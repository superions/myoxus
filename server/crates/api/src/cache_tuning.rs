//! Automatic cache TTL tuning (P84-J).
//!
//! Two background tasks adjust cache TTLs based on observed hit/miss/invalidation
//! rates:
//!
//! - **Hourly cycle** ([`start_hourly_tuner`]): conservative adjustments, high-traffic
//!   signal (P84-J-06/07/08/09/10).
//! - **Daily cycle** ([`start_daily_tuner`]): more aggressive adjustments, trend-based
//!   decisions (P84-J-11/12/13/14/15).
//!
//! ## TTL application (P84-J-09)
//!
//! The tuning cycle updates `current_ttl_*` atomics in `QueryCache`.  Because
//! moka caches are built with `AtomicTtlExpiry`, the
//! updated atomic is consulted for *every new insertion* — no server restart is
//! needed for the new TTL to apply to fresh entries.
//!
//! When TTL decreases, the cycle also calls [`QueryCache::invalidate_cache`] on
//! the affected cache so existing entries with the old (longer) TTL are evicted
//! immediately, forcing a DB re-fetch on the next access.
//!
//! ## Oscillation protection (P84-J-16)
//!
//! If a cache's TTL has both increased and decreased within the last 6 hours,
//! the next hourly cycle is skipped for that cache and a warning is logged.
//!
//! ## Max 24h change cap (P84-J-17)
//!
//! No cache's TTL may change by more than a factor of 4 within 24 hours.

use std::sync::{Arc, atomic::Ordering};
use std::time::Duration;

use serde::Serialize;
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

use crate::cache::{CacheConfig, CacheMetricsSnapshot, QueryCache};
use myoxus_application::metrics::MetricsService;
use myoxus_domain::metrics::CacheTuningRecord;
use myoxus_infrastructure::doc_cache::{DocCacheEventCounters, DocCacheTuningHandles};

// ─── P84-J-13: Structured daily report ───────────────────────────────────────

/// One cache's contribution to the daily tuning report.
#[derive(Serialize)]
struct CacheReport {
  name: String,
  avg_hit_rate_24h: f64,
  total_requests_24h: u64,
  total_invalidations_24h: u64,
  previous_ttl_s: u64,
  new_ttl_s: u64,
  action: &'static str,
}

/// Summary emitted as a structured `info!` log at the end of the daily cycle.
#[derive(Serialize)]
struct DailyReport {
  caches: Vec<CacheReport>,
}

/// A single row to persist in `cache_tuning_metrics`.
struct TuningRecord {
  snapshot: CacheMetricsSnapshot,
  current_ttl: u64,
  recommended_ttl: u64,
  action: &'static str,
  cycle_type: &'static str,
}

/// Persist one tuning record to the database.
///
/// Non-fatal — if the INSERT fails, a warning is logged and the cycle continues.
async fn persist_record(metrics: &MetricsService, rec: &TuningRecord) {
  let result = metrics
    .record_cache_tuning(&CacheTuningRecord {
      cache_name: rec.snapshot.cache_name.clone(),
      hits: rec.snapshot.hits as i64,
      misses: rec.snapshot.misses as i64,
      hit_rate: rec.snapshot.hit_rate,
      invalidations_local: rec.snapshot.invalidations_local as i64,
      invalidations_remote: rec.snapshot.invalidations_remote as i64,
      current_ttl_seconds: rec.current_ttl as i32,
      recommended_ttl_seconds: rec.recommended_ttl as i32,
      action_taken: rec.action.to_string(),
      cycle_type: rec.cycle_type.to_string(),
      measured_at: rec.snapshot.measured_at,
    })
    .await;

  if let Err(e) = result {
    warn!(
        cache = %rec.snapshot.cache_name,
        cycle = rec.cycle_type,
        error = %e,
        "P84-J: failed to persist tuning record to DB"
    );
  }
}

/// Per-cache tuning bounds loaded from config.
#[derive(Clone, Copy, Debug)]
struct CacheBounds {
  #[allow(dead_code)]
  name: &'static str,
  min_ttl: u64,
  max_ttl: u64,
  /// P84-J-18: If set, auto-tuning is disabled for this cache.
  fixed_ttl: Option<u64>,
}

/// Extract tuning bounds for the retained in-process caches.
fn all_bounds(config: &CacheConfig) -> [CacheBounds; 4] {
  [
    CacheBounds {
      name: "server_config",
      min_ttl: config.server_config_min_ttl_seconds,
      max_ttl: config.server_config_max_ttl_seconds,
      fixed_ttl: config.server_config_fixed_ttl_seconds,
    },
    CacheBounds {
      name: "user_features",
      min_ttl: config.user_features_min_ttl_seconds,
      max_ttl: config.user_features_max_ttl_seconds,
      fixed_ttl: config.user_features_fixed_ttl_seconds,
    },
    CacheBounds {
      name: "throttle_config",
      min_ttl: config.throttle_config_min_ttl_seconds,
      max_ttl: config.throttle_config_max_ttl_seconds,
      fixed_ttl: config.throttle_config_fixed_ttl_seconds,
    },
    CacheBounds {
      name: "ws_settings",
      min_ttl: config.ws_settings_min_ttl_seconds,
      max_ttl: config.ws_settings_max_ttl_seconds,
      fixed_ttl: config.ws_settings_fixed_ttl_seconds,
    },
  ]
}

