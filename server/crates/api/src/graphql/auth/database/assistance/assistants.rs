// SPDX-License-Identifier: AGPL-3.0-or-later
//! Typed transport for immutable package presentation. Native services own
//! authorization, resolution and canonical prepare/apply admission.
use super::*;
use myoxus_domain::assistant_package as package;

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantContext", rename_items = "PascalCase")]
pub enum AssistantPackageContextType {
  WorkspaceCreation,

  ProjectCreation,
  TaskHome,
  TaskInventory,
  TaskDetail,
  TaskCreation,
  TaskCapture,
  TaskSubtask,
  TaskMovement,
  TaskContainerAssistance,
}
impl From<package::AssistantPackageContext> for AssistantPackageContextType {
  fn from(value: package::AssistantPackageContext) -> Self {
    match value {
      package::AssistantPackageContext::WorkspaceCreation => Self::WorkspaceCreation,
      package::AssistantPackageContext::ProjectCreation => Self::ProjectCreation,
      package::AssistantPackageContext::TaskHome => Self::TaskHome,
      package::AssistantPackageContext::TaskInventory => Self::TaskInventory,
      package::AssistantPackageContext::TaskDetail => Self::TaskDetail,
      package::AssistantPackageContext::TaskCreation => Self::TaskCreation,
      package::AssistantPackageContext::TaskCapture => Self::TaskCapture,
      package::AssistantPackageContext::TaskSubtask => Self::TaskSubtask,
      package::AssistantPackageContext::TaskMovement => Self::TaskMovement,
      package::AssistantPackageContext::TaskContainerAssistance => Self::TaskContainerAssistance,
    }
  }
}
impl From<AssistantPackageContextType> for package::AssistantPackageContext {
  fn from(value: AssistantPackageContextType) -> Self {
    match value {
      AssistantPackageContextType::WorkspaceCreation => Self::WorkspaceCreation,
      AssistantPackageContextType::ProjectCreation => Self::ProjectCreation,
      AssistantPackageContextType::TaskHome => Self::TaskHome,
      AssistantPackageContextType::TaskInventory => Self::TaskInventory,
      AssistantPackageContextType::TaskDetail => Self::TaskDetail,
      AssistantPackageContextType::TaskCreation => Self::TaskCreation,
      AssistantPackageContextType::TaskCapture => Self::TaskCapture,
      AssistantPackageContextType::TaskSubtask => Self::TaskSubtask,
      AssistantPackageContextType::TaskMovement => Self::TaskMovement,
      AssistantPackageContextType::TaskContainerAssistance => Self::TaskContainerAssistance,
    }
  }
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantValueType", rename_items = "PascalCase")]
pub enum AssistantValueTypeType {
  TaskReferences,
  Document,
  Row,
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
  Folder,
}
impl From<package::AssistantValueType> for AssistantValueTypeType {
  fn from(value: package::AssistantValueType) -> Self {
    match value {
      package::AssistantValueType::TaskReferences => Self::TaskReferences,
      package::AssistantValueType::Document => Self::Document,
      package::AssistantValueType::Row => Self::Row,
      package::AssistantValueType::Text => Self::Text,
      package::AssistantValueType::Boolean => Self::Boolean,
      package::AssistantValueType::Choice => Self::Choice,
      package::AssistantValueType::Choices => Self::Choices,
      package::AssistantValueType::Date => Self::Date,
      package::AssistantValueType::DateTime => Self::DateTime,
      package::AssistantValueType::Members => Self::Members,
      package::AssistantValueType::DatabaseDestination => Self::DatabaseDestination,
      package::AssistantValueType::RowTemplate => Self::RowTemplate,
      package::AssistantValueType::RowSelection => Self::RowSelection,
      package::AssistantValueType::Folder => Self::Folder,
    }
  }
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantInputTarget", rename_items = "PascalCase")]
pub enum AssistantInputTargetType {
  Tasks,
  PrerequisiteTasks,
  SourceDocument,
  Reviewer,
  Deadline,
  WorkspaceName,
  InitialContent,
  AssistanceMode,

  ProjectTemplate,
  Goal,
  Scope,
  StartDate,
  EndDate,
  People,
  IncludeScaffold,
  IncludeComponent,
  Title,
  Description,
  Folder,
  PriorityPreset,
  ComplexityPreset,
  StructurePreset,
  DefaultCurrency,
  InitialView,
  IncludeSamples,
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
impl From<package::AssistantInputTarget> for AssistantInputTargetType {
  fn from(value: package::AssistantInputTarget) -> Self {
    match value {
      package::AssistantInputTarget::Tasks => Self::Tasks,
      package::AssistantInputTarget::PrerequisiteTasks => Self::PrerequisiteTasks,
      package::AssistantInputTarget::SourceDocument => Self::SourceDocument,
      package::AssistantInputTarget::Reviewer => Self::Reviewer,
      package::AssistantInputTarget::Deadline => Self::Deadline,
      package::AssistantInputTarget::WorkspaceName => Self::WorkspaceName,
      package::AssistantInputTarget::InitialContent => Self::InitialContent,
      package::AssistantInputTarget::AssistanceMode => Self::AssistanceMode,
      package::AssistantInputTarget::ProjectTemplate => Self::ProjectTemplate,
      package::AssistantInputTarget::Goal => Self::Goal,
      package::AssistantInputTarget::Scope => Self::Scope,
      package::AssistantInputTarget::StartDate => Self::StartDate,
      package::AssistantInputTarget::EndDate => Self::EndDate,
      package::AssistantInputTarget::People => Self::People,
      package::AssistantInputTarget::IncludeScaffold => Self::IncludeScaffold,
      package::AssistantInputTarget::IncludeComponent => Self::IncludeComponent,
      package::AssistantInputTarget::Title => Self::Title,
      package::AssistantInputTarget::Description => Self::Description,
      package::AssistantInputTarget::Folder => Self::Folder,
      package::AssistantInputTarget::PriorityPreset => Self::PriorityPreset,
      package::AssistantInputTarget::ComplexityPreset => Self::ComplexityPreset,
      package::AssistantInputTarget::StructurePreset => Self::StructurePreset,
      package::AssistantInputTarget::DefaultCurrency => Self::DefaultCurrency,
      package::AssistantInputTarget::InitialView => Self::InitialView,
      package::AssistantInputTarget::IncludeSamples => Self::IncludeSamples,
      package::AssistantInputTarget::Destination => Self::Destination,
      package::AssistantInputTarget::Assignees => Self::Assignees,
      package::AssistantInputTarget::Due => Self::Due,
      package::AssistantInputTarget::RowTemplate => Self::RowTemplate,
      package::AssistantInputTarget::CopyDescription => Self::CopyDescription,
      package::AssistantInputTarget::Parent => Self::Parent,
      package::AssistantInputTarget::Phase => Self::Phase,
      package::AssistantInputTarget::Milestone => Self::Milestone,
      package::AssistantInputTarget::MoveSelection => Self::MoveSelection,
      package::AssistantInputTarget::TaskScope => Self::TaskScope,
      package::AssistantInputTarget::TaskLifecycle => Self::TaskLifecycle,
      package::AssistantInputTarget::TaskDuePreset => Self::TaskDuePreset,
      package::AssistantInputTarget::TaskSearch => Self::TaskSearch,
      package::AssistantInputTarget::TaskAssignee => Self::TaskAssignee,
      package::AssistantInputTarget::TaskStatusGroup => Self::TaskStatusGroup,
      package::AssistantInputTarget::TaskBlockedOnly => Self::TaskBlockedOnly,
    }
  }
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantInputControlKind", rename_items = "PascalCase")]
pub enum AssistantInputControlKindType {
  TaskReferences,
  Document,
  Row,
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
  Folder,
}
impl From<package::AssistantInputControlKind> for AssistantInputControlKindType {
  fn from(value: package::AssistantInputControlKind) -> Self {
    match value {
      package::AssistantInputControlKind::TaskReferences => Self::TaskReferences,
      package::AssistantInputControlKind::Document => Self::Document,
      package::AssistantInputControlKind::Row => Self::Row,
      package::AssistantInputControlKind::Text => Self::Text,
      package::AssistantInputControlKind::Multiline => Self::Multiline,
      package::AssistantInputControlKind::Search => Self::Search,
      package::AssistantInputControlKind::Toggle => Self::Toggle,
      package::AssistantInputControlKind::Select => Self::Select,
      package::AssistantInputControlKind::RadioCards => Self::RadioCards,
      package::AssistantInputControlKind::MultiSelect => Self::MultiSelect,
      package::AssistantInputControlKind::Date => Self::Date,
      package::AssistantInputControlKind::DateTime => Self::DateTime,
      package::AssistantInputControlKind::Members => Self::Members,
      package::AssistantInputControlKind::Destination => Self::Destination,
      package::AssistantInputControlKind::RowTemplate => Self::RowTemplate,
      package::AssistantInputControlKind::Folder => Self::Folder,
    }
  }
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantTaskSummaryValue", rename_items = "PascalCase")]
pub enum AssistantTaskSummaryValueType {
  Title,
  Destination,
  Status,
  BlockedBy,
  Assignees,
  Due,
  Priority,
  RowActions,
}
impl From<package::AssistantTaskSummaryValue> for AssistantTaskSummaryValueType {
  fn from(value: package::AssistantTaskSummaryValue) -> Self {
    match value {
      package::AssistantTaskSummaryValue::Title => Self::Title,
      package::AssistantTaskSummaryValue::Destination => Self::Destination,
      package::AssistantTaskSummaryValue::Status => Self::Status,
      package::AssistantTaskSummaryValue::BlockedBy => Self::BlockedBy,
      package::AssistantTaskSummaryValue::Assignees => Self::Assignees,
      package::AssistantTaskSummaryValue::Due => Self::Due,
      package::AssistantTaskSummaryValue::Priority => Self::Priority,
      package::AssistantTaskSummaryValue::RowActions => Self::RowActions,
    }
  }
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantTaskFilter", rename_items = "PascalCase")]
pub enum AssistantTaskFilterType {
  Scope,
  Destination,
  Assignee,
  StatusGroup,
  Lifecycle,
  DuePreset,
  Search,
  BlockedOnly,
}
impl From<package::AssistantTaskFilter> for AssistantTaskFilterType {
  fn from(value: package::AssistantTaskFilter) -> Self {
    match value {
      package::AssistantTaskFilter::Scope => Self::Scope,
      package::AssistantTaskFilter::Destination => Self::Destination,
      package::AssistantTaskFilter::Assignee => Self::Assignee,
      package::AssistantTaskFilter::StatusGroup => Self::StatusGroup,
      package::AssistantTaskFilter::Lifecycle => Self::Lifecycle,
      package::AssistantTaskFilter::DuePreset => Self::DuePreset,
      package::AssistantTaskFilter::Search => Self::Search,
      package::AssistantTaskFilter::BlockedOnly => Self::BlockedOnly,
    }
  }
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantGroupRole", rename_items = "PascalCase")]
pub enum AssistantGroupRoleType {
  Content,
  Workflow,
  Details,
  More,
  Filters,
  Inventory,
  Review,
}
impl From<package::AssistantGroupRole> for AssistantGroupRoleType {
  fn from(value: package::AssistantGroupRole) -> Self {
    match value {
      package::AssistantGroupRole::Content => Self::Content,
      package::AssistantGroupRole::Workflow => Self::Workflow,
      package::AssistantGroupRole::Details => Self::Details,
      package::AssistantGroupRole::More => Self::More,
      package::AssistantGroupRole::Filters => Self::Filters,
      package::AssistantGroupRole::Inventory => Self::Inventory,
      package::AssistantGroupRole::Review => Self::Review,
    }
  }
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantActionKind", rename_items = "PascalCase")]
pub enum AssistantActionKindType {
  PrepareTaskPreparation,
  ConfigureTaskPreparation,
  PrepareTaskMaintenance,
  StartTaskMaintenance,
  PrepareTaskHandover,
  StartTaskHandover,
  PrepareDocumentReview,
  RequestDocumentReview,
  CreateWorkspace,

