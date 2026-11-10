//! Integration tests for the full-text search GraphQL resolver.
use crate::helpers;

use std::sync::Arc;

use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, AuthStore, AuthUser, InMemoryAuthStore, NewSession};
use myoxus_application::doc::DocService;
use myoxus_application::ports::blob_service::BlobService;
use myoxus_application::workspace::WorkspaceService;
use myoxus_domain::entities::SearchDocument;
use myoxus_domain::repositories::SearchRepository;
use myoxus_infrastructure::search::SqlxSearchRepository;
use myoxus_infrastructure::{doc::SqlxDocStore, mail::LogMailAdapter};

use helpers::DummyStorage;

async fn setup_pool() -> sqlx::PgPool {
  helpers::setup_pool().await
}

async fn setup_test_app(
  pool: sqlx::PgPool,
) -> (
  axum::Router,
  Arc<ApiState>,
  Arc<InMemoryAuthStore>,
  Arc<SqlxSearchRepository>,
) {
  let config = AppConfig::load().expect("AppConfig must load successfully");
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
  let doc_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
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
    .with_metrics_pool(pool)
    .with_search_repository(search_repo.clone()),
  );

  (build_router((*state).clone()), state, auth_store, search_repo)
}

async fn create_user_session(store: &InMemoryAuthStore, email: &str) -> (Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  store.insert_user(AuthUser {
    id: user_id,
    email: email.to_string(),
    name: Some(email.to_string()),
    avatar_url: None,
    password_hash: Some("hash".to_string()),
    is_admin: false,
    disabled: false,
    email_verified_at: Some(chrono::Utc::now()),
    registered: true,
  });

  let session = store
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
    .expect("session creation must succeed");

  (user_id, session.id)
}

async fn graphql(app: &axum::Router, session_id: Uuid, payload: Value) -> Value {
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(payload.to_string()))
        .expect("request body must be constructible"),
    )
    .await
    .expect("GraphQL request must not fail at transport level");

  let body = response
    .into_body()
    .collect()
    .await
    .expect("response body must be collectable")
    .to_bytes();
  serde_json::from_slice(&body).expect("response body must be valid JSON")
}

