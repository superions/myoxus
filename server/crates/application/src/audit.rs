// SPDX-License-Identifier: AGPL-3.0-or-later
//! Non-blocking admin audit recorder facade.
//!
//! [`AuditRecorder`] wraps the [`AuditLogStore`] persistence port and provides
//! a fire-and-forget interface: recording failures are logged at `warn` level
//! but **never** propagated to callers.  An audit write must never block or
//! abort a successful admin mutation.
//!
//! ## Usage
//!
//! ```rust,ignore
//! let actor = AuditActor::user(admin_id, "admin@example.com");
//! state.audit_recorder
//!     .record(AuditEvent::mutation(
//!         "organization.unit.update", AuditCategory::Organization,
//!         Some(AuditTarget::entity("organization_unit", unit_id, "Engineering")),
//!         actor,
//!         Some(serde_json::json!({"maxMembers": 3})),
//!         Some(serde_json::json!({"maxMembers": 5})),
//!     ))
//!     .await;
//! ```

use std::sync::Arc;

use chrono::{DateTime, Utc};
use tracing::{instrument, trace, warn};
use uuid::Uuid;

// Re-export domain types so callers only need to import `myoxus_application::audit`.
pub use myoxus_domain::audit::{
  AuditActor, AuditCategory, AuditEntry, AuditError, AuditEvent, AuditFilter, AuditLogStore, AuditTarget,
};

/// Fire-and-forget facade for the admin audit log.
///
/// Wraps an [`Arc<dyn AuditLogStore>`] and provides two recording helpers:
/// - [`AuditRecorder::record`] — low-level, takes a fully constructed [`AuditEvent`].
/// - Typed shortcut constructors via [`AuditEvent`] from the domain crate.
///
/// All errors from the underlying store are consumed: only a `warn!` log is
/// emitted, and the caller receives no error signal.
#[derive(Clone)]
pub struct AuditRecorder {
  store: Arc<dyn AuditLogStore>,
}

impl AuditRecorder {
  pub fn new(store: Arc<dyn AuditLogStore>) -> Self {
    Self { store }
  }

  /// Record an audit event.
  ///
  /// Errors from the store are logged at `warn` and silently swallowed —
  /// an audit failure must never abort a successful admin mutation.
  #[instrument(skip(self), level = "trace")]
  pub async fn record(&self, event: AuditEvent) {
    trace!(
      event_key = %event.event_key,
      category = %event.category,
      "AuditRecorder::record"
    );
    if let Err(err) = self.store.record(event).await {
      warn!(error = %err, "audit record failed — event dropped");
    }
  }

  /// List audit entries (delegates to store — may propagate errors).
  pub async fn list(&self, filter: AuditFilter, skip: i64, take: i64) -> Result<Vec<AuditEntry>, AuditError> {
    self.store.list(filter, skip, take).await
  }

  /// Count matching audit entries.
  pub async fn count(&self, filter: AuditFilter) -> Result<i64, AuditError> {
    self.store.count(filter).await
  }

  /// Read an existing entry without the best-effort error handling used for writes.
  pub async fn get_by_id(&self, id: Uuid) -> Result<Option<AuditEntry>, AuditError> {
    self.store.get_by_id(id).await
  }
}

/// Filter for the unified document-domain audit projection. Group keys are
/// stable application values; GraphQL enum mapping remains transport-owned.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DocumentAuditFilter {
  pub groups: Option<Vec<String>>,
  pub actor_user_id: Option<Uuid>,
  pub target_type: Option<String>,
  pub target_id: Option<String>,
  pub workspace_id: Option<Uuid>,
  pub doc_id: Option<Uuid>,
  pub event_key_prefix: Option<String>,
  pub from: Option<DateTime<Utc>>,
  pub to: Option<DateTime<Utc>>,
}

/// Transport-neutral row from the document governance, initial-sync and PDF
/// render audit sources.
#[derive(Debug, Clone, PartialEq)]
pub struct DocumentAuditEntry {
  pub id: String,
  pub source: String,
  pub group_key: String,
  pub event_key: String,
  pub source_category: String,
  pub target_type: Option<String>,
  pub target_id: Option<String>,
  pub target_label: Option<String>,
  pub old_value: Option<serde_json::Value>,
  pub new_value: Option<serde_json::Value>,
  pub actor_user_id: Option<Uuid>,
  pub actor_label: Option<String>,
  pub actor_kind: Option<String>,
  pub credential_type: Option<String>,
  pub credential_id: Option<String>,
  pub metadata: Option<serde_json::Value>,
  pub created_at: DateTime<Utc>,
  pub target_unit_id: Option<Uuid>,
  pub workspace_id: Option<String>,
  pub doc_id: Option<String>,
}

#[async_trait::async_trait]
pub trait DocumentAuditProjectionStore: Send + Sync {
  async fn list_document_audit(
    &self,
    filter: &DocumentAuditFilter,
    skip: i64,
    take: i64,
  ) -> Result<Vec<DocumentAuditEntry>, AuditError>;
  async fn count_document_audit(&self, filter: &DocumentAuditFilter) -> Result<i64, AuditError>;
}

#[derive(Debug, Default)]
pub struct UnavailableDocumentAuditProjectionStore;

#[async_trait::async_trait]
impl DocumentAuditProjectionStore for UnavailableDocumentAuditProjectionStore {
  async fn list_document_audit(
    &self,
    _filter: &DocumentAuditFilter,
    _skip: i64,
    _take: i64,
  ) -> Result<Vec<DocumentAuditEntry>, AuditError> {
    Err(AuditError::Storage(
      "document audit projection store is not configured".to_string(),
    ))
  }

  async fn count_document_audit(&self, _filter: &DocumentAuditFilter) -> Result<i64, AuditError> {
    Err(AuditError::Storage(
      "document audit projection store is not configured".to_string(),
    ))
  }
}

// ─── No-op stub for test environments ────────────────────────────────────────

/// A no-op `AuditLogStore` used in test builds where no DB is available.
#[derive(Debug)]
pub struct NoopAuditLogStore;

#[async_trait::async_trait]
impl AuditLogStore for NoopAuditLogStore {
  async fn record(&self, _event: AuditEvent) -> Result<(), AuditError> {
    Ok(())
  }
  async fn list(&self, _filter: AuditFilter, _skip: i64, _take: i64) -> Result<Vec<AuditEntry>, AuditError> {
    Ok(vec![])
  }
  async fn count(&self, _filter: AuditFilter) -> Result<i64, AuditError> {
    Ok(0)
  }
  async fn get_by_id(&self, _id: Uuid) -> Result<Option<AuditEntry>, AuditError> {
    Ok(None)
  }
}

impl AuditRecorder {
  /// Construct a no-op recorder (no persistence — for tests / builds without DB).
  pub fn noop() -> Self {
    Self::new(Arc::new(NoopAuditLogStore))
  }
}
