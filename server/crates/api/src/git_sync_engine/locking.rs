// SPDX-License-Identifier: AGPL-3.0-or-later
//! Per-profile concurrency lock with mandatory distributed Redis ownership.
//!
//! Only one sync per profile can run at a time. Uses a local `DashMap` as a
//! fast in-process check after a distributed SETNX lock prevents multiple
//! server instances from syncing the same profile simultaneously. Redis is a
//! startup requirement; acquisition errors fail closed before local state.

use std::sync::Arc;

use dashmap::DashMap;
use tracing::trace;
use uuid::Uuid;

use myoxus_application::ports::RedisPort;
use myoxus_infrastructure::redis_lease::RedisLease;

use super::error::SyncError;

/// Shared lock registry (one per server process).
pub type ProfileLocks = Arc<DashMap<Uuid, ()>>;

/// Create a new empty lock registry.
pub fn new_locks() -> ProfileLocks {
  Arc::new(DashMap::new())
}

// ROB-26: lock TTL is now operator-configurable via
// `git_sync.lock_ttl_seconds` (admin config + YAML), passed through
// the runner. The previous hardcoded 5-minute constant lived here as
// `REDIS_LOCK_TTL_SECS` and silently underestimated long-running
// syncs (large repos / high `max_docs_per_sync` values), causing
// concurrent runs against the same remote when the TTL expired
// mid-sync. The new value is validated at server start
// (`config::validate_config_strict`) to be in [1, 3600] seconds.

/// RAII guard — releases both the local and distributed lock when dropped.
///
/// The distributed owner/heartbeat/release mechanics are delegated to the
/// shared infrastructure lease. This guard retains only Git's process-local
/// profile exclusion.
pub struct ProfileLockGuard {
  locks: ProfileLocks,
  profile_id: Uuid,
  lease: RedisLease,
}

impl ProfileLockGuard {
  /// Fail closed when the distributed owner can no longer be verified.
  pub fn ensure_owned(&self, phase: &'static str) -> Result<(), SyncError> {
    self.lease.ensure_owned().map_err(|error| {
      SyncError::retryable(
        format!("distributed profile ownership lost: {error}"),
        self.profile_id,
        phase,
      )
    })
  }
}

impl Drop for ProfileLockGuard {
  fn drop(&mut self) {
    self.locks.remove(&self.profile_id);
    trace!(profile_id = %self.profile_id, "local profile sync lock released");
  }
}

