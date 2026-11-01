// SPDX-License-Identifier: AGPL-3.0-or-later
//! Sync engine error types, classified for the worker's retry logic.

use myoxus_application::git_sync::GitError;
use uuid::Uuid;

/// Strongly-typed kind of a git-side failure.
///
/// ROB-24: Mirrors [`myoxus_application::git_sync::GitError`] without the
/// embedded message so the variant carries the classification through
/// the conversion to [`SyncError`]. Previously `SyncError::Git` flattened
/// every `GitError` variant into a single `message: String` field, which
/// forced [`SyncError::to_error_class`] to do fragile substring matching
/// on the message text (`"auth"`, `"network"`, …) — false positives on
/// the substring `"author"` and case-sensitivity were the visible
/// symptoms; the deeper problem was that we already knew the variant at
/// the git2-adapter layer and threw it away on the way up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitErrorKind {
  /// libgit2 reported `git2::ErrorClass::Net` / `Http` (DNS, TCP,
  /// HTTP/HTTPS protocol-level failures) or an SSH transport problem
  /// that wasn't an authentication denial.
  Network,
  /// Authentication denied: invalid token / SSH key rejected /
  /// credentials-already-tried by libgit2.
  Auth,
  /// HTTPS certificate chain, validity, or hostname verification failed.
  Tls,
  /// Repository corruption, missing references, malformed configs.
  Repository,
  /// File / object not found in the repo or working tree.
  NotFound,
  /// Merge or push conflict (non-fast-forward, three-way conflict).
  Conflict,
  /// Other / unclassified internal failure.
  Internal,
}

impl GitErrorKind {
  /// Classify a [`GitError`] without losing the variant information.
  /// Single source of truth for the GitError-variant ↔ kind mapping;
  /// any new GitError variant must extend this match.
  pub fn from_git_error(e: &GitError) -> Self {
    match e {
      GitError::Auth(_) => Self::Auth,
      GitError::Network(_) => Self::Network,
      GitError::Tls(_) => Self::Tls,
      GitError::Repository(_) => Self::Repository,
      GitError::NotFound(_) => Self::NotFound,
      GitError::Conflict(_) => Self::Conflict,
      GitError::Internal(_) => Self::Internal,
    }
  }

  /// Map to the domain error class persisted on the run record.
  pub fn to_domain_class(self) -> myoxus_domain::git_sync::ErrorClass {
    match self {
      Self::Auth => myoxus_domain::git_sync::ErrorClass::GitAuth,
      Self::Network => myoxus_domain::git_sync::ErrorClass::GitNetwork,
      Self::Tls | Self::Conflict | Self::Repository | Self::NotFound | Self::Internal => {
        myoxus_domain::git_sync::ErrorClass::InternalError
      }
    }
  }
}

/// Errors from the sync engine.
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
  /// Temporary failure — worker should retry after backoff.
  /// Examples: network timeout, temporary lock, push rejected (non-fast-forward).
  #[error("retryable: {message} [profile={profile_id}, phase={phase}]")]
  Retryable {
    message: String,
    profile_id: Uuid,
    phase: &'static str,
  },

  /// Permanent failure — worker should NOT retry.
  /// Examples: auth failure, corrupt credential, invalid profile, schema mismatch.
  #[error("permanent: {message} [profile={profile_id}, phase={phase}]")]
  Permanent {
    message: String,
    profile_id: Uuid,
    phase: &'static str,
  },

  /// Profile is already being synced by another worker instance.
  #[error("profile {0} is already syncing — will retry after backoff")]
  AlreadySyncing(Uuid),

  /// Database error during state loading or persistence.
  #[error("database: {message} [phase={phase}]")]
  Database { message: String, phase: &'static str },

  /// A remote-mutating operation returned without a trustworthy ref
  /// observation. The run must remain `Running` until authenticated stale-run
  /// reconciliation determines whether the remote moved.
  #[error("remote outcome unknown: {message} [profile={profile_id}, intended_oid={intended_oid}, phase={phase}]")]
  RemoteOutcomeUnknown {
    message: String,
    profile_id: Uuid,
    intended_oid: String,
    phase: &'static str,
  },

  /// Git operation failed.
  ///
  /// `kind` carries the structured classification (ROB-24). Match on
  /// `kind` for retry decisions / domain-class mapping; never on
  /// `message` substring.
  #[error("git: {kind:?}: {message} [phase={phase}]")]
  Git {
    kind: GitErrorKind,
    message: String,
    phase: &'static str,
  },

  /// Markdown/Yjs conversion failure.
  #[error("conversion: {0}")]
  Conversion(String),
}

