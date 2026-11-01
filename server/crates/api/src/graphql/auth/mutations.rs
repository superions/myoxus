//! Root authenticated GraphQL mutation resolver (`AuthMutation`).
//!
//! Wires together all mutation sub-objects (user, workspace, document, blob,
//! team, search, copilot, calendar, notifications) under a single `AuthMutation`
//! struct that is exposed on the schema's `Mutation` root after session
//! validation.

use myoxus_application::workspace::workspace_invite_url;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_graphql::{Context, ID, MaybeUndefined, Object, Result, Upload};
use bytes::Bytes;
use chrono::Utc;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use super::{database, workspace_automation, workspace_tags};

const EMAIL_RATE_LIMIT_SECONDS: u64 = 60;

fn email_rate_limit_key(user_id: Uuid, mutation: &'static str) -> String {
  format!("auth:email-mutation-cooldown:{mutation}:{user_id}")
}

fn email_rate_limit_error(remaining_seconds: u64) -> async_graphql::Error {
  async_graphql::Error::new(format!(
    "Too many requests. Please wait {remaining_seconds} seconds before retrying."
  ))
}

/// Enforce the existing per-user, per-mutation cooldown across every API node.
///
/// Redis is a required startup dependency. Coordination failures therefore
/// fail closed with the existing user-facing rate-limit contract rather than
/// allowing an email side effect from an uncoordinated node.
async fn check_email_rate_limit(state: &ApiState, user_id: Uuid, mutation: &'static str) -> Result<()> {
  let key = email_rate_limit_key(user_id, mutation);
  match state
    .redis_port()
    .setnx_string(&key, "1", Some(EMAIL_RATE_LIMIT_SECONDS))
    .await
  {
    Ok(true) => Ok(()),
    Ok(false) => {
      let remaining_seconds = match state.redis_port().ttl_seconds(&key).await {
        Ok(Some(ttl)) => ttl.max(1),
        Ok(None) => EMAIL_RATE_LIMIT_SECONDS,
        Err(error) => {
          warn!(
            user_id = %user_id,
            mutation,
            error = %error,
            "email mutation cooldown TTL unavailable; rejecting conservatively"
          );
          EMAIL_RATE_LIMIT_SECONDS
        }
      };
      Err(email_rate_limit_error(remaining_seconds))
    }
    Err(error) => {
      warn!(
        user_id = %user_id,
        mutation,
        error = %error,
        "email mutation cooldown unavailable; rejecting conservatively"
      );
      Err(email_rate_limit_error(EMAIL_RATE_LIMIT_SECONDS))
    }
  }
}

fn map_delete_status(status: AppPermanentDeleteStatus) -> DeleteDocumentPermanentlyStatusType {
  match status {
    AppPermanentDeleteStatus::Deleted => DeleteDocumentPermanentlyStatusType::Deleted,
    AppPermanentDeleteStatus::NotFound => DeleteDocumentPermanentlyStatusType::NotFound,
    AppPermanentDeleteStatus::Forbidden => DeleteDocumentPermanentlyStatusType::Forbidden,
    AppPermanentDeleteStatus::AlreadyDeleted => DeleteDocumentPermanentlyStatusType::AlreadyDeleted,
    AppPermanentDeleteStatus::NotTrashed => DeleteDocumentPermanentlyStatusType::NotTrashed,
    AppPermanentDeleteStatus::Failed => DeleteDocumentPermanentlyStatusType::Failed,
  }
}

fn map_delete_document_result(result: AppPermanentDeleteDocumentResult) -> DeleteDocumentPermanentlyResultType {
  DeleteDocumentPermanentlyResultType {
    client_doc_id: result.client_doc_id,
    resolved_doc_id: result.resolved_doc_id.map(|id| ID(id.to_string())),
    title: result.title,
    status: map_delete_status(result.status),
    reason: result.reason,
  }
}

fn map_delete_summary(summary: PermanentDeleteSummary) -> DeleteDocumentsPermanentlyPayload {
  DeleteDocumentsPermanentlyPayload {
    requested: summary.requested as i32,
    deleted: summary.deleted as i32,
    not_found: summary.not_found as i32,
    forbidden: summary.forbidden as i32,
    already_deleted: summary.already_deleted as i32,
    not_trashed: summary.not_trashed as i32,
    failed: summary.failed as i32,
    root_meta_removed: summary.root_meta_removed as i32,
    documents: summary.documents.into_iter().map(map_delete_document_result).collect(),
  }
}

fn workspace_import_service(
  state: &Arc<ApiState>,
) -> Result<Arc<myoxus_application::workspace_import::WorkspaceImportService>> {
  state
    .workspace_import_service()
    .ok_or_else(|| async_graphql::Error::new("workspace import service is not configured"))
}

fn parse_workspace_import_id(value: &ID) -> Result<Uuid> {
  Uuid::parse_str(value.as_str())
    .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace import id".to_string())))
}

fn map_workspace_import_result(
  record: myoxus_domain::workspace_import::WorkspaceImportRecord,
) -> Result<super::WorkspaceImportType> {
  super::map_workspace_import(record).map_err(|_| async_graphql::Error::new("workspace import projection is invalid"))
}

fn validate_workspace_import_manifest(
  source_size_bytes: i64,
  source_hash: &str,
  parts: &[super::WorkspaceImportPartManifestInput],
  max_upload_bytes: u64,
) -> myoxus_application::auth::AuthResult<()> {
  let part_bytes = myoxus_application::workspace_import::WORKSPACE_IMPORT_PART_BYTES as i64;
  if source_size_bytes < 1
    || source_size_bytes as u64 > max_upload_bytes
    || source_hash.len() != 64
    || !source_hash
      .bytes()
      .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
  {
    return Err(AuthError::InvalidInput(
      "workspace import source manifest is invalid".to_string(),
    ));
  }
  let expected_count = ((source_size_bytes + part_bytes - 1) / part_bytes) as usize;
  if parts.len() != expected_count {
    return Err(AuthError::InvalidInput(
      "workspace import part manifest is not contiguous".to_string(),
    ));
  }
  for (index, part) in parts.iter().enumerate() {
    let expected_size = (source_size_bytes - index as i64 * part_bytes).min(part_bytes);
    if part.part_number != index as i32 + 1
      || part.size_bytes != expected_size
      || part.content_hash.len() != 64
      || !part
        .content_hash
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
      return Err(AuthError::InvalidInput(
        "workspace import part manifest is invalid".to_string(),
      ));
    }
  }
  Ok(())
}

async fn record_permanent_delete_audit(
  state: &ApiState,
  actor_user_id: Uuid,
  actor_label: Option<String>,
  workspace_id: Uuid,
  mode: &'static str,
  summary: &PermanentDeleteSummary,
) {
  let target = if summary.documents.len() == 1 {
    summary
      .documents
      .first()
      .and_then(|doc| doc.resolved_doc_id)
      .map(|doc_id| AuditTarget::entity("document", doc_id, None::<String>))
      .unwrap_or_else(|| AuditTarget::entity("workspace", workspace_id, None::<String>))
  } else {
    AuditTarget::entity("workspace", workspace_id, None::<String>)
  };

  let mut event = AuditEvent::mutation(
    "document.delete_permanent",
    AuditCategory::Document,
    Some(target),
    AuditActor::user(actor_user_id, actor_label),
    Some(serde_json::json!({
      "requested": summary.requested,
      "rootMetaRemoved": summary.root_meta_removed,
    })),
    None,
  );
  event.metadata = Some(serde_json::json!({
    "workspaceId": workspace_id,
    "mode": mode,
    "deleted": summary.deleted,
    "notFound": summary.not_found,
    "forbidden": summary.forbidden,
    "alreadyDeleted": summary.already_deleted,
    "failed": summary.failed,
  }));
  state.audit_recorder().record(event).await;
}

use crate::graphql::utils::{map_gql_error, require_session, require_session_allow_unverified, resolve_doc_id};
use crate::state::ApiState;
use crate::websocket;
use myoxus_application::audit::{AuditActor, AuditCategory, AuditEvent, AuditTarget};
use myoxus_application::auth::{AuthError, UpdateAuthUser};
use myoxus_application::calendar::{
  CalendarEventUpsert, DeleteScope, NativeCreateInput, ReminderInput as NativeSvcReminderInput, UpdateScope,
};
use myoxus_application::comment::SelectionAnchor as SelectionAnchorModel;
use myoxus_application::doc::{
  PermanentDeleteDocumentResult as AppPermanentDeleteDocumentResult, PermanentDeleteMode, PermanentDeleteRequest,
  PermanentDeleteStatus as AppPermanentDeleteStatus, PermanentDeleteSummary,
};
use myoxus_application::metrics::MetricsCategory;
use myoxus_application::permission::{AccessController, DocResource, WorkspaceResource};
use myoxus_application::ports::BlobWriteRequest;
use myoxus_application::ports::blob::{BlobKey, BlobStatus};
use myoxus_application::workspace::UserWorkspaceSettingsInput;
use myoxus_domain::document_key::DocumentKey;
use myoxus_domain::entities::{CopilotAttachmentRef, WorkspaceRole as WorkspaceRoleModel};
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use myoxus_domain::repositories::{CalendarEventSourceAnchor, NativeEventReminderInput, NativeEventUpdate};

use super::calendar::{
  CalendarAccountObjectType, CalendarEventInput, CalendarEventInstanceType, CalendarEventTagType, CalendarEventType,
  CalendarIcsImportResult, CalendarProviderType, CalendarReminderStatusResult, CalendarRsvpStatus, ConflictResolution,
  CreateEventTagInput, CreateWorkspaceEventInput, InstanceEditScope, LinkCalDAVAccountInput, LinkCalendarAccountInput,
  NativeEventScope, UpdateCalendarAccountInput, UpdateCalendarEventInstanceInput, UpdateCalendarEventInstanceResult,
  UpdateEventTagInput, UpdateWorkspaceCalendarSettingsInput, UpdateWorkspaceCalendarsInput, UpdateWorkspaceEventInput,
  WorkspaceCalendarObjectType, WorkspaceCalendarSettingsType, map_calendar_account_object,
  map_calendar_event_for_workspace, map_calendar_event_from_owner, map_calendar_event_tag,
  map_workspace_calendar_object, map_workspace_calendar_settings, parse_subscription_id,
};
use super::{
  BlobUploadInitType, BlobUploadMethodType, BlobUploadPartInputType, BlobUploadedPartType, CommentCreateInput,
  CommentObjectType, CommentResolveInput, CommentType, CommentUpdateInput, CopilotHistoriesType,
  CreateChatMessageInput, CreateChatSessionInput, DeleteAccount, DeleteDocumentPermanentlyInput,
  DeleteDocumentPermanentlyResultType, DeleteDocumentPermanentlyStatusType, DeleteDocumentsPermanentlyInput,
  DeleteDocumentsPermanentlyPayload, DeleteSessionInput, EmptyWorkspaceTrashInput, GenerateAccessTokenInput,
  InviteLinkType, InviteResult, MentionInput, MutationRoot, PublicUserType, RemoveAvatar, ReplyCreateInput,
  ReplyObjectType, ReplyUpdateInput, RevealedAccessToken, SelectionAnchorInput, TemplateCatalogViewInput,
  UpdateChatSessionInput, UpdateUserInput, UpdateUserPreferencesInput, UpdateWorkspaceInput, UserPreferencesType,
  UserType, WorkbenchToolLayoutInput, WorkspaceDashboardLayoutInput, WorkspaceDocumentMetadataVisibilityInput,
  WorkspaceInviteLinkExpireTime, WorkspaceInviteLinkType, WorkspaceRole, WorkspaceType, assert_copilot_doc_access,
  assert_copilot_session_access, assert_copilot_workspace_access, map_copilot_history,
};

fn source_anchor_from_input(
  block_id: Option<String>,
  start_offset: Option<i32>,
  end_offset: Option<i32>,
  kind: Option<String>,
) -> Result<Option<CalendarEventSourceAnchor>> {
  let block_id = block_id
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string);
  let kind = kind
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string);
  if let Some(value) = start_offset
    && value < 0
  {
    return Err(map_gql_error(AuthError::InvalidInput(
      "sourceStartOffset must be >= 0".to_string(),
    )));
  }
  if let Some(value) = end_offset
    && value < 0
  {
    return Err(map_gql_error(AuthError::InvalidInput(
      "sourceEndOffset must be >= 0".to_string(),
    )));
  }
  if let (Some(start), Some(end)) = (start_offset, end_offset)
    && end < start
  {
    return Err(map_gql_error(AuthError::InvalidInput(
      "sourceEndOffset must be >= sourceStartOffset".to_string(),
    )));
  }
  if let Some(kind) = kind.as_deref()
    && !matches!(kind, "document" | "block" | "text_range")
  {
    return Err(map_gql_error(AuthError::InvalidInput(
      "sourceKind must be document, block or text_range".to_string(),
    )));
  }
  if block_id.is_none() && start_offset.is_none() && end_offset.is_none() && kind.is_none() {
    return Ok(None);
  }
  Ok(Some(CalendarEventSourceAnchor {
    block_id,
    start_offset,
    end_offset,
    kind,
  }))
}

fn optional_uuid_patch(value: MaybeUndefined<Option<String>>, field: &'static str) -> Result<Option<Option<Uuid>>> {
  match value {
    MaybeUndefined::Undefined => Ok(None),
    MaybeUndefined::Null | MaybeUndefined::Value(None) => Ok(Some(None)),
    MaybeUndefined::Value(Some(value)) => {
      if value.trim().is_empty() {
        return Err(map_gql_error(AuthError::InvalidInput(format!(
          "{field} must be null or a UUID"
        ))));
      }
      Uuid::parse_str(&value)
        .map(|id| Some(Some(id)))
        .map_err(|_| map_gql_error(AuthError::InvalidInput(format!("invalid {field}"))))
    }
  }
}

fn optional_string_patch(value: MaybeUndefined<Option<String>>) -> Option<Option<String>> {
  match value {
    MaybeUndefined::Undefined => None,
    MaybeUndefined::Null | MaybeUndefined::Value(None) => Some(None),
    MaybeUndefined::Value(Some(value)) => Some(Some(value)),
  }
}

fn assistance_mode_patch(
  value: MaybeUndefined<Option<super::AssistanceModeType>>,
) -> Option<Option<myoxus_application::auth::AssistanceMode>> {
  match value {
    MaybeUndefined::Undefined => None,
    MaybeUndefined::Null | MaybeUndefined::Value(None) => Some(None),
    MaybeUndefined::Value(Some(value)) => Some(Some(value.into())),
  }
}

fn scoped_assistance_mode(
  value: MaybeUndefined<Option<super::AssistanceModeType>>,
) -> Result<Option<myoxus_application::auth::AssistanceMode>> {
  assistance_mode_patch(value).ok_or_else(|| {
    map_gql_error(AuthError::InvalidInput(
      "scoped assistance mode must be supplied or null".into(),
    ))
  })
}

fn assistance_scope_id(value: &ID) -> Result<Uuid> {
  Uuid::parse_str(value.as_str())
    .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid assistance scope UUID".into())))
}

fn source_external_id_input(
  source_external_id: MaybeUndefined<Option<String>>,
  legacy_source_doc_id: MaybeUndefined<Option<String>>,
) -> Result<MaybeUndefined<Option<String>>> {
  match (source_external_id, legacy_source_doc_id) {
    (MaybeUndefined::Undefined, MaybeUndefined::Undefined) => Ok(MaybeUndefined::Undefined),
    (MaybeUndefined::Undefined, legacy_source_doc_id) => Ok(legacy_source_doc_id),
    (source_external_id, MaybeUndefined::Undefined) => Ok(source_external_id),
    _ => Err(map_gql_error(AuthError::InvalidInput(
      "sourceExternalId and sourceDocId cannot be supplied together".to_string(),
    ))),
  }
}

fn optional_i32_patch(value: MaybeUndefined<Option<i32>>) -> Option<Option<i32>> {
  match value {
    MaybeUndefined::Undefined => None,
    MaybeUndefined::Null | MaybeUndefined::Value(None) => Some(None),
    MaybeUndefined::Value(Some(value)) => Some(Some(value)),
  }
}

fn optional_bool_patch(value: MaybeUndefined<Option<bool>>) -> Option<Option<bool>> {
  match value {
    MaybeUndefined::Undefined => None,
    MaybeUndefined::Null | MaybeUndefined::Value(None) => Some(None),
    MaybeUndefined::Value(Some(value)) => Some(Some(value)),
  }
}

type DocumentMetadataVisibilityByWorkspace = HashMap<Uuid, HashMap<String, bool>>;

fn optional_document_metadata_visibility_patch(
  value: MaybeUndefined<Option<Vec<WorkspaceDocumentMetadataVisibilityInput>>>,
) -> Result<Option<Option<DocumentMetadataVisibilityByWorkspace>>> {
  let MaybeUndefined::Value(Some(workspaces)) = value else {
    return Ok(match value {
      MaybeUndefined::Undefined => None,
      MaybeUndefined::Null | MaybeUndefined::Value(None) => Some(None),
      MaybeUndefined::Value(Some(_)) => unreachable!(),
    });
  };
  let mut result = HashMap::new();
  for workspace in workspaces {
    let workspace_id = Uuid::parse_str(workspace.workspace_id.as_str())
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspaceId".to_string())))?;
    let mut fields = HashMap::new();
    for field in workspace.fields {
      if fields.insert(field.field, field.visible).is_some() {
        return Err(map_gql_error(AuthError::InvalidInput(
          "duplicate document metadata visibility field".to_string(),
        )));
      }
    }
    if result.insert(workspace_id, fields).is_some() {
      return Err(map_gql_error(AuthError::InvalidInput(
        "duplicate document metadata visibility workspace".to_string(),
      )));
    }
  }
  Ok(Some(Some(result)))
}

fn optional_template_catalog_views_patch(
  value: MaybeUndefined<Option<Vec<TemplateCatalogViewInput>>>,
) -> Result<Option<Option<HashMap<Uuid, String>>>> {
  let MaybeUndefined::Value(Some(views)) = value else {
    return Ok(match value {
      MaybeUndefined::Undefined => None,
      _ => Some(None),
    });
  };
  let mut result = HashMap::new();
  for entry in views {
    let id = Uuid::parse_str(entry.workspace_id.as_str())
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspaceId".into())))?;
    if result.insert(id, entry.view).is_some() {
      return Err(map_gql_error(AuthError::InvalidInput(
        "duplicate templateCatalogViews workspace".into(),
      )));
    }
  }
  Ok(Some(Some(result)))
}

fn optional_workbench_tool_layouts_patch(
  value: MaybeUndefined<Option<Vec<WorkbenchToolLayoutInput>>>,
) -> Result<Option<Option<Vec<myoxus_application::auth::WorkbenchToolLayout>>>> {
  let MaybeUndefined::Value(Some(layouts)) = value else {
    return Ok(match value {
      MaybeUndefined::Undefined => None,
      MaybeUndefined::Null | MaybeUndefined::Value(None) => Some(None),
      MaybeUndefined::Value(Some(_)) => unreachable!(),
    });
  };
  layouts
    .into_iter()
    .map(|layout| {
      let workspace_id = Uuid::parse_str(layout.workspace_id.as_str())
        .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspaceId".to_string())))?;
      Ok(myoxus_application::auth::WorkbenchToolLayout {
        workspace_id,
        view_family: layout.view_family.into(),
        ordered_tool_ids: layout.ordered_tool_ids.into_iter().map(Into::into).collect(),
        visible_tool_ids: layout.visible_tool_ids.into_iter().map(Into::into).collect(),
        collapsed_tool_ids: layout.collapsed_tool_ids.into_iter().map(Into::into).collect(),
      })
    })
    .collect::<Result<Vec<_>>>()
    .map(|layouts| Some(Some(layouts)))
}

fn optional_workspace_dashboard_layouts_patch(
  value: MaybeUndefined<Option<Vec<WorkspaceDashboardLayoutInput>>>,
) -> Result<Option<Option<Vec<myoxus_application::auth::WorkspaceDashboardLayout>>>> {
  let MaybeUndefined::Value(Some(layouts)) = value else {
    return Ok(match value {
      MaybeUndefined::Undefined => None,
      MaybeUndefined::Null | MaybeUndefined::Value(None) => Some(None),
      MaybeUndefined::Value(Some(_)) => unreachable!(),
    });
  };
  layouts
    .into_iter()
    .map(|layout| {
      let workspace_id = Uuid::parse_str(layout.workspace_id.as_str())
        .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspaceId".to_string())))?;
      Ok(myoxus_application::auth::WorkspaceDashboardLayout {
        workspace_id,
        ordered_dashlet_ids: layout.ordered_dashlet_ids.into_iter().map(Into::into).collect(),
        dashlet_sizes: layout
          .dashlet_sizes
          .into_iter()
          .map(
            |value| myoxus_application::auth::WorkspaceDashboardDashletSizeOverride {
              dashlet_id: value.dashlet_id.into(),
              size: value.size.into(),
            },
          )
          .collect(),
      })
    })
    .collect::<Result<Vec<_>>>()
    .map(|layouts| Some(Some(layouts)))
}

/// Enforce MIME policy on upload bytes, returning a GraphQL-compatible error on denial.
///
/// Reads MIME policy from the universal live configuration snapshot. Returns
/// `Ok(())` for Allow/Warn and `Err` for Deny.
async fn enforce_mime_policy_gql(
  state: &ApiState,
  bytes: &[u8],
  file_name: &str,
  declared_mime: &str,
) -> Result<(), async_graphql::Error> {
  use myoxus_application::mime_policy::{MimePolicyDecision, detect_mime, evaluate_policy};
  use myoxus_infrastructure::mime_policy_config::{MimePolicyFallback, resolve_mime_policy_config};

  let effective = state.effective_config().await;
  let fallback = MimePolicyFallback {
    allowlist: &effective.base.git_sync.mime_allowlist_admin,
    blocklist: &effective.base.git_sync.mime_blocklist_admin,
    validation_mode: &effective.base.git_sync.mime_validation_mode,
  };
  let config = resolve_mime_policy_config(&effective.overrides.overrides, &fallback);

  let detection = detect_mime(bytes, file_name, declared_mime);
  let decision = evaluate_policy(&detection, &config);

  match decision {
    MimePolicyDecision::Allow | MimePolicyDecision::Warn { .. } => Ok(()),
    MimePolicyDecision::Deny { reason } => {
      warn!(
        file_name = file_name,
        effective_mime = %detection.effective_mime,
        confidence = %detection.confidence,
        reason = %reason,
        "MIME policy denied upload"
      );
      Err(map_gql_error(myoxus_application::auth::AuthError::InvalidInput(
        format!(
          "Upload denied: {} (detected MIME: {}, confidence: {})",
          reason, detection.effective_mime, detection.confidence
        ),
      )))
    }
  }
}

