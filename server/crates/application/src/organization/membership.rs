// SPDX-License-Identifier: AGPL-3.0-or-later
//! Manual OU membership mutations and their committed capability/cache effects.

use crate::audit::{AuditActor, AuditCategory, AuditEvent, AuditRecorder, AuditTarget};
use async_trait::async_trait;
use myoxus_domain::entities::{OrganizationUnitMember, OrganizationUnitRole};
use myoxus_domain::ids::{OrganizationId, OrganizationUnitId, UserId};
use myoxus_domain::repositories::{RepoResult, RepositoryError};
use std::sync::Arc;

/// Preconditions are enforced inside the writer transaction, never by an
/// adapter's earlier lookup. Admin upsert/removal retain their idempotent forms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MembershipOperation {
  Add,
  SetRole,
  Upsert,
  RemoveExisting,
  Remove,
}

#[derive(Debug, Clone)]
pub struct MembershipChange {
  pub organization_id: Option<OrganizationId>,
  pub unit_id: OrganizationUnitId,
  pub user_id: UserId,
  pub operation: MembershipOperation,
  pub role: OrganizationUnitRole,
  pub metadata: serde_json::Value,
  /// Manager ingress must recheck policy, active scope and the target's prior
  /// role under the same transaction locks. None selects administrative ingress.
  pub manager_id: Option<UserId>,
}

#[derive(Debug, Clone)]
pub struct MembershipCommit {
  pub user_label: Option<String>,
  pub previous: Option<OrganizationUnitMember>,
  pub current: Option<OrganizationUnitMember>,
  /// Some(active) only when the persisted capability actually transitioned.
  pub manager_capability: Option<bool>,
}

#[async_trait]
pub trait OrganizationMembershipWriter: Send + Sync {
  async fn commit(&self, change: &MembershipChange) -> RepoResult<MembershipCommit>;
}

#[async_trait]
pub trait OrganizationMembershipEffects: Send + Sync {
  /// Invalidate the established feature-cache namespace and notify other API
  /// instances after commit. A failed effect cannot undo the known DB commit.
  async fn invalidate_features(&self, user: UserId);
}

#[derive(Clone)]
pub struct OrganizationMembershipService {
  writer: Arc<dyn OrganizationMembershipWriter>,
  effects: Arc<dyn OrganizationMembershipEffects>,
  audit: AuditRecorder,
}

impl OrganizationMembershipService {
  pub fn new(
    writer: Arc<dyn OrganizationMembershipWriter>,
    effects: Arc<dyn OrganizationMembershipEffects>,
    audit: AuditRecorder,
  ) -> Self {
    Self { writer, effects, audit }
  }

  #[tracing::instrument(skip_all, fields(unit_id = %change.unit_id, user_id = %change.user_id))]
  pub async fn apply(&self, change: MembershipChange, actor: AuditActor) -> Result<MembershipCommit, RepositoryError> {
    let commit = self.writer.commit(&change).await?;
    if commit.previous.is_none() && commit.current.is_none() {
      return Ok(commit);
    }
    if commit.manager_capability.is_some() {
      self.effects.invalidate_features(change.user_id).await;
    }
    let removing = matches!(
      change.operation,
      MembershipOperation::Remove | MembershipOperation::RemoveExisting
    );
    let event = match (change.manager_id.is_some(), removing) {
      (true, true) => "organization.member.remove_as_manager",
      (true, false) => "organization.member.add_as_manager",
      (false, true) => "organization.member.remove",
      (false, false) => "organization.member.assign",
    };
    self.audit.record(AuditEvent::mutation(event, AuditCategory::Organization,
      Some(AuditTarget::entity("organization_unit_member", change.unit_id, commit.user_label.clone().or_else(|| Some(change.user_id.to_string())))), actor.clone(),
      commit.previous.as_ref().map(|m| serde_json::json!({"role": m.role.as_str()})),
      Some(serde_json::json!({"unit_id": change.unit_id, "user_id": change.user_id, "role": commit.current.as_ref().map(|m| m.role.as_str())})))
      .with_unit(change.unit_id)).await;
    if let Some(active) = commit.manager_capability {
      self
        .audit
        .record(
          AuditEvent::mutation(
            if active {
              "user.feature.manager.implicit_set"
            } else {
              "user.feature.manager.implicit_revoke"
            },
            AuditCategory::User,
            Some(AuditTarget::entity("user", change.user_id, commit.user_label.clone())),
            actor,
            None,
            Some(serde_json::json!({"user_id": change.user_id, "unit_id": change.unit_id})),
          )
          .with_unit(change.unit_id),
        )
        .await;
    }
    Ok(commit)
  }
}
