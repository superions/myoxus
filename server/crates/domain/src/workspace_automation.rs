//! Domain contract for server-owned Workspace Automations.
//!
//! Automations are intentionally separate from Database application services.
//! Database write paths emit typed events, while this contract owns matching,
//! persisted runs and native effect acknowledgements.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::database::DatabaseCellValueData;
use crate::ids::{
  DatabaseFieldId, DatabaseId, DatabaseRowId, DocId, UserId, WorkspaceAutomationActionId, WorkspaceAutomationId,
  WorkspaceAutomationRunId, WorkspaceId,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceAutomationStatus {
  Enabled,
  Disabled,
}

impl WorkspaceAutomationStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Enabled => "enabled",
      Self::Disabled => "disabled",
    }
  }
}

impl std::str::FromStr for WorkspaceAutomationStatus {
  type Err = ();

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "enabled" => Ok(Self::Enabled),
      "disabled" => Ok(Self::Disabled),
      _ => Err(()),
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceAutomationTriggerType {
  RowCreated,
  RowUpdated,
  RelationChanged,
  StatusSelectChanged,
}

impl WorkspaceAutomationTriggerType {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::RowCreated => "row_created",
      Self::RowUpdated => "row_updated",
      Self::RelationChanged => "relation_changed",
      Self::StatusSelectChanged => "status_select_changed",
    }
  }
}

impl std::str::FromStr for WorkspaceAutomationTriggerType {
  type Err = ();

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "row_created" => Ok(Self::RowCreated),
      "row_updated" => Ok(Self::RowUpdated),
      "relation_changed" => Ok(Self::RelationChanged),
      "status_select_changed" => Ok(Self::StatusSelectChanged),
      _ => Err(()),
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAutomationTrigger {
  pub trigger_type: WorkspaceAutomationTriggerType,
  pub database_id: DatabaseId,
  pub field_id: Option<DatabaseFieldId>,
  pub select_option_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceAutomationActionType {
  CreateRow,
  UpdateCell,
  CreateLinkedDocument,
  NotifyWebhook,
}

impl WorkspaceAutomationActionType {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::CreateRow => "create_row",
      Self::UpdateCell => "update_cell",
      Self::CreateLinkedDocument => "create_linked_document",
      Self::NotifyWebhook => "notify_webhook",
    }
  }
}

impl std::str::FromStr for WorkspaceAutomationActionType {
  type Err = ();

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "create_row" => Ok(Self::CreateRow),
      "update_cell" => Ok(Self::UpdateCell),
      "create_linked_document" => Ok(Self::CreateLinkedDocument),
      "notify_webhook" => Ok(Self::NotifyWebhook),
      _ => Err(()),
    }
  }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkspaceAutomationActionConfig {
  CreateRow {
    database_id: DatabaseId,
    title_template: Option<String>,
    cells: Vec<WorkspaceAutomationCellInput>,
  },
  UpdateCell {
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: DatabaseCellValueData,
  },
  CreateLinkedDocument {
    title_template: String,
    relation_field_id: Option<DatabaseFieldId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<AutomationDocumentSourceSetup>,
  },
  NotifyWebhook {
    url: String,
    secret_ref: Option<String>,
  },
}

