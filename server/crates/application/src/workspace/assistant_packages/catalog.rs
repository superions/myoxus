// SPDX-License-Identifier: AGPL-3.0-or-later

//! Immutable native version inventory and independent active offering selection.
use super::AssistantPackageService;
use super::validation::{key, validate_assistant_package};
use crate::database::DatabaseStarterTemplateCatalog;
use myoxus_domain::assistant_package::*;
use std::collections::{BTreeMap, BTreeSet};

pub trait AssistantPackageSourcePort: Send + Sync {
  fn capture(&self) -> Result<AssistantPackageCatalog, String>;
}

/// All admitted immutable versions, including versions absent from active offers.
#[derive(Debug, Clone)]
pub struct AssistantPackageInventory {
  definitions: BTreeMap<(String, String), (AssistantPackageSource, String)>,
}
impl AssistantPackageInventory {
  /// Validate a native fragment without fabricating selection/default entries.
  pub fn from_sources(
    definitions: Vec<(AssistantPackageSource, String)>,
    templates: &DatabaseStarterTemplateCatalog,
  ) -> Result<Self, String> {
    let mut admitted = BTreeMap::new();
    for (definition, digest) in definitions {
      validate_assistant_package(&definition, templates)?;
      if digest.len() != 64
        || !digest
          .bytes()
          .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || admitted
          .insert(
            (definition.id.clone(), definition.version.clone()),
            (definition, digest),
          )
          .is_some()
      {
        return Err("duplicate assistant identity or invalid digest".into());
      }
    }
    Ok(Self { definitions: admitted })
  }
  /// Exact retained lookup; availability here does not imply active eligibility.
  pub fn get(&self, identity: &AssistantPackageIdentity) -> Result<&AssistantPackageSource, String> {
    let (source, digest) = self
      .definitions
      .get(&(identity.id.clone(), identity.version.clone()))
      .ok_or("immutable assistant package unavailable")?;
    if digest != &identity.digest {
      return Err("assistant package digest changed".into());
    }
    Ok(source)
  }
}

