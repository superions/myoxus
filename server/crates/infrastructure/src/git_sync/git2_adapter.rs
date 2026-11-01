//! [`GitRepositoryPort`] implementation backed by git2 (libgit2).
//!
//! git2 is a Rust binding to libgit2 — a portable, pure C implementation of
//! the Git core methods.  All git2 calls are blocking, so we wrap them in
//! [`tokio::task::spawn_blocking`] to avoid starving the async runtime.
//!
//! This adapter replaces an earlier hybrid (gix-rs + CLI fallback)
//! implementation with a single, unified native library. Production sync does
//! not shell out to the git CLI.

use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use sqlx::PgPool;
use tokio::sync::Mutex;
use tracing::{debug, instrument, trace, warn};

use myoxus_application::git_sync::{
  ChangeType, ChangedFile, GitAuth, GitError, GitOperationGuard, GitRemoteProbe, GitRepositoryIdentity,
  GitRepositoryPort, HttpsCertificatePolicy, SshHostKeyPolicy, allows_https_credential_target,
};
use myoxus_domain::git_sync::RepoPath;

use super::ssh_host_keys::{
  PreparedSshHostKeyCheck, SshHostKeyRuntime, fingerprint_sha256, fingerprint_sha256_from_digest,
  ssh_endpoint_from_repo_url,
};
use super::store::SqlxGitSyncStore;

/// git2-backed implementation of [`GitRepositoryPort`].
///
/// Holds an optional path to the local repository.  Call `clone_repo` or
/// `open_repo` before any other operation.
#[derive(Debug)]
pub struct Git2Adapter {
  /// Path to the local working tree.  Set by `clone_repo` / `open_repo`.
  repo_path: Arc<Mutex<Option<PathBuf>>>,
  /// Physical ownership cloned into every native writer. The opaque port type
  /// keeps filesystem locking in Infrastructure while making cancellation
  /// lifetime explicit at the adapter boundary.
  operation_guard: Arc<Mutex<Option<Arc<dyn GitOperationGuard>>>>,
  /// Timeout for network operations (clone, fetch, push).
  pub network_timeout: std::time::Duration,
  /// Timeout for local operations (checkout, commit, status).
  pub local_timeout: std::time::Duration,
  /// Shallow clone/fetch depth. The server config validates positive values;
  /// constructors still clamp to `1` as the adapter's last safety line.
  pub clone_depth: u32,
  ssh_host_key_runtime: Option<Git2SshHostKeyRuntime>,
  https_certificate_policy: HttpsCertificatePolicy,
  allowed_https_hosts: Arc<HashSet<String>>,
}

impl Git2Adapter {
  /// Create a new adapter with default timeouts.
  pub fn new() -> Self {
    Self {
      repo_path: Arc::new(Mutex::new(None)),
      operation_guard: Arc::new(Mutex::new(None)),
      network_timeout: GIT_NETWORK_TIMEOUT,
      local_timeout: GIT_LOCAL_TIMEOUT,
      clone_depth: 1,
      ssh_host_key_runtime: None,
      https_certificate_policy: HttpsCertificatePolicy::Strict,
      allowed_https_hosts: Arc::new(HashSet::new()),
    }
  }

  /// Create a new adapter with custom timeouts.
  pub fn with_timeouts(network_secs: u64, local_secs: u64) -> Self {
    Self {
      repo_path: Arc::new(Mutex::new(None)),
      operation_guard: Arc::new(Mutex::new(None)),
      network_timeout: std::time::Duration::from_secs(network_secs),
      local_timeout: std::time::Duration::from_secs(local_secs),
      clone_depth: 1,
      ssh_host_key_runtime: None,
      https_certificate_policy: HttpsCertificatePolicy::Strict,
      allowed_https_hosts: Arc::new(HashSet::new()),
    }
  }

  /// Create a new adapter with custom timeouts and clone/fetch depth.
  pub fn with_config(network_secs: u64, local_secs: u64, clone_depth: u32) -> Self {
    Self {
      repo_path: Arc::new(Mutex::new(None)),
      operation_guard: Arc::new(Mutex::new(None)),
      network_timeout: std::time::Duration::from_secs(network_secs),
      local_timeout: std::time::Duration::from_secs(local_secs),
      clone_depth: clone_depth.max(1),
      ssh_host_key_runtime: None,
      https_certificate_policy: HttpsCertificatePolicy::Strict,
      allowed_https_hosts: Arc::new(HashSet::new()),
    }
  }

  /// Enable persistent SSH host-key verification for subsequent network calls.
  pub fn with_ssh_host_key_policy(
    mut self,
    pool: PgPool,
    policy: SshHostKeyPolicy,
    source: impl Into<String>,
    created_by: Option<uuid::Uuid>,
  ) -> Self {
    self.ssh_host_key_runtime = Some(Git2SshHostKeyRuntime {
      pool,
      runtime: SshHostKeyRuntime {
        policy,
        source: source.into(),
        created_by,
      },
    });
    self
  }

  /// Configure the HTTPS certificate policy for subsequent network calls.
  ///
  /// The adapter normalizes the allowlist and the shared policy decision fails
  /// closed when it is empty. This keeps direct adapter call sites safe even
  /// if invalid configuration bypasses the Admin API.
  pub fn with_https_certificate_policy(
    mut self,
    policy: HttpsCertificatePolicy,
    allowed_hosts: impl IntoIterator<Item = String>,
  ) -> Self {
    self.https_certificate_policy = policy;
    self.allowed_https_hosts = Arc::new(
      allowed_hosts
        .into_iter()
        .map(|host| host.trim().to_ascii_lowercase())
        .filter(|host| !host.is_empty())
        .collect(),
    );
    self
  }

  /// Return the repo path, or an error if not initialised.
  async fn repo_path(&self) -> Result<PathBuf, GitError> {
    self
      .repo_path
      .lock()
      .await
      .clone()
      .ok_or_else(|| GitError::Repository("repository not opened — call clone_repo or open_repo first".into()))
  }

  async fn operation_guard(&self) -> Option<Arc<dyn GitOperationGuard>> {
    self.operation_guard.lock().await.clone()
  }

  async fn prepare_ssh_host_key_check(&self, remote_url: &str) -> Result<Option<PreparedSshHostKeyCheck>, GitError> {
    let Some(runtime) = &self.ssh_host_key_runtime else {
      return Ok(None);
    };
    let Some(endpoint) = ssh_endpoint_from_repo_url(remote_url) else {
      return Ok(None);
    };
    let store = SqlxGitSyncStore::new(runtime.pool.clone());
    let known = store
      .list_enabled_ssh_host_keys_for_endpoint(&endpoint.host, endpoint.port)
      .await
      .map_err(|e| GitError::Internal(format!("load SSH host keys: {e}")))?;
    Ok(Some(PreparedSshHostKeyCheck::new(
      endpoint,
      runtime.runtime.clone(),
      known,
    )))
  }

  async fn persist_observed_ssh_host_keys(&self, check: Option<&PreparedSshHostKeyCheck>) -> Result<(), GitError> {
    let (Some(runtime), Some(check)) = (&self.ssh_host_key_runtime, check) else {
      return Ok(());
    };
    if runtime.runtime.policy == SshHostKeyPolicy::InsecureNoVerify {
      return Ok(());
    }
    let observed = check.observed();
    if observed.is_empty() {
      return Ok(());
    }
    let store = SqlxGitSyncStore::new(runtime.pool.clone());
    for key in observed {
      store
        .record_ssh_host_key_seen(&key)
        .await
        .map_err(|e| GitError::Internal(format!("persist SSH host key: {e}")))?;
    }
    Ok(())
  }

  async fn origin_url_for_repo_path(repo_path: PathBuf) -> Result<Option<String>, GitError> {
    tokio::task::spawn_blocking(move || {
      let repo = git2::Repository::open(&repo_path).map_err(git2_to_git_error)?;
      let remote = repo.find_remote("origin").map_err(git2_to_git_error)?;
      let url = remote.url().map_err(git2_to_git_error)?;
      Ok(Some(url.to_owned()))
    })
    .await
    .map_err(|e| GitError::Internal(format!("join error: {e}")))?
  }
}

#[derive(Debug, Clone)]
struct Git2SshHostKeyRuntime {
  pool: PgPool,
  runtime: SshHostKeyRuntime,
}

impl Default for Git2Adapter {
  fn default() -> Self {
    Self::new()
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Default timeout for git network operations (clone, fetch, push).
const GIT_NETWORK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// Default timeout for git local operations (checkout, commit, status).
const GIT_LOCAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Clone, Copy)]
enum NativeTimeoutClass {
  Network,
  Local,
}

