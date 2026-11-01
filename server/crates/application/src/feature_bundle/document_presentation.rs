// SPDX-License-Identifier: AGPL-3.0-or-later
//! Manual Library associations share the admitted immutable presentation catalog.
//! They neither select an assignment nor instantiate document content.
use super::{
  CapturedFeatureBundle,
  artwork_presentation::{package, target_component},
};
use myoxus_domain::{assistant_package::*, feature_bundle::*};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn assistant_document_sources_for_active(
  all: &[CapturedFeatureBundle],
  active: &[FeatureBundlePin],
) -> Result<BTreeMap<(String, String), Vec<AssistantDocumentSourceSlot>>, String> {
  let mut result: BTreeMap<_, Vec<_>> = BTreeMap::new();
  let mut slots = BTreeSet::new();
  for bundle in all.iter().filter(|bundle| active.contains(&bundle.pin())) {
    for link in &bundle.manifest.links {
      let FeatureLink::DocumentSource { from, to } = link else {
        continue;
      };
      let (source, identity, current) = package(bundle, from)?;
      if !current {
        continue;
      }
      if !source.contexts.iter().any(|context| {
        matches!(
          context,
          AssistantPackageContext::ProjectCreation | AssistantPackageContext::WorkspaceCreation
        )
      }) {
        return Err("manual Library association requires ProjectCreation".into());
      }
      let key = from
        .key
        .as_deref()
        .ok_or("manual Library source requires a presentation group")?;
      let parts: Vec<_> = key.split('/').collect();
      let ["group", step, group] = parts.as_slice() else {
        return Err("invalid manual Library group key".into());
      };
      if !source
        .presentation
        .steps
        .iter()
        .chain(source.presentation.guided_help.iter())
        .any(|candidate| candidate.id == *step && candidate.groups.iter().any(|candidate| candidate.id == *group))
      {
        return Err("manual Library presentation group unavailable".into());
      }
      if !slots.insert((
        identity.id.clone(),
        identity.version.clone(),
        (*step).to_string(),
        (*group).to_string(),
      )) {
        return Err("multiple manual Library sources for one presentation group".into());
      }
      let (_, component) = target_component(bundle, to, all)?;
      if component.kind != FeatureComponentKind::DocumentTemplate {
        return Err("manual Library source requires a native Document component".into());
      }
      let document = component
        .native_identity
        .as_ref()
        .ok_or("native document identity missing")?;
      result
        .entry((identity.id, identity.version))
        .or_default()
        .push(AssistantDocumentSourceSlot {
          step: (*step).into(),
          group: (*group).into(),
          template_id: document.id.clone(),
          version: document.version.clone(),
          digest: component.sha256.clone(),
        });
    }
  }
  Ok(result)
}
