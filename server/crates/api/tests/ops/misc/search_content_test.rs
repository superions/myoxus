//! Integration invariants for canonical document search content.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{Duration, Utc};
use uuid::Uuid;

use myoxus_application::auth::AuthResult;
use myoxus_application::doc::DocService;
use myoxus_application::search::{SearchIndexJobPayload, SearchIndexerService};
use myoxus_application::worker::WorkQueuePort;
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::search::SqlxSearchRepository;

use crate::helpers;

struct NullQueue;

#[async_trait]
impl WorkQueuePort for NullQueue {
  async fn add_job(
    &self,
    _queue: &str,
    _job_name: &str,
    _data: serde_json::Value,
    _max_attempts: Option<u32>,
    _delay_ms: Option<i64>,
  ) -> AuthResult<String> {
    Ok(Uuid::new_v4().to_string())
  }
}

async fn seed_document(pool: &sqlx::PgPool, prefix: &str) -> (Uuid, Uuid, Uuid) {
  let user_id = Uuid::new_v4();
  let workspace_id = Uuid::new_v4();
  let doc_id = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name, status) VALUES ($1, $2, $3, 'active')")
    .bind(user_id)
    .bind(format!("{prefix}-{user_id}@example.test"))
    .bind(format!("{prefix} user"))
    .execute(pool)
    .await
    .expect("seed search-content user");
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name) VALUES ($1, $2, $3)")
    .bind(workspace_id)
    .bind(user_id)
    .bind(format!("{prefix} workspace"))
    .execute(pool)
    .await
    .expect("seed search-content workspace");
  sqlx::query(
    "INSERT INTO docs
       (id, workspace_id, external_id, title, is_workspace_root, created_by, updated_by)
     VALUES ($1, $2, $3, $4, false, $5, $5)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(format!("external-{doc_id}"))
  .bind(format!("{prefix} title"))
  .bind(user_id)
  .execute(pool)
  .await
  .expect("seed search-content document");
  (user_id, workspace_id, doc_id)
}

async fn cleanup_document(pool: &sqlx::PgPool, user_id: Uuid, workspace_id: Uuid) {
  sqlx::query("DELETE FROM search_reindex_runs WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean search reindex runs");
  sqlx::query("DELETE FROM search_content WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean search content");
  sqlx::query("DELETE FROM doc_updates WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean document updates");
  sqlx::query("DELETE FROM docs WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean documents");
  sqlx::query("DELETE FROM workspaces WHERE id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean workspace");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(pool)
    .await
    .expect("clean user");
}

fn indexer(pool: &sqlx::PgPool) -> SearchIndexerService {
  SearchIndexerService::new(
    Arc::new(NullQueue),
    Arc::new(SqlxSearchRepository::new(pool.clone())),
    Arc::new(DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))),
  )
}