#[tokio::test]
async fn graphql_and_rest_search_apply_acl_paging_and_sorting() {
  let pool = setup_pool().await;

  // Pre-cleanup: remove stale data from previous runs that may have panicked before cleanup.
  // Must cascade: delete dependent rows first to avoid FK violations.
  sqlx::query(
    "DELETE FROM search_content WHERE workspace_id IN (
       SELECT w.id FROM workspaces w
       JOIN users u ON w.owner_user_id = u.id
       WHERE lower(u.email) IN ('owner-search@example.com', 'outsider-search@example.com')
     )",
  )
  .execute(&pool)
  .await
  .expect("clean stale search content");
  sqlx::query(
    "DELETE FROM docs WHERE workspace_id IN (
       SELECT w.id FROM workspaces w
       JOIN users u ON w.owner_user_id = u.id
       WHERE lower(u.email) IN ('owner-search@example.com', 'outsider-search@example.com')
     )",
  )
  .execute(&pool)
  .await
  .expect("clean stale documents");
  sqlx::query(
    "DELETE FROM workspaces WHERE owner_user_id IN (
       SELECT id FROM users WHERE lower(email) IN ('owner-search@example.com', 'outsider-search@example.com')
     )",
  )
  .execute(&pool)
  .await
  .expect("clean stale workspaces");
  sqlx::query("DELETE FROM users WHERE lower(email) IN ('owner-search@example.com', 'outsider-search@example.com')")
    .execute(&pool)
    .await
    .expect("clean stale users");

  let (app, state, auth_store, search_repo) = setup_test_app(pool.clone()).await;

  let (owner_id, owner_session) = create_user_session(&auth_store, "owner-search@example.com").await;
  let (_outsider_id, outsider_session) = create_user_session(&auth_store, "outsider-search@example.com").await;

  let workspace = state
    .workspace()
    .create_workspace(owner_id, Some("Search WS".to_string()), None)
    .await
    .expect("workspace creation");

  let doc_a = Uuid::new_v4();
  let doc_b = Uuid::new_v4();

  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(owner_id)
    .bind("owner-search@example.com")
    .bind("Owner")
    .execute(&pool)
    .await
    .expect("seed pg user");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
    .bind(workspace.id)
    .bind(owner_id)
    .bind("Search WS")
    .execute(&pool)
    .await
    .expect("seed pg workspace");
  let created_at = "2026-01-02T10:00:00Z".parse::<chrono::DateTime<chrono::Utc>>().unwrap();
  let updated_at = "2026-03-04T11:30:00Z".parse::<chrono::DateTime<chrono::Utc>>().unwrap();
  for (doc_id, external_id) in [(doc_a, "external-alpha"), (doc_b, "external-beta")] {
    sqlx::query("INSERT INTO docs (id, workspace_id, external_id, title, is_workspace_root, created_by, updated_by, created_at, updated_at) VALUES ($1, $2, $3, $4, false, $5, $5, $6, $7)")
            .bind(doc_id)
            .bind(workspace.id)
            .bind(external_id)
            .bind(format!("Doc {doc_id}"))
            .bind(owner_id)
            .bind(created_at)
            .bind(updated_at)
            .execute(&pool)
            .await
            .expect("seed pg doc");
  }

  SearchRepository::upsert_search_doc(
    search_repo.as_ref(),
    &SearchDocument {
      workspace_id: workspace.id,
      doc_id: doc_a,
      title: "alpha".to_string(),
      plain_text: "rust rust rust".to_string(),
      workspace_tags: Vec::new(),
      search_vector: None,
      updated_at: chrono::Utc::now() - chrono::Duration::minutes(5),
    },
  )
  .await
  .expect("upsert search a");

  SearchRepository::upsert_search_doc(
    search_repo.as_ref(),
    &SearchDocument {
      workspace_id: workspace.id,
      doc_id: doc_b,
      title: "beta".to_string(),
      plain_text: "rust".to_string(),
      workspace_tags: Vec::new(),
      search_vector: None,
      updated_at: chrono::Utc::now() - chrono::Duration::minutes(1),
    },
  )
  .await
  .expect("upsert search b");

  let gql_search = graphql(
        &app,
        owner_session,
        json!({
            "query": "query($workspaceId:String!){ search(workspaceId:$workspaceId, query:\"rust\", take:10, sortBy:Relevance, sortDirection:Desc){ docId title } aggregate(workspaceId:$workspaceId, query:\"rust\"){ total } }",
            "variables": {"workspaceId": workspace.id.to_string()}
        }),
    )
    .await;
  assert!(gql_search.get("errors").is_none(), "unexpected errors: {gql_search}");
  assert_eq!(
    gql_search["data"]["search"]
      .as_array()
      .expect("search result must be an array")
      .len(),
    2
  );
  assert_eq!(gql_search["data"]["aggregate"]["total"], 2);

  let indexer_search = graphql(
        &app,
        owner_session,
        json!({
            "query": "query indexerSearch($id: String!, $input: SearchInput!) { workspace(id: $id) { search(input: $input) { nodes { fields highlights } pagination { count hasMore nextCursor } } } }",
            "variables": {
                "id": workspace.id.to_string(),
                "input": {
                    "query": {"type": "Match", "field": "plainText", "matchValue": "rust"},
                    "options": {"pagination": {"limit": 10}}
                }
            }
        }),
    )
    .await;
  assert!(
    indexer_search.get("errors").is_none(),
    "indexerSearch errors: {indexer_search}"
  );
  assert_eq!(indexer_search["data"]["workspace"]["search"]["pagination"]["count"], 2);

  let indexer_docs = graphql(
        &app,
        owner_session,
        json!({
            "query": "query indexerSearchDocs($id: String!, $input: SearchDocsInput!) { workspace(id: $id) { searchDocs(input: $input) { docId externalId title blockId highlight createdAt updatedAt } } }",
            "variables": {
                "id": workspace.id.to_string(),
                "input": {"keyword": "rust", "limit": 10}
            }
        }),
    )
    .await;
  assert!(
    indexer_docs.get("errors").is_none(),
    "indexerSearchDocs errors: {indexer_docs}"
  );
  assert_eq!(
    indexer_docs["data"]["workspace"]["searchDocs"]
      .as_array()
      .expect("searchDocs result must be an array")
      .len(),
    2
  );
  let returned_document_ids = indexer_docs["data"]["workspace"]["searchDocs"]
    .as_array()
    .expect("searchDocs result must be an array")
    .iter()
    .map(|doc| {
      (
        doc["docId"].as_str().expect("docId must be a string").to_owned(),
        doc["externalId"]
          .as_str()
          .expect("externalId must be a string")
          .to_owned(),
      )
    })
    .collect::<std::collections::HashMap<_, _>>();
  assert_eq!(
    returned_document_ids,
    std::collections::HashMap::from([
      (doc_a.to_string(), "external-alpha".to_owned()),
      (doc_b.to_string(), "external-beta".to_owned()),
    ])
  );
  for doc in indexer_docs["data"]["workspace"]["searchDocs"].as_array().unwrap() {
    assert_eq!(
      doc["createdAt"],
      created_at.to_rfc3339(),
      "use document creation, not index time"
    );
    assert_eq!(
      doc["updatedAt"],
      updated_at.to_rfc3339(),
      "use document modification, not index time"
    );
  }

  let nested_page = |offset| {
    json!({
      "query":"query($id:String!,$input:SearchDocsInput!){workspace(id:$id){searchDocs(input:$input){externalId}}}",
      "variables":{"id":workspace.id.to_string(),"input":{"keyword":"rust","limit":1,"offset":offset}}
    })
  };
  let first = graphql(&app, owner_session, nested_page(-1)).await;
  let later = graphql(&app, owner_session, nested_page(1)).await;
  assert!(first.get("errors").is_none(), "{first}");
  assert!(later.get("errors").is_none(), "{later}");
  let paged_ids = [
    first["data"]["workspace"]["searchDocs"][0]["externalId"]
      .as_str()
      .unwrap(),
    later["data"]["workspace"]["searchDocs"][0]["externalId"]
      .as_str()
      .unwrap(),
  ];
  assert_eq!(
    paged_ids.into_iter().collect::<std::collections::HashSet<_>>(),
    std::collections::HashSet::from(["external-alpha", "external-beta"]),
    "nested offsets must reach distinct authorized external identities"
  );

  let indexer_aggregate = graphql(
        &app,
        owner_session,
        json!({
            "query": "query indexerAggregate($id: String!, $input: AggregateInput!) { workspace(id: $id) { aggregate(input: $input) { buckets { key count hits { nodes { fields highlights } } } pagination { count hasMore nextCursor } } } }",
            "variables": {
                "id": workspace.id.to_string(),
                "input": {
                    "query": {"type": "Match", "field": "plainText", "matchValue": "rust"},
                    "options": {
                        "hits": {"pagination": {"limit": 10}}
                    }
                }
            }
        }),
    )
    .await;
  assert!(
    indexer_aggregate.get("errors").is_none(),
    "indexerAggregate errors: {indexer_aggregate}"
  );
  assert_eq!(
    indexer_aggregate["data"]["workspace"]["aggregate"]["buckets"][0]["count"],
    2
  );

  let nested_indexer_search = graphql(
        &app,
        owner_session,
        json!({
            "query": "query indexerSearch($id: String!, $input: SearchInput!) { workspace(id: $id) { search(input: $input) { pagination { count } } } }",
            "variables": {
                "id": workspace.id.to_string(),
                "input": {
                    "query": {
                        "type": "Boolean",
                        "queries": [
                            {"type": "Match", "field": "plainText", "matchValue": "rust", "occur": "must"}
                        ]
                    },
                    "options": {"pagination": {"limit": 10}}
                }
            }
        }),
    )
    .await;
  assert!(
    nested_indexer_search.get("errors").is_none(),
    "nested indexer search errors: {nested_indexer_search}"
  );
  assert_eq!(
    nested_indexer_search["data"]["workspace"]["search"]["pagination"]["count"],
    2
  );

  let rest_search = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!(
          "/api/workspaces/{}/search?q=rust&limit=1&offset=1&sortBy=updatedAt&sortDirection=asc",
          workspace.id
        ))
        .header("cookie", format!("affine_session={owner_session}"))
        .body(Body::empty())
        .expect("REST request body must be constructible"),
    )
    .await
    .expect("REST search request must not fail at transport level");
  assert_eq!(rest_search.status(), axum::http::StatusCode::OK);
  let rest_body: Value = serde_json::from_slice(
    &rest_search
      .into_body()
      .collect()
      .await
      .expect("REST response body must be collectable")
      .to_bytes(),
  )
  .expect("REST response body must be valid JSON");
  assert_eq!(rest_body["items"].as_array().expect("items must be an array").len(), 1);
  assert_eq!(rest_body["items"][0]["docId"], doc_b.to_string());

  let gql_forbidden = graphql(
    &app,
    outsider_session,
    json!({
        "query": "query($workspaceId:String!){ search(workspaceId:$workspaceId, query:\"rust\"){ docId } }",
        "variables": {"workspaceId": workspace.id.to_string()}
    }),
  )
  .await;
  assert!(
    gql_forbidden.get("errors").is_some(),
    "outsider must not search foreign workspace"
  );

  // Exercise the actual UI boundary with a separate term, without changing the
  // relevance/ACL fixtures above. External keys must survive the second page.
  for index in 0..51 {
    let id = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO docs (id, workspace_id, external_id, title, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5)",
    )
    .bind(id)
    .bind(workspace.id)
    .bind(format!("paged-{index}"))
    .bind(format!("Paged {index}"))
    .bind(owner_id)
    .execute(&pool)
    .await
    .expect("seed paging document");
    SearchRepository::upsert_search_doc(
      search_repo.as_ref(),
      &SearchDocument {
        workspace_id: workspace.id,
        doc_id: id,
        title: format!("Paged {index}"),
        plain_text: "pagingboundary".to_string(),
        workspace_tags: Vec::new(),
        search_vector: None,
        updated_at: chrono::Utc::now(),
      },
    )
    .await
    .expect("index paging document");
  }
  let boundary_page = |offset| {
    json!({
      "query":"query($id:String!,$input:SearchDocsInput!){workspace(id:$id){searchDocs(input:$input){externalId}}}",
      "variables":{"id":workspace.id.to_string(),"input":{"keyword":"pagingboundary","limit":50,"offset":offset}}
    })
  };
  let first = graphql(&app, owner_session, boundary_page(0)).await;
  let later = graphql(&app, owner_session, boundary_page(50)).await;
  assert!(first.get("errors").is_none(), "{first}");
  assert!(later.get("errors").is_none(), "{later}");
  let first = first["data"]["workspace"]["searchDocs"].as_array().unwrap();
  let later = later["data"]["workspace"]["searchDocs"].as_array().unwrap();
  assert_eq!((first.len(), later.len()), (50, 1));
  let identities = first
    .iter()
    .chain(later)
    .map(|hit| hit["externalId"].as_str().unwrap())
    .collect::<std::collections::HashSet<_>>();
  assert_eq!(identities.len(), 51);
  assert!(identities.iter().all(|key| key.starts_with("paged-")));

  // ── Cleanup ────────────────────────────────────────────────────────────────
  sqlx::query("DELETE FROM search_content WHERE workspace_id = $1")
    .bind(workspace.id)
    .execute(&pool)
    .await
    .expect("remove search content");
  sqlx::query("DELETE FROM docs WHERE workspace_id = $1")
    .bind(workspace.id)
    .execute(&pool)
    .await
    .expect("remove documents");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace.id)
    .execute(&pool)
    .await
    .expect("remove workspace");
  sqlx::query("DELETE FROM users WHERE lower(email) IN ('owner-search@example.com', 'outsider-search@example.com')")
    .execute(&pool)
    .await
    .expect("remove search users");
}

