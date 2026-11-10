// SPDX-License-Identifier: AGPL-3.0-or-later
//! Transaction-owned facts and immutable native field captures.
//!
//! The caller establishes its repeatable-read snapshot and document locks before
//! entering this module. Nothing here changes the live document or sync stream.

use std::collections::BTreeMap;

use myoxus_application::{
  auth::{AuthError, AuthResult, EffectiveUserPreferences, UserPreferenceDefaults, UserPreferences},
  document_fields::{
    context::{DocumentFieldContext, DocumentFieldFacts, FieldIdentity},
    output::PreparedFieldOutput,
    validate,
  },
};
use myoxus_domain::entities::{DocumentMetadataReferenceValue, DocumentVersion};
use sqlx::{PgConnection, Row};
use uuid::Uuid;
use yjs::document_field::{DocumentField, MetadataKey};

use crate::{document_metadata::PgDocumentMetadataRepository, document_version::PgDocumentVersionRepository};

fn unavailable() -> AuthError {
  AuthError::Storage("document field capture context unavailable".into())
}

fn unavailable_at(phase: &'static str) -> AuthError {
  AuthError::Storage(format!("document field capture unavailable: {phase}"))
}

/// One capture's admitted descriptors and facts; no database read happens while
/// transforming its independent output copy or comparing it with the last version.
pub(crate) struct FieldCapture {
  fields: Vec<DocumentField>,
  facts: DocumentFieldFacts,
  preferences: EffectiveUserPreferences,
  revision: String,
}

impl FieldCapture {
  #[tracing::instrument(skip_all)]
  pub(crate) async fn load(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    doc_id: Uuid,
    actor: Option<Uuid>,
    base_locale: &str,
    snapshot: &[u8],
  ) -> AuthResult<Option<Self>> {
    // Yjs V1 writes format keys as literal UTF-8. A negative is safe and
    // preserves the existing empty/field-free history bytes and fast path.
    if !snapshot
      .windows(yjs::document_field::FIELD_ATTRIBUTE.len())
      .any(|bytes| bytes == yjs::document_field::FIELD_ATTRIBUTE.as_bytes())
    {
      return Ok(None);
    }
    let occurrences =
      yjs::document_field::content::inspect(snapshot).map_err(|_| unavailable_at("native admission"))?;
    if occurrences.is_empty() {
      return Ok(None);
    }
    // A marker from a live client is not historical authority. Current content
    // must be reactivated by its explicit native owner, never trusted as frozen.
    if occurrences.iter().any(|occurrence| occurrence.run.captured) {
      return Err(unavailable_at("unexpected captured source"));
    }
    let fields = occurrences
      .iter()
      .map(|occurrence| validate(&occurrence.run.descriptor))
      .collect::<Result<Vec<_>, _>>()?;
    let revision =
      myoxus_application::doc::canonical_yjs_revision(snapshot).map_err(|_| unavailable_at("source revision"))?;

    let locale: Option<serde_json::Value> =
      sqlx::query_scalar("SELECT value FROM app_configs WHERE id='i18n.default_locale'")
        .fetch_optional(&mut *conn)
        .await
        .map_err(|_| unavailable_at("configuration read"))?;
    let locale = match locale {
      Some(value) => value
        .as_str()
        .ok_or_else(|| unavailable_at("configuration value"))?
        .to_owned(),
      None => base_locale.to_owned(),
    };
    let defaults = UserPreferenceDefaults {
      locale,
      ..Default::default()
    };
    let preferences = if let Some(actor) = actor {
      let values: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT values FROM user_preferences WHERE user_id=$1")
          .bind(actor)
          .fetch_optional(&mut *conn)
          .await
          .map_err(|_| unavailable_at("preferences read"))?;
      let preferences: UserPreferences = values
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| unavailable_at("preferences decode"))?
        .unwrap_or_default();
      preferences
        .validate()
        .map_err(|_| unavailable_at("preferences validation"))?;
      preferences.resolve(&defaults)
    } else {
      UserPreferences::default().resolve(&defaults)
    };