/// Apply P84-J-07 hourly tuning rules to a snapshot and return (recommended_ttl, action).
///
/// Rules (conservative):
/// - Hit-rate < 30% AND ≥100 requests → TTL × 1.5 (cache underutilised: too short a TTL)
/// - Hit-rate 30–50% AND ≥100 requests → TTL × 1.25
/// - Hit-rate 50–80% AND ≥100 requests → no change (acceptable range)
/// - Hit-rate > 80% AND invalidations > 10 per hit → TTL × 0.75 (high churn: reduce TTL)
/// - Hit-rate > 80% AND invalidations ≤ 10 per hit → no change (healthy)
/// - < 100 requests → no change (too low signal)
fn apply_hourly_rules(snapshot: &CacheMetricsSnapshot, current_ttl: u64, bounds: &CacheBounds) -> (u64, &'static str) {
  if snapshot.total_requests < 100 {
    return (current_ttl, "none");
  }

  let rate = snapshot.hit_rate;
  let total_inv = snapshot.invalidations_local + snapshot.invalidations_remote;

  let raw = if rate < 0.30 {
    // Very low hit rate: TTL too short, items expire before being reused.
    (current_ttl as f64 * 1.5) as u64
  } else if rate < 0.50 {
    // Below average: increase TTL moderately.
    (current_ttl as f64 * 1.25) as u64
  } else if rate > 0.80 && snapshot.hits > 0 {
    // High hit rate but lots of invalidations per request: TTL too long relative to churn.
    let inv_per_hit_ratio = total_inv as f64 / snapshot.hits as f64;
    if inv_per_hit_ratio > 0.1 {
      (current_ttl as f64 * 0.75) as u64
    } else {
      current_ttl
    }
  } else {
    current_ttl
  };

  let recommended = raw.clamp(bounds.min_ttl, bounds.max_ttl);
  let action: &'static str = if recommended > current_ttl {
    "increased"
  } else if recommended < current_ttl {
    "decreased"
  } else {
    "unchanged"
  };

  (recommended, action)
}

/// Apply P84-J-12 daily tuning rules (more aggressive than hourly).
///
/// Rules:
/// - Hit-rate < 20% AND ≥200 requests → TTL × 2.0
/// - Hit-rate 20–40% AND ≥200 requests → TTL × 1.5
/// - Hit-rate 40–60% AND ≥200 requests → no change
/// - Hit-rate > 60% AND invalidations/hit > 0.2 → TTL × 0.5
/// - < 200 requests → no change
fn apply_daily_rules(snapshot: &CacheMetricsSnapshot, current_ttl: u64, bounds: &CacheBounds) -> (u64, &'static str) {
  if snapshot.total_requests < 200 {
    return (current_ttl, "none");
  }

  let rate = snapshot.hit_rate;
  let total_inv = snapshot.invalidations_local + snapshot.invalidations_remote;

  let raw = if rate < 0.20 {
    (current_ttl as f64 * 2.0) as u64
  } else if rate < 0.40 {
    (current_ttl as f64 * 1.5) as u64
  } else if rate > 0.60 && snapshot.hits > 0 {
    let inv_per_hit_ratio = total_inv as f64 / snapshot.hits as f64;
    if inv_per_hit_ratio > 0.2 {
      (current_ttl as f64 * 0.5) as u64
    } else {
      current_ttl
    }
  } else {
    current_ttl
  };

  let recommended = raw.clamp(bounds.min_ttl, bounds.max_ttl);
  let action: &'static str = if recommended > current_ttl {
    "increased"
  } else if recommended < current_ttl {
    "decreased"
  } else {
    "unchanged"
  };

  (recommended, action)
}

// ─── P84-J-16: Oscillation detection ─────────────────────────────────────────

/// Return `true` if the cache had both "increased" and "decreased" actions
/// within the last 6 hours — indicating oscillation.
///
/// Oscillation means the tuning system is confused about the right TTL and
/// keeps flip-flopping.  In that case, skip the cycle for this cache.
async fn is_oscillating(metrics: &MetricsService, cache_name: &str) -> bool {
  metrics.cache_tuning_is_oscillating(cache_name).await.unwrap_or(false)
}

// ─── P84-J-17: Max 24h change cap ────────────────────────────────────────────

/// Clamp `recommended` so that the TTL cannot change by more than factor 4
/// compared to the TTL that was in use 24 hours ago (read from DB).
///
/// If no DB record exists for 24h ago, the clamp is applied against `current_ttl`.
async fn clamp_max_24h_change(metrics: &MetricsService, cache_name: &str, current_ttl: u64, recommended: u64) -> u64 {
  let baseline = metrics
    .cache_tuning_ttl_around_24h(cache_name)
    .await
    .ok()
    .flatten()
    .map(|ttl| ttl as u64)
    .unwrap_or(current_ttl);
  if baseline == 0 {
    return recommended;
  }

  let max_allowed = baseline * 4;
  let min_allowed = (baseline / 4).max(1);

  if recommended > max_allowed {
    warn!(
      cache = cache_name,
      recommended_ttl = recommended,
      max_allowed,
      baseline_ttl_24h = baseline,
      "P84-J-17: capping TTL increase — exceeds 4× 24h baseline"
    );
    max_allowed
  } else if recommended < min_allowed {
    warn!(
      cache = cache_name,
      recommended_ttl = recommended,
      min_allowed,
      baseline_ttl_24h = baseline,
      "P84-J-17: capping TTL decrease — exceeds 4× 24h baseline"
    );
    min_allowed
  } else {
    recommended
  }
}