// append_query_params is defined in crate::graphql::config and re-exported via mod.rs.
use crate::graphql::config::append_query_params;

/// SC-M-02: Validate that a client-supplied callback URL belongs to the
/// configured server origin to prevent open-redirect / phishing attacks.
fn validate_callback_url(callback_url: &str, server_origin: &str) -> Result<(), async_graphql::Error> {
  let normalized_origin = server_origin.trim_end_matches('/');
  let normalized_callback = callback_url.trim();
  if let Some(rest) = normalized_callback.strip_prefix(normalized_origin) {
    // Ensure the match is at a path boundary (origin + "/" or origin + "?"),
    // not a prefix like "https://example.com.evil.com".
    if rest.is_empty() || rest.starts_with('/') || rest.starts_with('?') {
      return Ok(());
    }
  }
  warn!("callback URL rejected because it does not match the server origin");
  Err(map_gql_error(AuthError::InvalidInput(
    "callback_url must start with the server origin".to_string(),
  )))
}

#[instrument(skip_all)]
async fn send_password_email(
  ctx: &Context<'_>,
  callback_url: Option<String>,
  email: Option<String>,
  template: myoxus_application::ports::MailTemplate,
) -> Result<bool> {
  let (state, snapshot) = require_session(ctx).await?;
  check_email_rate_limit(state.as_ref(), snapshot.user.id, "send_change_password_email").await?;

  if snapshot.user.email_verified_at.is_none() {
    return Err(map_gql_error(AuthError::ActionForbidden));
  }

  let server_origin = state.effective_config().await.server_origin();
  let url = state
    .auth()
    .create_password_reset_link(snapshot.user.id, &server_origin, callback_url.as_deref())
    .await
    .map_err(map_gql_error)?;
  // SC-C-02: Always send to the authenticated user's own email.
  // Ignoring the `email` parameter prevents an attacker from redirecting
  // password-reset emails to an attacker-controlled address.
  if email.is_some() {
    tracing::warn!(
      user_id = %snapshot.user.id,
      "send_change_password_email: ignoring caller-supplied email, using authenticated user email"
    );
  }
  let mail = state
    .auth()
    .prepare_mail_for_user(
      Some(snapshot.user.id),
      &snapshot.user.email,
      template,
      serde_json::json!({"url":url.url}),
    )
    .await
    .map_err(map_gql_error)?;
  state
    .auth()
    .mailer
    .send_template(mail)
    .await
    .map_err(|e| map_gql_error(AuthError::Storage(e.to_string())))?;
  Ok(true)
}

#[Object]
impl MutationRoot {
  /// Build and persist one server-authoritative XWS preflight.
  #[instrument(skip_all)]
  pub(crate) async fn workspace_content_preflight(
    &self,
    ctx: &Context<'_>,
    input: super::WorkspaceContentPreflightInput,
  ) -> Result<super::WorkspaceContentPreflightType> {
    let (state, snapshot) = require_session(ctx).await?;
    let service = state
      .workspace_content_control_service()
      .ok_or_else(|| async_graphql::Error::new("workspace content operations are unavailable"))?;
    let (idempotency_id, request) = input
      .into_request(snapshot.user.id)
      .map_err(super::workspace_content_operation::map_workspace_content_error)?;
    let result = service
      .preflight(snapshot.user.id, idempotency_id, request)
      .await
      .map_err(super::workspace_content_operation::map_workspace_content_error)?;
    super::WorkspaceContentPreflightType::from_result(result, None)
      .map_err(super::workspace_content_operation::map_workspace_content_error)
  }

  /// Execute exactly the current preflight revision and confirmation set.
  #[instrument(skip_all)]
  pub(crate) async fn execute_workspace_content_operation(
    &self,
    ctx: &Context<'_>,
    input: super::WorkspaceContentExecuteInput,
  ) -> Result<super::WorkspaceContentOperationType> {
    let (state, snapshot) = require_session(ctx).await?;
    let service = state
      .workspace_content_control_service()
      .ok_or_else(|| async_graphql::Error::new("workspace content operations are unavailable"))?;
    let confirmations = input
      .confirmations
      .into_iter()
      .map(super::WorkspaceContentConfirmationInput::into_domain)
      .collect::<myoxus_application::auth::AuthResult<Vec<_>>>()
      .inspect_err(|error| {
        if let AuthError::InvalidInput(value) = error
          && let Some(cause) = myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode::parse(value)
        {
          tracing::error!(operation_id = %input.operation_id, phase = "request_validation",
            cause = cause.as_str(), error_kind = "confirmation_invalid",
            "workspace_content.request_rejected");
        }
      })
      .map_err(super::workspace_content_operation::map_workspace_content_error)?;
    service
      .execute(input.operation_id, snapshot.user.id, input.revision, confirmations)
      .await
      .map_err(super::workspace_content_operation::map_workspace_content_error)?;
    service
      .status(input.operation_id, snapshot.user.id)
      .await
      .map(super::WorkspaceContentOperationType::from_projection)
      .map_err(super::workspace_content_operation::map_workspace_content_error)
  }

  /// Cancel an actor-owned operation before canonical publication.
  #[instrument(skip_all)]
  pub(crate) async fn cancel_workspace_content_operation(
    &self,
    ctx: &Context<'_>,
    operation_id: Uuid,
  ) -> Result<super::WorkspaceContentOperationType> {
    let (state, snapshot) = require_session(ctx).await?;
    let service = state
      .workspace_content_control_service()
      .ok_or_else(|| async_graphql::Error::new("workspace content operations are unavailable"))?;
    service
      .cancel(operation_id, snapshot.user.id)
      .await
      .map_err(super::workspace_content_operation::map_workspace_content_error)?;
    service
      .status(operation_id, snapshot.user.id)
      .await
      .map(super::WorkspaceContentOperationType::from_projection)
      .map_err(super::workspace_content_operation::map_workspace_content_error)
  }

  /// Re-authorize failed content work or a successful Extract's pending Git work.
  #[instrument(skip_all)]
  pub(crate) async fn retry_workspace_content_operation(
    &self,
    ctx: &Context<'_>,
    operation_id: Uuid,
  ) -> Result<super::WorkspaceContentOperationType> {
    let (state, snapshot) = require_session(ctx).await?;
    let service = state
      .workspace_content_control_service()
      .ok_or_else(|| async_graphql::Error::new("workspace content operations are unavailable"))?;
    service
      .retry(operation_id, snapshot.user.id)
      .await
      .map_err(super::workspace_content_operation::map_workspace_content_error)?;
    service
      .status(operation_id, snapshot.user.id)
      .await
      .map(super::WorkspaceContentOperationType::from_projection)
      .map_err(super::workspace_content_operation::map_workspace_content_error)
  }

  /// Preflight an Undo as a new correlated counter-operation.
  #[instrument(skip_all)]
  pub(crate) async fn undo_workspace_content_operation(
    &self,
    ctx: &Context<'_>,
    origin_operation_id: Uuid,
    idempotency_id: Uuid,
  ) -> Result<super::WorkspaceContentPreflightType> {
    let (state, snapshot) = require_session(ctx).await?;
    let service = state
      .workspace_content_control_service()
      .ok_or_else(|| async_graphql::Error::new("workspace content operations are unavailable"))?;
    let result = service
      .undo_preflight(snapshot.user.id, origin_operation_id, idempotency_id)
      .await
      .map_err(super::workspace_content_operation::map_workspace_content_error)?;
    super::WorkspaceContentPreflightType::from_result(result, Some(origin_operation_id))
      .map_err(super::workspace_content_operation::map_workspace_content_error)
  }

  /// Migrate persisted editor-local Databases through the canonical service.
  #[instrument(skip_all)]
  pub(crate) async fn apply_legacy_database_migration(
    &self,
    ctx: &Context<'_>,
    input: database::LegacyDatabaseMigrationInput,
  ) -> Result<database::LegacyDatabaseMigrationApplyObjectType> {
    database::apply_legacy_database_migration(ctx, input).await
  }

  #[instrument(skip_all)]
  pub(crate) async fn create_workspace_import_upload(
    &self,
    ctx: &Context<'_>,
    source_size_bytes: i64,
    source_hash: String,
    parts: Vec<super::WorkspaceImportPartManifestInput>,
    source_format: Option<super::WorkspaceImportSourceFormatInput>,
  ) -> Result<super::WorkspaceImportUploadType> {
    let (state, snapshot) = require_session(ctx).await?;
    let service = state
      .workspace_import_service()
      .ok_or_else(|| async_graphql::Error::new("workspace import service is not configured"))?;
    let policy = service.current_policy().await;
    validate_workspace_import_manifest(source_size_bytes, &source_hash, &parts, policy.limits.max_upload_bytes)
      .map_err(map_gql_error)?;
    let upload = service
      .create_upload_as(snapshot.user.id, source_format.map(Into::into))
      .await
      .map_err(map_gql_error)?;
    let ttl = (upload.expires_at - Utc::now()).num_seconds().clamp(1, 3_600) as u64;
    let signed_parts = parts
      .into_iter()
      .map(|part| {
        let upload_url = state
          .blob()
          .create_signed_workspace_import_part_upload_url(
            "/api/workspace-import/upload-part",
            snapshot.user.id,
            upload.import_id,
            part.part_number,
            part.size_bytes,
            &part.content_hash,
            ttl,
          )
          .map_err(map_gql_error)?;
        Ok(super::WorkspaceImportPartUploadType {
          part_number: part.part_number,
          size_bytes: part.size_bytes,
          content_hash: part.content_hash,
          upload_url,
        })
      })
      .collect::<Result<Vec<_>>>()?;
    Ok(super::WorkspaceImportUploadType {
      workspace_import_id: ID(upload.import_id.to_string()),
      part_size_bytes: myoxus_application::workspace_import::WORKSPACE_IMPORT_PART_BYTES as i64,
      expires_at: upload.expires_at,
      parts: signed_parts,
    })
  }

  #[instrument(skip_all)]
  pub(crate) async fn complete_workspace_import_upload(
    &self,
    ctx: &Context<'_>,
    workspace_import_id: ID,
    source_size_bytes: i64,
    source_hash: String,
  ) -> Result<super::WorkspaceImportType> {
    let (state, snapshot) = require_session(ctx).await?;
    let import_id = parse_workspace_import_id(&workspace_import_id)?;
    let service = workspace_import_service(&state)?;
    let record = service
      .complete_upload(snapshot.user.id, import_id, source_size_bytes, &source_hash)
      .await
      .map_err(map_gql_error)?;
    map_workspace_import_result(record)
  }

  #[instrument(skip_all)]
  pub(crate) async fn preview_workspace_import(
    &self,
    ctx: &Context<'_>,
    workspace_import_id: ID,
  ) -> Result<super::WorkspaceImportType> {
    let (state, snapshot) = require_session(ctx).await?;
    let record = workspace_import_service(&state)?
      .queue_preview(snapshot.user.id, parse_workspace_import_id(&workspace_import_id)?)
      .await
      .map_err(map_gql_error)?;
    map_workspace_import_result(record)
  }

  #[instrument(skip_all)]
  pub(crate) async fn apply_workspace_import(
    &self,
    ctx: &Context<'_>,
    workspace_import_id: ID,
  ) -> Result<super::WorkspaceImportType> {
    let (state, snapshot) = require_session(ctx).await?;
    let record = workspace_import_service(&state)?
      .queue_apply(snapshot.user.id, parse_workspace_import_id(&workspace_import_id)?)
      .await
      .map_err(map_gql_error)?;
    map_workspace_import_result(record)
  }

  #[instrument(skip_all)]
  pub(crate) async fn cancel_workspace_import(
    &self,
    ctx: &Context<'_>,
    workspace_import_id: ID,
  ) -> Result<super::WorkspaceImportType> {
    let (state, snapshot) = require_session(ctx).await?;
    let record = workspace_import_service(&state)?
      .cancel(snapshot.user.id, parse_workspace_import_id(&workspace_import_id)?)
      .await
      .map_err(map_gql_error)?;
    map_workspace_import_result(record)
  }

  #[instrument(skip_all)]
  pub(crate) async fn retry_workspace_import_cleanup(
    &self,
    ctx: &Context<'_>,
    workspace_import_id: ID,
  ) -> Result<super::WorkspaceImportType> {
    let (state, snapshot) = require_session(ctx).await?;
    if !snapshot.user.is_admin {
      return Err(map_gql_error(AuthError::ActionForbidden));
    }
    let import_id = parse_workspace_import_id(&workspace_import_id)?;
    let record = workspace_import_service(&state)?
      .retry_cleanup(import_id)
      .await
      .map_err(map_gql_error)?;
    state
      .audit_recorder()
      .record(AuditEvent::mutation(
        "workspace_import.cleanup.retry",
        AuditCategory::Workspace,
        Some(AuditTarget::entity("workspace_import", import_id, None::<String>)),
        AuditActor::user(snapshot.user.id, Some(snapshot.user.email.clone())),
        None,
        Some(serde_json::json!({ "status": record.status.as_str() })),
      ))
      .await;
    map_workspace_import_result(record)
  }

  #[instrument(skip_all)]
  pub(crate) async fn delete_document_permanently(
    &self,
    ctx: &Context<'_>,
    input: DeleteDocumentPermanentlyInput,
  ) -> Result<DeleteDocumentsPermanentlyPayload> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(input.workspace_id.as_str()).map_err(|_| "Invalid workspace id")?;
    let document_key =
      DocumentKey::parse(input.doc_id.clone()).map_err(|e| map_gql_error(AuthError::InvalidInput(e)))?;
    let doc_id = state
      .doc()
      .resolve_document_key(
        workspace_uuid,
        myoxus_application::doc::DocSpaceKind::Workspace,
        &document_key,
      )
      .await
      .map_err(map_gql_error)?
      .unwrap_or(Uuid::nil());

