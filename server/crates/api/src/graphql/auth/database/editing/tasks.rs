// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

fn invalid_move_input(message: &str) -> Error {
  Error::new(message).extend_with(|_, extensions| {
    extensions.set("code", myoxus_application::database::ERR_QUERY_INVALID);
  })
}

#[derive(InputObject)]
pub struct DatabaseTaskMoveCellRevisionInput {
  pub field_id: ID,
  pub expected_edit_revision: i64,
}

#[derive(InputObject)]
pub struct DatabaseTaskMoveSelectionInput {
  pub row_id: ID,
  pub expected_edit_revision: i64,
  pub cell_revisions: Vec<DatabaseTaskMoveCellRevisionInput>,
}

#[derive(InputObject)]
pub struct DatabaseTaskMoveInput {
  pub workspace_id: ID,
  pub source_database_id: ID,
  pub target_database_id: ID,
  pub source_edit_revision: i64,
  pub target_edit_revision: i64,
  pub source_schema_revision: i64,
  pub target_schema_revision: i64,
  pub selection: Vec<DatabaseTaskMoveSelectionInput>,
  pub phase_row_id: Option<ID>,
  pub milestone_row_id: Option<ID>,
}

impl TryFrom<DatabaseTaskMoveInput> for domain::DatabaseTaskMoveInput {
  type Error = Error;
  fn try_from(value: DatabaseTaskMoveInput) -> Result<Self> {
    let selection = value
      .selection
      .into_iter()
      .map(|row| {
        let mut cell_revisions = BTreeMap::new();
        for cell in row.cell_revisions {
          if cell_revisions
            .insert(parse_uuid_id(&cell.field_id, "fieldId")?, cell.expected_edit_revision)
            .is_some()
          {
            return Err(invalid_move_input("duplicate Task move Cell revision"));
          }
        }
        Ok(domain::DatabaseTaskMoveSelection {
          row_id: parse_uuid_id(&row.row_id, "rowId")?,
          expected_edit_revision: row.expected_edit_revision,
          cell_revisions,
        })
      })
      .collect::<Result<_>>()?;
    Ok(Self {
      workspace_id: parse_uuid_id(&value.workspace_id, "workspaceId")?,
      source_database_id: parse_uuid_id(&value.source_database_id, "sourceDatabaseId")?,
      target_database_id: parse_uuid_id(&value.target_database_id, "targetDatabaseId")?,
      source_edit_revision: value.source_edit_revision,
      target_edit_revision: value.target_edit_revision,
      source_schema_revision: value.source_schema_revision,
      target_schema_revision: value.target_schema_revision,
      selection,
      phase_row_id: value
        .phase_row_id
        .as_ref()
        .map(|id| parse_uuid_id(id, "phaseRowId"))
        .transpose()?,
      milestone_row_id: value
        .milestone_row_id
        .as_ref()
        .map(|id| parse_uuid_id(id, "milestoneRowId"))
        .transpose()?,
    })
  }
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskMoveCellRevision")]
pub struct DatabaseTaskMoveCellRevisionObjectType {
  pub field_id: ID,
  pub expected_edit_revision: i64,
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskMoveSelection")]
pub struct DatabaseTaskMoveSelectionObjectType {
  pub row_id: ID,
  pub expected_edit_revision: i64,
  pub cell_revisions: Vec<DatabaseTaskMoveCellRevisionObjectType>,
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskMovePlan")]
pub struct DatabaseTaskMovePlanObjectType {
  pub workspace_id: ID,
  pub source_database_id: ID,
  pub target_database_id: ID,
  pub source_edit_revision: i64,
  pub target_edit_revision: i64,
  pub source_schema_revision: i64,
  pub target_schema_revision: i64,
  pub selection: Vec<DatabaseTaskMoveSelectionObjectType>,
  pub phase_row_id: Option<ID>,
  pub milestone_row_id: Option<ID>,
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskMoveBoundary")]
pub struct DatabaseTaskMoveBoundaryObjectType {
  pub row_id: ID,
  pub field_id: ID,
  pub related_row_id: ID,
  pub inbound: bool,
  pub recoverable_trash: bool,
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskMovePreview")]
pub struct DatabaseTaskMovePreviewObjectType {
  pub input: DatabaseTaskMovePlanObjectType,
  pub eligible: bool,
  pub reasons: Vec<String>,
  pub required_related_tasks: Vec<ID>,
  pub boundaries: Vec<DatabaseTaskMoveBoundaryObjectType>,
  pub allocates_display_ids: bool,
}

fn map_move_preview(value: domain::DatabaseTaskMovePreview) -> DatabaseTaskMovePreviewObjectType {
  let input = value.input;
  DatabaseTaskMovePreviewObjectType {
    input: DatabaseTaskMovePlanObjectType {
      workspace_id: input.workspace_id.to_string().into(),
      source_database_id: input.source_database_id.to_string().into(),
      target_database_id: input.target_database_id.to_string().into(),
      source_edit_revision: input.source_edit_revision,
      target_edit_revision: input.target_edit_revision,
      source_schema_revision: input.source_schema_revision,
      target_schema_revision: input.target_schema_revision,
      selection: input
        .selection
        .into_iter()
        .map(|row| DatabaseTaskMoveSelectionObjectType {
          row_id: row.row_id.to_string().into(),
          expected_edit_revision: row.expected_edit_revision,
          cell_revisions: row
            .cell_revisions
            .into_iter()
            .map(|(field_id, revision)| DatabaseTaskMoveCellRevisionObjectType {
              field_id: field_id.to_string().into(),
              expected_edit_revision: revision,
            })
            .collect(),
        })
        .collect(),
      phase_row_id: input.phase_row_id.map(|id| id.to_string().into()),
      milestone_row_id: input.milestone_row_id.map(|id| id.to_string().into()),
    },
    eligible: value.eligible,
    reasons: value.reasons,
    required_related_tasks: value
      .required_related_tasks
      .into_iter()
      .map(|id| id.to_string().into())
      .collect(),
    boundaries: value
      .boundaries
      .into_iter()
      .map(|boundary| DatabaseTaskMoveBoundaryObjectType {
        row_id: boundary.row_id.to_string().into(),
        field_id: boundary.field_id.to_string().into(),
        related_row_id: boundary.related_row_id.to_string().into(),
        inbound: boundary.inbound,
        recoverable_trash: boundary.recoverable_trash,
      })
      .collect(),
    allocates_display_ids: value.allocates_display_ids,
  }
}

pub(crate) async fn prepare_database_task_move(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  input: DatabaseTaskMoveInput,
) -> Result<DatabaseTaskMovePreviewObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let input: domain::DatabaseTaskMoveInput = input.try_into()?;
  if input.workspace_id != workspace_id {
    return Err(invalid_move_input(
      "Task move workspace does not match the selected workspace",
    ));
  }
  service(&state)?
    .editing
    .prepare_task_move(snapshot.user.id, input)
    .await
    .map(map_move_preview)
    .map_err(map_database_error)
}

#[derive(SimpleObject)]
#[graphql(name = "DatabaseTaskMoveResult")]
pub struct DatabaseTaskMoveResultObjectType {
  pub source_database_id: ID,
  pub target_database_id: ID,
  pub rows: Vec<DatabaseRowRecordObjectType>,
}

pub(crate) async fn move_database_tasks(
  ctx: &Context<'_>,
  input: DatabaseTaskMoveInput,
) -> Result<DatabaseTaskMoveResultObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let services = service(&state)?;
  let input: domain::DatabaseTaskMoveInput = input.try_into()?;
  let workspace_id = input.workspace_id;
  let result = services
    .editing
    .move_tasks(snapshot.user.id, input)
    .await
    .map_err(map_database_error)?;
  let mut rows = Vec::with_capacity(result.rows.len());
  for record in result.rows {
    rows.push(
      map_row_record_for_read(
        &services.editing,
        &services.views,
        snapshot.user.id,
        workspace_id,
        record,
      )
      .await?,
    );
  }
  Ok(DatabaseTaskMoveResultObjectType {
    source_database_id: result.source_database_id.to_string().into(),
    target_database_id: result.target_database_id.to_string().into(),
    rows,
  })
}
