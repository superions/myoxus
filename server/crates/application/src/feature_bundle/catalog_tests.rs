// SPDX-License-Identifier: AGPL-3.0-or-later
//! Assembly fixtures use original native starter variants and all shipped assistants.
use super::super::release::validate_feature_release_candidate;
use super::*;
use crate::feature_bundle::{FeatureAssistantSources, FeatureDatabaseSources};

fn database(id: &str) -> (DatabaseTemplateDefinitionSource, DatabaseTemplateCatalogEntry) {
  let original: serde_json::Value = serde_json::from_str(include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../infrastructure/src/database_templates_original.json"
  )))
  .unwrap();
  let mut variants = Vec::new();
  for value in original["specs"]
    .as_array()
    .unwrap()
    .iter()
    .filter(|spec| spec["id"] == id)
  {
    let mut value = value.clone();
    for key in ["priority_preset", "complexity_preset"] {
      if value[key] == "ThreeStep" {
        value[key] = "threeStep".into();
      }
      if value[key] == "FiveStep" {
        value[key] = "fiveStep".into();
      }
    }
    let spec: DatabaseTemplateSpec = serde_json::from_value(value).unwrap();
    let tuple = DatabaseTemplateSelection {
      priority: spec.priority_preset.unwrap_or(DatabaseProjectOptionPreset::ThreeStep),
      complexity: spec.complexity_preset.unwrap_or(DatabaseProjectOptionPreset::ThreeStep),
      structure: spec
        .default_structure
        .unwrap_or(DatabaseProjectStructurePreset::TasksOnly),
    };
    if !variants.iter().any(|variant: &DatabaseTemplateVariantSource| {
      variant.priority == tuple.priority
        && variant.complexity == tuple.complexity
        && variant.structure == tuple.structure
    }) {
      variants.push(DatabaseTemplateVariantSource {
        priority: tuple.priority,
        complexity: tuple.complexity,
        structure: tuple.structure,
        option_extensions: vec![],
        field_order: vec![],
        role_order: vec![],
        spec,
      });
    }
  }
  let definition = DatabaseTemplateDefinitionSource {
    format_version: 1,
    id: id.into(),
    version: "1.0.0".into(),
    supported_predecessors: vec![],
    task_core: None,
    variants,
  };
  let authored: DatabaseTemplateCatalogSource = myoxus_contracts::config_document::decode_typed_yaml_document(
    include_str!("../../../../templates/databases/catalog.yaml"),
  )
  .unwrap();
  let mut entry = authored.templates.into_iter().find(|entry| entry.id == id).unwrap();
  entry.current = definition.version.clone();
  entry.updates.clear();
  let selections = original["inputs"]
    .as_array()
    .unwrap()
    .iter()
    .map(|input| {
      let selected = input["indices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|index| &original["specs"][index.as_u64().unwrap() as usize])
        .find(|spec| spec["id"] == id)
        .unwrap();
      let preset = |value: &serde_json::Value| match value.as_str() {
        Some("FiveStep") => DatabaseProjectOptionPreset::FiveStep,
        _ => DatabaseProjectOptionPreset::ThreeStep,
      };
      DatabaseTemplateVariantSelection {
        input: DatabaseTemplateSelection {
          priority: serde_json::from_value(input["priority"].clone()).unwrap(),
          complexity: serde_json::from_value(input["complexity"].clone()).unwrap(),
          structure: input["structure"].as_str().unwrap().parse().unwrap(),
        },
        variant: DatabaseTemplateSelection {
          priority: preset(&selected["priority_preset"]),
          complexity: preset(&selected["complexity_preset"]),
          structure: selected["default_structure"]
            .as_str()
            .map(|value| value.parse().unwrap())
            .unwrap_or(DatabaseProjectStructurePreset::TasksOnly),
        },
      }
    })
    .collect();
  entry.definitions = vec![DatabaseTemplateFileReference {
    version: definition.version.clone(),
    path: format!("{id}/1.0.0.yaml"),
    sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(&definition).unwrap())),
    selections,
  }];
  (definition, entry)
}
fn bundle(id: &str, version: &str, base: bool, include_assets: bool) -> CapturedFeatureBundle {
  let authored: DatabaseTemplateCatalogSource = myoxus_contracts::config_document::decode_typed_yaml_document(
    include_str!("../../../../templates/databases/catalog.yaml"),
  )
  .unwrap();
  let pairs = authored
    .templates
    .iter()
    .filter(|entry| {
      if base {
        include_assets || entry.id != "myoxus.database.inventory_assets"
      } else {
        entry.id == "myoxus.database.inventory_assets"
      }
    })
    .map(|entry| database(&entry.id))
    .collect::<Vec<_>>();
  let sources = FeatureDatabaseSources {
    updates: vec![],
    catalog: DatabaseTemplateCatalogSource {
      format_version: 1,
      templates: pairs.iter().map(|(_, entry)| entry.clone()).collect(),
      system_sources: if base { authored.system_sources } else { vec![] },
    },
    definitions: pairs.into_iter().map(|(definition, _)| definition).collect(),
  };
  let mut files = BTreeMap::from([(
    "databases/catalog.yaml".into(),
    serde_json::to_vec(&sources.catalog).unwrap(),
  )]);
  for definition in &sources.definitions {
    files.insert(
      format!("databases/{}/{}.yaml", definition.id, definition.version),
      serde_json::to_vec(definition).unwrap(),
    );
  }
  let mut components = vec![FeatureComponent {
    id: "databases".into(),
    kind: FeatureComponentKind::DatabaseCatalog,
    path: "databases/catalog.yaml".into(),
    sha256: format!("{:x}", Sha256::digest(&files["databases/catalog.yaml"])),
    native_identity: None,
    artwork: None,
  }];
  let mut exports = sources
    .catalog
    .templates
    .iter()
    .filter(|entry| entry.offering == Some(true))
    .map(|entry| FeatureExport {
      id: entry.id.clone(),
      source: FeatureNativeReference {
        component: "databases".into(),
        export: format!("{}@{}", entry.id, entry.current),
        key: None,
      },
      contexts: vec![],
      document: None,
    })
    .collect::<Vec<_>>();
  let mut assistants = BTreeMap::new();
  let mut links = Vec::new();
  if base {
    let catalog: AssistantPackageCatalogSource = myoxus_contracts::config_document::decode_typed_yaml_document(
      include_str!("../../../../templates/assistants/catalog.yaml"),
    )
    .unwrap();
    files.insert("assistants/catalog.yaml".into(), serde_json::to_vec(&catalog).unwrap());
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/assistants");
    let mut definitions = Vec::new();
    for entry in &catalog.packages {
      for reference in &entry.definitions {
        let bytes = std::fs::read(root.join(&reference.path)).unwrap();
        assert_eq!(
          format!("{:x}", Sha256::digest(&bytes)),
          reference.sha256,
          "real source pin"
        );
        let package: AssistantPackageSource =
          myoxus_contracts::config_document::decode_typed_yaml_document(std::str::from_utf8(&bytes).unwrap()).unwrap();
        files.insert(format!("assistants/{}", reference.path), bytes);
        if package.version == entry.current {
          exports.push(FeatureExport {
            id: entry.id.clone(),
            source: FeatureNativeReference {
              component: "assistants".into(),
              export: format!("{}@{}", entry.id, entry.current),
              key: None,
            },
            contexts: package.contexts.clone(),
            document: None,
          });
          for component in &package.components {
            if let AssistantNativeAction::CreateProject { template_id, .. } = &component.action {
              let target = sources
                .catalog
                .templates
                .iter()
                .find(|target| target.id == *template_id)
                .unwrap();
              links.push(FeatureLink::Schema {
                from: FeatureNativeReference {
                  component: "assistants".into(),
                  export: format!("{}@{}", package.id, package.version),
                  key: Some(format!("component/{}", component.id)),
                },
                to: FeatureReference::Local {
                  reference: FeatureNativeReference {
                    component: "databases".into(),
                    export: format!("{}@{}", target.id, target.current),
                    key: None,
                  },
                },
              });
            }
          }
        }
        definitions.push((package, reference.sha256.clone()));
      }
    }
    components.push(FeatureComponent {
      id: "assistants".into(),
      kind: FeatureComponentKind::AssistantCatalog,
      path: "assistants/catalog.yaml".into(),
      sha256: format!("{:x}", Sha256::digest(&files["assistants/catalog.yaml"])),
      native_identity: None,
      artwork: None,
    });
    // The real current assistants now include optional native document
    // children. Preserve their genuine authored links and archive closure.
    let authored: FeatureBundleSource = myoxus_contracts::config_document::decode_typed_yaml_document(include_str!(
      "../../../../templates/features/base/manifest.yaml"
    ))
    .unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates");
    for link in &authored.links {
      let FeatureLink::DocumentComponent {
        from,
        to: FeatureReference::Local { reference },
      } = link
      else {
        continue;
      };
      if !definitions
        .iter()
        .any(|(source, _)| from.export == format!("{}@{}", source.id, source.version))
      {
        continue;
      }
      if !components.iter().any(|component| component.id == reference.component) {
        let declared = authored
          .components
          .iter()
          .find(|component| component.id == reference.component)
          .unwrap();
        let bytes = std::fs::read(root.join(&declared.path)).unwrap();
        let (native_id, native_version) = reference.export.rsplit_once('@').unwrap();
        components.push(FeatureComponent {
          id: declared.id.clone(),
          kind: declared.kind,
          path: declared.path.clone(),
          sha256: format!("{:x}", Sha256::digest(&bytes)),
          native_identity: Some(FeatureBundleIdentity {
            id: native_id.into(),
            version: native_version.into(),
          }),
          artwork: declared.artwork.clone(),
        });
        files.insert(declared.path.clone(), bytes);
        // Historical children retain their exact bytes and links without
        // becoming current offerings. Only authored current exports activate.
        if let Some(export) = authored.exports.iter().find(|export| export.source == *reference) {
          exports.push(export.clone());
        }
      }
      links.push(link.clone());
    }
    links.extend(
      authored
        .links
        .iter()
        .filter(|link| {
          let from = match link {
            FeatureLink::Input { from, .. } | FeatureLink::Context { from, .. } => from,
            _ => return false,
          };
          from.component == "assistants"
            && definitions
              .iter()
              .any(|(source, _)| from.export == format!("{}@{}", source.id, source.version))
        })
        .cloned(),
    );
    assistants.insert("assistants".into(), FeatureAssistantSources { catalog, definitions });
  }
  let manifest = FeatureBundleManifest {
    format_version: 1,
    id: id.into(),
    version: version.into(),
    capabilities: if base {
      BTreeMap::from([
        ("database".into(), 1),
        ("assistant".into(), 1),
        ("documentTemplate".into(), 1),
      ])
    } else {
      BTreeMap::from([("database".into(), 1)])
    },
    components,
    files: files
      .iter()
      .map(|(path, bytes)| (path.clone(), format!("{:x}", Sha256::digest(bytes))))
      .collect(),
    links,
    exports,
  };
  // The archive reader owns ZIP decoding; these deterministic captured fixtures
  // qualify native composition against real source bytes and original states.
  let archive_bytes = serde_json::to_vec(&manifest).unwrap();
  CapturedFeatureBundle {
    manifest,
    archive_sha256: format!("{:x}", Sha256::digest(&archive_bytes)),
    archive_bytes,
    files,
    databases: BTreeMap::from([("databases".into(), sources)]),
    assistants,
    workflows: BTreeMap::new(),
  }
}
fn source(
  base: &CapturedFeatureBundle,
  optional: &[CapturedFeatureBundle],
  retained: &[CapturedFeatureBundle],
) -> (FeatureReleaseDescriptor, FeatureBundleCatalogSource) {
  (
    FeatureReleaseDescriptor {
      format_version: 1,
      base: base.pin(),
    },
    FeatureBundleCatalogSource {
      format_version: 1,
      base: base.pin(),
      optional: optional.iter().map(CapturedFeatureBundle::pin).collect(),
      retained: retained.iter().map(CapturedFeatureBundle::pin).collect(),
    },
  )
}