impl SyncError {
  /// Whether the worker should retry this error.
  ///
  /// Only a transport failure that remains classified as `Network` is known
  /// to be retryable. Authentication, TLS, repository integrity, missing
  /// refs/files, conflicts and internal/resource failures require changed
  /// input or operator action; replaying the same attempt may otherwise
  /// destroy recovery evidence or hammer a permanently invalid mirror.
  pub fn is_retryable(&self) -> bool {
    match self {
      Self::Retryable { .. } | Self::AlreadySyncing(_) | Self::Database { .. } => true,
      Self::Git { kind, .. } => matches!(kind, GitErrorKind::Network),
      Self::RemoteOutcomeUnknown { .. } => false,
      Self::Permanent { .. } | Self::Conversion(_) => false,
    }
  }

  /// Map to the domain error class for the run record.
  ///
  /// ROB-24: Uses the structured `GitErrorKind` instead of substring
  /// matching on the rendered message. This eliminates false positives
  /// (e.g. `"author-not-found"` would previously have matched the
  /// `"auth"` substring rule) and sidesteps language-dependent error
  /// text from libgit2 / OS-level system errors.
  pub fn to_error_class(&self) -> myoxus_domain::git_sync::ErrorClass {
    match self {
      Self::Retryable { .. } => myoxus_domain::git_sync::ErrorClass::InternalError,
      Self::Permanent { .. } => myoxus_domain::git_sync::ErrorClass::InternalError,
      Self::AlreadySyncing(_) => myoxus_domain::git_sync::ErrorClass::InternalError,
      Self::Database { .. } => myoxus_domain::git_sync::ErrorClass::InternalError,
      Self::RemoteOutcomeUnknown { .. } => myoxus_domain::git_sync::ErrorClass::InternalError,
      Self::Git { kind, .. } => kind.to_domain_class(),
      Self::Conversion(_) => myoxus_domain::git_sync::ErrorClass::ImportError,
    }
  }

  // ── Convenience constructors ────────────────────────────────────────

  pub fn retryable(msg: impl Into<String>, profile_id: Uuid, phase: &'static str) -> Self {
    Self::Retryable {
      message: msg.into(),
      profile_id,
      phase,
    }
  }

  pub fn permanent(msg: impl Into<String>, profile_id: Uuid, phase: &'static str) -> Self {
    Self::Permanent {
      message: msg.into(),
      profile_id,
      phase,
    }
  }

  /// Construct a `SyncError::Git` with an explicit kind. Use the
  /// `From<GitError>` impl when you have a `GitError` in hand —
  /// this constructor is for synthetic git-side failures that don't
  /// originate from a libgit2 call (rare).
  pub fn git_kind(kind: GitErrorKind, msg: impl Into<String>, phase: &'static str) -> Self {
    Self::Git {
      kind,
      message: msg.into(),
      phase,
    }
  }

  /// Preserve the typed adapter cause while adding operation context.
  /// Callers must use this at the boundary where the phase is known instead
  /// of formatting `GitError` into an untyped string first.
  pub fn from_git_error(error: GitError, context: impl AsRef<str>, phase: &'static str) -> Self {
    if let GitError::Internal(message) = &error
      && message.contains("resource exhaustion")
    {
      return Self::Permanent {
        message: format!("{}: {error}", context.as_ref()),
        profile_id: uuid::Uuid::nil(),
        phase,
      };
    }
    let kind = GitErrorKind::from_git_error(&error);
    Self::Git {
      kind,
      message: format!("{}: {error}", context.as_ref()),
      phase,
    }
  }

  pub fn database(msg: impl Into<String>, phase: &'static str) -> Self {
    Self::Database {
      message: msg.into(),
      phase,
    }
  }
}

impl From<sqlx::Error> for SyncError {
  fn from(e: sqlx::Error) -> Self {
    Self::Database {
      message: e.to_string(),
      phase: "unknown",
    }
  }
}

