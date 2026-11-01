//! PostgreSQL invariants for the recoverable Database trash lifecycle.

use futures_util::FutureExt;
use myoxus_domain::database::{
  DatabaseDefinitionRepository, DatabaseEditingRepository, DatabaseProjectionRepository, DatabaseViewRepository,
};
use myoxus_domain::database::{DatabaseEditPrecondition, DatabaseInventoryFilter, DatabaseLifecycleFilter};
use myoxus_domain::repositories::{PageRequest, RepositoryError};
use myoxus_infrastructure::workspace_database::PgDatabaseRepository;
use sqlx::PgPool;
use uuid::Uuid;

async fn setup_pool() -> PgPool {
  let database_url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  let pool = PgPool::connect(&database_url)
    .await
    .expect("test postgres must be reachable");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("database migrations must apply");
  pool
}

/// Compare physical native children, including role/template and derived projections,
/// without normalizing away any persisted fact during Trash/Restore.
async fn database_children(pool: &PgPool, database_id: Uuid) -> serde_json::Value {
  let mut children = serde_json::Map::new();
  for table in [
    "database_profiles",
    "database_field_roles",
    "database_view_roles",
    "workspace_database_fields",
    "workspace_database_views",
    "workspace_database_rows",
    "workspace_database_cell_values",
    "workspace_database_row_templates",
    "database_unique_id_sequences",
    "workspace_database_row_search",
    "database_document_references",
    "workspace_database_formula_values",
    "workspace_database_rollup_values",
    "database_row_reminders",
  ] {
    let rows:serde_json::Value=sqlx::query_scalar(&format!(
      "SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY to_jsonb(item)::text),'[]'::jsonb) FROM {table} item WHERE database_id=$1"
    )).bind(database_id).fetch_one(pool).await.expect("read native child projection");
    children.insert(table.into(), rows);
  }
  let edges:serde_json::Value=sqlx::query_scalar("SELECT COALESCE(jsonb_agg(to_jsonb(edge) ORDER BY to_jsonb(edge)::text),'[]'::jsonb) FROM workspace_database_relation_edges edge WHERE source_database_id=$1 OR target_database_id=$1")
    .bind(database_id).fetch_one(pool).await.expect("read native graph projections");
  children.insert("workspace_database_relation_edges".into(), edges);
  serde_json::Value::Object(children)
}

