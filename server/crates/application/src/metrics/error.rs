//! Public failure taxonomy for the metrics pipeline.

use myoxus_domain::metrics::MetricsStoreError;
use thiserror::Error;

/// Errors produced during `counter_inc` / `snapshot` / `flush`.
#[derive(Debug, Error)]
pub enum MetricsError {
  /// Business metrics are globally disabled.  Hooks SHOULD short-circuit
  /// before even constructing arguments, so this is only produced by the
  /// admin-flush-now path.
  #[error("metrics collection is disabled")]
  Disabled,

  /// The `(category, name, labels)` triple exceeded the per-metric cardinality
  /// limit and was dropped (INV-MET-06).  Callers treat this as a silent drop
  /// — the counter `myoxus_metrics_cardinality_drops_total` is incremented
  /// separately.
  #[error("cardinality limit reached for metric '{0}'")]
  CardinalityLimit(String),

  /// Persistence layer failure.
  #[error("store error: {0}")]
  Store(#[from] MetricsStoreError),
}

impl MetricsError {
  /// A drop that should NOT be surfaced to the caller as a hard failure:
  /// the business operation completed, only the side-effect counter was lost.
  pub fn is_silent_drop(&self) -> bool {
    matches!(self, MetricsError::Disabled | MetricsError::CardinalityLimit(_))
  }
}