#[derive(Debug, Clone)]
pub struct AssistantPackageCatalog {
  entries: Vec<AssistantPackageCatalogEntry>,
  inventory: AssistantPackageInventory,
  artwork: BTreeMap<(String, String), Vec<AssistantArtworkSlot>>,
  document_sources: BTreeMap<(String, String), Vec<AssistantDocumentSourceSlot>>,
  document_components: BTreeMap<(String, String), Vec<(AssistantDocumentComponentSource, std::sync::Arc<[u8]>)>>,
  workflows: BTreeMap<(String, String), AssistantResolvedWorkflow>,
}
impl AssistantPackageCatalog {
  /// Callers must already hold a server-loaded accepted receipt; inventory
  /// availability is not an active offer or authorization to create.
  pub(crate) fn retained_source(&self, identity: &AssistantPackageIdentity) -> Result<&AssistantPackageSource, String> {
    self.inventory.get(identity)
  }
  /// Preserve the strict file-catalog contract: each captured version has one
  /// declared pinned reference. Retained lookup itself needs no active entry.
  pub fn from_sources(
    source: AssistantPackageCatalogSource,
    definitions: Vec<(AssistantPackageSource, String)>,
    templates: &DatabaseStarterTemplateCatalog,
  ) -> Result<Self, String> {
    if source.format_version != 1 || source.packages.is_empty() || source.packages.len() > 128 {
      return Err("invalid or unbounded assistant catalog".into());
    }
    let inventory = AssistantPackageInventory::from_sources(definitions, templates)?;
    let catalog = Self::from_inventory(source.packages, inventory)?;
    let references = catalog
      .entries
      .iter()
      .map(|entry| entry.definitions.len())
      .sum::<usize>();
    if references != catalog.inventory.definitions.len() {
      return Err("unreferenced assistant source".into());
    }
    Ok(catalog)
  }
  /// Admit an assembled active selection independently of retained inventory.
  /// An empty selection offers nothing; inventory remains available for recovery.
  pub fn from_inventory(
    entries: Vec<AssistantPackageCatalogEntry>,
    inventory: AssistantPackageInventory,
  ) -> Result<Self, String> {
    validate_assistant_selection(&entries, &inventory)?;
    Ok(Self {
      entries,
      inventory,
      artwork: BTreeMap::new(),
      document_sources: BTreeMap::new(),
      document_components: BTreeMap::new(),
      workflows: BTreeMap::new(),
    })
  }
  pub fn inventory(&self) -> &AssistantPackageInventory {
    &self.inventory
  }
  /// Only the admitted delivery composition attaches presentation to real
  /// current native groups. This has no effect on prepare/apply identity.
  pub(crate) fn with_artwork(mut self, artwork: BTreeMap<(String, String), Vec<AssistantArtworkSlot>>) -> Self {
    self.artwork = artwork;
    self
  }
  pub(crate) fn with_document_sources(
    mut self,
    sources: BTreeMap<(String, String), Vec<AssistantDocumentSourceSlot>>,
  ) -> Self {
    self.document_sources = sources;
    self
  }
  pub(crate) fn with_document_components(
    mut self,
    sources: BTreeMap<(String, String), Vec<(AssistantDocumentComponentSource, std::sync::Arc<[u8]>)>>,
  ) -> Self {
    self.document_components = sources;
    self
  }
  pub(crate) fn with_workflows(mut self, workflows: BTreeMap<(String, String), AssistantResolvedWorkflow>) -> Self {
    self.workflows = workflows;
    self
  }
  /// Exact inventory lookup is not fresh admission. Callers must first choose
  /// an active offering or resolve their already accepted native receipt.
  pub fn workflow(&self, identity: &AssistantPackageIdentity) -> Result<Option<AssistantResolvedWorkflow>, String> {
    self.inventory.get(identity)?;
    Ok(
      self
        .workflows
        .get(&(identity.id.clone(), identity.version.clone()))
        .cloned(),
    )
  }
  pub(crate) fn document_components(
    &self,
    identity: &AssistantPackageIdentity,
  ) -> &[(AssistantDocumentComponentSource, std::sync::Arc<[u8]>)] {
    if self.inventory.get(identity).is_err() {
      return &[];
    }
    self
      .document_components
      .get(&(identity.id.clone(), identity.version.clone()))
      .map(Vec::as_slice)
      .unwrap_or_default()
  }
  /// Exact immutable lookup alone grants no permission to begin an action.
  /// Accepted recovery resolves its persisted receipt before reaching this fence.
  pub fn offered_source(
    &self,
    identity: &AssistantPackageIdentity,
    context: AssistantPackageContext,
  ) -> Result<&AssistantPackageSource, String> {
    let source = self.inventory.get(identity)?;
    if !source.contexts.contains(&context)
      || !self
        .entries
        .iter()
        .any(|entry| entry.enabled && entry.id == identity.id && entry.current == identity.version)
    {
      return Err("assistant package is not an active current offering for this action".into());
    }
    Ok(source)
  }
  /// Resolve a fresh manual source only from the currently offered projection.
  /// The digest names the document archive; it grants no Registry/document rights.
  pub(crate) fn document_source(
    &self,
    identity: &AssistantPackageIdentity,
    step: &str,
    group: &str,
    digest: &str,
  ) -> Result<AssistantDocumentSourceSlot, String> {
    let source = self.inventory.get(identity)?;
    let context = if source.contexts.contains(&AssistantPackageContext::ProjectCreation) {
      AssistantPackageContext::ProjectCreation
    } else if source.contexts.contains(&AssistantPackageContext::WorkspaceCreation)
      && source
        .presentation
        .guided_help
        .as_ref()
        .is_some_and(|help| help.id == step && help.groups.iter().any(|candidate| candidate.id == group))
    {
      AssistantPackageContext::WorkspaceCreation
    } else {
      return Err("manual Library source unavailable in this context".into());
    };
    self.offered_source(identity, context)?;
    self
      .document_sources
      .get(&(identity.id.clone(), identity.version.clone()))
      .and_then(|slots| {
        slots
          .iter()
          .find(|slot| slot.step == step && slot.group == group && slot.digest == digest)
      })
      .cloned()
      .ok_or_else(|| "manual Library source is unavailable or changed".into())
  }
  fn descriptor(&self, entry: &AssistantPackageCatalogEntry) -> AssistantPackageDescriptor {
    let (source, digest) = &self.inventory.definitions[&(entry.id.clone(), entry.current.clone())];
    self.source_descriptor(source, digest, entry.default_for.clone())
  }
  /// Receipt-only projection; retained availability is never fresh permission.
  pub(crate) fn accepted_descriptor(
    &self,
    identity: &AssistantPackageIdentity,
  ) -> Result<AssistantPackageDescriptor, String> {
    let source = self.inventory.get(identity)?;
    let defaults = self
      .entries
      .iter()
      .find(|entry| entry.id == identity.id && entry.current == identity.version)
      .map(|entry| entry.default_for.clone())
      .unwrap_or_default();
    Ok(self.source_descriptor(source, &identity.digest, defaults))
  }
  fn source_descriptor(
    &self,
    source: &AssistantPackageSource,
    digest: &String,
    default_for: Vec<AssistantPackageContext>,
  ) -> AssistantPackageDescriptor {
    let mut components = std::collections::BTreeSet::new();
    AssistantPackageDescriptor {
      components: source.components.clone(),
      document_components: self
        .document_components(&AssistantPackageIdentity {
          id: source.id.clone(),
          version: source.version.clone(),
          digest: digest.clone(),
        })
        .iter()
        .filter(|(source, _)| components.insert(source.component_id.clone()))
        .map(|(source, _)| source.clone())
        .collect(),
      default_for,
      identity: AssistantPackageIdentity {
        id: source.id.clone(),
        version: source.version.clone(),
        digest: digest.clone(),
      },
      name: source.name.clone(),
      description: source.description.clone(),
      contexts: source.contexts.clone(),
      inputs: source.inputs.clone(),
      presentation: source.presentation.clone(),
      document_sources: self
        .document_sources
        .get(&(source.id.clone(), source.version.clone()))
        .cloned()
        .unwrap_or_default(),
      artwork: self
        .artwork
        .get(&(source.id.clone(), source.version.clone()))
        .cloned()
        .unwrap_or_default(),
    }
  }
  /// Saved selections discover the current offering by ID; historical inventory
  /// remains exclusive to already accepted receipt recovery.
  pub(crate) fn current_descriptor(
    &self,
    id: &str,
    context: AssistantPackageContext,
  ) -> Option<AssistantPackageDescriptor> {
    self
      .entries
      .iter()
      .find(|entry| {
        entry.enabled
          && entry.id == id
          && self.inventory.definitions[&(entry.id.clone(), entry.current.clone())]
            .0
            .contexts
            .contains(&context)
      })
      .map(|entry| self.descriptor(entry))
  }
  pub fn list(&self, context: AssistantPackageContext) -> Vec<AssistantPackageDescriptor> {
    self
      .entries
      .iter()
      .filter(|entry| {
        entry.enabled
          && self.inventory.definitions[&(entry.id.clone(), entry.current.clone())]
            .0
            .contexts
            .contains(&context)
      })
      .map(|entry| self.descriptor(entry))
      .collect()
  }
  pub fn default_descriptor(&self, context: AssistantPackageContext) -> Option<AssistantPackageDescriptor> {
    self
      .entries
      .iter()
      .find(|entry| entry.enabled && entry.default_for.contains(&context))
      .map(|entry| self.descriptor(entry))
  }
}

