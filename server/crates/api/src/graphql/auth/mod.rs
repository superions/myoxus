//! GraphQL resolvers for user accounts, workspaces, documents, and related entities.
//!
//! Split into domain-focused submodules:
//! - `types` — All struct/enum definitions
//! - `workspace` — WorkspaceType resolvers
//! - `document` — WorkspaceDocType resolvers
//! - `user` — UserType resolvers
//! - `copilot` — CopilotType resolvers
//! - `calendar` — Calendar types and resolvers
//! - `queries` — QueryRoot resolvers
//! - `mutations` — MutationRoot resolvers

pub mod calendar;
pub mod copilot;
pub mod database;
pub mod document;
pub mod document_graph;
pub mod mutations;
pub mod queries;
pub mod recurrence;
pub mod search_query;
pub mod template_suggestions;
pub mod types;
pub mod user;
pub mod workspace;
pub mod workspace_automation;
pub mod workspace_content_operation;
pub mod workspace_import;
pub mod workspace_tags;

pub use calendar::*;
pub use database::*;
pub use document::*;
pub use document_graph::*;
pub use recurrence::*;
pub use template_suggestions::*;
pub use types::*;
pub use workspace_automation::*;
pub use workspace_content_operation::*;
pub use workspace_import::*;
pub use workspace_tags::*;

use async_graphql::{ID, Result};
use tracing::instrument;
use uuid::Uuid;

use crate::config::{CompatibilityQuotaConfig, QuotaPlan};
use crate::graphql::utils::map_gql_error;
use crate::state::ApiState;
use myoxus_application::auth::AuthError;
use myoxus_application::permission::{AccessController, DocResource, WorkspaceResource};
use myoxus_domain::entities::{CopilotMessageRole, CopilotSession};
use myoxus_domain::permission::{DocAction, WorkspaceAction};
use myoxus_domain::repositories::{SearchSortBy, SortDirection};

/// Unit struct for the auth query root.
pub struct QueryRoot;

/// Unit struct for the auth mutation root.
pub struct MutationRoot;

pub(crate) fn neutral_copilot_quota(quota: &CompatibilityQuotaConfig) -> CopilotQuotaType {
  CopilotQuotaType {
    limit: quota.copilot_limit,
    used: quota.copilot_used,
  }
}

pub(crate) fn neutral_user_quota(plan: QuotaPlan, quota: &CompatibilityQuotaConfig) -> UserQuotaType {
  neutral_user_quota_with_member_usage(plan, quota, 0)
}

pub(crate) fn neutral_user_quota_with_member_usage(
  plan: QuotaPlan,
  quota: &CompatibilityQuotaConfig,
  member_count: i32,
) -> UserQuotaType {
  let plan_name = plan.display_name().to_string();
  let overcapacity_member_count = (member_count - quota.member_limit).max(0);
  UserQuotaType {
    name: plan_name.clone(),
    blob_limit: quota.blob_limit,
    storage_quota: quota.storage_quota,
    used_storage_quota: 0,
    history_period: quota.history_period,
    member_limit: quota.member_limit,
    member_count,
    overcapacity_member_count,
    human_readable: UserQuotaHumanReadableType {
      name: plan_name,
      blob_limit: format_bytes_human(quota.blob_limit as i64),
      storage_quota: format_bytes_human(quota.storage_quota),
      history_period: if quota.history_period <= 0 {
        "Unlimited".to_string()
      } else {
        format!("{} days", quota.history_period)
      },
      member_limit: if quota.member_limit <= 0 {
        "Unlimited".to_string()
      } else {
        quota.member_limit.to_string()
      },
      member_count: member_count.to_string(),
      overcapacity_member_count: overcapacity_member_count.to_string(),
    },
  }
}

#[instrument(skip_all)]
pub(crate) async fn count_license_seat_usage(state: &ApiState) -> Result<i32, AuthError> {
  let count = state.admin().count_users(None).await?;
  Ok(count.clamp(0, i32::MAX as i64) as i32)
}

