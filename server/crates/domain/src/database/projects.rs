// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native Project semantics and graph rules over caller-supplied facts.
use crate::database::*;

/// Decisions derived from already locked definitions. Persistence owns graph
/// snapshots and locks; this value contains no storage or clock dependency.
#[derive(Debug, Clone, Default)]
pub struct DatabaseProjectMutationPolicy {
  pub roles: HashMap<String, (DatabaseFieldId, Value)>,
  pub status_config: Option<DatabaseStatusFieldConfig>,
  pub enforce_hierarchy: bool,
  pub edits_parent: bool,
  pub parent_config_compatible: bool,
  pub parent_other_row_kinds: std::collections::HashSet<String>,
  pub edits_blocker: bool,
  pub blocker_config: Option<DatabaseRelationFieldConfig>,
  pub blocker_other_row_kinds: std::collections::HashSet<String>,
}

pub fn prepare_project_mutation(
  roles: &[DatabaseFieldRole],
  fields: &[DatabaseField],
  structure: Option<DatabaseProjectStructurePreset>,
  directly_edited_fields: &[DatabaseFieldId],
  creates_row: bool,
) -> Result<DatabaseProjectMutationPolicy, String> {
  let mut policy = DatabaseProjectMutationPolicy::default();
  for role in roles {
    if directly_edited_fields.contains(&role.field_id)
      && role.config.get("manualEdit").and_then(Value::as_bool) == Some(false)
    {
      return Err(format!("database role-managed field is read-only: {}", role.role_key));
    }
    if !matches!(role.role_key.as_str(), "task.parent" | "task.blockedBy") {
      policy
        .roles
        .insert(role.role_key.clone(), (role.field_id, role.config.clone()));
    }
  }
  for key in ["task.parent", "task.blockedBy"] {
    if let Some(role) = roles.iter().filter(|role| role.role_key == key).min_by_key(|role| {
      (
        role.row_kind_scope.as_deref() != Some("task"),
        role.row_kind_scope.as_deref().unwrap_or(""),
        role.field_id,
      )
    }) {
      policy.roles.insert(key.into(), (role.field_id, role.config.clone()));
    }
  }
  if let Some((id, _)) = policy.roles.get("task.status") {
    match fields.iter().find(|field| field.id == *id).map(|field| &field.config) {
      Some(DatabaseFieldConfig::Status(config)) => {
        validate_database_status_field_config(config)?;
        policy.status_config = Some(config.clone());
      }
      _ => return Err("database project task status config invalid".into()),
    }
  }
  policy.enforce_hierarchy = structure == Some(DatabaseProjectStructurePreset::PhasesAndMilestones)
    && (creates_row
      || ["task.phase", "task.milestone", "milestone.phase"].iter().any(|key| {
        policy
          .roles
          .get(*key)
          .is_some_and(|(id, _)| directly_edited_fields.contains(id))
      }));
  let bindings = || {
    roles
      .iter()
      .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id))
  };
  for (key, parent) in [("task.parent", true), ("task.blockedBy", false)] {
    let Some((id, _)) = policy.roles.get(key) else { continue };
    let Some(field) = fields
      .iter()
      .find(|field| field.id == *id && field.field_type == DatabaseFieldType::Relation)
    else {
      continue;
    };
    let conflicting = if parent {
      task_parent_has_conflicting_task_role(*id, bindings())
    } else {
      task_blocked_by_has_conflicting_task_role(*id, bindings())
    };
    if conflicting || !(creates_row || directly_edited_fields.contains(id)) {
      continue;
    }
    let scoped = roles
      .iter()
      .any(|role| role.role_key == key && role.field_id == *id && role.row_kind_scope.as_deref() == Some("task"));
    let other_kinds = roles
      .iter()
      .filter(|role| role.field_id == *id && role.role_key != key && role.row_kind_scope.as_deref() != Some("task"))
      .filter_map(|role| role.row_kind_scope.clone())
      .collect();
    if parent {
      policy.edits_parent = true;
      policy.parent_config_compatible = scoped && task_parent_config_compatible(field.database_id, &field.config);
      policy.parent_other_row_kinds = other_kinds;
    } else {
      policy.edits_blocker = true;
      policy.blocker_other_row_kinds = other_kinds;
      if scoped
        && task_blocked_by_config_compatible(field.database_id, &field.config)
        && let DatabaseFieldConfig::Relation(config) = &field.config
      {
        policy.blocker_config = Some(config.clone());
      }
    }
  }
  Ok(policy)
}

#[derive(Debug, Clone, PartialEq)]
pub struct DatabaseProjectCellEffect {
  pub field_id: DatabaseFieldId,
  pub value: Option<DatabaseCellValueData>,
}

/// Derive native assignment/completion Cells without changing existing completion
/// timestamps. Reopening clears completion, while retaining ordinary progress.
pub fn project_cell_effects(
  policy: &DatabaseProjectMutationPolicy,
  row_kind: DatabaseRowKind,
  changed_fields: &[DatabaseFieldId],
  status_value: Option<&str>,
  has_completed_at: bool,
  actor: UserId,
  now: DateTime<Utc>,
) -> Result<Vec<DatabaseProjectCellEffect>, String> {
  let mut effects = Vec::new();
  if row_kind != DatabaseRowKind::Task {
    return Ok(effects);
  }
  let field = |key| policy.roles.get(key).map(|(id, _)| *id);
  if field("task.assignees").is_some_and(|id| changed_fields.contains(&id))
    && let Some(field_id) = field("task.assignedBy")
  {
    effects.push(DatabaseProjectCellEffect {
      field_id,
      value: Some(DatabaseCellValueData::User(actor)),
    });
  }
  if !field("task.status").is_some_and(|id| changed_fields.contains(&id)) {
    return Ok(effects);
  }
  let config = policy
    .status_config
    .as_ref()
    .ok_or("database project task status config invalid")?;
  if status_value.is_some_and(|id| !config.options.iter().any(|option| option.id == id)) {
    return Err("database project task status value invalid".into());
  }
  let complete = status_value.is_some_and(|id| {
    config
      .options
      .iter()
      .any(|option| option.id == id && option.group == DatabaseStatusGroup::Complete)
  });
  if let Some(field_id) = field("task.completedAt") {
    if complete && !has_completed_at {
      effects.push(DatabaseProjectCellEffect {
        field_id,
        value: Some(DatabaseCellValueData::DateTime(DatabaseDateTimeValue {
          start: now,
          end: None,
          all_day: false,
          time_zone: "UTC".into(),
        })),
      });
    } else if !complete && has_completed_at {
      effects.push(DatabaseProjectCellEffect { field_id, value: None });
    }
  }
  if complete && let Some(field_id) = field("task.progress") {
    effects.push(DatabaseProjectCellEffect {
      field_id,
      value: Some(DatabaseCellValueData::Percent(100.0)),
    });
  }
  Ok(effects)
}

