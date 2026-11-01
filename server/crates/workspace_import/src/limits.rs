// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::ArchiveLimits;

/// Server-owned limits applied before allocation and while decoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceImportLimits {
  pub max_upload_bytes: u64,
  pub max_expanded_bytes: u64,
  pub max_archive_entries: usize,
  pub max_entry_bytes: u64,
  pub max_compression_ratio: u64,
  pub max_sqlite_bytes: u64,
  /// Existing global document transport boundary, not a separate app-config
  /// key. API wiring projects the stricter WebSocket/document limit here.
  pub max_document_bytes: u64,
  pub max_documents: usize,
  pub max_blocks: usize,
  pub max_databases: usize,
  /// Existing canonical Database schema limits projected by API config.
  pub max_fields_per_database: usize,
  pub max_views_per_database: usize,
  pub max_rows_per_database: usize,
  pub max_cells_per_database: usize,
  pub max_assets: usize,
  pub max_asset_bytes: u64,
}

impl Default for WorkspaceImportLimits {
  fn default() -> Self {
    Self {
      max_upload_bytes: 2_147_483_648,
      max_expanded_bytes: 8_589_934_592,
      max_archive_entries: 100_000,
      max_entry_bytes: 2_147_483_648,
      max_compression_ratio: 200,
      max_sqlite_bytes: 2_147_483_648,
      max_document_bytes: 104_857_600,
      max_documents: 100_000,
      max_blocks: 5_000_000,
      max_databases: 10_000,
      max_fields_per_database: 100,
      max_views_per_database: 25,
      max_rows_per_database: 1_000_000,
      max_cells_per_database: 20_000_000,
      max_assets: 250_000,
      max_asset_bytes: 6_442_450_944,
    }
  }
}

impl WorkspaceImportLimits {
  pub fn archive(self) -> ArchiveLimits {
    ArchiveLimits {
      max_entries: self.max_archive_entries,
      max_entry_bytes: self.max_entry_bytes,
      max_expanded_bytes: self.max_expanded_bytes,
      max_compression_ratio: self.max_compression_ratio,
      max_path_bytes: 1_024,
    }
  }
}
