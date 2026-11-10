//! Search indexing and bounded query continuation.
//!
//! Documents are indexed asynchronously via the Redis job queue.  The
//! [`SearchIndexerService`] enqueues jobs into the `"indexer"` queue using
//! BullMQ-compatible job names.  Processing is handled by `IndexerQueueHandler`
//! in the API crate via the `JobHandler` trait.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tracing::{debug, info, instrument};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};
use crate::doc::{DocService, project_yjs_plain_text};
use crate::worker::WorkQueuePort;
use myoxus_domain::entities::SearchDocument;
use myoxus_domain::workspace_tags::WorkspaceTagSearchProjection;

/// Optional, current native facts for one already authorized search hit.
/// Index-derived summaries carry their own clock; none of these facts imply verification.
#[derive(Debug, Default, Serialize)]
pub struct SearchKnowledgeMetadata {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub okf_type: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description_source: Option<&'static str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub description_index_updated_at: Option<DateTime<Utc>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tags: Option<Vec<crate::document_metadata::okf::OkfTag>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub document_updated_at: Option<DateTime<Utc>>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub metadata_updated_at: Option<DateTime<Utc>>,
  pub enrichment_diagnostics: Vec<&'static str>,
}

/// Enrich only the returned live page, without materializing Yjs or source documents.
/// The caller owns current ACL/live filtering and supplies matching external keys.
/// One fresh document batch and one tag assignment/catalog batch serve at most 50 hits;
/// metadata projections run sequentially (concurrency one) through their existing cache owner.
#[instrument(skip_all, fields(%workspace_id, count = hits.len()))]
pub async fn enrich_search_page(
  actor: Uuid,
  workspace_id: Uuid,
  hits: &[(SearchDocument, String)],
  docs: &DocService,
  metadata: &dyn crate::mcp::McpDocumentOperations,
  tags: Option<&crate::workspace_tags::WorkspaceTagService>,
) -> AuthResult<Vec<SearchKnowledgeMetadata>> {
  use myoxus_domain::document_key::DocumentKey;
  use serde_json::{Map, Value};
  use std::collections::{HashMap, HashSet};
  if hits.len() > 50 {
    return Err(AuthError::InvalidInput(
      "search enrichment page exceeds 50 documents".into(),
    ));
  }
  let ids = hits.iter().map(|(hit, _)| hit.doc_id).collect::<Vec<_>>();
  let fresh = docs.get_metadata_batch(&ids).await;
  let keys = hits
    .iter()
    .map(|(_, key)| DocumentKey::parse(key.clone()))
    .collect::<Result<Vec<_>, _>>()
    .map_err(|_| AuthError::InvalidInput("invalid search document identity".into()))?;
  let assignments = if let Some(service) = tags {
    service.document_assignments(actor, workspace_id, &keys).await.ok()
  } else {
    None
  };
  let mut canonical = None;
  if let (Some(service), Some(assignments)) = (tags, assignments.as_ref()) {
    let mut seen = HashSet::new();
    let tag_ids = assignments
      .iter()
      .flat_map(|entry| &entry.tag_ids)
      .copied()
      .filter(|id| seen.insert(*id))
      .collect::<Vec<_>>();
    canonical = service
      .resolve_tags(actor, workspace_id, &tag_ids)
      .await
      .ok()
      .map(|tags| {
        tags
          .into_iter()
          .map(|tag| (tag.id, tag.name))
          .collect::<HashMap<_, _>>()
      });
  }
  let assignments = assignments.map(|entries| {
    entries
      .into_iter()
      .map(|entry| (entry.doc_id, entry.tag_ids))
      .collect::<HashMap<_, _>>()
  });
  let mut output = Vec::with_capacity(hits.len());
  for (hit, _) in hits {
    let mut value = SearchKnowledgeMetadata::default();
    let current = fresh
      .as_ref()
      .ok()
      .and_then(|rows| rows.get(&hit.doc_id))
      .filter(|doc| doc.workspace_id == Some(workspace_id) && !doc.blocked && doc.deleted_at.is_none());
    let empty = Map::new();
    let properties = current
      .and_then(|doc| doc.meta.pointer("/obsidian/properties"))
      .and_then(Value::as_object)
      .unwrap_or(&empty);
    if let Some(doc) = current {
      value.document_updated_at = Some(doc.updated_at);
    } else {
      value.enrichment_diagnostics.push("document_facts_unavailable");
    }
    // A failed native projection is unknown, not an invented default type.
    match metadata.projection(hit.doc_id, workspace_id).await {
      Ok(projection) => {
        if current.is_some() {
          value.okf_type = Some(crate::document_metadata::okf::projected_type(&projection, properties));
        }
        value.metadata_updated_at = projection.metadata_updated_at;
      }
      Err(_) => value.enrichment_diagnostics.push("native_metadata_unavailable"),
    }
    value.description = properties
      .get("description")
      .and_then(Value::as_str)
      .filter(|text| !text.trim().is_empty())
      .map(str::to_owned);
    if value.description.is_some() {
      value.description_source = Some("imported_declaration");
    } else {
      value.description = myoxus_public_render::seo::knowledge_excerpt(&hit.plain_text, &hit.title);
      if value.description.is_some() {
        value.description_source = Some("indexed_content");
        value.description_index_updated_at = Some(hit.updated_at);
        value.enrichment_diagnostics.push("description_derived_from_index");
      }
    }
    if let Some(tag_ids) = assignments.as_ref().and_then(|entries| entries.get(&hit.doc_id)) {
      if let Some(canonical) = canonical.as_ref() {
        value.tags = tag_ids
          .iter()
          .map(|id| {
            canonical.get(id).map(|label| crate::document_metadata::okf::OkfTag {
              id: *id,
              label: label.clone(),
            })
          })
          .collect();
      }
    }
    if value.tags.is_none() {
      value.enrichment_diagnostics.push("canonical_tags_unavailable");
    }
    output.push(value);
  }
  Ok(output)
}