/// Server-owned product profile for a Database.
///
/// `Generic` means no explicit profile row exists. Product behavior such as a
/// Project is stored as profile metadata plus field-role mappings; consumers
/// must not infer roles from localized field or view names.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseProfileKind {
  #[default]
  Generic,
  Project,
}

impl DatabaseProfileKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Generic => "generic",
      Self::Project => "project",
    }
  }
}

impl FromStr for DatabaseProfileKind {
  type Err = DatabaseDomainError;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "generic" => Ok(Self::Generic),
      "project" => Ok(Self::Project),
      _ => Err(DatabaseDomainError::InvalidProfileKind(value.to_string())),
    }
  }
}

/// Structure variants supported by the server-owned Project profile.
///
/// This type lives in the domain because starter manifests, role contracts and
/// application creation inputs must agree on one preset vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseProjectStructurePreset {
  TasksOnly,
  Phases,
  Milestones,
  PhasesAndMilestones,
}

impl DatabaseProjectStructurePreset {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::TasksOnly => "tasks_only",
      Self::Phases => "phases",
      Self::Milestones => "milestones",
      Self::PhasesAndMilestones => "phases_and_milestones",
    }
  }

  pub fn has_phases(self) -> bool {
    matches!(self, Self::Phases | Self::PhasesAndMilestones)
  }

  pub fn has_milestones(self) -> bool {
    matches!(self, Self::Milestones | Self::PhasesAndMilestones)
  }
}

impl FromStr for DatabaseProjectStructurePreset {
  type Err = DatabaseDomainError;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    match value {
      "tasks_only" => Ok(Self::TasksOnly),
      "phases" => Ok(Self::Phases),
      "milestones" => Ok(Self::Milestones),
      "phases_and_milestones" => Ok(Self::PhasesAndMilestones),
      _ => Err(DatabaseDomainError::InvalidStarterTemplate(format!(
        "invalid Project structure preset: {value}"
      ))),
    }
  }
}

/// How a Project role obtains or maintains its value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseProjectRoleManagedState {
  UserEditable,
  UserEditableDefaultEmpty,
  CreatorDefault,
  AssignmentMutation,
  StatusCompletionPolicy,
}

/// Canonical semantic contract for one server-owned Project field role.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DatabaseProjectSemanticRole {
  pub role_key: &'static str,
  pub row_kind_scope: DatabaseRowKind,
  pub field_key: &'static str,
  pub field_type: DatabaseFieldType,
  pub required: bool,
  pub managed_state: DatabaseProjectRoleManagedState,
  pub structures: &'static [DatabaseProjectStructurePreset],
}

impl DatabaseProjectSemanticRole {
  pub fn applies_to(self, structure: DatabaseProjectStructurePreset) -> bool {
    self.structures.contains(&structure)
  }
}

const PROJECT_STRUCTURES_ALL: &[DatabaseProjectStructurePreset] = &[
  DatabaseProjectStructurePreset::TasksOnly,
  DatabaseProjectStructurePreset::Phases,
  DatabaseProjectStructurePreset::Milestones,
  DatabaseProjectStructurePreset::PhasesAndMilestones,
];
const PROJECT_STRUCTURES_WITH_PHASES: &[DatabaseProjectStructurePreset] = &[
  DatabaseProjectStructurePreset::Phases,
  DatabaseProjectStructurePreset::PhasesAndMilestones,
];
const PROJECT_STRUCTURES_WITH_MILESTONES: &[DatabaseProjectStructurePreset] = &[
  DatabaseProjectStructurePreset::Milestones,
  DatabaseProjectStructurePreset::PhasesAndMilestones,
];
const PROJECT_STRUCTURES_COMBINED: &[DatabaseProjectStructurePreset] =
  &[DatabaseProjectStructurePreset::PhasesAndMilestones];

macro_rules! project_role {
  ($role:literal, $scope:ident, $field:literal, $field_type:ident, $required:literal, $managed:ident, $structures:ident) => {
    DatabaseProjectSemanticRole {
      role_key: $role,
      row_kind_scope: DatabaseRowKind::$scope,
      field_key: $field,
      field_type: DatabaseFieldType::$field_type,
      required: $required,
      managed_state: DatabaseProjectRoleManagedState::$managed,
      structures: $structures,
    }
  };
}

