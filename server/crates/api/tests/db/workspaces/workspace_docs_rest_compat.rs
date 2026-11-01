//! Compatibility tests for the workspace-doc REST endpoints (fetch, history, render).
use crate::helpers;

use std::sync::Arc;

use axum::{
  body::Body,
  http::Request,
  http::{StatusCode, header::COOKIE},
};
use http_body_util::BodyExt;
use myoxus_application::doc::DocService;
use myoxus_infrastructure::auth::SqlxAuthStore;
use myoxus_infrastructure::doc::SqlxDocStore;
use serde_json::Value;
use sqlx::{PgPool, Row};
use tower::ServiceExt;
use uuid::Uuid;

/// Returns (app, pool, auth_store) — no global DB wipe so parallel tests are safe.
async fn setup_clean_app() -> (axum::Router, PgPool, Arc<SqlxAuthStore>) {
  helpers::setup_app().await
}

/// Creates an admin user + session and returns `(cookie_string, user_id)`.
///
/// Uses helper-based session creation (no setup endpoint) so it works even when
/// other tests have already seeded admin users into the DB.
async fn bootstrap_admin_session(pool: &PgPool, auth_store: &Arc<SqlxAuthStore>) -> (String, Uuid) {
  let (user_id, session_id) = helpers::seed_admin(pool, auth_store).await;
  let cookie = format!("affine_session={session_id}");
  (cookie, user_id)
}

