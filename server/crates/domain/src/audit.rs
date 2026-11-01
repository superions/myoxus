// SPDX-License-Identifier: AGPL-3.0-or-later
//! Domain types for the operator-visible audit log.
//!
//! The backing table keeps its historical `admin_audit_log` name because it is
//! exposed through admin/operator surfaces. Event origin is broader: admin
//! mutations, auth/security evidence, document lifecycle events, and delegated
//! API-key actions all use this contract when they need durable evidence.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ─── Event data types ─────────────────────────────────────────────────────────

/// High-level category grouping for audit events.
///
/// Stored as a short ASCII string in the DB (`category` column).
/// The [`Display`] impl produces the DB-compatible lowercase string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditCategory {
  /// Server runtime config mutations (`app_configs` table via admin panel).
  Config,
  /// User lifecycle, role, and feature mutations.
  User,
  /// Workspace settings and feature mutations.
  Workspace,
  /// Global feature-flag toggles.
  Feature,
  /// Template registry mutations (create, update, delete, publish).
  Template,
  /// Logging rule / filter mutations.
  Logging,
  /// Cache tuning and invalidation mutations.
  Cache,
  /// Auth-flow security events (P-Captcha-C: captcha rejections, future:
  /// brute-force lockouts, password resets, admin elevation). Distinct from
  /// [`AuditCategory::User`], which covers admin-driven user management.
  Auth,
  /// PDF-Export configuration mutations: ICC profile uploads/deletes, font
  /// approvals, template publishing, brand-asset changes.
  PdfExportConfig,
  /// Document-version lifecycle events such as retention-GC pruning.
  DocumentVersion,
  /// Document lifecycle events that are not version-specific, such as
  /// permanent deletion.
  Document,
  /// Organisation, Organisationseinheiten, Manager-Zuweisungen, Policies,
  /// Workspace-Owner-Wechsel, Projekt-Anlage-Antraege, Import/Export.
  /// Vgl. `docs/dev/server/organization-management.md`.
  Organization,
  /// Model Context Protocol evidence: API-key lifecycle, write mutations and
  /// relevant policy/security denials. High-volume MCP diagnosis remains
  /// normal `tracing` output under the `mcp` log group.
  Mcp,
  /// Workspace Automation runs, disabled-state changes, failed actions and
  /// dead-letter recovery evidence.
  WorkspaceAutomation,
  /// Server-backed Database mutations: row/cell changes, document link/unlink,
  /// assignment and status changes, bulk operations, import/export completion,
  /// and structural mutations (database/field/view/template create, update,
  /// delete).
  Database,
}

impl AuditCategory {
  /// Return the DB-stored lowercase string for this category.
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Config => "config",
      Self::User => "user",
      Self::Workspace => "workspace",
      Self::Feature => "feature",
      Self::Template => "template",
      Self::Logging => "logging",
      Self::Cache => "cache",
      Self::Auth => "auth",
      Self::PdfExportConfig => "pdf_export_config",
      Self::DocumentVersion => "document_version",
      Self::Document => "document",
      Self::Organization => "organization",
      Self::Mcp => "mcp",
      Self::WorkspaceAutomation => "workspace_automation",
      Self::Database => "database",
    }
  }

  fn parse_db(s: &str) -> Option<Self> {
    match s {
      "config" => Some(Self::Config),
      "user" => Some(Self::User),
      "workspace" => Some(Self::Workspace),
      "feature" => Some(Self::Feature),
      "template" => Some(Self::Template),
      "logging" => Some(Self::Logging),
      "cache" => Some(Self::Cache),
      "auth" => Some(Self::Auth),
      "pdf_export_config" => Some(Self::PdfExportConfig),
      "document_version" => Some(Self::DocumentVersion),
      "document" => Some(Self::Document),
      "organization" => Some(Self::Organization),
      "mcp" => Some(Self::Mcp),
      "workspace_automation" => Some(Self::WorkspaceAutomation),
      "database" => Some(Self::Database),
      _ => None,
    }
  }
}

impl std::str::FromStr for AuditCategory {
  type Err = ();

  fn from_str(s: &str) -> Result<Self, Self::Err> {
    Self::parse_db(s).ok_or(())
  }
}

impl std::fmt::Display for AuditCategory {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(self.as_str())
  }
}

/// The entity affected by an audit event.
///
/// `target_type` is a short human-readable type name (e.g. `"organization_unit"`, `"user"`).
/// `target_id` is the entity's UUID or config key as a string.
/// `target_label` is a human-readable snapshot (name, email) for display without
/// an additional DB lookup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditTarget {
  /// Entity type: `"organization_unit"`, `"user"`, `"workspace"`, `"config"`, etc.
  pub target_type: String,
  /// UUID or config key string.
  pub target_id: String,
  /// Human-readable snapshot for display (unit name, user email, config path, …).
  pub target_label: Option<String>,
}

