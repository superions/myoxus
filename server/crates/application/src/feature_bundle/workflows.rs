// SPDX-License-Identifier: AGPL-3.0-or-later
//! Workflow delivery binds an exact graph to existing assistant components.
//! Active selection grants fresh eligibility; captured history only supports receipts.
use super::{
  CapturedFeatureBundle,
  artwork_presentation::{package, target_component},
  validation::valid_key,
};
use crate::database::definition::templates::compare_template_versions;
use myoxus_domain::{assistant_package::*, feature_bundle::*};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
struct WorkflowInventory {
  nodes: BTreeSet<String>,
  waits: BTreeSet<String>,
  components: BTreeMap<String, AssistantWorkflowCapability>,
  capabilities: BTreeSet<AssistantWorkflowCapability>,
}

fn workflow_nodes(
  nodes: &[AssistantWorkflowNode],
  depth: usize,
  available: &mut BTreeSet<String>,
  inventory: &mut WorkflowInventory,
) -> Result<(), String> {
  if (nodes.is_empty() && depth == 0) || depth > 8 {
    return Err("empty or excessively nested native workflow".into());
  }
  for node in nodes {
    if !valid_key(&node.id) || !inventory.nodes.insert(node.id.clone()) || inventory.nodes.len() > 64 {
      return Err("duplicate, invalid or excessive native workflow nodes".into());
    }
    let capability = match &node.action {
      AssistantWorkflowAction::CreateDatabaseFromDefinition { component }
      | AssistantWorkflowAction::CreateWorkingDocument { component }
      | AssistantWorkflowAction::PlaceNativeLink { component }
      | AssistantWorkflowAction::CreateContextDocument { component }
      | AssistantWorkflowAction::CreateTaskFromDocument { component }
      | AssistantWorkflowAction::InspectTaskContent { component }
      | AssistantWorkflowAction::ApplyTaskCorrections { component }
      | AssistantWorkflowAction::CreateLinkedDocument { component } => {
        let capability = match &node.action {
          AssistantWorkflowAction::CreateDatabaseFromDefinition { .. } => {
            AssistantWorkflowCapability::CreateDatabaseFromDefinition
          }
          AssistantWorkflowAction::CreateWorkingDocument { .. } => AssistantWorkflowCapability::CreateWorkingDocument,
          AssistantWorkflowAction::PlaceNativeLink { .. } => AssistantWorkflowCapability::PlaceNativeLink,
          AssistantWorkflowAction::CreateContextDocument { .. } => AssistantWorkflowCapability::CreateContextDocument,
          AssistantWorkflowAction::InspectTaskContent { .. } => AssistantWorkflowCapability::InspectTaskContent,
          AssistantWorkflowAction::ApplyTaskCorrections { .. } => AssistantWorkflowCapability::ApplyTaskCorrections,
          AssistantWorkflowAction::CreateLinkedDocument { .. } => AssistantWorkflowCapability::CreateLinkedDocument,
          _ => AssistantWorkflowCapability::CreateTaskFromDocument,
        };
        if !valid_key(component) || inventory.components.insert(component.clone(), capability).is_some() {
          return Err("duplicate or invalid native workflow component".into());
        }
        if capability == AssistantWorkflowCapability::InspectTaskContent {
          available.insert(component.clone());
        }
        capability
      }
      AssistantWorkflowAction::AwaitCorrectionConfirmation { wait_id } => {
        if !valid_key(wait_id) || !inventory.waits.insert(wait_id.clone()) {
          return Err("invalid correction confirmation wait".into());
        }
        available.insert(node.id.clone());
        AssistantWorkflowCapability::AwaitCorrectionConfirmation
      }
      AssistantWorkflowAction::AwaitTaskSet {
        wait_id,
        tasks,
        deadline,
      } => {
        if !valid_key(wait_id)
          || !inventory.waits.insert(wait_id.clone())
          || !matches!(tasks,AssistantValueBinding::Input{input} if valid_key(input))
          || !matches!(deadline,AssistantValueBinding::Input{input} if valid_key(input))
        {
          return Err("invalid native Task-set wait bindings".into());
        }
        available.insert(node.id.clone());
        AssistantWorkflowCapability::AwaitTaskSet
      }
      AssistantWorkflowAction::AwaitSignal { wait_id, deadline } => {
        if !valid_key(wait_id)
          || !inventory.waits.insert(wait_id.clone())
          || !matches!(deadline, AssistantValueBinding::Input { input } if valid_key(input))
        {
          return Err("invalid native workflow wait or deadline binding".into());
        }
        available.insert(node.id.clone());
        AssistantWorkflowCapability::AwaitSignal
      }
      AssistantWorkflowAction::Branch { outcome, cases } => {
        if !matches!(outcome, AssistantValueBinding::Result { component, value: AssistantResultValue::Outcome } if available.contains(component))
          || cases.is_empty()
          || cases.values().all(Vec::is_empty)
          || cases.len() > 64
          || cases.keys().any(|outcome| !valid_key(outcome))
        {
          return Err("native workflow branch requires a preceding wait and bounded named outcomes".into());
        }
        // Branch-local results never authorize a sibling or later unconditional node.
        for branch in cases.values() {
          workflow_nodes(branch, depth + 1, &mut available.clone(), inventory)?;
        }
        AssistantWorkflowCapability::Branch
      }
    };
    inventory.capabilities.insert(capability);
  }
  Ok(())
}