#[test]
fn rpc_markdown_projects_the_shared_fixture_from_snapshot_and_tail() {
  helpers::block_on_large_stack("rpc-markdown-shared-fixture", || async {
    let (app, pool, auth_store) = setup_clean_app().await;
    let (session_cookie, user_id) = bootstrap_admin_session(&pool, &auth_store).await;
    let workspace_id = helpers::create_workspace(&pool, user_id).await;
    let doc_id = Uuid::new_v4();
    let external_id = "MarkdownPipelineFixture9xK";
    let source = include_str!(concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/../../../build/fixtures/seed-documents/complex/03-operations-runbook-fixture.md"
    ));
    let snapshot = myoxus_application::markdown::prepare_markdown_import("RPC fixture", source)
      .expect("prepare shared fixture")
      .yjs_binary;
    let tail = yjs::apply_document_mutation(
      &snapshot,
      &yjs::DocumentMutation::AppendBlocks {
        fragment: myoxus_application::doc::document_fragment_from_markdown("Later update payload")
          .expect("prepare tail fragment"),
      },
    )
    .expect("build later update")
    .delta;

    sqlx::query(
      "INSERT INTO docs (id, external_id, workspace_id, title, created_by, updated_by)
       VALUES ($1, $2, $3, 'RPC fixture', $4, $4)",
    )
    .bind(doc_id)
    .bind(external_id)
    .bind(workspace_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("insert fixture document");
    sqlx::query(
      "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence)
       VALUES ($1, $2, $3, 0)",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(snapshot)
    .execute(&pool)
    .await
    .expect("insert fixture snapshot");
    sqlx::query(
      "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
       VALUES ($1, $2, $3, 1)",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(tail)
    .execute(&pool)
    .await
    .expect("insert fixture tail");

    let markdown = app
      .clone()
      .oneshot(
        Request::builder()
          .uri(format!("/rpc/workspaces/{workspace_id}/docs/{external_id}/markdown"))
          .header(COOKIE, &session_cookie)
          .body(Body::empty())
          .expect("Markdown request"),
      )
      .await
      .expect("Markdown response");
    assert_eq!(markdown.status(), StatusCode::OK);
    let markdown = String::from_utf8(
      markdown
        .into_body()
        .collect()
        .await
        .expect("collect Markdown")
        .to_bytes()
        .to_vec(),
    )
    .expect("UTF-8 Markdown");
    assert!(markdown.starts_with("# RPC fixture\n\n"));
    assert!(markdown.contains("| :--- | :---: | ---: | --- |"));
    assert!(markdown.contains("```mermaid"));
    assert!(markdown.contains("Later update payload"));

    helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
    helpers::cleanup_users(&pool, &[user_id]).await;
  });
}

#[test]
fn workspace_docs_history_and_comment_attachment_routes_are_functional() {
  helpers::block_on_large_stack("workspace-docs-history-and-attachments", || async {
    let (app, pool, auth_store) = setup_clean_app().await;
    let (session_cookie, user_uuid) = bootstrap_admin_session(&pool, &auth_store).await;

    let create_ws_query = r#"{"query":"mutation { auth { createWorkspace { id } } }"}"#;
    let ws_response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("POST")
          .uri("/graphql")
          .header("content-type", "application/json")
          .header(COOKIE, &session_cookie)
          .body(Body::from(create_ws_query))
          .expect("test setup"),
      )
      .await
      .expect("test setup");
    assert_eq!(ws_response.status(), 200);
    let ws_body = ws_response
      .into_body()
      .collect()
      .await
      .expect("collect body failed")
      .to_bytes();
    let ws_json: Value = serde_json::from_slice(&ws_body).expect("JSON parse failed");
    let workspace_id = ws_json["data"]["auth"]["createWorkspace"]["id"]
      .as_str()
      .expect("workspace id")
      .to_string();
    let workspace_uuid = uuid::Uuid::parse_str(&workspace_id).expect("UUID parse failed");

    let doc_uuid = uuid::Uuid::new_v4();
    let doc_payload = yjs::merge_updates(Vec::new()).expect("valid empty yjs update");
    let history_payload = vec![9_u8, 8, 7];
    // The workspace root doc is created by `createWorkspace` with id = workspace_uuid.
    // Insert its content as a doc_update (not a snapshot), which is the normal state
    // after the client's first sync push — root docs rarely reach the 500-update
    // compaction threshold needed to create a snapshot.
    let root_doc_update = yjs::create_initial_workspace_doc("Root Doc Name");
    // merged_doc_payload re-encodes through merge_updates, so pre-compute the expected output.
    let root_doc_payload = yjs::merge_updates(vec![root_doc_update.clone()]).expect("merge root doc");
    let root_history_payload = vec![1_u8, 2, 3];
    sqlx::query(
      r#"
      INSERT INTO docs (id, workspace_id, title, meta, is_workspace_root, public_mode, created_by, updated_by)
      VALUES ($1, $2, $3, '{}'::jsonb, false, 'page', $4, $4)
    "#,
    )
    .bind(doc_uuid)
    .bind(workspace_uuid)
    .bind("REST Compat Doc")
    .bind(user_uuid)
    .execute(&pool)
    .await
    .expect("test setup");
    // Child doc gets a snapshot (simulating compaction after many edits).
    sqlx::query(
      r#"
      INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
      VALUES ($1, $2, $3, 0, now())
    "#,
    )
    .bind(doc_uuid)
    .bind(workspace_uuid)
    .bind(doc_payload.clone())
    .execute(&pool)
    .await
    .expect("test setup");
    // Root doc only has a doc_update (no snapshot) — this is the normal state for
    // workspace root docs.  Before the fix (P101-ELECTRON-01), the alias resolver
    // would incorrectly prefer the child doc (which has a snapshot) over the root
    // doc, causing the workspace name/avatar to be missing.
    sqlx::query(
      r#"
      INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
      VALUES ($1, $1, $2, 1)
      ON CONFLICT DO NOTHING
    "#,
    )
    .bind(workspace_uuid)
    .bind(root_doc_update)
    .execute(&pool)
    .await
    .expect("test setup");
    let history_id: i64 = sqlx::query_scalar(
      r#"
      INSERT INTO doc_histories (doc_id, workspace_id, snapshot, created_at)
      VALUES ($1, $2, $3, now() - interval '5 minutes')
      RETURNING id
    "#,
    )
    .bind(doc_uuid)
    .bind(workspace_uuid)
    .bind(history_payload.clone())
    .fetch_one(&pool)
    .await
    .expect("test setup");
    sqlx::query(
      r#"
      INSERT INTO doc_histories (doc_id, workspace_id, snapshot, created_at)
      VALUES ($1, $2, $3, now() - interval '4 minutes')
    "#,
    )
    .bind(workspace_uuid)
    .bind(workspace_uuid)
    .bind(root_history_payload.clone())
    .execute(&pool)
    .await
    .expect("test setup");

    let attachment_key = "att.bin";
    let attachment_payload = b"attachment-payload".to_vec();
    let storage_path = format!("./test-storage/{workspace_uuid}/{attachment_key}");
    if let Some(parent) = std::path::Path::new(&storage_path).parent() {
      std::fs::create_dir_all(parent).expect("create_dir_all failed");
    }
    std::fs::write(&storage_path, &attachment_payload).expect("fs::write failed");
    sqlx::query(
      r#"
      INSERT INTO comment_attachments (workspace_id, doc_id, storage_key, mime_type, size_bytes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
    "#,
    )
    .bind(workspace_uuid)
    .bind(doc_uuid)
    .bind(attachment_key)
    .bind("application/octet-stream")
    .bind(attachment_payload.len() as i64)
    .bind(user_uuid)
    .execute(&pool)
    .await
    .expect("test setup");

    let doc_response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!("/api/workspaces/{workspace_uuid}/docs/{doc_uuid}"))
          .header(COOKIE, &session_cookie)
          .body(Body::empty())
          .expect("test setup"),
      )
      .await
      .expect("test setup");
    assert_eq!(doc_response.status(), 200);
    assert_eq!(
      doc_response.headers().get("publish-mode").and_then(|v| v.to_str().ok()),
      Some("page")
    );
    let doc_body = doc_response
      .into_body()
      .collect()
      .await
      .expect("collect body failed")
      .to_bytes();
    assert_eq!(doc_body.to_vec(), doc_payload);

    let workspace_alias_doc_response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!("/api/workspaces/{workspace_uuid}/docs/{workspace_uuid}"))
          .header(COOKIE, &session_cookie)
          .body(Body::empty())
          .expect("test setup"),
      )
      .await
      .expect("test setup");
    assert_eq!(workspace_alias_doc_response.status(), 200);
    assert_eq!(
      workspace_alias_doc_response
        .headers()
        .get("publish-mode")
        .and_then(|v| v.to_str().ok()),
      Some("page")
    );
    let workspace_alias_body = workspace_alias_doc_response
      .into_body()
      .collect()
      .await
      .expect("test setup")
      .to_bytes();
    assert_eq!(workspace_alias_body.to_vec(), root_doc_payload);

    let timestamp_row = sqlx::query("SELECT EXTRACT(EPOCH FROM now())::bigint * 1000 AS ts")
      .fetch_one(&pool)
      .await
      .expect("test setup");
    let timestamp_ms = timestamp_row.get::<i64, _>("ts");
    let history_response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!(
            "/api/workspaces/{workspace_uuid}/docs/{doc_uuid}/histories/{timestamp_ms}"
          ))
          .header(COOKIE, &session_cookie)
          .body(Body::empty())
          .expect("test setup"),
      )
      .await
      .expect("test setup");
    assert_eq!(history_response.status(), 200);
    let history_body = history_response
      .into_body()
      .collect()
      .await
      .expect("collect body failed")
      .to_bytes();
    assert_eq!(history_body.to_vec(), history_payload);

    let exact_response = app
      .clone()
      .oneshot(
        Request::builder()
          .uri(format!(
            "/api/workspaces/{workspace_uuid}/docs/{doc_uuid}/histories/by-id/{history_id}"
          ))
          .header(COOKIE, &session_cookie)
          .body(Body::empty())
          .unwrap(),
      )
      .await
      .unwrap();
    assert_eq!(exact_response.status(), 200);
    assert_eq!(
      exact_response.into_body().collect().await.unwrap().to_bytes().as_ref(),
      history_payload.as_slice()
    );

    // Read access to both documents does not make their snapshot IDs interchangeable.
    for (guid, id, expected) in [
      (workspace_uuid, history_id.to_string(), 404),
      (doc_uuid, "not-an-id".to_string(), 400),
    ] {
      let response = app
        .clone()
        .oneshot(
          Request::builder()
            .uri(format!(
              "/api/workspaces/{workspace_uuid}/docs/{guid}/histories/by-id/{id}"
            ))
            .header(COOKIE, &session_cookie)
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
      assert_eq!(response.status(), expected);
    }

    let workspace_alias_history = app
      .clone()
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!(
            "/api/workspaces/{workspace_uuid}/docs/{workspace_uuid}/histories/{timestamp_ms}"
          ))
          .header(COOKIE, &session_cookie)
          .body(Body::empty())
          .expect("test setup"),
      )
      .await
      .expect("test setup");
    assert_eq!(workspace_alias_history.status(), 200);
    let workspace_alias_history_body = workspace_alias_history
      .into_body()
      .collect()
      .await
      .expect("collect body failed")
      .to_bytes();
    assert_eq!(workspace_alias_history_body.to_vec(), root_history_payload);

    let attachment_response = app
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!(
            "/api/workspaces/{workspace_uuid}/docs/{doc_uuid}/comment-attachments/{attachment_key}"
          ))
          .header(COOKIE, &session_cookie)
          .body(Body::empty())
          .expect("test setup"),
      )
      .await
      .expect("test setup");
    assert_eq!(attachment_response.status(), 200);
    let attachment_body = attachment_response
      .into_body()
      .collect()
      .await
      .expect("collect body failed")
      .to_bytes();
    assert_eq!(attachment_body.to_vec(), attachment_payload);
  });
}