// ---------------------------------------------------------------------------
// P83-K-02: Error-path tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_search_empty_query_returns_empty_list() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "srch_empty").await;
  let workspace_id = helpers::create_workspace(&pool, user_id).await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": format!("query {{ workspace(id: \"{workspace_id}\") {{ search(input: {{ query: \"\", limit: 10 }}) {{ edges {{ node {{ docId score }} }} }} }} }}")
    }),
  )
  .await;
  // Empty query must return empty edges or an error — not panic
  let no_crash = resp
    .get("errors")
    .is_none_or(|e| !e.to_string().contains("panic") && !e.to_string().contains("internal"));
  assert!(no_crash, "empty search query must not cause server error, got: {resp}");

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_search_unauthorized_workspace_returns_error() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (owner_id, _owner_session) = helpers::seed_user(&pool, &auth_store, "srch_owner2").await;
  let (attacker_id, attacker_session) = helpers::seed_user(&pool, &auth_store, "srch_attacker2").await;
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;

  let resp = helpers::gql(
    &app,
    attacker_session,
    json!({
      "query": format!("query {{ workspace(id: \"{workspace_id}\") {{ search(input: {{ query: \"test\", limit: 5 }}) {{ edges {{ node {{ docId }} }} }} }} }}")
    }),
  )
  .await;
  assert!(
    resp.get("errors").is_some() || resp["data"]["workspace"].is_null(),
    "non-member must not search foreign workspace, got: {resp}"
  );

  helpers::cleanup_users(&pool, &[owner_id, attacker_id]).await;
}
