//! Integration tests for P-DB-29B-C: realtime change-event emission + stale-write contract.
//!
//! Each test injects a `RecordingDatabaseChangeNotification` into the
//! immutable Database mutation-effects boundary (mirroring the
//! `RecordingCalendarBroadcast` pattern in
//! `calendar/inv_calendar_realtime_test.rs`) and asserts that:
//!
//!   * every successful mutation triggers exactly one `publish_change`
//!     call carrying the correct `DatabaseChangeKind`,
//!     `workspace_id`, `database_id`, `actor_user_id` and
//!     `event_id`;
//!   * failed transactions (validation failures, missing rows) trigger
//!     **zero** `publish_change` calls;
//!   * stale writes return the `MIX_DATABASE_*_CONFLICT` error code with
//!     a `latest_state` JSON snapshot that the client can render a
//!     conflict-resolution modal from;
//!   * force-overwrites still emit a change event.
//!
//! Run with:
//!   cargo test -p myoxus-api --test integration -- pdb29b

use myoxus_domain::database::{DatabaseDefinitionRepository, DatabaseEditingRepository, DatabaseViewRepository};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use myoxus_api::websocket::redis_adapter::{CrossInstanceBroadcast, RedisWsAdapter};
use myoxus_application::auth::{AuthUser, InMemoryAuthStore};
use myoxus_application::database::{DatabaseLimits, DatabaseServices, InitialDatabaseViewKind};
use myoxus_application::doc::DocService;
use myoxus_application::permission::PermissionService;
use myoxus_application::ports::database_change::{DatabaseChangeNotificationPort, classify_publish_error};
use myoxus_application::ports::{PortError, PortResult};
use myoxus_application::workspace::WorkspaceStore as _;
use myoxus_domain::database::{DatabaseCellValueData, DatabaseFieldType, DatabaseRowKind};
use myoxus_domain::database_change::DatabaseChangeEvent;
use myoxus_domain::entities::{MembershipStatus, WorkspaceRole};
use myoxus_domain::ids::{DatabaseFieldId, DatabaseId, DatabaseRowId, WorkspaceId};
use myoxus_domain::repositories::PageRequest;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::redis::RedisAdapter;
use myoxus_infrastructure::workspace_database::PgDatabaseRepository;
use uuid::Uuid;

use crate::helpers;

// ── Recording change-notification port ─────────────────────────────────────────

/// Records every `publish_change` invocation in shared memory so the
/// test can assert call counts, event payloads and ordering. Mirrors
/// `RecordingCalendarBroadcast` in `inv_calendar_realtime_test.rs` —
/// kept private to this test file because production code must not
/// depend on it.
struct RecordingDatabaseChangeNotification {
  calls: Arc<Mutex<Vec<DatabaseChangeEvent>>>,
  task_hints: Arc<Mutex<Vec<DatabaseChangeEvent>>>,
}

impl RecordingDatabaseChangeNotification {
  fn new() -> (
    Self,
    Arc<Mutex<Vec<DatabaseChangeEvent>>>,
    Arc<Mutex<Vec<DatabaseChangeEvent>>>,
  ) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let task_hints = Arc::new(Mutex::new(Vec::new()));
    (
      Self {
        calls: calls.clone(),
        task_hints: task_hints.clone(),
      },
      calls,
      task_hints,
    )
  }
}

#[async_trait]
impl DatabaseChangeNotificationPort for RecordingDatabaseChangeNotification {
  async fn publish_tasks_changed(&self, event: &DatabaseChangeEvent) -> PortResult<()> {
    self.task_hints.lock().unwrap().push(event.clone());
    Ok(())
  }

  async fn publish_change(&self, event: &DatabaseChangeEvent) -> PortResult<()> {
    self.calls.lock().unwrap().push(event.clone());
    Ok(())
  }
}

// ── Test harness ──────────────────────────────────────────────────────────────

struct Harness {
  pool: sqlx::PgPool,
  user_id: Uuid,
  workspace_id: WorkspaceId,
  service: Arc<DatabaseServices>,
  calls: Arc<Mutex<Vec<DatabaseChangeEvent>>>,
  task_hints: Arc<Mutex<Vec<DatabaseChangeEvent>>>,
}