#[test]
fn workspace_doc_lists_hide_non_root_docs_without_snapshot_or_update() {
  helpers::block_on_large_stack("workspace-doc-list-content-filter", || async {
    let (app, pool, auth_store) = setup_clean_app().await;
    let (session_cookie, user_uuid) = bootstrap_admin_session(&pool, &auth_store).await;
    let workspace_uuid = helpers::create_workspace(&pool, user_uuid).await;
    let empty_doc = Uuid::new_v4();
    let content_doc = Uuid::new_v4();

    sqlx::query(
      r#"
      INSERT INTO docs (id, workspace_id, title, meta, is_workspace_root, created_by, updated_by)
      VALUES
        ($1, $3, 'empty-list-regression', '{}'::jsonb, false, $4, $4),
        ($2, $3, 'content-list-regression', '{}'::jsonb, false, $4, $4)
    "#,
    )
    .bind(empty_doc)
    .bind(content_doc)
    .bind(workspace_uuid)
    .bind(user_uuid)
    .execute(&pool)
    .await
    .expect("seed docs");

    sqlx::query("INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence) VALUES ($1, $2, $3, 0)")
      .bind(content_doc)
      .bind(workspace_uuid)
      .bind(vec![1_u8, 2, 3])
      .execute(&pool)
      .await
      .expect("seed content snapshot");
    sqlx::query(
    "INSERT INTO search_content (workspace_id, doc_id, title, plain_text) VALUES ($1, $2, 'content-list-regression', 'visible content')",
  )
  .bind(workspace_uuid)
  .bind(content_doc)
  .execute(&pool)
  .await
  .expect("seed search document");

    let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
    let docs = service
      .list_workspace_docs(workspace_uuid, 50, 0)
      .await
      .expect("list workspace docs");
    assert!(
      docs.iter().any(|doc| doc.id == content_doc),
      "doc with content must remain visible in repository list"
    );
    assert!(
      docs.iter().all(|doc| doc.id != empty_doc),
      "non-root doc without snapshot/update must not be exposed as loadable"
    );

    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!("/rpc/workspaces/{workspace_uuid}/content"))
          .header(COOKIE, &session_cookie)
          .body(Body::empty())
          .expect("build content request"),
      )
      .await
      .expect("content request");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response
      .into_body()
      .collect()
      .await
      .expect("collect content response")
      .to_bytes();
    let payload: Value = serde_json::from_slice(&body).expect("content response json");
    let doc_ids = payload["docs"]
      .as_array()
      .expect("docs array")
      .iter()
      .map(|doc| doc["externalId"].as_str().expect("externalId").to_string())
      .collect::<Vec<_>>();
    assert!(
      doc_ids.contains(&content_doc.to_string()),
      "content doc must remain in RPC content list: {doc_ids:?}"
    );
    assert!(
      !doc_ids.contains(&empty_doc.to_string()),
      "empty non-root doc must not appear in RPC content list: {doc_ids:?}"
    );

    helpers::cleanup_workspaces(&pool, &[workspace_uuid]).await;
    helpers::cleanup_users(&pool, &[user_uuid]).await;
  });
}

