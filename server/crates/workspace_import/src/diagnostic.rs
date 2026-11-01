// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::{Deserialize, Serialize};

/// Stable diagnostic families shared by preview, API, CLI and UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkspaceImportDiagnosticCode {
  MixWorkspaceImportLabelColorNormalized,
  MixWorkspaceImportFormatUnsupported,
  MixWorkspaceImportUploadLimit,
  MixWorkspaceImportArchiveInvalid,
  MixWorkspaceImportArchiveLimit,
  MixWorkspaceImportSqliteInvalid,
  MixWorkspaceImportSqliteSchemaUnsupported,
  MixWorkspaceImportSnapshotInvalid,
  MixWorkspaceImportVaultRoot,
  MixWorkspaceImportVaultEntriesExcluded,
  MixWorkspaceImportVaultApplyUnavailable,
  MixWorkspaceImportVaultYamlInvalid,
  MixWorkspaceImportVaultContentNormalized,
  MixWorkspaceImportVaultSourcePreserved,
  MixWorkspaceImportAssetMissing,
  MixWorkspaceImportDocumentInvalid,
  MixWorkspaceImportDatabaseInvalid,
  MixWorkspaceImportDatabaseUnsupported,
  MixWorkspaceImportDatabaseValuesOmitted,
  MixWorkspaceImportApplyBlocked,
  MixWorkspaceImportPermissionDenied,
  MixWorkspaceImportCancelled,
  MixWorkspaceImportCleanupRequired,
  MixWorkspaceImportExpired,
  MixWorkspaceImportMembershipsOmitted,
  MixWorkspaceImportSessionsOmitted,
  MixWorkspaceImportSharingPublicationsOmitted,
  MixWorkspaceImportCommentsOmitted,
  MixWorkspaceImportActivityHistoryOmitted,
  MixWorkspaceImportExternalIntegrationsCredentialsOmitted,
}

impl WorkspaceImportDiagnosticCode {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::MixWorkspaceImportLabelColorNormalized => "MIX_WORKSPACE_IMPORT_LABEL_COLOR_NORMALIZED",
      Self::MixWorkspaceImportFormatUnsupported => "MIX_WORKSPACE_IMPORT_FORMAT_UNSUPPORTED",
      Self::MixWorkspaceImportUploadLimit => "MIX_WORKSPACE_IMPORT_UPLOAD_LIMIT",
      Self::MixWorkspaceImportArchiveInvalid => "MIX_WORKSPACE_IMPORT_ARCHIVE_INVALID",
      Self::MixWorkspaceImportArchiveLimit => "MIX_WORKSPACE_IMPORT_ARCHIVE_LIMIT",
      Self::MixWorkspaceImportSqliteInvalid => "MIX_WORKSPACE_IMPORT_SQLITE_INVALID",
      Self::MixWorkspaceImportSqliteSchemaUnsupported => "MIX_WORKSPACE_IMPORT_SQLITE_SCHEMA_UNSUPPORTED",
      Self::MixWorkspaceImportSnapshotInvalid => "MIX_WORKSPACE_IMPORT_SNAPSHOT_INVALID",
      Self::MixWorkspaceImportVaultRoot => "MIX_WORKSPACE_IMPORT_VAULT_ROOT",
      Self::MixWorkspaceImportVaultEntriesExcluded => "MIX_WORKSPACE_IMPORT_VAULT_ENTRIES_EXCLUDED",
      Self::MixWorkspaceImportVaultApplyUnavailable => "MIX_WORKSPACE_IMPORT_VAULT_APPLY_UNAVAILABLE",
      Self::MixWorkspaceImportVaultYamlInvalid => "MIX_WORKSPACE_IMPORT_VAULT_YAML_INVALID",
      Self::MixWorkspaceImportVaultContentNormalized => "MIX_WORKSPACE_IMPORT_VAULT_CONTENT_NORMALIZED",
      Self::MixWorkspaceImportVaultSourcePreserved => "MIX_WORKSPACE_IMPORT_VAULT_SOURCE_PRESERVED",
      Self::MixWorkspaceImportAssetMissing => "MIX_WORKSPACE_IMPORT_ASSET_MISSING",
      Self::MixWorkspaceImportDocumentInvalid => "MIX_WORKSPACE_IMPORT_DOCUMENT_INVALID",
      Self::MixWorkspaceImportDatabaseInvalid => "MIX_WORKSPACE_IMPORT_DATABASE_INVALID",
      Self::MixWorkspaceImportDatabaseUnsupported => "MIX_WORKSPACE_IMPORT_DATABASE_UNSUPPORTED",
      Self::MixWorkspaceImportDatabaseValuesOmitted => "MIX_WORKSPACE_IMPORT_DATABASE_VALUES_OMITTED",
      Self::MixWorkspaceImportApplyBlocked => "MIX_WORKSPACE_IMPORT_APPLY_BLOCKED",
      Self::MixWorkspaceImportPermissionDenied => "MIX_WORKSPACE_IMPORT_PERMISSION_DENIED",
      Self::MixWorkspaceImportCancelled => "MIX_WORKSPACE_IMPORT_CANCELLED",
      Self::MixWorkspaceImportCleanupRequired => "MIX_WORKSPACE_IMPORT_CLEANUP_REQUIRED",
      Self::MixWorkspaceImportExpired => "MIX_WORKSPACE_IMPORT_EXPIRED",
      Self::MixWorkspaceImportMembershipsOmitted => "MIX_WORKSPACE_IMPORT_MEMBERSHIPS_OMITTED",
      Self::MixWorkspaceImportSessionsOmitted => "MIX_WORKSPACE_IMPORT_SESSIONS_OMITTED",
      Self::MixWorkspaceImportSharingPublicationsOmitted => "MIX_WORKSPACE_IMPORT_SHARING_PUBLICATIONS_OMITTED",
      Self::MixWorkspaceImportCommentsOmitted => "MIX_WORKSPACE_IMPORT_COMMENTS_OMITTED",
      Self::MixWorkspaceImportActivityHistoryOmitted => "MIX_WORKSPACE_IMPORT_ACTIVITY_HISTORY_OMITTED",
      Self::MixWorkspaceImportExternalIntegrationsCredentialsOmitted => {
        "MIX_WORKSPACE_IMPORT_EXTERNAL_INTEGRATIONS_CREDENTIALS_OMITTED"
      }
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceImportDiagnosticSeverity {
  Blocking,
  Informational,
}

/// Stable, content-free location for a conversion finding. Source identities
/// are import-local and help operators locate a block without exposing titles,
/// cell values or binary payloads. `source_path` is populated only by source
/// formats whose reviewed preview contract explicitly authorizes bounded paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportDiagnosticContext {
  pub source_path: Option<String>,
  pub source_document_id: Option<String>,
  pub source_block_id: Option<String>,
  pub property_path: Option<String>,
}

