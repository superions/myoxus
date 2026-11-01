//! Transactional outbox and native Task notification delivery integration tests.
//!
//! Raw SQL fixtures independently verify pending/acknowledged repository reads.
//! The Task fixture exercises the real SQL producer, Redis handoff/retry,
//! notification dispatcher, current authorization and optional mail delivery.
//! `process_outbox_batch` itself is private to the server binary; these tests
//! use its actual repository, enqueue and dispatch owners without a background
//! processor. Owned IDs/prefixes isolate all durable fixtures.
//!
//! Requirements: PostgreSQL at TEST_DATABASE_URL and Redis at TEST_REDIS_URL.

use crate::helpers;

use chrono::Utc;
use futures_util::FutureExt;
use myoxus_domain::repositories::OutboxRepository;
use myoxus_infrastructure::outbox::SqlxOutboxRepository;
use sqlx::Row;
use uuid::Uuid;

// Only owned fixtures move ahead of existing backlog; ordinary concurrent
// writes cannot crowd these assertions out of the unchanged bounded poll.
async fn position_owned_events_first(pool: &sqlx::PgPool, ids: &[Uuid]) {
  sqlx::query(
    "UPDATE outbox_events SET created_at =
       COALESCE((SELECT MIN(created_at) FROM outbox_events), NOW()) - INTERVAL '1 day'
     WHERE id = ANY($1)",
  )
  .bind(ids)
  .execute(pool)
  .await
  .expect("position only owned poll fixtures");
}

// ---------------------------------------------------------------------------
// P83-C-02-a — Raw INSERT lands in DB as unprocessed
//
// Invariant: a `comment_mention` outbox event inserted directly via SQL
// (the path taken by domain code outside the repository layer) must appear
// in `outbox_events` with `processed_at IS NULL` before any background
// processor runs.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_ob_e2e_raw_insert_lands_unprocessed() {
  let pool = helpers::setup_pool().await;
  let event_id = Uuid::new_v4();

  let result = std::panic::AssertUnwindSafe(async {
    sqlx::query(
      "INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, created_at) \
       VALUES ($1, 'doc', $2, 'mention', '{\"doc_id\":\"test\"}'::jsonb, now())",
    )
    .bind(event_id)
    .bind(event_id.to_string())
    .execute(&pool)
    .await
    .expect("raw INSERT into outbox_events must succeed");

    // Assert via independent raw SQL query — not via repository read path.
    let row = sqlx::query("SELECT id, event_type, processed_at FROM outbox_events WHERE id = $1")
      .bind(event_id)
      .fetch_optional(&pool)
      .await
      .expect("DB query after INSERT must succeed");

    assert!(
      row.is_some(),
      "P83-C-02-a: outbox event must exist in DB immediately after INSERT"
    );
    let row = row.unwrap();
    let event_type: String = row.get("event_type");
    assert_eq!(
      event_type, "mention",
      "P83-C-02-a: stored event_type must match the inserted value"
    );
    let processed_at: Option<chrono::DateTime<Utc>> = row.get("processed_at");
    assert!(
      processed_at.is_none(),
      "P83-C-02-a: processed_at must be NULL before background processor runs"
    );
  })
  .catch_unwind()
  .await;
  sqlx::query("DELETE FROM outbox_events WHERE id = $1")
    .bind(event_id)
    .execute(&pool)
    .await
    .expect("cleanup exact owned outbox ID");
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

