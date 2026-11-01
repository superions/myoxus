// SPDX-License-Identifier: AGPL-3.0-or-later
//! Atomic manual membership and derived Manager-capability persistence.

use super::{PgManagerCapabilityWriter, PgOrganizationUnitMemberRepository};
use async_trait::async_trait;
use chrono::Utc;
use myoxus_application::organization::{
  MembershipChange, MembershipCommit, MembershipOperation, OrganizationMembershipWriter,
};
use myoxus_domain::entities::{OrganizationUnitMember, OrganizationUnitMemberSource, OrganizationUnitRole};
use myoxus_domain::repositories::{RepoResult, RepositoryError};
use sqlx::{PgPool, Row};

#[derive(Clone)]
pub struct PgOrganizationMembershipWriter {
  pool: PgPool,
}
impl PgOrganizationMembershipWriter {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }
}

fn storage(error: sqlx::Error) -> RepositoryError {
  if matches!(error, sqlx::Error::RowNotFound) || crate::auth::is_terminal_account_error(&error) {
    return RepositoryError::NotFound("user");
  }
  tracing::error!(database_code = ?error.as_database_error().and_then(|e| e.code()), "organization membership transaction failed");
  RepositoryError::Storage("organization membership transaction failed".into())
}

#[async_trait]
impl OrganizationMembershipWriter for PgOrganizationMembershipWriter {
  #[tracing::instrument(skip_all, fields(unit_id = %change.unit_id, user_id = %change.user_id))]
  async fn commit(&self, change: &MembershipChange) -> RepoResult<MembershipCommit> {
    let mut tx = self.pool.begin().await.map_err(storage)?;
    // All membership writers lock OU before users; imports lock their entire
    // OU set first. A user's roles across different OUs then serialize here.
    let unit =
      sqlx::query("SELECT organization_id,status::text AS status FROM organization_unit WHERE id=$1 FOR UPDATE")
        .bind(change.unit_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(storage)?;
    let Some(unit) = unit else {
      if change.manager_id.is_some() {
        return Err(RepositoryError::Conflict("ORGANIZATION_MEMBERSHIP_ACTION_FORBIDDEN"));
      }
      if change.operation == MembershipOperation::Remove
        && change.manager_id.is_none()
        && change.organization_id.is_none()
      {
        return Ok(MembershipCommit {
          user_label: None,
          previous: None,
          current: None,
          manager_capability: None,
        });
      }
      return Err(RepositoryError::NotFound("organization_unit"));
    };
    let org: uuid::Uuid = unit.get("organization_id");
    if change.organization_id.is_some_and(|expected| expected != org) {
      return Err(RepositoryError::Conflict(
        "organization unit belongs to another organization",
      ));
    }
    let mut users = vec![change.user_id];
    if let Some(manager) = change.manager_id {
      users.push(manager);
    }
    users.sort_unstable();
    users.dedup();
    let found = PgManagerCapabilityWriter::lock_users(&mut tx, &users)
      .await
      .map_err(storage)?;
    let user_label =
      sqlx::query_as::<_, (Option<String>, String)>("SELECT name,email FROM users WHERE id=$1 AND status <> 'deleted'")
        .bind(change.user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(storage)?
        .map(|(name, email)| {
          name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(email.as_str())
            .to_string()
        });
    let previous = sqlx::query("SELECT unit_id,user_id,role::text AS role_text,source::text AS source_text,metadata,created_at,updated_at FROM organization_unit_member WHERE unit_id=$1 AND user_id=$2 FOR UPDATE")
      .bind(change.unit_id).bind(change.user_id).fetch_optional(&mut *tx).await.map_err(storage)?
      .map(PgOrganizationUnitMemberRepository::map_row);
    if let Some(manager) = change.manager_id {
      let policy = sqlx::query_scalar::<_, bool>(
        "SELECT manager_can_manage_ou_members FROM organization_policy WHERE organization_id=$1 FOR SHARE",
      )
      .bind(org)
      .fetch_optional(&mut *tx)
      .await
      .map_err(storage)?
      .unwrap_or(false);
      let capable = sqlx::query_scalar::<_, bool>(
        "SELECT activated FROM user_features WHERE user_id=$1 AND feature_name='manager' FOR SHARE",
      )
      .bind(manager)
      .fetch_optional(&mut *tx)
      .await
      .map_err(storage)?
      .unwrap_or(false);
      let scoped = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM organization_unit_member WHERE unit_id=$1 AND user_id=$2 AND role='manager')",
      )
      .bind(change.unit_id)
      .bind(manager)
      .fetch_one(&mut *tx)
      .await
      .map_err(storage)?;
      if !policy
        || !capable
        || !scoped
        || unit.get::<String, _>("status") != "active"
        || previous
          .as_ref()
          .is_some_and(|m| m.role == OrganizationUnitRole::Manager)
        || (!matches!(
          change.operation,
          MembershipOperation::Remove | MembershipOperation::RemoveExisting
        ) && change.role == OrganizationUnitRole::Manager)
      {
        return Err(RepositoryError::Conflict("ORGANIZATION_MEMBERSHIP_ACTION_FORBIDDEN"));
      }
    }
    if !found.contains(&change.user_id) && change.operation != MembershipOperation::Remove {
      return Err(RepositoryError::NotFound("user"));
    }
    match change.operation {
      MembershipOperation::Add if previous.is_some() => {
        return Err(RepositoryError::Conflict(
          "user is already a member of this organization unit",
        ));
      }
      MembershipOperation::SetRole | MembershipOperation::RemoveExisting if previous.is_none() => {
        return Err(RepositoryError::Conflict(
          "user is not a member of this organization unit",
        ));
      }
      _ => {}
    }
    let current = if matches!(
      change.operation,
      MembershipOperation::Remove | MembershipOperation::RemoveExisting
    ) {
      PgOrganizationUnitMemberRepository::remove_in_transaction(&mut tx, change.unit_id, change.user_id).await?;
      None
    } else {
      let now = Utc::now();
      Some(
        PgOrganizationUnitMemberRepository::upsert_in_transaction(
          &mut tx,
          &OrganizationUnitMember {
            unit_id: change.unit_id,
            user_id: change.user_id,
            role: change.role,
            source: OrganizationUnitMemberSource::Manual,
            metadata: change.metadata.clone(),
            created_at: now,
            updated_at: now,
          },
        )
        .await?,
      )
    };
    // Reader/Member-only operations must preserve independently granted global
    // Manager flags. Only a Manager membership transition owns this projection.
    let manager_capability = if previous
      .as_ref()
      .is_some_and(|m| m.role == OrganizationUnitRole::Manager)
      || current
        .as_ref()
        .is_some_and(|m| m.role == OrganizationUnitRole::Manager)
    {
      if PgManagerCapabilityWriter::sync_in_transaction(&mut tx, change.user_id)
        .await
        .map_err(storage)?
      {
        Some(
          sqlx::query_scalar::<_, bool>(
            "SELECT activated FROM user_features WHERE user_id=$1 AND feature_name='manager'",
          )
          .bind(change.user_id)
          .fetch_one(&mut *tx)
          .await
          .map_err(storage)?,
        )
      } else {
        None
      }
    } else {
      None
    };
    tx.commit().await.map_err(storage)?;
    Ok(MembershipCommit {
      user_label,
      previous,
      current,
      manager_capability,
    })
  }
}
