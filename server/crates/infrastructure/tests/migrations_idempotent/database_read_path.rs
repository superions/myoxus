// SPDX-License-Identifier: AGPL-3.0-or-later
//! Repository-level performance and consistency invariants for Database reads.
//!
//! Query counters and statement triggers in this module are deliberately
//! test-local. Production repositories stay free of instrumentation state.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, Once};
use std::time::{Duration, Instant};

use myoxus_domain::database::{
  DatabaseCellValueData, DatabaseEditPrecondition, DatabaseInventoryFilter, DatabaseInventorySort,
  DatabaseLifecycleFilter, DatabaseProfileKind, DatabaseRowsQuery,
};
use myoxus_domain::database::{DatabaseDefinitionRepository, DatabaseEditingRepository, DatabaseViewRepository};
use myoxus_domain::repositories::{PageRequest, RepositoryError};
use myoxus_infrastructure::workspace_database::PgDatabaseRepository;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, Transaction};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;
use uuid::Uuid;

static INSTALL_QUERY_COUNTER: Once = Once::new();
static COUNT_SQLX_QUERIES: AtomicBool = AtomicBool::new(false);
static SQLX_QUERY_COUNT: AtomicUsize = AtomicUsize::new(0);
static CAPTURED_SQLX_FIELDS: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[derive(Default)]
struct SqlxFieldVisitor {
  fields: Vec<String>,
}

impl Visit for SqlxFieldVisitor {
  fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
    self.fields.push(format!("{}={value:?}", field.name()));
  }
}

struct SqlxQueryCounter;

impl<S> Layer<S> for SqlxQueryCounter
where
  S: Subscriber,
{
  fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
    if COUNT_SQLX_QUERIES.load(Ordering::Relaxed) && event.metadata().target() == "sqlx::query" {
      SQLX_QUERY_COUNT.fetch_add(1, Ordering::Relaxed);
      let mut visitor = SqlxFieldVisitor::default();
      event.record(&mut visitor);
      CAPTURED_SQLX_FIELDS
        .lock()
        .expect("capture SQLx event fields")
        .push(visitor.fields.join(" "));
    }
  }
}

fn install_query_counter() {
  INSTALL_QUERY_COUNTER.call_once(|| {
    tracing_subscriber::registry()
      .with(SqlxQueryCounter)
      .try_init()
      .expect("migrations_idempotent must own its test-local tracing subscriber");
  });
}

async fn setup_pool() -> PgPool {
  let url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  let pool = PgPoolOptions::new()
    .max_connections(6)
    .acquire_timeout(Duration::from_secs(30))
    .connect(&url)
    .await
    .expect("isolated test database must be reachable");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("Database read-path schema must apply");
  pool
}

async fn seed_owner_workspace(tx: &mut Transaction<'_, Postgres>, label: &str) -> (Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(format!("database-read-{user_id}@example.test"))
    .bind(format!("Database {label} owner"))
    .execute(&mut **tx)
    .await
    .expect("seed Database read owner");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
    .bind(workspace_id)
    .bind(user_id)
    .bind(format!("Database {label} workspace"))
    .execute(&mut **tx)
    .await
    .expect("seed Database read workspace");
  (user_id, workspace_id)
}

async fn cleanup_fixture(pool: &PgPool, user_id: Uuid, workspace_id: Uuid) {
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean Database read workspace");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("clean Database read owner");
}

struct SummaryFixture {
  user_id: Uuid,
  workspace_id: Uuid,
  database_ids: Vec<Uuid>,
  child_counts: HashMap<Uuid, (i64, i64)>,
}