/// Public entry point for the hourly tuning cycle — exposed for integration testing.
pub async fn run_hourly_cycle_once(cache: &QueryCache, config: &CacheConfig, metrics: &MetricsService) {
  run_hourly_cycle(cache, config, metrics).await;
}

/// Public entry point for the daily tuning cycle — exposed for integration testing.
pub async fn run_daily_cycle_once(cache: &QueryCache, config: &CacheConfig, metrics: &MetricsService) {
  run_daily_cycle(cache, config, metrics).await;
}

/// Run one hourly tuning cycle: snapshot metrics, apply rules, persist, update TTL atomics.
async fn run_hourly_cycle(cache: &QueryCache, config: &CacheConfig, metrics: &MetricsService) {
  let bounds_list = all_bounds(config);
  let ttl_handles = cache.all_current_ttls();
  let metrics_list = [
    cache.metrics_server_config.snapshot_and_reset(),
    cache.metrics_user_features.snapshot_and_reset(),
    cache.metrics_throttle_config.snapshot_and_reset(),
    cache.metrics_ws_settings.snapshot_and_reset(),
  ];

  for (i, snapshot) in metrics_list.iter().enumerate() {
    let bounds = &bounds_list[i];
    let (_, ttl_atomic) = ttl_handles[i];
    let current_ttl = ttl_atomic.load(Ordering::Acquire);

    // P84-J-18: Admin fixed-TTL override — skip auto-tuning.
    if let Some(fixed) = bounds.fixed_ttl {
      if current_ttl != fixed {
        ttl_atomic.store(fixed, Ordering::Release);
      }
      info!(
          cache = %snapshot.cache_name,
          fixed_ttl_s = fixed,
          "P84-J-18: fixed TTL override active — auto-tuning skipped"
      );
      continue;
    }

    // P84-J-16: Skip if oscillating.
    if is_oscillating(metrics, &snapshot.cache_name).await {
      warn!(
          cache = %snapshot.cache_name,
          "P84-J-16: oscillation detected — skipping tuning cycle, manual review recommended"
      );
      persist_record(
        metrics,
        &TuningRecord {
          snapshot: snapshot.clone(),
          current_ttl,
          recommended_ttl: current_ttl,
          action: "skipped",
          cycle_type: "hourly",
        },
      )
      .await;
      continue;
    }

    let (raw_recommended, action) = apply_hourly_rules(snapshot, current_ttl, bounds);

    // P84-J-17: Cap to max factor-4 change within 24h.
    let recommended = if action != "none" && action != "unchanged" {
      clamp_max_24h_change(metrics, &snapshot.cache_name, current_ttl, raw_recommended).await
    } else {
      raw_recommended
    };

    // Recompute action after capping.
    let final_action: &'static str = if recommended > current_ttl {
      "increased"
    } else if recommended < current_ttl {
      "decreased"
    } else {
      action // "none" or "unchanged"
    };

    info!(
        cycle = "hourly",
        cache = %snapshot.cache_name,
        hit_rate = format!("{:.1}%", snapshot.hit_rate * 100.0),
        total_requests = snapshot.total_requests,
        current_ttl_s = current_ttl,
        recommended_ttl_s = recommended,
        action = final_action,
        "P84-J: hourly tuning cycle"
    );

    if final_action != "none" && final_action != "unchanged" {
      ttl_atomic.store(recommended, Ordering::Release);
      // P84-J-09: flush existing entries when TTL decreases so they are
      // not served with the old (longer) expiry.
      if final_action == "decreased" {
        cache.invalidate_cache(&snapshot.cache_name);
        debug!(
            cache = %snapshot.cache_name,
            old_ttl_s = current_ttl,
            new_ttl_s = recommended,
            "P84-J-09: TTL decreased — flushing cache entries"
        );
      }
    }

    persist_record(
      metrics,
      &TuningRecord {
        snapshot: snapshot.clone(),
        current_ttl,
        recommended_ttl: recommended,
        action: final_action,
        cycle_type: "hourly",
      },
    )
    .await;
  }

  debug!("P84-J: hourly tuning cycle complete");
}

