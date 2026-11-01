// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL ownership invariants for Database Cells and Relation Edges.
//!
//! These tests deliberately write below the repository layer. Their purpose is
//! to prove that imports, maintenance SQL, or future writers cannot persist a
//! child whose denormalized Database identifier disagrees with its parents.

use std::collections::HashMap;

use myoxus_domain::database::DatabaseEditingRepository;
use myoxus_domain::database::{DatabaseCellValueData, DatabaseEditPrecondition};
use myoxus_domain::repositories::RepositoryError;
use myoxus_infrastructure::workspace_database::PgDatabaseRepository;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

const CELL_ROW_CONSTRAINT: &str = "fk_workspace_database_cells_row_database";
const CELL_FIELD_CONSTRAINT: &str = "fk_workspace_database_cells_field_database";
const RELATION_SOURCE_ROW_CONSTRAINT: &str = "fk_workspace_database_relations_source_row_database";
const RELATION_SOURCE_FIELD_CONSTRAINT: &str = "fk_workspace_database_relations_source_field_database";
const RELATION_TARGET_ROW_CONSTRAINT: &str = "fk_workspace_database_relations_target_row_database";

#[derive(Clone, Copy)]
struct Fixture {
  user_id: Uuid,
  workspace_id: Uuid,
  database_a: Uuid,
  database_b: Uuid,
  row_a: Uuid,
  row_b: Uuid,
  field_a: Uuid,
  field_b: Uuid,
  text_field_a: Uuid,
}

async fn setup_pool() -> PgPool {
  let url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  let pool = PgPoolOptions::new()
    .max_connections(2)
    .acquire_timeout(std::time::Duration::from_secs(30))
    .connect(&url)
    .await
    .expect("isolated test database must be reachable");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("Database membership migration must apply");
  pool
}

async fn seed_fixture(tx: &mut Transaction<'_, Postgres>) -> Fixture {
  let user_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let fixture = Fixture {
    user_id,
    workspace_id,
    database_a: Uuid::new_v4(),
    database_b: Uuid::new_v4(),
    row_a: Uuid::new_v4(),
    row_b: Uuid::new_v4(),
    field_a: Uuid::new_v4(),
    field_b: Uuid::new_v4(),
    text_field_a: Uuid::new_v4(),
  };

  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, 'Membership owner', 'active')")
    .bind(user_id)
    .bind(format!("database-membership-{user_id}@example.test"))
    .execute(&mut **tx)
    .await
    .expect("seed owner");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'Membership workspace')")
    .bind(workspace_id)
    .bind(user_id)
    .execute(&mut **tx)
    .await
    .expect("seed workspace");
  sqlx::query(
    "INSERT INTO workspace_databases (id, workspace_id, title, created_by, updated_by)
     VALUES ($1, $3, 'Database A', $4, $4), ($2, $3, 'Database B', $4, $4)",
  )
  .bind(fixture.database_a)
  .bind(fixture.database_b)
  .bind(workspace_id)
  .bind(user_id)
  .execute(&mut **tx)
  .await
  .expect("seed Databases");
  sqlx::query(
    "INSERT INTO workspace_database_fields
       (id, database_id, name, field_type, config_json, position, required)
     VALUES
       ($1, $3, 'Relation A', 'relation', '{}'::jsonb, 0, false),
       ($2, $4, 'Relation B', 'relation', '{}'::jsonb, 0, false),
       ($5, $3, 'Text A', 'text', '{}'::jsonb, 1, false)",
  )
  .bind(fixture.field_a)
  .bind(fixture.field_b)
  .bind(fixture.database_a)
  .bind(fixture.database_b)
  .bind(fixture.text_field_a)
  .execute(&mut **tx)
  .await
  .expect("seed Fields");
  sqlx::query(
    "INSERT INTO workspace_database_rows
       (id, database_id, title, position, created_by, updated_by)
     VALUES
       ($1, $3, 'Row A', 0, $5, $5),
       ($2, $4, 'Row B', 0, $5, $5)",
  )
  .bind(fixture.row_a)
  .bind(fixture.row_b)
  .bind(fixture.database_a)
  .bind(fixture.database_b)
  .bind(user_id)
  .execute(&mut **tx)
  .await
  .expect("seed Rows");

  fixture
}

