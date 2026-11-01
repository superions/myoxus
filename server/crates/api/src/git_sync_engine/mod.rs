// SPDX-License-Identifier: AGPL-3.0-or-later
//! Git Sync Engine — orchestrates the full bidirectional sync lifecycle.
//!
//! This module lives in the API crate because it needs access to both
//! infrastructure (SqlxGitSyncStore, Git2Adapter, crypto) and application
//! (reconcile, conversion, export, import) layers. It is consumed by the
//! worker handler in `server.rs`.
//!
//! ## Architecture
//!
//! ```text
//! server.rs (GitSyncQueueHandler)
//!   → runner::run_sync()                    ← single admitted entry point
//!       → repo::prepare()                   ← clone/fetch/reset to authenticated remote
//!       → loader + reconcile planners       ← read-only state and pure decisions
//!       → executor                           ← prepare imports and Git working tree
//!       → application::git_sync::remote_commit
//!                                             ← push plus authenticated remote-ref proof
//!       → executor                           ← staged content-addressed blob promotions
//!       → store::commit_post_push()          ← one SQL transaction for all normal state
//!       → periodic stale-run/blob recovery   ← explicit cross-system reconciliation
//! ```

use std::sync::Arc;

use myoxus_application::git_sync::GitRepositoryPort;
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::GitSyncPolicyConfig;

use self::policy::EffectiveGitSyncPolicy;

/// Builds the policy-bound Git transport used by profile lifecycle operations.
///
/// The builder is a narrow composition seam: production always supplies the
/// git2 implementation, while GraphQL lifecycle tests can replace only the
/// external transport without adding a test mode to product state.
pub trait GitRepositoryBuilder: Send + Sync {
  fn build(
    &self,
    pool: PgPool,
    policy: &EffectiveGitSyncPolicy,
    source: &'static str,
    actor_id: Option<Uuid>,
  ) -> Arc<dyn GitRepositoryPort>;
}

pub struct PolicyBoundGitRepositoryBuilder {
  network_timeout_secs: u64,
  local_timeout_secs: u64,
  clone_depth: u32,
}

impl PolicyBoundGitRepositoryBuilder {
  pub fn new(config: &GitSyncPolicyConfig) -> Self {
    Self {
      network_timeout_secs: config.network_timeout_secs,
      local_timeout_secs: config.local_timeout_secs,
      clone_depth: config.clone_depth,
    }
  }
}

impl GitRepositoryBuilder for PolicyBoundGitRepositoryBuilder {
  fn build(
    &self,
    pool: PgPool,
    policy: &EffectiveGitSyncPolicy,
    source: &'static str,
    actor_id: Option<Uuid>,
  ) -> Arc<dyn GitRepositoryPort> {
    Arc::new(
      myoxus_infrastructure::git_sync::Git2Adapter::with_config(
        self.network_timeout_secs,
        self.local_timeout_secs,
        self.clone_depth,
      )
      .with_ssh_host_key_policy(pool, policy.ssh_host_key_policy, source, actor_id)
      .with_https_certificate_policy(policy.https_certificate_policy, policy.allowed_hosts.iter().cloned()),
    )
  }
}

pub mod conflicts;
pub mod credential;
pub mod dispatch;
pub mod error;
pub mod executor;
pub mod extract_capture;
pub mod extract_metadata;
pub mod loader;
pub mod locking;
pub mod maintenance;
pub mod partial;
pub mod persist;
pub mod policy;
pub mod repo;
pub mod runner;
pub mod scheduler;