// ---------------------------------------------------------------------------
// P83-C-02-b — After mark_event_processed, processed_at IS NOT NULL in DB
//
// Invariant: after `SqlxOutboxRepository::mark_event_processed` (the exact
// call the background processor makes after enqueuing a job), the row in
// `outbox_events` must have a non-NULL `processed_at` timestamp.
// This verifies the post-processing DB state the processor leaves behind.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_ob_e2e_mark_processed_sets_timestamp_in_db() {
  let pool = helpers::setup_pool().await;
  let repo = SqlxOutboxRepository::new(pool.clone());
  let event_id = Uuid::new_v4();

  let result = std::panic::AssertUnwindSafe(async {
    // Insert via raw SQL — same path the outbox publisher uses in production.
    sqlx::query(
      "INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, created_at) \
       VALUES ($1, 'workspace', $2, 'invite', '{\"userId\":\"test\"}'::jsonb, now())",
    )
    .bind(event_id)
    .bind(event_id.to_string())
    .execute(&pool)
    .await
    .expect("raw INSERT must succeed");

    // Simulate the processor marking this event processed after successful job enqueue.
    let processed_at_sent = Utc::now();
    repo
      .mark_event_processed(event_id, processed_at_sent)
      .await
      .expect("mark_event_processed must succeed for a known event_id");

    // Assert via independent raw SQL — repository return value is not the unit under test.
    let db_processed_at: Option<chrono::DateTime<Utc>> =
      sqlx::query_scalar("SELECT processed_at FROM outbox_events WHERE id = $1")
        .bind(event_id)
        .fetch_optional(&pool)
        .await
        .expect("DB query after mark_event_processed must succeed")
        .flatten();

    assert!(
      db_processed_at.is_some(),
      "P83-C-02-b: processed_at must be non-NULL in DB after mark_event_processed — \
       delivery invariant broken (event would be reprocessed on next processor tick)"
    );
  })
  .catch_unwind()
  .await;
  sqlx::query("DELETE FROM outbox_events WHERE id = $1")
    .bind(event_id)
    .execute(&pool)
    .await
    .expect("cleanup exact owned outbox ID");
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

// ---------------------------------------------------------------------------
// P83-C-02-c — list_unprocessed_events excludes processed events (full cycle)
//
// Invariant: after the full INSERT → mark_processed cycle, the event must
// no longer appear in `list_unprocessed_events`.  This confirms the processor
// de-queuing contract: processed events are invisible to the next batch poll.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_ob_e2e_processed_event_absent_from_next_batch_poll() {
  let pool = helpers::setup_pool().await;
  let repo = SqlxOutboxRepository::new(pool.clone());
  let event_id = Uuid::new_v4();

  let result = std::panic::AssertUnwindSafe(async {
    // Insert via raw SQL.
    sqlx::query(
      "INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, created_at) \
       VALUES ($1, 'doc', $2, 'comment_reply', '{}'::jsonb, now())",
    )
    .bind(event_id)
    .bind(event_id.to_string())
    .execute(&pool)
    .await
    .expect("raw INSERT must succeed");

    position_owned_events_first(&pool, &[event_id]).await;

    // Confirm event appears in unprocessed list before marking.
    let page = myoxus_domain::repositories::PageRequest { limit: 1000, offset: 0 };
    let before = repo
      .list_unprocessed_events(page)
      .await
      .expect("list_unprocessed_events must succeed");
    assert!(
      before.iter().any(|e| e.id == event_id),
      "P83-C-02-c: event must appear in unprocessed list before processing"
    );

    // Mark processed (simulating background processor after job enqueue).
    repo
      .mark_event_processed(event_id, Utc::now())
      .await
      .expect("mark_event_processed must succeed");

    // Assert event is absent from next batch poll.
    let page = myoxus_domain::repositories::PageRequest { limit: 1000, offset: 0 };
    let after = repo
      .list_unprocessed_events(page)
      .await
      .expect("list_unprocessed_events must succeed after mark_processed");
    assert!(
      !after.iter().any(|e| e.id == event_id),
      "P83-C-02-c: processed event must NOT appear in unprocessed list — \
       processor would re-deliver the same job on next tick"
    );
  })
  .catch_unwind()
  .await;
  sqlx::query("DELETE FROM outbox_events WHERE id = $1")
    .bind(event_id)
    .execute(&pool)
    .await
    .expect("cleanup exact owned outbox ID");
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

