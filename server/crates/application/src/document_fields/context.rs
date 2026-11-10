// SPDX-License-Identifier: AGPL-3.0-or-later
//! One operation's authorized facts, shared by live output and atomic captures.

use std::{
  collections::BTreeMap,
  sync::{Arc, LazyLock},
};

use myoxus_domain::{
  entities::{DocumentMetadataProjection, DocumentVersion},
  repositories::DocumentVersionRepository,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use yjs::document_field::{DocumentField, MetadataFormat, MetadataKey};

use super::{DocumentFieldError, present_input, validate};
use crate::{
  auth::{AuthError, AuthResult, AuthStore, EffectiveUserPreferences, UserPreferenceDefaults, UserPreferences},
  doc::DocService,
  document_metadata::{DocumentMetadataProjectionMode, DocumentMetadataService},
};

/// Only the public identity projection needed by a field. Credential-adjacent
/// AuthUser objects never enter this context, its fingerprints or output.
#[derive(Clone, Serialize)]
pub struct FieldIdentity {
  pub name: Option<String>,
  pub email: String,
}

/// The caller authorizes the containing document before collecting facts. SQL
/// capture owners construct these from their own transaction snapshot, not from
/// a cached Application read made before that transaction.
#[derive(Clone)]
pub struct DocumentFieldFacts {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub title: Option<String>,
  pub metadata: Option<DocumentMetadataProjection>,
  pub current_version: Option<DocumentVersion>,
  pub identities: BTreeMap<Uuid, FieldIdentity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldValueState {
  Value,
  Unset,
  Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldPresentation {
  pub state: FieldValueState,
  /// Unset has readable localized text; unavailable has no invented value.
  pub text: Option<String>,
  pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldFreshness {
  pub workspace_id: Uuid,
  pub doc_id: Uuid,
  pub content_revision: String,
  pub metadata_projection_version: Option<String>,
  /// Covers the actual named pointer, number/label and working-copy state.
  pub version_digest: String,
  pub title_digest: String,
  /// A metadata epoch alone does not attest name/email profile changes.
  pub identity_digest: String,
  pub locale: String,
  pub timezone: String,
  pub date_format: String,
  pub time_format: String,
}

pub struct DocumentFieldContext {
  facts: DocumentFieldFacts,
  preferences: EffectiveUserPreferences,
  freshness: FieldFreshness,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Messages {
  unset: String,
  no_version: String,
  unversioned_changes: String,
  changed_suffix: String,
}

static MESSAGES: LazyLock<BTreeMap<String, Messages>> = LazyLock::new(|| {
  serde_json::from_str(include_str!("messages.generated.json")).expect("generated field message catalog")
});

fn messages(locale: &str) -> &'static Messages {
  MESSAGES
    .get(locale)
    .or_else(|| MESSAGES.get(locale.split('-').next().unwrap_or(locale)))
    .unwrap_or_else(|| MESSAGES.get("en").expect("generated EN field messages"))
}

fn digest(value: &impl Serialize) -> Result<String, DocumentFieldError> {
  let value = serde_json::to_vec(value).map_err(|_| DocumentFieldError::ContextUnavailable)?;
  Ok(hex::encode(Sha256::digest(value)))
}

impl DocumentFieldContext {
  /// Checks ownership without inventing values for absent projections/identities.
  /// Missing facts remain explicit Unavailable results at resolution time.
  pub fn new(
    facts: DocumentFieldFacts,
    content_revision: String,
    preferences: EffectiveUserPreferences,
  ) -> Result<Self, DocumentFieldError> {
    let metadata = facts.metadata.as_ref();
    if content_revision.is_empty()
      || metadata
        .is_some_and(|projection| projection.doc_id != facts.doc_id || projection.workspace_id != facts.workspace_id)
    {
      return Err(DocumentFieldError::ContextUnavailable);
    }
    let version_field = metadata.and_then(|projection| projection.fields.iter().find(|field| field.key == "version"));
    let version_id = version_field
      .and_then(|field| field.reference.as_ref())
      .map(|reference| reference.id);
    if facts.current_version.as_ref().is_some_and(|version| {
      version.doc_id != facts.doc_id || version.workspace_id != facts.workspace_id || Some(version.id) != version_id
    }) {
      return Err(DocumentFieldError::ContextUnavailable);
    }
    let freshness = FieldFreshness {
      workspace_id: facts.workspace_id,
      doc_id: facts.doc_id,
      content_revision,
      metadata_projection_version: metadata.map(|projection| projection.projection_version.clone()),
      version_digest: digest(&(
        version_field,
        facts
          .current_version
          .as_ref()
          .map(|version| (version.id, version.version_no, version.label.as_str())),
      ))?,
      title_digest: digest(&facts.title)?,
      identity_digest: digest(&facts.identities)?,
      locale: preferences.locale.clone(),
      timezone: preferences.timezone.clone(),
      date_format: preferences.date_format.clone(),
      time_format: preferences.time_format.clone(),
    };
    Ok(Self {
      facts,
      preferences,
      freshness,
    })
  }

  pub fn freshness(&self) -> &FieldFreshness {
    &self.freshness
  }

  /// Already-authorized effective projection, reusable by badges/frontmatter in
  /// this same operation instead of taking a second potentially newer read.
  pub fn metadata(&self) -> Option<&DocumentMetadataProjection> {
    self.facts.metadata.as_ref()
  }

  /// Current resolution never reads stored display text or a capture marker.
  /// Historical readers consume frozen runs without calling this method.
  pub fn present(&self, field: &DocumentField) -> Result<FieldPresentation, DocumentFieldError> {
    let field = validate(field)?;
    let copy = messages(&self.preferences.locale);
    if matches!(field, DocumentField::Input { .. }) {
      let input = present_input(&field, &self.preferences)?;
      let text = input.text.filter(|value| !value.is_empty());
      return Ok(FieldPresentation {
        state: if text.is_some() {
          FieldValueState::Value
        } else {
          FieldValueState::Unset
        },
        text: Some(text.unwrap_or_else(|| copy.unset.clone())),
        complete: input.complete,
      });
    }
    let DocumentField::Metadata { key, format, .. } = field else {
      unreachable!()
    };
    let value = self.metadata_value(key, format)?;
    Ok(match value {
      MetadataValue::Unavailable => FieldPresentation {
        state: FieldValueState::Unavailable,
        text: None,
        complete: false,
      },
      MetadataValue::Text(value) if !value.is_empty() => FieldPresentation {
        state: FieldValueState::Value,
        text: Some(value),
        complete: true,
      },
      _ => FieldPresentation {
        state: FieldValueState::Unset,
        text: Some(if key == MetadataKey::VersionLabel {
          copy.no_version.clone()
        } else {
          copy.unset.clone()
        }),
        complete: true,
      },
    })
  }

  fn metadata_value(&self, key: MetadataKey, format: MetadataFormat) -> Result<MetadataValue, DocumentFieldError> {
    use MetadataKey as Key;
    if key == Key::Title {
      return Ok(
        self
          .facts
          .title
          .clone()
          .map_or(MetadataValue::Unavailable, MetadataValue::Text),
      );
    }
    let Some(projection) = &self.facts.metadata else {
      return Ok(MetadataValue::Unavailable);
    };
    let field = |key: &str| projection.fields.iter().find(|field| field.key == key);
    let label = |key: &str| {
      field(key)
        .and_then(|field| field.reference.as_ref())
        .map(|reference| reference.label.clone())
    };
    let text = match key {
      Key::Title => unreachable!(),
      Key::VersionLabel => {
        let copy = messages(&self.preferences.locale);
        let version = field("version");
        let dirty = version.and_then(|field| field.text_value.as_deref()) == Some("dirty");
        match (label("version"), dirty) {
          (Some(label), true) => Some(format!("{label} ({})", copy.changed_suffix)),
          (label @ Some(_), false) => label,
          (None, true) => Some(copy.unversioned_changes.clone()),
          (None, false) => None,
        }
      }
      Key::VersionNumber => {
        if field("version").and_then(|field| field.reference.as_ref()).is_none() {
          None
        } else if let Some(number) = self
          .facts
          .current_version
          .as_ref()
          .and_then(|version| version.version_no)
        {
          Some(number.to_string())
        } else {
          return Ok(MetadataValue::Unavailable);
        }
      }
      Key::DocumentType => label("documentType"),
      Key::Status => label("status"),
      Key::Classification => label("classification"),
      Key::Language => label("language"),
      Key::RetentionPolicy => label("retentionPolicy"),
      Key::Audience => Some(
        projection
          .audience
          .iter()
          .map(|entry| entry.value.label.as_str())
          .collect::<Vec<_>>()
          .join(", "),
      ),
      Key::DocumentNumber => field("documentNumber").and_then(|field| field.text_value.clone()),
      Key::Responsible | Key::CreatedBy | Key::UpdatedBy => {
        let id = match key {
          Key::Responsible => field("responsible").and_then(|field| field.user_id),
          Key::CreatedBy => projection.system.created_by,
          Key::UpdatedBy => projection.system.updated_by,
          _ => unreachable!(),
        };
        let Some(id) = id else {
          return Ok(MetadataValue::Unset);
        };
        let Some(identity) = self.facts.identities.get(&id) else {
          return Ok(MetadataValue::Unavailable);
        };
        let text = if format == MetadataFormat::Email {
          Some(identity.email.as_str())
        } else {
          identity.name.as_deref()
        };
        let Some(text) = text.filter(|text| !text.is_empty()) else {
          return Ok(MetadataValue::Unavailable);
        };
        Some(text.to_string())
      }
      Key::CreatedAt | Key::UpdatedAt | Key::ReviewDueAt | Key::ValidFrom | Key::ValidUntil => {
        let instant = match key {
          Key::CreatedAt => Some(projection.system.created_at),
          Key::UpdatedAt => Some(projection.system.updated_at),
          Key::ReviewDueAt => field("reviewDueAt").and_then(|field| field.timestamp_value),
          Key::ValidFrom => field("validFrom").and_then(|field| field.timestamp_value),
          Key::ValidUntil => field("validUntil").and_then(|field| field.timestamp_value),
          _ => unreachable!(),
        };
        instant
          .map(|instant| {
            let unavailable = |_| DocumentFieldError::FormattingUnavailable;
            Ok(match format {
              MetadataFormat::Date => crate::regional::date_value(instant, &self.preferences).map_err(unavailable)?,
              MetadataFormat::Time => crate::regional::time_value(instant, &self.preferences).map_err(unavailable)?,
              MetadataFormat::Datetime => format!(
                "{}, {}",
                crate::regional::date_value(instant, &self.preferences).map_err(unavailable)?,
                crate::regional::time_value(instant, &self.preferences).map_err(unavailable)?
              ),
              _ => return Err(DocumentFieldError::InvalidField),
            })
          })
          .transpose()?
      }
    };
    Ok(text.map_or(MetadataValue::Unset, MetadataValue::Text))
  }
}

enum MetadataValue {
  Text(String),
  Unset,
  Unavailable,
}

/// Operation adapters provide live configured defaults; captured history owners
/// use the pure context directly from their transaction and do not call this port.
#[async_trait::async_trait]
pub trait DocumentFieldContextSource: Send + Sync {
  async fn resolve_authorized(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    content_revision: String,
    fields: &[DocumentField],
    actor_id: Option<Uuid>,
  ) -> AuthResult<DocumentFieldContext>;
}

#[derive(Clone)]
pub struct DocumentFieldResolver {
  pub(crate) metadata: DocumentMetadataService,
  pub(crate) versions: Arc<dyn DocumentVersionRepository>,
  pub(crate) auth: Arc<dyn AuthStore>,
  pub(crate) documents: DocService,
  pub(crate) defaults: UserPreferenceDefaults,
}

impl DocumentFieldResolver {
  pub fn new(
    metadata: DocumentMetadataService,
    versions: Arc<dyn DocumentVersionRepository>,
    auth: Arc<dyn AuthStore>,
    documents: DocService,
    defaults: UserPreferenceDefaults,
  ) -> Self {
    Self {
      metadata,
      versions,
      auth,
      documents,
      defaults,
    }
  }

  /// Full output owners already own a bounded, complete capture. Field-free
  /// output reuses its exact bytes without reading preferences or metadata.
  /// Bounded excerpts must instead resolve only their extracted descriptors.
  #[tracing::instrument(skip_all)]
  pub async fn project_authorized(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    content_revision: String,
    snapshot: &[u8],
    actor_id: Option<Uuid>,
  ) -> AuthResult<(Vec<u8>, Option<FieldFreshness>)> {
    let occurrences = yjs::document_field::content::inspect(snapshot).map_err(|_| DocumentFieldError::InvalidField)?;
    if occurrences.is_empty() {
      return Ok((snapshot.to_vec(), None));
    }
    let fields = occurrences
      .into_iter()
      .map(|field| field.run.descriptor)
      .collect::<Vec<_>>();
    let context = self
      .resolve_authorized(workspace_id, doc_id, content_revision, &fields, actor_id)
      .await?;
    let output = super::output::current_snapshot(snapshot, &context)?;
    Ok((output, Some(context.freshness().clone())))
  }

  /// Called only after the existing private/public read policy authorized this
  /// exact document. No viewer's member inventory, source document or per-field
  /// request is consulted. Actorless reads use configured product defaults.
  #[tracing::instrument(skip_all)]
  pub async fn resolve_authorized(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    content_revision: String,
    fields: &[DocumentField],
    actor_id: Option<Uuid>,
  ) -> AuthResult<DocumentFieldContext> {
    for field in fields {
      validate(field)?;
    }
    let preferences = if let Some(actor) = actor_id {
      self
        .auth
        .get_user_preferences(actor)
        .await?
        .values
        .resolve(&self.defaults)
    } else {
      UserPreferences::default().resolve(&self.defaults)
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
      let doc = self
        .documents
        .get_doc_metadata(doc_id)
        .await?
        .filter(|doc| doc.workspace_id == Some(workspace_id) && doc.deleted_at.is_none())
        .ok_or_else(|| AuthError::NotFound("document".into()))?;
      facts.title = Some(doc.title);
    }
    if keys.iter().any(|key| *key != MetadataKey::Title) {
      let metadata = self
        .metadata
        .get_projection(doc_id, workspace_id, DocumentMetadataProjectionMode::MyoxusNative)
        .await
        .map_err(|_| DocumentFieldError::ContextUnavailable)?;
      if keys.contains(&MetadataKey::VersionNumber)
        && let Some(id) = metadata
          .fields
          .iter()
          .find(|field| field.key == "version")
          .and_then(|field| field.reference.as_ref())
          .map(|value| value.id)
      {
        facts.current_version = self
          .versions
          .get(id)
          .await
          .map_err(|_| DocumentFieldError::ContextUnavailable)?;
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
        facts.identities = self
          .auth
          .get_users_by_ids(&ids)
          .await?
          .into_iter()
          .map(|(id, user)| {
            (
              id,
              FieldIdentity {
                name: user.name,
                email: user.email,
              },
            )
          })
          .collect();
      }
      facts.metadata = Some(metadata);
    }
    DocumentFieldContext::new(facts, content_revision, preferences).map_err(Into::into)
  }
}
