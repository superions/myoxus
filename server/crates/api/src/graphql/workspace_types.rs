//! GraphQL types for admin workspace management.

use async_graphql::{Context, Result};
use chrono::{DateTime, Utc};
use std::sync::Arc;

use super::auth;
use super::git_sync;

#[derive(async_graphql::InputObject, Clone)]
pub struct ListWorkspaceInput {
  pub enable_ai: Option<bool>,
  pub enable_doc_embedding: Option<bool>,
  pub enable_sharing: Option<bool>,
  pub enable_url_preview: Option<bool>,
  pub features: Option<Vec<auth::FeatureType>>,
  pub first: Option<i32>,
  #[graphql(name = "gitSyncEnabled")]
  pub git_sync_enabled: Option<bool>,
  #[graphql(name = "gitSyncLastStatus")]
  pub git_sync_last_status: Option<git_sync::GitSyncRunStatusType>,
  #[graphql(name = "isPersonal")]
  pub is_personal: Option<bool>,
  #[graphql(name = "workspaceType")]
  pub workspace_type: Option<WorkspaceTypeFilter>,
  pub keyword: Option<String>,
  #[graphql(name = "memberCountMin")]
  pub member_count_min: Option<i32>,
  #[graphql(name = "memberCountMax")]
  pub member_count_max: Option<i32>,
  pub public: Option<bool>,
  pub skip: Option<i32>,
  #[graphql(name = "orderBy")]
  pub order_by: Option<AdminWorkspaceSort>,
}

#[derive(async_graphql::Enum, Debug, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkspaceTypeFilter", rename_items = "PascalCase")]
pub enum WorkspaceTypeFilter {
  Personal,
  UserOwned,
  Shared,
}

impl WorkspaceTypeFilter {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Personal => "Personal",
      Self::UserOwned => "UserOwned",
      Self::Shared => "Shared",
    }
  }
}

/// Sort options for the admin workspace list.
///
/// Uses `PascalCase` serialization to match the generated TypeScript
/// generated `AdminWorkspaceSort` client enum.
#[derive(async_graphql::Enum, Debug, Copy, Clone, Eq, PartialEq)]
#[graphql(rename_items = "PascalCase")]
pub enum AdminWorkspaceSort {
  CreatedAt,
  MemberCount,
  PublicPageCount,
  SnapshotCount,
  SnapshotSize,
  BlobCount,
  BlobSize,
}

/// Global storage quota defaults from server configuration (admin-only).
#[derive(async_graphql::SimpleObject, Clone)]
#[graphql(name = "StorageQuotaConfigType")]
pub struct StorageQuotaConfigType {
  /// Default workspace storage quota in MB. 0 = unlimited.
  #[graphql(name = "defaultWorkspaceQuotaMb")]
  pub default_workspace_quota_mb: i32,
}

// ─── Workspace quota details (admin inspector) ───────────────────────────────

/// Which level of the 4-level priority hierarchy is currently determining the
/// effective storage quota for a workspace.
///
/// Mirrors [`myoxus_application::quota::QuotaSource`] for the GraphQL schema.
#[derive(async_graphql::Enum, Debug, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkspaceQuotaSource", rename_items = "PascalCase")]
pub enum QuotaSourceGqlType {
  /// Workspace-level override is active (`workspaces.storage_quota_bytes` is set).
  WorkspaceOverride,
  /// Global config default applies (no workspace override).
  ConfigDefault,
  /// No quota — unlimited storage.
  Unlimited,
}

impl From<myoxus_application::quota::QuotaSource> for QuotaSourceGqlType {
  fn from(source: myoxus_application::quota::QuotaSource) -> Self {
    use myoxus_application::quota::QuotaSource;
    match source {
      QuotaSource::WorkspaceOverride => Self::WorkspaceOverride,
      QuotaSource::ConfigDefault => Self::ConfigDefault,
      QuotaSource::Unlimited => Self::Unlimited,
    }
  }
}

/// Full quota state for a single workspace — returned by `adminWorkspaceQuotaDetails`.
///
/// Exposes the raw values at every level of the priority hierarchy alongside
/// the resolved effective quota and current usage, so the admin inspector can
/// display both the active source and all configured overrides at a glance.
#[derive(async_graphql::SimpleObject, Clone, Debug)]
#[graphql(name = "WorkspaceQuotaDetailsType")]
pub struct WorkspaceQuotaDetailsType {
  /// Workspace-level storage override in bytes. `null` = not set.
  #[graphql(name = "workspaceOverrideBytes")]
  pub workspace_override_bytes: Option<i64>,
  /// Config-level default in megabytes (server config). 0 = unlimited at config level.
  #[graphql(name = "configDefaultMb")]
  pub config_default_mb: i64,
  /// Resolved effective quota in bytes. 0 = unlimited.
  #[graphql(name = "effectiveBytes")]
  pub effective_bytes: i64,
  /// Current total storage usage in bytes (snapshot + blob).
  #[graphql(name = "usedBytes")]
  pub used_bytes: i64,
  /// Which level of the hierarchy determined the effective quota.
  pub source: QuotaSourceGqlType,
}

