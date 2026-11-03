// SPDX-License-Identifier: AGPL-3.0-or-later
//! Receipt-owned inverse of Extract's Git scope, on the existing counter-Move.

use super::*;
use myoxus_application::workspace_content_operation::WorkspaceContentGitSyncUndo;

fn denied(code: WorkspaceContentErrorCode) -> AuthError {
  AuthError::InvalidInput(code.as_str().into())
}
fn ownership() -> AuthError {
  denied(WorkspaceContentErrorCode::GitSyncUndoOwnershipChanged)
}
fn content() -> AuthError {
  denied(WorkspaceContentErrorCode::GitSyncUndoContentChanged)
}

pub(super) async fn prepare(
  pool: &PgPool,
  capture: Option<&dyn WorkspaceContentGitSyncCapturePort>,
  actor: Uuid,
  origin: Uuid,
  request: &WorkspaceContentOperationRequest,
  input: &WorkspaceContentGraphInput,
) -> AuthResult<Option<WorkspaceContentGitSyncPlan>> {
  let row=sqlx::query("SELECT git_sync_plan,git_sync_pending,git_sync_prepared_hashes,git_sync_undo_operation_id,
    source_workspace_id,target_workspace_id,source_folder_id FROM workspace_content_extract_targets WHERE operation_id=$1 AND published_at IS NOT NULL")
    .bind(origin).fetch_optional(pool).await.map_err(PgWorkspaceContentOperationRepository::storage)?;
  let Some(row) = row else {
    return Ok(None);
  };
  let Some(value) = row.get::<Option<serde_json::Value>, _>("git_sync_plan") else {
    return Ok(None);
  };
  if row.get::<bool, _>("git_sync_pending") {
    return Err(denied(WorkspaceContentErrorCode::GitSyncUndoPending));
  }
  if row.get::<Option<Uuid>, _>("git_sync_undo_operation_id").is_some()
    || request.kind != WorkspaceContentOperationKind::Move
    || request.source_workspace_id != row.get::<Uuid, _>("target_workspace_id")
    || request.target_workspace_id != row.get::<Uuid, _>("source_workspace_id")
  {
    return Err(ownership());
  }
  let mut plan: WorkspaceContentGitSyncPlan = serde_json::from_value(value).map_err(|_| ownership())?;
  let mappings = sqlx::query(
    "SELECT source_workspace_id,source_kind,source_id,target_workspace_id,target_kind,target_id
    FROM workspace_content_operation_mappings WHERE operation_id=$1",
  )
  .bind(origin)
  .fetch_all(pool)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?
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
    .map_err(|_| ownership())
  })
  .collect::<AuthResult<Vec<_>>>()?;
  let admitted = mappings
    .iter()
    .map(|mapping| mapping.target.clone())
    .collect::<BTreeSet<_>>();
  if input.resources.iter().any(|resource| {
    resource.resource.workspace_id() == request.source_workspace_id
      && matches!(
        resource.resource.kind(),
        WorkspaceContentResourceKind::Document
          | WorkspaceContentResourceKind::Folder
          | WorkspaceContentResourceKind::Database
      )
      && !admitted.contains(&resource.resource)
  }) {
    return Err(denied(WorkspaceContentErrorCode::GitSyncUndoTargetNotEmpty));
  }
  let document_keys = mappings
    .iter()
    .filter(|mapping| mapping.target.kind() == WorkspaceContentResourceKind::Document)
    .map(|mapping| mapping.target.resource_id().to_owned())
    .collect::<Vec<_>>();
  let independent: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM docs WHERE workspace_id=$1 AND NOT is_workspace_root
    AND external_id NOT LIKE 'db$%' AND NOT external_id=ANY($2))",
  )
  .bind(request.source_workspace_id)
  .bind(document_keys)
  .fetch_one(pool)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if independent {
    return Err(denied(WorkspaceContentErrorCode::GitSyncUndoTargetNotEmpty));
  }
  let store = SqlxGitSyncStore::new(pool.clone());
  let source = store
    .get_profile(plan.source_profile_id)
    .await
    .map_err(|_| ownership())?;
  let original_baselines = plan
    .documents
    .iter()
    .filter_map(|document| document.baseline_hash.clone().map(|hash| (document.binding_id, hash)))
    .collect();
  let moving = plan.choice == WorkspaceContentGitSyncChoice::Move;
  let binding_profile = if moving {
    git_handoff::target_profile_id(origin)
  } else {
    plan.source_profile_id
  };
  for document in &mut plan.documents {
    let binding = sqlx::query(
      "SELECT b.content_hash,baseline.content_hash AS baseline_hash FROM git_sync_bindings b
      LEFT JOIN git_sync_baselines baseline ON baseline.binding_id=b.id WHERE b.id=$1 AND b.profile_id=$2
      AND b.doc_id=$3 AND b.sync_id=$4 AND b.repo_path=$5 AND b.tombstone=$6",
    )
    .bind(document.binding_id)
    .bind(binding_profile)
    .bind(document.doc_id)
    .bind(document.sync_id)
    .bind(&document.repo_path)
    .bind(!moving)
    .fetch_optional(pool)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .ok_or_else(ownership)?;
    document.content_hash = binding.get("content_hash");
    document.baseline_hash = binding.get("baseline_hash");
  }
  if moving {
    let bindings: i64 = sqlx::query_scalar(
      "SELECT (SELECT count(*) FROM git_sync_bindings WHERE profile_id=$1 AND NOT tombstone)
      + (SELECT count(*) FROM git_sync_file_bindings WHERE profile_id=$1 AND NOT tombstoned)",
    )
    .bind(binding_profile)
    .fetch_one(pool)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
    if bindings != (plan.documents.len() + plan.files.len() + plan.shared_files.len()) as i64 {
      return Err(ownership());
    }
  }
  let target_revision = if plan.choice == WorkspaceContentGitSyncChoice::Move {
    Some(
      store
        .get_profile(git_handoff::target_profile_id(origin))
        .await
        .map_err(|_| ownership())?
        .scope_revision,
    )
  } else {
    None
  };
  plan.undo = Some(WorkspaceContentGitSyncUndo {
    origin_operation_id: origin,
    original_oid: plan.remote_oid.clone().ok_or_else(content)?,
    source_scope_revision: plan.source_scope_revision + 1,
    target_scope_revision: target_revision,
    expected_hashes: BTreeMap::new(),
    original_baselines,
    baseline_observed_before: plan.source_profile_updated_at,
  });
  let mut connection = pool
    .acquire()
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  validate_scopes(
    &mut connection,
    &plan,
    request.source_workspace_id,
    request.target_workspace_id,
    false,
  )
  .await?;
  drop(connection);
  let prefix = format!("{}/", plan.target_root);
  let delegated = |path: &str| {
    plan.delegated_descendants.iter().any(|fence| {
      path == fence.repo_path || (fence.is_directory && path.starts_with(&format!("{}/", fence.repo_path)))
    })
  };
  let prepared: BTreeMap<String, Option<String>> = row
    .get::<Option<serde_json::Value>, _>("git_sync_prepared_hashes")
    .map(serde_json::from_value)
    .transpose()
    .map_err(|_| content())?
    .unwrap_or_default();
  let mut expected = if plan.choice == WorkspaceContentGitSyncChoice::Move {
    prepared.clone()
  } else {
    plan
      .observed_hashes
      .iter()
      .filter(|(path, _)| path.starts_with(&prefix) && !delegated(path))
      .map(|(path, hash)| (path.clone(), Some(hash.clone())))
      .collect()
  };
  if plan.choice == WorkspaceContentGitSyncChoice::Disconnect {
    expected.extend(prepared);
  }
  if expected.is_empty() {
    return Err(content());
  }
  let folder: String = row.get("source_folder_id");
  let capture = capture.ok_or_else(content)?;
  let inventory = capture
    .capture(actor, &source, &folder, &[])
    .await?
    .filter(|capture| capture.remote_verified)
    .ok_or_else(content)?;
  if inventory
    .observed_paths
    .iter()
    .any(|path| path.starts_with(&prefix) && !delegated(path) && !expected.contains_key(path))
  {
    return Err(content());
  }
  let paths = expected
    .keys()
    .filter(|path| inventory.observed_paths.contains(*path))
    .cloned()
    .collect::<Vec<_>>();
  let current = capture
    .capture(actor, &source, &folder, &paths)
    .await?
    .filter(|capture| capture.remote_verified && capture.head_oid == inventory.head_oid)
    .ok_or_else(content)?;
  for (path, hash) in &expected {
    if current.path_hashes.get(path) != hash.as_ref() {
      return Err(content());
    }
  }
  for file in &mut plan.files {
    file.blob_key = mappings
      .iter()
      .find(|mapping| {
        mapping.source.kind() == WorkspaceContentResourceKind::Blob && mapping.source.resource_id() == file.blob_key
      })
      .map(|mapping| mapping.target.resource_id().to_owned())
      .ok_or_else(ownership)?;
  }
  plan.undo.as_mut().ok_or_else(ownership)?.expected_hashes = std::mem::take(&mut expected);
  plan.remote_oid = Some(current.head_oid);
  plan.source_profile_updated_at = source.updated_at;
  Ok(Some(plan))
}