fn assert_constraint(error: sqlx::Error, expected: &str) {
  let sqlx::Error::Database(database_error) = error else {
    panic!("expected PostgreSQL constraint error, got {error}");
  };
  assert_eq!(database_error.constraint(), Some(expected));
}

async fn begin_fixture(pool: &PgPool) -> (Transaction<'_, Postgres>, Fixture) {
  let mut tx = pool.begin().await.expect("begin membership fixture");
  let fixture = seed_fixture(&mut tx).await;
  (tx, fixture)
}

#[tokio::test]
async fn cell_row_database_mismatch_is_rejected() {
  let pool = setup_pool().await;
  let (mut tx, fixture) = begin_fixture(&pool).await;

  let error = sqlx::query(
    "INSERT INTO workspace_database_cell_values (row_id, field_id, database_id, value_json)
     VALUES ($1, $2, $3, '{}'::jsonb)",
  )
  .bind(fixture.row_a)
  .bind(fixture.field_b)
  .bind(fixture.database_b)
  .execute(&mut *tx)
  .await
  .expect_err("a Cell cannot borrow the Field Database when its Row belongs elsewhere");

  assert_constraint(error, CELL_ROW_CONSTRAINT);
  tx.rollback().await.expect("rollback rejected Cell");
}

#[tokio::test]
async fn cell_field_database_mismatch_is_rejected() {
  let pool = setup_pool().await;
  let (mut tx, fixture) = begin_fixture(&pool).await;

  let error = sqlx::query(
    "INSERT INTO workspace_database_cell_values (row_id, field_id, database_id, value_json)
     VALUES ($1, $2, $3, '{}'::jsonb)",
  )
  .bind(fixture.row_a)
  .bind(fixture.field_b)
  .bind(fixture.database_a)
  .execute(&mut *tx)
  .await
  .expect_err("a Cell cannot borrow the Row Database when its Field belongs elsewhere");

  assert_constraint(error, CELL_FIELD_CONSTRAINT);
  tx.rollback().await.expect("rollback rejected Cell");
}

#[tokio::test]
async fn relation_source_row_database_mismatch_is_rejected() {
  let pool = setup_pool().await;
  let (mut tx, fixture) = begin_fixture(&pool).await;

  let error = insert_relation(
    &mut tx,
    fixture.database_b,
    fixture.row_a,
    fixture.field_b,
    fixture.database_b,
    fixture.row_b,
  )
  .await
  .expect_err("a Relation source Database must own its Row");

  assert_constraint(error, RELATION_SOURCE_ROW_CONSTRAINT);
  tx.rollback().await.expect("rollback rejected Relation");
}

#[tokio::test]
async fn relation_source_field_database_mismatch_is_rejected() {
  let pool = setup_pool().await;
  let (mut tx, fixture) = begin_fixture(&pool).await;

  let error = insert_relation(
    &mut tx,
    fixture.database_a,
    fixture.row_a,
    fixture.field_b,
    fixture.database_b,
    fixture.row_b,
  )
  .await
  .expect_err("a Relation source Database must own its Field");

  assert_constraint(error, RELATION_SOURCE_FIELD_CONSTRAINT);
  tx.rollback().await.expect("rollback rejected Relation");
}

#[tokio::test]
async fn relation_target_row_database_mismatch_is_rejected() {
  let pool = setup_pool().await;
  let (mut tx, fixture) = begin_fixture(&pool).await;

  let error = insert_relation(
    &mut tx,
    fixture.database_a,
    fixture.row_a,
    fixture.field_a,
    fixture.database_a,
    fixture.row_b,
  )
  .await
  .expect_err("a Relation target Database must own its Row");

  assert_constraint(error, RELATION_TARGET_ROW_CONSTRAINT);
  tx.rollback().await.expect("rollback rejected Relation");
}

