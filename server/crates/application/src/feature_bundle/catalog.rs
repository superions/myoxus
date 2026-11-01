// SPDX-License-Identifier: AGPL-3.0-or-later
//! Explicit release/provider selection produces the existing native catalogs.
//! Historical captures supply immutable facts, never active defaults or offers.
use super::validation::valid_pin;
use super::{CapturedFeatureBundle, resolve_feature_task_core, validate_feature_manifest, validate_feature_references};
use crate::database::definition::templates::{
  DatabaseStarterTemplateCatalog, DatabaseTemplateCatalogSelection, DatabaseTemplateCurrentTarget,
  DatabaseTemplateInventory, DatabaseTemplateOffering,
};
use crate::workspace::WorkspaceInitialContent;
use crate::workspace::assistant_packages::{AssistantPackageCatalog, AssistantPackageInventory};
use myoxus_domain::{assistant_package::*, database::*, feature_bundle::*};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub struct ResolvedFeatureCatalogs {
  pub databases: DatabaseStarterTemplateCatalog,
  pub assistants: AssistantPackageCatalog,
  /// Required base first, then explicitly ordered optional providers.
  pub active: Vec<FeatureBundlePin>,
  pub retained: Vec<FeatureBundlePin>,
  pub(super) providers: BTreeMap<(FeatureComponentKind, String), String>,
}

pub(super) fn selected_captures<'a>(
  release: &FeatureReleaseDescriptor,
  catalog: &FeatureBundleCatalogSource,
  captured: &'a [CapturedFeatureBundle],
) -> Result<Vec<(&'a CapturedFeatureBundle, bool)>, String> {
  if release.format_version != 1
    || catalog.format_version != 1
    || !valid_pin(&release.base)
    || release.base != catalog.base
    || catalog.optional.len() > 128
    || catalog.retained.len() > 256
    || captured.len() > 385
  {
    return Err("Feature release requires its exact bounded mandatory base pin".into());
  }
  let mut active_ids = BTreeSet::from([release.base.id.as_str()]);
  for pin in &catalog.optional {
    if !valid_pin(pin) || !active_ids.insert(pin.id.as_str()) {
      return Err("duplicate active base/provider or invalid optional pin".into());
    }
  }
  let mut pins = BTreeSet::new();
  let mut selected = Vec::new();
  let mut total_bytes = 0usize;
  for (pin, active) in std::iter::once((&catalog.base, true))
    .chain(catalog.optional.iter().map(|pin| (pin, true)))
    .chain(catalog.retained.iter().map(|pin| (pin, false)))
  {
    if !valid_pin(pin) || !pins.insert((pin.id.clone(), pin.version.clone())) {
      return Err("duplicate Feature identity or invalid retained pin".into());
    }
    let mut matches = captured.iter().filter(|source| source.pin() == *pin);
    let source = matches
      .next()
      .ok_or_else(|| format!("missing Feature archive {} {}", pin.id, pin.version))?;
    if matches.next().is_some() {
      return Err("duplicate captured Feature archive".into());
    }
    if source.archive_bytes.is_empty() || format!("{:x}", Sha256::digest(&source.archive_bytes)) != pin.sha256 {
      return Err(format!("Feature archive SHA-256 mismatch: {} {}", pin.id, pin.version));
    }
    total_bytes = total_bytes
      .checked_add(source.archive_bytes.len())
      .ok_or("Feature release byte size overflow")?;
    if total_bytes > 200 * 1024 * 1024 {
      return Err("Feature release aggregate byte limit exceeded".into());
    }
    validate_feature_manifest(&source.manifest, &source.files)?;
    selected.push((source, active));
  }
  for pin in &catalog.retained {
    if let Some(active) = std::iter::once(&catalog.base)
      .chain(&catalog.optional)
      .find(|active| active.id == pin.id)
    {
      if crate::database::definition::templates::compare_template_versions(&active.version, &pin.version)?
        == std::cmp::Ordering::Less
      {
        return Err(format!(
          "active Feature provider cannot downgrade retained history: {}",
          pin.id
        ));
      }
    }
  }
  if selected.len() != captured.len() {
    return Err("unselected or conflicting captured Feature archive".into());
  }
  Ok(selected)
}