/// Run a native Git operation under a Tokio supervisor. Dropping the caller
/// drops only its wait handle: the blocking closure retains mirror and branch
/// ownership until libgit2 returns, even after an async timeout.
async fn run_native_writer<T, F>(
  timeout: std::time::Duration,
  operation: &'static str,
  timeout_class: NativeTimeoutClass,
  guard: Option<Arc<dyn GitOperationGuard>>,
  writer: F,
) -> Result<T, GitError>
where
  T: Send + 'static,
  F: FnOnce() -> Result<T, GitError> + Send + 'static,
{
  let native = tokio::task::spawn_blocking(move || {
    let _guard = guard;
    writer()
  });
  let mut supervisor = tokio::spawn(async move { native.await });
  match tokio::time::timeout(timeout, &mut supervisor).await {
    Ok(Ok(Ok(result))) => result,
    Ok(Ok(Err(error))) => Err(GitError::Internal(format!("{operation} worker join error: {error}"))),
    Ok(Err(error)) => Err(GitError::Internal(format!("{operation} supervisor failed: {error}"))),
    Err(_) => {
      warn!(
        operation,
        timeout_seconds = timeout.as_secs(),
        "native Git operation exceeded its deadline; joining before releasing ownership"
      );
      match supervisor.await {
        Ok(Ok(_)) | Ok(Err(_)) => {}
        Err(error) => {
          return Err(GitError::Internal(format!(
            "{operation} supervisor failed after deadline: {error}"
          )));
        }
      }
      let message = format!("{operation} timed out after {}s", timeout.as_secs());
      Err(match timeout_class {
        NativeTimeoutClass::Network => GitError::Network(message),
        NativeTimeoutClass::Local => GitError::Internal(message),
      })
    }
  }
}

/// Serialisable auth data that can be sent to `spawn_blocking`.
///
/// `GitAuth` contains `Vec<u8>` and `String` which are `Send`, so we clone it
/// before moving into the blocking closure.
#[derive(Clone)]
struct AuthData {
  inner: GitAuth,
}

impl AuthData {
  fn new(auth: &GitAuth) -> Self {
    Self { inner: auth.clone() }
  }

  /// Write an SSH key to a temp file and return the temp dir + path.
  ///
  /// The temp dir must be kept alive for the duration of the git operation.
  fn prepare_ssh_key(&self) -> Result<Option<(tempfile::TempDir, PathBuf)>, GitError> {
    if let GitAuth::SshKey { ref private_key, .. } = self.inner {
      let temp_dir =
        tempfile::tempdir().map_err(|e| GitError::Internal(format!("failed to create temp dir for SSH key: {e}")))?;
      let key_path = temp_dir.path().join("id_key");
      std::fs::write(&key_path, private_key)
        .map_err(|e| GitError::Internal(format!("failed to write SSH key file: {e}")))?;
      std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| GitError::Internal(format!("failed to set SSH key permissions: {e}")))?;
      Ok(Some((temp_dir, key_path)))
    } else {
      Ok(None)
    }
  }

  /// Set up credentials callback on a `RemoteCallbacks`.
  ///
  /// For SSH auth, `ssh_key_path` must point to the temp key file.
  fn configure_callbacks<'a>(
    &self,
    callbacks: &mut git2::RemoteCallbacks<'a>,
    ssh_key_path: Option<PathBuf>,
    ssh_host_key_check: Option<PreparedSshHostKeyCheck>,
    https_certificate_policy: HttpsCertificatePolicy,
    allowed_https_hosts: Arc<HashSet<String>>,
  ) {
    let allowed_https_hosts_for_certificates = Arc::clone(&allowed_https_hosts);
    callbacks.certificate_check(move |cert, hostname| {
      if cert.as_x509().is_some() {
        if https_certificate_policy.allows_invalid_certificate(hostname, &allowed_https_hosts_for_certificates) {
          warn!(
            hostname,
            policy = https_certificate_policy.as_str(),
            "git-sync HTTPS certificate verification bypassed for explicitly allowed host"
          );
          return Ok(git2::CertificateCheckStatus::CertificateOk);
        }
        // rust-git2 does not expose libgit2's native `valid` callback bit.
        // Passthrough preserves that one verifier's result: valid chains stay
        // valid and failed chains still fail. It is not a second verifier or a
        // fallback acceptance boundary.
        return Ok(git2::CertificateCheckStatus::CertificatePassthrough);
      }
      if let Some(hostkey) = cert.as_hostkey() {
        let key_type = hostkey
          .hostkey_type()
          .map(|key_type| key_type.name().to_string())
          .unwrap_or_else(|| "unknown".to_string());
        let fingerprint = hostkey
          .hash_sha256()
          .map(fingerprint_sha256_from_digest)
          .or_else(|| hostkey.hostkey().map(fingerprint_sha256))
          .ok_or_else(|| git2::Error::from_str("SSH host key did not expose SHA256 or raw key material"))?;

        let Some(check) = &ssh_host_key_check else {
          return Err(git2::Error::from_str(
            "SSH host key verification is not configured for this Git-Sync transport",
          ));
        };
        check
          .check_host_key(hostname, &key_type, &fingerprint)
          .map_err(|e| git2::Error::from_str(&e.to_string()))?;
        return Ok(git2::CertificateCheckStatus::CertificateOk);
      }
      Ok(git2::CertificateCheckStatus::CertificatePassthrough)
    });

    let auth = self.inner.clone();
    let used = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    callbacks.credentials(move |url, username_from_url, _allowed_types| {
      if used.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return Err(git2::Error::from_str(
          "authentication failed — credentials already tried",
        ));
      }
      match &auth {
        GitAuth::HttpsToken { username, token } => {
          if !allows_https_credential_target(url, &allowed_https_hosts) {
            return Err(https_credential_target_denied());
          }
          if username.is_empty() || token.is_empty() {
            return Err(git2::Error::from_str(
              "Git sync credentials are not configured. Set token/password in the git sync profile.",
            ));
          }
          git2::Cred::userpass_plaintext(username, token)
        }
        GitAuth::HttpsPassword { username, password } => {
          if !allows_https_credential_target(url, &allowed_https_hosts) {
            return Err(https_credential_target_denied());
          }
          if username.is_empty() || password.is_empty() {
            return Err(git2::Error::from_str(
              "Git sync credentials are not configured. Set token/password in the git sync profile.",
            ));
          }
          git2::Cred::userpass_plaintext(username, password)
        }
        GitAuth::SshKey { passphrase, .. } => {
          let user = username_from_url.unwrap_or("git");
          let kp = ssh_key_path.as_ref().expect("SSH key path must be set for SshKey auth");
          git2::Cred::ssh_key(user, None, kp, passphrase.as_deref())
        }
        GitAuth::None => {
          let is_http_target = url
            .split_once(':')
            .is_some_and(|(scheme, _)| scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https"));
          if is_http_target && !allows_https_credential_target(url, &allowed_https_hosts) {
            return Err(https_credential_target_denied());
          }
          git2::Cred::default()
        }
      }
    });
  }
}

fn https_credential_target_denied() -> git2::Error {
  git2::Error::from_str("authentication denied: HTTPS credential target is not allowed by administrator policy")
}

/// Map a git2 error to the appropriate [`GitError`] variant.
///
/// All error messages are scrubbed of credentials before being returned.
fn classify_git2_error(e: &git2::Error) -> GitError {
  let scrubbed = scrub_credentials(e.message());
  let lower = scrubbed.to_lowercase();

  // Concrete libgit2 codes and callback evidence are more specific than the
  // broad transport class. HTTP 401/403 and credential-callback denials may
  // otherwise arrive as `Http`/`Net` and become retryable network failures.
  match e.code() {
    git2::ErrorCode::Auth => return GitError::Auth(scrubbed),
    git2::ErrorCode::Certificate => return GitError::Tls(scrubbed),
    git2::ErrorCode::NotFound => return GitError::NotFound(scrubbed),
    git2::ErrorCode::Conflict | git2::ErrorCode::MergeConflict | git2::ErrorCode::NotFastForward => {
      return GitError::Conflict(scrubbed);
    }
    _ => {}
  }

  if lower.contains("certificate verification")
    || lower.contains("certificate verify")
    || lower.contains("ssl certificate")
    || lower.contains("tls certificate")
  {
    return GitError::Tls(scrubbed);
  }
  if lower.contains("authentication")
    || lower.contains("could not read username")
    || lower.contains("invalid credentials")
    || lower.contains("permission denied")
    || lower.contains("credentials already tried")
  {
    return GitError::Auth(scrubbed);
  }

  match e.class() {
    git2::ErrorClass::Ssl => GitError::Tls(scrubbed),
    git2::ErrorClass::Ssh => {
      if lower.contains("publickey") {
        GitError::Auth(scrubbed)
      } else {
        GitError::Network(scrubbed)
      }
    }
    git2::ErrorClass::Net | git2::ErrorClass::Http => GitError::Network(scrubbed),
    _ => {
      if lower.contains("could not resolve host")
        || lower.contains("unable to access")
        || lower.contains("connection refused")
        || lower.contains("network")
      {
        GitError::Network(scrubbed)
      } else if lower.contains("conflict") || lower.contains("merge") {
        GitError::Conflict(scrubbed)
      } else if lower.contains("no space left")
        || lower.contains("disk quota")
        || lower.contains("cannot allocate memory")
        || lower.contains("out of memory")
      {
        GitError::Internal(format!("resource exhaustion (disk/memory): {scrubbed}"))
      } else {
        GitError::Repository(scrubbed)
      }
    }
  }
}

