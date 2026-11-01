//! SQLx-backed document store implementation.
//!
//! [`SqlxDocStore`] implements the [`DocStore`] application port against
//! PostgreSQL. It stores document metadata, Yjs update payloads with
//! sequence numbers, compacted snapshots, history entries for rollback,
//! and per-document permission records.

use std::collections::{BTreeSet, HashMap};

use async_trait::async_trait;
use futures_util::TryStreamExt;
use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::doc::{
  DocContentMutationCommit, DocDeleteCandidate, DocHistoryEntry, DocHistoryMetadataEntry, DocHistoryStore,
  DocLoadCancellation, DocLoadStore, DocMetadataStore, DocPermissionStore, DocRevisionCheckedUpdateOutcome,
  DocSnapshotStore, DocStateStreamMeta, DocStore, DocTitleBackfillCandidate, DocUpdate, DocUpdatePersistenceOutcome,
  DocUpdatePersistenceResult, DocUpdateStore, DocUpdateStreamStats, DocUpdateWrite, DocViewStore, DocWriteTarget,
  PageLifecycleAuditState, PageLifecycleCommand, PageLifecycleCommit, PageLifecycleDelta, PageLifecycleRepairCommand,
  PageLifecycleRepairCommit, SourceRetirementOwnership, canonical_yjs_revision,
};
use myoxus_application::doc::{InitialDocumentProvenanceSource, resolve_initial_document_provenance};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgRow};
use tracing::{debug, error, info, instrument, trace};
use uuid::Uuid;
use yrs::{ReadTxn, Transact};

use myoxus_domain::{
  document_key::DocumentKey,
  entities::{Doc as DocModel, DocRole},
};

use crate::document_metadata::initial_sync_audit::workspace_document_first_create_lock_key;

mod organizer_retirement;
pub(crate) mod reference_lineage;
mod registration;

use crate::document_version::edit_capture_state::{self, lock_key as workspace_document_lock_key};

fn map_history_metadata(row: &PgRow) -> AuthResult<DocHistoryMetadataEntry> {
  let origin = row
    .get::<Option<String>, _>("origin")
    .map(|value| {
      myoxus_application::doc::history::DocHistoryOrigin::parse(&value)
        .ok_or_else(|| AuthError::Storage(format!("unknown document history origin: {value}")))
    })
    .transpose()?;
  Ok(DocHistoryMetadataEntry {
    id: row.get("id"),
    doc_id: row.get("doc_id"),
    workspace_id: row.get("workspace_id"),
    created_at: row.get("created_at"),
    origin,
    actor_id: row.get("actor_id"),
    actor_name: row.get("actor_name"),
    actor_avatar_key: row.get("actor_avatar_key"),
  })
}

fn map_history_row(row: PgRow) -> AuthResult<DocHistoryEntry> {
  let metadata = map_history_metadata(&row)?;
  Ok(DocHistoryEntry {
    id: metadata.id,
    doc_id: metadata.doc_id,
    workspace_id: metadata.workspace_id,
    snapshot: row.get("snapshot"),
    created_at: metadata.created_at,
    origin: metadata.origin,
    actor_id: metadata.actor_id,
    actor_name: metadata.actor_name,
    actor_avatar_key: metadata.actor_avatar_key,
  })
}

/// PostgreSQL-backed implementation of [`DocStore`].
pub struct SqlxDocStore {
  /// Database connection pool.
  pool: PgPool,
  database_templates: Option<std::sync::Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>>,
  /// Optional Redis cache for quota checks (P38 performance optimization).
  /// When present, quota and usage are read from cache first, falling back
  /// to DB on cache miss. Write-through updates cache after each write.
  quota_cache: Option<std::sync::Arc<crate::quota_cache::QuotaCache>>,
  /// Default workspace storage quota in MB. 0 = unlimited.
  default_workspace_quota_mb: u64,
}

