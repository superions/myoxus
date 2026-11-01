// SPDX-License-Identifier: AGPL-3.0-or-later
//! Saved preferences resolve fresh offerings; they never resume accepted effects.
use super::{
  AssistantPackageService,
  validation::{invalid, validate_value},
};
use crate::auth::*;
use crate::database::{DatabaseResult, DatabaseServiceError};
use myoxus_domain::assistant_package::*;
use myoxus_domain::ids::UserId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct SavedAssistantSelectionInput {
  pub identity: AssistantPackageIdentity,
  pub answers: BTreeMap<String, AssistantValue>,
}
#[derive(Debug, Clone)]
pub struct SavedSetupCaptureInput {
  pub id: Uuid,
  pub name: String,
  pub context: AssistantPackageContext,
  pub package: SavedAssistantSelectionInput,
  pub project: Option<SavedAssistantSelectionInput>,
  pub setup: Option<SavedAssistantSelectionInput>,
  pub assistance_mode: Option<AssistanceMode>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SavedSetupClearReason {
  PackageUnavailable,
  InputUnavailable,
  ValueUnavailable,
  SourceUnavailable,
  WorkflowUnavailable,
  NewComponent,
}
#[derive(Debug, Clone)]
pub struct SavedSetupClearedValue {
  pub input_id: Option<String>,
  pub component_id: Option<String>,
  pub reason: SavedSetupClearReason,
}
#[derive(Debug, Clone)]
pub struct ResolvedSavedAssistantSelection {
  pub descriptor: Option<AssistantPackageDescriptor>,
  pub defaults: BTreeMap<String, SavedSetupValue>,
  pub cleared: Vec<SavedSetupClearedValue>,
  pub unavailable: bool,
}
#[derive(Debug, Clone)]
pub struct SavedSetupResolution {
  pub configuration: SavedSetupConfiguration,
  pub package: ResolvedSavedAssistantSelection,
  pub project: Option<ResolvedSavedAssistantSelection>,
  pub setup: Option<ResolvedSavedAssistantSelection>,
  pub unavailable: bool,
}

fn storage() -> DatabaseServiceError {
  myoxus_domain::repositories::RepositoryError::Storage("saved setup source lookup unavailable".into()).into()
}
fn auth_error(error: AuthError) -> DatabaseServiceError {
  match error {
    AuthError::Storage(_) => storage(),
    _ => invalid("saved setup unavailable"),
  }
}
// Target semantics, rather than Text/Choice shape alone, exclude private prose
// and concrete destinations from reusable defaults.
fn saved_value(input: &AssistantInput, value: &AssistantValue) -> Option<SavedSetupValue> {
  use AssistantInputTarget as T;
  match (&input.target, value) {
    (T::IncludeSamples | T::IncludeScaffold | T::IncludeComponent, AssistantValue::Boolean(value)) => {
      Some(SavedSetupValue::Boolean(*value))
    }
    (
      T::InitialContent
      | T::AssistanceMode
      | T::ProjectTemplate
      | T::PriorityPreset
      | T::ComplexityPreset
      | T::StructurePreset
      | T::InitialView,
      AssistantValue::Choice(value),
    ) => Some(SavedSetupValue::Choice(value.clone())),
    (T::DefaultCurrency, AssistantValue::Text(value)) => {
      myoxus_domain::database::normalize_database_currency_code(value).map(SavedSetupValue::Currency)
    }
    _ => None,
  }
}
fn answer(value: &SavedSetupValue) -> AssistantValue {
  match value {
    SavedSetupValue::Boolean(value) => AssistantValue::Boolean(*value),
    SavedSetupValue::Choice(value) => AssistantValue::Choice(value.clone()),
    SavedSetupValue::Currency(value) => AssistantValue::Text(value.clone()),
  }
}
fn selected(binding: &AssistantValueBinding, values: &BTreeMap<String, AssistantValue>) -> bool {
  match binding {
    AssistantValueBinding::Input { input } => matches!(values.get(input), Some(AssistantValue::Boolean(true))),
    _ => false,
  }
}
fn component_selected(component: &AssistantComponent, values: &BTreeMap<String, AssistantValue>) -> bool {
  match &component.action {
    AssistantNativeAction::CreateDocument { selected: binding, .. }
    | AssistantNativeAction::CreateWorkingDocument { selected: binding, .. }
    | AssistantNativeAction::CreateDatabaseFromDefinition { selected: binding, .. } => selected(binding, values),
    _ => true,
  }
}
fn source_reference(source: &AssistantDocumentComponentSource) -> SavedDocumentSourceReference {
  SavedDocumentSourceReference {
    component_id: source.component_id.clone(),
    template_id: source.template_id.clone(),
    version: source.version.clone(),
    digest: source.digest.clone(),
  }
}
fn clear_component(source: &AssistantPackageSource, component: &str, defaults: &mut BTreeMap<String, SavedSetupValue>) {
  let binding = source
    .components
    .iter()
    .find(|candidate| candidate.id == component)
    .and_then(|component| match &component.action {
      AssistantNativeAction::CreateDocument { selected, .. }
      | AssistantNativeAction::CreateWorkingDocument { selected, .. }
      | AssistantNativeAction::CreateDatabaseFromDefinition { selected, .. } => Some(selected),
      _ => None,
    });
  if let Some(AssistantValueBinding::Input { input }) = binding {
    defaults.insert(input.clone(), SavedSetupValue::Boolean(false));
  }
}
fn context_supported(context: AssistantPackageContext) -> bool {
  matches!(
    context,
    AssistantPackageContext::WorkspaceCreation
      | AssistantPackageContext::ProjectCreation
      | AssistantPackageContext::TaskContainerAssistance
  )
}
#[derive(Clone, Copy)]
enum SelectionKind {
  CommonWorkspace,
  Project,
  Setup,
  Recipe,
}
fn root_kind(context: AssistantPackageContext) -> SelectionKind {
  match context {
    AssistantPackageContext::WorkspaceCreation => SelectionKind::CommonWorkspace,
    AssistantPackageContext::ProjectCreation => SelectionKind::Project,
    _ => SelectionKind::Recipe,
  }
}
fn selection_supported(source: &AssistantPackageSource, context: AssistantPackageContext, kind: SelectionKind) -> bool {
  if !context_supported(context) {
    return false;
  }
  match kind {
    SelectionKind::CommonWorkspace => {
      source.components.len() == 1
        && matches!(
          source.components.first().map(|component| &component.action),
          Some(AssistantNativeAction::CreateWorkspace { .. })
        )
    }
    SelectionKind::Project => matches!(
      source.components.first().map(|component| &component.action),
      Some(AssistantNativeAction::CreateProject { .. })
    ),
    SelectionKind::Setup => super::validation::workspace_setup_source(source),
    SelectionKind::Recipe => source.components.iter().any(|component| {
      matches!(
        component.action,
        AssistantNativeAction::ConfigureTaskPreparation { .. } | AssistantNativeAction::TaskMaintenance { .. }
      )
    }),
  }
}
impl AssistantPackageService {
  async fn saved_document_available(&self, source: &AssistantDocumentComponentSource) -> DatabaseResult<bool> {
    let Some(registry) = &self.document_components else {
      return Ok(false);
    };
    // This checks published metadata only. The normal fresh Prepare still owns
    // the real client's version, native body validation and destination rights.
    match registry
      .delivered_document_source_metadata(&source.template_id, &source.version, &self.default_locale, u32::MAX)
      .await
    {
      Ok(_) => Ok(true),
      Err(AuthError::Storage(_)) => Err(storage()),
      Err(_) => Ok(false),
    }
  }
  async fn capture_saved_selection(
    &self,
    input: SavedAssistantSelectionInput,
    context: AssistantPackageContext,
    kind: SelectionKind,
  ) -> DatabaseResult<SavedAssistantSelection> {
    let source = self
      .packages
      .offered_source(&input.identity, context)
      .map_err(invalid)?;
    if !selection_supported(source, context, kind) {
      return Err(invalid("saved setup package unavailable"));
    }
    let values = super::preparation::normalize_answers(source, input.answers).map_err(invalid)?;
    let mut defaults = BTreeMap::new();
    for field in &source.inputs {
      if let Some(value) = values.get(&field.id) {
        if let Some(value) = saved_value(field, value) {
          defaults.insert(field.id.clone(), value);
        }
      }
    }
    let mut document_sources = Vec::new();
    let mut database_sources = Vec::new();
    for component in &source.components {
      if !component_selected(component, &values) {
        continue;
      }
      match &component.action {
        AssistantNativeAction::CreateDocument { .. }
        | AssistantNativeAction::CreateWorkingDocument { .. }
        | AssistantNativeAction::CreateLinkedDocument { .. } => {
          let native = self
            .packages
            .document_components(&input.identity)
            .iter()
            .find(|(document, _)| document.component_id == component.id)
            .map(|(document, _)| document)
            .ok_or_else(|| invalid("saved document source unavailable"))?;
          if !self.saved_document_available(native).await? {
            return Err(invalid("saved document source unavailable"));
          }
          document_sources.push(source_reference(native));
        }
        AssistantNativeAction::CreateProject { template_id, .. }
        | AssistantNativeAction::CreateDatabaseFromDefinition {
          definition_id: template_id,
          ..
        } => {
          if !self
            .templates
            .summaries()
            .iter()
            .any(|summary| summary.id == *template_id)
          {
            return Err(invalid("saved database source unavailable"));
          }
          database_sources.push(SavedDatabaseSourceReference {
            component_id: component.id.clone(),
            definition_id: template_id.clone(),
          });
        }
        _ => {}
      }
    }
    Ok(SavedAssistantSelection {
      package_id: source.id.clone(),
      defaults,
      document_sources,
      database_sources,
      workflow: self
        .packages
        .workflow(&input.identity)
        .map_err(invalid)?
        .map(|workflow| workflow.identity),
    })
  }
  #[tracing::instrument(skip_all)]
  pub async fn capture_saved_setup(
    &self,
    actor: UserId,
    input: SavedSetupCaptureInput,
    auth: &AuthService,
  ) -> DatabaseResult<SavedSetupConfiguration> {
    if actor.is_nil()
      || auth
        .get_user_by_id(actor)
        .await
        .map_err(auth_error)?
        .is_none_or(|user| user.disabled)
    {
      return Err(invalid("saved setup actor unavailable"));
    }
    if !context_supported(input.context)
      || input.project.is_some() && input.setup.is_some()
      || input.context != AssistantPackageContext::WorkspaceCreation
        && (input.project.is_some() || input.setup.is_some())
    {
      return Err(invalid("invalid saved setup composition"));
    }
    let package = self
      .capture_saved_selection(input.package, input.context, root_kind(input.context))
      .await?;
    let project = match input.project {
      Some(value) => Some(
        self
          .capture_saved_selection(
            value,
            AssistantPackageContext::WorkspaceCreation,
            SelectionKind::Project,
          )
          .await?,
      ),
      None => None,
    };
    let setup = match input.setup {
      Some(value) => Some(
        self
          .capture_saved_selection(value, AssistantPackageContext::WorkspaceCreation, SelectionKind::Setup)
          .await?,
      ),
      None => None,
    };
    let saved = SavedSetupConfiguration {
      id: input.id,
      name: input.name.trim().into(),
      context: input.context,
      package,
      project,
      setup,
      assistance_mode: input.assistance_mode,
    };
    saved.validate().map_err(auth_error)?;
    Ok(saved)
  }
  #[tracing::instrument(skip_all)]
  pub async fn resolve_saved_setup(
    &self,
    actor: UserId,
    saved: &SavedSetupConfiguration,
  ) -> DatabaseResult<SavedSetupResolution> {
    if actor.is_nil() {
      return Err(invalid("saved setup actor unavailable"));
    }
    saved.validate().map_err(auth_error)?;
    let package = self
      .resolve_saved_selection(&saved.package, saved.context, root_kind(saved.context))
      .await?;
    let project = match &saved.project {
      Some(value) => Some(
        self
          .resolve_saved_selection(
            value,
            AssistantPackageContext::WorkspaceCreation,
            SelectionKind::Project,
          )
          .await?,
      ),
      None => None,
    };
    let setup = match &saved.setup {
      Some(value) => Some(
        self
          .resolve_saved_selection(value, AssistantPackageContext::WorkspaceCreation, SelectionKind::Setup)
          .await?,
      ),
      None => None,
    };
    let unavailable = package.unavailable
      || project.as_ref().is_some_and(|value| value.unavailable)
      || setup.as_ref().is_some_and(|value| value.unavailable);
    Ok(SavedSetupResolution {
      configuration: saved.clone(),
      package,
      project,
      setup,
      unavailable,
    })
  }
  async fn resolve_saved_selection(
    &self,
    saved: &SavedAssistantSelection,
    context: AssistantPackageContext,
    kind: SelectionKind,
  ) -> DatabaseResult<ResolvedSavedAssistantSelection> {
    let mut result = ResolvedSavedAssistantSelection {
      descriptor: None,
      defaults: BTreeMap::new(),
      cleared: Vec::new(),
      unavailable: false,
    };
    let Some(descriptor) = self.packages.current_descriptor(&saved.package_id, context) else {
      result.unavailable = true;
      result.cleared.push(SavedSetupClearedValue {
        input_id: None,
        component_id: None,
        reason: SavedSetupClearReason::PackageUnavailable,
      });
      return Ok(result);
    };
    let source = self
      .packages
      .offered_source(&descriptor.identity, context)
      .map_err(invalid)?;
    if !selection_supported(source, context, kind) {
      result.unavailable = true;
      result.cleared.push(SavedSetupClearedValue {
        input_id: None,
        component_id: None,
        reason: SavedSetupClearReason::PackageUnavailable,
      });
      return Ok(result);
    }
    for (key, value) in &saved.defaults {
      let field = source.inputs.iter().find(|input| input.id == *key);
      let reason = match field {
        None => Some(SavedSetupClearReason::InputUnavailable),
        Some(field)
          if validate_value(field, &answer(value)).is_err()
            || saved_value(field, &answer(value)).as_ref() != Some(value) =>
        {
          Some(SavedSetupClearReason::ValueUnavailable)
        }
        Some(_) => None,
      };
      if let Some(reason) = reason {
        result.cleared.push(SavedSetupClearedValue {
          input_id: Some(key.clone()),
          component_id: None,
          reason,
        });
      } else {
        result.defaults.insert(key.clone(), value.clone());
      }
    }
    // An authored new selection never inherits an implicit opt-in from its new
    // default when reopening an older personal configuration.
    for field in &source.inputs {
      if field.target == AssistantInputTarget::IncludeComponent && !result.defaults.contains_key(&field.id) {
        result
          .defaults
          .insert(field.id.clone(), SavedSetupValue::Boolean(false));
        result.cleared.push(SavedSetupClearedValue {
          input_id: Some(field.id.clone()),
          component_id: None,
          reason: SavedSetupClearReason::NewComponent,
        });
      }
    }
    let workflow = self
      .packages
      .workflow(&descriptor.identity)
      .map_err(invalid)?
      .map(|workflow| workflow.identity);
    if workflow != saved.workflow {
      result.unavailable = true;
      result.cleared.push(SavedSetupClearedValue {
        input_id: None,
        component_id: None,
        reason: SavedSetupClearReason::WorkflowUnavailable,
      });
    }
    for reference in &saved.document_sources {
      let current = self
        .packages
        .document_components(&descriptor.identity)
        .iter()
        .find(|(document, _)| source_reference(document) == *reference)
        .map(|(document, _)| document);
      let available = match current {
        Some(current) => self.saved_document_available(current).await?,
        None => false,
      };
      if !available {
        clear_component(source, &reference.component_id, &mut result.defaults);
        result.cleared.push(SavedSetupClearedValue {
          input_id: None,
          component_id: Some(reference.component_id.clone()),
          reason: SavedSetupClearReason::SourceUnavailable,
        });
        result.unavailable = true;
      }
    }
    let summaries = self.templates.summaries();
    for reference in &saved.database_sources {
      let declared = source.components.iter().any(|component| {
        component.id == reference.component_id
          && match &component.action {
            AssistantNativeAction::CreateProject { template_id, .. }
            | AssistantNativeAction::CreateDatabaseFromDefinition {
              definition_id: template_id,
              ..
            } => *template_id == reference.definition_id,
            _ => false,
          }
      });
      if !declared || !summaries.iter().any(|summary| summary.id == reference.definition_id) {
        clear_component(source, &reference.component_id, &mut result.defaults);
        result.cleared.push(SavedSetupClearedValue {
          input_id: None,
          component_id: Some(reference.component_id.clone()),
          reason: SavedSetupClearReason::SourceUnavailable,
        });
        result.unavailable = true;
      }
    }
    let values = result
      .defaults
      .iter()
      .map(|(key, value)| (key.clone(), answer(value)))
      .collect();
    for component in &source.components {
      if !component_selected(component, &values) {
        continue;
      }
      let captured = match &component.action {
        AssistantNativeAction::CreateDocument { .. }
        | AssistantNativeAction::CreateWorkingDocument { .. }
        | AssistantNativeAction::CreateLinkedDocument { .. } => saved
          .document_sources
          .iter()
          .any(|reference| reference.component_id == component.id),
        AssistantNativeAction::CreateProject { .. } | AssistantNativeAction::CreateDatabaseFromDefinition { .. } => {
          saved
            .database_sources
            .iter()
            .any(|reference| reference.component_id == component.id)
        }
        _ => true,
      };
      if !captured {
        clear_component(source, &component.id, &mut result.defaults);
        result.cleared.push(SavedSetupClearedValue {
          input_id: None,
          component_id: Some(component.id.clone()),
          reason: SavedSetupClearReason::NewComponent,
        });
        result.unavailable = true;
      }
    }
    result.descriptor = Some(descriptor);
    Ok(result)
  }
}
