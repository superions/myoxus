// SPDX-License-Identifier: AGPL-3.0-or-later

//! Native package, reference, control and reachability admission. This does not
//! select active offerings or require defaults for retained inventory fragments.
use crate::database::{DatabaseServiceError, DatabaseStarterTemplateCatalog};
use crate::workspace::WorkspaceInitialContent;
use myoxus_domain::assistant_package::*;
use myoxus_domain::database::*;
use myoxus_domain::repositories::RepositoryError;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn invalid(message: impl Into<String>) -> DatabaseServiceError {
  let mut error = DatabaseServiceError::from(RepositoryError::Validation(message.into()));
  error.code = "MIX_ASSISTANT_PACKAGE_INVALID";
  error
}
pub(super) fn key(value: &str) -> bool {
  !value.is_empty()
    && value.len() <= 128
    && value
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}
fn text(value: &AssistantLocalizedText) -> bool {
  [&value.en, &value.de, &value.fr, &value.es]
    .iter()
    .all(|value| !value.trim().is_empty() && value.len() <= 8192)
}
fn value_matches(kind: AssistantValueType, value: &AssistantValue) -> bool {
  matches!(
    (kind, value),
    (AssistantValueType::TaskReferences, AssistantValue::TaskReferences(_))
      | (AssistantValueType::Document, AssistantValue::Document(_))
      | (AssistantValueType::Text, AssistantValue::Text(_))
      | (AssistantValueType::Boolean, AssistantValue::Boolean(_))
      | (AssistantValueType::Choice, AssistantValue::Choice(_))
      | (AssistantValueType::Choices, AssistantValue::Choices(_))
      | (AssistantValueType::Date, AssistantValue::Date(_))
      | (AssistantValueType::DateTime, AssistantValue::DateTime(_))
      | (AssistantValueType::Members, AssistantValue::Members(_))
      | (
        AssistantValueType::DatabaseDestination,
        AssistantValue::DatabaseDestination(_)
      )
      | (AssistantValueType::RowTemplate, AssistantValue::RowTemplate(_))
      | (AssistantValueType::RowSelection, AssistantValue::RowSelection(_))
      | (AssistantValueType::Row, AssistantValue::Row(_))
      | (AssistantValueType::Folder, AssistantValue::Folder(_))
  )
}
pub(super) fn validate_value(input: &AssistantInput, value: &AssistantValue) -> Result<(), String> {
  if !value_matches(input.value_type, value) {
    return Err(format!("input {} has an incompatible value", input.id));
  }
  match value {
    AssistantValue::Text(value) if value.len() > 65536 => return Err("input text exceeds native bound".into()),
    AssistantValue::Choice(id) if !input.choices.iter().any(|choice| choice.id == *id) => {
      return Err(format!("input {} choice is unavailable", input.id));
    }
    AssistantValue::Choices(ids)
      if ids.len() > 128
        || ids
          .iter()
          .any(|id| !input.choices.iter().any(|choice| choice.id == *id)) =>
    {
      return Err("input choices are unavailable".into());
    }
    AssistantValue::Members(ids) if ids.len() > 128 => return Err("member input exceeds bound".into()),
    AssistantValue::RowSelection(rows) if rows.is_empty() || rows.len() > 100 => {
      return Err("Task selection exceeds native bound".into());
    }
    _ => {}
  }
  Ok(())
}
// Admission validates semantic native parameters, rather than merely their
// presentation widgets. A listed package must never defer an unsupported enum
// or View key until the user has completed its form.
fn validate_target(input: &AssistantInput) -> Result<(), String> {
  use AssistantInputTarget as T;
  use AssistantValueType as V;
  let expected = match input.target {
    T::PrerequisiteTasks | T::Tasks => V::TaskReferences,
    T::SourceDocument => V::Document,
    T::WorkspaceName | T::Title | T::Description | T::Goal | T::Scope | T::DefaultCurrency | T::TaskSearch => V::Text,
    T::InitialContent
    | T::AssistanceMode
    | T::ProjectTemplate
    | T::PriorityPreset
    | T::ComplexityPreset
    | T::StructurePreset
    | T::InitialView
    | T::TaskScope
    | T::TaskLifecycle
    | T::TaskDuePreset
    | T::TaskStatusGroup => V::Choice,
    T::IncludeSamples | T::IncludeScaffold | T::IncludeComponent | T::CopyDescription | T::TaskBlockedOnly => {
      V::Boolean
    }
    T::Folder => V::Folder,
    T::Destination => V::DatabaseDestination,
    T::Assignees | T::TaskAssignee | T::People | T::Reviewer => V::Members,
    T::StartDate | T::EndDate => V::Date,
    T::Due | T::Deadline => V::DateTime,
    T::RowTemplate => V::RowTemplate,
    T::Parent | T::Phase | T::Milestone => V::Row,
    T::MoveSelection => V::RowSelection,
  };
  if input.value_type != expected {
    return Err("native semantic input type mismatch".into());
  }
  for choice in &input.choices {
    let (AssistantValue::Text(value) | AssistantValue::Choice(value)) = &choice.value else {
      return Err("native finite choice requires a scalar value".into());
    };
    let valid = match input.target {
      T::InitialContent => {
        serde_json::from_value::<WorkspaceInitialContent>(serde_json::Value::String(value.clone())).is_ok()
      }
      T::AssistanceMode => {
        serde_json::from_value::<crate::auth::AssistanceMode>(serde_json::Value::String(value.clone())).is_ok()
      }
      T::PriorityPreset | T::ComplexityPreset => matches!(value.as_str(), "threeStep" | "fiveStep"),
      T::StructurePreset => value.parse::<DatabaseProjectStructurePreset>().is_ok(),
      T::TaskScope => serde_json::from_value::<DatabaseTaskScope>(serde_json::Value::String(value.clone())).is_ok(),
      T::TaskLifecycle => {
        serde_json::from_value::<DatabaseTaskLifecycle>(serde_json::Value::String(value.clone())).is_ok()
      }
      T::TaskDuePreset => {
        serde_json::from_value::<DatabaseTaskDuePreset>(serde_json::Value::String(value.clone())).is_ok()
      }
      T::TaskStatusGroup => {
        serde_json::from_value::<DatabaseStatusGroup>(serde_json::Value::String(value.clone())).is_ok()
      }
      _ => true,
    };
    if !valid {
      return Err("unsupported native finite parameter".into());
    }
  }
  if matches!(input.target, T::StartDate | T::EndDate) {
    if let Some(AssistantValue::Date(value)) = &input.default {
      super::project_setup::validate_endpoint(value)?;
    }
  }
  if input.target == T::People && matches!(&input.default, Some(AssistantValue::Members(ids)) if !ids.is_empty()) {
    return Err("Project people require explicit accepted-member selection".into());
  }
  if input.target == T::Due {
    if let Some(AssistantValue::DateTime(value)) = &input.default {
      let zone = value
        .time_zone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| "invalid native Due default timezone")?;
      if value.end.is_some() {
        return Err("native Due input cannot represent a range default".into());
      }
      if value.all_day && value.start.with_timezone(&zone).time() != chrono::NaiveTime::MIN {
        return Err("native all-day Due default must be local midnight".into());
      }
    }
  }
  if input.target == T::DefaultCurrency {
    if let Some(AssistantValue::Text(value)) = &input.default {
      if normalize_database_currency_code(value).is_none() {
        return Err("invalid native default currency".into());
      }
    }
  }
  Ok(())
}
fn project_parameter_values(
  source: &AssistantPackageSource,
  target: AssistantInputTarget,
  fallback: String,
) -> Vec<String> {
  source
    .inputs
    .iter()
    .find(|input| input.target == target)
    .map(|input| {
      input
        .choices
        .iter()
        .filter_map(|choice| match &choice.value {
          AssistantValue::Text(value) | AssistantValue::Choice(value) => Some(value.clone()),
          _ => None,
        })
        .collect()
    })
    .unwrap_or_else(|| vec![fallback])
}
fn visibility(rule: &Option<AssistantVisibility>, previous: &[AssistantInput]) -> Result<(), String> {
  if let Some(rule) = rule {
    let id = match rule {
      AssistantVisibility::Present { input } | AssistantVisibility::Equals { input, .. } => input,
    };
    let input = previous
      .iter()
      .find(|input| input.id == *id)
      .ok_or("visibility must reference a preceding input")?;
    if let AssistantVisibility::Equals { value, .. } = rule {
      validate_value(input, value)?;
    }
  }
  Ok(())
}
fn binding_key(binding: &AssistantFieldBinding) -> String {
  match binding {
    AssistantFieldBinding::Field { field_key } => field_key.clone(),
    AssistantFieldBinding::Role { role_key } => DATABASE_PROJECT_SEMANTIC_CATALOG
      .iter()
      .find(|role| role.role_key == role_key && role.row_kind_scope == DatabaseRowKind::Task)
      .map(|role| role.field_key.to_string())
      .unwrap_or_else(|| role_key.clone()),
  }
}
pub(super) fn control_identity(control: &AssistantControl) -> String {
  match control {
    AssistantControl::Input { input, .. } => format!("input:{input}"),
    AssistantControl::NativeCell { binding, presence } => format!("field:{}:{presence:?}", binding_key(binding)),
    AssistantControl::TaskSummary { value } => format!("summary:{value:?}"),
    AssistantControl::TaskFilter { filter } => format!("filter:{filter:?}"),
    _ => serde_json::to_value(control).expect("typed control serializes")["kind"]
      .as_str()
      .expect("tagged control kind")
      .to_string(),
  }
}

