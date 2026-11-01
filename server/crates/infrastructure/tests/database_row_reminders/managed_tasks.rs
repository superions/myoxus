// SPDX-License-Identifier: AGPL-3.0-or-later
//! Causal SQL coverage for canonical provisioning, protected structure and native Task ownership.
use futures_util::FutureExt;
use myoxus_application::{
  database::DatabaseStarterTemplateCatalog,
  workspace::{
    WorkspaceName, WorkspaceStore,
    tasks::{WorkspaceTasksInitializer, workspace_tasks_initial_state},
  },
};
use myoxus_domain::database::DatabaseReminderRepository;
use myoxus_domain::database::*;
use myoxus_infrastructure::{
  database_templates::load_database_template_catalog, workspace::SqlxWorkspaceStore,
  workspace_database::PgDatabaseRepository,
};
use sqlx::PgPool;
use std::{collections::BTreeMap, panic::AssertUnwindSafe, sync::Arc};
use uuid::Uuid;

#[derive(Default)]
struct Changes(std::sync::Mutex<Vec<myoxus_domain::database_change::DatabaseChangeEvent>>);
#[async_trait::async_trait]
impl myoxus_application::ports::database_change::DatabaseChangeNotificationPort for Changes {
  async fn publish_change(
    &self,
    event: &myoxus_domain::database_change::DatabaseChangeEvent,
  ) -> myoxus_application::ports::PortResult<()> {
    self.0.lock().expect("event capture").push(event.clone());
    Ok(())
  }
}

fn tasks_initializer(
  catalog: Arc<DatabaseStarterTemplateCatalog>,
  repository: Arc<PgDatabaseRepository>,
) -> WorkspaceTasksInitializer {
  let projection = Arc::new(myoxus_application::database::DatabaseProjectionService::new(
    repository.clone(),
    repository.clone(),
    repository.clone(),
    repository.clone(),
    myoxus_application::database::DatabaseLimits::default(),
  ));
  WorkspaceTasksInitializer::new(catalog, repository, projection)
}

struct Fixture {
  pool: PgPool,
  catalog: Arc<DatabaseStarterTemplateCatalog>,
  repo: Arc<PgDatabaseRepository>,
  owner: Uuid,
  workspace: Uuid,
}
impl Fixture {
  async fn new() -> Self {
    // Never fall through to the served development database.
    let url = std::env::var("TEST_DATABASE_URL")
      .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".into());
    let pool = PgPool::connect(&url).await.expect("isolated PostgreSQL");
    myoxus_infrastructure::migrations::run(&pool).await.expect("migrations");
    let catalog = Arc::new(
      load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("immutable catalog"),
    );
    let owner = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,name,status) VALUES($1,$2,'Managed tasks owner','active')")
      .bind(owner)
      .bind(format!("managed-tasks-{owner}@example.test"))
      .execute(&pool)
      .await
      .expect("owner");
    let store = SqlxWorkspaceStore::new(pool.clone(), catalog.clone());
    let workspace = store
      .create_workspace(
        owner,
        WorkspaceName::parse(&format!("Managed Tasks {owner}")).expect("name"),
      )
      .await
      .expect("atomic workspace publication")
      .id;
    let repo = Arc::new(PgDatabaseRepository::new(pool.clone(), catalog.clone()));
    Self {
      pool,
      catalog,
      repo,
      owner,
      workspace,
    }
  }
  async fn cleanup(self) {
    sqlx::query("DELETE FROM workspaces WHERE id=$1")
      .bind(self.workspace)
      .execute(&self.pool)
      .await
      .expect("workspace cleanup");
    sqlx::query("DELETE FROM users WHERE id=$1")
      .bind(self.owner)
      .execute(&self.pool)
      .await
      .expect("owner cleanup");
    self.pool.close().await;
  }
  async fn default(&self) -> DatabaseRecord {
    tasks_initializer(self.catalog.clone(), self.repo.clone())
      .ensure(self.workspace, None)
      .await
      .expect("verified default")
  }
  async fn project(&self) -> DatabaseRecord {
    let mut state =
      workspace_tasks_initial_state(&self.catalog, self.workspace, Some(self.owner)).expect("project descriptor");
    state.database.system_role = None;
    state.database.title = "Destination".into();
    self
      .repo
      .create_database(state)
      .await
      .expect("ordinary managed Project")
  }
  fn fence(&self, id: Uuid) -> DatabaseEditPrecondition {
    DatabaseEditPrecondition::new(None, true)
      .in_workspace(self.workspace)
      .in_database(id)
  }
}

#[tokio::test]
async fn row_template_revisions_fence_defaults_edits_and_captured_creation() {
  let fixture = Fixture::new().await;
  let outcome = AssertUnwindSafe(async {
    let source = fixture.default().await;
    let original = fixture
      .repo
      .list_row_templates(source.database.id)
      .await
      .expect("native templates")
      .into_iter()
      .find(|template| template.row_kind == DatabaseRowKind::Task && template.is_default)
      .expect("authored Task default");
    assert_eq!(original.edit_revision, 1);
    let mut second = original.clone();
    second.id = Uuid::new_v4();
    second.name = "Second native default".into();
    let second = fixture
      .repo
      .create_row_template(second, fixture.fence(source.database.id))
      .await
      .expect("native default switch");
    assert_eq!(second.edit_revision, 1);
    let previous = fixture
      .repo
      .get_row_template(original.id)
      .await
      .expect("previous default")
      .expect("same template");
    assert!(!previous.is_default);
    assert_eq!(
      previous.edit_revision, 2,
      "implicit sibling change advances its native revision"
    );
    let stale = DatabaseEditPrecondition::new(Some(original.edit_revision), true)
      .in_workspace(fixture.workspace)
      .in_database(source.database.id);
    let error = fixture
      .repo
      .update_row_template(
        original.id,
        Some("Stale name".into()),
        None,
        None,
        None,
        Some(true),
        None,
        fixture.owner,
        stale,
      )
      .await
      .expect_err("force cannot overwrite a stale mutable template");
    assert!(matches!(
      error,
      myoxus_domain::repositories::RepositoryError::Conflict("database row template edit revision")
    ));
    let unchanged = fixture
      .repo
      .get_row_template(original.id)
      .await
      .expect("stale-write readback")
      .expect("preserved template");
    assert_eq!(
      serde_json::to_value(&unchanged).unwrap(),
      serde_json::to_value(&previous).unwrap()
    );
    let second_fence = DatabaseEditPrecondition::new(Some(second.edit_revision), false)
      .in_workspace(fixture.workspace)
      .in_database(source.database.id);
    let no_op = fixture
      .repo
      .update_row_template(
        second.id,
        None,
        None,
        None,
        None,
        None,
        None,
        fixture.owner,
        second_fence,
      )
      .await
      .expect("native no-op");
    assert_eq!(
      serde_json::to_value(no_op).unwrap(),
      serde_json::to_value(&second).unwrap()
    );
    let current = fixture
      .repo
      .update_row_template(
        second.id,
        Some("Reviewed native template".into()),
        None,
        None,
        None,
        None,
        Some(BTreeMap::new()),
        fixture.owner,
        second_fence,
      )
      .await
      .expect("real mutable content change");
    assert_eq!(current.edit_revision, 2);
    assert!(current.initial_cell_values.is_empty());
    let row = Uuid::new_v4();
    let stale_capture = fixture
      .fence(source.database.id)
      .for_creation_template(Some((second.id, second.edit_revision)));
    let rows_before: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_database_rows WHERE database_id=$1")
      .bind(source.database.id)
      .fetch_one(&fixture.pool)
      .await
      .expect("Row count fence");
    let error = fixture
      .repo
      .create_row(
        source.database.id,
        row,
        DatabaseRowKind::Task,
        "Must not use captured old content".into(),
        fixture.owner,
        Vec::new(),
        stale_capture,
      )
      .await
      .expect_err("same creation transaction rechecks captured template revision");
    assert!(matches!(
      error,
      myoxus_domain::repositories::RepositoryError::Conflict("database row template edit revision")
    ));
    assert!(fixture.repo.get_row(row).await.expect("no partial Row").is_none());
    let rows_after: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_database_rows WHERE database_id=$1")
      .bind(source.database.id)
      .fetch_one(&fixture.pool)
      .await
      .expect("unchanged Row count");
    assert_eq!(rows_after, rows_before);
    let error = fixture
      .repo
      .delete_row_template(second.id, second_fence)
      .await
      .expect_err("stale delete rejected");
    assert!(matches!(
      error,
      myoxus_domain::repositories::RepositoryError::Conflict("database row template edit revision")
    ));
    let valid = fixture
      .repo
      .create_row(
        source.database.id,
        row,
        DatabaseRowKind::Task,
        "Reviewed native content".into(),
        fixture.owner,
        Vec::new(),
        fixture
          .fence(source.database.id)
          .for_creation_template(Some((current.id, current.edit_revision))),
      )
      .await
      .expect("current captured template commits normally");
    assert_eq!(valid.row.id, row);
    assert_eq!(valid.row.title, "Reviewed native content");
    let ids = [Uuid::new_v4(), Uuid::new_v4()];
    let captured = fixture
      .fence(source.database.id)
      .for_creation_template(Some((current.id, current.edit_revision)));
    let both = tokio::time::timeout(std::time::Duration::from_secs(5), async {
      tokio::join!(
        fixture.repo.create_row(
          source.database.id,
          ids[0],
          DatabaseRowKind::Task,
          "Concurrent captured A".into(),
          fixture.owner,
          Vec::new(),
          captured
        ),
        fixture.repo.create_row(
          source.database.id,
          ids[1],
          DatabaseRowKind::Task,
          "Concurrent captured B".into(),
          fixture.owner,
          Vec::new(),
          captured
        )
      )
    })
    .await
    .expect("root-before-graph/template order cannot deadlock concurrent creates");
    assert_eq!(both.0.expect("first captured create").row.id, ids[0]);
    assert_eq!(both.1.expect("second captured create").row.id, ids[1]);

    fixture
      .repo
      .delete_row_template(
        original.id,
        DatabaseEditPrecondition::new(Some(previous.edit_revision), false)
          .in_workspace(fixture.workspace)
          .in_database(source.database.id),
      )
      .await
      .expect("exact-revision native delete");
    assert!(
      fixture
        .repo
        .get_row_template(original.id)
        .await
        .expect("deleted template")
        .is_none()
    );
    assert_eq!(
      fixture
        .repo
        .get_row_template(second.id)
        .await
        .expect("remaining template")
        .expect("current default")
        .edit_revision,
      2
    );
  })
  .catch_unwind()
  .await;
  fixture.cleanup().await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic)
  }
}

