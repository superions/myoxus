// SPDX-License-Identifier: AGPL-3.0-or-later
//! PostgreSQL persistence for cross-workspace content operations.
//!
//! The repository persists bounded metadata and opaque staging references. It
//! never stores raw document, database, or blob payloads and never treats a
//! process-local instance id as state-machine authority.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::git_sync::{export as git_export, overview as git_overview, projection as git_projection};
use myoxus_application::organizer::{OrganizerService, OrganizerSnapshot, OrganizerSnapshotNode};
use myoxus_application::ports::blob_service::{OperationBlobMaterialization, OperationBlobOwnership};
use myoxus_application::ports::{BlobStoragePort, BlobWriteRequest, PortError};
use myoxus_application::workspace_content_operation::authorization::{
  WorkspaceContentAuthorizationSource, WorkspaceContentAuthorizationState, WorkspaceContentMemberRevision,
  WorkspaceContentOwnerPrincipal, WorkspaceContentWorkspaceRevision,
};
use myoxus_application::workspace_content_operation::control::{
  WorkspaceContentGraphSourcePort, WorkspaceContentPreparedGraph,
};
use myoxus_application::workspace_content_operation::extract::{
  WorkspaceContentExtractContextPort, WorkspaceContentExtractRecoveryPort, WorkspaceContentExtractTarget,
  WorkspaceContentExtractTargetPort, WorkspaceContentExtractTargetRequest,
};
use myoxus_application::workspace_content_operation::link::{
  WorkspaceContentLinkPublicationBatch, WorkspaceContentLinkPublicationPort,
};
use myoxus_application::workspace_content_operation::move_publication::{
  MOVE_TAG_MANIFEST_VERSION, WorkspaceContentMoveBlobRevision, WorkspaceContentMoveDatabaseRevision,
  WorkspaceContentMoveDocumentRevision, WorkspaceContentMoveOrganizerRevision, WorkspaceContentMovePublicationBatch,
  WorkspaceContentMovePublicationPort, WorkspaceContentMoveRevisionManifest, WorkspaceContentMoveRevisionManifestPort,
  WorkspaceContentMoveTagLineage, WorkspaceContentMoveTagManifest, WorkspaceContentMoveTagPosition,
  WorkspaceContentMoveWorkspaceRevision, WorkspaceContentRecipientSnapshot, WorkspaceContentRecipientSnapshotPort,
};
use myoxus_application::workspace_content_operation::notification::{
  WorkspaceContentNotificationIntent, WorkspaceContentNotificationOutboxPort,
};
use myoxus_application::workspace_content_operation::overview::{
  WorkspaceContentOverviewSnapshot, WorkspaceContentOverviewState, has_folder_mappings,
};
use myoxus_application::workspace_content_operation::preflight::{
  WorkspaceContentGraphBuilder, WorkspaceContentGraphInput, WorkspaceContentGraphReference,
  WorkspaceContentGraphResource, WorkspaceContentPreflightGraph, WorkspaceContentReferencePurpose,
  WorkspaceContentSelection, WorkspaceContentTargetDefinition,
};
use myoxus_application::workspace_content_operation::publication::{
  WorkspaceContentCopyPublicationBatch, WorkspaceContentCopyPublicationPort, WorkspaceContentPublicationObject,
};
use myoxus_application::workspace_content_operation::reconcile::WorkspaceContentReconcileAction;
use myoxus_application::workspace_content_operation::{
  MAX_COMPENSATION_KIND_BYTES, MAX_DIAGNOSTIC_INSTANCE_ID_BYTES, MAX_EXTRACT_WORKSPACE_NAME_BYTES,
  MAX_ORGANIZER_ENTRY_ID_BYTES, MAX_ORGANIZER_INDEX_BYTES, MAX_PREVIEW_REVISION_BYTES, MAX_RECIPIENT_EVENT_KIND_BYTES,
  WorkspaceContentCompensationIntent, WorkspaceContentControlRepository, WorkspaceContentCreateResult,
  WorkspaceContentExecuteRequest, WorkspaceContentExecutionMembership, WorkspaceContentGitSyncCapturePort,
  WorkspaceContentGitSyncChoice, WorkspaceContentGitSyncDelegation, WorkspaceContentGitSyncDocument,
  WorkspaceContentGitSyncFile, WorkspaceContentGitSyncPlan, WorkspaceContentLinkIntent,
  WorkspaceContentLinkIntentRepository, WorkspaceContentOperationRepository, WorkspaceContentOperationRequest,
  WorkspaceContentOperationSelection, WorkspaceContentRecipientIntent, WorkspaceContentRedirect,
  WorkspaceContentRedirectRepository, WorkspaceContentStagingManifestRepository,
};
use myoxus_domain::entities::{DocumentMetadataProjection, DocumentMetadataSource, OwnerPrincipalType, WorkspaceRole};
use myoxus_domain::ids::{UserId, WorkspaceContentOperationId};
use myoxus_domain::workspace_content_operation::{
  RedactedWorkspaceContentError, WorkspaceContentBlocker, WorkspaceContentErrorCode, WorkspaceContentIdMapping,
  WorkspaceContentOperationKind, WorkspaceContentOperationRecord, WorkspaceContentOperationStatus,
  WorkspaceContentResourceKind, WorkspaceContentResourceRef, WorkspaceContentStagingEntry,
  WorkspaceContentStagingStatus,
};
use myoxus_domain::workspace_tags::WorkspaceTag;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use tracing::{Instrument, error, instrument, warn};
use uuid::Uuid;

use crate::git_sync::SqlxGitSyncStore;
use crate::workspace::SqlxWorkspaceStore;
use crate::workspace_database::PgDatabaseRepository;
use crate::workspace_tags::PgWorkspaceTagRepository;

mod git_handoff;
mod git_undo;

#[derive(Clone, Debug)]
pub struct PgWorkspaceContentOperationRepository {
  pool: PgPool,
  database_templates: Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
}

fn move_recipient_snapshot_revision(
  source_workspace_id: Uuid,
  source_workspace_name: &str,
  recipients: &[(Uuid, String)],
) -> String {
  let mut digest = Sha256::new();
  digest.update(source_workspace_id.as_bytes());
  digest.update(source_workspace_name.as_bytes());
  for (user_id, role) in recipients {
    digest.update(user_id.as_bytes());
    digest.update([0]);
    digest.update(role.as_bytes());
    digest.update([0xff]);
  }
  hex::encode(digest.finalize())
}

#[derive(Clone)]
pub struct PgWorkspaceContentAuthorizationSource {
  pool: PgPool,
}

/// PostgreSQL/Yjs-backed topology source for API admission.
#[derive(Clone)]
pub struct PgWorkspaceContentGraphSource {
  pool: PgPool,
  doc: myoxus_application::doc::DocService,
  organizer: OrganizerService<myoxus_application::doc::DocService>,
  git_capture: Option<Arc<dyn WorkspaceContentGitSyncCapturePort>>,
}

#[derive(Clone)]
pub struct PgWorkspaceContentRedirectRepository {
  pool: PgPool,
  doc: myoxus_application::doc::DocService,
  organizer: OrganizerService<myoxus_application::doc::DocService>,
}

impl PgWorkspaceContentRedirectRepository {
  pub fn new(pool: PgPool, doc: myoxus_application::doc::DocService) -> Self {
    Self {
      pool,
      doc: doc.clone(),
      organizer: OrganizerService::new(doc),
    }
  }
}

impl PgWorkspaceContentGraphSource {
  pub fn new(pool: PgPool, doc: myoxus_application::doc::DocService) -> Self {
    Self {
      pool,
      doc: doc.clone(),
      organizer: OrganizerService::new(doc),
      git_capture: None,
    }
  }

  pub fn with_git_capture(mut self, capture: Arc<dyn WorkspaceContentGitSyncCapturePort>) -> Self {
    self.git_capture = Some(capture);
    self
  }
}

/// Reconstruct the Git ownership side of an Extract from persisted profile,
/// Organizer and binding facts. An absent profile is not a Git choice; an
/// ambiguous profile or path is a blocker, never an implicit Disconnect.
async fn extract_git_scope_plan(
  pool: &PgPool,
  actor_id: UserId,
  request: &WorkspaceContentOperationRequest,
  organizer: &OrganizerSnapshot,
  graph: &WorkspaceContentPreflightGraph,
  capture: Option<&dyn WorkspaceContentGitSyncCapturePort>,
) -> AuthResult<(Option<WorkspaceContentGitSyncPlan>, Vec<WorkspaceContentBlocker>)> {
  let profile_ids: Vec<Uuid> =
    sqlx::query_scalar("SELECT id FROM git_sync_profiles WHERE workspace_id = $1 ORDER BY id")
      .bind(request.source_workspace_id)
      .fetch_all(pool)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
  let Some(&profile_id) = profile_ids.first() else {
    return if request.git_sync_choice.is_some() {
      Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::RequestInvalid.as_str().into(),
      ))
    } else {
      Ok((None, Vec::new()))
    };
  };
  if profile_ids.len() != 1 {
    return Ok((None, vec![WorkspaceContentBlocker::GitSyncScopeAmbiguous]));
  }
  let store = SqlxGitSyncStore::new(pool.clone());
  let profile = store
    .get_profile(profile_id)
    .await
    .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::InventoryInvalid.as_str().into()))?;
  let choice = request.git_sync_choice.unwrap_or(WorkspaceContentGitSyncChoice::Move);
  let scope = store
    .writer_scope(&profile)
    .await
    .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::InventoryInvalid.as_str().into()))?;
  let mut blockers = Vec::new();
  let busy:bool=sqlx::query_scalar("SELECT
    EXISTS(SELECT 1 FROM git_sync_runs WHERE profile_id=$1 AND (status IN ('Pending','Running') OR reconciliation_required))
    OR EXISTS(SELECT 1 FROM git_sync_partial_sessions WHERE profile_id=$1 AND status='Open')
    OR EXISTS(SELECT 1 FROM git_sync_bootstrap_attempts WHERE profile_id=$1 AND phase IN ('Prepared','RemoteApplied'))
    OR EXISTS(SELECT 1 FROM git_sync_profiles p JOIN git_sync_credentials c ON c.id=p.credential_id JOIN git_token_rotation r ON r.profile_id=c.profile_id WHERE p.id=$1 AND r.state='Rotating')
    OR EXISTS(SELECT 1 FROM workspace_content_extract_targets WHERE git_sync_pending AND git_sync_plan->>'sourceProfileId'=$1::text)")
    .bind(profile_id).fetch_one(pool).await.map_err(PgWorkspaceContentOperationRepository::storage)?;
  if busy {
    blockers.push(WorkspaceContentBlocker::GitSyncBusy);
  }
  if store.assert_profile_scope_unambiguous(&profile).await.is_err() {
    blockers.push(WorkspaceContentBlocker::GitSyncScopeAmbiguous);
  }
  let doc_rows = sqlx::query("SELECT id, external_id FROM docs WHERE workspace_id = $1 AND external_id IS NOT NULL")
    .bind(request.source_workspace_id)
    .fetch_all(pool)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  let ids_by_external = doc_rows
    .into_iter()
    .map(|row| (row.get::<String, _>("external_id"), row.get::<Uuid, _>("id")))
    .collect();
  let projection = git_projection::project_organizer(organizer, &ids_by_external);
  let folder_id = match &request.selection {
    WorkspaceContentOperationSelection::FolderSubtree { folder_id } => folder_id,
    _ => {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::RequestInvalid.as_str().into(),
      ));
    }
  };
  if !projection
    .folders
    .iter()
    .any(|folder| folder.organizer_id == *folder_id)
  {
    return Ok((None, vec![WorkspaceContentBlocker::GitSyncOwnershipUnproven]));
  }
  let document_bindings = store
    .get_bindings_by_profile(profile_id)
    .await
    .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::InventoryInvalid.as_str().into()))?;
  let file_bindings = store
    .get_file_bindings_by_profile(profile_id)
    .await
    .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::InventoryInvalid.as_str().into()))?;
  let document_paths = document_bindings
    .iter()
    .filter(|binding| !binding.tombstone)
    .map(|binding| (binding.doc_id, binding.repo_path.clone()))
    .collect();
  let file_owners = file_bindings
    .iter()
    .filter(|binding| !binding.tombstoned)
    .map(|binding| (binding.repo_path.clone(), format!("file:{}", binding.id)))
    .collect();
  let mut capture_paths = document_bindings
    .iter()
    .filter(|binding| !binding.tombstone)
    .map(|binding| binding.repo_path.clone())
    .chain(
      file_bindings
        .iter()
        .filter(|binding| !binding.tombstoned)
        .map(|binding| binding.repo_path.clone()),
    )
    .collect::<Vec<_>>();
  let captured = if let Some(capture) = capture {
    capture.capture(actor_id, &profile, folder_id, &capture_paths).await?
  } else {
    None
  };
  let observed = captured.as_ref().map_or_else(
    || {
      document_bindings
        .iter()
        .map(|binding| binding.repo_path.clone())
        .chain(file_bindings.iter().map(|binding| binding.repo_path.clone()))
        .collect()
    },
    |capture| capture.observed_paths.clone(),
  );
  let planned = git_overview::plan_git_overview_paths(
    profile.workspace_id,
    &profile.root_path,
    &projection,
    &document_paths,
    &file_owners,
    &observed,
    captured.as_ref().map(|capture| &capture.manifest),
  );
  let Ok(planned) = planned else {
    return Ok((None, vec![WorkspaceContentBlocker::GitSyncScopeAmbiguous]));
  };
  let Some(overview) = planned.folders.get(folder_id) else {
    return Ok((None, vec![WorkspaceContentBlocker::GitSyncOwnershipUnproven]));
  };
  let Some((target_root, _)) = overview.as_str().rsplit_once('/') else {
    return Ok((None, vec![WorkspaceContentBlocker::GitSyncOwnershipUnproven]));
  };
  let target_root = target_root.to_string();
  let prefix = format!("{target_root}/");
  let source_root = profile.root_path.trim_end_matches('/');
  if target_root.is_empty() || (!source_root.is_empty() && !target_root.starts_with(&format!("{source_root}/"))) {
    blockers.push(WorkspaceContentBlocker::GitSyncScopeAmbiguous);
  }
  if scope.excludes(&target_root).unwrap_or(true)
    || projection
      .folders
      .iter()
      .filter(|folder| {
        planned
          .folders
          .get(&folder.organizer_id)
          .and_then(|path| path.as_str().rsplit_once('/').map(|(dir, _)| dir == target_root))
          .unwrap_or(false)
      })
      .count()
      != 1
  {
    blockers.push(WorkspaceContentBlocker::GitSyncScopeAmbiguous);
  }
  let selected_doc_ids = graph
    .resources
    .iter()
    .filter(|resource| resource.resource.kind() == WorkspaceContentResourceKind::Document)
    .filter_map(|resource| resource.permission_resource_id)
    .collect::<BTreeSet<_>>();
  let baselines = store
    .get_baselines_by_profile(profile_id)
    .await
    .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::InventoryInvalid.as_str().into()))?;
  let baseline_by_binding = baselines
    .into_iter()
    .map(|baseline| (baseline.binding_id, baseline.content_hash))
    .collect::<HashMap<_, _>>();
  let mut documents = Vec::new();
  for binding in document_bindings.iter().filter(|binding| !binding.tombstone) {
    let in_subtree = binding.repo_path.starts_with(&prefix);
    if in_subtree && scope.excludes(&binding.repo_path).unwrap_or(true) {
      blockers.push(WorkspaceContentBlocker::GitSyncScopeAmbiguous);
    }
    if selected_doc_ids.contains(&binding.doc_id) != in_subtree {
      blockers.push(WorkspaceContentBlocker::GitSyncScopeAmbiguous);
    }
    if in_subtree {
      documents.push(WorkspaceContentGitSyncDocument {
        binding_id: binding.id,
        doc_id: binding.doc_id,
        sync_id: binding.sync_id,
        repo_path: binding.repo_path.clone(),
        content_hash: binding.content_hash.clone(),
        baseline_hash: baseline_by_binding.get(&binding.id).cloned(),
      });
    }
  }
  let mut files = Vec::new();
  let mut shared_files = Vec::new();
  for binding in file_bindings
    .iter()
    .filter(|binding| !binding.tombstoned && !binding.repo_path.starts_with(&prefix))
  {
    let Some(mapping) = graph.mappings.iter().map(|entry| &entry.mapping).find(|mapping| {
      mapping.source.kind() == WorkspaceContentResourceKind::Blob && mapping.source.resource_id() == binding.blob_key
    }) else {
      continue;
    };
    let target_repo_path = git_export::asset_repo_path(&target_root, mapping.target.resource_id(), &binding.mime_type)
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::InventoryInvalid.as_str().into()))?
      .as_str()
      .to_owned();
    if observed.contains(&target_repo_path) {
      blockers.push(WorkspaceContentBlocker::GitSyncScopeAmbiguous);
    }
    shared_files.push(
      myoxus_application::workspace_content_operation::WorkspaceContentGitSyncSharedFile {
        source: WorkspaceContentGitSyncFile {
          binding_id: binding.id,
          blob_key: binding.blob_key.clone(),
          repo_path: binding.repo_path.clone(),
          content_hash: binding.content_hash.clone(),
        },
        target_blob_key: mapping.target.resource_id().into(),
        target_repo_path,
        mime_type: binding.mime_type.clone(),
        file_size: binding.file_size,
      },
    );
  }
  for binding in file_bindings
    .iter()
    .filter(|binding| !binding.tombstoned && binding.repo_path.starts_with(&prefix))
  {
    if scope.excludes(&binding.repo_path).unwrap_or(true) {
      blockers.push(WorkspaceContentBlocker::GitSyncScopeAmbiguous);
    }
    files.push(WorkspaceContentGitSyncFile {
      binding_id: binding.id,
      blob_key: binding.blob_key.clone(),
      repo_path: binding.repo_path.clone(),
      content_hash: binding.content_hash.clone(),
    });
  }
  let target_manifest = git_export::extracted_manifest_path(&target_root)
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::InventoryInvalid.as_str().into()))?;
  capture_paths.push(overview.as_str().to_string());
  if let Some(captured) = &captured {
    // The branch's complete physical inventory must have an owner, not just
    // the paths already recorded in SQL. An unbound authored sibling would
    // otherwise silently be transferred by a directory-level handoff.
    let unowned_path = captured
      .observed_paths
      .iter()
      .filter(|path| path.starts_with(&prefix))
      .filter(|path| !scope.excludes(path).unwrap_or(true))
      .any(|path| {
        !documents.iter().any(|binding| binding.repo_path == *path)
          && !files.iter().any(|binding| binding.repo_path == *path)
          && !captured.manifest.folders.iter().any(|folder| {
            folder.overview.as_ref().is_some_and(|output| {
              output.repo_path == *path && captured.path_hashes.get(path) == Some(&output.content_hash)
            })
          })
      });
    if captured
      .manifest
      .validate_overviews(profile.workspace_id, document_paths.values().map(String::as_str))
      .is_err()
      || captured
        .manifest
        .folders
        .iter()
        .find(|folder| folder.organizer_id == *folder_id)
        .and_then(|folder| folder.overview.as_ref())
        .is_none_or(|output| {
          output.repo_path != overview.as_str()
            || captured.path_hashes.get(&output.repo_path) != Some(&output.content_hash)
        })
      || captured
        .manifest
        .documents
        .iter()
        .filter(|document| document.repo_path.starts_with(&prefix))
        .any(|document| {
          captured.document_body_hashes.get(&document.repo_path) != Some(&document.content_hash)
            || !documents
              .iter()
              .any(|binding| binding.doc_id == document.doc_id && binding.repo_path == document.repo_path)
        })
      || documents.iter().any(|binding| {
        !captured
          .manifest
          .documents
          .iter()
          .any(|document| document.doc_id == binding.doc_id && document.repo_path == binding.repo_path)
      })
      || capture_paths
        .iter()
        .filter(|path| path.starts_with(&prefix))
        .any(|path| !captured.path_hashes.contains_key(path))
      || captured.observed_paths.contains(&target_manifest)
      || shared_files
        .iter()
        .any(|file| captured.path_hashes.get(&file.source.repo_path) != Some(&file.source.content_hash))
      || unowned_path
    {
      blockers.push(WorkspaceContentBlocker::GitSyncOwnershipUnproven);
    }
  } else {
    // A binding and its baseline identify known files but cannot exclude an
    // unbound sibling in the same physical subtree. Until a complete persisted
    // inventory is available, an offline branch cannot prove exclusivity.
    blockers.push(WorkspaceContentBlocker::GitSyncOwnershipUnproven);
  }
  let unresolved: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM git_sync_conflicts WHERE profile_id = $1 AND resolution = 'Open' AND left(repo_path, length($2)) = $2)
      OR EXISTS(SELECT 1 FROM git_sync_file_conflicts WHERE profile_id = $1 AND resolution = 'Open' AND left(repo_path, length($2)) = $2)",
  ).bind(profile_id).bind(&prefix)
    .fetch_one(pool).await.map_err(PgWorkspaceContentOperationRepository::storage)?;
  if unresolved && choice == WorkspaceContentGitSyncChoice::Move {
    blockers.push(WorkspaceContentBlocker::GitSyncConflicts);
  }
  blockers.sort();
  blockers.dedup();
  Ok((
    Some(WorkspaceContentGitSyncPlan {
      undo: None,
      target_configuration: Some(
        myoxus_application::workspace_content_operation::extract_git_profile_configuration(&profile),
      ),
      choice,
      source_profile_id: profile.id,
      source_profile_owner_id: profile.owner_id,
      source_profile_updated_at: profile.updated_at,
      source_scope_revision: profile.scope_revision,
      direction: profile.sync_direction,
      trigger: profile.trigger_mode,
      intended_enabled: profile.enabled,
      repository: profile.repo_url,
      branch: profile.branch,
      source_root: profile.root_path,
      source_manifest: profile.manifest_path,
      target_root,
      target_manifest,
      remote_oid: captured.as_ref().map(|capture| capture.head_oid.clone()),
      manifest_inventory: captured
        .as_ref()
        .map(|capture| serde_json::to_value(&capture.manifest))
        .transpose()
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::EncodingFailed.as_str().into()))?,
      observed_hashes: captured.map(|capture| capture.path_hashes).unwrap_or_default(),
      documents,
      files,
      shared_files,
      delegated_descendants: scope
        .exclusions()
        .iter()
        .filter(|fence| fence.repo_path.as_str().starts_with(&prefix))
        .map(|fence| WorkspaceContentGitSyncDelegation {
          repo_path: fence.repo_path.as_str().to_owned(),
          is_directory: fence.is_directory,
          destination_profile_id: fence.destination_profile_id,
          originating_operation_id: fence.originating_operation_id,
          scope_revision: fence.scope_revision,
        })
        .collect(),
    }),
    blockers,
  ))
}

#[async_trait]
impl WorkspaceContentRedirectRepository for PgWorkspaceContentRedirectRepository {
  async fn resolve_redirect(
    &self,
    source: &WorkspaceContentResourceRef,
  ) -> AuthResult<Option<WorkspaceContentResourceRef>> {
    sqlx::query(
      "SELECT target_workspace_id, target_kind, target_id
         FROM workspace_content_operation_redirects
        WHERE source_workspace_id = $1 AND source_kind = $2 AND source_id = $3",
    )
    .bind(source.workspace_id())
    .bind(source.kind().as_str())
    .bind(source.resource_id())
    .fetch_optional(&self.pool)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .map(|row| {
      make_resource(
        row.get("target_workspace_id"),
        row.get("target_kind"),
        row.get("target_id"),
      )
    })
    .transpose()
  }

  async fn canonical_reference(
    &self,
    resource: &WorkspaceContentResourceRef,
  ) -> AuthResult<Option<WorkspaceContentResourceRef>> {
    let mut tx = self
      .pool
      .begin()
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    let target = resolve_resource_reference_in_tx(&mut tx, resource).await?;
    tx.commit()
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    Ok(target)
  }

  async fn resource_exists(&self, resource: &WorkspaceContentResourceRef) -> AuthResult<bool> {
    match resource.kind() {
      WorkspaceContentResourceKind::Document => sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM docs
          WHERE workspace_id = $1 AND external_id = $2 AND deleted_at IS NULL)",
      )
      .bind(resource.workspace_id())
      .bind(resource.resource_id())
      .fetch_one(&self.pool)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage),
      WorkspaceContentResourceKind::Database => {
        let id = Uuid::parse_str(resource.resource_id())
          .map_err(|_| AuthError::NotFound(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))?;
        sqlx::query_scalar(
          "SELECT EXISTS(SELECT 1 FROM workspace_databases
            WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL)",
        )
        .bind(resource.workspace_id())
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)
      }
      WorkspaceContentResourceKind::Tag => {
        let id = Uuid::parse_str(resource.resource_id())
          .map_err(|_| AuthError::NotFound(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))?;
        sqlx::query_scalar(
          "SELECT EXISTS(SELECT 1 FROM workspace_tags
            WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL)",
        )
        .bind(resource.workspace_id())
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)
      }
      WorkspaceContentResourceKind::Blob => {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM blobs WHERE workspace_id = $1 AND key = $2)")
          .bind(resource.workspace_id())
          .bind(resource.resource_id())
          .fetch_one(&self.pool)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)
      }
      WorkspaceContentResourceKind::Collection => {
        let root = self
          .doc
          .load_full_doc_consistent(resource.workspace_id(), resource.workspace_id())
          .await?;
        let catalog = yjs::extract_workspace_collections(&root)
          .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::CollectionDecode.as_str().into()))?;
        Ok(
          catalog
            .iter()
            .any(|value| value.get("id").and_then(serde_json::Value::as_str) == Some(resource.resource_id())),
        )
      }
      WorkspaceContentResourceKind::Folder => {
        let snapshot = self
          .organizer
          .snapshot(resource.workspace_id())
          .await
          .map_err(myoxus_application::workspace_content_operation::organizer_failure)?;
        Ok(organizer_contains(&snapshot.roots, resource))
      }
    }
  }
}

/// Transaction-local form of the existing qualified redirect resolver. A live
/// route outranks a redirect; no UUID-shaped global identity lookup is allowed.
pub(crate) async fn resolve_document_reference_in_tx(
  tx: &mut Transaction<'_, Postgres>,
  source: &WorkspaceContentResourceRef,
) -> AuthResult<Option<WorkspaceContentResourceRef>> {
  if source.kind() != WorkspaceContentResourceKind::Document {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into(),
    ));
  }
  resolve_resource_reference_in_tx(tx, source).await
}

/// Content-free canonical proof for contained Organizer/native references.
/// It preserves live-route precedence and rejects unknown redirect chains.
async fn resolve_resource_reference_in_tx(
  tx: &mut Transaction<'_, Postgres>,
  source: &WorkspaceContentResourceRef,
) -> AuthResult<Option<WorkspaceContentResourceRef>> {
  let mut current = source.clone();
  let mut seen = BTreeSet::new();
  for _ in 0..myoxus_application::workspace_content_operation::redirect::MAX_REDIRECT_CHAIN_LENGTH {
    if !seen.insert(current.clone()) {
      break;
    }
    let live: bool = match current.kind() {
      WorkspaceContentResourceKind::Document => {
        if myoxus_domain::document_key::DocumentKey::parse(current.resource_id()).is_err() {
          return Ok(None);
        }
        sqlx::query_scalar(
          "SELECT EXISTS(SELECT 1 FROM docs WHERE workspace_id=$1 AND external_id=$2 AND deleted_at IS NULL)",
        )
        .bind(current.workspace_id())
        .bind(current.resource_id())
        .fetch_one(&mut **tx)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?
      }
      WorkspaceContentResourceKind::Database | WorkspaceContentResourceKind::Tag => {
        let Ok(id) = Uuid::parse_str(current.resource_id()) else {
          return Ok(None);
        };
        // Archived Tags are valid historical classifications, not broken links.
        let query = if current.kind() == WorkspaceContentResourceKind::Database {
          "SELECT EXISTS(SELECT 1 FROM workspace_databases WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL)"
        } else {
          "SELECT EXISTS(SELECT 1 FROM workspace_tags WHERE workspace_id=$1 AND id=$2)"
        };
        sqlx::query_scalar(query)
          .bind(current.workspace_id())
          .bind(id)
          .fetch_one(&mut **tx)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?
      }
      WorkspaceContentResourceKind::Collection => {
        let workspace_exists: bool =
          sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=$1 AND deleted_at IS NULL)")
            .bind(current.workspace_id())
            .fetch_one(&mut **tx)
            .await
            .map_err(PgWorkspaceContentOperationRepository::storage)?;
        if !workspace_exists {
          return Ok(None);
        }
        let (root, _) =
          crate::doc::SqlxDocStore::load_reference_snapshot_in_tx(tx, current.workspace_id(), current.workspace_id())
            .await?;
        yjs::extract_workspace_collections(&root)
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::CollectionDecode.as_str().into()))?
          .iter()
          .any(|value| value.get("id").and_then(serde_json::Value::as_str) == Some(current.resource_id()))
      }
      _ => {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into(),
        ));
      }
    };
    if live {
      return Ok(Some(current));
    }
    let redirect = sqlx::query("SELECT target_workspace_id,target_kind,target_id FROM workspace_content_operation_redirects WHERE source_workspace_id=$1 AND source_kind=$3 AND source_id=$2")
      .bind(current.workspace_id()).bind(current.resource_id()).bind(current.kind().as_str()).fetch_optional(&mut **tx).await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    let Some(redirect) = redirect else {
      return Ok(None);
    };
    current = make_resource(
      redirect.get("target_workspace_id"),
      redirect.get("target_kind"),
      redirect.get("target_id"),
    )?;
    if current.kind() != source.kind() {
      break;
    }
  }
  // A cycle/unsupported chain is unknown existence, not proof of absence.
  Err(AuthError::Storage(
    WorkspaceContentErrorCode::InventoryInvalid.as_str().into(),
  ))
}

fn organizer_contains(nodes: &[OrganizerSnapshotNode], resource: &WorkspaceContentResourceRef) -> bool {
  nodes.iter().any(|node| {
    let matches = match resource.kind() {
      WorkspaceContentResourceKind::Folder => node.row.is_folder() && node.row.id == resource.resource_id(),
      _ => false,
    };
    matches || organizer_contains(&node.children, resource)
  })
}

impl PgWorkspaceContentAuthorizationSource {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }
}

const MAX_GRAPH_INVENTORY_RESOURCES: usize = 4_096;

#[async_trait]
impl WorkspaceContentGraphSourcePort for PgWorkspaceContentGraphSource {
  async fn prepare_with_origin(
    &self,
    actor_id: UserId,
    operation_id: Uuid,
    request: &WorkspaceContentOperationRequest,
    mapping_overrides: Vec<WorkspaceContentIdMapping>,
    origin_operation_id: Option<Uuid>,
  ) -> AuthResult<WorkspaceContentPreparedGraph> {
    let mut prepared = self.prepare(actor_id, operation_id, request, mapping_overrides).await?;
    if let Some(origin) = origin_operation_id {
      prepared.authorization_options.git_sync_plan = git_undo::prepare(
        &self.pool,
        self.git_capture.as_deref(),
        actor_id,
        origin,
        request,
        &prepared.input,
      )
      .await?;
    }
    Ok(prepared)
  }
  #[instrument(skip(self, request, mapping_overrides), fields(source_workspace_id = %request.source_workspace_id, target_workspace_id = %request.target_workspace_id))]
  async fn prepare(
    &self,
    actor_id: UserId,
    operation_id: Uuid,
    request: &WorkspaceContentOperationRequest,
    mapping_overrides: Vec<WorkspaceContentIdMapping>,
  ) -> AuthResult<WorkspaceContentPreparedGraph> {
    if matches!(&request.selection, WorkspaceContentOperationSelection::Resources { resources }
      if resources.iter().any(|resource| resource.kind() == WorkspaceContentResourceKind::Collection))
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str().into(),
      ));
    }
    myoxus_application::workspace_content_operation::reject_collection_mappings(&mapping_overrides)?;
    let boundaries = sqlx::query(
      "SELECT id, owner_principal_type::text AS owner_principal_type,
              owner_principal_id, overview_settings, overview_revision
         FROM workspaces
        WHERE id = ANY($1) AND lifecycle_state = 'active' AND deleted_at IS NULL",
    )
    .bind([request.source_workspace_id, request.target_workspace_id])
    .fetch_all(&self.pool)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
    let extract = request.kind == WorkspaceContentOperationKind::ExtractFolder;
    let expected = if extract { 1 } else { 2 };
    if boundaries.len() != expected
      || !boundaries
        .iter()
        .any(|row| row.get::<Uuid, _>("id") == request.source_workspace_id)
      || (!extract
        && !boundaries
          .iter()
          .any(|row| row.get::<Uuid, _>("id") == request.target_workspace_id))
    {
      return Err(AuthError::NotFound(
        WorkspaceContentErrorCode::SourceWorkspaceMissing.as_str().to_string(),
      ));
    }
    let source_row = boundaries
      .iter()
      .find(|row| row.get::<Uuid, _>("id") == request.source_workspace_id)
      .expect("source boundary checked");
    if request.kind == WorkspaceContentOperationKind::Link {
      let WorkspaceContentOperationSelection::Resources { resources } = &request.selection else {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::RequestInvalid.as_str().into(),
        ));
      };
      let [selected] = resources.as_slice() else {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::RequestInvalid.as_str().into(),
        ));
      };
      let missing = match selected.kind() {
        WorkspaceContentResourceKind::Document => WorkspaceContentErrorCode::SourceDocumentMissing,
        WorkspaceContentResourceKind::Database => WorkspaceContentErrorCode::SourceDatabaseMissing,
        WorkspaceContentResourceKind::Tag => WorkspaceContentErrorCode::SourceTagMissing,
        _ => {
          return Err(AuthError::InvalidInput(
            WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str().into(),
          ));
        }
      };
      if selected.workspace_id() != request.source_workspace_id {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into(),
        ));
      }
      // Link owns only placement. Never expand a Database's rows or read document payloads/catalogs.
      let resource = load_graph_resource(&self.pool, selected, None)
        .await?
        .ok_or_else(|| AuthError::NotFound(missing.as_str().into()))?;
      let organizer = self
        .organizer
        .snapshot(request.target_workspace_id)
        .await
        .map_err(myoxus_application::workspace_content_operation::organizer_failure)?;
      return Ok(WorkspaceContentPreparedGraph {
        input: WorkspaceContentGraphInput {
          operation_id,
          kind: request.kind,
          source_workspace_id: request.source_workspace_id,
          target_workspace_id: request.target_workspace_id,
          selection: WorkspaceContentSelection::Resources(resources.clone()),
          resources: vec![resource],
          references: Vec::new(),
          target_definitions: Vec::new(),
          target_resource_ids: Vec::new(),
          mapping_overrides,
        },
        authorization_options: Default::default(),
        target_organizer_revision: Some(organizer.content_revision()),
      });
    }

    let selection_uses_organizer = match &request.selection {
      WorkspaceContentOperationSelection::FolderSubtree { .. } => true,
      WorkspaceContentOperationSelection::Resources { resources } => resources
        .iter()
        .any(|resource| matches!(resource.kind(), WorkspaceContentResourceKind::Folder)),
    };
    let source_organizer = if selection_uses_organizer {
      {
        Some(
          self
            .organizer
            .snapshot(request.source_workspace_id)
            .await
            .map_err(myoxus_application::workspace_content_operation::organizer_failure)?,
        )
      }
    } else {
      None
    };
    let selection = match (&request.selection, source_organizer.as_ref()) {
      (WorkspaceContentOperationSelection::Resources { resources }, _) => {
        WorkspaceContentSelection::Resources(resources.clone())
      }
      (WorkspaceContentOperationSelection::FolderSubtree { folder_id }, Some(snapshot)) => {
        WorkspaceContentSelection::FolderSubtree {
          organizer: snapshot.clone(),
          folder_id: folder_id.clone(),
        }
      }
      _ => {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::RequestInvalid.as_str().to_string(),
        ));
      }
    };
    let mut selected = match &request.selection {
      WorkspaceContentOperationSelection::Resources { resources } => resources.clone(),
      WorkspaceContentOperationSelection::FolderSubtree { .. } => {
        let mut resources = Vec::new();
        collect_organizer_resources(
          source_organizer.as_ref().expect("folder selection has organizer"),
          request.source_workspace_id,
          &mut resources,
        )?;
        resources
      }
    };
    selected.sort();
    selected.dedup();
    if selected.len() > MAX_GRAPH_INVENTORY_RESOURCES {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::InventoryLimit.as_str().to_string(),
      ));
    }
    let organizer_references = source_organizer
      .as_ref()
      .map(|snapshot| organizer_graph_references(snapshot, request.source_workspace_id))
      .transpose()?
      .unwrap_or_default();
    let (resources, references) = load_graph_closure(
      &self.pool,
      &self.doc,
      request.source_workspace_id,
      selected,
      match &request.selection {
        WorkspaceContentOperationSelection::Resources { resources } => resources.iter().cloned().collect(),
        WorkspaceContentOperationSelection::FolderSubtree { .. } => BTreeSet::new(),
      },
      source_organizer.as_ref(),
      organizer_references,
      true,
      request.kind != WorkspaceContentOperationKind::Copy,
    )
    .await?;
    if let WorkspaceContentOperationSelection::Resources { resources: roots } = &request.selection {
      for root in roots {
        if !resources.iter().any(|resource| &resource.resource == root) {
          let cause = match root.kind() {
            WorkspaceContentResourceKind::Document => WorkspaceContentErrorCode::SourceDocumentMissing,
            WorkspaceContentResourceKind::Database => WorkspaceContentErrorCode::SourceDatabaseMissing,
            WorkspaceContentResourceKind::Tag => WorkspaceContentErrorCode::SourceTagMissing,
            WorkspaceContentResourceKind::Blob => WorkspaceContentErrorCode::SourceBlobMissing,
            WorkspaceContentResourceKind::Folder => WorkspaceContentErrorCode::SourceRootMissing,
            WorkspaceContentResourceKind::Collection => WorkspaceContentErrorCode::SelectedResourceUnsupported,
          };
          return Err(AuthError::NotFound(cause.as_str().into()));
        }
      }
    }
    if request.kind == WorkspaceContentOperationKind::Copy {
      let selected_databases = resources
        .iter()
        .filter(|resource| resource.resource.kind() == WorkspaceContentResourceKind::Database)
        .map(|resource| resource.resource.resource_id().to_string())
        .collect::<BTreeSet<_>>();
      let configs = sqlx::query_scalar::<_, serde_json::Value>(
        "SELECT config_json FROM workspace_database_fields WHERE database_id::text=ANY($1) AND field_type='relation'",
      )
      .bind(selected_databases.iter().cloned().collect::<Vec<_>>())
      .fetch_all(&self.pool)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
      for config in configs {
        let config: myoxus_domain::database::DatabaseRelationFieldConfig = serde_json::from_value(config)
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
        if !selected_databases.contains(&config.target_database_id.to_string()) {
          return Err(AuthError::InvalidInput(
            WorkspaceContentErrorCode::RelationTargetOutsideSelection
              .as_str()
              .into(),
          ));
        }
      }
    }
    let graph_resource_refs = resources
      .iter()
      .map(|resource| resource.resource.clone())
      .collect::<Vec<_>>();
    let target_uses_organizer = graph_resource_refs
      .iter()
      .any(|resource| matches!(resource.kind(), WorkspaceContentResourceKind::Folder));
    let target_organizer = if !extract && target_uses_organizer {
      Some(
        self
          .organizer
          .snapshot(request.target_workspace_id)
          .await
          .map_err(myoxus_application::workspace_content_operation::organizer_failure)?,
      )
    } else {
      None
    };
    let (target_definitions, target_resource_ids) = if extract {
      (Vec::new(), Vec::new())
    } else {
      load_target_inventory(
        &self.pool,
        request.target_workspace_id,
        &graph_resource_refs,
        target_organizer.as_ref(),
        true,
      )
      .await?
    };
    let overview = if target_uses_organizer {
      Some(
        myoxus_application::workspace_content_operation::overview::WorkspaceContentOverviewSnapshot {
          source: workspace_overview_state(source_row, request.source_workspace_id)?,
          target: boundaries
            .iter()
            .find(|row| row.get::<Uuid, _>("id") == request.target_workspace_id)
            .map(|row| workspace_overview_state(row, request.target_workspace_id))
            .transpose()?,
          extracted_folder_id: match &request.selection {
            WorkspaceContentOperationSelection::FolderSubtree { folder_id } => Some(folder_id.clone()),
            _ => None,
          },
        },
      )
    } else {
      None
    };
    let target_organizer_revision = None;
    let principal_type = OwnerPrincipalType::parse(&source_row.get::<String, _>("owner_principal_type"))
      .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::InventoryInvalid.as_str().to_string()))?;
    let principal_id = source_row
      .get::<Option<Uuid>, _>("owner_principal_id")
      .unwrap_or(request.source_workspace_id);
    let input = WorkspaceContentGraphInput {
      operation_id,
      kind: request.kind,
      source_workspace_id: request.source_workspace_id,
      target_workspace_id: request.target_workspace_id,
      selection,
      resources,
      references,
      target_definitions,
      target_resource_ids,
      mapping_overrides,
    };
    let selected_graph = if extract {
      Some(
        WorkspaceContentGraphBuilder
          .build(input.clone())
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::InventoryInvalid.as_str().into()))?,
      )
    } else {
      None
    };
    let (git_sync_plan, git_sync_blockers) = if extract {
      extract_git_scope_plan(
        &self.pool,
        actor_id,
        request,
        source_organizer
          .as_ref()
          .expect("Extract requires a folder Organizer capture"),
        selected_graph.as_ref().expect("Extract selection is derived"),
        self.git_capture.as_deref(),
      )
      .await?
    } else {
      (None, Vec::new())
    };
    Ok(WorkspaceContentPreparedGraph {
      input,
      authorization_options:
        myoxus_application::workspace_content_operation::authorization::WorkspaceContentAuthorizationOptions {
          overview,
          copy_document_acl: request.copy_document_acl,
          extract_target_principal: extract.then_some(WorkspaceContentOwnerPrincipal {
            principal_type,
            principal_id,
          }),
          git_sync_plan,
          git_sync_blockers,
        },
      target_organizer_revision,
    })
  }
}

/// Load the selected inventory and its transferable ownership closure. The
/// broad relation snapshot is bounded once; only owned edges expand the queue.
async fn load_graph_closure(
  pool: &PgPool,
  doc: &myoxus_application::doc::DocService,
  workspace_id: Uuid,
  selected: Vec<WorkspaceContentResourceRef>,
  directly_selected: BTreeSet<WorkspaceContentResourceRef>,
  organizer: Option<&OrganizerSnapshot>,
  organizer_references: Vec<WorkspaceContentGraphReference>,
  portable_tags: bool,
  retained_history: bool,
) -> AuthResult<(Vec<WorkspaceContentGraphResource>, Vec<WorkspaceContentGraphReference>)> {
  let organizer_reference_count = organizer_references.len();
  let mut references = organizer_references;
  references.extend(load_relational_graph_references(pool, workspace_id, portable_tags).await?);
  let mut resources = BTreeMap::new();
  let mut queue = VecDeque::from(selected);
  while let Some(resource) = queue.pop_front() {
    if resources.contains_key(&resource) {
      continue;
    }
    if resources.len() >= MAX_GRAPH_INVENTORY_RESOURCES {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::InventoryLimit.as_str().to_string(),
      ));
    }
    let malformed_contained = !directly_selected.contains(&resource)
      && matches!(
        resource.kind(),
        WorkspaceContentResourceKind::Database | WorkspaceContentResourceKind::Tag
      )
      && Uuid::parse_str(resource.resource_id()).is_err();
    let snapshot = if malformed_contained {
      None
    } else {
      load_graph_resource(pool, &resource, organizer).await?
    };
    let Some(snapshot) = snapshot else {
      if portable_tags
        && resource.kind() == WorkspaceContentResourceKind::Tag
        && (directly_selected.contains(&resource)
          || references[organizer_reference_count..].iter().any(|reference| {
            reference.target == resource && reference.purpose == WorkspaceContentReferencePurpose::OwnedDependency
          }))
      {
        return Err(AuthError::NotFound(
          WorkspaceContentErrorCode::SourceTagMissing.as_str().into(),
        ));
      }
      // Organizer rows describe intended ownership, but the authoritative
      // resource stores decide whether their targets still exist. Keep
      // relational inconsistencies fail-closed; only Organizer-owned edges
      // can be reconciled from an authoritative absence here.
      let canonical = if !malformed_contained
        && matches!(
          resource.kind(),
          WorkspaceContentResourceKind::Document
            | WorkspaceContentResourceKind::Database
            | WorkspaceContentResourceKind::Tag
        ) {
        PgWorkspaceContentRedirectRepository::new(pool.clone(), doc.clone())
          .canonical_reference(&resource)
          .await?
      } else {
        None
      };
      for reference in references[..organizer_reference_count]
        .iter_mut()
        .filter(|reference| reference.target == resource)
      {
        reference.target_exists = canonical.is_some();
        if let Some(target) = &canonical {
          if target.workspace_id() == workspace_id {
            // Undo may return the same identity under a new local route.
            // Its contained placement still owns that live local document.
            reference.target = target.clone();
            queue.push_back(target.clone());
          } else {
            // A foreign moved target is lateral, never adopted as ownership.
            reference.purpose = WorkspaceContentReferencePurpose::Reference;
          }
        }
      }
      continue;
    };
    if resource.kind() == WorkspaceContentResourceKind::Document {
      references.extend(load_document_value_references(pool, doc, &snapshot, retained_history).await?);
    }
    if portable_tags && resource.kind() == WorkspaceContentResourceKind::Database {
      references.extend(load_database_tag_references(pool, &resource).await?);
    }
    resources.insert(resource.clone(), snapshot);
    for reference in references.iter().filter(|reference| {
      reference.source == resource
        && reference.purpose == WorkspaceContentReferencePurpose::OwnedDependency
        && reference.target_exists
    }) {
      queue.push_back(reference.target.clone());
    }
  }
  references.sort();
  references.dedup();
  Ok((resources.into_values().collect(), references))
}

/// Read Tags through their actual field kinds, including template values and
/// both saved filter forms. Collection rules never enter this inventory.
async fn load_database_tag_references(
  pool: &PgPool,
  resource: &WorkspaceContentResourceRef,
) -> AuthResult<Vec<WorkspaceContentGraphReference>> {
  use myoxus_domain::database::{DatabaseCellValueData, DatabaseFieldType, DatabaseViewConfig};
  let database_id = Uuid::parse_str(resource.resource_id())
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().into()))?;
  let rows = sqlx::query(
    "SELECT cell.value_json AS value, field.field_type FROM workspace_database_cell_values cell
       JOIN workspace_database_fields field ON field.id = cell.field_id AND field.field_type IN ('tags', 'files')
       JOIN workspace_database_rows row_data ON row_data.id = cell.row_id AND row_data.deleted_at IS NULL
      WHERE cell.database_id = $1 AND cell.value_json IS NOT NULL
     UNION ALL
     SELECT template.initial_cell_values_json -> field.id::text, field.field_type
       FROM workspace_database_row_templates template
       JOIN workspace_database_fields field ON field.database_id = template.database_id AND field.field_type IN ('tags', 'files')
      WHERE template.database_id = $1 AND template.initial_cell_values_json ? field.id::text
      LIMIT 4097",
  )
  .bind(database_id)
  .fetch_all(pool)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if rows.len() > MAX_GRAPH_INVENTORY_RESOURCES {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::InventoryLimit.as_str().into(),
    ));
  }
  let mut ids = BTreeSet::new();
  let mut asset_ids = BTreeSet::new();
  for row in rows {
    let value: serde_json::Value = row.get("value");
    if value.is_null() {
      continue;
    }
    let field_type = match row.get::<String, _>("field_type").as_str() {
      "tags" => DatabaseFieldType::Tags,
      "files" => DatabaseFieldType::Files,
      _ => unreachable!("typed SQL inventory"),
    };
    let value = crate::workspace_database::PgDatabaseRepository::map_cell_value_from_json(field_type, value)
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
    match value {
      DatabaseCellValueData::Tags(tags) => ids.extend(tags),
      DatabaseCellValueData::Files(files) => asset_ids.extend(files.files.into_iter().map(|file| file.blob_key)),
      _ => {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into(),
        ));
      }
    }
  }
  let tag_fields = sqlx::query_scalar::<_, Uuid>(
    "SELECT id FROM workspace_database_fields WHERE database_id = $1 AND field_type = 'tags' LIMIT 4097",
  )
  .bind(database_id)
  .fetch_all(pool)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?
  .into_iter()
  .collect::<std::collections::HashSet<_>>();
  let views = sqlx::query_scalar::<_, serde_json::Value>(
    "SELECT config_json FROM workspace_database_views WHERE database_id = $1 LIMIT 4097",
  )
  .bind(database_id)
  .fetch_all(pool)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if tag_fields.len() > MAX_GRAPH_INVENTORY_RESOURCES || views.len() > MAX_GRAPH_INVENTORY_RESOURCES {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::InventoryLimit.as_str().into(),
    ));
  }
  for view in views {
    let view: DatabaseViewConfig = serde_json::from_value(view)
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
    ids.extend(
      myoxus_domain::database::workspace_content_view_tag_ids(&view, &tag_fields)
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().into()))?,
    );
  }
  if ids.len() > MAX_GRAPH_INVENTORY_RESOURCES {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::InventoryLimit.as_str().into(),
    ));
  }
  let mut references = ids
    .into_iter()
    .map(|id| {
      Ok(WorkspaceContentGraphReference {
        relation: "workspace_database_cell_values".into(),
        source: resource.clone(),
        target: WorkspaceContentResourceRef::new(
          resource.workspace_id(),
          WorkspaceContentResourceKind::Tag,
          id.to_string(),
        )
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().into()))?,
        purpose: WorkspaceContentReferencePurpose::OwnedDependency,
        target_exists: true,
      })
    })
    .collect::<AuthResult<Vec<_>>>()?;
  for key in asset_ids {
    let exists: bool =
      sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM blobs WHERE workspace_id=$1 AND key=$2 AND deleted_at IS NULL)")
        .bind(resource.workspace_id())
        .bind(&key)
        .fetch_one(pool)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?;
    if !exists {
      return Err(AuthError::NotFound(
        WorkspaceContentErrorCode::SourceBlobMissing.as_str().into(),
      ));
    }
    references.push(WorkspaceContentGraphReference {
      relation: "blobs".into(),
      source: resource.clone(),
      target: WorkspaceContentResourceRef::new(resource.workspace_id(), WorkspaceContentResourceKind::Blob, key)
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::InventoryInvalid.as_str().into()))?,
      purpose: WorkspaceContentReferencePurpose::OwnedDependency,
      target_exists: true,
    });
  }
  Ok(references)
}

fn organizer_graph_references(
  snapshot: &OrganizerSnapshot,
  workspace_id: Uuid,
) -> AuthResult<Vec<WorkspaceContentGraphReference>> {
  fn row_resource(node: &OrganizerSnapshotNode, workspace_id: Uuid) -> AuthResult<Option<WorkspaceContentResourceRef>> {
    if node.row.is_folder() {
      return WorkspaceContentResourceRef::new(workspace_id, WorkspaceContentResourceKind::Folder, node.row.id.clone())
        .map(Some)
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()));
    }
    if node.row.effective_target_workspace_id(workspace_id) != workspace_id {
      return Ok(None);
    }
    let kind = match node
      .row
      .link_type()
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))?
    {
      myoxus_application::organizer::OrganizerLinkType::Doc => WorkspaceContentResourceKind::Document,
      myoxus_application::organizer::OrganizerLinkType::Database => WorkspaceContentResourceKind::Database,
      myoxus_application::organizer::OrganizerLinkType::Collection => return Ok(None),
      myoxus_application::organizer::OrganizerLinkType::Tag => WorkspaceContentResourceKind::Tag,
      myoxus_application::organizer::OrganizerLinkType::Workspace => return Ok(None),
    };
    Ok(WorkspaceContentResourceRef::new(workspace_id, kind, node.row.data.clone()).ok())
  }

  fn collect(
    node: &OrganizerSnapshotNode,
    workspace_id: Uuid,
    references: &mut Vec<WorkspaceContentGraphReference>,
  ) -> AuthResult<()> {
    let source = row_resource(node, workspace_id)?;
    for child in &node.children {
      if let (Some(source), Some(target)) = (source.as_ref(), row_resource(child, workspace_id)?) {
        references.push(WorkspaceContentGraphReference {
          relation: "doc_updates".to_string(),
          source: source.clone(),
          target,
          purpose: WorkspaceContentReferencePurpose::OwnedDependency,
          target_exists: true,
        });
      }
      collect(child, workspace_id, references)?;
    }
    Ok(())
  }

  let mut references = Vec::new();
  for root in &snapshot.roots {
    collect(root, workspace_id, &mut references)?;
  }
  Ok(references)
}

async fn load_relational_graph_references(
  pool: &PgPool,
  workspace_id: Uuid,
  portable_tags: bool,
) -> AuthResult<Vec<WorkspaceContentGraphReference>> {
  // Task sources retain internal Doc UUIDs; only a matching canonical source
  // association may project an editor key. Other reference kinds keep their contract.
  let rows = sqlx::query(
    "SELECT 'workspace_database_rows' AS relation, 'database' AS source_kind,
            database.id::text AS source_id, 'document' AS target_kind,
            document.external_id AS target_id, true AS target_exists, true AS owned, database.workspace_id AS target_workspace_id
       FROM workspace_database_rows row_data
       JOIN workspace_databases database ON database.id = row_data.database_id
       JOIN docs document ON document.id = row_data.doc_id
      WHERE database.workspace_id = $1 AND database.deleted_at IS NULL
        AND document.deleted_at IS NULL
     UNION ALL
     SELECT 'workspace_database_rows', 'database', database.id::text, 'document',
            document.external_id, true, true, database.workspace_id
       FROM workspace_database_row_templates template
       JOIN workspace_databases database ON database.id=template.database_id
       LEFT JOIN workspace_template_instances instance ON instance.workspace_id=database.workspace_id
         AND instance.template_id=template.template_id
       JOIN docs document ON document.id=COALESCE(template.content_document_id, instance.workspace_doc_id)
      WHERE database.workspace_id=$1 AND database.deleted_at IS NULL AND document.deleted_at IS NULL
     UNION ALL
     SELECT 'workspace_tag_document_assignments', 'document', document.external_id,
            'tag', assignment.tag_id::text, true, true, assignment.workspace_id
       FROM workspace_tag_document_assignments assignment
       JOIN docs document ON document.id = assignment.doc_id
       JOIN workspace_tags tag ON tag.workspace_id = assignment.workspace_id
                              AND tag.id = assignment.tag_id
      WHERE assignment.workspace_id = $1 AND document.deleted_at IS NULL
        AND ($2 OR tag.archived_at IS NULL)
     UNION ALL
     SELECT 'database_document_references', 'database', reference.database_id::text,
            'document', CASE WHEN reference.reference_kind = 'task_source'
              THEN COALESCE(target_document.external_id, reference.raw_target_doc_id)
              ELSE reference.raw_target_doc_id END,
            target_document.id IS NOT NULL, false, reference.target_workspace_id
       FROM database_document_references reference
       JOIN workspace_databases database ON database.id = reference.database_id
       LEFT JOIN docs target_document ON target_document.workspace_id = reference.target_workspace_id
         AND target_document.deleted_at IS NULL
         AND (
           (reference.reference_kind <> 'task_source' AND target_document.external_id = reference.raw_target_doc_id)
           OR (reference.reference_kind = 'task_source' AND target_document.blocked = false
             AND target_document.id = reference.resolved_target_doc_id
             AND EXISTS (
               SELECT 1 FROM database_row_source_links source_link
               JOIN workspace_database_rows source_row ON source_row.id = source_link.row_id
                 AND source_row.database_id = database.id
               WHERE source_link.row_id = reference.row_id
                 AND source_link.source_workspace_id = database.workspace_id
                 AND source_link.source_workspace_id = reference.target_workspace_id
                 AND source_link.source_document_id = target_document.id
                 AND source_link.source_external_id = target_document.external_id
             ))
         )
      WHERE reference.workspace_id = $1 AND database.deleted_at IS NULL
        AND (reference.reference_kind <> 'task_source' OR (
          database.workspace_id = $1 AND EXISTS (
            SELECT 1 FROM workspace_database_rows current_row
            WHERE current_row.id = reference.row_id AND current_row.database_id = database.id
          )
        ))
        AND reference.target_workspace_id IS NOT NULL
      LIMIT 4097",
  )
  .bind(workspace_id)
  .bind(portable_tags)
  .fetch_all(pool)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if rows.len() > MAX_GRAPH_INVENTORY_RESOURCES {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::InventoryLimit.as_str().to_string(),
    ));
  }
  rows
    .into_iter()
    .map(|row| {
      Ok(WorkspaceContentGraphReference {
        relation: row.get("relation"),
        source: make_resource(workspace_id, row.get("source_kind"), row.get("source_id"))?,
        target: make_resource(
          row.get("target_workspace_id"),
          row.get("target_kind"),
          row.get("target_id"),
        )?,
        purpose: if row.get::<bool, _>("owned") {
          WorkspaceContentReferencePurpose::OwnedDependency
        } else {
          WorkspaceContentReferencePurpose::Reference
        },
        target_exists: row.get("target_exists"),
      })
    })
    .collect()
}

async fn load_document_value_references(
  pool: &PgPool,
  doc: &myoxus_application::doc::DocService,
  resource: &WorkspaceContentGraphResource,
  retained_history: bool,
) -> AuthResult<Vec<WorkspaceContentGraphReference>> {
  let doc_id = resource
    .permission_resource_id
    .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))?;
  let update = doc
    .load_full_doc_consistent(resource.resource.workspace_id(), doc_id)
    .await?;
  let documents = yjs::extract_document_references_from_yjs(&update)
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::InventoryInvalid.as_str().into()))?;
  let assets = yjs::extract_portable_asset_references(&update)
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::InventoryInvalid.as_str().into()))?;
  let mut targets = BTreeSet::new();
  for (kind, id, scope) in documents
    .occurrences
    .into_iter()
    .map(|item| {
      (
        WorkspaceContentResourceKind::Document,
        item.raw_target_doc_id,
        item.target_workspace_id,
      )
    })
    .chain(
      assets
        .into_iter()
        .map(|item| (WorkspaceContentResourceKind::Blob, item.source_key, item.workspace_id)),
    )
  {
    let scope = match scope.as_deref().map(Uuid::parse_str).transpose() {
      Ok(scope) => scope.unwrap_or(resource.resource.workspace_id()),
      Err(_) if kind == WorkspaceContentResourceKind::Document => continue,
      Err(_) => {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::InventoryInvalid.as_str().into(),
        ));
      }
    };
    match WorkspaceContentResourceRef::new(scope, kind, id) {
      Ok(target) => {
        targets.insert(target);
      }
      Err(_) if kind == WorkspaceContentResourceKind::Document => {}
      Err(_) => {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::InventoryInvalid.as_str().into(),
        ));
      }
    }
  }
  let mut tx = pool
    .begin()
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
    .execute(&mut *tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if retained_history {
    let history = crate::doc::reference_lineage::capture_in_tx(&mut tx, doc_id, &resource.resource, &[]).await?;
    targets.extend(crate::doc::reference_lineage::assets_from_lineage(&history));
  }
  if retained_history {
    let comment_keys = sqlx::query_scalar::<_, String>(
      "SELECT storage_key FROM comment_attachments WHERE workspace_id=$1 AND doc_id=$2",
    )
    .bind(resource.resource.workspace_id())
    .bind(doc_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
    for key in comment_keys {
      // BlobStore persists a relative BlobKey here; it adds the workspace
      // prefix at object I/O. A slash inside that opaque key is not provenance.
      targets.insert(
        WorkspaceContentResourceRef::new(
          resource.resource.workspace_id(),
          WorkspaceContentResourceKind::Blob,
          key,
        )
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::InventoryInvalid.as_str().into()))?,
      );
    }
  }
  tx.commit()
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if targets.len() > MAX_GRAPH_INVENTORY_RESOURCES {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::InventoryLimit.as_str().into(),
    ));
  }
  let mut references = Vec::new();
  for target in targets {
    let (relation, query, purpose) = if target.kind() == WorkspaceContentResourceKind::Blob {
      (
        "blobs",
        "SELECT EXISTS(SELECT 1 FROM blobs WHERE workspace_id=$1 AND key=$2 AND deleted_at IS NULL)",
        WorkspaceContentReferencePurpose::OwnedDependency,
      )
    } else {
      (
        "document_graph_occurrences",
        "SELECT EXISTS(SELECT 1 FROM docs WHERE workspace_id=$1 AND external_id=$2 AND deleted_at IS NULL)",
        WorkspaceContentReferencePurpose::Reference,
      )
    };
    let exists: bool = if target.kind() == WorkspaceContentResourceKind::Document {
      PgWorkspaceContentRedirectRepository::new(pool.clone(), doc.clone())
        .canonical_reference(&target)
        .await?
        .is_some()
    } else {
      sqlx::query_scalar(query)
        .bind(target.workspace_id())
        .bind(target.resource_id())
        .fetch_one(pool)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?
    };
    if !exists && target.kind() == WorkspaceContentResourceKind::Blob {
      return Err(AuthError::NotFound(
        WorkspaceContentErrorCode::SourceBlobMissing.as_str().into(),
      ));
    }
    references.push(WorkspaceContentGraphReference {
      relation: relation.into(),
      source: resource.resource.clone(),
      target,
      purpose,
      target_exists: exists,
    });
  }
  Ok(references)
}

fn collect_organizer_resources(
  snapshot: &OrganizerSnapshot,
  workspace_id: Uuid,
  resources: &mut Vec<WorkspaceContentResourceRef>,
) -> AuthResult<()> {
  fn collect(
    node: &OrganizerSnapshotNode,
    workspace_id: Uuid,
    resources: &mut Vec<WorkspaceContentResourceRef>,
  ) -> AuthResult<()> {
    if node.row.is_folder() {
      resources.push(
        WorkspaceContentResourceRef::new(workspace_id, WorkspaceContentResourceKind::Folder, node.row.id.clone())
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))?,
      );
    } else if node.row.effective_target_workspace_id(workspace_id) == workspace_id {
      let kind = match node
        .row
        .link_type()
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))?
      {
        myoxus_application::organizer::OrganizerLinkType::Doc => WorkspaceContentResourceKind::Document,
        myoxus_application::organizer::OrganizerLinkType::Database => WorkspaceContentResourceKind::Database,
        myoxus_application::organizer::OrganizerLinkType::Collection => return Ok(()),
        myoxus_application::organizer::OrganizerLinkType::Tag => WorkspaceContentResourceKind::Tag,
        myoxus_application::organizer::OrganizerLinkType::Workspace => return Ok(()),
      };
      if let Ok(resource) = WorkspaceContentResourceRef::new(workspace_id, kind, node.row.data.clone()) {
        resources.push(resource);
      }
    }
    for child in &node.children {
      collect(child, workspace_id, resources)?;
    }
    Ok(())
  }
  for root in &snapshot.roots {
    collect(root, workspace_id, resources)?;
  }
  Ok(())
}

async fn load_graph_resource(
  pool: &PgPool,
  resource: &WorkspaceContentResourceRef,
  organizer: Option<&OrganizerSnapshot>,
) -> AuthResult<Option<WorkspaceContentGraphResource>> {
  let mut tag_archived = false;
  let mut database_system_role = None;
  let (permission_resource_id, revision, display_name, schema_revision, relations, publicly_shared) =
    match resource.kind() {
      WorkspaceContentResourceKind::Document => {
        let row = sqlx::query(
          "SELECT id, title, public_mode, updated_at,
                  GREATEST(
                    COALESCE((SELECT last_sequence FROM doc_snapshots WHERE doc_id = docs.id), 0),
                    COALESCE((SELECT max(sequence) FROM doc_updates WHERE doc_id = docs.id), 0)
                  ) AS sequence
             FROM docs
            WHERE workspace_id = $1 AND external_id = $2 AND deleted_at IS NULL",
        )
        .bind(resource.workspace_id())
        .bind(resource.resource_id())
        .fetch_optional(pool)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?;
        let Some(row) = row else {
          return Ok(None);
        };
        (
          Some(row.get("id")),
          format!(
            "{}:{}",
            row.get::<chrono::DateTime<Utc>, _>("updated_at").timestamp_micros(),
            row.get::<i64, _>("sequence")
          ),
          Some(row.get("title")),
          None,
          vec!["docs", "doc_updates", "doc_snapshots", "doc_user_permissions"],
          row.get::<Option<String>, _>("public_mode").is_some(),
        )
      }
      WorkspaceContentResourceKind::Database => {
        let id = Uuid::parse_str(resource.resource_id()).map_err(|_| {
          AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().to_string())
        })?;
        let row = sqlx::query(
          "SELECT title, updated_at,system_role FROM workspace_databases
            WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL",
        )
        .bind(resource.workspace_id())
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?;
        let Some(row) = row else {
          return Ok(None);
        };
        database_system_role = match row.get::<Option<String>, _>("system_role").as_deref() {
          Some("workspace_tasks") => Some(myoxus_domain::database::DatabaseSystemRole::WorkspaceTasks),
          None => None,
          Some(_) => return Err(AuthError::Storage("unknown database system role".into())),
        };
        (
          None,
          row
            .get::<chrono::DateTime<Utc>, _>("updated_at")
            .timestamp_micros()
            .to_string(),
          Some(row.get("title")),
          Some(id.to_string()),
          vec![
            "workspace_databases",
            "workspace_database_fields",
            "workspace_database_rows",
            "workspace_database_cell_values",
            "workspace_database_views",
          ],
          false,
        )
      }
      WorkspaceContentResourceKind::Tag => {
        let id = Uuid::parse_str(resource.resource_id())
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().to_string()))?;
        let row = sqlx::query(
          "SELECT name, updated_at, archived_at FROM workspace_tags
            WHERE workspace_id = $1 AND id = $2",
        )
        .bind(resource.workspace_id())
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?;
        let Some(row) = row else {
          return Ok(None);
        };
        tag_archived = row.get::<Option<chrono::DateTime<Utc>>, _>("archived_at").is_some();
        (
          None,
          row
            .get::<chrono::DateTime<Utc>, _>("updated_at")
            .timestamp_micros()
            .to_string(),
          Some(row.get("name")),
          None,
          vec!["workspace_tags", "workspace_tag_document_assignments"],
          false,
        )
      }
      WorkspaceContentResourceKind::Blob => {
        let row = sqlx::query(
          "SELECT key, checksum, size AS size_bytes, created_at FROM blobs
            WHERE workspace_id = $1 AND key = $2",
        )
        .bind(resource.workspace_id())
        .bind(resource.resource_id())
        .fetch_optional(pool)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?;
        let Some(row) = row else {
          return Ok(None);
        };
        (
          None,
          format!(
            "{}:{}:{}",
            row.get::<Option<String>, _>("checksum").unwrap_or_default(),
            row.get::<i64, _>("size_bytes"),
            row.get::<chrono::DateTime<Utc>, _>("created_at").timestamp_micros()
          ),
          None,
          None,
          vec!["blobs"],
          false,
        )
      }
      WorkspaceContentResourceKind::Folder => {
        let Some(snapshot) = organizer else {
          return Ok(None);
        };
        let Some(node) = find_organizer_node(&snapshot.roots, resource) else {
          return Ok(None);
        };
        (
          None,
          snapshot.revision.clone(),
          Some(node.row.data.clone()),
          None,
          vec!["docs", "doc_updates"],
          false,
        )
      }
      WorkspaceContentResourceKind::Collection => {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str().into(),
        ));
      }
    };
  Ok(Some(WorkspaceContentGraphResource {
    database_system_role,
    resource: resource.clone(),
    permission_resource_id,
    revision,
    display_name,
    schema_revision,
    persistence_relations: relations.into_iter().map(str::to_string).collect(),
    publicly_shared,
    tag_archived,
  }))
}

async fn load_target_inventory(
  pool: &PgPool,
  workspace_id: Uuid,
  selected: &[WorkspaceContentResourceRef],
  organizer: Option<&OrganizerSnapshot>,
  portable_tags: bool,
) -> AuthResult<(Vec<WorkspaceContentTargetDefinition>, Vec<WorkspaceContentResourceRef>)> {
  let kinds = selected.iter().map(|resource| resource.kind()).collect::<BTreeSet<_>>();
  let mut definitions = Vec::new();
  let mut ids = Vec::new();
  if kinds.contains(&WorkspaceContentResourceKind::Document) {
    for row in sqlx::query("SELECT external_id FROM docs WHERE workspace_id = $1 AND deleted_at IS NULL LIMIT 4097")
      .bind(workspace_id)
      .fetch_all(pool)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?
    {
      let resource = WorkspaceContentResourceRef::new(
        workspace_id,
        WorkspaceContentResourceKind::Document,
        row.get::<String, _>("external_id"),
      )
      .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))?;
      // Document titles may legitimately be empty and are not reusable
      // workspace definitions. Only their identities participate in target
      // collision detection.
      ids.push(resource);
    }
  }
  if kinds.contains(&WorkspaceContentResourceKind::Database) {
    for row in sqlx::query(
      "SELECT id, title, updated_at FROM workspace_databases WHERE workspace_id = $1 AND deleted_at IS NULL AND system_role IS NULL LIMIT 4097",
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    {
      let id = row.get::<Uuid, _>("id");
      let resource =
        WorkspaceContentResourceRef::new(workspace_id, WorkspaceContentResourceKind::Database, id.to_string())
          .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::DatabaseIdentityInvalid.as_str().to_string()))?;
      ids.push(resource.clone());
      definitions.push(WorkspaceContentTargetDefinition {
        resource,
        display_name: row.get("title"),
        tag_archived: false,
        schema_revision: Some(
          row
            .get::<chrono::DateTime<Utc>, _>("updated_at")
            .timestamp_micros()
            .to_string(),
        ),
      });
    }
  }
  if kinds.contains(&WorkspaceContentResourceKind::Tag) {
    for row in
      sqlx::query("SELECT id, name, archived_at FROM workspace_tags WHERE workspace_id = $1 AND ($2 OR archived_at IS NULL) LIMIT 4097")
        .bind(workspace_id)
        .bind(portable_tags)
        .fetch_all(pool)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?
    {
      let resource = WorkspaceContentResourceRef::new(
        workspace_id,
        WorkspaceContentResourceKind::Tag,
        row.get::<Uuid, _>("id").to_string(),
      )
      .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::SourceTagInvalid.as_str().to_string()))?;
      ids.push(resource.clone());
      definitions.push(WorkspaceContentTargetDefinition {
        resource,
        display_name: row.get("name"),
        schema_revision: None,
        tag_archived: row.get::<Option<chrono::DateTime<Utc>>, _>("archived_at").is_some(),
      });
    }
    if portable_tags {
      for retired in
        sqlx::query_scalar::<_, String>("SELECT retired_tag_id FROM workspace_tag_retired_ids WHERE workspace_id = $1")
          .bind(workspace_id)
          .fetch_all(pool)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?
      {
        if let Ok(id) = Uuid::parse_str(&retired) {
          ids.push(
            WorkspaceContentResourceRef::new(workspace_id, WorkspaceContentResourceKind::Tag, id.to_string())
              .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().into()))?,
          );
        }
      }
    }
  }
  if kinds.contains(&WorkspaceContentResourceKind::Folder) {
    let snapshot =
      organizer.ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::OrganizerDecode.as_str().to_string()))?;
    collect_target_organizer_ids(&snapshot.roots, workspace_id, &mut ids)?;
  }
  if definitions.len() > MAX_GRAPH_INVENTORY_RESOURCES {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::InventoryLimit.as_str().to_string(),
    ));
  }
  ids.sort();
  ids.dedup();
  Ok((definitions, ids))
}

fn find_organizer_node<'a>(
  nodes: &'a [OrganizerSnapshotNode],
  resource: &WorkspaceContentResourceRef,
) -> Option<&'a OrganizerSnapshotNode> {
  nodes.iter().find_map(|node| {
    let found = match resource.kind() {
      WorkspaceContentResourceKind::Folder => node.row.is_folder() && node.row.id == resource.resource_id(),
      _ => false,
    };
    found
      .then_some(node)
      .or_else(|| find_organizer_node(&node.children, resource))
  })
}

fn collect_target_organizer_ids(
  nodes: &[OrganizerSnapshotNode],
  workspace_id: Uuid,
  ids: &mut Vec<WorkspaceContentResourceRef>,
) -> AuthResult<()> {
  for node in nodes {
    if node.row.is_folder() {
      ids.push(
        WorkspaceContentResourceRef::new(workspace_id, WorkspaceContentResourceKind::Folder, node.row.id.clone())
          .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))?,
      );
    }
    collect_target_organizer_ids(&node.children, workspace_id, ids)?;
  }
  Ok(())
}

/// Singular SQL/object-store publication boundary for a staged XWS Copy.
///
/// Final blob bytes are prewritten under deterministic keys because object
/// storage cannot join a PostgreSQL transaction. They become product-visible
/// only when the matching `blobs` metadata row commits. Any pre-commit failure
/// removes only bytes created by this attempt; every canonical SQL row,
/// operation transition and durable fanout intent commits together.
pub struct PgWorkspaceContentCopyPublicationRepository {
  pool: PgPool,
  database_templates: Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
  storage: Arc<dyn BlobStoragePort>,
  default_workspace_quota_mb: u64,
}

/// Identity-preserving SQL/object-store publication boundary for Move.
pub struct PgWorkspaceContentMovePublicationRepository {
  pool: PgPool,
  database_templates: Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
  capture_config: Option<crate::document_version::ConfigValuesReader>,
  storage: Arc<dyn BlobStoragePort>,
  default_workspace_quota_mb: u64,
}

impl PgWorkspaceContentMovePublicationRepository {
  pub fn new(
    pool: PgPool,
    storage: Arc<dyn BlobStoragePort>,
    database_templates: Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
  ) -> Self {
    Self {
      pool,
      database_templates,
      capture_config: None,
      storage,
      default_workspace_quota_mb: 0,
    }
  }

  pub fn with_config_values_reader(mut self, reader: crate::document_version::ConfigValuesReader) -> Self {
    self.capture_config = Some(reader);
    self
  }

  pub fn with_quota_config(mut self, default_workspace_quota_mb: u64) -> Self {
    self.default_workspace_quota_mb = default_workspace_quota_mb;
    self
  }
}

impl PgWorkspaceContentCopyPublicationRepository {
  pub fn new(
    pool: PgPool,
    storage: Arc<dyn BlobStoragePort>,
    database_templates: Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
  ) -> Self {
    Self {
      pool,
      database_templates,
      storage,
      default_workspace_quota_mb: 0,
    }
  }

  pub fn with_quota_config(mut self, default_workspace_quota_mb: u64) -> Self {
    self.default_workspace_quota_mb = default_workspace_quota_mb;
    self
  }
}

impl PgWorkspaceContentOperationRepository {
  pub fn new(
    pool: PgPool,
    database_templates: Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
  ) -> Self {
    Self {
      pool,
      database_templates,
    }
  }

  /// New or reactivated work needs live parents; completed replay needs only
  /// its retained receipt. Account deletion locks the actor before workspaces.
  #[instrument(skip_all, fields(operation_id = %record.id))]
  async fn lock_live_parents(
    tx: &mut Transaction<'_, Postgres>,
    record: &WorkspaceContentOperationRecord,
  ) -> AuthResult<()> {
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR KEY SHARE")
      .bind(record.actor_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::storage)?
      .ok_or_else(|| AuthError::NotFound("user".into()))?;
    let mut ids = vec![record.source_workspace_id];
    ids.extend(record.target_workspace_id);
    ids.sort_unstable();
    ids.dedup();
    let existing: Vec<Uuid> =
      sqlx::query_scalar("SELECT id FROM workspaces WHERE id=ANY($1) ORDER BY id FOR KEY SHARE")
        .bind(&ids)
        .fetch_all(&mut **tx)
        .await
        .map_err(Self::storage)?;
    if !existing.contains(&record.source_workspace_id) {
      return Err(AuthError::NotFound(
        WorkspaceContentErrorCode::SourceWorkspaceMissing.as_str().into(),
      ));
    }
    if existing != ids {
      return Err(AuthError::NotFound(
        WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str().into(),
      ));
    }
    Ok(())
  }

  pub(crate) fn storage(error: sqlx::Error) -> AuthError {
    let error_kind = sqlx_error_kind(&error);
    let database_code = error
      .as_database_error()
      .and_then(|error| error.code())
      .map(|code| code.into_owned());
    let constraint = error.as_database_error().and_then(|error| error.constraint());
    let table = error.as_database_error().and_then(|error| error.table());
    let code = match (database_code.as_deref(), constraint) {
      (Some("23503"), Some("workspace_tag_document_assignments_workspace_id_tag_id_fkey")) => {
        WorkspaceContentErrorCode::TagAssignmentConstraint
      }
      (Some("23503"), _) => WorkspaceContentErrorCode::DatabaseForeignKeyConstraint,
      (Some("23505"), _) => WorkspaceContentErrorCode::DatabaseUniqueConstraint,
      (Some("23514"), _) => WorkspaceContentErrorCode::DatabaseCheckConstraint,
      (Some("23502"), _) => WorkspaceContentErrorCode::DatabaseNotNullConstraint,
      (Some("40001"), _) => WorkspaceContentErrorCode::PublicationSerializationConflict,
      (Some("40P01"), _) => WorkspaceContentErrorCode::PublicationDeadlock,
      _ => WorkspaceContentErrorCode::DatabaseUnavailable,
    };
    error!(
      error_kind,
      database_code,
      constraint,
      table,
      cause = code.as_str(),
      "workspace_content.persistence_failed"
    );
    if !code.retryable() {
      return AuthError::InvalidInput(code.as_str().into());
    }
    AuthError::Storage(WorkspaceContentErrorCode::DatabaseUnavailable.as_str().to_string())
  }

  fn invalid(message: &'static str) -> AuthError {
    AuthError::InvalidInput(message.to_string())
  }

  fn validate_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
  }

  fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
  }

  fn validate_record(record: &WorkspaceContentOperationRecord) -> AuthResult<()> {
    if record.id.is_nil()
      || record.idempotency_id.is_nil()
      || record.actor_id.is_nil()
      || record.source_workspace_id.is_nil()
      || record.target_workspace_id.is_some_and(|id| id.is_nil())
      || record.target_workspace_id == Some(record.source_workspace_id)
      || record.status != WorkspaceContentOperationStatus::Draft
      || !Self::valid_sha256(&record.manifest_hash)
      || record
        .preview_revision
        .as_deref()
        .is_some_and(|value| !Self::validate_text(value, MAX_PREVIEW_REVISION_BYTES))
      || record
        .diagnostic_instance_id
        .as_deref()
        .is_some_and(|value| !Self::validate_text(value, MAX_DIAGNOSTIC_INSTANCE_ID_BYTES))
      || record.error.is_some()
    {
      return Err(Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()));
    }
    if record.kind != WorkspaceContentOperationKind::ExtractFolder && record.target_workspace_id.is_none() {
      return Err(Self::invalid(
        WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str(),
      ));
    }
    Ok(())
  }

  async fn record_by_idempotency(
    tx: &mut Transaction<'_, Postgres>,
    idempotency_id: uuid::Uuid,
  ) -> AuthResult<Option<WorkspaceContentOperationRecord>> {
    sqlx::query(&format!("{RECORD_SELECT} WHERE idempotency_id = $1"))
      .bind(idempotency_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::storage)?
      .map(|row| map_record(&row))
      .transpose()
  }

  async fn load_record(
    tx: &mut Transaction<'_, Postgres>,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    sqlx::query(&format!("{RECORD_SELECT} WHERE id = $1"))
      .bind(operation_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::storage)?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))
      .and_then(|row| map_record(&row))
  }

  async fn operation_boundaries(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<(uuid::Uuid, Option<uuid::Uuid>)> {
    sqlx::query_as("SELECT source_workspace_id, target_workspace_id FROM workspace_content_operations WHERE id = $1")
      .bind(operation_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::storage)?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))
  }

  /// Keep operation-owned references inside the persisted source/target
  /// boundary. This is pure manifest validation, not a resource lock.
  fn resource_belongs_to_operation(
    resource: &WorkspaceContentResourceRef,
    source_workspace_id: uuid::Uuid,
    target_workspace_id: Option<uuid::Uuid>,
  ) -> bool {
    resource.workspace_id() == source_workspace_id || target_workspace_id == Some(resource.workspace_id())
  }
}

#[async_trait]
impl WorkspaceContentExtractTargetPort for PgWorkspaceContentOperationRepository {
  #[instrument(
    skip(self, request),
    fields(operation_id = %request.operation.id, source_workspace_id = %request.operation.source_workspace_id)
  )]
  async fn create_extract_target(
    &self,
    request: WorkspaceContentExtractTargetRequest,
  ) -> AuthResult<WorkspaceContentExtractTarget> {
    let target_workspace_id = request.target_workspace_id;
    if request.operation.kind != WorkspaceContentOperationKind::ExtractFolder
      || request.operation.status != WorkspaceContentOperationStatus::Previewed
      || request.operation.preview_revision.as_deref() != Some(request.membership_revision.as_str())
      || request.source_folder_id.is_empty()
      || request.root_update.is_empty()
      || request.owner_principal.principal_type == OwnerPrincipalType::System
      || request.owner_principal.principal_id.is_nil()
      || target_workspace_id == request.operation.source_workspace_id
    {
      return Err(Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()));
    }
    let principal_type = request.owner_principal.principal_type.as_str();
    let membership_snapshot = serde_json::to_value(&request.memberships)
      .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::EncodingFailed.as_str().to_string()))?;
    let acl_plan = serde_json::to_value(&request.acl_plan)
      .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::EncodingFailed.as_str().to_string()))?;

    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
      .execute(&mut *tx)
      .await
      .map_err(Self::storage)?;
    let durable = Self::load_record(&mut tx, request.operation.id).await?;
    if durable.kind != WorkspaceContentOperationKind::ExtractFolder
      || durable.status != WorkspaceContentOperationStatus::Previewed
      || durable.actor_id != request.operation.actor_id
      || durable.source_workspace_id != request.operation.source_workspace_id
      || durable.preview_revision != request.operation.preview_revision
      || durable.manifest_hash != request.operation.manifest_hash
      || durable.target_workspace_id.is_some_and(|id| id != target_workspace_id)
    {
      return Err(publication_failure(
        WorkspaceContentErrorCode::ExtractOperationRevisionChanged,
      ));
    }

    if let Some(row) = sqlx::query(
      "SELECT source_workspace_id, source_folder_id, target_workspace_id,
              owner_principal_type::text AS owner_principal_type, owner_principal_id,
              membership_revision, membership_snapshot, acl_publication_plan, git_sync_plan
         FROM workspace_content_extract_targets
        WHERE operation_id = $1",
    )
    .bind(request.operation.id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::storage)?
    {
      let exact_replay = row.get::<Uuid, _>("source_workspace_id") == request.operation.source_workspace_id
        && row.get::<String, _>("source_folder_id") == request.source_folder_id
        && row.get::<Uuid, _>("target_workspace_id") == target_workspace_id
        && row.get::<String, _>("owner_principal_type") == principal_type
        && row.get::<Uuid, _>("owner_principal_id") == request.owner_principal.principal_id
        && row.get::<String, _>("membership_revision") == request.membership_revision
        && row.get::<serde_json::Value, _>("membership_snapshot") == membership_snapshot
        && row.get::<serde_json::Value, _>("acl_publication_plan") == acl_plan
        && row.get::<Option<serde_json::Value>, _>("git_sync_plan")
          == request
            .git_sync_plan
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|_| Self::invalid(WorkspaceContentErrorCode::EncodingFailed.as_str()))?;
      if !exact_replay {
        return Err(publication_failure(
          WorkspaceContentErrorCode::ExtractTargetReplayChanged,
        ));
      }
      let name = sqlx::query_scalar::<_, String>(
        "SELECT name FROM workspaces
          WHERE id = $1 AND lifecycle_state = 'extracting'
            AND lifecycle_owner_kind = 'workspace_content'
            AND lifecycle_owner_id = $2 AND deleted_at IS NULL",
      )
      .bind(target_workspace_id)
      .bind(request.operation.id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::storage)?
      .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::ExtractTargetLifecycleChanged))?;
      tx.commit().await.map_err(Self::storage)?;
      return Ok(WorkspaceContentExtractTarget {
        operation_id: request.operation.id,
        workspace_id: target_workspace_id,
        name,
      });
    }

    let source = sqlx::query(
      "SELECT owner_principal_type::text AS owner_principal_type, owner_principal_id
         FROM workspaces
        WHERE id = $1 AND lifecycle_state = 'active' AND deleted_at IS NULL
        FOR UPDATE",
    )
    .bind(request.operation.source_workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::storage)?
    .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::SourceWorkspaceMissing.as_str().to_string()))?;
    if source.get::<String, _>("owner_principal_type") != principal_type
      || source.get::<Option<Uuid>, _>("owner_principal_id") != Some(request.owner_principal.principal_id)
    {
      return Err(Self::invalid("XWS_OWNERSHIP_UNSUPPORTED"));
    }

    let current_memberships = sqlx::query(
      "SELECT user_id, role::text AS role
         FROM workspace_memberships
        WHERE workspace_id = $1 AND status = 'Accepted'
        ORDER BY user_id
        FOR SHARE",
    )
    .bind(request.operation.source_workspace_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::storage)?
    .into_iter()
    .map(|row| {
      let role = workspace_role(&row.get::<String, _>("role"))?;
      Ok(serde_json::json!({
        "userId": row.get::<Uuid, _>("user_id"),
        "role": role,
      }))
    })
    .collect::<AuthResult<Vec<_>>>()?;
    if serde_json::Value::Array(current_memberships) != membership_snapshot {
      return Err(publication_failure(
        WorkspaceContentErrorCode::ExtractMembershipSnapshotChanged,
      ));
    }

    SqlxWorkspaceStore::lock_name_principal(&mut tx, principal_type, request.owner_principal.principal_id).await?;
    SqlxWorkspaceStore::require_available_name(
      &mut tx,
      principal_type,
      request.owner_principal.principal_id,
      &request.name,
      Some(target_workspace_id),
    )
    .await?;

    let owner_user_id = (request.owner_principal.principal_type == OwnerPrincipalType::User)
      .then_some(request.owner_principal.principal_id);
    let management_unit_id = (request.owner_principal.principal_type == OwnerPrincipalType::Ou)
      .then_some(request.owner_principal.principal_id);
    sqlx::query(
      "INSERT INTO workspaces (
         id, owner_user_id, owner_principal_type, owner_principal_id,
         management_unit_id, created_by_user_id, is_personal_workspace,
         name, name_normalized, public, lifecycle_state,
         lifecycle_owner_kind, lifecycle_owner_id
       )
       VALUES ($1, $2, $3::owner_principal_type, $4, $5, $6, false,
               $7, $8, false, 'extracting', 'workspace_content', $9)",
    )
    .bind(target_workspace_id)
    .bind(owner_user_id)
    .bind(principal_type)
    .bind(request.owner_principal.principal_id)
    .bind(management_unit_id)
    .bind(request.operation.actor_id)
    .bind(request.name.display())
    .bind(request.name.normalized())
    .bind(request.operation.id)
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?;
    let task_state = myoxus_application::workspace::tasks::workspace_tasks_initial_state(
      &self.database_templates,
      target_workspace_id,
      Some(request.operation.actor_id),
    )
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    crate::workspace_database::PgDatabaseRepository::ensure_workspace_tasks_in_tx(
      &mut tx,
      &self.database_templates,
      task_state,
    )
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    sqlx::query(
      "INSERT INTO docs (id, workspace_id, title, is_workspace_root, created_by, updated_by)
       VALUES ($1, $1, $2, true, $3, $3)",
    )
    .bind(target_workspace_id)
    .bind(request.name.display())
    .bind(request.operation.actor_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?;
    sqlx::query(
      "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
       VALUES ($1, $1, $2, 1)",
    )
    .bind(target_workspace_id)
    .bind(&request.root_update)
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?;
    for member in &request.memberships {
      sqlx::query(
        "INSERT INTO workspace_memberships
           (workspace_id, user_id, role, status, joined_at)
         VALUES ($1, $2, $3, 'Accepted', now())",
      )
      .bind(target_workspace_id)
      .bind(member.user_id)
      .bind(workspace_role_name(member.role))
      .execute(&mut *tx)
      .await
      .map_err(Self::storage)?;
    }
    if request.owner_principal.principal_type == OwnerPrincipalType::Ou {
      sqlx::query(
        "INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship)
         VALUES ($1, $2, 'owner'::organization_unit_workspace_relationship)",
      )
      .bind(request.owner_principal.principal_id)
      .bind(target_workspace_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::storage)?;
    }
    sqlx::query(
      "INSERT INTO workspace_content_extract_targets (
         operation_id, source_workspace_id, source_folder_id, target_workspace_id,
         owner_principal_type, owner_principal_id, membership_revision,
          membership_snapshot, acl_publication_plan, git_sync_plan
        )
        VALUES ($1, $2, $3, $4, $5::owner_principal_type, $6, $7, $8, $9, $10)",
    )
    .bind(request.operation.id)
    .bind(request.operation.source_workspace_id)
    .bind(&request.source_folder_id)
    .bind(target_workspace_id)
    .bind(principal_type)
    .bind(request.owner_principal.principal_id)
    .bind(&request.membership_revision)
    .bind(&membership_snapshot)
    .bind(&acl_plan)
    .bind(
      request
        .git_sync_plan
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|_| Self::invalid(WorkspaceContentErrorCode::EncodingFailed.as_str()))?,
    )
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?;
    sqlx::query(
      "UPDATE workspace_content_operations
          SET target_workspace_id = $2, updated_at = now()
        WHERE id = $1 AND target_workspace_id IS NULL AND status = 'previewed'",
    )
    .bind(request.operation.id)
    .bind(target_workspace_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?;
    tx.commit().await.map_err(Self::storage)?;
    Ok(WorkspaceContentExtractTarget {
      operation_id: request.operation.id,
      workspace_id: target_workspace_id,
      name: request.name.display().to_string(),
    })
  }
}

#[async_trait]
impl WorkspaceContentExtractContextPort for PgWorkspaceContentOperationRepository {
  #[instrument(skip_all)]
  async fn extract_target_owner(
    &self,
    operation: &WorkspaceContentOperationRecord,
  ) -> AuthResult<Option<WorkspaceContentOwnerPrincipal>> {
    if operation.kind != WorkspaceContentOperationKind::ExtractFolder
      || operation.status != WorkspaceContentOperationStatus::Running
    {
      return Ok(None);
    }
    let row = sqlx::query(
      "SELECT receipt.owner_principal_type::text AS principal_type, receipt.owner_principal_id
         FROM workspace_content_operations operation
         JOIN workspace_content_extract_targets receipt
           ON receipt.operation_id = operation.id
          AND receipt.source_workspace_id = operation.source_workspace_id
          AND receipt.target_workspace_id = operation.target_workspace_id
          AND receipt.published_at IS NULL
         JOIN workspaces target ON target.id = receipt.target_workspace_id
          AND target.lifecycle_state = 'extracting'
          AND target.lifecycle_owner_kind = 'workspace_content'
          AND target.lifecycle_owner_id = operation.id
          AND target.deleted_at IS NULL
          AND target.owner_principal_type = receipt.owner_principal_type
          AND target.owner_principal_id = receipt.owner_principal_id
         JOIN workspaces source ON source.id = receipt.source_workspace_id
          AND source.lifecycle_state = 'active' AND source.deleted_at IS NULL
        WHERE operation.id = $1 AND operation.actor_id = $2
          AND operation.target_workspace_id = $3 AND operation.source_workspace_id = $4
          AND operation.kind = 'extract_folder' AND operation.status = 'running'",
    )
    .bind(operation.id)
    .bind(operation.actor_id)
    .bind(operation.target_workspace_id)
    .bind(operation.source_workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?;
    row
      .map(|row| {
        Ok(WorkspaceContentOwnerPrincipal {
          principal_type: OwnerPrincipalType::parse(&row.get::<String, _>("principal_type"))
            .ok_or_else(|| Self::invalid(WorkspaceContentErrorCode::OwnershipUnsupported.as_str()))?,
          principal_id: row.get("owner_principal_id"),
        })
      })
      .transpose()
  }

  async fn extract_source_folder_id(&self, operation_id: WorkspaceContentOperationId) -> AuthResult<String> {
    sqlx::query_scalar(
      "SELECT source_folder_id
         FROM workspace_content_extract_targets
        WHERE operation_id = $1",
    )
    .bind(operation_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?
    .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()))
  }

  async fn extract_recipient_snapshot(
    &self,
    operation: &WorkspaceContentOperationRecord,
  ) -> AuthResult<WorkspaceContentRecipientSnapshot> {
    let row = sqlx::query(
      "SELECT receipt.membership_snapshot, source.name
         FROM workspace_content_extract_targets receipt
         JOIN workspace_content_operations operation ON operation.id = receipt.operation_id
         JOIN workspaces source ON source.id = receipt.source_workspace_id
        WHERE operation.id = $1 AND operation.actor_id = $2
          AND operation.source_workspace_id = $3 AND operation.target_workspace_id = $4
          AND operation.kind = 'extract_folder' AND operation.status = 'running'
          AND receipt.published_at IS NULL",
    )
    .bind(operation.id)
    .bind(operation.actor_id)
    .bind(operation.source_workspace_id)
    .bind(operation.target_workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?
    .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()))?;
    let members: Vec<WorkspaceContentMemberRevision> = serde_json::from_value(row.get("membership_snapshot"))
      .map_err(|_| Self::invalid(WorkspaceContentErrorCode::InventoryInvalid.as_str()))?;
    let mut recipients = members
      .into_iter()
      .map(|member| (member.user_id, workspace_role_name(member.role).to_string()))
      .collect::<Vec<_>>();
    if !recipients.iter().any(|(id, _)| *id == operation.actor_id) {
      recipients.push((operation.actor_id, "Actor".to_string()));
    }
    recipients.sort_by_key(|(id, _)| *id);
    let source_workspace_name: String = row.get("name");
    Ok(WorkspaceContentRecipientSnapshot {
      revision: move_recipient_snapshot_revision(operation.source_workspace_id, &source_workspace_name, &recipients),
      source_workspace_name,
      recipient_ids: recipients.into_iter().map(|(id, _)| id).collect(),
    })
  }
}

#[async_trait]
impl WorkspaceContentExtractRecoveryPort for PgWorkspaceContentOperationRepository {
  #[instrument(skip(self, failure, storage), fields(%operation_id, phase = "compensation", initial_cause = failure.code.as_str()))]
  async fn compensate_extract(
    &self,
    operation_id: WorkspaceContentOperationId,
    diagnostic_instance_id: &str,
    failure: RedactedWorkspaceContentError,
    storage: &dyn BlobStoragePort,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    if !Self::validate_text(diagnostic_instance_id, MAX_DIAGNOSTIC_INSTANCE_ID_BYTES) {
      return Err(Self::invalid(
        WorkspaceContentErrorCode::DiagnosticInstanceInvalid.as_str(),
      ));
    }
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
      .execute(&mut *tx)
      .await
      .map_err(Self::storage)?;
    let row = sqlx::query(&format!("{RECORD_SELECT} WHERE id = $1 FOR UPDATE"))
      .bind(operation_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::storage)?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))?;
    let record = map_record(&row)?;
    if record.kind != WorkspaceContentOperationKind::ExtractFolder {
      return Err(Self::invalid(
        WorkspaceContentErrorCode::PublicationKindInvalid.as_str(),
      ));
    }
    if record.status == WorkspaceContentOperationStatus::Succeeded {
      tx.commit().await.map_err(Self::storage)?;
      return Ok(record);
    }
    if matches!(
      record.status,
      WorkspaceContentOperationStatus::Cancelled | WorkspaceContentOperationStatus::Failed
    ) && record.target_workspace_id.is_none()
    {
      tx.commit().await.map_err(Self::storage)?;
      return Ok(record);
    }
    let target = sqlx::query(
      "SELECT target_workspace_id, published_at
         FROM workspace_content_extract_targets
        WHERE operation_id = $1
        FOR UPDATE",
    )
    .bind(operation_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::storage)?;
    let Some(target) = target else {
      return Err(publication_failure(
        WorkspaceContentErrorCode::ExtractRecoveryTargetReceiptIsMissing,
      ));
    };
    if target
      .get::<Option<chrono::DateTime<chrono::Utc>>, _>("published_at")
      .is_some()
    {
      return Err(publication_failure(
        WorkspaceContentErrorCode::PublishedExtractCannotBeCompensated,
      ));
    }
    let target_workspace_id: Uuid = target.get("target_workspace_id");
    let private_keys = sqlx::query_scalar::<_, String>(
      "SELECT target_workspace_id::text || '/' || target_id
         FROM workspace_content_operation_compensations
        WHERE operation_id = $1 AND kind = 'delete_operation_blob' AND target_kind = 'blob'
        ORDER BY sequence",
    )
    .bind(operation_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::storage)?
    .into_iter()
    .collect();
    // The receipt lock also fences publication while private bytes are removed.
    // A failed deletion retains both the intent and hidden target for recovery.
    cleanup_operation_blob_keys_in_tx(&mut tx, storage, operation_id, &private_keys).await?;
    let pending_private_objects: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM workspace_content_operation_compensations
         WHERE operation_id = $1 AND kind = 'delete_operation_blob' AND completed_at IS NULL)",
    )
    .bind(operation_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::storage)?;
    if pending_private_objects {
      // Referenced bytes must survive. Never cascade the target or erase the
      // recovery intent when the canonical Blob owner's fence denied cleanup.
      return Err(publication_failure(WorkspaceContentErrorCode::BlobCompensationFailed));
    }
    for table in [
      "workspace_content_move_revision_manifests",
      "workspace_content_operation_recipient_outbox",
      "workspace_content_operation_staging",
      "workspace_content_operation_mappings",
      // Staged bytes have been removed by the recovery service; materialized
      // target bytes were cleaned above. RESTRICT must not outlive these intents.
      "workspace_content_operation_compensations",
      "workspace_content_extract_targets",
    ] {
      sqlx::query(&format!("DELETE FROM {table} WHERE operation_id = $1"))
        .bind(operation_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::storage)?;
    }
    // The locked current row, not the worker's earlier snapshot, decides
    // whether cancellation won the race with semantic failure.
    let row = sqlx::query(&format!(
      "UPDATE workspace_content_operations
          SET target_workspace_id = NULL,
              status = CASE WHEN status = 'cancelled' OR
                (error_code = 'XWS_CANCELLATION_CLEANUP_REQUIRED' OR (error_code = 'XWS_WORKER_EXECUTION_FAILED' AND error_message = 'workspace content cancellation cleanup requires retry'))
                THEN 'cancelled' ELSE 'failed' END,
              error_code = CASE WHEN status = 'cancelled' OR
                (error_code = 'XWS_CANCELLATION_CLEANUP_REQUIRED' OR (error_code = 'XWS_WORKER_EXECUTION_FAILED' AND error_message = 'workspace content cancellation cleanup requires retry'))
                THEN NULL ELSE $2 END,
              error_message = CASE WHEN status = 'cancelled' OR
                (error_code = 'XWS_CANCELLATION_CLEANUP_REQUIRED' OR (error_code = 'XWS_WORKER_EXECUTION_FAILED' AND error_message = 'workspace content cancellation cleanup requires retry'))
                THEN NULL ELSE $3 END,
              error_phase = CASE WHEN status = 'cancelled' OR
                (error_code = 'XWS_CANCELLATION_CLEANUP_REQUIRED' OR (error_code = 'XWS_WORKER_EXECUTION_FAILED' AND error_message = 'workspace content cancellation cleanup requires retry'))
                THEN NULL ELSE $5 END,
              diagnostic_instance_id = $4, updated_at = now()
        WHERE id = $1 AND status <> 'succeeded'
        RETURNING {RECORD_COLUMNS}"
    ))
    .bind(operation_id)
    .bind(failure.code.as_str())
    .bind(failure.message())
    .bind(diagnostic_instance_id)
    .bind(failure.phase.as_deref())
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::storage)?
    .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::ExtractRecoveryStateChanged))?;
    let deleted = sqlx::query(
      "DELETE FROM workspaces
        WHERE id = $1 AND lifecycle_state = 'extracting'
          AND lifecycle_owner_kind = 'workspace_content'
          AND lifecycle_owner_id = $2",
    )
    .bind(target_workspace_id)
    .bind(operation_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?
    .rows_affected();
    if deleted != 1 {
      return Err(publication_failure(
        WorkspaceContentErrorCode::ExtractRecoveryTargetLifecycleChanged,
      ));
    }
    let failed = map_record(&row)?;
    tx.commit().await.map_err(Self::storage)?;
    Ok(failed)
  }

  #[instrument(skip(self, failure), fields(%operation_id, phase = "compensation", initial_cause = failure.code.as_str()))]
  async fn mark_extract_cleanup_required(
    &self,
    operation_id: WorkspaceContentOperationId,
    diagnostic_instance_id: &str,
    failure: RedactedWorkspaceContentError,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    if !Self::validate_text(diagnostic_instance_id, MAX_DIAGNOSTIC_INSTANCE_ID_BYTES) {
      return Err(Self::invalid(
        WorkspaceContentErrorCode::DiagnosticInstanceInvalid.as_str(),
      ));
    }
    let row = sqlx::query(&format!(
      "UPDATE workspace_content_operations
          SET status = 'cleanup_required',
              error_code = CASE WHEN status = 'cancelled'
                THEN 'XWS_CANCELLATION_CLEANUP_REQUIRED' ELSE COALESCE(error_code, $2) END,
              error_message = CASE WHEN status = 'cancelled'
                THEN 'workspace content cancellation cleanup requires retry'
                ELSE COALESCE(error_message, $3) END,
              error_phase = CASE WHEN status = 'cancelled' THEN 'compensation' WHEN error_code IS NULL THEN $5 ELSE error_phase END,
              diagnostic_instance_id = $4, updated_at = now()
        WHERE id = $1 AND kind = 'extract_folder'
          AND status IN ('running', 'cleanup_required', 'cancelled')
          AND target_workspace_id IS NOT NULL
        RETURNING {RECORD_COLUMNS}"
    ))
    .bind(operation_id)
    .bind(failure.code.as_str())
    .bind(failure.message())
    .bind(diagnostic_instance_id)
    .bind(failure.phase.as_deref())
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?;
    if let Some(row) = row {
      return map_record(&row);
    }
    let record = self
      .get(operation_id)
      .await?
      .ok_or_else(|| Self::invalid(WorkspaceContentErrorCode::OperationMissing.as_str()))?;
    if record.kind == WorkspaceContentOperationKind::ExtractFolder
      && (record.status == WorkspaceContentOperationStatus::Succeeded
        || (matches!(
          record.status,
          WorkspaceContentOperationStatus::Cancelled | WorkspaceContentOperationStatus::Failed
        ) && record.target_workspace_id.is_none()))
    {
      return Ok(record);
    }
    Err(publication_failure(
      WorkspaceContentErrorCode::ExtractRecoveryStateChanged,
    ))
  }
}

#[async_trait]
impl WorkspaceContentAuthorizationSource for PgWorkspaceContentAuthorizationSource {
  #[instrument(skip(self, graph), fields(source_workspace_id = %graph.source_workspace_id))]
  async fn load_authorization_state(
    &self,
    graph: &WorkspaceContentPreflightGraph,
    include_copy_acl: bool,
  ) -> AuthResult<WorkspaceContentAuthorizationState> {
    let mut tx = self
      .pool
      .begin()
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
      .execute(&mut *tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    let source = load_workspace_authorization_revision(&mut tx, graph.source_workspace_id).await?;
    if graph.kind == WorkspaceContentOperationKind::ExtractFolder {
      tx.commit()
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?;
      return Ok(WorkspaceContentAuthorizationState {
        source,
        target: None,
        document_acl_revision: graph.revision.clone(),
        permission_revision: graph.revision.clone(),
      });
    }
    let target = Some(load_workspace_authorization_revision(&mut tx, graph.target_workspace_id).await?);
    let mut document_ids = graph
      .resources
      .iter()
      .filter(|resource| resource.resource.kind() == WorkspaceContentResourceKind::Document)
      .map(|resource| {
        resource
          .permission_resource_id
          .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))
      })
      .collect::<AuthResult<Vec<_>>>()?;
    document_ids.sort();
    document_ids.dedup();
    let acl_rows = if include_copy_acl {
      sqlx::query(
        "SELECT doc_id, user_id, role
           FROM doc_user_permissions
          WHERE doc_id = ANY($1)
          ORDER BY doc_id, user_id, role",
      )
      .bind(&document_ids)
      .fetch_all(&mut *tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?
      .into_iter()
      .map(|row| {
        serde_json::json!({
          "docId": row.get::<Uuid, _>("doc_id"),
          "userId": row.get::<Uuid, _>("user_id"),
          "role": row.get::<String, _>("role"),
        })
      })
      .collect::<Vec<_>>()
    } else {
      Vec::new()
    };
    let policy_scope: serde_json::Value = sqlx::query_scalar(
      "SELECT jsonb_build_object(
         'workspaceLinks', COALESCE((
           SELECT jsonb_agg(to_jsonb(link) ORDER BY link.unit_id, link.workspace_id, link.relationship)
             FROM organization_unit_workspace link
            WHERE link.workspace_id = ANY($1)
         ), '[]'::jsonb),
         'units', COALESCE((
           SELECT jsonb_agg(to_jsonb(unit_row) ORDER BY unit_row.id)
             FROM organization_unit unit_row
            WHERE unit_row.id IN (
              SELECT link.unit_id FROM organization_unit_workspace link
               WHERE link.workspace_id = ANY($1)
            )
         ), '[]'::jsonb)
       )",
    )
    .bind([graph.source_workspace_id, graph.target_workspace_id])
    .fetch_one(&mut *tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
    let document_acl_revision = hash_values(&acl_rows)?;
    let permission_revision = hash_values(&[
      serde_json::to_value(&source)
        .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::EncodingFailed.as_str().to_string()))?,
      serde_json::to_value(&target)
        .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::EncodingFailed.as_str().to_string()))?,
      policy_scope,
      serde_json::Value::String(document_acl_revision.clone()),
    ])?;
    tx.commit()
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    Ok(WorkspaceContentAuthorizationState {
      source,
      target,
      document_acl_revision,
      permission_revision,
    })
  }
}

const RECORD_SELECT: &str = r#"
  SELECT id, idempotency_id, actor_id, kind, source_workspace_id,
         target_workspace_id, status, preview_revision, manifest_hash,
         error_code, error_message, error_phase, diagnostic_instance_id, created_at,
         updated_at
  FROM workspace_content_operations
"#;
const RECORD_COLUMNS: &str = r#"
  id, idempotency_id, actor_id, kind, source_workspace_id,
  target_workspace_id, status, preview_revision, manifest_hash,
  error_code, error_message, error_phase, diagnostic_instance_id, created_at, updated_at
"#;

fn operation_kind(value: &str) -> AuthResult<WorkspaceContentOperationKind> {
  match value {
    "move" => Ok(WorkspaceContentOperationKind::Move),
    "copy" => Ok(WorkspaceContentOperationKind::Copy),
    "link" => Ok(WorkspaceContentOperationKind::Link),
    "extract_folder" => Ok(WorkspaceContentOperationKind::ExtractFolder),
    _ => Err(AuthError::Storage(
      WorkspaceContentErrorCode::PublicationKindInvalid.as_str().to_string(),
    )),
  }
}

fn workspace_role(value: &str) -> AuthResult<WorkspaceRole> {
  match value {
    "Reader" => Ok(WorkspaceRole::Reader),
    "Commenter" => Ok(WorkspaceRole::Commenter),
    "Collaborator" => Ok(WorkspaceRole::Collaborator),
    "Manager" => Ok(WorkspaceRole::Manager),
    "Admin" => Ok(WorkspaceRole::Admin),
    "Owner" => Ok(WorkspaceRole::Owner),
    _ => Err(AuthError::Storage(
      WorkspaceContentErrorCode::InventoryInvalid.as_str().to_string(),
    )),
  }
}

fn workspace_role_name(role: WorkspaceRole) -> &'static str {
  match role {
    WorkspaceRole::External => "External",
    WorkspaceRole::Reader => "Reader",
    WorkspaceRole::Commenter => "Commenter",
    WorkspaceRole::Collaborator => "Collaborator",
    WorkspaceRole::Manager => "Manager",
    WorkspaceRole::Admin => "Admin",
    WorkspaceRole::Owner => "Owner",
  }
}

async fn load_workspace_authorization_revision(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: Uuid,
) -> AuthResult<WorkspaceContentWorkspaceRevision> {
  let row = sqlx::query(
    "SELECT owner_principal_type::text AS owner_principal_type,
            owner_principal_id, to_jsonb(workspaces) AS policy
       FROM workspaces
      WHERE id = $1 AND lifecycle_state = 'active' AND deleted_at IS NULL",
  )
  .bind(workspace_id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?
  .ok_or_else(|| {
    AuthError::NotFound(
      WorkspaceContentErrorCode::PublicationWorkspaceMissing
        .as_str()
        .to_string(),
    )
  })?;
  let principal_type = match row.get::<String, _>("owner_principal_type").as_str() {
    "user" => OwnerPrincipalType::User,
    "ou" => OwnerPrincipalType::Ou,
    "system" => OwnerPrincipalType::System,
    _ => {
      return Err(AuthError::Storage(
        WorkspaceContentErrorCode::InventoryInvalid.as_str().to_string(),
      ));
    }
  };
  let principal_id = row.get::<Option<Uuid>, _>("owner_principal_id").unwrap_or(workspace_id);
  let accepted_members = sqlx::query(
    "SELECT user_id, role FROM workspace_memberships
      WHERE workspace_id = $1 AND status = 'Accepted'
      ORDER BY user_id",
  )
  .bind(workspace_id)
  .fetch_all(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?
  .into_iter()
  .map(|member| {
    Ok(WorkspaceContentMemberRevision {
      user_id: member.get("user_id"),
      role: workspace_role(&member.get::<String, _>("role"))?,
    })
  })
  .collect::<AuthResult<Vec<_>>>()?;
  Ok(WorkspaceContentWorkspaceRevision {
    workspace_id,
    owner_principal: WorkspaceContentOwnerPrincipal {
      principal_type,
      principal_id,
    },
    policy_revision: hash_values(&[row.get("policy")])?,
    accepted_members,
  })
}

fn operation_status(value: &str) -> AuthResult<WorkspaceContentOperationStatus> {
  match value {
    "draft" => Ok(WorkspaceContentOperationStatus::Draft),
    "previewed" => Ok(WorkspaceContentOperationStatus::Previewed),
    "queued" => Ok(WorkspaceContentOperationStatus::Queued),
    "running" => Ok(WorkspaceContentOperationStatus::Running),
    "succeeded" => Ok(WorkspaceContentOperationStatus::Succeeded),
    "cancelled" => Ok(WorkspaceContentOperationStatus::Cancelled),
    "failed" => Ok(WorkspaceContentOperationStatus::Failed),
    "cleanup_required" => Ok(WorkspaceContentOperationStatus::CleanupRequired),
    _ => Err(AuthError::Storage(
      WorkspaceContentErrorCode::InventoryInvalid.as_str().to_string(),
    )),
  }
}

fn resource_kind(value: &str) -> AuthResult<WorkspaceContentResourceKind> {
  match value {
    "document" => Ok(WorkspaceContentResourceKind::Document),
    "database" => Ok(WorkspaceContentResourceKind::Database),
    "collection" => Ok(WorkspaceContentResourceKind::Collection),
    "folder" => Ok(WorkspaceContentResourceKind::Folder),
    "tag" => Ok(WorkspaceContentResourceKind::Tag),
    "blob" => Ok(WorkspaceContentResourceKind::Blob),
    _ => Err(AuthError::Storage(
      WorkspaceContentErrorCode::InventoryInvalid.as_str().to_string(),
    )),
  }
}

fn staging_status(value: &str) -> AuthResult<WorkspaceContentStagingStatus> {
  match value {
    "staged" => Ok(WorkspaceContentStagingStatus::Staged),
    "published" => Ok(WorkspaceContentStagingStatus::Published),
    "cleanup_required" => Ok(WorkspaceContentStagingStatus::CleanupRequired),
    "deleted" => Ok(WorkspaceContentStagingStatus::Deleted),
    _ => Err(AuthError::Storage(
      WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string(),
    )),
  }
}

fn error_code(value: &str) -> AuthResult<WorkspaceContentErrorCode> {
  WorkspaceContentErrorCode::parse(value)
    .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::InventoryInvalid.as_str().to_string()))
}

fn map_record(row: &sqlx::postgres::PgRow) -> AuthResult<WorkspaceContentOperationRecord> {
  let code: Option<String> = row.get("error_code");
  let message: Option<String> = row.get("error_message");
  let error = match (code, message) {
    (Some(code), Some(message)) => Some(
      RedactedWorkspaceContentError::new(error_code(&code)?, message)
        .map(|mut error| {
          error.phase = row.get("error_phase");
          error
        })
        .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::InventoryInvalid.as_str().to_string()))?,
    ),
    (None, None) => None,
    _ => {
      return Err(AuthError::Storage(
        WorkspaceContentErrorCode::InventoryInvalid.as_str().to_string(),
      ));
    }
  };
  Ok(WorkspaceContentOperationRecord {
    id: row.get("id"),
    idempotency_id: row.get("idempotency_id"),
    actor_id: row.get("actor_id"),
    kind: operation_kind(row.get::<String, _>("kind").as_str())?,
    source_workspace_id: row.get("source_workspace_id"),
    target_workspace_id: row.get("target_workspace_id"),
    status: operation_status(row.get::<String, _>("status").as_str())?,
    preview_revision: row.get("preview_revision"),
    manifest_hash: row.get("manifest_hash"),
    error,
    diagnostic_instance_id: row.get("diagnostic_instance_id"),
    created_at: row.get("created_at"),
    updated_at: row.get("updated_at"),
  })
}

fn immutable_replay_matches(
  existing: &WorkspaceContentOperationRecord,
  requested: &WorkspaceContentOperationRecord,
) -> bool {
  existing.actor_id == requested.actor_id
    && existing.kind == requested.kind
    && existing.source_workspace_id == requested.source_workspace_id
    && existing.target_workspace_id == requested.target_workspace_id
    && existing.preview_revision == requested.preview_revision
    && existing.manifest_hash.eq_ignore_ascii_case(&requested.manifest_hash)
}

fn make_resource(
  workspace_id: uuid::Uuid,
  kind: String,
  resource_id: String,
) -> AuthResult<WorkspaceContentResourceRef> {
  WorkspaceContentResourceRef::new(workspace_id, resource_kind(&kind)?, resource_id)
    .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))
}

#[async_trait]
impl WorkspaceContentOperationRepository for PgWorkspaceContentOperationRepository {
  async fn pending_git_operation_ids(&self, workspace_id: Uuid, actor_id: UserId) -> AuthResult<Vec<Uuid>> {
    sqlx::query_scalar(
      "SELECT o.id FROM workspace_content_extract_targets e
      JOIN workspace_content_operations o ON o.id=COALESCE(e.git_sync_undo_operation_id,e.operation_id)
      WHERE e.git_sync_pending AND o.status='succeeded' AND o.actor_id=$2
        AND (e.source_workspace_id=$1 OR e.target_workspace_id=$1) ORDER BY o.created_at,o.id LIMIT 32",
    )
    .bind(workspace_id)
    .bind(actor_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage)
  }
  #[instrument(skip(self, record), fields(operation_id = %record.id, actor_id = %record.actor_id))]
  async fn create_or_get(&self, record: WorkspaceContentOperationRecord) -> AuthResult<WorkspaceContentCreateResult> {
    Self::validate_record(&record)?;
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    if let Some(existing) = Self::record_by_idempotency(&mut tx, record.idempotency_id).await? {
      if !immutable_replay_matches(&existing, &record) {
        return Err(Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()));
      }
      tx.commit().await.map_err(Self::storage)?;
      return Ok(WorkspaceContentCreateResult {
        record: existing,
        created: false,
      });
    }
    Self::lock_live_parents(&mut tx, &record).await?;
    let mut workspace_ids = vec![record.source_workspace_id];
    workspace_ids.extend(record.target_workspace_id);
    let profiles: Vec<Uuid> =
      sqlx::query_scalar("SELECT id FROM git_sync_profiles WHERE workspace_id = ANY($1) ORDER BY id FOR UPDATE")
        .bind(&workspace_ids)
        .fetch_all(&mut *tx)
        .await
        .map_err(Self::storage)?;
    let rotating: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM git_sync_profiles p
       JOIN git_sync_credentials c ON c.id = p.credential_id
       JOIN git_token_rotation r ON r.profile_id = c.profile_id
       WHERE p.id = ANY($1) AND r.state = 'Rotating')",
    )
    .bind(&profiles)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::storage)?;
    if rotating {
      return Err(AuthError::InvalidInput(
        "workspace has an admitted Git-Sync token rotation".into(),
      ));
    }
    let inserted = sqlx::query(
      r#"
      INSERT INTO workspace_content_operations (
        id, idempotency_id, actor_id, kind, source_workspace_id,
        target_workspace_id, status, preview_revision, manifest_hash,
        diagnostic_instance_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT DO NOTHING
      "#,
    )
    .bind(record.id)
    .bind(record.idempotency_id)
    .bind(record.actor_id)
    .bind(record.kind.as_str())
    .bind(record.source_workspace_id)
    .bind(record.target_workspace_id)
    .bind(record.status.as_str())
    .bind(&record.preview_revision)
    .bind(&record.manifest_hash)
    .bind(&record.diagnostic_instance_id)
    .bind(record.created_at)
    .bind(record.updated_at)
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?
    .rows_affected()
      == 1;

    let durable = if inserted {
      Self::load_record(&mut tx, record.id).await?
    } else {
      let existing = Self::record_by_idempotency(&mut tx, record.idempotency_id)
        .await?
        .ok_or_else(|| Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()))?;
      if !immutable_replay_matches(&existing, &record) {
        return Err(Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()));
      }
      existing
    };
    tx.commit().await.map_err(Self::storage)?;
    Ok(WorkspaceContentCreateResult {
      record: durable,
      created: inserted,
    })
  }

  #[instrument(skip(self), fields(operation_id = %operation_id))]
  async fn get(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<Option<WorkspaceContentOperationRecord>> {
    sqlx::query(&format!("{RECORD_SELECT} WHERE id = $1"))
      .bind(operation_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::storage)?
      .map(|row| map_record(&row))
      .transpose()
  }

  #[instrument(skip(self, error), fields(operation_id = %operation_id, expected = expected.as_str(), next = next.as_str()))]
  async fn transition(
    &self,
    operation_id: WorkspaceContentOperationId,
    expected: WorkspaceContentOperationStatus,
    next: WorkspaceContentOperationStatus,
    error: Option<RedactedWorkspaceContentError>,
    diagnostic_instance_id: Option<&str>,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    if !expected.can_transition_to(next) {
      return Err(Self::invalid(
        WorkspaceContentErrorCode::PublicationStateInvalid.as_str(),
      ));
    }
    let failure_state = matches!(
      next,
      WorkspaceContentOperationStatus::Failed | WorkspaceContentOperationStatus::CleanupRequired
    ) || (expected == WorkspaceContentOperationStatus::Running
      && next == WorkspaceContentOperationStatus::Running);
    if failure_state != error.is_some()
      || diagnostic_instance_id.is_some_and(|value| !Self::validate_text(value, MAX_DIAGNOSTIC_INSTANCE_ID_BYTES))
    {
      return Err(Self::invalid(
        WorkspaceContentErrorCode::PublicationStateInvalid.as_str(),
      ));
    }
    let (error_code, error_message) = error
      .as_ref()
      .map(|error| (Some(error.code.as_str()), Some(error.message())))
      .unwrap_or((None, None));
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    if expected == WorkspaceContentOperationStatus::Failed && next == WorkspaceContentOperationStatus::Queued {
      let current = Self::load_record(&mut tx, operation_id).await?;
      if current.status == expected {
        Self::lock_live_parents(&mut tx, &current).await?;
      }
    }
    let row = sqlx::query(&format!(
      r#"
      UPDATE workspace_content_operations
      SET status = $3, error_code = $4, error_message = $5,
          diagnostic_instance_id = $6, error_phase = $7, updated_at = now()
      WHERE id = $1 AND status = $2
      RETURNING {}
      "#,
      RECORD_COLUMNS
    ))
    .bind(operation_id)
    .bind(expected.as_str())
    .bind(next.as_str())
    .bind(error_code)
    .bind(error_message)
    .bind(diagnostic_instance_id)
    .bind(error.as_ref().and_then(|error| error.phase.as_deref()))
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::storage)?;
    tx.commit().await.map_err(Self::storage)?;
    match row {
      Some(row) => map_record(&row),
      None if self.get(operation_id).await?.is_none() => Err(AuthError::NotFound(
        WorkspaceContentErrorCode::OperationMissing.as_str().to_string(),
      )),
      None => Err(publication_failure(
        WorkspaceContentErrorCode::PublicationTerminalConflict,
      )),
    }
  }

  #[instrument(skip(self, redirect), fields(operation_id = %redirect.operation_id))]
  async fn insert_redirect(&self, redirect: WorkspaceContentRedirect) -> AuthResult<bool> {
    let (source_workspace_id, target_workspace_id) = self.operation_boundaries(redirect.operation_id).await?;
    if redirect.source.kind() != redirect.target.kind()
      || redirect.source.workspace_id() != source_workspace_id
      || target_workspace_id != Some(redirect.target.workspace_id())
    {
      return Err(Self::invalid(WorkspaceContentErrorCode::MappingPlanInvalid.as_str()));
    }
    let inserted = sqlx::query(
      r#"
      INSERT INTO workspace_content_operation_redirects (
        operation_id, source_workspace_id, source_kind, source_id,
        target_workspace_id, target_kind, target_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT DO NOTHING
      "#,
    )
    .bind(redirect.operation_id)
    .bind(redirect.source.workspace_id())
    .bind(redirect.source.kind().as_str())
    .bind(redirect.source.resource_id())
    .bind(redirect.target.workspace_id())
    .bind(redirect.target.kind().as_str())
    .bind(redirect.target.resource_id())
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?
    .rows_affected()
      == 1;
    if inserted {
      return Ok(true);
    }
    let exact: bool = sqlx::query_scalar(
      r#"
      SELECT EXISTS(
        SELECT 1 FROM workspace_content_operation_redirects
        WHERE operation_id = $1 AND source_workspace_id = $2
          AND source_kind = $3 AND source_id = $4
          AND target_workspace_id = $5 AND target_kind = $6 AND target_id = $7
      )
      "#,
    )
    .bind(redirect.operation_id)
    .bind(redirect.source.workspace_id())
    .bind(redirect.source.kind().as_str())
    .bind(redirect.source.resource_id())
    .bind(redirect.target.workspace_id())
    .bind(redirect.target.kind().as_str())
    .bind(redirect.target.resource_id())
    .fetch_one(&self.pool)
    .await
    .map_err(Self::storage)?;
    if exact {
      Ok(false)
    } else {
      Err(Self::invalid(WorkspaceContentErrorCode::MappingPlanInvalid.as_str()))
    }
  }

  #[instrument(skip(self))]
  async fn list_reconcilable_operation_ids(&self, limit: usize) -> AuthResult<Vec<WorkspaceContentOperationId>> {
    if limit == 0 || limit > 1_000 {
      return Err(Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()));
    }

    sqlx::query_scalar(
      r#"
      SELECT operation_row.id
      FROM workspace_content_operations operation_row
       WHERE operation_row.status IN ('queued', 'running')
          OR (operation_row.status = 'succeeded' AND EXISTS (
            SELECT 1 FROM workspace_content_extract_targets extract
            WHERE COALESCE(extract.git_sync_undo_operation_id,extract.operation_id) = operation_row.id AND extract.git_sync_pending
              AND NOT extract.git_sync_retry_exhausted
              AND (extract.git_sync_undo_operation_id IS NOT NULL OR extract.git_sync_plan->>'choice'<>'disconnect' OR EXISTS(
                SELECT 1 FROM git_sync_runs r JOIN git_sync_profiles p ON p.id=r.profile_id
                WHERE p.id::text=extract.git_sync_plan->>'sourceProfileId' AND p.enabled AND p.sync_direction<>'GitToMyoxus'
                  AND r.status='Completed' AND NOT r.reconciliation_required AND r.finished_at>=extract.published_at
                  AND r.direction IN ('MyoxusToGit','Bidirectional')))
          ))
      ORDER BY operation_row.updated_at, operation_row.id
      LIMIT $1
      "#,
    )
    .bind(i64::try_from(limit).map_err(|_| Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()))?)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage)
  }

  async fn has_reconcilable_git_work(&self, operation_id: WorkspaceContentOperationId) -> AuthResult<bool> {
    sqlx::query_scalar(
      "SELECT EXISTS (
      SELECT 1 FROM workspace_content_extract_targets extract
      JOIN workspace_content_operations operation_row ON operation_row.id = COALESCE(extract.git_sync_undo_operation_id,extract.operation_id)
      WHERE operation_row.id = $1 AND operation_row.status = 'succeeded'
        AND extract.git_sync_pending AND NOT extract.git_sync_retry_exhausted
        AND (extract.git_sync_undo_operation_id IS NOT NULL OR extract.git_sync_plan->>'choice'<>'disconnect' OR EXISTS(
          SELECT 1 FROM git_sync_runs r JOIN git_sync_profiles p ON p.id=r.profile_id
          WHERE p.id::text=extract.git_sync_plan->>'sourceProfileId' AND p.enabled AND p.sync_direction<>'GitToMyoxus'
            AND r.status='Completed' AND NOT r.reconciliation_required AND r.finished_at>=extract.published_at
            AND r.direction IN ('MyoxusToGit','Bidirectional')))
    )",
    )
    .bind(operation_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::storage)
  }

  async fn git_work_status(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<Option<myoxus_application::workspace_content_operation::WorkspaceContentGitSyncPending>> {
    sqlx::query("SELECT git_sync_pending, git_sync_error_code, git_sync_retry_exhausted,
      jsonb_build_object('choice',plan->'choice','isUndo',COALESCE(plan->'undo','null'::jsonb)<>'null'::jsonb,
        'repository',plan->'repository','branch',plan->'branch','sourceProfileId',plan->'sourceProfileId',
        'newRoot',plan->'targetRoot','ownManifest',plan->'targetManifest','intendedEnabled',plan->'intendedEnabled') AS summary
      FROM (SELECT e.*,COALESCE(git_sync_undo_plan,git_sync_plan) AS plan FROM workspace_content_extract_targets e
        WHERE COALESCE(git_sync_undo_operation_id,operation_id) = $1 AND git_sync_plan IS NOT NULL AND published_at IS NOT NULL) e")
      .bind(operation_id).fetch_optional(&self.pool).await.map_err(Self::storage)?
      .map(|row| {
        let code: Option<String> = row.get("git_sync_error_code");
        Ok(myoxus_application::workspace_content_operation::WorkspaceContentGitSyncPending {
          summary: serde_json::from_value(row.get("summary")).map_err(|_|Self::invalid(WorkspaceContentErrorCode::InventoryInvalid.as_str()))?,
          pending: row.get("git_sync_pending"),
          error_code: code.map(|code| WorkspaceContentErrorCode::parse(&code).ok_or_else(|| Self::invalid(WorkspaceContentErrorCode::InventoryInvalid.as_str()))).transpose()?,
          retry_exhausted: row.get("git_sync_retry_exhausted"),
        })
      }).transpose()
  }

  async fn record_git_failure(
    &self,
    operation_id: WorkspaceContentOperationId,
    code: WorkspaceContentErrorCode,
    exhausted: bool,
  ) -> AuthResult<()> {
    sqlx::query(
      "UPDATE workspace_content_extract_targets SET git_sync_error_code = $2,
      git_sync_retry_exhausted = git_sync_retry_exhausted OR $3
       WHERE COALESCE(git_sync_undo_operation_id,operation_id) = $1 AND git_sync_pending AND published_at IS NOT NULL",
    )
    .bind(operation_id)
    .bind(code.as_str())
    .bind(exhausted)
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?;
    Ok(())
  }

  async fn retry_git_work(&self, operation_id: WorkspaceContentOperationId, actor_id: UserId) -> AuthResult<()> {
    let changed = sqlx::query(
      "UPDATE workspace_content_extract_targets e SET git_sync_error_code =
      CASE WHEN e.git_sync_undo_operation_id IS NULL AND e.git_sync_plan->>'choice'='disconnect' THEN 'XWS_GIT_SYNC_OUTBOUND_CLEANUP_PENDING' ELSE NULL END,
      git_sync_retry_exhausted = false FROM workspace_content_operations o
      WHERE COALESCE(e.git_sync_undo_operation_id,e.operation_id) = $1 AND o.id = $1 AND o.actor_id = $2
        AND o.status = 'succeeded' AND e.git_sync_pending AND e.published_at IS NOT NULL",
    )
    .bind(operation_id)
    .bind(actor_id)
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?
    .rows_affected();
    if changed != 1 {
      return Err(Self::invalid(WorkspaceContentErrorCode::OperationStateInvalid.as_str()));
    }
    Ok(())
  }

  #[instrument(skip(self, intent), fields(operation_id = %intent.operation_id, recipient_id = %intent.recipient_id))]
  async fn enqueue_recipient(&self, intent: WorkspaceContentRecipientIntent) -> AuthResult<bool> {
    let mut canonical_kinds = intent.visible_resource_kinds.clone();
    canonical_kinds.sort();
    canonical_kinds.dedup();
    let mut visible_resource_kinds = intent
      .visible_resource_kinds
      .iter()
      .map(|kind| kind.as_str())
      .collect::<Vec<_>>();
    visible_resource_kinds.sort_unstable();
    visible_resource_kinds.dedup();
    if intent.operation_id.is_nil()
      || intent.recipient_id.is_nil()
      || intent.source_workspace_id.is_nil()
      || intent.actor_id.is_nil()
      || intent.resource_count < 0
      || !Self::validate_text(&intent.source_workspace_name, MAX_EXTRACT_WORKSPACE_NAME_BYTES)
      || canonical_kinds != intent.visible_resource_kinds
      || (intent.resource_count == 0) != visible_resource_kinds.is_empty()
      || !Self::validate_text(&intent.event_kind, MAX_RECIPIENT_EVENT_KIND_BYTES)
      || !Self::validate_text(&intent.recipient_snapshot_revision, MAX_PREVIEW_REVISION_BYTES)
    {
      return Err(Self::invalid(
        WorkspaceContentErrorCode::RecipientBindingInvalid.as_str(),
      ));
    }
    let inserted = sqlx::query(
      r#"
      INSERT INTO workspace_content_operation_recipient_outbox (
        operation_id, recipient_id, event_kind, resource_count,
        visible_resource_kinds, recipient_snapshot_revision,
        source_workspace_id, source_workspace_name, actor_id, published_at
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, now()
      FROM workspace_content_operations operation_row
      WHERE operation_row.id = $1
        AND operation_row.source_workspace_id = $7
        AND operation_row.actor_id = $9
      ON CONFLICT DO NOTHING
      "#,
    )
    .bind(intent.operation_id)
    .bind(intent.recipient_id)
    .bind(&intent.event_kind)
    .bind(intent.resource_count)
    .bind(&visible_resource_kinds)
    .bind(&intent.recipient_snapshot_revision)
    .bind(intent.source_workspace_id)
    .bind(&intent.source_workspace_name)
    .bind(intent.actor_id)
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?
    .rows_affected()
      == 1;
    if inserted {
      return Ok(true);
    }
    let exact: bool = sqlx::query_scalar(
      r#"
      SELECT EXISTS(
        SELECT 1 FROM workspace_content_operation_recipient_outbox
        WHERE operation_id = $1 AND recipient_id = $2 AND event_kind = $3
          AND resource_count = $4 AND visible_resource_kinds = $5
          AND recipient_snapshot_revision = $6
          AND source_workspace_id = $7 AND source_workspace_name = $8
          AND actor_id = $9
      )
      "#,
    )
    .bind(intent.operation_id)
    .bind(intent.recipient_id)
    .bind(&intent.event_kind)
    .bind(intent.resource_count)
    .bind(&visible_resource_kinds)
    .bind(&intent.recipient_snapshot_revision)
    .bind(intent.source_workspace_id)
    .bind(&intent.source_workspace_name)
    .bind(intent.actor_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::storage)?;
    if exact {
      Ok(false)
    } else {
      Err(Self::invalid(
        WorkspaceContentErrorCode::RecipientBindingInvalid.as_str(),
      ))
    }
  }

  #[instrument(skip(self, intent), fields(operation_id = %intent.operation_id, sequence = intent.sequence))]
  async fn append_compensation(&self, intent: WorkspaceContentCompensationIntent) -> AuthResult<bool> {
    let (source_workspace_id, target_workspace_id) = self.operation_boundaries(intent.operation_id).await?;
    if intent.operation_id.is_nil()
      || intent.sequence < 0
      || !Self::validate_text(&intent.kind, MAX_COMPENSATION_KIND_BYTES)
      || !Self::resource_belongs_to_operation(&intent.target, source_workspace_id, target_workspace_id)
    {
      return Err(Self::invalid(
        WorkspaceContentErrorCode::StagingManifestInvalid.as_str(),
      ));
    }
    let inserted = sqlx::query(
      r#"
      INSERT INTO workspace_content_operation_compensations (
        operation_id, sequence, kind, target_workspace_id, target_kind, target_id
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT DO NOTHING
      "#,
    )
    .bind(intent.operation_id)
    .bind(intent.sequence)
    .bind(&intent.kind)
    .bind(intent.target.workspace_id())
    .bind(intent.target.kind().as_str())
    .bind(intent.target.resource_id())
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?
    .rows_affected()
      == 1;
    if inserted {
      return Ok(true);
    }
    let exact: bool = sqlx::query_scalar(
      r#"
      SELECT EXISTS(
        SELECT 1 FROM workspace_content_operation_compensations
        WHERE operation_id = $1 AND sequence = $2 AND kind = $3
          AND target_workspace_id = $4 AND target_kind = $5 AND target_id = $6
      )
      "#,
    )
    .bind(intent.operation_id)
    .bind(intent.sequence)
    .bind(&intent.kind)
    .bind(intent.target.workspace_id())
    .bind(intent.target.kind().as_str())
    .bind(intent.target.resource_id())
    .fetch_one(&self.pool)
    .await
    .map_err(Self::storage)?;
    if exact {
      Ok(false)
    } else {
      Err(Self::invalid(WorkspaceContentErrorCode::StagingReplayConflict.as_str()))
    }
  }
}

#[async_trait]
impl WorkspaceContentControlRepository for PgWorkspaceContentOperationRepository {
  async fn store_git_undo_plan(
    &self,
    operation_id: Uuid,
    plan: Option<&WorkspaceContentGitSyncPlan>,
  ) -> AuthResult<()> {
    let plan = plan
      .map(serde_json::to_value)
      .transpose()
      .map_err(|_| Self::invalid(WorkspaceContentErrorCode::EncodingFailed.as_str()))?;
    let changed = sqlx::query(
      "UPDATE workspace_content_operation_requests SET git_sync_undo_plan=$2
      WHERE operation_id=$1 AND (git_sync_undo_plan IS NULL OR git_sync_undo_plan IS NOT DISTINCT FROM $2)",
    )
    .bind(operation_id)
    .bind(plan)
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?
    .rows_affected();
    if changed != 1 {
      return Err(Self::invalid(WorkspaceContentErrorCode::PreflightStale.as_str()));
    }
    Ok(())
  }
  #[instrument(skip(self, request), fields(operation_id = %operation_id))]
  async fn store_request(
    &self,
    operation_id: WorkspaceContentOperationId,
    request: &WorkspaceContentOperationRequest,
    origin_operation_id: Option<WorkspaceContentOperationId>,
  ) -> AuthResult<()> {
    let value =
      serde_json::to_value(request).map_err(|_| Self::invalid(WorkspaceContentErrorCode::EncodingFailed.as_str()))?;
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    let operation = Self::load_record(&mut tx, operation_id).await?;
    if operation.kind != request.kind
      || operation.source_workspace_id != request.source_workspace_id
      || (operation.kind != WorkspaceContentOperationKind::ExtractFolder
        && operation.target_workspace_id != Some(request.target_workspace_id))
      || origin_operation_id == Some(operation_id)
    {
      return Err(Self::invalid(WorkspaceContentErrorCode::MappingPlanInvalid.as_str()));
    }
    let inserted = sqlx::query(
      "INSERT INTO workspace_content_operation_requests
         (operation_id, request, origin_operation_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING",
    )
    .bind(operation_id)
    .bind(&value)
    .bind(origin_operation_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?
    .rows_affected()
      == 1;
    if !inserted {
      let row = sqlx::query(
        "SELECT request, origin_operation_id
           FROM workspace_content_operation_requests
          WHERE operation_id = $1",
      )
      .bind(operation_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::storage)?;
      if row.get::<serde_json::Value, _>("request") != value
        || row.get::<Option<Uuid>, _>("origin_operation_id") != origin_operation_id
      {
        return Err(Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()));
      }
    }
    tx.commit().await.map_err(Self::storage)
  }

  async fn load_request(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<Option<(WorkspaceContentOperationRequest, Option<WorkspaceContentOperationId>)>> {
    sqlx::query(
      "SELECT request, origin_operation_id
         FROM workspace_content_operation_requests
        WHERE operation_id = $1",
    )
    .bind(operation_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?
    .map(|row| {
      let request = serde_json::from_value(row.get("request"))
        .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::RequestInvalid.as_str().to_string()))?;
      Ok((request, row.get("origin_operation_id")))
    })
    .transpose()
  }

  #[instrument(skip(self, request), fields(operation_id = %request.operation_id, actor_id = %request.actor_id))]
  async fn queue_previewed(
    &self,
    request: &WorkspaceContentExecuteRequest,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    if request.operation_id.is_nil()
      || request.actor_id.is_nil()
      || !Self::validate_text(&request.revision, MAX_PREVIEW_REVISION_BYTES)
    {
      return Err(Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()));
    }
    let row = sqlx::query(&format!(
      "UPDATE workspace_content_operations
          SET status = 'queued', updated_at = now()
        WHERE id = $1 AND actor_id = $2 AND status = 'previewed'
          AND preview_revision = $3
        RETURNING {RECORD_COLUMNS}"
    ))
    .bind(request.operation_id)
    .bind(request.actor_id)
    .bind(&request.revision)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?;
    match row {
      Some(row) => map_record(&row),
      None => Err(AuthError::NotFound(
        WorkspaceContentErrorCode::OperationMissing.as_str().to_string(),
      )),
    }
  }

  async fn store_execution_memberships(
    &self,
    operation_id: WorkspaceContentOperationId,
    memberships: &[WorkspaceContentExecutionMembership],
  ) -> AuthResult<()> {
    let mut canonical = memberships.to_vec();
    canonical.sort_by_key(|membership| membership.user_id);
    canonical.dedup_by_key(|membership| membership.user_id);
    if canonical != memberships
      || canonical
        .iter()
        .any(|membership| membership.user_id.is_nil() || membership.role == WorkspaceRole::Owner)
    {
      return Err(Self::invalid(WorkspaceContentErrorCode::InventoryInvalid.as_str()));
    }
    let value = serde_json::to_value(&canonical)
      .map_err(|_| Self::invalid(WorkspaceContentErrorCode::EncodingFailed.as_str()))?;
    let affected = sqlx::query(
      "UPDATE workspace_content_operation_requests request_row
          SET execution_memberships = $2
         FROM workspace_content_operations operation_row
        WHERE request_row.operation_id = $1
          AND operation_row.id = request_row.operation_id
          AND operation_row.status = 'previewed'
          AND (
            request_row.execution_memberships = '[]'::jsonb
            OR request_row.execution_memberships = $2
          )",
    )
    .bind(operation_id)
    .bind(value)
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?
    .rows_affected();
    if affected == 1 {
      Ok(())
    } else {
      Err(publication_failure(
        WorkspaceContentErrorCode::WorkspaceContentTargetMembershipChanged,
      ))
    }
  }

  #[instrument(skip(self), fields(operation_id = %operation_id, actor_id = %actor_id))]
  async fn cancel_unpublished(
    &self,
    operation_id: WorkspaceContentOperationId,
    actor_id: UserId,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    let row = sqlx::query(&format!(
      "UPDATE workspace_content_operations operation_row
          SET status = 'cancelled', error_code = NULL, error_message = NULL, error_phase = NULL,
              diagnostic_instance_id = NULL, updated_at = now()
        WHERE operation_row.id = $1 AND operation_row.actor_id = $2
          AND operation_row.status IN ('draft', 'previewed', 'queued', 'running')
          AND NOT EXISTS (
            SELECT 1 FROM workspace_content_move_publications published
             WHERE published.operation_id = operation_row.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM workspace_content_copy_publications published
             WHERE published.operation_id = operation_row.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM workspace_content_link_publications published
             WHERE published.operation_id = operation_row.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM workspace_content_extract_publications published
             WHERE published.operation_id = operation_row.id
          )
        RETURNING {RECORD_COLUMNS}"
    ))
    .bind(operation_id)
    .bind(actor_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?;
    match row {
      Some(row) => map_record(&row),
      None => Err(AuthError::NotFound(
        WorkspaceContentErrorCode::OperationMissing.as_str().to_string(),
      )),
    }
  }

  async fn cancelled_private_blob_targets(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<Vec<WorkspaceContentResourceRef>> {
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    let operation = Self::load_record(&mut tx, operation_id).await?;
    if operation.status != WorkspaceContentOperationStatus::Cancelled
      && !(operation.status == WorkspaceContentOperationStatus::CleanupRequired
        && operation
          .error
          .as_ref()
          .is_some_and(RedactedWorkspaceContentError::is_cancellation_cleanup))
    {
      return Err(Self::invalid(
        WorkspaceContentErrorCode::PublicationStateInvalid.as_str(),
      ));
    }
    let rows = sqlx::query(
      "SELECT target_workspace_id, target_id FROM workspace_content_operation_compensations intent
       WHERE operation_id=$1 AND kind='delete_operation_blob' AND target_kind='blob'
         AND NOT EXISTS(SELECT 1 FROM blobs WHERE workspace_id=intent.target_workspace_id AND key=intent.target_id AND deleted_at IS NULL)
         AND NOT EXISTS(SELECT 1 FROM workspace_content_copy_publications WHERE operation_id=$1)
         AND NOT EXISTS(SELECT 1 FROM workspace_content_move_publications WHERE operation_id=$1)
         AND NOT EXISTS(SELECT 1 FROM workspace_content_extract_publications WHERE operation_id=$1)
       ORDER BY sequence")
      .bind(operation_id).fetch_all(&mut *tx).await.map_err(Self::storage)?;
    let targets = rows
      .into_iter()
      .map(|row| make_resource(row.get("target_workspace_id"), "blob".into(), row.get("target_id")))
      .collect::<AuthResult<Vec<_>>>()?;
    tx.commit().await.map_err(Self::storage)?;
    Ok(targets)
  }

  async fn retry_failed(
    &self,
    operation_id: WorkspaceContentOperationId,
    actor_id: UserId,
    revision: &str,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    let current = Self::load_record(&mut tx, operation_id).await?;
    if current.actor_id != actor_id
      || current.status != WorkspaceContentOperationStatus::Failed
      || current.preview_revision.as_deref() != Some(revision)
    {
      return Err(AuthError::NotFound(
        WorkspaceContentErrorCode::OperationMissing.as_str().into(),
      ));
    }
    Self::lock_live_parents(&mut tx, &current).await?;
    let row = sqlx::query(&format!(
      "UPDATE workspace_content_operations
          SET status = 'queued', error_code = NULL, error_message = NULL, error_phase = NULL,
              diagnostic_instance_id = NULL, updated_at = now()
        WHERE id = $1 AND actor_id = $2 AND status = 'failed'
          AND preview_revision = $3
        RETURNING {RECORD_COLUMNS}"
    ))
    .bind(operation_id)
    .bind(actor_id)
    .bind(revision)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::storage)?;
    tx.commit().await.map_err(Self::storage)?;
    row
      .map(|row| map_record(&row))
      .transpose()?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))
  }

  async fn mark_cancel_cleanup_required(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    let error = RedactedWorkspaceContentError::new(
      WorkspaceContentErrorCode::CancellationCleanupRequired,
      "The cancelled operation still requires cleanup of unpublished staging.",
    )
    .map_err(|_| Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()))?
    .with_phase("compensation");
    self
      .transition(
        operation_id,
        WorkspaceContentOperationStatus::Cancelled,
        WorkspaceContentOperationStatus::CleanupRequired,
        Some(error),
        None,
      )
      .await
  }

  async fn complete_cancel_cleanup(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    let row = sqlx::query(&format!(
      "UPDATE workspace_content_operations
          SET status = 'cancelled', error_code = NULL, error_message = NULL, error_phase = NULL,
              diagnostic_instance_id = NULL, updated_at = now()
        WHERE id = $1 AND status = 'cleanup_required'
          AND (error_code = 'XWS_CANCELLATION_CLEANUP_REQUIRED' OR (error_code = 'XWS_WORKER_EXECUTION_FAILED' AND error_message = 'workspace content cancellation cleanup requires retry'))
        RETURNING {RECORD_COLUMNS}"
    ))
    .bind(operation_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?;
    row
      .map(|row| map_record(&row))
      .transpose()?
      .ok_or_else(|| Self::invalid(WorkspaceContentErrorCode::PublicationStateInvalid.as_str()))
  }

  async fn mark_staging_deleted(&self, operation_id: WorkspaceContentOperationId) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    let status: String = sqlx::query_scalar("SELECT status FROM workspace_content_operations WHERE id = $1 FOR UPDATE")
      .bind(operation_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::storage)?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))?;
    if !matches!(status.as_str(), "cancelled" | "cleanup_required") {
      return Err(Self::invalid(
        WorkspaceContentErrorCode::PublicationStateInvalid.as_str(),
      ));
    }
    sqlx::query(
      "UPDATE workspace_content_operation_staging
          SET publication_status = 'deleted', updated_at = now()
        WHERE operation_id = $1 AND publication_status <> 'published'",
    )
    .bind(operation_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?;
    tx.commit().await.map_err(Self::storage)
  }

  async fn resume_cleanup_required(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    let row = sqlx::query(&format!(
      "UPDATE workspace_content_operations
          SET status = CASE WHEN kind = 'extract_folder' THEN status ELSE 'running' END,
              error_phase = CASE WHEN kind = 'extract_folder' THEN error_phase ELSE NULL END,
              error_code = CASE WHEN kind = 'extract_folder' THEN error_code ELSE NULL END,
              error_message = CASE WHEN kind = 'extract_folder' THEN error_message ELSE NULL END,
              diagnostic_instance_id = NULL, updated_at = now()
        WHERE id = $1 AND status = 'cleanup_required'
          AND NOT (error_code = 'XWS_CANCELLATION_CLEANUP_REQUIRED' OR (error_code = 'XWS_WORKER_EXECUTION_FAILED' AND error_message = 'workspace content cancellation cleanup requires retry'))
        RETURNING {RECORD_COLUMNS}"
    ))
    .bind(operation_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?;
    row
      .map(|row| map_record(&row))
      .transpose()?
      .ok_or_else(|| Self::invalid(WorkspaceContentErrorCode::PublicationStateInvalid.as_str()))
  }
}

#[async_trait]
impl WorkspaceContentNotificationOutboxPort for PgWorkspaceContentOperationRepository {
  #[instrument(skip(self))]
  async fn claim(&self, limit: usize) -> AuthResult<Vec<WorkspaceContentNotificationIntent>> {
    if limit == 0 || limit > 100 {
      return Err(Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()));
    }
    let rows = sqlx::query(
      r#"
      WITH candidates AS (
        SELECT id
          FROM workspace_content_operation_recipient_outbox
         WHERE (
           status IN ('pending', 'failed')
           OR (status = 'processing' AND lease_expires_at < now())
         )
           AND attempt_count < 10
         ORDER BY created_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE workspace_content_operation_recipient_outbox outbox
         SET status = 'processing',
             attempt_count = outbox.attempt_count + 1,
             lease_expires_at = now() + interval '2 minutes',
             last_error = NULL,
             updated_at = now()
        FROM candidates
       WHERE outbox.id = candidates.id
      RETURNING outbox.id, outbox.operation_id, outbox.recipient_id,
                outbox.event_kind, outbox.resource_count,
                outbox.visible_resource_kinds, outbox.source_workspace_id,
                outbox.source_workspace_name, outbox.actor_id,
                outbox.published_at
      "#,
    )
    .bind(i64::try_from(limit).map_err(|_| Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()))?)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage)?;
    rows
      .into_iter()
      .map(|row| {
        let visible_resource_kinds = row
          .get::<Vec<String>, _>("visible_resource_kinds")
          .into_iter()
          .map(|kind| resource_kind(&kind))
          .collect::<AuthResult<Vec<_>>>()?;
        Ok(WorkspaceContentNotificationIntent {
          id: row.get("id"),
          operation_id: row.get("operation_id"),
          recipient_id: row.get("recipient_id"),
          event_kind: row.get("event_kind"),
          source_workspace_id: row.get("source_workspace_id"),
          source_workspace_name: row.get("source_workspace_name"),
          actor_id: row.get("actor_id"),
          published_at: row.get("published_at"),
          resource_count: row.get("resource_count"),
          visible_resource_kinds,
        })
      })
      .collect()
  }

  async fn mark_dispatched(&self, intent_id: i64) -> AuthResult<()> {
    let affected = sqlx::query(
      "UPDATE workspace_content_operation_recipient_outbox
          SET status = 'dispatched', dispatched_at = now(),
              lease_expires_at = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'processing'",
    )
    .bind(intent_id)
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?
    .rows_affected();
    if affected == 1 {
      Ok(())
    } else {
      Err(Self::invalid(
        WorkspaceContentErrorCode::RecipientBindingInvalid.as_str(),
      ))
    }
  }

  async fn mark_failed(&self, intent_id: i64, reason: &'static str) -> AuthResult<()> {
    if !Self::validate_text(reason, 512) {
      return Err(Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()));
    }
    let affected = sqlx::query(
      "UPDATE workspace_content_operation_recipient_outbox
          SET status = 'failed', lease_expires_at = NULL,
              last_error = $2, updated_at = now()
        WHERE id = $1 AND status = 'processing'",
    )
    .bind(intent_id)
    .bind(reason)
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?
    .rows_affected();
    if affected == 1 {
      Ok(())
    } else {
      Err(Self::invalid(
        WorkspaceContentErrorCode::RecipientBindingInvalid.as_str(),
      ))
    }
  }
}

#[async_trait]
impl WorkspaceContentLinkIntentRepository for PgWorkspaceContentOperationRepository {
  #[instrument(skip(self, intent), fields(operation_id = %intent.operation_id))]
  async fn store_link_intent(&self, intent: WorkspaceContentLinkIntent) -> AuthResult<bool> {
    if intent.operation_id.is_nil()
      || !Self::validate_text(&intent.entry_id, MAX_ORGANIZER_ENTRY_ID_BYTES)
      || !Self::validate_text(&intent.parent_id, MAX_ORGANIZER_ENTRY_ID_BYTES)
      || !Self::validate_text(&intent.index, MAX_ORGANIZER_INDEX_BYTES)
      || !Self::validate_text(&intent.organizer_revision, MAX_PREVIEW_REVISION_BYTES)
      || intent.entry_id.trim() != intent.entry_id
      || intent.parent_id.trim() != intent.parent_id
      || intent.index.trim() != intent.index
      || matches!(
        intent.target.kind(),
        WorkspaceContentResourceKind::Blob | WorkspaceContentResourceKind::Folder
      )
    {
      return Err(Self::invalid(WorkspaceContentErrorCode::MappingPlanInvalid.as_str()));
    }
    let operation = sqlx::query(
      r#"
      SELECT kind, source_workspace_id, target_workspace_id, status
      FROM workspace_content_operations
      WHERE id = $1
      "#,
    )
    .bind(intent.operation_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?
    .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))?;
    if operation_kind(operation.get::<String, _>("kind").as_str())? != WorkspaceContentOperationKind::Link
      || operation.get::<uuid::Uuid, _>("source_workspace_id") != intent.target.workspace_id()
      || operation.get::<Option<uuid::Uuid>, _>("target_workspace_id").is_none()
      || !matches!(
        operation_status(operation.get::<String, _>("status").as_str())?,
        WorkspaceContentOperationStatus::Draft | WorkspaceContentOperationStatus::Previewed
      )
    {
      return Err(Self::invalid(WorkspaceContentErrorCode::MappingPlanInvalid.as_str()));
    }
    let inserted = sqlx::query(
      r#"
      INSERT INTO workspace_content_operation_link_intents (
        operation_id, entry_id, parent_id, organizer_index, organizer_revision,
        target_workspace_id, target_kind, target_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT DO NOTHING
      "#,
    )
    .bind(intent.operation_id)
    .bind(&intent.entry_id)
    .bind(&intent.parent_id)
    .bind(&intent.index)
    .bind(&intent.organizer_revision)
    .bind(intent.target.workspace_id())
    .bind(intent.target.kind().as_str())
    .bind(intent.target.resource_id())
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?
    .rows_affected()
      == 1;
    if inserted {
      return Ok(true);
    }
    let exact: bool = sqlx::query_scalar(
      r#"
      SELECT EXISTS(
        SELECT 1
        FROM workspace_content_operation_link_intents
        WHERE operation_id = $1 AND entry_id = $2 AND parent_id = $3
          AND organizer_index = $4 AND organizer_revision = $5
          AND target_workspace_id = $6 AND target_kind = $7 AND target_id = $8
      )
      "#,
    )
    .bind(intent.operation_id)
    .bind(&intent.entry_id)
    .bind(&intent.parent_id)
    .bind(&intent.index)
    .bind(&intent.organizer_revision)
    .bind(intent.target.workspace_id())
    .bind(intent.target.kind().as_str())
    .bind(intent.target.resource_id())
    .fetch_one(&self.pool)
    .await
    .map_err(Self::storage)?;
    if exact {
      Ok(false)
    } else {
      Err(Self::invalid(WorkspaceContentErrorCode::MappingPlanInvalid.as_str()))
    }
  }

  async fn get_link_intent(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<Option<WorkspaceContentLinkIntent>> {
    let row = sqlx::query(
      r#"
      SELECT entry_id, parent_id, organizer_index, organizer_revision,
             target_workspace_id, target_kind, target_id
      FROM workspace_content_operation_link_intents
      WHERE operation_id = $1
      "#,
    )
    .bind(operation_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?;
    row
      .map(|row| {
        Ok(WorkspaceContentLinkIntent {
          operation_id,
          entry_id: row.get("entry_id"),
          parent_id: row.get("parent_id"),
          index: row.get("organizer_index"),
          organizer_revision: row.get("organizer_revision"),
          target: make_resource(
            row.get("target_workspace_id"),
            row.get("target_kind"),
            row.get("target_id"),
          )?,
        })
      })
      .transpose()
  }
}

#[async_trait]
impl WorkspaceContentLinkPublicationPort for PgWorkspaceContentOperationRepository {
  #[instrument(skip(self, batch), fields(operation_id = %batch.operation.id))]
  async fn publish_link(
    &self,
    batch: WorkspaceContentLinkPublicationBatch,
    diagnostic_instance_id: &str,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    if !Self::validate_text(diagnostic_instance_id, MAX_DIAGNOSTIC_INSTANCE_ID_BYTES) {
      return Err(Self::invalid(
        WorkspaceContentErrorCode::DiagnosticInstanceInvalid.as_str(),
      ));
    }
    if batch.intent.target.kind() == WorkspaceContentResourceKind::Collection {
      return Err(Self::invalid(
        WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str(),
      ));
    }
    let target_workspace_id = batch
      .operation
      .target_workspace_id
      .ok_or_else(|| Self::invalid(WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str()))?;
    if batch.operation.kind != WorkspaceContentOperationKind::Link
      || batch.operation.status != WorkspaceContentOperationStatus::Running
      || batch.intent.operation_id != batch.operation.id
      || batch.intent.target.workspace_id() != batch.operation.source_workspace_id
      || batch.organizer.row.id != batch.intent.entry_id
      || batch.organizer.row.parent_id.as_deref() != Some(batch.intent.parent_id.as_str())
      || batch.organizer.row.index != batch.intent.index
      || batch.organizer.revision != batch.intent.organizer_revision
      || batch.organizer.row.data != batch.intent.target.resource_id()
      || batch.organizer.row.target_workspace_id != Some(batch.intent.target.workspace_id())
    {
      return Err(Self::invalid(WorkspaceContentErrorCode::MappingPlanInvalid.as_str()));
    }

    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    let current = sqlx::query(&format!("{RECORD_SELECT} WHERE id = $1 FOR UPDATE"))
      .bind(batch.operation.id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::storage)?
      .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))
      .and_then(|row| map_record(&row))?;

    if let Some(receipt) = sqlx::query(
      "SELECT target_workspace_id, organizer_revision, organizer_sequence, entry_id
       FROM workspace_content_link_publications WHERE operation_id = $1",
    )
    .bind(batch.operation.id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::storage)?
    {
      if current.status == WorkspaceContentOperationStatus::Succeeded
        && receipt.get::<Uuid, _>("target_workspace_id") == target_workspace_id
        && receipt.get::<String, _>("organizer_revision") == batch.organizer.revision
        && receipt.get::<String, _>("entry_id") == batch.intent.entry_id
      {
        tx.commit().await.map_err(Self::storage)?;
        return Ok(current);
      }
      return Err(publication_failure(
        WorkspaceContentErrorCode::PublicationTerminalConflict,
      ));
    }
    if current != batch.operation {
      return Err(Self::invalid(
        WorkspaceContentErrorCode::PublicationTerminalConflict.as_str(),
      ));
    }

    let request_value: serde_json::Value =
      sqlx::query_scalar("SELECT request FROM workspace_content_operation_requests WHERE operation_id = $1")
        .bind(batch.operation.id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::storage)?
        .ok_or_else(|| Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()))?;
    let request: WorkspaceContentOperationRequest = serde_json::from_value(request_value)
      .map_err(|_| Self::invalid(WorkspaceContentErrorCode::RequestInvalid.as_str()))?;
    // An older first-closure-member intent must not publish a different selected resource.
    if request.kind != WorkspaceContentOperationKind::Link
      || request.source_workspace_id != batch.operation.source_workspace_id
      || request.target_workspace_id != target_workspace_id
      || !matches!(&request.selection, WorkspaceContentOperationSelection::Resources { resources }
        if resources.as_slice() == std::slice::from_ref(&batch.intent.target))
    {
      return Err(publication_failure(WorkspaceContentErrorCode::RequestInvalid));
    }

    let intent_exact: bool = sqlx::query_scalar(
      "SELECT EXISTS(
         SELECT 1 FROM workspace_content_operation_link_intents
         WHERE operation_id = $1 AND entry_id = $2 AND parent_id = $3
           AND organizer_index = $4 AND organizer_revision = $5
           AND target_workspace_id = $6 AND target_kind = $7 AND target_id = $8
       )",
    )
    .bind(batch.operation.id)
    .bind(&batch.intent.entry_id)
    .bind(&batch.intent.parent_id)
    .bind(&batch.intent.index)
    .bind(&batch.intent.organizer_revision)
    .bind(batch.intent.target.workspace_id())
    .bind(batch.intent.target.kind().as_str())
    .bind(batch.intent.target.resource_id())
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::storage)?;
    if !intent_exact {
      return Err(publication_failure(WorkspaceContentErrorCode::MappingPlanInvalid));
    }

    let organizer_resource = WorkspaceContentResourceRef::new(
      target_workspace_id,
      WorkspaceContentResourceKind::Document,
      format!("db${target_workspace_id}$folders"),
    )
    .map_err(|_| Self::invalid(WorkspaceContentErrorCode::OrganizerTargetInvalid.as_str()))?;
    let resources = vec![batch.intent.target.clone(), organizer_resource];

    let organizer_sequence = if batch.organizer.update.is_empty() {
      None
    } else {
      let doc_id = ensure_system_document(
        &mut tx,
        batch.operation.id,
        target_workspace_id,
        &format!("db${target_workspace_id}$folders"),
        batch.operation.actor_id,
      )
      .await?;
      let sequence = append_copy_update(&mut tx, doc_id, target_workspace_id, &batch.organizer.update).await?;
      sqlx::query(
        "INSERT INTO outbox_events
           (id, aggregate_type, aggregate_id, event_type, payload, created_at)
         VALUES ($1, 'doc', $2, 'workspace_doc_broadcast', $3, now())
         ON CONFLICT (id) DO NOTHING",
      )
      .bind(Uuid::new_v5(
        &batch.operation.id,
        format!("workspace-doc-broadcast:{target_workspace_id}:{doc_id}:{sequence}").as_bytes(),
      ))
      .bind(doc_id.to_string())
      .bind(serde_json::json!({
        "workspaceId": target_workspace_id,
        "docId": doc_id,
        "sequence": sequence,
        "actorUserId": batch.operation.actor_id,
      }))
      .execute(&mut *tx)
      .await
      .map_err(Self::storage)?;
      Some(sequence)
    };

    sqlx::query(
      "INSERT INTO outbox_events
         (id, aggregate_type, aggregate_id, event_type, payload, created_at)
       VALUES ($1, 'workspace_content_operation', $2, 'workspace_content_published', $3, now())
       ON CONFLICT (id) DO NOTHING",
    )
    .bind(Uuid::new_v5(&batch.operation.id, b"workspace-content-published"))
    .bind(batch.operation.id.to_string())
    .bind(serde_json::json!({
      "operationId": batch.operation.id,
      "targetWorkspaceId": target_workspace_id,
      "resources": resources,
    }))
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?;
    sqlx::query(
      "INSERT INTO workspace_content_link_publications
         (operation_id, target_workspace_id, organizer_revision, organizer_sequence,
          entry_id, diagnostic_instance_id)
       VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(batch.operation.id)
    .bind(target_workspace_id)
    .bind(&batch.organizer.revision)
    .bind(organizer_sequence)
    .bind(&batch.intent.entry_id)
    .bind(diagnostic_instance_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?;
    let row = sqlx::query(&format!(
      "UPDATE workspace_content_operations
       SET status = 'succeeded', diagnostic_instance_id = $2,
           error_code = NULL, error_message = NULL, error_phase = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running'
       RETURNING {RECORD_COLUMNS}"
    ))
    .bind(batch.operation.id)
    .bind(diagnostic_instance_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::storage)?
    .ok_or_else(|| Self::invalid(WorkspaceContentErrorCode::PublicationTerminalConflict.as_str()))?;
    let record = map_record(&row)?;
    tx.commit().await.map_err(Self::storage)?;
    Ok(record)
  }
}

#[async_trait]
impl WorkspaceContentRecipientSnapshotPort for PgWorkspaceContentOperationRepository {
  #[instrument(skip(self), fields(%source_workspace_id, %actor_id))]
  async fn recipient_snapshot(
    &self,
    source_workspace_id: Uuid,
    actor_id: Uuid,
  ) -> AuthResult<WorkspaceContentRecipientSnapshot> {
    let source_workspace_name: String =
      sqlx::query_scalar("SELECT name FROM workspaces WHERE id = $1 AND deleted_at IS NULL")
        .bind(source_workspace_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::storage)?
        .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::SourceWorkspaceMissing.as_str().to_string()))?;
    let rows = sqlx::query(
      "SELECT user_id, role
       FROM workspace_memberships
       WHERE workspace_id = $1 AND status = 'Accepted'
       ORDER BY user_id",
    )
    .bind(source_workspace_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage)?;
    let mut recipients = rows
      .into_iter()
      .map(|row| (row.get::<Uuid, _>("user_id"), row.get::<String, _>("role")))
      .collect::<Vec<_>>();
    if !recipients.iter().any(|(user_id, _)| *user_id == actor_id) {
      let actor_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(actor_id)
        .fetch_one(&self.pool)
        .await
        .map_err(Self::storage)?;
      if !actor_exists {
        return Err(AuthError::NotFound(
          WorkspaceContentErrorCode::TransferForbidden.as_str().to_string(),
        ));
      }
      recipients.push((actor_id, "Actor".to_string()));
      recipients.sort_by_key(|(user_id, _)| *user_id);
    }
    Ok(WorkspaceContentRecipientSnapshot {
      revision: move_recipient_snapshot_revision(source_workspace_id, &source_workspace_name, &recipients),
      source_workspace_name,
      recipient_ids: recipients.into_iter().map(|(user_id, _)| user_id).collect(),
    })
  }
}

#[async_trait]
impl WorkspaceContentStagingManifestRepository for PgWorkspaceContentOperationRepository {
  #[instrument(skip(self, mappings, entries), fields(operation_id = %operation_id, mapping_count = mappings.len(), staging_count = entries.len()))]
  async fn store_manifest(
    &self,
    operation_id: WorkspaceContentOperationId,
    manifest_hash: &str,
    mappings: &[WorkspaceContentIdMapping],
    entries: &[WorkspaceContentStagingEntry],
  ) -> AuthResult<()> {
    if operation_id.is_nil() || !Self::valid_sha256(manifest_hash) {
      return Err(Self::invalid(
        WorkspaceContentErrorCode::StagingManifestInvalid.as_str(),
      ));
    }
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    let operation = sqlx::query(
      r#"
      SELECT kind, manifest_hash, status, source_workspace_id, target_workspace_id
      FROM workspace_content_operations
      WHERE id = $1
      FOR UPDATE
      "#,
    )
    .bind(operation_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::storage)?
    .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))?;
    let durable_hash: String = operation.get("manifest_hash");
    let kind = operation_kind(operation.get::<String, _>("kind").as_str())?;
    let status = operation_status(operation.get::<String, _>("status").as_str())?;
    let source_workspace_id: uuid::Uuid = operation.get("source_workspace_id");
    let target_workspace_id: Option<uuid::Uuid> = operation.get("target_workspace_id");
    if !durable_hash.eq_ignore_ascii_case(manifest_hash)
      || !(matches!(
        status,
        WorkspaceContentOperationStatus::Draft | WorkspaceContentOperationStatus::Previewed
      ) || status == WorkspaceContentOperationStatus::Running
        && matches!(
          kind,
          WorkspaceContentOperationKind::Copy | WorkspaceContentOperationKind::ExtractFolder
        ))
    {
      return Err(Self::invalid(WorkspaceContentErrorCode::StagingReplayConflict.as_str()));
    }

    for mapping in mappings {
      let valid_boundary = if kind == WorkspaceContentOperationKind::Link {
        // Link publishes only an Organizer reference. It deliberately keeps
        // the qualified source identity instead of materializing a resource
        // in the destination workspace.
        mapping.source == mapping.target
      } else {
        target_workspace_id == Some(mapping.target.workspace_id())
      };
      if mapping.source.workspace_id() != source_workspace_id || !valid_boundary {
        return Err(Self::invalid(WorkspaceContentErrorCode::MappingPlanInvalid.as_str()));
      }
      let result = sqlx::query(
        r#"
        INSERT INTO workspace_content_operation_mappings (
          operation_id, source_workspace_id, source_kind, source_id,
          target_workspace_id, target_kind, target_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (operation_id, source_workspace_id, source_kind, source_id)
        DO UPDATE SET target_id = workspace_content_operation_mappings.target_id
        WHERE workspace_content_operation_mappings.target_workspace_id = EXCLUDED.target_workspace_id
          AND workspace_content_operation_mappings.target_kind = EXCLUDED.target_kind
          AND workspace_content_operation_mappings.target_id = EXCLUDED.target_id
        "#,
      )
      .bind(operation_id)
      .bind(mapping.source.workspace_id())
      .bind(mapping.source.kind().as_str())
      .bind(mapping.source.resource_id())
      .bind(mapping.target.workspace_id())
      .bind(mapping.target.kind().as_str())
      .bind(mapping.target.resource_id())
      .execute(&mut *tx)
      .await
      .map_err(Self::storage)?;
      if result.rows_affected() != 1 {
        return Err(Self::invalid(WorkspaceContentErrorCode::StagingReplayConflict.as_str()));
      }
    }

    for entry in entries {
      if entry.operation_id != operation_id
        || !Self::resource_belongs_to_operation(&entry.resource, source_workspace_id, target_workspace_id)
      {
        return Err(Self::invalid(
          WorkspaceContentErrorCode::StagingManifestInvalid.as_str(),
        ));
      }
      let result = sqlx::query(
        r#"
        INSERT INTO workspace_content_operation_staging (
          operation_id, sequence, resource_workspace_id, resource_kind,
          resource_id, object_key, content_hash, size_bytes, publication_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (operation_id, sequence)
        DO UPDATE SET sequence = workspace_content_operation_staging.sequence
        WHERE workspace_content_operation_staging.resource_workspace_id = EXCLUDED.resource_workspace_id
          AND workspace_content_operation_staging.resource_kind = EXCLUDED.resource_kind
          AND workspace_content_operation_staging.resource_id = EXCLUDED.resource_id
          AND workspace_content_operation_staging.object_key = EXCLUDED.object_key
          AND lower(workspace_content_operation_staging.content_hash) = lower(EXCLUDED.content_hash)
          AND workspace_content_operation_staging.size_bytes = EXCLUDED.size_bytes
          AND workspace_content_operation_staging.publication_status = EXCLUDED.publication_status
        "#,
      )
      .bind(operation_id)
      .bind(entry.sequence)
      .bind(entry.resource.workspace_id())
      .bind(entry.resource.kind().as_str())
      .bind(entry.resource.resource_id())
      .bind(entry.object_key())
      .bind(entry.content_hash())
      .bind(entry.size_bytes)
      .bind(entry.status.as_str())
      .execute(&mut *tx)
      .await
      .map_err(Self::storage)?;
      if result.rows_affected() != 1 {
        return Err(Self::invalid(WorkspaceContentErrorCode::StagingReplayConflict.as_str()));
      }
    }

    let mapping_count: i64 =
      sqlx::query_scalar("SELECT count(*) FROM workspace_content_operation_mappings WHERE operation_id = $1")
        .bind(operation_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::storage)?;
    let staging_count: i64 =
      sqlx::query_scalar("SELECT count(*) FROM workspace_content_operation_staging WHERE operation_id = $1")
        .bind(operation_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::storage)?;
    if usize::try_from(mapping_count) != Ok(mappings.len()) || usize::try_from(staging_count) != Ok(entries.len()) {
      return Err(Self::invalid(WorkspaceContentErrorCode::StagingReplayConflict.as_str()));
    }
    tx.commit().await.map_err(Self::storage)
  }

  async fn list_mappings(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<Vec<WorkspaceContentIdMapping>> {
    let rows = sqlx::query(
      r#"
      SELECT source_workspace_id, source_kind, source_id,
             target_workspace_id, target_kind, target_id
      FROM workspace_content_operation_mappings
      WHERE operation_id = $1
      ORDER BY source_workspace_id, source_kind, source_id
      "#,
    )
    .bind(operation_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage)?;
    rows
      .into_iter()
      .map(|row| {
        WorkspaceContentIdMapping::new(
          make_resource(
            row.get("source_workspace_id"),
            row.get("source_kind"),
            row.get("source_id"),
          )?,
          make_resource(
            row.get("target_workspace_id"),
            row.get("target_kind"),
            row.get("target_id"),
          )?,
        )
        .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))
      })
      .collect()
  }

  async fn list_staging_entries(
    &self,
    operation_id: WorkspaceContentOperationId,
  ) -> AuthResult<Vec<WorkspaceContentStagingEntry>> {
    let rows = sqlx::query(
      r#"
      SELECT sequence, resource_workspace_id, resource_kind, resource_id,
             object_key, content_hash, size_bytes, publication_status
      FROM workspace_content_operation_staging
      WHERE operation_id = $1
      ORDER BY sequence
      "#,
    )
    .bind(operation_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::storage)?;
    rows
      .into_iter()
      .map(|row| {
        let mut entry = WorkspaceContentStagingEntry::new(
          operation_id,
          row.get("sequence"),
          make_resource(
            row.get("resource_workspace_id"),
            row.get("resource_kind"),
            row.get("resource_id"),
          )?,
          row.get::<String, _>("object_key"),
          row.get::<String, _>("content_hash"),
          row.get("size_bytes"),
        )
        .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string()))?;
        entry.status = staging_status(row.get::<String, _>("publication_status").as_str())?;
        Ok(entry)
      })
      .collect()
  }
}

impl PgWorkspaceContentCopyPublicationRepository {
  #[instrument(skip_all, fields(operation_id = %batch.operation.id))]
  async fn publish_copy_in_phase(
    &self,
    batch: WorkspaceContentCopyPublicationBatch,
    diagnostic_instance_id: &str,
    phase: &mut &'static str,
    cleanup_required: &mut bool,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    if batch.operation.kind != WorkspaceContentOperationKind::Copy
      || batch.operation.status != WorkspaceContentOperationStatus::Running
      || !PgWorkspaceContentOperationRepository::validate_text(diagnostic_instance_id, MAX_DIAGNOSTIC_INSTANCE_ID_BYTES)
      || batch.objects.is_empty()
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::PublicationStateInvalid.as_str().to_string(),
      ));
    }
    myoxus_application::workspace_content_operation::reject_collection_mappings(&batch.mappings)?;
    let target_workspace_id = batch
      .operation
      .target_workspace_id
      .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str().to_string()))?;

    let mut newly_written_blob_keys = BTreeSet::new();
    let blob_proofs = match materialize_operation_blobs(
      &self.pool,
      self.storage.as_ref(),
      &batch.operation,
      &batch.objects,
      phase,
      0,
      &mut newly_written_blob_keys,
    )
    .await
    {
      Ok(proofs) => proofs,
      Err(error) => {
        if cleanup_operation_blob_keys(
          &self.pool,
          self.storage.as_ref(),
          batch.operation.id,
          &newly_written_blob_keys,
        )
        .await
        .is_err()
        {
          *cleanup_required = true;
          error!(operation_id = %batch.operation.id, phase = "compensation", cause = WorkspaceContentErrorCode::BlobCompensationFailed.as_str(), "workspace_content.compensation_failed");
        }
        return Err(error);
      }
    };

    *phase = "publication";
    let publication = async {
      let mut tx = self
        .pool
        .begin()
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?;
      PgDatabaseRepository::capture_catalog_admission(&mut tx, &self.database_templates)
        .await.map_err(publication_database_error)?;
      let row = sqlx::query(&format!("{RECORD_SELECT} WHERE id = $1 FOR UPDATE"))
        .bind(batch.operation.id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?
        .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))?;
      let durable = map_record(&row)?;
      if durable.status == WorkspaceContentOperationStatus::Succeeded {
        let replay_matches: bool =
          sqlx::query_scalar(
            r#"
          SELECT EXISTS (
            SELECT 1
            FROM workspace_content_copy_publications
            WHERE operation_id = $1
              AND target_workspace_id = $2
              AND lower(manifest_hash) = lower($3)
              AND preview_revision IS NOT DISTINCT FROM $4
              AND object_count = $5
          )
          "#,
          )
          .bind(batch.operation.id)
          .bind(target_workspace_id)
          .bind(&batch.operation.manifest_hash)
          .bind(&batch.operation.preview_revision)
          .bind(i32::try_from(batch.objects.len()).map_err(|_| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::ResourceCountInvalid.as_str().to_string())
          })?)
          .fetch_one(&mut *tx)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?;
        if replay_matches {
          tx.commit()
            .await
            .map_err(PgWorkspaceContentOperationRepository::storage)?;
          return Ok(durable);
        }
      }
      if durable != batch.operation {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::PublicationTerminalConflict.as_str().to_string(),
        ));
      }
      verify_publication_manifest(&mut tx, &batch).await?;
      verify_operation_blob_quota(&mut tx, target_workspace_id, &blob_proofs, self.default_workspace_quota_mb).await?;
      apply_operation_memberships(&mut tx, batch.operation.id, target_workspace_id).await?;

      for object in &batch.objects {
        if let WorkspaceContentPublicationObject::Reconciled { resource, envelope } = object {
          match (resource.kind(), envelope.action) {
            (WorkspaceContentResourceKind::Tag, action) => {
              let mut tag = envelope.source_tag()?;
              tag.id = parse_target_uuid(resource, "Tag")?;
              tag.workspace_id = target_workspace_id;
              tag.name = envelope.target_name.clone();
              materialize_operation_tag(&mut tx, &tag, batch.operation.actor_id,
                action == WorkspaceContentReconcileAction::Reuse).await?;
            }
            (WorkspaceContentResourceKind::Database, WorkspaceContentReconcileAction::Reuse) => {
              lock_reuse_target(&mut tx, resource).await?;
            }
            _ => {
              return Err(AuthError::InvalidInput(
                WorkspaceContentErrorCode::SelectedResourceUnsupported.as_str().to_string(),
              ));
            }
          }
        }
      }

      let mut tag_assignments = Vec::new();
      let mut doc_updates = Vec::new();
      for object in &batch.objects {
        let WorkspaceContentPublicationObject::Document {
          resource,
          internal_doc_id,
          title,
          yjs_update,
          metadata,
          tag_ids,
        } = object
        else {
          continue;
        };
        if resource.workspace_id() != target_workspace_id {
          return Err(AuthError::InvalidInput(
            WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string(),
          ));
        }
        let projection: DocumentMetadataProjection = serde_json::from_value(metadata.clone()).map_err(|_| {
          AuthError::InvalidInput(WorkspaceContentErrorCode::DocumentMetadataInvalid.as_str().to_string())
        })?;
        if projection.doc_id != *internal_doc_id || projection.workspace_id != target_workspace_id {
          return Err(AuthError::InvalidInput(
            WorkspaceContentErrorCode::DocumentMetadataInvalid.as_str().to_string(),
          ));
        }
        insert_copy_document(
          &mut tx,
          target_workspace_id,
          batch.operation.actor_id,
          resource.resource_id(),
          *internal_doc_id,
          title,
          yjs_update,
          &projection,
        )
        .await?;
        tag_assignments.push((*internal_doc_id, tag_ids.clone()));
        doc_updates.push((*internal_doc_id, 1_i64));
      }

      for (doc_id, tag_ids) in tag_assignments {
        // These references are carried by the verified source snapshot. Retain
        // archived source assignments while checking mapped target identities
        // under catalog locks in the existing publication transaction.
        PgWorkspaceTagRepository::validate_references_in_tx(&mut tx, target_workspace_id, &tag_ids, &tag_ids)
          .await
          .map_err(publication_tag_error)?;
        for (position, tag_id) in tag_ids.iter().enumerate() {
          PgWorkspaceTagRepository::insert_document_assignment_in_tx(
            &mut tx,
            target_workspace_id,
            doc_id,
            *tag_id,
            i32::try_from(position)
              .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::ResourceCountInvalid.as_str().into()))?,
            Some(batch.operation.actor_id),
          )
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?;
        }
      }

      for object in &batch.objects {
        match object {
          WorkspaceContentPublicationObject::Database {
resource,
            envelope,
            bundle,
          } if envelope.action == WorkspaceContentReconcileAction::Create => {
            if resource.workspace_id() != target_workspace_id {
              return Err(AuthError::InvalidInput(
                WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().to_string(),
              ));
            }
            let source_database_id = if bundle.database.managed_installation.is_some() {
              Some(parse_move_uuid(envelope.source.resource_id(), "Database")?)
            } else { None };
            PgDatabaseRepository::publish_workspace_content_database_identity(
              &mut tx, envelope.source.workspace_id(), source_database_id, bundle,
            ).await?;
          }
          WorkspaceContentPublicationObject::Database {
resource, envelope, .. }
            if envelope.action == WorkspaceContentReconcileAction::Reuse =>
          {
            lock_reuse_target(&mut tx, resource).await?;
          }
          WorkspaceContentPublicationObject::Organizer { update, .. } => {
            let key = format!("db${target_workspace_id}$folders");
            let doc_id = ensure_system_document(
              &mut tx,
              batch.operation.id,
              target_workspace_id,
              &key,
              batch.operation.actor_id,
            )
            .await?;
            let sequence = append_copy_update(&mut tx, doc_id, target_workspace_id, update).await?;
            doc_updates.push((doc_id, sequence));
          }
          _ => {}
        }
      }

      // Browser discovery and route resolution read meta.pages, not SQL docs.
      // Publish the directory in the same transaction as content and broadcast
      // it through the existing outbox before reporting Copy as successful.
      let copied_pages = batch
        .objects
        .iter()
        .filter_map(|object| match object {
          WorkspaceContentPublicationObject::Document { resource, title, .. } => {
            Some((resource.resource_id().to_string(), title.clone()))
          }
          _ => None,
        })
        .collect::<Vec<_>>();
      if !copied_pages.is_empty() {
        let target_root = load_full_move_doc(&mut tx, target_workspace_id, target_workspace_id).await?;
        let update = yjs::add_pages_to_root_doc(&[target_root], &copied_pages)
          .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::OrganizerDecode.as_str().to_string()))?;
        if update.is_empty() {
          return Err(publication_failure(WorkspaceContentErrorCode::CopyTargetPageDirectoryChanged));
        }
        let sequence = append_copy_update(&mut tx, target_workspace_id, target_workspace_id, &update).await?;
        doc_updates.push((target_workspace_id, sequence));
      }

      for object in &batch.objects {
        if let WorkspaceContentPublicationObject::Database {
envelope, bundle, .. } = object
          && envelope.action == WorkspaceContentReconcileAction::Create {
          PgDatabaseRepository::publish_workspace_content_database_contents(
            &mut tx, target_workspace_id, batch.operation.actor_id, bundle,
          ).await?;
        }
      }

      publish_operation_overviews(&mut tx, &batch.operation, &batch.mappings, None, None).await?;
      publish_operation_blob_catalog(&mut tx, target_workspace_id, &blob_proofs).await?;

      for (doc_id, sequence) in &doc_updates {
        sqlx::query(
          r#"
          INSERT INTO outbox_events
            (id, aggregate_type, aggregate_id, event_type, payload, created_at)
          VALUES ($1, 'doc', $2, 'workspace_doc_broadcast', $3, now())
          ON CONFLICT (id) DO NOTHING
          "#,
        )
        .bind(Uuid::new_v5(
          &batch.operation.id,
          format!("workspace-doc-broadcast:{doc_id}:{sequence}").as_bytes(),
        ))
        .bind(doc_id.to_string())
        .bind(serde_json::json!({
          "workspaceId": target_workspace_id,
          "docId": doc_id,
          "sequence": sequence,
          "actorUserId": batch.operation.actor_id,
        }))
        .execute(&mut *tx)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?;
      }
      let resources = publication_resources(&batch);
      sqlx::query(
        r#"
        INSERT INTO outbox_events
          (id, aggregate_type, aggregate_id, event_type, payload, created_at)
        VALUES ($1, 'workspace_content_operation', $2, 'workspace_content_published', $3, now())
        ON CONFLICT (id) DO NOTHING
        "#,
      )
      .bind(Uuid::new_v5(&batch.operation.id, b"workspace-content-published"))
      .bind(batch.operation.id.to_string())
      .bind(serde_json::json!({
        "operationId": batch.operation.id,
        "targetWorkspaceId": target_workspace_id,
        "resources": resources,
      }))
      .execute(&mut *tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;

      sqlx::query(
        r#"
        INSERT INTO workspace_content_copy_publications
          (operation_id, target_workspace_id, manifest_hash, preview_revision,
           object_count, diagnostic_instance_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
      )
      .bind(batch.operation.id)
      .bind(target_workspace_id)
      .bind(&batch.operation.manifest_hash)
      .bind(&batch.operation.preview_revision)
      .bind(
        i32::try_from(batch.objects.len())
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::ResourceCountInvalid.as_str().to_string()))?,
      )
      .bind(diagnostic_instance_id)
      .execute(&mut *tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
      sqlx::query(
        "UPDATE workspace_content_operation_staging
         SET publication_status = 'published'
         WHERE operation_id = $1 AND publication_status = 'staged'",
      )
      .bind(batch.operation.id)
      .execute(&mut *tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
      let row = sqlx::query(&format!(
        "UPDATE workspace_content_operations
         SET status = 'succeeded', diagnostic_instance_id = $2,
             error_code = NULL, error_message = NULL, error_phase = NULL, updated_at = now()
         WHERE id = $1 AND status = 'running'
         RETURNING {RECORD_COLUMNS}"
      ))
      .bind(batch.operation.id)
      .bind(diagnostic_instance_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?
      .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::PublicationTerminalConflict))?;
      let published = map_record(&row)?;
      tx.commit()
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?;
      Ok(published)
    }
    .instrument(tracing::info_span!("workspace_content.phase", operation_id = %batch.operation.id, operation_kind = batch.operation.kind.as_str(), phase = "publication"))
    .await;

    let published = match publication {
      Ok(record) => record,
      Err(error) => {
        // Commit transport failure is not proof of rollback. Locking the
        // operation row waits for the authoritative transaction outcome.
        match operation_publication_receipt(&self.pool, batch.operation.id).await {
          Ok(Some(committed)) => return Ok(committed),
          Ok(None) => {}
          Err(receipt_error) => {
            myoxus_application::workspace_content_operation::record_operation_failure(
              batch.operation.id,
              Some(batch.operation.kind),
              "publication_receipt",
              &receipt_error,
            );
            *cleanup_required = true;
            return Err(error);
          }
        }
        // Compensation may itself fail. Record the originating publication
        // cause before attempting it, not only the later cleanup failure.
        let cause = match &error {
          AuthError::InvalidInput(message) => WorkspaceContentErrorCode::parse(message).map(|code| code.as_str()),
          _ => None,
        };
        error!(operation_id = %batch.operation.id, phase = "publication", cause, "workspace_content.publication_aborted");
        if let Err(cleanup_error) = cleanup_operation_blob_keys(
          &self.pool,
          self.storage.as_ref(),
          batch.operation.id,
          &newly_written_blob_keys,
        )
        .await
        {
          *cleanup_required = true;
          myoxus_application::workspace_content_operation::record_operation_failure(
            batch.operation.id,
            Some(batch.operation.kind),
            "compensation",
            &cleanup_error,
          );
        }
        return Err(error);
      }
    };

    // Staging cleanup is deliberately post-commit. Failure cannot roll back or
    // hide the canonical publication and remains explicitly retryable.
    for entry in &batch.staging_entries {
      match self.storage.delete_blob(entry.object_key()).await {
        Ok(()) => {
          if let Err(error) = sqlx::query(
            "UPDATE workspace_content_operation_staging
             SET publication_status = 'deleted'
             WHERE operation_id = $1 AND sequence = $2 AND publication_status = 'published'",
          )
          .bind(batch.operation.id)
          .bind(entry.sequence)
          .execute(&self.pool)
          .await
          {
            let _ = PgWorkspaceContentOperationRepository::storage(error);
            warn!(
              operation_id = %batch.operation.id,
              staging_sequence = entry.sequence,
              phase = "staging_cleanup_persistence",
              "workspace content staging object was deleted but cleanup state could not be persisted"
            );
          }
        }
        Err(delete_error) => {
          if let Err(status_error) = sqlx::query(
            "UPDATE workspace_content_operation_staging
             SET publication_status = 'cleanup_required'
             WHERE operation_id = $1 AND sequence = $2 AND publication_status = 'published'",
          )
          .bind(batch.operation.id)
          .bind(entry.sequence)
          .execute(&self.pool)
          .await
          {
            let _ = PgWorkspaceContentOperationRepository::storage(status_error);
            warn!(
              operation_id = %batch.operation.id,
              staging_sequence = entry.sequence,
              phase = "staging_cleanup",
              error_kind = port_error_kind(&delete_error),
              "workspace content staging cleanup and retry-state persistence failed"
            );
          } else {
            warn!(
              operation_id = %batch.operation.id,
              staging_sequence = entry.sequence,
              phase = "staging_cleanup",
              error_kind = port_error_kind(&delete_error),
              "workspace content staging cleanup remains retryable"
            );
          }
        }
      }
    }
    Ok(published)
  }
}

#[async_trait]
impl WorkspaceContentCopyPublicationPort for PgWorkspaceContentCopyPublicationRepository {
  async fn publish_copy(
    &self,
    batch: WorkspaceContentCopyPublicationBatch,
    diagnostic_instance_id: &str,
  ) -> myoxus_application::workspace_content_operation::WorkspaceContentExecutionResult<WorkspaceContentOperationRecord>
  {
    // Keep the original dependency failure and the last reached boundary;
    // the private helper remains the sole materialization/SQL implementation.
    let mut phase = "typed_plan";
    let mut cleanup_required = false;
    let operation_id = batch.operation.id;
    match self
      .publish_copy_in_phase(batch, diagnostic_instance_id, &mut phase, &mut cleanup_required)
      .await
    {
      Ok(record) => Ok(record),
      Err(error) => {
        let failure =
          myoxus_application::workspace_content_operation::WorkspaceContentExecutionError::at_phase(error, phase);
        if cleanup_required {
          persist_materialization_cleanup_failure(&self.pool, operation_id, &failure.failure).await;
        }
        Err(failure)
      }
    }
  }
}

#[async_trait]
impl WorkspaceContentMoveRevisionManifestPort for PgWorkspaceContentOperationRepository {
  #[instrument(skip(self, operation, mappings), fields(operation_id = %operation.id, resource_count = mappings.len()))]
  async fn prepare_move_revision_manifest(
    &self,
    operation: &WorkspaceContentOperationRecord,
    mappings: &[WorkspaceContentIdMapping],
  ) -> AuthResult<WorkspaceContentMoveRevisionManifest> {
    if !matches!(
      operation.kind,
      WorkspaceContentOperationKind::Move | WorkspaceContentOperationKind::ExtractFolder
    ) || operation.status != WorkspaceContentOperationStatus::Running
      || mappings.is_empty()
    {
      return Err(Self::invalid(WorkspaceContentErrorCode::InventoryInvalid.as_str()));
    }
    myoxus_application::workspace_content_operation::reject_tag_relocation_mappings(mappings)?;
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
      .execute(&mut *tx)
      .await
      .map_err(Self::storage)?;
    let mut manifest = capture_move_revision_manifest(&mut tx, operation, mappings, false).await?;
    let manifest_value = serde_json::to_value(&manifest)
      .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::EncodingFailed.as_str().to_string()))?;
    let manifest_hash = hash_values(std::slice::from_ref(&manifest_value))?;
    let inserted = sqlx::query(
      "INSERT INTO workspace_content_move_revision_manifests
         (operation_id, manifest, manifest_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (operation_id) DO NOTHING",
    )
    .bind(operation.id)
    .bind(&manifest_value)
    .bind(&manifest_hash)
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?
    .rows_affected()
      == 1;
    if !inserted {
      let row = sqlx::query(
        "SELECT manifest, manifest_hash
         FROM workspace_content_move_revision_manifests
         WHERE operation_id = $1",
      )
      .bind(operation.id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::storage)?;
      let stored_value: serde_json::Value = row.get("manifest");
      let stored: WorkspaceContentMoveRevisionManifest = serde_json::from_value(stored_value)
        .map_err(|_| Self::invalid(WorkspaceContentErrorCode::InventoryInvalid.as_str()))?;
      // JSONB may reorder object keys. Re-encode the typed contract in the
      // same order used when persisting its hash, not PostgreSQL's wire order.
      let canonical_stored = serde_json::to_value(&stored)
        .map_err(|_| Self::invalid(WorkspaceContentErrorCode::InventoryInvalid.as_str()))?;
      align_legacy_overview_manifest(&mut manifest, &stored, operation.kind, mappings)?;
      if let Some(code) =
        diagnose_move_manifest_changes(operation.id, operation.kind, "revision_manifest", &manifest, &stored)
      {
        return Err(publication_failure(code));
      }
      if !row
        .get::<String, _>("manifest_hash")
        .eq_ignore_ascii_case(&hash_values(&[canonical_stored])?)
      {
        return Err(publication_failure(
          WorkspaceContentErrorCode::MoveRevisionManifestReplayChanged,
        ));
      }
      manifest = stored;
    }
    tx.commit().await.map_err(Self::storage)?;
    Ok(manifest)
  }
}

impl PgWorkspaceContentMovePublicationRepository {
  #[instrument(skip_all, fields(operation_id = %batch.operation.id))]
  async fn publish_move_in_phase(
    &self,
    batch: WorkspaceContentMovePublicationBatch,
    diagnostic_instance_id: &str,
    phase: &mut &'static str,
    cleanup_required: &mut bool,
  ) -> AuthResult<WorkspaceContentOperationRecord> {
    let is_extract = batch.operation.kind == WorkspaceContentOperationKind::ExtractFolder;
    for (invalid, code) in [
      (
        !matches!(
          batch.operation.kind,
          WorkspaceContentOperationKind::Move | WorkspaceContentOperationKind::ExtractFolder
        ),
        WorkspaceContentErrorCode::PublicationKindInvalid,
      ),
      (
        batch.operation.status != WorkspaceContentOperationStatus::Running,
        WorkspaceContentErrorCode::PublicationStateInvalid,
      ),
      (
        batch.mappings.is_empty(),
        WorkspaceContentErrorCode::PublicationMappingsEmpty,
      ),
      (
        is_extract != batch.extract_source_folder_id.is_some(),
        WorkspaceContentErrorCode::ExtractFolderBindingInvalid,
      ),
      (
        !is_extract && !batch.staging_entries.is_empty(),
        WorkspaceContentErrorCode::PublicationStagingUnexpected,
      ),
      (
        !PgWorkspaceContentOperationRepository::validate_text(diagnostic_instance_id, MAX_DIAGNOSTIC_INSTANCE_ID_BYTES),
        WorkspaceContentErrorCode::DiagnosticInstanceInvalid,
      ),
    ] {
      if invalid {
        return Err(AuthError::InvalidInput(code.as_str().into()));
      }
    }
    myoxus_application::workspace_content_operation::reject_collection_mappings(&batch.mappings)?;
    myoxus_application::workspace_content_operation::reject_tag_relocation_mappings(&batch.mappings)?;
    if batch
      .revision_manifest
      .tags
      .as_ref()
      .is_none_or(|tags| tags.version != MOVE_TAG_MANIFEST_VERSION)
    {
      return Err(publication_failure(
        WorkspaceContentErrorCode::MoveTagLineageRequiresAFreshPreview,
      ));
    }
    if batch.revision_manifest.reference_plans.as_ref().is_none_or(|plans| {
      plans.len() != batch.revision_manifest.documents.len() || plans.iter().any(|plan| plan.validate().is_err())
    }) || batch
      .revision_manifest
      .documents
      .iter()
      .any(|doc| doc.reference_source_sha256.is_none())
    {
      return Err(publication_failure(
        WorkspaceContentErrorCode::MoveReferencesRequireAFreshPreview,
      ));
    }
    let source_workspace_id = batch.operation.source_workspace_id;
    let target_workspace_id = batch
      .operation
      .target_workspace_id
      .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str().to_string()))?;
    if source_workspace_id == target_workspace_id {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::DistinctWorkspacesRequired
          .as_str()
          .to_string(),
      ));
    }
    myoxus_application::workspace_content_operation::preflight::validate_private_materialization_mappings(
      batch.operation.id,
      batch.operation.kind,
      target_workspace_id,
      &batch.mappings,
    )?;
    validate_move_recipient_intents(&batch)?;

    let mut blob_proofs = Vec::new();
    let mut newly_written_blob_keys = BTreeSet::new();
    let materialization: AuthResult<()> = async {
    for (blob_index, mapping) in batch.mappings.iter().filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Blob).enumerate() {
      *phase = "source_read";
      let metadata = sqlx::query("SELECT size, mime, checksum FROM blobs WHERE workspace_id=$1 AND key=$2 AND deleted_at IS NULL AND status='completed'")
        .bind(source_workspace_id).bind(mapping.source.resource_id()).fetch_optional(&self.pool).await
        .map_err(PgWorkspaceContentOperationRepository::storage)?
        .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::SourceBlobMissing.as_str().into()))?;
      let source_key = if is_extract {
        batch.staging_entries.iter().find(|entry| entry.resource == mapping.target)
          .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::BlobStagingEntryMissing.as_str().into()))?.object_key().to_string()
      } else { format!("{source_workspace_id}/{}", mapping.source.resource_id()) };
      let source = self.storage.read_blob(&source_key).await.map_err(|error| match error {
        PortError::NotFound(_) => AuthError::NotFound(WorkspaceContentErrorCode::SourceBlobMissing.as_str().into()),
        error => publication_storage(error),
      })?;
      let sha256 = hex::encode(Sha256::digest(&source.data));
      if metadata.get::<i64,_>("size") != i64::try_from(source.data.len()).unwrap_or(-1)
        || metadata.get::<Option<String>,_>("checksum").as_deref().is_some_and(|hash|
          hash.len() == 64 && hash.bytes().all(|value| value.is_ascii_hexdigit()) && !hash.eq_ignore_ascii_case(&sha256))
        || (is_extract && batch.staging_entries.iter().find(|entry| entry.resource == mapping.target)
          .is_none_or(|entry| entry.size_bytes != source.data.len() as i64 || !entry.content_hash().eq_ignore_ascii_case(&sha256)))
      {
        return Err(AuthError::InvalidInput(WorkspaceContentErrorCode::BlobIntegrityMismatch.as_str().into()));
      }
      let object = WorkspaceContentPublicationObject::Blob {
        resource: mapping.target.clone(), bytes: source.data, content_type: metadata.get("mime"),
      };
      blob_proofs.extend(materialize_operation_blobs(
        &self.pool, self.storage.as_ref(), &batch.operation, std::slice::from_ref(&object), phase,
        blob_index, &mut newly_written_blob_keys,
      ).await?);
    }
    Ok(())
    }.await;
    if let Err(error) = materialization {
      if cleanup_operation_blob_keys(
        &self.pool,
        self.storage.as_ref(),
        batch.operation.id,
        &newly_written_blob_keys,
      )
      .await
      .is_err()
      {
        *cleanup_required = true;
      }
      return Err(error);
    }

    *phase = "publication";
    // Retry only PostgreSQL's transaction aborts, using the same admitted
    // manifest and materialized bytes. A changed content fence is never retried
    // or replaced by a later snapshot.
    let mut publication_attempt = 0;
    let publication = loop {
      publication_attempt += 1;
      let result = async {
        let mut tx = self
          .pool
          .begin()
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
          .execute(&mut *tx)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?;
        PgDatabaseRepository::capture_catalog_admission(&mut tx, &self.database_templates)
          .await.map_err(publication_database_error)?;
        let row = sqlx::query(&format!("{RECORD_SELECT} WHERE id = $1 FOR UPDATE"))
          .bind(batch.operation.id)
          .fetch_optional(&mut *tx)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?
          .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::OperationMissing.as_str().to_string()))?;
        let durable = map_record(&row)?;
        if durable.status == WorkspaceContentOperationStatus::Succeeded {
          let replay_matches: bool = if is_extract {
            sqlx::query_scalar(
              r#"
            SELECT EXISTS (
              SELECT 1
              FROM workspace_content_extract_publications
              WHERE operation_id = $1
                AND source_workspace_id = $2
                AND target_workspace_id = $3
                AND lower(manifest_hash) = lower($4)
                AND preview_revision IS NOT DISTINCT FROM $5
                AND resource_count = $6
                AND source_folder_id = $7
            )
            "#,
            )
            .bind(batch.operation.id)
            .bind(source_workspace_id)
            .bind(target_workspace_id)
            .bind(&batch.operation.manifest_hash)
            .bind(&batch.operation.preview_revision)
            .bind(i32::try_from(batch.mappings.len()).map_err(|_| {
              AuthError::InvalidInput(WorkspaceContentErrorCode::ResourceCountInvalid.as_str().to_string())
            })?)
            .bind(batch.extract_source_folder_id.as_deref())
            .fetch_one(&mut *tx)
            .await
            .map_err(PgWorkspaceContentOperationRepository::storage)?
          } else {
            sqlx::query_scalar(
              r#"
          SELECT EXISTS (
            SELECT 1
            FROM workspace_content_move_publications
            WHERE operation_id = $1
              AND source_workspace_id = $2
              AND target_workspace_id = $3
              AND lower(manifest_hash) = lower($4)
              AND preview_revision IS NOT DISTINCT FROM $5
              AND resource_count = $6
          )
            "#,
            )
            .bind(batch.operation.id)
            .bind(source_workspace_id)
            .bind(target_workspace_id)
            .bind(&batch.operation.manifest_hash)
            .bind(&batch.operation.preview_revision)
            .bind(i32::try_from(batch.mappings.len()).map_err(|_| {
              AuthError::InvalidInput(WorkspaceContentErrorCode::ResourceCountInvalid.as_str().to_string())
            })?)
            .fetch_one(&mut *tx)
            .await
            .map_err(PgWorkspaceContentOperationRepository::storage)?
          };
          if replay_matches {
            verify_move_recipient_intents(&mut tx, &batch).await?;
            tx.commit()
              .await
              .map_err(PgWorkspaceContentOperationRepository::storage)?;
            return Ok(durable);
          }
        }
        if durable != batch.operation {
          return Err(publication_failure(WorkspaceContentErrorCode::MoveOperationRevisionChanged));
        }
        git_handoff::lock_profiles(&mut tx, &[source_workspace_id,target_workspace_id]).await?;
        // Writers lock each workspace's document set in UUID order. Take the
        // same scoped locks, including both roots, before manifest row locks.
        let mut document_locks=BTreeSet::from([(source_workspace_id,source_workspace_id),(target_workspace_id,target_workspace_id)]);
        for document in &batch.revision_manifest.documents {
          document_locks.insert((source_workspace_id,document.doc_id));
          document_locks.insert((target_workspace_id,document.doc_id));
          for workspace in sqlx::query_scalar::<_,Uuid>("SELECT workspace_id FROM document_edit_capture_state WHERE doc_id=$1")
            .bind(document.doc_id).fetch_all(&mut *tx).await.map_err(move_conflict)? {
            document_locks.insert((workspace,document.doc_id));
          }
        }
        // Organizer projections may update the existing system document too.
        for workspace in [source_workspace_id,target_workspace_id] {
          if let Some(id)=sqlx::query_scalar::<_,Uuid>("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2")
            .bind(workspace).bind(format!("db${workspace}$folders")).fetch_optional(&mut *tx).await.map_err(move_conflict)? {
            document_locks.insert((workspace,id));
          }
        }
        for (workspace,doc) in document_locks {
          sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
            .bind(crate::document_version::edit_capture_state::lock_key(workspace,doc))
            .execute(&mut *tx).await.map_err(move_conflict)?;
        }
        verify_current_move_recipient_snapshot(&mut tx, &batch).await?;
        verify_move_manifest(&mut tx, &batch).await?;
        for (workspace_id, lifecycle_state) in [
          (source_workspace_id, "active"),
          (target_workspace_id, if is_extract { "extracting" } else { "active" }),
        ] {
          sqlx::query(
            "SELECT 1 FROM workspaces
            WHERE id = $1 AND deleted_at IS NULL AND lifecycle_state = $2
            FOR UPDATE",
          )
          .bind(workspace_id)
          .bind(lifecycle_state)
          .fetch_optional(&mut *tx)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?
          .ok_or_else(|| {
            AuthError::NotFound(
              WorkspaceContentErrorCode::PublicationWorkspaceMissing
                .as_str()
                .to_string(),
            )
          })?;
        }
        if is_extract {
          verify_extract_target(&mut tx, &batch).await?;
        }
        apply_operation_memberships(&mut tx, batch.operation.id, target_workspace_id).await?;
        // The workspace locks above establish active ownership (or this operation
        // alone provisions Extract). Apply its current activated sharing policy,
        // independently of preview and without upgrading a private document.
        let target_allows_public_sharing: bool =
          sqlx::query_scalar("SELECT public AND enable_sharing FROM workspaces WHERE id = $1")
            .bind(target_workspace_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(PgWorkspaceContentOperationRepository::storage)?;

        let tag_manifest = batch.revision_manifest.tags.as_ref()
          .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::MoveTagLineageIsMissing))?;
        let mut used_tag_ids = tag_manifest.positions.iter().flat_map(|position| position.target_ids.iter().copied())
          .collect::<BTreeSet<_>>();
        if let Some(organizer) = &batch.organizer {
          for row in &organizer.target_rows {
            if row.row_type == "tag"
              && row.effective_target_workspace_id(target_workspace_id) == target_workspace_id {
              used_tag_ids.insert(parse_move_uuid(&row.data, "Tag")?);
            }
          }
        }
        let request: serde_json::Value = sqlx::query_scalar("SELECT request FROM workspace_content_operation_requests WHERE operation_id=$1")
          .bind(batch.operation.id).fetch_one(&mut *tx).await.map_err(PgWorkspaceContentOperationRepository::storage)?;
        let request: WorkspaceContentOperationRequest = serde_json::from_value(request)
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::RequestInvalid.as_str().into()))?;
        if let WorkspaceContentOperationSelection::Resources { resources } = request.selection {
          for resource in resources.iter().filter(|resource| resource.kind() == WorkspaceContentResourceKind::Tag) {
            if let Some(mapping) = batch.mappings.iter().find(|mapping| mapping.source == *resource) {
              used_tag_ids.insert(parse_move_uuid(mapping.target.resource_id(), "Tag")?);
            }
          }
        }
        for tag in tag_manifest.materializations.iter().filter(|tag| used_tag_ids.contains(&tag.id)) {
          materialize_operation_tag(&mut tx, tag, batch.operation.actor_id, false).await?;
        }

        for mapping in batch
          .mappings
          .iter()
          .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Database)
        {
          let id = parse_move_uuid(mapping.source.resource_id(), "Database")?;
          let expected = batch
            .revision_manifest
            .databases
            .iter()
            .find(|revision| revision.resource == mapping.source)
            .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::MoveDatabaseRevisionIsMissing))?;
          if mapping.target.resource_id() != mapping.source.resource_id() {
            return Err(AuthError::InvalidInput(
              WorkspaceContentErrorCode::DatabaseIdentityChanged.as_str().to_string(),
            ));
          }
          PgDatabaseRepository::move_workspace_content_database_owner(
            &mut tx, source_workspace_id, target_workspace_id, id,
            expected.parent_edit_revision, &expected.ownership_row_counts,
          ).await?;
        }

        let values=match &self.capture_config { Some(read)=>read().await, None=>HashMap::new() };
        let mut capture_policy=myoxus_application::document_version::GlobalEditCaptureSettings::default();
        capture_policy.enabled=values.get("doc.history.enabled").and_then(serde_json::Value::as_bool).unwrap_or(capture_policy.enabled);
        capture_policy.interval_ms=values.get("doc.history.interval").and_then(serde_json::Value::as_i64).unwrap_or(capture_policy.interval_ms);
        let mut moved_docs = Vec::new();
        let mut moved_pages = Vec::new();
        let mut doc_updates = Vec::new();
          let mut row_reference_mappings = Vec::new();
          for database in &batch.revision_manifest.databases {
            let source_database = parse_move_uuid(database.resource.resource_id(), "Database")?;
            let Some(target) = batch.mappings.iter().find(|item| item.source == database.resource) else { continue; };
            let target_database = parse_move_uuid(target.target.resource_id(), "Database")?;
            for row_id in PgDatabaseRepository::workspace_content_row_ids(&mut tx, source_database).await? {
              row_reference_mappings.push((
                yjs::DatabaseRowReference { workspace_id: source_workspace_id, database_id: source_database, row_id },
                yjs::DatabaseRowReference { workspace_id: target_workspace_id, database_id: target_database, row_id },
              ));
            }
          }

        for mapping in batch
          .mappings
          .iter()
          .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Document)
        {
          let expected = batch
            .revision_manifest
            .documents
            .iter()
            .find(|revision| revision.resource == mapping.source)
            .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::MoveDocumentRevisionIsMissing))?;
          let row = sqlx::query(
            "SELECT id, title, metadata_revision FROM docs
           WHERE workspace_id = $1 AND external_id = $2 AND deleted_at IS NULL
           FOR UPDATE",
          )
          .bind(source_workspace_id)
          .bind(mapping.source.resource_id())
          .fetch_optional(&mut *tx)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?
          .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::SourceDocumentMissing.as_str().to_string()))?;
          let doc_id: Uuid = row.get("id");
          let title: String = row.get("title");
          let target_conflict: bool = sqlx::query_scalar(
            "SELECT EXISTS(
             SELECT 1 FROM docs
             WHERE workspace_id = $1 AND external_id = $2 AND id <> $3
           )",
          )
          .bind(target_workspace_id)
          .bind(mapping.target.resource_id())
          .bind(doc_id)
          .fetch_one(&mut *tx)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?;
          if target_conflict {
            return Err(AuthError::InvalidInput(
              WorkspaceContentErrorCode::TargetDocumentKeyConflict
                .as_str()
                .to_string(),
            ));
          }
          let deleted_assignments = sqlx::query("DELETE FROM workspace_tag_document_assignments WHERE workspace_id=$1 AND doc_id=$2")
            .bind(source_workspace_id).bind(doc_id).execute(&mut *tx).await
            .map_err(PgWorkspaceContentOperationRepository::storage)?.rows_affected();
          if expected.ownership_row_counts.get("workspace_tag_document_assignments").copied() != Some(deleted_assignments) {
            return Err(publication_failure(WorkspaceContentErrorCode::MoveDocumentClassificationsChanged));
          }
          // A move invalidates all pending source windows, including sealed
          // ones. Returning the same identity later must not replay old edits.
          sqlx::query("DELETE FROM document_change_batches WHERE doc_id = $1")
            .bind(doc_id)
            .execute(&mut *tx)
            .await
            .map_err(PgWorkspaceContentOperationRepository::storage)?;
          let moved = sqlx::query(
            "UPDATE docs
           SET workspace_id = $2,
               external_id = $3,
               public_mode = CASE WHEN $4 THEN public_mode ELSE NULL END,
               updated_at = now()
           WHERE id = $1 AND workspace_id = $5 AND metadata_revision = $6",
          )
          .bind(doc_id)
          .bind(target_workspace_id)
          .bind(mapping.target.resource_id())
          .bind(target_allows_public_sharing)
          .bind(source_workspace_id)
          // Extract moves the locked live row without rewriting its metadata.
          // Permission writes may advance its generic metadata freshness too.
          .bind(row.get::<i64, _>("metadata_revision"))
          .execute(&mut *tx)
          .await
          .map_err(move_conflict)?
          .rows_affected();
          if moved != 1 {
            return Err(publication_failure(WorkspaceContentErrorCode::MoveDocumentOwnershipChanged));
          }
          for (table, column, text_id) in MOVE_DOCUMENT_OWNERSHIP_TABLES {
            if *table == "workspace_tag_document_assignments" { continue; }
            let expected_count = expected
              .ownership_row_counts
              .get(*table)
              .copied()
              .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::MoveDocumentChildCountIsMissing))?;
            let affected = if matches!(*table, "public_asset_manifest" | "public_render_artifacts")
              && !target_allows_public_sharing
            {
              sqlx::query(&format!(
                "DELETE FROM {table} WHERE workspace_id = $1 AND {column} = $2"
              ))
              .bind(source_workspace_id)
              .bind(doc_id)
              .execute(&mut *tx)
              .await
              .map_err(move_conflict)?
              .rows_affected()
            } else {
              let cast = if *text_id { "::text" } else { "" };
              sqlx::query(&format!(
                "UPDATE {table} SET workspace_id = $2
               WHERE workspace_id = $1 AND {column} = $3{cast}"
              ))
              .bind(source_workspace_id)
              .bind(target_workspace_id)
              .bind(doc_id)
              .execute(&mut *tx)
              .await
              .map_err(move_conflict)?
              .rows_affected()
            };
            if affected != expected_count {
              return Err(publication_failure(WorkspaceContentErrorCode::MoveDocumentChildOwnershipChanged));
            }
          }
          // Whole persisted-stream equality proves that the captured numeric
          // selectors are still bound, despite Any-map encoding order changes.
          let (snapshot, source_hash) = crate::doc::SqlxDocStore::load_reference_snapshot_in_tx(
            &mut tx, target_workspace_id, doc_id,
          ).await?;
          if expected.reference_source_sha256.as_deref() != Some(source_hash.as_str()) {
            return Err(publication_failure(WorkspaceContentErrorCode::MoveReferenceSourceChanged));
          }
          let mut reference_plan = batch.revision_manifest.reference_plans.as_ref()
            .and_then(|plans| plans.iter().find(|plan| plan.source == mapping.source))
            .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::MoveReferencePlanIsMissing))?.clone();
          reference_plan.snapshot_sha256 = hex::encode(Sha256::digest(&snapshot));
          let rewritten = myoxus_application::workspace_content_operation::copy::apply_native_reference_plan(
            &snapshot, &reference_plan, myoxus_application::workspace_content_operation::copy::copy_rewrite_client_id(batch.operation.id, &mapping.target),
          )?;
          let row_rewritten = yjs::rewrite_database_row_references(&rewritten.full_state, &row_reference_mappings,
            ((myoxus_application::workspace_content_operation::copy::copy_rewrite_client_id(batch.operation.id, &mapping.target)+1) & ((1_u64 << 53)-1)).max(1))
            .map_err(|_| publication_failure(WorkspaceContentErrorCode::MoveReferenceSourceChanged))?;
          // Preserve a genuine no-op without encoding a historical delete set
          // into an extra persisted stream entry. Real changes share one delta.
          let incremental_update = if rewritten.incremental_update.is_empty() && row_rewritten.incremental_update.is_empty() {
            Vec::new()
          } else {
            yjs::get_missing_diff(&row_rewritten.full_state, &yjs::get_state_vector(&snapshot)
              .map_err(|_| publication_failure(WorkspaceContentErrorCode::MoveReferenceSourceChanged))?)
              .map_err(|_| publication_failure(WorkspaceContentErrorCode::MoveReferenceSourceChanged))?
          };
          let rewritten = yjs::NativeReferenceRewriteResult { incremental_update, full_state: row_rewritten.full_state };
          if !rewritten.incremental_update.is_empty() {
            let sequence=append_copy_update(&mut tx, doc_id, target_workspace_id, &rewritten.incremental_update).await?;
            crate::document_version::edit_capture_state::mark_dirty(&mut tx,target_workspace_id,doc_id,sequence).await.map_err(move_conflict)?;
            doc_updates.push((target_workspace_id,doc_id,sequence));
          }
          for attachment in sqlx::query("SELECT id,storage_key FROM comment_attachments WHERE workspace_id=$1 AND doc_id=$2 FOR UPDATE")
            .bind(target_workspace_id).bind(doc_id).fetch_all(&mut *tx).await.map_err(move_conflict)?
          {
            let source_key: String = attachment.get("storage_key");
            let blob = batch.mappings.iter().find(|item| item.source.kind()==WorkspaceContentResourceKind::Blob
              && item.source.workspace_id()==source_workspace_id && item.source.resource_id()==source_key)
              .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::OwnedBlobMappingMissing.as_str().into()))?;
            sqlx::query("UPDATE comment_attachments SET storage_key=$2 WHERE id=$1")
              .bind(attachment.get::<Uuid,_>("id")).bind(blob.target.resource_id())
              .execute(&mut *tx).await.map_err(move_conflict)?;
          }
          crate::document_version::edit_capture_state::rebind(&mut tx,target_workspace_id,doc_id,&capture_policy,chrono::Utc::now())
            .await.map_err(move_conflict)?;
          moved_docs.push(doc_id);
          moved_pages.push((
            mapping.source.resource_id().to_string(),
            mapping.target.resource_id().to_string(),
            title,
          ));
        }

        verify_operation_blob_quota(&mut tx, target_workspace_id, &blob_proofs, self.default_workspace_quota_mb).await?;
        publish_operation_blob_catalog(&mut tx, target_workspace_id, &blob_proofs).await?;

        publish_move_database_references(&mut tx, &batch).await?;
        publish_move_tag_positions(&mut tx, &batch.operation, tag_manifest).await?;

        if let Some(projection) = &batch.organizer {
          let source_doc_id = ensure_system_document(
            &mut tx,
            batch.operation.id,
            source_workspace_id,
            &format!("db${source_workspace_id}$folders"),
            batch.operation.actor_id,
          )
          .await?;
          let target_doc_id = ensure_system_document(
            &mut tx,
            batch.operation.id,
            target_workspace_id,
            &format!("db${target_workspace_id}$folders"),
            batch.operation.actor_id,
          )
          .await?;
          doc_updates.push((
            source_workspace_id,
            source_doc_id,
            append_copy_update(&mut tx, source_doc_id, source_workspace_id, &projection.source_update).await?,
          ));
          doc_updates.push((
            target_workspace_id,
            target_doc_id,
            append_copy_update(&mut tx, target_doc_id, target_workspace_id, &projection.target_update).await?,
          ));
        }

        if !moved_pages.is_empty() {
          let source_root = load_full_move_doc(&mut tx, source_workspace_id, source_workspace_id).await?;
          let target_root = load_full_move_doc(&mut tx, target_workspace_id, target_workspace_id).await?;
          let source_page_ids = moved_pages
            .iter()
            .map(|(source_id, _, _)| source_id.clone())
            .collect::<Vec<_>>();
          let target_pages = moved_pages
            .iter()
            .map(|(_, target_id, title)| (target_id.clone(), title.clone()))
            .collect::<Vec<_>>();
          let source_removal = yjs::remove_pages_from_root_doc(&source_root, &source_page_ids)
            .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::OrganizerDecode.as_str().to_string()))?;
          if !source_removal.update.is_empty() {
            doc_updates.push((
              source_workspace_id,
              source_workspace_id,
              append_copy_update(
                &mut tx,
                source_workspace_id,
                source_workspace_id,
                &source_removal.update,
              )
              .await?,
            ));
          }
          let target_update = yjs::add_pages_to_root_doc(std::slice::from_ref(&target_root), &target_pages)
            .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::OrganizerDecode.as_str().to_string()))?;
          if target_update.is_empty() {
            return Err(publication_failure(WorkspaceContentErrorCode::MoveTargetPageDirectoryChanged));
          }
          doc_updates.push((
            target_workspace_id,
            target_workspace_id,
            append_copy_update(&mut tx, target_workspace_id, target_workspace_id, &target_update).await?,
          ));
        }
        for (workspace_id, doc_id, sequence) in doc_updates {
          sqlx::query(
            "INSERT INTO outbox_events
             (id, aggregate_type, aggregate_id, event_type, payload, created_at)
           VALUES ($1, 'doc', $2, 'workspace_doc_broadcast', $3, now())
           ON CONFLICT (id) DO NOTHING",
          )
          .bind(Uuid::new_v5(
            &batch.operation.id,
            format!("workspace-doc-broadcast:{workspace_id}:{doc_id}:{sequence}").as_bytes(),
          ))
          .bind(doc_id.to_string())
          .bind(serde_json::json!({
            "workspaceId": workspace_id,
            "docId": doc_id,
            "sequence": sequence,
            "actorUserId": batch.operation.actor_id,
          }))
          .execute(&mut *tx)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?;
        }

        // Workspace identity is part of every resource reference. A Move needs
        // a redirect even when the resource-local id itself remains stable.
        for mapping in batch.mappings.iter().filter(|mapping| !matches!(mapping.source.kind(), WorkspaceContentResourceKind::Tag | WorkspaceContentResourceKind::Blob)) {
          insert_move_redirect(&mut tx, batch.operation.id, mapping).await?;
        }

        if is_extract {
          git_handoff::publish(&mut tx, &batch.operation, &batch.mappings).await?;
        } else {
          git_undo::publish(&mut tx,&batch.operation,&batch.mappings).await?;
        }
        publish_operation_overviews(&mut tx, &batch.operation, &batch.mappings,
          batch.revision_manifest.overview.as_ref(), batch.extract_source_folder_id.as_deref()).await?;
        if is_extract {
          let activated = sqlx::query(
            "UPDATE workspaces
              SET lifecycle_state = 'active', lifecycle_owner_kind = NULL,
                  lifecycle_owner_id = NULL, updated_at = now()
            WHERE id = $1 AND lifecycle_state = 'extracting'
              AND lifecycle_owner_kind = 'workspace_content'
              AND lifecycle_owner_id = $2",
          )
          .bind(target_workspace_id)
          .bind(batch.operation.id)
          .execute(&mut *tx)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?
          .rows_affected();
          if activated != 1 {
            return Err(publication_failure(WorkspaceContentErrorCode::ExtractTargetActivationChanged));
          }
          let receipt = sqlx::query(
            "UPDATE workspace_content_extract_targets
              SET published_at = now()
            WHERE operation_id = $1 AND published_at IS NULL",
          )
          .bind(batch.operation.id)
          .execute(&mut *tx)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?
          .rows_affected();
          if receipt != 1 {
            return Err(publication_failure(WorkspaceContentErrorCode::ExtractTargetReceiptChanged));
          }
          for entry in &batch.staging_entries {
            let staged = sqlx::query(
              "UPDATE workspace_content_operation_staging
                SET publication_status = 'published'
              WHERE operation_id = $1 AND sequence = $2
                AND publication_status = 'staged'",
            )
            .bind(batch.operation.id)
            .bind(entry.sequence)
            .execute(&mut *tx)
            .await
            .map_err(PgWorkspaceContentOperationRepository::storage)?
            .rows_affected();
            if staged != 1 {
              return Err(publication_failure(WorkspaceContentErrorCode::ExtractBlobStagingStateChanged));
            }
          }
        }

        let mut resources = batch.mappings.iter()
          .filter(|mapping| mapping.target.kind() != WorkspaceContentResourceKind::Tag)
          .map(|mapping| mapping.target.clone()).collect::<Vec<_>>();
        resources.extend(used_tag_ids.iter().map(|id| make_resource(target_workspace_id, "tag".into(), id.to_string()))
          .collect::<AuthResult<Vec<_>>>()?);
        let source_resources = batch
          .mappings
          .iter()
          .filter(|mapping| mapping.source.kind() != WorkspaceContentResourceKind::Blob)
          .map(|mapping| mapping.source.clone())
          .collect::<Vec<_>>();
        for intent in &batch.recipient_intents {
          let visible_resource_kinds = intent
            .visible_resource_kinds
            .iter()
            .map(|kind| kind.as_str())
            .collect::<Vec<_>>();
          sqlx::query(
            "INSERT INTO workspace_content_operation_recipient_outbox
             (operation_id, recipient_id, event_kind, resource_count,
              visible_resource_kinds, recipient_snapshot_revision,
              source_workspace_id, source_workspace_name, actor_id, published_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())",
          )
          .bind(intent.operation_id)
          .bind(intent.recipient_id)
          .bind(&intent.event_kind)
          .bind(intent.resource_count)
          .bind(&visible_resource_kinds)
          .bind(&intent.recipient_snapshot_revision)
          .bind(intent.source_workspace_id)
          .bind(&intent.source_workspace_name)
          .bind(intent.actor_id)
          .execute(&mut *tx)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?;
        }
        sqlx::query(
          "INSERT INTO outbox_events
           (id, aggregate_type, aggregate_id, event_type, payload, created_at)
         VALUES ($1, 'workspace_content_operation', $2, 'workspace_content_published', $3, now())
         ON CONFLICT (id) DO NOTHING",
        )
        .bind(Uuid::new_v5(&batch.operation.id, b"workspace-content-published"))
        .bind(batch.operation.id.to_string())
        .bind(serde_json::json!({
          "operationId": batch.operation.id,
          "sourceWorkspaceId": source_workspace_id,
          "targetWorkspaceId": target_workspace_id,
          "sourceResources": source_resources,
          "resources": resources,
          "movedDocumentIds": moved_docs,
        }))
        .execute(&mut *tx)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?;
        if is_extract {
          sqlx::query(
            "INSERT INTO workspace_content_extract_publications
             (operation_id, source_workspace_id, target_workspace_id, source_folder_id,
              manifest_hash, preview_revision, resource_count, diagnostic_instance_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
          )
          .bind(batch.operation.id)
          .bind(source_workspace_id)
          .bind(target_workspace_id)
          .bind(batch.extract_source_folder_id.as_deref())
          .bind(&batch.operation.manifest_hash)
          .bind(&batch.operation.preview_revision)
          .bind(i32::try_from(batch.mappings.len()).map_err(|_| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::ResourceCountInvalid.as_str().to_string())
          })?)
          .bind(diagnostic_instance_id)
          .execute(&mut *tx)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?;
        } else {
          sqlx::query(
            "INSERT INTO workspace_content_move_publications
           (operation_id, source_workspace_id, target_workspace_id, manifest_hash,
            preview_revision, resource_count, diagnostic_instance_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)",
          )
          .bind(batch.operation.id)
          .bind(source_workspace_id)
          .bind(target_workspace_id)
          .bind(&batch.operation.manifest_hash)
          .bind(&batch.operation.preview_revision)
          .bind(i32::try_from(batch.mappings.len()).map_err(|_| {
            AuthError::InvalidInput(WorkspaceContentErrorCode::ResourceCountInvalid.as_str().to_string())
          })?)
          .bind(diagnostic_instance_id)
          .execute(&mut *tx)
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?;
        }
        let row = sqlx::query(&format!(
          "UPDATE workspace_content_operations
         SET status = 'succeeded', diagnostic_instance_id = $2,
             error_code = NULL, error_message = NULL, error_phase = NULL, updated_at = now()
         WHERE id = $1 AND status = 'running'
         RETURNING {RECORD_COLUMNS}"
        ))
        .bind(batch.operation.id)
        .bind(diagnostic_instance_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?
        .ok_or_else(|| {
          AuthError::InvalidInput(
            WorkspaceContentErrorCode::PublicationTerminalConflict
              .as_str()
              .to_string(),
          )
        })?;
        let published = map_record(&row)?;
        tx.commit()
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?;
        Ok(published)
      }
    .instrument(tracing::info_span!("workspace_content.phase", operation_id = %batch.operation.id, operation_kind = batch.operation.kind.as_str(), phase = "publication", publication_attempt))
      .await;
      if publication_attempt < 3
        && let Some(cause) = result.as_ref().err().and_then(publication_transaction_retry_cause)
      {
        warn!(operation_id = %batch.operation.id, phase = "publication", publication_attempt,
          cause = cause.as_str(),
          "workspace_content.publication_transaction_retry");
        continue;
      }
      break result;
    };

    let published = match publication {
      Ok(record) => record,
      Err(error) => {
        let cause = match &error {
          AuthError::InvalidInput(message) => WorkspaceContentErrorCode::parse(message).map(|code| code.as_str()),
          _ => None,
        };
        error!(operation_id = %batch.operation.id, phase = "publication", cause, "workspace_content.publication_aborted");
        match operation_publication_receipt(&self.pool, batch.operation.id).await {
          Ok(Some(record)) => return Ok(record),
          Ok(None) => {}
          Err(receipt_error) => {
            myoxus_application::workspace_content_operation::record_operation_failure(
              batch.operation.id,
              Some(batch.operation.kind),
              "publication_receipt",
              &receipt_error,
            );
            *cleanup_required = true;
            return Err(error);
          }
        }
        if let Err(cleanup_error) = cleanup_operation_blob_keys(
          &self.pool,
          self.storage.as_ref(),
          batch.operation.id,
          &newly_written_blob_keys,
        )
        .await
        {
          *cleanup_required = true;
          myoxus_application::workspace_content_operation::record_operation_failure(
            batch.operation.id,
            Some(batch.operation.kind),
            "compensation",
            &cleanup_error,
          );
        }
        return Err(error);
      }
    };
    if is_extract {
      for entry in &batch.staging_entries {
        let status = match self.storage.delete_blob(entry.object_key()).await {
          Ok(()) => "deleted",
          Err(error) => {
            warn!(
              operation_id = %batch.operation.id,
              staging_sequence = entry.sequence,
              error_kind = port_error_kind(&error),
              "published Extract staging cleanup remains retryable"
            );
            "cleanup_required"
          }
        };
        sqlx::query(
          "UPDATE workspace_content_operation_staging
              SET publication_status = $3
            WHERE operation_id = $1 AND sequence = $2",
        )
        .bind(batch.operation.id)
        .bind(entry.sequence)
        .bind(status)
        .execute(&self.pool)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?;
      }
    }
    Ok(published)
  }
}

#[async_trait]
impl WorkspaceContentMovePublicationPort for PgWorkspaceContentMovePublicationRepository {
  async fn publish_move(
    &self,
    batch: WorkspaceContentMovePublicationBatch,
    diagnostic_instance_id: &str,
  ) -> myoxus_application::workspace_content_operation::WorkspaceContentExecutionResult<WorkspaceContentOperationRecord>
  {
    // Keep the original dependency failure and the last reached boundary;
    // the private helper remains the sole materialization/SQL implementation.
    let mut phase = "typed_plan";
    let mut cleanup_required = false;
    let operation_id = batch.operation.id;
    let result = self
      .publish_move_in_phase(batch, diagnostic_instance_id, &mut phase, &mut cleanup_required)
      .await;
    match result {
      Ok(record) => Ok(record),
      Err(error) => {
        let failure =
          myoxus_application::workspace_content_operation::WorkspaceContentExecutionError::at_phase(error, phase);
        if cleanup_required {
          persist_materialization_cleanup_failure(&self.pool, operation_id, &failure.failure).await;
        }
        Err(failure)
      }
    }
  }
}

fn validate_move_recipient_intents(batch: &WorkspaceContentMovePublicationBatch) -> AuthResult<()> {
  if batch.recipient_intents.is_empty() {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::RecipientsEmpty.as_str().to_string(),
    ));
  }
  let revision = &batch.recipient_intents[0].recipient_snapshot_revision;
  let source_workspace_name = &batch.recipient_intents[0].source_workspace_name;
  let mapped_kinds = batch
    .mappings
    .iter()
    .map(|mapping| mapping.source.kind())
    .collect::<BTreeSet<_>>();
  let expected_event_kind = "workspace_content_moved";
  let mut recipients = BTreeSet::new();
  for intent in &batch.recipient_intents {
    let mut kinds = intent.visible_resource_kinds.clone();
    kinds.sort();
    kinds.dedup();
    if intent.operation_id != batch.operation.id
      || intent.source_workspace_id != batch.operation.source_workspace_id
      || intent.source_workspace_name != *source_workspace_name
      || intent.actor_id != batch.operation.actor_id
      || intent.event_kind != expected_event_kind
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::RecipientBindingInvalid.as_str().into(),
      ));
    }
    if intent.resource_count < 0
      || usize::try_from(intent.resource_count)
        .map(|count| count > batch.mappings.len())
        .unwrap_or(true)
      || (intent.resource_count == 0) != kinds.is_empty()
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::RecipientCountInvalid.as_str().into(),
      ));
    }
    if kinds != intent.visible_resource_kinds || !kinds.iter().all(|kind| mapped_kinds.contains(kind)) {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::RecipientKindsInvalid.as_str().into(),
      ));
    }
    if intent.recipient_snapshot_revision != *revision
      || !PgWorkspaceContentOperationRepository::validate_text(revision, MAX_PREVIEW_REVISION_BYTES)
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::RecipientRevisionInvalid.as_str().into(),
      ));
    }
    if !recipients.insert(intent.recipient_id) {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::RecipientDuplicate.as_str().into(),
      ));
    }
  }
  if !recipients.contains(&batch.operation.actor_id) {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::RecipientActorMissing.as_str().to_string(),
    ));
  }
  Ok(())
}

async fn verify_move_recipient_intents(
  tx: &mut Transaction<'_, Postgres>,
  batch: &WorkspaceContentMovePublicationBatch,
) -> AuthResult<()> {
  let count: i64 = sqlx::query_scalar(
    "SELECT count(*) FROM workspace_content_operation_recipient_outbox
     WHERE operation_id = $1 AND event_kind = $2",
  )
  .bind(batch.operation.id)
  .bind("workspace_content_moved")
  .fetch_one(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if usize::try_from(count) != Ok(batch.recipient_intents.len()) {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::RecipientReplayConflict.as_str().to_string(),
    ));
  }
  for intent in &batch.recipient_intents {
    let visible_resource_kinds = intent
      .visible_resource_kinds
      .iter()
      .map(|kind| kind.as_str())
      .collect::<Vec<_>>();
    let exact: bool = sqlx::query_scalar(
      "SELECT EXISTS(
         SELECT 1 FROM workspace_content_operation_recipient_outbox
         WHERE operation_id = $1 AND recipient_id = $2
           AND event_kind = $3 AND resource_count = $4
           AND visible_resource_kinds = $5
           AND recipient_snapshot_revision = $6
       )",
    )
    .bind(intent.operation_id)
    .bind(intent.recipient_id)
    .bind(&intent.event_kind)
    .bind(intent.resource_count)
    .bind(&visible_resource_kinds)
    .bind(&intent.recipient_snapshot_revision)
    .fetch_one(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
    if !exact {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::RecipientReplayConflict.as_str().to_string(),
      ));
    }
  }
  Ok(())
}

async fn verify_current_move_recipient_snapshot(
  tx: &mut Transaction<'_, Postgres>,
  batch: &WorkspaceContentMovePublicationBatch,
) -> AuthResult<()> {
  if batch.operation.kind == WorkspaceContentOperationKind::ExtractFolder {
    // The receipt, not changing source membership, owns Extract recipients.
    let value: serde_json::Value =
      sqlx::query_scalar("SELECT membership_snapshot FROM workspace_content_extract_targets WHERE operation_id = $1")
        .bind(batch.operation.id)
        .fetch_one(&mut **tx)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?;
    let members: Vec<WorkspaceContentMemberRevision> = serde_json::from_value(value)
      .map_err(|_| publication_failure(WorkspaceContentErrorCode::ExtractMembershipSnapshotIsInvalid))?;
    let mut recipients = members
      .into_iter()
      .map(|member| (member.user_id, workspace_role_name(member.role).to_string()))
      .collect::<Vec<_>>();
    if !recipients.iter().any(|(id, _)| *id == batch.operation.actor_id) {
      recipients.push((batch.operation.actor_id, "Actor".to_string()));
    }
    recipients.sort_by_key(|(id, _)| *id);
    let intent = &batch.recipient_intents[0];
    let expected = recipients.iter().map(|(id, _)| *id).collect::<BTreeSet<_>>();
    let actual = batch
      .recipient_intents
      .iter()
      .map(|intent| intent.recipient_id)
      .collect::<BTreeSet<_>>();
    if actual != expected
      || intent.recipient_snapshot_revision
        != move_recipient_snapshot_revision(
          batch.operation.source_workspace_id,
          &intent.source_workspace_name,
          &recipients,
        )
    {
      return Err(publication_failure(
        WorkspaceContentErrorCode::ExtractRecipientSnapshotChanged,
      ));
    }
    return Ok(());
  }
  let rows = sqlx::query(
    "SELECT user_id, role
     FROM workspace_memberships
     WHERE workspace_id = $1 AND status = 'Accepted'
     ORDER BY user_id",
  )
  .bind(batch.operation.source_workspace_id)
  .fetch_all(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  let mut recipients = rows
    .into_iter()
    .map(|row| (row.get::<Uuid, _>("user_id"), row.get::<String, _>("role")))
    .collect::<Vec<_>>();
  if !recipients
    .iter()
    .any(|(user_id, _)| *user_id == batch.operation.actor_id)
  {
    recipients.push((batch.operation.actor_id, "Actor".to_string()));
    recipients.sort_by_key(|(user_id, _)| *user_id);
  }
  // Role changes cannot revoke an admitted operation. Recipient IDs still
  // fence concurrent joins/leaves so no current source member is omitted.
  let expected_recipients = batch
    .recipient_intents
    .iter()
    .map(|intent| intent.recipient_id)
    .collect::<BTreeSet<_>>();
  let actual_recipients = recipients
    .into_iter()
    .map(|(user_id, _)| user_id)
    .collect::<BTreeSet<_>>();
  if actual_recipients != expected_recipients {
    return Err(publication_failure(
      WorkspaceContentErrorCode::MoveRecipientSnapshotChanged,
    ));
  }
  Ok(())
}

async fn verify_move_manifest(
  tx: &mut Transaction<'_, Postgres>,
  batch: &WorkspaceContentMovePublicationBatch,
) -> AuthResult<()> {
  let rows = sqlx::query(
    "SELECT source_workspace_id, source_kind, source_id,
            target_workspace_id, target_kind, target_id
     FROM workspace_content_operation_mappings
     WHERE operation_id = $1
     ORDER BY source_workspace_id, source_kind, source_id
     FOR UPDATE",
  )
  .bind(batch.operation.id)
  .fetch_all(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  let mut durable = rows
    .into_iter()
    .map(|row| {
      WorkspaceContentIdMapping::new(
        make_resource(
          row.get("source_workspace_id"),
          row.get("source_kind"),
          row.get("source_id"),
        )?,
        make_resource(
          row.get("target_workspace_id"),
          row.get("target_kind"),
          row.get("target_id"),
        )?,
      )
      .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))
    })
    .collect::<AuthResult<Vec<_>>>()?;
  durable.sort_by(|left, right| left.source.cmp(&right.source));
  let mut expected = batch.mappings.clone();
  expected.sort_by(|left, right| left.source.cmp(&right.source));
  if durable != expected {
    return Err(publication_failure(WorkspaceContentErrorCode::MoveMappingChanged));
  }
  let expected_manifest = serde_json::to_value(&batch.revision_manifest)
    .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::EncodingFailed.as_str().to_string()))?;
  let expected_hash = hash_values(std::slice::from_ref(&expected_manifest))?;
  let persisted_manifest: Option<(serde_json::Value, String)> = sqlx::query_as(
    "SELECT manifest, manifest_hash
     FROM workspace_content_move_revision_manifests
     WHERE operation_id = $1
     FOR UPDATE",
  )
  .bind(batch.operation.id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if persisted_manifest
    .as_ref()
    .is_none_or(|(manifest, hash)| manifest != &expected_manifest || !hash.eq_ignore_ascii_case(&expected_hash))
  {
    return Err(publication_failure(
      WorkspaceContentErrorCode::MovePersistedRevisionManifestChanged,
    ));
  }
  let mut current = capture_move_revision_manifest(tx, &batch.operation, &batch.mappings, true).await?;
  align_legacy_overview_manifest(
    &mut current,
    &batch.revision_manifest,
    batch.operation.kind,
    &batch.mappings,
  )?;
  if let Some(code) = diagnose_move_manifest_changes(
    batch.operation.id,
    batch.operation.kind,
    "publication",
    &current,
    &batch.revision_manifest,
  ) {
    return Err(publication_failure(code));
  }
  Ok(())
}

/// A deployed manifest without overview facts cannot absorb later settings.
fn align_legacy_overview_manifest(
  current: &mut WorkspaceContentMoveRevisionManifest,
  stored: &WorkspaceContentMoveRevisionManifest,
  kind: WorkspaceContentOperationKind,
  mappings: &[WorkspaceContentIdMapping],
) -> AuthResult<()> {
  if stored.overview.is_none() {
    if current
      .overview
      .as_ref()
      .is_some_and(|overview| !overview.affected_settings_empty(kind, mappings))
    {
      return Err(publication_failure(WorkspaceContentErrorCode::PreflightStale));
    }
    current.overview = None;
  }
  Ok(())
}

fn normalized_move_manifests(
  kind: WorkspaceContentOperationKind,
  left: &WorkspaceContentMoveRevisionManifest,
  right: &WorkspaceContentMoveRevisionManifest,
) -> (
  WorkspaceContentMoveRevisionManifest,
  WorkspaceContentMoveRevisionManifest,
) {
  let mut current = left.clone();
  let mut expected = right.clone();
  // The raw snapshot/tail proof, not noncanonical Any-map serialization,
  // owns offset freshness. All typed occurrences still compare exactly.
  if current.documents.iter().zip(&expected.documents).all(|(left, right)| {
    left.resource == right.resource
      && left.reference_source_sha256.is_some()
      && left.reference_source_sha256 == right.reference_source_sha256
  }) {
    for manifest in [&mut current, &mut expected] {
      if let Some(plans) = &mut manifest.reference_plans {
        for plan in plans {
          plan.snapshot_sha256.clear();
        }
      }
    }
  }
  if matches!(
    kind,
    WorkspaceContentOperationKind::Move | WorkspaceContentOperationKind::ExtractFolder
  ) {
    // Identity-preserving transfer retains live grants and metadata on the same document IDs.
    // Generic metadata freshness includes permission-write timestamps, so it
    // is not a content fence. Sequence and ownership counts still protect
    // the transferred bytes and workspace-qualified children.
    // Keep persisted manifests unchanged, including deployed-version records.
    for manifest in [&mut current, &mut expected] {
      for document in &mut manifest.documents {
        document.acl_hash.clear();
        document.metadata_hash.clear();
        document.metadata_revision = 0;
        // Deployed manifests may include view counters. They describe source
        // workspace usage, not transferable content or ownership freshness.
        document.ownership_row_counts.remove("workspace_doc_view_daily");
      }
      manifest.workspaces.clear();
    }
  }
  (current, expected)
}

/// Diagnose each failed fence separately. Compare the same normalized evidence
/// as publication; log only component names and SQL identities, never payloads
/// or hashes. The first concrete cause is durable, every cause is logged.
fn diagnose_move_manifest_changes(
  operation_id: Uuid,
  kind: WorkspaceContentOperationKind,
  phase: &str,
  left: &WorkspaceContentMoveRevisionManifest,
  right: &WorkspaceContentMoveRevisionManifest,
) -> Option<WorkspaceContentErrorCode> {
  let (current, expected) = normalized_move_manifests(kind, left, right);
  let mut first = None;
  let mut changed = |code: WorkspaceContentErrorCode, component: &str, resource_id: Option<Uuid>| {
    error!(%operation_id, phase, cause = code.as_str(), reason = code.safe_message(),
      component, resource_id = ?resource_id, "workspace_content.manifest_condition_failed");
    first.get_or_insert(code);
  };
  if current.overview != expected.overview {
    changed(WorkspaceContentErrorCode::PreflightStale, "workspace_overview", None);
  }
  if current
    .documents
    .iter()
    .map(|document| document.doc_id)
    .collect::<Vec<_>>()
    != expected
      .documents
      .iter()
      .map(|document| document.doc_id)
      .collect::<Vec<_>>()
  {
    changed(
      WorkspaceContentErrorCode::MoveDocumentIdentityChanged,
      "document_inventory",
      None,
    );
  }
  let documents_by_id = current
    .documents
    .iter()
    .map(|document| (document.doc_id, document))
    .collect::<BTreeMap<_, _>>();
  // Inventory changes must not compare two different documents and falsely
  // diagnose their differing payloads as concurrent content edits.
  for planned in &expected.documents {
    let Some(actual) = documents_by_id.get(&planned.doc_id) else {
      changed(
        WorkspaceContentErrorCode::MoveDocumentIdentityChanged,
        "document_missing",
        Some(planned.doc_id),
      );
      continue;
    };
    if actual.resource != planned.resource {
      changed(
        WorkspaceContentErrorCode::MoveDocumentIdentityChanged,
        "document_identity",
        Some(planned.doc_id),
      );
    }
    if actual.content_sequence != planned.content_sequence || actual.content_hash != planned.content_hash {
      changed(
        WorkspaceContentErrorCode::MoveContentRevisionChanged,
        "document_content",
        Some(planned.doc_id),
      );
    }
    if actual.reference_source_sha256 != planned.reference_source_sha256 {
      changed(
        WorkspaceContentErrorCode::NativeReferenceSnapshotChanged,
        "reference_snapshot",
        Some(planned.doc_id),
      );
    }
    if actual.metadata_revision != planned.metadata_revision || actual.metadata_hash != planned.metadata_hash {
      changed(
        WorkspaceContentErrorCode::MoveDocumentMetadataChanged,
        "document_metadata_revision",
        Some(planned.doc_id),
      );
    }
    if actual.acl_hash != planned.acl_hash {
      changed(
        WorkspaceContentErrorCode::MoveDocumentAclChanged,
        "document_acl",
        Some(planned.doc_id),
      );
    }
    for table in actual
      .ownership_row_counts
      .keys()
      .chain(planned.ownership_row_counts.keys())
      .collect::<BTreeSet<_>>()
    {
      if actual.ownership_row_counts.get(table) != planned.ownership_row_counts.get(table) {
        changed(
          WorkspaceContentErrorCode::MoveRelatedRowsChanged,
          table,
          Some(planned.doc_id),
        );
      }
    }
  }
  for (different, code, component) in [
    (
      current.blobs != expected.blobs,
      WorkspaceContentErrorCode::MoveBlobMetadataChanged,
      "blob_metadata",
    ),
    (
      current.organizer_roots != expected.organizer_roots,
      WorkspaceContentErrorCode::MoveWorkspaceRootChanged,
      "organizer_roots",
    ),
    (
      current.databases != expected.databases,
      WorkspaceContentErrorCode::MoveDatabaseContentChanged,
      "database_content",
    ),
    (
      current.workspaces != expected.workspaces,
      WorkspaceContentErrorCode::MoveWorkspacePolicyChanged,
      "workspace_policy",
    ),
    (
      current.tags != expected.tags,
      WorkspaceContentErrorCode::MoveTagPlanChanged,
      "tag_plan",
    ),
    (
      current.reference_plans != expected.reference_plans,
      WorkspaceContentErrorCode::MoveNativeReferencePlanChanged,
      "native_reference_plan",
    ),
    (
      current.history_reference_lineage != expected.history_reference_lineage,
      WorkspaceContentErrorCode::MoveHistoryReferencesChanged,
      "history_reference_lineage",
    ),
    (
      current.organizer_reference_decisions != expected.organizer_reference_decisions
        || current.organizer_reference_revision != expected.organizer_reference_revision,
      WorkspaceContentErrorCode::MoveOrganizerReferencesChanged,
      "organizer_references",
    ),
    (
      current.undo_extract_folder_id != expected.undo_extract_folder_id,
      WorkspaceContentErrorCode::MoveUndoFolderChanged,
      "undo_folder",
    ),
  ] {
    if different {
      changed(code, component, None);
    }
  }
  debug_assert_eq!(first.is_none(), current == expected);
  first
}

/// Registered conditions survive persistence and transport without aggregation.
/// Operation/phase spans route the event through the central workers group.
fn workspace_overview_state(
  row: &sqlx::postgres::PgRow,
  workspace_id: Uuid,
) -> AuthResult<WorkspaceContentOverviewState> {
  let (settings, revision) = crate::workspace::SqlxWorkspaceStore::overview_from_row(row)?;
  Ok(WorkspaceContentOverviewState {
    workspace_id,
    revision,
    settings,
  })
}

/// Apply configuration in the same transaction as Organizer/document ownership.
/// Copy locks only after its document writes; NO KEY UPDATE avoids conflicting
/// with the native workspace foreign-key locks taken by those writes.
async fn publish_operation_overviews(
  tx: &mut Transaction<'_, Postgres>,
  operation: &WorkspaceContentOperationRecord,
  mappings: &[WorkspaceContentIdMapping],
  captured: Option<&WorkspaceContentOverviewSnapshot>,
  extracted_folder_id: Option<&str>,
) -> AuthResult<()> {
  if !has_folder_mappings(mappings) {
    return Ok(());
  }
  let target_workspace_id = operation
    .target_workspace_id
    .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::TargetWorkspaceMissing))?;
  let current = if let Some(captured) = captured {
    captured.clone()
  } else {
    let mut states = BTreeMap::new();
    for id in BTreeSet::from([operation.source_workspace_id, target_workspace_id]) {
      let (settings, revision) = crate::workspace::SqlxWorkspaceStore::lock_overview_in_transaction(tx, id).await?;
      states.insert(
        id,
        WorkspaceContentOverviewState {
          workspace_id: id,
          revision,
          settings,
        },
      );
    }
    WorkspaceContentOverviewSnapshot {
      source: states
        .remove(&operation.source_workspace_id)
        .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::PublicationWorkspaceMissing))?,
      target: Some(
        states
          .remove(&target_workspace_id)
          .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::PublicationWorkspaceMissing))?,
      ),
      extracted_folder_id: extracted_folder_id.map(str::to_owned),
    }
  };
  if current.source.workspace_id != operation.source_workspace_id
    || current
      .target
      .as_ref()
      .is_none_or(|target| target.workspace_id != target_workspace_id)
    || current.extracted_folder_id.as_deref() != extracted_folder_id
    || !current.accepts_publication_revision(operation.kind, mappings, operation.preview_revision.as_deref())
  {
    return Err(publication_failure(WorkspaceContentErrorCode::PreflightStale));
  }
  let target = current
    .target
    .as_ref()
    .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::PublicationWorkspaceMissing))?;
  let origin_id = if operation.kind == WorkspaceContentOperationKind::Move {
    sqlx::query_scalar::<_, Option<Uuid>>(
      "SELECT origin_operation_id FROM workspace_content_operation_requests WHERE operation_id=$1",
    )
    .bind(operation.id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .flatten()
  } else {
    None
  };
  let origin = if let Some(origin_id) = origin_id {
    let row = sqlx::query(
      "SELECT o.kind, m.manifest, m.manifest_hash
       FROM workspace_content_move_revision_manifests m
       JOIN workspace_content_operations o ON o.id=m.operation_id
       WHERE m.operation_id=$1 AND o.status='succeeded'
         AND o.source_workspace_id=$2 AND o.target_workspace_id=$3
         AND o.kind IN ('move','extract_folder')
         AND (EXISTS(SELECT 1 FROM workspace_content_move_publications p WHERE p.operation_id=o.id AND p.manifest_hash=o.manifest_hash)
           OR EXISTS(SELECT 1 FROM workspace_content_extract_publications p WHERE p.operation_id=o.id AND p.manifest_hash=o.manifest_hash))",
    ).bind(origin_id).bind(target_workspace_id).bind(operation.source_workspace_id)
      .fetch_optional(&mut **tx).await.map_err(PgWorkspaceContentOperationRepository::storage)?
      .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::UndoHasNoCommittedOriginReceipt))?;
    let manifest: WorkspaceContentMoveRevisionManifest = serde_json::from_value(row.get("manifest"))
      .map_err(|_| publication_failure(WorkspaceContentErrorCode::StagingManifestInvalid))?;
    let value =
      serde_json::to_value(&manifest).map_err(|_| publication_failure(WorkspaceContentErrorCode::EncodingFailed))?;
    if !row
      .get::<String, _>("manifest_hash")
      .eq_ignore_ascii_case(&hash_values(&[value])?)
    {
      return Err(publication_failure(
        WorkspaceContentErrorCode::UndoOriginLineageHashChanged,
      ));
    }
    if let Some(overview) = manifest.overview {
      let rows = sqlx::query(
        "SELECT source_workspace_id, source_kind, source_id, target_workspace_id, target_kind, target_id
         FROM workspace_content_operation_mappings WHERE operation_id=$1
         ORDER BY source_workspace_id, source_kind, source_id",
      )
      .bind(origin_id)
      .fetch_all(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
      let original_mappings = rows
        .into_iter()
        .map(|row| {
          WorkspaceContentIdMapping::new(
            make_resource(
              row.get("source_workspace_id"),
              row.get("source_kind"),
              row.get("source_id"),
            )?,
            make_resource(
              row.get("target_workspace_id"),
              row.get("target_kind"),
              row.get("target_id"),
            )?,
          )
          .map_err(|_| publication_failure(WorkspaceContentErrorCode::MappingPlanInvalid))
        })
        .collect::<AuthResult<Vec<_>>>()?;
      myoxus_application::workspace_content_operation::reject_collection_mappings(&original_mappings)?;
      let kind = if row.get::<String, _>("kind") == "extract_folder" {
        WorkspaceContentOperationKind::ExtractFolder
      } else {
        WorkspaceContentOperationKind::Move
      };
      Some((kind, overview, original_mappings))
    } else {
      None
    }
  } else {
    None
  };
  let (source_settings, target_settings) = if let Some((kind, origin, original_mappings)) = origin {
    let (restored_source, remaining_target) =
      origin.restore(kind, &original_mappings, mappings, target, &current.source)?;
    (remaining_target, restored_source)
  } else {
    current.project(operation.kind, mappings)?
  };
  for (state, settings) in [(&current.source, &source_settings), (target, &target_settings)] {
    if state.settings != *settings {
      crate::workspace::SqlxWorkspaceStore::write_overview_in_transaction(
        tx,
        state.workspace_id,
        state.revision,
        settings,
      )
      .await?;
    }
  }
  Ok(())
}

pub(crate) fn publication_failure(code: WorkspaceContentErrorCode) -> AuthError {
  error!(
    cause = code.as_str(),
    reason = code.safe_message(),
    "workspace_content.condition_failed"
  );
  AuthError::InvalidInput(code.as_str().to_string())
}

/// Only an acknowledged transaction abort is safe to repeat without receipt
/// readback. Content changes and unknown commit outcomes never enter this path.
fn publication_transaction_retry_cause(error: &AuthError) -> Option<WorkspaceContentErrorCode> {
  let (AuthError::InvalidInput(value) | AuthError::Storage(value)) = error else {
    return None;
  };
  WorkspaceContentErrorCode::parse(value).filter(|code| {
    matches!(
      code,
      WorkspaceContentErrorCode::PublicationSerializationConflict | WorkspaceContentErrorCode::PublicationDeadlock
    )
  })
}

/// SQLx strings can contain credentials, SQL text or row values. Retain the
/// exact error variant and PostgreSQL schema identifiers instead of Display.
fn sqlx_error_kind(error: &sqlx::Error) -> &'static str {
  match error {
    sqlx::Error::Configuration(_) => "configuration",
    sqlx::Error::InvalidArgument(_) => "invalid_argument",
    sqlx::Error::Database(_) => "database",
    sqlx::Error::Io(_) => "io",
    sqlx::Error::Tls(_) => "tls",
    sqlx::Error::Protocol(_) => "protocol",
    sqlx::Error::RowNotFound => "row_not_found",
    sqlx::Error::TypeNotFound { .. } => "type_not_found",
    sqlx::Error::ColumnIndexOutOfBounds { .. } => "column_index_out_of_bounds",
    sqlx::Error::ColumnNotFound(_) => "column_not_found",
    sqlx::Error::ColumnDecode { .. } => "column_decode",
    sqlx::Error::Decode(_) => "decode",
    sqlx::Error::Encode(_) => "encode",
    sqlx::Error::AnyDriverError(_) => "driver",
    sqlx::Error::PoolTimedOut => "pool_timed_out",
    sqlx::Error::PoolClosed => "pool_closed",
    sqlx::Error::WorkerCrashed => "worker_crashed",
    sqlx::Error::Migrate(_) => "migration",
    sqlx::Error::InvalidSavePointStatement => "invalid_savepoint_statement",
    sqlx::Error::BeginFailed => "begin_failed",
    _ => "unregistered_sqlx_variant",
  }
}

fn hash_values(values: &[serde_json::Value]) -> AuthResult<String> {
  let bytes = serde_json::to_vec(values)
    .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::EncodingFailed.as_str().to_string()))?;
  Ok(hex::encode(Sha256::digest(bytes)))
}

const MOVE_DOCUMENT_OWNERSHIP_TABLES: &[(&str, &str, bool)] = &[
  ("doc_updates", "doc_id", false),
  ("doc_histories", "doc_id", false),
  ("doc_snapshots", "doc_id", false),
  ("comments", "doc_id", false),
  ("comment_attachments", "doc_id", false),
  ("document_initial_sync_audit", "doc_id", false),
  ("document_version", "doc_id", false),
  ("document_graph_index_state", "doc_id", false),
  ("search_content", "doc_id", false),
  ("ai_workspace_ignored_docs", "doc_id", false),
  ("ai_workspace_doc_embeddings", "doc_id", false),
  ("copilot_sessions", "doc_id", false),
  ("git_sync_bindings", "doc_id", false),
  ("pdf_export_jobs", "doc_id", false),
  ("pdf_export_render_audit", "doc_id", false),
  ("public_asset_manifest", "doc_id", false),
  ("public_render_artifacts", "doc_id", false),
  ("workspace_tag_document_assignments", "doc_id", false),
  ("document_graph_occurrences", "source_doc_id", false),
];

pub(crate) const MOVE_DATABASE_OWNERSHIP_TABLES: &[&str] = &[
  "workspace_database_row_templates",
  "database_activity_events",
  "workspace_database_row_search",
  "database_import_jobs",
  "database_row_reminders",
  "database_document_references",
];

const MOVE_DATABASE_CORE_CHILD_TABLES: &[&str] = &[
  "workspace_database_fields",
  "workspace_database_views",
  "workspace_database_rows",
  "workspace_database_cell_values",
];

async fn ownership_row_counts(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: Uuid,
  doc_id: Uuid,
  publication_lock: bool,
) -> AuthResult<std::collections::BTreeMap<String, u64>> {
  let mut counts = std::collections::BTreeMap::new();
  for (table, column, text_id) in MOVE_DOCUMENT_OWNERSHIP_TABLES {
    let cast = if *text_id { "::text" } else { "" };
    let count: i64 = sqlx::query_scalar(&format!(
      "SELECT count(*) FROM {table} WHERE workspace_id = $1 AND {column} = $2{cast}"
    ))
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|error| move_revision_database_error(error, publication_lock))?;
    counts.insert(
      (*table).to_string(),
      u64::try_from(count)
        .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::ResourceCountInvalid.as_str().to_string()))?,
    );
  }
  Ok(counts)
}

async fn database_ownership_row_counts(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: Uuid,
  database_id: Uuid,
  publication_lock: bool,
) -> AuthResult<std::collections::BTreeMap<String, u64>> {
  let mut counts = std::collections::BTreeMap::new();
  for table in MOVE_DATABASE_OWNERSHIP_TABLES {
    let count: i64 = sqlx::query_scalar(&format!(
      "SELECT count(*) FROM {table} WHERE workspace_id = $1 AND database_id = $2"
    ))
    .bind(workspace_id)
    .bind(database_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|error| move_revision_database_error(error, publication_lock))?;
    counts.insert(
      (*table).to_string(),
      u64::try_from(count)
        .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::ResourceCountInvalid.as_str().to_string()))?,
    );
  }
  Ok(counts)
}

async fn capture_database_child_revisions(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: Uuid,
  database_id: Uuid,
  lock: bool,
) -> AuthResult<Vec<serde_json::Value>> {
  let lock_clause = if lock { " FOR UPDATE" } else { "" };
  let mut revisions = Vec::new();
  for (table, workspace_qualified) in MOVE_DATABASE_CORE_CHILD_TABLES
    .iter()
    .map(|table| (*table, false))
    .chain(MOVE_DATABASE_OWNERSHIP_TABLES.iter().map(|table| (*table, true)))
  {
    let workspace_predicate = if workspace_qualified {
      "workspace_id = $2 AND "
    } else {
      ""
    };
    let sql = format!(
      "SELECT to_jsonb(child) AS child
       FROM {table} child
       WHERE {workspace_predicate}database_id = $1
       ORDER BY to_jsonb(child)::text{lock_clause}"
    );
    let query = sqlx::query(&sql).bind(database_id);
    let rows = if workspace_qualified {
      query.bind(workspace_id).fetch_all(&mut **tx).await
    } else {
      query.fetch_all(&mut **tx).await
    }
    .map_err(|error| move_revision_database_error(error, lock))?;
    revisions.extend(rows.into_iter().map(|row| {
      serde_json::json!({
        "table": table,
        "row": row.get::<serde_json::Value, _>("child"),
      })
    }));
  }
  Ok(revisions)
}

async fn capture_doc_content_revision(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: Uuid,
  doc_id: Uuid,
  publication_lock: bool,
) -> AuthResult<(i64, String)> {
  let rows = sqlx::query(
    "SELECT sequence, payload
     FROM doc_updates
     WHERE workspace_id = $1 AND doc_id = $2
     ORDER BY sequence
     FOR UPDATE",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .fetch_all(&mut **tx)
  .await
  .map_err(|error| move_revision_database_error(error, publication_lock))?;
  let mut digest = Sha256::new();
  let mut sequence = 0_i64;
  for row in rows {
    sequence = row.get("sequence");
    digest.update(sequence.to_be_bytes());
    digest.update(row.get::<Vec<u8>, _>("payload"));
  }
  Ok((sequence, hex::encode(digest.finalize())))
}

/// Materialize a prepared classification in the existing content transaction.
/// Existing rows always win metadata; archive/delete cannot race its SHARE lock.
async fn materialize_operation_tag(
  tx: &mut Transaction<'_, Postgres>,
  prepared: &WorkspaceTag,
  actor_id: Uuid,
  must_exist: bool,
) -> AuthResult<()> {
  if PgWorkspaceTagRepository::is_retired_id_in_tx(tx, prepared.workspace_id, &prepared.id.to_string())
    .await
    .map_err(publication_repository_error)?
  {
    return Err(publication_failure(
      WorkspaceContentErrorCode::PreparedTagIdentityWasRetired,
    ));
  }
  let existing = sqlx::query(&format!(
    "{} WHERE id=$1 FOR SHARE",
    PgWorkspaceTagRepository::SELECT_TAG
  ))
  .bind(prepared.id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if let Some(existing) = existing {
    let target = PgWorkspaceTagRepository::row_to_tag(&existing)
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().into()))?;
    if target.workspace_id != prepared.workspace_id
      || !myoxus_application::workspace_content_operation::preflight::tag_target_is_reusable(
        &prepared.name,
        prepared.archived_at.is_some(),
        &target.name,
        target.archived_at.is_some(),
      )
    {
      return Err(publication_failure(
        WorkspaceContentErrorCode::PreparedTagIsNoLongerReusable,
      ));
    }
  } else {
    if must_exist {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::TargetDefinitionMissing.as_str().into(),
      ));
    }
    let mut tag = prepared.clone();
    let slug = WorkspaceTag::slug_base(&tag.name)
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().into()))?;
    tag.created_by = Some(actor_id);
    tag.updated_by = Some(actor_id);
    tag.created_at = Utc::now();
    tag.updated_at = tag.created_at;
    for _ in 0..10_000 {
      tag.slug = PgWorkspaceTagRepository::available_slug_in_tx(tx, tag.workspace_id, &slug)
        .await
        .map_err(publication_repository_error)?;
      if PgWorkspaceTagRepository::insert_transfer_tag_in_tx(tx, &tag)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?
        .is_some()
      {
        return Ok(());
      }
      // A Read Committed Copy can see a concurrent winner after DO NOTHING.
      // A Serializable Move instead reaches the existing SQL retry path.
      if let Some(row) = sqlx::query(&format!(
        "{} WHERE id=$1 FOR SHARE",
        PgWorkspaceTagRepository::SELECT_TAG
      ))
      .bind(tag.id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?
      {
        let existing = PgWorkspaceTagRepository::row_to_tag(&row)
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().into()))?;
        if existing.workspace_id == tag.workspace_id
          && myoxus_application::workspace_content_operation::preflight::tag_target_is_reusable(
            &tag.name,
            tag.archived_at.is_some(),
            &existing.name,
            existing.archived_at.is_some(),
          )
        {
          return Ok(());
        }
        return Err(publication_failure(
          WorkspaceContentErrorCode::ConcurrentTagIdentityIsNotReusable,
        ));
      }
    }
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::DatabaseUniqueConstraint.as_str().into(),
    ));
  }
  Ok(())
}

async fn publish_move_tag_positions(
  tx: &mut Transaction<'_, Postgres>,
  operation: &WorkspaceContentOperationRecord,
  tags: &WorkspaceContentMoveTagManifest,
) -> AuthResult<()> {
  let workspace_id = operation
    .target_workspace_id
    .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str().into()))?;
  let mut views = BTreeMap::new();
  for lineage in &tags.positions {
    // Explicit transfer is the historical-write exception used by portable
    // imports. Ordinary manual assignment still rejects archived new values.
    PgWorkspaceTagRepository::validate_references_in_tx(tx, workspace_id, &lineage.target_ids, &lineage.target_ids)
      .await
      .map_err(publication_tag_error)?;
    match &lineage.position {
      WorkspaceContentMoveTagPosition::Document { doc_id } => {
        for (position, id) in lineage.target_ids.iter().enumerate() {
          PgWorkspaceTagRepository::insert_document_assignment_in_tx(
            tx,
            workspace_id,
            *doc_id,
            *id,
            i32::try_from(position)
              .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into()))?,
            Some(operation.actor_id),
          )
          .await
          .map_err(PgWorkspaceContentOperationRepository::storage)?;
        }
      }
      WorkspaceContentMoveTagPosition::Cell {
        database_id,
        row_id,
        field_id,
      } => {
        if lineage.source_ids == lineage.target_ids {
          continue;
        }
        PgDatabaseRepository::publish_workspace_content_tag_cell(
          tx,
          *database_id,
          *row_id,
          *field_id,
          &lineage.target_ids,
        )
        .await?;
      }
      WorkspaceContentMoveTagPosition::Template {
        database_id,
        template_id,
        field_id,
      } => {
        if lineage.source_ids == lineage.target_ids {
          continue;
        }
        PgDatabaseRepository::publish_workspace_content_tag_template(
          tx,
          workspace_id,
          *database_id,
          *template_id,
          *field_id,
          &lineage.target_ids,
        )
        .await?;
      }
      WorkspaceContentMoveTagPosition::Filter {
        database_id,
        view_id,
        path,
      } => {
        let key = (*database_id, *view_id);
        if !views.contains_key(&key) {
          let config = PgDatabaseRepository::workspace_content_view_for_update(tx, *database_id, *view_id).await?;
          views.insert(key, config);
        }
        let config = views.get_mut(&key).expect("view loaded above");
        let value = config
          .pointer_mut(&format!("{path}/value"))
          .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::MovedTagPredicateDisappeared))?;
        *value = filter_operand(&lineage.target_ids, value)?;
      }
    }
  }
  for ((database_id, view_id), config) in views {
    let expected = tags
      .positions
      .iter()
      .find(|lineage| {
        matches!(lineage.position,
      WorkspaceContentMoveTagPosition::Filter { database_id: d, view_id: v, .. } if d==database_id && v==view_id)
      })
      .expect("a mutated view has a predicate lineage");
    if !hash_values(std::slice::from_ref(&config))?.eq_ignore_ascii_case(&expected.container_hash) {
      return Err(publication_failure(
        WorkspaceContentErrorCode::MovedTagFilterContainerChanged,
      ));
    }
    PgDatabaseRepository::publish_workspace_content_view_tags(tx, database_id, view_id, &config).await?;
  }
  Ok(())
}

fn mapped_tag_ids(ids: &[Uuid], mappings: &BTreeMap<Uuid, Uuid>) -> AuthResult<Vec<Uuid>> {
  let mut seen = BTreeSet::new();
  ids
    .iter()
    .map(|id| {
      mappings
        .get(id)
        .copied()
        .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::OwnedTagClassificationChanged))
    })
    .collect::<AuthResult<Vec<_>>>()
    .map(|mut ids| {
      ids.retain(|id| seen.insert(*id));
      ids
    })
}

fn tag_cell_ids(value: serde_json::Value) -> AuthResult<Vec<Uuid>> {
  use myoxus_domain::database::{DatabaseCellValueData, DatabaseFieldType};
  if value.is_null() {
    return Ok(Vec::new());
  }
  match crate::workspace_database::PgDatabaseRepository::map_cell_value_from_json(DatabaseFieldType::Tags, value) {
    Ok(DatabaseCellValueData::Tags(ids)) => Ok(ids),
    _ => Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into(),
    )),
  }
}

fn filter_operand(ids: &[Uuid], previous: &serde_json::Value) -> AuthResult<serde_json::Value> {
  use myoxus_domain::database::DatabaseFilterValue;
  let value: DatabaseFilterValue = serde_json::from_value(previous.clone())
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
  let operand = match value {
    DatabaseFilterValue::OptionId(_) if ids.len() == 1 => serde_json::json!(ids[0]),
    DatabaseFilterValue::Ids(_) => serde_json::json!(ids),
    _ => {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into(),
      ));
    }
  };
  let mut mapped = previous.clone();
  let value = mapped
    .get_mut("value")
    .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
  *value = operand;
  Ok(mapped)
}

fn same_filter_container(left: &WorkspaceContentMoveTagPosition, right: &WorkspaceContentMoveTagPosition) -> bool {
  matches!((left, right),
    (WorkspaceContentMoveTagPosition::Filter { database_id: ld, view_id: lv, .. },
     WorkspaceContentMoveTagPosition::Filter { database_id: rd, view_id: rv, .. }) if ld == rd && lv == rv)
}

async fn capture_move_tag_manifest(
  tx: &mut Transaction<'_, Postgres>,
  operation: &WorkspaceContentOperationRecord,
  mappings: &[WorkspaceContentIdMapping],
  documents: &[WorkspaceContentMoveDocumentRevision],
  lock: bool,
) -> AuthResult<WorkspaceContentMoveTagManifest> {
  use myoxus_application::workspace_content_operation::preflight::tag_target_is_reusable;
  use myoxus_domain::database::DatabaseViewConfig;
  let target_workspace_id = operation
    .target_workspace_id
    .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str().into()))?;
  let lock_clause = if lock { " FOR SHARE" } else { "" };
  let tag_map = mappings
    .iter()
    .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Tag)
    .map(|mapping| {
      Ok((
        parse_move_uuid(mapping.source.resource_id(), "Tag")?,
        parse_move_uuid(mapping.target.resource_id(), "Tag")?,
      ))
    })
    .collect::<AuthResult<BTreeMap<_, _>>>()?;
  let source_rows = sqlx::query(&format!(
    "{} WHERE workspace_id=$1 AND id=ANY($2) ORDER BY id{lock_clause}",
    PgWorkspaceTagRepository::SELECT_TAG
  ))
  .bind(operation.source_workspace_id)
  .bind(tag_map.keys().copied().collect::<Vec<_>>())
  .fetch_all(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  let mut definitions = source_rows
    .iter()
    .map(PgWorkspaceTagRepository::row_to_tag)
    .collect::<Result<Vec<_>, _>>()
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().into()))?;
  if definitions.len() != tag_map.len() {
    return Err(AuthError::NotFound(
      WorkspaceContentErrorCode::SourceTagMissing.as_str().into(),
    ));
  }
  let target_rows = sqlx::query(&format!(
    "{} WHERE workspace_id=$1 ORDER BY id{lock_clause}",
    PgWorkspaceTagRepository::SELECT_TAG
  ))
  .bind(target_workspace_id)
  .fetch_all(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  let mut catalog = target_rows
    .iter()
    .map(PgWorkspaceTagRepository::row_to_tag)
    .collect::<Result<Vec<_>, _>>()
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().into()))?;
  let retired =
    sqlx::query_scalar::<_, String>("SELECT retired_tag_id FROM workspace_tag_retired_ids WHERE workspace_id=$1")
      .bind(target_workspace_id)
      .fetch_all(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?
      .into_iter()
      .collect::<BTreeSet<_>>();
  let mut materializations = BTreeMap::new();
  definitions.sort_by_key(|tag| (tag.archived_at.is_some(), tag.id));
  for source in &definitions {
    let id = tag_map[&source.id];
    if retired.contains(&id.to_string()) {
      return Err(publication_failure(
        WorkspaceContentErrorCode::PlannedTagIdentityWasRetired,
      ));
    }
    if let Some(target) = catalog.iter().find(|tag| tag.id == id) {
      if !tag_target_is_reusable(
        &source.name,
        source.archived_at.is_some(),
        &target.name,
        target.archived_at.is_some(),
      ) {
        return Err(publication_failure(
          WorkspaceContentErrorCode::PlannedTagIsNoLongerReusable,
        ));
      }
    }
    if let std::collections::btree_map::Entry::Vacant(entry) = materializations.entry(id) {
      let mut tag = source.clone();
      tag.id = id;
      tag.workspace_id = target_workspace_id;
      tag.name = WorkspaceTag::normalize_name(&tag.name)
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::SourceTagInvalid.as_str().into()))?;
      if !catalog.iter().any(|target| target.id == id) {
        catalog.push(tag.clone());
      }
      entry.insert(tag);
    }
  }
  definitions.sort_by_key(|tag| tag.id);
  let mut positions = Vec::new();
  for document in documents {
    let ids = sqlx::query_scalar::<_, Uuid>(&format!(
      "SELECT tag_id FROM workspace_tag_document_assignments WHERE workspace_id=$1 AND doc_id=$2 ORDER BY position{lock_clause}"))
      .bind(operation.source_workspace_id).bind(document.doc_id).fetch_all(&mut **tx).await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    positions.push(WorkspaceContentMoveTagLineage {
      position: WorkspaceContentMoveTagPosition::Document {
        doc_id: document.doc_id,
      },
      target_ids: mapped_tag_ids(&ids, &tag_map)?,
      source_ids: ids,
      container_hash: String::new(),
      context_hash: String::new(),
    });
  }
  // IDs are internal SQL identities. Only typed Tags fields enter the lineage.
  let mut view_configs = BTreeMap::new();
  for mapping in mappings
    .iter()
    .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Database)
  {
    let database_id = parse_move_uuid(mapping.source.resource_id(), "Database")?;
    let fields = sqlx::query_scalar::<_, Uuid>(
      "SELECT id FROM workspace_database_fields WHERE database_id=$1 AND field_type='tags'",
    )
    .bind(database_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .into_iter()
    .collect::<std::collections::HashSet<_>>();
    for row in sqlx::query(
      "SELECT c.row_id,c.field_id,c.value_json FROM workspace_database_cell_values c
       JOIN workspace_database_fields f ON f.id=c.field_id AND f.field_type='tags'
       JOIN workspace_database_rows r ON r.id=c.row_id AND r.deleted_at IS NULL
       WHERE c.database_id=$1 ORDER BY c.row_id,c.field_id",
    )
    .bind(database_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    {
      let ids = tag_cell_ids(row.get("value_json"))?;
      positions.push(WorkspaceContentMoveTagLineage {
        position: WorkspaceContentMoveTagPosition::Cell {
          database_id,
          row_id: row.get("row_id"),
          field_id: row.get("field_id"),
        },
        target_ids: mapped_tag_ids(&ids, &tag_map)?,
        source_ids: ids,
        container_hash: String::new(),
        context_hash: String::new(),
      });
    }
    for row in sqlx::query(
      "SELECT t.id, f.id AS field_id, t.initial_cell_values_json -> f.id::text AS value
       FROM workspace_database_row_templates t
       JOIN workspace_database_fields f ON f.database_id=t.database_id AND f.field_type='tags'
       WHERE t.database_id=$1 AND t.initial_cell_values_json ? f.id::text ORDER BY t.id,f.id",
    )
    .bind(database_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    {
      let ids = tag_cell_ids(row.get("value"))?;
      positions.push(WorkspaceContentMoveTagLineage {
        position: WorkspaceContentMoveTagPosition::Template {
          database_id,
          template_id: row.get("id"),
          field_id: row.get("field_id"),
        },
        target_ids: mapped_tag_ids(&ids, &tag_map)?,
        source_ids: ids,
        container_hash: String::new(),
        context_hash: String::new(),
      });
    }
    for row in sqlx::query("SELECT id, config_json FROM workspace_database_views WHERE database_id=$1 ORDER BY id")
      .bind(database_id)
      .fetch_all(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?
    {
      let view_id: Uuid = row.get("id");
      let raw: serde_json::Value = row.get("config_json");
      let mut config: DatabaseViewConfig = serde_json::from_value(raw.clone())
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
      let container_hash = hash_values(std::slice::from_ref(&raw))?;
      let mut failure = None;
      myoxus_domain::database::rewrite_workspace_content_view_tags(&mut config, &fields, |path, context, ids| {
        match mapped_tag_ids(ids, &tag_map) {
          Ok(target_ids) => {
            positions.push(WorkspaceContentMoveTagLineage {
              position: WorkspaceContentMoveTagPosition::Filter {
                database_id,
                view_id,
                path: path.into(),
              },
              source_ids: ids.to_vec(),
              target_ids,
              container_hash: container_hash.clone(),
              context_hash: context.into(),
            });
          }
          Err(error) => failure = Some(error),
        }
        Ok(ids.to_vec())
      })
      .map_err(|_| {
        error!(
          dependency_code = "MIX_DATABASE_JSON_INVALID",
          cause = WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str(),
          "workspace_content.database_view_invalid"
        );
        AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into())
      })?;
      if let Some(error) = failure {
        return Err(error);
      }
      view_configs.insert((database_id, view_id), raw);
    }
  }
  let origin_id: Option<Uuid> =
    sqlx::query_scalar("SELECT origin_operation_id FROM workspace_content_operation_requests WHERE operation_id=$1")
      .bind(operation.id)
      .fetch_one(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if let Some(origin_id) = origin_id {
    let origin_row = sqlx::query(
      "SELECT m.manifest,m.manifest_hash FROM workspace_content_move_revision_manifests m
       JOIN workspace_content_operations o ON o.id=m.operation_id AND o.status='succeeded'
       WHERE m.operation_id=$1 AND o.source_workspace_id=$2 AND o.target_workspace_id=$3
       AND (EXISTS(SELECT 1 FROM workspace_content_move_publications p WHERE p.operation_id=o.id AND p.manifest_hash=o.manifest_hash)
         OR EXISTS(SELECT 1 FROM workspace_content_extract_publications p WHERE p.operation_id=o.id AND p.manifest_hash=o.manifest_hash))")
      .bind(origin_id).bind(target_workspace_id).bind(operation.source_workspace_id)
      .fetch_optional(&mut **tx).await.map_err(PgWorkspaceContentOperationRepository::storage)?
      .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::UndoHasNoCommittedOriginReceipt))?;
    let origin: WorkspaceContentMoveRevisionManifest = serde_json::from_value(origin_row.get("manifest"))
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().into()))?;
    let origin_value = serde_json::to_value(&origin)
      .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::EncodingFailed.as_str().into()))?;
    if !origin_row
      .get::<String, _>("manifest_hash")
      .eq_ignore_ascii_case(&hash_values(&[origin_value])?)
    {
      return Err(publication_failure(
        WorkspaceContentErrorCode::UndoOriginLineageHashChanged,
      ));
    }
    let origin = origin
      .tags
      .filter(|tags| tags.version == MOVE_TAG_MANIFEST_VERSION)
      .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::UndoTagLineageRequiresAFreshPreview))?;
    let current_positions = positions.clone();
    for position in &mut positions {
      let exact = origin.positions.iter().find(|old| {
        old.position == position.position
          && old.target_ids == position.source_ids
          && old.context_hash == position.context_hash
          && (position.container_hash.is_empty() || old.container_hash == position.container_hash)
      });
      // When a view was edited, restore only a uniquely identifiable unchanged
      // typed rule. Ambiguous duplicate predicates never use guessed offsets.
      let unique = if exact.is_none() && !position.container_hash.is_empty() {
        let matches = |candidate: &&WorkspaceContentMoveTagLineage| {
          same_filter_container(&candidate.position, &position.position)
            && candidate.context_hash == position.context_hash
            && candidate.target_ids == position.source_ids
        };
        let candidates = origin.positions.iter().filter(matches).collect::<Vec<_>>();
        let current_count = current_positions
          .iter()
          .filter(|candidate| {
            same_filter_container(&candidate.position, &position.position)
              && candidate.context_hash == position.context_hash
              && candidate.source_ids == position.source_ids
          })
          .count();
        (candidates.len() == 1 && current_count == 1).then(|| candidates[0])
      } else {
        None
      };
      if let Some(old) = exact.or(unique) {
        let mut restored = Vec::new();
        for id in &old.source_ids {
          let resolved = if catalog.iter().any(|tag| tag.id == *id) {
            *id
          } else {
            let definition = origin.definitions.iter().find(|tag| tag.id == *id).ok_or_else(|| {
              AuthError::InvalidInput(WorkspaceContentErrorCode::StagingManifestInvalid.as_str().into())
            })?;
            if let Some(target) = catalog
              .iter()
              .filter(|target| {
                tag_target_is_reusable(
                  &definition.name,
                  definition.archived_at.is_some(),
                  &target.name,
                  target.archived_at.is_some(),
                )
              })
              .min_by_key(|target| (target.archived_at.is_some(), target.id))
            {
              target.id
            } else {
              let mut allocated = None;
              for suffix in 0..10_000 {
                let id = Uuid::new_v5(&operation.id, format!("undo-tag:{}:{suffix}", definition.id).as_bytes());
                if retired.contains(&id.to_string()) || catalog.iter().any(|tag| tag.id == id) {
                  continue;
                }
                let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_tags WHERE id=$1)")
                  .bind(id)
                  .fetch_one(&mut **tx)
                  .await
                  .map_err(PgWorkspaceContentOperationRepository::storage)?;
                if !exists {
                  allocated = Some(id);
                  break;
                }
              }
              let id = allocated.ok_or_else(|| {
                AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into())
              })?;
              let mut tag = definition.clone();
              tag.id = id;
              tag.workspace_id = target_workspace_id;
              materializations.insert(id, tag.clone());
              catalog.push(tag);
              id
            }
          };
          if !restored.contains(&resolved) {
            restored.push(resolved);
          }
        }
        position.target_ids = restored;
      }
    }
  }
  // Bind each published filter offset to the exact transferred representation.
  // Preserve unknown config properties: only verified typed operands are changed.
  for ((database_id, view_id), mut raw) in view_configs {
    for position in positions.iter().filter(|position| {
      matches!(position.position,
      WorkspaceContentMoveTagPosition::Filter { database_id: d, view_id: v, .. } if d == database_id && v == view_id)
    }) {
      let WorkspaceContentMoveTagPosition::Filter { path, .. } = &position.position else {
        unreachable!()
      };
      let value = raw
        .pointer_mut(&format!("{path}/value"))
        .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
      *value = filter_operand(&position.target_ids, value)?;
    }
    let hash = hash_values(&[raw])?;
    for position in positions.iter_mut().filter(|position| {
      matches!(position.position,
      WorkspaceContentMoveTagPosition::Filter { database_id: d, view_id: v, .. } if d == database_id && v == view_id)
    }) {
      position.container_hash = hash.clone();
    }
  }
  positions.sort_by(|left, right| left.position.cmp(&right.position));
  Ok(WorkspaceContentMoveTagManifest {
    version: MOVE_TAG_MANIFEST_VERSION,
    definitions,
    materializations: materializations.into_values().collect(),
    positions,
  })
}

async fn capture_move_revision_manifest(
  tx: &mut Transaction<'_, Postgres>,
  operation: &WorkspaceContentOperationRecord,
  mappings: &[WorkspaceContentIdMapping],
  lock: bool,
) -> AuthResult<WorkspaceContentMoveRevisionManifest> {
  let lock_clause = if lock { " FOR UPDATE" } else { "" };
  let mut documents = Vec::new();
  let mut reference_plans = Vec::new();
  let mut history_reference_lineage = Vec::new();
  for mapping in mappings
    .iter()
    .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Document)
  {
    let row = sqlx::query(&format!(
      "SELECT id, metadata_revision, to_jsonb(docs) AS metadata
       FROM docs
       WHERE workspace_id = $1 AND external_id = $2 AND deleted_at IS NULL{lock_clause}"
    ))
    .bind(mapping.source.workspace_id())
    .bind(mapping.source.resource_id())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| move_revision_database_error(error, lock))?
    .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::SourceDocumentMissing.as_str().to_string()))?;
    let doc_id: Uuid = row.get("id");
    let (content_sequence, content_hash) =
      capture_doc_content_revision(tx, mapping.source.workspace_id(), doc_id, lock).await?;
    if lock {
      sqlx::query("SELECT user_id FROM doc_user_permissions WHERE doc_id = $1 ORDER BY user_id FOR UPDATE")
        .bind(doc_id)
        .fetch_all(&mut **tx)
        .await
        .map_err(|error| move_revision_database_error(error, lock))?;
    }
    let acl_rows = sqlx::query(
      "SELECT user_id, role
         FROM doc_user_permissions
        WHERE doc_id = $1
        ORDER BY user_id, role",
    )
    .bind(doc_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|error| move_revision_database_error(error, lock))?
    .into_iter()
    .map(|row| {
      serde_json::json!({
        "userId": row.get::<Uuid, _>("user_id"),
        "role": row.get::<String, _>("role"),
      })
    })
    .collect::<Vec<_>>();
    let (snapshot, reference_source_sha256) =
      crate::doc::SqlxDocStore::load_reference_snapshot_in_tx(tx, mapping.source.workspace_id(), doc_id).await?;
    let mut exists = BTreeMap::new();
    for target in myoxus_application::workspace_content_operation::copy::native_document_reference_targets(
      &mapping.source,
      &snapshot,
    )? {
      let canonical = resolve_document_reference_in_tx(tx, &target).await?;
      exists.insert(target, canonical);
    }
    reference_plans.push(
      myoxus_application::workspace_content_operation::copy::prepare_native_reference_plan_with_resolver(
        &mapping.source,
        &snapshot,
        mappings,
        false,
        |target| std::future::ready(Ok(exists.get(&target).cloned().flatten())),
      )
      .await?,
    );
    history_reference_lineage
      .extend(crate::doc::reference_lineage::capture_in_tx(tx, doc_id, &mapping.source, mappings).await?);
    documents.push(WorkspaceContentMoveDocumentRevision {
      resource: mapping.source.clone(),
      doc_id,
      content_sequence,
      content_hash,
      reference_source_sha256: Some(reference_source_sha256),
      metadata_revision: row.get("metadata_revision"),
      metadata_hash: hash_values(&[row.get("metadata")])?,
      acl_hash: hash_values(&acl_rows)?,
      ownership_row_counts: ownership_row_counts(tx, mapping.source.workspace_id(), doc_id, lock).await?,
    });
  }

  let mut blobs = Vec::new();
  for mapping in mappings
    .iter()
    .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Blob)
  {
    let metadata: serde_json::Value = sqlx::query_scalar(&format!(
      "SELECT to_jsonb(blobs) FROM blobs
       WHERE workspace_id = $1 AND key = $2 AND deleted_at IS NULL{lock_clause}"
    ))
    .bind(mapping.source.workspace_id())
    .bind(mapping.source.resource_id())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| move_revision_database_error(error, lock))?
    .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::SourceBlobMissing.as_str().to_string()))?;
    blobs.push(WorkspaceContentMoveBlobRevision {
      resource: mapping.source.clone(),
      metadata_hash: hash_values(&[metadata])?,
    });
  }

  // Reuse the coherent transaction-local document reader and canonical Organizer
  // codec. Only contained placements are bound; unrelated rows stay out of the fence.
  let folder_doc_id: Option<Uuid> = sqlx::query_scalar(&format!(
    "SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2 AND deleted_at IS NULL{lock_clause}"
  ))
  .bind(operation.source_workspace_id)
  .bind(format!("db${}$folders", operation.source_workspace_id))
  .fetch_optional(&mut **tx)
  .await
  .map_err(|error| move_revision_database_error(error, lock))?;
  let source_organizer_bytes = match folder_doc_id {
    Some(id) => {
      crate::doc::SqlxDocStore::load_reference_snapshot_in_tx(tx, operation.source_workspace_id, id)
        .await?
        .0
    }
    None => Vec::new(),
  };
  let source_organizer = OrganizerSnapshot::from_update(operation.source_workspace_id, &source_organizer_bytes)
    .map_err(myoxus_application::workspace_content_operation::organizer_failure)?;
  let mut organizer_targets = BTreeMap::new();
  for row in source_organizer.contained_resource_rows(mappings) {
    if let Some(resource) = row
      .resource_reference(operation.source_workspace_id)
      .map_err(myoxus_application::workspace_content_operation::organizer_failure)?
    {
      let target = resolve_resource_reference_in_tx(tx, &resource).await?;
      organizer_targets.insert(resource, target);
    }
  }
  let organizer_reference_decisions =
    myoxus_application::workspace_content_operation::organizer_stage::prepare_organizer_reference_decisions(
      &source_organizer,
      mappings,
      |resource| {
        std::future::ready(
          organizer_targets
            .get(&resource)
            .cloned()
            .ok_or_else(|| AuthError::Storage(WorkspaceContentErrorCode::InventoryInvalid.as_str().into())),
        )
      },
    )
    .await?;
  let organizer_reference_revision = source_organizer.contained_reference_revision(mappings);
  let mut organizer_roots = Vec::new();
  let mut workspace_ids = [
    operation.source_workspace_id,
    operation
      .target_workspace_id
      .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str().to_string()))?,
  ];
  workspace_ids.sort();
  for workspace_id in workspace_ids {
    sqlx::query(&format!(
      "SELECT id FROM docs
       WHERE workspace_id = $1 AND id = $1 AND is_workspace_root AND deleted_at IS NULL{lock_clause}"
    ))
    .bind(workspace_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| move_revision_database_error(error, lock))?
    .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::SourceRootMissing.as_str().to_string()))?;
    let (content_sequence, content_hash) = capture_doc_content_revision(tx, workspace_id, workspace_id, lock).await?;
    organizer_roots.push(WorkspaceContentMoveOrganizerRevision {
      workspace_id,
      content_sequence,
      content_hash,
    });
  }

  let mut databases = Vec::new();
  for mapping in mappings
    .iter()
    .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Database)
  {
    let database_id = parse_move_uuid(mapping.source.resource_id(), "Database")?;
    let parent_edit_revision: i64 = sqlx::query_scalar(&format!(
      "SELECT edit_revision FROM workspace_databases
       WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL{lock_clause}"
    ))
    .bind(mapping.source.workspace_id())
    .bind(database_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| move_revision_database_error(error, lock))?
    .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::SourceDatabaseMissing.as_str().to_string()))?;
    let child_rows = capture_database_child_revisions(tx, mapping.source.workspace_id(), database_id, lock).await?;
    databases.push(WorkspaceContentMoveDatabaseRevision {
      resource: mapping.source.clone(),
      parent_edit_revision,
      child_revision_hash: hash_values(&child_rows)?,
      ownership_row_counts: database_ownership_row_counts(tx, mapping.source.workspace_id(), database_id, lock).await?,
    });
  }

  let mut workspaces = Vec::new();
  let mut overview_states = BTreeMap::new();
  for workspace_id in workspace_ids {
    let row = sqlx::query(&format!(
      "SELECT id, owner_principal_type::text AS owner_principal_type,
              owner_principal_id, overview_settings, overview_revision, to_jsonb(workspaces) AS policy
       FROM workspaces WHERE id = $1 AND deleted_at IS NULL{lock_clause}"
    ))
    .bind(workspace_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| move_revision_database_error(error, lock))?
    .ok_or_else(|| {
      AuthError::NotFound(
        WorkspaceContentErrorCode::PublicationWorkspaceMissing
          .as_str()
          .to_string(),
      )
    })?;
    let membership_rows = sqlx::query(&format!(
      "SELECT to_jsonb(membership) AS membership
       FROM workspace_memberships membership
       WHERE workspace_id = $1
       ORDER BY user_id{lock_clause}"
    ))
    .bind(workspace_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|error| move_revision_database_error(error, lock))?
    .into_iter()
    .map(|row| row.get("membership"))
    .collect::<Vec<serde_json::Value>>();
    if myoxus_application::workspace_content_operation::overview::has_folder_mappings(mappings) {
      overview_states.insert(workspace_id, workspace_overview_state(&row, workspace_id)?);
    }
    workspaces.push(WorkspaceContentMoveWorkspaceRevision {
      workspace_id,
      owner_principal_type: row.get("owner_principal_type"),
      owner_principal_id: row.get("owner_principal_id"),
      policy_hash: hash_values(&[row.get("policy")])?,
      membership_hash: hash_values(&membership_rows)?,
    });
  }

  documents.sort_by(|left, right| left.resource.cmp(&right.resource));
  blobs.sort_by(|left, right| left.resource.cmp(&right.resource));
  databases.sort_by(|left, right| left.resource.cmp(&right.resource));
  let tags = capture_move_tag_manifest(tx, operation, mappings, &documents, lock).await?;
  let origin = sqlx::query(
    "SELECT o.kind, o.manifest_hash, t.source_folder_id, t.source_workspace_id,
            t.target_workspace_id, t.published_at, p.manifest_hash AS publication_hash
       FROM workspace_content_operation_requests r
       JOIN workspace_content_operations o ON o.id=r.origin_operation_id
       LEFT JOIN workspace_content_extract_targets t ON t.operation_id=o.id
       LEFT JOIN workspace_content_extract_publications p ON p.operation_id=o.id
      WHERE r.operation_id=$1",
  )
  .bind(operation.id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  let undo_extract_folder_id =
    if let Some(origin) = origin.filter(|row| row.get::<String, _>("kind") == "extract_folder") {
      let folder: Option<String> = origin.get("source_folder_id");
      if folder.as_ref().is_none_or(|folder| {
        !mappings.iter().any(|mapping| {
          mapping.target.kind() == WorkspaceContentResourceKind::Folder && mapping.target.resource_id() == folder
        })
      }) || origin.get::<Option<Uuid>, _>("source_workspace_id") != operation.target_workspace_id
        || origin.get::<Option<Uuid>, _>("target_workspace_id") != Some(operation.source_workspace_id)
        || origin.get::<Option<chrono::DateTime<Utc>>, _>("published_at").is_none()
        || origin.get::<Option<String>, _>("publication_hash").as_deref()
          != Some(origin.get::<String, _>("manifest_hash").as_str())
      {
        return Err(publication_failure(
          WorkspaceContentErrorCode::UndoExtractHasNoMatchingPublishedFolderReceipt,
        ));
      }
      folder
    } else {
      None
    };
  let overview = if myoxus_application::workspace_content_operation::overview::has_folder_mappings(mappings) {
    let target_workspace_id = operation
      .target_workspace_id
      .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::TargetWorkspaceMissing))?;
    Some(
      myoxus_application::workspace_content_operation::overview::WorkspaceContentOverviewSnapshot {
        source: overview_states
          .remove(&operation.source_workspace_id)
          .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::PublicationWorkspaceMissing))?,
        target: Some(
          overview_states
            .remove(&target_workspace_id)
            .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::PublicationWorkspaceMissing))?,
        ),
        extracted_folder_id: if operation.kind == WorkspaceContentOperationKind::ExtractFolder {
          Some(
            sqlx::query_scalar("SELECT source_folder_id FROM workspace_content_extract_targets WHERE operation_id=$1")
              .bind(operation.id)
              .fetch_one(&mut **tx)
              .await
              .map_err(PgWorkspaceContentOperationRepository::storage)?,
          )
        } else {
          None
        },
      },
    )
  } else {
    None
  };
  Ok(WorkspaceContentMoveRevisionManifest {
    overview,
    organizer_reference_decisions: Some(organizer_reference_decisions),
    organizer_reference_revision: Some(organizer_reference_revision),
    reference_plans: Some(reference_plans),
    history_reference_lineage,
    tags: Some(tags),
    undo_extract_folder_id,
    documents,
    blobs,
    organizer_roots,
    databases,
    workspaces,
  })
}

fn parse_move_uuid(value: &str, _kind: &str) -> AuthResult<Uuid> {
  Uuid::parse_str(value)
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into()))
}

pub(crate) fn move_conflict(error: sqlx::Error) -> AuthError {
  // PostgreSQL error details can include conflicting row values. SQLSTATE
  // retains the failure category without copying document or resource data.
  let database_code = error
    .as_database_error()
    .and_then(|error| error.code())
    .map(|code| code.into_owned());
  let constraint = error.as_database_error().and_then(|error| error.constraint());
  let table = error.as_database_error().and_then(|error| error.table());
  let code = match (database_code.as_deref(), constraint) {
    (Some("23503"), Some("workspace_tag_document_assignments_workspace_id_tag_id_fkey")) => {
      WorkspaceContentErrorCode::TagAssignmentConstraint
    }
    (Some("23503"), _) => WorkspaceContentErrorCode::DatabaseForeignKeyConstraint,
    (Some("23505"), _) => WorkspaceContentErrorCode::DatabaseUniqueConstraint,
    (Some("23514"), _) => WorkspaceContentErrorCode::DatabaseCheckConstraint,
    (Some("23502"), _) => WorkspaceContentErrorCode::DatabaseNotNullConstraint,
    (Some("40001"), _) => WorkspaceContentErrorCode::PublicationSerializationConflict,
    (Some("40P01"), _) => WorkspaceContentErrorCode::PublicationDeadlock,
    _ => {
      error!(
        database_code,
        database_error_kind = "sqlx",
        "workspace_content.database_unavailable"
      );
      return PgWorkspaceContentOperationRepository::storage(error);
    }
  };
  // PostgreSQL DETAIL contains row values. Schema-owned names and SQLSTATE
  // identify the precise violated condition without copying that payload.
  error!(
    database_code,
    constraint,
    table,
    cause = code.as_str(),
    "workspace_content.publication_constraint_failed"
  );
  AuthError::InvalidInput(code.as_str().into())
}

fn move_revision_database_error(error: sqlx::Error, publication_lock: bool) -> AuthError {
  let is_serialization_failure = error
    .as_database_error()
    .and_then(|database_error| database_error.code())
    .is_some_and(|code| code == "40001");
  if publication_lock && is_serialization_failure {
    move_conflict(error)
  } else {
    PgWorkspaceContentOperationRepository::storage(error)
  }
}

async fn insert_move_redirect(
  tx: &mut Transaction<'_, Postgres>,
  operation_id: Uuid,
  mapping: &WorkspaceContentIdMapping,
) -> AuthResult<()> {
  // The transaction proved ownership of this departing live address. A later
  // departure after Undo must replace its prior hop, not leave a redirect cycle.
  sqlx::query(
    "INSERT INTO workspace_content_operation_redirects
       (operation_id, source_workspace_id, source_kind, source_id,
        target_workspace_id, target_kind, target_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source_workspace_id, source_kind, source_id) DO UPDATE
       SET operation_id = EXCLUDED.operation_id,
           target_workspace_id = EXCLUDED.target_workspace_id,
           target_kind = EXCLUDED.target_kind,
           target_id = EXCLUDED.target_id,
           created_at = now()",
  )
  .bind(operation_id)
  .bind(mapping.source.workspace_id())
  .bind(mapping.source.kind().as_str())
  .bind(mapping.source.resource_id())
  .bind(mapping.target.workspace_id())
  .bind(mapping.target.kind().as_str())
  .bind(mapping.target.resource_id())
  .execute(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  Ok(())
}

async fn verify_extract_target(
  tx: &mut Transaction<'_, Postgres>,
  batch: &WorkspaceContentMovePublicationBatch,
) -> AuthResult<()> {
  let target_workspace_id = batch
    .operation
    .target_workspace_id
    .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::ExtractTargetWorkspaceIsMissing))?;
  let row = sqlx::query(
    "SELECT source_workspace_id, source_folder_id, target_workspace_id,
            owner_principal_type::text AS owner_principal_type, owner_principal_id,
            membership_snapshot
       FROM workspace_content_extract_targets
      WHERE operation_id = $1 AND published_at IS NULL
      FOR UPDATE",
  )
  .bind(batch.operation.id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?
  .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::ExtractTargetReceiptIsMissing))?;
  if row.get::<Uuid, _>("source_workspace_id") != batch.operation.source_workspace_id
    || row.get::<Uuid, _>("target_workspace_id") != target_workspace_id
    || Some(row.get::<String, _>("source_folder_id").as_str()) != batch.extract_source_folder_id.as_deref()
  {
    return Err(publication_failure(
      WorkspaceContentErrorCode::ExtractTargetReceiptChanged,
    ));
  }
  let target_owner = sqlx::query(
    "SELECT owner_principal_type::text AS owner_principal_type, owner_principal_id
       FROM workspaces WHERE id = $1 AND lifecycle_state = 'extracting'
         AND lifecycle_owner_kind = 'workspace_content' AND lifecycle_owner_id = $2
         AND deleted_at IS NULL",
  )
  .bind(target_workspace_id)
  .bind(batch.operation.id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?
  .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::ExtractTargetLifecycleOwnershipChanged))?;
  if target_owner.get::<String, _>("owner_principal_type") != row.get::<String, _>("owner_principal_type")
    || target_owner.get::<Option<Uuid>, _>("owner_principal_id") != Some(row.get::<Uuid, _>("owner_principal_id"))
  {
    return Err(publication_failure(
      WorkspaceContentErrorCode::ExtractTargetOwnershipChanged,
    ));
  }
  let expected_memberships = row.get::<serde_json::Value, _>("membership_snapshot");
  // The target is private to this operation. Its start-time snapshot is
  // immutable; the source is allowed to change membership after admission.
  for workspace_id in [target_workspace_id] {
    let memberships = sqlx::query(
      "SELECT user_id, role FROM workspace_memberships
        WHERE workspace_id = $1 AND status = 'Accepted'
        ORDER BY user_id FOR SHARE",
    )
    .bind(workspace_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .into_iter()
    .map(|member| {
      let role = workspace_role(&member.get::<String, _>("role"))?;
      Ok(serde_json::json!({
        "userId": member.get::<Uuid, _>("user_id"),
        "role": role,
      }))
    })
    .collect::<AuthResult<Vec<_>>>()?;
    if serde_json::Value::Array(memberships) != expected_memberships {
      return Err(publication_failure(
        WorkspaceContentErrorCode::ExtractMembershipSnapshotChanged,
      ));
    }
  }
  let valid_root: bool = sqlx::query_scalar(
    "SELECT EXISTS(
       SELECT 1 FROM docs d
       JOIN doc_updates u ON u.doc_id = d.id AND u.workspace_id = d.workspace_id
       WHERE d.id = $1 AND d.workspace_id = $1 AND d.is_workspace_root
         AND d.deleted_at IS NULL AND u.sequence = 1 AND octet_length(u.payload) > 0
     )",
  )
  .bind(target_workspace_id)
  .fetch_one(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if !valid_root {
    return Err(publication_failure(WorkspaceContentErrorCode::ExtractTargetRootChanged));
  }
  Ok(())
}

async fn verify_publication_manifest(
  tx: &mut Transaction<'_, Postgres>,
  batch: &WorkspaceContentCopyPublicationBatch,
) -> AuthResult<()> {
  let mapping_rows = sqlx::query(
    r#"
    SELECT source_workspace_id, source_kind, source_id,
           target_workspace_id, target_kind, target_id
    FROM workspace_content_operation_mappings
    WHERE operation_id = $1
    ORDER BY source_workspace_id, source_kind, source_id
    FOR UPDATE
    "#,
  )
  .bind(batch.operation.id)
  .fetch_all(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  let mut durable_mappings = mapping_rows
    .into_iter()
    .map(|row| {
      WorkspaceContentIdMapping::new(
        make_resource(
          row.get("source_workspace_id"),
          row.get("source_kind"),
          row.get("source_id"),
        )?,
        make_resource(
          row.get("target_workspace_id"),
          row.get("target_kind"),
          row.get("target_id"),
        )?,
      )
      .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))
    })
    .collect::<AuthResult<Vec<_>>>()?;
  durable_mappings.sort_by(|left, right| left.source.cmp(&right.source));
  let mut expected_mappings = batch.mappings.clone();
  expected_mappings.sort_by(|left, right| left.source.cmp(&right.source));
  if durable_mappings != expected_mappings {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string(),
    ));
  }

  let staging_rows = sqlx::query(
    r#"
    SELECT sequence, resource_workspace_id, resource_kind, resource_id,
           object_key, content_hash, size_bytes, publication_status
    FROM workspace_content_operation_staging
    WHERE operation_id = $1
    ORDER BY sequence
    FOR UPDATE
    "#,
  )
  .bind(batch.operation.id)
  .fetch_all(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if staging_rows.len() != batch.staging_entries.len() {
    return Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string(),
    ));
  }
  for (row, expected) in staging_rows.into_iter().zip(&batch.staging_entries) {
    if row.get::<i32, _>("sequence") != expected.sequence
      || make_resource(
        row.get("resource_workspace_id"),
        row.get("resource_kind"),
        row.get("resource_id"),
      )? != expected.resource
      || row.get::<String, _>("object_key") != expected.object_key()
      || !row
        .get::<String, _>("content_hash")
        .eq_ignore_ascii_case(expected.content_hash())
      || row.get::<i64, _>("size_bytes") != expected.size_bytes
      || row.get::<String, _>("publication_status") != WorkspaceContentStagingStatus::Staged.as_str()
      || expected.status != WorkspaceContentStagingStatus::Staged
    {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::StagingManifestInvalid.as_str().to_string(),
      ));
    }
  }

  Ok(())
}

/// Rewrite canonical typed values only. SQL identities and relational/nested
/// identities remain unchanged; the existing reference projection is rebuilt
/// inside the publication transaction after every moved Doc owns its target.
async fn publish_move_database_references(
  tx: &mut Transaction<'_, Postgres>,
  batch: &WorkspaceContentMovePublicationBatch,
) -> AuthResult<()> {
  use crate::workspace_database::PgDatabaseRepository;
  let target_workspace_id = batch
    .operation
    .target_workspace_id
    .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::MoveTargetMissing))?;
  let blobs = batch
    .mappings
    .iter()
    .filter(|mapping| mapping.source.kind() == WorkspaceContentResourceKind::Blob)
    .map(|mapping| {
      (
        mapping.source.resource_id().to_string(),
        mapping.target.resource_id().to_string(),
      )
    })
    .collect::<std::collections::HashMap<_, _>>();
  let documents = batch
    .revision_manifest
    .documents
    .iter()
    .map(|doc| (doc.doc_id, doc.doc_id))
    .collect::<std::collections::HashMap<_, _>>();
  let source_documents = batch
    .revision_manifest
    .documents
    .iter()
    .filter_map(|document| {
      batch
        .mappings
        .iter()
        .find(|mapping| mapping.source == document.resource)
        .map(|mapping| {
          (
            document.doc_id,
            mapping.source.resource_id().to_string(),
            mapping.target.resource_id().to_string(),
          )
        })
    })
    .collect::<Vec<_>>();
  for database in &batch.revision_manifest.databases {
    let id = parse_move_uuid(database.resource.resource_id(), "Database")?;
    PgDatabaseRepository::publish_workspace_content_database_references(
      tx,
      batch.operation.source_workspace_id,
      target_workspace_id,
      id,
      &source_documents,
      &documents,
      &blobs,
    )
    .await?;
  }
  Ok(())
}

async fn publish_operation_blob_catalog(
  tx: &mut Transaction<'_, Postgres>,
  target_workspace_id: Uuid,
  objects: &[OperationBlobMaterialization],
) -> AuthResult<()> {
  for object in objects {
    let resource = &object.resource;
    let content_type = &object.content_type;
    let checksum = &object.sha256;
    let size = i64::try_from(object.size_bytes)
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::BlobSizeLimit.as_str().to_string()))?;
    let inserted = sqlx::query(
      r#"
          INSERT INTO blobs (workspace_id, key, size, mime, checksum, status, deleted_at)
          VALUES ($1, $2, $3, $4, $5, 'completed', NULL)
          ON CONFLICT (workspace_id, key) DO NOTHING
          "#,
    )
    .bind(target_workspace_id)
    .bind(resource.resource_id())
    .bind(size)
    .bind(content_type)
    .bind(&checksum)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .rows_affected();
    if inserted == 0 {
      let exact: bool = sqlx::query_scalar(
        r#"
            SELECT EXISTS (
              SELECT 1 FROM blobs
              WHERE workspace_id = $1 AND key = $2 AND size = $3
                AND mime = $4 AND lower(checksum) = lower($5)
                AND status = 'completed' AND deleted_at IS NULL
              FOR UPDATE
            )
            "#,
      )
      .bind(target_workspace_id)
      .bind(resource.resource_id())
      .bind(size)
      .bind(content_type)
      .bind(&checksum)
      .fetch_one(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
      if !exact {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::TargetBlobMetadataConflict
            .as_str()
            .to_string(),
        ));
      }
    } else {
      sqlx::query(
        r#"
            INSERT INTO workspace_storage_stats (workspace_id, blob_size, updated_at)
            VALUES ($1, $2, now())
            ON CONFLICT (workspace_id) DO UPDATE
              SET blob_size = workspace_storage_stats.blob_size + EXCLUDED.blob_size,
                  updated_at = now()
            "#,
      )
      .bind(target_workspace_id)
      .bind(size)
      .execute(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    }
  }

  Ok(())
}

async fn verify_operation_blob_quota(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: Uuid,
  objects: &[OperationBlobMaterialization],
  default_workspace_quota_mb: u64,
) -> AuthResult<()> {
  sqlx::query(
    "INSERT INTO workspace_storage_stats (workspace_id, snapshot_size, blob_size, updated_at)
     VALUES ($1, 0, 0, now())
     ON CONFLICT (workspace_id) DO NOTHING",
  )
  .bind(workspace_id)
  .execute(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  let workspace_policy = sqlx::query(
    r#"
    SELECT w.storage_quota_bytes AS workspace_quota_bytes,
           COALESCE(s.snapshot_size, 0)::BIGINT AS snapshot_bytes,
           COALESCE(s.blob_size, 0)::BIGINT AS blob_bytes
    FROM workspaces w
    JOIN workspace_storage_stats s ON s.workspace_id = w.id
    WHERE w.id = $1 AND w.deleted_at IS NULL
    FOR UPDATE OF w, s
    "#,
  )
  .bind(workspace_id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?
  .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str().to_string()))?;
  let quota = myoxus_application::quota::effective_quota_bytes(
    workspace_policy.get("workspace_quota_bytes"),
    default_workspace_quota_mb,
  );
  let current_usage = workspace_policy
    .get::<i64, _>("snapshot_bytes")
    .saturating_add(workspace_policy.get::<i64, _>("blob_bytes"))
    .max(0) as u64;
  let mut write_bytes = 0_u64;
  for object in objects {
    let resource = &object.resource;
    let content_type = &object.content_type;
    let checksum = &object.sha256;
    let existing = sqlx::query(
      "SELECT size, mime, checksum, status, deleted_at
       FROM blobs WHERE workspace_id = $1 AND key = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(resource.resource_id())
    .fetch_optional(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
    if let Some(existing) = existing {
      if existing.get::<i64, _>("size") != object.size_bytes as i64
        || existing.get::<String, _>("mime") != *content_type
        || !existing
          .get::<Option<String>, _>("checksum")
          .as_deref()
          .is_some_and(|value| value.eq_ignore_ascii_case(&checksum))
        || existing.get::<String, _>("status") != "completed"
        || existing
          .get::<Option<chrono::DateTime<chrono::Utc>>, _>("deleted_at")
          .is_some()
      {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::TargetBlobMetadataConflict
            .as_str()
            .to_string(),
        ));
      }
    } else {
      write_bytes = write_bytes.saturating_add(object.size_bytes);
    }
  }
  if let Err(exceeded) = myoxus_application::quota::check_quota(current_usage, write_bytes, quota) {
    return Err(AuthError::StorageQuotaExceeded {
      workspace_id,
      current_bytes: exceeded.current_bytes,
      write_bytes: exceeded.write_bytes,
      quota_bytes: exceeded.quota_bytes,
    });
  }
  Ok(())
}

async fn apply_operation_memberships(
  tx: &mut Transaction<'_, Postgres>,
  operation_id: WorkspaceContentOperationId,
  target_workspace_id: Uuid,
) -> AuthResult<()> {
  let value: serde_json::Value = sqlx::query_scalar(
    "SELECT execution_memberships
       FROM workspace_content_operation_requests
      WHERE operation_id = $1",
  )
  .bind(operation_id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?
  .ok_or_else(|| AuthError::NotFound(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().to_string()))?;
  let memberships: Vec<WorkspaceContentExecutionMembership> = serde_json::from_value(value)
    .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::InventoryInvalid.as_str().to_string()))?;
  for membership in memberships {
    let inserted = sqlx::query(
      "INSERT INTO workspace_memberships
         (workspace_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'Accepted', now())
       ON CONFLICT (workspace_id, user_id) DO NOTHING",
    )
    .bind(target_workspace_id)
    .bind(membership.user_id)
    .bind(workspace_role_name(membership.role))
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .rows_affected();
    if inserted == 0 {
      let exact: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM workspace_memberships
            WHERE workspace_id = $1 AND user_id = $2
              AND role = $3 AND status = 'Accepted'
         )",
      )
      .bind(target_workspace_id)
      .bind(membership.user_id)
      .bind(workspace_role_name(membership.role))
      .fetch_one(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
      if !exact {
        return Err(publication_failure(
          WorkspaceContentErrorCode::WorkspaceContentTargetMembershipChanged,
        ));
      }
    }
  }
  Ok(())
}

#[expect(
  clippy::too_many_arguments,
  reason = "the transactional insert keeps copied identity and projection values explicit"
)]
async fn insert_copy_document(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: Uuid,
  actor_id: Uuid,
  external_id: &str,
  doc_id: Uuid,
  title: &str,
  yjs_update: &[u8],
  projection: &DocumentMetadataProjection,
) -> AuthResult<()> {
  let field = |key: &str| {
    projection
      .fields
      .iter()
      .find(|field| field.key == key && field.source == DocumentMetadataSource::Document)
  };
  let reference = |key: &str| {
    field(key)
      .and_then(|field| field.reference.as_ref())
      .map(|value| value.id)
  };
  let timestamp = |key: &str| field(key).and_then(|field| field.timestamp_value);
  let text = |key: &str| field(key).and_then(|field| field.text_value.clone());
  let responsible_user_id = field("responsible").and_then(|field| field.user_id);
  if let Some(user_id) = responsible_user_id {
    let valid: bool = sqlx::query_scalar("SELECT document_metadata_is_valid_responsible_user($1, $2)")
      .bind(workspace_id)
      .bind(user_id)
      .fetch_one(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    if !valid {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::OwnershipUnsupported.as_str().to_string(),
      ));
    }
  }
  sqlx::query(
    r#"
    INSERT INTO docs (
      id, external_id, workspace_id, title, is_workspace_root, default_role,
      created_by, updated_by, created_at, updated_at,
      status_id, document_type_id, classification_id, retention_policy_id,
      language_id, responsible_user_id, document_number, review_due_at,
      valid_from, valid_until, journal_date, metadata_revision,
      metadata_updated_at, metadata_updated_by,
      status_source, document_type_source, classification_source,
      retention_policy_source, language_source, responsible_source
    )
    VALUES (
      $1, $2, $3, $4, false, 'viewer',
      $5, $5, now(), now(),
      $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 1,
      now(), $5,
      $17, $18, $19, $20, $21, $22
    )
    "#,
  )
  .bind(doc_id)
  .bind(external_id)
  .bind(workspace_id)
  .bind(title)
  .bind(actor_id)
  .bind(reference("status"))
  .bind(reference("documentType"))
  .bind(reference("classification"))
  .bind(reference("retentionPolicy"))
  .bind(reference("language"))
  .bind(responsible_user_id)
  .bind(text("documentNumber"))
  .bind(timestamp("reviewDueAt"))
  .bind(timestamp("validFrom"))
  .bind(timestamp("validUntil"))
  .bind(projection.journal.journal_date)
  .bind(metadata_source(field("status")))
  .bind(metadata_source(field("documentType")))
  .bind(metadata_source(field("classification")))
  .bind(metadata_source(field("retentionPolicy")))
  .bind(metadata_source(field("language")))
  .bind(metadata_source(field("responsible")))
  .execute(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;

  let payload_hash = Sha256::digest(yjs_update).to_vec();
  sqlx::query(
    "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence, payload_sha256)
     VALUES ($1, $2, $3, 1, $4)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(yjs_update)
  .bind(payload_hash)
  .execute(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  sqlx::query("INSERT INTO doc_user_permissions (user_id, doc_id, role) VALUES ($1, $2, 'Owner')")
    .bind(actor_id)
    .bind(doc_id)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;

  for audience in projection
    .audience
    .iter()
    .filter(|audience| audience.source == DocumentMetadataSource::Document)
  {
    sqlx::query(
      "INSERT INTO doc_audience_assignment
         (doc_id, audience_id, source, assigned_by)
       VALUES ($1, $2, 'document', $3)",
    )
    .bind(doc_id)
    .bind(audience.value.id)
    .bind(actor_id)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  }
  if let Some(template) = &projection.template {
    // Workspace template instances are source-owned. A copied document keeps
    // its global template/revision provenance but must not point back into the
    // source workspace's managed instance.
    let state = if template.instance_id.is_some() {
      "detached"
    } else {
      template.state.as_str()
    };
    sqlx::query(
      r#"
      INSERT INTO document_template_state
        (doc_id, template_id, revision_id, instance_id, state, source, updated_by)
      VALUES ($1, $2, $3, $4, $5, 'document', $6)
      "#,
    )
    .bind(doc_id)
    .bind(template.template_id)
    .bind(template.revision_id)
    .bind(Option::<Uuid>::None)
    .bind(state)
    .bind(actor_id)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  }
  if let Some(presentation) = &projection.presentation {
    sqlx::query(
      r#"
      INSERT INTO document_presentation_state
        (doc_id, primary_mode, page_width, edgeless_color_theme, updated_by)
      VALUES ($1, $2, $3, $4, $5)
      "#,
    )
    .bind(doc_id)
    .bind(&presentation.primary_mode)
    .bind(&presentation.page_width)
    .bind(&presentation.edgeless_color_theme)
    .bind(actor_id)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  }
  if let Some(integration_type) = projection
    .integration
    .as_ref()
    .and_then(|integration| integration.integration_type.as_deref())
  {
    sqlx::query(
      "INSERT INTO document_integration_state
         (doc_id, integration_type, updated_by)
       VALUES ($1, $2, $3)",
    )
    .bind(doc_id)
    .bind(integration_type)
    .bind(actor_id)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  }
  Ok(())
}

fn metadata_source(field: Option<&myoxus_domain::entities::DocumentMetadataFieldValue>) -> &'static str {
  field
    .map(|field| field.source.as_storage())
    .unwrap_or(DocumentMetadataSource::Fallback.as_storage())
}

async fn ensure_system_document(
  tx: &mut Transaction<'_, Postgres>,
  operation_id: Uuid,
  workspace_id: Uuid,
  external_id: &str,
  actor_id: Uuid,
) -> AuthResult<Uuid> {
  if let Some(doc_id) = sqlx::query_scalar::<_, Uuid>(
    "SELECT id FROM docs
     WHERE workspace_id = $1 AND external_id = $2 AND deleted_at IS NULL
     FOR UPDATE",
  )
  .bind(workspace_id)
  .bind(external_id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?
  {
    return Ok(doc_id);
  }
  let doc_id = Uuid::new_v5(
    &operation_id,
    format!("system-document:{workspace_id}:{external_id}").as_bytes(),
  );
  sqlx::query(
    "INSERT INTO docs
       (id, workspace_id, external_id, title, is_workspace_root, created_by, updated_by)
     VALUES ($1, $2, $3, '', false, $4, $4)",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(external_id)
  .bind(actor_id)
  .execute(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  Ok(doc_id)
}

async fn append_copy_update(
  tx: &mut Transaction<'_, Postgres>,
  doc_id: Uuid,
  workspace_id: Uuid,
  update: &[u8],
) -> AuthResult<i64> {
  let payload_hash = Sha256::digest(update).to_vec();
  let sequence = sqlx::query_scalar(
    r#"
    INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence, payload_sha256)
    VALUES (
      $1, $2, $3,
      GREATEST(
        COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE workspace_id = $2 AND doc_id = $1), 0),
        COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id = $2 AND doc_id = $1), 0)
      ) + 1,
      $4
    )
    RETURNING sequence
    "#,
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(update)
  .bind(payload_hash)
  .fetch_one(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  sqlx::query("UPDATE docs SET sync_state_vector_v1 = NULL WHERE id = $1 AND workspace_id = $2")
    .bind(doc_id)
    .bind(workspace_id)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  Ok(sequence)
}

async fn load_full_move_doc(
  tx: &mut Transaction<'_, Postgres>,
  workspace_id: Uuid,
  doc_id: Uuid,
) -> AuthResult<Vec<u8>> {
  let snapshot =
    sqlx::query("SELECT payload, last_sequence FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
  let (snapshot_payload, last_sequence) = snapshot
    .map(|row| (row.get::<Vec<u8>, _>("payload"), row.get::<i64, _>("last_sequence")))
    .unwrap_or_else(|| (Vec::new(), -1));
  let tail = sqlx::query_scalar::<_, Vec<u8>>(
    "SELECT payload FROM doc_updates
     WHERE workspace_id = $1 AND doc_id = $2 AND sequence > $3
     ORDER BY sequence",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(last_sequence)
  .fetch_all(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  let mut updates = Vec::with_capacity(tail.len() + usize::from(!snapshot_payload.is_empty()));
  if !snapshot_payload.is_empty() {
    updates.push(snapshot_payload);
  }
  updates.extend(tail);
  match updates.len() {
    0 => Ok(Vec::new()),
    1 => Ok(updates.pop().unwrap_or_default()),
    _ => yjs::merge_updates(updates)
      .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::DocumentSnapshotInvalid.as_str().to_string())),
  }
}

async fn lock_reuse_target(
  tx: &mut Transaction<'_, Postgres>,
  resource: &WorkspaceContentResourceRef,
) -> AuthResult<()> {
  let found = match resource.kind() {
    WorkspaceContentResourceKind::Tag => {
      let id = parse_target_uuid(resource, "Tag")?;
      sqlx::query_scalar::<_, i32>("SELECT 1 FROM workspace_tags WHERE workspace_id = $1 AND id = $2 FOR UPDATE")
        .bind(resource.workspace_id())
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?
        .is_some()
    }
    WorkspaceContentResourceKind::Database => {
      let id = parse_target_uuid(resource, "Database")?;
      sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM workspace_databases
         WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
         FOR UPDATE",
      )
      .bind(resource.workspace_id())
      .bind(id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?
      .is_some()
    }
    _ => true,
  };
  if found {
    Ok(())
  } else {
    Err(AuthError::InvalidInput(
      WorkspaceContentErrorCode::TargetDefinitionMissing.as_str().to_string(),
    ))
  }
}

fn parse_target_uuid(resource: &WorkspaceContentResourceRef, _label: &str) -> AuthResult<Uuid> {
  Uuid::parse_str(resource.resource_id())
    .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into()))
}

fn publication_resources(batch: &WorkspaceContentCopyPublicationBatch) -> Vec<WorkspaceContentResourceRef> {
  let mut resources = BTreeSet::new();
  for mapping in &batch.mappings {
    resources.insert(mapping.source.clone());
    resources.insert(mapping.target.clone());
  }
  resources.into_iter().collect()
}

/// One materialization owner for Copy and identity-preserving transfers.
/// Private intents precede I/O; canonical catalog and receipt fences decide cleanup.
/// Stage one bounded set of assets through the existing private intent owner.
/// Metadata/accounting stays invisible until SQL publication. The caller keeps
/// cumulative keys so failures in later source reads compensate earlier writes.
async fn materialize_operation_blobs(
  pool: &PgPool,
  storage: &dyn BlobStoragePort,
  operation: &WorkspaceContentOperationRecord,
  objects: &[WorkspaceContentPublicationObject],
  phase: &mut &'static str,
  sequence_offset: usize,
  newly_written_blob_keys: &mut BTreeSet<String>,
) -> AuthResult<Vec<OperationBlobMaterialization>> {
  let target_workspace_id = operation
    .target_workspace_id
    .ok_or_else(|| AuthError::InvalidInput(WorkspaceContentErrorCode::TargetWorkspaceMissing.as_str().into()))?;
  *phase = "blob_materialization";
  let mut proofs = Vec::new();
  for (blob_index, object) in objects.iter().enumerate() {
    let WorkspaceContentPublicationObject::Blob {
      resource,
      bytes,
      content_type,
    } = object
    else {
      continue;
    };
    if resource.workspace_id() != target_workspace_id {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into(),
      ));
    }
    let storage_key = format!("{target_workspace_id}/{}", resource.resource_id());
    let row = sqlx::query("SELECT EXISTS(SELECT 1 FROM blobs WHERE workspace_id=$2 AND key=$3 AND deleted_at IS NULL AND status='completed') AS canonical,
      EXISTS(SELECT 1 FROM workspace_content_operation_compensations WHERE operation_id=$1 AND kind='delete_operation_blob' AND target_workspace_id=$2 AND target_kind='blob' AND target_id=$3) AS previously_owned")
      .bind(operation.id).bind(target_workspace_id).bind(resource.resource_id()).fetch_one(pool).await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    let canonical: bool = row.get("canonical");
    let previously_owned: bool = row.get("previously_owned");
    match storage.read_blob(&storage_key).await {
      Ok(existing) if existing.data == *bytes => {
        if !canonical && !previously_owned {
          return Err(AuthError::InvalidInput(
            WorkspaceContentErrorCode::TargetBlobBytesConflict.as_str().into(),
          ));
        }
        if previously_owned {
          newly_written_blob_keys.insert(storage_key.clone());
        }
      }
      Ok(_) => {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::BlobIntegrityMismatch.as_str().into(),
        ));
      }
      Err(PortError::NotFound(_)) => {
        // Intent precedes I/O, including a write that reports an ambiguous
        // error after creating a partial object. Live catalogs fence cleanup.
        PgWorkspaceContentOperationRepository::new(
          pool.clone(),
          std::sync::Arc::new(
            crate::database_templates::load_database_template_catalog(
              &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/databases"),
            )
            .expect("database catalog fixture"),
          ),
        )
        .append_compensation(WorkspaceContentCompensationIntent {
          operation_id: operation.id,
          sequence: 1_000_000
            + i64::try_from(sequence_offset + blob_index)
              .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::ResourceCountInvalid.as_str().into()))?,
          kind: "delete_operation_blob".into(),
          target: resource.clone(),
        })
        .await?;
        newly_written_blob_keys.insert(storage_key.clone());
        storage
          .write_blob(BlobWriteRequest {
            key: storage_key.clone(),
            content_type: Some(content_type.clone()),
            body: bytes.clone(),
          })
          .await
          .map_err(publication_storage)?;
        let readback = storage.read_blob(&storage_key).await.map_err(publication_storage)?;
        if readback.data != *bytes {
          return Err(AuthError::Storage(
            WorkspaceContentErrorCode::BlobIntegrityMismatch.as_str().into(),
          ));
        }
      }
      Err(error) => return Err(publication_storage(error)),
    }
    proofs.push(OperationBlobMaterialization {
      operation_id: operation.id,
      resource: resource.clone(),
      object_key: storage_key,
      sha256: hex::encode(Sha256::digest(bytes)),
      size_bytes: bytes.len() as u64,
      content_type: content_type.clone(),
      ownership: if canonical {
        OperationBlobOwnership::Reused
      } else {
        OperationBlobOwnership::OperationOwned
      },
    });
  }
  Ok(proofs)
}

/// Recovery state never replaces the primary failure. Cancellation retains
/// its distinct recovery action instead of becoming eligible for publication.
async fn persist_materialization_cleanup_failure(
  pool: &PgPool,
  operation_id: Uuid,
  failure: &RedactedWorkspaceContentError,
) {
  if let Err(error) = sqlx::query("UPDATE workspace_content_operations SET status='cleanup_required',
    error_code=CASE WHEN status='cancelled' OR error_code='XWS_CANCELLATION_CLEANUP_REQUIRED' THEN 'XWS_CANCELLATION_CLEANUP_REQUIRED' ELSE $2 END,
    error_message=CASE WHEN status='cancelled' OR error_code='XWS_CANCELLATION_CLEANUP_REQUIRED' THEN 'The cancelled operation still requires cleanup of unpublished objects.' ELSE $3 END,
    error_phase=CASE WHEN status='cancelled' OR error_code='XWS_CANCELLATION_CLEANUP_REQUIRED' THEN 'compensation' ELSE $4 END,
    updated_at=now() WHERE id=$1 AND status IN ('running','cancelled','cleanup_required')")
    .bind(operation_id).bind(failure.code.as_str()).bind(failure.message()).bind(&failure.phase)
    .execute(pool).await
  {
    let error = PgWorkspaceContentOperationRepository::storage(error);
    let cause = match &error {
      AuthError::InvalidInput(code) | AuthError::Storage(code) => code.as_str(),
      _ => WorkspaceContentErrorCode::UnexpectedValidation.as_str(),
    };
    error!(operation_id = %operation_id, phase = "compensation", initial_cause = failure.code.as_str(), cause,
      "workspace_content.failure_persistence_failed");
  }
}

/// A failed ACK cannot authorize deletion. Serialize against the operation
/// transaction, then protect every live catalog entry (including another
/// operation's publication) before deleting only a recorded private intent.
#[tracing::instrument(skip_all, fields(%operation_id, phase = "publication_receipt"))]
async fn operation_publication_receipt(
  pool: &PgPool,
  operation_id: Uuid,
) -> AuthResult<Option<WorkspaceContentOperationRecord>> {
  let mut tx = pool
    .begin()
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  let row = sqlx::query(&format!("{RECORD_SELECT} WHERE id=$1 FOR UPDATE"))
    .bind(operation_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  let record = map_record(&row)?;
  let committed: bool =
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_content_copy_publications WHERE operation_id=$1) OR EXISTS(SELECT 1 FROM workspace_content_move_publications WHERE operation_id=$1) OR EXISTS(SELECT 1 FROM workspace_content_extract_publications WHERE operation_id=$1)")
      .bind(operation_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
  tx.commit()
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if committed { Ok(Some(record)) } else { Ok(None) }
}

#[tracing::instrument(skip_all, fields(%operation_id, phase = "compensation"))]
async fn cleanup_operation_blob_keys(
  pool: &PgPool,
  storage: &dyn BlobStoragePort,
  operation_id: Uuid,
  keys: &BTreeSet<String>,
) -> AuthResult<()> {
  if keys.is_empty() {
    return Ok(());
  }
  let mut tx = pool
    .begin()
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  // Keep the receipt lock until external deletion finishes. A concurrent
  // delivery of this operation cannot publish after a stale absence check.
  sqlx::query("SELECT id FROM workspace_content_operations WHERE id=$1 FOR UPDATE")
    .bind(operation_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  cleanup_operation_blob_keys_in_tx(&mut tx, storage, operation_id, keys).await?;
  tx.commit()
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  Ok(())
}

/// The caller holds the operation receipt lock until deletion and intent
/// completion commit together. Reuse this fence during Extract recovery too.
async fn cleanup_operation_blob_keys_in_tx(
  tx: &mut Transaction<'_, Postgres>,
  storage: &dyn BlobStoragePort,
  operation_id: Uuid,
  keys: &BTreeSet<String>,
) -> AuthResult<()> {
  for key in keys {
    let Some((scope, blob_key)) = key.split_once('/') else {
      return Err(AuthError::InvalidInput(
        WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into(),
      ));
    };
    let workspace_id = Uuid::parse_str(scope)
      .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into()))?;
    let owned_unpublished: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM workspace_content_operation_compensations WHERE operation_id=$1 AND kind='delete_operation_blob' AND target_workspace_id=$2 AND target_kind='blob' AND target_id=$3)
       AND NOT EXISTS(SELECT 1 FROM blobs WHERE workspace_id=$2 AND key=$3 AND deleted_at IS NULL)
       AND NOT EXISTS(SELECT 1 FROM workspace_content_copy_publications WHERE operation_id=$1)
       AND NOT EXISTS(SELECT 1 FROM workspace_content_move_publications WHERE operation_id=$1)
       AND NOT EXISTS(SELECT 1 FROM workspace_content_extract_publications WHERE operation_id=$1)")
      .bind(operation_id).bind(workspace_id).bind(blob_key).fetch_one(&mut **tx).await.map_err(PgWorkspaceContentOperationRepository::storage)?;
    // Reuse the Blob owner's accounting/catalog fence, including unrelated
    // canonical import references. It serializes publication through deletion.
    let unreferenced = crate::blob::SqlxBlobStore::lock_unreferenced_import_object_cleanup_in_tx(tx, key).await?;
    if owned_unpublished
      && unreferenced
      && let Err(error) = storage.delete_blob(key).await
    {
      error!(operation_id = %operation_id, phase = "compensation", error_kind = port_error_kind(&error), "workspace_content.compensation_failed");
      return Err(AuthError::Storage(
        WorkspaceContentErrorCode::BlobCompensationFailed.as_str().into(),
      ));
    }
    if owned_unpublished && unreferenced {
      sqlx::query(
        "UPDATE workspace_content_operation_compensations
            SET completed_at = now(), last_error_code = NULL, last_error_message = NULL
          WHERE operation_id = $1 AND kind = 'delete_operation_blob'
            AND target_workspace_id = $2 AND target_kind = 'blob' AND target_id = $3",
      )
      .bind(operation_id)
      .bind(workspace_id)
      .bind(blob_key)
      .execute(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    }
  }
  Ok(())
}

fn publication_storage(error: PortError) -> AuthError {
  let error_kind = port_error_kind(&error);
  error!(error_kind, "workspace content target Blob storage failed");
  match error {
    PortError::InvalidInput(_) => {
      AuthError::InvalidInput(WorkspaceContentErrorCode::MappingPlanInvalid.as_str().into())
    }
    PortError::Conflict(_) => {
      AuthError::InvalidInput(WorkspaceContentErrorCode::TargetBlobBytesConflict.as_str().into())
    }
    PortError::NotFound(_) | PortError::Transport(_) => {
      AuthError::Storage(WorkspaceContentErrorCode::BlobMaterializationFailed.as_str().into())
    }
  }
}

fn port_error_kind(error: &PortError) -> &'static str {
  match error {
    PortError::InvalidInput(_) => "invalid_input",
    PortError::NotFound(_) => "not_found",
    PortError::Conflict(_) => "conflict",
    PortError::Transport(_) => "transport",
  }
}

fn publication_repository_error(error: myoxus_domain::repositories::RepositoryError) -> AuthError {
  use myoxus_domain::repositories::RepositoryError;
  let (code, kind) = match error {
    RepositoryError::NotFound(_) => (WorkspaceContentErrorCode::TargetDefinitionMissing, "not_found"),
    RepositoryError::Conflict(_) => (WorkspaceContentErrorCode::DatabaseUniqueConstraint, "conflict"),
    RepositoryError::Validation(_) => (WorkspaceContentErrorCode::MappingPlanInvalid, "validation"),
    RepositoryError::Storage(_) => (WorkspaceContentErrorCode::DatabaseUnavailable, "storage"),
  };
  error!(
    error_kind = kind,
    cause = code.as_str(),
    "workspace_content.tag_persistence_failed"
  );
  if code.retryable() {
    AuthError::Storage(code.as_str().into())
  } else {
    AuthError::InvalidInput(code.as_str().into())
  }
}

fn publication_tag_error(error: myoxus_domain::workspace_tags::WorkspaceTagAssignmentError) -> AuthError {
  use myoxus_domain::workspace_tags::WorkspaceTagAssignmentError;
  let error_kind = match &error {
    WorkspaceTagAssignmentError::InvalidReferences => "invalid_references",
    WorkspaceTagAssignmentError::ArchivedReference => "archived_reference",
    WorkspaceTagAssignmentError::Repository(_) => "repository",
  };
  error!(error_kind, "workspace_content.tag_assignment_failed");
  match error {
    WorkspaceTagAssignmentError::InvalidReferences | WorkspaceTagAssignmentError::ArchivedReference => {
      AuthError::InvalidInput(WorkspaceContentErrorCode::TagAssignmentConstraint.as_str().into())
    }
    WorkspaceTagAssignmentError::Repository(error) => publication_database_error(error),
  }
}

pub(crate) fn publication_database_error(error: myoxus_domain::repositories::RepositoryError) -> AuthError {
  use myoxus_domain::repositories::RepositoryError;
  let error_kind = match &error {
    RepositoryError::NotFound(_) => "not_found",
    RepositoryError::Conflict(_) => "conflict",
    RepositoryError::Validation(_) => "validation",
    RepositoryError::Storage(_) => "storage",
  };
  let code = match &error {
    RepositoryError::Conflict(code) => {
      WorkspaceContentErrorCode::parse(code).unwrap_or(WorkspaceContentErrorCode::DatabaseCheckConstraint)
    }
    RepositoryError::NotFound(code) => {
      WorkspaceContentErrorCode::parse(code).unwrap_or(WorkspaceContentErrorCode::DatabaseIdentityInvalid)
    }
    RepositoryError::Validation(_) => WorkspaceContentErrorCode::DatabaseSnapshotInvalid,
    RepositoryError::Storage(_) => WorkspaceContentErrorCode::DatabaseUnavailable,
  };
  error!(
    error_kind,
    cause = code.as_str(),
    reason = code.safe_message(),
    "workspace_content.repository_failed"
  );
  if code.retryable() {
    AuthError::Storage(code.as_str().into())
  } else {
    AuthError::InvalidInput(code.as_str().into())
  }
}
