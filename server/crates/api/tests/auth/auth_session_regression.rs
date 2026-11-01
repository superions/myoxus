//! Regression tests for auth-session edge cases (expiry, concurrent logins).
use crate::helpers;

use std::sync::Arc;

use axum::{
  body::Body,
  http::{self, Request, StatusCode},
};
use http_body_util::BodyExt;
use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::admin::AdminService;
use myoxus_application::auth::{AuthService, hash_password_for_testing};
use myoxus_application::doc::DocService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::admin::SqlxAdminStore;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::blob::SqlxBlobStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::mail::LogMailAdapter;
use myoxus_infrastructure::storage::StorageAdapter;
use myoxus_infrastructure::workspace::SqlxWorkspaceStore;
use serde_json::json;
use sqlx::{PgPool, Row};
use tower::ServiceExt;
use uuid::Uuid;

async fn setup_app() -> (axum::Router, PgPool) {
  let pool = helpers::setup_pool().await;

  let config = AppConfig::load().expect("config");
  let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
  let workspace_store = Arc::new(SqlxWorkspaceStore::new(
    pool.clone(),
    crate::helpers::database_starter_catalog(),
  ));
  let admin_store = Arc::new(SqlxAdminStore::new(pool.clone()));
  let doc_store = Arc::new(SqlxDocStore::new(pool.clone()));
  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("storage"));

  let auth_service = AuthService::new(
    auth_store.clone(),
    mailer,
    storage.clone(),
    config.server.session_ttl,
    config.server.session_ttr,
  );
  let workspace_service = WorkspaceService::new(workspace_store);
  let admin_service = AdminService::new(admin_store);
  let doc_service = DocService::new(doc_store);
  let blob_store = Arc::new(SqlxBlobStore::new(pool.clone()));
  let blob_service = Arc::new(myoxus_application::ports::blob_service::BlobService::new(
    blob_store,
    storage.clone(),
    "test-key".to_string(),
  ));

  let state = ApiState::with_services(
    config,
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    blob_service,
    storage,
  )
  .with_metrics_pool(pool.clone());

  (build_router(state), pool)
}

async fn insert_user(pool: &PgPool, email: &str, password: &str) -> Uuid {
  let user_id = Uuid::new_v4();
  let password_hash = hash_password_for_testing(password).expect("password hash");
  sqlx::query(
    r#"INSERT INTO users (id, email, name, password_hash, status, is_admin, email_verified_at)
       VALUES ($1, $2, $3, $4, 'active', FALSE, now())"#,
  )
  .bind(user_id)
  .bind(email)
  .bind(email)
  .bind(password_hash)
  .execute(pool)
  .await
  .expect("insert user");
  user_id
}

fn first_cookie_value(headers: &http::HeaderMap, name: &str) -> String {
  headers
    .get_all(http::header::SET_COOKIE)
    .iter()
    .filter_map(|value| value.to_str().ok())
    .find_map(|cookie| {
      cookie
        .strip_prefix(&format!("{name}="))
        .and_then(|rest| rest.split(';').next())
    })
    .expect("cookie value")
    .to_string()
}

