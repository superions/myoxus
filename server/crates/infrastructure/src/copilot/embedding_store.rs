//! SQLx-backed Copilot embedding repository implementation (pgvector).
//!
//! [`SqlxCopilotEmbeddingRepository`] implements the
//! [`CopilotEmbeddingRepository`] domain trait against PostgreSQL with the
//! pgvector extension for vector similarity search.

use async_trait::async_trait;
use myoxus_domain::entities::{CopilotEmbedding, CopilotEmbeddingMatch, CopilotEmbeddingSourceType};
use myoxus_domain::ids::WorkspaceId;
use myoxus_domain::repositories::{
  CopilotEmbeddingRepository, CopilotWorkspaceDocMatch, CopilotWorkspaceFileMatch, RepoResult, RepositoryError,
};
use sqlx::{PgPool, Row};
use tracing::{debug, error, instrument, trace};

/// PostgreSQL + pgvector backed implementation of [`CopilotEmbeddingRepository`].
pub struct SqlxCopilotEmbeddingRepository {
  pool: PgPool,
}

impl SqlxCopilotEmbeddingRepository {
  /// Construct a new repository from an existing connection pool.
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  fn map_db_err(err: sqlx::Error) -> RepositoryError {
    error!(error = %err, "copilot embedding repository database error");
    RepositoryError::Storage(err.to_string())
  }

  /// Format a `Vec<f32>` as a string suitable for the pgvector `::vector` cast.
  /// Produces `"[0.1,0.2,0.3,...]"`.
  fn vec_to_pgvector_literal(v: &[f32]) -> String {
    let inner: String = v.iter().map(|f| f.to_string()).collect::<Vec<_>>().join(",");
    format!("[{inner}]")
  }

  /// Match the guarded expression indexes without evaluating a cast on legacy
  /// vectors of another dimension. Only a bounded integer enters the SQL text.
  pub(crate) fn distance_sql(dimensions: usize) -> RepoResult<String> {
    if !(1..=16000).contains(&dimensions) {
      return Err(RepositoryError::Validation("invalid embedding dimensions".into()));
    }
    Ok(format!(
      "(CASE WHEN vector_dims(e.embedding)={dimensions} THEN e.embedding END)::vector({dimensions}) <=> $1::vector({dimensions})"
    ))
  }

  fn map_embedding_row(row: sqlx::postgres::PgRow) -> CopilotEmbedding {
    CopilotEmbedding {
      id: row.get("id"),
      workspace_id: row.get("workspace_id"),
      source_type: CopilotEmbeddingSourceType::parse_or_doc(&row.get::<String, _>("source_type")),
      source_id: row.get("source_id"),
      chunk_index: row.get("chunk_index"),
      chunk_text: row.get("chunk_text"),
      token_count: row.get("token_count"),
      // pgvector returns the vector as text when not using a dedicated type;
      // we parse it back into Vec<f32>.
      embedding: parse_pgvector_text(&row.get::<String, _>("embedding_text")),
      model: row.get("model"),
      metadata: row.get("metadata"),
      created_at: row.get("created_at"),
    }
  }
}

/// Parse a pgvector text representation `"[0.1,0.2,...]"` back to `Vec<f32>`.
fn parse_pgvector_text(s: &str) -> Vec<f32> {
  let trimmed = s.trim_start_matches('[').trim_end_matches(']');
  if trimmed.is_empty() {
    return Vec::new();
  }
  trimmed
    .split(',')
    .filter_map(|v| v.trim().parse::<f32>().ok())
    .collect()
}

/// Maximum parameters per INSERT batch. PostgreSQL supports up to 65535
/// parameters. Each embedding row uses 10 parameters, so we cap at ~6000 rows
/// per batch to stay well under the limit.
const BATCH_CHUNK_SIZE: usize = 6000;