/// Convert a `git2::Error` into a `GitError`.
///
/// Note: We cannot implement `From<git2::Error> for GitError` due to the
/// orphan rule (neither type is defined in this crate). Use this function
/// or `classify_git2_error` instead.
fn git2_to_git_error(e: git2::Error) -> GitError {
  classify_git2_error(&e)
}

fn shallow_depth_for_remote_url(url: &str, clone_depth: u32) -> Option<i32> {
  let normalized = url.trim();
  if normalized.is_empty()
    || normalized.starts_with("file://")
    || normalized.starts_with('/')
    || normalized.starts_with("./")
    || normalized.starts_with("../")
  {
    return None;
  }

  Some(clone_depth.max(1) as i32)
}

/// Scrub credentials (tokens, passwords, private keys) from error messages.
///
/// Replaces credentials embedded in URLs (https://user:SECRET@host) with
/// `https://***:***@host` and redacts common secret patterns (GitHub PATs,
/// GitLab PATs, Bearer tokens).
fn scrub_credentials(msg: &str) -> String {
  let mut result = msg.to_string();

  // Scrub credentials in URLs: https://user:pass@host → https://***:***@host
  for scheme in &["https://", "http://", "ssh://"] {
    let mut out = String::new();
    let mut remaining = result.as_str();
    while let Some(scheme_pos) = remaining.find(scheme) {
      out.push_str(&remaining[..scheme_pos]);
      let after_scheme = scheme_pos + scheme.len();
      if let Some(at_rel) = remaining[after_scheme..].find('@') {
        let at_pos = after_scheme + at_rel;
        if remaining[after_scheme..at_pos].contains(':') {
          out.push_str(scheme);
          out.push_str("***:***@");
          remaining = &remaining[at_pos + 1..];
        } else {
          out.push_str(&remaining[scheme_pos..after_scheme]);
          remaining = &remaining[after_scheme..];
        }
      } else {
        out.push_str(&remaining[scheme_pos..after_scheme]);
        remaining = &remaining[after_scheme..];
      }
    }
    out.push_str(remaining);
    result = out;
  }

  // Redact GitHub PATs (ghp_...), GitLab PATs (glpat-...), GitHub App tokens (github_pat_...)
  for prefix in &["ghp_", "glpat-", "github_pat_"] {
    let mut out = String::new();
    let mut remaining = result.as_str();
    while let Some(pos) = remaining.find(prefix) {
      out.push_str(&remaining[..pos]);
      let after = &remaining[pos..];
      let end = after
        .find(|c: char| c.is_whitespace() || c == '\'' || c == '"' || c == ')' || c == ']')
        .unwrap_or(after.len());
      out.push_str("***");
      remaining = &after[end..];
    }
    out.push_str(remaining);
    result = out;
  }

  // Redact Bearer tokens (case-insensitive) — LOW-08: scrub all occurrences.
  // Build lower once and scan forward, advancing past each replaced token to
  // avoid re-scanning the replacement "***" in an infinite loop.
  {
    let lower = result.to_lowercase();
    let mut new_result = String::new();
    let mut last_end = 0usize;
    let mut search_start = 0usize;
    loop {
      match lower[search_start..].find("bearer ") {
        None => break,
        Some(rel_pos) => {
          let pos = search_start + rel_pos;
          let token_start = pos + 7; // skip "bearer "
          let token_end = result[token_start..]
            .find(|c: char| c.is_whitespace() || c == '\'' || c == '"')
            .map(|i| token_start + i)
            .unwrap_or(result.len());
          new_result.push_str(&result[last_end..token_start]);
          new_result.push_str("***");
          last_end = token_end;
          search_start = token_end; // advance past the consumed token
        }
      }
    }
    new_result.push_str(&result[last_end..]);
    result = new_result;
  }

  result
}

fn safe_worktree_path(repo_root: &Path, path: &str) -> Result<PathBuf, GitError> {
  let repo_path = RepoPath::new(path.to_string())
    .map_err(|reason| GitError::Repository(format!("invalid repository path '{path}': {reason}")))?;
  let mut full_path = repo_root.to_path_buf();
  for component in Path::new(repo_path.as_str()).components() {
    match component {
      Component::Normal(segment) => {
        if segment == ".git" {
          return Err(GitError::Repository(format!(
            "repository path must not enter .git metadata: {path}"
          )));
        }
        full_path.push(segment);
        if let Ok(meta) = std::fs::symlink_metadata(&full_path)
          && meta.file_type().is_symlink()
        {
          return Err(GitError::Repository(format!(
            "repository path traverses a symlink and is not safe: {path}"
          )));
        }
      }
      Component::CurDir => {}
      _ => {
        return Err(GitError::Repository(format!(
          "repository path contains an unsupported component: {path}"
        )));
      }
    }
  }
  Ok(full_path)
}

// ─── Trait implementation ────────────────────────────────────────────────────

#[async_trait]
impl GitRepositoryPort for Git2Adapter {
  async fn retain_operation_guard(&self, guard: Arc<dyn GitOperationGuard>) -> Result<(), GitError> {
    *self.operation_guard.lock().await = Some(guard);
    Ok(())
  }

  #[instrument(skip(self, auth), fields(url = %url, branch))]
  async fn probe_remote(&self, url: &str, branch: Option<&str>, auth: &GitAuth) -> Result<GitRemoteProbe, GitError> {
    let url_owned = url.to_string();
    let branch_owned = branch.map(str::to_string);
    let auth_data = AuthData::new(auth);
    let network_timeout = self.network_timeout;
    let ssh_host_key_check = self.prepare_ssh_host_key_check(&url_owned).await?;
    let ssh_host_key_check_for_callback = ssh_host_key_check.clone();
    let https_certificate_policy = self.https_certificate_policy;
    let allowed_https_hosts = Arc::clone(&self.allowed_https_hosts);

    let probe = run_native_writer(
      network_timeout,
      "remote probe",
      NativeTimeoutClass::Network,
      self.operation_guard().await,
      move || {
        let ssh_result = auth_data.prepare_ssh_key()?;
        let ssh_key_path = ssh_result.as_ref().map(|(_, path)| path.clone());
        let mut callbacks = git2::RemoteCallbacks::new();
        auth_data.configure_callbacks(
          &mut callbacks,
          ssh_key_path,
          ssh_host_key_check_for_callback,
          https_certificate_policy,
          allowed_https_hosts,
        );
        let mut remote = git2::Remote::create_detached(url_owned.as_bytes().to_vec()).map_err(git2_to_git_error)?;
        let connection = remote
          .connect_auth(git2::Direction::Fetch, Some(callbacks), None)
          .map_err(git2_to_git_error)?;
        let observed_remote_oid = match branch_owned.as_deref() {
          Some(branch) => {
            let reference = format!("refs/heads/{branch}");
            Some(
              connection
                .list()
                .map_err(git2_to_git_error)?
                .iter()
                .find(|head| head.name() == reference)
                .map(|head| head.oid().to_string())
                .ok_or_else(|| GitError::Repository(format!("remote did not advertise {reference}")))?,
            )
          }
          None => None,
        };
        Ok::<_, GitError>(GitRemoteProbe {
          branch: branch_owned,
          observed_remote_oid,
        })
      },
    )
    .await?;
    self.persist_observed_ssh_host_keys(ssh_host_key_check.as_ref()).await?;
    Ok(probe)
  }

