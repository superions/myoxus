// SPDX-License-Identifier: AGPL-3.0-or-later
//! Atomic PostgreSQL writer for organization imports.
//!
//! Parsing and domain validation remain in `myoxus-application`. This adapter
//! owns only the aggregate transaction: it re-resolves mutable references,
//! preserves fields absent from CSV, and commits organization, OU, membership,
//! workspace-owner, capability, and policy projections together.

use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use chrono::Utc;
use myoxus_application::auth::AuthError;
use myoxus_application::organization::{
  ImportError, ImportSummary, OrganizationImportCommit, OrganizationImportFormat, OrganizationImportWriter,
  PreparedOrganizationImport,
};
use myoxus_application::workspace::WorkspaceOwnerTarget;
use myoxus_domain::entities::{
  OrganizationPolicy, OrganizationUnit, OrganizationUnitMember, OrganizationUnitMemberSource, OrganizationUnitRole,
  OrganizationUnitStatus, OrganizationUnitType, OrganizationUnitWorkspaceRelationship, PolicyState,
};
use myoxus_domain::repositories::{RepoResult, RepositoryError};
use serde_json::Value as JsonValue;
use sqlx::{FromRow, PgPool, Row};
use tracing::{info, instrument, warn};
use uuid::Uuid;

use crate::workspace::SqlxWorkspaceStore;

const MAX_SERIALIZATION_ATTEMPTS: usize = 3;
#[derive(Debug, Clone)]
pub struct PgOrganizationImportWriter {
  pool: PgPool,
}