#[tokio::test]
async fn sign_in_ignores_stale_session_and_user_cookies() {
  let (app, pool) = setup_app().await;
  let email = format!("stale-{}@example.invalid", Uuid::new_v4());
  let user_id = insert_user(&pool, &email, "admin").await;
  let stale_session_id = Uuid::new_v4();
  let stale_user_id = Uuid::new_v4();

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .header(
          http::header::COOKIE,
          format!("affine_session={stale_session_id}; affine_user_id={stale_user_id}"),
        )
        .body(Body::from(
          json!({
            "email": email,
            "password": "admin"
          })
          .to_string(),
        ))
        .expect("build request"),
    )
    .await
    .expect("sign-in response");

  assert_eq!(response.status(), StatusCode::OK);
  let session_cookie = first_cookie_value(response.headers(), "affine_session");
  let user_cookie = first_cookie_value(response.headers(), "affine_user_id");
  let new_session_id = Uuid::parse_str(&session_cookie).expect("session uuid");
  assert_ne!(new_session_id, stale_session_id);
  assert_eq!(Uuid::parse_str(&user_cookie).expect("user uuid"), user_id);

  let row = sqlx::query(
    r#"SELECT session_id, root_session_id, user_id
       FROM session_links
       WHERE session_id = $1"#,
  )
  .bind(new_session_id)
  .fetch_one(&pool)
  .await
  .expect("new session link");

  assert_eq!(row.get::<Uuid, _>("session_id"), new_session_id);
  assert_eq!(row.get::<Uuid, _>("root_session_id"), new_session_id);
  assert_eq!(row.get::<Uuid, _>("user_id"), user_id);

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn db_backed_multi_account_sign_in_keeps_shared_root() {
  let (app, pool) = setup_app().await;
  let user1_email = format!("multi-1-{}@example.invalid", Uuid::new_v4());
  let user2_email = format!("multi-2-{}@example.invalid", Uuid::new_v4());
  let user1_id = insert_user(&pool, &user1_email, "u1-password").await;
  let user2_id = insert_user(&pool, &user2_email, "u2-password").await;

  let first_sign_in = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({
            "email": user1_email,
            "password": "u1-password"
          })
          .to_string(),
        ))
        .expect("build request"),
    )
    .await
    .expect("first sign-in");
  assert_eq!(first_sign_in.status(), StatusCode::OK);
  let first_session_cookie = first_cookie_value(first_sign_in.headers(), "affine_session");
  let first_user_cookie = first_cookie_value(first_sign_in.headers(), "affine_user_id");
  let first_session_id = Uuid::parse_str(&first_session_cookie).expect("first session uuid");

  let second_sign_in = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .header(
          http::header::COOKIE,
          format!("affine_session={first_session_cookie}; affine_user_id={first_user_cookie}"),
        )
        .body(Body::from(
          json!({
            "email": user2_email,
            "password": "u2-password"
          })
          .to_string(),
        ))
        .expect("build request"),
    )
    .await
    .expect("second sign-in");
  assert_eq!(second_sign_in.status(), StatusCode::OK);
  let second_session_cookie = first_cookie_value(second_sign_in.headers(), "affine_session");
  let second_session_id = Uuid::parse_str(&second_session_cookie).expect("second session uuid");

  let rows = sqlx::query(
    r#"SELECT session_id, root_session_id, user_id
       FROM session_links
       WHERE session_id = $1 OR session_id = $2
       ORDER BY created_at ASC"#,
  )
  .bind(first_session_id)
  .bind(second_session_id)
  .fetch_all(&pool)
  .await
  .expect("session links");
  assert_eq!(rows.len(), 2);
  assert_eq!(rows[0].get::<Uuid, _>("root_session_id"), first_session_id);
  assert_eq!(rows[1].get::<Uuid, _>("root_session_id"), first_session_id);

  let sessions_response = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::GET)
        .uri("/api/auth/sessions")
        .header(http::header::COOKIE, format!("affine_session={second_session_id}"))
        .body(Body::empty())
        .expect("build request"),
    )
    .await
    .expect("sessions response");
  assert_eq!(sessions_response.status(), StatusCode::OK);
  let sessions_body = sessions_response
    .into_body()
    .collect()
    .await
    .expect("sessions body")
    .to_bytes();
  let sessions_json: serde_json::Value = serde_json::from_slice(&sessions_body).expect("sessions json");
  let users = sessions_json["users"].as_array().expect("users array");
  assert_eq!(users.len(), 2);
  assert_eq!(users[0]["id"], user1_id.to_string());
  assert_eq!(users[1]["id"], user2_id.to_string());

  let session_count = sqlx::query_scalar::<_, i64>(r#"SELECT COUNT(*) FROM session_links WHERE root_session_id = $1"#)
    .bind(first_session_id)
    .fetch_one(&pool)
    .await
    .expect("session count");
  assert_eq!(session_count, 2);

  helpers::cleanup_users(&pool, &[user1_id, user2_id]).await;
}