pub(super) fn control_targets_input(control: &AssistantControl, input: &AssistantInput) -> bool {
  match control {
    AssistantControl::Input { input: id, .. } => id == &input.id,
    AssistantControl::TaskFilter { filter } => {
      input.target
        == match filter {
          AssistantTaskFilter::Scope => AssistantInputTarget::TaskScope,
          AssistantTaskFilter::Destination => AssistantInputTarget::Destination,
          AssistantTaskFilter::Assignee => AssistantInputTarget::TaskAssignee,
          AssistantTaskFilter::StatusGroup => AssistantInputTarget::TaskStatusGroup,
          AssistantTaskFilter::Lifecycle => AssistantInputTarget::TaskLifecycle,
          AssistantTaskFilter::DuePreset => AssistantInputTarget::TaskDuePreset,
          AssistantTaskFilter::Search => AssistantInputTarget::TaskSearch,
          AssistantTaskFilter::BlockedOnly => AssistantInputTarget::TaskBlockedOnly,
        }
    }
    _ => false,
  }
}
// These are native host capabilities, not package offerings or a widget
// registry. Admission cannot advertise a semantic adapter that its host ignores.
fn context_target_supported(context: AssistantPackageContext, target: AssistantInputTarget) -> bool {
  use AssistantInputTarget as T;
  use AssistantPackageContext as C;
  match context {
    C::TaskContainerAssistance => matches!(
      target,
      T::Title
        | T::Description
        | T::StartDate
        | T::People
        | T::Folder
        | T::IncludeComponent
        | T::Assignees
        | T::Tasks
        | T::PrerequisiteTasks
        | T::SourceDocument
        | T::Reviewer
        | T::Deadline
        | T::Destination
    ),
    C::WorkspaceCreation => matches!(target, T::WorkspaceName | T::InitialContent | T::AssistanceMode),
    C::ProjectCreation => matches!(
      target,
      T::Title
        | T::Description
        | T::Folder
        | T::PriorityPreset
        | T::ComplexityPreset
        | T::StructurePreset
        | T::DefaultCurrency
        | T::InitialView
        | T::IncludeSamples
        | T::Goal
        | T::Scope
        | T::StartDate
        | T::EndDate
        | T::People
        | T::IncludeScaffold
        | T::IncludeComponent
    ),
    C::TaskHome | C::TaskInventory => matches!(target, T::TaskScope | T::TaskLifecycle),
    C::TaskCreation => matches!(
      target,
      T::Destination | T::Title | T::Description | T::RowTemplate | T::Assignees | T::Due
    ),
    C::TaskCapture => matches!(target, T::Destination | T::Title | T::Description | T::CopyDescription),
    C::TaskSubtask => target == T::Title,
    C::TaskMovement => matches!(target, T::Destination | T::Phase | T::Milestone),
    C::TaskDetail => false,
  }
}
pub(crate) fn workspace_setup_source(source: &AssistantPackageSource) -> bool {
  source.contexts == [AssistantPackageContext::WorkspaceCreation]
    && matches!(source.components.first().map(|component|&component.action),Some(AssistantNativeAction::CreateWorkspace{inputs}) if inputs.is_empty())
    && source.components.len() > 1
    && source.components.iter().skip(1).all(|component| {
      matches!(
        component.action,
        AssistantNativeAction::CreateDatabaseFromDefinition { .. }
          | AssistantNativeAction::CreateWorkingDocument { .. }
          | AssistantNativeAction::PlaceNativeLink { .. }
      )
    })
}
fn workspace_setup_target(target: AssistantInputTarget) -> bool {
  matches!(
    target,
    AssistantInputTarget::Title
      | AssistantInputTarget::Description
      | AssistantInputTarget::Folder
      | AssistantInputTarget::IncludeComponent
      | AssistantInputTarget::IncludeSamples
  )
}
fn context_control_supported(
  context: AssistantPackageContext,
  control: &AssistantControl,
  source: &AssistantPackageSource,
) -> bool {
  use AssistantControl as K;
  use AssistantPackageContext as C;
  if let K::Input { input, control } = control {
    let Some(input) = source.inputs.iter().find(|candidate| candidate.id == *input) else {
      return false;
    };
    if context == C::WorkspaceCreation && workspace_setup_source(source) {
      return match input.target {
        AssistantInputTarget::Title => *control == AssistantInputControlKind::Text,
        AssistantInputTarget::Description => matches!(
          control,
          AssistantInputControlKind::Text | AssistantInputControlKind::Multiline
        ),
        AssistantInputTarget::Folder => *control == AssistantInputControlKind::Folder,
        AssistantInputTarget::IncludeComponent | AssistantInputTarget::IncludeSamples => {
          *control == AssistantInputControlKind::Toggle
        }
        _ => false,
      };
    }
    if !context_target_supported(context, input.target) {
      return false;
    }
    return if context == C::WorkspaceCreation {
      match input.target {
        AssistantInputTarget::WorkspaceName => *control == AssistantInputControlKind::Text,
        AssistantInputTarget::InitialContent | AssistantInputTarget::AssistanceMode => matches!(
          control,
          AssistantInputControlKind::Select | AssistantInputControlKind::RadioCards
        ),
        _ => false,
      }
    } else if matches!(context, C::ProjectCreation | C::TaskContainerAssistance) {
      match input.target {
        AssistantInputTarget::PrerequisiteTasks | AssistantInputTarget::Tasks => {
          return *control == AssistantInputControlKind::TaskReferences;
        }
        AssistantInputTarget::Assignees => return *control == AssistantInputControlKind::Members,
        AssistantInputTarget::SourceDocument => return *control == AssistantInputControlKind::Document,
        AssistantInputTarget::Reviewer => return *control == AssistantInputControlKind::Members,
        AssistantInputTarget::Deadline => return *control == AssistantInputControlKind::DateTime,
        AssistantInputTarget::Destination => return *control == AssistantInputControlKind::Destination,
        AssistantInputTarget::StartDate | AssistantInputTarget::EndDate => {
          return *control == AssistantInputControlKind::Date;
        }
        AssistantInputTarget::People => return *control == AssistantInputControlKind::Members,
        _ => {}
      }
      matches!(
        control,
        AssistantInputControlKind::Text
          | AssistantInputControlKind::Multiline
          | AssistantInputControlKind::Search
          | AssistantInputControlKind::Toggle
          | AssistantInputControlKind::Select
          | AssistantInputControlKind::RadioCards
          | AssistantInputControlKind::MultiSelect
          | AssistantInputControlKind::Folder
      )
    } else {
      let expected = match input.target {
        AssistantInputTarget::Title => AssistantInputControlKind::Text,
        AssistantInputTarget::Description if matches!(context, C::TaskCreation | C::TaskCapture) => {
          return matches!(
            control,
            AssistantInputControlKind::Text | AssistantInputControlKind::Multiline
          );
        }
        AssistantInputTarget::Destination => AssistantInputControlKind::Destination,
        AssistantInputTarget::RowTemplate => AssistantInputControlKind::RowTemplate,
        AssistantInputTarget::Assignees => AssistantInputControlKind::Members,
        AssistantInputTarget::Due => AssistantInputControlKind::DateTime,
        AssistantInputTarget::CopyDescription => AssistantInputControlKind::Toggle,
        AssistantInputTarget::Phase | AssistantInputTarget::Milestone => AssistantInputControlKind::Row,
        _ => return false,
      };
      *control == expected
    };
  }
  match context {
    C::TaskContainerAssistance => matches!(
      control,
      K::DocumentReview | K::TaskHandoverReview | K::TaskMaintenanceReview | K::TaskPreparationReview
    ),
    C::WorkspaceCreation => {
      matches!(control, K::WorkspaceReview)
        || (workspace_setup_source(source) && matches!(control, K::OfferingSelection { .. }))
    }
    C::ProjectCreation => matches!(control, K::OfferingSelection { .. } | K::ProjectReview),
    C::TaskHome => match control {
      K::TaskSummary { value } => matches!(
        value,
        AssistantTaskSummaryValue::Title
          | AssistantTaskSummaryValue::Destination
          | AssistantTaskSummaryValue::Status
          | AssistantTaskSummaryValue::Due
      ),
      K::TaskFilter { filter } => matches!(filter, AssistantTaskFilter::Scope | AssistantTaskFilter::Lifecycle),
      _ => false,
    },
    C::TaskInventory => matches!(control, K::TaskSummary { .. } | K::TaskFilter { .. }),
    C::TaskCreation => matches!(control, K::DestinationAudience),
    C::TaskCapture => matches!(control, K::DestinationAudience | K::SourceOrigin),
    C::TaskSubtask => false,
    C::TaskMovement => matches!(
      control,
      K::MoveSelection | K::MoveImpact | K::CurrentOwnerReadback | K::DestinationAudience
    ),
    C::TaskDetail => matches!(
      control,
      K::NativeCell { .. }
        | K::Parent
        | K::BlockedBy
        | K::Follow
        | K::Reminder { .. }
        | K::RowContent
        | K::SourceOrigin
        | K::Activity
        | K::RowLifecycle
    ),
  }
}
fn native_write_action(
  source: &AssistantPackageSource,
  context: AssistantPackageContext,
) -> Option<AssistantActionKind> {
  use AssistantActionKind as A;
  use AssistantPackageContext as C;
  Some(match context {
    C::TaskContainerAssistance => {
      match source.components.first().map(|component| &component.action) {
        Some(AssistantNativeAction::TaskMaintenance { .. }) => return Some(A::StartTaskMaintenance),
        Some(AssistantNativeAction::ConfigureTaskPreparation { .. }) => return Some(A::ConfigureTaskPreparation),
        _ => {}
      }
      if matches!(
        source.components.first().map(|component| &component.action),
        Some(AssistantNativeAction::TaskHandover { .. })
      ) {
        return Some(A::StartTaskHandover);
      }
      if matches!(
        source.components.first().map(|component| &component.action),
        Some(AssistantNativeAction::RequestDocumentReview { .. })
      ) {
        A::RequestDocumentReview
      } else {
        A::ApplyDocuments
      }
    }
    C::WorkspaceCreation => A::CreateWorkspace,
    C::ProjectCreation => A::CreateProject,
    C::TaskCreation => A::CreateTask,
    C::TaskCapture => A::CaptureTask,
    C::TaskSubtask => A::CreateSubtask,
    C::TaskMovement => A::CommitTaskMove,
    _ => return None,
  })
}