#[tokio::test]
async fn workspace_publication_and_concurrent_ensure_keep_one_protected_default() {
  let fixture = Fixture::new().await;
  let outcome = AssertUnwindSafe(async {
    let count: i64 = sqlx::query_scalar(
      "SELECT count(*) FROM workspace_databases WHERE workspace_id=$1 AND system_role='workspace_tasks'",
    )
    .bind(fixture.workspace)
    .fetch_one(&fixture.pool)
    .await
    .expect("published default count");
    assert_eq!(count, 1, "default exists before workspace creation returns");
    let (left, right) = tokio::join!(fixture.default(), fixture.default());
    assert_eq!(
      left.database.id, right.database.id,
      "concurrent recovery cannot publish a second default"
    );
    assert_eq!(
      left.managed_schema.as_ref().expect("projection").readiness,
      DatabaseManagedSchemaReadiness::Ready
    );
    assert!(
      fixture
        .repo
        .update_database(
          left.database.id,
          Some("Renamed".into()),
          None,
          fixture.owner,
          fixture.fence(left.database.id)
        )
        .await
        .is_err(),
      "Force cannot rename the default"
    );
    let field = &left.fields[0];
    assert!(
      fixture
        .repo
        .update_field(
          field.id,
          Some("Changed".into()),
          None,
          None,
          fixture.fence(left.database.id)
        )
        .await
        .is_err(),
      "Force cannot author managed structure"
    );
    let project = fixture.project().await;
    assert!(
      fixture
        .repo
        .update_database(
          project.database.id,
          Some("Renamed Project".into()),
          None,
          fixture.owner,
          fixture.fence(project.database.id)
        )
        .await
        .is_ok(),
      "ordinary Project metadata remains mutable"
    );
    assert!(
      fixture
        .repo
        .update_field(
          project.fields[0].id,
          Some("Changed".into()),
          None,
          None,
          fixture.fence(project.database.id)
        )
        .await
        .is_err(),
      "ordinary managed Project structure is equally protected"
    );
    let blank = fixture
      .catalog
      .select(
        "myoxus.database.blank",
        DatabaseProjectOptionPreset::ThreeStep,
        DatabaseProjectOptionPreset::ThreeStep,
        DatabaseProjectStructurePreset::TasksOnly,
      )
      .expect("Generic source")
      .clone();
    let state = myoxus_application::database::definition::templates::materialize_template(
      &myoxus_application::database::DatabaseLimits::default(),
      fixture.owner,
      fixture.workspace,
      "Custom Empty",
      None,
      false,
      "EUR",
      blank,
    )
    .expect("Generic materialization");
    let generic = fixture.repo.create_database(state).await.expect("customizable Generic");
    assert!(generic.database.managed_installation.is_none());
    assert!(generic.managed_schema.is_none());
    assert!(
      fixture
        .repo
        .update_field(
          generic.fields[0].id,
          Some("My title".into()),
          None,
          None,
          fixture.fence(generic.database.id)
        )
        .await
        .is_ok(),
      "Generic field authoring is unaffected"
    );
    let count: i64 = sqlx::query_scalar(
      "SELECT count(*) FROM workspace_databases WHERE workspace_id=$1 AND system_role='workspace_tasks'",
    )
    .bind(fixture.workspace)
    .fetch_one(&fixture.pool)
    .await
    .expect("final count");
    assert_eq!(count, 1);
  })
  .catch_unwind()
  .await;
  fixture.cleanup().await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic)
  }
}

#[tokio::test]
async fn move_keeps_row_identity_and_rejects_stale_forced_owner() {
  let fixture = Fixture::new().await;
  let outcome = AssertUnwindSafe(async {
    let source = fixture.default().await;
    let target = fixture.project().await;
    let document = Uuid::new_v4();
    sqlx::query("INSERT INTO docs(id,workspace_id,external_id,title,created_by,updated_by) VALUES($1,$2,$3,'Capture origin',$4,$4)")
      .bind(document).bind(fixture.workspace).bind(document.to_string()).bind(fixture.owner).execute(&fixture.pool).await.expect("source document");
    let request = Uuid::new_v4();
    let row_id = Uuid::new_v4();
    let due_field = source.field_roles.iter().find(|role|role.role_key=="task.dueDate" && role.row_kind_scope.as_deref()==Some("task")).expect("due binding").field_id;
    let status_field = source.field_roles.iter().find(|role|role.role_key=="task.status" && role.row_kind_scope.as_deref()==Some("task")).expect("status binding").field_id;
    let now = chrono::Utc::now();
    let due = DatabaseDateTimeValue { start:now+chrono::Duration::hours(2),end:None,all_day:false,time_zone:"Europe/Berlin".into() };
    let cells = vec![
      DatabaseCellValue {row_id,field_id:due_field,field_type:DatabaseFieldType::DateTime,value:DatabaseCellValueData::DateTime(due.clone()),updated_by:Some(fixture.owner),edit_revision:1,updated_at:now},
      DatabaseCellValue {row_id,field_id:status_field,field_type:DatabaseFieldType::Status,value:DatabaseCellValueData::Status("status.todo".into()),updated_by:Some(fixture.owner),edit_revision:1,updated_at:now},
    ];
    fixture.repo.create_task_capture("Keep my identity".into(),cells,DatabaseTaskCaptureReceipt {
      actor_id:fixture.owner,workspace_id:fixture.workspace,request_id:request,fingerprint:"immutable-capture".into(),database_id:source.database.id,row_id,edit_revision:1,
      source:DatabaseTaskSource{source_workspace_id:fixture.workspace,document_id:document,external_id:document.to_string(),block_id:Some("source-block".into()),selection_anchor:None}
    }, DatabaseEditPrecondition::default().in_workspace(fixture.workspace)).await.expect("native captured Task");
    let row = fixture.repo.attach_row_content_document(row_id,document,fixture.owner,fixture.fence(source.database.id)).await.expect("content attachment");
    let before_setup=fixture.repo.get_row(row_id).await.expect("canonical attached Task read").expect("attached Task");
    assert_eq!(serde_json::to_value(&before_setup.row).unwrap(),serde_json::to_value(&row.row).unwrap());
    let unique_id_field=source.database.managed_installation.as_ref().expect("native installation").field_bindings["public_id"];
    assert_eq!(source.fields.iter().find(|field|field.id==unique_id_field).expect("native display ID Field").field_type,DatabaseFieldType::UniqueId);
    for field in [due_field,status_field,unique_id_field] {
      assert!(before_setup.cell_revisions.iter().any(|slot|slot.field_id==field),"canonical capture slot for {field} must exist");
    }

    let reminder = fixture.repo.upsert_database_row_reminder(super::reminder(fixture.workspace,source.database.id,row_id,due_field,fixture.owner,10,due.start-chrono::Duration::minutes(10))).await.expect("personal reminder");
    let claim = Uuid::new_v4();
    sqlx::query("UPDATE database_row_reminders SET status='claimed',claim_token=$2,claim_expires_at=now()+interval '5 minutes' WHERE id=$1")
      .bind(reminder.id).bind(claim).execute(&fixture.pool).await.expect("held old-owner claim");
    use myoxus_domain::database_activity::{DatabaseActivityEvent,DatabaseActivityEventType,DatabaseActivityFilter,DatabaseActivityStore};
    let activity = myoxus_infrastructure::database_activity::PgDatabaseActivityStore::new(fixture.pool.clone());
    activity.record(DatabaseActivityEvent::new(fixture.workspace,source.database.id,DatabaseActivityEventType::RowCreated).with_row(row_id).with_actor(fixture.owner)).await.expect("historical activity");
    fixture.repo.upsert_search_row(source.database.id,row_id,row.row.edit_revision,row.row.title.clone(),"Source searchable text".into(),Vec::new()).await.expect("canonical source search cache");
    // The attachment command returns Row metadata. Move fences come from the
    // canonical persisted read, including every live or tombstoned Cell slot.
    let row=fixture.repo.get_row(row_id).await.expect("canonical Task before preview").expect("Task before preview");
    assert_eq!(serde_json::to_value(&row).unwrap(),serde_json::to_value(&before_setup).unwrap(),"reminder, history and search setup cannot change Row/Cell fences");
    let input = DatabaseTaskMoveInput {
      workspace_id: fixture.workspace,
      source_database_id: source.database.id,
      target_database_id: target.database.id,
      source_edit_revision: source.database.edit_revision,
      target_edit_revision: target.database.edit_revision,
      source_schema_revision: source
        .database
        .managed_installation
        .as_ref()
        .expect("source installation")
        .schema_revision,
      target_schema_revision: target
        .database
        .managed_installation
        .as_ref()
        .expect("target installation")
        .schema_revision,
      selection: vec![DatabaseTaskMoveSelection {
        row_id: row.row.id,
        expected_edit_revision: row.row.edit_revision,
        cell_revisions: row
          .cell_revisions
          .iter()
          .map(|slot| (slot.field_id, slot.edit_revision))
          .collect::<BTreeMap<_, _>>(),
      }],
      phase_row_id: None,
      milestone_row_id: None,
    };
    let preview = fixture
      .repo
      .prepare_task_move(fixture.owner, input.clone())
      .await
      .expect("read-only preview");
    assert!(preview.eligible, "{:?}", preview.reasons);
    let moved = fixture
      .repo
      .move_tasks(fixture.owner, input.clone())
      .await
      .expect("atomic native move");
    assert_eq!(moved.rows.len(), 1);
    let current = &moved.rows[0].row;
    assert_eq!(current.id, row.row.id);
    assert_eq!(current.database_id, target.database.id);
    assert_eq!(current.title, row.row.title);
    assert_eq!(current.created_at, row.row.created_at);
    assert_eq!(current.created_by, row.row.created_by);
    fixture.repo.upsert_search_row(target.database.id,row_id,current.edit_revision,current.title.clone(),"Target canonical payload".into(),Vec::new()).await.expect("current target reindex");
    assert!(fixture.repo.upsert_search_row(source.database.id,row_id,row.row.edit_revision,"Stale title".into(),"Old source payload".into(),Vec::new()).await.is_err(),"old-owner computed payload cannot overwrite moved cache");
    assert!(fixture.repo.upsert_search_row(target.database.id,row_id,row.row.edit_revision,"Stale revision".into(),"Old payload".into(),Vec::new()).await.is_err(),"currentowner does not bypass captured Row revision");
    let index:(Uuid,String)=sqlx::query_as("SELECT database_id,search_text FROM workspace_database_row_search WHERE row_id=$1").bind(row_id).fetch_one(&fixture.pool).await.expect("target search cache");
    assert_eq!(index,(target.database.id,"Target canonical payload".into()));
    assert_eq!(current.content_document_id,Some(document));
    let receipt=fixture.repo.get_task_capture_receipt(fixture.owner,fixture.workspace,request).await.expect("receipt read").expect("immutable receipt");
    assert_eq!(receipt.database_id,source.database.id,"historical capture owner remains immutable");
    assert_eq!(receipt.row_id,row_id);
    assert_eq!(receipt.fingerprint,"immutable-capture");
    assert_eq!(fixture.repo.get_task_source(row_id).await.expect("source lookup").expect("origin").document_id,document);
    let target_due=target.field_roles.iter().find(|role|role.role_key=="task.dueDate" && role.row_kind_scope.as_deref()==Some("task")).expect("target due").field_id;
    let reminders=fixture.repo.list_database_row_reminders(target.database.id,row_id,target_due,fixture.owner).await.expect("rebound reminder");
    assert_eq!(reminders.len(),1);
    assert_eq!(reminders[0].id,reminder.id);
    assert_eq!(reminders[0].trigger_at,reminder.trigger_at);
    assert_eq!(reminders[0].status,DatabaseRowReminderStatus::Scheduled);
    assert_eq!(reminders[0].schedule_revision,reminder.schedule_revision+1);
    assert_eq!(reminders[0].claim_token,None);
    assert!(!fixture.repo.mark_database_row_reminder_enqueued(reminder.id,reminder.schedule_revision,claim,now).await.expect("old worker finish"),"old claim cannot fire after native rebind");
    let history=activity.list(DatabaseActivityFilter{workspace_id:fixture.workspace,row_id:Some(row_id),..Default::default()},0,10).await.expect("current same-workspace history");
    assert_eq!(history.len(),1);
    assert_eq!(history[0].database_id,source.database.id,"history retains truthful former container");

    assert!(current.edit_revision > row.row.edit_revision);
    assert!(
      fixture.repo.move_tasks(fixture.owner, input).await.is_err(),
      "stale preview cannot replay"
    );
    assert!(
      fixture
        .repo
        .update_row_title(
          row.row.id,
          "Stale force".into(),
          fixture.owner,
          fixture.fence(source.database.id)
        )
        .await
        .is_err(),
      "Force never bypasses current owner"
    );
    assert_eq!(
      fixture
        .repo
        .get_row(row.row.id)
        .await
        .expect("canonical readback")
        .expect("same Row")
        .row
        .database_id,
      target.database.id
    );
    sqlx::query("DELETE FROM docs WHERE id=$1").bind(document).execute(&fixture.pool).await.expect("independent Document FK cleanup");
    let after_document = fixture.repo.get_row(row_id).await.expect("Task after document removal").expect("surviving Task");
    assert_eq!(after_document.row.content_document_id,None);
    assert_eq!(after_document.row.title,"Keep my identity");
  })
  .catch_unwind()
  .await;
  fixture.cleanup().await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic)
  }
}

