//! PostgreSQL invariants for personal Database Row reminders.

use chrono::{Duration, Utc};
use myoxus_domain::database::DatabaseReminderRepository;
use myoxus_domain::database::{
  DatabaseDateTimeFieldConfig, DatabaseEditPrecondition, DatabaseFieldConfig, DatabaseRowReminder,
  DatabaseRowReminderStatus,
};
use myoxus_domain::database::{DatabaseDefinitionRepository, DatabaseEditingRepository};

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
    .expect("database reminder migration must apply");
  pool
}

fn reminder(
  workspace_id: Uuid,
  database_id: Uuid,
  row_id: Uuid,
  field_id: Uuid,
  user_id: Uuid,
  offset_minutes: i64,
  trigger_at: chrono::DateTime<Utc>,
) -> DatabaseRowReminder {
  let now = Utc::now();
  DatabaseRowReminder {
    id: Uuid::new_v4(),
    workspace_id,
    database_id,
    row_id,
    field_id,
    user_id,
    offset_minutes,
    trigger_at,
    status: DatabaseRowReminderStatus::Scheduled,
    schedule_revision: 1,
    claim_token: None,
    claim_expires_at: None,
    claim_attempts: 0,
    fired_at: None,
    cancelled_at: None,
    created_at: now,
    updated_at: now,
  }
}

fn date_time_field_config() -> serde_json::Value {
  serde_json::to_value(DatabaseFieldConfig::DateTime(DatabaseDateTimeFieldConfig {
    default_time_zone: Some("UTC".to_string()),
    allow_reminders: true,
  }))
  .expect("serialize canonical DateTime field config")
}

