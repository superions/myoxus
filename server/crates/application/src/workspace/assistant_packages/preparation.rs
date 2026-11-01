// SPDX-License-Identifier: AGPL-3.0-or-later

//! Canonical Workspace/Project preparation and application through native owners.
//! Answer normalization and actor-bound confirmation stay on this same boundary.
use super::AssistantPackageService;
use super::validation::{control_targets_input, invalid, validate_value};
use crate::auth::AssistanceMode;
use crate::database::{CreateDatabaseFromTemplate, DatabaseResult};
use crate::workspace::{WorkspaceInitialContent, WorkspaceName};
use myoxus_domain::assistant_package::*;
use myoxus_domain::database::*;
use myoxus_domain::ids::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedWorkspaceAssistant {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub setup: Option<AssistantPreparedWorkspaceSetup>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub project: Option<AssistantPreparedProject>,
  pub package: AssistantPackageIdentity,
  pub answers: BTreeMap<String, AssistantValue>,
  pub name: String,
  pub initial_content: WorkspaceInitialContent,
  pub assistance_mode: AssistanceMode,
}
impl PreparedWorkspaceAssistant {
  /// Bind confirmation to the person who prepared it. Browser cookies may
  /// change before a client-side account observable reports the new owner.
  pub fn plan_digest(&self, actor: UserId) -> String {
    format!(
      "{:x}",
      Sha256::digest(serde_json::to_vec(&(actor, self)).expect("typed actor-bound Workspace plan serializes"))
    )
  }
}
pub struct AssistantAppliedProject {
  pub record: DatabaseRecord,
  pub initial_view_id: DatabaseViewId,
}
impl AssistantPackageService {
  /// Pure preallocation preparation: no Workspace identity or effects exist yet.
  pub fn prepare_workspace(
    &self,
    identity: &AssistantPackageIdentity,
    answers: BTreeMap<String, AssistantValue>,
  ) -> Result<PreparedWorkspaceAssistant, String> {
    let source = self
      .packages
      .offered_source(identity, AssistantPackageContext::WorkspaceCreation)?;
    prepare_workspace_source(source, identity, answers)
  }

  /// Admit only direct Empty allocation before preparing any optional content.
  #[tracing::instrument(skip_all)]
  pub async fn prepare_workspace_creation(
    &self,
    _actor: UserId,
    identity: &AssistantPackageIdentity,
    answers: BTreeMap<String, AssistantValue>,
    project: Option<&crate::workspace::WorkspaceStarterProjectInput>,
    setup: Option<&crate::workspace::WorkspaceStarterSetupInput>,
    _auth: &crate::auth::AuthService,
  ) -> DatabaseResult<PreparedWorkspaceAssistant> {
    // Keep admission here so native callers cannot bypass the creation catalog.
    if project.is_some() || setup.is_some() {
      return Err(invalid("Workspace creation does not accept Project or document setup"));
    }
    self.prepare_workspace(identity, answers).map_err(invalid)
  }