/// A real immutable successor exists only in this disposable source fixture.
fn successor_sources(incompatible_config: bool) -> tempfile::TempDir {
  use myoxus_contracts::config_document::{ConfigDocumentFormat, decode_config_document};
  use sha2::{Digest, Sha256};
  fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).expect("fixture directory");
    for entry in std::fs::read_dir(from).expect("source entries") {
      let entry = entry.expect("source entry");
      if entry.file_type().expect("source type").is_dir() {
        copy_tree(&entry.path(), &to.join(entry.file_name()));
      } else {
        std::fs::copy(entry.path(), to.join(entry.file_name())).expect("immutable fixture copy");
      }
    }
  }
  let temp = tempfile::tempdir().expect("fixture root");
  copy_tree(
    &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
    temp.path(),
  );
  let id = "myoxus.project.simple_project";
  let original = std::fs::read_to_string(temp.path().join(format!("{id}/1.0.1.yaml"))).expect("original source");
  let mut source = decode_config_document(&original, ConfigDocumentFormat::Yaml).expect("source YAML");
  source["version"] = serde_json::json!("1.0.2");
  for variant in source["variants"].as_array_mut().expect("variants") {
    variant["spec"]["views"][0]["name"] = serde_json::json!("Updated Tasks");
  }
  if incompatible_config {
    let core_path = "myoxus.project.task-core/1.0.0.yaml";
    let core = std::fs::read_to_string(temp.path().join(core_path)).expect("task core");
    let mut core = decode_config_document(&core, ConfigDocumentFormat::Yaml).expect("core YAML");
    core["version"] = serde_json::json!("1.0.2");
    let description = core["fields"]
      .as_array_mut()
      .expect("core fields")
      .iter_mut()
      .find(|field| field["key"] == "description")
      .expect("description");
    description["config"]["Direct"]["maxPlainTextBytes"] = serde_json::json!(1024);
    let bytes = serde_json::to_vec(&core).expect("new core");
    let path = "myoxus.project.task-core/1.0.2.yaml";
    std::fs::write(temp.path().join(path), &bytes).expect("fixture core");
    source["task_core"]["version"] = serde_json::json!("1.0.2");
    source["task_core"]["path"] = serde_json::json!(path);
    source["task_core"]["sha256"] = serde_json::json!(format!("{:x}", Sha256::digest(&bytes)));
  }
  // JSON is a YAML subset. The production confined loader still performs the
  // same typed decoding and pin checks as shipped sources.
  let bytes = serde_json::to_vec(&source).expect("successor source");
  std::fs::write(temp.path().join(format!("{id}/1.0.2.yaml")), &bytes).expect("successor fixture");
  let digest = format!("{:x}", Sha256::digest(&bytes));
  let original = std::fs::read_to_string(temp.path().join("catalog.yaml")).expect("catalog");
  let mut catalog = decode_config_document(&original, ConfigDocumentFormat::Yaml).expect("catalog YAML");
  let entry = catalog["templates"]
    .as_array_mut()
    .expect("entries")
    .iter_mut()
    .find(|entry| entry["id"] == id)
    .expect("Project entry");
  let selections = entry["definitions"]
    .as_array()
    .unwrap()
    .iter()
    .find(|reference| reference["version"] == entry["current"])
    .unwrap()["selections"]
    .clone();
  let source_digest = entry["definitions"]
    .as_array()
    .expect("versions")
    .iter()
    .find(|reference| reference["version"] == "1.0.1")
    .expect("exact source pin")["sha256"]
    .clone();
  let update_path = format!("{id}/updates/1.0.1-to-1.0.2.yaml");
  let update = serde_json::json!({"format_version":1,"template_id":id,
    "source":{"version":"1.0.1","sha256":source_digest},
    "target":{"version":"1.0.2","sha256":digest},"operations":[]});
  let update_bytes = serde_json::to_vec(&update).expect("exact native update source");
  std::fs::create_dir_all(temp.path().join(format!("{id}/updates"))).expect("update fixture directory");
  std::fs::write(temp.path().join(&update_path), &update_bytes).expect("native successor edge");
  if entry.get("updates").is_none() {
    entry["updates"] = serde_json::json!([]);
  }
  entry["updates"]
    .as_array_mut()
    .expect("update references")
    .push(serde_json::json!({
    "from":"1.0.1","to":"1.0.2","path":update_path,"sha256":format!("{:x}",Sha256::digest(&update_bytes))}));
  entry["current"] = serde_json::json!("1.0.2");
  entry["definitions"].as_array_mut().expect("versions").push(
    serde_json::json!({"version":"1.0.2","path":format!("{id}/1.0.2.yaml"),"sha256":digest,"selections":selections}),
  );
  std::fs::write(
    temp.path().join("catalog.yaml"),
    serde_json::to_vec(&catalog).expect("catalog bytes"),
  )
  .expect("fixture catalog");
  temp
}

fn successor_catalog(incompatible_config: bool) -> (tempfile::TempDir, Arc<DatabaseStarterTemplateCatalog>) {
  let temp = successor_sources(incompatible_config);
  let catalog = Arc::new(load_database_template_catalog(temp.path()).expect("admitted successor fixture"));
  (temp, catalog)
}

#[tokio::test]
async fn forward_update_preserves_native_ids_mutable_rows_and_rejects_old_node_writes() {
  let fixture = Fixture::new().await;
  let outcome = AssertUnwindSafe(async {
    let original = fixture.default().await;
    let row = fixture
      .repo
      .create_row(
        original.database.id,
        Uuid::new_v4(),
        DatabaseRowKind::Task,
        "Untouched task".into(),
        fixture.owner,
        Vec::new(),
        fixture.fence(original.database.id),
      )
      .await
      .expect("native content");
    let due_field=original.field_roles.iter().find(|role|role.role_key=="task.dueDate" && role.row_kind_scope.as_deref()==Some("task")).expect("due role").field_id;
    let due=DatabaseDateTimeValue{start:chrono::Utc::now()+chrono::Duration::hours(2),end:None,all_day:false,time_zone:"Europe/Berlin".into()};
    fixture.repo.update_cell_value(row.row.id,due_field,DatabaseCellValueData::DateTime(due.clone()),fixture.owner,fixture.fence(original.database.id),None).await.expect("native reminder due Cell");
    let reminder=fixture.repo.upsert_database_row_reminder(super::reminder(fixture.workspace,original.database.id,row.row.id,due_field,fixture.owner,10,due.start-chrono::Duration::minutes(10))).await.expect("native reminder before upgrade");
    let claim=Uuid::new_v4();
    sqlx::query("UPDATE database_row_reminders SET status='claimed',claim_token=$2,claim_expires_at=now()+interval '5 minutes' WHERE id=$1").bind(reminder.id).bind(claim).execute(&fixture.pool).await.expect("pre-upgrade queued claim");
    let (_sources, new_catalog) = successor_catalog(false);
    let new_repo = Arc::new(PgDatabaseRepository::new(fixture.pool.clone(), new_catalog.clone()));
    let changes = Arc::new(Changes::default());
    let initializer =
      tasks_initializer(new_catalog, new_repo.clone()).with_change_notifications(changes.clone());
    let upgraded = initializer
      .ensure(fixture.workspace, None)
      .await
      .expect("forward update");
    let installation = upgraded.database.managed_installation.as_ref().expect("installation");
    assert_eq!(installation.template_version, "1.0.2");
    assert_eq!(installation.schema_revision, 2);
    assert_eq!(
      installation.field_bindings,
      original
        .database
        .managed_installation
        .as_ref()
        .expect("old installation")
        .field_bindings
    );
    assert_eq!(
      new_repo
        .get_row(row.row.id)
        .await
        .expect("native read")
        .expect("preserved Task")
        .row
        .title,
      "Untouched task"
    );
    assert_eq!(upgraded.views[0].name, "Updated Tasks");
    let events = changes.0.lock().expect("committed events").clone();
    assert_eq!(events.len(), 1, "only a committed structural change invalidates");
    assert_eq!(events[0].database_id, original.database.id);
    assert_eq!(
      events[0].actor_user_id, None,
      "system recovery never impersonates a person"
    );
    let repeated = initializer
      .ensure(fixture.workspace, None)
      .await
      .expect("repeat verification");
    assert_eq!(
      repeated
        .database
        .managed_installation
        .expect("repeat metadata")
        .schema_revision,
      2,
      "repeated recovery is not an upgrade"
    );
    assert!(fixture.repo.upsert_database_row_reminder(reminder.clone()).await.is_err(),"old node cannot reinterpret newer reminder schema");
    assert!(fixture.repo.get_database_row_reminder_dispatch(reminder.id,reminder.schedule_revision,reminder.trigger_at,fixture.owner).await.is_err(),"unknown local schema is not terminal denial/cancellation");
    let dispatch=new_repo.get_database_row_reminder_dispatch(reminder.id,reminder.schedule_revision,reminder.trigger_at,fixture.owner).await.expect("current descriptor dispatch");
    assert!(dispatch.is_some(),"same current native intent remains eligible on admitted node");
    let (status,generation,token):(String,i64,Option<Uuid>)=sqlx::query_as("SELECT status,schedule_revision,claim_token FROM database_row_reminders WHERE id=$1").bind(reminder.id).fetch_one(&fixture.pool).await.expect("unchanged pending intent");
    assert_eq!((status,generation,token),("claimed".into(),reminder.schedule_revision,Some(claim)));
    assert_eq!(changes.0.lock().expect("events after no-op").len(), 1);
    assert!(
      fixture
        .repo
        .update_row_title(
          row.row.id,
          "Old node".into(),
          fixture.owner,
          fixture.fence(original.database.id)
        )
        .await
        .is_err(),
      "persisted Ready never admits an older node"
    );
    assert_eq!(
      new_repo
        .get_row(row.row.id)
        .await
        .expect("read")
        .expect("Task")
        .row
        .title,
      "Untouched task"
    );
  })
  .catch_unwind()
  .await;
  fixture.cleanup().await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic)
  }
}

#[tokio::test]
async fn historical_activity_scope_cannot_disclose_a_foreign_current_row() {
  use myoxus_domain::database_activity::{
    DatabaseActivityEvent, DatabaseActivityEventType, DatabaseActivityFilter, DatabaseActivityStore,
  };
  let current = Fixture::new().await;
  let historical = Fixture::new().await;
  let outcome = AssertUnwindSafe(async {
    let destination = current.default().await;
    let historical_container = historical.default().await;
    let row = current
      .repo
      .create_row(
        destination.database.id,
        Uuid::new_v4(),
        DatabaseRowKind::Task,
        "Private current owner".into(),
        current.owner,
        Vec::new(),
        current.fence(destination.database.id),
      )
      .await
      .expect("foreign native Task");
    let activity = myoxus_infrastructure::database_activity::PgDatabaseActivityStore::new(current.pool.clone());
    // Persisted history can legitimately outlive an ownership transition. The
    // authorization decision must therefore consult its surviving Row today.
    activity
      .record(
        DatabaseActivityEvent::new(
          historical.workspace,
          historical_container.database.id,
          DatabaseActivityEventType::RowCreated,
        )
        .with_row(row.row.id),
      )
      .await
      .expect("former-scope event");
    let filter = DatabaseActivityFilter {
      workspace_id: historical.workspace,
      row_id: Some(row.row.id),
      ..Default::default()
    };
    assert!(
      activity
        .list(filter.clone(), 0, 10)
        .await
        .expect("authorized former-scope list")
        .is_empty()
    );
    assert_eq!(activity.count(filter).await.expect("former-scope count"), 0);
  })
  .catch_unwind()
  .await;
  historical.cleanup().await;
  current.cleanup().await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic)
  }
}

