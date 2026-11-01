//! Integration tests for the transactional outbox repository (enqueue, claim, ack).
use chrono::{Duration, Utc};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use myoxus_domain::entities::{OutboxEvent, OutboxEventType};
use myoxus_domain::repositories::{OutboxRepository, PageRequest};
use myoxus_infrastructure::outbox::SqlxOutboxRepository;

async fn setup_pool() -> PgPool {
  let database_url =
    std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://myoxus:myoxus@localhost:5432/myoxus".to_string());
  let pool = PgPool::connect(&database_url)
    .await
    .expect("postgres must be reachable for outbox repository tests");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrations must succeed");
  pool
}

#[tokio::test]
async fn outbox_repository_enforces_taxonomy_and_processing_flow() {
  let pool = setup_pool().await;
  let repo = SqlxOutboxRepository::new(pool);
  let now = Utc::now();

  let created = repo
    .enqueue_event(&OutboxEvent {
      id: Uuid::new_v4(),
      aggregate_type: "comment".to_string(),
      aggregate_id: Uuid::new_v4().to_string(),
      event_type: OutboxEventType::CommentReply,
      payload: json!({"commentId":"c1","replyId":"r1"}),
      created_at: now,
      processed_at: None,
    })
    .await
    .expect("outbox enqueue should succeed");
  assert_eq!(created.event_type, OutboxEventType::CommentReply);

  let pending = repo
    .list_unprocessed_events(PageRequest { limit: 20, offset: 0 })
    .await
    .expect("list pending events");
  assert!(pending.iter().any(|event| event.id == created.id));

  repo
    .mark_event_processed(created.id, now + Duration::seconds(1))
    .await
    .expect("mark processed should succeed");

  let pending_after = repo
    .list_unprocessed_events(PageRequest { limit: 20, offset: 0 })
    .await
    .expect("list pending events after processing");
  assert!(
    pending_after.iter().all(|event| event.id != created.id),
    "processed outbox event must not appear in pending query"
  );
}
