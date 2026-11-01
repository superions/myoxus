// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only native Project facts. These proposals never create Rows or members.
use super::validation::{invalid, key};
use crate::database::{DatabaseResult, DatabaseServiceError};
use crate::workspace::WorkspaceStore;
use myoxus_domain::assistant_package::*;
use myoxus_domain::database::{DatabaseDateValue, DatabaseProjectStructurePreset};
use myoxus_domain::ids::{UserId, WorkspaceId};
use myoxus_domain::repositories::RepositoryError;
use std::collections::BTreeSet;

/// Before allocation there are no target memberships or existing Organizer IDs.
pub(super) fn validate_new_workspace_context(
  creator: UserId,
  people: &[UserId],
  folder: Option<&AssistantFolderDestination>,
) -> DatabaseResult<()> {
  if people.iter().any(|id| *id != creator) {
    return Err(invalid("new Workspace Project people may contain only its creator"));
  }
  if let Some(folder) = folder {
    match folder {
      AssistantFolderDestination::New { name, parent: None } => {
        crate::organizer::validate_project_folder_name(name)
          .map_err(|_| invalid("invalid reviewed new folder name"))?;
      }
      _ => return Err(invalid("new Workspace setup requires a new root folder")),
    }
  }
  Ok(())
}

pub(super) fn validate_endpoint(value: &DatabaseDateValue) -> Result<(), String> {
  // Setup endpoints are point dates. Ordinary native Date Cells still support
  // ranges; this semantic input does not silently discard a supplied range.
  if value.end.is_some() {
    return Err("Project start/end inputs require native point dates".into());
  }
  Ok(())
}

pub(super) fn validate_scaffold(scaffold: &[AssistantProjectScaffold]) -> Result<(), String> {
  if scaffold.len() > 64 {
    return Err("Project scaffold exceeds native preparation bound".into());
  }
  let mut ids = BTreeSet::new();
  for entry in scaffold {
    if !key(&entry.id) || !ids.insert(&entry.id) {
      return Err("Project scaffold keys must be valid and unique".into());
    }
    if [&entry.title.en, &entry.title.de, &entry.title.fr, &entry.title.es]
      .iter()
      .any(|title| title.trim().is_empty() || title.len() > 8192)
    {
      return Err("Project scaffold requires bounded localized titles".into());
    }
  }
  Ok(())
}

pub(super) fn prepare_setup(
  bound: impl Fn(AssistantInputTarget) -> Option<AssistantValue>,
  authored: &[AssistantProjectScaffold],
  structure: DatabaseProjectStructurePreset,
  sample_rows: usize,
) -> DatabaseResult<(AssistantProjectSetupFacts, AssistantProjectSetupCounts)> {
  let text = |target| match bound(target) {
    Some(AssistantValue::Text(value)) => {
      let value = value.trim().to_string();
      (!value.is_empty()).then_some(value)
    }
    _ => None,
  };
  let date = |target| -> DatabaseResult<_> {
    match bound(target) {
      Some(AssistantValue::Date(value)) => {
        validate_endpoint(&value).map_err(invalid)?;
        Ok(Some(value))
      }
      None => Ok(None),
      _ => Err(invalid("invalid native Project date")),
    }
  };
  let start_date = date(AssistantInputTarget::StartDate)?;
  let end_date = date(AssistantInputTarget::EndDate)?;
  if let (Some(start), Some(end)) = (&start_date, &end_date) {
    if end.start < start.start {
      return Err(invalid("Project end date cannot precede start date"));
    }
  }
  let people = match bound(AssistantInputTarget::People) {
    Some(AssistantValue::Members(ids)) => {
      if ids.len() > 128 || ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
        return Err(invalid("Project people must be bounded distinct accepted members"));
      }
      ids
    }
    None => Vec::new(),
    _ => return Err(invalid("invalid Project people")),
  };
  let include = match bound(AssistantInputTarget::IncludeScaffold) {
    Some(AssistantValue::Boolean(value)) => value,
    None => false,
    _ => return Err(invalid("invalid Project scaffold choice")),
  };
  let scaffold = authored
    .iter()
    .filter(|entry| {
      include
        && match entry.kind {
          AssistantProjectScaffoldKind::Phase => structure.has_phases(),
          AssistantProjectScaffoldKind::Milestone => structure.has_milestones(),
        }
    })
    .cloned()
    .collect::<Vec<_>>();
  let counts = AssistantProjectSetupCounts {
    phases: scaffold
      .iter()
      .filter(|entry| entry.kind == AssistantProjectScaffoldKind::Phase)
      .count(),
    milestones: scaffold
      .iter()
      .filter(|entry| entry.kind == AssistantProjectScaffoldKind::Milestone)
      .count(),
    sample_rows,
    explicit_tasks: 0,
  };
  Ok((
    AssistantProjectSetupFacts {
      goal: text(AssistantInputTarget::Goal),
      scope: text(AssistantInputTarget::Scope),
      start_date,
      end_date,
      people,
      scaffold,
    },
    counts,
  ))
}

