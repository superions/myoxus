// SPDX-License-Identifier: AGPL-3.0-or-later
//! State loading: read Myoxus docs from DB and Git files from the working tree.
//!
//! Current-state loading contract:
//! - Metadata and update watermarks include uncompacted `doc_updates`
//! - Selected bodies use snapshot-plus-tail reads through `DocLoadService`
//! - Organizer hierarchy is projected from `OrganizerService::snapshot`
//! - Bounded yjs→markdown conversion via `spawn_blocking`
//! - Complete Git working-tree state for three-way reconciliation
//!
//! File object support (M2-B1):
//! - Non-.md files classified as file objects for blob sync pipeline
//! - MIME detection + policy evaluation applied early (before heavy processing)

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use futures_util::stream::{self, StreamExt};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tracing::{debug, info, instrument, trace, warn};
use uuid::Uuid;

use myoxus_application::git_sync::doc_reconcile_plan::MyoxusDocState;
use myoxus_application::git_sync::export::{GitSyncWriterScope, is_git_sync_control_path};
use myoxus_application::git_sync::import;
use myoxus_application::git_sync::projection;
use myoxus_application::markdown::{
  AuthorizedMarkdownBatchDocument, AuthorizedMarkdownDocument, MarkdownBatchReferenceInventory,
  MarkdownProjectionPolicy, portable_markdown_block_id, project_document_in_batch_with_images,
};
use myoxus_application::mime_policy::{self, MimeDetectionResult, MimePolicyConfig, MimePolicyDecision};
use myoxus_application::{
  doc::DocService,
  organizer::{OrganizerService, OrganizerSnapshot},
};
use myoxus_domain::document_graph::{DocumentGraphDirection, DocumentGraphLinkKind, DocumentGraphStaleState};
use myoxus_domain::git_sync::RepoPath;
use myoxus_domain::repositories::{DocumentGraphRepository, PageRequest};
use myoxus_infrastructure::doc::SqlxDocStore;
use myoxus_infrastructure::document_graph::PgDocumentGraphRepository;
use myoxus_infrastructure::git_sync::SqlxGitSyncStore;

use super::error::SyncError;

// ── File object classification (M2-B1) ─────────────────────────────────

/// Classification of a file found in the git working tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncItemKind {
  /// Markdown files → existing Yjs/doc pipeline.
  Document,
  /// Non-markdown files → blob sync pipeline.
  File,
}

/// A non-markdown file loaded from the git working tree, with MIME classification.
#[derive(Debug, Clone)]
pub struct LoadedFileItem {
  /// Relative path in the git repository (e.g. "docs/image.png").
  pub repo_path: String,
  /// SHA-256 hex digest of the file content.
  pub content_hash: String,
  /// Raw file content bytes (for MIME detection + blob write).
  pub bytes: Vec<u8>,
  /// MIME detection result from `mime_policy::detect_mime`.
  pub mime_result: MimeDetectionResult,
  /// Policy decision from `mime_policy::evaluate_policy`.
  pub policy_decision: MimePolicyDecision,
}

/// Result of scanning the git working tree for non-markdown file objects.
#[derive(Debug)]
pub struct FileLoadResult {
  /// File objects that passed policy (Allow or Warn).
  pub items: Vec<LoadedFileItem>,
  /// Number of files denied by policy (strict mode).
  pub denied_count: usize,
  /// Number of files with policy warnings (warn mode).
  pub warned_count: usize,
  /// Total non-markdown files found before policy filtering.
  pub total_scanned: usize,
}

/// Result of loading Myoxus docs.
pub struct LoadResult {
  pub docs: Vec<MyoxusDocState>,
  /// Workspace documents visible to the profile owner, without body payloads.
  pub reference_documents: Vec<AuthorizedMarkdownDocument>,
  /// Internal-to-external key map for preserving identity on bound updates.
  pub reference_external_ids: std::collections::HashMap<Uuid, String>,
  /// Effective metadata/snapshot/tail timestamp from the one operation inventory.
  pub effective_updated_at: HashMap<Uuid, DateTime<Utc>>,
  /// The exact operation snapshot used by document placements and overviews.
  /// Keep it across partial action selection; it is not a second tree read.
  pub organizer_snapshot: OrganizerSnapshot,
  pub organizer_folders: Vec<myoxus_application::git_sync::export::GitSyncManifestFolder>,
  /// Docs that were soft-deleted since last sync (need DeleteInGit actions).
  pub deleted_doc_ids: Vec<Uuid>,
  /// Number of docs where yjs→markdown conversion failed.
  pub conversion_failures: i32,
  /// Doc IDs that failed conversion.
  pub failed_doc_ids: Vec<Uuid>,
  /// Total active docs in workspace.
  pub total_docs_in_workspace: i64,
  /// Highest effective document/snapshot update timestamp in the loaded
  /// workspace view. Partial-Sync sessions persist it as their source watermark
  /// so progress can be explained and future stricter snapshot filtering has a
  /// durable boundary.
  pub workspace_watermark: Option<DateTime<Utc>>,
}

/// Load the complete current document state for a workspace.
///
/// `since` bounds deleted-document detection and the reported source
/// watermark. It must never suppress active document payloads: reconciliation
/// needs a complete current view to detect path changes and pending updates.
///
/// ## Deleted docs
/// Docs soft-deleted since `since` are returned as `deleted_doc_ids`.
/// The reconcile algorithm uses these to generate DeleteInGit actions.
///
/// ## Parallel conversion (PERF-04)
/// Docs above `parallel_threshold` → parallel spawn_blocking per doc.
#[instrument(skip_all)]
pub async fn load_myoxus_docs(pool: &PgPool, workspace_id: Uuid) -> Result<LoadResult, SyncError> {
  load_myoxus_docs_since(pool, workspace_id, None, 10).await
}

