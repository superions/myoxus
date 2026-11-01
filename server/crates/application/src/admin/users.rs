// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

use super::AdminService;
use crate::audit::{AuditActor, AuditCategory, AuditEvent, AuditRecorder, AuditTarget};
use crate::auth::{AuthResult, AuthService};
use crate::workspace::WorkspaceService;
use chrono::{DateTime, Utc};
use myoxus_domain::entities::{AccountStatus, User};
use serde::Serialize;
use tracing::instrument;
use uuid::Uuid;

/// Creation is insert-only, but provisioning spans existing durable operations.
#[derive(Debug, thiserror::Error)]
pub enum AdminUserCreationError {
  #[error("email already used")]
  DuplicateEmail,
  #[error(transparent)]
  Auth(#[from] crate::auth::AuthError),
  /// IDs are safe diagnostics. Never include a password, SQL error or payload.
  #[error("account {user_id} was created; {stage} failed; personal workspace {workspace_state}, id={workspace_id:?}")]
  Partial {
    user_id: Uuid,
    workspace_id: Option<Uuid>,
    workspace_state: &'static str,
    stage: &'static str,
  },
}

/// Administrative account projection. Credentials never cross this boundary.
#[derive(Debug, Clone, Serialize)]
pub struct AdminUserProfile {
  pub id: Uuid,
  pub email: String,
  pub name: String,
  pub avatar_url: Option<String>,
  pub avatar_key: Option<String>,
  pub status: AccountStatus,
  pub is_admin: bool,
  pub registered: bool,
  pub disabled: bool,
  pub has_password: bool,
  pub email_verified_at: Option<DateTime<Utc>>,
  pub created_at: DateTime<Utc>,
  pub updated_at: DateTime<Utc>,
}

impl From<User> for AdminUserProfile {
  fn from(user: User) -> Self {
    Self {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar_url: user.avatar_url,
      avatar_key: user.avatar_key,
      status: user.status,
      is_admin: user.is_admin,
      registered: user.registered,
      disabled: user.disabled,
      has_password: user.password_hash.is_some(),
      email_verified_at: user.email_verified_at,
      created_at: user.created_at,
      updated_at: user.updated_at,
    }
  }
}

/// Shared account administration. Transports retain their authorization guards.
#[derive(Clone)]
pub struct AdminUserService {
  admin: AdminService,
  auth: AuthService,
  workspace: WorkspaceService,
  audit: AuditRecorder,
}

impl AdminUserService {
  pub fn new(admin: AdminService, auth: AuthService, workspace: WorkspaceService, audit: AuditRecorder) -> Self {
    Self {
      admin,
      auth,
      workspace,
      audit,
    }
  }

  /// Permanently delete the account while retaining historical UUID/name.
  /// Audit only that retained identity, never its old email or avatar.
  #[instrument(skip_all, fields(user_id = %user_id))]
  pub async fn delete(
    &self,
    user_id: Uuid,
    mut actor: AuditActor,
    source: &'static str,
  ) -> AuthResult<crate::auth::UserDeletionCommit> {
    let commit = self.auth.delete_account_with_commit(user_id).await?;
    let actor_id = actor.user_id;
    if actor_id == Some(user_id) {
      actor.label = commit.user.name.clone();
    }
    self
      .audit
      .record(
        AuditEvent::mutation(
          "user.delete",
          AuditCategory::User,
          Some(AuditTarget::entity("user", user_id, commit.user.name.clone())),
          actor,
          Some(serde_json::json!({"userId":user_id,"name":commit.user.name})),
          None,
        )
        .with_metadata(serde_json::json!({"source":source,"actor_user_id":actor_id})),
      )
      .await;
    Ok(commit)
  }

  /// Shared administrative role ingress; feature editing retains its distinct
  /// feature audit. The known commit is returned without a fallible reread.
  #[instrument(skip_all, fields(user_id = %user_id))]
  pub async fn set_admin(
    &self,
    user_id: Uuid,
    is_admin: bool,
    actor: AuditActor,
    source: &'static str,
  ) -> AuthResult<crate::auth::UserAdminRoleCommit> {
    let commit = self.auth.set_user_admin_role(user_id, is_admin).await?;
    self
      .audit
      .record(
        AuditEvent::mutation(
          "user.admin-role-set",
          AuditCategory::User,
          Some(AuditTarget::entity("user", user_id, None)),
          actor,
          Some(serde_json::json!({"isAdmin":commit.previous_is_admin})),
          Some(serde_json::json!({"isAdmin":commit.is_admin})),
        )
        .with_metadata(serde_json::json!({"source":source})),
      )
      .await;
    Ok(commit)
  }

