// SPDX-License-Identifier: AGPL-3.0-or-later
//! Immutable authored presentation and native capability references. Packages
//! describe inputs and composition; native owners retain authorization and writes.
use crate::database::{
  DatabaseDateTimeValue, DatabaseDateValue, DatabaseFieldConfig, DatabaseFieldType, DatabaseManagedSchema,
  DatabaseProjectOptionPreset, DatabaseProjectStructurePreset, DatabaseTaskMoveSelection, DatabaseViewKind,
};
use crate::ids::{DatabaseFieldId, DatabaseId, DatabaseRowId, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Transport envelope bound, distinct from each native answer's value limit.
/// It accommodates valid long answers plus tagged JSON and confirmation data.
pub const ASSISTANT_INPUT_MAX_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantPackageIdentity {
  pub id: String,
  pub version: String,
  pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantLocalizedText {
  pub en: String,
  pub de: String,
  pub fr: String,
  pub es: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantPackageContext {
  TaskContainerAssistance,
  WorkspaceCreation,
  ProjectCreation,
  TaskHome,
  TaskInventory,
  TaskDetail,
  TaskCreation,
  TaskCapture,
  TaskSubtask,
  TaskMovement,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantValueType {
  TaskReferences,
  Document,
  Text,
  Boolean,
  Choice,
  Choices,
  Date,
  DateTime,
  Members,
  DatabaseDestination,
  RowTemplate,
  RowSelection,
  Row,
  Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase", deny_unknown_fields)]
pub enum AssistantValue {
  TaskReferences(Vec<AssistantTaskReference>),
  Document(uuid::Uuid),
  Text(String),
  Boolean(bool),
  Choice(String),
  Choices(Vec<String>),
  Date(DatabaseDateValue),
  DateTime(DatabaseDateTimeValue),
  Members(Vec<UserId>),
  DatabaseDestination(DatabaseId),
  RowTemplate(uuid::Uuid),
  RowSelection(Vec<DatabaseTaskMoveSelection>),
  Row(DatabaseRowId),
  Folder(AssistantFolderDestination),
}

/// Stable native Task identity; edit preconditions belong to mutation commands.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantTaskReference {
  pub database_id: DatabaseId,
  pub row_id: DatabaseRowId,
}

/// An explicit native Organizer destination; folder identities are not Doc UUIDs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
  tag = "kind",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum AssistantFolderDestination {
  Existing { id: String },
  New { name: String, parent: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantChoice {
  pub id: String,
  pub label: AssistantLocalizedText,
  pub value: AssistantValue,
}

/// Visibility is finite and references earlier declared inputs. Hidden answers
/// are removed before defaults and native validation are applied.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum AssistantVisibility {
  Present { input: String },
  Equals { input: String, value: AssistantValue },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum AssistantInputTarget {
  Tasks,
  PrerequisiteTasks,
  SourceDocument,
  Reviewer,
  Deadline,
  WorkspaceName,
  InitialContent,
  AssistanceMode,
  ProjectTemplate,
  Title,
  Description,
  Folder,
  PriorityPreset,
  ComplexityPreset,
  StructurePreset,
  DefaultCurrency,
  InitialView,
  IncludeSamples,
  Goal,
  Scope,
  StartDate,
  EndDate,
  People,
  IncludeScaffold,
  IncludeComponent,
  Destination,
  Assignees,
  Due,
  RowTemplate,
  CopyDescription,
  Parent,
  Phase,
  Milestone,
  MoveSelection,
  TaskScope,
  TaskLifecycle,
  TaskDuePreset,
  TaskSearch,
  TaskAssignee,
  TaskStatusGroup,
  TaskBlockedOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantInput {
  pub id: String,
  pub target: AssistantInputTarget,
  pub label: AssistantLocalizedText,
  pub description: Option<AssistantLocalizedText>,
  pub value_type: AssistantValueType,
  pub required: bool,
  pub default: Option<AssistantValue>,
  pub choices: Vec<AssistantChoice>,
  pub visible_when: Option<AssistantVisibility>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantInputControlKind {
  TaskReferences,
  Document,
  Text,
  Multiline,
  Search,
  Toggle,
  Select,
  RadioCards,
  MultiSelect,
  Date,
  DateTime,
  Members,
  Destination,
  RowTemplate,
  Row,
  Folder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
  tag = "kind",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum AssistantFieldBinding {
  Role { role_key: String },
  Field { field_key: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantTaskSummaryValue {
  Title,
  Destination,
  Status,
  BlockedBy,
  Assignees,
  Due,
  Priority,
  RowActions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantTaskFilter {
  Scope,
  Destination,
  Assignee,
  StatusGroup,
  Lifecycle,
  DuePreset,
  Search,
  BlockedOnly,
}

/// Finite presentation of the canonical native Cell slot, not semantic
/// emptiness or write eligibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantCellPresence {
  Always,
  Present,
  Empty,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
  tag = "kind",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum AssistantControl {
  TaskPreparationReview,
  TaskMaintenanceReview,
  TaskHandoverReview,
  DocumentReview,
  WorkspaceReview,
  OfferingSelection {
    search: bool,
  },
  ProjectReview,
  Input {
    input: String,
    control: AssistantInputControlKind,
  },
  NativeCell {
    binding: AssistantFieldBinding,
    presence: AssistantCellPresence,
  },
  Parent,
  BlockedBy,
  Follow,
  Reminder {
    offsets_minutes: Vec<i64>,
    default_offset_minutes: i64,
    allow_custom_offset: bool,
  },
  DestinationAudience,
  MoveSelection,
  MoveImpact,
  CurrentOwnerReadback,
  RowContent,
  SourceOrigin,
  Activity,
  RowLifecycle,
  TaskSummary {
    value: AssistantTaskSummaryValue,
  },
  TaskFilter {
    filter: AssistantTaskFilter,
  },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantGroupRole {
  Content,
  Workflow,
  Details,
  More,
  Filters,
  Inventory,
  Review,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantGroup {
  pub id: String,
  pub title: Option<AssistantLocalizedText>,
  pub role: AssistantGroupRole,
  pub controls: Vec<AssistantControl>,
  pub visible_when: Option<AssistantVisibility>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantActionKind {
  PrepareTaskPreparation,
  ConfigureTaskPreparation,
  PrepareTaskMaintenance,
  StartTaskMaintenance,
  PrepareTaskHandover,
  StartTaskHandover,
  PrepareDocumentReview,
  RequestDocumentReview,
  PrepareDocuments,
  ApplyDocuments,
  CreateWorkspace,
  Back,
  Next,
  Cancel,
  Close,
  Check,
  Refresh,
  OpenCurrentRow,
  OpenRelatedRow,
  CreateProject,
  OpenProjectCreation,
  CreateTask,
  CaptureTask,
  CreateSubtask,
  PrepareTaskMove,
  CommitTaskMove,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantContextValue {
  Requester,
  Workspace,
  Database,
  Row,
  SourceDocument,
  ParentRow,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantResultValue {
  CorrectionProposal,
  Reason,
  Outcome,
  Document,
  Database,
  Row,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum AssistantValueBinding {
  LocalizedText {
    value: AssistantLocalizedText,
  },
  Input {
    input: String,
  },
  Context {
    value: AssistantContextValue,
  },
  Result {
    component: String,
    value: AssistantResultValue,
  },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantPresentationAction {
  pub id: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label: Option<AssistantLocalizedText>,
  pub action: AssistantActionKind,
  pub component: Option<String>,
  pub target_step: Option<String>,
  pub dialog: Option<String>,
  pub visible_when: Option<AssistantVisibility>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantStep {
  pub id: String,
  pub title: AssistantLocalizedText,
  pub groups: Vec<AssistantGroup>,
  pub actions: Vec<AssistantPresentationAction>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantDialog {
  pub id: String,
  pub title: AssistantLocalizedText,
  pub groups: Vec<AssistantGroup>,
  pub actions: Vec<AssistantPresentationAction>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantPresentation {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub guided_help: Option<AssistantStep>,
  pub steps: Vec<AssistantStep>,
  pub dialogs: Vec<AssistantDialog>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
  tag = "kind",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum AssistantNativeAction {
  CreateDatabaseFromDefinition {
    definition_id: String,
    selected: AssistantValueBinding,
    inputs: BTreeMap<AssistantInputTarget, AssistantValueBinding>,
  },
  CreateWorkingDocument {
    selected: AssistantValueBinding,
    folder: AssistantValueBinding,
    variables: BTreeMap<String, AssistantValueBinding>,
  },
  PlaceNativeLink {
    target: AssistantValueBinding,
    folder: AssistantValueBinding,
  },
  ConfigureTaskPreparation {
    inputs: BTreeMap<AssistantInputTarget, AssistantValueBinding>,
  },
  CreateLinkedDocument {
    inputs: BTreeMap<AssistantInputTarget, AssistantValueBinding>,
    variables: BTreeMap<String, AssistantValueBinding>,
  },
  TaskMaintenance {
    inputs: BTreeMap<AssistantInputTarget, AssistantValueBinding>,
  },
  InspectTaskContent {
    tasks: AssistantValueBinding,
  },
  ApplyTaskCorrections {
    proposal: AssistantValueBinding,
  },
  TaskHandover {
    inputs: BTreeMap<AssistantInputTarget, AssistantValueBinding>,
  },
  RequestDocumentReview {
    inputs: BTreeMap<AssistantInputTarget, AssistantValueBinding>,
  },
  CreateTaskFromDocument {
    inputs: BTreeMap<AssistantInputTarget, AssistantValueBinding>,
  },
  CreateDocument {
    selected: AssistantValueBinding,
    folder: AssistantValueBinding,
    variables: BTreeMap<String, AssistantValueBinding>,
  },
  CreateWorkspace {
    inputs: BTreeMap<AssistantInputTarget, AssistantValueBinding>,
  },
  CreateProject {
    template_id: String,
    inputs: BTreeMap<AssistantInputTarget, AssistantValueBinding>,
    /// Read-only native scaffold proposals; this does not authorize execution.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    scaffold: Vec<AssistantProjectScaffold>,
  },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantProjectScaffoldKind {
  Phase,
  Milestone,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantProjectScaffold {
  pub id: String,
  pub kind: AssistantProjectScaffoldKind,
  pub title: AssistantLocalizedText,
}

/// Explicit reviewed setup facts, never inferred attendance or Task assignment.
/// Start/end are point dates (native Date values with no range end).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantProjectSetupFacts {
  pub goal: Option<String>,
  pub scope: Option<String>,
  pub start_date: Option<DatabaseDateValue>,
  pub end_date: Option<DatabaseDateValue>,
  pub people: Vec<UserId>,
  pub scaffold: Vec<AssistantProjectScaffold>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantProjectSetupCounts {
  pub phases: usize,
  pub milestones: usize,
  pub sample_rows: usize,
  pub explicit_tasks: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantComponent {
  pub id: String,
  pub action: AssistantNativeAction,
}
/// A native workflow sequences existing package components; their authored
/// bindings and native receipts remain the input and effect authorities.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantWorkflowSource {
  pub format_version: u32,
  pub id: String,
  pub version: String,
  pub capability_versions: BTreeMap<AssistantWorkflowCapability, u32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub trigger: Option<AssistantWorkflowTrigger>,
  pub nodes: Vec<AssistantWorkflowNode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssistantWorkflowCapability {
  CreateDatabaseFromDefinition,
  CreateWorkingDocument,
  PlaceNativeLink,
  CreateLinkedDocument,
  InspectTaskContent,
  AwaitCorrectionConfirmation,
  ApplyTaskCorrections,
  AwaitTaskSet,
  CreateTaskFromDocument,
  AwaitSignal,
  Branch,
  CreateContextDocument,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantWorkflowNode {
  pub id: String,
  pub action: AssistantWorkflowAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
  tag = "kind",
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  deny_unknown_fields
)]
pub enum AssistantWorkflowAction {
  CreateDatabaseFromDefinition {
    component: String,
  },
  CreateWorkingDocument {
    component: String,
  },
  PlaceNativeLink {
    component: String,
  },
  CreateLinkedDocument {
    component: String,
  },
  InspectTaskContent {
    component: String,
  },
  /// A proposal-specific human confirmation has no invented expiry deadline.
  AwaitCorrectionConfirmation {
    wait_id: String,
  },
  ApplyTaskCorrections {
    component: String,
  },
  AwaitTaskSet {
    wait_id: String,
    tasks: AssistantValueBinding,
    deadline: AssistantValueBinding,
  },
  CreateTaskFromDocument {
    component: String,
  },
  AwaitSignal {
    wait_id: String,
    deadline: AssistantValueBinding,
  },
  Branch {
    outcome: AssistantValueBinding,
    cases: BTreeMap<String, Vec<AssistantWorkflowNode>>,
  },
  CreateContextDocument {
    component: String,
  },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantWorkflowIdentity {
  pub id: String,
  pub version: String,
  pub digest: String,
}

/// Retain admitted source bytes with the exact binding contract, rather than
/// resolving a newer active offering when an accepted request resumes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantResolvedWorkflow {
  pub identity: AssistantWorkflowIdentity,
  pub binding_version: u32,
  pub source: AssistantWorkflowSource,
  pub source_bytes: Vec<u8>,
  pub bundle: crate::feature_bundle::FeatureBundlePin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantPackageSource {
  pub format_version: u32,
  pub id: String,
  pub version: String,
  pub name: AssistantLocalizedText,
  pub description: AssistantLocalizedText,
  pub contexts: Vec<AssistantPackageContext>,
  pub inputs: Vec<AssistantInput>,
  pub components: Vec<AssistantComponent>,
  pub presentation: AssistantPresentation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantArtworkSlot {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub role: Option<crate::feature_bundle::FeatureArtworkRole>,
  pub step: String,
  pub group: String,
  pub bundle: crate::feature_bundle::FeatureBundlePin,
  pub component: String,
  pub digest: String,
  pub media_type: String,
  pub width: u32,
  pub height: u32,
  pub alternative: AssistantLocalizedText,
  pub caption: Option<AssistantLocalizedText>,
}

/// A supplemental manual Library source, never a Project execution component.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantDocumentSourceSlot {
  pub step: String,
  pub group: String,
  pub template_id: String,
  pub version: String,
  pub digest: String,
}

/// Exact delivery source of one optional native document component. Registry
/// eligibility and actor rights are checked separately before source capture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantDocumentComponentSource {
  pub component_id: String,
  pub template_id: String,
  pub version: String,
  pub digest: String,
  pub bundle: crate::feature_bundle::FeatureBundlePin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantPackageDescriptor {
  pub components: Vec<AssistantComponent>,
  pub default_for: Vec<AssistantPackageContext>,
  pub identity: AssistantPackageIdentity,
  pub name: AssistantLocalizedText,
  pub description: AssistantLocalizedText,
  pub contexts: Vec<AssistantPackageContext>,
  pub inputs: Vec<AssistantInput>,
  pub presentation: AssistantPresentation,
  /// Delivery presentation overlay; immutable native package bodies stay intact.
  pub artwork: Vec<AssistantArtworkSlot>,
  pub document_sources: Vec<AssistantDocumentSourceSlot>,
  pub document_components: Vec<AssistantDocumentComponentSource>,
}

/// Resolved only after current native authorization/readiness. Authored keys
/// never let a client install or choose arbitrary native Field UUID bindings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantResolvedField {
  pub name: String,
  pub field_type: DatabaseFieldType,
  pub required: bool,
  pub binding: AssistantFieldBinding,
  pub field_id: DatabaseFieldId,
  pub config: DatabaseFieldConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantPreparedDocumentComponent {
  pub source: AssistantDocumentComponentSource,
  pub source_revision_id: uuid::Uuid,
  pub source_content_digest: String,
  pub source_revision_digest: String,
  pub locale: String,
  pub title: String,
  pub variables: BTreeMap<String, String>,
  pub folder: AssistantFolderDestination,
}

/// Published native source facts only. New-workspace review cannot read or
/// instantiate a target body before the real workspace and destination exist.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantPreparedDocumentMetadata {
  pub source: AssistantDocumentComponentSource,
  pub source_revision_id: uuid::Uuid,
  pub source_revision_digest: String,
  pub locale: String,
  pub title: String,
  pub variables: BTreeMap<String, String>,
  pub folder: AssistantFolderDestination,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantPreparedProject {
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub document_metadata: Vec<AssistantPreparedDocumentMetadata>,
  pub client_version: Option<u32>,
  #[serde(default)]
  pub documents: Vec<AssistantPreparedDocumentComponent>,
  pub locale: String,
  pub setup: AssistantProjectSetupFacts,
  pub counts: AssistantProjectSetupCounts,
  /// False until all selected effects have a native execution adapter.
  pub execution_available: bool,
  pub workspace_id: Option<WorkspaceId>,
  pub actor_id: UserId,
  pub package: AssistantPackageIdentity,
  pub component_id: String,
  pub template_id: String,
  pub template_version: String,
  pub template_digest: String,
  pub answers: BTreeMap<String, AssistantValue>,
  pub title: String,
  pub description: Option<String>,
  pub priority: DatabaseProjectOptionPreset,
  pub complexity: DatabaseProjectOptionPreset,
  pub structure: DatabaseProjectStructurePreset,
  pub default_currency: String,
  pub include_sample_rows: bool,
  pub initial_view_key: String,
  pub initial_view_kind: DatabaseViewKind,
  pub folder: Option<AssistantFolderDestination>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantPackageCatalogSource {
  pub format_version: u32,
  pub packages: Vec<AssistantPackageCatalogEntry>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantPackageCatalogEntry {
  pub id: String,
  /// Controls fresh availability; immutable definitions remain validated inventory.
  #[serde(default = "assistant_package_enabled")]
  pub enabled: bool,
  pub current: String,
  pub default_for: Vec<AssistantPackageContext>,
  pub definitions: Vec<AssistantPackageFileReference>,
}
fn assistant_package_enabled() -> bool {
  true
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantPackageFileReference {
  pub version: String,
  pub path: String,
  pub sha256: String,
}

/// A context projection, not write authority. Native uncertain-write readback
/// remains usable independently of package admission or managed readiness.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantResolvedPresentation {
  pub descriptor: AssistantPackageDescriptor,
  pub database_id: Option<DatabaseId>,
  pub row_id: Option<DatabaseRowId>,
  pub managed_schema: Option<DatabaseManagedSchema>,
  pub fields: Vec<AssistantResolvedField>,
  pub unavailable_reason: Option<String>,
}

/// An existing authorized Task container; this never requests Database creation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextDocumentTarget {
  pub database_id: uuid::Uuid,
  pub task_id: Option<uuid::Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantPreparedContextDocuments {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub workflow: Option<AssistantResolvedWorkflow>,
  pub actor_id: UserId,
  pub workspace_id: WorkspaceId,
  pub target: ContextDocumentTarget,
  pub package: AssistantPackageIdentity,
  pub answers: BTreeMap<String, AssistantValue>,
  pub locale: String,
  pub client_version: u32,
  pub documents: Vec<AssistantPreparedDocumentComponent>,
  pub folder: AssistantFolderDestination,
  pub installation: crate::database::DatabaseManagedSchemaInstallation,
  pub execution_available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum AssistantWorkflowTrigger {
  TaskCreated,
  TaskChanged,
}

/// Creation provenance for an ordinary Generic copy. These facts belong to the
/// accepted request, never to the resulting Database's managed installation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantPreparedGenericDefinition {
  pub component_id: String,
  pub definition_id: String,
  pub version: String,
  pub digest: String,
  pub selection: crate::database::DatabaseTemplateSelection,
  pub title: String,
  pub description: Option<String>,
  pub include_sample_rows: bool,
  pub default_currency: String,
}

/// A creator-bound, metadata-only preallocation plan. Full native document
/// preflight occurs after the real Workspace exists, retaining these source pins.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantPreparedWorkspaceSetup {
  pub folder: Option<AssistantFolderDestination>,
  pub actor_id: UserId,
  pub workspace_id: Option<WorkspaceId>,
  pub package: AssistantPackageIdentity,
  pub answers: BTreeMap<String, AssistantValue>,
  pub locale: String,
  pub client_version: u32,
  pub workflow: AssistantResolvedWorkflow,
  pub components: Vec<AssistantComponent>,
  pub definitions: Vec<AssistantPreparedGenericDefinition>,
  pub document_metadata: Vec<AssistantPreparedDocumentMetadata>,
  pub documents: Vec<AssistantPreparedDocumentComponent>,
  pub execution_available: bool,
}