#[instrument(skip_all)]
pub async fn load_myoxus_docs_since(
  pool: &PgPool,
  workspace_id: Uuid,
  since: Option<DateTime<Utc>>,
  _parallel_threshold: usize,
) -> Result<LoadResult, SyncError> {
  // Phase 1: Metadata for ALL active docs.
  // The watermark includes pending updates as well as snapshots. Looking only
  // at snapshot timestamps makes delta loading stale until compaction.
  // Includes external_id for system-doc filtering (db$... docs are internal).
  let git_sync_store = SqlxGitSyncStore::new(pool.clone());
  let meta_rows = git_sync_store
    .list_document_projections(workspace_id)
    .await
    .map_err(|error| SyncError::permanent(error.to_string(), workspace_id, "load_document_inventory"))?;

  let total_docs = meta_rows.len() as i64;
  let workspace_watermark = meta_rows.iter().map(|row| row.effective_updated_at).max();

  let document_ids_by_external_key = meta_rows
    .iter()
    .filter_map(|row| {
      row
        .external_id
        .as_ref()
        .filter(|external_id| !external_id.starts_with("db$") && !external_id.starts_with("userdata$"))
        .map(|external_id| (external_id.clone(), row.id))
    })
    .collect();
  let reference_documents = meta_rows
    .iter()
    .filter_map(|row| {
      let external_id = row.external_id.as_ref()?;
      (!external_id.starts_with("db$") && !external_id.starts_with("userdata$")).then(|| AuthorizedMarkdownDocument {
        external_id: external_id.clone(),
        title: row.title.clone(),
      })
    })
    .collect();
  let reference_external_ids = meta_rows
    .iter()
    .filter_map(|row| {
      let external_id = row.external_id.as_ref()?;
      (!external_id.starts_with("db$") && !external_id.starts_with("userdata$")).then(|| (row.id, external_id.clone()))
    })
    .collect();
  let effective_updated_at = meta_rows
    .iter()
    .filter(|row| {
      row
        .external_id
        .as_ref()
        .is_none_or(|external_id| !external_id.starts_with("db$") && !external_id.starts_with("userdata$"))
    })
    .map(|row| (row.id, row.effective_updated_at))
    .collect();

  // Also find docs that were DELETED since last sync — needed for DeleteInGit.
  let deleted_doc_ids: Vec<Uuid> = if let Some(cutoff) = since {
    git_sync_store
      .list_deleted_document_ids_since(workspace_id, cutoff)
      .await
      .map_err(|error| SyncError::permanent(error.to_string(), workspace_id, "load_deleted_documents"))?
  } else {
    vec![]
  };

  debug!(
    total = total_docs,
    deleted_since_last_sync = deleted_doc_ids.len(),
    %workspace_id,
    "phase 1: loaded doc metadata"
  );

  // Determine which docs need payload loading.
  // Filter out system docs (external_id starting with "db$") — these are
  // internal metadata docs (folders, settings), not user content.
  let docs_needing_payload: Vec<(Uuid, String)> = meta_rows
    .iter()
    .filter(|row| {
      // Skip system docs (db$...$folders, db$...$settings, etc.)
      if let Some(ref orig) = row.external_id
        && (orig.starts_with("db$") || orig.starts_with("userdata$"))
      {
        trace!(doc_id = orig, "skipping system doc");
        return false;
      }

      true
    })
    .map(|row| (row.id, row.title.clone()))
    .collect();

  let skipped = total_docs - docs_needing_payload.len() as i64;

  // Body projection is intentionally deferred until the runner has finalized
  // every repository path. Relative document links and their hashes must be
  // derived from that one path plan.
  let mut docs = docs_needing_payload
    .iter()
    .map(|(doc_id, title)| MyoxusDocState {
      doc_id: *doc_id,
      title: title.clone(),
      markdown: None,
      content_hash: None,
      folder_path: vec![],
      organizer_folder_ids: vec![],
      organizer_entry_id: None,
      planned_repo_path: None,
    })
    .collect::<Vec<_>>();
  let conversion_failures = 0;
  let failed_doc_ids = Vec::new();

  let doc_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let organizer = OrganizerService::new(doc_service)
    .snapshot(workspace_id)
    .await
    .map_err(|error| SyncError::permanent(error.to_string(), workspace_id, "organizer_snapshot"))?;
  let organizer_projection = projection::project_organizer(&organizer, &document_ids_by_external_key);
  for doc in &mut docs {
    if let Some(placement) = organizer_projection.documents.get(&doc.doc_id) {
      doc.folder_path.clone_from(&placement.folder_names);
      doc.organizer_folder_ids.clone_from(&placement.folder_ids);
      doc.organizer_entry_id.clone_from(&placement.organizer_entry_id);
    }
  }

  if conversion_failures > 0 {
    warn!(failures = conversion_failures, failed_docs = ?failed_doc_ids, "conversion failures");
  }

  info!(
    total = total_docs,
    loaded_with_payload = docs_needing_payload.len(),
    skipped_system_documents = skipped,
    deleted_since_last_sync = deleted_doc_ids.len(),
    conversion_failures,
    "doc loading complete"
  );

  Ok(LoadResult {
    docs,
    reference_documents,
    reference_external_ids,
    effective_updated_at,
    organizer_snapshot: organizer,
    organizer_folders: organizer_projection.folders,
    deleted_doc_ids,
    conversion_failures,
    failed_doc_ids,
    total_docs_in_workspace: total_docs,
    workspace_watermark,
  })
}

#[derive(Debug, Clone)]
pub struct ProjectionSelection {
  pub doc_ids: HashSet<Uuid>,
  pub used_fresh_document_graph: bool,
}