/// Maximum index candidates inspected by one document-search request.
pub const SEARCH_CANDIDATE_BUDGET: i64 = 4_000;
pub const SEARCH_CANDIDATE_BATCH: i64 = 200;

/// Query-bound continuation over the existing repository's deterministic order.
/// Positions count consumed index candidates, including denied and stale rows.
/// Authorization remains with the consuming boundary and must run on every page.
/// This is not a snapshot: duplicate-free traversal requires an unchanged index.
pub struct SearchContinuation<'a> {
  user_id: Uuid,
  workspace_id: Uuid,
  query: &'a str,
  language: Option<&'a str>,
  key: &'a [u8],
}

impl<'a> SearchContinuation<'a> {
  pub fn new(user_id: Uuid, workspace_id: Uuid, query: &'a str, language: Option<&'a str>, key: &'a [u8]) -> Self {
    Self {
      user_id,
      workspace_id,
      query,
      language,
      key,
    }
  }

  /// Resolve only signed positions in this exact user/workspace/query/language context.
  pub fn position(&self, cursor: Option<&str>) -> Result<i64, &'static str> {
    use base64::Engine;
    let Some(cursor) = cursor else {
      return Ok(0);
    };
    let invalid = "MIX_MCP_SEARCH_CURSOR_INVALID: search cursor is invalid";
    if cursor.len() > 256 {
      return Err(invalid);
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
      .decode(cursor)
      .map_err(|_| invalid)?;
    if bytes.len() != 40 {
      return Err(invalid);
    }
    let position = i64::from_be_bytes(bytes[..8].try_into().map_err(|_| invalid)?);
    if !(0..=i64::MAX - SEARCH_CANDIDATE_BUDGET).contains(&position) {
      return Err(invalid);
    }
    use hmac::Mac;
    self.mac(position).verify_slice(&bytes[8..]).map_err(|_| invalid)?;
    Ok(position)
  }

