//! Compile-time catalogue of transaction boundary names.
//!
//! [`TransactionBoundary`] enumerates every distinct database transaction
//! scope that must be enforced in the infrastructure layer.  The
//! [`REQUIRED_TRANSACTION_BOUNDARIES`] slice lets integration tests assert
//! that each boundary is exercised.
//!
//! This module does not implement the transactions themselves; it is used as
//! a shared vocabulary between the application and test layers.

/// A named database transaction scope.
///
/// Each variant corresponds to a concrete multi-statement operation that must
/// be wrapped in a single atomic transaction in the infrastructure
/// implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionBoundary {
  /// Issuing a new auth session (insert session + optional user update).
  AuthSessionIssue,
  /// Refreshing an existing auth session (update session timestamps).
  AuthSessionRefresh,
  /// Creating a workspace together with its root document.
  WorkspaceCreateWithRootDoc,
  /// Accepting a workspace membership invite (update invite + insert member).
  WorkspaceMembershipInviteAccept,
  /// Creating a doc and writing its initial Yjs update.
  DocCreateRootUpdate,
  /// Appending a doc content update (snapshot + update record).
  DocContentUpdate,
  /// Finalising a multipart blob upload (complete + update metadata).
  BlobMultipartFinalize,
  /// Creating a comment and fanning out mention notifications.
  CommentCreateWithNotificationFanout,
  /// Marking a batch of notifications as read.
  NotificationReadBatch,
  /// Linking a calendar account and persisting its initial sync state.
  CalendarAccountLinkAndSyncState,
  /// Appending a copilot message to a session atomically.
  CopilotSessionAndMessageAppend,
  /// Committing every normal Myoxus-side fact after a verified Git push.
  GitSyncPostPushFinalize,
}

/// All transaction boundaries that infrastructure implementations must cover.
pub const REQUIRED_TRANSACTION_BOUNDARIES: &[TransactionBoundary] = &[
  TransactionBoundary::AuthSessionIssue,
  TransactionBoundary::AuthSessionRefresh,
  TransactionBoundary::WorkspaceCreateWithRootDoc,
  TransactionBoundary::WorkspaceMembershipInviteAccept,
  TransactionBoundary::DocCreateRootUpdate,
  TransactionBoundary::DocContentUpdate,
  TransactionBoundary::BlobMultipartFinalize,
  TransactionBoundary::CommentCreateWithNotificationFanout,
  TransactionBoundary::NotificationReadBatch,
  TransactionBoundary::CalendarAccountLinkAndSyncState,
  TransactionBoundary::CopilotSessionAndMessageAppend,
  TransactionBoundary::GitSyncPostPushFinalize,
];
