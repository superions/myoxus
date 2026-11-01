// SPDX-License-Identifier: AGPL-3.0-or-later
//! Web frontend schema compatibility — mutation field shapes.
//!
//! Verifies root mutation fields and mutation argument types used by the
//! web frontend bundle (`client/web/`).
//! Uses schema introspection only — no database required.

use std::sync::Arc;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use myoxus_api::config::AppConfig;
use myoxus_api::state::ApiState;
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, InMemoryAuthStore};
use myoxus_application::doc::{DocService, PanicDocStore};
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::mail::LogMailAdapter;
use myoxus_infrastructure::storage::StorageAdapter;
use serde_json::{Value, json};
use tower::ServiceExt;

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

async fn build_app() -> axum::Router {
  let config = AppConfig::load().expect("config");
  let store = Arc::new(InMemoryAuthStore::default());
  let mailer = Arc::new(LogMailAdapter);
  let storage = Arc::new(StorageAdapter::new_fs("./test-storage").expect("storage"));
  let auth_service = AuthService::new(store.clone(), mailer, storage.clone(), 3600, 3600);
  let workspace_service = WorkspaceService::new(store.clone());
  let admin_service = AdminService::new(Arc::new(InMemoryAdminStore));
  let doc_service = DocService::new(Arc::new(PanicDocStore));
  let blob_store = Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(
    sqlx::PgPool::connect_lazy("postgres://localhost").expect("pool"),
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
  myoxus_api::build_router_for_integration_tests(state)
}

async fn introspect(app: &axum::Router, query: &str) -> Value {
  let body = json!({ "query": query }).to_string();
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .expect("request"),
    )
    .await
    .expect("response");
  let bytes = response.into_body().collect().await.expect("body").to_bytes();
  serde_json::from_slice(&bytes).expect("json")
}

fn field_names(type_data: &Value) -> Vec<String> {
  type_data["fields"]
    .as_array()
    .unwrap_or(&vec![])
    .iter()
    .filter_map(|f| f["name"].as_str().map(String::from))
    .collect()
}

fn arg_names(type_data: &Value, field_name: &str) -> Vec<String> {
  type_data["fields"]
    .as_array()
    .unwrap_or(&vec![])
    .iter()
    .find(|f| f["name"].as_str() == Some(field_name))
    .map(|f| {
      f["args"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|a| a["name"].as_str().map(String::from))
        .collect()
    })
    .unwrap_or_default()
}

fn arg_type_name(type_data: &Value, field_name: &str, arg_name: &str) -> Option<String> {
  type_data["fields"]
    .as_array()?
    .iter()
    .find(|f| f["name"].as_str() == Some(field_name))?["args"]
    .as_array()?
    .iter()
    .find(|a| a["name"].as_str() == Some(arg_name))
    .map(|a| {
      let t = &a["type"];
      t["name"]
        .as_str()
        .or_else(|| t["ofType"]["name"].as_str())
        .or_else(|| t["ofType"]["ofType"]["name"].as_str())
        .unwrap_or("unknown")
        .to_string()
    })
}

fn assert_fields_present(type_name: &str, fields: &[String], required: &[&str]) {
  for r in required {
    assert!(
      fields.contains(&r.to_string()),
      "{} missing field '{}' — web frontend will break. Available: {:?}",
      type_name,
      r,
      fields
    );
  }
}

fn assert_fields_absent(type_name: &str, fields: &[String], forbidden: &[&str]) {
  for field in forbidden {
    assert!(
      !fields.contains(&field.to_string()),
      "{} must not expose retired field '{}' — available: {:?}",
      type_name,
      field,
      fields
    );
  }
}

