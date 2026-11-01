//! SQLx-backed authentication store implementation.
//!
//! [`SqlxAuthStore`] implements the [`AuthStore`] port from `myoxus-application`
//! against a PostgreSQL database via SQLx. It manages users, sessions, access
//! tokens, OAuth connected accounts, magic-link OTPs, and email verification
//! tokens.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_application::auth::{
  AccessToken, AssistanceProjectFacts, AuthCapabilityAccountState, AuthError, AuthResult, AuthSession, AuthStore,
  AuthUser, AuthUserProjection, ConnectedAccount, EffectiveAssistance, EmailChangeCommit, HistoricalUserProfile,
  MagicLinkOtp, NewAccessToken, NewConnectedAccount, NewSession, PasswordResetCommit, SessionGroupLink,
  SessionRevocationBarrier, SessionRevocationCommit, SessionRevocationTarget, UpdateAuthUser, UserAdminRoleCommit,
  UserDeletionCommit, UserPreferences, UserPreferencesPatch, UserPreferencesRecord, UserSuspensionCommit,
  VerificationToken,
};
use myoxus_application::organization::UserEmailLookup;
use myoxus_domain::repositories::{RepoResult, RepositoryError};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use tracing::instrument;
use uuid::Uuid;

/// Stable, content-free rejection shared by the narrowly scoped SQL guards.
pub(crate) fn is_terminal_account_error(error: &sqlx::Error) -> bool {
  error
    .as_database_error()
    .is_some_and(|e| e.constraint() == Some("account_reference_not_operational"))
}

/// PostgreSQL-backed implementation of [`AuthStore`].
#[derive(Debug, Clone)]
pub struct SqlxAuthStore {
  /// Database connection pool.
  pool: PgPool,
}

impl SqlxAuthStore {
  /// Open a new connection pool at `database_url` and return a store backed
  /// by it.
  ///
  /// **Deprecated**: Uses SQLx defaults (10 connections, 30s timeout). In
  /// production, use `PgPoolOptions` with explicit limits and pass the pool
  /// to `from_pool` instead. See [LRN-20260311-098].
  #[deprecated(note = "Use PgPoolOptions with explicit limits + SqlxAuthStore::from_pool() instead")]
  #[instrument(skip_all)]
  pub async fn connect(database_url: &str) -> Result<Self, sqlx::Error> {
    let pool = PgPool::connect(database_url).await?;
    Ok(Self { pool })
  }

  /// Wrap an existing pool without opening additional connections.
  pub fn from_pool(pool: PgPool) -> Self {
    Self { pool }
  }

  async fn fulfill_in_transaction(
    connection: &mut sqlx::PgConnection,
    email: &str,
    name: Option<&str>,
    avatar_url: Option<&str>,
  ) -> AuthResult<AuthUser> {
    myoxus_application::auth::validate_email(email)?;
    let row = sqlx::query(
      r#"
      INSERT INTO users (email, name, avatar_key)
      VALUES (lower($1), COALESCE($2, ''), $3)
      ON CONFLICT (lower(email)) DO UPDATE SET
        name = COALESCE(NULLIF(users.name, ''), EXCLUDED.name),
        avatar_key = COALESCE(users.avatar_key, EXCLUDED.avatar_key),
        updated_at = now()
      WHERE users.status <> 'deleted'
      RETURNING id, email, name, avatar_key, password_hash, status, is_admin, email_verified_at
      "#,
    )
    .bind(email)
    .bind(name)
    .bind(avatar_url)
    .fetch_one(connection)
    .await
    .map_err(Self::map_db_err)?;

    map_user_row(row).map_err(Self::map_db_err)
  }