/// Input for the `adminUpdateWorkspace` mutation (all fields optional).
///
/// ## Storage quota semantics (P112-QUOTA-C-05)
///
/// | `storageQuotaMb`      | `clearStorageQuota` | Result |
/// |----------------------|---------------------|--------|
/// | absent / `null`      | absent / `false`    | quota unchanged |
/// | `Some(n)` where n > 0 | absent / `false`  | quota set to n MB |
/// | any                  | `true`              | quota cleared (→ NULL) |
/// | `0`                  | absent / `false`    | quota cleared (same as clear=true) |
///
/// The deprecated `storageQuotaBytes` field is accepted for backwards compatibility
/// but values ≥ 2 GiB may have precision issues client-side. Prefer `storageQuotaMb`.
/// When `storageQuotaMb` is set, `storageQuotaBytes` is ignored.
#[derive(async_graphql::InputObject, Clone)]
pub struct AdminUpdateWorkspaceInput {
  pub id: String,
  #[graphql(validator(max_length = 255))]
  pub name: Option<String>,
  pub avatar_key: Option<String>,
  pub public: Option<bool>,
  pub enable_ai: Option<bool>,
  pub enable_sharing: Option<bool>,
  pub enable_url_preview: Option<bool>,
  pub enable_doc_embedding: Option<bool>,
  pub features: Option<Vec<auth::FeatureType>>,
  /// Per-workspace storage quota override in **megabytes**.
  /// Use `0` or set `clearStorageQuota = true` to remove the override.
  /// Values > 2,097,151 MB (~2 TiB) are rejected.
  #[graphql(name = "storageQuotaMb")]
  pub storage_quota_mb: Option<i32>,
  /// Explicitly clear the workspace storage quota override, reverting to the
  /// server config default. When `true`, `storageQuotaMb` is ignored.
  #[graphql(name = "clearStorageQuota")]
  pub clear_storage_quota: Option<bool>,
  /// **Deprecated** — use `storageQuotaMb` instead.
  /// Per-workspace storage quota override in bytes. NULL = inherit from global default.
  /// Ignored when `storageQuotaMb` is also present.
  #[graphql(name = "storageQuotaBytes")]
  pub storage_quota_bytes: Option<i64>,
}

