// SPDX-License-Identifier: AGPL-3.0-or-later
//! Web frontend schema compatibility — individual type shapes.
//!
//! Verifies ServerConfigType, UserType, WorkspaceType, CopilotType,
//! enum types, input types, and Git sync types used by the web frontend.
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

fn input_field_names(type_data: &Value) -> Vec<String> {
  type_data["inputFields"]
    .as_array()
    .unwrap_or(&vec![])
    .iter()
    .filter_map(|f| f["name"].as_str().map(String::from))
    .collect()
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

fn enum_value_names(type_data: &Value) -> Vec<String> {
  type_data["enumValues"]
    .as_array()
    .unwrap_or(&vec![])
    .iter()
    .filter_map(|f| f["name"].as_str().map(String::from))
    .collect()
}

// ===========================================================================
// ServerConfigType fields
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_server_config_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"ServerConfigType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "version",
    "baseUrl",
    "name",
    "features",
    "type",
    "initialized",
    "credentialsRequirement",
    "oauthProviders",
    "calendarProviders",
    "calendarCalDAVProviders",
    "gitSync",
    "journal",
  ];
  assert_fields_present("ServerConfigType", &fields, &required);
}

// ===========================================================================
// UserType fields (currentUser)
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_user_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"UserType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "id",
    "name",
    "email",
    "avatarUrl",
    "emailVerified",
    "hasPassword",
    "features",
    "copilot",
    "notifications",
    "revealedAccessTokens",
    "calendarAccounts",
    // PERMANENTLY OUT OF SCOPE — billing fields intentionally absent
    // NEVER add: "invoiceCount", "invoices", "subscriptions"
  ];
  assert_fields_present("UserType", &fields, &required);
}

// ===========================================================================
// WorkspaceType fields
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_workspace_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"WorkspaceType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "id",
    "public",
    "createdAt",
    "initialized",
    "owner",
    "members",
    "memberCount",
    "permissions",
    "blobs",
    "doc",
    "docs",
    "histories",
    "pageMeta",
    "quota",
    "inviteLink",
    "enableAi",
    "enableSharing",
    "enableUrlPreview",
    "enableDocEmbedding",
    "calendars",
    "embedding",
    "comments",
    "commentChanges",
    "gitSyncProfile",
    "gitSyncStatus",
    "gitSyncRuns",
    "gitSyncConflicts",
    "gitSyncBindings",
    "publicDocs",
    // PERMANENTLY OUT OF SCOPE — billing fields intentionally absent
    // NEVER add: "subscription", "invoiceCount", "invoices", "license"
  ];
  assert_fields_present("WorkspaceType", &fields, &required);
  assert_fields_absent("WorkspaceType", &fields, &["bodyFontFamily"]);
}

// ===========================================================================
// WorkspaceDocType fields (workspace.doc)
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_workspace_doc_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"WorkspaceDocType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "id",
    "workspaceId",
    "public",
    "mode",
    "defaultRole",
    "createdAt",
    "updatedAt",
    "title",
    "summary",
    "permissions",
    "grantedUsersList",
    "lastAccessedMembers",
    "analytics",
  ];
  assert_fields_present("WorkspaceDocType", &fields, &required);
}

// ===========================================================================
// Native document metadata contract
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_document_metadata_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"DocumentMetadataType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "docId",
    "workspaceId",
    "projectionMode",
    "metadataRevision",
    "metadataUpdatedAt",
    "metadataUpdatedBy",
    "system",
    "fields",
    "audience",
    "template",
    "journal",
    "presentation",
    "integration",
    "policy",
    "legacy",
  ];
  assert_fields_present("DocumentMetadataType", &fields, &required);
  assert_fields_absent("DocumentMetadataType", &fields, &["userspaceOwnerId"]);

  for (type_name, required_fields) in [
    (
      "DocumentMetadataSystemFactsType",
      vec![
        "createdAt",
        "createdBy",
        "updatedAt",
        "updatedBy",
        "metadataUpdatedAt",
        "metadataUpdatedBy",
      ],
    ),
    (
      "DocumentMetadataFieldValueType",
      vec![
        "key",
        "source",
        "reference",
        "textValue",
        "timestampValue",
        "dateValue",
        "userId",
      ],
    ),
    ("DocumentMetadataAudienceType", vec!["value", "source"]),
    (
      "DocumentMetadataReferenceValueType",
      vec!["id", "key", "label", "isActive"],
    ),
    ("DocumentMetadataPolicyType", vec!["locks"]),
    (
      "DocumentMetadataFieldLockType",
      vec!["key", "inheritanceMode", "editable", "reason"],
    ),
    (
      "DocumentMetadataTemplateType",
      vec!["state", "templateId", "revisionId", "instanceId"],
    ),
    ("DocumentMetadataJournalType", vec!["journalDate"]),
    (
      "DocumentMetadataPresentationType",
      vec!["primaryMode", "pageWidth", "edgelessColorTheme"],
    ),
    ("DocumentMetadataIntegrationType", vec!["integrationType"]),
  ] {
    let result = introspect(
      &app,
      &format!("{{ __type(name: \"{type_name}\") {{ fields {{ name }} }} }}"),
    )
    .await;
    let fields = field_names(&result["data"]["__type"]);
    assert_fields_present(type_name, &fields, &required_fields);
  }
}