  /// Validate before insertion. After admission, partial durable state is kept
  /// and reported; a provisioning failure is neither success nor an account rollback.
  #[instrument(skip_all)]
  pub async fn create(
    &self,
    email: &str,
    name: Option<&str>,
    password: Option<&str>,
    actor: AuditActor,
    source: &'static str,
  ) -> Result<AdminUserProfile, AdminUserCreationError> {
    let email = email.trim().to_lowercase();
    crate::auth::validate_email(&email)?;
    crate::workspace::WorkspaceName::parse(name.unwrap_or("My Workspace"))
      .map_err(|error| crate::auth::AuthError::InvalidInput(error.to_string()))?;
    let password = password.filter(|value| !value.is_empty());
    if let Some(password) = password {
      self.auth.validate_password(password).await?;
    }
    let user = self
      .auth
      .store
      .insert_admin_user(&email, name)
      .await?
      .ok_or(AdminUserCreationError::DuplicateEmail)?;
    let workspace = match self.workspace.ensure_personal_workspace(user.id, name).await {
      Ok(workspace) => workspace,
      Err(_) => {
        // Root initialization and policy seeding can fail after workspace
        // persistence. Read the diagnostic identity without starting a repair.
        let (workspace_id, workspace_state) = match self.workspace.find_personal_workspace(user.id).await {
          Ok(Some(workspace)) => (Some(workspace.id), "persisted"),
          Ok(None) => (None, "absent at diagnostic read"),
          Err(_) => (None, "unknown (diagnostic read failed)"),
        };
        return Err(AdminUserCreationError::Partial {
          user_id: user.id,
          workspace_id,
          workspace_state,
          stage: "provisioning",
        });
      }
    };
    if let Some(password) = password {
      if self.auth.set_user_password(user.id, password).await.is_err() {
        return Err(AdminUserCreationError::Partial {
          user_id: user.id,
          workspace_id: Some(workspace.id),
          workspace_state: "persisted",
          stage: "password setup",
        });
      }
    }
    let profile = match self.get_by_id(user.id).await {
      Ok(Some(profile)) => profile,
      _ => {
        return Err(AdminUserCreationError::Partial {
          user_id: user.id,
          workspace_id: Some(workspace.id),
          workspace_state: "persisted",
          stage: "account readback",
        });
      }
    };
    self
      .audit
      .record(
        AuditEvent::mutation(
          "user.create",
          AuditCategory::User,
          Some(AuditTarget::entity("user", profile.id, Some(profile.email.clone()))),
          actor,
          None,
          Some(serde_json::json!({"email": profile.email, "name": profile.name})),
        )
        .with_metadata(serde_json::json!({"source": source})),
      )
      .await;
    Ok(profile)
  }

  /// Preserve the store's patch semantics: omitted fields, including avatar,
  /// retain their values. Uniqueness is enforced by the same atomic write.
  #[instrument(skip_all)]
  pub async fn update(
    &self,
    user_id: Uuid,
    update: crate::auth::UpdateAuthUser,
    actor: AuditActor,
    source: &'static str,
  ) -> AuthResult<crate::auth::AuthUserProjection> {
    let user = self.auth.store.update_user(user_id, update).await?;
    self
      .audit
      .record(
        AuditEvent::mutation(
          "user.update",
          AuditCategory::User,
          Some(AuditTarget::entity("user", user.id, Some(user.email.clone()))),
          actor,
          None,
          Some(serde_json::json!({"email": user.email, "name": user.name})),
        )
        .with_metadata(serde_json::json!({"source": source})),
      )
      .await;
    Ok(crate::auth::AuthUserProjection::from(&user))
  }

  /// Return the known commit projection without a fallible post-commit read.
  /// The auth owner retains its transaction, epoch barrier and live-session
  /// observer. Re-enabling changes status only; revoked credentials stay revoked.
  #[instrument(skip_all)]
  pub async fn suspend(
    &self,
    user_id: Uuid,
    actor: AuditActor,
    source: &'static str,
  ) -> AuthResult<crate::auth::AuthUserProjection> {
    let commit = self.auth.suspend_user(user_id, Utc::now()).await?;
    self
      .record_status_change(user_id, &commit.user.email, true, actor, source)
      .await;
    Ok(commit.user)
  }

