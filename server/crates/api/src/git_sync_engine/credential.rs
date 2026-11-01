// SPDX-License-Identifier: AGPL-3.0-or-later
//! Credential decryption and GitAuth construction.

use myoxus_application::git_sync::backend::GitAuth;
use myoxus_domain::git_sync::AuthMethod;
use myoxus_infrastructure::crypto;
use uuid::Uuid;

use super::error::SyncError;

/// Decrypt credential data and parse the JSON payload.
pub fn decrypt(crypto_key: &str, encrypted: &[u8]) -> Result<serde_json::Value, SyncError> {
  let plaintext = crypto::decrypt(crypto_key, encrypted).map_err(|e| SyncError::Permanent {
    message: format!("credential decryption failed: {e}"),
    profile_id: uuid::Uuid::nil(),
    phase: "decrypt_credential",
  })?;
  serde_json::from_slice(&plaintext).map_err(|e| SyncError::Permanent {
    message: format!("invalid credential JSON: {e}"),
    profile_id: uuid::Uuid::nil(),
    phase: "decrypt_credential",
  })
}

/// Build a `GitAuth` from a profile's auth method and decrypted credential JSON.
///
/// ROB-25: Returns `Permanent { phase: "build_auth" }` when a required
/// credential field is missing or empty, instead of silently building a
/// `GitAuth` with empty credentials and letting the push fail with a
/// generic auth error far downstream. This surfaces misconfigured
/// profiles at sync-start time with a precise message ("missing field
/// `token` for HttpsToken auth") rather than as a confusing `git fetch:
/// authentication required` later in the pipeline.
///
/// Username defaulting:
/// * `HttpsToken` defaults `username` to `"x-access-token"` when absent
///   (GitHub convention; GitLab accepts it too via OAuth bridge).
/// * `HttpsPassword` requires both `username` and `password`.
pub fn build_auth(profile_id: Uuid, auth_method: AuthMethod, cred: &serde_json::Value) -> Result<GitAuth, SyncError> {
  fn required_str<'a>(
    cred: &'a serde_json::Value,
    field: &'static str,
    profile_id: Uuid,
    auth_method: AuthMethod,
  ) -> Result<&'a str, SyncError> {
    let value = cred.get(field).and_then(|v| v.as_str()).unwrap_or("");
    if value.is_empty() {
      return Err(SyncError::Permanent {
        message: format!("missing or empty `{field}` field for {auth_method:?} credential"),
        profile_id,
        phase: "build_auth",
      });
    }
    Ok(value)
  }

  match auth_method {
    AuthMethod::HttpsToken => {
      let token = required_str(cred, "token", profile_id, auth_method)?;
      // Username defaults to GitHub's bot convention. Operators can
      // override per-credential when their host needs a different value
      // (GitLab `oauth2`, Bitbucket actual user).
      let username = cred
        .get("username")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("x-access-token")
        .to_string();
      Ok(GitAuth::HttpsToken {
        username,
        token: token.to_string(),
      })
    }
    AuthMethod::HttpsPassword => {
      let username = required_str(cred, "username", profile_id, auth_method)?;
      let password = required_str(cred, "password", profile_id, auth_method)?;
      Ok(GitAuth::HttpsPassword {
        username: username.to_string(),
        password: password.to_string(),
      })
    }
    AuthMethod::SshKey => {
      let private_key = required_str(cred, "privateKey", profile_id, auth_method)?;
      // Passphrase: presence is optional. Distinguish `null`/missing
      // (= no passphrase) from `""` (= explicitly-empty passphrase).
      // `as_str()` returns `Some("")` for `""` and `None` for `null`/missing
      // — we keep the latter to avoid surprising the SSH backend with
      // an empty-string passphrase.
      let passphrase = cred.get("passphrase").and_then(|v| v.as_str()).map(String::from);
      Ok(GitAuth::SshKey {
        private_key: private_key.as_bytes().to_vec(),
        passphrase,
      })
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn pid() -> Uuid {
    Uuid::nil()
  }

  #[test]
  fn https_token_with_full_credential_succeeds() {
    let cred = json!({ "username": "ci-bot", "token": "ghp_xxx" });
    let auth = build_auth(pid(), AuthMethod::HttpsToken, &cred).unwrap();
    match auth {
      GitAuth::HttpsToken { username, token } => {
        assert_eq!(username, "ci-bot");
        assert_eq!(token, "ghp_xxx");
      }
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn https_token_defaults_username_when_absent() {
    let cred = json!({ "token": "ghp_xxx" });
    let auth = build_auth(pid(), AuthMethod::HttpsToken, &cred).unwrap();
    match auth {
      GitAuth::HttpsToken { username, .. } => assert_eq!(username, "x-access-token"),
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn https_token_defaults_username_when_empty_string() {
    // ROB-25: explicit empty string for username should still trigger
    // the GitHub default — a bot username of "" is never useful.
    let cred = json!({ "username": "", "token": "ghp_xxx" });
    let auth = build_auth(pid(), AuthMethod::HttpsToken, &cred).unwrap();
    match auth {
      GitAuth::HttpsToken { username, .. } => assert_eq!(username, "x-access-token"),
      _ => panic!("wrong variant"),
    }
  }

  #[test]
  fn https_token_missing_token_returns_permanent_error() {
    let cred = json!({ "username": "ci-bot" });
    let err = build_auth(pid(), AuthMethod::HttpsToken, &cred).unwrap_err();
    assert!(
      matches!(
        err,
        SyncError::Permanent {
          phase: "build_auth",
          ..
        }
      ),
      "expected Permanent build_auth error, got {err:?}"
    );
    let msg = err.to_string();
    assert!(msg.contains("token"), "error must mention the missing field: {msg}");
  }

  #[test]
  fn https_token_empty_token_returns_permanent_error() {
    let cred = json!({ "token": "" });
    let err = build_auth(pid(), AuthMethod::HttpsToken, &cred).unwrap_err();
    assert!(matches!(
      err,
      SyncError::Permanent {
        phase: "build_auth",
        ..
      }
    ));
  }

  #[test]
  fn https_password_requires_both_fields() {
    // missing password
    let cred = json!({ "username": "alice" });
    assert!(build_auth(pid(), AuthMethod::HttpsPassword, &cred).is_err());
    // missing username
    let cred = json!({ "password": "s3cret" });
    assert!(build_auth(pid(), AuthMethod::HttpsPassword, &cred).is_err());
    // both → ok
    let cred = json!({ "username": "alice", "password": "s3cret" });
    let auth = build_auth(pid(), AuthMethod::HttpsPassword, &cred).unwrap();
    assert!(matches!(auth, GitAuth::HttpsPassword { .. }));
  }

  #[test]
  fn ssh_key_requires_private_key() {
    let cred = json!({});
    let err = build_auth(pid(), AuthMethod::SshKey, &cred).unwrap_err();
    assert!(matches!(
      err,
      SyncError::Permanent {
        phase: "build_auth",
        ..
      }
    ));
  }

  #[test]
  fn ssh_key_passphrase_distinguishes_null_from_empty_string() {
    // null/missing → no passphrase
    let cred = json!({ "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n..." });
    let auth = build_auth(pid(), AuthMethod::SshKey, &cred).unwrap();
    match auth {
      GitAuth::SshKey { passphrase, .. } => assert!(passphrase.is_none()),
      _ => panic!("wrong variant"),
    }
    // explicit empty string → empty-string passphrase (some keys are
    // generated with `ssh-keygen -N ""` and need to round-trip that).
    let cred = json!({ "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...", "passphrase": "" });
    let auth = build_auth(pid(), AuthMethod::SshKey, &cred).unwrap();
    match auth {
      GitAuth::SshKey { passphrase, .. } => assert_eq!(passphrase.as_deref(), Some("")),
      _ => panic!("wrong variant"),
    }
  }
}