#[tokio::test]
async fn foreign_container_preview_never_returns_row_or_graph_details() {
  let authorized = Fixture::new().await;
  let foreign = Fixture::new().await;
  let outcome = AssertUnwindSafe(async {
    let source = foreign.default().await;
    let target = foreign.project().await;
    let row = foreign
      .repo
      .create_row(
        source.database.id,
        Uuid::new_v4(),
        DatabaseRowKind::Task,
        "Foreign private Task".into(),
        foreign.owner,
        Vec::new(),
        foreign.fence(source.database.id),
      )
      .await
      .expect("foreign Task");
    let input = DatabaseTaskMoveInput {
      workspace_id: authorized.workspace,
      source_database_id: source.database.id,
      target_database_id: target.database.id,
      source_edit_revision: source.database.edit_revision,
      target_edit_revision: target.database.edit_revision,
      source_schema_revision: 1,
      target_schema_revision: 1,
      selection: vec![DatabaseTaskMoveSelection {
        row_id: row.row.id,
        expected_edit_revision: row.row.edit_revision,
        cell_revisions: row
          .cell_revisions
          .iter()
          .map(|slot| (slot.field_id, slot.edit_revision))
          .collect(),
      }],
      phase_row_id: None,
      milestone_row_id: None,
    };
    assert!(
      authorized
        .repo
        .prepare_task_move(authorized.owner, input.clone())
        .await
        .is_err(),
      "authorized workspace cannot serve foreign container details"
    );
    assert!(authorized.repo.move_tasks(authorized.owner, input).await.is_err());
    assert_eq!(
      foreign
        .repo
        .get_row(row.row.id)
        .await
        .expect("foreign owner read")
        .expect("unmoved Task")
        .row
        .database_id,
      source.database.id
    );
  })
  .catch_unwind()
  .await;
  foreign.cleanup().await;
  authorized.cleanup().await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic)
  }
}

#[tokio::test]
async fn active_import_blocks_move_and_terminal_cleanup_cannot_delete_moved_provenance() {
  let fixture = Fixture::new().await;
  let outcome = AssertUnwindSafe(async {
    let source = fixture.default().await;
    let target = fixture.project().await;
    let now = chrono::Utc::now();
    let job = Uuid::new_v4();
    fixture
      .repo
      .create_import_job(&DatabaseImportJobRecord {
        id: job,
        workspace_id: fixture.workspace,
        database_id: Some(source.database.id),
        actor_id: Some(fixture.owner),
        kind: DatabaseImportJobKind::BulkImport,
        idempotency_key: job.to_string(),
        status: DatabaseImportJobStatus::Running,
        attempt_count: 1,
        cancellation_requested_at: None,
        cancelled_at: None,
        started_at: Some(now),
        finished_at: None,
        last_error_code: None,
        last_error_message: None,
        payload_summary: serde_json::json!({}),
        result: None,
        created_at: now,
      })
      .await
      .expect("running native import job");
    let id = Uuid::new_v4();
    let imported = DatabaseRowRecord {
      row: DatabaseRow {
        id,
        database_id: source.database.id,
        content_document_id: None,
        row_kind: DatabaseRowKind::Task,
        title: "Imported provenance".into(),
        position: 0,
        created_by: Some(fixture.owner),
        updated_by: Some(fixture.owner),
        edit_revision: 1,
        created_at: now,
        updated_at: now,
        deleted_at: None,
      },
      cells: Vec::new(),
      cell_revisions: Vec::new(),
    };
    fixture
      .repo
      .apply_database_snapshot_import(
        DatabaseJsonImportMode::Merge,
        Some(source.database.id),
        Some(fixture.fence(source.database.id)),
        source.database.clone(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        vec![imported],
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Some(job),
        None,
      )
      .await
      .expect("native managed content import");
    let row = fixture
      .repo
      .get_row(id)
      .await
      .expect("imported read")
      .expect("imported Task");
    let current_source = fixture
      .repo
      .get_database(source.database.id)
      .await
      .expect("source fence")
      .expect("source");
    let input = DatabaseTaskMoveInput {
      workspace_id: fixture.workspace,
      source_database_id: source.database.id,
      target_database_id: target.database.id,
      source_edit_revision: current_source.database.edit_revision,
      target_edit_revision: target.database.edit_revision,
      source_schema_revision: 1,
      target_schema_revision: 1,
      selection: vec![DatabaseTaskMoveSelection {
        row_id: id,
        expected_edit_revision: row.row.edit_revision,
        cell_revisions: row
          .cell_revisions
          .iter()
          .map(|slot| (slot.field_id, slot.edit_revision))
          .collect(),
      }],
      phase_row_id: None,
      milestone_row_id: None,
    };
    let preview = fixture
      .repo
      .prepare_task_move(fixture.owner, input.clone())
      .await
      .expect("active job preview");
    assert!(!preview.eligible);
    assert_eq!(preview.reasons, vec!["TASK_IMPORT_IN_PROGRESS"]);
    assert!(fixture.repo.move_tasks(fixture.owner, input.clone()).await.is_err());
    assert_eq!(
      fixture
        .repo
        .get_row(id)
        .await
        .expect("unchanged read")
        .expect("Task")
        .row
        .database_id,
      source.database.id
    );
    fixture
      .repo
      .mark_import_job_succeeded(job, &serde_json::json!({"database_id":source.database.id}))
      .await
      .expect("native terminal job");
    fixture
      .repo
      .move_tasks(fixture.owner, input)
      .await
      .expect("completed import content can move");
    assert_eq!(
      fixture
        .repo
        .delete_rows_by_job_id(job)
        .await
        .expect("former-owner cancellation cleanup"),
      0,
      "provenance never grants deletion in the new owner"
    );
    assert_eq!(
      fixture
        .repo
        .get_row(id)
        .await
        .expect("surviving current owner")
        .expect("same Task")
        .row
        .database_id,
      target.database.id
    );
    let provenance: Option<Uuid> =
      sqlx::query_scalar("SELECT created_by_job_id FROM workspace_database_rows WHERE id=$1")
        .bind(id)
        .fetch_one(&fixture.pool)
        .await
        .expect("native provenance");
    assert_eq!(provenance, Some(job));
  })
  .catch_unwind()
  .await;
  fixture.cleanup().await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic)
  }
}

struct ScopedTask<T>(tokio::task::JoinHandle<T>);
impl<T> Drop for ScopedTask<T> {
  fn drop(&mut self) {
    self.0.abort();
  }
}

async fn wait_for_database_lock(pool: &PgPool, application: &str) -> bool {
  tokio::time::timeout(std::time::Duration::from_secs(5),async {
    loop {
      let waiting:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock')")
        .bind(application).fetch_one(pool).await.expect("bounded lock observation");
      if waiting {return;}
      tokio::task::yield_now().await;
    }
  }).await.is_ok()
}

#[tokio::test]
async fn queued_old_node_writer_rechecks_catalog_after_concurrent_forward_commit() {
  let fixture = Fixture::new().await;
  let outcome = AssertUnwindSafe(async {
    let source = fixture.default().await;
    let row = fixture
      .repo
      .create_row(
        source.database.id,
        Uuid::new_v4(),
        DatabaseRowKind::Task,
        "Preserved through race".into(),
        fixture.owner,
        Vec::new(),
        fixture.fence(source.database.id),
      )
      .await
      .expect("native Task");
    let (_sources, catalog) = successor_catalog(false);
    let suffix = Uuid::new_v4();
    let upgrade_name = format!("wta-upgrade-{suffix}");
    let writer_name = format!("wta-old-writer-{suffix}");
    let options = fixture.pool.connect_options();
    let upgrade_pool = sqlx::postgres::PgPoolOptions::new()
      .max_connections(1)
      .connect_with(options.as_ref().clone().application_name(&upgrade_name))
      .await
      .expect("isolated upgrade connection");
    let writer_pool = sqlx::postgres::PgPoolOptions::new()
      .max_connections(1)
      .connect_with(options.as_ref().clone().application_name(&writer_name))
      .await
      .expect("isolated writer connection");
    let mut blocker = fixture.pool.begin().await.expect("root blocker");
    sqlx::query("SELECT id FROM workspace_databases WHERE id=$1 FOR UPDATE")
      .bind(source.database.id)
      .fetch_one(&mut *blocker)
      .await
      .expect("deterministic race barrier");
    let upgrade_repo = Arc::new(PgDatabaseRepository::new(upgrade_pool.clone(), catalog.clone()));
    let workspace = fixture.workspace;
    let mut upgrade = ScopedTask(tokio::spawn(async move {
      tasks_initializer(catalog, upgrade_repo).ensure(workspace, None).await
    }));
    let upgrade_waiting = wait_for_database_lock(&fixture.pool, &upgrade_name).await;
    if !upgrade_waiting {
      upgrade.0.abort();
      panic!("canonical updater never reached root lock");
    }
    let old_repo = PgDatabaseRepository::new(writer_pool.clone(), fixture.catalog.clone());
    let owner = fixture.owner;
    let fence = fixture.fence(source.database.id);
    let row_id = row.row.id;
    let mut writer = ScopedTask(tokio::spawn(async move {
      old_repo
        .update_row_title(row_id, "Stale queued writer".into(), owner, fence)
        .await
    }));
    let writer_waiting = wait_for_database_lock(&fixture.pool, &writer_name).await;
    if !writer_waiting {
      writer.0.abort();
      upgrade.0.abort();
      panic!("native writer did not wait behind the root authority lock");
    }
    blocker.commit().await.expect("release updater before old writer");
    let completed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
      tokio::join!(&mut upgrade.0, &mut writer.0)
    })
    .await
    .expect("bounded native race");
    assert!(completed.0.expect("updater task").is_ok());
    assert!(
      completed.1.expect("writer task").is_err(),
      "queued older node cannot write a newly admitted generation"
    );
    assert_eq!(
      fixture
        .repo
        .get_row(row_id)
        .await
        .expect("current Task read")
        .expect("same Task")
        .row
        .title,
      "Preserved through race"
    );
    upgrade_pool.close().await;
    writer_pool.close().await;
  })
  .catch_unwind()
  .await;
  fixture.cleanup().await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic)
  }
}