async fn insert_relation(
  tx: &mut Transaction<'_, Postgres>,
  source_database_id: Uuid,
  source_row_id: Uuid,
  source_field_id: Uuid,
  target_database_id: Uuid,
  target_row_id: Uuid,
) -> Result<(), sqlx::Error> {
  sqlx::query(
    "INSERT INTO workspace_database_relation_edges
       (source_database_id, source_row_id, source_field_id, target_database_id, target_row_id, position)
     VALUES ($1, $2, $3, $4, $5, 0)",
  )
  .bind(source_database_id)
  .bind(source_row_id)
  .bind(source_field_id)
  .bind(target_database_id)
  .bind(target_row_id)
  .execute(&mut **tx)
  .await
  .map(|_| ())
}

#[tokio::test]
async fn valid_cell_and_relation_lifecycle_preserves_existing_cascades() {
  let pool = setup_pool().await;
  let (mut tx, fixture) = begin_fixture(&pool).await;

  sqlx::query(
    "INSERT INTO workspace_database_cell_values (row_id, field_id, database_id, value_json)
     VALUES ($1, $2, $3, '[1]'::jsonb)",
  )
  .bind(fixture.row_a)
  .bind(fixture.field_a)
  .bind(fixture.database_a)
  .execute(&mut *tx)
  .await
  .expect("valid Cell write");
  insert_relation(
    &mut tx,
    fixture.database_a,
    fixture.row_a,
    fixture.field_a,
    fixture.database_b,
    fixture.row_b,
  )
  .await
  .expect("valid Relation write");

  sqlx::query(
    "UPDATE workspace_database_cell_values SET value_json = '[2]'::jsonb WHERE row_id = $1 AND field_id = $2",
  )
  .bind(fixture.row_a)
  .bind(fixture.field_a)
  .execute(&mut *tx)
  .await
  .expect("valid Cell update");
  sqlx::query(
    "UPDATE workspace_database_relation_edges SET position = 1
     WHERE source_row_id = $1 AND source_field_id = $2 AND target_row_id = $3",
  )
  .bind(fixture.row_a)
  .bind(fixture.field_a)
  .bind(fixture.row_b)
  .execute(&mut *tx)
  .await
  .expect("valid Relation update");

  sqlx::query("DELETE FROM workspace_database_rows WHERE id = $1")
    .bind(fixture.row_a)
    .execute(&mut *tx)
    .await
    .expect("delete source Row");
  let remaining_children: i64 = sqlx::query_scalar(
    "SELECT
       (SELECT count(*) FROM workspace_database_cell_values WHERE row_id = $1)
       + (SELECT count(*) FROM workspace_database_relation_edges WHERE source_row_id = $1)",
  )
  .bind(fixture.row_a)
  .fetch_one(&mut *tx)
  .await
  .expect("count cascaded children");
  assert_eq!(
    remaining_children, 0,
    "source Row deletion must retain cascade semantics"
  );

  tx.rollback().await.expect("rollback valid lifecycle fixture");
}