async fn seed_summary_fixture(pool: &PgPool) -> SummaryFixture {
  let mut tx = pool.begin().await.expect("begin summary fixture");
  let (user_id, workspace_id) = seed_owner_workspace(&mut tx, "summary").await;
  let mut database_ids = (0..101).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
  let titles = (0..101).map(|index| format!("Database {index:03}")).collect::<Vec<_>>();
  let field_ids = (0..101).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
  let view_ids = (0..101).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
  let row_ids = (0..101).map(|_| Uuid::new_v4()).collect::<Vec<_>>();

  sqlx::query(
    "INSERT INTO workspace_databases (id, workspace_id, title, description, created_by, updated_by)
     SELECT item.id, $2, item.title, 'Summary fixture', $3, $3
     FROM unnest($1::uuid[], $4::text[]) AS item(id, title)",
  )
  .bind(&database_ids[50..])
  .bind(workspace_id)
  .bind(user_id)
  .bind(&titles[50..])
  .execute(&mut *tx)
  .await
  .expect("seed summary Databases");
  sqlx::query(
    "INSERT INTO workspace_database_fields
       (id, database_id, name, field_type, config_json, position, required)
     SELECT item.field_id, item.database_id, 'Summary field', 'text',
            '{\"kind\":\"text\",\"multiline\":false}'::jsonb, 0, false
     FROM unnest($1::uuid[], $2::uuid[]) AS item(field_id, database_id)",
  )
  .bind(&field_ids[50..])
  .bind(&database_ids[50..])
  .execute(&mut *tx)
  .await
  .expect("seed summary Fields");
  sqlx::query(
    "INSERT INTO workspace_database_views
       (id, database_id, name, view_kind, config_json, position)
     SELECT item.view_id, item.database_id, 'Summary view', 'table',
            jsonb_build_object('kind', 'table', 'titleFieldId', item.field_id::text), 0
     FROM unnest($1::uuid[], $2::uuid[], $3::uuid[])
       AS item(view_id, database_id, field_id)",
  )
  .bind(&view_ids[50..])
  .bind(&database_ids[50..])
  .bind(&field_ids[50..])
  .execute(&mut *tx)
  .await
  .expect("seed summary Views");
  sqlx::query(
    "INSERT INTO workspace_database_rows
       (id, database_id, title, position, created_by, updated_by)
     SELECT item.row_id, item.database_id, 'Summary row', 0, $3, $3
     FROM unnest($1::uuid[], $2::uuid[]) AS item(row_id, database_id)",
  )
  .bind(&row_ids[50..])
  .bind(&database_ids[50..])
  .bind(user_id)
  .execute(&mut *tx)
  .await
  .expect("seed summary Rows");
  sqlx::query("UPDATE workspace_databases SET deleted_at = now(), deleted_by = $2 WHERE id = $1")
    .bind(database_ids[100])
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .expect("seed one trashed summary");
  tx.commit().await.expect("publish summary fixture");

  let catalog = std::sync::Arc::new(
    myoxus_infrastructure::database_templates::load_database_template_catalog(
      &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
    )
    .expect("immutable source catalog"),
  );
  let repository = std::sync::Arc::new(PgDatabaseRepository::new(pool.clone(), catalog.clone()));
  myoxus_application::workspace::tasks::WorkspaceTasksInitializer::new(
    catalog.clone(),
    repository.clone(),
    std::sync::Arc::new(myoxus_application::database::DatabaseProjectionService::new(
      repository.clone(),
      repository.clone(),
      repository.clone(),
      repository.clone(),
      myoxus_application::database::DatabaseLimits::default(),
    )),
  )
  .ensure(workspace_id, None)
  .await
  .expect("canonical technical default excluded from inventory");
  let mut child_counts = database_ids[50..]
    .iter()
    .map(|id| (*id, (1, 1)))
    .collect::<HashMap<_, _>>();
  for index in 0..50 {
    let mut state =
      myoxus_application::workspace::tasks::workspace_tasks_initial_state(&catalog, workspace_id, Some(user_id))
        .expect("native Project source state");
    state.database.system_role = None;
    state.database.title = titles[index].clone();
    state.database.description = Some("Summary fixture".into());
    let id = state.database.id;
    child_counts.insert(id, (state.fields.len() as i64, state.views.len() as i64));
    repository
      .create_database(state)
      .await
      .expect("persist managed Project fixture");
    repository
      .create_row(
        id,
        Uuid::new_v4(),
        myoxus_domain::database::DatabaseRowKind::Task,
        "Summary row".into(),
        user_id,
        Vec::new(),
        DatabaseEditPrecondition::default()
          .in_workspace(workspace_id)
          .in_database(id),
      )
      .await
      .expect("native Project summary Row");
    database_ids[index] = id;
  }

  SummaryFixture {
    user_id,
    workspace_id,
    database_ids,
    child_counts,
  }
}