    let keys = fields
      .iter()
      .filter_map(|field| match field {
        DocumentField::Metadata { key, .. } => Some(*key),
        _ => None,
      })
      .collect::<Vec<_>>();
    let mut facts = DocumentFieldFacts {
      workspace_id,
      doc_id,
      title: None,
      metadata: None,
      current_version: None,
      identities: BTreeMap::new(),
    };
    if keys.contains(&MetadataKey::Title) {
      facts.title = Some(
        sqlx::query_scalar("SELECT title FROM docs WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL")
          .bind(doc_id)
          .bind(workspace_id)
          .fetch_optional(&mut *conn)
          .await
          .map_err(|_| unavailable_at("title read"))?
          .ok_or_else(|| unavailable_at("title missing"))?,
      );
    }
    if keys.iter().any(|key| *key != MetadataKey::Title) {
      let (projection_version, mut metadata) =
        PgDocumentMetadataRepository::get_projection_versioned_in_tx(&mut *conn, doc_id, workspace_id)
          .await
          .map_err(|_| unavailable_at("metadata projection read"))?
          .ok_or_else(|| unavailable_at("metadata projection missing"))?;
      metadata.projection_version = projection_version;
      if keys.contains(&MetadataKey::VersionNumber)
        && let Some(id) = metadata
          .fields
          .iter()
          .find(|field| field.key == "version")
          .and_then(|field| field.reference.as_ref())
          .map(|value| value.id)
      {
        facts.current_version = PgDocumentVersionRepository::get_in_tx(&mut *conn, id)
          .await
          .map_err(|_| unavailable_at("version read"))?;
      }
      let mut ids = Vec::new();
      for key in &keys {
        let id = match key {
          MetadataKey::Responsible => metadata
            .fields
            .iter()
            .find(|field| field.key == "responsible")
            .and_then(|field| field.user_id),
          MetadataKey::CreatedBy => metadata.system.created_by,
          MetadataKey::UpdatedBy => metadata.system.updated_by,
          _ => None,
        };
        if let Some(id) = id
          && !ids.contains(&id)
        {
          ids.push(id);
        }
      }
      if !ids.is_empty() {
        let rows = sqlx::query("SELECT id,name,email FROM users WHERE id=ANY($1) AND status<>'deleted'")
          .bind(&ids)
          .fetch_all(&mut *conn)
          .await
          .map_err(|_| unavailable_at("identity read"))?;
        for row in rows {
          facts.identities.insert(
            row.try_get("id").map_err(|_| unavailable())?,
            FieldIdentity {
              name: row.try_get("name").map_err(|_| unavailable())?,
              email: row.try_get("email").map_err(|_| unavailable())?,
            },
          );
        }
      }
      facts.metadata = Some(metadata);
    }
    Ok(Some(Self {
      fields,
      facts,
      preferences,
      revision,
    }))
  }

  fn context(&self, named: Option<&DocumentVersion>) -> AuthResult<DocumentFieldContext> {
    let mut facts = self.facts.clone();
    if let Some(version) = named
      && let Some(metadata) = &mut facts.metadata
    {
      let field = metadata
        .fields
        .iter_mut()
        .find(|field| field.key == "version")
        .ok_or_else(unavailable)?;
      field.reference = Some(DocumentMetadataReferenceValue {
        id: version.id,
        key: version.version_no.ok_or_else(unavailable)?.to_string(),
        label: version.label.clone(),
        is_active: true,
      });
      field.text_value = Some("current".into());
      facts.current_version = Some(version.clone());
    }
    DocumentFieldContext::new(facts, self.revision.clone(), self.preferences.clone()).map_err(Into::into)
  }

  /// Compare the live content and displayed facts without a version/head loop.
  /// Only the digest is retained in the existing version metadata, never answers.
  pub(crate) fn comparison(&self) -> AuthResult<String> {
    let context = self.context(None)?;
    let output = PreparedFieldOutput::prepare(&context, &self.fields)?;
    output.latest_comparison(&self.fields).map_err(Into::into)
  }

  /// Exclude the head transition caused by capture itself, but not an operator
  /// renaming the current version. Its frozen body is immutable, so a displayed
  /// version field must still agree with the current head before skipping.
  pub(crate) fn version_matches_frozen(&self, snapshot: &[u8], version_id: Uuid) -> AuthResult<bool> {
    let wanted = self
      .fields
      .iter()
      .filter_map(|field| match field {
        DocumentField::Metadata {
          id,
          key: key @ (MetadataKey::VersionLabel | MetadataKey::VersionNumber),
          ..
        } => Some((id, key)),
        _ => None,
      })
      .collect::<Vec<_>>();
    if wanted.is_empty() {
      return Ok(true);
    }
    let reference = self
      .facts
      .metadata
      .as_ref()
      .and_then(|metadata| metadata.fields.iter().find(|field| field.key == "version"))
      .and_then(|field| field.reference.as_ref());
    let Some(reference) = reference.filter(|reference| reference.id == version_id) else {
      return Ok(false);
    };
    let mut captured = BTreeMap::<String, String>::new();
    for occurrence in
      yjs::document_field::content::inspect(snapshot).map_err(|_| unavailable_at("historical admission"))?
    {
      if !occurrence.run.captured {
        return Ok(false);
      }
      captured
        .entry(occurrence.run.descriptor.id().to_string())
        .or_default()
        .push_str(&occurrence.run.text);
    }
    Ok(wanted.iter().all(|(id, key)| {
      captured.get(*id).is_some_and(|text| match key {
        MetadataKey::VersionLabel => text == &reference.label,
        MetadataKey::VersionNumber => text == &reference.key,
        _ => false,
      })
    }))
  }

  /// Freeze into a detached history snapshot. An unavailable fact aborts the
  /// owning transaction before history, counters or metadata heads can commit.
  pub(crate) fn freeze(&self, snapshot: &[u8], named: Option<&DocumentVersion>) -> AuthResult<Vec<u8>> {
    let context = self.context(named)?;
    yjs::document_field::content::map(snapshot, |run| {
      let field = validate(&run.descriptor).map_err(|_| "invalid native document field")?;
      let text = context
        .present(&field)
        .map_err(|_| "document field context unavailable")?
        .text
        .ok_or("document field context unavailable")?;
      run.with_descriptor(field)?.freeze(text)
    })
    .map(|output| output.state)
    .map_err(|reason| AuthError::Storage(format!("document field capture transformation failed: {reason}")))
  }
}
