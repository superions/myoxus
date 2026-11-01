mod models;
pub mod updates;
pub use models::*;
pub use updates::*;

use crate::database::*;
use crate::repositories::RepoResult;
use crate::workspace_tags::WorkspaceTag;
use async_trait::async_trait;
use std::collections::HashMap;

/// Database lifecycle and native field-definition persistence.
#[async_trait]
#[allow(clippy::too_many_arguments)]
pub trait DatabaseDefinitionRepository: Send + Sync {
  async fn published_workspace_ids(&self, after: Option<WorkspaceId>, limit: i64) -> RepoResult<Vec<WorkspaceId>>;
  async fn managed_database_ids(&self, after: Option<DatabaseId>, limit: i64) -> RepoResult<Vec<DatabaseId>>;
  async fn ensure_workspace_tasks(&self, state: DatabaseInitialState) -> RepoResult<DatabaseRecord>;
  async fn commit_managed_schema(
    &self,
    database_id: DatabaseId,
    expected_source: &DatabaseRecord,
    replacement: Option<DatabaseInitialState>,
    installation: DatabaseManagedSchemaInstallation,
  ) -> RepoResult<Vec<DatabaseRowId>>;

  async fn create_database(&self, state: DatabaseInitialState) -> RepoResult<DatabaseRecord>;

  async fn get_database(&self, database_id: DatabaseId) -> RepoResult<Option<DatabaseRecord>>;

  /// Resolve a Database regardless of lifecycle state. This is intentionally
  /// separate from normal active-only reads so trashed content cannot leak
  /// back into product surfaces.
  async fn get_database_for_lifecycle(&self, database_id: DatabaseId) -> RepoResult<Option<DatabaseRecord>>;

  async fn update_database(
    &self,
    database_id: DatabaseId,
    title: Option<String>,
    description: Option<Option<String>>,
    updated_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRecord>;

  async fn trash_database(
    &self,
    database_id: DatabaseId,
    deleted_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRecord>;

  async fn restore_database(
    &self,
    database_id: DatabaseId,
    restored_by: UserId,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseRecord>;

  /// Permanently delete a Database bundle. Product callers must validate that
  /// the root is already trashed; import rollback paths may use this primitive
  /// for a Database that was never exposed to users.
  async fn purge_database(&self, database_id: DatabaseId, precondition: DatabaseEditPrecondition) -> RepoResult<()>;

  async fn create_field(
    &self,
    field: DatabaseField,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseField>;

  async fn update_field(
    &self,
    field_id: DatabaseFieldId,
    name: Option<String>,
    config: Option<DatabaseFieldConfig>,
    required: Option<bool>,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<DatabaseField>;

  async fn delete_field(&self, field_id: DatabaseFieldId, precondition: DatabaseEditPrecondition) -> RepoResult<()>;

  async fn reorder_fields(
    &self,
    database_id: DatabaseId,
    field_ids: Vec<DatabaseFieldId>,
    expected_edit_revisions: &HashMap<DatabaseFieldId, i64>,
    force: bool,
    precondition: DatabaseEditPrecondition,
  ) -> RepoResult<Vec<DatabaseField>>;

  /// P-DB-29R: return every field for the given database in stable
  /// order (position, then id). The default implementation reuses
  /// the canonical `get_database` projection; production repositories
  /// may override this when the full record fetch becomes too heavy.

  async fn list_fields(&self, database_id: DatabaseId) -> RepoResult<Vec<DatabaseField>> {
    let record = self.get_database(database_id).await?;
    Ok(record.map(|record| record.fields).unwrap_or_default())
  }
}

/// Complete native creation state, persisted atomically by the definition owner.
#[derive(Debug, Clone)]
pub struct DatabaseInitialState {
  pub database: Database,
  pub fields: Vec<DatabaseField>,
  pub views: Vec<DatabaseView>,
  pub roles: Vec<DatabaseFieldRole>,
  pub view_roles: Vec<DatabaseViewRole>,
  pub rows: Vec<DatabaseRowRecord>,
  pub row_templates: Vec<DatabaseRowTemplate>,
  pub workspace_tags: Vec<WorkspaceTag>,
}

pub mod managed_schema;
pub use managed_schema::*;
