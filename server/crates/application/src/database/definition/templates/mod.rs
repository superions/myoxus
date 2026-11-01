// SPDX-License-Identifier: AGPL-3.0-or-later
//! One admitted immutable source, native materializer and validation boundary.
use super::*;
mod catalog;
mod materialize;
mod validation;
pub use catalog::{
  DatabaseStarterTemplateCatalog, DatabaseStarterTemplateSource, DatabaseTemplateCatalogSelection,
  DatabaseTemplateCurrentTarget, DatabaseTemplateInventory, DatabaseTemplateOffering,
};
pub use materialize::materialize_template;
#[cfg(test)]
use materialize::{apply_currency, build_view_config};
#[cfg(test)]
use serde_json::json;
pub use validation::{
  validate_database_template_definition, validate_database_template_selection, validate_database_template_update,
};

/// Immutable source promotion uses the same semantic-version parser as native
/// catalog admission; prerelease precedence must not become a second policy.
pub fn compare_template_versions(left: &str, right: &str) -> Result<std::cmp::Ordering, String> {
  let parse = |value| semver::Version::parse(value).map_err(|_| "invalid native source semantic version".to_string());
  Ok(parse(left)?.cmp(&parse(right)?))
}

#[cfg(test)]
const TEMPLATE_BLANK_DATABASE: &str = "myoxus.database.blank";
#[cfg(test)]
const TEMPLATE_SIMPLE_TASK_LIST: &str = "myoxus.database.simple_task_list";
#[cfg(test)]
const TEMPLATE_SIMPLE_PROJECT: &str = "myoxus.project.simple_project";
#[cfg(test)]
const TEMPLATE_PRODUCT_ROADMAP: &str = "myoxus.project.product_roadmap";
#[cfg(test)]
const TEMPLATE_CONTENT_CALENDAR: &str = "myoxus.database.content_calendar";
#[cfg(test)]
const TEMPLATE_CRM_CONTACTS: &str = "myoxus.database.crm_contacts";
#[cfg(test)]
const TEMPLATE_INVENTORY_ASSETS: &str = "myoxus.database.inventory_assets";
#[cfg(test)]
const TEMPLATE_BUG_TRACKER: &str = "myoxus.project.bug_tracker";
#[cfg(test)]
const TEMPLATE_RESEARCH_INDEX: &str = "myoxus.database.research_index";

#[derive(Debug, Clone)]
pub struct DatabaseStarterTemplateSummary {
  pub id: String,
  pub version: String,
  pub digest: String,
  pub default_variant: DatabaseTemplateSelection,
  pub selections: Vec<DatabaseTemplateVariantSelection>,
  pub name: String,
  pub name_key: String,
  pub description: String,
  pub description_key: String,
  pub category: DatabaseStarterTemplateCategory,
  pub profile_kind: DatabaseProfileKind,
  pub default_view_kinds: Vec<DatabaseViewKind>,
  pub sample_row_count: usize,
  pub import_mappings: Vec<DatabaseStarterTemplateImportMappingManifest>,
}

