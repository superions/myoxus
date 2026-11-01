// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native Database decoding from an already captured, bounded YAML namespace.
use crate::template_files::{SourceBounds, decode_yaml, validate_yaml_path, verify_sha256};
use myoxus_domain::{
  database::*,
  repositories::{RepoResult, RepositoryError},
};
use serde::{Serialize, de::DeserializeOwned};
use std::collections::{BTreeMap, BTreeSet};

/// Decodes pinned definitions/updates and expands Task cores without accessing files.
/// Application admission owns endpoint/schema semantics and final-selection routes.
pub fn decode_database_template_sources(
  files: &BTreeMap<String, Vec<u8>>,
) -> RepoResult<(
  DatabaseTemplateCatalogSource,
  Vec<DatabaseTemplateDefinitionSource>,
  Vec<(DatabaseTemplateUpdateSource, DatabaseTemplateUpdateReference)>,
)> {
  decode_with_diagnostics(files, |path, message| {
    RepositoryError::Storage(format!("Database template {path}: {message}"))
  })
}

pub(super) fn decode_with_diagnostics(
  files: &BTreeMap<String, Vec<u8>>,
  error: impl Fn(&str, &str) -> RepositoryError,
) -> RepoResult<(
  DatabaseTemplateCatalogSource,
  Vec<DatabaseTemplateDefinitionSource>,
  Vec<(DatabaseTemplateUpdateSource, DatabaseTemplateUpdateReference)>,
)> {
  decode_with_core_provider(files, &error, |_, reference| {
    files
      .get(&reference.path)
      .cloned()
      .ok_or_else(|| error(&reference.path, "missing captured source"))
  })
}

/// Core resolution is byte-only: this native decoder retains sole ownership of
/// typed definition parsing, pin checks and expansion. The provider runs for
/// every reference, including references to an already decoded immutable core.
pub(crate) fn decode_database_template_sources_with_core_provider(
  files: &BTreeMap<String, Vec<u8>>,
  provider: impl FnMut(&DatabaseTemplateDefinitionSource, &DatabaseTemplateCoreReference) -> RepoResult<Vec<u8>>,
) -> RepoResult<(
  DatabaseTemplateCatalogSource,
  Vec<DatabaseTemplateDefinitionSource>,
  Vec<(DatabaseTemplateUpdateSource, DatabaseTemplateUpdateReference)>,
)> {
  decode_with_core_provider(
    files,
    |path, message| RepositoryError::Storage(format!("Database template {path}: {message}")),
    provider,
  )
}