#[tokio::test]
async fn summary_inventory_is_set_based_complete_and_bounded() {
  install_query_counter();
  let pool = setup_pool().await;
  let fixture = seed_summary_fixture(&pool).await;
  let repository = PgDatabaseRepository::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  );
  let active_page = || PageRequest { limit: 100, offset: 0 };
  let title_ascending = DatabaseInventoryFilter {
    sort: DatabaseInventorySort::TitleAsc,
    ..DatabaseInventoryFilter::default()
  };

  repository
    .list_databases(fixture.workspace_id, active_page(), title_ascending.clone())
    .await
    .expect("warm summary query");

  SQLX_QUERY_COUNT.store(0, Ordering::Relaxed);
  COUNT_SQLX_QUERIES.store(true, Ordering::Relaxed);
  let counted_page = repository
    .list_databases(fixture.workspace_id, active_page(), title_ascending.clone())
    .await;
  COUNT_SQLX_QUERIES.store(false, Ordering::Relaxed);
  let statement_count = SQLX_QUERY_COUNT.load(Ordering::Relaxed);

  let mut timings = Vec::with_capacity(20);
  let mut measured_pages = Vec::with_capacity(20);
  for _ in 0..20 {
    let started = Instant::now();
    measured_pages.push(
      repository
        .list_databases(fixture.workspace_id, active_page(), title_ascending.clone())
        .await,
    );
    timings.push(started.elapsed());
  }
  let project_page = repository
    .list_databases(
      fixture.workspace_id,
      active_page(),
      DatabaseInventoryFilter {
        profile_kind: Some(DatabaseProfileKind::Project),
        sort: DatabaseInventorySort::TitleAsc,
        ..DatabaseInventoryFilter::default()
      },
    )
    .await;
  let search_page = repository
    .list_databases(
      fixture.workspace_id,
      active_page(),
      DatabaseInventoryFilter {
        search: Some("Database 09".to_string()),
        sort: DatabaseInventorySort::TitleAsc,
        ..DatabaseInventoryFilter::default()
      },
    )
    .await;
  let filtered_ids = repository
    .list_databases(
      fixture.workspace_id,
      active_page(),
      DatabaseInventoryFilter {
        database_ids: Some(vec![fixture.database_ids[3], fixture.database_ids[7]]),
        sort: DatabaseInventorySort::TitleAsc,
        ..DatabaseInventoryFilter::default()
      },
    )
    .await;
  let trashed_page = repository
    .list_databases(
      fixture.workspace_id,
      active_page(),
      DatabaseInventoryFilter {
        lifecycle: DatabaseLifecycleFilter::Trashed,
        ..DatabaseInventoryFilter::default()
      },
    )
    .await;
  let paged_descending = repository
    .list_databases(
      fixture.workspace_id,
      PageRequest { limit: 10, offset: 25 },
      DatabaseInventoryFilter {
        sort: DatabaseInventorySort::TitleDesc,
        ..DatabaseInventoryFilter::default()
      },
    )
    .await;
  CAPTURED_SQLX_FIELDS.lock().expect("reset SQL capture").clear();
  COUNT_SQLX_QUERIES.store(true, Ordering::Relaxed);
  let page_identities = repository
    .list_database_page_identities(
      fixture.workspace_id,
      PageRequest { limit: 100, offset: 0 },
      DatabaseLifecycleFilter::Active,
    )
    .await;
  COUNT_SQLX_QUERIES.store(false, Ordering::Relaxed);
  let page_identity_sql = CAPTURED_SQLX_FIELDS.lock().expect("read SQL capture").join("\n");
  let trailing_identities = repository
    .list_database_page_identities(
      fixture.workspace_id,
      PageRequest {
        limit: 100,
        offset: 100,
      },
      DatabaseLifecycleFilter::Active,
    )
    .await;
  let trashed_identities = repository
    .list_database_page_identities(
      fixture.workspace_id,
      PageRequest { limit: 100, offset: 0 },
      DatabaseLifecycleFilter::Trashed,
    )
    .await;

  let initial_revision = repository
    .database_page_inventory_revision(fixture.workspace_id)
    .await
    .expect("read initial Database inventory revision");
  let initial_snapshot = repository
    .list_database_page_identities_versioned(fixture.workspace_id, active_page(), DatabaseLifecycleFilter::Active)
    .await
    .expect("read revision-consistent Database inventory");
  assert_eq!(initial_snapshot.revision, initial_revision);
  assert_eq!(initial_snapshot.rows.len(), 100);

  repository
    .update_database(
      fixture.database_ids[0],
      Some("Database 000 renamed".into()),
      Some(Some("Changed projection".into())),
      fixture.user_id,
      DatabaseEditPrecondition::default().in_workspace(fixture.workspace_id),
    )
    .await
    .expect("mutate returned Database identity facts");
  let renamed_revision = repository
    .database_page_inventory_revision(fixture.workspace_id)
    .await
    .expect("read renamed inventory revision");
  assert!(renamed_revision > initial_revision);
  let renamed = repository
    .list_database_page_identities_versioned(fixture.workspace_id, active_page(), DatabaseLifecycleFilter::Active)
    .await
    .expect("read renamed revision-consistent inventory");
  assert_eq!(renamed.revision, renamed_revision);
  assert!(renamed.rows.iter().any(|row| row.title == "Database 000 renamed"));

  let rejected =
    sqlx::query("UPDATE database_profiles SET profile_kind='generic',structure_preset=NULL WHERE database_id=$1")
      .bind(fixture.database_ids[0])
      .execute(&pool)
      .await;
  assert!(
    rejected.is_err(),
    "managed profile is immutable even for identity-only consumers"
  );
  let profile_revision = repository
    .database_page_inventory_revision(fixture.workspace_id)
    .await
    .expect("protected profile inventory revision");
  assert_eq!(
    profile_revision, renamed_revision,
    "rejected profile change cannot invalidate inventory"
  );

  let stable_revision = profile_revision;
  let mut content_tx = pool.begin().await.unwrap();
  sqlx::query("SELECT set_config('myoxus.admitted_database_sources',$1,true)")
    .bind(
      serde_json::to_string(
        &myoxus_infrastructure::database_templates::load_database_template_catalog(
          &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
        )
        .expect("catalog")
        .admitted_sources(),
      )
      .unwrap(),
    )
    .execute(&mut *content_tx)
    .await
    .unwrap();
  sqlx::query("UPDATE workspace_database_rows SET title = 'Unprojected row title' WHERE database_id = $1")
    .bind(fixture.database_ids[0])
    .execute(&mut *content_tx)
    .await
    .expect("mutate unprojected row fact");
  content_tx.commit().await.unwrap();
  assert_eq!(
    repository
      .database_page_inventory_revision(fixture.workspace_id)
      .await
      .expect("read stable inventory revision"),
    stable_revision,
    "a row mutation that changes no returned Database identity fact is exempt"
  );

  repository
    .trash_database(
      fixture.database_ids[0],
      fixture.user_id,
      DatabaseEditPrecondition::default().in_workspace(fixture.workspace_id),
    )
    .await
    .expect("trash projected Database identity");
  let trashed_revision = repository
    .database_page_inventory_revision(fixture.workspace_id)
    .await
    .expect("read trashed inventory revision");
  assert!(trashed_revision > stable_revision);
  let active_after_trash = repository
    .list_database_page_identities_versioned(fixture.workspace_id, active_page(), DatabaseLifecycleFilter::Active)
    .await
    .expect("read active inventory after trash");
  assert_eq!(active_after_trash.revision, trashed_revision);
  assert!(
    !active_after_trash
      .rows
      .iter()
      .any(|row| row.id == fixture.database_ids[0])
  );

  cleanup_fixture(&pool, fixture.user_id, fixture.workspace_id).await;

  assert!(
    statement_count > 0,
    "the test-local SQLx counter must observe the query"
  );
  assert!(
    statement_count <= 2,
    "one summary page executed {statement_count} SQL statements"
  );
  let counted_page = counted_page.expect("read counted summary page");
  assert_eq!(counted_page.len(), 100);
  assert_eq!(
    counted_page.first().map(|item| item.title.as_str()),
    Some("Database 000")
  );
  assert_eq!(
    counted_page.last().map(|item| item.title.as_str()),
    Some("Database 099")
  );
  assert!(
    counted_page.iter().all(
      |item| item.row_count == 1 && fixture.child_counts.get(&item.id) == Some(&(item.field_count, item.view_count))
    ),
    "summary counts must come from the canonical child tables"
  );
  for page in measured_pages {
    assert_eq!(page.expect("read measured summary page").len(), 100);
  }
  timings.sort_unstable();
  let p95 = timings[18];
  eprintln!("DatabaseSummary 100-row timings: {timings:?}; p95={p95:?}");
  assert!(p95 <= Duration::from_millis(100), "100-row summary p95 was {p95:?}");
  assert_eq!(project_page.expect("read Project summaries").len(), 50);
  assert_eq!(search_page.expect("search summaries").len(), 10);
  assert_eq!(filtered_ids.expect("filter summary IDs").len(), 2);
  assert_eq!(
    trashed_page.expect("read trashed summaries")[0].id,
    fixture.database_ids[100]
  );
  assert_eq!(
    paged_descending.expect("read descending summary page")[0].title,
    "Database 074"
  );
  let page_identities = page_identities.expect("read count-free Database page identities");
  assert_eq!(page_identities.len(), 100);
  assert!(
    page_identity_sql.contains("workspace_databases"),
    "the causal SQL capture must contain the executed Database identity query: {page_identity_sql}"
  );
  for content_relation in [
    "workspace_database_rows",
    "workspace_database_fields",
    "workspace_database_views",
  ] {
    assert!(
      !page_identity_sql.contains(content_relation),
      "Database page identity SQL must not inspect {content_relation}: {page_identity_sql}"
    );
  }
  assert!(
    trailing_identities
      .expect("read trailing Database identity page")
      .is_empty()
  );
  let trashed_identities = trashed_identities.expect("read trashed Database page identities");
  assert_eq!(trashed_identities.len(), 1);
  assert_eq!(trashed_identities[0].id, fixture.database_ids[100]);
  assert_eq!(trashed_identities[0].title, "Database 100");
  assert!(trashed_identities[0].deleted_at.is_some());
}

