// SPDX-License-Identifier: AGPL-3.0-or-later
//! Thin MCP adapters for the authoritative Database application service.
//!
//! Query inputs are projected onto [`DatabaseRowsQuery`], so saved-view
//! filters, search and cursor semantics remain server-owned. Row updates use
//! one `bulk_apply_cell_patches` transaction and deliberately expose neither
//! edit revisions nor force-write controls. The 200-patch MCP ceiling bounds
//! agent payloads below the wider product bulk-operation budget.

use myoxus_domain::database::{
  DatabaseBulkCellIntent, DatabaseBulkCellUpdate, DatabaseBulkOperationResult, DatabaseBulkRowPatch,
  DatabaseCsvDelimiter, DatabaseCsvDialect, DatabaseRowCursor, DatabaseRowTemplateApplyRequest, DatabaseRowsQuery,
};
use myoxus_domain::permission::WorkspaceAction;
use myoxus_domain::repositories::PageRequest;
use serde_json::{Value, json};

use super::{
  McpAuthContext, McpToolState, assert_workspace_permission, begin_mcp_idempotency,
  begin_optional_mcp_idempotency_with_payload, build_mcp_import_options, check_workspace_membership, database_services,
  finish_or_abort_mcp_write, mcp_database_error, mcp_json_response, mcp_page, parse_mcp_cell_value,
  parse_mcp_cell_value_map, parse_mcp_import_content, parse_mcp_initial_cells, parse_optional_i64,
  parse_optional_string, parse_optional_uuid, parse_uuid, preflight_database_write, require_mcp_database_scope,
  sha256_hex,
};

const MAX_ROW_PATCHES: usize = 200;

/// Schema reads reuse the complete canonical aggregate, including field/view revisions.
#[tracing::instrument(skip_all)]
pub(super) async fn get(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, false)?;
  schema_arguments(params, &["database_id"], state)?;
  let record = database_services(state)?
    .definition
    .get_database(auth.user_id, parse_uuid(params, "database_id")?)
    .await
    .map_err(schema_read_error)?;
  bounded_schema_response(json!({"database": record}), state, false)
}

#[tracing::instrument(skip_all)]
pub(super) async fn schema_create(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  use myoxus_application::database::InitialDatabaseViewKind;
  require_mcp_database_scope(auth, true)?;
  schema_arguments(
    params,
    &[
      "workspace_id",
      "title",
      "description",
      "initial_view_kind",
      "assistant_confirmation",
      "idempotency_key",
    ],
    state,
  )?;
  let services = database_services(state)?;
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let prepared = if let Some(confirmation) = params.get("assistant_confirmation") {
    Some(
      super::database_assistants::canonical_confirmation(state, auth.user_id, workspace_id, confirmation.clone())
        .await?,
    )
  } else {
    None
  };
  let title = params
    .get("title")
    .and_then(Value::as_str)
    .ok_or_else(|| (-32602, "title must be a string".into()))?;
  let title = services
    .definition
    .validate_database_creation(auth.user_id, workspace_id, title)
    .await
    .map_err(schema_read_error)?;
  let description = parse_optional_string(params, "description")?;
  let kind = if let Some(confirmation) = &prepared {
    let plan = &confirmation.plan;
    if let Some(value) = params.get("initial_view_kind")
      && value.as_str() != Some(plan.initial_view_kind.as_str())
    {
      return Err((-32602, "initial View differs from reviewed assistant plan".into()));
    }
    None
  } else {
    Some(match params.get("initial_view_kind") {
      None => InitialDatabaseViewKind::Table,
      Some(Value::String(value)) if value == "table" => InitialDatabaseViewKind::Table,
      Some(Value::String(value)) if value == "kanban" => InitialDatabaseViewKind::Kanban,
      _ => {
        return Err((
          -32602,
          "initial_view_kind must be table or kanban for Generic creation".into(),
        ));
      }
    })
  };
  if let Some(confirmation) = &prepared {
    let plan = &confirmation.plan;
    if title != plan.title || (params.get("description").is_some() && description != plan.description) {
      return Err((
        -32602,
        "native creation fields differ from reviewed assistant plan".into(),
      ));
    }
  }
  let semantic = if let Some(confirmation) = &prepared {
    // Current catalog admission can change during recovery; the original
    // explicit request remains the transport semantic identity.
    json!({"workspace_id":workspace_id,"title":title,"description":description,
      "initial_view_kind":params.get("initial_view_kind"),"assistant":confirmation.input})
  } else {
    json!({"workspace_id": workspace_id, "title": title, "description": description, "initial_view_kind": if kind == Some(InitialDatabaseViewKind::Table) {"table"} else {"kanban"}})
  };
  let guard = match crate::idempotency::begin(
    super::IdempotencyRequirement::Required,
    "database_create",
    params,
    Some(&semantic),
    auth,
    &state.idempotency,
  )
  .await?
  {
    super::IdempotencyBeginOutcome::Replay(response) => {
      let id = super::mcp_result_nested_string(&response, &["database", "database", "id"])
        .and_then(|id| id.parse::<uuid::Uuid>().ok())
        .ok_or_else(|| (-32002, "created Database readback unavailable".into()))?;
      let current = services
        .definition
        .get_database(auth.user_id, id)
        .await
        .map_err(schema_read_error)?;
      if current.database.workspace_id != workspace_id {
        return Err((-32004, "created Database no longer belongs to this workspace".into()));
      }
      return Ok(response);
    }
    super::IdempotencyBeginOutcome::Execute(guard) => guard,
  };
  let result = if let Some(confirmation) = prepared {
    let initial_key = confirmation.plan.initial_view_key.clone();
    state
      .workspace_service
      .create_project_starter(
        auth.user_id,
        workspace_id,
        confirmation.input,
        super::database_assistants::service(state)?,
      )
      .await
      .map_err(super::database_assistants::starter_error)
      .and_then(|outcome| {
        if outcome.status != myoxus_application::workspace::ProjectStarterStatus::Ready {
          return Err((
            -32010,
            "MIX_ASSISTANT_RECOVERY_REQUIRED: accepted Project setup requires readback or review".into(),
          ));
        }
        let record = outcome
          .database
          .ok_or_else(|| (-32002, "accepted Project result unavailable".into()))?;
        let initial = record
          .database
          .managed_installation
          .as_ref()
          .and_then(|installation| installation.view_bindings.get(&initial_key))
          .copied();
        Ok(json!({"database":record,"initialViewId":initial}))
      })
  } else {
    services
      .definition
      .create_database(
        auth.user_id,
        workspace_id,
        title,
        description,
        kind.expect("validated Generic initial View"),
      )
      .await
      .map_err(schema_write_error)
      .map(|record| json!({"database":record}))
  }
  .and_then(|value| bounded_schema_response(value, state, true));
  finish_schema_write(guard, &state.idempotency, result).await
}

