//! Compatibility tests for the admin GraphQL API (field presence, type shapes).
use axum::{body::Body, http::Request};
use futures_util::FutureExt;
use http_body_util::BodyExt;
use myoxus_application::auth::AuthStore;
use serde_json::Value;
use std::panic::{AssertUnwindSafe, resume_unwind};
use tower::ServiceExt;

#[tokio::test]
async fn admin_root_compat_queries_and_mutations_are_wired() {
  // Auth and Admin must read the same canonical persisted accounts. The old
  // empty Admin store could never satisfy the shared userById projection.
  let (app, pool, store) = crate::helpers::setup_app().await;
  let admin_id = crate::helpers::create_user(&pool, "admin-root-compat", true).await;
  let user_id = crate::helpers::create_user(&pool, "user-root-compat", false).await;
  let outcome = AssertUnwindSafe(async {
  let session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: admin_id,
      csrf_token: "csrf".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("session");

  let q = serde_json::json!({
    "query": format!("query {{ admin {{ users(filter:{{first:10,skip:0}}) {{ email }} usersCount(filter:{{first:10,skip:0}}) adminUsers: users(filter:{{first:10,skip:0,features:[Admin]}}) {{ email }} adminUsersCount: usersCount(filter:{{first:10,skip:0,features:[Admin]}}) userByEmail(email:\"user@example.com\") {{ email }} userById(id:\"{admin_id}\") {{ id email }} adminDashboard {{ syncActiveUsers generatedAt }} adminWorkspaces(filter:{{first:10,skip:0}}) {{ id name public owner {{ id email }} features }} adminWorkspacesCount(filter:{{first:10,skip:0}}) adminWorkspace(id:\"{admin_id}\") {{ id }} adminAllSharedLinks(pagination:{{first:5,offset:0}}) {{ totalCount pageInfo {{ hasNextPage hasPreviousPage }} edges {{ cursor }} }} }} }}")
  })
  .to_string();
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::from(q))
        .expect("request"),
    )
    .await
    .expect("response");
  let body = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("json");
  assert!(json.get("errors").is_none(), "query failed: {}", json);
  assert!(json["data"]["admin"]["users"].is_array());
  assert!(json["data"]["admin"]["usersCount"].is_i64());
  assert!(json["data"]["admin"]["adminUsers"].is_array());
  assert!(json["data"]["admin"]["adminUsersCount"].is_i64());
  assert_eq!(json["data"]["admin"]["userById"]["id"], admin_id.to_string());
  assert!(json["data"]["admin"]["adminDashboard"].is_object());
  assert!(json["data"]["admin"]["adminWorkspaces"].is_array());
  assert!(json["data"]["admin"]["adminWorkspacesCount"].is_i64());
  assert!(json["data"]["admin"]["adminAllSharedLinks"].is_object());
  assert!(json["data"]["admin"]["adminAllSharedLinks"]["edges"].is_array());

  let m = serde_json::json!({
    "query": format!(
      "mutation {{ admin {{ createChangePasswordUrl(userId:\"{admin_id}\") }} }}"
    )
  })
  .to_string();
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::from(m))
        .expect("request"),
    )
    .await
    .expect("response");
  let body = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("json");
  assert!(json.get("errors").is_none(), "mutation failed: {}", json);
  assert!(
    json["data"]["admin"]["createChangePasswordUrl"]
      .as_str()
      .expect("url")
      .contains("token=")
  );
  }).catch_unwind().await;
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=ANY($1) OR target_id=ANY($2)")
    .bind(vec![admin_id, user_id])
    .bind(vec![admin_id.to_string(), user_id.to_string()])
    .execute(&pool)
    .await
    .expect("cleanup owned compatibility audits");
  sqlx::query("DELETE FROM verification_tokens WHERE user_id=ANY($1)")
    .bind(vec![admin_id, user_id])
    .execute(&pool)
    .await
    .expect("cleanup owned reset tokens");
  sqlx::query("DELETE FROM users WHERE id=ANY($1)")
    .bind(vec![admin_id, user_id])
    .execute(&pool)
    .await
    .expect("cleanup owned users and sessions");
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}