/// Select body payloads after path planning while retaining baseline hashes for
/// unrelated documents. A stale or incomplete dependency graph deliberately
/// falls back to full projection so path-dependent links cannot become stale.
pub async fn select_projection_doc_ids(
  pool: &PgPool,
  workspace_id: Uuid,
  docs: &[MyoxusDocState],
  effective_updated_at: &HashMap<Uuid, DateTime<Utc>>,
  since: Option<DateTime<Utc>>,
  baseline_doc_ids: &HashSet<Uuid>,
  existing_paths: &HashMap<Uuid, String>,
  pending_partial_doc_ids: Option<&HashSet<Uuid>>,
) -> Result<ProjectionSelection, SyncError> {
  let all_ids = docs.iter().map(|doc| doc.doc_id).collect::<HashSet<_>>();
  let Some(since) = since else {
    return Ok(ProjectionSelection {
      doc_ids: all_ids,
      used_fresh_document_graph: false,
    });
  };
  let mut selected = docs
    .iter()
    .filter(|doc| {
      (!baseline_doc_ids.contains(&doc.doc_id)
        && pending_partial_doc_ids.is_none_or(|pending| pending.contains(&doc.doc_id)))
        || pending_partial_doc_ids.is_some_and(|pending| pending.contains(&doc.doc_id))
        || effective_updated_at
          .get(&doc.doc_id)
          .is_none_or(|updated_at| *updated_at > since)
        || existing_paths
          .get(&doc.doc_id)
          .zip(doc.planned_repo_path.as_ref())
          .is_some_and(|(existing, planned)| existing != planned)
    })
    .map(|doc| doc.doc_id)
    .collect::<HashSet<_>>();
  if selected.is_empty() || selected.len() == all_ids.len() {
    return Ok(ProjectionSelection {
      doc_ids: selected,
      used_fresh_document_graph: false,
    });
  }

  let graph = PgDocumentGraphRepository::new(pool.clone());
  for doc in docs {
    let Some(expected_updated_at) = effective_updated_at.get(&doc.doc_id) else {
      return Ok(ProjectionSelection {
        doc_ids: all_ids,
        used_fresh_document_graph: false,
      });
    };
    let state = graph
      .get_index_state(workspace_id, doc.doc_id)
      .await
      .map_err(|error| SyncError::permanent(error.to_string(), doc.doc_id, "document_graph_freshness"))?;
    if state.is_none_or(|state| {
      state.stale_state != DocumentGraphStaleState::Current
        || state
          .source_updated_at
          .is_none_or(|indexed| indexed < *expected_updated_at)
    }) {
      debug!(doc_id = %doc.doc_id, "document graph is not fresh; projecting the complete inventory");
      return Ok(ProjectionSelection {
        doc_ids: all_ids,
        used_fresh_document_graph: false,
      });
    }
  }

  const MAX_INCOMING_OCCURRENCES_PER_TARGET: i64 = 10_000;
  let changed_targets = selected.iter().copied().collect::<Vec<_>>();
  for target_id in changed_targets {
    let incoming = graph
      .list_doc_occurrences(
        workspace_id,
        target_id,
        DocumentGraphDirection::Incoming,
        PageRequest {
          limit: MAX_INCOMING_OCCURRENCES_PER_TARGET + 1,
          offset: 0,
        },
      )
      .await
      .map_err(|error| SyncError::permanent(error.to_string(), target_id, "document_graph_dependencies"))?;
    if incoming.len() as i64 > MAX_INCOMING_OCCURRENCES_PER_TARGET {
      return Ok(ProjectionSelection {
        doc_ids: all_ids,
        used_fresh_document_graph: false,
      });
    }
    // Even a partial session may select a target without its referrers. Its
    // export-only anchors must include all current referrers, not just this
    // session's changed sources. Ordinary links keep the incremental subset.
    if incoming.iter().any(|occurrence| {
      all_ids.contains(&occurrence.source_doc_id)
        && occurrence.link_kind == DocumentGraphLinkKind::InlineReference
        && portable_markdown_block_id(occurrence.params_json.get("params")).is_some()
    }) {
      return Ok(ProjectionSelection {
        doc_ids: all_ids,
        used_fresh_document_graph: true,
      });
    }
    selected.extend(incoming.into_iter().filter_map(|occurrence| {
      pending_partial_doc_ids
        .is_none_or(|pending| pending.contains(&occurrence.source_doc_id))
        .then_some(occurrence.source_doc_id)
    }));
  }
  selected.retain(|doc_id| all_ids.contains(doc_id));
  Ok(ProjectionSelection {
    doc_ids: selected,
    used_fresh_document_graph: true,
  })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectionMetrics {
  pub payload_reads: usize,
  pub worker_concurrency: usize,
  pub reference_inventory_builds: usize,
}

/// Capture native bodies and reference targets once before file/path publication.
/// Precise native references expand the capture so unchanged target anchors
/// remain available without a second document read during rendering.
pub async fn capture_myoxus_docs_in_path_plan(
  pool: &PgPool,
  workspace_id: Uuid,
  server_origin: &str,
  docs: &[MyoxusDocState],
  authorized_documents: &[AuthorizedMarkdownDocument],
  external_ids: &HashMap<Uuid, String>,
  projection_doc_ids: &HashSet<Uuid>,
) -> Result<(myoxus_application::markdown::PreparedMarkdownBatchExport, HashSet<Uuid>), SyncError> {
  let batch = docs
    .iter()
    .filter_map(|doc| {
      Some(AuthorizedMarkdownBatchDocument {
        external_id: external_ids.get(&doc.doc_id)?.clone(),
        title: doc.title.clone(),
        path: doc.planned_repo_path.clone()?,
      })
    })
    .collect::<Vec<_>>();
  let reference_inventory = MarkdownBatchReferenceInventory::new_with_authorized(
    &format!("{}/workspace/{workspace_id}", server_origin.trim_end_matches('/')),
    authorized_documents.iter().cloned(),
    batch,
  )
  .map_err(|error| SyncError::permanent(error.to_string(), workspace_id, "document_reference_plan"))?;
  let doc_service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
  let mut payloads = load_projection_snapshots(&doc_service, workspace_id, projection_doc_ids).await?;
  let inspection_inventory = reference_inventory.clone();
  let (captured, needs_native_targets) = tokio::task::spawn_blocking(move || {
    let needed = payloads.values().try_fold(false, |needed, payload| {
      inspection_inventory
        .requires_native_export_targets(payload)
        .map(|current| needed || current)
    })?;
    Ok::<_, myoxus_application::markdown::ConversionError>((payloads, needed))
  })
  .await
  .map_err(|error| SyncError::permanent(error.to_string(), workspace_id, "document_reference_worker"))?
  .map_err(|error| SyncError::permanent(error.to_string(), workspace_id, "document_reference_plan"))?;
  payloads = captured;
  let mut selected = projection_doc_ids.clone();
  let (reference_inventory, snapshots) = if needs_native_targets {
    let remaining = external_ids
      .keys()
      .filter(|id| !payloads.contains_key(id))
      .copied()
      .collect::<HashSet<_>>();
    payloads.extend(load_projection_snapshots(&doc_service, workspace_id, &remaining).await?);
    selected.extend(docs.iter().map(|doc| doc.doc_id));
    let snapshots = payloads
      .into_iter()
      .map(|(id, payload)| {
        external_ids
          .get(&id)
          .cloned()
          .map(|external_id| (external_id, payload))
          .ok_or_else(|| SyncError::permanent("missing external document key", id, "document_reference_plan"))
      })
      .collect::<Result<HashMap<_, _>, _>>()?;
    let prepared = tokio::task::spawn_blocking(move || reference_inventory.prepare_export_snapshots(snapshots))
      .await
      .map_err(|error| SyncError::permanent(error.to_string(), workspace_id, "document_reference_worker"))?
      .map_err(|error| SyncError::permanent(error.to_string(), workspace_id, "document_reference_plan"))?;
    (prepared.references, prepared.snapshots)
  } else {
    (
      reference_inventory,
      payloads
        .into_iter()
        .map(|(id, payload)| {
          (
            external_ids.get(&id).cloned().unwrap_or_else(|| id.to_string()),
            payload,
          )
        })
        .collect(),
    )
  };
  Ok((
    myoxus_application::markdown::PreparedMarkdownBatchExport {
      references: reference_inventory,
      snapshots,
    },
    selected,
  ))
}

/// Serialize the same frozen capture after native asset paths have been admitted.
pub async fn project_myoxus_docs_in_path_plan(
  docs: &mut [MyoxusDocState],
  external_ids: &HashMap<Uuid, String>,
  captured: myoxus_application::markdown::PreparedMarkdownBatchExport,
  selected: &HashSet<Uuid>,
  parallel_threshold: usize,
  asset_paths: &HashMap<String, String>,
) -> Result<
  (
    i32,
    Vec<Uuid>,
    ProjectionMetrics,
    myoxus_application::markdown::PreparedMarkdownBatchExport,
  ),
  SyncError,
> {
  let myoxus_application::markdown::PreparedMarkdownBatchExport {
    references: reference_inventory,
    snapshots,
  } = captured;
  let payload_reads = snapshots.len();
  let inputs = docs
    .iter()
    .filter(|doc| selected.contains(&doc.doc_id))
    .map(|doc| {
      let external_id = external_ids
        .get(&doc.doc_id)
        .cloned()
        .unwrap_or_else(|| doc.doc_id.to_string());
      (
        doc.doc_id,
        doc.title.clone(),
        doc.planned_repo_path.clone(),
        external_id,
      )
    })
    .collect::<Vec<_>>();
  let parallel = inputs.len() > parallel_threshold;
  let concurrency = if parallel { inputs.len().min(8) } else { 1 };
  let snapshots = Arc::new(snapshots);
  let asset_paths = Arc::new(asset_paths.clone());
  let results = stream::iter(inputs)
    .map(|(doc_id, title, path, external_id)| {
      let snapshots = snapshots.clone();
      let asset_paths = asset_paths.clone();
      let reference_inventory = reference_inventory.clone();
      async move {
        let result = async {
          let path =
            path.ok_or_else(|| SyncError::permanent("missing planned repository path", doc_id, "path_plan"))?;
          tokio::task::spawn_blocking(move || {
            let references = reference_inventory
              .for_source(&path)
              .map_err(|error| SyncError::permanent(error.to_string(), doc_id, "document_reference_plan"))?;
            project_document_in_batch_with_images(
              &snapshots[&external_id],
              &title,
              MarkdownProjectionPolicy::default(),
              &references,
              &|key| {
                // Unbound opaque/data/external sources keep the existing codec
                // contract; a missing mapping must never mean dropping an image.
                asset_paths
                  .get(key)
                  .and_then(|path| references.resolve_export_asset_path(path))
                  .or_else(|| Some(key.to_string()))
              },
            )
            .map(|projected| (doc_id, projected.markdown, projected.content_hash))
            .map_err(|error| SyncError::permanent(error.to_string(), doc_id, "document_projection"))
          })
          .await
          .map_err(|error| SyncError::permanent(error.to_string(), doc_id, "document_projection_worker"))?
        }
        .await;
        (doc_id, result)
      }
    })
    .buffered(concurrency)
    .collect::<Vec<_>>()
    .await;
  let mut projected = HashMap::with_capacity(results.len());
  let mut failures = Vec::new();
  for (doc_id, result) in results {
    match result {
      Ok((_projected_doc_id, markdown, content_hash)) => {
        projected.insert(doc_id, (markdown, content_hash));
      }
      Err(error) => {
        warn!(%doc_id, error = %error, "yjs→markdown conversion failed");
        failures.push(doc_id);
      }
    }
  }
  for doc in docs {
    if let Some((markdown, content_hash)) = projected.remove(&doc.doc_id) {
      doc.markdown = Some(markdown);
      doc.content_hash = Some(content_hash);
    }
  }
  Ok((
    failures.len() as i32,
    failures,
    ProjectionMetrics {
      payload_reads,
      worker_concurrency: concurrency,
      reference_inventory_builds: 1,
    },
    myoxus_application::markdown::PreparedMarkdownBatchExport {
      references: reference_inventory,
      snapshots: Arc::unwrap_or_clone(snapshots),
    },
  ))
}

/// Admit only referenced, completed workspace media into the native file plan.
/// Candidate bindings remain in memory until the existing atomic run finalizer.
pub(super) async fn admit_referenced_assets(
  pool: &PgPool,
  storage: &dyn myoxus_application::ports::BlobStoragePort,
  profile: &myoxus_domain::git_sync::GitSyncProfile,
  capture: &myoxus_application::markdown::PreparedMarkdownBatchExport,
  repo_dir: &Path,
  document_paths: &HashMap<Uuid, String>,
  bindings: &mut Vec<myoxus_domain::git_sync::GitSyncFileBinding>,
  mime_config: &MimePolicyConfig,
  scope: &GitSyncWriterScope,
) -> Result<(), String> {
  use myoxus_application::ports::blob::{BlobKey, BlobStatus, BlobStore};
  let mut keys = std::collections::BTreeSet::new();
  for payload in capture.snapshots.values() {
    keys.extend(
      yjs::extract_portable_asset_references(payload)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|asset| asset.source_key),
    );
  }
  let limits = myoxus_workspace_import::WorkspaceImportLimits::default();
  if keys.len() > limits.max_assets {
    return Err("Markdown asset count limit exceeded".into());
  }
  let store = myoxus_infrastructure::blob::SqlxBlobStore::new(pool.clone());
  let mut total = 0u64;
  let observed = if keys.is_empty() {
    std::collections::BTreeSet::new()
  } else {
    observed_output_paths(repo_dir, &profile.root_path, None, scope).await?
  };
  for key in keys {
    if bindings.iter().any(|binding| binding.blob_key == key) {
      continue;
    }
    let parsed = match BlobKey::parse(&key) {
      Ok(parsed) => parsed,
      Err(_) => continue, // Opaque external/data sources retain the normal codec contract.
    };
    let Some(metadata) = store
      .get_blob_metadata(profile.workspace_id, &parsed)
      .await
      .map_err(|error| error.to_string())?
    else {
      continue;
    };
    if metadata.status != BlobStatus::Completed || metadata.deleted_at.is_some() {
      return Err("referenced Markdown asset is unavailable".into());
    }
    total = total.checked_add(metadata.size).ok_or("Markdown asset size overflow")?;
    if total > limits.max_asset_bytes || metadata.size > limits.max_entry_bytes || metadata.size > MAX_FILE_SIZE_BYTES {
      return Err("Markdown asset byte limit exceeded".into());
    }
    let path = myoxus_application::git_sync::export::asset_repo_path(&profile.root_path, &key, &metadata.mime)
      .map_err(|error| error.to_string())?;
    RepoPath::new(path.clone())?;
    if scope.excludes(&path).map_err(|error| error.to_string())? {
      return Err("Markdown asset destination enters a delegated repository scope".into());
    }
    let folded = path.to_lowercase();
    if document_paths
      .values()
      .chain(bindings.iter().map(|binding| &binding.repo_path))
      .chain(observed.iter())
      .any(|other| {
        let other = other.to_lowercase();
        other == folded || other.starts_with(&format!("{folded}/")) || folded.starts_with(&format!("{other}/"))
      })
    {
      return Err("Markdown asset destination is occupied".into());
    }
    // Never adopt an unrelated remote file, including a symlinked ancestor.
    let mut cursor = repo_dir.to_path_buf();
    for segment in path.split('/') {
      cursor.push(segment);
      match tokio::fs::symlink_metadata(&cursor).await {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
          return Err("Markdown asset destination is occupied".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
      }
    }
    let bytes = storage
      .read_blob(&parsed.storage_key(profile.workspace_id))
      .await
      .map_err(|error| error.to_string())?
      .data;
    let hash = hex::encode(Sha256::digest(&bytes));
    if bytes.len() as u64 != metadata.size || metadata.checksum.as_ref().is_some_and(|expected| expected != &hash) {
      return Err("Markdown asset bytes changed".into());
    }
    let detection = mime_policy::detect_mime(&bytes, &path, &metadata.mime);
    match mime_policy::evaluate_policy(&detection, mime_config) {
      MimePolicyDecision::Deny { .. } => return Err("referenced Markdown asset denied by MIME policy".into()),
      MimePolicyDecision::Warn { .. } => warn!("referenced Markdown asset has a MIME policy warning"),
      MimePolicyDecision::Allow => {}
    }
    let now = Utc::now();
    bindings.push(myoxus_domain::git_sync::GitSyncFileBinding {
      id: Uuid::new_v4(),
      profile_id: profile.id,
      workspace_id: profile.workspace_id,
      blob_key: key,
      repo_path: path,
      content_hash: hash,
      mime_type: detection.effective_mime,
      file_size: bytes.len() as i64,
      tombstoned: false,
      created_at: now,
      updated_at: now,
    });
  }
  Ok(())
}

/// Capture each snapshot-plus-tail body once, through the normal document
/// service. This read fence precedes both export preparation and Git mutation.
pub(super) async fn load_projection_snapshots(
  service: &DocService,
  workspace_id: Uuid,
  ids: &HashSet<Uuid>,
) -> Result<HashMap<Uuid, Vec<u8>>, SyncError> {
  stream::iter(ids.iter().copied())
    .map(|id| {
      let service = service.clone();
      async move {
        service
          .load
          .load_full_doc_with_revision_bounded(
            workspace_id,
            id,
            myoxus_application::doc::ExternalUpdateIngressPolicy::default().max_update_bytes,
          )
          .await
          .map(|state| (id, state.payload))
          .map_err(|error| SyncError::permanent(error.to_string(), id, "load_full_doc"))
      }
    })
    .buffered(8)
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .collect()
}

/// Scan the Git working tree for markdown files (`.md` only).
///
/// The reconcile planner consumes this as the complete current Git side of a
/// three-way comparison. A commit delta must never be substituted here: an
/// unchanged tracked path omitted from a delta is otherwise indistinguishable
/// from a deletion and can tombstone a valid binding.
///
/// All returned paths are validated against [`RepoPath`] rules (no traversal,
/// no absolute paths, no null bytes) before being returned to the caller.
///
/// Returns `Vec<(repo_path, content)>` pairs.
#[instrument(skip_all)]
pub fn load_git_files(
  repo_dir: &Path,
  root_path: &str,
  manifest: Option<&myoxus_application::git_sync::export::GitSyncManifest>,
  workspace_id: Uuid,
  ordinary_paths: &[String],
  scope: &GitSyncWriterScope,
) -> Result<Vec<(String, String)>, String> {
  let scan_dir = repo_dir.join(root_path);
  // A new managed root can legitimately be absent; a present but unreadable
  // tree cannot be substituted with an empty side of reconciliation.
  let raw_files = if !scan_dir.try_exists().map_err(|error| error.to_string())? {
    Vec::new()
  } else {
    if scan_dir.is_symlink()
      || !scan_dir
        .canonicalize()
        .map_err(|error| error.to_string())?
        .starts_with(repo_dir.canonicalize().map_err(|error| error.to_string())?)
    {
      return Err("Git managed root must remain inside the captured repository".into());
    }
    import::scan_markdown_files_scoped(&scan_dir, root_path, scope)?
  };
  let owned_manifest = manifest
    .map(|previous| scope.owned_manifest(previous))
    .transpose()
    .map_err(|error| error.to_string())?;
  let owned_ordinary_paths = ordinary_paths
    .iter()
    .filter_map(|path| match scope.excludes(path) {
      Ok(false) => Some(Ok(path.as_str())),
      Ok(true) => None,
      Err(error) => Some(Err(error.to_string())),
    })
    .collect::<Result<Vec<_>, _>>()?;
  let owned = myoxus_application::git_sync::overview::classify_git_overview_paths(
    workspace_id,
    owned_manifest.as_ref(),
    owned_ordinary_paths,
    raw_files
      .iter()
      .map(|(path, content)| (path.as_str(), content.as_bytes())),
  )?;
  Ok(validate_file_paths(
    raw_files
      .into_iter()
      .filter(|(path, _)| !owned.contains(path))
      .collect(),
  ))
}

/// Allocation sees policy-denied and unrelated regular files as occupied too.
/// Discovery remains complete within this writer's owned scope; delegated
/// directories are pruned before any Markdown or asset bytes are read.
pub(super) async fn observed_output_paths(
  repo_dir: &Path,
  root: &str,
  previous: Option<&myoxus_application::git_sync::export::GitSyncManifest>,
  scope: &GitSyncWriterScope,
) -> Result<std::collections::BTreeSet<String>, String> {
  let repo_dir = repo_dir.to_path_buf();
  let root = root.to_string();
  let scope = scope.clone();
  let old = previous
    .into_iter()
    .flat_map(|manifest| {
      manifest
        .overview
        .iter()
        .chain(manifest.folders.iter().filter_map(|folder| folder.overview.as_ref()))
    })
    .map(|output| output.repo_path.clone())
    .collect::<Vec<_>>();
  tokio::task::spawn_blocking(move || {
    let mut paths = std::collections::BTreeSet::new();
    let source = repo_dir.join(&root);
    if source.try_exists().map_err(|error| error.to_string())? {
      paths.extend(
        import::scan_markdown_files_scoped(&source, &root, &scope)?
          .into_iter()
          .map(|(path, _)| path),
      );
      paths.extend(scan_non_md_files_scoped(&source, &root, &scope)?);
    }
    for path in old {
      if scope.excludes(&path).map_err(|error| error.to_string())? {
        continue;
      }
      let candidate = repo_dir.join(&path);
      if candidate.is_symlink() {
        return Err("previous overview path is now a symlink".into());
      }
      if candidate.is_file() {
        paths.insert(path);
      }
    }
    Ok(paths)
  })
  .await
  .map_err(|error| error.to_string())?
}

/// Filter out file entries whose repo_path fails [`RepoPath`] validation.
fn validate_file_paths(files: Vec<(String, String)>) -> Vec<(String, String)> {
  let before = files.len();
  let valid: Vec<(String, String)> = files
    .into_iter()
    .filter(|(path, _)| {
      if is_git_sync_control_path(path) {
        return false;
      }
      match RepoPath::new(path.as_str()) {
        Ok(_) => true,
        Err(reason) => {
          warn!(path, reason, "skipping file with invalid repo path");
          false
        }
      }
    })
    .collect();
  let skipped = before - valid.len();
  if skipped > 0 {
    warn!(skipped, "files skipped due to invalid repo paths");
  }
  valid
}

// ── File object loading (M2-B1) ────────────────────────────────────────

/// Scan the Git working tree for non-markdown files (file objects / binary blobs).
///
/// Like [`load_git_files`], this returns the complete current Git side required
/// by three-way reconciliation. It does not expose a commit delta as current
/// state.
///
/// Applies MIME detection and policy evaluation **early** (before any heavy
/// processing or DB writes) to filter out denied files at the pipeline boundary.
/// This prevents blocked file types from consuming memory or disk I/O.
///
/// Returns a [`FileLoadResult`] with accepted items, denied/warned counts.
#[instrument(skip_all)]
pub async fn load_git_file_objects(
  repo_dir: &Path,
  root_path: &str,
  mime_policy_config: &MimePolicyConfig,
  scope: &GitSyncWriterScope,
) -> Result<FileLoadResult, String> {
  let raw_paths = collect_non_md_paths(repo_dir, root_path, scope).await?;

  // Validate repo paths at the pipeline boundary (H4: RepoPath validation).
  let non_md_paths: Vec<String> = raw_paths
    .into_iter()
    .filter(|path| {
      if is_git_sync_control_path(path) {
        return false;
      }
      match RepoPath::new(path.as_str()) {
        Ok(_) => true,
        Err(reason) => {
          warn!(
            path = path.as_str(),
            reason, "skipping non-md file with invalid repo path"
          );
          false
        }
      }
    })
    .collect();
  trace!(
    count = non_md_paths.len(),
    root_path, "collected non-markdown file paths for classification"
  );

  classify_file_objects(repo_dir, &non_md_paths, mime_policy_config).await
}

/// Collect relative paths of non-.md files from the git working tree.
///
/// Recursively enumerate the complete non-Markdown working-tree state.
async fn collect_non_md_paths(
  repo_dir: &Path,
  root_path: &str,
  scope: &GitSyncWriterScope,
) -> Result<Vec<String>, String> {
  let scan_dir = repo_dir.join(root_path);
  // A first sync may create its managed root; only an existing unreadable
  // tree is unsafe to treat as an empty inbound inventory.
  if !scan_dir.try_exists().map_err(|error| error.to_string())? {
    return Ok(Vec::new());
  }
  let root_prefix = root_path.to_string();
  let scope = scope.clone();
  match tokio::task::spawn_blocking(move || scan_non_md_files_scoped(&scan_dir, &root_prefix, &scope)).await {
    Ok(Ok(paths)) => {
      debug!(count = paths.len(), root_path, "full non-md directory scan");
      Ok(paths)
    }
    Ok(Err(error)) => Err(error),
    Err(error) => Err(format!("join non-Markdown scan: {error}")),
  }
}

/// Maximum recursion depth for non-markdown file scanning (MED-04).
/// 20 levels is more than sufficient for any reasonable repo structure.
const MAX_SCAN_DEPTH: u32 = 20;

/// Recursively scan a directory for non-.md files, returning relative paths.
#[cfg(test)]
fn scan_non_md_files_recursive(dir: &Path, prefix: &str) -> Result<Vec<String>, String> {
  scan_non_md_files_scoped(dir, prefix, &GitSyncWriterScope::new(Vec::new()))
}

fn scan_non_md_files_scoped(dir: &Path, prefix: &str, scope: &GitSyncWriterScope) -> Result<Vec<String>, String> {
  let mut paths = Vec::new();
  let prefix = prefix.trim_end_matches('/');
  scan_non_md_dir(dir, prefix, &mut paths, 0, scope)?;
  Ok(paths)
}

fn scan_non_md_dir(
  dir: &Path,
  prefix: &str,
  paths: &mut Vec<String>,
  depth: u32,
  scope: &GitSyncWriterScope,
) -> Result<(), String> {
  if depth > MAX_SCAN_DEPTH {
    warn!(dir = %dir.display(), depth, "scan_non_md_dir: skipping directory beyond max recursion depth");
    return Ok(());
  }

  let entries = std::fs::read_dir(dir).map_err(|e| format!("read dir failed: {e}"))?;
  for entry in entries {
    let entry = entry.map_err(|e| format!("dir entry error: {e}"))?;
    let path = entry.path();

    // Skip symlinks to avoid infinite loops
    if path.is_symlink() {
      trace!(path = %path.display(), "skipping symlink in non-md scan");
      continue;
    }

    if path.is_dir() {
      let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
      // Skip hidden directories and .git
      if name.starts_with('.') {
        continue;
      }
      let sub_prefix = if prefix.is_empty() {
        name.to_string()
      } else {
        format!("{prefix}/{name}")
      };
      if !scope.excludes(&sub_prefix).map_err(|error| error.to_string())? {
        scan_non_md_dir(&path, &sub_prefix, paths, depth + 1, scope)?;
      }
    } else if path.is_file() {
      // Skip .md files — those go through the document pipeline
      let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
      if ext.eq_ignore_ascii_case("md") {
        continue;
      }
      let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
      // Skip hidden files
      if file_name.starts_with('.') {
        continue;
      }
      let rel_path = if prefix.is_empty() {
        file_name.to_string()
      } else {
        format!("{prefix}/{file_name}")
      };
      if !scope.excludes(&rel_path).map_err(|error| error.to_string())? {
        paths.push(rel_path);
      }
    }
  }
  Ok(())
}

/// GS-HIGH-04: Hard limit on file size to prevent OOM from large binaries in git repos.
/// 100 MB — deliberately generous to allow images/PDFs but reject multi-GB binaries.
const MAX_FILE_SIZE_BYTES: u64 = 100 * 1024 * 1024;

/// Read file bytes, run MIME detection + policy, and classify each file.
async fn classify_file_objects(
  repo_dir: &Path,
  paths: &[String],
  mime_policy_config: &MimePolicyConfig,
) -> Result<FileLoadResult, String> {
  let total_scanned = paths.len();
  let mut items = Vec::with_capacity(paths.len());
  let mut denied_count: usize = 0;
  let mut warned_count: usize = 0;

  for rel_path in paths {
    let full_path = repo_dir.join(rel_path);

    // GS-HIGH-04: Check file size before reading to prevent OOM on large binaries.
    match tokio::fs::metadata(&full_path).await {
      Ok(meta) if meta.len() > MAX_FILE_SIZE_BYTES => {
        warn!(
          path = %rel_path,
          size_bytes = meta.len(),
          max_bytes = MAX_FILE_SIZE_BYTES,
          "skipping file exceeding size limit"
        );
        denied_count += 1;
        continue;
      }
      Err(e) => {
        trace!(path = %rel_path, error = %e, "non-md file metadata not readable, skipping");
        continue;
      }
      _ => {}
    }

    let bytes = match tokio::fs::read(&full_path).await {
      Ok(b) => b,
      Err(e) => {
        trace!(path = %rel_path, error = %e, "non-md file not readable, skipping");
        continue;
      }
    };

    if std::str::from_utf8(&bytes).is_ok_and(myoxus_application::git_sync::overview::is_git_overview_marked) {
      return Err(format!(
        "unknown read-only overview `{rel_path}` cannot be imported as a file object"
      ));
    }

    // Extract filename for MIME detection
    let file_name = Path::new(rel_path)
      .file_name()
      .and_then(|n| n.to_str())
      .unwrap_or(rel_path);

    // MIME detection (no declared MIME for git files)
    let mime_result = mime_policy::detect_mime(&bytes, file_name, "");

    // Policy evaluation
    let policy_decision = mime_policy::evaluate_policy(&mime_result, mime_policy_config);

    trace!(
      path = %rel_path,
      effective_mime = %mime_result.effective_mime,
      confidence = %mime_result.confidence,
      decision = ?policy_decision,
      kind = "File",
      "classified non-md file"
    );

    match &policy_decision {
      MimePolicyDecision::Deny { reason } => {
        warn!(
          path = %rel_path,
          effective_mime = %mime_result.effective_mime,
          reason = %reason,
          "file denied by MIME policy, skipping"
        );
        denied_count += 1;
        continue;
      }
      MimePolicyDecision::Warn { reason } => {
        warn!(
          path = %rel_path,
          effective_mime = %mime_result.effective_mime,
          reason = %reason,
          "file allowed with MIME policy warning"
        );
        warned_count += 1;
        // Fall through — include the file with warning flag
      }
      MimePolicyDecision::Allow => {}
    }

    // Compute content hash
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let content_hash = format!("{:x}", hasher.finalize());

    items.push(LoadedFileItem {
      repo_path: rel_path.clone(),
      content_hash,
      bytes,
      mime_result,
      policy_decision,
    });
  }

  info!(
    total_scanned,
    accepted = items.len(),
    denied = denied_count,
    warned = warned_count,
    "file object classification complete"
  );

  Ok(FileLoadResult {
    items,
    denied_count,
    warned_count,
    total_scanned,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn non_md_scan_normalizes_trailing_prefix_slash() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("content");
    std::fs::create_dir_all(root.join("assets")).expect("create assets dir");
    std::fs::write(root.join("assets/check.png"), b"png").expect("write file");

    let paths = scan_non_md_files_recursive(&root, "content/").expect("scan non-md files");

    assert_eq!(paths, vec!["content/assets/check.png"]);
  }
}

/// Current ACL evaluation is separate from frozen body capture and is repeated
/// immediately before publication. Cached bodies never serve as authorization.
pub(super) async fn authorize_projection_documents(
  pool: &PgPool,
  workspace_id: Uuid,
  actor: Uuid,
  ids: &HashSet<Uuid>,
) -> Result<(), SyncError> {
  let permissions = projection_permissions(pool);
  let live: Vec<Uuid> = sqlx::query_scalar(
    "SELECT id FROM docs WHERE workspace_id=$1 AND id=ANY($2) AND deleted_at IS NULL AND blocked=false AND NOT is_workspace_root",
  )
  .bind(workspace_id)
  .bind(ids.iter().copied().collect::<Vec<_>>())
  .fetch_all(pool)
  .await
  .map_err(|error| SyncError::database(error.to_string(), "document_authorization"))?;
  let readable = permissions
    .readable_doc_ids(actor, workspace_id, &ids.iter().copied().collect::<Vec<_>>())
    .await
    .map_err(|error| SyncError::permanent(error.to_string(), workspace_id, "document_authorization"))?;
  if readable != *ids || live.into_iter().collect::<HashSet<_>>() != *ids {
    return Err(SyncError::permanent(
      "missing or inaccessible Markdown export document",
      workspace_id,
      "document_authorization",
    ));
  }
  Ok(())
}

/// Use the ordinary effective-role authority, including its organization
/// projection. The runner's separate accepted-membership admission still applies.
pub(super) fn projection_permissions(pool: &PgPool) -> myoxus_application::permission::PermissionService {
  use myoxus_infrastructure::organization::{
    PgOrganizationPolicyRepository, PgOrganizationUnitMemberRepository, PgOrganizationUnitRepository,
    PgOrganizationUnitWorkspaceRepository, PgUserFeatureLookup,
  };
  myoxus_application::permission::PermissionService::new(Arc::new(
    myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone()),
  ))
  .with_organization_permissions(Arc::new(
    myoxus_application::organization::OrganizationPermissionService::new(
      Arc::new(PgOrganizationUnitMemberRepository::new(pool.clone())),
      Arc::new(PgOrganizationUnitRepository::new(pool.clone())),
      Arc::new(PgOrganizationUnitWorkspaceRepository::new(pool.clone())),
      Arc::new(PgOrganizationPolicyRepository::new(pool.clone())),
      Arc::new(PgUserFeatureLookup::new(pool.clone())),
    ),
  ))
}
