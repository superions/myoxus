// SPDX-License-Identifier: AGPL-3.0-or-later
//! Thin privileged MCP adapters over shared organization owners.

use chrono::{DateTime, Utc};
use myoxus_application::audit::AuditActor;
use myoxus_application::organization::OrganizationUnitLifecycleError;
use myoxus_domain::entities::{OrganizationUnit, OrganizationUnitStatus};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{
  McpAuthContext, McpOrganizationServices, McpToolState, begin_mcp_idempotency, finish_or_abort_mcp_write,
  mcp_json_response, parse_uuid,
};

fn services(state: &McpToolState) -> Result<&McpOrganizationServices, (i32, String)> {
  state.organization.as_deref().ok_or_else(|| {
    (
      -32002,
      "MIX_MCP_ORGANIZATION_SERVICE_UNAVAILABLE: organization lifecycle service is unavailable".to_string(),
    )
  })
}

async fn preflight<'a>(
  auth: &McpAuthContext,
  state: &'a McpToolState,
) -> Result<&'a McpOrganizationServices, (i32, String)> {
  let organization = services(state)?;
  super::require_active_global_admin(auth, &organization.auth, "MIX_MCP_ORGANIZATION").await?;
  Ok(organization)
}

pub(super) async fn list(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  let organization = preflight(auth, state).await?;
  let root = organization
    .organizations
    .get_by_key("myoxus")
    .await
    .map_err(map_repo_error)?
    .ok_or_else(|| (-32004, "ORGANIZATION_NOT_FOUND".to_string()))?;
  let status = match params.get("status").and_then(Value::as_str).unwrap_or("active") {
    "active" => Some(OrganizationUnitStatus::Active),
    "disabled" => Some(OrganizationUnitStatus::Disabled),
    "archived" => Some(OrganizationUnitStatus::Archived),
    "all" => None,
    _ => return Err((-32602, "status must be active, disabled, archived or all".to_string())),
  };
  let units = organization.units.list(root.id, status).await.map_err(map_repo_error)?;
  Ok(mcp_json_response(json!({
    "units": units.iter().map(unit_json).collect::<Vec<_>>(),
  })))
}

pub(super) async fn get(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  let organization = preflight(auth, state).await?;
  let id = parse_uuid(params, "unit_id")?;
  let unit = organization
    .units
    .get_by_id(id)
    .await
    .map_err(map_repo_error)?
    .ok_or_else(|| (-32004, "ORGANIZATION_UNIT_NOT_FOUND".to_string()))?;
  Ok(mcp_json_response(unit_json(&unit)))
}

