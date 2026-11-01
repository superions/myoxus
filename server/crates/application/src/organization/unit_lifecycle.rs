// SPDX-License-Identifier: AGPL-3.0-or-later
//! Authoritative organization-unit lifecycle service.
//!
//! GraphQL, Admin and MCP adapters call this service instead of composing raw
//! repository mutations. Authorization remains an adapter concern, while all
//! status, placement, preview/recheck/delete and audit behavior lives here.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use thiserror::Error;
use tracing::instrument;

use myoxus_domain::audit::{AuditActor, AuditCategory, AuditEvent, AuditTarget};
use myoxus_domain::entities::{OrganizationUnit, OrganizationUnitDeletionPreview, OrganizationUnitStatus};
use myoxus_domain::ids::OrganizationUnitId;
use myoxus_domain::repositories::{OrganizationUnitLifecycleRepository, RepositoryError};

use crate::audit::AuditRecorder;

#[derive(Debug, Error)]
pub enum OrganizationUnitLifecycleError {
  #[error("ORGANIZATION_UNIT_NOT_FOUND")]
  NotFound,
  #[error("ORGANIZATION_UNIT_CONFIRMATION_MISMATCH")]
  ConfirmationMismatch,
  #[error("ORGANIZATION_UNIT_CONFLICT")]
  Conflict,
  #[error("ORGANIZATION_UNIT_SLUG_CONFLICT")]
  SlugConflict,
  #[error("ORGANIZATION_UNIT_CYCLE")]
  Cycle,
  #[error("ORGANIZATION_UNIT_ROOT_NOT_ALLOWED")]
  RootNotAllowed,
  #[error("ORGANIZATION_UNIT_IN_USE")]
  InUse,
  #[error("ORGANIZATION_UNIT_INVALID_TRANSITION")]
  InvalidTransition,
  #[error("ORGANIZATION_UNIT_PARENT_INACTIVE")]
  ParentInactive,
  #[error("ORGANIZATION_UNIT_TYPE_INACTIVE")]
  TypeInactive,
  #[error("ORGANIZATION_UNIT_ACTIVE")]
  Active,
  #[error("ORGANIZATION_UNIT_VALIDATION: {0}")]
  Validation(String),
  #[error("ORGANIZATION_UNIT_STORAGE")]
  Storage(#[source] RepositoryError),
}

impl OrganizationUnitLifecycleError {
  pub fn code(&self) -> &'static str {
    match self {
      Self::NotFound => "ORGANIZATION_UNIT_NOT_FOUND",
      Self::ConfirmationMismatch => "ORGANIZATION_UNIT_CONFIRMATION_MISMATCH",
      Self::Conflict => "ORGANIZATION_UNIT_CONFLICT",
      Self::SlugConflict => "ORGANIZATION_UNIT_SLUG_CONFLICT",
      Self::Cycle => "ORGANIZATION_UNIT_CYCLE",
      Self::RootNotAllowed => "ORGANIZATION_UNIT_ROOT_NOT_ALLOWED",
      Self::InUse => "ORGANIZATION_UNIT_IN_USE",
      Self::InvalidTransition => "ORGANIZATION_UNIT_INVALID_TRANSITION",
      Self::ParentInactive => "ORGANIZATION_UNIT_PARENT_INACTIVE",
      Self::TypeInactive => "ORGANIZATION_UNIT_TYPE_INACTIVE",
      Self::Active => "ORGANIZATION_UNIT_ACTIVE",
      Self::Validation(_) => "ORGANIZATION_UNIT_VALIDATION",
      Self::Storage(_) => "ORGANIZATION_UNIT_STORAGE",
    }
  }
}

impl From<RepositoryError> for OrganizationUnitLifecycleError {
  fn from(error: RepositoryError) -> Self {
    match error {
      RepositoryError::NotFound("organization_unit") => Self::NotFound,
      RepositoryError::Conflict("ORGANIZATION_UNIT_CONFIRMATION_MISMATCH") => Self::ConfirmationMismatch,
      RepositoryError::Conflict("ORGANIZATION_UNIT_CONFLICT") => Self::Conflict,
      RepositoryError::Conflict("ORGANIZATION_UNIT_SLUG_CONFLICT") => Self::SlugConflict,
      RepositoryError::Conflict("ORGANIZATION_UNIT_CYCLE") => Self::Cycle,
      RepositoryError::Conflict("ORGANIZATION_UNIT_ROOT_NOT_ALLOWED") => Self::RootNotAllowed,
      RepositoryError::Conflict("ORGANIZATION_UNIT_IN_USE") => Self::InUse,
      RepositoryError::Conflict("ORGANIZATION_UNIT_INVALID_TRANSITION") => Self::InvalidTransition,
      RepositoryError::Conflict("ORGANIZATION_UNIT_PARENT_INACTIVE") => Self::ParentInactive,
      RepositoryError::Conflict("ORGANIZATION_UNIT_TYPE_INACTIVE") => Self::TypeInactive,
      RepositoryError::Conflict("ORGANIZATION_UNIT_ACTIVE") => Self::Active,
      RepositoryError::Validation(message) => Self::Validation(message),
      other => Self::Storage(other),
    }
  }
}

#[derive(Clone)]
pub struct OrganizationUnitLifecycleService {
  repository: Arc<dyn OrganizationUnitLifecycleRepository>,
  audit: AuditRecorder,
}

