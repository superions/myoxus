// SPDX-License-Identifier: AGPL-3.0-or-later
use super::preparation::normalize_answers;
use super::validation::invalid;
use super::*;
use crate::database::{DatabaseResult, DatabaseServiceError};
use myoxus_domain::{assistant_package::*, ids::*, repositories::RepositoryError};
use std::collections::BTreeMap;
impl AssistantPackageService {
  /// Review a native prerequisite set without allocating a Run or a Task.
  pub(crate) async fn prepare_task_handover(
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
  ) -> DatabaseResult<myoxus_domain::workspace_automation::PreparedTaskHandover> {
    if !matches!(locale, "en" | "de" | "fr" | "es") || client_version == 0 {
      return Err(invalid(
        "handover requires a supported locale and positive client version",
      ));
    }
    let role = permission
      .get_effective_workspace_role(actor, workspace)
      .await
      .map_err(|error| match error {
        crate::auth::AuthError::Storage(message) => DatabaseServiceError::from(RepositoryError::Storage(message)),
        _ => invalid("handover Task write authority unavailable"),
      })?;
    if !role.is_some_and(|role| role.can(myoxus_domain::permission::WorkspaceAction::CreateDoc)) {
      let mut error = invalid("handover Task write permission denied");
      error.code = crate::database::ERR_FORBIDDEN;
      return Err(error);
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
        AssistantNativeAction::TaskHandover { inputs } => Some(inputs),
        _ => None,
      });
    let inputs = primaries
      .next()
      .ok_or_else(|| invalid("handover primary action unavailable"))?;
    if primaries.next().is_some() {
      return Err(invalid("handover requires exactly one native primary action"));
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
    let responsible_id = match value(AssistantInputTarget::Assignees) {
      Some(AssistantValue::Members(ids)) if ids.len() == 1 => ids[0],
      _ => return Err(invalid("select exactly one responsible person")),
    };
    if !self
      .workspace_store
      .has_accepted_member(workspace, responsible_id)
      .await
      .map_err(|error| match error {
        crate::auth::AuthError::Storage(message) => DatabaseServiceError::from(RepositoryError::Storage(message)),
        _ => invalid("responsible person unavailable"),
      })?
    {
      return Err(invalid("responsible person must be an accepted workspace member"));
    }
    let prerequisites = match value(AssistantInputTarget::PrerequisiteTasks) {
      Some(AssistantValue::TaskReferences(tasks)) if !tasks.is_empty() && tasks.len() <= 64 => tasks.clone(),
      _ => return Err(invalid("select a bounded nonempty set of prerequisite Tasks")),
    };
    let unique = prerequisites
      .iter()
      .map(|task| task.row_id)
      .collect::<std::collections::BTreeSet<_>>();
    if unique.len() != prerequisites.len() {
      return Err(invalid("prerequisite Tasks must be distinct"));
    }
    for task in &prerequisites {
      self
        .context_document_context(
          actor,
          workspace,
          &ContextDocumentTarget {
            database_id: task.database_id,
            task_id: Some(task.row_id),
          },
        )
        .await?;
    }
    let (deadline_at, deadline_time_zone) = match value(AssistantInputTarget::Deadline) {
      Some(AssistantValue::DateTime(date))
        if !date.all_day && date.end.is_none() && date.start > chrono::Utc::now() =>
      {
        crate::database::definition::rules::validate_time_zone(&date.time_zone)?;
        (date.start, date.time_zone.clone())
      }
      _ => return Err(invalid("handover deadline must be a future point in time")),
    };
    let title = match value(AssistantInputTarget::Title) {
      Some(AssistantValue::Text(title)) if !title.trim().is_empty() => title.clone(),
      _ => return Err(invalid("handover title is required")),
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
        _ => invalid("handover source unavailable"),
      })?
      .filter(|doc| {
        doc.workspace_id == Some(workspace) && doc.deleted_at.is_none() && !doc.blocked && !doc.is_workspace_root
      })
      .ok_or_else(|| invalid("handover source unavailable"))?;
    // Native create_task_from_source requires current Copy, not merely Read.
    // Linking this identity does not freeze or copy its editable document body.
    if !permission
      .get_effective_doc_role(actor, workspace, document_id)
      .await
      .map_err(|error| match error {
        crate::auth::AuthError::Storage(message) => DatabaseServiceError::from(RepositoryError::Storage(message)),
        _ => invalid("handover source authority unavailable"),
      })?
      .can(myoxus_domain::permission::DocAction::Copy)
    {
      return Err(invalid("handover source permission denied"));
    }
    let workflow = self
      .packages
      .workflow(identity)
      .map_err(invalid)?
      .ok_or_else(|| invalid("handover workflow source unavailable"))?;
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
    Ok(myoxus_domain::workspace_automation::PreparedTaskHandover {
      actor_id: actor,
      workspace_id: workspace,
      package: identity.clone(),
      answers,
      locale: locale.into(),
      client_version,
      target,
      source_document_id: document_id,
      source_external_id: document.external_id,
      responsible_id,
      prerequisites,
      destination_database_id,
      title,
      deadline_at,
      deadline_time_zone,
      workflow,
      components: source.components.clone(),
      execution_available: self.context_workflows_enabled,
    })
  }
}