/// Current authority precedes execution and returned replay. Lifecycle predicates
/// and optimistic revisions are still enforced by the same GraphQL service paths.
#[tracing::instrument(skip_all)]
pub(super) async fn schema_mutate(
  name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, true)?;
  let purge = name == "database_delete_permanently";
  let allowed = match name {
    "database_update" => &[
      "database_id",
      "title",
      "description",
      "expected_edit_revision",
      "idempotency_key",
    ][..],
    "database_trash" | "database_restore" => &["database_id", "expected_edit_revision", "idempotency_key"][..],
    "database_delete_permanently" => &[
      "workspace_id",
      "database_id",
      "confirm",
      "expected_edit_revision",
      "idempotency_key",
    ][..],
    _ => return Err((-32601, "Unknown Database schema operation".into())),
  };
  let args = schema_arguments(params, allowed, state)?;
  let database_id = parse_uuid(params, "database_id")?;
  let revision = params
    .get("expected_edit_revision")
    .and_then(Value::as_i64)
    .filter(|value| *value > 0)
    .ok_or_else(|| (-32602, "expected_edit_revision must be a positive integer".into()))?;
  if purge && params.get("confirm").and_then(Value::as_bool) != Some(true) {
    return Err((-32602, "Permanent deletion requires confirm=true".into()));
  }
  let title = if name == "database_update" {
    match params.get("title") {
      None => None,
      Some(Value::String(value)) => {
        Some(myoxus_application::database::definition::rules::validate_title(value).map_err(schema_read_error)?)
      }
      _ => return Err((-32602, "title must be a string when supplied".into())),
    }
  } else {
    None
  };
  let description = super::parse_optional_string_patch(args, "description")?;
  let services = database_services(state)?;
  let workspace_id = if purge {
    Some(parse_uuid(params, "workspace_id")?)
  } else {
    None
  };
  if let Some(workspace_id) = workspace_id {
    services
      .views
      .assert_workspace_read(auth.user_id, workspace_id)
      .await
      .map_err(schema_read_error)?;
  }
  let record = match services
    .definition
    .validate_database_management(auth.user_id, database_id)
    .await
  {
    Ok(record) => {
      if workspace_id.is_some_and(|id| id != record.database.workspace_id) {
        return Err((-32004, "MIX_DATABASE_NOT_FOUND: database not found".into()));
      }
      Some(record)
    }
    Err(error) if purge && error.code == myoxus_application::database::ERR_NOT_FOUND => None,
    Err(error) => return Err(schema_read_error(error)),
  };
  let semantic = json!({"database_id": database_id, "workspace_id": workspace_id, "title": title,
    "description": description, "description_provided": args.contains_key("description"), "expected_edit_revision": revision, "confirm": purge});
  let guard = match crate::idempotency::begin(
    super::IdempotencyRequirement::Required,
    name,
    params,
    Some(&semantic),
    auth,
    &state.idempotency,
  )
  .await?
  {
    super::IdempotencyBeginOutcome::Replay(response) => {
      // Purged aggregates cannot be reloaded. Only a matching completed receipt
      // supplies the historical creator; new requests cannot assert that identity.
      if record.is_none() {
        let payload = super::normalize_legacy_tool_result(response.clone());
        let original_workspace = payload
          .get("workspaceId")
          .and_then(Value::as_str)
          .and_then(|id| id.parse().ok())
          .ok_or_else(|| (-32002, "Invalid Database purge receipt".into()))?;
        let original_creator = match payload.get("createdBy") {
          Some(Value::Null) => None,
          Some(Value::String(id)) => Some(
            id.parse()
              .map_err(|_| (-32002, "Invalid Database purge receipt".to_owned()))?,
          ),
          _ => return Err((-32002, "Invalid Database purge receipt".into())),
        };
        if Some(original_workspace) != workspace_id {
          return Err((-32004, "MIX_DATABASE_NOT_FOUND: database not found".into()));
        }
        services
          .definition
          .validate_database_receipt_authority(auth.user_id, original_workspace, original_creator)
          .await
          .map_err(schema_read_error)?;
      }
      return Ok(response);
    }
    super::IdempotencyBeginOutcome::Execute(guard) => guard,
  };
  let result = async {
    let record = record.ok_or_else(|| (-32004, "MIX_DATABASE_NOT_FOUND: database not found".to_owned()))?;
    let output = match name {
      "database_update" => json!({"database": services.definition.update_database_with_precondition(auth.user_id, database_id, title, description, Some(revision), false).await.map_err(schema_write_error)?}),
      "database_trash" => json!({"database": services.definition.trash_database_with_precondition(auth.user_id, database_id, Some(revision), false).await.map_err(schema_write_error)?}),
      "database_restore" => json!({"database": services.definition.restore_database_with_precondition(auth.user_id, database_id, Some(revision), false).await.map_err(schema_write_error)?}),
      _ => {
        services.definition.delete_database_permanently_with_precondition(auth.user_id, database_id, Some(revision), false).await.map_err(schema_write_error)?;
        json!({"databaseId": database_id, "workspaceId": record.database.workspace_id, "createdBy": record.database.created_by, "deleted": true})
      }
    };
    bounded_schema_response(output, state, true)
  }.await;
  finish_schema_write(guard, &state.idempotency, result).await
}

