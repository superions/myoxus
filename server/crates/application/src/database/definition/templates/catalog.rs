// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native immutable sources remain available independently of creation offers.
use super::*;

/// Captures a complete immutable source snapshot before request handling.
pub trait DatabaseStarterTemplateSource: Send + Sync {
  fn capture(&self) -> Result<DatabaseStarterTemplateCatalog, String>;
}

/// An admitted version carries the original native pin and finite input mapping.
/// Delivery namespaces and active offering policy do not belong to this inventory.
#[derive(Debug, Clone)]
pub struct DatabaseTemplateInventory {
  pub(super) updates: BTreeMap<(String, String), (DatabaseTemplateUpdateSource, DatabaseTemplateUpdateReference)>,
  pub(super) sources: BTreeMap<(String, String), (DatabaseTemplateDefinitionSource, DatabaseTemplateFileReference)>,
}
impl DatabaseTemplateInventory {
  /// Admit a fragment without requiring platform roles, current targets or offers.
  pub fn from_sources(
    sources: Vec<(DatabaseTemplateDefinitionSource, DatabaseTemplateFileReference)>,
    updates: Vec<(DatabaseTemplateUpdateSource, DatabaseTemplateUpdateReference)>,
  ) -> Result<Self, String> {
    if sources.len() > 256 {
      return Err("unbounded native database inventory".into());
    }
    let mut admitted = BTreeMap::new();
    for (definition, reference) in sources {
      validate_database_template_definition(&definition, &reference)?;
      let identity = (definition.id.clone(), definition.version.clone());
      if admitted.insert(identity, (definition, reference)).is_some() {
        return Err("duplicate database definition identity".into());
      }
    }
    if updates.len() > 256 {
      return Err("unbounded native database update inventory".into());
    }
    let mut inventory = Self {
      sources: admitted,
      updates: BTreeMap::new(),
    };
    for (update, reference) in updates {
      validate_database_template_update(&inventory, &update, &reference)?;
      let identity = (update.template_id.clone(), update.source.version.clone());
      if inventory.updates.insert(identity, (update, reference)).is_some() {
        return Err("duplicate or ambiguous native database update edge".into());
      }
    }
    Ok(inventory)
  }
  /// Exact outgoing transition; immutable history alone grants no fresh offering.
  pub fn update_from(
    &self,
    id: &str,
    version: &str,
  ) -> Option<(&DatabaseTemplateUpdateSource, &DatabaseTemplateUpdateReference)> {
    let (source, reference) = self.updates.get(&(id.to_string(), version.to_string()))?;
    Some((source, reference))
  }
  pub fn version_source(&self, id: &str, version: &str) -> Option<(&DatabaseTemplateDefinitionSource, &str)> {
    let (definition, reference) = self.sources.get(&(id.to_string(), version.to_string()))?;
    Some((definition, &reference.sha256))
  }
  pub fn select_version(
    &self,
    id: &str,
    version: &str,
    input: DatabaseTemplateSelection,
  ) -> Option<&DatabaseTemplateSpec> {
    let (definition, reference) = self.sources.get(&(id.to_string(), version.to_string()))?;
    let selection = reference.selections.iter().find(|selection| selection.input == input)?;
    definition
      .variants
      .iter()
      .find(|variant| variant_selection(variant) == selection.variant)
      .map(|variant| &variant.spec)
  }
  fn reference(&self, id: &str, version: &str) -> Option<&DatabaseTemplateFileReference> {
    Some(&self.sources.get(&(id.to_string(), version.to_string()))?.1)
  }
}

