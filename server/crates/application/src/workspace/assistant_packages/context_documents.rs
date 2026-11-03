// SPDX-License-Identifier: AGPL-3.0-or-later
//! Readonly preparation for explicit actions against an existing Task container.
use super::preparation::normalize_answers;
use super::validation::invalid;
use super::*;
use crate::auth::{AuthService, EffectiveAssistance};
use crate::database::{DatabaseResult, DatabaseServiceError};
use crate::workspace::*;
use myoxus_domain::{assistant_package::*, database::*, ids::*, repositories::RepositoryError};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct ContextDocumentContext {
  pub container_title: String,
  pub task_title: Option<String>,
}
fn context_permission_error(message: &str) -> DatabaseServiceError {
  let mut error = invalid(message);
  error.code = crate::database::ERR_FORBIDDEN;
  error
}

pub fn context_documents_digest(plan: &AssistantPreparedContextDocuments) -> String {
  format!(
    "{:x}",
    Sha256::digest(serde_json::to_vec(&(plan.actor_id, plan)).expect("typed contextual review"))
  )
}
pub fn context_documents_admission(plan: &AssistantPreparedContextDocuments) -> ContextDocumentAdmission {
  // The existing container has no creation effects. A metadata-only managed
  // upgrade changes its write fence, never the original document fingerprint.
  let effects_digest = format!(
    "{:x}",
    Sha256::digest(serde_json::to_vec(&(&plan.target, &plan.documents, &plan.folder)).expect("typed document effects"))
  );
  ContextDocumentAdmission {
    installation: plan.installation.clone(),
    effects_digest,
  }
}
impl AssistantPackageService {
  pub async fn metadata_review_target(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
  ) -> DatabaseResult<ContextDocumentTarget> {
    let destination = self
      .views
      .task_destinations(actor, workspace, 1, None)
      .await?
      .default_destination
      .ok_or_else(|| invalid("Workspace Tasks destination unavailable"))?;
    let target = ContextDocumentTarget {
      database_id: destination.database_id,
      task_id: None,
    };
    self.context_document_context(actor, workspace, &target).await?;
    Ok(target)
  }
  pub async fn context_document_context(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: &ContextDocumentTarget,
  ) -> DatabaseResult<(ContextDocumentContext, DatabaseManagedSchemaInstallation, bool)> {
    let record = self.definition.get_database(actor, target.database_id).await?;
    if record.database.workspace_id != workspace
      || record.database.deleted_at.is_some()
      || record.database.profile_kind != DatabaseProfileKind::Project
      || !record
        .managed_schema
        .as_ref()
        .is_some_and(|schema| schema.readiness == DatabaseManagedSchemaReadiness::Ready)
    {
      return Err(invalid("contextual action requires a current ready Task container"));
    }
    let task_title = if let Some(id) = target.task_id {
      let row = self
        .views
        .get_row_for_read(actor, target.database_id, id, false)
        .await?
        .ok_or_else(|| invalid("context Task unavailable"))?;
      if row.row.database_id != target.database_id || row.row.row_kind != DatabaseRowKind::Task {
        return Err(invalid("context requires an actual Task in this container"));
      }
      Some(row.row.title)
    } else {
      None
    };
    let installation = record
      .database
      .managed_installation
      .ok_or_else(|| invalid("native managed installation unavailable"))?;
    Ok((
      ContextDocumentContext {
        container_title: record.database.title,
        task_title,
      },
      installation,
      record.database.system_role.is_none(),
    ))
  }
  #[tracing::instrument(skip_all)]
  pub async fn prepare_context_documents(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    identity: &AssistantPackageIdentity,
    answers: BTreeMap<String, AssistantValue>,
    locale: &str,
    client_version: u32,
    auth: &AuthService,
  ) -> DatabaseResult<PreparedContextDocuments> {
    let (context, _, ordinary) = self.context_document_context(actor, workspace, &target).await?;
    let assistance = self
      .context_assistance(actor, workspace, &target, ordinary, auth)
      .await?;
    let source = self
      .packages
      .offered_source(identity, AssistantPackageContext::TaskContainerAssistance)
      .map_err(invalid)?;
    let plan = self
      .prepare_context_document_source(
        actor,
        workspace,
        target,
        identity,
        answers,
        locale,
        client_version,
        source,
        None,
      )
      .await?;
    Ok(PreparedContextDocuments {
      plan_digest: context_documents_digest(&plan),
      plan,
      assistance,
      context,
    })
  }
  pub(crate) async fn context_assistance(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: &ContextDocumentTarget,
    ordinary: bool,
    auth: &AuthService,
  ) -> DatabaseResult<EffectiveAssistance> {
    auth
      .get_assistance(actor, Some(workspace), ordinary.then_some(target.database_id))
      .await
      .map_err(|error| match error {
        crate::auth::AuthError::Storage(message) => DatabaseServiceError::from(RepositoryError::Storage(message)),
        _ => invalid("context assistance unavailable"),
      })
  }
  pub(crate) async fn prepare_accepted_context_documents(
    &self,
    accepted: &AcceptedContextDocuments,
  ) -> DatabaseResult<AssistantPreparedContextDocuments> {
    // Frozen names are content, not continuing membership authority. Recheck
    // the original selected IDs before remaining effects without rebinding text.
    if accepted.state == ProjectStarterState::Accepted {
      for person in accepted.document_receipt().people {
        let present = self
          .workspace_store
          .has_accepted_member(accepted.workspace_id, person)
          .await
          .map_err(|error| match error {
            crate::auth::AuthError::Storage(message) => DatabaseServiceError::from(RepositoryError::Storage(message)),
            _ => context_permission_error("selected member authority unavailable"),
          })?;
        if !present {
          return Err(context_permission_error(
            "selected person is no longer an accepted member",
          ));
        }
      }
    }
    let source = self.packages.inventory().get(&accepted.plan.package).map_err(invalid)?;
    self
      .prepare_context_document_source(
        accepted.actor_id,
        accepted.workspace_id,
        accepted.plan.target.clone(),
        &accepted.plan.package,
        accepted.plan.answers.clone(),
        &accepted.plan.locale,
        accepted.plan.client_version,
        source,
        Some(accepted),
      )
      .await
  }
  async fn prepare_context_document_source(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    identity: &AssistantPackageIdentity,
    answers: BTreeMap<String, AssistantValue>,
    locale: &str,
    client_version: u32,
    source: &AssistantPackageSource,
    accepted: Option<&AcceptedContextDocuments>,
  ) -> DatabaseResult<AssistantPreparedContextDocuments> {
    if !matches!(locale, "en" | "de" | "fr" | "es") || client_version == 0 {
      return Err(invalid(
        "contextual preparation requires a supported locale and positive client version",
      ));
    }
    let (_, installation, _) = self.context_document_context(actor, workspace, &target).await?;
    let answers = normalize_answers(source, answers).map_err(invalid)?;
    let bound = |binding: &AssistantValueBinding| match binding {
      AssistantValueBinding::Input { input } => answers.get(input),
      _ => None,
    };
    let (documents, registry) = self
      .project_placement
      .as_ref()
      .zip(self.document_components.as_ref())
      .ok_or_else(|| invalid("native document capability unavailable"))?;
    let mut prepared = Vec::new();
    let mut destination = None;
    for component in &source.components {
      let AssistantNativeAction::CreateDocument {
        selected,
        folder,
        variables,
      } = &component.action
      else {
        return Err(invalid("unsupported contextual component"));
      };
      if !matches!(bound(selected), Some(AssistantValue::Boolean(true))) {
        continue;
      }
      let Some(AssistantValue::Folder(folder)) = bound(folder) else {
        return Err(invalid("selected document requires an explicit folder"));
      };
      if destination.as_ref().is_some_and(|old| old != folder) {
        return Err(invalid("contextual documents require the same reviewed destination"));
      }
      destination = Some(folder.clone());
      let previous = accepted.and_then(|receipt| {
        receipt
          .plan
          .documents
          .iter()
          .find(|doc| doc.source.component_id == component.id)
      });
      if let Some(previous) =
        previous.filter(|_| accepted.is_some_and(|receipt| receipt.progress.documents.contains_key(&component.id)))
      {
        prepared.push(previous.clone());
        continue;
      }
      let delivery = self
        .packages
        .document_components(identity)
        .iter()
        .find(|(source, _)| source.component_id == component.id);
      let (pin, bytes) = match (previous, delivery) {
        (Some(old), _) => (&old.source, &[][..]),
        (None, Some((source, bytes))) => (source, bytes.as_ref()),
        _ => return Err(invalid("document source unavailable")),
      };
      let mut values = BTreeMap::new();
      if let Some(old) = previous {
        values = old.variables.clone()
      } else {
        for (key, binding) in variables {
          if key.starts_with("context.") {
            continue;
          }
          let value = match bound(binding) {
            None => String::new(),
            Some(AssistantValue::Text(value)) => value.clone(),
            Some(AssistantValue::Date(date)) if date.end.is_none() => date.start.to_string(),
            Some(AssistantValue::Members(ids)) => {
              let members = self
                .workspace_store
                .accepted_members_for_lookup(workspace)
                .await
                .map_err(|error| match error {
                  crate::auth::AuthError::Storage(message) => {
                    DatabaseServiceError::from(RepositoryError::Storage(message))
                  }
                  _ => invalid("selected people unavailable"),
                })?;
              ids
                .iter()
                .map(|id| {
                  members
                    .iter()
                    .find(|member| member.user_id == *id)
                    .filter(|member| !member.display_name.trim().is_empty())
                    .map(|member| member.display_name.clone())
                    .ok_or_else(|| invalid("selected person is not an accepted member"))
                })
                .collect::<DatabaseResult<Vec<_>>>()?
                .join(", ")
            }
            _ => return Err(invalid("unsupported contextual explicit value")),
          };
          if value.len() > 8192 {
            return Err(invalid("context document scalar exceeds native bound"));
          }
          values.insert(key.clone(), value);
        }
      }
      let captured = documents
        .preflight_registry_component(
          registry,
          actor,
          workspace,
          pin,
          bytes,
          folder,
          locale,
          client_version,
          &values,
          previous,
          None,
          Some(yjs::NativeTemplateReferenceTargets {
            workspace_id: workspace,
            database_id: target.database_id,
            task_id: target.task_id,
          }),
        )
        .await
        .map_err(|error| match error {
          crate::document_template::DocumentTemplateError::Repository(error) => DatabaseServiceError::from(error),
          crate::document_template::DocumentTemplateError::Forbidden => {
            context_permission_error("native document permission unavailable")
          }
          crate::document_template::DocumentTemplateError::Content
          | crate::document_template::DocumentTemplateError::MutationUnavailable => DatabaseServiceError::from(
            RepositoryError::Storage("native document preparation or mutation unavailable".into()),
          ),
          _ => invalid("context document source or destination unavailable"),
        })?;
      prepared.push(AssistantPreparedDocumentComponent {
        source: pin.clone(),
        source_revision_id: captured.source_revision_id,
        source_content_digest: captured.source_content_digest,
        source_revision_digest: captured.source_revision_digest,
        locale: captured.locale,
        title: previous.map(|old| old.title.clone()).unwrap_or(captured.title),
        variables: values,
        folder: folder.clone(),
      });
    }
    if prepared.is_empty() {
      return Err(invalid("select at least one native document"));
    }
    let workflow = match accepted {
      Some(accepted) => accepted.plan.workflow.clone(),
      None => self.packages.workflow(identity).map_err(invalid)?,
    }
    .ok_or_else(|| invalid("native contextual workflow unavailable"))?;
    Ok(AssistantPreparedContextDocuments {
      workflow: Some(workflow),
      actor_id: actor,
      workspace_id: workspace,
      target,
      package: identity.clone(),
      answers,
      locale: locale.into(),
      client_version,
      documents: prepared,
      folder: destination.ok_or_else(|| invalid("document destination unavailable"))?,
      installation,
      execution_available: self.context_workflows_enabled,
    })
  }
  pub(crate) fn context_descriptor(&self, accepted: &AcceptedContextDocuments) -> Option<AssistantPackageDescriptor> {
    self.packages.accepted_descriptor(&accepted.plan.package).ok()
  }
}
impl AssistantPackageService {
  pub(crate) async fn create_context_document(
    &self,
    accepted: &AcceptedContextDocuments,
    component: &str,
    automation_effect: Option<myoxus_domain::workspace_automation::AutomationEffectFence>,
  ) -> DatabaseResult<()> {
    self
      .context_document_context(accepted.actor_id, accepted.workspace_id, &accepted.plan.target)
      .await?;
    let document = accepted
      .plan
      .documents
      .iter()
      .find(|doc| doc.source.component_id == component)
      .ok_or_else(|| invalid("accepted document unavailable"))?;
    let (native, registry) = self
      .project_placement
      .as_ref()
      .zip(self.document_components.as_ref())
      .ok_or_else(|| invalid("native document capability unavailable"))?;
    native
      .create_context_component(registry, accepted, document, automation_effect)
      .await
      .map_err(|error| match error {
        crate::document_template::DocumentTemplateError::Repository(error) => DatabaseServiceError::from(error),
        crate::document_template::DocumentTemplateError::Forbidden => {
          context_permission_error("native document permission unavailable")
        }
        crate::document_template::DocumentTemplateError::Content
        | crate::document_template::DocumentTemplateError::MutationUnavailable => DatabaseServiceError::from(
          RepositoryError::Storage("native document preparation or mutation unavailable".into()),
        ),
        _ => invalid("native document publication unavailable"),
      })
  }
  pub(crate) async fn place_context_stage(
    &self,
    accepted: &AcceptedContextDocuments,
    stage: ProjectPlacementStage,
    automation_effect: Option<myoxus_domain::workspace_automation::AutomationEffectFence>,
  ) -> DatabaseResult<()> {
    self
      .context_document_context(accepted.actor_id, accepted.workspace_id, &accepted.plan.target)
      .await?;
    self
      .project_placement
      .as_ref()
      .ok_or_else(|| invalid("native placement unavailable"))?
      .place_context_documents(accepted, stage, automation_effect)
      .await
      .map_err(|error| match error {
        crate::document_template::DocumentTemplateError::Repository(error) => DatabaseServiceError::from(error),
        crate::document_template::DocumentTemplateError::Forbidden => {
          context_permission_error("native document permission unavailable")
        }
        crate::document_template::DocumentTemplateError::Content
        | crate::document_template::DocumentTemplateError::MutationUnavailable => DatabaseServiceError::from(
          RepositoryError::Storage("native document preparation or mutation unavailable".into()),
        ),
        _ => invalid("native document placement unavailable"),
      })
  }
  pub(crate) async fn context_document_views(
    &self,
    accepted: &AcceptedContextDocuments,
  ) -> DatabaseResult<Vec<ProjectStarterDocumentView>> {
    let mut documents = Vec::new();
    for ids in &accepted.ids.documents {
      let created = accepted.progress.documents.get(&ids.component_id);
      let external_id = match (created, self.project_placement.as_ref()) {
        (Some(created), Some(native)) => match native
          .readable_project_result(accepted.actor_id, accepted.workspace_id, created)
          .await
        {
          Ok(()) => Some(created.external_id.clone()),
          Err(crate::document_template::DocumentTemplateError::Repository(error)) => {
            return Err(DatabaseServiceError::from(error));
          }
          Err(
            crate::document_template::DocumentTemplateError::Content
            | crate::document_template::DocumentTemplateError::MutationUnavailable,
          ) => {
            return Err(DatabaseServiceError::from(
              myoxus_domain::repositories::RepositoryError::Storage("native document readback unavailable".into()),
            ));
          }
          Err(_) => None,
        },
        _ => None,
      };
      documents.push(ProjectStarterDocumentView {
        component_id: ids.component_id.clone(),
        reserved_document_id: ids.doc_id,
        external_id,
        created: created.is_some(),
        placed: created.is_some_and(|result| result.placed),
      });
    }
    Ok(documents)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn reviewed_plan() -> AssistantPreparedContextDocuments {
    AssistantPreparedContextDocuments {
      workflow: None,
      actor_id: uuid::Uuid::new_v4(),
      workspace_id: uuid::Uuid::new_v4(),
      target: ContextDocumentTarget {
        database_id: uuid::Uuid::new_v4(),
        task_id: None,
      },
      package: AssistantPackageIdentity {
        id: "context.fixture".into(),
        version: "1.0.0".into(),
        digest: "a".repeat(64),
      },
      answers: BTreeMap::new(),
      locale: "en".into(),
      client_version: 1,
      documents: vec![AssistantPreparedDocumentComponent {
        source: AssistantDocumentComponentSource {
          component_id: "document".into(),
          template_id: "agenda".into(),
          version: "1.0.0".into(),
          digest: "b".repeat(64),
          bundle: myoxus_domain::feature_bundle::FeatureBundlePin {
            id: "base".into(),
            version: "1.0.0".into(),
            sha256: "c".repeat(64),
          },
        },
        source_revision_id: uuid::Uuid::new_v4(),
        source_content_digest: "d".repeat(64),
        source_revision_digest: "e".repeat(64),
        locale: "en".into(),
        title: "Meeting".into(),
        variables: BTreeMap::new(),
        folder: AssistantFolderDestination::New {
          name: "Meeting".into(),
          parent: None,
        },
      }],
      folder: AssistantFolderDestination::New {
        name: "Meeting".into(),
        parent: None,
      },
      installation: DatabaseManagedSchemaInstallation {
        template_id: "tasks".into(),
        template_version: "1.0.0".into(),
        template_digest: "f".repeat(64),
        variant: DatabaseManagedSchemaVariant {
          priority: DatabaseProjectOptionPreset::ThreeStep,
          complexity: DatabaseProjectOptionPreset::ThreeStep,
          structure: DatabaseProjectStructurePreset::TasksOnly,
          currency: "EUR".into(),
        },
        schema_revision: 1,
        field_bindings: BTreeMap::new(),
        view_bindings: BTreeMap::new(),
        readiness: DatabaseManagedSchemaReadiness::Ready,
        reason_code: None,
      },
      execution_available: true,
    }
  }

  #[test]
  fn context_document_review_binds_actor_target_and_effects_without_metadata_only_rereview() {
    let original = reviewed_plan();
    let original_effects = context_documents_admission(&original).effects_digest;
    let digest = context_documents_digest(&original);
    let mut upgraded = original.clone();
    upgraded.installation.template_version = "1.0.1".into();
    upgraded.installation.template_digest = "1".repeat(64);
    upgraded.installation.schema_revision += 1;
    assert_eq!(context_documents_admission(&upgraded).effects_digest, original_effects);
    assert_ne!(context_documents_digest(&upgraded), digest);
    let mut changed_actor = original.clone();
    changed_actor.actor_id = uuid::Uuid::new_v4();
    assert_ne!(context_documents_digest(&changed_actor), digest);
    let mut changed_task = original.clone();
    changed_task.target.task_id = Some(uuid::Uuid::new_v4());
    assert_ne!(
      context_documents_admission(&changed_task).effects_digest,
      original_effects
    );
    let mut changed_content = original.clone();
    changed_content.documents[0]
      .variables
      .insert("preparation.title".into(), "Changed".into());
    assert_ne!(
      context_documents_admission(&changed_content).effects_digest,
      original_effects
    );
    let input = ContextDocumentStarterInput {
      request_id: uuid::Uuid::new_v4(),
      package: original.package.clone(),
      answers: original.answers.clone(),
      locale: original.locale.clone(),
      client_version: original.client_version,
      plan_digest: digest,
      admission_confirmation: None,
    };
    assert_ne!(
      input.fingerprint(original.workspace_id, &original.target),
      input.fingerprint(original.workspace_id, &changed_task.target)
    );
  }
}

impl AssistantPackageService {
  /// Resolve one authored review form. Native document loading and revision
  /// capture remain with DocService; this never allocates a Task or a Run.
  pub(crate) async fn prepare_document_review(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    identity: &AssistantPackageIdentity,
    answers: BTreeMap<String, AssistantValue>,
    locale: &str,
    client_version: u32,
    documents: &crate::doc::DocService,
    permission: &crate::permission::PermissionService,
  ) -> DatabaseResult<myoxus_domain::workspace_automation::PreparedDocumentReview> {
    if !matches!(locale, "en" | "de" | "fr" | "es") || client_version == 0 {
      return Err(invalid(
        "review requires a supported locale and positive client version",
      ));
    }
    self.context_document_context(actor, workspace, &target).await?;
    let source = self
      .packages
      .offered_source(identity, AssistantPackageContext::TaskContainerAssistance)
      .map_err(invalid)?;
    let mut primaries = source
      .components
      .iter()
      .filter_map(|component| match &component.action {
        AssistantNativeAction::RequestDocumentReview { inputs } => Some(inputs),
        _ => None,
      });
    let inputs = primaries
      .next()
      .ok_or_else(|| invalid("review primary action unavailable"))?;
    if primaries.next().is_some() {
      return Err(invalid("review requires exactly one native primary action"));
    }
    let mut answers = normalize_answers(source, answers).map_err(invalid)?;
    let value = |target| {
      inputs.get(&target).and_then(|binding| match binding {
        AssistantValueBinding::Input { input } => answers.get(input),
        _ => None,
      })
    };
    let document_id = match value(AssistantInputTarget::SourceDocument) {
      Some(AssistantValue::Document(id)) => *id,
      _ => return Err(invalid("select an existing document")),
    };
    let reviewer_id = match value(AssistantInputTarget::Reviewer) {
      Some(AssistantValue::Members(ids)) if ids.len() == 1 => ids[0],
      _ => return Err(invalid("select exactly one reviewer")),
    };
    if !self
      .workspace_store
      .has_accepted_member(workspace, reviewer_id)
      .await
      .map_err(|error| match error {
        crate::auth::AuthError::Storage(message) => DatabaseServiceError::from(RepositoryError::Storage(message)),
        _ => invalid("reviewer unavailable"),
      })?
    {
      return Err(invalid("reviewer must be an accepted workspace member"));
    }
    let (deadline_at, deadline_time_zone) = match value(AssistantInputTarget::Deadline) {
      Some(AssistantValue::DateTime(date))
        if !date.all_day && date.end.is_none() && date.start > chrono::Utc::now() =>
      {
        crate::database::definition::rules::validate_time_zone(&date.time_zone)?;
        (date.start, date.time_zone.clone())
      }
      _ => return Err(invalid("review deadline must be a future point in time")),
    };
    let title = match value(AssistantInputTarget::Title) {
      Some(AssistantValue::Text(title)) if !title.trim().is_empty() => title.clone(),
      _ => return Err(invalid("review title is required")),
    };
    let destination_database_id = match value(AssistantInputTarget::Destination) {
      Some(AssistantValue::DatabaseDestination(id)) => *id,
      None => {
        self
          .views
          .task_destinations(actor, workspace, 1, None)
          .await?
          .default_destination
          .ok_or_else(|| invalid("Workspace Tasks destination unavailable"))?
          .database_id
      }
      _ => return Err(invalid("native Task destination required")),
    };
    self
      .context_document_context(
        actor,
        workspace,
        &ContextDocumentTarget {
          database_id: destination_database_id,
          task_id: None,
        },
      )
      .await?;
    let document = documents
      .get_doc_metadata(document_id)
      .await
      .map_err(|error| match error {
        crate::auth::AuthError::Storage(message) => DatabaseServiceError::from(RepositoryError::Storage(message)),
        _ => invalid("review source unavailable"),
      })?
      .filter(|doc| {
        doc.workspace_id == Some(workspace) && doc.deleted_at.is_none() && !doc.blocked && !doc.is_workspace_root
      })
      .ok_or_else(|| invalid("review source unavailable"))?;
    // Use the canonical permission owner; no reviewer or requester access is granted.
    if !permission
      .get_effective_doc_role(actor, workspace, document_id)
      .await
      .map_err(|error| match error {
        crate::auth::AuthError::Storage(message) => DatabaseServiceError::from(RepositoryError::Storage(message)),
        _ => invalid("review source authority unavailable"),
      })?
      .can(myoxus_domain::permission::DocAction::Read)
    {
      return Err(invalid("review source permission denied"));
    }
    let source_revision = crate::doc::canonical_yjs_revision(
      &documents
        .load_full_doc_consistent(workspace, document_id)
        .await
        .map_err(|error| match error {
          crate::auth::AuthError::Storage(message) => DatabaseServiceError::from(RepositoryError::Storage(message)),
          _ => invalid("review source unavailable"),
        })?,
    )
    .map_err(|_| invalid("review source revision unavailable"))?;
    let workflow = self
      .packages
      .workflow(identity)
      .map_err(invalid)?
      .ok_or_else(|| invalid("review workflow source unavailable"))?;
    if let Some(input) = source
      .inputs
      .iter()
      .find(|input| input.target == AssistantInputTarget::Destination)
    {
      answers.insert(
        input.id.clone(),
        AssistantValue::DatabaseDestination(destination_database_id),
      );
    }
    Ok(myoxus_domain::workspace_automation::PreparedDocumentReview {
      actor_id: actor,
      workspace_id: workspace,
      package: identity.clone(),
      answers,
      locale: locale.into(),
      client_version,
      target,
      source_document_id: document_id,
      source_external_id: document.external_id,
      source_revision,
      reviewer_id,
      destination_database_id,
      title,
      deadline_at,
      deadline_time_zone,
      source_metadata_deadline: None,
      workflow,
      components: source.components.clone(),
      execution_available: self.context_workflows_enabled,
    })
  }
  pub(crate) fn document_review_descriptor(
    &self,
    identity: &AssistantPackageIdentity,
  ) -> Option<AssistantPackageDescriptor> {
    self.packages.accepted_descriptor(identity).ok()
  }
}