  pub fn cursor(&self, position: i64) -> String {
    use base64::Engine;
    use hmac::Mac;
    let mut bytes = position.to_be_bytes().to_vec();
    bytes.extend_from_slice(&self.mac(position).finalize().into_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
  }

  fn mac(&self, position: i64) -> hmac::Hmac<sha2::Sha256> {
    use hmac::Mac;
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(self.key).expect("HMAC accepts arbitrary key lengths");
    mac.update(b"myoxus.search-continuation.1");
    mac.update(self.user_id.as_bytes());
    mac.update(self.workspace_id.as_bytes());
    mac.update(&position.to_be_bytes());
    // Length framing preserves the distinction between absent and empty language.
    mac.update(&serde_json::to_vec(&(self.query, self.language)).expect("query tuple is serializable"));
    mac
  }

  /// Read at most one existing repository batch, preserving its ranking and ID tie-breaker.
  pub async fn candidates(
    &self,
    repository: &dyn myoxus_domain::repositories::SearchRepository,
    position: i64,
  ) -> myoxus_domain::repositories::RepoResult<Vec<SearchDocument>> {
    use myoxus_domain::repositories::{PageRequest, SearchPageRequest, SearchSortBy, SortDirection};
    repository
      .search_docs(SearchPageRequest {
        query: self.query.to_string(),
        language: self.language.map(str::to_string),
        workspace_id: self.workspace_id,
        sort_by: SearchSortBy::Relevance,
        sort_direction: SortDirection::Desc,
        page: PageRequest {
          limit: SEARCH_CANDIDATE_BATCH,
          offset: position,
        },
      })
      .await
  }
}

/// Job payload for Redis-based search indexing jobs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SearchIndexJobPayload {
  /// Replace the entire search index entry for a document with a fresh
  /// snapshot of its title and full plain-text content.
  Snapshot {
    workspace_id: Uuid,
    doc_id: Uuid,
    title: String,
    plain_text: String,
  },
  /// Apply an incremental update to the existing search index entry.
  /// `append_plain_text` appends to the existing body;
  /// `replace_plain_text` replaces it entirely.
  Delta {
    workspace_id: Uuid,
    doc_id: Uuid,
    title: Option<String>,
    append_plain_text: Option<String>,
    replace_plain_text: Option<String>,
  },
  /// Deferred snapshot: load and extract the current merged Yjs document.
  /// Enqueued after a live doc update with a short delay so that rapid
  /// keystrokes collapse into a single index job per document.
  DeferredSnapshot { workspace_id: Uuid, doc_id: Uuid },
  /// Delete a single document from the search index.
  DeleteDoc { workspace_id: Uuid, doc_id: Uuid },
  /// Delete all search index entries for a workspace.
  DeleteWorkspace { workspace_id: Uuid },
  /// Fan-out: list all documents in a workspace and enqueue individual
  /// `indexer.indexDoc` (deferred snapshot) jobs for each one.
  IndexWorkspace { workspace_id: Uuid },
  /// Process one batch of a reindex run identified by `run_id`.
  Reindex { run_id: Uuid, batch_size: i64 },
}

/// Whether a reindex run processes all documents or only recently changed ones.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SearchReindexMode {
  /// Reindex every document in the workspace(s).
  Full,
  /// Reindex only documents modified after a given timestamp.
  Incremental,
}

/// Current state of a reindex run.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SearchReindexStatus {
  /// The run is actively progressing (batches may still be enqueued).
  Running,
  /// All batches processed successfully.
  Completed,
  /// The run encountered a non-retryable error.
  Failed,
}

/// Tracks the progress of a multi-batch search reindex operation.
#[derive(Debug, Clone)]
pub struct SearchReindexRun {
  /// Primary key.
  pub id: Uuid,
  /// If set, only documents in this workspace are reindexed.
  pub workspace_id: Option<Uuid>,
  /// Full or incremental mode.
  pub mode: SearchReindexMode,
  /// Current lifecycle state.
  pub status: SearchReindexStatus,
  /// Cursor `updated_at` value from the last successfully processed document.
  pub cursor_updated_at: Option<DateTime<Utc>>,
  /// Cursor `doc_id` from the last successfully processed document.
  pub cursor_doc_id: Option<Uuid>,
  /// Total documents examined so far.
  pub processed_count: i64,
  /// Total documents written to the index so far.
  pub indexed_count: i64,
  /// When the run was created.
  pub started_at: DateTime<Utc>,
  /// When the run record was last updated.
  pub updated_at: DateTime<Utc>,
  /// Set when the run reaches a terminal state.
  pub finished_at: Option<DateTime<Utc>>,
  /// Error detail on failure.
  pub error_message: Option<String>,
}