fn context_action_supported(
  source: &AssistantPackageSource,
  context: AssistantPackageContext,
  action: AssistantActionKind,
) -> bool {
  use AssistantActionKind as A;
  use AssistantPackageContext as C;
  match context {
    C::TaskContainerAssistance => match action {
      A::PrepareTaskMaintenance | A::StartTaskMaintenance => {
        native_write_action(source, context) == Some(A::StartTaskMaintenance)
      }
      A::PrepareTaskPreparation | A::ConfigureTaskPreparation => {
        native_write_action(source, context) == Some(A::ConfigureTaskPreparation)
      }
      A::PrepareDocuments | A::ApplyDocuments => native_write_action(source, context) == Some(A::ApplyDocuments),
      A::PrepareTaskHandover | A::StartTaskHandover => {
        native_write_action(source, context) == Some(A::StartTaskHandover)
      }
      A::PrepareDocumentReview | A::RequestDocumentReview => {
        native_write_action(source, context) == Some(A::RequestDocumentReview)
      }
      _ => matches!(action, A::Back | A::Next | A::Cancel | A::Close | A::Check | A::Refresh),
    },
    C::WorkspaceCreation => matches!(
      action,
      A::Back | A::Next | A::Cancel | A::Close | A::Check | A::CreateWorkspace
    ),
    C::ProjectCreation => matches!(
      action,
      A::Back | A::Next | A::Cancel | A::Close | A::Check | A::Refresh | A::CreateProject
    ),
    C::TaskHome | C::TaskInventory => matches!(action, A::CreateTask | A::Refresh),
    C::TaskCreation => matches!(
      action,
      A::Back | A::Next | A::Cancel | A::Close | A::Check | A::CreateTask
    ),
    C::TaskCapture => matches!(
      action,
      A::Back | A::Next | A::Cancel | A::Close | A::Check | A::CaptureTask
    ),
    C::TaskSubtask => matches!(
      action,
      A::Back | A::Next | A::Cancel | A::Close | A::Check | A::CreateSubtask
    ),
    C::TaskMovement => matches!(
      action,
      A::Back
        | A::Next
        | A::Cancel
        | A::Close
        | A::Check
        | A::Refresh
        | A::OpenProjectCreation
        | A::PrepareTaskMove
        | A::CommitTaskMove
    ),
    C::TaskDetail => matches!(action, A::Close | A::Refresh),
  }
}
fn project_contexts(source: &AssistantPackageSource) -> bool {
  source.contexts.contains(&AssistantPackageContext::ProjectCreation)
    && source.contexts.iter().all(|context| {
      matches!(
        context,
        AssistantPackageContext::ProjectCreation | AssistantPackageContext::WorkspaceCreation
      )
    })
}
fn native_context(source: &AssistantPackageSource, context: AssistantPackageContext) -> AssistantPackageContext {
  if context == AssistantPackageContext::WorkspaceCreation
    && matches!(
      source.components.first().map(|component| &component.action),
      Some(AssistantNativeAction::CreateProject { .. })
    )
  {
    AssistantPackageContext::ProjectCreation
  } else {
    context
  }
}

fn validate_context_capabilities(source: &AssistantPackageSource) -> Result<(), String> {
  let mut contexts = Vec::new();
  for context in &source.contexts {
    if contexts.contains(context) {
      return Err("duplicate assistant context".into());
    }
    contexts.push(*context);
    let effective_context = native_context(source, *context);
    if matches!(
      context,
      AssistantPackageContext::TaskHome | AssistantPackageContext::TaskInventory | AssistantPackageContext::TaskDetail
    ) && (source.presentation.steps.len() != 1 || !source.presentation.dialogs.is_empty())
    {
      return Err("native read surface requires one step and no dialogs".into());
    }
    if source.inputs.iter().any(|input| {
      !context_target_supported(effective_context, input.target)
        && !(workspace_setup_source(source) && workspace_setup_target(input.target))
    }) {
      return Err("native input target is unsupported in this presentation context".into());
    }
    for (groups, actions) in source
      .presentation
      .steps
      .iter()
      .map(|step| (&step.groups, &step.actions))
      .chain(
        source
          .presentation
          .dialogs
          .iter()
          .map(|dialog| (&dialog.groups, &dialog.actions)),
      )
    {
      if groups
        .iter()
        .flat_map(|group| &group.controls)
        .any(|control| !context_control_supported(effective_context, control, source))
      {
        return Err("native control is unsupported in this presentation context".into());
      }
      if matches!(
        context,
        AssistantPackageContext::TaskHome | AssistantPackageContext::TaskInventory
      ) {
        for group in groups {
          let compatible = match group.role {
            AssistantGroupRole::Filters => group
              .controls
              .iter()
              .all(|control| matches!(control, AssistantControl::TaskFilter { .. })),
            AssistantGroupRole::Inventory => group
              .controls
              .iter()
              .all(|control| matches!(control, AssistantControl::TaskSummary { .. })),
            _ => false,
          };
          if !compatible {
            return Err("native task surface group role/control mismatch".into());
          }
        }
      }
      if actions
        .iter()
        .any(|action| !context_action_supported(source, effective_context, action.action))
      {
        return Err("native action is unsupported in this presentation context".into());
      }
    }
  }
  Ok(())
}