pub fn validate_assistant_workflow_source(source: &AssistantWorkflowSource) -> Result<(), String> {
  if source.format_version != 1
    || !valid_key(&source.id)
    || compare_template_versions(&source.version, &source.version).is_err()
  {
    return Err("unsupported native workflow source".into());
  }
  let mut inventory = WorkflowInventory::default();
  workflow_nodes(&source.nodes, 0, &mut BTreeSet::new(), &mut inventory)?;
  if source.capability_versions
    != inventory
      .capabilities
      .into_iter()
      .map(|capability| (capability, 1))
      .collect()
  {
    return Err("native workflow capabilities differ from executable nodes".into());
  }
  Ok(())
}

fn task_bindings(
  inputs: &BTreeMap<AssistantInputTarget, AssistantValueBinding>,
  package: &AssistantPackageSource,
  available: &BTreeSet<String>,
) -> Result<(), String> {
  if [
    AssistantInputTarget::SourceDocument,
    AssistantInputTarget::Assignees,
    AssistantInputTarget::Title,
  ]
  .iter()
  .any(|target| !inputs.contains_key(target))
  {
    return Err("native review Task requires its source, assignee and title bindings".into());
  }
  for (target, binding) in inputs {
    let expected = match target {
      AssistantInputTarget::SourceDocument => AssistantValueType::Document,
      AssistantInputTarget::Assignees => AssistantValueType::Members,
      AssistantInputTarget::Destination => AssistantValueType::DatabaseDestination,
      AssistantInputTarget::Title | AssistantInputTarget::Description => AssistantValueType::Text,
      AssistantInputTarget::Due => AssistantValueType::DateTime,
      _ => return Err("unsupported native review Task input".into()),
    };
    let valid = match binding {
      AssistantValueBinding::Input { input } => package
        .inputs
        .iter()
        .any(|candidate| candidate.id == *input && candidate.value_type == expected),
      AssistantValueBinding::Context {
        value: AssistantContextValue::Requester,
      } => expected == AssistantValueType::Members,
      AssistantValueBinding::Result {
        component,
        value: AssistantResultValue::Reason,
      } => available.contains(component) && *target == AssistantInputTarget::Description,
      AssistantValueBinding::LocalizedText { value } => {
        *target == AssistantInputTarget::Title
          && [&value.en, &value.de, &value.fr, &value.es]
            .iter()
            .all(|text| !text.trim().is_empty() && text.len() <= 8192)
      }
      _ => false,
    };
    if !valid {
      return Err("dangling or mistyped native review Task binding".into());
    }
  }
  Ok(())
}