// ===========================================================================
// Root-level mutation fields
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_root_mutation_fields_present() {
  let app = build_app().await;
  let result = introspect(&app, "{ __schema { mutationType { fields { name } } } }").await;
  let names = field_names(&result["data"]["__schema"]["mutationType"]);

  let required = [
    // Auth & user
    "changeEmail",
    "changePassword",
    "deleteAccount",
    "generateUserAccessToken",
    "removeAvatar",
    "revokeUserAccessToken",
    "sendChangeEmail",
    "sendChangePasswordEmail",
    "sendSetPasswordEmail",
    "sendVerifyChangeEmail",
    "sendVerifyEmail",
    "updateProfile",
    "updatePreferences",
    "uploadAvatar",
    "verifyEmail",
    // Workspace management
    "createWorkspace",
    "deleteWorkspace",
    "leaveWorkspace",
    "updateWorkspace",
    // Workspace members & invites
    "acceptInviteById",
    "approveMember",
    "createInviteLink",
    "grantMember",
    "inviteMembers",
    "revokeMember",
    "revokeInviteLink",
    // Doc operations
    "applyDocUpdates",
    "grantDocUserRoles",
    "publishDoc",
    "recoverDoc",
    "revokeDocUserRoles",
    "revokePublicDoc",
    "updateDocDefaultRole",
    "updateDocUserRole",
    // Blobs & upload
    "abortBlobUpload",
    "completeBlobUpload",
    "createBlobUpload",
    "deleteBlob",
    "releaseDeletedBlobs",
    "setBlob",
    // Comments
    "createComment",
    "createReply",
    "deleteComment",
    "deleteReply",
    "resolveComment",
    "updateComment",
    "updateReply",
    "uploadCommentAttachment",
    "mentionUser",
    // Copilot
    "addContextBlob",
    "addContextCategory",
    "addContextDoc",
    "addContextFile",
    "addWorkspaceEmbeddingFiles",
    "claimAudioTranscription",
    "cleanupCopilotSession",
    "createCopilotContext",
    "createCopilotMessage",
    "createCopilotSession",
    "createCopilotSessionWithHistory",
    "forkCopilotSession",
    "removeContextBlob",
    "removeContextCategory",
    "removeContextDoc",
    "removeContextFile",
    "removeWorkspaceEmbeddingFiles",
    "retryAudioTranscription",
    "submitAudioTranscription",
    "updateCopilotSession",
    "updateWorkspaceEmbeddingIgnoredDocs",
    // Document metadata
    "setDocumentMetadata",
    // Calendar
    "linkCalDAVAccount",
    "linkCalendarAccount",
    "unlinkCalendarAccount",
    "updateWorkspaceCalendars",
    // Notifications
    "readAllNotifications",
    "readNotification",
    // Billing/subscription (compat stubs)
    "cancelSubscription",
    "createCheckoutSession",
    "createCustomerPortal",
    "createSelfhostWorkspaceCustomerPortal",
    "resumeSubscription",
    "updateSubscriptionRecurring",
    // License
    "activateLicense",
    "deactivateLicense",
    "generateLicenseKey",
    "installLicense",
    // Git sync
    "createGitSyncProfile",
    "deleteGitSyncProfile",
    "resolveGitSyncConflict",
    "resolveGitSyncFileConflict",
    "testGitConnection",
    "triggerGitSync",
  ];
  assert_fields_present("Root mutation", &names, &required);
  assert_fields_absent("Root mutation", &names, &["setDocumentAttributes"]);
}

// ===========================================================================
// Mutation argument type correctness (spot checks on key mutations)
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_mutation_argument_types_correct() {
  let app = build_app().await;
  let result = introspect(
    &app,
    "{ __schema { mutationType { fields { name args { name type { name kind ofType { name kind ofType { name } } } } } } } }",
  )
  .await;
  let mt = &result["data"]["__schema"]["mutationType"];

  let _cw_args = arg_names(mt, "createWorkspace");

  assert_eq!(
    arg_type_name(mt, "deleteWorkspace", "id"),
    Some("String".to_string()),
    "deleteWorkspace() must accept id: String!"
  );

  let im_args = arg_names(mt, "inviteMembers");
  assert!(
    im_args.contains(&"workspaceId".to_string()),
    "inviteMembers needs workspaceId"
  );
  assert!(im_args.contains(&"emails".to_string()), "inviteMembers needs emails");

  assert_eq!(
    arg_type_name(mt, "updateWorkspace", "input"),
    Some("UpdateWorkspaceInput".to_string()),
    "updateWorkspace() must accept UpdateWorkspaceInput"
  );

  assert_eq!(
    arg_type_name(mt, "createCopilotSession", "options"),
    Some("CreateChatSessionInput".to_string()),
    "createCopilotSession() must accept CreateChatSessionInput"
  );

  assert_eq!(
    arg_type_name(mt, "createCopilotMessage", "options"),
    Some("CreateChatMessageInput".to_string()),
    "createCopilotMessage() must accept CreateChatMessageInput"
  );

  let pd_args = arg_names(mt, "publishDoc");
  assert!(
    pd_args.contains(&"workspaceId".to_string()),
    "publishDoc needs workspaceId"
  );
  assert!(pd_args.contains(&"docId".to_string()), "publishDoc needs docId");
  assert!(pd_args.contains(&"mode".to_string()), "publishDoc needs mode");

  assert_eq!(
    arg_type_name(mt, "createGitSyncProfile", "input"),
    Some("GitSyncProfileInput".to_string()),
    "createGitSyncProfile() must accept GitSyncProfileInput"
  );
  assert_eq!(
    arg_type_name(mt, "resolveGitSyncFileConflict", "input"),
    Some("ResolveFileConflictInput".to_string()),
    "resolveGitSyncFileConflict() must accept ResolveFileConflictInput"
  );

  assert_eq!(
    arg_type_name(mt, "setDocumentMetadata", "workspaceId"),
    Some("ID".to_string()),
    "setDocumentMetadata() must accept workspaceId: ID!"
  );
  assert_eq!(
    arg_type_name(mt, "setDocumentMetadata", "docId"),
    Some("ID".to_string()),
    "setDocumentMetadata() must accept docId: ID!"
  );
  assert_eq!(
    arg_type_name(mt, "setDocumentMetadata", "input"),
    Some("SetDocumentMetadataInput".to_string()),
    "setDocumentMetadata() must accept SetDocumentMetadataInput"
  );

  let tgs_args = arg_names(mt, "triggerGitSync");
  assert!(
    tgs_args.contains(&"workspaceId".to_string()),
    "triggerGitSync needs workspaceId"
  );
  assert!(
    tgs_args.contains(&"direction".to_string()),
    "triggerGitSync needs direction"
  );
}
