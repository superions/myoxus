//! Port traits for telemetry persistence and dedupe.
//!
//! The application-layer `TelemetryIngestService` depends on these traits
//! rather than concrete storage backends, keeping the ingest pipeline
//! testable and storage-agnostic.
//!
//! * [`TelemetryRepository`] — persists a batch of raw events to long-term
//!   storage (INV-TEL-01: `event_id` is UNIQUE).
//! * [`TelemetryDedupeStore`] — short-TTL first-seen registry used to drop
//!   duplicate client submissions before they reach the database.
//!
//! See `docs/dev/server/telemetry.md` and `todo/telemetry.md` for the full
//! invariant catalog.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

/// A single telemetry event in the form the repository persists.
///
/// This type is deliberately storage-oriented (already PII-stripped, category
/// resolved). The application service is responsible for validating and
/// transforming the client-supplied event shape into this canonical form
/// before calling [`TelemetryRepository::insert_batch`].
#[derive(Debug, Clone)]
pub struct TelemetryEventRecord {
  /// Client-supplied idempotency key. UNIQUE in `telemetry_events`.
  pub event_id: String,
  /// Event name (`pageView`, `doc.create`, etc.).
  pub event_name: String,
  /// Category (`page_view`, `doc_op`, `error`, `auth`, `admin_action`,
  /// `ai_interaction`).
  pub category: String,
  /// Optional user reference. Cascade-deleted when the user is deleted.
  pub user_id: Option<Uuid>,
  /// Opaque client identifier.
  pub client_id: Option<String>,
  /// Opaque session identifier.
  pub session_id: Option<String>,
  /// Client-side schema version.
  pub schema_version: i16,
  /// PII-stripped event params.
  pub params: Value,
  /// PII-stripped user-properties.
  pub user_properties: Value,
  /// PII-stripped context (IP removed).
  pub context: Value,
  /// Client-reported timestamp.
  pub client_timestamp: DateTime<Utc>,
}

/// Errors surfaced by [`TelemetryRepository`] and [`TelemetryDedupeStore`].
#[derive(Debug, Error)]
pub enum TelemetryStoreError {
  /// Backend I/O failure (Postgres / Redis unavailable).
  #[error("telemetry store backend error: {0}")]
  Backend(String),
}

pub type TelemetryStoreResult<T> = Result<T, TelemetryStoreError>;

/// Long-term persistence of raw telemetry events.
#[async_trait]
pub trait TelemetryRepository: Send + Sync {
  /// Bulk-insert a batch of events.  Implementations MUST honor the
  /// `event_id` UNIQUE constraint: duplicate rows are silently skipped
  /// (ON CONFLICT DO NOTHING) so that a flush retry after a partial failure
  /// is idempotent.  Returns the number of rows actually inserted.
  async fn insert_batch(&self, events: &[TelemetryEventRecord]) -> TelemetryStoreResult<u64>;

  /// Count rows for health-check / admin-status purposes.
  async fn count_recent(&self, since: DateTime<Utc>) -> TelemetryStoreResult<u64>;

  /// Count `telemetry_daily` rollup rows for days `>= since` (date, inclusive).
  /// Used by the admin status endpoint to surface recent aggregation coverage.
  async fn count_daily_rollups_since(&self, since: chrono::NaiveDate) -> TelemetryStoreResult<u64>;

  /// Rebuild the previous UTC day's rollups while holding the repository's
  /// cross-instance maintenance lock. `None` means another instance owns it.
  async fn rollup_previous_day(&self) -> TelemetryStoreResult<Option<u64>>;

  /// Delete data outside both retention windows under the cross-instance
  /// maintenance lock. `None` means another instance owns it.
  async fn apply_retention(&self, raw_days: u32, daily_days: u32) -> TelemetryStoreResult<Option<(u64, u64)>>;
}

/// Short-TTL first-seen registry for event-level dedupe.
///
/// Keyed by the client-supplied `event_id`; the first caller to register the
/// key wins, all subsequent submissions for the same key are treated as
/// replays until the entry expires.
#[async_trait]
pub trait TelemetryDedupeStore: Send + Sync {
  /// Atomically record `event_id` with `ttl_seconds`. Returns `Ok(true)` if
  /// the key was newly inserted (first-seen), `Ok(false)` if it already
  /// existed (replay).
  async fn try_register(&self, event_id: &str, ttl_seconds: u64) -> TelemetryStoreResult<bool>;
}
