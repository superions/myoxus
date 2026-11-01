//! Integration tests for the analytics event repository (store and query events).
use chrono::{Timelike, Utc};
use myoxus_application::admin::AdminStore;
use myoxus_infrastructure::admin::SqlxAdminStore;
use sqlx::PgPool;
use uuid::Uuid;

async fn setup_db() -> PgPool {
  let database_url =
    std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://myoxus:myoxus@localhost:5432/myoxus".to_string());
  let pool = PgPool::connect(&database_url)
    .await
    .expect("Failed to connect to database");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("Failed to run migrations");
  pool
}

#[tokio::test]
async fn test_active_users_analytics_persistence() {
  let pool = setup_db().await;
  let admin_store = SqlxAdminStore::new(pool.clone());

  let workspace_id = Uuid::new_v4();
  // 1. Create Workspace first (foreign key)
  let owner_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Owner')")
    .bind(owner_id)
    .bind(format!("owner{}@ex.com", workspace_id))
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, 'WS')")
    .bind(workspace_id)
    .bind(owner_id)
    .execute(&pool)
    .await
    .unwrap();

  let now = Utc::now().with_second(0).unwrap().with_nanosecond(0).unwrap();

  // 2. Upsert metric
  admin_store
    .upsert_active_users_metric(workspace_id, now, 5)
    .await
    .unwrap();

  // 3. Verify
  let count: i32 = sqlx::query_scalar(
    "SELECT active_users FROM workspace_analytics_minute WHERE workspace_id = $1 AND bucket_at = $2",
  )
  .bind(workspace_id)
  .bind(now)
  .fetch_one(&pool)
  .await
  .unwrap();

  assert_eq!(count, 5);

  // 4. Update (Conflict test)
  admin_store
    .upsert_active_users_metric(workspace_id, now, 10)
    .await
    .unwrap();

  let updated_count: i32 = sqlx::query_scalar(
    "SELECT active_users FROM workspace_analytics_minute WHERE workspace_id = $1 AND bucket_at = $2",
  )
  .bind(workspace_id)
  .bind(now)
  .fetch_one(&pool)
  .await
  .unwrap();

  assert_eq!(updated_count, 10);
}
