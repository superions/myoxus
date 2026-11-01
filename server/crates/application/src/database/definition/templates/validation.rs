// SPDX-License-Identifier: AGPL-3.0-or-later
use super::catalog::variant_selection;
use super::*;
use serde_json::json;

pub(super) fn validate_source_keys(spec: &DatabaseTemplateSpec) -> Result<(), String> {
  // Role configuration controls native write admission. A JSON value must not
  // bypass the managed-state contract through missing or misspelled guards.
  for role in &spec.roles {
    let expected = match role.managed_state {
      Some(DatabaseProjectRoleManagedState::UserEditable) => json!({}),
      Some(DatabaseProjectRoleManagedState::UserEditableDefaultEmpty) => json!({ "default": [] }),
      Some(DatabaseProjectRoleManagedState::CreatorDefault) => json!({ "default": "creator" }),
      Some(DatabaseProjectRoleManagedState::AssignmentMutation) => {
        json!({ "maintainedBy": "assignmentMutation", "manualEdit": false })
      }
      Some(DatabaseProjectRoleManagedState::StatusCompletionPolicy) if role.role_key == "task.status" => {
        json!({ "completionPolicy": "setCompletedAtAndProgress" })
      }
      Some(DatabaseProjectRoleManagedState::StatusCompletionPolicy) => {
        json!({ "maintainedBy": "statusCompletionPolicy", "manualEdit": false })
      }
      None if role.role_key == "project.template" => json!({ "templateId": spec.id }),
      None => {
        return Err(format!(
          "{} role {} has no native managed-state contract",
          spec.id, role.role_key
        ));
      }
    };
    if role.config != expected {
      return Err(format!(
        "{} role {} has invalid managed-state configuration",
        spec.id, role.role_key
      ));
    }
  }

  fn unique<'a>(values: impl Iterator<Item = &'a str>, kind: &str) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for value in values {
      if value.trim().is_empty() || !seen.insert(value) {
        return Err(format!("duplicate or blank {kind} key"));
      }
    }
    Ok(())
  }
  unique(spec.fields.iter().map(|field| field.key.as_str()), "field")?;
  unique(spec.sample_rows.iter().map(|row| row.key.as_str()), "sample row")?;
  unique(spec.row_templates.iter().map(|row| row.key.as_str()), "row template")?;
  for row in &spec.sample_rows {
    unique(
      row
        .cells
        .iter()
        .map(|(key, _)| key.as_str())
        .chain(row.relation_cells.iter().map(|(key, _)| key.as_str())),
      "sample cell",
    )?;
  }
  for row in &spec.row_templates {
    unique(row.initial_cells.iter().map(|(key, _)| key.as_str()), "template cell")?;
  }
  fn reject_instance_ids(value: &serde_json::Value) -> Result<(), String> {
    match value {
      serde_json::Value::String(value) if Uuid::parse_str(value).is_ok() => {
        Err("source must not author allocated instance UUIDs".into())
      }
      serde_json::Value::Array(values) => {
        for value in values {
          reject_instance_ids(value)?;
        }
        Ok(())
      }
      serde_json::Value::Object(values) => {
        for value in values.values() {
          reject_instance_ids(value)?;
        }
        Ok(())
      }
      _ => Ok(()),
    }
  }
  reject_instance_ids(&serde_json::to_value(spec).map_err(|error| error.to_string())?)
}

pub(super) fn validate_source_manifest(spec: &DatabaseTemplateSpec) -> Result<(), String> {
  let manifest = spec.to_manifest()?;
  manifest.validate().map_err(|error| error.to_string())?;
  manifest.validate_project_contract().map_err(|error| error.to_string())
}