pub(crate) fn compat_public_doc_mode_from_db(value: Option<String>) -> crate::graphql::PublicDocModeType {
  match value {
    Some(raw) if raw.eq_ignore_ascii_case("edgeless") => crate::graphql::PublicDocModeType::Edgeless,
    _ => crate::graphql::PublicDocModeType::Page,
  }
}

pub(crate) fn compat_default_doc_role_from_domain(
  role: myoxus_domain::entities::DocDefaultRole,
) -> crate::graphql::DocRoleType {
  match role {
    myoxus_domain::entities::DocDefaultRole::Editor => crate::graphql::DocRoleType::Editor,
    myoxus_domain::entities::DocDefaultRole::Viewer => crate::graphql::DocRoleType::Reader,
  }
}

/// Compute document-level permissions from the application-resolved role.
///
/// The caller resolves workspace and explicit document roles through
/// `PermissionService`; this projection only maps the authoritative result to
/// the stable GraphQL booleans.
pub(crate) fn doc_permissions_for_role(doc_role: myoxus_domain::entities::DocRole) -> DocPermissionsType {
  use myoxus_domain::permission::DocAction;

  DocPermissionsType {
    doc_copy: doc_role.can(DocAction::Copy),
    doc_delete: doc_role.can(DocAction::Delete),
    doc_duplicate: doc_role.can(DocAction::Duplicate),
    doc_properties_read: doc_role.can(DocAction::PropertiesRead),
    doc_properties_update: doc_role.can(DocAction::PropertiesUpdate),
    doc_publish: doc_role.can(DocAction::Publish),
    doc_read: doc_role.can(DocAction::Read),
    doc_restore: doc_role.can(DocAction::Restore),
    doc_transfer_owner: doc_role.can(DocAction::TransferOwner),
    doc_trash: doc_role.can(DocAction::Trash),
    doc_update: doc_role.can(DocAction::Update),
    doc_users_manage: doc_role.can(DocAction::UsersManage),
    doc_users_read: doc_role.can(DocAction::UsersRead),
    doc_comments_create: doc_role.can(DocAction::CommentsCreate),
    doc_comments_delete: doc_role.can(DocAction::CommentsDelete),
    doc_comments_read: doc_role.can(DocAction::CommentsRead),
    doc_comments_resolve: doc_role.can(DocAction::CommentsResolve),
  }
}

#[instrument(skip_all)]
pub(crate) async fn assert_copilot_workspace_access(
  state: &ApiState,
  user_id: Uuid,
  workspace_id: Uuid,
  _operation: &'static str,
) -> Result<()> {
  // Effective runtime policy is authoritative; configured providers are only
  // the fallback when no explicit enabled value exists.
  let copilot_enabled = state
    .effective_config()
    .await
    .bool("copilot.enabled")
    .unwrap_or_else(|| {
      !state.config.copilot.providers.is_empty() && state.config.copilot.providers.values().any(|p| p.enabled)
    });
  if !copilot_enabled {
    return Err(async_graphql::Error::new("copilot is not enabled"));
  }

  state
    .permission_service()
    .assert(&WorkspaceResource { user_id, workspace_id }, WorkspaceAction::Copilot)
    .await
    .map_err(map_gql_error)?;
  let workspace = state
    .workspace()
    .get_workspace(workspace_id)
    .await
    .map_err(map_gql_error)?;
  if !workspace.is_some_and(|workspace| workspace.enable_ai) {
    return Err(map_gql_error(AuthError::ActionForbidden));
  }
  Ok(())
}

/// Check the current document scope without reading its content into Copilot.
#[instrument(skip_all)]
pub(crate) async fn assert_copilot_doc_access(
  state: &ApiState,
  user_id: Uuid,
  workspace_id: Uuid,
  doc_id: Uuid,
) -> Result<()> {
  if !can_read_copilot_doc(state, user_id, workspace_id, doc_id).await? {
    return Err(map_gql_error(AuthError::ActionForbidden));
  }
  Ok(())
}