type NativeKey = (FeatureComponentKind, String, String);
/// The canonical provider is identified independently of its currently active
/// archive version. Equal history does not transfer ownership to another bundle.
#[derive(Default)]
struct NativeOwners {
  identities: BTreeMap<(FeatureComponentKind, String), String>,
  pins: BTreeMap<NativeKey, String>,
}
impl NativeOwners {
  fn admit(
    &mut self,
    kind: FeatureComponentKind,
    id: &str,
    version: &str,
    digest: &str,
    provider: &str,
    active_claim: bool,
  ) -> Result<bool, String> {
    let owner_key = (kind, id.to_string());
    let key = (kind, id.to_string(), version.to_string());
    if let Some(owner) = self.identities.get(&owner_key) {
      if owner != provider {
        if active_claim || self.pins.get(&key).is_none_or(|known| known != digest) {
          return Err(format!("native source {id}@{version} conflicts with provider {owner}"));
        }
        return Ok(false);
      }
    } else {
      self.identities.insert(owner_key, provider.to_string());
    }
    if let Some(known) = self.pins.get(&key) {
      if known != digest {
        return Err(format!("immutable native source changed: {id}@{version}"));
      }
      return Ok(false);
    }
    self.pins.insert(key, digest.to_string());
    Ok(true)
  }
}

pub(super) fn native_identities(bundle: &CapturedFeatureBundle) -> BTreeSet<(FeatureComponentKind, String)> {
  bundle
    .databases
    .values()
    .flat_map(|sources| {
      sources
        .definitions
        .iter()
        .map(|source| (FeatureComponentKind::DatabaseCatalog, source.id.clone()))
    })
    .chain(bundle.assistants.values().flat_map(|sources| {
      sources
        .definitions
        .iter()
        .map(|(source, _)| (FeatureComponentKind::AssistantCatalog, source.id.clone()))
    }))
    .chain(bundle.manifest.components.iter().filter_map(|component| {
      component
        .native_identity
        .as_ref()
        .map(|identity| (component.kind, identity.id.clone()))
    }))
    .collect()
}
pub(super) fn validate_historical_ownership(selected: &[(&CapturedFeatureBundle, bool)]) -> Result<(), String> {
  let mut historical: BTreeMap<_, BTreeSet<String>> = BTreeMap::new();
  let mut active = BTreeMap::new();
  for (bundle, is_active) in selected {
    for identity in native_identities(bundle) {
      if *is_active {
        if active
          .insert(identity.clone(), &bundle.manifest.id)
          .is_some_and(|owner| owner != &bundle.manifest.id)
        {
          return Err(format!("duplicate active native provider: {}", identity.1));
        }
      } else {
        historical
          .entry(identity)
          .or_default()
          .insert(bundle.manifest.id.clone());
      }
    }
  }
  for (identity, owners) in historical {
    match active.get(&identity) {
      Some(provider) if !owners.contains(*provider) => {
        return Err(format!(
          "active provider cannot adopt foreign native history: {}",
          identity.1
        ));
      }
      None if owners.len() > 1 => return Err(format!("ambiguous historical native provider: {}", identity.1)),
      _ => {}
    }
  }
  Ok(())
}

