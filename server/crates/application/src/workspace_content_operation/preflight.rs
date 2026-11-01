// SPDX-License-Identifier: AGPL-3.0-or-later
//! Deterministic, mutation-free graph planning for workspace content operations.
//!
//! Persistence adapters load one qualified snapshot. This module turns direct
//! selections and organizer subtrees into the same canonical graph. Permission
//! and TOCTOU decisions are deliberately added by the next application layer;
//! this builder owns only content topology, dependency classes, mapping plans,
//! policy conflicts, counters, and the content revision.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use myoxus_domain::workspace_content_operation::{
  WorkspaceContentBlocker, WorkspaceContentIdMapping, WorkspaceContentOperationKind, WorkspaceContentResourceKind,
  WorkspaceContentResourceRef,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::organizer::{OrganizerLinkType, OrganizerSnapshot, OrganizerSnapshotNode};

use super::dependencies::{WorkspaceContentDependencyClass, workspace_content_dependency};

const MAX_REVISION_BYTES: usize = 128;
const MAX_SCHEMA_REVISION_BYTES: usize = 128;
const MAX_RELATION_BYTES: usize = 128;
const MAX_DISPLAY_NAME_BYTES: usize = 512;
pub(crate) const MAX_SUFFIX_ATTEMPTS: u32 = 10_000;

/// Legacy queued jobs must not enter private object materialization with a
/// source-owned key. Copy also allocates private document routes.
pub fn validate_private_materialization_mappings(
  operation_id: Uuid,
  kind: WorkspaceContentOperationKind,
  target_workspace_id: Uuid,
  mappings: &[WorkspaceContentIdMapping],
) -> crate::auth::AuthResult<()> {
  use myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode;
  for mapping in mappings.iter().filter(|mapping| {
    mapping.source.kind() == WorkspaceContentResourceKind::Blob
      || (kind == WorkspaceContentOperationKind::Copy
        && mapping.source.kind() == WorkspaceContentResourceKind::Document)
  }) {
    if !(1..=MAX_SUFFIX_ATTEMPTS).any(|suffix| {
      operation_private_resource_key(operation_id, target_workspace_id, &mapping.source, suffix)
        == mapping.target.resource_id()
    }) {
      return Err(crate::auth::AuthError::InvalidInput(
        WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into(),
      ));
    }
  }
  Ok(())
}

/// One authoritative resource snapshot consumed by the graph builder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentGraphResource {
  pub database_system_role: Option<myoxus_domain::database::DatabaseSystemRole>,
  pub resource: WorkspaceContentResourceRef,
  /// Internal document id used by `PermissionService`. It is required only
  /// for document resources; route keys never substitute for ACL identity.
  pub permission_resource_id: Option<Uuid>,
  /// Content/schema revision supplied by the owning repository.
  pub revision: String,
  /// Human-visible name used only for deterministic reconciliation.
  pub display_name: Option<String>,
  /// Canonical schema hash for workspace-local metadata definitions.
  pub schema_revision: Option<String>,
  /// Every persistence relation required to materialize this resource.
  pub persistence_relations: Vec<String>,
  pub publicly_shared: bool,
  /// Only Tags use this lifecycle bit; archived assignments remain portable.
  pub tag_archived: bool,
}

/// Whether a reference owns its target or only points to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceContentReferencePurpose {
  OwnedDependency,
  Reference,
}

/// One qualified edge discovered by the persistence adapter.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentGraphReference {
  pub relation: String,
  pub source: WorkspaceContentResourceRef,
  pub target: WorkspaceContentResourceRef,
  pub purpose: WorkspaceContentReferencePurpose,
  /// False means the persisted reference is dangling.
  pub target_exists: bool,
}

/// Existing target definition available for semantic reuse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentTargetDefinition {
  pub resource: WorkspaceContentResourceRef,
  pub display_name: String,
  pub schema_revision: Option<String>,
  pub tag_archived: bool,
}

/// Direct resource selection or an organizer folder subtree.
#[derive(Debug, Clone)]
pub enum WorkspaceContentSelection {
  Resources(Vec<WorkspaceContentResourceRef>),
  FolderSubtree {
    organizer: OrganizerSnapshot,
    folder_id: String,
  },
}

/// Complete, transactionally observed input to graph planning.
#[derive(Debug, Clone)]
pub struct WorkspaceContentGraphInput {
  pub operation_id: Uuid,
  pub kind: WorkspaceContentOperationKind,
  pub source_workspace_id: Uuid,
  /// A reserved target id is required even for extraction so mappings are
  /// stable before the new workspace becomes visible.
  pub target_workspace_id: Uuid,
  pub selection: WorkspaceContentSelection,
  pub resources: Vec<WorkspaceContentGraphResource>,
  pub references: Vec<WorkspaceContentGraphReference>,
  pub target_definitions: Vec<WorkspaceContentTargetDefinition>,
  pub target_resource_ids: Vec<WorkspaceContentResourceRef>,
  /// Server-authored mappings for an Undo counter-operation. Public
  /// transports cannot supply these; they are derived from the immutable
  /// origin manifest and reloaded again at execute time.
  pub mapping_overrides: Vec<WorkspaceContentIdMapping>,
}

/// Stable reference placement relative to the selected operation graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceContentReferencePlacement {
  Internal,
  Incoming,
  Outgoing,
  Broken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// One graph edge projected into the operation-relative topology.