/// The Project host prepares on entry to a review step, or explicitly before
/// opening a CreateProject confirmation dialog. Inputs cannot live beyond that
/// boundary, and modal presentation cannot edit an already reviewed plan.
fn validate_project_review_flow(source: &AssistantPackageSource) -> Result<(), String> {
  if !source.contexts.contains(&AssistantPackageContext::ProjectCreation) {
    return Ok(());
  }
  let has_review = |groups: &[AssistantGroup]| {
    groups
      .iter()
      .filter(|group| group.visible_when.is_none())
      .flat_map(|group| &group.controls)
      .any(|control| matches!(control, AssistantControl::ProjectReview))
  };
  let last_input = source
    .presentation
    .steps
    .iter()
    .enumerate()
    .filter(|(_, step)| {
      step
        .groups
        .iter()
        .flat_map(|group| &group.controls)
        .any(|control| matches!(control, AssistantControl::Input { .. }))
    })
    .map(|(index, _)| index)
    .max();
  for dialog in &source.presentation.dialogs {
    if source
      .presentation
      .steps
      .iter()
      .flat_map(|step| &step.actions)
      .any(|action| action.dialog.as_ref() == Some(&dialog.id) && action.action != AssistantActionKind::CreateProject)
    {
      return Err("Project dialogs require native CreateProject prepare openers".into());
    }
    if dialog
      .groups
      .iter()
      .flat_map(|group| &group.controls)
      .any(|control| !matches!(control, AssistantControl::ProjectReview))
    {
      return Err("Project confirmation dialogs support only readonly ProjectReview controls".into());
    }
    if dialog.actions.iter().any(|action| {
      !matches!(
        action.action,
        AssistantActionKind::CreateProject | AssistantActionKind::Cancel | AssistantActionKind::Close
      )
    }) {
      return Err("Project confirmation dialog action is unsupported".into());
    }
    let openers = source
      .presentation
      .steps
      .iter()
      .enumerate()
      .filter(|(_, step)| {
        step.actions.iter().any(|action| {
          action.action == AssistantActionKind::CreateProject && action.dialog.as_ref() == Some(&dialog.id)
        })
      })
      .collect::<Vec<_>>();
    if openers.is_empty() {
      return Err("Project confirmation dialog requires a native prepare opener".into());
    }
    for (index, step) in openers {
      if !has_review(&dialog.groups) && !has_review(&step.groups) {
        return Err("Project confirmation requires visible native review before apply".into());
      }
      if last_input.is_some_and(|last| last > index) {
        return Err("Project inputs must precede the native review boundary".into());
      }
    }
  }
  for (index, step) in source.presentation.steps.iter().enumerate() {
    if has_review(&step.groups) && (index == 0 || last_input.is_some_and(|last| last >= index)) {
      return Err("direct Project review requires a later step after all inputs".into());
    }
    for action in &step.actions {
      if action.action == AssistantActionKind::CreateProject && action.dialog.is_none() && !has_review(&step.groups) {
        return Err("direct Project apply requires its native review step".into());
      }
    }
  }
  Ok(())
}