#[test]
fn workspace_content_roundtrips_only_external_document_keys() {
  helpers::block_on_large_stack("workspace-content-external-keys", || async {
    let (app, pool, auth_store) = setup_clean_app().await;
    let (session_cookie, user_id) = bootstrap_admin_session(&pool, &auth_store).await;
    let workspace_id = helpers::create_workspace(&pool, user_id).await;
    let uuid_default_id = Uuid::new_v4();
    let nano_internal_id = Uuid::new_v4();
    let nano_external_id = "p02b-NanoRouteKey5qL8vN";
    let collision_decoy_internal_id = Uuid::new_v4();
    let collision_target_internal_id = Uuid::new_v4();
    let collision_external_id = collision_decoy_internal_id.to_string();

    for (id, external_id, title, plain_text) in [
      (
        uuid_default_id,
        uuid_default_id.to_string(),
        "P02B UUID Default",
        "uuid default content",
      ),
      (
        nano_internal_id,
        nano_external_id.to_string(),
        "P02B Nano",
        "nano content",
      ),
      (
        collision_decoy_internal_id,
        "p02b-collision-decoy".to_string(),
        "P02B Collision Decoy",
        "collision decoy content",
      ),
      (
        collision_target_internal_id,
        collision_external_id.clone(),
        "P02B Collision Target",
        "collision target content",
      ),
    ] {
      sqlx::query(
        "INSERT INTO docs
           (id, external_id, workspace_id, title, is_workspace_root, created_by, updated_by)
         VALUES ($1, $2, $3, $4, false, $5, $5)",
      )
      .bind(id)
      .bind(&external_id)
      .bind(workspace_id)
      .bind(title)
      .bind(user_id)
      .execute(&pool)
      .await
      .expect("insert P02B document");
      sqlx::query(
        "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence)
         VALUES ($1, $2, $3, 0)",
      )
      .bind(id)
      .bind(workspace_id)
      .bind(vec![1_u8])
      .execute(&pool)
      .await
      .expect("insert P02B content marker");
      sqlx::query(
        "INSERT INTO search_content (workspace_id, doc_id, title, plain_text)
         VALUES ($1, $2, $3, $4)",
      )
      .bind(workspace_id)
      .bind(id)
      .bind(title)
      .bind(plain_text)
      .execute(&pool)
      .await
      .expect("insert P02B search content");
    }

    let list_response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!("/rpc/workspaces/{workspace_id}/content"))
          .header(COOKIE, &session_cookie)
          .body(Body::empty())
          .expect("build workspace-content request"),
      )
      .await
      .expect("workspace-content response");
    assert_eq!(list_response.status(), StatusCode::OK);
    let list_body = list_response
      .into_body()
      .collect()
      .await
      .expect("collect workspace-content response")
      .to_bytes();
    let list: Value = serde_json::from_slice(&list_body).expect("workspace-content JSON");
    assert_eq!(
      list
        .as_object()
        .expect("workspace-content object")
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>(),
      ["docs", "workspaceId"].into_iter().collect()
    );
    assert_eq!(list["workspaceId"], workspace_id.to_string());

    for (expected_key, expected_title) in [
      (uuid_default_id.to_string(), "P02B UUID Default"),
      (nano_external_id.to_string(), "P02B Nano"),
      (collision_external_id, "P02B Collision Target"),
    ] {
      let listed = list["docs"]
        .as_array()
        .expect("workspace-content docs")
        .iter()
        .find(|doc| doc["externalId"] == expected_key)
        .unwrap_or_else(|| panic!("missing external document key {expected_key}: {list}"));
      assert_eq!(listed["externalId"], expected_key);
      assert_eq!(listed["docId"], listed["externalId"], "legacy alias drifted");
      assert_eq!(listed["workspaceId"], workspace_id.to_string());
      assert_eq!(listed["title"], expected_title);
      assert!(listed["updatedAt"].is_string());
      assert_eq!(
        listed
          .as_object()
          .expect("workspace-content document")
          .keys()
          .map(String::as_str)
          .collect::<std::collections::BTreeSet<_>>(),
        ["docId", "externalId", "plainText", "title", "updatedAt", "workspaceId"]
          .into_iter()
          .collect(),
        "RPC response shape changed"
      );

      // Canonical consumers feed externalId back into the unchanged route.
      let direct_response = app
        .clone()
        .oneshot(
          Request::builder()
            .method("GET")
            .uri(format!("/rpc/workspaces/{workspace_id}/docs/{expected_key}/content"))
            .header(COOKIE, &session_cookie)
            .body(Body::empty())
            .expect("build direct content request"),
        )
        .await
        .expect("direct content response");
      assert_eq!(direct_response.status(), StatusCode::OK);
      let direct_body = direct_response
        .into_body()
        .collect()
        .await
        .expect("collect direct content response")
        .to_bytes();
      let direct: Value = serde_json::from_slice(&direct_body).expect("direct content JSON");
      assert_eq!(&direct, listed, "listed externalId did not round-trip unchanged");

      // A stale 0.41.7 consumer still reads docId and must reach the byte-identical response.
      let legacy_key = listed["docId"].as_str().expect("legacy docId");
      let legacy_response = app
        .clone()
        .oneshot(
          Request::builder()
            .method("GET")
            .uri(format!("/rpc/workspaces/{workspace_id}/docs/{legacy_key}/content"))
            .header(COOKIE, &session_cookie)
            .body(Body::empty())
            .expect("build legacy direct content request"),
        )
        .await
        .expect("legacy direct content response");
      assert_eq!(legacy_response.status(), StatusCode::OK);
      let legacy_body = legacy_response
        .into_body()
        .collect()
        .await
        .expect("collect legacy direct content response")
        .to_bytes();
      assert_eq!(legacy_body, direct_body, "legacy docId response changed response bytes");
    }

    assert!(
      !String::from_utf8_lossy(&list_body).contains(&nano_internal_id.to_string()),
      "workspace-content leaked the NanoID document's internal UUID"
    );
    assert!(
      !String::from_utf8_lossy(&list_body).contains(&collision_target_internal_id.to_string()),
      "workspace-content leaked the UUID-shaped collision target's internal UUID"
    );

    helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
    helpers::cleanup_users(&pool, &[user_id]).await;
  });
}

