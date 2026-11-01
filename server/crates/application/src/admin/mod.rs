//! Server administration service.
//!
//! [`AdminService`] provides privileged operations accessible only to server
//! administrators: listing all users and workspaces, granting/revoking admin
//! status, and deleting workspaces.  These are surfaced via the admin
//! GraphQL API.

use crate::auth::AuthResult;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_domain::entities::{User, Workspace};
use tracing::{info, instrument, warn};
use uuid::Uuid;

mod users;
pub use users::{AdminUserCreationError, AdminUserProfile, AdminUserService};

/// Lightweight workspace search hit — returned by [`AdminStore::search_workspaces`].
///
/// Carries just enough metadata to power admin pickers (`P-AR-0-S03`):
/// workspace identity, owner snapshot, and the set of OUs the workspace
/// is linked to (any relationship — `owner` / `managed` / `linked`).
#[derive(Debug, Clone)]
pub struct WorkspaceSearchRow {
  pub id: Uuid,
  pub name: String,
  pub owner_user_id: Option<Uuid>,
  pub owner_email: Option<String>,
  pub linked_ou_ids: Vec<Uuid>,
}

/// Lightweight user search hit — returned by [`AdminStore::search_users`].
///
/// Powers the admin and manager user-pickers (`P-AR-0-S02`). Carries
/// identity, email/name snapshot, the active feature names, plus
/// `is_admin`/`disabled` flags. The GraphQL surface decides which subset
/// is exposed (admin sees everything, manager-mode strips admin/disabled).
#[derive(Debug, Clone)]
pub struct UserSearchRow {
  pub id: Uuid,
  pub email: String,
  pub name: String,
  /// Activated user features (e.g. `manager`, `early_access`). Empty
  /// when the user has no `user_features` rows with `activated = true`.
  pub features: Vec<String>,
  pub is_admin: bool,
  pub disabled: bool,
}

/// Storage counters shown by the administrative workspace projection.
#[derive(Debug, Clone, Copy, Default, Eq, PartialEq)]
pub struct AdminWorkspaceStorageStats {
  pub snapshot_count: i64,
  pub snapshot_size: i64,
  pub blob_count: i64,
  pub blob_size: i64,
}

/// Published-document analytics projected for Admin shared-link surfaces.
#[derive(Debug, Clone)]
pub struct AdminSharedLinkStats {
  pub workspace_id: Uuid,
  pub doc_id: String,
  pub title: String,
  pub published_at: Option<DateTime<Utc>>,
  pub doc_updated_at: Option<DateTime<Utc>>,
  pub workspace_owner_id: Option<Uuid>,
  pub last_updater_id: Option<Uuid>,
  pub total_views: i64,
  pub unique_views: i64,
  pub guest_views: i64,
  pub last_viewed_at: Option<DateTime<Utc>>,
}

/// Filter and pagination for the Admin shared-link inventory.
#[derive(Debug, Clone, Default)]
pub struct AdminSharedLinkFilter {
  pub workspace_id: Option<Uuid>,
  pub keyword: Option<String>,
  pub limit: i64,
  pub offset: i64,
}

/// Database-backed portion of the operational Admin dashboard.
#[derive(Debug, Clone, Default)]
pub struct AdminDashboardProjection {
  pub sync_active_users: i64,
  pub workspace_storage_bytes: i64,
  pub blob_storage_bytes: i64,
  pub sync_active_users_timeline: Vec<(DateTime<Utc>, i32)>,
  pub workspace_storage_history: Vec<(DateTime<Utc>, i64)>,
  pub blob_storage_history: Vec<(DateTime<Utc>, i64)>,
  pub top_shared_links: Vec<AdminSharedLinkStats>,
}

/// Extended ownership and Git-Sync fields for one Admin workspace row.
#[derive(Debug, Clone)]
pub struct AdminWorkspaceDetails {
  pub storage_quota_bytes: Option<i64>,
  pub owner_principal_type: String,
  pub owner_principal_id: Option<Uuid>,
  pub owner_principal_name: Option<String>,
  pub git_sync_profile_id: Option<Uuid>,
  pub git_sync_trigger_mode: Option<String>,
  pub git_sync_next_scheduled_at: Option<DateTime<Utc>>,
  pub git_sync_last_status: Option<String>,
  pub git_sync_last_run_at: Option<DateTime<Utc>>,
}

