//! Integration tests for the SQLx notification repository (create, list, mark-read).
use std::sync::Arc;

use chrono::{Duration, Utc};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use myoxus_application::notification::{NotificationListRequest, NotificationService, NotificationStore};
use myoxus_infrastructure::notification::SqlxNotificationRepository;

async fn setup_pool() -> PgPool {
  let database_url =
    std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://myoxus:myoxus@localhost:5432/myoxus".to_string());
  let pool = PgPool::connect(&database_url)
    .await
    .expect("postgres must be reachable for notification repository tests");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrations must succeed");
  pool
}

async fn seed_user(pool: &PgPool) -> Uuid {
  let user_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(format!("notification-user-{user_id}@example.test"))
    .bind("Notification User")
    .execute(pool)
    .await
    .expect("seed user");
  user_id
}

#[tokio::test]
async fn notification_repository_supports_unread_count_mark_read_and_cursor_pagination() {
  let pool = setup_pool().await;
  let user_id = seed_user(&pool).await;
  let foreign_user_id = seed_user(&pool).await;
  let repo_impl = SqlxNotificationRepository::new(pool.clone());
  let store: Arc<dyn NotificationStore> = Arc::new(repo_impl);
  let service = NotificationService::new(store.clone());
  let now = Utc::now();

  let first = NotificationStore::create_notification(
    store.as_ref(),
    user_id,
    "mention".to_string(),
    "default".to_string(),
    None,
    json!({"order": 1}),
    now,
  )
  .await
  .expect("create first notification");
  let _second = NotificationStore::create_notification(
    store.as_ref(),
    user_id,
    "comment_reply".to_string(),
    "default".to_string(),
    None,
    json!({"order": 2}),
    now + Duration::seconds(1),
  )
  .await
  .expect("create second notification");
  let _third = NotificationStore::create_notification(
    store.as_ref(),
    user_id,
    "invitation".to_string(),
    "default".to_string(),
    None,
    json!({"order": 3}),
    now + Duration::seconds(2),
  )
  .await
  .expect("create third notification");

  let page_one = service
    .list_notifications(
      user_id,
      NotificationListRequest {
        first: Some(2),
        ..Default::default()
      },
    )
    .await
    .expect("list first page");
  assert_eq!(page_one.total_count, 3);
  assert_eq!(page_one.edges.len(), 2);
  assert!(page_one.page_info.has_next_page);
  assert!(!page_one.page_info.has_previous_page);

  let _concurrent = NotificationStore::create_notification(
    store.as_ref(),
    user_id,
    "general".to_string(),
    "default".to_string(),
    None,
    json!({"order": 4}),
    now + Duration::seconds(3),
  )
  .await
  .expect("create concurrent notification");

  let page_two = service
    .list_notifications(
      user_id,
      NotificationListRequest {
        first: Some(2),
        after: page_one.page_info.end_cursor.clone(),
        ..Default::default()
      },
    )
    .await
    .expect("list second page");
  assert_eq!(page_two.total_count, 4);
  assert_eq!(page_two.edges.len(), 1);
  assert!(!page_two.page_info.has_next_page);
  assert!(page_two.page_info.has_previous_page);
  assert_eq!(page_two.edges[0].node.id, first.notification.id);

  let unread_before = service.unread_count(user_id).await.expect("unread count");
  assert_eq!(unread_before, 4);

  let marked = service
    .mark_notification_read(user_id, first.notification.id)
    .await
    .expect("mark read");
  assert!(marked);
  let unread_after_single = service
    .unread_count(user_id)
    .await
    .expect("unread count after single read");
  assert_eq!(unread_after_single, 3);

  let marked_all = service
    .mark_all_notifications_read(user_id)
    .await
    .expect("mark all read");
  assert_eq!(marked_all, 3);
  let unread_after_all = service
    .unread_count(user_id)
    .await
    .expect("unread count after mark all");
  assert_eq!(unread_after_all, 0);

  let include_read = service
    .list_notifications(
      user_id,
      NotificationListRequest {
        first: Some(10),
        include_read: Some(true),
        ..Default::default()
      },
    )
    .await
    .expect("list include read");
  assert_eq!(include_read.total_count, 4);
  assert_eq!(include_read.edges.len(), 4);

  NotificationStore::create_notification(
    store.as_ref(),
    foreign_user_id,
    "mention".to_string(),
    "default".to_string(),
    None,
    json!({"foreign": true}),
    now,
  )
  .await
  .expect("create foreign notification");

  let mention_only = service
    .list_notifications(
      user_id,
      NotificationListRequest {
        first: Some(10),
        include_read: Some(true),
        notification_types: Some(vec!["mention".to_string(), "mention".to_string()]),
        ..Default::default()
      },
    )
    .await
    .expect("list mention filter");
  assert_eq!(mention_only.total_count, 1);
  assert_eq!(mention_only.edges.len(), 1);
  assert_eq!(mention_only.edges[0].node.id, first.notification.id);

  let multi_type = service
    .list_notifications(
      user_id,
      NotificationListRequest {
        first: Some(10),
        include_read: Some(true),
        notification_types: Some(vec!["mention".to_string(), "invitation".to_string()]),
        ..Default::default()
      },
    )
    .await
    .expect("list multi-type filter");
  assert_eq!(multi_type.total_count, 2);
  assert_eq!(multi_type.edges.len(), 2);

  let dedupe_key = format!("mention:{}:{}:{}", user_id, "doc-1", "comment-1");
  let idempotent_first = NotificationStore::create_notification(
    store.as_ref(),
    user_id,
    "mention".to_string(),
    "default".to_string(),
    Some(dedupe_key.clone()),
    json!({"docId":"doc-1","commentId":"comment-1"}),
    now + Duration::seconds(3),
  )
  .await
  .expect("create idempotent notification");
  let idempotent_second = NotificationStore::create_notification(
    store.as_ref(),
    user_id,
    "mention".to_string(),
    "default".to_string(),
    Some(dedupe_key),
    json!({"docId":"doc-1","commentId":"comment-1","duplicate":true}),
    now + Duration::seconds(4),
  )
  .await
  .expect("replay idempotent notification");
  assert_eq!(idempotent_first.notification.id, idempotent_second.notification.id);

  let include_read_after_dedupe = service
    .list_notifications(
      user_id,
      NotificationListRequest {
        first: Some(20),
        include_read: Some(true),
        ..Default::default()
      },
    )
    .await
    .expect("list include read after dedupe");
  assert_eq!(include_read_after_dedupe.total_count, 5);

  sqlx::query("DELETE FROM users WHERE id = ANY($1)")
    .bind(vec![user_id, foreign_user_id])
    .execute(&pool)
    .await
    .expect("clean notification test users");
}
