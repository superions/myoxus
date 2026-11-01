// SPDX-License-Identifier: AGPL-3.0-or-later
//! Canonical resource and lifecycle configuration for workspace imports.
//!
//! The decoder crate owns this transport-neutral contract so API, worker and
//! CLI entry points cannot drift into different import limits.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::WorkspaceImportLimits;

/// Resource and lifecycle limits for untrusted full-workspace imports.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceImportConfig {
  pub max_upload_bytes: u64,
  pub max_expanded_bytes: u64,
  pub max_archive_entries: usize,
  pub max_entry_bytes: u64,
  pub max_compression_ratio: u64,
  pub max_sqlite_bytes: u64,
  pub max_documents: usize,
  pub max_blocks: usize,
  pub max_databases: usize,
  pub max_rows_per_database: usize,
  pub max_cells_per_database: usize,
  pub max_assets: usize,
  pub max_asset_bytes: u64,
  pub staging_retention_hours: u64,
  pub job_timeout_seconds: u64,
  /// Worker concurrency is read at process startup and is not hot-reloaded.
  pub worker_concurrency: usize,
}

impl Default for WorkspaceImportConfig {
  fn default() -> Self {
    Self {
      max_upload_bytes: 2_147_483_648,
      max_expanded_bytes: 8_589_934_592,
      max_archive_entries: 100_000,
      max_entry_bytes: 2_147_483_648,
      max_compression_ratio: 200,
      max_sqlite_bytes: 2_147_483_648,
      max_documents: 100_000,
      max_blocks: 5_000_000,
      max_databases: 10_000,
      max_rows_per_database: 1_000_000,
      max_cells_per_database: 20_000_000,
      max_assets: 250_000,
      max_asset_bytes: 6_442_450_944,
      staging_retention_hours: 24,
      job_timeout_seconds: 7_200,
      worker_concurrency: 1,
    }
  }
}

impl WorkspaceImportConfig {
  /// Apply the universal Admin config overlay. Invalid or zero values retain
  /// the server-owned base value; startup-only concurrency is never overlaid.
  pub fn with_runtime_overrides(self, overrides: &HashMap<String, Value>) -> Self {
    let max_upload_bytes = positive_u64(overrides, "workspace.import.max_upload_bytes", self.max_upload_bytes);
    let max_expanded_bytes = positive_u64(
      overrides,
      "workspace.import.max_expanded_bytes",
      self.max_expanded_bytes,
    );
    Self {
      max_upload_bytes,
      max_expanded_bytes,
      max_archive_entries: positive_usize(
        overrides,
        "workspace.import.max_archive_entries",
        self.max_archive_entries,
      ),
      max_entry_bytes: positive_u64(overrides, "workspace.import.max_entry_bytes", self.max_entry_bytes)
        .min(max_upload_bytes)
        .min(max_expanded_bytes),
      max_compression_ratio: positive_u64(
        overrides,
        "workspace.import.max_compression_ratio",
        self.max_compression_ratio,
      ),
      max_sqlite_bytes: positive_u64(overrides, "workspace.import.max_sqlite_bytes", self.max_sqlite_bytes)
        .min(max_upload_bytes),
      max_documents: positive_usize(overrides, "workspace.import.max_documents", self.max_documents),
      max_blocks: positive_usize(overrides, "workspace.import.max_blocks", self.max_blocks),
      max_databases: positive_usize(overrides, "workspace.import.max_databases", self.max_databases),
      max_rows_per_database: positive_usize(
        overrides,
        "workspace.import.max_rows_per_database",
        self.max_rows_per_database,
      ),
      max_cells_per_database: positive_usize(
        overrides,
        "workspace.import.max_cells_per_database",
        self.max_cells_per_database,
      ),
      max_assets: positive_usize(overrides, "workspace.import.max_assets", self.max_assets),
      max_asset_bytes: positive_u64(overrides, "workspace.import.max_asset_bytes", self.max_asset_bytes)
        .min(max_expanded_bytes),
      staging_retention_hours: positive_u64(
        overrides,
        "workspace.import.staging_retention_hours",
        self.staging_retention_hours,
      ),
      job_timeout_seconds: positive_u64(
        overrides,
        "workspace.import.job_timeout_seconds",
        self.job_timeout_seconds,
      ),
      worker_concurrency: self.worker_concurrency,
    }
  }

  /// Project decoder limits while honoring stricter global storage, document
  /// and Database boundaries supplied by the consuming server process.
  pub fn decoder_limits(
    self,
    storage_upload_bytes: u64,
    document_bytes: u64,
    max_fields_per_database: usize,
    max_views_per_database: usize,
  ) -> WorkspaceImportLimits {
    let max_upload_bytes = self.max_upload_bytes.min(storage_upload_bytes);
    WorkspaceImportLimits {
      max_upload_bytes,
      max_expanded_bytes: self.max_expanded_bytes,
      max_archive_entries: self.max_archive_entries,
      max_entry_bytes: self.max_entry_bytes.min(max_upload_bytes),
      max_compression_ratio: self.max_compression_ratio,
      max_sqlite_bytes: self.max_sqlite_bytes.min(max_upload_bytes),
      max_document_bytes: document_bytes.min(max_upload_bytes),
      max_documents: self.max_documents,
      max_blocks: self.max_blocks,
      max_databases: self.max_databases,
      max_fields_per_database,
      max_views_per_database,
      max_rows_per_database: self.max_rows_per_database,
      max_cells_per_database: self.max_cells_per_database,
      max_assets: self.max_assets,
      max_asset_bytes: self.max_asset_bytes.min(self.max_expanded_bytes),
    }
  }
}

fn positive_u64(overrides: &HashMap<String, Value>, key: &str, fallback: u64) -> u64 {
  overrides
    .get(key)
    .and_then(Value::as_u64)
    .filter(|value| *value > 0)
    .unwrap_or(fallback)
}

fn positive_usize(overrides: &HashMap<String, Value>, key: &str, fallback: usize) -> usize {
  overrides
    .get(key)
    .and_then(Value::as_u64)
    .and_then(|value| usize::try_from(value).ok())
    .filter(|value| *value > 0)
    .unwrap_or(fallback)
}