fn refresh(bundle: &mut CapturedFeatureBundle) {
  for (component, sources) in &bundle.databases {
    let catalog = bundle
      .manifest
      .components
      .iter()
      .find(|item| item.id == *component)
      .unwrap();
    bundle
      .files
      .insert(catalog.path.clone(), serde_json::to_vec(&sources.catalog).unwrap());
    let prefix = catalog.path.strip_suffix("catalog.yaml").unwrap();
    for definition in &sources.definitions {
      let reference = sources
        .catalog
        .templates
        .iter()
        .find(|entry| entry.id == definition.id)
        .unwrap()
        .definitions
        .iter()
        .find(|reference| reference.version == definition.version)
        .unwrap();
      bundle.files.insert(
        format!("{prefix}{}", reference.path),
        serde_json::to_vec(definition).unwrap(),
      );
    }
  }
  for (component, sources) in &bundle.databases {
    let catalog = bundle
      .manifest
      .components
      .iter()
      .find(|item| item.id == *component)
      .unwrap();
    let prefix = catalog.path.strip_suffix("catalog.yaml").unwrap();
    for (source, reference) in &sources.updates {
      bundle.files.insert(
        format!("{prefix}{}", reference.path),
        serde_json::to_vec(source).unwrap(),
      );
    }
  }
  for (component, sources) in &bundle.assistants {
    let catalog = bundle
      .manifest
      .components
      .iter()
      .find(|item| item.id == *component)
      .unwrap();
    let prefix = catalog.path.strip_suffix("catalog.yaml").unwrap();
    bundle
      .files
      .insert(catalog.path.clone(), serde_json::to_vec(&sources.catalog).unwrap());
    for (source, _) in &sources.definitions {
      let reference = sources
        .catalog
        .packages
        .iter()
        .find(|entry| entry.id == source.id)
        .unwrap()
        .definitions
        .iter()
        .find(|reference| reference.version == source.version)
        .unwrap();
      bundle.files.insert(
        format!("{prefix}{}", reference.path),
        serde_json::to_vec(source).unwrap(),
      );
    }
  }
  for component in &mut bundle.manifest.components {
    component.sha256 = format!("{:x}", Sha256::digest(&bundle.files[&component.path]));
  }
  bundle.manifest.files = bundle
    .files
    .iter()
    .map(|(path, bytes)| (path.clone(), format!("{:x}", Sha256::digest(bytes))))
    .collect();
  bundle.archive_bytes = serde_json::to_vec(&bundle.manifest).unwrap();
  bundle.archive_sha256 = format!("{:x}", Sha256::digest(&bundle.archive_bytes));
}

