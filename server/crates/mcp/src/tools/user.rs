// SPDX-License-Identifier: AGPL-3.0-or-later
//! Thin privileged-user adapters over the shared administrative owner.

use super::{
  McpAuthContext, McpToolState, begin_mcp_idempotency, bounded_integer, finish_or_abort_mcp_write, mcp_json_response,
  parse_uuid, require_active_global_admin,
};
use myoxus_application::{
  admin::AdminUserCreationError,
  audit::AuditActor,
  auth::{AuthError, UpdateAuthUser},
};
use serde_json::{Value, json};

pub(super) async fn call(
  name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let services = state
    .users
    .as_deref()
    .ok_or_else(|| (-32002, "MIX_MCP_USER_SERVICE_UNAVAILABLE".to_string()))?;
  // Never admit or replay a write on the role held when the key was issued.
  require_active_global_admin(auth, &services.auth, "MIX_MCP_USER").await?;
  let fields: &[&str] = match name {
    "user_list" => &["offset", "limit", "keyword"],
    "user_get" => &["id_or_email"],
    "user_create" => &["email", "name", "idempotency_key"],
    "user_update" => &["user_id", "email", "name", "idempotency_key"],
    "user_delete" => &["user_id", "confirmed_user_id", "idempotency_key"],
    "user_set_admin" => &["user_id", "is_admin", "idempotency_key"],
    _ => &["user_id", "idempotency_key"],
  };
  if params
    .as_object()
    .is_none_or(|object| object.keys().any(|key| !fields.contains(&key.as_str())))
  {
    return Err((-32602, "Unexpected user tool argument".to_string()));
  }
  if name == "user_list" {
    let offset = bounded_integer(params, "offset", 0, 0, i64::MAX - 100)?;
    let limit = bounded_integer(params, "limit", 20, 1, 100)?;
    let keyword = optional_text(params, "keyword")?.map(str::to_string);
    let users = services
      .users
      .list(offset, limit, keyword.clone())
      .await
      .map_err(map_error)?;
    let total = services.users.count(keyword).await.map_err(map_error)?;
    let next = offset + users.len() as i64;
    return Ok(mcp_json_response(
      json!({"users": users, "offset": offset, "limit": limit, "total": total,
      "next_offset": (next < total).then_some(next)}),
    ));
  }
  if name == "user_get" {
    let identity = required_text(params, "id_or_email")?;
    let user = if let Ok(id) = identity.parse() {
      services.users.get_by_id(id).await
    } else {
      services.users.get_by_email(identity).await
    }
    .map_err(map_error)?
    .ok_or_else(|| (-32004, "USER_NOT_FOUND".to_string()))?;
    return Ok(mcp_json_response(json!(user)));
  }
  let user_id = if name == "user_create" {
    None
  } else {
    Some(parse_uuid(params, "user_id")?)
  };
  let email = optional_text(params, "email")?;
  let display_name = optional_text(params, "name")?;
  if name == "user_create" && email.is_none() {
    return Err((-32602, "Missing required parameter: email".to_string()));
  }
  let is_admin = if name == "user_set_admin" {
    Some(
      params
        .get("is_admin")
        .and_then(Value::as_bool)
        .ok_or_else(|| (-32602, "is_admin must be a boolean".to_string()))?,
    )
  } else {
    None
  };
  if name == "user_delete" && parse_uuid(params, "confirmed_user_id")? != user_id.expect("validated identity") {
    return Err((-32602, "confirmed_user_id must equal user_id".into()));
  }
  let guard = match begin_mcp_idempotency(name, params, auth, state).await? {
    Ok(guard) => guard,
    Err(replay) => return Ok(replay),
  };
  let actor = AuditActor::api_key(auth.user_id, auth.key_id);
  let result = match name {
    "user_create" => services
      .users
      .create(email.expect("validated email"), display_name, None, actor, "mcp")
      .await
      .map(|user| mcp_json_response(json!(user)))
      .map_err(|error| match error {
        AdminUserCreationError::DuplicateEmail => (-32602, "USER_EMAIL_ALREADY_USED".to_string()),
        AdminUserCreationError::Auth(error) => map_error(error),
        error @ AdminUserCreationError::Partial { .. } => (-32002, format!("MIX_MCP_USER_CREATE_PARTIAL: {error}")),
      }),
    "user_update" => services
      .users
      .update(
        user_id.expect("validated identity"),
        UpdateAuthUser {
          email: email.map(str::to_string),
          name: display_name.map(|name| Some(name.to_string())),
          avatar_url: None,
        },
        actor,
        "mcp",
      )
      .await
      .map(|user| mcp_json_response(json!(user)))
      .map_err(map_error),
    "user_delete" => services
      .users
      .delete(user_id.expect("validated identity"), actor, "mcp")
      .await
      .map(|commit| mcp_json_response(json!({"user_id":commit.user.id,"deleted":true})))
      .map_err(map_error),
    "user_set_admin" => services
      .users
      .set_admin(
        user_id.expect("validated identity"),
        is_admin.expect("validated flag"),
        actor,
        "mcp",
      )
      .await
      .map(|commit| {
        mcp_json_response(
          json!({"user_id":commit.user_id,"previous_is_admin":commit.previous_is_admin,"is_admin":commit.is_admin}),
        )
      })
      .map_err(map_error),
    "user_suspend" => services
      .users
      .suspend(user_id.expect("validated identity"), actor, "mcp")
      .await
      .map(|user| mcp_json_response(json!(user)))
      .map_err(map_error),
    "user_enable" => services
      .users
      .enable(user_id.expect("validated identity"), actor, "mcp")
      .await
      .map(|user| mcp_json_response(json!(user)))
      .map_err(map_error),
    "user_reset_link" => services
      .users
      .reset_link(
        user_id.expect("validated identity"),
        &state.server_origin,
        None,
        actor,
        "mcp",
      )
      .await
      .map(|link| mcp_json_response(json!({"user_id": user_id, "reset_link": link.url, "expires_at": link.expires_at})))
      .map_err(map_error),
    _ => unreachable!("registry dispatch admits only user tools"),
  };
  if matches!(name, "user_suspend" | "user_delete") && user_id == Some(auth.user_id) && result.is_ok() {
    // The credential-removal transaction deleted this credential and cascaded its
    // receipt. Return the known commit without recreating either or treating
    // the absent completion row as a failed domain mutation.
    return result;
  }
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

fn optional_text<'a>(params: &'a Value, key: &str) -> Result<Option<&'a str>, (i32, String)> {
  match params.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(Value::String(value)) if value.chars().count() <= 255 => Ok(Some(value)),
    _ => Err((-32602, format!("{key} must be a string of at most 255 characters"))),
  }
}

fn required_text<'a>(params: &'a Value, key: &str) -> Result<&'a str, (i32, String)> {
  optional_text(params, key)?
    .filter(|value| !value.is_empty())
    .ok_or_else(|| (-32602, format!("Missing required parameter: {key}")))
}

fn map_error(error: AuthError) -> (i32, String) {
  match error {
    AuthError::NotFound(_) => (-32004, "USER_NOT_FOUND".to_string()),
    AuthError::ActionForbidden => (-32003, "USER_OPERATION_FORBIDDEN".to_string()),
    AuthError::InvalidEmail => (-32602, "INVALID_EMAIL".to_string()),
    AuthError::InvalidInput(_) => (-32602, "INVALID_USER_INPUT".to_string()),
    _ => (-32002, "MIX_MCP_USER_OPERATION_FAILED".to_string()),
  }
}