  async fn lock_assistance_user(tx: &mut sqlx::PgConnection, user_id: Uuid) -> AuthResult<()> {
    sqlx::query("SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE")
      .bind(user_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(AuthError::ActionForbidden)?;
    Ok(())
  }

  async fn lock_assistance_workspace(tx: &mut sqlx::PgConnection, user_id: Uuid, workspace_id: Uuid) -> AuthResult<()> {
    // Keep native authority ahead of Database and preference locks. A revoke or
    // move after a preflight read cannot authorize a later preference commit.
    sqlx::query("SELECT id FROM workspaces WHERE id=$1 AND lifecycle_state='active' AND deleted_at IS NULL FOR SHARE")
      .bind(workspace_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(AuthError::ActionForbidden)?;
    sqlx::query("SELECT workspace_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='Accepted' FOR SHARE")
      .bind(workspace_id).bind(user_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?
      .ok_or(AuthError::ActionForbidden)?;
    Ok(())
  }

  async fn lock_assistance_project(
    tx: &mut sqlx::PgConnection,
    workspace_id: Uuid,
    project_id: Uuid,
    for_override: bool,
  ) -> AuthResult<AssistanceProjectFacts> {
    let row = sqlx::query("SELECT id,workspace_id,system_role FROM workspace_databases WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL FOR SHARE")
      .bind(project_id).bind(workspace_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?
      .ok_or(AuthError::ActionForbidden)?;
    let profile: Option<String> = sqlx::query_scalar("SELECT profile_kind FROM database_profiles WHERE database_id=$1")
      .bind(project_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let role: Option<String> = row.try_get("system_role").map_err(Self::map_db_err)?;
    let facts = AssistanceProjectFacts {
      id: row.try_get("id").map_err(Self::map_db_err)?,
      workspace_id: row.try_get("workspace_id").map_err(Self::map_db_err)?,
      profile_kind: profile
        .as_deref()
        .unwrap_or("generic")
        .parse()
        .map_err(|_| AuthError::Storage("invalid database profile".into()))?,
      system_role: role
        .map(|value| serde_json::from_value(serde_json::Value::String(value)))
        .transpose()
        .map_err(|_| AuthError::Storage("invalid database system role".into()))?,
    };
    facts.validate(workspace_id, project_id, for_override)?;
    Ok(facts)
  }

  /// Resolve the same native hierarchy while holding the preference row through
  /// effect commit. NOWAIT avoids inversion with scoped preference/root writers.
  pub(crate) async fn personal_assistance_in_tx(
    tx: &mut sqlx::PgConnection,
    user: Uuid,
    workspace: Uuid,
    database: Uuid,
  ) -> AuthResult<EffectiveAssistance> {
    let project = Self::lock_assistance_project(tx, workspace, database, false).await?;
    let value: Option<serde_json::Value> =
      sqlx::query_scalar("SELECT values FROM user_preferences WHERE user_id=$1 FOR SHARE NOWAIT")
        .bind(user)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    let preferences: UserPreferences = value
      .map(serde_json::from_value)
      .transpose()
      .map_err(|_| AuthError::Storage("invalid user preferences".into()))?
      .unwrap_or_default();
    preferences.validate()?;
    Ok(preferences.resolve_assistance(Some(workspace), Some(&project)))
  }
  async fn invalidate_downgraded_personal_rules(
    tx: &mut sqlx::PgConnection,
    user: Uuid,
    before: &UserPreferences,
    after: &UserPreferences,
  ) -> AuthResult<()> {
    if before.assistance_mode == after.assistance_mode
      && before.workspace_assistance_overrides == after.workspace_assistance_overrides
      && before.project_assistance_overrides == after.project_assistance_overrides
    {
      return Ok(());
    }
    let rules=sqlx::query("SELECT id,workspace_id,personal_config FROM workspace_automations WHERE personal_config->>'actorId'=$1 AND status='enabled' ORDER BY id FOR UPDATE NOWAIT")
      .bind(user.to_string()).fetch_all(&mut *tx).await.map_err(Self::map_db_err)?;
    for rule in rules {
      let id: Uuid = rule.try_get("id").map_err(Self::map_db_err)?;
      let workspace: Uuid = rule.try_get("workspace_id").map_err(Self::map_db_err)?;
      let config: myoxus_domain::workspace_automation::PersonalAutomationConfig =
        serde_json::from_value(rule.try_get("personal_config").map_err(Self::map_db_err)?)
          .map_err(|_| AuthError::Storage("invalid personal automation configuration".into()))?;
      if config.actor_id != user {
        return Err(AuthError::ActionForbidden);
      }
      let downgraded = match Self::lock_assistance_project(tx, workspace, config.database_id, false).await {
        Ok(project) => {
          before.resolve_assistance(Some(workspace), Some(&project)).mode
            == myoxus_application::auth::AssistanceMode::Automatic
            && after.resolve_assistance(Some(workspace), Some(&project)).mode
              != myoxus_application::auth::AssistanceMode::Automatic
        }
        Err(AuthError::ActionForbidden) => true,
        Err(error) => return Err(error),
      };
      if !downgraded {
        continue;
      }
      // A downgrade invalidates accepted generations even if Automatic is later
      // restored. Theme-only saves never enter this path. Locks are NOWAIT:
      // execution takes claim→Run→Rule, so no inverse waiter may be introduced.
      crate::workspace_automation::PgWorkspaceAutomationRepository::stop_personal_runs_in_tx(tx, id)
        .await
        .map_err(|error| AuthError::Storage(error.to_string()))?;
      sqlx::query("UPDATE workspace_automations SET execution_revision=execution_revision+1 WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    Ok(())
  }

  async fn patch_preferences_in_tx(
    tx: &mut sqlx::PgConnection,
    user_id: Uuid,
    patch: UserPreferencesPatch,
  ) -> AuthResult<UserPreferencesRecord> {
    sqlx::query(
      r#"
      INSERT INTO user_preferences (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
      "#,
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    let payload: serde_json::Value = sqlx::query_scalar(
      r#"
      SELECT values
      FROM user_preferences
      WHERE user_id = $1
      FOR UPDATE
      "#,
    )
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let mut values: UserPreferences =
      serde_json::from_value(payload).map_err(|err| AuthError::Storage(format!("invalid user preferences: {err}")))?;
    let before = values.clone();
    values.apply_patch(patch)?;
    Self::invalidate_downgraded_personal_rules(tx, user_id, &before, &values).await?;
    let payload = serde_json::to_value(&values).map_err(|e| AuthError::Storage(e.to_string()))?;
    let updated_at = sqlx::query_scalar(
      r#"
      UPDATE user_preferences
      SET values = $2, updated_at = now()
      WHERE user_id = $1
      RETURNING updated_at
      "#,
    )
    .bind(user_id)
    .bind(payload)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    Ok(UserPreferencesRecord {
      values,
      updated_at: Some(updated_at),
    })
  }

  fn map_db_err(err: sqlx::Error) -> AuthError {
    if matches!(err, sqlx::Error::RowNotFound) || crate::auth::is_terminal_account_error(&err) {
      AuthError::NotFound("user".into())
    } else {
      AuthError::Storage(err.to_string())
    }
  }
}

#[async_trait]
impl UserEmailLookup for SqlxAuthStore {
  async fn user_id_by_email(&self, email: &str) -> RepoResult<Option<Uuid>> {
    sqlx::query_scalar("SELECT id FROM users WHERE email = $1 AND status <> 'deleted'")
      .bind(email)
      .fetch_optional(&self.pool)
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))
  }

  async fn email_by_user_id(&self, user_id: Uuid) -> RepoResult<Option<String>> {
    sqlx::query_scalar("SELECT email FROM users WHERE id = $1 AND status <> 'deleted'")
      .bind(user_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(|error| RepositoryError::Storage(error.to_string()))
  }
}

#[async_trait]
impl AuthStore for SqlxAuthStore {
  #[instrument(skip_all)]
  async fn insert_admin_user(&self, email: &str, name: Option<&str>) -> AuthResult<Option<AuthUser>> {
    let row = sqlx::query(
      "INSERT INTO users (email, name) VALUES (lower($1), COALESCE($2, '')) \
       ON CONFLICT (lower(email)) DO NOTHING \
       RETURNING id, email, name, avatar_key, password_hash, status, is_admin, email_verified_at",
    )
    .bind(email)
    .bind(name)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    row.map(map_user_row).transpose().map_err(Self::map_db_err)
  }

  #[instrument(skip_all)]
  async fn auth_capability_account_state(&self) -> AuthResult<AuthCapabilityAccountState> {
    let row = sqlx::query(
      r#"
      SELECT
        COUNT(*)::bigint AS total_users,
        COUNT(*) FILTER (
          WHERE status = 'active' AND password_hash IS NOT NULL
        )::bigint AS active_password_users
      FROM users WHERE status <> 'deleted'
      "#,
    )
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(AuthCapabilityAccountState {
      total_users: row.try_get::<i64, _>("total_users").map_err(Self::map_db_err)? as u64,
      active_password_users: row
        .try_get::<i64, _>("active_password_users")
        .map_err(Self::map_db_err)? as u64,
    })
  }

  /// Look up a user by email address (case-insensitive).
  #[instrument(skip_all)]
  async fn get_user_by_email(&self, email: &str) -> AuthResult<Option<AuthUser>> {
    let row = sqlx::query(
      r#"
      SELECT id, email, name, avatar_key, password_hash, status, is_admin, email_verified_at
      FROM users
      WHERE lower(email) = lower($1) AND status <> 'deleted'
      LIMIT 1
      "#,
    )
    .bind(email)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    row.map(map_user_row).transpose().map_err(Self::map_db_err)
  }

  /// Look up a user by primary key.
  #[instrument(skip_all)]
  async fn get_user_by_id(&self, user_id: Uuid) -> AuthResult<Option<AuthUser>> {
    let row = sqlx::query(
      r#"
      SELECT id, email, name, avatar_key, password_hash, status, is_admin, email_verified_at
      FROM users
      WHERE id = $1 AND status <> 'deleted'
      LIMIT 1
      "#,
    )
    .bind(user_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    row.map(map_user_row).transpose().map_err(Self::map_db_err)
  }

  #[instrument(skip_all)]
  async fn get_historical_profiles(&self, ids: &[Uuid]) -> AuthResult<HashMap<Uuid, HistoricalUserProfile>> {
    let rows = sqlx::query("SELECT id,name,CASE WHEN status='deleted' THEN '' ELSE email END AS email,CASE WHEN status='deleted' THEN NULL ELSE avatar_key END AS avatar_key FROM users WHERE id=ANY($1)")
      .bind(ids).fetch_all(&self.pool).await.map_err(Self::map_db_err)?;
    Ok(
      rows
        .into_iter()
        .map(|row| {
          let profile = HistoricalUserProfile {
            id: row.get("id"),
            name: row.get("name"),
            email: row.get("email"),
            avatar_url: row.get("avatar_key"),
          };
          (profile.id, profile)
        })
        .collect(),
    )
  }

  #[instrument(skip_all)]
  async fn get_user_feature_override(&self, user_id: Uuid, feature_name: &str) -> AuthResult<Option<bool>> {
    sqlx::query_scalar("SELECT activated FROM user_features WHERE user_id = $1 AND feature_name = $2")
      .bind(user_id)
      .bind(feature_name)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_db_err)
  }

  #[instrument(skip_all)]
  async fn get_user_feature_overrides(
    &self,
    user_ids: &[Uuid],
    feature_name: &str,
  ) -> AuthResult<std::collections::HashMap<Uuid, bool>> {
    if user_ids.is_empty() {
      return Ok(std::collections::HashMap::new());
    }
    let rows = sqlx::query_as::<_, (Uuid, bool)>(
      "SELECT user_id, activated FROM user_features WHERE user_id = ANY($1) AND feature_name = $2",
    )
    .bind(user_ids)
    .bind(feature_name)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().collect())
  }

  #[instrument(skip_all)]
  async fn set_user_feature_override(
    &self,
    user_id: Uuid,
    feature_name: &str,
    activated: bool,
    reason: &str,
  ) -> AuthResult<()> {
    sqlx::query(
      r#"
      INSERT INTO user_features (user_id, feature_name, activated, reason)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, feature_name)
      DO UPDATE SET
        activated = EXCLUDED.activated,
        reason = EXCLUDED.reason,
        updated_at = now()
      "#,
    )
    .bind(user_id)
    .bind(feature_name)
    .bind(activated)
    .bind(reason)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }

  #[instrument(skip_all)]
  async fn last_login_at(&self, user_id: Uuid) -> AuthResult<Option<chrono::DateTime<chrono::Utc>>> {
    sqlx::query_scalar("SELECT MAX(created_at) FROM sessions WHERE user_id = $1")
      .bind(user_id)
      .fetch_one(&self.pool)
      .await
      .map_err(Self::map_db_err)
  }

  /// Batch-fetch users by a set of IDs in a single query.
  #[instrument(skip_all)]
  async fn get_users_by_ids(&self, ids: &[Uuid]) -> AuthResult<std::collections::HashMap<Uuid, AuthUser>> {
    use std::collections::HashMap;
    if ids.is_empty() {
      return Ok(HashMap::new());
    }
    let rows = sqlx::query(
      r#"
      SELECT id, email, name, avatar_key, password_hash, status, is_admin, email_verified_at
      FROM users
      WHERE id = ANY($1) AND status <> 'deleted'
      "#,
    )
    .bind(ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let mut map = HashMap::with_capacity(rows.len());
    for row in rows {
      let user = map_user_row(row).map_err(Self::map_db_err)?;
      map.insert(user.id, user);
    }
    Ok(map)
  }

  /// Batch-check which emails already exist in the database.
  #[instrument(skip_all)]
  async fn get_existing_emails(&self, emails: &[String]) -> AuthResult<std::collections::HashSet<String>> {
    use std::collections::HashSet;
    if emails.is_empty() {
      return Ok(HashSet::new());
    }
    let rows: Vec<String> = sqlx::query_scalar(
      r#"
      SELECT lower(email) FROM users WHERE lower(email) = ANY($1) AND status <> 'deleted'
      "#,
    )
    .bind(emails)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(rows.into_iter().collect())
  }

  /// Insert a user if no account exists for `email`, otherwise update name
  /// and avatar only when the existing columns are `NULL` (non-destructive
  /// upsert).
  #[instrument(skip_all)]
  async fn fulfill_user(&self, email: &str, name: Option<&str>, avatar_url: Option<&str>) -> AuthResult<AuthUser> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let user = Self::fulfill_in_transaction(&mut tx, email, name, avatar_url).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(user)
  }

  /// Partial-update a user's profile.  Only fields present in `update` are
  /// written; absent fields retain their current value.
  #[instrument(skip_all)]
  async fn update_user(&self, user_id: Uuid, update: UpdateAuthUser) -> AuthResult<AuthUser> {
    let row = sqlx::query(
      r#"
      UPDATE users
      SET
        email = COALESCE($2, email),
        name = CASE WHEN $3 THEN $4 ELSE name END,
        avatar_key = CASE WHEN $5 THEN $6 ELSE avatar_key END,
        updated_at = now()
      WHERE id = $1 AND status <> 'deleted'
      RETURNING id, email, name, avatar_key, password_hash, status, is_admin, email_verified_at
      "#,
    )
    .bind(user_id)
    .bind(update.email)
    .bind(update.name.is_some())
    .bind(update.name.flatten())
    .bind(update.avatar_url.is_some())
    .bind(update.avatar_url.flatten())
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    map_user_row(row).map_err(Self::map_db_err)
  }

  /// Retain historical identity while permanently removing the operational
  /// account. The user lock serializes cleanup with credential/grant guards.
  #[instrument(skip_all)]
  async fn commit_user_deletion(&self, user_id: Uuid) -> AuthResult<UserDeletionCommit> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let row = sqlx::query("SELECT id,email,name,avatar_key,password_hash,status,is_admin,email_verified_at FROM users WHERE id=$1 AND status <> 'deleted' FOR UPDATE")
      .bind(user_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?
      .ok_or(AuthError::NotFound("user".into()))?;
    let user = AuthUserProjection::from(&map_user_row(row).map_err(Self::map_db_err)?);
    let revoked_session_ids = sqlx::query_scalar::<_, Uuid>("SELECT id FROM sessions WHERE user_id=$1 ORDER BY id")
      .bind(user_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let deleted_api_key_ids = sqlx::query_scalar::<_, Uuid>("SELECT id FROM api_keys WHERE user_id=$1 ORDER BY id")
      .bind(user_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;

    // 1a. Move shared workspaces to the canonical ownerless principal before
    // deleting their user owner, including archived shared workspaces.
    // Updating only `owner_user_id` would violate
    // the principal consistency constraint and make account deletion fail.
    sqlx::query(
      r#"
      UPDATE workspaces
      SET owner_user_id = NULL,
          owner_principal_type = 'system',
          owner_principal_id = NULL,
          is_personal_workspace = FALSE,
          updated_at = now()
      WHERE owner_user_id = $1
        AND EXISTS (
          SELECT 1 FROM workspace_memberships
          WHERE workspace_id = workspaces.id
            AND user_id <> $1
            AND status = 'Accepted'
        )
      "#,
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    // 1b. Delete sole-owner workspaces (user was the only member) and all their content.
    let sole_owner_workspaces = sqlx::query_scalar::<_, Uuid>(
      "SELECT id FROM workspaces WHERE owner_user_id=$1 AND NOT EXISTS(
        SELECT 1 FROM workspace_memberships WHERE workspace_id=workspaces.id
          AND user_id<>$1 AND status='Accepted')",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    crate::workspace::SqlxWorkspaceStore::guard_hard_delete_in_transaction(&mut tx, &sole_owner_workspaces).await?;
    sqlx::query(
      r#"
      DELETE FROM workspaces
      WHERE owner_user_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM workspace_memberships
          WHERE workspace_id = workspaces.id
            AND user_id <> $1
            AND status = 'Accepted'
        )
      "#,
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    // Shared attribution, attachments, invites and historical actor FKs stay on
    // the retained identity. Current responsibilities are not authorship; their
    // existing triggers advance metadata revisions/epochs when cleared.
    for query in [
      "UPDATE document_workspace_settings SET default_responsible_user_id=NULL,metadata_revision=metadata_revision+1,updated_at=now() WHERE default_responsible_user_id=$1",
      "UPDATE organization_document_settings SET default_responsible_user_id=NULL,metadata_revision=metadata_revision+1,updated_at=now() WHERE default_responsible_user_id=$1",
      "DELETE FROM docs WHERE userspace_owner_id=$1",
      "DELETE FROM session_links WHERE user_id=$1",
      "DELETE FROM sessions WHERE user_id=$1",
      "DELETE FROM access_tokens WHERE user_id=$1",
      "DELETE FROM mcp_idempotency_keys WHERE user_id=$1",
      "DELETE FROM api_keys WHERE user_id=$1",
      "DELETE FROM connected_accounts WHERE user_id=$1",
      "DELETE FROM user_features WHERE user_id=$1",
      "DELETE FROM workspace_starter_applications WHERE actor_id=$1",
      "DELETE FROM user_preferences WHERE user_id=$1",
      "DELETE FROM workspace_memberships WHERE user_id=$1",
      "DELETE FROM organization_unit_member WHERE user_id=$1",
      "DELETE FROM doc_user_permissions WHERE user_id=$1",
      "DELETE FROM comment_thread_read_state WHERE user_id=$1",
      "DELETE FROM database_row_reminders WHERE user_id=$1",
      "DELETE FROM database_view_user_states WHERE user_id=$1",
      "DELETE FROM notifications WHERE user_id=$1",
      "DELETE FROM workspace_member_last_access WHERE user_id=$1",
      "DELETE FROM workspace_content_operation_recipient_outbox WHERE recipient_id=$1",
      "DELETE FROM document_history_capture_request WHERE actor_id=$1",
      "DELETE FROM calendar_accounts WHERE user_id=$1",
      "DELETE FROM copilot_jobs WHERE user_id=$1",
      "DELETE FROM copilot_sessions WHERE user_id=$1",
      "DELETE FROM copilot_contexts WHERE user_id=$1",
      "DELETE FROM git_sync_profiles WHERE owner_id=$1",
      "DELETE FROM telemetry_events WHERE user_id=$1",
      "DELETE FROM workspace_imports WHERE actor_id=$1",
    ] {
      sqlx::query(query)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    sqlx::query("DELETE FROM magic_link_otps WHERE lower(email)=lower($1)")
      .bind(&user.email)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query("DELETE FROM verification_tokens WHERE user_id=$1 OR lower(email)=lower($2)")
      .bind(user_id)
      .bind(&user.email)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query("UPDATE users SET status='deleted',email='deleted:'||id::text,password_hash=NULL,avatar_key=NULL,email_verified_at=NULL,is_admin=FALSE,updated_at=now() WHERE id=$1")
      .bind(user_id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
    // Membership/default triggers may resolve the still-active historical
    // creator as a fallback. Clear current assignments after terminal marking,
    // so no subsequent cleanup trigger can restore that deleted responsibility.
    sqlx::query("UPDATE docs SET responsible_user_id=NULL WHERE responsible_user_id=$1")
      .bind(user_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    // No old email or avatar crosses the deletion commit/audit boundary.
    let user = AuthUserProjection {
      email: String::new(),
      avatar_url: None,
      is_admin: false,
      disabled: true,
      email_verified_at: None,
      has_password: false,
      ..user
    };

    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(UserDeletionCommit {
      user,
      revoked_session_ids,
      deleted_api_key_ids,
    })
  }

  /// Atomically replace a password hash and revoke every session so an
  /// administrative password change cannot leave old sessions usable after a
  /// partial database failure.
  #[instrument(skip_all)]
  async fn commit_password_update(
    &self,
    user_id: Uuid,
    password_hash: String,
    changed_at: DateTime<Utc>,
  ) -> AuthResult<myoxus_application::auth::PasswordUpdateCommit> {
    let mut transaction = self.pool.begin().await.map_err(Self::map_db_err)?;
    let updated_user = sqlx::query(
      r#"
      UPDATE users
      SET password_hash = $2, updated_at = $3
      WHERE id = $1 AND status <> 'deleted'
      "#,
    )
    .bind(user_id)
    .bind(password_hash)
    .bind(changed_at)
    .execute(&mut *transaction)
    .await
    .map_err(Self::map_db_err)?;
    if updated_user.rows_affected() != 1 {
      return Err(AuthError::NotFound("user".to_string()));
    }

    let revoked_session_ids = sqlx::query_scalar::<_, Uuid>(
      r#"
      UPDATE sessions
      SET revoked_at = COALESCE(revoked_at, $2), updated_at = $2
      WHERE user_id = $1
      RETURNING id
      "#,
    )
    .bind(user_id)
    .bind(changed_at)
    .fetch_all(&mut *transaction)
    .await
    .map_err(Self::map_db_err)?;

    transaction.commit().await.map_err(Self::map_db_err)?;
    Ok(myoxus_application::auth::PasswordUpdateCommit {
      user_id,
      revoked_session_ids,
    })
  }

  /// Serialize role changes with credential creation on the target user row.
  /// Capture every existing session before committing; none is revoked here.
  #[instrument(skip_all, fields(user_id = %user_id))]
  async fn commit_user_admin_role(&self, user_id: Uuid, is_admin: bool) -> AuthResult<UserAdminRoleCommit> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let previous_is_admin =
      sqlx::query_scalar::<_, bool>("SELECT is_admin FROM users WHERE id=$1 AND status <> 'deleted' FOR UPDATE")
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?
        .ok_or(AuthError::NotFound("user".into()))?;
    sqlx::query("UPDATE users SET is_admin=$2,updated_at=now() WHERE id=$1")
      .bind(user_id)
      .bind(is_admin)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let session_ids = sqlx::query_scalar::<_, Uuid>("SELECT id FROM sessions WHERE user_id=$1 ORDER BY id")
      .bind(user_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(UserAdminRoleCommit {
      user_id,
      previous_is_admin,
      is_admin,
      session_ids,
    })
  }

  /// Atomically disable a user and revoke every credential that can still
  /// authenticate as that user. The user row is updated first so concurrent
  /// session/API-key creation is serialized by the same row lock; all writes
  /// commit or roll back together.
  #[instrument(skip_all)]
  async fn commit_user_suspension(&self, user_id: Uuid, changed_at: DateTime<Utc>) -> AuthResult<UserSuspensionCommit> {
    let mut transaction = self.pool.begin().await.map_err(Self::map_db_err)?;
    let user_row = sqlx::query(
      r#"
      UPDATE users
      SET status = 'disabled', updated_at = $2
      WHERE id = $1 AND status <> 'deleted'
      RETURNING id, email, name, avatar_key, status, is_admin, email_verified_at,
        (password_hash IS NOT NULL) AS has_password
      "#,
    )
    .bind(user_id)
    .bind(changed_at)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(AuthError::NotFound("user".to_string()))?;
    let user = map_suspended_user_row(user_row).map_err(Self::map_db_err)?;

    let revoked_session_ids = sqlx::query_scalar::<_, Uuid>(
      r#"
      UPDATE sessions
      SET revoked_at = COALESCE(revoked_at, $2), updated_at = $2
      WHERE user_id = $1
      RETURNING id
      "#,
    )
    .bind(user_id)
    .bind(changed_at)
    .fetch_all(&mut *transaction)
    .await
    .map_err(Self::map_db_err)?;

    let deleted_api_key_ids = sqlx::query_scalar::<_, Uuid>("DELETE FROM api_keys WHERE user_id = $1 RETURNING id")
      .bind(user_id)
      .fetch_all(&mut *transaction)
      .await
      .map_err(Self::map_db_err)?;

    transaction.commit().await.map_err(Self::map_db_err)?;
    Ok(UserSuspensionCommit {
      user,
      revoked_session_ids,
      deleted_api_key_ids,
    })
  }

  /// Suspend (`disabled = true`) or restore (`disabled = false`) a user account.
  ///
  /// Maps to the `status` column: `'disabled'` ↔ `'active'`.  Returns the
  /// updated user record so callers can return it without an extra round-trip.
  #[instrument(skip_all)]
  async fn set_user_disabled(&self, user_id: Uuid, disabled: bool) -> AuthResult<AuthUser> {
    let status = if disabled { "disabled" } else { "active" };
    let row = sqlx::query(
      r#"
      UPDATE users
      SET status = $2, updated_at = now()
      WHERE id = $1 AND status <> 'deleted'
      RETURNING id, email, name, avatar_key, password_hash, status, is_admin, email_verified_at
      "#,
    )
    .bind(user_id)
    .bind(status)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    map_user_row(row).map_err(Self::map_db_err)
  }

  /// Record the timestamp at which the user's email address was verified.
  #[instrument(skip_all)]
  async fn set_email_verified(&self, user_id: Uuid, verified_at: DateTime<Utc>) -> AuthResult<()> {
    let changed = sqlx::query(
      r#"
      UPDATE users
      SET email_verified_at = $2, updated_at = now()
      WHERE id = $1 AND status <> 'deleted'
      "#,
    )
    .bind(user_id)
    .bind(verified_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    if changed.rows_affected() != 1 {
      return Err(AuthError::NotFound("user".into()));
    }
    Ok(())
  }

  /// Insert or replace a session (upserts on `id`).
  #[instrument(skip_all)]
  async fn create_session(&self, session: NewSession) -> AuthResult<AuthSession> {
    let mut transaction = self.pool.begin().await.map_err(Self::map_db_err)?;
    let active_user =
      sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id = $1 AND status = 'active' FOR SHARE")
        .bind(session.user_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(Self::map_db_err)?;
    if active_user.is_none() {
      return Err(AuthError::AuthenticationRequired);
    }

    let row = sqlx::query(
      r#"
      INSERT INTO sessions (id, user_id, csrf_token, user_agent, ip_address, expires_at, refresh_after, created_at)
      VALUES ($1, $2, $3, $4, $5::inet, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        csrf_token = EXCLUDED.csrf_token,
        user_agent = EXCLUDED.user_agent,
        ip_address = EXCLUDED.ip_address,
        expires_at = EXCLUDED.expires_at,
        refresh_after = EXCLUDED.refresh_after,
        created_at = EXCLUDED.created_at,
        updated_at = now()
      RETURNING id, user_id, csrf_token, user_agent, ip_address::text AS ip_address, expires_at, refresh_after, revoked_at, created_at
      "#,
    )
    .bind(session.id)
    .bind(session.user_id)
    .bind(session.csrf_token)
    .bind(session.user_agent)
    .bind(session.ip_address)
    .bind(session.expires_at)
    .bind(session.refresh_after)
    .bind(session.created_at)
    .fetch_one(&mut *transaction)
    .await
    .map_err(Self::map_db_err)?;

    transaction.commit().await.map_err(Self::map_db_err)?;

    map_session_row(row).map_err(Self::map_db_err)
  }

  /// Fetch a session by ID, returning `None` when not found.
  #[instrument(skip_all)]
  async fn get_session(&self, session_id: Uuid) -> AuthResult<Option<AuthSession>> {
    let row = sqlx::query(
      r#"
      SELECT id, user_id, csrf_token, user_agent, ip_address::text AS ip_address, expires_at, refresh_after, revoked_at, created_at
      FROM sessions
      WHERE id = $1
      LIMIT 1
      "#,
    )
    .bind(session_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    row.map(map_session_row).transpose().map_err(Self::map_db_err)
  }

  /// Extend the expiry of an existing session.
  #[instrument(skip_all)]
  async fn refresh_session(
    &self,
    session_id: Uuid,
    expires_at: DateTime<Utc>,
    refresh_after: DateTime<Utc>,
  ) -> AuthResult<()> {
    sqlx::query(
      r#"
      UPDATE sessions
      SET expires_at = $2, refresh_after = $3, updated_at = now()
      WHERE id = $1
      "#,
    )
    .bind(session_id)
    .bind(expires_at)
    .bind(refresh_after)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(())
  }

  #[instrument(skip_all)]
  async fn commit_session_revocation(
    &self,
    target: &SessionRevocationTarget,
    revoked_at: DateTime<Utc>,
    barrier: &dyn SessionRevocationBarrier,
  ) -> AuthResult<SessionRevocationCommit> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let (session, user, all) = match target {
      SessionRevocationTarget::Session(id) => (Some(*id), None, false),
      SessionRevocationTarget::User(filter) => (None, Some(filter.as_str()), false),
      SessionRevocationTarget::All => (None, None, true),
    };
    // Capture under row locks before fencing. Bulk selectors commit one
    // captured set, including expired sessions, just like the CLI SQL path.
    let captured: Vec<(Uuid, Uuid)> = sqlx::query_as(
      "SELECT id, user_id FROM sessions WHERE \
       ($3 OR id = $1 OR user_id = (SELECT id FROM users WHERE email = $2 OR id::text = $2 LIMIT 1)) \
       ORDER BY id FOR UPDATE",
    )
    .bind(session)
    .bind(user)
    .bind(all)
    .fetch_all(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let users: Vec<Uuid> = captured
      .iter()
      .map(|(_, user)| *user)
      .collect::<std::collections::BTreeSet<_>>()
      .into_iter()
      .collect();
    let epochs = barrier.block(&users).await?;
    let ids: Vec<Uuid> = captured.iter().map(|(id, _)| *id).collect();
    let result = async {
      let result = sqlx::query("UPDATE sessions SET revoked_at = $2 WHERE id = ANY($1) AND revoked_at IS NULL")
        .bind(&ids)
        .bind(revoked_at)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      Ok::<_, AuthError>(result.rows_affected() as usize)
    }
    .await;
    let revoked_count = match result {
      Ok(count) => count,
      Err(error) => {
        tx.rollback().await.map_err(Self::map_db_err)?;
        barrier.rollback(&epochs).await;
        return Err(error);
      }
    };
    if let Err(error) = tx.commit().await {
      // COMMIT transport failures have an uncertain outcome. Keep the epoch
      // blocked rather than authenticating a possibly revoked session.
      return Err(Self::map_db_err(error));
    }
    Ok(SessionRevocationCommit {
      sessions: captured,
      revoked_count,
      epochs,
    })
  }

  /// Soft-revoke a session by setting `revoked_at` (idempotent).
  #[instrument(skip_all)]
  async fn revoke_session(&self, session_id: Uuid, revoked_at: DateTime<Utc>) -> AuthResult<()> {
    sqlx::query(
      r#"
      UPDATE sessions
      SET revoked_at = COALESCE(revoked_at, $2)
      WHERE id = $1
      "#,
    )
    .bind(session_id)
    .bind(revoked_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(())
  }

  /// Soft-revoke all sessions belonging to a user.
  #[instrument(skip_all)]
  async fn revoke_all_user_sessions(&self, user_id: Uuid, revoked_at: DateTime<Utc>) -> AuthResult<()> {
    sqlx::query(
      r#"
      UPDATE sessions
      SET revoked_at = COALESCE(revoked_at, $2)
      WHERE user_id = $1
      "#,
    )
    .bind(user_id)
    .bind(revoked_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(())
  }

  #[instrument(skip_all)]
  async fn get_session_group_root(&self, session_id: Uuid) -> AuthResult<Option<Uuid>> {
    sqlx::query_scalar("SELECT root_session_id FROM session_links WHERE session_id = $1")
      .bind(session_id)
      .fetch_optional(&self.pool)
      .await
      .map_err(Self::map_db_err)
  }

  #[instrument(skip_all)]
  async fn upsert_session_group_link(&self, link: SessionGroupLink) -> AuthResult<()> {
    let persist = |root_session_id| {
      sqlx::query(
        r#"INSERT INTO session_links (session_id, root_session_id, user_id, created_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (session_id) DO UPDATE SET
             root_session_id = EXCLUDED.root_session_id,
             user_id = EXCLUDED.user_id"#,
      )
      .bind(link.session_id)
      .bind(root_session_id)
      .bind(link.user_id)
      .bind(link.created_at)
      .execute(&self.pool)
    };
    match persist(link.root_session_id).await {
      Ok(_) => Ok(()),
      Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("23503") => {
        if link.root_session_id == link.session_id {
          return Ok(());
        }
        persist(link.session_id).await.map(|_| ()).or_else(|error| {
          if matches!(&error, sqlx::Error::Database(database) if database.code().as_deref() == Some("23503")) {
            Ok(())
          } else {
            Err(Self::map_db_err(error))
          }
        })
      }
      Err(error) => Err(Self::map_db_err(error)),
    }
  }

  #[instrument(skip_all)]
  async fn delete_session_group_link(&self, session_id: Uuid) -> AuthResult<()> {
    sqlx::query("DELETE FROM session_links WHERE session_id = $1")
      .bind(session_id)
      .execute(&self.pool)
      .await
      .map(|_| ())
      .map_err(Self::map_db_err)
  }

  #[instrument(skip_all)]
  async fn list_session_group_sessions(&self, root_session_id: Uuid) -> AuthResult<Vec<Uuid>> {
    sqlx::query_scalar("SELECT session_id FROM session_links WHERE root_session_id = $1 ORDER BY created_at ASC")
      .bind(root_session_id)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)
  }

  #[instrument(skip_all)]
  async fn list_session_group_users(&self, root_session_id: Uuid) -> AuthResult<Vec<Uuid>> {
    sqlx::query_scalar(
      r#"SELECT user_id FROM session_links
         WHERE root_session_id = $1
         GROUP BY user_id
         ORDER BY MIN(created_at) ASC"#,
    )
    .bind(root_session_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }

  #[instrument(skip_all)]
  async fn find_session_group_session_for_user(
    &self,
    root_session_id: Uuid,
    user_id: Uuid,
  ) -> AuthResult<Option<Uuid>> {
    sqlx::query_scalar(
      r#"SELECT session_id FROM session_links
         WHERE root_session_id = $1 AND user_id = $2
         ORDER BY created_at DESC LIMIT 1"#,
    )
    .bind(root_session_id)
    .bind(user_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }

  /// Insert a new verification token (e.g. for email-verify or
  /// password-reset flows).
  #[instrument(skip_all)]
  async fn create_verification_token(
    &self,
    user_id: Option<Uuid>,
    kind: &str,
    token_hash: &str,
    email: Option<&str>,
    expires_at: DateTime<Utc>,
    extra: Option<serde_json::Value>,
  ) -> AuthResult<VerificationToken> {
    let row = sqlx::query(
      r#"
      INSERT INTO verification_tokens (user_id, kind, token_hash, email, expires_at, extra)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, user_id, kind, token_hash, email, expires_at, used_at, created_at, extra
      "#,
    )
    .bind(user_id)
    .bind(kind)
    .bind(token_hash)
    .bind(email)
    .bind(expires_at)
    .bind(extra)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    map_verification_token_row(row).map_err(Self::map_db_err)
  }

  /// Fetch a verification token by its hash, returning `None` when not found.
  #[instrument(skip_all)]
  async fn get_verification_token(&self, token_hash: &str) -> AuthResult<Option<VerificationToken>> {
    let row = sqlx::query(
      r#"
      SELECT id, user_id, kind, token_hash, email, expires_at, used_at, created_at, extra
      FROM verification_tokens
      WHERE token_hash = $1
      LIMIT 1
      "#,
    )
    .bind(token_hash)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    row
      .map(map_verification_token_row)
      .transpose()
      .map_err(Self::map_db_err)
  }

  /// Find a verification token by `kind`, hash, and optional user constraint.
  #[instrument(skip_all)]
  async fn find_verification_token(
    &self,
    kind: &str,
    token_hash: &str,
    user_id: Option<Uuid>,
  ) -> AuthResult<Option<VerificationToken>> {
    let row = sqlx::query(
      r#"
      SELECT id, user_id, kind, token_hash, email, expires_at, used_at, created_at, extra
      FROM verification_tokens
      WHERE kind = $1 AND token_hash = $2 AND ($3 IS NULL OR user_id = $3)
      LIMIT 1
      "#,
    )
    .bind(kind)
    .bind(token_hash)
    .bind(user_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    row
      .map(map_verification_token_row)
      .transpose()
      .map_err(Self::map_db_err)
  }

  /// Mark a verification token as consumed (idempotent via `COALESCE`).
  #[instrument(skip_all)]
  async fn consume_verification_token(&self, token_hash: &str, used_at: DateTime<Utc>) -> AuthResult<()> {
    sqlx::query(
      r#"
      UPDATE verification_tokens
      SET used_at = COALESCE(used_at, $2)
      WHERE token_hash = $1
      "#,
    )
    .bind(token_hash)
    .bind(used_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(())
  }

  #[instrument(skip_all)]
  async fn commit_email_change(
    &self,
    user_id: Uuid,
    token_hash: &str,
    email: &str,
    changed_at: DateTime<Utc>,
    barrier: &dyn SessionRevocationBarrier,
  ) -> AuthResult<EmailChangeCommit> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // Account-first locks match credential creation/deletion. A caller with a
    // stale snapshot cannot mutate a deleted or suspended account.
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id=$1 AND status='active' FOR UPDATE")
      .bind(user_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(AuthError::InvalidToken)?;
    let token = sqlx::query("SELECT expires_at, used_at FROM verification_tokens WHERE kind='VerifyEmail' AND token_hash=$1 AND user_id=$2 FOR UPDATE")
      .bind(token_hash).bind(user_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?
      .ok_or(AuthError::InvalidToken)?;
    if token
      .try_get::<Option<DateTime<Utc>>, _>("used_at")
      .map_err(Self::map_db_err)?
      .is_some()
    {
      return Err(AuthError::InvalidToken);
    }
    if token
      .try_get::<DateTime<Utc>, _>("expires_at")
      .map_err(Self::map_db_err)?
      <= Utc::now().max(changed_at)
    {
      return Err(AuthError::ExpiredToken);
    }
    let duplicate: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM users WHERE lower(email)=lower($1) AND id<>$2 AND status<>'deleted')",
    )
    .bind(email)
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if duplicate {
      return Err(AuthError::ActionForbidden);
    }
    let revoked_session_ids =
      sqlx::query_scalar::<_, Uuid>("SELECT id FROM sessions WHERE user_id=$1 ORDER BY id FOR UPDATE")
        .bind(user_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    let epochs = barrier.block(&[user_id]).await?;
    let result = async {
      let row = sqlx::query("UPDATE users SET email=$2, email_verified_at=$3, updated_at=$3 WHERE id=$1 RETURNING id,email,name,avatar_key,password_hash,status,is_admin,email_verified_at")
        .bind(user_id).bind(email).bind(changed_at).fetch_one(&mut *tx).await
        .map_err(|error| {
          // A concurrent account can win the unique email index after our
          // read. Preserve the same refusal as an already-visible duplicate.
          if matches!(&error, sqlx::Error::Database(e) if e.code().as_deref()==Some("23505")) {
            AuthError::ActionForbidden
          } else { Self::map_db_err(error) }
        })?;
      let user = map_user_row(row).map_err(Self::map_db_err)?;
      let consumed = sqlx::query("UPDATE verification_tokens SET used_at=$2 WHERE token_hash=$1 AND kind='VerifyEmail' AND user_id=$3 AND used_at IS NULL")
        .bind(token_hash).bind(changed_at).bind(user_id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      if consumed.rows_affected() != 1 { return Err(AuthError::InvalidToken); }
      sqlx::query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,$2), updated_at=$2 WHERE user_id=$1")
        .bind(user_id).bind(changed_at).execute(&mut *tx).await.map_err(Self::map_db_err)?;
      Ok::<_, AuthError>(user)
    }.await;
    let user = match result {
      Ok(user) => user,
      Err(error) => {
        tx.rollback().await.map_err(Self::map_db_err)?;
        barrier.rollback(&epochs).await;
        return Err(error);
      }
    };
    // A transport failure during COMMIT is uncertain; do not release fences.
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(EmailChangeCommit {
      user,
      revoked_session_ids,
      epochs,
    })
  }

  /// Commit every security-sensitive password-reset write in one SQL
  /// transaction. The token row lock serializes concurrent consumers; the
  /// session `RETURNING` projection is the authoritative cache-invalidation
  /// set handed back to the application layer.
  #[instrument(skip_all)]
  async fn commit_password_reset(
    &self,
    token_hash: &str,
    password_hash: String,
    changed_at: DateTime<Utc>,
  ) -> AuthResult<PasswordResetCommit> {
    let mut transaction = self.pool.begin().await.map_err(Self::map_db_err)?;
    let user_id = sqlx::query_scalar::<_, Option<Uuid>>(
      "SELECT user_id FROM verification_tokens WHERE kind='ChangePassword' AND token_hash=$1",
    )
    .bind(token_hash)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(Self::map_db_err)?
    .flatten()
    .ok_or(AuthError::InvalidToken)?;
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id=$1 AND status <> 'deleted' FOR UPDATE")
      .bind(user_id)
      .fetch_optional(&mut *transaction)
      .await
      .map_err(Self::map_db_err)?
      .ok_or(AuthError::InvalidToken)?;
    let token = sqlx::query(
      r#"
      SELECT user_id, expires_at, used_at
      FROM verification_tokens
      WHERE kind = 'ChangePassword' AND token_hash = $1
      FOR UPDATE
      "#,
    )
    .bind(token_hash)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(Self::map_db_err)?
    .ok_or(AuthError::InvalidToken)?;

    if token.try_get::<Option<Uuid>, _>("user_id").map_err(Self::map_db_err)? != Some(user_id) {
      return Err(AuthError::InvalidToken);
    }
    let used_at = token
      .try_get::<Option<DateTime<Utc>>, _>("used_at")
      .map_err(Self::map_db_err)?;
    if used_at.is_some() {
      return Err(AuthError::InvalidToken);
    }
    let expires_at = token
      .try_get::<DateTime<Utc>, _>("expires_at")
      .map_err(Self::map_db_err)?;
    if expires_at <= changed_at {
      return Err(AuthError::ExpiredToken);
    }

    let updated_user = sqlx::query(
      r#"
      UPDATE users
      SET password_hash = $2, updated_at = $3
      WHERE id = $1 AND status <> 'deleted'
      "#,
    )
    .bind(user_id)
    .bind(password_hash)
    .bind(changed_at)
    .execute(&mut *transaction)
    .await
    .map_err(Self::map_db_err)?;
    if updated_user.rows_affected() != 1 {
      return Err(AuthError::InvalidToken);
    }

    let consumed = sqlx::query(
      r#"
      UPDATE verification_tokens
      SET used_at = $2
      WHERE token_hash = $1 AND kind = 'ChangePassword' AND used_at IS NULL
      "#,
    )
    .bind(token_hash)
    .bind(changed_at)
    .execute(&mut *transaction)
    .await
    .map_err(Self::map_db_err)?;
    if consumed.rows_affected() != 1 {
      return Err(AuthError::InvalidToken);
    }

    let revoked_session_ids = sqlx::query_scalar::<_, Uuid>(
      r#"
      UPDATE sessions
      SET revoked_at = COALESCE(revoked_at, $2), updated_at = $2
      WHERE user_id = $1
      RETURNING id
      "#,
    )
    .bind(user_id)
    .bind(changed_at)
    .fetch_all(&mut *transaction)
    .await
    .map_err(Self::map_db_err)?;

    transaction.commit().await.map_err(Self::map_db_err)?;
    Ok(PasswordResetCommit {
      user_id,
      revoked_session_ids,
    })
  }

  /// Create a new long-lived API access token for a user.
  #[instrument(skip_all)]
  async fn create_access_token(&self, input: NewAccessToken) -> AuthResult<AccessToken> {
    let row = sqlx::query(
      r#"
      INSERT INTO access_tokens (user_id, name, token_hash, expires_at)
      VALUES ($1, $2, $3, $4)
      RETURNING id, user_id, name, token_hash, expires_at, created_at, last_used_at
      "#,
    )
    .bind(input.user_id)
    .bind(input.name)
    .bind(input.token_hash)
    .bind(input.expires_at)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    map_access_token_row(row).map_err(Self::map_db_err)
  }

  /// List all access tokens belonging to a user.
  #[instrument(skip_all)]
  async fn list_access_tokens(&self, user_id: Uuid) -> AuthResult<Vec<AccessToken>> {
    let rows = sqlx::query(
      r#"
      SELECT id, user_id, name, token_hash, expires_at, created_at, last_used_at
      FROM access_tokens
      WHERE user_id = $1
      "#,
    )
    .bind(user_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    rows
      .into_iter()
      .map(map_access_token_row)
      .collect::<Result<Vec<_>, _>>()
      .map_err(Self::map_db_err)
  }

  /// Delete an access token, scoped to the owning user for safety.
  #[instrument(skip_all)]
  async fn revoke_access_token(&self, id: Uuid, user_id: Uuid) -> AuthResult<()> {
    sqlx::query(
      r#"
      DELETE FROM access_tokens
      WHERE id = $1 AND user_id = $2
      "#,
    )
    .bind(id)
    .bind(user_id)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(())
  }

  /// Fetch the typed user-preference overrides, returning an empty aggregate
  /// when no row exists yet.
  #[instrument(skip_all)]
  async fn get_user_preferences(&self, user_id: Uuid) -> AuthResult<UserPreferencesRecord> {
    let row = sqlx::query(
      r#"
      SELECT values, updated_at
      FROM user_preferences
      WHERE user_id = $1
      "#,
    )
    .bind(user_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    match row {
      Some(row) => {
        let values: serde_json::Value = row.try_get("values").map_err(Self::map_db_err)?;
        let values: UserPreferences =
          serde_json::from_value(values).map_err(|e| AuthError::Storage(format!("invalid user preferences: {e}")))?;
        values.validate()?;
        Ok(UserPreferencesRecord {
          values,
          updated_at: Some(row.try_get("updated_at").map_err(Self::map_db_err)?),
        })
      }
      None => Ok(UserPreferencesRecord::default()),
    }
  }

  #[instrument(skip_all)]
  async fn acknowledge_workspace_starter_assistance(&self, actor: Uuid, request_id: Uuid) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::lock_assistance_user(&mut tx, actor).await?;
    let workspace_id: Uuid = sqlx::query_scalar("SELECT workspace_id FROM workspace_starter_applications WHERE actor_id=$1 AND operation='create_workspace' AND request_id=$2")
      .bind(actor).bind(request_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?
      .ok_or_else(|| AuthError::NotFound("workspace starter receipt".into()))?;
    Self::lock_assistance_workspace(&mut tx, actor, workspace_id).await?;
    let row = sqlx::query("SELECT assistance_mode,assistance_saved_at FROM workspace_starter_applications WHERE actor_id=$1 AND operation='create_workspace' AND request_id=$2 FOR UPDATE")
      .bind(actor).bind(request_id).fetch_one(&mut *tx).await.map_err(Self::map_db_err)?;
    if row
      .try_get::<Option<DateTime<Utc>>, _>("assistance_saved_at")
      .map_err(Self::map_db_err)?
      .is_none()
    {
      let mode: String = row.try_get("assistance_mode").map_err(Self::map_db_err)?;
      let mode = serde_json::from_value(serde_json::Value::String(mode))
        .map_err(|_| AuthError::Storage("invalid Workspace assistance receipt".into()))?;
      Self::patch_preferences_in_tx(
        &mut tx,
        actor,
        UserPreferencesPatch {
          workspace_assistance_overrides: vec![myoxus_application::auth::WorkspaceAssistancePatch {
            workspace_id,
            mode: Some(mode),
          }],
          ..Default::default()
        },
      )
      .await?;
      sqlx::query("UPDATE workspace_starter_applications SET assistance_saved_at=now() WHERE actor_id=$1 AND operation='create_workspace' AND request_id=$2 AND assistance_saved_at IS NULL")
        .bind(actor).bind(request_id).execute(&mut *tx).await.map_err(Self::map_db_err)?;
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  #[instrument(skip_all)]
  async fn get_assistance(
    &self,
    user_id: Uuid,
    workspace_id: Option<Uuid>,
    project_id: Option<Uuid>,
  ) -> AuthResult<EffectiveAssistance> {
    if project_id.is_some() && workspace_id.is_none() {
      return Err(AuthError::InvalidInput(
        "project assistance requires a workspace".into(),
      ));
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::lock_assistance_user(&mut tx, user_id).await?;
    if let Some(workspace_id) = workspace_id {
      Self::lock_assistance_workspace(&mut tx, user_id, workspace_id).await?;
    }
    let project = if let (Some(workspace_id), Some(project_id)) = (workspace_id, project_id) {
      Some(Self::lock_assistance_project(&mut tx, workspace_id, project_id, false).await?)
    } else {
      None
    };
    let payload: Option<serde_json::Value> = sqlx::query_scalar("SELECT values FROM user_preferences WHERE user_id=$1")
      .bind(user_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let values: UserPreferences = payload
      .map(serde_json::from_value)
      .transpose()
      .map_err(|_| AuthError::Storage("invalid user preferences".into()))?
      .unwrap_or_default();
    values.validate()?;
    let effective = values.resolve_assistance(workspace_id, project.as_ref());
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(effective)
  }

  /// Apply a preference patch under a row lock so concurrent devices cannot
  /// overwrite unrelated fields with stale aggregate snapshots.
  #[instrument(skip_all)]
  async fn patch_user_preferences(
    &self,
    user_id: Uuid,
    patch: UserPreferencesPatch,
  ) -> AuthResult<UserPreferencesRecord> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    patch.validate_assistance_scopes()?;
    Self::lock_assistance_user(&mut tx, user_id).await?;
    let workspaces: std::collections::BTreeSet<_> = patch
      .workspace_assistance_overrides
      .iter()
      .map(|value| value.workspace_id)
      .chain(
        patch
          .project_assistance_overrides
          .iter()
          .map(|value| value.workspace_id),
      )
      .collect();
    for workspace_id in workspaces {
      Self::lock_assistance_workspace(&mut tx, user_id, workspace_id).await?;
    }
    let mut projects: Vec<_> = patch.project_assistance_overrides.iter().collect();
    projects.sort_by_key(|value| value.project_id);
    for project in projects {
      Self::lock_assistance_project(&mut tx, project.workspace_id, project.project_id, true).await?;
    }

    let record = Self::patch_preferences_in_tx(&mut tx, user_id, patch).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(record)
  }

  /// Return `true` when two users share at least one workspace membership.
  #[instrument(skip_all)]
  async fn has_shared_workspace(&self, user_id1: Uuid, user_id2: Uuid) -> AuthResult<bool> {
    let row = sqlx::query(
      r#"
      SELECT 1
      FROM workspace_memberships m1
      JOIN workspace_memberships m2 ON m1.workspace_id = m2.workspace_id
      JOIN workspaces w ON w.id = m1.workspace_id
        AND w.lifecycle_state = 'active'
        AND w.deleted_at IS NULL
      WHERE m1.user_id = $1 AND m2.user_id = $2
        AND m1.status = 'Accepted' AND m2.status = 'Accepted'
      LIMIT 1
      "#,
    )
    .bind(user_id1)
    .bind(user_id2)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.is_some())
  }

  /// Return the user's accepted role in a workspace, or `None` when they are
  /// not a member.
  #[instrument(skip_all)]
  async fn get_workspace_role(
    &self,
    user_id: Uuid,
    workspace_id: Uuid,
  ) -> AuthResult<Option<myoxus_domain::entities::WorkspaceRole>> {
    let row = sqlx::query(
      r#"
      SELECT m.role
      FROM workspace_memberships m
      JOIN workspaces w ON w.id = m.workspace_id
        AND w.lifecycle_state = 'active'
        AND w.deleted_at IS NULL
      WHERE m.user_id = $1 AND m.workspace_id = $2 AND m.status = 'Accepted'
      LIMIT 1
      "#,
    )
    .bind(user_id)
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.and_then(|r| {
      let role: String = r.get("role");
      match role.as_str() {
        "Owner" => Some(myoxus_domain::entities::WorkspaceRole::Owner),
        "Admin" => Some(myoxus_domain::entities::WorkspaceRole::Admin),
        "Manager" => Some(myoxus_domain::entities::WorkspaceRole::Manager),
        "Collaborator" => Some(myoxus_domain::entities::WorkspaceRole::Collaborator),
        "Commenter" => Some(myoxus_domain::entities::WorkspaceRole::Commenter),
        "Reader" => Some(myoxus_domain::entities::WorkspaceRole::Reader),
        "External" => Some(myoxus_domain::entities::WorkspaceRole::External),
        _ => None,
      }
    }))
  }

  /// Return the user's per-document role, or `None` when no row exists.
  #[instrument(skip_all)]
  async fn get_doc_role(&self, user_id: Uuid, doc_id: Uuid) -> AuthResult<Option<myoxus_domain::entities::DocRole>> {
    let row = sqlx::query(
      r#"
      SELECT role
      FROM doc_user_permissions
      WHERE user_id = $1 AND doc_id = $2
      LIMIT 1
      "#,
    )
    .bind(user_id)
    .bind(doc_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.map(|r| {
      let role: String = r.get("role");
      // INF-RV-01: Complete DocRole mapping matching domain enum.
      match role.to_lowercase().as_str() {
        "owner" => myoxus_domain::entities::DocRole::Owner,
        "manager" => myoxus_domain::entities::DocRole::Manager,
        "editor" => myoxus_domain::entities::DocRole::Editor,
        "commenter" => myoxus_domain::entities::DocRole::Commenter,
        "reader" => myoxus_domain::entities::DocRole::Reader,
        "external" => myoxus_domain::entities::DocRole::External,
        "none" => myoxus_domain::entities::DocRole::None,
        other => {
          tracing::warn!(%user_id, %doc_id, role = other, "unknown doc role in DB, degrading to None");
          myoxus_domain::entities::DocRole::None
        }
      }
    }))
  }

  /// Fetch explicit document-role overrides in one SQL round-trip.
  ///
  /// The empty-input fast path is intentional: callers use this method for
  /// already loaded candidate sets and must not pay for a pointless query.
  #[instrument(skip_all)]
  async fn get_doc_roles_bulk(
    &self,
    user_id: Uuid,
    doc_ids: &[Uuid],
  ) -> AuthResult<HashMap<Uuid, myoxus_domain::entities::DocRole>> {
    if doc_ids.is_empty() {
      return Ok(HashMap::new());
    }

    let rows = sqlx::query(
      r#"
      SELECT doc_id, role
      FROM doc_user_permissions
      WHERE user_id = $1 AND doc_id = ANY($2)
      "#,
    )
    .bind(user_id)
    .bind(doc_ids)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(
      rows
        .into_iter()
        .map(|row| {
          let doc_id: Uuid = row.get("doc_id");
          let role: String = row.get("role");
          let parsed = match role.to_lowercase().as_str() {
            "owner" => myoxus_domain::entities::DocRole::Owner,
            "manager" => myoxus_domain::entities::DocRole::Manager,
            "editor" => myoxus_domain::entities::DocRole::Editor,
            "commenter" => myoxus_domain::entities::DocRole::Commenter,
            "reader" => myoxus_domain::entities::DocRole::Reader,
            "external" => myoxus_domain::entities::DocRole::External,
            "none" => myoxus_domain::entities::DocRole::None,
            other => {
              tracing::warn!(%user_id, %doc_id, role = other, "unknown doc role in bulk DB result, degrading to None");
              myoxus_domain::entities::DocRole::None
            }
          };
          (doc_id, parsed)
        })
        .collect(),
    )
  }

  /// Fetch an OAuth connected account by provider name and provider-side
  /// account ID.
  #[instrument(skip_all)]
  async fn get_connected_account(
    &self,
    provider: &str,
    provider_account_id: &str,
  ) -> AuthResult<Option<ConnectedAccount>> {
    let row = sqlx::query(
      r#"
      SELECT id, user_id, provider, provider_account_id, access_token, refresh_token, expires_at, created_at
      FROM connected_accounts
      WHERE provider = $1 AND provider_account_id = $2
      LIMIT 1
      "#,
    )
    .bind(provider)
    .bind(provider_account_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    row.map(map_connected_account_row).transpose().map_err(Self::map_db_err)
  }

  /// Insert a new OAuth connected account row.
  #[instrument(skip_all)]
  async fn create_connected_account(&self, input: NewConnectedAccount) -> AuthResult<ConnectedAccount> {
    let row = sqlx::query(
      r#"
      INSERT INTO connected_accounts (user_id, provider, provider_account_id, access_token, refresh_token, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, user_id, provider, provider_account_id, access_token, refresh_token, expires_at, created_at
      "#,
    )
    .bind(input.user_id)
    .bind(input.provider)
    .bind(input.provider_account_id)
    .bind(input.access_token)
    .bind(input.refresh_token)
    .bind(input.expires_at)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    map_connected_account_row(row).map_err(Self::map_db_err)
  }

  /// Update the OAuth tokens for an existing connected account.
  #[instrument(skip_all)]
  async fn update_connected_account(
    &self,
    id: Uuid,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<DateTime<Utc>>,
  ) -> AuthResult<()> {
    sqlx::query(
      r#"
      UPDATE connected_accounts
      SET access_token = $2, refresh_token = $3, expires_at = $4, updated_at = now()
      WHERE id = $1
      "#,
    )
    .bind(id)
    .bind(access_token)
    .bind(refresh_token)
    .bind(expires_at)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(())
  }

  /// Insert or replace a magic-link OTP record for `email`, resetting
  /// attempt counters on conflict.
  #[instrument(skip_all)]
  async fn upsert_magic_link_otp(&self, otp: MagicLinkOtp) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let user_id =
      sqlx::query_scalar::<_, Option<Uuid>>("SELECT user_id FROM verification_tokens WHERE id=$1 AND kind='SignIn'")
        .bind(otp.verification_token_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?
        .ok_or(AuthError::InvalidToken)?;
    if let Some(id) = user_id {
      sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id=$1 AND status <> 'deleted' FOR SHARE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?
        .ok_or(AuthError::InvalidToken)?;
    }
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM verification_tokens WHERE id=$1 AND user_id IS NOT DISTINCT FROM $2 AND kind='SignIn' AND used_at IS NULL AND expires_at>now() FOR SHARE")
      .bind(otp.verification_token_id).bind(user_id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?.ok_or(AuthError::InvalidToken)?;
    sqlx::query(
      r#"
      INSERT INTO magic_link_otps (email, otp_hash, verification_token_id, client_nonce, expires_at)
      VALUES (lower($1), $2, $3, $4, $5)
      ON CONFLICT (email) DO UPDATE SET
        otp_hash = EXCLUDED.otp_hash,
        verification_token_id = EXCLUDED.verification_token_id,
        client_nonce = EXCLUDED.client_nonce,
        expires_at = EXCLUDED.expires_at,
        attempts = 0,
        locked_until = NULL,
        consumed_at = NULL,
        created_at = now()
      "#,
    )
    .bind(otp.email)
    .bind(otp.otp) // we store it as is for now, legacy uses plain text OTP
    .bind(otp.verification_token_id)
    .bind(otp.client_nonce)
    .bind(otp.expires_at)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Fetch an unconsumed magic-link OTP for the given email and OTP hash.
  #[instrument(skip_all)]
  async fn get_magic_link_otp(&self, email: &str, otp: &str) -> AuthResult<Option<MagicLinkOtp>> {
    let row = sqlx::query(
      r#"
      SELECT email, otp_hash, verification_token_id, client_nonce, expires_at
      FROM magic_link_otps
      WHERE lower(email) = lower($1) AND otp_hash = $2 AND consumed_at IS NULL
      LIMIT 1
      "#,
    )
    .bind(email)
    .bind(otp)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.map(|r| MagicLinkOtp {
      email: r.get("email"),
      otp: r.get("otp_hash"),
      verification_token_id: r.get("verification_token_id"),
      client_nonce: r.get("client_nonce"),
      expires_at: r.get("expires_at"),
    }))
  }

  /// Resolve binding first without a token lock, then lock user before OTP and
  /// verification token. Revalidation under those locks closes deletion/reuse
  /// and concurrent-consumption races without email fallback for bound codes.
  #[instrument(skip_all)]
  async fn consume_magic_link_otp(
    &self,
    email: &str,
    otp: &str,
    client_nonce: Option<&str>,
    used_at: DateTime<Utc>,
  ) -> AuthResult<AuthUser> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let binding = sqlx::query("SELECT v.id,v.user_id FROM magic_link_otps o JOIN verification_tokens v ON v.id=o.verification_token_id WHERE lower(o.email)=lower($1) AND o.otp_hash=$2 AND o.consumed_at IS NULL AND v.kind='SignIn'")
      .bind(email).bind(otp).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?.ok_or(AuthError::InvalidToken)?;
    let token_id: Uuid = binding.get("id");
    let bound_user: Option<Uuid> = binding.get("user_id");
    let user = if let Some(id) = bound_user {
      let row = sqlx::query("SELECT id,email,name,avatar_key,password_hash,status,is_admin,email_verified_at FROM users WHERE id=$1 AND status <> 'deleted' FOR UPDATE")
        .bind(id).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?.ok_or(AuthError::InvalidToken)?;
      map_user_row(row).map_err(Self::map_db_err)?
    } else {
      Self::fulfill_in_transaction(&mut tx, email, None, None).await?
    };
    let row = sqlx::query("SELECT o.expires_at AS otp_expires,v.expires_at AS token_expires,o.client_nonce FROM magic_link_otps o JOIN verification_tokens v ON v.id=o.verification_token_id WHERE lower(o.email)=lower($1) AND o.otp_hash=$2 AND o.verification_token_id=$3 AND o.consumed_at IS NULL AND v.used_at IS NULL AND v.kind='SignIn' AND v.user_id IS NOT DISTINCT FROM $4 AND lower(v.email)=lower($1) FOR UPDATE OF o,v")
      .bind(email).bind(otp).bind(token_id).bind(bound_user).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?.ok_or(AuthError::InvalidToken)?;
    if row.get::<DateTime<Utc>, _>("otp_expires") <= used_at || row.get::<DateTime<Utc>, _>("token_expires") <= used_at
    {
      return Err(AuthError::ExpiredToken);
    }
    if row.get::<Option<String>, _>("client_nonce").as_deref() != client_nonce {
      return Err(AuthError::ActionForbidden);
    }
    sqlx::query("UPDATE magic_link_otps SET consumed_at=$3 WHERE lower(email)=lower($1) AND otp_hash=$2")
      .bind(email)
      .bind(otp)
      .bind(used_at)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    sqlx::query("UPDATE verification_tokens SET used_at=$2 WHERE id=$1")
      .bind(token_id)
      .bind(used_at)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(user)
  }
}

fn map_suspended_user_row(row: sqlx::postgres::PgRow) -> Result<AuthUserProjection, sqlx::Error> {
  let status: String = row.try_get("status")?;
  Ok(AuthUserProjection {
    id: row.try_get("id")?,
    email: row.try_get("email")?,
    name: row.try_get("name").ok(),
    avatar_url: row.try_get("avatar_key").ok(),
    is_admin: row.try_get("is_admin")?,
    disabled: status != "active",
    email_verified_at: row.try_get("email_verified_at").ok(),
    has_password: row.try_get("has_password")?,
  })
}

fn map_user_row(row: sqlx::postgres::PgRow) -> Result<AuthUser, sqlx::Error> {
  let status: String = row.try_get("status")?;
  Ok(AuthUser {
    id: row.try_get("id")?,
    email: row.try_get("email")?,
    name: row.try_get("name").ok(),
    avatar_url: row.try_get("avatar_key").ok(),
    password_hash: row.try_get("password_hash").ok(),
    is_admin: row.try_get("is_admin")?,
    disabled: status != "active",
    email_verified_at: row.try_get("email_verified_at").ok(),
    registered: true,
  })
}

fn map_session_row(row: sqlx::postgres::PgRow) -> Result<AuthSession, sqlx::Error> {
  Ok(AuthSession {
    id: row.try_get("id")?,
    user_id: row.try_get("user_id")?,
    csrf_token: row.try_get("csrf_token")?,
    user_agent: row.try_get("user_agent").ok(),
    ip_address: row.try_get("ip_address").ok(),
    expires_at: row.try_get("expires_at")?,
    refresh_after: row.try_get("refresh_after")?,
    revoked_at: row.try_get("revoked_at").ok(),
    created_at: row.try_get("created_at")?,
  })
}

fn map_verification_token_row(row: sqlx::postgres::PgRow) -> Result<VerificationToken, sqlx::Error> {
  Ok(VerificationToken {
    id: row.try_get("id")?,
    user_id: row.try_get("user_id").ok(),
    kind: row.try_get("kind")?,
    token_hash: row.try_get("token_hash")?,
    email: row.try_get("email").ok(),
    expires_at: row.try_get("expires_at")?,
    used_at: row.try_get("used_at").ok(),
    created_at: row.try_get("created_at")?,
    extra: row.try_get("extra").ok(),
  })
}

fn map_access_token_row(row: sqlx::postgres::PgRow) -> Result<AccessToken, sqlx::Error> {
  Ok(AccessToken {
    id: row.try_get("id")?,
    user_id: row.try_get("user_id")?,
    name: row.try_get("name")?,
    token_hash: row.try_get("token_hash")?,
    expires_at: row.try_get("expires_at").ok(),
    created_at: row.try_get("created_at")?,
    last_used_at: row.try_get("last_used_at").ok(),
  })
}

fn map_connected_account_row(row: sqlx::postgres::PgRow) -> Result<ConnectedAccount, sqlx::Error> {
  Ok(ConnectedAccount {
    id: row.try_get("id")?,
    user_id: row.try_get("user_id")?,
    provider: row.try_get("provider")?,
    provider_account_id: row.try_get("provider_account_id")?,
    access_token: row.try_get("access_token").ok(),
    refresh_token: row.try_get("refresh_token").ok(),
    expires_at: row.try_get("expires_at").ok(),
    created_at: row.try_get("created_at")?,
  })
}