#[test]
fn workspace_pseudo_db_doc_requests_return_not_found_instead_of_bad_request() {
  helpers::block_on_large_stack("workspace-pseudo-db-doc-404", || async {
    let (app, pool, auth_store) = setup_clean_app().await;
    let (session_cookie, user_id) = bootstrap_admin_session(&pool, &auth_store).await;

    let create_ws_query = r#"{"query":"mutation { auth { createWorkspace { id } } }"}"#;
    let ws_response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("POST")
          .uri("/graphql")
          .header("content-type", "application/json")
          .header(COOKIE, &session_cookie)
          .body(Body::from(create_ws_query))
          .expect("test setup"),
      )
      .await
      .expect("test setup");
    assert_eq!(ws_response.status(), StatusCode::OK);
    let ws_body = ws_response
      .into_body()
      .collect()
      .await
      .expect("collect body failed")
      .to_bytes();
    let ws_json: Value = serde_json::from_slice(&ws_body).expect("JSON parse failed");
    let workspace_id = ws_json["data"]["auth"]["createWorkspace"]["id"]
      .as_str()
      .expect("workspace id")
      .to_string();
    let workspace_uuid = Uuid::parse_str(&workspace_id).expect("workspace uuid");

    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!("/api/workspaces/{workspace_id}/docs/db$docProperties"))
          .header(COOKIE, &session_cookie)
          .body(Body::empty())
          .expect("test setup"),
      )
      .await
      .expect("test setup");
    assert_eq!(
      response.status(),
      StatusCode::NOT_FOUND,
      "db$ pseudo docs are internal sync projections and must not be served as REST document content"
    );

    let rpc_response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!("/rpc/workspaces/{workspace_id}/docs/db$docProperties"))
          .header(COOKIE, &session_cookie)
          .body(Body::empty())
          .expect("test setup"),
      )
      .await
      .expect("test setup");
    assert_eq!(rpc_response.status(), StatusCode::NOT_FOUND);

    for method in ["POST", "PUT", "PATCH"] {
      let rest_write = app
        .clone()
        .oneshot(
          Request::builder()
            .method(method)
            .uri(format!("/api/workspaces/{workspace_id}/docs/db$docProperties"))
            .header("content-type", "application/json")
            .header(COOKIE, &session_cookie)
            .body(Body::from(
              r#"{"createdAt":"2001-01-01T00:00:00Z","updatedBy":"00000000-0000-0000-0000-000000000000"}"#,
            ))
            .expect("test setup"),
        )
        .await
        .expect("test setup");
      assert_eq!(
        rest_write.status(),
        StatusCode::METHOD_NOT_ALLOWED,
        "REST db$docProperties must not expose a write surface for system facts via {method}"
      );

      let rpc_write = app
        .clone()
        .oneshot(
          Request::builder()
            .method(method)
            .uri(format!("/rpc/workspaces/{workspace_id}/docs/db$docProperties"))
            .header("content-type", "application/json")
            .header(COOKIE, &session_cookie)
            .body(Body::from(
              r#"{"createdAt":"2001-01-01T00:00:00Z","updatedBy":"00000000-0000-0000-0000-000000000000"}"#,
            ))
            .expect("test setup"),
        )
        .await
        .expect("test setup");
      assert_eq!(
        rpc_write.status(),
        StatusCode::METHOD_NOT_ALLOWED,
        "RPC db$docProperties must not expose a write surface for system facts via {method}"
      );
    }

    helpers::cleanup_workspaces(&pool, &[workspace_uuid]).await;
    helpers::cleanup_users(&pool, &[user_id]).await;
  });
}

