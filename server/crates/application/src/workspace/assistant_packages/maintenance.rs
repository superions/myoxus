// SPDX-License-Identifier: AGPL-3.0-or-later
//! Source-bound readonly preparation; correction values come from native editing.
use super::*;
use super::{preparation::normalize_answers, validation::invalid};
use crate::database::{DatabaseEditingService, DatabaseResult};
use myoxus_domain::{assistant_package::*, ids::*, workspace_automation::*};
use std::collections::BTreeMap;
impl AssistantPackageService {
  #[tracing::instrument(skip_all)]
  pub async fn prepare_task_maintenance(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    identity: &AssistantPackageIdentity,
    answers: BTreeMap<String, AssistantValue>,
    locale: &str,
    client_version: u32,
    editing: &DatabaseEditingService,
  ) -> DatabaseResult<PreparedTaskMaintenance> {
    if !matches!(locale, "en" | "de" | "fr" | "es") || client_version == 0 {
      return Err(invalid(
        "maintenance requires a supported locale and positive client version",
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
        AssistantNativeAction::TaskMaintenance { inputs } => Some(inputs),
        _ => None,
      });
    let inputs = primaries
      .next()
      .ok_or_else(|| invalid("maintenance primary action unavailable"))?;
    if primaries.next().is_some() || inputs.len() != 1 {
      return Err(invalid("maintenance requires one native primary action"));
    }
    let Some(AssistantValueBinding::Input { input }) = inputs.get(&AssistantInputTarget::Tasks) else {
      return Err(invalid("maintenance requires native Task selection"));
    };
    let mut answers = normalize_answers(source, answers).map_err(invalid)?;
    if !answers.contains_key(input)
      || matches!(answers.get(input), Some(AssistantValue::TaskReferences(tasks)) if tasks.is_empty())
    {
      if let Some(row_id) = target.task_id {
        answers.insert(
          input.clone(),
          AssistantValue::TaskReferences(vec![AssistantTaskReference {
            database_id: target.database_id,
            row_id,
          }]),
        );
      }
    }
    let Some(AssistantValue::TaskReferences(tasks)) = answers.get(input) else {
      return Err(invalid("select actual Tasks to inspect"));
    };
    if tasks.is_empty() || tasks.iter().any(|task| task.database_id != target.database_id) {
      return Err(invalid("all selected Tasks must belong to the current container"));
    }
    let proposal = editing
      .inspect_task_content(
        actor,
        workspace,
        target.database_id,
        &tasks.iter().map(|task| task.row_id).collect::<Vec<_>>(),
      )
      .await?;
    let workflow = self
      .packages
      .workflow(identity)
      .map_err(invalid)?
      .ok_or_else(|| invalid("maintenance workflow unavailable"))?;
    Ok(PreparedTaskMaintenance {
      actor_id: actor,
      workspace_id: workspace,
      package: identity.clone(),
      answers,
      locale: locale.into(),
      client_version,
      target,
      proposal,
      workflow,
      components: source.components.clone(),
      execution_available: self.context_workflows_enabled,
    })
  }
}