#[tokio::test]
async fn database_trash_preserves_children_restore_recovers_and_purge_cascades() {
  let pool = setup_pool().await;
  let catalog = std::sync::Arc::new(
    myoxus_infrastructure::database_templates::load_database_template_catalog(
      &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
    )
    .expect("database catalog fixture"),
  );
  let repo = std::sync::Arc::new(PgDatabaseRepository::new(pool.clone(), catalog.clone()));
  let owner_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let row_id = Uuid::new_v4();
  let outcome = std::panic::AssertUnwindSafe(async {
    sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'Delete owner', 'active')")
      .bind(owner_id)
      .bind(format!("database-delete-{owner_id}@example.test"))
      .execute(&pool)
      .await
      .expect("seed owner");
    sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'Delete workspace')")
      .bind(workspace_id)
      .bind(owner_id)
      .execute(&pool)
      .await
      .expect("seed workspace");
    myoxus_application::workspace::tasks::WorkspaceTasksInitializer::new(
      catalog.clone(),
      repo.clone(),
      std::sync::Arc::new(myoxus_application::database::DatabaseProjectionService::new(
        repo.clone(),
        repo.clone(),
        repo.clone(),
        repo.clone(),
        myoxus_application::database::DatabaseLimits::default(),
      )),
    )
    .ensure(workspace_id, None)
    .await
    .expect("canonical default stays outside ordinary lifecycle inventory");
    let mut state =
      myoxus_application::workspace::tasks::workspace_tasks_initial_state(&catalog, workspace_id, Some(owner_id))
        .expect("complete current Project source state");
    state.database.system_role = None;
    state.database.title = "Delete project".into();
    let database_id = state.database.id;
    let field_id = state
      .roles
      .iter()
      .find(|role| role.role_key == "task.priority")
      .expect("installed priority binding")
      .field_id;
    let priority = match &state
      .fields
      .iter()
      .find(|field| field.id == field_id)
      .expect("bound priority Field")
      .config
    {
      myoxus_domain::database::DatabaseFieldConfig::Select(config) => config.options[0].id.clone(),
      _ => panic!("native priority is a Select"),
    };
    let expected_fields = state.fields.len() as i64;
    let expected_views = state.views.len() as i64;
    let expected_roles = state.roles.len();
    let expected_view_roles = state.view_roles.len();
    let expected_templates = state.row_templates.len();
    repo
      .create_database(state)
      .await
      .expect("persist complete managed Project");
    repo
      .create_row(
        database_id,
        row_id,
        myoxus_domain::database::DatabaseRowKind::Task,
        "Preserved value".into(),
        owner_id,
        vec![myoxus_domain::database::DatabaseCellValue {
          row_id,
          field_id,
          field_type: myoxus_domain::database::DatabaseFieldType::Select,
          value: myoxus_domain::database::DatabaseCellValueData::Select(priority.clone()),
          updated_by: Some(owner_id),
          edit_revision: 1,
          updated_at: chrono::Utc::now(),
        }],
        DatabaseEditPrecondition::default()
          .in_workspace(workspace_id)
          .in_database(database_id),
      )
      .await
      .expect("native preserved Task and Cell");
    let persisted_row = repo.get_row(row_id).await.unwrap().unwrap();
    assert_eq!(persisted_row.row.title, "Preserved value");
    assert_eq!(
      persisted_row
        .cells
        .iter()
        .find(|cell| cell.field_id == field_id)
        .expect("persisted priority")
        .value,
      myoxus_domain::database::DatabaseCellValueData::Select(priority)
    );

    repo
      .upsert_search_row(
        database_id,
        row_id,
        persisted_row.row.edit_revision,
        "Preserved value".into(),
        "Preserved value".into(),
        Vec::new(),
      )
      .await
      .expect("native search projection");
    let before_children = database_children(&pool, database_id).await;
    assert_eq!(
      before_children["workspace_database_fields"].as_array().unwrap().len(),
      expected_fields as usize
    );
    assert_eq!(
      before_children["workspace_database_views"].as_array().unwrap().len(),
      expected_views as usize
    );
    assert_eq!(
      before_children["database_field_roles"].as_array().unwrap().len(),
      expected_roles
    );
    assert_eq!(
      before_children["database_view_roles"].as_array().unwrap().len(),
      expected_view_roles
    );
    assert_eq!(
      before_children["workspace_database_row_templates"]
        .as_array()
        .unwrap()
        .len(),
      expected_templates
    );
    assert!(expected_roles > 0 && expected_view_roles > 0 && expected_templates > 0);
    assert_eq!(
      before_children["workspace_database_row_search"]
        .as_array()
        .unwrap()
        .len(),
      1
    );

    let active_purge = repo
      .purge_database(database_id, DatabaseEditPrecondition::new(None, false))
      .await;
    assert!(
      matches!(active_purge, Err(RepositoryError::NotFound("trashed database"))),
      "permanent deletion must atomically reject an active Database"
    );
    assert!(
      repo
        .get_database(database_id)
        .await
        .expect("active Database after rejected purge")
        .is_some(),
      "a rejected purge must roll back profile cleanup"
    );

    let trashed = repo
      .trash_database(database_id, owner_id, DatabaseEditPrecondition::new(None, false))
      .await
      .expect("move Project Database to trash");
    assert!(trashed.database.deleted_at.is_some());
    assert_eq!(trashed.database.deleted_by, Some(owner_id));
    assert!(repo.get_database(database_id).await.expect("active lookup").is_none());
    assert!(
      repo
        .list_databases(
          workspace_id,
          PageRequest { limit: 10, offset: 0 },
          DatabaseInventoryFilter::default()
        )
        .await
        .expect("active inventory")
        .is_empty()
    );
    let trashed_inventory = repo
      .list_databases(
        workspace_id,
        PageRequest { limit: 10, offset: 0 },
        DatabaseInventoryFilter {
          lifecycle: DatabaseLifecycleFilter::Trashed,
          ..Default::default()
        },
      )
      .await
      .expect("trash inventory");
    assert_eq!(trashed_inventory.len(), 1);
    assert_eq!(trashed_inventory[0].field_count, expected_fields);
    assert_eq!(trashed_inventory[0].view_count, expected_views);
    assert_eq!(trashed_inventory[0].row_count, 1);

    assert_eq!(
      database_children(&pool, database_id).await,
      before_children,
      "Trash retains the complete native profile, roles, schema, Cells and templates"
    );

    let restored = repo
      .restore_database(
        database_id,
        owner_id,
        DatabaseEditPrecondition::new(Some(trashed.database.edit_revision), false),
      )
      .await
      .expect("restore Database");
    assert!(restored.database.deleted_at.is_none());
    assert_eq!(restored.row_count, 1);
    assert!(repo.get_database(database_id).await.expect("restored lookup").is_some());
    assert_eq!(
      database_children(&pool, database_id).await,
      before_children,
      "Restore retains every physical child fact"
    );
    assert_eq!(
      serde_json::to_value(repo.get_row(row_id).await.unwrap().unwrap()).unwrap(),
      serde_json::to_value(&persisted_row).unwrap(),
      "Restore preserves actual native Cell content and revisions"
    );

    let trashed_again = repo
      .trash_database(
        database_id,
        owner_id,
        DatabaseEditPrecondition::new(Some(restored.database.edit_revision), false),
      )
      .await
      .expect("trash restored Database");
    repo
      .purge_database(
        database_id,
        DatabaseEditPrecondition::new(Some(trashed_again.database.edit_revision), false),
      )
      .await
      .expect("purge trashed Project Database with role projections");

    let remaining = database_children(&pool, database_id).await;
    for (projection, rows) in remaining.as_object().unwrap() {
      assert!(
        rows.as_array().unwrap().is_empty(),
        "purge must remove {projection}: {rows}"
      );
    }
    assert!(repo.get_database_for_lifecycle(database_id).await.unwrap().is_none());
  })
  .catch_unwind()
  .await;

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("clean up workspace");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("clean up owner");
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn initial_state_late_row_failure_rolls_back_the_root_and_prior_rows() {
  use chrono::Utc;
  use myoxus_domain::database::{
    Database, DatabaseInitialState, DatabaseProfileKind, DatabaseRow, DatabaseRowKind, DatabaseRowRecord,
  };
  let pool = setup_pool().await;
  let owner_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let database_id = Uuid::new_v4();
  let row_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id,email,name,status) VALUES ($1,$2,'Initial state owner','active')")
    .bind(owner_id)
    .bind(format!("initial-state-{owner_id}@example.test"))
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("INSERT INTO workspaces (id,owner_user_id,name) VALUES ($1,$2,'Initial state workspace')")
    .bind(workspace_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .unwrap();
  let now = Utc::now();
  let database = Database {
    system_role: None,
    managed_installation: None,

    id: database_id,
    workspace_id,
    profile_kind: DatabaseProfileKind::Generic,
    profile_structure_preset: None,
    profile_config: serde_json::json!({}),
    title: "Atomic initial state".into(),
    description: None,
    created_by: Some(owner_id),
    updated_by: Some(owner_id),
    deleted_at: None,
    deleted_by: None,
    edit_revision: 1,
    created_at: now,
    updated_at: now,
  };
  let row = DatabaseRowRecord {
    row: DatabaseRow {
      id: row_id,
      database_id,
      content_document_id: None,
      row_kind: DatabaseRowKind::Record,
      title: "First row".into(),
      position: 0,
      created_by: Some(owner_id),
      updated_by: Some(owner_id),
      edit_revision: 1,
      created_at: now,
      updated_at: now,
      deleted_at: None,
    },
    cells: vec![],
    cell_revisions: vec![],
  };
  let result = PgDatabaseRepository::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  )
  .create_database(DatabaseInitialState {
    database,
    fields: vec![],
    views: vec![],
    roles: vec![],
    view_roles: vec![],
    rows: vec![row.clone(), row],
    row_templates: vec![],
    workspace_tags: vec![],
  })
  .await;
  let remaining: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM workspace_databases WHERE id=$1) + (SELECT count(*) FROM workspace_database_rows WHERE database_id=$1)")
    .bind(database_id).fetch_one(&pool).await.unwrap();
  // Clean the owned fixture even if an assertion exposes a partial commit.
  sqlx::query("DELETE FROM workspaces WHERE id=$1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(owner_id)
    .execute(&pool)
    .await
    .unwrap();
  assert!(
    matches!(result, Err(RepositoryError::Conflict("XWS_DATABASE_UNIQUE_CONSTRAINT"))),
    "the duplicate later Row must reach the native unique constraint"
  );
  assert_eq!(remaining, 0, "the root and first Row must share the rollback");
}