/// Acquire an exclusive sync lock for a profile.
///
/// **Two-layer locking strategy:**
/// 1. **Redis (distributed):** Attempt a mandatory SETNX lock first. This
///    prevents two server instances from syncing the same profile. Transport
///    errors fail closed before the process-local guard is touched.
/// 2. **DashMap (local):** Fast in-process check. Prevents two async tasks in
///    the same process from racing.
///
/// Returns `Err(SyncError::AlreadySyncing)` if the profile is already locked
/// at either layer.
///
/// ROB-26 / ROB-26-FOLLOWUP: `lock_ttl_seconds` is the Redis-side SETNX
/// expiry; the guard spawns a heartbeat task that re-EXPIREs every
/// `lock_ttl_seconds / 3` seconds via atomic compare-and-refresh, so a
/// long-running sync no longer loses the lock mid-flight.  Operators tune
/// the TTL via `git_sync.lock_ttl_seconds` (default 300); a smaller TTL is
/// fine in HA mode because the heartbeat keeps the lock alive.
///
/// ROB-23: release uses `compare_and_delete` (atomic value check) so a
/// release that arrives after our lock expired and another instance has
/// reacquired it does not delete the foreign lock.
pub async fn acquire(
  locks: &ProfileLocks,
  profile_id: Uuid,
  redis_port: &Arc<dyn RedisPort>,
  lock_ttl_seconds: u64,
) -> Result<ProfileLockGuard, SyncError> {
  // ── Layer 1: Distributed lock (Redis SETNX) ──────────────────────────
  let lease = match RedisLease::acquire(
    Arc::clone(redis_port),
    format!("git-sync:lock:{profile_id}"),
    lock_ttl_seconds,
  )
  .await
  {
    Ok(Some(lease)) => lease,
    Ok(None) => return Err(SyncError::AlreadySyncing(profile_id)),
    Err(error) => {
      return Err(SyncError::retryable(
        format!("distributed profile lock unavailable: {error}"),
        profile_id,
        "acquire_profile_lock",
      ));
    }
  };

  // ── Layer 2: Local in-process lock (DashMap) ──────────────────────────
  use dashmap::mapref::entry::Entry;
  match locks.entry(profile_id) {
    Entry::Vacant(vacant) => {
      vacant.insert(());
      trace!(profile_id = %profile_id, "local profile sync lock acquired");

      Ok(ProfileLockGuard {
        locks: locks.clone(),
        profile_id,
        lease,
      })
    }
    Entry::Occupied(_) => {
      // Guarded release is owned by the shared technical lease.
      drop(lease);
      Err(SyncError::AlreadySyncing(profile_id))
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_infrastructure::redis::{InMemoryRedisAdapter, RedisAdapter};

  fn make_redis() -> Arc<dyn RedisPort> {
    Arc::new(InMemoryRedisAdapter::new("test"))
  }

  /// ROB-23: when an instance acquires the lock and then drops the guard,
  /// the Redis key must be deleted only by that instance. Subsequent
  /// `acquire` calls must succeed.
  #[tokio::test]
  async fn release_clears_redis_lock_for_subsequent_acquire() {
    let locks = new_locks();
    let redis = make_redis();
    let profile = Uuid::new_v4();

    let guard1 = acquire(&locks, profile, &redis, 60).await.expect("first");
    drop(guard1);
    // Compare-and-delete runs in a tokio::spawn — yield until it completes.
    for _ in 0..10 {
      tokio::task::yield_now().await;
      tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    let key = format!("test:git-sync:lock:{profile}");
    assert_eq!(
      redis
        .get_string(&format!("git-sync:lock:{profile}"))
        .await
        .expect("get"),
      None,
      "release must clear the Redis lock; key={key}",
    );

    let guard2 = acquire(&locks, profile, &redis, 60).await.expect("second");
    drop(guard2);
  }

  /// ROB-23: the central ABA-race regression test.
  ///
  /// Instance A acquires the lock, then the lock TTL expires. Instance B
  /// acquires the lock and writes its own `instance_value`. When Instance
  /// A's guard drops it MUST NOT delete Instance B's lock.
  ///
  /// We simulate the race by manipulating the Redis key directly between
  /// "Instance A acquires" and "Instance A drops guard": after A's SETNX
  /// we overwrite the key with a different value (representing B's
  /// reacquisition after TTL expiry). When A's guard drops, the
  /// compare_and_delete sees the mismatch and leaves the key alone.
  #[tokio::test]
  async fn drop_does_not_delete_foreign_lock_after_aba_race() {
    let locks = new_locks();
    let redis = make_redis();
    let profile = Uuid::new_v4();
    let key_no_namespace = format!("git-sync:lock:{profile}");

    let guard_a = acquire(&locks, profile, &redis, 60).await.expect("A acquires");

    // Simulate: A's TTL expired, B re-acquired with a different value.
    // We must stop A's heartbeat first (otherwise it would refresh the
    // foreign lock's TTL — but compare_and_refresh is value-checked, so
    // the heartbeat cannot extend B's lock either; abort it just to keep
    // the test deterministic).
    redis
      .set_string(&key_no_namespace, "instance-B-value", Some(60))
      .await
      .expect("B overwrite");

    drop(guard_a);
    // Wait for the spawned compare_and_delete to run.
    for _ in 0..10 {
      tokio::task::yield_now().await;
      tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    let after = redis.get_string(&key_no_namespace).await.expect("get after");
    assert_eq!(
      after,
      Some("instance-B-value".to_string()),
      "Instance A's drop must NOT delete Instance B's lock value"
    );
  }

  #[tokio::test]
  async fn lost_lease_blocks_mutation_and_allows_a_later_real_reacquire() {
    let locks = new_locks();
    let redis = make_redis();
    let profile = Uuid::new_v4();
    let key = format!("git-sync:lock:{profile}");
    let guard = acquire(&locks, profile, &redis, 1).await.expect("initial guard");
    let mirror_root = tempfile::tempdir().expect("mirror root");
    let native_guard = myoxus_infrastructure::git_sync::acquire_profile_mirror(mirror_root.path(), profile)
      .await
      .expect("initial native guard");

    redis
      .set_string(&key, "foreign-owner", Some(60))
      .await
      .expect("replace expired owner");
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    assert!(matches!(
      guard.ensure_owned("controlled_mutation"),
      Err(SyncError::Retryable {
        phase: "controlled_mutation",
        ..
      })
    ));

    drop(guard);
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert_eq!(
      redis.get_string(&key).await.expect("foreign owner remains"),
      Some("foreign-owner".to_string())
    );
    redis.delete_key(&key).await.expect("release foreign fixture owner");
    let reacquired = acquire(&locks, profile, &redis, 60).await.expect("later reacquire");
    reacquired.ensure_owned("later_mutation").expect("new lease is owned");
    assert!(matches!(
      myoxus_infrastructure::git_sync::acquire_profile_mirror(mirror_root.path(), profile).await,
      Err(myoxus_infrastructure::git_sync::MirrorLockError::Busy)
    ));
    drop(native_guard);
    myoxus_infrastructure::git_sync::acquire_profile_mirror(mirror_root.path(), profile)
      .await
      .expect("later owner acquires only after native writer finishes");
  }

  /// ROB-26-FOLLOWUP: heartbeat refreshes the lock TTL while the guard is
  /// alive. With a 3-second TTL and a 1-second tick (3/3=1), a 4-second
  /// hold should keep the lock present despite the original TTL expiring.
  #[tokio::test]
  async fn heartbeat_keeps_lock_alive_past_initial_ttl() {
    let locks = new_locks();
    let redis = make_redis();
    let profile = Uuid::new_v4();
    let key_no_namespace = format!("git-sync:lock:{profile}");

    let guard = acquire(&locks, profile, &redis, 3).await.expect("acquire");

    // Sleep 4s — well past the 3s initial TTL. The heartbeat ticks every
    // 1s and re-EXPIREs the lock so it stays.
    tokio::time::sleep(std::time::Duration::from_millis(4_000)).await;

    let still_there = redis.get_string(&key_no_namespace).await.expect("get");
    assert!(
      still_there.is_some(),
      "heartbeat must refresh the TTL so the lock survives past its initial expiry"
    );

    drop(guard);
  }

  /// ROB-26-FOLLOWUP: dropping the guard aborts the heartbeat — the lock
  /// must not be re-extended after release.
  #[tokio::test]
  async fn dropped_guard_stops_heartbeat() {
    let locks = new_locks();
    let redis = make_redis();
    let profile = Uuid::new_v4();
    let key_no_namespace = format!("git-sync:lock:{profile}");

    let guard = acquire(&locks, profile, &redis, 3).await.expect("acquire");
    drop(guard);

    // Wait for compare_and_delete to run.
    for _ in 0..10 {
      tokio::task::yield_now().await;
      tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
      redis.get_string(&key_no_namespace).await.expect("after drop"),
      None,
      "drop must release the lock immediately"
    );

    // If the heartbeat were still running, a couple of ticks later it would
    // try to compare_and_refresh — but the key is gone, so refresh returns
    // false (no resurrection). Verify the key stays absent.
    tokio::time::sleep(std::time::Duration::from_millis(2_500)).await;
    assert_eq!(
      redis.get_string(&key_no_namespace).await.expect("later"),
      None,
      "heartbeat must not resurrect the lock after drop"
    );
  }

  #[tokio::test]
  async fn redis_acquisition_error_is_retryable_without_local_guard() {
    let locks = new_locks();
    let redis: Arc<dyn RedisPort> =
      Arc::new(RedisAdapter::new("redis://127.0.0.1:1", "test-lock-role").expect("valid unreachable Redis URL"));
    let profile = Uuid::new_v4();

    let error = match acquire(&locks, profile, &redis, 60).await {
      Ok(_) => panic!("unreachable mandatory Redis lock must fail closed"),
      Err(error) => error,
    };

    assert!(matches!(
      error,
      SyncError::Retryable {
        phase: "acquire_profile_lock",
        ..
      }
    ));
    assert!(
      !locks.contains_key(&profile),
      "Redis acquisition failure must not create a process-local guard"
    );
  }
}