impl OrganizationUnitLifecycleService {
  pub fn new(repository: Arc<dyn OrganizationUnitLifecycleRepository>, audit: AuditRecorder) -> Self {
    Self { repository, audit }
  }

  async fn record_change(
    &self,
    event: &'static str,
    actor: AuditActor,
    before: Option<&OrganizationUnit>,
    after: Option<&OrganizationUnit>,
  ) {
    let snapshot = after.or(before);
    let Some(unit) = snapshot else { return };
    let mut audit = AuditEvent::mutation(
      event,
      AuditCategory::Organization,
      Some(AuditTarget::entity(
        "organization_unit",
        unit.id,
        Some(unit.name.clone()),
      )),
      actor,
      before.map(safe_unit_snapshot),
      after.map(safe_unit_snapshot),
    );
    // A successful delete cannot keep an FK to the deleted OU. Other events
    // retain the unit scope for manager-visible audit filtering.
    if after.is_some() {
      audit = audit.with_unit(unit.id);
    }
    self.audit.record(audit).await;
  }

  #[instrument(skip(self, unit, actor), fields(unit_id = %unit.id), err)]
  pub async fn create(
    &self,
    unit: &OrganizationUnit,
    actor: AuditActor,
  ) -> Result<OrganizationUnit, OrganizationUnitLifecycleError> {
    let saved = self.repository.create(unit).await?;
    self
      .record_change("organization.unit.create", actor, None, Some(&saved))
      .await;
    Ok(saved)
  }

  #[instrument(skip(self, unit, actor), fields(unit_id = %unit.id), err)]
  pub async fn update(
    &self,
    unit: &OrganizationUnit,
    actor: AuditActor,
  ) -> Result<OrganizationUnit, OrganizationUnitLifecycleError> {
    let saved = self.repository.update(unit).await?;
    self
      .record_change("organization.unit.update", actor, None, Some(&saved))
      .await;
    Ok(saved)
  }

  #[instrument(skip(self, actor), fields(unit_id = %unit), err)]
  pub async fn move_unit(
    &self,
    unit: OrganizationUnitId,
    parent: Option<OrganizationUnitId>,
    actor: AuditActor,
  ) -> Result<OrganizationUnit, OrganizationUnitLifecycleError> {
    let saved = self.repository.move_unit(unit, parent).await?;
    self
      .record_change("organization.unit.move", actor, None, Some(&saved))
      .await;
    Ok(saved)
  }

  #[instrument(skip(self, actor), fields(unit_id = %unit, target_status = status.as_str()), err)]
  pub async fn set_status(
    &self,
    unit: OrganizationUnitId,
    status: OrganizationUnitStatus,
    actor: AuditActor,
  ) -> Result<OrganizationUnit, OrganizationUnitLifecycleError> {
    let saved = self.repository.set_lifecycle_status(unit, status).await?;
    self
      .record_change("organization.unit.status.update", actor, None, Some(&saved))
      .await;
    Ok(saved)
  }

  #[instrument(skip(self), fields(unit_id = %unit), err)]
  pub async fn deletion_preview(
    &self,
    unit: OrganizationUnitId,
  ) -> Result<OrganizationUnitDeletionPreview, OrganizationUnitLifecycleError> {
    self.repository.deletion_preview(unit).await.map_err(Into::into)
  }

  #[instrument(skip(self, confirmed_name, actor), fields(unit_id = %unit), err)]
  pub async fn delete_permanently(
    &self,
    unit: OrganizationUnitId,
    confirmed_name: &str,
    preview_revision: DateTime<Utc>,
    actor: AuditActor,
  ) -> Result<OrganizationUnit, OrganizationUnitLifecycleError> {
    let deleted = self
      .repository
      .delete_permanently(unit, confirmed_name, preview_revision)
      .await?;
    self
      .record_change("organization.unit.delete", actor, Some(&deleted), None)
      .await;
    Ok(deleted)
  }
}

fn safe_unit_snapshot(unit: &OrganizationUnit) -> serde_json::Value {
  serde_json::json!({
    "id": unit.id,
    "organization_id": unit.organization_id,
    "parent_unit_id": unit.parent_unit_id,
    "unit_type_id": unit.unit_type_id,
    "name": unit.name,
    "slug": unit.slug,
    "status": unit.status.as_str(),
    "updated_at": unit.updated_at,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn lifecycle_errors_expose_stable_codes() {
    let error = OrganizationUnitLifecycleError::from(RepositoryError::Conflict("ORGANIZATION_UNIT_IN_USE"));
    assert_eq!(error.code(), "ORGANIZATION_UNIT_IN_USE");

    for code in [
      "ORGANIZATION_UNIT_SLUG_CONFLICT",
      "ORGANIZATION_UNIT_CYCLE",
      "ORGANIZATION_UNIT_ROOT_NOT_ALLOWED",
    ] {
      assert_eq!(
        OrganizationUnitLifecycleError::from(RepositoryError::Conflict(code)).code(),
        code
      );
    }
  }

  #[test]
  fn status_machine_rejects_archived_to_disabled() {
    assert!(!OrganizationUnitStatus::Archived.can_transition_to(OrganizationUnitStatus::Disabled));
    assert!(OrganizationUnitStatus::Archived.can_transition_to(OrganizationUnitStatus::Active));
  }
}