#[derive(Clone)]
pub struct AdminWorkspaceType {
  pub id: String,
  pub name: Option<String>,
  pub public: bool,
  pub created_at: DateTime<Utc>,
  pub enable_ai: bool,
  pub enable_sharing: bool,
  pub enable_url_preview: bool,
  pub enable_doc_embedding: bool,
  pub owner: Option<AdminWorkspaceOwnerType>,
  pub owner_principal_type: String,
  pub owner_principal_id: Option<String>,
  pub owner_principal_name: Option<String>,
  pub features: Vec<auth::FeatureType>,
  /// Per-workspace storage quota override in bytes. NULL = inherit from global default.
  pub storage_quota_bytes: Option<i64>,
  pub git_sync_profile_id: Option<String>,
  pub git_sync_trigger_mode: Option<String>,
  pub git_sync_next_scheduled_at: Option<DateTime<Utc>>,
  pub git_sync_last_status: Option<String>,
  pub git_sync_last_run_at: Option<DateTime<Utc>>,
  pub git_sync_token_rotation_provider: Option<crate::graphql::git_sync::GitTokenRotationProviderType>,
  pub git_sync_token_rotation_enabled: Option<bool>,
  pub git_sync_token_rotation_state: Option<crate::graphql::git_sync::GitTokenRotationStateType>,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminWorkspaceSharedLinkType {
  pub workspace_id: String,
  pub doc_id: String,
  pub title: Option<String>,
  pub public_mode: String,
  pub status: String,
  pub share_url: String,
  pub published_at: Option<DateTime<Utc>>,
}

#[derive(async_graphql::SimpleObject, Clone)]
pub struct AdminWorkspaceOwnerType {
  pub id: String,
  pub name: String,
  pub email: String,
  pub avatar_url: Option<String>,
}

#[async_graphql::Object(name = "AdminWorkspaceType")]
impl AdminWorkspaceType {
  async fn id(&self) -> &str {
    &self.id
  }
  async fn name(&self) -> Option<&str> {
    self.name.as_deref()
  }
  async fn public(&self) -> bool {
    self.public
  }
  async fn created_at(&self) -> DateTime<Utc> {
    self.created_at
  }
  async fn enable_ai(&self) -> bool {
    self.enable_ai
  }
  async fn enable_sharing(&self) -> bool {
    self.enable_sharing
  }
  async fn enable_url_preview(&self) -> bool {
    self.enable_url_preview
  }
  async fn enable_doc_embedding(&self) -> bool {
    self.enable_doc_embedding
  }
  async fn avatar_key(&self) -> Option<&str> {
    None
  }
  async fn features(&self) -> Vec<auth::FeatureType> {
    self.features.clone()
  }
  async fn owner(&self) -> Option<AdminWorkspaceOwnerType> {
    self.owner.clone()
  }
  #[graphql(name = "ownerPrincipalType")]
  async fn owner_principal_type(&self) -> &str {
    &self.owner_principal_type
  }
  #[graphql(name = "ownerPrincipalId")]
  async fn owner_principal_id(&self) -> Option<&str> {
    self.owner_principal_id.as_deref()
  }
  #[graphql(name = "ownerPrincipalName")]
  async fn owner_principal_name(&self) -> Option<&str> {
    self.owner_principal_name.as_deref()
  }
  /// Per-workspace storage quota override in bytes. NULL = inherit from global default.
  #[graphql(name = "storageQuotaBytes")]
  async fn storage_quota_bytes(&self) -> Option<i64> {
    self.storage_quota_bytes
  }
  /// Total storage used by this workspace (snapshot_size + blob_size) in bytes.
  #[graphql(name = "storageQuotaUsed")]
  async fn storage_quota_used(&self, ctx: &Context<'_>) -> Result<i64> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let ws_id = uuid::Uuid::parse_str(&self.id).map_err(|_| async_graphql::Error::new("invalid id"))?;
    state
      .admin()
      .workspace_storage_stats(ws_id)
      .await
      .map(|stats| stats.total_size())
      .map_err(|error| async_graphql::Error::new(format!("storage stats query failed: {error}")))
  }
  async fn member_count(&self, ctx: &Context<'_>) -> Result<i32> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let workspace_id =
      uuid::Uuid::parse_str(&self.id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let count = state
      .workspace()
      .member_count(workspace_id)
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(count as i32)
  }
  async fn members(
    &self,
    ctx: &Context<'_>,
    skip: Option<i32>,
    take: Option<i32>,
    query: Option<String>,
  ) -> Result<Vec<auth::WorkspaceMemberType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    super::ensure_admin(ctx, state).await?;
    let workspace_id =
      uuid::Uuid::parse_str(&self.id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
    let members = state
      .workspace()
      .list_members(
        workspace_id,
        i64::from(skip.unwrap_or(0)),
        i64::from(take.unwrap_or(20)),
        query,
      )
      .await
      .map_err(crate::graphql::utils::map_gql_error)?;
    Ok(members.into_iter().map(auth::WorkspaceMemberType::from_model).collect())
  }
  async fn shared_links(&self, ctx: &Context<'_>) -> Result<Vec<AdminWorkspaceSharedLinkType>> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
    let ws_id = uuid::Uuid::parse_str(&self.id).map_err(|_| async_graphql::Error::new("invalid id"))?;
    let docs = state
      .doc()
      .list_public_docs(ws_id)
      .await
      .map_err(|error| async_graphql::Error::new(format!("shared links query failed: {error}")))?;
    Ok(
      docs
        .into_iter()
        .filter_map(|doc| {
          let public_mode = doc.public_mode?;
          let doc_id = doc.external_id;
          let share_url = format!(
            "{}/public/{}/{}",
            state.config.server.origin.trim_end_matches('/'),
            self.id,
            doc_id
          );
          Some(AdminWorkspaceSharedLinkType {
            workspace_id: self.id.clone(),
            doc_id,
            title: (!doc.title.is_empty()).then_some(doc.title),
            public_mode,
            status: "active".to_string(),
            share_url,
            published_at: Some(doc.updated_at),
          })
        })
        .collect(),
    )
  }
  async fn public_page_count(&self, ctx: &Context<'_>) -> Result<i32> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let ws_id = uuid::Uuid::parse_str(&self.id).map_err(|_| async_graphql::Error::new("invalid id"))?;
    Ok(state.doc().list_public_docs(ws_id).await.unwrap_or_default().len() as i32)
  }
  async fn snapshot_count(&self, ctx: &Context<'_>) -> Result<i32> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let ws_id = uuid::Uuid::parse_str(&self.id).map_err(|_| async_graphql::Error::new("invalid id"))?;
    Ok(
      state
        .admin()
        .workspace_storage_stats(ws_id)
        .await
        .unwrap_or_default()
        .snapshot_count as i32,
    )
  }
  async fn snapshot_size(&self, ctx: &Context<'_>) -> Result<i64> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let ws_id = uuid::Uuid::parse_str(&self.id).map_err(|_| async_graphql::Error::new("invalid id"))?;
    Ok(
      state
        .admin()
        .workspace_storage_stats(ws_id)
        .await
        .unwrap_or_default()
        .snapshot_size,
    )
  }
  async fn blob_count(&self, ctx: &Context<'_>) -> Result<i32> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let ws_id = uuid::Uuid::parse_str(&self.id).map_err(|_| async_graphql::Error::new("invalid id"))?;
    Ok(
      state
        .admin()
        .workspace_storage_stats(ws_id)
        .await
        .unwrap_or_default()
        .blob_count as i32,
    )
  }
  async fn blob_size(&self, ctx: &Context<'_>) -> Result<i64> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let ws_id = uuid::Uuid::parse_str(&self.id).map_err(|_| async_graphql::Error::new("invalid id"))?;
    Ok(
      state
        .admin()
        .workspace_storage_stats(ws_id)
        .await
        .unwrap_or_default()
        .blob_size,
    )
  }
  /// Whether this is the user's single canonical personal userspace.
  #[graphql(name = "isPersonal")]
  async fn is_personal(&self, ctx: &Context<'_>) -> Result<bool> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let ws_id = uuid::Uuid::parse_str(&self.id).map_err(|_| async_graphql::Error::new("invalid id"))?;
    let classification = state
      .workspace()
      .workspace_classification(ws_id)
      .await
      .map_err(|error| async_graphql::Error::new(format!("personal workspace query failed: {error}")))?;
    Ok(matches!(
      classification,
      Some(myoxus_application::workspace::WorkspaceClassification::Personal)
    ))
  }
  /// Computed workspace type: "Personal", "UserOwned", or "Shared".
  #[graphql(name = "workspaceType")]
  async fn workspace_type(&self, ctx: &Context<'_>) -> Result<String> {
    let state = ctx
      .data::<Arc<crate::state::ApiState>>()
      .map_err(|_| "ApiState missing")?;
    let ws_id = uuid::Uuid::parse_str(&self.id).map_err(|_| async_graphql::Error::new("invalid id"))?;

    let classification = state
      .workspace()
      .workspace_classification(ws_id)
      .await
      .map_err(|error| async_graphql::Error::new(format!("workspace type query failed: {error}")))?;
    Ok(
      match classification {
        Some(myoxus_application::workspace::WorkspaceClassification::Personal) => "Personal",
        Some(myoxus_application::workspace::WorkspaceClassification::Shared) => "Shared",
        _ => "UserOwned",
      }
      .to_string(),
    )
  }

  /// ID of the active Git Sync profile for this workspace.
  #[graphql(name = "gitSyncProfileId")]
  async fn git_sync_profile_id(&self) -> Option<&str> {
    self.git_sync_profile_id.as_deref()
  }
  /// Whether this workspace has an active Git Sync profile.
  #[graphql(name = "gitSyncEnabled")]
  async fn git_sync_enabled(&self) -> bool {
    self.git_sync_profile_id.is_some()
  }
  /// Last Git Sync run status (Completed/Failed/Running/null).
  #[graphql(name = "gitSyncLastStatus")]
  async fn git_sync_last_status(&self) -> Option<&str> {
    self.git_sync_last_status.as_deref()
  }

  #[graphql(name = "gitSyncTriggerMode")]
  async fn git_sync_trigger_mode(&self) -> Option<&str> {
    self.git_sync_trigger_mode.as_deref()
  }

  #[graphql(name = "gitSyncNextScheduledAt")]
  async fn git_sync_next_scheduled_at(&self) -> Option<DateTime<Utc>> {
    self.git_sync_next_scheduled_at
  }
  /// Timestamp of the latest Git Sync run for this workspace.
  #[graphql(name = "gitSyncLastRunAt")]
  async fn git_sync_last_run_at(&self) -> Option<DateTime<Utc>> {
    self.git_sync_last_run_at
  }

  #[graphql(name = "gitSyncTokenRotationProvider")]
  async fn git_sync_token_rotation_provider(&self) -> Option<crate::graphql::git_sync::GitTokenRotationProviderType> {
    self.git_sync_token_rotation_provider
  }

  #[graphql(name = "gitSyncTokenRotationEnabled")]
  async fn git_sync_token_rotation_enabled(&self) -> Option<bool> {
    self.git_sync_token_rotation_enabled
  }

  #[graphql(name = "gitSyncTokenRotationState")]
  async fn git_sync_token_rotation_state(&self) -> Option<crate::graphql::git_sync::GitTokenRotationStateType> {
    self.git_sync_token_rotation_state
  }
}

#[derive(async_graphql::SimpleObject)]
#[graphql(name = "GitSyncStorageUsageType")]
pub struct GitSyncStorageUsageType {
  pub total_bytes: i64,
  pub repo_count: i32,
  pub free_bytes: i64,
  pub capacity_bytes: i64,
  pub limit_bytes: i64,
  pub usage_percent: f64,
}
