// SPDX-License-Identifier: AGPL-3.0-or-later
//! Canonical register facts and ordering over an already authorized inventory.

use std::cmp::Ordering;

use chrono::{DateTime, Utc};
use myoxus_domain::entities::DocumentMetadataIndexRow;
use myoxus_domain::workspace_overview::OverviewRegisterPresentation;
use myoxus_domain::workspace_tags::WorkspaceTag;
use uuid::Uuid;

use super::OverviewDocument;

/// A request-local join, not another index or document property owner. Metadata
/// retains its canonical IDs; adapters reuse existing label/date formatters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverviewRegisterFacts {
  pub metadata: DocumentMetadataIndexRow,
  pub labels: myoxus_domain::entities::DocumentMetadataIndexLabels,
  pub created_at: DateTime<Utc>,
  pub created_by_name: Option<String>,
  pub tag_ids: Vec<Uuid>,
  pub tags: Vec<WorkspaceTag>,
  pub can_publish: bool,
}

pub(super) fn sort_documents(documents: &mut [OverviewDocument], presentation: Option<&OverviewRegisterPresentation>) {
  let key = presentation.map_or("updatedAt", |value| value.order_by.key.as_str());
  let descending = presentation.is_none_or(|value| value.order_by.desc);
  if key == "tags" {
    // Cache the ephemeral ordering key once per row, preserving assignment order
    // in the actual Tag projection and avoiding allocation per comparison.
    if descending {
      documents
        .sort_by_cached_key(|document| (std::cmp::Reverse(tag_sort_value(document)), document.reference.clone()));
    } else {
      documents.sort_by_cached_key(|document| (tag_sort_value(document), document.reference.clone()));
    }
    return;
  }
  documents.sort_by(|left, right| {
    // Explorer excludes missing creators from its ordered IDs and appends them
    // afterwards, regardless of direction. Do not reverse that missing bucket.
    if key == "createdBy" {
      let missing = id_value(left, key).is_none().cmp(&id_value(right, key).is_none());
      if missing != Ordering::Equal {
        return missing;
      }
    }
    let comparison = compare(left, right, key);
    (if descending { comparison.reverse() } else { comparison }).then_with(|| left.reference.cmp(&right.reference))
  });
}

fn compare(left: &OverviewDocument, right: &OverviewDocument, key: &str) -> Ordering {
  match key {
    // Explorer title/creator providers use lexical values, not display labels.
    "title" => left.title.encode_utf16().cmp(right.title.encode_utf16()),
    "updatedAt" => left.updated_at.cmp(&right.updated_at),
    "createdAt" => left
      .register
      .as_ref()
      .map(|row| row.created_at)
      .cmp(&right.register.as_ref().map(|row| row.created_at)),
    "createdBy" | "documentType" | "status" | "classification" | "version" => {
      id_value(left, key).cmp(&id_value(right, key))
    }
    "reviewDueAt" => left
      .register
      .as_ref()
      .and_then(|row| row.metadata.review_due_at)
      .cmp(&right.register.as_ref().and_then(|row| row.metadata.review_due_at)),
    "validUntil" => left
      .register
      .as_ref()
      .and_then(|row| row.metadata.valid_until)
      .cmp(&right.register.as_ref().and_then(|row| row.metadata.valid_until)),
    _ => Ordering::Equal,
  }
}

fn id_value(document: &OverviewDocument, key: &str) -> Option<Uuid> {
  let metadata = &document.register.as_ref()?.metadata;
  match key {
    "createdBy" => metadata.created_by,
    "documentType" => metadata.document_type_id,
    "status" => metadata.status_id,
    "classification" => metadata.classification_id,
    "version" => metadata.current_version_id,
    _ => None,
  }
}

fn tag_sort_value(document: &OverviewDocument) -> String {
  let Some(row) = &document.register else {
    return String::new();
  };
  // Match Explorer's tag-ID ordering; labels and assignment order are not keys.
  let mut ids = row.tag_ids.clone();
  ids.sort_unstable();
  ids.iter().map(Uuid::to_string).collect::<Vec<_>>().join(",")
}
