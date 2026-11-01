//! Integration tests for the authenticated GraphQL surface (session extraction, token validation).
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use myoxus_api::config::AppConfig;
use myoxus_api::state::ApiState;
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, AuthStore, AuthUser, InMemoryAuthStore};
use myoxus_application::doc::DocService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::mail::LogMailAdapter;
use myoxus_infrastructure::storage::StorageAdapter;
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;

#[derive(Debug, Default)]
struct MockWorkspaceStore;

#[async_trait::async_trait]
impl myoxus_application::workspace::WorkspaceStore for MockWorkspaceStore {
  async fn has_accepted_member(
    &self,
    _workspace_id: uuid::Uuid,
    _user_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<bool> {
    Err(myoxus_application::auth::AuthError::Storage(
      "member lookup is not provisioned in this auth fixture".into(),
    ))
  }
  async fn accepted_member_by_email(
    &self,
    _workspace_id: uuid::Uuid,
    _email: &str,
  ) -> myoxus_application::auth::AuthResult<Option<uuid::Uuid>> {
    Err(myoxus_application::auth::AuthError::Storage(
      "member lookup is not provisioned in this auth fixture".into(),
    ))
  }
  async fn accepted_members_for_lookup(
    &self,
    _workspace_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Vec<myoxus_domain::entities::WorkspaceMemberLookupRow>> {
    Err(myoxus_application::auth::AuthError::Storage(
      "member lookup is not provisioned in this auth fixture".into(),
    ))
  }

  async fn create_workspace(
    &self,
    _owner_id: uuid::Uuid,
    _name: myoxus_application::workspace::WorkspaceName,
  ) -> myoxus_application::auth::AuthResult<myoxus_domain::entities::Workspace> {
    unimplemented!()
  }
  async fn get_workspace(
    &self,
    _workspace_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_domain::entities::Workspace>> {
    Ok(None)
  }
  async fn workspace_classification(
    &self,
    _workspace_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_application::workspace::WorkspaceClassification>> {
    Ok(None)
  }
  async fn list_user_workspaces(
    &self,
    _user_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Vec<myoxus_domain::entities::Workspace>> {
    Ok(vec![])
  }
  async fn update_workspace(
    &self,
    _workspace_id: uuid::Uuid,
    _update: myoxus_application::workspace::UpdateWorkspace,
  ) -> myoxus_application::auth::AuthResult<myoxus_domain::entities::Workspace> {
    unimplemented!()
  }
  async fn delete_workspace(&self, _workspace_id: uuid::Uuid) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }
  async fn list_workspace_members(
    &self,
    _workspace_id: uuid::Uuid,
    _skip: i64,
    _take: i64,
    _query: Option<String>,
  ) -> myoxus_application::auth::AuthResult<Vec<myoxus_domain::entities::WorkspaceMember>> {
    Ok(vec![])
  }
  async fn count_workspace_members(&self, _workspace_id: uuid::Uuid) -> myoxus_application::auth::AuthResult<i64> {
    Ok(0)
  }
  async fn get_workspace_owner(
    &self,
    _workspace_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_domain::entities::User>> {
    Ok(None)
  }
  async fn add_or_update_member(
    &self,
    _workspace_id: uuid::Uuid,
    _user_id: uuid::Uuid,
    _role: myoxus_domain::entities::WorkspaceRole,
    _status: myoxus_domain::entities::MembershipStatus,
    _inviter_id: Option<uuid::Uuid>,
  ) -> myoxus_application::auth::AuthResult<myoxus_domain::entities::WorkspaceMember> {
    unimplemented!()
  }
  async fn get_member(
    &self,
    _workspace_id: uuid::Uuid,
    _user_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_domain::entities::WorkspaceMember>> {
    Ok(None)
  }
  async fn get_member_by_invite_id(
    &self,
    _invite_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_domain::entities::WorkspaceMember>> {
    Ok(None)
  }
  async fn delete_member(
    &self,
    _workspace_id: uuid::Uuid,
    _user_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }
  async fn update_member_role(
    &self,
    _workspace_id: uuid::Uuid,
    _user_id: uuid::Uuid,
    _role: myoxus_domain::entities::WorkspaceRole,
  ) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }
  async fn transfer_ownership(
    &self,
    _workspace_id: uuid::Uuid,
    _current_owner_id: uuid::Uuid,
    _new_owner_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }
  async fn create_invite_link(
    &self,
    _workspace_id: uuid::Uuid,
    _inviter_id: uuid::Uuid,
    _token_hash: &str,
    _expire_at: chrono::DateTime<chrono::Utc>,
  ) -> myoxus_application::auth::AuthResult<myoxus_domain::entities::WorkspaceInviteLink> {
    unimplemented!()
  }
  async fn get_invite_link(
    &self,
    _workspace_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_domain::entities::WorkspaceInviteLink>> {
    Ok(None)
  }
  async fn get_invite_link_by_token(
    &self,
    _token_hash: &str,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_domain::entities::WorkspaceInviteLink>> {
    Ok(None)
  }
  async fn revoke_invite_link(&self, _workspace_id: uuid::Uuid) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }
  async fn init_workspace_root_doc(
    &self,
    _workspace_id: uuid::Uuid,
    _user_id: uuid::Uuid,
    _data: Vec<u8>,
  ) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }
  async fn workspace_root_doc_exists(&self, _workspace_id: uuid::Uuid) -> myoxus_application::auth::AuthResult<bool> {
    Ok(false)
  }
  async fn list_orphaned_workspaces(
    &self,
    _skip: i64,
    _take: i64,
  ) -> myoxus_application::auth::AuthResult<Vec<myoxus_domain::entities::Workspace>> {
    Ok(vec![])
  }
  async fn count_orphaned_workspaces(&self) -> myoxus_application::auth::AuthResult<i64> {
    Ok(0)
  }
  async fn reassign_workspace_owner(
    &self,
    _workspace_id: uuid::Uuid,
    _new_owner_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }
  async fn find_personal_workspace(
    &self,
    _user_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_domain::entities::Workspace>> {
    Ok(None)
  }
}

async fn setup_test_app() -> (axum::Router, Arc<InMemoryAuthStore>) {
  let mut config = AppConfig::load().expect("AppConfig::load");
  // Force a predictable origin so callback URL validation in tests uses localhost:3001.
  config.server.origin = "http://localhost:3001".to_string();
  let store = Arc::new(InMemoryAuthStore::default());
  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("HTTP request failed"));

  let auth_service = AuthService::new(store.clone(), mailer, storage.clone(), 3600, 3600);
  let workspace_store = Arc::new(MockWorkspaceStore);
  let workspace_service = WorkspaceService::new(workspace_store);
  let admin_service = AdminService::new(Arc::new(InMemoryAdminStore));
  let doc_service = DocService::new(Arc::new(myoxus_application::doc::PanicDocStore));
  let blob_store = Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(
    sqlx::PgPool::connect_lazy("postgres://localhost").expect("DB operation"),
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

#[tokio::test]
async fn test_graphql_current_user_query() {
  let (app, store) = setup_test_app().await;
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: "gql@example.com".to_string(),
    name: Some("GQL User".to_string()),
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: None,
    registered: true,
  });

  let session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id,
      csrf_token: "csrf123".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("create session");

  let query = r#"{"query": "{ auth { currentUser { id email name } } }"}"#;
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::from(query))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert_eq!(json["data"]["auth"]["currentUser"]["email"], "gql@example.com");

  // Cookie compatibility: GraphQL accepts the legacy AFFiNE session alias too.
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_sid={}", session.id))
        .body(Body::from(query))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert_eq!(json["data"]["auth"]["currentUser"]["email"], "gql@example.com");

  // Legacy client compatibility: root-level field without auth namespace.
  let query = r#"{"query": "{ currentUser { id email name } }"}"#;
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::from(query))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert_eq!(json["data"]["currentUser"]["email"], "gql@example.com");
  let query = r#"{"query":"query { currentUser { features } }"}"#;
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::from(query))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  let features = json["data"]["currentUser"]["features"]
    .as_array()
    .expect("features array");
  assert!(!features.iter().any(|value| value == "Admin"));

  // Root-level email mutation should exist for legacy client contracts.
  let query = r#"{"query": "mutation { sendVerifyEmail(callbackUrl: \"http://localhost:3001/verify-email\") }"}"#;
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::from(query))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert_eq!(json["data"]["sendVerifyEmail"], true);
}

#[tokio::test]
async fn test_graphql_current_user_profile_contract_fields() {
  let (app, store) = setup_test_app().await;
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: "profile@example.com".to_string(),
    name: Some("Profile User".to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: true,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });

  let session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id,
      csrf_token: "csrf999".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("create session");

  let query = r#"{
      "query":"query { currentUser { id name email avatarUrl emailVerified features preferences { effectiveValues { receiveInvitationEmail receiveMentionEmail receiveCommentEmail } } quota { name blobLimit storageQuota historyPeriod memberLimit humanReadable { name blobLimit storageQuota historyPeriod memberLimit } } quotaUsage { storageQuota } copilot { quota { limit used } } } }"
    }"#;
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::from(query))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert!(json.get("errors").is_none(), "query failed: {}", json);
  assert_eq!(json["data"]["currentUser"]["email"], "profile@example.com");
  assert_eq!(json["data"]["currentUser"]["quota"]["name"], "Pro");
  assert_eq!(json["data"]["currentUser"]["quota"]["humanReadable"]["name"], "Pro");
  let features = json["data"]["currentUser"]["features"]
    .as_array()
    .expect("features array");
  assert!(features.iter().any(|value| value == "Admin"));
  assert!(json["data"]["currentUser"]["quota"]["memberLimit"].is_number());
  assert_eq!(
    json["data"]["currentUser"]["quota"]["memberLimit"].as_i64(),
    Some(i32::MAX as i64)
  );
  assert!(json["data"]["currentUser"]["copilot"]["quota"]["limit"].is_number());
  assert_eq!(
    json["data"]["currentUser"]["copilot"]["quota"]["limit"].as_i64(),
    Some(i64::MAX)
  );
  assert_eq!(
    json["data"]["currentUser"]["copilot"]["quota"]["used"].as_i64(),
    Some(0)
  );
}

