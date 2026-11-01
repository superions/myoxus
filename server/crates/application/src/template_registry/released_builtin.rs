// SPDX-License-Identifier: AGPL-3.0-or-later

//! Private release cutover. Ordinary imports never acquire this authority.

use myoxus_domain::ids::{DocId, WorkspaceId};
use myoxus_domain::template_registry::{InstanceState, RevisionState, SelectionMode, TemplateSource};
use tracing::instrument;
use uuid::Uuid;

use super::{TemplateRegistryService, bundle, compute_content_hash};
use crate::auth::{AuthError, AuthResult};

/// Frozen deployed identities for the builtin cutover, not the active catalog.
/// New native guides are declared in Basis without extending this migration set.
// TODO(TS-BUILTIN-01): Remove this set and the legacy adoption path after both production
// environments have migrated; todo/template-system.md owns the removal gate.
pub fn released_system_baseline_version(slug: &str) -> Option<&'static str> {
  matches!(
    slug,
    "business-daily"
      | "eisenhower"
      | "time-blocking"
      | "gtd-weekly-review"
      | "hybrid-day-sprint"
      | "personal-journal"
      | "agile-standup"
      | "agile-retro"
      | "meeting-notes"
      | "welcome-myoxus"
      | "getting-started-myoxus"
      | "using-folders-myoxus"
      | "meeting-templates-myoxus"
      | "databases-guide-myoxus"
  )
  .then_some("1.0.0")
}

pub(super) fn is_released_system_slug(slug: &str) -> bool {
  released_system_baseline_version(slug).is_some()
}

pub(super) fn validate_released_system_manifest(manifest: &bundle::Manifest) -> AuthResult<()> {
  let guide = matches!(
    manifest.template_id.as_str(),
    "welcome-myoxus"
      | "getting-started-myoxus"
      | "using-folders-myoxus"
      | "meeting-templates-myoxus"
      | "databases-guide-myoxus"
  );
  let expected = if guide {
    bundle::TemplatePurpose::Guide
  } else {
    bundle::TemplatePurpose::Template
  };
  if !is_released_system_slug(&manifest.template_id)
    || manifest.purpose != Some(expected)
    || manifest.title_policy.is_none()
  {
    return Err(AuthError::InvalidInput(
      "release manifest does not preserve its system document purpose".into(),
    ));
  }
  Ok(())
}

/// Raw legacy binding facts used only during the bounded release transition.
/// The normal revision-backed instance type continues to require a real ID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleasedBuiltinInstance {
  pub id: Uuid,
  pub workspace_id: WorkspaceId,
  pub workspace_doc_id: Option<DocId>,
  pub workspace_doc_key: Option<String>,
  pub resolved_doc_id: Option<DocId>,
  pub resolved_doc_key: Option<String>,
  pub state: InstanceState,
  pub revision_id: Option<Uuid>,
  pub last_applied_hash: Option<String>,
  pub expected_hash: Option<String>,
  pub locale: Option<String>,
  pub source_available: bool,
  pub native_template_state: Option<String>,
  pub native_template_id: Option<Uuid>,
  pub native_instance_id: Option<Uuid>,
  pub selection_mode: Option<SelectionMode>,
  pub selected_revision_id: Option<Uuid>,
}

/// Content attestation is revision-fenced by the persistence owner at commit.
#[derive(Debug, Clone)]
pub struct ReleasedBuiltinAdoption {
  pub observed: ReleasedBuiltinInstance,
  pub revision_id: Uuid,
  pub content_revision: Option<i64>,
  pub current_hash: Option<String>,
  pub unchanged: bool,
}

impl ReleasedBuiltinAdoption {
  /// Compare one captured body with its frozen native baseline. Preview and
  /// Apply share this decision; only Apply persists the observed revision fence.
  pub fn attest_baseline(&mut self, template: Uuid, parsed: &bundle::ParsedBundle, payload: &[u8]) -> AuthResult<()> {
    let attributed = self.observed.native_template_id.is_none_or(|id| id == template)
      && self.observed.native_instance_id.is_none_or(|id| id == self.observed.id);
    if parsed.manifest.purpose == Some(bundle::TemplatePurpose::Guide) && !attributed {
      return Err(AuthError::InvalidInput(
        "release guide attribution belongs to another identity".into(),
      ));
    }
    let locale = parsed.select_locale(
      self
        .observed
        .locale
        .as_deref()
        .unwrap_or(parsed.manifest.locale.as_deref().unwrap_or("en")),
    );
    self.unchanged = attributed
      && yjs::native_documents_have_same_content(payload, parsed.content_for_locale(&locale)).unwrap_or(false);
    self.current_hash = Some(compute_content_hash(payload));
    Ok(())
  }