pub(super) async fn create(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let organization = preflight(auth, state).await?;
  let root = organization
    .organizations
    .get_by_key("myoxus")
    .await
    .map_err(map_repo_error)?
    .ok_or_else(|| (-32004, "ORGANIZATION_NOT_FOUND".to_string()))?;
  let id = params
    .get("unit_id")
    .and_then(Value::as_str)
    .map(Uuid::parse_str)
    .transpose()
    .map_err(|_| (-32602, "unit_id must be a valid UUID".to_string()))?
    .unwrap_or_else(Uuid::new_v4);
  let unit = OrganizationUnit {
    id,
    organization_id: root.id,
    parent_unit_id: optional_uuid(params, "parent_unit_id")?,
    unit_type_id: parse_uuid(params, "unit_type_id")?,
    name: required_text(params, "name")?,
    slug: required_text(params, "slug")?,
    description: optional_text(params, "description")?,
    status: parse_status(params.get("status").and_then(Value::as_str).unwrap_or("active"))?,
    max_members: 25,
    metadata: params.get("metadata").cloned().unwrap_or_else(|| json!({})),
    created_by: Some(auth.user_id),
    child_unit_count: 0,
    member_count: 0,
    workspace_count: 0,
    created_at: Utc::now(),
    updated_at: Utc::now(),
  };
  let guard = match begin_mcp_idempotency("organization_unit_create", params, auth, state).await? {
    Ok(guard) => guard,
    Err(replay) => return Ok(replay),
  };
  let result = organization
    .lifecycle
    .create(&unit, AuditActor::api_key(auth.user_id, auth.key_id))
    .await
    .map(|saved| mcp_json_response(unit_json(&saved)))
    .map_err(map_lifecycle_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn update(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let organization = preflight(auth, state).await?;
  let id = parse_uuid(params, "unit_id")?;
  let mut unit = organization
    .units
    .get_by_id(id)
    .await
    .map_err(map_repo_error)?
    .ok_or_else(|| (-32004, "ORGANIZATION_UNIT_NOT_FOUND".to_string()))?;
  if let Some(value) = params.get("name") {
    unit.name = non_empty_value(value, "name")?;
  }
  if let Some(value) = params.get("slug") {
    unit.slug = non_empty_value(value, "slug")?;
  }
  if params.get("description").is_some() {
    unit.description = optional_text(params, "description")?;
  }
  if let Some(value) = params.get("unit_type_id").and_then(Value::as_str) {
    unit.unit_type_id =
      Uuid::parse_str(value).map_err(|_| (-32602, "unit_type_id must be a valid UUID".to_string()))?;
  }
  if params.get("parent_unit_id").is_some() {
    unit.parent_unit_id = optional_uuid(params, "parent_unit_id")?;
  }
  if let Some(status) = params.get("status").and_then(Value::as_str) {
    unit.status = parse_status(status)?;
  }
  if let Some(metadata) = params.get("metadata") {
    unit.metadata = metadata.clone();
  }
  let guard = match begin_mcp_idempotency("organization_unit_update", params, auth, state).await? {
    Ok(guard) => guard,
    Err(replay) => return Ok(replay),
  };
  let result = organization
    .lifecycle
    .update(&unit, AuditActor::api_key(auth.user_id, auth.key_id))
    .await
    .map(|saved| mcp_json_response(unit_json(&saved)))
    .map_err(map_lifecycle_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn move_unit(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let organization = preflight(auth, state).await?;
  let unit_id = parse_uuid(params, "unit_id")?;
  let parent = optional_uuid(params, "parent_unit_id")?;
  let guard = match begin_mcp_idempotency("organization_unit_move", params, auth, state).await? {
    Ok(guard) => guard,
    Err(replay) => return Ok(replay),
  };
  let result = organization
    .lifecycle
    .move_unit(unit_id, parent, AuditActor::api_key(auth.user_id, auth.key_id))
    .await
    .map(|saved| mcp_json_response(unit_json(&saved)))
    .map_err(map_lifecycle_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn set_status(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let organization = preflight(auth, state).await?;
  let unit_id = parse_uuid(params, "unit_id")?;
  let status = parse_status(required_text(params, "status")?.as_str())?;
  let guard = match begin_mcp_idempotency("organization_unit_set_status", params, auth, state).await? {
    Ok(guard) => guard,
    Err(replay) => return Ok(replay),
  };
  let result = organization
    .lifecycle
    .set_status(unit_id, status, AuditActor::api_key(auth.user_id, auth.key_id))
    .await
    .map(|saved| mcp_json_response(unit_json(&saved)))
    .map_err(map_lifecycle_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn delete_preview(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let organization = preflight(auth, state).await?;
  let preview = organization
    .lifecycle
    .deletion_preview(parse_uuid(params, "unit_id")?)
    .await
    .map_err(map_lifecycle_error)?;
  Ok(mcp_json_response(json!({
    "id": preview.id,
    "name": preview.name,
    "status": preview.status.as_str(),
    "updatedAt": preview.updated_at,
    "deletable": preview.deletable,
    "blockers": preview.blockers.iter().map(|blocker| json!({
      "code": blocker.code.as_str(), "count": blocker.count
    })).collect::<Vec<_>>(),
  })))
}

pub(super) async fn delete_permanent(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let organization = preflight(auth, state).await?;
  let unit_id = parse_uuid(params, "unit_id")?;
  let confirmed_name = required_text(params, "confirmed_name")?;
  let revision = required_text(params, "preview_revision")?
    .parse::<DateTime<Utc>>()
    .map_err(|_| (-32602, "preview_revision must be an RFC 3339 timestamp".to_string()))?;
  let guard = match begin_mcp_idempotency("organization_unit_delete_permanent", params, auth, state).await? {
    Ok(guard) => guard,
    Err(replay) => return Ok(replay),
  };
  let result = organization
    .lifecycle
    .delete_permanently(
      unit_id,
      &confirmed_name,
      revision,
      AuditActor::api_key(auth.user_id, auth.key_id),
    )
    .await
    .map(|deleted| mcp_json_response(json!({ "deleted": true, "id": deleted.id, "name": deleted.name })))
    .map_err(map_lifecycle_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

fn unit_json(unit: &OrganizationUnit) -> Value {
  json!({
    "id": unit.id,
    "organizationId": unit.organization_id,
    "parentUnitId": unit.parent_unit_id,
    "unitTypeId": unit.unit_type_id,
    "name": unit.name,
    "slug": unit.slug,
    "description": unit.description,
    "status": unit.status.as_str(),
    "maxMembers": unit.max_members,
    "metadata": unit.metadata,
    "childUnitCount": unit.child_unit_count,
    "memberCount": unit.member_count,
    "workspaceCount": unit.workspace_count,
    "createdAt": unit.created_at,
    "updatedAt": unit.updated_at,
  })
}

fn required_text(params: &Value, key: &str) -> Result<String, (i32, String)> {
  params
    .get(key)
    .map(|value| non_empty_value(value, key))
    .transpose()?
    .ok_or_else(|| (-32602, format!("Missing required parameter: {key}")))
}

fn non_empty_value(value: &Value, key: &str) -> Result<String, (i32, String)> {
  value
    .as_str()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(ToOwned::to_owned)
    .ok_or_else(|| (-32602, format!("{key} must be a non-empty string")))
}

fn optional_text(params: &Value, key: &str) -> Result<Option<String>, (i32, String)> {
  match params.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(Value::String(value)) => Ok(Some(value.clone())),
    Some(_) => Err((-32602, format!("{key} must be a string or null"))),
  }
}

fn optional_uuid(params: &Value, key: &str) -> Result<Option<Uuid>, (i32, String)> {
  match params.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(Value::String(value)) => Uuid::parse_str(value)
      .map(Some)
      .map_err(|_| (-32602, format!("{key} must be a valid UUID or null"))),
    Some(_) => Err((-32602, format!("{key} must be a UUID string or null"))),
  }
}

fn parse_status(value: &str) -> Result<OrganizationUnitStatus, (i32, String)> {
  match value {
    "active" => Ok(OrganizationUnitStatus::Active),
    "disabled" => Ok(OrganizationUnitStatus::Disabled),
    "archived" => Ok(OrganizationUnitStatus::Archived),
    _ => Err((-32602, "status must be active, disabled or archived".to_string())),
  }
}

fn map_lifecycle_error(error: OrganizationUnitLifecycleError) -> (i32, String) {
  let code = match &error {
    OrganizationUnitLifecycleError::NotFound => -32004,
    OrganizationUnitLifecycleError::Storage(_) => -32002,
    _ => -32009,
  };
  (code, error.to_string())
}

fn map_repo_error(error: myoxus_domain::repositories::RepositoryError) -> (i32, String) {
  match error {
    myoxus_domain::repositories::RepositoryError::NotFound(_) => (-32004, "ORGANIZATION_UNIT_NOT_FOUND".to_string()),
    _ => (-32002, "ORGANIZATION_UNIT_STORAGE".to_string()),
  }
}

fn map_read_error(error: myoxus_domain::repositories::RepositoryError) -> (i32, String) {
  use myoxus_domain::repositories::RepositoryError;
  match error {
    RepositoryError::NotFound("organization") => (-32004, "ORGANIZATION_NOT_FOUND".into()),
    RepositoryError::Conflict("ORGANIZATION_UNIT_INACTIVE") => (-32009, "ORGANIZATION_UNIT_INACTIVE".into()),
    RepositoryError::Validation(_) => (-32602, "INVALID_ORGANIZATION_PAGE".into()),
    other => map_repo_error(other),
  }
}

/// Discovery adds no authority: every read requires the owner's current active
/// global Admin role, even with a previously issued organization-scoped key.
pub(super) async fn discover(
  name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  let organization = preflight(auth, state).await?;
  let reads = organization
    .reads
    .as_ref()
    .ok_or_else(|| (-32002, "MIX_MCP_ORGANIZATION_READS_UNAVAILABLE".into()))?;
  let fields: &[&str] = match name {
    "organization_get" => &[],
    "organization_unit_type_list" => &["offset", "limit", "include_inactive"],
    "organization_unit_member_list" => &["unit_id", "role", "offset", "limit", "include_inactive"],
    "user_organization_memberships" => &["user_id", "offset", "limit", "include_inactive"],
    _ => return Err((-32601, "Unknown organization discovery tool".into())),
  };
  if params
    .as_object()
    .is_none_or(|o| o.keys().any(|k| !fields.contains(&k.as_str())))
  {
    return Err((-32602, "Unexpected organization discovery argument".into()));
  }
  if name == "organization_get" {
    let org = reads.default_organization().await.map_err(map_read_error)?;
    return Ok(mcp_json_response(
      json!({"id":org.id,"key":org.key,"name":org.name,"slug":org.slug}),
    ));
  }
  let offset = super::bounded_integer(params, "offset", 0, 0, i64::MAX - 101)?;
  let limit = super::bounded_integer(params, "limit", 20, 1, 100)?;
  let inactive = match params.get("include_inactive") {
    None => false,
    Some(Value::Bool(value)) => *value,
    _ => return Err((-32602, "include_inactive must be boolean".into())),
  };
  match name {
    "organization_unit_type_list" => Ok(mcp_json_response(
      serde_json::to_value(
        reads
          .unit_types_page(inactive, offset, limit)
          .await
          .map_err(map_read_error)?,
      )
      .map_err(|_| (-32002, "MIX_MCP_ORGANIZATION_PROJECTION".into()))?,
    )),
    "organization_unit_member_list" => {
      let role = match params.get("role") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(match value.as_str() {
          "reader" => myoxus_domain::entities::OrganizationUnitRole::Reader,
          "member" => myoxus_domain::entities::OrganizationUnitRole::Member,
          "manager" => myoxus_domain::entities::OrganizationUnitRole::Manager,
          _ => return Err((-32602, "role must be reader, member or manager".into())),
        }),
        _ => return Err((-32602, "role must be text or null".into())),
      };
      let page = reads
        .unit_members_page(parse_uuid(params, "unit_id")?, role, inactive, offset, limit)
        .await
        .map_err(map_read_error)?;
      Ok(mcp_json_response(
        json!({"items":page.items.into_iter().map(|row|json!({"unit_id":row.membership.unit_id,"user_id":row.membership.user_id,"role":row.membership.role.as_str(),"source":row.membership.source.as_str(),"metadata":row.membership.metadata,"created_at":row.membership.created_at,"updated_at":row.membership.updated_at,"email":row.email,"name":row.name,"avatar_url":row.avatar_url})).collect::<Vec<_>>(),"offset":page.offset,"limit":page.limit,"next_offset":page.next_offset}),
      ))
    }
    _ => {
      let page = reads
        .user_memberships_page(parse_uuid(params, "user_id")?, inactive, offset, limit)
        .await
        .map_err(map_read_error)?;
      Ok(mcp_json_response(
        json!({"items":page.items.into_iter().map(|row|json!({"unit_id":row.unit.id,"unit_name":row.unit.name,"unit_slug":row.unit.slug,"unit_status":row.unit.status.as_str(),"role":row.membership.role.as_str(),"source":row.membership.source.as_str(),"metadata":row.membership.metadata,"joined_at":row.membership.created_at})).collect::<Vec<_>>(),"offset":page.offset,"limit":page.limit,"next_offset":page.next_offset}),
      ))
    }
  }
}

/// Administrative membership writes share the transaction/cache/audit owner.
/// Authorization precedes validation and durable replay admission.
pub(super) async fn mutate_member(
  name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  use myoxus_application::organization::{MembershipChange, MembershipOperation};
  use myoxus_domain::entities::OrganizationUnitRole;
  let organization = preflight(auth, state).await?;
  let owner = organization
    .memberships
    .as_ref()
    .ok_or_else(|| (-32002, "MIX_MCP_ORGANIZATION_MEMBERSHIPS_UNAVAILABLE".into()))?;
  let removing = name == "organization_unit_member_remove";
  let fields: &[&str] = if removing {
    &["unit_id", "user_id", "idempotency_key"]
  } else {
    &["unit_id", "user_id", "role", "idempotency_key"]
  };
  if params
    .as_object()
    .is_none_or(|o| o.keys().any(|k| !fields.contains(&k.as_str())))
  {
    return Err((-32602, "Unexpected membership argument".into()));
  }
  let unit_id = parse_uuid(params, "unit_id")?;
  let user_id = parse_uuid(params, "user_id")?;
  let role = if removing {
    OrganizationUnitRole::Reader
  } else {
    match params.get("role").and_then(Value::as_str) {
      Some("reader") => OrganizationUnitRole::Reader,
      Some("member") => OrganizationUnitRole::Member,
      Some("manager") => OrganizationUnitRole::Manager,
      _ => return Err((-32602, "role must be reader, member or manager".into())),
    }
  };
  let operation = match name {
    "organization_unit_member_add" => MembershipOperation::Add,
    "organization_unit_member_set_role" => MembershipOperation::SetRole,
    "organization_unit_member_remove" => MembershipOperation::RemoveExisting,
    _ => return Err((-32601, "Unknown membership tool".into())),
  };
  let guard = match begin_mcp_idempotency(name, params, auth, state).await? {
    Ok(guard) => guard,
    Err(replay) => return Ok(replay),
  };
  let result = owner.apply(MembershipChange { organization_id: None, unit_id, user_id, operation, role, metadata: json!({}), manager_id: None }, AuditActor::api_key(auth.user_id, auth.key_id)).await
    .map(|commit| mcp_json_response(json!({"unit_id":unit_id,"user_id":user_id,"previous_role":commit.previous.map(|m| m.role.as_str()),"role":commit.current.map(|m| m.role.as_str()),"manager_capability_changed":commit.manager_capability.is_some(),"manager_capability":commit.manager_capability})))
    .map_err(map_membership_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

fn map_membership_error(error: myoxus_domain::repositories::RepositoryError) -> (i32, String) {
  use myoxus_domain::repositories::RepositoryError;
  let (code, message) = match error {
    RepositoryError::NotFound("user") => (-32004, "USER_NOT_FOUND"),
    RepositoryError::NotFound(_) => (-32004, "ORGANIZATION_UNIT_NOT_FOUND"),
    RepositoryError::Conflict("user is already a member of this organization unit") => {
      (-32009, "ORGANIZATION_MEMBER_ALREADY_EXISTS")
    }
    RepositoryError::Conflict("user is not a member of this organization unit") => {
      (-32009, "ORGANIZATION_MEMBER_NOT_FOUND")
    }
    RepositoryError::Conflict("organization_unit is not active") => (-32009, "ORGANIZATION_UNIT_INACTIVE"),
    RepositoryError::Conflict("organization_unit member limit reached") => {
      (-32009, "ORGANIZATION_MEMBER_LIMIT_REACHED")
    }
    _ => (-32002, "ORGANIZATION_MEMBERSHIP_STORAGE"),
  };
  (code, message.into())
}