struct SnapshotFixture {
  user_id: Uuid,
  workspace_id: Uuid,
  database_id: Uuid,
  row_id: Uuid,
  text_field_id: Uuid,
  rollup_field_id: Uuid,
  formula_field_id: Uuid,
}

async fn seed_snapshot_fixture(pool: &PgPool) -> SnapshotFixture {
  let mut tx = pool.begin().await.expect("begin snapshot fixture");
  let (user_id, workspace_id) = seed_owner_workspace(&mut tx, "snapshot").await;
  let database_id = Uuid::new_v4();
  let row_id = Uuid::new_v4();
  let text_field_id = Uuid::new_v4();
  let relation_field_id = Uuid::new_v4();
  let rollup_field_id = Uuid::new_v4();
  let formula_field_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO workspace_databases (id, workspace_id, title, created_by, updated_by)
     VALUES ($1, $2, 'Snapshot Database', $3, $3)",
  )
  .bind(database_id)
  .bind(workspace_id)
  .bind(user_id)
  .execute(&mut *tx)
  .await
  .expect("seed snapshot Database");
  sqlx::query(
    "INSERT INTO workspace_database_fields
       (id, database_id, name, field_type, config_json, position, required)
     VALUES
       ($1, $5, 'Text', 'text', '{\"kind\":\"text\",\"multiline\":false}'::jsonb, 0, false),
       ($2, $5, 'Relation', 'relation', jsonb_build_object(
          'kind', 'relation', 'targetDatabaseId', $5::text, 'allowMultiple', true,
          'reciprocalFieldId', NULL, 'maxTargets', NULL), 1, false),
       ($3, $5, 'Rollup', 'rollup', jsonb_build_object(
          'kind', 'rollup', 'sourceRelationFieldId', $2::text,
          'targetFieldId', $1::text, 'aggregate', 'sum', 'emptyValue', NULL,
          'stalePolicy', 'async'), 2, false),
       ($4, $5, 'Formula', 'formula', jsonb_build_object(
          'kind', 'formula', 'expression', '1', 'resultType', 'number',
          'dependencyFieldIds', '[]'::jsonb, 'stalePolicy', 'async', 'format', NULL), 3, false)",
  )
  .bind(text_field_id)
  .bind(relation_field_id)
  .bind(rollup_field_id)
  .bind(formula_field_id)
  .bind(database_id)
  .execute(&mut *tx)
  .await
  .expect("seed snapshot Fields");
  sqlx::query(
    "INSERT INTO workspace_database_rows
       (id, database_id, title, position, created_by, updated_by)
     VALUES ($1, $2, 'Snapshot Row', 0, $3, $3)",
  )
  .bind(row_id)
  .bind(database_id)
  .bind(user_id)
  .execute(&mut *tx)
  .await
  .expect("seed snapshot Row");
  sqlx::query(
    "INSERT INTO workspace_database_cell_values
       (row_id, field_id, database_id, value_json, edit_revision)
     VALUES ($1, $2, $3, '\"before\"'::jsonb, 7)",
  )
  .bind(row_id)
  .bind(text_field_id)
  .bind(database_id)
  .execute(&mut *tx)
  .await
  .expect("seed snapshot Cell");
  sqlx::query(
    "INSERT INTO workspace_database_rollup_values
       (database_id, row_id, field_id, value_json, stale_state)
     VALUES ($1, $2, $3, '{\"kind\":\"number\",\"value\":1}'::jsonb, 'current')",
  )
  .bind(database_id)
  .bind(row_id)
  .bind(rollup_field_id)
  .execute(&mut *tx)
  .await
  .expect("seed snapshot Rollup");
  sqlx::query(
    "INSERT INTO workspace_database_formula_values
       (database_id, row_id, field_id, value_json, stale_state)
     VALUES ($1, $2, $3, '{\"kind\":\"number\",\"value\":2}'::jsonb, 'current')",
  )
  .bind(database_id)
  .bind(row_id)
  .bind(formula_field_id)
  .execute(&mut *tx)
  .await
  .expect("seed snapshot Formula");
  tx.commit().await.expect("publish snapshot fixture");
  SnapshotFixture {
    user_id,
    workspace_id,
    database_id,
    row_id,
    text_field_id,
    rollup_field_id,
    formula_field_id,
  }
}

