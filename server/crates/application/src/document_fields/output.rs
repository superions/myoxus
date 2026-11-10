// SPDX-License-Identifier: AGPL-3.0-or-later
//! Transient native output copies. These bytes are never a persistence update.

use super::{DocumentFieldError, context::DocumentFieldContext, validate_snapshot};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;
use yjs::document_field::{DocumentField, MetadataKey};

/// Server-owned presentation inputs for one deferred format render. This is
/// stored only with that render job, never as canonical input answers or live
/// Yjs. The exact source revision fences the worker against later document edits.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedFieldOutput {
  pub freshness: super::context::FieldFreshness,
  values: BTreeMap<String, String>,
}

impl PreparedFieldOutput {
  pub fn prepare(context: &DocumentFieldContext, fields: &[DocumentField]) -> Result<Self, DocumentFieldError> {
    let values = fields
      .iter()
      .map(|field| {
        let value = context
          .present(field)?
          .text
          .ok_or(DocumentFieldError::ContextUnavailable)?;
        Ok((field.id().to_string(), value))
      })
      .collect::<Result<_, DocumentFieldError>>()?;
    Ok(Self {
      freshness: context.freshness().clone(),
      values,
    })
  }

  pub fn apply(&self, snapshot: &[u8], workspace_id: Uuid, doc_id: Uuid) -> Result<Vec<u8>, DocumentFieldError> {
    validate_snapshot(snapshot)?;
    if self.freshness.workspace_id != workspace_id
      || self.freshness.doc_id != doc_id
      || crate::doc::canonical_yjs_revision(snapshot).map_err(|_| DocumentFieldError::InvalidField)?
        != self.freshness.content_revision
    {
      return Err(DocumentFieldError::ContextUnavailable);
    }
    yjs::document_field::content::project_text(snapshot, |field| {
      self
        .values
        .get(field.id())
        .cloned()
        .ok_or("document field output unavailable")
    })
    .map_err(|_| DocumentFieldError::ContextUnavailable)
  }

  /// Qualify a latest-export retry against the actual captured body, including
  /// version labels/numbers and working-copy text. The broad retry key alone
  /// cannot distinguish its own head change from a later intentional rename.
  pub fn matches_frozen(&self, snapshot: &[u8]) -> Result<bool, DocumentFieldError> {
    historical_snapshot(snapshot)?;
    let mut captured = BTreeMap::<String, String>::new();
    for field in yjs::document_field::content::inspect(snapshot).map_err(|_| DocumentFieldError::InvalidField)? {
      captured
        .entry(field.run.descriptor.id().to_string())
        .or_default()
        .push_str(&field.run.text);
    }
    Ok(captured == self.values)
  }

  /// The existing latest-export retry key excludes version/head changes caused
  /// by its own auto-capture. Keep actual source, other displayed values, profile
  /// facts and formatting, without creating a self-triggering version loop.
  pub fn latest_comparison(&self, fields: &[DocumentField]) -> Result<String, DocumentFieldError> {
    use sha2::{Digest, Sha256};
    let mut values = self.values.clone();
    for field in fields {
      if matches!(
        field,
        DocumentField::Metadata {
          key: MetadataKey::VersionLabel | MetadataKey::VersionNumber,
          ..
        }
      ) {
        values.remove(field.id());
      }
    }
    let input = serde_json::to_vec(&(
      &self.freshness.content_revision,
      &self.freshness.title_digest,
      &self.freshness.identity_digest,
      &self.freshness.locale,
      &self.freshness.timezone,
      &self.freshness.date_format,
      &self.freshness.time_format,
      values,
    ))
    .map_err(|_| DocumentFieldError::ContextUnavailable)?;
    Ok(hex::encode(Sha256::digest(input)))
  }
}

/// Resolve current facts into an independent native copy for existing format
/// adapters. Neither stored text nor an untrusted capture marker can override
/// current field values. Keep the original capture for native reads/restoration.
pub fn current_snapshot(snapshot: &[u8], context: &DocumentFieldContext) -> Result<Vec<u8>, DocumentFieldError> {
  validate_snapshot(snapshot)?;
  if crate::doc::canonical_yjs_revision(snapshot).map_err(|_| DocumentFieldError::InvalidField)?
    != context.freshness().content_revision
  {
    return Err(DocumentFieldError::ContextUnavailable);
  }
  yjs::document_field::content::project_text(snapshot, |field| {
    let output = context
      .present(field)
      .map_err(|_| "document field output unavailable")?;
    let text = output.text.ok_or("document field context unavailable")?;
    Ok(text)
  })
  .map_err(|_| DocumentFieldError::ContextUnavailable)
}

/// Only authoritative history/version readers select this path. Frozen text is
/// immutable and no present-day metadata, identity or preference is consulted.
/// A live descriptor in a historical capture is unavailable, never refreshed.
pub fn historical_snapshot(snapshot: &[u8]) -> Result<&[u8], DocumentFieldError> {
  // Pre-field empty captures contain no descriptors. The format owner retains
  // its existing empty-source behavior; field admission must not reinterpret it.
  if snapshot.is_empty() {
    return Ok(snapshot);
  }
  validate_snapshot(snapshot)?;
  if yjs::document_field::content::inspect(snapshot)
    .map_err(|_| DocumentFieldError::InvalidField)?
    .iter()
    .any(|field| !field.run.captured)
  {
    return Err(DocumentFieldError::ContextUnavailable);
  }
  Ok(snapshot)
}