/// Validate all retained pins, with defaults required only for enabled contexts.
/// A disabled entry cannot satisfy or shadow an active context's default.
pub fn validate_assistant_selection(
  entries: &[AssistantPackageCatalogEntry],
  inventory: &AssistantPackageInventory,
) -> Result<(), String> {
  if entries.len() > 128 {
    return Err("invalid or unbounded assistant catalog".into());
  }
  let mut identities = BTreeSet::new();
  let mut references = BTreeSet::new();
  let mut defaults = Vec::new();
  for entry in entries {
    if !key(&entry.id)
      || !identities.insert(&entry.id)
      || entry.definitions.is_empty()
      || !entry
        .definitions
        .iter()
        .any(|reference| reference.version == entry.current)
    {
      return Err("invalid assistant catalog identity/current version".into());
    }
    for reference in &entry.definitions {
      let identity = (entry.id.clone(), reference.version.clone());
      let (definition, digest) = inventory
        .definitions
        .get(&identity)
        .ok_or("missing retained assistant source")?;
      if !references.insert(identity) || digest != &reference.sha256 {
        return Err("duplicate assistant reference or pin mismatch".into());
      }
      if reference.version == entry.current {
        let mut declared_defaults = Vec::new();
        for context in &entry.default_for {
          if !definition.contexts.contains(context)
            || declared_defaults.contains(context)
            || (entry.enabled && defaults.contains(context))
          {
            return Err("invalid or duplicate assistant context default".into());
          }
          declared_defaults.push(*context);
          if entry.enabled {
            defaults.push(*context);
          }
        }
      }
    }
  }
  for entry in entries.iter().filter(|entry| entry.enabled) {
    let definition = &inventory.definitions[&(entry.id.clone(), entry.current.clone())].0;
    if definition.contexts.iter().any(|context| !defaults.contains(context)) {
      return Err("every offered assistant context requires one explicit default".into());
    }
  }
  Ok(())
}

impl AssistantPackageService {
  /// A current source selection does not grant access to its workspace Library.
  pub fn document_source(
    &self,
    identity: &AssistantPackageIdentity,
    step: &str,
    group: &str,
    digest: &str,
  ) -> Result<AssistantDocumentSourceSlot, String> {
    self.packages.document_source(identity, step, group, digest)
  }
  pub fn list(&self, context: AssistantPackageContext) -> Vec<AssistantPackageDescriptor> {
    if context == AssistantPackageContext::WorkspaceCreation {
      // Combined-purpose sources remain validated inventory, not creation choices.
      return self
        .packages
        .default_descriptor(context)
        .filter(|descriptor| {
          matches!(
            descriptor.components.first().map(|component| &component.action),
            Some(AssistantNativeAction::CreateWorkspace { .. })
          )
        })
        .into_iter()
        .collect();
    }
    self.packages.list(context)
  }
  pub fn default_descriptor(&self, context: AssistantPackageContext) -> Option<AssistantPackageDescriptor> {
    self.packages.default_descriptor(context)
  }
}