#[tokio::test]
async fn filtered_row_page_uses_one_snapshot_for_cells_revisions_and_derived_values() {
  let pool = setup_pool().await;
  let fixture = seed_snapshot_fixture(&pool).await;
  let mut writer = pool.begin().await.expect("begin concurrent snapshot writer");
  sqlx::query(
    "LOCK TABLE workspace_database_cell_values,
                workspace_database_rollup_values,
                workspace_database_formula_values
     IN ACCESS EXCLUSIVE MODE",
  )
  .execute(&mut *writer)
  .await
  .expect("lock response value tables");
  sqlx::query(
    "UPDATE workspace_database_cell_values
     SET value_json = '\"after\"'::jsonb, edit_revision = edit_revision + 1
     WHERE row_id = $1 AND field_id = $2",
  )
  .bind(fixture.row_id)
  .bind(fixture.text_field_id)
  .execute(&mut *writer)
  .await
  .expect("stage concurrent Cell update");
  sqlx::query(
    "UPDATE workspace_database_rollup_values
     SET value_json = '{\"kind\":\"number\",\"value\":11}'::jsonb
     WHERE row_id = $1 AND field_id = $2",
  )
  .bind(fixture.row_id)
  .bind(fixture.rollup_field_id)
  .execute(&mut *writer)
  .await
  .expect("stage concurrent Rollup update");
  sqlx::query(
    "UPDATE workspace_database_formula_values
     SET value_json = '{\"kind\":\"number\",\"value\":12}'::jsonb
     WHERE row_id = $1 AND field_id = $2",
  )
  .bind(fixture.row_id)
  .bind(fixture.formula_field_id)
  .execute(&mut *writer)
  .await
  .expect("stage concurrent Formula update");

  let repository = PgDatabaseRepository::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  );
  let database_id = fixture.database_id;
  let user_id = fixture.user_id;
  let read = tokio::spawn(async move {
    repository
      .list_rows_filtered_paged(
        database_id,
        user_id,
        DatabaseRowsQuery::default(),
        PageRequest { limit: 20, offset: 0 },
      )
      .await
  });
  let observed_block = tokio::time::timeout(Duration::from_secs(5), async {
    loop {
      let blocked: bool = sqlx::query_scalar(
        "SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE wait_event_type = 'Lock'
             AND query LIKE '%SELECT cv.row_id%'
             AND query LIKE '%workspace_database_cell_values%'
         )",
      )
      .fetch_one(&pool)
      .await
      .expect("inspect blocked snapshot read");
      if blocked {
        break true;
      }
      tokio::time::sleep(Duration::from_millis(10)).await;
    }
  })
  .await
  .unwrap_or(false);
  writer.commit().await.expect("publish concurrent response updates");
  let page_result = read.await.expect("join snapshot read");

  cleanup_fixture(&pool, fixture.user_id, fixture.workspace_id).await;

  assert!(
    observed_block,
    "the Cell read must block after the Row snapshot is established"
  );
  let page = page_result.expect("read snapshot-consistent Row page");
  let row = &page.rows[0];
  assert!(matches!(
    row.cells.iter().find(|cell| cell.field_id == fixture.text_field_id).map(|cell| &cell.value),
    Some(DatabaseCellValueData::Text(value)) if value == "before"
  ));
  assert_eq!(
    row
      .cell_revisions
      .iter()
      .find(|revision| revision.field_id == fixture.text_field_id)
      .map(|revision| revision.edit_revision),
    Some(7)
  );
  assert!(matches!(
    row.cells.iter().find(|cell| cell.field_id == fixture.rollup_field_id).map(|cell| &cell.value),
    Some(DatabaseCellValueData::Rollup(value))
      if matches!(value.value, Some(myoxus_domain::database::DatabaseRollupScalarValue::Number(number)) if number == 1.0)
  ));
  assert!(matches!(
    row.cells.iter().find(|cell| cell.field_id == fixture.formula_field_id).map(|cell| &cell.value),
    Some(DatabaseCellValueData::Formula(value))
      if matches!(value.value, Some(myoxus_domain::database::DatabaseFormulaScalarValue::Number(number)) if number == 2.0)
  ));
}