fn database_pairs(
  bundle: &CapturedFeatureBundle,
) -> Result<Vec<(DatabaseTemplateDefinitionSource, DatabaseTemplateFileReference)>, String> {
  let declared = bundle
    .manifest
    .components
    .iter()
    .filter(|component| component.kind == FeatureComponentKind::DatabaseCatalog)
    .map(|component| component.id.as_str())
    .collect::<BTreeSet<_>>();
  if declared.len() != bundle.databases.len()
    || bundle
      .databases
      .keys()
      .any(|component| !declared.contains(component.as_str()))
  {
    return Err("decoded Database components differ from declared native components".into());
  }
  let mut pairs = Vec::new();
  for (component, sources) in &bundle.databases {
    if sources.catalog.format_version != 1 {
      return Err(format!("{component}: invalid native Database catalog format"));
    }
    let mut definitions = BTreeMap::new();
    for definition in &sources.definitions {
      if definitions
        .insert((definition.id.clone(), definition.version.clone()), definition)
        .is_some()
      {
        return Err(format!("{component}: duplicate native Database source"));
      }
    }
    let mut ids = BTreeSet::new();
    for entry in &sources.catalog.templates {
      if !ids.insert(&entry.id)
        || entry.offering.is_none()
        || entry.default_variant.is_none()
        || !entry
          .definitions
          .iter()
          .any(|reference| reference.version == entry.current)
      {
        return Err(format!("{component}: invalid native current/offering metadata"));
      }
      if !entry
        .definitions
        .iter()
        .find(|reference| reference.version == entry.current)
        .is_some_and(|reference| {
          reference
            .selections
            .iter()
            .any(|selection| Some(selection.input) == entry.default_variant)
        })
      {
        return Err(format!(
          "{component}: native declared default parameters are unavailable"
        ));
      }
      for reference in &entry.definitions {
        let definition = definitions
          .remove(&(entry.id.clone(), reference.version.clone()))
          .ok_or_else(|| {
            format!(
              "{component}: missing or duplicate native source {}@{}",
              entry.id, reference.version
            )
          })?;
        pairs.push((definition.clone(), reference.clone()));
      }
    }
    if !definitions.is_empty() {
      return Err(format!("{component}: unreferenced native Database source"));
    }
  }
  Ok(pairs)
}

/// Match the captured closure exactly; a decoded edge cannot bypass its native
/// catalog declaration, and a declared pin cannot silently disappear in union.
fn database_update_pairs(
  bundle: &CapturedFeatureBundle,
) -> Result<Vec<(DatabaseTemplateUpdateSource, DatabaseTemplateUpdateReference)>, String> {
  let mut pairs = Vec::new();
  for (component, sources) in &bundle.databases {
    let mut captured = BTreeMap::new();
    for (source, reference) in &sources.updates {
      let key = (source.template_id.clone(), reference.from.clone(), reference.to.clone());
      if captured.insert(key, (source, reference)).is_some() {
        return Err(format!("{component}: duplicate captured native Database update"));
      }
    }
    for entry in &sources.catalog.templates {
      for reference in &entry.updates {
        let key = (entry.id.clone(), reference.from.clone(), reference.to.clone());
        let (source, pin) = captured
          .remove(&key)
          .ok_or_else(|| format!("{component}: missing or duplicate native Database update"))?;
        if pin != reference {
          return Err(format!("{component}: native Database update pin mismatch"));
        }
        pairs.push((source.clone(), pin.clone()));
      }
    }
    if !captured.is_empty() {
      return Err(format!("{component}: unreferenced native Database update"));
    }
  }
  Ok(pairs)
}

fn merge_database_updates(
  all: impl IntoIterator<Item = (DatabaseTemplateUpdateSource, DatabaseTemplateUpdateReference)>,
) -> Result<Vec<(DatabaseTemplateUpdateSource, DatabaseTemplateUpdateReference)>, String> {
  let mut unique = BTreeMap::new();
  for (source, reference) in all {
    let key = (source.template_id.clone(), source.source.version.clone());
    if let Some(known) = unique.get(&key) {
      if known != &(source, reference) {
        return Err(format!(
          "conflicting immutable native Database update: {}@{}",
          key.0, key.1
        ));
      }
    } else {
      unique.insert(key, (source, reference));
    }
  }
  Ok(unique.into_values().collect())
}

