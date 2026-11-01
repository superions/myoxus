use crate::database::*;
use crate::repositories::{PageRequest, RepoResult, RepositoryError};
use async_trait::async_trait;

#[async_trait]
#[allow(clippy::too_many_arguments)]
pub trait DatabaseViewRepository: Send + Sync {
  async fn task_destinations(
    &self,
    workspace_id: WorkspaceId,
    first: i64,
    after: Option<DatabaseId>,
  ) -> RepoResult<DatabaseTaskDestinations>;
  async fn create_view(&self, view: DatabaseView, precondition: DatabaseEditPrecondition) -> RepoResult<DatabaseView>;

  async fn update_view(
    &self,
    view_id: DatabaseViewId,
    name: Option<String>,
    view_kind: Option<DatabaseViewKind>,
    icon: Option<Option<DatabaseViewIcon>>,
    config: Option<DatabaseViewConfig>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseView>;

  /// Delete a view and, when it owns a required profile role, move that role
  /// to its validated replacement in the same transaction.
  async fn delete_view(
    &self,
    view_id: DatabaseViewId,
    precondition: DatabaseEditPrecondition,
    replacement_role: Option<DatabaseViewRole>,
  ) -> RepoResult<()>;

  /// Reorder the complete view set atomically. Every supplied view revision is
  /// checked while all rows are locked; a stale member aborts the whole order.
  async fn reorder_views(
    &self,
    database_id: DatabaseId,
    view_ids: Vec<DatabaseViewId>,
    expected_edit_revisions: &HashMap<DatabaseViewId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<DatabaseView>>;

  async fn task_parent(
    &self,
    _database_id: DatabaseId,
    _row_id: DatabaseRowId,
  ) -> RepoResult<DatabaseTaskParentProjection> {
    Err(RepositoryError::Storage("Task parent projection unsupported".into()))
  }

  /// Read capability, canonical live children and status counts in one snapshot.
  async fn task_children(&self, _read: DatabaseTaskChildrenRead) -> RepoResult<DatabaseTaskChildrenPage> {
    Err(RepositoryError::Storage("Task children projection unsupported".into()))
  }

  async fn task_blocking(&self, _read: DatabaseTaskBlockingRead) -> RepoResult<DatabaseTaskBlockingPage> {
    Err(RepositoryError::Storage("Task blocking projection unsupported".into()))
  }

  /// Apply workspace authorization, role filters, order and count before paging.
  async fn list_workspace_tasks(&self, _read: DatabaseTasksRead) -> RepoResult<DatabaseTasksPage> {
    Err(RepositoryError::Storage(
      "workspace task query is unavailable".to_string(),
    ))
  }

  /// Read only admitted explicit native pairs; lifecycle/cockpit filters do
  /// not hide a closed Task or turn a trashed Project into a missing identity.
  async fn list_workspace_task_references(
    &self,
    _read: DatabaseTaskReferencesRead,
  ) -> RepoResult<Vec<DatabaseTaskReferenceRecord>> {
    Err(RepositoryError::Storage("workspace task references unavailable".into()))
  }

  /// List count-free Database page identities for a workspace lifecycle slice.
  async fn list_database_page_identities(
    &self,
    workspace_id: WorkspaceId,
    page: PageRequest,
    lifecycle: DatabaseLifecycleFilter,
  ) -> RepoResult<Vec<DatabasePageIdentity>>;

  /// Return the current durable revision for lightweight Database inventories.
  async fn database_page_inventory_revision(&self, _workspace_id: WorkspaceId) -> RepoResult<i64> {
    Err(RepositoryError::Storage(
      "database page inventory revisions are unavailable".to_string(),
    ))
  }

  /// Read one inventory page and its revision from a consistent snapshot.
  async fn list_database_page_identities_versioned(
    &self,
    _workspace_id: WorkspaceId,
    _page: PageRequest,
    _lifecycle: DatabaseLifecycleFilter,
  ) -> RepoResult<DatabasePageIdentitySnapshot> {
    Err(RepositoryError::Storage(
      "versioned database page inventories are unavailable".to_string(),
    ))
  }

  async fn list_databases(
    &self,
    workspace_id: WorkspaceId,
    page: PageRequest,
    filter: DatabaseInventoryFilter,
  ) -> RepoResult<Vec<DatabaseSummary>>;

  async fn get_database_summary(
    &self,
    database_id: DatabaseId,
    lifecycle: DatabaseLifecycleFilter,
  ) -> RepoResult<Option<DatabaseSummary>>;

  /// Enumerate canonical workspace/Database scopes for global operational
  /// reindexing without leaking physical table names into API adapters.
  async fn list_database_scopes(&self, page: PageRequest) -> RepoResult<Vec<(WorkspaceId, DatabaseId)>> {
    let _ = page;
    RepoResult::Ok(Vec::new())
  }

  async fn get_view_user_state(
    &self,
    view_id: DatabaseViewId,
    user_id: UserId,
  ) -> RepoResult<Option<DatabaseViewUserState>>;

  async fn upsert_view_user_state(
    &self,
    state: DatabaseViewUserState,
    expected_edit_revision: Option<i64>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseViewUserState>;

  async fn reset_view_user_state(
    &self,
    view_id: DatabaseViewId,
    user_id: UserId,
    expected_edit_revision: Option<i64>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<()>;

  /// Promote one actor's exploratory query state into the shared view and
  /// remove that personal state in the same transaction. Both revisions are
  /// checked under row locks so callers cannot observe a partially promoted
  /// state after a conflict or storage failure.
  async fn promote_view_user_state(
    &self,
    view_id: DatabaseViewId,
    user_id: UserId,
    config: DatabaseViewConfig,
    expected_view_edit_revision: i64,
    expected_state_edit_revision: i64,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseView>;

  async fn list_rows(&self, database_id: DatabaseId, page: PageRequest) -> RepoResult<Vec<DatabaseRowRecord>>;

  /// Execute the complete validated query before cursor pagination and return
  /// a count from the same read boundary. Implementations must never emulate
  /// this contract by loading the full Database into Application memory.
  async fn list_rows_filtered_paged(
    &self,
    database_id: DatabaseId,
    actor_id: UserId,
    query: DatabaseRowsQuery,
    page: PageRequest,
  ) -> RepoResult<DatabaseFilteredRowsPage>;

  async fn aggregate_row_groups(
    &self,
    database_id: DatabaseId,
    actor_id: UserId,
    query: DatabaseRowsQuery,
    group_field_id: DatabaseFieldId,
    subgroup_field_id: Option<DatabaseFieldId>,
  ) -> RepoResult<Vec<DatabaseRowGroupCount>>;

  async fn aggregate_progress(
    &self,
    database_id: DatabaseId,
    actor_id: UserId,
    query: DatabaseRowsQuery,
    spec: DatabaseProgressAggregateSpec,
  ) -> RepoResult<Vec<DatabaseProgressAggregateCount>>;

  async fn count_rows(&self, database_id: DatabaseId) -> RepoResult<i64>;
}

mod models;
mod select_updates;
pub use models::*;
pub use select_updates::{map_select_filter_group, map_select_view_group_keys};
pub mod tasks;
pub use tasks::*;

pub(super) use models::{default_show_empty_cover, default_show_field_labels};
