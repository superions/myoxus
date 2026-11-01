// SPDX-License-Identifier: AGPL-3.0-or-later
//! INV-IGNORED-01/02: allIgnoredDocs returns objects with docId + createdAt.
//!
//! INV-IGNORED-01: After adding ignored docs, allIgnoredDocs returns [{docId, createdAt}]
//!                 where createdAt is a non-null ISO-8601 timestamp.
//! INV-IGNORED-02: ignoredDocs (paginated) returns edges with docId and createdAt populated.

use crate::helpers;

use serde_json::json;
use uuid::Uuid;

/// INV-IGNORED-01: allIgnoredDocs returns objects with docId and non-null createdAt.
#[tokio::test]
async fn inv_ignored01_all_ignored_docs_returns_objects_with_timestamps() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "ignored01").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let doc_ids = [Uuid::new_v4(), Uuid::new_v4()];

  // Add two docs to the ignored list via the mutation.
  let add_resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($wsId: String!, $docs: [String!]!) {
        updateWorkspaceEmbeddingIgnoredDocs(workspaceId: $wsId, add: $docs)
      }"#,
      "variables": {
        "wsId": workspace_id.to_string(),
        "docs": doc_ids.iter().map(Uuid::to_string).collect::<Vec<_>>()
      }
    }),
  )
  .await;
  assert!(add_resp.get("errors").is_none(), "addIgnoredDoc failed: {add_resp}");

  // Query allIgnoredDocs and verify shape.
  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"query($wsId: String!) {
        workspace(id: $wsId) {
          embedding {
            allIgnoredDocs { docId createdAt }
          }
        }
      }"#,
      "variables": { "wsId": workspace_id.to_string() }
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "allIgnoredDocs query failed: {resp}");

  let docs = resp["data"]["workspace"]["embedding"]["allIgnoredDocs"]
    .as_array()
    .expect("INV-IGNORED-01: allIgnoredDocs must be an array");

  assert_eq!(docs.len(), 2, "INV-IGNORED-01: expected 2 ignored docs");

  for doc in docs {
    assert!(
      doc["docId"].is_string(),
      "INV-IGNORED-01: each entry must have a string docId, got: {doc}"
    );
    assert!(
      doc["createdAt"].is_string(),
      "INV-IGNORED-01: each entry must have a string createdAt timestamp, got: {doc}"
    );
    // Verify it parses as a valid RFC3339 timestamp.
    let ts = doc["createdAt"].as_str().unwrap();
    assert!(
      chrono::DateTime::parse_from_rfc3339(ts).is_ok(),
      "INV-IGNORED-01: createdAt must be valid RFC3339, got: {ts}"
    );
  }

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

/// INV-IGNORED-02: ignoredDocs (paginated) edges also carry createdAt.
#[tokio::test]
async fn inv_ignored02_paginated_ignored_docs_has_created_at() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "ignored02").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = Uuid::new_v4();

  // Seed one ignored doc.
  helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"mutation($wsId: String!, $docs: [String!]!) {
        updateWorkspaceEmbeddingIgnoredDocs(workspaceId: $wsId, add: $docs)
      }"#,
      "variables": { "wsId": workspace_id.to_string(), "docs": [doc_id.to_string()] }
    }),
  )
  .await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"query($wsId: String!) {
        workspace(id: $wsId) {
          embedding {
            ignoredDocs { edges { node { docId createdAt } } }
          }
        }
      }"#,
      "variables": { "wsId": workspace_id.to_string() }
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "ignoredDocs query failed: {resp}");

  let edges = resp["data"]["workspace"]["embedding"]["ignoredDocs"]["edges"]
    .as_array()
    .expect("INV-IGNORED-02: edges must be an array");

  assert_eq!(edges.len(), 1, "INV-IGNORED-02: expected 1 edge");
  let node = &edges[0]["node"];
  assert_eq!(node["docId"], doc_id.to_string(), "INV-IGNORED-02: docId mismatch");
  assert!(
    node["createdAt"].is_string(),
    "INV-IGNORED-02: paginated ignoredDocs node must have createdAt"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}