async fn setup(suffix: &str) -> Harness {
  let pool = helpers::setup_pool().await;
  let store = Arc::new(InMemoryAuthStore::default());
  let user_id = helpers::create_user(&pool, suffix, false).await;
  store.insert_user(AuthUser {
    id: user_id,
    email: format!("{suffix}_{user_id}@example.test"),
    name: Some("test".to_string()),
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: Some(Utc::now()),
    registered: true,
  });
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  store
    .add_or_update_member(
      workspace_id,
      user_id,
      WorkspaceRole::Owner,
      MembershipStatus::Accepted,
      None,
    )
    .await
    .expect("member insert");

  let repo = Arc::new(PgDatabaseRepository::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let doc_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let permission = Arc::new(PermissionService::new(store.clone()));
  let (recording, calls, task_hints) = RecordingDatabaseChangeNotification::new();
  let service = Arc::new(DatabaseServices::new(
    repo,
    doc_service,
    permission,
    DatabaseLimits::default(),
    Arc::new(myoxus_infrastructure::workspace::SqlxWorkspaceStore::new(
      pool.clone(),
      crate::helpers::database_starter_catalog(),
    )),
    crate::helpers::database_starter_catalog(),
    myoxus_application::database::DatabaseServiceDependencies::disabled().with_effects(
      myoxus_application::database::DatabaseMutationEffects::disabled().with_change_notifications(Arc::new(recording)),
    ),
  ));

  Harness {
    pool,
    user_id,
    workspace_id,
    service,
    calls,
    task_hints,
  }
}

async fn create_text_database(harness: &Harness) -> DatabaseId {
  let record = harness
    .service
    .definition
    .create_database(
      harness.user_id,
      harness.workspace_id,
      format!("pdb29b-{}", Uuid::new_v4()),
      None,
      InitialDatabaseViewKind::Table,
    )
    .await
    .expect("create_database");
  // Drain the create_database emit so per-mutation assertions below
  // see only the events they care about.
  harness.calls.lock().unwrap().clear();
  harness.task_hints.lock().unwrap().clear();
  record.database.id
}

async fn create_text_field(harness: &Harness, database_id: DatabaseId) -> DatabaseFieldId {
  let field = harness
    .service
    .definition
    .create_field(
      harness.user_id,
      database_id,
      "Body".to_string(),
      DatabaseFieldType::Text,
      myoxus_domain::database::DatabaseFieldConfig::empty_for(DatabaseFieldType::Text),
      false,
    )
    .await
    .expect("create_field");
  let field_id = field.id;
  harness.calls.lock().unwrap().clear();
  harness.task_hints.lock().unwrap().clear();
  field_id
}

async fn create_record_row(harness: &Harness, database_id: DatabaseId) -> DatabaseRowId {
  let row = harness
    .service
    .editing
    .create_row(harness.user_id, database_id, Some("Row".to_string()), vec![])
    .await
    .expect("create_row");
  harness.calls.lock().unwrap().clear();
  harness.task_hints.lock().unwrap().clear();
  row.row.id
}

async fn cleanup(harness: &Harness) {
  helpers::cleanup_workspaces(&harness.pool, &[harness.workspace_id]).await;
  helpers::cleanup_users(&harness.pool, &[harness.user_id]).await;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// INV-P-DB-29B-C-1: a successful `update_cell_value` triggers exactly
/// one `CellUpdated` event with the right `workspace_id`,
/// `database_id`, `actor_user_id` and `target.row_id`.
#[tokio::test]
async fn pdb29b_emitted_only_after_committed_cell_value_update() {
  let harness = setup("pdb29b-emit-cell").await;
  let database_id = create_text_database(&harness).await;
  let field_id = create_text_field(&harness, database_id).await;
  let row_id = create_record_row(&harness, database_id).await;

  let value = DatabaseCellValueData::Text("hello".to_string());

  harness
    .service
    .editing
    .update_cell_value(harness.user_id, database_id, row_id, field_id, value)
    .await
    .expect("update_cell_value must succeed");

  let snapshot = harness.calls.lock().unwrap().clone();
  assert_eq!(
    snapshot.len(),
    1,
    "expected exactly one publish_change call, got {snapshot:?}"
  );
  let hints = harness.task_hints.lock().unwrap().clone();
  assert_eq!(hints.len(), 1, "one workspace invalidation after commit");
  assert_eq!(hints[0].event_id, snapshot[0].event_id);
  assert_eq!(hints[0].workspace_id, harness.workspace_id);
  let event = &snapshot[0];
  assert_eq!(event.workspace_id, harness.workspace_id);
  assert_eq!(event.database_id, database_id);
  assert_eq!(event.actor_user_id, Some(harness.user_id));
  assert!(
    matches!(
      event.kind,
      myoxus_domain::database_change::DatabaseChangeKind::CellUpdated
    ),
    "expected CellUpdated, got {:?}",
    event.kind
  );
  assert_eq!(event.target.row_id, Some(row_id));
  cleanup(&harness).await;
}

/// Empty editable values share the dedicated clear path so collaboration,
/// activity, audit and search side effects cannot drift between two APIs.
#[tokio::test]
async fn pdb29b_empty_cell_update_emits_committed_clear_change() {
  let harness = setup("pdb29b-empty-cell-clear").await;
  let database_id = create_text_database(&harness).await;
  let field_id = harness
    .service
    .definition
    .create_field(
      harness.user_id,
      database_id,
      "Link".to_string(),
      DatabaseFieldType::Url,
      myoxus_domain::database::DatabaseFieldConfig::empty_for(DatabaseFieldType::Url),
      false,
    )
    .await
    .expect("create URL field")
    .id;
  harness.calls.lock().unwrap().clear();
  harness.task_hints.lock().unwrap().clear();
  let row_id = create_record_row(&harness, database_id).await;

  harness
    .service
    .editing
    .update_cell_value(
      harness.user_id,
      database_id,
      row_id,
      field_id,
      DatabaseCellValueData::Url("https://example.test/stored".to_string()),
    )
    .await
    .expect("seed text value");
  harness.calls.lock().unwrap().clear();
  harness.task_hints.lock().unwrap().clear();

  harness
    .service
    .editing
    .update_cell_value(
      harness.user_id,
      database_id,
      row_id,
      field_id,
      DatabaseCellValueData::Url(String::new()),
    )
    .await
    .expect("empty text clears the cell");

  let snapshot = harness.calls.lock().unwrap().clone();
  assert_eq!(snapshot.len(), 1, "clear must emit one change: {snapshot:?}");
  assert!(matches!(
    snapshot[0].kind,
    myoxus_domain::database_change::DatabaseChangeKind::CellUpdated
  ));
  assert_eq!(snapshot[0].target.row_id, Some(row_id));
  assert_eq!(snapshot[0].target.field_id, Some(field_id));

  let stored_value = sqlx::query_scalar::<_, Option<serde_json::Value>>(
    "SELECT value_json FROM workspace_database_cell_values WHERE row_id = $1 AND field_id = $2",
  )
  .bind(row_id)
  .bind(field_id)
  .fetch_one(&harness.pool)
  .await
  .expect("read cleared cell");
  assert!(
    stored_value.is_none(),
    "empty update must persist the canonical null cell value"
  );
  cleanup(&harness).await;
}

/// INV-P-DB-29B-C-2: a failed transaction (update against a
/// non-existent row) MUST NOT trigger a `publish_change` call.
#[tokio::test]
async fn pdb29b_failed_cell_value_update_does_not_emit() {
  let harness = setup("pdb29b-fail-cell").await;
  let database_id = create_text_database(&harness).await;
  let field_id = create_text_field(&harness, database_id).await;

  let bogus_row_id = DatabaseRowId::new_v4();
  let value = DatabaseCellValueData::Text("x".to_string());

  let outcome = harness
    .service
    .editing
    .update_cell_value(harness.user_id, database_id, bogus_row_id, field_id, value)
    .await;
  assert!(
    outcome.is_err(),
    "update against a non-existent row must fail: {outcome:?}"
  );
  let err = outcome.err().unwrap();
  assert_eq!(
    err.code, "MIX_DATABASE_NOT_FOUND",
    "expected NOT_FOUND rejection, got {}",
    err.code
  );

  let snapshot = harness.calls.lock().unwrap().clone();
  assert!(
    snapshot.is_empty(),
    "no publish_change may occur after a failed transaction; got {snapshot:?}"
  );
  cleanup(&harness).await;
}

/// INV-P-DB-29B-C-3: stale-write preconditions return
/// `MIX_DATABASE_CELL_CONFLICT` with a `latest_state` JSON snapshot so
/// the GraphQL resolver can surface it via `latestState`.
#[tokio::test]
async fn pdb29b_stale_cell_value_update_returns_cell_conflict_with_latest_state() {
  let harness = setup("pdb29b-conflict-cell").await;
  let database_id = create_text_database(&harness).await;
  let field_id = create_text_field(&harness, database_id).await;
  let row_id = create_record_row(&harness, database_id).await;

  let value = DatabaseCellValueData::Text("stale write".to_string());

  let outcome = harness
    .service
    .editing
    .update_cell_value_with_precondition(harness.user_id, database_id, row_id, field_id, value, Some(1), false)
    .await;
  let err = outcome.expect_err("stale write must be rejected with conflict");
  assert_eq!(
    err.code, "MIX_DATABASE_CELL_CONFLICT",
    "expected MIX_DATABASE_CELL_CONFLICT, got {}",
    err.code
  );
  let latest = err
    .latest_state
    .expect("conflict must carry latest_state for the client modal");
  assert_eq!(latest["rowId"], row_id.to_string());
  assert_eq!(latest["databaseId"], database_id.to_string());
  assert!(
    latest["editRevision"] == 0,
    "a never-written cell must report revision 0, got {latest}"
  );

  // A stale write must not emit any change event.
  let snapshot = harness.calls.lock().unwrap().clone();
  assert!(
    snapshot.is_empty(),
    "stale write must not emit a change event; got {snapshot:?}"
  );
  cleanup(&harness).await;
}

/// INV-P-DB-29B-C-4: force-overwrite bypasses the conflict and emits a
/// change event. The post-condition must hold: the cell value reflects
/// the new write and one `publish_change` was emitted.
#[tokio::test]
async fn pdb29b_force_overwrite_emits_change_event() {
  let harness = setup("pdb29b-force-cell").await;
  let database_id = create_text_database(&harness).await;
  let field_id = create_text_field(&harness, database_id).await;
  let row_id = create_record_row(&harness, database_id).await;

  let value = DatabaseCellValueData::Text("force-write wins".to_string());

  harness
    .service
    .editing
    .update_cell_value_with_precondition(harness.user_id, database_id, row_id, field_id, value, Some(1), true)
    .await
    .expect("force=true must bypass the conflict and write the cell");

  let snapshot = harness.calls.lock().unwrap().clone();
  assert_eq!(
    snapshot.len(),
    1,
    "forced overwrite must emit exactly one CellUpdated event; got {snapshot:?}"
  );
  let event = &snapshot[0];
  assert!(
    matches!(
      event.kind,
      myoxus_domain::database_change::DatabaseChangeKind::CellUpdated
    ),
    "expected CellUpdated, got {:?}",
    event.kind
  );
  assert_eq!(event.target.row_id, Some(row_id));

  // The post-state of the cell must reflect the forced value.
  let page = harness
    .service
    .views
    .list_rows(harness.user_id, database_id, PageRequest { limit: 50, offset: 0 })
    .await
    .expect("list_rows after force");
  let row_read = page
    .rows
    .iter()
    .find(|r| r.row.id == row_id)
    .expect("row present after force");
  let stored = row_read
    .cells
    .iter()
    .find(|c| c.field_id == field_id)
    .expect("cell stored after force");
  match &stored.value {
    DatabaseCellValueData::Text(s) => assert_eq!(s, "force-write wins"),
    other => panic!("expected Text cell value, got {other:?}"),
  }
  cleanup(&harness).await;
}

// ── Defensive: classify_publish_error maps every variant to a stable label ───

#[test]
fn pdb29b_classify_publish_error_is_stable() {
  assert_eq!(
    classify_publish_error(&PortError::InvalidInput("x".into())),
    "invalid_input"
  );
  assert_eq!(
    classify_publish_error(&PortError::NotFound("x".into())),
    "no_subscribers"
  );
  assert_eq!(classify_publish_error(&PortError::Conflict("x".into())), "conflict");
  assert_eq!(
    classify_publish_error(&PortError::Transport("x".into())),
    "transport_failure"
  );
}

/// Atomicity regression gate for the five independently mutable entity
/// families. Both callers start from the same committed revision and are
/// released by the same barrier. The repository lock and in-transaction
/// comparison must permit exactly one normal write.
#[tokio::test]
async fn pdb29b_concurrent_same_revision_writes_have_exactly_one_winner_per_family() {
  use std::collections::HashMap;
  use tokio::sync::Barrier;

  let harness = setup("pdb29b-atomic-families").await;
  let database_id = create_text_database(&harness).await;
  let field_id = create_text_field(&harness, database_id).await;
  let row_id = create_record_row(&harness, database_id).await;

  let barrier = Arc::new(Barrier::new(2));
  let (cell_a, cell_b) = tokio::join!(
    async {
      barrier.wait().await;
      harness
        .service
        .editing
        .update_cell_value_with_precondition(
          harness.user_id,
          database_id,
          row_id,
          field_id,
          DatabaseCellValueData::Text("cell-a".into()),
          Some(0),
          false,
        )
        .await
    },
    async {
      barrier.wait().await;
      harness
        .service
        .editing
        .update_cell_value_with_precondition(
          harness.user_id,
          database_id,
          row_id,
          field_id,
          DatabaseCellValueData::Text("cell-b".into()),
          Some(0),
          false,
        )
        .await
    }
  );
  assert_eq!(usize::from(cell_a.is_ok()) + usize::from(cell_b.is_ok()), 1);
  let cell_loser = cell_a.err().or_else(|| cell_b.err()).expect("one cell loser");
  assert_eq!(cell_loser.code, "MIX_DATABASE_CELL_CONFLICT");
  assert_eq!(
    cell_loser
      .latest_state
      .as_ref()
      .and_then(|value| value["editRevision"].as_i64()),
    Some(1)
  );

  let barrier = Arc::new(Barrier::new(2));
  let (row_a, row_b) = tokio::join!(
    async {
      barrier.wait().await;
      harness
        .service
        .editing
        .update_row_position_with_precondition(harness.user_id, database_id, row_id, 1, Some(1), false)
        .await
    },
    async {
      barrier.wait().await;
      harness
        .service
        .editing
        .update_row_position_with_precondition(harness.user_id, database_id, row_id, 2, Some(1), false)
        .await
    }
  );
  assert_eq!(usize::from(row_a.is_ok()) + usize::from(row_b.is_ok()), 1);
  assert_eq!(
    row_a.err().or_else(|| row_b.err()).expect("one row loser").code,
    "MIX_DATABASE_ROW_CONFLICT"
  );

  let barrier = Arc::new(Barrier::new(2));
  let (field_a, field_b) = tokio::join!(
    async {
      barrier.wait().await;
      harness
        .service
        .definition
        .update_field_with_precondition(
          harness.user_id,
          database_id,
          field_id,
          Some("Field A".into()),
          None,
          None,
          Some(1),
          false,
        )
        .await
    },
    async {
      barrier.wait().await;
      harness
        .service
        .definition
        .update_field_with_precondition(
          harness.user_id,
          database_id,
          field_id,
          Some("Field B".into()),
          None,
          None,
          Some(1),
          false,
        )
        .await
    }
  );
  assert_eq!(usize::from(field_a.is_ok()) + usize::from(field_b.is_ok()), 1);
  assert_eq!(
    field_a.err().or_else(|| field_b.err()).expect("one field loser").code,
    "MIX_DATABASE_FIELD_CONFLICT"
  );

  let record = harness
    .service
    .definition
    .get_database(harness.user_id, database_id)
    .await
    .expect("database record");
  let view = record.views.first().expect("initial view");
  let view_id = view.id;
  let view_revision = view.edit_revision;
  let barrier = Arc::new(Barrier::new(2));
  let (view_a, view_b) = tokio::join!(
    async {
      barrier.wait().await;
      harness
        .service
        .views
        .update_view_with_precondition(
          harness.user_id,
          database_id,
          view_id,
          Some("View A".into()),
          None,
          None,
          Some(view_revision),
          false,
        )
        .await
    },
    async {
      barrier.wait().await;
      harness
        .service
        .views
        .update_view_with_precondition(
          harness.user_id,
          database_id,
          view_id,
          Some("View B".into()),
          None,
          None,
          Some(view_revision),
          false,
        )
        .await
    }
  );
  assert_eq!(usize::from(view_a.is_ok()) + usize::from(view_b.is_ok()), 1);
  assert_eq!(
    view_a.err().or_else(|| view_b.err()).expect("one view loser").code,
    "MIX_DATABASE_VIEW_CONFLICT"
  );

  let bulk_field_id = create_text_field(&harness, database_id).await;
  let bulk_row_id = create_record_row(&harness, database_id).await;
  let expected = HashMap::from([(bulk_row_id, 0)]);
  let barrier = Arc::new(Barrier::new(2));
  let (bulk_a, bulk_b) = tokio::join!(
    async {
      barrier.wait().await;
      harness
        .service
        .editing
        .bulk_set_cell_value_with_precondition(
          harness.user_id,
          database_id,
          &[bulk_row_id],
          bulk_field_id,
          DatabaseCellValueData::Text("bulk-a".into()),
          &expected,
          false,
        )
        .await
    },
    async {
      barrier.wait().await;
      harness
        .service
        .editing
        .bulk_set_cell_value_with_precondition(
          harness.user_id,
          database_id,
          &[bulk_row_id],
          bulk_field_id,
          DatabaseCellValueData::Text("bulk-b".into()),
          &expected,
          false,
        )
        .await
    }
  );
  assert_eq!(usize::from(bulk_a.is_ok()) + usize::from(bulk_b.is_ok()), 1);
  assert_eq!(
    bulk_a.err().or_else(|| bulk_b.err()).expect("one bulk loser").code,
    "MIX_DATABASE_BULK_CONFLICT"
  );

  cleanup(&harness).await;
}

/// Repository-level revision semantics: schema defaults are present, absent
/// cells begin at zero, successful set/clear/force writes increment once, and
/// a rejected stale write leaves the committed revision unchanged.
#[tokio::test]
async fn pdb29b_edit_revision_defaults_tombstones_and_increment_semantics_are_stable() {
  let harness = setup("pdb29b-revision-semantics").await;
  let database_id = create_text_database(&harness).await;
  let field_id = create_text_field(&harness, database_id).await;
  let row_id = create_record_row(&harness, database_id).await;

  for table in [
    "workspace_databases",
    "workspace_database_fields",
    "workspace_database_views",
    "workspace_database_rows",
    "workspace_database_cell_values",
  ] {
    let default: Option<String> = sqlx::query_scalar(
      r#"
        SELECT column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'edit_revision'
      "#,
    )
    .bind(table)
    .fetch_one(&harness.pool)
    .await
    .expect("edit_revision schema projection");
    assert!(
      default.as_deref().is_some_and(|value| value.contains('1')),
      "{table} must default edit_revision to 1"
    );
  }

  let initial = harness
    .service
    .definition
    .get_database(harness.user_id, database_id)
    .await
    .expect("initial record");
  assert_eq!(initial.database.edit_revision, 1);
  assert!(initial.fields.iter().all(|field| field.edit_revision == 1));
  assert!(initial.views.iter().all(|view| view.edit_revision == 1));
  let initial_row = harness
    .service
    .views
    .list_rows(harness.user_id, database_id, PageRequest { limit: 10, offset: 0 })
    .await
    .expect("initial rows")
    .rows
    .into_iter()
    .find(|row| row.row.id == row_id)
    .expect("created row");
  assert_eq!(initial_row.row.edit_revision, 1);
  assert!(
    !initial_row
      .cell_revisions
      .iter()
      .any(|revision| revision.field_id == field_id)
  );

  let first = harness
    .service
    .editing
    .update_cell_value_with_precondition(
      harness.user_id,
      database_id,
      row_id,
      field_id,
      DatabaseCellValueData::Text("first".into()),
      Some(0),
      false,
    )
    .await
    .expect("absent revision zero insert");
  assert_eq!(first.edit_revision, 1);

  let stale = harness
    .service
    .editing
    .update_cell_value_with_precondition(
      harness.user_id,
      database_id,
      row_id,
      field_id,
      DatabaseCellValueData::Text("stale".into()),
      Some(0),
      false,
    )
    .await
    .expect_err("stale baseline");
  assert_eq!(stale.code, "MIX_DATABASE_CELL_CONFLICT");
  assert_eq!(
    stale
      .latest_state
      .as_ref()
      .and_then(|state| state["editRevision"].as_i64()),
    Some(1)
  );

  let cleared = harness
    .service
    .editing
    .clear_cell_value_with_precondition(harness.user_id, database_id, row_id, field_id, Some(1), false)
    .await
    .expect("clear revision tombstone");
  assert_eq!(cleared.edit_revision, 2);
  assert!(!cleared.has_value);

  let forced = harness
    .service
    .editing
    .update_cell_value_with_precondition(
      harness.user_id,
      database_id,
      row_id,
      field_id,
      DatabaseCellValueData::Text("forced".into()),
      Some(0),
      true,
    )
    .await
    .expect("forced write");
  assert_eq!(forced.edit_revision, 3);

  cleanup(&harness).await;
}

/// Live Redis contract used by cross-instance Database collaboration. This is
/// intentionally not an in-memory adapter test: it proves Pub/Sub delivery and
/// room-presence persistence against the isolated test Redis.
#[tokio::test]
async fn pdb29b_live_redis_delivers_remote_change_and_shared_presence() {
  use redis::AsyncCommands;

  let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
  let namespace = format!("pdb29b-{}", Uuid::new_v4());
  let adapter = Arc::new(RedisAdapter::new(&redis_url, &namespace).expect("test Redis adapter"));
  let websocket = RedisWsAdapter::new(Uuid::new_v4(), adapter.clone());
  let mut subscriber = websocket.start_subscriber().await.expect("Redis websocket subscriber");
  tokio::time::sleep(std::time::Duration::from_millis(100)).await;

  let workspace_id = Uuid::new_v4();
  let database_id = Uuid::new_v4();
  let payload = serde_json::json!({
    "workspaceId": workspace_id,
    "databaseId": database_id,
    "eventId": Uuid::new_v4(),
    "kind": "cell_updated",
  });
  let remote = CrossInstanceBroadcast {
    origin_instance: format!("remote-{}", Uuid::new_v4()),
    event: "database:change".to_string(),
    workspace_id: workspace_id.to_string(),
    payload: payload.clone(),
    sender_socket_id: "remote-socket".to_string(),
  };
  let channel = format!("{namespace}:ws:broadcast:{workspace_id}");
  let mut connection = adapter
    .client()
    .get_multiplexed_async_connection()
    .await
    .expect("Redis connection");
  connection
    .publish::<_, _, ()>(&channel, serde_json::to_string(&remote).expect("broadcast JSON"))
    .await
    .expect("publish remote Database change");
  let delivered = tokio::time::timeout(std::time::Duration::from_secs(2), subscriber.recv())
    .await
    .expect("remote Database change timeout")
    .expect("remote Database change delivery");
  assert_eq!(delivered.event, "database:change");
  assert_eq!(delivered.payload, payload);

  let hint = serde_json::json!({"workspaceId":workspace_id,"databaseId":database_id,"eventId":Uuid::new_v4()});
  websocket
    .broadcast_to_workspace(&workspace_id.to_string(), "database:tasks-changed", &hint, "")
    .await;
  assert!(
    tokio::time::timeout(std::time::Duration::from_millis(100), subscriber.recv())
      .await
      .is_err(),
    "ordinary API origin is suppressed because local fanout owns delivery"
  );
  let remote_hint = CrossInstanceBroadcast {
    origin_instance: format!("remote-{}", Uuid::new_v4()),
    event: "database:tasks-changed".into(),
    workspace_id: workspace_id.to_string(),
    payload: hint.clone(),
    sender_socket_id: String::new(),
  };
  connection
    .publish::<_, _, ()>(&channel, serde_json::to_string(&remote_hint).expect("remote hint JSON"))
    .await
    .expect("publish remote Task hint");
  let received_hint = tokio::time::timeout(std::time::Duration::from_secs(2), subscriber.recv())
    .await
    .expect("remote Task hint timeout")
    .expect("remote Task hint delivery");
  assert_eq!(received_hint.event, "database:tasks-changed");
  assert_eq!(received_hint.payload, hint);

  let socket_a = format!("socket-a-{}", Uuid::new_v4());
  let socket_b = format!("socket-b-{}", Uuid::new_v4());
  let presence = |socket_id: &str, name: &str| {
    serde_json::json!({
      "socketId": socket_id,
      "userId": Uuid::new_v4(),
      "displayName": name,
      "viewId": serde_json::Value::Null,
      "rowId": serde_json::Value::Null,
      "fieldId": serde_json::Value::Null,
      "dragging": false,
      "lastActiveAt": chrono::Utc::now().to_rfc3339(),
    })
  };
  websocket
    .upsert_database_presence(workspace_id, database_id, &socket_a, &presence(&socket_a, "Alice"))
    .await;
  websocket
    .upsert_database_presence(workspace_id, database_id, &socket_b, &presence(&socket_b, "Bob"))
    .await;
  let shared = websocket.list_database_presence(workspace_id, database_id).await;
  assert_eq!(shared.len(), 2, "both Redis-backed sockets must be visible");
  websocket
    .remove_database_presence(workspace_id, database_id, &socket_a)
    .await;
  websocket
    .remove_database_presence(workspace_id, database_id, &socket_b)
    .await;
  assert!(
    websocket
      .list_database_presence(workspace_id, database_id)
      .await
      .is_empty()
  );

  let stale_socket = format!("stale-socket-{}", Uuid::new_v4());
  websocket
    .upsert_database_presence(
      workspace_id,
      database_id,
      &stale_socket,
      &serde_json::json!({
        "socketId": stale_socket,
        "userId": Uuid::new_v4(),
        "displayName": "Stale collaborator",
        "viewId": serde_json::Value::Null,
        "rowId": serde_json::Value::Null,
        "fieldId": serde_json::Value::Null,
        "dragging": false,
        "lastActiveAt": (chrono::Utc::now() - chrono::Duration::seconds(91)).to_rfc3339(),
      }),
    )
    .await;
  assert!(
    websocket
      .list_database_presence(workspace_id, database_id)
      .await
      .is_empty(),
    "Redis presence readers must prune records older than the 90-second contract"
  );
}

// ── Coverage sweep: every service-level mutation MUST publish exactly
//    one matching change event on the success path. The harness above
//    already covers cell writes; this block extends that guarantee to
//    the remaining surfaces so a future refactor that drops an emit
//    turns a yellow light into a red one in CI.

#[tokio::test]
async fn pdb29b_database_create_emits_database_created_event() {
  let harness = setup("pdb29b-create-db").await;
  let record = harness
    .service
    .definition
    .create_database(
      harness.user_id,
      harness.workspace_id,
      "Creation event".to_string(),
      None,
      InitialDatabaseViewKind::Table,
    )
    .await
    .expect("database create");
  let snapshot = harness.calls.lock().unwrap().clone();
  assert_eq!(snapshot.len(), 1, "create must publish one event: {snapshot:?}");
  assert!(matches!(
    snapshot[0].kind,
    myoxus_domain::database_change::DatabaseChangeKind::DatabaseCreated
  ));
  assert_eq!(snapshot[0].database_id, record.database.id);
  cleanup(&harness).await;
}

#[tokio::test]
async fn pdb29b_row_create_then_delete_emits_row_created_and_row_deleted() {
  let harness = setup("pdb29b-row-lifecycle").await;
  let database_id = create_text_database(&harness).await;
  let _field_id = create_text_field(&harness, database_id).await;

  let row_id = harness
    .service
    .editing
    .create_row(harness.user_id, database_id, Some("L".to_string()), vec![])
    .await
    .expect("create_row")
    .row
    .id;
  harness.calls.lock().unwrap().clear();
  harness.task_hints.lock().unwrap().clear();

  harness
    .service
    .editing
    .delete_row(harness.user_id, database_id, row_id)
    .await
    .expect("delete_row");

  let snapshot = harness.calls.lock().unwrap().clone();
  assert_eq!(
    snapshot.len(),
    1,
    "exactly one RowDeleted event expected, got {snapshot:?}"
  );
  assert!(matches!(
    snapshot[0].kind,
    myoxus_domain::database_change::DatabaseChangeKind::RowDeleted
  ));
  assert_eq!(snapshot[0].target.row_id, Some(row_id));
  cleanup(&harness).await;
}

#[tokio::test]
async fn pdb29b_clear_cell_emits_cell_updated_event() {
  let harness = setup("pdb29b-clear").await;
  let database_id = create_text_database(&harness).await;
  let field_id = create_text_field(&harness, database_id).await;
  let row_id = create_record_row(&harness, database_id).await;

  // Seed a value so the clear has something to clear.
  harness
    .service
    .editing
    .update_cell_value(
      harness.user_id,
      database_id,
      row_id,
      field_id,
      DatabaseCellValueData::Text("seed".to_string()),
    )
    .await
    .expect("update_cell_value");
  harness.calls.lock().unwrap().clear();
  harness.task_hints.lock().unwrap().clear();

  harness
    .service
    .editing
    .clear_cell_value(harness.user_id, database_id, row_id, field_id)
    .await
    .expect("clear_cell_value");

  let snapshot = harness.calls.lock().unwrap().clone();
  assert_eq!(
    snapshot.len(),
    1,
    "exactly one CellUpdated event expected on clear, got {snapshot:?}"
  );
  assert!(matches!(
    snapshot[0].kind,
    myoxus_domain::database_change::DatabaseChangeKind::CellUpdated
  ));
  assert_eq!(snapshot[0].target.row_id, Some(row_id));
  assert_eq!(snapshot[0].target.field_id, Some(field_id));
  cleanup(&harness).await;
}

#[tokio::test]
async fn pdb29b_update_row_position_emits_row_moved_event() {
  let harness = setup("pdb29b-row-move").await;
  let database_id = create_text_database(&harness).await;
  let row_id = create_record_row(&harness, database_id).await;

  harness
    .service
    .editing
    .update_row_position(harness.user_id, database_id, row_id, 17)
    .await
    .expect("update_row_position");

  let snapshot = harness.calls.lock().unwrap().clone();
  assert_eq!(
    snapshot.len(),
    1,
    "exactly one RowMoved event expected, got {snapshot:?}"
  );
  assert!(matches!(
    snapshot[0].kind,
    myoxus_domain::database_change::DatabaseChangeKind::RowMoved
  ));
  assert_eq!(snapshot[0].target.row_id, Some(row_id));
  cleanup(&harness).await;
}

// ── Bulk-with-precondition contract (P-DB-29B-C, Bulk-Precondition-T3)
//
// The service exposes `bulk_*_with_precondition` methods that gate a
// whole batch on per-cell `expected_edit_revision` snapshots. Any stale
// target aborts the entire batch with `MIX_DATABASE_BULK_CONFLICT`; the
// `latest_state` payload enumerates every conflicting row so the client
// can render a conflict-resolution modal.

#[tokio::test]
async fn pdb29b_bulk_set_with_precondition_rejects_stale_batch_with_conflict() {
  use std::collections::HashMap;
  let harness = setup("pdb29b-bulk-set-precond").await;
  let database_id = create_text_database(&harness).await;
  let field_id = create_text_field(&harness, database_id).await;
  let row_a = create_record_row(&harness, database_id).await;
  let row_b = create_record_row(&harness, database_id).await;
  harness.calls.lock().unwrap().clear();
  harness.task_hints.lock().unwrap().clear();

  let mut expected = HashMap::new();
  expected.insert(row_a, 1);
  expected.insert(row_b, 1);

  let outcome = harness
    .service
    .editing
    .bulk_set_cell_value_with_precondition(
      harness.user_id,
      database_id,
      &[row_a, row_b],
      field_id,
      DatabaseCellValueData::Text("bulk-stale".to_string()),
      &expected,
      false,
    )
    .await;
  let err = outcome.expect_err("stale bulk must be rejected with conflict");
  assert_eq!(
    err.code, "MIX_DATABASE_BULK_CONFLICT",
    "expected MIX_DATABASE_BULK_CONFLICT, got {}",
    err.code
  );
  let latest = err.latest_state.expect("conflict must carry conflicts array");
  let conflicts = latest["conflicts"].as_array().expect("conflicts must be an array");
  assert_eq!(conflicts.len(), 2, "every stale row must be enumerated; got {latest}");

  // Stale writes MUST NOT emit any change events or aggregate hints.
  assert!(harness.task_hints.lock().unwrap().is_empty());
  let snapshot = harness.calls.lock().unwrap().clone();
  assert!(
    snapshot.is_empty(),
    "stale bulk write must not emit any event; got {snapshot:?}"
  );
  cleanup(&harness).await;
}

#[tokio::test]
async fn pdb29b_bulk_set_with_precondition_force_overwrite_emits_per_row_cell_updated() {
  use std::collections::HashMap;
  let harness = setup("pdb29b-bulk-set-force").await;
  let database_id = create_text_database(&harness).await;
  let field_id = create_text_field(&harness, database_id).await;
  let row_a = create_record_row(&harness, database_id).await;
  let row_b = create_record_row(&harness, database_id).await;
  let mut expected = HashMap::new();
  expected.insert(row_a, 99);
  expected.insert(row_b, 99);

  // An explicit force bypasses only the stale revision predicate.
  harness
    .service
    .editing
    .bulk_set_cell_value_with_precondition(
      harness.user_id,
      database_id,
      &[row_a, row_b],
      field_id,
      DatabaseCellValueData::Text("first".to_string()),
      &expected,
      true,
    )
    .await
    .expect("force overwrite must succeed");

  let snapshot = harness.calls.lock().unwrap().clone();
  // Filter to only CellUpdated emit-kind; the call also records an audit
  // entry for each forced row, but only CellUpdated events reach the
  // change-notification port.
  let cell_events: Vec<_> = snapshot
    .iter()
    .filter(|e| matches!(e.kind, myoxus_domain::database_change::DatabaseChangeKind::CellUpdated))
    .collect();
  assert_eq!(
    cell_events.len(),
    2,
    "one CellUpdated per row expected, got {cell_events:?}"
  );
  let touched: std::collections::HashSet<_> = cell_events.iter().filter_map(|e| e.target.row_id).collect();
  assert_eq!(touched, std::collections::HashSet::from([row_a, row_b]));
  cleanup(&harness).await;
}

// ── Defensive: keep module items reachable so the unused-import lint
//    doesn't bite us if a future refactor drops a usage.
#[allow(dead_code)]
fn touch_row_kind() -> DatabaseRowKind {
  DatabaseRowKind::Record
}