/// Retrieval omits denied candidates, but must not turn metadata storage errors
/// into successful empty results. Both direct inputs and retrieval share this check.
#[instrument(skip_all)]
pub(crate) async fn can_read_copilot_doc(
  state: &ApiState,
  user_id: Uuid,
  workspace_id: Uuid,
  doc_id: Uuid,
) -> Result<bool> {
  let metadata = state.doc().get_metadata(doc_id).await.map_err(map_gql_error)?;
  if !metadata.is_some_and(|metadata| metadata.workspace_id == Some(workspace_id)) {
    return Ok(false);
  }
  Ok(
    state
      .permission_service()
      .can(
        &DocResource {
          user_id,
          workspace_id,
          doc_id,
        },
        DocAction::Read,
      )
      .await,
  )
}

/// Interactive access is revalidated on every operation. Raw repository reads
/// remain available to privileged retention/administration consumers.
#[instrument(skip_all)]
pub(crate) async fn assert_copilot_session_access(
  state: &ApiState,
  user_id: Uuid,
  session: &CopilotSession,
  operation: &'static str,
) -> Result<()> {
  if session.user_id != user_id || session.deleted_at.is_some() {
    return Err(map_gql_error(AuthError::ActionForbidden));
  }
  let workspace_id = session
    .workspace_id
    .ok_or_else(|| map_gql_error(AuthError::ActionForbidden))?;
  assert_copilot_workspace_access(state, user_id, workspace_id, operation).await?;
  if let Some(doc_id) = session.doc_id {
    assert_copilot_doc_access(state, user_id, workspace_id, doc_id).await?;
  }
  Ok(())
}

pub(crate) fn map_copilot_role(role: CopilotMessageRole) -> String {
  match role {
    CopilotMessageRole::System => "system".to_string(),
    CopilotMessageRole::User => "user".to_string(),
    CopilotMessageRole::Assistant => "assistant".to_string(),
    CopilotMessageRole::Tool => "tool".to_string(),
  }
}