fn decode_with_core_provider(
  files: &BTreeMap<String, Vec<u8>>,
  error: impl Fn(&str, &str) -> RepositoryError,
  mut provider: impl FnMut(&DatabaseTemplateDefinitionSource, &DatabaseTemplateCoreReference) -> RepoResult<Vec<u8>>,
) -> RepoResult<(
  DatabaseTemplateCatalogSource,
  Vec<DatabaseTemplateDefinitionSource>,
  Vec<(DatabaseTemplateUpdateSource, DatabaseTemplateUpdateReference)>,
)> {
  let mut inventory_bounds = SourceBounds::default();
  for (path, bytes) in files {
    validate_yaml_path(path)
      .and_then(|()| inventory_bounds.admit(bytes))
      .map_err(|message| error(path, &message))?;
  }
  let mut sources = NamedSources {
    files,
    bounds: SourceBounds::default(),
    diagnostic: &error,
  };
  let bytes = sources.read("catalog.yaml")?;
  let source: DatabaseTemplateCatalogSource = sources.decode("catalog.yaml", bytes)?;
  let mut definitions = Vec::new();
  let mut updates = Vec::new();
  let mut inventory_paths = files.keys().cloned().collect::<BTreeSet<_>>();
  let mut cores: BTreeMap<String, (String, DatabaseTemplateTaskCore)> = BTreeMap::new();
  let mut paths = BTreeSet::new();
  for entry in &source.templates {
    for reference in &entry.definitions {
      if !valid_version(&reference.version)
        || reference.path != format!("{}/{}.yaml", entry.id, reference.version)
        || !paths.insert(reference.path.clone())
      {
        return Err(sources.error(&reference.path, "duplicate or noncanonical immutable version path"));
      }
      let mut definition: DatabaseTemplateDefinitionSource = sources.pinned(&reference.path, &reference.sha256)?;
      if definition.id != entry.id || definition.version != reference.version {
        return Err(sources.error(&reference.path, "definition identity/version mismatch"));
      }
      let is_project = definition
        .variants
        .iter()
        .any(|variant| variant.spec.profile_kind == DatabaseProfileKind::Project);
      if is_project != definition.task_core.is_some() {
        return Err(sources.error(
          &reference.path,
          "Projects require the shared Task core; Generic starters must remain independent",
        ));
      }
      if let Some(reference) = &definition.task_core {
        if reference.id != "myoxus.project.task-core"
          || !valid_version(&reference.version)
          || reference.path != format!("{}/{}.yaml", reference.id, reference.version)
        {
          return Err(sources.error(&reference.path, "noncanonical core version path"));
        }
        validate_yaml_path(&reference.path).map_err(|message| sources.error(&reference.path, &message))?;
        let bytes = provider(&definition, reference)?;
        if inventory_paths.insert(reference.path.clone()) {
          inventory_bounds
            .admit(&bytes)
            .map_err(|message| sources.error(&reference.path, &message))?;
        }
        // Bounds and pins apply to each logical reference even when its strictly
        // decoded value is reused within this invocation.
        sources
          .bounds
          .admit(&bytes)
          .map_err(|message| sources.error(&reference.path, &message))?;
        verify_sha256(&bytes, &reference.sha256).map_err(|message| sources.error(&reference.path, &message))?;
        if let Some((digest, _)) = cores.get(&reference.path) {
          if digest != &reference.sha256 {
            return Err(sources.error(&reference.path, "SHA-256 mismatch"));
          }
        } else {
          let core = sources.decode(&reference.path, &bytes)?;
          cores.insert(reference.path.clone(), (reference.sha256.clone(), core));
        }
        let (_, core) = cores.get(&reference.path).expect("decoded pinned core");
        if core.format_version != 1 || core.id != reference.id || core.version != reference.version {
          return Err(sources.error(&reference.path, "Task core identity/version mismatch"));
        }
        for variant in &mut definition.variants {
          for field in &core.fields {
            if variant.spec.fields.iter().any(|other| other.key == field.key) {
              return Err(sources.error(&reference.path, "variant replaces a common Task field"));
            }
            variant.spec.fields.push(field.clone());
          }
          for role in &core.roles {
            if variant.spec.roles.iter().any(|other| other.role_key == role.role_key) {
              return Err(sources.error(&reference.path, "variant replaces a common Task role"));
            }
            variant.spec.roles.push(role.clone());
          }
          let mut extension_fields = BTreeSet::new();
          for extension in &variant.option_extensions {
            if !extension_fields.insert(&extension.field_key) {
              return Err(sources.error(&reference.path, "duplicate option extension"));
            }
            let field = variant
              .spec
              .fields
              .iter_mut()
              .find(|field| field.key == extension.field_key)
              .ok_or_else(|| sources.error(&reference.path, "option extension targets a missing field"))?;
            let DatabaseTemplateFieldConfig::Direct(DatabaseFieldConfig::Select(config)) = &mut field.config else {
              return Err(sources.error(&reference.path, "option extensions require a native Select field"));
            };
            for option in &extension.options {
              if config.options.iter().any(|common| common.id == option.id) {
                return Err(sources.error(&reference.path, "extension replaces a common stable option"));
              }
              config.options.push(option.clone());
            }
            let option_keys = config
              .options
              .iter()
              .map(|option| option.id.as_str())
              .collect::<BTreeSet<_>>();
            let option_order = extension
              .option_order
              .iter()
              .map(String::as_str)
              .collect::<BTreeSet<_>>();
            if option_keys != option_order
              || option_keys.len() != config.options.len()
              || option_order.len() != extension.option_order.len()
            {
              return Err(sources.error(
                &reference.path,
                "option order must preserve every common and added stable option exactly once",
              ));
            }
            config
              .options
              .sort_by_key(|option| extension.option_order.iter().position(|id| id == &option.id));
            for (position, option) in config.options.iter_mut().enumerate() {
              option.position = position as i32;
            }
          }
          let field_keys = variant
            .spec
            .fields
            .iter()
            .map(|field| field.key.as_str())
            .collect::<BTreeSet<_>>();
          let field_order = variant.field_order.iter().map(String::as_str).collect::<BTreeSet<_>>();
          let role_keys = variant
            .spec
            .roles
            .iter()
            .map(|role| role.role_key.as_str())
            .collect::<BTreeSet<_>>();
          let role_order = variant.role_order.iter().map(String::as_str).collect::<BTreeSet<_>>();
          if field_keys != field_order
            || field_keys.len() != variant.spec.fields.len()
            || field_order.len() != variant.field_order.len()
            || role_keys != role_order
            || role_keys.len() != variant.spec.roles.len()
            || role_order.len() != variant.role_order.len()
          {
            return Err(sources.error(
              &reference.path,
              "field/role order must list every stable key exactly once",
            ));
          }
          variant
            .spec
            .fields
            .sort_by_key(|field| variant.field_order.iter().position(|key| key == &field.key));
          variant
            .spec
            .roles
            .sort_by_key(|role| variant.role_order.iter().position(|key| key == &role.role_key));
        }
      }
      for variant in &definition.variants {
        let fields = variant
          .spec
          .fields
          .iter()
          .map(|field| &field.key)
          .collect::<BTreeSet<_>>();
        let field_order = variant.field_order.iter().collect::<BTreeSet<_>>();
        let roles = variant
          .spec
          .roles
          .iter()
          .map(|role| &role.role_key)
          .collect::<BTreeSet<_>>();
        let role_order = variant.role_order.iter().collect::<BTreeSet<_>>();
        if fields != field_order
          || fields.len() != variant.spec.fields.len()
          || field_order.len() != variant.field_order.len()
          || roles != role_order
          || roles.len() != variant.spec.roles.len()
          || role_order.len() != variant.role_order.len()
        {
          return Err(sources.error(
            &reference.path,
            "field/role order must list every stable key exactly once",
          ));
        }
        if !is_project && !variant.option_extensions.is_empty() {
          return Err(sources.error(&reference.path, "Generic starters cannot extend the Task core"));
        }
      }
      definitions.push(definition);
    }
    for reference in &entry.updates {
      if !valid_version(&reference.from)
        || !valid_version(&reference.to)
        || reference.path != format!("{}/updates/{}-to-{}.yaml", entry.id, reference.from, reference.to)
        || !paths.insert(reference.path.clone())
      {
        return Err(sources.error(&reference.path, "duplicate or noncanonical immutable update path"));
      }
      let update: DatabaseTemplateUpdateSource = sources.pinned(&reference.path, &reference.sha256)?;
      if update.template_id != entry.id
        || update.source.version != reference.from
        || update.target.version != reference.to
      {
        return Err(sources.error(&reference.path, "update identity/endpoints mismatch"));
      }
      updates.push((update, reference.clone()));
    }
  }
  Ok((source, definitions, updates))
}