#[async_trait]
impl CopilotEmbeddingRepository for SqlxCopilotEmbeddingRepository {
  #[instrument(skip(self, embedding), fields(workspace_id = %embedding.workspace_id, source_id = %embedding.source_id))]
  async fn insert_embedding(&self, embedding: &CopilotEmbedding) -> RepoResult<()> {
    trace!(id = %embedding.id, chunk_index = embedding.chunk_index, "inserting single copilot embedding");
    sqlx::query(
      "INSERT INTO copilot_embeddings \
         (id, workspace_id, source_type, source_id, chunk_index, chunk_text, token_count, embedding, model, metadata, created_at, updated_at) \
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11, $11) \
       ON CONFLICT (workspace_id, source_type, source_id, chunk_index, model) \
       DO UPDATE SET chunk_text = EXCLUDED.chunk_text, token_count = EXCLUDED.token_count, \
                     embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at",
    )
    .bind(embedding.id)
    .bind(embedding.workspace_id)
    .bind(embedding.source_type.as_str())
    .bind(&embedding.source_id)
    .bind(embedding.chunk_index)
    .bind(&embedding.chunk_text)
    .bind(embedding.token_count)
    .bind(Self::vec_to_pgvector_literal(&embedding.embedding))
    .bind(&embedding.model)
    .bind(&embedding.metadata)
    .bind(embedding.created_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    debug!(id = %embedding.id, "copilot embedding inserted");
    Ok(())
  }

  #[instrument(skip(self, embeddings), fields(count = embeddings.len()))]
  async fn insert_embeddings_batch(&self, embeddings: &[CopilotEmbedding]) -> RepoResult<()> {
    if embeddings.is_empty() {
      return Ok(());
    }
    trace!(count = embeddings.len(), "batch inserting copilot embeddings");

    for chunk in embeddings.chunks(BATCH_CHUNK_SIZE) {
      let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
      for embedding in chunk {
        sqlx::query(
          "INSERT INTO copilot_embeddings \
             (id, workspace_id, source_type, source_id, chunk_index, chunk_text, token_count, embedding, model, metadata, created_at, updated_at) \
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11, $11) \
           ON CONFLICT (workspace_id, source_type, source_id, chunk_index, model) \
           DO UPDATE SET chunk_text = EXCLUDED.chunk_text, token_count = EXCLUDED.token_count, \
                         embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at",
        )
        .bind(embedding.id)
        .bind(embedding.workspace_id)
        .bind(embedding.source_type.as_str())
        .bind(&embedding.source_id)
        .bind(embedding.chunk_index)
        .bind(&embedding.chunk_text)
        .bind(embedding.token_count)
        .bind(Self::vec_to_pgvector_literal(&embedding.embedding))
        .bind(&embedding.model)
        .bind(&embedding.metadata)
        .bind(embedding.created_at)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      }
      tx.commit().await.map_err(Self::map_db_err)?;
    }
    debug!(count = embeddings.len(), "copilot embeddings batch inserted");
    Ok(())
  }

  #[instrument(skip_all, fields(%workspace_id))]
  async fn replace_source_embeddings(
    &self,
    workspace_id: WorkspaceId,
    source_type: &CopilotEmbeddingSourceType,
    source_id: &str,
    model: &str,
    embeddings: &[CopilotEmbedding],
  ) -> RepoResult<()> {
    if embeddings.iter().any(|row| {
      row.workspace_id != workspace_id
        || row.source_type != *source_type
        || row.source_id != source_id
        || row.model != model
    }) {
      return Err(RepositoryError::Validation("invalid complete embedding source".into()));
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
      .bind(format!(
        "copilot-embedding:{workspace_id}:{}:{source_id}:{model}",
        source_type.as_str()
      ))
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query(
      "DELETE FROM copilot_embeddings WHERE workspace_id=$1 AND source_type=$2 AND source_id=$3 AND model=$4",
    )
    .bind(workspace_id)
    .bind(source_type.as_str())
    .bind(source_id)
    .bind(model)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    for row in embeddings {
      sqlx::query("INSERT INTO copilot_embeddings(id,workspace_id,source_type,source_id,chunk_index,chunk_text,token_count,embedding,model,metadata,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::vector,$9,$10,$11,$11)")
        .bind(row.id).bind(workspace_id).bind(source_type.as_str()).bind(source_id).bind(row.chunk_index).bind(&row.chunk_text).bind(row.token_count).bind(Self::vec_to_pgvector_literal(&row.embedding)).bind(model).bind(&row.metadata).bind(row.created_at).execute(&mut *tx).await.map_err(Self::map_db_err)?;
    }
    tx.commit().await.map_err(Self::map_db_err)
  }

  #[instrument(skip(self))]
  async fn delete_embeddings_by_source(
    &self,
    workspace_id: WorkspaceId,
    source_type: &CopilotEmbeddingSourceType,
    source_id: &str,
  ) -> RepoResult<u64> {
    trace!(%workspace_id, source_type = source_type.as_str(), source_id, "deleting embeddings by source");
    let result =
      sqlx::query("DELETE FROM copilot_embeddings WHERE workspace_id = $1 AND source_type = $2 AND source_id = $3")
        .bind(workspace_id)
        .bind(source_type.as_str())
        .bind(source_id)
        .execute(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    let deleted = result.rows_affected();
    debug!(%workspace_id, source_id, deleted, "embeddings deleted by source");
    Ok(deleted)
  }

  #[instrument(skip(self, query_embedding), fields(%workspace_id, limit))]
  async fn similarity_search(
    &self,
    workspace_id: WorkspaceId,
    query_embedding: &[f32],
    limit: i32,
    model: &str,
    source_ids: &[uuid::Uuid],
  ) -> RepoResult<Vec<CopilotEmbeddingMatch>> {
    trace!(%workspace_id, embedding_dim = query_embedding.len(), limit, "running similarity search");
    let query_literal = Self::vec_to_pgvector_literal(query_embedding);
    let dimensions = query_embedding.len();
    let distance = Self::distance_sql(dimensions)?;
    let rows = sqlx::query(&format!(
      "SELECT id, workspace_id, source_type, source_id, chunk_index, chunk_text, \
              token_count, embedding::text AS embedding_text, model, metadata, created_at, \
               {distance} AS distance \
        FROM copilot_embeddings e \
         WHERE workspace_id = $2 AND model = $4 AND source_type='doc' AND vector_dims(e.embedding)={dimensions} \
          AND EXISTS(SELECT 1 FROM docs d WHERE d.workspace_id=e.workspace_id AND d.id::text=e.source_id AND d.deleted_at IS NULL AND NOT d.blocked AND NOT d.is_workspace_root AND d.external_id NOT LIKE 'db$%' AND d.external_id NOT LIKE 'userdata$%' AND NOT (COALESCE((SELECT ignored_doc_ids FROM copilot_workspaces WHERE workspace_id=$2),'[]'::jsonb) ? d.id::text)) \
          AND (cardinality($5::uuid[])=0 OR source_id IN(SELECT unnest($5::uuid[])::text)) \
           AND NOT EXISTS (SELECT 1 FROM (SELECT state FROM copilot_jobs j WHERE j.workspace_id=e.workspace_id AND j.job_type='copilot.embedding.add' AND j.payload->>'model'=e.model AND COALESCE(j.payload->>'dimensions','1536')=vector_dims(e.embedding)::text AND j.payload->>'sourceId'=e.source_id AND j.payload->>'sourceType'=e.source_type ORDER BY created_at DESC,id DESC LIMIT 1) latest WHERE latest.state<>'finished') \
        ORDER BY {distance} \
       LIMIT $3",
    ))
    .bind(&query_literal)
    .bind(workspace_id)
    .bind(limit)
    .bind(model)
    .bind(source_ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let results: Vec<CopilotEmbeddingMatch> = rows
      .into_iter()
      .map(|row| {
        let distance: f64 = row.get("distance");
        CopilotEmbeddingMatch {
          embedding: Self::map_embedding_row(row),
          distance,
        }
      })
      .collect();
    debug!(%workspace_id, returned = results.len(), "similarity search complete");
    Ok(results)
  }

  #[instrument(skip(self, query_embedding), fields(%workspace_id, limit))]
  async fn similarity_search_workspace_files(
    &self,
    workspace_id: WorkspaceId,
    query_embedding: &[f32],
    limit: i32,
    maximum_distance: Option<f64>,
    model: &str,
    source_ids: &[String],
  ) -> RepoResult<Vec<CopilotWorkspaceFileMatch>> {
    let query_literal = Self::vec_to_pgvector_literal(query_embedding);
    let dimensions = query_embedding.len();
    let distance = Self::distance_sql(dimensions)?;
    let rows = sqlx::query(&format!(
      r#"SELECT e.source_id AS file_id, e.chunk_text AS content, b.key AS blob_id,
                COALESCE(e.metadata->>'name',b.key) AS file_name, b.mime AS mime_type,
                e.chunk_index AS chunk,
                 {distance} AS distance
         FROM copilot_embeddings e
         JOIN blobs b ON e.workspace_id=b.workspace_id AND e.source_id=b.key
         WHERE e.workspace_id = $2 AND e.source_type IN ('file','attachment')
            AND e.model=$5 AND vector_dims(e.embedding)={dimensions} AND b.deleted_at IS NULL AND b.status='completed'
           AND e.source_id=ANY($6)
            AND NOT EXISTS (SELECT 1 FROM (SELECT state FROM copilot_jobs j WHERE j.workspace_id=e.workspace_id AND j.job_type='copilot.embedding.add' AND j.payload->>'model'=e.model AND COALESCE(j.payload->>'dimensions','1536')=vector_dims(e.embedding)::text AND j.payload->>'sourceId'=e.source_id AND j.payload->>'sourceType'=e.source_type ORDER BY created_at DESC,id DESC LIMIT 1) latest WHERE latest.state<>'finished')
            AND ($4::double precision IS NULL OR {distance} <= $4)
          ORDER BY {distance}
         LIMIT $3"#,
    ))
    .bind(query_literal)
    .bind(workspace_id)
    .bind(limit.clamp(1, 100))
    .bind(maximum_distance)
    .bind(model)
    .bind(source_ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| CopilotWorkspaceFileMatch {
          file_id: row.get("file_id"),
          content: row.get("content"),
          blob_id: row.get("blob_id"),
          name: row.get("file_name"),
          mime_type: row.get("mime_type"),
          chunk: row.get("chunk"),
          distance: row.get("distance"),
        })
        .collect(),
    )
  }

  #[instrument(skip(self, query_embedding), fields(%workspace_id, limit))]
  async fn similarity_search_workspace_docs(
    &self,
    workspace_id: WorkspaceId,
    query_embedding: &[f32],
    limit: i32,
    maximum_distance: Option<f64>,
    model: &str,
    source_ids: &[uuid::Uuid],
  ) -> RepoResult<Vec<CopilotWorkspaceDocMatch>> {
    let query_literal = Self::vec_to_pgvector_literal(query_embedding);
    let dimensions = query_embedding.len();
    let distance = Self::distance_sql(dimensions)?;
    let rows = sqlx::query(&format!(
      r#"SELECT d.id AS doc_id, e.chunk_text AS content, e.chunk_index AS chunk,
                 {distance} AS distance
         FROM copilot_embeddings e
         JOIN docs d ON d.workspace_id=e.workspace_id AND d.id::text=e.source_id
          WHERE e.workspace_id = $2 AND e.source_type='doc' AND e.model=$5 AND vector_dims(e.embedding)={dimensions}
           AND d.deleted_at IS NULL AND NOT d.blocked AND NOT d.is_workspace_root AND d.external_id NOT LIKE 'db$%' AND d.external_id NOT LIKE 'userdata$%'
           AND (cardinality($6::uuid[])=0 OR d.id=ANY($6))
           AND NOT (COALESCE((SELECT ignored_doc_ids FROM copilot_workspaces WHERE workspace_id=$2),'[]'::jsonb) ? d.id::text)
            AND NOT EXISTS (SELECT 1 FROM (SELECT state FROM copilot_jobs j WHERE j.workspace_id=e.workspace_id AND j.job_type='copilot.embedding.add' AND j.payload->>'model'=e.model AND COALESCE(j.payload->>'dimensions','1536')=vector_dims(e.embedding)::text AND j.payload->>'sourceId'=e.source_id AND j.payload->>'sourceType'='doc' ORDER BY created_at DESC,id DESC LIMIT 1) latest WHERE latest.state<>'finished')
            AND ($4::double precision IS NULL OR {distance} <= $4)
          ORDER BY {distance}
         LIMIT $3"#,
    ))
    .bind(query_literal)
    .bind(workspace_id)
    .bind(limit.clamp(1, 100))
    .bind(maximum_distance)
    .bind(model)
    .bind(source_ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| CopilotWorkspaceDocMatch {
          doc_id: row.get("doc_id"),
          content: row.get("content"),
          chunk: row.get("chunk"),
          distance: row.get("distance"),
        })
        .collect(),
    )
  }

  #[instrument(skip(self))]
  async fn count_embeddings_by_workspace(&self, workspace_id: WorkspaceId) -> RepoResult<i64> {
    let row = sqlx::query("SELECT COUNT(*) AS cnt FROM copilot_embeddings WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_one(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    let count: i64 = row.get("cnt");
    trace!(%workspace_id, count, "counted embeddings by workspace");
    Ok(count)
  }

  async fn workspace_index_status(
    &self,
    workspace_id: WorkspaceId,
    model: &str,
    dimensions: u32,
  ) -> RepoResult<myoxus_domain::repositories::CopilotIndexStatus> {
    let row = sqlx::query(r#"WITH latest AS (
      SELECT DISTINCT ON (payload->>'sourceId') payload->>'sourceId' AS source_id,state,updated_at,payload->'indexedChunks' AS indexed_chunks
      FROM copilot_jobs WHERE workspace_id=$1 AND job_type='copilot.embedding.add' AND payload->>'model'=$2 AND COALESCE(payload->>'dimensions','1536')=$3::integer::text AND payload->>'sourceType'='doc'
      ORDER BY payload->>'sourceId',created_at DESC,id DESC
    ) SELECT COUNT(*) FILTER(WHERE NOT COALESCE(latest.state='finished' AND latest.indexed_chunks='0'::jsonb AND latest.updated_at>=d.updated_at,false))::bigint AS total,
      COUNT(*) FILTER(WHERE (latest.state IS NULL OR latest.state='finished') AND EXISTS(SELECT 1 FROM copilot_embeddings e WHERE e.workspace_id=$1 AND e.model=$2 AND vector_dims(e.embedding)=$3 AND e.source_type='doc' AND e.source_id=d.id::text))::bigint AS embedded,
      COALESCE(BOOL_OR(latest.state IN ('pending','claimed','running')),false) AS processing,
      COALESCE(BOOL_OR(latest.state='failed'),false) AS failed
    FROM docs d LEFT JOIN latest ON latest.source_id=d.id::text
    WHERE d.workspace_id=$1 AND d.deleted_at IS NULL AND NOT d.blocked AND NOT d.is_workspace_root AND d.external_id NOT LIKE 'db$%' AND d.external_id NOT LIKE 'userdata$%'
      AND NOT (COALESCE((SELECT ignored_doc_ids FROM copilot_workspaces WHERE workspace_id=$1),'[]'::jsonb) ? d.id::text)"#)
      .bind(workspace_id).bind(model).bind(dimensions as i32).fetch_one(&self.pool).await.map_err(Self::map_db_err)?;
    Ok(myoxus_domain::repositories::CopilotIndexStatus {
      total: row.get("total"),
      embedded: row.get("embedded"),
      processing: row.get("processing"),
      failed: row.get("failed"),
    })
  }

  async fn has_indexed_file_sources(
    &self,
    workspace_id: WorkspaceId,
    model: &str,
    dimensions: u32,
    source_ids: &[String],
  ) -> RepoResult<bool> {
    sqlx::query_scalar(r#"SELECT EXISTS(SELECT 1 FROM copilot_embeddings e JOIN blobs b ON b.workspace_id=e.workspace_id AND b.key=e.source_id
      WHERE e.workspace_id=$1 AND e.model=$2 AND vector_dims(e.embedding)=$4 AND e.source_type IN ('file','attachment') AND e.source_id=ANY($3)
      AND b.deleted_at IS NULL AND b.status='completed'
      AND NOT EXISTS(SELECT 1 FROM(SELECT state FROM copilot_jobs j WHERE j.workspace_id=e.workspace_id AND j.job_type='copilot.embedding.add' AND j.payload->>'model'=e.model AND COALESCE(j.payload->>'dimensions','1536')=vector_dims(e.embedding)::text AND j.payload->>'sourceId'=e.source_id AND j.payload->>'sourceType'=e.source_type ORDER BY created_at DESC,id DESC LIMIT 1) latest WHERE latest.state<>'finished'))"#)
      .bind(workspace_id).bind(model).bind(source_ids).bind(dimensions as i32).fetch_one(&self.pool).await.map_err(Self::map_db_err)
  }

  async fn list_embedding_sources(&self, workspace_id: WorkspaceId) -> RepoResult<Vec<(String, String)>> {
    sqlx::query_as("SELECT DISTINCT source_type, source_id FROM copilot_embeddings WHERE workspace_id = $1")
      .bind(workspace_id)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)
  }

  #[instrument(skip(self, valid_source_ids), fields(%workspace_id, valid_count = valid_source_ids.len()))]
  async fn delete_orphan_embeddings(&self, workspace_id: WorkspaceId, valid_source_ids: &[String]) -> RepoResult<u64> {
    trace!(%workspace_id, valid_count = valid_source_ids.len(), "deleting orphan embeddings");
    let result = if valid_source_ids.is_empty() {
      // No valid source IDs means ALL embeddings in the workspace are orphans.
      sqlx::query("DELETE FROM copilot_embeddings WHERE workspace_id = $1")
        .bind(workspace_id)
        .execute(&self.pool)
        .await
        .map_err(Self::map_db_err)?
    } else {
      sqlx::query("DELETE FROM copilot_embeddings WHERE workspace_id = $1 AND source_id != ALL($2)")
        .bind(workspace_id)
        .bind(valid_source_ids)
        .execute(&self.pool)
        .await
        .map_err(Self::map_db_err)?
    };
    let deleted = result.rows_affected();
    debug!(%workspace_id, deleted, "orphan embeddings deleted");
    Ok(deleted)
  }
}

// ─── Context Window Helper ────────────────────────────────────────────────────

/// Build a context window from similarity search results, respecting a token
/// budget. Returns references to results that fit within `max_tokens`.
pub fn build_context_window(results: &[CopilotEmbeddingMatch], max_tokens: usize) -> Vec<&CopilotEmbeddingMatch> {
  let mut total_tokens: usize = 0;
  results
    .iter()
    .take_while(|r| {
      total_tokens += r.embedding.token_count as usize;
      total_tokens <= max_tokens
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parse_pgvector_text_roundtrip() {
    let original = vec![0.1_f32, 0.2, -0.3, 1.0];
    let literal = SqlxCopilotEmbeddingRepository::vec_to_pgvector_literal(&original);
    assert_eq!(literal, "[0.1,0.2,-0.3,1]");
    let parsed = parse_pgvector_text(&literal);
    assert_eq!(parsed.len(), original.len());
    for (a, b) in parsed.iter().zip(original.iter()) {
      assert!((a - b).abs() < 1e-6);
    }
  }

  #[test]
  fn parse_pgvector_text_empty() {
    let parsed = parse_pgvector_text("[]");
    assert!(parsed.is_empty());
  }

  #[test]
  fn build_context_window_respects_budget() {
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;

    let make_match = |tokens: i32| CopilotEmbeddingMatch {
      embedding: CopilotEmbedding {
        id: Uuid::new_v4(),
        workspace_id: Uuid::new_v4(),
        source_type: CopilotEmbeddingSourceType::Doc,
        source_id: "test".into(),
        chunk_index: 0,
        chunk_text: "hello".into(),
        token_count: tokens,
        embedding: vec![],
        model: "test".into(),
        metadata: json!({}),
        created_at: Utc::now(),
      },
      distance: 0.1,
    };

    let results = vec![make_match(100), make_match(200), make_match(300)];
    // Budget 250: should include first two (100 + 200 = 300 > 250 → only first)
    // Actually: take_while includes while condition holds, so:
    // iter 1: total=100, 100<=250 → include
    // iter 2: total=300, 300>250 → stop
    let window = build_context_window(&results, 250);
    assert_eq!(window.len(), 1);

    // Budget 300: first two fit exactly
    let window = build_context_window(&results, 300);
    assert_eq!(window.len(), 2);

    // Budget 1000: all fit
    let window = build_context_window(&results, 1000);
    assert_eq!(window.len(), 3);

    // Budget 0: none fit
    let window = build_context_window(&results, 0);
    assert_eq!(window.len(), 0);
  }
}
