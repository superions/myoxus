// SPDX-License-Identifier: AGPL-3.0-or-later
//! Application capabilities required by the authenticated MCP transport.

use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::auth::AuthResult;
use crate::doc::history::{HistoryCaptureError, HistoryRestoreCommit};
use crate::doc::{DocContentMutationCommit, PageLifecycleCommit};
use crate::document_metadata::{DocumentMetadataProjectionMode, DocumentMetadataService};
use crate::document_metadata_policy::{
  DocumentMetadataEffectivePolicy, DocumentMetadataPolicyService, DocumentStatusTransitionRequest,
  DocumentStatusTransitionService,
};
use crate::document_version::{
  DocumentVersionCreateRequest, DocumentVersionCreateService, DocumentVersionHistoryPort, DocumentVersionRestoreError,
  DocumentVersionRestoreService,
};
use crate::mime_policy::MimePolicyConfig;
use myoxus_domain::audit::AuditActor;
use myoxus_domain::entities::{
  DocumentMetadataPatch, DocumentMetadataProjection, DocumentMetadataValidation, DocumentVersion,
};
use myoxus_domain::repositories::{DocumentMetadataPolicyRepository, DocumentVersionRepository};

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct McpCapabilityError(String);

impl McpCapabilityError {
  fn from_service(error: impl std::fmt::Display) -> Self {
    Self(error.to_string())
  }

  fn unavailable() -> Self {
    Self("MCP document operations are unavailable in this reduced runtime".to_string())
  }
}

pub type McpCapabilityResult<T> = Result<T, McpCapabilityError>;

#[derive(Debug, Clone)]
pub enum McpIdempotencyAdmission {
  Started {
    row_id: Uuid,
  },
  Existing {
    payload_sha256: String,
    /// Zero is historical normalization; one retains derived native table headers.
    document_payload_format: i16,
    response: Option<Value>,
  },
}

#[async_trait]
pub trait McpIdempotencyRepository: Send + Sync {
  /// Reduced in-memory fixtures have no shared document transaction. Production
  /// wiring requires the PostgreSQL adapter that owns atomic replay receipts.
  fn document_transaction_recovery(&self) -> bool {
    false
  }
  async fn begin(
    &self,
    row_id: Uuid,
    api_key_id: Uuid,
    user_id: Uuid,
    tool_name: &str,
    idempotency_key: &str,
    payload_sha256: &str,
    document_payload_format: i16,
  ) -> AuthResult<McpIdempotencyAdmission>;
  /// Keep an admitted long render fenced while its request-owned task runs.
  /// Reduced repositories cannot provide production PDF durability.
  async fn renew(&self, _row_id: Uuid) -> AuthResult<bool> {
    Ok(false)
  }
  async fn complete(&self, row_id: Uuid, response: &Value) -> AuthResult<bool>;
  async fn abort(&self, row_id: Uuid) -> AuthResult<()>;
}

pub fn atomic_document_write_tool(tool_name: &str) -> bool {
  // Import's creation edge is atomic; its later placement/compensation steps
  // retain that receipt as an explicit failure until normal completion.
  matches!(
    tool_name,
    "create_page"
      | "doc_patch"
      | "update_doc"
      | "delete_page"
      | "restore_page"
      | "document_import"
      | "doc_version_restore"
      | "pdf_export_create"
  )
}