pub(crate) fn map_copilot_message(
  message: myoxus_domain::entities::CopilotMessage,
  workspace_id: uuid::Uuid,
) -> ChatMessageType {
  ChatMessageType {
    id: Some(ID::from(message.id.to_string())),
    role: map_copilot_role(message.role),
    content: message
      .content
      .as_str()
      .map(ToString::to_string)
      .or_else(|| {
        message
          .content
          .get("text")
          .and_then(|value| value.as_str())
          .map(ToString::to_string)
      })
      .unwrap_or_else(|| message.content.to_string()),
    generated_files: message
      .attachment_refs
      .iter()
      .filter_map(crate::handlers::copilot::file_descriptor)
      .collect(),
    attachments: if message.attachment_refs.is_empty() {
      None
    } else {
      Some(
        message
          .attachment_refs
          .iter()
          // Derive a fresh authenticated delivery URL on read. Persistence keeps
          // only blob keys; temporary/signed URLs never become attachment IDs.
          .filter(|attachment| attachment.generated_file().is_none())
          .map(|attachment| {
            format!(
              "/api/workspaces/{workspace_id}/blobs/{}",
              urlencoding::encode(&attachment.blob_key)
            )
          })
          .collect(),
      )
    },
    stream_objects: if let Some(objects) = message
      .content
      .get("streamObjects")
      .and_then(serde_json::Value::as_array)
      .filter(|objects| !objects.is_empty())
    {
      let mut projected: Vec<StreamObjectType> = objects
        .iter()
        .filter_map(|object| {
          Some(StreamObjectType {
            r#type: object.get("type")?.as_str()?.to_string(),
            text_delta: object
              .get("textDelta")
              .and_then(serde_json::Value::as_str)
              .map(ToString::to_string),
            tool_call_id: object
              .get("toolCallId")
              .and_then(serde_json::Value::as_str)
              .map(ToString::to_string),
            tool_name: object
              .get("toolName")
              .and_then(serde_json::Value::as_str)
              .map(ToString::to_string),
            args: object.get("args").cloned(),
            result: object.get("result").cloned(),
          })
        })
        .collect();
      // Existing persisted envelopes may contain reasoning/tools but leave
      // their final answer only in text. Do not let objects hide that answer.
      if !projected.iter().any(|object| object.r#type == "text-delta")
        && let Some(text) = message
          .content
          .get("text")
          .and_then(serde_json::Value::as_str)
          .filter(|text| !text.is_empty())
      {
        projected.push(StreamObjectType {
          r#type: "text-delta".into(),
          text_delta: Some(text.to_string()),
          tool_call_id: None,
          tool_name: None,
          args: None,
          result: None,
        });
      }
      Some(projected)
    } else if message.tool_calls.is_empty() {
      None
    } else {
      Some(
        message
          .tool_calls
          .iter()
          .map(|call| StreamObjectType {
            r#type: "tool-call".to_string(),
            text_delta: None,
            tool_call_id: Some(call.id.to_string()),
            tool_name: Some(call.tool_name.clone()),
            args: Some(call.args.clone()),
            result: call.result.clone(),
          })
          .collect(),
      )
    },
    params: message.token_usage,
    created_at: message.created_at,
  }
}

pub(crate) fn map_copilot_history(
  session: CopilotSession,
  workspace_id: Uuid,
  messages: Vec<ChatMessageType>,
  doc_keys: &std::collections::HashMap<Uuid, String>,
) -> Result<CopilotHistoriesType> {
  // Session persistence uses normalized UUIDs; navigation must use the current
  // workspace's external key, even when that key itself looks like a UUID.
  let doc_id = session
    .doc_id
    .map(|id| {
      doc_keys.get(&id).cloned().ok_or_else(|| {
        map_gql_error(AuthError::Storage(
          "copilot document identity projection missing".into(),
        ))
      })
    })
    .transpose()?;
  let prompt_name = session
    .metadata
    .get("promptName")
    .and_then(|value| value.as_str())
    .unwrap_or("chat-with-ai")
    .to_string();
  let action = session
    .metadata
    .get("action")
    .and_then(|value| value.as_str())
    .map(ToString::to_string);
  let tokens = messages
    .iter()
    .filter_map(|message| {
      message
        .params
        .as_ref()
        .and_then(|value| value.get("total_tokens"))
        .and_then(|value| value.as_i64())
    })
    .sum::<i64>() as i32;
  Ok(CopilotHistoriesType {
    session_id: session.id.to_string(),
    workspace_id: workspace_id.to_string(),
    doc_id,
    parent_session_id: session
      .metadata
      .get("parentSessionId")
      .and_then(serde_json::Value::as_str)
      .map(ToString::to_string),
    prompt_name,
    model: session.model.unwrap_or_else(|| "default".to_string()),
    optional_models: Vec::new(),
    action,
    pinned: session.pinned,
    title: session.title,
    tokens,
    messages,
    created_at: session.created_at,
    updated_at: session.updated_at,
  })
}

pub(crate) fn map_search_sort_by(sort_by: Option<SearchSortByType>) -> SearchSortBy {
  match sort_by.unwrap_or(SearchSortByType::Relevance) {
    SearchSortByType::Relevance => SearchSortBy::Relevance,
    SearchSortByType::UpdatedAt => SearchSortBy::UpdatedAt,
  }
}

pub(crate) fn map_sort_direction(direction: Option<SortDirectionType>) -> SortDirection {
  match direction.unwrap_or(SortDirectionType::Desc) {
    SortDirectionType::Asc => SortDirection::Asc,
    SortDirectionType::Desc => SortDirection::Desc,
  }
}
