//! Admin workspace and i18n config tests — DB-backed REST + GraphQL coverage.
//!
//! Covers: adminUpdateWorkspace mutation (field persistence), i18n config PUT
//! (admin-gated, DB-persisted, GET read-back), and locale validation rejection.

use crate::helpers;

use axum::{body::Body, http::Request};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::Row;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn admin_update_workspace_mutation_is_db_backed() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session_id) = helpers::seed_admin(&pool, &auth_store).await;

  let workspace_id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO workspaces (id, owner_user_id, name, public, enable_ai, enable_sharing, enable_url_preview, enable_doc_embedding)
       VALUES ($1, $2, $3, FALSE, FALSE, TRUE, TRUE, TRUE)"#,
  )
  .bind(workspace_id)
  .bind(admin_id)
  .bind("Before Update")
  .execute(&pool)
  .await
  .expect("insert workspace");

  let resp = helpers::gql(
    &app,
    admin_session_id,
    json!({"query": format!(
      "mutation {{ admin {{ adminUpdateWorkspace(input:{{id:\"{workspace_id}\",name:\"After Update\",public:true,enableAi:true,enableSharing:false,enableUrlPreview:false,enableDocEmbedding:false}}) {{ id name public enableAi enableSharing enableUrlPreview enableDocEmbedding owner {{ id email }} }} }} }}"
    )}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "adminUpdateWorkspace failed: {resp}");
  assert_eq!(resp["data"]["admin"]["adminUpdateWorkspace"]["name"], "After Update");
  assert_eq!(resp["data"]["admin"]["adminUpdateWorkspace"]["public"], true);
  assert_eq!(resp["data"]["admin"]["adminUpdateWorkspace"]["enableAi"], true);
  assert_eq!(resp["data"]["admin"]["adminUpdateWorkspace"]["enableSharing"], false);
  assert_eq!(resp["data"]["admin"]["adminUpdateWorkspace"]["enableUrlPreview"], false);
  assert_eq!(
    resp["data"]["admin"]["adminUpdateWorkspace"]["enableDocEmbedding"],
    false
  );

  let row = sqlx::query(
    "SELECT name, public, enable_ai, enable_sharing, enable_url_preview, enable_doc_embedding FROM workspaces WHERE id = $1",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("workspace row");
  assert_eq!(row.get::<String, _>("name"), "After Update");
  assert!(row.get::<bool, _>("public"));
  assert!(row.get::<bool, _>("enable_ai"));
  assert!(!row.get::<bool, _>("enable_sharing"));
  assert!(!row.get::<bool, _>("enable_url_preview"));
  assert!(!row.get::<bool, _>("enable_doc_embedding"));

  // Cleanup
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn workspace_feature_mutations_reject_plan_and_quota_enums() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let workspace_id = helpers::create_workspace(&pool, admin_id).await;

  sqlx::query(
    r#"
      UPDATE workspaces
      SET enable_ai = FALSE,
          enable_sharing = FALSE,
          enable_url_preview = FALSE,
          enable_doc_embedding = FALSE
      WHERE id = $1
    "#,
  )
  .bind(workspace_id)
  .execute(&pool)
  .await
  .expect("reset workspace capability flags");

  for feature in [
    "FreePlan",
    "LifetimeProPlan",
    "ProPlan",
    "TeamPlan",
    "UnlimitedWorkspace",
  ] {
    let resp = helpers::gql(
      &app,
      admin_session_id,
      json!({"query": format!(
        "mutation {{ admin {{ addWorkspaceFeature(workspaceId:\"{workspace_id}\", feature:{feature}) }} }}"
      )}),
    )
    .await;
    let message = resp["errors"]
      .as_array()
      .and_then(|errors| errors.first())
      .and_then(|error| error["message"].as_str())
      .unwrap_or("");
    assert!(
      message.contains("unsupported workspace feature capability"),
      "plan/quota feature {feature} must fail closed, response: {resp}"
    );
  }

  let remove_resp = helpers::gql(
    &app,
    admin_session_id,
    json!({"query": format!(
      "mutation {{ admin {{ removeWorkspaceFeature(workspaceId:\"{workspace_id}\", feature:UnlimitedWorkspace) }} }}"
    )}),
  )
  .await;
  let remove_message = remove_resp["errors"]
    .as_array()
    .and_then(|errors| errors.first())
    .and_then(|error| error["message"].as_str())
    .unwrap_or("");
  assert!(
    remove_message.contains("unsupported workspace feature capability"),
    "removeWorkspaceFeature must also fail closed for plan/quota enums: {remove_resp}"
  );

  let row = sqlx::query(
    "SELECT enable_ai, enable_sharing, enable_url_preview, enable_doc_embedding FROM workspaces WHERE id = $1",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("workspace flags after rejected mutations");
  assert!(!row.get::<bool, _>("enable_ai"));
  assert!(!row.get::<bool, _>("enable_sharing"));
  assert!(!row.get::<bool, _>("enable_url_preview"));
  assert!(!row.get::<bool, _>("enable_doc_embedding"));

  let ai_resp = helpers::gql(
    &app,
    admin_session_id,
    json!({"query": format!(
      "mutation {{ admin {{ addWorkspaceFeature(workspaceId:\"{workspace_id}\", feature:UnlimitedCopilot) }} }}"
    )}),
  )
  .await;
  assert!(
    ai_resp.get("errors").is_none(),
    "workspace-scoped AI capability should still be mutable: {ai_resp}"
  );
  assert_eq!(ai_resp["data"]["admin"]["addWorkspaceFeature"].as_bool(), Some(true));

  let row = sqlx::query(
    "SELECT enable_ai, enable_sharing, enable_url_preview, enable_doc_embedding FROM workspaces WHERE id = $1",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("workspace flags after AI mutation");
  assert!(row.get::<bool, _>("enable_ai"));
  assert!(!row.get::<bool, _>("enable_sharing"));
  assert!(!row.get::<bool, _>("enable_url_preview"));
  assert!(!row.get::<bool, _>("enable_doc_embedding"));

  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[test]
fn admin_workspace_shared_links_use_canonical_public_contract() {
  helpers::block_on_large_stack("admin_workspace_shared_links_use_canonical_public_contract", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, admin_session_id) = helpers::seed_admin(&pool, &auth_store).await;
    let workspace_id = helpers::create_workspace(&pool, admin_id).await;
    let doc_id = helpers::create_doc(&pool, workspace_id, admin_id).await;

    sqlx::query(
      r#"
          UPDATE docs
          SET title = 'Published Admin Link',
              public_mode = 'Edgeless',
              updated_at = now()
          WHERE workspace_id = $1 AND id = $2
        "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("publish fixture doc");

    let resp = helpers::gql(
      &app,
      admin_session_id,
      json!({"query": format!(
        r#"
            query {{
              admin {{
                adminWorkspace(id: "{workspace_id}") {{
                  sharedLinks {{
                    workspaceId
                    docId
                    title
                    publicMode
                    status
                    shareUrl
                    publishedAt
                  }}
                }}
              }}
            }}
          "#
      )}),
    )
    .await;
    assert!(
      resp.get("errors").is_none(),
      "adminWorkspace sharedLinks failed: {resp}"
    );
    let links = resp["data"]["admin"]["adminWorkspace"]["sharedLinks"]
      .as_array()
      .expect("sharedLinks array");
    let doc_id_string = doc_id.to_string();
    let link = links
      .iter()
      .find(|link| link["docId"].as_str() == Some(doc_id_string.as_str()))
      .expect("published doc link");

    assert_eq!(link["workspaceId"], workspace_id.to_string());
    assert_eq!(link["title"], "Published Admin Link");
    assert_eq!(link["publicMode"], "Edgeless");
    assert_eq!(link["status"], "active");
    let share_url = link["shareUrl"].as_str().expect("shareUrl string");
    assert!(
      share_url.starts_with("http://") || share_url.starts_with("https://"),
      "shareUrl must be an absolute public URL: {share_url}"
    );
    assert!(
      share_url.ends_with(&format!("/public/{workspace_id}/{doc_id}")),
      "shareUrl must use the canonical public route: {share_url}"
    );
    assert!(link["publishedAt"].as_str().is_some());

    helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[tokio::test]
async fn i18n_config_put_is_admin_gated_and_db_backed() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let original_i18n_configs: Vec<(String, Value)> =
    sqlx::query_as("SELECT id, value FROM app_configs WHERE id IN ('i18n.default_locale', 'i18n.available_locales')")
      .fetch_all(&pool)
      .await
      .expect("snapshot canonical i18n config rows");

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("PUT")
        .uri("/api/i18n/config")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={admin_session_id}"))
        .body(Body::from(r#"{"defaultLocale":"de","availableLocales":["en","de"]}"#))
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("json");
  assert_eq!(json["defaultLocale"], "de");
  assert_eq!(
    json["availableLocales"]
      .as_array()
      .and_then(|a| a.first())
      .and_then(|v| v.as_str()),
    Some("en")
  );

  let row = sqlx::query("SELECT value FROM app_configs WHERE id = $1")
    .bind("i18n.default_locale")
    .fetch_one(&pool)
    .await
    .expect("default locale row");
  let value: Value = row.get("value");
  assert_eq!(value, Value::String("de".to_string()));

  let response = app
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/api/i18n/config")
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("json");
  assert_eq!(json["defaultLocale"], "de");
  assert_eq!(json["availableLocales"], serde_json::json!(["en", "de"]));

  let mut cleanup = pool.begin().await.expect("begin i18n config cleanup");
  sqlx::query("DELETE FROM app_configs WHERE id IN ('i18n.default_locale', 'i18n.available_locales')")
    .execute(&mut *cleanup)
    .await
    .expect("remove test i18n config rows");
  for (id, value) in original_i18n_configs {
    sqlx::query("INSERT INTO app_configs (id, value) VALUES ($1, $2)")
      .bind(id)
      .bind(value)
      .execute(&mut *cleanup)
      .await
      .expect("restore canonical i18n config row");
  }
  cleanup.commit().await.expect("commit i18n config cleanup");
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn i18n_config_put_rejects_unsupported_locale() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session_id) = helpers::seed_admin(&pool, &auth_store).await;

  let response = app
    .oneshot(
      Request::builder()
        .method("PUT")
        .uri("/api/i18n/config")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={admin_session_id}"))
        .body(Body::from(
          r#"{"defaultLocale":"xx-TEST","availableLocales":["en","xx-TEST"]}"#,
        ))
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(response.status(), 400);

  // Cleanup
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[test]
fn admin_workspaces_git_sync_filters_and_fields_are_db_backed() {
  helpers::block_on_large_stack("admin_workspaces_git_sync_filters_and_fields_are_db_backed", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, admin_session_id) = helpers::seed_admin(&pool, &auth_store).await;

    let marker = format!("git-sync-filter-{}", Uuid::new_v4());
    let ws_with_sync = helpers::create_workspace(&pool, admin_id).await;
    let ws_without_sync = helpers::create_workspace(&pool, admin_id).await;
    sqlx::query("UPDATE workspaces SET name = $2 WHERE id = $1")
      .bind(ws_with_sync)
      .bind(format!("{marker}-with"))
      .execute(&pool)
      .await
      .expect("name update (with)");
    sqlx::query("UPDATE workspaces SET name = $2 WHERE id = $1")
      .bind(ws_without_sync)
      .bind(format!("{marker}-without"))
      .execute(&pool)
      .await
      .expect("name update (without)");

    let profile_id = Uuid::new_v4();
    let next_scheduled_at = Utc::now() + chrono::Duration::hours(1);
    sqlx::query(
      r#"INSERT INTO git_sync_profiles
       (id, workspace_id, owner_id, repo_url, branch, root_path, sync_direction,
        trigger_mode, cron_expression, cron_timezone, cron_misfire_policy,
        cron_next_scheduled_at, auth_method, enabled)
       VALUES ($1, $2, $3, $4, 'main', 'content/', 'Bidirectional', 'Cron',
               '0 * * * *', 'UTC', 'Skip', $5, 'HttpsToken', TRUE)"#,
    )
    .bind(profile_id)
    .bind(ws_with_sync)
    .bind(admin_id)
    .bind("https://localhost/acme/admin-filter-repo.git")
    .bind(next_scheduled_at)
    .execute(&pool)
    .await
    .expect("insert git sync profile");

    sqlx::query(
      r#"INSERT INTO git_sync_runs
       (id, profile_id, direction, status, started_at, docs_created, docs_updated, docs_deleted, conflicts_found)
       VALUES ($1, $2, 'Bidirectional', 'Failed', $3, 0, 0, 0, 0)"#,
    )
    .bind(Uuid::new_v4())
    .bind(profile_id)
    .bind(Utc::now())
    .execute(&pool)
    .await
    .expect("insert git sync run");

    let with_sync = helpers::gql(
      &app,
      admin_session_id,
      helpers::gql_query_vars(
        r#"
      query AdminWorkspacesWithSync($filter: ListWorkspaceInput!) {
        admin {
          adminWorkspaces(filter: $filter) {
            id
            gitSyncEnabled
            gitSyncLastStatus
            gitSyncTriggerMode
            gitSyncNextScheduledAt
          }
        }
      }
      "#,
        json!({
          "filter": {
            "first": 20,
            "skip": 0,
            "keyword": marker,
            "gitSyncEnabled": true
          }
        }),
      ),
    )
    .await;
    assert!(
      with_sync.get("errors").is_none(),
      "adminWorkspaces(gitSyncEnabled=true) failed: {with_sync}"
    );
    let rows = with_sync["data"]["admin"]["adminWorkspaces"]
      .as_array()
      .expect("adminWorkspaces array");
    assert!(
      rows.iter().any(|row| row["id"] == ws_with_sync.to_string()),
      "workspace with git sync must be returned: {with_sync}"
    );
    assert!(
      rows.iter().all(|row| row["gitSyncEnabled"] == true),
      "gitSyncEnabled filter must only return enabled rows: {with_sync}"
    );
    assert!(
      rows.iter().any(|row| row["gitSyncLastStatus"] == "Failed"),
      "last status must be surfaced from latest run: {with_sync}"
    );
    let projected = rows
      .iter()
      .find(|row| row["id"] == ws_with_sync.to_string())
      .expect("Cron workspace projection");
    assert_eq!(projected["gitSyncTriggerMode"], "Cron");
    let projected_next_schedule = chrono::DateTime::parse_from_rfc3339(
      projected["gitSyncNextScheduledAt"]
        .as_str()
        .expect("projected next schedule"),
    )
    .unwrap()
    .with_timezone(&Utc);
    assert_eq!(
      projected_next_schedule.timestamp_micros(),
      next_scheduled_at.timestamp_micros(),
      "PostgreSQL stores timestamps at microsecond precision"
    );

    let failed_only = helpers::gql(
      &app,
      admin_session_id,
      helpers::gql_query_vars(
        r#"
      query AdminWorkspacesFailed($filter: ListWorkspaceInput!) {
        admin {
          adminWorkspaces(filter: $filter) {
            id
            gitSyncEnabled
            gitSyncLastStatus
          }
        }
      }
      "#,
        json!({
          "filter": {
            "first": 20,
            "skip": 0,
            "keyword": marker,
            "gitSyncLastStatus": "Failed"
          }
        }),
      ),
    )
    .await;
    assert!(
      failed_only.get("errors").is_none(),
      "adminWorkspaces(gitSyncLastStatus=Failed) failed: {failed_only}"
    );
    let failed_rows = failed_only["data"]["admin"]["adminWorkspaces"]
      .as_array()
      .expect("adminWorkspaces array");
    assert_eq!(failed_rows.len(), 1, "only one failed workspace expected");
    assert_eq!(failed_rows[0]["id"], ws_with_sync.to_string());
    assert_eq!(failed_rows[0]["gitSyncLastStatus"], "Failed");

    let without_sync = helpers::gql(
      &app,
      admin_session_id,
      helpers::gql_query_vars(
        r#"
      query AdminWorkspacesWithoutSync($filter: ListWorkspaceInput!) {
        admin {
          adminWorkspaces(filter: $filter) {
            id
            gitSyncEnabled
          }
        }
      }
      "#,
        json!({
          "filter": {
            "first": 20,
            "skip": 0,
            "keyword": marker,
            "gitSyncEnabled": false
          }
        }),
      ),
    )
    .await;
    assert!(
      without_sync.get("errors").is_none(),
      "adminWorkspaces(gitSyncEnabled=false) failed: {without_sync}"
    );
    let without_rows = without_sync["data"]["admin"]["adminWorkspaces"]
      .as_array()
      .expect("adminWorkspaces array");
    assert!(
      without_rows.iter().any(|row| row["id"] == ws_without_sync.to_string()),
      "workspace without git sync must be returned: {without_sync}"
    );
    assert!(
      without_rows.iter().all(|row| row["gitSyncEnabled"] == false),
      "gitSyncEnabled=false filter must exclude enabled rows: {without_sync}"
    );

    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}
