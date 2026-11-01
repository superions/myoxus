// SPDX-License-Identifier: AGPL-3.0-or-later
//! Typed projection of selected content on the existing Workspace receipt.
//! Native owners authorize results; transport never executes component lists.
use super::*;
use myoxus_application::workspace::assistant_packages::{WorkspaceSetupOutcome, WorkspaceSetupResult};
use myoxus_domain::assistant_package as package;

#[derive(SimpleObject)]
#[graphql(name = "WorkspaceSetupAssistance")]
pub struct WorkspaceSetupAssistanceObjectType {
  pub descriptor: AssistantPackageObjectType,
  pub document_targets: Vec<WorkspaceSetupDocumentTargetObjectType>,
}

#[derive(SimpleObject)]
#[graphql(name = "WorkspaceSetupDocumentTarget")]
pub struct WorkspaceSetupDocumentTargetObjectType {
  pub step: String,
  pub group: String,
  pub source_digest: String,
  pub component_id: String,
  pub document_id: ID,
  pub document_external_id: String,
}

impl From<myoxus_application::workspace::assistant_packages::WorkspaceSetupAssistance>
  for WorkspaceSetupAssistanceObjectType
{
  fn from(value: myoxus_application::workspace::assistant_packages::WorkspaceSetupAssistance) -> Self {
    Self {
      descriptor: value.descriptor.into(),
      document_targets: value
        .document_targets
        .into_iter()
        .map(|target| WorkspaceSetupDocumentTargetObjectType {
          step: target.step,
          group: target.group,
          source_digest: target.source_digest,
          component_id: target.component_id,
          document_id: ID(target.document_id.to_string()),
          document_external_id: target.document_external_id,
        })
        .collect(),
    }
  }
}

#[derive(SimpleObject)]
#[graphql(name = "AssistantWorkflowIdentity")]
pub struct AssistantWorkflowIdentityObjectType {
  pub id: String,
  pub version: String,
  pub digest: String,
}

#[derive(SimpleObject)]
#[graphql(name = "PreparedGenericDefinition")]
pub struct PreparedGenericDefinitionObjectType {
  pub component_id: String,
  pub definition_id: String,
  pub version: String,
  pub digest: String,
  pub title: String,
  pub description: Option<String>,
  pub include_sample_rows: bool,
  pub default_currency: String,
  pub priority: ProjectOptionPresetType,
  pub complexity: ProjectOptionPresetType,
  pub structure: ProjectStructurePresetType,
}

#[derive(SimpleObject)]
#[graphql(name = "PreparedWorkspaceSetup")]
pub struct PreparedWorkspaceSetupObjectType {
  pub folder: Option<AssistantFolderDestinationObjectType>,
  pub package: AssistantPackageIdentityObjectType,
  pub answers: Vec<AssistantNamedValueObjectType>,
  pub locale: String,
  pub client_version: i32,
  pub workflow: AssistantWorkflowIdentityObjectType,
  pub components: Vec<AssistantComponentObjectType>,
  pub definitions: Vec<PreparedGenericDefinitionObjectType>,
  pub document_metadata: Vec<AssistantPreparedDocumentMetadataObjectType>,
  pub documents: Vec<AssistantPreparedDocumentComponentObjectType>,
  pub execution_available: bool,
}

pub(crate) fn map_prepared_workspace_setup(
  plan: package::AssistantPreparedWorkspaceSetup,
) -> Result<PreparedWorkspaceSetupObjectType> {
  Ok(PreparedWorkspaceSetupObjectType {
    folder: plan.folder.map(Into::into),
    package: plan.package.into(),
    answers: plan
      .answers
      .into_iter()
      .map(|(input, value)| AssistantNamedValueObjectType {
        input,
        value: value.into(),
      })
      .collect(),
    locale: plan.locale,
    client_version: i32::try_from(plan.client_version)
      .map_err(|_| Error::new("Unsupported Workspace setup client version"))?,
    workflow: AssistantWorkflowIdentityObjectType {
      id: plan.workflow.identity.id,
      version: plan.workflow.identity.version,
      digest: plan.workflow.identity.digest,
    },
    components: plan.components.into_iter().map(Into::into).collect(),
    definitions: plan
      .definitions
      .into_iter()
      .map(|definition| PreparedGenericDefinitionObjectType {
        component_id: definition.component_id,
        definition_id: definition.definition_id,
        version: definition.version,
        digest: definition.digest,
        title: definition.title,
        description: definition.description,
        include_sample_rows: definition.include_sample_rows,
        default_currency: definition.default_currency,
        priority: definition.selection.priority.into(),
        complexity: definition.selection.complexity.into(),
        structure: definition.selection.structure.into(),
      })
      .collect(),
    document_metadata: plan.document_metadata.into_iter().map(Into::into).collect(),
    documents: plan.documents.into_iter().map(Into::into).collect(),
    execution_available: plan.execution_available,
  })
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "WorkspaceSetupResultKind", rename_items = "PascalCase")]
pub enum WorkspaceSetupResultKindType {
  Database,
  Document,
  NativeLink,
}