impl WorkspaceAutomationActionConfig {
  pub fn action_type(&self) -> WorkspaceAutomationActionType {
    match self {
      Self::CreateRow { .. } => WorkspaceAutomationActionType::CreateRow,
      Self::UpdateCell { .. } => WorkspaceAutomationActionType::UpdateCell,
      Self::CreateLinkedDocument { .. } => WorkspaceAutomationActionType::CreateLinkedDocument,
      Self::NotifyWebhook { .. } => WorkspaceAutomationActionType::NotifyWebhook,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAutomationCellInput {
  pub field_id: DatabaseFieldId,
  pub value: DatabaseCellValueData,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAutomationActionDefinition {
  pub position: i32,
  pub config: WorkspaceAutomationActionConfig,
}

#[derive(Debug, Clone)]
pub struct WorkspaceAutomation {
  pub id: WorkspaceAutomationId,
  pub workspace_id: WorkspaceId,
  pub name: String,
  pub description: Option<String>,
  pub status: WorkspaceAutomationStatus,
  pub trigger: WorkspaceAutomationTrigger,
  pub actions: Vec<WorkspaceAutomationActionDefinition>,
  pub personal_config: Option<PersonalAutomationConfig>,
  pub execution_revision: i64,
  pub created_by: Option<UserId>,
  pub updated_by: Option<UserId>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceAutomationRunStatus {
  Queued,
  Running,
  Succeeded,
  Failed,
  DeadLetter,
  Skipped,
}

impl WorkspaceAutomationRunStatus {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Queued => "queued",
      Self::Running => "running",
      Self::Succeeded => "succeeded",
      Self::Failed => "failed",
      Self::DeadLetter => "dead_letter",
      Self::Skipped => "skipped",
    }
  }
}

impl std::str::FromStr for WorkspaceAutomationRunStatus {
  type Err = ();

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "queued" => Ok(Self::Queued),
      "running" => Ok(Self::Running),
      "succeeded" => Ok(Self::Succeeded),
      "failed" => Ok(Self::Failed),
      "dead_letter" => Ok(Self::DeadLetter),
      "skipped" => Ok(Self::Skipped),
      _ => Err(()),
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAutomationTriggerEvent {
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub row_id: DatabaseRowId,
  pub trigger_type: WorkspaceAutomationTriggerType,
  pub actor_user_id: Option<UserId>,
  pub field_id: Option<DatabaseFieldId>,
  pub old_value: Option<DatabaseCellValueData>,
  pub new_value: Option<DatabaseCellValueData>,
  pub row_content_document_id: Option<DocId>,
  pub occurred_at: DateTime<Utc>,
}

/// Rule runs retain their original trigger; confirmed requests are bound to an
/// existing native acceptance receipt and never manufacture a rule or event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
  tag = "kind",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum WorkspaceAutomationRunOrigin {
  RecurringTask {
    schedule_id: uuid::Uuid,
    occurrence_id: uuid::Uuid,
  },
  WorkspaceSetup {
    request_id: uuid::Uuid,
    fingerprint: String,
  },
  TaskMaintenance {
    request_id: uuid::Uuid,
    fingerprint: String,
  },
  TaskHandover {
    request_id: uuid::Uuid,
    fingerprint: String,
  },
  Rule,
  DocumentReview {
    request_id: uuid::Uuid,
    fingerprint: String,
  },
  ConfirmedContextDocuments {
    request_id: uuid::Uuid,
    fingerprint: String,
  },
}

#[derive(Debug, Clone)]
pub struct WorkspaceAutomationRun {
  pub id: WorkspaceAutomationRunId,
  /// Last known queue job identity, not an execution or delivery fence.
  /// Redis wake metadata may be unavailable; it is not required for runtime admission.
  pub job_id: Option<String>,
  pub origin: WorkspaceAutomationRunOrigin,
  pub automation_id: Option<WorkspaceAutomationId>,
  pub workspace_id: WorkspaceId,
  pub trigger_type: Option<WorkspaceAutomationTriggerType>,
  pub trigger_event: Option<WorkspaceAutomationTriggerEvent>,
  /// None projects unsupported or malformed accepted input; never rebuild it from a mutable rule.
  pub accepted: Option<AcceptedAutomationRun>,
  pub execution_generation: i64,
  pub idempotency_key: String,
  pub status: WorkspaceAutomationRunStatus,
  pub attempt_count: i32,
  pub error_code: Option<String>,
  pub error_message: Option<String>,
  pub dead_letter: bool,
  pub queued_at: DateTime<Utc>,
  pub started_at: Option<DateTime<Utc>>,
  pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceAutomationActionStatus {
  Running,
  Succeeded,
}

impl std::str::FromStr for WorkspaceAutomationActionStatus {
  type Err = ();

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "running" => Ok(Self::Running),
      "succeeded" => Ok(Self::Succeeded),
      _ => Err(()),
    }
  }
}

/// The exact native implementation and configuration admitted for one definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedAutomationDefinition {
  pub format_version: u32,
  pub runtime_schema_version: u32,
  pub policy: AutomationExecutionPolicy,
  pub hash: String,
  pub capability_versions: std::collections::BTreeMap<String, u32>,
  pub actions: Vec<WorkspaceAutomationActionDefinition>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub workflow: Option<AcceptedNativeWorkflow>,
}

/// Lowered once at confirmation. Sayiir owns stage advancement; these stages
/// only name existing atomic native component capabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedNativeWorkflow {
  pub source: crate::assistant_package::AssistantResolvedWorkflow,
  pub stages: Vec<ContextDocumentWorkflowStage>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub components: Vec<crate::assistant_package::AssistantComponent>,
  /// Logical Task-set waits lower once to this accepted number of serial signals.
  #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
  pub wait_counts: std::collections::BTreeMap<String, u32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
  tag = "kind",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum ContextDocumentWorkflowStage {
  CreateDatabaseFromDefinition { component: String },
  CreateWorkingDocument { component: String },
  PlaceNativeLink { component: String },
  Folder,
  CreateDocument { component: String },
  PlaceDocument { component: String, created_node: String },
  Complete,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedAutomationRun {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub recurring_task: Option<AcceptedRecurringTask>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub workspace_setup: Option<AcceptedWorkspaceSetupRequest>,
  pub run_id: WorkspaceAutomationRunId,
  pub automation_id: Option<WorkspaceAutomationId>,
  pub workspace_id: WorkspaceId,
  pub actor_id: Option<UserId>,
  pub trigger: Option<WorkspaceAutomationTriggerEvent>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub confirmed_request: Option<AcceptedContextDocumentRequest>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub document_review: Option<AcceptedDocumentReview>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub task_handover: Option<AcceptedTaskHandover>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub task_maintenance: Option<AcceptedTaskMaintenance>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub personal_rule: Option<AcceptedPersonalAutomation>,
  pub definition: AcceptedAutomationDefinition,
}

/// An admitted native creation, not an authorable workflow or a mutable recipe.
/// The slot receipt and native effect retain the reserved Row even after deletion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedRecurringTask {
  /// One member advancement, not a generic trigger. Equal Due dates may belong
  /// to different completed members and must still reserve different Tasks.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub cause_member_id: Option<uuid::Uuid>,
  pub schedule_id: uuid::Uuid,
  pub zone: crate::scheduling::AdmissionZone,
  pub occurrence_id: uuid::Uuid,
  pub series_id: uuid::Uuid,
  pub generation: i64,
  pub slot: crate::scheduling::Occurrence,
  pub row_id: DatabaseRowId,
  pub database_id: DatabaseId,
  pub title: String,
  pub cells: Vec<WorkspaceAutomationCellInput>,
}
/// Private, versioned engine continuation. Native receipts, never this JSON,
/// authorize identities and writes; result bindings are checked at consumption.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextWorkflowEnvelope {
  pub format_version: u32,
  pub request_id: uuid::Uuid,
  pub fingerprint: String,
  pub target: crate::assistant_package::ContextDocumentTarget,
  pub results: std::collections::BTreeMap<String, ContextWorkflowResult>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
  tag = "kind",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum ContextWorkflowResult {
  Folder { folder_id: String },
  Created { component: String, doc_id: uuid::Uuid },
  Placed { component: String, doc_id: uuid::Uuid },
  Complete,
}

/// A compact binding to the authoritative starter ledger, not a copied plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedContextDocumentRequest {
  pub request_id: uuid::Uuid,
  pub fingerprint: String,
  pub target: crate::assistant_package::ContextDocumentTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationExecutionClaim {
  pub owner: uuid::Uuid,
  pub generation: i64,
}
/// Safe native terminal categories for a confirmed request. They never contain
/// private inputs and cannot be downgraded to a retryable engine diagnostic.
#[derive(Debug, Clone, Copy)]
pub enum ContextWorkflowFailure {
  Permission,
  Stale,
}
impl ContextWorkflowFailure {
  pub fn code(self) -> &'static str {
    match self {
      Self::Permission => "MIX_AUTOMATION_FORBIDDEN",
      Self::Stale => "MIX_AUTOMATION_RUN_NOT_RETRYABLE",
    }
  }
}

/// A native writer must check this under its own transaction and acknowledge
/// the stable effect before commit. Force never bypasses this execution fence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AutomationEffectFence {
  pub run_id: WorkspaceAutomationRunId,
  pub action_id: WorkspaceAutomationActionId,
  pub claim: AutomationExecutionClaim,
}
#[derive(Debug, Clone)]
pub struct WorkspaceAutomationEffectReceipt {
  pub action_id: WorkspaceAutomationActionId,
  pub run_id: WorkspaceAutomationRunId,
  pub position: i32,
  pub node_key: String,
  pub effect_key: String,
  pub input_fingerprint: String,
  pub reserved_id: uuid::Uuid,
  pub expected_edit_revision: Option<i64>,
  pub status: WorkspaceAutomationActionStatus,
  pub result_json: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationExecutionPolicy {
  pub max_actions_per_run: u32,
  pub max_retry_attempts: u32,
  pub webhook_timeout_seconds: u64,
}

/// Read-only native review facts. The full merged Yjs revision includes deletions;
/// neither a sequence number nor a state vector is an approval precondition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedDocumentReview {
  pub actor_id: UserId,
  pub workspace_id: WorkspaceId,
  pub package: crate::assistant_package::AssistantPackageIdentity,
  pub answers: std::collections::BTreeMap<String, crate::assistant_package::AssistantValue>,
  pub locale: String,
  pub client_version: u32,
  pub target: crate::assistant_package::ContextDocumentTarget,
  pub source_document_id: DocId,
  pub source_external_id: String,
  pub source_revision: String,
  pub reviewer_id: UserId,
  pub destination_database_id: DatabaseId,
  pub title: String,
  pub deadline_at: DateTime<Utc>,
  pub deadline_time_zone: String,
  /// Automatic cycle identity, distinct from its future process deadline.
  /// Deployed manual Reviews omit it and retain their accepted JSON shape.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub source_metadata_deadline: Option<DateTime<Utc>>,
  pub workflow: crate::assistant_package::AssistantResolvedWorkflow,
  pub components: Vec<crate::assistant_package::AssistantComponent>,
  pub execution_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentReviewStartInput {
  pub request_id: uuid::Uuid,
  pub package: crate::assistant_package::AssistantPackageIdentity,
  pub answers: std::collections::BTreeMap<String, crate::assistant_package::AssistantValue>,
  pub locale: String,
  pub client_version: u32,
  pub plan_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum DocumentReviewDecision {
  Approve,
  RequestChanges { reason: String },
}

/// A decision is a native command, never an unrestricted engine signal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentReviewDecisionInput {
  pub run_id: WorkspaceAutomationRunId,
  pub wait_id: String,
  pub request_id: uuid::Uuid,
  pub expected_document_revision: String,
  pub expected_task_edit_revision: i64,
  pub expected_status_edit_revision: i64,
  pub decision: DocumentReviewDecision,
}

#[derive(Debug, Clone)]
pub struct DocumentReviewView {
  pub wait_id: String,
  pub expected_task_edit_revision: Option<i64>,
  pub expected_status_edit_revision: Option<i64>,
  pub source_available: bool,
  pub current_source_revision: Option<String>,
  pub can_retry: bool,
  pub accepted_descriptor: Option<crate::assistant_package::AssistantPackageDescriptor>,
  pub run: WorkspaceAutomationRun,
  pub accepted: PreparedDocumentReview,
  pub review_task_id: DatabaseRowId,
  pub follow_up_task_id: DatabaseRowId,
  pub review_task_available: bool,
  pub follow_up_task_available: bool,
  pub decision: Option<DocumentReviewDecision>,
  pub can_approve: bool,
  pub can_request_changes: bool,
  pub can_stop: bool,
  pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedDocumentReview {
  pub request_id: uuid::Uuid,
  /// Slot generation is frozen only for automatic admission. Manual receipts
  /// omit it; the native generated SQL fence derives from this accepted value.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub scheduling_generation: Option<i64>,
  pub fingerprint: String,
  pub plan: PreparedDocumentReview,
  pub review_task_id: DatabaseRowId,
  pub follow_up_task_id: DatabaseRowId,
  pub wait_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentReviewDecisionReceipt {
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub review_task_id: DatabaseRowId,
  pub run_id: WorkspaceAutomationRunId,
  pub wait_id: String,
  pub event_id: uuid::Uuid,
  pub request_id: uuid::Uuid,
  pub actor_id: UserId,
  pub source_revision: String,
  pub expected_task_edit_revision: i64,
  pub expected_status_edit_revision: i64,
  pub decision: DocumentReviewDecision,
  pub accepted_at: DateTime<Utc>,
}

/// Correlation and acceptance time are technical facts. Native decision owners
/// authorize and freeze the typed business payload before outbox publication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowWaitKey {
  pub run_id: WorkspaceAutomationRunId,
  pub wait_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSignalEnvelope {
  pub format_version: u32,
  pub event_id: uuid::Uuid,
  pub key: WorkflowWaitKey,
  pub accepted_at: DateTime<Utc>,
  pub outcome: WorkflowSignalOutcome,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
  tag = "kind",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum WorkflowSignalOutcome {
  Accepted {
    outcome_key: String,
    result: serde_json::Value,
  },
  Invalidated {
    reason_code: String,
  },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowWaitStatus {
  pub key: WorkflowWaitKey,
  pub deadline_at: DateTime<Utc>,
  pub accepted_event_id: Option<uuid::Uuid>,
  pub expired: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkflowSignalDelivery {
  Accepted,
  AlreadyAccepted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedTaskHandover {
  pub actor_id: UserId,
  pub workspace_id: WorkspaceId,
  pub package: crate::assistant_package::AssistantPackageIdentity,
  pub answers: std::collections::BTreeMap<String, crate::assistant_package::AssistantValue>,
  pub locale: String,
  pub client_version: u32,
  pub target: crate::assistant_package::ContextDocumentTarget,
  pub source_document_id: DocId,
  pub source_external_id: String,
  pub prerequisites: Vec<crate::assistant_package::AssistantTaskReference>,
  pub responsible_id: UserId,
  pub destination_database_id: DatabaseId,
  pub title: String,
  pub deadline_at: DateTime<Utc>,
  pub deadline_time_zone: String,
  pub workflow: crate::assistant_package::AssistantResolvedWorkflow,
  pub components: Vec<crate::assistant_package::AssistantComponent>,
  pub execution_available: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskHandoverStartInput {
  pub request_id: uuid::Uuid,
  pub package: crate::assistant_package::AssistantPackageIdentity,
  pub answers: std::collections::BTreeMap<String, crate::assistant_package::AssistantValue>,
  pub locale: String,
  pub client_version: u32,
  pub plan_digest: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedTaskHandover {
  pub request_id: uuid::Uuid,
  pub fingerprint: String,
  pub plan: PreparedTaskHandover,
  pub result_task_id: DatabaseRowId,
}
#[derive(Debug, Clone)]
pub struct TaskHandoverPrerequisiteView {
  pub reference: crate::assistant_package::AssistantTaskReference,
  pub available: bool,
  pub title: Option<String>,
  pub complete: bool,
}
#[derive(Debug, Clone)]
pub struct TaskHandoverView {
  pub run: WorkspaceAutomationRun,
  pub accepted: PreparedTaskHandover,
  pub accepted_descriptor: Option<crate::assistant_package::AssistantPackageDescriptor>,
  pub result_task_id: DatabaseRowId,
  pub result_task: Option<crate::assistant_package::AssistantTaskReference>,
  pub result_available: bool,
  pub source_available: bool,
  pub prerequisites: Vec<TaskHandoverPrerequisiteView>,
  pub can_retry: bool,
  pub can_stop: bool,
  pub reason_code: Option<String>,
}
/// Completion facts live on the accepted Run independently of outbox retention.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskHandoverCompletion {
  pub task: crate::assistant_package::AssistantTaskReference,
  pub event_id: uuid::Uuid,
  pub accepted_at: DateTime<Utc>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskHandoverState {
  pub completions: std::collections::BTreeMap<DatabaseRowId, TaskHandoverCompletion>,
  pub invalid_reason: Option<String>,
  pub expired_at: Option<DateTime<Utc>>,
}

impl TaskHandoverState {
  pub fn validate(&self, plan: &PreparedTaskHandover) -> Result<(), String> {
    let mut events = std::collections::BTreeSet::new();
    if self.completions.len() > plan.prerequisites.len()
      || self.completions.iter().any(|(row, fact)| {
        *row != fact.task.row_id
          || !plan.prerequisites.contains(&fact.task)
          || fact.accepted_at >= plan.deadline_at
          || !events.insert(fact.event_id)
      })
    {
      return Err("retained Task completion identity unavailable".into());
    }
    Ok(())
  }
}

/// Source identity and literal inputs are frozen before accepting a personal
/// preparation rule. No document body or signing material is stored here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationDocumentSourceSetup {
  pub source: crate::assistant_package::AssistantDocumentComponentSource,
  pub source_revision_id: uuid::Uuid,
  pub source_revision_digest: String,
  pub source_content_digest: String,
  pub locale: String,
  pub title: String,
  pub variables: std::collections::BTreeMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersonalAutomationConfig {
  /// Digest of the exact reviewed configuration, including resolved source pins.
  pub plan_digest: String,
  pub actor_id: UserId,
  pub database_id: DatabaseId,
  pub confirmed_mode: ConfirmedAutomaticMode,
  pub package: crate::assistant_package::AssistantPackageIdentity,
  pub workflow: crate::assistant_package::AssistantResolvedWorkflow,
  pub answers: std::collections::BTreeMap<String, crate::assistant_package::AssistantValue>,
  pub locale: String,
  pub client_version: u32,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfirmedAutomaticMode {
  Automatic,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedPersonalAutomation {
  pub installation: crate::database::DatabaseManagedSchemaInstallation,
  pub actor_id: UserId,
  pub database_id: DatabaseId,
  pub execution_revision: i64,
  pub config: PersonalAutomationConfig,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskContentFindingKind {
  RequiredValueMissing,
  DueBeforeStart,
  ReferenceUnavailable,
  AssignmentSuggestion,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskContentFinding {
  pub task: crate::assistant_package::AssistantTaskReference,
  pub field_id: DatabaseFieldId,
  pub kind: TaskContentFindingKind,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCorrectionPatch {
  pub old_value: Option<DatabaseCellValueData>,
  pub row_id: DatabaseRowId,
  pub field_id: DatabaseFieldId,
  pub intent: crate::database::DatabaseBulkCellIntent,
  pub expected_edit_revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCorrectionRowPrecondition {
  pub row_id: DatabaseRowId,
  pub expected_edit_revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCorrectionProposal {
  pub actor_id: UserId,
  pub workspace_id: WorkspaceId,
  pub database_id: DatabaseId,
  pub tasks: Vec<crate::assistant_package::AssistantTaskReference>,
  pub findings: Vec<TaskContentFinding>,
  pub patches: Vec<TaskCorrectionPatch>,
  pub row_preconditions: Vec<TaskCorrectionRowPrecondition>,
  pub digest: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedTaskMaintenance {
  pub actor_id: UserId,
  pub workspace_id: WorkspaceId,
  pub package: crate::assistant_package::AssistantPackageIdentity,
  pub answers: std::collections::BTreeMap<String, crate::assistant_package::AssistantValue>,
  pub locale: String,
  pub client_version: u32,
  pub target: crate::assistant_package::ContextDocumentTarget,
  pub proposal: TaskCorrectionProposal,
  pub workflow: crate::assistant_package::AssistantResolvedWorkflow,
  pub components: Vec<crate::assistant_package::AssistantComponent>,
  pub execution_available: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskMaintenanceStartInput {
  pub request_id: uuid::Uuid,
  pub package: crate::assistant_package::AssistantPackageIdentity,
  pub answers: std::collections::BTreeMap<String, crate::assistant_package::AssistantValue>,
  pub locale: String,
  pub client_version: u32,
  pub plan_digest: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedTaskMaintenance {
  pub request_id: uuid::Uuid,
  pub fingerprint: String,
  pub plan: PreparedTaskMaintenance,
  pub wait_id: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskCorrectionOutcome {
  Apply,
  Decline,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCorrectionConfirmationInput {
  pub run_id: WorkspaceAutomationRunId,
  pub request_id: uuid::Uuid,
  pub wait_id: String,
  pub proposal_digest: String,
  pub outcome: TaskCorrectionOutcome,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCorrectionConfirmationReceipt {
  pub run_id: WorkspaceAutomationRunId,
  pub actor_id: UserId,
  pub request_id: uuid::Uuid,
  pub wait_id: String,
  pub proposal_digest: String,
  pub outcome: TaskCorrectionOutcome,
  pub event_id: uuid::Uuid,
  pub accepted_at: DateTime<Utc>,
}
#[derive(Debug, Clone)]
pub struct TaskMaintenanceView {
  pub request_id: uuid::Uuid,
  pub run: WorkspaceAutomationRun,
  pub accepted: PreparedTaskMaintenance,
  pub accepted_descriptor: Option<crate::assistant_package::AssistantPackageDescriptor>,
  pub confirmation: Option<TaskCorrectionConfirmationReceipt>,
  pub wait_id: String,
  pub can_confirm: bool,
  pub can_apply: bool,
  pub can_decline: bool,
  pub can_retry: bool,
  pub can_stop: bool,
  pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedTaskPreparation {
  pub components: Vec<crate::assistant_package::AssistantComponent>,
  pub actor_id: UserId,
  pub workspace_id: WorkspaceId,
  pub target: crate::assistant_package::ContextDocumentTarget,
  pub package: crate::assistant_package::AssistantPackageIdentity,
  pub answers: std::collections::BTreeMap<String, crate::assistant_package::AssistantValue>,
  pub locale: String,
  pub client_version: u32,
  pub workflow: crate::assistant_package::AssistantResolvedWorkflow,
  pub source: AutomationDocumentSourceSetup,
  pub execution_available: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskPreparationConfigurationInput {
  pub rule_id: Option<WorkspaceAutomationId>,
  pub expected_execution_revision: Option<i64>,
  pub package: crate::assistant_package::AssistantPackageIdentity,
  pub answers: std::collections::BTreeMap<String, crate::assistant_package::AssistantValue>,
  pub locale: String,
  pub client_version: u32,
  pub plan_digest: String,
  pub enabled: bool,
}

/// The existing create_workspace starter row remains the business receipt.
/// This binding supplies no replacement plan or second acceptance identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedWorkspaceSetupRequest {
  pub request_id: uuid::Uuid,
  pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
  tag = "kind",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum WorkspaceSetupResult {
  Database { database_id: DatabaseId },
  Document { document_id: uuid::Uuid },
  NativeLink { component_id: String, entry_id: String },
}

/// Typed continuation results are verified against the existing root receipt
/// and action ACK before a later node can consume them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSetupWorkflowEnvelope {
  pub format_version: u32,
  pub request_id: uuid::Uuid,
  pub fingerprint: String,
  pub results: std::collections::BTreeMap<String, WorkspaceSetupStageResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
  tag = "kind",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum WorkspaceSetupStageResult {
  Folder {
    folder_id: String,
  },
  Component {
    component_id: String,
    result: WorkspaceSetupResult,
  },
  Complete,
}