/// Run one daily tuning cycle: aggressive rules + retention cleanup.
async fn run_daily_cycle(cache: &QueryCache, config: &CacheConfig, metrics: &MetricsService) {
  let bounds_list = all_bounds(config);
  let ttl_handles = cache.all_current_ttls();
  let metrics_list = [
    cache.metrics_server_config.snapshot_and_reset(),
    cache.metrics_user_features.snapshot_and_reset(),
    cache.metrics_throttle_config.snapshot_and_reset(),
    cache.metrics_ws_settings.snapshot_and_reset(),
  ];

  // P84-J-13: Collect per-cache results for the structured daily report.
  let mut report_caches: Vec<CacheReport> = Vec::with_capacity(metrics_list.len());

  for (i, snapshot) in metrics_list.iter().enumerate() {
    let bounds = &bounds_list[i];
    let (_, ttl_atomic) = ttl_handles[i];
    let current_ttl = ttl_atomic.load(Ordering::Acquire);

    // P84-J-18: Admin fixed-TTL override — skip auto-tuning for this cache.
    if let Some(fixed) = bounds.fixed_ttl {
      if current_ttl != fixed {
        ttl_atomic.store(fixed, Ordering::Release);
      }
      info!(
          cache = %snapshot.cache_name,
          fixed_ttl_s = fixed,
          "P84-J-18: fixed TTL override active — daily auto-tuning skipped"
      );
      continue;
    }

    let (recommended, action) = apply_daily_rules(snapshot, current_ttl, bounds);

    info!(
        cycle = "daily",
        cache = %snapshot.cache_name,
        hit_rate = format!("{:.1}%", snapshot.hit_rate * 100.0),
        total_requests = snapshot.total_requests,
        invalidations_local = snapshot.invalidations_local,
        invalidations_remote = snapshot.invalidations_remote,
        current_ttl_s = current_ttl,
        recommended_ttl_s = recommended,
        action = action,
        "P84-J: daily tuning cycle"
    );

    if action != "none" && action != "unchanged" {
      ttl_atomic.store(recommended, Ordering::Release);
      // P84-J-09: flush on decrease (same as hourly cycle).
      if action == "decreased" {
        cache.invalidate_cache(&snapshot.cache_name);
        debug!(
            cache = %snapshot.cache_name,
            old_ttl_s = current_ttl,
            new_ttl_s = recommended,
            "P84-J-09: TTL decreased (daily) — flushing cache entries"
        );
      }
    }

    persist_record(
      metrics,
      &TuningRecord {
        snapshot: snapshot.clone(),
        current_ttl,
        recommended_ttl: recommended,
        action,
        cycle_type: "daily",
      },
    )
    .await;

    // Collect for P84-J-13 summary.
    report_caches.push(CacheReport {
      name: snapshot.cache_name.clone(),
      avg_hit_rate_24h: snapshot.hit_rate,
      total_requests_24h: snapshot.total_requests,
      total_invalidations_24h: snapshot.invalidations_local + snapshot.invalidations_remote,
      previous_ttl_s: current_ttl,
      new_ttl_s: recommended,
      action,
    });
  }

  // P84-J-13: Emit structured daily summary.
  let report = DailyReport { caches: report_caches };
  match serde_json::to_string(&report) {
    Ok(json) => info!(cycle = "daily", report = %json, "P84-J-13: daily tuning report"),
    Err(e) => warn!(error = %e, "P84-J-13: failed to serialize daily report"),
  }

  // P84-J-14: Retention cleanup.
  run_retention_cleanup(metrics).await;

  debug!("P84-J: daily tuning cycle complete");
}

/// P84-J-14: Delete expired tuning records per retention policy.
/// - Hourly records: keep 7 days.
/// - Daily records: keep 90 days.
async fn run_retention_cleanup(metrics: &MetricsService) {
  match metrics.prune_cache_tuning_history().await {
    Ok((hourly_deleted, daily_deleted)) => info!(hourly_deleted, daily_deleted, "P84-J: retention cleanup complete"),
    Err(error) => warn!(%error, "P84-J: retention cleanup failed"),
  }
}

// ─── P104-B: Doc-cache auto-tuning (+100%/-50% per-cycle constraint) ─────────

/// Per-doc-cache tuning bounds.  The per-cycle constraint (+100%/-50%) is
/// applied in addition to the absolute min/max bounds.
struct DocCacheBounds {
  name: &'static str,
  min_ttl: u64,
  max_ttl: u64,
  fixed_ttl: Option<u64>,
}

/// Build bounds for the tunable doc-caches from config.
fn doc_cache_bounds(config: &CacheConfig) -> [DocCacheBounds; 4] {
  [
    DocCacheBounds {
      name: "doc_snapshot",
      min_ttl: config.doc_snapshot_min_ttl_seconds,
      max_ttl: config.doc_snapshot_max_ttl_seconds,
      fixed_ttl: config.doc_snapshot_fixed_ttl_seconds,
    },
    DocCacheBounds {
      name: "doc_metadata",
      min_ttl: config.doc_metadata_min_ttl_seconds,
      max_ttl: config.doc_metadata_max_ttl_seconds,
      fixed_ttl: config.doc_metadata_fixed_ttl_seconds,
    },
    DocCacheBounds {
      name: "doc_metadata_projection",
      min_ttl: config.doc_metadata_projection_min_ttl_seconds,
      max_ttl: config.doc_metadata_projection_max_ttl_seconds,
      fixed_ttl: config.doc_metadata_projection_fixed_ttl_seconds,
    },
    DocCacheBounds {
      name: "doc_timestamps",
      min_ttl: config.doc_timestamps_min_ttl_seconds,
      max_ttl: config.doc_timestamps_max_ttl_seconds,
      fixed_ttl: config.doc_timestamps_fixed_ttl_seconds,
    },
  ]
}

/// Apply the +100%/-50% per-cycle constraint for doc-caches.
///
/// `raw` is the output of `apply_hourly_rules` / `apply_daily_rules` before
/// absolute clamping.  We first clamp to [current×0.5, current×2] then apply
/// the absolute min/max from config.
fn constrain_doc_cache_ttl(raw: u64, current_ttl: u64, bounds: &DocCacheBounds) -> (u64, &'static str) {
  let max_up = current_ttl.saturating_mul(2); // +100%
  let max_down = (current_ttl / 2).max(1); // -50%
  let constrained = raw.clamp(max_down, max_up);
  let final_ttl = constrained.clamp(bounds.min_ttl, bounds.max_ttl);
  let action: &'static str = if final_ttl > current_ttl {
    "increased"
  } else if final_ttl < current_ttl {
    "decreased"
  } else {
    "unchanged"
  };
  (final_ttl, action)
}

