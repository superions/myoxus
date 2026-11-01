//! Git Sync application layer.
//!
//! Provides the business logic for bidirectional synchronisation between
//! Myoxus workspaces and external Git repositories.
//!
//! ## Modules
//!
//! - [`backend`] — Port trait for Git repository operations (clone, fetch, commit, push)
//! - [`export`] — Workspace documents to Git files (frontmatter, slugs, paths)
//! - [`import`] — Git files to workspace documents (parsing, classification)
//! - [`projection`] — Deterministic content/structure hashing for change detection
//! - [`reconcile`] — 3-way merge engine (Myoxus vs Git vs Baseline)
//! - [`doc_reconcile_plan`] — pure document reconcile planning for the API engine

pub mod backend;
pub mod bootstrap;
pub mod coordination;
pub mod doc_reconcile_plan;
pub mod export;
pub mod extract_metadata;
pub mod file_reconcile;
pub mod finalization;
pub mod git_token_rotation;
pub mod import;
pub mod lifecycle;
pub mod overview;
pub mod projection;
pub mod reconcile;
pub mod reconciliation;
pub mod remote_commit;
pub mod schedule;
pub mod webhook;

pub use backend::{
  ChangeType, ChangedFile, GitAuth, GitError, GitOperationGuard, GitRemoteProbe, GitRepositoryIdentity,
  GitRepositoryPort, HttpsCertificatePolicy, SshHostKeyPolicy, allows_https_credential_target,
};
pub use coordination::{
  GitSyncCoordinationError, GitSyncNativeOwnership, GitSyncRepositoryCoordination, GitSyncRepositoryGuard,
  GitSyncRepositoryScope,
};
pub use doc_reconcile_plan::DocReconcilePlan;
pub use export::ExportFrontmatter;
pub use file_reconcile::{FileReconcileAction, GitFileEntry};
pub use git_token_rotation::{
  GitTokenCredential, GitTokenCredentialCodec, GitTokenRotationAdmission, GitTokenRotationAttempt,
  GitTokenRotationCodecError, GitTokenRotationConfiguration, GitTokenRotationError, GitTokenRotationProvider,
  GitTokenRotationProviderError, GitTokenRotationProviderFailureKind, GitTokenRotationProviderKind,
  GitTokenRotationProviderRequest, GitTokenRotationProviderResult, GitTokenRotationService, GitTokenRotationState,
  GitTokenRotationStatus, GitTokenRotationStore, GitTokenRotationStoreError,
};
pub use import::{ImportClassification, ImportedDoc};
pub use lifecycle::{
  CreateGitSyncProfile, EncryptedGitCredential, GitConnectionErrorClass, GitConnectionFailure, GitSyncDeleteImpact,
  GitSyncLifecycleError, GitSyncLifecyclePolicy, GitSyncLifecycleService, GitSyncLifecycleStore,
  GitSyncLifecycleStoreError, GitSyncProfilePatch, UpdateGitSyncProfile, validate_repository_url,
};
pub use reconcile::ReconcileAction;
pub use reconciliation::{
  GitSyncBindingAdoption, GitSyncReconciliationCounts, GitSyncReconciliationDocumentIdentity,
  GitSyncReconciliationError, GitSyncReconciliationInventory, GitSyncReconciliationPlan, GitSyncReconciliationReport,
  GitSyncReconciliationService, GitSyncReconciliationStore, GitSyncReconciliationStoreError,
  GitSyncUnresolvedRemoteDocument, ReconciliationDocument,
};
pub use webhook::{
  GitSyncWebhookDelivery, GitSyncWebhookDeliveryAdmission, GitSyncWebhookStore, GitSyncWebhookStoreError,
};