  /// An edited legacy body becomes a custom source. Keeping its document pointer
  /// would let the old assignment protect it through the normal lifecycle guard.
  pub fn retains_source_binding(&self, purpose: bundle::TemplatePurpose) -> bool {
    purpose == bundle::TemplatePurpose::Guide || self.state_after_cutover(purpose) != InstanceState::Detached
  }

  pub fn state_after_cutover(&self, purpose: bundle::TemplatePurpose) -> InstanceState {
    if matches!(self.observed.state, InstanceState::Retired | InstanceState::Detached) {
      return self.observed.state;
    }
    if purpose == bundle::TemplatePurpose::Guide {
      return if self.observed.source_available {
        InstanceState::Ok
      } else {
        InstanceState::Retired
      };
    }
    if !self.observed.source_available {
      return InstanceState::Error;
    }
    if self.unchanged
      && matches!(
        self.observed.native_template_state.as_deref(),
        Some("seeded" | "managed")
      )
    {
      InstanceState::Ok
    } else {
      InstanceState::Detached
    }
  }
}

impl TemplateRegistryService {
  /// Attest the frozen deployed body before normal Feature current selection.
  /// Staging history never publishes the baseline over an operator's current
  /// choice. Each native binding batch is durable and replay excludes it.
  #[instrument(skip_all)]
  pub async fn adopt_released_builtin_baseline(&self, data: &[u8], filename: &str) -> AuthResult<()> {
    let parsed = bundle::parse_bundle_with_filename_and_limits(data, filename, self.bundle_zip_limits())?;
    validate_released_system_manifest(&parsed.manifest)?;
    if released_system_baseline_version(&parsed.manifest.template_id) != Some(parsed.manifest.version.as_str()) {
      return Err(AuthError::InvalidInput(
        "expected the frozen deployed system baseline".into(),
      ));
    }
    let (entry, revision) = self.stage_shipped_catalog_bundle(data, filename).await?;
    self.transition_released_builtin(&entry, &revision, &parsed).await
  }
  /// The retirement baseline is historical evidence, never active delivery.
  /// Re-registration keeps its genuine revision and an archived catalog inert.
  #[instrument(skip_all)]
  pub async fn retire_shipped_meeting_notes(&self, baseline: &[u8]) -> AuthResult<()> {
    let manifest = bundle::parse_bundle_with_limits(baseline, self.bundle_zip_limits())?.manifest;
    if manifest.template_id != "meeting-notes" || manifest.version != "1.0.0" {
      return Err(AuthError::InvalidInput(
        "unexpected retirement baseline identity/version".into(),
      ));
    }
    let (entry, _) = self
      .register_shipped_bundle(baseline, "meeting-notes-1.0.0.zip")
      .await?;
    if entry.slug != "meeting-notes" {
      return Err(AuthError::InvalidInput(
        "unexpected retirement baseline identity".into(),
      ));
    }
    if entry.status != myoxus_domain::template_registry::TemplateStatus::Archived {
      // Snapshot IDs before deleting assignments; a removed cursor cannot resume
      // the public preview API. One policy per pass bounds materialization work.
      let replacement_available = entry.status == myoxus_domain::template_registry::TemplateStatus::Active
        && self
          .store
          .get_catalog_entry_by_slug("meeting-focus")
          .await?
          .is_some_and(|focus| focus.status == myoxus_domain::template_registry::TemplateStatus::Active);
      let policies = self.store.list_policies_for_template(entry.id).await?;
      for policy in policies {
        if replacement_available {
          self
            .replace_default_assignments_inner(
              super::TemplateDefaultReplacementRequest {
                source_slug: "meeting-notes",
                replacement_slug: "meeting-focus",
                after_policy_id: None,
                limit: 1,
                apply: true,
              },
              Some(policy.id),
            )
            .await?;
        }
        // The public operation preserves pins, disables and operator choices.
        // Process remaining policies without enabling or reseeding them.
        if self.store.get_policy(policy.id).await?.is_some() {
          self
            .store
            .preserve_source_as_custom(policy.workspace_id, entry.id)
            .await?;
        }
      }
      self
        .store
        .commit_catalog_transition(
          entry.id,
          myoxus_domain::template_registry::TemplateStatus::Archived,
          false,
        )
        .await?;
    }
    // Archive closes delivery first. Preserve any surviving bindings, including
    // an assignment added while the bounded replacement pass was running.
    for instance in self.store.list_released_builtin_instances(entry.id).await? {
      if instance.workspace_doc_id.is_some() || instance.workspace_doc_key.is_some() {
        self
          .store
          .preserve_source_as_custom(instance.workspace_id, entry.id)
          .await?;
      }
    }
    Ok(())
  }