  #[instrument(skip(self, auth), fields(url = %url, branch = %branch))]
  async fn clone_repo(&self, url: &str, path: &Path, branch: &str, auth: &GitAuth) -> Result<(), GitError> {
    let path_buf = path.to_path_buf();
    let branch_owned = branch.to_string();
    let url_owned = url.to_string();
    let network_timeout = self.network_timeout;
    let clone_depth = self.clone_depth.max(1);
    let auth_data = AuthData::new(auth);
    let ssh_host_key_check = self.prepare_ssh_host_key_check(&url_owned).await?;
    let ssh_host_key_check_for_callback = ssh_host_key_check.clone();
    let https_certificate_policy = self.https_certificate_policy;
    let allowed_https_hosts = Arc::clone(&self.allowed_https_hosts);

    let operation_guard = self.operation_guard().await;
    let cloned_path = run_native_writer(
      network_timeout,
      "git clone",
      NativeTimeoutClass::Network,
      operation_guard,
      move || {
        // Ensure parent directory exists.
        if let Some(parent) = path_buf.parent() {
          std::fs::create_dir_all(parent).map_err(|e| GitError::Internal(format!("mkdir failed: {e}")))?;
        }

        trace!(branch = %branch_owned, "cloning repository (credentials redacted)");

        // Prepare SSH key if needed (temp dir must live through the clone).
        let ssh_result = auth_data.prepare_ssh_key()?;
        let ssh_key_path = ssh_result.as_ref().map(|(_, p)| p.clone());

        let mut callbacks = git2::RemoteCallbacks::new();
        auth_data.configure_callbacks(
          &mut callbacks,
          ssh_key_path,
          ssh_host_key_check_for_callback,
          https_certificate_policy,
          allowed_https_hosts,
        );

        let mut fetch_opts = git2::FetchOptions::new();
        fetch_opts.remote_callbacks(callbacks);
        if let Some(depth) = shallow_depth_for_remote_url(&url_owned, clone_depth) {
          // libgit2 applies shallow depth through FetchOptions, including
          // RepoBuilder clone. Local file remotes cannot shallow-fetch, so the
          // transport decision is explicit instead of silently breaking tests
          // and local seed repos.
          fetch_opts.depth(depth);
        }

        let mut builder = git2::build::RepoBuilder::new();
        builder.fetch_options(fetch_opts);
        builder.branch(&branch_owned);

        let _repo = builder.clone(&url_owned, &path_buf).map_err(git2_to_git_error)?;

        // Auth is passed via callbacks, not embedded in the URL,
        // so the stored remote URL is already the bare (non-authed) URL.

        debug!("clone succeeded");
        // _ssh_result dropped here — temp key file cleaned up.
        Ok::<PathBuf, GitError>(path_buf)
      },
    )
    .await?;
    self.persist_observed_ssh_host_keys(ssh_host_key_check.as_ref()).await?;

    *self.repo_path.lock().await = Some(cloned_path);
    debug!("repository cloned and opened");
    Ok(())
  }

  #[instrument(skip(self, auth), fields(url = %url, branch = %branch))]
  async fn clone_repo_full(&self, url: &str, path: &Path, branch: &str, auth: &GitAuth) -> Result<(), GitError> {
    let path_buf = path.to_path_buf();
    let branch_owned = branch.to_string();
    let url_owned = url.to_string();
    let network_timeout = self.network_timeout;
    let auth_data = AuthData::new(auth);
    let ssh_host_key_check = self.prepare_ssh_host_key_check(&url_owned).await?;
    let ssh_host_key_check_for_callback = ssh_host_key_check.clone();
    let https_certificate_policy = self.https_certificate_policy;
    let allowed_https_hosts = Arc::clone(&self.allowed_https_hosts);

    let cloned_path = run_native_writer(
      network_timeout,
      "full git clone",
      NativeTimeoutClass::Network,
      None,
      move || {
        if let Some(parent) = path_buf.parent() {
          std::fs::create_dir_all(parent).map_err(|error| GitError::Internal(format!("mkdir failed: {error}")))?;
        }
        let ssh_result = auth_data.prepare_ssh_key()?;
        let ssh_key_path = ssh_result.as_ref().map(|(_, path)| path.clone());
        let mut callbacks = git2::RemoteCallbacks::new();
        auth_data.configure_callbacks(
          &mut callbacks,
          ssh_key_path,
          ssh_host_key_check_for_callback,
          https_certificate_policy,
          allowed_https_hosts,
        );
        let mut fetch_options = git2::FetchOptions::new();
        fetch_options.remote_callbacks(callbacks);
        let mut builder = git2::build::RepoBuilder::new();
        builder.fetch_options(fetch_options);
        builder.branch(&branch_owned);
        builder.clone(&url_owned, &path_buf).map_err(git2_to_git_error)?;
        Ok::<PathBuf, GitError>(path_buf)
      },
    )
    .await?;
    self.persist_observed_ssh_host_keys(ssh_host_key_check.as_ref()).await?;
    *self.repo_path.lock().await = Some(cloned_path);
    Ok(())
  }

  #[instrument(skip(self))]
  async fn open_repo(&self, path: &Path) -> Result<(), GitError> {
    let path_buf = path.to_path_buf();

    tokio::task::spawn_blocking(move || {
      let _repo = git2::Repository::open(&path_buf)
        .map_err(|e| GitError::Repository(format!("failed to open repository at {}: {e}", path_buf.display())))?;
      debug!("repository opened via git2");
      Ok::<(), GitError>(())
    })
    .await
    .map_err(|e| GitError::Internal(format!("join error: {e}")))??;

    *self.repo_path.lock().await = Some(path.to_path_buf());
    Ok(())
  }

  async fn repository_identity(&self) -> Result<GitRepositoryIdentity, GitError> {
    let repo_path = self.repo_path().await?;
    tokio::task::spawn_blocking(move || {
      let repo = git2::Repository::open(&repo_path).map_err(git2_to_git_error)?;
      let workdir = repo
        .workdir()
        .ok_or_else(|| GitError::Repository("managed mirror is bare and has no worktree".to_string()))?;
      let workdir = std::fs::canonicalize(workdir)
        .map_err(|error| GitError::Repository(format!("canonicalize managed worktree: {error}")))?;
      let origin = repo
        .find_remote("origin")
        .map_err(|error| GitError::Repository(format!("managed mirror has no readable origin remote: {error}")))?;
      let origin_url = origin
        .url()
        .map_err(|error| GitError::Repository(format!("managed mirror origin has no URL: {error}")))?
        .to_string();
      let head = repo
        .head()
        .map_err(|error| GitError::Repository(format!("managed mirror has no readable HEAD: {error}")))?;
      let head_branch = head
        .shorthand()
        .map_err(|error| GitError::Repository(format!("read managed mirror branch name: {error}")))?;
      if head_branch.is_empty() {
        return Err(GitError::Repository(
          "managed mirror HEAD is detached or unnamed".to_string(),
        ));
      }
      let head_branch = head_branch.to_string();
      let commit = head
        .peel_to_commit()
        .map_err(|error| GitError::Repository(format!("managed mirror HEAD is not a readable commit: {error}")))?;
      let tree = commit
        .tree()
        .map_err(|error| GitError::Repository(format!("managed mirror HEAD tree is unreadable: {error}")))?;
      Ok(GitRepositoryIdentity {
        workdir,
        origin_url,
        head_branch,
        head_oid: commit.id().to_string(),
        head_tree_oid: tree.id().to_string(),
      })
    })
    .await
    .map_err(|error| GitError::Internal(format!("repository identity worker failed: {error}")))?
  }

