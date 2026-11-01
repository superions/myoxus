//! Telemetry ingest pipeline.
//!
//! The application layer defines:
//! * [`models::TelemetryEvent`] — the client-sent shape.
//! * [`service::TelemetryIngestService`] — validates, dedupes, strips PII,
//!   enqueues into a hot buffer, and exposes Prometheus counters.
//! * [`service::TelemetryPolicy`] — runtime knobs derived from
//!   `crate::config::TelemetryConfig`.
//! * [`error::TelemetryError`] — public failure taxonomy.
//!
//! Infrastructure implementations live in the `myoxus-infrastructure` crate
//! (`telemetry::SqlxTelemetryRepository`, `RedisTelemetryDedupeStore`).
//!
//! See `todo/telemetry.md` and `docs/dev/server/telemetry.md` for design,
//! invariants, and DSGVO flow.

pub mod error;
pub mod models;
pub mod service;

pub use error::TelemetryError;
pub use models::{FlushStats, TELEMETRY_SCHEMA_MAX, TELEMETRY_SCHEMA_MIN, TelemetryBatch, TelemetryEvent};
pub use service::{TelemetryCounters, TelemetryIngestService, TelemetryPolicy};

/// Backwards-compat alias so legacy call sites (`ApiState::telemetry()`)
/// continue to compile.
pub type TelemetryService = TelemetryIngestService;