#[tokio::test]
async fn bulk_cell_writers_do_not_cross_the_first_rows_database() {
  let pool = setup_pool().await;
  let (tx, fixture) = begin_fixture(&pool).await;
  tx.commit().await.expect("publish repository fixture");
  let repository = PgDatabaseRepository::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  );

  let set_result = repository
    .bulk_set_cell_value(
      &[fixture.row_a, fixture.row_b],
      fixture.text_field_a,
      DatabaseCellValueData::Text("bounded".to_string()),
      fixture.user_id,
      &HashMap::new(),
      true,
      Vec::new(),
      DatabaseEditPrecondition::new(None, false),
    )
    .await;

  let clear_result = repository
    .bulk_clear_cell_value(
      &[fixture.row_a, fixture.row_b],
      fixture.text_field_a,
      fixture.user_id,
      &HashMap::new(),
      true,
      DatabaseEditPrecondition::new(None, false),
    )
    .await;

  let foreign_cell_count: Result<i64, sqlx::Error> =
    sqlx::query_scalar("SELECT count(*) FROM workspace_database_cell_values WHERE row_id = $1 AND field_id = $2")
      .bind(fixture.row_b)
      .bind(fixture.text_field_a)
      .fetch_one(&pool)
      .await;

  // Clean before evaluating product assertions so a regression cannot leave
  // committed fixtures in the shared isolated test database.
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(fixture.workspace_id)
    .execute(&pool)
    .await
    .expect("clean repository workspace fixture");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(fixture.user_id)
    .execute(&pool)
    .await
    .expect("clean repository fixture");

  let set_results = set_result.expect("bulk set must retain per-Row diagnostics");
  assert!(set_results[0].is_ok());
  assert!(matches!(
    &set_results[1],
    Err(RepositoryError::NotFound("database row"))
  ));
  let clear_results = clear_result.expect("bulk clear must retain per-Row diagnostics");
  assert!(clear_results[0].is_ok());
  assert!(matches!(
    &clear_results[1],
    Err(RepositoryError::NotFound("database row"))
  ));
  assert_eq!(
    foreign_cell_count.expect("count cross-Database Cells"),
    0,
    "bulk writers must not touch a foreign Row"
  );
}

#[tokio::test]
async fn membership_constraints_are_composite_and_validated() {
  let pool = setup_pool().await;
  let rows: Vec<(String, bool, bool, bool, String)> = sqlx::query_as(
    "SELECT conname, convalidated, condeferrable, condeferred, pg_get_constraintdef(oid)
     FROM pg_constraint
     WHERE conname = ANY($1)
       AND conrelid IN (
         'workspace_database_cell_values'::regclass,
         'workspace_database_relation_edges'::regclass,
         'database_row_reminders'::regclass
       )
     ORDER BY conname",
  )
  .bind(
    &[
      CELL_ROW_CONSTRAINT,
      CELL_FIELD_CONSTRAINT,
      RELATION_SOURCE_ROW_CONSTRAINT,
      RELATION_SOURCE_FIELD_CONSTRAINT,
      RELATION_TARGET_ROW_CONSTRAINT,
      "fk_database_row_reminders_field_database",
      "fk_database_row_reminders_row_database",
    ][..],
  )
  .fetch_all(&pool)
  .await
  .expect("read Database membership constraints");

  assert_eq!(rows.len(), 7, "all seven movable membership constraints must exist");
  for (name, validated, deferrable, initially_deferred, definition) in rows {
    assert!(deferrable, "{name} must support the atomic native Task move");
    assert!(
      !initially_deferred,
      "{name} must retain immediate enforcement for ordinary writers"
    );
    assert!(validated, "{name} must not remain NOT VALID");
    let expected_columns = match name.as_str() {
      CELL_ROW_CONSTRAINT => "FOREIGN KEY (row_id, database_id)",
      CELL_FIELD_CONSTRAINT => "FOREIGN KEY (field_id, database_id)",
      RELATION_SOURCE_ROW_CONSTRAINT => "FOREIGN KEY (source_row_id, source_database_id)",
      RELATION_SOURCE_FIELD_CONSTRAINT => "FOREIGN KEY (source_field_id, source_database_id)",
      RELATION_TARGET_ROW_CONSTRAINT => "FOREIGN KEY (target_row_id, target_database_id)",
      "fk_database_row_reminders_field_database" => "FOREIGN KEY (field_id, database_id)",
      "fk_database_row_reminders_row_database" => "FOREIGN KEY (row_id, database_id)",
      _ => panic!("unexpected Database membership constraint {name}"),
    };
    assert!(definition.starts_with(expected_columns), "{name}: {definition}");
    assert!(
      definition.ends_with("ON DELETE CASCADE DEFERRABLE"),
      "{name}: {definition}"
    );
  }
}
