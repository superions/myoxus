// SPDX-License-Identifier: AGPL-3.0-or-later
//! Delivery resolves document identities; native Registry capture owns eligibility.
use super::{
  CapturedFeatureBundle,
  artwork_presentation::{package, target_component},
};
use myoxus_domain::{assistant_package::*, feature_bundle::*};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

pub(super) fn assistant_document_components_for_active(
  all: &[CapturedFeatureBundle],
  active: &[FeatureBundlePin],
) -> Result<BTreeMap<(String, String), Vec<(AssistantDocumentComponentSource, Arc<[u8]>)>>, String> {
  let mut result: BTreeMap<(String, String), Vec<(AssistantDocumentComponentSource, Arc<[u8]>)>> = BTreeMap::new();
  let mut archives: BTreeMap<String, Arc<[u8]>> = BTreeMap::new();
  for owner in all
    .iter()
    .filter(|owner| active.contains(&owner.pin()))
    .chain(all.iter().filter(|owner| !active.contains(&owner.pin())))
  {
    let mut linked = BTreeSet::new();
    for link in &owner.manifest.links {
      let FeatureLink::DocumentComponent { from, to } = link else {
        continue;
      };
      let (source, identity, _current) = package(owner, from)?;
      let key = from
        .key
        .as_deref()
        .and_then(|key| key.strip_prefix("component/"))
        .filter(|key| !key.contains('/'))
        .ok_or("document link requires a native component key")?;
      if !source.contexts.iter().any(|context| {
        matches!(
          context,
          AssistantPackageContext::ProjectCreation
            | AssistantPackageContext::WorkspaceCreation
            | AssistantPackageContext::TaskContainerAssistance
        )
      }) || !source.components.iter().any(|component| {
        component.id == key
          && matches!(
            component.action,
            AssistantNativeAction::CreateDocument { .. }
              | AssistantNativeAction::CreateWorkingDocument { .. }
              | AssistantNativeAction::CreateLinkedDocument { .. }
          )
      }) {
        return Err("document link requires an actual native document-producing component".into());
      }
      if !linked.insert((identity.id.clone(), identity.version.clone(), key.to_string())) {
        return Err("multiple sources for one native document component".into());
      }
      let (provider, document) = target_component(owner, to, all)?;
      if document.kind != FeatureComponentKind::DocumentTemplate {
        return Err("document component requires an exact native Document source".into());
      }
      let native = document
        .native_identity
        .as_ref()
        .ok_or("native document identity unavailable")?;
      let bytes = provider
        .files
        .get(&document.path)
        .ok_or("native Document archive unavailable")?;
      let bytes = archives
        .entry(document.sha256.clone())
        .or_insert_with(|| Arc::from(bytes.clone()))
        .clone();
      let entries = result.entry((identity.id, identity.version)).or_default();
      if !entries
        .iter()
        .any(|(source, _)| source.component_id == key && source.digest == document.sha256)
      {
        entries.push((
          AssistantDocumentComponentSource {
            component_id: key.into(),
            template_id: native.id.clone(),
            version: native.version.clone(),
            digest: document.sha256.clone(),
            bundle: provider.pin(),
          },
          bytes,
        ));
      }
    }
    // Retained children also require their genuine source link; they do not
    // become offered merely because delivery preserves the immutable archive.
    for sources in owner.assistants.values() {
      for (source, _) in &sources.definitions {
        for component in &source.components {
          if matches!(
            component.action,
            AssistantNativeAction::CreateDocument { .. }
              | AssistantNativeAction::CreateWorkingDocument { .. }
              | AssistantNativeAction::CreateLinkedDocument { .. }
          ) && !linked.contains(&(source.id.clone(), source.version.clone(), component.id.clone()))
          {
            return Err("native document component has no exact delivery source".into());
          }
        }
      }
    }
  }
  Ok(result)
}