  #[instrument(skip(self, auth))]
  async fn fetch(&self, auth: &GitAuth) -> Result<(), GitError> {
    let repo_path = self.repo_path().await?;
    let auth_data = AuthData::new(auth);
    let network_timeout = self.network_timeout;
    let clone_depth = self.clone_depth.max(1);
    let remote_url = Self::origin_url_for_repo_path(repo_path.clone()).await?;
    let ssh_host_key_check = if let Some(url) = remote_url.as_deref() {
      self.prepare_ssh_host_key_check(url).await?
    } else {
      None
    };
    let ssh_host_key_check_for_callback = ssh_host_key_check.clone();
    let https_certificate_policy = self.https_certificate_policy;
    let allowed_https_hosts = Arc::clone(&self.allowed_https_hosts);

    let operation_guard = self.operation_guard().await;
    run_native_writer(
      network_timeout,
      "git fetch",
      NativeTimeoutClass::Network,
      operation_guard,
      move || {
        let repo = git2::Repository::open(&repo_path).map_err(git2_to_git_error)?;
        let mut remote = repo.find_remote("origin").map_err(git2_to_git_error)?;

        let ssh_result = auth_data.prepare_ssh_key()?;
        let ssh_key_path = ssh_result.as_ref().map(|(_, p)| p.clone());

        let mut callbacks = git2::RemoteCallbacks::new();
        auth_data.configure_callbacks(
          &mut callbacks,
          ssh_key_path,
          ssh_host_key_check_for_callback,
          https_certificate_policy,
          allowed_https_hosts,
        );

        let mut fetch_opts = git2::FetchOptions::new();
        fetch_opts.remote_callbacks(callbacks);
        if let Ok(remote_url) = remote.url()
          && let Some(depth) = shallow_depth_for_remote_url(remote_url, clone_depth)
        {
          // Re-apply the same shallow depth on later network fetches so mirror
          // growth is bounded consistently after the initial clone. Local file
          // remotes intentionally stay full because libgit2 rejects shallow
          // local transport fetches.
          fetch_opts.depth(depth);
        }

        remote
          .fetch(&["refs/heads/*:refs/remotes/origin/*"], Some(&mut fetch_opts), None)
          .map_err(git2_to_git_error)?;
        debug!("fetch completed");
        Ok::<(), GitError>(())
      },
    )
    .await?;
    self.persist_observed_ssh_host_keys(ssh_host_key_check.as_ref()).await?;
    Ok(())
  }

  #[instrument(skip(self))]
  async fn checkout_branch(&self, branch: &str) -> Result<(), GitError> {
    let repo_path = self.repo_path().await?;
    let branch_owned = branch.to_string();
    let local_timeout = self.local_timeout;

    let operation_guard = self.operation_guard().await;
    run_native_writer(
      local_timeout,
      "git checkout",
      NativeTimeoutClass::Local,
      operation_guard,
      move || {
        let repo = git2::Repository::open(&repo_path).map_err(git2_to_git_error)?;

        let local_ref = format!("refs/heads/{branch_owned}");
        let remote_ref = format!("refs/remotes/origin/{branch_owned}");

        let target_oid = if let Ok(reference) = repo.find_reference(&local_ref) {
          reference.peel_to_commit().map_err(git2_to_git_error)?.id()
        } else if let Ok(reference) = repo.find_reference(&remote_ref) {
          let commit = reference.peel_to_commit().map_err(git2_to_git_error)?;
          let oid = commit.id();
          repo.branch(&branch_owned, &commit, false).map_err(git2_to_git_error)?;
          oid
        } else {
          return Err(GitError::Repository(format!(
            "branch '{branch_owned}' not found locally or in origin"
          )));
        };

        repo.set_head(&local_ref).map_err(git2_to_git_error)?;

        let obj = repo.find_object(target_oid, None).map_err(git2_to_git_error)?;
        repo
          .checkout_tree(&obj, Some(git2::build::CheckoutBuilder::default().force()))
          .map_err(git2_to_git_error)?;

        debug!(branch = %branch_owned, "branch checked out");
        Ok::<(), GitError>(())
      },
    )
    .await
  }

  #[instrument(skip(self), fields(branch = %branch))]
  async fn reset_to_remote(&self, branch: &str) -> Result<String, GitError> {
    let repo_path = self.repo_path().await?;
    let branch = branch.to_string();
    let local_timeout = self.local_timeout;
    let operation_guard = self.operation_guard().await;
    run_native_writer(
      local_timeout,
      "git reset to remote",
      NativeTimeoutClass::Local,
      operation_guard,
      move || reset_to_remote(&repo_path, &branch),
    )
    .await
  }

  async fn stash_if_dirty(&self) -> Result<bool, GitError> {
    let repo_path = self.repo_path().await?;
    let operation_guard = self.operation_guard().await;
    run_native_writer(
      self.local_timeout,
      "git stash",
      NativeTimeoutClass::Local,
      operation_guard,
      move || stash_if_dirty(&repo_path),
    )
    .await
  }

  async fn drop_all_stashes(&self) -> Result<(), GitError> {
    let repo_path = self.repo_path().await?;
    let operation_guard = self.operation_guard().await;
    run_native_writer(
      self.local_timeout,
      "git stash cleanup",
      NativeTimeoutClass::Local,
      operation_guard,
      move || {
        drop_all_stashes(&repo_path);
        Ok(())
      },
    )
    .await
  }

  #[instrument(skip(self))]
  async fn head_oid(&self) -> Result<String, GitError> {
    let repo_path = self.repo_path().await?;

    tokio::task::spawn_blocking(move || {
      let repo = git2::Repository::open(&repo_path).map_err(|e| GitError::Repository(format!("open failed: {e}")))?;
      let head = repo
        .head()
        .map_err(|e| GitError::Repository(format!("HEAD has no id: {e}")))?;
      let oid = head
        .target()
        .ok_or_else(|| GitError::Repository("HEAD is not a direct reference".into()))?;
      let oid_str = oid.to_string();
      trace!(oid = %oid_str, "read HEAD OID");
      Ok(oid_str)
    })
    .await
    .map_err(|e| GitError::Internal(format!("join error: {e}")))?
  }

