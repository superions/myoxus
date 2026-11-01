//! Infrastructure-layer notes for each required transaction boundary.
//!
//! [`required_boundaries`] re-exports the canonical list from the application
//! crate.  [`TRANSACTION_BOUNDARY_NOTES`] adds implementation-level
//! explanations for the boundaries that require special care.

use myoxus_application::transaction_boundaries::{REQUIRED_TRANSACTION_BOUNDARIES, TransactionBoundary};

/// Return the full set of required transaction boundaries defined in the
/// application crate.
pub fn required_boundaries() -> &'static [TransactionBoundary] {
  REQUIRED_TRANSACTION_BOUNDARIES
}

/// Implementation notes for selected transaction boundaries.
///
/// Each entry is `(boundary_name, explanation)`.  These are used by
/// integration tests and code-review tooling to confirm that the
/// corresponding repository methods use explicit SQLx transactions.
pub const TRANSACTION_BOUNDARY_NOTES: &[(&str, &str)] = &[
  (
    "AuthSessionIssue",
    "Create session and verification side effects atomically.",
  ),
  (
    "WorkspaceCreateWithRootDoc",
    "Workspace record and root document creation must commit together.",
  ),
  (
    "DocCreateRootUpdate",
    "Page insertion and root-document linkage commit as one unit.",
  ),
  (
    "BlobMultipartFinalize",
    "Blob metadata and multipart completion state commit together.",
  ),
  (
    "CommentCreateWithNotificationFanout",
    "Comment write and notification enqueue share one boundary.",
  ),
  (
    "GitSyncPostPushFinalize",
    "Verified remote outcome, synced objects, bindings, baselines, provenance and terminal run state commit together.",
  ),
];
