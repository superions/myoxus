//! Periodic analytics flush + WS-state housekeeping.
//!
//! Runs on a `ping_interval_seconds` cadence (spawned from `init`) and performs:
//! - Cluster live-user count upsert from leased Redis workspace memberships
//! - Day-change eviction of `DOC_VIEW_DEDUP`
//! - TTL-based + hard-cap eviction of `NOTIFICATION_EVENT_ACKS` (SC-H-01, P84-E-02)
//! - Removal of empty `WORKSPACE_SESSIONS` entries (SC-H-01)
//!
//! Extracted from `mod.rs` in P107-H.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use chrono::Timelike;
use tracing::{debug, error, warn};
use uuid::Uuid;

use myoxus_application::doc::{DOC_VIEW_DEDUP, DOC_VIEW_DEDUP_DATE};

use crate::state::ApiState;

use super::state::{
  NOTIFICATION_EVENT_ACKS, NOTIFICATION_EVENT_ACKS_MAX, NOTIFICATION_EVENT_ACKS_TTL, SOCKET_USER_MAP,
  WORKSPACE_SESSIONS,
};

/// Periodic task: flush active-user counts to DB and perform DashMap housekeeping.
///
/// Runs every `ping_interval_seconds`. Local memberships renew their leases;
/// all writers sample globally distinct users through the existing Admin port.
/// Redis failure skips the sample, never replacing it with a local subset.
/// DashMap guards must be released before any Redis or SQL await.
pub(super) async fn flush_analytics(state: &Arc<ApiState>) {
  let minute = chrono::Utc::now()
    .with_second(0)
    .and_then(|t| t.with_nanosecond(0))
    .unwrap_or_else(chrono::Utc::now);
  let local: Vec<(Uuid, Vec<(String, Uuid)>)> = WORKSPACE_SESSIONS
    .iter()
    .map(|entry| {
      (
        *entry.key(),
        entry
          .value()
          .iter()
          .filter_map(|sid| SOCKET_USER_MAP.get(sid).map(|user| (sid.clone(), *user)))
          .collect(),
      )
    })
    .collect();
  let snapshot = async {
    let adapter = state
      .redis_ws_adapter()
      .ok_or_else(|| "Socket-role Redis unavailable".to_string())?;
    for (workspace_id, members) in &local {
      for (sid, user_id) in members {
        adapter
          .join_workspace(
            *workspace_id,
            sid,
            *user_id,
            state.config.websocket.ping_interval_seconds,
          )
          .await?;
        // A disconnect/leave during renewal must not resurrect local membership.
        let live = WORKSPACE_SESSIONS
          .get(workspace_id)
          .is_some_and(|entry| entry.contains(sid))
          && SOCKET_USER_MAP.get(sid).is_some_and(|user| *user == *user_id);
        if !live {
          adapter.leave_workspace(*workspace_id, sid).await;
        }
      }
    }
    let mut counts = adapter.workspace_active_users().await?;
    for (workspace_id, _) in &local {
      counts.entry(*workspace_id).or_insert(0);
    }
    Ok::<HashMap<Uuid, i32>, String>(counts)
  };
  // Bound the entire sample, including a paused Redis connection or large scan.
  let snapshot = tokio::time::timeout(std::time::Duration::from_secs(5), snapshot).await;
  match snapshot {
    Ok(Ok(counts)) => {
      for (workspace_id, count) in counts {
        match state
          .admin()
          .upsert_active_users_metric(workspace_id, minute, count)
          .await
        {
          Ok(()) if count == 0 => {
            WORKSPACE_SESSIONS.remove_if(&workspace_id, |_, set| set.is_empty());
          }
          Ok(()) => {}
          Err(error) => error!(%workspace_id, %error, "failed to flush analytics to db"),
        }
      }
    }
    _ => warn!("cluster workspace analytics unavailable; metric sample skipped"),
  }

  // P73-C / P80-K-03: Evict stale entries from DOC_VIEW_DEDUP on day change.
  // We use `retain()` instead of `clear()` to avoid a race condition: between
  // the date check and `clear()`, another thread could insert a new-day entry
  // that would be incorrectly wiped. Since the dedup key includes the date,
  // `retain()` safely removes only yesterday's entries while preserving any
  // new-day entries that arrived concurrently.
  {
    let today = chrono::Utc::now().date_naive();
    let mut last_date = DOC_VIEW_DEDUP_DATE.lock().unwrap_or_else(|e| e.into_inner());
    if *last_date != today {
      let old_len = DOC_VIEW_DEDUP.len();
      DOC_VIEW_DEDUP.retain(|(_uid, _ws, _doc, date)| *date >= today);
      let new_len = DOC_VIEW_DEDUP.len();
      *last_date = today;
      debug!(
        evicted = old_len - new_len,
        remaining = new_len,
        "DOC_VIEW_DEDUP day-change eviction"
      );
    }
  }

  // P84-E-02: TTL-based eviction of NOTIFICATION_EVENT_ACKS. Remove entries
  // older than NOTIFICATION_EVENT_ACKS_TTL incrementally, preserving recent acks.
  // Hard cap at NOTIFICATION_EVENT_ACKS_MAX as a safety net.
  {
    let now = Instant::now();
    let expired: Vec<String> = NOTIFICATION_EVENT_ACKS
      .iter()
      .filter(|entry| now.duration_since(entry.value().1) > NOTIFICATION_EVENT_ACKS_TTL)
      .map(|entry| entry.key().clone())
      .collect();
    if !expired.is_empty() {
      debug!(
        expired_count = expired.len(),
        total = NOTIFICATION_EVENT_ACKS.len(),
        "NOTIFICATION_EVENT_ACKS: evicting expired entries"
      );
      for key in &expired {
        NOTIFICATION_EVENT_ACKS.remove(key);
      }
    }
    // Safety net: if we still exceed the hard cap after TTL eviction, clear all.
    let ack_count = NOTIFICATION_EVENT_ACKS.len();
    if ack_count > NOTIFICATION_EVENT_ACKS_MAX {
      warn!(
        entries = ack_count,
        limit = NOTIFICATION_EVENT_ACKS_MAX,
        "NOTIFICATION_EVENT_ACKS still exceeds hard cap after TTL eviction, clearing"
      );
      NOTIFICATION_EVENT_ACKS.clear();
    }
  }
}
