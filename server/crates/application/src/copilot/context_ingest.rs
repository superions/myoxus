// SPDX-License-Identifier: AGPL-3.0-or-later
//! Durable selected-file admission and lease-guarded execution on the Copilot queue.

use super::CopilotService;
use crate::{
  auth::{AuthError, AuthResult},
  permission::{AccessController, DocResource, PermissionService, WorkspaceResource},
  ports::blob_service::BlobService,
  worker::WorkQueuePort,
};
use async_trait::async_trait;
use bytes::Bytes;
use chrono::Utc;
use myoxus_domain::{
  entities::{CopilotContext, CopilotContextItem, CopilotContextItemType},
  permission::{DocAction, WorkspaceAction},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{io::Read, sync::Arc};
use tracing::instrument;
use uuid::Uuid;

#[derive(Clone, Copy)]
pub struct ContextIngestionLimits {
  pub max_input_bytes: u64,
  pub max_output_bytes: usize,
  pub timeout_ms: u64,
  pub dispatch_ms: u64,
  pub max_attempts: u32,
}

#[derive(Serialize, Deserialize)]
pub struct ParsedContextFile {
  pub text: String,
  pub chunk_count: usize,
}

#[async_trait]
pub trait ContextFileParser: Send + Sync {
  /// Implementations must terminate their parser work on deadline/cancellation;
  /// dropping a timed-out blocking thread is not cancellation.
  async fn parse(&self, bytes: Bytes, mime: &str, limits: ContextIngestionLimits) -> AuthResult<ParsedContextFile>;
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextIngestJob {
  pub context_id: Uuid,
  pub item_id: Uuid,
  pub blob_id: String,
  pub ingestion_id: Uuid,
}

pub struct ContextIngestion {
  pub copilot: Arc<CopilotService>,
  pub blobs: Arc<BlobService>,
  pub permissions: Arc<PermissionService>,
  pub queue: Arc<dyn WorkQueuePort>,
  pub parser: Arc<dyn ContextFileParser>,
  pub limits: ContextIngestionLimits,
  pub mime_policy: crate::mime_policy::MimePolicyConfig,
}

fn unavailable() -> AuthError {
  AuthError::ActionForbidden
}

impl ContextIngestion {
  fn deadline(&self, duration: u64) -> i64 {
    Utc::now()
      .timestamp_millis()
      .saturating_add(duration.min(i64::MAX as u64) as i64)
  }

  /// Background execution uses the persisted person/session, never a synthetic
  /// worker identity. Recheck this boundary before publishing parsed content.
  #[instrument(skip_all,fields(%context_id))]
  pub async fn authorize(&self, context_id: Uuid, caller: Option<Uuid>, upload: bool) -> AuthResult<CopilotContext> {
    let context = self.copilot.get_context(context_id).await?.ok_or_else(unavailable)?;
    if caller.is_some_and(|user| user != context.user_id) {
      return Err(unavailable());
    }
    let workspace_id = context.workspace_id.ok_or_else(unavailable)?;
    let resource = WorkspaceResource {
      user_id: context.user_id,
      workspace_id,
    };
    self.permissions.assert(&resource, WorkspaceAction::Copilot).await?;
    self
      .permissions
      .assert(
        &resource,
        if upload {
          WorkspaceAction::BlobsWrite
        } else {
          WorkspaceAction::BlobsRead
        },
      )
      .await?;
    if let Some(session_id) = context.metadata.get("sessionId") {
      let session_id = session_id
        .as_str()
        .and_then(|id| Uuid::parse_str(id).ok())
        .ok_or_else(unavailable)?;
      let session = self.copilot.get_session(session_id).await?;
      if session.user_id != context.user_id
        || session.workspace_id != Some(workspace_id)
        || session.deleted_at.is_some()
      {
        return Err(unavailable());
      }
      if let Some(doc_id) = session.doc_id {
        self
          .permissions
          .assert(
            &DocResource {
              user_id: context.user_id,
              workspace_id,
              doc_id,
            },
            DocAction::Read,
          )
          .await?;
      }
    }
    Ok(context)
  }

  #[instrument(skip_all,fields(%context_id))]
  pub async fn upload(
    &self,
    user_id: Uuid,
    context_id: Uuid,
    name: String,
    mime: Option<String>,
    file: std::fs::File,
  ) -> AuthResult<CopilotContextItem> {
    let context = self.authorize(context_id, Some(user_id), true).await?;
    if name.is_empty() || name.len() > 1024 || name.chars().any(char::is_control) {
      return Err(AuthError::InvalidInput("invalid context filename".into()));
    }
    let max = self.limits.max_input_bytes;
    let data = tokio::task::spawn_blocking(move || {
      let mut data = Vec::new();
      file
        .take(max.saturating_add(1))
        .read_to_end(&mut data)
        .map_err(|_| AuthError::InvalidInput("context upload could not be read".into()))?;
      if data.is_empty() || data.len() as u64 > max {
        return Err(AuthError::InvalidInput(
          "context upload is empty or exceeds the storage input limit".into(),
        ));
      }
      Ok(data)
    })
    .await
    .map_err(|_| AuthError::Storage("context upload could not be read".into()))??;
    let mime = validated_mime(&name, mime.as_deref(), &data)?;
    // The shared detector traces its filename argument. Only the canonical
    // format hint may leave authorized metadata, never a private upload name.
    let detection = crate::mime_policy::detect_mime(&data, format_name(mime), mime);
    if matches!(
      crate::mime_policy::evaluate_policy(&detection, &self.mime_policy),
      crate::mime_policy::MimePolicyDecision::Deny { .. }
    ) {
      return Err(AuthError::InvalidInput(
        "context file is denied by the upload MIME policy".into(),
      ));
    }
    let workspace = context.workspace_id.ok_or_else(unavailable)?;
    let blob_id = format!("copilot/context/{}", Uuid::new_v4());
    let size = data.len();
    self
      .blobs
      .upload_single_part_blob(workspace, &blob_id, Bytes::from(data), mime, Some(mime.into()), None)
      .await?;
    if let Err(error) = self.authorize(context_id, Some(user_id), true).await {
      self.blobs.delete_imported_blob(workspace, &blob_id).await?;
      return Err(error);
    }
    // Only this fresh key is compensable. Never remove shared blobs on context
    // removal; ordinary workspace blob retention owns their lifecycle.
    let item=match self.copilot.add_context_item(context_id,CopilotContextItemType::File,Uuid::new_v4().to_string(),json!({"blobId":blob_id,"name":name,"mimeType":mime,"size":size,"ingestStatus":"queued","ingestionId":Uuid::new_v4(),"attempts":0,"leaseUntil":0})).await {
      Ok(item)=>item,
      Err(error)=>{self.blobs.delete_imported_blob(workspace,&blob_id).await?;return Err(error);}
    };
    self.dispatch(item).await
  }

  async fn replace(&self, item: &CopilotContextItem, metadata: &Value) -> AuthResult<bool> {
    self
      .copilot
      .repo
      .compare_context_item_metadata(item.id, &item.metadata, metadata)
      .await
      .map_err(CopilotService::map_repo_err)
  }

  /// Selecting an existing attachment reuses its workspace blob, never a URL.
  #[instrument(skip_all,fields(%context_id))]
  pub async fn attach(&self, user: Uuid, context_id: Uuid, blob_id: &str) -> AuthResult<CopilotContextItem> {
    let context = self.authorize(context_id, Some(user), false).await?;
    let workspace = context.workspace_id.ok_or_else(unavailable)?;
    let metadata = self
      .blobs
      .get_blob_metadata(workspace, blob_id)
      .await?
      .filter(|blob| blob.deleted_at.is_none() && blob.status == crate::ports::blob::BlobStatus::Completed)
      .ok_or_else(unavailable)?;
    let existing = self
      .copilot
      .list_context_items(context_id)
      .await?
      .into_iter()
      .find(|item| item.item_type == CopilotContextItemType::Blob && item.item_ref == blob_id);
    if let Some(item) = &existing {
      if matches!(item.metadata["ingestStatus"].as_str(), Some("queued" | "running"))
        || (item.metadata["ingestStatus"] == "finished"
          && item.metadata["text"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty()))
      {
        return Ok(item.clone());
      }
    }
    let name = format_name(&metadata.mime);
    let data = self
      .blobs
      .get_blob_bounded(workspace, blob_id, self.limits.max_input_bytes)
      .await?
      .data;
    let mime = validated_mime(name, Some(&metadata.mime), &data)?;
    let detection = crate::mime_policy::detect_mime(&data, format_name(mime), mime);
    if matches!(
      crate::mime_policy::evaluate_policy(&detection, &self.mime_policy),
      crate::mime_policy::MimePolicyDecision::Deny { .. }
    ) {
      return Err(AuthError::InvalidInput(
        "context file is denied by the upload MIME policy".into(),
      ));
    }
    self.authorize(context_id, Some(user), false).await?;
    let metadata = json!({"blobId":blob_id,"name":name,"mimeType":mime,"size":data.len(),"ingestStatus":"queued","ingestionId":Uuid::new_v4(),"attempts":0,"leaseUntil":0});
    let item = if let Some(mut item) = existing {
      if !self.replace(&item, &metadata).await? {
        return Err(AuthError::InvalidInput("context input changed before retry".into()));
      }
      item.metadata = metadata;
      item
    } else {
      self
        .copilot
        .add_context_item(context_id, CopilotContextItemType::Blob, blob_id.into(), metadata)
        .await?
    };
    self.dispatch(item).await
  }

  async fn fail(&self, item: &CopilotContextItem, code: &str) -> AuthResult<()> {
    let mut metadata = item.metadata.clone();
    metadata["ingestStatus"] = json!("failed");
    metadata["error"] = json!(code);
    metadata.as_object_mut().unwrap().remove("text");
    self.replace(item, &metadata).await?;
    Ok(())
  }

  async fn dispatch(&self, mut item: CopilotContextItem) -> AuthResult<CopilotContextItem> {
    let mut metadata = item.metadata.clone();
    metadata["ingestStatus"] = json!("queued");
    metadata["leaseUntil"] = json!(self.deadline(self.limits.dispatch_ms));
    if !self.replace(&item, &metadata).await? {
      return Err(AuthError::InvalidInput("context input changed before dispatch".into()));
    }
    item.metadata = metadata;
    let job = ContextIngestJob {
      context_id: item.context_id,
      item_id: item.id,
      blob_id: item.metadata["blobId"].as_str().ok_or_else(unavailable)?.into(),
      ingestion_id: serde_json::from_value(item.metadata["ingestionId"].clone()).map_err(|_| unavailable())?,
    };
    // The SQL item is the durable intent. A crash before/after enqueue is
    // recovered by this same queue's existing recovery callback.
    match self
      .queue
      .add_job(
        "copilot",
        "copilot.context.ingest",
        serde_json::to_value(job).map_err(|_| unavailable())?,
        Some(self.limits.max_attempts),
        None,
      )
      .await
    {
      Ok(_) => Ok(item),
      Err(_) => {
        self.fail(&item, "CONTEXT_DISPATCH_FAILED").await?;
        item.metadata["ingestStatus"] = json!("failed");
        item.metadata["error"] = json!("CONTEXT_DISPATCH_FAILED");
        Ok(item)
      }
    }
  }

  #[instrument(skip_all,fields(%context_id))]
  pub async fn retry(&self, user: Uuid, context_id: Uuid, file_ref: &str) -> AuthResult<CopilotContextItem> {
    self
      .retry_source(user, context_id, CopilotContextItemType::File, file_ref)
      .await
  }

  #[instrument(skip_all,fields(%context_id))]
  async fn retry_source(
    &self,
    user: Uuid,
    context_id: Uuid,
    item_type: CopilotContextItemType,
    item_ref: &str,
  ) -> AuthResult<CopilotContextItem> {
    self.authorize(context_id, Some(user), false).await?;
    let mut item = self
      .copilot
      .list_context_items(context_id)
      .await?
      .into_iter()
      .find(|item| item.item_type == item_type && item.item_ref == item_ref)
      .ok_or_else(unavailable)?;
    if item.metadata["ingestStatus"] != "failed" {
      return Ok(item);
    }
    let mut metadata = item.metadata.clone();
    metadata["ingestStatus"] = json!("queued");
    metadata["ingestionId"] = json!(Uuid::new_v4());
    metadata["attempts"] = json!(0);
    metadata["leaseUntil"] = json!(0);
    metadata.as_object_mut().unwrap().remove("error");
    if !self.replace(&item, &metadata).await? {
      return Err(AuthError::InvalidInput("context input changed before retry".into()));
    }
    item.metadata = metadata;
    self.dispatch(item).await
  }

  #[instrument(skip_all)]
  pub async fn recover(&self) -> AuthResult<()> {
    let due = self
      .copilot
      .repo
      .due_context_ingestions(Utc::now().timestamp_millis(), 100)
      .await
      .map_err(CopilotService::map_repo_err)?;
    for item in due {
      if item.metadata["attempts"].as_u64().unwrap_or(0) >= u64::from(self.limits.max_attempts) {
        self.fail(&item, "CONTEXT_ATTEMPTS_EXHAUSTED").await?;
        continue;
      }
      if self.authorize(item.context_id, None, false).await.is_err() {
        self.fail(&item, "CONTEXT_ACCESS_REVOKED").await?;
        continue;
      }
      // Lost CAS means another worker/removal already owns the transition.
      if let Err(error) = self.dispatch(item).await
        && !matches!(error, AuthError::InvalidInput(_))
      {
        return Err(error);
      }
    }
    Ok(())
  }

  #[instrument(skip_all,fields(context_id=%job.context_id,item_id=%job.item_id))]
  pub async fn execute(&self, job: ContextIngestJob) -> AuthResult<()> {
    let Some(mut item) = self
      .copilot
      .repo
      .get_copilot_context_item(job.item_id)
      .await
      .map_err(CopilotService::map_repo_err)?
    else {
      return Ok(());
    };
    if item.context_id != job.context_id
      || item.metadata["blobId"] != job.blob_id
      || item.metadata["ingestionId"] != json!(job.ingestion_id)
      || item.metadata["ingestStatus"] != "queued"
    {
      return Ok(());
    }
    if item.metadata["attempts"].as_u64().unwrap_or(0) >= u64::from(self.limits.max_attempts) {
      self.fail(&item, "CONTEXT_ATTEMPTS_EXHAUSTED").await?;
      return Ok(());
    }
    let context = match self.authorize(item.context_id, None, false).await {
      Ok(context) => context,
      Err(_) => {
        self.fail(&item, "CONTEXT_ACCESS_REVOKED").await?;
        return Ok(());
      }
    };
    if self
      .blobs
      .get_blob_metadata(context.workspace_id.ok_or_else(unavailable)?, &job.blob_id)
      .await?
      .is_none_or(|blob| blob.deleted_at.is_some())
    {
      self.fail(&item, "CONTEXT_INPUT_UNAVAILABLE").await?;
      return Ok(());
    }
    let mut running = item.metadata.clone();
    running["ingestStatus"] = json!("running");
    running["leaseUntil"] = json!(self.deadline(self.limits.timeout_ms.saturating_add(self.limits.dispatch_ms)));
    running["attempts"] = json!(running["attempts"].as_u64().unwrap_or(0) + 1);
    running["leaseId"] = json!(Uuid::new_v4());
    if !self.replace(&item, &running).await? {
      return Ok(());
    }
    item.metadata = running;
    let result = tokio::time::timeout(std::time::Duration::from_millis(self.limits.timeout_ms), async {
      let blob = self
        .blobs
        .get_blob_bounded(
          context.workspace_id.ok_or_else(unavailable)?,
          &job.blob_id,
          self.limits.max_input_bytes,
        )
        .await?;
      let mime = validated_mime(
        item.metadata["name"].as_str().unwrap_or(""),
        blob.content_type.as_deref(),
        &blob.data,
      )?;
      let detection = crate::mime_policy::detect_mime(&blob.data, format_name(mime), mime);
      if matches!(
        crate::mime_policy::evaluate_policy(&detection, &self.mime_policy),
        crate::mime_policy::MimePolicyDecision::Deny { .. }
      ) {
        return Err(unavailable());
      }
      self.parser.parse(blob.data, mime, self.limits).await
    })
    .await;
    let parsed = match result {
      Ok(Ok(parsed)) if !parsed.text.trim().is_empty() && parsed.text.len() <= self.limits.max_output_bytes => parsed,
      Ok(_) => {
        self.fail(&item, "CONTEXT_PARSE_FAILED").await?;
        return Ok(());
      }
      Err(_) => {
        self.fail(&item, "CONTEXT_PARSE_TIMEOUT").await?;
        return Ok(());
      }
    };
    if self.authorize(item.context_id, None, false).await.is_err() {
      self.fail(&item, "CONTEXT_ACCESS_REVOKED").await?;
      return Ok(());
    }
    if self
      .blobs
      .get_blob_metadata(context.workspace_id.ok_or_else(unavailable)?, &job.blob_id)
      .await?
      .is_none_or(|blob| blob.deleted_at.is_some())
    {
      self.fail(&item, "CONTEXT_INPUT_UNAVAILABLE").await?;
      return Ok(());
    }
    let mut ready = item.metadata.clone();
    ready["ingestStatus"] = json!("finished");
    ready["text"] = json!(parsed.text);
    ready["chunkSize"] = json!(parsed.chunk_count);
    ready.as_object_mut().unwrap().remove("error");
    self.replace(&item, &ready).await?;
    Ok(())
  }
}

fn validated_mime<'a>(name: &str, mime: Option<&'a str>, data: &[u8]) -> AuthResult<&'static str> {
  let hint = mime
    .unwrap_or("application/octet-stream")
    .split(';')
    .next()
    .unwrap_or_default()
    .trim();
  if data.starts_with(b"%PDF-") {
    return if matches!(hint, "application/pdf" | "application/octet-stream" | "") {
      Ok("application/pdf")
    } else {
      Err(AuthError::InvalidInput(
        "context PDF MIME type does not match its content".into(),
      ))
    };
  }
  let ext = name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
  let text_mime = match hint {
    "text/plain" => Some("text/plain"),
    "text/csv" | "application/csv" => Some("text/csv"),
    "application/octet-stream" | "" => match ext.as_str() {
      "txt" => Some("text/plain"),
      "csv" => Some("text/csv"),
      _ => None,
    },
    _ => None,
  };
  if let Some(mime) = text_mime
    && std::str::from_utf8(data).is_ok()
    && !data.contains(&0)
  {
    return Ok(mime);
  }
  Err(AuthError::InvalidInput(
    "context files must contain PDF text, UTF-8 TXT or CSV".into(),
  ))
}

fn format_name(mime: &str) -> &'static str {
  match mime {
    "application/pdf" => "context.pdf",
    "text/csv" => "context.csv",
    _ => "context.txt",
  }
}
