//! Phase-2 compatibility tests verifying the full GraphQL schema surface matches the original AFFiNE API.
use std::sync::Arc;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use myoxus_api::config::AppConfig;
use myoxus_api::state::ApiState;
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, AuthStore, AuthUser, InMemoryAuthStore};
use myoxus_application::doc::{DocService, PanicDocStore};
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::mail::LogMailAdapter;
use myoxus_infrastructure::storage::StorageAdapter;
use serde_json::{Value, json};
use tower::ServiceExt;

async fn setup_test_app() -> (axum::Router, Arc<InMemoryAuthStore>) {
  let config = AppConfig::load().expect("AppConfig::load failed");
  let store = Arc::new(InMemoryAuthStore::default());
  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("StorageAdapter::new_fs failed"));

  let auth_service = AuthService::new(store.clone(), mailer, storage.clone(), 3600, 3600);
  let workspace_service = WorkspaceService::new(store.clone());
  let admin_service = AdminService::new(Arc::new(InMemoryAdminStore));
  let doc_service = DocService::new(Arc::new(PanicDocStore));
  let blob_store = Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(
    sqlx::PgPool::connect_lazy("postgres://localhost").expect("PgPool::connect_lazy failed"),
  ));
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
  );

  (myoxus_api::build_router_for_integration_tests(state), store)
}

fn invite_token_from_url(invite_url: &str) -> &str {
  assert!(
    invite_url.starts_with("http://") || invite_url.starts_with("https://"),
    "InviteLink.link must be an absolute URL, got {invite_url}"
  );
  let (_, token) = invite_url
    .rsplit_once("/invite/")
    .expect("InviteLink.link must route to /invite/{token}");
  assert!(!token.is_empty(), "InviteLink.link must include a token");
  token
}

