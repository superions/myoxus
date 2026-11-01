//! P101-WS-ERR-03: Per-socket circuit breaker for WebSocket doc operations.
//!
//! Tracks consecutive error counts per (space, doc) pair within a single
//! WebSocket session. After `FAILURE_THRESHOLD` consecutive failures for
//! the same document, the circuit "opens" — subsequent errors are logged at
//! `debug!` level instead of `error!` to reduce log noise, and the error
//! category is escalated to `PERMANENT_ERROR`.
//!
//! The circuit resets automatically:
//! - On any successful operation for that doc (immediate reset)
//! - After `COOLDOWN_DURATION` has elapsed since the last failure (time-based reset)
//!
//! This is entirely in-memory and per-socket — no Redis or DB is involved.
//! State is dropped when the WebSocket connection closes (DashMap entry removed
//! in disconnect handler).

use dashmap::DashMap;
use std::time::{Duration, Instant};

/// Number of consecutive failures before the circuit opens.
const FAILURE_THRESHOLD: u32 = 3;

/// Time after which the circuit auto-resets (5 minutes).
const COOLDOWN_DURATION: Duration = Duration::from_secs(300);

type CircuitBreakerKey = (String, String);
type SocketCircuitBreakers = std::collections::HashMap<CircuitBreakerKey, CircuitState>;

/// Per-socket circuit breaker state, keyed by `(space_id, doc_id)`.
///
/// Each socket gets one entry in the global `CIRCUIT_BREAKERS` DashMap,
/// containing a nested HashMap of doc-level failure counters. This two-level
/// structure avoids a combinatorial explosion of DashMap entries while still
/// allowing O(1) cleanup on disconnect.
static CIRCUIT_BREAKERS: std::sync::LazyLock<DashMap<String, SocketCircuitBreakers>> =
  std::sync::LazyLock::new(DashMap::new);

/// Failure state for a single (space, doc) pair.
#[derive(Debug, Clone)]
struct CircuitState {
  /// Number of consecutive failures without a success.
  error_count: u32,
  /// When the most recent failure occurred.
  last_error_time: Instant,
}

/// Result of checking the circuit breaker after a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitStatus {
  /// Circuit is still closed — error count is below threshold.
  /// Contains the current consecutive failure count.
  BelowThreshold(u32),
  /// Circuit is open — error count has reached or exceeded threshold.
  /// Contains the current consecutive failure count.
  Open(u32),
}

impl CircuitStatus {
  /// Returns the current consecutive error count.
  pub fn retry_count(&self) -> u32 {
    match self {
      CircuitStatus::BelowThreshold(n) | CircuitStatus::Open(n) => *n,
    }
  }

  /// Returns `true` if the circuit is open (threshold exceeded).
  pub fn is_open(&self) -> bool {
    matches!(self, CircuitStatus::Open(_))
  }
}

/// Record a failure for the given socket/space/doc combination.
///
/// Returns the circuit status after recording this failure, which callers
/// use to decide error category and log level.
pub fn record_failure(socket_id: &str, space_id: &str, doc_id: &str) -> CircuitStatus {
  let key = (space_id.to_string(), doc_id.to_string());
  let now = Instant::now();

  let mut entry = CIRCUIT_BREAKERS.entry(socket_id.to_string()).or_default();
  let state = entry.entry(key).or_insert(CircuitState {
    error_count: 0,
    last_error_time: now,
  });

  // Time-based reset: if cooldown has elapsed, start fresh.
  if now.duration_since(state.last_error_time) > COOLDOWN_DURATION {
    state.error_count = 0;
  }

  state.error_count += 1;
  state.last_error_time = now;

  if state.error_count >= FAILURE_THRESHOLD {
    CircuitStatus::Open(state.error_count)
  } else {
    CircuitStatus::BelowThreshold(state.error_count)
  }
}

/// Record a success for the given socket/space/doc combination.
///
/// Resets the consecutive failure counter to zero immediately.
pub fn record_success(socket_id: &str, space_id: &str, doc_id: &str) {
  if let Some(mut entry) = CIRCUIT_BREAKERS.get_mut(socket_id) {
    let key = (space_id.to_string(), doc_id.to_string());
    entry.remove(&key);
  }
}

/// Remove all circuit breaker state for a disconnected socket.
///
/// Called from the disconnect handler in `mod.rs`.
pub fn cleanup_socket(socket_id: &str) {
  CIRCUIT_BREAKERS.remove(socket_id);
}

/// Get the current retry count for a socket/space/doc without recording anything.
///
/// Returns 0 if no failures have been recorded or the cooldown has elapsed.
pub fn current_retry_count(socket_id: &str, space_id: &str, doc_id: &str) -> u32 {
  let key = (space_id.to_string(), doc_id.to_string());
  CIRCUIT_BREAKERS
    .get(socket_id)
    .and_then(|entry| {
      entry.get(&key).map(|s| {
        if Instant::now().duration_since(s.last_error_time) > COOLDOWN_DURATION {
          0
        } else {
          s.error_count
        }
      })
    })
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn circuit_breaker_counts_consecutive_failures() {
    let sid = "test-cb-count";
    let space = "space-1";
    let doc = "doc-1";
    cleanup_socket(sid);

    let s1 = record_failure(sid, space, doc);
    assert_eq!(s1.retry_count(), 1);
    assert!(!s1.is_open());

    let s2 = record_failure(sid, space, doc);
    assert_eq!(s2.retry_count(), 2);
    assert!(!s2.is_open());

    let s3 = record_failure(sid, space, doc);
    assert_eq!(s3.retry_count(), 3);
    assert!(s3.is_open());

    cleanup_socket(sid);
  }

  #[test]
  fn circuit_breaker_resets_on_success() {
    let sid = "test-cb-reset";
    let space = "space-1";
    let doc = "doc-1";
    cleanup_socket(sid);

    record_failure(sid, space, doc);
    record_failure(sid, space, doc);
    assert_eq!(current_retry_count(sid, space, doc), 2);

    record_success(sid, space, doc);
    assert_eq!(current_retry_count(sid, space, doc), 0);

    let s1 = record_failure(sid, space, doc);
    assert_eq!(s1.retry_count(), 1);
    assert!(!s1.is_open());

    cleanup_socket(sid);
  }

  #[test]
  fn circuit_breaker_is_per_doc() {
    let sid = "test-cb-perdoc";
    let space = "space-1";
    cleanup_socket(sid);

    record_failure(sid, space, "doc-a");
    record_failure(sid, space, "doc-a");
    record_failure(sid, space, "doc-a");

    // doc-a is open
    assert_eq!(current_retry_count(sid, space, "doc-a"), 3);
    // doc-b is unaffected
    assert_eq!(current_retry_count(sid, space, "doc-b"), 0);

    cleanup_socket(sid);
  }

  #[test]
  fn circuit_breaker_cleanup_removes_all_state() {
    let sid = "test-cb-cleanup";
    cleanup_socket(sid);

    record_failure(sid, "s1", "d1");
    record_failure(sid, "s2", "d2");
    assert!(CIRCUIT_BREAKERS.contains_key(sid));

    cleanup_socket(sid);
    assert!(!CIRCUIT_BREAKERS.contains_key(sid));
  }
}
