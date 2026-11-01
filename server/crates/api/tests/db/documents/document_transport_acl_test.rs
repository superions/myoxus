// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! P0-02 transport-boundary regressions.
//!
//! These tests deliberately cross the HTTP and GraphQL boundaries. A
//! PermissionService unit test cannot prove that a handler checked the
//! resolved document before loading payloads, history or attachment storage.

use crate::helpers;
use myoxus_application::auth::AuthStore;
use myoxus_application::permission::AccessController;
use myoxus_infrastructure::auth::SqlxAuthStore;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

async fn add_workspace_role(pool: &PgPool, workspace_id: Uuid, user_id: Uuid, role: &str) {
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, $3, 'Accepted', now())",
  )
  .bind(workspace_id)
  .bind(user_id)
  .bind(role)
  .execute(pool)
  .await
  .expect("workspace role must be persisted");
}

async fn add_doc_role(pool: &PgPool, doc_id: Uuid, user_id: Uuid, role: &str) {
  sqlx::query("INSERT INTO doc_user_permissions (user_id, doc_id, role) VALUES ($1, $2, $3)")
    .bind(user_id)
    .bind(doc_id)
    .bind(role)
    .execute(pool)
    .await
    .expect("document role must be persisted");
}

/// Exercise the SQLx implementation of the P0 bulk role contract against the
/// migrated schema, including the no-query-equivalent empty input behavior.
#[test]
fn sqlx_bulk_document_roles_returns_only_explicit_overrides() {
  helpers::block_on_large_stack("p002-bulk-role-sql", || async {
    let pool = helpers::setup_pool().await;
    let owner_id = helpers::create_user(&pool, "p002_bulk_owner", false).await;
    let granted_id = helpers::create_user(&pool, "p002_bulk_granted", false).await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    let first_doc = helpers::create_doc(&pool, workspace_id, owner_id).await;
    let second_doc = helpers::create_doc(&pool, workspace_id, owner_id).await;
    add_doc_role(&pool, first_doc, granted_id, "Reader").await;

    let store = SqlxAuthStore::from_pool(pool.clone());
    let roles = store
      .get_doc_roles_bulk(granted_id, &[first_doc, second_doc])
      .await
      .expect("bulk SQL role read");
    assert_eq!(roles.get(&first_doc), Some(&myoxus_domain::entities::DocRole::Reader));
    assert!(
      !roles.contains_key(&second_doc),
      "bulk role read must omit absent overrides"
    );
    assert!(
      store
        .get_doc_roles_bulk(granted_id, &[])
        .await
        .expect("empty bulk SQL role read")
        .is_empty(),
      "empty bulk role read must return an empty map"
    );

    helpers::cleanup_users(&pool, &[owner_id, granted_id]).await;
  });
}

fn graphql_errors(value: &serde_json::Value) -> bool {
  value
    .get("errors")
    .and_then(serde_json::Value::as_array)
    .is_some_and(|errors| !errors.is_empty())
}

/// A reader can resolve document metadata, but the permanent-delete mutation
/// must still fail at the document action boundary.
#[test]
fn reader_can_resolve_metadata_but_cannot_hard_delete() {
  helpers::block_on_large_stack("p002-reader-hard-delete", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "p002_transport_owner").await;
    let (reader_id, reader_session) = helpers::seed_user(&pool, &auth_store, "p002_transport_reader").await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    add_workspace_role(&pool, workspace_id, reader_id, "Reader").await;
    let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;

    let loaded = helpers::gql(
    &app,
    reader_session,
    json!({
      "query": "query($workspaceId: String!, $docId: String!) { workspace(id: $workspaceId) { doc(docId: $docId) { id } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() }
    }),
  )
  .await;
    assert!(!graphql_errors(&loaded), "reader metadata load must succeed: {loaded}");
    assert_eq!(loaded["data"]["workspace"]["doc"]["id"], doc_id.to_string());

    let denied_delete = helpers::gql(
    &app,
    reader_session,
    json!({
      "query": "mutation($input: DeleteDocumentPermanentlyInput!) { deleteDocumentPermanently(input: $input) { deleted } }",
      "variables": { "input": { "workspaceId": workspace_id.to_string(), "docId": doc_id.to_string() } }
    }),
  )
  .await;
    assert!(
      graphql_errors(&denied_delete),
      "reader hard-delete must be denied: {denied_delete}"
    );
    let still_present: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id = $1)")
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("document existence query");
    assert!(still_present, "denied reader delete must not remove the document");

    let permission = myoxus_application::permission::PermissionService::new(auth_store.clone());
    let resource = myoxus_application::permission::DocResource {
      user_id: reader_id,
      workspace_id,
      doc_id,
    };
    assert!(
      !permission
        .can(&resource, myoxus_domain::permission::DocAction::Update)
        .await
    );
    assert!(
      !permission
        .can(&resource, myoxus_domain::permission::DocAction::Delete)
        .await
    );

    helpers::cleanup_users(&pool, &[owner_id, reader_id]).await;
    let _ = owner_session;
  });
}

