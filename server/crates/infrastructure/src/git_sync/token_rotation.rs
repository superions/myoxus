// SPDX-License-Identifier: AGPL-3.0-or-later
//! Provider-neutral credential codec for Git-Sync token rotation.

use std::{fmt, sync::Arc};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_application::git_sync::{
  EncryptedGitCredential, GitTokenCredential, GitTokenCredentialCodec, GitTokenRotationCodecError,
};

#[derive(Clone)]
pub struct GitSyncTokenCredentialCodec {
  crypto_key: Arc<str>,
}

impl GitSyncTokenCredentialCodec {
  pub fn new(crypto_key: impl Into<Arc<str>>) -> Self {
    Self {
      crypto_key: crypto_key.into(),
    }
  }
}

impl fmt::Debug for GitSyncTokenCredentialCodec {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter
      .debug_struct("GitSyncTokenCredentialCodec")
      .field("crypto_key", &"[REDACTED]")
      .finish()
  }
}

#[async_trait]
impl GitTokenCredentialCodec for GitSyncTokenCredentialCodec {
  async fn decrypt_https_token(&self, encrypted: &[u8]) -> Result<GitTokenCredential, GitTokenRotationCodecError> {
    let plaintext =
      crate::crypto::decrypt(&self.crypto_key, encrypted).map_err(|_| GitTokenRotationCodecError::Credential)?;
    let value: serde_json::Value =
      serde_json::from_slice(&plaintext).map_err(|_| GitTokenRotationCodecError::Credential)?;
    let token = value
      .get("token")
      .and_then(serde_json::Value::as_str)
      .filter(|token| !token.is_empty())
      .ok_or(GitTokenRotationCodecError::Credential)?
      .to_owned();
    let username = match value.get("username") {
      None | Some(serde_json::Value::Null) => None,
      Some(serde_json::Value::String(username)) => Some(username.clone()),
      Some(_) => return Err(GitTokenRotationCodecError::Credential),
    };
    Ok(GitTokenCredential { username, token })
  }

  async fn encrypt_https_token(
    &self,
    credential: &GitTokenCredential,
    label: &str,
    expires_at: DateTime<Utc>,
  ) -> Result<EncryptedGitCredential, GitTokenRotationCodecError> {
    if credential.token.is_empty() {
      return Err(GitTokenRotationCodecError::Credential);
    }
    let plaintext = serde_json::to_vec(&serde_json::json!({
      "token": credential.token,
      "username": credential.username,
    }))
    .map_err(|_| GitTokenRotationCodecError::Credential)?;
    let ciphertext =
      crate::crypto::encrypt(&self.crypto_key, &plaintext).map_err(|_| GitTokenRotationCodecError::Credential)?;
    Ok(EncryptedGitCredential {
      label: label.to_owned(),
      ciphertext,
      expires_at: Some(expires_at),
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn codec_roundtrip_preserves_optional_username_and_redacts_debug() {
    let codec = GitSyncTokenCredentialCodec::new("rotation-codec-test-key");
    let expires_at = Utc::now() + chrono::Duration::days(90);
    for username in [None, Some("gitlab-bot".to_string())] {
      let encrypted = codec
        .encrypt_https_token(
          &GitTokenCredential {
            username: username.clone(),
            token: "replacement-secret".into(),
          },
          "existing-label",
          expires_at,
        )
        .await
        .expect("encrypt token credential");
      let decoded = codec
        .decrypt_https_token(&encrypted.ciphertext)
        .await
        .expect("decrypt token credential");
      assert_eq!(decoded.username, username);
      assert_eq!(decoded.token, "replacement-secret");
      assert_eq!(encrypted.label, "existing-label");
      assert_eq!(encrypted.expires_at, Some(expires_at));
      assert!(!format!("{decoded:?}").contains("replacement-secret"));
    }
    assert!(!format!("{codec:?}").contains("rotation-codec-test-key"));
  }
}