/// Native wizard navigation permits Back/Next cycles. Admission rejects dead
/// sections and tracks unconditional paths separately for required controls.
fn presentation_reachability(source: &AssistantPackageSource) -> Result<BTreeSet<String>, String> {
  let steps = &source.presentation.steps;
  if source
    .presentation
    .dialogs
    .iter()
    .flat_map(|dialog| &dialog.actions)
    .any(|action| action.dialog.is_some())
  {
    return Err("nested native presentation dialogs are unsupported".into());
  }
  let mut reachable = BTreeSet::new();
  let mut unconditional = BTreeSet::new();
  let mut visited = BTreeSet::new();
  let mut pending = vec![(0usize, true)];
  while let Some((index, always)) = pending.pop() {
    if !visited.insert((index, always)) {
      continue;
    }
    let step = &steps[index];
    reachable.insert(step.id.clone());
    if always {
      unconditional.insert(step.id.clone());
    }
    let mut actions = Vec::new();
    for action in &step.actions {
      let action_always = always && action.visible_when.is_none();
      if let Some(id) = &action.dialog {
        let dialog = source
          .presentation
          .dialogs
          .iter()
          .find(|dialog| dialog.id == *id)
          .ok_or("presentation dialog reference unavailable")?;
        reachable.insert(dialog.id.clone());
        if action_always {
          unconditional.insert(dialog.id.clone());
        }
        for button in &dialog.actions {
          actions.push((button, action_always && button.visible_when.is_none()));
        }
      } else {
        actions.push((action, action_always));
      }
    }
    for (action, always) in actions {
      if matches!(action.action, AssistantActionKind::Next | AssistantActionKind::Back) {
        let target = if let Some(target) = &action.target_step {
          steps.iter().position(|step| step.id == *target)
        } else if action.action == AssistantActionKind::Next {
          (index + 1 < steps.len()).then_some(index + 1)
        } else {
          index.checked_sub(1)
        };
        if let Some(target) = target {
          pending.push((target, always));
        }
      }
    }
  }
  if steps
    .iter()
    .map(|step| &step.id)
    .chain(source.presentation.dialogs.iter().map(|dialog| &dialog.id))
    .any(|id| !reachable.contains(id))
  {
    return Err("unreachable native presentation section".into());
  }
  Ok(unconditional)
}
pub fn validate_assistant_package(
  source: &AssistantPackageSource,
  templates: &DatabaseStarterTemplateCatalog,
) -> Result<(), String> {
  if source.format_version != 1
    || !key(&source.id)
    || semver::Version::parse(&source.version).is_err()
    || !text(&source.name)
    || !text(&source.description)
    || source.contexts.is_empty()
    || source.contexts.len() > 16
    || source.inputs.len() > 128
    || source.components.len() > 16
    || source.presentation.steps.is_empty()
    || source.presentation.steps.len() > 32
    || source.presentation.dialogs.len() > 32
  {
    return Err("invalid or unbounded assistant package".into());
  }
  let mut ids = BTreeSet::new();
  let mut targets = Vec::new();
  for (index, input) in source.inputs.iter().enumerate() {
    if !key(&input.id)
      || !ids.insert(&input.id)
      || !text(&input.label)
      || input.description.as_ref().is_some_and(|value| !text(value))
      || (input.target != AssistantInputTarget::IncludeComponent && targets.contains(&input.target))
      || input.choices.len() > 128
    {
      return Err("invalid or duplicate assistant input".into());
    }
    targets.push(input.target);
    validate_target(input)?;
    visibility(&input.visible_when, &source.inputs[..index])?;
    let mut choices = BTreeSet::new();
    for choice in &input.choices {
      if !key(&choice.id)
        || !choices.insert(&choice.id)
        || !text(&choice.label)
        || !matches!(
          choice.value,
          AssistantValue::Text(_) | AssistantValue::Choice(_) | AssistantValue::Boolean(_)
        )
      {
        return Err("invalid assistant finite choice".into());
      }
    }
    if matches!(
      input.value_type,
      AssistantValueType::Choice | AssistantValueType::Choices
    ) && input.choices.is_empty()
    {
      return Err("choice input has no admitted choices".into());
    }
    if let Some(value) = &input.default {
      if matches!(
        value,
        AssistantValue::TaskReferences(_)
          | AssistantValue::Document(_)
          | AssistantValue::Row(_)
          | AssistantValue::RowTemplate(_)
          | AssistantValue::RowSelection(_)
          | AssistantValue::DatabaseDestination(_)
          | AssistantValue::Folder(_)
          | AssistantValue::Members(_)
      ) {
        return Err("packages cannot invent identity/member defaults".into());
      }
      validate_value(input, value)?;
    }
    if input.required && input.visible_when.is_some() {
      return Err("a required package input cannot be conditionally hidden".into());
    }
  }
  let mut components = BTreeSet::new();
  for component in &source.components {
    if !key(&component.id) || !components.insert(&component.id) {
      return Err("invalid assistant component identity".into());
    }
    match &component.action {
      AssistantNativeAction::CreateDatabaseFromDefinition { definition_id, selected, inputs } => {
        if source.contexts != [AssistantPackageContext::WorkspaceCreation] || !matches!(source.components.first().map(|component| &component.action),Some(AssistantNativeAction::CreateWorkspace { inputs }) if inputs.is_empty()) {
          return Err("Generic setup requires native Workspace composition".into());
        }
        if !matches!(selected,AssistantValueBinding::Input{input} if source.inputs.iter().any(|candidate|candidate.id==*input&&candidate.target==AssistantInputTarget::IncludeComponent&&candidate.value_type==AssistantValueType::Boolean)) {
          return Err("Generic setup requires explicit component selection".into());
        }
        let current = templates.summaries().into_iter().find(|current|current.id==*definition_id&&current.profile_kind==DatabaseProfileKind::Generic).ok_or("Generic setup source unavailable")?;
        if templates.select_version(definition_id,&current.version,current.default_variant).is_none() {return Err("Generic setup source unavailable".into())}
        if !inputs.contains_key(&AssistantInputTarget::Title) {return Err("Generic setup title is required".into())}
        for (target,binding) in inputs {
          let expected = match target {AssistantInputTarget::Title|AssistantInputTarget::Description=>AssistantValueType::Text,AssistantInputTarget::IncludeSamples=>AssistantValueType::Boolean,_=>return Err("unsupported Generic creation input".into())};
          if !matches!(binding,AssistantValueBinding::Input{input} if source.inputs.iter().any(|candidate|candidate.id==*input&&candidate.value_type==expected)) && !matches!(binding,AssistantValueBinding::LocalizedText{value} if expected==AssistantValueType::Text&&text(value)) {return Err("unsupported Generic creation binding".into())}
        }
      }
      AssistantNativeAction::PlaceNativeLink { target, folder } => {
        if source.contexts != [AssistantPackageContext::WorkspaceCreation] || !matches!(folder,AssistantValueBinding::Input{input} if source.inputs.iter().any(|candidate|candidate.id==*input&&candidate.target==AssistantInputTarget::Folder)) {
          return Err("native setup link requires an explicit folder".into());
        }
        if !matches!(target,AssistantValueBinding::Result{component:target,value} if source.components.iter().any(|child|child.id==*target&&matches!((&child.action,value),(AssistantNativeAction::CreateDatabaseFromDefinition{..},AssistantResultValue::Database)|(AssistantNativeAction::CreateWorkingDocument{..},AssistantResultValue::Document)))) {return Err("native setup link requires a matching created result".into())}
      }
      AssistantNativeAction::TaskMaintenance{inputs} => {
        if !matches!(inputs.get(&AssistantInputTarget::Tasks),Some(AssistantValueBinding::Input{input}) if source.inputs.iter().any(|value|value.id==*input&&value.target==AssistantInputTarget::Tasks&&value.value_type==AssistantValueType::TaskReferences)) || inputs.len()!=1 {
          return Err("maintenance requires its native Task input".into())
        }
      }
      AssistantNativeAction::InspectTaskContent{tasks}=>{
        if !matches!(tasks,AssistantValueBinding::Input{input} if source.inputs.iter().any(|value|value.id==*input&&value.target==AssistantInputTarget::Tasks&&value.value_type==AssistantValueType::TaskReferences)) {return Err("inspection requires native selected Tasks".into())}
      }
      AssistantNativeAction::ApplyTaskCorrections{proposal}=>{
        if !matches!(proposal,AssistantValueBinding::Result{component,value:AssistantResultValue::CorrectionProposal} if source.components.iter().any(|child|child.id==*component&&matches!(child.action,AssistantNativeAction::InspectTaskContent{..}))) {return Err("correction requires its native inspection result".into())}
      }
      AssistantNativeAction::ConfigureTaskPreparation{inputs}=>{
        if !inputs.is_empty() {return Err("personal preparation binds its finite child input mask".into())}
      }
      AssistantNativeAction::CreateLinkedDocument{inputs,variables}=>{
        if !inputs.is_empty() || variables.len()>32 || variables.iter().any(|(name,binding)| !name.starts_with("input.") || !key(&name[6..]) || !matches!(binding,AssistantValueBinding::Input{input} if source.inputs.iter().any(|value|value.id==*input&&value.value_type==AssistantValueType::Text))) {return Err("row content requires declared native string input variables".into())}
      }
      AssistantNativeAction::TaskHandover { inputs }
      | AssistantNativeAction::RequestDocumentReview { inputs }
      | AssistantNativeAction::CreateTaskFromDocument { inputs } => {
        let handover = matches!(&component.action, AssistantNativeAction::TaskHandover { .. });
        let primary = handover || matches!(&component.action, AssistantNativeAction::RequestDocumentReview { .. });
        if !source
          .contexts
          .contains(&AssistantPackageContext::TaskContainerAssistance)
          || (primary && source.components.first().is_none_or(|first| first.id != component.id))
        {
          return Err("native review requires its contextual primary action".into());
        }
        for (target, binding) in inputs {
          use AssistantInputTarget as T;
          let permitted = if handover {
            matches!(
              target,
              T::SourceDocument | T::PrerequisiteTasks | T::Assignees | T::Destination | T::Title | T::Deadline
            )
          } else if primary {
            matches!(
              target,
              T::SourceDocument | T::Reviewer | T::Destination | T::Title | T::Deadline
            )
          } else {
            matches!(
              target,
              T::SourceDocument | T::Assignees | T::Destination | T::Title | T::Description | T::Due
            )
          };
          if !permitted {
            return Err("unsupported native review Task parameter".into());
          }
          match binding {
            AssistantValueBinding::Input { input } => {
              let input = source
                .inputs
                .iter()
                .find(|candidate| candidate.id == *input)
                .ok_or("missing native review input")?;
              if input.target != *target
                && !matches!(
                  (input.target, *target),
                  (T::Reviewer, T::Assignees) | (T::Deadline, T::Due)
                )
              {
                return Err("native review input semantic mismatch".into());
              }
            }
            AssistantValueBinding::LocalizedText { value } if !primary && *target == T::Title && text(value) => {}
            AssistantValueBinding::Context {
              value: AssistantContextValue::Requester,
            } if !primary && *target == T::Assignees => {}
            AssistantValueBinding::Result {
              value: AssistantResultValue::Reason,
              ..
            } if !primary && *target == T::Description => {}
            _ => return Err("unsupported native review Task binding".into()),
          }
        }
        let required = if handover {
          vec![
            AssistantInputTarget::SourceDocument,
            AssistantInputTarget::PrerequisiteTasks,
            AssistantInputTarget::Assignees,
            AssistantInputTarget::Title,
            AssistantInputTarget::Deadline,
          ]
        } else if primary {
          vec![
            AssistantInputTarget::SourceDocument,
            AssistantInputTarget::Reviewer,
            AssistantInputTarget::Title,
            AssistantInputTarget::Deadline,
          ]
        } else {
          vec![
            AssistantInputTarget::SourceDocument,
            AssistantInputTarget::Assignees,
            AssistantInputTarget::Title,
          ]
        };
        if required.iter().any(|target| !inputs.contains_key(target)) {
          return Err("missing native review parameters".into());
        }
      }
      AssistantNativeAction::CreateDocument { selected, folder, variables }
      | AssistantNativeAction::CreateWorkingDocument { selected, folder, variables } => {
        let contextual = source.contexts == [AssistantPackageContext::TaskContainerAssistance];
        let workspace_setup = matches!(&component.action,AssistantNativeAction::CreateWorkingDocument{..}) && source.contexts == [AssistantPackageContext::WorkspaceCreation] && matches!(source.components.first().map(|component|&component.action),Some(AssistantNativeAction::CreateWorkspace{inputs}) if inputs.is_empty());
        if (!contextual && !workspace_setup
          && (!project_contexts(source)
            || !matches!(
              source.components.first().map(|component| &component.action),
              Some(AssistantNativeAction::CreateProject { .. })
            )))
          || variables.len() > 6
        {
          return Err("document components require a primary native Project".into());
        }
        let bind = |binding: &AssistantValueBinding, target| -> Result<&AssistantInput, String> {
          let AssistantValueBinding::Input { input } = binding else {
            return Err("document component requires explicit native input bindings".into());
          };
          source
            .inputs
            .iter()
            .find(|candidate| candidate.id == *input && candidate.target == target)
            .ok_or_else(|| "document component input binding mismatch".into())
        };
        bind(selected, AssistantInputTarget::IncludeComponent)?;
        bind(folder, AssistantInputTarget::Folder)?;
        if contextual && (!variables.contains_key("context.container") || !variables.contains_key("context.task")) {
          return Err("contextual document requires native container and optional Task bindings".into());
        }
        for (name, binding) in variables {
          if contextual && matches!(name.as_str(), "context.container" | "context.task") {
            let expected = if name == "context.container" {
              AssistantContextValue::Database
            } else {
              AssistantContextValue::Row
            };
            if !matches!(binding,AssistantValueBinding::Context{value} if *value==expected) {
              return Err("native document context binding mismatch".into());
            }
            continue;
          }
          let target = if contextual {
            match name.as_str() {
              "preparation.title" => AssistantInputTarget::Title,
              "preparation.date" => AssistantInputTarget::StartDate,
              "preparation.people" => AssistantInputTarget::People,
              "preparation.notes" => AssistantInputTarget::Description,
              _ => return Err("unsupported contextual document variable".into()),
            }
          } else {
            match name.as_str() {
              "project.title" => AssistantInputTarget::Title,
              "project.goal" => AssistantInputTarget::Goal,
              "project.scope" => AssistantInputTarget::Scope,
              "project.start_date" => AssistantInputTarget::StartDate,
              "project.end_date" => AssistantInputTarget::EndDate,
              "project.people" => AssistantInputTarget::People,
              _ => return Err("unsupported native Project document variable".into()),
            }
          };
          bind(binding, target)?;
        }
      }
      AssistantNativeAction::CreateWorkspace { inputs } => {
        if inputs.is_empty() && source.contexts == [AssistantPackageContext::WorkspaceCreation] && source.components.len()>1 && source.components.first().is_some_and(|first|first.id==component.id) {
          continue;
        }
        if source.components.len() != 1 || source.contexts != [AssistantPackageContext::WorkspaceCreation] {
          return Err("native Workspace allocation requires one WorkspaceCreation component".into());
        }
        for target in [
          AssistantInputTarget::WorkspaceName,
          AssistantInputTarget::InitialContent,
          AssistantInputTarget::AssistanceMode,
        ] {
          let Some(AssistantValueBinding::Input { input }) = inputs.get(&target) else {
            return Err("Workspace allocation requires explicit native input bindings".into());
          };
          if !source
            .inputs
            .iter()
            .any(|candidate| candidate.id == *input && candidate.target == target && candidate.required)
          {
            return Err("Workspace allocation requires its admitted native inputs".into());
          }
        }
        if inputs.len() != 3 || source.inputs.len() != 3 {
          return Err("unsupported native Workspace allocation input".into());
        }
        let mode = source
          .inputs
          .iter()
          .find(|input| input.target == AssistantInputTarget::AssistanceMode)
          .expect("validated binding");
        let mut modes = Vec::new();
        for choice in &mode.choices {
          let (AssistantValue::Text(value) | AssistantValue::Choice(value)) = &choice.value else {
            return Err("native assistance requires scalar choices".into());
          };
          let native: crate::auth::AssistanceMode = serde_json::from_value(serde_json::Value::String(value.clone()))
            .map_err(|_| "unsupported native assistance mode")?;
          if modes.contains(&native) {
            return Err("duplicate native assistance choice".into());
          }
          modes.push(native);
        }
        if [
          crate::auth::AssistanceMode::Manual,
          crate::auth::AssistanceMode::Guided,
          crate::auth::AssistanceMode::Automatic,
        ]
        .iter()
        .any(|mode| !modes.contains(mode))
        {
          return Err("Workspace creation must offer every native assistance mode".into());
        }
        if source
          .inputs
          .iter()
          .find(|input| input.target == AssistantInputTarget::WorkspaceName)
          .is_none_or(|input| input.value_type != AssistantValueType::Text)
        {
          return Err("Workspace name must remain editable text".into());
        }
      }
      AssistantNativeAction::CreateProject {
        template_id,
        inputs,
        scaffold,
      } => {
        super::project_setup::validate_scaffold(scaffold)?;
        if !scaffold.is_empty() && !inputs.contains_key(&AssistantInputTarget::IncludeScaffold) {
          return Err("authored Project scaffold requires an explicit selection input".into());
        }
        if scaffold.is_empty() && inputs.contains_key(&AssistantInputTarget::IncludeScaffold) {
          return Err("Project scaffold selection requires authored native proposals".into());
        }
        if !project_contexts(source)
          || source.components.first().is_none_or(|first| first.id != component.id)
          || source
            .components
            .iter()
            .skip(1)
            .any(|child| !matches!(child.action, AssistantNativeAction::CreateDocument { .. }))
        {
          return Err("Project application requires one primary Project and optional native documents".into());
        }
        let selection = templates
          .selections(template_id)
          .and_then(|selections| selections.first())
          .map(|selection| selection.input)
          .ok_or("package references unavailable native template")?;
        let spec = templates
          .select_selection(template_id, selection)
          .ok_or("package references unavailable native variant")?;
        if spec.profile_kind != DatabaseProfileKind::Project {
          return Err("Project package requires native managed source".into());
        }
        let priority = project_parameter_values(
          source,
          AssistantInputTarget::PriorityPreset,
          serde_json::to_value(selection.priority)
            .expect("native enum")
            .as_str()
            .expect("enum string")
            .into(),
        );
        let complexity = project_parameter_values(
          source,
          AssistantInputTarget::ComplexityPreset,
          serde_json::to_value(selection.complexity)
            .expect("native enum")
            .as_str()
            .expect("enum string")
            .into(),
        );
        let structure = project_parameter_values(
          source,
          AssistantInputTarget::StructurePreset,
          serde_json::to_value(selection.structure)
            .expect("native enum")
            .as_str()
            .expect("enum string")
            .into(),
        );
        if priority.len() * complexity.len() * structure.len() > 64 {
          return Err("native Project parameter combinations exceed bound".into());
        }
        for priority in &priority {
          for complexity in &complexity {
            for structure in &structure {
              let preset = |value: &str| {
                if value == "threeStep" {
                  DatabaseProjectOptionPreset::ThreeStep
                } else {
                  DatabaseProjectOptionPreset::FiveStep
                }
              };
              let variant = templates
                .select(
                  template_id,
                  preset(priority),
                  preset(complexity),
                  structure.parse().map_err(|_| "unsupported native Project structure")?,
                )
                .ok_or("unsupported native Project parameter combination")?;
              let manifest = variant.to_manifest()?;
              for view in
                project_parameter_values(source, AssistantInputTarget::InitialView, manifest.views[0].key.clone())
              {
                if !manifest.views.iter().any(|candidate| candidate.key == view) {
                  return Err("initial View is unavailable for native parameter combination".into());
                }
              }
            }
          }
        }
        for (target, binding) in inputs {
          let AssistantValueBinding::Input { input } = binding else {
            return Err("current Project adapter requires explicit input bindings".into());
          };
          if !matches!(
            target,
            AssistantInputTarget::Title
              | AssistantInputTarget::Description
              | AssistantInputTarget::Folder
              | AssistantInputTarget::PriorityPreset
              | AssistantInputTarget::ComplexityPreset
              | AssistantInputTarget::StructurePreset
              | AssistantInputTarget::DefaultCurrency
              | AssistantInputTarget::InitialView
              | AssistantInputTarget::IncludeSamples
              | AssistantInputTarget::Goal
              | AssistantInputTarget::Scope
              | AssistantInputTarget::StartDate
              | AssistantInputTarget::EndDate
              | AssistantInputTarget::People
              | AssistantInputTarget::IncludeScaffold
          ) {
            return Err("input target is unsupported by native Project adapter".into());
          }
          if !source
            .inputs
            .iter()
            .any(|value| value.id == *input && value.target == *target)
          {
            return Err("native action input binding mismatch".into());
          }
        }
        if !inputs.contains_key(&AssistantInputTarget::Title) {
          return Err("Project action requires its native title input".into());
        }
        if source
          .inputs
          .iter()
          .any(|input| !inputs.contains_key(&input.target) && input.target != AssistantInputTarget::IncludeComponent)
        {
          return Err("Project presentation input is not consumed by its native component".into());
        }
        let title = source
          .inputs
          .iter()
          .find(|input| input.target == AssistantInputTarget::Title)
          .ok_or("Project title input unavailable")?;
        if !title.required {
          return Err("native Project title must be a required input".into());
        }
      }
    }
  }
  for input in source
    .inputs
    .iter()
    .filter(|input| input.target == AssistantInputTarget::IncludeComponent)
  {
    if source.components.iter().filter(|component| matches!(&component.action,
      AssistantNativeAction::CreateDocument { selected: AssistantValueBinding::Input { input: selected }, .. } | AssistantNativeAction::CreateWorkingDocument { selected: AssistantValueBinding::Input { input: selected }, .. } | AssistantNativeAction::CreateDatabaseFromDefinition { selected: AssistantValueBinding::Input { input: selected }, .. } if selected == &input.id)).count() != 1 {
      return Err("each document selector must bind exactly one native component".into());
    }
  }
  if let Some(help) = &source.presentation.guided_help {
    if !help.actions.is_empty()
      || help.groups.iter().any(|group| {
        group.visible_when.is_some() || group.role != AssistantGroupRole::Content || !group.controls.is_empty()
      })
    {
      return Err("Guided help must contain only declared content groups".into());
    }
  }
  let mut control_ids = BTreeSet::new();
  let mut field_presences: BTreeMap<String, Vec<AssistantCellPresence>> = BTreeMap::new();
  let mut sections = BTreeSet::new();
  let mut actions = BTreeSet::new();
  let step_ids = source
    .presentation
    .steps
    .iter()
    .map(|step| step.id.as_str())
    .collect::<BTreeSet<_>>();
  let dialog_ids = source
    .presentation
    .dialogs
    .iter()
    .map(|dialog| dialog.id.as_str())
    .collect::<BTreeSet<_>>();
  for (id, title, groups, buttons) in source
    .presentation
    .steps
    .iter()
    .map(|step| (&step.id, &step.title, &step.groups, &step.actions))
    .chain(
      source
        .presentation
        .guided_help
        .iter()
        .map(|step| (&step.id, &step.title, &step.groups, &step.actions)),
    )
    .chain(
      source
        .presentation
        .dialogs
        .iter()
        .map(|dialog| (&dialog.id, &dialog.title, &dialog.groups, &dialog.actions)),
    )
  {
    if !key(id) || !sections.insert(id) || !text(title) || groups.len() > 64 || buttons.len() > 32 {
      return Err("invalid presentation section".into());
    }
    let mut group_ids = BTreeSet::new();
    for group in groups {
      if !key(&group.id)
        || !group_ids.insert(&group.id)
        || group.title.as_ref().is_some_and(|value| !text(value))
        || group.controls.len() > 128
      {
        return Err("invalid presentation group".into());
      }
      visibility(&group.visible_when, &source.inputs)?;
      let mut group_control_ids = BTreeSet::new();
      for control in &group.controls {
        let identity = control_identity(control);
        if !group_control_ids.insert(identity.clone())
          || (!matches!(control, AssistantControl::Input { .. }) && !control_ids.insert(identity))
        {
          return Err("duplicate typed presentation control identity".into());
        }
        for input in source
          .inputs
          .iter()
          .filter(|input| control_targets_input(control, input))
        {
          let index = source
            .inputs
            .iter()
            .position(|candidate| candidate.id == input.id)
            .expect("resolved input");
          visibility(&group.visible_when, &source.inputs[..index])?;
          if input.required && group.visible_when.is_some() {
            return Err("required native input control cannot be hidden".into());
          }
        }
        match control {
          AssistantControl::Input { input, control } => {
            let input = source
              .inputs
              .iter()
              .find(|value| value.id == *input)
              .ok_or("control references missing input")?;
            let compatible = match control {
              AssistantInputControlKind::TaskReferences => input.value_type == AssistantValueType::TaskReferences,
              AssistantInputControlKind::Document => input.value_type == AssistantValueType::Document,
              AssistantInputControlKind::Text
              | AssistantInputControlKind::Multiline
              | AssistantInputControlKind::Search => input.value_type == AssistantValueType::Text,
              AssistantInputControlKind::Toggle => input.value_type == AssistantValueType::Boolean,
              AssistantInputControlKind::Select | AssistantInputControlKind::RadioCards => {
                input.value_type == AssistantValueType::Choice
              }
              AssistantInputControlKind::MultiSelect => input.value_type == AssistantValueType::Choices,
              AssistantInputControlKind::Date => input.value_type == AssistantValueType::Date,
              AssistantInputControlKind::DateTime => input.value_type == AssistantValueType::DateTime,
              AssistantInputControlKind::Members => input.value_type == AssistantValueType::Members,
              AssistantInputControlKind::Destination => input.value_type == AssistantValueType::DatabaseDestination,
              AssistantInputControlKind::RowTemplate => input.value_type == AssistantValueType::RowTemplate,
              AssistantInputControlKind::Row => input.value_type == AssistantValueType::Row,
              AssistantInputControlKind::Folder => input.value_type == AssistantValueType::Folder,
            };
            if !compatible {
              return Err("native control/input type mismatch".into());
            }
          }
          AssistantControl::NativeCell { binding, presence } => {
            let previous = field_presences.entry(binding_key(binding)).or_default();
            if !previous.is_empty()
              && (*presence == AssistantCellPresence::Always || previous.contains(&AssistantCellPresence::Always))
            {
              return Err("overlapping native field presence controls".into());
            }
            previous.push(*presence);
            if *presence != AssistantCellPresence::Always
              && source
                .contexts
                .iter()
                .any(|context| *context != AssistantPackageContext::TaskDetail)
            {
              return Err("Cell presence requires the native Task detail snapshot".into());
            }
            let known = DATABASE_PROJECT_SEMANTIC_CATALOG
              .iter()
              .filter(|role| role.row_kind_scope == DatabaseRowKind::Task)
              .any(|role| match binding {
                AssistantFieldBinding::Role { role_key } => role.role_key == role_key,
                AssistantFieldBinding::Field { field_key } => role.field_key == field_key,
              });
            if !known {
              return Err("unsupported native Task binding".into());
            }
          }
          AssistantControl::Reminder {
            offsets_minutes,
            default_offset_minutes,
            allow_custom_offset,
          } => {
            if offsets_minutes.is_empty()
              || offsets_minutes.len() > 32
              || !(0..=525600).contains(default_offset_minutes)
              || (!allow_custom_offset && !offsets_minutes.contains(default_offset_minutes))
              || offsets_minutes.iter().any(|offset| *offset < 0 || *offset > 525600)
            {
              return Err("invalid native reminder choices".into());
            }
          }
          _ => {}
        }
      }
    }
    for action in buttons {
      if !key(&action.id)
        || !actions.insert(&action.id)
        || action.label.as_ref().is_some_and(|value| !text(value))
        || action
          .target_step
          .as_ref()
          .is_some_and(|id| !step_ids.contains(id.as_str()))
        || action
          .dialog
          .as_ref()
          .is_some_and(|id| !dialog_ids.contains(id.as_str()))
        || action.component.as_ref().is_some_and(|id| !components.contains(id))
      {
        return Err("invalid presentation action reference".into());
      }
      if action.action == AssistantActionKind::CreateProject
        && action.component.as_ref().is_some_and(|id| {
          source
            .components
            .iter()
            .find(|component| component.id == *id)
            .is_none_or(|component| !matches!(component.action, AssistantNativeAction::CreateProject { .. }))
        })
      {
        return Err("Project apply must reference its primary native Project component".into());
      }
      visibility(&action.visible_when, &source.inputs)?;
      if matches!(
        action.action,
        AssistantActionKind::CreateProject | AssistantActionKind::CreateWorkspace
      ) && action.component.is_none()
      {
        return Err("Project action requires native component".into());
      }
    }
  }
  if matches!(
    source.components.first().map(|component| &component.action),
    Some(AssistantNativeAction::CreateWorkspace { inputs }) if !inputs.is_empty()
  ) {
    if source.components.len() != 1 || source.presentation.steps.len() != 1 || !source.presentation.dialogs.is_empty() {
      return Err("native Empty Workspace creation supports one reviewed main step".into());
    }
    let step = &source.presentation.steps[0];
    if !step
      .groups
      .iter()
      .filter(|group| group.visible_when.is_none())
      .flat_map(|group| &group.controls)
      .any(|control| matches!(control, AssistantControl::WorkspaceReview))
    {
      return Err("Workspace allocation requires an unconditional Empty review".into());
    }
  }
  if workspace_setup_source(source)
    && !source.presentation.steps.iter().any(|step| {
      step
        .groups
        .iter()
        .filter(|group| group.visible_when.is_none())
        .flat_map(|group| &group.controls)
        .any(|control| matches!(control, AssistantControl::WorkspaceReview))
    })
  {
    return Err("Workspace setup requires its unconditional native review".into());
  }
  validate_context_capabilities(source)?;
  let unconditional_sections = presentation_reachability(source)?;
  if source
    .contexts
    .contains(&AssistantPackageContext::TaskContainerAssistance)
  {
    let maintenance_request = matches!(
      source.components.first().map(|component| &component.action),
      Some(AssistantNativeAction::TaskMaintenance { .. })
    );
    let preparation_request = matches!(
      source.components.first().map(|component| &component.action),
      Some(AssistantNativeAction::ConfigureTaskPreparation { .. })
    );
    if maintenance_request || preparation_request {
      validate_task_assistance_review(source, maintenance_request)?;
    } else {
      let handover_request = matches!(
        source.components.first().map(|component| &component.action),
        Some(AssistantNativeAction::TaskHandover { .. })
      );
      let review_request = matches!(
        source.components.first().map(|component| &component.action),
        Some(AssistantNativeAction::RequestDocumentReview { .. })
      );
      if source.contexts != [AssistantPackageContext::TaskContainerAssistance]
        || source.components.iter().any(|component| {
          if review_request || handover_request {
            !matches!(
              &component.action,
              AssistantNativeAction::TaskHandover { .. }
                | AssistantNativeAction::RequestDocumentReview { .. }
                | AssistantNativeAction::CreateTaskFromDocument { .. }
            )
          } else {
            !matches!(&component.action, AssistantNativeAction::CreateDocument { .. })
          }
        })
      {
        return Err("contextual preparation requires native document or review components".into());
      }
      let prepare_action = if handover_request {
        AssistantActionKind::PrepareTaskHandover
      } else if review_request {
        AssistantActionKind::PrepareDocumentReview
      } else {
        AssistantActionKind::PrepareDocuments
      };
      let review_group = |groups: &[AssistantGroup]| {
        groups.iter().any(|group| {
          group.visible_when.is_none()
            && group.controls.iter().any(|control| {
              matches!(control, AssistantControl::TaskHandoverReview) == handover_request
                && matches!(
                  control,
                  AssistantControl::DocumentReview | AssistantControl::TaskHandoverReview
                )
            })
        })
      };
      for dialog in &source.presentation.dialogs {
        if dialog.groups.iter().flat_map(|group| &group.controls).any(|control| {
          !(matches!(
            control,
            AssistantControl::DocumentReview | AssistantControl::TaskHandoverReview
          ) && matches!(control, AssistantControl::TaskHandoverReview) == handover_request)
        }) || source
          .presentation
          .steps
          .iter()
          .flat_map(|step| &step.actions)
          .any(|action| action.dialog.as_deref() == Some(dialog.id.as_str()) && action.action != prepare_action)
        {
          return Err("contextual review dialogs require native readonly review and preparation openers".into());
        }
      }
      if !source.presentation.steps.iter().any(|step| review_group(&step.groups))
        && !source.presentation.dialogs.iter().any(|dialog| {
          review_group(&dialog.groups)
            && source
              .presentation
              .steps
              .iter()
              .flat_map(|step| &step.actions)
              .any(|action| {
                action.action == prepare_action
                  && action.visible_when.is_none()
                  && action.dialog.as_deref() == Some(dialog.id.as_str())
              })
        })
      {
        return Err("contextual preparation requires an unconditional native document review".into());
      }
    }
  }
  validate_project_review_flow(source)?;
  for (id, groups) in source
    .presentation
    .steps
    .iter()
    .map(|step| (&step.id, &step.groups))
    .chain(
      source
        .presentation
        .dialogs
        .iter()
        .map(|dialog| (&dialog.id, &dialog.groups)),
    )
  {
    if !unconditional_sections.contains(id)
      && groups
        .iter()
        .flat_map(|group| &group.controls)
        .any(|control| source.inputs.iter().any(|input| control_targets_input(control, input)))
    {
      return Err("native input section requires an unconditional presentation path".into());
    }
  }
  // Safety readback/close belongs to the native write controller. An authored
  // mask cannot conditionally remove those actions after an uncertain result.
  if source.contexts.iter().any(|context| {
    matches!(
      context,
      AssistantPackageContext::WorkspaceCreation
        | AssistantPackageContext::TaskContainerAssistance
        | AssistantPackageContext::ProjectCreation
        | AssistantPackageContext::TaskCreation
        | AssistantPackageContext::TaskCapture
        | AssistantPackageContext::TaskSubtask
        | AssistantPackageContext::TaskMovement
    )
  }) {
    for required in [AssistantActionKind::Check, AssistantActionKind::Close] {
      let available = source
        .presentation
        .steps
        .iter()
        .filter(|step| unconditional_sections.contains(&step.id))
        .flat_map(|step| step.actions.iter())
        .any(|action| action.action == required && action.visible_when.is_none() && action.dialog.is_none());
      if !available {
        return Err("native write presentation requires unconditional readback and close actions".into());
      }
    }
  }
  for context in &source.contexts {
    let Some(write) = native_write_action(source, native_context(source, *context)) else {
      continue;
    };
    for step in &source.presentation.steps {
      let writes = step.actions.iter().any(|action| {
        action.action == write
          || action.dialog.as_ref().is_some_and(|id| {
            source
              .presentation
              .dialogs
              .iter()
              .any(|dialog| dialog.id == *id && dialog.actions.iter().any(|button| button.action == write))
          })
      });
      if writes {
        // Native write controllers lock navigation while the outcome is
        // uncertain. Recovery must remain on the originating main step.
        for required in [AssistantActionKind::Check, AssistantActionKind::Close] {
          if !step
            .actions
            .iter()
            .any(|action| action.action == required && action.visible_when.is_none() && action.dialog.is_none())
          {
            return Err("native write step requires direct unconditional readback and close actions".into());
          }
        }
      }
    }
  }
  let controls = source
    .presentation
    .steps
    .iter()
    .filter(|step| unconditional_sections.contains(&step.id))
    .flat_map(|step| &step.groups)
    .chain(
      source
        .presentation
        .dialogs
        .iter()
        .filter(|dialog| unconditional_sections.contains(&dialog.id))
        .flat_map(|dialog| &dialog.groups),
    )
    .filter(|group| group.visible_when.is_none())
    .flat_map(|group| &group.controls)
    .collect::<Vec<_>>();
  for input in &source.inputs {
    let placed = source
      .presentation
      .steps
      .iter()
      .flat_map(|step| &step.groups)
      .chain(source.presentation.dialogs.iter().flat_map(|dialog| &dialog.groups))
      .flat_map(|group| &group.controls)
      .any(|control| control_targets_input(control, input));
    if !placed {
      return Err("native input requires a real presentation control".into());
    }
  }
  for input in source.inputs.iter().filter(|input| input.required) {
    if !controls.iter().any(|control| control_targets_input(control, input)) {
      return Err("required native input needs an unconditional presentation control".into());
    }
  }
  let buttons = source
    .presentation
    .steps
    .iter()
    .filter(|step| unconditional_sections.contains(&step.id))
    .flat_map(|step| &step.actions)
    .chain(
      source
        .presentation
        .dialogs
        .iter()
        .filter(|dialog| unconditional_sections.contains(&dialog.id))
        .flat_map(|dialog| &dialog.actions),
    )
    .collect::<Vec<_>>();
  for context in &source.contexts {
    // Movement retains its dedicated prepare/commit checks below.
    if *context == AssistantPackageContext::TaskMovement || native_context(source, *context) != *context {
      continue;
    }
    let Some(action) = native_write_action(source, *context) else {
      continue;
    };
    if !buttons.iter().any(|button| {
      button.action == action
        && button.visible_when.is_none()
        && button.dialog.is_none()
        && (!matches!(
          action,
          AssistantActionKind::CreateProject
            | AssistantActionKind::CreateWorkspace
            | AssistantActionKind::StartTaskHandover
            | AssistantActionKind::RequestDocumentReview
        ) || button.component.as_ref() == source.components.first().map(|component| &component.id))
    }) {
      return Err("native write context requires an unconditional executable apply action".into());
    }
  }
  if source.contexts.contains(&AssistantPackageContext::TaskMovement) {
    // The native move controller owns one transient step. It locks navigation
    // after commit; only confirmation dialogs may sit behind eligibility gates.
    if source.presentation.steps.len() != 1 {
      return Err("native Task move presentation requires one main step".into());
    }
    let main_steps = &source.presentation.steps;
    let safety_controls = main_steps
      .iter()
      .flat_map(|step| &step.groups)
      .filter(|group| group.visible_when.is_none())
      .flat_map(|group| &group.controls)
      .collect::<Vec<_>>();
    for required in [
      AssistantControl::MoveSelection,
      AssistantControl::MoveImpact,
      AssistantControl::CurrentOwnerReadback,
    ] {
      if !safety_controls
        .iter()
        .any(|control| control_identity(control) == control_identity(&required))
      {
        return Err(
          "Task move presentation requires unconditional selection, impact and current-owner readback".into(),
        );
      }
    }
    for required in [
      AssistantActionKind::PrepareTaskMove,
      AssistantActionKind::Check,
      AssistantActionKind::Close,
    ] {
      if !main_steps
        .iter()
        .flat_map(|step| &step.actions)
        .any(|action| action.action == required && action.visible_when.is_none() && action.dialog.is_none())
      {
        return Err("Task move preparation and recovery actions must remain in unconditional main steps".into());
      }
    }
    for required in [
      AssistantActionKind::PrepareTaskMove,
      AssistantActionKind::CommitTaskMove,
    ] {
      if !buttons
        .iter()
        .any(|action| action.action == required && action.visible_when.is_none() && action.dialog.is_none())
      {
        return Err("Task move presentation requires native prepare and commit actions".into());
      }
    }
  }
  if source.contexts.contains(&AssistantPackageContext::TaskCapture)
    && source
      .inputs
      .iter()
      .any(|input| input.target == AssistantInputTarget::CopyDescription)
    && !controls
      .iter()
      .any(|control| matches!(control, AssistantControl::SourceOrigin))
  {
    return Err("capture description copy requires unconditional native source preview".into());
  }
  Ok(())
}

