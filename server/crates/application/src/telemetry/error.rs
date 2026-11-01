//! Errors surfaced by the telemetry ingest pipeline.

use myoxus_domain::telemetry::TelemetryStoreError;
use thiserror::Error;

/// Outcome of a single-event ingest call.
#[derive(Debug, Error)]
pub enum TelemetryError {
  /// Telemetry is globally disabled. Handler MUST return 503 (INV-TEL-03).
  #[error("telemetry is disabled")]
  Disabled,
  /// Event category is not in the enabled-categories allowlist (INV-TEL-02).
  /// Callers treat this as a silent accept (the event was valid, policy
  /// dropped it) — no client-visible error.
  #[error("category '{0}' is not enabled")]
  CategoryDisabled(String),
  /// Event was sampled out. Silent accept.
  #[error("sampled out")]
  SampledOut,
  /// Dedupe store reports this `event_id` has already been seen (INV-TEL-01).
  #[error("duplicate event_id")]
  Duplicate,
  /// Event violates schema (missing/invalid fields).
  #[error("invalid event: {0}")]
  Invalid(String),
  /// Persistence or dedupe store failure.
  #[error("store error: {0}")]
  Store(#[from] TelemetryStoreError),
}

impl TelemetryError {
  /// Whether this error should be surfaced to the client as an accept (policy
  /// drop) vs. a genuine failure.  Policy drops return 202 Accepted with
  /// `dropped>0`; genuine failures return 5xx / `Disabled` returns 503.
  pub fn is_policy_drop(&self) -> bool {
    matches!(
      self,
      TelemetryError::CategoryDisabled(_) | TelemetryError::SampledOut | TelemetryError::Duplicate
    )
  }
}