impl From<myoxus_application::git_sync::GitError> for SyncError {
  fn from(e: myoxus_application::git_sync::GitError) -> Self {
    Self::from_git_error(e, "git operation", "git_operation")
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Each `GitError` variant maps to a deterministic `GitErrorKind`.
  /// This test pins the mapping so a future variant addition forces an
  /// update to the match in `from_git_error`.
  #[test]
  fn git_error_kind_covers_all_git_error_variants() {
    use myoxus_application::git_sync::GitError;
    let cases: &[(GitError, GitErrorKind)] = &[
      (GitError::Auth("x".into()), GitErrorKind::Auth),
      (GitError::Network("x".into()), GitErrorKind::Network),
      (GitError::Tls("x".into()), GitErrorKind::Tls),
      (GitError::Repository("x".into()), GitErrorKind::Repository),
      (GitError::NotFound("x".into()), GitErrorKind::NotFound),
      (GitError::Conflict("x".into()), GitErrorKind::Conflict),
      (GitError::Internal("x".into()), GitErrorKind::Internal),
    ];
    for (input, expected) in cases {
      let got = GitErrorKind::from_git_error(input);
      assert_eq!(
        got, *expected,
        "GitErrorKind::from_git_error({input:?}) = {got:?}, expected {expected:?}"
      );
    }
  }

  /// `to_error_class` derives the domain class from `GitErrorKind`,
  /// not from message substring. Verifies the map is faithful.
  #[test]
  fn to_error_class_is_kind_driven_not_substring_driven() {
    use myoxus_domain::git_sync::ErrorClass;
    // An auth message that ALSO contains "network" must still map to
    // GitAuth — the substring-driven implementation would have
    // misclassified it as GitNetwork.
    let err = SyncError::Git {
      kind: GitErrorKind::Auth,
      message: "authentication denied while fetching from network host".into(),
      phase: "fetch",
    };
    assert_eq!(err.to_error_class(), ErrorClass::GitAuth);

    // Conversely a network message that contains "auth-" (e.g. a
    // dotted path "git/auth-server.example.com") must still map to
    // GitNetwork.
    let err = SyncError::Git {
      kind: GitErrorKind::Network,
      message: "could not resolve auth-server.example.com".into(),
      phase: "fetch",
    };
    assert_eq!(err.to_error_class(), ErrorClass::GitNetwork);
  }

  /// Only an explicitly classified network failure is retryable.
  #[test]
  fn auth_tls_and_conflict_are_not_retryable_other_git_kinds_are() {
    let auth = SyncError::Git {
      kind: GitErrorKind::Auth,
      message: "x".into(),
      phase: "fetch",
    };
    assert!(!auth.is_retryable());

    let tls = SyncError::Git {
      kind: GitErrorKind::Tls,
      message: "x".into(),
      phase: "fetch",
    };
    assert!(!tls.is_retryable());

    let conflict = SyncError::Git {
      kind: GitErrorKind::Conflict,
      message: "x".into(),
      phase: "merge",
    };
    assert!(!conflict.is_retryable());

    for terminal_kind in [GitErrorKind::Repository, GitErrorKind::NotFound, GitErrorKind::Internal] {
      let e = SyncError::Git {
        kind: terminal_kind,
        message: "x".into(),
        phase: "fetch",
      };
      assert!(
        !e.is_retryable(),
        "{terminal_kind:?} must remain terminal without known transient transport evidence"
      );
    }

    let network = SyncError::Git {
      kind: GitErrorKind::Network,
      message: "x".into(),
      phase: "fetch",
    };
    assert!(network.is_retryable());
  }

  #[test]
  fn contextual_conversion_preserves_auth_kind_and_phase() {
    let error = SyncError::from_git_error(
      GitError::Auth("denied".into()),
      "fetch existing mirror",
      "prepare_fetch",
    );
    assert!(matches!(
      error,
      SyncError::Git {
        kind: GitErrorKind::Auth,
        phase: "prepare_fetch",
        ..
      }
    ));
    assert_eq!(error.to_error_class(), myoxus_domain::git_sync::ErrorClass::GitAuth);
    assert!(!error.is_retryable());
  }

  /// Resource-exhaustion `GitError::Internal` becomes `Permanent`
  /// (ROB-19) — must survive the ROB-24 refactor.
  #[test]
  fn rob19_resource_exhaustion_is_still_permanent() {
    use myoxus_application::git_sync::GitError;
    let e: SyncError = GitError::Internal("resource exhaustion: disk full".into()).into();
    assert!(matches!(e, SyncError::Permanent { .. }));
  }
}

/// Outcome of executing a single action.
#[derive(Debug)]
pub enum ActionOutcome {
  /// Action executed successfully.
  Success,
  /// Action failed but sync continues (partial failure). Contains the error message.
  PartialFailure(String),
  /// Action was skipped (e.g. by direction policy).
  Skipped,
}
