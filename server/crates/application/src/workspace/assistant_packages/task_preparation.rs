// SPDX-License-Identifier: AGPL-3.0-or-later
//! Personal rule review resolves exact delivered source bytes through native templates.
use super::*;
use super::{preparation::normalize_answers, validation::invalid};
use crate::database::DatabaseResult;
use myoxus_domain::{assistant_package::*, ids::*, workspace_automation::*};
use std::collections::BTreeMap;
impl AssistantPackageService {
  #[tracing::instrument(skip_all)]
  pub async fn prepare_task_preparation(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    target: ContextDocumentTarget,
    identity: &AssistantPackageIdentity,
    answers: BTreeMap<String, AssistantValue>,
    locale: &str,
    client_version: u32,
  ) -> DatabaseResult<PreparedTaskPreparation> {
    if !matches!(locale, "en" | "de" | "fr" | "es") || client_version == 0 {
      return Err(invalid(
        "personal preparation requires a supported locale and positive client version",
      ));
    }
    self.context_document_context(actor, workspace, &target).await?;
    let source = self
      .packages
      .offered_source(identity, AssistantPackageContext::TaskContainerAssistance)
      .map_err(invalid)?;
    if source.components.len() != 2
      || !matches!(
        source.components[0].action,
        AssistantNativeAction::ConfigureTaskPreparation { .. }
      )
    {
      return Err(invalid("personal preparation component closure unavailable"));
    }
    let AssistantNativeAction::CreateLinkedDocument { variables, .. } = &source.components[1].action else {
      return Err(invalid("personal preparation document component unavailable"));
    };
    let workflow = self
      .packages
      .workflow(identity)
      .map_err(invalid)?
      .ok_or_else(|| invalid("personal preparation workflow unavailable"))?;
    if workflow.source.trigger != Some(AssistantWorkflowTrigger::TaskCreated)
      || workflow.source.nodes.len() != 1
      || !matches!(&workflow.source.nodes[0].action,AssistantWorkflowAction::CreateLinkedDocument{component} if component==&source.components[1].id)
      || workflow.source.capability_versions != [(AssistantWorkflowCapability::CreateLinkedDocument, 1)].into()
    {
      return Err(invalid(
        "personal preparation requires its native Task-created capability",
      ));
    }
    let answers = normalize_answers(source, answers).map_err(invalid)?;
    let mut values = BTreeMap::new();
    for (key, binding) in variables {
      let AssistantValueBinding::Input { input } = binding else {
        return Err(invalid("personal preparation requires explicit literal inputs"));
      };
      let value = match answers.get(input) {
        Some(AssistantValue::Text(value)) => value.clone(),
        None => String::new(),
        _ => return Err(invalid("native template input must be text")),
      };
      values.insert(key.clone(), value);
    }
    let mut delivered = self
      .packages
      .document_components(identity)
      .iter()
      .filter(|(pin, _)| pin.component_id == source.components[1].id);
    let (pin, bytes) = delivered
      .next()
      .ok_or_else(|| invalid("personal preparation source unavailable"))?;
    if delivered.next().is_some() {
      return Err(invalid("personal preparation requires one exact native source"));
    }
    let documents = self
      .project_placement
      .as_ref()
      .ok_or_else(|| invalid("native document preparation unavailable"))?;
    let registry = self
      .document_components
      .as_ref()
      .ok_or_else(|| invalid("native source capture unavailable"))?;
    let prepared = documents
      .prepare_automation_row_body_source(registry, actor, workspace, pin, bytes, locale, client_version, &values)
      .await
      .map_err(|error| match error {
        crate::document_template::DocumentTemplateError::Repository(
          myoxus_domain::repositories::RepositoryError::Storage(message),
        ) => {
          crate::database::DatabaseServiceError::from(myoxus_domain::repositories::RepositoryError::Storage(message))
        }
        _ => invalid("native personal preparation source unavailable"),
      })?;
    Ok(PreparedTaskPreparation {
      actor_id: actor,
      workspace_id: workspace,
      target,
      package: identity.clone(),
      answers,
      locale: locale.into(),
      client_version,
      workflow,
      components: source.components.clone(),
      source: prepared,
      execution_available: self.context_workflows_enabled,
    })
  }
  pub(crate) fn personal_configuration_components(
    &self,
    config: &PersonalAutomationConfig,
  ) -> Result<Vec<AssistantComponent>, String> {
    let source = self
      .packages
      .offered_source(&config.package, AssistantPackageContext::TaskContainerAssistance)?;
    let workflow = self
      .packages
      .workflow(&config.package)?
      .ok_or("personal workflow source unavailable")?;
    if workflow.identity != config.workflow.identity || workflow.source_bytes != config.workflow.source_bytes {
      return Err("personal workflow effects require fresh review".into());
    }
    Ok(source.components.clone())
  }
  pub(crate) fn personal_document_source_admitted(
    &self,
    config: &PersonalAutomationConfig,
    source: &AssistantDocumentComponentSource,
  ) -> bool {
    self
      .packages
      .document_components(&config.package)
      .iter()
      .any(|(pin, _)| pin == source)
  }
  pub(crate) fn automation_document_services(
    &self,
  ) -> Option<(
    &crate::document_template::DocumentTemplateService,
    &crate::template_registry::TemplateRegistryService,
  )> {
    Some((self.project_placement.as_deref()?, self.document_components.as_deref()?))
  }
}