fn assistant_definitions(bundle: &CapturedFeatureBundle) -> Result<Vec<(AssistantPackageSource, String)>, String> {
  let declared = bundle
    .manifest
    .components
    .iter()
    .filter(|component| component.kind == FeatureComponentKind::AssistantCatalog)
    .map(|component| component.id.as_str())
    .collect::<BTreeSet<_>>();
  if declared.len() != bundle.assistants.len()
    || bundle
      .assistants
      .keys()
      .any(|component| !declared.contains(component.as_str()))
  {
    return Err("decoded assistant components differ from declared native components".into());
  }
  let mut definitions = Vec::new();
  for (component, sources) in &bundle.assistants {
    if sources.catalog.format_version != 1 {
      return Err(format!("{component}: invalid native assistant catalog format"));
    }
    let mut remaining = BTreeMap::new();
    for (source, digest) in &sources.definitions {
      if remaining
        .insert((source.id.clone(), source.version.clone()), (source, digest))
        .is_some()
      {
        return Err(format!("{component}: duplicate native assistant source"));
      }
    }
    let mut ids = BTreeSet::new();
    for entry in &sources.catalog.packages {
      if !ids.insert(&entry.id)
        || !entry
          .definitions
          .iter()
          .any(|reference| reference.version == entry.current)
      {
        return Err(format!("{component}: invalid native assistant current metadata"));
      }
      for reference in &entry.definitions {
        let (source, digest) = remaining
          .remove(&(entry.id.clone(), reference.version.clone()))
          .ok_or_else(|| {
            format!(
              "{component}: missing or duplicate assistant {}@{}",
              entry.id, reference.version
            )
          })?;
        if digest != &reference.sha256 {
          return Err(format!("{component}: native assistant pin mismatch"));
        }
        definitions.push((source.clone(), digest.clone()));
      }
    }
    if !remaining.is_empty() {
      return Err(format!("{component}: unreferenced native assistant source"));
    }
  }
  Ok(definitions)
}

fn database_selection(bundles: &[&CapturedFeatureBundle]) -> Result<DatabaseTemplateCatalogSelection, String> {
  let mut selection = DatabaseTemplateCatalogSelection {
    current_targets: vec![],
    offerings: vec![],
    system_sources: vec![],
  };
  let mut ids = BTreeSet::new();
  for bundle in bundles {
    for component in bundle
      .manifest
      .components
      .iter()
      .filter(|component| component.kind == FeatureComponentKind::DatabaseCatalog)
    {
      let sources = bundle
        .databases
        .get(&component.id)
        .ok_or("declared native Database component unavailable")?;
      selection.system_sources.extend(sources.catalog.system_sources.clone());
      for entry in &sources.catalog.templates {
        if !ids.insert(&entry.id) {
          return Err(format!("duplicate active native Database provider: {}", entry.id));
        }
        selection.current_targets.push(DatabaseTemplateCurrentTarget {
          template_id: entry.id.clone(),
          version: entry.current.clone(),
        });
        if entry.offering == Some(true) {
          selection.offerings.push(DatabaseTemplateOffering {
            template_id: entry.id.clone(),
            default_variant: entry.default_variant.ok_or("native offering default missing")?,
          });
        }
      }
    }
  }
  Ok(selection)
}