#[derive(SimpleObject)]
#[graphql(name = "WorkspaceSetupResult")]
pub struct WorkspaceSetupResultObjectType {
  pub kind: WorkspaceSetupResultKindType,
  pub database_id: Option<ID>,
  pub document_id: Option<ID>,
  pub entry_id: Option<String>,
}
impl From<WorkspaceSetupResult> for WorkspaceSetupResultObjectType {
  fn from(result: WorkspaceSetupResult) -> Self {
    let mut value = Self {
      kind: WorkspaceSetupResultKindType::NativeLink,
      database_id: None,
      document_id: None,
      entry_id: None,
    };
    match result {
      WorkspaceSetupResult::Database { database_id } => {
        value.kind = WorkspaceSetupResultKindType::Database;
        value.database_id = Some(ID(database_id.to_string()));
      }
      WorkspaceSetupResult::Document { document_id } => {
        value.kind = WorkspaceSetupResultKindType::Document;
        value.document_id = Some(ID(document_id.to_string()));
      }
      WorkspaceSetupResult::NativeLink { entry_id, .. } => {
        value.entry_id = Some(entry_id);
      }
    }
    value
  }
}

#[derive(SimpleObject)]
#[graphql(name = "WorkspaceSetupComponent")]
pub struct WorkspaceSetupComponentObjectType {
  pub component_id: String,
  pub reserved_id: ID,
  pub result: Option<WorkspaceSetupResultObjectType>,
  pub document_external_id: Option<String>,
  pub available: bool,
}

#[derive(SimpleObject)]
#[graphql(name = "WorkspaceSetup")]
pub struct WorkspaceSetupObjectType {
  pub request_id: ID,
  pub status: ProjectSetupStatusType,
  pub accepted_plan: PreparedWorkspaceSetupObjectType,
  pub accepted_descriptor: Option<AssistantPackageObjectType>,
  pub current_review: Option<PreparedWorkspaceSetupObjectType>,
  pub run: Option<crate::graphql::auth::WorkspaceAutomationRunObjectType>,
  pub components: Vec<WorkspaceSetupComponentObjectType>,
  pub can_retry: bool,
  pub can_stop: bool,
  pub reason_code: Option<String>,
}

pub(crate) fn map_workspace_setup(outcome: WorkspaceSetupOutcome) -> Result<WorkspaceSetupObjectType> {
  use myoxus_application::workspace::ProjectStarterStatus as S;
  Ok(WorkspaceSetupObjectType {
    request_id: ID(outcome.accepted.request_id.to_string()),
    status: match outcome.status {
      S::Ready => ProjectSetupStatusType::Ready,
      S::Pending => ProjectSetupStatusType::Pending,
      S::StopRequested => ProjectSetupStatusType::StopRequested,
      S::Stopped => ProjectSetupStatusType::Stopped,
      S::ReReviewRequired => ProjectSetupStatusType::ReReviewRequired,
      S::Unavailable => ProjectSetupStatusType::Unavailable,
    },
    accepted_plan: map_prepared_workspace_setup(outcome.accepted.original)?,
    accepted_descriptor: outcome.accepted_descriptor.map(Into::into),
    current_review: outcome.current_review.map(map_prepared_workspace_setup).transpose()?,
    run: outcome.run.map(crate::graphql::auth::workspace_automation::map_run),
    components: outcome
      .components
      .into_iter()
      .map(|component| WorkspaceSetupComponentObjectType {
        component_id: component.component_id,
        reserved_id: ID(component.reserved_id.to_string()),
        result: component.result.map(Into::into),
        document_external_id: component.document_external_id,
        available: component.available,
      })
      .collect(),
    can_retry: outcome.can_retry,
    can_stop: outcome.can_stop,
    reason_code: outcome.reason_code,
  })
}