/// Single source of truth for Project role semantics.
///
/// Local field keys only identify fields while a starter is materialized.
/// Consumers must resolve product meaning through `role_key` and
/// `row_kind_scope`.
pub const DATABASE_PROJECT_SEMANTIC_CATALOG: &[DatabaseProjectSemanticRole] = &[
  project_role!(
    "task.title",
    Task,
    "title",
    Title,
    true,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.description",
    Task,
    "description",
    RichText,
    true,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.status",
    Task,
    "status",
    Status,
    true,
    StatusCompletionPolicy,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.priority",
    Task,
    "priority",
    Select,
    true,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.tags",
    Task,
    "tags",
    Tags,
    true,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.owner",
    Task,
    "owner",
    User,
    true,
    CreatorDefault,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.assignees",
    Task,
    "assignees",
    Users,
    true,
    UserEditableDefaultEmpty,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.assignedBy",
    Task,
    "assigned_by",
    User,
    true,
    AssignmentMutation,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.progress",
    Task,
    "progress",
    Percent,
    true,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.publicId",
    Task,
    "public_id",
    UniqueId,
    false,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.complexity",
    Task,
    "complexity",
    Select,
    false,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.effort",
    Task,
    "effort",
    Duration,
    false,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.cost",
    Task,
    "cost",
    Currency,
    false,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.startDate",
    Task,
    "start",
    DateTime,
    false,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.dueDate",
    Task,
    "due",
    DateTime,
    false,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.completedAt",
    Task,
    "completed",
    DateTime,
    false,
    StatusCompletionPolicy,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.attachments",
    Task,
    "attachments",
    Files,
    false,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.document",
    Task,
    "linked_document",
    DocumentLink,
    false,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.parent",
    Task,
    "parent",
    Relation,
    false,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.dependencies",
    Task,
    "dependencies",
    Relation,
    false,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.blockedBy",
    Task,
    "blocked_by",
    Relation,
    false,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.watchers",
    Task,
    "watchers",
    Users,
    false,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.acceptanceCriteria",
    Task,
    "acceptance",
    RichText,
    false,
    UserEditable,
    PROJECT_STRUCTURES_ALL
  ),
  project_role!(
    "task.phase",
    Task,
    "phase",
    Relation,
    true,
    UserEditable,
    PROJECT_STRUCTURES_WITH_PHASES
  ),
  project_role!(
    "task.milestone",
    Task,
    "milestone",
    Relation,
    true,
    UserEditable,
    PROJECT_STRUCTURES_WITH_MILESTONES
  ),
  project_role!(
    "phase.title",
    Phase,
    "title",
    Title,
    true,
    UserEditable,
    PROJECT_STRUCTURES_WITH_PHASES
  ),
  project_role!(
    "phase.description",
    Phase,
    "description",
    RichText,
    false,
    UserEditable,
    PROJECT_STRUCTURES_WITH_PHASES
  ),
  project_role!(
    "phase.status",
    Phase,
    "status",
    Status,
    false,
    UserEditable,
    PROJECT_STRUCTURES_WITH_PHASES
  ),
  project_role!(
    "phase.startDate",
    Phase,
    "start",
    DateTime,
    false,
    UserEditable,
    PROJECT_STRUCTURES_WITH_PHASES
  ),
  project_role!(
    "phase.dueDate",
    Phase,
    "due",
    DateTime,
    false,
    UserEditable,
    PROJECT_STRUCTURES_WITH_PHASES
  ),
  project_role!(
    "milestone.title",
    Milestone,
    "title",
    Title,
    true,
    UserEditable,
    PROJECT_STRUCTURES_WITH_MILESTONES
  ),
  project_role!(
    "milestone.description",
    Milestone,
    "description",
    RichText,
    false,
    UserEditable,
    PROJECT_STRUCTURES_WITH_MILESTONES
  ),
  project_role!(
    "milestone.status",
    Milestone,
    "status",
    Status,
    false,
    UserEditable,
    PROJECT_STRUCTURES_WITH_MILESTONES
  ),
  project_role!(
    "milestone.dueDate",
    Milestone,
    "due",
    DateTime,
    false,
    UserEditable,
    PROJECT_STRUCTURES_WITH_MILESTONES
  ),
  project_role!(
    "milestone.phase",
    Milestone,
    "phase",
    Relation,
    true,
    UserEditable,
    PROJECT_STRUCTURES_COMBINED
  ),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatabaseProjectViewAxis {
  Group,
  Progress,
  Date,
  Start,
  End,
  Cover,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DatabaseProjectViewAxisPolicy {
  pub axis: DatabaseProjectViewAxis,
  pub role_key: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseProjectViewPolicy {
  pub view_kind: DatabaseViewKind,
  pub visible_role_keys: Vec<&'static str>,
  pub axes: Vec<DatabaseProjectViewAxisPolicy>,
}

/// Resolve the persisted defaults for a newly created Project view.
pub fn database_project_view_policies(structure: DatabaseProjectStructurePreset) -> Vec<DatabaseProjectViewPolicy> {
  let summary = vec![
    "task.title",
    "task.status",
    "task.priority",
    "task.assignees",
    "task.dueDate",
    "task.progress",
  ];
  let task_roles = DATABASE_PROJECT_SEMANTIC_CATALOG
    .iter()
    .filter(|role| role.row_kind_scope == DatabaseRowKind::Task && role.applies_to(structure))
    .map(|role| role.role_key)
    .collect::<Vec<_>>();
  let progress_group = if structure.has_phases() {
    "task.phase"
  } else if structure.has_milestones() {
    "task.milestone"
  } else {
    "task.status"
  };
  vec![
    DatabaseProjectViewPolicy {
      view_kind: DatabaseViewKind::Kanban,
      visible_role_keys: vec![
        "task.title",
        "task.description",
        "task.status",
        "task.priority",
        "task.assignees",
        "task.dueDate",
        "task.progress",
      ],
      axes: vec![DatabaseProjectViewAxisPolicy {
        axis: DatabaseProjectViewAxis::Group,
        role_key: "task.status",
      }],
    },
    DatabaseProjectViewPolicy {
      view_kind: DatabaseViewKind::Table,
      visible_role_keys: task_roles,
      axes: vec![DatabaseProjectViewAxisPolicy {
        axis: DatabaseProjectViewAxis::Group,
        role_key: "task.status",
      }],
    },
    DatabaseProjectViewPolicy {
      view_kind: DatabaseViewKind::Progress,
      visible_role_keys: summary.clone(),
      axes: vec![
        DatabaseProjectViewAxisPolicy {
          axis: DatabaseProjectViewAxis::Progress,
          role_key: "task.progress",
        },
        DatabaseProjectViewAxisPolicy {
          axis: DatabaseProjectViewAxis::Group,
          role_key: progress_group,
        },
      ],
    },
    DatabaseProjectViewPolicy {
      view_kind: DatabaseViewKind::List,
      visible_role_keys: summary.clone(),
      axes: vec![DatabaseProjectViewAxisPolicy {
        axis: DatabaseProjectViewAxis::Group,
        role_key: "task.status",
      }],
    },
    DatabaseProjectViewPolicy {
      view_kind: DatabaseViewKind::Calendar,
      visible_role_keys: summary.clone(),
      axes: vec![DatabaseProjectViewAxisPolicy {
        axis: DatabaseProjectViewAxis::Date,
        role_key: "task.dueDate",
      }],
    },
    DatabaseProjectViewPolicy {
      view_kind: DatabaseViewKind::Timeline,
      visible_role_keys: summary.clone(),
      axes: vec![
        DatabaseProjectViewAxisPolicy {
          axis: DatabaseProjectViewAxis::Start,
          role_key: "task.startDate",
        },
        DatabaseProjectViewAxisPolicy {
          axis: DatabaseProjectViewAxis::End,
          role_key: "task.dueDate",
        },
      ],
    },
    DatabaseProjectViewPolicy {
      view_kind: DatabaseViewKind::Gallery,
      visible_role_keys: summary,
      axes: vec![DatabaseProjectViewAxisPolicy {
        axis: DatabaseProjectViewAxis::Cover,
        role_key: "task.attachments",
      }],
    },
  ]
}

/// Stable, metadata-free diagnostics for the native Task relation role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum DatabaseTaskRelationReason {
  MissingRole,
  SelfParent,
  SelfBlockedBy,
  DuplicateTargets,
  Cycle,
  WrongRowKind,
  ForeignDatabase,
  IncompatibleRoleConfiguration,
  MultipleParents,
  UnavailableTarget,
}

impl DatabaseTaskRelationReason {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::MissingRole => "MissingRole",
      Self::SelfParent => "SelfParent",
      Self::SelfBlockedBy => "SelfBlockedBy",
      Self::DuplicateTargets => "DuplicateTargets",
      Self::Cycle => "Cycle",
      Self::WrongRowKind => "WrongRowKind",
      Self::ForeignDatabase => "ForeignDatabase",
      Self::IncompatibleRoleConfiguration => "IncompatibleRoleConfiguration",
      Self::MultipleParents => "MultipleParents",
      Self::UnavailableTarget => "UnavailableTarget",
    }
  }

  /// The existing repository validation channel carries only this closed
  /// vocabulary, never target identities or SQL details.
  pub fn validation_message(self) -> String {
    format!("database task relation invalid: {}", self.as_str())
  }

  pub fn diagnostic_code(self) -> String {
    format!("MIX_DATABASE_TASK_RELATION_INVALID_{}", self.as_str())
  }

  pub fn blocked_by_diagnostic_code(self) -> String {
    format!("MIX_DATABASE_TASK_BLOCKED_BY_INVALID_{}", self.as_str())
  }

  pub fn from_diagnostic_code(code: &str) -> Option<Self> {
    Self::from_reason_name(
      code
        .strip_prefix("MIX_DATABASE_TASK_RELATION_INVALID_")
        .or_else(|| code.strip_prefix("MIX_DATABASE_TASK_BLOCKED_BY_INVALID_"))?,
    )
  }

  pub fn from_validation_message(message: &str) -> Option<Self> {
    Self::from_reason_name(message.strip_prefix("database task relation invalid: ")?)
  }

  fn from_reason_name(reason: &str) -> Option<Self> {
    [
      Self::MissingRole,
      Self::SelfParent,
      Self::SelfBlockedBy,
      Self::DuplicateTargets,
      Self::Cycle,
      Self::WrongRowKind,
      Self::ForeignDatabase,
      Self::IncompatibleRoleConfiguration,
      Self::MultipleParents,
      Self::UnavailableTarget,
    ]
    .into_iter()
    .find(|candidate| candidate.as_str() == reason)
  }
}