struct ReorderFixture {
  user_id: Uuid,
  workspace_id: Uuid,
  database_id: Uuid,
  field_ids: Vec<Uuid>,
  view_ids: Vec<Uuid>,
  row_ids: Vec<Uuid>,
}

async fn seed_reorder_fixture(pool: &PgPool) -> ReorderFixture {
  let mut tx = pool.begin().await.expect("begin reorder fixture");
  let (user_id, workspace_id) = seed_owner_workspace(&mut tx, "reorder").await;
  let database_id = Uuid::new_v4();
  let field_ids = (0..100).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
  let view_ids = (0..100).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
  let row_ids = (0..100).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
  sqlx::query(
    "INSERT INTO workspace_databases (id, workspace_id, title, created_by, updated_by)
     VALUES ($1, $2, 'Reorder Database', $3, $3)",
  )
  .bind(database_id)
  .bind(workspace_id)
  .bind(user_id)
  .execute(&mut *tx)
  .await
  .expect("seed reorder Database");
  sqlx::query(
    "INSERT INTO workspace_database_fields
       (id, database_id, name, field_type, config_json, position, required)
     SELECT item.id, $2, format('Field %s', item.ordinality), 'text',
            '{\"kind\":\"text\",\"multiline\":false}'::jsonb,
            item.ordinality::int - 1, false
     FROM unnest($1::uuid[]) WITH ORDINALITY AS item(id, ordinality)",
  )
  .bind(&field_ids)
  .bind(database_id)
  .execute(&mut *tx)
  .await
  .expect("seed reorder Fields");
  sqlx::query(
    "INSERT INTO workspace_database_views
       (id, database_id, name, view_kind, config_json, position)
     SELECT item.id, $2, format('View %s', item.ordinality), 'table',
            jsonb_build_object('kind', 'table', 'titleFieldId', $3::text),
            item.ordinality::int - 1
     FROM unnest($1::uuid[]) WITH ORDINALITY AS item(id, ordinality)",
  )
  .bind(&view_ids)
  .bind(database_id)
  .bind(field_ids[0])
  .execute(&mut *tx)
  .await
  .expect("seed reorder Views");
  sqlx::query(
    "INSERT INTO workspace_database_rows
       (id, database_id, title, position, created_by, updated_by)
     SELECT item.id, $2, format('Row %s', item.ordinality),
            item.ordinality::int - 1, $3, $3
     FROM unnest($1::uuid[]) WITH ORDINALITY AS item(id, ordinality)",
  )
  .bind(&row_ids)
  .bind(database_id)
  .bind(user_id)
  .execute(&mut *tx)
  .await
  .expect("seed reorder Rows");
  tx.commit().await.expect("publish reorder fixture");
  ReorderFixture {
    user_id,
    workspace_id,
    database_id,
    field_ids,
    view_ids,
    row_ids,
  }
}

