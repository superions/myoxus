// SPDX-License-Identifier: AGPL-3.0-or-later
//! Presentation links bind verified bytes to native groups. Historical lookup
//! exposes evidence for the existing receipt owner, never permission itself.
use super::CapturedFeatureBundle;
use myoxus_domain::{assistant_package::*, feature_bundle::*};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn target_component<'a>(
  owner: &'a CapturedFeatureBundle,
  reference: &FeatureReference,
  all: &'a [CapturedFeatureBundle],
) -> Result<(&'a CapturedFeatureBundle, &'a FeatureComponent), String> {
  let (bundle, component) = match reference {
    FeatureReference::Local { reference } => (owner, reference.component.as_str()),
    FeatureReference::Platform { bundle, export } => {
      let selected = all
        .iter()
        .find(|candidate| candidate.pin() == *bundle)
        .ok_or("missing pinned native presentation provider")?;
      let export = selected
        .manifest
        .exports
        .iter()
        .find(|candidate| candidate.id == *export)
        .ok_or("missing pinned native presentation export")?;
      (selected, export.source.component.as_str())
    }
  };
  let component = bundle
    .manifest
    .components
    .iter()
    .find(|candidate| candidate.id == component)
    .ok_or("native linked component unavailable")?;
  Ok((bundle, component))
}

pub(super) fn package<'a>(
  bundle: &'a CapturedFeatureBundle,
  from: &FeatureNativeReference,
) -> Result<(&'a AssistantPackageSource, AssistantPackageIdentity, bool), String> {
  let sources = bundle
    .assistants
    .get(&from.component)
    .ok_or("native presentation link requires an assistant")?;
  let (source, digest) = sources
    .definitions
    .iter()
    .find(|(source, _)| format!("{}@{}", source.id, source.version) == from.export)
    .ok_or("native presentation link requires an exact assistant version")?;
  let current = sources
    .catalog
    .packages
    .iter()
    .any(|entry| entry.id == source.id && entry.current == source.version);
  Ok((
    source,
    AssistantPackageIdentity {
      id: source.id.clone(),
      version: source.version.clone(),
      digest: digest.clone(),
    },
    current,
  ))
}

pub(super) fn assistant_artwork_for_active(
  all: &[CapturedFeatureBundle],
  active: &[FeatureBundlePin],
) -> Result<BTreeMap<(String, String), Vec<AssistantArtworkSlot>>, String> {
  let mut result: BTreeMap<_, Vec<_>> = BTreeMap::new();
  let mut slots = BTreeSet::new();
  for bundle in all.iter().filter(|bundle| active.contains(&bundle.pin())) {
    for link in &bundle.manifest.links {
      let FeatureLink::Artwork { from, to } = link else {
        continue;
      };
      let (source, identity, current) = package(bundle, from)?;
      if !current {
        continue;
      }
      let key = from.key.as_deref().ok_or("Artwork requires a native group key")?;
      let parts: Vec<_> = key.split('/').collect();
      let ["group", step, group] = parts.as_slice() else {
        return Err("invalid Artwork group key".into());
      };
      if !source
        .presentation
        .steps
        .iter()
        .chain(source.presentation.guided_help.iter())
        .any(|candidate| candidate.id == *step && candidate.groups.iter().any(|candidate| candidate.id == *group))
      {
        return Err("Artwork references an unavailable native step/group".into());
      }
      if !slots.insert((
        identity.id.clone(),
        identity.version.clone(),
        (*step).to_string(),
        (*group).to_string(),
      )) {
        return Err("multiple Artwork assets for one native presentation slot".into());
      }
      let (provider, component) = target_component(bundle, to, all)?;
      if component.kind != FeatureComponentKind::Artwork {
        return Err("Artwork link requires an actual Artwork component".into());
      }
      let metadata = component.artwork.as_ref().ok_or("missing Artwork metadata")?;
      result
        .entry((identity.id, identity.version))
        .or_default()
        .push(AssistantArtworkSlot {
          role: metadata.role,
          step: (*step).into(),
          group: (*group).into(),
          bundle: provider.pin(),
          component: component.id.clone(),
          digest: component.sha256.clone(),
          media_type: metadata.media_type.clone(),
          width: metadata.width,
          height: metadata.height,
          alternative: metadata.alternative.clone(),
          caption: metadata.caption.clone(),
        });
    }
  }
  Ok(result)
}

pub struct FeatureArtworkResource<'a> {
  pub bytes: &'a [u8],
  pub metadata: &'a FeatureArtwork,
  pub digest: &'a str,
  pub active: bool,
  /// A caller must prove a persisted acceptance through the native receipt owner
  /// before serving a retained resource. A client-provided identity is no proof.
  pub accepted_packages: Vec<AssistantPackageIdentity>,
}

pub fn resolve_feature_artwork<'a>(
  all: &'a [CapturedFeatureBundle],
  active: &[FeatureBundlePin],
  pin: &FeatureBundlePin,
  component_id: &str,
) -> Result<FeatureArtworkResource<'a>, String> {
  let bundle = all
    .iter()
    .find(|bundle| bundle.pin() == *pin)
    .ok_or("unknown Artwork pin")?;
  let component = bundle
    .manifest
    .components
    .iter()
    .find(|component| component.kind == FeatureComponentKind::Artwork && component.id == component_id)
    .ok_or("unknown Artwork component")?;
  let mut packages = Vec::new();
  let mut is_active = false;
  for owner in all {
    for link in &owner.manifest.links {
      let FeatureLink::Artwork { from, to } = link else {
        continue;
      };
      let (provider, target) = target_component(owner, to, all)?;
      if provider.pin() != *pin || target.id != component_id {
        continue;
      }
      let (_, identity, current) = package(owner, from)?;
      is_active |= current && active.contains(&owner.pin());
      if !packages.contains(&identity) {
        packages.push(identity);
      }
    }
  }
  Ok(FeatureArtworkResource {
    bytes: bundle.files.get(&component.path).ok_or("missing Artwork bytes")?,
    metadata: component.artwork.as_ref().ok_or("missing Artwork metadata")?,
    digest: &component.sha256,
    active: is_active,
    accepted_packages: packages,
  })
}
