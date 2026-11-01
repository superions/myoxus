//! Public publishing route integration tests.
//!
//! These tests exercise the anonymous Axum surface, not only the database
//! metadata. Public reads must use the dedicated Public ACL and must never make
//! the raw workspace document endpoint anonymously readable.

use crate::helpers;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use myoxus_application::doc::DocService;
use myoxus_infrastructure::doc::SqlxDocStore;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;
use yrs::{Array, Doc, Map, Text, Transact, updates::encoder::Encode};

async fn public_doc_fixture(pool: &sqlx::PgPool, owner_id: Uuid, title: &str, markdown: &str) -> (Uuid, Uuid) {
  let workspace_id = helpers::create_workspace(pool, owner_id).await;
  sqlx::query("UPDATE workspaces SET public = true WHERE id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("make public fixture workspace eligible");
  let doc_id = helpers::create_doc(pool, workspace_id, owner_id).await;
  let payload = yjs::markdown_to_yjs(title, markdown).expect("fixture yjs payload");
  sqlx::query(
    r#"
      UPDATE docs
      SET title = $3, public_mode = 'Page', updated_at = now()
      WHERE workspace_id = $1 AND id = $2
    "#,
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(title)
  .execute(pool)
  .await
  .expect("publish fixture doc");
  sqlx::query(
    r#"
      INSERT INTO doc_snapshots (workspace_id, doc_id, payload, last_sequence, updated_at)
      VALUES ($1, $2, $3, 0, now())
    "#,
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(payload)
  .execute(pool)
  .await
  .expect("insert fixture snapshot");
  (workspace_id, doc_id)
}

async fn public_doc_update_fixture<F>(pool: &sqlx::PgPool, owner_id: Uuid, title: &str, markdown: F) -> (Uuid, Uuid)
where
  F: FnOnce(Uuid) -> String,
{
  let workspace_id = helpers::create_workspace(pool, owner_id).await;
  sqlx::query("UPDATE workspaces SET public = true WHERE id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("make update-only fixture workspace eligible");
  let doc_id = helpers::create_doc(pool, workspace_id, owner_id).await;
  let markdown = markdown(doc_id);
  let payload = yjs::markdown_to_yjs(title, &markdown).expect("fixture yjs payload");
  sqlx::query(
    r#"
      UPDATE docs
      SET title = $3, public_mode = 'Page', updated_at = now()
      WHERE workspace_id = $1 AND id = $2
    "#,
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(title)
  .execute(pool)
  .await
  .expect("publish update-only fixture doc");
  sqlx::query(
    r#"
      INSERT INTO doc_updates (workspace_id, doc_id, payload, sequence, server_timestamp)
      VALUES ($1, $2, $3, 1, now())
    "#,
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(payload)
  .execute(pool)
  .await
  .expect("insert fixture update");
  (workspace_id, doc_id)
}

fn active_web_doc_updates(title: &str, body: &str) -> (Vec<u8>, Vec<u8>) {
  fn create_block(
    blocks_map: &yrs::MapRef,
    txn: &mut yrs::TransactionMut,
    id: &str,
    flavour: &str,
  ) -> (yrs::MapRef, yrs::ArrayRef) {
    let block = blocks_map.insert(txn, id, yrs::MapPrelim::default());
    block.insert(txn, "sys:id", id);
    block.insert(txn, "sys:flavour", flavour);
    block.insert(txn, "sys:version", 1.0);
    let children = block.insert(txn, "sys:children", yrs::ArrayPrelim::default());
    (block, children)
  }

  let doc = Doc::new();
  let blocks_map = doc.get_or_insert_map("blocks");

  let paragraph_text = {
    let mut txn = doc.transact_mut();
    let (page, page_children) = create_block(&blocks_map, &mut txn, "page-block", "myoxus:page");
    page.insert(&mut txn, "prop:title", yrs::TextPrelim::new(title));

    let (_surface, _surface_children) = create_block(&blocks_map, &mut txn, "surface-block", "myoxus:surface");
    let (_note, note_children) = create_block(&blocks_map, &mut txn, "note-block", "myoxus:note");
    let (paragraph, _paragraph_children) = create_block(&blocks_map, &mut txn, "paragraph-block", "myoxus:paragraph");
    paragraph.insert(&mut txn, "prop:type", "text");
    paragraph.insert(&mut txn, "prop:collapsed", false);
    let paragraph_text = paragraph.insert(&mut txn, "prop:text", yrs::TextPrelim::new(""));

    page_children.push_back(&mut txn, "surface-block");
    page_children.push_back(&mut txn, "note-block");
    note_children.push_back(&mut txn, "paragraph-block");

    let initial_update = txn.encode_update_v1();
    (paragraph_text, initial_update)
  };

  let (paragraph_text, initial_update) = paragraph_text;
  let body_update = {
    let mut txn = doc.transact_mut();
    paragraph_text.insert(&mut txn, 0, body);
    txn.encode_update_v1()
  };

  (initial_update, body_update)
}

async fn attach_external_id(pool: &sqlx::PgPool, workspace_id: Uuid, doc_id: Uuid, external_id: &str) {
  sqlx::query(
    r#"
      UPDATE docs
      SET external_id = $3, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
    "#,
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(external_id)
  .execute(pool)
  .await
  .expect("attach public fixture original doc id");
}

async fn insert_completed_blob_fixture(
  pool: &sqlx::PgPool,
  workspace_id: Uuid,
  blob_key: &str,
  mime: &str,
  bytes: &[u8],
) -> std::path::PathBuf {
  let storage_path = Path::new("./test-storage")
    .join(workspace_id.to_string())
    .join(blob_key);
  if let Some(parent) = storage_path.parent() {
    std::fs::create_dir_all(parent).expect("create public asset storage parent");
  }
  std::fs::write(&storage_path, bytes).expect("write public asset fixture");
  sqlx::query(
    r#"
      INSERT INTO blobs (workspace_id, key, size, mime, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'completed', now(), now())
      ON CONFLICT (workspace_id, key) DO UPDATE
      SET size = EXCLUDED.size,
          mime = EXCLUDED.mime,
          status = 'completed',
          deleted_at = NULL,
          updated_at = now()
    "#,
  )
  .bind(workspace_id)
  .bind(blob_key)
  .bind(bytes.len() as i64)
  .bind(mime)
  .execute(pool)
  .await
  .expect("insert public blob metadata");
  storage_path
}

fn cleanup_blob_fixture_storage(workspace_id: Uuid) {
  let workspace_storage_path = Path::new("./test-storage").join(workspace_id.to_string());
  if workspace_storage_path.exists() {
    std::fs::remove_dir_all(&workspace_storage_path).expect("cleanup public asset fixture storage");
  }
}

async fn get(app: &axum::Router, uri: String) -> (http::StatusCode, String, http::HeaderMap) {
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(uri)
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");
  let status = response.status();
  let headers = response.headers().clone();
  let body = response.into_body().collect().await.expect("body").to_bytes();
  (status, String::from_utf8_lossy(&body).into_owned(), headers)
}

#[tokio::test]
async fn public_routes_render_anonymous_html_and_keep_raw_doc_private() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _session_id) = helpers::seed_user(&pool, &auth_store, "pub-route").await;
  let (workspace_id, doc_id) = public_doc_fixture(
    &pool,
    owner_id,
    "Public <Title>",
    "# Public heading\n\nVisible content.",
  )
  .await;
  // Native editor text may contain literal HTML characters. Exercise that
  // projection directly; Markdown import deliberately rejects raw HTML.
  let (initial, body_update) = active_web_doc_updates("Public <Title>", "Visible <script>alert(1)</script> text.");
  let literal_payload = yrs::merge_updates_v1([initial.as_slice(), body_update.as_slice()]).unwrap();
  sqlx::query("UPDATE doc_snapshots SET payload=$3 WHERE workspace_id=$1 AND doc_id=$2")
    .bind(workspace_id)
    .bind(doc_id)
    .bind(literal_payload)
    .execute(&pool)
    .await
    .unwrap();
  myoxus_infrastructure::branding::set_theme_profile(&pool, Some(workspace_id), "hamburg", "dark", Some(owner_id))
    .await
    .expect("seed workspace theme for public route");

  let (status, body, headers) = get(&app, format!("/public/{workspace_id}/{doc_id}")).await;
  assert_eq!(status, http::StatusCode::OK, "public document should render");
  assert!(
    headers
      .get(http::header::CONTENT_TYPE)
      .and_then(|value| value.to_str().ok())
      .is_some_and(|value| value.starts_with("text/html")),
    "public route must return HTML headers: {headers:?}"
  );
  assert_eq!(
    headers
      .get(http::header::CACHE_CONTROL)
      .and_then(|value| value.to_str().ok()),
    Some("no-cache, max-age=0, must-revalidate"),
    "revocable public HTML must revalidate at the origin"
  );
  let workspace_theme_href = format!("/api/branding/theme.css?workspaceId={workspace_id}");
  assert!(
    body.contains(&format!("href=\"{workspace_theme_href}\"")),
    "dynamic public HTML must link the workspace-scoped runtime theme CSS: {body}"
  );
  assert!(body.contains("Public &lt;Title&gt;"), "title must be escaped: {body}");
  assert!(
    body.contains("<p>Visible &lt;script&gt;alert(1)&lt;&#x2f;script&gt; text.</p>"),
    "Native literal text must remain visible and escaped: {body}"
  );
  assert!(
    !body.contains("<script>alert(1)</script>"),
    "raw script must not pass through: {body}"
  );

  let (theme_status, theme_body, theme_headers) = get(&app, workspace_theme_href).await;
  assert_eq!(
    theme_status,
    http::StatusCode::OK,
    "public theme CSS endpoint should render"
  );
  assert!(
    theme_headers
      .get(http::header::CONTENT_TYPE)
      .and_then(|value| value.to_str().ok())
      .is_some_and(|value| value.starts_with("text/css")),
    "public theme route must return CSS headers: {theme_headers:?}"
  );
  let (global_theme_status, global_theme_body, _) = get(&app, "/api/branding/theme.css".to_string()).await;
  assert_eq!(
    global_theme_status,
    http::StatusCode::OK,
    "global theme CSS endpoint should render"
  );
  assert_ne!(
    theme_body, global_theme_body,
    "workspace-scoped public theme CSS must differ from the global projection while an override is active"
  );
  assert!(
    !theme_body.contains("@media (prefers-color-scheme: dark)"),
    "explicit dark workspace mode must not silently fall back to system media behavior: {theme_body}"
  );

  let (raw_status, raw_body, _raw_headers) = get(&app, format!("/api/workspaces/{workspace_id}/docs/{doc_id}")).await;
  assert_ne!(
    raw_status,
    http::StatusCode::OK,
    "anonymous raw doc endpoint must stay protected, body: {raw_body}"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn public_routes_accept_client_external_ids_as_canonical_doc_keys() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _session_id) = helpers::seed_user(&pool, &auth_store, "pub-original").await;
  let (workspace_id, doc_uuid) = public_doc_fixture(
    &pool,
    owner_id,
    "Client Key Public Doc",
    "# Client Key Public Doc\n\nVisible through the Web document key.",
  )
  .await;
  let route_doc_id = format!("client-public-doc-{workspace_id}");
  attach_external_id(&pool, workspace_id, doc_uuid, &route_doc_id).await;
  let workspace_description = "Public research <script>alert('no')</script>\nSecond line";
  sqlx::query("UPDATE workspaces SET name = 'Canonical Public Workspace', description = $2 WHERE id = $1")
    .bind(workspace_id)
    .bind(workspace_description)
    .execute(&pool)
    .await
    .expect("update public workspace metadata");

  let (index_status, index_body, _) = get(&app, format!("/public/{workspace_id}")).await;
  assert_eq!(index_status, http::StatusCode::OK);
  assert!(
    index_body.contains("<h1>Canonical Public Workspace</h1>")
      && index_body.contains("Public research &lt;script&gt;alert(&#x27;no&#x27;)&lt;&#x2f;script&gt;\nSecond line"),
    "workspace index must serve fresh, escaped workspace metadata: {index_body}"
  );
  assert!(
    index_body.contains(&format!("href=\"/public/{workspace_id}/{route_doc_id}\"")),
    "workspace index must generate the external document route: {index_body}"
  );
  assert!(
    !index_body.contains(&format!("/public/{workspace_id}/{doc_uuid}")),
    "workspace index must not expose internal UUID routes: {index_body}"
  );
  assert!(
    index_body.contains("<h2>Published documents</h2>") && index_body.contains(">1 document<"),
    "workspace index must expose semantic heading and count: {index_body}"
  );

  let (status, body, headers) = get(&app, format!("/public/{workspace_id}/{route_doc_id}")).await;
  assert_eq!(
    status,
    http::StatusCode::OK,
    "public route must resolve docs.external_id route keys"
  );
  assert!(
    headers
      .get(http::header::CONTENT_TYPE)
      .and_then(|value| value.to_str().ok())
      .is_some_and(|value| value.starts_with("text/html")),
    "client-key public route must return HTML headers: {headers:?}"
  );
  assert!(
    body.contains(&format!("/public/{workspace_id}/{route_doc_id}")),
    "canonical public HTML must preserve the visible client doc key: {body}"
  );
  assert!(
    body.contains("Visible through the Web document key."),
    "resolved client-key public route should render the stored document payload: {body}"
  );

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/share/{workspace_id}/{route_doc_id}"))
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(response.status(), http::StatusCode::TEMPORARY_REDIRECT);
  let expected_location = format!("/public/{workspace_id}/{route_doc_id}");
  assert_eq!(
    response
      .headers()
      .get(http::header::LOCATION)
      .and_then(|value| value.to_str().ok()),
    Some(expected_location.as_str()),
    "legacy share redirect must keep the same visible client doc key"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn public_route_renders_active_web_update_only_doc_after_empty_initial_render() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _session_id) = helpers::seed_user(&pool, &auth_store, "pub-live-web").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  sqlx::query("UPDATE workspaces SET public = true WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("make live Web fixture workspace eligible");
  let route_doc_id = format!("public-live-{}", Uuid::new_v4().simple());
  let doc_id = Uuid::new_v4();
  let title = "Live Web Public Document";
  let body = format!("Live Web public body {}", Uuid::new_v4().simple());
  let (initial_update, body_update) = active_web_doc_updates(title, &body);

  sqlx::query(
    r#"
      INSERT INTO docs
        (id, workspace_id, title, default_role, is_workspace_root, created_by, updated_by, external_id, public_mode)
      VALUES ($1, $2, $3, 'viewer', false, $4, $4, $5, 'Page')
    "#,
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(title)
  .bind(owner_id)
  .bind(&route_doc_id)
  .execute(&pool)
  .await
  .expect("insert active web public doc metadata");

  sqlx::query(
    r#"
      INSERT INTO doc_updates (workspace_id, doc_id, payload, sequence, server_timestamp)
      VALUES ($1, $2, $3, 1, now())
    "#,
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(initial_update)
  .execute(&pool)
  .await
  .expect("insert active web initial update");

  let (initial_status, initial_body, _) = get(&app, format!("/public/{workspace_id}/{route_doc_id}")).await;
  assert_eq!(initial_status, http::StatusCode::OK);
  assert!(
    initial_body.contains(title),
    "initial public render should expose the document title: {initial_body}"
  );
  assert!(
    !initial_body.contains(&body),
    "initial public render must not invent later body content: {initial_body}"
  );

  // Active Web documents usually arrive as a stream of Yjs updates, not as a
  // compacted snapshot. Public HTML must use the latest merged update stream on
  // every render, even after an earlier empty render has written an artifact.
  sqlx::query(
    r#"
      INSERT INTO doc_updates (workspace_id, doc_id, payload, sequence, server_timestamp)
      VALUES ($1, $2, $3, 2, now())
    "#,
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(body_update)
  .execute(&pool)
  .await
  .expect("insert active web body update");

  let (status, rendered_body, _) = get(&app, format!("/public/{workspace_id}/{route_doc_id}")).await;
  assert_eq!(status, http::StatusCode::OK);
  assert!(
    rendered_body.contains(&body),
    "public route must render the later live Web body update: {rendered_body}"
  );

  let artifact_html: String = sqlx::query_scalar(
    r#"
      SELECT rendered_html
      FROM public_render_artifacts
      WHERE workspace_id = $1 AND doc_id = $2
    "#,
  )
  .bind(workspace_id)
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("public artifact after second render");
  assert!(
    artifact_html.contains(&body),
    "public artifact must be regenerated from the latest live Web update stream"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn public_acl_denies_private_revoked_and_disabled_sharing_documents() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _session_id) = helpers::seed_user(&pool, &auth_store, "pub-deny").await;
  let (workspace_id, doc_id) = public_doc_fixture(&pool, owner_id, "Public", "Visible").await;

  sqlx::query("UPDATE docs SET public_mode = NULL WHERE workspace_id = $1 AND id = $2")
    .bind(workspace_id)
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("revoke fixture doc");
  let (revoked_status, _, _) = get(&app, format!("/public/{workspace_id}/{doc_id}")).await;
  assert_eq!(
    revoked_status,
    http::StatusCode::NOT_FOUND,
    "revoked docs must be hidden"
  );

  sqlx::query("UPDATE docs SET public_mode = 'Page' WHERE workspace_id = $1 AND id = $2")
    .bind(workspace_id)
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("republish fixture doc");
  sqlx::query("UPDATE workspaces SET enable_sharing = false WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("disable sharing");
  let (disabled_status, _, _) = get(&app, format!("/public/{workspace_id}/{doc_id}")).await;
  assert_eq!(
    disabled_status,
    http::StatusCode::NOT_FOUND,
    "disabled workspace sharing must hide public docs"
  );

  sqlx::query("UPDATE workspaces SET enable_sharing = true, public = false WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("make fixture workspace private");
  let (private_workspace_status, _, _) = get(&app, format!("/public/{workspace_id}/{doc_id}")).await;
  assert_eq!(
    private_workspace_status,
    http::StatusCode::NOT_FOUND,
    "private workspaces must suspend selected public documents"
  );

  sqlx::query("UPDATE workspaces SET public = true WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("reactivate fixture workspace");
  sqlx::query("UPDATE docs SET blocked = true WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("block fixture doc");
  let (blocked_status, _, _) = get(&app, format!("/public/{workspace_id}/{doc_id}")).await;
  assert_eq!(
    blocked_status,
    http::StatusCode::NOT_FOUND,
    "blocked docs must be hidden"
  );

  sqlx::query("UPDATE docs SET blocked = false, deleted_at = now() WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("delete fixture doc");
  let (deleted_status, _, _) = get(&app, format!("/public/{workspace_id}/{doc_id}")).await;
  assert_eq!(
    deleted_status,
    http::StatusCode::NOT_FOUND,
    "deleted docs must be hidden"
  );

  let private_doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let (private_status, _, _) = get(&app, format!("/public/{workspace_id}/{private_doc_id}")).await;
  assert_eq!(
    private_status,
    http::StatusCode::NOT_FOUND,
    "private docs must be hidden"
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn publish_mutation_rejects_private_workspace_before_history_and_allows_independent_revoke() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "pub-write-boundary").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;

  let history_before: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_histories WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("history count before rejected publish");
  let rejected = helpers::gql(
    &app,
    session_id,
    serde_json::json!({
      "query": "mutation Publish($workspaceId: String!, $docId: String!) { publishDoc(workspaceId: $workspaceId, docId: $docId) { id public } }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": doc_id.to_string()}
    }),
  )
  .await;
  assert!(
    rejected.get("errors").is_some(),
    "private workspace publish must fail: {rejected}"
  );
  let stored_mode: Option<String> = sqlx::query_scalar("SELECT public_mode FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("publication mode after rejected publish");
  assert_eq!(stored_mode, None, "rejected mutation must not persist a public mode");
  let history_after: i64 = sqlx::query_scalar("SELECT count(*) FROM doc_histories WHERE doc_id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("history count after rejected publish");
  assert_eq!(
    history_after, history_before,
    "rejection must happen before auto publish history"
  );

  sqlx::query("UPDATE docs SET public_mode = 'Page' WHERE id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("seed retained legacy selection");
  let revoked = helpers::gql(
    &app,
    session_id,
    serde_json::json!({
      "query": "mutation Revoke($workspaceId: String!, $docId: String!) { revokePublicDoc(workspaceId: $workspaceId, docId: $docId) { id public } }",
      "variables": {"workspaceId": workspace_id.to_string(), "docId": doc_id.to_string()}
    }),
  )
  .await;
  assert!(
    revoked.get("errors").is_none(),
    "revocation must remain available: {revoked}"
  );
  let revoked_mode: Option<String> = sqlx::query_scalar("SELECT public_mode FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("publication mode after revoke");
  assert_eq!(revoked_mode, None);

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn concurrent_workspace_deactivation_wins_before_document_publication_write() {
  let (_app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _session_id) = helpers::seed_user(&pool, &auth_store, "pub-concurrent-boundary").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  sqlx::query("UPDATE workspaces SET public = true WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("make concurrent fixture eligible");

  let mut deactivation = pool.begin().await.expect("begin deactivation");
  sqlx::query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE")
    .bind(workspace_id)
    .fetch_one(&mut *deactivation)
    .await
    .expect("lock workspace for deactivation");

  let doc_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let publish = tokio::spawn(async move {
    doc_service
      .update_public_mode(workspace_id, doc_id, Some("Page".to_string()), owner_id)
      .await
  });
  tokio::task::yield_now().await;
  sqlx::query("UPDATE workspaces SET public = false WHERE id = $1")
    .bind(workspace_id)
    .execute(&mut *deactivation)
    .await
    .expect("deactivate locked workspace");
  deactivation.commit().await.expect("commit deactivation");

  let result = publish.await.expect("join concurrent publish");
  assert!(
    result.is_err(),
    "publication must recheck eligibility after the deactivation lock"
  );
  let stored_mode: Option<String> = sqlx::query_scalar("SELECT public_mode FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("publication mode after concurrent deactivation");
  assert_eq!(stored_mode, None);

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn public_workspace_and_legacy_share_routes_use_canonical_public_contract() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, session_id) = helpers::seed_user(&pool, &auth_store, "pub-ws").await;
  let (workspace_id, doc_id) = public_doc_fixture(&pool, owner_id, "Indexed", "Listed").await;

  let initial_projection = helpers::gql(
    &app,
    session_id,
    serde_json::json!({
      "query": "query WorkspacePublication($id: String!) { workspace(id: $id) { public publicDeliveryEnabled publiclyAccessible publicDocumentSelectionCount enableSharing } }",
      "variables": {"id": workspace_id.to_string()}
    }),
  )
  .await;
  assert_eq!(initial_projection["data"]["workspace"]["public"], true);
  assert_eq!(initial_projection["data"]["workspace"]["publicDeliveryEnabled"], true);
  assert_eq!(initial_projection["data"]["workspace"]["publiclyAccessible"], true);
  assert_eq!(
    initial_projection["data"]["workspace"]["publicDocumentSelectionCount"],
    1
  );

  let (initial_doc_status, _, _) = get(&app, format!("/public/{workspace_id}/{doc_id}")).await;
  assert_eq!(initial_doc_status, http::StatusCode::OK);
  let artifact_count: i64 =
    sqlx::query_scalar("SELECT count(*) FROM public_render_artifacts WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("materialized public artifact count");
  assert_eq!(artifact_count, 1);

  let suspended = helpers::gql(
    &app,
    session_id,
    serde_json::json!({
      "query": "mutation SuspendWorkspace($input: UpdateWorkspaceInput!) { updateWorkspace(input: $input) { id public } }",
      "variables": {"input": {"id": workspace_id.to_string(), "public": false}}
    }),
  )
  .await;
  assert!(
    suspended.get("errors").is_none(),
    "workspace suspension failed: {suspended}"
  );
  assert_eq!(suspended["data"]["updateWorkspace"]["public"], false);
  let artifact_count_after_suspension: i64 =
    sqlx::query_scalar("SELECT count(*) FROM public_render_artifacts WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("public artifact count after workspace suspension");
  assert_eq!(
    artifact_count_after_suspension, 0,
    "workspace settings changes must invalidate public artifacts"
  );

  let (private_ws_status, _, _) = get(&app, format!("/public/{workspace_id}")).await;
  assert_eq!(
    private_ws_status,
    http::StatusCode::NOT_FOUND,
    "workspace route requires workspaces.public=true"
  );
  let (private_doc_status, _, _) = get(&app, format!("/public/{workspace_id}/{doc_id}")).await;
  assert_eq!(
    private_doc_status,
    http::StatusCode::NOT_FOUND,
    "selected documents must be suspended with their private workspace"
  );
  let private_redirect = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/share/{workspace_id}/{doc_id}"))
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(
    private_redirect.status(),
    http::StatusCode::NOT_FOUND,
    "legacy redirects must not bypass a private workspace"
  );

  let reactivated = helpers::gql(
    &app,
    session_id,
    serde_json::json!({
      "query": "mutation ReactivateWorkspace($input: UpdateWorkspaceInput!) { updateWorkspace(input: $input) { id public publiclyAccessible publicDocumentSelectionCount } }",
      "variables": {"input": {"id": workspace_id.to_string(), "public": true}}
    }),
  )
  .await;
  assert!(
    reactivated.get("errors").is_none(),
    "workspace reactivation failed: {reactivated}"
  );
  assert_eq!(reactivated["data"]["updateWorkspace"]["publiclyAccessible"], true);
  assert_eq!(
    reactivated["data"]["updateWorkspace"]["publicDocumentSelectionCount"],
    1
  );
  let (workspace_status, workspace_body, _) = get(&app, format!("/public/{workspace_id}")).await;
  assert_eq!(workspace_status, http::StatusCode::OK);
  assert!(
    workspace_body.contains(&format!("/public/{workspace_id}/{doc_id}")),
    "workspace index should link canonical public doc URL: {workspace_body}"
  );
  let retained_mode: Option<String> = sqlx::query_scalar("SELECT public_mode FROM docs WHERE id = $1")
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("retained public selection");
  assert_eq!(
    retained_mode.as_deref(),
    Some("Page"),
    "workspace suspension must retain document selections for reactivation"
  );

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/share/{workspace_id}/{doc_id}"))
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");
  assert_eq!(response.status(), http::StatusCode::TEMPORARY_REDIRECT);
  let expected_location = format!("/public/{workspace_id}/{doc_id}");
  assert_eq!(
    response
      .headers()
      .get(http::header::LOCATION)
      .and_then(|value| value.to_str().ok()),
    Some(expected_location.as_str())
  );

  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn public_assets_are_served_only_after_manifest_materialization() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _session_id) = helpers::seed_user(&pool, &auth_store, "pub-asset").await;
  let blob_key = "public-image.png";
  let (workspace_id, doc_id) =
    public_doc_fixture(&pool, owner_id, "Asset Doc", &format!("![Alt text]({blob_key})")).await;
  let bytes = b"public image bytes".to_vec();
  let storage_path = insert_completed_blob_fixture(&pool, workspace_id, blob_key, "image/png", &bytes).await;

  let mut hasher = Sha256::new();
  hasher.update(blob_key.as_bytes());
  let asset_hash = hex::encode(hasher.finalize());
  let asset_route = format!("/public-assets/{workspace_id}/{doc_id}/{asset_hash}/{blob_key}");

  let (pre_render_status, _, _) = get(&app, asset_route.clone()).await;
  assert_eq!(
    pre_render_status,
    http::StatusCode::NOT_FOUND,
    "assets must not be public before the document route materializes the manifest"
  );

  let (doc_status, doc_body, _) = get(&app, format!("/public/{workspace_id}/{doc_id}")).await;
  assert_eq!(doc_status, http::StatusCode::OK);
  assert!(
    doc_body.contains(&asset_route),
    "document HTML should use manifest public asset URL: {doc_body}"
  );

  let (asset_status, asset_body, asset_headers) = get(&app, asset_route.clone()).await;
  assert_eq!(asset_status, http::StatusCode::OK);
  assert_eq!(asset_body.as_bytes(), bytes.as_slice());
  assert_eq!(
    asset_headers
      .get(http::header::CONTENT_TYPE)
      .and_then(|value| value.to_str().ok()),
    Some("image/png")
  );
  assert_eq!(
    asset_headers
      .get(http::header::CACHE_CONTROL)
      .and_then(|value| value.to_str().ok()),
    Some("no-cache, max-age=0, must-revalidate"),
    "revocable public assets must revalidate at the origin"
  );

  let (wrong_asset_status, _, _) = get(
    &app,
    format!("/public-assets/{workspace_id}/{doc_id}/not-the-hash/{blob_key}"),
  )
  .await;
  assert_eq!(
    wrong_asset_status,
    http::StatusCode::NOT_FOUND,
    "non-manifested asset URLs must stay hidden"
  );

  sqlx::query("UPDATE docs SET public_mode = NULL WHERE workspace_id = $1 AND id = $2")
    .bind(workspace_id)
    .bind(doc_id)
    .execute(&pool)
    .await
    .expect("revoke public asset doc");
  let (revoked_asset_status, _, _) = get(&app, asset_route).await;
  assert_eq!(
    revoked_asset_status,
    http::StatusCode::NOT_FOUND,
    "revoked public docs must hide already materialized public assets"
  );

  std::fs::remove_file(storage_path).expect("cleanup public asset fixture file");
  cleanup_blob_fixture_storage(workspace_id);
  sqlx::query("DELETE FROM blobs WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("cleanup public asset fixture blob metadata");
  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn public_route_renders_update_only_imported_markdown_with_materialized_blob_image() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _session_id) = helpers::seed_user(&pool, &auth_store, "pub-import-asset").await;
  let (workspace_id, doc_id) = public_doc_update_fixture(&pool, owner_id, "Imported Asset Doc", |doc_id| {
    let blob_key = format!("markdown-import/{doc_id}/fixture.svg");
    format!(
      "# Imported Asset Doc\n\n\
       ## Render Contract\n\n\
       Rendered **bold** and *italic* body.\n\n\
       | Column | Expected Behavior |\n\
       | --- | --- |\n\
       | Images | SVG and PNG render through public assets |\n\n\
       ![Seed SVG]({blob_key})\n\n\
       ![Seed SVG duplicate]({blob_key})\n"
    )
  })
  .await;
  sqlx::query("UPDATE workspaces SET name = 'Seed QA Workspace' WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("name public workspace fixture");
  let blob_key = format!("markdown-import/{doc_id}/fixture.svg");
  let bytes = b"<svg xmlns='http://www.w3.org/2000/svg'></svg>".to_vec();
  let storage_path = insert_completed_blob_fixture(&pool, workspace_id, &blob_key, "image/svg+xml", &bytes).await;

  let snapshot_count: i64 =
    sqlx::query_scalar("SELECT count(*) FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .expect("snapshot count");
  assert_eq!(snapshot_count, 0, "fixture must exercise the update-only import path");

  let mut hasher = Sha256::new();
  hasher.update(blob_key.as_bytes());
  let asset_hash = hex::encode(hasher.finalize());
  let asset_route = format!("/public-assets/{workspace_id}/{doc_id}/{asset_hash}/fixture.svg");

  let (doc_status, doc_body, _) = get(&app, format!("/public/{workspace_id}/{doc_id}")).await;
  assert_eq!(doc_status, http::StatusCode::OK);
  assert!(
    doc_body.contains("Rendered "),
    "public body must not be blank: {doc_body}"
  );
  assert!(
    doc_body.contains("Seed QA Workspace"),
    "document breadcrumb must use the real workspace name: {doc_body}"
  );
  assert!(
    !doc_body.contains("Public workspace"),
    "document breadcrumb must not use the public placeholder label: {doc_body}"
  );
  assert!(
    doc_body.contains("<h1 id=\"imported-asset-doc\">") && doc_body.contains("<h2 id=\"render-contract\">"),
    "public HTML must render editor headings as headings: {doc_body}"
  );
  assert!(
    doc_body.contains("<strong>bold</strong>") && doc_body.contains("<em>italic</em>"),
    "public HTML must preserve inline rich-text semantics: {doc_body}"
  );
  let (table_attributes, table_content) = doc_body
    .split_once("<table ")
    .and_then(|(_, rest)| rest.split_once("</table>"))
    .and_then(|(table, _)| table.split_once('>'))
    .expect("public HTML must contain a semantic table");
  assert!(
    table_attributes.contains("data-myoxus-role=\"public-table\"")
      && table_content.contains("<th scope=\"col\">Column</th>")
      && table_content.contains("<td>Images</td>"),
    "public HTML must render imported tables as semantic tables: {doc_body}"
  );
  assert!(
    !doc_body.contains("<p>| Column |"),
    "public HTML must not leak GFM table rows as paragraphs: {doc_body}"
  );
  assert!(
    doc_body.contains(&asset_route),
    "public HTML must rewrite imported blob image to the manifest asset route: {doc_body}"
  );
  assert!(
    !doc_body.contains("data:image/"),
    "public HTML must not expose pre-import data URLs: {doc_body}"
  );

  let (asset_status, asset_body, asset_headers) = get(&app, asset_route).await;
  assert_eq!(asset_status, http::StatusCode::OK);
  assert_eq!(asset_body.as_bytes(), bytes.as_slice());
  assert_eq!(
    asset_headers
      .get(http::header::CONTENT_TYPE)
      .and_then(|value| value.to_str().ok()),
    Some("image/svg+xml")
  );

  std::fs::remove_file(storage_path).expect("cleanup imported public asset fixture file");
  cleanup_blob_fixture_storage(workspace_id);
  sqlx::query("DELETE FROM blobs WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("cleanup imported public asset fixture blob metadata");
  helpers::cleanup_workspaces(&pool, &[workspace_id]).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}
#[tokio::test]
async fn public_overviews_use_native_folders_and_current_publication_without_private_rows() {
  use futures_util::FutureExt;
  use myoxus_application::{
    organizer::{CreateOrganizerFolder, CreateOrganizerLink, OrganizerLinkType, OrganizerService},
    workspace::UserWorkspaceSettingsInput,
  };
  use myoxus_domain::{
    workspace_content_operation::{WorkspaceContentResourceKind, WorkspaceContentResourceRef},
    workspace_overview::{
      OverviewOrderBy, OverviewRegisterPresentation, OverviewSettingsScope, WorkspaceOverviewSettingsPatch,
    },
  };
  use myoxus_public_render::{public_document_path, public_folder_path};

  let (app, pool, auth_store, state) = helpers::setup_app_with_state().await;
  let (owner, _) = helpers::seed_user(&pool, &auth_store, "pub-overview").await;
  let (workspace, introduction) = public_doc_fixture(
    &pool, owner, "Start here", "## Native introduction\n\nA **public** introduction.\n\n| Area | Role |\n| --- | --- |\n| Monitoring | Operations |\n\n![Overview image](overview-image.png)",
  ).await;
  let (foreign, foreign_doc) = public_doc_fixture(&pool, owner, "External guide", "Foreign source").await;
  let storage = insert_completed_blob_fixture(
    &pool,
    workspace,
    "overview-image.png",
    "image/png",
    b"overview image fixture",
  )
  .await;
  // The existing serial public owner restores this global definition even when
  // an assertion fails. Other fixtures and source workspaces remain unchanged.
  let original_created_export: String =
    sqlx::query_scalar("SELECT export_mode FROM document_metadata_field_definition WHERE key='createdAt'")
      .fetch_one(&pool)
      .await
      .unwrap();
  let outcome = std::panic::AssertUnwindSafe(async {
    state
      .workspace()
      .seed_root_doc(workspace, owner, yjs::create_initial_workspace_doc("Overview fixture"))
      .await
      .unwrap();
    attach_external_id(&pool, workspace, introduction, "introduction with spaces").await;
    attach_external_id(&pool, foreign, foreign_doc, "foreign guide & notes").await;
    let leaf = helpers::create_doc(&pool, workspace, owner).await;
    let private = helpers::create_doc(&pool, workspace, owner).await;
    attach_external_id(&pool, workspace, leaf, "monitoring & alerts").await;
    sqlx::query("UPDATE docs SET title = 'Monitoring guide', public_mode = 'Page' WHERE id = $1")
      .bind(leaf)
      .execute(&pool)
      .await
      .unwrap();
    sqlx::query("UPDATE docs SET title = 'Private planning sentinel' WHERE id = $1")
      .bind(private)
      .execute(&pool)
      .await
      .unwrap();
    sqlx::query(
      "INSERT INTO doc_snapshots (workspace_id,doc_id,payload,last_sequence,updated_at) VALUES ($1,$2,$3,0,now())",
    )
    .bind(workspace)
    .bind(leaf)
    .bind(yjs::markdown_to_yjs("Monitoring guide", "## Monitoring\n\nCheck current alerts.").unwrap())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE docs SET created_at='2001-01-01T10:22:33Z'::timestamptz WHERE id=$1")
      .bind(introduction)
      .execute(&pool)
      .await
      .unwrap();
    sqlx::query("UPDATE docs SET created_at='2099-09-09T09:09:09Z'::timestamptz WHERE id=$1")
      .bind(leaf)
      .execute(&pool)
      .await
      .unwrap();
    sqlx::query("UPDATE document_metadata_field_definition SET export_mode='hidden' WHERE key='createdAt'")
      .execute(&pool)
      .await
      .unwrap();
    let organizer = OrganizerService::new(state.doc().clone());
    for (id, parent, name) in [
      ("services", None, "Services & systems"),
      ("monitoring & alarms", Some("services"), "Monitoring"),
      ("private", None, "Private branch sentinel"),
      ("collection-only", None, "Collection branch sentinel"),
      ("intro-only", None, "Introduction only"),
    ] {
      organizer
        .create_folder(
          workspace,
          CreateOrganizerFolder {
            id: id.into(),
            parent_id: parent.map(str::to_string),
            name: name.into(),
            index: None,
          },
        )
        .await
        .unwrap();
    }
    for (id, parent, kind, key, source) in [
      (
        "local-link",
        "monitoring & alarms",
        OrganizerLinkType::Doc,
        "monitoring & alerts".to_string(),
        None,
      ),
      (
        "foreign-link",
        "monitoring & alarms",
        OrganizerLinkType::Doc,
        "foreign guide & notes".to_string(),
        Some(foreign),
      ),
      (
        "private-link",
        "private",
        OrganizerLinkType::Doc,
        private.to_string(),
        None,
      ),
      (
        "collection-link",
        "collection-only",
        OrganizerLinkType::Collection,
        "orthogonal-collection".into(),
        None,
      ),
    ] {
      organizer
        .create_link(
          workspace,
          CreateOrganizerLink {
            id: id.into(),
            parent_id: parent.into(),
            link_type: kind,
            target_id: key,
            target_workspace_id: source,
            index: None,
          },
        )
        .await
        .unwrap();
    }
    let reference = WorkspaceContentResourceRef::new(
      workspace,
      WorkspaceContentResourceKind::Document,
      "introduction with spaces",
    )
    .unwrap();
    let settings = state.workspace_settings_service();
    let saved = settings
      .update(
        owner,
        workspace,
        UserWorkspaceSettingsInput {
          overview: Some(WorkspaceOverviewSettingsPatch {
            introduction: Some(Some(reference.clone())),
            register_presentation: Some(Some(OverviewRegisterPresentation {
              display_properties: ["title", "createdAt", "createdBy", "tags", "updatedAt"]
                .into_iter()
                .map(|key| format!("system:{key}"))
                .collect(),
              order_by: OverviewOrderBy {
                property_type: "system".into(),
                key: "createdAt".into(),
                desc: false,
              },
            })),
            ..Default::default()
          }),
          ..Default::default()
        },
      )
      .await
      .unwrap();
    settings
      .update(
        owner,
        workspace,
        UserWorkspaceSettingsInput {
          overview: Some(WorkspaceOverviewSettingsPatch {
            expected_revision: saved.overview_revision,
            scope: OverviewSettingsScope::Folder("intro-only".into()),
            introduction: Some(Some(reference)),
            ..Default::default()
          }),
          ..Default::default()
        },
      )
      .await
      .unwrap();

    let (status, root, headers) = get(&app, format!("/public/{workspace}")).await;
    assert_eq!(status, http::StatusCode::OK);
    assert_eq!(
      headers.get(http::header::CACHE_CONTROL).unwrap(),
      "no-cache, max-age=0, must-revalidate"
    );
    assert!(root.contains(&public_folder_path(workspace, "services")));
    assert!(root.contains(&public_folder_path(workspace, "intro-only")));
    assert!(
      root.contains("Native introduction") && root.contains("<strong>public</strong>") && root.contains("<table")
    );
    assert!(
      root.contains(&public_document_path(workspace, "monitoring & alerts")),
      "Unplaced root inventory must remain complete"
    );
    for private_value in [
      "Private branch sentinel",
      "Private planning sentinel",
      "Collection branch sentinel",
      "orthogonal-collection",
      "External guide",
    ] {
      assert!(!root.contains(private_value), "Root must not expose {private_value}");
    }
    assert!(
      !root.contains("data-register-key=\"createdAt\"")
        && !root.contains("data-register-key=\"createdBy\"")
        && !root.contains("2099-09-09"),
      "Hidden metadata must be absent, not merely hidden by CSS"
    );
    let root_links = root.replace("&#x2F;", "/").replace("&#x2f;", "/");
    assert!(
      root_links
        .find(&public_document_path(workspace, "monitoring & alerts"))
        .unwrap()
        < root_links
          .find(&public_document_path(workspace, "introduction with spaces"))
          .unwrap(),
      "Hidden creation-time sorting must fall back to title rather than put the older introduction first"
    );
    let root_artifact: String =
      sqlx::query_scalar("SELECT rendered_html FROM public_render_artifacts WHERE workspace_id=$1 AND doc_id IS NULL")
        .bind(workspace)
        .fetch_one(&pool)
        .await
        .unwrap();
    let (status, parent, _) = get(&app, public_folder_path(workspace, "services")).await;
    assert_eq!(status, http::StatusCode::OK);
    assert!(parent.contains(&public_folder_path(workspace, "monitoring & alarms").replace('&', "&amp;")));
    assert!(
      !parent.contains("data-myoxus-role=\"public-index-link\""),
      "Parent registers contain direct documents only"
    );
    let (status, nested, _) = get(&app, public_folder_path(workspace, "monitoring & alarms")).await;
    assert_eq!(status, http::StatusCode::OK);
    // The shared shell may escape URL slashes while preserving the link target.
    let nested_links = nested.replace("&#x2F;", "/").replace("&#x2f;", "/");
    assert!(nested_links.contains(&public_folder_path(workspace, "services")));
    assert!(nested.contains(&public_document_path(foreign, "foreign guide & notes")));
    assert!(nested.contains(&public_document_path(workspace, "monitoring & alerts")));
    assert!(
      nested.contains("folder=monitoring+%26+alarms"),
      "Folder canonical URL retains its selector"
    );
    let (status, document, _) = get(&app, public_document_path(workspace, "monitoring & alerts")).await;
    assert_eq!(status, http::StatusCode::OK);
    assert!(document.contains("Check current alerts."));
    assert!(document.contains("monitoring%20%26%20alerts"));
    let after_folder_reads: String =
      sqlx::query_scalar("SELECT rendered_html FROM public_render_artifacts WHERE workspace_id=$1 AND doc_id IS NULL")
        .bind(workspace)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
      after_folder_reads, root_artifact,
      "Folder HTML must not overwrite the existing root artifact"
    );
    for folder in ["private", "collection-only"] {
      assert_eq!(
        get(&app, public_folder_path(workspace, folder)).await.0,
        http::StatusCode::NOT_FOUND
      );
    }
    let mut hash = Sha256::new();
    hash.update(b"overview-image.png");
    let asset = format!(
      "/public-assets/{workspace}/{introduction}/{}/overview-image.png",
      hex::encode(hash.finalize())
    );
    assert!(
      root.contains(&asset),
      "Introductions retain the normal document media manifest"
    );
    assert_eq!(get(&app, asset).await.0, http::StatusCode::OK);
    assert_eq!(
      get(&app, public_folder_path(workspace, "intro-only")).await.0,
      http::StatusCode::OK
    );

    state
      .doc()
      .update_public_mode(workspace, introduction, None, owner)
      .await
      .unwrap();
    settings
      .update(
        owner,
        foreign,
        UserWorkspaceSettingsInput {
          public: Some(false),
          ..Default::default()
        },
      )
      .await
      .unwrap();
    let (status, root, _) = get(&app, format!("/public/{workspace}")).await;
    assert_eq!(status, http::StatusCode::OK);
    assert!(!root.contains("Native introduction") && !root.contains("Introduction only"));
    assert_eq!(
      get(&app, public_folder_path(workspace, "intro-only")).await.0,
      http::StatusCode::NOT_FOUND
    );
    let (status, nested, _) = get(&app, public_folder_path(workspace, "monitoring & alarms")).await;
    assert_eq!(status, http::StatusCode::OK);
    assert!(!nested.contains("External guide") && !nested.contains(&foreign.to_string()));
    state
      .doc()
      .update_public_mode(workspace, leaf, None, owner)
      .await
      .unwrap();
    let (status, root, _) = get(&app, format!("/public/{workspace}")).await;
    assert_eq!(status, http::StatusCode::OK);
    assert!(!root.contains("Services &amp; systems"));
    assert_eq!(
      get(&app, public_folder_path(workspace, "services")).await.0,
      http::StatusCode::NOT_FOUND
    );
    // Exercise the existing route across its real page boundary, with equal
    // title/sort facts. Later revocation must not resurrect a cached last page.
    let mut paging_ids = (0..52).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
    paging_ids.sort();
    sqlx::query(
      "INSERT INTO docs (id,external_id,workspace_id,title,default_role,created_by,updated_by,public_mode)
      SELECT id,id::text,$2,'Paging','viewer',$3,$3,'Page' FROM unnest($1::uuid[]) id",
    )
    .bind(&paging_ids)
    .bind(workspace)
    .bind(owner)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
      "INSERT INTO doc_snapshots (workspace_id,doc_id,payload,last_sequence)
      SELECT $2,id,$3,0 FROM unnest($1::uuid[]) id",
    )
    .bind(&paging_ids)
    .bind(workspace)
    .bind(yjs::markdown_to_yjs("Paging", "Page boundary fixture").unwrap())
    .execute(&pool)
    .await
    .unwrap();
    let (_, first, _) = get(&app, format!("/public/{workspace}?first=999")).await;
    assert_eq!(first.matches("data-myoxus-role=\"public-index-link\"").count(), 50);
    assert!(first.contains(">52 documents<") && first.contains("offset=50"));
    let (_, last, _) = get(&app, format!("/public/{workspace}?offset=50")).await;
    assert_eq!(last.matches("data-myoxus-role=\"public-index-link\"").count(), 2);
    let last_links = last.replace("&#x2F;", "/").replace("&#x2f;", "/");
    assert!(last_links.contains(&public_document_path(workspace, &paging_ids[50].to_string())));
    assert!(last_links.contains(&public_document_path(workspace, &paging_ids[51].to_string())));
    sqlx::query("UPDATE docs SET public_mode=NULL WHERE id=ANY($1)")
      .bind(&paging_ids[49..])
      .execute(&pool)
      .await
      .unwrap();
    let (_, after_revoke, _) = get(&app, format!("/public/{workspace}?offset=50")).await;
    assert_eq!(
      after_revoke.matches("data-myoxus-role=\"public-index-link\"").count(),
      49
    );
    assert!(after_revoke.contains(">49 documents<"));
    assert!(!after_revoke.contains(&paging_ids[50].to_string()) && !after_revoke.contains("rel=\"next\""));
  })
  .catch_unwind()
  .await;
  sqlx::query("UPDATE document_metadata_field_definition SET export_mode=$1 WHERE key='createdAt'")
    .bind(original_created_export)
    .execute(&pool)
    .await
    .expect("restore metadata export definition");
  std::fs::remove_file(&storage).expect("remove overview asset fixture");
  cleanup_blob_fixture_storage(workspace);
  helpers::cleanup_workspaces(&pool, &[workspace, foreign]).await;
  helpers::cleanup_users(&pool, &[owner]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