/// Structural writes keep the canonical field owner and SQL revision comparisons.
/// Formula dependency writes are composed; unknown failures retain admission.
#[tracing::instrument(skip_all)]
pub(super) async fn field_mutate(
  name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  use myoxus_domain::database::{DatabaseFieldConfig, DatabaseFieldType};
  require_mcp_database_scope(auth, true)?;
  let allowed = match name {
    "database_field_create" => &[
      "database_id",
      "name",
      "field_type",
      "config",
      "required",
      "idempotency_key",
    ][..],
    "database_field_update" => &[
      "database_id",
      "field_id",
      "name",
      "config",
      "required",
      "expected_edit_revision",
      "idempotency_key",
    ][..],
    "database_field_delete" => &["database_id", "field_id", "expected_edit_revision", "idempotency_key"][..],
    "database_field_reorder" => &["database_id", "field_ids", "expected_edit_revisions", "idempotency_key"][..],
    _ => return Err((-32601, "Unknown Database field operation".into())),
  };
  schema_arguments(params, allowed, state)?;
  let database_id = parse_uuid(params, "database_id")?;
  let services = database_services(state)?;
  let record = services
    .definition
    .validate_database_management(auth.user_id, database_id)
    .await
    .map_err(field_read_error)?;
  let create = name == "database_field_create";
  let field_id = if matches!(name, "database_field_update" | "database_field_delete") {
    Some(parse_uuid(params, "field_id")?)
  } else {
    None
  };
  let field_type = if create {
    Some(
      serde_json::from_value::<DatabaseFieldType>(
        params
          .get("field_type")
          .cloned()
          .ok_or_else(|| (-32602, "field_type is required".to_owned()))?,
      )
      .map_err(|_| (-32602, "Unknown canonical field type".to_owned()))?,
    )
  } else {
    None
  };
  let field_name = match params.get("name") {
    Some(Value::String(value)) if value.chars().count() <= 512 => {
      Some(myoxus_application::database::definition::rules::validate_title(value).map_err(field_read_error)?)
    }
    None if !create => None,
    _ => {
      return Err((
        -32602,
        "name must be a nonempty string of at most 512 characters".into(),
      ));
    }
  };
  let required = match params.get("required") {
    None => {
      if create {
        Some(false)
      } else {
        None
      }
    }
    Some(Value::Bool(value)) => Some(*value),
    _ => return Err((-32602, "required must be boolean when supplied".into())),
  };
  let config = match params.get("config") {
    Some(value) => Some(canonical_field_config(value)?),
    None => field_type.map(DatabaseFieldConfig::empty_for),
  };
  if let Some(config) = &config
    && let Some(kind) = field_type.or_else(|| {
      record
        .fields
        .iter()
        .find(|field| Some(field.id) == field_id)
        .map(|field| field.field_type)
    })
  {
    myoxus_application::database::definition::rules::validate_field_config(kind, config).map_err(field_read_error)?;
  }
  let revision = if field_id.is_some() {
    Some(structural_revision(params.get("expected_edit_revision"))?)
  } else {
    None
  };
  let (field_ids, revisions) = if name == "database_field_reorder" {
    structural_order(params, "field_ids")?
  } else {
    Default::default()
  };
  let semantic = json!({"database_id":database_id,"field_id":field_id,"name":field_name,"field_type":field_type,"config":config,"required":required,"expected_edit_revision":revision,"field_ids":field_ids,"expected_edit_revisions":revisions});
  let guard = match crate::idempotency::begin(
    super::IdempotencyRequirement::Required,
    name,
    params,
    Some(&semantic),
    auth,
    &state.idempotency,
  )
  .await?
  {
    super::IdempotencyBeginOutcome::Replay(response) => return Ok(response),
    super::IdempotencyBeginOutcome::Execute(guard) => guard,
  };
  let result = async {
    let output = match name {
      "database_field_create" => json!({"databaseId":database_id,"field":services.definition.create_field(auth.user_id, database_id, field_name.expect("validated create name"), field_type.expect("validated create type"), config.expect("canonical create config"), required.expect("default required")).await.map_err(field_write_error)?}),
      "database_field_update" => json!({"databaseId":database_id,"field":services.definition.update_field_with_precondition(auth.user_id, database_id, field_id.expect("update identity"), field_name, config, required, revision, false).await.map_err(field_write_error)?}),
      "database_field_delete" => {
        services.definition.delete_field_with_precondition(auth.user_id, database_id, field_id.expect("delete identity"), revision, false).await.map_err(field_write_error)?;
        json!({"databaseId":database_id,"fieldId":field_id,"deleted":true})
      },
      _ => json!({"databaseId":database_id,"fields":services.definition.reorder_fields_with_precondition(auth.user_id, database_id, field_ids, &revisions, false).await.map_err(field_write_error)?}),
    };
    bounded_schema_response(output, state, true)
  }.await;
  finish_schema_write(guard, &state.idempotency, result).await
}

/// Shared schema and actor-effective query projection remain separate owners.
#[tracing::instrument(skip_all)]
pub(super) async fn view_get(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, false)?;
  schema_arguments(params, &["database_id", "view_id"], state)?;
  let database_id = parse_uuid(params, "database_id")?;
  let view_id = parse_uuid(params, "view_id")?;
  let services = database_services(state)?;
  let record = services
    .definition
    .get_database(auth.user_id, database_id)
    .await
    .map_err(view_read_error)?;
  let view = record
    .views
    .into_iter()
    .find(|view| view.id == view_id)
    .ok_or_else(|| (-32004, "MIX_DATABASE_NOT_FOUND: saved view not found".to_owned()))?;
  let effective = services
    .views
    .effective_view_state(auth.user_id, database_id, view_id)
    .await
    .map_err(view_read_error)?;
  // Never rewrite the saved config with personal overrides or return another actor's state.
  bounded_schema_response(
    json!({"databaseId":database_id,"view":view,
    "effectiveSort":effective.effective_sort,"effectiveFilterTree":effective.effective_filter_tree,
    "searchText":effective.search_text,"effectiveFieldWidths":effective.effective_field_widths,
    "canEditShared":effective.can_edit_shared}),
    state,
    false,
  )
}