#[tokio::test]
async fn inv_web_schema_metadata_index_is_the_only_metadata_version_shape_with_external_id() {
  let app = build_app().await;
  let index = introspect(
    &app,
    "{ __type(name: \"DocumentMetadataIndexRowType\") { fields { name } } }",
  )
  .await;
  let index_fields = field_names(&index["data"]["__type"]);
  assert_fields_present("DocumentMetadataIndexRowType", &index_fields, &["docId", "externalId"]);

  for type_name in [
    "DocumentMetadataType",
    "DocumentVersionType",
    "DocumentVersioningSettingsType",
  ] {
    let result = introspect(
      &app,
      &format!("{{ __type(name: \"{type_name}\") {{ fields {{ name }} }} }}"),
    )
    .await;
    let fields = field_names(&result["data"]["__type"]);
    assert_fields_absent(type_name, &fields, &["externalId"]);
  }
}

#[tokio::test]
async fn inv_web_schema_set_document_metadata_input_fields() {
  let app = build_app().await;
  let result = introspect(
    &app,
    "{ __type(name: \"SetDocumentMetadataInput\") { inputFields { name } } }",
  )
  .await;
  let fields = input_field_names(&result["data"]["__type"]);

  let required = [
    "expectedMetadataRevision",
    "documentTypeId",
    "classificationId",
    "retentionPolicyId",
    "languageId",
    "responsibleUserId",
    "documentNumber",
    "reviewDueAt",
    "validFrom",
    "validUntil",
    "journalDate",
    "audienceIds",
    "templateState",
    "templateId",
    "templateRevisionId",
    "templateInstanceId",
    "primaryMode",
    "pageWidth",
    "edgelessColorTheme",
    "integrationType",
  ];
  assert_fields_present("SetDocumentMetadataInput", &fields, &required);
  assert_fields_absent(
    "SetDocumentMetadataInput",
    &fields,
    &[
      "statusId",
      "createdAt",
      "createdBy",
      "updatedAt",
      "updatedBy",
      "responsiblePrincipals",
      "audienceId",
      "language",
    ],
  );
}

#[tokio::test]
async fn inv_web_schema_retired_document_attributes_types_absent() {
  let app = build_app().await;

  for type_name in [
    "DocumentAttributesType",
    "DocumentAttributeAuditDiffType",
    "SetDocumentAttributesInput",
    "SetDocumentAttributesPayload",
  ] {
    let result = introspect(&app, &format!("{{ __type(name: \"{type_name}\") {{ name }} }}")).await;
    assert!(
      result["data"]["__type"].is_null(),
      "retired Myoxus-internal GraphQL type {type_name} must not remain in the schema: {result}"
    );
  }
}

// ===========================================================================
// CopilotType fields (currentUser.copilot)
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_copilot_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"CopilotType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = ["chats", "contexts", "models", "audioTranscription"];
  assert_fields_present("CopilotType", &fields, &required);
}

// ===========================================================================
// Key input types — field presence
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_pagination_input_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"PaginationInput\") { inputFields { name } } }").await;
  let fields = input_field_names(&result["data"]["__type"]);

  let required = ["first", "offset"];
  assert_fields_present("PaginationInput", &fields, &required);
}

#[tokio::test]
async fn inv_web_schema_create_chat_session_input_fields() {
  let app = build_app().await;
  let result = introspect(
    &app,
    "{ __type(name: \"CreateChatSessionInput\") { inputFields { name } } }",
  )
  .await;
  let fields = input_field_names(&result["data"]["__type"]);

  let required = ["workspaceId", "docId", "promptName"];
  assert_fields_present("CreateChatSessionInput", &fields, &required);
}