  pub(super) async fn prepare_document_metadata(
    &self,
    identity: &AssistantPackageIdentity,
    source: &AssistantPackageSource,
    answers: &BTreeMap<String, AssistantValue>,
    locale: &str,
    client_version: Option<u32>,
    creator: UserId,
    creator_name: &str,
  ) -> DatabaseResult<Vec<AssistantPreparedDocumentMetadata>> {
    let bound = |binding: &AssistantValueBinding| match binding {
      AssistantValueBinding::Input { input } => answers.get(input),
      _ => None,
    };
    let mut result = Vec::new();
    for component in &source.components {
      let (AssistantNativeAction::CreateDocument {
        selected,
        folder,
        variables,
      }
      | AssistantNativeAction::CreateWorkingDocument {
        selected,
        folder,
        variables,
      }) = &component.action
      else {
        continue;
      };
      if !matches!(bound(selected), Some(AssistantValue::Boolean(true))) {
        continue;
      }
      let Some(AssistantValue::Folder(folder @ AssistantFolderDestination::New { parent: None, .. })) = bound(folder)
      else {
        return Err(invalid("selected document requires a reviewed new root folder"));
      };
      let registry = self
        .document_components
        .as_ref()
        .ok_or_else(|| invalid("native document capability unavailable"))?;
      self
        .project_placement
        .as_ref()
        .ok_or_else(|| invalid("native document capability unavailable"))?;
      let source = self
        .packages
        .document_components(identity)
        .iter()
        .find(|(source, _)| source.component_id == component.id)
        .map(|(source, _)| source)
        .ok_or_else(|| invalid("native document delivery source unavailable"))?;
      let mut values = BTreeMap::new();
      for (key, binding) in variables {
        let value = match bound(binding) {
          None => String::new(),
          Some(AssistantValue::Text(value)) => value.trim().into(),
          Some(AssistantValue::Date(value)) if value.end.is_none() => value.start.to_string(),
          Some(AssistantValue::Members(ids)) if ids.iter().all(|id| *id == creator) => {
            if !ids.is_empty() && creator_name.trim().is_empty() {
              return Err(invalid("Project creator name unavailable"));
            }
            if ids.is_empty() {
              String::new()
            } else {
              creator_name.into()
            }
          }
          _ => return Err(invalid("unsupported preallocation document value")),
        };
        if value.len() > 8192 {
          return Err(invalid("Project document scalar exceeds native input bound"));
        }
        values.insert(key.clone(), value);
      }
      let metadata = registry
        .delivered_document_source_metadata(
          &source.template_id,
          &source.version,
          locale,
          client_version
            .filter(|value| *value > 0)
            .ok_or_else(|| invalid("selected document requires native client version"))?,
        )
        .await
        .map_err(|error| invalid(error.to_string()))?;
      result.push(AssistantPreparedDocumentMetadata {
        source: source.clone(),
        source_revision_id: metadata.revision_id,
        source_revision_digest: metadata.revision_digest,
        locale: metadata.locale,
        title: metadata.title,
        variables: values,
        folder: folder.clone(),
      });
    }
    Ok(result)
  }

  #[tracing::instrument(skip_all)]
  pub async fn prepare_project(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    identity: &AssistantPackageIdentity,
    answers: BTreeMap<String, AssistantValue>,
    locale: &str,
    client_version: Option<u32>,
  ) -> DatabaseResult<AssistantPreparedProject> {
    let source = self
      .packages
      .offered_source(identity, AssistantPackageContext::ProjectCreation)
      .map_err(invalid)?;
    super::project_setup::validate_locale(locale)?;
    if client_version == Some(0) {
      return Err(invalid("native client version must be positive"));
    }
    self
      .prepare_project_source(
        actor,
        workspace_id,
        identity,
        answers,
        locale,
        client_version,
        source,
        None,
        None,
      )
      .await
  }

  pub(crate) async fn prepare_accepted_project(
    &self,
    accepted: &crate::workspace::AcceptedProjectStarter,
  ) -> DatabaseResult<AssistantPreparedProject> {
    // Only WorkspaceService's server-loaded receipt reaches this recovery path.
    self
      .definition
      .validate_database_creation(accepted.actor_id, accepted.workspace_id, &accepted.plan.title)
      .await?;
    let source = self.packages.inventory().get(&accepted.plan.package).map_err(invalid)?;
    self
      .prepare_project_source(
        accepted.actor_id,
        accepted.workspace_id,
        &accepted.plan.package,
        accepted.plan.answers.clone(),
        &accepted.plan.locale,
        accepted.plan.client_version,
        source,
        Some(&accepted.plan),
        Some(&accepted.progress),
      )
      .await
  }

