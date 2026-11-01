//! Git Sync infrastructure — git2 (libgit2 bindings) adapter for
//! [`GitRepositoryPort`](myoxus_application::git_sync::GitRepositoryPort)
//! and SQLx-backed persistence store.

pub mod ca_bundle;
pub mod coordination;
pub mod git2_adapter;
pub mod gitlab_token_rotation;
pub mod mirror;
pub mod ssh_host_keys;
pub mod store;
pub mod token_rotation;

pub use coordination::PgGitSyncRepositoryCoordination;
pub use git2_adapter::{Git2Adapter, drop_all_stashes, reset_to_remote, stash_if_dirty};
pub use gitlab_token_rotation::GitLabTokenRotationAdapter;
pub use mirror::{
  MirrorCleanupInventory, MirrorDirectoryGuard, MirrorLockError, MirrorPathState, MirrorStorageError, StagedMirror,
  StagingCleanupCandidate, StagingOwnership, acquire_profile_mirror, create_staged_mirror, inspect_cleanup_inventory,
  inspect_profile_mirror, publish_staged_mirror, remove_canonical_mirror, remove_staging_candidate,
};
pub use myoxus_application::git_sync::GitSyncNativeOwnership;
pub use ssh_host_keys::{
  GitSyncSshHostKey, ObservedSshHostKey, PreparedSshHostKeyCheck, SshHostKeyDecision, SshHostKeyRuntime,
  SshRemoteEndpoint, decide_ssh_host_key, fingerprint_sha256, fingerprint_sha256_from_digest,
  ssh_endpoint_from_repo_url,
};
pub use store::{GitSyncResult, GitSyncStoreError, PendingGitSyncDispatch, SqlxGitSyncStore};
pub use token_rotation::GitSyncTokenCredentialCodec;
