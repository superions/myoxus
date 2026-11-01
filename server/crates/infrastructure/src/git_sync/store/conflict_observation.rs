// SPDX-License-Identifier: AGPL-3.0-or-later
//! One insert/reuse rule for normal finalization and direct observations.

use super::*;
use sqlx::{Postgres, Transaction};

async fn lock_profile(tx: &mut Transaction<'_, Postgres>, id: Uuid) -> GitSyncResult<()> {
  sqlx::query_scalar::<_, Uuid>("SELECT id FROM git_sync_profiles WHERE id=$1 FOR UPDATE")
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(SqlxGitSyncStore::map_db_err)?
    .ok_or(GitSyncStoreError::NotFound)?;
  Ok(())
}

pub(super) async fn document(
  tx: &mut Transaction<'_, Postgres>,
  conflict: &GitSyncConflict,
) -> GitSyncResult<(GitSyncConflict, bool)> {
  // The profile row also serializes the empty-identity case. A unique index
  // alone cannot serialize the compare/dismiss/insert sequence for absent rows.
  lock_profile(tx, conflict.profile_id).await?;
  let mut insert_id = conflict.id;
  if conflict.resolution == ConflictResolution::Open {
    let existing = sqlx::query(
      "SELECT *,ROW(binding_id,repo_path,conflict_type,base_content,myoxus_content,git_content)
      IS NOT DISTINCT FROM ROW($3::uuid,$4::text,$5::text,$6::text,$7::text,$8::text) AS identical
      FROM git_sync_conflicts WHERE profile_id=$1 AND doc_id=$2 AND resolution='Open' FOR UPDATE",
    )
    .bind(conflict.profile_id)
    .bind(conflict.doc_id)
    .bind(conflict.binding_id)
    .bind(&conflict.repo_path)
    .bind(conflict.conflict_type.to_string())
    .bind(&conflict.base_content)
    .bind(&conflict.myoxus_content)
    .bind(&conflict.git_content)
    .fetch_optional(&mut **tx)
    .await
    .map_err(SqlxGitSyncStore::map_db_err)?;
    if let Some(row) = existing {
      if row.get::<bool, _>("identical") {
        return Ok((SqlxGitSyncStore::map_conflict_row(row)?, false));
      }
      insert_id = Uuid::new_v4();
      sqlx::query("UPDATE git_sync_conflicts SET resolution='Dismissed',resolved_at=now(),resolved_by=NULL WHERE id=$1 AND resolution='Open'")
        .bind(row.get::<Uuid,_>("id")).execute(&mut **tx).await.map_err(SqlxGitSyncStore::map_db_err)?;
    }
  }
  let row = sqlx::query(
    "INSERT INTO git_sync_conflicts
    (id,profile_id,binding_id,doc_id,repo_path,conflict_type,resolution,base_content,myoxus_content,git_content)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
  )
  .bind(insert_id)
  .bind(conflict.profile_id)
  .bind(conflict.binding_id)
  .bind(conflict.doc_id)
  .bind(&conflict.repo_path)
  .bind(conflict.conflict_type.to_string())
  .bind(conflict.resolution.to_string())
  .bind(&conflict.base_content)
  .bind(&conflict.myoxus_content)
  .bind(&conflict.git_content)
  .fetch_one(&mut **tx)
  .await
  .map_err(SqlxGitSyncStore::map_db_err)?;
  Ok((SqlxGitSyncStore::map_conflict_row(row)?, true))
}

pub(super) async fn file(
  tx: &mut Transaction<'_, Postgres>,
  conflict: &GitSyncFileConflict,
) -> GitSyncResult<(GitSyncFileConflict, bool)> {
  lock_profile(tx, conflict.profile_id).await?;
  let mut insert_id = conflict.id;
  if conflict.resolution == ConflictResolution::Open {
    // run_id is provenance, not input: recurring observations in later runs
    // keep the original decision and its still-live provenance reference.
    let existing = sqlx::query(
      "SELECT *,ROW(binding_id,blob_key,conflict_type,git_hash,myoxus_hash,baseline_hash)
      IS NOT DISTINCT FROM ROW($3::uuid,$4::text,$5::text,$6::text,$7::text,$8::text) AS identical
      FROM git_sync_file_conflicts WHERE profile_id=$1 AND repo_path=$2 AND resolution='Open' FOR UPDATE",
    )
    .bind(conflict.profile_id)
    .bind(&conflict.repo_path)
    .bind(conflict.binding_id)
    .bind(&conflict.blob_key)
    .bind(conflict.conflict_type.to_string())
    .bind(&conflict.git_hash)
    .bind(&conflict.myoxus_hash)
    .bind(&conflict.baseline_hash)
    .fetch_optional(&mut **tx)
    .await
    .map_err(SqlxGitSyncStore::map_db_err)?;
    if let Some(row) = existing {
      if row.get::<bool, _>("identical") {
        return Ok((SqlxGitSyncStore::map_file_conflict_row(row)?, false));
      }
      insert_id = Uuid::new_v4();
      sqlx::query("UPDATE git_sync_file_conflicts SET resolution='Dismissed',resolved_at=now(),resolved_by=NULL WHERE id=$1 AND resolution='Open'")
        .bind(row.get::<Uuid,_>("id")).execute(&mut **tx).await.map_err(SqlxGitSyncStore::map_db_err)?;
    }
  }
  let row = sqlx::query(
    "INSERT INTO git_sync_file_conflicts
    (id,profile_id,run_id,repo_path,conflict_type,resolution,git_hash,myoxus_hash,baseline_hash,binding_id,blob_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
  )
  .bind(insert_id)
  .bind(conflict.profile_id)
  .bind(conflict.run_id)
  .bind(&conflict.repo_path)
  .bind(conflict.conflict_type.to_string())
  .bind(conflict.resolution.to_string())
  .bind(&conflict.git_hash)
  .bind(&conflict.myoxus_hash)
  .bind(&conflict.baseline_hash)
  .bind(conflict.binding_id)
  .bind(&conflict.blob_key)
  .fetch_one(&mut **tx)
  .await
  .map_err(SqlxGitSyncStore::map_db_err)?;
  Ok((SqlxGitSyncStore::map_file_conflict_row(row)?, true))
}