  #[expect(
    clippy::too_many_arguments,
    reason = "one native preparer keeps fresh versus accepted source admission explicit"
  )]
  async fn prepare_project_source(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    identity: &AssistantPackageIdentity,
    answers: BTreeMap<String, AssistantValue>,
    locale: &str,
    client_version: Option<u32>,
    source: &AssistantPackageSource,
    accepted: Option<&AssistantPreparedProject>,
    progress: Option<&crate::workspace::ProjectStarterProgress>,
  ) -> DatabaseResult<AssistantPreparedProject> {
    super::project_setup::validate_locale(locale)?;
    if client_version == Some(0) {
      return Err(invalid("native client version must be positive"));
    }
    let normalized = normalize_answers(source, answers).map_err(invalid)?;
    let component = source
      .components
      .first()
      .ok_or_else(|| invalid("native Project component unavailable"))?;
    let AssistantNativeAction::CreateProject {
      template_id,
      inputs,
      scaffold,
    } = &component.action
    else {
      return Err(invalid("native Project component unavailable"));
    };
    let bound = |target| -> Option<AssistantValue> {
      let AssistantValueBinding::Input { input } = inputs.get(&target)? else {
        return None;
      };
      let value = normalized.get(input)?;
      let spec = source.inputs.iter().find(|value| value.id == *input)?;
      if let AssistantValue::Choice(id) = value {
        spec
          .choices
          .iter()
          .find(|choice| choice.id == *id)
          .map(|choice| choice.value.clone())
      } else {
        Some(value.clone())
      }
    };
    let scalar = |target| -> Option<String> {
      match bound(target) {
        Some(AssistantValue::Text(value) | AssistantValue::Choice(value)) => Some(value),
        _ => None,
      }
    };
    let supplied_title = scalar(AssistantInputTarget::Title).ok_or_else(|| invalid("Project title is required"))?;
    let title = self
      .definition
      .validate_database_creation(actor, workspace_id, &supplied_title)
      .await?;
    let default = if let Some(accepted) = accepted {
      DatabaseTemplateSelection {
        priority: accepted.priority,
        complexity: accepted.complexity,
        structure: accepted.structure,
      }
    } else {
      *self
        .templates
        .default_selection(template_id)
        .ok_or_else(|| invalid("native template unavailable"))?
    };
    let priority = match scalar(AssistantInputTarget::PriorityPreset) {
      None => default.priority,
      Some(value) => match value.as_str() {
        "threeStep" => DatabaseProjectOptionPreset::ThreeStep,
        "fiveStep" => DatabaseProjectOptionPreset::FiveStep,
        _ => return Err(invalid("unsupported priority preset")),
      },
    };
    let complexity = match scalar(AssistantInputTarget::ComplexityPreset) {
      None => default.complexity,
      Some(value) => match value.as_str() {
        "threeStep" => DatabaseProjectOptionPreset::ThreeStep,
        "fiveStep" => DatabaseProjectOptionPreset::FiveStep,
        _ => return Err(invalid("unsupported complexity preset")),
      },
    };
    let structure = match scalar(AssistantInputTarget::StructurePreset) {
      None => default.structure,
      Some(value) => value.parse().map_err(|_| invalid("unsupported Project structure"))?,
    };
    let selection = DatabaseTemplateSelection {
      priority,
      complexity,
      structure,
    };
    let template = if accepted.is_some() {
      self.templates.select_selection(template_id, selection)
    } else {
      self.templates.select_offering(template_id, selection)
    }
    .ok_or_else(|| invalid("native parameter tuple is unavailable"))?;
    let manifest = template.to_manifest().map_err(invalid)?;
    let initial_view_key = scalar(AssistantInputTarget::InitialView).unwrap_or_else(|| manifest.views[0].key.clone());
    let view = manifest
      .views
      .iter()
      .find(|view| view.key == initial_view_key)
      .ok_or_else(|| invalid("initial View is unavailable for this variant"))?;
    let currency = scalar(AssistantInputTarget::DefaultCurrency)
      .filter(|value| !value.trim().is_empty())
      .unwrap_or_else(|| {
        accepted
          .map(|plan| plan.default_currency.clone())
          .unwrap_or_else(|| self.default_currency.clone())
      });
    let currency =
      normalize_database_currency_code(&currency).ok_or_else(|| invalid("invalid native default currency"))?;
    let include_sample_rows = match bound(AssistantInputTarget::IncludeSamples) {
      Some(AssistantValue::Boolean(value)) => value,
      None => false,
      _ => return Err(invalid("invalid sample choice")),
    };
    // The receipt binds the destination; the native Organizer transaction
    // acknowledges placement only after its canonical update is durable.
    let folder = match bound(AssistantInputTarget::Folder) {
      Some(AssistantValue::Folder(id)) => Some(id),
      None => None,
      _ => return Err(invalid("invalid folder target")),
    };
    let (version, digest) = self
      .templates
      .current_source(template_id)
      .ok_or_else(|| invalid("current native source unavailable"))?;
    let description = scalar(AssistantInputTarget::Description).and_then(|value| {
      let value = value.trim().to_string();
      (!value.is_empty()).then_some(value)
    });
    let (setup, counts) = super::project_setup::prepare_setup(
      bound,
      scaffold,
      structure,
      if include_sample_rows {
        template.sample_rows.len()
      } else {
        0
      },
    )?;
    let description = if let Some(accepted) = accepted {
      // Accepted content is immutable even when a member is renamed or leaves.
      // Current membership is fenced separately at unfinished publication.
      accepted.description.clone()
    } else {
      super::project_setup::validate_people(self.workspace_store.as_ref(), workspace_id, &setup).await?;
      super::project_setup::compose_description(
        self.workspace_store.as_ref(),
        workspace_id,
        source,
        &setup,
        description,
        locale,
      )
      .await?
    };
    let (documents, selected_documents) = self
      .prepare_document_components(
        actor,
        workspace_id,
        identity,
        source,
        &normalized,
        locale,
        client_version,
        accepted.map(|plan| plan.documents.as_slice()).unwrap_or_default(),
        accepted
          .map(|plan| plan.document_metadata.as_slice())
          .unwrap_or_default(),
        &progress
          .map(|progress| progress.documents.keys().cloned().collect())
          .unwrap_or_default(),
      )
      .await?;
    if let (Some(folder), Some(documents)) = (&folder, &self.project_placement) {
      documents
        .preflight_project_placement(actor, workspace_id, folder)
        .await
        .map_err(document_error)?;
    }
    let selected_count = source.components.iter().filter(|component|
      matches!(&component.action, AssistantNativeAction::CreateDocument {selected:AssistantValueBinding::Input{input},..} if matches!(normalized.get(input),Some(AssistantValue::Boolean(true))))
    ).count();
    let execution_available = (!selected_documents || documents.len() == selected_count)
      && (folder.is_none() || self.project_placement.is_some());
    Ok(AssistantPreparedProject {
      document_metadata: Vec::new(),
      documents,
      client_version,
      locale: locale.into(),
      setup,
      counts,
      execution_available,
      workspace_id: Some(workspace_id),
      actor_id: actor,
      package: identity.clone(),
      component_id: component.id.clone(),
      template_id: template_id.clone(),
      template_version: version.into(),
      template_digest: digest.into(),
      answers: normalized,
      title,
      description,
      priority,
      complexity,
      structure,
      default_currency: currency,
      include_sample_rows,
      initial_view_key,
      initial_view_kind: view.view_kind,
      folder,
    })
  }
  pub(super) async fn prepare_document_components(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    identity: &AssistantPackageIdentity,
    source: &AssistantPackageSource,
    normalized: &BTreeMap<String, AssistantValue>,
    locale: &str,
    client_version: Option<u32>,
    previous_documents: &[AssistantPreparedDocumentComponent],
    metadata_documents: &[AssistantPreparedDocumentMetadata],
    created_components: &std::collections::BTreeSet<String>,
  ) -> DatabaseResult<(Vec<AssistantPreparedDocumentComponent>, bool)> {
    let bound = |binding: &AssistantValueBinding| {
      let AssistantValueBinding::Input { input } = binding else {
        return None;
      };
      normalized.get(input)
    };
    let mut result = Vec::new();
    let mut selected_any = false;
    for component in &source.components {
      let (AssistantNativeAction::CreateDocument {
        selected,
        folder,
        variables,
      }
      | AssistantNativeAction::CreateWorkingDocument {
        selected,
        folder,
        variables,
      }) = &component.action
      else {
        continue;
      };
      if !matches!(bound(selected), Some(AssistantValue::Boolean(true))) {
        continue;
      }
      selected_any = true;
      let Some(AssistantValue::Folder(folder)) = bound(folder) else {
        return Err(invalid(
          "selected document requires an explicit native folder destination",
        ));
      };
      let previous = previous_documents
        .iter()
        .find(|document| document.source.component_id == component.id);
      let metadata = metadata_documents
        .iter()
        .find(|document| document.source.component_id == component.id);
      if let Some(previous) = previous.filter(|_| created_components.contains(&component.id)) {
        result.push(previous.clone());
        continue;
      }
      let Some((documents, registry)) = self.project_placement.as_ref().zip(self.document_components.as_ref()) else {
        continue;
      };
      let client_version = client_version
        .filter(|version| *version > 0)
        .ok_or_else(|| invalid("selected document requires its native client version"))?;
      let active = self.packages.document_components(identity).iter().find(|(source, _)| {
        source.component_id == component.id && metadata.is_none_or(|metadata| source.digest == metadata.source.digest)
      });
      let (delivery, bytes) = match (previous, metadata, active) {
        (Some(previous), _, _) => (&previous.source, &[][..]),
        (None, Some(metadata), Some((_, bytes))) => (&metadata.source, bytes.as_ref()),
        (None, None, Some((source, bytes))) => (source, bytes.as_ref()),
        _ => return Err(invalid("document component delivery source unavailable")),
      };
      let mut values = BTreeMap::new();
      if previous.is_none() && metadata.is_none() {
        for (name, binding) in variables {
          let value = match bound(binding) {
            None => String::new(),
            Some(AssistantValue::Text(value)) => value.trim().to_string(),
            Some(AssistantValue::Date(value)) if value.end.is_none() => value.start.to_string(),
            Some(AssistantValue::Members(ids)) => {
              let members = if ids.is_empty() {
                Vec::new()
              } else {
                self
                  .workspace_store
                  .accepted_members_for_lookup(workspace)
                  .await
                  .map_err(|error| {
                    crate::database::DatabaseServiceError::from(myoxus_domain::repositories::RepositoryError::Storage(
                      error.to_string(),
                    ))
                  })?
              };
              ids
                .iter()
                .map(|id| {
                  members
                    .iter()
                    .find(|member| member.user_id == *id)
                    .filter(|member| !member.display_name.trim().is_empty())
                    .map(|member| member.display_name.clone())
                    .ok_or_else(|| invalid("selected Project member is unavailable"))
                })
                .collect::<DatabaseResult<Vec<_>>>()?
                .join(", ")
            }
            _ => return Err(invalid("unsupported native Project document variable value")),
          };
          // The native document scalar bound applies only to selected document
          // effects; ordinary Project descriptions retain their own larger limit.
          if value.len() > 8192 {
            return Err(invalid("Project document scalar exceeds native input bound"));
          }
          values.insert(name.clone(), value);
        }
      }
      if let Some(previous) = previous {
        values = previous.variables.clone();
      } else if let Some(metadata) = metadata {
        values = metadata.variables.clone();
      }
      let prepared = documents
        .preflight_registry_component(
          registry,
          actor,
          workspace,
          delivery,
          bytes,
          folder,
          locale,
          client_version,
          &values,
          previous,
          metadata,
          None,
        )
        .await
        .map_err(|error| match error {
          crate::document_template::DocumentTemplateError::Repository(error) => {
            crate::database::DatabaseServiceError::from(error)
          }
          crate::document_template::DocumentTemplateError::Forbidden => {
            let mut error = invalid("document component permission denied");
            error.code = crate::database::ERR_FORBIDDEN;
            error
          }
          _ => invalid("native document component source or destination unavailable"),
        })?;
      result.push(AssistantPreparedDocumentComponent {
        source: delivery.clone(),
        source_revision_id: prepared.source_revision_id,
        source_content_digest: prepared.source_content_digest,
        source_revision_digest: prepared.source_revision_digest,
        locale: prepared.locale,
        title: previous
          .map(|document| document.title.clone())
          .unwrap_or(prepared.title),
        variables: values,
        folder: folder.clone(),
      });
    }
    Ok((result, selected_any))
  }
  pub(crate) fn accepted_project_descriptor(
    &self,
    accepted: &crate::workspace::AcceptedProjectStarter,
  ) -> Option<AssistantPackageDescriptor> {
    let mut descriptor = self.packages.accepted_descriptor(&accepted.plan.package).ok()?;
    descriptor.document_components = accepted
      .plan
      .documents
      .iter()
      .map(|document| document.source.clone())
      .chain(
        accepted
          .plan
          .document_metadata
          .iter()
          .map(|document| document.source.clone()),
      )
      .collect();
    Some(descriptor)
  }
  pub(crate) async fn project_document_views(
    &self,
    accepted: &crate::workspace::AcceptedProjectStarter,
  ) -> DatabaseResult<Vec<crate::workspace::ProjectStarterDocumentView>> {
    let mut result = Vec::new();
    for ids in &accepted.ids.documents {
      let created = accepted.progress.documents.get(&ids.component_id);
      let external_id = match (created, &self.project_placement) {
        (Some(created), Some(documents)) => match documents
          .readable_project_result(accepted.actor_id, accepted.workspace_id, created)
          .await
        {
          Ok(()) => Some(created.external_id.clone()),
          Err(crate::document_template::DocumentTemplateError::Repository(error)) => {
            return Err(crate::database::DatabaseServiceError::from(error));
          }
          Err(
            crate::document_template::DocumentTemplateError::Content
            | crate::document_template::DocumentTemplateError::MutationUnavailable,
          ) => {
            return Err(crate::database::DatabaseServiceError::from(
              myoxus_domain::repositories::RepositoryError::Storage("Project document readback unavailable".into()),
            ));
          }
          Err(_) => None,
        },
        _ => None,
      };
      result.push(crate::workspace::ProjectStarterDocumentView {
        component_id: ids.component_id.clone(),
        reserved_document_id: ids.doc_id,
        external_id,
        created: created.is_some(),
        placed: created.is_some_and(|created| created.placed),
      });
    }
    Ok(result)
  }
  pub(crate) async fn project_installation(
    &self,
    accepted: &crate::workspace::AcceptedProjectStarter,
  ) -> crate::workspace::ProjectStarterResult<DatabaseManagedSchemaInstallation> {
    let record = self.read_project_result(accepted).await?;
    if record.database.deleted_at.is_some()
      || !record
        .managed_schema
        .as_ref()
        .is_some_and(|schema| schema.readiness == DatabaseManagedSchemaReadiness::Ready)
    {
      return Err(invalid("current Project managed schema is unavailable").into());
    }
    record
      .database
      .managed_installation
      .ok_or_else(|| invalid("Project managed installation missing").into())
  }
  pub(crate) async fn create_project_document(
    &self,
    accepted: &crate::workspace::AcceptedProjectStarter,
    component: &str,
  ) -> crate::workspace::ProjectStarterResult<()> {
    let (documents, registry) = self
      .project_placement
      .as_ref()
      .zip(self.document_components.as_ref())
      .ok_or_else(|| invalid("native document capability unavailable"))?;
    let source = accepted
      .plan
      .documents
      .iter()
      .find(|document| document.source.component_id == component)
      .ok_or_else(|| invalid("accepted document source missing"))?;
    let installation = self.project_installation(accepted).await?;
    documents
      .create_accepted_component(registry, accepted, source, installation)
      .await
      .map_err(document_error)?;
    Ok(())
  }
  pub(crate) async fn place_project_stage(
    &self,
    accepted: &crate::workspace::AcceptedProjectStarter,
    stage: crate::workspace::ProjectPlacementStage,
  ) -> crate::workspace::ProjectStarterResult<()> {
    let documents = self
      .project_placement
      .as_ref()
      .ok_or_else(|| invalid("native placement capability unavailable"))?;
    let installation = self.project_installation(accepted).await?;
    documents
      .place_accepted_project(accepted, installation, stage)
      .await
      .map_err(document_error)?;
    Ok(())
  }
  pub(crate) fn project_admission(
    &self,
    plan: &AssistantPreparedProject,
  ) -> DatabaseResult<crate::workspace::ProjectStarterAdmission> {
    review_project_admission(&self.templates, plan)
  }
  pub(crate) async fn read_project_result(
    &self,
    accepted: &crate::workspace::AcceptedProjectStarter,
  ) -> crate::workspace::ProjectStarterResult<DatabaseRecord> {
    match self
      .definition
      .get_database_for_lifecycle(accepted.actor_id, accepted.ids.database_id)
      .await
    {
      Ok(record) if record.database.workspace_id == accepted.workspace_id => Ok(record),
      Ok(_) => Err(crate::workspace::ProjectStarterError::Conflict),
      Err(error) if error.code == crate::database::ERR_NOT_FOUND => Err(crate::workspace::ProjectStarterError::Gone {
        database_id: accepted.ids.database_id,
      }),
      Err(error) => Err(error.into()),
    }
  }
  pub(crate) async fn materialize_accepted_project(
    &self,
    accepted: &crate::workspace::AcceptedProjectStarter,
    review: &AssistantPreparedProject,
  ) -> DatabaseResult<DatabaseInitialState> {
    self.definition.materialize_accepted_project(accepted, review).await
  }
  #[tracing::instrument(skip_all)]
  pub async fn apply_project(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    confirmed: AssistantPreparedProject,
  ) -> DatabaseResult<AssistantAppliedProject> {
    let current = self
      .prepare_project(
        actor,
        workspace_id,
        &confirmed.package,
        confirmed.answers.clone(),
        &confirmed.locale,
        confirmed.client_version,
      )
      .await?;
    if plan_digest(&current) != plan_digest(&confirmed) {
      return Err(invalid("reviewed native plan changed; prepare again"));
    }
    // Read-only setup facts cannot be silently dropped by the existing single-
    // Database adapter. WTA10 must own their actual native execution first.
    if !current.execution_available
      || current.folder.is_some()
      || !current.documents.is_empty()
      || !super::project_setup::execution_available(&current.setup)
    {
      return Err(invalid("reviewed Project setup requires its accepted request"));
    }
    let record = self
      .definition
      .create_database_from_template(
        actor,
        CreateDatabaseFromTemplate {
          workspace_id,
          template_id: current.template_id,
          title: current.title,
          description: current.description,
          include_sample_rows: current.include_sample_rows,
          priority_preset: current.priority,
          complexity_preset: current.complexity,
          structure_preset: current.structure,
          default_currency: current.default_currency,
        },
      )
      .await?;
    let initial_view_id = record
      .database
      .managed_installation
      .as_ref()
      .and_then(|installation| installation.view_bindings.get(&current.initial_view_key))
      .copied()
      .ok_or_else(|| invalid("created native initial View unavailable"))?;
    Ok(AssistantAppliedProject {
      record,
      initial_view_id,
    })
  }
}

