//! Copilot helper functions for workspace file management, context operations,
//! and AI job lifecycle.
//!
//! These transport helpers delegate persistence to the Copilot and Workspace
//! capability owners; GraphQL remains responsible only for authentication,
//! authorization, input mapping and response projection.

use async_graphql::{Context, Result};
use chrono::Utc;
use myoxus_application::permission::AccessController;
use myoxus_application::workspace::{QuotaUpdate, UpdateWorkspace};
use myoxus_domain::entities::CopilotJobState;
use serde_json::json;
use std::sync::Arc;
use tracing::instrument;

use super::auth;
use super::{AiJobStatusType, CopilotWorkspaceFileType, TranscriptionResultType, ensure_authenticated_snapshot};

// ─── Workspace ignored docs ──────────────────────────────────────────────────

#[instrument(skip_all)]
pub(crate) async fn persist_workspace_ignored_docs(
  state: &Arc<crate::state::ApiState>,
  workspace_id: uuid::Uuid,
  ignored: &std::collections::BTreeSet<String>,
) -> Result<()> {
  let copilot = state.copilot();
  let existing = copilot
    .get_workspace_state(workspace_id)
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  let mut metadata = existing
    .as_ref()
    .map(|state| state.metadata.clone())
    .unwrap_or_else(|| json!({}));
  if !metadata.is_object() {
    metadata = json!({});
  }
  let timestamps = metadata
    .as_object_mut()
    .expect("metadata was normalized to an object")
    .entry("ignoredDocCreatedAt")
    .or_insert_with(|| json!({}));
  if !timestamps.is_object() {
    *timestamps = json!({});
  }
  let timestamps = timestamps.as_object_mut().expect("timestamp map was normalized");
  timestamps.retain(|doc_id, _| ignored.contains(doc_id));
  let now = Utc::now().to_rfc3339();
  for doc_id in ignored {
    timestamps.entry(doc_id.clone()).or_insert_with(|| json!(now.clone()));
  }
  let ignored_doc_ids = ignored
    .iter()
    .filter_map(|value| uuid::Uuid::parse_str(value).ok())
    .collect();
  copilot
    .upsert_workspace_state(workspace_id, ignored_doc_ids, metadata)
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  Ok(())
}

// ─── Copilot job management ──────────────────────────────────────────────────

#[instrument(skip_all)]
pub(crate) async fn create_copilot_system_job(
  state: &Arc<crate::state::ApiState>,
  job_type: &str,
  payload: serde_json::Value,
) -> Result<()> {
  state
    .copilot()
    .create_job(job_type.to_string(), None, None, payload)
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  Ok(())
}

#[instrument(skip_all)]
pub(crate) async fn fetch_transcription_job_for_owner(
  state: &Arc<crate::state::ApiState>,
  job_id: uuid::Uuid,
  user_id: uuid::Uuid,
  workspace_id: Option<uuid::Uuid>,
) -> Result<TranscriptionResultType> {
  let result = state
    .transcription_results()
    .query(
      myoxus_domain::transcription::TranscriptionResultQuery {
        user_id,
        workspace_id,
        job_id: Some(job_id),
        blob_id: None,
      },
      &state.permission_service(),
    )
    .await
    .map_err(crate::graphql::utils::map_gql_error)?
    .into_iter()
    .next()
    .ok_or_else(|| async_graphql::Error::new("job not found"))?;
  Ok(project_audio_job_result(result))
}

/// Both list and claim project the same stored content. Claim is readback only.
pub(crate) fn project_audio_job_result(
  result: myoxus_domain::transcription::AudioJobResult,
) -> TranscriptionResultType {
  let status = match result.job.state {
    CopilotJobState::Running | CopilotJobState::Claimed => AiJobStatusType::Running,
    CopilotJobState::Finished => AiJobStatusType::Finished,
    CopilotJobState::Failed => AiJobStatusType::Failed,
    CopilotJobState::Pending => AiJobStatusType::Pending,
  };
  let mut projected = TranscriptionResultType {
    id: result.job.id.to_string(),
    status,
    error_message: result.job.error_message.clone(),
    title: None,
    summary: None,
    actions: None,
    transcription: None,
    text: None,
    segments: None,
  };
  if let Some(stored) = result.transcript {
    projected.title = stored.title;
    projected.summary = stored.summary;
    projected.actions = stored.actions;
    let response = stored.response;
    let mut legacy = response
      .segments
      .iter()
      .map(|segment| super::TranscriptionItemType {
        start: segment.start_seconds.map(|value| value.to_string()).unwrap_or_default(),
        end: segment.end_seconds.map(|value| value.to_string()).unwrap_or_default(),
        speaker: segment.speaker.clone().unwrap_or_default(),
        transcription: segment.text.clone(),
      })
      .collect::<Vec<_>>();
    if legacy.is_empty() && !response.text.is_empty() {
      legacy.push(super::TranscriptionItemType {
        start: String::new(),
        end: String::new(),
        speaker: String::new(),
        transcription: response.text.clone(),
      });
    }
    projected.transcription = (!legacy.is_empty()).then_some(legacy);
    projected.text = Some(response.text);
    projected.segments = Some(
      response
        .segments
        .into_iter()
        .map(|segment| super::TranscriptionSegmentType {
          text: segment.text,
          start_seconds: segment.start_seconds,
          end_seconds: segment.end_seconds,
          speaker: segment.speaker,
        })
        .collect(),
    );
  }
  projected
}

