// SPDX-License-Identifier: AGPL-3.0-or-later
//! One native admission implementation for manual and shared-clock entry. The
//! latter adds its frozen slot/outbox in the same transaction, without exposing
//! credential material to the shared adapter.
use super::*;
use crate::scheduling::git_rotation::{RotationFence, lock_fence_in, record_in};
use myoxus_application::git_sync::GitTokenRotationAttempt;

impl SqlxGitSyncStore {
  #[tracing::instrument(skip_all,fields(%credential_id))]
  pub async fn admit_rotation_slot(
    &self,
    credential_id: Uuid,
    generation: i64,
    revision: i64,
    now: chrono::DateTime<chrono::Utc>,
    providers: &[GitTokenRotationProviderKind],
  ) -> Result<Option<GitTokenRotationAttempt>, GitTokenRotationStoreError> {
    let profile: Option<Uuid> = sqlx::query_scalar("SELECT profile_id FROM git_sync_credentials WHERE id=$1")
      .bind(credential_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(map_token_rotation_db_error)?;
    let Some(profile) = profile else { return Ok(None) };
    Ok(
      self
        .admit_rotation_owned(
          profile,
          now,
          false,
          Some(RotationFence {
            credential_id,
            generation,
            revision,
          }),
          Some(providers),
        )
        .await?
        .map(|admission| GitTokenRotationAttempt {
          profile_id: admission.profile_id,
          attempt_id: admission.attempt_id,
        }),
    )
  }

  pub(super) async fn admit_rotation_owned(
    &self,
    requested_profile_id: Uuid,
    now: chrono::DateTime<chrono::Utc>,
    force: bool,
    fence: Option<RotationFence>,
    providers: Option<&[GitTokenRotationProviderKind]>,
  ) -> Result<Option<GitTokenRotationAdmission>, GitTokenRotationStoreError> {
    let mut tx = self.pool.begin().await.map_err(map_token_rotation_db_error)?;
    if !lock_credential_dependents(&mut tx, requested_profile_id)
      .await
      .map_err(map_token_rotation_db_error)?
    {
      return Err(GitTokenRotationStoreError::Conflict);
    }
    let credential_id: Uuid =
      sqlx::query_scalar::<_, Option<Uuid>>("SELECT credential_id FROM git_sync_profiles WHERE id=$1")
        .bind(requested_profile_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_token_rotation_db_error)?
        .ok_or(GitTokenRotationStoreError::NotFound)?
        .ok_or(GitTokenRotationStoreError::IncompatibleProfile)?;
    let nominal = if let Some(fence) = fence {
      if fence.credential_id != credential_id {
        return Ok(None);
      }
      let steward: Uuid = sqlx::query_scalar("SELECT profile_id FROM git_sync_credentials WHERE id=$1 FOR UPDATE")
        .bind(credential_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(map_token_rotation_db_error)?;
      sqlx::query("SELECT profile_id FROM git_token_rotation WHERE profile_id=$1 FOR UPDATE")
        .bind(steward)
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_token_rotation_db_error)?
        .ok_or(GitTokenRotationStoreError::NotFound)?;
      let due = lock_fence_in(&mut tx, fence, now)
        .await
        .map_err(|_| GitTokenRotationStoreError::Storage("rotation timing fence unavailable".into()))?;
      let Some(due) = due else { return Ok(None) };
      Some(due)
    } else {
      None
    };
    let profile_id = rotation_steward_in_transaction(&mut tx, credential_id)
      .await?
      .ok_or(GitTokenRotationStoreError::IncompatibleProfile)?;
    let profile = sqlx::query(
      "SELECT workspace_id,repo_url,auth_method,credential_id,enabled FROM git_sync_profiles WHERE id=$1 FOR UPDATE",
    )
    .bind(profile_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(map_token_rotation_db_error)?
    .ok_or(GitTokenRotationStoreError::NotFound)?;
    let rotation=sqlx::query("SELECT provider,enabled,renew_before_days,requested_lifetime_days,state,last_attempt_at FROM git_token_rotation WHERE profile_id=$1 FOR UPDATE")
      .bind(profile_id).fetch_optional(&mut *tx).await.map_err(map_token_rotation_db_error)?.ok_or(GitTokenRotationStoreError::NotFound)?;
    if !rotation.get::<bool, _>("enabled") {
      tx.commit().await.map_err(map_token_rotation_db_error)?;
      return Ok(None);
    }
    let state = parse_token_rotation_state(rotation.get("state"))?;
    if state == GitTokenRotationState::Rotating {
      return Err(GitTokenRotationStoreError::RotationInProgress);
    }
    if state == GitTokenRotationState::ManualIntervention {
      tx.commit().await.map_err(map_token_rotation_db_error)?;
      return Ok(None);
    }
    let last_attempt_at = rotation.get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_attempt_at");
    if state == GitTokenRotationState::Failed
      && last_attempt_at.is_some_and(|last| last.date_naive() >= now.date_naive())
    {
      tx.commit().await.map_err(map_token_rotation_db_error)?;
      return Ok(None);
    }
    if profile.get::<Option<Uuid>, _>("credential_id") != Some(credential_id) {
      return Err(GitTokenRotationStoreError::Conflict);
    }
    if !profile.get::<bool, _>("enabled")
      || profile.get::<String, _>("auth_method") != "HttpsToken"
      || !is_https_repository(&profile.get::<String, _>("repo_url"))
    {
      return Err(GitTokenRotationStoreError::IncompatibleProfile);
    }
    let credential =
      sqlx::query("SELECT label,encrypted_data,expires_at FROM git_sync_credentials WHERE id=$1 AND profile_id=$2")
        .bind(credential_id)
        .bind(profile_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(map_token_rotation_db_error)?
        .ok_or(GitTokenRotationStoreError::IncompatibleProfile)?;
    let expires_at = credential
      .get::<Option<chrono::DateTime<chrono::Utc>>, _>("expires_at")
      .ok_or(GitTokenRotationStoreError::IncompatibleProfile)?;
    let due_at = expires_at - chrono::Duration::days(i64::from(rotation.get::<i32, _>("renew_before_days")));
    if !force && due_at > now {
      tx.commit().await.map_err(map_token_rotation_db_error)?;
      return Ok(None);
    }
    let unfinished:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM git_sync_runs WHERE profile_id IN(SELECT id FROM git_sync_profiles WHERE credential_id=$1) AND status IN('Pending','Running')) OR EXISTS(SELECT 1 FROM workspace_content_operations o WHERE (o.status NOT IN('succeeded','cancelled','failed') OR (o.status<>'succeeded' AND (EXISTS(SELECT 1 FROM workspace_content_operation_staging s WHERE s.operation_id=o.id AND s.publication_status IN('staged','cleanup_required')) OR EXISTS(SELECT 1 FROM workspace_content_operation_compensations c WHERE c.operation_id=o.id AND c.completed_at IS NULL) OR EXISTS(SELECT 1 FROM workspace_content_extract_targets e WHERE e.operation_id=o.id AND e.published_at IS NULL)))) AND (o.source_workspace_id IN(SELECT workspace_id FROM git_sync_profiles WHERE credential_id=$1) OR o.target_workspace_id IN(SELECT workspace_id FROM git_sync_profiles WHERE credential_id=$1)))")
      .bind(credential_id).fetch_one(&mut *tx).await.map_err(map_token_rotation_db_error)?;
    if unfinished {
      return Err(GitTokenRotationStoreError::UnfinishedRun);
    }
    let attempt_id = Uuid::new_v4();
    sqlx::query("UPDATE git_token_rotation SET state='Rotating',latest_attempt_id=$2,admitted_credential_id=$3,last_attempt_at=$4,diagnosis=NULL,updated_at=$4 WHERE profile_id=$1")
      .bind(profile_id).bind(attempt_id).bind(credential_id).bind(now).execute(&mut *tx).await.map_err(map_token_rotation_db_error)?;
    let provider = parse_token_rotation_provider(rotation.get("provider"))?;
    let available = providers.is_none_or(|providers| providers.contains(&provider));
    if !available {
      // Preserve the native pre-request failure and next-UTC-day policy when
      // an installed definition no longer has its concrete provider adapter.
      sqlx::query("UPDATE git_token_rotation SET state='Failed',diagnosis='configured token rotation provider is not available',updated_at=$3 WHERE profile_id=$1 AND latest_attempt_id=$2")
        .bind(profile_id).bind(attempt_id).bind(now).execute(&mut *tx).await.map_err(map_token_rotation_db_error)?;
    }
    if let (Some(fence), Some(due)) = (fence, nominal) {
      record_in(
        &mut tx,
        fence,
        due,
        GitTokenRotationAttempt { profile_id, attempt_id },
        available,
      )
      .await
      .map_err(|_| GitTokenRotationStoreError::Storage("rotation scheduling receipt unavailable".into()))?;
    }
    tx.commit().await.map_err(map_token_rotation_db_error)?;
    let requested_lifetime_days = u16::try_from(rotation.get::<i32, _>("requested_lifetime_days"))
      .map_err(|_| GitTokenRotationStoreError::Storage("invalid persisted requested lifetime".into()))?;
    Ok(Some(GitTokenRotationAdmission {
      profile_id,
      workspace_id: profile.get("workspace_id"),
      repository_url: profile.get("repo_url"),
      provider,
      attempt_id,
      credential_id,
      credential_label: credential.get("label"),
      encrypted_credential: credential.get("encrypted_data"),
      requested_expires_at: requested_expiry(now, requested_lifetime_days)?,
    }))
  }
}