impl AuditTarget {
  /// Construct a target from an entity UUID.
  pub fn entity(target_type: &str, id: Uuid, label: impl Into<Option<String>>) -> Self {
    Self {
      target_type: target_type.to_string(),
      target_id: id.to_string(),
      target_label: label.into(),
    }
  }

  /// Construct a target from a config key string.
  pub fn config_key(key: &str) -> Self {
    Self {
      target_type: "config".to_string(),
      target_id: key.to_string(),
      target_label: Some(key.to_string()),
    }
  }
}

/// The origin class that caused an audit event.
///
/// `actor_user_id` remains the delegating or interactive user filter. These
/// values explain how that user acted: directly, via system automation, or via
/// a delegated credential such as an MCP API key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditActorKind {
  User,
  System,
  ApiKey,
}

impl AuditActorKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::User => "user",
      Self::System => "system",
      Self::ApiKey => "api_key",
    }
  }

  fn parse_db(s: &str) -> Option<Self> {
    match s {
      "user" => Some(Self::User),
      "system" => Some(Self::System),
      "api_key" => Some(Self::ApiKey),
      _ => None,
    }
  }
}

impl std::str::FromStr for AuditActorKind {
  type Err = ();

  fn from_str(s: &str) -> Result<Self, Self::Err> {
    Self::parse_db(s).ok_or(())
  }
}

impl std::fmt::Display for AuditActorKind {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(self.as_str())
  }
}

/// The actor who performed the action.
///
/// Snapshot-captured at event time — survives user deletion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditActor {
  /// Origin class for the event.
  pub kind: AuditActorKind,
  /// User ID for direct user actions, or the credential owner for delegated
  /// actions. `None` also represents an actor whose account was deleted;
  /// historical attribution remains in kind, label, credential and metadata.
  pub user_id: Option<Uuid>,
  /// Human-readable snapshot for display. MCP credential actions deliberately
  /// use redacted labels instead of introducing an email-storage dependency.
  pub label: Option<String>,
  /// Type of delegated credential, e.g. `"mcp_api_key"`.
  pub credential_type: Option<String>,
  /// Stable credential identifier. This is never a secret or key hash.
  pub credential_id: Option<String>,
}

impl AuditActor {
  pub fn user(user_id: Uuid, label: impl Into<Option<String>>) -> Self {
    Self {
      kind: AuditActorKind::User,
      user_id: Some(user_id),
      label: label.into(),
      credential_type: None,
      credential_id: None,
    }
  }
  pub fn system() -> Self {
    Self {
      kind: AuditActorKind::System,
      user_id: None,
      label: Some("system".to_string()),
      credential_type: None,
      credential_id: None,
    }
  }
  pub fn api_key(owner_user_id: Uuid, key_id: Uuid) -> Self {
    Self {
      kind: AuditActorKind::ApiKey,
      user_id: Some(owner_user_id),
      label: Some(format!("mcp-api-key:{}", short_uuid(key_id))),
      credential_type: Some("mcp_api_key".to_string()),
      credential_id: Some(key_id.to_string()),
    }
  }
}

fn short_uuid(id: Uuid) -> String {
  let raw = id.to_string();
  format!("{}...{}", &raw[..8], &raw[raw.len() - 6..])
}

/// An audit event to be recorded.
///
/// Created in the API layer after a successful mutation and passed to
/// [`AuditLogStore::record`].  Fields `old_value` / `new_value` carry
/// JSON representations of the before/after state (field diff or full entity).
///
/// **Security**: callers MUST NOT include password hashes, session tokens,
/// or other secrets in `old_value` / `new_value`.
#[derive(Debug, Clone)]
pub struct AuditEvent {
  /// Stable dotted event identifier, e.g. `"organization.unit.update"`,
  /// `"config.server.logLevel.update"`.
  pub event_key: String,
  /// High-level category (stored in the `category` column for indexed filtering).
  pub category: AuditCategory,
  /// Affected entity (nullable for global operations like feature toggles).
  pub target: Option<AuditTarget>,
  /// JSON snapshot of the affected state before the mutation.  `None` for create events.
  pub old_value: Option<serde_json::Value>,
  /// JSON snapshot of the affected state after the mutation.  `None` for delete events.
  pub new_value: Option<serde_json::Value>,
  /// Actor snapshot.
  pub actor: AuditActor,
  /// Opaque bag: `request_id`, `ip`, `user_agent` etc.
  pub metadata: Option<serde_json::Value>,
  /// Optional Organisationseinheit-Zuordnung. Wenn gesetzt, kann ein
  /// OU-Manager das Event ueber den manager-scoped Audit-Resolver
  /// einsehen (ORG-G-06). NULL fuer organisationsweite oder OU-fremde
  /// Operationen.
  pub target_unit_id: Option<Uuid>,
}