impl PgOrganizationImportWriter {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  async fn apply_once(
    &self,
    import: &PreparedOrganizationImport,
  ) -> Result<OrganizationImportCommit, ApplyAttemptError> {
    let snapshot = &import.snapshot;
    let csv = import.format == OrganizationImportFormat::Csv;
    let unit_types = if import.presence.unit_types {
      snapshot.unit_types.as_slice()
    } else {
      &[]
    };
    let units = if import.presence.units {
      snapshot.units.as_slice()
    } else {
      &[]
    };
    let members = if import.presence.members {
      snapshot.members.as_slice()
    } else {
      &[]
    };
    let workspace_links = if import.presence.workspace_links {
      snapshot.workspace_links.as_slice()
    } else {
      &[]
    };
    let mut tx = self.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
      .execute(&mut *tx)
      .await?;

    let organization = sqlx::query("SELECT id, metadata FROM organization WHERE key = $1 FOR UPDATE")
      .bind(&snapshot.organization.key)
      .fetch_optional(&mut *tx)
      .await?
      .ok_or_else(|| {
        validation(
          "organization",
          format!(
            "no organization with key '{}' — single-tenant imports must reuse the existing key",
            snapshot.organization.key
          ),
        )
      })?;
    let organization_id: Uuid = organization.get("id");
    let organization_metadata: JsonValue = organization.get("metadata");

    // Workspace writers lock workspace before OU rows. Acquire every imported
    // workspace in that same stable order before locking the organization tree
    // below, avoiding a unit/workspace lock-order inversion with normal writes.
    let mut workspace_ids: Vec<Uuid> = workspace_links.iter().map(|link| link.workspace_id).collect();
    workspace_ids.sort_unstable();
    workspace_ids.dedup();
    if !workspace_ids.is_empty() {
      sqlx::query_scalar::<_, Uuid>("SELECT id FROM workspaces WHERE id = ANY($1) ORDER BY id FOR UPDATE")
        .bind(&workspace_ids)
        .fetch_all(&mut *tx)
        .await?;
    }

    let metadata = if csv {
      &organization_metadata
    } else {
      &snapshot.organization.metadata
    };
    PgOrganizationRepository::update_in_transaction(
      &mut tx,
      organization_id,
      &snapshot.organization.name,
      &snapshot.organization.slug,
      metadata,
    )
    .await
    .map_err(|error| repository("organization", error))?;

    let mut summary = ImportSummary {
      organization_updated: true,
      ..ImportSummary::default()
    };

    let existing_types = sqlx::query_as::<_, ExistingType>(
      r#"SELECT id, key, description, icon, color, is_preset, is_active, metadata
           FROM organization_unit_type
          WHERE organization_id = $1
          ORDER BY id
          FOR UPDATE"#,
    )
    .bind(organization_id)
    .fetch_all(&mut *tx)
    .await?;
    let mut types_by_key: HashMap<String, ExistingType> = existing_types
      .into_iter()
      .map(|unit_type| (unit_type.key.clone(), unit_type))
      .collect();
    let mut type_ids: HashMap<String, Uuid> = types_by_key
      .iter()
      .map(|(key, unit_type)| (key.clone(), unit_type.id))
      .collect();

    for unit_type in unit_types {
      let existing = types_by_key.remove(&unit_type.key);
      let id = existing.as_ref().map(|value| value.id).unwrap_or_else(Uuid::new_v4);
      let description = if csv {
        existing.as_ref().and_then(|value| value.description.clone())
      } else {
        unit_type.description.clone()
      };
      let icon = if csv {
        existing.as_ref().and_then(|value| value.icon.clone())
      } else {
        unit_type.icon.clone()
      };
      let color = if csv {
        existing.as_ref().and_then(|value| value.color.clone())
      } else {
        unit_type.color.clone()
      };
      let is_preset = existing
        .as_ref()
        .map(|value| value.is_preset)
        .unwrap_or(unit_type.is_preset);
      let is_active = if csv {
        existing.as_ref().map(|value| value.is_active).unwrap_or(true)
      } else {
        unit_type.is_active
      };
      let metadata = if csv {
        existing
          .as_ref()
          .map(|value| value.metadata.clone())
          .unwrap_or_else(empty_object)
      } else {
        unit_type.metadata.clone()
      };
      let saved = PgOrganizationUnitTypeRepository::upsert_in_transaction(
        &mut tx,
        &OrganizationUnitType {
          id,
          organization_id,
          key: unit_type.key.clone(),
          label: unit_type.label.clone(),
          description,
          icon,
          color,
          is_preset,
          is_active,
          is_structural: unit_type.is_structural,
          can_have_children: unit_type.can_have_children,
          can_be_root_level: unit_type.can_be_root_level,
          can_be_manager_created: unit_type.can_be_manager_created,
          can_have_cross_unit_members: unit_type.can_have_cross_unit_members,
          can_own_workspaces: unit_type.can_own_workspaces,
          can_manage_workspaces: unit_type.can_manage_workspaces,
          is_staff_unit: unit_type.is_staff_unit,
          requires_admin_approval: unit_type.requires_admin_approval,
          metadata,
          created_at: Utc::now(),
          updated_at: Utc::now(),
        },
      )
      .await
      .map_err(|error| repository("unitTypes", error))?;
      type_ids.insert(unit_type.key.clone(), saved.id);
      if existing.is_some() {
        summary.unit_types_updated += 1;
      } else {
        summary.unit_types_inserted += 1;
      }
    }

    let existing_units = sqlx::query_as::<_, ExistingUnit>(
      r#"SELECT id, slug, description, metadata, created_by
           FROM organization_unit
          WHERE organization_id = $1
          ORDER BY id
          FOR UPDATE"#,
    )
    .bind(organization_id)
    .fetch_all(&mut *tx)
    .await?;
    let mut units_by_slug: HashMap<String, ExistingUnit> = existing_units
      .into_iter()
      .map(|unit| (unit.slug.clone(), unit))
      .collect();
    let mut unit_ids: HashMap<String, Uuid> = units_by_slug
      .iter()
      .map(|(slug, unit)| (slug.clone(), unit.id))
      .collect();

    for unit in units {
      let existing = units_by_slug.remove(&unit.slug);
      let id = existing.as_ref().map(|value| value.id).unwrap_or_else(Uuid::new_v4);
      let type_id = type_ids
        .get(&unit.type_key)
        .copied()
        .ok_or_else(|| validation_at("units", "typeKey", format!("unknown unit-type key '{}'", unit.type_key)))?;
      let description = if csv {
        existing.as_ref().and_then(|value| value.description.clone())
      } else {
        unit.description.clone()
      };
      let metadata = if csv {
        existing
          .as_ref()
          .map(|value| value.metadata.clone())
          .unwrap_or_else(empty_object)
      } else {
        unit.metadata.clone()
      };
      let created_by = existing.as_ref().and_then(|value| value.created_by);
      let saved = PgOrganizationUnitRepository::upsert_in_transaction(
        &mut tx,
        &OrganizationUnit {
          id,
          organization_id,
          parent_unit_id: None,
          unit_type_id: type_id,
          name: unit.name.clone(),
          slug: unit.slug.clone(),
          description,
          status: OrganizationUnitStatus::parse_or_active(&unit.status),
          max_members: unit.max_members,
          metadata,
          created_by,
          child_unit_count: 0,
          member_count: 0,
          workspace_count: 0,
          created_at: Utc::now(),
          updated_at: Utc::now(),
        },
      )
      .await
      .map_err(|error| repository("units", error))?;
      unit_ids.insert(unit.slug.clone(), saved.id);
      if existing.is_some() {
        summary.units_updated += 1;
      } else {
        summary.units_inserted += 1;
      }
    }

    // Parent IDs are resolved only after every stable slug has a durable ID.
    for unit in units {
      let unit_id = unit_ids[&unit.slug];
      let parent_id = match unit.parent_slug.as_ref() {
        Some(parent_slug) => Some(
          unit_ids
            .get(parent_slug)
            .copied()
            .ok_or_else(|| validation_at("units", "parentSlug", format!("unknown parent slug '{parent_slug}'")))?,
        ),
        None => None,
      };
      PgOrganizationUnitRepository::set_parent_in_transaction(&mut tx, unit_id, parent_id)
        .await
        .map_err(|error| repository("units", error))?;
    }

    // Lock the full membership OU set before the shared, sorted user locks.
    // Manual and OIDC writers use OU -> user too; a per-row lock here would
    // invert that order for a later membership in the aggregate transaction.
    let mut member_unit_ids: Vec<Uuid> = members
      .iter()
      .filter_map(|m| unit_ids.get(&m.ou_slug).copied())
      .collect();
    member_unit_ids.sort_unstable();
    member_unit_ids.dedup();
    sqlx::query("SELECT id FROM organization_unit WHERE id=ANY($1) ORDER BY id FOR UPDATE")
      .bind(&member_unit_ids)
      .fetch_all(&mut *tx)
      .await?;
    let emails: Vec<&str> = members.iter().map(|m| m.user_email.as_str()).collect();
    let member_user_ids: Vec<Uuid> =
      sqlx::query_scalar("SELECT id FROM users WHERE email=ANY($1) AND status <> 'deleted' ORDER BY id")
        .bind(&emails)
        .fetch_all(&mut *tx)
        .await?;
    PgManagerCapabilityWriter::lock_users(&mut tx, &member_user_ids).await?;

    let mut capability_candidates = HashSet::new();
    for member in members {
      let unit_id = unit_ids
        .get(&member.ou_slug)
        .copied()
        .ok_or_else(|| validation_at("members", "ouSlug", format!("unknown OU slug '{}'", member.ou_slug)))?;
      let user_id =
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email = $1 AND status <> 'deleted' FOR SHARE")
          .bind(&member.user_email)
          .fetch_optional(&mut *tx)
          .await?
          .ok_or_else(|| {
            validation_at(
              "members",
              "userEmail",
              format!("no user with email '{}'", member.user_email),
            )
          })?;
      let existing = sqlx::query_as::<_, ExistingMember>(
        r#"SELECT role::text AS role, source::text AS source, metadata
             FROM organization_unit_member
            WHERE unit_id = $1 AND user_id = $2
            FOR UPDATE"#,
      )
      .bind(unit_id)
      .bind(user_id)
      .fetch_optional(&mut *tx)
      .await?;
      if let Some(existing) = &existing
        && existing.source != member.source
      {
        return Err(validation_at(
          "members",
          "source",
          format!(
            "membership is owned by '{}' and cannot be replaced by '{}' import data",
            existing.source, member.source
          ),
        ));
      }
      let metadata = if csv {
        existing
          .as_ref()
          .map(|value| value.metadata.clone())
          .unwrap_or_else(empty_object)
      } else {
        member.metadata.clone()
      };
      let role = OrganizationUnitRole::parse_or_member(&member.role);
      let source = OrganizationUnitMemberSource::parse_or_manual(&member.source);
      if existing.as_ref().is_some_and(|value| value.role == "manager") || role == OrganizationUnitRole::Manager {
        capability_candidates.insert(user_id);
      }
      if existing.as_ref().is_some_and(|value| {
        value.role == role.as_str() && value.source == source.as_str() && value.metadata == metadata
      }) {
        // Re-importing an unchanged membership is a true no-op. In particular,
        // it must not turn a valid snapshot of an inactive OU into an attempted
        // membership mutation that the canonical repository correctly rejects.
        summary.members_updated += 1;
        continue;
      }
      PgOrganizationUnitMemberRepository::upsert_in_transaction(
        &mut tx,
        &OrganizationUnitMember {
          unit_id,
          user_id,
          role,
          source,
          metadata,
          created_at: Utc::now(),
          updated_at: Utc::now(),
        },
      )
      .await
      .map_err(|error| ApplyAttemptError::Repository {
        source: "members",
        error,
      })?;
      if existing.is_some() {
        summary.members_updated += 1;
      } else {
        summary.members_inserted += 1;
      }
    }

    let mut capability_candidates: Vec<Uuid> = capability_candidates.into_iter().collect();
    capability_candidates.sort_unstable();
    let mut manager_capability_users = Vec::new();
    for user_id in capability_candidates {
      if PgManagerCapabilityWriter::sync_in_transaction(&mut tx, user_id)
        .await
        .map_err(ApplyAttemptError::Sql)?
      {
        manager_capability_users.push(user_id);
      }
    }

    for link in workspace_links {
      let unit_id = unit_ids.get(&link.ou_slug).copied().ok_or_else(|| {
        validation_at(
          "workspaceLinks",
          "ouSlug",
          format!("unknown OU slug '{}'", link.ou_slug),
        )
      })?;
      let relationship = OrganizationUnitWorkspaceRelationship::parse_or_managed(&link.relationship);
      let was_present: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM organization_unit_workspace
            WHERE unit_id = $1 AND workspace_id = $2
              AND relationship = $3::organization_unit_workspace_relationship
         )",
      )
      .bind(unit_id)
      .bind(link.workspace_id)
      .bind(relationship.as_str())
      .fetch_one(&mut *tx)
      .await?;