/// Validate one expanded native fragment without selecting current versions or
/// requiring platform roles. Executable transitions are separately pinned edges;
/// historical predecessor metadata never supplies a missing transition.
pub fn validate_database_template_definition(
  definition: &DatabaseTemplateDefinitionSource,
  reference: &DatabaseTemplateFileReference,
) -> Result<(), String> {
  if definition.format_version != 1 || definition.id.trim().is_empty() || definition.version != reference.version {
    return Err(format!(
      "invalid database definition format/version for {}",
      definition.id
    ));
  }
  let version = semver::Version::parse(&definition.version).map_err(|_| "invalid native source semantic version")?;
  if reference.sha256.len() != 64
    || !reference
      .sha256
      .bytes()
      .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
  {
    return Err("invalid native database source digest".into());
  }
  let mut predecessors = BTreeSet::new();
  for predecessor in &definition.supported_predecessors {
    let previous = semver::Version::parse(predecessor).map_err(|_| "invalid source predecessor version")?;
    if previous >= version || !predecessors.insert(predecessor) {
      return Err(format!("{} has an unsupported or missing predecessor", definition.id));
    }
  }
  if !definition.supported_predecessors.is_empty()
    && definition
      .variants
      .iter()
      .any(|variant| variant.spec.metadata.is_none())
  {
    return Err(format!(
      "{} updated authoring requires canonical metadata",
      definition.id
    ));
  }
  if definition.variants.is_empty() || definition.variants.len() > 64 {
    return Err(format!("{} requires bounded declared variants", definition.id));
  }
  let mut variants = BTreeSet::new();
  for variant in &definition.variants {
    if variant.spec.id != definition.id {
      return Err(format!("definition/spec identity mismatch for {}", definition.id));
    }
    if !variants.insert((
      variant.priority.as_str(),
      variant.complexity.as_str(),
      variant.structure.as_str(),
    )) {
      return Err(format!("duplicate variant for {}", definition.id));
    }
    validate_source_manifest(&variant.spec)?;
    validate_source_keys(&variant.spec)?;
    materialize_template(
      &DatabaseLimits::default(),
      Uuid::nil(),
      Uuid::nil(),
      "Source validation",
      None,
      true,
      "EUR",
      variant.spec.clone(),
    )
    .map_err(|error| format!("{}: {error}", definition.id))?;
  }
  if reference.selections.is_empty() || reference.selections.len() > 256 {
    return Err(format!("{} has no bounded parameter selections", definition.id));
  }
  let mut inputs = BTreeSet::new();
  for selection in &reference.selections {
    if !inputs.insert((
      selection.input.priority.as_str(),
      selection.input.complexity.as_str(),
      selection.input.structure.as_str(),
    )) {
      return Err(format!("{} has duplicate parameter selections", definition.id));
    }
    if !definition
      .variants
      .iter()
      .any(|variant| variant_selection(variant) == selection.variant)
    {
      return Err(format!("{} selection references an undeclared variant", definition.id));
    }
  }
  Ok(())
}

/// Validate the resolved complete native selection once. Retiring an offering
/// never removes the installed version or its managed current target.
pub fn validate_database_template_selection(
  inventory: &DatabaseTemplateInventory,
  selection: &DatabaseTemplateCatalogSelection,
) -> Result<(), String> {
  validate_database_template_selection_metadata(inventory, selection)?;
  validate_database_template_routes(inventory, selection)
}

pub(super) fn validate_database_template_selection_metadata(
  inventory: &DatabaseTemplateInventory,
  selection: &DatabaseTemplateCatalogSelection,
) -> Result<(), String> {
  if inventory.sources.len() > 256 || selection.current_targets.len() > 128 || selection.offerings.len() > 128 {
    return Err("unbounded native database inventory or selection".into());
  }
  let mut targets = BTreeMap::new();
  for target in &selection.current_targets {
    if targets
      .insert(target.template_id.as_str(), target.version.as_str())
      .is_some()
      || inventory.version_source(&target.template_id, &target.version).is_none()
    {
      return Err("duplicate or unavailable native database current target".into());
    }
  }
  let mut offerings = BTreeSet::new();
  for offering in &selection.offerings {
    let version = targets
      .get(offering.template_id.as_str())
      .ok_or("database offering has no current target")?;
    if !offerings.insert(offering.template_id.as_str()) {
      return Err("duplicate native database offering".into());
    }
    if inventory
      .select_version(&offering.template_id, version, offering.default_variant)
      .is_none()
    {
      return Err(format!("{} default parameters are not declared", offering.template_id));
    }
  }
  let mut roles = Vec::new();
  for source in &selection.system_sources {
    if roles.contains(&source.role) {
      return Err("duplicate native database source role".into());
    }
    roles.push(source.role);
    let version = targets
      .get(source.template_id.as_str())
      .ok_or("native database source is unavailable")?;
    let spec = inventory
      .select_version(&source.template_id, version, source.selection)
      .ok_or("native database source is unavailable")?;
    if spec.profile_kind != DatabaseProfileKind::Project {
      return Err("native Task sources require managed Project definitions".into());
    }
    if source.role == DatabaseTemplateSourceRole::ProjectDefault && !offerings.contains(source.template_id.as_str()) {
      return Err("ProjectDefault requires an offered current Project target".into());
    }
    if source.role == DatabaseTemplateSourceRole::WorkspaceTasks
      && (spec.default_structure != Some(DatabaseProjectStructurePreset::TasksOnly)
        || spec.priority_preset != Some(DatabaseProjectOptionPreset::ThreeStep)
        || spec.complexity_preset != Some(DatabaseProjectOptionPreset::ThreeStep))
    {
      return Err("Workspace Tasks source must retain TasksOnly/three-step native contract".into());
    }
  }
  for required in [
    DatabaseTemplateSourceRole::ProjectDefault,
    DatabaseTemplateSourceRole::WorkspaceTasks,
  ] {
    if !roles.contains(&required) {
      return Err("required native database source role missing".into());
    }
  }
  Ok(())
}