fn package_nodes(
  nodes: &[AssistantWorkflowNode],
  package: &AssistantPackageSource,
  available: &mut BTreeSet<String>,
) -> Result<(), String> {
  for node in nodes {
    match &node.action {
      AssistantWorkflowAction::CreateDatabaseFromDefinition { component }
      | AssistantWorkflowAction::CreateWorkingDocument { component }
      | AssistantWorkflowAction::PlaceNativeLink { component } => {
        let native = package
          .components
          .iter()
          .find(|child| child.id == *component)
          .ok_or("missing Workspace workflow component")?;
        match (&node.action, &native.action) {
          (
            AssistantWorkflowAction::CreateDatabaseFromDefinition { .. },
            AssistantNativeAction::CreateDatabaseFromDefinition { .. },
          )
          | (
            AssistantWorkflowAction::CreateWorkingDocument { .. },
            AssistantNativeAction::CreateWorkingDocument { .. },
          ) => {
            available.insert(component.clone());
          }
          (
            AssistantWorkflowAction::PlaceNativeLink { .. },
            AssistantNativeAction::PlaceNativeLink {
              target: AssistantValueBinding::Result { component: prior, .. },
              ..
            },
          ) if available.contains(prior) => {}
          _ => return Err("Workspace workflow requires a preceding matching native result".into()),
        }
      }
      AssistantWorkflowAction::InspectTaskContent { component } => {
        let Some(AssistantComponent {
          action: AssistantNativeAction::InspectTaskContent { tasks },
          ..
        }) = package.components.iter().find(|child| child.id == *component)
        else {
          return Err("workflow inspection component unavailable".into());
        };
        if !matches!(tasks,AssistantValueBinding::Input{input} if package.inputs.iter().any(|candidate|candidate.id==*input&&candidate.target==AssistantInputTarget::Tasks&&candidate.value_type==AssistantValueType::TaskReferences))
        {
          return Err("workflow inspection requires native Task input".into());
        }
        available.insert(component.clone());
      }
      AssistantWorkflowAction::ApplyTaskCorrections { component } => {
        let Some(AssistantComponent {
          action: AssistantNativeAction::ApplyTaskCorrections { proposal },
          ..
        }) = package.components.iter().find(|child| child.id == *component)
        else {
          return Err("workflow correction component unavailable".into());
        };
        if !matches!(proposal,AssistantValueBinding::Result{component,value:AssistantResultValue::CorrectionProposal} if available.contains(component))
        {
          return Err("workflow correction requires preceding inspection proposal".into());
        }
      }
      AssistantWorkflowAction::CreateLinkedDocument { component } => {
        if !package.components.iter().any(|child| {
          child.id == *component && matches!(child.action, AssistantNativeAction::CreateLinkedDocument { .. })
        }) {
          return Err("workflow linked document component unavailable".into());
        }
      }
      AssistantWorkflowAction::AwaitCorrectionConfirmation { .. } => {
        available.insert(node.id.clone());
      }

      AssistantWorkflowAction::CreateTaskFromDocument { component } => {
        let Some(AssistantComponent {
          action: AssistantNativeAction::CreateTaskFromDocument { inputs },
          ..
        }) = package.components.iter().find(|child| child.id == *component)
        else {
          return Err("workflow requires an exact native Task component".into());
        };
        task_bindings(inputs, package, available)?;
      }
      AssistantWorkflowAction::CreateContextDocument { component } => {
        if !package
          .components
          .iter()
          .any(|child| child.id == *component && matches!(child.action, AssistantNativeAction::CreateDocument { .. }))
        {
          return Err("workflow requires an exact native document component".into());
        }
      }
      AssistantWorkflowAction::AwaitTaskSet { tasks, deadline, .. } => {
        if !matches!(tasks,AssistantValueBinding::Input{input} if package.inputs.iter().any(|candidate|candidate.id==*input&&candidate.target==AssistantInputTarget::PrerequisiteTasks&&candidate.value_type==AssistantValueType::TaskReferences))
          || !matches!(deadline,AssistantValueBinding::Input{input} if package.inputs.iter().any(|candidate|candidate.id==*input&&candidate.target==AssistantInputTarget::Deadline&&candidate.value_type==AssistantValueType::DateTime))
        {
          return Err("Task-set wait requires native Tasks and Deadline inputs".into());
        }
        available.insert(node.id.clone());
      }
      AssistantWorkflowAction::AwaitSignal { deadline, .. } => {
        if !matches!(deadline, AssistantValueBinding::Input { input } if package.inputs.iter().any(|candidate| candidate.id == *input && candidate.target == AssistantInputTarget::Deadline && candidate.value_type == AssistantValueType::DateTime))
        {
          return Err("workflow deadline requires the declared native Deadline input".into());
        }
        available.insert(node.id.clone());
      }
      AssistantWorkflowAction::Branch { cases, .. } => {
        for branch in cases.values() {
          package_nodes(branch, package, &mut available.clone())?;
        }
      }
    }
  }
  Ok(())
}