#[tracing::instrument(skip_all)]
pub(super) async fn view_mutate(
  name: &str,
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  use myoxus_domain::database::{DatabaseViewConfig, DatabaseViewIcon, DatabaseViewKind};
  require_mcp_database_scope(auth, true)?;
  let allowed = match name {
    "database_view_create" => &["database_id", "name", "view_kind", "icon", "config", "idempotency_key"][..],
    "database_view_update" => &[
      "database_id",
      "view_id",
      "name",
      "view_kind",
      "icon",
      "config",
      "expected_edit_revision",
      "idempotency_key",
    ][..],
    "database_view_delete" => &[
      "database_id",
      "view_id",
      "replacement_view_id",
      "expected_edit_revision",
      "idempotency_key",
    ][..],
    "database_view_reorder" => &["database_id", "view_ids", "expected_edit_revisions", "idempotency_key"][..],
    _ => return Err((-32601, "Unknown saved-view operation".into())),
  };
  let args = schema_arguments(params, allowed, state)?;
  let database_id = parse_uuid(params, "database_id")?;
  let services = database_services(state)?;
  services
    .definition
    .validate_database_management(auth.user_id, database_id)
    .await
    .map_err(view_read_error)?;
  let create = name == "database_view_create";
  let view_id = if matches!(name, "database_view_update" | "database_view_delete") {
    Some(parse_uuid(params, "view_id")?)
  } else {
    None
  };
  let revision = if view_id.is_some() {
    Some(structural_revision(params.get("expected_edit_revision"))?)
  } else {
    None
  };
  let view_name = match params.get("name") {
    Some(Value::String(value)) if value.chars().count() <= 512 => {
      Some(myoxus_application::database::definition::rules::validate_title(value).map_err(view_read_error)?)
    }
    None if !create => None,
    _ => {
      return Err((
        -32602,
        "name must be a nonempty string of at most 512 characters".into(),
      ));
    }
  };
  let kind: Option<DatabaseViewKind> = match params.get("view_kind") {
    Some(value) => {
      Some(serde_json::from_value(value.clone()).map_err(|_| (-32602, "Invalid canonical view kind".to_owned()))?)
    }
    None if !create => None,
    _ => return Err((-32602, "view_kind is required".into())),
  };
  let config: Option<DatabaseViewConfig> = match params.get("config") {
    Some(value) => Some(canonical_view_config(value)?),
    None if !create => None,
    _ => return Err((-32602, "config is required".into())),
  };
  let icon: Option<Option<DatabaseViewIcon>> = match params.get("icon") {
    None => None,
    Some(Value::Null) => Some(None),
    Some(value) => {
      let icon: DatabaseViewIcon =
        serde_json::from_value(value.clone()).map_err(|_| (-32602, "Invalid canonical view icon".to_owned()))?;
      if serde_json::to_value(&icon).map_err(|_| (-32602, "Invalid view icon".to_owned()))? != *value {
        return Err((-32602, "Unknown view icon argument".into()));
      }
      icon.validate().map_err(|_| (-32602, "Invalid view icon".to_owned()))?;
      Some(Some(icon))
    }
  };
  // Pure input kind/config mismatch is rejected before admission. Mutable
  // field references and retained configs belong to the canonical write owner;
  // checking them here could reject an otherwise authorized completed replay.
  if let (Some(kind), Some(config)) = (kind, config.as_ref())
    && !config.matches_view_kind(kind)
  {
    return Err((-32602, "View config does not match view_kind".into()));
  }
  let replacement = match params.get("replacement_view_id") {
    None => None,
    Some(Value::String(_)) => Some(parse_uuid(params, "replacement_view_id")?),
    _ => return Err((-32602, "replacement_view_id must be a UUID when supplied".into())),
  };
  let (ids, revisions) = if name == "database_view_reorder" {
    structural_order(params, "view_ids")?
  } else {
    Default::default()
  };
  // JSON null cannot represent patch omission: retain the icon-presence bit in admission.
  let semantic = json!({"database_id":database_id,"view_id":view_id,"name":view_name,"view_kind":kind,"config":config,"icon":icon,"icon_provided":args.contains_key("icon"),"expected_edit_revision":revision,"replacement_view_id":replacement,"view_ids":ids,"expected_edit_revisions":revisions});
  let guard = match crate::idempotency::begin(
    super::IdempotencyRequirement::Required,
    name,
    params,
    Some(&semantic),
    auth,
    &state.idempotency,
  )
  .await?
  {
    super::IdempotencyBeginOutcome::Replay(response) => return Ok(response),
    super::IdempotencyBeginOutcome::Execute(guard) => guard,
  };
  let result = async {
    let output = match name {
      "database_view_create" => json!({"databaseId":database_id,"view":services.views.create_view_with_icon(auth.user_id,database_id,view_name.expect("create name"),kind.expect("create kind"),icon.flatten(),config.expect("create config")).await.map_err(view_write_error)?}),
      "database_view_update" => json!({"databaseId":database_id,"view":services.views.update_view_with_icon_precondition(auth.user_id,database_id,view_id.expect("update identity"),view_name,kind,icon,config,revision,false).await.map_err(view_write_error)?}),
      "database_view_delete" => {
        services.views.delete_view_with_precondition(auth.user_id,database_id,view_id.expect("delete identity"),replacement,revision,false).await.map_err(view_write_error)?;
        json!({"databaseId":database_id,"viewId":view_id,"deleted":true})
      },
      _ => json!({"databaseId":database_id,"views":services.views.reorder_views_with_precondition(auth.user_id,database_id,ids,&revisions,false).await.map_err(view_write_error)?}),
    };
    bounded_schema_response(output,state,true)
  }.await;
  finish_schema_write(guard, &state.idempotency, result).await
}