/// One tuning-owned, swap-to-zero sample from a document-cache partition.
///
/// `tuning` preserves the existing persisted metric contract: its misses are
/// absent Redis keys and its local invalidations are explicit eviction
/// operations. The remaining fields retain causes that must not inflate the
/// miss rate or be mistaken for confirmed deletions.
struct DocCacheEventSnapshot {
  tuning: CacheMetricsSnapshot,
  decode_errors: u64,
  read_errors: u64,
  disabled: u64,
  skipped_oversized: u64,
  uncacheable: u64,
  writes: u64,
  write_errors: u64,
  eviction_errors: u64,
  evicted_keys: u64,
  version_changes: u64,
}

impl DocCacheEventSnapshot {
  /// Add freshness churn only to the tuning decision, keeping it distinct
  /// from the explicit-eviction metric persisted for operators.
  fn decision_snapshot(&self) -> CacheMetricsSnapshot {
    let mut snapshot = self.tuning.clone();
    snapshot.invalidations_local = snapshot.invalidations_local.saturating_add(self.version_changes);
    snapshot
  }
}

/// Atomically consume the complete event interval for one tuning cycle.
fn build_doc_cache_snapshot(name: &'static str, events: &DocCacheEventCounters) -> DocCacheEventSnapshot {
  let h = events.hits.swap(0, Ordering::AcqRel);
  let m = events.absent.swap(0, Ordering::AcqRel);
  let total = h + m;
  let hit_rate = if total > 0 { h as f64 / total as f64 } else { 0.0 };
  DocCacheEventSnapshot {
    tuning: CacheMetricsSnapshot {
      cache_name: name.to_string(),
      hits: h,
      misses: m,
      hit_rate,
      invalidations_local: events.eviction_attempts.swap(0, Ordering::AcqRel),
      invalidations_remote: 0,
      total_requests: total,
      measured_at: chrono::Utc::now(),
    },
    decode_errors: events.decode_errors.swap(0, Ordering::AcqRel),
    read_errors: events.read_errors.swap(0, Ordering::AcqRel),
    disabled: events.disabled.swap(0, Ordering::AcqRel),
    skipped_oversized: events.skipped_oversized.swap(0, Ordering::AcqRel),
    uncacheable: events.uncacheable.swap(0, Ordering::AcqRel),
    writes: events.writes.swap(0, Ordering::AcqRel),
    write_errors: events.write_errors.swap(0, Ordering::AcqRel),
    eviction_errors: events.eviction_errors.swap(0, Ordering::AcqRel),
    evicted_keys: events.evicted_keys.swap(0, Ordering::AcqRel),
    version_changes: events.version_changes.swap(0, Ordering::AcqRel),
  }
}

fn log_doc_cache_events(cycle: &'static str, events: &DocCacheEventSnapshot) {
  info!(
    cycle,
    cache = %events.tuning.cache_name,
    hits = events.tuning.hits,
    absent = events.tuning.misses,
    decode_errors = events.decode_errors,
    read_errors = events.read_errors,
    disabled = events.disabled,
    skipped_oversized = events.skipped_oversized,
    uncacheable = events.uncacheable,
    writes = events.writes,
    write_errors = events.write_errors,
    eviction_attempts = events.tuning.invalidations_local,
    eviction_errors = events.eviction_errors,
    evicted_keys = events.evicted_keys,
    version_changes = events.version_changes,
    "P104-B: document-cache event interval"
  );
}