#[tokio::test]
async fn personal_reminders_are_idempotent_private_and_claimed_once() {
  let pool = setup_pool().await;
  let repo = PgDatabaseRepository::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  );
  let owner_id = Uuid::new_v4();
  let second_user_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let database_id = Uuid::new_v4();
  let row_id = Uuid::new_v4();
  let field_id = Uuid::new_v4();
  let text_field_id = Uuid::new_v4();

  for (user_id, label) in [(owner_id, "owner"), (second_user_id, "second")] {
    sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
      .bind(user_id)
      .bind(format!("database-reminder-{label}-{user_id}@example.test"))
      .bind(format!("Reminder {label}"))
      .execute(&pool)
      .await
      .expect("seed reminder user");
  }
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'Reminder test')")
    .bind(workspace_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("seed workspace");
  for user_id in [owner_id, second_user_id] {
    sqlx::query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, 'Collaborator', 'Accepted', now())",
    )
    .bind(workspace_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("seed membership");
  }
  sqlx::query(
    "INSERT INTO workspace_databases (id, workspace_id, title, created_by, updated_by) VALUES ($1, $2, 'Reminder DB', $3, $3)",
  )
  .bind(database_id)
  .bind(workspace_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("seed database");
  sqlx::query(
    r#"
      INSERT INTO workspace_database_fields
        (id, database_id, name, field_type, config_json, position, required)
      VALUES ($1, $2, 'Starts', 'date_time', $3, 0, false)
    "#,
  )
  .bind(field_id)
  .bind(database_id)
  .bind(date_time_field_config())
  .execute(&pool)
  .await
  .expect("seed DateTime field");
  sqlx::query(
    "INSERT INTO workspace_database_rows (id, database_id, title, position, created_by, updated_by) VALUES ($1, $2, 'Due row', 0, $3, $3)",
  )
  .bind(row_id)
  .bind(database_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("seed row");
  sqlx::query(
    r#"
      INSERT INTO workspace_database_cell_values
        (row_id, field_id, database_id, value_json, updated_by)
      VALUES ($1, $2, $3,
              '{"start":"2026-07-11T08:00:00Z","end":null,"allDay":false,"timeZone":"UTC"}', $4)
    "#,
  )
  .bind(row_id)
  .bind(field_id)
  .bind(database_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("seed DateTime Cell");

  sqlx::query(
    "INSERT INTO workspace_database_fields (id,database_id,name,field_type,config_json,position,required)
     VALUES ($1,$2,'Text','text','{}'::jsonb,1,false)",
  )
  .bind(text_field_id)
  .bind(database_id)
  .execute(&pool)
  .await
  .expect("seed actual non-DateTime field");

  let first = repo
    .upsert_database_row_reminder(reminder(
      workspace_id,
      database_id,
      row_id,
      field_id,
      owner_id,
      10,
      Utc::now() - Duration::minutes(2),
    ))
    .await
    .expect("create owner's reminder");
  let updated = repo
    .upsert_database_row_reminder(reminder(
      workspace_id,
      database_id,
      row_id,
      field_id,
      owner_id,
      10,
      Utc::now() - Duration::minutes(1),
    ))
    .await
    .expect("same owner/offset must reschedule idempotently");
  assert_eq!(updated.id, first.id);
  assert_eq!(updated.schedule_revision, first.schedule_revision + 1);

  repo
    .upsert_database_row_reminder(reminder(
      workspace_id,
      database_id,
      row_id,
      field_id,
      second_user_id,
      30,
      Utc::now() - Duration::minutes(1),
    ))
    .await
    .expect("second user owns an independent reminder");
  let owner_visible = repo
    .list_database_row_reminders(database_id, row_id, field_id, owner_id)
    .await
    .expect("list owner's reminders");
  assert_eq!(owner_visible.len(), 1);
  assert!(owner_visible.iter().all(|value| value.user_id == owner_id));
  assert!(
    !repo
      .cancel_database_row_reminder(database_id, first.id, second_user_id, Utc::now())
      .await
      .expect("cross-user cancel query must be safe")
  );

  let wrong_workspace_id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'Wrong reminder workspace')")
    .bind(wrong_workspace_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("seed wrong reminder workspace");
  assert!(
    repo
      .upsert_database_row_reminder(reminder(
        wrong_workspace_id,
        database_id,
        row_id,
        field_id,
        owner_id,
        40,
        Utc::now() + Duration::hours(1),
      ))
      .await
      .is_err(),
    "an existing workspace that does not own the Database must be rejected"
  );
  assert!(
    repo
      .upsert_database_row_reminder(reminder(
        workspace_id,
        database_id,
        row_id,
        text_field_id,
        owner_id,
        40,
        Utc::now() + Duration::hours(1),
      ))
      .await
      .is_err(),
    "a same-Database non-DateTime field must be rejected"
  );

  let cascade_field_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO workspace_database_fields (id, database_id, name, field_type, config_json, position, required) VALUES ($1, $2, 'Cascade date', 'date_time', $3, 2, false)",
  )
  .bind(cascade_field_id)
  .bind(database_id)
  .bind(date_time_field_config())
  .execute(&pool)
  .await
  .expect("seed cascade DateTime field");
  let field_cascade_reminder = repo
    .upsert_database_row_reminder(reminder(
      workspace_id,
      database_id,
      row_id,
      cascade_field_id,
      owner_id,
      45,
      Utc::now() + Duration::hours(1),
    ))
    .await
    .expect("seed field cascade reminder");
  repo
    .delete_field(cascade_field_id, DatabaseEditPrecondition::new(None, false))
    .await
    .expect("delete reminder field");
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM database_row_reminders WHERE id = $1")
      .bind(field_cascade_reminder.id)
      .fetch_one(&pool)
      .await
      .expect("field cascade reminder count"),
    0,
    "hard field deletion must cascade the personal Reminder"
  );

  let cascade_database_id = Uuid::new_v4();
  let cascade_row_id = Uuid::new_v4();
  let cascade_database_field_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO workspace_databases (id, workspace_id, title, created_by, updated_by) VALUES ($1, $2, 'Cascade reminder DB', $3, $3)",
  )
  .bind(cascade_database_id)
  .bind(workspace_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("seed cascade Database");
  sqlx::query(
    "INSERT INTO workspace_database_fields (id, database_id, name, field_type, config_json, position, required) VALUES ($1, $2, 'Due', 'date_time', $3, 0, false)",
  )
  .bind(cascade_database_field_id)
  .bind(cascade_database_id)
  .bind(date_time_field_config())
  .execute(&pool)
  .await
  .expect("seed cascade Database field");
  sqlx::query(
    "INSERT INTO workspace_database_rows (id, database_id, title, position, created_by, updated_by) VALUES ($1, $2, 'Cascade row', 0, $3, $3)",
  )
  .bind(cascade_row_id)
  .bind(cascade_database_id)
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("seed cascade Database row");
  let database_cascade_reminder = repo
    .upsert_database_row_reminder(reminder(
      workspace_id,
      cascade_database_id,
      cascade_row_id,
      cascade_database_field_id,
      owner_id,
      60,
      Utc::now() + Duration::hours(1),
    ))
    .await
    .expect("seed Database cascade reminder");
  let trashed_cascade_database = repo
    .trash_database(
      cascade_database_id,
      owner_id,
      DatabaseEditPrecondition::new(None, false),
    )
    .await
    .expect("move reminder Database to trash");
  repo
    .purge_database(
      cascade_database_id,
      DatabaseEditPrecondition::new(Some(trashed_cascade_database.database.edit_revision), false),
    )
    .await
    .expect("delete reminder Database");
  assert_eq!(
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM database_row_reminders WHERE id = $1")
      .bind(database_cascade_reminder.id)
      .fetch_one(&pool)
      .await
      .expect("Database cascade reminder count"),
    0,
    "hard Database deletion must cascade the personal Reminder"
  );

  let first_claimer = PgDatabaseRepository::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  );
  let second_claimer = PgDatabaseRepository::new(
    pool.clone(),
    std::sync::Arc::new(
      myoxus_infrastructure::database_templates::load_database_template_catalog(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
      )
      .expect("database catalog fixture"),
    ),
  );
  let now = Utc::now();
  let (left, right) = tokio::join!(
    first_claimer.claim_due_database_row_reminders(now, now + Duration::minutes(5), 10),
    second_claimer.claim_due_database_row_reminders(now, now + Duration::minutes(5), 10),
  );
  let left = left.expect("first claimer");
  let right = right.expect("second claimer");
  let mut claimed_ids = left.iter().chain(&right).map(|value| value.id).collect::<Vec<_>>();
  claimed_ids.sort_unstable();
  claimed_ids.dedup();
  assert_eq!(claimed_ids.len(), 2, "both due reminders are claimed exactly once");
  assert_eq!(left.len() + right.len(), 2);

  sqlx::query("UPDATE database_row_reminders SET claim_expires_at = $2 WHERE row_id = $1 AND status = 'claimed'")
    .bind(row_id)
    .bind(now - Duration::seconds(1))
    .execute(&pool)
    .await
    .expect("expire claimed reminders");
  assert_eq!(
    repo
      .release_expired_database_row_reminder_claims(now)
      .await
      .expect("release expired claims"),
    2
  );
  assert_eq!(
    repo
      .claim_due_database_row_reminders(now, now + Duration::minutes(5), 10)
      .await
      .expect("reclaim expired reminders")
      .len(),
    2,
    "expired claims must become retryable"
  );

  let wrong_database = Uuid::new_v4();
  let invalid = repo
    .upsert_database_row_reminder(reminder(
      workspace_id,
      wrong_database,
      row_id,
      field_id,
      owner_id,
      60,
      Utc::now() + Duration::hours(1),
    ))
    .await;
  assert!(invalid.is_err(), "cross-Database hierarchy must be rejected");

  repo
    .delete_row(row_id, DatabaseEditPrecondition::new(None, false))
    .await
    .expect("soft-delete reminder target Row");
  let live_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM database_row_reminders WHERE row_id = $1 AND status IN ('scheduled', 'claimed')",
  )
  .bind(row_id)
  .fetch_one(&pool)
  .await
  .expect("live reminder count after Row delete");
  let cancelled_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM database_row_reminders WHERE row_id = $1 AND status = 'cancelled'")
      .bind(row_id)
      .fetch_one(&pool)
      .await
      .expect("cancelled reminder count after Row delete");
  assert_eq!(live_count, 0);
  assert_eq!(cancelled_count, 2, "Row deletion cancels every user's live reminder");

  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("cleanup workspace");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(wrong_workspace_id)
    .execute(&pool)
    .await
    .expect("cleanup wrong reminder workspace");
  sqlx::query("DELETE FROM users WHERE id = ANY($1)")
    .bind([owner_id, second_user_id])
    .execute(&pool)
    .await
    .expect("cleanup users");
}

#[path = "database_row_reminders/managed_tasks.rs"]
mod managed_tasks;