impl DatabaseDefinitionService {
  /// A retained Generic source creates an independent copy; its creation pin
  /// remains on the setup receipt and is never an installation on the Database.
  pub(crate) async fn materialize_workspace_generic(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    plan: &myoxus_domain::assistant_package::AssistantPreparedGenericDefinition,
    reserved_id: DatabaseId,
  ) -> DatabaseResult<DatabaseInitialState> {
    self.validate_database_creation(actor, workspace, &plan.title).await?;
    let (_, digest) = self
      .starter_templates
      .inventory()
      .version_source(&plan.definition_id, &plan.version)
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "accepted Generic source unavailable"))?;
    let template = self
      .starter_templates
      .select_version(&plan.definition_id, &plan.version, plan.selection)
      .filter(|source| source.profile_kind == DatabaseProfileKind::Generic)
      .filter(|_| digest == plan.digest)
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "accepted Generic source unavailable"))?;
    materialize::materialize_template_reserved(
      &self.limits,
      actor,
      workspace,
      &plan.title,
      plan.description.clone(),
      plan.include_sample_rows,
      &plan.default_currency,
      template.clone(),
      reserved_id,
      &[],
    )
  }
  /// Internal accepted-receipt path: current native definition, reserved result
  /// identities and the same materializer. It never accepts a requested schema.
  pub(crate) async fn materialize_accepted_project(
    &self,
    accepted: &crate::workspace::AcceptedProjectStarter,
    review: &myoxus_domain::assistant_package::AssistantPreparedProject,
  ) -> DatabaseResult<DatabaseInitialState> {
    if accepted.actor_id != review.actor_id
      || Some(accepted.workspace_id) != review.workspace_id
      || accepted.plan.package != review.package
      || accepted.plan.component_id != review.component_id
    {
      return Err(DatabaseServiceError::new(
        ERR_FORBIDDEN,
        "accepted Project scope mismatch",
      ));
    }
    self
      .validate_database_creation(review.actor_id, accepted.workspace_id, &review.title)
      .await?;
    let selection = DatabaseTemplateSelection {
      priority: review.priority,
      complexity: review.complexity,
      structure: review.structure,
    };
    let template = self
      .starter_templates
      .select_selection(&review.template_id, selection)
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "current managed Project source unavailable"))?
      .clone();
    let mut scaffold = Vec::new();
    for row in &review.setup.scaffold {
      let id = *accepted
        .ids
        .scaffold_rows
        .get(&row.id)
        .ok_or_else(|| DatabaseServiceError::new(ERR_ROW_INVALID, "review changes reserved scaffold effects"))?;
      let kind = match row.kind {
        myoxus_domain::assistant_package::AssistantProjectScaffoldKind::Phase => DatabaseRowKind::Phase,
        myoxus_domain::assistant_package::AssistantProjectScaffoldKind::Milestone => DatabaseRowKind::Milestone,
      };
      let title = match review.locale.as_str() {
        "de" => &row.title.de,
        "fr" => &row.title.fr,
        "es" => &row.title.es,
        _ => &row.title.en,
      };
      scaffold.push((id, kind, title.clone()));
    }
    if scaffold.len() != accepted.ids.scaffold_rows.len() {
      return Err(DatabaseServiceError::new(
        ERR_ROW_INVALID,
        "review changes reserved scaffold effects",
      ));
    }
    let mut state = materialize::materialize_template_reserved(
      &self.limits,
      review.actor_id,
      accepted.workspace_id,
      &review.title,
      review.description.clone(),
      review.include_sample_rows,
      &review.default_currency,
      template,
      accepted.ids.database_id,
      &scaffold,
    )?;
    managed_schema::install_source_metadata(&self.starter_templates, &review.template_id, &mut state)?;
    Ok(state)
  }
  pub fn list_starter_templates(&self) -> Vec<DatabaseStarterTemplateSummary> {
    self.starter_templates.summaries()
  }

  #[tracing::instrument(skip(self,input),fields(workspace_id=%input.workspace_id,template_id=%input.template_id,actor=%actor))]
  pub async fn create_database_from_template(
    &self,
    actor: UserId,
    input: CreateDatabaseFromTemplate,
  ) -> DatabaseResult<DatabaseRecord> {
    access::assert_workspace(&self.permission, actor, input.workspace_id, WorkspaceAction::CreateDoc).await?;
    let title = rules::validate_title(&input.title)?;
    let currency =
      normalize_database_currency_code(&input.default_currency).unwrap_or_else(default_database_currency_code);
    let template = self
      .starter_templates
      .select_offering(
        &input.template_id,
        DatabaseTemplateSelection {
          priority: input.priority_preset,
          complexity: input.complexity_preset,
          structure: input.structure_preset,
        },
      )
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "database starter template not found"))?
      .clone();
    let mut state = materialize_template(
      &self.limits,
      actor,
      input.workspace_id,
      &title,
      input.description,
      input.include_sample_rows,
      &currency,
      template,
    )?;
    managed_schema::install_source_metadata(&self.starter_templates, &input.template_id, &mut state)?;
    self.schema_repo.create_database(state).await.map_err(Into::into)
  }
}

#[cfg(test)]
fn starter_template_i18n_key(template_id: &str, field: &str) -> String {
  let local_id = template_id
    .strip_prefix("myoxus.")
    .unwrap_or(template_id)
    .replace(['.', '_'], "-");
  format!("com.myoxus.database.starter-template.{local_id}.{field}")
}

#[cfg(test)]
mod tests {

  use std::collections::BTreeSet;

  use crate::database::DatabaseLimits;

  use super::*;