fn canonical_view_config(value: &Value) -> Result<myoxus_domain::database::DatabaseViewConfig, (i32, String)> {
  if value.to_string().len() > 65536 {
    return Err((-32602, "View config exceeds its byte bound".into()));
  }
  let config =
    serde_json::from_value(value.clone()).map_err(|_| (-32602, "Invalid canonical view config".to_owned()))?;
  if serde_json::to_value(&config).map_err(|_| (-32602, "Invalid view config".to_owned()))? != *value {
    return Err((-32602, "config must use the complete canonical view shape".into()));
  }
  Ok(config)
}

fn view_read_error(mut error: myoxus_application::database::DatabaseServiceError) -> (i32, String) {
  error.message = "Database saved-view request was rejected".into();
  schema_read_error(error)
}

fn view_write_error(error: myoxus_application::database::DatabaseServiceError) -> (i32, String) {
  if error.is_retryable_storage_failure() {
    schema_write_error(error)
  } else {
    view_read_error(error)
  }
}

// Formula parser errors can echo caller-defined identifiers. Keep stable domain
// codes while withholding formula/config content from transport errors.
fn field_read_error(mut error: myoxus_application::database::DatabaseServiceError) -> (i32, String) {
  error.message = "Database field request was rejected".into();
  schema_read_error(error)
}

fn field_write_error(error: myoxus_application::database::DatabaseServiceError) -> (i32, String) {
  if error.is_retryable_storage_failure() {
    schema_write_error(error)
  } else {
    field_read_error(error)
  }
}

/// Configs use the existing complete serde shape. Roundtrip equality rejects
/// unknown keys instead of silently discarding requested configuration.
fn canonical_field_config(value: &Value) -> Result<myoxus_domain::database::DatabaseFieldConfig, (i32, String)> {
  if value.to_string().len() > 65536
    || value
      .get("options")
      .and_then(Value::as_array)
      .is_some_and(|options| options.len() > 200)
  {
    return Err((-32602, "Field config exceeds its byte/option bounds".into()));
  }
  let config =
    serde_json::from_value(value.clone()).map_err(|_| (-32602, "Invalid canonical field config".to_owned()))?;
  if serde_json::to_value(&config).map_err(|_| (-32602, "Invalid field config".to_owned()))? != *value {
    return Err((-32602, "config must use the complete canonical field shape".into()));
  }
  Ok(config)
}

fn structural_revision(value: Option<&Value>) -> Result<i64, (i32, String)> {
  value
    .and_then(Value::as_i64)
    .filter(|revision| *revision > 0)
    .ok_or_else(|| (-32602, "Expected a positive edit revision".into()))
}

/// Every reordered ID carries its captured revision; partial maps cannot waive
/// SQL concurrency checks. The canonical owner validates membership and order.
fn structural_order(
  params: &Value,
  ids_key: &str,
) -> Result<(Vec<uuid::Uuid>, std::collections::HashMap<uuid::Uuid, i64>), (i32, String)> {
  let ids = params
    .get(ids_key)
    .and_then(Value::as_array)
    .filter(|ids| !ids.is_empty() && ids.len() <= 200)
    .ok_or_else(|| (-32602, "Order must contain between 1 and 200 IDs".to_owned()))?;
  let ids = ids
    .iter()
    .map(|id| {
      id.as_str()
        .and_then(|id| id.parse().ok())
        .ok_or_else(|| (-32602, "Order IDs must be UUIDs".to_owned()))
    })
    .collect::<Result<Vec<uuid::Uuid>, _>>()?;
  let unique = ids.iter().copied().collect::<std::collections::BTreeSet<_>>();
  let revisions = params
    .get("expected_edit_revisions")
    .and_then(Value::as_object)
    .ok_or_else(|| {
      (
        -32602,
        "expected_edit_revisions must map UUIDs to captured revisions".to_owned(),
      )
    })?;
  if unique.len() != ids.len() || revisions.len() != ids.len() {
    return Err((-32602, "Order IDs and revisions must match without duplicates".into()));
  }
  let revisions = revisions
    .iter()
    .map(|(id, value)| {
      let id = id
        .parse::<uuid::Uuid>()
        .map_err(|_| (-32602, "Revision IDs must be UUIDs".to_owned()))?;
      if !unique.contains(&id) {
        return Err((-32602, "Revision IDs must match ordered IDs".into()));
      }
      Ok((id, structural_revision(Some(value))?))
    })
    .collect::<Result<std::collections::HashMap<_, _>, (i32, String)>>()?;
  // Distinct UUID spellings must not collapse two entries into one revision.
  if revisions.len() != ids.len() {
    return Err((-32602, "Revision IDs must be distinct".into()));
  }
  Ok((ids, revisions))
}

/// Authorization and revision conflicts precede writes or roll back.
/// Validation and NotFound may arise from post-commit decoding/readback, so both
/// retain admission together with storage and post-commit projection failures.
async fn finish_schema_write(
  guard: super::McpIdempotencyGuard,
  repository: &std::sync::Arc<dyn myoxus_application::mcp::McpIdempotencyRepository>,
  result: Result<Value, (i32, String)>,
) -> Result<Value, (i32, String)> {
  if matches!(&result, Err((code, _)) if matches!(code, -32003 | -32010)) {
    if let super::McpIdempotencyGuard::Pending { row_id, .. } = guard {
      repository.abort(row_id).await.map_err(|_| {
        (
          -32002,
          "MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED_UNCERTAIN: Database admission cleanup requires operator readback"
            .to_owned(),
        )
      })?;
    }
    return result;
  }
  crate::idempotency::finish_or_abort(guard, repository, result).await
}

pub(super) fn schema_arguments<'a>(
  params: &'a Value,
  allowed: &[&str],
  state: &McpToolState,
) -> Result<&'a serde_json::Map<String, Value>, (i32, String)> {
  let args = params
    .as_object()
    .ok_or_else(|| (-32602, "Expected Database arguments object".into()))?;
  if args.keys().any(|key| !allowed.contains(&key.as_str())) {
    return Err((-32602, "Unknown Database argument".into()));
  }
  for (key, limit) in [("title", 512), ("description", 65536)] {
    if params
      .get(key)
      .and_then(Value::as_str)
      .is_some_and(|value| value.chars().count() > limit)
    {
      return Err((-32602, format!("{key} exceeds its character limit")));
    }
  }
  if params.to_string().len() > state.document_export_max_bytes {
    return Err((-32602, "Database input exceeds byte limit".into()));
  }
  Ok(args)
}