async fn install_statement_counters(pool: &PgPool, suffix: &str) {
  let ddl = format!(
    "CREATE TABLE database_reorder_counter_{suffix} (
       table_name text PRIMARY KEY,
       statement_count integer NOT NULL DEFAULT 0
     );
     INSERT INTO database_reorder_counter_{suffix} (table_name) VALUES
       ('workspace_database_fields'),
       ('workspace_database_views'),
       ('workspace_database_rows');
     CREATE FUNCTION database_reorder_counter_fn_{suffix}() RETURNS trigger AS $$
     BEGIN
       UPDATE database_reorder_counter_{suffix}
       SET statement_count = statement_count + 1
       WHERE table_name = TG_TABLE_NAME;
       RETURN NULL;
     END;
     $$ LANGUAGE plpgsql;
     CREATE TRIGGER database_reorder_fields_{suffix}
       AFTER UPDATE ON workspace_database_fields FOR EACH STATEMENT
       EXECUTE FUNCTION database_reorder_counter_fn_{suffix}();
     CREATE TRIGGER database_reorder_views_{suffix}
       AFTER UPDATE ON workspace_database_views FOR EACH STATEMENT
       EXECUTE FUNCTION database_reorder_counter_fn_{suffix}();
     CREATE TRIGGER database_reorder_rows_{suffix}
       AFTER UPDATE ON workspace_database_rows FOR EACH STATEMENT
       EXECUTE FUNCTION database_reorder_counter_fn_{suffix}();"
  );
  sqlx::raw_sql(&ddl)
    .execute(pool)
    .await
    .expect("install test-local reorder statement counters");
}

async fn remove_statement_counters(pool: &PgPool, suffix: &str) {
  let ddl = format!(
    "DROP TRIGGER database_reorder_fields_{suffix} ON workspace_database_fields;
     DROP TRIGGER database_reorder_views_{suffix} ON workspace_database_views;
     DROP TRIGGER database_reorder_rows_{suffix} ON workspace_database_rows;
     DROP FUNCTION database_reorder_counter_fn_{suffix}();
     DROP TABLE database_reorder_counter_{suffix};"
  );
  sqlx::raw_sql(&ddl)
    .execute(pool)
    .await
    .expect("remove test-local reorder statement counters");
}

