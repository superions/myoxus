// SPDX-License-Identifier: AGPL-3.0-or-later
//! GraphQL types for the admin/operator-visible audit log.
//!
//! These types are returned by the `adminAuditLog` / `adminAuditLogCount` resolvers.

use async_graphql::{Error, ID, InputObject, Object, Result, SimpleObject};
use chrono::{DateTime, Utc};
use serde_json::Value;
use uuid::Uuid;

// ─── Input filter ─────────────────────────────────────────────────────────────

/// Filter for `adminAuditLog` / `adminAuditLogCount` queries.
///
/// All fields are optional; absent fields match any value.
#[derive(InputObject, Debug, Default, Clone)]
pub struct AuditLogFilterInput {
  /// Restrict to a specific category: `"config"`, `"organization"`, `"user"`,
  /// `"workspace"`, `"feature"`, `"template"`, `"logging"`, `"cache"`.
  pub category: Option<String>,
  /// Restrict to events performed by or delegated from a specific user.
  #[graphql(name = "actorUserId")]
  pub actor_user_id: Option<ID>,
  /// Restrict to actor origin kind: `"user"`, `"system"` or `"api_key"`.
  #[graphql(name = "actorKind")]
  pub actor_kind: Option<String>,
  /// Restrict to delegated credential type, e.g. `"mcp_api_key"`.
  #[graphql(name = "credentialType")]
  pub credential_type: Option<String>,
  /// Restrict to delegated credential id.
  #[graphql(name = "credentialId")]
  pub credential_id: Option<String>,
  /// Restrict to events affecting a specific entity type.
  #[graphql(name = "targetType")]
  pub target_type: Option<String>,
  /// Restrict to events affecting a specific entity ID (requires `targetType`).
  #[graphql(name = "targetId")]
  pub target_id: Option<String>,
  /// Restrict to events whose `eventKey` starts with this prefix.
  #[graphql(name = "eventKeyPrefix")]
  pub event_key_prefix: Option<String>,
  /// Lower bound (inclusive) on `createdAt`.
  pub from: Option<DateTime<Utc>>,
  /// Upper bound (inclusive) on `createdAt`.
  pub to: Option<DateTime<Utc>>,
  /// Restrict to events tagged with a specific Organisationseinheit
  /// (`target_unit_id`). Set automatically by `myOrganizationAuditLog`.
  #[graphql(name = "targetUnitId")]
  pub target_unit_id: Option<ID>,
}

impl AuditLogFilterInput {
  /// Convert to the domain [`AuditFilter`].
  pub fn to_domain(&self) -> Result<myoxus_domain::audit::AuditFilter> {
    use myoxus_domain::audit::AuditFilter;
    let category = self
      .category
      .as_deref()
      .map(str::trim)
      .filter(|category| !category.is_empty())
      .map(|category| {
        category
          .parse()
          .map_err(|_| Error::new(format!("invalid audit category: {category}")))
      })
      .transpose()?;
    let actor_user_id = self
      .actor_user_id
      .as_ref()
      .map(|id| Uuid::parse_str(id.as_str()).map_err(|_| Error::new("actorUserId must be a valid UUID")))
      .transpose()?;
    let target_unit_id = self
      .target_unit_id
      .as_ref()
      .map(|id| Uuid::parse_str(id.as_str()).map_err(|_| Error::new("targetUnitId must be a valid UUID")))
      .transpose()?;
    Ok(AuditFilter {
      category,
      actor_user_id,
      actor_kind: self
        .actor_kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
          value
            .parse()
            .map_err(|_| Error::new(format!("invalid audit actor kind: {value}")))
        })
        .transpose()?,
      credential_type: self.credential_type.clone(),
      credential_id: self.credential_id.clone(),
      target_type: self.target_type.clone(),
      target_id: self.target_id.clone(),
      event_key_prefix: self.event_key_prefix.clone(),
      from: self.from,
      to: self.to,
      target_unit_id,
    })
  }
}

// ─── Output types ─────────────────────────────────────────────────────────────

/// Target entity for an audit log entry.
#[derive(SimpleObject, Clone, Debug)]
pub struct AuditTargetType {
  /// Entity type: `"organization_unit"`, `"user"`, `"workspace"`, `"config"`, etc.
  #[graphql(name = "type")]
  pub target_type: String,
  /// UUID or config key string.
  pub id: String,
  /// Human-readable snapshot for display.
  pub label: Option<String>,
}

