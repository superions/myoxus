// SPDX-License-Identifier: AGPL-3.0-or-later
//! Anonymous metadata admission belongs to Application, before ordering and IR.

use super::{OverviewDocument, OverviewPage};
use myoxus_domain::entities::DocumentMetadataFieldDefinition;
use myoxus_domain::workspace_overview::{OverviewOrderBy, OverviewRegisterPresentation, WorkspaceOverviewSettings};
use myoxus_public_render::WorkspaceRegisterValue;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn admit_public_presentation(
  settings: &mut WorkspaceOverviewSettings,
  definitions: &[DocumentMetadataFieldDefinition],
) {
  admit_export_presentation(settings, definitions, false);
}

/// Export-field admission is shared; anonymous publishing additionally omits
/// people. Neither policy grants document access or changes persisted settings.
pub(super) fn admit_export_presentation(
  settings: &mut WorkspaceOverviewSettings,
  definitions: &[DocumentMetadataFieldDefinition],
  allow_people: bool,
) {
  let visible = definitions
    .iter()
    .filter(|field| crate::public::document_metadata_export_visible(field) && field.visible_in_lists)
    .map(|field| field.key.as_str())
    .chain(["title", "tags"])
    .filter(|key| allow_people || *key != "createdBy")
    .collect::<BTreeSet<_>>();
  let admit = |value: Option<OverviewRegisterPresentation>| {
    let mut value = value.unwrap_or_default();
    value
      .display_properties
      .retain(|key| key.strip_prefix("system:").is_some_and(|key| visible.contains(key)));
    // Hidden/unselected columns must not disclose their values through ordering.
    if !value
      .display_properties
      .contains(&format!("system:{}", value.order_by.key))
    {
      value.order_by = OverviewOrderBy {
        property_type: "system".into(),
        key: "title".into(),
        desc: false,
      };
    }
    value
  };
  settings.register_presentation = Some(admit(settings.register_presentation.take()));
  for folder in settings.folders.values_mut() {
    if let Some(value) = folder.register_presentation.take() {
      folder.register_presentation = Some(admit(Some(value)));
    }
  }
}

/// Consume only pages that passed the appropriate export-field admission
/// (anonymous public or authorized Git), never raw authenticated presentation.
pub fn public_register_columns(page: &OverviewPage) -> Vec<String> {
  page
    .register_presentation
    .as_ref()
    .map_or_else(Vec::new, |presentation| {
      presentation
        .display_properties
        .iter()
        .map(|key| key.trim_start_matches("system:").to_string())
        .collect()
    })
}

/// Values correspond only to the admitted columns. Each adapter retains its
/// existing link/path owner; this function never discovers or sorts documents.
pub fn public_register_values(
  document: &OverviewDocument,
  page: &OverviewPage,
) -> BTreeMap<String, WorkspaceRegisterValue> {
  let mut values = BTreeMap::new();
  for key in public_register_columns(page) {
    let row = document.register.as_ref();
    let text = |value: Option<String>| value.map(WorkspaceRegisterValue::Text);
    let value = match key.as_str() {
      "updatedAt" => Some(WorkspaceRegisterValue::Timestamp(document.updated_at)),
      "createdAt" => row.map(|row| WorkspaceRegisterValue::Timestamp(row.created_at)),
      "tags" => row.map(|row| WorkspaceRegisterValue::Labels(row.tags.iter().map(|tag| tag.name.clone()).collect())),
      "status" => text(row.and_then(|row| row.labels.status_label.clone())),
      "documentType" => text(row.and_then(|row| row.labels.document_type_label.clone())),
      "classification" => text(row.and_then(|row| row.labels.classification_label.clone())),
      "version" => row.map(|row| WorkspaceRegisterValue::Version {
        label: row.labels.version_label.clone(),
        dirty: row.metadata.dirty_since_current_version,
      }),
      "reviewDueAt" => row
        .and_then(|row| row.metadata.review_due_at)
        .map(WorkspaceRegisterValue::Timestamp),
      "validUntil" => row
        .and_then(|row| row.metadata.valid_until)
        .map(WorkspaceRegisterValue::Timestamp),
      _ => None,
    };
    if let Some(value) = value {
      values.insert(key, value);
    }
  }
  values
}