impl AdminWorkspaceStorageStats {
  pub fn total_size(self) -> i64 {
    self.snapshot_size.saturating_add(self.blob_size)
  }
}

/// Filter parameters for admin workspace listing.
#[derive(Debug, Clone, Default)]
pub struct AdminWorkspaceFilter {
  pub skip: i64,
  pub take: i64,
  pub query: Option<String>,
  pub public: Option<bool>,
  pub enable_ai: Option<bool>,
  pub enable_sharing: Option<bool>,
  pub enable_url_preview: Option<bool>,
  pub enable_doc_embedding: Option<bool>,
  pub is_personal: Option<bool>,
  /// Canonical server-owned classification: Personal, UserOwned, or Shared.
  pub workspace_type: Option<String>,
  pub member_count_min: Option<i64>,
  pub member_count_max: Option<i64>,
  pub git_sync_enabled: Option<bool>,
  pub git_sync_last_status: Option<String>,
  pub order_by: Option<String>,
}

/// Storage port for privileged administrative queries.
#[async_trait]
pub trait AdminStore: Send + Sync {
  /// List all registered users with optional name/email filter.
  async fn list_users(&self, skip: i64, take: i64, query: Option<String>) -> AuthResult<Vec<User>>;
  /// Count all registered users matching the filter.
  async fn count_users(&self, query: Option<String>) -> AuthResult<i64>;

  /// Exact indexed identity reads, including persisted administrative timestamps.
  async fn get_user_by_id(&self, user_id: Uuid) -> AuthResult<Option<User>>;
  async fn get_user_by_email(&self, email: &str) -> AuthResult<Option<User>>;

  /// List all workspaces with filter.
  async fn list_workspaces_filtered(&self, filter: AdminWorkspaceFilter) -> AuthResult<Vec<Workspace>>;
  /// Count all workspaces matching the filter.
  async fn count_workspaces_filtered(&self, filter: &AdminWorkspaceFilter) -> AuthResult<i64>;
  /// Fetch a single workspace by ID.
  async fn get_workspace(&self, workspace_id: Uuid) -> AuthResult<Option<Workspace>>;
  /// Return persisted snapshot/blob counters for one workspace.
  async fn workspace_storage_stats(&self, workspace_id: Uuid) -> AuthResult<AdminWorkspaceStorageStats>;
  /// Count shared links matching the Admin inventory filter.
  async fn count_shared_links(&self, filter: &AdminSharedLinkFilter) -> AuthResult<i64>;
  /// List shared links with their bounded analytics projection.
  async fn list_shared_links(&self, filter: AdminSharedLinkFilter) -> AuthResult<Vec<AdminSharedLinkStats>>;
  /// Read the database-backed operational dashboard projection.
  async fn dashboard_projection(&self, sync_hours: i32, storage_days: i32) -> AuthResult<AdminDashboardProjection>;
  /// Return extended fields for one Admin workspace projection.
  async fn workspace_details(&self, workspace_id: Uuid) -> AuthResult<Option<AdminWorkspaceDetails>>;

  /// Substring-search workspaces by name (case-insensitive). Optionally
  /// filter to workspaces linked to a specific OU or exclude workspaces that
  /// are already linked to one OU.
  ///
  /// Used by the admin workspace-picker (`P-AR-0-S03`). Returns lightweight
  /// rows including owner-email snapshot and all linked OU ids.
  async fn search_workspaces(
    &self,
    query: &str,
    ou_id: Option<Uuid>,
    exclude_ou_id: Option<Uuid>,
    limit: i64,
  ) -> AuthResult<Vec<WorkspaceSearchRow>>;