#[derive(Debug, Clone, Default)]
pub struct DatabaseTaskRelationGraph {
  /// Internal identity/kind plus whether the Row is live (not in Trash).
  pub rows: BTreeMap<DatabaseRowId, (DatabaseId, DatabaseRowKind, bool)>,
  pub edges: BTreeMap<DatabaseRowId, Vec<DatabaseRowId>>,
}

impl DatabaseTaskRelationGraph {
  /// Diagnose canonical Cells without normalizing legacy edges. Target metadata
  /// stays internal; public readers expose only reasons and their own Cell IDs.
  pub fn diagnostics(&self, database_id: DatabaseId, row_id: DatabaseRowId) -> Vec<DatabaseTaskRelationReason> {
    self.relation_diagnostics(database_id, row_id, true)
  }

  pub fn blocking_diagnostics(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
  ) -> Vec<DatabaseTaskRelationReason> {
    self.relation_diagnostics(database_id, row_id, false)
  }

  fn relation_diagnostics(
    &self,
    database_id: DatabaseId,
    row_id: DatabaseRowId,
    parent: bool,
  ) -> Vec<DatabaseTaskRelationReason> {
    use DatabaseTaskRelationReason as Reason;
    let targets = self.edges.get(&row_id).map(Vec::as_slice).unwrap_or_default();
    let mut reasons = BTreeSet::new();
    if targets.is_empty() {
      return Vec::new();
    }
    if parent && targets.len() > 1 {
      reasons.insert(Reason::MultipleParents);
    }
    if !parent && targets.iter().collect::<BTreeSet<_>>().len() != targets.len() {
      reasons.insert(Reason::DuplicateTargets);
    }
    if self
      .rows
      .get(&row_id)
      .is_none_or(|(_, kind, _)| *kind != DatabaseRowKind::Task)
    {
      reasons.insert(Reason::WrongRowKind);
    }
    for target in targets {
      if *target == row_id {
        reasons.insert(if parent {
          Reason::SelfParent
        } else {
          Reason::SelfBlockedBy
        });
      }
      match self.rows.get(target) {
        Some((scope, _, _)) if *scope != database_id => {
          reasons.insert(Reason::ForeignDatabase);
        }
        Some((_, _, false)) | None => {
          reasons.insert(Reason::UnavailableTarget);
        }
        Some((_, kind, _)) if *kind != DatabaseRowKind::Task => {
          reasons.insert(Reason::WrongRowKind);
        }
        _ => {}
      }
    }
    let mut pending = targets.to_vec();
    let mut visited = BTreeSet::new();
    while let Some(target) = pending.pop() {
      if !visited.insert(target) {
        continue;
      }
      if target == row_id {
        reasons.insert(Reason::Cycle);
        break;
      }
      if self
        .rows
        .get(&target)
        .is_some_and(|(scope, kind, live)| *scope == database_id && *kind == DatabaseRowKind::Task && *live)
      {
        pending.extend(self.edges.get(&target).into_iter().flatten().copied());
      }
    }
    reasons.into_iter().collect()
  }
}

