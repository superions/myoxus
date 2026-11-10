// SPDX-License-Identifier: AGPL-3.0-or-later
//! Raw source attribution and native retirement; identity adoption is complete.

use myoxus_domain::ids::{DocId, WorkspaceId};
use myoxus_domain::template_registry::{InstanceState, SelectionMode};
use tracing::instrument;
use uuid::Uuid;

use super::{TemplateRegistryService, bundle};
use crate::auth::{AuthError, AuthResult};

/// Raw attribution preserves nullable historical facts for source protection and
/// retirement. Normal revision-backed instances still require a genuine ID.
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

impl TemplateRegistryService {
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
}
