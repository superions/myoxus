//! Dashboard invariant tests (BF-SRV-02j, BF-SRV-02k).
//!
//! Verify that the adminDashboard query returns correct, consistent data
//! when workspace storage stats exist. Each test asserts a specific invariant
//! about the dashboard response shape and data accuracy.
//!
//! BF-SRV-02k: Input validation for storageHistoryDays / syncHistoryHours
//! clamping (server clamps to [1, 365] for days and [1, 168] for hours).

use crate::helpers;

use chrono::{DateTime, Timelike, Utc};
use myoxus_application::admin::AdminStore;
use myoxus_infrastructure::admin::SqlxAdminStore;
use serde_json::json;

/// INV-DASH-01: adminDashboard must return generatedAt as a non-null string.
#[tokio::test]
async fn inv_dash01_dashboard_returns_generated_at() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": "{ admin { adminDashboard { generatedAt } } }"}),
  )
  .await;

  assert!(
    resp["data"]["admin"]["adminDashboard"]["generatedAt"].is_string(),
    "generatedAt must be a string, got: {resp}"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-DASH-02: Storage bytes fields must be non-negative integers.
#[tokio::test]
async fn inv_dash02_storage_bytes_are_non_negative() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": "{ admin { adminDashboard { workspaceStorageBytes blobStorageBytes } } }"}),
  )
  .await;

  let dash = &resp["data"]["admin"]["adminDashboard"];
  let ws_bytes = dash["workspaceStorageBytes"]
    .as_i64()
    .expect("workspaceStorageBytes must be int");
  let blob_bytes = dash["blobStorageBytes"].as_i64().expect("blobStorageBytes must be int");
  assert!(ws_bytes >= 0, "workspaceStorageBytes must be >= 0, got {ws_bytes}");
  assert!(blob_bytes >= 0, "blobStorageBytes must be >= 0, got {blob_bytes}");

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-DASH-03: the Admin consumer reads replaced minute samples, including
/// zero, and expired Redis observations cannot resurrect hard-deleted workspaces.
#[sqlx::test(migrations = false)]
async fn inv_dash03_sync_active_users_non_negative(pool: sqlx::PgPool) {
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("owned dashboard database migrations");
  let (app, pool, auth) = helpers::setup_app_with_pool(pool).await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;
  let store = SqlxAdminStore::new(pool.clone());
  let minute = Utc::now().with_second(0).unwrap().with_nanosecond(0).unwrap();
  for count in [2, 1, 0] {
    store
      .upsert_active_users_metric(workspace_id, minute, count)
      .await
      .expect("owned global sample");
    let resp = helpers::gql(&app, session_id,
      json!({"query": "{ admin { adminDashboard { syncActiveUsers syncActiveUsersTimeline { minute activeUsers } } } }"})
    ).await;
    assert!(resp["errors"].is_null(), "Admin projection errors: {resp}");
    assert_eq!(resp["data"]["admin"]["adminDashboard"]["syncActiveUsers"], count);
    let samples = resp["data"]["admin"]["adminDashboard"]["syncActiveUsersTimeline"]
      .as_array()
      .expect("timeline");
    assert!(samples.iter().any(|sample| {
      sample["activeUsers"] == count
        && DateTime::parse_from_rfc3339(sample["minute"].as_str().expect("minute"))
          .expect("timestamp")
          .with_timezone(&Utc)
          == minute
    }));
  }
  store.delete_workspace(workspace_id).await.expect("owned hard delete");
  for count in [0, 2] {
    store
      .upsert_active_users_metric(workspace_id, minute, count)
      .await
      .expect("deleted workspace has no metric sample");
  }
  let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_analytics_minute WHERE workspace_id = $1")
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("orphan metric count");
  assert_eq!(remaining, 0);
  // SQLx drops the complete owned database, including startup/admin fixtures.
}

