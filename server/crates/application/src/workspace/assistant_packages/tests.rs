// SPDX-License-Identifier: AGPL-3.0-or-later
use super::validation::control_identity;
use super::*;
use myoxus_domain::assistant_package::*;
use myoxus_domain::database::*;
use sha2::{Digest, Sha256};

fn movement() -> AssistantPackageSource {
  myoxus_contracts::config_document::decode_typed_yaml_document(include_str!(
    "../../../../../templates/assistants/myoxus.assistant.taskMovement/1.0.0.yaml"
  ))
  .unwrap()
}
fn admission_templates() -> DatabaseStarterTemplateCatalog {
  // The retained native fixture supplies a complete Project, rather than a
  // test-only partial schema. No database or file loader is needed by this port.
  let original: serde_json::Value = serde_json::from_str(include_str!(
    "../../../../infrastructure/src/database_templates_original.json"
  ))
  .unwrap();
  let mut value = original["specs"]
    .as_array()
    .unwrap()
    .iter()
    .find(|spec| {
      spec["id"] == "myoxus.project.simple_project"
        && spec["default_structure"] == "tasks_only"
        && spec["priority_preset"] == "ThreeStep"
        && spec["complexity_preset"] == "ThreeStep"
    })
    .unwrap()
    .clone();
  for key in ["priority_preset", "complexity_preset"] {
    value[key] = "threeStep".into();
  }
  let spec: DatabaseTemplateSpec = serde_json::from_value(value).unwrap();
  let selection = DatabaseTemplateSelection {
    priority: DatabaseProjectOptionPreset::ThreeStep,
    complexity: DatabaseProjectOptionPreset::ThreeStep,
    structure: DatabaseProjectStructurePreset::TasksOnly,
  };
  let id = spec.id.clone();
  let definition = DatabaseTemplateDefinitionSource {
    supported_predecessors: vec![],
    format_version: 1,
    id: id.clone(),
    version: "1.0.0".into(),
    task_core: None,
    variants: vec![DatabaseTemplateVariantSource {
      option_extensions: vec![],
      field_order: vec![],
      role_order: vec![],
      priority: selection.priority,
      complexity: selection.complexity,
      structure: selection.structure,
      spec,
    }],
  };
  let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&definition).unwrap()));
  DatabaseStarterTemplateCatalog::from_sources(
    DatabaseTemplateCatalogSource {
      format_version: 1,
      templates: vec![DatabaseTemplateCatalogEntry {
        id: id.clone(),
        current: "1.0.0".into(),
        updates: vec![],
        offering: Some(true),
        default_variant: Some(selection),
        definitions: vec![DatabaseTemplateFileReference {
          selections: vec![DatabaseTemplateVariantSelection {
            input: selection,
            variant: selection,
          }],
          version: "1.0.0".into(),
          path: format!("{id}/1.0.0.yaml"),
          sha256: digest,
        }],
      }],
      system_sources: [
        DatabaseTemplateSourceRole::ProjectDefault,
        DatabaseTemplateSourceRole::WorkspaceTasks,
      ]
      .into_iter()
      .map(|role| DatabaseTemplateSystemSource {
        role,
        template_id: id.clone(),
        selection,
      })
      .collect(),
    },
    vec![definition],
    vec![],
  )
  .unwrap()
}
fn admit_task_source(source: AssistantPackageSource) -> Result<AssistantPackageCatalog, String> {
  let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&source).unwrap()));
  let pointer = AssistantPackageCatalogSource {
    format_version: 1,
    packages: vec![AssistantPackageCatalogEntry {
      enabled: true,
      id: source.id.clone(),
      current: source.version.clone(),
      default_for: source.contexts.clone(),
      definitions: vec![AssistantPackageFileReference {
        version: source.version.clone(),
        path: format!("{}/{}.yaml", source.id, source.version),
        sha256: digest.clone(),
      }],
    }],
  };
  AssistantPackageCatalog::from_sources(pointer, vec![(source, digest)], &admission_templates())
}
fn move_confirmation(source: &mut AssistantPackageSource) {
  let apply = source.presentation.steps[0]
    .actions
    .iter_mut()
    .find(|action| action.action == AssistantActionKind::CommitTaskMove)
    .unwrap();
  let mut confirm = apply.clone();
  confirm.id = "confirm-move".into();
  apply.dialog = Some("move-confirmation".into());
  let mut cancel = source.presentation.steps[0]
    .actions
    .iter()
    .find(|action| action.action == AssistantActionKind::Cancel)
    .unwrap()
    .clone();
  cancel.id = "cancel-confirmation".into();
  source.presentation.dialogs.push(AssistantDialog {
    id: "move-confirmation".into(),
    title: AssistantLocalizedText {
      en: "Confirm move".into(),
      de: "Verschieben bestätigen".into(),
      fr: "Confirmer le déplacement".into(),
      es: "Confirmar traslado".into(),
    },
    groups: vec![],
    actions: vec![confirm, cancel],
  });
}
#[test]
fn commit_dialog_cannot_hide_move_diagnostics_or_current_owner_readback() {
  for kind in [
    AssistantControl::MoveSelection,
    AssistantControl::MoveImpact,
    AssistantControl::CurrentOwnerReadback,
  ] {
    let mut source = movement();
    move_confirmation(&mut source);
    let mut moved = vec![];
    for group in &mut source.presentation.steps[0].groups {
      group.controls.retain(|control| {
        if control_identity(control) == control_identity(&kind) {
          moved.push(control.clone());
          false
        } else {
          true
        }
      });
    }
    assert_eq!(moved.len(), 1);
    let mut group = source.presentation.steps[0].groups[0].clone();
    group.id = "hidden-safety".into();
    group.controls = moved;
    source.presentation.dialogs[0].groups.push(group);
    let error = admit_task_source(source).unwrap_err();
    assert!(
      error.contains("Task move presentation requires unconditional selection, impact and current-owner readback"),
      "{error}"
    );
  }
}