#[tokio::test]
async fn related_tasks_require_explicit_expansion_and_keep_native_graph_on_move() {
  let fixture = Fixture::new().await;
  let outcome=AssertUnwindSafe(async {
    let source=fixture.default().await;
    let target=fixture.project().await;
    let parent=fixture.repo.create_row(source.database.id,Uuid::new_v4(),DatabaseRowKind::Task,"Parent".into(),fixture.owner,Vec::new(),fixture.fence(source.database.id)).await.expect("native parent");
    let field=source.field_roles.iter().find(|role|role.role_key=="task.parent" && role.row_kind_scope.as_deref()==Some("task")).expect("parent role").field_id;
    let child=Uuid::new_v4();
    let child=fixture.repo.create_row(source.database.id,child,DatabaseRowKind::Task,"Child".into(),fixture.owner,vec![DatabaseCellValue{row_id:child,field_id:field,field_type:DatabaseFieldType::Relation,value:DatabaseCellValueData::Relation(vec![parent.row.id]),updated_by:Some(fixture.owner),edit_revision:1,updated_at:chrono::Utc::now()}],fixture.fence(source.database.id)).await.expect("native child graph");
    let select=|row:&DatabaseRowRecord|DatabaseTaskMoveSelection{row_id:row.row.id,expected_edit_revision:row.row.edit_revision,cell_revisions:row.cell_revisions.iter().map(|slot|(slot.field_id,slot.edit_revision)).collect()};
    let current_source=fixture.repo.get_database(source.database.id).await.expect("source fence").expect("source");
    let mut input=DatabaseTaskMoveInput{workspace_id:fixture.workspace,source_database_id:source.database.id,target_database_id:target.database.id,source_edit_revision:current_source.database.edit_revision,target_edit_revision:target.database.edit_revision,source_schema_revision:1,target_schema_revision:1,selection:vec![select(&child)],phase_row_id:None,milestone_row_id:None};
    let preview=fixture.repo.prepare_task_move(fixture.owner,input.clone()).await.expect("related preview");
    assert!(!preview.eligible);
    assert_eq!(preview.required_related_tasks,vec![parent.row.id]);
    assert!(fixture.repo.move_tasks(fixture.owner,input.clone()).await.is_err(),"no implicit component migration");
    input.selection.push(select(&parent));
    let preview=fixture.repo.prepare_task_move(fixture.owner,input.clone()).await.expect("expanded preview");
    assert!(preview.eligible,"{:?}",preview.reasons);
    let moved=fixture.repo.move_tasks(fixture.owner,input).await.expect("explicit native related set");
    assert_eq!(moved.rows.len(),2);
    let target_field=target.field_roles.iter().find(|role|role.role_key=="task.parent" && role.row_kind_scope.as_deref()==Some("task")).expect("target parent role").field_id;
    let child=fixture.repo.get_row(child.row.id).await.expect("canonical child").expect("same child");
    assert_eq!(child.row.database_id,target.database.id);
    assert_eq!(child.cells.iter().find(|cell|cell.field_id==target_field).expect("remapped native parent Cell").value,DatabaseCellValueData::Relation(vec![parent.row.id]));
    let owners:(Uuid,Uuid)=sqlx::query_as("SELECT source_database_id,target_database_id FROM workspace_database_relation_edges WHERE source_row_id=$1 AND source_field_id=$2 AND target_row_id=$3").bind(child.row.id).bind(target_field).bind(parent.row.id).fetch_one(&fixture.pool).await.expect("composite native graph ownership");
    assert_eq!(owners,(target.database.id,target.database.id));
  }).catch_unwind().await;
  fixture.cleanup().await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic)
  }
}

#[tokio::test]
async fn competing_forward_initializers_return_the_same_ready_winner_once() {
  let fixture = Fixture::new().await;
  let outcome = AssertUnwindSafe(async {
    let original = fixture.default().await;
    let (_sources, catalog) = successor_catalog(false);
    let changes = Arc::new(Changes::default());
    let options = fixture.pool.connect_options();
    let suffix = Uuid::new_v4();
    let first_name = format!("wta-concurrent-first-{suffix}");
    let second_name = format!("wta-concurrent-second-{suffix}");
    let first_pool = sqlx::postgres::PgPoolOptions::new()
      .max_connections(1)
      .connect_with(options.as_ref().clone().application_name(&first_name))
      .await
      .expect("first updater connection");
    let second_pool = sqlx::postgres::PgPoolOptions::new()
      .max_connections(1)
      .connect_with(options.as_ref().clone().application_name(&second_name))
      .await
      .expect("second updater connection");
    let first = tasks_initializer(
      catalog.clone(),
      Arc::new(PgDatabaseRepository::new(first_pool.clone(), catalog.clone())),
    )
    .with_change_notifications(changes.clone());
    let second = tasks_initializer(
      catalog.clone(),
      Arc::new(PgDatabaseRepository::new(second_pool.clone(), catalog)),
    )
    .with_change_notifications(changes.clone());
    let mut blocker = fixture.pool.begin().await.expect("generation barrier");
    sqlx::query("SELECT id FROM workspace_databases WHERE id=$1 FOR UPDATE")
      .bind(original.database.id)
      .fetch_one(&mut *blocker)
      .await
      .expect("hold original generation");
    let workspace = fixture.workspace;
    let mut first = ScopedTask(tokio::spawn(async move { first.ensure(workspace, None).await }));
    let mut second = ScopedTask(tokio::spawn(async move { second.ensure(workspace, None).await }));
    assert!(
      wait_for_database_lock(&fixture.pool, &first_name).await,
      "first must capture old generation"
    );
    assert!(
      wait_for_database_lock(&fixture.pool, &second_name).await,
      "second must capture same old generation"
    );
    blocker.commit().await.expect("release competing updaters");
    let (first, second) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
      tokio::join!(&mut first.0, &mut second.0)
    })
    .await
    .expect("bounded convergent reconciliation");
    let first = first.expect("first task").expect("first result");
    let second = second.expect("second task").expect("canonical winner readback");
    for record in [&first, &second] {
      assert_eq!(record.database.id, original.database.id);
      let installed = record.database.managed_installation.as_ref().expect("current metadata");
      assert_eq!(installed.schema_revision, 2);
      assert_eq!(installed.template_version, "1.0.2");
      assert_eq!(installed.readiness, DatabaseManagedSchemaReadiness::Ready);
      assert_eq!(
        record.database.edit_revision,
        original.database.edit_revision + 1,
        "the loser does not replay an upgrade"
      );
    }
    assert_eq!(changes.0.lock().expect("committed invalidations").len(), 1);
    first_pool.close().await;
    second_pool.close().await;
  })
  .catch_unwind()
  .await;
  fixture.cleanup().await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic)
  }
}

/// Only synthetic future edges are rewritten when their target fixture changes;
/// retained shipped definitions/updates keep their exact bytes.
fn repin_fixture_update_targets(root: &std::path::Path) {
  use sha2::{Digest, Sha256};
  let mut catalog: serde_json::Value =
    serde_json::from_slice(&std::fs::read(root.join("catalog.yaml")).expect("fixture catalog"))
      .expect("fixture JSON catalog");
  for entry in catalog["templates"].as_array_mut().expect("entries") {
    let definitions = entry["definitions"].clone();
    let Some(references) = entry.get_mut("updates").and_then(serde_json::Value::as_array_mut) else {
      continue;
    };
    for reference in references {
      if reference["to"] != "1.0.2" && reference["to"] != "1.0.3" {
        continue;
      }
      let path = reference["path"].as_str().expect("update path");
      let mut update: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join(path)).expect("future edge")).expect("future JSON edge");
      for (endpoint, key) in [("source", "from"), ("target", "to")] {
        update[endpoint]["sha256"] = definitions
          .as_array()
          .expect("versions")
          .iter()
          .find(|definition| definition["version"] == reference[key])
          .expect("declared endpoint")["sha256"]
          .clone();
      }
      let bytes = serde_json::to_vec(&update).expect("repinned edge");
      std::fs::write(root.join(path), &bytes).expect("write future edge");
      reference["sha256"] = serde_json::json!(format!("{:x}", Sha256::digest(&bytes)));
    }
  }
  std::fs::write(
    root.join("catalog.yaml"),
    serde_json::to_vec(&catalog).expect("fixture catalog bytes"),
  )
  .expect("fixture catalog write");
}

fn chained_successor_catalog() -> (tempfile::TempDir, Arc<DatabaseStarterTemplateCatalog>) {
  use sha2::{Digest, Sha256};
  let (temp, _) = successor_catalog(false);
  let id = "myoxus.project.simple_project";
  let mut source: serde_json::Value =
    serde_json::from_slice(&std::fs::read(temp.path().join(format!("{id}/1.0.2.yaml"))).expect("first successor"))
      .expect("fixture JSON definition");
  source["version"] = serde_json::json!("1.0.3");
  for variant in source["variants"].as_array_mut().expect("variants") {
    variant["spec"]["views"][0]["name"] = serde_json::json!("Final Tasks");
  }
  let path = format!("{id}/1.0.3.yaml");
  let bytes = serde_json::to_vec(&source).expect("final definition");
  std::fs::write(temp.path().join(&path), &bytes).expect("final source");
  let mut catalog: serde_json::Value =
    serde_json::from_slice(&std::fs::read(temp.path().join("catalog.yaml")).expect("catalog"))
      .expect("JSON fixture catalog");
  let entry = catalog["templates"]
    .as_array_mut()
    .expect("entries")
    .iter_mut()
    .find(|entry| entry["id"] == id)
    .expect("Project entry");
  let from = entry["definitions"]
    .as_array()
    .expect("versions")
    .iter()
    .find(|reference| reference["version"] == "1.0.2")
    .expect("middle pin")
    .clone();
  let digest = format!("{:x}", Sha256::digest(&bytes));
  entry["definitions"]
    .as_array_mut()
    .expect("versions")
    .push(serde_json::json!({"version":"1.0.3","path":path,"sha256":digest,"selections":from["selections"]}));
  let path = format!("{id}/updates/1.0.2-to-1.0.3.yaml");
  let update = serde_json::json!({"format_version":1,"template_id":id,"source":{"version":"1.0.2","sha256":from["sha256"]},"target":{"version":"1.0.3","sha256":digest},"operations":[]});
  let bytes = serde_json::to_vec(&update).expect("second edge");
  std::fs::write(temp.path().join(&path), &bytes).expect("second edge source");
  entry["updates"]
    .as_array_mut()
    .expect("edges")
    .push(serde_json::json!({"from":"1.0.2","to":"1.0.3","path":path,"sha256":format!("{:x}",Sha256::digest(&bytes))}));
  entry["current"] = serde_json::json!("1.0.3");
  std::fs::write(
    temp.path().join("catalog.yaml"),
    serde_json::to_vec(&catalog).expect("catalog bytes"),
  )
  .expect("chained catalog");
  let catalog = Arc::new(load_database_template_catalog(temp.path()).expect("complete exact route"));
  (temp, catalog)
}

/// Block the next real root-locked commit only after its predecessor has
/// committed and published. No trigger, schema override or synthetic writer.
struct EdgeBarrier {
  pool: PgPool,
  database: Uuid,
  events: std::sync::Mutex<Vec<myoxus_domain::database_change::DatabaseChangeEvent>>,
  task_events: std::sync::atomic::AtomicUsize,
  blocker: tokio::sync::Mutex<Option<sqlx::Transaction<'static, sqlx::Postgres>>>,
}
#[async_trait::async_trait]
impl myoxus_application::ports::database_change::DatabaseChangeNotificationPort for EdgeBarrier {
  async fn publish_change(
    &self,
    event: &myoxus_domain::database_change::DatabaseChangeEvent,
  ) -> myoxus_application::ports::PortResult<()> {
    let first = {
      let mut events = self.events.lock().expect("events");
      events.push(event.clone());
      events.len() == 1
    };
    if first {
      let mut tx = self.pool.begin().await.expect("next-edge barrier transaction");
      sqlx::query("SELECT id FROM workspace_databases WHERE id=$1 FOR UPDATE")
        .bind(self.database)
        .fetch_one(&mut *tx)
        .await
        .expect("hold next native edge");
      *self.blocker.lock().await = Some(tx);
    }
    Ok(())
  }
  async fn publish_tasks_changed(
    &self,
    _: &myoxus_domain::database_change::DatabaseChangeEvent,
  ) -> myoxus_application::ports::PortResult<()> {
    self.task_events.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    Ok(())
  }
}