fn valid_version(version: &str) -> bool {
  myoxus_application::database::definition::templates::compare_template_versions(version, version).is_ok()
}

struct NamedSources<'a, 'e> {
  files: &'a BTreeMap<String, Vec<u8>>,
  bounds: SourceBounds,
  diagnostic: &'e dyn Fn(&str, &str) -> RepositoryError,
}
impl<'a> NamedSources<'a, '_> {
  fn error(&self, path: &str, message: &str) -> RepositoryError {
    (self.diagnostic)(path, message)
  }
  fn read(&mut self, path: &str) -> RepoResult<&'a [u8]> {
    validate_yaml_path(path).map_err(|message| self.error(path, &message))?;
    let bytes = self
      .files
      .get(path)
      .ok_or_else(|| self.error(path, "missing captured source"))?;
    self.bounds.admit(bytes).map_err(|message| self.error(path, &message))?;
    Ok(bytes)
  }
  fn decode<T: DeserializeOwned + Serialize>(&self, path: &str, bytes: &[u8]) -> RepoResult<T> {
    decode_yaml(bytes).map_err(|message| self.error(path, &message))
  }
  fn pinned<T: DeserializeOwned + Serialize>(&mut self, path: &str, digest: &str) -> RepoResult<T> {
    let bytes = self.read(path)?;
    verify_sha256(bytes, digest).map_err(|message| self.error(path, &message))?;
    self.decode(path, bytes)
  }
}