pub struct WorkspaceContentPlannedReference {
  pub relation: String,
  pub source: WorkspaceContentResourceRef,
  pub target: WorkspaceContentResourceRef,
  pub purpose: WorkspaceContentReferencePurpose,
  pub placement: WorkspaceContentReferencePlacement,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
/// Publication treatment for a planned source-to-target identity.
pub enum WorkspaceContentMappingAction {
  Preserve,
  Reuse,
  Create,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// Deterministic identity and optional display-name decision.
pub struct WorkspaceContentPlannedMapping {
  pub mapping: WorkspaceContentIdMapping,
  pub action: WorkspaceContentMappingAction,
  pub target_display_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
/// User-visible conflict families produced without mutating either workspace.
pub enum WorkspaceContentConflictKind {
  Key,
  Schema,
  PublicSharing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
/// One conflict and its server-authored resolution proposal, if resolvable.
pub struct WorkspaceContentConflict {
  pub kind: WorkspaceContentConflictKind,
  pub resource: WorkspaceContentResourceRef,
  pub suggested_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentKindCount {
  pub kind: WorkspaceContentResourceKind,
  pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentDependencyCount {
  pub class: WorkspaceContentDependencyClass,
  pub relation_count: usize,
}

/// Stable, content-free preflight graph returned to authorization and API code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContentPreflightGraph {
  pub kind: WorkspaceContentOperationKind,
  pub source_workspace_id: Uuid,
  pub target_workspace_id: Uuid,
  /// The organizer folder selected by Extract. Descendant folder mappings are
  /// not interchangeable with this source replacement identity.
  pub selection_root_folder_id: Option<String>,
  pub roots: Vec<WorkspaceContentResourceRef>,
  pub missing_resources: Vec<WorkspaceContentResourceRef>,
  pub resources: Vec<WorkspaceContentGraphResource>,
  pub references: Vec<WorkspaceContentPlannedReference>,
  pub mappings: Vec<WorkspaceContentPlannedMapping>,
  pub conflicts: Vec<WorkspaceContentConflict>,
  pub blockers: Vec<WorkspaceContentBlocker>,
  pub kind_counts: Vec<WorkspaceContentKindCount>,
  pub dependency_counts: Vec<WorkspaceContentDependencyCount>,
  pub active_reference_count: usize,
  pub broken_reference_count: usize,
  pub external_reference_count: usize,
  pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum WorkspaceContentGraphError {
  #[error("selected resource is not supported by workspace content operations")]
  SelectedResourceUnsupported,
  #[error("workspace content selection must not be empty")]
  EmptySelection,
  #[error("workspace content graph uses an invalid workspace boundary")]
  InvalidWorkspaceBoundary,
  #[error("workspace content resource snapshot is malformed")]
  InvalidResourceSnapshot,
  #[error("workspace content graph contains duplicate resource snapshots")]
  DuplicateResource,
  #[error("workspace content graph contains an unclassified persistence relation: {0}")]
  UnclassifiedRelation(String),
  #[error("non-transferable relation was declared as an owned dependency: {0}")]
  NonTransferableOwnedDependency(String),
  #[error("workspace content graph is incomplete for an owned dependency")]
  IncompleteOwnedDependency,
  #[error("workspace content target inventory is malformed")]
  InvalidTargetInventory,
  #[error("organizer folder is not present in the validated snapshot")]
  FolderNotFound,
  #[error("workspace content target suffix space is exhausted")]
  SuffixSpaceExhausted,
  #[error("workspace content preflight revision could not be serialized")]
  RevisionSerialization,
}

#[derive(Debug, Default)]
pub struct WorkspaceContentGraphBuilder;

impl WorkspaceContentGraphBuilder {
  pub fn build(
    &self,
    mut input: WorkspaceContentGraphInput,
  ) -> Result<WorkspaceContentPreflightGraph, WorkspaceContentGraphError> {
    validate_workspace_boundary(&input)?;
    let selection_root_folder_id = match &input.selection {
      WorkspaceContentSelection::FolderSubtree { folder_id, .. } => Some(folder_id.clone()),
      WorkspaceContentSelection::Resources(_) => None,
    };
    if (input.kind == WorkspaceContentOperationKind::ExtractFolder) != selection_root_folder_id.is_some() {
      return Err(WorkspaceContentGraphError::InvalidWorkspaceBoundary);
    }
    let mut roots = selection_roots(&input.selection, input.source_workspace_id)?;
    roots.sort();
    roots.dedup();
    if roots.is_empty() {
      return Err(WorkspaceContentGraphError::EmptySelection);
    }
    if roots
      .iter()
      .any(|resource| resource.kind() == WorkspaceContentResourceKind::Collection)
      || (input.kind == WorkspaceContentOperationKind::Link
        && roots.iter().any(|resource| {
          !matches!(
            resource.kind(),
            WorkspaceContentResourceKind::Document
              | WorkspaceContentResourceKind::Database
              | WorkspaceContentResourceKind::Tag
          )
        }))
      || input.mapping_overrides.iter().any(|mapping| {
        mapping.source.kind() == WorkspaceContentResourceKind::Collection
          || mapping.target.kind() == WorkspaceContentResourceKind::Collection
      })
    {
      return Err(WorkspaceContentGraphError::SelectedResourceUnsupported);
    }
    // Collection placements are lateral references resolved by Organizer.
    // They never contribute ownership, catalog inventory or filtered content.
    input
      .resources
      .retain(|resource| resource.resource.kind() != WorkspaceContentResourceKind::Collection);
    input
      .target_definitions
      .retain(|definition| definition.resource.kind() != WorkspaceContentResourceKind::Collection);
    input
      .target_resource_ids
      .retain(|resource| resource.kind() != WorkspaceContentResourceKind::Collection);

    if input.kind == WorkspaceContentOperationKind::Link {
      input.resources.retain(|resource| roots.contains(&resource.resource));
      input.references.clear();
      input.target_definitions.clear();
      input.target_resource_ids.clear();
    }
    let resources = index_resources(input.resources)?;
    let references = normalize_references(input.references)?;
    if matches!(input.selection, WorkspaceContentSelection::FolderSubtree { .. }) {
      // A contained shortcut is not a directly selected missing root.
      roots.retain(|root| root.kind() == WorkspaceContentResourceKind::Folder || resources.contains_key(root));
    }
    validate_target_inventory(
      input.target_workspace_id,
      &input.target_definitions,
      &input.target_resource_ids,
    )?;

    let (selected, missing_resources) =
      select_operation_resources(input.source_workspace_id, &roots, &resources, &references)?;
    if matches!(
      input.kind,
      WorkspaceContentOperationKind::Move | WorkspaceContentOperationKind::ExtractFolder
    ) && selected.iter().any(|resource| {
      resources
        .get(resource)
        .is_some_and(|resource| resource.database_system_role.is_some())
    }) {
      return Err(WorkspaceContentGraphError::SelectedResourceUnsupported);
    }
    let (planned_references, mut blockers_from_references) = plan_references(&selected, &references);
    if !missing_resources.is_empty() {
      blockers_from_references.insert(WorkspaceContentBlocker::BrokenReference);
    }
    let (mappings, mut conflicts) = plan_mappings(
      input.operation_id,
      input.kind,
      input.source_workspace_id,
      input.target_workspace_id,
      &selected,
      &resources,
      input.target_definitions,
      input.target_resource_ids,
      input.mapping_overrides,
    )?;

    let blockers = blockers_from_references;
    conflicts.sort_by(conflict_order);

    let selected_resources = selected
      .iter()
      .filter_map(|resource| resources.get(resource).cloned())
      .collect::<Vec<_>>();
    let kind_counts = count_resource_kinds(&selected_resources);
    let dependency_counts = count_dependencies(&selected_resources, &planned_references)?;
    let active_reference_count = planned_references
      .iter()
      .filter(|reference| reference.placement != WorkspaceContentReferencePlacement::Broken)
      .count();
    let broken_reference_count = planned_references.len() - active_reference_count;
    let external_reference_count = planned_references
      .iter()
      .filter(|reference| {
        matches!(
          reference.placement,
          WorkspaceContentReferencePlacement::Incoming | WorkspaceContentReferencePlacement::Outgoing
        )
      })
      .count();

    let mut graph = WorkspaceContentPreflightGraph {
      kind: input.kind,
      source_workspace_id: input.source_workspace_id,
      target_workspace_id: input.target_workspace_id,
      selection_root_folder_id,
      roots,
      missing_resources: missing_resources.clone(),
      resources: selected_resources,
      references: planned_references,
      mappings,
      conflicts,
      blockers: blockers.into_iter().collect(),
      kind_counts,
      dependency_counts,
      active_reference_count,
      broken_reference_count: broken_reference_count + missing_resources.len(),
      external_reference_count,
      revision: String::new(),
    };
    graph.revision = content_revision(input.kind, input.source_workspace_id, input.target_workspace_id, &graph)?;
    Ok(graph)
  }
}

fn validate_workspace_boundary(input: &WorkspaceContentGraphInput) -> Result<(), WorkspaceContentGraphError> {
  if input.source_workspace_id.is_nil()
    || input.target_workspace_id.is_nil()
    || input.source_workspace_id == input.target_workspace_id
  {
    return Err(WorkspaceContentGraphError::InvalidWorkspaceBoundary);
  }
  Ok(())
}

fn selection_roots(
  selection: &WorkspaceContentSelection,
  source_workspace_id: Uuid,
) -> Result<Vec<WorkspaceContentResourceRef>, WorkspaceContentGraphError> {
  match selection {
    WorkspaceContentSelection::Resources(resources) => {
      if resources
        .iter()
        .any(|resource| resource.workspace_id() != source_workspace_id)
      {
        return Err(WorkspaceContentGraphError::InvalidWorkspaceBoundary);
      }
      Ok(resources.clone())
    }
    WorkspaceContentSelection::FolderSubtree { organizer, folder_id } => {
      if organizer.workspace_id != source_workspace_id {
        return Err(WorkspaceContentGraphError::InvalidWorkspaceBoundary);
      }
      let node = find_organizer_node(&organizer.roots, folder_id).ok_or(WorkspaceContentGraphError::FolderNotFound)?;
      let mut roots = Vec::new();
      collect_organizer_roots(node, source_workspace_id, &mut roots)?;
      Ok(roots)
    }
  }
}

fn find_organizer_node<'a>(nodes: &'a [OrganizerSnapshotNode], folder_id: &str) -> Option<&'a OrganizerSnapshotNode> {
  nodes.iter().find_map(|node| {
    if node.row.id == folder_id && node.row.is_folder() {
      Some(node)
    } else {
      find_organizer_node(&node.children, folder_id)
    }
  })
}

fn collect_organizer_roots(
  node: &OrganizerSnapshotNode,
  source_workspace_id: Uuid,
  roots: &mut Vec<WorkspaceContentResourceRef>,
) -> Result<(), WorkspaceContentGraphError> {
  roots.push(
    WorkspaceContentResourceRef::new(
      source_workspace_id,
      WorkspaceContentResourceKind::Folder,
      node.row.id.clone(),
    )
    .map_err(|_| WorkspaceContentGraphError::InvalidResourceSnapshot)?,
  );
  for child in &node.children {
    if child.row.is_folder() {
      collect_organizer_roots(child, source_workspace_id, roots)?;
      continue;
    }
    let target_workspace_id = child.row.effective_target_workspace_id(source_workspace_id);
    if target_workspace_id != source_workspace_id {
      continue;
    }
    let kind = match child
      .row
      .link_type()
      .map_err(|_| WorkspaceContentGraphError::InvalidResourceSnapshot)?
    {
      OrganizerLinkType::Doc => WorkspaceContentResourceKind::Document,
      OrganizerLinkType::Database => WorkspaceContentResourceKind::Database,
      OrganizerLinkType::Collection => continue,
      OrganizerLinkType::Tag => WorkspaceContentResourceKind::Tag,
      OrganizerLinkType::Workspace => continue,
    };
    if let Ok(resource) = WorkspaceContentResourceRef::new(target_workspace_id, kind, child.row.data.clone()) {
      roots.push(resource);
    }
  }
  Ok(())
}

fn index_resources(
  resources: Vec<WorkspaceContentGraphResource>,
) -> Result<BTreeMap<WorkspaceContentResourceRef, WorkspaceContentGraphResource>, WorkspaceContentGraphError> {
  let mut indexed = BTreeMap::new();
  for mut resource in resources {
    validate_resource(&resource)?;
    resource.persistence_relations.sort();
    resource.persistence_relations.dedup();
    if indexed.insert(resource.resource.clone(), resource).is_some() {
      return Err(WorkspaceContentGraphError::DuplicateResource);
    }
  }
  Ok(indexed)
}

fn validate_resource(resource: &WorkspaceContentGraphResource) -> Result<(), WorkspaceContentGraphError> {
  if invalid_bounded(&resource.revision, MAX_REVISION_BYTES)
    || (resource.resource.kind() == WorkspaceContentResourceKind::Document) != resource.permission_resource_id.is_some()
    // Document titles are content, not normalized reconciliation names. An
    // untitled document (or a title containing whitespace) is valid persisted
    // data and must not invalidate an otherwise transferable graph.
    || (resource.resource.kind() != WorkspaceContentResourceKind::Document
      && resource
        .display_name
        .as_deref()
        .is_some_and(|value| invalid_bounded(value, MAX_DISPLAY_NAME_BYTES)))
    || resource
      .schema_revision
      .as_deref()
      .is_some_and(|value| invalid_bounded(value, MAX_SCHEMA_REVISION_BYTES))
    || resource.persistence_relations.is_empty()
  {
    return Err(WorkspaceContentGraphError::InvalidResourceSnapshot);
  }
  for relation in &resource.persistence_relations {
    classify_relation(relation)?;
  }
  Ok(())
}

fn normalize_references(
  mut references: Vec<WorkspaceContentGraphReference>,
) -> Result<Vec<WorkspaceContentGraphReference>, WorkspaceContentGraphError> {
  references.retain(|reference| {
    reference.purpose != WorkspaceContentReferencePurpose::OwnedDependency
      || (reference.source.kind() != WorkspaceContentResourceKind::Collection
        && reference.target.kind() != WorkspaceContentResourceKind::Collection)
  });
  for reference in &references {
    if invalid_bounded(&reference.relation, MAX_RELATION_BYTES) {
      return Err(WorkspaceContentGraphError::InvalidResourceSnapshot);
    }
    let class = classify_relation(&reference.relation)?;
    if reference.purpose == WorkspaceContentReferencePurpose::OwnedDependency
      && matches!(
        class,
        WorkspaceContentDependencyClass::DerivedRebuild | WorkspaceContentDependencyClass::SourceOwned
      )
    {
      return Err(WorkspaceContentGraphError::NonTransferableOwnedDependency(
        reference.relation.clone(),
      ));
    }
  }
  references.sort();
  references.dedup();
  Ok(references)
}

fn validate_target_inventory(
  target_workspace_id: Uuid,
  definitions: &[WorkspaceContentTargetDefinition],
  resources: &[WorkspaceContentResourceRef],
) -> Result<(), WorkspaceContentGraphError> {
  let mut resources_seen = BTreeSet::new();
  for resource in resources {
    if resource.workspace_id() != target_workspace_id || !resources_seen.insert(resource.clone()) {
      return Err(WorkspaceContentGraphError::InvalidTargetInventory);
    }
  }
  let mut definitions_seen = BTreeSet::new();
  for definition in definitions {
    if definition.resource.workspace_id() != target_workspace_id
      || invalid_bounded(&definition.display_name, MAX_DISPLAY_NAME_BYTES)
      || definition
        .schema_revision
        .as_deref()
        .is_some_and(|value| invalid_bounded(value, MAX_SCHEMA_REVISION_BYTES))
      || !definitions_seen.insert(definition.resource.clone())
    {
      return Err(WorkspaceContentGraphError::InvalidTargetInventory);
    }
  }
  Ok(())
}

fn select_operation_resources(
  source_workspace_id: Uuid,
  roots: &[WorkspaceContentResourceRef],
  resources: &BTreeMap<WorkspaceContentResourceRef, WorkspaceContentGraphResource>,
  references: &[WorkspaceContentGraphReference],
) -> Result<(BTreeSet<WorkspaceContentResourceRef>, Vec<WorkspaceContentResourceRef>), WorkspaceContentGraphError> {
  let mut selected = BTreeSet::new();
  let mut missing = BTreeSet::new();
  let mut queue = VecDeque::from(roots.to_vec());
  while let Some(resource) = queue.pop_front() {
    if resource.workspace_id() != source_workspace_id || selected.contains(&resource) || missing.contains(&resource) {
      continue;
    }
    let Some(_) = resources.get(&resource) else {
      missing.insert(resource);
      continue;
    };
    selected.insert(resource.clone());
    for reference in references.iter().filter(|reference| {
      reference.source == resource
        && reference.purpose == WorkspaceContentReferencePurpose::OwnedDependency
        && reference.target.workspace_id() == source_workspace_id
    }) {
      if !reference.target_exists {
        if reference.source.kind() == WorkspaceContentResourceKind::Folder && reference.relation == "doc_updates" {
          continue;
        }
        return Err(WorkspaceContentGraphError::IncompleteOwnedDependency);
      }
      if !resources.contains_key(&reference.target) {
        return Err(WorkspaceContentGraphError::IncompleteOwnedDependency);
      }
      queue.push_back(reference.target.clone());
    }
  }
  Ok((selected, missing.into_iter().collect()))
}

fn plan_references(
  selected: &BTreeSet<WorkspaceContentResourceRef>,
  references: &[WorkspaceContentGraphReference],
) -> (Vec<WorkspaceContentPlannedReference>, BTreeSet<WorkspaceContentBlocker>) {
  let mut planned = Vec::new();
  let blockers = BTreeSet::new();
  for reference in references {
    let source_selected = selected.contains(&reference.source);
    let target_selected = selected.contains(&reference.target);
    if !source_selected && !target_selected {
      continue;
    }
    let placement = if !reference.target_exists {
      // Required owned bytes fail closed during selection. Contained absence
      // is an omission; repository/decoder failures never reach this branch.
      WorkspaceContentReferencePlacement::Broken
    } else if source_selected && target_selected {
      WorkspaceContentReferencePlacement::Internal
    } else if source_selected {
      WorkspaceContentReferencePlacement::Outgoing
    } else {
      WorkspaceContentReferencePlacement::Incoming
    };
    planned.push(WorkspaceContentPlannedReference {
      relation: reference.relation.clone(),
      source: reference.source.clone(),
      target: reference.target.clone(),
      purpose: reference.purpose,
      placement,
    });
  }
  planned.sort_by(reference_order);
  (planned, blockers)
}

#[expect(
  clippy::too_many_arguments,
  reason = "preflight keeps source, target, policy, and overrides explicit"
)]
fn plan_mappings(
  operation_id: Uuid,
  kind: WorkspaceContentOperationKind,
  source_workspace_id: Uuid,
  target_workspace_id: Uuid,
  selected: &BTreeSet<WorkspaceContentResourceRef>,
  resources: &BTreeMap<WorkspaceContentResourceRef, WorkspaceContentGraphResource>,
  mut target_definitions: Vec<WorkspaceContentTargetDefinition>,
  target_resource_ids: Vec<WorkspaceContentResourceRef>,
  mapping_overrides: Vec<WorkspaceContentIdMapping>,
) -> Result<(Vec<WorkspaceContentPlannedMapping>, Vec<WorkspaceContentConflict>), WorkspaceContentGraphError> {
  target_definitions.sort_by(|left, right| left.resource.cmp(&right.resource));
  let mut occupied = target_resource_ids.into_iter().collect::<BTreeSet<_>>();
  occupied.extend(target_definitions.iter().map(|definition| definition.resource.clone()));
  let mut occupied_names = target_definitions
    .iter()
    .map(|definition| normalized_name(&definition.display_name))
    .collect::<BTreeSet<_>>();
  let mut mappings = Vec::new();
  let mut conflicts = Vec::new();

  let undo = !mapping_overrides.is_empty();
  let mut overrides = mapping_overrides
    .into_iter()
    .map(|mapping| (mapping.source.clone(), mapping))
    .collect::<BTreeMap<_, _>>();
  if undo
    && (kind != WorkspaceContentOperationKind::Move
      || overrides.len()
        != selected
          .iter()
          .filter(|source| {
            !matches!(
              source.kind(),
              WorkspaceContentResourceKind::Tag | WorkspaceContentResourceKind::Blob
            )
          })
          .count())
  {
    return Err(WorkspaceContentGraphError::InvalidTargetInventory);
  }
  let mut override_targets = BTreeSet::new();

  // Resolve active source values first, so historical values can share a new
  // active target rather than creating an avoidable archived duplicate.
  let mut ordered = selected.iter().collect::<Vec<_>>();
  ordered.sort_by_key(|source| (resources[*source].tag_archived, *source));
  for source in ordered {
    let resource = resources
      .get(source)
      .expect("selected resources are indexed before mapping");
    if undo
      && !matches!(
        source.kind(),
        WorkspaceContentResourceKind::Tag | WorkspaceContentResourceKind::Blob
      )
    {
      let mut mapping = overrides
        .remove(source)
        .ok_or(WorkspaceContentGraphError::InvalidTargetInventory)?;
      if mapping.source.workspace_id() != source_workspace_id
        || mapping.target.workspace_id() != target_workspace_id
        || mapping.source.kind() != mapping.target.kind()
        || !override_targets.insert(mapping.target.clone())
      {
        return Err(WorkspaceContentGraphError::InvalidTargetInventory);
      }
      if occupied.contains(&mapping.target) {
        if source.kind() != WorkspaceContentResourceKind::Document {
          return Err(WorkspaceContentGraphError::InvalidTargetInventory);
        }
        mapping.target =
          available_target_identity(operation_id, kind, target_workspace_id, &mapping.target, &occupied)?;
      }
      occupied.insert(mapping.target.clone());
      mappings.push(planned_mapping(
        mapping.source,
        mapping.target,
        WorkspaceContentMappingAction::Preserve,
        resource.display_name.clone(),
      )?);
      continue;
    }
    if kind == WorkspaceContentOperationKind::Link {
      mappings.push(planned_mapping(
        source.clone(),
        source.clone(),
        WorkspaceContentMappingAction::Preserve,
        resource.display_name.clone(),
      )?);
      continue;
    }

    if source.kind() == WorkspaceContentResourceKind::Tag {
      let name = resource
        .display_name
        .as_deref()
        .ok_or(WorkspaceContentGraphError::InvalidResourceSnapshot)?;
      let reusable = target_definitions
        .iter()
        .filter(|target| {
          target.resource.kind() == WorkspaceContentResourceKind::Tag
            && tag_target_is_reusable(name, resource.tag_archived, &target.display_name, target.tag_archived)
        })
        .min_by_key(|target| (target.tag_archived, &target.resource));
      let (target, action, target_name) = if let Some(target) = reusable {
        (
          target.resource.clone(),
          WorkspaceContentMappingAction::Reuse,
          target.display_name.clone(),
        )
      } else {
        let target = available_target_identity(
          operation_id,
          WorkspaceContentOperationKind::Copy,
          target_workspace_id,
          source,
          &occupied,
        )?;
        occupied.insert(target.clone());
        target_definitions.push(WorkspaceContentTargetDefinition {
          resource: target.clone(),
          display_name: name.into(),
          schema_revision: None,
          tag_archived: resource.tag_archived,
        });
        (target, WorkspaceContentMappingAction::Create, name.into())
      };
      mappings.push(planned_mapping(source.clone(), target, action, Some(target_name))?);
      continue;
    }

    // Database reuse retains Copy's existing schema policy. Tags above use
    // the same name/archive classification policy for Copy, Move and Extract.
    if kind == WorkspaceContentOperationKind::Copy
      && is_reusable_workspace_definition(source.kind())
      && let Some(name) = resource.display_name.as_deref()
    {
      let normalized = normalized_name(name);
      let mut same_name = target_definitions
        .iter()
        .filter(|definition| {
          definition.resource.kind() == source.kind() && normalized_name(&definition.display_name) == normalized
        })
        .collect::<Vec<_>>();
      same_name.sort_by(|left, right| left.resource.cmp(&right.resource));
      if let Some(reusable) = same_name
        .iter()
        .find(|definition| definition.schema_revision == resource.schema_revision)
      {
        mappings.push(planned_mapping(
          source.clone(),
          reusable.resource.clone(),
          WorkspaceContentMappingAction::Reuse,
          Some(reusable.display_name.clone()),
        )?);
        continue;
      }
      if !same_name.is_empty() {
        let suggested_name = available_name(name, &occupied_names)?;
        occupied_names.insert(normalized_name(&suggested_name));
        let target = available_target_identity(
          operation_id,
          WorkspaceContentOperationKind::Copy,
          target_workspace_id,
          source,
          &occupied,
        )?;
        occupied.insert(target.clone());
        conflicts.push(WorkspaceContentConflict {
          kind: WorkspaceContentConflictKind::Schema,
          resource: source.clone(),
          suggested_name: Some(suggested_name.clone()),
        });
        mappings.push(planned_mapping(
          source.clone(),
          target,
          WorkspaceContentMappingAction::Create,
          Some(suggested_name),
        )?);
        continue;
      }
      occupied_names.insert(normalized);
      let target = available_target_identity(
        operation_id,
        WorkspaceContentOperationKind::Copy,
        target_workspace_id,
        source,
        &occupied,
      )?;
      occupied.insert(target.clone());
      mappings.push(planned_mapping(
        source.clone(),
        target,
        WorkspaceContentMappingAction::Create,
        resource.display_name.clone(),
      )?);
      continue;
    }

    let mut target_display_name = resource.display_name.clone();
    if source.kind() == WorkspaceContentResourceKind::Database
      && let Some(name) = resource.display_name.as_deref()
    {
      let normalized = normalized_name(name);
      let same_name = target_definitions
        .iter()
        .filter(|definition| {
          definition.resource.kind() == WorkspaceContentResourceKind::Database
            && normalized_name(&definition.display_name) == normalized
        })
        .collect::<Vec<_>>();
      if same_name.is_empty() {
        occupied_names.insert(normalized);
      } else {
        let suggested_name = available_name(name, &occupied_names)?;
        occupied_names.insert(normalized_name(&suggested_name));
        conflicts.push(WorkspaceContentConflict {
          kind: if same_name
            .iter()
            .any(|definition| definition.schema_revision == resource.schema_revision)
          {
            WorkspaceContentConflictKind::Key
          } else {
            WorkspaceContentConflictKind::Schema
          },
          resource: source.clone(),
          suggested_name: Some(suggested_name.clone()),
        });
        target_display_name = Some(suggested_name);
      }
    }

    let target = available_target_identity(operation_id, kind, target_workspace_id, source, &occupied)?;
    let action = if source.kind() == WorkspaceContentResourceKind::Blob {
      WorkspaceContentMappingAction::Create
    } else if matches!(
      kind,
      WorkspaceContentOperationKind::Move | WorkspaceContentOperationKind::ExtractFolder
    ) {
      WorkspaceContentMappingAction::Preserve
    } else {
      WorkspaceContentMappingAction::Create
    };
    if occupied.contains(
      &WorkspaceContentResourceRef::new(target_workspace_id, source.kind(), source.resource_id())
        .expect("validated source identity"),
    ) && target.resource_id() != source.resource_id()
    {
      conflicts.push(WorkspaceContentConflict {
        kind: WorkspaceContentConflictKind::Key,
        resource: source.clone(),
        suggested_name: Some(target.resource_id().to_string()),
      });
    }
    occupied.insert(target.clone());
    mappings.push(planned_mapping(source.clone(), target, action, target_display_name)?);
  }
  mappings.sort_by(|left, right| left.mapping.source.cmp(&right.mapping.source));
  conflicts.sort_by(conflict_order);
  Ok((mappings, conflicts))
}

fn planned_mapping(
  source: WorkspaceContentResourceRef,
  target: WorkspaceContentResourceRef,
  action: WorkspaceContentMappingAction,
  target_display_name: Option<String>,
) -> Result<WorkspaceContentPlannedMapping, WorkspaceContentGraphError> {
  let mapping =
    WorkspaceContentIdMapping::new(source, target).map_err(|_| WorkspaceContentGraphError::InvalidResourceSnapshot)?;
  Ok(WorkspaceContentPlannedMapping {
    mapping,
    action,
    target_display_name,
  })
}

fn available_target_identity(
  operation_id: Uuid,
  operation: WorkspaceContentOperationKind,
  target_workspace_id: Uuid,
  source: &WorkspaceContentResourceRef,
  occupied: &BTreeSet<WorkspaceContentResourceRef>,
) -> Result<WorkspaceContentResourceRef, WorkspaceContentGraphError> {
  // Route collisions and newly materialized assets use bounded private keys.
  // SQL document/Database identities are preserved by the Move publisher.
  let preserve_identity = matches!(
    operation,
    WorkspaceContentOperationKind::Move | WorkspaceContentOperationKind::ExtractFolder
  );
  for suffix in 1..=MAX_SUFFIX_ATTEMPTS {
    let resource_id = if preserve_identity && source.kind() != WorkspaceContentResourceKind::Blob && suffix == 1 {
      source.resource_id().to_string()
    } else {
      operation_private_resource_key(operation_id, target_workspace_id, source, suffix)
    };
    let target = WorkspaceContentResourceRef::new(target_workspace_id, source.kind(), resource_id)
      .map_err(|_| WorkspaceContentGraphError::InvalidResourceSnapshot)?;
    if !occupied.contains(&target) {
      return Ok(target);
    }
  }
  Err(WorkspaceContentGraphError::SuffixSpaceExhausted)
}

/// The persisted operation and qualified resource kind own each private key.
pub(crate) fn operation_private_resource_key(
  operation_id: Uuid,
  target_workspace_id: Uuid,
  source: &WorkspaceContentResourceRef,
  suffix: u32,
) -> String {
  Uuid::new_v5(
    &operation_id,
    format!(
      "{}:{}:{}:{}:{suffix}",
      source.workspace_id(),
      target_workspace_id,
      source.kind().as_str(),
      source.resource_id()
    )
    .as_bytes(),
  )
  .to_string()
}

fn available_name(name: &str, occupied: &BTreeSet<String>) -> Result<String, WorkspaceContentGraphError> {
  for suffix in 2..=MAX_SUFFIX_ATTEMPTS {
    let candidate = format!("{} ({suffix})", name.trim());
    if !occupied.contains(&normalized_name(&candidate)) {
      return Ok(candidate);
    }
  }
  Err(WorkspaceContentGraphError::SuffixSpaceExhausted)
}

fn is_reusable_workspace_definition(kind: WorkspaceContentResourceKind) -> bool {
  matches!(kind, WorkspaceContentResourceKind::Tag)
}

/// Transfer equality is name/archive based. Color and description belong to
/// the target; an active source never acquires an archived target identity.
pub fn tag_target_is_reusable(
  source_name: &str,
  source_archived: bool,
  target_name: &str,
  target_archived: bool,
) -> bool {
  normalized_name(source_name) == normalized_name(target_name) && (source_archived || !target_archived)
}

fn normalized_name(value: &str) -> String {
  value.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn count_resource_kinds(resources: &[WorkspaceContentGraphResource]) -> Vec<WorkspaceContentKindCount> {
  let mut counts = BTreeMap::new();
  for resource in resources {
    *counts.entry(resource.resource.kind()).or_insert(0) += 1;
  }
  counts
    .into_iter()
    .map(|(kind, count)| WorkspaceContentKindCount { kind, count })
    .collect()
}

fn count_dependencies(
  resources: &[WorkspaceContentGraphResource],
  references: &[WorkspaceContentPlannedReference],
) -> Result<Vec<WorkspaceContentDependencyCount>, WorkspaceContentGraphError> {
  let mut relations = BTreeMap::new();
  for relation in resources
    .iter()
    .flat_map(|resource| resource.persistence_relations.iter())
    .chain(references.iter().map(|reference| &reference.relation))
  {
    relations.insert(relation, classify_relation(relation)?);
  }
  let mut counts = BTreeMap::new();
  for class in relations.into_values() {
    *counts.entry(class).or_insert(0) += 1;
  }
  Ok(
    counts
      .into_iter()
      .map(|(class, relation_count)| WorkspaceContentDependencyCount { class, relation_count })
      .collect(),
  )
}

fn classify_relation(relation: &str) -> Result<WorkspaceContentDependencyClass, WorkspaceContentGraphError> {
  workspace_content_dependency(relation)
    .map(|dependency| dependency.class)
    .ok_or_else(|| WorkspaceContentGraphError::UnclassifiedRelation(relation.to_string()))
}

fn reference_order(
  left: &WorkspaceContentPlannedReference,
  right: &WorkspaceContentPlannedReference,
) -> std::cmp::Ordering {
  (&left.source, &left.target, &left.relation, left.purpose, left.placement).cmp(&(
    &right.source,
    &right.target,
    &right.relation,
    right.purpose,
    right.placement,
  ))
}

fn conflict_order(left: &WorkspaceContentConflict, right: &WorkspaceContentConflict) -> std::cmp::Ordering {
  (left.kind, &left.resource, &left.suggested_name).cmp(&(right.kind, &right.resource, &right.suggested_name))
}

fn content_revision(
  kind: WorkspaceContentOperationKind,
  source_workspace_id: Uuid,
  target_workspace_id: Uuid,
  graph: &WorkspaceContentPreflightGraph,
) -> Result<String, WorkspaceContentGraphError> {
  #[derive(Serialize)]
  #[serde(rename_all = "camelCase")]
  struct RevisionMaterial<'a> {
    reference_plan_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    reference_admission_version: Option<u32>,
    kind: WorkspaceContentOperationKind,
    source_workspace_id: Uuid,
    target_workspace_id: Uuid,
    roots: &'a [WorkspaceContentResourceRef],
    missing_resources: &'a [WorkspaceContentResourceRef],
    resources: &'a [WorkspaceContentGraphResource],
    references: &'a [WorkspaceContentPlannedReference],
    mappings: &'a [WorkspaceContentPlannedMapping],
    conflicts: &'a [WorkspaceContentConflict],
    blockers: &'a [WorkspaceContentBlocker],
    kind_counts: &'a [WorkspaceContentKindCount],
    dependency_counts: &'a [WorkspaceContentDependencyCount],
  }
  let material = RevisionMaterial {
    reference_plan_version: super::NATIVE_REFERENCE_PLAN_VERSION,
    reference_admission_version: (kind != WorkspaceContentOperationKind::Link)
      .then_some(super::REFERENCE_ADMISSION_VERSION),
    kind,
    source_workspace_id,
    target_workspace_id,
    roots: &graph.roots,
    missing_resources: &graph.missing_resources,
    resources: &graph.resources,
    references: &graph.references,
    mappings: &graph.mappings,
    conflicts: &graph.conflicts,
    blockers: &graph.blockers,
    kind_counts: &graph.kind_counts,
    dependency_counts: &graph.dependency_counts,
  };
  serde_json::to_vec(&material)
    .map(|bytes| hex::encode(Sha256::digest(bytes)))
    .map_err(|_| WorkspaceContentGraphError::RevisionSerialization)
}

fn invalid_bounded(value: &str, max_bytes: usize) -> bool {
  value.is_empty() || value.len() > max_bytes || value.trim() != value || value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::organizer::{OrganizerRow, OrganizerSnapshotNode};

  #[test]
  fn document_titles_are_not_reconciliation_name_constraints() {
    for title in [
      String::new(),
      " Title\n ".into(),
      "x".repeat(MAX_DISPLAY_NAME_BYTES + 1),
    ] {
      let document = resource(
        Uuid::new_v4(),
        WorkspaceContentResourceKind::Document,
        "untitled",
        Some(&title),
        None,
        &["docs"],
      );
      assert_eq!(validate_resource(&document), Ok(()));
      let mut missing_acl_identity = document;
      missing_acl_identity.permission_resource_id = None;
      assert_eq!(
        validate_resource(&missing_acl_identity),
        Err(WorkspaceContentGraphError::InvalidResourceSnapshot)
      );
    }
  }

  fn resource(
    workspace_id: Uuid,
    kind: WorkspaceContentResourceKind,
    id: &str,
    name: Option<&str>,
    schema: Option<&str>,
    relations: &[&str],
  ) -> WorkspaceContentGraphResource {
    WorkspaceContentGraphResource {
      database_system_role: None,
      resource: WorkspaceContentResourceRef::new(workspace_id, kind, id).unwrap(),
      permission_resource_id: (kind == WorkspaceContentResourceKind::Document)
        .then(|| Uuid::new_v5(&workspace_id, format!("permission:{id}").as_bytes())),
      revision: format!("revision-{id}"),
      display_name: name.map(str::to_string),
      schema_revision: schema.map(str::to_string),
      persistence_relations: relations.iter().map(|value| (*value).to_string()).collect(),
      publicly_shared: false,
      tag_archived: false,
    }
  }

  fn reference(
    relation: &str,
    source: &WorkspaceContentResourceRef,
    target: &WorkspaceContentResourceRef,
    purpose: WorkspaceContentReferencePurpose,
    target_exists: bool,
  ) -> WorkspaceContentGraphReference {
    WorkspaceContentGraphReference {
      relation: relation.to_string(),
      source: source.clone(),
      target: target.clone(),
      purpose,
      target_exists,
    }
  }

  #[test]
  fn mixed_graph_is_deterministic_and_maps_every_resource_once() {
    let source_workspace = Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap();
    let target_workspace = Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap();
    let document = resource(
      source_workspace,
      WorkspaceContentResourceKind::Document,
      "roadmap",
      Some("Roadmap"),
      None,
      &["docs", "doc_updates"],
    );
    let database = resource(
      source_workspace,
      WorkspaceContentResourceKind::Database,
      "33333333-3333-4333-8333-333333333333",
      Some("Projects"),
      Some("schema-v2"),
      &["workspace_databases", "workspace_database_rows"],
    );
    let tag = resource(
      source_workspace,
      WorkspaceContentResourceKind::Tag,
      "44444444-4444-4444-8444-444444444444",
      Some("Release Ready"),
      Some("tag-schema"),
      &["workspace_tags", "workspace_tag_document_assignments"],
    );
    let collection = resource(
      source_workspace,
      WorkspaceContentResourceKind::Collection,
      "77777777-7777-4777-8777-777777777777",
      Some("Delivery"),
      Some("collection-schema"),
      &["doc_updates"],
    );
    let blob = resource(
      source_workspace,
      WorkspaceContentResourceKind::Blob,
      "sha256-asset",
      None,
      None,
      &["blobs"],
    );
    let external =
      WorkspaceContentResourceRef::new(source_workspace, WorkspaceContentResourceKind::Document, "outside").unwrap();
    let incoming =
      WorkspaceContentResourceRef::new(source_workspace, WorkspaceContentResourceKind::Document, "incoming").unwrap();
    let target_tag = WorkspaceContentResourceRef::new(
      target_workspace,
      WorkspaceContentResourceKind::Tag,
      "55555555-5555-4555-8555-555555555555",
    )
    .unwrap();
    let target_database = WorkspaceContentResourceRef::new(
      target_workspace,
      WorkspaceContentResourceKind::Database,
      "66666666-6666-4666-8666-666666666666",
    )
    .unwrap();
    let target_document =
      WorkspaceContentResourceRef::new(target_workspace, WorkspaceContentResourceKind::Document, "roadmap").unwrap();
    let target_collection = WorkspaceContentResourceRef::new(
      target_workspace,
      WorkspaceContentResourceKind::Collection,
      "88888888-8888-4888-8888-888888888888",
    )
    .unwrap();
    let mut published_document = document.clone();
    published_document.publicly_shared = true;
    let input = WorkspaceContentGraphInput {
      operation_id: Uuid::nil(),
      kind: WorkspaceContentOperationKind::Move,
      source_workspace_id: source_workspace,
      target_workspace_id: target_workspace,
      selection: WorkspaceContentSelection::Resources(vec![published_document.resource.clone()]),
      resources: vec![
        published_document.clone(),
        database.clone(),
        tag.clone(),
        collection.clone(),
        blob.clone(),
      ],
      references: vec![
        reference(
          "workspace_database_relation_edges",
          &published_document.resource,
          &database.resource,
          WorkspaceContentReferencePurpose::OwnedDependency,
          true,
        ),
        reference(
          "workspace_tag_document_assignments",
          &database.resource,
          &tag.resource,
          WorkspaceContentReferencePurpose::OwnedDependency,
          true,
        ),
        reference(
          "workspace_tag_document_assignments",
          &database.resource,
          &tag.resource,
          WorkspaceContentReferencePurpose::OwnedDependency,
          true,
        ),
        reference(
          "doc_updates",
          &collection.resource,
          &tag.resource,
          WorkspaceContentReferencePurpose::OwnedDependency,
          true,
        ),
        reference(
          "comment_attachments",
          &tag.resource,
          &blob.resource,
          WorkspaceContentReferencePurpose::OwnedDependency,
          true,
        ),
        reference(
          "document_graph_occurrences",
          &published_document.resource,
          &external,
          WorkspaceContentReferencePurpose::Reference,
          true,
        ),
        reference(
          "document_graph_occurrences",
          &incoming,
          &database.resource,
          WorkspaceContentReferencePurpose::Reference,
          true,
        ),
      ],
      target_definitions: vec![
        WorkspaceContentTargetDefinition {
          resource: target_tag.clone(),
          display_name: "  release   ready ".trim().to_string(),
          schema_revision: Some("tag-schema".to_string()),
          tag_archived: false,
        },
        WorkspaceContentTargetDefinition {
          resource: target_database,
          display_name: "Projects".to_string(),
          schema_revision: Some("schema-v1".to_string()),
          tag_archived: false,
        },
        WorkspaceContentTargetDefinition {
          resource: target_collection.clone(),
          display_name: "Delivery".to_string(),
          schema_revision: Some("collection-schema".to_string()),
          tag_archived: false,
        },
      ],
      target_resource_ids: vec![target_tag.clone(), target_document],
      mapping_overrides: Vec::new(),
    };
    let builder = WorkspaceContentGraphBuilder;
    let copied = builder
      .build(WorkspaceContentGraphInput {
        operation_id: Uuid::nil(),
        kind: WorkspaceContentOperationKind::Copy,
        ..input.clone()
      })
      .unwrap();
    for (source, target) in [(&tag.resource, &target_tag)] {
      assert!(copied.mappings.iter().any(|mapping| {
        &mapping.mapping.source == source
          && &mapping.mapping.target == target
          && mapping.action == WorkspaceContentMappingAction::Reuse
      }));
    }
    assert!(
      !copied
        .mappings
        .iter()
        .any(|mapping| mapping.mapping.source.kind() == WorkspaceContentResourceKind::Collection)
    );
    let mut direct_collection = input.clone();
    direct_collection.selection = WorkspaceContentSelection::Resources(vec![collection.resource.clone()]);
    assert_eq!(
      builder.build(direct_collection),
      Err(WorkspaceContentGraphError::SelectedResourceUnsupported)
    );
    let first = builder.build(input.clone()).unwrap();

    let mut permuted = input;
    permuted.resources.reverse();
    permuted.references.reverse();
    permuted.target_definitions.reverse();
    if let WorkspaceContentSelection::Resources(roots) = &mut permuted.selection {
      roots.push(roots[0].clone());
    }
    let second = builder.build(permuted).unwrap();
    assert_eq!(first, second, "input ordering must not affect graph or revision");
    assert_eq!(first.resources.len(), 4);
    assert_eq!(first.mappings.len(), 4);
    assert_eq!(
      first
        .mappings
        .iter()
        .map(|mapping| &mapping.mapping.source)
        .collect::<BTreeSet<_>>()
        .len(),
      4
    );
    assert_eq!(first.active_reference_count, 5);
    assert_eq!(first.external_reference_count, 2);
    assert_eq!(first.broken_reference_count, 0);
    assert!(first.blockers.is_empty());
    assert!(first.conflicts.iter().any(|conflict| {
      conflict.kind == WorkspaceContentConflictKind::Schema
        && conflict.suggested_name.as_deref() == Some("Projects (2)")
    }));
    let document_mapping = first
      .mappings
      .iter()
      .find(|mapping| mapping.mapping.source == published_document.resource)
      .unwrap();
    assert_ne!(
      document_mapping.mapping.target.resource_id(),
      published_document.resource.resource_id()
    );
    assert_eq!(document_mapping.action, WorkspaceContentMappingAction::Preserve);
    assert!(first.conflicts.iter().any(|conflict| {
      conflict.kind == WorkspaceContentConflictKind::Key
        && conflict.resource == published_document.resource
        && conflict.suggested_name.as_deref() == Some(document_mapping.mapping.target.resource_id())
    }));
    assert!(first.mappings.iter().any(|mapping| {
      mapping.mapping.source == tag.resource
        && mapping.mapping.target == target_tag
        && mapping.action == WorkspaceContentMappingAction::Reuse
    }));
    assert!(first.mappings.iter().any(|mapping| {
      mapping.mapping.source == database.resource
        && mapping.mapping.target.resource_id() == database.resource.resource_id()
        && mapping.action == WorkspaceContentMappingAction::Preserve
        && mapping.target_display_name.as_deref() == Some("Projects (2)")
    }));
    assert!(first.mappings.iter().any(|mapping| {
      mapping.mapping.source == blob.resource
        && mapping.action == WorkspaceContentMappingAction::Create
        && mapping.mapping.target.resource_id() != blob.resource.resource_id()
    }));
    assert!(
      !first
        .mappings
        .iter()
        .any(|mapping| mapping.mapping.source.kind() == WorkspaceContentResourceKind::Collection)
    );
    assert_eq!(first.revision.len(), 64);
  }

  #[test]
  fn undo_mapping_overrides_restore_the_origin_identity_and_fail_closed_on_drift() {
    let source_workspace = Uuid::new_v4();
    let target_workspace = Uuid::new_v4();
    let document = resource(
      source_workspace,
      WorkspaceContentResourceKind::Document,
      "renamed-after-move",
      Some("Document"),
      None,
      &["docs"],
    );
    let restored =
      WorkspaceContentResourceRef::new(target_workspace, WorkspaceContentResourceKind::Document, "original-key")
        .unwrap();
    let override_mapping = WorkspaceContentIdMapping::new(document.resource.clone(), restored.clone()).unwrap();
    let input = WorkspaceContentGraphInput {
      operation_id: Uuid::nil(),
      kind: WorkspaceContentOperationKind::Move,
      source_workspace_id: source_workspace,
      target_workspace_id: target_workspace,
      selection: WorkspaceContentSelection::Resources(vec![document.resource.clone()]),
      resources: vec![document],
      references: Vec::new(),
      target_definitions: Vec::new(),
      target_resource_ids: Vec::new(),
      mapping_overrides: vec![override_mapping],
    };

    let graph = WorkspaceContentGraphBuilder.build(input.clone()).unwrap();
    assert_eq!(graph.mappings.len(), 1);
    assert_eq!(graph.mappings[0].mapping.target, restored);
    assert_eq!(graph.mappings[0].action, WorkspaceContentMappingAction::Preserve);

    let mut occupied = input.clone();
    occupied.target_resource_ids.push(restored.clone());
    let reallocated = WorkspaceContentGraphBuilder.build(occupied).unwrap();
    assert_eq!(reallocated.mappings[0].mapping.source, graph.mappings[0].mapping.source);
    assert_eq!(reallocated.mappings[0].mapping.target.workspace_id(), target_workspace);
    assert_ne!(
      reallocated.mappings[0].mapping.target, restored,
      "Undo reallocates its local route rather than overwriting the occupied address"
    );
    assert_eq!(reallocated.mappings[0].action, WorkspaceContentMappingAction::Preserve);

    let mut public_override = input;
    public_override.kind = WorkspaceContentOperationKind::Copy;
    assert_eq!(
      WorkspaceContentGraphBuilder.build(public_override),
      Err(WorkspaceContentGraphError::InvalidTargetInventory),
      "mapping overrides are exclusive to Undo's Move counter-operation"
    );
  }

  #[test]
  fn folder_selection_retains_content_and_omits_contained_broken_references() {
    let source_workspace = Uuid::new_v4();
    let target_workspace = Uuid::new_v4();
    let document = resource(
      source_workspace,
      WorkspaceContentResourceKind::Document,
      "doc",
      Some("Doc"),
      None,
      &["docs"],
    );
    let missing =
      WorkspaceContentResourceRef::new(source_workspace, WorkspaceContentResourceKind::Document, "missing").unwrap();
    let folder = resource(
      source_workspace,
      WorkspaceContentResourceKind::Folder,
      "folder",
      Some("Folder"),
      None,
      &["doc_updates"],
    );
    let organizer = OrganizerSnapshot {
      workspace_id: source_workspace,
      revision: "organizer-revision".to_string(),
      roots: vec![OrganizerSnapshotNode {
        row: OrganizerRow {
          id: "folder".to_string(),
          parent_id: None,
          data: "Folder".to_string(),
          row_type: "folder".to_string(),
          index: "a0".to_string(),
          target_workspace_id: None,
        },
        children: vec![
          OrganizerSnapshotNode {
            row: OrganizerRow {
              id: "link-1".to_string(),
              parent_id: Some("folder".to_string()),
              data: "doc".to_string(),
              row_type: "doc".to_string(),
              index: "a0".to_string(),
              target_workspace_id: None,
            },
            children: Vec::new(),
          },
          OrganizerSnapshotNode {
            row: OrganizerRow {
              id: "missing-link".to_string(),
              parent_id: Some("folder".to_string()),
              data: "missing".to_string(),
              row_type: "doc".to_string(),
              index: "a2".to_string(),
              target_workspace_id: None,
            },
            children: Vec::new(),
          },
          OrganizerSnapshotNode {
            row: OrganizerRow {
              id: "remote".to_string(),
              parent_id: Some("folder".to_string()),
              data: "remote-doc".to_string(),
              row_type: "doc".to_string(),
              index: "a1".to_string(),
              target_workspace_id: Some(target_workspace),
            },
            children: Vec::new(),
          },
        ],
      }],
    };
    let graph = WorkspaceContentGraphBuilder
      .build(WorkspaceContentGraphInput {
        operation_id: Uuid::nil(),
        kind: WorkspaceContentOperationKind::ExtractFolder,
        source_workspace_id: source_workspace,
        target_workspace_id: target_workspace,
        selection: WorkspaceContentSelection::FolderSubtree {
          organizer,
          folder_id: "folder".to_string(),
        },
        resources: vec![folder.clone(), document.clone()],
        references: vec![reference(
          "document_graph_occurrences",
          &document.resource,
          &missing,
          WorkspaceContentReferencePurpose::Reference,
          false,
        )],
        target_definitions: Vec::new(),
        target_resource_ids: Vec::new(),
        mapping_overrides: Vec::new(),
      })
      .unwrap();
    assert_eq!(graph.resources.len(), 2);
    assert!(graph.missing_resources.is_empty());
    assert_eq!(graph.broken_reference_count, 1);
    assert!(graph.blockers.is_empty());
    assert_eq!(graph.references[0].target, missing);
    assert_eq!(
      graph.references[0].placement,
      WorkspaceContentReferencePlacement::Broken
    );
    assert!(graph.roots.iter().all(|root| root.workspace_id() == source_workspace));
  }

  #[test]
  fn graph_fails_closed_for_unclassified_or_incomplete_dependencies() {
    let source_workspace = Uuid::new_v4();
    let target_workspace = Uuid::new_v4();
    let document = resource(
      source_workspace,
      WorkspaceContentResourceKind::Document,
      "doc",
      None,
      None,
      &["docs"],
    );
    let missing =
      WorkspaceContentResourceRef::new(source_workspace, WorkspaceContentResourceKind::Blob, "missing").unwrap();
    let base = WorkspaceContentGraphInput {
      operation_id: Uuid::nil(),
      kind: WorkspaceContentOperationKind::Copy,
      source_workspace_id: source_workspace,
      target_workspace_id: target_workspace,
      selection: WorkspaceContentSelection::Resources(vec![document.resource.clone()]),
      resources: vec![document.clone()],
      references: Vec::new(),
      target_definitions: Vec::new(),
      target_resource_ids: Vec::new(),
      mapping_overrides: Vec::new(),
    };
    let mut unknown = base.clone();
    unknown.references.push(reference(
      "future_relation",
      &document.resource,
      &missing,
      WorkspaceContentReferencePurpose::Reference,
      false,
    ));
    assert_eq!(
      WorkspaceContentGraphBuilder.build(unknown),
      Err(WorkspaceContentGraphError::UnclassifiedRelation(
        "future_relation".to_string()
      ))
    );

    let mut incomplete = base;
    incomplete.references.push(reference(
      "comment_attachments",
      &document.resource,
      &missing,
      WorkspaceContentReferencePurpose::OwnedDependency,
      true,
    ));
    assert_eq!(
      WorkspaceContentGraphBuilder.build(incomplete),
      Err(WorkspaceContentGraphError::IncompleteOwnedDependency)
    );

    let mut derived_as_owned = WorkspaceContentGraphInput {
      operation_id: Uuid::nil(),
      kind: WorkspaceContentOperationKind::Copy,
      source_workspace_id: source_workspace,
      target_workspace_id: target_workspace,
      selection: WorkspaceContentSelection::Resources(vec![document.resource.clone()]),
      resources: vec![document],
      references: Vec::new(),
      target_definitions: Vec::new(),
      target_resource_ids: Vec::new(),
      mapping_overrides: Vec::new(),
    };
    derived_as_owned.references.push(reference(
      "document_graph_occurrences",
      &derived_as_owned.resources[0].resource,
      &missing,
      WorkspaceContentReferencePurpose::OwnedDependency,
      true,
    ));
    assert_eq!(
      WorkspaceContentGraphBuilder.build(derived_as_owned),
      Err(WorkspaceContentGraphError::NonTransferableOwnedDependency(
        "document_graph_occurrences".to_string()
      ))
    );
  }
  #[test]
  fn workspace_tasks_container_rejects_move_extract_but_keeps_explicit_copy_policy() {
    let source = Uuid::new_v4();
    let target = Uuid::new_v4();
    let id = Uuid::new_v4().to_string();
    let mut database = resource(
      source,
      WorkspaceContentResourceKind::Database,
      &id,
      Some("Workspace Tasks"),
      Some("managed-schema"),
      &["workspace_databases", "workspace_database_rows"],
    );
    database.database_system_role = Some(myoxus_domain::database::DatabaseSystemRole::WorkspaceTasks);
    let direct = WorkspaceContentGraphInput {
      operation_id: Uuid::new_v4(),
      kind: WorkspaceContentOperationKind::Move,
      source_workspace_id: source,
      target_workspace_id: target,
      selection: WorkspaceContentSelection::Resources(vec![database.resource.clone()]),
      resources: vec![database.clone()],
      references: Vec::new(),
      target_definitions: Vec::new(),
      target_resource_ids: Vec::new(),
      mapping_overrides: Vec::new(),
    };
    assert!(
      matches!(
        WorkspaceContentGraphBuilder.build(direct.clone()),
        Err(WorkspaceContentGraphError::SelectedResourceUnsupported)
      ),
      "the protected aggregate never reaches a Move plan/stage"
    );
    let copied = WorkspaceContentGraphBuilder
      .build(WorkspaceContentGraphInput {
        kind: WorkspaceContentOperationKind::Copy,
        ..direct.clone()
      })
      .expect("explicitly selected whole-container Copy remains permitted");
    assert_eq!(copied.resources.len(), 1);
    assert_eq!(copied.mappings[0].mapping.source, database.resource);
    assert_ne!(
      copied.mappings[0].mapping.target.resource_id(),
      database.resource.resource_id()
    );
    let folder = resource(
      source,
      WorkspaceContentResourceKind::Folder,
      "folder",
      Some("Folder"),
      None,
      &["doc_updates"],
    );
    let organizer = OrganizerSnapshot {
      workspace_id: source,
      revision: "organizer-revision".into(),
      roots: vec![OrganizerSnapshotNode {
        row: OrganizerRow {
          id: "folder".into(),
          parent_id: None,
          data: "Folder".into(),
          row_type: "folder".into(),
          index: "a0".into(),
          target_workspace_id: None,
        },
        children: vec![OrganizerSnapshotNode {
          row: OrganizerRow {
            id: "tasks-link".into(),
            parent_id: Some("folder".into()),
            data: id,
            row_type: "database".into(),
            index: "a0".into(),
            target_workspace_id: None,
          },
          children: Vec::new(),
        }],
      }],
    };
    let extract = WorkspaceContentGraphInput {
      kind: WorkspaceContentOperationKind::ExtractFolder,
      selection: WorkspaceContentSelection::FolderSubtree {
        organizer,
        folder_id: "folder".into(),
      },
      resources: vec![folder, database.clone()],
      ..direct.clone()
    };
    assert!(
      matches!(
        WorkspaceContentGraphBuilder.build(extract.clone()),
        Err(WorkspaceContentGraphError::SelectedResourceUnsupported)
      ),
      "a protected contained Database never reaches Extract staging"
    );
    let mut ordinary = database.clone();
    ordinary.database_system_role = None;
    assert!(
      WorkspaceContentGraphBuilder
        .build(WorkspaceContentGraphInput {
          resources: vec![ordinary.clone()],
          ..direct
        })
        .is_ok(),
      "ordinary Database Move remains native"
    );
    let mut ordinary_extract = extract;
    ordinary_extract
      .resources
      .iter_mut()
      .find(|resource| resource.resource == database.resource)
      .expect("selected Database")
      .database_system_role = None;
    assert!(WorkspaceContentGraphBuilder.build(ordinary_extract).is_ok());
    let document = resource(
      source,
      WorkspaceContentResourceKind::Document,
      "note",
      Some("Note"),
      None,
      &["docs"],
    );
    let referenced = WorkspaceContentGraphBuilder
      .build(WorkspaceContentGraphInput {
        operation_id: Uuid::new_v4(),
        kind: WorkspaceContentOperationKind::Copy,
        source_workspace_id: source,
        target_workspace_id: target,
        selection: WorkspaceContentSelection::Resources(vec![document.resource.clone()]),
        resources: vec![document.clone(), database.clone()],
        references: vec![reference(
          "document_graph_occurrences",
          &document.resource,
          &database.resource,
          WorkspaceContentReferencePurpose::Reference,
          true,
        )],
        target_definitions: Vec::new(),
        target_resource_ids: Vec::new(),
        mapping_overrides: Vec::new(),
      })
      .expect("a normal external reference stays in the existing copy preview");
    assert_eq!(
      referenced.resources.len(),
      1,
      "a reference cannot silently acquire the entire Tasks container"
    );
    assert!(
      !referenced
        .mappings
        .iter()
        .any(|mapping| mapping.mapping.source == database.resource)
    );
  }
}