/// A repair may remove repeated legacy IDs but must never introduce a new
/// occurrence disguised as an already-present target.
pub fn task_relation_edges_only_removed(previous: &[DatabaseRowId], proposed: &[DatabaseRowId]) -> bool {
  let mut remaining = BTreeMap::<DatabaseRowId, usize>::new();
  for target in previous {
    *remaining.entry(*target).or_default() += 1;
  }
  for target in proposed {
    let Some(count) = remaining.get_mut(target) else {
      return false;
    };
    if *count == 0 {
      return false;
    }
    *count -= 1;
  }
  true
}

/// Prefer the canonical Task scope; malformed extra scopes cannot shadow it.
/// Without a Task binding, the deterministic fallback permits diagnosis and
/// explicit legacy edge removal, never new Parent edges.
pub fn task_parent_field<'a>(
  roles: impl IntoIterator<Item = (&'a str, Option<&'a str>, DatabaseFieldId)>,
) -> Option<DatabaseFieldId> {
  roles
    .into_iter()
    .filter(|(key, _, _)| *key == "task.parent")
    .min_by_key(|(_, scope, field)| (*scope != Some("task"), scope.unwrap_or(""), *field))
    .map(|(_, _, field)| field)
}

/// Only an actual matching source-kind role exempts a non-Task field write;
/// an otherwise standalone Parent field still rejects non-Task additions.
pub fn task_parent_field_has_other_kind_owner<'a>(
  field_id: DatabaseFieldId,
  source_kind: DatabaseRowKind,
  roles: impl IntoIterator<Item = (&'a str, Option<&'a str>, DatabaseFieldId)>,
) -> bool {
  source_kind != DatabaseRowKind::Task
    && roles
      .into_iter()
      .any(|(key, scope, field)| field == field_id && key != "task.parent" && scope == Some(source_kind.as_str()))
}

/// An optional Parent alias cannot take authority from another role on the
/// same Task field. Sharing with a different Row-kind scope is independent.
pub fn task_parent_has_conflicting_task_role<'a>(
  field_id: DatabaseFieldId,
  roles: impl IntoIterator<Item = (&'a str, Option<&'a str>, DatabaseFieldId)>,
) -> bool {
  roles
    .into_iter()
    .any(|(key, scope, field)| field == field_id && key != "task.parent" && scope == Some("task"))
}

/// Identify the semantic Cell owner without treating a malformed optional
/// alias as authority over another Task role or a matching other source kind.
pub fn task_parent_owns_cell(field: &DatabaseField, kind: DatabaseRowKind, roles: &[DatabaseFieldRole]) -> bool {
  let role_iter = || {
    roles
      .iter()
      .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id))
  };
  field.field_type == DatabaseFieldType::Relation
    && task_parent_field(role_iter()) == Some(field.id)
    && !task_parent_has_conflicting_task_role(field.id, role_iter())
    && !task_parent_field_has_other_kind_owner(field.id, kind, role_iter())
}

pub fn task_parent_config_compatible(database_id: DatabaseId, config: &DatabaseFieldConfig) -> bool {
  matches!(config, DatabaseFieldConfig::Relation(config)
    if config.target_database_id == database_id && !config.allow_multiple
      && matches!(config.max_targets, None | Some(1)) && config.reciprocal_field_id.is_none())
}

/// Select the canonical blocker role without allowing malformed extra scopes
/// to shadow it. A fallback permits diagnosis/removal, never new additions.
pub fn task_blocked_by_field<'a>(
  roles: impl IntoIterator<Item = (&'a str, Option<&'a str>, DatabaseFieldId)>,
) -> Option<DatabaseFieldId> {
  roles
    .into_iter()
    .filter(|(key, _, _)| *key == "task.blockedBy")
    .min_by_key(|(_, scope, field)| (*scope != Some("task"), scope.unwrap_or(""), *field))
    .map(|(_, _, field)| field)
}

pub fn task_blocked_by_has_conflicting_task_role<'a>(
  field_id: DatabaseFieldId,
  roles: impl IntoIterator<Item = (&'a str, Option<&'a str>, DatabaseFieldId)>,
) -> bool {
  roles
    .into_iter()
    .any(|(key, scope, field)| field == field_id && key != "task.blockedBy" && scope == Some("task"))
}

pub fn task_blocked_by_field_has_other_kind_owner<'a>(
  field_id: DatabaseFieldId,
  kind: DatabaseRowKind,
  roles: impl IntoIterator<Item = (&'a str, Option<&'a str>, DatabaseFieldId)>,
) -> bool {
  kind != DatabaseRowKind::Task
    && roles
      .into_iter()
      .any(|(key, scope, field)| field == field_id && key != "task.blockedBy" && scope == Some(kind.as_str()))
}