#[tokio::test]
async fn test_root_workspace_contract_compat() {
  let (app, store) = setup_test_app().await;
  let owner_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: owner_id,
    email: "owner@example.com".to_string(),
    name: Some("Owner".to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  let owner_session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: owner_id,
      csrf_token: "csrf".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("test setup");

  let create_workspace = r#"{"query":"mutation { createWorkspace { id } }"}"#;
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", owner_session.id))
        .body(Body::from(create_workspace))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  let workspace_id = json["data"]["createWorkspace"]["id"]
    .as_str()
    .expect("expected JSON string field")
    .to_string();

  let invite_link_query = json!({
      "query": format!(
          "mutation {{ createInviteLink(workspaceId:\"{}\", expireTime: OneDay) {{ link expireTime }} }}",
          workspace_id
      )
  });
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", owner_session.id))
        .body(Body::from(invite_link_query.to_string()))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  assert!(
    json.get("errors").is_none(),
    "createInviteLink returned errors: {}",
    json
  );
  let invite_link = json["data"]["createInviteLink"]["link"]
    .as_str()
    .expect("expected JSON string field")
    .to_string();
  let invite_token = invite_token_from_url(&invite_link).to_string();

  let workspace_query = json!({
      "query": format!(
          "query {{ workspace(id:\"{}\") {{ permissions {{ Workspace_Read Workspace_Users_Read }} inviteLink {{ link expireTime }} }} }}",
          workspace_id
      )
  });
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", owner_session.id))
        .body(Body::from(workspace_query.to_string()))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  assert!(
    json["data"]["workspace"]["permissions"]["Workspace_Read"]
      .as_bool()
      .expect("test setup")
  );
  assert_eq!(
    json["data"]["workspace"]["inviteLink"]["link"].as_str(),
    Some(invite_link.as_str())
  );

  let get_invite_info = json!({
      "query": format!(
          "query {{ getInviteInfo(inviteId:\"{}\") {{ workspace {{ id }} }} }}",
          invite_token
      )
  });
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .body(Body::from(get_invite_info.to_string()))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  assert_eq!(
    json["data"]["getInviteInfo"]["workspace"]["id"].as_str(),
    Some(workspace_id.as_str())
  );

  let features_query = r#"{"query":"query { currentUser { features } serverConfig { type deploymentType credentialsRequirement { password { minLength maxLength } } } }"}"#;
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", owner_session.id))
        .body(Body::from(features_query))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  assert!(
    json.get("errors").is_none(),
    "features/serverConfig query failed: {}",
    json
  );
  assert!(json["data"]["currentUser"]["features"].is_array());
  assert_eq!(json["data"]["serverConfig"]["deploymentType"], "Standalone");
  assert_eq!(json["data"]["serverConfig"]["type"], "Standalone");
}

#[tokio::test]
async fn test_member_management_contract_edges() {
  let (app, store) = setup_test_app().await;
  let owner_id = uuid::Uuid::new_v4();
  let member_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: owner_id,
    email: "owner2@example.com".to_string(),
    name: Some("Owner2".to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  store.insert_user(AuthUser {
    id: member_id,
    email: "member2@example.com".to_string(),
    name: Some("Member2".to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  let owner_session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: owner_id,
      csrf_token: "csrf1".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("test setup");
  let member_session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: member_id,
      csrf_token: "csrf2".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("test setup");

  let create_workspace = r#"{"query":"mutation { createWorkspace { id } }"}"#;
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", owner_session.id))
        .body(Body::from(create_workspace))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  let workspace_id = json["data"]["createWorkspace"]["id"]
    .as_str()
    .expect("expected JSON string field")
    .to_string();

  let invite_query = json!({
      "query": format!(
          "mutation {{ inviteMembers(workspaceId:\"{}\", emails:[\"member2@example.com\"]) {{ inviteId sentSuccess }} }}",
          workspace_id
      )
  });
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", owner_session.id))
        .body(Body::from(invite_query.to_string()))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  let invite_id = json["data"]["inviteMembers"][0]["inviteId"]
    .as_str()
    .expect("test setup")
    .to_string();

  let wrong_accept = json!({
      "query": format!(
          "mutation {{ acceptInviteById(workspaceId:\"{}\", inviteId:\"{}\") }}",
          uuid::Uuid::new_v4(),
          invite_id
      )
  });
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", member_session.id))
        .body(Body::from(wrong_accept.to_string()))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  assert!(json.get("errors").is_some(), "workspace mismatch must fail");

  let accept = json!({
      "query": format!(
          "mutation {{ acceptInviteById(workspaceId:\"{}\", inviteId:\"{}\") }}",
          workspace_id,
          invite_id
      )
  });
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", member_session.id))
        .body(Body::from(accept.to_string()))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  assert_eq!(json["data"]["acceptInviteById"].as_bool(), Some(true));

  let grant = json!({
      "query": format!(
          "mutation {{ grantMember(workspaceId:\"{}\", userId:\"{}\", permission: Admin) }}",
          workspace_id, member_id
      )
  });
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", owner_session.id))
        .body(Body::from(grant.to_string()))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  assert_eq!(json["data"]["grantMember"].as_bool(), Some(true));

  let revoke_self = json!({
      "query": format!(
          "mutation {{ revokeMember(workspaceId:\"{}\", userId:\"{}\") }}",
          workspace_id, owner_id
      )
  });
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", owner_session.id))
        .body(Body::from(revoke_self.to_string()))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  assert!(json.get("errors").is_some(), "self-revoke must fail");

  let leave = json!({
      "query": format!(
          "mutation {{ leaveWorkspace(workspaceId:\"{}\") }}",
          workspace_id
      )
  });
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", member_session.id))
        .body(Body::from(leave.to_string()))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  assert_eq!(json["data"]["leaveWorkspace"].as_bool(), Some(true));
}

#[tokio::test]
async fn test_root_invite_alias_and_revealed_tokens_contract() {
  let (app, store) = setup_test_app().await;
  let owner_id = uuid::Uuid::new_v4();
  let member_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: owner_id,
    email: "owner3@example.com".to_string(),
    name: Some("Owner3".to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  store.insert_user(AuthUser {
    id: member_id,
    email: "member3@example.com".to_string(),
    name: Some("Member3".to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  let owner_session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: owner_id,
      csrf_token: "csrf3".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("test setup");
  let member_session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: member_id,
      csrf_token: "csrf4".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("test setup");

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", owner_session.id))
        .body(Body::from(r#"{"query":"mutation { createWorkspace { id } }"}"#))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  let workspace_id = json["data"]["createWorkspace"]["id"]
    .as_str()
    .expect("expected JSON string field")
    .to_string();

  let create_link = json!({
      "query": format!(
          "mutation {{ createWorkspaceInviteLink(workspaceId:\"{}\", expireTime:86400000) {{ workspaceId inviteId expireTime }} }}",
          workspace_id
      )
  });
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", owner_session.id))
        .body(Body::from(create_link.to_string()))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  assert!(
    json.get("errors").is_none(),
    "createWorkspaceInviteLink failed: {}",
    json
  );
  let invite_id = json["data"]["createWorkspaceInviteLink"]["inviteId"]
    .as_str()
    .expect("test setup")
    .to_string();

  let accept_link = json!({
      "query": format!(
          "mutation {{ acceptWorkspaceInvite(workspaceId:\"{}\", inviteId:\"{}\") }}",
          workspace_id, invite_id
      )
  });
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", member_session.id))
        .body(Body::from(accept_link.to_string()))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  assert_eq!(json["data"]["acceptWorkspaceInvite"].as_bool(), Some(true));

  let revoke_link = json!({
      "query": format!(
          "mutation {{ revokeWorkspaceInviteLink(workspaceId:\"{}\") }}",
          workspace_id
      )
  });
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", owner_session.id))
        .body(Body::from(revoke_link.to_string()))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  assert_eq!(json["data"]["revokeWorkspaceInviteLink"].as_bool(), Some(true));

  let revealed = r#"{"query":"query { revealedAccessTokens { id name token } }"}"#;
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", owner_session.id))
        .body(Body::from(revealed))
        .expect("test setup"),
    )
    .await
    .expect("test setup");
  let body = response
    .into_body()
    .collect()
    .await
    .expect("collect body failed")
    .to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse failed");
  assert!(json.get("errors").is_none(), "revealedAccessTokens failed: {}", json);
  assert!(json["data"]["revealedAccessTokens"].is_array());
}