    state
      .permission_service()
      .assert(
        &DocResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
          doc_id,
        },
        DocAction::Delete,
      )
      .await
      .map_err(map_gql_error)?;

    let summary = state
      .doc()
      .permanently_delete_documents(PermanentDeleteRequest {
        workspace_id: workspace_uuid,
        actor_user_id: Some(snapshot.user.id),
        mode: PermanentDeleteMode::SelectedDocs,
        doc_ids: vec![input.doc_id],
      })
      .await
      .map_err(map_gql_error)?;
    state.metrics().record(
      MetricsCategory::Doc,
      "doc_deleted_permanent",
      &[("source", "graphql"), ("mode", "single")],
    );
    record_permanent_delete_audit(
      state.as_ref(),
      snapshot.user.id,
      Some(snapshot.user.email),
      workspace_uuid,
      "single",
      &summary,
    )
    .await;
    crate::websocket::publish_workspace_doc_deletions(state.as_ref(), workspace_uuid, &summary).await;
    Ok(map_delete_summary(summary))
  }

  #[instrument(skip_all)]
  pub(crate) async fn delete_documents_permanently(
    &self,
    ctx: &Context<'_>,
    input: DeleteDocumentsPermanentlyInput,
  ) -> Result<DeleteDocumentsPermanentlyPayload> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(input.workspace_id.as_str()).map_err(|_| "Invalid workspace id")?;
    if input.doc_ids.is_empty() {
      return Err(map_gql_error(AuthError::InvalidInput(
        "docIds must not be empty".to_string(),
      )));
    }

    for external_id in &input.doc_ids {
      let document_key =
        DocumentKey::parse(external_id.clone()).map_err(|e| map_gql_error(AuthError::InvalidInput(e)))?;
      let doc_id = state
        .doc()
        .resolve_document_key(
          workspace_uuid,
          myoxus_application::doc::DocSpaceKind::Workspace,
          &document_key,
        )
        .await
        .map_err(map_gql_error)?
        .unwrap_or(Uuid::nil());
      state
        .permission_service()
        .assert(
          &DocResource {
            user_id: snapshot.user.id,
            workspace_id: workspace_uuid,
            doc_id,
          },
          DocAction::Delete,
        )
        .await
        .map_err(map_gql_error)?;
    }

    let summary = state
      .doc()
      .permanently_delete_documents(PermanentDeleteRequest {
        workspace_id: workspace_uuid,
        actor_user_id: Some(snapshot.user.id),
        mode: PermanentDeleteMode::SelectedDocs,
        doc_ids: input.doc_ids,
      })
      .await
      .map_err(map_gql_error)?;
    state.metrics().record(
      MetricsCategory::Doc,
      "doc_deleted_permanent",
      &[("source", "graphql"), ("mode", "bulk")],
    );
    record_permanent_delete_audit(
      state.as_ref(),
      snapshot.user.id,
      Some(snapshot.user.email),
      workspace_uuid,
      "bulk",
      &summary,
    )
    .await;
    crate::websocket::publish_workspace_doc_deletions(state.as_ref(), workspace_uuid, &summary).await;
    Ok(map_delete_summary(summary))
  }

  #[instrument(skip_all)]
  pub(crate) async fn empty_workspace_trash(
    &self,
    ctx: &Context<'_>,
    input: EmptyWorkspaceTrashInput,
  ) -> Result<DeleteDocumentsPermanentlyPayload> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(input.workspace_id.as_str()).map_err(|_| "Invalid workspace id")?;

    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::CreateDoc,
      )
      .await
      .map_err(map_gql_error)?;

    let summary = state
      .doc()
      .permanently_delete_documents(PermanentDeleteRequest {
        workspace_id: workspace_uuid,
        actor_user_id: Some(snapshot.user.id),
        mode: PermanentDeleteMode::AllTrashed,
        doc_ids: input.client_visible_doc_ids.unwrap_or_default(),
      })
      .await
      .map_err(map_gql_error)?;
    state.metrics().record(
      MetricsCategory::Doc,
      "doc_deleted_permanent",
      &[("source", "graphql"), ("mode", "empty_trash")],
    );
    record_permanent_delete_audit(
      state.as_ref(),
      snapshot.user.id,
      Some(snapshot.user.email),
      workspace_uuid,
      "empty_trash",
      &summary,
    )
    .await;
    crate::websocket::publish_workspace_doc_deletions(state.as_ref(), workspace_uuid, &summary).await;
    Ok(map_delete_summary(summary))
  }

  #[instrument(skip_all)]
  pub(crate) async fn change_password(
    &self,
    ctx: &Context<'_>,
    token: String,
    new_password: String,
    // API-C-01: user_id parameter is accepted for GraphQL schema compatibility
    // but intentionally ignored — the user_id is extracted from the token's DB
    // record to prevent an attacker from changing another user's password.
    user_id: Option<String>,
  ) -> Result<bool> {
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "Internal error")?;
    if user_id.is_some() {
      tracing::warn!(
        supplied_user_id = ?user_id,
        "change_password: ignoring client-supplied user_id, using token-bound user_id"
      );
    }
    state
      .auth()
      .change_password(&token, &new_password)
      .await
      .map_err(map_gql_error)?;
    // NOTE: user_id is not available here — it is bound to the token server-side.
    info!("successfully changed password via graphql");
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn send_change_password_email(
    &self,
    ctx: &Context<'_>,
    callback_url: Option<String>,
    email: Option<String>,
  ) -> Result<bool> {
    send_password_email(
      ctx,
      callback_url,
      email,
      myoxus_application::ports::MailTemplate::PasswordReset,
    )
    .await
  }

  #[instrument(skip_all)]
  pub(crate) async fn send_set_password_email(
    &self,
    ctx: &Context<'_>,
    callback_url: Option<String>,
    email: Option<String>,
  ) -> Result<bool> {
    send_password_email(
      ctx,
      callback_url,
      email,
      myoxus_application::ports::MailTemplate::SetPassword,
    )
    .await
  }

  #[instrument(skip_all)]
  pub(crate) async fn send_change_email(
    &self,
    ctx: &Context<'_>,
    callback_url: String,
    email: Option<String>,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    check_email_rate_limit(state.as_ref(), snapshot.user.id, "send_change_email").await?;
    validate_callback_url(&callback_url, &state.config.server.origin)?;

    if snapshot.user.email_verified_at.is_none() {
      return Err(map_gql_error(AuthError::ActionForbidden));
    }

    let token = Uuid::new_v4().to_string();
    state
      .auth()
      .store
      .create_verification_token(
        Some(snapshot.user.id),
        "ChangeEmail",
        &token,
        None,
        Utc::now() + chrono::Duration::minutes(30),
        None,
      )
      .await
      .map_err(map_gql_error)?;

    let url = append_query_params(&callback_url, &[("token", token)]);
    let target_email = email.unwrap_or(snapshot.user.email);
    let mail = state
      .auth()
      .prepare_mail_for_user(
        Some(snapshot.user.id),
        &target_email,
        myoxus_application::ports::MailTemplate::ChangeEmail,
        serde_json::json!({"url":url}),
      )
      .await
      .map_err(map_gql_error)?;
    state
      .auth()
      .mailer
      .send_template(mail)
      .await
      .map_err(|e| map_gql_error(AuthError::Storage(e.to_string())))?;
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn send_verify_change_email(
    &self,
    ctx: &Context<'_>,
    token: String,
    email: String,
    callback_url: String,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    check_email_rate_limit(state.as_ref(), snapshot.user.id, "send_verify_change_email").await?;
    validate_callback_url(&callback_url, &state.config.server.origin)?;

    let Some(vt) = state
      .auth()
      .store
      .find_verification_token("ChangeEmail", &token, Some(snapshot.user.id))
      .await
      .map_err(map_gql_error)?
    else {
      return Err(map_gql_error(AuthError::InvalidToken));
    };
    if vt.used_at.is_some() {
      return Err(map_gql_error(AuthError::InvalidToken));
    }
    if vt.expires_at <= Utc::now() {
      return Err(map_gql_error(AuthError::ExpiredToken));
    }

    // SC-L-04: URL-decode email for consistency with change_email endpoint.
    let decoded_email = urlencoding::decode(&email).map(|s| s.to_string()).unwrap_or(email);

    if let Some(existing) = state
      .auth()
      .store
      .get_user_by_email(&decoded_email)
      .await
      .map_err(map_gql_error)?
    {
      if existing.id != snapshot.user.id {
        return Err(map_gql_error(AuthError::ActionForbidden));
      } else {
        return Err(map_gql_error(AuthError::InvalidInput(
          "same email provided".to_string(),
        )));
      }
    }

    let verify_token = Uuid::new_v4().to_string();
    state
      .auth()
      .store
      .create_verification_token(
        Some(snapshot.user.id),
        "VerifyEmail",
        &verify_token,
        None,
        Utc::now() + chrono::Duration::minutes(30),
        None,
      )
      .await
      .map_err(map_gql_error)?;

    let url = append_query_params(
      &callback_url,
      &[("token", verify_token), ("email", decoded_email.clone())],
    );
    // The destination is new; all presentation comes from the requesting account.
    let mail = state
      .auth()
      .prepare_mail_for_user(
        Some(snapshot.user.id),
        &decoded_email,
        myoxus_application::ports::MailTemplate::VerifyEmail,
        serde_json::json!({"url":url}),
      )
      .await
      .map_err(map_gql_error)?;
    state
      .auth()
      .mailer
      .send_template(mail)
      .await
      .map_err(|e| map_gql_error(AuthError::Storage(e.to_string())))?;
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn send_verify_email(&self, ctx: &Context<'_>, callback_url: String) -> Result<bool> {
    // P42-B-02: Use unverified session — unverified users must be able to request verification.
    let (state, snapshot) = require_session_allow_unverified(ctx).await?;
    check_email_rate_limit(state.as_ref(), snapshot.user.id, "send_verify_email").await?;
    validate_callback_url(&callback_url, &state.config.server.origin)?;

    let token = Uuid::new_v4().to_string();
    state
      .auth()
      .store
      .create_verification_token(
        Some(snapshot.user.id),
        "VerifyEmail",
        &token,
        None,
        Utc::now() + chrono::Duration::minutes(30),
        None,
      )
      .await
      .map_err(map_gql_error)?;

    let url = append_query_params(&callback_url, &[("token", token)]);
    let mail = state
      .auth()
      .prepare_mail_for_user(
        Some(snapshot.user.id),
        &snapshot.user.email,
        myoxus_application::ports::MailTemplate::VerifyEmail,
        serde_json::json!({"url":url}),
      )
      .await
      .map_err(map_gql_error)?;
    state
      .auth()
      .mailer
      .send_template(mail)
      .await
      .map_err(|e| map_gql_error(AuthError::Storage(e.to_string())))?;
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn change_email(&self, ctx: &Context<'_>, token: String, email: String) -> Result<UserType> {
    let (state, snapshot) = require_session(ctx).await?;

    let user = state
      .auth()
      .change_email(snapshot.user.id, &token, &email)
      .await
      .map_err(map_gql_error)?;
    Ok(user.into())
  }

  #[instrument(skip_all)]
  pub(crate) async fn verify_email(&self, ctx: &Context<'_>, token: String) -> Result<bool> {
    // P42-B-02: Use unverified session — user must be able to verify their email.
    let (state, snapshot) = require_session_allow_unverified(ctx).await?;
    state
      .auth()
      .verify_email(snapshot.user.id, &token)
      .await
      .map_err(map_gql_error)?;
    info!(user_id = %snapshot.user.id, "successfully verified email via graphql");
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn update_profile(&self, ctx: &Context<'_>, input: UpdateUserInput) -> Result<UserType> {
    let (state, snapshot) = require_session(ctx).await?;
    let user = state
      .auth()
      .update_profile(
        snapshot.user.id,
        UpdateAuthUser {
          name: Some(input.name),
          ..Default::default()
        },
      )
      .await
      .map_err(map_gql_error)?;
    info!(user_id = %snapshot.user.id, "successfully updated profile via graphql");
    Ok(user.into())
  }

  #[instrument(skip_all)]
  pub(crate) async fn save_assistant_setup(
    &self,
    ctx: &Context<'_>,
    expected_user_id: ID,
    input: database::SaveAssistantSetupInput,
  ) -> Result<UserPreferencesType> {
    database::save_assistant_setup(ctx, expected_user_id, input).await
  }

  #[instrument(skip_all)]
  pub(crate) async fn delete_assistant_setup(
    &self,
    ctx: &Context<'_>,
    expected_user_id: ID,
    id: ID,
  ) -> Result<UserPreferencesType> {
    database::delete_assistant_setup(ctx, expected_user_id, id).await
  }

  #[instrument(skip_all)]
  pub(crate) async fn update_preferences(
    &self,
    ctx: &Context<'_>,
    input: UpdateUserPreferencesInput,
  ) -> Result<UserPreferencesType> {
    let (state, snapshot) = require_session(ctx).await?;
    let editor_font_size = optional_i32_patch(input.editor_font_size)
      .map(|value| {
        value
          .map(|size| {
            u8::try_from(size).map_err(|_| map_gql_error(AuthError::InvalidInput("invalid editorFontSize".to_string())))
          })
          .transpose()
      })
      .transpose()?;
    let record = state
      .auth()
      .patch_user_preferences(
        snapshot.user.id,
        myoxus_application::auth::UserPreferencesPatch {
          saved_setups: Vec::new(),
          assistance_mode: assistance_mode_patch(input.assistance_mode),
          workspace_assistance_overrides: input
            .workspace_assistance_overrides
            .unwrap_or_default()
            .into_iter()
            .map(|value| {
              Ok(myoxus_application::auth::WorkspaceAssistancePatch {
                workspace_id: assistance_scope_id(&value.workspace_id)?,
                mode: scoped_assistance_mode(value.mode)?,
              })
            })
            .collect::<Result<Vec<_>>>()?,
          project_assistance_overrides: input
            .project_assistance_overrides
            .unwrap_or_default()
            .into_iter()
            .map(|value| {
              Ok(myoxus_application::auth::ProjectAssistancePatch {
                workspace_id: assistance_scope_id(&value.workspace_id)?,
                project_id: assistance_scope_id(&value.project_id)?,
                mode: scoped_assistance_mode(value.mode)?,
              })
            })
            .collect::<Result<Vec<_>>>()?,
          locale: optional_string_patch(input.locale),
          default_document_language: optional_string_patch(input.default_document_language),
          timezone: optional_string_patch(input.timezone),
          date_format: optional_string_patch(input.date_format),
          time_format: optional_string_patch(input.time_format),
          receive_invitation_email: optional_bool_patch(input.receive_invitation_email),
          receive_mention_email: optional_bool_patch(input.receive_mention_email),
          receive_comment_email: optional_bool_patch(input.receive_comment_email),
          notify_created_documents: optional_bool_patch(input.notify_created_documents),
          journal_first_day_of_week: optional_string_patch(input.journal_first_day_of_week),
          journal_show_calendar_weeks: optional_bool_patch(input.journal_show_calendar_weeks),
          color_mode: optional_string_patch(input.color_mode),
          show_linked_documents: optional_bool_patch(input.show_linked_documents),
          image_antialiasing: optional_bool_patch(input.image_antialiasing),
          noisy_background: optional_bool_patch(input.noisy_background),
          editor_font_family: optional_string_patch(input.editor_font_family),
          editor_custom_font_family: optional_string_patch(input.editor_custom_font_family),
          editor_font_size,
          new_document_mode: optional_string_patch(input.new_document_mode),
          full_width_layout: optional_bool_patch(input.full_width_layout),
          open_document_mode: optional_string_patch(input.open_document_mode),
          edgeless_default_theme: optional_string_patch(input.edgeless_default_theme),
          telemetry_enabled: optional_bool_patch(input.telemetry_enabled),
          ai_model_id: optional_string_patch(input.ai_model_id),
          ai_reasoning_enabled: optional_bool_patch(input.ai_reasoning_enabled),
          document_metadata_header_visibility: optional_document_metadata_visibility_patch(
            input.document_metadata_header_visibility,
          )?,
          workbench_tool_layouts: optional_workbench_tool_layouts_patch(input.workbench_tool_layouts)?,
          workspace_dashboard_layouts: optional_workspace_dashboard_layouts_patch(input.workspace_dashboard_layouts)?,
          template_catalog_views: optional_template_catalog_views_patch(input.template_catalog_views)?,
        },
      )
      .await
      .map_err(map_gql_error)?;
    info!(user_id = %snapshot.user.id, "successfully updated user preferences via graphql");
    Ok(super::user::map_user_preferences(&state, record).await)
  }

  #[instrument(skip_all)]
  pub(crate) async fn upload_avatar(&self, ctx: &Context<'_>, avatar: Upload) -> Result<UserType> {
    let (state, snapshot) = require_session(ctx).await?;
    let upload = avatar.value(ctx)?;
    let upload_content_type = upload.content_type.clone();
    use std::io::Read;
    let mut buffer = Vec::new();
    let mut file = upload.content;
    file.read_to_end(&mut buffer).map_err(|e| {
      tracing::error!(user_id = %snapshot.user.id, error = %e, "failed to read avatar upload content");
      map_gql_error(AuthError::Storage(e.to_string()))
    })?;
    // SC-L-01: Detect actual MIME type from bytes, fall back to upload header, then "image/png".
    let content_type = infer::get(&buffer)
      .map(|kind| kind.mime_type().to_string())
      .or(upload_content_type)
      .unwrap_or_else(|| "image/png".to_string());
    if !content_type.starts_with("image/") {
      warn!(user_id = %snapshot.user.id, content_type = %content_type, "rejected invalid avatar file type");
      return Err(map_gql_error(AuthError::InvalidInput("Invalid file type".into())));
    }
    let user = state
      .auth()
      .upload_avatar(snapshot.user.id, Bytes::from(buffer), &content_type)
      .await
      .map_err(map_gql_error)?;
    info!(user_id = %snapshot.user.id, "successfully uploaded avatar via graphql");
    Ok(user.into())
  }

  #[instrument(skip_all)]
  pub(crate) async fn remove_avatar(&self, ctx: &Context<'_>) -> Result<RemoveAvatar> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .auth()
      .remove_avatar(snapshot.user.id)
      .await
      .map_err(map_gql_error)?;
    info!(user_id = %snapshot.user.id, "successfully removed avatar via graphql");
    Ok(RemoveAvatar { success: true })
  }

  #[instrument(skip_all)]
  pub(crate) async fn delete_account(&self, ctx: &Context<'_>) -> Result<DeleteAccount> {
    let (state, snapshot) = require_session(ctx).await?;
    state
      .admin_users()
      .delete(
        snapshot.user.id,
        myoxus_domain::audit::AuditActor::user(snapshot.user.id, snapshot.user.email.clone()),
        "graphql-self-service",
      )
      .await
      .map_err(map_gql_error)?;
    info!(user_id = %snapshot.user.id, "successfully DELETED account via graphql");
    Ok(DeleteAccount { success: true })
  }

  #[instrument(skip_all)]
  pub(crate) async fn generate_user_access_token(
    &self,
    ctx: &Context<'_>,
    input: GenerateAccessTokenInput,
  ) -> Result<RevealedAccessToken> {
    let (state, snapshot) = require_session(ctx).await?;
    let (token, raw) = state
      .auth()
      .create_access_token(snapshot.user.id, input.name, input.expires_at)
      .await
      .map_err(map_gql_error)?;
    info!(user_id = %snapshot.user.id, token_id = %token.id, "successfully generated access token");
    Ok(RevealedAccessToken {
      id: token.id,
      name: token.name,
      created_at: token.created_at,
      expires_at: token.expires_at,
      token: raw,
    })
  }

  #[instrument(skip_all)]
  pub(crate) async fn revoke_user_access_token(&self, ctx: &Context<'_>, id: String) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let token_uuid = Uuid::parse_str(&id).map_err(|_| "Invalid token id")?;
    state
      .auth()
      .revoke_access_token(token_uuid, snapshot.user.id)
      .await
      .map_err(map_gql_error)?;
    info!(user_id = %snapshot.user.id, token_id = %token_uuid, "successfully revoked access token");
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn create_workspace(
    &self,
    ctx: &Context<'_>,
    init: Option<Upload>,
    input: Option<super::CreateWorkspaceInput>,
  ) -> Result<WorkspaceType> {
    let (state, snapshot) = require_session(ctx).await?;
    let session_user_exists = state
      .auth()
      .get_user_by_id(snapshot.user.id)
      .await
      .map_err(map_gql_error)?
      .is_some();
    if !session_user_exists {
      state.auth().sign_out(snapshot.session.id).await.ok();
      return Err(map_gql_error(AuthError::AuthenticationRequired));
    }
    if let Some(input) = input {
      if init.is_some() {
        return Err(map_gql_error(AuthError::InvalidInput(
          "init and input cannot be combined".into(),
        )));
      }
      let request_id = Uuid::parse_str(input.request_id.as_str())
        .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid requestId".into())))?;
      // Confirmation freezes the prepared locale. Resolving a mutable account
      // default again on replay would change the same request's fingerprint.
      if input.project.as_ref().is_some_and(|project| project.locale.is_none()) {
        return Err(map_gql_error(AuthError::InvalidInput(
          "confirmed Project setup requires its prepared locale".into(),
        )));
      }
      let confirmation = input.assistant_confirmation;
      let project = database::workspace_project_input(&state, snapshot.user.id, input.project).await?;
      let setup = database::workspace_setup_input(input.setup)?;
      let outcome = state
        .workspace()
        .create_workspace_starter(
          snapshot.user.id,
          myoxus_application::workspace::WorkspaceStarterInput {
            request_id,
            name: input.name,
            initial_content: myoxus_application::workspace::WorkspaceInitialContent::Empty,
            assistance_mode: input.assistance_mode.into(),
            package: confirmation.identity.into(),
            answers: super::database::package_answers(confirmation.answers.0)?,
            plan_digest: confirmation.plan_digest,
            project,
            setup,
            admission_confirmation: input.admission_confirmation,
          },
          state.assistant_packages().as_deref(),
          state.auth(),
        )
        .await
        .map_err(super::workspace::map_workspace_starter_error)?;
      let creation = super::WorkspaceCreationResultType::try_from(&outcome)?;
      let mut result: WorkspaceType = outcome.allocation.workspace.into();
      result.creation = Some(creation);
      return Ok(result);
    }
    let mut init_data = None;
    if let Some(upload) = init {
      let u = upload.value(ctx)?;
      use std::io::Read;
      let mut buffer = Vec::new();
      let mut file = u.content;
      file.read_to_end(&mut buffer).map_err(|e| {
        tracing::error!(user_id = %snapshot.user.id, error = %e, "failed to read workspace init upload content");
        map_gql_error(AuthError::Storage(e.to_string()))
      })?;
      init_data = Some(buffer);
    }
    let w = state
      .workspace()
      .create_workspace(snapshot.user.id, None, init_data)
      .await
      .map_err(map_gql_error)?;
    info!(user_id = %snapshot.user.id, workspace_id = %w.id, "successfully created workspace via graphql");
    state.metrics().record(
      MetricsCategory::Workspace,
      "workspace_created",
      &[("source", "graphql")],
    );
    Ok(w.into())
  }

  #[instrument(skip_all)]
  pub(crate) async fn update_workspace(&self, ctx: &Context<'_>, input: UpdateWorkspaceInput) -> Result<WorkspaceType> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_id = Uuid::parse_str(&input.id).map_err(|_| "Invalid id")?;
    let w = state
      .workspace_settings_service()
      .update(
        snapshot.user.id,
        workspace_id,
        UserWorkspaceSettingsInput {
          overview: input
            .overview
            .map(|value| value.into_patch(workspace_id))
            .transpose()
            .map_err(map_gql_error)?,
          name: input.name,
          description: input.description,
          public: input.public,
          enable_ai: input.enable_ai,
          enable_sharing: input.enable_sharing,
          enable_url_preview: input.enable_url_preview,
          enable_doc_embedding: input.enable_doc_embedding,
          ..Default::default()
        },
      )
      .await
      .map_err(map_gql_error)?;
    info!(user_id = %snapshot.user.id, workspace_id = %w.id, "successfully updated workspace via graphql");
    state
      .metrics()
      .record(MetricsCategory::Workspace, "workspace_updated", &[]);
    Ok(w.into())
  }

  #[instrument(skip_all)]
  pub(crate) async fn delete_workspace(&self, ctx: &Context<'_>, id: String) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_id = Uuid::parse_str(&id).map_err(|_| "Invalid id")?;
    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id,
      },
      WorkspaceAction::Delete,
    )
    .await
    .map_err(map_gql_error)?;

    // This is trash, not permanent deletion: retain blob metadata and bytes
    // so administrative lifecycle recovery restores the same content.
    state
      .workspace()
      .delete_workspace(workspace_id)
      .await
      .map_err(map_gql_error)?;

    state.metrics().record(
      MetricsCategory::Workspace,
      "workspace_deleted",
      &[("source", "graphql")],
    );
    info!(user_id = %snapshot.user.id, workspace_id = %workspace_id, "successfully trashed workspace via graphql");

    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn invite_members(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    emails: Vec<String>,
  ) -> Result<Vec<InviteResult>> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| "Invalid id")?;

    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::UsersManage,
    )
    .await
    .map_err(map_gql_error)?;

    let invite_results = state
      .workspace()
      .invite_members(
        workspace_uuid,
        snapshot.user.id,
        emails.clone(),
        state.auth().store.clone(),
      )
      .await
      .map_err(map_gql_error)?;

    let mut results = Vec::new();
    let mut sent_ok: u64 = 0;
    let mut sent_fail: u64 = 0;
    for (email, res) in emails.into_iter().zip(invite_results) {
      match res {
        Ok(m) => {
          sent_ok += 1;
          results.push(InviteResult {
            email,
            invite_id: Some(m.invite_id.to_string()),
            sent_success: true,
            error: None,
          });
        }
        Err(e) => {
          sent_fail += 1;
          warn!(email = %email, error = %e, "failed to invite member");
          results.push(InviteResult {
            email,
            invite_id: None,
            sent_success: false,
            error: Some(e.to_string()),
          });
        }
      }
    }
    if sent_ok > 0 {
      state.metrics().record_with(
        MetricsCategory::Workspace,
        "invite_sent",
        Default::default(),
        sent_ok as f64,
      );
    }
    if sent_fail > 0 {
      state.metrics().record_with(
        MetricsCategory::Workspace,
        "invite_failed",
        Default::default(),
        sent_fail as f64,
      );
    }
    Ok(results)
  }

  /// P100-SRV-F-02: Invite an existing user by their user ID.
  ///
  /// Creates a Pending membership and emits an Invite outbox event.
  /// Returns the membership's invite_id (UUID string) on success.
  #[instrument(skip_all)]
  pub(crate) async fn invite_server_user_by_id(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    user_id: String,
    _role: Option<String>,
  ) -> Result<String> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| "Invalid workspace id")?;
    let target_user_id = Uuid::parse_str(&user_id).map_err(|_| "Invalid user id")?;

    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::UsersManage,
    )
    .await
    .map_err(map_gql_error)?;

    // Verify the target user exists.
    state
      .auth()
      .get_user_by_id(target_user_id)
      .await
      .map_err(map_gql_error)?
      .ok_or_else(|| map_gql_error(AuthError::InvalidInput("UserNotFound".to_string())))?;

    let member = state
      .workspace()
      .invite_member_by_id(workspace_uuid, snapshot.user.id, target_user_id)
      .await
      .map_err(map_gql_error)?;

    Ok(member.invite_id.to_string())
  }

  #[instrument(skip_all)]
  pub(crate) async fn accept_invite_by_id(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    invite_id: String,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| "Invalid id")?;
    let invite_uuid = Uuid::parse_str(&invite_id).map_err(|_| "Invalid invite id")?;

    let member = state
      .workspace()
      .get_member_by_invite_id(invite_uuid)
      .await
      .map_err(map_gql_error)?
      .ok_or_else(|| map_gql_error(AuthError::InvalidInput("InvalidInvitation".to_string())))?;
    if member.workspace_id != workspace_uuid {
      return Err(map_gql_error(AuthError::InvalidInput("InvalidInvitation".to_string())));
    }
    let result = state
      .workspace()
      .accept_invite_by_id(snapshot.user.id, invite_uuid)
      .await
      .map_err(map_gql_error)?;
    state
      .metrics()
      .record(MetricsCategory::Workspace, "invite_accepted", &[]);
    Ok(result)
  }

  #[instrument(skip_all)]
  pub(crate) async fn create_workspace_invite_link(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    expire_time: f64,
  ) -> Result<WorkspaceInviteLinkType> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| "Invalid id")?;

    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::UsersManage,
    )
    .await
    .map_err(map_gql_error)?;

    let link = state
      .workspace()
      .create_invite_link(workspace_uuid, snapshot.user.id, expire_time as i64)
      .await
      .map_err(map_gql_error)?;
    Ok(WorkspaceInviteLinkType {
      workspace_id,
      invite_id: link.token_hash,
      expire_time,
    })
  }

  #[instrument(skip_all)]
  pub(crate) async fn create_invite_link(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    expire_time: WorkspaceInviteLinkExpireTime,
  ) -> Result<InviteLinkType> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| "Invalid id")?;

    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::UsersManage,
    )
    .await
    .map_err(map_gql_error)?;

    let link = state
      .workspace()
      .create_invite_link(workspace_uuid, snapshot.user.id, expire_time.milliseconds())
      .await
      .map_err(map_gql_error)?;
    let server_origin = state.effective_config().await.server_origin();
    Ok(InviteLinkType {
      link: workspace_invite_url(&server_origin, &link.token_hash),
      expire_time: link.expires_at.unwrap_or_else(Utc::now),
    })
  }

  #[instrument(skip_all)]
  pub(crate) async fn revoke_workspace_invite_link(&self, ctx: &Context<'_>, workspace_id: String) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| "Invalid id")?;

    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::UsersManage,
    )
    .await
    .map_err(map_gql_error)?;

    state
      .workspace()
      .revoke_invite_link(workspace_uuid)
      .await
      .map_err(map_gql_error)?;
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn accept_workspace_invite(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    invite_id: String, // this is the token_hash for join links
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| "Invalid id")?;

    let link = state
      .workspace()
      .get_invite_link_by_token(&invite_id)
      .await
      .map_err(map_gql_error)?
      .ok_or_else(|| map_gql_error(AuthError::InvalidToken))?;
    if link.workspace_id != workspace_uuid {
      return Err(map_gql_error(AuthError::InvalidInput("InvalidInvitation".to_string())));
    }
    state
      .workspace()
      .accept_invite_by_link(snapshot.user.id, &invite_id)
      .await
      .map_err(map_gql_error)
  }

  #[instrument(skip_all)]
  pub(crate) async fn revoke_member(&self, ctx: &Context<'_>, workspace_id: String, user_id: String) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| "Invalid id")?;
    let target_user_id = Uuid::parse_str(&user_id).map_err(|_| "Invalid user id")?;

    let required = state
      .workspace()
      .membership_mutation_action(workspace_uuid, snapshot.user.id, target_user_id, None)
      .await
      .map_err(map_gql_error)?;
    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      required,
    )
    .await
    .map_err(map_gql_error)?;

    state
      .workspace()
      .revoke_member(workspace_uuid, target_user_id)
      .await
      .map_err(map_gql_error)
  }

  #[instrument(skip_all)]
  pub(crate) async fn leave_workspace(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    send_leave_mail: Option<bool>,
    workspace_name: Option<String>,
  ) -> Result<bool> {
    let _ = send_leave_mail;
    let _ = workspace_name;
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| "Invalid id")?;

    state
      .workspace()
      .leave_workspace(snapshot.user.id, workspace_uuid)
      .await
      .map_err(map_gql_error)
  }

  #[instrument(skip_all)]
  pub(crate) async fn grant_member(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    user_id: String,
    permission: WorkspaceRole,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| "Invalid id")?;
    let target_user_id = Uuid::parse_str(&user_id).map_err(|_| "Invalid user id")?;

    let role = match permission {
      WorkspaceRole::Owner => WorkspaceRoleModel::Owner,
      WorkspaceRole::Admin => WorkspaceRoleModel::Admin,
      WorkspaceRole::Manager => WorkspaceRoleModel::Manager,
      WorkspaceRole::Collaborator => WorkspaceRoleModel::Collaborator,
      WorkspaceRole::Commenter => WorkspaceRoleModel::Commenter,
      WorkspaceRole::Reader => WorkspaceRoleModel::Reader,
      WorkspaceRole::External => WorkspaceRoleModel::External,
    };

    let required = state
      .workspace()
      .membership_mutation_action(workspace_uuid, snapshot.user.id, target_user_id, Some(role))
      .await
      .map_err(map_gql_error)?;
    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      required,
    )
    .await
    .map_err(map_gql_error)?;

    if role == WorkspaceRoleModel::Owner {
      return state
        .workspace()
        .transfer_ownership(workspace_uuid, snapshot.user.id, target_user_id)
        .await
        .map_err(map_gql_error);
    }
    state
      .workspace()
      .update_member_role(workspace_uuid, target_user_id, role)
      .await
      .map_err(map_gql_error)
  }

  #[instrument(skip_all)]
  pub(crate) async fn approve_member(&self, ctx: &Context<'_>, workspace_id: String, user_id: String) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| "Invalid id")?;
    let target_user_id = Uuid::parse_str(&user_id).map_err(|_| "Invalid user id")?;

    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::UsersManage,
    )
    .await
    .map_err(map_gql_error)?;
    state
      .workspace()
      .approve_member(workspace_uuid, target_user_id)
      .await
      .map_err(map_gql_error)
  }

  #[instrument(skip_all)]
  #[allow(clippy::too_many_arguments)]
  pub(crate) async fn create_comment(
    &self,
    ctx: &Context<'_>,
    input: Option<CommentCreateInput>,
    workspace_id: Option<String>,
    doc_id: Option<String>,
    parent_comment_id: Option<String>,
    body: Option<serde_json::Value>,
    attachment_keys: Option<Vec<String>>,
    selection_anchor: Option<SelectionAnchorInput>,
    doc_text: Option<String>,
  ) -> Result<CommentObjectType> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_id = input
      .as_ref()
      .map(|value| value.workspace_id.clone())
      .or(workspace_id)
      .ok_or_else(|| map_gql_error(AuthError::InvalidInput("workspace id is required".to_string())))?;
    let doc_id = input
      .as_ref()
      .map(|value| value.doc_id.clone())
      .or(doc_id)
      .ok_or_else(|| map_gql_error(AuthError::InvalidInput("doc id is required".to_string())))?;
    let body = input
      .map(|value| value.content)
      .or(body)
      .unwrap_or_else(|| serde_json::json!({}));
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, &doc_id).await?;
    let parent_uuid = parent_comment_id
      .as_deref()
      .map(Uuid::parse_str)
      .transpose()
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid parent comment id".to_string())))?;

    let comment = state
      .comment()
      .create_comment_with_context(
        snapshot.user.id,
        myoxus_application::comment::CommentCreationInput {
          workspace_id: workspace_uuid,
          doc_id: doc_uuid,
          parent_comment_id: parent_uuid,
          body,
          attachment_keys: attachment_keys.unwrap_or_default(),
          selection_anchor: selection_anchor.map(|anchor| SelectionAnchorModel {
            quote: anchor.quote,
            start: anchor.start.map(|v| v.max(0) as usize),
            end: anchor.end.map(|v| v.max(0) as usize),
            prefix: anchor.prefix,
            suffix: anchor.suffix,
          }),
          doc_text,
        },
        state.blob(),
      )
      .await
      .map_err(map_gql_error)?
      .comment;

    let user = state
      .auth()
      .get_historical_profile(comment.author_id)
      .await
      .map_err(map_gql_error)?
      .map(|value| PublicUserType {
        id: ID::from(value.id.to_string()),
        email: value.email.clone(),
        name: value.name.unwrap_or(value.email),
        avatar_url: value.avatar_url,
      })
      .unwrap_or(PublicUserType {
        id: ID::from(comment.author_id.to_string()),
        email: String::new(),
        name: "Unknown".to_string(),
        avatar_url: None,
      });
    Ok(CommentObjectType {
      id: ID::from(comment.id.to_string()),
      parent_comment_id: comment.parent_comment_id.map(|value| ID::from(value.to_string())),
      content: comment.body,
      resolved: comment.resolved,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      user,
      replies: Vec::new(),
    })
  }

  #[instrument(skip_all)]
  pub(crate) async fn update_comment(
    &self,
    ctx: &Context<'_>,
    input: Option<CommentUpdateInput>,
    comment_id: Option<String>,
    body: Option<serde_json::Value>,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let comment_id = input
      .as_ref()
      .map(|value| value.id.clone())
      .or(comment_id)
      .ok_or_else(|| map_gql_error(AuthError::InvalidInput("comment id is required".to_string())))?;
    let body = input
      .map(|value| value.content)
      .or(body)
      .unwrap_or_else(|| serde_json::json!({}));
    let comment_uuid = Uuid::parse_str(&comment_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid comment id".to_string())))?;
    state
      .comment()
      .update_comment(snapshot.user.id, comment_uuid, body)
      .await
      .map_err(map_gql_error)?;
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn resolve_comment(
    &self,
    ctx: &Context<'_>,
    input: Option<CommentResolveInput>,
    comment_id: Option<String>,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let comment_id = input
      .as_ref()
      .map(|value| value.id.clone())
      .or(comment_id)
      .ok_or_else(|| map_gql_error(AuthError::InvalidInput("comment id is required".to_string())))?;
    let resolved = input.map(|value| value.resolved).unwrap_or(true);
    let comment_uuid = Uuid::parse_str(&comment_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid comment id".to_string())))?;
    state
      .comment()
      .set_comment_resolved(snapshot.user.id, comment_uuid, resolved)
      .await
      .map_err(map_gql_error)?;
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn reopen_comment(&self, ctx: &Context<'_>, comment_id: String) -> Result<CommentType> {
    let (state, snapshot) = require_session(ctx).await?;
    let comment_uuid = Uuid::parse_str(&comment_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid comment id".to_string())))?;
    let updated = state
      .comment()
      .set_comment_resolved(snapshot.user.id, comment_uuid, false)
      .await
      .map_err(map_gql_error)?;
    Ok(updated.into())
  }

  #[instrument(skip_all)]
  pub(crate) async fn delete_comment(&self, ctx: &Context<'_>, id: String) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let comment_uuid =
      Uuid::parse_str(&id).map_err(|_| map_gql_error(AuthError::InvalidInput("invalid comment id".to_string())))?;
    state
      .comment()
      .delete_comment(snapshot.user.id, comment_uuid)
      .await
      .map_err(map_gql_error)
  }

  #[instrument(skip_all)]
  pub(crate) async fn create_reply(&self, ctx: &Context<'_>, input: ReplyCreateInput) -> Result<ReplyObjectType> {
    let (state, snapshot) = require_session(ctx).await?;
    let parent_id = Uuid::parse_str(&input.comment_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid comment id".to_string())))?;
    let parent = state
      .comment()
      .get_comment(parent_id)
      .await
      .map_err(map_gql_error)?
      .ok_or_else(|| map_gql_error(AuthError::InvalidInput("parent comment not found".to_string())))?;
    let reply = state
      .comment()
      .create_comment(
        snapshot.user.id,
        parent.workspace_id,
        parent.doc_id,
        Some(parent_id),
        input.content,
      )
      .await
      .map_err(map_gql_error)?;
    let user = state
      .auth()
      .get_historical_profile(reply.author_id)
      .await
      .map_err(map_gql_error)?
      .map(|value| PublicUserType {
        id: ID::from(value.id.to_string()),
        email: value.email.clone(),
        name: value.name.unwrap_or(value.email),
        avatar_url: value.avatar_url,
      })
      .unwrap_or(PublicUserType {
        id: ID::from(reply.author_id.to_string()),
        email: String::new(),
        name: "Unknown".to_string(),
        avatar_url: None,
      });
    Ok(ReplyObjectType {
      id: ID::from(reply.id.to_string()),
      comment_id: ID::from(parent_id.to_string()),
      content: reply.body,
      created_at: reply.created_at,
      updated_at: reply.updated_at,
      user,
    })
  }

  #[instrument(skip_all)]
  pub(crate) async fn update_reply(&self, ctx: &Context<'_>, input: ReplyUpdateInput) -> Result<bool> {
    self
      .update_comment(
        ctx,
        Some(CommentUpdateInput {
          id: input.id,
          content: input.content,
        }),
        None,
        None,
      )
      .await
  }

  #[instrument(skip_all)]
  pub(crate) async fn delete_reply(&self, ctx: &Context<'_>, id: String) -> Result<bool> {
    self.delete_comment(ctx, id).await
  }

  #[instrument(skip_all)]
  pub(crate) async fn mention_user(&self, ctx: &Context<'_>, input: MentionInput) -> Result<ID> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_id = Uuid::parse_str(&input.workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let target_user_id = Uuid::parse_str(&input.user_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid user id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id,
        },
        WorkspaceAction::Read,
      )
      .await
      .map_err(map_gql_error)?;
    let notification_id = state
      .notification()
      .create_notification(
        target_user_id,
        "mention".to_string(),
        Some("default".to_string()),
        Some(format!(
          "mention:{}:{}:{}",
          target_user_id, input.doc.id, snapshot.user.id
        )),
        serde_json::json!({
        "workspaceId": input.workspace_id,
            "doc": {
                "id": input.doc.id,
                "mode": input.doc.mode,
                "title": input.doc.title,
                "blockId": input.doc.block_id,
                "elementId": input.doc.element_id,
            },
            "mentionedUserId": input.user_id,
            "createdByUserId": snapshot.user.id,
        }),
      )
      .await
      .map_err(map_gql_error)?;
    Ok(ID::from(notification_id.id.to_string()))
  }

  #[instrument(skip_all)]
  pub(crate) async fn mark_comment_thread_read(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    comment_id: String,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, &doc_id).await?;
    let comment_uuid = Uuid::parse_str(&comment_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid comment id".to_string())))?;
    state
      .comment()
      .mark_comment_thread_read(snapshot.user.id, workspace_uuid, doc_uuid, comment_uuid)
      .await
      .map_err(map_gql_error)
  }

  #[instrument(skip_all)]
  pub(crate) async fn mark_all_comment_threads_read(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
  ) -> Result<i32> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, &doc_id).await?;
    let count = state
      .comment()
      .mark_all_comment_threads_read(snapshot.user.id, workspace_uuid, doc_uuid)
      .await
      .map_err(map_gql_error)?;
    Ok(count as i32)
  }

  #[instrument(skip_all)]
  pub(crate) async fn read_notification(&self, ctx: &Context<'_>, id: String) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let notification_id = Uuid::parse_str(&id)
      .map_err(|e| map_gql_error(AuthError::InvalidInput(format!("invalid notification id: {e}"))))?;
    let changed = state
      .notification()
      .mark_notification_read(snapshot.user.id, notification_id)
      .await
      .map_err(map_gql_error)?;
    if changed {
      websocket::publish_user_notification(
        state.redis_ws_adapter().map(AsRef::as_ref),
        snapshot.user.id,
        "notification_read",
        serde_json::json!({
            "notificationId": notification_id,
            "read": true
        }),
      )
      .await;
    }
    Ok(changed)
  }

  #[instrument(skip_all)]
  pub(crate) async fn read_all_notifications(&self, ctx: &Context<'_>) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let affected = state
      .notification()
      .mark_all_notifications_read(snapshot.user.id)
      .await
      .map_err(map_gql_error)?;
    if affected > 0 {
      websocket::publish_user_notification(
        state.redis_ws_adapter().map(AsRef::as_ref),
        snapshot.user.id,
        "notification_read_all",
        serde_json::json!({
            "affected": affected
        }),
      )
      .await;
    }
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn set_blob(&self, ctx: &Context<'_>, workspace_id: String, blob: Upload) -> Result<String> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;

    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::BlobsWrite,
    )
    .await
    .map_err(map_gql_error)?;

    let upload = blob
      .value(ctx)
      .map_err(|e| map_gql_error(AuthError::InvalidInput(e.to_string())))?;
    let file_name = upload.filename.clone();
    let normalized_key = BlobKey::parse(&file_name)
      .map_err(|e| map_gql_error(AuthError::InvalidInput(format!("invalid blob key: {e}"))))?;
    let content_type = upload
      .content_type
      .clone()
      .unwrap_or_else(|| "application/octet-stream".to_string());

    use std::io::Read;
    let mut buffer = Vec::new();
    let mut reader = upload.content;
    reader
      .read_to_end(&mut buffer)
      .map_err(|e| map_gql_error(AuthError::Storage(format!("failed to read uploaded blob: {e}"))))?;
    if buffer.len() as u64 > state.config.storage.max_upload_bytes() {
      return Err(map_gql_error(AuthError::InvalidInput(
        "blob exceeds configured max upload size".to_string(),
      )));
    }

    // MIME policy enforcement — check before storing.
    enforce_mime_policy_gql(&state, &buffer, &file_name, &content_type).await?;

    state
      .blob()
      .initialize_upload(
        workspace_uuid,
        normalized_key.as_str(),
        buffer.len() as u64,
        &content_type,
      )
      .await
      .map_err(map_gql_error)?;

    let storage_key = format!("{workspace_uuid}/{}", normalized_key.as_str());
    state
      .storage()
      .write_blob(BlobWriteRequest {
        key: storage_key,
        content_type: Some(content_type),
        body: Bytes::from(buffer),
      })
      .await
      .map_err(|e| map_gql_error(AuthError::Storage(e.to_string())))?;

    state
      .blob()
      .complete_upload(workspace_uuid, normalized_key.as_str())
      .await
      .map_err(map_gql_error)?;
    info!(
        user_id = %snapshot.user.id,
        workspace_id = %workspace_uuid,
        key = %normalized_key.as_str(),
        "uploaded blob via graphql single-part path"
    );
    Ok(normalized_key.as_str().to_string())
  }

  #[instrument(skip_all)]
  pub(crate) async fn upload_comment_attachment(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    doc_id: String,
    attachment: Upload,
  ) -> Result<String> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let doc_uuid = crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, &doc_id).await?;

    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::BlobsWrite,
    )
    .await
    .map_err(map_gql_error)?;
    pc.assert(
      &DocResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
        doc_id: doc_uuid,
      },
      DocAction::CommentsCreate,
    )
    .await
    .map_err(map_gql_error)?;

    let doc_meta = state.doc().get_metadata(doc_uuid).await.map_err(map_gql_error)?;
    let Some(doc_meta) = doc_meta else {
      return Err(map_gql_error(AuthError::InvalidInput("document not found".to_string())));
    };
    if doc_meta.workspace_id != Some(workspace_uuid) {
      return Err(map_gql_error(AuthError::ActionForbidden));
    }

    let upload = attachment
      .value(ctx)
      .map_err(|e| map_gql_error(AuthError::InvalidInput(e.to_string())))?;
    let file_name = upload.filename.clone();
    let safe_name = file_name.replace(['/', '\\'], "_");
    let key = format!("comment-attachments/{}/{}-{}", doc_uuid, Uuid::new_v4(), safe_name);
    let normalized_key = BlobKey::parse(&key)
      .map_err(|e| map_gql_error(AuthError::InvalidInput(format!("invalid attachment key: {e}"))))?;
    let content_type = upload
      .content_type
      .clone()
      .unwrap_or_else(|| "application/octet-stream".to_string());

    use std::io::Read;
    let mut buffer = Vec::new();
    let mut reader = upload.content;
    reader
      .read_to_end(&mut buffer)
      .map_err(|e| map_gql_error(AuthError::Storage(format!("failed to read attachment: {e}"))))?;
    if buffer.len() as u64 > state.config.storage.max_upload_bytes() {
      return Err(map_gql_error(AuthError::InvalidInput(
        "attachment exceeds configured max upload size".to_string(),
      )));
    }
    let attachment_size = buffer.len() as u64;

    // MIME policy enforcement — check before storing.
    enforce_mime_policy_gql(&state, &buffer, &file_name, &content_type).await?;

    state
      .blob()
      .initialize_upload(workspace_uuid, normalized_key.as_str(), attachment_size, &content_type)
      .await
      .map_err(map_gql_error)?;
    state
      .storage()
      .write_blob(BlobWriteRequest {
        key: format!("{workspace_uuid}/{}", normalized_key.as_str()),
        content_type: Some(content_type.clone()),
        body: Bytes::from(buffer),
      })
      .await
      .map_err(|e| map_gql_error(AuthError::Storage(e.to_string())))?;
    state
      .blob()
      .complete_upload(workspace_uuid, normalized_key.as_str())
      .await
      .map_err(map_gql_error)?;
    state
      .blob()
      .bind_comment_attachment(
        workspace_uuid,
        doc_uuid,
        normalized_key.as_str(),
        &content_type,
        attachment_size,
        snapshot.user.id,
      )
      .await
      .map_err(map_gql_error)?;

    info!(
        user_id = %snapshot.user.id,
        workspace_id = %workspace_uuid,
        doc_id = %doc_uuid,
        key = %normalized_key.as_str(),
        "uploaded and bound comment attachment"
    );
    Ok(normalized_key.as_str().to_string())
  }

  #[instrument(skip_all)]
  pub(crate) async fn create_blob_upload(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    key: String,
    size: i32,
    mime: String,
  ) -> Result<BlobUploadInitType> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let normalized_key =
      BlobKey::parse(&key).map_err(|e| map_gql_error(AuthError::InvalidInput(format!("invalid blob key: {e}"))))?;
    let normalized_mime = if mime.trim().is_empty() {
      "application/octet-stream".to_string()
    } else {
      mime.trim().to_string()
    };

    if size < 0 {
      return Err(map_gql_error(AuthError::InvalidInput(
        "blob size must be >= 0".to_string(),
      )));
    }
    let size_u64 = size as u64;
    if size_u64 > state.config.storage.max_upload_bytes() {
      return Err(map_gql_error(AuthError::InvalidInput(
        "blob exceeds configured max upload size".to_string(),
      )));
    }

    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::BlobsWrite,
    )
    .await
    .map_err(map_gql_error)?;

    if let Some(existing) = state
      .blob()
      .get_blob_metadata(workspace_uuid, normalized_key.as_str())
      .await
      .map_err(map_gql_error)?
    {
      if existing.size != size_u64 {
        return Err(map_gql_error(AuthError::InvalidInput("Blob size mismatch".to_string())));
      }
      if existing.mime != normalized_mime {
        return Err(map_gql_error(AuthError::InvalidInput("Blob mime mismatch".to_string())));
      }
      if existing.status == BlobStatus::Completed {
        info!(
            user_id = %snapshot.user.id,
            workspace_id = %workspace_uuid,
            key = %normalized_key.as_str(),
            "blob already uploaded"
        );
        return Ok(BlobUploadInitType {
          method: BlobUploadMethodType::Graphql,
          blob_key: normalized_key.as_str().to_string(),
          already_uploaded: Some(true),
          upload_url: None,
          headers: None,
          expires_at: None,
          upload_id: None,
          part_size: None,
          uploaded_parts: None,
        });
      }
    }

    if size_u64 >= state.config.storage.multipart_threshold_bytes() {
      let part_size_bytes = state.config.storage.multipart_part_size_bytes.max(1);
      let part_size_i32 = part_size_bytes.min(i32::MAX as u64) as i32;
      let total_parts = size_u64.div_ceil(part_size_bytes);
      if total_parts > state.config.storage.multipart_max_parts as u64 {
        return Err(map_gql_error(AuthError::InvalidInput(
          "multipart upload exceeds configured maximum number of parts".to_string(),
        )));
      }
      let (upload_id, uploaded_parts) = state
        .blob()
        .prepare_multipart_upload(workspace_uuid, normalized_key.as_str(), size_u64, &normalized_mime)
        .await
        .map_err(map_gql_error)?;
      let uploaded_parts = uploaded_parts
        .into_iter()
        .map(|part| BlobUploadedPartType {
          part_number: part.part_number,
          etag: part.etag,
        })
        .collect::<Vec<_>>();
      info!(
          user_id = %snapshot.user.id,
          workspace_id = %workspace_uuid,
          key = %normalized_key.as_str(),
          upload_id,
          part_size = part_size_i32,
          "created multipart blob upload session"
      );
      return Ok(BlobUploadInitType {
        method: BlobUploadMethodType::Multipart,
        blob_key: normalized_key.as_str().to_string(),
        already_uploaded: Some(false),
        upload_url: None,
        headers: None,
        expires_at: Some(Utc::now() + chrono::Duration::seconds(state.config.storage.signed_url_ttl_seconds as i64)),
        upload_id: Some(upload_id),
        part_size: Some(part_size_i32),
        uploaded_parts: Some(uploaded_parts),
      });
    }

    state
      .blob()
      .initialize_upload(workspace_uuid, normalized_key.as_str(), size_u64, &normalized_mime)
      .await
      .map_err(map_gql_error)?;
    info!(
        user_id = %snapshot.user.id,
        workspace_id = %workspace_uuid,
        key = %normalized_key.as_str(),
        size = size_u64,
        mime = %normalized_mime,
        "created blob upload session"
    );
    Ok(BlobUploadInitType {
      method: BlobUploadMethodType::Graphql,
      blob_key: normalized_key.as_str().to_string(),
      already_uploaded: Some(false),
      upload_url: None,
      headers: None,
      expires_at: None,
      upload_id: None,
      part_size: None,
      uploaded_parts: Some(Vec::new()),
    })
  }

  #[instrument(skip_all)]
  pub(crate) async fn complete_blob_upload(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    key: String,
    upload_id: Option<String>,
    parts: Option<Vec<BlobUploadPartInputType>>,
  ) -> Result<String> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let normalized_key =
      BlobKey::parse(&key).map_err(|e| map_gql_error(AuthError::InvalidInput(format!("invalid blob key: {e}"))))?;

    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::BlobsWrite,
    )
    .await
    .map_err(map_gql_error)?;

    let metadata = state
      .blob()
      .get_blob_metadata(workspace_uuid, normalized_key.as_str())
      .await
      .map_err(map_gql_error)?
      .ok_or_else(|| map_gql_error(AuthError::InvalidInput("blob upload session not found".to_string())))?;
    if metadata.status == BlobStatus::Completed {
      return Ok(normalized_key.as_str().to_string());
    }
    let active_upload_id = metadata.upload_id.ok_or_else(|| {
      map_gql_error(AuthError::InvalidInput(
        "multipart upload is not initialized".to_string(),
      ))
    })?;
    if let Some(ref provided_upload_id) = upload_id
      && provided_upload_id != &active_upload_id
    {
      return Err(map_gql_error(AuthError::InvalidInput("upload id mismatch".to_string())));
    }

    let mut persisted_parts = state
      .blob()
      .list_multipart_parts(workspace_uuid, normalized_key.as_str(), &active_upload_id)
      .await
      .map_err(map_gql_error)?;
    persisted_parts.sort_by_key(|p| p.part_number);
    let selected_parts = if let Some(provided_parts) = parts {
      if provided_parts.is_empty() {
        return Err(map_gql_error(AuthError::InvalidInput(
          "multipart upload parts must not be empty".to_string(),
        )));
      }
      let mut normalized = provided_parts
        .into_iter()
        .map(|p| (p.part_number, p.etag))
        .collect::<Vec<_>>();
      normalized.sort_by_key(|(part_number, _)| *part_number);
      for (index, (part_number, _)) in normalized.iter().enumerate() {
        let expected = (index as i32) + 1;
        if *part_number != expected {
          return Err(map_gql_error(AuthError::InvalidInput(
            "multipart parts must be contiguous and sorted".to_string(),
          )));
        }
      }
      for (part_number, etag) in &normalized {
        let Some(found) = persisted_parts.iter().find(|p| p.part_number == *part_number) else {
          return Err(map_gql_error(AuthError::InvalidInput(format!(
            "missing uploaded part {}",
            part_number
          ))));
        };
        if found.etag != *etag {
          return Err(map_gql_error(AuthError::InvalidInput(format!(
            "etag mismatch for part {}",
            part_number
          ))));
        }
      }
      normalized
    } else {
      if persisted_parts.is_empty() {
        return Err(map_gql_error(AuthError::InvalidInput(
          "no uploaded parts found".to_string(),
        )));
      }
      for (index, part) in persisted_parts.iter().enumerate() {
        let expected = (index as i32) + 1;
        if part.part_number != expected {
          return Err(map_gql_error(AuthError::InvalidInput(
            "multipart parts must be contiguous and sorted".to_string(),
          )));
        }
      }
      persisted_parts
        .into_iter()
        .map(|p| (p.part_number, p.etag))
        .collect::<Vec<_>>()
    };

    let mut merged = Vec::new();
    for (part_number, _) in &selected_parts {
      let part_storage_key = format!("{workspace_uuid}/multipart/{}/{:05}", active_upload_id, part_number);
      let part = state
        .storage()
        .read_blob(&part_storage_key)
        .await
        .map_err(|e| map_gql_error(AuthError::Storage(e.to_string())))?;
      merged.extend_from_slice(&part.data);
    }

    // MIME policy enforcement on the assembled blob — check before final write.
    enforce_mime_policy_gql(&state, &merged, normalized_key.as_str(), &metadata.mime).await?;

    let final_storage_key = format!("{workspace_uuid}/{}", normalized_key.as_str());
    state
      .storage()
      .write_blob(BlobWriteRequest {
        key: final_storage_key,
        content_type: Some(metadata.mime.clone()),
        body: Bytes::from(merged),
      })
      .await
      .map_err(|e| map_gql_error(AuthError::Storage(e.to_string())))?;
    state
      .blob()
      .complete_upload(workspace_uuid, normalized_key.as_str())
      .await
      .map_err(map_gql_error)?;
    state
      .blob()
      .clear_multipart_parts(workspace_uuid, normalized_key.as_str(), &active_upload_id)
      .await
      .map_err(map_gql_error)?;
    for (part_number, _) in &selected_parts {
      let part_storage_key = format!("{workspace_uuid}/multipart/{}/{:05}", active_upload_id, part_number);
      if let Err(e) = state.storage().delete_blob(&part_storage_key).await {
        warn!(workspace_id = %workspace_uuid, blob_key = %part_storage_key, error = %e, "blob part cleanup failed — orphan may remain");
      }
    }
    info!(
        user_id = %snapshot.user.id,
        workspace_id = %workspace_uuid,
        key = %normalized_key.as_str(),
        upload_id = %active_upload_id,
        parts = selected_parts.len(),
        "completed multipart blob upload"
    );
    Ok(normalized_key.as_str().to_string())
  }

  #[instrument(skip_all)]
  pub(crate) async fn abort_blob_upload(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    key: String,
    upload_id: String,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let normalized_key =
      BlobKey::parse(&key).map_err(|e| map_gql_error(AuthError::InvalidInput(format!("invalid blob key: {e}"))))?;

    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::BlobsWrite,
    )
    .await
    .map_err(map_gql_error)?;

    let metadata = state
      .blob()
      .get_blob_metadata(workspace_uuid, normalized_key.as_str())
      .await
      .map_err(map_gql_error)?
      .ok_or_else(|| map_gql_error(AuthError::InvalidInput("blob upload session not found".to_string())))?;
    if metadata.upload_id.as_deref() != Some(upload_id.as_str()) {
      return Err(map_gql_error(AuthError::InvalidInput("upload id mismatch".to_string())));
    }

    let parts = state
      .blob()
      .list_multipart_parts(workspace_uuid, normalized_key.as_str(), &upload_id)
      .await
      .map_err(map_gql_error)?;
    for part in &parts {
      let part_storage_key = format!("{workspace_uuid}/multipart/{}/{:05}", upload_id, part.part_number);
      if let Err(e) = state.storage().delete_blob(&part_storage_key).await {
        warn!(workspace_id = %workspace_uuid, blob_key = %part_storage_key, error = %e, "blob part cleanup on abort failed — orphan may remain");
      }
    }
    state
      .blob()
      .clear_multipart_parts(workspace_uuid, normalized_key.as_str(), &upload_id)
      .await
      .map_err(map_gql_error)?;
    state
      .blob()
      .set_upload_status(workspace_uuid, normalized_key.as_str(), BlobStatus::Failed)
      .await
      .map_err(map_gql_error)?;
    info!(
        user_id = %snapshot.user.id,
        workspace_id = %workspace_uuid,
        key = %normalized_key.as_str(),
        upload_id = %upload_id,
        "aborted multipart blob upload"
    );
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn delete_blob(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    hash: Option<String>,
    key: Option<String>,
    permanently: Option<bool>,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    let blob_key = key.or(hash).unwrap_or_default();
    if blob_key.trim().is_empty() {
      return Ok(false);
    }

    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::BlobsWrite,
      )
      .await
      .map_err(map_gql_error)?;

    if permanently.unwrap_or(false) {
      let _ = state
        .blob()
        .hard_delete_blob(workspace_uuid, &blob_key)
        .await
        .map_err(map_gql_error)?;
    } else {
      let _ = state
        .blob()
        .soft_delete_blob(workspace_uuid, &blob_key, Utc::now())
        .await
        .map_err(map_gql_error)?;
    }
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn release_deleted_blobs(&self, ctx: &Context<'_>, workspace_id: String) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::BlobsWrite,
      )
      .await
      .map_err(map_gql_error)?;
    let _ = state
      .blob()
      .release_deleted_blobs_in_workspace(workspace_uuid, Utc::now(), 5000)
      .await
      .map_err(map_gql_error)?;
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn link_calendar_account(
    &self,
    ctx: &Context<'_>,
    input: LinkCalendarAccountInput,
  ) -> Result<String> {
    let (state, snapshot) = require_session(ctx).await?;
    let provider = match input.provider {
      CalendarProviderType::Google => "google",
      CalendarProviderType::CalDav => "caldav",
    };
    let callback = format!(
      "{}/api/oauth/callback",
      state.config.server.origin.trim_end_matches('/')
    );
    let redirect = input.redirect_uri.unwrap_or_else(|| state.config.server.origin.clone());
    let state_token = Uuid::new_v4();
    let url = format!(
      "{}/oauth/{provider}/authorize?state={state_token}&redirect_uri={}&callback={}",
      state.config.server.origin.trim_end_matches('/'),
      urlencoding::encode(&redirect),
      urlencoding::encode(&callback)
    );
    info!(user_id = %snapshot.user.id, provider, "generated calendar oauth link");
    Ok(url)
  }

  #[instrument(skip_all)]
  pub(crate) async fn link_caldav_account(
    &self,
    ctx: &Context<'_>,
    input: LinkCalDAVAccountInput,
  ) -> Result<CalendarAccountObjectType> {
    let (state, snapshot) = require_session(ctx).await?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;

    let now = Utc::now();
    let account = calendar
      .upsert_account(myoxus_domain::entities::CalendarAccount {
        id: Uuid::new_v4(),
        user_id: snapshot.user.id,
        provider: "caldav".to_string(),
        remote_account_id: input.username.clone(),
        access_token_ciphertext: None,
        refresh_token_ciphertext: None,
        expires_at: None,
        config: serde_json::json!({
            "displayName": input.display_name,
            "status": "connected",
            "providerPresetId": input.provider_preset_id,
        }),
        created_at: now,
        updated_at: now,
      })
      .await
      .map_err(map_gql_error)?;
    info!(user_id = %snapshot.user.id, account_id = %account.id, "linked caldav account");
    let subscriptions = calendar
      .list_account_calendars(account.id)
      .await
      .map_err(map_gql_error)?;
    Ok(map_calendar_account_object(account, subscriptions))
  }

  #[instrument(skip_all)]
  pub(crate) async fn upsert_calendar_event(
    &self,
    ctx: &Context<'_>,
    input: CalendarEventInput,
  ) -> Result<CalendarEventType> {
    if input.ends_at < input.starts_at {
      return Err(map_gql_error(AuthError::InvalidInput(
        "invalid event time range: `endsAt` must be greater than or equal to `startsAt`".to_string(),
      )));
    }
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&input.workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(map_gql_error)?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;

    let participants = input
      .participants
      .into_iter()
      .map(|p| {
        Ok(myoxus_domain::entities::CalendarEventParticipant {
          id: Uuid::new_v4(),
          event_id: Uuid::nil(),
          user_id: p
            .user_id
            .as_deref()
            .map(Uuid::parse_str)
            .transpose()
            .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid participant user id".to_string())))?,
          email: p.email,
          display_name: p.display_name,
          response_status: p.response_status.unwrap_or_else(|| "needsAction".to_string()),
          is_organizer: p.is_organizer.unwrap_or(false),
          created_at: Utc::now(),
          updated_at: Utc::now(),
        })
      })
      .collect::<Result<Vec<_>>>()?;
    let reminders = input
      .reminders
      .into_iter()
      .map(|r| myoxus_domain::entities::CalendarReminder {
        id: Uuid::new_v4(),
        event_id: Uuid::nil(),
        channel: r.channel.unwrap_or_else(|| "in_app".to_string()),
        minutes_before: r.minutes_before,
        scheduled_for: r.scheduled_for,
        delivered_at: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
      })
      .collect::<Vec<_>>();

    let event_id = input
      .id
      .as_deref()
      .map(Uuid::parse_str)
      .transpose()
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid event id".to_string())))?
      .unwrap_or_else(Uuid::new_v4);
    let account_id = Uuid::parse_str(&input.account_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid account id".to_string())))?;
    let owns_account = calendar
      .list_accounts(snapshot.user.id)
      .await
      .map_err(map_gql_error)?
      .into_iter()
      .any(|account| account.id == account_id);
    if !owns_account {
      warn!(user_id = %snapshot.user.id, account_id = %account_id, "calendar account ownership check failed");
      return Err(map_gql_error(AuthError::InvalidInput(
        "calendar account not found for user".to_string(),
      )));
    }
    let source_external_id = source_external_id_input(input.source_external_id, input.source_doc_id)?;
    let source_doc_id = match source_external_id {
      MaybeUndefined::Value(Some(source_external_id)) => {
        Some(crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, &source_external_id).await?)
      }
      MaybeUndefined::Undefined | MaybeUndefined::Null | MaybeUndefined::Value(None) => None,
    };

    let mut participants = participants;
    for p in &mut participants {
      p.event_id = event_id;
    }
    let mut reminders = reminders;
    for r in &mut reminders {
      r.event_id = event_id;
    }

    let event = calendar
      .upsert_authored_event(CalendarEventUpsert {
        id: event_id,
        account_id,
        workspace_id: Some(workspace_uuid),
        remote_event_id: input.remote_event_id,
        starts_at: input.starts_at,
        ends_at: input.ends_at,
        title: input.title,
        source_doc_id,
        payload: serde_json::json!({}),
        participants,
        reminders,
      })
      .await
      .map_err(map_gql_error)?;
    info!(workspace_id = %workspace_uuid, event_id = %event.id, user_id = %snapshot.user.id, "upserted calendar event");
    map_calendar_event_for_workspace(&state, workspace_uuid, event).await
  }

  /// Delete a calendar event by ID (P90-CAL-E-08).
  ///
  /// If the event has a `remote_href` and `etag`, the write-through layer
  /// propagates the deletion to the remote provider.  Otherwise the event is
  /// deleted locally only.
  ///
  /// Returns `true` on success, `false` if the event was not found.
  #[instrument(skip_all)]
  pub(crate) async fn delete_calendar_event(&self, ctx: &Context<'_>, event_id: String) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let event_uuid =
      Uuid::parse_str(&event_id).map_err(|_| map_gql_error(AuthError::InvalidInput("invalid event id".to_string())))?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;
    // Verify the event exists and the caller owns the account.
    let event = calendar.get_event(event_uuid).await.map_err(map_gql_error)?;
    let Some(event) = event else {
      return Ok(false);
    };
    let owns_account = calendar
      .list_accounts(snapshot.user.id)
      .await
      .map_err(map_gql_error)?
      .into_iter()
      .any(|acc| Some(acc.id) == event.account_id);
    if !owns_account {
      warn!(user_id = %snapshot.user.id, event_id = %event_uuid, "delete_calendar_event: account ownership check failed");
      return Err(map_gql_error(AuthError::InvalidInput(
        "calendar account not found for user".to_string(),
      )));
    }
    calendar.delete_remote_event(event_uuid).await.map_err(map_gql_error)?;
    info!(event_id = %event_uuid, user_id = %snapshot.user.id, "deleted calendar event");
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn update_calendar_reminder_status(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    reminder_id: String,
    delivered: bool,
  ) -> Result<CalendarReminderStatusResult> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(map_gql_error)?;
    let reminder_uuid = Uuid::parse_str(&reminder_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid reminder id".to_string())))?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;
    calendar
      .mark_reminder_status(reminder_uuid, delivered, Some(Utc::now()))
      .await
      .map_err(map_gql_error)?;
    info!(workspace_id = %workspace_uuid, reminder_id = %reminder_uuid, delivered, user_id = %snapshot.user.id, "updated calendar reminder status");
    Ok(CalendarReminderStatusResult { ok: true })
  }

  /// Resolve a detected calendar conflict (P90-CAL-F-04).
  ///
  /// - `KEEP_LOCAL`   — the local version is authoritative; update the DB to
  ///                    clear the pending-conflict flag (Force-PUT would be done
  ///                    by the write-through layer in a future step).
  /// - `KEEP_REMOTE`  — overwrite the local DB event with the remote version.
  /// - `MERGE_AUTO`   — attempt a three-way auto-merge and apply the result.
  #[instrument(skip_all)]
  pub(crate) async fn resolve_calendar_conflict(
    &self,
    ctx: &Context<'_>,
    event_id: String,
    resolution: ConflictResolution,
    base_version: Option<serde_json::Value>,
  ) -> async_graphql::Result<CalendarEventType> {
    use myoxus_application::calendar::{MergeResult, merge_calendar_events};

    let (state, snapshot) = require_session(ctx).await?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;

    let event_uuid =
      Uuid::parse_str(&event_id).map_err(|_| map_gql_error(AuthError::InvalidInput("invalid event id".to_string())))?;

    // Fetch the current local event from DB.
    let local_event = calendar
      .get_event(event_uuid)
      .await
      .map_err(map_gql_error)?
      .ok_or_else(|| map_gql_error(AuthError::NotFound("calendar event not found".to_string())))?;

    match resolution {
      ConflictResolution::KeepLocal => {
        // The local version wins. Return it as-is.
        // (Force-push to remote is handled by the write-through layer.)
        info!(event_id = %event_uuid, user_id = %snapshot.user.id, "conflict resolved: KEEP_LOCAL");
        map_calendar_event_from_owner(&state, local_event).await
      }
      ConflictResolution::KeepRemote => {
        // We don't have a "remote_version" here because F-02 (conflict
        // detection during write) would have stored the remote in the
        // pending-conflict table. For now, return the local event unchanged
        // and log the intent. Full implementation requires F-02 first.
        warn!(
          event_id = %event_uuid,
          user_id = %snapshot.user.id,
          "resolve_calendar_conflict: KEEP_REMOTE requires write-through (F-02); returning local"
        );
        map_calendar_event_from_owner(&state, local_event).await
      }
      ConflictResolution::MergeAuto => {
        // Attempt a three-way merge.  The `base_version` JSON payload must
        // contain the common ancestor version.  `base_version.remote` must
        // provide the remote (theirs) version; without it we cannot merge.
        let (base, remote_event) = if let Some(ref base_json) = base_version {
          // Expect: { "base": { CalendarEvent fields }, "remote": { CalendarEvent fields } }
          let base_ev: Option<myoxus_domain::entities::CalendarEvent> = base_json
            .get("base")
            .and_then(|v| serde_json::from_value(v.clone()).ok());
          let remote_ev: Option<myoxus_domain::entities::CalendarEvent> = base_json
            .get("remote")
            .and_then(|v| serde_json::from_value(v.clone()).ok());
          match (base_ev, remote_ev) {
            (Some(b), Some(r)) => (b, r),
            _ => {
              return Err(map_gql_error(AuthError::InvalidInput(
                "no conflict data available, cannot merge: base_version must contain 'base' and 'remote' fields"
                  .to_string(),
              )));
            }
          }
        } else {
          return Err(map_gql_error(AuthError::InvalidInput(
            "no conflict data available, cannot merge: base_version is required for MERGE_AUTO".to_string(),
          )));
        };

        let merge_result = merge_calendar_events(&base, &local_event, &remote_event);
        let merged = match merge_result {
          MergeResult::Merged(m) => *m,
          MergeResult::Conflicts(cs) => {
            let fields: Vec<String> = cs.iter().map(|c| c.field.clone()).collect();
            return Err(map_gql_error(AuthError::InvalidInput(format!(
              "auto-merge conflicts on fields [{}]: provide explicit resolution",
              fields.join(", ")
            ))));
          }
        };

        info!(
          event_id = %event_uuid,
          user_id = %snapshot.user.id,
          "conflict resolved: MERGE_AUTO"
        );
        map_calendar_event_from_owner(&state, merged).await
      }
    }
  }

  /// Update or split a single recurrence instance (P90-CAL-I-01, I-02).
  #[instrument(skip_all)]
  pub(crate) async fn update_calendar_event_instance(
    &self,
    ctx: &Context<'_>,
    input: UpdateCalendarEventInstanceInput,
  ) -> Result<UpdateCalendarEventInstanceResult> {
    let (state, snapshot) = require_session(ctx).await?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;

    let event_uuid = uuid::Uuid::parse_str(input.event_id.as_str())
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid event id".to_string())))?;

    // Ownership check: caller must own the calendar account the event belongs to.
    {
      let event = calendar
        .get_event(event_uuid)
        .await
        .map_err(map_gql_error)?
        .ok_or_else(|| map_gql_error(AuthError::NotFound("calendar event not found".to_string())))?;
      let owns_account = calendar
        .list_accounts(snapshot.user.id)
        .await
        .map_err(map_gql_error)?
        .into_iter()
        .any(|acc| Some(acc.id) == event.account_id);
      if !owns_account {
        warn!(user_id = %snapshot.user.id, event_id = %event_uuid, "update_calendar_event_instance: ownership check failed");
        return Err(map_gql_error(AuthError::ActionForbidden));
      }
    }

    match input.scope {
      InstanceEditScope::ThisOnly => {
        let instance = calendar
          .update_event_instance(event_uuid, input.instance_start, input.changes)
          .await
          .map_err(map_gql_error)?;
        let result_instance = CalendarEventInstanceType {
          id: async_graphql::ID::from(instance.id.to_string()),
          event_id: async_graphql::ID::from(instance.event_id.to_string()),
          instance_start: instance.instance_start,
          instance_end: instance.instance_end,
          is_override: instance.is_override,
          is_cancelled: instance.is_cancelled,
          title: instance
            .override_payload
            .as_ref()
            .and_then(|p| p.get("title"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
          description: instance
            .override_payload
            .as_ref()
            .and_then(|p| p.get("description"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
          location: instance
            .override_payload
            .as_ref()
            .and_then(|p| p.get("location"))
            .and_then(|v| v.as_str())
            .map(ToString::to_string),
        };
        info!(event_id = %event_uuid, "recurring instance updated (THIS_ONLY)");
        Ok(UpdateCalendarEventInstanceResult {
          ok: true,
          instance: Some(result_instance),
        })
      }
      InstanceEditScope::ThisAndFuture => {
        calendar
          .split_recurring_event(event_uuid, input.instance_start, input.changes)
          .await
          .map_err(map_gql_error)?;
        info!(event_id = %event_uuid, "recurring series split (THIS_AND_FUTURE)");
        Ok(UpdateCalendarEventInstanceResult {
          ok: true,
          instance: None,
        })
      }
      InstanceEditScope::All => {
        calendar
          .update_recurring_series(event_uuid, input.changes)
          .await
          .map_err(map_gql_error)?;
        info!(event_id = %event_uuid, "ALL scope: recurring series updated");
        Ok(UpdateCalendarEventInstanceResult {
          ok: true,
          instance: None,
        })
      }
    }
  }

  /// Delete a single recurrence instance or the entire series (P90-CAL-I-03..I-05).
  #[instrument(skip_all)]
  pub(crate) async fn delete_calendar_event_instance(
    &self,
    ctx: &Context<'_>,
    event_id: String,
    instance_start: chrono::DateTime<Utc>,
    scope: InstanceEditScope,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;

    let event_uuid = uuid::Uuid::parse_str(&event_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid event id".to_string())))?;

    // Ownership check: caller must own the calendar account the event belongs to.
    {
      let event = calendar
        .get_event(event_uuid)
        .await
        .map_err(map_gql_error)?
        .ok_or_else(|| map_gql_error(AuthError::NotFound("calendar event not found".to_string())))?;
      let owns_account = calendar
        .list_accounts(snapshot.user.id)
        .await
        .map_err(map_gql_error)?
        .into_iter()
        .any(|acc| Some(acc.id) == event.account_id);
      if !owns_account {
        warn!(user_id = %snapshot.user.id, event_id = %event_uuid, "delete_calendar_event_instance: ownership check failed");
        return Err(map_gql_error(AuthError::ActionForbidden));
      }
    }

    match scope {
      InstanceEditScope::ThisOnly => {
        calendar
          .cancel_event_instance(event_uuid, instance_start)
          .await
          .map_err(map_gql_error)?;
        info!(event_id = %event_uuid, "instance cancelled (EXDATE)");
        Ok(true)
      }
      InstanceEditScope::ThisAndFuture => {
        calendar
          .truncate_recurring_series(event_uuid, instance_start)
          .await
          .map_err(map_gql_error)?;
        info!(event_id = %event_uuid, "series truncated (THIS_AND_FUTURE delete)");
        Ok(true)
      }
      InstanceEditScope::All => {
        calendar
          .delete_recurring_series(event_uuid)
          .await
          .map_err(map_gql_error)?;
        info!(event_id = %event_uuid, "series deleted (ALL)");
        Ok(true)
      }
    }
  }

  #[instrument(skip_all)]
  pub(crate) async fn update_calendar_account(
    &self,
    ctx: &Context<'_>,
    account_id: Option<String>,
    refresh_interval_minutes: Option<i32>,
    input: Option<UpdateCalendarAccountInput>,
  ) -> Result<Option<CalendarAccountObjectType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;
    let account_id = account_id
      .or_else(|| input.as_ref().map(|value| value.account_id.clone()))
      .ok_or_else(|| map_gql_error(AuthError::InvalidInput("account id is required".to_string())))?;
    let account_id = Uuid::parse_str(&account_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid account id".to_string())))?;
    let mut accounts = calendar.list_accounts(snapshot.user.id).await.map_err(map_gql_error)?;
    let Some(mut account) = accounts.drain(..).find(|value| value.id == account_id) else {
      return Ok(None);
    };
    let refresh_interval_minutes = refresh_interval_minutes
      .or_else(|| {
        input
          .as_ref()
          .and_then(|value| value.config.as_ref())
          .and_then(|config| config.get("refreshIntervalMinutes"))
          .and_then(|value| value.as_i64())
          .map(|value| value as i32)
      })
      .unwrap_or(15)
      .clamp(1, 24 * 60);
    account.expires_at = input.as_ref().and_then(|value| value.expires_at);
    let mut config = account.config.clone();
    if let Some(payload) = input.and_then(|value| value.config) {
      config = payload;
    }
    config["refreshIntervalMinutes"] = serde_json::json!(refresh_interval_minutes);
    account.config = config;
    account.updated_at = Utc::now();
    let updated = calendar.update_account(account).await.map_err(map_gql_error)?;
    let subscriptions = calendar
      .list_account_calendars(updated.id)
      .await
      .map_err(map_gql_error)?;
    Ok(Some(map_calendar_account_object(updated, subscriptions)))
  }

  /// Update the RSVP status of the current user for a calendar event (P90-CAL-H-04).
  ///
  /// `eventId` — the local UUID of the `calendar_events` row.
  /// `status`  — one of `ACCEPTED`, `DECLINED`, `TENTATIVE`, `NEEDS_ACTION`.
  ///
  /// Requires the caller to be a participant in the event.  Returns the updated
  /// event with the refreshed participant list.
  #[instrument(skip_all)]
  pub(crate) async fn update_calendar_event_rsvp(
    &self,
    ctx: &Context<'_>,
    event_id: String,
    status: CalendarRsvpStatus,
  ) -> Result<CalendarEventType> {
    let (state, snapshot) = require_session(ctx).await?;
    let event_uuid =
      Uuid::parse_str(&event_id).map_err(|_| map_gql_error(AuthError::InvalidInput("invalid event id".to_string())))?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;
    // Ownership check: caller must own the calendar account or be a participant.
    {
      let event = calendar
        .get_event(event_uuid)
        .await
        .map_err(map_gql_error)?
        .ok_or_else(|| map_gql_error(AuthError::NotFound("calendar event not found".to_string())))?;
      let owns_account = calendar
        .list_accounts(snapshot.user.id)
        .await
        .map_err(map_gql_error)?
        .into_iter()
        .any(|acc| Some(acc.id) == event.account_id);
      let is_participant = event.participants.iter().any(|p| p.user_id == Some(snapshot.user.id));
      if !owns_account && !is_participant {
        warn!(user_id = %snapshot.user.id, event_id = %event_uuid, "update_calendar_event_rsvp: ownership check failed");
        return Err(map_gql_error(AuthError::ActionForbidden));
      }
    }

    let rsvp_status: myoxus_application::calendar::RsvpStatus = status.into();
    let updated = calendar
      .update_rsvp(event_uuid, snapshot.user.id, rsvp_status)
      .await
      .map_err(map_gql_error)?;
    info!(
      event_id = %event_uuid,
      user_id = %snapshot.user.id,
      "RSVP updated via GraphQL mutation"
    );
    map_calendar_event_from_owner(&state, updated).await
  }

  #[instrument(skip_all)]
  pub(crate) async fn unlink_calendar_account(&self, ctx: &Context<'_>, account_id: String) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let account_uuid = Uuid::parse_str(&account_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid account id".to_string())))?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;
    calendar
      .unlink_account(account_uuid, snapshot.user.id)
      .await
      .map_err(map_gql_error)?;
    Ok(true)
  }

  #[instrument(skip_all)]
  pub(crate) async fn update_workspace_calendars(
    &self,
    ctx: &Context<'_>,
    input: UpdateWorkspaceCalendarsInput,
  ) -> Result<WorkspaceCalendarObjectType> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&input.workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(map_gql_error)?;
    let calendar_service = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service is not configured".to_string())))?;
    let owned_accounts: HashSet<Uuid> = calendar_service
      .list_accounts(snapshot.user.id)
      .await
      .map_err(map_gql_error)?
      .into_iter()
      .map(|value| value.id)
      .collect();
    let mut saved = Vec::new();
    for item in input.items {
      let Some((account_id, remote_calendar_id)) = parse_subscription_id(&item.subscription_id) else {
        return Err(map_gql_error(AuthError::InvalidInput(
          "invalid subscription id".to_string(),
        )));
      };
      if !owned_accounts.contains(&account_id) {
        warn!(user_id = %snapshot.user.id, workspace_id = %workspace_uuid, account_id = %account_id, "calendar account ownership check failed");
        return Err(map_gql_error(AuthError::InvalidInput(
          "calendar account not found for user".to_string(),
        )));
      }
      let value = calendar_service
        .upsert_workspace_calendar(myoxus_domain::entities::WorkspaceCalendar {
          workspace_id: workspace_uuid,
          account_id,
          remote_calendar_id,
          enabled: true,
          updated_at: Utc::now(),
        })
        .await
        .map_err(map_gql_error)?;
      saved.push(value);
    }
    let primary = saved
      .first()
      .ok_or_else(|| {
        map_gql_error(AuthError::InvalidInput(
          "workspace calendar items must not be empty".to_string(),
        ))
      })?
      .clone();
    Ok(map_workspace_calendar_object(primary, snapshot.user.id))
  }

  // ── Native-event mutations (P-JCAL-SERVER-03-B) ───────────────────────────

  /// Create a workspace-native calendar event.
  ///
  /// Enforces INV-CAL-NATIVE-03 (workspace write permission).
  #[instrument(skip_all)]
  pub(crate) async fn create_workspace_event(
    &self,
    ctx: &Context<'_>,
    input: CreateWorkspaceEventInput,
  ) -> Result<CalendarEventType> {
    if input.ends_at < input.starts_at {
      return Err(map_gql_error(AuthError::InvalidInput(
        "endsAt must be >= startsAt".to_string(),
      )));
    }
    let (state, snapshot) = require_session(ctx).await?;
    let native = state
      .native_event_service()
      .ok_or_else(|| map_gql_error(AuthError::Storage("native event service not configured".to_string())))?;
    let workspace_uuid = Uuid::parse_str(&input.workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace_id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::CreateDoc,
      )
      .await
      .map_err(map_gql_error)?;
    let tag_id = input
      .tag_id
      .as_deref()
      .map(Uuid::parse_str)
      .transpose()
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid tag_id".to_string())))?;
    let source_external_id = source_external_id_input(input.source_external_id, input.source_doc_id)?;
    let source_doc_id = match source_external_id {
      MaybeUndefined::Value(Some(source_external_id)) => {
        Some(crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, &source_external_id).await?)
      }
      MaybeUndefined::Undefined | MaybeUndefined::Null | MaybeUndefined::Value(None) => None,
    };
    let source_anchor = source_anchor_from_input(
      input.source_block_id,
      input.source_start_offset,
      input.source_end_offset,
      input.source_kind,
    )?;
    if source_anchor.is_some() && source_doc_id.is_none() {
      return Err(map_gql_error(AuthError::InvalidInput(
        "sourceExternalId is required when source anchor fields are provided".to_string(),
      )));
    }
    let reminders: Vec<NativeSvcReminderInput> = input
      .reminders
      .unwrap_or_default()
      .into_iter()
      .map(|r| NativeSvcReminderInput {
        minutes_before: r.minutes_before,
        channel: r.channel.unwrap_or_else(|| "in_app".to_string()),
      })
      .collect();
    let svc_input = NativeCreateInput {
      title: input.title,
      description_delta: input.description_delta.map(|j| j.0),
      starts_at: input.starts_at,
      ends_at: input.ends_at,
      all_day: input.all_day.unwrap_or(false),
      all_members: input.all_members.unwrap_or(false),
      tag_id,
      source_doc_id,
      source_anchor,
      reminders,
    };
    let event = native
      .create(workspace_uuid, snapshot.user.id, svc_input)
      .await
      .map_err(map_gql_error)?;
    map_calendar_event_for_workspace(&state, workspace_uuid, event).await
  }

  /// Update a workspace-native calendar event.
  ///
  /// scope=All edits the master; scope=This creates an EXDATE + override row.
  /// Returns `FORBIDDEN` for external events (INV-CAL-NATIVE-02).
  #[instrument(skip_all)]
  pub(crate) async fn update_workspace_event(
    &self,
    ctx: &Context<'_>,
    event_id: String,
    workspace_id: String,
    scope: NativeEventScope,
    instance_start: Option<chrono::DateTime<chrono::Utc>>,
    input: UpdateWorkspaceEventInput,
  ) -> Result<CalendarEventType> {
    let (state, snapshot) = require_session(ctx).await?;
    let native = state
      .native_event_service()
      .ok_or_else(|| map_gql_error(AuthError::Storage("native event service not configured".to_string())))?;
    let event_uuid =
      Uuid::parse_str(&event_id).map_err(|_| map_gql_error(AuthError::InvalidInput("invalid event_id".to_string())))?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace_id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::CreateDoc,
      )
      .await
      .map_err(map_gql_error)?;
    let update_scope = match scope {
      NativeEventScope::All => UpdateScope::All,
      NativeEventScope::This => {
        let is = instance_start.ok_or_else(|| {
          map_gql_error(AuthError::InvalidInput(
            "instance_start is required when scope=This".to_string(),
          ))
        })?;
        UpdateScope::This { instance_start: is }
      }
    };
    let tag_id = optional_uuid_patch(input.tag_id, "tagId")?;
    let source_external_id = source_external_id_input(input.source_external_id, input.source_doc_id)?;
    let source_doc_id = match source_external_id {
      MaybeUndefined::Undefined => None,
      MaybeUndefined::Null | MaybeUndefined::Value(None) => Some(None),
      MaybeUndefined::Value(Some(source_doc_id)) => Some(Some(
        crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, &source_doc_id).await?,
      )),
    };
    let source_block_id = optional_string_patch(input.source_block_id);
    let source_start_offset = optional_i32_patch(input.source_start_offset);
    let source_end_offset = optional_i32_patch(input.source_end_offset);
    let source_kind = optional_string_patch(input.source_kind);
    let has_source_anchor_fields = source_block_id.is_some()
      || source_start_offset.is_some()
      || source_end_offset.is_some()
      || source_kind.is_some();
    let source_anchor = if has_source_anchor_fields {
      let anchor = source_anchor_from_input(
        source_block_id.flatten(),
        source_start_offset.flatten(),
        source_end_offset.flatten(),
        source_kind.flatten(),
      )?
      .unwrap_or_default();
      Some(Some(anchor))
    } else if source_doc_id == Some(None) {
      Some(None)
    } else {
      None
    };
    let reminders = match input.reminders {
      MaybeUndefined::Undefined => None,
      MaybeUndefined::Null | MaybeUndefined::Value(None) => Some(Vec::new()),
      MaybeUndefined::Value(Some(reminders)) => Some(
        reminders
          .into_iter()
          .map(|reminder| NativeEventReminderInput {
            minutes_before: reminder.minutes_before,
            channel: reminder.channel.unwrap_or_else(|| "in_app".to_string()),
          })
          .collect(),
      ),
    };
    let repo_update = NativeEventUpdate {
      title: input.title.map(Some),
      description_delta: input.description_delta.map(|j| Some(j.0)),
      starts_at: input.starts_at,
      ends_at: input.ends_at,
      all_day: input.all_day,
      all_members: input.all_members,
      tag_id,
      source_doc_id,
      source_anchor,
      reminders,
    };
    let event = native
      .update(event_uuid, workspace_uuid, snapshot.user.id, update_scope, repo_update)
      .await
      .map_err(map_gql_error)?;
    map_calendar_event_for_workspace(&state, workspace_uuid, event).await
  }

  /// Delete a workspace-native calendar event.
  ///
  /// scope=All removes the master (FK cascade removes overrides).
  /// scope=This adds an EXDATE, hiding the single occurrence.
  /// Returns `FORBIDDEN` for external events (INV-CAL-NATIVE-02).
  #[instrument(skip_all)]
  pub(crate) async fn delete_workspace_event(
    &self,
    ctx: &Context<'_>,
    event_id: String,
    workspace_id: String,
    scope: NativeEventScope,
    instance_start: Option<chrono::DateTime<chrono::Utc>>,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let native = state
      .native_event_service()
      .ok_or_else(|| map_gql_error(AuthError::Storage("native event service not configured".to_string())))?;
    let event_uuid =
      Uuid::parse_str(&event_id).map_err(|_| map_gql_error(AuthError::InvalidInput("invalid event_id".to_string())))?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace_id".to_string())))?;
    let delete_scope = match scope {
      NativeEventScope::All => DeleteScope::All,
      NativeEventScope::This => {
        let is = instance_start.ok_or_else(|| {
          map_gql_error(AuthError::InvalidInput(
            "instance_start is required when scope=This".to_string(),
          ))
        })?;
        DeleteScope::This { instance_start: is }
      }
    };
    native
      .delete(event_uuid, workspace_uuid, snapshot.user.id, delete_scope)
      .await
      .map_err(map_gql_error)?;
    Ok(true)
  }

  /// Create a workspace event tag.
  ///
  /// Enforces workspace write permission (INV-CAL-TAG-01).
  #[instrument(skip_all)]
  pub(crate) async fn create_event_tag(
    &self,
    ctx: &Context<'_>,
    input: CreateEventTagInput,
  ) -> Result<CalendarEventTagType> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&input.workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace_id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(map_gql_error)?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service not configured".to_string())))?;
    let tag = calendar
      .insert_event_tag(workspace_uuid, &input.name, &input.color)
      .await
      .map_err(map_gql_error)?;
    Ok(map_calendar_event_tag(tag))
  }

  /// Update an existing workspace event tag.
  #[instrument(skip_all)]
  pub(crate) async fn update_event_tag(
    &self,
    ctx: &Context<'_>,
    tag_id: String,
    input: UpdateEventTagInput,
  ) -> Result<CalendarEventTagType> {
    let (state, snapshot) = require_session(ctx).await?;
    let tag_uuid =
      Uuid::parse_str(&tag_id).map_err(|_| map_gql_error(AuthError::InvalidInput("invalid tag_id".to_string())))?;
    let workspace_uuid = Uuid::parse_str(&input.workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace_id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(map_gql_error)?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service not configured".to_string())))?;
    let tag = calendar
      .update_event_tag(tag_uuid, workspace_uuid, input.name.as_deref(), input.color.as_deref())
      .await
      .map_err(map_gql_error)?;
    Ok(map_calendar_event_tag(tag))
  }

  /// Delete a workspace event tag.
  ///
  /// Events referencing the tag will have their `tag_id` set to NULL (FK SET NULL).
  #[instrument(skip_all)]
  pub(crate) async fn delete_event_tag(&self, ctx: &Context<'_>, tag_id: String, workspace_id: String) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let tag_uuid =
      Uuid::parse_str(&tag_id).map_err(|_| map_gql_error(AuthError::InvalidInput("invalid tag_id".to_string())))?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace_id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(map_gql_error)?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service not configured".to_string())))?;
    calendar
      .delete_event_tag(tag_uuid, workspace_uuid)
      .await
      .map_err(map_gql_error)?;
    Ok(true)
  }

  /// Update workspace-level calendar settings (writeback target + default reminder).
  ///
  /// Requires SettingsUpdate permission on the workspace.
  #[instrument(skip_all)]
  pub(crate) async fn update_workspace_calendar_settings(
    &self,
    ctx: &Context<'_>,
    input: UpdateWorkspaceCalendarSettingsInput,
  ) -> Result<WorkspaceCalendarSettingsType> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&input.workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace_id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(map_gql_error)?;
    let writeback_sub_id = input
      .writeback_subscription_id
      .as_deref()
      .map(Uuid::parse_str)
      .transpose()
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid writeback_subscription_id".to_string())))?;
    let calendar = state
      .calendar()
      .ok_or_else(|| map_gql_error(AuthError::Storage("calendar service not configured".to_string())))?;
    let settings = calendar
      .upsert_workspace_calendar_settings(workspace_uuid, writeback_sub_id, input.default_reminder_offset_minutes)
      .await
      .map_err(map_gql_error)?;
    Ok(map_workspace_calendar_settings(settings))
  }

  /// Import events from a RFC 5545 VCALENDAR blob into a workspace
  /// (P-JCAL-SERVER-07-B).
  ///
  /// Each VEVENT is created as a workspace-native event. VEVENTs that cannot
  /// be mapped (e.g. zero-duration or malformed dates) are counted in
  /// `skipped_count`. A 5 MiB hard limit is enforced on `ics_body`.
  #[instrument(skip_all)]
  pub(crate) async fn import_workspace_calendar_ics(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    ics_body: String,
  ) -> Result<CalendarIcsImportResult> {
    const MAX_ICS_BYTES: usize = 5 * 1024 * 1024;
    if ics_body.len() > MAX_ICS_BYTES {
      return Err(map_gql_error(AuthError::InvalidInput(format!(
        "ics_body exceeds maximum allowed size ({MAX_ICS_BYTES} bytes)"
      ))));
    }
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace_id".to_string())))?;
    state
      .permission_service()
      .assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::SettingsUpdate,
      )
      .await
      .map_err(map_gql_error)?;
    let native = state
      .native_event_service()
      .ok_or_else(|| map_gql_error(AuthError::Storage("native event service not configured".to_string())))?;

    let parsed = myoxus_infrastructure::caldav::parse_ical_events(&ics_body);
    let mut imported_count = 0i32;
    let mut skipped_count = 0i32;
    let mut errors: Vec<String> = Vec::new();

    for vevent in parsed {
      if vevent.ends_at <= vevent.starts_at {
        skipped_count += 1;
        errors.push(format!("UID {}: ends_at <= starts_at, skipped", vevent.uid));
        continue;
      }
      let create_input = NativeCreateInput {
        title: vevent.summary,
        description_delta: None,
        starts_at: vevent.starts_at,
        ends_at: vevent.ends_at,
        all_day: vevent.all_day,
        all_members: false,
        tag_id: None,
        source_doc_id: None,
        source_anchor: None,
        reminders: vec![],
      };
      match native.create(workspace_uuid, snapshot.user.id, create_input).await {
        Ok(_) => imported_count += 1,
        Err(e) => {
          skipped_count += 1;
          errors.push(format!("UID {}: {e}", vevent.uid));
        }
      }
    }

    info!(
      workspace_id = %workspace_uuid,
      user_id = %snapshot.user.id,
      imported_count,
      skipped_count,
      "imported ICS calendar"
    );
    Ok(CalendarIcsImportResult {
      imported_count,
      skipped_count,
      errors,
    })
  }

  #[instrument(skip_all)]
  pub(crate) async fn create_copilot_session(
    &self,
    ctx: &Context<'_>,
    options: CreateChatSessionInput,
  ) -> Result<String> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_id = Uuid::parse_str(&options.workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    assert_copilot_workspace_access(&state, snapshot.user.id, workspace_id, "create_copilot_session").await?;
    let doc_id = match options.doc_id.as_deref() {
      Some(key) => Some(resolve_doc_id(&state, workspace_id, key).await?),
      None => None,
    };
    if let Some(doc_id) = doc_id {
      assert_copilot_doc_access(&state, snapshot.user.id, workspace_id, doc_id).await?;
    }
    let session = state
      .copilot()
      .create_session(
        snapshot.user.id,
        Some(workspace_id),
        doc_id,
        None,
        None,
        serde_json::json!({
            "promptName": options.prompt_name,
            "reuseLatestChat": options.reuse_latest_chat.unwrap_or(true),
        }),
      )
      .await
      .map_err(map_gql_error)?;
    if let Some(pinned) = options.pinned {
      state
        .copilot()
        .update_session(session.id, None, Some(pinned), None, None, None)
        .await
        .map_err(map_gql_error)?;
    }
    Ok(session.id.to_string())
  }

  #[instrument(skip_all)]
  pub(crate) async fn create_copilot_session_with_history(
    &self,
    ctx: &Context<'_>,
    options: CreateChatSessionInput,
  ) -> Result<CopilotHistoriesType> {
    let created_id = self.create_copilot_session(ctx, options).await?;
    let state = ctx.data::<Arc<ApiState>>().map_err(|_| "Internal error")?;
    let session_uuid =
      Uuid::parse_str(&created_id).map_err(|_| map_gql_error(AuthError::Storage("invalid session id".to_string())))?;
    let session = state.copilot().get_session(session_uuid).await.map_err(map_gql_error)?;
    let workspace_id = session
      .workspace_id
      .ok_or_else(|| map_gql_error(AuthError::Storage("workspace id missing on session".to_string())))?;
    let doc_keys = match session.doc_id {
      Some(id) => state
        .doc()
        .resolve_external_doc_ids(workspace_id, &[id])
        .await
        .map_err(map_gql_error)?,
      None => std::collections::HashMap::new(),
    };
    map_copilot_history(session, workspace_id, Vec::new(), &doc_keys)
  }

  #[instrument(skip_all)]
  pub(crate) async fn update_copilot_session(
    &self,
    ctx: &Context<'_>,
    options: UpdateChatSessionInput,
  ) -> Result<String> {
    let (state, snapshot) = require_session(ctx).await?;
    let session_id = Uuid::parse_str(&options.session_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid session id".to_string())))?;
    let existing = state.copilot().get_session(session_id).await.map_err(map_gql_error)?;
    assert_copilot_session_access(&state, snapshot.user.id, &existing, "update_copilot_session").await?;
    let metadata_patch = options
      .prompt_name
      .map(|value| serde_json::json!({"promptName": value}));
    let doc_id_patch = if let Some(key) = options.doc_id.as_deref() {
      let workspace_id = existing
        .workspace_id
        .ok_or_else(|| map_gql_error(AuthError::ActionForbidden))?;
      Some(Some(resolve_doc_id(&state, workspace_id, key).await?))
    } else {
      None
    };
    if let Some(Some(doc_id)) = doc_id_patch {
      let workspace_id = existing
        .workspace_id
        .ok_or_else(|| map_gql_error(AuthError::ActionForbidden))?;
      assert_copilot_doc_access(&state, snapshot.user.id, workspace_id, doc_id).await?;
    }
    state
      .copilot()
      .update_session(
        session_id,
        options.title,
        options.pinned,
        doc_id_patch,
        None,
        metadata_patch,
      )
      .await
      .map_err(map_gql_error)?;
    Ok(session_id.to_string())
  }

  #[instrument(skip_all)]
  pub(crate) async fn cleanup_copilot_session(
    &self,
    ctx: &Context<'_>,
    options: DeleteSessionInput,
  ) -> Result<Vec<String>> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_id = Uuid::parse_str(&options.workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;
    assert_copilot_workspace_access(&state, snapshot.user.id, workspace_id, "cleanup_copilot_session").await?;

    let mut deleted = Vec::new();
    for session_id in options.session_ids {
      let session_uuid = Uuid::parse_str(&session_id)
        .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid session id".to_string())))?;
      let session = state.copilot().get_session(session_uuid).await.map_err(map_gql_error)?;
      if session.user_id != snapshot.user.id || session.workspace_id != Some(workspace_id) {
        continue;
      }
      assert_copilot_session_access(&state, snapshot.user.id, &session, "cleanup_copilot_session").await?;
      state
        .copilot()
        .delete_session(session_uuid)
        .await
        .map_err(map_gql_error)?;
      deleted.push(session_uuid.to_string());
    }
    Ok(deleted)
  }

  #[instrument(skip_all)]
  pub(crate) async fn export_copilot_message(
    &self,
    ctx: &Context<'_>,
    message_id: ID,
    format: super::CopilotExportFormat,
  ) -> Result<super::CopilotGeneratedFileType> {
    let (state, snapshot) = require_session(ctx).await?;
    let id = Uuid::parse_str(message_id.as_str())
      .map_err(|_| map_gql_error(AuthError::InvalidInput("Invalid message ID".into())))?;
    let message = state.copilot().get_message(id).await.map_err(map_gql_error)?;
    let session = state
      .copilot()
      .get_session(message.session_id)
      .await
      .map_err(map_gql_error)?;
    assert_copilot_session_access(&state, snapshot.user.id, &session, "export_copilot_message").await?;
    let locale = state
      .auth()
      .get_user_preferences(snapshot.user.id)
      .await
      .map_err(map_gql_error)?
      .values
      .locale
      .unwrap_or_else(|| state.config.i18n.default_locale.clone());
    let format = match format {
      super::CopilotExportFormat::Pdf => myoxus_domain::entities::CopilotFileFormat::Pdf,
      super::CopilotExportFormat::Html => myoxus_domain::entities::CopilotFileFormat::Html,
    };
    let file = crate::handlers::copilot::file_service(state, snapshot.user.id)
      .export(id, format, locale)
      .await
      .map_err(map_gql_error)?;
    crate::handlers::copilot::file_descriptor(&file)
      .ok_or_else(|| async_graphql::Error::new("Export file metadata unavailable"))
  }

  pub(crate) async fn create_copilot_message(
    &self,
    ctx: &Context<'_>,
    options: CreateChatMessageInput,
  ) -> Result<String> {
    let (state, snapshot) = require_session(ctx).await?;
    let session_id = Uuid::parse_str(&options.session_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid session id".to_string())))?;
    let session = state.copilot().get_session(session_id).await.map_err(map_gql_error)?;
    assert_copilot_session_access(&state, snapshot.user.id, &session, "create_copilot_message").await?;
    let attachment_refs = options
      .attachments
      .unwrap_or_default()
      .into_iter()
      .map(|key| CopilotAttachmentRef {
        id: Uuid::new_v4(),
        message_id: Uuid::nil(),
        blob_key: key,
        file_name: None,
        mime_type: None,
        size_bytes: None,
        metadata: serde_json::json!({}),
        created_at: Utc::now(),
      })
      .collect::<Vec<_>>();
    let message = state
      .copilot()
      .submit_user_message(
        snapshot.user.id,
        session_id,
        serde_json::json!({ "text": options.content.unwrap_or_default() }),
        options.params,
        attachment_refs,
        options.request_id,
      )
      .await
      .map_err(map_gql_error)?;
    Ok(message.id.to_string())
  }

  /// Adopt a copilot-generated blob into the workspace blob store.
  ///
  /// Copilot blobs are stored ephemerally under a `{user_id}/{workspace_id}/{filename}`
  /// key and are not tracked in the `blobs` DB table — they are subject to nightly
  /// cleanup once the session that produced them is deleted.  This mutation copies the
  /// bytes into the workspace blob store (under `{workspace_id}/{new_key}`) and creates
  /// a `blobs` DB record so the blob is permanent and accessible via the regular blob API.
  ///
  /// `copilot_blob_key` must be a path of the form `{user_id}/{workspace_id}/{filename}`
  /// where `user_id` matches the authenticated caller.
  ///
  /// Returns the new workspace-scoped blob key on success.
  #[instrument(skip_all)]
  pub(crate) async fn adopt_copilot_blob(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    copilot_blob_key: String,
  ) -> Result<String> {
    let (state, snapshot) = require_session(ctx).await?;

    let workspace_uuid = Uuid::parse_str(&workspace_id)
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid workspace id".to_string())))?;

    // Permission: caller must be a workspace member with blob-write access.
    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::BlobsWrite,
    )
    .await
    .map_err(map_gql_error)?;

    // Validate the copilot key format: must be "{user_id}/{workspace_id}/{filename}".
    // Split into exactly 3 segments.
    let parts: Vec<&str> = copilot_blob_key.splitn(3, '/').collect();
    if parts.len() != 3 || parts[2].is_empty() {
      return Err(map_gql_error(AuthError::InvalidInput(
        "copilot_blob_key must be '{user_id}/{workspace_id}/{filename}'".to_string(),
      )));
    }
    let key_user_id = Uuid::parse_str(parts[0]).map_err(|_| {
      map_gql_error(AuthError::InvalidInput(
        "copilot_blob_key user segment is not a valid UUID".to_string(),
      ))
    })?;
    let key_workspace_id = Uuid::parse_str(parts[1]).map_err(|_| {
      map_gql_error(AuthError::InvalidInput(
        "copilot_blob_key workspace segment is not a valid UUID".to_string(),
      ))
    })?;
    let filename = parts[2];

    // Ownership: the user_id in the key must match the authenticated caller.
    if key_user_id != snapshot.user.id {
      return Err(map_gql_error(AuthError::ActionForbidden));
    }
    // Sanity: the workspace in the key must match the mutation parameter.
    if key_workspace_id != workspace_uuid {
      return Err(map_gql_error(AuthError::InvalidInput(
        "copilot_blob_key workspace does not match workspace_id".to_string(),
      )));
    }

    // Read blob bytes from copilot storage area.
    let blob_data = state
      .storage()
      .read_blob(&copilot_blob_key)
      .await
      .map_err(|e| map_gql_error(AuthError::Storage(format!("copilot blob not found: {e}"))))?;

    let content_type = blob_data
      .content_type
      .clone()
      .unwrap_or_else(|| "application/octet-stream".to_string());
    let body_bytes: Bytes = blob_data.data;
    let size = body_bytes.len() as u64;

    // Derive a stable, workspace-scoped key from the original filename.
    // We generate a fresh UUID so the new key is unique even if the copilot
    // blob is adopted multiple times (e.g. by different workspace members).
    let ext = std::path::Path::new(filename)
      .extension()
      .and_then(|e| e.to_str())
      .unwrap_or("");
    let new_key_str = if ext.is_empty() {
      Uuid::new_v4().to_string()
    } else {
      format!("{}.{ext}", Uuid::new_v4())
    };
    let new_key = BlobKey::parse(&new_key_str)
      .map_err(|e| map_gql_error(AuthError::InvalidInput(format!("derived blob key invalid: {e}"))))?;

    // Write to workspace storage, create metadata, mark completed.
    state
      .blob()
      .initialize_upload(workspace_uuid, new_key.as_str(), size, &content_type)
      .await
      .map_err(map_gql_error)?;

    let storage_key = format!("{workspace_uuid}/{}", new_key.as_str());
    state
      .storage()
      .write_blob(BlobWriteRequest {
        key: storage_key,
        content_type: Some(content_type),
        body: body_bytes,
      })
      .await
      .map_err(|e| map_gql_error(AuthError::Storage(e.to_string())))?;

    state
      .blob()
      .complete_upload(workspace_uuid, new_key.as_str())
      .await
      .map_err(map_gql_error)?;

    info!(
        user_id = %snapshot.user.id,
        workspace_id = %workspace_uuid,
        copilot_key = %copilot_blob_key,
        new_key = %new_key.as_str(),
        size_bytes = size,
        "adopted copilot blob into workspace blob store"
    );

    Ok(new_key.as_str().to_string())
  }

  // ─── Builtin Template Bridge (P125-TPL-S-04) ────────────────────────────

  /// Read retained builtin bindings, optionally repairing assigned native sources.
  /// Passive callers retain read-only behavior; explicit recovery requires document
  /// creation permission and never overrides detached source ownership.
  #[instrument(skip_all)]
  pub(crate) async fn workspace_template_reconcile_slugs(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    locale: String,
    provision_sources: Option<bool>,
  ) -> Result<Vec<crate::graphql::template_registry::BuiltinReconcileEntryType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| "invalid workspace_id")?;
    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::Read,
    )
    .await
    .map_err(map_gql_error)?;

    let Some(service) = crate::graphql::template_registry::optional_template_registry(&state).await else {
      return Ok(vec![]);
    };
    if provision_sources.unwrap_or(false) {
      pc.assert(
        &WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: workspace_uuid,
        },
        WorkspaceAction::CreateDoc,
      )
      .await
      .map_err(map_gql_error)?;
      let instances = service
        .reconcile_workspace_templates(workspace_uuid)
        .await
        .map_err(map_gql_error)?;
      if instances.iter().any(|instance| {
        instance.state == myoxus_domain::template_registry::InstanceState::Error
          || (instance.state == myoxus_domain::template_registry::InstanceState::Detached
            && instance.workspace_doc_key.is_none())
      }) {
        return Err(map_gql_error(AuthError::Storage(
          "assigned template sources could not be prepared".into(),
        )));
      }
    }
    let entries = service
      .query_builtin_reconcile_slugs(workspace_uuid, &locale)
      .await
      .map_err(map_gql_error)?;
    Ok(entries.into_iter().map(Into::into).collect())
  }

  /// Report that the client builder has successfully applied a builtin template.
  #[instrument(skip_all)]
  pub(crate) async fn report_template_builder_applied(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::template_registry::ReportBuilderAppliedInput,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&input.workspace_id).map_err(|_| "invalid workspace_id")?;
    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::CreateDoc,
    )
    .await
    .map_err(map_gql_error)?;

    let Some(service) = crate::graphql::template_registry::optional_template_registry(&state).await else {
      return Ok(false);
    };
    let document_key = input
      .doc_id
      .as_deref()
      .ok_or_else(|| map_gql_error(AuthError::InvalidInput("doc_id is required".to_string())))?;
    let workspace_doc_id = crate::graphql::utils::resolve_doc_id(&state, workspace_uuid, document_key).await?;
    pc.assert(
      &DocResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
        doc_id: workspace_doc_id,
      },
      DocAction::Update,
    )
    .await
    .map_err(map_gql_error)?;
    service
      .report_builder_applied(
        workspace_uuid,
        &input.slug,
        &input.applied_hash,
        &input.locale,
        Some(document_key),
      )
      .await
      .map_err(map_gql_error)?;
    Ok(true)
  }

  /// Report that the client has trashed a builtin template document.
  #[instrument(skip_all)]
  pub(crate) async fn report_template_builder_trashed(
    &self,
    ctx: &Context<'_>,
    workspace_id: String,
    slug: String,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| "invalid workspace_id")?;
    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::CreateDoc,
    )
    .await
    .map_err(map_gql_error)?;

    let Some(service) = crate::graphql::template_registry::optional_template_registry(&state).await else {
      return Ok(false);
    };
    service
      .report_builder_trashed(workspace_uuid, &slug)
      .await
      .map_err(map_gql_error)?;
    Ok(true)
  }

  /// Set per-workspace template override (enable/disable, provisioning_mode).
  #[instrument(skip_all)]
  pub(crate) async fn set_workspace_template_override(
    &self,
    ctx: &Context<'_>,
    input: crate::graphql::template_registry::SetWorkspaceTemplateOverrideInput,
  ) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    let workspace_uuid = Uuid::parse_str(&input.workspace_id).map_err(|_| "invalid workspace_id")?;
    let template_uuid = Uuid::parse_str(&input.template_id).map_err(|_| "invalid template_id")?;
    let pc = state.permission_service();
    pc.assert(
      &WorkspaceResource {
        user_id: snapshot.user.id,
        workspace_id: workspace_uuid,
      },
      WorkspaceAction::SettingsUpdate,
    )
    .await
    .map_err(map_gql_error)?;

    let service = crate::graphql::template_registry::require_template_registry(&state).await?;
    let provisioning_mode = input
      .provisioning_mode
      .map(myoxus_domain::template_registry::ProvisioningMode::from);
    service
      .set_workspace_template_override(
        workspace_uuid,
        template_uuid,
        input.is_enabled,
        provisioning_mode,
        Some(snapshot.user.id),
      )
      .await
      .map_err(map_gql_error)?;
    Ok(true)
  }

  pub(crate) async fn create_database(
    &self,
    ctx: &Context<'_>,
    input: database::CreateDatabaseInput,
  ) -> Result<database::DatabaseRecordObjectType> {
    database::create_database(ctx, input).await
  }

  pub(crate) async fn create_workspace_tag(
    &self,
    ctx: &Context<'_>,
    input: workspace_tags::CreateWorkspaceTagInput,
  ) -> Result<workspace_tags::WorkspaceTagObjectType> {
    workspace_tags::create_workspace_tag(ctx, input).await
  }

  pub(crate) async fn rename_workspace_tag(
    &self,
    ctx: &Context<'_>,
    input: workspace_tags::RenameWorkspaceTagInput,
  ) -> Result<workspace_tags::WorkspaceTagObjectType> {
    workspace_tags::rename_workspace_tag(ctx, input).await
  }

  pub(crate) async fn recolor_workspace_tag(
    &self,
    ctx: &Context<'_>,
    input: workspace_tags::RecolorWorkspaceTagInput,
  ) -> Result<workspace_tags::WorkspaceTagObjectType> {
    workspace_tags::recolor_workspace_tag(ctx, input).await
  }

  pub(crate) async fn update_workspace_tag_description(
    &self,
    ctx: &Context<'_>,
    input: workspace_tags::UpdateWorkspaceTagDescriptionInput,
  ) -> Result<workspace_tags::WorkspaceTagObjectType> {
    workspace_tags::update_workspace_tag_description(ctx, input).await
  }

  pub(crate) async fn archive_workspace_tag(
    &self,
    ctx: &Context<'_>,
    input: workspace_tags::WorkspaceTagLifecycleInput,
  ) -> Result<workspace_tags::WorkspaceTagObjectType> {
    workspace_tags::archive_workspace_tag(ctx, input).await
  }

  pub(crate) async fn restore_workspace_tag(
    &self,
    ctx: &Context<'_>,
    input: workspace_tags::WorkspaceTagLifecycleInput,
  ) -> Result<workspace_tags::WorkspaceTagObjectType> {
    workspace_tags::restore_workspace_tag(ctx, input).await
  }

  pub(crate) async fn delete_workspace_tag_permanently(
    &self,
    ctx: &Context<'_>,
    input: workspace_tags::WorkspaceTagLifecycleInput,
  ) -> Result<bool> {
    workspace_tags::delete_workspace_tag_permanently(ctx, input).await
  }

  pub(crate) async fn set_document_workspace_tags(
    &self,
    ctx: &Context<'_>,
    input: workspace_tags::SetDocumentWorkspaceTagsInput,
  ) -> Result<Vec<ID>> {
    workspace_tags::set_document_workspace_tags(ctx, input).await
  }

  pub(crate) async fn import_workspace_tags(
    &self,
    ctx: &Context<'_>,
    input: workspace_tags::ImportWorkspaceTagsInput,
  ) -> Result<workspace_tags::WorkspaceTagTransferObjectType> {
    workspace_tags::import_workspace_tags(ctx, input).await
  }

  pub(crate) async fn bootstrap_workspace_tags(
    &self,
    ctx: &Context<'_>,
    input: workspace_tags::BootstrapWorkspaceTagsInput,
  ) -> Result<workspace_tags::WorkspaceTagBootstrapResultObjectType> {
    workspace_tags::bootstrap_workspace_tags(ctx, input).await
  }

  pub(crate) async fn create_project(
    &self,
    ctx: &Context<'_>,
    input: database::CreateProjectInput,
  ) -> Result<database::DatabaseRecordObjectType> {
    database::create_project(ctx, input).await
  }

  /// Retry addresses the existing actor-bound receipt; no allocation input or
  /// new result identity is accepted through this recovery command.
  #[instrument(skip_all)]
  pub(crate) async fn retry_workspace_creation(
    &self,
    ctx: &Context<'_>,
    input: super::RetryWorkspaceCreationInput,
  ) -> Result<Option<super::WorkspaceCreationResultType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let request = Uuid::parse_str(input.request_id.as_str())
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid requestId".into())))?;
    let packages = state.assistant_packages();
    let outcome = state
      .workspace()
      .retry_workspace_creation(snapshot.user.id, request, packages.as_deref(), state.auth())
      .await
      .map_err(super::workspace::map_workspace_starter_error)?;
    outcome
      .as_ref()
      .map(super::WorkspaceCreationResultType::try_from)
      .transpose()
  }

  #[instrument(skip_all)]
  pub(crate) async fn stop_workspace_creation(
    &self,
    ctx: &Context<'_>,
    input: super::StopWorkspaceCreationInput,
  ) -> Result<Option<super::WorkspaceCreationResultType>> {
    let (state, snapshot) = require_session(ctx).await?;
    let request = Uuid::parse_str(input.request_id.as_str())
      .map_err(|_| map_gql_error(AuthError::InvalidInput("invalid requestId".into())))?;
    let packages = state.assistant_packages();
    let outcome = state
      .workspace()
      .stop_workspace_creation(snapshot.user.id, request, packages.as_deref())
      .await
      .map_err(super::workspace::map_workspace_starter_error)?;
    outcome
      .as_ref()
      .map(super::WorkspaceCreationResultType::try_from)
      .transpose()
  }

  pub(crate) async fn stop_project_setup(
    &self,
    ctx: &Context<'_>,
    input: database::StopProjectSetupInput,
  ) -> Result<database::ProjectSetupObjectType> {
    database::stop_project_setup(ctx, input).await
  }

  pub(crate) async fn apply_context_documents(
    &self,
    ctx: &Context<'_>,
    input: database::ApplyContextDocumentsInput,
  ) -> Result<database::ContextDocumentsObjectType> {
    database::apply_context_documents(ctx, input).await
  }

  pub(crate) async fn start_task_handover(
    &self,
    ctx: &Context<'_>,
    input: database::StartTaskHandoverInput,
  ) -> Result<database::TaskHandoverObjectType> {
    database::start_task_handover(ctx, input).await
  }

  pub(crate) async fn retry_task_handover(
    &self,
    ctx: &Context<'_>,
    input: database::TaskHandoverRunInput,
  ) -> Result<database::TaskHandoverObjectType> {
    database::retry_task_handover(ctx, input).await
  }

  pub(crate) async fn stop_task_handover(
    &self,
    ctx: &Context<'_>,
    input: database::TaskHandoverRunInput,
  ) -> Result<database::TaskHandoverObjectType> {
    database::stop_task_handover(ctx, input).await
  }

  pub(crate) async fn configure_task_preparation(
    &self,
    ctx: &Context<'_>,
    input: database::ConfigureTaskPreparationInput,
  ) -> Result<database::TaskPreparationConfigurationObjectType> {
    database::configure_task_preparation(ctx, input).await
  }
  pub(crate) async fn retry_task_preparation_run(
    &self,
    ctx: &Context<'_>,
    run_id: ID,
  ) -> Result<database::TaskPreparationRunObjectType> {
    database::retry_task_preparation_run(ctx, run_id).await
  }
  pub(crate) async fn stop_task_preparation_run(
    &self,
    ctx: &Context<'_>,
    run_id: ID,
  ) -> Result<database::TaskPreparationRunObjectType> {
    database::stop_task_preparation_run(ctx, run_id).await
  }
  pub(crate) async fn configure_task_maintenance(
    &self,
    ctx: &Context<'_>,
    input: database::ConfigureTaskPreparationInput,
  ) -> Result<database::TaskPreparationConfigurationObjectType> {
    database::configure_task_maintenance(ctx, input).await
  }
  pub(crate) async fn start_task_maintenance(
    &self,
    ctx: &Context<'_>,
    input: database::StartTaskMaintenanceInput,
  ) -> Result<database::TaskMaintenanceObjectType> {
    database::start_task_maintenance(ctx, input).await
  }

  pub(crate) async fn retry_task_maintenance(
    &self,
    ctx: &Context<'_>,
    input: database::TaskMaintenanceRunInput,
  ) -> Result<database::TaskMaintenanceObjectType> {
    database::retry_task_maintenance(ctx, input).await
  }

  pub(crate) async fn stop_task_maintenance(
    &self,
    ctx: &Context<'_>,
    input: database::TaskMaintenanceRunInput,
  ) -> Result<database::TaskMaintenanceObjectType> {
    database::stop_task_maintenance(ctx, input).await
  }

  pub(crate) async fn confirm_task_corrections(
    &self,
    ctx: &Context<'_>,
    input: database::ConfirmTaskCorrectionsInput,
  ) -> Result<database::TaskMaintenanceObjectType> {
    database::confirm_task_corrections(ctx, input).await
  }

  pub(crate) async fn start_document_review(
    &self,
    ctx: &Context<'_>,
    input: database::StartDocumentReviewInput,
  ) -> Result<database::DocumentReviewObjectType> {
    database::start_document_review(ctx, input).await
  }

  pub(crate) async fn decide_document_review(
    &self,
    ctx: &Context<'_>,
    input: database::DecideDocumentReviewInput,
  ) -> Result<database::DocumentReviewObjectType> {
    database::decide_document_review(ctx, input).await
  }

  pub(crate) async fn stop_document_review(
    &self,
    ctx: &Context<'_>,
    input: database::DocumentReviewRunInput,
  ) -> Result<database::DocumentReviewObjectType> {
    database::stop_document_review(ctx, input).await
  }

  pub(crate) async fn retry_document_review(
    &self,
    ctx: &Context<'_>,
    input: database::DocumentReviewRunInput,
  ) -> Result<database::DocumentReviewObjectType> {
    database::retry_document_review(ctx, input).await
  }

  pub(crate) async fn retry_context_documents(
    &self,
    ctx: &Context<'_>,
    input: database::RetryContextDocumentsInput,
  ) -> Result<database::ContextDocumentsObjectType> {
    database::retry_context_documents(ctx, input).await
  }

  pub(crate) async fn stop_context_documents(
    &self,
    ctx: &Context<'_>,
    input: database::StopContextDocumentsInput,
  ) -> Result<database::ContextDocumentsObjectType> {
    database::stop_context_documents(ctx, input).await
  }

  pub(crate) async fn create_database_from_template(
    &self,
    ctx: &Context<'_>,
    input: database::CreateDatabaseFromTemplateInput,
  ) -> Result<database::DatabaseRecordObjectType> {
    database::create_database_from_template(ctx, input).await
  }

  pub(crate) async fn create_workspace_automation(
    &self,
    ctx: &Context<'_>,
    input: workspace_automation::CreateWorkspaceAutomationInput,
  ) -> Result<workspace_automation::WorkspaceAutomationObjectType> {
    workspace_automation::create_workspace_automation(ctx, input).await
  }

  pub(crate) async fn disable_workspace_automation(
    &self,
    ctx: &Context<'_>,
    input: workspace_automation::DisableWorkspaceAutomationInput,
  ) -> Result<workspace_automation::WorkspaceAutomationObjectType> {
    workspace_automation::disable_workspace_automation(ctx, input).await
  }

  pub(crate) async fn update_database(
    &self,
    ctx: &Context<'_>,
    input: database::UpdateDatabaseInput,
  ) -> Result<database::DatabaseRecordObjectType> {
    database::update_database(ctx, input).await
  }

  pub(crate) async fn trash_database(
    &self,
    ctx: &Context<'_>,
    input: database::DatabaseLifecycleInput,
  ) -> Result<database::DatabaseRecordObjectType> {
    database::trash_database(ctx, input).await
  }

  pub(crate) async fn restore_database(
    &self,
    ctx: &Context<'_>,
    input: database::DatabaseLifecycleInput,
  ) -> Result<database::DatabaseRecordObjectType> {
    database::restore_database(ctx, input).await
  }

  pub(crate) async fn delete_database_permanently(
    &self,
    ctx: &Context<'_>,
    input: database::DatabaseLifecycleInput,
  ) -> Result<bool> {
    database::delete_database_permanently(ctx, input).await
  }

  pub(crate) async fn set_database_row_reminder(
    &self,
    ctx: &Context<'_>,
    input: database::SetDatabaseRowReminderInput,
  ) -> Result<database::DatabaseRowReminderObjectType> {
    database::set_database_row_reminder(ctx, input).await
  }

  pub(crate) async fn delete_database_row_reminder(
    &self,
    ctx: &Context<'_>,
    input: database::DeleteDatabaseRowReminderInput,
  ) -> Result<bool> {
    database::delete_database_row_reminder(ctx, input).await
  }

  pub(crate) async fn create_database_field(
    &self,
    ctx: &Context<'_>,
    input: database::CreateDatabaseFieldInput,
  ) -> Result<database::DatabaseFieldObjectType> {
    database::create_database_field(ctx, input).await
  }

  pub(crate) async fn update_database_field(
    &self,
    ctx: &Context<'_>,
    input: database::UpdateDatabaseFieldInput,
  ) -> Result<database::DatabaseFieldObjectType> {
    database::update_database_field(ctx, input).await
  }

  pub(crate) async fn delete_database_field(
    &self,
    ctx: &Context<'_>,
    input: database::DeleteDatabaseFieldInput,
  ) -> Result<bool> {
    database::delete_database_field(ctx, input).await
  }

  pub(crate) async fn reorder_database_fields(
    &self,
    ctx: &Context<'_>,
    input: database::ReorderDatabaseFieldsInput,
  ) -> Result<Vec<database::DatabaseFieldObjectType>> {
    database::reorder_database_fields(ctx, input).await
  }

  pub(crate) async fn create_database_view(
    &self,
    ctx: &Context<'_>,
    input: database::CreateDatabaseViewInput,
  ) -> Result<database::DatabaseViewObjectType> {
    database::create_database_view(ctx, input).await
  }

  pub(crate) async fn update_database_view(
    &self,
    ctx: &Context<'_>,
    input: database::UpdateDatabaseViewInput,
  ) -> Result<database::DatabaseViewObjectType> {
    database::update_database_view(ctx, input).await
  }

  pub(crate) async fn upsert_database_view_user_state(
    &self,
    ctx: &Context<'_>,
    input: database::UpsertDatabaseViewUserStateInput,
  ) -> Result<database::DatabaseViewUserStateObjectType> {
    database::upsert_database_view_user_state(ctx, input).await
  }

  pub(crate) async fn reset_database_view_user_state(
    &self,
    ctx: &Context<'_>,
    input: database::ResetDatabaseViewUserStateInput,
  ) -> Result<bool> {
    database::reset_database_view_user_state(ctx, input).await
  }

  pub(crate) async fn save_database_view_user_state(
    &self,
    ctx: &Context<'_>,
    input: database::SaveDatabaseViewUserStateInput,
  ) -> Result<database::DatabaseViewObjectType> {
    database::save_database_view_user_state(ctx, input).await
  }

  pub(crate) async fn delete_database_view(
    &self,
    ctx: &Context<'_>,
    input: database::DeleteDatabaseViewInput,
  ) -> Result<bool> {
    database::delete_database_view(ctx, input).await
  }

  pub(crate) async fn reorder_database_views(
    &self,
    ctx: &Context<'_>,
    input: database::ReorderDatabaseViewsInput,
  ) -> Result<Vec<database::DatabaseViewObjectType>> {
    database::reorder_database_views(ctx, input).await
  }

  pub(crate) async fn create_database_task_from_source(
    &self,
    ctx: &Context<'_>,
    input: database::CreateDatabaseTaskFromSourceInput,
  ) -> Result<database::DatabaseTaskCaptureResultObjectType> {
    database::create_database_task_from_source(ctx, input).await
  }

  pub(crate) async fn move_database_tasks(
    &self,
    ctx: &Context<'_>,
    input: database::DatabaseTaskMoveInput,
  ) -> Result<database::DatabaseTaskMoveResultObjectType> {
    database::move_database_tasks(ctx, input).await
  }

  pub(crate) async fn create_database_row(
    &self,
    ctx: &Context<'_>,
    input: database::CreateDatabaseRowInput,
  ) -> Result<database::DatabaseRowRecordObjectType> {
    database::create_database_row(ctx, input).await
  }

  pub(crate) async fn create_database_row_template(
    &self,
    ctx: &Context<'_>,
    input: database::CreateDatabaseRowTemplateInput,
  ) -> Result<database::DatabaseRowTemplateBindingObjectType> {
    database::create_database_row_template(ctx, input).await
  }

  pub(crate) async fn update_database_row_template(
    &self,
    ctx: &Context<'_>,
    input: database::UpdateDatabaseRowTemplateInput,
  ) -> Result<database::DatabaseRowTemplateBindingObjectType> {
    database::update_database_row_template(ctx, input).await
  }

  pub(crate) async fn delete_database_row_template(
    &self,
    ctx: &Context<'_>,
    input: database::DeleteDatabaseRowTemplateInput,
  ) -> Result<bool> {
    database::delete_database_row_template(ctx, input).await
  }

  pub(crate) async fn create_database_row_from_template(
    &self,
    ctx: &Context<'_>,
    input: database::CreateDatabaseRowFromTemplateInput,
  ) -> Result<database::DatabaseRowRecordObjectType> {
    database::create_database_row_from_template(ctx, input).await
  }

  pub(crate) async fn update_database_row_title(
    &self,
    ctx: &Context<'_>,
    input: database::UpdateDatabaseRowTitleInput,
  ) -> Result<database::DatabaseCellValueObjectType> {
    database::update_database_row_title(ctx, input).await
  }

  pub(crate) async fn update_database_row_position(
    &self,
    ctx: &Context<'_>,
    input: database::UpdateDatabaseRowPositionInput,
  ) -> Result<database::DatabaseRowRecordObjectType> {
    database::update_database_row_position(ctx, input).await
  }

  pub(crate) async fn update_database_cell_value(
    &self,
    ctx: &Context<'_>,
    input: database::UpdateDatabaseCellValueInput,
  ) -> Result<database::DatabaseCellValueObjectType> {
    database::update_database_cell_value(ctx, input).await
  }

  pub(crate) async fn clear_database_cell_value(
    &self,
    ctx: &Context<'_>,
    input: database::ClearDatabaseCellValueInput,
  ) -> Result<database::DatabaseCellRevisionObjectType> {
    database::clear_database_cell_value(ctx, input).await
  }

  pub(crate) async fn delete_database_row(
    &self,
    ctx: &Context<'_>,
    input: database::DeleteDatabaseRowInput,
  ) -> Result<bool> {
    database::delete_database_row(ctx, input).await
  }

  // P-DB-26: bulk operation mutations. The underlying service methods are
  // atomic; per-row diagnostics surface in the returned
  // `DatabaseBulkOperationResultObjectType`.
  pub(crate) async fn bulk_set_database_cell_value(
    &self,
    ctx: &Context<'_>,
    input: database::BulkSetDatabaseCellValueInput,
  ) -> Result<database::DatabaseBulkOperationResultObjectType> {
    database::bulk_set_database_cell_value(ctx, input).await
  }

  pub(crate) async fn bulk_clear_database_cell_value(
    &self,
    ctx: &Context<'_>,
    input: database::BulkClearDatabaseCellValueInput,
  ) -> Result<database::DatabaseBulkOperationResultObjectType> {
    database::bulk_clear_database_cell_value(ctx, input).await
  }

  pub(crate) async fn bulk_apply_database_cell_patches(
    &self,
    ctx: &Context<'_>,
    input: database::BulkApplyDatabaseCellPatchesInput,
  ) -> Result<database::DatabaseBulkOperationResultObjectType> {
    database::bulk_apply_database_cell_patches(ctx, input).await
  }

  pub(crate) async fn bulk_delete_database_rows(
    &self,
    ctx: &Context<'_>,
    input: database::BulkDeleteDatabaseRowsInput,
  ) -> Result<database::DatabaseBulkOperationResultObjectType> {
    database::bulk_delete_database_rows(ctx, input).await
  }

  pub(crate) async fn bulk_restore_database_rows(
    &self,
    ctx: &Context<'_>,
    input: database::BulkRestoreDatabaseRowsInput,
  ) -> Result<database::DatabaseBulkOperationResultObjectType> {
    database::bulk_restore_database_rows(ctx, input).await
  }

  pub(crate) async fn bulk_update_database_row_positions(
    &self,
    ctx: &Context<'_>,
    input: database::BulkUpdateDatabaseRowPositionsInput,
  ) -> Result<database::DatabaseBulkOperationResultObjectType> {
    database::bulk_update_database_row_positions(ctx, input).await
  }

  pub(crate) async fn preview_database_csv_import(
    &self,
    ctx: &Context<'_>,
    file: Upload,
    input: database::PreviewDatabaseCsvImportInput,
  ) -> Result<database::DatabaseCsvPreviewObjectType> {
    database::preview_database_csv_import(ctx, file, input).await
  }

  pub(crate) async fn import_database_csv(
    &self,
    ctx: &Context<'_>,
    file: Upload,
    input: database::ImportDatabaseCsvInput,
  ) -> Result<database::DatabaseCsvImportResultObjectType> {
    database::import_database_csv(ctx, file, input).await
  }

  pub(crate) async fn preview_database_json_import(
    &self,
    ctx: &Context<'_>,
    file: Upload,
    input: database::PreviewDatabaseJsonImportInput,
  ) -> Result<database::DatabaseJsonPreviewObjectType> {
    database::preview_database_json_import(ctx, file, input).await
  }

  pub(crate) async fn import_database_json(
    &self,
    ctx: &Context<'_>,
    file: Upload,
    input: database::ImportDatabaseJsonInput,
  ) -> Result<database::DatabaseJsonImportResultObjectType> {
    database::import_database_json(ctx, file, input).await
  }

  pub(crate) async fn preview_database_notion_import(
    &self,
    ctx: &Context<'_>,
    file: Upload,
    input: database::PreviewDatabaseJsonImportInput,
  ) -> Result<database::DatabaseJsonPreviewObjectType> {
    database::preview_database_notion_import(ctx, file, input).await
  }

  pub(crate) async fn import_database_notion(
    &self,
    ctx: &Context<'_>,
    file: Upload,
    input: database::ImportDatabaseJsonInput,
  ) -> Result<database::DatabaseJsonImportResultObjectType> {
    database::import_database_notion(ctx, file, input).await
  }

  pub(crate) async fn export_database_csv(
    &self,
    ctx: &Context<'_>,
    input: database::ExportDatabaseCsvInput,
  ) -> Result<database::DatabaseCsvExportObjectType> {
    database::export_database_csv(ctx, input).await
  }

  /// P-DB-27: save (or update) a CSV mapping template. Saving under
  /// an existing name creates a new revision.
  pub(crate) async fn save_database_csv_mapping_template(
    &self,
    ctx: &Context<'_>,
    input: database::SaveDatabaseCsvMappingTemplateInput,
  ) -> Result<database::DatabaseCsvMappingTemplateObjectType> {
    database::save_database_csv_mapping_template(ctx, input).await
  }

  /// P-DB-27: load the current revision of a saved CSV mapping
  /// template by name. Returns `null` if no template exists under
  /// that name.
  pub(crate) async fn load_database_csv_mapping_template(
    &self,
    ctx: &Context<'_>,
    input: database::LoadDatabaseCsvMappingTemplateInput,
  ) -> Result<Option<database::DatabaseCsvMappingTemplateObjectType>> {
    database::load_database_csv_mapping_template(ctx, input).await
  }

  /// P-DB-27: delete every revision of a saved CSV mapping
  /// template by name. Returns whether at least one revision was
  /// removed.
  pub(crate) async fn delete_database_csv_mapping_template(
    &self,
    ctx: &Context<'_>,
    input: database::DeleteDatabaseCsvMappingTemplateInput,
  ) -> Result<bool> {
    database::delete_database_csv_mapping_template(ctx, input).await
  }

  pub(crate) async fn export_database_json(
    &self,
    ctx: &Context<'_>,
    input: database::ExportDatabaseJsonInput,
  ) -> Result<database::DatabaseJsonExportObjectType> {
    database::export_database_json(ctx, input).await
  }

  /// Create and attach a normal workspace document as optional Row content.
  pub(crate) async fn create_database_row_content_document(
    &self,
    ctx: &Context<'_>,
    input: database::CreateDatabaseRowContentDocumentInput,
  ) -> Result<database::DatabaseRowRecordObjectType> {
    database::create_database_row_content_document(ctx, input).await
  }

  /// Attach an existing readable document as optional Row content.
  pub(crate) async fn attach_database_row_content_document(
    &self,
    ctx: &Context<'_>,
    input: database::AttachDatabaseRowContentDocumentInput,
  ) -> Result<database::DatabaseRowRecordObjectType> {
    database::attach_database_row_content_document(ctx, input).await
  }

  /// Detach optional Row content without deleting the document.
  pub(crate) async fn detach_database_row_content_document(
    &self,
    ctx: &Context<'_>,
    input: database::DetachDatabaseRowContentDocumentInput,
  ) -> Result<database::DatabaseRowRecordObjectType> {
    database::detach_database_row_content_document(ctx, input).await
  }
}

