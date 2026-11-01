//! Queue observability and health metrics.

use serde::{Deserialize, Serialize};

/// A real minute sample of unfinished jobs; missing minutes are not zeroes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QueueHistoryPoint {
  pub timestamp: i64,
  pub pending: i64,
}

/// Point-in-time snapshot of a queue's state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueStats {
  /// Queue name.
  pub queue: String,
  /// Number of jobs waiting to be processed.
  pub waiting: i64,
  /// Number of jobs currently being processed.
  pub active: i64,
  /// Number of completed jobs.
  pub completed: i64,
  /// Number of permanently failed jobs.
  pub failed: i64,
  /// Number of delayed/scheduled jobs.
  pub delayed: i64,
  /// Number of stalled jobs detected.
  pub stalled: i64,
  /// `true` when one or more individual stat queries failed (WRK-RV-03b).
  /// Failed stats are reported as 0; the successfully read stats are accurate.
  #[serde(default)]
  pub degraded: bool,
}

impl QueueStats {
  pub fn history_point(&self, timestamp: i64) -> Option<QueueHistoryPoint> {
    if self.degraded || timestamp < 0 || self.waiting < 0 || self.active < 0 || self.delayed < 0 {
      return None;
    }
    Some(QueueHistoryPoint {
      timestamp: timestamp / 60_000 * 60_000,
      pending: self.waiting.checked_add(self.active)?.checked_add(self.delayed)?,
    })
  }
}