enum ContentChange<'a> {
  Semantic(&'a yjs::DocumentMutation),
  Snapshot(&'a [u8]),
}

impl SqlxDocStore {
  async fn hard_delete_doc_scoped_inner(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    expected_revision: Option<(i64, SourceRetirementOwnership)>,
  ) -> AuthResult<bool> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let organizer_id: Option<Uuid> =
      sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2 AND deleted_at IS NULL")
        .bind(workspace_id)
        .bind(format!("db${workspace_id}$folders"))
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    let external_id: Option<String> =
      sqlx::query_scalar("SELECT external_id FROM docs WHERE id = $1 AND workspace_id = $2")
        .bind(doc_id)
        .bind(workspace_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?
        .flatten();
    let key = external_id.clone().unwrap_or_else(|| doc_id.to_string());
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(workspace_document_first_create_lock_key(workspace_id, &key))
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    // Resolve the complete root/leaf/Organizer lock set before acquiring it;
    // adding a lower UUID later would invert the sync writer's lock ordering.
    let mut lock_ids = BTreeSet::from([workspace_id, doc_id]);
    lock_ids.extend(organizer_id);
    for locked_doc_id in lock_ids {
      sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(workspace_document_lock_key(workspace_id, locked_doc_id))
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    // Revalidate after waiting: Move may have transferred the identity while
    // this delete was acquiring the same canonical document locks.
    let exists = sqlx::query_scalar::<_, i32>("SELECT 1 FROM docs WHERE id = $1 AND workspace_id = $2 FOR UPDATE")
      .bind(doc_id)
      .bind(workspace_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    if exists.is_none() {
      return Ok(false);
    }
    if let Some((expected, ownership)) = expected_revision {
      let actual: i64 = sqlx::query_scalar("SELECT GREATEST(COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE workspace_id=$1 AND doc_id=$2),0),COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id=$1 AND doc_id=$2),0))")
        .bind(workspace_id).bind(doc_id).fetch_one(&mut *tx).await.map_err(Self::map_db_err)?;
      if actual != expected {
        return Err(AuthError::InvalidInput("TEMPLATE_SOURCE_CONTENT_CHANGED".into()));
      }
      let owned: Option<Uuid> = match ownership {
        SourceRetirementOwnership::ManagedAssignment => sqlx::query_scalar("SELECT i.id FROM document_template_state t JOIN workspace_template_instances i ON i.workspace_doc_id=t.doc_id AND (t.instance_id IS NULL OR i.id=t.instance_id) AND (t.template_id IS NULL OR i.template_id=t.template_id) AND (t.revision_id IS NULL OR i.revision_id=t.revision_id) JOIN workspace_template_policies p ON p.workspace_id=i.workspace_id AND p.template_id=i.template_id WHERE t.doc_id=$2 AND t.state IN ('seeded','managed') AND i.workspace_id=$1 AND i.workspace_doc_id=$2 AND i.state='retired' AND p.is_enabled AND p.selection_mode='published' AND p.provisioning_mode='managed_until_local_edit' FOR UPDATE OF i,p,t")
          .bind(workspace_id).bind(doc_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?,
        SourceRetirementOwnership::ConfirmedUnboundTemplate => sqlx::query_scalar("SELECT t.doc_id FROM document_template_state t WHERE t.doc_id=$2 AND t.state IN ('seeded','managed','detached') AND t.template_id IS NULL AND t.instance_id IS NULL AND t.revision_id IS NULL AND NOT EXISTS(SELECT 1 FROM workspace_template_instances i WHERE i.workspace_id=$1 AND (i.workspace_doc_id=$2 OR i.workspace_doc_key=$3 OR i.workspace_doc_key=$2::text)) FOR UPDATE OF t")
          .bind(workspace_id).bind(doc_id).bind(&key).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?,
      };
      if owned.is_none() {
        return Err(AuthError::InvalidInput("TEMPLATE_SOURCE_OWNERSHIP_CHANGED".into()));
      }
    }
    crate::template_registry::reject_managed_source_write(&mut tx, workspace_id, doc_id).await?;
    if registration::normal_page(workspace_id, &key) {
      sqlx::query(
        "INSERT INTO page_registration_evidence (workspace_id, external_id, doc_id, state)
         VALUES ($1, $2, $3, 'deleted')
         ON CONFLICT (workspace_id, external_id) DO UPDATE SET state = 'deleted'",
      )
      .bind(workspace_id)
      .bind(&key)
      .bind(doc_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      // Close the interval between the caller's root removal and this delete.
      // A previously unseen stale entry may have arrived during that interval.
      let root = Self::load_full_doc_in_tx(&mut tx, workspace_id, workspace_id).await?;
      let removal = yjs::remove_pages_from_root_doc(&root, std::slice::from_ref(&key)).map_err(AuthError::Storage)?;
      if removal.removed_entries > 0 {
        let root = Self::append_lifecycle_delta(&mut tx, workspace_id, workspace_id, removal.update).await?;
        Self::append_workspace_doc_broadcast_outbox(&mut tx, doc_id, workspace_id, None, "page_registration", &[root])
          .await?;
      }
    }
    let mut doc_keys = vec![doc_id.to_string()];
    if let Some(external_id) = external_id
      && external_id != doc_id.to_string()
    {
      doc_keys.push(external_id);
    }

    // Organizer rows are CRDT references, not SQL foreign keys. Commit their
    // tombstones/index removal with the identity deletion and realtime outbox.
    if let Some(organizer_id) = organizer_id {
      let payload = Self::load_full_doc_in_tx(&mut tx, workspace_id, organizer_id).await?;
      let removal =
        myoxus_application::organizer::remove_document_links(&payload, workspace_id, workspace_id, &doc_keys).map_err(
          |error| {
            tracing::error!(%workspace_id, %doc_id, %organizer_id, phase="permanent_delete", error_kind=error.diagnostic_kind(), "document_delete.organizer_projection_failed");
            AuthError::Storage(
              "DOC_DELETE_ORGANIZER_DECODE_FAILED: folder references could not be read; document was not deleted"
                .into(),
            )
          },
        )?;
      if !removal.update.is_empty() {
        let delta = Self::append_lifecycle_delta(&mut tx, workspace_id, organizer_id, removal.update).await?;
        Self::append_workspace_doc_broadcast_outbox(
          &mut tx,
          doc_id,
          workspace_id,
          None,
          "document_permanent_delete",
          &[delta],
        )
        .await?;
      }
      debug!(%workspace_id, %doc_id, organizer_entries_removed = removal.entry_ids.len(), "document_delete.organizer_projected");
    }

    // Remove explicitly owned update data before the document identity.
    sqlx::query("DELETE FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;

    sqlx::query("DELETE FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $2")
      .bind(workspace_id)
      .bind(doc_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;

    // These denormalized context tables intentionally store client-facing
    // document keys as TEXT and therefore cannot rely on docs(id) FK cascades.
    sqlx::query(
      "DELETE FROM copilot_embeddings WHERE workspace_id = $1 AND source_type = 'doc' AND source_id = ANY($2)",
    )
    .bind(workspace_id)
    .bind(&doc_keys)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    sqlx::query(
      "DELETE FROM copilot_context_items
       WHERE item_type = 'doc'
         AND item_ref = ANY($1)
         AND context_id IN (SELECT id FROM copilot_contexts WHERE workspace_id = $2)",
    )
    .bind(&doc_keys)
    .bind(workspace_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    // Delete the workspace-scoped identity last; its foreign-key cascades then
    // remove every remaining relational dependent.
    let deleted = sqlx::query("DELETE FROM docs WHERE id = $1 AND workspace_id = $2")
      .bind(doc_id)
      .bind(workspace_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .rows_affected()
      > 0;

    tx.commit().await.map_err(Self::map_db_err)?;
    info!(%workspace_id, %doc_id, outcome = "deleted", "document_delete.committed");
    Ok(deleted)
  }

  fn map_document_mutation_error(error: yjs::DocumentMutationError) -> AuthError {
    match error {
      yjs::DocumentMutationError::TargetNotFound => {
        AuthError::InvalidInput("MIX_DOCUMENT_MUTATION_TARGET_NOT_FOUND".to_string())
      }
      yjs::DocumentMutationError::AmbiguousHeading => {
        AuthError::InvalidInput("MIX_DOCUMENT_MUTATION_TARGET_AMBIGUOUS".to_string())
      }
      yjs::DocumentMutationError::EmptyFragment => {
        AuthError::InvalidInput("MIX_DOCUMENT_MUTATION_FRAGMENT_EMPTY".to_string())
      }
      yjs::DocumentMutationError::InvalidFragment => {
        AuthError::InvalidInput("MIX_DOCUMENT_MUTATION_FRAGMENT_INVALID".to_string())
      }
      yjs::DocumentMutationError::InvalidTextRange => {
        AuthError::InvalidInput("MIX_DOCUMENT_MUTATION_TEXT_RANGE_INVALID".to_string())
      }
      yjs::DocumentMutationError::ExpectedTextMismatch => {
        AuthError::InvalidInput("MIX_DOCUMENT_MUTATION_EXPECTED_TEXT_MISMATCH".to_string())
      }
      yjs::DocumentMutationError::MoveCycle => AuthError::InvalidInput("MIX_DOCUMENT_MUTATION_MOVE_CYCLE".to_string()),
      yjs::DocumentMutationError::InvalidBlockProperties => {
        AuthError::InvalidInput("MIX_DOCUMENT_MUTATION_BLOCK_PROPERTIES_INVALID".to_string())
      }
      yjs::DocumentMutationError::InvalidDocument | yjs::DocumentMutationError::MissingContentRoot => {
        AuthError::Storage("canonical Yjs document state is invalid".to_string())
      }
    }
  }

  /// Shared normal-page boundary for automatic capture and change windows.
  /// Roots, database/userdata records, retired identities and trash are excluded.
  async fn normal_document_eligible_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<bool> {
    edit_capture_state::eligible(tx, workspace_id, doc_id)
      .await
      .map_err(Self::map_db_err)
  }

  async fn mark_edit_capture_dirty_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
    revision: i64,
  ) -> AuthResult<bool> {
    edit_capture_state::mark_dirty(tx, workspace_id, doc_id, revision)
      .await
      .map_err(Self::map_db_err)
  }

  /// Current-state capture acknowledges its materialized revision; naming an
  /// older snapshot does not acknowledge pending automatic work.
  async fn acknowledge_edit_capture_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
    snapshot: &[u8],
  ) -> AuthResult<()> {
    let revision: i64 = sqlx::query_scalar(
      "SELECT GREATEST(
      COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE workspace_id=$1 AND doc_id=$2),0),
      COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id=$1 AND doc_id=$2),0))",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    edit_capture_state::acknowledge(
      tx,
      workspace_id,
      doc_id,
      revision,
      &Sha256::digest(snapshot),
      None,
      chrono::Utc::now(),
    )
    .await
    .map_err(Self::map_db_err)
  }
  async fn capture_history_in_tx(
    &self,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
    provenance: myoxus_application::doc::history::HistoryCaptureProvenance,
    named: Option<myoxus_application::doc::history::NamedHistoryCapture>,
  ) -> Result<myoxus_application::doc::history::HistoryCapture, myoxus_application::doc::history::HistoryCaptureError>
  {
    use crate::document_metadata::PgDocumentMetadataRepository;
    use crate::document_version::PgDocumentVersionRepository;
    use myoxus_application::doc::history::HistoryCapture;
    use myoxus_domain::entities::{DocumentVersion, DocumentVersionCreateInput};

    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(workspace_document_lock_key(workspace_id, doc_id))
      .execute(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query_scalar::<_, i32>(
      "SELECT 1 FROM docs WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::NotFound("document".into()))?;

    let snapshot = Self::load_full_doc_in_tx(tx, workspace_id, doc_id).await?;
    if named.as_ref().is_some_and(|request| request.skip_unchanged) {
      let latest: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT h.snapshot FROM document_version v JOIN doc_histories h ON h.id = v.doc_history_id
         WHERE v.doc_id = $1 ORDER BY v.created_at DESC, h.id DESC LIMIT 1",
      )
      .bind(doc_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
      if latest.is_some_and(|latest| Sha256::digest(&latest) == Sha256::digest(&snapshot)) {
        Self::acknowledge_edit_capture_in_tx(tx, workspace_id, doc_id, &snapshot).await?;
        return Ok(HistoryCapture::Unchanged);
      }
    }

    let captured_at = chrono::Utc::now();
    let history_id: i64 = sqlx::query_scalar(
      "INSERT INTO doc_histories (doc_id, workspace_id, snapshot, created_at, origin, actor_id, reference_workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $2) RETURNING id",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(&snapshot)
    .bind(captured_at)
    .bind(provenance.origin.as_str())
    .bind(provenance.actor_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;

    crate::history_git_sync::record_history_capture(tx, workspace_id, history_id)
      .await
      .map_err(Self::map_db_err)?;

    Self::acknowledge_edit_capture_in_tx(tx, workspace_id, doc_id, &snapshot).await?;

    let result = if let Some(request) = named {
      let counter = match &request.label.counter_key {
        Some(key) => Some(PgDocumentVersionRepository::next_counter_in_tx(tx, doc_id, key).await?),
        None => None,
      };
      let label = request.label.render(counter)?;
      let mut version = DocumentVersion::new_for_create(DocumentVersionCreateInput {
        id: Uuid::new_v4(),
        doc_id,
        workspace_id,
        doc_history_id: history_id,
        label: label.label,
        description: request.description,
        event: request.event,
        kind: request.kind,
        created_by: request.actor_id,
        created_at: captured_at,
        is_pinned: false,
        is_protected: false,
        policy_id: label.policy_id,
        policy_snapshot: serde_json::json!({}),
        content_hash: Some(hex::encode(Sha256::digest(&snapshot))),
        metadata: serde_json::json!({}),
      });
      // Simple-counter labels and version_no share the existing `seq` counter.
      // Supplying the reserved number prevents the INSERT trigger consuming it twice.
      if label.counter_key.as_deref() == Some("seq") {
        version.version_no = label.counter_value;
      }
      let version = PgDocumentVersionRepository::create_in_tx(tx, &version).await?;
      PgDocumentMetadataRepository::mark_current_version_in_tx(tx, doc_id, version.id, captured_at, request.actor_id)
        .await?;
      HistoryCapture::Version(version)
    } else {
      HistoryCapture::Snapshot(history_id)
    };
    Ok(result)
  }
  /// Caller must hold the document's advisory write lock. Rename and semantic
  /// edits share this check so a precondition cannot race either write owner.
  async fn check_content_revision_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
    expected_sequence: Option<i64>,
  ) -> AuthResult<()> {
    let Some(expected_sequence) = expected_sequence else {
      return Ok(());
    };
    if expected_sequence < 0 {
      return Err(AuthError::InvalidInput(
        "expected revision must be non-negative".to_string(),
      ));
    }
    let current_sequence: i64 = sqlx::query_scalar(
      "SELECT GREATEST(
        COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE workspace_id=$1 AND doc_id=$2),0),
        COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id=$1 AND doc_id=$2),0))",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    if expected_sequence != current_sequence {
      return Err(AuthError::InvalidInput(format!(
        "MIX_DOCUMENT_MUTATION_CONFLICT: expected revision {expected_sequence}, current revision {current_sequence}"
      )));
    }
    Ok(())
  }

  async fn mutate_content_in_tx(
    &self,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
    actor_user_id: Option<Uuid>,
    mutation: ContentChange<'_>,
    capture_recovery_history: bool,
    expected_sequence: Option<i64>,
    project_root_title: bool,
  ) -> AuthResult<DocContentMutationCommit> {
    crate::mcp_idempotency::lock_document_write(tx, actor_user_id).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(workspace_document_lock_key(workspace_id, doc_id))
      .execute(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;

    let exists: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM docs WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL)",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    if !exists {
      return Err(AuthError::NotFound("document".to_string()));
    }

    let snapshot =
      sqlx::query("SELECT payload, last_sequence FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $2")
        .bind(workspace_id)
        .bind(doc_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Self::map_db_err)?;
    let (snapshot_payload, last_sequence) = snapshot
      .map(|row| (row.get::<Vec<u8>, _>("payload"), row.get::<i64, _>("last_sequence")))
      .unwrap_or_else(|| (Vec::new(), -1));
    Self::check_content_revision_in_tx(tx, workspace_id, doc_id, expected_sequence).await?;
    let tail = sqlx::query_scalar::<_, Vec<u8>>(
      "SELECT payload FROM doc_updates
       WHERE workspace_id = $1 AND doc_id = $2 AND sequence > $3
       ORDER BY sequence ASC",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(last_sequence)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    let mut updates = Vec::with_capacity(tail.len() + 1);
    if !snapshot_payload.is_empty() {
      updates.push(snapshot_payload);
    }
    updates.extend(tail);
    let current = if updates.is_empty() {
      yrs::Doc::new().transact().encode_diff_v1(&yrs::StateVector::default())
    } else {
      yjs::merge_updates(updates).map_err(|_| AuthError::Storage("persisted Yjs state is invalid".to_string()))?
    };

    let operation = match &mutation {
      ContentChange::Semantic(mutation) => mutation.name(),
      ContentChange::Snapshot(_) => "restore_snapshot",
    };
    let is_semantic_edit = matches!(&mutation, ContentChange::Semantic(_));
    // A restore still records intentional history when its captured state is
    // current; only the change-window producer is suppressed in that case.
    let unchanged_restore = matches!(&mutation, ContentChange::Snapshot(snapshot) if *snapshot == current.as_slice());
    // Validate and derive the entire delta before the first history/data write.
    let applied = match mutation {
      ContentChange::Snapshot(snapshot) => {
        let delta = yjs::restore_document_snapshot(&current, snapshot)
          .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
        let state = yjs::merge_updates(vec![current.clone(), delta.clone()])
          .map_err(|_| AuthError::Storage("restored Yjs state is invalid".to_string()))?;
        yjs::DocumentMutationOutput {
          delta,
          state,
          inserted_block_ids: Vec::new(),
          removed_block_ids: Vec::new(),
          updated_block_ids: Vec::new(),
        }
      }
      ContentChange::Semantic(mutation) => {
        yjs::apply_document_mutation(&current, mutation).map_err(Self::map_document_mutation_error)?
      }
    };
    let recovery_history_id = if capture_recovery_history {
      let history_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO doc_histories (doc_id, workspace_id, snapshot, origin, actor_id, reference_workspace_id)
           VALUES ($1, $2, $3, 'recovery', $4, $2) RETURNING id",
      )
      .bind(doc_id)
      .bind(workspace_id)
      .bind(&current)
      .bind(actor_user_id)
      .fetch_one(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
      crate::history_git_sync::record_history_capture(&mut *tx, workspace_id, history_id)
        .await
        .map_err(Self::map_db_err)?;
      Some(history_id)
    } else {
      None
    };
    let sequence: i64 = sqlx::query_scalar(
      "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
       VALUES ($1, $2, $3,
         GREATEST(
           COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE workspace_id = $2 AND doc_id = $1), 0),
           COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id = $2 AND doc_id = $1), 0)
         ) + 1)
       RETURNING sequence",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(&applied.delta)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    sqlx::query("UPDATE docs SET sync_state_vector_v1 = NULL, updated_at = now() WHERE id = $1")
      .bind(doc_id)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
    // Restore owns its named/unnamed head transition in the same transaction.
    if is_semantic_edit {
      crate::document_metadata::PgDocumentMetadataRepository::mark_named_version_dirty_in_tx(tx, doc_id)
        .await
        .map_err(|error| AuthError::Storage(error.to_string()))?;
    }
    let eligible = Self::mark_edit_capture_dirty_in_tx(tx, workspace_id, doc_id, sequence).await?;
    if eligible
      && !unchanged_restore
      && applied.state != current
      && let Some(actor_id) = actor_user_id
    {
      crate::notification::document_change::accumulate_in_tx(
        tx,
        workspace_id,
        doc_id,
        actor_id,
        sequence,
        chrono::Utc::now(),
      )
      .await?;
    }
    let accepted = PageLifecycleDelta {
      doc_id,
      sequence,
      delta: applied.delta.clone(),
    };
    let mut updates = vec![accepted];
    if let Some(root) =
      Self::project_leaf_title_in_tx(tx, workspace_id, doc_id, chrono::Utc::now(), project_root_title).await?
    {
      updates.push(root);
    }
    Self::append_workspace_doc_broadcast_outbox(tx, doc_id, workspace_id, actor_user_id, operation, &updates).await?;

    let committed = DocContentMutationCommit {
      doc_id,
      sequence,
      delta: applied.delta,
      state: applied.state,
      inserted_block_ids: applied.inserted_block_ids,
      removed_block_ids: applied.removed_block_ids,
      updated_block_ids: applied.updated_block_ids,
      recovery_history_id,
    };
    // Snapshot restoration owns a wider transaction: defer its receipt until
    // recovery, named version, head, relation and audit are complete.
    if is_semantic_edit {
      crate::mcp_idempotency::commit_document_write(
        tx,
        myoxus_application::mcp::McpDocumentWriteCommit::Content {
          commit: &committed,
          operation,
        },
      )
      .await?;
    }
    Ok(committed)
  }
  /// Construct a `SqlxDocStore` from an existing pool.
  pub fn new(pool: PgPool) -> Self {
    Self {
      pool,
      database_templates: None,
      quota_cache: None,
      default_workspace_quota_mb: 0,
    }
  }

  /// Share the node's validated catalog with atomic Task-content association.
  /// Ordinary page writes need no managed Database admission.
  pub fn with_database_templates(
    mut self,
    catalog: std::sync::Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
  ) -> Self {
    self.database_templates = Some(catalog);
    self
  }

  /// Attach a QuotaCache for faster quota enforcement.
  pub fn with_quota_cache(mut self, cache: std::sync::Arc<crate::quota_cache::QuotaCache>) -> Self {
    self.quota_cache = Some(cache);
    self
  }

  /// Configure storage quota defaults from server config.
  pub fn with_quota_config(mut self, default_workspace_quota_mb: u64) -> Self {
    self.default_workspace_quota_mb = default_workspace_quota_mb;
    self
  }

  fn map_db_err(err: sqlx::Error) -> AuthError {
    // PostgreSQL DETAIL and transport strings may contain user values. Retain
    // the structural cause, not the dependency's free-form rendering.
    let database_code = err.as_database_error().and_then(|error| error.code());
    let constraint = err.as_database_error().and_then(|error| error.constraint());
    let table = err.as_database_error().and_then(|error| error.table());
    let error_kind = match &err {
      sqlx::Error::Database(_) => "database",
      sqlx::Error::Io(_) => "io",
      sqlx::Error::Tls(_) => "tls",
      sqlx::Error::PoolTimedOut => "pool_timed_out",
      sqlx::Error::PoolClosed => "pool_closed",
      sqlx::Error::RowNotFound => "row_not_found",
      sqlx::Error::ColumnDecode { .. } => "column_decode",
      sqlx::Error::Decode(_) => "decode",
      sqlx::Error::Protocol(_) => "protocol",
      sqlx::Error::Configuration(_) => "configuration",
      _ => "other_sqlx",
    };
    error!(
      error_kind,
      database_code = database_code.as_deref(),
      constraint,
      table,
      "database error in doc store"
    );
    AuthError::Storage(err.to_string())
  }

  /// Reuse the bounded P04 Yjs materializer while the document advisory lock
  /// and write transaction remain held.
  ///
  /// Snapshot and tail rows cross a capacity-one channel, so semantic replay
  /// checks cannot collect an unbounded second copy of a document. The shared
  /// decoder worker requests the stream only for legacy vectors or delete-set
  /// candidates; contiguous struct-clock updates never read the full state.
  async fn classify_external_candidate(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
    candidate: yjs::ValidatedYjsUpdate,
    current_state_vector: Option<Vec<u8>>,
    max_materialization_bytes: usize,
    registration: yjs::page_registration::PageRegistrationRequest,
  ) -> AuthResult<yjs::ClassifiedYjsCandidate> {
    let mut session = candidate
      .classify_with_registration(current_state_vector, max_materialization_bytes, registration)
      .map_err(|_| AuthError::YjsDecoderUnavailable)?;
    match session.plan().await.map_err(|_| AuthError::YjsDecoderUnavailable)? {
      yjs::YjsCandidatePlan::Complete(result) => return Ok(result),
      yjs::YjsCandidatePlan::Materialize => {}
    }
    let producer_result = async {
      let snapshot = sqlx::query(
        "SELECT payload, last_sequence FROM doc_snapshots
         WHERE workspace_id = $1 AND doc_id = $2",
      )
      .bind(workspace_id)
      .bind(doc_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
      let last_sequence = if let Some(row) = snapshot {
        let payload: Vec<u8> = row.get("payload");
        let last_sequence: i64 = row.get("last_sequence");
        if !payload.is_empty() {
          session
            .send_update(payload)
            .await
            .map_err(|_| AuthError::YjsDecoderUnavailable)?;
        }
        last_sequence
      } else {
        -1
      };

      let mut rows = sqlx::query(
        "SELECT payload FROM doc_updates
         WHERE workspace_id = $1 AND doc_id = $2 AND sequence > $3
         ORDER BY sequence ASC",
      )
      .bind(workspace_id)
      .bind(doc_id)
      .bind(last_sequence)
      .fetch(&mut **tx);
      while let Some(row) = rows.try_next().await.map_err(Self::map_db_err)? {
        let payload: Vec<u8> = row.get("payload");
        session
          .send_update(payload)
          .await
          .map_err(|_| AuthError::YjsDecoderUnavailable)?;
      }
      AuthResult::Ok(())
    }
    .await;

    let classified = session.finish().await;
    let classified = classified.map_err(|error| match error {
      yjs::YjsDiffMaterializationError::InputTooLarge => AuthError::DocSyncPayloadTooLarge {
        max_bytes: max_materialization_bytes,
      },
      yjs::YjsDiffMaterializationError::Cancelled => AuthError::DocSyncCancelled,
      yjs::YjsDiffMaterializationError::InvalidStateVector => AuthError::InvalidYjsStateVector,
      yjs::YjsDiffMaterializationError::WorkerUnavailable => AuthError::YjsDecoderUnavailable,
      yjs::YjsDiffMaterializationError::InvalidUpdate | yjs::YjsDiffMaterializationError::ApplyFailed => {
        AuthError::Storage("persisted Yjs document state is invalid".to_string())
      }
    });
    match classified {
      Err(error) => Err(error),
      Ok(classified) => {
        producer_result?;
        Ok(classified)
      }
    }
  }

  fn map_doc_row(&self, row: sqlx::postgres::PgRow) -> DocModel {
    let default_role_str: String = row.get("default_role");
    let default_role = match default_role_str.to_lowercase().as_str() {
      "editor" => myoxus_domain::entities::DocDefaultRole::Editor,
      _ => myoxus_domain::entities::DocDefaultRole::Viewer,
    };

    DocModel {
      id: row.get("id"),
      external_id: row.get("external_id"),
      workspace_id: row.get("workspace_id"),
      userspace_owner_id: row.get("userspace_owner_id"),
      title: row.get("title"),
      meta: row.get("meta"),
      blocked: row.get("blocked"),
      is_workspace_root: row.get("is_workspace_root"),
      public_mode: row.get("public_mode"),
      default_role,
      created_by: row.get("created_by"),
      updated_by: row.get("updated_by"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
      deleted_at: row.get("deleted_at"),
    }
  }

  async fn load_doc_parts_in_tx(
    tx: &mut sqlx::PgConnection,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<Vec<Vec<u8>>> {
    let snapshot =
      sqlx::query("SELECT payload, last_sequence FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $2")
        .bind(workspace_id)
        .bind(doc_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    let (snapshot_payload, last_sequence) = snapshot
      .map(|row| (row.get::<Vec<u8>, _>("payload"), row.get::<i64, _>("last_sequence")))
      .unwrap_or_else(|| (Vec::new(), -1));
    let tail = sqlx::query_scalar::<_, Vec<u8>>(
      "SELECT payload FROM doc_updates
       WHERE workspace_id = $1 AND doc_id = $2 AND sequence > $3
       ORDER BY sequence ASC",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(last_sequence)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let mut updates = Vec::with_capacity(tail.len() + usize::from(!snapshot_payload.is_empty()));
    if !snapshot_payload.is_empty() {
      updates.push(snapshot_payload);
    }
    updates.extend(tail);
    Ok(updates)
  }

  fn merge_doc_parts(mut updates: Vec<Vec<u8>>) -> AuthResult<Vec<u8>> {
    match updates.len() {
      0 => Ok(Vec::new()),
      1 => Ok(updates.pop().unwrap_or_default()),
      _ => yjs::merge_updates(updates).map_err(|_| AuthError::Storage("persisted Yjs state is invalid".to_string())),
    }
  }

  /// Read a bounded native body in the caller's repeatable-read snapshot. This
  /// keeps recovery attribution, ledger and content on the same read-only view;
  /// the byte check precedes allocation and never returns a truncated update.
  pub async fn load_full_doc_bounded_in_snapshot(
    connection: &mut sqlx::PgConnection,
    workspace_id: Uuid,
    doc_id: Uuid,
    max_bytes: usize,
  ) -> AuthResult<Vec<u8>> {
    let bytes: i64 = sqlx::query_scalar(
      "SELECT COALESCE((SELECT octet_length(payload)::bigint FROM doc_snapshots WHERE workspace_id=$1 AND doc_id=$2),0)
        + COALESCE((SELECT sum(octet_length(payload))::bigint FROM doc_updates WHERE workspace_id=$1 AND doc_id=$2
          AND sequence>COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id=$1 AND doc_id=$2),-1)),0)",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(Self::map_db_err)?;
    if bytes < 0 || bytes as u64 > max_bytes as u64 {
      return Err(AuthError::DocSyncPayloadTooLarge { max_bytes });
    }
    Self::merge_doc_parts(Self::load_doc_parts_in_tx(connection, workspace_id, doc_id).await?)
  }

  /// Read the full persisted Yjs state under the same native document lock as
  /// sync/deletion. Review decisions and follow-up creation share this fence.
  pub(crate) async fn review_source_revision_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace: Uuid,
    document: Uuid,
    external: &str,
  ) -> AuthResult<String> {
    Self::lock_page_lifecycle_document_set(tx, workspace, &[document]).await?;
    let present:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id=$1 AND workspace_id=$2 AND external_id=$3 AND deleted_at IS NULL AND blocked=false AND is_workspace_root=false)").bind(document).bind(workspace).bind(external).fetch_one(&mut **tx).await.map_err(Self::map_db_err)?;
    if !present {
      return Err(AuthError::ActionForbidden);
    }
    canonical_yjs_revision(&Self::load_full_doc_in_tx(tx, workspace, document).await?).map_err(AuthError::Storage)
  }
  pub(crate) async fn load_full_doc_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<Vec<u8>> {
    Self::merge_doc_parts(Self::load_doc_parts_in_tx(tx, workspace_id, doc_id).await?)
  }

  /// Bind ownership and all metadata rows to one read snapshot. A Move
  /// committed before this read must not reuse the old authorization scope;
  /// a concurrent Move cannot mix old ownership with new history rows.
  async fn begin_history_metadata_read(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<sqlx::Transaction<'_, sqlx::Postgres>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let owned: bool =
      sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL)")
        .bind(doc_id)
        .bind(workspace_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    if !owned {
      return Err(AuthError::NotFound("document history".into()));
    }
    Ok(tx)
  }

  async fn project_history_rows(&self, rows: Vec<PgRow>) -> AuthResult<Vec<DocHistoryEntry>> {
    if rows.is_empty() {
      return Ok(Vec::new());
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let mut entries = Vec::with_capacity(rows.len());
    for row in rows {
      let mut entry = map_history_row(row)?;
      // The initial lookup may precede a concurrent Move. Read ownership and
      // lineage from one snapshot; never return a new projection under the old
      // workspace's history URL or authorization decision.
      let owner: Option<(Uuid, Uuid)> = sqlx::query_as("SELECT workspace_id, doc_id FROM doc_histories WHERE id=$1")
        .bind(entry.id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      if owner != Some((entry.workspace_id, entry.doc_id)) {
        return Err(AuthError::NotFound("document history".into()));
      }
      entry.snapshot =
        reference_lineage::project_snapshot_in_tx(&mut tx, entry.id, entry.doc_id, entry.workspace_id, &entry.snapshot)
          .await?;
      entries.push(entry);
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(entries)
  }

  /// Reconciliation compares the persisted stream, not a re-encoded Yjs root:
  /// legacy Any::Map key order is not byte-stable across materializations.
  /// The caller bounds the snapshot/tail before this transaction-local read.
  pub(crate) async fn load_label_reconciliation_root_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
  ) -> AuthResult<(Vec<u8>, String)> {
    Self::load_reference_snapshot_in_tx(tx, workspace_id, workspace_id).await
  }

  /// Exact persisted parts bind typed offsets; equivalent legacy Any-map
  /// materializations need not have the same encoded property order.
  pub(crate) async fn load_reference_snapshot_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<(Vec<u8>, String)> {
    let updates = Self::load_doc_parts_in_tx(tx, workspace_id, doc_id).await?;
    let mut revision = Sha256::new();
    for update in &updates {
      revision.update((update.len() as u64).to_be_bytes());
      revision.update(update);
    }
    Ok((Self::merge_doc_parts(updates)?, hex::encode(revision.finalize())))
  }

  async fn append_lifecycle_delta(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
    delta: Vec<u8>,
  ) -> AuthResult<PageLifecycleDelta> {
    if delta.is_empty() {
      return Err(AuthError::Storage(
        "page lifecycle produced an empty Yjs delta".to_string(),
      ));
    }
    let sequence = sqlx::query_scalar::<_, i64>(
      "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
       VALUES ($1, $2, $3,
         GREATEST(
           COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE workspace_id = $2 AND doc_id = $1), 0),
           COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id = $2 AND doc_id = $1), 0)
         ) + 1)
       RETURNING sequence",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(&delta)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    sqlx::query("UPDATE docs SET sync_state_vector_v1 = NULL WHERE id = $1")
      .bind(doc_id)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
    crate::document_metadata::PgDocumentMetadataRepository::mark_named_version_dirty_in_tx(tx, doc_id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    Ok(PageLifecycleDelta {
      doc_id,
      sequence,
      delta,
    })
  }

  /// Native content publication must be searchable without a later client push.
  /// This intent shares the content transaction; delivery retries may enqueue
  /// the same canonical full-document projection more than once.
  async fn append_doc_updated_outbox(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    doc_id: Uuid,
    workspace_id: Uuid,
  ) -> AuthResult<()> {
    sqlx::query(
      "INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, created_at)
       VALUES (gen_random_uuid(), 'doc', $1::text, 'doc_updated', $2, now())",
    )
    .bind(doc_id)
    .bind(serde_json::json!({
      "docId": doc_id.to_string(),
      "workspaceId": workspace_id.to_string(),
    }))
    .execute(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }

  pub(crate) async fn append_workspace_doc_broadcast_outbox(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    aggregate_id: Uuid,
    workspace_id: Uuid,
    actor_user_id: Option<Uuid>,
    lifecycle_operation: &str,
    updates: &[PageLifecycleDelta],
  ) -> AuthResult<()> {
    let updates = updates
      .iter()
      .map(|update| {
        serde_json::json!({
          "docId": update.doc_id,
          "sequence": update.sequence,
        })
      })
      .collect::<Vec<_>>();
    sqlx::query(
      "INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, created_at)
       VALUES (gen_random_uuid(), 'doc', $1::text, 'workspace_doc_broadcast', $2, now())",
    )
    .bind(aggregate_id)
    .bind(serde_json::json!({
      "workspaceId": workspace_id,
      "actorUserId": actor_user_id,
      "lifecycleOperation": lifecycle_operation,
      "updates": updates,
      "deliveryAttempts": 0,
    }))
    .execute(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Clean retired Tag identifiers from the root-Yjs compatibility projection
  /// inside an existing authoritative transaction.
  ///
  /// The ordinary document sequence allocator and durable broadcast outbox are
  /// reused so sync consumers see exactly the same ordered update contract as
  /// every other server-owned root mutation. No row or outbox entry is emitted
  /// when the compatibility projection is already semantically clean.
  pub(crate) async fn remove_workspace_tags_from_root_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    aggregate_id: Uuid,
    actor_user_id: Uuid,
    retired_tag_ids: &[String],
  ) -> AuthResult<bool> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(workspace_document_lock_key(workspace_id, workspace_id))
      .execute(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
    let root_state = Self::load_full_doc_in_tx(tx, workspace_id, workspace_id).await?;
    let removal = yjs::remove_workspace_tags_from_root_doc(&root_state, retired_tag_ids).map_err(AuthError::Storage)?;
    if removal.update.is_empty() {
      return Ok(false);
    }
    let root = Self::append_lifecycle_delta(tx, workspace_id, workspace_id, removal.update).await?;
    Self::append_workspace_doc_broadcast_outbox(
      tx,
      aggregate_id,
      workspace_id,
      Some(actor_user_id),
      "workspace_tag_delete_permanently",
      std::slice::from_ref(&root),
    )
    .await?;
    Ok(true)
  }

  /// Shares the existing sync/lifecycle lock with bounded label reconciliation.
  pub(crate) async fn lock_workspace_root_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
  ) -> AuthResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(workspace_document_lock_key(workspace_id, workspace_id))
      .execute(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// The caller already holds the root lock and commits its SQL assignment
  /// decisions in this transaction. Reuse the normal sequence/cache/outbox path.
  pub(crate) async fn append_label_reconciliation_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    actor: Uuid,
    delta: Vec<u8>,
  ) -> AuthResult<()> {
    if delta.is_empty() {
      return Ok(());
    }
    let root = Self::append_lifecycle_delta(tx, workspace_id, workspace_id, delta).await?;
    Self::append_workspace_doc_broadcast_outbox(
      tx,
      workspace_id,
      workspace_id,
      Some(actor),
      "workspace_labels_reconcile",
      std::slice::from_ref(&root),
    )
    .await
  }

  async fn lock_page_lifecycle_documents(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<()> {
    Self::lock_page_lifecycle_document_set(tx, workspace_id, &[workspace_id, doc_id]).await
  }

  pub(crate) async fn lock_page_lifecycle_document_set(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    document_ids: &[Uuid],
  ) -> AuthResult<()> {
    let document_ids = document_ids.iter().copied().collect::<BTreeSet<_>>();
    for locked_doc_id in document_ids {
      sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(workspace_document_lock_key(workspace_id, locked_doc_id))
        .execute(&mut **tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    Ok(())
  }

  /// Register an actual, trusted server create through the native page lifecycle.
  /// The caller holds the native root/leaf locks and commits the
  /// returned root delta's broadcast with the leaf. Retired evidence fails closed.
  pub(crate) async fn register_created_page_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
    external_id: &str,
    title: &str,
    created_at: chrono::DateTime<chrono::Utc>,
    root_state: &[u8],
  ) -> AuthResult<PageLifecycleDelta> {
    let delta = Self::create_root_page_delta(root_state, external_id, title, created_at)?;
    let root = Self::append_lifecycle_delta(tx, workspace_id, workspace_id, delta).await?;
    sqlx::query("INSERT INTO page_registration_evidence (workspace_id, external_id, doc_id, state) VALUES ($1,$2,$3,'registered')")
      .bind(workspace_id).bind(external_id).bind(doc_id).execute(&mut **tx).await.map_err(Self::map_db_err)?;
    Ok(root)
  }

  fn create_root_page_delta(
    root_state: &[u8],
    root_page_key: &str,
    title: &str,
    committed_at: chrono::DateTime<chrono::Utc>,
  ) -> AuthResult<Vec<u8>> {
    let existing = if root_state.is_empty() {
      Vec::new()
    } else {
      vec![root_state.to_vec()]
    };
    let added = yjs::add_pages_to_root_doc(&existing, &[(root_page_key.to_string(), title.to_string())])
      .map_err(AuthError::Storage)?;
    let state_with_page = if root_state.is_empty() {
      added.clone()
    } else {
      yjs::merge_updates(vec![root_state.to_vec(), added.clone()]).map_err(AuthError::Storage)?
    };
    let metadata = yjs::update_root_page_metadata(
      &state_with_page,
      root_page_key,
      Some(title),
      Some(false),
      Some(committed_at.timestamp_millis()),
      committed_at.timestamp_millis(),
    )
    .map_err(AuthError::Storage)?;
    if metadata.matched_entries != 1 {
      return Err(AuthError::Storage(
        "workspace root did not contain exactly one newly created page entry".to_string(),
      ));
    }
    yjs::merge_updates(vec![added, metadata.update]).map_err(AuthError::Storage)
  }

  fn update_root_page_delta(
    root_state: &[u8],
    root_page_key: &str,
    title: Option<&str>,
    is_trashed: Option<bool>,
    committed_at: chrono::DateTime<chrono::Utc>,
  ) -> AuthResult<Vec<u8>> {
    let mutation = yjs::update_root_page_metadata(
      root_state,
      root_page_key,
      title,
      is_trashed,
      None,
      committed_at.timestamp_millis(),
    )
    .map_err(AuthError::Storage)?;
    if mutation.matched_entries == 0 {
      return Err(AuthError::NotFound("workspace root page entry".to_string()));
    }
    Ok(mutation.update)
  }

  fn extract_leaf_title(state: &[u8]) -> AuthResult<Option<String>> {
    if state.is_empty() {
      return Ok(None);
    }
    let extracted = yjs::page_registration::extract_page_title(state)
      .map_err(|_| AuthError::Storage("persisted page leaf state is invalid".to_string()))?;
    Ok(extracted)
  }

  /// Read optional structural title evidence without turning an opaque or
  /// legacy leaf into a title command. The normal sync decoder still owns
  /// payload validity; title projection only acts on one recognized page.
  async fn structural_leaf_title_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<Option<String>> {
    let parts = Self::load_doc_parts_in_tx(tx, workspace_id, doc_id).await?;
    let Ok(state) = Self::merge_doc_parts(parts) else {
      return Ok(None);
    };
    Ok(Self::extract_leaf_title(&state).unwrap_or(None))
  }

  async fn title_projection_lock_candidates_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
    payload: &[u8],
  ) -> AuthResult<BTreeSet<Uuid>> {
    let current = Self::load_full_doc_in_tx(tx, workspace_id, doc_id).await?;
    let mut candidates = BTreeSet::new();
    if doc_id != workspace_id {
      let current_title = Self::extract_leaf_title(&current).unwrap_or(None);
      let projected = if current.is_empty() {
        payload.to_vec()
      } else {
        let Ok(projected) = yjs::merge_updates(vec![current, payload.to_vec()]) else {
          return Ok(candidates);
        };
        projected
      };
      let Some(title) = Self::extract_leaf_title(&projected).unwrap_or(None) else {
        return Ok(candidates);
      };
      let sql_title = sqlx::query_scalar::<_, String>(
        "SELECT title FROM docs WHERE workspace_id = $1 AND id = $2 AND NOT is_workspace_root",
      )
      .bind(workspace_id)
      .bind(doc_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
      if current_title.as_deref() != Some(title.as_str()) || sql_title.as_deref() != Some(title.as_str()) {
        candidates.insert(workspace_id);
      }
      return Ok(candidates);
    }

    let projected = if current.is_empty() {
      payload.to_vec()
    } else {
      yjs::merge_updates(vec![current, payload.to_vec()])
        .map_err(|_| AuthError::Storage("persisted Yjs document state is invalid".to_string()))?
    };
    let pages = yjs::extract_page_trash_state(&projected)
      .map_err(|_| AuthError::Storage("workspace root page metadata is invalid".to_string()))?;
    let external_ids = pages.iter().map(|page| page.id.as_str()).collect::<Vec<_>>();
    if external_ids.is_empty() {
      return Ok(candidates);
    }
    let rows = sqlx::query(
      "SELECT id, external_id, title, deleted_at IS NOT NULL AS is_trashed FROM docs
       WHERE workspace_id = $1 AND NOT is_workspace_root AND external_id = ANY($2)",
    )
    .bind(workspace_id)
    .bind(&external_ids)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    for row in rows {
      let external_id: String = row.get("external_id");
      let matching = pages.iter().filter(|page| page.id == external_id).collect::<Vec<_>>();
      if matching.len() == 1
        && (matching[0].title.as_deref() != Some(row.get::<String, _>("title").as_str())
          || matching[0].is_trashed != row.get::<bool, _>("is_trashed"))
      {
        candidates.insert(row.get("id"));
      }
    }
    Ok(candidates)
  }

  async fn project_leaf_title_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
    committed_at: chrono::DateTime<chrono::Utc>,
    project_root: bool,
  ) -> AuthResult<Option<PageLifecycleDelta>> {
    let Some(title) = Self::structural_leaf_title_in_tx(tx, workspace_id, doc_id).await? else {
      return Ok(None);
    };
    let row = sqlx::query(
      "SELECT external_id, title FROM docs
       WHERE workspace_id = $1 AND id = $2 AND NOT is_workspace_root FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    let Some(row) = row else {
      return Ok(None);
    };
    let external_id: String = row.get("external_id");
    let sql_title: String = row.get("title");
    if sql_title != title {
      sqlx::query("UPDATE docs SET title = $3, updated_at = $4 WHERE workspace_id = $1 AND id = $2")
        .bind(workspace_id)
        .bind(doc_id)
        .bind(&title)
        .bind(committed_at)
        .execute(&mut **tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    if !project_root {
      return Ok(None);
    }
    let root_state = Self::load_full_doc_in_tx(tx, workspace_id, workspace_id).await?;
    let root_entries = yjs::extract_page_trash_state(&root_state)
      .map_err(|_| AuthError::Storage("workspace root page metadata is invalid".to_string()))?
      .into_iter()
      .filter(|entry| entry.id == external_id)
      .collect::<Vec<_>>();
    if root_entries.len() != 1 || root_entries[0].title.as_deref() == Some(title.as_str()) {
      return Ok(None);
    }
    let delta = Self::update_root_page_delta(&root_state, &external_id, Some(&title), None, committed_at)?;
    Self::append_lifecycle_delta(tx, workspace_id, workspace_id, delta)
      .await
      .map(Some)
  }

  async fn project_root_metadata_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    locked_leaf_ids: &BTreeSet<Uuid>,
    committed_at: chrono::DateTime<chrono::Utc>,
  ) -> AuthResult<Vec<PageLifecycleDelta>> {
    let mut root_state = Self::load_full_doc_in_tx(tx, workspace_id, workspace_id).await?;
    let entries = yjs::extract_page_trash_state(&root_state)
      .map_err(|error| AuthError::Storage(format!("root page metadata is invalid: {error}")))?;
    for entry in &entries {
      let target = sqlx::query_as::<_, (Uuid, bool)>(
        "SELECT id, deleted_at IS NOT NULL
         FROM docs
         WHERE workspace_id = $1 AND external_id = $2 AND NOT is_workspace_root
         FOR UPDATE",
      )
      .bind(workspace_id)
      .bind(&entry.id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
      if let Some((doc_id, was_trashed)) = target
        && entry.is_trashed
        && !was_trashed
      {
        crate::template_registry::reject_managed_source_write(tx, workspace_id, doc_id).await?;
      }
      sqlx::query(
        "UPDATE docs SET deleted_at = CASE WHEN $3 THEN COALESCE(deleted_at, $4) ELSE NULL END
         WHERE workspace_id = $1 AND external_id = $2 AND NOT is_workspace_root
           AND ((deleted_at IS NULL) = $3)",
      )
      .bind(workspace_id)
      .bind(&entry.id)
      .bind(entry.is_trashed)
      .bind(committed_at)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
    }

    let mut deltas = Vec::new();
    for leaf_id in locked_leaf_ids.iter().copied().filter(|id| *id != workspace_id) {
      let Some(external_id) = sqlx::query_scalar::<_, String>(
        "SELECT external_id FROM docs WHERE workspace_id = $1 AND id = $2 AND NOT is_workspace_root FOR UPDATE",
      )
      .bind(workspace_id)
      .bind(leaf_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_db_err)?
      else {
        continue;
      };
      let Some(title) = Self::structural_leaf_title_in_tx(tx, workspace_id, leaf_id).await? else {
        continue;
      };
      sqlx::query(
        "UPDATE docs SET title = $3, updated_at = $4 WHERE workspace_id = $1 AND id = $2 AND title IS DISTINCT FROM $3",
      )
      .bind(workspace_id)
      .bind(leaf_id)
      .bind(&title)
      .bind(committed_at)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
      let mutation = yjs::update_root_page_metadata(
        &root_state,
        &external_id,
        Some(&title),
        None,
        None,
        committed_at.timestamp_millis(),
      )
      .map_err(AuthError::Storage)?;
      if mutation.matched_entries == 1 && !mutation.update.is_empty() {
        let delta = Self::append_lifecycle_delta(tx, workspace_id, workspace_id, mutation.update).await?;
        root_state = Self::load_full_doc_in_tx(tx, workspace_id, workspace_id).await?;
        deltas.push(delta);
      }
    }
    Ok(deltas)
  }

  async fn read_page_audit_state_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    doc_id: Uuid,
    expected_external_doc_id: &str,
  ) -> AuthResult<PageLifecycleAuditState> {
    let sql = sqlx::query("SELECT external_id, title, deleted_at IS NOT NULL AS is_trashed FROM docs WHERE workspace_id = $1 AND id = $2 AND NOT is_workspace_root")
      .bind(workspace_id)
      .bind(doc_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
    let root_state = Self::load_full_doc_in_tx(tx, workspace_id, workspace_id).await?;
    let external_doc_id = sql
      .as_ref()
      .map(|row| row.get::<String, _>("external_id"))
      .unwrap_or_else(|| expected_external_doc_id.to_string());
    let root_entries = yjs::extract_workspace_root_metadata(&root_state)
      .map_err(|_| AuthError::Storage("workspace root page metadata is invalid".to_string()))?
      .pages
      .into_iter()
      .filter(|entry| entry.id == external_doc_id)
      .collect::<Vec<_>>();
    let root_entry = (root_entries.len() == 1).then(|| &root_entries[0]);
    let identity_conflict: bool = root_entries.len() > 1
      || (sql.is_none()
        && sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id = $1)")
          .bind(doc_id)
          .fetch_one(&mut **tx)
          .await
          .map_err(Self::map_db_err)?);
    let leaf_exists = sqlx::query_scalar::<_, bool>(
      "SELECT EXISTS(
         SELECT 1 FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2
         UNION ALL
         SELECT 1 FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $2
       )",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    let leaf_title = if leaf_exists {
      Self::extract_leaf_title(&Self::load_full_doc_in_tx(tx, workspace_id, doc_id).await?)?
    } else {
      None
    };
    Ok(PageLifecycleAuditState {
      source_id: doc_id.to_string(),
      doc_id: Some(doc_id),
      external_doc_id: Some(external_doc_id),
      identity_conflict,
      sql_title: sql.as_ref().map(|row| row.get("title")),
      sql_trashed: sql.as_ref().map(|row| row.get("is_trashed")),
      root_title: root_entry.as_ref().and_then(|entry| entry.title.clone()),
      root_trashed: root_entry.as_ref().map(|entry| entry.is_trashed),
      leaf_exists,
      leaf_title,
    })
  }

  fn map_delete_candidate_row(row: sqlx::postgres::PgRow) -> DocDeleteCandidate {
    DocDeleteCandidate {
      doc_id: row.get("id"),
      client_doc_id: row.get("client_doc_id"),
      title: row.get("title"),
      workspace_id: row.get("workspace_id"),
      is_workspace_root: row.get("is_workspace_root"),
      deleted_at: row.get("deleted_at"),
    }
  }

  fn map_page_projection_sql_row(row: sqlx::postgres::PgRow) -> myoxus_application::doc::PageProjectionSqlRow {
    myoxus_application::doc::PageProjectionSqlRow {
      doc_id: row.get("id"),
      external_doc_id: row.get("external_id"),
      title: row.get("title"),
      is_trashed: row.get("is_trashed"),
    }
  }

  fn parse_doc_role(role_str: &str) -> DocRole {
    match role_str.to_lowercase().as_str() {
      "owner" => DocRole::Owner,
      "manager" => DocRole::Manager,
      "editor" => DocRole::Editor,
      "commenter" => DocRole::Commenter,
      "reader" => DocRole::Reader,
      "external" => DocRole::External,
      _ => DocRole::None,
    }
  }

  fn doc_role_to_db(role: DocRole) -> &'static str {
    match role {
      DocRole::Owner => "Owner",
      DocRole::Manager => "Manager",
      DocRole::Editor => "Editor",
      DocRole::Commenter => "Commenter",
      DocRole::Reader => "Reader",
      DocRole::External => "External",
      DocRole::None => "None",
    }
  }
}

// P102-MOD-02: SqlxDocStore implements all 6 sub-traits separately.
// impl DocStore for SqlxDocStore {} is a marker — all methods live in sub-trait impls.

#[async_trait]
impl DocMetadataStore for SqlxDocStore {
  #[instrument(skip(self, key), fields(%workspace_id))]
  async fn is_page_moved(&self, workspace_id: Uuid, key: &DocumentKey) -> AuthResult<bool> {
    sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM workspace_content_operation_redirects r
       WHERE r.source_workspace_id = $1 AND r.source_kind = 'document' AND r.source_id = $2
       AND NOT EXISTS(SELECT 1 FROM docs d WHERE d.workspace_id = $1
         AND (d.external_id = $2 OR d.id::text = $2)))",
    )
    .bind(workspace_id)
    .bind(key.as_str())
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }
  #[instrument(skip(self), fields(%workspace_id, %doc_id))]
  async fn has_committed_transfer_from(&self, doc_id: Uuid, workspace_id: Uuid) -> AuthResult<bool> {
    sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM workspace_content_move_revision_manifests m
       JOIN workspace_content_operations o ON o.id = m.operation_id
       WHERE o.source_workspace_id = $1 AND (m.manifest->'documents') @> $2::jsonb
         AND (EXISTS(SELECT 1 FROM workspace_content_move_publications p WHERE p.operation_id=m.operation_id AND p.manifest_hash=o.manifest_hash)
           OR EXISTS(SELECT 1 FROM workspace_content_extract_publications p WHERE p.operation_id=m.operation_id AND p.manifest_hash=o.manifest_hash)))",
    )
    .bind(workspace_id)
    .bind(serde_json::json!([{ "doc_id": doc_id }]))
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }

  #[instrument(skip(self, key), fields(%workspace_id))]
  async fn is_page_permanently_deleted(&self, workspace_id: Uuid, key: &DocumentKey) -> AuthResult<bool> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM page_registration_evidence WHERE workspace_id = $1 AND external_id = $2 AND state = 'deleted')")
      .bind(workspace_id).bind(key.as_str()).fetch_one(&self.pool).await.map_err(Self::map_db_err)
  }

  async fn page_registration_state(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<Option<myoxus_application::doc::PageRegistrationState>> {
    let state = sqlx::query_scalar::<_, String>("SELECT COALESCE(e.state, 'legacy') FROM docs d LEFT JOIN page_registration_evidence e ON e.workspace_id = d.workspace_id AND e.doc_id = d.id WHERE d.workspace_id = $1 AND d.id = $2 AND d.id <> $1 AND NOT d.is_workspace_root AND d.external_id NOT LIKE 'db$%' AND d.external_id NOT LIKE 'userdata$%'")
      .bind(workspace_id).bind(doc_id).fetch_optional(&self.pool).await.map_err(Self::map_db_err)?;
    state.map(|state| registration::parse_state(&state)).transpose()
  }
  #[instrument(skip(self), fields(%workspace_id, %doc_id))]
  async fn preview_source_identity(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<Option<myoxus_application::doc::DocPreviewSourceIdentity>> {
    let row = sqlx::query(
      r#"
      SELECT d.title,
             COALESCE(d.public_mode, 'page') AS public_mode,
             d.deleted_at IS NOT NULL AS deleted,
             (EXTRACT(EPOCH FROM d.updated_at) * 1000000)::BIGINT AS metadata_revision,
             GREATEST(
               COALESCE(s.last_sequence, 0),
               COALESCE((SELECT MAX(u.sequence)
                         FROM doc_updates u
                         WHERE u.workspace_id = d.workspace_id AND u.doc_id = d.id), 0)
             ) AS revision
      FROM docs d
      LEFT JOIN doc_snapshots s
        ON s.workspace_id = d.workspace_id AND s.doc_id = d.id
      WHERE d.workspace_id = $1 AND d.id = $2
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(|row| myoxus_application::doc::DocPreviewSourceIdentity {
      revision: row.get("revision"),
      metadata_revision: row.get("metadata_revision"),
      title: row.get::<Option<String>, _>("title").unwrap_or_default(),
      public_mode: row.get("public_mode"),
      deleted: row.get("deleted"),
    }))
  }

  #[instrument(skip_all)]
  async fn preview_source_identities(
    &self,
    workspace_id: Uuid,
    doc_ids: &[Uuid],
  ) -> AuthResult<HashMap<Uuid, myoxus_application::doc::DocPreviewSourceIdentity>> {
    if doc_ids.is_empty() {
      return Ok(HashMap::new());
    }
    let rows = sqlx::query(
      r#"
      SELECT d.id, d.title, COALESCE(d.public_mode, 'page') AS public_mode,
             d.deleted_at IS NOT NULL AS deleted,
             (EXTRACT(EPOCH FROM d.updated_at) * 1000000)::BIGINT AS metadata_revision,
             GREATEST(COALESCE(s.last_sequence, 0),
               COALESCE((SELECT MAX(u.sequence) FROM doc_updates u
                         WHERE u.workspace_id=d.workspace_id AND u.doc_id=d.id), 0)) AS revision
      FROM docs d LEFT JOIN doc_snapshots s ON s.workspace_id=d.workspace_id AND s.doc_id=d.id
      WHERE d.workspace_id=$1 AND d.id=ANY($2) AND NOT d.blocked
    "#,
    )
    .bind(workspace_id)
    .bind(doc_ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| {
          (
            row.get("id"),
            myoxus_application::doc::DocPreviewSourceIdentity {
              revision: row.get("revision"),
              metadata_revision: row.get("metadata_revision"),
              title: row.get::<Option<String>, _>("title").unwrap_or_default(),
              public_mode: row.get("public_mode"),
              deleted: row.get("deleted"),
            },
          )
        })
        .collect(),
    )
  }

  #[instrument(skip_all)]
  async fn metadata_by_external_keys(
    &self,
    workspace_id: Uuid,
    keys: &[String],
  ) -> AuthResult<HashMap<String, myoxus_domain::entities::Doc>> {
    if keys.is_empty() {
      return Ok(HashMap::new());
    }
    let rows = sqlx::query("SELECT id, external_id, workspace_id, userspace_owner_id, title, meta, blocked, is_workspace_root, public_mode, default_role, created_by, updated_by, created_at, updated_at, deleted_at FROM docs WHERE workspace_id=$1 AND external_id=ANY($2) AND deleted_at IS NULL")
      .bind(workspace_id).bind(keys).fetch_all(&self.pool).await.map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| {
          let doc = self.map_doc_row(row);
          (doc.external_id.clone(), doc)
        })
        .collect(),
    )
  }

  async fn commit_page_lifecycle(&self, command: PageLifecycleCommand) -> AuthResult<PageLifecycleCommit> {
    self.commit_lifecycle_with_project_ack(command, None).await
  }
  async fn commit_automation_page_lifecycle(
    &self,
    command: PageLifecycleCommand,
    row_content: Option<myoxus_application::doc::AutomationRowContentTarget>,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> AuthResult<myoxus_application::doc::AutomationPageLifecycleResult> {
    self
      .commit_lifecycle_with_native_ack(command, None, Some(fence), row_content)
      .await
  }
  async fn commit_project_page_lifecycle(
    &self,
    command: PageLifecycleCommand,
    ack: myoxus_application::workspace::ProjectDocumentAck,
  ) -> AuthResult<PageLifecycleCommit> {
    self.commit_lifecycle_with_project_ack(command, Some(ack)).await
  }

  async fn page_projection_root_sequence(&self, workspace_id: Uuid) -> AuthResult<i64> {
    sqlx::query_scalar(
      "SELECT GREATEST(
         COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE workspace_id = $1 AND doc_id = $1), 0),
         COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $1), 0)
       )
       FROM docs
       WHERE id = $1 AND workspace_id = $1 AND is_workspace_root",
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::NotFound("workspace root document".to_string()))
  }

  async fn scan_page_projection_sql(
    &self,
    workspace_id: Uuid,
    after_external_doc_id: Option<&str>,
    limit: usize,
  ) -> AuthResult<Vec<myoxus_application::doc::PageProjectionSqlRow>> {
    sqlx::query(
      "SELECT id, external_id, title, deleted_at IS NOT NULL AS is_trashed
       FROM docs
       WHERE workspace_id = $1
         AND NOT is_workspace_root
         AND ($2::text IS NULL OR external_id > $2)
       ORDER BY external_id, id
       LIMIT $3",
    )
    .bind(workspace_id)
    .bind(after_external_doc_id)
    .bind(i64::try_from(limit).map_err(|_| AuthError::InvalidInput("page projection limit is invalid".to_string()))?)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)
    .map(|rows| rows.into_iter().map(Self::map_page_projection_sql_row).collect())
  }

  async fn scan_page_projection_leaf_ids(
    &self,
    workspace_id: Uuid,
    after_doc_id: Option<Uuid>,
    limit: usize,
  ) -> AuthResult<Vec<Uuid>> {
    sqlx::query_scalar(
      "SELECT doc_id FROM (
         SELECT doc_id FROM doc_updates WHERE workspace_id = $1 AND doc_id <> $1
         UNION
         SELECT doc_id FROM doc_snapshots WHERE workspace_id = $1 AND doc_id <> $1
       ) leaves
       WHERE ($2::uuid IS NULL OR doc_id > $2)
       ORDER BY doc_id
       LIMIT $3",
    )
    .bind(workspace_id)
    .bind(after_doc_id)
    .bind(i64::try_from(limit).map_err(|_| AuthError::InvalidInput("page projection limit is invalid".to_string()))?)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }

  async fn page_projection_sql_by_external_ids(
    &self,
    workspace_id: Uuid,
    external_doc_ids: &[String],
  ) -> AuthResult<Vec<myoxus_application::doc::PageProjectionSqlRow>> {
    if external_doc_ids.is_empty() {
      return Ok(Vec::new());
    }
    sqlx::query(
      "SELECT id, external_id, title, deleted_at IS NOT NULL AS is_trashed
       FROM docs
       WHERE workspace_id = $1 AND NOT is_workspace_root AND external_id = ANY($2)
       ORDER BY external_id, id",
    )
    .bind(workspace_id)
    .bind(external_doc_ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)
    .map(|rows| rows.into_iter().map(Self::map_page_projection_sql_row).collect())
  }

  async fn page_projection_sql_by_doc_ids(
    &self,
    workspace_id: Uuid,
    doc_ids: &[Uuid],
  ) -> AuthResult<Vec<myoxus_application::doc::PageProjectionSqlRow>> {
    if doc_ids.is_empty() {
      return Ok(Vec::new());
    }
    sqlx::query(
      "SELECT id, external_id, title, deleted_at IS NOT NULL AS is_trashed
       FROM docs
       WHERE workspace_id = $1 AND NOT is_workspace_root AND id = ANY($2)
       ORDER BY id",
    )
    .bind(workspace_id)
    .bind(doc_ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)
    .map(|rows| rows.into_iter().map(Self::map_page_projection_sql_row).collect())
  }

  async fn page_projection_existing_doc_ids(&self, doc_ids: &[Uuid]) -> AuthResult<Vec<Uuid>> {
    if doc_ids.is_empty() {
      return Ok(Vec::new());
    }
    sqlx::query_scalar("SELECT id FROM docs WHERE id = ANY($1) ORDER BY id")
      .bind(doc_ids)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)
  }

  async fn page_projection_leaf_presence(&self, workspace_id: Uuid, doc_ids: &[Uuid]) -> AuthResult<Vec<Uuid>> {
    if doc_ids.is_empty() {
      return Ok(Vec::new());
    }
    sqlx::query_scalar(
      "SELECT doc_id FROM (
         SELECT doc_id FROM doc_updates WHERE workspace_id = $1 AND doc_id = ANY($2)
         UNION
         SELECT doc_id FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = ANY($2)
       ) leaves
       ORDER BY doc_id",
    )
    .bind(workspace_id)
    .bind(doc_ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }

  #[instrument(skip(self, command), fields(workspace_id = %command.workspace_id, doc_id = %command.doc_id))]
  async fn commit_page_lifecycle_repair(
    &self,
    command: PageLifecycleRepairCommand,
  ) -> AuthResult<PageLifecycleRepairCommit> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::lock_page_lifecycle_documents(&mut tx, command.workspace_id, command.doc_id).await?;
    let current =
      Self::read_page_audit_state_in_tx(&mut tx, command.workspace_id, command.doc_id, &command.external_doc_id)
        .await?;
    Self::registration_request(
      &mut tx,
      command.workspace_id,
      &command.external_doc_id,
      Some(command.doc_id),
    )
    .await?;
    if current.sql_title.is_none() {
      let moved: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_content_operation_redirects
         WHERE source_workspace_id=$1 AND source_kind='document' AND source_id=$2)",
      )
      .bind(command.workspace_id)
      .bind(&command.external_doc_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if moved {
        return Err(AuthError::NotFound("document".into()));
      }
    }
    let already_consistent = current.external_doc_id.as_deref() == Some(command.external_doc_id.as_str())
      && !current.identity_conflict
      && current.sql_title.as_deref() == Some(command.title.as_str())
      && current.sql_trashed == Some(command.is_trashed)
      && current.root_title.as_deref() == Some(command.title.as_str())
      && current.root_trashed == Some(command.is_trashed)
      && current.leaf_exists
      && current.leaf_title.as_deref() == Some(command.title.as_str());
    if already_consistent {
      tx.rollback().await.map_err(Self::map_db_err)?;
      return Ok(PageLifecycleRepairCommit {
        changed: false,
        leaf_sequence: None,
        root_sequence: None,
      });
    }
    if current != command.expected_state {
      return Err(AuthError::InvalidInput("MIX_PAGE_REPAIR_TARGET_CHANGED".to_string()));
    }

    let root_exists: bool =
      sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id = $1 AND workspace_id = $1 AND is_workspace_root)")
        .bind(command.workspace_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    if !root_exists {
      return Err(AuthError::NotFound("workspace root document".to_string()));
    }
    let committed_at = chrono::Utc::now();
    if command.ensure_sql_metadata {
      sqlx::query(
        "WITH requested_language AS (
           SELECT COALESCE(
             NULLIF(values->>'defaultDocumentLanguage', ''),
             NULLIF(values->>'locale', '')
           ) AS key
           FROM user_preferences
           WHERE user_id = $4
             AND NOT EXISTS (
               SELECT 1 FROM document_workspace_settings settings
               WHERE settings.workspace_id = $2
                 AND settings.default_language_id IS NOT NULL
                 AND settings.updated_by IS NOT NULL
             )
             AND NOT EXISTS (
               SELECT 1 FROM organization_document_settings settings
               WHERE settings.organization_id = document_metadata_effective_organization_id($2)
                 AND settings.default_language_id IS NOT NULL
                 AND settings.updated_by IS NOT NULL
             )
         ), preferred_language AS (
           SELECT language.id
           FROM requested_language requested
           JOIN language_definition language
             ON language.is_active
            AND (
              lower(language.key) = lower(requested.key)
              OR lower(language.key) = lower(split_part(requested.key, '-', 1))
            )
           ORDER BY (lower(language.key) = lower(requested.key)) DESC,
                    language.sort_order,
                    language.key
           LIMIT 1
         )
         INSERT INTO docs (
           id, external_id, workspace_id, title, is_workspace_root,
           created_by, updated_by, language_id, created_at, updated_at, deleted_at
         ) VALUES ($1, $7, $2, $3, false, $4, $4,
                   (SELECT id FROM preferred_language), $5, $5,
                   CASE WHEN $6 THEN $5 ELSE NULL END)",
      )
      .bind(command.doc_id)
      .bind(command.workspace_id)
      .bind(&command.title)
      .bind(command.actor_user_id)
      .bind(committed_at)
      .bind(command.is_trashed)
      .bind(&command.external_doc_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    } else if current.sql_title.as_deref() != Some(command.title.as_str())
      || current.sql_trashed != Some(command.is_trashed)
    {
      sqlx::query(
        "UPDATE docs
         SET title = $3, deleted_at = CASE WHEN $4 THEN $6 ELSE NULL END,
             updated_by = $5, updated_at = $6
         WHERE workspace_id = $1 AND id = $2 AND NOT is_workspace_root",
      )
      .bind(command.workspace_id)
      .bind(command.doc_id)
      .bind(&command.title)
      .bind(command.is_trashed)
      .bind(command.actor_user_id)
      .bind(committed_at)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }

    let leaf_needs_update = command.ensure_leaf || current.leaf_title.as_deref() != Some(command.title.as_str());
    let leaf = if leaf_needs_update {
      let delta = if command.ensure_leaf {
        myoxus_application::markdown::empty_page_to_yjs(&command.title)
      } else {
        let leaf_state = Self::load_full_doc_in_tx(&mut tx, command.workspace_id, command.doc_id).await?;
        yjs::update_document_title(&leaf_state, &command.title).map_err(AuthError::Storage)?
      };
      Some(Self::append_lifecycle_delta(&mut tx, command.workspace_id, command.doc_id, delta).await?)
    } else {
      None
    };

    let root_state = Self::load_full_doc_in_tx(&mut tx, command.workspace_id, command.workspace_id).await?;
    let root_delta = if command.ensure_root_entry {
      let create = Self::create_root_page_delta(&root_state, &command.external_doc_id, &command.title, committed_at)?;
      if command.is_trashed {
        let merged = if root_state.is_empty() {
          create.clone()
        } else {
          yjs::merge_updates(vec![root_state, create.clone()]).map_err(AuthError::Storage)?
        };
        let trash = Self::update_root_page_delta(
          &merged,
          &command.external_doc_id,
          Some(&command.title),
          Some(true),
          committed_at,
        )?;
        yjs::merge_updates(vec![create, trash]).map_err(AuthError::Storage)?
      } else {
        create
      }
    } else {
      Self::update_root_page_delta(
        &root_state,
        &command.external_doc_id,
        Some(&command.title),
        Some(command.is_trashed),
        committed_at,
      )?
    };
    let root = Self::append_lifecycle_delta(&mut tx, command.workspace_id, command.workspace_id, root_delta).await?;

    // Exact-target repair is explicit registration authority. Reuse completion
    // so retained creation intent also marks the repaired root for late delivery.
    Self::finish_page_registration(
      &mut tx,
      command.workspace_id,
      command.doc_id,
      &command.external_doc_id,
      Some(command.actor_user_id),
      Some(myoxus_application::doc::PageRegistrationState::Legacy),
      yjs::page_registration::PageRegistrationProjection {
        title: Some(command.title.clone()),
        ..Default::default()
      },
      true,
    )
    .await?;

    let mut updates = Vec::with_capacity(2);
    if let Some(leaf) = &leaf {
      updates.push(serde_json::json!({ "docId": leaf.doc_id, "sequence": leaf.sequence }));
    }
    updates.push(serde_json::json!({ "docId": root.doc_id, "sequence": root.sequence }));
    sqlx::query(
      "INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, created_at)
       VALUES (gen_random_uuid(), 'doc', $1::text, 'workspace_doc_broadcast', $2, now())",
    )
    .bind(command.doc_id)
    .bind(serde_json::json!({
      "workspaceId": command.workspace_id,
      "actorUserId": command.actor_user_id,
      "lifecycleOperation": "repair",
      "updates": updates,
      "deliveryAttempts": 0,
    }))
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(PageLifecycleRepairCommit {
      changed: true,
      leaf_sequence: leaf.map(|delta| delta.sequence),
      root_sequence: Some(root.sequence),
    })
  }

  #[instrument(skip(self), fields(external_id))]
  async fn resolve_external_doc_id(
    &self,
    space_id: Uuid,
    space_kind: myoxus_application::doc::DocSpaceKind,
    external_id: &str,
  ) -> AuthResult<Option<Uuid>> {
    let row = match space_kind {
      myoxus_application::doc::DocSpaceKind::Workspace => {
        sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id = $1 AND external_id = $2")
          .bind(space_id)
          .bind(external_id)
          .fetch_optional(&self.pool)
          .await
      }
      myoxus_application::doc::DocSpaceKind::Userspace => {
        sqlx::query_scalar("SELECT id FROM docs WHERE userspace_owner_id = $1 AND external_id = $2")
          .bind(space_id)
          .bind(external_id)
          .fetch_optional(&self.pool)
          .await
      }
    }
    .map_err(Self::map_db_err)?;
    Ok(row)
  }

  /// Insert a new document metadata row associated with a workspace.
  #[instrument(skip(self))]
  async fn create_doc_metadata(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    title: String,
    is_root: bool,
    created_by: Uuid,
  ) -> AuthResult<DocModel> {
    // Note: For workspace docs, userspace_owner_id remains NULL.
    // For userspace docs, workspace_id will be NULL (not yet fully implemented in this method signature)
    let row = sqlx::query(
            r#"
            WITH requested_language AS (
              SELECT COALESCE(
                NULLIF(values->>'defaultDocumentLanguage', ''),
                NULLIF(values->>'locale', '')
              ) AS key
              FROM user_preferences
              WHERE user_id = $5
                AND NOT EXISTS (
                  SELECT 1
                  FROM document_workspace_settings settings
                  WHERE settings.workspace_id = $2
                    AND settings.default_language_id IS NOT NULL
                    AND settings.updated_by IS NOT NULL
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM organization_document_settings settings
                  WHERE settings.organization_id = document_metadata_effective_organization_id($2)
                    AND settings.default_language_id IS NOT NULL
                    AND settings.updated_by IS NOT NULL
                )
            ), preferred_language AS (
              SELECT language.id
              FROM requested_language requested
              JOIN language_definition language
                ON language.is_active
               AND (
                 lower(language.key) = lower(requested.key)
                 OR lower(language.key) = lower(split_part(requested.key, '-', 1))
               )
              ORDER BY (lower(language.key) = lower(requested.key)) DESC,
                       language.sort_order,
                       language.key
              LIMIT 1
            )
            INSERT INTO docs (
              id, external_id, workspace_id, title, is_workspace_root,
              created_by, updated_by, language_id
            )
            VALUES ($1, $1::text, $2, $3, $4, $5, $5, (SELECT id FROM preferred_language))
            RETURNING id, external_id, workspace_id, userspace_owner_id, title, meta, blocked, is_workspace_root, public_mode, default_role, created_by, updated_by, created_at, updated_at, deleted_at
            "#
        )
        .bind(doc_id)
        .bind(workspace_id)
        .bind(title)
        .bind(is_root)
        .bind(created_by)
        .fetch_one(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    Ok(self.map_doc_row(row))
  }

  #[instrument(skip(self), fields(%workspace_id, %doc_id, %created_by))]
  async fn create_imported_doc_metadata(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    title: String,
    created_by: Uuid,
  ) -> AuthResult<DocModel> {
    let row = sqlx::query(
      r#"
      INSERT INTO docs (
        id, external_id, workspace_id, title, is_workspace_root,
        created_by, updated_by
      )
      SELECT $1, $1::text, $2, $3, false, $4, $4
      FROM workspaces
      WHERE id = $2 AND lifecycle_state = 'importing' AND deleted_at IS NULL
      ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, updated_by = EXCLUDED.updated_by
      WHERE docs.workspace_id = EXCLUDED.workspace_id
        AND docs.is_workspace_root = false
        AND EXISTS (
          SELECT 1 FROM workspaces
          WHERE id = EXCLUDED.workspace_id
            AND lifecycle_state = 'importing'
            AND deleted_at IS NULL
        )
      RETURNING id, external_id, workspace_id, userspace_owner_id, title, meta,
                blocked, is_workspace_root, public_mode, default_role,
                created_by, updated_by, created_at, updated_at, deleted_at
      "#,
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(title)
    .bind(created_by)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::InvalidInput("workspace import document identity conflicts".to_string()))?;
    Ok(self.map_doc_row(row))
  }

  #[instrument(skip(self, meta), fields(%workspace_id, %doc_id, is_trashed))]
  async fn apply_imported_doc_metadata(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    title: String,
    meta: serde_json::Value,
    source_timestamp_ms: Option<i64>,
    is_trashed: bool,
  ) -> AuthResult<()> {
    let result = sqlx::query(
      r#"
      UPDATE docs SET
        title = $3,
        meta = $4,
        deleted_at = CASE WHEN $5 THEN COALESCE(deleted_at, now()) ELSE NULL END,
        created_at = COALESCE(to_timestamp($6::double precision / 1000.0), created_at),
        updated_at = COALESCE(to_timestamp($6::double precision / 1000.0), now())
      WHERE workspace_id = $1 AND id = $2
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(title)
    .bind(meta)
    .bind(is_trashed)
    .bind(source_timestamp_ms)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() != 1 {
      return Err(AuthError::NotFound("imported document".to_string()));
    }
    Ok(())
  }

  /// Insert a personal (userspace) document metadata row.
  #[instrument(skip(self))]
  async fn create_userspace_doc_metadata(&self, owner_id: Uuid, doc_id: Uuid, title: String) -> AuthResult<DocModel> {
    let row = sqlx::query(
            r#"
            WITH requested_language AS (
              SELECT COALESCE(
                NULLIF(values->>'defaultDocumentLanguage', ''),
                NULLIF(values->>'locale', '')
              ) AS key
              FROM user_preferences
              WHERE user_id = $2
            ), preferred_language AS (
              SELECT language.id
              FROM requested_language requested
              JOIN language_definition language
                ON language.is_active
               AND (
                 lower(language.key) = lower(requested.key)
                 OR lower(language.key) = lower(split_part(requested.key, '-', 1))
               )
              ORDER BY (lower(language.key) = lower(requested.key)) DESC,
                       language.sort_order,
                       language.key
              LIMIT 1
            )
            INSERT INTO docs (
              id, external_id, userspace_owner_id, title, is_workspace_root,
              created_by, updated_by, language_id
            )
            VALUES ($1, $1::text, $2, $3, false, $2, $2, (SELECT id FROM preferred_language))
            RETURNING id, external_id, workspace_id, userspace_owner_id, title, meta, blocked, is_workspace_root, public_mode, default_role, created_by, updated_by, created_at, updated_at, deleted_at
            "#
        )
        .bind(doc_id)
        .bind(owner_id)
        .bind(title)
        .fetch_one(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    Ok(self.map_doc_row(row))
  }

  /// Fetch document metadata by ID.
  #[instrument(skip(self))]
  async fn get_doc_metadata(&self, doc_id: Uuid) -> AuthResult<Option<DocModel>> {
    let row = sqlx::query(
            r#"
            SELECT id, external_id, workspace_id, userspace_owner_id, title, meta, blocked, is_workspace_root, public_mode, default_role, created_by, updated_by, created_at, updated_at, deleted_at
            FROM docs
            WHERE id = $1 AND deleted_at IS NULL
            "#
        )
        .bind(doc_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    Ok(row.map(|r| self.map_doc_row(r)))
  }

  #[instrument(skip_all)]
  async fn get_doc_metadata_batch(&self, doc_ids: &[Uuid]) -> AuthResult<HashMap<Uuid, DocModel>> {
    if doc_ids.is_empty() {
      return Ok(HashMap::new());
    }
    let rows = sqlx::query(
      "SELECT id, external_id, workspace_id, userspace_owner_id, title, meta, blocked,
       is_workspace_root, public_mode, default_role, created_by, updated_by,
       created_at, updated_at, deleted_at FROM docs
       WHERE id = ANY($1) AND deleted_at IS NULL",
    )
    .bind(doc_ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| {
          let doc = self.map_doc_row(row);
          (doc.id, doc)
        })
        .collect(),
    )
  }

  #[instrument(skip(self))]
  async fn get_doc_attribution(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<Option<myoxus_application::doc::DocAttribution>> {
    let row = sqlx::query(
      r#"SELECT d.created_at, d.updated_at,
                cu.name AS created_by_name, cu.avatar_key AS created_by_avatar,
                uu.name AS updated_by_name, uu.avatar_key AS updated_by_avatar
         FROM docs d
         LEFT JOIN users cu ON cu.id = d.created_by
         LEFT JOIN users uu ON uu.id = d.updated_by
         WHERE d.id = $1 AND d.workspace_id = $2 AND d.deleted_at IS NULL"#,
    )
    .bind(doc_id)
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(|row| myoxus_application::doc::DocAttribution {
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
      created_by_name: row.get("created_by_name"),
      created_by_avatar_key: row.get("created_by_avatar"),
      updated_by_name: row.get("updated_by_name"),
      updated_by_avatar_key: row.get("updated_by_avatar"),
    }))
  }

  #[instrument(skip(self, doc_ids))]
  async fn resolve_external_doc_ids(&self, workspace_id: Uuid, doc_ids: &[Uuid]) -> AuthResult<HashMap<Uuid, String>> {
    if doc_ids.is_empty() {
      return Ok(HashMap::new());
    }
    let rows =
      sqlx::query("SELECT id, external_id FROM docs WHERE workspace_id = $1 AND id = ANY($2) AND deleted_at IS NULL")
        .bind(workspace_id)
        .bind(doc_ids)
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| (row.get("id"), row.get("external_id")))
        .collect(),
    )
  }

  #[instrument(skip(self))]
  async fn list_public_docs(&self, workspace_id: Uuid) -> AuthResult<Vec<DocModel>> {
    let rows = sqlx::query(
      r#"SELECT id, external_id, workspace_id, userspace_owner_id, title, meta, blocked,
                is_workspace_root, public_mode, default_role,
                created_by, updated_by, created_at, updated_at, deleted_at
         FROM docs
         WHERE workspace_id = $1 AND public_mode IS NOT NULL
           AND deleted_at IS NULL AND blocked = FALSE
         ORDER BY updated_at DESC"#,
    )
    .bind(workspace_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(|row| self.map_doc_row(row)).collect())
  }

  /// Lifecycle authorization needs the row even after it entered the trash.
  /// Keep this separate from `get_doc_metadata`, whose `deleted_at IS NULL`
  /// contract protects ordinary read paths from exposing deleted documents.
  #[instrument(skip(self))]
  async fn get_doc_metadata_including_deleted(&self, doc_id: Uuid) -> AuthResult<Option<DocModel>> {
    let row = sqlx::query(
      r#"
            SELECT id, external_id, workspace_id, userspace_owner_id, title, meta, blocked, is_workspace_root, public_mode, default_role, created_by, updated_by, created_at, updated_at, deleted_at
            FROM docs
            WHERE id = $1
            "#,
    )
    .bind(doc_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.map(|r| self.map_doc_row(r)))
  }

  #[instrument(skip(self))]
  async fn update_doc_default_role(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    role: myoxus_domain::entities::DocDefaultRole,
    actor_id: Uuid,
  ) -> AuthResult<Option<DocModel>> {
    let role = match role {
      myoxus_domain::entities::DocDefaultRole::Editor => "editor",
      myoxus_domain::entities::DocDefaultRole::Viewer => "viewer",
    };
    let row = sqlx::query(
      r#"UPDATE docs
         SET default_role = $1, updated_by = $2, updated_at = now()
         WHERE id = $3 AND workspace_id = $4 AND deleted_at IS NULL
         RETURNING id, external_id, workspace_id, userspace_owner_id, title, meta,
                   blocked, is_workspace_root, public_mode, default_role,
                   created_by, updated_by, created_at, updated_at, deleted_at"#,
    )
    .bind(role)
    .bind(actor_id)
    .bind(doc_id)
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(|row| self.map_doc_row(row)))
  }

  #[instrument(skip(self))]
  async fn update_doc_public_mode(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    public_mode: Option<String>,
    actor_id: Uuid,
  ) -> AuthResult<Option<DocModel>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    if public_mode.is_some() {
      // The row lock serializes this decision with workspace deactivation.
      // Revocation deliberately bypasses the eligibility check.
      let eligible = sqlx::query_scalar::<_, bool>(
        r#"SELECT public AND enable_sharing AND deleted_at IS NULL AND lifecycle_state = 'active'
           FROM workspaces
           WHERE id = $1
           FOR SHARE"#,
      )
      .bind(workspace_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .unwrap_or(false);
      if !eligible {
        return Err(AuthError::InvalidInput(
          "workspace must be public with sharing enabled before publishing documents".to_string(),
        ));
      }
    }
    let row = sqlx::query(
      r#"UPDATE docs
         SET public_mode = $1, updated_by = $2, updated_at = now()
         WHERE id = $3 AND workspace_id = $4 AND deleted_at IS NULL
         RETURNING id, external_id, workspace_id, userspace_owner_id, title, meta,
                   blocked, is_workspace_root, public_mode, default_role,
                   created_by, updated_by, created_at, updated_at, deleted_at"#,
    )
    .bind(public_mode)
    .bind(actor_id)
    .bind(doc_id)
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(row.map(|row| self.map_doc_row(row)))
  }

  /// Soft-delete a document by setting `deleted_at`.
  #[instrument(skip(self))]
  async fn soft_delete_doc(&self, doc_id: Uuid) -> AuthResult<()> {
    sqlx::query("UPDATE docs SET deleted_at = now() WHERE id = $1")
      .bind(doc_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Return the latest persisted clock for each document in a workspace.
  ///
  /// This combines `doc_snapshots.updated_at` with each document's maximum
  /// `doc_updates.server_timestamp`. `after` is an exclusive millisecond lower
  /// bound. External keys are preserved so the response round-trips to the
  /// client's local document identity.
  ///
  /// If a positive filtered query is empty, the unfiltered fallback repairs
  /// clients whose retained clock is newer than all current server state (for
  /// example after a development database reset).
  #[instrument(skip(self))]
  async fn get_space_doc_timestamps(
    &self,
    workspace_id: Uuid,
    after: Option<i64>,
  ) -> AuthResult<std::collections::HashMap<String, i64>> {
    let mut result = std::collections::HashMap::new();

    // Source 1: compacted snapshot clocks. Preserve external IDs so system
    // documents such as `db$...$folders` match their IndexedDB identity.
    // Convert the exclusive millisecond lower bound for PostgreSQL timestamps.
    // Soft-deleted documents are excluded.
    // d.deleted_at IS NULL covers both:
    // - Regular docs where deleted_at is not set (not trashed)
    // - System docs without a docs row (LEFT JOIN → d.id IS NULL → d.deleted_at IS NULL)
    let snapshot_rows = sqlx::query(
      r#"
      SELECT COALESCE(d.external_id, ds.doc_id::text) AS doc_key,
             ds.updated_at
      FROM doc_snapshots ds
      LEFT JOIN docs d ON d.id = ds.doc_id
      WHERE ((ds.workspace_id = $1 AND d.userspace_owner_id IS NULL) OR d.userspace_owner_id = $1)
        AND ($2::BIGINT IS NULL OR ds.updated_at > to_timestamp($2::DOUBLE PRECISION / 1000.0))
        AND d.deleted_at IS NULL
      "#,
    )
    .bind(workspace_id)
    .bind(after)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    for row in snapshot_rows {
      let doc_key: String = row.get("doc_key");
      let updated_at: chrono::DateTime<chrono::Utc> = row.get("updated_at");
      let ts = updated_at.timestamp_millis();
      result.insert(doc_key, ts);
    }

    // Source 2: updates not yet represented by a snapshot. Aggregate before
    // applying the lower bound, then retain the newer of update and snapshot.
    // Apply the same lifecycle filter as the snapshot query.
    // d.deleted_at IS NULL also covers system docs (d.id IS NULL from LEFT JOIN).
    let update_rows = sqlx::query(
      r#"
      SELECT COALESCE(d.external_id, du.doc_id::text) AS doc_key,
             MAX(du.server_timestamp) AS max_ts
      FROM doc_updates du
      LEFT JOIN docs d ON d.id = du.doc_id
      WHERE ((du.workspace_id = $1 AND d.userspace_owner_id IS NULL) OR d.userspace_owner_id = $1)
        AND d.deleted_at IS NULL
      GROUP BY doc_key
      "#,
    )
    .bind(workspace_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    for row in update_rows {
      let doc_key: String = row.get("doc_key");
      let max_ts: chrono::DateTime<chrono::Utc> = row.get("max_ts");
      let ts = max_ts.timestamp_millis();
      // Apply the exclusive lower bound and choose the latest source clock.
      if after.is_none_or(|a| ts > a) {
        let current = result.get(&doc_key).copied().unwrap_or(0);
        if ts > current {
          result.insert(doc_key, ts);
        }
      }
    }

    // A retained client clock can be newer than all current server clocks. An
    // unfiltered retry prevents that stale clock from suppressing every doc.
    if result.is_empty() && after.is_some_and(|a| a > 0) {
      tracing::debug!(
        %workspace_id,
        client_after = after.unwrap_or(0),
        "load-doc-timestamps returned empty with after>0 — falling back to unfiltered query (Option C safety net)"
      );
      // One bounded retry without a lower bound returns the complete clock map.
      return self.get_space_doc_timestamps(workspace_id, None).await;
    }

    Ok(result)
  }

  /// Permanently delete a document and all owned data.
  ///
  /// `hard_delete_doc_scoped` enforces workspace isolation. Foreign-key
  /// cascades remove relational `docs(id)` dependents; denormalized text-keyed
  /// search and Copilot records are removed explicitly in the same transaction.
  #[instrument(skip(self))]
  async fn hard_delete_doc(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<()> {
    self.hard_delete_doc_scoped(workspace_id, doc_id).await?;
    Ok(())
  }

  #[instrument(skip(self, external_ids), fields(doc_count = external_ids.len()))]
  async fn list_delete_candidates(
    &self,
    workspace_id: Uuid,
    external_ids: &[String],
  ) -> AuthResult<Vec<DocDeleteCandidate>> {
    if external_ids.is_empty() {
      return Ok(Vec::new());
    }

    let rows = sqlx::query(
      r#"
      SELECT id,
             external_id AS client_doc_id,
             title,
             workspace_id,
             is_workspace_root,
             deleted_at
      FROM docs
      WHERE workspace_id = $1
        AND external_id = ANY($2)
      "#,
    )
    .bind(workspace_id)
    .bind(external_ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(rows.into_iter().map(Self::map_delete_candidate_row).collect())
  }

  #[instrument(skip(self))]
  async fn list_trashed_delete_candidates(
    &self,
    workspace_id: Uuid,
    limit: i64,
  ) -> AuthResult<Vec<DocDeleteCandidate>> {
    let rows = sqlx::query(
      r#"
      SELECT id,
             external_id AS client_doc_id,
             title,
             workspace_id,
             is_workspace_root,
             deleted_at
      FROM docs
      WHERE workspace_id = $1
        AND deleted_at IS NOT NULL
        AND is_workspace_root = false
      ORDER BY deleted_at ASC, id ASC
      LIMIT $2
      "#,
    )
    .bind(workspace_id)
    .bind(limit.max(0))
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(rows.into_iter().map(Self::map_delete_candidate_row).collect())
  }

  #[instrument(skip(self))]
  async fn hard_delete_doc_scoped(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<bool> {
    self.hard_delete_doc_scoped_inner(workspace_id, doc_id, None).await
  }

  async fn hard_delete_doc_scoped_at_revision(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    revision: i64,
    ownership: SourceRetirementOwnership,
  ) -> AuthResult<bool> {
    self
      .hard_delete_doc_scoped_inner(workspace_id, doc_id, Some((revision, ownership)))
      .await
  }

  /// Return document IDs that need the title backfill job.
  ///
  /// Both `NULL` and empty titles qualify. `limit` bounds the batch; ordering is
  /// intentionally unspecified.
  #[instrument(skip(self))]
  async fn find_docs_without_title(&self, workspace_id: Uuid, limit: i64) -> AuthResult<Vec<Uuid>> {
    // Soft-deleted documents may also receive a harmless title backfill.
    let rows = sqlx::query("SELECT id FROM docs WHERE workspace_id = $1 AND (title IS NULL OR title = '') LIMIT $2")
      .bind(workspace_id)
      .bind(limit)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(|r| r.get("id")).collect())
  }

  #[instrument(skip(self))]
  async fn find_title_backfill_candidates(&self, limit: i64) -> AuthResult<Vec<DocTitleBackfillCandidate>> {
    let rows = sqlx::query(
      r#"
      SELECT d.workspace_id, d.id
      FROM docs AS d
      WHERE (d.title IS NULL OR d.title = '')
        AND d.deleted_at IS NULL
        AND d.workspace_id IS NOT NULL
        AND d.id <> d.workspace_id
        AND COALESCE(d.external_id, '') <> 'db$docProperties'
        AND COALESCE(d.external_id, '') NOT LIKE 'db$%$docProperties'
        AND EXISTS (
          SELECT 1
          FROM doc_updates AS u
          WHERE u.doc_id = d.id
        )
      ORDER BY d.updated_at ASC, d.id ASC
      LIMIT $1
      "#,
    )
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(
      rows
        .into_iter()
        .map(|row| DocTitleBackfillCandidate {
          workspace_id: row.get("workspace_id"),
          doc_id: row.get("id"),
        })
        .collect(),
    )
  }

  /// List active workspace documents using offset pagination.
  ///
  /// Results are workspace-scoped, exclude soft-deleted rows, and order newest
  /// creation first.
  #[instrument(skip(self))]
  async fn list_docs_in_workspace(
    &self,
    workspace_id: Uuid,
    limit: i64,
    offset: i64,
  ) -> AuthResult<Vec<myoxus_domain::entities::Doc>> {
    let rows = sqlx::query(
      r#"
      SELECT id, external_id, workspace_id, userspace_owner_id, title, meta, blocked,
             is_workspace_root, public_mode, default_role,
             created_by, updated_by, created_at, updated_at, deleted_at
      FROM docs
      WHERE workspace_id = $1 AND deleted_at IS NULL
        AND (
          is_workspace_root = TRUE
          OR EXISTS (
            SELECT 1 FROM doc_snapshots ds
            WHERE ds.workspace_id = docs.workspace_id AND ds.doc_id = docs.id
          )
          OR EXISTS (
            SELECT 1 FROM doc_updates du
            WHERE du.workspace_id = docs.workspace_id AND du.doc_id = docs.id
          )
        )
      ORDER BY created_at DESC, id ASC
      LIMIT $2 OFFSET $3
      "#,
    )
    .bind(workspace_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(rows.into_iter().map(|r| self.map_doc_row(r)).collect())
  }

  #[instrument(skip(self))]
  async fn list_content_docs_in_workspace(
    &self,
    workspace_id: Uuid,
    limit: i64,
  ) -> AuthResult<Vec<myoxus_domain::entities::Doc>> {
    let rows = sqlx::query(
      r#"SELECT id, external_id, workspace_id, userspace_owner_id, title, meta, blocked,
                is_workspace_root, public_mode, default_role,
                created_by, updated_by, created_at, updated_at, deleted_at
         FROM docs
         WHERE workspace_id = $1 AND deleted_at IS NULL AND blocked = FALSE
           AND (
             is_workspace_root = TRUE
             OR EXISTS (
               SELECT 1 FROM doc_snapshots ds
               WHERE ds.workspace_id = docs.workspace_id AND ds.doc_id = docs.id
             )
             OR EXISTS (
               SELECT 1 FROM doc_updates du
               WHERE du.workspace_id = docs.workspace_id AND du.doc_id = docs.id
             )
           )
         ORDER BY updated_at DESC
         LIMIT $2"#,
    )
    .bind(workspace_id)
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(|row| self.map_doc_row(row)).collect())
  }

  #[instrument(skip(self))]
  async fn count_workspace_documents(&self, workspace_id: Uuid) -> AuthResult<i64> {
    sqlx::query_scalar(
      "SELECT COUNT(*)::BIGINT FROM docs WHERE workspace_id = $1 AND deleted_at IS NULL AND is_workspace_root = FALSE",
    )
    .bind(workspace_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }
}

#[async_trait]
impl DocPermissionStore for SqlxDocStore {
  /// Fetch a user's per-document role, returning `None` when no row exists.
  #[instrument(skip(self))]
  async fn get_user_doc_role(&self, user_id: Uuid, doc_id: Uuid) -> AuthResult<Option<DocRole>> {
    let row = sqlx::query("SELECT role FROM doc_user_permissions WHERE user_id = $1 AND doc_id = $2")
      .bind(user_id)
      .bind(doc_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_db_err)?;

    Ok(row.map(|r| Self::parse_doc_role(&r.get::<String, _>("role"))))
  }

  /// Insert or update a user's per-document role.
  #[instrument(skip(self))]
  async fn upsert_user_doc_role(&self, user_id: Uuid, doc_id: Uuid, role: DocRole) -> AuthResult<()> {
    self.bulk_upsert_user_doc_roles(&[user_id], doc_id, role, None).await
  }

  /// Remove a user's per-document role grant.
  #[instrument(skip(self))]
  async fn delete_user_doc_role(&self, user_id: Uuid, doc_id: Uuid) -> AuthResult<()> {
    sqlx::query("DELETE FROM doc_user_permissions WHERE user_id = $1 AND doc_id = $2")
      .bind(user_id)
      .bind(doc_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Persist actual permission transitions and their mail intent in one SQL statement.
  /// Repeating an unchanged grant emits no event; revoked/re-granted access creates
  /// a new event identity, so a later genuine share is not suppressed forever.
  #[instrument(skip_all)]
  async fn bulk_upsert_user_doc_roles(
    &self,
    user_ids: &[Uuid],
    doc_id: Uuid,
    role: DocRole,
    actor: Option<Uuid>,
  ) -> AuthResult<()> {
    if user_ids.is_empty() {
      return Ok(());
    }
    sqlx::query(
      r#"
      WITH changed AS (
        INSERT INTO doc_user_permissions (user_id, doc_id, role)
        SELECT DISTINCT recipient, $2, $3 FROM unnest($1::uuid[]) AS recipient
        ON CONFLICT (user_id, doc_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()
        WHERE doc_user_permissions.role IS DISTINCT FROM EXCLUDED.role
        RETURNING user_id, doc_id, role
      )
      INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload)
      SELECT gen_random_uuid(), 'doc', changed.doc_id::text, 'access_change',
        jsonb_build_object('action', 'document_shared', 'workspaceId', docs.workspace_id,
          'docId', changed.doc_id, 'userId', changed.user_id, 'actorUserId', $4::uuid)
      FROM changed JOIN docs ON docs.id = changed.doc_id
      WHERE docs.workspace_id IS NOT NULL AND docs.deleted_at IS NULL
        AND changed.role IN ('Reader', 'Commenter', 'Editor', 'Manager', 'Owner')
        AND ($4::uuid IS NULL OR changed.user_id <> $4)
    "#,
    )
    .bind(user_ids)
    .bind(doc_id)
    .bind(Self::doc_role_to_db(role))
    .bind(actor)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Batch-revoke roles from multiple users on a single document.
  #[instrument(skip(self))]
  async fn bulk_delete_user_doc_roles(&self, user_ids: &[Uuid], doc_id: Uuid) -> AuthResult<()> {
    if user_ids.is_empty() {
      return Ok(());
    }
    sqlx::query("DELETE FROM doc_user_permissions WHERE user_id = ANY($1) AND doc_id = $2")
      .bind(user_ids)
      .bind(doc_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// List all (user_id, role) pairs that have an explicit permission on a doc.
  #[instrument(skip(self))]
  async fn list_doc_permissions(&self, doc_id: Uuid) -> AuthResult<Vec<(Uuid, DocRole)>> {
    let rows = sqlx::query("SELECT user_id, role FROM doc_user_permissions WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)?;

    let perms = rows
      .into_iter()
      .map(|r| (r.get("user_id"), Self::parse_doc_role(&r.get::<String, _>("role"))))
      .collect();

    Ok(perms)
  }

  #[instrument(skip(self))]
  async fn list_granted_users(&self, doc_id: Uuid) -> AuthResult<Vec<myoxus_application::doc::DocGrantedUser>> {
    let rows = sqlx::query(
      r#"SELECT dup.role, u.id AS user_id, u.name, u.email, u.avatar_key
         FROM doc_user_permissions dup
         JOIN users u ON u.id = dup.user_id
         WHERE dup.doc_id = $1
         ORDER BY dup.created_at DESC"#,
    )
    .bind(doc_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| myoxus_application::doc::DocGrantedUser {
          user_id: row.get("user_id"),
          role: Self::parse_doc_role(&row.get::<String, _>("role")),
          name: row.get("name"),
          email: row.get("email"),
          avatar_key: row.get("avatar_key"),
        })
        .collect(),
    )
  }
}

#[async_trait]
impl DocUpdateStore for SqlxDocStore {
  /// Append one Yjs-v1 update to a document's update log.
  ///
  /// Sequence assignment and external-key resolution are server-owned. The
  /// sequence continues beyond a compacted snapshot because `load_full_doc`
  /// reads only updates above `doc_snapshots.last_sequence`. For userspace
  /// documents, `update.workspace_id` contains the owner UUID rather than a
  /// workspace UUID.
  #[instrument(skip_all)]
  async fn push_update(&self, update: DocUpdateWrite) -> AuthResult<DocUpdatePersistenceResult> {
    self.push_update_with_project_placement(update, None).await
  }
  #[instrument(skip_all)]
  async fn commit_project_placement(
    &self,
    update: DocUpdateWrite,
    ack: myoxus_application::workspace::ProjectPlacementAck,
  ) -> AuthResult<DocUpdatePersistenceResult> {
    self.push_update_with_project_placement(update, Some(ack)).await
  }

  #[instrument(skip(self, payload), fields(%workspace_id, %doc_id))]
  async fn push_revision_checked_update(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    expected_revision: &str,
    payload: Vec<u8>,
  ) -> AuthResult<DocRevisionCheckedUpdateOutcome> {
    if payload.is_empty() {
      return Err(AuthError::Storage(
        "revision-checked document update must not be empty".to_string(),
      ));
    }
    yjs::decode_update_v1(&payload).map_err(|_| AuthError::InvalidYjsUpdate)?;

    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let mut locked_docs = BTreeSet::from([doc_id]);
    locked_docs.extend(Self::title_projection_lock_candidates_in_tx(&mut tx, workspace_id, doc_id, &payload).await?);
    for locked_doc_id in locked_docs.iter().copied() {
      sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(workspace_document_lock_key(workspace_id, locked_doc_id))
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }

    sqlx::query_scalar::<_, i32>(
      "SELECT 1 FROM docs WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::NotFound("document".to_string()))?;

    let required = Self::title_projection_lock_candidates_in_tx(&mut tx, workspace_id, doc_id, &payload).await?;
    if !required.is_subset(&locked_docs) {
      tx.rollback().await.map_err(Self::map_db_err)?;
      return Box::pin(self.push_revision_checked_update(workspace_id, doc_id, expected_revision, payload)).await;
    }

    let current = Self::load_full_doc_in_tx(&mut tx, workspace_id, doc_id).await?;
    let current_revision =
      canonical_yjs_revision(&current).map_err(|_| AuthError::Storage("persisted Yjs state is invalid".to_string()))?;
    if current_revision != expected_revision {
      tx.rollback().await.map_err(Self::map_db_err)?;
      return Ok(DocRevisionCheckedUpdateOutcome::Stale { current_revision });
    }

    let sequence: i64 = sqlx::query_scalar(
      "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
       VALUES ($1, $2, $3,
         GREATEST(
           COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE workspace_id = $2 AND doc_id = $1), 0),
           COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id = $2 AND doc_id = $1), 0)
         ) + 1)
       RETURNING sequence",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(&payload)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    sqlx::query("UPDATE docs SET sync_state_vector_v1 = NULL, updated_at = now() WHERE id = $1")
      .bind(doc_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    crate::document_metadata::PgDocumentMetadataRepository::mark_named_version_dirty_in_tx(&mut tx, doc_id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    Self::mark_edit_capture_dirty_in_tx(&mut tx, workspace_id, doc_id, sequence).await?;
    let accepted = PageLifecycleDelta {
      doc_id,
      sequence,
      delta: payload.clone(),
    };
    let mut updates = vec![accepted];
    if let Some(root) = Self::project_leaf_title_in_tx(
      &mut tx,
      workspace_id,
      doc_id,
      chrono::Utc::now(),
      locked_docs.contains(&workspace_id),
    )
    .await?
    {
      updates.push(root);
    }
    Self::append_workspace_doc_broadcast_outbox(
      &mut tx,
      doc_id,
      workspace_id,
      None,
      "revision_checked_update",
      &updates,
    )
    .await?;
    tx.commit().await.map_err(Self::map_db_err)?;

    Ok(DocRevisionCheckedUpdateOutcome::Appended { sequence })
  }

  #[instrument(skip(self, mutation), fields(%workspace_id, %doc_id, operation = mutation.name()))]
  async fn mutate_content(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    actor_user_id: Option<Uuid>,
    mutation: yjs::DocumentMutation,
    capture_recovery_history: bool,
    expected_sequence: Option<i64>,
  ) -> AuthResult<DocContentMutationCommit> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let current = Self::load_full_doc_in_tx(&mut tx, workspace_id, doc_id).await?;
    let preview = yjs::apply_document_mutation(&current, &mutation).map_err(Self::map_document_mutation_error)?;
    let mut locked_docs = BTreeSet::from([doc_id]);
    locked_docs
      .extend(Self::title_projection_lock_candidates_in_tx(&mut tx, workspace_id, doc_id, &preview.delta).await?);
    tx.rollback().await.map_err(Self::map_db_err)?;

    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    for locked_doc_id in locked_docs.iter().copied() {
      sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(workspace_document_lock_key(workspace_id, locked_doc_id))
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    let result = self
      .mutate_content_in_tx(
        &mut tx,
        workspace_id,
        doc_id,
        actor_user_id,
        ContentChange::Semantic(&mutation),
        capture_recovery_history,
        expected_sequence,
        locked_docs.contains(&workspace_id),
      )
      .await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(result)
  }

  /// Return updates with `sequence > after_sequence` in ascending order.
  ///
  /// Logical space scoping accepts a workspace UUID or authoritative userspace
  /// owner UUID; private binary rows retain their deployed workspace FK. `-1`
  /// returns the complete log from sequence zero. Ordering is required by merge.
  #[instrument(skip(self))]
  async fn get_updates_after(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    after_sequence: i64,
  ) -> AuthResult<Vec<DocUpdate>> {
    trace!(%workspace_id, %doc_id, after_sequence, "get_updates_after");
    // The exclusive comparison avoids replaying the caller's last sequence.
    let rows = sqlx::query(
      r#"
            SELECT workspace_id, doc_id, payload, sequence
            FROM doc_updates
            WHERE doc_id = $2 AND sequence > $3
              AND (workspace_id = $1 OR EXISTS (
                SELECT 1 FROM docs WHERE id = $2 AND userspace_owner_id = $1
              ))
            ORDER BY sequence ASC
            "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(after_sequence)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let updates: Vec<DocUpdate> = rows
      .into_iter()
      .map(|row| DocUpdate {
        workspace_id: row.get("workspace_id"),
        doc_id: row.get("doc_id"),
        payload: row.get("payload"),
        sequence: row.get("sequence"),
        // The update log does not retain enough information to reconstruct the
        // space kind; persisted update reads use the workspace default.
        space_kind: myoxus_application::doc::DocSpaceKind::Workspace,
      })
      .collect();

    trace!(
      %workspace_id, %doc_id, after_sequence,
      result_count = updates.len(),
      total_bytes = updates.iter().map(|u| u.payload.len()).sum::<usize>(),
      "fetched doc updates"
    );

    Ok(updates)
  }

  /// Count pending, not-yet-compacted updates for one document.
  ///
  /// Used for monitoring and auto-compaction decisions. The document ID is
  /// indexed, keeping the count scoped to that document's update range.
  #[instrument(skip(self))]
  async fn count_pending_updates(&self, doc_id: Uuid) -> AuthResult<i64> {
    let row = sqlx::query("SELECT COUNT(*) as cnt FROM doc_updates WHERE doc_id = $1")
      .bind(doc_id)
      .fetch_one(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(row.get::<i64, _>("cnt"))
  }

  /// Count all pending updates across the instance.
  ///
  /// This unscoped monitoring metric may require a sequential scan on large
  /// installations. Do not call it from a request-critical path.
  #[instrument(skip(self))]
  async fn count_all_pending_updates(&self) -> AuthResult<i64> {
    let row = sqlx::query("SELECT COUNT(*) as cnt FROM doc_updates")
      .fetch_one(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(row.get::<i64, _>("cnt"))
  }

  /// Return the highest update sequence for a workspace document.
  ///
  /// The database aggregate avoids loading the update log into memory. A
  /// document without updates returns zero through `COALESCE`.
  #[instrument(skip(self))]
  async fn max_update_sequence(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<i64> {
    let row = sqlx::query(
      "SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    let max_seq: i64 = row.get("max_seq");
    trace!(%workspace_id, %doc_id, max_seq, "max_update_sequence");
    Ok(max_seq)
  }
}

#[async_trait]
impl DocLoadStore for SqlxDocStore {
  /// Stream snapshot and tail from one repeatable-read database view.
  ///
  /// Compaction replaces the snapshot and deletes covered updates in one
  /// transaction. Reading both tables under `READ COMMITTED` in separate
  /// statements can therefore observe an old snapshot after the corresponding
  /// tail was deleted. This read-only repeatable-read transaction prevents that
  /// data-loss window while the capacity-one channel bounds row ownership.
  #[instrument(skip(self, sender, cancellation), fields(%sync_operation_id, %workspace_id, %doc_id))]
  async fn stream_doc_state(
    &self,
    sync_operation_id: Uuid,
    workspace_id: Uuid,
    doc_id: Uuid,
    sender: tokio::sync::mpsc::Sender<Vec<u8>>,
    cancellation: DocLoadCancellation,
  ) -> AuthResult<DocStateStreamMeta> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;

    let doc_row = sqlx::query(
      "SELECT deleted_at, userspace_owner_id FROM docs
       WHERE id = $1 AND (workspace_id = $2 OR userspace_owner_id = $2)",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let exists = doc_row.as_ref().is_some_and(|row| {
      row
        .get::<Option<chrono::DateTime<chrono::Utc>>, _>("deleted_at")
        .is_none()
    });

    // Userspace wire scope is the owner UUID; existing update/snapshot rows
    // retain a workspace FK. Resolve access from the authoritative document,
    // rather than confusing that physical container with the private owner.
    let userspace = doc_row
      .as_ref()
      .is_some_and(|row| row.get::<Option<Uuid>, _>("userspace_owner_id") == Some(workspace_id));
    let snapshot = sqlx::query(
      "SELECT payload, updated_at, last_sequence FROM doc_snapshots
       WHERE doc_id = $2 AND (workspace_id = $1 OR $3)",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(userspace)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let (snapshot_payload, updated_at, last_sequence) = match snapshot {
      Some(row) => (
        row.get::<Vec<u8>, _>("payload"),
        Some(row.get("updated_at")),
        row.get("last_sequence"),
      ),
      None => (Vec::new(), None, -1_i64),
    };
    let mut revision = last_sequence.max(0);
    let mut stats = DocUpdateStreamStats::default();
    if !snapshot_payload.is_empty() {
      stats.update_count = 1;
      stats.input_bytes = snapshot_payload.len();
      tokio::select! {
        _ = cancellation.cancelled() => return Err(AuthError::DocSyncCancelled),
        sent = sender.send(snapshot_payload) => sent.map_err(|_| AuthError::DocSyncCancelled)?,
      }
    }

    {
      let mut rows = sqlx::query(
        "SELECT payload, sequence FROM doc_updates
         WHERE doc_id = $2 AND (workspace_id = $1 OR $4) AND sequence > $3
         ORDER BY sequence ASC",
      )
      .bind(workspace_id)
      .bind(doc_id)
      .bind(last_sequence)
      .bind(userspace)
      .fetch(&mut *tx);
      loop {
        let next = tokio::select! {
          _ = cancellation.cancelled() => return Err(AuthError::DocSyncCancelled),
          row = rows.try_next() => row.map_err(Self::map_db_err)?,
        };
        let Some(row) = next else {
          break;
        };
        let payload: Vec<u8> = row.get("payload");
        revision = revision.max(row.get("sequence"));
        stats.update_count += 1;
        stats.input_bytes = stats.input_bytes.saturating_add(payload.len());
        tokio::select! {
          _ = cancellation.cancelled() => return Err(AuthError::DocSyncCancelled),
          sent = sender.send(payload) => sent.map_err(|_| AuthError::DocSyncCancelled)?,
        }
      }
    }
    tx.commit().await.map_err(Self::map_db_err)?;

    trace!(
      %sync_operation_id,
      %workspace_id,
      %doc_id,
      update_count = stats.update_count,
      input_bytes = stats.input_bytes,
      "streamed consistent doc snapshot and tail"
    );
    Ok(DocStateStreamMeta {
      revision,
      updated_at,
      exists,
      has_real_content: stats.update_count > 0,
      stats,
    })
  }
}

#[async_trait]
impl DocSnapshotStore for SqlxDocStore {
  /// Return the current compacted Yjs snapshot.
  ///
  /// Scope is a workspace UUID or authoritative userspace owner UUID. The
  /// single-snapshot model stores at most one row per document; `None` means
  /// the scoped document has not been compacted.
  #[instrument(skip(self))]
  async fn get_snapshot(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<Option<Vec<u8>>> {
    trace!(%workspace_id, %doc_id, "get_snapshot");
    let row = sqlx::query(
      "SELECT payload FROM doc_snapshots WHERE doc_id = $2
       AND (workspace_id = $1 OR EXISTS (
         SELECT 1 FROM docs WHERE id = $2 AND userspace_owner_id = $1
       ))",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let snapshot = row.map(|r| r.get::<Vec<u8>, _>("payload"));
    trace!(
      %workspace_id, %doc_id,
      found = snapshot.is_some(),
      snapshot_size = snapshot.as_ref().map(|s| s.len()).unwrap_or(0),
      "fetched doc snapshot"
    );
    Ok(snapshot)
  }

  /// Load snapshot payload and compaction metadata in one database read.
  ///
  /// `updated_at` reflects the maximum timestamp among merged updates, not the
  /// wall-clock compaction time, so document timestamp headers remain stable.
  #[instrument(skip(self))]
  async fn get_snapshot_with_meta(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<Option<myoxus_application::doc::DocSnapshotMeta>> {
    use myoxus_application::doc::DocSnapshotMeta;
    trace!(%workspace_id, %doc_id, "get_snapshot_with_meta");
    let row = sqlx::query(
      "SELECT payload, updated_at, last_sequence FROM doc_snapshots WHERE doc_id = $2
       AND (workspace_id = $1 OR EXISTS (
         SELECT 1 FROM docs WHERE id = $2 AND userspace_owner_id = $1
       ))",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.map(|r| DocSnapshotMeta {
      payload: r.get("payload"),
      updated_at: r.get("updated_at"),
      last_sequence: r.get("last_sequence"),
    }))
  }

  /// Persist a compacted snapshot and its relational side effects atomically.
  ///
  /// Limit enforcement, snapshot upsert, update cleanup, outbox publication,
  /// storage statistics, and title backfill share one transaction. Cache
  /// invalidation runs after commit and is best effort.
  ///
  /// `updated_at` uses the maximum timestamp of the merged updates rather than
  /// `now()`, preserving the `space:load-doc-timestamps` clock contract.
  #[instrument(skip(self, payload))]
  async fn save_snapshot(
    &self,
    doc_id: Uuid,
    workspace_id: Uuid,
    payload: Vec<u8>,
    last_sequence: i64,
  ) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // Private compaction receives the owner UUID just like private loads.
    // Keep the persisted workspace FK; document ownership is the access scope.
    let workspace_id = sqlx::query_scalar::<_, Option<Uuid>>(
      "SELECT COALESCE(
         (SELECT workspace_id FROM doc_snapshots WHERE doc_id = $1),
         (SELECT workspace_id FROM doc_updates WHERE doc_id = $1 ORDER BY sequence LIMIT 1),
         (SELECT id FROM workspaces WHERE owner_user_id = $2
            AND lifecycle_state = 'active' AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1)
       ) FROM docs WHERE id = $1 AND userspace_owner_id = $2",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .flatten()
    .unwrap_or(workspace_id);
    let lock_space_id = sqlx::query_scalar::<_, Option<Uuid>>("SELECT userspace_owner_id FROM docs WHERE id = $1")
      .bind(doc_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .flatten()
      .unwrap_or(workspace_id);
    let mut locked_docs = BTreeSet::from([doc_id]);
    locked_docs.extend(Self::title_projection_lock_candidates_in_tx(&mut tx, workspace_id, doc_id, &payload).await?);
    tx.rollback().await.map_err(Self::map_db_err)?;
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    for locked_doc_id in locked_docs.iter().copied() {
      sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(workspace_document_lock_key(lock_space_id, locked_doc_id))
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }

    // Section 1: enforce the resolved technical storage limit.
    // Priority chain (see quota_resolver::resolve_effective_quota_with_config):
    //   1. workspaces.storage_quota_bytes (workspace-level override)
    //   2. config default_workspace_quota_mb
    //   4. 0 = unlimited
    //
    // Prefer the Redis projection; on a miss, resolve the complete override
    // hierarchy from SQL. Zero means unlimited.
    let effective_quota = if let Some(cache) = &self.quota_cache {
      match cache.get_quota(workspace_id).await {
        Some(q) => q,
        None => {
          // Cache-Miss: resolve via JOIN query honouring the full 4-level hierarchy.
          let effective =
            crate::quota_resolver::resolve_effective_quota(&self.pool, workspace_id, self.default_workspace_quota_mb)
              .await;
          cache.set_quota(workspace_id, effective).await;
          effective
        }
      }
    } else {
      // No cache: resolve directly via JOIN query.
      crate::quota_resolver::resolve_effective_quota(&self.pool, workspace_id, self.default_workspace_quota_mb).await
    };

    if effective_quota > 0 {
      // Resolve current snapshot plus blob usage from cache or SQL.
      let current_usage = if let Some(cache) = &self.quota_cache {
        match cache.get_usage(workspace_id).await {
          Some((snap, blob)) => (snap + blob) as i64,
          None => {
            let usage: i64 = sqlx::query_scalar(
              "SELECT COALESCE(snapshot_size, 0) + COALESCE(blob_size, 0) FROM workspace_storage_stats WHERE workspace_id = $1",
            )
            .bind(workspace_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(Self::map_db_err)?
            .unwrap_or(0);
            usage
          }
        }
      } else {
        sqlx::query_scalar(
          "SELECT COALESCE(snapshot_size, 0) + COALESCE(blob_size, 0) FROM workspace_storage_stats WHERE workspace_id = $1",
        )
        .bind(workspace_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?
        .unwrap_or(0)
      };

      // Saturating addition keeps pathological sizes from wrapping the limit
      // check.
      let projected = (current_usage as u64).saturating_add(payload.len() as u64);
      if projected > effective_quota {
        tracing::warn!(
          %workspace_id, %doc_id, current_usage, quota = effective_quota, payload_len = payload.len(),
          "snapshot write rejected: storage quota exceeded"
        );
        return Err(AuthError::StorageQuotaExceeded {
          workspace_id,
          current_bytes: current_usage as u64,
          write_bytes: payload.len() as u64,
          quota_bytes: effective_quota,
        });
      }
    }

    // Section 2: upsert the single snapshot. Its clock is the latest merged
    // update timestamp, preserving incremental timestamp queries. `now()` is
    // used only when no source update remains.
    let snapshot_payload_size = payload.len();
    sqlx::query(
      r#"
            INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at)
            VALUES ($1, $2, $3, $4,
              COALESCE(
                (SELECT MAX(server_timestamp) FROM doc_updates WHERE doc_id = $1 AND sequence <= $4),
                now()
              )
            )
            ON CONFLICT (doc_id) DO UPDATE SET
                payload = EXCLUDED.payload,
                last_sequence = EXCLUDED.last_sequence,
                updated_at = COALESCE(
                  (SELECT MAX(server_timestamp) FROM doc_updates WHERE doc_id = $1 AND sequence <= $4),
                  now()
                )
            "#,
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(payload)
    .bind(last_sequence)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    // Section 3: remove updates included in the snapshot; later sequences stay.
    let deleted = sqlx::query(
      "DELETE FROM doc_updates updates
       WHERE updates.doc_id = $1 AND updates.sequence <= $2
         AND NOT EXISTS (
           SELECT 1 FROM outbox_events event
           WHERE event.event_type = 'workspace_doc_broadcast'
             AND event.processed_at IS NULL
             AND event.aggregate_id = $1::text
             AND (
               (event.payload->>'sequence')::bigint = updates.sequence
               OR EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements(COALESCE(event.payload->'updates', '[]'::jsonb)) item
                 WHERE item->>'docId' = $1::text
                   AND (item->>'sequence')::bigint = updates.sequence
               )
             )
         )",
    )
    .bind(doc_id)
    .bind(last_sequence)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    // Keep search-refresh intent atomic with the compacted snapshot.
    Self::append_doc_updated_outbox(&mut tx, doc_id, workspace_id).await?;

    // Section 5: recompute snapshot usage from source rows. Delta accounting
    // would drift under concurrent compactions; blob usage is retained.
    // Guard with EXISTS: if the workspace was concurrently deleted, skip the stats
    // update instead of failing with a FK violation that would roll back the snapshot.
    sqlx::query(
      r#"
      INSERT INTO workspace_storage_stats (workspace_id, snapshot_size, blob_size, updated_at)
      SELECT $1,
        COALESCE((SELECT SUM(length(payload)) FROM doc_snapshots WHERE workspace_id = $1), 0),
        0, now()
      WHERE EXISTS (
        SELECT 1 FROM workspaces
         WHERE id = $1
           AND lifecycle_state = 'active'
           AND deleted_at IS NULL
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        snapshot_size = COALESCE(
          (SELECT SUM(length(payload)) FROM doc_snapshots WHERE workspace_id = $1), 0),
        updated_at = now()
      "#,
    )
    .bind(workspace_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    // Re-read the new snapshot plus any retained tail under the document lock.
    // This preserves an intentionally empty current title even when the
    // compacted snapshot was produced from an older non-empty state.
    if let Some(root) = Self::project_leaf_title_in_tx(
      &mut tx,
      workspace_id,
      doc_id,
      chrono::Utc::now(),
      locked_docs.contains(&workspace_id),
    )
    .await?
    {
      Self::append_workspace_doc_broadcast_outbox(
        &mut tx,
        doc_id,
        workspace_id,
        None,
        "snapshot_title_projection",
        std::slice::from_ref(&root),
      )
      .await?;
    }

    tracing::info!(
      %doc_id,
      last_sequence,
      deleted_updates = deleted.rows_affected(),
      "snapshot saved, old updates deleted, doc_updated event emitted, storage stats updated"
    );
    trace!(
      new_snapshot_size = snapshot_payload_size,
      deleted_update_count = deleted.rows_affected(),
      "snapshot saved after compaction"
    );

    tx.commit().await.map_err(Self::map_db_err)?;

    // After commit, invalidate the best-effort usage cache so the next check
    // observes the committed statistics.
    if let Some(cache) = &self.quota_cache {
      cache.invalidate_usage(workspace_id).await;
    }

    Ok(())
  }
}

#[async_trait]
impl DocHistoryStore for SqlxDocStore {
  #[instrument(skip(self), fields(%workspace_id, %doc_id, history_id))]
  async fn read_history_comparison(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    history_id: i64,
    max_input_bytes: usize,
  ) -> AuthResult<myoxus_application::doc::history::DocHistoryComparisonRead> {
    let too_large = || AuthError::DocSyncPayloadTooLarge {
      max_bytes: max_input_bytes,
    };
    let sql_limit = i64::try_from(max_input_bytes).map_err(|_| too_large())?;
    let mut tx = self.begin_history_metadata_read(workspace_id, doc_id).await?;
    // CASE bounds allocation before transferring a potentially oversized row.
    let history = sqlx::query(
      "SELECT CASE WHEN octet_length(snapshot) <= $4 THEN snapshot END AS payload
       FROM doc_histories WHERE id=$1 AND workspace_id=$2 AND doc_id=$3",
    )
    .bind(history_id)
    .bind(workspace_id)
    .bind(doc_id)
    .bind(sql_limit)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::NotFound("document history".into()))?;
    let history_snapshot: Vec<u8> = history.get::<Option<Vec<u8>>, _>("payload").ok_or_else(too_large)?;
    let history_snapshot =
      reference_lineage::project_snapshot_in_tx(&mut tx, history_id, doc_id, workspace_id, &history_snapshot).await?;
    if history_snapshot.len() > max_input_bytes {
      return Err(too_large());
    }
    let snapshot = sqlx::query(
      "SELECT last_sequence, CASE WHEN octet_length(payload) <= $3 THEN payload END AS payload
       FROM doc_snapshots WHERE workspace_id=$1 AND doc_id=$2",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(sql_limit)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let (mut parts, last_sequence, mut input_bytes) = if let Some(row) = snapshot {
      let payload = row.get::<Option<Vec<u8>>, _>("payload").ok_or_else(too_large)?;
      let size = payload.len();
      (
        if payload.is_empty() { Vec::new() } else { vec![payload] },
        row.get::<i64, _>("last_sequence"),
        size,
      )
    } else {
      (Vec::new(), -1, 0)
    };
    let mut current_revision = last_sequence.max(0);
    {
      // The byte ceiling also needs a row-work bound for empty/legacy updates.
      let mut tail = sqlx::query(
        "SELECT sequence, CASE WHEN octet_length(payload) <= $4 THEN payload END AS payload
         FROM doc_updates WHERE workspace_id=$1 AND doc_id=$2 AND sequence > $3
         ORDER BY sequence ASC LIMIT 10001",
      )
      .bind(workspace_id)
      .bind(doc_id)
      .bind(last_sequence)
      .bind(sql_limit)
      .fetch(&mut *tx);
      let mut count = 0;
      while let Some(row) = tail.try_next().await.map_err(Self::map_db_err)? {
        count += 1;
        if count > 10_000 {
          return Err(AuthError::InvalidInput(
            "history comparison exceeds its update-tail work limit; compact the document before retrying".into(),
          ));
        }
        let payload = row.get::<Option<Vec<u8>>, _>("payload").ok_or_else(too_large)?;
        input_bytes = input_bytes
          .checked_add(payload.len())
          .filter(|size| *size <= max_input_bytes)
          .ok_or_else(too_large)?;
        current_revision = current_revision.max(row.get("sequence"));
        parts.push(payload);
      }
    }
    let current_snapshot = Self::merge_doc_parts(parts)?;
    if current_snapshot.len() > max_input_bytes {
      return Err(too_large());
    }
    let read_at = sqlx::query_scalar("SELECT transaction_timestamp()")
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(myoxus_application::doc::history::DocHistoryComparisonRead {
      history_id,
      history_snapshot,
      current_snapshot,
      current_revision,
      read_at,
    })
  }
  async fn history_revision(&self, workspace_id: Uuid, doc_id: Uuid) -> AuthResult<i64> {
    sqlx::query_scalar(
      "SELECT GREATEST(
      COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE workspace_id=$1 AND doc_id=$2), 0),
      COALESCE((SELECT last_sequence FROM doc_snapshots WHERE workspace_id=$1 AND doc_id=$2), 0))",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }
  #[instrument(skip(self, request), fields(workspace_id = %request.workspace_id, doc_id = %request.doc_id, history_id = request.history_id))]
  async fn restore_history(
    &self,
    request: myoxus_application::doc::history::HistoryRestoreRequest,
  ) -> Result<
    myoxus_application::doc::history::HistoryRestoreCommit,
    myoxus_application::doc::history::HistoryCaptureError,
  > {
    use crate::document_version::PgDocumentVersionRepository;
    use myoxus_application::doc::history::{HistoryCapture, HistoryRestoreCommit};
    use myoxus_domain::audit::{AuditCategory, AuditEvent, AuditTarget};
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::lock_page_lifecycle_documents(&mut tx, request.workspace_id, request.doc_id).await?;
    let snapshot: Vec<u8> = sqlx::query_scalar(
      "SELECT snapshot FROM doc_histories WHERE id = $1 AND doc_id = $2 AND workspace_id = $3 FOR SHARE",
    )
    .bind(request.history_id)
    .bind(request.doc_id)
    .bind(request.workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(myoxus_application::doc::history::HistoryCaptureError::StaleEntry)?;
    let snapshot = reference_lineage::project_snapshot_in_tx(
      &mut tx,
      request.history_id,
      request.doc_id,
      request.workspace_id,
      &snapshot,
    )
    .await?;
    let source_audit = if let Some((source_id, _)) = &request.named {
      let row = sqlx::query(
        "SELECT label, description, created_by, created_at, is_pinned FROM document_version WHERE id = $1 AND doc_id = $2 AND workspace_id = $3 AND doc_history_id = $4 FOR SHARE",
      ).bind(source_id).bind(request.doc_id).bind(request.workspace_id).bind(request.history_id)
        .fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?
        .ok_or_else(|| AuthError::NotFound("source version".into()))?;
      serde_json::json!({
        "id": source_id, "label": row.get::<String, _>("label"),
        "description": row.get::<Option<String>, _>("description"),
        "createdBy": row.get::<Uuid, _>("created_by"),
        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
        "isPinned": row.get::<bool, _>("is_pinned"),
        "docHistoryId": request.history_id, "docId": request.doc_id, "workspaceId": request.workspace_id,
      })
    } else {
      serde_json::json!({"docHistoryId": request.history_id, "docId": request.doc_id, "workspaceId": request.workspace_id})
    };
    let applied = self
      .mutate_content_in_tx(
        &mut tx,
        request.workspace_id,
        request.doc_id,
        request.actor.user_id,
        ContentChange::Snapshot(&snapshot),
        true,
        request.expected_sequence,
        true,
      )
      .await?;
    let recovery_history_id = applied
      .recovery_history_id
      .ok_or_else(|| AuthError::Storage("restore recovery snapshot missing".into()))?;
    let committed_at = chrono::Utc::now();
    let source_version_id = request.named.as_ref().map(|(id, _)| *id);
    let source_label = source_audit.get("label").and_then(serde_json::Value::as_str);
    let version = if let Some((source_id, capture)) = request.named {
      let provenance = myoxus_application::doc::history::HistoryCaptureProvenance {
        origin: myoxus_application::doc::history::DocHistoryOrigin::from_version_event(capture.event),
        actor_id: Some(capture.actor_id),
      };
      let HistoryCapture::Version(version) = self
        .capture_history_in_tx(&mut tx, request.workspace_id, request.doc_id, provenance, Some(capture))
        .await?
      else {
        return Err(AuthError::Storage("restore version missing".into()).into());
      };
      PgDocumentVersionRepository::create_relation_in_tx(
        &mut tx,
        &myoxus_domain::entities::DocumentVersionRelation {
          id: Uuid::new_v4(),
          from_version_id: version.id,
          to_version_id: source_id,
          relation: "restored_from".into(),
          created_by: request.actor.user_id,
          created_at: committed_at,
          metadata: serde_json::json!({}),
        },
      )
      .await?;
      Some(version)
    } else {
      crate::document_metadata::PgDocumentMetadataRepository::mark_content_restored_in_tx(
        &mut tx,
        request.doc_id,
        request.actor.user_id,
      )
      .await?;
      None
    };
    let event = AuditEvent::mutation(
      if version.is_some() {
        "document_version.restore"
      } else {
        "document.restore"
      },
      if version.is_some() {
        AuditCategory::DocumentVersion
      } else {
        AuditCategory::Document
      },
      Some(match &version {
        Some(version) => AuditTarget::entity("document_version", version.id, Some(version.label.clone())),
        None => AuditTarget::entity("document", request.doc_id, None),
      }),
      request.actor,
      Some(source_audit.clone()),
      Some(
        serde_json::json!({"docId": request.doc_id, "workspaceId": request.workspace_id,
        "sourceHistoryId": request.history_id, "sourceVersionId": source_version_id, "sourceLabel": source_label,
        "versionId": version.as_ref().map(|v| v.id), "sequence": applied.sequence,
        "recoveryHistoryId": recovery_history_id,
        "id": version.as_ref().map(|v| v.id), "label": version.as_ref().map(|v| &v.label),
        "description": version.as_ref().and_then(|v| v.description.as_ref()),
        "createdBy": version.as_ref().map(|v| v.created_by),
        "createdAt": version.as_ref().map(|v| v.created_at.to_rfc3339()),
        "isPinned": version.as_ref().map(|v| v.is_pinned),
        "docHistoryId": version.as_ref().map(|v| v.doc_history_id)}),
      ),
    );
    crate::audit::PgAuditLogStore::record_in_tx(&mut tx, &event)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    let committed = HistoryRestoreCommit {
      sequence: applied.sequence,
      recovery_history_id,
      version,
      committed_at,
    };
    crate::mcp_idempotency::commit_document_write(
      &mut tx,
      myoxus_application::mcp::McpDocumentWriteCommit::HistoryRestore(&committed),
    )
    .await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(committed)
  }
  #[instrument(skip(self, request), fields(workspace_id = %request.workspace_id, doc_id = %request.doc_id, request_key = %request.idempotency.request_key))]
  async fn save_history(
    &self,
    request: myoxus_application::doc::history::HistorySaveRequest,
  ) -> Result<myoxus_application::doc::history::HistorySaveCommit, myoxus_application::doc::history::HistoryCaptureError>
  {
    use crate::document_version::PgDocumentVersionRepository;
    use myoxus_application::doc::history::{HistoryCapture, HistoryCaptureError, HistorySaveCommit};

    if request.provenance.actor_id != Some(request.idempotency.actor_id) {
      return Err(AuthError::InvalidInput("history capture actor mismatch".into()).into());
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(workspace_document_lock_key(request.workspace_id, request.doc_id))
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let existing = sqlx::query(
      "SELECT request_fingerprint, history_id, version_id
       FROM document_history_capture_request
       WHERE actor_id = $1 AND workspace_id = $2 AND doc_id = $3 AND request_key = $4
       FOR UPDATE",
    )
    .bind(request.idempotency.actor_id)
    .bind(request.workspace_id)
    .bind(request.doc_id)
    .bind(request.idempotency.request_key)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if let Some(row) = existing {
      if row.get::<Vec<u8>, _>("request_fingerprint") != request.idempotency.fingerprint {
        return Err(HistoryCaptureError::IdempotencyConflict);
      }
      let history_id = row.get::<i64, _>("history_id");
      let capture = if let Some(version_id) = row.get::<Option<Uuid>, _>("version_id") {
        let version = PgDocumentVersionRepository::get_in_tx(&mut tx, version_id)
          .await?
          .ok_or(HistoryCaptureError::StaleEntry)?;
        HistoryCapture::Version(version)
      } else {
        HistoryCapture::Snapshot(history_id)
      };
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(HistorySaveCommit {
        capture,
        replayed: true,
      });
    }

    let capture = self
      .capture_history_in_tx(
        &mut tx,
        request.workspace_id,
        request.doc_id,
        request.provenance,
        request.named,
      )
      .await?;
    let (history_id, version_id) = match &capture {
      HistoryCapture::Snapshot(history_id) => (*history_id, None),
      HistoryCapture::Version(version) => (version.doc_history_id, Some(version.id)),
      HistoryCapture::Unchanged => {
        return Err(AuthError::Storage("explicit history save unexpectedly skipped".into()).into());
      }
    };
    sqlx::query(
      "INSERT INTO document_history_capture_request
         (actor_id, workspace_id, doc_id, request_key, request_fingerprint, history_id, version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(request.idempotency.actor_id)
    .bind(request.workspace_id)
    .bind(request.doc_id)
    .bind(request.idempotency.request_key)
    .bind(&request.idempotency.fingerprint)
    .bind(history_id)
    .bind(version_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(HistorySaveCommit {
      capture,
      replayed: false,
    })
  }

  #[instrument(skip(self, request), fields(workspace_id = %request.workspace_id, doc_id = %request.doc_id, history_id = request.history_id))]
  async fn name_history(
    &self,
    request: myoxus_application::doc::history::HistoryNameRequest,
  ) -> Result<myoxus_application::doc::history::HistoryNameCommit, myoxus_application::doc::history::HistoryCaptureError>
  {
    use crate::document_version::PgDocumentVersionRepository;
    use myoxus_application::doc::history::{HistoryCaptureError, HistoryNameCommit};
    use myoxus_domain::entities::{DocumentVersion, DocumentVersionCreateInput};

    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(workspace_document_lock_key(request.workspace_id, request.doc_id))
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query_scalar::<_, i32>(
      "SELECT 1 FROM docs WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(request.doc_id)
    .bind(request.workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::NotFound("document".into()))?;
    let snapshot: Vec<u8> = sqlx::query_scalar(
      "SELECT snapshot FROM doc_histories
       WHERE id = $1 AND workspace_id = $2 AND doc_id = $3 FOR UPDATE",
    )
    .bind(request.history_id)
    .bind(request.workspace_id)
    .bind(request.doc_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(HistoryCaptureError::StaleEntry)?;

    let mut current_ids: Vec<Uuid> = sqlx::query_scalar(
      "SELECT id FROM document_version WHERE workspace_id = $1 AND doc_id = $2 AND doc_history_id = $3
       ORDER BY id FOR UPDATE",
    )
    .bind(request.workspace_id)
    .bind(request.doc_id)
    .bind(request.history_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    current_ids.sort_unstable();
    let counter = match &request.named.label.counter_key {
      Some(key) => Some(PgDocumentVersionRepository::next_counter_in_tx(&mut tx, request.doc_id, key).await?),
      None => None,
    };
    let label = request.named.label.render(counter)?;
    let matching_id: Option<Uuid> = sqlx::query_scalar(
      "SELECT id FROM document_version
       WHERE workspace_id = $1 AND doc_id = $2 AND doc_history_id = $3
         AND label = $4 AND description IS NOT DISTINCT FROM $5
         AND created_by = $6 AND event = $7 AND kind = $8
       ORDER BY created_at, id LIMIT 1",
    )
    .bind(request.workspace_id)
    .bind(request.doc_id)
    .bind(request.history_id)
    .bind(&label.label)
    .bind(&request.named.description)
    .bind(request.named.actor_id)
    .bind(request.named.event.as_str())
    .bind(request.named.kind.as_str())
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if let Some(version_id) = matching_id {
      let version = PgDocumentVersionRepository::get_in_tx(&mut tx, version_id)
        .await?
        .ok_or(HistoryCaptureError::StaleEntry)?;
      tx.commit().await.map_err(Self::map_db_err)?;
      return Ok(HistoryNameCommit {
        version,
        replayed: true,
      });
    }
    let mut expected_ids = request.expected_version_ids;
    expected_ids.sort_unstable();
    expected_ids.dedup();
    if expected_ids != current_ids {
      return Err(HistoryCaptureError::ReferenceConflict);
    }

    let named_at = chrono::Utc::now();
    let mut version = DocumentVersion::new_for_create(DocumentVersionCreateInput {
      id: Uuid::new_v4(),
      doc_id: request.doc_id,
      workspace_id: request.workspace_id,
      doc_history_id: request.history_id,
      label: label.label,
      description: request.named.description,
      event: request.named.event,
      kind: request.named.kind,
      created_by: request.named.actor_id,
      created_at: named_at,
      is_pinned: false,
      is_protected: false,
      policy_id: label.policy_id,
      policy_snapshot: serde_json::json!({}),
      content_hash: Some(hex::encode(Sha256::digest(&snapshot))),
      metadata: serde_json::json!({}),
    });
    if label.counter_key.as_deref() == Some("seq") {
      version.version_no = label.counter_value;
    }
    let version = PgDocumentVersionRepository::create_in_tx(&mut tx, &version).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(HistoryNameCommit {
      version,
      replayed: false,
    })
  }

  #[instrument(skip(self, named), fields(%workspace_id, %doc_id, named = named.is_some()))]
  async fn capture_history(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    provenance: myoxus_application::doc::history::HistoryCaptureProvenance,
    named: Option<myoxus_application::doc::history::NamedHistoryCapture>,
  ) -> Result<myoxus_application::doc::history::HistoryCapture, myoxus_application::doc::history::HistoryCaptureError>
  {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let result = self
      .capture_history_in_tx(&mut tx, workspace_id, doc_id, provenance, named)
      .await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(result)
  }

  async fn list_history_before(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    before: Option<chrono::DateTime<chrono::Utc>>,
    before_id: Option<i64>,
    take: i64,
  ) -> AuthResult<Vec<DocHistoryMetadataEntry>> {
    self
      .list_history_before_filtered(workspace_id, doc_id, before, before_id, take, false)
      .await
  }

  async fn list_history_before_filtered(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    before: Option<chrono::DateTime<chrono::Utc>>,
    before_id: Option<i64>,
    take: i64,
    named_only: bool,
  ) -> AuthResult<Vec<DocHistoryMetadataEntry>> {
    let mut tx = self.begin_history_metadata_read(workspace_id, doc_id).await?;
    let rows = sqlx::query(
      "SELECT h.id, h.doc_id, h.workspace_id, h.created_at,
              h.origin, h.actor_id, u.name AS actor_name, u.avatar_key AS actor_avatar_key
       FROM doc_histories h
       JOIN docs d ON d.id=h.doc_id AND d.workspace_id=h.workspace_id
       LEFT JOIN users u ON u.id=h.actor_id
       WHERE h.doc_id=$1 AND h.workspace_id=$2
         AND (NOT $6::boolean OR EXISTS (
           SELECT 1 FROM document_version v
           WHERE v.doc_id=h.doc_id AND v.workspace_id=h.workspace_id AND v.doc_history_id=h.id
         ))
         AND ($3::timestamptz IS NULL OR h.created_at<$3
           OR (h.created_at=$3 AND $4::bigint IS NOT NULL AND h.id<$4))
       ORDER BY h.created_at DESC,h.id DESC LIMIT $5",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(before)
    .bind(before_id)
    .bind(take)
    .bind(named_only)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let entries = rows.iter().map(map_history_metadata).collect::<AuthResult<Vec<_>>>()?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(entries)
  }
  /// Store a history snapshot for rollback purposes.  Returns the new history
  /// entry ID.
  #[instrument(skip(self, snapshot))]
  async fn create_history_entry(&self, doc_id: Uuid, workspace_id: Uuid, snapshot: Vec<u8>) -> AuthResult<i64> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let row = sqlx::query(
      r#"
            INSERT INTO doc_histories (doc_id, workspace_id, snapshot, reference_workspace_id)
            VALUES ($1, $2, $3, $2)
            RETURNING id
            "#,
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(snapshot)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let history_id = row.get("id");
    crate::history_git_sync::record_history_capture(&mut tx, workspace_id, history_id)
      .await
      .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(history_id)
  }

  /// Metadata-only offset pagination for trusted server consumers.
  #[instrument(skip(self))]
  async fn list_history(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    skip: i64,
    take: i64,
  ) -> AuthResult<Vec<DocHistoryMetadataEntry>> {
    let mut tx = self.begin_history_metadata_read(workspace_id, doc_id).await?;
    let rows = sqlx::query(
      "SELECT h.id,h.doc_id,h.workspace_id,h.created_at,h.origin,h.actor_id,
              u.name AS actor_name,u.avatar_key AS actor_avatar_key
       FROM doc_histories h
       JOIN docs d ON d.id=h.doc_id AND d.workspace_id=h.workspace_id
       LEFT JOIN users u ON u.id=h.actor_id
       WHERE h.doc_id=$1 AND h.workspace_id=$2
       ORDER BY h.created_at DESC,h.id DESC LIMIT $3 OFFSET $4",
    )
    .bind(doc_id)
    .bind(workspace_id)
    .bind(take)
    .bind(skip)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let entries = rows.iter().map(map_history_metadata).collect::<AuthResult<Vec<_>>>()?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(entries)
  }

  #[instrument(skip(self))]
  async fn get_history_metadata(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    history_id: i64,
  ) -> AuthResult<Option<DocHistoryMetadataEntry>> {
    let mut tx = self.begin_history_metadata_read(workspace_id, doc_id).await?;
    let row = sqlx::query(
      "SELECT h.id,h.doc_id,h.workspace_id,h.created_at,h.origin,h.actor_id,
              u.name AS actor_name,u.avatar_key AS actor_avatar_key
       FROM doc_histories h
       JOIN docs d ON d.id=h.doc_id AND d.workspace_id=h.workspace_id
       LEFT JOIN users u ON u.id=h.actor_id
       WHERE h.id=$1 AND h.doc_id=$2 AND h.workspace_id=$3",
    )
    .bind(history_id)
    .bind(doc_id)
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let entry = row.as_ref().map(map_history_metadata).transpose()?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(entry)
  }

  /// Fetch a single history entry (including its binary snapshot) by ID.
  #[instrument(skip(self))]
  async fn get_history_entry(&self, history_id: i64) -> AuthResult<Option<DocHistoryEntry>> {
    let row = sqlx::query(
      r#"
            SELECT h.id, h.doc_id, h.workspace_id, h.snapshot, h.created_at,
                   h.origin, h.actor_id, u.name AS actor_name, u.avatar_key AS actor_avatar_key
            FROM doc_histories h
            LEFT JOIN users u ON u.id = h.actor_id
            WHERE h.id = $1
            "#,
    )
    .bind(history_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    match row {
      Some(row) => Ok(self.project_history_rows(vec![row]).await?.pop()),
      None => Ok(None),
    }
  }

  #[instrument(skip(self))]
  async fn find_history_at_or_before(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    timestamp: chrono::DateTime<chrono::Utc>,
  ) -> AuthResult<Option<DocHistoryEntry>> {
    let row = sqlx::query(
      r#"SELECT h.id, h.doc_id, h.workspace_id, h.snapshot, h.created_at,
                h.origin, h.actor_id, u.name AS actor_name, u.avatar_key AS actor_avatar_key
         FROM doc_histories h
         LEFT JOIN users u ON u.id = h.actor_id
         WHERE h.workspace_id = $1 AND h.doc_id = $2 AND h.created_at <= $3
         ORDER BY h.created_at DESC, h.id DESC
         LIMIT 1"#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(timestamp)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    match row {
      Some(row) => Ok(self.project_history_rows(vec![row]).await?.pop()),
      None => Ok(None),
    }
  }

  #[instrument(skip(self))]
  async fn delete_history_entry(&self, history_id: i64) -> AuthResult<bool> {
    let result = sqlx::query("DELETE FROM doc_histories WHERE id = $1")
      .bind(history_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(result.rows_affected() > 0)
  }
}

#[async_trait]
impl DocViewStore for SqlxDocStore {
  async fn analytics_window(&self) -> AuthResult<Option<myoxus_application::doc::traits::DocViewAnalyticsWindow>> {
    // CURRENT_DATE and this connection's timezone also own the daily UPSERT.
    // End is inclusive for bucket reads; to is the exclusive end instant.
    let row = sqlx::query(
      "SELECT CURRENT_DATE - 28 AS start, CURRENT_DATE - 1 AS end, \
       (CURRENT_DATE - 28)::timestamp AT TIME ZONE current_setting('TimeZone') AS from_time, \
       CURRENT_DATE::timestamp AT TIME ZONE current_setting('TimeZone') AS to_time",
    )
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(Some(myoxus_application::doc::traits::DocViewAnalyticsWindow {
      start: row.get("start"),
      end: row.get("end"),
      from: row.get("from_time"),
      to: row.get("to_time"),
    }))
  }
  /// Zählt einen Seitenaufruf in der täglichen Aggregationstabelle.
  ///
  /// UPSERT auf `(workspace_id, doc_id, date)` — ein Eintrag pro Doc pro Tag.
  /// is_unique/is_guest werden als 0/1-Integer übergeben damit PostgreSQL sie
  /// direkt als Inkrement addieren kann (vermeidet CASE-Ausdrücke im SQL).
  #[instrument(skip(self))]
  async fn record_doc_view(&self, workspace_id: Uuid, doc_id: &str, is_unique: bool, is_guest: bool) -> AuthResult<()> {
    // Booleans → i64 für direktes Addieren im UPSERT-Inkrement.
    let unique_inc: i64 = if is_unique { 1 } else { 0 };
    let guest_inc: i64 = if is_guest { 1 } else { 0 };

    // UPSERT auf (workspace_id, doc_id, date): CURRENT_DATE partitioniert die
    // Aggregation täglich. total_views immer +1; unique_views/guest_views nur +1
    // wenn is_unique/is_guest gesetzt.
    sqlx::query(
      r#"
      INSERT INTO workspace_doc_view_daily
             (workspace_id, doc_id, date, total_views, unique_views, guest_views, last_accessed_at)
      VALUES ($1, $2, CURRENT_DATE, 1, $3, $4, now())
      ON CONFLICT (workspace_id, doc_id, date) DO UPDATE SET
        total_views    = workspace_doc_view_daily.total_views + 1,
        unique_views   = workspace_doc_view_daily.unique_views + $3,
        guest_views    = workspace_doc_view_daily.guest_views + $4,
        last_accessed_at = now(),
        updated_at     = now()
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(unique_inc)
    .bind(guest_inc)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Aktualisiert den letzten Zugriffszeitpunkt eines Workspace-Mitglieds.
  ///
  /// UPSERT auf `(workspace_id, user_id)` — ein Eintrag pro User pro Workspace.
  /// Bei Konflikt werden last_doc_id und last_accessed_at immer mit den neuen
  /// Werten überschrieben (letzter Zugriff gewinnt).
  #[instrument(skip(self))]
  async fn upsert_member_last_access(&self, workspace_id: Uuid, user_id: Uuid, doc_id: &str) -> AuthResult<()> {
    // UPSERT auf (workspace_id, user_id): speichert welches Doc der User zuletzt
    // aufgerufen hat. Wird für "zuletzt besucht"-Anzeigen im Frontend verwendet.
    sqlx::query(
      r#"
      INSERT INTO workspace_member_last_access
             (workspace_id, user_id, last_doc_id, last_accessed_at, updated_at)
      VALUES ($1, $2, $3, now(), now())
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET
        last_doc_id      = $3,
        last_accessed_at = now(),
        updated_at       = now()
      "#,
    )
    .bind(workspace_id)
    .bind(user_id)
    .bind(doc_id)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }

  #[instrument(skip(self))]
  async fn list_member_last_access(
    &self,
    workspace_id: Uuid,
    doc_id: &str,
    query: Option<&str>,
    limit: i64,
    offset: i64,
  ) -> AuthResult<Vec<myoxus_application::doc::DocMemberLastAccess>> {
    let pattern = query
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .map(|value| format!("%{value}%"));
    let rows = sqlx::query(
      r#"SELECT mla.user_id, u.name, u.avatar_key, u.email,
                mla.last_accessed_at, mla.last_doc_id
         FROM workspace_member_last_access mla
         JOIN users u ON u.id = mla.user_id
         JOIN workspace_memberships wm
           ON wm.workspace_id = mla.workspace_id
          AND wm.user_id = mla.user_id
          AND wm.status = 'Accepted'
         JOIN workspaces w
           ON w.id = mla.workspace_id
          AND w.lifecycle_state = 'active'
          AND w.deleted_at IS NULL
         WHERE mla.workspace_id = $1
           AND mla.last_doc_id = $2
           AND ($3::text IS NULL OR u.name ILIKE $3 OR u.email ILIKE $3)
         ORDER BY mla.last_accessed_at DESC
         LIMIT $4 OFFSET $5"#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(pattern)
    .bind(limit)
    .bind(offset)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| myoxus_application::doc::DocMemberLastAccess {
          user_id: row.get("user_id"),
          name: row.get("name"),
          email: row.get("email"),
          avatar_key: row.get("avatar_key"),
          last_accessed_at: row.get("last_accessed_at"),
          last_doc_id: row.get("last_doc_id"),
        })
        .collect(),
    )
  }

  #[instrument(skip(self))]
  async fn count_member_last_access(&self, workspace_id: Uuid, doc_id: &str) -> AuthResult<i64> {
    sqlx::query_scalar(
      "SELECT COUNT(*)::bigint FROM workspace_member_last_access WHERE workspace_id = $1 AND last_doc_id = $2",
    )
    .bind(workspace_id)
    .bind(doc_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }

  #[instrument(skip(self))]
  async fn list_doc_view_daily(
    &self,
    workspace_id: Uuid,
    doc_id: &str,
    start: chrono::NaiveDate,
    end: chrono::NaiveDate,
  ) -> AuthResult<Vec<myoxus_application::doc::DocViewDaily>> {
    let rows = sqlx::query(
      r#"WITH days AS (
           SELECT generate_series($3::date, $4::date, interval '1 day')::date AS day
         )
         SELECT days.day AS date,
                COALESCE(v.total_views, 0) AS total_views,
                COALESCE(v.unique_views, 0) AS unique_views,
                COALESCE(v.guest_views, 0) AS guest_views
         FROM days
         LEFT JOIN workspace_doc_view_daily v
           ON v.workspace_id = $1 AND v.doc_id = $2 AND v.date = days.day
         ORDER BY date ASC"#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(start)
    .bind(end)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| myoxus_application::doc::DocViewDaily {
          date: row.get("date"),
          total_views: row.get("total_views"),
          unique_views: row.get("unique_views"),
          guest_views: row.get("guest_views"),
        })
        .collect(),
    )
  }
}

/// Blanket impl — all methods live in the six sub-trait impl blocks above.
impl DocStore for SqlxDocStore {}

impl SqlxDocStore {
  #[instrument(skip_all)]
  async fn commit_lifecycle_with_project_ack(
    &self,
    command: PageLifecycleCommand,
    ack: Option<myoxus_application::workspace::ProjectDocumentAck>,
  ) -> AuthResult<PageLifecycleCommit> {
    match self.commit_lifecycle_with_native_ack(command, ack, None, None).await? {
      myoxus_application::doc::AutomationPageLifecycleResult::Committed(commit) => Ok(commit),
      myoxus_application::doc::AutomationPageLifecycleResult::Replay(_) => {
        Err(AuthError::Storage("unexpected automation lifecycle replay".into()))
      }
    }
  }

  #[instrument(skip_all)]
  async fn commit_lifecycle_with_native_ack(
    &self,
    command: PageLifecycleCommand,
    ack: Option<myoxus_application::workspace::ProjectDocumentAck>,
    automation: Option<myoxus_domain::workspace_automation::AutomationEffectFence>,
    row_content: Option<myoxus_application::doc::AutomationRowContentTarget>,
  ) -> AuthResult<myoxus_application::doc::AutomationPageLifecycleResult> {
    let kind = command.kind();
    let (workspace_id, doc_id, actor_user_id, committed_at) = match &command {
      PageLifecycleCommand::Create {
        workspace_id,
        doc_id,
        actor_user_id,
        committed_at,
        ..
      }
      | PageLifecycleCommand::Rename {
        workspace_id,
        doc_id,
        actor_user_id,
        committed_at,
        ..
      }
      | PageLifecycleCommand::SetTrash {
        workspace_id,
        doc_id,
        actor_user_id,
        committed_at,
        ..
      } => (*workspace_id, *doc_id, *actor_user_id, *committed_at),
    };
    if doc_id == workspace_id {
      return Err(AuthError::InvalidInput(
        "workspace root is not a normal page lifecycle target".to_string(),
      ));
    }

    if row_content.is_some() && automation.is_none() {
      return Err(AuthError::InvalidInput("Task content requires a native effect".into()));
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    if row_content.is_some() {
      // The native Row writer checks transaction-local admission even when its
      // caller owns the document/association/ACK transaction.
      let catalog = self
        .database_templates
        .as_ref()
        .ok_or_else(|| AuthError::Storage("Task content database catalog unavailable".into()))?;
      crate::workspace_database::PgDatabaseRepository::capture_catalog_admission(&mut tx, catalog)
        .await
        .map_err(|error| AuthError::Storage(error.to_string()))?;
    }
    if let Some(fence) = &automation {
      if ack.is_some() || kind != myoxus_application::doc::PageLifecycleKind::Create {
        return Err(AuthError::InvalidInput("invalid automation page lifecycle".into()));
      }
      let prior = crate::workflow_runtime::lock_runtime_effect(&mut *tx, fence)
        .await
        .map_err(|error| AuthError::Storage(error.to_string()))?;
      let accepted: serde_json::Value =
        sqlx::query_scalar("SELECT accepted_json FROM workspace_automation_runs WHERE id=$1")
          .bind(fence.run_id)
          .fetch_one(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
      let accepted: myoxus_domain::workspace_automation::AcceptedAutomationRun = serde_json::from_value(accepted)
        .map_err(|_| AuthError::Storage("invalid accepted automation identity".into()))?;
      let effect =
        sqlx::query("SELECT reserved_id,position FROM workspace_automation_actions WHERE id=$1 AND run_id=$2")
          .bind(fence.action_id)
          .bind(fence.run_id)
          .fetch_one(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
      let reserved: Uuid = effect.try_get("reserved_id").map_err(Self::map_db_err)?;
      let position: i32 = effect.try_get("position").map_err(Self::map_db_err)?;
      let native_document_action = accepted.definition.actions.iter().any(|action| {
        action.position == position
          && matches!(
            &action.config,
            myoxus_domain::workspace_automation::WorkspaceAutomationActionConfig::CreateLinkedDocument {
              relation_field_id: None,
              ..
            }
          )
      });
      if accepted.actor_id != Some(actor_user_id)
        || accepted.workspace_id != workspace_id
        || reserved != doc_id
        || !native_document_action
      {
        return Err(AuthError::InvalidInput("automation page identity mismatch".into()));
      }
      if let Some(target) = &row_content {
        let trigger = accepted
          .trigger
          .as_ref()
          .ok_or_else(|| AuthError::InvalidInput("Task source unavailable".into()))?;
        let source_action = accepted
          .definition
          .actions
          .iter()
          .find(|action| action.position == position);
        if trigger.database_id != target.database_id
          || trigger.row_id != target.row_id
          || !matches!(
            source_action.map(|a| &a.config),
            Some(
              myoxus_domain::workspace_automation::WorkspaceAutomationActionConfig::CreateLinkedDocument {
                source: Some(_),
                relation_field_id: None,
                ..
              }
            )
          )
        {
          return Err(AuthError::InvalidInput("Task content identity changed".into()));
        }
      }
      if let Some(prior) = prior {
        if prior.get("doc_id").and_then(serde_json::Value::as_str) != Some(doc_id.to_string().as_str()) {
          return Err(AuthError::Storage("automation page acknowledgement mismatch".into()));
        }
        let row = sqlx::query("SELECT * FROM docs WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND NOT blocked AND NOT is_workspace_root FOR SHARE")
          .bind(doc_id).bind(workspace_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?
          .ok_or_else(|| AuthError::InvalidInput("automation document unavailable".into()))?;
        let document = self.map_doc_row(row);
        if let Some(target) = &row_content {
          let attached: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_database_rows WHERE id=$1 AND database_id=$2 AND doc_id=$3 AND deleted_at IS NULL)")
            .bind(target.row_id).bind(target.database_id).bind(doc_id).fetch_one(&mut *tx).await.map_err(Self::map_db_err)?;
          if !attached {
            return Err(AuthError::InvalidInput("Task content association changed".into()));
          }
        }
        tx.commit().await.map_err(Self::map_db_err)?;
        return Ok(myoxus_application::doc::AutomationPageLifecycleResult::Replay(document));
      }
    }

    if let Some(ack) = &ack {
      let contextual = ack.operation == myoxus_application::workspace::StarterOperation::PrepareDocuments
        || matches!(
          ack.admission,
          myoxus_application::workspace::StarterDocumentAdmission::WorkspaceSetup
        );
      if contextual != ack.automation_effect.is_some() {
        return Err(AuthError::InvalidInput(
          "context document requires its native execution fence".into(),
        ));
      }
      if ack.actor_id != actor_user_id
        || ack.workspace_id != workspace_id
        || kind != myoxus_application::doc::PageLifecycleKind::Create
      {
        return Err(AuthError::InvalidInput("invalid document component identity".into()));
      }
    }
    if let Some((ack, fence)) = ack
      .as_ref()
      .and_then(|ack| ack.automation_effect.as_ref().map(|fence| (ack, fence)))
    {
      let stage = if matches!(
        ack.admission,
        myoxus_application::workspace::StarterDocumentAdmission::WorkspaceSetup
      ) {
        myoxus_domain::workspace_automation::ContextDocumentWorkflowStage::CreateWorkingDocument {
          component: ack.component_id.clone(),
        }
      } else {
        myoxus_domain::workspace_automation::ContextDocumentWorkflowStage::CreateDocument {
          component: ack.component_id.clone(),
        }
      };
      if crate::workflow_runtime::effects::lock_context_receipt_effect(
        &mut tx,
        fence,
        &stage,
        ack.actor_id,
        ack.workspace_id,
        ack.request_id,
        &ack.fingerprint,
        Some(doc_id),
      )
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?
      .is_some()
      {
        let row=sqlx::query("SELECT * FROM docs WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND NOT blocked AND NOT is_workspace_root FOR SHARE")
          .bind(doc_id).bind(workspace_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?
          .ok_or_else(||AuthError::NotFound("context document".into()))?;
        let document = self.map_doc_row(row);
        tx.commit().await.map_err(Self::map_db_err)?;
        return Ok(myoxus_application::doc::AutomationPageLifecycleResult::Replay(document));
      }
    }
    let mut project = if let Some(ack) = &ack {
      use myoxus_application::workspace::*;
      if ack.actor_id != actor_user_id
        || ack.workspace_id != workspace_id
        || kind != myoxus_application::doc::PageLifecycleKind::Create
      {
        return Err(AuthError::InvalidInput(
          "invalid Project component acknowledgement".into(),
        ));
      }
      crate::workspace::SqlxWorkspaceStore::project_authority(
        &mut tx,
        actor_user_id,
        workspace_id,
        myoxus_domain::permission::WorkspaceAction::CreateDoc,
      )
      .await?;
      if ack.automation_effect.is_none() {
        crate::workspace::SqlxWorkspaceStore::project_request_lock(
          &mut tx,
          actor_user_id,
          ack.operation,
          ack.request_id,
        )
        .await?;
      }
      let receipt = crate::workspace::SqlxWorkspaceStore::document_receipt(
        &mut tx,
        actor_user_id,
        ack.operation,
        workspace_id,
        ack.request_id,
        Some(&ack.fingerprint),
      )
      .await
      .map_err(|error| match error {
        myoxus_application::workspace::ProjectStarterError::Auth(error) => error,
        _ => AuthError::InvalidInput("accepted Project request changed".into()),
      })?
      .ok_or_else(|| AuthError::InvalidInput("accepted Project request unavailable".into()))?;
      if receipt.state != ProjectStarterState::Accepted
        || (matches!(&receipt.origin, StarterDocumentOrigin::Project { .. }) && !receipt.progress.project_created)
        || !receipt.progress.folder_ready
        || receipt.progress.documents.contains_key(&ack.component_id)
        || !receipt
          .ids
          .iter()
          .any(|component| component.component_id == ack.component_id && component.doc_id == doc_id)
      {
        return Err(AuthError::InvalidInput("Project component frontier changed".into()));
      }
      crate::workspace::SqlxWorkspaceStore::document_admission_fence(&mut tx, &receipt, &ack.admission).await?;
      crate::workspace::SqlxWorkspaceStore::document_people(&mut tx, &receipt).await?;
      let mut source_plan = receipt.clone();
      source_plan
        .documents
        .retain(|document| document.source.component_id == ack.component_id);
      crate::workspace::SqlxWorkspaceStore::lock_document_sources(&mut tx, &source_plan).await?;
      Some(receipt)
    } else {
      None
    };
    if let Some(target) = &row_content {
      let row = sqlx::query("SELECT edit_revision,doc_id FROM workspace_database_rows WHERE id=$1 AND database_id=$2 AND row_kind='task' AND deleted_at IS NULL FOR UPDATE")
        .bind(target.row_id).bind(target.database_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?
        .ok_or_else(||AuthError::InvalidInput("Task content target unavailable".into()))?;
      if row.try_get::<i64, _>("edit_revision").map_err(Self::map_db_err)? != target.expected_edit_revision
        || row
          .try_get::<Option<Uuid>, _>("doc_id")
          .map_err(Self::map_db_err)?
          .is_some()
      {
        return Err(AuthError::InvalidInput("Task content target changed".into()));
      }
    }
    crate::mcp_idempotency::lock_document_write(&mut tx, Some(actor_user_id)).await?;
    if let Some(receipt) = &project {
      // Folder readiness is an ACK, not permission to use a later deleted
      // destination. Lock its native Organizer together with root/leaf IDs.
      let organizer_id: Uuid =
        sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND external_id=$2 AND deleted_at IS NULL")
          .bind(workspace_id)
          .bind(format!("db${workspace_id}$folders"))
          .fetch_optional(&mut *tx)
          .await
          .map_err(Self::map_db_err)?
          .ok_or_else(|| AuthError::NotFound("Project destination".into()))?;
      Self::lock_page_lifecycle_document_set(&mut tx, workspace_id, &[workspace_id, doc_id, organizer_id]).await?;
      let payload = Self::load_full_doc_in_tx(&mut tx, workspace_id, organizer_id).await?;
      myoxus_application::organizer::verify_document_starter_destination(&payload, receipt)
        .map_err(|_| AuthError::InvalidInput("Project destination unavailable".into()))?;
    } else {
      Self::lock_page_lifecycle_documents(&mut tx, workspace_id, doc_id).await?;
    }
    let root_exists: bool = sqlx::query_scalar(
      "SELECT EXISTS(
         SELECT 1 FROM docs
         WHERE id = $1 AND workspace_id = $1 AND is_workspace_root AND deleted_at IS NULL
       )",
    )
    .bind(workspace_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if !root_exists {
      return Err(AuthError::NotFound("workspace root document".to_string()));
    }
    let root_state = Self::load_full_doc_in_tx(&mut tx, workspace_id, workspace_id).await?;

    let (document, leaf, workspace_root) = match command {
      PageLifecycleCommand::Create {
        title: _,
        initial_leaf_update,
        ..
      } => {
        let derived_title = Self::extract_leaf_title(&initial_leaf_update)?
          .ok_or_else(|| AuthError::Storage("created page leaf has no unambiguous structural title".to_string()))?;
        let row = sqlx::query(
          r#"
          WITH requested_language AS (
            SELECT COALESCE(
              NULLIF(values->>'defaultDocumentLanguage', ''),
              NULLIF(values->>'locale', '')
            ) AS key
            FROM user_preferences
            WHERE user_id = $4
              AND NOT EXISTS (
                SELECT 1 FROM document_workspace_settings settings
                WHERE settings.workspace_id = $2
                  AND settings.default_language_id IS NOT NULL
                  AND settings.updated_by IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM organization_document_settings settings
                WHERE settings.organization_id = document_metadata_effective_organization_id($2)
                  AND settings.default_language_id IS NOT NULL
                  AND settings.updated_by IS NOT NULL
              )
          ), preferred_language AS (
            SELECT language.id
            FROM requested_language requested
            JOIN language_definition language
              ON language.is_active
             AND (
               lower(language.key) = lower(requested.key)
               OR lower(language.key) = lower(split_part(requested.key, '-', 1))
             )
            ORDER BY (lower(language.key) = lower(requested.key)) DESC,
                     language.sort_order,
                     language.key
            LIMIT 1
          )
          INSERT INTO docs (
            id, external_id, workspace_id, title, is_workspace_root,
            created_by, updated_by, language_id, created_at, updated_at
          )
          VALUES ($1, $1::text, $2, $3, false, $4, $4,
                  (SELECT id FROM preferred_language), $5, $5)
          RETURNING id, external_id, workspace_id, userspace_owner_id, title,
                    meta, blocked, is_workspace_root, public_mode, default_role,
                    created_by, updated_by, created_at, updated_at, deleted_at
          "#,
        )
        .bind(doc_id)
        .bind(workspace_id)
        .bind(&derived_title)
        .bind(actor_user_id)
        .bind(committed_at)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        let external_id: String = row.get("external_id");
        let leaf = Self::append_lifecycle_delta(&mut tx, workspace_id, doc_id, initial_leaf_update).await?;
        let root = Self::register_created_page_in_tx(
          &mut tx,
          workspace_id,
          doc_id,
          &external_id,
          &derived_title,
          committed_at,
          &root_state,
        )
        .await?;
        (self.map_doc_row(row), Some(leaf), root)
      }
      PageLifecycleCommand::Rename {
        title,
        expected_sequence,
        ..
      } => {
        let previous = sqlx::query(
          "SELECT external_id, title
           FROM docs
           WHERE workspace_id = $1 AND id = $2 AND NOT is_workspace_root AND deleted_at IS NULL
           FOR UPDATE",
        )
        .bind(workspace_id)
        .bind(doc_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?
        .ok_or_else(|| AuthError::NotFound("document".to_string()))?;
        let external_id: String = previous.get("external_id");
        let previous_title: String = previous.get("title");
        Self::check_content_revision_in_tx(&mut tx, workspace_id, doc_id, expected_sequence).await?;
        let leaf_state = Self::load_full_doc_in_tx(&mut tx, workspace_id, doc_id).await?;
        let leaf_delta = yjs::update_document_title(&leaf_state, &title).map_err(AuthError::Storage)?;
        let projected_leaf = yjs::merge_updates(vec![leaf_state, leaf_delta.clone()])
          .map_err(|_| AuthError::Storage("renamed page leaf state is invalid".to_string()))?;
        let derived_title = Self::extract_leaf_title(&projected_leaf)?
          .ok_or_else(|| AuthError::Storage("renamed page leaf has no unambiguous structural title".to_string()))?;
        let root_delta =
          Self::update_root_page_delta(&root_state, &external_id, Some(&derived_title), None, committed_at)?;
        let leaf = Self::append_lifecycle_delta(&mut tx, workspace_id, doc_id, leaf_delta).await?;
        let root = Self::append_lifecycle_delta(&mut tx, workspace_id, workspace_id, root_delta).await?;
        let row = sqlx::query(
          "UPDATE docs SET title = $3, updated_by = $4, updated_at = $5
           WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
           RETURNING id, external_id, workspace_id, userspace_owner_id, title,
                     meta, blocked, is_workspace_root, public_mode, default_role,
                     created_by, updated_by, created_at, updated_at, deleted_at",
        )
        .bind(workspace_id)
        .bind(doc_id)
        .bind(&derived_title)
        .bind(actor_user_id)
        .bind(committed_at)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        // Count the leaf once; its companion root projection is technical state.
        if previous_title != derived_title
          && Self::normal_document_eligible_in_tx(&mut tx, workspace_id, doc_id).await?
        {
          crate::notification::document_change::accumulate_in_tx(
            &mut tx,
            workspace_id,
            doc_id,
            actor_user_id,
            leaf.sequence,
            committed_at,
          )
          .await?;
        }
        (self.map_doc_row(row), Some(leaf), root)
      }
      PageLifecycleCommand::SetTrash { is_trashed, .. } => {
        let external_id = sqlx::query_scalar::<_, String>(
          "SELECT external_id
           FROM docs
           WHERE workspace_id = $1 AND id = $2 AND NOT is_workspace_root
           FOR UPDATE",
        )
        .bind(workspace_id)
        .bind(doc_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?
        .ok_or_else(|| AuthError::NotFound("document".to_string()))?;
        if is_trashed {
          crate::template_registry::reject_managed_source_write(&mut tx, workspace_id, doc_id).await?;
        }
        let root_delta = Self::update_root_page_delta(&root_state, &external_id, None, Some(is_trashed), committed_at)?;
        let root = Self::append_lifecycle_delta(&mut tx, workspace_id, workspace_id, root_delta).await?;
        let row = sqlx::query(
          "UPDATE docs
           SET deleted_at = CASE WHEN $3 THEN $5 ELSE NULL END,
               updated_by = $4,
               updated_at = $5
           WHERE workspace_id = $1 AND id = $2
           RETURNING id, external_id, workspace_id, userspace_owner_id, title,
                     meta, blocked, is_workspace_root, public_mode, default_role,
                     created_by, updated_by, created_at, updated_at, deleted_at",
        )
        .bind(workspace_id)
        .bind(doc_id)
        .bind(is_trashed)
        .bind(actor_user_id)
        .bind(committed_at)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        (self.map_doc_row(row), None, root)
      }
    };

    // One durable event owns the complete lifecycle fanout. The consumer
    // publishes leaf before root so clients never discover a newly created or
    // renamed page before its document delta is available. Yjs updates are
    // idempotent, therefore replaying the complete ordered event is safe.
    let mut updates = Vec::with_capacity(2);
    if let Some(leaf) = &leaf {
      updates.push(leaf.clone());
    }
    updates.push(workspace_root.clone());
    Self::append_workspace_doc_broadcast_outbox(
      &mut tx,
      doc_id,
      workspace_id,
      Some(actor_user_id),
      kind.as_str(),
      &updates,
    )
    .await?;

    Self::append_doc_updated_outbox(&mut tx, doc_id, workspace_id).await?;

    let committed = PageLifecycleCommit {
      kind,
      document,
      leaf,
      workspace_root,
      committed_at,
    };
    crate::mcp_idempotency::commit_document_write(
      &mut tx,
      myoxus_application::mcp::McpDocumentWriteCommit::Lifecycle(&committed),
    )
    .await?;
    if let (Some(ack), Some(receipt)) = (&ack, project.as_mut()) {
      let leaf = committed
        .leaf
        .as_ref()
        .ok_or_else(|| AuthError::Storage("created page has no leaf acknowledgement".into()))?;
      crate::document_metadata::PgDocumentMetadataRepository::clear_template_state_in_tx(&mut tx, doc_id)
        .await
        .map_err(|error| AuthError::Storage(error.to_string()))?;
      receipt.progress.documents.insert(
        ack.component_id.clone(),
        myoxus_application::workspace::ProjectStarterDocumentResult {
          placed: false,
          doc_id,
          external_id: committed.document.external_id.clone(),
          document_revision: leaf.sequence,
          root_revision: committed.workspace_root.sequence,
        },
      );
      let result = sqlx::query("UPDATE workspace_starter_applications SET project_progress=$3 WHERE actor_id=$1 AND operation=$4 AND request_id=$2 AND project_state='accepted'")
        .bind(actor_user_id).bind(ack.request_id)
        .bind(serde_json::to_value(&receipt.progress).map_err(|error| AuthError::Storage(error.to_string()))?).bind(ack.operation.as_str())
        .execute(&mut *tx).await.map_err(Self::map_db_err)?;
      if result.rows_affected() != 1 {
        return Err(AuthError::InvalidInput("Project component frontier changed".into()));
      }
    }
    if let Some((ack, fence)) = ack
      .as_ref()
      .and_then(|ack| ack.automation_effect.as_ref().map(|fence| (ack, fence)))
    {
      crate::workflow_runtime::effects::acknowledge_context_effect(
        &mut tx,
        fence,
        &if matches!(
          ack.admission,
          myoxus_application::workspace::StarterDocumentAdmission::WorkspaceSetup
        ) {
          myoxus_domain::workspace_automation::ContextDocumentWorkflowStage::CreateWorkingDocument {
            component: ack.component_id.clone(),
          }
        } else {
          myoxus_domain::workspace_automation::ContextDocumentWorkflowStage::CreateDocument {
            component: ack.component_id.clone(),
          }
        },
      )
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    }
    if let Some(target) = &row_content {
      crate::workspace_database::PgDatabaseRepository::attach_row_content_document_in_tx(
        &mut tx,
        target.row_id,
        doc_id,
        actor_user_id,
        myoxus_domain::database::DatabaseEditPrecondition::new(Some(target.expected_edit_revision), false)
          .in_workspace(workspace_id)
          .in_database(target.database_id),
      )
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    }
    if let Some(fence) = &automation {
      crate::workflow_runtime::acknowledge_runtime_effect(
        &mut *tx,
        fence,
        serde_json::json!({"doc_id":doc_id,"workspace_id":workspace_id}),
      )
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(myoxus_application::doc::AutomationPageLifecycleResult::Committed(
      committed,
    ))
  }
}

impl SqlxDocStore {
  #[instrument(skip_all)]
  async fn push_update_with_project_placement(
    &self,
    update: DocUpdateWrite,
    ack: Option<myoxus_application::workspace::ProjectPlacementAck>,
  ) -> AuthResult<DocUpdatePersistenceResult> {
    use myoxus_application::doc::DocSpaceKind;

    let mut update = update;
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    if let Some(ack) = &ack {
      let contextual = ack.operation == myoxus_application::workspace::StarterOperation::PrepareDocuments
        || matches!(
          ack.admission,
          myoxus_application::workspace::StarterDocumentAdmission::WorkspaceSetup
        );
      if contextual != ack.automation_effect.is_some() {
        return Err(AuthError::InvalidInput(
          "context placement requires its native execution fence".into(),
        ));
      }
    }
    if let Some((ack, fence)) = ack
      .as_ref()
      .and_then(|ack| ack.automation_effect.as_ref().map(|fence| (ack, fence)))
    {
      let stage = Self::context_placement_stage(&mut tx, fence, &ack.stage).await?;
      crate::workflow_runtime::effects::lock_context_receipt_effect(
        &mut tx,
        fence,
        &stage,
        ack.actor_id,
        ack.workspace_id,
        ack.request_id,
        &ack.fingerprint,
        None,
      )
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    }
    let mut project = if let Some(ack) = &ack {
      use myoxus_application::workspace::*;
      let expected_key = format!("db${}$folders", ack.workspace_id);
      if update.workspace_id != ack.workspace_id
        || update.actor_user_id != Some(ack.actor_id)
        || !matches!(&update.target, DocWriteTarget::External(key) if key.as_str() == expected_key)
        || !matches!(update.space_kind, DocSpaceKind::Workspace)
      {
        return Err(AuthError::InvalidInput("invalid Project placement target".into()));
      }
      crate::workspace::SqlxWorkspaceStore::project_authority(
        &mut tx,
        ack.actor_id,
        ack.workspace_id,
        myoxus_domain::permission::WorkspaceAction::CreateDoc,
      )
      .await?;
      if ack.automation_effect.is_none() {
        crate::workspace::SqlxWorkspaceStore::project_request_lock(
          &mut tx,
          ack.actor_id,
          ack.operation,
          ack.request_id,
        )
        .await?;
      }
      let receipt = crate::workspace::SqlxWorkspaceStore::document_receipt(
        &mut tx,
        ack.actor_id,
        ack.operation,
        ack.workspace_id,
        ack.request_id,
        Some(&ack.fingerprint),
      )
      .await
      .map_err(|error| match error {
        ProjectStarterError::Auth(error) => error,
        _ => AuthError::InvalidInput("accepted Project request changed".into()),
      })?
      .ok_or_else(|| AuthError::InvalidInput("accepted Project request unavailable".into()))?;
      let valid_stage = match &ack.stage {
        ProjectPlacementStage::Folder => !receipt.progress.folder_ready,
        ProjectPlacementStage::NativeLink { component_id } => {
          let already:bool=sqlx::query_scalar("SELECT setup_progress->'results' ? $3 FROM workspace_starter_applications WHERE actor_id=$1 AND operation='create_workspace' AND request_id=$2")
            .bind(ack.actor_id).bind(ack.request_id).bind(component_id).fetch_one(&mut *tx).await.map_err(Self::map_db_err)?;
          receipt.progress.folder_ready
            && !already
            && matches!(&receipt.origin,StarterDocumentOrigin::WorkspaceSetup{links} if links.contains_key(component_id))
        }
        ProjectPlacementStage::Document { component_id } => {
          receipt.progress.folder_ready
            && receipt
              .progress
              .documents
              .get(component_id)
              .is_some_and(|result| !result.placed)
        }
        ProjectPlacementStage::CompleteDocuments => {
          matches!(&receipt.origin, StarterDocumentOrigin::TaskContainer(_))
            && receipt.progress.folder_ready
            && receipt.ids.iter().all(|ids| {
              receipt
                .progress
                .documents
                .get(&ids.component_id)
                .is_some_and(|doc| doc.placed)
            })
        }
        ProjectPlacementStage::Project => {
          matches!(&receipt.origin, StarterDocumentOrigin::Project { .. })
            && receipt.progress.folder_ready
            && receipt.ids.iter().all(|ids| {
              receipt
                .progress
                .documents
                .get(&ids.component_id)
                .is_some_and(|result| result.placed)
            })
        }
      };
      if receipt.state != ProjectStarterState::Accepted
        || (matches!(&receipt.origin, StarterDocumentOrigin::Project { .. }) && !receipt.progress.project_created)
        || receipt.progress.placement_complete
        || !valid_stage
      {
        return Err(AuthError::InvalidInput("Project placement frontier changed".into()));
      }
      crate::workspace::SqlxWorkspaceStore::document_admission_fence(&mut tx, &receipt, &ack.admission).await?;
      if matches!(&receipt.origin, StarterDocumentOrigin::TaskContainer(_))
        && receipt
          .ids
          .iter()
          .any(|ids| !receipt.progress.documents.contains_key(&ids.component_id))
      {
        crate::workspace::SqlxWorkspaceStore::document_people(&mut tx, &receipt).await?;
      }
      Some(receipt)
    } else {
      None
    };
    let ws_id = match update.space_kind {
      DocSpaceKind::Workspace => update.workspace_id,
      DocSpaceKind::Userspace => sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM workspaces
          WHERE owner_user_id = $1
            AND lifecycle_state = 'active'
            AND deleted_at IS NULL",
      )
      .bind(update.workspace_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?,
    };

    let (requested_internal_id, external_id) = match &update.target {
      DocWriteTarget::Internal(doc_id) => (*doc_id, doc_id.to_string()),
      DocWriteTarget::External(document_key) => (Uuid::new_v4(), document_key.as_str().to_string()),
    };
    // Resolution, optional materialization, and the first update must be one
    // transaction. The advisory lock serializes concurrent first writers for
    // the same workspace-local key; without it, both could observe no row and
    // split document identity from update persistence.
    let lock_key = match update.space_kind {
      DocSpaceKind::Workspace => workspace_document_first_create_lock_key(ws_id, &external_id),
      DocSpaceKind::Userspace => format!("doc-first-create:userspace:{}:{external_id}", update.workspace_id),
    };
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
      .bind(lock_key)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;

    let existing_doc_id = match (&update.target, &update.space_kind) {
      (DocWriteTarget::Internal(doc_id), DocSpaceKind::Workspace) => {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM docs WHERE workspace_id = $1 AND id = $2")
          .bind(update.workspace_id)
          .bind(doc_id)
          .fetch_optional(&mut *tx)
          .await
      }
      (DocWriteTarget::Internal(doc_id), DocSpaceKind::Userspace) => {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM docs WHERE userspace_owner_id = $1 AND id = $2")
          .bind(update.workspace_id)
          .bind(doc_id)
          .fetch_optional(&mut *tx)
          .await
      }
      (DocWriteTarget::External(_), DocSpaceKind::Workspace) => {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM docs WHERE workspace_id = $1 AND external_id = $2")
          .bind(update.workspace_id)
          .bind(&external_id)
          .fetch_optional(&mut *tx)
          .await
      }
      (DocWriteTarget::External(_), DocSpaceKind::Userspace) => {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM docs WHERE userspace_owner_id = $1 AND external_id = $2")
          .bind(update.workspace_id)
          .bind(&external_id)
          .fetch_optional(&mut *tx)
          .await
      }
    }
    .map_err(Self::map_db_err)?;
    if existing_doc_id.is_none()
      && matches!(&update.target, DocWriteTarget::External(_))
      && matches!(update.space_kind, DocSpaceKind::Workspace)
    {
      // A browser may still flush an update through its old workspace socket
      // after an atomic Move. The durable redirect is the source tombstone for
      // opaque client keys; accepting that write would recreate a second
      // document in the source workspace under a fresh internal UUID.
      let moved_from_source: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM workspace_content_operation_redirects
           WHERE source_workspace_id = $1
             AND source_kind = 'document'
             AND source_id = $2
         )",
      )
      .bind(ws_id)
      .bind(&external_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if moved_from_source {
        return Err(AuthError::NotFound("document".to_string()));
      }
    }
    if existing_doc_id.is_none() && matches!(&update.target, DocWriteTarget::Internal(_)) {
      // Internal UUIDs are global document identities. A missing row in the
      // requested space may be a legitimate first push, but an identity that
      // already belongs to another space must never be rematerialized. This
      // also closes the stale-source write path after a document Move.
      let identity_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id = $1)")
        .bind(requested_internal_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      if identity_exists {
        return Err(AuthError::NotFound("document".to_string()));
      }
    }
    let auto_created_doc = existing_doc_id.is_none();
    let doc_id = existing_doc_id.unwrap_or(requested_internal_id);
    let mut is_organizer = external_id == format!("db${ws_id}$folders");

    let (mut registration_request, mut prior_registration) = if matches!(update.space_kind, DocSpaceKind::Workspace)
      && matches!(&update.target, DocWriteTarget::External(_))
      && doc_id != ws_id
    {
      Self::registration_request(&mut tx, ws_id, &external_id, existing_doc_id).await?
    } else {
      (Default::default(), None)
    };
    let mut registration_needed = !matches!(
      registration_request,
      yjs::page_registration::PageRegistrationRequest::None
    );

    // Determine the bounded set of projection locks before taking any
    // document lock. A body-only leaf update therefore keeps its single leaf
    // lock, while a title change or stale root title adds only the affected
    // root/leaf identities.
    let mut locked_docs = BTreeSet::from([doc_id]);
    if let Some(receipt) = &project {
      locked_docs.insert(ws_id);
      locked_docs.extend(receipt.progress.documents.values().map(|document| document.doc_id));
    }
    if matches!(update.space_kind, DocSpaceKind::Workspace) {
      locked_docs.extend(Self::title_projection_lock_candidates_in_tx(&mut tx, ws_id, doc_id, &update.payload).await?);
    }
    if registration_needed && doc_id != ws_id {
      locked_docs.insert(ws_id);
    }
    for locked_doc_id in locked_docs.iter().copied() {
      sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
        .bind(workspace_document_lock_key(update.workspace_id, locked_doc_id))
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    if let Some(receipt) = &project {
      // The complete root/result/Organizer advisory set above is acquired in
      // native lifecycle order before live identity and blocked-state checks.
      for result in receipt.progress.documents.values() {
        let row = sqlx::query("SELECT external_id FROM docs WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND blocked=FALSE AND NOT is_workspace_root FOR SHARE")
          .bind(result.doc_id).bind(ws_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
        if !row.is_some_and(|row| row.get::<String, _>("external_id") == result.external_id) {
          return Err(AuthError::InvalidInput(
            "acknowledged Project document unavailable".into(),
          ));
        }
      }
    }
    if auto_created_doc
      && matches!(update.space_kind, DocSpaceKind::Workspace)
      && matches!(&update.target, DocWriteTarget::Internal(_))
    {
      let retired: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM page_registration_evidence WHERE workspace_id = $1 AND doc_id = $2)",
      )
      .bind(ws_id)
      .bind(doc_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if retired {
        return Err(AuthError::NotFound("document".into()));
      }
    }
    if !auto_created_doc && matches!(update.space_kind, DocSpaceKind::Workspace) {
      // Revalidate ownership after the canonical document lock. A Move may
      // have committed after target resolution but before this write reached
      // persistence; row locking makes that race end as a missing source
      // document instead of appending an update under the old workspace.
      is_organizer = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE(external_id = $3, FALSE) FROM docs
         WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
         FOR UPDATE",
      )
      .bind(doc_id)
      .bind(ws_id)
      .bind(format!("db${ws_id}$folders"))
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or_else(|| AuthError::NotFound("document".to_string()))?;

      // State may have advanced between the unlocked candidate read and the
      // canonical locks. Never extend the lock set out of UUID order: abandon
      // the write-free transaction and resolve the identity/state again.
      let required = Self::title_projection_lock_candidates_in_tx(&mut tx, ws_id, doc_id, &update.payload).await?;
      if !required.is_subset(&locked_docs) {
        tx.rollback().await.map_err(Self::map_db_err)?;
        return Box::pin(self.push_update_with_project_placement(update, ack)).await;
      }
    }

    if doc_id == ws_id
      && matches!(update.space_kind, DocSpaceKind::Workspace)
      && matches!(&update.target, DocWriteTarget::External(_))
    {
      // Refresh after both advisory and SQL row locks: first registration,
      // deletion or Move may have committed while this delivery was waiting.
      (registration_request, prior_registration) =
        Self::registration_request(&mut tx, ws_id, &external_id, existing_doc_id).await?;
      registration_needed = !matches!(
        registration_request,
        yjs::page_registration::PageRegistrationRequest::None
      );
    }

    if let Some(ack) = &ack {
      let current = Self::load_full_doc_in_tx(&mut tx, ws_id, doc_id).await?;
      let snapshot = myoxus_application::organizer::OrganizerSnapshot::from_update(ws_id, &current)
        .map_err(|_| AuthError::Storage("invalid canonical Organizer".into()))?;
      if snapshot.content_revision() != ack.organizer_revision {
        return Err(AuthError::InvalidInput("Project Organizer revision changed".into()));
      }
    }
    let validated_external_update = match &update.target {
      DocWriteTarget::External(_) => Some(
        update
          .validated_external_update
          .take()
          .ok_or(AuthError::InvalidYjsUpdate)?,
      ),
      DocWriteTarget::Internal(_) => {
        if update.validated_external_update.is_some() {
          return Err(AuthError::Storage(
            "internal document update carried external validation state".to_string(),
          ));
        }
        None
      }
    };
    let payload_sha256 = validated_external_update
      .as_ref()
      .map(|_| Sha256::digest(&update.payload).to_vec());

    if let Some(digest) = payload_sha256.as_deref()
      && !auto_created_doc
    {
      let exact_replay: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM doc_updates WHERE doc_id = $1 AND payload_sha256 = $2
         )",
      )
      .bind(doc_id)
      .bind(digest)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if exact_replay {
        trace!(
          workspace_id = %update.workspace_id,
          %doc_id,
          sync_operation_id = ?update.sync_operation_id,
          outcome = DocUpdatePersistenceOutcome::ExactReplay.as_str(),
          "document update classified without persistence"
        );
        if let (Some(ack), Some(receipt)) = (&ack, project.as_mut()) {
          Self::acknowledge_project_placement(&mut tx, doc_id, ack, receipt).await?;
        }
        tx.commit().await.map_err(Self::map_db_err)?;
        return Ok(DocUpdatePersistenceResult {
          doc_id,
          auto_created_doc: false,
          outcome: DocUpdatePersistenceOutcome::ExactReplay,
          page_registration: prior_registration,
        });
      }
    }

    // External replay classification is completed before provenance audit
    // writes. A CRDT no-op on an existing document therefore has no durable
    // side effects. The first accepted push still materializes an unknown key,
    // including the protocol's empty `[0, 0]` bootstrap update.
    let mut registration_projection = Default::default();
    let next_state_vector = if let Some(validated) = validated_external_update {
      let (decoded, max_materialization_bytes) = validated.into_parts();
      let current_state_vector = if auto_created_doc {
        Some(yjs::empty_state_vector_v1())
      } else {
        sqlx::query_scalar::<_, Option<Vec<u8>>>("SELECT sync_state_vector_v1 FROM docs WHERE id = $1")
          .bind(doc_id)
          .fetch_one(&mut *tx)
          .await
          .map_err(Self::map_db_err)?
      };
      let classified = Self::classify_external_candidate(
        &mut tx,
        ws_id,
        doc_id,
        decoded,
        current_state_vector,
        max_materialization_bytes,
        registration_request,
      )
      .await?;
      if classified.is_crdt_noop && !auto_created_doc {
        let page_registration = if registration_needed {
          Self::finish_page_registration(
            &mut tx,
            ws_id,
            doc_id,
            &external_id,
            update.actor_user_id,
            prior_registration,
            classified.registration,
            classified.state_vector.is_some(),
          )
          .await?
        } else {
          prior_registration
        };
        trace!(
          workspace_id = %update.workspace_id,
          %doc_id,
          sync_operation_id = ?update.sync_operation_id,
          outcome = DocUpdatePersistenceOutcome::CrdtNoop.as_str(),
          "document update classified without persistence"
        );
        if let (Some(ack), Some(receipt)) = (&ack, project.as_mut()) {
          Self::acknowledge_project_placement(&mut tx, doc_id, ack, receipt).await?;
        }
        tx.commit().await.map_err(Self::map_db_err)?;
        return Ok(DocUpdatePersistenceResult {
          doc_id,
          auto_created_doc: false,
          outcome: DocUpdatePersistenceOutcome::CrdtNoop,
          page_registration,
        });
      }
      registration_projection = classified.registration;
      classified.state_vector
    } else {
      // Internal server-authored updates do not cross the external decoder.
      // Invalidate the acceleration value atomically so the next external
      // write reconstructs it from snapshot and tail.
      None
    };

    let received_at_server = chrono::Utc::now();
    let (effective_client_format, effective_client_capabilities, effective_initial_provenance) = match update.space_kind
    {
      DocSpaceKind::Workspace => (
        update.client_format.as_deref(),
        update.client_capabilities.as_deref(),
        update.initial_provenance.as_ref(),
      ),
      DocSpaceKind::Userspace => (None, None, None),
    };
    let mut resolved = resolve_initial_document_provenance(
      ws_id,
      doc_id,
      update.actor_user_id,
      InitialDocumentProvenanceSource::ClientSync,
      effective_client_format,
      effective_client_capabilities,
      effective_initial_provenance,
      received_at_server,
    );
    let accepted_client_instance = resolved
      .normalized_provenance
      .get("clientInstanceId")
      .and_then(serde_json::Value::as_str)
      .map(str::to_owned);
    if let serde_json::Value::Object(fields) = &mut resolved.normalized_provenance {
      fields.insert(
        "connectionClientKind".to_string(),
        update
          .connection_context
          .as_ref()
          .map(|context| serde_json::Value::String(context.client_kind.as_str().to_string()))
          .unwrap_or(serde_json::Value::Null),
      );
    }
    let resolved_provenance_mode = match resolved.provenance_mode {
      myoxus_application::doc::ResolvedInitialDocumentProvenanceMode::ServerObservedFirstSync => {
        "server_observed_first_sync"
      }
      myoxus_application::doc::ResolvedInitialDocumentProvenanceMode::OfflineSync => "offline_sync",
      myoxus_application::doc::ResolvedInitialDocumentProvenanceMode::ExplicitImport => "explicit_import",
    };

    if auto_created_doc {
      if matches!(update.space_kind, DocSpaceKind::Workspace) && registration::normal_page(ws_id, &external_id) {
        info!(%ws_id, %doc_id, outcome = "first_leaf", "page registration received content");
      }
      // `docs` rows are content/ownership facts. Workspace documents and
      // userspace documents intentionally materialize through different owner
      // columns; visible page order/parentage for workspace pages is projected
      // from the workspace root Yjs `meta.pages`, not inferred from a Git-Sync
      // binding or from the raw presence of this row.
      match update.space_kind {
        DocSpaceKind::Workspace => {
          sqlx::query(
            r#"INSERT INTO docs (
                 id, workspace_id, external_id, created_by, updated_by, created_at, updated_at
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
          )
          .bind(doc_id)
          .bind(update.workspace_id)
          .bind(&external_id)
          .bind(resolved.applied_created_by)
          .bind(resolved.applied_updated_by)
          .bind(resolved.applied_created_at)
          .bind(resolved.applied_updated_at)
          .execute(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
        }
        DocSpaceKind::Userspace => {
          sqlx::query(
            r#"INSERT INTO docs (
                 id, userspace_owner_id, external_id, created_by, updated_by, created_at, updated_at
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
          )
          .bind(doc_id)
          .bind(update.workspace_id)
          .bind(&external_id)
          .bind(resolved.applied_created_by)
          .bind(resolved.applied_updated_by)
          .bind(resolved.applied_created_at)
          .bind(resolved.applied_updated_at)
          .execute(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
        }
      }

      let raw_provenance = serde_json::to_value(&update.initial_provenance).unwrap_or(serde_json::Value::Null);
      sqlx::query(
        r#"INSERT INTO document_initial_sync_audit (
             doc_id, workspace_id, actor_user_id, client_instance_id, source_property_doc_revision,
             idempotency_key, provenance_mode, received_at_server, resolution_kind, decision_code,
             raw_provenance, normalized_provenance, applied_created_at, applied_updated_at,
             applied_created_by, applied_updated_by, rejected_fields
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'created',$9,$10,$11,$12,$13,$14,$15,$16)"#,
      )
      .bind(doc_id)
      .bind(ws_id)
      .bind(update.actor_user_id)
      .bind(accepted_client_instance.as_deref())
      .bind(
        update
          .initial_provenance
          .as_ref()
          .and_then(|p| p.source_property_doc_revision.as_deref()),
      )
      .bind(&resolved.idempotency_key)
      .bind(resolved_provenance_mode)
      .bind(resolved.received_at_server)
      .bind(&resolved.decision_code)
      .bind(raw_provenance)
      .bind(&resolved.normalized_provenance)
      .bind(resolved.applied_created_at)
      .bind(resolved.applied_updated_at)
      .bind(resolved.applied_created_by)
      .bind(resolved.applied_updated_by)
      .bind(&resolved.rejected_fields)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    } else {
      if let Some(provenance) = &update.initial_provenance {
        let raw_provenance = serde_json::to_value(provenance).unwrap_or(serde_json::Value::Null);
        let mut normalized_provenance = resolved.normalized_provenance.clone();
        if let serde_json::Value::Object(fields) = &mut normalized_provenance {
          fields.insert("existingDocument".to_string(), serde_json::Value::Bool(true));
        }
        sqlx::query(
          r#"INSERT INTO document_initial_sync_audit (
               doc_id, workspace_id, actor_user_id, client_instance_id, source_property_doc_revision,
               idempotency_key, provenance_mode, received_at_server, resolution_kind, decision_code,
               raw_provenance, normalized_provenance, rejected_fields
             )
             VALUES ($1,$2,$3,$4,$5,$6,$7,now(),'ignored_existing_document','document_already_exists',$8,$9,$10)
             ON CONFLICT (doc_id, idempotency_key) DO NOTHING"#,
        )
        .bind(doc_id)
        .bind(ws_id)
        .bind(update.actor_user_id)
        .bind(accepted_client_instance.as_deref())
        .bind(provenance.source_property_doc_revision.as_deref())
        .bind(&resolved.idempotency_key)
        .bind(resolved_provenance_mode)
        .bind(raw_provenance.clone())
        .bind(normalized_provenance)
        .bind(&resolved.rejected_fields)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      }
    }

    let row = sqlx::query(
      r#"
      INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence, payload_sha256)
      VALUES ($1, $2, $3,
        GREATEST(
          COALESCE((SELECT MAX(sequence) FROM doc_updates WHERE doc_id = $1 AND (workspace_id = $2 OR $5)), 0),
          COALESCE((SELECT last_sequence FROM doc_snapshots WHERE doc_id = $1 AND (workspace_id = $2 OR $5)), 0)
        ) + 1,
        $4
      )
      RETURNING sequence
      "#,
    )
    .bind(doc_id)
    .bind(ws_id)
    .bind(&update.payload)
    .bind(payload_sha256.as_deref())
    // Private identity, locks and sequence are owner-scoped even when its
    // physical workspace changes; a durable ACK must stay above the snapshot.
    .bind(matches!(update.space_kind, DocSpaceKind::Userspace))
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let assigned_sequence: i64 = row.get("sequence");
    sqlx::query("UPDATE docs SET sync_state_vector_v1 = $2 WHERE id = $1")
      .bind(doc_id)
      .bind(next_state_vector.as_deref())
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    crate::document_metadata::PgDocumentMetadataRepository::mark_named_version_dirty_in_tx(&mut tx, doc_id)
      .await
      .map_err(|error| AuthError::Storage(error.to_string()))?;
    if matches!(update.space_kind, DocSpaceKind::Workspace) {
      let eligible = Self::mark_edit_capture_dirty_in_tx(&mut tx, ws_id, doc_id, assigned_sequence).await?;
      // Only authenticated normal sync edits enter the business window.
      // Registration and replay/no-op returns precede this persisted path;
      // internal maintenance/import writes retain their separate authority.
      if eligible
        && !auto_created_doc
        && !registration_needed
        && matches!(&update.target, DocWriteTarget::External(_))
        && let Some(actor) = update.actor_user_id
      {
        crate::notification::document_change::accumulate_in_tx(
          &mut tx,
          ws_id,
          doc_id,
          actor,
          assigned_sequence,
          chrono::Utc::now(),
        )
        .await?;
      }
    }
    let page_registration = if registration_needed {
      Self::finish_page_registration(
        &mut tx,
        ws_id,
        doc_id,
        &external_id,
        update.actor_user_id,
        prior_registration,
        registration_projection,
        next_state_vector.is_some(),
      )
      .await?
    } else {
      prior_registration
    };
    if matches!(update.space_kind, DocSpaceKind::Workspace) {
      let accepted = PageLifecycleDelta {
        doc_id,
        sequence: assigned_sequence,
        delta: update.payload.clone(),
      };
      let mut broadcast_updates = vec![accepted];
      if is_organizer {
        // Offline deliveries can introduce previously unseen links after a
        // permanent delete. Normalize them against durable deletion evidence
        // in this same commit; absence, trash or Move are not deletion proof.
        if let Some(delta) = Self::retire_deleted_organizer_links_in_tx(&mut tx, ws_id, doc_id).await? {
          broadcast_updates.push(delta);
        }
      }
      let committed_at = chrono::Utc::now();
      if doc_id == ws_id {
        broadcast_updates.extend(Self::project_root_metadata_in_tx(&mut tx, ws_id, &locked_docs, committed_at).await?);
      } else if let Some(root_delta) =
        Self::project_leaf_title_in_tx(&mut tx, ws_id, doc_id, committed_at, locked_docs.contains(&ws_id)).await?
      {
        broadcast_updates.push(root_delta);
      }
      Self::append_workspace_doc_broadcast_outbox(
        &mut tx,
        doc_id,
        ws_id,
        update.actor_user_id,
        "doc_update",
        &broadcast_updates,
      )
      .await?;
    }
    if let (Some(ack), Some(receipt)) = (&ack, project.as_mut()) {
      Self::acknowledge_project_placement(&mut tx, doc_id, ack, receipt).await?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    trace!(
      workspace_id = %update.workspace_id, doc_id = %doc_id, sync_operation_id = ?update.sync_operation_id,
      payload_size = update.payload.len(),
      assigned_sequence,
      "update pushed to store"
    );
    Ok(DocUpdatePersistenceResult {
      doc_id,
      auto_created_doc,
      outcome: DocUpdatePersistenceOutcome::Persisted,
      page_registration,
    })
  }
}

impl SqlxDocStore {
  async fn context_placement_stage(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    fence: &myoxus_domain::workspace_automation::AutomationEffectFence,
    expected: &myoxus_application::workspace::ProjectPlacementStage,
  ) -> AuthResult<myoxus_domain::workspace_automation::ContextDocumentWorkflowStage> {
    use myoxus_application::workspace::ProjectPlacementStage as Placement;
    use myoxus_domain::workspace_automation::{AcceptedAutomationRun, ContextDocumentWorkflowStage as Stage};
    let row=sqlx::query("SELECT r.accepted_json,a.position FROM workspace_automation_runs r JOIN workspace_automation_actions a ON a.run_id=r.id WHERE r.id=$1 AND a.id=$2")
      .bind(fence.run_id).bind(fence.action_id).fetch_one(&mut **tx).await.map_err(Self::map_db_err)?;
    let run: AcceptedAutomationRun = serde_json::from_value(row.try_get("accepted_json").map_err(Self::map_db_err)?)
      .map_err(|_| AuthError::InvalidInput("context workflow unavailable".into()))?;
    let position: i32 = row.try_get("position").map_err(Self::map_db_err)?;
    let stage = run
      .definition
      .workflow
      .and_then(|workflow| {
        usize::try_from(position)
          .ok()
          .and_then(|position| workflow.stages.get(position).cloned())
      })
      .ok_or_else(|| AuthError::InvalidInput("context workflow stage unavailable".into()))?;
    if !matches!(
      (&stage, expected),
      (Stage::Folder, Placement::Folder) | (Stage::Complete, Placement::CompleteDocuments)
    ) && !matches!((&stage,expected),(Stage::PlaceDocument{component,..},Placement::Document{component_id}) | (Stage::PlaceNativeLink{component},Placement::NativeLink{component_id}) if component==component_id)
    {
      return Err(AuthError::InvalidInput("context placement stage mismatch".into()));
    }
    Ok(stage)
  }

  async fn acknowledge_project_placement(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    organizer_id: Uuid,
    ack: &myoxus_application::workspace::ProjectPlacementAck,
    receipt: &mut myoxus_application::workspace::StarterDocumentReceipt,
  ) -> AuthResult<()> {
    let payload = Self::load_full_doc_in_tx(tx, ack.workspace_id, organizer_id).await?;
    myoxus_application::organizer::verify_document_starter_placement(&payload, receipt, &ack.stage)
      .map_err(|_| AuthError::InvalidInput("Project placement projection mismatch".into()))?;
    use myoxus_application::workspace::ProjectPlacementStage;
    match &ack.stage {
      ProjectPlacementStage::Folder => receipt.progress.folder_ready = true,
      ProjectPlacementStage::NativeLink { component_id } => {
        let myoxus_application::workspace::StarterDocumentOrigin::WorkspaceSetup { links } = &receipt.origin else {
          return Err(AuthError::InvalidInput("Workspace link receipt mismatch".into()));
        };
        let link = links
          .get(component_id)
          .ok_or_else(|| AuthError::InvalidInput("Workspace link result unavailable".into()))?;
        if let myoxus_domain::workspace_automation::WorkspaceSetupResult::Document { document_id } = &link.target {
          receipt
            .progress
            .documents
            .values_mut()
            .find(|document| document.doc_id == *document_id)
            .ok_or_else(|| AuthError::InvalidInput("Workspace document result unavailable".into()))?
            .placed = true;
        }
        let result = myoxus_domain::workspace_automation::WorkspaceSetupResult::NativeLink {
          component_id: component_id.clone(),
          entry_id: link.entry_id.clone(),
        };
        sqlx::query("UPDATE workspace_starter_applications SET setup_progress=jsonb_set(setup_progress,ARRAY['results',$3],$4,true) WHERE actor_id=$1 AND operation='create_workspace' AND request_id=$2 AND project_state='accepted'")
          .bind(ack.actor_id).bind(ack.request_id).bind(component_id).bind(serde_json::to_value(result).map_err(|error|AuthError::Storage(error.to_string()))?).execute(&mut **tx).await.map_err(Self::map_db_err)?;
      }
      ProjectPlacementStage::Document { component_id } => {
        receipt
          .progress
          .documents
          .get_mut(component_id)
          .ok_or_else(|| AuthError::InvalidInput("Project document frontier changed".into()))?
          .placed = true
      }
      ProjectPlacementStage::Project | ProjectPlacementStage::CompleteDocuments => {
        receipt.progress.placement_complete = true
      }
    }
    let state = if receipt.progress.placement_complete {
      "complete"
    } else {
      "accepted"
    };
    let result = sqlx::query("UPDATE workspace_starter_applications SET project_progress=$3,project_state=$4 WHERE actor_id=$1 AND operation=$5 AND request_id=$2 AND project_state='accepted'")
      .bind(ack.actor_id).bind(ack.request_id).bind(serde_json::to_value(&receipt.progress).map_err(|error| AuthError::Storage(error.to_string()))?).bind(state).bind(ack.operation.as_str())
      .execute(&mut **tx).await.map_err(Self::map_db_err)?;
    if result.rows_affected() != 1 {
      return Err(AuthError::InvalidInput("Project placement frontier changed".into()));
    }
    if let Some(fence) = &ack.automation_effect {
      let stage = Self::context_placement_stage(tx, fence, &ack.stage).await?;
      crate::workflow_runtime::effects::acknowledge_context_effect(tx, fence, &stage)
        .await
        .map_err(|error| AuthError::Storage(error.to_string()))?;
    }
    Ok(())
  }
}