  #[instrument(skip_all)]
  pub async fn enable(
    &self,
    user_id: Uuid,
    actor: AuditActor,
    source: &'static str,
  ) -> AuthResult<crate::auth::AuthUserProjection> {
    let user = self.auth.store.set_user_disabled(user_id, false).await?;
    self
      .record_status_change(user_id, &user.email, false, actor, source)
      .await;
    Ok(crate::auth::AuthUserProjection::from(&user))
  }

  async fn record_status_change(
    &self,
    user_id: Uuid,
    email: &str,
    disabled: bool,
    actor: AuditActor,
    source: &'static str,
  ) {
    self
      .audit
      .record(
        AuditEvent::mutation(
          if disabled { "user.disable" } else { "user.enable" },
          AuditCategory::User,
          Some(AuditTarget::entity("user", user_id, Some(email.to_string()))),
          actor,
          None,
          Some(serde_json::json!({"disabled": disabled})),
        )
        .with_metadata(serde_json::json!({"source": source})),
      )
      .await;
  }

  /// Origin is effective server configuration, never a request header. Callback
  /// validation, token persistence and expiry stay in the canonical auth owner.
  #[instrument(skip_all)]
  pub async fn reset_link(
    &self,
    user_id: Uuid,
    server_origin: &str,
    callback_path: Option<&str>,
    actor: AuditActor,
    source: &'static str,
  ) -> AuthResult<crate::auth::PasswordResetLink> {
    let link = self
      .auth
      .create_password_reset_link(user_id, server_origin, callback_path)
      .await?;
    self
      .audit
      .record(
        AuditEvent::mutation(
          "user.reset-link-created",
          AuditCategory::User,
          Some(AuditTarget::entity("user", user_id, None)),
          actor,
          None,
          None,
        )
        .with_metadata(serde_json::json!({"source": source})),
      )
      .await;
    Ok(link)
  }

  #[instrument(skip_all)]
  pub async fn list(&self, skip: i64, take: i64, keyword: Option<String>) -> AuthResult<Vec<AdminUserProfile>> {
    self
      .admin
      .list_users(skip, take, keyword)
      .await
      .map(|users| users.into_iter().map(Into::into).collect())
  }

  pub async fn count(&self, keyword: Option<String>) -> AuthResult<i64> {
    self.admin.count_users(keyword).await
  }

  /// Exhaust bounded pages for the CLI's established unpaged output.
  /// Timestamp ties use the repository's ID ordering, so later pages are not skipped.
  #[instrument(skip_all)]
  pub async fn list_all(&self, keyword: Option<String>) -> AuthResult<Vec<AdminUserProfile>> {
    const PAGE_SIZE: i64 = 100;
    let mut users = Vec::new();
    loop {
      let page = self.list(users.len() as i64, PAGE_SIZE, keyword.clone()).await?;
      let finished = page.len() < PAGE_SIZE as usize;
      users.extend(page);
      if finished {
        return Ok(users);
      }
    }
  }

  #[instrument(skip_all)]
  pub async fn get_by_id(&self, user_id: Uuid) -> AuthResult<Option<AdminUserProfile>> {
    self
      .admin
      .store
      .get_user_by_id(user_id)
      .await
      .map(|user| user.map(Into::into))
  }

  #[instrument(skip_all)]
  pub async fn get_by_email(&self, email: &str) -> AuthResult<Option<AdminUserProfile>> {
    self
      .admin
      .store
      .get_user_by_email(&email.trim().to_lowercase())
      .await
      .map(|user| user.map(Into::into))
  }
  /// Retain the existing Admin email-read visibility contract (self or shared workspace).
  #[instrument(skip_all)]
  pub async fn get_by_email_for_requester(&self, email: &str, requester: Uuid) -> AuthResult<Option<AdminUserProfile>> {
    let Some(user) = self.get_by_email(email).await? else {
      return Ok(None);
    };
    if user.id == requester || self.auth.store.has_shared_workspace(requester, user.id).await? {
      Ok(Some(user))
    } else {
      Ok(None)
    }
  }
}