pub(super) fn prepare_workspace_source(
  source: &AssistantPackageSource,
  identity: &AssistantPackageIdentity,
  answers: BTreeMap<String, AssistantValue>,
) -> Result<PreparedWorkspaceAssistant, String> {
  if source.contexts != [AssistantPackageContext::WorkspaceCreation] {
    return Err("package is not a Workspace creation capability".into());
  }
  let normalized = normalize_answers(source, answers)?;
  let Some(AssistantNativeAction::CreateWorkspace { inputs }) =
    source.components.first().map(|component| &component.action)
  else {
    return Err("native Workspace allocation component unavailable".into());
  };
  let scalar = |target| -> Result<String, String> {
    let Some(AssistantValueBinding::Input { input }) = inputs.get(&target) else {
      return Err("native Workspace input unavailable".into());
    };
    let spec = source
      .inputs
      .iter()
      .find(|spec| spec.id == *input)
      .ok_or("native Workspace input unavailable")?;
    match normalized.get(input) {
      Some(AssistantValue::Text(value)) => Ok(value.clone()),
      Some(AssistantValue::Choice(id)) => match &spec
        .choices
        .iter()
        .find(|choice| choice.id == *id)
        .ok_or("Workspace choice unavailable")?
        .value
      {
        AssistantValue::Text(value) | AssistantValue::Choice(value) => Ok(value.clone()),
        _ => Err("unsupported Workspace choice".into()),
      },
      _ => Err("native Workspace value required".into()),
    }
  };
  Ok(PreparedWorkspaceAssistant {
    setup: None,
    project: None,
    package: identity.clone(),
    name: WorkspaceName::parse(&scalar(AssistantInputTarget::WorkspaceName)?)
      .map_err(|error| error.to_string())?
      .display()
      .to_string(),
    initial_content: serde_json::from_value(serde_json::Value::String(scalar(AssistantInputTarget::InitialContent)?))
      .map_err(|_| "unsupported Workspace content")?,
    assistance_mode: serde_json::from_value(serde_json::Value::String(scalar(AssistantInputTarget::AssistanceMode)?))
      .map_err(|_| "unsupported assistance mode")?,
    answers: normalized,
  })
}