#[derive(Debug, Clone)]
pub struct DatabaseTemplateCurrentTarget {
  pub template_id: String,
  pub version: String,
}
#[derive(Debug, Clone)]
pub struct DatabaseTemplateOffering {
  pub template_id: String,
  pub default_variant: DatabaseTemplateSelection,
}
/// Resolved native choices, supplied by the composition owner, never persisted
/// into immutable definition bytes. Generic sources remain ordinary unbound data.
#[derive(Debug, Clone)]
pub struct DatabaseTemplateCatalogSelection {
  pub current_targets: Vec<DatabaseTemplateCurrentTarget>,
  pub offerings: Vec<DatabaseTemplateOffering>,
  pub system_sources: Vec<DatabaseTemplateSystemSource>,
}
#[derive(Debug, Clone)]
pub struct DatabaseStarterTemplateCatalog {
  inventory: DatabaseTemplateInventory,
  selection: DatabaseTemplateCatalogSelection,
}
impl DatabaseStarterTemplateCatalog {
  /// Strict filesystem admission: every captured version has exactly one native
  /// reference. This wrapper builds the same inventory and final selection used
  /// by composed consumers; it does not maintain a parallel source model.
  pub fn from_sources(
    source: DatabaseTemplateCatalogSource,
    definitions: Vec<DatabaseTemplateDefinitionSource>,
    updates: Vec<(DatabaseTemplateUpdateSource, DatabaseTemplateUpdateReference)>,
  ) -> Result<Self, String> {
    if source.format_version != 1
      || source.templates.is_empty()
      || source.templates.len() > 128
      || definitions.len() > 256
    {
      return Err("database catalog requires a bounded nonempty format-1 offering inventory".into());
    }
    let mut captured_updates = BTreeMap::new();
    for (update, reference) in updates {
      let key = (update.template_id.clone(), reference.from.clone(), reference.to.clone());
      if captured_updates.insert(key, (update, reference)).is_some() {
        return Err("duplicate captured database update".into());
      }
    }
    let mut paired_updates = Vec::new();
    let mut ids = BTreeSet::new();
    let mut by_identity = BTreeMap::new();
    for definition in definitions {
      let identity = (definition.id.clone(), definition.version.clone());
      if by_identity.insert(identity, definition).is_some() {
        return Err("duplicate database definition identity".into());
      }
    }
    let mut sources = Vec::new();
    let mut current_targets = Vec::new();
    let mut offerings = Vec::new();
    for entry in &source.templates {
      if entry.id.trim().is_empty()
        || !ids.insert(&entry.id)
        || entry.offering.is_none()
        || entry.default_variant.is_none()
      {
        return Err("duplicate or empty database catalog identity".into());
      }
      if entry.definitions.is_empty() || !entry.definitions.iter().any(|file| file.version == entry.current) {
        return Err(format!("{} has no explicit current definition", entry.id));
      }
      for reference in &entry.definitions {
        let definition = by_identity
          .remove(&(entry.id.clone(), reference.version.clone()))
          .ok_or_else(|| {
            format!(
              "{} has duplicate or unavailable definition {}",
              entry.id, reference.version
            )
          })?;
        sources.push((definition, reference.clone()));
      }
      for reference in &entry.updates {
        let key = (entry.id.clone(), reference.from.clone(), reference.to.clone());
        let (update, captured_reference) = captured_updates
          .remove(&key)
          .ok_or("duplicate or unavailable database update reference")?;
        if &captured_reference != reference {
          return Err("database update reference does not match captured pin".into());
        }
        paired_updates.push((update, captured_reference));
      }
      current_targets.push(DatabaseTemplateCurrentTarget {
        template_id: entry.id.clone(),
        version: entry.current.clone(),
      });
      if entry.offering == Some(true) {
        offerings.push(DatabaseTemplateOffering {
          template_id: entry.id.clone(),
          default_variant: entry.default_variant.expect("checked explicit default"),
        });
      }
    }
    if !by_identity.is_empty() {
      return Err("unreferenced database definition".into());
    }
    if !captured_updates.is_empty() {
      return Err("unreferenced database update".into());
    }
    let inventory = DatabaseTemplateInventory::from_sources(sources, paired_updates)?;
    // Retired filesystem entries still declare valid source metadata; their
    // defaults do not become active creation defaults in the assembled catalog.
    for entry in &source.templates {
      if inventory
        .select_version(
          &entry.id,
          &entry.current,
          entry.default_variant.expect("checked explicit default"),
        )
        .is_none()
      {
        return Err(format!("{} default parameters are not declared", entry.id));
      }
    }
    Self::from_inventory(
      inventory,
      DatabaseTemplateCatalogSelection {
        current_targets,
        offerings,
        system_sources: source.system_sources,
      },
    )
  }
  pub fn from_inventory(
    inventory: DatabaseTemplateInventory,
    selection: DatabaseTemplateCatalogSelection,
  ) -> Result<Self, String> {
    validate_database_template_selection(&inventory, &selection)?;
    Ok(Self { inventory, selection })
  }
  /// Fragment dependency checks need offering/role facts without asserting that
  /// an immutable historical archive already contains future update edges.
  /// Only the final composed selection grants executable update routes.
  pub(crate) fn from_fragment_inventory(
    inventory: DatabaseTemplateInventory,
    selection: DatabaseTemplateCatalogSelection,
  ) -> Result<Self, String> {
    super::validation::validate_database_template_selection_metadata(&inventory, &selection)?;
    Ok(Self { inventory, selection })
  }
  /// The unique admitted route, in commit order, without materializing user data.
  pub fn update_route(&self, id: &str, from: &str) -> Option<Vec<&DatabaseTemplateUpdateSource>> {
    let (current, _) = self.current_source(id)?;
    self.inventory.version_source(id, from)?;
    let mut route = Vec::new();
    let mut version = from;
    while version != current {
      let (update, _) = self.inventory.update_from(id, version)?;
      route.push(update);
      version = &update.target.version;
      if route.len() > self.inventory.updates.len() {
        return None;
      }
    }
    Some(route)
  }
  pub fn inventory(&self) -> &DatabaseTemplateInventory {
    &self.inventory
  }
  pub fn system_source(&self, role: DatabaseTemplateSourceRole) -> Option<&DatabaseTemplateSystemSource> {
    self.selection.system_sources.iter().find(|source| source.role == role)
  }
  pub fn default_selection(&self, id: &str) -> Option<&DatabaseTemplateSelection> {
    self
      .selection
      .offerings
      .iter()
      .find(|offering| offering.template_id == id)
      .map(|offering| &offering.default_variant)
  }
  pub fn selections(&self, id: &str) -> Option<&[DatabaseTemplateVariantSelection]> {
    let target = self
      .selection
      .current_targets
      .iter()
      .find(|target| target.template_id == id)?;
    Some(&self.inventory.reference(id, &target.version)?.selections)
  }
  /// Exact native lookup, including retained versions with no current offering.
  pub fn select_version(
    &self,
    id: &str,
    version: &str,
    input: DatabaseTemplateSelection,
  ) -> Option<&DatabaseTemplateSpec> {
    self.inventory.select_version(id, version, input)
  }
  pub fn select_selection(&self, id: &str, input: DatabaseTemplateSelection) -> Option<&DatabaseTemplateSpec> {
    let target = self
      .selection
      .current_targets
      .iter()
      .find(|target| target.template_id == id)?;
    self.select_version(id, &target.version, input)
  }
  /// Offering-aware selection for fresh actions. Public action fencing is owned
  /// by its caller; native readiness and recovery use the independent selectors.
  pub fn select_offering(&self, id: &str, input: DatabaseTemplateSelection) -> Option<&DatabaseTemplateSpec> {
    self
      .selection
      .offerings
      .iter()
      .find(|offering| offering.template_id == id)?;
    self.select_selection(id, input)
  }
  pub fn select(
    &self,
    id: &str,
    priority: DatabaseProjectOptionPreset,
    complexity: DatabaseProjectOptionPreset,
    structure: DatabaseProjectStructurePreset,
  ) -> Option<&DatabaseTemplateSpec> {
    self.select_selection(
      id,
      DatabaseTemplateSelection {
        priority,
        complexity,
        structure,
      },
    )
  }
  pub fn current_source(&self, id: &str) -> Option<(&str, &str)> {
    let target = self
      .selection
      .current_targets
      .iter()
      .find(|target| target.template_id == id)?;
    let reference = self.inventory.reference(id, &target.version)?;
    Some((&reference.version, &reference.sha256))
  }
  pub fn version_source(&self, id: &str, version: &str) -> Option<(&DatabaseTemplateDefinitionSource, &str)> {
    self.inventory.version_source(id, version)
  }
  pub fn admitted_sources(&self) -> Vec<(String, String, String)> {
    self
      .selection
      .current_targets
      .iter()
      .map(|target| {
        let reference = self
          .inventory
          .reference(&target.template_id, &target.version)
          .expect("admitted current target");
        (
          target.template_id.clone(),
          target.version.clone(),
          reference.sha256.clone(),
        )
      })
      .collect()
  }
  pub fn summaries(&self) -> Vec<DatabaseStarterTemplateSummary> {
    self
      .selection
      .offerings
      .iter()
      .filter_map(|entry| self.select_selection(&entry.template_id, entry.default_variant))
      .map(|template| {
        let manifest = template.to_manifest().expect("catalog admitted canonical manifest");
        DatabaseStarterTemplateSummary {
          id: template.id.clone(),
          version: self.current_source(&template.id).expect("admitted source").0.into(),
          digest: self.current_source(&template.id).expect("admitted source").1.into(),
          default_variant: *self.default_selection(&template.id).expect("admitted default"),
          selections: self.selections(&template.id).expect("admitted selections").to_vec(),
          name: template.name.clone(),
          name_key: manifest.name_key.clone(),
          description: template.description.clone(),
          description_key: manifest.description_key.clone(),
          category: template.category,
          profile_kind: template.profile_kind,
          default_view_kinds: template.views.iter().map(|view| view.kind).collect(),
          sample_row_count: template.sample_rows.len(),
          import_mappings: manifest.import_mappings.clone(),
        }
      })
      .collect()
  }
}

pub(super) fn variant_selection(variant: &DatabaseTemplateVariantSource) -> DatabaseTemplateSelection {
  DatabaseTemplateSelection {
    priority: variant.priority,
    complexity: variant.complexity,
    structure: variant.structure,
  }
}