pub(super) fn validate_package_workflow(
  source: &AssistantWorkflowSource,
  package: &AssistantPackageSource,
) -> Result<(), String> {
  validate_assistant_workflow_source(source)?;
  if !package
    .contexts
    .contains(&AssistantPackageContext::TaskContainerAssistance)
    && !(crate::workspace::assistant_packages::workspace_setup_source(package) && source.trigger.is_none())
  {
    return Err("workflow requires a native contextual or explicit Workspace setup package".into());
  }
  let mut inventory = WorkflowInventory::default();
  workflow_nodes(&source.nodes, 0, &mut BTreeSet::new(), &mut inventory)?;
  let declared = package
    .components
    .iter()
    .filter_map(|component| match component.action {
      AssistantNativeAction::CreateDatabaseFromDefinition { .. }
      | AssistantNativeAction::CreateWorkingDocument { .. }
      | AssistantNativeAction::PlaceNativeLink { .. }
      | AssistantNativeAction::CreateDocument { .. }
      | AssistantNativeAction::CreateTaskFromDocument { .. }
      | AssistantNativeAction::InspectTaskContent { .. }
      | AssistantNativeAction::ApplyTaskCorrections { .. }
      | AssistantNativeAction::CreateLinkedDocument { .. } => Some(component.id.clone()),
      _ => None,
    })
    .collect::<BTreeSet<_>>();
  if declared != inventory.components.keys().cloned().collect() {
    return Err("workflow nodes differ from native child components".into());
  }
  package_nodes(&source.nodes, package, &mut BTreeSet::new())?;
  Ok(())
}

pub(super) fn assistant_workflows(
  all: &[CapturedFeatureBundle],
  active: &[FeatureBundlePin],
) -> Result<BTreeMap<(String, String), AssistantResolvedWorkflow>, String> {
  let mut result: BTreeMap<(String, String), AssistantResolvedWorkflow> = BTreeMap::new();
  for owner in all
    .iter()
    .filter(|bundle| active.contains(&bundle.pin()))
    .chain(all.iter().filter(|bundle| !active.contains(&bundle.pin())))
  {
    let mut linked = BTreeSet::new();
    for link in &owner.manifest.links {
      let FeatureLink::Workflow { from, to } = link else {
        continue;
      };
      if from.key.is_some() {
        return Err("workflow link requires the whole native package".into());
      }
      let (package, identity, _) = package(owner, from)?;
      if !linked.insert((identity.id.clone(), identity.version.clone())) {
        return Err("multiple workflows for one native package".into());
      }
      let (provider, component) = target_component(owner, to, all)?;
      if component.kind != FeatureComponentKind::Workflow {
        return Err("workflow link requires a native workflow component".into());
      }
      let source = provider
        .workflows
        .get(&component.id)
        .ok_or("workflow component was not decoded")?;
      validate_package_workflow(source, package)?;
      let resolved = AssistantResolvedWorkflow {
        identity: AssistantWorkflowIdentity {
          id: source.id.clone(),
          version: source.version.clone(),
          digest: component.sha256.clone(),
        },
        binding_version: 1,
        source: source.clone(),
        source_bytes: provider
          .files
          .get(&component.path)
          .ok_or("missing workflow bytes")?
          .clone(),
        bundle: provider.pin(),
      };
      let key = (identity.id, identity.version);
      if let Some(known) = result.get(&key) {
        if known.identity != resolved.identity || known.source_bytes != resolved.source_bytes {
          return Err("immutable assistant workflow binding changed".into());
        }
      } else {
        result.insert(key, resolved);
      }
    }
  }
  Ok(result)
}
