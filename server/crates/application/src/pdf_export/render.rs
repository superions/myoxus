// SPDX-License-Identifier: AGPL-3.0-or-later
use uuid::Uuid;

/// Outcome of a sync-path attempt in the shared PDF create use case.
///
/// The use case maps these directly:
/// - [`Self::Rendered`] → INSERT row with `status='done'`, return job
/// - [`Self::TooLargeForSync`] → fall through to existing async/queue path
/// - [`Self::Failed`] → return GraphQL error with `extensions.class` set
#[derive(Debug)]
pub enum SyncRenderOutcome {
  /// The PDF was produced and written to object storage. The use case must
  /// still INSERT a `pdf_export_jobs` row pointing at this blob.
  Rendered {
    blob_id: Uuid,
    size_bytes: usize,
    /// Page count observed in the compiled document, used for the
    /// `pdf_export.pages_total` metric and admin UX.
    page_count: usize,
    /// Theme font families the renderer could not resolve in the FontBook.
    /// The API pins Theme DB roles to concrete assets before dispatch, so this
    /// should stay empty unless that contract was bypassed or an asset changed
    /// after enqueue.
    unmapped_font_families: Vec<String>,
    /// Observed omissions from the canonical IR builder, never full readiness.
    renderer_diagnostics: serde_json::Value,
  },
  /// The IR builder rejected the document because it has more blocks than
  /// the configured sync threshold. Caller should run the async path.
  TooLargeForSync,
  /// An unrecoverable error in the pipeline. Caller should surface it as a
  /// structured use-case error without publishing a successful job.
  Failed {
    class: &'static str,
    detail: String,
    /// Available only after the canonical IR builder completed. The report
    /// remains useful when a later compiler/storage stage fails.
    renderer_diagnostics: Option<serde_json::Value>,
  },
}

/// Validated bytes before publication; the caller owns private storage/lifetime.
pub struct SnapshotRenderedPdf {
  pub bytes: Vec<u8>,
  pub page_count: usize,
  pub unmapped_font_families: Vec<String>,
  pub renderer_diagnostics: serde_json::Value,
}
