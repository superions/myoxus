// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;
use myoxus_application::database::DatabaseStarterTemplateCatalog;
use myoxus_contracts::config_document::{decode_typed_yaml_document, encode_config_yaml};
use myoxus_domain::assistant_package::AssistantPackageIdentity;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn shipped() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/assistants")
}
fn templates() -> DatabaseStarterTemplateCatalog {
  crate::database_templates::load_database_template_catalog(
    &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
  )
  .unwrap()
}
fn copy_tree(source: &Path, target: &Path) {
  std::fs::create_dir_all(target).unwrap();
  for entry in std::fs::read_dir(source).unwrap() {
    let entry = entry.unwrap();
    let destination = target.join(entry.file_name());
    if entry.file_type().unwrap().is_dir() {
      copy_tree(&entry.path(), &destination);
    } else {
      std::fs::copy(entry.path(), destination).unwrap();
    }
  }
}
fn read(path: &Path) -> Value {
  decode_typed_yaml_document(&std::fs::read_to_string(path).unwrap()).unwrap()
}
fn write(path: &Path, value: &Value) {
  std::fs::write(path, encode_config_yaml(value).unwrap()).unwrap();
}
/// Mutate the selected native source and repin that exact catalog reference.
fn alter_current(root: &Path, id: &str, change: impl FnOnce(&mut Value)) -> AssistantPackageIdentity {
  let catalog_path = root.join("catalog.yaml");
  let mut catalog = read(&catalog_path);
  let entry = catalog["packages"]
    .as_array_mut()
    .unwrap()
    .iter_mut()
    .find(|entry| entry["id"] == id)
    .unwrap();
  let version = entry["current"].as_str().unwrap().to_owned();
  let reference = entry["definitions"]
    .as_array_mut()
    .unwrap()
    .iter_mut()
    .find(|reference| reference["version"] == version)
    .unwrap();
  let source_path = root.join(reference["path"].as_str().unwrap());
  let mut source = read(&source_path);
  assert_eq!(source["id"], id);
  assert_eq!(source["version"], version);
  change(&mut source);
  write(&source_path, &source);
  let digest = format!("{:x}", Sha256::digest(std::fs::read(source_path).unwrap()));
  reference["sha256"] = digest.clone().into();
  write(&catalog_path, &catalog);
  AssistantPackageIdentity {
    id: id.into(),
    version,
    digest,
  }
}

fn rejects(id: &str, change: impl FnOnce(&mut Value), expected: &str) {
  let directory = tempfile::tempdir().unwrap();
  copy_tree(&shipped(), directory.path());
  alter_current(directory.path(), id, change);
  let error = load_assistant_package_catalog(directory.path(), &templates())
    .unwrap_err()
    .to_string();
  assert!(error.contains(expected), "expected {expected}, received {error}");
}

#[test]
fn authored_visibility_and_execution_cannot_hide_native_safety() {
  rejects(
    "myoxus.assistant.project.simple_project",
    |source| {
      source["inputs"][0]["visibleWhen"] = serde_json::json!({"kind":"present","input":"samples"});
    },
    "preceding input",
  );
  let directory = tempfile::tempdir().unwrap();
  copy_tree(&shipped(), directory.path());
  alter_current(directory.path(), "myoxus.assistant.project.simple_project", |source| {
    let mut second = source["components"][0].clone();
    second["id"] = "second".into();
    source["components"].as_array_mut().unwrap().push(second);
  });
  let error = load_assistant_package_catalog(directory.path(), &templates())
    .unwrap_err()
    .to_string();
  assert!(
    error.contains("one primary Project and optional native documents"),
    "received {error}"
  );
  rejects(
    "myoxus.assistant.taskMovement",
    |source| {
      for group in source["presentation"]["steps"][0]["groups"].as_array_mut().unwrap() {
        group["controls"]
          .as_array_mut()
          .unwrap()
          .retain(|control| control["kind"] != "moveImpact");
      }
    },
    "unconditional selection, impact",
  );
  rejects(
    "myoxus.assistant.taskDetail",
    |source| {
      source["presentation"]["steps"][0]["groups"][0]["controls"][0]["binding"] =
        serde_json::json!({"kind":"role","roleKey":"task.imaginary"});
    },
    "unsupported native Task binding",
  );
}

#[test]
fn configured_write_flows_cannot_omit_their_native_apply_action() {
  for (id, action) in [
    ("myoxus.assistant.project.simple_project", "createProject"),
    ("myoxus.assistant.taskCreation", "createTask"),
    ("myoxus.assistant.taskCapture", "captureTask"),
    ("myoxus.assistant.taskSubtask", "createSubtask"),
  ] {
    rejects(
      id,
      |source| {
        for step in source["presentation"]["steps"].as_array_mut().unwrap() {
          step["actions"]
            .as_array_mut()
            .unwrap()
            .retain(|button| button["action"] != action);
        }
      },
      "native write context requires an unconditional executable apply action",
    );
  }
}

#[test]
fn direct_project_apply_cannot_precede_or_omit_the_native_review_boundary() {
  rejects(
    "myoxus.assistant.project.simple_project",
    |source| {
      let apply = source["presentation"]["steps"][3]["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|action| action["action"] == "createProject")
        .unwrap()
        .clone();
      source["presentation"]["steps"][3]["actions"]
        .as_array_mut()
        .unwrap()
        .retain(|action| action["action"] != "createProject");
      source["presentation"]["steps"][0]["actions"]
        .as_array_mut()
        .unwrap()
        .push(apply);
    },
    "direct Project apply requires its native review step",
  );
}

#[test]
fn catalog_activation_defaults_preserve_strict_native_capture() {
  let files = capture_assistant_package_files(&shipped()).unwrap();
  let (catalog, _) = decode_assistant_package_sources(&files).unwrap();
  let authored = read(&shipped().join("catalog.yaml"));
  for (entry, raw) in catalog.packages.iter().zip(authored["packages"].as_array().unwrap()) {
    assert_eq!(
      entry.enabled,
      raw.get("enabled").and_then(Value::as_bool).unwrap_or(true)
    );
  }
  let decode = |source: &Value| decode_assistant_package_catalog(&serde_json::to_vec(source).unwrap());
  for enabled in [true, false] {
    let mut source = authored.clone();
    source["packages"][0]["enabled"] = enabled.into();
    assert_eq!(decode(&source).unwrap().packages[0].enabled, enabled);
  }
  let mut omitted = authored.clone();
  omitted["packages"][0].as_object_mut().unwrap().remove("enabled");
  assert!(decode(&omitted).unwrap().packages[0].enabled);

  let mut unknown = omitted.clone();
  unknown["packages"][0]["enabeld"] = false.into();
  assert!(decode(&unknown).is_err());
  unknown = omitted;
  unknown["unrecognized"] = true.into();
  assert!(decode(&unknown).is_err());
  assert!(decode_assistant_package_catalog(b"formatVersion: 1\npackages: []\npackages: []\n").is_err());
}
