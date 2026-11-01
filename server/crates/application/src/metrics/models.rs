//! Value objects shared by the recorder and service layers.

use std::collections::HashMap;

/// Canonical list of metric categories — MUST match
/// `myoxus_api::config::METRICS_CATEGORIES`.  Duplicated here so the
/// application crate does not have to depend on `myoxus-api`.
pub const METRICS_CATEGORIES: &[&str] = &["auth", "workspace", "doc", "collab", "ai", "pdf_export", "mcp"];

/// Well-known metric categories — typed enum used by service-layer hooks for
/// compile-time correctness.  Prefer [`MetricsCategory::as_str`] over hard-
/// coding string literals at call sites.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MetricsCategory {
  Auth,
  Workspace,
  Doc,
  Collab,
  Ai,
  /// PDF export pipeline — render outcomes, durations, page counts emitted
  /// by `myoxus-worker::PdfExportJobHandler` and the sync GraphQL mutation.
  PdfExport,
  /// Model Context Protocol tool, transport, authz and write observability.
  Mcp,
}

impl MetricsCategory {
  pub const fn as_str(&self) -> &'static str {
    match self {
      MetricsCategory::Auth => "auth",
      MetricsCategory::Workspace => "workspace",
      MetricsCategory::Doc => "doc",
      MetricsCategory::Collab => "collab",
      MetricsCategory::Ai => "ai",
      MetricsCategory::PdfExport => "pdf_export",
      MetricsCategory::Mcp => "mcp",
    }
  }
}

/// Runtime knobs read by the recorder on every call.
///
/// Built once per request/worker-tick from the live
/// `crate::config::MetricsConfig` snapshot — the recorder itself is unaware
/// of `AppConfig`.
#[derive(Debug, Clone)]
pub struct MetricsPolicy {
  /// Master switch (INV-MET-07).
  pub enabled: bool,
  /// Categories allowlist.  Keys not present fail closed (INV-MET-01).
  pub categories: HashMap<String, bool>,
  /// `true` → hooks may attach a `workspace_id` label; `false` → label is
  /// stripped before reaching the recorder so cardinality stays bounded.
  pub label_workspace_id_enabled: bool,
  /// Hard upper bound on distinct `(metric_name, labels)` series per metric
  /// (INV-MET-06).  The recorder drops and counts samples beyond it.
  pub cardinality_limit_per_metric: u32,
}

impl MetricsPolicy {
  /// Category enablement (fail-closed for unknown keys).
  pub fn category_enabled(&self, category: &str) -> bool {
    self.enabled && self.categories.get(category).copied().unwrap_or(false)
  }
}

impl Default for MetricsPolicy {
  fn default() -> Self {
    Self {
      enabled: false,
      categories: HashMap::new(),
      label_workspace_id_enabled: false,
      cardinality_limit_per_metric: 10_000,
    }
  }
}