/// An External workspace member keeps workspace-level visibility for list
/// surfaces, but receives no document payload through any normal read route
/// when no explicit document role exists.
#[test]
fn external_cannot_read_payload_history_search_timestamp_or_attachment() {
  helpers::block_on_large_stack("p002-external-transport", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_template_registry_and_search_service().await;
    let (owner_id, _owner_session) = helpers::seed_user(&pool, &auth_store, "p002_external_owner").await;
    let (external_id, external_session) = helpers::seed_user(&pool, &auth_store, "p002_external_reader").await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    add_workspace_role(&pool, workspace_id, external_id, "External").await;
    let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
    let doc_key = doc_id.to_string();

    let (status, _) = helpers::get_json(
      &app,
      external_session,
      &format!("/api/workspaces/{workspace_id}/docs/{doc_key}"),
    )
    .await;
    assert_eq!(status, 403, "payload read must be denied before the doc load");

    let (status, _) = helpers::get_json(
      &app,
      external_session,
      &format!("/api/workspaces/{workspace_id}/docs/{doc_key}/histories/0"),
    )
    .await;
    assert_eq!(
      status, 403,
      "history read must be denied before timestamp parsing/storage"
    );

    let (status, _) = helpers::get_json(
      &app,
      external_session,
      &format!("/rpc/workspaces/{workspace_id}/docs/{doc_key}/content"),
    )
    .await;
    assert_eq!(
      status, 403,
      "RPC content read must be denied before SQL payload projection"
    );

    let (status, _) = helpers::get_json(
      &app,
      external_session,
      &format!("/api/workspaces/{workspace_id}/docs/{doc_key}/comment-attachments/missing"),
    )
    .await;
    assert_eq!(status, 403, "comment attachment read must be denied by document ACL");

    crate::document_event_acl_test::assert_workspace_timestamp_denied(
      &app,
      &format!("affine_session={external_session}"),
      workspace_id,
    )
    .await;

    let (status, search) = helpers::get_json(
      &app,
      external_session,
      &format!("/api/workspaces/{workspace_id}/search?q=secret"),
    )
    .await;
    assert_eq!(status, 200, "workspace search remains a valid filtered response");
    assert!(
      search["items"].as_array().is_some_and(Vec::is_empty),
      "search must omit unreadable documents rather than projecting their snippets: {search}"
    );

    helpers::cleanup_users(&pool, &[owner_id, external_id]).await;
  });
}

/// The workspace root is authorized by the resolved document identity, not by
/// a client-visible prefix or by workspace membership alone.
#[test]
fn workspace_root_obeys_doc_action_without_prefix_bypass() {
  helpers::block_on_large_stack("p002-workspace-root", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "p002_root_owner").await;
    let (external_id, external_session) = helpers::seed_user(&pool, &auth_store, "p002_root_external").await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    add_workspace_role(&pool, workspace_id, external_id, "External").await;

    sqlx::query(
    "INSERT INTO docs (id, external_id, workspace_id, title, is_workspace_root, created_by, updated_by) VALUES ($1, $2, $1, 'Workspace Root', TRUE, $3, $3)",
  )
  .bind(workspace_id)
  .bind(workspace_id.to_string())
  .bind(owner_id)
  .execute(&pool)
  .await
  .expect("workspace root must be persisted");

    let owner_view = helpers::gql(
    &app,
    owner_session,
    json!({
      "query": "query($workspaceId: String!, $docId: String!) { workspace(id: $workspaceId) { doc(docId: $docId) { id } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": workspace_id.to_string() }
    }),
  )
  .await;
    assert!(
      !graphql_errors(&owner_view),
      "owner must read the workspace root: {owner_view}"
    );

    let external_view = helpers::gql(
    &app,
    external_session,
    json!({
      "query": "query($workspaceId: String!, $docId: String!) { workspace(id: $workspaceId) { doc(docId: $docId) { id } } }",
      "variables": { "workspaceId": workspace_id.to_string(), "docId": workspace_id.to_string() }
    }),
  )
  .await;
    assert!(
      graphql_errors(&external_view),
      "workspace root must not bypass document ACL: {external_view}"
    );

    helpers::cleanup_users(&pool, &[owner_id, external_id]).await;
  });
}