pub fn plan_digest(plan: &AssistantPreparedProject) -> String {
  format!(
    "{:x}",
    Sha256::digest(serde_json::to_vec(plan).expect("typed prepared plan serializes"))
  )
}
fn same_value(left: &AssistantValue, right: &AssistantValue) -> bool {
  serde_json::to_value(left).expect("typed value serializes")
    == serde_json::to_value(right).expect("typed value serializes")
}
pub(super) fn visible(rule: &Option<AssistantVisibility>, values: &BTreeMap<String, AssistantValue>) -> bool {
  match rule {
    None => true,
    Some(AssistantVisibility::Present { input }) => values.get(input).is_some_and(|value| match value {
      AssistantValue::Text(text) => !text.trim().is_empty(),
      _ => true,
    }),
    Some(AssistantVisibility::Equals { input, value }) => {
      values.get(input).is_some_and(|actual| same_value(actual, value))
    }
  }
}

pub(super) fn normalize_answers(
  source: &AssistantPackageSource,
  answers: BTreeMap<String, AssistantValue>,
) -> Result<BTreeMap<String, AssistantValue>, String> {
  if answers.len() > 128
    || answers
      .keys()
      .any(|id| !source.inputs.iter().any(|input| input.id == *id))
  {
    return Err("unknown or unbounded package answers".into());
  }
  let mut values = BTreeMap::new();
  for input in &source.inputs {
    let placed_visible = source
      .presentation
      .steps
      .iter()
      .flat_map(|step| &step.groups)
      .chain(source.presentation.dialogs.iter().flat_map(|dialog| &dialog.groups))
      .any(|group| {
        visible(&group.visible_when, &values)
          && group
            .controls
            .iter()
            .any(|control| control_targets_input(control, input))
      });
    // A hidden placement cannot inject either a submitted value or a default.
    // Admission orders group dependencies before their affected inputs.
    if !visible(&input.visible_when, &values) || !placed_visible {
      continue;
    }
    if let Some(value) = answers.get(&input.id).or(input.default.as_ref()) {
      validate_value(input, value)?;
      let value = match value {
        AssistantValue::Text(value) => AssistantValue::Text(value.trim().into()),
        other => other.clone(),
      };
      // Required collections represent an actual selection. This is separate
      // from Present, where an explicitly supplied empty collection is answered.
      let empty_required = match &value {
        AssistantValue::Text(value) => value.is_empty(),
        AssistantValue::Members(values) => values.is_empty(),
        AssistantValue::Choices(values) => values.is_empty(),
        _ => false,
      };
      if input.required && empty_required {
        return Err(format!("input {} is required", input.id));
      }
      values.insert(input.id.clone(), value);
    } else if input.required {
      return Err(format!("input {} is required", input.id));
    }
  }
  Ok(values)
}

