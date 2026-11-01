// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;
use myoxus_contracts::config_document::{ConfigDocumentFormat, decode_config_document};
use myoxus_domain::database::*;
use sha2::{Digest, Sha256};
use std::path::Path;
fn shipped() -> std::path::PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases")
}
#[test]
fn named_bytes_reject_missing_tampered_duplicate_unknown_and_unbounded_sources() {
  use myoxus_contracts::config_document::encode_config_yaml;
  let files = super::capture::capture_files(&shipped()).unwrap();
  let definition_path = "myoxus.database.blank/1.0.1.yaml";
  let core_path = files
    .keys()
    .find(|path| path.starts_with("myoxus.project.task-core/"))
    .unwrap();
  for path in ["catalog.yaml", definition_path, core_path.as_str()] {
    let mut missing = files.clone();
    missing.remove(path);
    let error = decode_database_template_sources(&missing).unwrap_err().to_string();
    assert!(
      error.contains(path) && error.contains("missing captured source"),
      "{error}"
    );
  }
  let mut tampered = files.clone();
  tampered.get_mut(definition_path).unwrap().push(b' ');
  let error = decode_database_template_sources(&tampered).unwrap_err().to_string();
  assert!(
    error.contains(definition_path) && error.contains("SHA-256 mismatch"),
    "{error}"
  );

  let mut duplicate = files.clone();
  duplicate
    .get_mut("catalog.yaml")
    .unwrap()
    .extend_from_slice(b"\nformat_version: 1\n");
  assert!(
    decode_database_template_sources(&duplicate)
      .unwrap_err()
      .to_string()
      .contains("catalog.yaml")
  );

  // A later definition cannot change the pin of an already decoded shared Core.
  let mut conflicting_pin = files.clone();
  let mut catalog: DatabaseTemplateCatalogSource = crate::template_files::decode_yaml(&files["catalog.yaml"]).unwrap();
  let mut core_references = 0;
  for entry in &mut catalog.templates {
    for reference in &mut entry.definitions {
      let definition: DatabaseTemplateDefinitionSource =
        crate::template_files::decode_yaml(&files[&reference.path]).unwrap();
      if let Some(core) = &definition.task_core {
        core_references += 1;
        if core_references == 2 {
          // Preserve the authored definition byte-for-byte except its one Core
          // digest; reserializing native scalar content is unrelated to this case.
          let original = std::str::from_utf8(&files[&reference.path]).unwrap();
          assert_eq!(original.matches(&core.sha256).count(), 1);
          let bytes = original.replacen(&core.sha256, &"0".repeat(64), 1).into_bytes();
          reference.sha256 = format!("{:x}", Sha256::digest(&bytes));
          conflicting_pin.insert(reference.path.clone(), bytes);
        }
      }
    }
  }
  assert!(
    core_references >= 2,
    "fixture must exercise a later shared Core reference"
  );
  conflicting_pin.insert(
    "catalog.yaml".into(),
    encode_config_yaml(&catalog).unwrap().into_bytes(),
  );
  let error = decode_database_template_sources(&conflicting_pin)
    .unwrap_err()
    .to_string();
  assert!(
    error.contains(core_path) && error.contains("SHA-256 mismatch"),
    "{error}"
  );

  // Re-pin a syntactically valid source so unknown native keys cannot be hidden
  // behind an earlier digest failure.
  let mut unknown = files.clone();
  let mut definition = decode_config_document(
    std::str::from_utf8(&unknown[definition_path]).unwrap(),
    ConfigDocumentFormat::Yaml,
  )
  .unwrap();
  definition["variants"][0]["spec"]["fields"][0]["config"]["Direct"]["unknownNativeKey"] = true.into();
  let bytes = encode_config_yaml(&definition).unwrap().into_bytes();
  let digest = format!("{:x}", Sha256::digest(&bytes));
  unknown.insert(definition_path.into(), bytes);
  let mut pointer = decode_config_document(
    std::str::from_utf8(&unknown["catalog.yaml"]).unwrap(),
    ConfigDocumentFormat::Yaml,
  )
  .unwrap();
  for entry in pointer["templates"].as_array_mut().unwrap() {
    for reference in entry["definitions"].as_array_mut().unwrap() {
      if reference["path"] == definition_path {
        reference["sha256"] = digest.clone().into();
      }
    }
  }
  unknown.insert(
    "catalog.yaml".into(),
    encode_config_yaml(&pointer).unwrap().into_bytes(),
  );
  let error = decode_database_template_sources(&unknown).unwrap_err().to_string();
  assert!(
    error.contains(definition_path) && (error.contains("unknown") || error.contains("invalid source schema")),
    "{error}"
  );

  let mut invalid_path = files.clone();
  invalid_path.insert("../escape.yaml".into(), vec![b'x']);
  assert!(
    decode_database_template_sources(&invalid_path)
      .unwrap_err()
      .to_string()
      .contains("confined .yaml path")
  );
  let mut oversized = files.clone();
  oversized.insert("catalog.yaml".into(), vec![b'x'; 4 * 1024 * 1024 + 1]);
  assert!(
    decode_database_template_sources(&oversized)
      .unwrap_err()
      .to_string()
      .contains("catalog size limit exceeded")
  );
  let mut invalid_utf8 = files.clone();
  invalid_utf8.insert("catalog.yaml".into(), vec![0xff]);
  assert!(
    decode_database_template_sources(&invalid_utf8)
      .unwrap_err()
      .to_string()
      .contains("input is not UTF-8")
  );
  let excessive_bytes = (0..17)
    .map(|index| (format!("{index}.yaml"), vec![b'x'; 4 * 1024 * 1024]))
    .collect();
  assert!(
    decode_database_template_sources(&excessive_bytes)
      .unwrap_err()
      .to_string()
      .contains("catalog size limit exceeded")
  );
  let excessive = (0..257).map(|index| (format!("{index}.yaml"), vec![b'x'])).collect();
  assert!(
    decode_database_template_sources(&excessive)
      .unwrap_err()
      .to_string()
      .contains("reference limit exceeded")
  );
}
