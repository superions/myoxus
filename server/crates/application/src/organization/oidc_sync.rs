//! OIDC group-to-OU reconciliation.
//!
//! This service is the single application-layer owner of the Myoxus OIDC group
//! sync contract: configured provider groups may add, update or remove only
//! `source=oidc` organization-unit memberships. Manual, import, LDAP and SCIM
//! memberships are administrator-/external-system-owned and are never
//! overwritten here. The service deliberately does not create direct
//! `workspace_memberships`; workspace access continues to flow through the
//! existing OU permission model.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tracing::{debug, instrument, warn};

use myoxus_domain::entities::{
  OrganizationUnitMember, OrganizationUnitMemberSource, OrganizationUnitRole, OrganizationUnitStatus,
};
use myoxus_domain::ids::{OrganizationUnitId, UserId};
use myoxus_domain::repositories::{OrganizationUnitMemberRepository, OrganizationUnitRepository};

/// Maximum byte length accepted by the existing login group normalization.
/// This is a claim-value limit, not a directory-size or group-count limit.
pub const MAX_OIDC_GROUP_LENGTH: usize = 512;

/// Normalize a provider claim value identically for login and catalog choices.
/// Case and internal whitespace remain provider-owned; cosmetic slashes collapse.
pub fn normalize_group_name(raw: &str) -> Option<String> {
  let trimmed = raw.trim().trim_matches('/');
  if trimmed.is_empty() || trimmed.len() > MAX_OIDC_GROUP_LENGTH {
    return None;
  }

  // Keycloak often emits path-style groups (`/org/team`). Myoxus stores the
  // normalized path without a leading slash so mapping rules stay stable across
  // providers that disagree on the cosmetic prefix.
  let mut collapsed = String::with_capacity(trimmed.len());
  let mut previous_was_slash = false;
  for ch in trimmed.chars() {
    if ch == '/' {
      if !previous_was_slash {
        collapsed.push(ch);
      }
      previous_was_slash = true;
    } else {
      collapsed.push(ch);
      previous_was_slash = false;
    }
  }
  Some(collapsed)
}

/// Fail-closed policy for enabled OIDC group mapping when the provider response
/// does not contain the configured groups claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OidcMissingGroupsPolicy {
  DenyLogin,
  AllowWithoutMemberships,
}

/// Policy for provider groups that do not match any configured OU mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OidcUnknownGroupsPolicy {
  Ignore,
  DenyLogin,
}

/// One exact provider-group to organization-unit mapping rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcGroupMappingRule {
  pub provider_group: String,
  pub target_unit_id: OrganizationUnitId,
  pub role: Option<OrganizationUnitRole>,
}

/// Server-normalized OIDC group mapping contract consumed by the sync service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcGroupMapping {
  pub default_role: OrganizationUnitRole,
  pub remove_missing_oidc_memberships: bool,
  pub missing_groups_policy: OidcMissingGroupsPolicy,
  pub unknown_groups: OidcUnknownGroupsPolicy,
  pub mappings: Vec<OidcGroupMappingRule>,
}

/// Input for one login-time OIDC reconciliation run.
#[derive(Debug, Clone, Copy)]
pub struct OidcGroupSyncInput<'a> {
  pub user_id: UserId,
  pub provider: &'a str,
  pub provider_subject: &'a str,
  pub provider_groups: Option<&'a [String]>,
  pub mapping: &'a OidcGroupMapping,
}

/// Side-effect summary used by API wiring for redacted audit events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcGroupSyncEvent {
  pub action: OidcGroupSyncAction,
  pub unit_id: OrganizationUnitId,
  pub role: Option<OrganizationUnitRole>,
  pub previous_role: Option<OrganizationUnitRole>,
  pub source_conflict: Option<OrganizationUnitMemberSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OidcGroupSyncAction {
  Added,
  Updated,
  Removed,
  SkippedConflict,
  ManagerCapabilitySet,
  ManagerCapabilityRevoked,
}

/// Aggregate reconciliation result. Counts intentionally avoid raw group names.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct OidcGroupSyncReport {
  pub desired_memberships: usize,
  pub ignored_unmapped_groups: usize,
  pub events: Vec<OidcGroupSyncEvent>,
}