#[tokio::test]
async fn inv_web_schema_create_chat_message_input_fields() {
  let app = build_app().await;
  let result = introspect(
    &app,
    "{ __type(name: \"CreateChatMessageInput\") { inputFields { name } } }",
  )
  .await;
  let fields = input_field_names(&result["data"]["__type"]);

  let required = ["sessionId", "content"];
  assert_fields_present("CreateChatMessageInput", &fields, &required);
}

#[tokio::test]
async fn inv_web_schema_update_user_input_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"UpdateUserInput\") { inputFields { name } } }").await;
  let fields = input_field_names(&result["data"]["__type"]);

  assert!(
    fields.contains(&"name".to_string()),
    "UpdateUserInput must have 'name' field. Has: {:?}",
    fields
  );
}

#[tokio::test]
async fn inv_web_schema_git_sync_profile_input_fields() {
  let app = build_app().await;
  let result = introspect(
    &app,
    "{ __type(name: \"GitSyncProfileInput\") { inputFields { name } } }",
  )
  .await;
  let fields = input_field_names(&result["data"]["__type"]);

  let required = ["repoUrl", "branch", "syncDirection", "authMethod"];
  assert_fields_present("GitSyncProfileInput", &fields, &required);
}

#[tokio::test]
async fn inv_web_schema_git_sync_file_conflict_input_fields() {
  let app = build_app().await;
  let result = introspect(
    &app,
    "{ __type(name: \"ResolveFileConflictInput\") { inputFields { name } } }",
  )
  .await;
  let fields = input_field_names(&result["data"]["__type"]);

  let required = ["conflictId", "resolution"];
  assert_fields_present("ResolveFileConflictInput", &fields, &required);
}

#[tokio::test]
async fn inv_web_schema_update_workspace_input_fields() {
  let app = build_app().await;
  let result = introspect(
    &app,
    "{ __type(name: \"UpdateWorkspaceInput\") { inputFields { name } } }",
  )
  .await;
  let fields = input_field_names(&result["data"]["__type"]);

  let required = [
    "id",
    "enableAi",
    "enableSharing",
    "enableUrlPreview",
    "enableDocEmbedding",
  ];
  assert_fields_present("UpdateWorkspaceInput", &fields, &required);
  assert_fields_absent(
    "UpdateWorkspaceInput",
    &fields,
    &["bodyFontFamily", "clearBodyFontFamily"],
  );
}

// ===========================================================================
// Quota & subscription types (compat stubs)
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_quota_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"UserQuotaType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "name",
    "blobLimit",
    "storageQuota",
    "usedStorageQuota",
    "historyPeriod",
    "memberLimit",
    "memberCount",
    "humanReadable",
  ];
  assert_fields_present("UserQuotaType", &fields, &required);
}

#[tokio::test]
async fn inv_web_schema_subscription_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"SubscriptionType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "id",
    "status",
    "plan",
    "recurring",
    "start",
    "end",
    "nextBillAt",
    "canceledAt",
    "variant",
  ];
  assert_fields_present("SubscriptionType", &fields, &required);
}

// ===========================================================================
// Enum types used by the web frontend
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_enum_types_present() {
  let app = build_app().await;

  let enums_to_check = [
    ("PublicDocMode", &["Page", "Edgeless"][..]),
    ("Permission", &["Admin", "Owner", "Collaborator", "Reader"][..]),
    (
      "DocumentMetadataProjectionModeType",
      &["MYOXUS_NATIVE", "AFFINE_LEGACY"][..],
    ),
    (
      "DocumentMetadataSourceType",
      &["DOCUMENT", "WORKSPACE", "ORGANIZATION", "FALLBACK"][..],
    ),
    (
      "DocumentMetadataInheritanceModeType",
      &[
        "INHERITED",
        "DOCUMENT_ONLY",
        "RELATION_INHERITED",
        "SYSTEM_READONLY",
        "SPECIALIZED_SUBSYSTEM",
      ][..],
    ),
    ("DatabaseFieldKind", &["Title", "Text", "Relation", "DocumentLink"][..]),
    // PERMANENTLY OUT OF SCOPE — SubscriptionPlan is billing (AGENTS.md hard constraint)
    // NEVER add: SubscriptionPlan enum
    ("WorkspaceInviteLinkExpireTime", &[][..]),
  ];

  for (enum_name, required_values) in enums_to_check {
    let result = introspect(
      &app,
      &format!("{{ __type(name: \"{}\") {{ enumValues {{ name }} }} }}", enum_name),
    )
    .await;
    let type_data = &result["data"]["__type"];
    assert!(
      !type_data.is_null(),
      "Enum type '{}' must exist in schema — web frontend depends on it",
      enum_name
    );

    if !required_values.is_empty() {
      let values = enum_value_names(type_data);
      for rv in required_values {
        assert!(
          values.contains(&rv.to_string()),
          "Enum {} missing value '{}'. Has: {:?}",
          enum_name,
          rv,
          values
        );
      }
    }
  }
}