fn document_error(error: crate::document_template::DocumentTemplateError) -> crate::database::DatabaseServiceError {
  use crate::document_template::DocumentTemplateError;
  match error {
    DocumentTemplateError::Repository(error) => error.into(),
    DocumentTemplateError::Forbidden => {
      let mut error = invalid("native document permission denied");
      error.code = crate::database::ERR_FORBIDDEN;
      error
    }
    DocumentTemplateError::Content => {
      myoxus_domain::repositories::RepositoryError::Storage("native document content read unavailable".into()).into()
    }
    _ => invalid("native document source, destination or publication unavailable"),
  }
}

/// The same executable-effects review is consumed by receipt allocation and
/// existing-workspace application. It performs no persistence or discovery.
pub fn review_project_admission(
  templates: &crate::database::DatabaseStarterTemplateCatalog,
  plan: &AssistantPreparedProject,
) -> DatabaseResult<crate::workspace::ProjectStarterAdmission> {
  let variant = DatabaseTemplateSelection {
    priority: plan.priority,
    complexity: plan.complexity,
    structure: plan.structure,
  };
  let mut spec = templates
    .select_selection(&plan.template_id, variant)
    .ok_or_else(|| invalid("current native Project definition unavailable"))?
    .clone();
  let variant = DatabaseTemplateSelection {
    priority: spec.priority_preset.unwrap_or(plan.priority),
    complexity: spec.complexity_preset.unwrap_or(plan.complexity),
    structure: spec.default_structure.unwrap_or(plan.structure),
  };
  // Compare executable content and canonical copy, not whether a retained
  // source used redundant manifest assertions versus authored metadata.
  let mut manifest = spec.to_manifest().map_err(invalid)?;
  spec.manifest = None;
  spec.metadata = None;
  if !plan.include_sample_rows {
    spec.sample_rows.clear();
    manifest.sample_rows.clear();
  }
  let sources = plan
    .documents
    .iter()
    .map(|document| {
      (
        &document.source,
        document.source_revision_id,
        &document.source_revision_digest,
        &document.locale,
        &document.variables,
        &document.folder,
      )
    })
    .chain(plan.document_metadata.iter().map(|document| {
      (
        &document.source,
        document.source_revision_id,
        &document.source_revision_digest,
        &document.locale,
        &document.variables,
        &document.folder,
      )
    }))
    .collect::<Vec<_>>();
  let effects_digest = format!(
    "{:x}",
    Sha256::digest(
      serde_json::to_vec(&(
        &spec,
        &manifest,
        &plan.title,
        &plan.description,
        &plan.setup,
        &plan.counts,
        &plan.default_currency,
        &plan.initial_view_key,
        &plan.locale,
        &sources,
        &plan.folder
      ))
      .expect("native reviewed effects")
    )
  );
  Ok(crate::workspace::ProjectStarterAdmission {
    template_id: plan.template_id.clone(),
    version: plan.template_version.clone(),
    digest: plan.template_digest.clone(),
    variant,
    effects_digest,
  })
}