      if relationship == OrganizationUnitWorkspaceRelationship::Owner {
        SqlxWorkspaceStore::transfer_workspace_owner_in_transaction(
          &mut tx,
          link.workspace_id,
          WorkspaceOwnerTarget::OrganizationUnit(unit_id),
          None,
        )
        .await
        .map_err(ApplyAttemptError::Workspace)?;
      } else {
        PgOrganizationUnitWorkspaceRepository::set_relationship_in_transaction(
          &mut tx,
          unit_id,
          link.workspace_id,
          relationship,
        )
        .await
        .map_err(|error| ApplyAttemptError::Repository {
          source: "workspaceLinks",
          error,
        })?;
      }
      if was_present {
        summary.workspace_links_updated += 1;
      } else {
        summary.workspace_links_inserted += 1;
      }
    }

    if import.presence.policies {
      let policy =
        sqlx::query("SELECT metadata, updated_by FROM organization_policy WHERE organization_id = $1 FOR UPDATE")
          .bind(organization_id)
          .fetch_optional(&mut *tx)
          .await?;
      let policy_metadata: JsonValue = policy
        .as_ref()
        .map(|row| row.get("metadata"))
        .unwrap_or_else(empty_object);
      let updated_by: Option<Uuid> = policy.as_ref().and_then(|row| row.get("updated_by"));
      PgOrganizationPolicyRepository::upsert_in_transaction(
        &mut tx,
        &OrganizationPolicy {
          organization_id,
          manager_root_project_creation: PolicyState::parse_or_disabled(
            &snapshot.policies.manager_root_project_creation,
          ),
          manager_unit_project_creation: PolicyState::parse_or_disabled(
            &snapshot.policies.manager_unit_project_creation,
          ),
          manager_can_create_workspaces: snapshot.policies.manager_can_create_workspaces,
          manager_can_manage_ou_members: snapshot.policies.manager_can_manage_ou_members,
          import_export_enabled: snapshot.policies.import_export_enabled,
          metadata: policy_metadata,
          updated_by,
          updated_at: Utc::now(),
        },
      )
      .await
      .map_err(|error| repository("policies", error))?;
      summary.policy_updated = true;
    }

    tx.commit().await?;
    Ok(OrganizationImportCommit {
      summary,
      manager_capability_users,
    })
  }
}

