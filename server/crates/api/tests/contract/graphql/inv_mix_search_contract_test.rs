//! P1 (MIX-M1) Search-Contract invariants: keyword downgrade must be gone.
//!
//! Each test in this module would FAIL if `workspace.search` /
//! `workspace.aggregate` reverted to silently picking the first non-empty
//! `match_value` from a `SearchQueryInputType`. The plan layer is exercised
//! end-to-end through GraphQL, so the assertions fail at the user-visible
//! boundary, not on internal helper calls.
//!
//! Operator/field matrix enforced by the plan:
//! - `Match` with `field = "plainText"` / `field = "title"` — FTS on the
//!   specified column.
//! - `Boolean` with `must` / `must_not` / `should` / `filter` — set algebra.
//! - `Exists` — non-null, non-empty column check.
//! - `Prefix` / `Phrase` / `Fuzzy` / `Wildcard` / `Regex` / `Boost` — stable
//!   `MIX_SRCH_OPERATOR_UNSUPPORTED` error.

use crate::helpers;

use std::sync::Arc;

use serde_json::{Value, json};
use uuid::Uuid;

use myoxus_api::graphql::auth::search_query::{
  ERR_FIELD_INVALID, ERR_FIELD_REQUIRED, ERR_OPERATOR_UNSUPPORTED, ERR_QUERY_EMPTY, ERR_SEARCH_UNAVAILABLE,
};
use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, AuthStore, AuthUser, InMemoryAuthStore, NewSession};
use myoxus_application::doc::{DocService, PanicDocStore};
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_domain::entities::SearchDocument;
use myoxus_domain::repositories::SearchRepository;
use myoxus_infrastructure::mail::LogMailAdapter;
use myoxus_infrastructure::search::SqlxSearchRepository;

use helpers::DummyStorage;

/// GraphQL query templates use variables so the test inputs are JSON-typed.
/// This matches the existing graphql_search.rs pattern and avoids inline
/// escape-soup.
const SEARCH_QUERY: &str = "query SearchTest($id: String!, $input: SearchInput!) { \
  workspace(id: $id) { \
    search(input: $input) { nodes { fields } pagination { count } } \
  } \
}";

const AGGREGATE_QUERY: &str = "query AggregateTest($id: String!, $input: AggregateInput!) { \
  workspace(id: $id) { \
    aggregate(input: $input) { buckets { key count } pagination { count } } \
  } \
}";

const SUPPORTED_OPERATORS: &[&str] = &["Match", "Boolean", "Exists"];
const UNSUPPORTED_OPERATORS: &[&str] = &["Prefix", "Phrase", "Fuzzy", "Wildcard", "Regex", "Boost"];

/// Test app wired with a real `SqlxSearchRepository`. The generic helpers in
/// `helpers::setup_app` deliberately do not configure search — they trust
/// the test to opt in. P1 search-contract tests must opt in.
async fn setup_app_with_search() -> (axum::Router, sqlx::PgPool, Arc<InMemoryAuthStore>) {
  let pool = helpers::setup_pool().await;
  let config = AppConfig::load().expect("AppConfig must load");
  let auth_store = Arc::new(InMemoryAuthStore::default());
  let storage = Arc::new(DummyStorage);
  let auth_service = AuthService::new(
    auth_store.clone(),
    Arc::new(LogMailAdapter),
    storage.clone(),
    3600,
    3600,
  );
  let workspace_service = WorkspaceService::new(auth_store.clone());
  let admin_service = AdminService::new(Arc::new(InMemoryAdminStore));
  let doc_service = DocService::new(Arc::new(PanicDocStore));
  let blob_service = Arc::new(BlobService::new(
    Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(
      sqlx::PgPool::connect_lazy("postgres://localhost").expect("lazy pool"),
    )),
    storage.clone(),
    "test-sign-key".to_string(),
  ));
  let search_repo = Arc::new(SqlxSearchRepository::new(pool.clone()));
  let state = Arc::new(
    ApiState::with_services(
      config,
      auth_service,
      workspace_service,
      admin_service,
      doc_service,
      blob_service,
      storage,
    )
    .with_search_repository(search_repo.clone()),
  );
  (build_router((*state).clone()), pool, auth_store)
}