pub fn task_blocked_by_owns_cell(field: &DatabaseField, kind: DatabaseRowKind, roles: &[DatabaseFieldRole]) -> bool {
  let iter = || {
    roles
      .iter()
      .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id))
  };
  field.field_type == DatabaseFieldType::Relation
    && task_blocked_by_field(iter()) == Some(field.id)
    && !task_blocked_by_has_conflicting_task_role(field.id, iter())
    && !task_blocked_by_field_has_other_kind_owner(field.id, kind, iter())
}

pub fn task_blocked_by_config_compatible(database_id: DatabaseId, config: &DatabaseFieldConfig) -> bool {
  matches!(config, DatabaseFieldConfig::Relation(config) if config.target_database_id == database_id && config.reciprocal_field_id.is_none() && config.max_targets.is_none_or(|max| max > 0))
}

/// Validate a native template/import proposal without changing legacy Cells.
/// Merge proposals overlay only supplied Cells; unchanged/subset removals stay
/// repairable. All freshly published Parent IDs must resolve in this graph.
pub fn validate_task_parent_rows(
  database_id: DatabaseId,
  profile_kind: DatabaseProfileKind,
  fields: &[DatabaseField],
  roles: &[DatabaseFieldRole],
  before_rows: &[DatabaseRowRecord],
  proposed_rows: &[DatabaseRowRecord],
  templates: &[DatabaseRowTemplate],
) -> Result<(), DatabaseTaskRelationReason> {
  validate_task_relation_rows(
    database_id,
    profile_kind,
    fields,
    roles,
    before_rows,
    proposed_rows,
    templates,
    false,
  )
}

/// Validate portable/default blocker proposals against the same canonical
/// graph as native writes; this does not create or mirror any relation Cells.
pub fn validate_task_blocked_by_rows(
  database_id: DatabaseId,
  profile_kind: DatabaseProfileKind,
  fields: &[DatabaseField],
  roles: &[DatabaseFieldRole],
  before_rows: &[DatabaseRowRecord],
  proposed_rows: &[DatabaseRowRecord],
  templates: &[DatabaseRowTemplate],
) -> Result<(), DatabaseTaskRelationReason> {
  validate_task_relation_rows(
    database_id,
    profile_kind,
    fields,
    roles,
    before_rows,
    proposed_rows,
    templates,
    true,
  )
}

fn validate_task_relation_rows(
  database_id: DatabaseId,
  profile_kind: DatabaseProfileKind,
  fields: &[DatabaseField],
  roles: &[DatabaseFieldRole],
  before_rows: &[DatabaseRowRecord],
  proposed_rows: &[DatabaseRowRecord],
  templates: &[DatabaseRowTemplate],
  blocked: bool,
) -> Result<(), DatabaseTaskRelationReason> {
  if profile_kind != DatabaseProfileKind::Project {
    return Ok(());
  }
  let role_iter = || {
    roles
      .iter()
      .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id))
  };
  let role_key = if blocked { "task.blockedBy" } else { "task.parent" };
  let selected = if blocked {
    task_blocked_by_field(role_iter())
  } else {
    task_parent_field(role_iter())
  };
  let Some(parent) = selected else {
    return Ok(());
  };
  let field = fields.iter().find(|field| field.id == parent);
  // Optional aliases never take authority from an existing physical/Task owner.
  // A missing field is incompatible only if the proposal actually adds an edge.
  if field.is_some_and(|field| field.field_type != DatabaseFieldType::Relation)
    || if blocked {
      task_blocked_by_has_conflicting_task_role(parent, role_iter())
    } else {
      task_parent_has_conflicting_task_role(parent, role_iter())
    }
  {
    return Ok(());
  }
  let compatible = roles
    .iter()
    .any(|role| role.role_key == role_key && role.field_id == parent && role.row_kind_scope.as_deref() == Some("task"))
    && field.is_some_and(|field| {
      if blocked {
        task_blocked_by_config_compatible(database_id, &field.config)
      } else {
        task_parent_config_compatible(database_id, &field.config)
      }
    });
  let overlay = |graph: &mut DatabaseTaskRelationGraph, rows: &[DatabaseRowRecord]| {
    for row in rows {
      graph.rows.insert(
        row.row.id,
        (row.row.database_id, row.row.row_kind, row.row.deleted_at.is_none()),
      );
      if let Some(cell) = row.cells.iter().find(|cell| cell.field_id == parent) {
        if let DatabaseCellValueData::Relation(targets) = &cell.value {
          graph.edges.insert(row.row.id, targets.clone());
        }
      }
    }
  };
  let mut before = DatabaseTaskRelationGraph::default();
  overlay(&mut before, before_rows);
  let mut proposals = proposed_rows.to_vec();
  // A template describes a future independent Row, not a second stored graph.
  // Its targets already use the operation's actual native Row mapping.
  for template in templates {
    let id = Uuid::new_v4();
    proposals.push(DatabaseRowRecord {
      row: DatabaseRow {
        id,
        database_id,
        content_document_id: None,
        row_kind: template.row_kind,
        title: String::new(),
        position: 0,
        created_by: None,
        updated_by: None,
        edit_revision: 1,
        created_at: template.created_at,
        updated_at: template.updated_at,
        deleted_at: None,
      },
      cells: template
        .initial_cell_values
        .iter()
        .map(|(field, value)| DatabaseCellValue {
          row_id: id,
          field_id: *field,
          field_type: fields
            .iter()
            .find(|candidate| candidate.id == *field)
            .map(|field| field.field_type)
            .unwrap_or(DatabaseFieldType::Relation),
          value: value.clone(),
          updated_by: None,
          edit_revision: 1,
          updated_at: template.updated_at,
        })
        .collect(),
      cell_revisions: Vec::new(),
    });
  }
  let mut after = before.clone();
  overlay(&mut after, &proposals);
  for row in &proposals {
    if if blocked {
      task_blocked_by_field_has_other_kind_owner(parent, row.row.row_kind, role_iter())
    } else {
      task_parent_field_has_other_kind_owner(parent, row.row.row_kind, role_iter())
    } {
      continue;
    }
    let previous = before.edges.get(&row.row.id).map(Vec::as_slice).unwrap_or_default();
    let targets = after.edges.get(&row.row.id).map(Vec::as_slice).unwrap_or_default();
    let reactivated = before.rows.get(&row.row.id).is_some_and(|(_, _, live)| !*live) && row.row.deleted_at.is_none();
    if targets.is_empty() || (!reactivated && task_relation_edges_only_removed(previous, targets)) {
      continue;
    }
    if !compatible {
      return Err(DatabaseTaskRelationReason::IncompatibleRoleConfiguration);
    }
    let diagnostics = if blocked {
      after.blocking_diagnostics(database_id, row.row.id)
    } else {
      after.diagnostics(database_id, row.row.id)
    };
    if let Some(reason) = diagnostics.first() {
      return Err(*reason);
    }
    if blocked
      && let Some(DatabaseField {
        config: DatabaseFieldConfig::Relation(config),
        ..
      }) = field
      && ((!config.allow_multiple && targets.len() > 1)
        || config
          .max_targets
          .is_some_and(|max| targets.len() as i64 > i64::from(max)))
    {
      return Err(DatabaseTaskRelationReason::IncompatibleRoleConfiguration);
    }
  }
  Ok(())
}