/// A real Task writer survives queue outage, worker reconstruction and a lost
/// SQL acknowledgement. Drop receipts stay terminal after subscription repair.
#[tokio::test]
async fn task_intent_is_transactional_recoverable_and_currently_authorized() {
  use myoxus_api::database_task_notification::{dispatch, enqueue};
  use myoxus_domain::database::DatabaseEditingRepository;
  use myoxus_domain::database::{DatabaseCellValueData, DatabaseEditPrecondition};
  use myoxus_worker::{RedisQueue, TerminalRetentionPolicy};
  use redis::AsyncCommands;
  use serde_json::{Value, json};
  use std::{panic::AssertUnwindSafe, sync::Arc};
  let mail = Arc::new(myoxus_infrastructure::mail::TestMailAdapter::default());
  let (app, pool, auth, state) = helpers::setup_app_with_task_notification_mail(mail.clone()).await;
  let (owner, session) = helpers::seed_user(&pool, &auth, "task-outbox-owner").await;
  let (recipient, _) = helpers::seed_user(&pool, &auth, "task-outbox-recipient").await;
  let redis_url = std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".into());
  let prefix = format!("myoxus:test:task-outbox:{}", Uuid::new_v4());
  let queue = RedisQueue::new(&redis_url, prefix.clone()).unwrap();
  let trigger = format!("task_outbox_fail_{}", Uuid::new_v4().simple());
  let body = AssertUnwindSafe(async {
    async fn mutate(app: &axum::Router, session: Uuid, query: &str, input: Value) -> Value {
      let response = helpers::gql(app, session, json!({"query":query,"variables":{"i":input}})).await;
      assert!(response.get("errors").is_none(), "{response}");
      response["data"].clone()
    }
    async fn event(pool: &sqlx::PgPool, row: Uuid) -> (Uuid, Value) {
      sqlx::query_as("SELECT id,payload FROM outbox_events WHERE event_type='database_task_notification' AND payload->'intent'->>'rowId'=$1 ORDER BY created_at DESC,id DESC LIMIT 1")
                .bind(row.to_string()).fetch_one(pool).await.unwrap()
    }
    async fn inbox_count(pool: &sqlx::PgPool, row: Uuid) -> i64 {
      sqlx::query_scalar("SELECT count(*) FROM notifications WHERE payload->>'rowId'=$1")
        .bind(row.to_string())
        .fetch_one(pool)
        .await
        .unwrap()
    }
    // These low-level fixtures establish dispatcher scope/missing-Row facts;
    // they do not simulate full cross-workspace publication. Keep the actual
    // catalog admission and SQL guards, without a managed-schema write bypass.
    async fn admitted_fixture_write<'q>(
      pool: &sqlx::PgPool,
      query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    ) {
      let mut tx = pool.begin().await.expect("begin owned authority fixture");
      sqlx::query("SELECT set_config('myoxus.admitted_database_sources',$1,true)")
        .bind(serde_json::to_string(&helpers::database_starter_catalog().admitted_sources())
          .expect("validated fixture catalog"))
        .execute(&mut *tx).await.expect("admit actual fixture sources");
      let result = query.execute(&mut *tx).await.expect("write owned current-authority fixture");
      assert_eq!(result.rows_affected(), 1, "fixture must retain its expected ordinary owner");
      tx.commit().await.expect("commit owned authority fixture");
    }
    let workspace = helpers::create_workspace(&pool, owner).await;
    helpers::create_workspace_root_doc(&pool, workspace, owner).await;
    helpers::add_workspace_member(&pool, workspace, recipient).await;
    let project=mutate(&app,session,"mutation($i:CreateProjectInput!){createProject(input:$i){database{id}fieldRoles{roleKey fieldId}}}",
              json!({"workspaceId":workspace,"title":"Durable Task intent","structurePreset":"TasksOnly","priorityPreset":"ThreeStep","complexityPreset":"ThreeStep"})).await;
    let project = &project["createProject"];
    let database: Uuid = project["database"]["id"].as_str().unwrap().parse().unwrap();
    let role = |key: &str| {
      project["fieldRoles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|role| role["roleKey"] == key)
        .unwrap()["fieldId"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap()
    };
    let assignees = role("task.assignees");
    let watchers = role("task.watchers");
    let status = role("task.status");
    let config: Value = sqlx::query_scalar("SELECT config_json FROM workspace_database_fields WHERE id=$1")
      .bind(status)
      .fetch_one(&pool)
      .await
      .unwrap();
    let complete = config["options"]
      .as_array()
      .unwrap()
      .iter()
      .find(|option| option["group"] == "complete")
      .unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string();
    let create = "mutation($i:CreateDatabaseRowInput!){createDatabaseRow(input:$i){row{id}}}";
    let assigned=mutate(&app,session,create,json!({"databaseId":database,"title":"Old Task title","cells":[{"fieldId":assignees,"value":{"users":[recipient]}}]})).await;
    let row: Uuid = assigned["createDatabaseRow"]["row"]["id"]
      .as_str()
      .unwrap()
      .parse()
      .unwrap();
    let (id, payload) = event(&pool, row).await;
    assert_eq!(
      inbox_count(&pool, row).await,
      0,
      "SQL commit creates intent, not an after-commit Inbox effect"
    );
    assert_eq!(
      payload["intent"]["recipients"],
      json!([{"userId":recipient,"kind":"assignment"}])
    );
    assert!(!payload.to_string().contains("Old Task title"));
    let offline = RedisQueue::new("redis://127.0.0.1:1", prefix.clone()).unwrap();
    assert!(
      tokio::time::timeout(
        std::time::Duration::from_secs(5),
        enqueue(&pool, &offline, id, &payload)
      )
      .await
      .unwrap()
      .is_err()
    );
    assert!(
      sqlx::query_scalar::<_, Option<chrono::DateTime<Utc>>>("SELECT processed_at FROM outbox_events WHERE id=$1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap()
        .is_none()
    );
    let title: Uuid =
      sqlx::query_scalar("SELECT id FROM workspace_database_fields WHERE database_id=$1 AND field_type='title'")
        .bind(database)
        .fetch_one(&pool)
        .await
        .unwrap();
    mutate(
      &app,
      session,
      "mutation($i:UpdateDatabaseRowTitleInput!){updateDatabaseRowTitle(input:$i){editRevision}}",
      json!({"databaseId":database,"rowId":row,"titleFieldId":title,"title":"Current authorized Task title"}),
    )
    .await;
    enqueue(&pool, &queue, id, &payload).await.unwrap();
    drop(queue.clone());
    let restarted = RedisQueue::new(&redis_url, prefix.clone()).unwrap();
    let job = restarted.dequeue("notification", 1).await.unwrap().unwrap();
    assert_eq!(job.id, format!("task-notification:{id}"));
    restarted
      .fail(
        "notification",
        &job.id,
        "owned delivery failure",
        None,
        TerminalRetentionPolicy::default(),
      )
      .await
      .unwrap();
    let failed = restarted.get_job("notification", &job.id).await.unwrap().unwrap();
    assert_eq!(failed.failed_reason.as_deref(), Some("owned delivery failure"));
    assert_eq!(failed.attempts_made, 1);
    enqueue(&pool, &restarted, id, &payload).await.unwrap();
    let after_handoff = restarted.get_job("notification", &job.id).await.unwrap().unwrap();
    assert_eq!(after_handoff.name, failed.name);
    assert_eq!(after_handoff.data, failed.data);
    assert_eq!(after_handoff.failed_reason, failed.failed_reason);
    assert_eq!(after_handoff.attempts_made, failed.attempts_made);
    assert_eq!(after_handoff.finished_on, failed.finished_on);
    assert!(
      restarted.dequeue("notification", 1).await.unwrap().is_none(),
      "handoff replay cannot reset failed work"
    );
    restarted.retry_job("notification", &job.id).await.unwrap();
    let job = restarted.dequeue("notification", 1).await.unwrap().unwrap();
    assert_eq!(job.id, failed.id);
    assert_eq!(job.attempts_made, 0, "only the explicit retry owner resets attempts");
    let outcome = dispatch(&pool, &state, &job.data, std::sync::Arc::new(myoxus_infrastructure::workspace_database::PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog()))).await.unwrap();
    restarted
      .ack(
        "notification",
        &job.id,
        Some(outcome),
        TerminalRetentionPolicy::default(),
      )
      .await
      .unwrap();
    assert_eq!(inbox_count(&pool, row).await, 1);
    assert_eq!(mail.sent_mails.lock().unwrap().len(), 1);
    assert!(
      mail.sent_mails.lock().unwrap()[0]
        .body
        .contains("Current authorized Task title")
    );
    assert!(!mail.sent_mails.lock().unwrap()[0].body.contains("Old Task title"));
    // The SQL ack was intentionally omitted. Exact completed-job/receipt
    // readback acknowledges the same work without another Inbox/email.
    enqueue(&pool, &restarted, id, &payload).await.unwrap();
    dispatch(&pool, &state, &job.data, std::sync::Arc::new(myoxus_infrastructure::workspace_database::PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog()))).await.unwrap();
    assert_eq!(inbox_count(&pool, row).await, 1);
    assert_eq!(mail.sent_mails.lock().unwrap().len(), 1);
    SqlxOutboxRepository::new(pool.clone())
      .mark_event_processed(id, Utc::now())
      .await
      .unwrap();

    let repo = myoxus_infrastructure::workspace_database::PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog());
    let cells_before: Value = sqlx::query_scalar(
      "SELECT jsonb_agg(to_jsonb(cell) ORDER BY field_id) FROM workspace_database_cell_values cell WHERE row_id=$1",
    )
    .bind(row)
    .fetch_one(&pool)
    .await
    .unwrap();
    let count_before:i64=sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE event_type='database_task_notification' AND payload->'intent'->>'rowId'=$1")
              .bind(row.to_string()).fetch_one(&pool).await.unwrap();
    assert!(
      repo
        .update_cell_value(
          row,
          status,
          DatabaseCellValueData::Status(complete.clone()),
          owner,
          DatabaseEditPrecondition::default().in_workspace(Uuid::new_v4()),
          None
        )
        .await
        .is_err()
    );
    assert_eq!(
      sqlx::query_scalar::<_, Value>(
        "SELECT jsonb_agg(to_jsonb(cell) ORDER BY field_id) FROM workspace_database_cell_values cell WHERE row_id=$1"
      )
      .bind(row)
      .fetch_one(&pool)
      .await
      .unwrap(),
      cells_before
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM outbox_events WHERE event_type='database_task_notification' AND payload->'intent'->>'rowId'=$1")
              .bind(row.to_string()).fetch_one(&pool).await.unwrap(),count_before,"rollback creates no intent");

    // If the outbox insert itself fails, the native Cell, derived completion
    // state and revision must roll back. An after-commit publisher fails this.
    sqlx::query(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned Task intent failure'; END; $$")).execute(&pool).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER {trigger}_insert BEFORE INSERT ON outbox_events FOR EACH ROW WHEN (NEW.event_type='database_task_notification' AND NEW.aggregate_id='{row}') EXECUTE FUNCTION {trigger}()"))
              .execute(&pool).await.unwrap();
    assert!(
      repo
        .update_cell_value(
          row,
          status,
          DatabaseCellValueData::Status(complete.clone()),
          owner,
          Default::default(),
          None
        )
        .await
        .is_err()
    );
    assert_eq!(
      sqlx::query_scalar::<_, Value>(
        "SELECT jsonb_agg(to_jsonb(cell) ORDER BY field_id) FROM workspace_database_cell_values cell WHERE row_id=$1"
      )
      .bind(row)
      .fetch_one(&pool)
      .await
      .unwrap(),
      cells_before
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM outbox_events WHERE event_type='database_task_notification' AND payload->'intent'->>'rowId'=$1")
              .bind(row.to_string()).fetch_one(&pool).await.unwrap(),count_before);
    sqlx::query(&format!("DROP TRIGGER {trigger}_insert ON outbox_events"))
      .execute(&pool)
      .await
      .unwrap();
    repo
      .update_cell_value(
        row,
        status,
        DatabaseCellValueData::Status(complete.clone()),
        owner,
        Default::default(),
        None,
      )
      .await
      .unwrap();
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM outbox_events WHERE event_type='database_task_notification' AND payload->'intent'->>'rowId'=$1")
              .bind(row.to_string()).fetch_one(&pool).await.unwrap(),count_before+1);
    let (closed_id, closed_payload) = event(&pool, row).await;
    dispatch(
      &pool,
      &state,
      &json!({"eventId":closed_id,"intent":closed_payload["intent"]}), std::sync::Arc::new(myoxus_infrastructure::workspace_database::PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog())))
    .await
    .unwrap();
    assert_eq!(
      inbox_count(&pool, row).await,
      2,
      "Closed completion still reaches current assignees"
    );
    assert_eq!(mail.sent_mails.lock().unwrap().len(), 1, "completion is in-app only");

    // Failure after Inbox insertion, before the worker receipt commit, must
    // replay via the existing inserted-only identity without sending mail twice.
    let created=mutate(&app,session,create,json!({"databaseId":database,"title":"Receipt failure Task","cells":[{"fieldId":assignees,"value":{"users":[recipient]}}]})).await;
    let failing: Uuid = created["createDatabaseRow"]["row"]["id"]
      .as_str()
      .unwrap()
      .parse()
      .unwrap();
    let (failing_id, failing_payload) = event(&pool, failing).await;

    sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE UPDATE ON outbox_events FOR EACH ROW WHEN (NEW.id='{failing_id}'::uuid) EXECUTE FUNCTION {trigger}()"))
              .execute(&pool).await.unwrap();
    let data = json!({"eventId":failing_id,"intent":failing_payload["intent"]});
    assert!(dispatch(&pool, &state, &data, std::sync::Arc::new(myoxus_infrastructure::workspace_database::PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog()))).await.is_err());
    assert_eq!(inbox_count(&pool, failing).await, 1);
    assert_eq!(mail.sent_mails.lock().unwrap().len(), 2);
    use myoxus_application::maintenance::RetentionRepository;
    let retention = myoxus_infrastructure::maintenance::SqlxRetentionRepository::new(pool.clone());
    let general = state
      .notification()
      .create_in_app_notification(
        recipient,
        "general".into(),
        Some("info".into()),
        format!("task-retention-general:{failing_id}"),
        json!({"rowId":failing,"taskNotificationEventId":failing_id}),
      )
      .await
      .unwrap();
    sqlx::query("UPDATE notifications SET created_at=NOW()-INTERVAL '14 days' WHERE payload->>'rowId'=$1")
      .bind(failing.to_string())
      .execute(&pool)
      .await
      .unwrap();
    retention.clean_notifications(7).await.unwrap();
    let general_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM notifications WHERE id=$1)")
      .bind(general.id)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert!(
      !general_exists,
      "a General body marker cannot opt into Task receipt retention"
    );
    assert_eq!(
      inbox_count(&pool, failing).await,
      1,
      "unfinished SQL receipt protects inserted-only Inbox evidence"
    );
    sqlx::query(&format!("DROP TRIGGER {trigger} ON outbox_events"))
      .execute(&pool)
      .await
      .unwrap();
    dispatch(&pool, &state, &data, std::sync::Arc::new(myoxus_infrastructure::workspace_database::PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog()))).await.unwrap();
    assert_eq!(inbox_count(&pool, failing).await, 1);
    assert_eq!(
      mail.sent_mails.lock().unwrap().len(),
      2,
      "Inbox receipt recovery cannot replay optional email"
    );

    retention.clean_notifications(7).await.unwrap();
    assert_eq!(
      inbox_count(&pool, failing).await,
      0,
      "terminal receipt restores ordinary Inbox retention"
    );
    dispatch(&pool, &state, &data, std::sync::Arc::new(myoxus_infrastructure::workspace_database::PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog()))).await.unwrap();
    assert_eq!(
      inbox_count(&pool, failing).await,
      0,
      "terminal event cannot recreate an expired Inbox"
    );
    assert_eq!(
      mail.sent_mails.lock().unwrap().len(),
      2,
      "terminal replay cannot resend mail after Inbox retention"
    );

    // An actual content-bearing Task template prepares its body before Row
    // publication. A late SQL failure must compensate that page, never notify.
    use myoxus_domain::database::DatabaseDefinitionRepository;
    let template = repo
      .list_row_templates(database)
      .await
      .unwrap()
      .into_iter()
      .find(|template| template.row_kind == myoxus_domain::database::DatabaseRowKind::Task)
      .unwrap();
    let source = state
      .doc()
      .create_page(workspace, owner, Some("Task template source".into()))
      .await
      .unwrap();
    let initial = std::collections::BTreeMap::from([(assignees, DatabaseCellValueData::Users(vec![recipient]))]);
    repo
      .update_row_template(
        template.id,
        None,
        None,
        None,
        None,
        None,
        Some(initial),
        owner,
        myoxus_domain::database::DatabaseEditPrecondition::new(Some(template.edit_revision), false),
      )
      .await
      .unwrap();
    sqlx::query("UPDATE workspace_database_row_templates SET content_document_id=$2 WHERE id=$1")
      .bind(template.id)
      .bind(source.id)
      .execute(&pool)
      .await
      .unwrap();
    let docs_before: i64 = sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1")
      .bind(workspace)
      .fetch_one(&pool)
      .await
      .unwrap();
    let rows_before: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_database_rows WHERE database_id=$1")
      .bind(database)
      .fetch_one(&pool)
      .await
      .unwrap();
    let intents_before:i64=sqlx::query_scalar("SELECT count(*) FROM outbox_events WHERE event_type='database_task_notification' AND payload->'intent'->>'databaseId'=$1")
              .bind(database.to_string()).fetch_one(&pool).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER {trigger}_body BEFORE INSERT ON workspace_database_rows FOR EACH ROW WHEN (NEW.database_id='{database}'::uuid AND NEW.title='Body publication rollback') EXECUTE FUNCTION {trigger}()"))
              .execute(&pool).await.unwrap();
    let apply = "mutation($i:CreateDatabaseRowFromTemplateInput!){createDatabaseRowFromTemplate(input:$i){row{id contentDocument{documentId state}}}}";
    let input = json!({"databaseId":database,"rowTemplateId":template.id,"title":"Body publication rollback"});
    let rejected = helpers::gql(&app, session, json!({"query":apply,"variables":{"i":input}})).await;
    assert_eq!(
      rejected["errors"][0]["extensions"]["code"], "MIX_DATABASE_STORAGE",
      "{rejected}"
    );
    assert!(
      rejected["errors"][0]["message"]
        .as_str()
        .unwrap()
        .contains("owned Task intent failure"),
      "the prepared body must reach the deliberately failing Row INSERT: {rejected}"
    );
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT count(*) FROM docs WHERE workspace_id=$1")
        .bind(workspace)
        .fetch_one(&pool)
        .await
        .unwrap(),
      docs_before,
      "failed Row publication removes its already prepared native body"
    );
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspace_database_rows WHERE database_id=$1")
        .bind(database)
        .fetch_one(&pool)
        .await
        .unwrap(),
      rows_before
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM outbox_events WHERE event_type='database_task_notification' AND payload->'intent'->>'databaseId'=$1")
              .bind(database.to_string()).fetch_one(&pool).await.unwrap(),intents_before);
    sqlx::query(&format!("DROP TRIGGER {trigger}_body ON workspace_database_rows"))
      .execute(&pool)
      .await
      .unwrap();
    let applied = mutate(&app, session, apply, input).await;
    let applied = &applied["createDatabaseRowFromTemplate"]["row"];
    let template_row: Uuid = applied["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(applied["contentDocument"]["state"], "Available");
    assert_eq!(
      sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM database_document_references WHERE row_id=$1 AND reference_kind='row_content_document'"
      )
      .bind(template_row)
      .fetch_one(&pool)
      .await
      .unwrap(),
      1,
      "body reference is part of the original Row transaction"
    );
    let (template_event, template_payload) = event(&pool, template_row).await;
    dispatch(
      &pool,
      &state,
      &json!({"eventId":template_event,"intent":template_payload["intent"]}), std::sync::Arc::new(myoxus_infrastructure::workspace_database::PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog())))
    .await
    .unwrap();
    assert_eq!(inbox_count(&pool, template_row).await, 1);
    assert_eq!(mail.sent_mails.lock().unwrap().len(), 3);

    for scenario in ["unfollow", "revoked", "trashed", "moved", "purged"] {
      let created = mutate(
        &app,
        session,
        create,
        json!({"databaseId":database,"title":format!("Eligibility {scenario}"),"cells":[
          {"fieldId":assignees,"value":{"users":[]}},{"fieldId":watchers,"value":{"users":[recipient]}}
        ]}),
      )
      .await;
      let target: Uuid = created["createDatabaseRow"]["row"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
      // Direct repository use is the same producer used by Automation.
      repo
        .update_cell_value(
          target,
          status,
          DatabaseCellValueData::Status(complete.clone()),
          owner,
          Default::default(),
          None,
        )
        .await
        .unwrap();
      let (event_id, payload) = event(&pool, target).await;
      assert_eq!(
        payload["intent"]["recipients"],
        json!([{"userId":recipient,"kind":"changed"}])
      );
      let mut moved_workspace = None;
      match scenario {
        "unfollow" => {
          repo
            .update_cell_value(
              target,
              watchers,
              DatabaseCellValueData::Users(vec![]),
              recipient,
              Default::default(),
              None,
            )
            .await
            .unwrap();
        }
        "revoked" => {
          sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2")
            .bind(workspace)
            .bind(recipient)
            .execute(&pool)
            .await
            .unwrap();
        }
        "trashed" => {
          state
            .database_services()
            .unwrap()
            .editing
            .delete_row(owner, database, target)
            .await
            .unwrap();
        }
        "moved" => {
          let other = helpers::create_workspace(&pool, owner).await;
          moved_workspace = Some(other);
          admitted_fixture_write(&pool,
            sqlx::query("UPDATE workspace_databases SET workspace_id=$2 WHERE id=$1 AND workspace_id=$3 AND system_role IS NULL")
              .bind(database).bind(other).bind(workspace),
          ).await;
        }
        "purged" => {
          admitted_fixture_write(&pool,
            sqlx::query("DELETE FROM workspace_database_rows r USING workspace_databases d
              WHERE r.id=$1 AND r.database_id=$2 AND d.id=r.database_id
                AND d.workspace_id=$3 AND d.system_role IS NULL")
              .bind(target).bind(database).bind(workspace),
          ).await;
        }
        _ => {}
      }
      let data = json!({"eventId":event_id,"intent":payload["intent"]});
      dispatch(&pool, &state, &data, std::sync::Arc::new(myoxus_infrastructure::workspace_database::PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog()))).await.unwrap();
      assert_eq!(inbox_count(&pool, target).await, 0, "{scenario}");
      match scenario {
        "unfollow" => {
          repo
            .update_cell_value(
              target,
              watchers,
              DatabaseCellValueData::Users(vec![recipient]),
              recipient,
              Default::default(),
              None,
            )
            .await
            .unwrap();
        }
        "revoked" => helpers::add_workspace_member(&pool, workspace, recipient).await,
        "trashed" => {
          state
            .database_services()
            .unwrap()
            .editing
            .bulk_restore_rows(owner, database, &[target])
            .await
            .unwrap();
        }
        "moved" => {
          admitted_fixture_write(&pool,
            sqlx::query("UPDATE workspace_databases SET workspace_id=$2 WHERE id=$1 AND workspace_id=$3 AND system_role IS NULL")
              .bind(database).bind(workspace).bind(moved_workspace.expect("moved fixture workspace")),
          ).await;
        }
        _ => {}
      }
      dispatch(&pool, &state, &data, std::sync::Arc::new(myoxus_infrastructure::workspace_database::PgDatabaseRepository::new(pool.clone(), crate::helpers::database_starter_catalog()))).await.unwrap();
      assert_eq!(
        inbox_count(&pool, target).await,
        0,
        "terminal receipt must survive repair: {scenario}"
      );
      assert_eq!(
        mail.sent_mails.lock().unwrap().len(),
        3,
        "Changed is always in-app only"
      );
    }
  }).catch_unwind().await;
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger}_insert ON outbox_events"))
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query(&format!(
    "DROP TRIGGER IF EXISTS {trigger}_body ON workspace_database_rows"
  ))
  .execute(&pool)
  .await
  .unwrap();
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger} ON outbox_events"))
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {trigger}() CASCADE"))
    .execute(&pool)
    .await
    .unwrap();
  let mut connection = redis::Client::open(redis_url)
    .unwrap()
    .get_multiplexed_async_connection()
    .await
    .unwrap();
  let keys: Vec<String> = connection.keys(format!("{prefix}:*")).await.unwrap();
  if !keys.is_empty() {
    let _: usize = connection.del(keys).await.unwrap();
  }
  helpers::cleanup_users(&pool, &[recipient, owner]).await;
  if let Err(error) = body {
    std::panic::resume_unwind(error);
  }
}