/// Used again while publication holds both profile rows. Credential pointer
/// changes are deliberately not compared: current pointers are never restored.
pub(super) async fn validate_scopes(
  connection: &mut sqlx::PgConnection,
  plan: &WorkspaceContentGitSyncPlan,
  extracted: Uuid,
  original: Uuid,
  published: bool,
) -> AuthResult<()> {
  let undo = plan.undo.as_ref().ok_or_else(ownership)?;
  let source=sqlx::query("SELECT workspace_id,owner_id,repo_url,branch,root_path,manifest_path,scope_revision FROM git_sync_profiles WHERE id=$1")
    .bind(plan.source_profile_id).fetch_optional(&mut *connection).await.map_err(PgWorkspaceContentOperationRepository::storage)?.ok_or_else(ownership)?;
  if source.get::<Uuid, _>("workspace_id") != original
    || source.get::<Uuid, _>("owner_id") != plan.source_profile_owner_id
    || source.get::<String, _>("repo_url") != plan.repository
    || source.get::<String, _>("branch") != plan.branch
    || source.get::<String, _>("root_path") != plan.source_root
    || source.get::<String, _>("manifest_path") != plan.source_manifest
    || source.get::<i64, _>("scope_revision") != undo.source_scope_revision
  {
    return Err(ownership());
  }
  let destination = if plan.choice == WorkspaceContentGitSyncChoice::Move {
    Some(git_handoff::target_profile_id(undo.origin_operation_id))
  } else {
    None
  };
  let fence:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM git_sync_scope_exclusions WHERE profile_id=$1 AND repo_path=$2
    AND is_directory AND destination_profile_id IS NOT DISTINCT FROM $3 AND originating_operation_id=$4 AND scope_revision=$5)")
    .bind(plan.source_profile_id).bind(&plan.target_root).bind(destination).bind(undo.origin_operation_id).bind(undo.source_scope_revision)
    .fetch_one(&mut *connection).await.map_err(PgWorkspaceContentOperationRepository::storage)?;
  if !fence {
    return Err(ownership());
  }
  if let Some(target) = destination {
    let target = sqlx::query("SELECT p.*,to_jsonb(p) AS profile FROM git_sync_profiles p WHERE id=$1")
      .bind(target)
      .fetch_optional(&mut *connection)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?
      .ok_or_else(ownership)?;
    if target.get::<Uuid, _>("workspace_id") != extracted
      || target.get::<Uuid, _>("owner_id") != plan.source_profile_owner_id
      || target.get::<String, _>("repo_url") != plan.repository
      || target.get::<String, _>("branch") != plan.branch
      || target.get::<String, _>("root_path") != plan.target_root
      || target.get::<String, _>("manifest_path") != plan.target_manifest
      || Some(target.get::<i64, _>("scope_revision")) != undo.target_scope_revision
      || undo.target_scope_revision != Some(1)
    {
      return Err(ownership());
    }
    let mut profile: myoxus_domain::git_sync::GitSyncProfile =
      serde_json::from_value(target.get("profile")).map_err(|_| ownership())?;
    if published {
      profile.enabled = plan.intended_enabled;
    }
    if plan.target_configuration.as_ref()
      != Some(&myoxus_application::workspace_content_operation::extract_git_profile_configuration(&profile))
    {
      return Err(ownership());
    }
  }
  let ids = vec![plan.source_profile_id, destination.unwrap_or(plan.source_profile_id)];
  let busy:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM git_sync_runs WHERE profile_id=ANY($1) AND (status IN ('Pending','Running') OR reconciliation_required))
    OR EXISTS(SELECT 1 FROM git_sync_partial_sessions WHERE profile_id=ANY($1) AND status='Open')
    OR EXISTS(SELECT 1 FROM git_sync_bootstrap_attempts WHERE profile_id=ANY($1) AND phase IN ('Prepared','RemoteApplied'))
    OR EXISTS(SELECT 1 FROM git_sync_profiles p JOIN git_sync_credentials c ON c.id=p.credential_id
      JOIN git_token_rotation r ON r.profile_id=c.profile_id WHERE p.id=ANY($1) AND r.state='Rotating')
    OR EXISTS(SELECT 1 FROM git_sync_conflicts WHERE profile_id=ANY($1) AND resolution='Open'
      AND (profile_id=$2 OR doc_id=ANY($3)))
    OR EXISTS(SELECT 1 FROM git_sync_file_conflicts WHERE profile_id=ANY($1) AND resolution='Open'
      AND (profile_id=$2 OR left(repo_path,length($4))=$4))")
    .bind(&ids).bind(destination.unwrap_or(Uuid::nil()))
    .bind(plan.documents.iter().map(|document|document.doc_id).collect::<Vec<_>>()).bind(format!("{}/",plan.target_root))
    .fetch_one(&mut *connection).await.map_err(PgWorkspaceContentOperationRepository::storage)?;
  if busy {
    return Err(denied(WorkspaceContentErrorCode::GitSyncUndoPending));
  }
  Ok(())
}