/// Run one hourly tuning cycle for the tunable doc-caches.
async fn run_hourly_cycle_doc_caches(handles: &DocCacheTuningHandles, config: &CacheConfig, metrics: &MetricsService) {
  let bounds_list = doc_cache_bounds(config);
  let cache_handles: [(&std::sync::atomic::AtomicU64, &DocCacheEventCounters); 4] = [
    (&handles.snapshot_ttl, &handles.snapshot_events),
    (&handles.metadata_ttl, &handles.metadata_events),
    (&handles.metadata_projection_ttl, &handles.metadata_projection_events),
    (&handles.timestamps_ttl, &handles.timestamps_events),
  ];

  for (i, (ttl_atomic, counters)) in cache_handles.iter().enumerate() {
    let bounds = &bounds_list[i];
    let current_ttl = ttl_atomic.load(Ordering::Acquire);
    let events = build_doc_cache_snapshot(bounds.name, counters);
    log_doc_cache_events("hourly", &events);

    // P104-B: Fixed TTL override — skip auto-tuning for this cache.
    if let Some(fixed) = bounds.fixed_ttl {
      if current_ttl != fixed {
        ttl_atomic.store(fixed, Ordering::Release);
      }
      info!(
        cache = bounds.name,
        fixed_ttl_s = fixed,
        "P104-B: doc-cache fixed TTL override active — hourly auto-tuning skipped"
      );
      // Still persist so the status table has up-to-date data.
      persist_record(
        metrics,
        &TuningRecord {
          snapshot: events.tuning,
          current_ttl: fixed,
          recommended_ttl: fixed,
          action: "fixed",
          cycle_type: "hourly",
        },
      )
      .await;
      continue;
    }

    // Oscillation guard (reuses QueryCache mechanism).
    if is_oscillating(metrics, bounds.name).await {
      warn!(
        cache = bounds.name,
        "P104-B: oscillation detected for doc-cache — skipping hourly cycle"
      );
      persist_record(
        metrics,
        &TuningRecord {
          snapshot: events.tuning,
          current_ttl,
          recommended_ttl: current_ttl,
          action: "skipped",
          cycle_type: "hourly",
        },
      )
      .await;
      continue;
    }

    let decision_snapshot = events.decision_snapshot();

    // Use same rules as QueryCache but with a proxy CacheBounds for the raw calc.
    let proxy_bounds = CacheBounds {
      name: bounds.name,
      min_ttl: bounds.min_ttl,
      max_ttl: bounds.max_ttl,
      fixed_ttl: None,
    };
    let (raw, _) = apply_hourly_rules(&decision_snapshot, current_ttl, &proxy_bounds);

    // Apply +100%/-50% per-cycle constraint THEN absolute min/max.
    let (constrained, _) = constrain_doc_cache_ttl(raw, current_ttl, bounds);

    // P84-J-17 equivalent: max 4× change in 24h.
    let recommended = if constrained != current_ttl {
      clamp_max_24h_change(metrics, bounds.name, current_ttl, constrained).await
    } else {
      constrained
    };

    let final_action: &'static str = if recommended > current_ttl {
      "increased"
    } else if recommended < current_ttl {
      "decreased"
    } else {
      "unchanged"
    };

    info!(
      cycle = "hourly",
      cache = bounds.name,
      hit_rate = format!("{:.1}%", events.tuning.hit_rate * 100.0),
      total_requests = events.tuning.total_requests,
      current_ttl_s = current_ttl,
      recommended_ttl_s = recommended,
      action = final_action,
      "P104-B: doc-cache hourly tuning cycle"
    );

    if final_action == "increased" || final_action == "decreased" {
      ttl_atomic.store(recommended, Ordering::Release);
    }

    persist_record(
      metrics,
      &TuningRecord {
        snapshot: events.tuning,
        current_ttl,
        recommended_ttl: recommended,
        action: final_action,
        cycle_type: "hourly",
      },
    )
    .await;
  }

  let index_events = build_doc_cache_snapshot("document_metadata_index", &handles.document_metadata_index_events);
  log_doc_cache_events("hourly-fixed", &index_events);
  let database_events = build_doc_cache_snapshot("database_page_inventory", &handles.database_page_inventory_events);
  log_doc_cache_events("hourly-fixed", &database_events);

  debug!("P104-B: doc-cache hourly tuning cycle complete");
}

/// Run one daily tuning cycle for the tunable doc-caches.
async fn run_daily_cycle_doc_caches(handles: &DocCacheTuningHandles, config: &CacheConfig, metrics: &MetricsService) {
  let bounds_list = doc_cache_bounds(config);
  let cache_handles: [(&std::sync::atomic::AtomicU64, &DocCacheEventCounters); 4] = [
    (&handles.snapshot_ttl, &handles.snapshot_events),
    (&handles.metadata_ttl, &handles.metadata_events),
    (&handles.metadata_projection_ttl, &handles.metadata_projection_events),
    (&handles.timestamps_ttl, &handles.timestamps_events),
  ];

  for (i, (ttl_atomic, counters)) in cache_handles.iter().enumerate() {
    let bounds = &bounds_list[i];
    let current_ttl = ttl_atomic.load(Ordering::Acquire);
    let events = build_doc_cache_snapshot(bounds.name, counters);
    log_doc_cache_events("daily", &events);

    if let Some(fixed) = bounds.fixed_ttl {
      if current_ttl != fixed {
        ttl_atomic.store(fixed, Ordering::Release);
      }
      info!(
        cache = bounds.name,
        fixed_ttl_s = fixed,
        "P104-B: doc-cache fixed TTL override active — daily auto-tuning skipped"
      );
      persist_record(
        metrics,
        &TuningRecord {
          snapshot: events.tuning,
          current_ttl: fixed,
          recommended_ttl: fixed,
          action: "fixed",
          cycle_type: "daily",
        },
      )
      .await;
      continue;
    }

    let decision_snapshot = events.decision_snapshot();
    let proxy_bounds = CacheBounds {
      name: bounds.name,
      min_ttl: bounds.min_ttl,
      max_ttl: bounds.max_ttl,
      fixed_ttl: None,
    };
    let (raw, _) = apply_daily_rules(&decision_snapshot, current_ttl, &proxy_bounds);
    let (constrained, _) = constrain_doc_cache_ttl(raw, current_ttl, bounds);
    let recommended = if constrained != current_ttl {
      clamp_max_24h_change(metrics, bounds.name, current_ttl, constrained).await
    } else {
      constrained
    };

    let final_action: &'static str = if recommended > current_ttl {
      "increased"
    } else if recommended < current_ttl {
      "decreased"
    } else {
      "unchanged"
    };

    info!(
      cycle = "daily",
      cache = bounds.name,
      hit_rate = format!("{:.1}%", events.tuning.hit_rate * 100.0),
      total_requests = events.tuning.total_requests,
      current_ttl_s = current_ttl,
      recommended_ttl_s = recommended,
      action = final_action,
      "P104-B: doc-cache daily tuning cycle"
    );

    if final_action == "increased" || final_action == "decreased" {
      ttl_atomic.store(recommended, Ordering::Release);
    }

    persist_record(
      metrics,
      &TuningRecord {
        snapshot: events.tuning,
        current_ttl,
        recommended_ttl: recommended,
        action: final_action,
        cycle_type: "daily",
      },
    )
    .await;
  }

  let index_events = build_doc_cache_snapshot("document_metadata_index", &handles.document_metadata_index_events);
  log_doc_cache_events("daily-fixed", &index_events);
  let database_events = build_doc_cache_snapshot("database_page_inventory", &handles.database_page_inventory_events);
  log_doc_cache_events("daily-fixed", &database_events);

  debug!("P104-B: doc-cache daily tuning cycle complete");
}

