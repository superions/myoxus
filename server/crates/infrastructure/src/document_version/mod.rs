// SPDX-License-Identifier: AGPL-3.0-or-later
//! SQLx-backed repository implementations for the document-versioning subsystem.
//!
//! Named versions, effective settings and durable automatic-capture intent share
//! this owner:
//!
//! - [`PgDocumentVersionRepository`] — CRUD + GC for named doc snapshots
//!   (table: `document_version`).
//! - [`PgDocumentVersioningSettingsRepository`] — Workspace/document settings
//!   resolved against server-owned defaults.
//! - [`PgDocumentEditCaptureRepository`] — Bounded reconciliation and capture,
//!   sharing transaction-local bookkeeping with writers and ownership changes.

pub mod edit_capture_repo;
pub(crate) mod edit_capture_state;
pub mod settings_repo;
pub mod versions_repo;

pub use edit_capture_repo::PgDocumentEditCaptureRepository;
pub use settings_repo::{ConfigValuesReader, PgDocumentVersioningSettingsRepository};
pub use versions_repo::PgDocumentVersionRepository;
