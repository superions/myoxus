// SPDX-License-Identifier: AGPL-3.0-or-later

//! Explicit operator reconciliation. Presence, emptiness and equality never
//! choose an assignment: only the submitted document decisions authorize writes.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use async_trait::async_trait;
use myoxus_domain::repositories::{RepoResult, RepositoryError};
use myoxus_domain::workspace_tags::{WorkspaceTag, WorkspaceTagDocumentAssignment};
use myoxus_workspace_import::{DecodedWorkspaceTag, WorkspaceImportLimits};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Coherent, bounded persistence input. Root bytes never enter CLI output/logs.
pub struct LabelMigrationSnapshot {
  pub workspace_id: Uuid,
  pub catalog: Vec<WorkspaceTag>,
  pub documents: Vec<WorkspaceTagDocumentAssignment>,
  pub legacy_ids: BTreeMap<String, Uuid>,
  pub retired_ids: BTreeSet<String>,
  pub root: Vec<u8>,
  pub root_revision: String,
}

#[derive(Debug, Serialize)]
pub struct LabelDocumentInspection {
  pub external_id: String,
  pub doc_id: Option<Uuid>,
  pub sql_tags: Option<Vec<Uuid>>,
  pub yjs_tags: Option<Vec<String>>,
  pub mapped_yjs_tags: Option<Vec<Uuid>>,
  pub status: &'static str,
  pub unknown_ids: Vec<String>,
  pub retired_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct LabelInspection {
  pub workspace_id: Uuid,
  pub sql_revision: String,
  pub root_revision: String,
  pub catalog: Vec<WorkspaceTag>,
  pub legacy_catalog: Vec<DecodedWorkspaceTag>,
  pub legacy_id_mappings: BTreeMap<String, Uuid>,
  pub retired_ids: BTreeSet<String>,
  pub documents: Vec<LabelDocumentInspection>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LabelDocumentDecision {
  pub external_id: String,
  /// Ordered complete replacement: canonical UUIDs or explicitly selected
  /// legacy-only catalog IDs. An empty array is an explicit clear decision.
  pub tag_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LabelRepairDecision {
  pub workspace_id: Uuid,
  pub sql_revision: String,
  pub root_revision: String,
  pub documents: Vec<LabelDocumentDecision>,
  #[serde(default)]
  pub import_legacy_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct LabelRepairResult {
  pub workspace_id: Uuid,
  pub changed: bool,
  pub documents: usize,
  pub imported_tags: usize,
  pub root_catalog_removed: bool,
}

pub struct LabelRepairPlan {
  pub tags: Vec<WorkspaceTag>,
  pub mappings: BTreeMap<String, Uuid>,
  pub assignments: Vec<(Uuid, Vec<Uuid>)>,
  pub root_delta: Vec<u8>,
  pub result: LabelRepairResult,
}

/// Apply rereads and plans inside the same transaction as SQL replacement and
/// the existing append-only root update/outbox. A transport cannot bypass the
/// revision or cutover checks by constructing a persistence plan itself.
#[async_trait]
pub trait LabelMigrationRepository: myoxus_domain::workspace_tags::WorkspaceTagRepository {
  async fn inspect_labels(&self, workspace_id: Uuid, limits: WorkspaceImportLimits) -> RepoResult<LabelInspection>;
  async fn apply_label_repair(
    &self,
    actor: Uuid,
    decision: &LabelRepairDecision,
    cutover_acknowledged: bool,
    limits: WorkspaceImportLimits,
  ) -> RepoResult<LabelRepairResult>;
}

pub struct LabelMigrationService {
  repo: std::sync::Arc<dyn LabelMigrationRepository>,
  cache: Option<std::sync::Arc<dyn crate::doc::DocCachePort>>,
}

impl LabelMigrationService {
  pub fn new(
    repo: std::sync::Arc<dyn LabelMigrationRepository>,
    cache: Option<std::sync::Arc<dyn crate::doc::DocCachePort>>,
  ) -> Self {
    Self { repo, cache }
  }

  #[tracing::instrument(skip_all)]
  pub async fn inspect(&self, workspace_id: Uuid, limits: WorkspaceImportLimits) -> RepoResult<LabelInspection> {
    self.repo.inspect_labels(workspace_id, limits).await
  }

  #[tracing::instrument(skip_all)]
  pub async fn apply(
    &self,
    actor: Uuid,
    decision: &LabelRepairDecision,
    cutover_acknowledged: bool,
    limits: WorkspaceImportLimits,
  ) -> RepoResult<LabelRepairResult> {
    let result = self
      .repo
      .apply_label_repair(actor, decision, cutover_acknowledged, limits)
      .await?;
    // Repeat invalidation on a no-op retry too: it may be recovering delivery
    // after a previous process exited immediately after the durable commit.
    if let Some(cache) = &self.cache {
      cache
        .invalidate_snapshot(decision.workspace_id, decision.workspace_id)
        .await;
      cache.invalidate_timestamps(decision.workspace_id).await;
    }
    if result.changed
      && let Err(error) = self
        .repo
        .refresh_search_projections(
          decision.workspace_id,
          myoxus_domain::workspace_tags::WorkspaceTagSearchRefreshScope::Workspace,
        )
        .await
    {
      tracing::warn!(workspace_id = %decision.workspace_id, %error, "label repair committed; search refresh failed");
    }
    Ok(result)
  }
}

fn invalid(message: &str) -> RepositoryError {
  RepositoryError::Validation(message.to_string())
}

fn resolve_id(snapshot: &LabelMigrationSnapshot, canonical_ids: &HashSet<Uuid>, id: &str) -> Option<Uuid> {
  Uuid::parse_str(id)
    .ok()
    .filter(|id| canonical_ids.contains(id))
    .or_else(|| snapshot.legacy_ids.get(id).copied())
    .filter(|id| canonical_ids.contains(id))
}

fn retired(snapshot: &LabelMigrationSnapshot, canonical_ids: &HashSet<Uuid>, id: &str) -> bool {
  snapshot.retired_ids.contains(id)
    || resolve_id(snapshot, canonical_ids, id).is_some_and(|mapped| snapshot.retired_ids.contains(&mapped.to_string()))
    || snapshot
      .retired_ids
      .contains(&Uuid::new_v5(&snapshot.workspace_id, id.as_bytes()).to_string())
}

fn root_metadata(snapshot: &LabelMigrationSnapshot) -> RepoResult<yjs::WorkspaceRootMetadata> {
  let root = yjs::extract_workspace_root_metadata(&snapshot.root)
    .map_err(|_| invalid("workspace root label metadata is invalid; no repair applied"))?;
  let mut ids = HashSet::new();
  if root.pages.iter().any(|page| !ids.insert(&page.id)) {
    return Err(invalid("workspace root contains duplicate document identities"));
  }
  Ok(root)
}

#[tracing::instrument(skip_all)]
pub fn inspect(snapshot: &LabelMigrationSnapshot, limits: WorkspaceImportLimits) -> RepoResult<LabelInspection> {
  let root = root_metadata(snapshot)?;
  if root.pages.len() > limits.max_documents {
    return Err(invalid("workspace root exceeds inspection document limits"));
  }
  let canonical_ids = &snapshot.catalog.iter().map(|tag| tag.id).collect::<HashSet<_>>();
  let legacy_catalog = serde_json::from_value(root.workspace_tags.clone())
    .map_err(|_| invalid("workspace root label catalog is invalid"))?;
  // Sorted persistence inputs include identity mappings, retirement and catalog
  // metadata, so a concurrent rename, deletion or reassignment invalidates a plan.
  let sql = serde_json::to_vec(&(
    snapshot.workspace_id,
    &snapshot.catalog,
    &snapshot.documents,
    &snapshot.legacy_ids,
    &snapshot.retired_ids,
  ))
  .map_err(|_| invalid("workspace label revision cannot be computed"))?;
  let mut documents = BTreeMap::new();
  for doc in &snapshot.documents {
    documents.insert(
      doc.external_id.clone(),
      LabelDocumentInspection {
        external_id: doc.external_id.clone(),
        doc_id: Some(doc.doc_id),
        sql_tags: Some(doc.tag_ids.clone()),
        yjs_tags: None,
        mapped_yjs_tags: None,
        status: "sql_only",
        unknown_ids: Vec::new(),
        retired_ids: Vec::new(),
      },
    );
  }
  for page in root.pages {
    let entry = documents
      .entry(page.id.clone())
      .or_insert_with(|| LabelDocumentInspection {
        external_id: page.id,
        doc_id: None,
        sql_tags: None,
        yjs_tags: None,
        mapped_yjs_tags: None,
        status: "unmapped_document",
        unknown_ids: Vec::new(),
        retired_ids: Vec::new(),
      });
    if !page.tags_present {
      continue;
    }
    let ids: Vec<String> =
      serde_json::from_value(page.tags).map_err(|_| invalid("workspace page label assignment is invalid"))?;
    let mut mapped = Vec::new();
    for id in &ids {
      if retired(snapshot, canonical_ids, id) {
        entry.retired_ids.push(id.clone());
      } else if let Some(id) = resolve_id(snapshot, canonical_ids, id) {
        mapped.push(id);
      } else {
        entry.unknown_ids.push(id.clone());
      }
    }
    entry.yjs_tags = Some(ids);
    if entry.unknown_ids.is_empty() && entry.retired_ids.is_empty() {
      entry.mapped_yjs_tags = Some(mapped.clone());
    }
    entry.status = if entry.doc_id.is_none() {
      "unmapped_document"
    } else if !entry.retired_ids.is_empty() {
      "retired_reference"
    } else if !entry.unknown_ids.is_empty() {
      "unknown_reference"
    } else if entry.sql_tags.as_ref() == Some(&mapped) {
      "equal"
    } else {
      "different"
    };
  }
  let inspection = LabelInspection {
    workspace_id: snapshot.workspace_id,
    sql_revision: hex::encode(Sha256::digest(sql)),
    root_revision: snapshot.root_revision.clone(),
    catalog: snapshot.catalog.clone(),
    legacy_catalog,
    legacy_id_mappings: snapshot.legacy_ids.clone(),
    retired_ids: snapshot.retired_ids.clone(),
    documents: documents.into_values().collect(),
  };
  if inspection.documents.len() > limits.max_documents
    || serde_json::to_vec(&inspection)
      .map_err(|_| invalid("invalid inspection output"))?
      .len() as u64
      > limits.max_document_bytes
  {
    return Err(invalid("label inspection output exceeds metadata/document limits"));
  }
  Ok(inspection)
}

#[tracing::instrument(skip_all)]
pub fn plan_repair(
  snapshot: &LabelMigrationSnapshot,
  actor: Uuid,
  decision: &LabelRepairDecision,
  cutover_acknowledged: bool,
  limits: WorkspaceImportLimits,
) -> RepoResult<LabelRepairPlan> {
  if !cutover_acknowledged {
    return Err(invalid(
      "label cleanup requires explicit acknowledgement that updated clients are deployed and editing is stopped",
    ));
  }
  if decision.workspace_id != snapshot.workspace_id || decision.documents.is_empty() {
    return Err(invalid("repair requires explicit documents in the inspected workspace"));
  }
  if [&decision.sql_revision, &decision.root_revision]
    .iter()
    .any(|revision| revision.len() != 64 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()))
  {
    return Err(invalid(
      "repair requires both inspected revision values, including for a completed retry",
    ));
  }
  let inspection = inspect(snapshot, limits)?;
  let canonical_ids = &snapshot.catalog.iter().map(|tag| tag.id).collect::<HashSet<_>>();
  let documents = snapshot
    .documents
    .iter()
    .map(|doc| (doc.external_id.as_str(), doc))
    .collect::<BTreeMap<_, _>>();
  let mut selected = HashSet::new();
  let mut import_ids = HashSet::new();
  let mut source = Vec::new();
  let mut mappings = BTreeMap::new();
  for id in &decision.import_legacy_ids {
    if !import_ids.insert(id) || retired(snapshot, canonical_ids, id) {
      return Err(invalid("duplicate or retired legacy catalog selection"));
    }
    if let Some(mapped) = resolve_id(snapshot, canonical_ids, id) {
      // A completed repair may already have removed the source catalog.
      mappings.insert(id.clone(), mapped);
      continue;
    }
    let matches = inspection
      .legacy_catalog
      .iter()
      .filter(|tag| &tag.id == id)
      .collect::<Vec<_>>();
    if matches.len() != 1 {
      return Err(invalid("selected legacy label is missing or ambiguous"));
    }
    source.push(matches[0].clone());
  }
  let imported = super::transfer::plan_import(
    snapshot.workspace_id,
    snapshot.workspace_id,
    actor,
    &source,
    std::iter::empty::<&[String]>(),
  )
  .map_err(|_| invalid("selected legacy label metadata is invalid"))?;
  for (source, id) in imported.mappings {
    if snapshot.retired_ids.contains(&id.to_string()) || canonical_ids.contains(&id) {
      return Err(invalid(
        "selected legacy label target identity is retired or already occupied",
      ));
    }
    mappings.insert(source, id);
  }
  let mut assignments = Vec::new();
  let mut assignment_changed = false;
  for choice in &decision.documents {
    if !selected.insert(choice.external_id.clone()) {
      return Err(invalid("duplicate document repair selection"));
    }
    let doc = documents
      .get(choice.external_id.as_str())
      .ok_or_else(|| invalid("selected document identity is unavailable"))?;
    let mut ids = Vec::new();
    for id in &choice.tag_ids {
      if retired(snapshot, canonical_ids, id) {
        return Err(invalid("repair cannot resurrect a retired label identity"));
      }
      // Existing canonical UUIDs retain their identity. Legacy IDs are usable
      // only when explicitly selected for transfer; display names never match.
      let canonical = Uuid::parse_str(id)
        .ok()
        .filter(|id| canonical_ids.contains(id))
        .or_else(|| mappings.get(id).copied())
        .ok_or_else(|| invalid("final assignment must use canonical or explicitly selected legacy IDs"))?;
      if ids.contains(&canonical) {
        return Err(invalid("final assignment contains duplicate label identities"));
      }
      ids.push(canonical);
    }
    assignment_changed |= ids != doc.tag_ids;
    assignments.push((doc.doc_id, ids));
  }
  let cleanup = yjs::reconcile_workspace_labels_in_root_doc(&snapshot.root, &selected)
    .map_err(|_| invalid("workspace root label cleanup is invalid"))?;
  let changed = assignment_changed || !imported.tags.is_empty() || !cleanup.update.is_empty();
  // A semantically completed retry is safe even after unrelated work changed
  // the workspace revision. Every non-no-op must match both inspected inputs.
  if changed && (decision.sql_revision != inspection.sql_revision || decision.root_revision != inspection.root_revision)
  {
    return Err(invalid(
      "workspace SQL/root revision changed; inspect again before choosing a repair",
    ));
  }
  Ok(LabelRepairPlan {
    tags: imported.tags,
    mappings,
    assignments,
    root_delta: cleanup.update,
    result: LabelRepairResult {
      workspace_id: snapshot.workspace_id,
      changed,
      documents: selected.len(),
      imported_tags: source.len(),
      root_catalog_removed: cleanup.catalog_removed,
    },
  })
}