/// Public entry point for the hourly doc-cache tuning cycle — exposed for integration testing.
pub async fn run_hourly_cycle_doc_caches_once(
  handles: &DocCacheTuningHandles,
  config: &CacheConfig,
  metrics: &MetricsService,
) {
  run_hourly_cycle_doc_caches(handles, config, metrics).await;
}

/// Public entry point for the daily doc-cache tuning cycle — exposed for integration testing.
pub async fn run_daily_cycle_doc_caches_once(
  handles: &DocCacheTuningHandles,
  config: &CacheConfig,
  metrics: &MetricsService,
) {
  run_daily_cycle_doc_caches(handles, config, metrics).await;
}

/// P84-J-06/P84-J-10: Spawn the hourly TTL tuning background task.
///
/// Returns the `JoinHandle`.  If `hourly_enabled` is `false`, returns a
/// no-op handle immediately.
pub fn start_hourly_tuner(
  cache: QueryCache,
  config: CacheConfig,
  metrics: Arc<MetricsService>,
  doc_cache_handles: Option<DocCacheTuningHandles>,
) -> JoinHandle<()> {
  if !config.tuning_hourly_enabled {
    info!("P84-J: hourly tuning disabled (cache.tuning_hourly_enabled = false)");
    return tokio::spawn(async {});
  }

  tokio::spawn(async move {
    info!("P84-J: starting hourly cache TTL tuning task");
    let mut interval = tokio::time::interval(Duration::from_secs(3600));
    interval.tick().await; // discard first immediate tick
    loop {
      interval.tick().await;
      run_hourly_cycle(&cache, &config, metrics.as_ref()).await;
      if let Some(ref handles) = doc_cache_handles {
        run_hourly_cycle_doc_caches(handles, &config, metrics.as_ref()).await;
      }
    }
  })
}

/// P84-J-11/P84-J-15: Spawn the daily TTL tuning background task.
///
/// Returns the `JoinHandle`.  If `daily_enabled` is `false`, returns a
/// no-op handle immediately.
pub fn start_daily_tuner(
  cache: QueryCache,
  config: CacheConfig,
  metrics: Arc<MetricsService>,
  doc_cache_handles: Option<DocCacheTuningHandles>,
) -> JoinHandle<()> {
  if !config.tuning_daily_enabled {
    info!("P84-J: daily tuning disabled (cache.tuning_daily_enabled = false)");
    return tokio::spawn(async {});
  }

  tokio::spawn(async move {
    info!("P84-J: starting daily cache TTL tuning task");
    let mut interval = tokio::time::interval(Duration::from_secs(86400));
    interval.tick().await; // discard first immediate tick
    loop {
      interval.tick().await;
      run_daily_cycle(&cache, &config, metrics.as_ref()).await;
      if let Some(ref handles) = doc_cache_handles {
        run_daily_cycle_doc_caches(handles, &config, metrics.as_ref()).await;
      }
    }
  })
}

