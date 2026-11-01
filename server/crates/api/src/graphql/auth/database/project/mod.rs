// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "ProjectOptionPreset", rename_items = "PascalCase")]
pub enum ProjectOptionPresetType {
  ThreeStep,
  FiveStep,
}

impl From<ProjectOptionPresetType> for DatabaseProjectOptionPreset {
  fn from(value: ProjectOptionPresetType) -> Self {
    match value {
      ProjectOptionPresetType::ThreeStep => Self::ThreeStep,
      ProjectOptionPresetType::FiveStep => Self::FiveStep,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "ProjectStructurePreset", rename_items = "PascalCase")]
pub enum ProjectStructurePresetType {
  TasksOnly,
  Phases,
  Milestones,
  PhasesAndMilestones,
}

impl From<ProjectStructurePresetType> for DatabaseProjectStructurePreset {
  fn from(value: ProjectStructurePresetType) -> Self {
    match value {
      ProjectStructurePresetType::TasksOnly => Self::TasksOnly,
      ProjectStructurePresetType::Phases => Self::Phases,
      ProjectStructurePresetType::Milestones => Self::Milestones,
      ProjectStructurePresetType::PhasesAndMilestones => Self::PhasesAndMilestones,
    }
  }
}

#[derive(InputObject)]
pub struct CreateProjectInput {
  pub workspace_id: ID,
  pub title: String,
  pub description: Option<String>,
  pub priority_preset: Option<ProjectOptionPresetType>,
  pub complexity_preset: Option<ProjectOptionPresetType>,
  pub structure_preset: Option<ProjectStructurePresetType>,
}

pub(crate) async fn create_project(ctx: &Context<'_>, input: CreateProjectInput) -> Result<DatabaseRecordObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let workspace_id = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let default_currency = state.config.i18n.default_currency.clone();
  let services = service(&state)?;
  services
    .definition
    .validate_database_creation(snapshot.user.id, workspace_id, &input.title)
    .await
    .map_err(map_database_error)?;
  let defaults = services
    .definition
    .starter_template_catalog()
    .system_source(domain::DatabaseTemplateSourceRole::ProjectDefault)
    .ok_or_else(|| {
      Error::new("default Project source unavailable")
        .extend_with(|_, e| e.set("code", myoxus_application::database::ERR_TEMPLATE_INVALID))
    })?
    .selection;
  let record = service(&state)?
    .definition
    .create_project(
      snapshot.user.id,
      CreateDatabaseProject {
        workspace_id,
        title: input.title,
        description: input.description,
        priority_preset: input.priority_preset.map(Into::into).unwrap_or(defaults.priority),
        complexity_preset: input.complexity_preset.map(Into::into).unwrap_or(defaults.complexity),
        structure_preset: input.structure_preset.map(Into::into).unwrap_or(defaults.structure),
        default_currency,
      },
    )
    .await
    .map_err(map_database_error)?;
  Ok(map_record(record))
}