#[async_trait]
impl OrganizationImportWriter for PgOrganizationImportWriter {
  #[instrument(skip_all)]
  async fn apply(
    &self,
    import: &PreparedOrganizationImport,
  ) -> RepoResult<Result<OrganizationImportCommit, Vec<ImportError>>> {
    for attempt in 1..=MAX_SERIALIZATION_ATTEMPTS {
      match self.apply_once(import).await {
        Ok(commit) => {
          info!(attempt, summary = ?commit.summary, "organization import transaction committed");
          return Ok(Ok(commit));
        }
        Err(error) if error.is_serialization_failure() && attempt < MAX_SERIALIZATION_ATTEMPTS => {
          warn!(
            attempt,
            "organization import serialization conflict; retrying transaction"
          );
        }
        Err(ApplyAttemptError::Validation(errors)) => return Ok(Err(errors)),
        Err(ApplyAttemptError::Repository {
          source,
          error: RepositoryError::Conflict(message),
        }) => return Ok(Err(vec![ImportError::global(source, message)])),
        Err(ApplyAttemptError::Repository {
          source,
          error: RepositoryError::Validation(message),
        }) => return Ok(Err(vec![ImportError::global(source, message)])),
        Err(ApplyAttemptError::Repository {
          source,
          error: RepositoryError::NotFound(entity),
        }) => return Ok(Err(vec![ImportError::global(source, format!("not found: {entity}"))])),
        Err(ApplyAttemptError::Workspace(AuthError::InvalidInput(message) | AuthError::NotFound(message))) => {
          return Ok(Err(vec![ImportError::global("workspaceLinks", message)]));
        }
        Err(ApplyAttemptError::Workspace(AuthError::WorkspaceNameConflict { suggestion })) => {
          return Ok(Err(vec![ImportError::global(
            "workspaceLinks",
            format!("workspace name conflicts with its target owner; suggested name: {suggestion}"),
          )]));
        }
        Err(error) => return Err(error.into_repository_error()),
      }
    }
    unreachable!("bounded import loop returns on its final attempt")
  }
}