#[cfg(test)]
mod email_rate_limit_tests {
  use super::*;
  use async_trait::async_trait;
  use myoxus_application::ports::{PortError, PortResult, RedisPort};
  use myoxus_infrastructure::redis::InMemoryRedisAdapter;

  fn test_config() -> crate::config::AppConfig {
    yaml_serde::from_str(
      r#"
server:
  port: 3001
  host: "127.0.0.1"
  origin: "http://localhost:3001"
  session_ttl: 3600
  session_ttr: 3600
database:
  url: "postgres://localhost/test"
redis:
  enabled: false
  url: null
  namespace: "myoxus"
mail:
  sender: "noreply@test.local"
  smtp_port: 587
storage:
  backend: "local"
  root: "./test-storage"
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
"#,
    )
    .expect("test config must parse")
  }

  fn state_with_redis(redis: Arc<dyn RedisPort>) -> ApiState {
    ApiState::new(test_config()).with_redis_port(redis)
  }

  #[tokio::test]
  async fn email_rate_limit_is_shared_across_states_and_recovers_after_expiry() {
    let redis = Arc::new(InMemoryRedisAdapter::new("email-cooldown-test"));
    let redis_port: Arc<dyn RedisPort> = redis.clone();
    let state_a = state_with_redis(redis_port.clone());
    let state_b = state_with_redis(redis_port);
    let user_id = Uuid::new_v4();
    let mutation = "send_verify_email";

    check_email_rate_limit(&state_a, user_id, mutation)
      .await
      .expect("first node must acquire the cooldown");

    let rejection = check_email_rate_limit(&state_b, user_id, mutation)
      .await
      .expect_err("a second node must observe the shared cooldown");
    let remaining = rejection
      .message
      .strip_prefix("Too many requests. Please wait ")
      .and_then(|value| value.strip_suffix(" seconds before retrying."))
      .and_then(|value| value.parse::<u64>().ok())
      .expect("the established rate-limit message must contain the remaining TTL");
    assert!((1..=EMAIL_RATE_LIMIT_SECONDS).contains(&remaining));

    let key = email_rate_limit_key(user_id, mutation);
    assert!(
      redis.expire_key(&key, 1).await.expect("shorten test TTL"),
      "the shared key must exist"
    );
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;

    check_email_rate_limit(&state_b, user_id, mutation)
      .await
      .expect("another node must acquire after expiry");
    check_email_rate_limit(&state_b, user_id, "send_change_email")
      .await
      .expect("different mutations retain independent cooldowns");
  }