#[test]
fn workspace_alias_doc_returns_empty_payload_when_root_doc_has_no_snapshot() {
  helpers::block_on_large_stack("workspace-alias-empty-root-doc", || async {
    let (app, pool, auth_store) = setup_clean_app().await;
    let (session_cookie, _user_id) = bootstrap_admin_session(&pool, &auth_store).await;

    let create_ws_query = r#"{"query":"mutation { auth { createWorkspace { id } } }"}"#;
    let ws_response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("POST")
          .uri("/graphql")
          .header("content-type", "application/json")
          .header(COOKIE, &session_cookie)
          .body(Body::from(create_ws_query))
          .expect("test setup"),
      )
      .await
      .expect("test setup");
    assert_eq!(ws_response.status(), StatusCode::OK);
    let ws_body = ws_response
      .into_body()
      .collect()
      .await
      .expect("collect body failed")
      .to_bytes();
    let ws_json: Value = serde_json::from_slice(&ws_body).expect("JSON parse failed");
    let workspace_id = ws_json["data"]["auth"]["createWorkspace"]["id"]
      .as_str()
      .expect("workspace id")
      .to_string();

    let response = app
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!("/api/workspaces/{workspace_id}/docs/{workspace_id}"))
          .header(COOKIE, &session_cookie)
          .body(Body::empty())
          .expect("test setup"),
      )
      .await
      .expect("test setup");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response
      .into_body()
      .collect()
      .await
      .expect("collect body failed")
      .to_bytes();
    assert!(body.is_empty());
  });
}