/// Admit native fragments against explicitly supplied platform facts. Pure
/// Database/document/artwork fragments need no fabricated platform defaults.
pub fn validate_feature_native_sources(
  bundle: &CapturedFeatureBundle,
  platform: &[CapturedFeatureBundle],
) -> Result<(), String> {
  validate_feature_manifest(&bundle.manifest, &bundle.files)?;
  let declared = bundle
    .manifest
    .components
    .iter()
    .filter(|component| component.kind == FeatureComponentKind::Workflow)
    .collect::<Vec<_>>();
  if declared.len() != bundle.workflows.len() {
    return Err("decoded workflow components differ from declared components".into());
  }
  for component in declared {
    let workflow = bundle.workflows.get(&component.id).ok_or("missing decoded workflow")?;
    super::workflows::validate_assistant_workflow_source(workflow)?;
    if component
      .native_identity
      .as_ref()
      .is_none_or(|identity| identity.id != workflow.id || identity.version != workflow.version)
    {
      return Err("workflow native identity changed".into());
    }
  }
  validate_feature_references(bundle, platform)?;
  validate_active_exports(bundle)?;
  validate_active_document_exports(&[bundle])?;
  let pairs = database_pairs(bundle)?;
  let updates = database_update_pairs(bundle)?;
  DatabaseTemplateInventory::from_sources(pairs.clone(), updates.clone())?;
  let assistants = assistant_definitions(bundle)?;
  if assistants.is_empty() {
    return Ok(());
  }
  let mut all_pairs = pairs;
  let mut all_updates = updates;
  let mut bundles = vec![bundle];
  for source in platform {
    all_pairs.extend(database_pairs(source)?);
    all_updates.extend(database_update_pairs(source)?);
    bundles.push(source);
  }
  // Exact platform history may already occur in a current native catalog.
  let mut unique = BTreeMap::new();
  for (definition, reference) in all_pairs {
    let key = (definition.id.clone(), definition.version.clone());
    if let Some((_, known)) = unique.get(&key) {
      let known: &DatabaseTemplateFileReference = known;
      if known.sha256 != reference.sha256 {
        return Err("conflicting platform native Database pin".into());
      }
    } else {
      unique.insert(key, (definition, reference));
    }
  }
  let catalog = DatabaseStarterTemplateCatalog::from_fragment_inventory(
    DatabaseTemplateInventory::from_sources(unique.into_values().collect(), merge_database_updates(all_updates)?)?,
    database_selection(&bundles)?,
  )
  .map_err(|error| format!("assistant native platform dependency unavailable: {error}"))?;
  AssistantPackageInventory::from_sources(assistants, &catalog)?;
  validate_active_native_links(bundle, platform, &catalog)?;
  Ok(())
}