/// FR-10: When a user has an old `affine_session` cookie whose session was
/// deleted by TTL cleanup, sign-in must succeed — not fail with an FK
/// constraint error on `session_links`.
#[tokio::test]
async fn fr10_sign_in_succeeds_after_previous_session_deleted_by_ttl() {
  let (app, pool) = setup_app().await;
  let email = format!("fr10-{}@example.invalid", Uuid::new_v4());
  let user_id = insert_user(&pool, &email, "testpass").await;

  // 1. Sign in to get a real session
  let first_response = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(
          json!({ "email": email, "password": "testpass" }).to_string(),
        ))
        .expect("build request"),
    )
    .await
    .expect("first sign-in");
  assert_eq!(first_response.status(), StatusCode::OK);
  let old_session_cookie = first_cookie_value(first_response.headers(), "affine_session");
  let old_session_id = Uuid::parse_str(&old_session_cookie).expect("old session uuid");

  // Verify session_link was created
  let link_exists = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM session_links WHERE session_id = $1")
    .bind(old_session_id)
    .fetch_one(&pool)
    .await
    .expect("check link");
  assert_eq!(link_exists, 1, "session_link must exist after sign-in");

  // 2. Simulate TTL cleanup: delete the session from the DB.
  //    CASCADE should clean up session_links too.
  sqlx::query("DELETE FROM sessions WHERE id = $1")
    .bind(old_session_id)
    .execute(&pool)
    .await
    .expect("delete old session");

  // Verify CASCADE cleaned the link
  let link_after_delete = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM session_links WHERE session_id = $1")
    .bind(old_session_id)
    .fetch_one(&pool)
    .await
    .expect("check link after delete");
  assert_eq!(link_after_delete, 0, "CASCADE must clean session_links");

  // 3. Sign in again with the stale cookie — this MUST succeed (FR-10)
  let second_response = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .header(
          http::header::COOKIE,
          format!("affine_session={old_session_id}; affine_user_id={user_id}"),
        )
        .body(Body::from(
          json!({ "email": email, "password": "testpass" }).to_string(),
        ))
        .expect("build request"),
    )
    .await
    .expect("second sign-in with stale cookie");
  assert_eq!(
    second_response.status(),
    StatusCode::OK,
    "FR-10: sign-in must not fail when previous session was deleted"
  );

  // 4. Verify new session is self-rooted (no link to dead parent)
  let new_session_cookie = first_cookie_value(second_response.headers(), "affine_session");
  let new_session_id = Uuid::parse_str(&new_session_cookie).expect("new session uuid");
  assert_ne!(new_session_id, old_session_id);

  let row = sqlx::query("SELECT root_session_id, user_id FROM session_links WHERE session_id = $1")
    .bind(new_session_id)
    .fetch_one(&pool)
    .await
    .expect("new session link must exist");
  assert_eq!(
    row.get::<Uuid, _>("root_session_id"),
    new_session_id,
    "new session must be self-rooted after stale parent"
  );
  assert_eq!(row.get::<Uuid, _>("user_id"), user_id);

  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// FR-10: Deleting a root session must CASCADE-delete all session_links
/// that reference it (both as session_id and root_session_id).
#[tokio::test]
async fn fr10_cascade_deletes_session_links_when_parent_deleted() {
  let (app, pool) = setup_app().await;
  let email1 = format!("fr10-cascade-1-{}@example.invalid", Uuid::new_v4());
  let email2 = format!("fr10-cascade-2-{}@example.invalid", Uuid::new_v4());
  let user1_id = insert_user(&pool, &email1, "pass1").await;
  let _user2_id = insert_user(&pool, &email2, "pass2").await;

  // Sign in user1 to create root session
  let first = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "email": email1, "password": "pass1" }).to_string()))
        .expect("build request"),
    )
    .await
    .expect("first sign-in");
  let root_cookie = first_cookie_value(first.headers(), "affine_session");
  let root_session_id = Uuid::parse_str(&root_cookie).expect("root session uuid");

  // Sign in user2 with the existing session cookie to create a linked session
  let second = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/auth/sign-in")
        .header(http::header::CONTENT_TYPE, "application/json")
        .header(
          http::header::COOKIE,
          format!("affine_session={root_cookie}; affine_user_id={user1_id}"),
        )
        .body(Body::from(json!({ "email": email2, "password": "pass2" }).to_string()))
        .expect("build request"),
    )
    .await
    .expect("second sign-in");
  let child_cookie = first_cookie_value(second.headers(), "affine_session");
  let child_session_id = Uuid::parse_str(&child_cookie).expect("child session uuid");

  // Both sessions should be linked under the same root
  let count_before = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM session_links WHERE root_session_id = $1")
    .bind(root_session_id)
    .fetch_one(&pool)
    .await
    .expect("count before");
  assert_eq!(count_before, 2, "two sessions linked under root");

  // Delete the ROOT session — CASCADE must clean both links
  sqlx::query("DELETE FROM sessions WHERE id = $1")
    .bind(root_session_id)
    .execute(&pool)
    .await
    .expect("delete root session");

  // All links referencing the root must be gone
  let count_after = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM session_links WHERE root_session_id = $1")
    .bind(root_session_id)
    .fetch_one(&pool)
    .await
    .expect("count after");
  assert_eq!(count_after, 0, "CASCADE must delete all links for root");

  // The child session's link (session_id FK) should also be gone since the
  // root was cascaded.  The child's own session row may still exist.
  let child_link = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM session_links WHERE session_id = $1")
    .bind(child_session_id)
    .fetch_one(&pool)
    .await
    .expect("child link after cascade");
  assert_eq!(child_link, 0, "child link must be gone after root deletion");

  helpers::cleanup_users(&pool, &[user1_id]).await;
}