#[tokio::test]
async fn chained_updates_invalidate_each_commit_and_resume_after_later_sql_failure() {
  let fixture = Fixture::new().await;
  let outcome = AssertUnwindSafe(async {
    let original = fixture.default().await;
    let row = fixture
      .repo
      .create_row(
        original.database.id,
        Uuid::new_v4(),
        DatabaseRowKind::Task,
        "Retained across edges".into(),
        fixture.owner,
        Vec::new(),
        fixture.fence(original.database.id),
      )
      .await
      .expect("native Task");
    let row = fixture
      .repo
      .get_row(row.row.id)
      .await
      .expect("canonical original read")
      .expect("Task");
    let (_sources, catalog) = chained_successor_catalog();
    let options = fixture.pool.connect_options();
    let pool = sqlx::postgres::PgPoolOptions::new()
      .max_connections(1)
      .after_connect(|connection, _| {
        Box::pin(async move {
          sqlx::query("SET lock_timeout='200ms'").execute(connection).await?;
          Ok(())
        })
      })
      .connect_with(options.as_ref().clone())
      .await
      .expect("bounded edge writer");
    let repository = Arc::new(PgDatabaseRepository::new(pool.clone(), catalog.clone()));
    let changes = Arc::new(EdgeBarrier {
      pool: fixture.pool.clone(),
      database: original.database.id,
      events: Default::default(),
      task_events: Default::default(),
      blocker: Default::default(),
    });
    let initializer = tasks_initializer(catalog, repository.clone()).with_change_notifications(changes.clone());
    let error = initializer
      .ensure(fixture.workspace, None)
      .await
      .expect_err("second actual SQL commit must hit the barrier");
    assert_eq!(error.code, myoxus_application::database::ERR_STORAGE);
    let persisted: serde_json::Value =
      sqlx::query_scalar("SELECT managed_installation FROM workspace_databases WHERE id=$1")
        .bind(original.database.id)
        .fetch_one(&fixture.pool)
        .await
        .expect("committed middle installation");
    let middle: DatabaseManagedSchemaInstallation = serde_json::from_value(persisted).expect("native installation");
    assert_eq!(middle.template_version, "1.0.2");
    assert_eq!(middle.schema_revision, 2);
    assert_eq!(middle.readiness, DatabaseManagedSchemaReadiness::Unavailable);
    assert_eq!(middle.reason_code.as_deref(), Some("MANAGED_UPDATE_INCOMPLETE"));
    assert_eq!(changes.events.lock().expect("immediate invalidation").len(), 1);
    assert_eq!(changes.task_events.load(std::sync::atomic::Ordering::SeqCst), 1);
    changes
      .blocker
      .lock()
      .await
      .take()
      .expect("held root")
      .rollback()
      .await
      .expect("release failed edge");
    let blocked = repository
      .update_row_title(
        row.row.id,
        "Must not edit intermediate schema".into(),
        fixture.owner,
        fixture.fence(original.database.id),
      )
      .await;
    assert!(
      blocked.is_err(),
      "intermediate version is not admitted for ordinary content writes"
    );
    let complete = initializer
      .ensure(fixture.workspace, None)
      .await
      .expect("resume at canonical committed edge");
    let installed = complete.database.managed_installation.as_ref().expect("final install");
    assert_eq!(installed.template_version, "1.0.3");
    assert_eq!(installed.schema_revision, 3);
    assert_eq!(installed.readiness, DatabaseManagedSchemaReadiness::Ready);
    assert_eq!(installed.field_bindings, middle.field_bindings);
    assert_eq!(installed.view_bindings, middle.view_bindings);
    assert_eq!(complete.views[0].name, "Final Tasks");
    assert_eq!(changes.events.lock().expect("committed edges").len(), 2);
    assert_eq!(changes.task_events.load(std::sync::atomic::Ordering::SeqCst), 2);
    let actual = repository
      .get_row(row.row.id)
      .await
      .expect("preserved content")
      .expect("same Row");
    assert_eq!(
      serde_json::to_value(actual).unwrap(),
      serde_json::to_value(&row).unwrap()
    );
    let before = serde_json::to_value(&complete).unwrap();
    let repeated = initializer
      .ensure(fixture.workspace, None)
      .await
      .expect("current version no-op");
    assert_eq!(serde_json::to_value(repeated).unwrap(), before);
    assert_eq!(changes.events.lock().expect("no repeated effects").len(), 2);
    // An older node can report local unavailability, but cannot rewrite the
    // newer installation's persisted readiness or identity.
    tasks_initializer(fixture.catalog.clone(), fixture.repo.clone())
      .ensure(fixture.workspace, None)
      .await
      .expect("older node bounded readback");
    let after = repository
      .get_database_for_lifecycle(original.database.id)
      .await
      .expect("new-node readback")
      .expect("same Database");
    assert_eq!(serde_json::to_value(after).unwrap(), before);
    pool.close().await;
  })
  .catch_unwind()
  .await;
  fixture.cleanup().await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic)
  }
}

fn successor_catalog_with_formula() -> (tempfile::TempDir, Arc<DatabaseStarterTemplateCatalog>) {
  use myoxus_contracts::config_document::{ConfigDocumentFormat, decode_config_document};
  use sha2::{Digest, Sha256};
  let (temp, _) = successor_catalog(false);
  let path = "myoxus.project.simple_project/1.0.2.yaml";
  let mut source: serde_json::Value =
    serde_json::from_slice(&std::fs::read(temp.path().join(path)).expect("future source")).expect("fixture JSON YAML");
  for variant in source["variants"].as_array_mut().expect("variants") {
    variant["field_order"]
      .as_array_mut()
      .expect("field order")
      .push(serde_json::json!("fixture_formula"));
    variant["spec"]["fields"].as_array_mut().expect("extension fields").push(serde_json::json!({"key":"fixture_formula","name":"Fixture formula","field_type":"formula","required":false,"config":{"Direct":{"kind":"formula","expression":"1","resultType":"number","dependencyFieldIds":[],"stalePolicy":"async","format":null}}}));
    variant["spec"]["metadata"]["fields"].as_array_mut().expect("field copy/import metadata").push(serde_json::json!({"key":"fixture_formula","name_key":"com.myoxus.database.fixture-formula.name","import_export_behavior":"read_only"}));
  }
  let bytes = serde_json::to_vec(&source).expect("formula source bytes");
  std::fs::write(temp.path().join(path), &bytes).expect("formula source");
  let text = std::fs::read_to_string(temp.path().join("catalog.yaml")).expect("catalog");
  let mut catalog = decode_config_document(&text, ConfigDocumentFormat::Yaml).expect("catalog document");
  let entry = catalog["templates"]
    .as_array_mut()
    .expect("entries")
    .iter_mut()
    .find(|entry| entry["id"] == "myoxus.project.simple_project")
    .expect("Project entry");
  let reference = entry["definitions"]
    .as_array_mut()
    .expect("versions")
    .iter_mut()
    .find(|entry| entry["version"] == "1.0.2")
    .expect("future reference");
  reference["sha256"] = serde_json::json!(format!("{:x}", Sha256::digest(&bytes)));
  std::fs::write(
    temp.path().join("catalog.yaml"),
    serde_json::to_vec(&catalog).expect("catalog bytes"),
  )
  .expect("fixture pin");
  repin_fixture_update_targets(temp.path());
  let catalog = Arc::new(load_database_template_catalog(temp.path()).expect("native future formula descriptor"));
  (temp, catalog)
}

#[tokio::test]
async fn derived_projection_fences_current_catalog_and_moved_native_owner() {
  let fixture = Fixture::new().await;
  let outcome = AssertUnwindSafe(async {
    let original = fixture.default().await;
    let row = fixture
      .repo
      .create_row(
        original.database.id,
        Uuid::new_v4(),
        DatabaseRowKind::Task,
        "Derived native Task".into(),
        fixture.owner,
        Vec::new(),
        fixture.fence(original.database.id),
      )
      .await
      .expect("native Task");
    let (_sources, catalog) = successor_catalog_with_formula();
    let repository = Arc::new(PgDatabaseRepository::new(fixture.pool.clone(), catalog.clone()));
    let source = tasks_initializer(catalog.clone(), repository.clone())
      .ensure(fixture.workspace, None)
      .await
      .expect("admitted additive formula update");
    let mut state = workspace_tasks_initial_state(&catalog, fixture.workspace, Some(fixture.owner))
      .expect("current target descriptor");
    state.database.system_role = None;
    let target = repository
      .create_database(state)
      .await
      .expect("current ordinary target");
    let source_field = source
      .database
      .managed_installation
      .as_ref()
      .expect("source installation")
      .field_bindings["fixture_formula"];
    let target_field = target
      .database
      .managed_installation
      .as_ref()
      .expect("target installation")
      .field_bindings["fixture_formula"];
    repository
      .upsert_formula_projection_value(
        source.database.id,
        row.row.id,
        source_field,
        Some(DatabaseFormulaScalarValue::Number(1.0)),
        Some("source".into()),
        DatabaseFormulaStaleState::Stale,
        None,
        None,
      )
      .await
      .expect("admitted source projection");
    let admitted = repository
      .list_stale_formula_projection_tasks(Some(fixture.workspace), 100, 100)
      .await
      .expect("current descriptor task admission");
    assert_eq!(admitted.len(), 1);
    assert_eq!(admitted[0].row_id, row.row.id);
    assert!(
      fixture
        .repo
        .list_stale_formula_projection_tasks(Some(fixture.workspace), 100, 100)
        .await
        .expect("old node task admission")
        .is_empty()
    );
    let input = DatabaseTaskMoveInput {
      workspace_id: fixture.workspace,
      source_database_id: source.database.id,
      target_database_id: target.database.id,
      source_edit_revision: source.database.edit_revision,
      target_edit_revision: target.database.edit_revision,
      source_schema_revision: 2,
      target_schema_revision: 1,
      selection: vec![DatabaseTaskMoveSelection {
        row_id: row.row.id,
        expected_edit_revision: row.row.edit_revision,
        cell_revisions: row
          .cell_revisions
          .iter()
          .map(|slot| (slot.field_id, slot.edit_revision))
          .collect(),
      }],
      phase_row_id: None,
      milestone_row_id: None,
    };
    repository
      .move_tasks(fixture.owner, input)
      .await
      .expect("native Task with derived binding");
    let owner: (Uuid, Uuid, String) =
      sqlx::query_as("SELECT database_id,field_id,stale_state FROM workspace_database_formula_values WHERE row_id=$1")
        .bind(row.row.id)
        .fetch_one(&fixture.pool)
        .await
        .expect("remapped derived cache");
    assert_eq!(owner, (target.database.id, target_field, "stale".into()));
    assert!(
      repository
        .upsert_formula_projection_value(
          source.database.id,
          row.row.id,
          source_field,
          Some(DatabaseFormulaScalarValue::Number(9.0)),
          Some("stale owner".into()),
          DatabaseFormulaStaleState::Current,
          None,
          None
        )
        .await
        .is_err(),
      "old native projection owner cannot create an orphan source slot"
    );
    assert!(
      fixture
        .repo
        .upsert_formula_projection_value(
          target.database.id,
          row.row.id,
          target_field,
          Some(DatabaseFormulaScalarValue::Number(9.0)),
          Some("old node".into()),
          DatabaseFormulaStaleState::Current,
          None,
          None
        )
        .await
        .is_err(),
      "persisted Ready does not admit an unsupported node"
    );
    repository
      .upsert_formula_projection_value(
        target.database.id,
        row.row.id,
        target_field,
        Some(DatabaseFormulaScalarValue::Number(2.0)),
        Some("current owner".into()),
        DatabaseFormulaStaleState::Current,
        None,
        None,
      )
      .await
      .expect("admitted current projection");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_database_formula_values WHERE row_id=$1")
      .bind(row.row.id)
      .fetch_one(&fixture.pool)
      .await
      .expect("canonical projection count");
    assert_eq!(count, 1);
  })
  .catch_unwind()
  .await;
  fixture.cleanup().await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic)
  }
}