fn schema_read_error(error: myoxus_application::database::DatabaseServiceError) -> (i32, String) {
  if error.is_retryable_storage_failure() {
    (
      -32002,
      "MIX_DATABASE_STORAGE: Database capability is unavailable".into(),
    )
  } else if matches!(
    error.code,
    myoxus_application::database::ERR_DATABASE_CONFLICT
      | myoxus_application::database::ERR_FIELD_CONFLICT
      | myoxus_application::database::ERR_VIEW_CONFLICT
  ) {
    (-32010, format!("{}: {}", error.code, error.message))
  } else if matches!(
    error.code,
    myoxus_application::database::ERR_FORBIDDEN | myoxus_application::database::ERR_NOT_FOUND
  ) {
    mcp_database_error(error)
  } else {
    (-32602, format!("{}: {}", error.code, error.message))
  }
}

fn schema_write_error(error: myoxus_application::database::DatabaseServiceError) -> (i32, String) {
  if error.is_retryable_storage_failure() {
    (
      -32002,
      "MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED_UNCERTAIN: Database write requires operator readback".into(),
    )
  } else {
    schema_read_error(error)
  }
}

pub(super) fn bounded_schema_response(
  value: Value,
  state: &McpToolState,
  after_write: bool,
) -> Result<Value, (i32, String)> {
  if value.to_string().len() > state.document_export_max_bytes {
    return Err(if after_write {
      (
        -32002,
        "MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED_UNCERTAIN: Database readback exceeds byte limit".into(),
      )
    } else {
      (-32009, "RESULT_TOO_LARGE: Database readback exceeds byte limit".into())
    });
  }
  Ok(mcp_json_response(value))
}

pub(super) async fn list(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, false)?;
  let service = &database_services(state)?.views;
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let page = mcp_page(params, 50, 200)?;
  let databases = service
    .list_databases(auth.user_id, workspace_id, page, Default::default())
    .await
    .map_err(mcp_database_error)?;
  Ok(mcp_json_response(
    json!({ "workspaceId": workspace_id, "databases": databases }),
  ))
}

pub(super) async fn query(params: &Value, auth: &McpAuthContext, state: &McpToolState) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, false)?;
  let services = database_services(state)?;
  let database_id = parse_uuid(params, "database_id")?;
  let limit = parse_optional_i64(params, "limit")?.unwrap_or(50).clamp(1, 200);
  let cursor = parse_row_cursor(params)?;
  let page = PageRequest {
    limit,
    // Preserve the established offset input until callers migrate to cursors,
    // but never combine offset and cursor pagination.
    offset: if cursor.is_some() {
      0
    } else {
      parse_optional_i64(params, "offset")?.unwrap_or(0).max(0)
    },
  };
  let database = services
    .definition
    .get_database(auth.user_id, database_id)
    .await
    .map_err(mcp_database_error)?;
  let rows = services
    .views
    .list_rows_query(
      auth.user_id,
      database_id,
      page,
      DatabaseRowsQuery {
        view_id: parse_optional_uuid(params, "view_id")?,
        search: parse_optional_string(params, "search")?,
        first: Some(limit),
        after: cursor,
        ..Default::default()
      },
    )
    .await
    .map_err(mcp_database_error)?;
  let rows_json = rows
    .rows
    .into_iter()
    .map(|row| {
      json!({
        "row": row.row,
        "cells": row.cells,
        "redacted": row.redacted,
      })
    })
    .collect::<Vec<_>>();
  Ok(mcp_json_response(json!({
    "database": database,
    "rows": rows_json,
    "totalCount": rows.total_count,
    "nextCursor": rows.end_cursor,
  })))
}

pub(super) async fn row_get(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, false)?;
  let service = &database_services(state)?.views;
  let database_id = parse_uuid(params, "database_id")?;
  let row_id = parse_uuid(params, "row_id")?;
  let row = service
    .get_row(auth.user_id, database_id, row_id)
    .await
    .map_err(mcp_database_error)?
    .ok_or_else(|| (-32004, "MIX_DATABASE_NOT_FOUND: database row not found".to_string()))?;
  Ok(mcp_json_response(json!({
    "row": {
      "row": row.row,
      "cells": row.cells,
      "redacted": row.redacted,
    }
  })))
}

pub(super) async fn row_update(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, true)?;
  crate::idempotency::validate_required_key(params)?;
  let services = database_services(state)?;
  let database_id = parse_uuid(params, "database_id")?;
  let row_id = parse_uuid(params, "row_id")?;
  preflight_database_write(state, &services.definition, auth.user_id, database_id).await?;
  let cells = parse_row_patches(params)?;
  let guard = match begin_mcp_idempotency("database_row_update", params, auth, state).await? {
    Ok(guard) => guard,
    Err(replay) => return Ok(replay),
  };
  let result = services
    .editing
    .bulk_apply_cell_patches(auth.user_id, database_id, &[DatabaseBulkRowPatch { row_id, cells }])
    .await
    .map_err(mcp_database_error)
    .and_then(ensure_bulk_success)
    .map(|result| mcp_json_response(json!({ "rowId": row_id, "result": result })));
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn row_delete(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  row_lifecycle(params, auth, state, false).await
}

pub(super) async fn row_restore(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  row_lifecycle(params, auth, state, true).await
}