#[tokio::test]
async fn hundred_item_reorders_use_one_write_statement_and_preserve_conflicts() {
  let pool = setup_pool().await;
  let fixture = seed_reorder_fixture(&pool).await;
  let suffix = Uuid::new_v4().simple().to_string();
  install_statement_counters(&pool, &suffix).await;
  let repository = PgDatabaseRepository::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  );
  let precondition = DatabaseEditPrecondition::new(None, false).in_workspace(fixture.workspace_id);
  let field_revisions =
    sqlx::query_as::<_, (Uuid, i64)>("SELECT id, edit_revision FROM workspace_database_fields WHERE database_id = $1")
      .bind(fixture.database_id)
      .fetch_all(&pool)
      .await
      .expect("read initial Field revisions")
      .into_iter()
      .collect::<HashMap<_, _>>();
  let view_revisions =
    sqlx::query_as::<_, (Uuid, i64)>("SELECT id, edit_revision FROM workspace_database_views WHERE database_id = $1")
      .bind(fixture.database_id)
      .fetch_all(&pool)
      .await
      .expect("read initial View revisions")
      .into_iter()
      .collect::<HashMap<_, _>>();
  let mut reversed_fields = fixture.field_ids.clone();
  reversed_fields.reverse();
  let mut reversed_views = fixture.view_ids.clone();
  reversed_views.reverse();

  let reordered_fields = repository
    .reorder_fields(
      fixture.database_id,
      reversed_fields.clone(),
      &field_revisions,
      false,
      precondition,
    )
    .await;
  let field_conflict = repository
    .reorder_fields(
      fixture.database_id,
      reversed_fields.clone(),
      &field_revisions,
      false,
      precondition,
    )
    .await;
  let reordered_views = repository
    .reorder_views(
      fixture.database_id,
      reversed_views.clone(),
      &view_revisions,
      false,
      precondition,
    )
    .await;
  let view_conflict = repository
    .reorder_views(
      fixture.database_id,
      reversed_views.clone(),
      &view_revisions,
      false,
      precondition,
    )
    .await;
  let moved_row_id = fixture.row_ids[99];
  let initial_row_revision =
    sqlx::query_scalar::<_, i64>("SELECT edit_revision FROM workspace_database_rows WHERE id = $1")
      .bind(moved_row_id)
      .fetch_one(&pool)
      .await
      .expect("read initial Row revision");
  let moved_row = repository
    .update_row_position(
      fixture.database_id,
      moved_row_id,
      0,
      fixture.user_id,
      DatabaseEditPrecondition::new(Some(initial_row_revision), false).in_workspace(fixture.workspace_id),
    )
    .await;
  let row_conflict = repository
    .update_row_position(
      fixture.database_id,
      moved_row_id,
      50,
      fixture.user_id,
      DatabaseEditPrecondition::new(Some(initial_row_revision), false).in_workspace(fixture.workspace_id),
    )
    .await;
  let stored_row_ids = sqlx::query_scalar::<_, Uuid>(
    "SELECT id FROM workspace_database_rows WHERE database_id = $1 ORDER BY position, id",
  )
  .bind(fixture.database_id)
  .fetch_all(&pool)
  .await;
  let statement_counts = sqlx::query_as::<_, (String, i32)>(&format!(
    "SELECT table_name, statement_count FROM database_reorder_counter_{suffix} ORDER BY table_name"
  ))
  .fetch_all(&pool)
  .await;

  remove_statement_counters(&pool, &suffix).await;
  cleanup_fixture(&pool, fixture.user_id, fixture.workspace_id).await;

  assert_eq!(
    reordered_fields
      .expect("reorder 100 Fields")
      .into_iter()
      .map(|field| field.id)
      .collect::<Vec<_>>(),
    reversed_fields
  );
  assert!(matches!(field_conflict, Err(RepositoryError::Conflict(_))));
  assert_eq!(
    reordered_views
      .expect("reorder 100 Views")
      .into_iter()
      .map(|view| view.id)
      .collect::<Vec<_>>(),
    reversed_views
  );
  assert!(matches!(view_conflict, Err(RepositoryError::Conflict(_))));
  assert_eq!(moved_row.expect("move one of 100 Rows").row.position, 0);
  assert!(matches!(row_conflict, Err(RepositoryError::Conflict(_))));
  let stored_row_ids = stored_row_ids.expect("read reordered Rows");
  assert_eq!(stored_row_ids[0], moved_row_id);
  assert_eq!(stored_row_ids.len(), 100);
  assert_eq!(
    statement_counts.expect("read reorder statement counts"),
    vec![
      ("workspace_database_fields".to_string(), 1),
      ("workspace_database_rows".to_string(), 1),
      ("workspace_database_views".to_string(), 1),
    ]
  );
}
