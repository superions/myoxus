//! Integration tests for the PostgreSQL FTS search repository (index, query, rank).
use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

use myoxus_domain::entities::SearchDocument;
use myoxus_domain::repositories::{PageRequest, SearchPageRequest, SearchRepository, SearchSortBy, SortDirection};
use myoxus_domain::workspace_tags::{WorkspaceTagColorRole, WorkspaceTagSearchProjection};
use myoxus_infrastructure::search::{SqlxSearchRepository, hybrid_search};

async fn setup_pool() -> PgPool {
  let database_url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  let pool = PgPool::connect(&database_url)
    .await
    .expect("postgres must be reachable for search repository tests");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("migrations must succeed");
  pool
}

async fn seed_workspace(pool: &PgPool) -> (Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();

  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(format!("search-repo-{user_id}@example.test"))
    .bind("Search Repo User")
    .execute(pool)
    .await
    .expect("seed user");

  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
    .bind(workspace_id)
    .bind(user_id)
    .bind("Search Repo Workspace")
    .execute(pool)
    .await
    .expect("seed workspace");

  (workspace_id, user_id)
}

async fn seed_doc(pool: &PgPool, workspace_id: Uuid, user_id: Uuid, title: &str) -> Uuid {
  let doc_id = Uuid::new_v4();

  sqlx::query(
        "INSERT INTO docs (id, workspace_id, title, is_workspace_root, created_by, updated_by) VALUES ($1, $2, $3, false, $4, $4)",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(title)
    .bind(user_id)
    .execute(pool)
    .await
    .expect("seed doc");

  doc_id
}

#[tokio::test]
async fn search_docs_are_workspace_scoped_and_ranked() {
  let pool = setup_pool().await;
  let repo = SqlxSearchRepository::new(pool.clone());

  let (workspace_a, user_a) = seed_workspace(&pool).await;
  let doc_a1 = seed_doc(&pool, workspace_a, user_a, "Rust Deep Dive").await;
  let doc_a2 = seed_doc(&pool, workspace_a, user_a, "Rust Notes").await;
  let (workspace_b, user_b) = seed_workspace(&pool).await;
  let doc_b1 = seed_doc(&pool, workspace_b, user_b, "Foreign").await;

  repo
    .upsert_search_doc(&SearchDocument {
      workspace_id: workspace_a,
      doc_id: doc_a1,
      title: "Rust Deep Dive".to_string(),
      plain_text: "rust rust rust rust rust ranking signals".to_string(),
      workspace_tags: Vec::new(),
      search_vector: None,
      updated_at: Utc::now(),
    })
    .await
    .expect("upsert doc a1");

  repo
    .upsert_search_doc(&SearchDocument {
      workspace_id: workspace_a,
      doc_id: doc_a2,
      title: "Rust Notes".to_string(),
      plain_text: "rust ranking notes and snippets".to_string(),
      workspace_tags: vec![WorkspaceTagSearchProjection {
        id: Uuid::new_v4(),
        name: "Release Ready".to_string(),
        slug: "release-ready".to_string(),
        color_role: WorkspaceTagColorRole::Green,
      }],
      search_vector: None,
      updated_at: Utc::now(),
    })
    .await
    .expect("upsert doc a2");

  repo
    .upsert_search_doc(&SearchDocument {
      workspace_id: workspace_b,
      doc_id: doc_b1,
      title: "Foreign".to_string(),
      plain_text: "rust rust rust ranking signals".to_string(),
      workspace_tags: Vec::new(),
      search_vector: None,
      updated_at: Utc::now(),
    })
    .await
    .expect("upsert doc b1");

  let results = repo
    .search_docs(SearchPageRequest {
      query: "rust".to_string(),
      language: Some("en-US".to_string()),
      sort_by: SearchSortBy::Relevance,
      sort_direction: SortDirection::Desc,
      workspace_id: workspace_a,
      page: PageRequest { limit: 10, offset: 0 },
    })
    .await
    .expect("search docs");

  assert_eq!(results.len(), 2, "only docs in workspace A should be visible");
  assert_eq!(results[0].doc_id, doc_a1, "higher relevance doc must rank first");
  assert_eq!(results[1].doc_id, doc_a2);
  assert!(results.iter().all(|d| d.workspace_id == workspace_a));

  let tag_results = repo
    .search_docs(SearchPageRequest {
      query: "release-ready".to_string(),
      language: Some("en-US".to_string()),
      sort_by: SearchSortBy::Relevance,
      sort_direction: SortDirection::Desc,
      workspace_id: workspace_a,
      page: PageRequest { limit: 10, offset: 0 },
    })
    .await
    .expect("search by canonical workspace tag slug");
  assert_eq!(tag_results.len(), 1);
  assert_eq!(tag_results[0].doc_id, doc_a2);
  assert_eq!(tag_results[0].workspace_tags[0].name, "Release Ready");
  assert_eq!(tag_results[0].workspace_tags[0].slug, "release-ready");
  assert_eq!(
    tag_results[0].workspace_tags[0].color_role,
    WorkspaceTagColorRole::Green
  );

  let empty = repo
    .search_docs(SearchPageRequest {
      query: "   ".to_string(),
      language: Some("de-DE".to_string()),
      sort_by: SearchSortBy::Relevance,
      sort_direction: SortDirection::Desc,
      workspace_id: workspace_a,
      page: PageRequest { limit: 10, offset: 0 },
    })
    .await
    .expect("empty query should not fail");
  assert!(empty.is_empty());

  // Scoped cleanup — only remove data this test created
  for &doc_id in &[doc_a1, doc_a2, doc_b1] {
    sqlx::query("DELETE FROM search_content WHERE doc_id = $1")
      .bind(doc_id)
      .execute(&pool)
      .await
      .ok();
    sqlx::query("DELETE FROM docs WHERE id = $1")
      .bind(doc_id)
      .execute(&pool)
      .await
      .ok();
  }
  for &(ws, u) in &[(workspace_a, user_a), (workspace_b, user_b)] {
    sqlx::query("DELETE FROM workspaces WHERE id = $1")
      .bind(ws)
      .execute(&pool)
      .await
      .ok();
    sqlx::query("DELETE FROM users WHERE id = $1")
      .bind(u)
      .execute(&pool)
      .await
      .ok();
  }
}

#[tokio::test]
async fn hybrid_search_fuses_fts_only_embedding_only_and_combined_results() {
  let pool = setup_pool().await;
  let repo = SqlxSearchRepository::new(pool.clone());
  let (workspace_id, user_id) = seed_workspace(&pool).await;
  let fts_only = seed_doc(&pool, workspace_id, user_id, "Orchid handbook").await;
  let embedding_only = seed_doc(&pool, workspace_id, user_id, "Vector handbook").await;
  let combined = seed_doc(&pool, workspace_id, user_id, "Orchid vector handbook").await;
  let legacy = seed_doc(&pool, workspace_id, user_id, "Legacy vector source").await;
  let system = seed_doc(&pool, workspace_id, user_id, "Reserved source").await;
  sqlx::query("UPDATE docs SET external_id='userdata$hybrid-fixture' WHERE id=$1")
    .bind(system)
    .execute(&pool)
    .await
    .expect("mark reserved CRDT document");

  for (doc_id, title, body) in [
    (fts_only, "Orchid handbook", "orchid lexical signal"),
    (embedding_only, "Vector handbook", "semantic-only body"),
    (combined, "Orchid vector handbook", "orchid combined signal"),
  ] {
    repo
      .upsert_search_doc(&SearchDocument {
        workspace_id,
        doc_id,
        title: title.to_string(),
        plain_text: body.to_string(),
        workspace_tags: Vec::new(),
        search_vector: None,
        updated_at: Utc::now(),
      })
      .await
      .expect("upsert hybrid search content");
  }

  let query_embedding = {
    let mut values = vec![0.0_f32; 768];
    values[0] = 1.0;
    values
  };
  let vector_literal = format!(
    "[{}]",
    query_embedding.iter().map(f32::to_string).collect::<Vec<_>>().join(",")
  );
  for (doc_id, chunk_index, chunk_text) in [
    (embedding_only, 0, "embedding-only chunk"),
    (embedding_only, 1, "second chunk of the same document"),
    (combined, 0, "combined chunk"),
    (system, 0, "reserved CRDT state"),
  ] {
    sqlx::query(
      "INSERT INTO copilot_embeddings
          (workspace_id, source_type, source_id, chunk_index, chunk_text, embedding, model)
        VALUES ($1, 'doc', $2, $5, $3, $4::vector, 'fixture-search-model')",
    )
    .bind(workspace_id)
    .bind(doc_id.to_string())
    .bind(chunk_text)
    .bind(&vector_literal)
    .bind(chunk_index)
    .execute(&pool)
    .await
    .expect("seed hybrid embedding");
  }

  for (model, dimensions) in [("fixture-search-model", 1536), ("legacy-search-model", 768)] {
    let values = format!("[{}]", vec!["0.1"; dimensions].join(","));
    sqlx::query("INSERT INTO copilot_embeddings(workspace_id,source_type,source_id,chunk_index,chunk_text,embedding,model) VALUES($1,'doc',$2,0,'legacy vector',$3::vector,$4)")
      .bind(workspace_id).bind(legacy.to_string()).bind(values).bind(model).execute(&pool).await.expect("seed retained legacy vectors");
  }
  let results = hybrid_search(
    &pool,
    workspace_id,
    "orchid",
    &query_embedding,
    "fixture-search-model",
    10,
  )
  .await
  .expect("hybrid search");
  let fts_only_id = fts_only.to_string();
  let embedding_only_id = embedding_only.to_string();
  let combined_id = combined.to_string();
  let ids: Vec<&str> = results.iter().map(|result| result.doc_id.as_str()).collect();
  assert!(
    !ids.contains(&legacy.to_string().as_str()),
    "hybrid vectors must match the query model and dimension"
  );
  assert_eq!(
    ids.len(),
    3,
    "one result per ordinary document; no reserved sources: {ids:?}"
  );
  assert_eq!(ids.first().copied(), Some(combined_id.as_str()));
  assert!(ids.contains(&fts_only_id.as_str()), "missing FTS-only result: {ids:?}");
  assert!(
    ids.contains(&embedding_only_id.as_str()),
    "missing embedding-only result: {ids:?}"
  );
  let combined_result = results
    .iter()
    .find(|result| result.doc_id == combined_id)
    .expect("combined result");
  let fts_result = results
    .iter()
    .find(|result| result.doc_id == fts_only_id)
    .expect("FTS-only result");
  let embedding_result = results
    .iter()
    .find(|result| result.doc_id == embedding_only_id)
    .expect("embedding-only result");
  assert!(combined_result.rrf_score > fts_result.rrf_score);
  assert!(combined_result.rrf_score > embedding_result.rrf_score);
  assert_eq!(embedding_result.chunk_text.as_deref(), Some("embedding-only chunk"));
  assert_eq!(embedding_result.title.as_deref(), Some("Vector handbook"));
  assert_eq!(fts_result.title.as_deref(), Some("Orchid handbook"));

  sqlx::query("DELETE FROM copilot_embeddings WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("clean hybrid embeddings");
  sqlx::query("DELETE FROM search_content WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("clean hybrid search content");
  sqlx::query("DELETE FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("clean hybrid documents");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(&pool)
    .await
    .expect("clean hybrid workspace");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("clean hybrid user");
}
