// SPDX-License-Identifier: AGPL-3.0-or-later
//! Candidate promotion validates current providers and native dependencies.
//! Validation is read-only; publication and its lock remain the delivery owner.
use super::{
  CapturedFeatureBundle,
  catalog::{
    ResolvedFeatureCatalogs, assemble_feature_catalogs, native_identities, selected_captures,
    validate_historical_ownership,
  },
};
use crate::database::definition::templates::compare_template_versions;
use myoxus_domain::{database::DatabaseProfileKind, feature_bundle::*};
use std::cmp::Ordering;

pub fn validate_feature_release_candidate(
  candidate_release: &FeatureReleaseDescriptor,
  candidate_catalog: &FeatureBundleCatalogSource,
  candidate_captured: &[CapturedFeatureBundle],
  installed: Option<(
    &FeatureReleaseDescriptor,
    &FeatureBundleCatalogSource,
    &[CapturedFeatureBundle],
  )>,
) -> Result<ResolvedFeatureCatalogs, String> {
  let candidate = assemble_feature_catalogs(candidate_release, candidate_catalog, candidate_captured)?;
  let Some((installed_release, installed_catalog, installed_captured)) = installed else {
    return Ok(candidate);
  };
  // Retained archives contribute immutable ownership/history, not an executable
  // old selection. Newly declared edges may exist only in the candidate base.
  let old_selected = selected_captures(installed_release, installed_catalog, installed_captured)?;
  if candidate_release.base.id != installed_release.base.id {
    return Err("the installed release base identity cannot change".into());
  }
  admit_forward_pin(&installed_release.base, &candidate_release.base)?;
  validate_historical_ownership(&old_selected)?;
  let mut previous_owners = std::collections::BTreeMap::new();
  for (old, _) in old_selected
    .iter()
    .filter(|(_, active)| *active)
    .chain(old_selected.iter().filter(|(_, active)| !*active))
  {
    for identity in native_identities(old) {
      previous_owners.entry(identity).or_insert(&old.manifest.id);
    }
  }
  for (identity, owner) in previous_owners {
    if candidate.providers.get(&identity).is_some_and(|new| new != owner) {
      return Err(format!("native provider ownership cannot transfer: {}", identity.1));
    }
  }
  let new_selected = selected_captures(candidate_release, candidate_catalog, candidate_captured)?;
  for (old, was_active) in old_selected {
    if !was_active {
      continue;
    }
    let current = new_selected
      .iter()
      .find(|(new, active)| *active && new.manifest.id == old.manifest.id)
      .map(|(new, _)| *new);
    if let Some(new) = current {
      admit_forward_pin(&old.pin(), &new.pin())?;
      let targets = native_current_sources(new)?;
      for (identity, version) in native_current_sources(old)? {
        if let Some(current) = targets.get(&identity) {
          if compare_template_versions(current, &version)? == Ordering::Less {
            return Err(format!("native current source cannot downgrade: {}", identity.1));
          }
        }
      }
    }
    for sources in old.databases.values() {
      for entry in &sources.catalog.templates {
        let managed = sources.definitions.iter().any(|definition| {
          definition.id == entry.id
            && definition
              .variants
              .iter()
              .any(|variant| variant.spec.profile_kind == DatabaseProfileKind::Project)
        });
        if !managed {
          continue;
        }
        let new = current.ok_or_else(|| {
          format!(
            "managed provider must retain an explicit active target: {}",
            old.manifest.id
          )
        })?;
        let target = new
          .databases
          .values()
          .flat_map(|sources| &sources.catalog.templates)
          .find(|target| target.id == entry.id)
          .ok_or_else(|| {
            format!(
              "provider {} dropped managed current target {}",
              old.manifest.id, entry.id
            )
          })?;
        if compare_template_versions(&target.current, &entry.current)? == Ordering::Less {
          return Err(format!("managed native target cannot downgrade: {}", entry.id));
        }
        // Its current provider must explicitly retain update/history paths. An
        // old archive alone is not a declaration by the new current provider.
        for reference in &entry.definitions {
          if !target.definitions.iter().any(|new| {
            new.version == reference.version
              && new.sha256 == reference.sha256
              && serde_json::to_value(&new.selections).expect("native mappings serialize")
                == serde_json::to_value(&reference.selections).expect("native mappings serialize")
          }) {
            return Err(format!(
              "current provider dropped native history: {}@{}",
              entry.id, reference.version
            ));
          }
        }
        for reference in &entry.updates {
          if !target.updates.contains(reference) {
            return Err(format!(
              "current provider dropped native update history: {}@{}->{}",
              entry.id, reference.from, reference.to
            ));
          }
        }
        let old_source = entry
          .definitions
          .iter()
          .find(|reference| reference.version == entry.current)
          .map(|reference| (reference.version.as_str(), reference.sha256.as_str()))
          .ok_or("installed native current target unavailable")?;
        let new_source = candidate
          .databases
          .current_source(&entry.id)
          .ok_or("candidate native current target unavailable")?;
        if old_source.0 == new_source.0 && old_source.1 != new_source.1 {
          return Err(format!("immutable native current source changed: {}", entry.id));
        }
      }
    }
  }
  Ok(candidate)
}

fn admit_forward_pin(old: &FeatureBundlePin, new: &FeatureBundlePin) -> Result<(), String> {
  match compare_template_versions(&new.version, &old.version)? {
    Ordering::Less => Err(format!("Feature provider cannot downgrade: {}", old.id)),
    Ordering::Equal if old.sha256 != new.sha256 => {
      Err(format!("immutable Feature archive changed: {} {}", old.id, old.version))
    }
    _ => Ok(()),
  }
}

fn native_current_sources(
  bundle: &CapturedFeatureBundle,
) -> Result<std::collections::BTreeMap<(FeatureComponentKind, String), String>, String> {
  let mut current = std::collections::BTreeMap::new();
  for sources in bundle.databases.values() {
    for entry in &sources.catalog.templates {
      current.insert(
        (FeatureComponentKind::DatabaseCatalog, entry.id.clone()),
        entry.current.clone(),
      );
    }
  }
  for sources in bundle.assistants.values() {
    for entry in &sources.catalog.packages {
      current.insert(
        (FeatureComponentKind::AssistantCatalog, entry.id.clone()),
        entry.current.clone(),
      );
    }
  }
  for export in &bundle.manifest.exports {
    let component = bundle
      .manifest
      .components
      .iter()
      .find(|component| component.id == export.source.component)
      .ok_or("native export component unavailable")?;
    if matches!(
      component.kind,
      FeatureComponentKind::DocumentTemplate | FeatureComponentKind::Workflow
    ) {
      let identity = component
        .native_identity
        .as_ref()
        .ok_or("native document identity unavailable")?;
      current.insert((component.kind, identity.id.clone()), identity.version.clone());
    }
  }
  Ok(current)
}