  OpenProjectCreation,
  Back,
  Next,
  Cancel,
  Close,
  Check,
  Refresh,
  OpenCurrentRow,
  OpenRelatedRow,
  CreateProject,
  CreateTask,
  CaptureTask,
  CreateSubtask,
  PrepareTaskMove,
  CommitTaskMove,
  PrepareDocuments,
  ApplyDocuments,
}
impl From<package::AssistantActionKind> for AssistantActionKindType {
  fn from(value: package::AssistantActionKind) -> Self {
    match value {
      package::AssistantActionKind::PrepareTaskPreparation => Self::PrepareTaskPreparation,
      package::AssistantActionKind::ConfigureTaskPreparation => Self::ConfigureTaskPreparation,
      package::AssistantActionKind::PrepareTaskMaintenance => Self::PrepareTaskMaintenance,
      package::AssistantActionKind::StartTaskMaintenance => Self::StartTaskMaintenance,
      package::AssistantActionKind::PrepareTaskHandover => Self::PrepareTaskHandover,
      package::AssistantActionKind::StartTaskHandover => Self::StartTaskHandover,
      package::AssistantActionKind::PrepareDocumentReview => Self::PrepareDocumentReview,
      package::AssistantActionKind::RequestDocumentReview => Self::RequestDocumentReview,
      package::AssistantActionKind::OpenProjectCreation => Self::OpenProjectCreation,
      package::AssistantActionKind::Back => Self::Back,
      package::AssistantActionKind::Next => Self::Next,
      package::AssistantActionKind::Cancel => Self::Cancel,
      package::AssistantActionKind::Close => Self::Close,
      package::AssistantActionKind::Check => Self::Check,
      package::AssistantActionKind::Refresh => Self::Refresh,
      package::AssistantActionKind::OpenCurrentRow => Self::OpenCurrentRow,
      package::AssistantActionKind::OpenRelatedRow => Self::OpenRelatedRow,
      package::AssistantActionKind::CreateWorkspace => Self::CreateWorkspace,
      package::AssistantActionKind::CreateProject => Self::CreateProject,
      package::AssistantActionKind::CreateTask => Self::CreateTask,
      package::AssistantActionKind::CaptureTask => Self::CaptureTask,
      package::AssistantActionKind::CreateSubtask => Self::CreateSubtask,
      package::AssistantActionKind::PrepareTaskMove => Self::PrepareTaskMove,
      package::AssistantActionKind::CommitTaskMove => Self::CommitTaskMove,
      package::AssistantActionKind::PrepareDocuments => Self::PrepareDocuments,
      package::AssistantActionKind::ApplyDocuments => Self::ApplyDocuments,
    }
  }
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantBindingKind", rename_items = "PascalCase")]
pub enum AssistantBindingKindType {
  Role,
  Field,
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantVisibilityKind", rename_items = "PascalCase")]
pub enum AssistantVisibilityKindType {
  Present,
  Equals,
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantCellPresence", rename_items = "PascalCase")]
pub enum AssistantCellPresenceType {
  Always,
  Present,
  Empty,
}
impl From<package::AssistantCellPresence> for AssistantCellPresenceType {
  fn from(v: package::AssistantCellPresence) -> Self {
    match v {
      package::AssistantCellPresence::Always => Self::Always,
      package::AssistantCellPresence::Present => Self::Present,
      package::AssistantCellPresence::Empty => Self::Empty,
    }
  }
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantControlKind", rename_items = "PascalCase")]
pub enum AssistantControlKindType {
  TaskPreparationReview,
  TaskMaintenanceReview,
  TaskHandoverReview,
  WorkspaceReview,