pub fn assemble_feature_catalogs(
  release: &FeatureReleaseDescriptor,
  catalog: &FeatureBundleCatalogSource,
  captured: &[CapturedFeatureBundle],
) -> Result<ResolvedFeatureCatalogs, String> {
  let selected = selected_captures(release, catalog, captured)?;
  let platform = captured
    .iter()
    .filter(|bundle| bundle.manifest.id == release.base.id)
    .cloned()
    .collect::<Vec<_>>();
  validate_historical_ownership(&selected)?;
  let mut owners = NativeOwners::default();
  let mut databases = Vec::new();
  let mut updates = Vec::new();
  let mut assistants = Vec::new();
  let mut database_facts = BTreeMap::new();
  let mut assistant_facts = BTreeMap::new();
  let active = selected
    .iter()
    .filter(|(_, active)| *active)
    .map(|(bundle, _)| *bundle)
    .collect::<Vec<_>>();
  let selection = database_selection(&active)?;
  validate_active_document_exports(&active)?;
  let mut assistant_entries = Vec::new();
  let mut assistant_ids = BTreeSet::new();
  for (bundle, is_active) in &selected {
    validate_feature_references(bundle, &platform)?;
    let base_provider = bundle.manifest.id == release.base.id;
    if *is_active {
      validate_active_exports(bundle)?;
    }
    if !base_provider {
      for (component_id, sources) in &bundle.databases {
        for definition in &sources.definitions {
          if let Some(core) = &definition.task_core {
            if resolve_feature_task_core(
              &bundle.manifest.links,
              component_id,
              &definition.id,
              &definition.version,
              core,
              &platform,
            )?
            .is_none()
            {
              return Err(format!(
                "{}: optional Task core requires a pinned base export",
                component_id
              ));
            }
          }
        }
      }
    }
    if !base_provider
      && bundle
        .databases
        .values()
        .any(|sources| !sources.catalog.system_sources.is_empty())
    {
      return Err(format!(
        "optional provider {} cannot own native system roles",
        bundle.manifest.id
      ));
    }
    for component in &bundle.manifest.components {
      if let Some(identity) = &component.native_identity {
        if component.kind == FeatureComponentKind::TaskCore && !base_provider {
          return Err(format!(
            "optional provider {} cannot own platform Task core",
            bundle.manifest.id
          ));
        }
        owners.admit(
          component.kind,
          &identity.id,
          &identity.version,
          &component.sha256,
          &bundle.manifest.id,
          *is_active,
        )?;
      }
    }
    for (definition, reference) in database_pairs(bundle)? {
      let key = (definition.id.clone(), definition.version.clone());
      let facts = serde_json::to_value((&definition, &reference.selections)).expect("native Database facts serialize");
      if database_facts
        .insert(key, facts.clone())
        .is_some_and(|known| known != facts)
      {
        return Err(format!(
          "immutable native definition or mapping changed: {}@{}",
          definition.id, definition.version
        ));
      }
      let active_claim = *is_active;
      if owners.admit(
        FeatureComponentKind::DatabaseCatalog,
        &definition.id,
        &definition.version,
        &reference.sha256,
        &bundle.manifest.id,
        active_claim,
      )? {
        databases.push((definition, reference));
      }
    }
    updates.extend(database_update_pairs(bundle)?);
    for (source, digest) in assistant_definitions(bundle)? {
      let key = (source.id.clone(), source.version.clone());
      let facts = serde_json::to_value(&source).expect("native assistant facts serialize");
      if assistant_facts
        .insert(key, facts.clone())
        .is_some_and(|known| known != facts)
      {
        return Err(format!(
          "immutable native assistant changed: {}@{}",
          source.id, source.version
        ));
      }
      if owners.admit(
        FeatureComponentKind::AssistantCatalog,
        &source.id,
        &source.version,
        &digest,
        &bundle.manifest.id,
        *is_active,
      )? {
        assistants.push((source, digest));
      }
    }
    if *is_active {
      for component in bundle
        .manifest
        .components
        .iter()
        .filter(|component| component.kind == FeatureComponentKind::AssistantCatalog)
      {
        let sources = bundle
          .assistants
          .get(&component.id)
          .ok_or("declared native assistant component unavailable")?;
        for entry in &sources.catalog.packages {
          if !assistant_ids.insert(entry.id.clone()) {
            return Err(format!("duplicate active native assistant provider: {}", entry.id));
          }
          assistant_entries.push(entry.clone());
        }
      }
    }
  }
  // Every retained managed identity must retain an explicit current target from
  // its original active provider. A historical wrapper cannot restore one.
  for (definition, _) in &databases {
    if definition
      .variants
      .iter()
      .any(|variant| variant.spec.profile_kind == DatabaseProfileKind::Project)
      && !selection
        .current_targets
        .iter()
        .any(|target| target.template_id == definition.id)
    {
      return Err(format!(
        "retained managed template has no explicit current target: {}",
        definition.id
      ));
    }
  }
  let databases = DatabaseStarterTemplateCatalog::from_inventory(
    DatabaseTemplateInventory::from_sources(databases, merge_database_updates(updates)?)?,
    selection,
  )?;
  let active_pins: Vec<_> = std::iter::once(catalog.base.clone())
    .chain(catalog.optional.clone())
    .collect();
  let assistants = AssistantPackageCatalog::from_inventory(
    assistant_entries,
    AssistantPackageInventory::from_sources(assistants, &databases)?,
  )?
  .with_artwork(super::artwork_presentation::assistant_artwork_for_active(
    captured,
    &active_pins,
  )?)
  .with_document_sources(super::document_presentation::assistant_document_sources_for_active(
    captured,
    &active_pins,
  )?)
  .with_document_components(super::document_components::assistant_document_components_for_active(
    captured,
    &active_pins,
  )?)
  .with_workflows(super::workflows::assistant_workflows(captured, &active_pins)?);
  validate_platform_contexts(&assistants)?;
  for bundle in &active {
    validate_active_native_links(bundle, &platform, &databases)?;
  }
  Ok(ResolvedFeatureCatalogs {
    databases,
    assistants,
    active: active_pins,
    retained: catalog.retained.clone(),
    providers: owners.identities,
  })
}