fn offered_ids(bundle: &CapturedFeatureBundle) -> Vec<String> {
  bundle.databases["databases"]
    .catalog
    .templates
    .iter()
    .filter(|entry| entry.offering == Some(true))
    .map(|entry| entry.id.clone())
    .collect()
}
#[test]
fn explicit_base_optional_and_retained_frames_have_distinct_native_selection() {
  let old = bundle("platform", "1.0.0", true, true);
  let current = bundle("platform", "1.1.0", true, false);
  let (release, catalog) = source(&current, &[], std::slice::from_ref(&old));
  let resolved = assemble_feature_catalogs(&release, &catalog, &[old.clone(), current.clone()]).unwrap();
  assert_eq!(
    resolved
      .databases
      .summaries()
      .iter()
      .map(|source| source.id.clone())
      .collect::<Vec<_>>(),
    offered_ids(&current)
  );
  assert!(
    resolved
      .databases
      .version_source("myoxus.database.inventory_assets", "1.0.0")
      .is_some()
  );
  assert!(
    resolved
      .databases
      .current_source("myoxus.database.inventory_assets")
      .is_none()
  );
  let sources = &current.assistants["assistants"];
  let optional_context = AssistantPackageContext::TaskContainerAssistance;
  // A different native source may legitimately offer this context. Protect
  // each disabled identity below rather than assuming the whole context empty.
  assert_eq!(
    resolved
      .assistants
      .list(optional_context)
      .into_iter()
      .map(|descriptor| descriptor.identity.id)
      .collect::<Vec<_>>(),
    vec!["myoxus.assistant.document-review"]
  );
  assert_eq!(
    resolved
      .assistants
      .default_descriptor(optional_context)
      .unwrap()
      .identity
      .id,
    "myoxus.assistant.document-review"
  );
  for entry in sources.catalog.packages.iter().filter(|entry| !entry.enabled) {
    let identity = AssistantPackageIdentity {
      id: entry.id.clone(),
      version: entry.current.clone(),
      digest: entry
        .definitions
        .iter()
        .find(|reference| reference.version == entry.current)
        .unwrap()
        .sha256
        .clone(),
    };
    let retained = resolved.assistants.inventory().get(&identity).unwrap();
    for context in &retained.contexts {
      assert!(resolved.assistants.current_descriptor(&entry.id, *context).is_none());
      assert!(resolved.assistants.offered_source(&identity, *context).is_err());
    }
  }
  // Feature exports cannot activate a disabled source or replace the selected
  // default. Reassignment remains an explicit native-catalog choice.
  let mut reactivated = sources.catalog.packages.clone();
  for entry in reactivated.iter_mut().filter(|entry| entry.enabled) {
    entry.default_for.retain(|context| *context != optional_context);
  }
  let entry = reactivated
    .iter_mut()
    .find(|entry| !entry.enabled && entry.default_for.contains(&optional_context))
    .unwrap();
  entry.enabled = true;
  let reactivated_id = entry.id.clone();
  let restored =
    AssistantPackageCatalog::from_inventory(reactivated.clone(), resolved.assistants.inventory().clone()).unwrap();
  let descriptor = restored.default_descriptor(optional_context).unwrap();
  assert_eq!(descriptor.identity.id, reactivated_id);
  assert!(restored.offered_source(&descriptor.identity, optional_context).is_ok());
  reactivated
    .iter_mut()
    .find(|entry| entry.id == reactivated_id)
    .unwrap()
    .default_for
    .clear();
  assert!(AssistantPackageCatalog::from_inventory(reactivated, resolved.assistants.inventory().clone()).is_err());
  let workspace_offerings = sources
    .catalog
    .packages
    .iter()
    .filter(|entry| {
      entry.enabled
        && sources.definitions.iter().any(|(source, _)| {
          source.id == entry.id
            && source.version == entry.current
            && source.contexts.contains(&AssistantPackageContext::WorkspaceCreation)
        })
    })
    .map(|entry| entry.id.as_str())
    .collect::<Vec<_>>();
  assert_eq!(
    resolved
      .assistants
      .list(AssistantPackageContext::WorkspaceCreation)
      .iter()
      .map(|descriptor| descriptor.identity.id.as_str())
      .collect::<Vec<_>>(),
    workspace_offerings
  );
  let (old_release, old_catalog) = source(&old, &[], &[]);
  validate_feature_release_candidate(
    &release,
    &catalog,
    &[current.clone(), old.clone()],
    Some((&old_release, &old_catalog, std::slice::from_ref(&old))),
  )
  .unwrap();

  let extension = bundle("extension", "1.0.0", false, false);
  let (release, catalog) = source(&current, std::slice::from_ref(&extension), &[]);
  let resolved = assemble_feature_catalogs(&release, &catalog, &[extension.clone(), current.clone()]).unwrap();
  assert_eq!(resolved.active, vec![current.pin(), extension.pin()]);
  assert_eq!(
    resolved
      .databases
      .summaries()
      .iter()
      .map(|source| source.id.clone())
      .collect::<Vec<_>>(),
    offered_ids(&current)
      .into_iter()
      .chain(offered_ids(&extension))
      .collect::<Vec<_>>()
  );
  validate_feature_native_sources(&extension, &[]).unwrap();
  // A release refresh consumes the same explicit preparation owner as delivery:
  // source defaults/offerings replace the base, installed extension pins remain.
  let mut next = bundle("platform", "1.2.0", true, false);
  let sources = next.assistants.get("assistants").unwrap();
  let retired = sources
    .catalog
    .packages
    .iter()
    .find(|entry| {
      !entry.default_for.contains(&AssistantPackageContext::ProjectCreation)
        && sources.definitions.iter().any(|(package, _)| {
          package.id == entry.id && package.contexts.contains(&AssistantPackageContext::ProjectCreation)
        })
    })
    .unwrap()
    .clone();
  let replacement = sources
    .catalog
    .packages
    .iter()
    .find(|entry| {
      entry.id != retired.id
        && !entry.default_for.contains(&AssistantPackageContext::ProjectCreation)
        && sources.definitions.iter().any(|(package, _)| {
          package.id == entry.id && package.contexts.contains(&AssistantPackageContext::ProjectCreation)
        })
    })
    .unwrap()
    .id
    .clone();
  let retired_template = sources
    .definitions
    .iter()
    .find(|(package, _)| package.id == retired.id && package.version == retired.current)
    .unwrap()
    .0
    .components
    .iter()
    .find_map(|component| match &component.action {
      AssistantNativeAction::CreateProject { template_id, .. } => Some(template_id.clone()),
      _ => None,
    })
    .unwrap();
  let sources = next.assistants.get_mut("assistants").unwrap();
  sources.catalog.packages.retain(|entry| entry.id != retired.id);
  sources.definitions.retain(|(package, _)| package.id != retired.id);
  for entry in &mut sources.catalog.packages {
    entry
      .default_for
      .retain(|context| *context != AssistantPackageContext::ProjectCreation);
    if entry.id == replacement {
      entry.default_for.push(AssistantPackageContext::ProjectCreation);
    }
  }
  for reference in &retired.definitions {
    next.files.remove(&format!("assistants/{}", reference.path));
  }
  next
    .databases
    .get_mut("databases")
    .unwrap()
    .catalog
    .templates
    .iter_mut()
    .find(|entry| entry.id == retired_template)
    .unwrap()
    .offering = Some(false);
  next.manifest.exports.retain(|export| {
    !(export.source.component == "assistants" && export.source.export.starts_with(&format!("{}@", retired.id)))
      && !(export.source.component == "databases" && export.source.export.starts_with(&format!("{retired_template}@")))
  });
  next.manifest.links.retain(|link| match link {
    FeatureLink::Schema { from, .. }
    | FeatureLink::View { from, .. }
    | FeatureLink::Artwork { from, .. }
    | FeatureLink::DocumentComponent { from, .. }
    | FeatureLink::DocumentSource { from, .. }
    | FeatureLink::Input { from, .. }
    | FeatureLink::Context { from, .. } => {
      !(from.component == "assistants" && from.export.starts_with(&format!("{}@", retired.id)))
    }
    _ => true,
  });
  // Refresh selection bytes only; native bodies/digests remain untouched.
  next.files.insert(
    "databases/catalog.yaml".into(),
    serde_json::to_vec(&next.databases["databases"].catalog).unwrap(),
  );
  next.files.insert(
    "assistants/catalog.yaml".into(),
    serde_json::to_vec(&next.assistants["assistants"].catalog).unwrap(),
  );
  for component in &mut next.manifest.components {
    component.sha256 = format!("{:x}", Sha256::digest(&next.files[&component.path]));
  }
  next.manifest.files = next
    .files
    .iter()
    .map(|(path, bytes)| (path.clone(), format!("{:x}", Sha256::digest(bytes))))
    .collect();
  next.archive_bytes = serde_json::to_vec(&next.manifest).unwrap();
  next.archive_sha256 = format!("{:x}", Sha256::digest(&next.archive_bytes));
  let (installed_release, installed_catalog) = source(&current, std::slice::from_ref(&extension), &[]);
  let (next_release, source_catalog) = source(&next, &[], &[]);
  let promoted = crate::feature_bundle::prepare_feature_release_catalog(
    &next_release,
    &source_catalog,
    Some(&installed_catalog),
    None,
  )
  .unwrap();
  assert_eq!(promoted.optional, installed_catalog.optional);
  let extension_bytes = extension.archive_bytes.clone();
  let captures = vec![next.clone(), extension.clone()];
  let admitted = validate_feature_release_candidate(
    &next_release,
    &promoted,
    &captures,
    Some((
      &installed_release,
      &installed_catalog,
      &[current.clone(), extension.clone()],
    )),
  )
  .unwrap();
  assert_eq!(admitted.active, vec![next.pin(), extension.pin()]);
  assert_eq!(captures[1].archive_bytes, extension_bytes);
  assert_eq!(
    admitted
      .assistants
      .default_descriptor(AssistantPackageContext::ProjectCreation)
      .unwrap()
      .identity
      .id,
    replacement
  );
  assert!(
    !admitted
      .assistants
      .list(AssistantPackageContext::ProjectCreation)
      .iter()
      .any(|package| package.identity.id == retired.id)
  );
  assert!(
    !admitted
      .databases
      .summaries()
      .iter()
      .any(|template| template.id == retired_template)
  );
  assert!(admitted.databases.current_source(&retired_template).is_some());
  assert!(admitted.databases.version_source(&retired_template, "1.0.0").is_some());
  for (path, bytes) in &next.files {
    if path != "databases/catalog.yaml" && path != "assistants/catalog.yaml" {
      assert_eq!(
        bytes, &current.files[path],
        "selection-only release changed a native child"
      );
    }
  }
}