  Input,
  NativeCell,
  Parent,
  BlockedBy,
  Follow,
  Reminder,
  DestinationAudience,
  MoveSelection,
  MoveImpact,
  CurrentOwnerReadback,
  RowContent,
  SourceOrigin,
  Activity,
  RowLifecycle,
  TaskSummary,
  TaskFilter,
  OfferingSelection,
  ProjectReview,
  DocumentReview,
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantLocalizedText")]
pub struct AssistantLocalizedTextObjectType {
  pub en: String,
  pub de: String,
  pub fr: String,
  pub es: String,
}
impl From<package::AssistantLocalizedText> for AssistantLocalizedTextObjectType {
  fn from(v: package::AssistantLocalizedText) -> Self {
    Self {
      en: v.en,
      de: v.de,
      fr: v.fr,
      es: v.es,
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantPackageIdentity")]
pub struct AssistantPackageIdentityObjectType {
  pub id: String,
  pub version: String,
  pub digest: String,
}
impl From<package::AssistantPackageIdentity> for AssistantPackageIdentityObjectType {
  fn from(v: package::AssistantPackageIdentity) -> Self {
    Self {
      id: v.id,
      version: v.version,
      digest: v.digest,
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantValue")]
pub struct AssistantValueObjectType {
  pub task_references: Option<Vec<AssistantTaskReferenceObjectType>>,
  pub document_id: Option<ID>,
  pub row_id: Option<ID>,
  pub kind: AssistantValueTypeType,
  pub text: Option<String>,
  pub boolean: Option<bool>,
  pub choice: Option<String>,
  pub choices: Option<Vec<String>>,
  pub date: Option<DatabaseDateCellValueObjectType>,
  pub date_time: Option<DatabaseDateTimeCellValueObjectType>,
  pub member_ids: Option<Vec<ID>>,
  pub database_id: Option<ID>,
  pub row_template_id: Option<ID>,
  pub row_selection: Option<Vec<DatabaseTaskMoveSelectionObjectType>>,
  pub folder: Option<AssistantFolderDestinationObjectType>,
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantTaskReference")]
pub struct AssistantTaskReferenceObjectType {
  pub database_id: ID,
  pub row_id: ID,
}
impl From<package::AssistantTaskReference> for AssistantTaskReferenceObjectType {
  fn from(value: package::AssistantTaskReference) -> Self {
    Self {
      database_id: ID(value.database_id.to_string()),
      row_id: ID(value.row_id.to_string()),
    }
  }
}
impl From<package::AssistantValue> for AssistantValueObjectType {
  fn from(v: package::AssistantValue) -> Self {
    let mut o = Self {
      task_references: None,
      document_id: None,
      row_id: None,
      kind: AssistantValueTypeType::Text,
      text: None,
      boolean: None,
      choice: None,
      choices: None,
      date: None,
      date_time: None,
      member_ids: None,
      database_id: None,
      row_template_id: None,
      row_selection: None,
      folder: None,
    };
    match v {
      package::AssistantValue::TaskReferences(references) => {
        o.kind = AssistantValueTypeType::TaskReferences;
        o.task_references = Some(references.into_iter().map(Into::into).collect());
      }
      package::AssistantValue::Document(v) => {
        o.kind = AssistantValueTypeType::Document;
        o.document_id = Some(ID(v.to_string()))
      }
      package::AssistantValue::Row(v) => {
        o.kind = AssistantValueTypeType::Row;
        o.row_id = Some(ID(v.to_string()))
      }
      package::AssistantValue::Text(v) => {
        o.kind = AssistantValueTypeType::Text;
        o.text = Some(v)
      }
      package::AssistantValue::Boolean(v) => {
        o.kind = AssistantValueTypeType::Boolean;
        o.boolean = Some(v)
      }
      package::AssistantValue::Choice(v) => {
        o.kind = AssistantValueTypeType::Choice;
        o.choice = Some(v)
      }
      package::AssistantValue::Choices(v) => {
        o.kind = AssistantValueTypeType::Choices;
        o.choices = Some(v)
      }
      package::AssistantValue::Date(v) => {
        o.kind = AssistantValueTypeType::Date;
        o.date = Some(DatabaseDateCellValueObjectType {
          start: v.start,
          end: v.end,
        })
      }
      package::AssistantValue::DateTime(v) => {
        o.kind = AssistantValueTypeType::DateTime;
        o.date_time = Some(DatabaseDateTimeCellValueObjectType {
          start: v.start,
          end: v.end,
          all_day: v.all_day,
          time_zone: v.time_zone,
        })
      }
      package::AssistantValue::Members(v) => {
        o.kind = AssistantValueTypeType::Members;
        o.member_ids = Some(v.into_iter().map(|id| ID(id.to_string())).collect())
      }
      package::AssistantValue::DatabaseDestination(v) => {
        o.kind = AssistantValueTypeType::DatabaseDestination;
        o.database_id = Some(ID(v.to_string()))
      }
      package::AssistantValue::RowTemplate(v) => {
        o.kind = AssistantValueTypeType::RowTemplate;
        o.row_template_id = Some(ID(v.to_string()))
      }
      package::AssistantValue::RowSelection(v) => {
        o.kind = AssistantValueTypeType::RowSelection;
        o.row_selection = Some(
          v.into_iter()
            .map(|r| DatabaseTaskMoveSelectionObjectType {
              row_id: ID(r.row_id.to_string()),
              expected_edit_revision: r.expected_edit_revision,
              cell_revisions: r
                .cell_revisions
                .into_iter()
                .map(|(field_id, revision)| DatabaseTaskMoveCellRevisionObjectType {
                  field_id: ID(field_id.to_string()),
                  expected_edit_revision: revision,
                })
                .collect(),
            })
            .collect(),
        )
      }
      package::AssistantValue::Folder(v) => {
        o.kind = AssistantValueTypeType::Folder;
        o.folder = Some(v.into())
      }
    }
    o
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantFolderDestinationKind", rename_items = "PascalCase")]
pub enum AssistantFolderDestinationKindType {
  Existing,
  New,
}

#[derive(SimpleObject)]
#[graphql(name = "AssistantFolderDestination")]
pub struct AssistantFolderDestinationObjectType {
  pub kind: AssistantFolderDestinationKindType,
  pub id: Option<String>,
  pub name: Option<String>,
  pub parent: Option<String>,
}
impl From<package::AssistantFolderDestination> for AssistantFolderDestinationObjectType {
  fn from(value: package::AssistantFolderDestination) -> Self {
    match value {
      package::AssistantFolderDestination::Existing { id } => Self {
        kind: AssistantFolderDestinationKindType::Existing,
        id: Some(id),
        name: None,
        parent: None,
      },
      package::AssistantFolderDestination::New { name, parent } => Self {
        kind: AssistantFolderDestinationKindType::New,
        id: None,
        name: Some(name),
        parent,
      },
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantVisibility")]
pub struct AssistantVisibilityObjectType {
  pub kind: AssistantVisibilityKindType,
  pub input: String,
  pub value: Option<AssistantValueObjectType>,
}
impl From<package::AssistantVisibility> for AssistantVisibilityObjectType {
  fn from(v: package::AssistantVisibility) -> Self {
    match v {
      package::AssistantVisibility::Present { input } => Self {
        kind: AssistantVisibilityKindType::Present,
        input,
        value: None,
      },
      package::AssistantVisibility::Equals { input, value } => Self {
        kind: AssistantVisibilityKindType::Equals,
        input,
        value: Some(value.into()),
      },
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantChoice")]
pub struct AssistantChoiceObjectType {
  pub id: String,
  pub label: AssistantLocalizedTextObjectType,
  pub value: AssistantValueObjectType,
}
impl From<package::AssistantChoice> for AssistantChoiceObjectType {
  fn from(v: package::AssistantChoice) -> Self {
    Self {
      id: v.id,
      label: v.label.into(),
      value: v.value.into(),
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantInput")]
pub struct AssistantInputObjectType {
  pub id: String,
  pub target: AssistantInputTargetType,
  pub label: AssistantLocalizedTextObjectType,
  pub description: Option<AssistantLocalizedTextObjectType>,
  pub value_type: AssistantValueTypeType,
  pub required: bool,
  pub default_value: Option<AssistantValueObjectType>,
  pub choices: Vec<AssistantChoiceObjectType>,
  pub visible_when: Option<AssistantVisibilityObjectType>,
}
impl From<package::AssistantInput> for AssistantInputObjectType {
  fn from(v: package::AssistantInput) -> Self {
    Self {
      id: v.id,
      target: v.target.into(),
      label: v.label.into(),
      description: v.description.map(Into::into),
      value_type: v.value_type.into(),
      required: v.required,
      default_value: v.default.map(Into::into),
      choices: v.choices.into_iter().map(Into::into).collect(),
      visible_when: v.visible_when.map(Into::into),
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantFieldBinding")]
pub struct AssistantFieldBindingObjectType {
  pub kind: AssistantBindingKindType,
  pub role_key: Option<String>,
  pub field_key: Option<String>,
}
impl From<package::AssistantFieldBinding> for AssistantFieldBindingObjectType {
  fn from(v: package::AssistantFieldBinding) -> Self {
    match v {
      package::AssistantFieldBinding::Role { role_key } => Self {
        kind: AssistantBindingKindType::Role,
        role_key: Some(role_key),
        field_key: None,
      },
      package::AssistantFieldBinding::Field { field_key } => Self {
        kind: AssistantBindingKindType::Field,
        role_key: None,
        field_key: Some(field_key),
      },
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantControl")]
pub struct AssistantControlObjectType {
  pub presence: Option<AssistantCellPresenceType>,
  pub kind: AssistantControlKindType,
  pub input: Option<String>,
  pub control: Option<AssistantInputControlKindType>,
  pub binding: Option<AssistantFieldBindingObjectType>,
  pub offsets_minutes: Option<Vec<i64>>,
  pub default_offset_minutes: Option<i64>,
  pub allow_custom_offset: Option<bool>,
  pub value: Option<AssistantTaskSummaryValueType>,
  pub filter: Option<AssistantTaskFilterType>,
  pub search: Option<bool>,
}
impl From<package::AssistantControl> for AssistantControlObjectType {
  fn from(v: package::AssistantControl) -> Self {
    let mut o = Self {
      presence: None,
      kind: AssistantControlKindType::Input,
      input: None,
      control: None,
      binding: None,
      offsets_minutes: None,
      default_offset_minutes: None,
      allow_custom_offset: None,
      value: None,
      filter: None,
      search: None,
    };
    match v {
      package::AssistantControl::OfferingSelection { search } => {
        o.kind = AssistantControlKindType::OfferingSelection;
        o.search = Some(search)
      }
      package::AssistantControl::WorkspaceReview => o.kind = AssistantControlKindType::WorkspaceReview,
      package::AssistantControl::ProjectReview => o.kind = AssistantControlKindType::ProjectReview,
      package::AssistantControl::DocumentReview => o.kind = AssistantControlKindType::DocumentReview,
      package::AssistantControl::TaskPreparationReview => o.kind = AssistantControlKindType::TaskPreparationReview,
      package::AssistantControl::TaskMaintenanceReview => o.kind = AssistantControlKindType::TaskMaintenanceReview,
      package::AssistantControl::TaskHandoverReview => o.kind = AssistantControlKindType::TaskHandoverReview,
      package::AssistantControl::Input { input, control } => {
        o.kind = AssistantControlKindType::Input;
        o.input = Some(input);
        o.control = Some(control.into())
      }
      package::AssistantControl::NativeCell { binding, presence } => {
        o.presence = Some(presence.into());
        o.kind = AssistantControlKindType::NativeCell;
        o.binding = Some(binding.into())
      }
      package::AssistantControl::Reminder {
        offsets_minutes,
        default_offset_minutes,
        allow_custom_offset,
      } => {
        o.kind = AssistantControlKindType::Reminder;
        o.offsets_minutes = Some(offsets_minutes);
        o.default_offset_minutes = Some(default_offset_minutes);
        o.allow_custom_offset = Some(allow_custom_offset)
      }
      package::AssistantControl::TaskSummary { value } => {
        o.kind = AssistantControlKindType::TaskSummary;
        o.value = Some(value.into())
      }
      package::AssistantControl::TaskFilter { filter } => {
        o.kind = AssistantControlKindType::TaskFilter;
        o.filter = Some(filter.into())
      }
      package::AssistantControl::Parent => o.kind = AssistantControlKindType::Parent,
      package::AssistantControl::BlockedBy => o.kind = AssistantControlKindType::BlockedBy,
      package::AssistantControl::Follow => o.kind = AssistantControlKindType::Follow,
      package::AssistantControl::DestinationAudience => o.kind = AssistantControlKindType::DestinationAudience,
      package::AssistantControl::MoveSelection => o.kind = AssistantControlKindType::MoveSelection,
      package::AssistantControl::MoveImpact => o.kind = AssistantControlKindType::MoveImpact,
      package::AssistantControl::CurrentOwnerReadback => o.kind = AssistantControlKindType::CurrentOwnerReadback,
      package::AssistantControl::RowContent => o.kind = AssistantControlKindType::RowContent,
      package::AssistantControl::SourceOrigin => o.kind = AssistantControlKindType::SourceOrigin,
      package::AssistantControl::Activity => o.kind = AssistantControlKindType::Activity,
      package::AssistantControl::RowLifecycle => o.kind = AssistantControlKindType::RowLifecycle,
    }
    o
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantGroup")]
pub struct AssistantGroupObjectType {
  pub id: String,
  pub title: Option<AssistantLocalizedTextObjectType>,
  pub role: AssistantGroupRoleType,
  pub controls: Vec<AssistantControlObjectType>,
  pub visible_when: Option<AssistantVisibilityObjectType>,
}
impl From<package::AssistantGroup> for AssistantGroupObjectType {
  fn from(v: package::AssistantGroup) -> Self {
    Self {
      id: v.id,
      title: v.title.map(Into::into),
      role: v.role.into(),
      controls: v.controls.into_iter().map(Into::into).collect(),
      visible_when: v.visible_when.map(Into::into),
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantAction")]
pub struct AssistantActionObjectType {
  pub id: String,
  pub label: Option<AssistantLocalizedTextObjectType>,
  pub action: AssistantActionKindType,
  pub component: Option<String>,
  pub target_step: Option<String>,
  pub dialog: Option<String>,
  pub visible_when: Option<AssistantVisibilityObjectType>,
}
impl From<package::AssistantPresentationAction> for AssistantActionObjectType {
  fn from(v: package::AssistantPresentationAction) -> Self {
    Self {
      id: v.id,
      label: v.label.map(Into::into),
      action: v.action.into(),
      component: v.component,
      target_step: v.target_step,
      dialog: v.dialog,
      visible_when: v.visible_when.map(Into::into),
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantStep")]
pub struct AssistantStepObjectType {
  pub id: String,
  pub title: AssistantLocalizedTextObjectType,
  pub groups: Vec<AssistantGroupObjectType>,
  pub actions: Vec<AssistantActionObjectType>,
}
impl From<package::AssistantStep> for AssistantStepObjectType {
  fn from(v: package::AssistantStep) -> Self {
    Self {
      id: v.id,
      title: v.title.into(),
      groups: v.groups.into_iter().map(Into::into).collect(),
      actions: v.actions.into_iter().map(Into::into).collect(),
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantDialog")]
pub struct AssistantDialogObjectType {
  pub id: String,
  pub title: AssistantLocalizedTextObjectType,
  pub groups: Vec<AssistantGroupObjectType>,
  pub actions: Vec<AssistantActionObjectType>,
}
impl From<package::AssistantDialog> for AssistantDialogObjectType {
  fn from(v: package::AssistantDialog) -> Self {
    Self {
      id: v.id,
      title: v.title.into(),
      groups: v.groups.into_iter().map(Into::into).collect(),
      actions: v.actions.into_iter().map(Into::into).collect(),
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantPresentation")]
pub struct AssistantPresentationObjectType {
  pub guided_help: Option<AssistantStepObjectType>,
  pub steps: Vec<AssistantStepObjectType>,
  pub dialogs: Vec<AssistantDialogObjectType>,
}
impl From<package::AssistantPresentation> for AssistantPresentationObjectType {
  fn from(v: package::AssistantPresentation) -> Self {
    Self {
      guided_help: v.guided_help.map(Into::into),
      steps: v.steps.into_iter().map(Into::into).collect(),
      dialogs: v.dialogs.into_iter().map(Into::into).collect(),
    }
  }
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantArtworkRole", rename_items = "PascalCase")]
pub enum AssistantArtworkRoleType {
  Illustration,
  Diagram,
}
impl From<myoxus_domain::feature_bundle::FeatureArtworkRole> for AssistantArtworkRoleType {
  fn from(value: myoxus_domain::feature_bundle::FeatureArtworkRole) -> Self {
    match value {
      myoxus_domain::feature_bundle::FeatureArtworkRole::Illustration => Self::Illustration,
      myoxus_domain::feature_bundle::FeatureArtworkRole::Diagram => Self::Diagram,
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantArtwork")]
pub struct AssistantArtworkObjectType {
  pub role: Option<AssistantArtworkRoleType>,
  pub step: String,
  pub group: String,
  pub url: String,
  pub digest: String,
  pub media_type: String,
  pub width: i32,
  pub height: i32,
  pub alternative: AssistantLocalizedTextObjectType,
  pub caption: Option<AssistantLocalizedTextObjectType>,
}
impl From<package::AssistantArtworkSlot> for AssistantArtworkObjectType {
  fn from(value: package::AssistantArtworkSlot) -> Self {
    Self {
      role: value.role.map(Into::into),
      step: value.step,
      group: value.group,
      url: format!(
        "/api/templates/features/{}/{}/{}/{}",
        value.bundle.id, value.bundle.version, value.bundle.sha256, value.component
      ),
      digest: value.digest,
      media_type: value.media_type,
      width: value.width as i32,
      height: value.height as i32,
      alternative: value.alternative.into(),
      caption: value.caption.map(Into::into),
    }
  }
}

#[derive(SimpleObject)]
#[graphql(name = "AssistantDocumentSource")]
pub struct AssistantDocumentSourceObjectType {
  pub step: String,
  pub group: String,
  /// Native document slug/version; the Library resolver supplies Registry UUIDs.
  pub template_id: String,
  pub version: String,
  pub digest: String,
}
impl From<package::AssistantDocumentSourceSlot> for AssistantDocumentSourceObjectType {
  fn from(value: package::AssistantDocumentSourceSlot) -> Self {
    Self {
      step: value.step,
      group: value.group,
      template_id: value.template_id,
      version: value.version,
      digest: value.digest,
    }
  }
}

#[derive(SimpleObject)]
#[graphql(name = "AssistantDocumentComponentSource")]
pub struct AssistantDocumentComponentSourceObjectType {
  pub component_id: String,
  pub template_id: String,
  pub version: String,
  pub digest: String,
}
impl From<package::AssistantDocumentComponentSource> for AssistantDocumentComponentSourceObjectType {
  fn from(value: package::AssistantDocumentComponentSource) -> Self {
    Self {
      component_id: value.component_id,
      template_id: value.template_id,
      version: value.version,
      digest: value.digest,
    }
  }
}

#[derive(SimpleObject)]
#[graphql(name = "AssistantPackage")]
pub struct AssistantPackageObjectType {
  pub artwork: Vec<AssistantArtworkObjectType>,
  pub document_sources: Vec<AssistantDocumentSourceObjectType>,
  pub document_components: Vec<AssistantDocumentComponentSourceObjectType>,
  pub components: Vec<AssistantComponentObjectType>,
  pub identity: AssistantPackageIdentityObjectType,
  pub name: AssistantLocalizedTextObjectType,
  pub description: AssistantLocalizedTextObjectType,
  pub contexts: Vec<AssistantPackageContextType>,
  pub default_for: Vec<AssistantPackageContextType>,
  pub inputs: Vec<AssistantInputObjectType>,
  pub presentation: AssistantPresentationObjectType,
}
impl From<package::AssistantPackageDescriptor> for AssistantPackageObjectType {
  fn from(v: package::AssistantPackageDescriptor) -> Self {
    Self {
      artwork: v.artwork.into_iter().map(Into::into).collect(),
      document_sources: v.document_sources.into_iter().map(Into::into).collect(),
      document_components: v.document_components.into_iter().map(Into::into).collect(),
      components: v.components.into_iter().map(Into::into).collect(),
      identity: v.identity.into(),
      name: v.name.into(),
      description: v.description.into(),
      contexts: v.contexts.into_iter().map(Into::into).collect(),
      default_for: v.default_for.into_iter().map(Into::into).collect(),
      inputs: v.inputs.into_iter().map(Into::into).collect(),
      presentation: v.presentation.into(),
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantResolvedField")]
pub struct AssistantResolvedFieldObjectType {
  pub name: String,
  pub field_type: DatabaseFieldKindType,
  pub required: bool,
  pub binding: AssistantFieldBindingObjectType,
  pub field_id: ID,
  pub config: DatabaseFieldConfigObjectType,
}
impl From<package::AssistantResolvedField> for AssistantResolvedFieldObjectType {
  fn from(v: package::AssistantResolvedField) -> Self {
    Self {
      name: v.name,
      field_type: v.field_type.into(),
      required: v.required,
      binding: v.binding.into(),
      field_id: ID(v.field_id.to_string()),
      config: map_field_config(v.config),
    }
  }
}

#[derive(SimpleObject)]
#[graphql(name = "AssistantResolvedPresentation")]
pub struct AssistantResolvedPresentationObjectType {
  pub descriptor: AssistantPackageObjectType,
  pub database_id: Option<ID>,
  pub row_id: Option<ID>,
  pub managed_schema: Option<DatabaseManagedSchemaObjectType>,
  pub fields: Vec<AssistantResolvedFieldObjectType>,
  pub unavailable_reason: Option<String>,
}
impl From<package::AssistantResolvedPresentation> for AssistantResolvedPresentationObjectType {
  fn from(v: package::AssistantResolvedPresentation) -> Self {
    Self {
      descriptor: v.descriptor.into(),
      database_id: v.database_id.map(|v| ID(v.to_string())),
      row_id: v.row_id.map(|v| ID(v.to_string())),
      managed_schema: v.managed_schema.map(map_managed_schema),
      fields: v.fields.into_iter().map(Into::into).collect(),
      unavailable_reason: v.unavailable_reason,
    }
  }
}

#[derive(InputObject, Clone)]
pub struct AssistantPackageIdentityInput {
  pub id: String,
  pub version: String,
  pub digest: String,
}
impl From<AssistantPackageIdentityInput> for package::AssistantPackageIdentity {
  fn from(v: AssistantPackageIdentityInput) -> Self {
    Self {
      id: v.id,
      version: v.version,
      digest: v.digest,
    }
  }
}
#[derive(InputObject)]
pub struct PrepareProjectAssistantInput {
  pub locale: Option<String>,
  pub client_version: Option<i32>,
  pub identity: AssistantPackageIdentityInput,
  /// Bounded answers decode to the package's declared native value types.
  pub answers: Json<JsonValue>,
}
#[derive(InputObject)]
pub struct AssistantDocumentSourceInput {
  pub identity: AssistantPackageIdentityInput,
  pub step: String,
  pub group: String,
  pub source_digest: String,
  pub locale: String,
  pub client_version: i32,
}
#[derive(InputObject)]
pub struct ProjectAssistantConfirmationInput {
  pub request_id: Option<ID>,
  pub admission_confirmation: Option<String>,
  pub locale: Option<String>,
  pub client_version: Option<i32>,
  pub identity: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
  pub plan_digest: String,
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantNamedValue")]
pub struct AssistantNamedValueObjectType {
  pub input: String,
  pub value: AssistantValueObjectType,
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantProjectScaffoldKind", rename_items = "PascalCase")]
pub enum AssistantProjectScaffoldKindType {
  Phase,
  Milestone,
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantProjectScaffold")]
pub struct AssistantProjectScaffoldObjectType {
  pub id: String,
  pub kind: AssistantProjectScaffoldKindType,
  pub title: AssistantLocalizedTextObjectType,
}
impl From<package::AssistantProjectScaffold> for AssistantProjectScaffoldObjectType {
  fn from(value: package::AssistantProjectScaffold) -> Self {
    Self {
      id: value.id,
      kind: match value.kind {
        package::AssistantProjectScaffoldKind::Phase => AssistantProjectScaffoldKindType::Phase,
        package::AssistantProjectScaffoldKind::Milestone => AssistantProjectScaffoldKindType::Milestone,
      },
      title: value.title.into(),
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantProjectSetupFacts")]
pub struct AssistantProjectSetupFactsObjectType {
  pub goal: Option<String>,
  pub scope: Option<String>,
  pub start_date: Option<DatabaseDateCellValueObjectType>,
  pub end_date: Option<DatabaseDateCellValueObjectType>,
  pub people: Vec<ID>,
  pub scaffold: Vec<AssistantProjectScaffoldObjectType>,
}
impl From<package::AssistantProjectSetupFacts> for AssistantProjectSetupFactsObjectType {
  fn from(value: package::AssistantProjectSetupFacts) -> Self {
    Self {
      goal: value.goal,
      scope: value.scope,
      start_date: value.start_date.map(|date| DatabaseDateCellValueObjectType {
        start: date.start,
        end: date.end,
      }),
      end_date: value.end_date.map(|date| DatabaseDateCellValueObjectType {
        start: date.start,
        end: date.end,
      }),
      people: value.people.into_iter().map(|id| ID(id.to_string())).collect(),
      scaffold: value.scaffold.into_iter().map(Into::into).collect(),
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantProjectSetupCounts")]
pub struct AssistantProjectSetupCountsObjectType {
  pub phases: i32,
  pub milestones: i32,
  pub sample_rows: i32,
  pub explicit_tasks: i32,
}
impl TryFrom<package::AssistantProjectSetupCounts> for AssistantProjectSetupCountsObjectType {
  type Error = Error;
  fn try_from(value: package::AssistantProjectSetupCounts) -> Result<Self> {
    Ok(Self {
      phases: value.phases.try_into().map_err(|_| invalid_package_input())?,
      milestones: value.milestones.try_into().map_err(|_| invalid_package_input())?,
      sample_rows: value.sample_rows.try_into().map_err(|_| invalid_package_input())?,
      explicit_tasks: value.explicit_tasks.try_into().map_err(|_| invalid_package_input())?,
    })
  }
}
#[derive(SimpleObject)]
#[graphql(name = "PreparedProjectAssistant")]
pub struct PreparedProjectAssistantObjectType {
  pub document_metadata: Vec<AssistantPreparedDocumentMetadataObjectType>,
  pub client_version: Option<i32>,
  pub documents: Vec<AssistantPreparedDocumentComponentObjectType>,
  pub locale: String,
  pub setup: AssistantProjectSetupFactsObjectType,
  pub counts: AssistantProjectSetupCountsObjectType,
  pub execution_available: bool,
  pub package: AssistantPackageIdentityObjectType,
  pub plan_digest: String,
  pub template_id: String,
  pub template_version: String,
  pub template_digest: String,
  pub answers: Vec<AssistantNamedValueObjectType>,
  pub title: String,
  pub description: Option<String>,
  pub priority: ProjectOptionPresetType,
  pub complexity: ProjectOptionPresetType,
  pub structure: ProjectStructurePresetType,
  pub default_currency: String,
  pub include_sample_rows: bool,
  pub initial_view_key: String,
  pub initial_view_kind: DatabaseViewKindType,
  pub folder: Option<AssistantFolderDestinationObjectType>,
}

#[derive(SimpleObject)]
#[graphql(name = "AssistantPreparedDocumentComponent")]
pub struct AssistantPreparedDocumentComponentObjectType {
  pub source: AssistantDocumentComponentSourceObjectType,
  pub source_revision_id: ID,
  pub source_content_digest: String,
  pub locale: String,
  pub title: String,
  pub folder: AssistantFolderDestinationObjectType,
}
impl From<package::AssistantPreparedDocumentComponent> for AssistantPreparedDocumentComponentObjectType {
  fn from(value: package::AssistantPreparedDocumentComponent) -> Self {
    Self {
      source: value.source.into(),
      source_revision_id: ID(value.source_revision_id.to_string()),
      source_content_digest: value.source_content_digest,
      locale: value.locale,
      title: value.title,
      folder: value.folder.into(),
    }
  }
}

/// Preallocation references expose published metadata only; native content is
/// captured only after the actual Workspace and folder are available.
#[derive(SimpleObject)]
#[graphql(name = "AssistantPreparedDocumentMetadata")]
pub struct AssistantPreparedDocumentMetadataObjectType {
  pub source: AssistantDocumentComponentSourceObjectType,
  pub source_revision_id: ID,
  pub locale: String,
  pub title: String,
  pub folder: AssistantFolderDestinationObjectType,
}
impl From<package::AssistantPreparedDocumentMetadata> for AssistantPreparedDocumentMetadataObjectType {
  fn from(value: package::AssistantPreparedDocumentMetadata) -> Self {
    Self {
      source: value.source.into(),
      source_revision_id: ID(value.source_revision_id.to_string()),
      locale: value.locale,
      title: value.title,
      folder: value.folder.into(),
    }
  }
}

fn map_prepared_project(prepared: package::AssistantPreparedProject) -> Result<PreparedProjectAssistantObjectType> {
  let plan_digest = myoxus_application::workspace::assistant_packages::plan_digest(&prepared);
  Ok(PreparedProjectAssistantObjectType {
    document_metadata: prepared.document_metadata.into_iter().map(Into::into).collect(),
    documents: prepared.documents.into_iter().map(Into::into).collect(),
    client_version: prepared
      .client_version
      .map(i32::try_from)
      .transpose()
      .map_err(|_| invalid_package_input())?,
    locale: prepared.locale,
    setup: prepared.setup.into(),
    counts: prepared.counts.try_into()?,
    execution_available: prepared.execution_available,
    package: prepared.package.into(),
    plan_digest,
    template_id: prepared.template_id,
    template_version: prepared.template_version,
    template_digest: prepared.template_digest,
    answers: prepared
      .answers
      .into_iter()
      .map(|(input, value)| AssistantNamedValueObjectType {
        input,
        value: value.into(),
      })
      .collect(),
    title: prepared.title,
    description: prepared.description,
    priority: prepared.priority.into(),
    complexity: prepared.complexity.into(),
    structure: prepared.structure.into(),
    default_currency: prepared.default_currency,
    include_sample_rows: prepared.include_sample_rows,
    initial_view_key: prepared.initial_view_key,
    initial_view_kind: prepared.initial_view_kind.into(),
    folder: prepared.folder.map(Into::into),
  })
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "ProjectSetupStatus", rename_items = "PascalCase")]
pub enum ProjectSetupStatusType {
  Ready,
  Pending,
  StopRequested,
  Stopped,
  ReReviewRequired,
  Unavailable,
}

/// Accepted identities survive lost responses and source withdrawal. Readback
/// exposes the native state; it never starts or resumes publication.
#[derive(SimpleObject)]
#[graphql(name = "ProjectSetup")]
pub struct ProjectSetupObjectType {
  pub request_id: ID,
  pub status: ProjectSetupStatusType,
  pub reserved_database_id: ID,
  pub accepted_plan: PreparedProjectAssistantObjectType,
  pub accepted_descriptor: Option<AssistantPackageObjectType>,
  pub current_review: Option<PreparedProjectAssistantObjectType>,
  pub database: Option<DatabaseRecordObjectType>,
  pub reason_code: Option<String>,
  pub folder_id: Option<String>,
  pub placement_complete: bool,
  pub documents: Vec<ProjectSetupDocumentObjectType>,
}

#[derive(SimpleObject)]
#[graphql(name = "ProjectSetupDocument")]
pub struct ProjectSetupDocumentObjectType {
  pub component_id: String,
  pub reserved_document_id: ID,
  /// Available only after the native leaf/root transaction acknowledged it.
  pub external_id: Option<String>,
  pub created: bool,
  pub placed: bool,
}

pub(crate) fn map_project_setup(
  outcome: myoxus_application::workspace::ProjectStarterOutcome,
) -> Result<ProjectSetupObjectType> {
  use myoxus_application::workspace::ProjectStarterStatus;
  let initial_key = outcome
    .current_review
    .as_ref()
    .unwrap_or(&outcome.accepted.plan)
    .initial_view_key
    .clone();
  let database = outcome.database.map(|record| {
    let initial = record
      .database
      .managed_installation
      .as_ref()
      .and_then(|installation| installation.view_bindings.get(&initial_key))
      .copied();
    let mut result = map_record(record);
    result.initial_view_id = initial.map(|id| ID(id.to_string()));
    result
  });
  Ok(ProjectSetupObjectType {
    folder_id: outcome.accepted.ids.folder_id.clone(),
    placement_complete: outcome.accepted.progress.placement_complete,
    documents: outcome
      .documents
      .into_iter()
      .map(|document| ProjectSetupDocumentObjectType {
        component_id: document.component_id,
        reserved_document_id: ID(document.reserved_document_id.to_string()),
        external_id: document.external_id,
        created: document.created,
        placed: document.placed,
      })
      .collect(),
    request_id: ID(outcome.accepted.request_id.to_string()),
    status: match outcome.status {
      ProjectStarterStatus::Ready => ProjectSetupStatusType::Ready,
      ProjectStarterStatus::Pending => ProjectSetupStatusType::Pending,
      ProjectStarterStatus::StopRequested => ProjectSetupStatusType::StopRequested,
      ProjectStarterStatus::Stopped => ProjectSetupStatusType::Stopped,
      ProjectStarterStatus::ReReviewRequired => ProjectSetupStatusType::ReReviewRequired,
      ProjectStarterStatus::Unavailable => ProjectSetupStatusType::Unavailable,
    },
    reserved_database_id: ID(outcome.accepted.ids.database_id.to_string()),
    accepted_descriptor: outcome.accepted_descriptor.map(Into::into),
    accepted_plan: map_prepared_project(outcome.accepted.plan)?,
    current_review: outcome.current_review.map(map_prepared_project).transpose()?,
    database,
    reason_code: outcome.reason_code,
  })
}

pub(crate) async fn project_setup(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  request_id: ID,
) -> Result<Option<ProjectSetupObjectType>> {
  let (state, session) = require_session(ctx).await?;
  let packages = package_service(&state)?;
  state
    .workspace()
    .get_project_starter(
      session.user.id,
      workspace_id,
      parse_uuid_id(&request_id, "requestId")?,
      &packages,
    )
    .await
    .map_err(map_project_starter_error)?
    .map(map_project_setup)
    .transpose()
}

#[derive(InputObject)]
pub struct StopProjectSetupInput {
  pub workspace_id: ID,
  pub request_id: ID,
}

pub(crate) async fn stop_project_setup(
  ctx: &Context<'_>,
  input: StopProjectSetupInput,
) -> Result<ProjectSetupObjectType> {
  let (state, session) = require_session(ctx).await?;
  let packages = package_service(&state)?;
  let outcome = state
    .workspace()
    .stop_project_starter(
      session.user.id,
      parse_uuid_id(&input.workspace_id, "workspaceId")?,
      parse_uuid_id(&input.request_id, "requestId")?,
      &packages,
    )
    .await
    .map_err(map_project_starter_error)?;
  map_project_setup(outcome)
}

pub(crate) fn package_service(
  state: &ApiState,
) -> Result<Arc<myoxus_application::workspace::assistant_packages::AssistantPackageService>> {
  state.assistant_packages().ok_or_else(|| {
    Error::new("assistant packages unavailable")
      .extend_with(|_, e| e.set("code", myoxus_application::database::ERR_STORAGE))
  })
}
pub(crate) fn package_answers(value: JsonValue) -> Result<BTreeMap<String, package::AssistantValue>> {
  if serde_json::to_vec(&value).map_err(|_| invalid_package_input())?.len() > package::ASSISTANT_INPUT_MAX_BYTES {
    return Err(invalid_package_input());
  }
  serde_json::from_value(value).map_err(|_| invalid_package_input())
}
fn invalid_package_input() -> Error {
  Error::new("invalid assistant package input")
    .extend_with(|_, e| e.set("code", myoxus_application::database::ERR_QUERY_INVALID))
}

fn project_client_version(value: Option<i32>) -> Result<Option<u32>> {
  value
    .map(|value| {
      u32::try_from(value)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(invalid_package_input)
    })
    .transpose()
}

pub(crate) async fn list_assistant_packages(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  context: AssistantPackageContextType,
) -> Result<Vec<AssistantPackageObjectType>> {
  let (state, snapshot) = require_session(ctx).await?;
  service(&state)?
    .views
    .assert_workspace_read(snapshot.user.id, workspace_id)
    .await
    .map_err(map_database_error)?;
  Ok(
    package_service(&state)?
      .list(context.into())
      .into_iter()
      .map(Into::into)
      .collect(),
  )
}
pub(crate) async fn resolve_assistant_presentation(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  context: AssistantPackageContextType,
  database_id: Option<ID>,
  row_id: Option<ID>,
) -> Result<AssistantResolvedPresentationObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let database_id = database_id
    .as_ref()
    .map(|v| parse_uuid_id(v, "databaseId"))
    .transpose()?;
  let row_id = row_id.as_ref().map(|v| parse_uuid_id(v, "rowId")).transpose()?;
  Ok(
    package_service(&state)?
      .resolve_presentation(snapshot.user.id, workspace_id, context.into(), database_id, row_id)
      .await
      .map_err(map_database_error)?
      .into(),
  )
}

/// Resolve only an existing authorized Library source. Navigation never assigns
/// a template or provisions content, including in an explicitly Empty Workspace.
pub(crate) async fn resolve_assistant_document_source(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  input: AssistantDocumentSourceInput,
) -> Result<Option<crate::graphql::auth::template_suggestions::TemplateSuggestionItemObjectType>> {
  use myoxus_application::template_registry::suggestions::TemplateSuggestionService;
  let (state, snapshot) = require_session(ctx).await?;
  service(&state)?
    .views
    .assert_workspace_read(snapshot.user.id, workspace_id)
    .await
    .map_err(map_database_error)?;
  if !crate::graphql::template_registry::is_template_registry_enabled(&state).await {
    return Ok(None);
  }
  let source = package_service(&state)?
    .document_source(&input.identity.into(), &input.step, &input.group, &input.source_digest)
    .map_err(|_| invalid_package_input())?;
  let Some(registry) = state.template_registry().cloned() else {
    return Ok(None);
  };
  TemplateSuggestionService::new(
    Arc::new(registry),
    state.document_metadata_policy_repo(),
    Some(state.permission_service()),
  )
  .with_document_metadata_service(state.document_metadata_service().ok_or_else(|| {
    crate::graphql::auth::template_suggestions::map_suggestion_error(
      myoxus_application::template_registry::suggestions::TemplateSuggestionError::Unavailable,
    )
  })?)
  .resolve_pinned_library_source(
    snapshot.user.id,
    workspace_id,
    &source.template_id,
    &source.version,
    &input.locale,
    input.client_version.max(0) as u32,
  )
  .await
  .map(|item| item.map(crate::graphql::auth::template_suggestions::map_item))
  .map_err(crate::graphql::auth::template_suggestions::map_suggestion_error)
}
/// Locale is part of the reviewed plan; absent transport values inherit the
/// account's current preference and then the native operator snapshot.
async fn project_assistant_locale(state: &ApiState, actor: Uuid, requested: Option<String>) -> Result<String> {
  if let Some(locale) = requested {
    return Ok(locale);
  }
  let preferences = state.auth().get_user_preferences(actor).await.map_err(map_gql_error)?;
  Ok(
    preferences
      .values
      .locale
      .unwrap_or_else(|| state.config.i18n.default_locale.clone()),
  )
}

pub(crate) async fn prepare_project_assistant(
  ctx: &Context<'_>,
  workspace_id: WorkspaceId,
  input: PrepareProjectAssistantInput,
) -> Result<PreparedProjectAssistantObjectType> {
  let (state, snapshot) = require_session(ctx).await?;
  let locale = project_assistant_locale(&state, snapshot.user.id, input.locale).await?;
  let prepared = package_service(&state)?
    .prepare_project(
      snapshot.user.id,
      workspace_id,
      &input.identity.into(),
      package_answers(input.answers.0)?,
      &locale,
      project_client_version(input.client_version)?,
    )
    .await
    .map_err(map_database_error)?;
  map_prepared_project(prepared)
}

fn assert_project_native_arguments(
  prepared: &package::AssistantPreparedProject,
  native: &CreateDatabaseFromTemplateInput,
) -> Result<()> {
  // Existing native arguments remain assertions when a package confirmation
  // is supplied. Conflicting duplicate inputs must not silently create effects
  // different from those the caller explicitly requested.
  if prepared.template_id != native.template_id
    || prepared.title != native.title.trim()
    || native.description.as_ref().is_some_and(|description| {
      let description = description.trim();
      prepared.description.as_deref() != (!description.is_empty()).then_some(description)
    })
    || native
      .include_sample_rows
      .is_some_and(|value| value != prepared.include_sample_rows)
    || native
      .priority_preset
      .is_some_and(|value| domain::DatabaseProjectOptionPreset::from(value) != prepared.priority)
    || native
      .complexity_preset
      .is_some_and(|value| domain::DatabaseProjectOptionPreset::from(value) != prepared.complexity)
    || native
      .structure_preset
      .is_some_and(|value| domain::DatabaseProjectStructurePreset::from(value) != prepared.structure)
  {
    return Err(invalid_package_input());
  }
  Ok(())
}

pub(crate) fn map_project_starter_error(error: myoxus_application::workspace::ProjectStarterError) -> Error {
  use myoxus_application::workspace::ProjectStarterError;
  match error {
    ProjectStarterError::Auth(error) => map_gql_error(error),
    ProjectStarterError::Database(error) => map_database_error(error),
    ProjectStarterError::Conflict => Error::new("Project setup request conflicts with its accepted input")
      .extend_with(|_, e| e.set("code", "MIX_ASSISTANT_REQUEST_CONFLICT")),
    ProjectStarterError::Gone { database_id } => Error::new("Accepted Project result is gone").extend_with(|_, e| {
      e.set("code", "MIX_ASSISTANT_RESULT_GONE");
      e.set("databaseId", database_id.to_string());
    }),
  }
}

pub(in crate::graphql::auth::database) async fn apply_project_confirmation(
  state: &ApiState,
  actor: Uuid,
  workspace_id: WorkspaceId,
  input: ProjectAssistantConfirmationInput,
  native: &CreateDatabaseFromTemplateInput,
) -> Result<DatabaseRecordObjectType> {
  let service = package_service(state)?;
  if input.request_id.is_some() && input.locale.is_none() {
    return Err(invalid_package_input());
  }
  let locale = project_assistant_locale(state, actor, input.locale).await?;
  let identity: package::AssistantPackageIdentity = input.identity.into();
  let answers = package_answers(input.answers.0)?;
  if let Some(request) = input.request_id {
    let request_id = parse_uuid_id(&request, "requestId")?;
    let setup = myoxus_application::workspace::ProjectStarterInput {
      request_id,
      package: identity,
      answers,
      locale,
      client_version: project_client_version(input.client_version)?,
      plan_digest: input.plan_digest,
      admission_confirmation: input.admission_confirmation,
    };
    // Read accepted state before fresh offering admission, and validate duplicate
    // native arguments before any publication can occur. Result readback is not
    // permission to adopt another request's reserved identity.
    let existing = state
      .workspace()
      .get_project_starter_for_input(actor, workspace_id, &setup, &service)
      .await
      .map_err(map_project_starter_error)?;
    let prepared = if let Some(existing) = existing {
      if existing.accepted.fingerprint != setup.fingerprint(workspace_id) {
        return Err(map_project_starter_error(
          myoxus_application::workspace::ProjectStarterError::Conflict,
        ));
      }
      existing.current_review.unwrap_or(existing.accepted.plan)
    } else {
      service
        .prepare_project(
          actor,
          workspace_id,
          &setup.package,
          setup.answers.clone(),
          &setup.locale,
          setup.client_version,
        )
        .await
        .map_err(map_database_error)?
    };
    assert_project_native_arguments(&prepared, native)?;
    let outcome = state
      .workspace()
      .create_project_starter(actor, workspace_id, setup, &service)
      .await
      .map_err(map_project_starter_error)?;
    let initial_key = outcome
      .current_review
      .as_ref()
      .unwrap_or(&outcome.accepted.plan)
      .initial_view_key
      .clone();
    if outcome.status != myoxus_application::workspace::ProjectStarterStatus::Ready {
      return Err(
        Error::new("Project setup requires recovery or review").extend_with(|_, e| {
          e.set("code", "MIX_ASSISTANT_RECOVERY_REQUIRED");
          e.set("requestId", request_id.to_string());
          e.set("status", format!("{:?}", outcome.status));
          e.set("databaseId", outcome.accepted.ids.database_id.to_string());
        }),
      );
    }
    let record = outcome
      .database
      .ok_or_else(|| Error::new("Accepted Project result unavailable"))?;
    let initial = record
      .database
      .managed_installation
      .as_ref()
      .and_then(|value| value.view_bindings.get(&initial_key))
      .copied();
    let mut result = map_record(record);
    result.initial_view_id = initial.map(|id| ID(id.to_string()));
    return Ok(result);
  }
  let prepared = service
    .prepare_project(
      actor,
      workspace_id,
      &identity,
      answers,
      &locale,
      project_client_version(input.client_version)?,
    )
    .await
    .map_err(map_database_error)?;
  assert_project_native_arguments(&prepared, native)?;
  if myoxus_application::workspace::assistant_packages::plan_digest(&prepared) != input.plan_digest {
    return Err(invalid_package_input());
  }
  let applied = service
    .apply_project(actor, workspace_id, prepared)
    .await
    .map_err(map_database_error)?;
  let mut result = map_record(applied.record);
  result.initial_view_id = Some(ID(applied.initial_view_id.to_string()));
  Ok(result)
}

impl From<domain::DatabaseProjectOptionPreset> for ProjectOptionPresetType {
  fn from(v: domain::DatabaseProjectOptionPreset) -> Self {
    match v {
      domain::DatabaseProjectOptionPreset::ThreeStep => Self::ThreeStep,
      domain::DatabaseProjectOptionPreset::FiveStep => Self::FiveStep,
    }
  }
}
impl From<domain::DatabaseProjectStructurePreset> for ProjectStructurePresetType {
  fn from(v: domain::DatabaseProjectStructurePreset) -> Self {
    match v {
      domain::DatabaseProjectStructurePreset::TasksOnly => Self::TasksOnly,
      domain::DatabaseProjectStructurePreset::Phases => Self::Phases,
      domain::DatabaseProjectStructurePreset::Milestones => Self::Milestones,
      domain::DatabaseProjectStructurePreset::PhasesAndMilestones => Self::PhasesAndMilestones,
    }
  }
}

#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantBindingValueKind", rename_items = "PascalCase")]
pub enum AssistantBindingValueKindType {
  Input,
  Context,
  Result,
  LocalizedText,
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantContextValue", rename_items = "PascalCase")]
pub enum AssistantContextValueType {
  Workspace,
  Database,
  Row,
  SourceDocument,
  ParentRow,
  Requester,
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantResultValue", rename_items = "PascalCase")]
pub enum AssistantResultValueType {
  CorrectionProposal,
  Database,
  Row,
  Document,
  Reason,
  Outcome,
}
#[derive(Debug, Enum, Copy, Clone, Eq, PartialEq)]
#[graphql(name = "AssistantNativeActionKind", rename_items = "PascalCase")]
pub enum AssistantNativeActionKindType {
  CreateDatabaseFromDefinition,
  CreateWorkingDocument,
  PlaceNativeLink,
  ConfigureTaskPreparation,
  CreateLinkedDocument,
  TaskMaintenance,
  InspectTaskContent,
  ApplyTaskCorrections,
  TaskHandover,
  CreateWorkspace,

  CreateProject,
  CreateDocument,
  RequestDocumentReview,
  CreateTaskFromDocument,
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantValueBinding")]
pub struct AssistantValueBindingObjectType {
  pub kind: AssistantBindingValueKindType,
  pub input: Option<String>,
  pub context: Option<AssistantContextValueType>,
  pub component: Option<String>,
  pub result: Option<AssistantResultValueType>,
  pub localized_text: Option<AssistantLocalizedTextObjectType>,
}
impl From<package::AssistantValueBinding> for AssistantValueBindingObjectType {
  fn from(v: package::AssistantValueBinding) -> Self {
    match v {
      package::AssistantValueBinding::Input { input } => Self {
        kind: AssistantBindingValueKindType::Input,
        input: Some(input),
        context: None,
        component: None,
        result: None,
        localized_text: None,
      },
      package::AssistantValueBinding::Context { value } => Self {
        kind: AssistantBindingValueKindType::Context,
        input: None,
        context: Some(match value {
          package::AssistantContextValue::Workspace => AssistantContextValueType::Workspace,
          package::AssistantContextValue::Database => AssistantContextValueType::Database,
          package::AssistantContextValue::Row => AssistantContextValueType::Row,
          package::AssistantContextValue::SourceDocument => AssistantContextValueType::SourceDocument,
          package::AssistantContextValue::ParentRow => AssistantContextValueType::ParentRow,
          package::AssistantContextValue::Requester => AssistantContextValueType::Requester,
        }),
        component: None,
        result: None,
        localized_text: None,
      },
      package::AssistantValueBinding::Result { component, value } => Self {
        kind: AssistantBindingValueKindType::Result,
        input: None,
        context: None,
        component: Some(component),
        result: Some(match value {
          package::AssistantResultValue::CorrectionProposal => AssistantResultValueType::CorrectionProposal,
          package::AssistantResultValue::Database => AssistantResultValueType::Database,
          package::AssistantResultValue::Row => AssistantResultValueType::Row,
          package::AssistantResultValue::Document => AssistantResultValueType::Document,
          package::AssistantResultValue::Reason => AssistantResultValueType::Reason,
          package::AssistantResultValue::Outcome => AssistantResultValueType::Outcome,
        }),
        localized_text: None,
      },
      package::AssistantValueBinding::LocalizedText { value } => Self {
        kind: AssistantBindingValueKindType::LocalizedText,
        input: None,
        context: None,
        component: None,
        result: None,
        localized_text: Some(value.into()),
      },
    }
  }
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantTargetBinding")]
pub struct AssistantTargetBindingObjectType {
  pub target: AssistantInputTargetType,
  pub binding: AssistantValueBindingObjectType,
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantNativeAction")]
pub struct AssistantNativeActionObjectType {
  pub definition_id: Option<String>,
  pub target: Option<AssistantValueBindingObjectType>,
  pub tasks: Option<AssistantValueBindingObjectType>,
  pub proposal: Option<AssistantValueBindingObjectType>,
  pub kind: AssistantNativeActionKindType,
  pub template_id: Option<String>,
  pub inputs: Vec<AssistantTargetBindingObjectType>,
  pub selected: Option<AssistantValueBindingObjectType>,
  pub folder: Option<AssistantValueBindingObjectType>,
  pub variables: Vec<AssistantNamedBindingObjectType>,
}

#[derive(SimpleObject)]
#[graphql(name = "AssistantNamedBinding")]
pub struct AssistantNamedBindingObjectType {
  pub name: String,
  pub binding: AssistantValueBindingObjectType,
}
#[derive(SimpleObject)]
#[graphql(name = "AssistantComponent")]
pub struct AssistantComponentObjectType {
  pub id: String,
  pub action: AssistantNativeActionObjectType,
}
impl From<package::AssistantComponent> for AssistantComponentObjectType {
  fn from(v: package::AssistantComponent) -> Self {
    let mut definition_id = None;
    let mut target = None;
    let mut tasks = None;
    let mut proposal = None;
    let mut selected = None;
    let mut folder = None;
    let mut variables = Vec::new();
    let (kind, template_id, inputs) = match v.action {
      package::AssistantNativeAction::CreateDatabaseFromDefinition {
        definition_id: definition,
        selected: selection,
        inputs,
      } => {
        definition_id = Some(definition);
        selected = Some(selection.into());
        (
          AssistantNativeActionKindType::CreateDatabaseFromDefinition,
          None,
          inputs,
        )
      }
      package::AssistantNativeAction::CreateWorkingDocument {
        selected: selection,
        folder: destination,
        variables: bindings,
      } => {
        selected = Some(selection.into());
        folder = Some(destination.into());
        variables = bindings
          .into_iter()
          .map(|(name, binding)| AssistantNamedBindingObjectType {
            name,
            binding: binding.into(),
          })
          .collect();
        (
          AssistantNativeActionKindType::CreateWorkingDocument,
          None,
          BTreeMap::new(),
        )
      }
      package::AssistantNativeAction::PlaceNativeLink {
        target: binding,
        folder: destination,
      } => {
        target = Some(binding.into());
        folder = Some(destination.into());
        (AssistantNativeActionKindType::PlaceNativeLink, None, BTreeMap::new())
      }
      package::AssistantNativeAction::CreateDocument {
        selected: selection,
        folder: destination,
        variables: bindings,
      } => {
        selected = Some(selection.into());
        folder = Some(destination.into());
        variables = bindings
          .into_iter()
          .map(|(name, binding)| AssistantNamedBindingObjectType {
            name,
            binding: binding.into(),
          })
          .collect();
        (AssistantNativeActionKindType::CreateDocument, None, BTreeMap::new())
      }
      package::AssistantNativeAction::CreateProject {
        template_id, inputs, ..
      } => (AssistantNativeActionKindType::CreateProject, Some(template_id), inputs),
      package::AssistantNativeAction::CreateWorkspace { inputs } => {
        (AssistantNativeActionKindType::CreateWorkspace, None, inputs)
      }
      package::AssistantNativeAction::ConfigureTaskPreparation { inputs } => {
        (AssistantNativeActionKindType::ConfigureTaskPreparation, None, inputs)
      }
      package::AssistantNativeAction::CreateLinkedDocument {
        inputs,
        variables: bindings,
      } => {
        variables = bindings
          .into_iter()
          .map(|(name, binding)| AssistantNamedBindingObjectType {
            name,
            binding: binding.into(),
          })
          .collect();
        (AssistantNativeActionKindType::CreateLinkedDocument, None, inputs)
      }
      package::AssistantNativeAction::TaskMaintenance { inputs } => {
        (AssistantNativeActionKindType::TaskMaintenance, None, inputs)
      }
      package::AssistantNativeAction::InspectTaskContent { tasks: binding } => {
        tasks = Some(binding.into());
        (AssistantNativeActionKindType::InspectTaskContent, None, BTreeMap::new())
      }
      package::AssistantNativeAction::ApplyTaskCorrections { proposal: binding } => {
        proposal = Some(binding.into());
        (
          AssistantNativeActionKindType::ApplyTaskCorrections,
          None,
          BTreeMap::new(),
        )
      }
      package::AssistantNativeAction::TaskHandover { inputs } => {
        (AssistantNativeActionKindType::TaskHandover, None, inputs)
      }
      package::AssistantNativeAction::RequestDocumentReview { inputs } => {
        (AssistantNativeActionKindType::RequestDocumentReview, None, inputs)
      }
      package::AssistantNativeAction::CreateTaskFromDocument { inputs } => {
        (AssistantNativeActionKindType::CreateTaskFromDocument, None, inputs)
      }
    };
    Self {
      id: v.id,
      action: AssistantNativeActionObjectType {
        definition_id,
        target,
        tasks,
        proposal,
        kind,
        template_id,
        selected,
        folder,
        variables,
        inputs: inputs
          .into_iter()
          .map(|(target, binding)| AssistantTargetBindingObjectType {
            target: target.into(),
            binding: binding.into(),
          })
          .collect(),
      },
    }
  }
}

/// Optional composition stays within the outer Workspace request. The package
/// and answers are distinct from the common Empty allocation descriptor.
#[derive(InputObject)]
pub struct WorkspaceProjectSetupInput {
  pub package: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
  pub locale: Option<String>,
  pub client_version: Option<i32>,
}

pub(crate) async fn workspace_project_input(
  state: &ApiState,
  actor: Uuid,
  input: Option<WorkspaceProjectSetupInput>,
) -> Result<Option<myoxus_application::workspace::WorkspaceStarterProjectInput>> {
  let Some(input) = input else { return Ok(None) };
  Ok(Some(myoxus_application::workspace::WorkspaceStarterProjectInput {
    package: input.package.into(),
    answers: package_answers(input.answers.0)?,
    locale: project_assistant_locale(state, actor, input.locale).await?,
    client_version: project_client_version(input.client_version)?,
  }))
}

/// Optional authored content shares the allocation request and its native receipt.
/// Confirmed locale/client values are retained verbatim for uncertain replay.
#[derive(InputObject)]
pub struct WorkspaceSetupInput {
  pub package: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
  pub locale: String,
  pub client_version: i32,
}

pub(crate) fn workspace_setup_input(
  input: Option<WorkspaceSetupInput>,
) -> Result<Option<myoxus_application::workspace::WorkspaceStarterSetupInput>> {
  input
    .map(|input| {
      let client_version = u32::try_from(input.client_version)
        .ok()
        .filter(|version| *version > 0)
        .ok_or_else(invalid_package_input)?;
      Ok(myoxus_application::workspace::WorkspaceStarterSetupInput {
        package: input.package.into(),
        answers: package_answers(input.answers.0)?,
        locale: input.locale,
        client_version,
      })
    })
    .transpose()
}

#[derive(InputObject)]
pub struct PrepareWorkspaceAssistantInput {
  pub identity: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
  pub project: Option<WorkspaceProjectSetupInput>,
  pub setup: Option<WorkspaceSetupInput>,
}
#[derive(InputObject)]
pub struct WorkspaceAssistantConfirmationInput {
  pub identity: AssistantPackageIdentityInput,
  pub answers: Json<JsonValue>,
  pub plan_digest: String,
}
#[derive(SimpleObject)]
#[graphql(name = "PreparedWorkspaceAssistant")]
pub struct PreparedWorkspaceAssistantObjectType {
  pub setup: Option<PreparedWorkspaceSetupObjectType>,
  pub project: Option<PreparedProjectAssistantObjectType>,
  pub package: AssistantPackageIdentityObjectType,
  pub plan_digest: String,
  pub answers: Vec<AssistantNamedValueObjectType>,
  pub name: String,
  pub initial_content: crate::graphql::auth::WorkspaceInitialContentType,
  pub assistance_mode: crate::graphql::auth::AssistanceModeType,
}
impl
  TryFrom<(
    myoxus_domain::ids::UserId,
    myoxus_application::workspace::PreparedWorkspaceAssistant,
  )> for PreparedWorkspaceAssistantObjectType
{
  type Error = Error;
  fn try_from(
    (actor, plan): (
      myoxus_domain::ids::UserId,
      myoxus_application::workspace::PreparedWorkspaceAssistant,
    ),
  ) -> Result<Self> {
    let plan_digest = plan.plan_digest(actor);
    Ok(Self {
      setup: plan.setup.map(map_prepared_workspace_setup).transpose()?,
      project: plan.project.map(map_prepared_project).transpose()?,
      plan_digest,
      package: plan.package.into(),
      answers: plan
        .answers
        .into_iter()
        .map(|(input, value)| AssistantNamedValueObjectType {
          input,
          value: value.into(),
        })
        .collect(),
      name: plan.name,
      initial_content: crate::graphql::auth::WorkspaceInitialContentType::Empty,
      assistance_mode: plan.assistance_mode.into(),
    })
  }
}