  #[instrument(skip(self))]
  async fn commit_is_ancestor(&self, ancestor_oid: &str, descendant_oid: &str) -> Result<bool, GitError> {
    let repo_path = self.repo_path().await?;
    let ancestor = ancestor_oid.to_string();
    let descendant = descendant_oid.to_string();
    let local_timeout = self.local_timeout;
    match tokio::time::timeout(
      local_timeout,
      tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(repo_path).map_err(git2_to_git_error)?;
        let ancestor = git2::Oid::from_str(&ancestor).map_err(git2_to_git_error)?;
        let descendant = git2::Oid::from_str(&descendant).map_err(git2_to_git_error)?;
        if ancestor == descendant {
          return Ok(true);
        }
        if repo.find_commit(ancestor).is_err() || repo.find_commit(descendant).is_err() {
          return Ok(false);
        }
        repo
          .graph_descendant_of(descendant, ancestor)
          .map_err(git2_to_git_error)
      }),
    )
    .await
    {
      Ok(result) => result.map_err(|error| GitError::Internal(format!("join error: {error}")))?,
      Err(_) => Err(GitError::Internal(format!(
        "commit reachability check timed out after {}s",
        local_timeout.as_secs()
      ))),
    }
  }

  #[instrument(skip(self, auth), fields(branch = %branch))]
  async fn remote_branch_oid(&self, branch: &str, auth: &GitAuth) -> Result<String, GitError> {
    let repo_path = self.repo_path().await?;
    let remote_url = Self::origin_url_for_repo_path(repo_path)
      .await?
      .ok_or_else(|| GitError::Repository("origin remote has no URL".to_string()))?;
    self
      .probe_remote(&remote_url, Some(branch), auth)
      .await?
      .observed_remote_oid
      .ok_or_else(|| GitError::Repository("branch probe returned no remote OID".to_string()))
  }

  #[instrument(skip(self))]
  async fn changed_files(&self, from: Option<&str>, to: Option<&str>) -> Result<Vec<ChangedFile>, GitError> {
    let repo_path = self.repo_path().await?;
    let from_owned = from.map(String::from);
    let to_owned = to.map(String::from);

    tokio::task::spawn_blocking(move || {
      let repo = git2::Repository::open(&repo_path).map_err(git2_to_git_error)?;

      let diff = match (from_owned.as_deref(), to_owned.as_deref()) {
        (Some(f), Some(t)) => {
          let old_oid = git2::Oid::from_str(f).map_err(git2_to_git_error)?;
          let new_oid = git2::Oid::from_str(t).map_err(git2_to_git_error)?;
          let old_tree = repo
            .find_commit(old_oid)
            .map_err(git2_to_git_error)?
            .tree()
            .map_err(git2_to_git_error)?;
          let new_tree = repo
            .find_commit(new_oid)
            .map_err(git2_to_git_error)?
            .tree()
            .map_err(git2_to_git_error)?;
          repo
            .diff_tree_to_tree(Some(&old_tree), Some(&new_tree), None)
            .map_err(git2_to_git_error)?
        }
        (Some(f), None) => {
          let old_oid = git2::Oid::from_str(f).map_err(git2_to_git_error)?;
          let old_tree = repo
            .find_commit(old_oid)
            .map_err(git2_to_git_error)?
            .tree()
            .map_err(git2_to_git_error)?;
          let head_tree = repo
            .head()
            .map_err(git2_to_git_error)?
            .peel_to_tree()
            .map_err(git2_to_git_error)?;
          repo
            .diff_tree_to_tree(Some(&old_tree), Some(&head_tree), None)
            .map_err(git2_to_git_error)?
        }
        (None, None) => {
          // ROB-22: untracked files must appear in the diff. By default
          // `diff_tree_to_workdir_with_index(_, None)` excludes them
          // because git2's default DiffOptions has `include_untracked = false`.
          // The git_sync engine consumes this output to decide "do we
          // have something to commit?" — without untracked-file
          // inclusion a freshly-written file via `write_file()` would be
          // invisible, and commit_and_push would short-circuit on
          // `pending.is_empty()` before the actual commit (which
          // auto-stages untracked files via `add_all`). Inconsistency
          // → silent skip in production sync paths that add new files.
          let head_tree = repo
            .head()
            .map_err(git2_to_git_error)?
            .peel_to_tree()
            .map_err(git2_to_git_error)?;
          let mut opts = git2::DiffOptions::new();
          opts.include_untracked(true).recurse_untracked_dirs(true);
          repo
            .diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut opts))
            .map_err(git2_to_git_error)?
        }
        (None, Some(_)) => {
          return Err(GitError::Repository(
            "'from' must be specified if 'to' is specified".into(),
          ));
        }
      };

      let mut files = Vec::new();
      for delta in diff.deltas() {
        let change_type = match delta.status() {
          git2::Delta::Added | git2::Delta::Untracked => ChangeType::Added,
          git2::Delta::Modified => ChangeType::Modified,
          git2::Delta::Deleted => ChangeType::Deleted,
          git2::Delta::Renamed => ChangeType::Renamed,
          git2::Delta::Copied => ChangeType::Added,
          _ => {
            warn!(status = ?delta.status(), "unknown git diff status, treating as Modified");
            ChangeType::Modified
          }
        };

        let path = if change_type == ChangeType::Renamed || delta.status() == git2::Delta::Copied {
          delta
            .new_file()
            .path()
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .to_string()
        } else if delta.status() == git2::Delta::Deleted {
          delta
            .old_file()
            .path()
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .to_string()
        } else {
          delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .to_string()
        };

        let old_path = if change_type == ChangeType::Renamed {
          delta.old_file().path().map(|p| p.to_string_lossy().to_string())
        } else {
          None
        };

        files.push(ChangedFile {
          path,
          change_type,
          old_path,
        });
      }

      debug!(count = files.len(), "changed files computed");
      Ok(files)
    })
    .await
    .map_err(|e| GitError::Internal(format!("join error: {e}")))?
  }

  #[instrument(skip(self))]
  async fn read_file(&self, path: &str) -> Result<Vec<u8>, GitError> {
    let repo_path = self.repo_path().await?;
    let requested_path = path.to_string();

    tokio::task::spawn_blocking(move || {
      let full_path = safe_worktree_path(&repo_path, &requested_path)?;
      std::fs::read(&full_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
          GitError::NotFound(format!("file not found: {}", full_path.display()))
        } else {
          GitError::Internal(format!("read failed: {e}"))
        }
      })
    })
    .await
    .map_err(|e| GitError::Internal(format!("join error: {e}")))?
  }

  #[instrument(skip(self, content), fields(content_len = content.len()))]
  async fn write_file(&self, path: &str, content: &[u8]) -> Result<(), GitError> {
    let repo_path = self.repo_path().await?;
    let requested_path = path.to_string();
    let content = content.to_vec();
    let operation_guard = self.operation_guard().await;

    tokio::task::spawn_blocking(move || {
      let _operation_guard = operation_guard;
      let full_path = safe_worktree_path(&repo_path, &requested_path)?;
      if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| GitError::Internal(format!("mkdir failed: {e}")))?;
      }
      std::fs::write(&full_path, &content).map_err(|e| GitError::Internal(format!("write failed: {e}")))?;
      trace!(path = %full_path.display(), "file written");
      Ok(())
    })
    .await
    .map_err(|e| GitError::Internal(format!("join error: {e}")))?
  }

  #[instrument(skip(self, oid, path))]
  async fn read_file_at_revision(&self, oid: &str, path: &str) -> Result<Vec<u8>, GitError> {
    let repo_path = self.repo_path().await?;
    let oid = oid.to_owned();
    let path = myoxus_domain::git_sync::RepoPath::new(path)
      .map_err(|_| GitError::Internal("invalid immutable Git path".into()))?
      .as_str()
      .to_owned();
    let guard = self.operation_guard().await;
    tokio::time::timeout(
      self.local_timeout,
      tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let repo = git2::Repository::open(repo_path).map_err(git2_to_git_error)?;
        let commit = repo
          .find_commit(git2::Oid::from_str(&oid).map_err(git2_to_git_error)?)
          .map_err(git2_to_git_error)?;
        let tree = commit.tree().map_err(git2_to_git_error)?;
        let entry = tree.get_path(std::path::Path::new(&path)).map_err(git2_to_git_error)?;
        if !matches!(entry.filemode(), 0o100644 | 0o100755) {
          return Err(GitError::Internal("immutable Git path is not a regular file".into()));
        }
        let blob = repo.find_blob(entry.id()).map_err(git2_to_git_error)?;
        if blob.size() > 256 * 1024 * 1024 {
          return Err(GitError::Internal("immutable Git file exceeds the read bound".into()));
        }
        Ok(blob.content().to_vec())
      }),
    )
    .await
    .map_err(|_| GitError::Internal("immutable Git read timed out".into()))?
    .map_err(|_| GitError::Internal("immutable Git read task failed".into()))?
  }

  #[instrument(skip(self))]
  async fn delete_file(&self, path: &str) -> Result<(), GitError> {
    let repo_path = self.repo_path().await?;
    let requested_path = path.to_string();
    let operation_guard = self.operation_guard().await;

    tokio::task::spawn_blocking(move || {
      let _operation_guard = operation_guard;
      let full_path = safe_worktree_path(&repo_path, &requested_path)?;
      std::fs::remove_file(&full_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
          GitError::NotFound(format!("file not found: {}", full_path.display()))
        } else {
          GitError::Internal(format!("delete failed: {e}"))
        }
      })
    })
    .await
    .map_err(|e| GitError::Internal(format!("join error: {e}")))?
  }

  #[instrument(skip(self))]
  async fn rename_file(&self, from: &str, to: &str) -> Result<(), GitError> {
    let repo_path = self.repo_path().await?;
    let from_requested = from.to_string();
    let to_requested = to.to_string();
    let operation_guard = self.operation_guard().await;

    tokio::task::spawn_blocking(move || {
      let _operation_guard = operation_guard;
      let from_path = safe_worktree_path(&repo_path, &from_requested)?;
      let to_path = safe_worktree_path(&repo_path, &to_requested)?;
      if let Some(parent) = to_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| GitError::Internal(format!("mkdir failed: {e}")))?;
      }
      std::fs::rename(&from_path, &to_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
          GitError::NotFound(format!("source not found: {}", from_path.display()))
        } else {
          GitError::Internal(format!("rename failed: {e}"))
        }
      })
    })
    .await
    .map_err(|e| GitError::Internal(format!("join error: {e}")))?
  }

  #[instrument(skip(self))]
  async fn commit(&self, message: &str, author_name: &str, author_email: &str) -> Result<String, GitError> {
    let repo_path = self.repo_path().await?;
    let message_owned = message.to_string();
    let name_owned = author_name.to_string();
    let email_owned = author_email.to_string();
    let operation_guard = self.operation_guard().await;

    tokio::task::spawn_blocking(move || {
      let _operation_guard = operation_guard;
      let repo = git2::Repository::open(&repo_path).map_err(|e| GitError::Repository(format!("open failed: {e}")))?;

      // Stage all changes: add new/modified files and update removals.
      let mut index = repo
        .index()
        .map_err(|e| GitError::Repository(format!("index failed: {e}")))?;
      index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| GitError::Repository(format!("add_all failed: {e}")))?;
      index
        .update_all(["*"].iter(), None)
        .map_err(|e| GitError::Repository(format!("update_all failed: {e}")))?;
      index
        .write()
        .map_err(|e| GitError::Repository(format!("index write failed: {e}")))?;

      let tree_id = index
        .write_tree()
        .map_err(|e| GitError::Repository(format!("write_tree failed: {e}")))?;
      let tree = repo
        .find_tree(tree_id)
        .map_err(|e| GitError::Repository(format!("find_tree failed: {e}")))?;

      let sig = git2::Signature::now(&name_owned, &email_owned)
        .map_err(|e| GitError::Internal(format!("signature creation failed: {e}")))?;

      let parent_commit = match repo.head() {
        Ok(head) => Some(
          head
            .peel_to_commit()
            .map_err(|error| GitError::Repository(format!("resolve parent commit: {error}")))?,
        ),
        Err(error) if matches!(error.code(), git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound) => None,
        Err(error) => {
          return Err(GitError::Repository(format!(
            "read repository HEAD before commit: {error}"
          )));
        }
      };
      let parents: Vec<&git2::Commit<'_>> = parent_commit.iter().collect();

      let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message_owned, &tree, &parents)
        .map_err(|e| GitError::Repository(format!("commit failed: {e}")))?;

      let oid_str = oid.to_string();
      debug!(oid = %oid_str, "commit created");
      Ok(oid_str)
    })
    .await
    .map_err(|e| GitError::Internal(format!("join error: {e}")))?
  }

  #[instrument(skip(self, auth))]
  async fn push(
    &self,
    branch: &str,
    intended_oid: &str,
    auth: &GitAuth,
  ) -> Result<myoxus_application::git_sync::backend::GitPushReceipt, GitError> {
    let repo_path = self.repo_path().await?;
    let branch_owned = branch.to_string();
    let intended_oid_owned = intended_oid.to_string();
    let auth_data = AuthData::new(auth);
    let network_timeout = self.network_timeout;
    let remote_url = Self::origin_url_for_repo_path(repo_path.clone()).await?;
    let ssh_host_key_check = if let Some(url) = remote_url.as_deref() {
      self.prepare_ssh_host_key_check(url).await?
    } else {
      None
    };
    let ssh_host_key_check_for_callback = ssh_host_key_check.clone();
    let https_certificate_policy = self.https_certificate_policy;
    let allowed_https_hosts = Arc::clone(&self.allowed_https_hosts);
    let operation_guard = self.operation_guard().await;

    let native_push = tokio::task::spawn_blocking(move || {
      let _operation_guard = operation_guard;
      let repo = git2::Repository::open(&repo_path).map_err(git2_to_git_error)?;
      let mut remote = repo.find_remote("origin").map_err(git2_to_git_error)?;

      let ssh_result = auth_data.prepare_ssh_key()?;
      let ssh_key_path = ssh_result.as_ref().map(|(_, p)| p.clone());

      let push_status = Arc::new(std::sync::Mutex::new(None::<String>));
      let push_status_for_callback = Arc::clone(&push_status);
      let mut callbacks = git2::RemoteCallbacks::new();
      auth_data.configure_callbacks(
        &mut callbacks,
        ssh_key_path.clone(),
        ssh_host_key_check_for_callback.clone(),
        https_certificate_policy,
        Arc::clone(&allowed_https_hosts),
      );
      callbacks.push_update_reference(move |_reference, status| {
        if let Some(status) = status {
          *push_status_for_callback.lock().expect("push status lock") = Some(status.to_string());
        }
        Ok(())
      });

      let mut push_opts = git2::PushOptions::new();
      push_opts.remote_callbacks(callbacks);

      let refspec = format!("refs/heads/{branch_owned}:refs/heads/{branch_owned}");
      remote
        .push(&[&refspec], Some(&mut push_opts))
        .map_err(git2_to_git_error)?;
      if let Some(status) = push_status.lock().expect("push status lock").clone() {
        return Err(GitError::Repository(format!("remote rejected branch update: {status}")));
      }

      let mut verify_callbacks = git2::RemoteCallbacks::new();
      auth_data.configure_callbacks(
        &mut verify_callbacks,
        ssh_key_path,
        ssh_host_key_check_for_callback,
        https_certificate_policy,
        Arc::clone(&allowed_https_hosts),
      );
      let connection = remote
        .connect_auth(git2::Direction::Fetch, Some(verify_callbacks), None)
        .map_err(git2_to_git_error)?;
      let reference = format!("refs/heads/{branch_owned}");
      let observed_remote_oid = connection
        .list()
        .map_err(git2_to_git_error)?
        .iter()
        .find(|head| head.name() == reference)
        .map(|head| head.oid().to_string())
        .ok_or_else(|| GitError::Repository(format!("remote did not advertise {reference} after push")))?;

      debug!(branch = %branch_owned, %observed_remote_oid, "push completed and remote ref observed");
      Ok::<_, GitError>(myoxus_application::git_sync::backend::GitPushReceipt {
        branch: branch_owned,
        local_commit_oid: intended_oid_owned,
        remote_ref_status: myoxus_application::git_sync::backend::GitRemoteRefStatus::Updated,
        observed_remote_oid,
      })
    });
    let mut push_task = tokio::spawn(async move { native_push.await });

    let receipt = match tokio::time::timeout(network_timeout, &mut push_task).await {
      Ok(inner) => inner
        .map_err(|error| GitError::Internal(format!("push supervisor failed: {error}")))?
        .map_err(|error| GitError::Internal(format!("push worker join error: {error}")))??,
      Err(_elapsed) => {
        // `spawn_blocking` cannot be cancelled once libgit2 entered the
        // transport. Returning here would detach a push that may move the
        // remote after the runner reset its mirror. Keep ownership until the
        // operation reaches a definite result; the caller then verifies the
        // authenticated remote ref before any retry.
        warn!(
          timeout_seconds = network_timeout.as_secs(),
          "git push exceeded its warning deadline; waiting for a definite transport outcome"
        );
        push_task
          .await
          .map_err(|error| GitError::Internal(format!("push supervisor failed after deadline: {error}")))?
          .map_err(|error| GitError::Internal(format!("push worker join error after deadline: {error}")))??
      }
    };

    self.persist_observed_ssh_host_keys(ssh_host_key_check.as_ref()).await?;
    Ok(receipt)
  }
}

