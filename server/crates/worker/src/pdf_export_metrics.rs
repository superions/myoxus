// SPDX-License-Identifier: AGPL-3.0-or-later
//! Observability hook trait for the PDF export pipeline.
//!
//! The worker crate stays decoupled from `myoxus-application` (and from
//! `myoxus-domain::metrics`), mirroring the [`crate::PdfBlobWriter`]
//! pattern. The api crate wires a concrete adapter that delegates into the
//! shared `MetricsService` so PDF export render outcomes land on
//! `/metrics/prometheus` next to every other business metric.
//!
//! Counter contract (category = `pdf_export`):
//!
//! | metric                      | labels                              | unit       |
//! |-----------------------------|-------------------------------------|------------|
//! | `render_total`              | `outcome`, `template_id`, `error_class?` | events |
//! | `pages_total`               | `template_id`                       | pages (sum) |
//! | `duration_ms_count`         | `outcome`                           | events     |
//! | `duration_ms_sum`           | `outcome`                           | ms (sum)   |
//!
//! `outcome` ∈ `{ "success", "ir_error", "render_error", "storage_error" }`.
//! `error_class` is only set on non-success outcomes — its values mirror the
//! stable error classes documented in `pdf_export_handler::{ir,render}_error_to_class`
//! (`TooLarge`, `Timeout`, `RenderError`, `DecodeError`, `AssetError`,
//! `TemplateError`, `StorageError`).
//!
//! Cardinality: `template_id` is bounded by the workspace template registry
//! (small, slowly-changing set). `outcome` × `error_class` is a fixed
//! enumeration. The recorder's per-metric cardinality guard (INV-MET-06)
//! protects against a future template-registry blow-up.

use std::sync::Arc;
use std::time::Duration;

/// Stable label values for `outcome` — mirror the worker's observation
/// points so the wire metric names never drift from the trait contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PdfExportOutcome {
  Success,
  IrError,
  RenderError,
  StorageError,
}

impl PdfExportOutcome {
  pub const fn as_str(&self) -> &'static str {
    match self {
      Self::Success => "success",
      Self::IrError => "ir_error",
      Self::RenderError => "render_error",
      Self::StorageError => "storage_error",
    }
  }
}

/// Observability hook surface used by the PDF export pipeline.
///
/// All methods are infallible — implementations must swallow errors so the
/// hot path stays unaffected. Pass `None` for `error_class` on success.
pub trait PdfExportMetrics: Send + Sync {
  /// Record one render attempt with its outcome, the template that was
  /// requested, the wall-clock duration, and (for non-success outcomes)
  /// the stable error class.
  fn record_render(&self, outcome: PdfExportOutcome, template_id: &str, duration: Duration, error_class: Option<&str>);

  /// Record `pages` produced by a successful render against `template_id`.
  /// No-op when `pages == 0`.
  fn record_pages(&self, template_id: &str, pages: usize);
}

/// No-op implementation used by tests and the standalone worker bin.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopPdfExportMetrics;

impl PdfExportMetrics for NoopPdfExportMetrics {
  fn record_render(&self, _: PdfExportOutcome, _: &str, _: Duration, _: Option<&str>) {}
  fn record_pages(&self, _: &str, _: usize) {}
}

/// Default value used when the api crate has not wired an adapter yet —
/// equivalent to `Arc::new(NoopPdfExportMetrics)` but spelled out so the
/// call site reads as an intentional opt-out.
pub fn noop() -> Arc<dyn PdfExportMetrics> {
  Arc::new(NoopPdfExportMetrics)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn outcome_as_str_is_stable_wire_format() {
    assert_eq!(PdfExportOutcome::Success.as_str(), "success");
    assert_eq!(PdfExportOutcome::IrError.as_str(), "ir_error");
    assert_eq!(PdfExportOutcome::RenderError.as_str(), "render_error");
    assert_eq!(PdfExportOutcome::StorageError.as_str(), "storage_error");
  }

  #[test]
  fn noop_metrics_does_not_panic() {
    let m = NoopPdfExportMetrics;
    m.record_render(PdfExportOutcome::Success, "default", Duration::from_millis(42), None);
    m.record_render(
      PdfExportOutcome::RenderError,
      "default",
      Duration::from_secs(1),
      Some("Timeout"),
    );
    m.record_pages("default", 7);
    m.record_pages("default", 0);
  }
}