/// The canonical document transaction supplies its outcome before committing.
/// Native state is borrowed only while producing the bounded replay response;
/// it is never retained as a second document snapshot in the replay ledger.
pub enum McpDocumentWriteCommit<'a> {
  Content {
    commit: &'a DocContentMutationCommit,
    operation: &'a str,
  },
  Lifecycle(&'a PageLifecycleCommit),
  HistoryRestore(&'a HistoryRestoreCommit),
  PdfExport(&'a crate::pdf_export::jobs::PdfExportJob),
}

pub type McpDocumentResponseBuilder =
  Arc<dyn for<'a> Fn(McpDocumentWriteCommit<'a>) -> AuthResult<Value> + Send + Sync>;

#[derive(Clone)]
pub struct McpDocumentWriteReplay {
  /// Admission IDs rotate on recovery and therefore fence abandoned writers.
  pub row_id: Uuid,
  pub api_key_id: Uuid,
  pub user_id: Uuid,
  pub response: McpDocumentResponseBuilder,
}

tokio::task_local! {
  static DOCUMENT_WRITE_REPLAY: McpDocumentWriteReplay;
}

/// Scope replay admission to one canonical write, without changing shipped
/// document APIs. The context follows this future only, never spawned tasks.
pub async fn with_mcp_document_write<T>(
  replay: McpDocumentWriteReplay,
  operation: impl std::future::Future<Output = T>,
) -> T {
  DOCUMENT_WRITE_REPLAY.scope(replay, operation).await
}

pub fn current_mcp_document_write() -> Option<McpDocumentWriteReplay> {
  DOCUMENT_WRITE_REPLAY.try_with(Clone::clone).ok()
}

/// Explicit deterministic repository for reduced MCP tests.
type McpIdempotencyKey = (Uuid, String, String);
type McpIdempotencyRow = (Uuid, String, i16, Option<Value>);

#[derive(Default)]
pub struct InMemoryMcpIdempotencyRepository {
  rows: RwLock<HashMap<McpIdempotencyKey, McpIdempotencyRow>>,
}

#[async_trait]
impl McpIdempotencyRepository for InMemoryMcpIdempotencyRepository {
  async fn begin(
    &self,
    row_id: Uuid,
    api_key_id: Uuid,
    _user_id: Uuid,
    tool_name: &str,
    idempotency_key: &str,
    payload_sha256: &str,
    document_payload_format: i16,
  ) -> AuthResult<McpIdempotencyAdmission> {
    let key = (api_key_id, tool_name.to_string(), idempotency_key.to_string());
    let mut rows = self.rows.write().await;
    if let Some((_, existing_hash, existing_format, response)) = rows.get(&key) {
      return Ok(McpIdempotencyAdmission::Existing {
        payload_sha256: existing_hash.clone(),
        document_payload_format: *existing_format,
        response: response.clone(),
      });
    }
    rows.insert(key, (row_id, payload_sha256.to_string(), document_payload_format, None));
    Ok(McpIdempotencyAdmission::Started { row_id })
  }

  async fn complete(&self, row_id: Uuid, response: &Value) -> AuthResult<bool> {
    let mut rows = self.rows.write().await;
    if let Some((_, _, _, stored_response)) = rows.values_mut().find(|(id, _, _, _)| *id == row_id)
      && stored_response.is_none()
    {
      *stored_response = Some(response.clone());
      return Ok(true);
    }
    Ok(false)
  }

  async fn abort(&self, row_id: Uuid) -> AuthResult<()> {
    self.rows.write().await.retain(|_, (id, _, _, _)| *id != row_id);
    Ok(())
  }
}

/// Document operations consumed by MCP after transport authorization.
#[async_trait]
pub trait McpDocumentOperations: Send + Sync {
  async fn projection(&self, doc_id: Uuid, workspace_id: Uuid) -> McpCapabilityResult<DocumentMetadataProjection>;
  async fn policy(&self, doc_id: Uuid, workspace_id: Uuid) -> McpCapabilityResult<DocumentMetadataEffectivePolicy>;
  async fn resolve_status_in_schema(&self, from_status_id: Uuid, target: &str) -> McpCapabilityResult<Option<Uuid>>;
  async fn list_versions(&self, doc_id: Uuid) -> McpCapabilityResult<Vec<DocumentVersion>>;
  /// Exact named history only; callers authorize the current document before loading.
  async fn version_snapshot(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    version_id: Uuid,
  ) -> McpCapabilityResult<Option<(DocumentVersion, Vec<u8>)>>;
  async fn create_version(&self, request: DocumentVersionCreateRequest) -> McpCapabilityResult<DocumentVersion>;
  async fn restore_version(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    version_id: Uuid,
    actor: AuditActor,
    expected_sequence: i64,
  ) -> Result<HistoryRestoreCommit, DocumentVersionRestoreError>;
  async fn transition(
    &self,
    request: DocumentStatusTransitionRequest,
  ) -> McpCapabilityResult<DocumentMetadataValidation>;
  async fn set_metadata(&self, doc_id: Uuid, actor_id: Uuid, patch: DocumentMetadataPatch) -> McpCapabilityResult<()>;
}

/// Composition of the canonical document services for MCP consumers.
pub struct ApplicationMcpDocumentOperations {
  metadata: DocumentMetadataService,
  policy: DocumentMetadataPolicyService,
  transition: DocumentStatusTransitionService,
  versions: Arc<dyn DocumentVersionRepository>,
  version_create: DocumentVersionCreateService,
  version_restore: DocumentVersionRestoreService,
}

impl ApplicationMcpDocumentOperations {
  pub fn new(
    metadata: DocumentMetadataService,
    policy_repo: Arc<dyn DocumentMetadataPolicyRepository>,
    versions: Arc<dyn DocumentVersionRepository>,
    history: Arc<dyn DocumentVersionHistoryPort>,
  ) -> Self {
    let policy = DocumentMetadataPolicyService::new(Arc::clone(&policy_repo));
    let transition = DocumentStatusTransitionService::with_versioning(
      policy_repo,
      Arc::clone(&history),
      Arc::clone(&versions),
      metadata.clone(),
    );
    let version_restore = DocumentVersionRestoreService::new(Arc::clone(&history), Arc::clone(&versions));
    let version_create = DocumentVersionCreateService::new(history, Arc::clone(&versions));
    Self {
      metadata,
      policy,
      transition,
      versions,
      version_create,
      version_restore,
    }
  }
}

#[async_trait]
impl McpDocumentOperations for ApplicationMcpDocumentOperations {
  #[tracing::instrument(skip_all)]
  async fn restore_version(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    version_id: Uuid,
    actor: AuditActor,
    expected_sequence: i64,
  ) -> Result<HistoryRestoreCommit, DocumentVersionRestoreError> {
    let source = self
      .versions
      .get(version_id)
      .await
      .map_err(HistoryCaptureError::Repository)?
      .filter(|source| source.workspace_id == workspace_id && source.doc_id == doc_id)
      .ok_or_else(|| HistoryCaptureError::Document(crate::auth::AuthError::NotFound("named version".into())))?;
    self
      .version_restore
      .restore_committed(&source, actor, None, Some(expected_sequence))
      .await
  }
  async fn projection(&self, doc_id: Uuid, workspace_id: Uuid) -> McpCapabilityResult<DocumentMetadataProjection> {
    self
      .metadata
      .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
      .await
      .map_err(McpCapabilityError::from_service)
  }

  async fn policy(&self, doc_id: Uuid, workspace_id: Uuid) -> McpCapabilityResult<DocumentMetadataEffectivePolicy> {
    self
      .policy
      .load_policy(doc_id, workspace_id)
      .await
      .map_err(McpCapabilityError::from_service)
  }

  async fn resolve_status_in_schema(&self, from_status_id: Uuid, target: &str) -> McpCapabilityResult<Option<Uuid>> {
    self
      .policy
      .resolve_status_in_schema(from_status_id, target)
      .await
      .map_err(McpCapabilityError::from_service)
  }

  async fn list_versions(&self, doc_id: Uuid) -> McpCapabilityResult<Vec<DocumentVersion>> {
    self
      .versions
      .list_for_doc(doc_id)
      .await
      .map_err(McpCapabilityError::from_service)
  }

  async fn create_version(&self, request: DocumentVersionCreateRequest) -> McpCapabilityResult<DocumentVersion> {
    self
      .version_create
      .create(request)
      .await
      .map_err(McpCapabilityError::from_service)
  }

  #[tracing::instrument(skip(self), err)]
  async fn version_snapshot(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    version_id: Uuid,
  ) -> McpCapabilityResult<Option<(DocumentVersion, Vec<u8>)>> {
    let belongs = |version: &DocumentVersion| {
      version.id == version_id && version.workspace_id == workspace_id && version.doc_id == doc_id
    };
    // Check ownership before loading bytes, then check the atomic join again.
    // A missing named snapshot must never fall back to nearby or current state.
    if self
      .versions
      .get(version_id)
      .await
      .map_err(McpCapabilityError::from_service)?
      .as_ref()
      .is_none_or(|v| !belongs(v))
    {
      return Ok(None);
    }
    Ok(
      self
        .versions
        .snapshot_for_version(version_id)
        .await
        .map_err(McpCapabilityError::from_service)?
        .filter(|(version, _)| belongs(version)),
    )
  }

  async fn transition(
    &self,
    request: DocumentStatusTransitionRequest,
  ) -> McpCapabilityResult<DocumentMetadataValidation> {
    self
      .transition
      .transition_with_request(request)
      .await
      .map_err(McpCapabilityError::from_service)
  }

  async fn set_metadata(&self, doc_id: Uuid, actor_id: Uuid, patch: DocumentMetadataPatch) -> McpCapabilityResult<()> {
    self
      .metadata
      .set_metadata(doc_id, actor_id, patch)
      .await
      .map_err(McpCapabilityError::from_service)
  }
}

/// Explicit fail-closed document capability for transport-only unit tests.
pub struct UnavailableMcpDocumentOperations;

impl UnavailableMcpDocumentOperations {
  fn unavailable<T>() -> McpCapabilityResult<T> {
    Err(McpCapabilityError::unavailable())
  }
}

#[async_trait]
impl McpDocumentOperations for UnavailableMcpDocumentOperations {
  async fn restore_version(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _version_id: Uuid,
    _actor: AuditActor,
    _expected_sequence: i64,
  ) -> Result<HistoryRestoreCommit, DocumentVersionRestoreError> {
    Err(
      HistoryCaptureError::Document(crate::auth::AuthError::Storage(
        McpCapabilityError::unavailable().to_string(),
      ))
      .into(),
    )
  }
  async fn version_snapshot(
    &self,
    _workspace_id: Uuid,
    _doc_id: Uuid,
    _version_id: Uuid,
  ) -> McpCapabilityResult<Option<(DocumentVersion, Vec<u8>)>> {
    Self::unavailable()
  }
  async fn projection(&self, _doc_id: Uuid, _workspace_id: Uuid) -> McpCapabilityResult<DocumentMetadataProjection> {
    Self::unavailable()
  }

  async fn policy(&self, _doc_id: Uuid, _workspace_id: Uuid) -> McpCapabilityResult<DocumentMetadataEffectivePolicy> {
    Self::unavailable()
  }

  async fn resolve_status_in_schema(&self, _from_status_id: Uuid, _target: &str) -> McpCapabilityResult<Option<Uuid>> {
    Self::unavailable()
  }

  async fn list_versions(&self, _doc_id: Uuid) -> McpCapabilityResult<Vec<DocumentVersion>> {
    Self::unavailable()
  }

  async fn create_version(&self, _request: DocumentVersionCreateRequest) -> McpCapabilityResult<DocumentVersion> {
    Self::unavailable()
  }

  async fn transition(
    &self,
    _request: DocumentStatusTransitionRequest,
  ) -> McpCapabilityResult<DocumentMetadataValidation> {
    Self::unavailable()
  }

  async fn set_metadata(
    &self,
    _doc_id: Uuid,
    _actor_id: Uuid,
    _patch: DocumentMetadataPatch,
  ) -> McpCapabilityResult<()> {
    Self::unavailable()
  }
}

#[async_trait]
pub trait McpMimePolicyReader: Send + Sync {
  async fn resolve(&self, fallback: &McpMimePolicyFallback) -> AuthResult<MimePolicyConfig>;
}

/// Startup values used when no live admin override exists.
#[derive(Debug, Clone)]
pub struct McpMimePolicyFallback {
  pub allowlist: Vec<String>,
  pub blocklist: Vec<String>,
  pub validation_mode: String,
}

/// Explicit MIME policy source for reduced MCP tests.
pub struct StaticMcpMimePolicyReader {
  config: MimePolicyConfig,
}

impl StaticMcpMimePolicyReader {
  pub fn shared(config: MimePolicyConfig) -> Arc<Self> {
    Arc::new(Self { config })
  }
}

#[async_trait]
impl McpMimePolicyReader for StaticMcpMimePolicyReader {
  async fn resolve(&self, _fallback: &McpMimePolicyFallback) -> AuthResult<MimePolicyConfig> {
    Ok(self.config.clone())
  }
}