/// Actor for an audit log entry.
#[derive(Clone, Debug)]
pub struct AdminAuditActorType {
  pub id: Option<Uuid>,
  pub label: Option<String>,
  pub kind: String,
  pub credential_type: Option<String>,
  pub credential_id: Option<String>,
}

#[Object]
impl AdminAuditActorType {
  async fn id(&self) -> Option<ID> {
    self.id.map(|u| ID::from(u.to_string()))
  }
  /// Human-readable snapshot (email) at the time of the event.
  async fn label(&self) -> Option<&str> {
    self.label.as_deref()
  }
  /// Actor origin: `user`, `system` or `api_key`.
  async fn kind(&self) -> &str {
    &self.kind
  }
  /// Delegated credential type, e.g. `mcp_api_key`.
  #[graphql(name = "credentialType")]
  async fn credential_type(&self) -> Option<&str> {
    self.credential_type.as_deref()
  }
  /// Delegated credential id. This is never a plaintext secret or key hash.
  #[graphql(name = "credentialId")]
  async fn credential_id(&self) -> Option<&str> {
    self.credential_id.as_deref()
  }
}

/// A single admin audit log entry.
#[derive(Clone, Debug)]
pub struct AdminAuditLogEntryType {
  pub id: Uuid,
  pub event_key: String,
  pub category: String,
  pub target: Option<AuditTargetType>,
  pub old_value: Option<Value>,
  pub new_value: Option<Value>,
  pub actor: Option<AdminAuditActorType>,
  pub metadata: Option<Value>,
  pub created_at: DateTime<Utc>,
  pub target_unit_id: Option<Uuid>,
}

#[Object]
impl AdminAuditLogEntryType {
  async fn id(&self) -> ID {
    ID::from(self.id.to_string())
  }
  #[graphql(name = "eventKey")]
  async fn event_key(&self) -> &str {
    &self.event_key
  }
  async fn category(&self) -> &str {
    &self.category
  }
  async fn target(&self) -> Option<&AuditTargetType> {
    self.target.as_ref()
  }
  #[graphql(name = "oldValue")]
  async fn old_value(&self) -> Option<&Value> {
    self.old_value.as_ref()
  }
  #[graphql(name = "newValue")]
  async fn new_value(&self) -> Option<&Value> {
    self.new_value.as_ref()
  }
  async fn actor(&self) -> Option<&AdminAuditActorType> {
    self.actor.as_ref()
  }
  async fn metadata(&self) -> Option<&Value> {
    self.metadata.as_ref()
  }
  #[graphql(name = "createdAt")]
  async fn created_at(&self) -> DateTime<Utc> {
    self.created_at
  }
  /// Organisationseinheit, der dieses Event zugeordnet ist.
  /// `None` fuer organisationsweite oder nicht-OU-bezogene Eintraege.
  #[graphql(name = "targetUnitId")]
  async fn target_unit_id(&self) -> Option<ID> {
    self.target_unit_id.map(|u| ID::from(u.to_string()))
  }
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

impl From<myoxus_domain::audit::AuditEntry> for AdminAuditLogEntryType {
  fn from(entry: myoxus_domain::audit::AuditEntry) -> Self {
    let target = match (entry.target_type, entry.target_id) {
      (Some(tt), Some(tid)) => Some(AuditTargetType {
        target_type: tt,
        id: tid,
        label: entry.target_label,
      }),
      _ => None,
    };
    let actor = if entry.actor_user_id.is_some() || entry.actor_label.is_some() {
      Some(AdminAuditActorType {
        id: entry.actor_user_id,
        label: entry.actor_label,
        kind: entry.actor_kind.as_str().to_string(),
        credential_type: entry.credential_type,
        credential_id: entry.credential_id,
      })
    } else {
      None
    };
    Self {
      id: entry.id,
      event_key: entry.event_key,
      category: entry.category.as_str().to_string(),
      target,
      old_value: entry.old_value,
      new_value: entry.new_value,
      actor,
      metadata: entry.metadata,
      created_at: entry.created_at,
      target_unit_id: entry.target_unit_id,
    }
  }
}