#[derive(Debug, Error)]
pub enum OidcGroupSyncError {
  #[error("OIDC groups claim is required for this provider")]
  GroupsClaimMissing,
  #[error("{0} OIDC groups are not mapped to organization units")]
  UnknownGroups(usize),
  #[error("OIDC group mapping target unit {0} does not exist")]
  TargetUnitMissing(OrganizationUnitId),
  #[error("OIDC group mapping target unit {0} is inactive")]
  TargetUnitInactive(OrganizationUnitId),
  #[error("OIDC group sync repository error: {0}")]
  Repository(String),
  #[error("OIDC manager capability update failed: {0}")]
  ManagerCapability(String),
}

/// Port for materializing the global manager capability when an OIDC mapping
/// grants or removes an OU `manager` role. The implementation lives in the API
/// crate because it must update `user_features` and invalidate API caches.
#[async_trait]
pub trait ManagerCapabilityWriter: Send + Sync {
  async fn ensure_manager_capability(&self, user_id: UserId) -> Result<bool, String>;
  async fn revoke_manager_capability_if_no_more(&self, user_id: UserId) -> Result<bool, String>;
}

#[derive(Clone)]
pub struct OidcGroupSyncService {
  units: Arc<dyn OrganizationUnitRepository>,
  members: Arc<dyn OrganizationUnitMemberRepository>,
  manager_capabilities: Arc<dyn ManagerCapabilityWriter>,
}

impl OidcGroupSyncService {
  pub fn new(
    units: Arc<dyn OrganizationUnitRepository>,
    members: Arc<dyn OrganizationUnitMemberRepository>,
    manager_capabilities: Arc<dyn ManagerCapabilityWriter>,
  ) -> Self {
    Self {
      units,
      members,
      manager_capabilities,
    }
  }

  /// Reconcile one user's OIDC provider groups into OU memberships.
  ///
  /// The function is idempotent. Re-running it with the same provider groups
  /// leaves the same `source=oidc` memberships and only emits events for actual
  /// additions, role changes, stale removals or protected-source conflicts.
  #[instrument(skip(self, input), fields(user_id = %input.user_id, provider = input.provider))]
  pub async fn reconcile(&self, input: OidcGroupSyncInput<'_>) -> Result<OidcGroupSyncReport, OidcGroupSyncError> {
    let Some(provider_groups) = input.provider_groups else {
      return match input.mapping.missing_groups_policy {
        OidcMissingGroupsPolicy::AllowWithoutMemberships => {
          warn!(
            user_id = %input.user_id,
            provider = input.provider,
            "oidc group mapping enabled but configured groups claim is missing; login allowed by policy"
          );
          Ok(OidcGroupSyncReport::default())
        }
        OidcMissingGroupsPolicy::DenyLogin => Err(OidcGroupSyncError::GroupsClaimMissing),
      };
    };

    let provider_group_set = provider_groups
      .iter()
      .map(|group| group.trim())
      .filter(|group| !group.is_empty())
      .collect::<HashSet<_>>();
    let rules_by_group = input
      .mapping
      .mappings
      .iter()
      .filter(|rule| !rule.provider_group.trim().is_empty())
      .map(|rule| (rule.provider_group.trim(), rule))
      .collect::<HashMap<_, _>>();

    let unknown_count = provider_group_set
      .iter()
      .filter(|group| !rules_by_group.contains_key(**group))
      .count();
    if unknown_count > 0 && input.mapping.unknown_groups == OidcUnknownGroupsPolicy::DenyLogin {
      return Err(OidcGroupSyncError::UnknownGroups(unknown_count));
    }

    let mut report = OidcGroupSyncReport {
      ignored_unmapped_groups: unknown_count,
      ..OidcGroupSyncReport::default()
    };
    let mut desired_units = HashSet::new();

    for group in &provider_group_set {
      let Some(rule) = rules_by_group.get(*group) else {
        debug!(user_id = %input.user_id, provider = input.provider, "ignoring unmapped OIDC group");
        continue;
      };

      let target_unit = self
        .units
        .get_by_id(rule.target_unit_id)
        .await
        .map_err(map_repo_error)?;
      let Some(target_unit) = target_unit else {
        return Err(OidcGroupSyncError::TargetUnitMissing(rule.target_unit_id));
      };
      if target_unit.status != OrganizationUnitStatus::Active {
        return Err(OidcGroupSyncError::TargetUnitInactive(rule.target_unit_id));
      }

      desired_units.insert(rule.target_unit_id);
      report.desired_memberships += 1;

      let previous = self
        .members
        .get(rule.target_unit_id, input.user_id)
        .await
        .map_err(map_repo_error)?;
      if let Some(existing) = previous.as_ref()
        && existing.source != OrganizationUnitMemberSource::Oidc
      {
        report.events.push(OidcGroupSyncEvent {
          action: OidcGroupSyncAction::SkippedConflict,
          unit_id: rule.target_unit_id,
          role: Some(existing.role),
          previous_role: Some(existing.role),
          source_conflict: Some(existing.source),
        });
        debug!(
          user_id = %input.user_id,
          unit_id = %rule.target_unit_id,
          source = existing.source.as_str(),
          "preserving non-OIDC OU membership during OIDC group sync"
        );
        continue;
      }

      let role = rule.role.unwrap_or(input.mapping.default_role);
      let now = Utc::now();
      let saved = self
        .members
        .upsert(&OrganizationUnitMember {
          unit_id: rule.target_unit_id,
          user_id: input.user_id,
          role,
          source: OrganizationUnitMemberSource::Oidc,
          metadata: oidc_member_metadata(input.provider, input.provider_subject, &rule.provider_group, now),
          created_at: now,
          updated_at: now,
        })
        .await
        .map_err(map_repo_error)?;

      let previous_role = previous.as_ref().map(|member| member.role);
      let changed = previous_role != Some(saved.role);
      if previous.is_none() || changed {
        report.events.push(OidcGroupSyncEvent {
          action: if previous.is_none() {
            OidcGroupSyncAction::Added
          } else {
            OidcGroupSyncAction::Updated
          },
          unit_id: saved.unit_id,
          role: Some(saved.role),
          previous_role,
          source_conflict: None,
        });
      }

      self
        .sync_manager_capability(
          input.user_id,
          saved.unit_id,
          previous_role,
          Some(saved.role),
          &mut report,
        )
        .await?;
    }

    if input.mapping.remove_missing_oidc_memberships {
      for member in self
        .members
        .list_for_user(input.user_id)
        .await
        .map_err(map_repo_error)?
      {
        if member.source == OrganizationUnitMemberSource::Oidc && !desired_units.contains(&member.unit_id) {
          self
            .members
            .remove(member.unit_id, input.user_id)
            .await
            .map_err(map_repo_error)?;
          report.events.push(OidcGroupSyncEvent {
            action: OidcGroupSyncAction::Removed,
            unit_id: member.unit_id,
            role: None,
            previous_role: Some(member.role),
            source_conflict: None,
          });
          self
            .sync_manager_capability(input.user_id, member.unit_id, Some(member.role), None, &mut report)
            .await?;
        }
      }
    }

    Ok(report)
  }

