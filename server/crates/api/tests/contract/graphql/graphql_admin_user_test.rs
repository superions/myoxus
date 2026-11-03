//! Admin user management GraphQL tests — DB-backed user/session operations.
//!
//! Covers: createChangePasswordUrl token persistence, session refresh,
//! updateUserFeatures flag persistence, and full admin CRUD lifecycle
//! (createUser, updateUser, banUser, enableUser, importUsers, deleteUser).

use crate::helpers;

use axum::{body::Body, http::Request};
use chrono::{DateTime, Utc};
use futures_util::FutureExt;
use http_body_util::BodyExt;
use myoxus_application::auth::{AuthStore, verify_password_hash};
use reqwest::Url;
use serde_json::{Value, json};
use sqlx::Row;
use std::panic::{AssertUnwindSafe, resume_unwind};
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn create_change_password_url_uses_server_origin_and_configured_ttl() {
  let (app, pool, auth_store) = helpers::setup_app_with_config_override(|config| {
    config.server.origin = "https://workspace.example.test/base".to_string();
    config.auth.password_reset_ttl_seconds = 900;
  })
  .await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  let resp = helpers::gql_with_headers(
    &app,
    session_id,
    json!({"query": format!("mutation {{ admin {{ createChangePasswordUrl(userId:\"{admin_id}\") }} }}")}),
    &[
      ("host", "attacker.example"),
      ("forwarded", "host=attacker.example;proto=http"),
      ("x-forwarded-host", "attacker.example"),
    ],
  )
  .await;
  assert!(resp.get("errors").is_none(), "mutation failed: {resp}");
  let raw_url = resp["data"]["admin"]["createChangePasswordUrl"]
    .as_str()
    .expect("url response");
  let url = Url::parse(raw_url).expect("canonical reset URL");
  assert_eq!(url.origin().ascii_serialization(), "https://workspace.example.test");
  assert_eq!(url.path(), "/base/auth/changePassword");
  let token = url
    .query_pairs()
    .find(|(key, _)| key == "token")
    .map(|(_, value)| value.into_owned())
    .expect("token in URL");

  let row = sqlx::query("SELECT kind, user_id, created_at, expires_at FROM verification_tokens WHERE token_hash = $1")
    .bind(token)
    .fetch_one(&pool)
    .await
    .expect("verification token");
  let kind: String = row.get("kind");
  let user_id: Option<Uuid> = row.get("user_id");
  let created_at: DateTime<Utc> = row.get("created_at");
  let expires_at: DateTime<Utc> = row.get("expires_at");
  assert_eq!(kind, "ChangePassword");
  assert_eq!(user_id, Some(admin_id));
  let persisted_ttl = (expires_at - created_at).num_seconds();
  assert!(
    (895..=905).contains(&persisted_ttl),
    "configured 900-second TTL must be bound by the test router, got {persisted_ttl}"
  );

  // Cleanup
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn concurrent_password_reset_has_one_winner_and_atomically_revokes_sessions() {
  let (app, pool, auth_store) = helpers::setup_app_with_config_override(|config| {
    config.server.origin = "https://workspace.example.test".to_string();
  })
  .await;
  let (admin_id, admin_session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let (user_id, first_session_id) = helpers::seed_user(&pool, &auth_store, "password-reset-race").await;
  let second_session_id = helpers::create_session(&auth_store, user_id).await;

  let link_response = helpers::gql(
    &app,
    admin_session_id,
    json!({"query": format!("mutation {{ admin {{ createChangePasswordUrl(userId:\"{user_id}\") }} }}")}),
  )
  .await;
  assert!(
    link_response.get("errors").is_none(),
    "link mutation failed: {link_response}"
  );
  let link = Url::parse(
    link_response["data"]["admin"]["createChangePasswordUrl"]
      .as_str()
      .expect("reset URL"),
  )
  .expect("canonical reset URL");
  let token = link
    .query_pairs()
    .find(|(key, _)| key == "token")
    .map(|(_, value)| value.into_owned())
    .expect("token query parameter");

  let mutation = "mutation Reset($token:String!,$password:String!){changePassword(token:$token,newPassword:$password)}";
  let first = helpers::gql_anon(
    &app,
    json!({"query": mutation, "variables": {"token": token, "password": "FirstWinner-2026!"}}),
  );
  let second = helpers::gql_anon(
    &app,
    json!({"query": mutation, "variables": {"token": token, "password": "SecondWinner-2026!"}}),
  );
  let (first_response, second_response) = tokio::join!(first, second);
  let responses = [&first_response, &second_response];
  assert_eq!(
    responses
      .iter()
      .filter(|response| response["data"]["changePassword"] == json!(true))
      .count(),
    1,
    "exactly one concurrent reset must succeed: {responses:?}"
  );
  assert_eq!(
    responses
      .iter()
      .filter(|response| response.get("errors").is_some())
      .count(),
    1,
    "the losing reset must report token failure: {responses:?}"
  );

  let password_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .expect("persisted password hash");
  assert!(
    verify_password_hash(&password_hash, "FirstWinner-2026!")
      ^ verify_password_hash(&password_hash, "SecondWinner-2026!"),
    "the stored hash must match exactly one competing password"
  );
  let token_consumed: bool =
    sqlx::query_scalar("SELECT used_at IS NOT NULL FROM verification_tokens WHERE token_hash = $1")
      .bind(&token)
      .fetch_one(&pool)
      .await
      .expect("consumed token state");
  assert!(token_consumed);
  let active_target_sessions: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL")
      .bind(user_id)
      .fetch_one(&pool)
      .await
      .expect("target session state");
  assert_eq!(active_target_sessions, 0);
  for session_id in [first_session_id, second_session_id] {
    let snapshot = auth_store
      .get_session(session_id)
      .await
      .expect("session lookup")
      .expect("persisted session");
    assert!(snapshot.revoked_at.is_some(), "session {session_id} must be revoked");
  }

  let reuse_response = helpers::gql_anon(
    &app,
    json!({"query": mutation, "variables": {"token": token, "password": "ThirdAttempt-2026!"}}),
  )
  .await;
  assert!(
    reuse_response.get("errors").is_some(),
    "consumed token must stay unusable"
  );
  let unchanged_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .expect("password hash after token reuse");
  assert_eq!(
    unchanged_hash, password_hash,
    "failed token reuse must not mutate the password"
  );

  helpers::cleanup_users(&pool, &[admin_id, user_id]).await;
}

#[tokio::test]
async fn current_sessions_refreshes_persisted_session_record() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  let before = sqlx::query("SELECT expires_at FROM sessions WHERE id = $1")
    .bind(session_id)
    .fetch_one(&pool)
    .await
    .expect("session before");
  let before_expires_at: DateTime<Utc> = before.get("expires_at");

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri("/api/auth/sessions")
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("json");
  assert!(json["users"].as_array().is_some_and(|arr| !arr.is_empty()));

  let after = sqlx::query("SELECT expires_at FROM sessions WHERE id = $1")
    .bind(session_id)
    .fetch_one(&pool)
    .await
    .expect("session after");
  let after_expires_at: DateTime<Utc> = after.get("expires_at");
  assert!(
    after_expires_at >= before_expires_at,
    "session expiry must be refreshed"
  );

  // Cleanup
  helpers::cleanup_users(&pool, &[admin_id]).await;
}

#[tokio::test]
async fn update_user_features_persists_admin_and_unlimited_copilot_overrides() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let (user_id, user_session_id) = helpers::seed_user(&pool, &auth_store, "features").await;

  let resp = helpers::gql(
    &app,
    user_session_id,
    json!({"query": "query { currentUser { features } }"}),
  )
  .await;
  let features = resp["data"]["currentUser"]["features"]
    .as_array()
    .expect("features array");
  assert!(
    !features.iter().any(|v| v == "UnlimitedCopilot"),
    "optional copilot capability must not be enabled by static defaults"
  );
  assert!(!features.iter().any(|v| v == "Admin"));

  let resp = helpers::gql(
    &app,
    admin_session_id,
    json!({"query": format!("mutation {{ admin {{ updateUserFeatures(id:\"{user_id}\", features:[Admin]) }} }}")}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "mutation failed: {resp}");

  let row = sqlx::query("SELECT is_admin FROM users WHERE id = $1")
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .expect("admin flag row");
  let is_admin: bool = row.get("is_admin");
  assert!(is_admin, "user should be admin after Admin feature update");

  let row =
    sqlx::query("SELECT activated FROM user_features WHERE user_id = $1 AND feature_name = 'unlimited_copilot'")
      .bind(user_id)
      .fetch_one(&pool)
      .await
      .expect("unlimited copilot row");
  let activated: bool = row.get("activated");
  assert!(!activated, "unlimited copilot should be disabled by omission");

  let resp = helpers::gql(
    &app,
    user_session_id,
    json!({"query": "query { currentUser { features } }"}),
  )
  .await;
  let features = resp["data"]["currentUser"]["features"]
    .as_array()
    .expect("features array");
  assert!(features.iter().any(|v| v == "Admin"));
  assert!(!features.iter().any(|v| v == "UnlimitedCopilot"));

  // Cleanup
  helpers::cleanup_users(&pool, &[admin_id, user_id]).await;
}

#[tokio::test]
async fn admin_user_mutations_are_db_backed() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, admin_session_id) = helpers::seed_admin(&pool, &auth_store).await;

  let marker = Uuid::new_v4().simple().to_string();
  let email = format!("admin-mutation-{marker}@example.test");
  let changed_email = format!("admin-mutation-changed-{marker}@example.test");
  let import_a = format!("import-a-{marker}@example.test");
  let import_b = format!("import-b-{marker}@example.test");
  let mut fixture_ids = vec![admin_id];
  let outcome=AssertUnwindSafe(async {
  // createUser
  let resp = helpers::gql(
    &app,
    admin_session_id,
    json!({"query":"mutation($input:CreateUserInput!){admin{createUser(input:$input){id email name disabled hasPassword}}}","variables":{"input":{"email":email,"name":"Tmp User","password":"TestPassword123!"}}}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "createUser failed: {resp}");
  let created_id = resp["data"]["admin"]["createUser"]["id"]
    .as_str()
    .expect("created user id")
    .to_string();
  fixture_ids.push(Uuid::parse_str(&created_id).unwrap());
  assert_eq!(resp["data"]["admin"]["createUser"]["name"], "Tmp User");
  assert_eq!(resp["data"]["admin"]["createUser"]["disabled"], false);
  assert_eq!(resp["data"]["admin"]["createUser"]["hasPassword"], true);

  // updateUser
  let resp = helpers::gql(
    &app,
    admin_session_id,
    json!({"query":"mutation($id:String!,$input:ManageUserInput!){admin{updateUser(id:$id,input:$input){id email name}}}","variables":{"id":created_id,"input":{"name":"Updated User","email":changed_email}}}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "updateUser failed: {resp}");
  assert_eq!(resp["data"]["admin"]["updateUser"]["name"], "Updated User");
  assert_eq!(
    resp["data"]["admin"]["updateUser"]["email"],
    changed_email
  );

  // banUser
  let resp = helpers::gql(
    &app,
    admin_session_id,
    json!({"query": format!("mutation {{ admin {{ banUser(id:\"{created_id}\") {{ id disabled }} }} }}")}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "banUser failed: {resp}");
  assert_eq!(resp["data"]["admin"]["banUser"]["disabled"], true);

  // enableUser
  let resp = helpers::gql(
    &app,
    admin_session_id,
    json!({"query": format!("mutation {{ admin {{ enableUser(id:\"{created_id}\") {{ id disabled }} }} }}")}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "enableUser failed: {resp}");
  assert_eq!(resp["data"]["admin"]["enableUser"]["disabled"], false);

  // importUsers
  let resp = helpers::gql(
    &app,
    admin_session_id,
    json!({"query":"mutation($input:ImportUsersInput!){admin{importUsers(input:$input){__typename ... on UserType{id email name} ... on UserImportFailedType{email error}}}}","variables":{"input":{"users":[{"email":import_a,"name":"Import A"},{"email":"bad-email"},{"email":import_b,"password":"TestPassword123!"}]}}}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "importUsers failed: {resp}");
  let imported = resp["data"]["admin"]["importUsers"]
    .as_array()
    .expect("importUsers array");
  for item in imported.iter().filter(|item| item["__typename"] == "UserType") {
    fixture_ids.push(Uuid::parse_str(item["id"].as_str().expect("imported UUID")).unwrap());
  }
  assert_eq!(imported.len(), 3);
  assert!(imported.iter().any(|item| item["__typename"] == "UserImportFailedType"));

  // deleteUser
  let resp = helpers::gql(
    &app,
    admin_session_id,
    json!({"query": format!("mutation {{ admin {{ deleteUser(id:\"{created_id}\") {{ success }} }} }}")}),
  )
  .await;
  assert!(resp.get("errors").is_none(), "deleteUser failed: {resp}");
  assert_eq!(resp["data"]["admin"]["deleteUser"]["success"], true);

  let row = sqlx::query("SELECT COUNT(*) AS count FROM users WHERE id = $1")
    .bind(Uuid::parse_str(&created_id).expect("uuid"))
    .fetch_one(&pool)
    .await
    .expect("deleted user count");
  let count: i64 = row.get("count");
  assert_eq!(count, 1);
  assert!(auth_store.get_user_by_id(Uuid::parse_str(&created_id).unwrap()).await.unwrap().is_none());
  }).catch_unwind().await;

  // Remove only owned content before physically removing retained fixture identities.
  sqlx::query("DELETE FROM workspace_content_operations WHERE source_workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ANY($1)) OR target_workspace_id IN (SELECT id FROM workspaces WHERE owner_user_id = ANY($1))")
    .bind(&fixture_ids).execute(&pool).await.expect("clean owned content operations");
  sqlx::query("DELETE FROM workspaces WHERE owner_user_id = ANY($1)")
    .bind(&fixture_ids)
    .execute(&pool)
    .await
    .expect("clean owned workspaces");
  sqlx::query("DELETE FROM users WHERE id = ANY($1)")
    .bind(&fixture_ids)
    .execute(&pool)
    .await
    .expect("clean owned fixture identities");
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}

#[tokio::test]
async fn administrative_creation_is_insert_only_and_reports_durable_provisioning_failure() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let marker = Uuid::new_v4().simple().to_string();
  let email = format!("admin-create-{marker}@example.test");
  let invalid_password_email = format!("invalid-password-{marker}@example.test");
  let invalid_name_email = format!("invalid-name-{marker}@example.test");
  let partial_email = format!("partial-create-{marker}@example.test");
  let password_failure_email = format!("password-failure-{marker}@example.test");
  let fixture_emails = vec![
    email.clone(),
    invalid_password_email.clone(),
    invalid_name_email.clone(),
    partial_email.clone(),
    password_failure_email.clone(),
  ];
  let trigger = format!("admin_create_failure_{marker}");
  let outcome = AssertUnwindSafe(async {
    // Fail only this fixture's root payload, after the workspace transaction commits.
    sqlx::query(&format!(
      "CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
     IF EXISTS (SELECT 1 FROM workspaces w JOIN users u ON u.id = w.owner_user_id \
     WHERE w.id = NEW.workspace_id AND u.email = '{partial_email}') THEN \
     RAISE EXCEPTION 'root-init-secret-sentinel'; END IF; RETURN NEW; END $$"
    ))
    .execute(&pool)
    .await
    .expect("install isolated failure function");
    sqlx::query(&format!(
      "CREATE TRIGGER {trigger} BEFORE INSERT ON doc_updates FOR EACH ROW EXECUTE FUNCTION {trigger}()"
    ))
    .execute(&pool)
    .await
    .expect("install isolated failure trigger");
    sqlx::query(&format!(
      "CREATE FUNCTION {trigger}_password() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
     IF OLD.email = '{password_failure_email}' AND NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN \
     RAISE EXCEPTION 'password-write-secret-sentinel'; END IF; RETURN NEW; END $$"
    ))
    .execute(&pool)
    .await
    .expect("install password failure function");
    sqlx::query(&format!(
      "CREATE TRIGGER {trigger}_password BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION {trigger}_password()"
    ))
    .execute(&pool)
    .await
    .expect("install password failure trigger");
    let request = |email: &str, name: &str, password: &str| {
      json!({
        "query": "mutation($input:CreateUserInput!){admin{createUser(input:$input){id email name hasPassword}}}",
        "variables": {"input": {"email":email,"name":name,"password":password}}
      })
    };
    let first_input = request(
      &format!(" {} ", email.to_uppercase()),
      "First winner",
      "FirstWinner-2026!",
    );
    let second_input = request(&email, "Second winner", "SecondWinner-2026!");
    let (first, second) = tokio::join!(
      helpers::gql(&app, session_id, first_input),
      helpers::gql(&app, session_id, second_input)
    );
    assert_ne!(
      first.get("errors").is_none(),
      second.get("errors").is_none(),
      "one winner required"
    );
    let (winner, loser, winner_name, winner_password, loser_password) = if first.get("errors").is_none() {
      (
        &first,
        &second,
        "First winner",
        "FirstWinner-2026!",
        "SecondWinner-2026!",
      )
    } else {
      (
        &second,
        &first,
        "Second winner",
        "SecondWinner-2026!",
        "FirstWinner-2026!",
      )
    };
    assert_eq!(loser["errors"][0]["message"], "email already used");
    let id = Uuid::parse_str(
      winner["data"]["admin"]["createUser"]["id"]
        .as_str()
        .expect("winner identity"),
    )
    .unwrap();
    assert_eq!(winner["data"]["admin"]["createUser"]["email"], email);
    let persisted = auth_store.get_user_by_id(id).await.unwrap().unwrap();
    assert_eq!(persisted.name.as_deref(), Some(winner_name));
    let hash = persisted.password_hash.as_deref().expect("winner password");
    assert!(verify_password_hash(hash, winner_password));
    assert!(!verify_password_hash(hash, loser_password));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE lower(email) = $1")
      .bind(&email)
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(count, 1);
    let roots: i64 = sqlx::query_scalar(
      "SELECT COUNT(*) FROM workspaces w WHERE w.owner_user_id = $1 AND w.is_personal_workspace \
      AND EXISTS(SELECT 1 FROM docs d WHERE d.workspace_id = w.id AND d.is_workspace_root) \
      AND EXISTS(SELECT 1 FROM doc_updates u WHERE u.workspace_id = w.id AND octet_length(u.payload) > 0)",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(roots, 1, "one usable personal workspace");
    let audit: i64 = sqlx::query_scalar(
      "SELECT COUNT(*) FROM admin_audit_log WHERE event_key = 'user.create' AND target_id = $1 AND actor_user_id = $2",
    )
    .bind(id.to_string())
    .bind(admin_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit, 1, "shared owner emits one event with actual session actor");
    let repeat = helpers::gql(&app, session_id, request(&email, "Replacement", "Replacement-2026!")).await;
    assert_eq!(repeat["errors"][0]["message"], "email already used");
    let unchanged = auth_store.get_user_by_id(id).await.unwrap().unwrap();
    assert_eq!(unchanged.name, persisted.name);
    assert_eq!(unchanged.password_hash, persisted.password_hash);
    for input in [
      request("invalid-address", "Valid name", "ValidPassword-2026!"),
      request(&invalid_password_email, "Valid name", "x"),
      request(&invalid_name_email, "   ", "ValidPassword-2026!"),
    ] {
      let result = helpers::gql(&app, session_id, input).await;
      assert!(result.get("errors").is_some(), "invalid input must fail");
    }
    let invalid_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE email = ANY($1)")
      .bind(vec![
        "invalid-address".to_string(),
        invalid_password_email.clone(),
        invalid_name_email.clone(),
      ])
      .fetch_one(&pool)
      .await
      .unwrap();
    assert_eq!(invalid_count, 0, "validation must precede all account writes");
    let partial = helpers::gql(
      &app,
      session_id,
      request(&partial_email, "Partial workspace", "ValidPassword-2026!"),
    )
    .await;
    let partial_user = auth_store
      .get_user_by_email(&partial_email)
      .await
      .unwrap()
      .expect("partial account retained");
    let workspace_id: Uuid =
      sqlx::query_scalar("SELECT id FROM workspaces WHERE owner_user_id = $1 AND is_personal_workspace")
        .bind(partial_user.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let message = partial["errors"][0]["message"].as_str().expect("truthful error");
    assert!(message.contains(&partial_user.id.to_string()) && message.contains(&workspace_id.to_string()));
    assert!(message.contains("provisioning"));
    assert!(!message.contains("root-init-secret-sentinel"));
    assert!(partial_user.password_hash.is_none(), "password stage never reached");
    let audit: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM admin_audit_log WHERE event_key = 'user.create' AND target_id = $1")
        .bind(partial_user.id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(audit, 0, "partial failure must not emit successful creation");
    let retry = helpers::gql(&app, session_id, request(&partial_email, "Repair", "Replacement-2026!")).await;
    assert_eq!(
      retry["errors"][0]["message"], "email already used",
      "no implicit repair or replacement"
    );
    let failure = helpers::gql(
      &app,
      session_id,
      request(&password_failure_email, "Password failure", "ValidPassword-2026!"),
    )
    .await;
    let retained = auth_store
      .get_user_by_email(&password_failure_email)
      .await
      .unwrap()
      .expect("retained account after password failure");
    let workspace_id: Uuid =
      sqlx::query_scalar("SELECT id FROM workspaces WHERE owner_user_id = $1 AND is_personal_workspace")
        .bind(retained.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let message = failure["errors"][0]["message"].as_str().expect("password failure");
    assert!(
      message.contains("password setup")
        && message.contains(&retained.id.to_string())
        && message.contains(&workspace_id.to_string())
    );
    assert!(!message.contains("password-write-secret-sentinel"));
    assert!(retained.password_hash.is_none());
    let initialized: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM doc_updates WHERE workspace_id = $1 AND octet_length(payload) > 0)",
    )
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(initialized, "password failure preserves provisioned root");
    let audit: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM admin_audit_log WHERE event_key = 'user.create' AND target_id = $1")
        .bind(retained.id.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(audit, 0);
  })
  .catch_unwind()
  .await;
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger} ON doc_updates"))
    .execute(&pool)
    .await
    .expect("remove failure trigger");
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {trigger}()"))
    .execute(&pool)
    .await
    .expect("remove failure function");
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger}_password ON users"))
    .execute(&pool)
    .await
    .expect("remove password failure trigger");
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {trigger}_password()"))
    .execute(&pool)
    .await
    .expect("remove password failure function");
  let mut ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE email = ANY($1)")
    .bind(fixture_emails)
    .fetch_all(&pool)
    .await
    .expect("read owned cleanup identities");
  ids.push(admin_id);
  let mut tx = pool.begin().await.expect("cleanup transaction");
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1 OR target_id = ANY($2)")
    .bind(admin_id)
    .bind(ids.iter().map(ToString::to_string).collect::<Vec<_>>())
    .execute(&mut *tx)
    .await
    .expect("clean owned audit");
  sqlx::query("DELETE FROM workspaces WHERE owner_user_id = ANY($1)")
    .bind(&ids)
    .execute(&mut *tx)
    .await
    .expect("clean owned workspaces");
  sqlx::query("DELETE FROM users WHERE id = ANY($1)")
    .bind(&ids)
    .execute(&mut *tx)
    .await
    .expect("clean owned users");
  tx.commit().await.expect("commit fixture cleanup");
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}

#[tokio::test]
async fn admin_role_ingresses_refresh_warm_sessions_retain_keys_and_rollback_missing_or_faulted_targets() {
  use myoxus_application::ports::RedisPort;
  use std::sync::Arc;
  let namespace = format!("ua11-{}", Uuid::new_v4());
  let redis = Arc::new(
    myoxus_infrastructure::redis::RedisAdapter::new(
      std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".into()),
      namespace,
    )
    .unwrap(),
  );
  let (app, pool, auth) = helpers::setup_app_with_mcp_audit_and_session_cache(redis.clone()).await;
  let (other, _, _) = helpers::setup_app_with_mcp_audit_and_session_cache(redis.clone()).await;
  let (admin, session) = helpers::seed_admin(&pool, &auth).await;
  let (target, target_session) = helpers::seed_user(&pool, &auth, "role_warm_verified").await;
  let (unverified, unverified_session) = helpers::seed_user(&pool, &auth, "role_warm_unverified").await;
  auth.set_email_verified(target, Utc::now()).await.unwrap();
  sqlx::query("UPDATE users SET email_verified_at=NULL WHERE id=$1")
    .bind(unverified)
    .execute(&pool)
    .await
    .unwrap();
  let missing = Uuid::new_v4();
  let fault = format!("ua11_{}", Uuid::new_v4().simple());
  let outcome=AssertUnwindSafe(async {
    let key=helpers::mcp::key(&app,session,&["read:users","write:users"]).await;
    let args=json!({"user_id":target,"is_admin":true,"idempotency_key":"grant"});
    let granted=helpers::mcp::invoke(&app,&key,"user_set_admin",args.clone(),true).await;
    assert_eq!(granted["is_admin"],true);
    assert_eq!(helpers::mcp::invoke(&app,&key,"user_set_admin",args,true).await,granted);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM admin_audit_log WHERE target_id=$1 AND event_key='user.admin-role-set'").bind(target.to_string()).fetch_one(&pool).await.unwrap(),1,"replay does not emit a second domain event");
    let target_key=helpers::mcp::key(&app,target_session,&["read:users","write:users"]).await;
    let retained=sqlx::query_as::<_,(Uuid,chrono::DateTime<Utc>)>("SELECT id,expires_at FROM sessions WHERE id=$1").bind(target_session).fetch_one(&pool).await.unwrap();
    for ingress in ["setUserAdmin","updateUserFeatures","mcp"] {
      let grant=helpers::gql(&app,session,json!({"query":"mutation($id:ID!){admin{setUserAdmin(userId:$id,isAdmin:true)}}","variables":{"id":target}})).await;
      assert!(grant.get("errors").is_none(),"grant failed");
      let warm=helpers::gql(&other,target_session,json!({"query":"query($id:String!){admin{userById(id:$id){id}}}","variables":{"id":target}})).await;
      assert!(warm.get("errors").is_none(),"warm Admin operation");
      let demote=match ingress {
        "setUserAdmin"=>helpers::gql(&app,session,json!({"query":"mutation($id:ID!){admin{setUserAdmin(userId:$id,isAdmin:false)}}","variables":{"id":target}})).await,
        "updateUserFeatures"=>helpers::gql(&app,session,json!({"query":"mutation($id:String!){admin{updateUserFeatures(id:$id,features:[])}}","variables":{"id":target}})).await,
        _=>json!({"data":helpers::mcp::invoke(&app,&key,"user_set_admin",json!({"user_id":target,"is_admin":false,"idempotency_key":"demote-target"}),true).await}),
      };
      assert!(demote.get("errors").is_none(),"demotion failed");
      assert!(helpers::gql(&other,target_session,json!({"query":"query($id:String!){admin{userById(id:$id){id}}}","variables":{"id":target}})).await.get("errors").is_some(),"warm old Admin authority must be refused");
      let ordinary=helpers::gql(&other,target_session,json!({"query":"query{currentUser{id features}}"})).await;
      assert!(ordinary.get("errors").is_none(),"verified account keeps ordinary access");
      assert!(helpers::gql(&other,target_session,json!({"query":"query{workspaces{id}}"})).await.get("errors").is_none(),"verified target retains ordinary authenticated access");
      assert!(!ordinary["data"]["currentUser"]["features"].as_array().unwrap().contains(&json!("Admin")));
      assert_eq!(sqlx::query_as::<_,(Uuid,chrono::DateTime<Utc>)>("SELECT id,expires_at FROM sessions WHERE id=$1 AND revoked_at IS NULL").bind(target_session).fetch_one(&pool).await.unwrap(),retained);
    }
    helpers::mcp::invoke(&app,&target_key,"user_get",json!({"id_or_email":target}),false).await;
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM api_keys WHERE user_id=$1").bind(target).fetch_one(&pool).await.unwrap(),1,"demotion keeps the key");
    let absent=helpers::gql(&app,session,json!({"query":"mutation($id:ID!){admin{setUserAdmin(userId:$id,isAdmin:true)}}","variables":{"id":missing}})).await;
    assert!(absent.get("errors").is_some());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM admin_audit_log WHERE target_id=$1 AND event_key='user.admin-role-set'").bind(missing.to_string()).fetch_one(&pool).await.unwrap(),0);
    let before=sqlx::query_scalar::<_,i64>("SELECT count(*) FROM admin_audit_log WHERE target_id=$1 AND event_key='user.admin-role-set'").bind(target.to_string()).fetch_one(&pool).await.unwrap();
    sqlx::query(&format!("CREATE FUNCTION {fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='{target}'::uuid THEN RAISE EXCEPTION 'owned role failure'; END IF; RETURN NEW; END $$")).execute(&pool).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER {fault} BEFORE UPDATE OF is_admin ON users FOR EACH ROW EXECUTE FUNCTION {fault}()")).execute(&pool).await.unwrap();
    let failed=helpers::gql(&app,session,json!({"query":"mutation($id:ID!){admin{setUserAdmin(userId:$id,isAdmin:true)}}","variables":{"id":target}})).await;
    assert!(failed.get("errors").is_some());
    assert!(!auth.get_user_by_id(target).await.unwrap().unwrap().is_admin);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM admin_audit_log WHERE target_id=$1 AND event_key='user.admin-role-set'").bind(target.to_string()).fetch_one(&pool).await.unwrap(),before);
    assert!(helpers::gql(&other,target_session,json!({"query":"query{currentUser{id}}"})).await.get("errors").is_none(),"rollback restores usable credentials");
    sqlx::query(&format!("DROP TRIGGER {fault} ON users")).execute(&pool).await.unwrap();
    sqlx::query(&format!("DROP FUNCTION {fault}()")).execute(&pool).await.unwrap();
    helpers::gql(&app,session,json!({"query":"mutation($id:ID!){admin{setUserAdmin(userId:$id,isAdmin:true)}}","variables":{"id":unverified}})).await;
    assert!(helpers::gql(&other,unverified_session,json!({"query":"query($id:String!){admin{userById(id:$id){id}}}","variables":{"id":unverified}})).await.get("errors").is_none());
    helpers::gql(&app,session,json!({"query":"mutation($id:ID!){admin{setUserAdmin(userId:$id,isAdmin:false)}}","variables":{"id":unverified}})).await;
    let restricted=helpers::gql(&other,unverified_session,json!({"query":"query{workspaces{id}}"})).await;
    assert_eq!(restricted["errors"][0]["extensions"]["type"],"EMAIL_VERIFICATION_REQUIRED");
    assert!(restricted.get("errors").is_some(),"demotion does not bypass unverified-account policy");

  }).catch_unwind().await;
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {fault} ON users"))
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {fault}()"))
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=ANY($1) OR target_id=ANY($2)")
    .bind(&[admin, target, unverified][..])
    .bind(vec![admin.to_string(), target.to_string(), unverified.to_string()])
    .execute(&pool)
    .await
    .unwrap();
  helpers::cleanup_users(&pool, &[admin, target, unverified]).await;
  for id in [admin, target, unverified, missing] {
    redis
      .delete_key(&format!("auth:user_session_epoch:{id}"))
      .await
      .unwrap();
  }
  for id in [session, target_session, unverified_session] {
    redis.delete_key(&format!("auth:session_snapshot:{id}")).await.unwrap();
  }
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}

#[tokio::test]
async fn account_deletion_ingresses_preserve_shared_content_rollback_and_fence_two_api_instances() {
  use myoxus_application::ports::RedisPort;
  use std::sync::Arc;
  let redis = Arc::new(
    myoxus_infrastructure::redis::RedisAdapter::new(
      std::env::var("TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".into()),
      format!("ua12-{}", Uuid::new_v4()),
    )
    .unwrap(),
  );
  let (app, pool, auth) = helpers::setup_app_with_mcp_audit_and_session_cache(redis.clone()).await;
  let (other, _, _) = helpers::setup_app_with_mcp_audit_and_session_cache(redis.clone()).await;
  let (admin, session) = helpers::seed_admin(&pool, &auth).await;
  let mut users = vec![admin];
  let mut spaces = Vec::new();
  let mut sessions = vec![session];
  let mut credential_ids = Vec::<Uuid>::new();
  let missing = Uuid::new_v4();
  let fault = format!("ua12_{}", Uuid::new_v4().simple());
  let outcome=AssertUnwindSafe(async {
    let operator_key=helpers::mcp::key(&app,session,&["read:users","write:users"]).await;
    for ingress in ["admin","mcp","self-service"] {
      let (target,target_session)=helpers::seed_admin(&pool,&auth).await;users.push(target);sessions.push(target_session);
      let sole=helpers::create_workspace(&pool,target).await; spaces.push(sole);
      let shared=helpers::create_workspace(&pool,target).await; spaces.push(shared);
      let sole_doc=helpers::create_doc(&pool,sole,target).await;
      let shared_doc=helpers::create_doc(&pool,shared,target).await;
      sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status,invited_by_user_id) VALUES($1,$2,'Admin','Accepted',$3)").bind(shared).bind(admin).bind(target).execute(&pool).await.unwrap();
      let target_key=helpers::mcp::key(&app,target_session,&["read:users","write:users"]).await;
      credential_ids.extend(sqlx::query_scalar::<_,Uuid>("SELECT id FROM api_keys WHERE user_id=$1").bind(target).fetch_all(&pool).await.unwrap());
      assert!(helpers::gql(&other,target_session,json!({"query":"query($id:String!){admin{userById(id:$id){id}} workspaces{id}}","variables":{"id":admin}})).await.get("errors").is_none(),"warm privileged identity on second API");
      assert_eq!(helpers::mcp::request(&other,&target_key,"tools/list",json!({})).await.0,axum::http::StatusCode::OK);
      if ingress=="admin" {
        sqlx::query(&format!("CREATE FUNCTION {fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='{target}'::uuid AND NEW.status='deleted' THEN RAISE EXCEPTION 'owned deletion rollback'; END IF; RETURN NEW; END $$")).execute(&pool).await.unwrap();
        sqlx::query(&format!("CREATE TRIGGER {fault} BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION {fault}()")).execute(&pool).await.unwrap();
        let failed=helpers::gql(&app,session,json!({"query":"mutation($id:String!){admin{deleteUser(id:$id){success}}}","variables":{"id":target}})).await;
        assert!(failed.get("errors").is_some());
        assert!(auth.get_user_by_id(target).await.unwrap().is_some());
        assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT owner_user_id FROM workspaces WHERE id=$1").bind(shared).fetch_one(&pool).await.unwrap(),target,"ownership rollback");
        assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT created_by FROM docs WHERE id=$1").bind(shared_doc).fetch_one(&pool).await.unwrap(),target,"authorship rollback");
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM docs WHERE id=$1").bind(sole_doc).fetch_one(&pool).await.unwrap(),1,"sole content rollback");
        assert!(helpers::gql(&other,target_session,json!({"query":"query($id:String!){admin{userById(id:$id){id}} workspaces{id}}","variables":{"id":admin}})).await.get("errors").is_none(),"rollback restores usable account credentials");
        assert_eq!(helpers::mcp::request(&other,&target_key,"tools/list",json!({})).await.0,axum::http::StatusCode::OK);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM admin_audit_log WHERE target_id=$1 AND event_key='user.delete'").bind(target.to_string()).fetch_one(&pool).await.unwrap(),0);
        sqlx::query(&format!("DROP TRIGGER {fault} ON users")).execute(&pool).await.unwrap();
        sqlx::query(&format!("DROP FUNCTION {fault}()")).execute(&pool).await.unwrap();
      }
      if ingress=="mcp" {
        let args=json!({"user_id":target,"confirmed_user_id":target,"idempotency_key":"delete-content"});
        let result=helpers::mcp::invoke(&app,&operator_key,"user_delete",args.clone(),true).await;
        assert_eq!(result,json!({"user_id":target,"deleted":true}));
        assert_eq!(helpers::mcp::invoke(&app,&operator_key,"user_delete",args,true).await,result,"replay returns known deletion");
      } else {
        let request=if ingress=="admin" {json!({"query":"mutation($id:String!){admin{deleteUser(id:$id){success}}}","variables":{"id":target}})}else{json!({"query":"mutation{deleteAccount{success}}"})};
        let result=helpers::gql(&app,if ingress=="admin" {session}else{target_session},request).await;
        assert!(result.get("errors").is_none(),"deletion ingress succeeds");
        assert_eq!(if ingress=="admin" {&result["data"]["admin"]["deleteUser"]["success"]}else{&result["data"]["deleteAccount"]["success"]},&json!(true));
      }
      assert!(auth.get_user_by_id(target).await.unwrap().is_none());
      assert!(auth.get_session(target_session).await.unwrap().is_none());
      assert_eq!(helpers::gql(&other,target_session,json!({"query":"query{currentUser{id}}"})).await["data"]["currentUser"],Value::Null,"warm identity cannot outlive deletion");
      assert!(helpers::gql(&other,target_session,json!({"query":"query($id:String!){admin{userById(id:$id){id}}}","variables":{"id":admin}})).await.get("errors").is_some());
      assert_eq!(helpers::mcp::request(&other,&target_key,"tools/list",json!({})).await.0,axum::http::StatusCode::UNAUTHORIZED);
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM workspaces WHERE id=$1").bind(sole).fetch_one(&pool).await.unwrap(),0);
      assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM docs WHERE id=$1").bind(sole_doc).fetch_one(&pool).await.unwrap(),0);
      assert_eq!(sqlx::query_as::<_,(Option<Uuid>,String,Option<Uuid>,bool)>("SELECT owner_user_id,owner_principal_type::text,owner_principal_id,is_personal_workspace FROM workspaces WHERE id=$1").bind(shared).fetch_one(&pool).await.unwrap(),(None,"system".into(),None,false));
      assert_eq!(sqlx::query_as::<_,(Option<Uuid>,Option<Uuid>)>("SELECT created_by,updated_by FROM docs WHERE id=$1").bind(shared_doc).fetch_one(&pool).await.unwrap(),(Some(target),Some(target)));
      assert_eq!(sqlx::query_scalar::<_,Option<Uuid>>("SELECT invited_by_user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2").bind(shared).bind(admin).fetch_one(&pool).await.unwrap(),Some(target));
      let events:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(a) FROM admin_audit_log a WHERE target_id=$1 AND event_key='user.delete'").bind(target.to_string()).fetch_all(&pool).await.unwrap();
      assert_eq!(events.len(),1,"one audit per known commit, including replay");
      let profile=auth.get_historical_profile(target).await.unwrap().unwrap();
      assert_eq!(events[0]["target_label"],json!(profile.name));
      assert!(profile.email.is_empty() && profile.avatar_url.is_none());
      let state=sqlx::query_as::<_,(String,String,bool,Option<String>,Option<String>)>("SELECT status,email,is_admin,password_hash,avatar_key FROM users WHERE id=$1").bind(target).fetch_one(&pool).await.unwrap();
      assert_eq!(state,("deleted".into(),format!("deleted:{target}"),false,None,None));
      let history=helpers::gql(&other,session,json!({"query":"query($id:String!){publicUserById(id:$id){id name avatarUrl}}","variables":{"id":target}})).await;
      assert!(history.get("errors").is_none());
      assert_eq!(history["data"]["publicUserById"]["id"],json!(target));
      assert_eq!(history["data"]["publicUserById"]["name"],json!(profile.name));
      assert!(history["data"]["publicUserById"]["avatarUrl"].is_null());
      let repeated=helpers::gql(&app,session,json!({"query":"mutation($id:String!){admin{deleteUser(id:$id){success}}}","variables":{"id":target}})).await;
      assert!(repeated.get("errors").is_some(),"fresh deletion cannot replay a retained account");
      if ingress=="self-service" {assert_eq!(events[0]["actor_user_id"],json!(target));assert_eq!(events[0]["metadata"]["actor_user_id"],json!(target));}
      let readback=helpers::gql(&other,session,json!({"query":"query($id:String!){admin{adminWorkspace(id:$id){id ownerPrincipalType ownerPrincipalId owner{id} isPersonal}}}","variables":{"id":shared}})).await;
      assert!(readback.get("errors").is_none());assert_eq!(readback["data"]["admin"]["adminWorkspace"]["ownerPrincipalType"],"system");
    }
    let absent=helpers::gql(&app,session,json!({"query":"mutation($id:String!){admin{deleteUser(id:$id){success}}}","variables":{"id":missing}})).await;
    assert!(absent.get("errors").is_some());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM admin_audit_log WHERE event_key='user.delete' AND target_id=$1").bind(missing.to_string()).fetch_one(&pool).await.unwrap(),0);
  }).catch_unwind().await;
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {fault} ON users"))
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {fault}()"))
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM workspaces WHERE id=ANY($1)")
    .bind(&spaces)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=ANY($1) OR target_id=ANY($2)")
    .bind(&users)
    .bind(
      users
        .iter()
        .chain(credential_ids.iter())
        .chain(std::iter::once(&missing))
        .map(ToString::to_string)
        .collect::<Vec<_>>(),
    )
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM users WHERE id=ANY($1)")
    .bind(&users)
    .execute(&pool)
    .await
    .unwrap();
  for id in users.into_iter().chain(std::iter::once(missing)) {
    redis
      .delete_key(&format!("auth:user_session_epoch:{id}"))
      .await
      .unwrap();
  }
  for id in sessions {
    redis.delete_key(&format!("auth:session_snapshot:{id}")).await.unwrap();
  }
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}

/// The persistence boundary must also fence trusted/background writers, without
/// relying on GraphQL/MCP admission. Every cleanup row is populated first.
#[tokio::test]
async fn terminal_account_repository_cleanup_guards_and_released_email_are_atomic() {
  use myoxus_application::auth::{MagicLinkOtp, NewConnectedAccount, UpdateAuthUser};
  let pool = helpers::setup_pool().await;
  let store = myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone());
  let target = Uuid::new_v4();
  let survivor = Uuid::new_v4();
  let ws = Uuid::new_v4();
  let doc = Uuid::new_v4();
  let comment = Uuid::new_v4();
  let org = Uuid::new_v4();
  let typ = Uuid::new_v4();
  let unit = Uuid::new_v4();
  let database = Uuid::new_v4();
  let row = Uuid::new_v4();
  let field = Uuid::new_v4();
  let view = Uuid::new_v4();
  let session = Uuid::new_v4();
  let key = Uuid::new_v4();
  let operation = Uuid::new_v4();
  let asset = Uuid::new_v4();
  let private_doc = Uuid::new_v4();
  let archived = Uuid::new_v4();
  let email = format!("terminal-{target}@example.test");
  let mut recreated = None;
  let outcome=AssertUnwindSafe(async {
    for (id,address) in [(target,email.clone()),(survivor,format!("survivor-{survivor}@example.test"))] {
      sqlx::query("INSERT INTO users(id,email,name,status) VALUES($1,$2,'Retained Author','disabled')").bind(id).bind(address).execute(&pool).await.unwrap();
    }
    for statement in [
      format!("INSERT INTO workspaces(id,name,owner_user_id) VALUES('{ws}','terminal shared','{target}')"),
      format!("INSERT INTO docs(id,userspace_owner_id,created_by) VALUES('{private_doc}','{target}','{target}')"),
      format!("INSERT INTO workspaces(id,name,owner_user_id,deleted_at) VALUES('{archived}','terminal archived','{target}',now())"),
      format!("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES('{archived}','{target}','Owner','Accepted'),('{archived}','{survivor}','Admin','Accepted')"),
      format!("INSERT INTO docs(id,workspace_id,created_by,updated_by,responsible_user_id) VALUES('{doc}','{ws}','{target}','{target}','{target}')"),
      format!("INSERT INTO comments(id,workspace_id,doc_id,author_id,body,last_edited_by,resolved_by,deleted_by) VALUES('{comment}','{ws}','{doc}','{target}','{{}}','{target}','{target}','{target}')"),
      format!("INSERT INTO comment_edit_history(comment_id,body,edited_by) VALUES('{comment}','{{}}','{target}')"),
      format!("INSERT INTO workspace_invite_links(workspace_id,created_by_user_id,token_hash) VALUES('{ws}','{target}','{target}')"),
      format!("INSERT INTO comment_attachments(workspace_id,doc_id,comment_id,created_by,storage_key,size_bytes) VALUES('{ws}','{doc}','{comment}','{target}','owned/{target}',4)"),
      format!("INSERT INTO pdf_icc_profiles(id,name,profile_type,blob_key,sha256,uploaded_by) VALUES('{asset}','owned terminal asset {target}','sRGB','owned/{target}','{target}','{target}')"),
      format!("INSERT INTO organization(id,key,name,slug) VALUES('{org}','{org}','owned terminal','{org}')"),
      format!("INSERT INTO organization_unit_type(id,organization_id,key,label,is_structural,can_have_children,can_be_root_level,can_be_manager_created,can_have_cross_unit_members,can_own_workspaces,can_manage_workspaces) VALUES('{typ}','{org}','terminal','terminal',false,false,true,false,true,true,true)"),
      format!("INSERT INTO organization_unit(id,organization_id,unit_type_id,name,slug) VALUES('{unit}','{org}','{typ}','terminal','terminal')"),
      format!("INSERT INTO workspace_databases(id,workspace_id,title,created_by) VALUES('{database}','{ws}','terminal','{target}')"),
      format!("INSERT INTO workspace_database_fields(id,database_id,name,field_type,position) VALUES('{field}','{database}','when','date_time',0)"),
      format!("INSERT INTO workspace_database_rows(id,database_id,title,position,created_by) VALUES('{row}','{database}','terminal',0,'{target}')"),
      format!("INSERT INTO workspace_database_views(id,database_id,name,view_kind,position) VALUES('{view}','{database}','terminal','table',0)"),
      format!("INSERT INTO workspace_content_operations(id,idempotency_id,actor_id,kind,source_workspace_id,status,manifest_hash) VALUES('{operation}','{operation}','{target}','copy','{ws}','succeeded',repeat('a',64))"),
      format!("INSERT INTO workspace_memberships(workspace_id,user_id,role,status,invited_by_user_id) VALUES('{ws}','{survivor}','Admin','Accepted','{target}')"),
      format!("INSERT INTO document_workspace_settings(workspace_id,default_responsible_user_id) VALUES('{ws}','{target}')"),
      format!("INSERT INTO organization_document_settings(organization_id,default_responsible_user_id) VALUES('{org}','{target}') ON CONFLICT(organization_id) DO UPDATE SET default_responsible_user_id=EXCLUDED.default_responsible_user_id"),
    ] {sqlx::query(&statement).execute(&pool).await.unwrap();}
    let history: i64=sqlx::query_scalar("INSERT INTO doc_histories(workspace_id,doc_id,snapshot,actor_id) VALUES($1,$2,$3,$4) RETURNING id").bind(ws).bind(doc).bind(vec![1u8,2,3]).bind(target).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO document_version(doc_id,workspace_id,doc_history_id,label,created_by,version_no) VALUES($1,$2,$3,'retained',$4,1)").bind(doc).bind(ws).bind(history).bind(target).execute(&pool).await.unwrap();
    let reminder_id=Uuid::new_v4();
    let statements=vec![
      ("sessions","user_id",format!("INSERT INTO sessions(id,user_id,expires_at,refresh_after) VALUES('{session}','{target}',now()+interval '1 hour',now())")),
      ("session_links","user_id",format!("INSERT INTO session_links(session_id,root_session_id,user_id) VALUES('{session}','{session}','{target}')")),
      ("access_tokens","user_id",format!("INSERT INTO access_tokens(user_id,name,token_hash) VALUES('{target}','owned','{target}')")),
      ("api_keys","user_id",format!("INSERT INTO api_keys(id,user_id,name,key_hash) VALUES('{key}','{target}','owned','{target}')")),
      ("verification_tokens","user_id",format!("INSERT INTO verification_tokens(user_id,kind,token_hash,email,expires_at) VALUES('{target}','OpenAppSignIn','app-{target}','{email}',now()+interval '1 hour')")),
      ("connected_accounts","user_id",format!("INSERT INTO connected_accounts(user_id,provider,provider_account_id) VALUES('{target}','owned','{target}')")),
      ("mcp_idempotency_keys","user_id",format!("INSERT INTO mcp_idempotency_keys(id,api_key_id,user_id,tool_name,idempotency_key,payload_sha256) VALUES('{key}','{key}','{target}','owned','owned',repeat('a',64))")),
      ("user_features","user_id",format!("INSERT INTO user_features(user_id,feature_name) VALUES('{target}','manager')")),
      ("user_preferences","user_id",format!("INSERT INTO user_preferences(user_id) VALUES('{target}')")),
      ("workspace_memberships","user_id",format!("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES('{ws}','{target}','Owner','Accepted')")),
      ("organization_unit_member","user_id",format!("INSERT INTO organization_unit_member(unit_id,user_id,role) VALUES('{unit}','{target}','manager')")),
      ("doc_user_permissions","user_id",format!("INSERT INTO doc_user_permissions(doc_id,user_id,role) VALUES('{doc}','{target}','Owner')")),
      ("comment_thread_read_state","user_id",format!("INSERT INTO comment_thread_read_state(user_id,thread_comment_id,read_at) VALUES('{target}','{comment}',now())")),
      ("database_row_reminders","user_id",format!("WITH scheduled AS (INSERT INTO scheduling_schedules(id,workspace_id,actor_id,admission_zone,target_json,next_nominal,next_due_at,next_admission_at) VALUES('{reminder_id}','{ws}','{target}','UTC',jsonb_build_object('kind','database_reminder','reminder_id','{reminder_id}'),jsonb_build_object('kind','local_date_time','value',((now()+interval '1 hour') AT TIME ZONE 'UTC')),now()+interval '1 hour',now()+interval '1 hour') RETURNING id) INSERT INTO database_row_reminders(id,workspace_id,database_id,row_id,field_id,user_id,offset_minutes) SELECT id,'{ws}','{database}','{row}','{field}','{target}',0 FROM scheduled")),
      ("database_view_user_states","user_id",format!("INSERT INTO database_view_user_states(view_id,user_id) VALUES('{view}','{target}')")),
      ("notifications","user_id",format!("INSERT INTO notifications(user_id,notification_type) VALUES('{target}','owned')")),
      ("workspace_member_last_access","user_id",format!("INSERT INTO workspace_member_last_access(workspace_id,user_id,last_accessed_at) VALUES('{ws}','{target}',now())")),
      ("workspace_content_operation_recipient_outbox","recipient_id",format!("INSERT INTO workspace_content_operation_recipient_outbox(operation_id,recipient_id,event_kind,resource_count,recipient_snapshot_revision,source_workspace_id,source_workspace_name,actor_id,published_at) VALUES('{operation}','{target}','owned',0,'owned','{ws}','owned','{target}',now())")),
      ("document_history_capture_request","actor_id",format!("INSERT INTO document_history_capture_request(actor_id,workspace_id,doc_id,request_key,request_fingerprint,history_id) VALUES('{target}','{ws}','{doc}','{target}',decode('aa','hex'),{history})")),
      ("calendar_accounts","user_id",format!("INSERT INTO calendar_accounts(user_id,provider,remote_account_id) VALUES('{target}','owned','{target}')")),
      ("copilot_contexts","user_id",format!("INSERT INTO copilot_contexts(user_id,workspace_id,name) VALUES('{target}','{ws}','owned')")),
      ("copilot_jobs","user_id",format!("INSERT INTO copilot_jobs(user_id,workspace_id,job_type,state) VALUES('{target}','{ws}','owned','queued')")),
      ("copilot_sessions","user_id",format!("INSERT INTO copilot_sessions(user_id,workspace_id,title) VALUES('{target}','{ws}','owned')")),
      ("git_sync_profiles","owner_id",format!("INSERT INTO git_sync_profiles(owner_id,workspace_id,repo_url) VALUES('{target}','{ws}','https://owned.invalid/repo')")),
      ("telemetry_events","user_id",format!("INSERT INTO telemetry_events(user_id,event_id,event_name,category,schema_version,client_timestamp) VALUES('{target}','{target}','owned','owned',1,now())")),
      ("workspace_imports","actor_id",format!("INSERT INTO workspace_imports(id,actor_id,status,staging_object_key,config_fingerprint,expires_at) VALUES('{target}','{target}','staged','owned/{target}','owned',now()+interval '1 hour')")),
    ];
    for (table,_,statement) in &statements {sqlx::query(statement).execute(&pool).await.unwrap_or_else(|e|panic!("populate {table}: {e}"));}
    let otp_token=store.create_verification_token(Some(target),"SignIn",&format!("otp-{target}"),Some(&email),Utc::now()+chrono::Duration::hours(1),None).await.unwrap();
    store.upsert_magic_link_otp(MagicLinkOtp{email:email.clone(),otp:"123456".into(),verification_token_id:otp_token.id,client_nonce:None,expires_at:Utc::now()+chrono::Duration::hours(1)}).await.unwrap();
    store.create_verification_token(None,"SignIn",&format!("unbound-{target}"),Some(&email),Utc::now()+chrono::Duration::hours(1),None).await.unwrap();
    store.create_verification_token(Some(target),"ChangePassword",&format!("reset-{target}"),Some(&email),Utc::now()+chrono::Duration::hours(1),None).await.unwrap();
    let workspace_revision:i64=sqlx::query_scalar("SELECT metadata_revision FROM document_workspace_settings WHERE workspace_id=$1").bind(ws).fetch_one(&pool).await.unwrap();
    let organization_revision:i64=sqlx::query_scalar("SELECT metadata_revision FROM organization_document_settings WHERE organization_id=$1").bind(org).fetch_one(&pool).await.unwrap();
    store.set_user_disabled(target,false).await.unwrap();
    // Hold the account lock to admit the deletion and concurrent credential /
    // OU / workspace / document grants together. Either a grant commits first
    // and is removed, or it loses to deletion and the persisted guard denies it.
    let mut lock=pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE").bind(target).execute(&mut *lock).await.unwrap();
    let deletion_store=store.clone();
    let deletion=tokio::spawn(async move {deletion_store.commit_user_deletion(target).await});
    let mut writers=Vec::new();
    for statement in [
      format!("INSERT INTO access_tokens(user_id,name,token_hash) VALUES('{target}','race','race-{target}')"),
      format!("INSERT INTO organization_unit_member(unit_id,user_id,role) VALUES('{unit}','{target}','manager') ON CONFLICT(unit_id,user_id) DO UPDATE SET role='manager'"),
      format!("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES('{ws}','{target}','Reader','Accepted') ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='Reader'"),
      format!("INSERT INTO doc_user_permissions(doc_id,user_id,role) VALUES('{doc}','{target}','Reader') ON CONFLICT(doc_id,user_id) DO UPDATE SET role='Reader'"),
    ] {let pool=pool.clone(); writers.push(tokio::spawn(async move {sqlx::query(&statement).execute(&pool).await}));}
    lock.commit().await.unwrap();
    let commit=tokio::time::timeout(std::time::Duration::from_secs(20),deletion).await.expect("deletion cannot deadlock with grant writers").unwrap().unwrap();
    for writer in writers {
      if let Err(error)=tokio::time::timeout(std::time::Duration::from_secs(20),writer).await.expect("writer completes").unwrap() {
        assert!(error.as_database_error().is_some_and(|e|e.constraint()==Some("account_reference_not_operational")),"stable denial instead of deadlock or unrelated SQL failure: {error}");
      }
    }
    assert_eq!(commit.user.id,target); assert!(commit.user.email.is_empty());
    assert_eq!(commit.revoked_session_ids,vec![session]); assert_eq!(commit.deleted_api_key_ids,vec![key]);
    assert!(store.commit_user_deletion(target).await.is_err());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM docs WHERE id=$1").bind(private_doc).fetch_one(&pool).await.unwrap(),0);
    assert!(sqlx::query_scalar::<_,bool>("SELECT owner_user_id IS NULL AND owner_principal_type='system' AND deleted_at IS NOT NULL FROM workspaces WHERE id=$1").bind(archived).fetch_one(&pool).await.unwrap());
    for (table,column,statement) in &statements {
      let count:i64=sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE {column}=$1")).bind(target).fetch_one(&pool).await.unwrap();
      assert_eq!(count,0,"cleanup {table}");
      let error=sqlx::query(statement).execute(&pool).await.unwrap_err();
      assert!(error.as_database_error().is_some_and(|e|e.constraint()==Some("account_reference_not_operational")),"{table} denies at terminal account guard: {error}");
    }
    // Changing an existing operational reference must be guarded too; every
    // table retains a valid suspended-account control record for this check.
    for (table,column,statement) in &statements {
      if *table!="workspace_memberships" {sqlx::query(&statement.replace(&target.to_string(),&survivor.to_string())).execute(&pool).await.unwrap_or_else(|e|panic!("control {table}: {e}"));}
      let error=sqlx::query(&format!("UPDATE {table} SET {column}=$1 WHERE {column}=$2")).bind(target).bind(survivor).execute(&pool).await.unwrap_err();
      assert!(error.as_database_error().is_some_and(|e|e.constraint()==Some("account_reference_not_operational")),"update {table}: {error}");
    }
    assert!(store.get_magic_link_otp(&email,"123456").await.unwrap().is_none());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM verification_tokens WHERE email=$1").bind(&email).fetch_one(&pool).await.unwrap(),0);
    assert_eq!(sqlx::query_as::<_,(Option<Uuid>,Option<Uuid>)>("SELECT created_by,updated_by FROM docs WHERE id=$1").bind(doc).fetch_one(&pool).await.unwrap(),(Some(target),Some(target)));
    assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT author_id FROM comments WHERE id=$1").bind(comment).fetch_one(&pool).await.unwrap(),target);
    assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT edited_by FROM comment_edit_history WHERE comment_id=$1").bind(comment).fetch_one(&pool).await.unwrap(),target);
    assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT created_by_user_id FROM workspace_invite_links WHERE workspace_id=$1").bind(ws).fetch_one(&pool).await.unwrap(),target);
    assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT created_by FROM comment_attachments WHERE workspace_id=$1").bind(ws).fetch_one(&pool).await.unwrap(),target);
    assert_eq!(sqlx::query_scalar::<_,Option<Uuid>>("SELECT uploaded_by FROM pdf_icc_profiles WHERE id=$1").bind(asset).fetch_one(&pool).await.unwrap(),Some(target));
    assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT created_by FROM document_version WHERE doc_id=$1").bind(doc).fetch_one(&pool).await.unwrap(),target);
    assert_eq!(sqlx::query_scalar::<_,Vec<u8>>("SELECT snapshot FROM doc_histories WHERE id=$1").bind(history).fetch_one(&pool).await.unwrap(),vec![1,2,3]);
    for statement in [format!("SELECT default_responsible_user_id IS NULL AND metadata_revision>{workspace_revision} FROM document_workspace_settings WHERE workspace_id='{ws}'"),format!("SELECT default_responsible_user_id IS NULL AND metadata_revision>{organization_revision} FROM organization_document_settings WHERE organization_id='{org}'")] {
      assert!(sqlx::query_scalar::<_,bool>(&statement).fetch_one(&pool).await.unwrap());
    }
    assert!(sqlx::query_scalar::<_,bool>("SELECT responsible_user_id IS NULL FROM docs WHERE id=$1").bind(doc).fetch_one(&pool).await.unwrap());
    for statement in [format!("UPDATE users SET status='active' WHERE id='{target}'"),format!("UPDATE users SET name='changed' WHERE id='{target}'"),format!("UPDATE users SET email='{email}' WHERE id='{target}'"),format!("UPDATE docs SET responsible_user_id='{target}' WHERE id='{doc}'"),format!("UPDATE workspaces SET owner_user_id='{target}' WHERE id='{ws}'")] {
      let error=sqlx::query(&statement).execute(&pool).await.unwrap_err();
      assert!(error.as_database_error().is_some_and(|e|e.constraint()==Some("account_reference_not_operational")));
    }
    use myoxus_application::admin::AdminStore;
    let admin_store=myoxus_infrastructure::admin::SqlxAdminStore::new(pool.clone());
    assert!(AdminStore::get_user_by_id(&admin_store,target).await.unwrap().is_none());
    assert!(AdminStore::get_user_by_email(&admin_store,&email).await.unwrap().is_none());
    assert!(admin_store.list_users(0,10,Some(email.clone())).await.unwrap().is_empty());
    assert_eq!(admin_store.count_users(Some(email.clone())).await.unwrap(),0);
    assert!(admin_store.search_users(&email,None,10).await.unwrap().is_empty());
    assert!(admin_store.search_users(&email,Some(&["manager".into()]),10).await.unwrap().is_empty());
    assert!(store.set_user_feature_override(target,"manager",true,"terminal test").await.is_err());
    use myoxus_domain::{entities::{CalendarAccount,CopilotJob,CopilotJobState,OrganizationUnitMember,OrganizationUnitRole,OrganizationUnitMemberSource},repositories::{CalendarRepository,CopilotRepository,OrganizationUnitMemberRepository,RepositoryError}};
    let now=Utc::now();
    let calendar=myoxus_infrastructure::calendar::SqlxCalendarRepository::new(pool.clone());
    let account=CalendarAccount{id:Uuid::new_v4(),user_id:target,provider:"owned".into(),remote_account_id:target.to_string(),access_token_ciphertext:None,refresh_token_ciphertext:None,expires_at:None,config:json!({}),created_at:now,updated_at:now};
    assert!(matches!(calendar.upsert_calendar_account(&account).await,Err(RepositoryError::NotFound("user"))));
    let copilot=myoxus_infrastructure::copilot::SqlxCopilotRepository::new(pool.clone());
    let job=CopilotJob{id:Uuid::new_v4(),job_type:"owned".into(),state:CopilotJobState::Pending,workspace_id:Some(ws),user_id:Some(target),payload:json!({}),error_message:None,created_at:now,updated_at:now};
    assert!(matches!(copilot.create_copilot_job(&job).await,Err(RepositoryError::NotFound("user"))));
    let members=myoxus_infrastructure::organization::PgOrganizationUnitMemberRepository::new(pool.clone());
    let member=OrganizationUnitMember{unit_id:unit,user_id:target,role:OrganizationUnitRole::Manager,source:OrganizationUnitMemberSource::Manual,metadata:json!({}),created_at:now,updated_at:now};
    assert!(matches!(members.upsert(&member).await,Err(RepositoryError::NotFound(_))));
    assert!(store.set_user_disabled(target,false).await.is_err());
    assert!(store.set_user_disabled(target,true).await.is_err());
    assert!(store.update_user(target,UpdateAuthUser{ name:Some(Some("changed".into())),..Default::default()}).await.is_err());
    assert!(store.commit_password_update(target,"hash".into(),Utc::now()).await.is_err());
    assert!(store.commit_user_admin_role(target,true).await.is_err());
    assert!(store.set_email_verified(target,Utc::now()).await.is_err());
    assert!(store.create_connected_account(NewConnectedAccount{user_id:target,provider:"owned".into(),provider_account_id:target.to_string(),access_token:None,refresh_token:None,expires_at:None}).await.is_err());
    let new=store.fulfill_user(&email,Some("New account"),None).await.unwrap(); recreated=Some(new.id);
    assert_ne!(new.id,target); assert!(!new.is_admin);
    assert!(store.get_workspace_role(new.id,ws).await.unwrap().is_none());
    assert!(store.get_doc_role(new.id,doc).await.unwrap().is_none());
    assert!(store.consume_magic_link_otp(&email,"123456",None,Utc::now()).await.is_err());
    assert!(store.commit_password_reset(&format!("reset-{target}"),"hash".into(),Utc::now()).await.is_err());
    assert!(store.get_verification_token(&format!("app-{target}")).await.unwrap().is_none());
    assert!(store.fulfill_user(&format!("deleted:{target}"),None,None).await.is_err());
    let historic=store.get_historical_profile(target).await.unwrap().unwrap();
    assert_eq!(historic.name.as_deref(),Some("Retained Author")); assert!(historic.email.is_empty() && historic.avatar_url.is_none());
    assert!(!store.set_user_disabled(survivor,false).await.unwrap().disabled);
    // A surviving historical creator may still author historical records.
    sqlx::query("INSERT INTO comment_edit_history(comment_id,body,edited_by) VALUES($1,'{}',$2)").bind(comment).bind(target).execute(&pool).await.unwrap();
  }).catch_unwind().await;
  sqlx::query("DELETE FROM workspace_content_operations WHERE id=$1")
    .bind(operation)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM workspaces WHERE id=ANY($1)")
    .bind(&[ws, archived][..])
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM organization_unit WHERE id=$1")
    .bind(unit)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM organization_unit_type WHERE id=$1")
    .bind(typ)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM organization WHERE id=$1")
    .bind(org)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM pdf_icc_profiles WHERE id=$1")
    .bind(asset)
    .execute(&pool)
    .await
    .unwrap();
  let mut users = vec![target, survivor];
  users.extend(recreated);
  sqlx::query("DELETE FROM magic_link_otps WHERE email=$1")
    .bind(&email)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM verification_tokens WHERE email=$1")
    .bind(&email)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query("DELETE FROM users WHERE id=ANY($1)")
    .bind(&users)
    .execute(&pool)
    .await
    .unwrap();
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}