#[tokio::test]
async fn test_graphql_user_union_limited_and_public_user_contract() {
  let (app, store) = setup_test_app().await;
  let requester_id = uuid::Uuid::new_v4();
  let target_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: requester_id,
    email: "requester@example.com".to_string(),
    name: Some("Requester".to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  store.insert_user(AuthUser {
    id: target_id,
    email: "target@example.com".to_string(),
    name: Some("Target".to_string()),
    avatar_url: None,
    password_hash: Some("hash2".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: None,
    registered: true,
  });

  let requester_session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: requester_id,
      csrf_token: "csrf777".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("create session");

  let user_query = json!({
    "query":"query($email:String!){ user(email:$email){ __typename ... on UserType { id email hasPassword } ... on LimitedUserType { email hasPassword } } }",
    "variables": { "email": "target@example.com" }
  });
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", requester_session.id))
        .body(Body::from(user_query.to_string()))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert!(json.get("errors").is_none(), "query failed: {}", json);
  assert!(json["data"]["user"].is_null());

  // publicUserById requires authentication (API-C-02 fix) — use requester session
  let public_query = json!({
    "query":"query($id:String!){ publicUserById(id:$id){ id name avatarUrl } }",
    "variables": { "id": target_id.to_string() }
  });
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", requester_session.id))
        .body(Body::from(public_query.to_string()))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert!(json.get("errors").is_none(), "publicUserById failed: {}", json);
  assert_eq!(json["data"]["publicUserById"]["name"], "Target");
}

// ─── publicUserById auth regression tests (API-C-02) ─────────────────────

/// API-C-02: publicUserById WITHOUT authentication must return an error.
/// Prevents unauthenticated user enumeration.
#[tokio::test]
async fn public_user_by_id_without_auth_returns_error() {
  let (app, store) = setup_test_app().await;
  let target_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: target_id,
    email: "enumeration-target@example.com".to_string(),
    name: Some("EnumTarget".to_string()),
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: None,
    registered: true,
  });

  let query = json!({
    "query":"query($id:String!){ publicUserById(id:$id){ id name avatarUrl } }",
    "variables": { "id": target_id.to_string() }
  });

  // No session cookie → must fail
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .body(Body::from(query.to_string()))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(response.status(), 200); // GraphQL returns 200 with errors in body
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert!(
    json.get("errors").is_some(),
    "publicUserById without auth must return errors, got: {json}"
  );
}