/// A document row fetched from the primary store for reindexing.
#[derive(Debug, Clone)]
pub struct SearchSourceDoc {
  /// Workspace that owns the document.
  pub workspace_id: Uuid,
  /// Document identifier.
  pub doc_id: Uuid,
  /// Document title extracted from its content.
  pub title: String,
  /// Latest document, snapshot or ordered-update timestamp used by the
  /// incremental keyset cursor.
  pub updated_at: DateTime<Utc>,
}

/// Storage port for the search index and reindex run tracking.
#[async_trait]
pub trait SearchStore: Send + Sync {
  /// Fetch the current search index entry for a document.
  async fn get_search_doc(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<Option<SearchDocument>>;
  /// Fetch indexed projections for one bounded, already-authorized ID set.
  async fn list_search_docs_by_ids(&self, workspace_id: Uuid, doc_ids: &[Uuid]) -> AuthResult<Vec<SearchDocument>>;
  /// Insert or replace the search index entry for a document.
  async fn upsert_search_doc(&self, doc: SearchDocument) -> AuthResult<()>;
  /// Publish a complete native projection and its derived field-dependency bit
  /// atomically. Only current native extraction can clear that bit; plain-text
  /// jobs cannot assert that a live document no longer contains native fields.
  /// The paired snapshot/tail revision makes field-free suppression safe even
  /// when a first/new field races a metadata invalidation and an index write.
  async fn upsert_current_search_doc(
    &self,
    doc: SearchDocument,
    has_fields: bool,
    source_revision: i64,
  ) -> AuthResult<()>;
  /// Resolve canonical document tags for the search payload, including
  /// archived references that must remain discoverable.
  async fn list_document_workspace_tags(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<Vec<WorkspaceTagSearchProjection>>;
  /// Remove the search index entry for a document.
  async fn delete_search_doc(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<()>;
  /// Remove all search index entries for a workspace.  Returns the number of
  /// deleted rows.
  async fn delete_search_docs_by_workspace(&self, workspace_id: Uuid) -> AuthResult<i64>;
  /// Create a new reindex run record in the `Running` state.
  async fn create_reindex_run(
    &self,
    mode: SearchReindexMode,
    workspace_id: Option<Uuid>,
    cursor_updated_at: Option<DateTime<Utc>>,
  ) -> AuthResult<SearchReindexRun>;
  /// Fetch a reindex run by ID.
  async fn get_reindex_run(&self, run_id: Uuid) -> AuthResult<Option<SearchReindexRun>>;
  /// Advance the reindex cursor and increment the progress counters.
  async fn update_reindex_progress(
    &self,
    run_id: Uuid,
    cursor_updated_at: DateTime<Utc>,
    cursor_doc_id: Uuid,
    processed_inc: i64,
    indexed_inc: i64,
  ) -> AuthResult<()>;
  /// Mark a reindex run as successfully completed.
  async fn complete_reindex_run(&self, run_id: Uuid) -> AuthResult<()>;
  /// Mark a reindex run as failed with an error message.
  async fn fail_reindex_run(&self, run_id: Uuid, error_message: String) -> AuthResult<()>;
  /// Return the next batch of documents for a reindex run using cursor-based
  /// pagination.
  async fn list_docs_for_reindex(
    &self,
    workspace_id: Option<Uuid>,
    cursor_updated_at: Option<DateTime<Utc>>,
    cursor_doc_id: Option<Uuid>,
    limit: i64,
  ) -> AuthResult<Vec<SearchSourceDoc>>;
}

/// Service that enqueues and processes search index jobs.
///
/// All indexer jobs are enqueued to the `"indexer"` Redis queue using
/// BullMQ-compatible job names (`"indexer.indexDoc"`, `"indexer.autoIndexWorkspaces"`).
/// Processing is handled by `IndexerQueueHandler` via the `JobHandler` trait.
#[derive(Clone)]
pub struct SearchIndexerService {
  /// Redis-based queue adapter.
  queue: Arc<dyn WorkQueuePort>,
  store: Arc<dyn SearchStore>,
  doc_service: Arc<DocService>,
  field_source: Option<Arc<dyn crate::document_fields::context::DocumentFieldContextSource>>,
}

/// List-safe text projection with the search index's own freshness marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentSnippet {
  pub doc_id: Uuid,
  pub text: Option<String>,
  pub indexed_at: DateTime<Utc>,
}

const DOCUMENT_SNIPPET_MAX_CHARS: usize = 260;
const DOCUMENT_SNIPPET_BATCH_LIMIT: usize = 100;

pub fn normalize_document_snippet(raw: &str) -> Option<String> {
  let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
  if normalized.is_empty() {
    return None;
  }
  if normalized.chars().count() <= DOCUMENT_SNIPPET_MAX_CHARS {
    return Some(normalized);
  }
  let mut truncated = normalized.chars().take(DOCUMENT_SNIPPET_MAX_CHARS).collect::<String>();
  truncated.push_str("...");
  Some(truncated)
}

#[async_trait::async_trait]
impl crate::events::DocumentSearchUpdatePublisher for SearchIndexerService {
  async fn enqueue_search_update(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<()> {
    self
      .enqueue_deferred_snapshot(workspace_id, doc_id, 1)
      .await
      .map(|_| ())
  }
}

impl SearchIndexerService {
  /// Construct a `SearchIndexerService` with the Redis-based queue adapter.
  pub fn new(queue: Arc<dyn WorkQueuePort>, store: Arc<dyn SearchStore>, doc_service: Arc<DocService>) -> Self {
    Self {
      queue,
      store,
      doc_service,
      field_source: None,
    }
  }

  /// Internal indexing is already admitted by its workspace/document owner.
  /// Resolve fields actorlessly with configured defaults, never worker identity
  /// or the last editor's preferences. Field-free indexing needs no capability.
  pub fn with_field_source(
    mut self,
    source: Arc<dyn crate::document_fields::context::DocumentFieldContextSource>,
  ) -> Self {
    self.field_source = Some(source);
    self
  }

  /// Read normalized snippets without loading source documents or scheduling indexing.
  #[instrument(skip(self, doc_ids), fields(workspace_id = %workspace_id, requested = doc_ids.len()))]
  pub async fn read_document_snippets(&self, workspace_id: Uuid, doc_ids: &[Uuid]) -> AuthResult<Vec<DocumentSnippet>> {
    let unique = doc_ids.iter().copied().collect::<std::collections::HashSet<_>>();
    if unique.len() > DOCUMENT_SNIPPET_BATCH_LIMIT {
      return Err(AuthError::InvalidInput(format!(
        "document snippet batch exceeds {DOCUMENT_SNIPPET_BATCH_LIMIT} unique ids"
      )));
    }
    let ids = unique.into_iter().collect::<Vec<_>>();
    let documents = self.store.list_search_docs_by_ids(workspace_id, &ids).await?;
    Ok(
      documents
        .into_iter()
        .map(|document| DocumentSnippet {
          doc_id: document.doc_id,
          text: normalize_document_snippet(&document.plain_text),
          indexed_at: document.updated_at,
        })
        .collect(),
    )
  }

  async fn canonical_document_tags(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<Vec<WorkspaceTagSearchProjection>> {
    self.store.list_document_workspace_tags(workspace_id, doc_id).await
  }

  async fn current_text_projection(&self, source: &SearchSourceDoc) -> AuthResult<(String, String, bool, i64)> {
    let current = self
      .doc_service
      .load
      .load_full_doc_with_revision(source.workspace_id, source.doc_id)
      .await?;
    let fields = yjs::document_field::content::inspect(&current.payload)
      .map_err(|_| crate::document_fields::DocumentFieldError::InvalidField)?
      .into_iter()
      .map(|field| field.run.descriptor)
      .collect::<Vec<_>>();
    let has_fields = !fields.is_empty();
    let snapshot = if !has_fields {
      current.payload
    } else {
      let context = self
        .field_source
        .as_ref()
        .ok_or(crate::document_fields::DocumentFieldError::ContextUnavailable)?
        .resolve_authorized(
          source.workspace_id,
          source.doc_id,
          crate::doc::canonical_yjs_revision(&current.payload)
            .map_err(|_| crate::document_fields::DocumentFieldError::InvalidField)?,
          &fields,
          None,
        )
        .await?;
      crate::document_fields::output::current_snapshot(&current.payload, &context)?
    };
    let projected =
      project_yjs_plain_text(source.workspace_id, source.doc_id, &source.title, &snapshot).map_err(|error| {
        AuthError::Storage(format!(
          "failed to project current search content for document {}: {error}",
          source.doc_id
        ))
      })?;
    Ok((projected.title, projected.plain_text, has_fields, current.revision))
  }

  /// Enqueue a full document snapshot indexing job.  Returns the job ID string.
  #[instrument(skip(self))]
  pub async fn enqueue_snapshot(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    title: String,
    plain_text: String,
  ) -> AuthResult<String> {
    let data = serde_json::json!({
      "workspaceId": workspace_id.to_string(),
      "docId": doc_id.to_string(),
      "kind": "snapshot",
      "title": title,
      "plainText": plain_text,
    });
    let job_id = self
      .queue
      .add_job("indexer", "indexer.indexDoc", data, Some(8), None)
      .await?;
    Ok(job_id)
  }

  /// Enqueue an incremental delta indexing job.  Returns the job ID string.
  #[instrument(skip(self))]
  pub async fn enqueue_delta(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    title: Option<String>,
    append_plain_text: Option<String>,
    replace_plain_text: Option<String>,
  ) -> AuthResult<String> {
    let data = serde_json::json!({
      "workspaceId": workspace_id.to_string(),
      "docId": doc_id.to_string(),
      "kind": "delta",
      "title": title,
      "appendPlainText": append_plain_text,
      "replacePlainText": replace_plain_text,
    });
    let job_id = self
      .queue
      .add_job("indexer", "indexer.indexDoc", data, Some(8), None)
      .await?;
    Ok(job_id)
  }

  /// Enqueue a deferred snapshot job for a single document.
  ///
  /// The job is scheduled `delay_secs` seconds in the future so that rapid
  /// keystrokes collapse into a single search-index update per document.
  /// Call sites are responsible for Redis-based deduplication to avoid
  /// enqueuing multiple pending jobs for the same document.
  #[instrument(skip(self))]
  pub async fn enqueue_deferred_snapshot(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    delay_secs: i64,
  ) -> AuthResult<String> {
    let delay_ms = delay_secs.max(1) * 1000;
    let data = serde_json::json!({
      "workspaceId": workspace_id.to_string(),
      "docId": doc_id.to_string(),
      "kind": "deferred",
    });
    let job_id = self
      .queue
      .add_job("indexer", "indexer.indexDoc", data, Some(3), Some(delay_ms))
      .await?;
    debug!(%workspace_id, %doc_id, delay_secs, %job_id, "enqueued deferred search snapshot");
    Ok(job_id)
  }

  /// Start a full reindex of all documents (optionally scoped to a workspace).
  /// Returns the reindex run ID.
  #[instrument(skip(self))]
  pub async fn start_full_reindex(&self, workspace_id: Option<Uuid>, batch_size: i64) -> AuthResult<Uuid> {
    let run = self
      .store
      .create_reindex_run(SearchReindexMode::Full, workspace_id, None)
      .await?;
    self.enqueue_reindex_job(run.id, batch_size).await?;
    Ok(run.id)
  }

  /// Start an incremental reindex of documents modified since `since`.
  #[instrument(skip(self))]
  pub async fn start_incremental_reindex(
    &self,
    workspace_id: Option<Uuid>,
    since: DateTime<Utc>,
    batch_size: i64,
  ) -> AuthResult<Uuid> {
    let run = self
      .store
      .create_reindex_run(SearchReindexMode::Incremental, workspace_id, Some(since))
      .await?;
    self.enqueue_reindex_job(run.id, batch_size).await?;
    Ok(run.id)
  }

  /// Execute a single already-deserialized `SearchIndexJobPayload`.
  ///
  /// Used by the Redis-based `IndexerQueueHandler` which receives a pre-decoded job.
  /// The caller is responsible for job lifecycle (ACK / NACK) in the Redis queue.
  #[instrument(skip(self, payload))]
  pub async fn process_payload(&self, payload: SearchIndexJobPayload) -> AuthResult<()> {
    match payload {
      SearchIndexJobPayload::Snapshot {
        workspace_id,
        doc_id,
        title,
        plain_text,
      } => {
        let workspace_tags = self.canonical_document_tags(workspace_id, doc_id).await?;
        self
          .store
          .upsert_search_doc(SearchDocument {
            workspace_id,
            doc_id,
            title,
            plain_text,
            workspace_tags,
            search_vector: None,
            updated_at: Utc::now(),
          })
          .await
      }
      SearchIndexJobPayload::Delta {
        workspace_id,
        doc_id,
        title,
        append_plain_text,
        replace_plain_text,
      } => {
        let mut current = self
          .store
          .get_search_doc(workspace_id, doc_id)
          .await?
          .unwrap_or(SearchDocument {
            workspace_id,
            doc_id,
            title: String::new(),
            plain_text: String::new(),
            workspace_tags: Vec::new(),
            search_vector: None,
            updated_at: Utc::now(),
          });
        if let Some(new_title) = title {
          current.title = new_title;
        }
        if let Some(replace) = replace_plain_text {
          current.plain_text = replace;
        } else if let Some(append) = append_plain_text {
          current.plain_text.push_str(&append);
        }
        current.workspace_tags = self.canonical_document_tags(workspace_id, doc_id).await?;
        current.updated_at = Utc::now();
        self.store.upsert_search_doc(current).await
      }
      SearchIndexJobPayload::DeferredSnapshot { workspace_id, doc_id } => {
        match self.doc_service.get_metadata(doc_id).await {
          Ok(Some(meta)) => {
            if meta.workspace_id != Some(workspace_id) {
              return Err(AuthError::InvalidInput(format!(
                "search snapshot workspace mismatch for document {doc_id}"
              )));
            }

            let (title, plain_text, has_fields, source_revision) = self
              .current_text_projection(&SearchSourceDoc {
                workspace_id,
                doc_id,
                title: meta.title,
                updated_at: meta.updated_at,
              })
              .await?;
            let workspace_tags = self.canonical_document_tags(workspace_id, doc_id).await?;

            self
              .store
              .upsert_current_search_doc(
                SearchDocument {
                  workspace_id,
                  doc_id,
                  title,
                  plain_text,
                  workspace_tags,
                  search_vector: None,
                  updated_at: Utc::now(),
                },
                has_fields,
                source_revision,
              )
              .await
          }
          Ok(None) => {
            debug!(%doc_id, "doc metadata not found for deferred snapshot, skipping");
            Ok(())
          }
          Err(e) => Err(e),
        }
      }
      SearchIndexJobPayload::DeleteDoc { workspace_id, doc_id } => {
        self.store.delete_search_doc(workspace_id, doc_id).await?;
        info!(%workspace_id, %doc_id, "deleted document from search content");
        Ok(())
      }
      SearchIndexJobPayload::DeleteWorkspace { workspace_id } => {
        let deleted = self.store.delete_search_docs_by_workspace(workspace_id).await?;
        info!(%workspace_id, deleted, "deleted all search content for workspace");
        Ok(())
      }
      SearchIndexJobPayload::IndexWorkspace { workspace_id } => self.process_index_workspace(workspace_id).await,
      SearchIndexJobPayload::Reindex { run_id, batch_size } => {
        self.process_reindex_run(run_id, batch_size.max(1)).await.map(|_| ())
      }
    }
  }

  /// Fan-out: list all documents in a workspace and enqueue a deferred
  /// snapshot job for each one.  Uses cursor-based pagination to handle
  /// workspaces with many documents without loading them all into memory.
  #[instrument(skip(self))]
  async fn process_index_workspace(&self, workspace_id: Uuid) -> AuthResult<()> {
    let batch_size = 100_i64;
    let mut cursor_updated_at: Option<DateTime<Utc>> = None;
    let mut cursor_doc_id: Option<Uuid> = None;
    let mut total_enqueued = 0_i64;

    loop {
      let docs = self
        .store
        .list_docs_for_reindex(Some(workspace_id), cursor_updated_at, cursor_doc_id, batch_size)
        .await?;

      if docs.is_empty() {
        break;
      }

      for doc in &docs {
        self.enqueue_deferred_snapshot(doc.workspace_id, doc.doc_id, 1).await?;
        total_enqueued += 1;
      }

      let last = docs.last().expect("docs is not empty");
      cursor_updated_at = Some(last.updated_at);
      cursor_doc_id = Some(last.doc_id);

      if (docs.len() as i64) < batch_size {
        break;
      }
    }

    info!(%workspace_id, total_enqueued, "enqueued deferred snapshot jobs for workspace indexing");
    Ok(())
  }

  #[instrument(skip(self))]
  async fn enqueue_reindex_job(&self, run_id: Uuid, batch_size: i64) -> AuthResult<String> {
    let data = serde_json::json!({
      "runId": run_id.to_string(),
      "batchSize": batch_size,
      "mode": "full",
    });
    let job_id = self
      .queue
      .add_job("indexer", "indexer.autoIndexWorkspaces", data, Some(5), None)
      .await?;
    Ok(job_id)
  }

  #[instrument(skip(self))]
  async fn process_reindex_run(&self, run_id: Uuid, batch_size: i64) -> AuthResult<bool> {
    let run = self
      .store
      .get_reindex_run(run_id)
      .await?
      .ok_or_else(|| AuthError::InvalidInput(format!("reindex run not found: {run_id}")))?;

    if run.status != SearchReindexStatus::Running {
      info!(run_id = %run_id, status = ?run.status, "reindex run not in running state, skipping");
      return Ok(false);
    }

    let docs = self
      .store
      .list_docs_for_reindex(run.workspace_id, run.cursor_updated_at, run.cursor_doc_id, batch_size)
      .await?;

    if docs.is_empty() {
      self.store.complete_reindex_run(run_id).await?;
      info!(run_id = %run_id, "reindex run completed");
      return Ok(false);
    }

    let mut indexed_count = 0_i64;
    for doc in &docs {
      let (title, plain_text, has_fields, source_revision) = self.current_text_projection(doc).await?;
      let workspace_tags = self.canonical_document_tags(doc.workspace_id, doc.doc_id).await?;
      self
        .store
        .upsert_current_search_doc(
          SearchDocument {
            workspace_id: doc.workspace_id,
            doc_id: doc.doc_id,
            title,
            plain_text,
            workspace_tags,
            search_vector: None,
            updated_at: doc.updated_at,
          },
          has_fields,
          source_revision,
        )
        .await?;
      indexed_count += 1;
    }

    let last = docs.last().expect("docs is not empty");
    self
      .store
      .update_reindex_progress(run_id, last.updated_at, last.doc_id, docs.len() as i64, indexed_count)
      .await?;

    if (docs.len() as i64) >= batch_size {
      self.enqueue_reindex_job(run_id, batch_size).await?;
    } else {
      self.store.complete_reindex_run(run_id).await?;
      info!(run_id = %run_id, "reindex run completed after final partial batch");
    }

    Ok(true)
  }
}
