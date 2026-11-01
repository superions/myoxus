//! Integration tests for the PostgreSQL transactional outbox.
//!
//! Validates that:
//!  - Raw INSERT into `outbox_events` followed by `OutboxRepository` queries
//!    behaves correctly (the infrastructure crate's repository is the unit under
//!    test here, not the HTTP layer).
//!  - `list_unprocessed_events` only returns events with `processed_at IS NULL`.
//!  - `mark_event_processed` sets `processed_at` and hides the event from the
//!    unprocessed list.
//!  - Already-processed events are skipped on re-query.
//!
//! Requirements:
//!   - PostgreSQL at TEST_DATABASE_URL env (default: postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test)
//!   - Migrations applied (helpers::setup_pool runs them automatically)
//!
//! These tests do NOT touch Redis or the `worker_jobs` table.

use crate::helpers;

use chrono::Utc;
use futures_util::FutureExt;
use myoxus_domain::entities::{OutboxEvent, OutboxEventType};
use myoxus_domain::repositories::{OutboxRepository, PageRequest};
use myoxus_infrastructure::outbox::SqlxOutboxRepository;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_event(event_type: OutboxEventType) -> OutboxEvent {
  OutboxEvent {
    id: Uuid::new_v4(),
    aggregate_type: "workspace".to_string(),
    aggregate_id: Uuid::new_v4().to_string(),
    event_type,
    payload: serde_json::json!({"key": "value"}),
    created_at: Utc::now(),
    processed_at: None,
  }
}

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
// Test: enqueue + list_unprocessed returns the event
// ---------------------------------------------------------------------------