// ===========================================================================
// ServerGitSyncConfig fields (serverConfig.gitSync sub-object)
// ===========================================================================

#[tokio::test]
async fn inv_web_schema_server_git_sync_config_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"ServerGitSyncConfig\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "enabled",
    "allowedDirections",
    "allowedAuthMethods",
    "defaultBranch",
    "autoSyncAllowed",
    "webhookAllowed",
  ];
  assert_fields_present("ServerGitSyncConfig", &fields, &required);
}

#[tokio::test]
async fn inv_web_schema_git_sync_profile_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"GitSyncProfileType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "id",
    "repoUrl",
    "branch",
    "rootPath",
    "syncDirection",
    "triggerMode",
    "pollingIntervalSecs",
    "authMethod",
    "enabled",
    "createdAt",
    "updatedAt",
  ];
  assert_fields_present("GitSyncProfileType", &fields, &required);
}

#[tokio::test]
async fn inv_web_schema_git_sync_run_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"GitSyncRunType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "id",
    "direction",
    "triggerSource",
    "status",
    "startedAt",
    "finishedAt",
    "jobId",
    "commitBefore",
    "commitAfter",
    "observedRemoteOid",
    "reconciliationRequired",
    "reconciliationReason",
    "docsCreated",
    "docsUpdated",
    "docsDeleted",
    "conflictsFound",
    "errorMessage",
    "errorClass",
  ];
  assert_fields_present("GitSyncRunType", &fields, &required);
}

#[tokio::test]
async fn inv_web_schema_git_sync_status_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"GitSyncStatusType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "profile",
    "lastRun",
    "openConflicts",
    "totalBindings",
    "openDocConflicts",
    "openFileConflicts",
    "totalDocBindings",
    "totalFileBindings",
    "partialSessionId",
    "partialStatus",
    "partialHasMore",
    "partialTotalItems",
    "partialProcessedItems",
    "partialFailedItems",
  ];
  assert_fields_present("GitSyncStatusType", &fields, &required);
}

#[tokio::test]
async fn inv_web_schema_git_sync_conflict_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"GitSyncConflictType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "id",
    "repoPath",
    "conflictType",
    "resolution",
    "myoxusContent",
    "gitContent",
    "createdAt",
  ];
  assert_fields_present("GitSyncConflictType", &fields, &required);
}

#[tokio::test]
async fn inv_web_schema_git_sync_binding_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"GitSyncBindingType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = ["id", "docId", "syncId", "repoPath", "tombstone"];
  assert_fields_present("GitSyncBindingType", &fields, &required);
}

#[tokio::test]
async fn inv_web_schema_git_sync_file_conflict_type_fields() {
  let app = build_app().await;
  let result = introspect(
    &app,
    "{ __type(name: \"GitSyncFileConflictType\") { fields { name } } }",
  )
  .await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "id",
    "runId",
    "bindingId",
    "blobKey",
    "repoPath",
    "conflictType",
    "resolution",
    "gitHash",
    "myoxusHash",
    "baselineHash",
    "createdAt",
    "resolvedAt",
    "resolvedBy",
  ];
  assert_fields_present("GitSyncFileConflictType", &fields, &required);
}

#[tokio::test]
async fn inv_web_schema_git_sync_file_binding_type_fields() {
  let app = build_app().await;
  let result = introspect(&app, "{ __type(name: \"GitSyncFileBindingType\") { fields { name } } }").await;
  let fields = field_names(&result["data"]["__type"]);

  let required = [
    "id",
    "blobKey",
    "repoPath",
    "contentHash",
    "mimeType",
    "fileSize",
    "tombstoned",
    "createdAt",
    "updatedAt",
  ];
  assert_fields_present("GitSyncFileBindingType", &fields, &required);
}