pub(super) async fn validate_people(
  store: &dyn WorkspaceStore,
  workspace: WorkspaceId,
  setup: &AssistantProjectSetupFacts,
) -> DatabaseResult<()> {
  for user in &setup.people {
    if !store
      .has_accepted_member(workspace, *user)
      .await
      .map_err(|error| DatabaseServiceError::from(RepositoryError::Storage(error.to_string())))?
    {
      return Err(invalid("Project people must reference accepted workspace members"));
    }
  }
  Ok(())
}

pub(super) fn execution_available(setup: &AssistantProjectSetupFacts) -> bool {
  setup.goal.is_none()
    && setup.scope.is_none()
    && setup.start_date.is_none()
    && setup.end_date.is_none()
    && setup.people.is_empty()
    && setup.scaffold.is_empty()
}

pub(super) fn validate_locale(locale: &str) -> DatabaseResult<()> {
  if !matches!(locale, "en" | "de" | "fr" | "es") {
    return Err(invalid("unsupported reviewed Project locale"));
  }
  Ok(())
}

pub(super) fn localized<'a>(value: &'a AssistantLocalizedText, locale: &str) -> &'a str {
  match locale {
    "de" => &value.de,
    "fr" => &value.fr,
    "es" => &value.es,
    _ => &value.en,
  }
}

pub(super) async fn compose_description(
  store: &dyn WorkspaceStore,
  workspace: WorkspaceId,
  source: &AssistantPackageSource,
  setup: &AssistantProjectSetupFacts,
  description: Option<String>,
  locale: &str,
) -> DatabaseResult<Option<String>> {
  let members = if setup.people.is_empty() {
    Vec::new()
  } else {
    store
      .accepted_members_for_lookup(workspace)
      .await
      .map_err(|error| DatabaseServiceError::from(RepositoryError::Storage(error.to_string())))?
  };
  let people = setup
    .people
    .iter()
    .map(|id| {
      members
        .iter()
        .find(|member| member.user_id == *id)
        .filter(|member| !member.display_name.trim().is_empty())
        .map(|member| member.display_name.clone())
        .ok_or_else(|| invalid("selected Project member is unavailable"))
    })
    .collect::<DatabaseResult<Vec<_>>>()?;
  Ok(compose_description_with_people(
    source,
    setup,
    description,
    locale,
    &people,
  ))
}

pub(super) fn compose_description_with_people(
  source: &AssistantPackageSource,
  setup: &AssistantProjectSetupFacts,
  description: Option<String>,
  locale: &str,
  people: &[String],
) -> Option<String> {
  let mut sections = description.into_iter().collect::<Vec<_>>();
  for input in &source.inputs {
    let value = match input.target {
      AssistantInputTarget::Goal => setup.goal.clone(),
      AssistantInputTarget::Scope => setup.scope.clone(),
      AssistantInputTarget::StartDate => setup.start_date.as_ref().map(|value| value.start.to_string()),
      AssistantInputTarget::EndDate => setup.end_date.as_ref().map(|value| value.start.to_string()),
      AssistantInputTarget::People => (!people.is_empty()).then(|| people.join(", ")),
      _ => None,
    };
    if let Some(value) = value {
      sections.push(format!("{}\n{}", localized(&input.label, locale), value));
    }
  }
  (!sections.is_empty()).then(|| sections.join("\n\n"))
}