async fn row_lifecycle(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
  restore: bool,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, true)?;
  crate::idempotency::validate_required_key(params)?;
  let services = database_services(state)?;
  let database_id = parse_uuid(params, "database_id")?;
  let row_id = parse_uuid(params, "row_id")?;
  preflight_database_write(state, &services.definition, auth.user_id, database_id).await?;
  let tool_name = if restore {
    "database_row_restore"
  } else {
    "database_row_delete"
  };
  let guard = match begin_mcp_idempotency(tool_name, params, auth, state).await? {
    Ok(guard) => guard,
    Err(replay) => return Ok(replay),
  };
  let result = if restore {
    services
      .editing
      .bulk_restore_rows(auth.user_id, database_id, &[row_id])
      .await
  } else {
    services
      .editing
      .bulk_delete_rows(auth.user_id, database_id, &[row_id])
      .await
  }
  .map_err(mcp_database_error)
  .and_then(ensure_bulk_success)
  .map(|result| {
    if restore {
      mcp_json_response(json!({ "rowId": row_id, "restored": true, "result": result }))
    } else {
      mcp_json_response(json!({ "rowId": row_id, "deleted": true, "result": result }))
    }
  });
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn csv_export(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, false)?;
  let service = &database_services(state)?.import_export;
  let database_id = parse_uuid(params, "database_id")?;
  let view_id = parse_optional_uuid(params, "view_id")?;
  let export = service
    .export_csv(
      auth.user_id,
      database_id,
      view_id,
      DatabaseCsvDialect {
        delimiter: DatabaseCsvDelimiter::Comma,
        ..Default::default()
      },
    )
    .await
    .map_err(mcp_database_error)?;
  Ok(mcp_json_response(json!({ "export": export })))
}

pub(super) async fn json_export(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, false)?;
  let service = &database_services(state)?.import_export;
  let database_id = parse_uuid(params, "database_id")?;
  let export = service
    .export_json(auth.user_id, database_id)
    .await
    .map_err(mcp_database_error)?;
  Ok(mcp_json_response(json!({ "export": export })))
}

pub(super) async fn json_import_preview(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, false)?;
  let service = &database_services(state)?.import_export;
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let content = parse_mcp_import_content(params)?;
  let options = build_mcp_import_options(params, workspace_id);
  let preview = service
    .preview_json_import_with_options(auth.user_id, workspace_id, content.as_slice(), options)
    .await
    .map_err(mcp_database_error)?;
  Ok(mcp_json_response(json!({ "preview": preview })))
}

pub(super) async fn json_import(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, true)?;
  let service = &database_services(state)?.import_export;
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let content = parse_mcp_import_content(params)?;
  let options = build_mcp_import_options(params, workspace_id);
  let target_workspace_id = parse_optional_uuid(params, "target_workspace_id")?.unwrap_or(workspace_id);
  check_workspace_membership(&state.workspace_service, auth.user_id, target_workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, target_workspace_id, WorkspaceAction::CreateDoc).await?;
  let semantic_payload = import_idempotency_payload(params, &content);
  let guard = match begin_optional_mcp_idempotency_with_payload(
    "database_json_import",
    params,
    Some(&semantic_payload),
    auth,
    state,
  )
  .await?
  {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = service
    .import_json_with_options(auth.user_id, workspace_id, content.as_slice(), options, None)
    .await
    .map(|result| mcp_json_response(json!({ "result": result })))
    .map_err(mcp_database_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn notion_export(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, false)?;
  let service = &database_services(state)?.import_export;
  let database_id = parse_uuid(params, "database_id")?;
  let export = service
    .export_notion(auth.user_id, database_id)
    .await
    .map_err(mcp_database_error)?;
  Ok(mcp_json_response(json!({ "export": export })))
}

pub(super) async fn notion_import_preview(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, false)?;
  let service = &database_services(state)?.import_export;
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let content = parse_mcp_import_content(params)?;
  let preview = service
    .preview_notion_import(auth.user_id, workspace_id, content.as_slice())
    .await
    .map_err(mcp_database_error)?;
  Ok(mcp_json_response(json!({ "preview": preview })))
}