  struct FailingRedis;

  #[async_trait]
  impl RedisPort for FailingRedis {
    async fn get_string(&self, _key: &str) -> PortResult<Option<String>> {
      Err(PortError::Transport("scripted unavailable Redis".to_string()))
    }

    async fn set_string(&self, _key: &str, _value: &str, _ttl_seconds: Option<u64>) -> PortResult<()> {
      Err(PortError::Transport("scripted unavailable Redis".to_string()))
    }

    async fn delete_key(&self, _key: &str) -> PortResult<()> {
      Err(PortError::Transport("scripted unavailable Redis".to_string()))
    }

    async fn setnx_string(&self, _key: &str, _value: &str, _ttl_seconds: Option<u64>) -> PortResult<bool> {
      Err(PortError::Transport("scripted unavailable Redis".to_string()))
    }
  }

  #[tokio::test]
  async fn email_rate_limit_fails_closed_when_redis_is_unavailable() {
    let state = state_with_redis(Arc::new(FailingRedis));

    let rejection = check_email_rate_limit(&state, Uuid::new_v4(), "send_change_password_email")
      .await
      .expect_err("an uncoordinated node must not reach the mail side effect");

    assert_eq!(
      rejection.message,
      "Too many requests. Please wait 60 seconds before retrying."
    );
  }
}