pub(super) async fn publish(
  tx: &mut Transaction<'_, Postgres>,
  operation: &WorkspaceContentOperationRecord,
  mappings: &[WorkspaceContentIdMapping],
) -> AuthResult<()> {
  let value: Option<serde_json::Value> =
    sqlx::query_scalar("SELECT git_sync_undo_plan FROM workspace_content_operation_requests WHERE operation_id=$1")
      .bind(operation.id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?
      .flatten();
  let Some(value) = value else {
    let git_origin:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_content_operation_requests r
      JOIN workspace_content_extract_targets e ON e.operation_id=r.origin_operation_id WHERE r.operation_id=$1 AND e.git_sync_plan IS NOT NULL)")
      .bind(operation.id).fetch_one(&mut **tx).await.map_err(PgWorkspaceContentOperationRepository::storage)?;
    return if git_origin { Err(ownership()) } else { Ok(()) };
  };
  let mut plan: WorkspaceContentGitSyncPlan = serde_json::from_value(value).map_err(|_| ownership())?;
  let undo = plan.undo.clone().ok_or_else(ownership)?;
  let original = operation.target_workspace_id.ok_or_else(ownership)?;
  validate_scopes(tx, &plan, operation.source_workspace_id, original, false).await?;
  let ready: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM workspace_content_extract_targets
    WHERE operation_id=$1 AND NOT git_sync_pending AND git_sync_undo_operation_id IS NULL)",
  )
  .bind(undo.origin_operation_id)
  .fetch_one(&mut **tx)
  .await
  .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if !ready {
    return Err(denied(WorkspaceContentErrorCode::GitSyncUndoPending));
  }
  let moving = plan.choice == WorkspaceContentGitSyncChoice::Move;
  let child = git_handoff::target_profile_id(undo.origin_operation_id);
  if moving {
    let previous = SqlxGitSyncStore::profile_in(&mut **tx, child)
      .await
      .map_err(|_| AuthError::Storage("Git Cron target projection unavailable".into()))?;
    let mut updated = previous.clone();
    updated.enabled = false;
    sqlx::query("UPDATE git_sync_profiles SET enabled=false,updated_at=now() WHERE id=$1")
      .bind(child)
      .execute(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    SqlxGitSyncStore::write_schedules_in(&mut **tx, Some(&previous), &updated)
      .await
      .map_err(|_| AuthError::Storage("Git Cron target suspension unavailable".into()))?;
  }
  for document in &plan.documents {
    let changed = sqlx::query(
      "UPDATE git_sync_bindings SET profile_id=$2,workspace_id=$3,tombstone=false,updated_at=now()
      WHERE id=$1 AND profile_id=$4 AND doc_id=$5 AND sync_id=$6 AND repo_path=$7 AND tombstone=$8
        AND content_hash IS NOT DISTINCT FROM $9
        AND (SELECT content_hash FROM git_sync_baselines WHERE binding_id=$1) IS NOT DISTINCT FROM $10",
    )
    .bind(document.binding_id)
    .bind(plan.source_profile_id)
    .bind(original)
    .bind(if moving { child } else { plan.source_profile_id })
    .bind(document.doc_id)
    .bind(document.sync_id)
    .bind(&document.repo_path)
    .bind(!moving)
    .bind(&document.content_hash)
    .bind(&document.baseline_hash)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .rows_affected();
    if changed != 1 {
      return Err(ownership());
    }
  }
  let source_profile = plan.source_profile_id;
  let mut files = plan
    .files
    .iter_mut()
    .map(|file| (file.binding_id, &mut file.blob_key, &file.repo_path, &file.content_hash))
    .collect::<Vec<_>>();
  if moving {
    files.extend(plan.shared_files.iter_mut().map(|file| {
      (
        Uuid::new_v5(&undo.origin_operation_id, file.source.binding_id.as_bytes()),
        &mut file.target_blob_key,
        &file.target_repo_path,
        &file.source.content_hash,
      )
    }));
  }
  for (id, key, path, hash) in files {
    let target_key = mappings
      .iter()
      .find(|mapping| {
        mapping.source.kind() == WorkspaceContentResourceKind::Blob && mapping.source.resource_id() == *key
      })
      .map(|mapping| mapping.target.resource_id())
      .ok_or_else(ownership)?;
    let old_key = key.clone();
    let changed = sqlx::query(
      "UPDATE git_sync_file_bindings SET profile_id=$2,workspace_id=$3,blob_key=$4,tombstoned=false,updated_at=now()
      WHERE id=$1 AND profile_id=$5 AND repo_path=$6 AND content_hash=$7 AND tombstoned=$8",
    )
    .bind(id)
    .bind(source_profile)
    .bind(original)
    .bind(target_key)
    .bind(if moving { child } else { source_profile })
    .bind(path)
    .bind(hash)
    .bind(!moving)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .rows_affected();
    if changed != 1 {
      return Err(ownership());
    }
    if moving {
      sqlx::query(
        "INSERT INTO git_sync_file_baselines (profile_id,blob_key,content_hash,commit_oid)
        SELECT $2,$3,content_hash,commit_oid FROM git_sync_file_baselines WHERE profile_id=$1 AND blob_key=$4
        ON CONFLICT (profile_id,blob_key) DO NOTHING",
      )
      .bind(child)
      .bind(source_profile)
      .bind(target_key)
      .bind(&old_key)
      .execute(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
      sqlx::query("DELETE FROM git_sync_file_baselines WHERE profile_id=$1 AND blob_key=$2")
        .bind(child)
        .bind(&old_key)
        .execute(&mut **tx)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?;
    }
    *key = target_key.to_owned();
  }
  sqlx::query("UPDATE workspace_content_extract_targets SET git_sync_undo_operation_id=$2,git_sync_undo_plan=$3,
    git_sync_pending=true,git_sync_error_code=NULL,git_sync_retry_exhausted=false,git_sync_prepared_oid=NULL,git_sync_prepared_hashes=NULL
    WHERE operation_id=$1")
    .bind(undo.origin_operation_id).bind(operation.id).bind(serde_json::to_value(plan).map_err(|_|ownership())?)
    .execute(&mut **tx).await.map_err(PgWorkspaceContentOperationRepository::storage)?;
  Ok(())
}

pub(super) async fn complete(
  tx: &mut Transaction<'_, Postgres>,
  plan: &WorkspaceContentGitSyncPlan,
  oid: &str,
  bodies: &BTreeMap<Uuid, String>,
) -> AuthResult<()> {
  let undo = plan.undo.as_ref().ok_or_else(ownership)?;
  for document in &plan.documents {
    let hash = bodies.get(&document.doc_id).ok_or_else(content)?;
    let changed=sqlx::query("UPDATE git_sync_bindings SET content_hash=$2,last_commit_oid=$3,updated_at=now() WHERE id=$1 AND profile_id=$4 AND NOT tombstone")
      .bind(document.binding_id).bind(hash).bind(oid).bind(plan.source_profile_id).execute(&mut **tx).await.map_err(PgWorkspaceContentOperationRepository::storage)?.rows_affected();
    if changed != 1 {
      return Err(ownership());
    }
    // Git bytes and the normalized Myoxus baseline are different contracts.
    // Metadata readback must not acknowledge intervening local document edits.
    sqlx::query("UPDATE git_sync_baselines SET commit_oid=$2 WHERE binding_id=$1")
      .bind(document.binding_id)
      .bind(oid)
      .execute(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    if plan.choice == WorkspaceContentGitSyncChoice::Disconnect
      && let Some(original) = undo.original_baselines.get(&document.binding_id)
    {
      sqlx::query(
        "INSERT INTO git_sync_baselines (binding_id,content_hash,commit_oid,myoxus_updated_at) VALUES ($1,$2,$3,$4)
        ON CONFLICT(binding_id) DO NOTHING",
      )
      .bind(document.binding_id)
      .bind(original)
      .bind(oid)
      .bind(undo.baseline_observed_before)
      .execute(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    }
  }
  let changed=sqlx::query("DELETE FROM git_sync_scope_exclusions WHERE profile_id=$1 AND repo_path=$2 AND originating_operation_id=$3 AND scope_revision=$4")
    .bind(plan.source_profile_id).bind(&plan.target_root).bind(undo.origin_operation_id).bind(undo.source_scope_revision)
    .execute(&mut **tx).await.map_err(PgWorkspaceContentOperationRepository::storage)?.rows_affected();
  if changed != 1 {
    return Err(ownership());
  }
  sqlx::query("UPDATE git_sync_profiles SET scope_revision=scope_revision+1,updated_at=now() WHERE id=$1")
    .bind(plan.source_profile_id)
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?;
  if plan.choice == WorkspaceContentGitSyncChoice::Move {
    let child = git_handoff::target_profile_id(undo.origin_operation_id);
    crate::git_sync::store::rehome_credentials_before_profile_deletion(tx, &[child])
      .await
      .map_err(|_| ownership())?;
    sqlx::query("DELETE FROM git_sync_profiles WHERE id=$1")
      .bind(child)
      .execute(&mut **tx)
      .await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
  }
  Ok(())
}
