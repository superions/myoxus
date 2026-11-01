// SPDX-License-Identifier: AGPL-3.0-or-later
//! Selected native components share the existing Workspace allocation receipt.
use myoxus_domain::assistant_package::*;
use myoxus_domain::ids::*;
use myoxus_domain::workspace_automation::WorkspaceAutomationRun;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

/// Published help and current-reader-authorized working copies are separate
/// projections: opening help never assigns or materializes a Library template.
#[derive(Debug, Clone)]
pub struct WorkspaceSetupAssistance {
  pub descriptor: myoxus_domain::assistant_package::AssistantPackageDescriptor,
  pub document_targets: Vec<WorkspaceSetupAssistanceDocumentTarget>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceSetupAssistanceDocumentTarget {
  pub step: String,
  pub group: String,
  pub source_digest: String,
  pub component_id: String,
  pub document_id: Uuid,
  pub document_external_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSetupReservation {
  pub component_id: String,
  pub result_id: Uuid,
  pub entry_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSetupProgress {
  pub folder_ready: bool,
  pub results: BTreeMap<String, WorkspaceSetupResult>,
  pub complete: bool,
}

pub use myoxus_domain::workspace_automation::WorkspaceSetupResult;

#[derive(Debug, Clone)]
pub struct AcceptedWorkspaceSetup {
  pub document_progress: crate::workspace::ProjectStarterProgress,
  pub folder_id: Option<String>,
  pub actor_id: UserId,
  pub workspace_id: WorkspaceId,
  pub request_id: Uuid,
  pub fingerprint: String,
  pub original: AssistantPreparedWorkspaceSetup,
  /// Absent until full native preflight has a real allocated Workspace.
  pub plan: Option<AssistantPreparedWorkspaceSetup>,
  pub reservations: Vec<WorkspaceSetupReservation>,
  pub progress: WorkspaceSetupProgress,
  pub state: crate::workspace::ProjectStarterState,
  pub run_id: Uuid,
}

/// Links are projected only after current native read authorization. Reserved
/// identities remain visible even when a completed result has been removed.
#[derive(Debug, Clone)]
pub struct WorkspaceSetupComponentView {
  pub component_id: String,
  pub reserved_id: Uuid,
  pub result: Option<WorkspaceSetupResult>,
  pub document_external_id: Option<String>,
  pub available: bool,
}

#[derive(Debug, Clone)]
pub struct WorkspaceSetupOutcome {
  pub status: crate::workspace::ProjectStarterStatus,
  pub accepted: AcceptedWorkspaceSetup,
  pub accepted_descriptor: Option<AssistantPackageDescriptor>,
  pub current_review: Option<AssistantPreparedWorkspaceSetup>,
  pub run: Option<WorkspaceAutomationRun>,
  pub components: Vec<WorkspaceSetupComponentView>,
  pub can_retry: bool,
  pub can_stop: bool,
  pub reason_code: Option<String>,
}

use super::{AssistantPackageService, preparation::normalize_answers, validation::invalid};
use crate::database::DatabaseResult;
use myoxus_domain::database::DatabaseProfileKind;

fn setup_selected(binding: &AssistantValueBinding, answers: &BTreeMap<String, AssistantValue>) -> DatabaseResult<bool> {
  match binding {
    AssistantValueBinding::Input { input } => match answers.get(input) {
      Some(AssistantValue::Boolean(value)) => Ok(*value),
      _ => Err(invalid("Workspace component requires an explicit selection")),
    },
    _ => Err(invalid("Workspace component requires an explicit selection")),
  }
}
fn setup_text(
  binding: &AssistantValueBinding,
  answers: &BTreeMap<String, AssistantValue>,
  locale: &str,
) -> DatabaseResult<String> {
  match binding {
    AssistantValueBinding::Input { input } => match answers.get(input) {
      Some(AssistantValue::Text(value)) => Ok(value.clone()),
      _ => Err(invalid("Workspace component text is unavailable")),
    },
    AssistantValueBinding::LocalizedText { value } => Ok(
      match locale {
        "de" => &value.de,
        "fr" => &value.fr,
        "es" => &value.es,
        _ => &value.en,
      }
      .clone(),
    ),
    _ => Err(invalid("Workspace component text binding is unavailable")),
  }
}
impl AssistantPackageService {
  #[tracing::instrument(skip_all)]
  pub async fn prepare_workspace_setup(
    &self,
    actor: UserId,
    input: &crate::workspace::WorkspaceStarterSetupInput,
    auth: &crate::auth::AuthService,
  ) -> DatabaseResult<AssistantPreparedWorkspaceSetup> {
    super::project_setup::validate_locale(&input.locale)?;
    if input.client_version == 0 {
      return Err(invalid("native client version must be positive"));
    }
    let creator = auth
      .get_user_by_id(actor)
      .await
      .map_err(|_| invalid("Workspace creator unavailable"))?
      .filter(|user| !user.disabled)
      .ok_or_else(|| invalid("Workspace creator unavailable"))?;
    let source = self
      .packages
      .offered_source(&input.package, AssistantPackageContext::WorkspaceCreation)
      .map_err(invalid)?;
    if !matches!(source.components.first().map(|component| &component.action), Some(AssistantNativeAction::CreateWorkspace { inputs }) if inputs.is_empty())
    {
      return Err(invalid("Workspace setup requires its common allocation capability"));
    }
    let answers = normalize_answers(source, input.answers.clone()).map_err(invalid)?;
    for value in answers.values() {
      match value {
        AssistantValue::Members(ids) if ids.iter().any(|id| *id != actor) => {
          return Err(invalid("new Workspace can only select its creator"));
        }
        AssistantValue::Folder(
          AssistantFolderDestination::Existing { .. } | AssistantFolderDestination::New { parent: Some(_), .. },
        ) => return Err(invalid("new Workspace requires a new root folder")),
        _ => {}
      }
    }
    let workflow = self
      .packages
      .workflow(&input.package)
      .map_err(invalid)?
      .ok_or_else(|| invalid("Workspace workflow source unavailable"))?;
    let mut components = Vec::new();
    let mut definitions = Vec::new();
    for component in source.components.iter().skip(1) {
      match &component.action {
        AssistantNativeAction::CreateDatabaseFromDefinition {
          definition_id,
          selected,
          inputs,
        } => {
          if !setup_selected(selected, &answers)? {
            continue;
          }
          let current = self
            .templates
            .summaries()
            .into_iter()
            .find(|source| source.id == *definition_id && source.profile_kind == DatabaseProfileKind::Generic)
            .ok_or_else(|| invalid("current Generic definition unavailable"))?;
          let title = setup_text(
            inputs
              .get(&AssistantInputTarget::Title)
              .ok_or_else(|| invalid("Generic title unavailable"))?,
            &answers,
            &input.locale,
          )?;
          let title = crate::database::definition::rules::validate_title(&title)?;
          let description = inputs
            .get(&AssistantInputTarget::Description)
            .map(|binding| setup_text(binding, &answers, &input.locale))
            .transpose()?;
          let include_sample_rows = inputs
            .get(&AssistantInputTarget::IncludeSamples)
            .map(|binding| setup_selected(binding, &answers))
            .transpose()?
            .unwrap_or(false);
          definitions.push(AssistantPreparedGenericDefinition {
            component_id: component.id.clone(),
            definition_id: definition_id.clone(),
            version: current.version,
            digest: current.digest,
            selection: current.default_variant,
            title,
            description,
            include_sample_rows,
            default_currency: self.default_currency.clone(),
          });
          components.push(component.clone());
        }
        AssistantNativeAction::CreateWorkingDocument { selected, .. } if setup_selected(selected, &answers)? => {
          components.push(component.clone())
        }
        AssistantNativeAction::CreateWorkingDocument { .. } | AssistantNativeAction::PlaceNativeLink { .. } => {}
        _ => return Err(invalid("unsupported Workspace setup capability")),
      }
    }
    for component in source.components.iter().skip(1) {
      if let AssistantNativeAction::PlaceNativeLink {
        target:
          AssistantValueBinding::Result {
            component: target,
            value: AssistantResultValue::Database | AssistantResultValue::Document,
          },
        folder,
      } = &component.action
      {
        if components.iter().any(|component| component.id == *target) {
          if !matches!(folder,AssistantValueBinding::Input {input} if matches!(answers.get(input),Some(AssistantValue::Folder(AssistantFolderDestination::New {parent:None,..}))))
          {
            return Err(invalid("native link requires its reviewed new root folder"));
          }
          components.push(component.clone());
        }
      }
    }
    if components.is_empty() {
      return Err(invalid("select at least one native Workspace component"));
    }
    let document_metadata = self
      .prepare_document_metadata(
        &input.package,
        source,
        &answers,
        &input.locale,
        Some(input.client_version),
        actor,
        &creator.name.unwrap_or_default(),
      )
      .await?;
    let mut folder = document_metadata.first().map(|document| document.folder.clone());
    for destination in document_metadata
      .iter()
      .map(|document| &document.folder)
      .chain(components.iter().filter_map(|component| match &component.action {
        AssistantNativeAction::PlaceNativeLink {
          folder: AssistantValueBinding::Input { input },
          ..
        } => match answers.get(input) {
          Some(AssistantValue::Folder(folder)) => Some(folder),
          _ => None,
        },
        _ => None,
      }))
    {
      if folder.as_ref().is_some_and(|reviewed| reviewed != destination) {
        return Err(invalid("selected Workspace components must share the reviewed folder"));
      }
      folder = Some(destination.clone());
    }
    super::project_setup::validate_new_workspace_context(actor, &[], folder.as_ref())?;
    Ok(AssistantPreparedWorkspaceSetup {
      folder,
      actor_id: actor,
      workspace_id: None,
      package: input.package.clone(),
      answers,
      locale: input.locale.clone(),
      client_version: input.client_version,
      workflow,
      components,
      definitions,
      document_metadata,
      documents: Vec::new(),
      execution_available: self.context_workflows_enabled && self.project_placement.is_some(),
    })
  }
}

impl AssistantPackageService {
  /// Binding never re-resolves current offering selection or creator display
  /// names. The metadata and authored values were accepted before allocation.
  #[tracing::instrument(skip_all)]
  pub async fn bind_workspace_setup(
    &self,
    accepted: &AcceptedWorkspaceSetup,
  ) -> DatabaseResult<AssistantPreparedWorkspaceSetup> {
    let mut plan = accepted.plan.as_ref().unwrap_or(&accepted.original).clone();
    if plan.actor_id != accepted.actor_id || plan.workspace_id.is_some_and(|id| id != accepted.workspace_id) {
      return Err(invalid("Workspace setup scope changed"));
    }
    let source = self.packages.retained_source(&plan.package).map_err(invalid)?;
    self
      .definition
      .validate_database_creation(accepted.actor_id, accepted.workspace_id, "Workspace setup")
      .await?;
    let acknowledged = accepted
      .progress
      .results
      .iter()
      .filter_map(|(component, result)| {
        matches!(result, WorkspaceSetupResult::Document { .. }).then(|| component.clone())
      })
      .collect();
    let (documents, _) = self
      .prepare_document_components(
        accepted.actor_id,
        accepted.workspace_id,
        &plan.package,
        source,
        &plan.answers,
        &plan.locale,
        Some(plan.client_version),
        &plan.documents,
        &plan.document_metadata,
        &acknowledged,
      )
      .await?;
    plan.documents = documents;
    plan.workspace_id = Some(accepted.workspace_id);
    plan.execution_available = self.context_workflows_enabled
      && self.project_placement.is_some()
      && plan.documents.len() == plan.document_metadata.len();
    Ok(plan)
  }
}

impl AcceptedWorkspaceSetup {
  pub fn document_receipt(&self) -> crate::workspace::StarterDocumentReceipt {
    use crate::workspace::*;
    let plan = self.plan.as_ref().unwrap_or(&self.original);
    let ids = plan
      .documents
      .iter()
      .filter_map(|document| {
        self
          .reservations
          .iter()
          .find(|reserved| reserved.component_id == document.source.component_id)
          .map(|reserved| ProjectStarterDocumentIds {
            component_id: reserved.component_id.clone(),
            doc_id: reserved.result_id,
            entry_id: reserved.entry_id.clone(),
          })
      })
      .collect();
    let mut links = BTreeMap::new();
    for component in &plan.components {
      if let AssistantNativeAction::PlaceNativeLink {
        target: AssistantValueBinding::Result { component: target, .. },
        ..
      } = &component.action
      {
        if let Some(result) = self.progress.results.get(target) {
          if let Some(reserved) = self
            .reservations
            .iter()
            .find(|reserved| reserved.component_id == component.id)
          {
            links.insert(
              component.id.clone(),
              StarterNativeLink {
                entry_id: reserved.entry_id.clone(),
                target: result.clone(),
              },
            );
          }
        }
      }
    }
    StarterDocumentReceipt {
      operation: StarterOperation::CreateWorkspace,
      actor_id: self.actor_id,
      workspace_id: self.workspace_id,
      request_id: self.request_id,
      fingerprint: self.fingerprint.clone(),
      origin: StarterDocumentOrigin::WorkspaceSetup { links },
      folder: plan.folder.clone(),
      documents: plan.documents.clone(),
      people: plan
        .answers
        .values()
        .filter_map(|value| match value {
          AssistantValue::Members(ids) => Some(ids.clone()),
          _ => None,
        })
        .flatten()
        .collect(),
      client_version: Some(plan.client_version),
      ids,
      folder_id: self.folder_id.clone(),
      state: self.state,
      progress: self.document_progress.clone(),
    }
  }
}

impl AssistantPackageService {
  pub(crate) fn workspace_setup_descriptor(
    &self,
    identity: &AssistantPackageIdentity,
  ) -> Option<AssistantPackageDescriptor> {
    self.packages.accepted_descriptor(identity).ok()
  }
}

impl AssistantPackageService {
  pub(crate) async fn workspace_setup_help_targets(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    descriptor: &AssistantPackageDescriptor,
    documents: &[crate::workspace::WorkspaceSetupAssistanceDocument],
  ) -> crate::auth::AuthResult<Vec<crate::workspace::WorkspaceSetupAssistanceDocumentTarget>> {
    use crate::document_template::DocumentTemplateError;
    use crate::workspace::WorkspaceSetupAssistanceDocumentTarget;
    let Some(help) = &descriptor.presentation.guided_help else {
      return Ok(Vec::new());
    };
    let Some(placement) = &self.project_placement else {
      return Ok(Vec::new());
    };
    let mut targets = Vec::new();
    for slot in &descriptor.document_sources {
      if slot.step != help.id || !help.groups.iter().any(|group| group.id == slot.group) {
        continue;
      }
      let mut matching = documents.iter().filter(|document| {
        document.source.template_id == slot.template_id
          && document.source.version == slot.version
          && document.source.digest == slot.digest
      });
      let Some(document) = matching.next() else {
        continue;
      };
      // A source used by multiple selected components does not identify which
      // working copy the authored help means. Never pick one by iteration order.
      if matching.next().is_some() {
        continue;
      }
      match placement
        .readable_project_result(actor, workspace, &document.created)
        .await
      {
        Ok(()) => targets.push(WorkspaceSetupAssistanceDocumentTarget {
          step: slot.step.clone(),
          group: slot.group.clone(),
          source_digest: slot.digest.clone(),
          component_id: document.source.component_id.clone(),
          document_id: document.created.doc_id,
          document_external_id: document.created.external_id.clone(),
        }),
        Err(
          DocumentTemplateError::Forbidden
          | DocumentTemplateError::NotFound
          | DocumentTemplateError::InvalidDocumentKey,
        ) => {}
        Err(_) => {
          return Err(crate::auth::AuthError::Storage(
            "Workspace help document read unavailable".into(),
          ));
        }
      }
    }
    Ok(targets)
  }

  pub(crate) async fn workspace_setup_views(
    &self,
    accepted: &AcceptedWorkspaceSetup,
  ) -> DatabaseResult<Vec<WorkspaceSetupComponentView>> {
    let mut views = Vec::new();
    for reserved in &accepted.reservations {
      let result = accepted.progress.results.get(&reserved.component_id).cloned();
      let mut external = None;
      let available = match &result {
        Some(WorkspaceSetupResult::Database { database_id }) => match self
          .definition
          .get_database_for_lifecycle(accepted.actor_id, *database_id)
          .await
        {
          Ok(record) => {
            record.database.workspace_id == accepted.workspace_id
              && record.database.deleted_at.is_none()
              && record.database.profile_kind == DatabaseProfileKind::Generic
              && record.database.managed_installation.is_none()
          }
          Err(error)
            if matches!(
              error.code,
              crate::database::ERR_NOT_FOUND | crate::database::ERR_FORBIDDEN
            ) =>
          {
            false
          }
          Err(error) => return Err(error),
        },
        Some(WorkspaceSetupResult::Document { document_id }) => {
          let Some(created) = accepted
            .document_progress
            .documents
            .get(&reserved.component_id)
            .filter(|created| created.doc_id == *document_id)
          else {
            return Err(invalid("invalid Workspace document ACK"));
          };
          if let Some(documents) = &self.project_placement {
            match documents
              .readable_project_result(accepted.actor_id, accepted.workspace_id, created)
              .await
            {
              Ok(()) => {
                external = Some(created.external_id.clone());
                true
              }
              Err(crate::document_template::DocumentTemplateError::Repository(error)) => return Err(error.into()),
              Err(_) => false,
            }
          } else {
            false
          }
        }
        Some(WorkspaceSetupResult::NativeLink { component_id, .. }) => {
          if let Some(documents) = &self.project_placement {
            match documents.workspace_setup_link_available(accepted, component_id).await {
              Ok(available) => available,
              Err(crate::document_template::DocumentTemplateError::Repository(error)) => return Err(error.into()),
              Err(crate::document_template::DocumentTemplateError::Organizer(
                crate::organizer::OrganizerError::Storage,
              )) => {
                return Err(
                  myoxus_domain::repositories::RepositoryError::Storage(
                    "native Workspace link readback unavailable".into(),
                  )
                  .into(),
                );
              }
              Err(_) => false,
            }
          } else {
            false
          }
        }
        None => false,
      };
      views.push(WorkspaceSetupComponentView {
        component_id: reserved.component_id.clone(),
        reserved_id: reserved.result_id,
        result,
        document_external_id: external,
        available,
      });
    }
    Ok(views)
  }
  pub(crate) async fn materialize_workspace_setup_database(
    &self,
    accepted: &AcceptedWorkspaceSetup,
    component: &str,
  ) -> DatabaseResult<myoxus_domain::database::DatabaseInitialState> {
    let plan = accepted
      .plan
      .as_ref()
      .ok_or_else(|| invalid("Workspace setup not bound"))?;
    let definition = plan
      .definitions
      .iter()
      .find(|definition| definition.component_id == component)
      .ok_or_else(|| invalid("Workspace Generic source unavailable"))?;
    let reserved = accepted
      .reservations
      .iter()
      .find(|reserved| reserved.component_id == component)
      .ok_or_else(|| invalid("Workspace result reservation unavailable"))?;
    self
      .definition
      .materialize_workspace_generic(accepted.actor_id, accepted.workspace_id, definition, reserved.result_id)
      .await
  }
  pub(crate) async fn create_workspace_setup_document(
    &self,
    accepted: &AcceptedWorkspaceSetup,
    component: &str,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> Result<(), crate::document_template::DocumentTemplateError> {
    let document = accepted
      .plan
      .as_ref()
      .and_then(|plan| {
        plan
          .documents
          .iter()
          .find(|document| document.source.component_id == component)
      })
      .ok_or(crate::document_template::DocumentTemplateError::CreationUnavailable)?;
    let documents = self
      .project_placement
      .as_ref()
      .ok_or(crate::document_template::DocumentTemplateError::MutationUnavailable)?;
    let registry = self
      .document_components
      .as_ref()
      .ok_or(crate::document_template::DocumentTemplateError::MutationUnavailable)?;
    documents
      .create_workspace_setup_component(registry, accepted, document, fence)
      .await
  }
  pub(crate) async fn place_workspace_setup(
    &self,
    accepted: &AcceptedWorkspaceSetup,
    stage: crate::workspace::ProjectPlacementStage,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> Result<(), crate::document_template::DocumentTemplateError> {
    self
      .project_placement
      .as_ref()
      .ok_or(crate::document_template::DocumentTemplateError::MutationUnavailable)?
      .place_workspace_setup_stage(accepted, stage, fence)
      .await
  }
}