fn validate_task_assistance_review(source: &AssistantPackageSource, maintenance: bool) -> Result<(), String> {
  if source.contexts != [AssistantPackageContext::TaskContainerAssistance]
    || source.components.iter().enumerate().any(|(index, component)| {
      if index == 0 {
        if maintenance {
          !matches!(component.action, AssistantNativeAction::TaskMaintenance { .. })
        } else {
          !matches!(component.action, AssistantNativeAction::ConfigureTaskPreparation { .. })
        }
      } else if maintenance {
        !matches!(
          component.action,
          AssistantNativeAction::InspectTaskContent { .. } | AssistantNativeAction::ApplyTaskCorrections { .. }
        )
      } else {
        !matches!(component.action, AssistantNativeAction::CreateLinkedDocument { .. })
      }
    })
  {
    return Err("invalid native Task assistance component closure".into());
  }
  let prepare = if maintenance {
    AssistantActionKind::PrepareTaskMaintenance
  } else {
    AssistantActionKind::PrepareTaskPreparation
  };
  let review = |control: &AssistantControl| {
    if maintenance {
      matches!(control, AssistantControl::TaskMaintenanceReview)
    } else {
      matches!(control, AssistantControl::TaskPreparationReview)
    }
  };
  let has_review = source.presentation.steps.iter().any(|step| {
    step
      .groups
      .iter()
      .any(|group| group.visible_when.is_none() && group.controls.iter().any(review))
  }) || source.presentation.dialogs.iter().any(|dialog| {
    dialog
      .groups
      .iter()
      .any(|group| group.visible_when.is_none() && group.controls.iter().any(review))
      && source
        .presentation
        .steps
        .iter()
        .flat_map(|step| &step.actions)
        .any(|action| {
          action.action == prepare
            && action.visible_when.is_none()
            && action.dialog.as_deref() == Some(dialog.id.as_str())
        })
  });
  if !has_review
    || source.presentation.dialogs.iter().any(|dialog| {
      dialog
        .groups
        .iter()
        .flat_map(|group| &group.controls)
        .any(|control| !review(control))
    })
  {
    return Err("Task assistance requires an unconditional native readonly review".into());
  }
  Ok(())
}