  async fn sync_manager_capability(
    &self,
    user_id: UserId,
    unit_id: OrganizationUnitId,
    previous_role: Option<OrganizationUnitRole>,
    next_role: Option<OrganizationUnitRole>,
    report: &mut OidcGroupSyncReport,
  ) -> Result<(), OidcGroupSyncError> {
    if next_role == Some(OrganizationUnitRole::Manager) {
      let transitioned = self
        .manager_capabilities
        .ensure_manager_capability(user_id)
        .await
        .map_err(OidcGroupSyncError::ManagerCapability)?;
      if transitioned {
        report.events.push(OidcGroupSyncEvent {
          action: OidcGroupSyncAction::ManagerCapabilitySet,
          unit_id,
          role: Some(OrganizationUnitRole::Manager),
          previous_role,
          source_conflict: None,
        });
      }
    } else if previous_role == Some(OrganizationUnitRole::Manager) {
      let transitioned = self
        .manager_capabilities
        .revoke_manager_capability_if_no_more(user_id)
        .await
        .map_err(OidcGroupSyncError::ManagerCapability)?;
      if transitioned {
        report.events.push(OidcGroupSyncEvent {
          action: OidcGroupSyncAction::ManagerCapabilityRevoked,
          unit_id,
          role: next_role,
          previous_role,
          source_conflict: None,
        });
      }
    }
    Ok(())
  }
}

fn map_repo_error(error: myoxus_domain::repositories::RepositoryError) -> OidcGroupSyncError {
  OidcGroupSyncError::Repository(error.to_string())
}

fn oidc_member_metadata(
  provider: &str,
  provider_subject: &str,
  provider_group: &str,
  synced_at: chrono::DateTime<Utc>,
) -> serde_json::Value {
  serde_json::json!({
    "source": "oidc",
    "provider": provider,
    "providerSubjectHash": stable_hash(provider_subject),
    "providerGroupHash": stable_hash(provider_group),
    "syncedAt": synced_at.to_rfc3339(),
  })
}

fn stable_hash(value: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(value.as_bytes());
  hex::encode(hasher.finalize())
}