/// P84-J-19: At server startup, read the last daily recommendation per cache
/// from `cache_tuning_metrics` (must be younger than 48h) and apply it by
/// updating the `current_ttl_*` atomics.
///
/// Non-fatal: if the query fails or no recent recommendation exists, the
/// configured defaults are used.
pub async fn apply_startup_ttl_recommendations(cache: &QueryCache, metrics: &MetricsService) {
  // For each cache, find the most recent daily record within 48h.
  let names = ["server_config", "user_features", "throttle_config", "ws_settings"];

  let ttl_handles: [(&str, &std::sync::Arc<std::sync::atomic::AtomicU64>); 4] = [
    ("server_config", &cache.current_ttl_server_config),
    ("user_features", &cache.current_ttl_user_features),
    ("throttle_config", &cache.current_ttl_throttle_config),
    ("ws_settings", &cache.current_ttl_ws_settings),
  ];

  for (i, &name) in names.iter().enumerate() {
    let row = metrics.latest_daily_cache_ttl(name).await;

    match row {
      Ok(Some(rec_ttl)) if rec_ttl > 0 => {
        let (_, atomic) = ttl_handles[i];
        atomic.store(rec_ttl as u64, Ordering::Release);
        info!(
          cache = name,
          recommended_ttl_s = rec_ttl,
          "P84-J-19: applied last daily TTL recommendation at startup"
        );
      }
      Ok(None) => {
        debug!(
          cache = name,
          "P84-J-19: no recent daily recommendation — using config default"
        );
      }
      Err(e) => {
        warn!(cache = name, error = %e, "P84-J-19: failed to read startup TTL recommendation");
      }
      _ => {}
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::cache::CacheMetricsSnapshot;

  fn snapshot(name: &str, hits: u64, misses: u64, inv_local: u64, inv_remote: u64) -> CacheMetricsSnapshot {
    let total = hits + misses;
    let hit_rate = if total == 0 { 0.0 } else { hits as f64 / total as f64 };
    CacheMetricsSnapshot {
      cache_name: name.to_string(),
      hits,
      misses,
      hit_rate,
      invalidations_local: inv_local,
      invalidations_remote: inv_remote,
      total_requests: total,
      measured_at: chrono::Utc::now(),
    }
  }

  fn default_bounds() -> CacheBounds {
    CacheBounds {
      name: "test",
      min_ttl: 30,
      max_ttl: 3600,
      fixed_ttl: None,
    }
  }

  // P84-J-20: hourly rule tests

  #[test]
  fn test_hourly_low_hit_rate_increases_ttl() {
    let s = snapshot("app_config", 25, 75, 0, 0); // 25% hit rate, 100 total
    let (rec, action) = apply_hourly_rules(&s, 300, &default_bounds());
    assert_eq!(action, "increased");
    assert!(rec > 300);
  }

  #[test]
  fn test_hourly_medium_hit_rate_increases_ttl() {
    let s = snapshot("app_config", 40, 60, 0, 0); // 40% hit rate
    let (rec, action) = apply_hourly_rules(&s, 300, &default_bounds());
    assert_eq!(action, "increased");
    assert!(rec > 300, "expected rec > 300 but got {rec}");
  }

  #[test]
  fn test_hourly_good_hit_rate_no_change() {
    let s = snapshot("app_config", 70, 30, 0, 0); // 70% hit rate, low invalidations
    let (rec, action) = apply_hourly_rules(&s, 300, &default_bounds());
    assert_eq!(action, "unchanged");
    assert_eq!(rec, 300);
  }

  #[test]
  fn test_hourly_high_hit_rate_high_invalidations_decreases_ttl() {
    // 90% hit rate but lots of invalidations relative to hits
    let s = snapshot("app_config", 900, 100, 200, 0); // inv/hit = 0.22
    let (rec, action) = apply_hourly_rules(&s, 300, &default_bounds());
    assert_eq!(action, "decreased");
    assert!(rec < 300);
  }

  #[test]
  fn test_hourly_too_few_requests_no_change() {
    let s = snapshot("app_config", 5, 10, 0, 0); // only 15 requests
    let (rec, action) = apply_hourly_rules(&s, 300, &default_bounds());
    assert_eq!(action, "none");
    assert_eq!(rec, 300);
  }

  // P84-J-21: daily rule tests

  #[test]
  fn test_daily_low_avg_doubles_ttl() {
    let s = snapshot("user_features", 30, 170, 0, 0); // 15% hit rate, 200 total
    let (rec, action) = apply_daily_rules(&s, 120, &default_bounds());
    assert_eq!(action, "increased");
    assert!(rec > 120);
  }

  #[test]
  fn test_daily_high_avg_with_invalidations_decreases() {
    // 80% hit rate, many invalidations
    let s = snapshot("user_features", 800, 200, 200, 0); // inv/hit = 0.25
    let (rec, action) = apply_daily_rules(
      &s,
      120,
      &CacheBounds {
        name: "test",
        min_ttl: 10,
        max_ttl: 600,
        fixed_ttl: None,
      },
    );
    assert_eq!(action, "decreased");
    assert!(rec < 120);
  }

  #[test]
  fn test_daily_stable_no_change() {
    let s = snapshot("throttle_config", 500, 200, 20, 0); // 71% hit, low inv/hit
    let (rec, action) = apply_daily_rules(
      &s,
      30,
      &CacheBounds {
        name: "test",
        min_ttl: 10,
        max_ttl: 120,
        fixed_ttl: None,
      },
    );
    assert_eq!(action, "unchanged");
    assert_eq!(rec, 30);
  }

  #[test]
  fn test_daily_too_few_requests_no_change() {
    let s = snapshot("app_config", 10, 50, 0, 0); // only 60 requests
    let (rec, action) = apply_daily_rules(&s, 300, &default_bounds());
    assert_eq!(action, "none");
    assert_eq!(rec, 300);
  }

  #[test]
  fn test_max_ttl_clamped() {
    let bounds = CacheBounds {
      name: "test",
      min_ttl: 30,
      max_ttl: 400,
      fixed_ttl: None,
    };
    // Need ≥ 200 total requests to pass the daily guard, with low hit rate (< 0.20)
    // so the ×2.0 multiplier fires: 300 × 2.0 = 600, clamped to max_ttl 400.
    let s = snapshot("app_config", 20, 180, 0, 0); // 10% hit rate, 200 total
    let (rec, action) = apply_daily_rules(&s, 300, &bounds);
    assert_eq!(rec, 400, "should be clamped to max_ttl");
    assert_eq!(action, "increased");
  }

  #[test]
  fn test_min_ttl_clamped() {
    let bounds = CacheBounds {
      name: "test",
      min_ttl: 60,
      max_ttl: 3600,
      fixed_ttl: None,
    };
    // High inv/hit will try × 0.5 = 15, but min is 60.
    let s = snapshot("app_config", 900, 100, 500, 0); // inv/hit = 0.56
    let (rec, _) = apply_hourly_rules(&s, 60, &bounds);
    assert!(rec >= 60, "should be clamped to min_ttl");
  }
}