#[tokio::test]
async fn unexpected_managed_binding_marks_instance_unavailable_without_reseeding_content() {
  let fixture = Fixture::new().await;
  let outcome = AssertUnwindSafe(async {
    let original = fixture.default().await;
    let task = fixture
      .repo
      .create_row(
        original.database.id,
        Uuid::new_v4(),
        DatabaseRowKind::Task,
        "Retain content on invalid binding".into(),
        fixture.owner,
        Vec::new(),
        fixture.fence(original.database.id),
      )
      .await
      .expect("native Task");
    let task = fixture
      .repo
      .get_row(task.row.id)
      .await
      .expect("read persisted Task before invalid binding")
      .expect("persisted Task");
    let mut installation = original
      .database
      .managed_installation
      .clone()
      .expect("installed source");
    installation
      .field_bindings
      .insert("undeclared_field".into(), original.fields[0].id);
    let mut tx = fixture.pool.begin().await.expect("fixture corruption transaction");
    sqlx::query("SELECT set_config('myoxus.managed_schema_write','on',true)")
      .execute(&mut *tx)
      .await
      .expect("bounded fixture writer");
    sqlx::query("UPDATE workspace_databases SET managed_installation=$2 WHERE id=$1")
      .bind(original.database.id)
      .bind(serde_json::to_value(installation).unwrap())
      .execute(&mut *tx)
      .await
      .expect("corrupt declared bindings only");
    tx.commit().await.expect("persist invalid binding fixture");
    let ensured = fixture.default().await;
    let metadata = ensured
      .database
      .managed_installation
      .expect("retained unavailable source");
    assert_eq!(metadata.readiness, DatabaseManagedSchemaReadiness::Unavailable);
    assert_eq!(metadata.reason_code.as_deref(), Some("MANAGED_STRUCTURE_MISMATCH"));
    assert_eq!(
      serde_json::to_value(
        fixture
          .repo
          .get_row(task.row.id)
          .await
          .expect("retained Row read")
          .expect("retained Row")
      )
      .unwrap(),
      serde_json::to_value(task).unwrap()
    );
  })
  .catch_unwind()
  .await;
  fixture.cleanup().await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}

/// A fixture-local extension leaves the common Task core unchanged. Its real
/// outgoing edge removes one option and simultaneously remaps two old IDs.
fn select_conversion_catalogs() -> (
  tempfile::TempDir,
  Arc<DatabaseStarterTemplateCatalog>,
  Arc<DatabaseStarterTemplateCatalog>,
) {
  use sha2::{Digest, Sha256};
  let temp = successor_sources(false);
  let id = "myoxus.project.simple_project";
  let mut source: serde_json::Value =
    serde_json::from_slice(&std::fs::read(temp.path().join(format!("{id}/1.0.2.yaml"))).expect("source definition"))
      .expect("fixture JSON source");
  let options = |ids: &[&str]| {
    serde_json::Value::Array(ids.iter().enumerate().map(|(position,id)|serde_json::json!({"id":id,"name":format!("Option {id}"),"position":position,"colorRole":"neutral"})).collect())
  };
  for variant in source["variants"].as_array_mut().expect("variants") {
    for (key, kind) in [("fixture_select", "select"), ("fixture_multi", "multi_select")] {
      variant["field_order"]
        .as_array_mut()
        .expect("field order")
        .push(serde_json::json!(key));
      variant["spec"]["fields"].as_array_mut().expect("fields").push(serde_json::json!({"key":key,"name":key,"field_type":kind,"required":false,"config":{"Direct":{"kind":kind,"options":options(&["a","b","c"])}}}));
      variant["spec"]["metadata"]["fields"].as_array_mut().expect("metadata").push(serde_json::json!({"key":key,"name_key":format!("com.myoxus.database.{}.name", key.replace('_', "-")),"import_export_behavior":"read_write"}));
    }
  }
  let source_bytes = serde_json::to_vec(&source).expect("extended source bytes");
  std::fs::write(temp.path().join(format!("{id}/1.0.2.yaml")), &source_bytes).expect("extended source");
  let mut catalog: serde_json::Value =
    serde_json::from_slice(&std::fs::read(temp.path().join("catalog.yaml")).expect("catalog"))
      .expect("fixture catalog");
  let entry = catalog["templates"]
    .as_array_mut()
    .expect("entries")
    .iter_mut()
    .find(|entry| entry["id"] == id)
    .expect("Project");
  let reference = entry["definitions"]
    .as_array_mut()
    .expect("definitions")
    .iter_mut()
    .find(|reference| reference["version"] == "1.0.2")
    .expect("source pin");
  reference["sha256"] = serde_json::json!(format!("{:x}", Sha256::digest(&source_bytes)));
  std::fs::write(
    temp.path().join("catalog.yaml"),
    serde_json::to_vec(&catalog).expect("catalog bytes"),
  )
  .expect("source catalog");
  repin_fixture_update_targets(temp.path());
  let before = Arc::new(load_database_template_catalog(temp.path()).expect("native source extension admitted"));
  source["version"] = serde_json::json!("1.0.3");
  for variant in source["variants"].as_array_mut().expect("variants") {
    for field in variant["spec"]["fields"].as_array_mut().expect("fields") {
      if field["key"] == "fixture_select" || field["key"] == "fixture_multi" {
        field["config"]["Direct"]["options"] = options(&["b", "c"]);
      }
    }
  }
  let bytes = serde_json::to_vec(&source).expect("target source");
  let digest = format!("{:x}", Sha256::digest(&bytes));
  std::fs::write(temp.path().join(format!("{id}/1.0.3.yaml")), &bytes).expect("native target definition");
  let mut catalog: serde_json::Value =
    serde_json::from_slice(&std::fs::read(temp.path().join("catalog.yaml")).expect("source catalog")).expect("catalog");
  let entry = catalog["templates"]
    .as_array_mut()
    .expect("entries")
    .iter_mut()
    .find(|entry| entry["id"] == id)
    .expect("Project");
  let from = entry["definitions"]
    .as_array()
    .expect("definitions")
    .iter()
    .find(|reference| reference["version"] == "1.0.2")
    .expect("source reference")
    .clone();
  entry["definitions"].as_array_mut().expect("definitions").push(serde_json::json!({"version":"1.0.3","path":format!("{id}/1.0.3.yaml"),"sha256":digest,"selections":from["selections"]}));
  let path = format!("{id}/updates/1.0.2-to-1.0.3.yaml");
  let update = serde_json::json!({"format_version":1,"template_id":id,"source":{"version":"1.0.2","sha256":from["sha256"]},"target":{"version":"1.0.3","sha256":digest},"operations":[{"kind":"map_select_options","field_key":"fixture_select","mapping":{"a":"b","b":"c"}},{"kind":"map_select_options","field_key":"fixture_multi","mapping":{"a":"b","b":"c"}}]});
  let bytes = serde_json::to_vec(&update).expect("typed Select edge");
  std::fs::write(temp.path().join(&path), &bytes).expect("native edge");
  entry["updates"]
    .as_array_mut()
    .expect("edges")
    .push(serde_json::json!({"from":"1.0.2","to":"1.0.3","path":path,"sha256":format!("{:x}",Sha256::digest(&bytes))}));
  entry["current"] = serde_json::json!("1.0.3");
  std::fs::write(
    temp.path().join("catalog.yaml"),
    serde_json::to_vec(&catalog).expect("target catalog bytes"),
  )
  .expect("target catalog");
  let after = Arc::new(load_database_template_catalog(temp.path()).expect("actual mapping edge admitted"));
  (temp, before, after)
}

