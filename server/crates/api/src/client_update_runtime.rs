// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{
  sync::{Arc, RwLock},
  time::Duration,
};

use myoxus_contracts::client_update::{CLIENT_UPDATE_NOTIFY_CHANNEL, ClientUpdateControlV1};
use myoxus_infrastructure::client_update::{ClientUpdateRepositoryError, PgClientUpdateRepository};
use sqlx::{PgPool, postgres::PgListener};
use tokio::{
  sync::{broadcast, watch},
  task::JoinHandle,
};
use tracing::{debug, info, warn};

/// API-node runtime for the server-owned Browser Web update policy.
///
/// PostgreSQL remains authoritative: every query and connection admission
/// performs a fresh repository read. The process-local snapshot is only the
/// last successfully observed value; `NOTIFY` invalidates it and wakes sockets,
/// but never carries or replaces policy state.
#[derive(Clone)]
pub struct ClientUpdateRuntime {
  pool: PgPool,
  repository: PgClientUpdateRepository,
  snapshot: Arc<RwLock<Option<ClientUpdateControlV1>>>,
  wakeups: broadcast::Sender<()>,
  shutdown: watch::Sender<bool>,
  listener_ready: watch::Sender<bool>,
}

impl ClientUpdateRuntime {
  pub fn new(pool: PgPool) -> Self {
    let (wakeups, _) = broadcast::channel(16);
    let (shutdown, _) = watch::channel(false);
    let (listener_ready, _) = watch::channel(false);
    Self {
      repository: PgClientUpdateRepository::new(pool.clone()),
      pool,
      snapshot: Arc::new(RwLock::new(None)),
      wakeups,
      shutdown,
      listener_ready,
    }
  }

  /// Reads and validates the current PostgreSQL value without consulting the
  /// process-local snapshot. A lost wake-up therefore cannot make a later read
  /// or Browser Web admission stale.
  pub async fn read_authoritative(&self) -> Result<ClientUpdateControlV1, ClientUpdateRepositoryError> {
    let control = self.repository.read().await?;
    *self.snapshot.write().unwrap_or_else(|error| error.into_inner()) = Some(control.clone());
    Ok(control)
  }

  pub fn subscribe_wakeups(&self) -> broadcast::Receiver<()> {
    self.wakeups.subscribe()
  }

  pub fn listener_ready(&self) -> watch::Receiver<bool> {
    self.listener_ready.subscribe()
  }

  /// Starts the reconnecting PostgreSQL wake-up listener.
  ///
  /// The task owns no `Arc<ClientUpdateRuntime>`, so dropping the runtime closes
  /// the shutdown channel and lets short-lived integration routers terminate.
  pub fn start_listener(&self) -> JoinHandle<()> {
    let pool = self.pool.clone();
    let snapshot = self.snapshot.clone();
    let wakeups = self.wakeups.clone();
    let mut shutdown = self.shutdown.subscribe();
    let ready = self.listener_ready.clone();
    tokio::spawn(async move {
      let mut reconnect_delay = Duration::from_secs(1);
      loop {
        if *shutdown.borrow() {
          break;
        }

        match PgListener::connect_with(&pool).await {
          Ok(mut listener) => {
            if listener.listen(CLIENT_UPDATE_NOTIFY_CHANNEL).await.is_ok() {
              ready.send_replace(true);
              reconnect_delay = Duration::from_secs(1);
              info!(
                channel = CLIENT_UPDATE_NOTIFY_CHANNEL,
                "client update wake-up listener ready"
              );

              loop {
                tokio::select! {
                  changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                      return;
                    }
                  }
                  notification = listener.recv() => {
                    match notification {
                      Ok(_) => {
                        let invalidated_state_id = snapshot
                          .write()
                          .unwrap_or_else(|error| error.into_inner())
                          .take()
                          .map(|control| control.state_id);
                        let _ = wakeups.send(());
                        debug!(
                          invalidated_state_id = ?invalidated_state_id,
                          "client update wake-up received"
                        );
                      }
                      Err(_) => {
                        warn!("client update wake-up listener disconnected; reconnecting");
                        break;
                      }
                    }
                  }
                }
              }
            } else {
              warn!("client update wake-up channel subscription failed; reconnecting");
            }
          }
          Err(_) => warn!("client update wake-up database connection failed; reconnecting"),
        }

        ready.send_replace(false);
        tokio::select! {
          changed = shutdown.changed() => {
            if changed.is_err() || *shutdown.borrow() {
              break;
            }
          }
          _ = tokio::time::sleep(reconnect_delay) => {}
        }
        reconnect_delay = (reconnect_delay * 2).min(Duration::from_secs(30));
      }
    })
  }

  pub fn shutdown(&self) {
    let _ = self.shutdown.send(true);
  }
}