fn validate_active_exports(bundle: &CapturedFeatureBundle) -> Result<(), String> {
  for (component, sources) in &bundle.databases {
    for entry in sources
      .catalog
      .templates
      .iter()
      .filter(|entry| entry.offering == Some(true))
    {
      if !bundle.manifest.exports.iter().any(|export| {
        export.source.component == *component
          && export.source.export == format!("{}@{}", entry.id, entry.current)
          && export.source.key.is_none()
          && export.contexts.is_empty()
      }) {
        return Err(format!(
          "{component}: native current offering lacks Feature export: {}",
          entry.id
        ));
      }
    }
  }
  for (component, sources) in &bundle.assistants {
    for entry in &sources.catalog.packages {
      let package = sources
        .definitions
        .iter()
        .find(|(source, _)| source.id == entry.id && source.version == entry.current)
        .map(|(source, _)| source)
        .ok_or("active assistant source unavailable")?;
      let exports = bundle
        .manifest
        .exports
        .iter()
        .filter(|export| {
          export.source.component == *component
            && export.source.export == format!("{}@{}", entry.id, entry.current)
            && export.source.key.is_none()
        })
        .collect::<Vec<_>>();
      if package
        .contexts
        .iter()
        .any(|context| !exports.iter().any(|export| export.contexts.contains(context)))
      {
        return Err(format!(
          "{component}: native current assistant contexts lack Feature exports: {}",
          entry.id
        ));
      }
    }
  }
  for export in bundle
    .manifest
    .exports
    .iter()
    .filter(|export| !export.contexts.is_empty())
  {
    let sources = bundle
      .assistants
      .get(&export.source.component)
      .ok_or("offering context export is not a native assistant")?;
    if export.source.key.is_some()
      || !sources
        .catalog
        .packages
        .iter()
        .any(|entry| export.source.export == format!("{}@{}", entry.id, entry.current))
    {
      return Err("offering context export must refer to its native current assistant".into());
    }
  }
  Ok(())
}