  fn starter_template_specs(
    priority: DatabaseProjectOptionPreset,
    complexity: DatabaseProjectOptionPreset,
    structure: DatabaseProjectStructurePreset,
    currency: &str,
  ) -> Vec<DatabaseTemplateSpec> {
    let source: serde_json::Value = serde_json::from_str(include_str!(concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/../infrastructure/src/database_templates_original.json"
    )))
    .unwrap();
    let input = source["inputs"]
      .as_array()
      .unwrap()
      .iter()
      .find(|input| {
        input["priority"] == priority.as_str()
          && input["complexity"] == complexity.as_str()
          && input["structure"] == structure.as_str()
      })
      .unwrap();
    input["indices"]
      .as_array()
      .unwrap()
      .iter()
      .map(|index| {
        let mut value = source["specs"][index.as_u64().unwrap() as usize].clone();
        for property in ["priority_preset", "complexity_preset"] {
          if let Some(preset) = value[property].as_str() {
            value[property] = serde_json::json!(match preset {
              "ThreeStep" => "threeStep",
              "FiveStep" => "fiveStep",
              other => panic!("unexpected original preset {other}"),
            });
          }
        }
        let mut spec: DatabaseTemplateSpec = serde_json::from_value(value).unwrap();
        apply_currency(&mut spec, currency);
        spec
      })
      .collect()
  }
  fn fixture_template(id: &str) -> DatabaseTemplateSpec {
    starter_template_specs(
      DatabaseProjectOptionPreset::ThreeStep,
      DatabaseProjectOptionPreset::ThreeStep,
      DatabaseProjectStructurePreset::Phases,
      "EUR",
    )
    .into_iter()
    .find(|spec| spec.id == id)
    .unwrap()
  }
  fn fixture_project(
    priority: DatabaseProjectOptionPreset,
    complexity: DatabaseProjectOptionPreset,
    structure: DatabaseProjectStructurePreset,
  ) -> DatabaseTemplateSpec {
    starter_template_specs(priority, complexity, structure, "EUR")
      .into_iter()
      .find(|spec| spec.id == TEMPLATE_SIMPLE_PROJECT)
      .unwrap()
  }

  #[test]
  fn built_in_catalog_contains_all_required_starter_templates() {
    let templates = starter_template_specs(
      DatabaseProjectOptionPreset::ThreeStep,
      DatabaseProjectOptionPreset::ThreeStep,
      DatabaseProjectStructurePreset::Phases,
      "EUR",
    );
    let ids = templates
      .iter()
      .map(|template| template.id.as_str())
      .collect::<BTreeSet<_>>();
    assert_eq!(templates.len(), 9);
    assert_eq!(
      ids,
      BTreeSet::from([
        TEMPLATE_BLANK_DATABASE,
        TEMPLATE_SIMPLE_TASK_LIST,
        TEMPLATE_SIMPLE_PROJECT,
        TEMPLATE_PRODUCT_ROADMAP,
        TEMPLATE_CONTENT_CALENDAR,
        TEMPLATE_CRM_CONTACTS,
        TEMPLATE_INVENTORY_ASSETS,
        TEMPLATE_BUG_TRACKER,
        TEMPLATE_RESEARCH_INDEX,
      ])
    );
  }

  #[test]
  fn starter_template_summaries_expose_stable_i18n_keys() {
    let templates = starter_template_specs(
      DatabaseProjectOptionPreset::ThreeStep,
      DatabaseProjectOptionPreset::ThreeStep,
      DatabaseProjectStructurePreset::Phases,
      "EUR",
    );
    for template in templates {
      let name_key = starter_template_i18n_key(&template.id, "name");
      let description_key = starter_template_i18n_key(&template.id, "description");
      assert!(
        name_key.starts_with("com.myoxus.database.starter-template."),
        "{} must expose a product i18n name key",
        template.id
      );
      assert!(
        name_key.ends_with(".name"),
        "{} name key must identify the name field",
        template.id
      );
      assert!(
        description_key.ends_with(".description"),
        "{} description key must identify the description field",
        template.id
      );
      assert!(
        !name_key.contains('_') && !description_key.contains('_'),
        "{} i18n keys must be stable kebab-case resource keys",
        template.id
      );
    }
  }

  #[test]
  fn starter_template_specs_are_valid_domain_manifests() {
    let templates = starter_template_specs(
      DatabaseProjectOptionPreset::FiveStep,
      DatabaseProjectOptionPreset::FiveStep,
      DatabaseProjectStructurePreset::PhasesAndMilestones,
      "USD",
    );
    for template in templates {
      let manifest = template.to_manifest().expect("fixture manifest");
      manifest.validate().unwrap_or_else(|error| {
        panic!(
          "{} must satisfy the starter-template manifest contract: {error}",
          template.id
        )
      });
      assert_eq!(manifest.schema_version, DATABASE_STARTER_TEMPLATE_SCHEMA_VERSION);
      assert_eq!(manifest.id, template.id);
      assert_eq!(manifest.fields.len(), template.fields.len());
      assert_eq!(manifest.views.len(), template.views.len());
      assert_eq!(manifest.sample_rows.len(), template.sample_rows.len());
      assert_eq!(manifest.import_mappings.len(), 1);
      assert_eq!(manifest.import_mappings[0].key, "default-csv");
      assert_eq!(manifest.import_mappings[0].column_mappings.len(), template.fields.len());
    }
  }

  fn project_manifest(structure: DatabaseProjectStructurePreset) -> DatabaseStarterTemplateManifest {
    fixture_project(
      DatabaseProjectOptionPreset::ThreeStep,
      DatabaseProjectOptionPreset::FiveStep,
      structure,
    )
    .to_manifest()
    .expect("fixture manifest")
  }

  #[test]
  fn project_manifests_match_the_exact_semantic_catalog_for_every_structure() {
    for structure in [
      DatabaseProjectStructurePreset::TasksOnly,
      DatabaseProjectStructurePreset::Phases,
      DatabaseProjectStructurePreset::Milestones,
      DatabaseProjectStructurePreset::PhasesAndMilestones,
    ] {
      let manifest = project_manifest(structure);
      manifest
        .validate_project_contract()
        .unwrap_or_else(|error| panic!("{structure:?} Project contract must be valid: {error}"));

      let expected_roles = DATABASE_PROJECT_SEMANTIC_CATALOG
        .iter()
        .filter(|role| role.applies_to(structure))
        .collect::<Vec<_>>();
      assert_eq!(manifest.roles.len(), expected_roles.len() + 1);
      for expected in expected_roles {
        let role = manifest
          .roles
          .iter()
          .find(|role| {
            role.role_key == expected.role_key
              && role.row_kind_scope.as_deref() == Some(expected.row_kind_scope.as_str())
          })
          .unwrap_or_else(|| panic!("{structure:?} missing role {}", expected.role_key));
        let field = manifest
          .fields
          .iter()
          .find(|field| field.key == role.field_key)
          .expect("catalog role field");
        assert_eq!(role.required, expected.required, "{}", expected.role_key);
        assert_eq!(
          role.managed_state,
          Some(expected.managed_state),
          "{}",
          expected.role_key
        );
        assert_eq!(field.field_type, expected.field_type, "{}", expected.role_key);
      }

      for row_template in &manifest.row_templates {
        assert!(
          row_template.row_kind == DatabaseRowKind::Task
            || !row_template.initial_field_keys.iter().any(|key| key == "progress"),
          "{structure:?} non-task templates must not persist aggregate progress"
        );
      }

      for policy in database_project_view_policies(structure) {
        let view = manifest
          .views
          .iter()
          .find(|view| view.view_kind == policy.view_kind)
          .expect("Project policy view");
        if policy.view_kind == DatabaseViewKind::Kanban {
          assert_eq!(
            view.visible_field_keys.get(0..2),
            Some(["title".to_string(), "description".to_string()].as_slice())
          );
        } else if policy.view_kind != DatabaseViewKind::Table {
          assert_eq!(view.visible_field_keys.first().map(String::as_str), Some("title"));
          assert_eq!(view.visible_field_keys.get(1).map(String::as_str), Some("status"));
        }
      }
    }
  }

  #[test]
  fn project_manifest_validation_rejects_semantic_drift_before_persistence() {
    let base = project_manifest(DatabaseProjectStructurePreset::PhasesAndMilestones);

    let mut missing = base.clone();
    missing.roles.retain(|role| role.role_key != "task.document");
    assert_eq!(
      missing
        .validate_project_contract()
        .expect_err("missing catalog role must fail")
        .boundary,
      DatabaseStarterTemplateValidationBoundary::Field
    );

    let mut duplicate = base.clone();
    duplicate.roles.push(duplicate.roles[0].clone());
    assert!(
      duplicate
        .validate_project_contract()
        .expect_err("duplicate role must fail")
        .message
        .contains("duplicate role")
    );

    let mut wrong_scope = base.clone();
    wrong_scope
      .roles
      .iter_mut()
      .find(|role| role.role_key == "task.status")
      .expect("task.status")
      .row_kind_scope = Some("phase".to_string());
    assert!(wrong_scope.validate_project_contract().is_err());

    let mut wrong_type = base.clone();
    wrong_type
      .fields
      .iter_mut()
      .find(|field| field.key == "description")
      .expect("description")
      .field_type = DatabaseFieldType::Text;
    assert!(wrong_type.validate_project_contract().is_err());

    let mut wrong_requiredness = base.clone();
    wrong_requiredness
      .roles
      .iter_mut()
      .find(|role| role.role_key == "task.complexity")
      .expect("task.complexity")
      .required = true;
    assert!(wrong_requiredness.validate_project_contract().is_err());

    let mut unresolved_template = base.clone();
    unresolved_template
      .row_templates
      .iter_mut()
      .find(|template| template.row_kind == DatabaseRowKind::Phase)
      .expect("phase row template")
      .initial_field_keys
      .push("progress".to_string());
    assert!(
      unresolved_template
        .validate_project_contract()
        .expect_err("unscoped row-template field must fail")
        .message
        .contains("unresolved field progress")
    );

    let mut wrong_view = base;
    wrong_view
      .views
      .iter_mut()
      .find(|view| view.view_kind == DatabaseViewKind::Kanban)
      .expect("Kanban")
      .visible_field_keys
      .swap(0, 1);
    assert_eq!(
      wrong_view
        .validate_project_contract()
        .expect_err("view policy drift must fail")
        .boundary,
      DatabaseStarterTemplateValidationBoundary::View
    );

    let mut preset_mismatch = project_manifest(DatabaseProjectStructurePreset::TasksOnly);
    let phase_role = project_manifest(DatabaseProjectStructurePreset::Phases)
      .roles
      .into_iter()
      .find(|role| role.role_key == "phase.title")
      .expect("phase role");
    preset_mismatch.roles.push(phase_role);
    assert!(preset_mismatch.validate_project_contract().is_err());
  }

  #[test]
  fn starter_template_manifest_validation_rejects_unknown_field_references() {
    let template = fixture_template(TEMPLATE_SIMPLE_TASK_LIST);
    let mut manifest = template.to_manifest().expect("fixture manifest");
    manifest.views[0].field_keys.push("missing-field".to_string());
    let error = manifest
      .validate()
      .expect_err("manifest validation must reject stale view field references");
    assert!(
      error.to_string().contains("references unknown field missing-field"),
      "unexpected validation error: {error}"
    );

    let mut manifest = template.to_manifest().expect("fixture manifest");
    manifest.import_mappings[0].column_mappings[0].field_key = "missing-import-field".to_string();
    let error = manifest
      .validate()
      .expect_err("manifest validation must reject stale import mapping field references");
    assert!(
      error
        .to_string()
        .contains("references unknown field missing-import-field"),
      "unexpected validation error: {error}"
    );
  }

  #[test]
  fn starter_templates_have_real_fields_views_and_sample_rows() {
    let templates = starter_template_specs(
      DatabaseProjectOptionPreset::ThreeStep,
      DatabaseProjectOptionPreset::ThreeStep,
      DatabaseProjectStructurePreset::Phases,
      "EUR",
    );
    for template in templates {
      assert!(
        !template.fields.is_empty(),
        "{} must define real fields instead of copy-only metadata",
        template.id
      );
      assert!(
        template
          .fields
          .iter()
          .any(|field| field.field_type == DatabaseFieldType::Title),
        "{} must contain exactly one user-facing title field",
        template.id
      );
      assert!(
        !template.views.is_empty(),
        "{} must define at least one persisted view",
        template.id
      );
      if template.id == TEMPLATE_BLANK_DATABASE {
        assert!(template.sample_rows.is_empty());
      } else {
        assert!(
          template.sample_rows.len() >= 5,
          "{} must provide at least five useful sample rows when samples are enabled",
          template.id
        );
      }
      let mut field_ids = BTreeMap::new();
      let mut field_types = BTreeMap::new();
      let mut test_fields = BTreeMap::new();
      for field in &template.fields {
        let field_id = Uuid::new_v5(&Uuid::NAMESPACE_OID, field.key.as_bytes());
        field_ids.insert(field.key.clone(), field_id);
        field_types.insert(field.key.clone(), field.field_type);
        let config = match &field.config {
          DatabaseTemplateFieldConfig::Direct(config) => config.clone(),
          DatabaseTemplateFieldConfig::SelfRelation {
            allow_multiple,
            max_targets,
          } => DatabaseFieldConfig::Relation(DatabaseRelationFieldConfig {
            target_database_id: Uuid::new_v5(&Uuid::NAMESPACE_OID, template.id.as_bytes()),
            allow_multiple: *allow_multiple,
            reciprocal_field_id: None,
            max_targets: *max_targets,
          }),
        };
        crate::database::definition::rules::validate_field_config(field.field_type, &config)
          .expect("template field config is valid");
        test_fields.insert(
          field.key.clone(),
          DatabaseField {
            id: field_id,
            database_id: Uuid::new_v5(&Uuid::NAMESPACE_OID, template.id.as_bytes()),
            name: field.name.to_string(),
            field_type: field.field_type,
            config,
            position: 0,
            required: field.required,
            edit_revision: 1,
            created_at: Utc::now(),
            updated_at: Utc::now(),
          },
        );
      }
      for view in &template.views {
        build_view_config(&view.config, &field_ids, &field_types).expect("template view references existing fields");
      }
      assert!(
        !template.row_templates.is_empty(),
        "{} must define at least one row template",
        template.id
      );
      assert_eq!(
        template
          .row_templates
          .iter()
          .filter(|row_template| row_template.is_default)
          .count(),
        1,
        "{} must define exactly one default row template",
        template.id
      );
      for row_template in &template.row_templates {
        assert!(
          !row_template.name.trim().is_empty(),
          "{} row template names are product copy",
          template.id
        );
        for (field_key, value) in &row_template.initial_cells {
          let field = test_fields
            .get(field_key)
            .expect("row template initial value references existing field");
          crate::database::editing::rules::validate_cell_value(field, value, &DatabaseLimits::default())
            .expect("row template initial value is valid for its field");
        }
      }
      for sample in &template.sample_rows {
        assert!(!sample.title.trim().is_empty(), "sample row titles are product copy");
        for (field_key, _) in &sample.cells {
          assert!(
            field_ids.contains_key(field_key),
            "sample row in {} references unknown field {}",
            template.id,
            field_key
          );
        }
        for (field_key, target_keys) in &sample.relation_cells {
          assert!(
            field_ids.contains_key(field_key),
            "sample row in {} references unknown relation field {}",
            template.id,
            field_key
          );
          for target_key in target_keys {
            assert!(
              template
                .sample_rows
                .iter()
                .any(|candidate| candidate.key == *target_key),
              "sample row in {} references unknown sample row {}",
              template.id,
              target_key
            );
          }
        }
      }
    }
  }

  #[test]
  fn inventory_gallery_does_not_lead_with_empty_cover_chrome() {
    let template = fixture_template(TEMPLATE_INVENTORY_ASSETS);
    let gallery = template.views.first().expect("inventory default view");
    match &gallery.config {
      DatabaseTemplateViewConfig::Gallery {
        cover,
        show_empty_cover,
        ..
      } => {
        assert!(cover.is_none(), "sample assets do not ship fake file covers");
        assert!(
          !show_empty_cover,
          "the default Gallery must prioritize useful asset properties"
        );
      }
      _ => panic!("inventory must retain Gallery as its default view"),
    }
  }

  #[test]
  fn crm_template_uses_a_contact_lifecycle_instead_of_task_statuses() {
    let template = fixture_template(TEMPLATE_CRM_CONTACTS);
    let status = template
      .fields
      .iter()
      .find(|field| field.key == "status")
      .expect("CRM status field");
    let DatabaseTemplateFieldConfig::Direct(DatabaseFieldConfig::Status(config)) = &status.config else {
      panic!("CRM status must retain the native Status field type");
    };
    assert_eq!(config.default_option_id, "status.new");
    assert_eq!(
      config
        .options
        .iter()
        .map(|option| option.name.as_str())
        .collect::<Vec<_>>(),
      ["New", "Contacted", "Qualified", "Customer"]
    );
    assert_eq!(
      template
        .sample_rows
        .iter()
        .filter_map(|row| row.cells.iter().find(|(key, _)| *key == "status"))
        .filter_map(|(_, value)| match value {
          DatabaseCellValueData::Status(status) => Some(status.as_str()),
          _ => None,
        })
        .collect::<BTreeSet<_>>(),
      BTreeSet::from(["status.contacted", "status.customer", "status.new", "status.qualified",])
    );
  }

  #[test]
  fn project_templates_have_required_project_roles_and_views() {
    let templates = starter_template_specs(
      DatabaseProjectOptionPreset::FiveStep,
      DatabaseProjectOptionPreset::FiveStep,
      DatabaseProjectStructurePreset::PhasesAndMilestones,
      "USD",
    );
    for template in templates
      .into_iter()
      .filter(|template| template.profile_kind == DatabaseProfileKind::Project)
    {
      let role_keys = template
        .roles
        .iter()
        .map(|role| role.role_key.as_str())
        .collect::<BTreeSet<_>>();
      for required in [
        "task.title",
        "task.description",
        "task.status",
        "task.priority",
        "task.assignees",
        "task.progress",
        "task.cost",
      ] {
        assert!(
          role_keys.contains(required),
          "{} must include required Project role {}",
          template.id,
          required
        );
      }
      if template.default_structure.expect("project structure").has_phases() {
        assert!(
          role_keys.contains("task.phase"),
          "{} must include task.phase",
          template.id
        );
      }
      if template.default_structure.expect("project structure").has_milestones() {
        assert!(
          role_keys.contains("task.milestone"),
          "{} must include task.milestone",
          template.id
        );
      }
      if template.default_structure.expect("project structure") == DatabaseProjectStructurePreset::PhasesAndMilestones {
        assert!(
          role_keys.contains("milestone.phase"),
          "{} must include milestone.phase",
          template.id
        );
      }
      let view_kinds = template.views.iter().map(|view| view.kind).collect::<Vec<_>>();
      for required in [
        DatabaseViewKind::Kanban,
        DatabaseViewKind::Table,
        DatabaseViewKind::Progress,
        DatabaseViewKind::List,
        DatabaseViewKind::Calendar,
      ] {
        assert!(
          view_kinds.contains(&required),
          "{} must include required Project view {:?}",
          template.id,
          required
        );
      }
      assert!(template.default_structure.is_some());
      assert!(template.priority_preset.is_some());
      assert!(template.complexity_preset.is_some());
      for sample in &template.sample_rows {
        for (field_key, value) in &sample.cells {
          if *field_key == "cost" {
            let DatabaseCellValueData::Currency(currency) = value else {
              panic!("{} sample cost must use Currency cell data", template.id);
            };
            assert_eq!(
              currency.currency_code, "USD",
              "{} sample costs must follow the selected template default currency",
              template.id
            );
          }
        }
      }
    }
  }

  #[test]
  fn project_sample_rows_follow_selected_structure_model() {
    for structure in [
      DatabaseProjectStructurePreset::TasksOnly,
      DatabaseProjectStructurePreset::Phases,
      DatabaseProjectStructurePreset::Milestones,
      DatabaseProjectStructurePreset::PhasesAndMilestones,
    ] {
      let template = fixture_project(
        DatabaseProjectOptionPreset::ThreeStep,
        DatabaseProjectOptionPreset::ThreeStep,
        structure,
      );
      let task_rows = template
        .sample_rows
        .iter()
        .filter(|row| row.row_kind == DatabaseRowKind::Task)
        .collect::<Vec<_>>();
      let phase_rows = template
        .sample_rows
        .iter()
        .filter(|row| row.row_kind == DatabaseRowKind::Phase)
        .collect::<Vec<_>>();
      let milestone_rows = template
        .sample_rows
        .iter()
        .filter(|row| row.row_kind == DatabaseRowKind::Milestone)
        .collect::<Vec<_>>();
      assert_eq!(task_rows.len(), 5, "{structure:?} keeps the five useful task rows");
      assert!(
        template
          .row_templates
          .iter()
          .any(|template| template.row_kind == DatabaseRowKind::Task),
        "{structure:?} Project starter must always expose a task row template"
      );
      assert_eq!(
        template
          .row_templates
          .iter()
          .any(|template| template.row_kind == DatabaseRowKind::Phase),
        structure.has_phases(),
        "{structure:?} phase row template must match the selected structure"
      );
      assert_eq!(
        template
          .row_templates
          .iter()
          .any(|template| template.row_kind == DatabaseRowKind::Milestone),
        structure.has_milestones(),
        "{structure:?} milestone row template must match the selected structure"
      );
      assert_eq!(
        phase_rows.len(),
        if structure.has_phases() { 2 } else { 0 },
        "{structure:?} seeds phases only when the structure supports phases"
      );
      assert_eq!(
        milestone_rows.len(),
        if structure.has_milestones() { 2 } else { 0 },
        "{structure:?} seeds milestones only when the structure supports milestones"
      );

      for task in task_rows {
        assert_eq!(
          task.relation_cells.iter().any(|(field_key, _)| *field_key == "phase"),
          structure.has_phases(),
          "{structure:?} task phase relation must match the structure"
        );
        assert_eq!(
          task
            .relation_cells
            .iter()
            .any(|(field_key, _)| *field_key == "milestone"),
          structure.has_milestones(),
          "{structure:?} task milestone relation must match the structure"
        );
      }

      for milestone in milestone_rows {
        assert_eq!(
          milestone
            .relation_cells
            .iter()
            .any(|(field_key, _)| *field_key == "phase"),
          structure.has_phases(),
          "{structure:?} milestone phase relation must match the structure"
        );
      }
    }
  }

  fn inventory_source(spec: DatabaseTemplateSpec) -> (DatabaseTemplateDefinitionSource, DatabaseTemplateFileReference) {
    let input = DatabaseTemplateSelection {
      priority: spec.priority_preset.unwrap_or(DatabaseProjectOptionPreset::ThreeStep),
      complexity: spec.complexity_preset.unwrap_or(DatabaseProjectOptionPreset::ThreeStep),
      structure: spec
        .default_structure
        .unwrap_or(DatabaseProjectStructurePreset::TasksOnly),
    };
    let id = spec.id.clone();
    (
      DatabaseTemplateDefinitionSource {
        format_version: 1,
        id: id.clone(),
        version: "1.0.0".into(),
        supported_predecessors: vec![],
        task_core: None,
        variants: vec![DatabaseTemplateVariantSource {
          priority: input.priority,
          complexity: input.complexity,
          structure: input.structure,
          option_extensions: vec![],
          field_order: vec![],
          role_order: vec![],
          spec,
        }],
      },
      DatabaseTemplateFileReference {
        version: "1.0.0".into(),
        path: format!("{id}/1.0.0.yaml"),
        sha256: "a".repeat(64),
        selections: vec![DatabaseTemplateVariantSelection { input, variant: input }],
      },
    )
  }

  fn update_fixture(
    before: &(DatabaseTemplateDefinitionSource, DatabaseTemplateFileReference),
    after: &(DatabaseTemplateDefinitionSource, DatabaseTemplateFileReference),
  ) -> (DatabaseTemplateUpdateSource, DatabaseTemplateUpdateReference) {
    (
      DatabaseTemplateUpdateSource {
        format_version: 1,
        template_id: before.0.id.clone(),
        source: DatabaseTemplateUpdateEndpoint {
          version: before.0.version.clone(),
          sha256: before.1.sha256.clone(),
        },
        target: DatabaseTemplateUpdateEndpoint {
          version: after.0.version.clone(),
          sha256: after.1.sha256.clone(),
        },
        operations: vec![],
      },
      DatabaseTemplateUpdateReference {
        from: before.0.version.clone(),
        to: after.0.version.clone(),
        path: format!(
          "{}/updates/{}-to-{}.yaml",
          before.0.id, before.0.version, after.0.version
        ),
        sha256: "e".repeat(64),
      },
    )
  }

  fn select_update_fixture() -> (
    (DatabaseTemplateDefinitionSource, DatabaseTemplateFileReference),
    (DatabaseTemplateDefinitionSource, DatabaseTemplateFileReference),
    (DatabaseTemplateUpdateSource, DatabaseTemplateUpdateReference),
  ) {
    let mut spec = fixture_project(
      DatabaseProjectOptionPreset::ThreeStep,
      DatabaseProjectOptionPreset::ThreeStep,
      DatabaseProjectStructurePreset::TasksOnly,
    );
    // An ordinary optional field isolates value conversion from the mandatory
    // Task-core option identities and lifecycle policy.
    let mut field = spec
      .fields
      .iter()
      .find(|field| field.key == "priority")
      .unwrap()
      .clone();
    field.key = "release_track".into();
    field.name = "Release track".into();
    field.required = false;
    let DatabaseTemplateFieldConfig::Direct(DatabaseFieldConfig::Select(config)) = &mut field.config else {
      panic!("native priority is Select")
    };
    config.options.truncate(2);
    config.options[0].id = "old".into();
    config.options[1].id = "keep".into();
    spec.fields.push(field);
    let manifest = spec.manifest.as_mut().expect("original source manifest");
    let mut metadata = manifest
      .fields
      .iter()
      .find(|field| field.key == "priority")
      .unwrap()
      .clone();
    metadata.key = "release_track".into();
    metadata.name_key = "com.myoxus.database.fixture.release-track".into();
    metadata.required = false;
    manifest.fields.push(metadata);
    let before = inventory_source(spec);
    let mut after = before.clone();
    after.0.version = "1.0.1".into();
    after.1.version = "1.0.1".into();
    after.1.path = format!("{}/1.0.1.yaml", after.0.id);
    after.1.sha256 = "b".repeat(64);
    let field = after.0.variants[0]
      .spec
      .fields
      .iter_mut()
      .find(|field| field.key == "release_track")
      .unwrap();
    let DatabaseTemplateFieldConfig::Direct(DatabaseFieldConfig::Select(config)) = &mut field.config else {
      unreachable!()
    };
    config.options[0].id = "new".into();
    let mut edge = update_fixture(&before, &after);
    edge
      .0
      .operations
      .push(DatabaseTemplateUpdateOperation::MapSelectOptions {
        field_key: "release_track".into(),
        mapping: [("old".into(), "new".into())].into(),
      });
    (before, after, edge)
  }

  #[test]
  fn native_update_admission_rejects_cardinality_status_policy_and_field_deletion() {
    let (before, after, edge) = select_update_fixture();
    let mut cardinality = after.clone();
    let spec = &mut cardinality.0.variants[0].spec;
    let field = spec
      .fields
      .iter_mut()
      .find(|field| field.key == "release_track")
      .unwrap();
    let DatabaseTemplateFieldConfig::Direct(DatabaseFieldConfig::Select(config)) = &field.config else {
      unreachable!()
    };
    field.config = DatabaseTemplateFieldConfig::Direct(DatabaseFieldConfig::MultiSelect(config.clone()));
    field.field_type = DatabaseFieldType::MultiSelect;
    let assertion = spec
      .manifest
      .as_mut()
      .unwrap()
      .fields
      .iter_mut()
      .find(|field| field.key == "release_track")
      .unwrap();
    assertion.field_type = DatabaseFieldType::MultiSelect;
    assertion.config_kind = "multi_select".into();
    assert!(
      DatabaseTemplateInventory::from_sources(vec![before.clone(), cardinality], vec![edge.clone()])
        .unwrap_err()
        .contains("cardinality")
    );

    let mut removed = after.clone();
    removed.0.variants[0]
      .spec
      .fields
      .retain(|field| field.key != "release_track");
    removed.0.variants[0]
      .spec
      .manifest
      .as_mut()
      .unwrap()
      .fields
      .retain(|field| field.key != "release_track");
    assert!(
      DatabaseTemplateInventory::from_sources(vec![before.clone(), removed], vec![edge.clone()])
        .unwrap_err()
        .contains("remove a field")
    );

    let mut policy = after;
    policy.0.variants[0]
      .spec
      .roles
      .iter_mut()
      .find(|role| role.role_key == "task.status")
      .unwrap()
      .config = json!({"completionPolicy":"ignoreCompletion"});
    assert!(
      DatabaseTemplateInventory::from_sources(vec![before, policy], vec![edge])
        .unwrap_err()
        .contains("invalid managed-state configuration")
    );
  }

  #[test]
  fn native_update_edges_require_exact_pins_variants_and_structural_semantics() {
    let original = inventory_source(fixture_project(
      DatabaseProjectOptionPreset::ThreeStep,
      DatabaseProjectOptionPreset::ThreeStep,
      DatabaseProjectStructurePreset::TasksOnly,
    ));
    let mut target = original.clone();
    target.0.version = "1.0.1".into();
    target.1.version = target.0.version.clone();
    target.1.path = format!("{}/1.0.1.yaml", target.0.id);
    target.1.sha256 = "b".repeat(64);
    let edge = update_fixture(&original, &target);
    let definitions = vec![original.clone(), target.clone()];
    let inventory = DatabaseTemplateInventory::from_sources(definitions.clone(), vec![edge.clone()]).unwrap();
    assert_eq!(
      inventory.update_from(&original.0.id, "1.0.0").unwrap().0.target.version,
      "1.0.1"
    );
    assert!(
      DatabaseTemplateInventory::from_sources(vec![original.clone()], vec![edge.clone()])
        .unwrap_err()
        .contains("target definition missing")
    );
    let mut changed_pin = edge.clone();
    changed_pin.0.target.sha256 = "c".repeat(64);
    assert!(
      DatabaseTemplateInventory::from_sources(definitions.clone(), vec![changed_pin])
        .unwrap_err()
        .contains("endpoint digest mismatch")
    );
    let mut bad_path = edge.clone();
    bad_path.1.path = "../update.yaml".into();
    assert!(DatabaseTemplateInventory::from_sources(definitions.clone(), vec![bad_path]).is_err());
    assert!(
      DatabaseTemplateInventory::from_sources(definitions.clone(), vec![edge.clone(), edge.clone()])
        .unwrap_err()
        .contains("ambiguous")
    );
    let backwards = update_fixture(&target, &original);
    assert!(
      DatabaseTemplateInventory::from_sources(definitions.clone(), vec![backwards])
        .unwrap_err()
        .contains("move forward")
    );
    let mut mapping = target.clone();
    mapping.1.selections[0].input.priority = DatabaseProjectOptionPreset::FiveStep;
    assert!(
      DatabaseTemplateInventory::from_sources(vec![original.clone(), mapping], vec![edge.clone()])
        .unwrap_err()
        .contains("variant mapping mismatch")
    );
    let mut removed = target.clone();
    // An otherwise valid native definition may not drop an installed binding.
    let field = removed.0.variants[0].spec.fields.pop().unwrap();
    assert!(
      myoxus_domain::database::definition::updates::validate_structural_template_update(
        &original.0.variants[0].spec,
        &removed.0.variants[0].spec
      )
      .unwrap_err()
      .contains("remove a field")
    );
    removed.0.variants[0].spec.fields.push(field);
    removed.0.variants[0].spec.fields[0].required = !removed.0.variants[0].spec.fields[0].required;
    assert!(
      myoxus_domain::database::definition::updates::validate_structural_template_update(
        &original.0.variants[0].spec,
        &removed.0.variants[0].spec
      )
      .unwrap_err()
      .contains("requiredness change")
    );
    let generic = inventory_source(fixture_template(TEMPLATE_INVENTORY_ASSETS));
    let mut generic_target = generic.clone();
    generic_target.0.version = "1.0.1".into();
    generic_target.1.version = "1.0.1".into();
    generic_target.1.path = format!("{}/1.0.1.yaml", generic_target.0.id);
    generic_target.1.sha256 = "b".repeat(64);
    let generic_edge = update_fixture(&generic, &generic_target);
    assert!(
      DatabaseTemplateInventory::from_sources(vec![generic, generic_target], vec![generic_edge])
        .unwrap_err()
        .contains("managed native variant")
    );
    let mut value = serde_json::to_value(&edge.0).unwrap();
    value["operations"] = json!([{"map_select_options": {}}]);
    assert!(serde_json::from_value::<DatabaseTemplateUpdateSource>(value).is_err());
    let mut value = serde_json::to_value(&edge.0).unwrap();
    value["target"]["unknown"] = json!(true);
    assert!(serde_json::from_value::<DatabaseTemplateUpdateSource>(value).is_err());
  }
}