// ─── Workspace feature toggle ───────────────────────────────────────────────

#[instrument(skip_all)]
pub(crate) async fn update_workspace_feature(
  ctx: &Context<'_>,
  workspace_id: String,
  feature: auth::FeatureType,
  enabled: bool,
) -> Result<bool> {
  let state = ctx
    .data::<Arc<crate::state::ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
  let workspace_uuid =
    uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
  state
    .permission_service()
    .assert(
      &myoxus_application::permission::WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      myoxus_domain::permission::WorkspaceAction::SettingsUpdate,
    )
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  let enable_ai = match feature {
    auth::FeatureType::AIEarlyAccess | auth::FeatureType::UnlimitedCopilot => Some(enabled),
    // These enum variants remain in GraphQL for persisted-client compatibility,
    // but they are not product capabilities in Myoxus and must never toggle
    // workspace behavior. Explicitly failing prevents frontend-only hiding from
    // becoming the de-facto billing/plan boundary.
    auth::FeatureType::FreePlan
    | auth::FeatureType::LifetimeProPlan
    | auth::FeatureType::ProPlan
    | auth::FeatureType::TeamPlan
    | auth::FeatureType::UnlimitedWorkspace => {
      tracing::warn!(
        workspace_id = %workspace_uuid,
        feature = ?feature,
        enabled,
        "rejected unsupported plan/quota workspace feature mutation"
      );
      return Err(async_graphql::Error::new("unsupported workspace feature capability"));
    }
    auth::FeatureType::Admin | auth::FeatureType::EarlyAccess | auth::FeatureType::Manager => {
      tracing::warn!(
        workspace_id = %workspace_uuid,
        feature = ?feature,
        enabled,
        "rejected non-workspace-scoped feature mutation"
      );
      return Err(async_graphql::Error::new(
        "feature is not a workspace-scoped capability",
      ));
    }
  };
  state
    .workspace()
    .update_workspace(
      workspace_uuid,
      UpdateWorkspace {
        enable_ai,
        storage_quota_update: QuotaUpdate::Unchanged,
        ..UpdateWorkspace::default()
      },
    )
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  Ok(true)
}

// ─── Workspace file management ──────────────────────────────────────────────

#[instrument(skip_all)]
pub(crate) async fn persist_workspace_file(
  ctx: &Context<'_>,
  workspace_id: String,
  file: CopilotWorkspaceFileType,
  add: bool,
) -> Result<()> {
  let state = ctx
    .data::<Arc<crate::state::ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
  let workspace_uuid =
    uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
  state
    .permission_service()
    .assert(
      &myoxus_application::permission::WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      myoxus_domain::permission::WorkspaceAction::Copilot,
    )
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  let copilot = state.copilot();
  let existing = copilot
    .get_workspace_state(workspace_uuid)
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  let ignored_doc_ids = existing
    .as_ref()
    .map(|state| state.ignored_doc_ids.clone())
    .unwrap_or_default();
  let mut metadata = existing.map(|state| state.metadata).unwrap_or_else(|| json!({}));
  if !metadata.is_object() {
    metadata = json!({});
  }
  let files = metadata
    .as_object_mut()
    .expect("metadata is Object — guarded by if-branch above")
    .entry("workspaceFiles")
    .or_insert_with(|| json!([]));
  let files_arr = files
    .as_array_mut()
    .ok_or_else(|| async_graphql::Error::new("invalid workspaceFiles metadata"))?;
  if add {
    files_arr.push(json!({
      "id": file.id,
      "blobId": file.blob_id,
      "name": file.name,
      "mimeType": file.mime_type,
      "createdAt": file.created_at,
    }));
  }
  copilot
    .upsert_workspace_state(workspace_uuid, ignored_doc_ids, metadata)
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  Ok(())
}

#[instrument(skip_all)]
pub(crate) async fn persist_workspace_file_removal(
  ctx: &Context<'_>,
  workspace_id: String,
  file_id: &str,
) -> Result<bool> {
  let state = ctx
    .data::<Arc<crate::state::ApiState>>()
    .map_err(|_| async_graphql::Error::new("ApiState missing"))?;
  let snapshot = ensure_authenticated_snapshot(ctx, state).await?;
  let workspace_uuid =
    uuid::Uuid::parse_str(&workspace_id).map_err(|_| async_graphql::Error::new("invalid workspace id"))?;
  state
    .permission_service()
    .assert(
      &myoxus_application::permission::WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      myoxus_domain::permission::WorkspaceAction::Copilot,
    )
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  let copilot = state.copilot();
  let Some(existing) = copilot
    .get_workspace_state(workspace_uuid)
    .await
    .map_err(crate::graphql::utils::map_gql_error)?
  else {
    return Ok(false);
  };
  let mut metadata = existing.metadata;
  let Some(files) = metadata
    .as_object_mut()
    .and_then(|obj| obj.get_mut("workspaceFiles"))
    .and_then(|v| v.as_array_mut())
  else {
    return Ok(false);
  };
  let before = files.len();
  files.retain(|item| item.get("id").and_then(|v| v.as_str()) != Some(file_id));
  if files.len() == before {
    return Ok(false);
  }
  copilot
    .upsert_workspace_state(workspace_uuid, existing.ignored_doc_ids, metadata)
    .await
    .map_err(crate::graphql::utils::map_gql_error)?;
  Ok(true)
}
