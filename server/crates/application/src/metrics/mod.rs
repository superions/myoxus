//! Business-metrics pipeline.
//!
//! Structurally this module is the twin of `telemetry` but for *aggregate*
//! counters rather than per-event rows:
//!
//! ```text
//! service-layer hook (auth / workspace / doc / collab / ai)
//!   → MetricsPolicy::category_enabled? → short-circuit if disabled (INV-MET-01)
//!   → MetricsRecorder::counter_inc(category, name, labels, delta)
//!     ↳ cardinality guard (INV-MET-06) — drop + log if over limit
//! [background flush, every `flush_interval_seconds`]
//!   → MetricsRecorder::snapshot() returns Vec<MetricSample>
//!   → MetricsRepository::insert_minute_batch (UPSERT into metrics_raw)
//!   → MetricsRecorder::reset_after_flush()
//! ```
//!
//! Prometheus continues to be the live surface — the recorder's running
//! counters are rendered into `/metrics/prometheus` on scrape.  DB persistence
//! exists so that historical trends survive a process restart, not as the
//! authoritative live view.
//!
//! See `docs/dev/server/metrics.md` and `todo/metrics.md`.

pub mod error;
pub mod models;
pub mod recorder;
pub mod service;

pub use error::MetricsError;
pub use models::{METRICS_CATEGORIES, MetricsCategory, MetricsPolicy};
pub use recorder::{InMemoryMetricsRecorder, MetricsCounters, MetricsRecorder};
pub use service::MetricsService;