impl AuditEvent {
  /// Convenience constructor for a mutation with explicit old/new values.
  pub fn mutation(
    event_key: impl Into<String>,
    category: AuditCategory,
    target: Option<AuditTarget>,
    actor: AuditActor,
    old_value: Option<serde_json::Value>,
    new_value: Option<serde_json::Value>,
  ) -> Self {
    Self {
      event_key: event_key.into(),
      category,
      target,
      old_value,
      new_value,
      actor,
      metadata: None,
      target_unit_id: None,
    }
  }

  /// Add request-level metadata (request_id, etc.)
  pub fn with_metadata(mut self, meta: serde_json::Value) -> Self {
    self.metadata = Some(meta);
    self
  }

  /// Tag this event with the Organisationseinheit it concerns. Manager-scoped
  /// queries (`myOrganizationAuditLog`) filter on this field — only events
  /// with a matching `target_unit_id` are returned.
  pub fn with_unit(mut self, unit_id: Uuid) -> Self {
    self.target_unit_id = Some(unit_id);
    self
  }
}

// ─── Query types ─────────────────────────────────────────────────────────────

/// Filter for listing audit log entries.
///
/// All fields are optional — absent fields match any value.
#[derive(Debug, Clone, Default)]
pub struct AuditFilter {
  /// Filter to a specific category.
  pub category: Option<AuditCategory>,
  /// Filter to events by a specific admin user.
  pub actor_user_id: Option<Uuid>,
  /// Filter to a specific actor origin kind.
  pub actor_kind: Option<AuditActorKind>,
  /// Filter to delegated credential type.
  pub credential_type: Option<String>,
  /// Filter to delegated credential id.
  pub credential_id: Option<String>,
  /// Filter to events affecting a specific entity type.
  pub target_type: Option<String>,
  /// Filter to events affecting a specific entity (requires `target_type`).
  pub target_id: Option<String>,
  /// Filter to events whose `event_key` starts with this prefix.
  pub event_key_prefix: Option<String>,
  /// Lower bound (inclusive) on `created_at`.
  pub from: Option<DateTime<Utc>>,
  /// Upper bound (inclusive) on `created_at`.
  pub to: Option<DateTime<Utc>>,
  /// Filter to events tagged with a specific Organisationseinheit. When
  /// combined with the manager-scoped resolver this becomes the
  /// authoritative scope predicate (ORG-G-06).
  pub target_unit_id: Option<Uuid>,
}

/// A stored audit log entry (read-back from the DB).
#[derive(Debug, Clone)]
pub struct AuditEntry {
  pub id: Uuid,
  pub event_key: String,
  pub category: AuditCategory,
  pub target_type: Option<String>,
  pub target_id: Option<String>,
  pub target_label: Option<String>,
  pub old_value: Option<serde_json::Value>,
  pub new_value: Option<serde_json::Value>,
  pub actor_user_id: Option<Uuid>,
  pub actor_label: Option<String>,
  pub actor_kind: AuditActorKind,
  pub credential_type: Option<String>,
  pub credential_id: Option<String>,
  pub metadata: Option<serde_json::Value>,
  pub created_at: DateTime<Utc>,
  /// Organisationseinheit-Zuordnung (NULL fuer pre-Organisation oder
  /// organisationsweite Events). This is part of the canonical audit schema.
  pub target_unit_id: Option<Uuid>,
}

// ─── Error type ──────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum AuditError {
  Storage(String),
}

impl std::fmt::Display for AuditError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::Storage(msg) => write!(f, "audit storage error: {msg}"),
    }
  }
}

impl std::error::Error for AuditError {}

// ─── Repository trait ────────────────────────────────────────────────────────

/// Persistence port for the operator-visible audit log.
///
/// The infrastructure layer implements this trait against PostgreSQL
/// (`admin_audit_log` table, historical name).  The application layer wraps it in
/// [`myoxus_application::audit::AuditRecorder`], which provides
/// a non-blocking, fire-and-forget facade.
#[async_trait]
pub trait AuditLogStore: Send + Sync {
  /// Persist a single audit event.  Must not be called in a hot path without
  /// an async spawn — the recorder facade handles fire-and-forget semantics.
  async fn record(&self, event: AuditEvent) -> Result<(), AuditError>;

  /// List audit entries matching `filter`, ordered newest-first.
  async fn list(&self, filter: AuditFilter, skip: i64, take: i64) -> Result<Vec<AuditEntry>, AuditError>;

  /// Read one persisted entry by its stable ID; absence is not a storage failure.
  async fn get_by_id(&self, id: Uuid) -> Result<Option<AuditEntry>, AuditError>;

  /// Count matching audit entries (for pagination).
  async fn count(&self, filter: AuditFilter) -> Result<i64, AuditError>;
}
