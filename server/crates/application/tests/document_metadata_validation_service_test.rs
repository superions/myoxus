// SPDX-License-Identifier: AGPL-3.0-or-later

use chrono::{Duration, Utc};
use uuid::Uuid;

use myoxus_application::document_metadata::DocumentMetadataValidationService;
use myoxus_application::document_metadata_policy::DocumentMetadataAction;
use myoxus_domain::entities::{
  DocumentMetadataAudience, DocumentMetadataFieldDefinition, DocumentMetadataFieldValue, DocumentMetadataPolicy,
  DocumentMetadataProjection, DocumentMetadataReferenceValue, DocumentMetadataSource, DocumentMetadataSystemFacts,
  DocumentMetadataValidationCode, DocumentMetadataValidationSeverity,
};

fn definition(
  key: &str,
  required_mode: &str,
  export_mode: &str,
  validation_config: serde_json::Value,
) -> DocumentMetadataFieldDefinition {
  DocumentMetadataFieldDefinition {
    key: key.to_string(),
    label: key.to_string(),
    enabled: true,
    required_mode: required_mode.to_string(),
    editable_by: "editor".to_string(),
    visible_in_header: true,
    visible_in_properties: true,
    visible_in_lists: true,
    export_mode: export_mode.to_string(),
    validation_config,
    metadata: serde_json::json!({}),
    updated_by: None,
    updated_at: Utc::now(),
  }
}

fn reference(key: &str) -> DocumentMetadataReferenceValue {
  DocumentMetadataReferenceValue {
    id: Uuid::new_v4(),
    key: key.to_string(),
    label: key.to_string(),
    is_active: true,
  }
}

fn reference_field(key: &str, reference_key: Option<&str>) -> DocumentMetadataFieldValue {
  DocumentMetadataFieldValue {
    key: key.to_string(),
    source: DocumentMetadataSource::Document,
    reference: reference_key.map(reference),
    text_value: None,
    timestamp_value: None,
    date_value: None,
    user_id: None,
  }
}

fn projection(fields: Vec<DocumentMetadataFieldValue>) -> DocumentMetadataProjection {
  DocumentMetadataProjection {
    doc_id: Uuid::new_v4(),
    workspace_id: Uuid::new_v4(),
    projection_version: "test".to_string(),
    metadata_revision: 1,
    metadata_updated_at: None,
    metadata_updated_by: None,
    system: DocumentMetadataSystemFacts {
      created_at: Utc::now(),
      updated_at: Utc::now(),
      created_by: None,
      updated_by: None,
      metadata_updated_at: None,
      metadata_updated_by: None,
    },
    fields,
    audience: Vec::<DocumentMetadataAudience>::new(),
    template: None,
    journal: myoxus_domain::entities::DocumentMetadataJournal { journal_date: None },
    presentation: None,
    integration: None,
    policy: DocumentMetadataPolicy::default(),
  }
}

#[test]
fn document_metadata_validation_uses_native_projection_for_required_by_status() {
  let service = DocumentMetadataValidationService::new();
  let def = definition(
    "classification",
    "by_status",
    "optional",
    serde_json::json!({ "requiredWhenStatusSet": true }),
  );

  let without_status = service.validate(
    std::slice::from_ref(&def),
    &projection(Vec::new()),
    DocumentMetadataAction::Read,
  );
  assert!(
    without_status.valid(),
    "by_status must not fire when the native status projection is missing"
  );

  let with_status = service.validate(
    &[def],
    &projection(vec![reference_field("status", Some("in_progress"))]),
    DocumentMetadataAction::Read,
  );
  assert!(!with_status.valid());
  assert_eq!(with_status.missing_required_metadata_fields, vec!["classification"]);
  assert_eq!(
    with_status.errors[0].code,
    DocumentMetadataValidationCode::DocumentMetadataRequired
  );
}

#[test]
fn document_metadata_validation_uses_native_projection_for_validity_and_share_policy() {
  let service = DocumentMetadataValidationService::new();
  let mut valid_until = reference_field("validUntil", None);
  valid_until.timestamp_value = Some(Utc::now() - Duration::days(1));
  let projection = projection(vec![reference_field("classification", Some("restricted")), valid_until]);

  let read_validation = service.validate(&[], &projection, DocumentMetadataAction::Read);
  assert!(read_validation.valid());
  assert_eq!(
    read_validation.warnings[0].severity,
    DocumentMetadataValidationSeverity::Warning
  );

  let export_validation = service.validate(&[], &projection, DocumentMetadataAction::ExportPdf);
  assert!(!export_validation.valid());
  assert!(export_validation.blocked_actions.contains(&"export_pdf".to_string()));

  let share_validation = service.validate(&[], &projection, DocumentMetadataAction::SharePublic);
  assert!(!share_validation.valid());
  assert_eq!(
    share_validation.errors[0].code,
    DocumentMetadataValidationCode::DocumentClassificationBlocksShare
  );
}
