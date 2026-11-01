// SPDX-License-Identifier: AGPL-3.0-or-later
//! GraphQL surface for the Organization domain (package D).
//!
//! Provides both the Admin surface (`AdminRoot.organization*`) and the
//! caller- and manager-scoped organization surface.
//!
//! Concept: `todo/organization-management-concept.md`
//! Contract: `docs/dev/server/organization-management.md`, GraphQL target contract

use std::sync::Arc;

use async_graphql::{Context, Enum, ID, InputObject, Object, Result, SimpleObject};
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

use myoxus_application::auth::AuthError;
use myoxus_application::organization::{MembershipChange, MembershipOperation, ProjectCreationDecision};
use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
use myoxus_domain::entities::{
  Organization, OrganizationPolicy, OrganizationProjectRequest, OrganizationUnit, OrganizationUnitMember,
  OrganizationUnitMemberSource, OrganizationUnitRole, OrganizationUnitStatus, OrganizationUnitType,
  OrganizationUnitWorkspace, OrganizationUnitWorkspaceRelationship, PolicyState, ProjectRequestScope,
  ProjectRequestStatus,
};
use myoxus_domain::repositories::RepositoryError;

use crate::graphql::admin::resolve_audit_actor;
use crate::graphql::organization_lifecycle::{OrganizationUnitDeletionPreviewType, map_lifecycle_error};
use crate::graphql::utils::{map_gql_error, require_session};
use crate::state::ApiState;

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL Types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(SimpleObject, Clone)]
pub struct OrganizationType {
  pub id: ID,
  pub key: String,
  pub name: String,
  pub slug: String,
  /// Frei-Form-Metadaten (avatar_key, etc.).
  pub metadata: JsonValue,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

impl From<Organization> for OrganizationType {
  fn from(o: Organization) -> Self {
    Self {
      id: ID(o.id.to_string()),
      key: o.key,
      name: o.name,
      slug: o.slug,
      metadata: o.metadata,
      created_at: o.created_at,
      updated_at: o.updated_at,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(rename_items = "PascalCase")]
pub enum OrganizationUnitStatusEnum {
  Active,
  Disabled,
  Archived,
}

impl From<OrganizationUnitStatus> for OrganizationUnitStatusEnum {
  fn from(s: OrganizationUnitStatus) -> Self {
    match s {
      OrganizationUnitStatus::Active => Self::Active,
      OrganizationUnitStatus::Disabled => Self::Disabled,
      OrganizationUnitStatus::Archived => Self::Archived,
    }
  }
}

impl From<OrganizationUnitStatusEnum> for OrganizationUnitStatus {
  fn from(s: OrganizationUnitStatusEnum) -> Self {
    match s {
      OrganizationUnitStatusEnum::Active => Self::Active,
      OrganizationUnitStatusEnum::Disabled => Self::Disabled,
      OrganizationUnitStatusEnum::Archived => Self::Archived,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(rename_items = "PascalCase")]
pub enum OrganizationUnitRoleEnum {
  Reader,
  Member,
  Manager,
}

impl From<OrganizationUnitRole> for OrganizationUnitRoleEnum {
  fn from(r: OrganizationUnitRole) -> Self {
    match r {
      OrganizationUnitRole::Reader => Self::Reader,
      OrganizationUnitRole::Member => Self::Member,
      OrganizationUnitRole::Manager => Self::Manager,
    }
  }
}

impl From<OrganizationUnitRoleEnum> for OrganizationUnitRole {
  fn from(r: OrganizationUnitRoleEnum) -> Self {
    match r {
      OrganizationUnitRoleEnum::Reader => Self::Reader,
      OrganizationUnitRoleEnum::Member => Self::Member,
      OrganizationUnitRoleEnum::Manager => Self::Manager,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(rename_items = "PascalCase")]
pub enum OrganizationUnitMemberSourceEnum {
  Manual,
  Import,
  Oidc,
  Ldap,
  Scim,
}

impl From<OrganizationUnitMemberSource> for OrganizationUnitMemberSourceEnum {
  fn from(s: OrganizationUnitMemberSource) -> Self {
    match s {
      OrganizationUnitMemberSource::Manual => Self::Manual,
      OrganizationUnitMemberSource::Import => Self::Import,
      OrganizationUnitMemberSource::Oidc => Self::Oidc,
      OrganizationUnitMemberSource::Ldap => Self::Ldap,
      OrganizationUnitMemberSource::Scim => Self::Scim,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(rename_items = "PascalCase")]
pub enum OrganizationUnitWorkspaceRelationshipEnum {
  Owner,
  Managed,
  Linked,
}

impl From<OrganizationUnitWorkspaceRelationship> for OrganizationUnitWorkspaceRelationshipEnum {
  fn from(r: OrganizationUnitWorkspaceRelationship) -> Self {
    match r {
      OrganizationUnitWorkspaceRelationship::Owner => Self::Owner,
      OrganizationUnitWorkspaceRelationship::Managed => Self::Managed,
      OrganizationUnitWorkspaceRelationship::Linked => Self::Linked,
    }
  }
}

impl From<OrganizationUnitWorkspaceRelationshipEnum> for OrganizationUnitWorkspaceRelationship {
  fn from(r: OrganizationUnitWorkspaceRelationshipEnum) -> Self {
    match r {
      OrganizationUnitWorkspaceRelationshipEnum::Owner => Self::Owner,
      OrganizationUnitWorkspaceRelationshipEnum::Managed => Self::Managed,
      OrganizationUnitWorkspaceRelationshipEnum::Linked => Self::Linked,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(rename_items = "PascalCase")]
pub enum PolicyStateEnum {
  Disabled,
  RequiresApproval,
  Allowed,
}

impl From<PolicyState> for PolicyStateEnum {
  fn from(p: PolicyState) -> Self {
    match p {
      PolicyState::Disabled => Self::Disabled,
      PolicyState::RequiresApproval => Self::RequiresApproval,
      PolicyState::Allowed => Self::Allowed,
    }
  }
}

impl From<PolicyStateEnum> for PolicyState {
  fn from(p: PolicyStateEnum) -> Self {
    match p {
      PolicyStateEnum::Disabled => Self::Disabled,
      PolicyStateEnum::RequiresApproval => Self::RequiresApproval,
      PolicyStateEnum::Allowed => Self::Allowed,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(rename_items = "PascalCase")]
pub enum ProjectRequestScopeEnum {
  OrganizationRoot,
  Ou,
}

impl From<ProjectRequestScope> for ProjectRequestScopeEnum {
  fn from(s: ProjectRequestScope) -> Self {
    match s {
      ProjectRequestScope::OrganizationRoot => Self::OrganizationRoot,
      ProjectRequestScope::Ou => Self::Ou,
    }
  }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(rename_items = "PascalCase")]
pub enum ProjectRequestStatusEnum {
  Pending,
  Approved,
  Rejected,
  Cancelled,
}

impl From<ProjectRequestStatus> for ProjectRequestStatusEnum {
  fn from(s: ProjectRequestStatus) -> Self {
    match s {
      ProjectRequestStatus::Pending => Self::Pending,
      ProjectRequestStatus::Approved => Self::Approved,
      ProjectRequestStatus::Rejected => Self::Rejected,
      ProjectRequestStatus::Cancelled => Self::Cancelled,
    }
  }
}

impl From<ProjectRequestStatusEnum> for ProjectRequestStatus {
  fn from(s: ProjectRequestStatusEnum) -> Self {
    match s {
      ProjectRequestStatusEnum::Pending => Self::Pending,
      ProjectRequestStatusEnum::Approved => Self::Approved,
      ProjectRequestStatusEnum::Rejected => Self::Rejected,
      ProjectRequestStatusEnum::Cancelled => Self::Cancelled,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct OrganizationUnitTypeType {
  pub id: ID,
  pub organization_id: ID,
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub icon: Option<String>,
  pub color: Option<String>,
  pub is_preset: bool,
  pub is_active: bool,
  pub is_structural: bool,
  pub can_have_children: bool,
  pub can_be_root_level: bool,
  pub can_be_manager_created: bool,
  pub can_have_cross_unit_members: bool,
  pub can_own_workspaces: bool,
  pub can_manage_workspaces: bool,
  pub is_staff_unit: bool,
  pub requires_admin_approval: bool,
  pub metadata: JsonValue,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

impl From<OrganizationUnitType> for OrganizationUnitTypeType {
  fn from(t: OrganizationUnitType) -> Self {
    Self {
      id: ID(t.id.to_string()),
      organization_id: ID(t.organization_id.to_string()),
      key: t.key,
      label: t.label,
      description: t.description,
      icon: t.icon,
      color: t.color,
      is_preset: t.is_preset,
      is_active: t.is_active,
      is_structural: t.is_structural,
      can_have_children: t.can_have_children,
      can_be_root_level: t.can_be_root_level,
      can_be_manager_created: t.can_be_manager_created,
      can_have_cross_unit_members: t.can_have_cross_unit_members,
      can_own_workspaces: t.can_own_workspaces,
      can_manage_workspaces: t.can_manage_workspaces,
      is_staff_unit: t.is_staff_unit,
      requires_admin_approval: t.requires_admin_approval,
      metadata: t.metadata,
      created_at: t.created_at,
      updated_at: t.updated_at,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct OrganizationUnitTypeOutput {
  pub id: ID,
  pub organization_id: ID,
  pub parent_unit_id: Option<ID>,
  pub unit_type_id: ID,
  pub name: String,
  pub slug: String,
  pub description: Option<String>,
  pub status: OrganizationUnitStatusEnum,
  pub max_members: i32,
  pub metadata: JsonValue,
  pub created_by: Option<ID>,
  /// Direct child OUs. Computed in the repository list query so tree UIs do
  /// not need per-node GraphQL follow-up requests.
  pub child_unit_count: i64,
  /// Direct members of this OU.
  pub member_count: i64,
  /// Workspace relationships attached to this OU.
  pub workspace_count: i64,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

impl From<OrganizationUnit> for OrganizationUnitTypeOutput {
  fn from(u: OrganizationUnit) -> Self {
    Self {
      id: ID(u.id.to_string()),
      organization_id: ID(u.organization_id.to_string()),
      parent_unit_id: u.parent_unit_id.map(|p| ID(p.to_string())),
      unit_type_id: ID(u.unit_type_id.to_string()),
      name: u.name,
      slug: u.slug,
      description: u.description,
      status: u.status.into(),
      max_members: u.max_members,
      metadata: u.metadata,
      created_by: u.created_by.map(|c| ID(c.to_string())),
      child_unit_count: u.child_unit_count,
      member_count: u.member_count,
      workspace_count: u.workspace_count,
      created_at: u.created_at,
      updated_at: u.updated_at,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct OrganizationUnitMemberType {
  pub unit_id: ID,
  pub user_id: ID,
  pub user_email: Option<String>,
  pub user_name: Option<String>,
  pub user_avatar_url: Option<String>,
  pub role: OrganizationUnitRoleEnum,
  pub source: OrganizationUnitMemberSourceEnum,
  pub metadata: JsonValue,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

impl From<OrganizationUnitMember> for OrganizationUnitMemberType {
  fn from(m: OrganizationUnitMember) -> Self {
    Self {
      unit_id: ID(m.unit_id.to_string()),
      user_id: ID(m.user_id.to_string()),
      user_email: None,
      user_name: None,
      user_avatar_url: None,
      role: m.role.into(),
      source: m.source.into(),
      metadata: m.metadata,
      created_at: m.created_at,
      updated_at: m.updated_at,
    }
  }
}

fn member_with_profile(row: myoxus_application::organization::OrganizationMemberProfile) -> OrganizationUnitMemberType {
  let mut output = OrganizationUnitMemberType::from(row.membership);
  output.user_email = row.email;
  output.user_name = row.name;
  output.user_avatar_url = row.avatar_url;
  output
}

#[derive(SimpleObject, Clone)]
pub struct OrganizationUnitWorkspaceType {
  pub unit_id: ID,
  pub unit_name: Option<String>,
  pub unit_slug: Option<String>,
  pub workspace_id: ID,
  pub workspace_name: Option<String>,
  pub owner_user_id: Option<ID>,
  pub owner_email: Option<String>,
  pub relationship: OrganizationUnitWorkspaceRelationshipEnum,
  /// Current workspace storage usage in bytes, if quota storage stats are
  /// available on this server.
  pub storage_used_bytes: Option<i64>,
  /// Effective workspace quota in bytes.
  pub effective_quota_bytes: Option<i64>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

impl From<OrganizationUnitWorkspace> for OrganizationUnitWorkspaceType {
  fn from(w: OrganizationUnitWorkspace) -> Self {
    Self {
      unit_id: ID(w.unit_id.to_string()),
      unit_name: None,
      unit_slug: None,
      workspace_id: ID(w.workspace_id.to_string()),
      workspace_name: None,
      owner_user_id: None,
      owner_email: None,
      relationship: w.relationship.into(),
      storage_used_bytes: None,
      effective_quota_bytes: None,
      created_at: w.created_at,
      updated_at: w.updated_at,
    }
  }
}

async fn hydrate_organization_unit_workspace_rows(
  state: &ApiState,
  rows: Vec<OrganizationUnitWorkspace>,
  unit_snapshots: std::collections::HashMap<Uuid, (String, String)>,
) -> Result<Vec<OrganizationUnitWorkspaceType>> {
  // The admin frontend renders both OU-centric and workspace-centric views.
  // Hydrating here keeps both clients on one server contract instead of
  // forcing fragile N+1 workspace/owner/quota lookups into the UI.
  let mut workspace_snapshots: std::collections::HashMap<Uuid, (Option<String>, Option<Uuid>)> =
    std::collections::HashMap::with_capacity(rows.len());
  let mut owner_ids: Vec<Uuid> = Vec::new();
  for row in &rows {
    match state.workspace().get_workspace(row.workspace_id).await {
      Ok(Some(workspace)) => {
        if let Some(owner_id) = workspace.owner_user_id {
          owner_ids.push(owner_id);
        }
        workspace_snapshots.insert(row.workspace_id, (Some(workspace.name), workspace.owner_user_id));
      }
      Ok(None) => {
        debug!(
          unit_id = %row.unit_id,
          workspace_id = %row.workspace_id,
          "organizationUnitWorkspaces: linked workspace row no longer exists"
        );
        workspace_snapshots.insert(row.workspace_id, (None, None));
      }
      Err(err) => return Err(map_gql_error(err)),
    }
  }

  owner_ids.sort_unstable();
  owner_ids.dedup();
  let users = state
    .auth()
    .store
    .get_users_by_ids(&owner_ids)
    .await
    .map_err(map_gql_error)?;
  let metrics_pool = state.metrics_pool();

  let mut out = Vec::with_capacity(rows.len());
  for row in rows {
    let (workspace_name, owner_user_id) = workspace_snapshots.remove(&row.workspace_id).unwrap_or((None, None));
    let (unit_name, unit_slug) = unit_snapshots
      .get(&row.unit_id)
      .map(|(name, slug)| (Some(name.clone()), Some(slug.clone())))
      .unwrap_or((None, None));
    let owner_email = owner_user_id
      .as_ref()
      .and_then(|owner_id| users.get(owner_id))
      .map(|user| user.email.clone());
    let quota_snapshot = match metrics_pool.as_ref() {
      Some(pool) => {
        myoxus_infrastructure::quota_resolver::resolve_workspace_quota_full(
          pool,
          row.workspace_id,
          state.config.storage.default_workspace_quota_mb,
        )
        .await
      }
      None => None,
    };
    let storage_used_bytes = quota_snapshot.as_ref().map(|snapshot| snapshot.used_bytes());
    let effective_quota_bytes = quota_snapshot.as_ref().map(|snapshot| snapshot.effective_bytes);

    out.push(OrganizationUnitWorkspaceType {
      unit_id: ID(row.unit_id.to_string()),
      unit_name,
      unit_slug,
      workspace_id: ID(row.workspace_id.to_string()),
      workspace_name,
      owner_user_id: owner_user_id.map(|owner| ID(owner.to_string())),
      owner_email,
      relationship: row.relationship.into(),
      storage_used_bytes,
      effective_quota_bytes,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }

  Ok(out)
}

#[derive(SimpleObject, Clone)]
pub struct OrganizationPolicyType {
  pub organization_id: ID,
  pub manager_root_project_creation: PolicyStateEnum,
  pub manager_unit_project_creation: PolicyStateEnum,
  pub manager_can_create_workspaces: bool,
  pub manager_can_manage_ou_members: bool,
  pub import_export_enabled: bool,
  pub metadata: JsonValue,
  pub updated_by: Option<ID>,
  pub updated_at: DateTime<Utc>,
}

impl From<OrganizationPolicy> for OrganizationPolicyType {
  fn from(p: OrganizationPolicy) -> Self {
    Self {
      organization_id: ID(p.organization_id.to_string()),
      manager_root_project_creation: p.manager_root_project_creation.into(),
      manager_unit_project_creation: p.manager_unit_project_creation.into(),
      manager_can_create_workspaces: p.manager_can_create_workspaces,
      manager_can_manage_ou_members: p.manager_can_manage_ou_members,
      import_export_enabled: p.import_export_enabled,
      metadata: p.metadata,
      updated_by: p.updated_by.map(|u| ID(u.to_string())),
      updated_at: p.updated_at,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct OrganizationProjectRequestType {
  pub id: ID,
  pub organization_id: ID,
  pub requested_by: ID,
  pub requested_scope: ProjectRequestScopeEnum,
  pub parent_unit_id: Option<ID>,
  pub proposed_name: String,
  pub proposed_type_id: Option<ID>,
  pub proposed_members: Vec<ID>,
  pub proposed_workspace: bool,
  pub status: ProjectRequestStatusEnum,
  pub decided_by: Option<ID>,
  pub decided_at: Option<DateTime<Utc>>,
  pub metadata: JsonValue,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

impl From<OrganizationProjectRequest> for OrganizationProjectRequestType {
  fn from(r: OrganizationProjectRequest) -> Self {
    Self {
      id: ID(r.id.to_string()),
      organization_id: ID(r.organization_id.to_string()),
      requested_by: ID(r.requested_by.to_string()),
      requested_scope: r.requested_scope.into(),
      parent_unit_id: r.parent_unit_id.map(|p| ID(p.to_string())),
      proposed_name: r.proposed_name,
      proposed_type_id: r.proposed_type_id.map(|t| ID(t.to_string())),
      proposed_members: r.proposed_members.into_iter().map(|m| ID(m.to_string())).collect(),
      proposed_workspace: r.proposed_workspace,
      status: r.status.into(),
      decided_by: r.decided_by.map(|u| ID(u.to_string())),
      decided_at: r.decided_at,
      metadata: r.metadata,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) async fn require_admin(ctx: &Context<'_>) -> Result<(Arc<ApiState>, Uuid)> {
  let (state, snapshot) = require_session(ctx).await?;
  if !snapshot.user.is_admin {
    warn!(user_id = %snapshot.user.id, "non-admin tried to access organization admin surface");
    return Err(map_gql_error(AuthError::ActionForbidden));
  }
  Ok((state, snapshot.user.id))
}

fn map_repo_err(err: RepositoryError) -> async_graphql::Error {
  match err {
    RepositoryError::NotFound(what) => async_graphql::Error::new(format!("{what} not found")),
    RepositoryError::Conflict("ORGANIZATION_MEMBERSHIP_ACTION_FORBIDDEN") => map_gql_error(AuthError::ActionForbidden),
    RepositoryError::Conflict(what) => async_graphql::Error::new(format!("conflict: {what}")),
    RepositoryError::Validation(msg) => async_graphql::Error::new(msg),
    RepositoryError::Storage(msg) => async_graphql::Error::new(msg),
  }
}

fn parse_id<T>(id: &ID, name: &str) -> Result<T>
where
  T: std::str::FromStr,
{
  id.as_str()
    .parse::<T>()
    .map_err(|_| async_graphql::Error::new(format!("invalid {name} id")))
}

/// Search-result row for `searchOrganizationUnits` (P-AR-0-S01). Returns
/// only the fields the OuPicker UI needs — full OU details remain reserved
/// for the admin/manager-scoped detail queries.
#[derive(SimpleObject, Clone)]
pub struct OrganizationUnitSearchResult {
  pub id: ID,
  pub name: String,
  pub slug: String,
  /// Ancestor names from the topmost ancestor down to (but excluding)
  /// the unit itself. Empty for root-level OUs. Computed server-side via
  /// a 32-hop walk over `parent_unit_id`.
  pub parent_breadcrumb: Vec<String>,
}

/// Search-result row for `managerSearchUsers` (P-AR-0-S02). Manager-mode
/// deliberately does NOT expose `is_admin` / `disabled` — managers must
/// not learn the admin-status or the account-status of other users.
#[derive(SimpleObject, Clone)]
pub struct ManagerUserSearchResult {
  pub id: ID,
  pub email: String,
  pub name: String,
  /// Activated user features (e.g. `manager`). Surfaced so the picker can
  /// show role-badges in the dropdown.
  pub features: Vec<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Public Query/Mutation API
// ─────────────────────────────────────────────────────────────────────────────

pub struct OrganizationQueryRoot;

#[Object]
impl OrganizationQueryRoot {
  /// The single organisation row of this installation. Single-tenant
  /// returns `key='myoxus'`. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn organization(&self, ctx: &Context<'_>) -> Result<OrganizationType> {
    let (state, _) = require_admin(ctx).await?;
    let org = state
      .organization_reads()
      .ok_or_else(|| async_graphql::Error::new("organization reads not configured"))?
      .default_organization()
      .await
      .map_err(map_repo_err)?;
    Ok(org.into())
  }

  /// All organisation units, optionally filtered by status. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn organization_units(
    &self,
    ctx: &Context<'_>,
    status: Option<OrganizationUnitStatusEnum>,
  ) -> Result<Vec<OrganizationUnitTypeOutput>> {
    let (state, _) = require_admin(ctx).await?;
    let org_repo = state
      .organization_repo()
      .ok_or_else(|| async_graphql::Error::new("organization repo not configured"))?;
    let units_repo = state
      .organization_unit_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit repo not configured"))?;
    let org = org_repo
      .get_by_key("myoxus")
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("default organization missing"))?;
    let units = units_repo
      .list(org.id, status.map(|s| s.into()))
      .await
      .map_err(map_repo_err)?;
    Ok(units.into_iter().map(Into::into).collect())
  }

  /// Single OU. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn organization_unit(&self, ctx: &Context<'_>, id: ID) -> Result<Option<OrganizationUnitTypeOutput>> {
    let (state, _) = require_admin(ctx).await?;
    let units_repo = state
      .organization_unit_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit repo not configured"))?;
    let uid = parse_id::<Uuid>(&id, "organization_unit")?;
    let unit = units_repo.get_by_id(uid).await.map_err(map_repo_err)?;
    Ok(unit.map(Into::into))
  }

  /// All OU-types, optionally including inactive. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn organization_unit_types(
    &self,
    ctx: &Context<'_>,
    include_inactive: Option<bool>,
  ) -> Result<Vec<OrganizationUnitTypeType>> {
    let (state, _) = require_admin(ctx).await?;
    let types = state
      .organization_reads()
      .ok_or_else(|| async_graphql::Error::new("organization reads not configured"))?
      .unit_types(include_inactive.unwrap_or(false))
      .await
      .map_err(map_repo_err)?;
    Ok(types.into_iter().map(Into::into).collect())
  }

  /// Members of an OU. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn organization_unit_members(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
    role: Option<OrganizationUnitRoleEnum>,
  ) -> Result<Vec<OrganizationUnitMemberType>> {
    let (state, _) = require_admin(ctx).await?;
    let uid = parse_id::<Uuid>(&unit_id, "organization_unit")?;
    let rows = state
      .organization_reads()
      .ok_or_else(|| async_graphql::Error::new("organization reads not configured"))?
      .unit_members(uid, role.map(Into::into))
      .await
      .map_err(map_repo_err)?;
    Ok(rows.into_iter().map(member_with_profile).collect())
  }

  /// Workspace links of an OU. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn organization_unit_workspaces(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
  ) -> Result<Vec<OrganizationUnitWorkspaceType>> {
    let (state, _) = require_admin(ctx).await?;
    let links = state
      .organization_unit_workspace_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit_workspace repo not configured"))?;
    let units_repo = state
      .organization_unit_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit repo not configured"))?;
    let uid = parse_id::<Uuid>(&unit_id, "organization_unit")?;
    let rows = links.list_for_unit(uid).await.map_err(map_repo_err)?;

    let mut unit_snapshots = std::collections::HashMap::new();
    if let Some(unit) = units_repo.get_by_id(uid).await.map_err(map_repo_err)? {
      unit_snapshots.insert(uid, (unit.name, unit.slug));
    }

    hydrate_organization_unit_workspace_rows(state.as_ref(), rows, unit_snapshots).await
  }

  /// All OU links of one workspace. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn workspace_organization_unit_workspaces(
    &self,
    ctx: &Context<'_>,
    workspace_id: ID,
  ) -> Result<Vec<OrganizationUnitWorkspaceType>> {
    let (state, _) = require_admin(ctx).await?;
    let links = state
      .organization_unit_workspace_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit_workspace repo not configured"))?;
    let units_repo = state
      .organization_unit_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit repo not configured"))?;
    let wid = parse_id::<Uuid>(&workspace_id, "workspace")?;
    let rows = links.list_for_workspace(wid).await.map_err(map_repo_err)?;

    let mut unit_snapshots = std::collections::HashMap::with_capacity(rows.len());
    for row in &rows {
      if unit_snapshots.contains_key(&row.unit_id) {
        continue;
      }
      if let Some(unit) = units_repo.get_by_id(row.unit_id).await.map_err(map_repo_err)? {
        unit_snapshots.insert(row.unit_id, (unit.name, unit.slug));
      } else {
        debug!(
          workspace_id = %wid,
          unit_id = %row.unit_id,
          "workspaceOrganizationUnitWorkspaces: linked OU row no longer exists"
        );
      }
    }

    hydrate_organization_unit_workspace_rows(state.as_ref(), rows, unit_snapshots).await
  }

  /// Organisation policies. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn organization_policy(&self, ctx: &Context<'_>) -> Result<OrganizationPolicyType> {
    let (state, _) = require_admin(ctx).await?;
    let policies = state
      .organization_policy_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_policy repo not configured"))?;
    let org_repo = state
      .organization_repo()
      .ok_or_else(|| async_graphql::Error::new("organization repo not configured"))?;
    let org = org_repo
      .get_by_key("myoxus")
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("default organization missing"))?;
    let policy = policies.get(org.id).await.map_err(map_repo_err)?;
    Ok(policy.into())
  }

  /// Project requests. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn organization_project_requests(
    &self,
    ctx: &Context<'_>,
    status: Option<ProjectRequestStatusEnum>,
  ) -> Result<Vec<OrganizationProjectRequestType>> {
    let (state, _) = require_admin(ctx).await?;
    let requests = state
      .organization_project_request_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_project_request repo not configured"))?;
    let org_repo = state
      .organization_repo()
      .ok_or_else(|| async_graphql::Error::new("organization repo not configured"))?;
    let org = org_repo
      .get_by_key("myoxus")
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("default organization missing"))?;
    let rows = requests
      .list(org.id, status.map(|s| s.into()))
      .await
      .map_err(map_repo_err)?;
    Ok(rows.into_iter().map(Into::into).collect())
  }

  /// OUs in which the caller is a member (any role). Manager-scope view.
  #[instrument(skip(self, ctx))]
  pub async fn my_organization_units(&self, ctx: &Context<'_>) -> Result<Vec<OrganizationUnitTypeOutput>> {
    let (state, snapshot) = require_session(ctx).await?;
    let units_repo = state
      .organization_unit_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit repo not configured"))?;
    let units = units_repo.list_for_user(snapshot.user.id).await.map_err(map_repo_err)?;
    Ok(units.into_iter().map(Into::into).collect())
  }
}

// ─── Mutations ──────────────────────────────────────────────────────────────

#[derive(InputObject, Debug)]
pub struct UpdateOrganizationInput {
  pub name: Option<String>,
  pub slug: Option<String>,
  pub metadata: Option<JsonValue>,
}

#[derive(InputObject, Debug)]
pub struct UpsertOrganizationUnitTypeInput {
  /// Either `null` (insert) or an existing UUID (update).
  pub id: Option<ID>,
  pub key: String,
  pub label: String,
  pub description: Option<String>,
  pub icon: Option<String>,
  pub color: Option<String>,
  pub is_active: Option<bool>,
  pub is_structural: bool,
  pub can_have_children: bool,
  pub can_be_root_level: bool,
  pub can_be_manager_created: bool,
  pub can_have_cross_unit_members: bool,
  pub can_own_workspaces: bool,
  pub can_manage_workspaces: bool,
  pub is_staff_unit: Option<bool>,
  pub requires_admin_approval: Option<bool>,
  pub metadata: Option<JsonValue>,
}

#[derive(InputObject, Debug)]
pub struct UpsertOrganizationUnitInput {
  pub id: Option<ID>,
  pub parent_unit_id: Option<ID>,
  pub unit_type_id: ID,
  pub name: String,
  pub slug: String,
  pub description: Option<String>,
  pub status: Option<OrganizationUnitStatusEnum>,
  pub max_members: Option<i32>,
  pub metadata: Option<JsonValue>,
}

#[derive(InputObject, Debug)]
pub struct UpdateOrganizationPolicyInput {
  pub manager_root_project_creation: Option<PolicyStateEnum>,
  pub manager_unit_project_creation: Option<PolicyStateEnum>,
  pub manager_can_create_workspaces: Option<bool>,
  pub manager_can_manage_ou_members: Option<bool>,
  pub import_export_enabled: Option<bool>,
}

#[derive(InputObject, Debug)]
pub struct AssignOrganizationManagerInput {
  pub unit_id: ID,
  pub user_id: ID,
  pub role: OrganizationUnitRoleEnum,
}

#[derive(InputObject, Debug)]
pub struct AssignOrganizationUnitWorkspaceInput {
  pub unit_id: ID,
  pub workspace_id: ID,
  pub relationship: OrganizationUnitWorkspaceRelationshipEnum,
}

pub struct OrganizationMutationRoot;

#[Object]
impl OrganizationMutationRoot {
  /// Update organisation metadata. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn update_organization(
    &self,
    ctx: &Context<'_>,
    input: UpdateOrganizationInput,
  ) -> Result<OrganizationType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let repo = state
      .organization_repo()
      .ok_or_else(|| async_graphql::Error::new("organization repo not configured"))?;
    let current = repo
      .get_by_key("myoxus")
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("default organization missing"))?;
    let updated = repo
      .update(
        current.id,
        input.name.as_deref().unwrap_or(&current.name),
        input.slug.as_deref().unwrap_or(&current.slug),
        input.metadata.as_ref().unwrap_or(&current.metadata),
      )
      .await
      .map_err(map_repo_err)?;
    let actor = resolve_audit_actor(ctx).await;
    state
      .audit_recorder()
      .record(AuditEvent::mutation(
        "organization.update",
        AuditCategory::Organization,
        Some(AuditTarget::entity(
          "organization",
          current.id,
          Some(current.key.clone()),
        )),
        actor,
        None,
        Some(serde_json::json!({"organization_id": current.id.to_string()})),
      ))
      .await;
    info!(admin_id = %admin_id, organization_id = %current.id, "organization metadata updated");
    Ok(updated.into())
  }

  /// Upsert a unit type (insert or update by id). Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn upsert_organization_unit_type(
    &self,
    ctx: &Context<'_>,
    input: UpsertOrganizationUnitTypeInput,
  ) -> Result<OrganizationUnitTypeType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let org_repo = state
      .organization_repo()
      .ok_or_else(|| async_graphql::Error::new("organization repo not configured"))?;
    let types_repo = state
      .organization_unit_type_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit_type repo not configured"))?;
    let org = org_repo
      .get_by_key("myoxus")
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("default organization missing"))?;

    let id = match &input.id {
      Some(id) => parse_id::<Uuid>(id, "organization_unit_type")?,
      None => Uuid::new_v4(),
    };

    let now = Utc::now();
    let row = OrganizationUnitType {
      id,
      organization_id: org.id,
      key: input.key,
      label: input.label,
      description: input.description,
      icon: input.icon,
      color: input.color,
      is_preset: false,
      is_active: input.is_active.unwrap_or(true),
      is_structural: input.is_structural,
      can_have_children: input.can_have_children,
      can_be_root_level: input.can_be_root_level,
      can_be_manager_created: input.can_be_manager_created,
      can_have_cross_unit_members: input.can_have_cross_unit_members,
      can_own_workspaces: input.can_own_workspaces,
      can_manage_workspaces: input.can_manage_workspaces,
      is_staff_unit: input.is_staff_unit.unwrap_or(false),
      requires_admin_approval: input.requires_admin_approval.unwrap_or(false),
      metadata: input.metadata.unwrap_or(serde_json::json!({})),
      created_at: now,
      updated_at: now,
    };
    let saved = types_repo.upsert(&row).await.map_err(map_repo_err)?;

    let actor = resolve_audit_actor(ctx).await;
    state
      .audit_recorder()
      .record(AuditEvent::mutation(
        "organization.unit_type.upsert",
        AuditCategory::Organization,
        Some(AuditTarget::entity(
          "organization_unit_type",
          saved.id,
          Some(saved.key.clone()),
        )),
        actor,
        None,
        Some(serde_json::json!({"organization_id": org.id.to_string()})),
      ))
      .await;
    info!(admin_id = %admin_id, type_id = %saved.id, "organization_unit_type upserted");
    Ok(saved.into())
  }

  /// Soft-disable a unit type. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn deactivate_organization_unit_type(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    let (state, admin_id) = require_admin(ctx).await?;
    let types_repo = state
      .organization_unit_type_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit_type repo not configured"))?;
    let uid = parse_id::<Uuid>(&id, "organization_unit_type")?;
    types_repo.deactivate(uid).await.map_err(map_repo_err)?;
    info!(admin_id = %admin_id, type_id = %uid, "unit type deactivated");
    Ok(true)
  }

  /// Upsert an organisation unit (insert or update by id). Admin-only.
  /// The repository enforces cycle detection for `parent_unit_id`.
  #[instrument(skip(self, ctx))]
  pub async fn upsert_organization_unit(
    &self,
    ctx: &Context<'_>,
    input: UpsertOrganizationUnitInput,
  ) -> Result<OrganizationUnitTypeOutput> {
    let (state, admin_id) = require_admin(ctx).await?;
    let org_repo = state
      .organization_repo()
      .ok_or_else(|| async_graphql::Error::new("organization repo not configured"))?;
    let units_repo = state
      .organization_unit_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit repo not configured"))?;
    let lifecycle = state
      .organization_unit_lifecycle_service()
      .ok_or_else(|| async_graphql::Error::new("organization unit lifecycle service not configured"))?;
    let org = org_repo
      .get_by_key("myoxus")
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("default organization missing"))?;

    let id = match &input.id {
      Some(id) => parse_id::<Uuid>(id, "organization_unit")?,
      None => Uuid::new_v4(),
    };
    let parent = input
      .parent_unit_id
      .as_ref()
      .map(|p| parse_id::<Uuid>(p, "parent_unit"))
      .transpose()?;
    let unit_type_id = parse_id::<Uuid>(&input.unit_type_id, "unit_type")?;
    if matches!(input.max_members, Some(value) if value < 1) {
      return Err(async_graphql::Error::new("max_members must be at least 1"));
    }
    let existing = units_repo.get_by_id(id).await.map_err(map_repo_err)?;
    let now = Utc::now();
    let row = OrganizationUnit {
      id,
      organization_id: org.id,
      parent_unit_id: parent,
      unit_type_id,
      name: input.name,
      slug: input.slug,
      description: input.description,
      status: input.status.map(Into::into).unwrap_or(OrganizationUnitStatus::Active),
      max_members: input
        .max_members
        .or_else(|| existing.as_ref().map(|unit| unit.max_members))
        .unwrap_or(25),
      metadata: input.metadata.unwrap_or(serde_json::json!({})),
      created_by: Some(admin_id),
      child_unit_count: 0,
      member_count: 0,
      workspace_count: 0,
      created_at: now,
      updated_at: now,
    };
    let actor = resolve_audit_actor(ctx).await;
    let saved = if existing.is_some() {
      lifecycle.update(&row, actor).await.map_err(map_lifecycle_error)?
    } else {
      lifecycle.create(&row, actor).await.map_err(map_lifecycle_error)?
    };
    info!(admin_id = %admin_id, unit_id = %saved.id, "organization_unit upserted");
    Ok(saved.into())
  }

  /// Set an OU's parent (`null` = root). Cycle detection enforced by repo.
  #[instrument(skip(self, ctx))]
  pub async fn set_organization_unit_parent(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
    parent_unit_id: Option<ID>,
  ) -> Result<bool> {
    let (state, _) = require_admin(ctx).await?;
    let lifecycle = state
      .organization_unit_lifecycle_service()
      .ok_or_else(|| async_graphql::Error::new("organization unit lifecycle service not configured"))?;
    let uid = parse_id::<Uuid>(&unit_id, "organization_unit")?;
    let parent = parent_unit_id
      .as_ref()
      .map(|p| parse_id::<Uuid>(p, "parent_unit"))
      .transpose()?;
    lifecycle
      .move_unit(uid, parent, resolve_audit_actor(ctx).await)
      .await
      .map_err(map_lifecycle_error)?;
    Ok(true)
  }

  /// Soft-disable an OU. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn deactivate_organization_unit(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    let (state, _) = require_admin(ctx).await?;
    let lifecycle = state
      .organization_unit_lifecycle_service()
      .ok_or_else(|| async_graphql::Error::new("organization unit lifecycle service not configured"))?;
    let uid = parse_id::<Uuid>(&id, "organization_unit")?;
    lifecycle
      .set_status(uid, OrganizationUnitStatus::Disabled, resolve_audit_actor(ctx).await)
      .await
      .map_err(map_lifecycle_error)?;
    Ok(true)
  }

  /// Set an OU status through the guarded lifecycle state machine.
  #[instrument(skip(self, ctx))]
  pub async fn set_organization_unit_status(
    &self,
    ctx: &Context<'_>,
    id: ID,
    status: OrganizationUnitStatusEnum,
  ) -> Result<OrganizationUnitTypeOutput> {
    let (state, _) = require_admin(ctx).await?;
    let lifecycle = state
      .organization_unit_lifecycle_service()
      .ok_or_else(|| async_graphql::Error::new("organization unit lifecycle service not configured"))?;
    let unit_id = parse_id::<Uuid>(&id, "organization_unit")?;
    lifecycle
      .set_status(unit_id, status.into(), resolve_audit_actor(ctx).await)
      .await
      .map(Into::into)
      .map_err(map_lifecycle_error)
  }

  /// Preview all current permanent-deletion blockers and bind the confirmation
  /// to the returned revision.
  #[instrument(skip(self, ctx))]
  pub async fn organization_unit_deletion_preview(
    &self,
    ctx: &Context<'_>,
    id: ID,
  ) -> Result<OrganizationUnitDeletionPreviewType> {
    let (state, _) = require_admin(ctx).await?;
    let lifecycle = state
      .organization_unit_lifecycle_service()
      .ok_or_else(|| async_graphql::Error::new("organization unit lifecycle service not configured"))?;
    lifecycle
      .deletion_preview(parse_id::<Uuid>(&id, "organization_unit")?)
      .await
      .map(Into::into)
      .map_err(map_lifecycle_error)
  }

  /// Permanently delete an inactive and unreferenced OU after exact name and
  /// revision confirmation.
  #[instrument(skip(self, ctx, confirmed_name))]
  pub async fn delete_organization_unit_permanently(
    &self,
    ctx: &Context<'_>,
    id: ID,
    confirmed_name: String,
    preview_revision: DateTime<Utc>,
  ) -> Result<bool> {
    let (state, _) = require_admin(ctx).await?;
    let lifecycle = state
      .organization_unit_lifecycle_service()
      .ok_or_else(|| async_graphql::Error::new("organization unit lifecycle service not configured"))?;
    lifecycle
      .delete_permanently(
        parse_id::<Uuid>(&id, "organization_unit")?,
        &confirmed_name,
        preview_revision,
        resolve_audit_actor(ctx).await,
      )
      .await
      .map_err(map_lifecycle_error)?;
    Ok(true)
  }

  /// Update organisation policies. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn update_organization_policy(
    &self,
    ctx: &Context<'_>,
    input: UpdateOrganizationPolicyInput,
  ) -> Result<OrganizationPolicyType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let policies = state
      .organization_policy_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_policy repo not configured"))?;
    let org_repo = state
      .organization_repo()
      .ok_or_else(|| async_graphql::Error::new("organization repo not configured"))?;
    let org = org_repo
      .get_by_key("myoxus")
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("default organization missing"))?;
    let mut current = policies.get(org.id).await.map_err(map_repo_err)?;
    if let Some(p) = input.manager_root_project_creation {
      current.manager_root_project_creation = p.into();
    }
    if let Some(p) = input.manager_unit_project_creation {
      current.manager_unit_project_creation = p.into();
    }
    if let Some(b) = input.manager_can_create_workspaces {
      current.manager_can_create_workspaces = b;
    }
    if let Some(b) = input.manager_can_manage_ou_members {
      current.manager_can_manage_ou_members = b;
    }
    if let Some(b) = input.import_export_enabled {
      current.import_export_enabled = b;
    }
    current.updated_by = Some(admin_id);
    current.updated_at = Utc::now();
    let saved = policies.upsert(&current).await.map_err(map_repo_err)?;

    let actor = resolve_audit_actor(ctx).await;
    state
      .audit_recorder()
      .record(AuditEvent::mutation(
        "organization.policy.update",
        AuditCategory::Organization,
        Some(AuditTarget::entity("organization", org.id, None)),
        actor,
        None,
        None,
      ))
      .await;
    Ok(saved.into())
  }

  /// Toggle the `Manager` user feature for a user. Admin-only.
  ///
  /// This only flips the global capability; OU-membership must be set
  /// separately via `assign_organization_manager`. Without both, the user
  /// has no manager rights (Learning LRN-20260502-ORG-A-01).
  #[instrument(skip(self, ctx))]
  pub async fn set_user_manager_feature(&self, ctx: &Context<'_>, user_id: ID, enabled: bool) -> Result<bool> {
    let (state, admin_id) = require_admin(ctx).await?;
    let uid = parse_id::<Uuid>(&user_id, "user")?;
    crate::graphql::persist_user_feature_override(&state, uid, crate::graphql::USER_FEATURE_MANAGER, enabled).await?;
    let actor = resolve_audit_actor(ctx).await;
    state
      .audit_recorder()
      .record(AuditEvent::mutation(
        "organization.user_manager_feature.set",
        AuditCategory::Organization,
        Some(AuditTarget::entity("user", uid, None)),
        actor,
        None,
        Some(serde_json::json!({"enabled": enabled})),
      ))
      .await;
    info!(admin_id = %admin_id, user_id = %uid, enabled, "user manager feature toggled");
    Ok(enabled)
  }

  /// Assign / update an OU member. Admin-only.
  ///
  /// P-AR-2-S03 intentionally makes the global `Manager` feature a
  /// consequence of `role=manager`, not a prerequisite. Membership and
  /// implicit capability commit together in the shared transactional owner.
  #[instrument(skip(self, ctx))]
  pub async fn assign_organization_manager(
    &self,
    ctx: &Context<'_>,
    input: AssignOrganizationManagerInput,
  ) -> Result<OrganizationUnitMemberType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let unit_id = parse_id::<Uuid>(&input.unit_id, "organization_unit")?;
    let user_id = parse_id::<Uuid>(&input.user_id, "user")?;
    let service = state
      .organization_memberships()
      .ok_or_else(|| async_graphql::Error::new("organization membership service not configured"))?;
    let commit = service
      .apply(
        MembershipChange {
          organization_id: None,
          unit_id,
          user_id,
          operation: MembershipOperation::Upsert,
          role: input.role.into(),
          metadata: serde_json::json!({"assigned_by": admin_id.to_string()}),
          manager_id: None,
        },
        resolve_audit_actor(ctx).await,
      )
      .await
      .map_err(map_repo_err)?;
    Ok(commit.current.expect("upsert commit contains membership").into())
  }

  /// Remove a user from an OU. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn unassign_organization_manager(&self, ctx: &Context<'_>, unit_id: ID, user_id: ID) -> Result<bool> {
    let (state, _) = require_admin(ctx).await?;
    let unit_id = parse_id::<Uuid>(&unit_id, "organization_unit")?;
    let user_id = parse_id::<Uuid>(&user_id, "user")?;
    state
      .organization_memberships()
      .ok_or_else(|| async_graphql::Error::new("organization membership service not configured"))?
      .apply(
        MembershipChange {
          organization_id: None,
          unit_id,
          user_id,
          operation: MembershipOperation::Remove,
          role: OrganizationUnitRole::Member,
          metadata: serde_json::json!({}),
          manager_id: None,
        },
        resolve_audit_actor(ctx).await,
      )
      .await
      .map_err(map_repo_err)?;
    Ok(true)
  }

  /// Set a workspace's OU relationship (owner/managed/linked). Setting Owner
  /// atomically transfers OU ownership and demotes the previous owner OU to
  /// Managed. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn assign_organization_unit_workspace(
    &self,
    ctx: &Context<'_>,
    input: AssignOrganizationUnitWorkspaceInput,
  ) -> Result<bool> {
    let (state, _) = require_admin(ctx).await?;
    let links = state
      .organization_unit_workspace_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit_workspace repo not configured"))?;
    let uid = parse_id::<Uuid>(&input.unit_id, "organization_unit")?;
    let wid = parse_id::<Uuid>(&input.workspace_id, "workspace")?;
    links
      .set_relationship(uid, wid, input.relationship.into())
      .await
      .map_err(map_repo_err)?;
    Ok(true)
  }

  /// Remove an OU↔workspace link. Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn unassign_organization_unit_workspace(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
    workspace_id: ID,
    relationship: OrganizationUnitWorkspaceRelationshipEnum,
  ) -> Result<bool> {
    let (state, _) = require_admin(ctx).await?;
    let links = state
      .organization_unit_workspace_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit_workspace repo not configured"))?;
    let uid = parse_id::<Uuid>(&unit_id, "organization_unit")?;
    let wid = parse_id::<Uuid>(&workspace_id, "workspace")?;
    links
      .unassign(uid, wid, relationship.into())
      .await
      .map_err(map_repo_err)?;
    Ok(true)
  }

  /// Decide on a project request (Approve / Reject / Cancel). Admin-only.
  #[instrument(skip(self, ctx))]
  pub async fn decide_organization_project_request(
    &self,
    ctx: &Context<'_>,
    id: ID,
    new_status: ProjectRequestStatusEnum,
  ) -> Result<bool> {
    let (state, admin_id) = require_admin(ctx).await?;
    let svc = state
      .organization_project_request_service()
      .ok_or_else(|| async_graphql::Error::new("project request service not configured"))?;
    let rid = parse_id::<Uuid>(&id, "organization_project_request")?;
    svc
      .decide(rid, new_status.into(), admin_id)
      .await
      .map_err(map_repo_err)?;
    Ok(true)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers used by tests / cross-resolver hooks
// ─────────────────────────────────────────────────────────────────────────────

/// Map a `ProjectCreationDecision` to the GraphQL-visible enum, used by
/// scoped manager-mutations to render policy responses without coupling
/// the GraphQL surface to the application service's `Decision` type.
pub fn project_creation_decision_label(d: ProjectCreationDecision) -> &'static str {
  match d {
    ProjectCreationDecision::Allowed => "Allowed",
    ProjectCreationDecision::RequiresApproval => "RequiresApproval",
    ProjectCreationDecision::Denied => "Denied",
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// P-AR-2-S03 — Implicit Manager-Capability Hooks
// ─────────────────────────────────────────────────────────────────────────────
//
// The global `FeatureType.Manager`-capability is NOT UI-toggle-bar (concept §
// 3.4). It is set as a CONSEQUENCE of OU manager-role assigns and revoked
// once the user no longer holds any `manager`-membership in any OU.
//
// These helpers are called from the four resolvers that mutate
// `organization_unit_member.role = 'manager'`:
//
//   * `assignOrganizationManager`            (admin)
//   * `addOrganizationUnitMemberAsManager`   (manager-scoped, never grants
//                                             role=manager today, but the
//                                             helper is symmetric for safety)
//   * `unassignOrganizationManager`          (admin)
//   * `removeOrganizationUnitMemberAsManager` (manager-scoped)
//
// They write an audit row keyed `user.feature.manager.implicit_set` /
// `ProjectCreationScope` is owned and publicly exported by the application
// layer (`myoxus_application::organization`). Resolvers that need the decision
// path import it directly from that authoritative owner.

// ─────────────────────────────────────────────────────────────────────────────
// Manager-scoped surface (packages D-04 / D-05)
// ─────────────────────────────────────────────────────────────────────────────

/// Three-state outcome of the project-creation policy gate.
#[derive(Enum, Copy, Clone, Eq, PartialEq, Debug)]
#[graphql(rename_items = "PascalCase")]
pub enum ProjectCreationDecisionEnum {
  Allowed,
  RequiresApproval,
  Denied,
}

impl From<ProjectCreationDecision> for ProjectCreationDecisionEnum {
  fn from(d: ProjectCreationDecision) -> Self {
    match d {
      ProjectCreationDecision::Allowed => Self::Allowed,
      ProjectCreationDecision::RequiresApproval => Self::RequiresApproval,
      ProjectCreationDecision::Denied => Self::Denied,
    }
  }
}

/// Result of `createOrganizationProject`. Either the manager may proceed
/// directly (returning the unit/request id), the request is pending
/// admin approval, or it was outright denied.
#[derive(SimpleObject, Debug, Clone)]
pub struct OrganizationProjectCreationResult {
  pub decision: ProjectCreationDecisionEnum,
  /// Set on `RequiresApproval`: id of the new pending request row.
  pub request_id: Option<ID>,
  /// Set on `Allowed`: id of the freshly created OU representing the
  /// project. Currently `None` — direct project creation is forwarded
  /// to a follow-up workspace flow that the caller drives.
  pub created_unit_id: Option<ID>,
}

/// Input for `createOrganizationProject` — the manager-scoped
/// project request entry-point.
#[derive(InputObject, Debug)]
pub struct CreateOrganizationProjectInput {
  /// `null` = root-level project (uses `manager_root_project_creation`
  /// policy). Otherwise an existing OU id (uses
  /// `manager_unit_project_creation` policy).
  pub parent_unit_id: Option<ID>,
  pub proposed_name: String,
  /// OU type to assign — must be `can_be_manager_created`. Resolver
  /// checks the type's flags before persisting.
  pub proposed_type_id: Option<ID>,
  /// Optional list of additional members to seed into the new OU.
  pub proposed_members: Option<Vec<ID>>,
  /// If `true`, the request signals that an associated workspace should
  /// be created alongside the OU (admin discretion at decide-time).
  pub proposed_workspace: Option<bool>,
  pub metadata: Option<JsonValue>,
}

/// Input for `createWorkspaceInOrganizationUnit` — the manager-scoped
/// workspace-creation entry-point. Creates an OU-owned shared workspace and
/// grants the caller an Admin membership.
#[derive(InputObject, Debug)]
pub struct CreateWorkspaceInOrganizationUnitInput {
  pub unit_id: ID,
  /// Optional workspace name. Omitted names retain the compatible server
  /// default.
  pub name: Option<String>,
  /// Deprecated client-supplied Yjs state. Shared workspace roots are always
  /// generated authoritatively by the server from the final workspace name.
  pub init_data_b64: Option<String>,
}

/// A workspace link with the relationship label, used by
/// `myOrganizationUnitWorkspaces`.
#[derive(SimpleObject, Debug, Clone)]
pub struct MyOrganizationUnitWorkspace {
  pub unit_id: ID,
  pub unit_name: Option<String>,
  pub unit_slug: Option<String>,
  pub workspace_id: ID,
  pub workspace_name: Option<String>,
  pub relationship: OrganizationUnitWorkspaceRelationshipEnum,
}

impl From<OrganizationUnitWorkspace> for MyOrganizationUnitWorkspace {
  fn from(l: OrganizationUnitWorkspace) -> Self {
    Self {
      unit_id: ID(l.unit_id.to_string()),
      unit_name: None,
      unit_slug: None,
      workspace_id: ID(l.workspace_id.to_string()),
      workspace_name: None,
      relationship: l.relationship.into(),
    }
  }
}

/// Manager-scoped query surface — exposed at GraphQL root level (NOT
/// under `admin`). Members are checked via session + permission service.
pub struct OrganizationManagerQueryRoot;

#[Object]
impl OrganizationManagerQueryRoot {
  /// All OU↔workspace links accessible via the caller's OU memberships.
  /// Returns the union over `list_for_unit` for each of the user's OUs.
  #[graphql(name = "myOrganizationUnitWorkspaces")]
  #[instrument(skip(self, ctx))]
  pub async fn my_organization_unit_workspaces(&self, ctx: &Context<'_>) -> Result<Vec<MyOrganizationUnitWorkspace>> {
    let (state, snapshot) = require_session(ctx).await?;
    let units_repo = state
      .organization_unit_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit repo not configured"))?;
    let links = state
      .organization_unit_workspace_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit_workspace repo not configured"))?;
    let units = units_repo.list_for_user(snapshot.user.id).await.map_err(map_repo_err)?;
    let mut out: Vec<MyOrganizationUnitWorkspace> = Vec::new();
    for u in units {
      let rows = links.list_for_unit(u.id).await.map_err(map_repo_err)?;
      for row in rows {
        // Manager surfaces are human administration surfaces. Returning only
        // UUIDs forces every client to rehydrate labels and makes visual
        // regressions likely; the server already owns the authoritative
        // workspace and OU names.
        let workspace_name = match state.workspace().get_workspace(row.workspace_id).await {
          Ok(Some(workspace)) => Some(workspace.name),
          Ok(None) => {
            debug!(
              unit_id = %row.unit_id,
              workspace_id = %row.workspace_id,
              "myOrganizationUnitWorkspaces: linked workspace row no longer exists"
            );
            None
          }
          Err(err) => return Err(map_gql_error(err)),
        };
        out.push(MyOrganizationUnitWorkspace {
          unit_id: ID(row.unit_id.to_string()),
          unit_name: Some(u.name.clone()),
          unit_slug: Some(u.slug.clone()),
          workspace_id: ID(row.workspace_id.to_string()),
          workspace_name,
          relationship: row.relationship.into(),
        });
      }
    }
    Ok(out)
  }

  /// Run the project-creation policy gate without persisting anything.
  /// `unit_id=None` queries the root-policy, `Some(id)` queries the
  /// unit-policy combined with manager-scope on that OU.
  #[graphql(name = "canCreateOrganizationProject")]
  #[instrument(skip(self, ctx))]
  pub async fn can_create_organization_project(
    &self,
    ctx: &Context<'_>,
    unit_id: Option<ID>,
  ) -> Result<ProjectCreationDecisionEnum> {
    let (state, snapshot) = require_session(ctx).await?;
    let perm = state
      .organization_permission_service()
      .ok_or_else(|| async_graphql::Error::new("organization permission service not configured"))?;
    let org_repo = state
      .organization_repo()
      .ok_or_else(|| async_graphql::Error::new("organization repo not configured"))?;
    let org = org_repo
      .get_by_key("myoxus")
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("default organization missing"))?;
    use myoxus_application::organization::ProjectCreationScope;
    let scope = match unit_id {
      Some(ref id) => ProjectCreationScope::Ou(parse_id::<Uuid>(id, "organization_unit")?),
      None => ProjectCreationScope::OrganizationRoot,
    };
    let decision = perm
      .can_create_project_in_scope(snapshot.user.id, org.id, scope)
      .await
      .map_err(map_repo_err)?;
    Ok(decision.into())
  }

  /// Caller-scoped: members of an OU the user manages. Refuses with
  /// `ActionForbidden` if the user is not a manager of `unit_id`.
  /// Used by the Web frontend Workspace-Setting → Organisation tab to
  /// surface the OU's member roster without exposing the admin-only
  /// `admin.organizationUnitMembers` field.
  #[graphql(name = "myOrganizationUnitMembers")]
  #[instrument(skip(self, ctx))]
  pub async fn my_organization_unit_members(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
  ) -> Result<Vec<OrganizationUnitMemberType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let perm = state
      .organization_permission_service()
      .ok_or_else(|| async_graphql::Error::new("organization permission service not configured"))?;
    let uid = parse_id::<Uuid>(&unit_id, "organization_unit")?;
    if !perm.is_manager_for_unit(snapshot.user.id, uid).await {
      warn!(user = %snapshot.user.id, unit = %uid, "non-manager attempted to read unit members");
      return Err(map_gql_error(AuthError::ActionForbidden));
    }
    let rows = state
      .organization_reads()
      .ok_or_else(|| async_graphql::Error::new("organization reads not configured"))?
      .unit_members(uid, None)
      .await
      .map_err(map_repo_err)?;
    Ok(rows.into_iter().map(member_with_profile).collect())
  }

  /// Caller-scoped audit log for an OU managed by the current actor.
  /// Manager-only; filters on `target_unit_id = unit_id`. See ORG-G-06.
  #[graphql(name = "myOrganizationAuditLog")]
  #[instrument(skip(self, ctx))]
  pub async fn my_organization_audit_log(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
    skip: Option<i64>,
    take: Option<i64>,
  ) -> Result<Vec<crate::graphql::audit_types::AdminAuditLogEntryType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let perm = state
      .organization_permission_service()
      .ok_or_else(|| async_graphql::Error::new("organization permission service not configured"))?;
    let uid = parse_id::<Uuid>(&unit_id, "organization_unit")?;
    if !perm.is_manager_for_unit_or_ancestor(snapshot.user.id, uid).await {
      warn!(user = %snapshot.user.id, unit = %uid, "non-manager attempted to read OU audit log");
      return Err(map_gql_error(AuthError::ActionForbidden));
    }
    let filter = myoxus_domain::audit::AuditFilter {
      target_unit_id: Some(uid),
      ..Default::default()
    };
    let entries = state
      .audit_recorder()
      .list(filter, skip.unwrap_or(0), take.unwrap_or(50).clamp(1, 500))
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;
    Ok(
      entries
        .into_iter()
        .map(crate::graphql::audit_types::AdminAuditLogEntryType::from)
        .collect(),
    )
  }

  /// Run the workspace-creation policy gate for an OU without
  /// persisting anything. Returns `true` iff the caller may create a
  /// new workspace owned by the given OU.
  #[graphql(name = "canCreateWorkspaceInOrganizationUnit")]
  #[instrument(skip(self, ctx))]
  pub async fn can_create_workspace_in_organization_unit(&self, ctx: &Context<'_>, unit_id: ID) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let perm = state
      .organization_permission_service()
      .ok_or_else(|| async_graphql::Error::new("organization permission service not configured"))?;
    let org_repo = state
      .organization_repo()
      .ok_or_else(|| async_graphql::Error::new("organization repo not configured"))?;
    let org = org_repo
      .get_by_key("myoxus")
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("default organization missing"))?;
    let uid = parse_id::<Uuid>(&unit_id, "organization_unit")?;
    let allowed = perm
      .can_create_workspace_in_ou(snapshot.user.id, org.id, uid)
      .await
      .map_err(map_repo_err)?;
    Ok(allowed)
  }

  /// P-AR-0-S01: Free-text search over OUs (name + slug, ILIKE substring).
  /// Permission model:
  ///   * Admin → unrestricted, sees every match.
  ///   * Non-admin → membership-scoped: results are intersected with the
  ///     user's OU memberships (`organization_unit_member` rows for the
  ///     caller). This makes the resolver safe to expose at the
  ///     manager-scoped root (no `require_admin`) without leaking OUs the
  ///     caller has no business knowing about.
  /// `limit` is clamped to `[1, 50]`, default 20. The repository sorts by
  /// `name ASC`. Each hit carries a server-resolved `parentBreadcrumb`
  /// (root-first, exclusive of the hit itself).
  #[graphql(name = "searchOrganizationUnits")]
  #[instrument(skip(self, ctx))]
  pub async fn search_organization_units(
    &self,
    ctx: &Context<'_>,
    query: String,
    limit: Option<i32>,
  ) -> Result<Vec<OrganizationUnitSearchResult>> {
    let (state, snapshot) = require_session(ctx).await?;
    let units_repo = state
      .organization_unit_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_unit repo not configured"))?;

    let clamped_limit = limit.unwrap_or(20).clamp(1, 50) as i64;
    let hits = units_repo
      .search(query.as_str(), clamped_limit)
      .await
      .map_err(map_repo_err)?;

    // Apply membership-scoping for non-admin callers. We resolve the user's
    // OU id-set once (single DB round-trip) and filter the search hits in
    // memory; this avoids an N+1 lookup pattern.
    let visible: Vec<OrganizationUnit> = if snapshot.user.is_admin {
      hits
    } else {
      let members_repo = state
        .organization_unit_member_repo()
        .ok_or_else(|| async_graphql::Error::new("organization_unit_member repo not configured"))?;
      let memberships = members_repo
        .list_for_user(snapshot.user.id)
        .await
        .map_err(map_repo_err)?;
      let allowed: std::collections::HashSet<Uuid> = memberships.iter().map(|m| m.unit_id).collect();
      hits.into_iter().filter(|u| allowed.contains(&u.id)).collect()
    };

    let mut out: Vec<OrganizationUnitSearchResult> = Vec::with_capacity(visible.len());
    for u in visible {
      let breadcrumb = units_repo.breadcrumb_for_unit(u.id).await.map_err(map_repo_err)?;
      out.push(OrganizationUnitSearchResult {
        id: ID(u.id.to_string()),
        name: u.name,
        slug: u.slug,
        parent_breadcrumb: breadcrumb,
      });
    }
    Ok(out)
  }

  /// P-AR-0-S02: Manager-scoped user search (`UserPicker` in
  /// `mode="manager"`). Permission gate: caller MUST be a manager of
  /// `unit_id` (`is_manager_for_unit` — two-axis check: feature
  /// `manager` AND `organization_unit_member.role = 'manager'`).
  ///
  /// Refuses with `ActionForbidden` when the caller is not a manager of
  /// the requested OU — including admins who hold no manager role on
  /// that specific unit. The admin surface is `adminSearchUsers`.
  ///
  /// Single-tenant scope: the entire `users` table is the candidate
  /// set; the resolver delegates to `AdminService::search_users`. The
  /// "not yet member of this OU" filter is intentionally NOT applied
  /// here — the picker UI overlays that hint based on its own
  /// member-list query so users that are already in the OU still appear
  /// (with a badge).
  ///
  /// `limit` is clamped to `[1, 50]`, default 20. The output type
  /// ([`ManagerUserSearchResult`]) deliberately omits `is_admin` and
  /// `disabled` — managers must not see the admin-status or
  /// account-status of other users.
  #[graphql(name = "managerSearchUsers")]
  #[instrument(skip(self, ctx))]
  pub async fn manager_search_users(
    &self,
    ctx: &Context<'_>,
    query: String,
    unit_id: ID,
    limit: Option<i32>,
  ) -> Result<Vec<ManagerUserSearchResult>> {
    let (state, snapshot) = require_session(ctx).await?;
    let perm = state
      .organization_permission_service()
      .ok_or_else(|| async_graphql::Error::new("organization permission service not configured"))?;
    let uid = parse_id::<Uuid>(&unit_id, "organization_unit")?;
    if !perm.is_manager_for_unit(snapshot.user.id, uid).await {
      warn!(user = %snapshot.user.id, unit = %uid, "non-manager attempted managerSearchUsers");
      return Err(map_gql_error(AuthError::ActionForbidden));
    }

    let clamped_limit = limit.unwrap_or(20).clamp(1, 50) as i64;
    let rows = state
      .admin()
      .search_users(query.as_str(), None, clamped_limit)
      .await
      .map_err(|e| async_graphql::Error::new(e.to_string()))?;

    Ok(
      rows
        .into_iter()
        .map(|r| ManagerUserSearchResult {
          id: ID(r.id.to_string()),
          email: r.email,
          name: r.name,
          features: r.features,
        })
        .collect(),
    )
  }
}

/// Manager-scoped mutation surface — exposed at GraphQL root level (NOT
/// under `admin`). Each resolver runs its own policy check.
pub struct OrganizationManagerMutationRoot;

#[Object]
impl OrganizationManagerMutationRoot {
  /// Manager-scoped project creation. Routes through
  /// `ProjectRequestService::request_creation` so policy state
  /// (`Allowed`/`RequiresApproval`/`Denied`) decides whether the row
  /// is created directly, queued for admin decision, or refused.
  #[graphql(name = "createOrganizationProject")]
  #[instrument(skip(self, ctx))]
  pub async fn create_organization_project(
    &self,
    ctx: &Context<'_>,
    input: CreateOrganizationProjectInput,
  ) -> Result<OrganizationProjectCreationResult> {
    let (state, snapshot) = require_session(ctx).await?;
    let svc = state
      .organization_project_request_service()
      .ok_or_else(|| async_graphql::Error::new("project request service not configured"))?;
    let org_repo = state
      .organization_repo()
      .ok_or_else(|| async_graphql::Error::new("organization repo not configured"))?;
    let org = org_repo
      .get_by_key("myoxus")
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("default organization missing"))?;

    let parent = input
      .parent_unit_id
      .as_ref()
      .map(|p| parse_id::<Uuid>(p, "parent_unit"))
      .transpose()?;
    let proposed_type = input
      .proposed_type_id
      .as_ref()
      .map(|t| parse_id::<Uuid>(t, "proposed_type"))
      .transpose()?;
    let proposed_members: Vec<Uuid> = input
      .proposed_members
      .unwrap_or_default()
      .into_iter()
      .map(|m| parse_id::<Uuid>(&m, "proposed_member"))
      .collect::<Result<_>>()?;

    let outcome = svc
      .request_creation(myoxus_application::organization::CreateProjectRequestInput {
        organization_id: org.id,
        requested_by: snapshot.user.id,
        parent_unit_id: parent,
        proposed_name: input.proposed_name,
        proposed_type_id: proposed_type,
        proposed_members,
        proposed_workspace: input.proposed_workspace.unwrap_or(false),
        metadata: input.metadata.unwrap_or(serde_json::json!({})),
      })
      .await
      .map_err(map_repo_err)?;

    use myoxus_application::organization::ProjectRequestOutcome;
    let actor = resolve_audit_actor(ctx).await;
    let res = match outcome {
      ProjectRequestOutcome::AllowedDirect => {
        // Resolver does NOT auto-create the unit row here — the spec
        // (`organization-management-concept.md` §Manager-Workflows)
        // assigns that responsibility to the follow-up
        // `createWorkspaceInOrganizationUnit` flow once the manager has
        // chosen a name + type for the workspace. The decision is
        // surfaced so the client can render the right CTA.
        info!(user = %snapshot.user.id, "manager project creation: AllowedDirect");
        OrganizationProjectCreationResult {
          decision: ProjectCreationDecisionEnum::Allowed,
          request_id: None,
          created_unit_id: None,
        }
      }
      ProjectRequestOutcome::PendingApproval(rid) => {
        state
          .audit_recorder()
          .record(AuditEvent::mutation(
            "organization.project_request.create",
            AuditCategory::Organization,
            Some(AuditTarget::entity("organization_project_request", rid, None)),
            actor,
            None,
            Some(serde_json::json!({"requested_by": snapshot.user.id.to_string()})),
          ))
          .await;
        info!(user = %snapshot.user.id, request_id = %rid, "manager project creation: PendingApproval");
        OrganizationProjectCreationResult {
          decision: ProjectCreationDecisionEnum::RequiresApproval,
          request_id: Some(ID(rid.to_string())),
          created_unit_id: None,
        }
      }
      ProjectRequestOutcome::Denied => {
        warn!(user = %snapshot.user.id, "manager project creation: Denied");
        OrganizationProjectCreationResult {
          decision: ProjectCreationDecisionEnum::Denied,
          request_id: None,
          created_unit_id: None,
        }
      }
    };
    Ok(res)
  }

  /// Manager-scoped workspace creation inside a specific OU.
  ///
  /// Combines:
  ///  1. `OrganizationPermissionService::can_create_workspace_in_ou`
  ///     (capability + policy + scope check)
  ///  2. atomic `WorkspaceService::create_shared_workspace`
  ///
  /// Audit-logs the creation under category `organization`.
  #[graphql(name = "createWorkspaceInOrganizationUnit")]
  #[instrument(skip(self, ctx))]
  pub async fn create_workspace_in_organization_unit(
    &self,
    ctx: &Context<'_>,
    input: CreateWorkspaceInOrganizationUnitInput,
  ) -> Result<crate::graphql::auth::WorkspaceType> {
    let (state, snapshot) = require_session(ctx).await?;
    let perm = state
      .organization_permission_service()
      .ok_or_else(|| async_graphql::Error::new("organization permission service not configured"))?;
    let org_repo = state
      .organization_repo()
      .ok_or_else(|| async_graphql::Error::new("organization repo not configured"))?;
    let org = org_repo
      .get_by_key("myoxus")
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("default organization missing"))?;
    let uid = parse_id::<Uuid>(&input.unit_id, "organization_unit")?;
    let allowed = snapshot.user.is_admin
      || perm
        .can_create_workspace_in_ou(snapshot.user.id, org.id, uid)
        .await
        .map_err(map_repo_err)?;
    if !allowed {
      warn!(user = %snapshot.user.id, unit = %uid, "manager workspace creation refused (policy/scope)");
      return Err(map_gql_error(AuthError::ActionForbidden));
    }
    let ws = state
      .workspace()
      .create_shared_workspace(uid, snapshot.user.id, input.name)
      .await
      .map_err(map_gql_error)?;
    let actor = resolve_audit_actor(ctx).await;
    state
      .audit_recorder()
      .record(
        AuditEvent::mutation(
          "organization.workspace.create",
          AuditCategory::Organization,
          Some(AuditTarget::entity("workspace", ws.id, Some(ws.name.clone()))),
          actor,
          None,
          Some(serde_json::json!({
            "organization_unit_id": uid.to_string(),
            "manager_id": snapshot.user.id.to_string(),
          })),
        )
        .with_unit(uid),
      )
      .await;
    info!(user = %snapshot.user.id, unit = %uid, workspace = %ws.id, "manager created workspace in OU");
    let _ = input.init_data_b64; // Kept only for compatibility; never trusted as root state.
    Ok(ws.into())
  }

  /// Manager cancels their own pending project request. Admin-decided
  /// requests cannot be re-cancelled.
  #[graphql(name = "cancelOrganizationProjectRequest")]
  #[instrument(skip(self, ctx))]
  pub async fn cancel_organization_project_request(&self, ctx: &Context<'_>, id: ID) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let svc = state
      .organization_project_request_service()
      .ok_or_else(|| async_graphql::Error::new("project request service not configured"))?;
    let requests = state
      .organization_project_request_repo()
      .ok_or_else(|| async_graphql::Error::new("organization_project_request repo not configured"))?;
    let rid = parse_id::<Uuid>(&id, "organization_project_request")?;
    // Only the requesting user may cancel their own row.
    let req = requests
      .get(rid)
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("project request not found"))?;
    if req.requested_by != snapshot.user.id {
      warn!(user = %snapshot.user.id, request = %rid, "non-owner attempted to cancel project request");
      return Err(map_gql_error(AuthError::ActionForbidden));
    }
    svc
      .decide(rid, ProjectRequestStatus::Cancelled, snapshot.user.id)
      .await
      .map_err(map_repo_err)?;
    Ok(true)
  }

  /// Manager-scoped: add (or update) a member's role on an OU the
  /// caller manages. The role is capped at `member` for non-manager
  /// targets. Changing a Manager target requires the admin-only
  /// `assignOrganizationManager` mutation.
  ///
  /// Server checks:
  ///  - `is_manager_for_unit(caller, unit)` (two-axis)
  ///  - `policy.manager_can_manage_ou_members`
  ///  - role ∈ {`reader`, `member`} — never `manager` (admin scope)
  #[graphql(name = "addOrganizationUnitMemberAsManager")]
  #[instrument(skip(self, ctx))]
  pub async fn add_organization_unit_member_as_manager(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
    user_id: ID,
    role: OrganizationUnitRoleEnum,
  ) -> Result<OrganizationUnitMemberType> {
    let (state, snapshot) = require_session(ctx).await?;
    let unit_id = parse_id::<Uuid>(&unit_id, "organization_unit")?;
    let user_id = parse_id::<Uuid>(&user_id, "user")?;
    let service = state
      .organization_memberships()
      .ok_or_else(|| async_graphql::Error::new("organization membership service not configured"))?;
    let commit = service
      .apply(
        MembershipChange {
          organization_id: None,
          unit_id,
          user_id,
          operation: MembershipOperation::Upsert,
          role: role.into(),
          metadata: serde_json::json!({"added_by_manager": snapshot.user.id.to_string()}),
          manager_id: Some(snapshot.user.id),
        },
        resolve_audit_actor(ctx).await,
      )
      .await
      .map_err(map_repo_err)?;
    Ok(commit.current.expect("upsert commit contains membership").into())
  }

  /// Manager-scoped: remove a member from an OU the caller manages.
  /// Refuses if the target carries the `manager` role — admins manage
  /// manager removals via `unassignOrganizationManager`.
  #[graphql(name = "removeOrganizationUnitMemberAsManager")]
  #[instrument(skip(self, ctx))]
  pub async fn remove_organization_unit_member_as_manager(
    &self,
    ctx: &Context<'_>,
    unit_id: ID,
    user_id: ID,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let unit_id = parse_id::<Uuid>(&unit_id, "organization_unit")?;
    let user_id = parse_id::<Uuid>(&user_id, "user")?;
    state
      .organization_memberships()
      .ok_or_else(|| async_graphql::Error::new("organization membership service not configured"))?
      .apply(
        MembershipChange {
          organization_id: None,
          unit_id,
          user_id,
          operation: MembershipOperation::Remove,
          role: OrganizationUnitRole::Member,
          metadata: serde_json::json!({}),
          manager_id: Some(snapshot.user.id),
        },
        resolve_audit_actor(ctx).await,
      )
      .await
      .map_err(map_repo_err)?;
    Ok(true)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Import / Export (package H, exposed through package D-06..D-08)
// ─────────────────────────────────────────────────────────────────────────────

/// One CSV file as a tuple of name + body. Mirrors
/// `myoxus_application::organization::CsvFile`.
#[derive(SimpleObject, Clone, Debug)]
pub struct OrganizationCsvFileType {
  pub name: String,
  /// The file body as UTF-8 text. Always RFC-4180 with CRLF line endings.
  #[graphql(name = "contentType")]
  pub content_type: String,
  pub content: String,
}

/// Result of a non-applying validation pass. `errors` is empty if the
/// snapshot is consistent.
#[derive(SimpleObject, Clone, Debug)]
pub struct OrganizationImportPreviewType {
  pub errors: Vec<OrganizationImportErrorType>,
  /// Stats that *would* be produced on apply, computed from a successful
  /// dry-run. `null` when `errors` is non-empty.
  pub summary: Option<OrganizationImportSummaryType>,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct OrganizationImportErrorType {
  pub source: String,
  pub row: Option<i32>,
  pub field: Option<String>,
  pub message: String,
}

#[derive(SimpleObject, Clone, Debug)]
pub struct OrganizationImportSummaryType {
  pub organization_updated: bool,
  pub unit_types_inserted: i32,
  pub unit_types_updated: i32,
  pub units_inserted: i32,
  pub units_updated: i32,
  pub members_inserted: i32,
  pub members_updated: i32,
  pub workspace_links_inserted: i32,
  pub workspace_links_updated: i32,
  pub policy_updated: bool,
}

/// Full export payload — JSON snapshot plus the five CSV files.
#[derive(SimpleObject, Clone, Debug)]
pub struct OrganizationExportType {
  pub schema_version: i32,
  /// JSON snapshot serialised as a string (clients usually parse it
  /// client-side; the GraphQL `JSON` scalar is also acceptable but we
  /// prefer a plain string for backwards-compat with stricter codegens).
  pub json: String,
  pub files: Vec<OrganizationCsvFileType>,
}

#[derive(InputObject, Debug)]
pub struct OrganizationImportInput {
  /// Full JSON snapshot. Either `json` or `files` must be provided.
  pub json: Option<String>,
  /// Five CSV files (`organization.csv`, `ou_types.csv`, `ous.csv`,
  /// `ou_members.csv`, `ou_workspaces.csv`). Order is irrelevant.
  pub files: Option<Vec<OrganizationCsvFileInput>>,
}

#[derive(InputObject, Debug)]
pub struct OrganizationCsvFileInput {
  pub name: String,
  pub content: String,
}

fn snapshot_from_input(
  input: OrganizationImportInput,
) -> std::result::Result<
  myoxus_application::organization::PreparedOrganizationImport,
  Vec<myoxus_application::organization::ImportError>,
> {
  let csv_files = input.files.map(|files| {
    files
      .into_iter()
      .map(|file| myoxus_application::organization::CsvFile {
        name: file.name,
        content: file.content,
      })
      .collect::<Vec<_>>()
  });
  myoxus_application::organization::OrganizationImportExportService::decode_import(
    input.json.as_deref(),
    csv_files.as_deref(),
  )
}

fn errors_to_graphql(errors: Vec<myoxus_application::organization::ImportError>) -> Vec<OrganizationImportErrorType> {
  errors
    .into_iter()
    .map(|e| OrganizationImportErrorType {
      source: e.source,
      row: e.row.map(|r| r as i32),
      field: e.field,
      message: e.message,
    })
    .collect()
}

fn summary_to_graphql(s: myoxus_application::organization::ImportSummary) -> OrganizationImportSummaryType {
  OrganizationImportSummaryType {
    organization_updated: s.organization_updated,
    unit_types_inserted: s.unit_types_inserted as i32,
    unit_types_updated: s.unit_types_updated as i32,
    units_inserted: s.units_inserted as i32,
    units_updated: s.units_updated as i32,
    members_inserted: s.members_inserted as i32,
    members_updated: s.members_updated as i32,
    workspace_links_inserted: s.workspace_links_inserted as i32,
    workspace_links_updated: s.workspace_links_updated as i32,
    policy_updated: s.policy_updated,
  }
}

/// Admin-only Import/Export resolver root. Mounted on `AdminRoot`.
pub struct OrganizationImportExportRoot;

#[Object]
impl OrganizationImportExportRoot {
  /// Full snapshot export — admin only. Returns the canonical JSON
  /// document plus the five CSV files generated from it.
  #[instrument(skip(self, ctx))]
  pub async fn organization_export(&self, ctx: &Context<'_>) -> Result<OrganizationExportType> {
    let (state, _) = require_admin(ctx).await?;
    let svc = state
      .organization_import_export_service()
      .ok_or_else(|| async_graphql::Error::new("organization import/export service not configured"))?;
    let org_repo = state
      .organization_repo()
      .ok_or_else(|| async_graphql::Error::new("organization repo not configured"))?;
    let org = org_repo
      .get_by_key("myoxus")
      .await
      .map_err(map_repo_err)?
      .ok_or_else(|| async_graphql::Error::new("default organization missing"))?;
    let snapshot = svc.export_json(org.id).await.map_err(map_repo_err)?;
    let files = myoxus_application::organization::OrganizationImportExportService::snapshot_to_csv(&snapshot)
      .map_err(map_repo_err)?;
    let json = serde_json::to_string_pretty(&snapshot)
      .map_err(|e| async_graphql::Error::new(format!("snapshot serialisation failed: {e}")))?;
    Ok(OrganizationExportType {
      schema_version: snapshot.schema_version as i32,
      json,
      files: files
        .into_iter()
        .map(|f| OrganizationCsvFileType {
          name: f.name,
          content_type: "text/csv".to_string(),
          content: f.content,
        })
        .collect(),
    })
  }

  /// Validate-only — admin only. Returns structured errors without
  /// touching the DB. Clients render the report in a preview pane.
  #[instrument(skip(self, ctx, input))]
  pub async fn organization_import_dry_run(
    &self,
    ctx: &Context<'_>,
    input: OrganizationImportInput,
  ) -> Result<OrganizationImportPreviewType> {
    let (state, _) = require_admin(ctx).await?;
    let svc = state
      .organization_import_export_service()
      .ok_or_else(|| async_graphql::Error::new("organization import/export service not configured"))?;
    let import = match snapshot_from_input(input) {
      Ok(import) => import,
      Err(errors) => {
        return Ok(OrganizationImportPreviewType {
          errors: errors_to_graphql(errors),
          summary: None,
        });
      }
    };
    let errors = svc.dry_run(&import).await.map_err(map_repo_err)?;
    Ok(OrganizationImportPreviewType {
      errors: errors_to_graphql(errors),
      summary: None,
    })
  }

  /// Apply the snapshot — admin only. Refuses to apply if `dry_run`
  /// returns any error; in that case the response carries the errors
  /// unchanged so the client can render them.
  #[instrument(skip(self, ctx, input))]
  pub async fn organization_import_apply(
    &self,
    ctx: &Context<'_>,
    input: OrganizationImportInput,
  ) -> Result<OrganizationImportPreviewType> {
    let (state, admin_id) = require_admin(ctx).await?;
    let svc = state
      .organization_import_export_service()
      .ok_or_else(|| async_graphql::Error::new("organization import/export service not configured"))?;
    let import = match snapshot_from_input(input) {
      Ok(import) => import,
      Err(errors) => {
        return Ok(OrganizationImportPreviewType {
          errors: errors_to_graphql(errors),
          summary: None,
        });
      }
    };
    let outcome = svc.apply(&import).await.map_err(map_repo_err)?;
    let actor = resolve_audit_actor(ctx).await;
    let res = match outcome {
      Ok(commit) => {
        for user_id in &commit.manager_capability_users {
          state.invalidate_user_feature_cache_l2(*user_id).await;
        }
        let summary = commit.summary;
        state
          .audit_recorder()
          .record(AuditEvent::mutation(
            "organization.import.apply",
            AuditCategory::Organization,
            Some(AuditTarget::entity(
              "organization",
              uuid::Uuid::nil(),
              Some(import.snapshot.organization.key.clone()),
            )),
            actor,
            None,
            Some(serde_json::json!({
              "units_inserted": summary.units_inserted,
              "members_inserted": summary.members_inserted,
            })),
          ))
          .await;
        info!(admin_id = %admin_id, "organization import applied");
        OrganizationImportPreviewType {
          errors: vec![],
          summary: Some(summary_to_graphql(summary)),
        }
      }
      Err(errors) => OrganizationImportPreviewType {
        errors: errors_to_graphql(errors),
        summary: None,
      },
    };
    Ok(res)
  }
}