pub(super) async fn notion_import(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, true)?;
  let service = &database_services(state)?.import_export;
  let workspace_id = parse_uuid(params, "workspace_id")?;
  let content = parse_mcp_import_content(params)?;
  let options = build_mcp_import_options(params, workspace_id);
  let target_workspace_id = parse_optional_uuid(params, "target_workspace_id")?.unwrap_or(workspace_id);
  check_workspace_membership(&state.workspace_service, auth.user_id, target_workspace_id).await?;
  assert_workspace_permission(state, auth.user_id, target_workspace_id, WorkspaceAction::CreateDoc).await?;
  let semantic_payload = import_idempotency_payload(params, &content);
  let guard = match begin_optional_mcp_idempotency_with_payload(
    "database_notion_import",
    params,
    Some(&semantic_payload),
    auth,
    state,
  )
  .await?
  {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = service
    .import_notion(auth.user_id, workspace_id, content.as_slice(), options)
    .await
    .map(|result| mcp_json_response(json!({ "result": result })))
    .map_err(mcp_database_error);
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn row_create(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, true)?;
  crate::idempotency::validate_required_key(params)?;
  let services = database_services(state)?;
  let database_id = parse_uuid(params, "database_id")?;
  preflight_database_write(state, &services.definition, auth.user_id, database_id).await?;
  let guard = match begin_mcp_idempotency("database_row_create", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = async {
    let title = parse_optional_string(params, "title")?;
    let initial_cells = parse_mcp_initial_cells(params)?;
    let row = services
      .editing
      .create_row(auth.user_id, database_id, title, initial_cells)
      .await
      .map_err(mcp_database_error)?;
    Ok(mcp_json_response(json!({ "row": row })))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn cell_update(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, true)?;
  crate::idempotency::validate_required_key(params)?;
  let services = database_services(state)?;
  let database_id = parse_uuid(params, "database_id")?;
  preflight_database_write(state, &services.definition, auth.user_id, database_id).await?;
  let guard = match begin_mcp_idempotency("database_cell_update", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = async {
    let row_id = parse_uuid(params, "row_id")?;
    let field_id = parse_uuid(params, "field_id")?;
    let value = parse_mcp_cell_value(params.get("value"))?;
    let cell = services
      .editing
      .update_cell_value(auth.user_id, database_id, row_id, field_id, value)
      .await
      .map_err(mcp_database_error)?;
    Ok(mcp_json_response(json!({ "cell": cell })))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn row_from_template(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  require_mcp_database_scope(auth, true)?;
  crate::idempotency::validate_required_key(params)?;
  let services = database_services(state)?;
  let database_id = parse_uuid(params, "database_id")?;
  preflight_database_write(state, &services.definition, auth.user_id, database_id).await?;
  let registry = state.template_registry.as_ref().ok_or_else(|| {
    (
      -32002,
      "Template Registry is not enabled on this MCP server".to_string(),
    )
  })?;
  let guard = match begin_mcp_idempotency("database_row_from_template", params, auth, state).await? {
    Ok(guard) => guard,
    Err(response) => return Ok(response),
  };
  let result = async {
    let request = DatabaseRowTemplateApplyRequest {
      database_id,
      row_template_id: parse_uuid(params, "row_template_id")?,
      title: parse_optional_string(params, "title")?,
      body_inputs: params
        .get("body_inputs")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| (-32602, "body_inputs must map input names to text values".to_string()))?
        .unwrap_or_default(),
      source_revision: parse_optional_string(params, "source_revision")?,
      override_cell_values: parse_mcp_cell_value_map(params.get("override_cell_values"))?,
    };
    let row = services
      .editing
      .create_row_from_template(
        auth.user_id,
        request,
        registry,
        state.document_template_service.as_deref(),
      )
      .await
      .map_err(mcp_database_error)?;
    Ok(mcp_json_response(json!({ "row": row })))
  }
  .await;
  finish_or_abort_mcp_write(guard, state, auth, result).await
}

pub(super) async fn row_templates_list(
  params: &Value,
  auth: &McpAuthContext,
  state: &McpToolState,
) -> Result<Value, (i32, String)> {
  super::require_mcp_scope(auth, "read:templates")?;
  let service = &database_services(state)?.editing;
  let registry = state.template_registry.as_ref().ok_or_else(|| {
    (
      -32002,
      "Template Registry is not enabled on this MCP server".to_string(),
    )
  })?;
  let database_id = parse_uuid(params, "database_id")?;
  let bindings = service
    .list_row_template_bindings(auth.user_id, database_id, registry)
    .await
    .map_err(mcp_database_error)?;
  Ok(mcp_json_response(
    json!({ "databaseId": database_id, "bindings": bindings }),
  ))
}

fn parse_row_cursor(params: &Value) -> Result<Option<DatabaseRowCursor>, (i32, String)> {
  let Some(raw) = parse_optional_string(params, "cursor")? else {
    return Ok(None);
  };
  DatabaseRowCursor::decode(&raw)
    .map(Some)
    .ok_or_else(|| (-32602, "cursor must be a valid opaque Database row cursor".to_string()))
}

fn parse_row_patches(params: &Value) -> Result<Vec<DatabaseBulkCellUpdate>, (i32, String)> {
  let patches = params
    .get("patches")
    .and_then(Value::as_array)
    .ok_or_else(|| (-32602, "patches must be an array".to_string()))?;
  if patches.is_empty() || patches.len() > MAX_ROW_PATCHES {
    return Err((
      -32602,
      format!("patches must contain between 1 and {MAX_ROW_PATCHES} entries"),
    ));
  }
  patches
    .iter()
    .map(|patch| {
      Ok(DatabaseBulkCellUpdate {
        field_id: parse_uuid(patch, "field_id")?,
        intent: DatabaseBulkCellIntent::Set(parse_mcp_cell_value(patch.get("value"))?),
      })
    })
    .collect()
}

fn ensure_bulk_success(result: DatabaseBulkOperationResult) -> Result<DatabaseBulkOperationResult, (i32, String)> {
  if let Some(failure) = result.failed.first() {
    let code = failure.error_code.as_deref().unwrap_or("MIX_DATABASE_BULK_FAILED");
    let message = failure
      .error_message
      .as_deref()
      .unwrap_or("database row operation failed");
    let tool_code = if code.contains("NOT_FOUND") { -32004 } else { -32002 };
    return Err((tool_code, format!("{code}: {message}")));
  }
  Ok(result)
}

fn import_idempotency_payload(params: &Value, content: &[u8]) -> Value {
  let mut payload = params.clone();
  if let Some(object) = payload.as_object_mut() {
    object.remove("idempotency_key");
    object.remove("content_base64");
    object.remove("content_text");
    object.insert("content_sha256".to_string(), Value::String(sha256_hex(content)));
  }
  payload
}

#[cfg(test)]
mod schema_admission_tests {
  use super::*;
  use crate::idempotency::{BeginOutcome, Requirement, begin};

  #[tokio::test]
  async fn schema_readback_not_found_cannot_readmit_a_possible_committed_write() {
    let repository: std::sync::Arc<dyn myoxus_application::mcp::McpIdempotencyRepository> =
      std::sync::Arc::new(myoxus_application::mcp::InMemoryMcpIdempotencyRepository::default());
    let auth = McpAuthContext {
      user_id: uuid::Uuid::new_v4(),
      key_id: uuid::Uuid::new_v4(),
      scopes: vec!["write:databases".into()],
    };
    for (key, code, retry_allowed) in [
      ("readback", -32004, false),
      ("decoding", -32602, false),
      ("conflict", -32010, true),
    ] {
      let params = json!({"idempotency_key":key});
      let BeginOutcome::Execute(guard) = begin(
        Requirement::Required,
        "database_update",
        &params,
        None,
        &auth,
        &repository,
      )
      .await
      .unwrap() else {
        panic!("new schema admission must execute");
      };
      finish_schema_write(guard, &repository, Err((code, "schema outcome".into())))
        .await
        .expect_err("failed outcome");
      let retry = begin(
        Requirement::Required,
        "database_update",
        &params,
        None,
        &auth,
        &repository,
      )
      .await;
      if retry_allowed {
        assert!(
          matches!(retry, Ok(BeginOutcome::Execute(_))),
          "rolled-back revision conflict may retry"
        );
      } else {
        let error = match retry {
          Err(error) => error,
          _ => panic!("possible committed effect must remain fenced"),
        };
        assert!(error.1.starts_with("MIX_MCP_IDEMPOTENCY_RECOVERY_REQUIRED_UNCERTAIN"));
      }
    }
  }
}