  pub(super) async fn unchanged_source_revision(
    &self,
    instance: &myoxus_domain::template_registry::WorkspaceTemplateInstance,
  ) -> AuthResult<Option<(DocId, i64)>> {
    let Some(doc) = instance.workspace_doc_id else {
      return Ok(None);
    };
    let attribution = self
      .store
      .source_attribution(instance.workspace_id, instance.template_id)
      .await?
      .filter(|row| row.id == instance.id);
    // Historical sources can retain a seeded marker after policy correction.
    // Both positive native states still require canonical content comparison;
    // the locked retirement boundary separately rechecks the managed policy.
    if attribution.is_none_or(|row| {
      !row.source_available
        || !matches!(row.native_template_state.as_deref(), Some("seeded" | "managed"))
        || row.native_template_id.is_some_and(|id| id != instance.template_id)
        || row.native_instance_id.is_some_and(|id| id != instance.id)
    }) {
      return Ok(None);
    }
    let service = self
      .doc_service
      .as_ref()
      .ok_or_else(|| AuthError::Storage("replacement requires document storage".into()))?;
    let revision = self
      .store
      .get_revision(instance.revision_id)
      .await?
      .ok_or_else(|| AuthError::InvalidInput("replacement source has no genuine revision".into()))?;
    let storage = self
      .blob_storage
      .as_ref()
      .ok_or_else(|| AuthError::Storage("replacement requires bundle storage".into()))?;
    let bytes = self.load_revision_bundle_bytes(&revision, storage.as_ref()).await?;
    let parsed = bundle::parse_bundle_with_limits(&bytes, self.bundle_zip_limits())?;
    let current = service
      .load
      .load_full_doc_with_revision_bounded(
        instance.workspace_id,
        doc,
        self
          .zip_limits
          .max_total_uncompressed_size_mb
          .saturating_mul(1024 * 1024) as usize,
      )
      .await?;
    let locale = parsed.select_locale(instance.locale_hash.as_deref().unwrap_or("en"));
    Ok(
      yjs::native_documents_have_same_content(&current.payload, parsed.content_for_locale(&locale))
        .unwrap_or(false)
        .then_some((doc, current.revision)),
    )
  }

