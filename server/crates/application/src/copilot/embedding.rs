// SPDX-License-Identifier: AGPL-3.0-or-later
//! Productive indexing uses the configured embedding port, never chat fallback.

use std::sync::Arc;

use chrono::Utc;
use myoxus_domain::{
  entities::{CopilotEmbedding, CopilotEmbeddingSourceType, CopilotJobState, Doc},
  permission::{DocAction, WorkspaceAction},
  repositories::CopilotEmbeddingRepository,
};
use serde_json::json;
use tracing::instrument;
use uuid::Uuid;

use super::{
  CopilotService,
  context_ingest::{ContextFileParser, ContextIngestionLimits},
  provider::{EmbeddingPurpose, LlmProvider, LlmProviderError},
};
use crate::{
  auth::{AuthError, AuthResult},
  doc::DocService,
  permission::{AccessController, DocResource, PermissionService, WorkspaceResource},
  ports::{blob::BlobStatus, blob_service::BlobService},
  worker::WorkQueuePort,
};

/// Validate the same vector contract for indexing and query embedding. Invalid
/// dimensions/counts must not publish a partial or apparently ready index.
pub async fn embed_checked(
  provider: &dyn LlmProvider,
  texts: &[String],
  model: &str,
  dimensions: u32,
  purpose: EmbeddingPurpose,
) -> Result<Vec<Vec<f32>>, LlmProviderError> {
  let response = provider.embed_for_purpose(texts, model, purpose).await?;
  if response.embeddings.len() != texts.len()
    || response
      .embeddings
      .iter()
      .any(|vector| vector.len() != dimensions as usize || vector.iter().any(|value| !value.is_finite()))
  {
    return Err(LlmProviderError::Upstream(
      "embedding response has invalid vector dimensions or count".into(),
    ));
  }
  Ok(response.embeddings)
}

/// Reserved CRDT state is not user-authored retrieval content. Keep admission
/// aligned with the document predicates in the embedding repository.
pub fn is_embedding_document(doc: &Doc) -> bool {
  !doc.is_workspace_root
    && !doc.blocked
    && doc.deleted_at.is_none()
    && !doc.external_id.starts_with("db$")
    && !doc.external_id.starts_with("userdata$")
}

pub struct EmbeddingIndexer {
  pub copilot: Arc<CopilotService>,
  pub repository: Arc<dyn CopilotEmbeddingRepository>,
  pub docs: Arc<DocService>,
  pub blobs: Arc<BlobService>,
  pub permissions: Arc<PermissionService>,
  pub queue: Arc<dyn WorkQueuePort>,
  pub parser: Arc<dyn ContextFileParser>,
  pub limits: ContextIngestionLimits,
  pub provider: Arc<dyn LlmProvider>,
  pub model: String,
  pub dimensions: u32,
  pub batch_size: usize,
  pub mime_policy: crate::mime_policy::MimePolicyConfig,
}

impl EmbeddingIndexer {
  /// Persist intent before dispatch; the existing Redis queue owns execution and
  /// retries. A failed dispatch remains failed SQL work, never ready progress.
  #[instrument(skip_all, fields(%workspace_id))]
  pub async fn queue_source(
    &self,
    workspace_id: Uuid,
    user_id: Option<Uuid>,
    source_type: CopilotEmbeddingSourceType,
    source_id: String,
  ) -> AuthResult<Uuid> {
    if source_type == CopilotEmbeddingSourceType::Doc {
      let doc_id = Uuid::parse_str(&source_id).map_err(|_| AuthError::ActionForbidden)?;
      self
        .docs
        .get_doc_metadata(doc_id)
        .await?
        .filter(|doc| doc.workspace_id == Some(workspace_id) && is_embedding_document(doc))
        .ok_or(AuthError::ActionForbidden)?;
    }
    let job = self
      .copilot
      .create_job(
        "copilot.embedding.add".into(),
        Some(workspace_id),
        user_id,
        json!({"sourceType":source_type.as_str(),"sourceId":source_id,"model":self.model,"dimensions":self.dimensions}),
      )
      .await?;
    if self
      .queue
      .add_job(
        "copilot",
        "copilot.embedding.add",
        json!({"copilotJobId":job.id}),
        Some(self.limits.max_attempts),
        None,
      )
      .await
      .is_err()
    {
      self
        .copilot
        .update_job_state(
          job.id,
          CopilotJobState::Failed,
          Some("EMBEDDING_DISPATCH_FAILED".into()),
        )
        .await?;
      return Err(AuthError::Storage("embedding dispatch failed".into()));
    }
    Ok(job.id)
  }