#[test]
fn wrong_base_duplicate_provider_shadow_and_unexported_offering_fail_closed() {
  let base = bundle("platform", "1.0.0", true, false);
  let (release, mut catalog) = source(&base, &[], &[]);
  catalog.base.sha256 = "a".repeat(64);
  assert!(
    assemble_feature_catalogs(&release, &catalog, std::slice::from_ref(&base))
      .unwrap_err()
      .contains("exact bounded mandatory base")
  );
  let (_, mut catalog) = source(&base, &[], &[]);
  catalog.optional.push(base.pin());
  assert!(
    assemble_feature_catalogs(&release, &catalog, std::slice::from_ref(&base))
      .unwrap_err()
      .contains("duplicate active base")
  );
  let mut shadow = bundle("extension", "1.0.0", true, false);
  shadow
    .databases
    .get_mut("databases")
    .unwrap()
    .catalog
    .system_sources
    .clear();
  refresh(&mut shadow);
  let (release, catalog) = source(&base, std::slice::from_ref(&shadow), &[]);
  assert!(
    assemble_feature_catalogs(&release, &catalog, &[base.clone(), shadow])
      .unwrap_err()
      .contains("duplicate active native provider")
  );
  let mut missing = base.clone();
  missing.manifest.exports.clear();
  assert!(
    validate_feature_native_sources(&missing, &[])
      .unwrap_err()
      .contains("lacks Feature export")
  );
}

#[test]
fn release_rejects_same_version_rewrite() {
  let old = bundle("platform", "1.0.0", true, false);
  let (old_release, old_catalog) = source(&old, &[], &[]);
  let changed = bundle("platform", "1.0.0", true, true);
  let (release, catalog) = source(&changed, &[], &[]);
  assert!(
    validate_feature_release_candidate(
      &release,
      &catalog,
      std::slice::from_ref(&changed),
      Some((&old_release, &old_catalog, std::slice::from_ref(&old)))
    )
    .unwrap_err()
    .contains("immutable Feature archive changed")
  );
}