fn native_link_target<'a>(
  bundle: &'a CapturedFeatureBundle,
  target: &'a FeatureReference,
  platform: &'a [CapturedFeatureBundle],
) -> Result<&'a FeatureNativeReference, String> {
  match target {
    FeatureReference::Local { reference } => Ok(reference),
    FeatureReference::Platform { bundle: pin, export } => platform
      .iter()
      .find(|source| source.pin() == *pin)
      .and_then(|source| source.manifest.exports.iter().find(|entry| entry.id == *export))
      .map(|entry| &entry.source)
      .ok_or_else(|| format!("{}: pinned native link target unavailable", bundle.manifest.id)),
  }
}
fn validate_active_native_links(
  bundle: &CapturedFeatureBundle,
  platform: &[CapturedFeatureBundle],
  databases: &DatabaseStarterTemplateCatalog,
) -> Result<(), String> {
  for (component, sources) in &bundle.assistants {
    for entry in &sources.catalog.packages {
      let package = &sources
        .definitions
        .iter()
        .find(|(source, _)| source.id == entry.id && source.version == entry.current)
        .ok_or("native assistant current source unavailable")?
        .0;
      let native_export = format!("{}@{}", package.id, package.version);
      for action in &package.components {
        let AssistantNativeAction::CreateProject { template_id, .. } = &action.action else {
          continue;
        };
        let version = databases
          .current_source(template_id)
          .ok_or("active assistant native current target unavailable")?
          .0;
        let expected = format!("{template_id}@{version}");
        let schemas = bundle
          .manifest
          .links
          .iter()
          .filter_map(|link| match link {
            FeatureLink::Schema { from, to }
              if from.component == *component
                && from.export == native_export
                && from.key.as_deref() == Some(&format!("component/{}", action.id)) =>
            {
              Some(to)
            }
            _ => None,
          })
          .collect::<Vec<_>>();
        if schemas.len() != 1 || native_link_target(bundle, schemas[0], platform)?.export != expected {
          return Err(format!(
            "{component}: active Project schema link must target native current source {expected}"
          ));
        }
        for link in &bundle.manifest.links {
          if let FeatureLink::View { from, to } = link {
            if from.component == *component
              && from.export == native_export
              && native_link_target(bundle, to, platform)?.export != expected
            {
              return Err(format!(
                "{component}: active View link must target native current source {expected}"
              ));
            }
          }
        }
      }
    }
  }
  Ok(())
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;

fn validate_active_document_exports(bundles: &[&CapturedFeatureBundle]) -> Result<(), String> {
  let mut current = BTreeMap::new();
  for bundle in bundles {
    for export in &bundle.manifest.exports {
      let component = bundle
        .manifest
        .components
        .iter()
        .find(|component| component.id == export.source.component)
        .ok_or("export native component unavailable")?;
      if component.kind != FeatureComponentKind::DocumentTemplate {
        continue;
      }
      let identity = component
        .native_identity
        .as_ref()
        .ok_or("document native identity unavailable")?;
      if current
        .insert(&identity.id, (&identity.version, &bundle.manifest.id))
        .is_some()
      {
        return Err(format!(
          "duplicate active document current/default export: {}",
          identity.id
        ));
      }
    }
  }
  Ok(())
}

/// These are implemented native surfaces, not package IDs or offering counts.
/// Fragment admission stays partial; Task-container assistance is optional.
fn validate_platform_contexts(assistants: &AssistantPackageCatalog) -> Result<(), String> {
  for context in [
    AssistantPackageContext::WorkspaceCreation,
    AssistantPackageContext::ProjectCreation,
    AssistantPackageContext::TaskHome,
    AssistantPackageContext::TaskInventory,
    AssistantPackageContext::TaskDetail,
    AssistantPackageContext::TaskCreation,
    AssistantPackageContext::TaskCapture,
    AssistantPackageContext::TaskSubtask,
    AssistantPackageContext::TaskMovement,
  ] {
    let descriptor = assistants
      .default_descriptor(context)
      .ok_or_else(|| format!("required native assistant context unavailable: {context:?}"))?;
    if context == AssistantPackageContext::WorkspaceCreation {
      let empty = descriptor.components.iter().any(|component| match &component.action {
        AssistantNativeAction::CreateWorkspace { inputs } => {
          let Some(AssistantValueBinding::Input { input }) = inputs.get(&AssistantInputTarget::InitialContent) else {
            return false;
          };
          descriptor
            .inputs
            .iter()
            .find(|spec| spec.id == *input)
            .is_some_and(|spec| {
              spec.choices.iter().any(|choice| match &choice.value {
                AssistantValue::Text(value) | AssistantValue::Choice(value) => {
                  serde_json::from_value::<WorkspaceInitialContent>(serde_json::Value::String(value.clone()))
                    .is_ok_and(|value| value == WorkspaceInitialContent::Empty)
                }
                _ => false,
              })
            })
        }
        _ => false,
      });
      if !empty {
        return Err("required native Empty Workspace creation capability unavailable".into());
      }
    }
  }
  Ok(())
}