#[derive(Debug, FromRow)]
struct ExistingType {
  id: Uuid,
  key: String,
  description: Option<String>,
  icon: Option<String>,
  color: Option<String>,
  is_preset: bool,
  is_active: bool,
  metadata: JsonValue,
}

#[derive(Debug, FromRow)]
struct ExistingUnit {
  id: Uuid,
  slug: String,
  description: Option<String>,
  metadata: JsonValue,
  created_by: Option<Uuid>,
}

#[derive(Debug, FromRow)]
struct ExistingMember {
  role: String,
  source: String,
  metadata: JsonValue,
}

#[derive(Debug)]
enum ApplyAttemptError {
  Sql(sqlx::Error),
  Repository {
    source: &'static str,
    error: RepositoryError,
  },
  Workspace(AuthError),
  Validation(Vec<ImportError>),
}

impl From<sqlx::Error> for ApplyAttemptError {
  fn from(error: sqlx::Error) -> Self {
    Self::Sql(error)
  }
}

impl ApplyAttemptError {
  fn is_serialization_failure(&self) -> bool {
    match self {
      Self::Sql(sqlx::Error::Database(error)) => error.code().as_deref() == Some("40001"),
      Self::Repository {
        error: RepositoryError::Storage(message),
        ..
      } => message.contains("40001") || message.contains("could not serialize access"),
      Self::Workspace(AuthError::Storage(message)) => {
        message.contains("40001") || message.contains("could not serialize access")
      }
      _ => false,
    }
  }

  fn into_repository_error(self) -> RepositoryError {
    match self {
      Self::Sql(sqlx::Error::Database(error)) if error.code().as_deref() == Some("23505") => {
        RepositoryError::Conflict("organization import conflicts with concurrent state")
      }
      Self::Sql(error)
        if matches!(error, sqlx::Error::RowNotFound) || crate::auth::is_terminal_account_error(&error) =>
      {
        RepositoryError::NotFound("user")
      }
      Self::Sql(error) => {
        tracing::error!(database_code = ?database_code(&error), "organization import transaction failed");
        RepositoryError::Storage("organization import transaction failed".to_string())
      }
      Self::Repository {
        error: RepositoryError::Storage(_),
        ..
      } => RepositoryError::Storage("organization import transaction failed".to_string()),
      Self::Repository { error, .. } => error,
      Self::Workspace(AuthError::Storage(_)) => {
        RepositoryError::Storage("organization import transaction failed".to_string())
      }
      Self::Workspace(error) => RepositoryError::Validation(error.to_string()),
      Self::Validation(errors) => RepositoryError::Validation(
        errors
          .first()
          .map(|error| error.message.clone())
          .unwrap_or_else(|| "organization import validation failed".to_string()),
      ),
    }
  }
}

fn validation(source: impl Into<String>, message: impl Into<String>) -> ApplyAttemptError {
  ApplyAttemptError::Validation(vec![ImportError::global(source, message)])
}

fn repository(source: &'static str, error: RepositoryError) -> ApplyAttemptError {
  ApplyAttemptError::Repository { source, error }
}

fn validation_at(source: impl Into<String>, field: impl Into<String>, message: impl Into<String>) -> ApplyAttemptError {
  ApplyAttemptError::Validation(vec![ImportError {
    source: source.into(),
    row: None,
    field: Some(field.into()),
    message: message.into(),
  }])
}

fn empty_object() -> JsonValue {
  serde_json::json!({})
}

fn database_code(error: &sqlx::Error) -> Option<String> {
  match error {
    sqlx::Error::Database(error) => error.code().map(|code| code.into_owned()),
    _ => None,
  }
}

use super::{
  PgManagerCapabilityWriter, PgOrganizationPolicyRepository, PgOrganizationRepository,
  PgOrganizationUnitMemberRepository, PgOrganizationUnitRepository, PgOrganizationUnitTypeRepository,
  PgOrganizationUnitWorkspaceRepository,
};
