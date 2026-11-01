//! P73-C integration tests: doc view tracking (write-side).
//!
//! Tests exercise `record_doc_view` and `upsert_member_last_access` at the
//! SqlxDocStore level (DB round-trip), plus GraphQL query integration for
//! SharedLinkType view counts.

use crate::helpers::{cleanup_users, create_doc, create_user, create_workspace, setup_pool};
use myoxus_application::doc::DocViewStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use sqlx::Row;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// P73-C-04a: record_doc_view UPSERT increments daily counters correctly
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p73c_record_doc_view_increments_daily_counters() {
  let pool = setup_pool().await;
  let store: Arc<SqlxDocStore> = Arc::new(SqlxDocStore::new(pool.clone()));
  let user_id = create_user(&pool, "view_a", false).await;
  let ws_id = create_workspace(&pool, user_id).await;
  let doc_id = create_doc(&pool, ws_id, user_id).await;
  let doc_id_str = doc_id.to_string();

  // First view: not unique, not guest → total=1, unique=0, guest=0
  store
    .record_doc_view(ws_id, &doc_id_str, false, false)
    .await
    .expect("first view record must succeed");

  let row = sqlx::query(
    "SELECT total_views, unique_views, guest_views FROM workspace_doc_view_daily WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(ws_id)
  .bind(&doc_id_str)
  .fetch_one(&pool)
  .await
  .expect("daily view row must exist after first view");
  assert_eq!(row.get::<i64, _>("total_views"), 1);
  assert_eq!(row.get::<i64, _>("unique_views"), 0);
  assert_eq!(row.get::<i64, _>("guest_views"), 0);

  // Second view (same day) → total=2, unique still 0
  store
    .record_doc_view(ws_id, &doc_id_str, false, false)
    .await
    .expect("second view record must succeed");
  let row = sqlx::query(
    "SELECT total_views, unique_views FROM workspace_doc_view_daily WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(ws_id)
  .bind(&doc_id_str)
  .fetch_one(&pool)
  .await
  .expect("daily view row must exist after second view");
  assert_eq!(row.get::<i64, _>("total_views"), 2);
  assert_eq!(row.get::<i64, _>("unique_views"), 0);

  cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// P73-C-04b: unique flag increments unique_views
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p73c_record_doc_view_unique_increments_unique_views() {
  let pool = setup_pool().await;
  let store: Arc<SqlxDocStore> = Arc::new(SqlxDocStore::new(pool.clone()));
  let user_id = create_user(&pool, "view_b", false).await;
  let ws_id = create_workspace(&pool, user_id).await;
  let doc_id = create_doc(&pool, ws_id, user_id).await;
  let doc_id_str = doc_id.to_string();

  store
    .record_doc_view(ws_id, &doc_id_str, true, false)
    .await
    .expect("unique view record must succeed");

  let row = sqlx::query(
    "SELECT total_views, unique_views, guest_views FROM workspace_doc_view_daily WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(ws_id)
  .bind(&doc_id_str)
  .fetch_one(&pool)
  .await
  .expect("daily view row must exist after unique view");
  assert_eq!(row.get::<i64, _>("total_views"), 1);
  assert_eq!(row.get::<i64, _>("unique_views"), 1);
  assert_eq!(row.get::<i64, _>("guest_views"), 0);

  cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// P73-C-04c: guest flag increments guest_views
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p73c_record_doc_view_guest_increments_guest_views() {
  let pool = setup_pool().await;
  let store: Arc<SqlxDocStore> = Arc::new(SqlxDocStore::new(pool.clone()));
  let user_id = create_user(&pool, "view_c", false).await;
  let ws_id = create_workspace(&pool, user_id).await;
  let doc_id = create_doc(&pool, ws_id, user_id).await;
  let doc_id_str = doc_id.to_string();

  store
    .record_doc_view(ws_id, &doc_id_str, false, true)
    .await
    .expect("guest view record must succeed");

  let row = sqlx::query(
    "SELECT total_views, unique_views, guest_views FROM workspace_doc_view_daily WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(ws_id)
  .bind(&doc_id_str)
  .fetch_one(&pool)
  .await
  .expect("daily view row must exist after guest view");
  assert_eq!(row.get::<i64, _>("total_views"), 1);
  assert_eq!(row.get::<i64, _>("unique_views"), 0);
  assert_eq!(row.get::<i64, _>("guest_views"), 1);

  cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// P73-C-04d: upsert_member_last_access tracks doc + timestamp
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p73c_upsert_member_last_access_updates_doc_and_timestamp() {
  let pool = setup_pool().await;
  let store: Arc<SqlxDocStore> = Arc::new(SqlxDocStore::new(pool.clone()));
  let user_id = create_user(&pool, "view_d", false).await;
  let ws_id = create_workspace(&pool, user_id).await;
  let doc1 = create_doc(&pool, ws_id, user_id).await;
  let doc2 = create_doc(&pool, ws_id, user_id).await;

  // First access: doc1
  store
    .upsert_member_last_access(ws_id, user_id, &doc1.to_string())
    .await
    .expect("first member last access upsert must succeed");

  let row = sqlx::query(
    "SELECT last_doc_id, last_accessed_at FROM workspace_member_last_access WHERE workspace_id = $1 AND user_id = $2",
  )
  .bind(ws_id)
  .bind(user_id)
  .fetch_one(&pool)
  .await
  .expect("member last access row must exist after first upsert");
  assert_eq!(row.get::<String, _>("last_doc_id"), doc1.to_string());
  let ts1: chrono::DateTime<chrono::Utc> = row.get("last_accessed_at");

  // Second access: doc2 — should update doc_id and timestamp
  store
    .upsert_member_last_access(ws_id, user_id, &doc2.to_string())
    .await
    .expect("second member last access upsert must succeed");

  let row = sqlx::query(
    "SELECT last_doc_id, last_accessed_at FROM workspace_member_last_access WHERE workspace_id = $1 AND user_id = $2",
  )
  .bind(ws_id)
  .bind(user_id)
  .fetch_one(&pool)
  .await
  .expect("member last access row must exist after second upsert");
  assert_eq!(row.get::<String, _>("last_doc_id"), doc2.to_string());
  let ts2: chrono::DateTime<chrono::Utc> = row.get("last_accessed_at");
  assert!(ts2 >= ts1, "timestamp must advance on second access");

  cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// P73-C-04e: combined unique+guest in single call
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_p73c_record_doc_view_unique_and_guest_combined() {
  let pool = setup_pool().await;
  let store: Arc<SqlxDocStore> = Arc::new(SqlxDocStore::new(pool.clone()));
  let user_id = create_user(&pool, "view_e", false).await;
  let ws_id = create_workspace(&pool, user_id).await;
  let doc_id = create_doc(&pool, ws_id, user_id).await;
  let doc_id_str = doc_id.to_string();

  store
    .record_doc_view(ws_id, &doc_id_str, true, true)
    .await
    .expect("combined unique+guest view record must succeed");

  let row = sqlx::query(
    "SELECT total_views, unique_views, guest_views FROM workspace_doc_view_daily WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(ws_id)
  .bind(&doc_id_str)
  .fetch_one(&pool)
  .await
  .expect("daily view row must exist after combined unique+guest view");
  assert_eq!(row.get::<i64, _>("total_views"), 1);
  assert_eq!(row.get::<i64, _>("unique_views"), 1);
  assert_eq!(row.get::<i64, _>("guest_views"), 1);

  cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// P73-C-04f: top_shared_links sorted by total_views descending
// ---------------------------------------------------------------------------

/// Seed helper: set a doc as publicly shared.
async fn set_doc_public(pool: &sqlx::PgPool, doc_id: uuid::Uuid) {
  sqlx::query("UPDATE docs SET public_mode = 'page' WHERE id = $1")
    .bind(doc_id)
    .execute(pool)
    .await
    .expect("set doc public");
}

/// Seed helper: insert a daily view row for a doc.
async fn insert_views(pool: &sqlx::PgPool, ws: uuid::Uuid, doc: &str, views: i64) {
  sqlx::query(
    r#"INSERT INTO workspace_doc_view_daily
       (workspace_id, doc_id, date, total_views, unique_views, guest_views, last_accessed_at)
       VALUES ($1, $2, CURRENT_DATE, $3, 0, 0, now())"#,
  )
  .bind(ws)
  .bind(doc)
  .bind(views)
  .execute(pool)
  .await
  .expect("insert views");
}

#[tokio::test]
async fn inv_p73c_top_shared_links_sorted_by_views() {
  let pool = setup_pool().await;
  let user_id = create_user(&pool, "tsl_f", false).await;
  let ws_id = create_workspace(&pool, user_id).await;
  let doc_lo = create_doc(&pool, ws_id, user_id).await;
  let doc_hi = create_doc(&pool, ws_id, user_id).await;
  let lo_str = doc_lo.to_string();
  let hi_str = doc_hi.to_string();

  set_doc_public(&pool, doc_lo).await;
  set_doc_public(&pool, doc_hi).await;
  insert_views(&pool, ws_id, &lo_str, 5).await;
  insert_views(&pool, ws_id, &hi_str, 42).await;

  let rows = query_top_shared_links(&pool).await;
  let ids: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();

  let pos_hi = ids
    .iter()
    .position(|d| *d == hi_str)
    .expect("high-view doc must appear");
  let pos_lo = ids.iter().position(|d| *d == lo_str).expect("low-view doc must appear");
  assert!(pos_hi < pos_lo, "doc with 42 views must rank above doc with 5 views");

  cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_p73c_top_shared_links_excludes_non_public() {
  let pool = setup_pool().await;
  let user_id = create_user(&pool, "tsl_excl", false).await;
  let ws_id = create_workspace(&pool, user_id).await;
  let doc_pub = create_doc(&pool, ws_id, user_id).await;
  let doc_priv = create_doc(&pool, ws_id, user_id).await;
  let pub_str = doc_pub.to_string();
  let priv_str = doc_priv.to_string();

  set_doc_public(&pool, doc_pub).await;
  // doc_priv stays private (public_mode IS NULL)
  insert_views(&pool, ws_id, &pub_str, 10).await;
  insert_views(&pool, ws_id, &priv_str, 99).await;

  let rows = query_top_shared_links(&pool).await;
  let ids: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();

  assert!(ids.iter().any(|d| *d == pub_str), "public doc must appear");
  assert!(!ids.iter().any(|d| *d == priv_str), "private doc must NOT appear");

  cleanup_users(&pool, &[user_id]).await;
}

/// Run the same SQL the `admin_dashboard` resolver uses for top_shared_links.
/// Returns vec of `(doc_id, total_views)`.
async fn query_top_shared_links(pool: &sqlx::PgPool) -> Vec<(String, i64)> {
  sqlx::query(
    r#"
    SELECT d.id::text AS doc_id,
           COALESCE(v.total_views, 0) AS total_views
    FROM docs d
    LEFT JOIN LATERAL (
      SELECT SUM(total_views)::bigint AS total_views
      FROM workspace_doc_view_daily wdvd
      WHERE wdvd.workspace_id = d.workspace_id
        AND wdvd.doc_id = d.id::text
        AND wdvd.date >= CURRENT_DATE - INTERVAL '28 days'
    ) v ON true
    WHERE d.public_mode IS NOT NULL
      AND d.deleted_at IS NULL
    ORDER BY COALESCE(v.total_views, 0) DESC, d.updated_at DESC
    LIMIT 20
    "#,
  )
  .fetch_all(pool)
  .await
  .expect("top_shared_links query")
  .iter()
  .map(|r| {
    use sqlx::Row;
    (r.get::<String, _>("doc_id"), r.get::<i64, _>("total_views"))
  })
  .collect()
}