/// A freshly enqueued event (with `processed_at = None`) must be returned
/// by `list_unprocessed_events`.
#[tokio::test]
async fn outbox_list_unprocessed_returns_new_event() {
  let pool = helpers::setup_pool().await;
  let repo = SqlxOutboxRepository::new(pool.clone());

  let event = make_event(OutboxEventType::Invite);
  let result = std::panic::AssertUnwindSafe(async {
    let stored = repo.enqueue_event(&event).await.expect("enqueue_event");

    assert_eq!(stored.id, event.id, "stored event must have the same ID");
    assert!(stored.processed_at.is_none(), "new event must have processed_at = NULL");

    // Retrieve only unprocessed events.
    position_owned_events_first(&pool, &[event.id]).await;

    let page = PageRequest { limit: 100, offset: 0 };
    let unprocessed = repo
      .list_unprocessed_events(page)
      .await
      .expect("list_unprocessed_events");

    let found = unprocessed.iter().any(|e| e.id == event.id);
    assert!(found, "newly enqueued event must appear in unprocessed list");
  })
  .catch_unwind()
  .await;
  sqlx::query("DELETE FROM outbox_events WHERE id = ANY($1)")
    .bind(&[event.id][..])
    .execute(&pool)
    .await
    .expect("cleanup exact owned outbox IDs");
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

// ---------------------------------------------------------------------------
// Test: mark_event_processed hides event from unprocessed list
// ---------------------------------------------------------------------------

/// After `mark_event_processed`, the event must no longer appear in
/// `list_unprocessed_events`.
#[tokio::test]
async fn outbox_mark_processed_hides_event_from_unprocessed_list() {
  let pool = helpers::setup_pool().await;
  let repo = SqlxOutboxRepository::new(pool.clone());

  let event = make_event(OutboxEventType::Mention);
  let result = std::panic::AssertUnwindSafe(async {
    repo.enqueue_event(&event).await.expect("enqueue_event");

    let processed_at = Utc::now();
    repo
      .mark_event_processed(event.id, processed_at)
      .await
      .expect("mark_event_processed");

    position_owned_events_first(&pool, &[event.id]).await;

    let page = PageRequest { limit: 1000, offset: 0 };
    let unprocessed = repo
      .list_unprocessed_events(page)
      .await
      .expect("list_unprocessed_events");

    let still_visible = unprocessed.iter().any(|e| e.id == event.id);
    assert!(!still_visible, "processed event must NOT appear in unprocessed list");
  })
  .catch_unwind()
  .await;
  sqlx::query("DELETE FROM outbox_events WHERE id = ANY($1)")
    .bind(&[event.id][..])
    .execute(&pool)
    .await
    .expect("cleanup exact owned outbox IDs");
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

// ---------------------------------------------------------------------------
// Test: already-processed event is not duplicated on re-insert attempt
// ---------------------------------------------------------------------------

/// Inserting an event with `processed_at` already set must store it with that
/// timestamp and the event must NOT appear in `list_unprocessed_events`.
#[tokio::test]
async fn outbox_already_processed_event_is_not_in_unprocessed_list() {
  let pool = helpers::setup_pool().await;
  let repo = SqlxOutboxRepository::new(pool.clone());

  // Insert an event that is already marked as processed.
  let already_processed = OutboxEvent {
    id: Uuid::new_v4(),
    aggregate_type: "doc".to_string(),
    aggregate_id: Uuid::new_v4().to_string(),
    event_type: OutboxEventType::CommentReply,
    payload: serde_json::json!({}),
    created_at: Utc::now(),
    processed_at: Some(Utc::now()),
  };

  let result = std::panic::AssertUnwindSafe(async {
    let stored = repo
      .enqueue_event(&already_processed)
      .await
      .expect("enqueue_event with processed_at");

    assert!(
      stored.processed_at.is_some(),
      "stored event must carry the pre-set processed_at"
    );

    position_owned_events_first(&pool, &[already_processed.id]).await;

    let page = PageRequest { limit: 1000, offset: 0 };
    let unprocessed = repo
      .list_unprocessed_events(page)
      .await
      .expect("list_unprocessed_events");

    let visible = unprocessed.iter().any(|e| e.id == already_processed.id);
    assert!(
      !visible,
      "event inserted with processed_at must not appear in unprocessed list"
    );
  })
  .catch_unwind()
  .await;
  sqlx::query("DELETE FROM outbox_events WHERE id = ANY($1)")
    .bind(&[already_processed.id][..])
    .execute(&pool)
    .await
    .expect("cleanup exact owned outbox IDs");
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

// ---------------------------------------------------------------------------
// Test: multiple events — only unprocessed ones are listed
// ---------------------------------------------------------------------------

/// With a mix of processed and unprocessed events, only the unprocessed ones
/// must be returned.
#[tokio::test]
async fn outbox_list_unprocessed_filters_processed_events() {
  let pool = helpers::setup_pool().await;
  let repo = SqlxOutboxRepository::new(pool.clone());

  // Enqueue two events.
  let ev1 = make_event(OutboxEventType::AccessChange);
  let ev2 = make_event(OutboxEventType::Invite);
  let result = std::panic::AssertUnwindSafe(async {
    repo.enqueue_event(&ev1).await.expect("enqueue ev1");
    repo.enqueue_event(&ev2).await.expect("enqueue ev2");

    // Mark ev1 as processed.
    repo
      .mark_event_processed(ev1.id, Utc::now())
      .await
      .expect("mark ev1 processed");

    position_owned_events_first(&pool, &[ev1.id, ev2.id]).await;

    let page = PageRequest { limit: 1000, offset: 0 };
    let unprocessed = repo
      .list_unprocessed_events(page)
      .await
      .expect("list_unprocessed_events");

    let ev1_visible = unprocessed.iter().any(|e| e.id == ev1.id);
    let ev2_visible = unprocessed.iter().any(|e| e.id == ev2.id);

    assert!(!ev1_visible, "processed event ev1 must not be in unprocessed list");
    assert!(ev2_visible, "unprocessed event ev2 must be in unprocessed list");
  })
  .catch_unwind()
  .await;
  sqlx::query("DELETE FROM outbox_events WHERE id = ANY($1)")
    .bind(&[ev1.id, ev2.id][..])
    .execute(&pool)
    .await
    .expect("cleanup exact owned outbox IDs");
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

// ---------------------------------------------------------------------------
// Test: mark_event_processed returns NotFound for unknown ID
// ---------------------------------------------------------------------------

/// Marking a non-existent event as processed must return a `NotFound` error.
#[tokio::test]
async fn outbox_mark_processed_returns_not_found_for_unknown_id() {
  let pool = helpers::setup_pool().await;
  let repo = SqlxOutboxRepository::new(pool);

  let bogus_id = Uuid::new_v4();
  let result = repo.mark_event_processed(bogus_id, Utc::now()).await;

  assert!(result.is_err(), "marking a non-existent event must return an error");
  match result {
    Err(myoxus_domain::repositories::RepositoryError::NotFound(_)) => {}
    Err(e) => panic!("expected NotFound error, got: {e:?}"),
    Ok(_) => panic!("expected error, got Ok"),
  }
}
