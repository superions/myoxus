// SPDX-License-Identifier: AGPL-3.0-or-later
//! SQL-only publication of Extract's Git ownership, inside the content transaction.

use super::*;

/// The profile identity is derived from the receipt, never allocated on retry.
pub(super) fn target_profile_id(operation_id: Uuid) -> Uuid {
  myoxus_application::workspace_content_operation::extract_git_profile_id(operation_id)
}

pub(super) async fn lock_profiles(tx: &mut Transaction<'_, Postgres>, workspace_ids: &[Uuid]) -> AuthResult<()> {
  // Rotation uses the same stable dependent ordering. Take these locks before
  // document locks, as normal post-push persistence does.
  sqlx::query(
    "SELECT id FROM git_sync_profiles WHERE workspace_id = ANY($1)
    OR credential_id IN (SELECT credential_id FROM git_sync_profiles WHERE workspace_id = ANY($1))
    ORDER BY id FOR UPDATE",
  )
  .bind(workspace_ids)
  .fetch_all(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  Ok(())
}

pub(super) async fn publish(
  tx: &mut Transaction<'_, Postgres>,
  operation: &WorkspaceContentOperationRecord,
  mappings: &[WorkspaceContentIdMapping],
) -> AuthResult<Option<WorkspaceContentGitSyncPlan>> {
  let captured: Option<serde_json::Value> = sqlx::query_scalar(
    "SELECT git_sync_plan FROM workspace_content_extract_targets WHERE operation_id = $1 FOR UPDATE",
  )
  .bind(operation.id)
  .fetch_one(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  let Some(captured) = captured else {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM git_sync_profiles WHERE workspace_id = $1)")
      .bind(operation.source_workspace_id)
      .fetch_one(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    return if exists { Err(stale()) } else { Ok(None) };
  };
  let plan: WorkspaceContentGitSyncPlan = serde_json::from_value(captured).map_err(|_| stale())?;
  let source = sqlx::query(
    "SELECT updated_at, scope_revision, workspace_id, owner_id FROM git_sync_profiles WHERE id = $1 FOR UPDATE",
  )
  .bind(plan.source_profile_id)
  .fetch_optional(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?
  .ok_or_else(stale)?;
  let count: i64 = sqlx::query_scalar("SELECT count(*) FROM git_sync_profiles WHERE workspace_id=$1")
    .bind(operation.source_workspace_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if count != 1 {
    return Err(stale());
  }
  if source.get::<chrono::DateTime<Utc>, _>("updated_at") != plan.source_profile_updated_at
    || source.get::<i64, _>("scope_revision") != plan.source_scope_revision
    || source.get::<Uuid, _>("workspace_id") != operation.source_workspace_id
    || source.get::<Uuid, _>("owner_id") != plan.source_profile_owner_id
  {
    return Err(stale());
  }
  let busy: bool = sqlx::query_scalar("SELECT
    EXISTS(SELECT 1 FROM git_sync_runs WHERE profile_id = $1 AND (status IN ('Pending','Running') OR reconciliation_required))
    OR EXISTS(SELECT 1 FROM git_sync_partial_sessions WHERE profile_id = $1 AND status = 'Open')
    OR EXISTS(SELECT 1 FROM git_sync_bootstrap_attempts WHERE profile_id = $1 AND phase IN ('Prepared','RemoteApplied'))
    OR EXISTS(SELECT 1 FROM git_sync_profiles p JOIN git_sync_credentials c ON c.id = p.credential_id
      JOIN git_token_rotation r ON r.profile_id = c.profile_id WHERE p.id = $1 AND r.state = 'Rotating')")
    .bind(plan.source_profile_id).fetch_one(&mut **tx).await.map_err(PgWorkspaceContentOperationRepository::storage)?;
  if busy {
    return Err(stale());
  }
  if plan.choice == WorkspaceContentGitSyncChoice::Disconnect {
    disconnect(tx, operation, &plan).await?;
    return Ok(Some(plan));
  }
  let target_workspace = operation.target_workspace_id.ok_or_else(stale)?;
  let target = target_profile_id(operation.id);
  // Copy only configuration and the active credential pointer. Stewardship and
  // rotation remain on the existing credential; no ciphertext enters the receipt.
  sqlx::query(
    "INSERT INTO git_sync_profiles
    (id, workspace_id, owner_id, repo_url, branch, root_path, manifest_path,
      scope_revision, sync_direction, trigger_mode, polling_interval_secs,
      cron_expression, cron_timezone, cron_misfire_policy, cron_next_scheduled_at,
      auth_method, credential_id, enabled, max_mirror_storage_mb)
    SELECT $2, $3, owner_id, repo_url, branch, $4, $5, 1, sync_direction, trigger_mode,
      polling_interval_secs, cron_expression, cron_timezone, cron_misfire_policy,
      cron_next_scheduled_at, auth_method, credential_id, false, max_mirror_storage_mb
    FROM git_sync_profiles WHERE id = $1",
  )
  .bind(plan.source_profile_id)
  .bind(target)
  .bind(target_workspace)
  .bind(&plan.target_root)
  .bind(&plan.target_manifest)
  .execute(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  sqlx::query("UPDATE git_sync_profiles SET scope_revision = scope_revision + 1, updated_at = now() WHERE id = $1")
    .bind(plan.source_profile_id)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  sqlx::query(
    "INSERT INTO git_sync_scope_exclusions
    (profile_id, repo_path, is_directory, destination_profile_id, originating_operation_id, scope_revision)
    VALUES ($1, $2, true, $3, $4, $5)",
  )
  .bind(plan.source_profile_id)
  .bind(&plan.target_root)
  .bind(target)
  .bind(operation.id)
  .bind(plan.source_scope_revision + 1)
  .execute(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  for fence in &plan.delegated_descendants {
    sqlx::query(
      "INSERT INTO git_sync_scope_exclusions
      (profile_id, repo_path, is_directory, destination_profile_id, originating_operation_id, scope_revision)
      VALUES ($1, $2, $3, $4, $5, 1)",
    )
    .bind(target)
    .bind(&fence.repo_path)
    .bind(fence.is_directory)
    .bind(fence.destination_profile_id)
    .bind(fence.originating_operation_id)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  }
  SqlxGitSyncStore::validate_extract_scopes(tx, &plan.repository, &plan.branch, &[plan.source_profile_id, target])
    .await
    .map_err(|_| stale())?;
  for document in &plan.documents {
    let changed = sqlx::query(
      "UPDATE git_sync_bindings SET profile_id = $2, workspace_id = $3, updated_at = now()
      WHERE id = $1 AND profile_id = $4 AND workspace_id = $5 AND doc_id = $6 AND sync_id = $7
        AND repo_path = $8 AND NOT tombstone AND content_hash IS NOT DISTINCT FROM $9
        AND (SELECT content_hash FROM git_sync_baselines WHERE binding_id = $1) IS NOT DISTINCT FROM $10",
    )
    .bind(document.binding_id)
    .bind(target)
    .bind(target_workspace)
    .bind(plan.source_profile_id)
    .bind(target_workspace)
    .bind(document.doc_id)
    .bind(document.sync_id)
    .bind(&document.repo_path)
    .bind(&document.content_hash)
    .bind(&document.baseline_hash)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .rows_affected();
    if changed != 1 {
      return Err(stale());
    }
  }
  for file in &plan.files {
    let target_key = mappings
      .iter()
      .find(|mapping| {
        mapping.source.kind() == WorkspaceContentResourceKind::Blob && mapping.source.resource_id() == file.blob_key
      })
      .map(|mapping| mapping.target.resource_id())
      .ok_or_else(stale)?;
    let changed = sqlx::query(
      "UPDATE git_sync_file_bindings SET profile_id = $2, workspace_id = $3, blob_key = $9, updated_at = now()
      WHERE id = $1 AND profile_id = $4 AND workspace_id = $5 AND repo_path = $6 AND blob_key = $7
        AND content_hash = $8 AND NOT tombstoned",
    )
    .bind(file.binding_id)
    .bind(target)
    .bind(target_workspace)
    .bind(plan.source_profile_id)
    .bind(operation.source_workspace_id)
    .bind(&file.repo_path)
    .bind(&file.blob_key)
    .bind(&file.content_hash)
    .bind(target_key)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .rows_affected();
    if changed != 1 {
      return Err(stale());
    }
    sqlx::query(
      "UPDATE git_sync_file_baselines SET profile_id = $2, blob_key = $4 WHERE profile_id = $1 AND blob_key = $3",
    )
    .bind(plan.source_profile_id)
    .bind(target)
    .bind(&file.blob_key)
    .bind(target_key)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  }
  for shared in &plan.shared_files {
    let copied = sqlx::query(
      "INSERT INTO git_sync_file_bindings
      (id,profile_id,workspace_id,blob_key,repo_path,content_hash,mime_type,file_size)
      SELECT $2,$3,$4,$5,$6,content_hash,mime_type,file_size FROM git_sync_file_bindings
      WHERE id=$1 AND profile_id=$7 AND blob_key=$8 AND repo_path=$9 AND content_hash=$10 AND NOT tombstoned",
    )
    .bind(shared.source.binding_id)
    .bind(Uuid::new_v5(&operation.id, shared.source.binding_id.as_bytes()))
    .bind(target)
    .bind(target_workspace)
    .bind(&shared.target_blob_key)
    .bind(&shared.target_repo_path)
    .bind(plan.source_profile_id)
    .bind(&shared.source.blob_key)
    .bind(&shared.source.repo_path)
    .bind(&shared.source.content_hash)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .rows_affected();
    if copied != 1 {
      return Err(stale());
    }
    sqlx::query(
      "INSERT INTO git_sync_file_baselines (profile_id,blob_key,content_hash,commit_oid)
      VALUES ($1,$2,$3,$4)",
    )
    .bind(target)
    .bind(&shared.target_blob_key)
    .bind(&shared.source.content_hash)
    .bind(&plan.remote_oid)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  }
  sqlx::query(
    "UPDATE workspace_content_extract_targets SET git_sync_pending = true,
    git_sync_error_code = NULL, git_sync_retry_exhausted = false WHERE operation_id = $1",
  )
  .bind(operation.id)
  .execute(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  Ok(Some(plan))
}

fn stale() -> AuthError {
  AuthError::InvalidInput(WorkspaceContentErrorCode::PreflightStale.as_str().into())
}

async fn disconnect(
  tx: &mut Transaction<'_, Postgres>,
  operation: &WorkspaceContentOperationRecord,
  plan: &WorkspaceContentGitSyncPlan,
) -> AuthResult<()> {
  // Retire bindings, not path-owner rows: their triggers alone release the
  // ledger. The detached fence remains authoritative even after history expiry.
  sqlx::query("UPDATE git_sync_profiles SET scope_revision=scope_revision+1,updated_at=now() WHERE id=$1")
    .bind(plan.source_profile_id)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  sqlx::query("INSERT INTO git_sync_scope_exclusions (profile_id,repo_path,is_directory,destination_profile_id,originating_operation_id,scope_revision)
    VALUES ($1,$2,true,NULL,$3,$4)")
    .bind(plan.source_profile_id).bind(&plan.target_root).bind(operation.id).bind(plan.source_scope_revision+1)
    .execute(&mut **tx).await.map_err(PgWorkspaceContentOperationRepository::storage)?;
  let ids = plan
    .documents
    .iter()
    .map(|document| document.doc_id)
    .collect::<Vec<_>>();
  let paths = plan.files.iter().map(|file| file.repo_path.clone()).collect::<Vec<_>>();
  for document in &plan.documents {
    let changed = sqlx::query(
      "UPDATE git_sync_bindings SET tombstone=true,updated_at=now()
      WHERE id=$1 AND profile_id=$2 AND doc_id=$3 AND sync_id=$4 AND repo_path=$5 AND NOT tombstone",
    )
    .bind(document.binding_id)
    .bind(plan.source_profile_id)
    .bind(document.doc_id)
    .bind(document.sync_id)
    .bind(&document.repo_path)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .rows_affected();
    if changed != 1 {
      return Err(stale());
    }
    sqlx::query("DELETE FROM git_sync_baselines WHERE binding_id=$1")
      .bind(document.binding_id)
      .execute(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
  }
  for file in &plan.files {
    let changed = sqlx::query(
      "UPDATE git_sync_file_bindings SET tombstoned=true,updated_at=now()
      WHERE id=$1 AND profile_id=$2 AND repo_path=$3 AND content_hash=$4 AND NOT tombstoned",
    )
    .bind(file.binding_id)
    .bind(plan.source_profile_id)
    .bind(&file.repo_path)
    .bind(&file.content_hash)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .rows_affected();
    if changed != 1 {
      return Err(stale());
    }
    sqlx::query("DELETE FROM git_sync_file_baselines baseline WHERE profile_id=$1 AND blob_key=$2
      AND NOT EXISTS(SELECT 1 FROM git_sync_file_bindings b WHERE b.profile_id=baseline.profile_id AND b.blob_key=baseline.blob_key AND NOT b.tombstoned)")
      .bind(plan.source_profile_id).bind(&file.blob_key).execute(&mut **tx).await.map_err(PgWorkspaceContentOperationRepository::storage)?;
  }
  sqlx::query(
    "UPDATE git_sync_conflicts SET resolution='Dismissed',resolved_at=now(),resolved_by=$3
    WHERE profile_id=$1 AND doc_id=ANY($2) AND resolution='Open'",
  )
  .bind(plan.source_profile_id)
  .bind(&ids)
  .bind(operation.actor_id)
  .execute(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  sqlx::query(
    "UPDATE git_sync_file_conflicts SET resolution='Dismissed',resolved_at=now(),resolved_by=$3
    WHERE profile_id=$1 AND repo_path=ANY($2) AND resolution='Open'",
  )
  .bind(plan.source_profile_id)
  .bind(&paths)
  .bind(operation.actor_id)
  .execute(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  sqlx::query(
    "UPDATE git_sync_history_capture_receipts receipt SET discarded_at=now() FROM doc_histories history
    WHERE receipt.profile_id=$1 AND receipt.history_id=history.id AND history.doc_id=ANY($2)
      AND receipt.assigned_run_id IS NULL AND receipt.discarded_at IS NULL",
  )
  .bind(plan.source_profile_id)
  .bind(&ids)
  .execute(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  sqlx::query(
    "UPDATE workspace_content_extract_targets SET git_sync_pending=true,git_sync_error_code=$2 WHERE operation_id=$1",
  )
  .bind(operation.id)
  .bind(WorkspaceContentErrorCode::GitSyncOutboundCleanupPending.as_str())
  .execute(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  Ok(())
}

impl PgWorkspaceContentOperationRepository {
  pub async fn validate_git_undo_scope(
    &self,
    work: &myoxus_application::workspace_content_operation::extract::WorkspaceContentExtractGitWork,
  ) -> AuthResult<()> {
    let mut connection = self.pool.acquire().await.map_err(Self::storage)?;
    super::git_undo::validate_scopes(
      &mut connection,
      &work.plan,
      work.target_workspace_id,
      work.source_workspace_id,
      true,
    )
    .await
  }
  /// Cleanup is not outbound admission. Require an already completed outbound
  /// source run, and recheck current enablement/direction under native ownership.
  pub async fn disconnect_outbound_admitted(&self, operation_id: Uuid) -> AuthResult<bool> {
    sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM workspace_content_extract_targets e
      JOIN git_sync_profiles p ON p.id::text=e.git_sync_plan->>'sourceProfileId'
      JOIN git_sync_runs r ON r.profile_id=p.id
      WHERE e.operation_id=$1 AND p.enabled AND p.sync_direction<>'GitToMyoxus'
        AND r.status='Completed' AND NOT r.reconciliation_required AND r.finished_at>=e.published_at
        AND r.direction IN ('MyoxusToGit','Bidirectional'))",
    )
    .bind(operation_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::storage)
  }
  pub async fn validate_extract_git_bindings(
    &self,
    work: &myoxus_application::workspace_content_operation::extract::WorkspaceContentExtractGitWork,
  ) -> AuthResult<()> {
    let profile = if work.plan.undo.is_some() {
      work.plan.source_profile_id
    } else {
      target_profile_id(work.operation_id)
    };
    let workspace = if work.plan.undo.is_some() {
      work.source_workspace_id
    } else {
      work.target_workspace_id
    };
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM jsonb_to_recordset($1) AS expected(\"bindingId\" uuid,\"docId\" uuid,\"syncId\" uuid,\"repoPath\" text)
      JOIN git_sync_bindings b ON b.id=expected.\"bindingId\" AND b.doc_id=expected.\"docId\" AND b.sync_id=expected.\"syncId\" AND b.repo_path=expected.\"repoPath\"
      WHERE b.profile_id=$2 AND b.workspace_id=$3 AND NOT b.tombstone")
      .bind(serde_json::to_value(&work.plan.documents).map_err(|_|stale())?).bind(profile).bind(workspace)
      .fetch_one(&self.pool).await.map_err(Self::storage)?;
    if count != work.plan.documents.len() as i64 {
      return Err(stale());
    }
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM jsonb_to_recordset($1) AS expected(\"bindingId\" uuid,\"repoPath\" text,\"contentHash\" text)
      JOIN git_sync_file_bindings b ON b.id=expected.\"bindingId\" AND b.repo_path=expected.\"repoPath\" AND b.content_hash=expected.\"contentHash\"
      WHERE b.profile_id=$2 AND b.workspace_id=$3 AND NOT b.tombstoned")
      .bind(serde_json::to_value(&work.plan.files).map_err(|_|stale())?).bind(profile).bind(workspace)
      .fetch_one(&self.pool).await.map_err(Self::storage)?;
    if count != work.plan.files.len() as i64 {
      return Err(stale());
    }
    if work.plan.undo.is_none() || work.plan.choice == WorkspaceContentGitSyncChoice::Move {
      let count:i64=sqlx::query_scalar("SELECT count(*) FROM jsonb_to_recordset($1) AS expected(\"targetBlobKey\" text,\"targetRepoPath\" text,source jsonb)
      JOIN git_sync_file_bindings b ON b.blob_key=expected.\"targetBlobKey\" AND b.repo_path=expected.\"targetRepoPath\"
        AND b.content_hash=expected.source->>'contentHash'
      WHERE b.profile_id=$2 AND b.workspace_id=$3 AND NOT b.tombstoned")
      .bind(serde_json::to_value(&work.plan.shared_files).map_err(|_|stale())?).bind(profile).bind(workspace)
      .fetch_one(&self.pool).await.map_err(Self::storage)?;
      if count != work.plan.shared_files.len() as i64 {
        return Err(stale());
      }
    }
    Ok(())
  }
  #[tracing::instrument(skip_all, fields(%operation_id))]
  pub async fn pending_extract_git_work(
    &self,
    operation_id: Uuid,
  ) -> AuthResult<Option<myoxus_application::workspace_content_operation::extract::WorkspaceContentExtractGitWork>> {
    let row = sqlx::query(
      "SELECT e.source_workspace_id,e.target_workspace_id,e.source_folder_id,
      COALESCE(e.git_sync_undo_plan,e.git_sync_plan) AS git_sync_plan,e.git_sync_prepared_oid,e.git_sync_prepared_hashes,r.request
      FROM workspace_content_extract_targets e JOIN workspace_content_operations o ON o.id=COALESCE(e.git_sync_undo_operation_id,e.operation_id)
      JOIN workspace_content_operation_requests r ON r.operation_id=e.operation_id
      WHERE o.id=$1 AND e.git_sync_pending AND NOT e.git_sync_retry_exhausted
        AND e.published_at IS NOT NULL AND o.status='succeeded'",
    )
    .bind(operation_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::storage)?;
    row
      .map(|row| {
        let request: WorkspaceContentOperationRequest =
          serde_json::from_value(row.get("request")).map_err(|_| stale())?;
        Ok(
          myoxus_application::workspace_content_operation::extract::WorkspaceContentExtractGitWork {
            operation_id,
            source_workspace_id: row.get("source_workspace_id"),
            target_workspace_id: row.get("target_workspace_id"),
            source_folder_id: row.get("source_folder_id"),
            target_name: request.extract_workspace_name.ok_or_else(stale)?,
            plan: serde_json::from_value(row.get("git_sync_plan")).map_err(|_| stale())?,
            prepared_oid: row.get("git_sync_prepared_oid"),
            prepared_hashes: row
              .get::<Option<serde_json::Value>, _>("git_sync_prepared_hashes")
              .map(serde_json::from_value)
              .transpose()
              .map_err(|_| stale())?
              .unwrap_or_default(),
          },
        )
      })
      .transpose()
  }

  #[tracing::instrument(skip_all, fields(%operation_id))]
  pub async fn prepare_extract_git_commit(
    &self,
    operation_id: Uuid,
    oid: &str,
    hashes: &BTreeMap<String, Option<String>>,
  ) -> AuthResult<()> {
    let changed = sqlx::query(
      "UPDATE workspace_content_extract_targets SET git_sync_prepared_oid=$2,git_sync_prepared_hashes=$3
      WHERE COALESCE(git_sync_undo_operation_id,operation_id)=$1 AND git_sync_pending AND NOT git_sync_retry_exhausted AND published_at IS NOT NULL",
    )
    .bind(operation_id)
    .bind(oid)
    .bind(serde_json::to_value(hashes).map_err(|_| stale())?)
    .execute(&self.pool)
    .await
    .map_err(Self::storage)?
    .rows_affected();
    if changed != 1 {
      return Err(stale());
    }
    Ok(())
  }

  /// The caller holds repository ownership through authenticated remote readback.
  /// Move re-enables its target in the same commit; Disconnect only acknowledges
  /// cleanup and must never create or activate a target profile.
  #[tracing::instrument(skip_all, fields(%operation_id))]
  pub async fn complete_extract_git_work(
    &self,
    operation_id: Uuid,
    prepared_oid: &str,
    body_hashes: &BTreeMap<Uuid, String>,
  ) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::storage)?;
    let row = sqlx::query(
      "SELECT COALESCE(git_sync_undo_plan,git_sync_plan) AS git_sync_plan,git_sync_prepared_oid,git_sync_pending,target_workspace_id
      FROM workspace_content_extract_targets WHERE COALESCE(git_sync_undo_operation_id,operation_id)=$1 FOR UPDATE",
    )
    .bind(operation_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::storage)?
    .ok_or_else(stale)?;
    if !row.get::<bool, _>("git_sync_pending") {
      return Ok(());
    }
    if row.get::<Option<String>, _>("git_sync_prepared_oid").as_deref() != Some(prepared_oid) {
      return Err(stale());
    }
    let plan: WorkspaceContentGitSyncPlan = serde_json::from_value(row.get("git_sync_plan")).map_err(|_| stale())?;
    let moving = plan.choice == WorkspaceContentGitSyncChoice::Move && plan.undo.is_none();
    if moving {
      let recorded: git_export::GitSyncManifest =
        serde_json::from_value(plan.manifest_inventory.clone().ok_or_else(stale)?).map_err(|_| stale())?;
      for document in &plan.documents {
        let emitted = body_hashes.get(&document.doc_id).ok_or_else(stale)?;
        let old = recorded
          .documents
          .iter()
          .find(|doc| doc.doc_id == document.doc_id)
          .ok_or_else(stale)?;
        let changed = sqlx::query(
          "UPDATE git_sync_bindings SET content_hash=$2,last_commit_oid=$3,updated_at=now()
        WHERE id=$1 AND profile_id=$4 AND doc_id=$5 AND sync_id=$6 AND repo_path=$7 AND NOT tombstone",
        )
        .bind(document.binding_id)
        .bind(emitted)
        .bind(prepared_oid)
        .bind(target_profile_id(operation_id))
        .bind(document.doc_id)
        .bind(document.sync_id)
        .bind(&document.repo_path)
        .execute(&mut *tx)
        .await
        .map_err(Self::storage)?
        .rows_affected();
        if changed != 1 {
          return Err(stale());
        }
        if emitted != &old.content_hash {
          sqlx::query(
            "UPDATE git_sync_baselines SET content_hash=$2,commit_oid=$3
          WHERE binding_id=$1 AND content_hash=$4",
          )
          .bind(document.binding_id)
          .bind(emitted)
          .bind(prepared_oid)
          .bind(&old.content_hash)
          .execute(&mut *tx)
          .await
          .map_err(Self::storage)?;
        }
      }
      for shared in &plan.shared_files {
        sqlx::query(
          "UPDATE git_sync_file_baselines SET commit_oid=$3,synced_at=now()
        WHERE profile_id=$1 AND blob_key=$2 AND content_hash=$4",
        )
        .bind(target_profile_id(operation_id))
        .bind(&shared.target_blob_key)
        .bind(prepared_oid)
        .bind(&shared.source.content_hash)
        .execute(&mut *tx)
        .await
        .map_err(Self::storage)?;
      }
    }
    sqlx::query(
      "UPDATE workspace_content_extract_targets SET git_sync_pending=false,git_sync_error_code=NULL,
      git_sync_retry_exhausted=false WHERE COALESCE(git_sync_undo_operation_id,operation_id)=$1",
    )
    .bind(operation_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::storage)?;
    if plan.undo.is_some() {
      super::git_undo::complete(&mut tx, &plan, prepared_oid, body_hashes).await?;
    }
    if moving {
      let changed =
        sqlx::query("UPDATE git_sync_profiles SET enabled=$2,updated_at=now() WHERE id=$1 AND workspace_id=$3")
          .bind(target_profile_id(operation_id))
          .bind(plan.intended_enabled)
          .bind(row.get::<Uuid, _>("target_workspace_id"))
          .execute(&mut *tx)
          .await
          .map_err(Self::storage)?
          .rows_affected();
      if changed != 1 {
        return Err(stale());
      }
    }
    tx.commit().await.map_err(Self::storage)
  }
}