async fn seed_user_with_search(pool: &sqlx::PgPool, auth_store: &InMemoryAuthStore, email: &str) -> (Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  let unique_email = format!("{email}_{user_id}@example.test");
  auth_store.insert_user(AuthUser {
    id: user_id,
    email: unique_email.clone(),
    name: Some(unique_email.clone()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });
  let session = auth_store
    .create_session(NewSession {
      id: Uuid::new_v4(),
      user_id,
      csrf_token: "csrf".to_string(),
      user_agent: None,
      ip_address: None,
      expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
      refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
      created_at: chrono::Utc::now(),
    })
    .await
    .expect("session creation");
  // Bump user into pg so PG-based ACL checks function.
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(&unique_email)
    .bind(&unique_email)
    .execute(pool)
    .await
    .expect("seed pg user");
  (user_id, session.id)
}

/// Create a workspace, register it in the PG layer, and seed a workspace
/// membership so the in-memory auth store treats the user as the owner.
async fn create_owned_workspace(pool: &sqlx::PgPool, auth_store: &Arc<InMemoryAuthStore>, user_id: Uuid) -> Uuid {
  use myoxus_application::workspace::WorkspaceService;
  let workspace_service = WorkspaceService::new(auth_store.clone());
  let workspace = workspace_service
    .create_workspace(user_id, Some("Search WS".to_string()), None)
    .await
    .expect("create workspace via service");
  // Mirror create_workspace SQL rows so foreign-key checks pass.
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
    .bind(workspace.id)
    .bind(user_id)
    .bind("Search WS")
    .execute(pool)
    .await
    .expect("seed pg workspace");
  sqlx::query("INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at) VALUES ($1, $2, 'Owner', 'Accepted', now())")
    .bind(workspace.id)
    .bind(user_id)
    .execute(pool)
    .await
    .expect("seed pg membership");
  workspace.id
}

/// Seed a single indexed search document with the given title and plain_text.
async fn upsert_search_doc(pool: &sqlx::PgPool, workspace_id: Uuid, doc_id: Uuid, title: &str, plain_text: &str) {
  sqlx::query(
    "INSERT INTO docs (id, workspace_id, title, default_role, is_workspace_root) VALUES ($1, $2, $3, 'viewer', FALSE)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(title)
  .execute(pool)
  .await
  .expect("seed doc");

  let repo = myoxus_infrastructure::search::SqlxSearchRepository::new(pool.clone());
  SearchRepository::upsert_search_doc(
    &repo,
    &SearchDocument {
      workspace_id,
      doc_id,
      title: title.to_string(),
      plain_text: plain_text.to_string(),
      workspace_tags: Vec::new(),
      search_vector: None,
      updated_at: chrono::Utc::now(),
    },
  )
  .await
  .expect("upsert search doc");
}

async fn cleanup_workspace(pool: &sqlx::PgPool, workspace_id: Uuid) {
  sqlx::query("DELETE FROM search_content WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .ok();
}

fn assert_no_panic_or_internal_error(payload: &Value) {
  let errors = payload.get("errors").map(|v| v.to_string()).unwrap_or_default();
  assert!(
    !errors.contains("panic") && !errors.contains("internal"),
    "GraphQL payload must not contain panic/internal errors: {errors}"
  );
}

fn make_search_payload(workspace_id: Uuid, query: Value) -> Value {
  json!({
    "query": SEARCH_QUERY,
    "variables": {
      "id": workspace_id.to_string(),
      "input": {
        "query": query,
        "options": { "pagination": { "limit": 10 } }
      }
    }
  })
}

fn make_aggregate_payload(workspace_id: Uuid, query: Value) -> Value {
  json!({
    "query": AGGREGATE_QUERY,
    "variables": {
      "id": workspace_id.to_string(),
      "input": {
        "query": query,
        "options": { "hits": { "pagination": { "limit": 10 } } }
      }
    }
  })
}

// ─── P1 INVARIANT 1 — Boolean AND is not keyword-only ────────────────────────

#[tokio::test]
async fn inv_mix_search_01_boolean_and_is_not_keyword_only() {
  let (app, pool, auth_store) = setup_app_with_search().await;
  let (owner_id, owner_session) = seed_user_with_search(&pool, auth_store.as_ref(), "mix01").await;
  let workspace_id = create_owned_workspace(&pool, &auth_store, owner_id).await;
  let doc_alpha_only = Uuid::new_v4();
  let doc_beta_only = Uuid::new_v4();
  let doc_both = Uuid::new_v4();

  upsert_search_doc(&pool, workspace_id, doc_alpha_only, "alpha", "alpha").await;
  upsert_search_doc(&pool, workspace_id, doc_beta_only, "beta", "beta").await;
  upsert_search_doc(&pool, workspace_id, doc_both, "both", "alpha beta").await;

  let resp = helpers::gql(
    &app,
    owner_session,
    make_search_payload(
      workspace_id,
      json!({
        "type": "Boolean",
        "queries": [
          { "type": "Match", "field": "plainText", "matchValue": "alpha", "occur": "must" },
          { "type": "Match", "field": "plainText", "matchValue": "beta", "occur": "must" }
        ]
      }),
    ),
  )
  .await;
  assert_no_panic_or_internal_error(&resp);
  let nodes = resp["data"]["workspace"]["search"]["nodes"]
    .as_array()
    .expect("nodes must be an array");
  assert_eq!(
    nodes.len(),
    1,
    "Boolean AND must intersect (only docs containing both alpha AND beta); got {}: {resp}",
    nodes.len()
  );
  let doc_id = nodes[0]["fields"]["docId"].as_str().expect("docId");
  assert_eq!(doc_id, doc_both.to_string());

  cleanup_workspace(&pool, workspace_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ─── P1 INVARIANT 2 — Exists filter is preserved ─────────────────────────────

#[tokio::test]
async fn inv_mix_search_02_exists_filter_is_preserved() {
  let (app, pool, auth_store) = setup_app_with_search().await;
  let (owner_id, owner_session) = seed_user_with_search(&pool, auth_store.as_ref(), "mix02").await;
  let workspace_id = create_owned_workspace(&pool, &auth_store, owner_id).await;
  let doc_titled = Uuid::new_v4();
  let doc_untitled = Uuid::new_v4();

  upsert_search_doc(&pool, workspace_id, doc_titled, "non-empty title", "body").await;
  // Empty title row to ensure Exists filters it out.
  upsert_search_doc(&pool, workspace_id, doc_untitled, "", "body").await;

  let resp = helpers::gql(
    &app,
    owner_session,
    make_search_payload(workspace_id, json!({ "type": "Exists", "field": "title" })),
  )
  .await;
  assert_no_panic_or_internal_error(&resp);
  let nodes = resp["data"]["workspace"]["search"]["nodes"]
    .as_array()
    .expect("nodes must be an array");
  assert_eq!(
    nodes.len(),
    1,
    "Exists(title) must return only docs whose title is non-empty; got {}: {resp}",
    nodes.len()
  );
  let doc_id = nodes[0]["fields"]["docId"].as_str().expect("docId");
  assert_eq!(doc_id, doc_titled.to_string());

  cleanup_workspace(&pool, workspace_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ─── P1 INVARIANT 3 — Unsupported operator returns explicit error ────────────

#[tokio::test]
async fn inv_mix_search_03_unsupported_query_type_returns_explicit_error() {
  let (app, pool, auth_store) = setup_app_with_search().await;
  let (owner_id, owner_session) = seed_user_with_search(&pool, auth_store.as_ref(), "mix03").await;
  let workspace_id = create_owned_workspace(&pool, &auth_store, owner_id).await;

  for op in UNSUPPORTED_OPERATORS {
    let resp = helpers::gql(
      &app,
      owner_session,
      make_search_payload(
        workspace_id,
        json!({ "type": op, "field": "plainText", "matchValue": "alpha" }),
      ),
    )
    .await;
    let errors = resp.get("errors").and_then(|v| v.as_array()).expect("errors array");
    assert!(
      !errors.is_empty(),
      "operator {} must produce a GraphQL error, got: {resp}",
      op
    );
    let has_stable_code = errors.iter().any(|err| {
      err
        .get("extensions")
        .and_then(|ext| ext.get("code"))
        .and_then(|c| c.as_str())
        == Some(ERR_OPERATOR_UNSUPPORTED)
    });
    assert!(
      has_stable_code,
      "operator {} must carry extension code {}: {resp}",
      op, ERR_OPERATOR_UNSUPPORTED
    );
  }

  cleanup_workspace(&pool, workspace_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ─── P1 INVARIANT 4 — Boolean SHOULD delivers union semantics ────────────────

#[tokio::test]
async fn inv_mix_search_04_boolean_should_union_semantics() {
  let (app, pool, auth_store) = setup_app_with_search().await;
  let (owner_id, owner_session) = seed_user_with_search(&pool, auth_store.as_ref(), "mix04").await;
  let workspace_id = create_owned_workspace(&pool, &auth_store, owner_id).await;
  let doc_alpha = Uuid::new_v4();
  let doc_beta = Uuid::new_v4();
  let doc_other = Uuid::new_v4();

  upsert_search_doc(&pool, workspace_id, doc_alpha, "alpha doc", "alpha only body").await;
  upsert_search_doc(&pool, workspace_id, doc_beta, "beta doc", "beta only body").await;
  upsert_search_doc(&pool, workspace_id, doc_other, "other doc", "unrelated body").await;

  let resp = helpers::gql(
    &app,
    owner_session,
    make_search_payload(
      workspace_id,
      json!({
        "type": "Boolean",
        "queries": [
          { "type": "Match", "field": "plainText", "matchValue": "alpha", "occur": "should" },
          { "type": "Match", "field": "plainText", "matchValue": "beta", "occur": "should" }
        ]
      }),
    ),
  )
  .await;
  assert_no_panic_or_internal_error(&resp);
  let nodes = resp["data"]["workspace"]["search"]["nodes"]
    .as_array()
    .expect("nodes must be an array");
  let mut ids: Vec<String> = nodes
    .iter()
    .map(|n| n["fields"]["docId"].as_str().unwrap_or_default().to_string())
    .collect();
  ids.sort();
  let mut expected = vec![doc_alpha.to_string(), doc_beta.to_string()];
  expected.sort();
  assert_eq!(ids, expected, "Boolean SHOULD must union; got {ids:?}");
  assert_eq!(
    nodes.len(),
    2,
    "Boolean SHOULD must return exactly alpha + beta; got {nodes:?}"
  );

  cleanup_workspace(&pool, workspace_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ─── P1 INVARIANT 5 — MUST NOT removes hits ──────────────────────────────────

#[tokio::test]
async fn inv_mix_search_05_must_not_removes_hits() {
  let (app, pool, auth_store) = setup_app_with_search().await;
  let (owner_id, owner_session) = seed_user_with_search(&pool, auth_store.as_ref(), "mix05").await;
  let workspace_id = create_owned_workspace(&pool, &auth_store, owner_id).await;
  let doc_a = Uuid::new_v4();
  let doc_b = Uuid::new_v4();
  let doc_other = Uuid::new_v4();

  upsert_search_doc(&pool, workspace_id, doc_a, "alpha", "alpha rust").await;
  upsert_search_doc(&pool, workspace_id, doc_b, "alpha2", "alpha also contains rust").await;
  upsert_search_doc(&pool, workspace_id, doc_other, "alpha but no rust", "alpha only").await;

  let resp = helpers::gql(
    &app,
    owner_session,
    make_search_payload(
      workspace_id,
      json!({
        "type": "Boolean",
        "queries": [
          { "type": "Match", "field": "plainText", "matchValue": "alpha", "occur": "must" },
          { "type": "Match", "field": "plainText", "matchValue": "rust", "occur": "must_not" }
        ]
      }),
    ),
  )
  .await;
  assert_no_panic_or_internal_error(&resp);
  let nodes = resp["data"]["workspace"]["search"]["nodes"]
    .as_array()
    .expect("nodes must be an array");
  assert_eq!(
    nodes.len(),
    1,
    "must_not must remove docs that contain 'rust'; got {}: {resp}",
    nodes.len()
  );
  let doc_id = nodes[0]["fields"]["docId"].as_str().expect("docId");
  assert_eq!(doc_id, doc_other.to_string());

  cleanup_workspace(&pool, workspace_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ─── P1 INVARIANT 6 — Plain keyword search remains compatible ────────────────

#[tokio::test]
async fn inv_mix_search_06_keyword_compat() {
  let (app, pool, auth_store) = setup_app_with_search().await;
  let (owner_id, owner_session) = seed_user_with_search(&pool, auth_store.as_ref(), "mix06").await;
  let workspace_id = create_owned_workspace(&pool, &auth_store, owner_id).await;
  let doc_match = Uuid::new_v4();
  let doc_no_match = Uuid::new_v4();

  upsert_search_doc(&pool, workspace_id, doc_match, "alpha doc", "alpha body").await;
  upsert_search_doc(&pool, workspace_id, doc_no_match, "other", "no-match body").await;

  // Legacy shape: no type, just matchValue.
  let resp = helpers::gql(
    &app,
    owner_session,
    make_search_payload(workspace_id, json!({ "field": "plainText", "matchValue": "alpha" })),
  )
  .await;
  assert_no_panic_or_internal_error(&resp);
  let nodes = resp["data"]["workspace"]["search"]["nodes"]
    .as_array()
    .expect("nodes must be an array");
  assert_eq!(
    nodes.len(),
    1,
    "plain keyword query must continue to work; got {}: {resp}",
    nodes.len()
  );

  cleanup_workspace(&pool, workspace_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ─── P1 INVARIANT 7 — aggregate count matches search count ───────────────────

#[tokio::test]
async fn inv_mix_aggregate_01_all_bucket_matches_search_count() {
  let (app, pool, auth_store) = setup_app_with_search().await;
  let (owner_id, owner_session) = seed_user_with_search(&pool, auth_store.as_ref(), "mix07").await;
  let workspace_id = create_owned_workspace(&pool, &auth_store, owner_id).await;
  let doc_alpha = Uuid::new_v4();
  let doc_beta = Uuid::new_v4();
  let doc_other = Uuid::new_v4();

  upsert_search_doc(&pool, workspace_id, doc_alpha, "alpha", "alpha body").await;
  upsert_search_doc(&pool, workspace_id, doc_beta, "beta", "beta body").await;
  upsert_search_doc(&pool, workspace_id, doc_other, "other", "unrelated").await;

  let query = json!({
    "type": "Boolean",
    "queries": [
      { "type": "Match", "field": "plainText", "matchValue": "alpha", "occur": "should" },
      { "type": "Match", "field": "plainText", "matchValue": "beta", "occur": "should" }
    ]
  });
  let search_resp = helpers::gql(&app, owner_session, make_search_payload(workspace_id, query.clone())).await;
  let aggregate_resp = helpers::gql(&app, owner_session, make_aggregate_payload(workspace_id, query)).await;
  assert_no_panic_or_internal_error(&search_resp);
  assert_no_panic_or_internal_error(&aggregate_resp);

  let search_count = search_resp["data"]["workspace"]["search"]["pagination"]["count"]
    .as_i64()
    .expect("search count must be i64");
  let agg_count = aggregate_resp["data"]["workspace"]["aggregate"]["buckets"][0]["count"]
    .as_i64()
    .expect("aggregate bucket count must be i64");
  assert_eq!(
    agg_count, search_count,
    "aggregate count must equal search count under the same plan; search={} aggregate={}",
    search_count, agg_count
  );
  assert_eq!(agg_count, 2, "should-union of alpha + beta must yield 2");

  cleanup_workspace(&pool, workspace_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_mix_aggregate_02_complex_query_count_matches_search() {
  let (app, pool, auth_store) = setup_app_with_search().await;
  let (owner_id, owner_session) = seed_user_with_search(&pool, auth_store.as_ref(), "mix08").await;
  let workspace_id = create_owned_workspace(&pool, &auth_store, owner_id).await;
  let doc_both = Uuid::new_v4();
  let doc_alpha = Uuid::new_v4();
  let doc_beta = Uuid::new_v4();
  let doc_neither = Uuid::new_v4();

  upsert_search_doc(&pool, workspace_id, doc_both, "both", "alpha beta").await;
  upsert_search_doc(&pool, workspace_id, doc_alpha, "alpha", "alpha only").await;
  upsert_search_doc(&pool, workspace_id, doc_beta, "beta", "beta only").await;
  upsert_search_doc(&pool, workspace_id, doc_neither, "neither", "unrelated").await;

  let query = json!({
    "type": "Boolean",
    "queries": [
      { "type": "Match", "field": "plainText", "matchValue": "alpha", "occur": "must" },
      { "type": "Match", "field": "plainText", "matchValue": "beta", "occur": "must" }
    ]
  });
  let search_resp = helpers::gql(&app, owner_session, make_search_payload(workspace_id, query.clone())).await;
  let aggregate_resp = helpers::gql(&app, owner_session, make_aggregate_payload(workspace_id, query)).await;
  assert_no_panic_or_internal_error(&search_resp);
  assert_no_panic_or_internal_error(&aggregate_resp);
  let search_count = search_resp["data"]["workspace"]["search"]["pagination"]["count"]
    .as_i64()
    .expect("search count i64");
  let agg_count = aggregate_resp["data"]["workspace"]["aggregate"]["buckets"][0]["count"]
    .as_i64()
    .expect("aggregate bucket count i64");
  assert_eq!(
    agg_count, search_count,
    "Boolean AND aggregate count must equal search count; search={} aggregate={}",
    search_count, agg_count
  );
  assert_eq!(agg_count, 1, "alpha AND beta must yield 1 (only doc_both)");

  cleanup_workspace(&pool, workspace_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_mix_aggregate_03_no_fake_facet_buckets() {
  let (app, pool, auth_store) = setup_app_with_search().await;
  let (owner_id, owner_session) = seed_user_with_search(&pool, auth_store.as_ref(), "mix09").await;
  let workspace_id = create_owned_workspace(&pool, &auth_store, owner_id).await;
  let doc_a = Uuid::new_v4();
  let doc_b = Uuid::new_v4();
  upsert_search_doc(&pool, workspace_id, doc_a, "alpha", "alpha body").await;
  upsert_search_doc(&pool, workspace_id, doc_b, "alpha2", "alpha body too").await;

  let resp = helpers::gql(
    &app,
    owner_session,
    make_aggregate_payload(
      workspace_id,
      json!({ "type": "Match", "field": "plainText", "matchValue": "alpha" }),
    ),
  )
  .await;
  assert_no_panic_or_internal_error(&resp);
  let buckets = resp["data"]["workspace"]["aggregate"]["buckets"]
    .as_array()
    .expect("buckets array");
  assert_eq!(
    buckets.len(),
    1,
    "aggregate must not invent fake facets; got {} buckets",
    buckets.len()
  );
  assert_eq!(buckets[0]["key"].as_str(), Some("all"));
  assert_eq!(buckets[0]["count"].as_i64(), Some(2));

  cleanup_workspace(&pool, workspace_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ─── P1 INVARIANT 8 — Plan compile-time errors propagate with stable code ────

#[tokio::test]
async fn inv_mix_plan_compile_propagates_stable_codes() {
  let (app, pool, auth_store) = setup_app_with_search().await;
  let (owner_id, owner_session) = seed_user_with_search(&pool, auth_store.as_ref(), "mix10").await;
  let workspace_id = create_owned_workspace(&pool, &auth_store, owner_id).await;

  // Invalid field name
  let resp = helpers::gql(
    &app,
    owner_session,
    make_search_payload(
      workspace_id,
      json!({ "type": "Match", "field": "not_a_field", "matchValue": "alpha" }),
    ),
  )
  .await;
  let errors = resp.get("errors").and_then(|v| v.as_array()).expect("errors array");
  assert!(!errors.is_empty(), "invalid field must error");
  let has_code = errors.iter().any(|err| {
    err
      .get("extensions")
      .and_then(|ext| ext.get("code"))
      .and_then(|c| c.as_str())
      == Some(ERR_FIELD_INVALID)
  });
  assert!(has_code, "invalid field must carry code {ERR_FIELD_INVALID}: {resp}");

  // Exists without a field
  let resp = helpers::gql(
    &app,
    owner_session,
    make_search_payload(workspace_id, json!({ "type": "Exists" })),
  )
  .await;
  let errors = resp.get("errors").and_then(|v| v.as_array()).expect("errors array");
  let has_code = errors.iter().any(|err| {
    err
      .get("extensions")
      .and_then(|ext| ext.get("code"))
      .and_then(|c| c.as_str())
      == Some(ERR_FIELD_REQUIRED)
  });
  assert!(
    has_code,
    "Exists without field must carry code {ERR_FIELD_REQUIRED}: {resp}"
  );

  // Empty Match (no match_value)
  let resp = helpers::gql(
    &app,
    owner_session,
    make_search_payload(workspace_id, json!({ "type": "Match", "field": "plainText" })),
  )
  .await;
  let errors = resp.get("errors").and_then(|v| v.as_array()).expect("errors array");
  let has_code = errors.iter().any(|err| {
    err
      .get("extensions")
      .and_then(|ext| ext.get("code"))
      .and_then(|c| c.as_str())
      == Some(ERR_QUERY_EMPTY)
  });
  assert!(has_code, "empty Match must carry code {ERR_QUERY_EMPTY}: {resp}");

  cleanup_workspace(&pool, workspace_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_mix_execution_failure_is_not_reported_as_invalid_input() {
  let (app, pool, auth_store) = setup_app_with_search().await;
  let (owner_id, owner_session) = seed_user_with_search(&pool, auth_store.as_ref(), "mix-unavailable").await;
  let workspace_id = create_owned_workspace(&pool, &auth_store, owner_id).await;

  // Remove persistent fixtures before closing every clone of the repository
  // pool. The in-memory auth owner remains valid for the GraphQL request.
  cleanup_workspace(&pool, workspace_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
  pool.close().await;

  for (field, payload) in [
    (
      "search",
      make_search_payload(
        workspace_id,
        json!({ "type": "Match", "field": "plainText", "matchValue": "valid" }),
      ),
    ),
    (
      "aggregate",
      make_aggregate_payload(
        workspace_id,
        json!({ "type": "Match", "field": "plainText", "matchValue": "valid" }),
      ),
    ),
  ] {
    let response = helpers::gql(&app, owner_session, payload).await;
    assert_eq!(response["data"]["workspace"][field], Value::Null, "{response}");
    let error = &response["errors"][0];
    assert_eq!(error["extensions"]["code"], ERR_SEARCH_UNAVAILABLE, "{response}");
    assert_eq!(error["message"], format!("{field}: search is temporarily unavailable"));
    assert!(
      !response.to_string().contains("pool is closed"),
      "repository details must remain internal: {response}"
    );
  }

  let empty = helpers::gql(
    &app,
    owner_session,
    make_search_payload(workspace_id, json!({ "type": "Match", "field": "plainText" })),
  )
  .await;
  assert_eq!(empty["errors"][0]["extensions"]["code"], ERR_QUERY_EMPTY, "{empty}");
}

// ─── P1 INVARIANT 9 — supported operators sanity (no regression) ─────────────

#[tokio::test]
async fn inv_mix_search_supported_operators_do_not_regress() {
  let (app, pool, auth_store) = setup_app_with_search().await;
  let (owner_id, owner_session) = seed_user_with_search(&pool, auth_store.as_ref(), "mix11").await;
  let workspace_id = create_owned_workspace(&pool, &auth_store, owner_id).await;

  for op in SUPPORTED_OPERATORS {
    let resp = helpers::gql(
      &app,
      owner_session,
      make_search_payload(
        workspace_id,
        json!({ "type": op, "field": "plainText", "matchValue": "alpha" }),
      ),
    )
    .await;
    assert_no_panic_or_internal_error(&resp);
    // Boolean without branches is EmptyQuery (supported), but Match/Exists
    // with a value must succeed without errors.
    let errors = resp
      .get("errors")
      .and_then(|v| v.as_array())
      .cloned()
      .unwrap_or_default();
    if *op == "Boolean" && !errors.is_empty() {
      // Empty boolean with single child: still rejected as EmptyQuery (allowed).
      let has_empty = errors.iter().any(|err| {
        err
          .get("extensions")
          .and_then(|ext| ext.get("code"))
          .and_then(|c| c.as_str())
          == Some(ERR_QUERY_EMPTY)
      });
      assert!(has_empty, "Boolean error must be EmptyQuery, got: {resp}");
    } else if !errors.is_empty() {
      panic!("supported operator {op} must not error: {resp}");
    }
  }

  cleanup_workspace(&pool, workspace_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}
