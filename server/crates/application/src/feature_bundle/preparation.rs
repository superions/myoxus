// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only release selection. Capture and locked publication remain delivery
//! concerns; this owner never edits an installed catalog or native user data.
use super::validation::valid_pin;
use myoxus_domain::feature_bundle::*;
use std::collections::BTreeSet;

fn pins(catalog: &FeatureBundleCatalogSource) -> impl Iterator<Item = &FeatureBundlePin> {
  std::iter::once(&catalog.base)
    .chain(&catalog.optional)
    .chain(&catalog.retained)
}

fn validate(catalog: &FeatureBundleCatalogSource) -> Result<(), String> {
  if catalog.format_version != 1 || catalog.optional.len() > 128 || catalog.retained.len() > 256 {
    return Err("invalid or unbounded Feature preparation catalog".into());
  }
  let mut identities = BTreeSet::new();
  let mut providers = BTreeSet::from([catalog.base.id.as_str()]);
  for pin in pins(catalog) {
    if !valid_pin(pin) || !identities.insert((pin.id.as_str(), pin.version.as_str())) {
      return Err("duplicate or invalid Feature preparation pin".into());
    }
  }
  for pin in &catalog.optional {
    if !providers.insert(pin.id.as_str()) {
      return Err("duplicate active Feature provider".into());
    }
  }
  Ok(())
}

/// Select the current release and installed optional providers, without carrying
/// previous Feature archives into the runtime. Native dependencies belong to
/// each selected bundle's closed inventory.
pub fn prepare_feature_release_catalog(
  release: &FeatureReleaseDescriptor,
  source: &FeatureBundleCatalogSource,
  installed: Option<&FeatureBundleCatalogSource>,
  explicit: Option<&FeatureBundleCatalogSource>,
) -> Result<FeatureBundleCatalogSource, String> {
  validate(source)?;
  if !source.retained.is_empty() || explicit.is_some_and(|catalog| !catalog.retained.is_empty()) {
    return Err("release preparation selects current Feature providers, not archive history".into());
  }
  if release.format_version != 1 || source.base != release.base {
    return Err("candidate Feature base differs from independent release expectation".into());
  }
  if let Some(installed) = installed {
    validate(installed)?;
    if installed.base.id != release.base.id {
      return Err("the installed release base identity cannot change".into());
    }
  }
  if let Some(explicit) = explicit {
    validate(explicit)?;
    if explicit.base != release.base {
      return Err("explicit optional catalog differs from the required release base".into());
    }
    if let Some(installed) = installed {
      for provider in &installed.optional {
        if !explicit.optional.iter().any(|selected| selected.id == provider.id) {
          return Err(format!(
            "explicit catalog cannot uninstall optional provider {}",
            provider.id
          ));
        }
      }
    }
  }
  let optional = explicit
    .map(|catalog| &catalog.optional)
    .or_else(|| installed.map(|catalog| &catalog.optional))
    .unwrap_or(&source.optional)
    .clone();
  let candidate = FeatureBundleCatalogSource {
    format_version: 1,
    base: release.base.clone(),
    optional,
    retained: Vec::new(),
  };
  validate(&candidate)?;
  Ok(candidate)
}
