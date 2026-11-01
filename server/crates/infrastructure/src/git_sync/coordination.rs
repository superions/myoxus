// SPDX-License-Identifier: AGPL-3.0-or-later
//! Dedicated PostgreSQL sessions for Git-Sync repository/branch ownership.

use std::time::Duration;

use async_trait::async_trait;
use myoxus_application::git_sync::{
  GitSyncCoordinationError, GitSyncRepositoryCoordination, GitSyncRepositoryGuard, GitSyncRepositoryScope,
};
use sqlx::{PgPool, Postgres, pool::PoolConnection};

const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Clone)]
pub struct PgGitSyncRepositoryCoordination {
  pool: PgPool,
}

impl PgGitSyncRepositoryCoordination {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }
}

struct PgGitSyncRepositoryGuard {
  connection: Option<PoolConnection<Postgres>>,
  key: i64,
}

impl Drop for PgGitSyncRepositoryGuard {
  fn drop(&mut self) {
    // An abandoned acquire or remote operation may still hold a session lock.
    // Never return that connection to the pool without an acknowledged unlock.
    if let Some(connection) = self.connection.as_mut() {
      connection.close_on_drop();
    }
  }
}

impl PgGitSyncRepositoryGuard {
  fn connection(&mut self) -> Result<&mut sqlx::PgConnection, GitSyncCoordinationError> {
    self
      .connection
      .as_mut()
      .map(|connection| &mut **connection)
      .ok_or(GitSyncCoordinationError::Lost)
  }

  fn discard(&mut self) {
    if let Some(connection) = self.connection.as_mut() {
      connection.close_on_drop();
    }
  }
}

#[async_trait]
impl GitSyncRepositoryCoordination for PgGitSyncRepositoryCoordination {
  async fn acquire(
    &self,
    scope: &GitSyncRepositoryScope,
  ) -> Result<Box<dyn GitSyncRepositoryGuard>, GitSyncCoordinationError> {
    let deadline = tokio::time::Instant::now() + ACQUIRE_TIMEOUT;
    let connection = tokio::time::timeout(ACQUIRE_TIMEOUT, self.pool.acquire())
      .await
      .map_err(|_| GitSyncCoordinationError::Busy)?
      .map_err(|_| GitSyncCoordinationError::Unavailable)?;
    let mut guard = PgGitSyncRepositoryGuard {
      connection: Some(connection),
      key: 0,
    };
    guard.key = tokio::time::timeout_at(
      deadline,
      sqlx::query_scalar("SELECT hashtextextended($1::text, 0)")
        .bind(scope.advisory_key())
        .fetch_one(guard.connection()?),
    )
    .await
    .map_err(|_| GitSyncCoordinationError::Busy)?
    .map_err(|_| GitSyncCoordinationError::Unavailable)?;

    loop {
      let key = guard.key;
      let acquired: bool = tokio::time::timeout_at(
        deadline,
        sqlx::query_scalar("SELECT pg_try_advisory_lock($1::bigint)")
          .bind(key)
          .fetch_one(guard.connection()?),
      )
      .await
      .map_err(|_| GitSyncCoordinationError::Busy)?
      .map_err(|_| GitSyncCoordinationError::Unavailable)?;
      if acquired {
        guard.ensure_owned().await?;
        return Ok(Box::new(guard));
      }
      if tokio::time::Instant::now() >= deadline {
        return Err(GitSyncCoordinationError::Busy);
      }
      tokio::time::sleep(RETRY_INTERVAL.min(deadline.saturating_duration_since(tokio::time::Instant::now()))).await;
    }
  }
}

#[async_trait]
impl GitSyncRepositoryGuard for PgGitSyncRepositoryGuard {
  async fn ensure_owned(&mut self) -> Result<(), GitSyncCoordinationError> {
    let key = self.key;
    // Checking pg_locks instead of calling pg_try_advisory_lock matters: the
    // latter would silently reacquire a lock that this session had lost.
    let result = tokio::time::timeout(
      ACQUIRE_TIMEOUT,
      sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory' AND pid = pg_backend_pid()
         AND classid::bigint = (($1::bigint >> 32) & 4294967295)
         AND objid::bigint = ($1::bigint & 4294967295)
         AND objsubid = 1 AND mode = 'ExclusiveLock' AND granted)",
      )
      .bind(key)
      .fetch_one(self.connection()?),
    )
    .await;
    let owned: bool = result
      .map_err(|_| {
        self.discard();
        GitSyncCoordinationError::Lost
      })?
      .map_err(|_| {
        self.discard();
        GitSyncCoordinationError::Lost
      })?;
    if !owned {
      self.discard();
      return Err(GitSyncCoordinationError::Lost);
    }
    Ok(())
  }

  async fn release(mut self: Box<Self>) -> Result<(), GitSyncCoordinationError> {
    self.ensure_owned().await?;
    let key = self.key;
    let unlocked: bool = tokio::time::timeout(
      ACQUIRE_TIMEOUT,
      sqlx::query_scalar("SELECT pg_advisory_unlock($1::bigint)")
        .bind(key)
        .fetch_one(self.connection()?),
    )
    .await
    .map_err(|_| GitSyncCoordinationError::Lost)?
    .map_err(|_| GitSyncCoordinationError::Lost)?;
    if !unlocked {
      return Err(GitSyncCoordinationError::Lost);
    }
    // An acknowledged unlock is the only path that returns the connection to
    // the pool. Drop closes it after every other exit, including cancellation.
    drop(self.connection.take());
    Ok(())
  }
}