/// Redacted decoder finding. Messages describe the violated contract without
/// including archive-internal paths, document text, cell values or raw SQL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportDiagnostic {
  pub code: WorkspaceImportDiagnosticCode,
  pub severity: WorkspaceImportDiagnosticSeverity,
  pub message: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub context: Option<WorkspaceImportDiagnosticContext>,
}

impl WorkspaceImportDiagnostic {
  pub fn blocking(code: WorkspaceImportDiagnosticCode, message: impl Into<String>) -> Self {
    Self {
      code,
      severity: WorkspaceImportDiagnosticSeverity::Blocking,
      message: message.into(),
      context: None,
    }
  }

  pub fn informational(code: WorkspaceImportDiagnosticCode, message: impl Into<String>) -> Self {
    Self {
      code,
      severity: WorkspaceImportDiagnosticSeverity::Informational,
      message: message.into(),
      context: None,
    }
  }

  pub fn with_source_context(mut self, source_document_id: &str, source_block_id: &str) -> Self {
    let context = self.context.get_or_insert(WorkspaceImportDiagnosticContext {
      source_path: None,
      source_document_id: None,
      source_block_id: None,
      property_path: None,
    });
    context.source_document_id = Some(source_document_id.to_string());
    context.source_block_id = Some(source_block_id.to_string());
    self
  }

  pub fn with_property_path(mut self, property_path: impl Into<String>) -> Self {
    let context = self.context.get_or_insert(WorkspaceImportDiagnosticContext {
      source_path: None,
      source_document_id: None,
      source_block_id: None,
      property_path: None,
    });
    context.property_path = Some(property_path.into());
    self
  }

  pub fn with_source_path(mut self, source_path: impl Into<String>) -> Self {
    let context = self.context.get_or_insert(WorkspaceImportDiagnosticContext {
      source_path: None,
      source_document_id: None,
      source_block_id: None,
      property_path: None,
    });
    context.source_path = Some(source_path.into());
    self
  }
}