/// Snapshot and delta jobs must update the single canonical row and rebuild
/// its persisted `simple` search vector.
#[tokio::test]
async fn inv_search_content_snapshot_delta_and_delete_lifecycle() {
  let pool = helpers::setup_pool().await;
  let (user_id, workspace_id, doc_id) = seed_document(&pool, "search-lifecycle").await;
  let indexer = indexer(&pool);

  indexer
    .process_payload(SearchIndexJobPayload::Snapshot {
      workspace_id,
      doc_id,
      title: "Quartz launch".to_string(),
      plain_text: "initial meadow".to_string(),
    })
    .await
    .expect("snapshot indexing must succeed");
  let snapshot: (String, String, bool) = sqlx::query_as(
    "SELECT title, plain_text,
            search_vector @@ plainto_tsquery('simple', 'quartz meadow')
       FROM search_content
      WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("read snapshot search content");
  assert_eq!(
    snapshot,
    ("Quartz launch".to_string(), "initial meadow".to_string(), true)
  );

  indexer
    .process_payload(SearchIndexJobPayload::Delta {
      workspace_id,
      doc_id,
      title: Some("Amber launch".to_string()),
      append_plain_text: Some(" lantern".to_string()),
      replace_plain_text: None,
    })
    .await
    .expect("append delta indexing must succeed");
  let appended: (String, String, bool) = sqlx::query_as(
    "SELECT title, plain_text,
            search_vector @@ plainto_tsquery('simple', 'amber lantern')
       FROM search_content
      WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("read appended search content");
  assert_eq!(
    appended,
    ("Amber launch".to_string(), "initial meadow lantern".to_string(), true)
  );

  indexer
    .process_payload(SearchIndexJobPayload::Delta {
      workspace_id,
      doc_id,
      title: None,
      append_plain_text: Some(" ignored append".to_string()),
      replace_plain_text: Some("replacement cobalt".to_string()),
    })
    .await
    .expect("replacement delta indexing must succeed");
  let replaced: (String, bool, bool) = sqlx::query_as(
    "SELECT plain_text,
            search_vector @@ plainto_tsquery('simple', 'cobalt'),
            search_vector @@ plainto_tsquery('simple', 'meadow')
       FROM search_content
      WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("read replaced search content");
  assert_eq!(replaced, ("replacement cobalt".to_string(), true, false));

  indexer
    .process_payload(SearchIndexJobPayload::DeleteDoc { workspace_id, doc_id })
    .await
    .expect("document search delete must succeed");
  let remains: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM search_content WHERE workspace_id = $1 AND doc_id = $2")
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .expect("count deleted search content");
  assert_eq!(remains, 0);

  cleanup_document(&pool, user_id, workspace_id).await;
}

/// The list-snippet owner performs one bounded search projection read and
/// keeps asynchronous absence distinct from authoritative empty content.
#[tokio::test]
async fn inv_document_snippet_batch_is_bounded_and_normalized() {
  let pool = helpers::setup_pool().await;
  let (user_id, workspace_id, doc_id) = seed_document(&pool, "snippet-batch").await;
  let indexer = indexer(&pool);

  indexer
    .process_payload(SearchIndexJobPayload::Snapshot {
      workspace_id,
      doc_id,
      title: "  Quartz\n\tlaunch  ".to_string(),
      plain_text: " meadow   lantern ".to_string(),
    })
    .await
    .expect("seed snippet search projection");

  let snippets = indexer
    .read_document_snippets(workspace_id, &[doc_id, doc_id])
    .await
    .expect("read unique snippet batch");
  assert_eq!(snippets.len(), 1, "duplicate IDs must share one projection");
  assert_eq!(snippets[0].doc_id, doc_id);
  assert_eq!(snippets[0].text.as_deref(), Some("meadow lantern"));

  let oversized = (0..101).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
  assert!(
    indexer.read_document_snippets(workspace_id, &oversized).await.is_err(),
    "more than 100 unique IDs must fail before repository access"
  );

  cleanup_document(&pool, user_id, workspace_id).await;
}

/// A deferred snapshot reloads merged Yjs state and replaces stale relational
/// content rather than merely refreshing document metadata.
#[tokio::test]
async fn inv_deferred_snapshot_extracts_current_yjs_body() {
  let pool = helpers::setup_pool().await;
  let (user_id, workspace_id, doc_id) = seed_document(&pool, "deferred-search").await;

  let mut builder = yjs::YjsDocumentBuilder::new("Deferred snapshot title");
  builder.push_paragraph(&[yjs::YjsTextSegment::plain(
    "cobalt meadow lantern appears only in the current document body",
  )]);
  sqlx::query("INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence) VALUES ($1, $2, $3, 1)")
    .bind(doc_id)
    .bind(workspace_id)
    .bind(builder.encode())
    .execute(&pool)
    .await
    .expect("seed deferred-search Yjs update");

  indexer(&pool)
    .process_payload(SearchIndexJobPayload::DeferredSnapshot { workspace_id, doc_id })
    .await
    .expect("deferred snapshot indexing must succeed");
  let indexed: (String, String, bool) = sqlx::query_as(
    "SELECT title, plain_text,
            search_vector @@ plainto_tsquery('simple', 'cobalt lantern')
       FROM search_content WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("deferred snapshot must create canonical search content");
  assert_eq!(indexed.0, "Deferred snapshot title");
  assert!(
    indexed.1.contains("cobalt meadow lantern"),
    "indexed body: {}",
    indexed.1
  );
  assert!(indexed.2);

  cleanup_document(&pool, user_id, workspace_id).await;
}

/// Incremental reindex must use the paired current Yjs materialization, even
/// when only the ordered update tail is newer than its cursor. A successful
/// projection replaces both stale summary stores atomically.
#[tokio::test]
async fn inv_reindex_projects_update_only_yjs_into_search_and_metadata() {
  let pool = helpers::setup_pool().await;
  let (user_id, workspace_id, doc_id) = seed_document(&pool, "reindex-current-yjs").await;
  let old_time = Utc::now() - Duration::hours(2);
  let cursor = Utc::now() - Duration::minutes(5);

  let mut builder = yjs::YjsDocumentBuilder::new("Current projected title");
  builder.push_paragraph(&[yjs::YjsTextSegment::plain("snapshot amber body")]);
  let snapshot = builder.encode_state();
  let snapshot_vector = builder.state_vector();
  builder.push_paragraph(&[yjs::YjsTextSegment::plain("update-only cobalt tail")]);
  let tail = builder.encode_diff(&snapshot_vector);

  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
     VALUES ($1, $2, $3, 1, $4)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(snapshot)
  .bind(old_time)
  .execute(&pool)
  .await
  .expect("seed old compacted snapshot");
  sqlx::query(
    "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence, server_timestamp)
     VALUES ($1, $2, $3, 2, now())",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(tail)
  .execute(&pool)
  .await
  .expect("seed update-only current content");
  sqlx::query(
    "UPDATE docs
        SET title = 'stale relational title',
            meta = jsonb_build_object('plain_text', 'stale metadata body'),
            updated_at = $3
      WHERE workspace_id = $1 AND id = $2",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(old_time)
  .execute(&pool)
  .await
  .expect("seed stale relational projection");
  sqlx::query(
    "INSERT INTO search_content (workspace_id, doc_id, title, plain_text, updated_at)
     VALUES ($1, $2, 'stale search title', 'stale search body', $3)",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(old_time)
  .execute(&pool)
  .await
  .expect("seed stale search projection");

  let indexer = indexer(&pool);
  let run_id = indexer
    .start_incremental_reindex(Some(workspace_id), cursor, 10)
    .await
    .expect("start incremental reindex");
  indexer
    .process_payload(SearchIndexJobPayload::Reindex { run_id, batch_size: 10 })
    .await
    .expect("process current Yjs reindex");

  let projected: (String, String, String) = sqlx::query_as(
    "SELECT search.title, search.plain_text, docs.meta->>'plain_text'
       FROM search_content search
       JOIN docs ON docs.workspace_id = search.workspace_id AND docs.id = search.doc_id
      WHERE search.workspace_id = $1 AND search.doc_id = $2",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .fetch_one(&pool)
  .await
  .expect("read converged summary projections");
  assert_eq!(projected.0, "Current projected title");
  assert!(projected.1.contains("snapshot amber body"), "body: {}", projected.1);
  assert!(projected.1.contains("update-only cobalt tail"), "body: {}", projected.1);
  assert!(!projected.1.contains("stale"), "body: {}", projected.1);
  assert_eq!(projected.2, projected.1);

  cleanup_document(&pool, user_id, workspace_id).await;
}

/// Workspace deletion is scoped: it removes every canonical row in the target
/// workspace without touching another workspace.
#[tokio::test]
async fn inv_search_content_workspace_delete_is_scoped() {
  let pool = helpers::setup_pool().await;
  let (user_a, workspace_a, doc_a) = seed_document(&pool, "search-delete-a").await;
  let (user_b, workspace_b, doc_b) = seed_document(&pool, "search-delete-b").await;
  let indexer = indexer(&pool);
  for (workspace_id, doc_id, title) in [
    (workspace_a, doc_a, "workspace alpha"),
    (workspace_b, doc_b, "workspace beta"),
  ] {
    indexer
      .process_payload(SearchIndexJobPayload::Snapshot {
        workspace_id,
        doc_id,
        title: title.to_string(),
        plain_text: "search body".to_string(),
      })
      .await
      .expect("seed canonical search content");
  }

  indexer
    .process_payload(SearchIndexJobPayload::DeleteWorkspace {
      workspace_id: workspace_a,
    })
    .await
    .expect("workspace search delete must succeed");
  let counts: (i64, i64) = sqlx::query_as(
    "SELECT
       COUNT(*) FILTER (WHERE workspace_id = $1),
       COUNT(*) FILTER (WHERE workspace_id = $2)
     FROM search_content
     WHERE workspace_id IN ($1, $2)",
  )
  .bind(workspace_a)
  .bind(workspace_b)
  .fetch_one(&pool)
  .await
  .expect("count workspace-scoped search content");
  assert_eq!(counts, (0, 1));

  cleanup_document(&pool, user_a, workspace_a).await;
  cleanup_document(&pool, user_b, workspace_b).await;
}

/// Search publication is durable even when Redis accepts a job but its reply
/// is lost. Technical and stale-owner events never project ordinary content.
#[tokio::test]
async fn inv_native_document_search_outbox_retries_without_opening_a_page() {
  use futures_util::FutureExt;
  use myoxus_application::auth::AuthError;
  use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
  };

  #[derive(Default)]
  struct Queue {
    lose_reply: AtomicBool,
    payloads: Mutex<Vec<serde_json::Value>>,
  }
  #[async_trait]
  impl WorkQueuePort for Queue {
    async fn add_job(
      &self,
      queue: &str,
      job: &str,
      data: serde_json::Value,
      _: Option<u32>,
      _: Option<i64>,
    ) -> AuthResult<String> {
      assert_eq!((queue, job), ("indexer", "indexer.indexDoc"));
      self.payloads.lock().unwrap().push(data);
      if self.lose_reply.swap(false, Ordering::SeqCst) {
        return Err(AuthError::Storage("injected lost enqueue reply".into()));
      }
      Ok(Uuid::new_v4().to_string())
    }
  }
  let pool = helpers::setup_pool().await;
  let (user, workspace, doc) = seed_document(&pool, "native-search-outbox").await;
  let queue = Arc::new(Queue::default());
  let repository = myoxus_infrastructure::outbox::SqlxOutboxRepository::new(pool.clone());
  let indexer = SearchIndexerService::new(
    queue.clone(),
    Arc::new(SqlxSearchRepository::new(pool.clone())),
    Arc::new(DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))),
  );
  let mut events = Vec::new();
  let result = std::panic::AssertUnwindSafe(async {
    let mut builder = yjs::YjsDocumentBuilder::new("Unopened native working copy");
    builder.push_paragraph(&[yjs::YjsTextSegment::plain("durable cobalt body before any editor opens")]);
    sqlx::query("INSERT INTO doc_updates(doc_id,workspace_id,payload,sequence) VALUES($1,$2,$3,1)")
      .bind(doc).bind(workspace).bind(builder.encode()).execute(&pool).await.unwrap();
    let event = Uuid::new_v4();
    events.push(event);
    sqlx::query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'doc',$2,'doc_updated',$3)")
      .bind(event).bind(doc.to_string()).bind(serde_json::json!({"docId":doc,"workspaceId":workspace})).execute(&pool).await.unwrap();
    queue.lose_reply.store(true, Ordering::SeqCst);
    assert!(repository.process_document_search_update(event, &indexer).await.is_err());
    let pending: bool = sqlx::query_scalar("SELECT processed_at IS NULL FROM outbox_events WHERE id=$1")
      .bind(event).fetch_one(&pool).await.unwrap();
    assert!(pending, "an uncertain enqueue must retain durable search intent");
    repository.process_document_search_update(event, &indexer).await.unwrap();
    repository.process_document_search_update(event, &indexer).await.unwrap();
    let payloads = queue.payloads.lock().unwrap().clone();
    assert_eq!(payloads.len(),2, "acknowledged events cannot enqueue again");
    for payload in payloads {
      assert_eq!(payload,serde_json::json!({"workspaceId":workspace.to_string(),"docId":doc.to_string(),"kind":"deferred"}));
      indexer.process_payload(SearchIndexJobPayload::DeferredSnapshot{workspace_id:workspace,doc_id:doc}).await.unwrap();
    }
    let indexed: (i64,bool) = sqlx::query_as("SELECT COUNT(*),bool_and(search_vector @@ plainto_tsquery('simple','durable cobalt')) FROM search_content WHERE workspace_id=$1 AND doc_id=$2")
      .bind(workspace).bind(doc).fetch_one(&pool).await.unwrap();
    assert_eq!(indexed,(1,true), "replay must index one complete unopened working copy");
    for key in [format!("db${workspace}$folders"),format!("userdata${user}"),format!("external-{doc}")] {
      sqlx::query("UPDATE docs SET external_id=$2 WHERE id=$1").bind(doc).bind(&key).execute(&pool).await.unwrap();
      let event = Uuid::new_v4(); events.push(event);
      // Last case is a stale event naming a different workspace, not a new
      // authority to index the document's current owner's content.
      let event_workspace = if key.starts_with("external-") {Uuid::new_v4()} else {workspace};
      sqlx::query("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'doc',$2,'doc_updated',$3)")
        .bind(event).bind(doc.to_string()).bind(serde_json::json!({"docId":doc,"workspaceId":event_workspace})).execute(&pool).await.unwrap();
      repository.process_document_search_update(event, &indexer).await.unwrap();
      let processed: bool = sqlx::query_scalar("SELECT processed_at IS NOT NULL FROM outbox_events WHERE id=$1")
        .bind(event).fetch_one(&pool).await.unwrap();
      assert!(processed);
      assert_eq!(queue.payloads.lock().unwrap().len(),2,"technical or stale events must not enqueue");
    }
  }).catch_unwind().await;
  sqlx::query("DELETE FROM outbox_events WHERE id=ANY($1)")
    .bind(&events)
    .execute(&pool)
    .await
    .expect("clean owned search events");
  cleanup_document(&pool, user, workspace).await;
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}