  async fn authorize(
    &self,
    workspace: Uuid,
    user: Option<Uuid>,
    source_type: &CopilotEmbeddingSourceType,
    source: &str,
  ) -> AuthResult<()> {
    if let Some(user_id) = user {
      self
        .permissions
        .assert(
          &WorkspaceResource {
            user_id,
            workspace_id: workspace,
          },
          WorkspaceAction::Copilot,
        )
        .await?;
      if *source_type == CopilotEmbeddingSourceType::Doc {
        self
          .permissions
          .assert(
            &DocResource {
              user_id,
              workspace_id: workspace,
              doc_id: Uuid::parse_str(source).map_err(|_| AuthError::ActionForbidden)?,
            },
            DocAction::Read,
          )
          .await?;
      } else {
        self
          .permissions
          .assert(
            &WorkspaceResource {
              user_id,
              workspace_id: workspace,
            },
            WorkspaceAction::BlobsRead,
          )
          .await?;
      }
    }
    Ok(())
  }

  /// The worker consumes only a persisted job identity. Source and caller are
  /// loaded from SQL rather than accepted from an unbound worker payload.
  #[instrument(skip_all, fields(%job_id))]
  pub async fn execute(&self, job_id: Uuid) -> AuthResult<usize> {
    let job = self.copilot.get_job(job_id).await?.ok_or(AuthError::ActionForbidden)?;
    if job.job_type != "copilot.embedding.add" {
      return Err(AuthError::ActionForbidden);
    }
    if job.payload["model"] != self.model
      || job
        .payload
        .get("dimensions")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1536)
        != u64::from(self.dimensions)
    {
      self
        .copilot
        .update_job_state(
          job_id,
          CopilotJobState::Failed,
          Some("EMBEDDING_CONFIGURATION_CHANGED".into()),
        )
        .await?;
      return Err(AuthError::InvalidInput("embedding job configuration changed".into()));
    }
    if job.state == CopilotJobState::Finished {
      return Ok(0);
    }
    let workspace = job.workspace_id.ok_or(AuthError::ActionForbidden)?;
    let source = job.payload["sourceId"].as_str().ok_or(AuthError::ActionForbidden)?;
    let kind = match job.payload["sourceType"].as_str() {
      Some("doc") => CopilotEmbeddingSourceType::Doc,
      Some("file") => CopilotEmbeddingSourceType::File,
      Some("attachment") => CopilotEmbeddingSourceType::Attachment,
      _ => return Err(AuthError::InvalidInput("invalid embedding source type".into())),
    };
    self
      .copilot
      .update_job_state(job_id, CopilotJobState::Running, None)
      .await?;
    let result = tokio::time::timeout(
      std::time::Duration::from_millis(self.limits.timeout_ms),
      self.index_source(workspace, job.user_id, kind, source),
    )
    .await;
    match result {
      Ok(Ok(count)) => {
        // An empty, successfully materialized source has no searchable chunks.
        // Persist that outcome before publishing completion; failures never
        // masquerade as an intentionally empty document in readiness counts.
        let mut payload = job.payload.clone();
        payload["indexedChunks"] = json!(count);
        self.copilot.update_job_payload(job_id, payload).await?;
        self
          .copilot
          .update_job_state(job_id, CopilotJobState::Finished, None)
          .await?;
        Ok(count)
      }
      failure => {
        self
          .copilot
          .update_job_state(
            job_id,
            CopilotJobState::Failed,
            Some(
              if failure.is_err() {
                "EMBEDDING_TIMEOUT"
              } else {
                "EMBEDDING_FAILED"
              }
              .into(),
            ),
          )
          .await?;
        Err(AuthError::Storage("embedding source failed or is unavailable".into()))
      }
    }
  }

  async fn index_source(
    &self,
    workspace: Uuid,
    user: Option<Uuid>,
    kind: CopilotEmbeddingSourceType,
    source: &str,
  ) -> AuthResult<usize> {
    self.authorize(workspace, user, &kind, source).await?;
    let text = if kind == CopilotEmbeddingSourceType::Doc {
      let doc = Uuid::parse_str(source).map_err(|_| AuthError::ActionForbidden)?;
      self
        .docs
        .get_doc_metadata(doc)
        .await?
        .filter(|metadata| metadata.workspace_id == Some(workspace) && is_embedding_document(metadata))
        .ok_or(AuthError::ActionForbidden)?;
      if self
        .copilot
        .get_workspace_state(workspace)
        .await?
        .is_some_and(|state| state.ignored_doc_ids.contains(&doc))
      {
        return Err(AuthError::ActionForbidden);
      }
      super::context_prompt::materialize_selected_document(&self.docs, workspace, doc, self.limits.max_output_bytes)
        .await?
        .markdown
    } else {
      self
        .blobs
        .get_blob_metadata(workspace, source)
        .await?
        .filter(|blob| blob.deleted_at.is_none() && blob.status == BlobStatus::Completed)
        .ok_or(AuthError::ActionForbidden)?;
      let blob = self
        .blobs
        .get_blob_bounded(workspace, source, self.limits.max_input_bytes)
        .await?;
      let mime = blob.content_type.as_deref().unwrap_or("application/octet-stream");
      let detection = crate::mime_policy::detect_mime(&blob.data, "source", mime);
      if matches!(
        crate::mime_policy::evaluate_policy(&detection, &self.mime_policy),
        crate::mime_policy::MimePolicyDecision::Deny { .. }
      ) {
        return Err(AuthError::ActionForbidden);
      }
      self
        .parser
        .parse(
          blob.data,
          blob.content_type.as_deref().unwrap_or("application/octet-stream"),
          self.limits,
        )
        .await?
        .text
    };
    if text.len() > self.limits.max_output_bytes {
      return Err(AuthError::InvalidInput("embedding source has no bounded text".into()));
    }
    // Empty sources clear their previous vectors through the same atomic
    // replacement below, after authorization and document revalidation.
    let chunks: Vec<String> = if text.trim().is_empty() {
      Vec::new()
    } else {
      let parser =
        myoxus_doc_pipeline::DefaultDocumentParser::new(myoxus_doc_pipeline::pipeline::ParserConfig::default());
      let parsed = parser
        .parse(text.as_bytes(), "text/markdown", "source.md")
        .map_err(|_| AuthError::InvalidInput("embedding chunking failed".into()))?;
      if parsed.chunks.is_empty() {
        vec![text.clone()]
      } else {
        parsed.chunks.into_iter().map(|chunk| chunk.content).collect()
      }
    };
    let mut embeddings = Vec::with_capacity(chunks.len());
    for (batch_index, batch) in chunks.chunks(self.batch_size.clamp(1, 100)).enumerate() {
      let vectors = embed_checked(
        self.provider.as_ref(),
        batch,
        &self.model,
        self.dimensions,
        EmbeddingPurpose::Document,
      )
      .await
      .map_err(|_| AuthError::Storage("embedding provider unavailable".into()))?;
      for (offset, (chunk, vector)) in batch.iter().zip(vectors).enumerate() {
        embeddings.push(CopilotEmbedding {
          id: Uuid::new_v4(),
          workspace_id: workspace,
          source_type: kind.clone(),
          source_id: source.into(),
          chunk_index: (batch_index * self.batch_size.clamp(1, 100) + offset) as i32,
          chunk_text: chunk.clone(),
          token_count: (chunk.len() / 4) as i32,
          embedding: vector,
          model: self.model.clone(),
          metadata: json!({"source_type":kind.as_str(),"pipeline":"openai-embedding"}),
          created_at: Utc::now(),
        });
      }
    }
    self.authorize(workspace, user, &kind, source).await?;
    if kind == CopilotEmbeddingSourceType::Doc {
      let doc = Uuid::parse_str(source).map_err(|_| AuthError::ActionForbidden)?;
      self
        .docs
        .get_doc_metadata(doc)
        .await?
        .filter(|metadata| metadata.workspace_id == Some(workspace) && is_embedding_document(metadata))
        .ok_or(AuthError::ActionForbidden)?;
      if self
        .copilot
        .get_workspace_state(workspace)
        .await?
        .is_some_and(|state| state.ignored_doc_ids.contains(&doc))
        || super::context_prompt::materialize_selected_document(
          &self.docs,
          workspace,
          doc,
          self.limits.max_output_bytes,
        )
        .await?
        .markdown
          != text
      {
        return Err(AuthError::InvalidInput(
          "embedding source changed during indexing".into(),
        ));
      }
    } else {
      self
        .blobs
        .get_blob_metadata(workspace, source)
        .await?
        .filter(|blob| blob.deleted_at.is_none() && blob.status == BlobStatus::Completed)
        .ok_or(AuthError::ActionForbidden)?;
    }
    let count = embeddings.len();
    self
      .repository
      .replace_source_embeddings(workspace, &kind, source, &self.model, &embeddings)
      .await
      .map_err(CopilotService::map_repo_err)?;
    Ok(count)
  }
}
