//! P83 — Invariant-first integration tests: transactional outbox domain.
//!
//! Tests verify DB STATE after operations, not just repository return values.
//! Naming convention: `inv_{code}_{description}`.
//!
//! Invariant source: the outbox pattern requires that
//!   (a) every enqueued event has processed_at IS NULL until explicitly marked, and
//!   (b) marking an event processed sets a non-NULL timestamp that is retained.
//!
//! These tests use the `SqlxOutboxRepository` directly (no HTTP layer needed)
//! and confirm the DB state via independent raw SQL queries after each
//! repository operation — they do NOT rely solely on repository return values.

use crate::helpers;

use chrono::Utc;
use myoxus_domain::entities::{OutboxEvent, OutboxEventType};
use myoxus_domain::repositories::OutboxRepository;
use myoxus_infrastructure::outbox::SqlxOutboxRepository;
use sqlx::Row;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// INV-OB-01 — Enqueued outbox event exists in DB with processed_at = NULL
//
// Invariant: every event written to the outbox before background processing
// must be present in `outbox_events` with `processed_at IS NULL`.
// The background worker must not be required for the row to exist.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_ob01_enqueued_event_exists_unprocessed_in_db() {
  let pool = helpers::setup_pool().await;
  let repo = SqlxOutboxRepository::new(pool.clone());

  let entity_id = Uuid::new_v4();
  let event = OutboxEvent {
    id: Uuid::new_v4(),
    aggregate_type: "doc".to_string(),
    aggregate_id: entity_id.to_string(),
    event_type: OutboxEventType::Mention,
    payload: serde_json::json!({"doc_id": entity_id}),
    created_at: Utc::now(),
    processed_at: None,
  };

  repo
    .enqueue_event(&event)
    .await
    .expect("INV-OB-01: enqueue_event must succeed");

  // Assert via raw SQL — independent of the repository read path.
  let row = sqlx::query("SELECT id, aggregate_id, processed_at FROM outbox_events WHERE id = $1")
    .bind(event.id)
    .fetch_optional(&pool)
    .await
    .expect("INV-OB-01: DB query failed");

  assert!(
    row.is_some(),
    "INV-OB-01: event row must exist in outbox_events after enqueue"
  );
  let row = row.expect("outbox row must exist");
  let stored_aggregate_id: String = row.get("aggregate_id");
  assert_eq!(
    stored_aggregate_id,
    entity_id.to_string(),
    "INV-OB-01: stored aggregate_id must match the enqueued event"
  );
  let processed_at: Option<chrono::DateTime<Utc>> = row.get("processed_at");
  assert!(
    processed_at.is_none(),
    "INV-OB-01: processed_at must be NULL before background worker runs — outbox invariant broken"
  );

  // Cleanup — outbox rows have no FK to user/workspace, delete directly.
  sqlx::query("DELETE FROM outbox_events WHERE id = $1")
    .bind(event.id)
    .execute(&pool)
    .await
    .ok();
}

// ---------------------------------------------------------------------------
// INV-OB-02 — Processed event has a non-NULL processed_at timestamp in DB
//
// Invariant: after mark_event_processed, the `processed_at` column in
// `outbox_events` must be set to a non-NULL timestamp, permanently recording
// that the event was delivered.  This is verified against the raw DB row.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_ob02_processed_event_has_timestamp_in_db() {
  let pool = helpers::setup_pool().await;
  let repo = SqlxOutboxRepository::new(pool.clone());

  let event = OutboxEvent {
    id: Uuid::new_v4(),
    aggregate_type: "workspace".to_string(),
    aggregate_id: Uuid::new_v4().to_string(),
    event_type: OutboxEventType::Invite,
    payload: serde_json::json!({}),
    created_at: Utc::now(),
    processed_at: None,
  };

  repo
    .enqueue_event(&event)
    .await
    .expect("INV-OB-02: enqueue must succeed");

  let processed_at_sent = Utc::now();
  repo
    .mark_event_processed(event.id, processed_at_sent)
    .await
    .expect("INV-OB-02: mark_event_processed must succeed");

  // Assert via raw SQL — repository return value alone is not sufficient.
  let db_processed_at: Option<chrono::DateTime<Utc>> =
    sqlx::query_scalar("SELECT processed_at FROM outbox_events WHERE id = $1")
      .bind(event.id)
      .fetch_optional(&pool)
      .await
      .expect("INV-OB-02: DB query failed")
      .flatten();

  assert!(
    db_processed_at.is_some(),
    "INV-OB-02: processed_at must be non-NULL in DB after mark_event_processed — delivery invariant broken"
  );

  // Cleanup.
  sqlx::query("DELETE FROM outbox_events WHERE id = $1")
    .bind(event.id)
    .execute(&pool)
    .await
    .ok();
}