/// Validate a locked before/after proposal, preserving removal-only repairs.
pub fn validate_task_relation_graph(
  database_id: DatabaseId,
  policy: &DatabaseProjectMutationPolicy,
  before: &DatabaseTaskRelationGraph,
  after: &DatabaseTaskRelationGraph,
  blocked: bool,
) -> Result<(), String> {
  let other_kinds = if blocked {
    &policy.blocker_other_row_kinds
  } else {
    &policy.parent_other_row_kinds
  };
  for (row_id, targets) in &after.edges {
    if after
      .rows
      .get(row_id)
      .is_some_and(|(_, kind, _)| *kind != DatabaseRowKind::Task && other_kinds.contains(kind.as_str()))
    {
      continue;
    }
    let previous = before.edges.get(row_id).map(Vec::as_slice).unwrap_or_default();
    // Deleting any subset of legacy edges is always a repair. A no-op does
    // not make unrelated legacy defects a new admission requirement.
    if task_relation_edges_only_removed(previous, targets) {
      continue;
    }
    if if blocked {
      policy.blocker_config.is_none()
    } else {
      !policy.parent_config_compatible
    } {
      return Err(String::from(
        DatabaseTaskRelationReason::IncompatibleRoleConfiguration.validation_message(),
      ));
    }
    let diagnostics = if blocked {
      after.blocking_diagnostics(database_id, *row_id)
    } else {
      after.diagnostics(database_id, *row_id)
    };
    if let Some(reason) = diagnostics.first() {
      return Err(String::from(reason.validation_message()));
    }
    if blocked
      && let Some(config) = &policy.blocker_config
      && ((!config.allow_multiple && targets.len() > 1)
        || config
          .max_targets
          .is_some_and(|max| (targets.len() as i64) > i64::from(max)))
    {
      return Err(String::from("relation target count exceeds field limit"));
    }
  }
  Ok(())
}

/// Admit restored relation contents from the caller's locked post-restore
/// snapshot. Existing unavailable blocker identities survive Restore, while a
/// newly live cycle remains forbidden. Persistence applies only returned edges.
pub fn restored_task_relation_edges(
  database_id: DatabaseId,
  policy: &DatabaseProjectMutationPolicy,
  graph: &DatabaseTaskRelationGraph,
  restored_ids: &std::collections::HashSet<Uuid>,
  blocked: bool,
) -> Result<Vec<(Uuid, Vec<Uuid>)>, String> {
  let other_kinds = if blocked {
    &policy.blocker_other_row_kinds
  } else {
    &policy.parent_other_row_kinds
  };
  let mut accepted = Vec::new();
  for row in restored_ids {
    let Some((_, kind, _)) = graph.rows.get(row) else {
      continue;
    };
    if *kind != DatabaseRowKind::Task && other_kinds.contains(kind.as_str()) {
      continue;
    }
    let targets = graph.edges.get(row).map(Vec::as_slice).unwrap_or_default();
    if !targets.is_empty() {
      if if blocked {
        policy.blocker_config.is_none()
      } else {
        !policy.parent_config_compatible
      } {
        return Err(DatabaseTaskRelationReason::IncompatibleRoleConfiguration.validation_message());
      }
      let diagnostics = if blocked {
        graph.blocking_diagnostics(database_id, *row)
      } else {
        graph.diagnostics(database_id, *row)
      };
      if blocked
        && let Some(config) = &policy.blocker_config
        && ((!config.allow_multiple && targets.len() > 1)
          || config
            .max_targets
            .is_some_and(|max| targets.len() as i64 > i64::from(max)))
      {
        return Err(DatabaseTaskRelationReason::IncompatibleRoleConfiguration.validation_message());
      }
      if let Some(reason) = diagnostics
        .iter()
        .find(|reason| !blocked || **reason != DatabaseTaskRelationReason::UnavailableTarget)
      {
        return Err(reason.validation_message());
      }
    }
    accepted.push((*row, targets.to_vec()));
  }
  Ok(accepted)
}