#[tokio::test]
async fn select_update_converts_native_content_and_personal_state_atomically_or_rolls_back() {
  for invalid_personal in [false, true] {
    let fixture = Fixture::new().await;
    let outcome = AssertUnwindSafe(async {
      let (_files, before, after) = select_conversion_catalogs();
      let old_repo = Arc::new(PgDatabaseRepository::new(fixture.pool.clone(), before.clone()));
      let source = tasks_initializer(before, old_repo.clone())
        .ensure(fixture.workspace, None)
        .await
        .expect("source installation");
      let installed = source.database.managed_installation.as_ref().expect("source pins");
      let single = installed.field_bindings["fixture_select"];
      let multi = installed.field_bindings["fixture_multi"];
      let priority = installed.field_bindings["priority"];
      let status = installed.field_bindings["status"];
      let DatabaseFieldConfig::Status(status_config) = &source
        .fields
        .iter()
        .find(|field| field.id == status)
        .expect("native Status field")
        .config
      else {
        panic!("native Status config");
      };
      let mut collapsed_status_groups = status_config
        .options
        .iter()
        .take(2)
        .map(|option| option.id.clone())
        .collect::<Vec<_>>();
      collapsed_status_groups.push("__empty__".into());
      let make_cell = |row, field, field_type, value| DatabaseCellValue {
        row_id: row,
        field_id: field,
        field_type,
        value,
        updated_by: Some(fixture.owner),
        edit_revision: 1,
        updated_at: chrono::Utc::now(),
      };
      let live = Uuid::new_v4();
      let trash = Uuid::new_v4();
      let blank = Uuid::new_v4();
      let cleared = Uuid::new_v4();
      for row in [live, trash] {
        old_repo
          .create_row(
            source.database.id,
            row,
            DatabaseRowKind::Task,
            "Original facts".into(),
            fixture.owner,
            vec![
              make_cell(
                row,
                single,
                DatabaseFieldType::Select,
                DatabaseCellValueData::Select("a".into()),
              ),
              make_cell(
                row,
                multi,
                DatabaseFieldType::MultiSelect,
                DatabaseCellValueData::MultiSelect(vec!["a".into(), "b".into(), "c".into()]),
              ),
            ],
            fixture.fence(source.database.id),
          )
          .await
          .expect("native source Row");
      }
      old_repo
        .create_row(
          source.database.id,
          blank,
          DatabaseRowKind::Task,
          "Blank facts".into(),
          fixture.owner,
          vec![make_cell(
            blank,
            single,
            DatabaseFieldType::Select,
            DatabaseCellValueData::Select("".into()),
          )],
          fixture.fence(source.database.id),
        )
        .await
        .expect("explicit empty Select");
      old_repo
        .create_row(
          source.database.id,
          cleared,
          DatabaseRowKind::Task,
          "Cleared facts".into(),
          fixture.owner,
          vec![make_cell(
            cleared,
            single,
            DatabaseFieldType::Select,
            DatabaseCellValueData::Select("a".into()),
          )],
          fixture.fence(source.database.id),
        )
        .await
        .expect("native clear source");
      old_repo
        .clear_cell_value(
          cleared,
          single,
          fixture.owner,
          DatabaseEditPrecondition::new(Some(1), false)
            .in_workspace(fixture.workspace)
            .in_database(source.database.id),
        )
        .await
        .expect("real SQL NULL revision tombstone");
      old_repo
        .delete_row(trash, fixture.fence(source.database.id))
        .await
        .expect("recoverable trash Row");
      let template = old_repo
        .list_row_templates(source.database.id)
        .await
        .expect("templates")
        .into_iter()
        .find(|template| template.row_kind == DatabaseRowKind::Task)
        .expect("Task template");
      let mut values = template.initial_cell_values.clone();
      values.insert(single, DatabaseCellValueData::Select("a".into()));
      values.insert(
        multi,
        DatabaseCellValueData::MultiSelect(vec!["a".into(), "b".into(), "c".into()]),
      );
      let template = old_repo
        .update_row_template(
          template.id,
          None,
          None,
          None,
          None,
          None,
          Some(values),
          fixture.owner,
          DatabaseEditPrecondition::new(Some(template.edit_revision), false)
            .in_workspace(fixture.workspace)
            .in_database(source.database.id),
        )
        .await
        .expect("actual mutable template content");
      let grouped = source
        .views
        .iter()
        .find(|view| matches!(&view.config, DatabaseViewConfig::Kanban(config) if config.group_field_id == status))
        .expect("native Status Kanban grouping");
      let other = source
        .views
        .iter()
        .find(|view| !matches!(&view.config, DatabaseViewConfig::Kanban(config) if config.group_field_id == status))
        .expect("independent View");
      let now = chrono::Utc::now();
      let state = DatabaseViewUserState {
        view_id: grouped.id,
        user_id: fixture.owner,
        search_text: "Retained search".into(),
        sort: Some(vec![DatabaseSortRule {
          field_id: priority,
          direction: DatabaseSortDirection::Desc,
        }]),
        filter_tree: Some(DatabaseFilterGroup {
          conjunction: DatabaseFilterConjunction::And,
          rules: vec![DatabaseFilterRule {
            field_id: priority,
            operator: DatabaseFilterOperator::Is,
            value: DatabaseFilterValue::OptionId("priority.normal".into()),
          }],
          groups: vec![DatabaseFilterGroup {
            conjunction: DatabaseFilterConjunction::Or,
            rules: vec![DatabaseFilterRule {
              field_id: single,
              operator: DatabaseFilterOperator::AnyOf,
              value: DatabaseFilterValue::Ids(if invalid_personal {
                vec!["invalid-native-source-option".into()]
              } else {
                vec!["a".into(), "b".into()]
              }),
            }],
            groups: vec![],
          }],
        }),
        field_width_overrides: BTreeMap::from([(single, 280)]),
        collapsed_group_keys: collapsed_status_groups,
        edit_revision: 0,
        created_at: now,
        updated_at: now,
      };
      let state = old_repo
        .upsert_view_user_state(state, Some(0), fixture.fence(source.database.id))
        .await
        .expect("native personal draft");
      let mut other_state = state.clone();
      other_state.view_id = other.id;
      other_state.filter_tree = None;
      other_state.collapsed_group_keys = vec!["unrelated-group".into()];
      let other_state = old_repo
        .upsert_view_user_state(other_state, Some(0), fixture.fence(source.database.id))
        .await
        .expect("unrelated personal state");
      let rows_before = vec![
        old_repo.get_row(live).await.unwrap().unwrap(),
        old_repo.get_row(trash).await.unwrap().unwrap(),
        old_repo.get_row(blank).await.unwrap().unwrap(),
        old_repo.get_row(cleared).await.unwrap().unwrap(),
      ];
      let root_before = old_repo
        .get_database_for_lifecycle(source.database.id)
        .await
        .unwrap()
        .unwrap();
      let new_repo = Arc::new(PgDatabaseRepository::new(fixture.pool.clone(), after.clone()));
      let changes = Arc::new(Changes::default());
      let initializer = tasks_initializer(after, new_repo.clone()).with_change_notifications(changes.clone());
      let result = initializer.ensure(fixture.workspace, None).await;
      if invalid_personal {
        let error = result.expect_err("late native personal selector fails the entire edge");
        let reason = error
          .select_update
          .expect("typed reason/path retained through repository");
        assert_eq!(reason.reason, DatabaseSelectUpdateReason::UnknownSourceOption);
        assert!(reason.path.starts_with("viewUserStates/"));
        assert!(!reason.path.contains("invalid-native-source-option"));
        assert!(
          changes.0.lock().unwrap().is_empty(),
          "rolled-back conversion never invalidates"
        );
        assert_eq!(
          serde_json::to_value(
            old_repo
              .get_database_for_lifecycle(source.database.id)
              .await
              .unwrap()
              .unwrap()
          )
          .unwrap(),
          serde_json::to_value(&root_before).unwrap()
        );
        assert_eq!(
          serde_json::to_value(old_repo.get_row_template(template.id).await.unwrap().unwrap()).unwrap(),
          serde_json::to_value(&template).unwrap()
        );
        assert_eq!(
          serde_json::to_value(
            old_repo
              .get_view_user_state(grouped.id, fixture.owner)
              .await
              .unwrap()
              .unwrap()
          )
          .unwrap(),
          serde_json::to_value(&state).unwrap()
        );
        for original in &rows_before {
          assert_eq!(
            serde_json::to_value(old_repo.get_row(original.row.id).await.unwrap().unwrap()).unwrap(),
            serde_json::to_value(original).unwrap()
          );
        }
        return;
      }
      let current = result.expect("actual SQL conversion");
      assert_eq!(
        current.database.managed_installation.as_ref().unwrap().template_version,
        "1.0.3"
      );
      assert_eq!(
        current.database.managed_installation.as_ref().unwrap().schema_revision,
        3
      );
      for original in &rows_before {
        let row = new_repo.get_row(original.row.id).await.unwrap().unwrap();
        let changed = original.row.id == live || original.row.id == trash;
        assert_eq!(
          row.row.edit_revision,
          original.row.edit_revision + if changed { 1 } else { 0 }
        );
        assert_eq!(row.row.title, original.row.title);
        assert_eq!(row.row.updated_by, original.row.updated_by);
        assert_eq!(row.row.updated_at, original.row.updated_at);
        assert_eq!(row.row.deleted_at, original.row.deleted_at);
        for slot in &original.cell_revisions {
          let next = row
            .cell_revisions
            .iter()
            .find(|next| next.field_id == slot.field_id)
            .expect("same native revision slot");
          assert_eq!(
            next.edit_revision,
            slot.edit_revision
              + if changed && (slot.field_id == single || slot.field_id == multi) {
                1
              } else {
                0
              }
          );
          assert_eq!(next.has_value, slot.has_value);
        }

        for cell in &original.cells {
          let next = row
            .cells
            .iter()
            .find(|next| next.field_id == cell.field_id)
            .expect("same Cell identity");
          if changed && cell.field_id == single {
            assert_eq!(next.value, DatabaseCellValueData::Select("b".into()));
            assert_eq!(next.edit_revision, cell.edit_revision + 1);
          } else if changed && cell.field_id == multi {
            assert_eq!(
              next.value,
              DatabaseCellValueData::MultiSelect(vec!["b".into(), "c".into()])
            );
            assert_eq!(next.edit_revision, cell.edit_revision + 1);
          } else {
            assert_eq!(serde_json::to_value(next).unwrap(), serde_json::to_value(cell).unwrap());
          }
        }
      }
      let updated_template = new_repo.get_row_template(template.id).await.unwrap().unwrap();
      assert_eq!(updated_template.edit_revision, template.edit_revision + 1);
      assert_eq!(
        updated_template.initial_cell_values[&single],
        DatabaseCellValueData::Select("b".into())
      );
      assert_eq!(
        updated_template.initial_cell_values[&multi],
        DatabaseCellValueData::MultiSelect(vec!["b".into(), "c".into()])
      );
      let updated_state = new_repo
        .get_view_user_state(grouped.id, fixture.owner)
        .await
        .unwrap()
        .unwrap();
      assert!(updated_state.edit_revision > state.edit_revision);
      assert_eq!(
        updated_state.collapsed_group_keys, state.collapsed_group_keys,
        "Status grouping keys are unrelated to the converted Select filter"
      );
      assert_eq!(updated_state.search_text, state.search_text);
      assert_eq!(updated_state.sort, state.sort);
      assert_eq!(updated_state.field_width_overrides, state.field_width_overrides);
      assert_eq!(
        updated_state.filter_tree.as_ref().unwrap().rules,
        state.filter_tree.as_ref().unwrap().rules
      );
      assert_eq!(
        updated_state.filter_tree.as_ref().unwrap().groups[0].rules[0].value,
        DatabaseFilterValue::Ids(vec!["b".into(), "c".into()])
      );
      assert_eq!(
        serde_json::to_value(
          new_repo
            .get_view_user_state(other.id, fixture.owner)
            .await
            .unwrap()
            .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&other_state).unwrap()
      );
      for field in &root_before.fields {
        let next = current.fields.iter().find(|next| next.id == field.id).unwrap();
        if field.id != single && field.id != multi {
          assert_eq!(
            serde_json::to_value(next).unwrap(),
            serde_json::to_value(field).unwrap()
          );
        }
      }
      for view in &root_before.views {
        assert_eq!(
          serde_json::to_value(current.views.iter().find(|next| next.id == view.id).unwrap()).unwrap(),
          serde_json::to_value(view).unwrap()
        );
      }
      assert_eq!(
        serde_json::to_value(&current.field_roles).unwrap(),
        serde_json::to_value(&root_before.field_roles).unwrap()
      );
      assert_eq!(
        serde_json::to_value(&current.view_roles).unwrap(),
        serde_json::to_value(&root_before.view_roles).unwrap()
      );
      let stale_cell = new_repo
        .update_cell_value(
          live,
          single,
          DatabaseCellValueData::Select("c".into()),
          fixture.owner,
          DatabaseEditPrecondition::new(Some(1), false)
            .in_workspace(fixture.workspace)
            .in_database(source.database.id),
          None,
        )
        .await
        .expect_err("stale Cell draft conflicts");
      assert!(matches!(
        stale_cell,
        myoxus_domain::repositories::RepositoryError::Conflict("database cell edit revision")
      ));
      assert!(
        new_repo
          .update_row_template(
            template.id,
            None,
            None,
            None,
            None,
            None,
            Some(template.initial_cell_values.clone()),
            fixture.owner,
            DatabaseEditPrecondition::new(Some(template.edit_revision), false)
              .in_workspace(fixture.workspace)
              .in_database(source.database.id)
          )
          .await
          .is_err()
      );
      assert!(
        new_repo
          .upsert_view_user_state(
            state.clone(),
            Some(state.edit_revision),
            fixture.fence(source.database.id)
          )
          .await
          .is_err()
      );
      // Reset removes the row, but must never recycle an earlier draft token.
      new_repo
        .reset_view_user_state(
          grouped.id,
          fixture.owner,
          Some(updated_state.edit_revision),
          fixture.fence(source.database.id),
        )
        .await
        .expect("reset current personal state");
      assert!(
        new_repo
          .get_view_user_state(grouped.id, fixture.owner)
          .await
          .unwrap()
          .is_none()
      );
      let recreated = new_repo
        .upsert_view_user_state(updated_state.clone(), Some(0), fixture.fence(source.database.id))
        .await
        .expect("recreate absent state");
      assert!(recreated.edit_revision > updated_state.edit_revision);
      assert!(matches!(
        new_repo
          .upsert_view_user_state(
            state.clone(),
            Some(state.edit_revision),
            fixture.fence(source.database.id)
          )
          .await,
        Err(myoxus_domain::repositories::RepositoryError::Conflict(
          "database view user-state edit revision"
        ))
      ));
      assert!(matches!(
        new_repo
          .reset_view_user_state(
            grouped.id,
            fixture.owner,
            Some(state.edit_revision),
            fixture.fence(source.database.id)
          )
          .await,
        Err(myoxus_domain::repositories::RepositoryError::Conflict(
          "database view user-state edit revision"
        ))
      ));
      assert_eq!(
        serde_json::to_value(
          new_repo
            .get_view_user_state(grouped.id, fixture.owner)
            .await
            .unwrap()
            .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&recreated).unwrap()
      );
      let repeated = initializer
        .ensure(fixture.workspace, None)
        .await
        .expect("no repeated mapping");
      assert_eq!(
        serde_json::to_value(repeated).unwrap(),
        serde_json::to_value(&current).unwrap()
      );
      let search: (String, String) =
        sqlx::query_as("SELECT title,search_text FROM workspace_database_row_search WHERE row_id=$1")
          .bind(live)
          .fetch_one(&fixture.pool)
          .await
          .expect("canonical post-commit search refreshed");
      assert_eq!(search.0, "Original facts");
      assert!(search.1.split_whitespace().any(|value| value == "b"));
      assert!(!search.1.split_whitespace().any(|value| value == "a"));
      assert_eq!(changes.0.lock().unwrap().len(), 1);
    })
    .catch_unwind()
    .await;
    fixture.cleanup().await;
    if let Err(panic) = outcome {
      std::panic::resume_unwind(panic)
    }
  }
}