/// INV-DASH-04: storageWindow must contain from and to fields.
#[tokio::test]
async fn inv_dash04_storage_window_has_from_and_to() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": "{ admin { adminDashboard { storageWindow { from to } syncWindow { from to } } } }"}),
  )
  .await;

  let dash = &resp["data"]["admin"]["adminDashboard"];
  assert!(
    dash["storageWindow"]["from"].is_string(),
    "storageWindow.from must be a string"
  );
  assert!(
    dash["storageWindow"]["to"].is_string(),
    "storageWindow.to must be a string"
  );
  assert!(
    dash["syncWindow"]["from"].is_string(),
    "syncWindow.from must be a string"
  );
  assert!(dash["syncWindow"]["to"].is_string(), "syncWindow.to must be a string");

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-DASH-05: With test data inserted, workspaceStorageHistory must not be empty.
#[test]
fn inv_dash05_storage_history_non_empty_with_data() {
  helpers::block_on_large_stack("inv_dash05_storage_history_non_empty_with_data", || async {
    let (app, pool, auth) = helpers::setup_app().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;
    let ws_id = helpers::create_workspace(&pool, admin_id).await;

    // Insert test data into materialized stats tables
    sqlx::query(
      "INSERT INTO workspace_storage_stats (workspace_id, snapshot_size, blob_size) VALUES ($1, 2048, 1024)
         ON CONFLICT (workspace_id) DO UPDATE SET snapshot_size = 2048, blob_size = 1024",
    )
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("insert workspace_storage_stats");
    sqlx::query(
        "INSERT INTO workspace_storage_stats_daily (workspace_id, day, snapshot_size, blob_size) VALUES ($1, CURRENT_DATE, 2048, 1024)
         ON CONFLICT (workspace_id, day) DO UPDATE SET snapshot_size = 2048, blob_size = 1024",
    )
    .bind(ws_id)
    .execute(&pool)
    .await
    .expect("insert workspace_storage_stats_daily");

    let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": "{ admin { adminDashboard { workspaceStorageHistory { date value } blobStorageHistory { date value } } } }"}),
  )
  .await;

    let dash = &resp["data"]["admin"]["adminDashboard"];
    let ws_hist = dash["workspaceStorageHistory"]
      .as_array()
      .expect("workspaceStorageHistory array");
    let blob_hist = dash["blobStorageHistory"].as_array().expect("blobStorageHistory array");
    assert!(
      !ws_hist.is_empty(),
      "workspaceStorageHistory must not be empty when stats data exists"
    );
    assert!(
      !blob_hist.is_empty(),
      "blobStorageHistory must not be empty when stats data exists"
    );

    // Cleanup
    sqlx::query("DELETE FROM workspace_storage_stats_daily WHERE workspace_id = $1")
      .bind(ws_id)
      .execute(&pool)
      .await
      .ok();
    sqlx::query("DELETE FROM workspace_storage_stats WHERE workspace_id = $1")
      .bind(ws_id)
      .execute(&pool)
      .await
      .ok();
    sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
      .bind(ws_id)
      .execute(&pool)
      .await
      .ok();
    sqlx::query("DELETE FROM workspaces WHERE id = $1")
      .bind(ws_id)
      .execute(&pool)
      .await
      .ok();
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

/// INV-DASH-06: copilotConversations must be a non-negative integer.
#[tokio::test]
async fn inv_dash06_copilot_conversations_non_negative() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": "{ admin { adminDashboard { copilotConversations } } }"}),
  )
  .await;

  let count = resp["data"]["admin"]["adminDashboard"]["copilotConversations"]
    .as_i64()
    .expect("copilotConversations must be int");
  assert!(count >= 0, "copilotConversations must be >= 0, got {count}");

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-DASH-07: syncActiveUsersTimeline must be an array (possibly empty).
#[test]
fn inv_dash07_sync_timeline_is_array() {
  helpers::block_on_large_stack("inv_dash07_sync_timeline_is_array", || async {
    let (app, pool, auth) = helpers::setup_app().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;

    let resp = helpers::gql(
      &app,
      session_id,
      json!({"query": "{ admin { adminDashboard { syncActiveUsersTimeline { minute activeUsers } } } }"}),
    )
    .await;

    assert!(
      resp["data"]["admin"]["adminDashboard"]["syncActiveUsersTimeline"].is_array(),
      "syncActiveUsersTimeline must be an array, got: {resp}"
    );

    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

// ---------------------------------------------------------------------------
// BF-SRV-02k: Input validation for storageHistoryDays / syncHistoryHours
// ---------------------------------------------------------------------------

const WINDOW_QUERY: &str = r#"
  query($input: AdminDashboardInput) {
    admin {
      adminDashboard(input: $input) {
        storageWindow { from to effectiveSize }
        syncWindow { from to effectiveSize }
      }
    }
  }
"#;

fn parse_dt(v: &serde_json::Value, field: &str) -> DateTime<Utc> {
  v[field]
    .as_str()
    .expect("datetime field is string")
    .parse::<DateTime<Utc>>()
    .expect("parse datetime")
}

/// INV-DASH-08: Without input, storageWindow defaults to ~30 days, syncWindow to ~30 hours.
#[tokio::test]
async fn inv_dash_default_window_values() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  let resp = helpers::gql(&app, session_id, json!({"query": WINDOW_QUERY})).await;
  let dash = &resp["data"]["admin"]["adminDashboard"];

  let sw = &dash["storageWindow"];
  assert!(parse_dt(sw, "to") > parse_dt(sw, "from"), "storageWindow.to > from");
  assert_eq!(
    sw["effectiveSize"].as_i64().expect("effectiveSize int"),
    30,
    "default storage days = 30"
  );

  let syn = &dash["syncWindow"];
  assert!(parse_dt(syn, "to") > parse_dt(syn, "from"), "syncWindow.to > from");
  assert_eq!(
    syn["effectiveSize"].as_i64().expect("syncWindow effectiveSize int"),
    30 * 60,
    "default sync = 30h in minutes"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-DASH-09: storageHistoryDays=7 produces a 7-day window.
#[tokio::test]
async fn inv_dash_custom_storage_days() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  let resp = helpers::gql(
    &app,
    session_id,
    helpers::gql_query_vars(WINDOW_QUERY, json!({"input": {"storageHistoryDays": 7}})),
  )
  .await;

  let sw = &resp["data"]["admin"]["adminDashboard"]["storageWindow"];
  assert_eq!(
    sw["effectiveSize"].as_i64().expect("storageWindow effectiveSize int"),
    7,
    "effectiveSize must be 7"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-DASH-10: storageHistoryDays=0 is clamped to 1 (server uses .max(1)).
#[tokio::test]
async fn inv_dash_zero_days_clamped_to_one() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  let resp = helpers::gql(
    &app,
    session_id,
    helpers::gql_query_vars(WINDOW_QUERY, json!({"input": {"storageHistoryDays": 0}})),
  )
  .await;

  let sw = &resp["data"]["admin"]["adminDashboard"]["storageWindow"];
  assert_eq!(
    sw["effectiveSize"].as_i64().expect("storageWindow effectiveSize int"),
    1,
    "0 days clamped to 1"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

/// INV-DASH-11: storageHistoryDays=999 is clamped to 365 (server uses .min(365)).
#[tokio::test]
async fn inv_dash_excessive_days_capped() {
  let (app, pool, auth) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth).await;

  let resp = helpers::gql(
    &app,
    session_id,
    helpers::gql_query_vars(WINDOW_QUERY, json!({"input": {"storageHistoryDays": 999}})),
  )
  .await;

  let sw = &resp["data"]["admin"]["adminDashboard"]["storageWindow"];
  assert_eq!(
    sw["effectiveSize"].as_i64().expect("storageWindow effectiveSize int"),
    365,
    "999 days clamped to 365"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}