  #[instrument(skip_all, fields(template_id = %entry.id, revision_id = %revision.id))]
  pub(super) async fn transition_released_builtin(
    &self,
    entry: &myoxus_domain::template_registry::TemplateCatalogEntry,
    revision: &myoxus_domain::template_registry::TemplateRevision,
    parsed: &bundle::ParsedBundle,
  ) -> AuthResult<()> {
    if !matches!(entry.source, TemplateSource::Builtin | TemplateSource::Bundle) {
      return Ok(());
    }
    if entry.source == TemplateSource::Bundle && !is_released_system_slug(&entry.slug) {
      return Ok(());
    }
    // A newer current export cannot attest a deployed builder's old native body.
    // Bundle owners with no pending legacy rows need no transition at all.
    let mut batch = self.store.pending_released_builtin_instances(entry.id, 100).await?;
    if entry.source == TemplateSource::Bundle && batch.is_empty() {
      return Ok(());
    }
    if !is_released_system_slug(&entry.slug) || revision.created_by.is_some() {
      return Err(AuthError::InvalidInput(
        "release cannot replace this builtin owner".into(),
      ));
    }
    if !batch.is_empty() && released_system_baseline_version(&entry.slug) != Some(parsed.manifest.version.as_str()) {
      return Err(AuthError::InvalidInput(
        "builtin transition requires its frozen deployed baseline".into(),
      ));
    }
    while !batch.is_empty() {
      let mut pinned_bundles = std::collections::HashMap::new();
      let mut adoptions = Vec::new();
      for observed in batch {
        let mut adoption = ReleasedBuiltinAdoption {
          observed,
          revision_id: revision.id,
          content_revision: None,
          current_hash: None,
          unchanged: false,
        };
        if adoption.observed.source_available {
          let doc_service = self
            .doc_service
            .as_ref()
            .ok_or_else(|| AuthError::Storage("release cutover requires document storage".into()))?;
          let doc_id = adoption
            .observed
            .resolved_doc_id
            .ok_or_else(|| AuthError::Storage("live builtin source has no document identity".into()))?;
          let content = doc_service
            .load
            .load_full_doc_with_revision_bounded(
              adoption.observed.workspace_id,
              doc_id,
              self
                .zip_limits
                .max_total_uncompressed_size_mb
                .saturating_mul(1024 * 1024) as usize,
            )
            .await?;
          let locale = adoption
            .observed
            .locale
            .as_deref()
            .unwrap_or(parsed.manifest.locale.as_deref().unwrap_or("en"));
          let locale = parsed.select_locale(locale);
          adoption.attest_baseline(entry.id, parsed, &content.payload)?;
          // A real matching pin remains the applied revision. Otherwise the next
          // normal worker would rewrite unchanged bytes merely due to this cutover.
          if let Some(pin) = adoption
            .observed
            .selected_revision_id
            .filter(|_| adoption.observed.selection_mode == Some(SelectionMode::PinnedRevision))
          {
            if !pinned_bundles.contains_key(&pin) {
              let pinned = self
                .store
                .get_revision(pin)
                .await?
                .filter(|pinned| {
                  pinned.template_id == entry.id
                    && matches!(pinned.state, RevisionState::Published | RevisionState::Deprecated)
                })
                .ok_or_else(|| AuthError::InvalidInput("release pin has no published content revision".into()))?;
              let storage = self
                .blob_storage
                .as_ref()
                .ok_or_else(|| AuthError::Storage("release pin requires bundle storage".into()))?;
              let bytes = self.load_revision_bundle_bytes(&pinned, storage.as_ref()).await?;
              let pinned_bundle = bundle::parse_bundle_with_limits(&bytes, self.bundle_zip_limits())
                .map_err(|error| AuthError::InvalidInput(format!("release pin bundle is invalid: {error}")))?;
              validate_released_system_manifest(&pinned_bundle.manifest)?;
              if pinned.checksum.as_deref() != Some(pinned_bundle.content_checksum.as_str())
                || super::content::validation_findings(&pinned_bundle, self.zip_limits)
                  .iter()
                  .any(|finding| finding.severity == bundle::ValidationSeverity::Error)
              {
                return Err(AuthError::InvalidInput("release pin content failed validation".into()));
              }
              if pinned_bundle.manifest.template_id != entry.slug {
                return Err(AuthError::InvalidInput(
                  "release pin belongs to a different system identity".into(),
                ));
              }
              pinned_bundles.insert(pin, pinned_bundle);
            }
            let pinned = &pinned_bundles[&pin];
            let pinned_locale = pinned.select_locale(&locale);
            if yjs::native_documents_have_same_content(&content.payload, pinned.content_for_locale(&pinned_locale))
              .unwrap_or(false)
            {
              adoption.revision_id = pin;
              adoption.unchanged = adoption.observed.native_template_id.is_none_or(|id| id == entry.id)
                && adoption
                  .observed
                  .native_instance_id
                  .is_none_or(|id| id == adoption.observed.id);
            }
          }
          adoption.content_revision = Some(content.revision);
        }
        adoptions.push(adoption);
      }
      self
        .store
        .commit_released_builtin_transition(
          entry.id,
          revision.id,
          parsed.manifest.purpose.unwrap_or(bundle::TemplatePurpose::Template),
          &adoptions,
          false,
        )
        .await?;
      batch = self.store.pending_released_builtin_instances(entry.id, 100).await?;
    }
    self
      .store
      .commit_released_builtin_transition(
        entry.id,
        revision.id,
        parsed.manifest.purpose.unwrap_or(bundle::TemplatePurpose::Template),
        &[],
        true,
      )
      .await
  }
}
