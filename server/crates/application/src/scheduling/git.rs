// SPDX-License-Identifier: AGPL-3.0-or-later
//! Current native Git policy at the shared admission boundary. Configuration
//! resolution stays with the same owner used by Git requests and workers.
use crate::{auth::AuthResult, git_sync::GitSyncLifecyclePolicy};

#[async_trait::async_trait]
pub trait ScheduledGitPolicySource: Send + Sync {
  /// Resolve a coherent current policy, not a startup-only permission snapshot.
  async fn policy(&self) -> AuthResult<GitSyncLifecyclePolicy>;
}
