// SPDX-License-Identifier: AGPL-3.0-or-later
//! Pure, read-only decoding boundary for legacy workspace imports.
//!
//! This crate accepts untrusted SQLite and snapshot-ZIP inputs and projects
//! them into neutral source records. It deliberately has no repository,
//! GraphQL, worker, blob-storage, or product-write dependencies. Application
//! services are responsible for authorization, durable staging, target-id
//! planning, migration, and materialization.

mod archive;
mod config;
mod database;
mod decoder;
mod diagnostic;
mod limits;
mod model;
mod obsidian;
mod snapshot;
mod sqlite;

pub use archive::{
  ArchiveEntry, ArchiveError, ArchiveIndex, ArchiveLimits, PortableArchiveKind, SnapshotArchive, SnapshotDocument,
  asset_aliases, detect_portable_archive_kind, inspect_zip_bytes, is_ignored_archive_entry, is_snapshot_json_path,
  validate_snapshot_archive, validate_snapshot_archive_reader,
};
pub use config::WorkspaceImportConfig;
pub use database::extract_database_blocks;
pub use decoder::{WorkspaceDecoder, detect_workspace_format};
pub use diagnostic::{
  WorkspaceImportDiagnostic, WorkspaceImportDiagnosticCode, WorkspaceImportDiagnosticContext,
  WorkspaceImportDiagnosticSeverity,
};
pub use limits::WorkspaceImportLimits;
pub use model::{
  DecodedAsset, DecodedDocument, DecodedDocumentContent, DecodedOmittedObjectCounts, DecodedWorkspace,
  DecodedWorkspaceTag, WorkspaceImportFormat,
};