// ─── Stash / Reset (used by repo.rs in the sync engine) ─────────────────────

/// Stash any uncommitted changes in the working tree using git2.
///
/// This prevents fetch/checkout from failing due to dirty state left over
/// from a previous interrupted sync. The stash is never popped — we start
/// fresh from remote HEAD each time.
pub fn stash_if_dirty(repo_path: &Path) -> Result<bool, GitError> {
  let mut repo = git2::Repository::open(repo_path)
    .map_err(|error| GitError::Repository(format!("failed to open repo for stash: {error}")))?;
  let mut status_options = git2::StatusOptions::new();
  status_options.include_untracked(true).recurse_untracked_dirs(true);
  let statuses = repo
    .statuses(Some(&mut status_options))
    .map_err(|error| GitError::Repository(format!("inspect working tree before stash: {error}")))?;
  if statuses.is_empty() {
    return Ok(false);
  }
  drop(statuses);

  let sig = git2::Signature::now("Myoxus Sync", "sync@myoxus.local")
    .map_err(|error| GitError::Internal(format!("create stash signature: {error}")))?;
  repo
    .stash_save(
      &sig,
      "myoxus-sync-auto-stash",
      Some(git2::StashFlags::INCLUDE_UNTRACKED),
    )
    .map_err(|error| GitError::Repository(format!("stash dirty working tree: {error}")))?;
  debug!("stashed dirty working tree changes");
  Ok(true)
}

/// Drop all stashes to prevent unbounded stash accumulation.
///
/// Called after a successful sync to clean up auto-stashes created by
/// `stash_if_dirty`.
pub fn drop_all_stashes(repo_path: &Path) {
  let mut repo = match git2::Repository::open(repo_path) {
    Ok(r) => r,
    Err(e) => {
      warn!(error = %e, "failed to open repo for stash cleanup");
      return;
    }
  };

  // Drop stashes from top (index 0) until none remain.
  while let Ok(()) = repo.stash_drop(0) {
    trace!("dropped stash entry");
  }
  debug!("all stashes dropped");
}

