// SPDX-License-Identifier: AGPL-3.0-or-later
//! MCP Workspace administration and publication adapters over shared owners.

use myoxus_application::permission::{AccessController, WorkspaceResource};
use myoxus_application::public::PublicAclDecision;
use myoxus_application::workspace::{UserWorkspaceSettingsInput, WorkspaceName, workspace_description};
use myoxus_domain::permission::WorkspaceAction;
use serde_json::{Map, Value, json};
use url::Url;
use uuid::Uuid;

use super::{
  IdempotencyBeginOutcome, IdempotencyRequirement, McpAuthContext, McpToolState, finish_or_abort_mcp_write,
  mcp_json_response,
};

type HandlerError = (i32, String);

/// Creation composes the existing provisioning owners. A failed root or policy
/// step may follow a durable Workspace insert, so the ordinary retained
/// admission must fence retries instead of treating this as an atomic write.
#[tracing::instrument(skip_all)]
pub(super) async fn create(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, HandlerError> {
  require_scope(auth, "write:workspaces")?;
  validate_keys(params, &["name", "owner_unit_id", "idempotency_key"])?;
  let name = optional_string(params, "name")?
    .map(|name| WorkspaceName::parse(&name).map(|name| name.display().to_owned()))
    .transpose()
    .map_err(|error| (-32602, error.to_string()))?;
  let unit_id = params
    .get("owner_unit_id")
    .map(|_| required_uuid(params, "owner_unit_id"))
    .transpose()?;
  let users = state
    .users
    .as_ref()
    .ok_or_else(|| (-32002, "Workspace actor service is not enabled".into()))?;
  if let Some(unit_id) = unit_id {
    super::require_active_global_admin(auth, &users.auth, "MIX_MCP_WORKSPACE").await?;
    let organization = state
      .organization
      .as_ref()
      .ok_or_else(|| (-32002, "Organization service is not enabled".into()))?;
    let unit = organization
      .units
      .get_by_id(unit_id)
      .await
      .map_err(|_| (-32002, "Workspace ownership could not be verified".into()))?
      .ok_or_else(|| (-32004, "Organization unit not found".into()))?;
    if unit.status != myoxus_domain::entities::OrganizationUnitStatus::Active {
      return Err((-32003, "Active organization unit required".into()));
    }
  } else if users
    .auth
    .get_user_by_id(auth.user_id)
    .await
    .map_err(|_| (-32002, "Workspace actor could not be verified".into()))?
    .is_none_or(|user| user.disabled)
  {
    return Err((-32003, "Active Workspace creator required".into()));
  }

  // Fresh actor and principal authorization also apply to completed receipts.
  let semantic = json!({"name":name,"owner_unit_id":unit_id});
  let guard = match crate::idempotency::begin(
    IdempotencyRequirement::Required,
    "workspace_create",
    params,
    Some(&semantic),
    auth,
    &state.idempotency,
  )
  .await?
  {
    IdempotencyBeginOutcome::Execute(guard) => guard,
    IdempotencyBeginOutcome::Replay(response) => return Ok(response),
  };
  let result = async {
    let workspace = if let Some(unit_id) = unit_id {
      state
        .workspace_service
        .create_shared_workspace(unit_id, auth.user_id, name)
        .await
    } else {
      state.workspace_service.create_workspace(auth.user_id, name, None).await
    }
    .map_err(map_create_error)?;
    if unit_id.is_none() {
      // GraphQL's optional upload keeps its shipped empty-root behavior. MCP
      // seeds through the same owner using the final normalized/suffixed name,
      // just as the CLI supplies canonical Yjs initialization bytes.
      state
        .workspace_service
        .seed_root_doc(
          workspace.id,
          auth.user_id,
          yjs::create_initial_workspace_doc(&workspace.name),
        )
        .await
        .map_err(partial_create_error)?;
    }
    // Root seeding preserves existing updates. Read the authoritative state
    // rather than claiming initialization when an empty concurrent update won.
    if !state
      .workspace_service
      .is_initialized(workspace.id)
      .await
      .map_err(partial_create_error)?
    {
      return Err((
        -32002,
        "MIX_MCP_WORKSPACE_CREATE_PARTIAL: created Workspace root is not initialized".into(),
      ));
    }
    let classification = state
      .workspace_service
      .workspace_classification(workspace.id)
      .await
      .map_err(partial_create_error)?
      .ok_or_else(|| {
        (
          -32002,
          "MIX_MCP_WORKSPACE_CREATE_PARTIAL: created Workspace classification unavailable".into(),
        )
      })?;
    let classification = match classification {
      myoxus_application::workspace::WorkspaceClassification::Personal => "personal",
      myoxus_application::workspace::WorkspaceClassification::UserOwned => "user_owned",
      myoxus_application::workspace::WorkspaceClassification::Shared => "shared",
    };
    Ok(mcp_json_response(
      json!({"id":workspace.id,"classification":classification,"initialized":true}),
    ))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

fn map_create_error(error: myoxus_application::auth::AuthError) -> HandlerError {
  use myoxus_application::auth::AuthError;
  match error {
    AuthError::WorkspaceNameConflict { suggestion } => (
      -32602,
      format!("XWS_WORKSPACE_NAME_CONFLICT: suggested name: {suggestion}"),
    ),
    AuthError::InvalidInput(message) => (-32602, message),
    AuthError::ActionForbidden => (-32003, "Workspace creation forbidden".into()),
    AuthError::NotFound(_) => (-32004, "Workspace creation principal not found".into()),
    error => partial_create_error(error),
  }
}

fn partial_create_error(error: myoxus_application::auth::AuthError) -> HandlerError {
  tracing::warn!(error = %error, "Workspace provisioning failed; durable effects may remain");
  (
    -32002,
    "MIX_MCP_WORKSPACE_CREATE_PARTIAL: inspect the original Workspace inventory before repairing provisioning".into(),
  )
}

/// Trash uses ordinary current Delete authority; recovery is a privileged
/// lifecycle operation and never obtains authority from an active-only read.
#[tracing::instrument(skip_all)]
pub(super) async fn delete(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, HandlerError> {
  require_scope(auth, "write:workspaces")?;
  validate_keys(params, &["workspace_id", "confirm", "idempotency_key"])?;
  let workspace_id = required_uuid(params, "workspace_id")?;
  if params.get("confirm").and_then(Value::as_bool) != Some(true) {
    return Err((-32602, "workspace_delete requires confirm: true".into()));
  }
  assert_workspace_action(state, auth.user_id, workspace_id, WorkspaceAction::Delete).await?;
  let semantic = json!({"workspace_id":workspace_id,"confirm":true});
  let guard = match crate::idempotency::begin(
    IdempotencyRequirement::Required,
    "workspace_delete",
    params,
    Some(&semantic),
    auth,
    &state.idempotency,
  )
  .await?
  {
    IdempotencyBeginOutcome::Execute(guard) => guard,
    IdempotencyBeginOutcome::Replay(response) => return Ok(response),
  };
  let result = state
    .workspace_service
    .delete_workspace(workspace_id)
    .await
    .map(|()| mcp_json_response(json!({"id":workspace_id,"deleted":true})))
    .map_err(map_lifecycle_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

#[tracing::instrument(skip_all)]
pub(super) async fn restore(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  require_scope(auth, "write:workspaces")?;
  validate_keys(params, &["workspace_id", "idempotency_key"])?;
  let workspace_id = required_uuid(params, "workspace_id")?;
  let users = state
    .users
    .as_ref()
    .ok_or_else(|| (-32002, "Workspace actor service is not enabled".into()))?;
  super::require_active_global_admin(auth, &users.auth, "MIX_MCP_WORKSPACE").await?;
  let semantic = json!({"workspace_id":workspace_id});
  let guard = match crate::idempotency::begin(
    IdempotencyRequirement::Required,
    "workspace_restore",
    params,
    Some(&semantic),
    auth,
    &state.idempotency,
  )
  .await?
  {
    IdempotencyBeginOutcome::Execute(guard) => guard,
    IdempotencyBeginOutcome::Replay(response) => return Ok(response),
  };
  let result = state
    .workspace_service
    .undelete_workspace(workspace_id)
    .await
    .map(|workspace| mcp_json_response(json!({"id":workspace.id,"restored":true})))
    .map_err(map_lifecycle_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

fn map_lifecycle_error(error: myoxus_application::auth::AuthError) -> HandlerError {
  use myoxus_application::auth::AuthError;
  match error {
    AuthError::WorkspaceNameConflict { suggestion } => (
      -32602,
      format!("XWS_WORKSPACE_NAME_CONFLICT: suggested name: {suggestion}"),
    ),
    AuthError::InvalidInput(message) => (-32602, message),
    AuthError::ActionForbidden => (-32003, "Workspace lifecycle operation forbidden".into()),
    AuthError::NotFound(_) => (-32004, "Workspace not found".into()),
    _ => {
      // Invitation storage errors can contain token values. Keep uncertainty
      // observable without retaining the credential-adjacent backend payload.
      tracing::warn!("Workspace lifecycle write outcome is uncertain");
      (
        -32002,
        "MIX_MCP_WORKSPACE_LIFECYCLE_UNCERTAIN: inspect the original Workspace before repairing its lifecycle".into(),
      )
    }
  }
}

/// Lists accepted members through the existing bounded, ordered SQL owner.
/// The extra row is only a continuation probe and is never returned.
#[tracing::instrument(skip_all)]
pub(super) async fn member_list(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  require_scope(auth, "read:workspaces")?;
  validate_keys(params, &["workspace_id", "offset", "limit", "query"])?;
  let workspace_id = required_uuid(params, "workspace_id")?;
  let offset = bounded_integer(params, "offset", 0, 0, i32::MAX as i64)?;
  let limit = bounded_integer(params, "limit", 50, 1, 200)?;
  let query = optional_string(params, "query")?;
  if query.as_ref().is_some_and(|query| query.chars().count() > 200) {
    return Err((-32602, "query exceeds 200 characters".into()));
  }
  assert_workspace_action(state, auth.user_id, workspace_id, WorkspaceAction::UsersRead).await?;
  let mut members = state
    .workspace_service
    .list_members(workspace_id, offset, limit + 1, query)
    .await
    .map_err(|_| (-32002, "Workspace member inventory unavailable".into()))?;
  let has_more = members.len() > limit as usize;
  members.truncate(limit as usize);
  Ok(mcp_json_response(json!({
    "members":members.iter().map(member_json).collect::<Vec<_>>(),
    "offset":offset,"limit":limit,"next_offset":has_more.then_some(offset+limit)
  })))
}

#[tracing::instrument(skip_all)]
pub(super) async fn member_add(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  member_write("workspace_member_add", params, auth, state).await
}

#[tracing::instrument(skip_all)]
pub(super) async fn member_set_role(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  member_write("workspace_member_set_role", params, auth, state).await
}

#[tracing::instrument(skip_all)]
pub(super) async fn member_remove(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  member_write("workspace_member_remove", params, auth, state).await
}

async fn member_write(
  tool: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  use myoxus_domain::entities::WorkspaceRole;
  require_scope(auth, "write:workspaces")?;
  let remove = tool == "workspace_member_remove";
  let add = tool == "workspace_member_add";
  if remove {
    validate_keys(params, &["workspace_id", "user_id", "idempotency_key"])?;
  } else {
    validate_keys(params, &["workspace_id", "user_id", "role", "idempotency_key"])?;
  }
  let workspace_id = required_uuid(params, "workspace_id")?;
  let user_id = required_uuid(params, "user_id")?;
  let role = if remove {
    None
  } else {
    let role = if add && params.get("role").is_none() {
      WorkspaceRole::Collaborator
    } else {
      serde_json::from_value::<WorkspaceRole>(params.get("role").cloned().unwrap_or(Value::Null))
        .map_err(|_| (-32602, "Invalid Workspace member role".into()))?
    };
    if role == WorkspaceRole::Owner {
      return Err((-32602, "Owner changes require ownership transfer".into()));
    }
    if add && role == WorkspaceRole::External {
      return Err((-32602, "External is not an assignable direct member role".into()));
    }
    Some(role)
  };
  let users = state
    .users
    .as_ref()
    .ok_or_else(|| (-32002, "Workspace member identity service unavailable".into()))?;
  if add {
    super::require_active_global_admin(auth, &users.auth, "MIX_MCP_WORKSPACE").await?;
  }
  users
    .auth
    .get_user_by_id(user_id)
    .await
    .map_err(|_| (-32002, "Workspace member identity unavailable".into()))?
    .filter(|user| !user.disabled)
    .ok_or_else(|| (-32004, "Active Workspace member target not found".into()))?;
  if add {
    state
      .workspace_service
      .get_workspace(workspace_id)
      .await
      .map_err(|_| (-32002, "Workspace member target unavailable".into()))?
      .ok_or_else(|| (-32004, "Active Workspace not found".into()))?;
  } else {
    let required = state
      .workspace_service
      .membership_mutation_action(workspace_id, auth.user_id, user_id, role)
      .await
      .map_err(map_lifecycle_error)?;
    assert_workspace_action(state, auth.user_id, workspace_id, required).await?;
  }
  // Preflight is repeated before completed receipts: an old success never
  // substitutes for current actor, target or effective membership authority.
  let semantic = json!({"workspace_id":workspace_id,"user_id":user_id,"role":role});
  let guard = match crate::idempotency::begin(
    IdempotencyRequirement::Required,
    tool,
    params,
    Some(&semantic),
    auth,
    &state.idempotency,
  )
  .await?
  {
    IdempotencyBeginOutcome::Execute(guard) => guard,
    IdempotencyBeginOutcome::Replay(response) => return Ok(response),
  };
  let result = async {
    if add {
      let member = state
        .workspace_service
        .add_member_direct(workspace_id, user_id, role.unwrap(), auth.user_id)
        .await
        .map_err(map_lifecycle_error)?;
      Ok(mcp_json_response(member_json(&member)))
    } else if remove {
      let removed = state
        .workspace_service
        .revoke_member(workspace_id, user_id)
        .await
        .map_err(map_lifecycle_error)?;
      Ok(mcp_json_response(
        json!({"workspaceId":workspace_id,"userId":user_id,"removed":removed}),
      ))
    } else {
      let updated = state
        .workspace_service
        .update_member_role(workspace_id, user_id, role.unwrap())
        .await
        .map_err(map_lifecycle_error)?;
      Ok(mcp_json_response(
        json!({"workspaceId":workspace_id,"userId":user_id,"updated":updated}),
      ))
    }
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

fn member_json(member: &myoxus_domain::entities::WorkspaceMember) -> Value {
  json!({"userId":member.user.id,"name":member.user.name,"email":member.user.email,
    "disabled":member.user.disabled,"role":member.role,"status":member.status,"inviteId":member.invite_id})
}

fn bounded_integer(params: &Value, key: &str, default: i64, min: i64, max: i64) -> Result<i64, HandlerError> {
  let value = match params.get(key) {
    None => default,
    Some(value) => value
      .as_i64()
      .ok_or_else(|| (-32602, format!("{key} must be an integer")))?,
  };
  if value < min || value > max {
    return Err((-32602, format!("{key} must be between {min} and {max}")));
  }
  Ok(value)
}

#[tracing::instrument(skip_all)]
pub(super) async fn member_invite(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  invitation_write("workspace_member_invite", params, auth, state).await
}

#[tracing::instrument(skip_all)]
pub(super) async fn invite_link_create(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  invitation_write("workspace_invite_link_create", params, auth, state).await
}

#[tracing::instrument(skip_all)]
pub(super) async fn invite_link_revoke(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  invitation_write("workspace_invite_link_revoke", params, auth, state).await
}

#[tracing::instrument(skip_all)]
pub(super) async fn invite_link_get(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  require_scope(auth, "read:workspaces")?;
  validate_keys(params, &["workspace_id"])?;
  let workspace_id = required_uuid(params, "workspace_id")?;
  assert_workspace_action(state, auth.user_id, workspace_id, WorkspaceAction::UsersManage).await?;
  let link = state
    .workspace_service
    .get_invite_link(workspace_id)
    .await
    .map_err(|_| (-32002, "Workspace invitation state unavailable".into()))?;
  // The canonical owner returns only active links. No token, token-derived ID
  // or join URL is included in discovery/read state.
  Ok(mcp_json_response(
    json!({"workspaceId":workspace_id,"active":link.is_some(),
    "expiresAt":link.and_then(|link|link.expires_at)}),
  ))
}

async fn invitation_write(
  tool: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  use myoxus_application::workspace::{WorkspaceInviteLinkExpiry, workspace_invite_url};
  require_scope(auth, "write:workspaces")?;
  let invite = tool == "workspace_member_invite";
  let create = tool == "workspace_invite_link_create";
  validate_keys(
    params,
    if invite {
      &["workspace_id", "user_id", "idempotency_key"]
    } else if create {
      &["workspace_id", "expire_time", "idempotency_key"]
    } else {
      &["workspace_id", "idempotency_key"]
    },
  )?;
  let workspace_id = required_uuid(params, "workspace_id")?;
  let target = if invite {
    Some(required_uuid(params, "user_id")?)
  } else {
    None
  };
  let expiry = if create {
    Some(
      serde_json::from_value::<WorkspaceInviteLinkExpiry>(params.get("expire_time").cloned().unwrap_or(Value::Null))
        .map_err(|_| {
          (
            -32602,
            "expire_time must be OneDay, ThreeDays, OneWeek or OneMonth".into(),
          )
        })?,
    )
  } else {
    None
  };
  assert_workspace_action(state, auth.user_id, workspace_id, WorkspaceAction::UsersManage).await?;
  if let Some(target) = target {
    let users = state
      .users
      .as_ref()
      .ok_or_else(|| (-32002, "Workspace invitation identity service unavailable".into()))?;
    users
      .auth
      .get_user_by_id(target)
      .await
      .map_err(|_| (-32002, "Workspace invitation identity unavailable".into()))?
      .filter(|user| !user.disabled)
      .ok_or_else(|| (-32004, "Active invitation recipient not found".into()))?;
  }
  let semantic = json!({"workspace_id":workspace_id,"user_id":target,"expire_time":expiry});
  let guard = match crate::idempotency::begin(
    IdempotencyRequirement::Required,
    tool,
    params,
    Some(&semantic),
    auth,
    &state.idempotency,
  )
  .await?
  {
    IdempotencyBeginOutcome::Execute(guard) => guard,
    IdempotencyBeginOutcome::Replay(response) => return Ok(response),
  };
  let result = async {
    if let Some(target) = target {
      let member = state
        .workspace_service
        .invite_member_by_id(workspace_id, auth.user_id, target)
        .await
        .map_err(map_lifecycle_error)?;
      Ok(mcp_json_response(member_json(&member)))
    } else if let Some(expiry) = expiry {
      let link = state
        .workspace_service
        .create_invite_link(workspace_id, auth.user_id, expiry.milliseconds())
        .await
        .map_err(map_lifecycle_error)?;
      Ok(mcp_json_response(json!({"workspaceId":workspace_id,
        "link":workspace_invite_url(&state.server_origin,&link.token_hash),"expiresAt":link.expires_at})))
    } else {
      state
        .workspace_service
        .revoke_invite_link(workspace_id)
        .await
        .map_err(map_lifecycle_error)?;
      Ok(mcp_json_response(json!({"workspaceId":workspace_id,"revoked":true})))
    }
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

/// Human transfer keeps GraphQL's current-owner authorization/CAS. Principal
/// transfer is the existing trusted administrative lifecycle with a fresh admin.
/// Neither mode derives ownership or OU powers from management relationships.
#[tracing::instrument(skip_all)]
pub(super) async fn owner_transfer(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  use myoxus_application::workspace::WorkspaceOwnerTarget;
  use myoxus_domain::entities::WorkspaceRole;
  require_scope(auth, "write:workspaces")?;
  validate_keys(
    params,
    &["workspace_id", "mode", "user_id", "owner_unit_id", "idempotency_key"],
  )?;
  let workspace_id = required_uuid(params, "workspace_id")?;
  let member_mode = match params.get("mode").and_then(Value::as_str) {
    Some("member") => true,
    Some("principal") => false,
    _ => return Err((-32602, "mode must be member or principal".into())),
  };
  let user_id = params
    .get("user_id")
    .map(|_| required_uuid(params, "user_id"))
    .transpose()?;
  let unit_id = params
    .get("owner_unit_id")
    .map(|_| required_uuid(params, "owner_unit_id"))
    .transpose()?;
  if user_id.is_some() == unit_id.is_some() || (member_mode && unit_id.is_some()) {
    return Err((
      -32602,
      "member mode requires user_id; principal mode requires exactly one of user_id or owner_unit_id".into(),
    ));
  }
  let users = state
    .users
    .as_ref()
    .ok_or_else(|| (-32002, "Workspace identity service unavailable".into()))?;
  if member_mode {
    let action = state
      .workspace_service
      .membership_mutation_action(workspace_id, auth.user_id, user_id.unwrap(), Some(WorkspaceRole::Owner))
      .await
      .map_err(map_lifecycle_error)?;
    assert_workspace_action(state, auth.user_id, workspace_id, action).await?;
  } else {
    super::require_active_global_admin(auth, &users.auth, "MIX_MCP_WORKSPACE").await?;
    state
      .workspace_service
      .get_workspace(workspace_id)
      .await
      .map_err(|_| (-32002, "Workspace unavailable".into()))?
      .ok_or_else(|| (-32004, "Active Workspace not found".into()))?;
  }
  if let Some(user) = user_id {
    users
      .auth
      .get_user_by_id(user)
      .await
      .map_err(|_| (-32002, "Workspace owner identity unavailable".into()))?
      .filter(|user| !user.disabled)
      .ok_or_else(|| (-32004, "Active Workspace owner not found".into()))?;
  }
  if let Some(unit) = unit_id {
    require_active_unit(state, unit).await?;
  }
  let semantic = json!({"workspace_id":workspace_id,"mode":if member_mode {"member"} else {"principal"},"user_id":user_id,"owner_unit_id":unit_id});
  let guard = match crate::idempotency::begin(
    IdempotencyRequirement::Required,
    "workspace_owner_transfer",
    params,
    Some(&semantic),
    auth,
    &state.idempotency,
  )
  .await?
  {
    IdempotencyBeginOutcome::Execute(guard) => guard,
    IdempotencyBeginOutcome::Replay(response) => return Ok(response),
  };
  let result=async {
    if member_mode {
      state.workspace_service.transfer_ownership(workspace_id,auth.user_id,user_id.unwrap()).await.map_err(map_lifecycle_error)?;
    } else {
      let target=if let Some(user)=user_id {WorkspaceOwnerTarget::User(user)} else {WorkspaceOwnerTarget::OrganizationUnit(unit_id.unwrap())};
      state.workspace_service.transfer_workspace_owner(workspace_id,target).await.map_err(map_lifecycle_error)?;
    }
    Ok(mcp_json_response(json!({"workspaceId":workspace_id,"mode":if member_mode {"member"} else {"principal"},
      "ownerPrincipalType":if unit_id.is_some(){"ou"}else{"user"},"ownerPrincipalId":user_id.or(unit_id).unwrap(),"transferred":true})))
  }.await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

#[tracing::instrument(skip_all)]
pub(super) async fn management_unit_set(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, HandlerError> {
  require_scope(auth, "write:workspaces")?;
  validate_keys(params, &["workspace_id", "unit_id", "idempotency_key"])?;
  let workspace_id = required_uuid(params, "workspace_id")?;
  let unit = params
    .get("unit_id")
    .ok_or_else(|| (-32602, "unit_id is required; use null to clear management".into()))?;
  let unit_id = if unit.is_null() {
    None
  } else {
    Some(required_uuid(params, "unit_id")?)
  };
  let users = state
    .users
    .as_ref()
    .ok_or_else(|| (-32002, "Workspace actor service unavailable".into()))?;
  super::require_active_global_admin(auth, &users.auth, "MIX_MCP_WORKSPACE").await?;
  state
    .workspace_service
    .get_workspace(workspace_id)
    .await
    .map_err(|_| (-32002, "Workspace unavailable".into()))?
    .ok_or_else(|| (-32004, "Active Workspace not found".into()))?;
  if let Some(unit) = unit_id {
    require_active_unit(state, unit).await?;
  }
  let semantic = json!({"workspace_id":workspace_id,"unit_id":unit_id});
  let guard = match crate::idempotency::begin(
    IdempotencyRequirement::Required,
    "workspace_management_unit_set",
    params,
    Some(&semantic),
    auth,
    &state.idempotency,
  )
  .await?
  {
    IdempotencyBeginOutcome::Execute(guard) => guard,
    IdempotencyBeginOutcome::Replay(response) => return Ok(response),
  };
  let result = state
    .workspace_service
    .set_management_unit(workspace_id, unit_id)
    .await
    .map_err(map_lifecycle_error)
    .map(|()| mcp_json_response(json!({"workspaceId":workspace_id,"managementUnitId":unit_id,"updated":true})));
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

async fn require_active_unit(state: &McpToolState, unit: Uuid) -> Result<(), HandlerError> {
  let organization = state
    .organization
    .as_ref()
    .ok_or_else(|| (-32002, "Organization service unavailable".into()))?;
  let unit = organization
    .units
    .get_by_id(unit)
    .await
    .map_err(|_| (-32002, "Workspace unit unavailable".into()))?
    .ok_or_else(|| (-32004, "Workspace unit not found".into()))?;
  if unit.status != myoxus_domain::entities::OrganizationUnitStatus::Active {
    return Err((-32003, "Active organization unit required".into()));
  }
  Ok(())
}

pub(super) async fn get(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, HandlerError> {
  require_scope(auth, "read:workspaces")?;
  validate_keys(params, &["workspace_id"])?;
  let workspace_id = required_uuid(params, "workspace_id")?;
  assert_workspace_action(state, auth.user_id, workspace_id, WorkspaceAction::Read).await?;
  Ok(mcp_json_response(workspace_projection(state, workspace_id).await?))
}

pub(super) async fn update(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, HandlerError> {
  require_scope(auth, "write:workspaces")?;
  require_scope(auth, "read:workspaces")?;
  validate_keys(
    params,
    &[
      "workspace_id",
      "idempotency_key",
      "name",
      "description",
      "public",
      "enable_sharing",
    ],
  )?;
  let workspace_id = required_uuid(params, "workspace_id")?;
  let name = optional_string(params, "name")?
    .map(|value| WorkspaceName::parse(&value).map(|name| name.display().to_string()))
    .transpose()
    .map_err(|error| (-32602, error.to_string()))?;
  let description = optional_string(params, "description")?
    .map(|value| workspace_description(&value))
    .transpose()
    .map_err(|error| (-32602, error.to_string()))?;
  let public = optional_bool(params, "public")?;
  let enable_sharing = optional_bool(params, "enable_sharing")?;
  if name.is_none() && description.is_none() && public.is_none() && enable_sharing.is_none() {
    return Err((
      -32602,
      "workspace_update requires at least one setting field".to_string(),
    ));
  }

  // Authorization precedes replay so a revoked key owner cannot recover a
  // previously stored response after losing access.
  assert_workspace_action(state, auth.user_id, workspace_id, WorkspaceAction::Read).await?;
  assert_workspace_action(state, auth.user_id, workspace_id, WorkspaceAction::SettingsUpdate).await?;

  let mut semantic = Map::from_iter([("workspace_id".to_string(), json!(workspace_id))]);
  insert_present(&mut semantic, "name", name.as_ref());
  insert_present(&mut semantic, "description", description.as_ref());
  insert_present(&mut semantic, "public", public.as_ref());
  insert_present(&mut semantic, "enable_sharing", enable_sharing.as_ref());
  let semantic = Value::Object(semantic);
  let guard = match crate::idempotency::begin(
    IdempotencyRequirement::Required,
    "workspace_update",
    params,
    Some(&semantic),
    auth,
    &state.idempotency,
  )
  .await?
  {
    IdempotencyBeginOutcome::Execute(guard) => guard,
    IdempotencyBeginOutcome::Replay(response) => return Ok(response),
  };

  let result = async {
    let service = state.workspace_settings_service.as_ref().ok_or_else(|| {
      (
        -32002,
        "Workspace settings service is not enabled on this MCP server".to_string(),
      )
    })?;
    service
      .update(
        auth.user_id,
        workspace_id,
        UserWorkspaceSettingsInput {
          name,
          description,
          public,
          enable_sharing,
          ..Default::default()
        },
      )
      .await
      .map_err(|error| (-32002, format!("Failed to update workspace: {error}")))?;
    Ok(mcp_json_response(workspace_projection(state, workspace_id).await?))
  }
  .await;

  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(crate) async fn workspace_projection(state: &McpToolState, workspace_id: Uuid) -> Result<Value, HandlerError> {
  let workspace = state
    .workspace_service
    .get_workspace(workspace_id)
    .await
    .map_err(|error| (-32002, format!("Failed to read workspace: {error}")))?
    .filter(|workspace| workspace.deleted_at.is_none())
    .ok_or_else(|| (-32004, "Workspace not found".to_string()))?;
  let selected_count = state
    .doc_service
    .list_public_docs(workspace_id)
    .await
    .map_err(|error| (-32002, format!("Failed to read public document selections: {error}")))?
    .len();
  let repository = state.public_repository.as_ref().ok_or_else(|| {
    (
      -32002,
      "Public repository is not enabled on this MCP server".to_string(),
    )
  })?;
  let repository_allows = matches!(
    repository.decide_workspace(workspace_id).await.map_err(|error| (
      -32002,
      format!("Failed to evaluate public workspace availability: {error}")
    ))?,
    PublicAclDecision::Allow(_)
  );
  let publicly_accessible = state.public_delivery_enabled && repository_allows;
  let public_url = if publicly_accessible {
    Some(public_workspace_url(&state.server_origin, workspace_id)?)
  } else {
    None
  };
  Ok(json!({
    "id": workspace.id,
    "name": workspace.name,
    "description": workspace.description,
    "public": workspace.public,
    "enable_sharing": workspace.enable_sharing,
    "publicly_accessible": publicly_accessible,
    "public_document_selection_count": selected_count,
    "public_url": public_url,
  }))
}

fn public_workspace_url(origin: &str, workspace_id: Uuid) -> Result<String, HandlerError> {
  let mut url = Url::parse(origin).map_err(|_| (-32002, "Configured server origin is invalid".to_string()))?;
  url.set_query(None);
  url.set_fragment(None);
  url.set_path("");
  url
    .path_segments_mut()
    .map_err(|_| {
      (
        -32002,
        "Configured server origin cannot contain path segments".to_string(),
      )
    })?
    .extend(["public", &workspace_id.to_string()]);
  Ok(url.into())
}

async fn assert_workspace_action(
  state: &McpToolState,
  user_id: Uuid,
  workspace_id: Uuid,
  action: WorkspaceAction,
) -> Result<(), HandlerError> {
  state
    .permission_service
    .assert(&WorkspaceResource { user_id, workspace_id }, action)
    .await
    .map_err(|_| {
      (
        -32003,
        format!("Permission denied: workspace action {action:?} required"),
      )
    })
}

fn validate_keys(params: &Value, allowed: &[&str]) -> Result<(), HandlerError> {
  let object = params
    .as_object()
    .ok_or_else(|| (-32602, "Tool arguments must be an object".to_string()))?;
  if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
    return Err((-32602, format!("Unknown parameter: {key}")));
  }
  Ok(())
}

fn required_uuid(params: &Value, key: &str) -> Result<Uuid, HandlerError> {
  let value = params
    .get(key)
    .and_then(Value::as_str)
    .ok_or_else(|| (-32602, format!("Missing required parameter: {key}")))?;
  Uuid::parse_str(value).map_err(|_| (-32602, format!("Invalid UUID for parameter: {key}")))
}

fn optional_string(params: &Value, key: &str) -> Result<Option<String>, HandlerError> {
  match params.get(key) {
    None => Ok(None),
    Some(Value::String(value)) => Ok(Some(value.clone())),
    Some(_) => Err((-32602, format!("{key} must be a non-null string"))),
  }
}

fn optional_bool(params: &Value, key: &str) -> Result<Option<bool>, HandlerError> {
  match params.get(key) {
    None => Ok(None),
    Some(Value::Bool(value)) => Ok(Some(*value)),
    Some(_) => Err((-32602, format!("{key} must be a non-null boolean"))),
  }
}

fn insert_present<T: serde::Serialize>(map: &mut Map<String, Value>, key: &str, value: Option<&T>) {
  if let Some(value) = value {
    map.insert(key.to_string(), json!(value));
  }
}

fn require_scope(auth: &McpAuthContext, scope: &str) -> Result<(), HandlerError> {
  if auth.has_scope(scope) {
    Ok(())
  } else {
    Err((-32003, format!("Scope '{scope}' required")))
  }
}
