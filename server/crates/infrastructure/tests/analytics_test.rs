use chrono::{Timelike, Utc};
use myoxus_application::admin::AdminStore;
use myoxus_infrastructure::admin::SqlxAdminStore;
use sqlx::PgPool;

#[sqlx::test(migrations = false)]
async fn test_active_users_analytics_persistence(pool: PgPool) {
  myoxus_infrastructure::migrations::run(&pool).await.unwrap();
  let admin_store = SqlxAdminStore::new(pool.clone());

  let minute = Utc::now().with_second(0).unwrap().with_nanosecond(0).unwrap();
  for (at, count) in [(minute - chrono::Duration::minutes(1), 8), (minute, 5), (minute, 2)] {
    admin_store.upsert_active_users_metric(at, count).await.unwrap();
  }
  let projection = admin_store.dashboard_projection(1, 1).await.unwrap();
  assert_eq!(projection.sync_active_users, 2);
  assert_eq!(projection.sync_active_users_timeline.len(), 2);
}