/// API-C-02: publicUserById WITH authentication must return user data.
#[tokio::test]
async fn public_user_by_id_with_auth_returns_data() {
  let (app, store) = setup_test_app().await;
  let requester_id = uuid::Uuid::new_v4();
  let target_id = uuid::Uuid::new_v4();

  store.insert_user(AuthUser {
    id: requester_id,
    email: "auth-requester@example.com".to_string(),
    name: Some("Requester".to_string()),
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  store.insert_user(AuthUser {
    id: target_id,
    email: "auth-target@example.com".to_string(),
    name: Some("AuthTarget".to_string()),
    avatar_url: None,
    password_hash: None,
    is_admin: false,
    disabled: false,
    email_verified_at: None,
    registered: true,
  });

  let session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: requester_id,
      csrf_token: "csrf-pub-auth".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("create session");

  let query = json!({
    "query":"query($id:String!){ publicUserById(id:$id){ id name avatarUrl } }",
    "variables": { "id": target_id.to_string() }
  });

  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={}", session.id))
        .body(Body::from(query.to_string()))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert!(
    json.get("errors").is_none(),
    "publicUserById with auth must succeed: {json}"
  );
  assert_eq!(
    json["data"]["publicUserById"]["name"], "AuthTarget",
    "publicUserById must return user data when authenticated"
  );
}