/// P101-ELECTRON-01: When the root doc has only doc_updates (no snapshot) and
/// a child doc has a snapshot, requesting `docs/{workspace_id}` must return
/// the root doc's content — not the child doc's.
///
/// Before the fix, `resolve_workspace_doc_alias` prioritized docs with
/// snapshots over the actual root doc, so the client received the wrong Yjs
/// binary and couldn't extract workspace name/avatar from the `meta` Y.Map.
#[test]
fn inv_p101_root_doc_returned_even_when_child_has_snapshot() {
  helpers::block_on_large_stack("workspace-root-doc-alias-priority", || async {
    let (app, pool, auth_store) = setup_clean_app().await;
    let (session_cookie, user_uuid) = bootstrap_admin_session(&pool, &auth_store).await;

    let create_ws_query = r#"{"query":"mutation { auth { createWorkspace { id } } }"}"#;
    let ws_response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("POST")
          .uri("/graphql")
          .header("content-type", "application/json")
          .header(COOKIE, &session_cookie)
          .body(Body::from(create_ws_query))
          .expect("test setup"),
      )
      .await
      .expect("test setup");
    assert_eq!(ws_response.status(), StatusCode::OK);
    let ws_body = ws_response
      .into_body()
      .collect()
      .await
      .expect("collect body failed")
      .to_bytes();
    let ws_json: Value = serde_json::from_slice(&ws_body).expect("JSON parse failed");
    let workspace_id = ws_json["data"]["auth"]["createWorkspace"]["id"]
      .as_str()
      .expect("workspace id")
      .to_string();
    let workspace_uuid = uuid::Uuid::parse_str(&workspace_id).expect("UUID parse");

    // Insert root doc content as a doc_update (the normal state — root docs
    // rarely get compacted into snapshots).
    let root_update = yjs::create_initial_workspace_doc("My Workspace");
    sqlx::query(
      "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence) VALUES ($1, $1, $2, 1) ON CONFLICT DO NOTHING",
    )
    .bind(workspace_uuid)
    .bind(&root_update)
    .execute(&pool)
    .await
    .expect("insert root doc update");

    // Create a child doc WITH a snapshot (simulating a heavily-edited page).
    let child_uuid = uuid::Uuid::new_v4();
    let child_payload = yjs::merge_updates(Vec::new()).expect("empty yjs");
    sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, meta, is_workspace_root, created_by, updated_by) VALUES ($1, $2, 'Child', '{}'::jsonb, false, $3, $3)",
  )
  .bind(child_uuid)
  .bind(workspace_uuid)
  .bind(user_uuid)
  .execute(&pool)
  .await
  .expect("insert child doc");
    sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at) VALUES ($1, $2, $3, 0, now())",
  )
  .bind(child_uuid)
  .bind(workspace_uuid)
  .bind(&child_payload)
  .execute(&pool)
  .await
  .expect("insert child snapshot");

    // Request docs/{workspace_id} — must return root doc content, not child.
    let response = app
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!("/api/workspaces/{workspace_uuid}/docs/{workspace_uuid}"))
          .header(COOKIE, &session_cookie)
          .body(Body::empty())
          .expect("test setup"),
      )
      .await
      .expect("test setup");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response
      .into_body()
      .collect()
      .await
      .expect("collect body failed")
      .to_bytes();
    // The body must NOT be empty (root doc has content) and must NOT equal the
    // child doc payload (which would mean the alias resolved to the wrong doc).
    assert!(!body.is_empty(), "root doc body must not be empty");
    assert_ne!(body.to_vec(), child_payload, "must return root doc, not child doc");
  });
}
