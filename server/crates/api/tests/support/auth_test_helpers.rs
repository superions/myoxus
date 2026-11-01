// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared setup helpers for auth integration tests.
//!
//! `integration.rs` exposes this file as the crate-root `auth_test_helpers`
//! module. Auth test modules import helpers from that root module so the API
//! integration suite still compiles as one Cargo test binary.

#![allow(dead_code)]

use std::sync::Arc;

use myoxus_api::config::AppConfig;
use myoxus_api::state::ApiState;
use myoxus_application::admin::{AdminService, InMemoryAdminStore};
use myoxus_application::auth::{AuthService, InMemoryAuthStore};
use myoxus_application::doc::{DocService, PanicDocStore};
use myoxus_application::workspace::WorkspaceService;
use myoxus_infrastructure::mail::TestMailAdapter;
use myoxus_infrastructure::storage::StorageAdapter;

#[derive(Debug, Default)]
pub struct MockWorkspaceStore;

#[async_trait::async_trait]
impl myoxus_application::workspace::WorkspaceStore for MockWorkspaceStore {
  async fn has_accepted_member(
    &self,
    _workspace_id: uuid::Uuid,
    _user_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<bool> {
    Err(myoxus_application::auth::AuthError::Storage(
      "member lookup is not provisioned in this auth fixture".into(),
    ))
  }
  async fn accepted_member_by_email(
    &self,
    _workspace_id: uuid::Uuid,
    _email: &str,
  ) -> myoxus_application::auth::AuthResult<Option<uuid::Uuid>> {
    Err(myoxus_application::auth::AuthError::Storage(
      "member lookup is not provisioned in this auth fixture".into(),
    ))
  }
  async fn accepted_members_for_lookup(
    &self,
    _workspace_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Vec<myoxus_domain::entities::WorkspaceMemberLookupRow>> {
    Err(myoxus_application::auth::AuthError::Storage(
      "member lookup is not provisioned in this auth fixture".into(),
    ))
  }

  async fn create_workspace(
    &self,
    owner_id: uuid::Uuid,
    name: myoxus_application::workspace::WorkspaceName,
  ) -> myoxus_application::auth::AuthResult<myoxus_domain::entities::Workspace> {
    Ok(myoxus_domain::entities::Workspace {
      initial_content_policy: Default::default(),
      id: uuid::Uuid::new_v4(),
      owner_user_id: Some(owner_id),
      name: name.display().to_string(),
      description: String::new(),
      overview_settings: Default::default(),
      overview_revision: 0,
      avatar_key: None,
      public: false,
      enable_ai: false,
      enable_sharing: false,
      enable_url_preview: false,
      enable_doc_embedding: false,
      created_at: chrono::Utc::now(),
      updated_at: chrono::Utc::now(),
      deleted_at: None,
    })
  }
  async fn get_workspace(
    &self,
    _workspace_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_domain::entities::Workspace>> {
    Ok(None)
  }
  async fn workspace_classification(
    &self,
    _workspace_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_application::workspace::WorkspaceClassification>> {
    Ok(None)
  }
  async fn list_user_workspaces(
    &self,
    _user_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Vec<myoxus_domain::entities::Workspace>> {
    Ok(vec![])
  }
  async fn update_workspace(
    &self,
    _workspace_id: uuid::Uuid,
    _update: myoxus_application::workspace::UpdateWorkspace,
  ) -> myoxus_application::auth::AuthResult<myoxus_domain::entities::Workspace> {
    unimplemented!()
  }
  async fn delete_workspace(&self, _workspace_id: uuid::Uuid) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }
  async fn list_workspace_members(
    &self,
    _workspace_id: uuid::Uuid,
    _skip: i64,
    _take: i64,
    _query: Option<String>,
  ) -> myoxus_application::auth::AuthResult<Vec<myoxus_domain::entities::WorkspaceMember>> {
    Ok(vec![])
  }
  async fn count_workspace_members(&self, _workspace_id: uuid::Uuid) -> myoxus_application::auth::AuthResult<i64> {
    Ok(0)
  }
  async fn get_workspace_owner(
    &self,
    _workspace_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_domain::entities::User>> {
    Ok(None)
  }
  async fn add_or_update_member(
    &self,
    workspace_id: uuid::Uuid,
    user_id: uuid::Uuid,
    role: myoxus_domain::entities::WorkspaceRole,
    status: myoxus_domain::entities::MembershipStatus,
    _inviter_id: Option<uuid::Uuid>,
  ) -> myoxus_application::auth::AuthResult<myoxus_domain::entities::WorkspaceMember> {
    Ok(myoxus_domain::entities::WorkspaceMember {
      invited_by_user_id: _inviter_id,
      workspace_id,
      user: myoxus_domain::entities::User {
        id: user_id,
        name: "Mock".to_string(),
        email: "mock@test.local".to_string(),
        email_verified_at: None,
        avatar_url: None,
        avatar_key: None,
        password_hash: None,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        status: myoxus_domain::entities::AccountStatus::Active,
        is_admin: false,
        registered: true,
        disabled: false,
      },
      role,
      status,
      invite_id: uuid::Uuid::nil(),
    })
  }
  async fn get_member(
    &self,
    _workspace_id: uuid::Uuid,
    _user_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_domain::entities::WorkspaceMember>> {
    Ok(None)
  }
  async fn get_member_by_invite_id(
    &self,
    _invite_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_domain::entities::WorkspaceMember>> {
    Ok(None)
  }
  async fn delete_member(
    &self,
    _workspace_id: uuid::Uuid,
    _user_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }
  async fn update_member_role(
    &self,
    _workspace_id: uuid::Uuid,
    _user_id: uuid::Uuid,
    _role: myoxus_domain::entities::WorkspaceRole,
  ) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }
  async fn transfer_ownership(
    &self,
    _workspace_id: uuid::Uuid,
    _current_owner_id: uuid::Uuid,
    _new_owner_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }
  async fn create_invite_link(
    &self,
    _workspace_id: uuid::Uuid,
    _inviter_id: uuid::Uuid,
    _token_hash: &str,
    _expire_at: chrono::DateTime<chrono::Utc>,
  ) -> myoxus_application::auth::AuthResult<myoxus_domain::entities::WorkspaceInviteLink> {
    unimplemented!()
  }
  async fn get_invite_link(
    &self,
    _workspace_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_domain::entities::WorkspaceInviteLink>> {
    Ok(None)
  }
  async fn get_invite_link_by_token(
    &self,
    _token_hash: &str,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_domain::entities::WorkspaceInviteLink>> {
    Ok(None)
  }
  async fn revoke_invite_link(&self, _workspace_id: uuid::Uuid) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }
  async fn init_workspace_root_doc(
    &self,
    _workspace_id: uuid::Uuid,
    _user_id: uuid::Uuid,
    _data: Vec<u8>,
  ) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }
  async fn workspace_root_doc_exists(&self, _workspace_id: uuid::Uuid) -> myoxus_application::auth::AuthResult<bool> {
    Ok(false)
  }
  async fn list_orphaned_workspaces(
    &self,
    _skip: i64,
    _take: i64,
  ) -> myoxus_application::auth::AuthResult<Vec<myoxus_domain::entities::Workspace>> {
    Ok(vec![])
  }
  async fn count_orphaned_workspaces(&self) -> myoxus_application::auth::AuthResult<i64> {
    Ok(0)
  }
  async fn reassign_workspace_owner(
    &self,
    _workspace_id: uuid::Uuid,
    _new_owner_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<()> {
    Ok(())
  }
  async fn find_personal_workspace(
    &self,
    _user_id: uuid::Uuid,
  ) -> myoxus_application::auth::AuthResult<Option<myoxus_domain::entities::Workspace>> {
    Ok(None)
  }
}

pub async fn setup_test_app_with_config(
  config: AppConfig,
) -> (axum::Router, Arc<InMemoryAuthStore>, Arc<TestMailAdapter>) {
  setup_test_app_with_config_and_storage(config, "./test-storage").await
}

pub async fn setup_test_app_with_config_and_storage(
  config: AppConfig,
  storage_root: &str,
) -> (axum::Router, Arc<InMemoryAuthStore>, Arc<TestMailAdapter>) {
  let store = Arc::new(InMemoryAuthStore::default());
  let template_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../templates/mail");
  let mailer = Arc::new(
    TestMailAdapter::new_with_templates(template_dir)
      .expect("complete mail catalog")
      .with_rendering_config(config.server.origin.clone(), config.i18n.default_locale.clone()),
  );
  let storage = Arc::new(StorageAdapter::new_fs(storage_root).expect("test storage should initialise"));

  let auth_service = AuthService::new_with_token_ttls(
    store.clone(),
    mailer.clone(),
    storage.clone(),
    config.server.session_ttl,
    config.server.session_ttr,
    config.server.magic_link_ttl_seconds,
    config.auth.password_reset_ttl_seconds,
  )
  .expect("test AppConfig must contain valid auth token TTLs")
  .with_mail_defaults(myoxus_application::auth::UserPreferenceDefaults {
    locale: config.i18n.default_locale.clone(),
    ..Default::default()
  });
  let workspace_store = Arc::new(MockWorkspaceStore);
  let workspace_service = WorkspaceService::new(workspace_store);
  let admin_service = AdminService::new(Arc::new(InMemoryAdminStore));
  let doc_service = DocService::new(Arc::new(PanicDocStore));
  let blob_store = Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(
    sqlx::PgPool::connect_lazy("postgres://localhost").expect("lazy PgPool should construct"),
  ));
  let blob_service = Arc::new(myoxus_application::ports::blob_service::BlobService::new(
    blob_store,
    storage.clone(),
    "test-key".to_string(),
  ));

  let state = ApiState::with_services(
    config,
    auth_service,
    workspace_service,
    admin_service,
    doc_service,
    blob_service,
    storage,
  );
  (myoxus_api::build_router_for_integration_tests(state), store, mailer)
}

pub async fn setup_test_app() -> (axum::Router, Arc<InMemoryAuthStore>, Arc<TestMailAdapter>) {
  setup_test_app_with_config(AppConfig::load().expect("AppConfig::load should succeed")).await
}

/// Build a [`myoxus_application::auth::NewSession`] with sensible defaults.
/// `csrf_token` must be unique per test to avoid cross-test interference.
pub fn make_session(user_id: uuid::Uuid, csrf_token: &str) -> myoxus_application::auth::NewSession {
  myoxus_application::auth::NewSession {
    id: uuid::Uuid::new_v4(),
    user_id,
    csrf_token: csrf_token.to_string(),
    user_agent: None,
    ip_address: None,
    expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
    refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
    created_at: chrono::Utc::now(),
  }
}