/// Hard-reset to the remote tracking branch to discard any local-only commits.
///
/// After a failed push, the local branch may be ahead of remote. Resetting
/// ensures we start each sync from the same state as the remote, preventing
/// divergence accumulation across runs.
pub fn reset_to_remote(repo_path: &Path, branch: &str) -> Result<String, GitError> {
  let repo = git2::Repository::open(repo_path)
    .map_err(|error| GitError::Repository(format!("failed to open repo for reset: {error}")))?;

  let remote_ref = format!("refs/remotes/origin/{branch}");
  let obj = repo
    .revparse_single(&remote_ref)
    .map_err(|error| GitError::Repository(format!("failed to resolve {remote_ref} for reset: {error}")))?;
  let expected_oid = obj.id().to_string();
  repo
    .reset(&obj, git2::ResetType::Hard, None)
    .map_err(|error| GitError::Repository(format!("git reset --hard to {remote_ref} failed: {error}")))?;
  let actual_oid = repo
    .head()
    .and_then(|head| head.peel_to_commit())
    .map_err(|error| GitError::Repository(format!("read HEAD after reset: {error}")))?
    .id()
    .to_string();
  if actual_oid != expected_oid {
    return Err(GitError::Repository(format!(
      "HEAD mismatch after reset: expected {expected_oid}, observed {actual_oid}"
    )));
  }
  debug!(branch, oid = %actual_oid, "reset to remote HEAD verified");
  Ok(actual_oid)
}

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use crate::git_sync::{MirrorLockError, acquire_profile_mirror};
  use std::time::Duration;

  // ─── Credential scrubbing tests ──────────────────────────────────────

  #[test]
  fn scrub_https_token_in_url() {
    let msg = "fatal: unable to access 'https://user:ghp_secret123@github.com/repo.git'";
    let scrubbed = scrub_credentials(msg);
    assert!(!scrubbed.contains("ghp_secret123"), "token should be scrubbed");
    assert!(scrubbed.contains("***"), "should contain redaction marker");
  }

  #[tokio::test]
  async fn timed_out_native_writer_keeps_physical_guard_until_completion() {
    let temp = tempfile::tempdir().expect("tempdir");
    let profile_id = uuid::Uuid::new_v4();
    let guard: Arc<dyn GitOperationGuard> = Arc::new(
      acquire_profile_mirror(temp.path(), profile_id)
        .await
        .expect("first guard"),
    );
    let base = temp.path().to_path_buf();
    let writer = tokio::spawn(async move {
      run_native_writer(
        Duration::from_millis(10),
        "controlled writer",
        NativeTimeoutClass::Local,
        Some(guard),
        || {
          std::thread::sleep(Duration::from_millis(100));
          Ok(())
        },
      )
      .await
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(matches!(
      acquire_profile_mirror(&base, profile_id).await,
      Err(MirrorLockError::Busy)
    ));
    assert!(matches!(writer.await.expect("writer task"), Err(GitError::Internal(_))));
    acquire_profile_mirror(&base, profile_id)
      .await
      .expect("lock released after native writer ended");
  }

  #[tokio::test]
  async fn cancelled_caller_does_not_release_a_running_native_writer() {
    let temp = tempfile::tempdir().expect("tempdir");
    let profile_id = uuid::Uuid::new_v4();
    let guard: Arc<dyn GitOperationGuard> = Arc::new(
      acquire_profile_mirror(temp.path(), profile_id)
        .await
        .expect("first guard"),
    );
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let writer = tokio::spawn(async move {
      run_native_writer(
        Duration::from_secs(5),
        "controlled writer",
        NativeTimeoutClass::Local,
        Some(guard),
        move || {
          release_rx.recv().expect("release writer");
          Ok(())
        },
      )
      .await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    writer.abort();
    assert!(matches!(
      acquire_profile_mirror(temp.path(), profile_id).await,
      Err(MirrorLockError::Busy)
    ));
    release_tx.send(()).expect("release native writer");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
      match acquire_profile_mirror(temp.path(), profile_id).await {
        Ok(_) => break,
        Err(MirrorLockError::Busy) if tokio::time::Instant::now() < deadline => {
          tokio::time::sleep(Duration::from_millis(10)).await;
        }
        other => panic!("physical guard did not release after native completion: {other:?}"),
      }
    }
  }

  #[test]
  fn scrub_password_in_url() {
    let msg = "fatal: Authentication failed for 'https://alice:p4ssw0rd@gitlab.com/repo.git'";
    let scrubbed = scrub_credentials(msg);
    assert!(!scrubbed.contains("p4ssw0rd"), "password should be scrubbed");
  }

  #[test]
  fn scrub_github_pat() {
    let msg = "token ghp_abc123XYZ was rejected";
    let scrubbed = scrub_credentials(msg);
    assert!(!scrubbed.contains("ghp_abc123XYZ"), "PAT should be scrubbed");
    assert!(scrubbed.contains("***"));
  }

  #[test]
  fn scrub_gitlab_pat() {
    let msg = "token glpat-abc123 was rejected";
    let scrubbed = scrub_credentials(msg);
    assert!(!scrubbed.contains("glpat-abc123"), "GitLab PAT should be scrubbed");
  }

  #[test]
  fn scrub_no_credentials_unchanged() {
    let msg = "fatal: bad object HEAD";
    assert_eq!(scrub_credentials(msg), msg);
  }

  #[test]
  fn scrub_bearer_token() {
    let msg = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret";
    let scrubbed = scrub_credentials(msg);
    assert!(
      !scrubbed.contains("eyJhbGciOiJIUzI1NiJ9"),
      "bearer token should be scrubbed"
    );
  }

  #[test]
  fn classify_auth_error() {
    let e = git2::Error::from_str("authentication failed for https://...");
    let err: GitError = classify_git2_error(&e);
    assert!(matches!(err, GitError::Auth(_)), "expected Auth, got {err:?}");
  }

  #[test]
  fn concrete_auth_and_certificate_codes_override_broad_http_class() {
    let auth = git2::Error::new(
      git2::ErrorCode::Auth,
      git2::ErrorClass::Http,
      "request failed without provider-specific detail",
    );
    assert!(matches!(classify_git2_error(&auth), GitError::Auth(_)));

    let certificate = git2::Error::new(
      git2::ErrorCode::Certificate,
      git2::ErrorClass::Http,
      "request failed without provider-specific detail",
    );
    assert!(matches!(classify_git2_error(&certificate), GitError::Tls(_)));
  }

  #[test]
  fn classify_generic_error() {
    let e = git2::Error::from_str("bad object HEAD");
    let err: GitError = classify_git2_error(&e);
    assert!(
      matches!(err, GitError::Repository(_)),
      "expected Repository, got {err:?}"
    );
  }

  #[test]
  fn classify_error_scrubs_credentials() {
    let e = git2::Error::from_str("authentication failed for 'https://user:ghp_MYSECRET@github.com/repo.git'");
    let err: GitError = classify_git2_error(&e);
    let msg = err.to_string();
    assert!(
      !msg.contains("ghp_MYSECRET"),
      "classified error should have credentials scrubbed"
    );
  }

  #[test]
  fn shallow_depth_applies_to_network_remotes() {
    assert_eq!(
      shallow_depth_for_remote_url("https://example.test/org/repo.git", 1),
      Some(1)
    );
    assert_eq!(
      shallow_depth_for_remote_url("ssh://git@example.test/org/repo.git", 7),
      Some(7)
    );
    assert_eq!(
      shallow_depth_for_remote_url("git@example.test:org/repo.git", 0),
      Some(1),
      "adapter clamps invalid depth as the last safety line"
    );
  }

  #[test]
  fn shallow_depth_is_skipped_for_local_remotes() {
    assert_eq!(shallow_depth_for_remote_url("file:///tmp/repo.git", 1), None);
    assert_eq!(shallow_depth_for_remote_url("/tmp/repo.git", 1), None);
    assert_eq!(shallow_depth_for_remote_url("./repo.git", 1), None);
    assert_eq!(shallow_depth_for_remote_url("../repo.git", 1), None);
  }

  // ─── SSH key preparation tests ───────────────────────────────────────

  #[test]
  fn prepare_ssh_key_creates_file() {
    let key_data = b"-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----\n";
    let auth = AuthData::new(&GitAuth::SshKey {
      private_key: key_data.to_vec(),
      passphrase: None,
    });
    let result = auth.prepare_ssh_key().unwrap();
    assert!(result.is_some(), "SSH key should produce a temp dir");

    let (temp_dir, key_path) = result.unwrap();
    assert!(key_path.exists(), "key file should exist");

    let perms = std::fs::metadata(&key_path).unwrap().permissions();
    assert_eq!(perms.mode() & 0o777, 0o600, "key file should have 0600 permissions");

    let content = std::fs::read(&key_path).unwrap();
    assert_eq!(content, key_data, "key file content should match");

    // Verify cleanup on drop.
    let key_path_clone = key_path.clone();
    drop(temp_dir);
    assert!(
      !key_path_clone.exists(),
      "key file should be deleted after TempDir drop"
    );
  }

  #[test]
  fn prepare_ssh_key_none_for_https() {
    let auth = AuthData::new(&GitAuth::HttpsToken {
      username: "user".into(),
      token: "tok".into(),
    });
    let result = auth.prepare_ssh_key().unwrap();
    assert!(result.is_none(), "HTTPS auth should not produce SSH key");
  }
}
