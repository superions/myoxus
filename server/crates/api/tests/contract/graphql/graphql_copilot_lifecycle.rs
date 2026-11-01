//! Phase-5 Copilot integration tests (context, session, message flow).
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
  let mut config = AppConfig::load().expect("load config");
  config.copilot.enabled = true;
  let store = Arc::new(InMemoryAuthStore::default());
  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("DB operation"));

  let auth_service = AuthService::new(store.clone(), mailer, storage.clone(), 3600, 3600);
  let workspace_service = WorkspaceService::new(store.clone());
  let admin_service = AdminService::new(Arc::new(InMemoryAdminStore));
  let doc_service = DocService::new(Arc::new(PanicDocStore));
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

async fn post_graphql(app: &axum::Router, session_id: Option<uuid::Uuid>, payload: Value) -> Value {
  let mut request = Request::builder()
    .method("POST")
    .uri("/graphql")
    .header("content-type", "application/json");
  if let Some(session_id) = session_id {
    request = request.header("cookie", format!("affine_session={}", session_id));
  }
  let response = app
    .clone()
    .oneshot(
      request
        .body(Body::from(payload.to_string()))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  serde_json::from_slice(&body).expect("JSON parse")
}

async fn enable_workspace_ai(app: &axum::Router, session_id: uuid::Uuid, workspace_id: &str) {
  let enabled = post_graphql(
    app,
    Some(session_id),
    json!({
      "query":"mutation($input:UpdateWorkspaceInput!){updateWorkspace(input:$input){enableAi}}",
      "variables":{"input":{"id":workspace_id,"enableAi":true}}
    }),
  )
  .await;
  assert_eq!(enabled["data"]["updateWorkspace"]["enableAi"], true, "{enabled}");
}

/// Returns (auth_session_id, workspace_id, copilot_session_id).
async fn setup_user_with_workspace(app: &axum::Router, store: &Arc<InMemoryAuthStore>) -> (uuid::Uuid, String, String) {
  let user_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: format!("copilot-setup-{}@example.com", user_id),
    name: Some("Copilot Setup User".to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  let session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id,
      csrf_token: format!("csrf-{}", user_id),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("DB operation");

  let create_workspace = post_graphql(
    app,
    Some(session.id),
    json!({"query": "mutation { createWorkspace { id } }"}),
  )
  .await;
  assert!(create_workspace.get("errors").is_none(), "{}", create_workspace);
  let workspace_id = create_workspace["data"]["createWorkspace"]["id"]
    .as_str()
    .expect("expected JSON field")
    .to_string();

  enable_workspace_ai(app, session.id, &workspace_id).await;
  let create_session = post_graphql(
    app,
    Some(session.id),
    json!({
        "query": "mutation($options: CreateChatSessionInput!) { createCopilotSession(options: $options) }",
        "variables": {
            "options": {
                "workspaceId": workspace_id.clone(),
                "promptName": "chat-with-ai",
                "pinned": false
            }
        }
    }),
  )
  .await;
  assert!(create_session.get("errors").is_none(), "{}", create_session);
  let copilot_session_id = create_session["data"]["createCopilotSession"]
    .as_str()
    .expect("expected JSON field")
    .to_string();

  (session.id, workspace_id, copilot_session_id)
}

#[tokio::test]
async fn inv_copilot_create_session() {
  let (app, store) = setup_test_app().await;
  let (_session_id, _workspace_id, copilot_session_id) = setup_user_with_workspace(&app, &store).await;

  assert!(
    !copilot_session_id.is_empty(),
    "createCopilotSession must return a non-empty session ID"
  );
}

#[tokio::test]
async fn inv_copilot_create_message() {
  let (app, store) = setup_test_app().await;
  let (session_id, _workspace_id, copilot_session_id) = setup_user_with_workspace(&app, &store).await;

  let create_message = post_graphql(
    &app,
    Some(session_id),
    json!({
        "query": "mutation($options: CreateChatMessageInput!) { createCopilotMessage(options: $options) }",
        "variables": {
            "options": {
                "sessionId": copilot_session_id,
                "content": "hello copilot",
                "attachments": ["blob/a"]
            }
        }
    }),
  )
  .await;
  assert!(create_message.get("errors").is_none(), "{}", create_message);
}

#[tokio::test]
async fn inv_copilot_update_session() {
  let (app, store) = setup_test_app().await;
  let (session_id, workspace_id, copilot_session_id) = setup_user_with_workspace(&app, &store).await;

  let create_message = post_graphql(
    &app,
    Some(session_id),
    json!({
        "query": "mutation($options: CreateChatMessageInput!) { createCopilotMessage(options: $options) }",
        "variables": { "options": { "sessionId": copilot_session_id.clone(), "content": "hello copilot", "attachments": ["blob/a"] } }
    }),
  )
  .await;
  assert!(create_message.get("errors").is_none(), "{}", create_message);

  let update_session = post_graphql(
    &app,
    Some(session_id),
    json!({
        "query": "mutation($options: UpdateChatSessionInput!) { updateCopilotSession(options: $options) }",
        "variables": { "options": { "sessionId": copilot_session_id.clone(), "promptName": "rewrite", "pinned": true, "title": "Renamed" } }
    }),
  )
  .await;
  assert!(update_session.get("errors").is_none(), "{}", update_session);

  let list_query = "query($workspaceId: String!, $sessionId: String!) { currentUser { copilot(workspaceId: $workspaceId) { chats(pagination: { first: 20, offset: 0 }, options: { sessionId: $sessionId }) { edges { node { sessionId promptName pinned title messages { content } } } } } } }";
  let list_sessions = post_graphql(
    &app,
    Some(session_id),
    json!({ "query": list_query, "variables": { "workspaceId": workspace_id, "sessionId": copilot_session_id.clone() } }),
  )
  .await;
  assert!(list_sessions.get("errors").is_none(), "{}", list_sessions);
  let node = &list_sessions["data"]["currentUser"]["copilot"]["chats"]["edges"][0]["node"];
  assert_eq!(node["sessionId"].as_str(), Some(copilot_session_id.as_str()));
  assert_eq!(node["promptName"].as_str(), Some("rewrite"));
  assert_eq!(node["pinned"].as_bool(), Some(true));
  assert_eq!(node["title"].as_str(), Some("Renamed"));
  assert_eq!(node["messages"][0]["content"].as_str(), Some("hello copilot"));
}

#[tokio::test]
async fn inv_copilot_session_cleanup() {
  let (app, store) = setup_test_app().await;
  let (session_id, workspace_id, copilot_session_id) = setup_user_with_workspace(&app, &store).await;

  let create_message = post_graphql(
    &app,
    Some(session_id),
    json!({
        "query": "mutation($options: CreateChatMessageInput!) { createCopilotMessage(options: $options) }",
        "variables": { "options": { "sessionId": copilot_session_id.clone(), "content": "hello copilot" } }
    }),
  )
  .await;
  assert!(create_message.get("errors").is_none(), "{}", create_message);

  let cleanup = post_graphql(
    &app,
    Some(session_id),
    json!({
        "query": "mutation($options: DeleteSessionInput!) { cleanupCopilotSession(options: $options) }",
        "variables": { "options": { "workspaceId": workspace_id, "sessionIds": [copilot_session_id.clone()] } }
    }),
  )
  .await;
  assert!(cleanup.get("errors").is_none(), "{}", cleanup);
  assert_eq!(
    cleanup["data"]["cleanupCopilotSession"][0].as_str(),
    Some(copilot_session_id.as_str())
  );
}

#[tokio::test]
async fn copilot_workspace_acl_blocks_non_member_session_creation() {
  let (app, store) = setup_test_app().await;
  let owner_id = uuid::Uuid::new_v4();
  let outsider_id = uuid::Uuid::new_v4();
  for (id, email) in [
    (owner_id, "owner-copilot@example.com"),
    (outsider_id, "outsider-copilot@example.com"),
  ] {
    store.insert_user(AuthUser {
      id,
      email: email.to_string(),
      name: Some("User".to_string()),
      avatar_url: None,
      password_hash: Some("hash".to_string()),
      is_admin: false,
      disabled: false,
      email_verified_at: Some(chrono::Utc::now()),
      registered: true,
    });
  }
  let owner_session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: owner_id,
      csrf_token: "csrf-owner".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("DB operation");
  let outsider_session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: outsider_id,
      csrf_token: "csrf-outsider".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("DB operation");

  let create_workspace = post_graphql(
    &app,
    Some(owner_session.id),
    json!({"query": "mutation { createWorkspace { id } }"}),
  )
  .await;
  let workspace_id = create_workspace["data"]["createWorkspace"]["id"]
    .as_str()
    .expect("expected JSON field")
    .to_string();

  enable_workspace_ai(&app, owner_session.id, &workspace_id).await;

  let outsider_create = post_graphql(
    &app,
    Some(outsider_session.id),
    json!({
        "query": "mutation($options: CreateChatSessionInput!) { createCopilotSession(options: $options) }",
        "variables": {
            "options": {
                "workspaceId": workspace_id,
                "promptName": "chat-with-ai"
            }
        }
    }),
  )
  .await;
  assert_eq!(
    outsider_create["errors"][0]["extensions"]["code"], "FORBIDDEN",
    "{outsider_create}"
  );

  let create_options = json!({"query":"mutation($options:CreateChatSessionInput!){createCopilotSession(options:$options)}", "variables":{"options":{"workspaceId":workspace_id,"promptName":"chat-with-ai"}}});
  let owner_create = post_graphql(&app, Some(owner_session.id), create_options.clone()).await;
  let chat_id = owner_create["data"]["createCopilotSession"]
    .as_str()
    .expect("authorized session");
  let foreign_fork = post_graphql(
    &app,
    Some(outsider_session.id),
    json!({
      "query":"mutation($options:ForkChatSessionInput!){forkCopilotSession(options:$options)}",
      "variables":{"options":{"sessionId":chat_id,"docId":"","workspaceId":workspace_id}}
    }),
  )
  .await;
  assert_eq!(
    foreign_fork["errors"][0]["extensions"]["code"], "FORBIDDEN",
    "{foreign_fork}"
  );

  let disable = post_graphql(
    &app,
    Some(owner_session.id),
    json!({
      "query":"mutation($input:UpdateWorkspaceInput!){updateWorkspace(input:$input){enableAi}}",
      "variables":{"input":{"id":workspace_id,"enableAi":false}}
    }),
  )
  .await;
  assert_eq!(disable["data"]["updateWorkspace"]["enableAi"], false, "{disable}");
  let disabled_create = post_graphql(&app, Some(owner_session.id), create_options).await;
  assert_eq!(
    disabled_create["errors"][0]["extensions"]["code"], "FORBIDDEN",
    "{disabled_create}"
  );
  let disabled_send = post_graphql(
    &app,
    Some(owner_session.id),
    json!({
      "query":"mutation($options:CreateChatMessageInput!){createCopilotMessage(options:$options)}",
      "variables":{"options":{"sessionId":chat_id,"content":"must not append"}}
    }),
  )
  .await;
  assert_eq!(
    disabled_send["errors"][0]["extensions"]["code"], "FORBIDDEN",
    "{disabled_send}"
  );
}

#[tokio::test]
async fn copilot_quota_is_unlimited_and_chats_require_workspace_acl() {
  let (app, store) = setup_test_app().await;
  let owner_id = uuid::Uuid::new_v4();
  let outsider_id = uuid::Uuid::new_v4();
  for (id, email) in [
    (owner_id, "owner-quota@example.com"),
    (outsider_id, "outsider-quota@example.com"),
  ] {
    store.insert_user(AuthUser {
      id,
      email: email.to_string(),
      name: Some("User".to_string()),
      avatar_url: None,
      password_hash: Some("hash".to_string()),
      is_admin: false,
      disabled: false,
      email_verified_at: Some(chrono::Utc::now()),
      registered: true,
    });
  }
  let owner_session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: owner_id,
      csrf_token: "csrf-owner".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("DB operation");
  let outsider_session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id: outsider_id,
      csrf_token: "csrf-outsider".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("DB operation");

  let create_workspace = post_graphql(
    &app,
    Some(owner_session.id),
    json!({"query": "mutation { createWorkspace { id } }"}),
  )
  .await;
  let workspace_id = create_workspace["data"]["createWorkspace"]["id"]
    .as_str()
    .expect("expected JSON field")
    .to_string();

  let owner_quota = post_graphql(
        &app,
        Some(owner_session.id),
        json!({
            "query": "query($workspaceId: String!) { currentUser { copilot(workspaceId: $workspaceId) { quota { limit used } } } }",
            "variables": { "workspaceId": workspace_id.clone() }
        }),
    )
    .await;
  assert!(owner_quota.get("errors").is_none(), "{}", owner_quota);
  assert_eq!(
    owner_quota["data"]["currentUser"]["copilot"]["quota"]["limit"].as_i64(),
    Some(i64::MAX)
  );
  assert_eq!(
    owner_quota["data"]["currentUser"]["copilot"]["quota"]["used"].as_i64(),
    Some(0)
  );

  let outsider_chats = post_graphql(
        &app,
        Some(outsider_session.id),
        json!({
            "query": "query($workspaceId: String!) { currentUser { copilot(workspaceId: $workspaceId) { chats(pagination: { first: 5, offset: 0 }) { totalCount } } } }",
            "variables": { "workspaceId": workspace_id }
        }),
    )
    .await;
  assert!(
    outsider_chats.get("errors").is_some(),
    "expected ACL error for chats in foreign workspace, got: {}",
    outsider_chats
  );
}

#[tokio::test]
async fn copilot_contract_session_and_message_workflow_is_consistent() {
  let (app, store) = setup_test_app().await;

  let user_id = uuid::Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: "copilot-contract@example.com".to_string(),
    name: Some("Copilot Contract User".to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  let session = store
    .create_session(myoxus_application::auth::NewSession {
      id: uuid::Uuid::new_v4(),
      user_id,
      csrf_token: "csrf-contract".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("DB operation");

  let create_workspace = post_graphql(
    &app,
    Some(session.id),
    json!({"query": "mutation { createWorkspace { id } }"}),
  )
  .await;
  assert!(create_workspace.get("errors").is_none(), "{}", create_workspace);
  let workspace_id = create_workspace["data"]["createWorkspace"]["id"]
    .as_str()
    .expect("expected JSON field")
    .to_string();

  enable_workspace_ai(&app, session.id, &workspace_id).await;
  let create_with_history = post_graphql(
        &app,
        Some(session.id),
        json!({
            "query": "mutation($options: CreateChatSessionInput!) { createCopilotSessionWithHistory(options: $options) { sessionId workspaceId promptName pinned messages { id content } } }",
            "variables": {
                "options": {
                    "workspaceId": workspace_id.clone(),
                    "promptName": "chat-with-ai",
                    "pinned": true
                }
            }
        }),
    )
    .await;
  assert!(create_with_history.get("errors").is_none(), "{}", create_with_history);
  let copilot_session_id = create_with_history["data"]["createCopilotSessionWithHistory"]["sessionId"]
    .as_str()
    .expect("expected JSON field")
    .to_string();
  assert_eq!(
    create_with_history["data"]["createCopilotSessionWithHistory"]["workspaceId"].as_str(),
    Some(workspace_id.as_str())
  );
  assert_eq!(
    create_with_history["data"]["createCopilotSessionWithHistory"]["promptName"].as_str(),
    Some("chat-with-ai")
  );
  assert_eq!(
    create_with_history["data"]["createCopilotSessionWithHistory"]["pinned"].as_bool(),
    Some(true)
  );
  assert_eq!(
    create_with_history["data"]["createCopilotSessionWithHistory"]["messages"]
      .as_array()
      .map(Vec::len),
    Some(0)
  );

  let message_contents = ["first message", "second message", "third message"];
  for content in message_contents {
    let create_message = post_graphql(
      &app,
      Some(session.id),
      json!({
          "query": "mutation($options: CreateChatMessageInput!) { createCopilotMessage(options: $options) }",
          "variables": {
              "options": {
                  "sessionId": copilot_session_id,
                  "content": content
              }
          }
      }),
    )
    .await;
    assert!(create_message.get("errors").is_none(), "{}", create_message);
  }

  let list_desc = post_graphql(
        &app,
        Some(session.id),
        json!({
            "query": "query($workspaceId: String!, $sessionId: String!) { currentUser { copilot(workspaceId: $workspaceId) { chats(pagination: { first: 10, offset: 0 }, options: { sessionId: $sessionId, withMessages: true, messageOrder: desc }) { edges { node { messages { content } } } } } } }",
            "variables": { "workspaceId": workspace_id.clone(), "sessionId": copilot_session_id.clone() }
        }),
    )
    .await;
  assert!(list_desc.get("errors").is_none(), "{}", list_desc);
  let desc_messages = list_desc["data"]["currentUser"]["copilot"]["chats"]["edges"][0]["node"]["messages"]
    .as_array()
    .expect("expected JSON field");
  assert_eq!(desc_messages.len(), 3);
  assert_eq!(desc_messages[0]["content"].as_str(), Some("third message"));
  assert_eq!(desc_messages[2]["content"].as_str(), Some("first message"));

  let list_without_messages = post_graphql(
        &app,
        Some(session.id),
        json!({
            "query": "query($workspaceId: String!, $sessionId: String!) { currentUser { copilot(workspaceId: $workspaceId) { chats(pagination: { first: 10, offset: 0 }, options: { sessionId: $sessionId, withMessages: false }) { edges { node { messages { content } } } } } } }",
            "variables": { "workspaceId": workspace_id.clone(), "sessionId": copilot_session_id.clone() }
        }),
    )
    .await;
  assert!(
    list_without_messages.get("errors").is_none(),
    "{}",
    list_without_messages
  );
  let compact_messages =
    list_without_messages["data"]["currentUser"]["copilot"]["chats"]["edges"][0]["node"]["messages"]
      .as_array()
      .expect("expected JSON field");
  assert!(compact_messages.is_empty());

  let update_invalid = post_graphql(
    &app,
    Some(session.id),
    json!({
        "query": "mutation($options: UpdateChatSessionInput!) { updateCopilotSession(options: $options) }",
        "variables": {
            "options": {
                "sessionId": "not-a-uuid",
                "title": "ignored"
            }
        }
    }),
  )
  .await;
  assert!(
    update_invalid.get("errors").is_some(),
    "expected invalid session id rejection, got: {}",
    update_invalid
  );
}
