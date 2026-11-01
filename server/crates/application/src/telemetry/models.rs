//! Client-side event schema consumed by the ingest pipeline.
//!
//! The client (both HTTP POST and Socket.IO) sends events shaped like
//! `TelemetryEvent`. The ingest service validates, strips PII, and transforms
//! them into [`myoxus_domain::telemetry::TelemetryEventRecord`] before
//! persistence.

use chrono::{DateTime, TimeZone, Utc};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

/// Schema version the client MUST set on every event.
///
/// Unknown values are rejected during validation.  The persisted record
/// carries the version so rollups/migrations can reason about mixed-version
/// populations.
pub const TELEMETRY_SCHEMA_MIN: i16 = 1;
pub const TELEMETRY_SCHEMA_MAX: i16 = 1;

/// Raw event as sent by the client.
///
/// Fields mirror the frontend `TelemetryEvent` type
/// (`client/libs/core/telemetry`). Unknown fields are ignored.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryEvent {
  /// Client-supplied idempotency key (UUID v4 or nanoid).
  pub event_id: String,
  /// Schema version. See [`TELEMETRY_SCHEMA_MIN`].
  pub schema_version: i16,
  /// Event name (`pageView`, `doc.create`, `auth.login`, ...).
  pub event_name: String,
  /// Optional pre-classified category. If absent, the service derives it
  /// from `event_name`.
  #[serde(default)]
  pub category: Option<String>,
  /// Event-specific parameters.
  #[serde(default)]
  pub params: Value,
  /// Stable per-user properties.
  #[serde(default)]
  pub user_properties: Value,
  /// Opaque context (user agent, route, app version). MUST NOT contain IP.
  #[serde(default)]
  pub context: Value,
  /// Authenticated user identifier, if any.
  #[serde(default)]
  pub user_id: Option<Uuid>,
  /// Client-generated anonymous identifier.
  #[serde(default)]
  pub client_id: Option<String>,
  /// Session identifier.
  #[serde(default)]
  pub session_id: Option<String>,
  /// Microseconds since epoch (matches GA4-style client timestamps).
  #[serde(default)]
  pub timestamp_micros: Option<i64>,
  /// Client-declared opt-out: if `true`, the server drops the event without
  /// persistence regardless of configuration.
  #[serde(default)]
  pub opt_out: bool,
}

impl TelemetryEvent {
  /// Convert the client-supplied micro-timestamp to a UTC datetime, falling
  /// back to `now` when absent or out of range.
  pub fn resolved_client_timestamp(&self) -> DateTime<Utc> {
    match self.timestamp_micros {
      Some(micros) => Utc.timestamp_micros(micros).single().unwrap_or_else(Utc::now),
      None => Utc::now(),
    }
  }
}

/// Parameters for batch submission (used by HTTP handler and WS bridge).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct TelemetryBatch {
  /// Events in submission order.  May be empty.
  #[serde(default)]
  pub events: Option<Vec<TelemetryEvent>>,
}

/// Flush-outcome summary reported by the worker job.
#[derive(Debug, Clone, Copy, Default)]
pub struct FlushStats {
  /// Events removed from the hot buffer.
  pub buffered: u64,
  /// Rows successfully inserted into `telemetry_events`.
  pub inserted: u64,
}
