// SPDX-License-Identifier: AGPL-3.0-or-later
//! Captured document assets feed the native Registry. Selection schedules native
//! Registry reconciliation; workers own bodies and preserve operator policy.

use super::{CapturedFeatureBundle, validate_feature_references};
use crate::auth::{AuthError, AuthResult};
use crate::template_registry::{ShippedTemplateSelection, ShippedTemplateSelectionReport, TemplateRegistryService};
use myoxus_domain::feature_bundle::{FeatureBundlePin, FeatureComponentKind};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug)]
pub struct FeatureDocumentRegistrationReport {
  pub registered_versions: usize,
  pub selection: ShippedTemplateSelectionReport,
  pub scheduled_workspaces: usize,
}

#[derive(Debug)]
struct DocumentSource<'a> {
  id: &'a str,
  version: &'a str,
  digest: &'a str,
  path: &'a str,
  bytes: &'a [u8],
  current: bool,
  new_workspace_default: bool,
}

/// Validate the complete projection before staging any native immutable children.
fn document_sources<'a>(
  captured: &'a [CapturedFeatureBundle],
  active: &[FeatureBundlePin],
) -> Result<Vec<DocumentSource<'a>>, String> {
  let mut active_pins = BTreeSet::new();
  for pin in active {
    if !active_pins.insert((&pin.id, &pin.version, &pin.sha256)) || !captured.iter().any(|bundle| bundle.pin() == *pin)
    {
      return Err("duplicate or missing active document provider".into());
    }
  }
  let mut sources: BTreeMap<(&str, &str), DocumentSource<'a>> = BTreeMap::new();
  let mut current = BTreeSet::new();
  for bundle in captured {
    validate_feature_references(bundle, captured)?;
    let is_active = active.iter().any(|pin| *pin == bundle.pin());
    for component in &bundle.manifest.components {
      if component.kind != FeatureComponentKind::DocumentTemplate {
        continue;
      }
      let identity = component
        .native_identity
        .as_ref()
        .ok_or("missing native document identity")?;
      let bytes = bundle
        .files
        .get(&component.path)
        .ok_or("missing captured document bytes")?
        .as_slice();
      let claims: Vec<_> = bundle
        .manifest
        .exports
        .iter()
        .filter(|export| export.source.component == component.id)
        .collect();
      if claims.len() > 1 {
        return Err("duplicate native document current claim".into());
      }
      let exported = is_active && !claims.is_empty();
      if exported && !current.insert(identity.id.as_str()) {
        return Err("duplicate native document current identity".into());
      }
      let default = exported
        && claims[0]
          .document
          .as_ref()
          .is_some_and(|policy| policy.new_workspace_default);
      let key = (identity.id.as_str(), identity.version.as_str());
      if let Some(previous) = sources.get_mut(&key) {
        if previous.digest != component.sha256 || previous.bytes != bytes {
          return Err("native document history bytes changed".into());
        }
        previous.current |= exported;
        previous.new_workspace_default |= default;
      } else {
        sources.insert(
          key,
          DocumentSource {
            id: &identity.id,
            version: &identity.version,
            digest: &component.sha256,
            path: &component.path,
            bytes,
            current: exported,
            new_workspace_default: default,
          },
        );
      }
    }
  }
  Ok(sources.into_values().collect())
}

/// Import and validate immutable revisions first, then atomically select every
/// native current/history pointer. A failed selection may leave reusable staged
/// revisions; it cannot expose a partly activated release or seed workspaces.
#[tracing::instrument(skip_all)]
pub async fn register_feature_document_sources(
  registry: &TemplateRegistryService,
  captured: &[CapturedFeatureBundle],
  active: &[FeatureBundlePin],
) -> AuthResult<FeatureDocumentRegistrationReport> {
  let staged = stage_feature_document_sources(registry, captured, active).await?;
  let count = staged
    .iter()
    .map(|item| item.history_revision_ids.len() + usize::from(item.current_revision_id.is_some()))
    .sum();
  let selection = registry.commit_shipped_catalog_selection(&staged).await?;
  // Native mismatches remain discoverable after interruption. Reuse the existing
  // durable scheduler rather than adding release receipts or another queue.
  let mut after = None;
  let mut scheduled_workspaces = 0;
  loop {
    let workspaces = registry
      .store()
      .release_workspaces_needing_reconcile(after, 100)
      .await?;
    if workspaces.is_empty() {
      break;
    }
    for workspace in workspaces {
      registry.schedule_workspace_reconcile(workspace).await?;
      after = Some(workspace);
      scheduled_workspaces += 1;
    }
  }
  Ok(FeatureDocumentRegistrationReport {
    registered_versions: count,
    selection,
    scheduled_workspaces,
  })
}

/// Admit immutable history before recovery attests legacy bindings. This does
/// not select a publication, adopt a source, or seed a Workspace.
#[tracing::instrument(skip_all)]
pub async fn stage_feature_document_sources(
  registry: &TemplateRegistryService,
  captured: &[CapturedFeatureBundle],
  active: &[FeatureBundlePin],
) -> AuthResult<Vec<ShippedTemplateSelection>> {
  let sources = document_sources(captured, active).map_err(AuthError::InvalidInput)?;
  let mut selection = BTreeMap::new();
  for source in sources {
    let (entry, revision) = registry.stage_shipped_catalog_bundle(source.bytes, source.path).await?;
    if entry.slug != source.id || revision.version != source.version {
      return Err(AuthError::InvalidInput(
        "native document identity differs from captured declaration".into(),
      ));
    }
    let item = selection.entry(entry.id).or_insert_with(|| ShippedTemplateSelection {
      template_id: entry.id,
      current_revision_id: None,
      history_revision_ids: Vec::new(),
      new_workspace_default: false,
    });
    if source.current {
      item.current_revision_id = Some(revision.id);
      item.new_workspace_default = source.new_workspace_default;
    } else {
      item.history_revision_ids.push(revision.id);
    }
  }
  Ok(selection.into_values().collect())
}