/// Validate native template relation values using caller-allocated future Row
/// identities. Graph loading and ID allocation remain outside this pure policy.
pub fn validate_task_relation_template_values(
  database_id: DatabaseId,
  policy: &DatabaseProjectMutationPolicy,
  before: &DatabaseTaskRelationGraph,
  values: &[(Uuid, DatabaseRowKind, &BTreeMap<DatabaseFieldId, DatabaseCellValueData>)],
  blocked: bool,
) -> Result<(), String> {
  let role = if blocked { "task.blockedBy" } else { "task.parent" };
  let Some((field, _)) = policy.roles.get(role) else {
    return Ok(());
  };
  let other_kinds = if blocked {
    &policy.blocker_other_row_kinds
  } else {
    &policy.parent_other_row_kinds
  };
  let mut after = before.clone();
  for (future_row, row_kind, values) in values {
    let Some(value) = values.get(field) else { continue };
    if *row_kind != DatabaseRowKind::Task && other_kinds.contains(row_kind.as_str()) {
      continue;
    }
    let DatabaseCellValueData::Relation(targets) = value else {
      return Err(DatabaseTaskRelationReason::IncompatibleRoleConfiguration.validation_message());
    };
    after.rows.insert(*future_row, (database_id, *row_kind, true));
    after.edges.insert(*future_row, targets.clone());
  }
  validate_task_relation_graph(database_id, policy, before, &after, blocked)
}

/// Validate live hierarchy facts loaded under the native graph locks.
pub fn validate_project_hierarchy(
  policy: &DatabaseProjectMutationPolicy,
  row_kinds: &HashMap<DatabaseRowId, DatabaseRowKind>,
  relations: &HashMap<(DatabaseRowId, DatabaseFieldId), Vec<DatabaseRowId>>,
) -> Result<(), String> {
  if !policy.enforce_hierarchy {
    return Ok(());
  }
  let field = |key| policy.roles.get(key).map(|(id, _)| *id);
  let (Some(task_phase_field), Some(task_milestone_field), Some(milestone_phase_field)) =
    (field("task.phase"), field("task.milestone"), field("milestone.phase"))
  else {
    return Ok(());
  };
  for (row_id, row_kind) in row_kinds {
    match row_kind {
      DatabaseRowKind::Milestone => {
        let phase_targets = relations
          .get(&(*row_id, milestone_phase_field))
          .map(Vec::as_slice)
          .unwrap_or_default();
        if phase_targets.len() != 1 || row_kinds.get(&phase_targets[0]) != Some(&DatabaseRowKind::Phase) {
          return Err(String::from(format!(
            "database project hierarchy invalid: milestone {row_id} must belong to exactly one phase; targets={phase_targets:?}; targetKinds={:?}",
            phase_targets
              .iter()
              .map(|target| row_kinds.get(target))
              .collect::<Vec<_>>()
          )));
        }
      }
      DatabaseRowKind::Task => {
        let phase_targets = relations
          .get(&(*row_id, task_phase_field))
          .map(Vec::as_slice)
          .unwrap_or_default();
        let milestone_targets = relations
          .get(&(*row_id, task_milestone_field))
          .map(Vec::as_slice)
          .unwrap_or_default();
        if phase_targets
          .iter()
          .any(|target| row_kinds.get(target) != Some(&DatabaseRowKind::Phase))
        {
          return Err(String::from(format!(
            "database project hierarchy invalid: task.phase must target Phase rows"
          )));
        }
        if milestone_targets
          .iter()
          .any(|target| row_kinds.get(target) != Some(&DatabaseRowKind::Milestone))
        {
          return Err(String::from(format!(
            "database project hierarchy invalid: task.milestone must target Milestone rows"
          )));
        }
        if let (Some(task_phase), Some(task_milestone)) = (phase_targets.first(), milestone_targets.first()) {
          let milestone_phases = relations
            .get(&(*task_milestone, milestone_phase_field))
            .map(Vec::as_slice)
            .unwrap_or_default();
          if milestone_phases != [*task_phase] {
            return Err(String::from(format!(
              "database project hierarchy invalid: task milestone must belong to the task phase"
            )));
          }
        }
      }
      DatabaseRowKind::Record | DatabaseRowKind::Phase => {}
    }
  }
  Ok(())
}

/// Return the role-managed cells changed in the same repository transaction
/// as a Project field mutation. The application layer uses this metadata to
/// publish one row-level collaboration event and one coherent activity/audit
/// record instead of pretending only the directly edited cell changed.
pub fn project_side_effect_roles(record: &DatabaseRecord, field_id: DatabaseFieldId) -> &'static [&'static str] {
  if record.database.profile_kind != DatabaseProfileKind::Project {
    return &[];
  }
  match record
    .field_roles
    .iter()
    .find(|role| role.field_id == field_id)
    .map(|role| role.role_key.as_str())
  {
    Some("task.assignees") => &["task.assignedBy"],
    Some("task.status") => &["task.completedAt", "task.progress"],
    _ => &[],
  }
}

pub fn project_activity_type(
  record: &DatabaseRecord,
  field_id: DatabaseFieldId,
) -> Option<crate::database_activity::DatabaseActivityEventType> {
  if record.database.profile_kind != DatabaseProfileKind::Project {
    return None;
  }
  match record
    .field_roles
    .iter()
    .find(|role| role.field_id == field_id)
    .map(|role| role.role_key.as_str())
  {
    Some("task.assignees") => Some(crate::database_activity::DatabaseActivityEventType::RowAssignmentChanged),
    Some("task.status") => Some(crate::database_activity::DatabaseActivityEventType::RowStatusChanged),
    _ => None,
  }
}

/// Used Task status IDs retain their established lifecycle meaning, including
/// recoverable Trash. Unknown legacy IDs may remain unknown until explicit repair.
pub fn validate_project_task_status_config_update(
  current: &DatabaseStatusFieldConfig,
  next: &DatabaseStatusFieldConfig,
  used_ids: &[String],
) -> Result<(), String> {
  for used_id in used_ids {
    let old = current.options.iter().find(|option| option.id == *used_id);
    let new = next.options.iter().find(|option| option.id == *used_id);
    if match (old, new) {
      (Some(old), Some(new)) => old.group != new.group,
      (None, None) => false,
      _ => true,
    } {
      return Err("database project task status is in use".to_string());
    }
  }
  Ok(())
}