  /// Substring-search users by email or name (case-insensitive). When
  /// `features` is `Some(non-empty)`, only users that have ALL of the
  /// listed features active are returned.
  ///
  /// Used by the admin/manager user-pickers (`P-AR-0-S02`). Returns
  /// lightweight rows including the activated feature names and the
  /// `is_admin` / `disabled` flags.
  async fn search_users(&self, query: &str, features: Option<&[String]>, limit: i64) -> AuthResult<Vec<UserSearchRow>>;

  /// Delete (or soft-delete) a workspace as an administrative action.
  async fn delete_workspace(&self, workspace_id: Uuid) -> AuthResult<()>;
  /// Upsert a one-minute active-user metric sample for a workspace.
  async fn upsert_active_users_metric(
    &self,
    workspace_id: Uuid,
    minute: chrono::DateTime<chrono::Utc>,
    count: i32,
  ) -> AuthResult<()>;
}

/// High-level administration service.
#[derive(Clone)]
pub struct AdminService {
  store: std::sync::Arc<dyn AdminStore>,
}

impl AdminService {
  /// Construct an `AdminService`.
  pub fn new(store: std::sync::Arc<dyn AdminStore>) -> Self {
    Self { store }
  }

  /// List users (with pagination and optional search filter).
  #[instrument(skip(self))]
  pub async fn list_users(&self, skip: i64, take: i64, query: Option<String>) -> AuthResult<Vec<User>> {
    info!(skip, take, ?query, "listing users for admin");
    self.store.list_users(skip, take, query).await
  }

  /// Count users matching an optional search filter.
  #[instrument(skip(self))]
  pub async fn count_users(&self, query: Option<String>) -> AuthResult<i64> {
    self.store.count_users(query).await
  }

  /// List workspaces with full filter support.
  #[instrument(skip(self))]
  pub async fn list_workspaces(&self, filter: AdminWorkspaceFilter) -> AuthResult<Vec<Workspace>> {
    info!(?filter, "listing workspaces for admin");
    self.store.list_workspaces_filtered(filter).await
  }

  /// Count workspaces matching a filter.
  #[instrument(skip(self))]
  pub async fn count_workspaces(&self, filter: &AdminWorkspaceFilter) -> AuthResult<i64> {
    self.store.count_workspaces_filtered(filter).await
  }

  /// Fetch a workspace by ID.
  #[instrument(skip(self))]
  pub async fn get_workspace(&self, workspace_id: Uuid) -> AuthResult<Option<Workspace>> {
    self.store.get_workspace(workspace_id).await
  }

  /// Return the storage counters projected by the admin workspace surface.
  pub async fn workspace_storage_stats(&self, workspace_id: Uuid) -> AuthResult<AdminWorkspaceStorageStats> {
    self.store.workspace_storage_stats(workspace_id).await
  }

  pub async fn count_shared_links(&self, filter: &AdminSharedLinkFilter) -> AuthResult<i64> {
    self.store.count_shared_links(filter).await
  }

  pub async fn list_shared_links(&self, filter: AdminSharedLinkFilter) -> AuthResult<Vec<AdminSharedLinkStats>> {
    self.store.list_shared_links(filter).await
  }

  pub async fn dashboard_projection(&self, sync_hours: i32, storage_days: i32) -> AuthResult<AdminDashboardProjection> {
    self.store.dashboard_projection(sync_hours, storage_days).await
  }

  pub async fn workspace_details(&self, workspace_id: Uuid) -> AuthResult<Option<AdminWorkspaceDetails>> {
    self.store.workspace_details(workspace_id).await
  }

  /// Substring-search workspaces by name. Optional `ou_id` restricts the
  /// hit set to workspaces linked to that OU (any relationship);
  /// `exclude_ou_id` removes workspaces already linked to that OU so add
  /// pickers cannot offer duplicate links. `limit` is clamped by the caller.
  #[instrument(skip(self))]
  pub async fn search_workspaces(
    &self,
    query: &str,
    ou_id: Option<Uuid>,
    exclude_ou_id: Option<Uuid>,
    limit: i64,
  ) -> AuthResult<Vec<WorkspaceSearchRow>> {
    info!(query = %query, ?ou_id, ?exclude_ou_id, limit, "admin: searching workspaces");
    self.store.search_workspaces(query, ou_id, exclude_ou_id, limit).await
  }