/// A fragment admits only the edges it declares, against exact immutable native
/// endpoints. Complete reachability belongs to final selection, never discovery.
pub fn validate_database_template_update(
  inventory: &DatabaseTemplateInventory,
  update: &DatabaseTemplateUpdateSource,
  reference: &DatabaseTemplateUpdateReference,
) -> Result<(), String> {
  fn digest(value: &str) -> bool {
    value.len() == 64
      && value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
  }
  if update.format_version != 1
    || update.template_id.trim().is_empty()
    || update.source.version != reference.from
    || update.target.version != reference.to
    || !digest(&reference.sha256)
    || !digest(&update.source.sha256)
    || !digest(&update.target.sha256)
    || reference.path
      != format!(
        "{}/updates/{}-to-{}.yaml",
        update.template_id, reference.from, reference.to
      )
    || update.template_id.contains('/')
    || update.template_id.contains('\\')
    || update.template_id == "."
    || update.template_id == ".."
    || reference.from.contains('/')
    || reference.to.contains('/')
    || update.operations.len() > 256
  {
    return Err("invalid native database update identity, path or pin".into());
  }
  if compare_template_versions(&update.source.version, &update.target.version)? != std::cmp::Ordering::Less {
    return Err("native database update must move forward".into());
  }
  let (source, source_digest) = inventory
    .version_source(&update.template_id, &update.source.version)
    .ok_or("native database update source definition missing")?;
  let (target, target_digest) = inventory
    .version_source(&update.template_id, &update.target.version)
    .ok_or("native database update target definition missing")?;
  if source_digest != update.source.sha256 || target_digest != update.target.sha256 {
    return Err("native database update endpoint digest mismatch".into());
  }
  let source_reference = &inventory.sources[&(update.template_id.clone(), update.source.version.clone())].1;
  let target_reference = &inventory.sources[&(update.template_id.clone(), update.target.version.clone())].1;
  if source_reference.selections.len() != target_reference.selections.len()
    || source_reference.selections.iter().any(|before| {
      !target_reference
        .selections
        .iter()
        .any(|after| before.input == after.input && before.variant == after.variant)
    })
    || source.variants.len() != target.variants.len()
  {
    return Err("native database update variant mapping mismatch".into());
  }
  for before in &source.variants {
    let after = target
      .variants
      .iter()
      .find(|after| variant_selection(before) == variant_selection(after))
      .ok_or("native database update variant missing")?;
    myoxus_domain::database::definition::updates::validate_template_update(
      &before.spec,
      &after.spec,
      &update.operations,
    )?;
  }
  Ok(())
}

fn validate_database_template_routes(
  inventory: &DatabaseTemplateInventory,
  selection: &DatabaseTemplateCatalogSelection,
) -> Result<(), String> {
  let targets: BTreeMap<_, _> = selection
    .current_targets
    .iter()
    .map(|target| (target.template_id.as_str(), target.version.as_str()))
    .collect();
  // Only explicit update edges authorize execution. Historical predecessor
  // declarations cannot fill a missing edge or supply an alternate route.
  for ((id, version), (definition, _)) in &inventory.sources {
    if definition
      .variants
      .iter()
      .all(|variant| variant.spec.profile_kind == DatabaseProfileKind::Generic)
    {
      continue;
    }
    let current = targets
      .get(id.as_str())
      .ok_or("managed database inventory has no current target")?;
    let mut next = version.as_str();
    let mut visited = BTreeSet::new();
    while next != *current {
      if !visited.insert(next) {
        return Err("cyclic native database update route".into());
      }
      let (edge, _) = inventory
        .update_from(id, next)
        .ok_or_else(|| format!("{} has an incomplete update route from {}", id, version))?;
      next = &edge.target.version;
    }
    if inventory.update_from(id, current).is_some() {
      return Err("native database update continues beyond current target".into());
    }
  }
  Ok(())
}