  /// Substring-search users by email/name. Optional `features` filter
  /// restricts hits to users with ALL listed user-features active.
  /// `limit` is clamped by the caller.
  #[instrument(skip(self))]
  pub async fn search_users(
    &self,
    query: &str,
    features: Option<&[String]>,
    limit: i64,
  ) -> AuthResult<Vec<UserSearchRow>> {
    info!(query = %query, ?features, limit, "admin: searching users");
    self.store.search_users(query, features, limit).await
  }

  /// Delete a workspace (privileged action, logged at WARN level).
  #[instrument(skip(self))]
  pub async fn delete_workspace(&self, workspace_id: Uuid) -> AuthResult<()> {
    warn!(%workspace_id, "administratively deleting workspace");
    self.store.delete_workspace(workspace_id).await
  }

  /// Record a one-minute active-user count sample for telemetry.
  #[instrument(skip(self))]
  pub async fn upsert_active_users_metric(
    &self,
    workspace_id: Uuid,
    minute: chrono::DateTime<chrono::Utc>,
    count: i32,
  ) -> AuthResult<()> {
    self.store.upsert_active_users_metric(workspace_id, minute, count).await
  }
}

/// No-op [`AdminStore`] used in test contexts.
pub struct InMemoryAdminStore;

#[async_trait]
impl AdminStore for InMemoryAdminStore {
  async fn get_user_by_id(&self, _user_id: Uuid) -> AuthResult<Option<User>> {
    Ok(None)
  }

  async fn get_user_by_email(&self, _email: &str) -> AuthResult<Option<User>> {
    Ok(None)
  }
  async fn list_users(&self, _skip: i64, _take: i64, _query: Option<String>) -> AuthResult<Vec<User>> {
    Ok(vec![])
  }
  async fn count_users(&self, _query: Option<String>) -> AuthResult<i64> {
    Ok(0)
  }
  async fn list_workspaces_filtered(&self, _filter: AdminWorkspaceFilter) -> AuthResult<Vec<Workspace>> {
    Ok(vec![])
  }
  async fn count_workspaces_filtered(&self, _filter: &AdminWorkspaceFilter) -> AuthResult<i64> {
    Ok(0)
  }
  async fn get_workspace(&self, _workspace_id: Uuid) -> AuthResult<Option<Workspace>> {
    Ok(None)
  }
  async fn workspace_storage_stats(&self, _workspace_id: Uuid) -> AuthResult<AdminWorkspaceStorageStats> {
    Ok(AdminWorkspaceStorageStats::default())
  }
  async fn count_shared_links(&self, _filter: &AdminSharedLinkFilter) -> AuthResult<i64> {
    Ok(0)
  }
  async fn list_shared_links(&self, _filter: AdminSharedLinkFilter) -> AuthResult<Vec<AdminSharedLinkStats>> {
    Ok(Vec::new())
  }
  async fn dashboard_projection(&self, _sync_hours: i32, _storage_days: i32) -> AuthResult<AdminDashboardProjection> {
    Ok(AdminDashboardProjection::default())
  }
  async fn workspace_details(&self, _workspace_id: Uuid) -> AuthResult<Option<AdminWorkspaceDetails>> {
    Ok(None)
  }
  async fn search_workspaces(
    &self,
    _query: &str,
    _ou_id: Option<Uuid>,
    _exclude_ou_id: Option<Uuid>,
    _limit: i64,
  ) -> AuthResult<Vec<WorkspaceSearchRow>> {
    Ok(vec![])
  }
  async fn search_users(
    &self,
    _query: &str,
    _features: Option<&[String]>,
    _limit: i64,
  ) -> AuthResult<Vec<UserSearchRow>> {
    Ok(vec![])
  }
  async fn delete_workspace(&self, _workspace_id: Uuid) -> AuthResult<()> {
    Ok(())
  }
  async fn upsert_active_users_metric(
    &self,
    _workspace_id: Uuid,
    _minute: chrono::DateTime<chrono::Utc>,
    _count: i32,
  ) -> AuthResult<()> {
    Ok(())
  }
}
