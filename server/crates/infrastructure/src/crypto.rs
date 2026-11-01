//! Credential encryption/decryption using AES-256-GCM.
//!
//! The server's `crypto.private_key` config value is used as the key material.
//! It is SHA-256 hashed to derive a 256-bit AES key.  Each encryption produces
//! a random 96-bit nonce prepended to the ciphertext.
//!
//! Wire format: `[12-byte nonce][ciphertext+16-byte auth tag]`
//!
//! This is used to protect Git Sync credentials (PATs, passwords, SSH keys)
//! at rest in the `git_sync_credentials.encrypted_data` column.

use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use sha2::{Digest, Sha256};

/// Errors from encryption/decryption operations.
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
  #[error("encryption failed: {0}")]
  EncryptionFailed(String),
  #[error("decryption failed: {0}")]
  DecryptionFailed(String),
  #[error("invalid ciphertext: too short (expected at least 12 bytes nonce)")]
  CiphertextTooShort,
}

/// Derive a 256-bit AES key from the server's private key string.
fn derive_key(private_key: &str) -> [u8; 32] {
  let mut hasher = Sha256::new();
  hasher.update(private_key.as_bytes());
  hasher.finalize().into()
}

/// Encrypt plaintext bytes using AES-256-GCM with the server's private key.
///
/// Returns `[12-byte nonce][ciphertext+auth_tag]`.
pub fn encrypt(private_key: &str, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
  let key = derive_key(private_key);
  let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

  let mut nonce_bytes = [0u8; 12];
  use rand::RngCore;
  rand::thread_rng().fill_bytes(&mut nonce_bytes);
  let nonce = Nonce::from_slice(&nonce_bytes);

  let ciphertext = cipher
    .encrypt(nonce, plaintext)
    .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

  let mut result = Vec::with_capacity(12 + ciphertext.len());
  result.extend_from_slice(&nonce_bytes);
  result.extend_from_slice(&ciphertext);
  Ok(result)
}

/// Decrypt ciphertext produced by [`encrypt`] using the server's private key.
pub fn decrypt(private_key: &str, ciphertext: &[u8]) -> Result<Vec<u8>, CryptoError> {
  if ciphertext.len() < 12 {
    return Err(CryptoError::CiphertextTooShort);
  }

  let key = derive_key(private_key);
  let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

  let nonce = Nonce::from_slice(&ciphertext[..12]);
  let encrypted = &ciphertext[12..];

  cipher
    .decrypt(nonce, encrypted)
    .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn encrypt_decrypt_roundtrip() {
    let key = "test-private-key-for-unit-tests";
    let plaintext = b"ghp_abc123secrettoken";

    let encrypted = encrypt(key, plaintext).expect("encrypt");
    assert!(encrypted.len() > 12, "ciphertext must be longer than nonce");
    assert_ne!(&encrypted[12..], plaintext, "ciphertext must not equal plaintext");

    let decrypted = decrypt(key, &encrypted).expect("decrypt");
    assert_eq!(decrypted, plaintext);
  }

  #[test]
  fn decrypt_wrong_key_fails() {
    let encrypted = encrypt("correct-key", b"secret").expect("encrypt");
    let result = decrypt("wrong-key", &encrypted);
    assert!(result.is_err(), "decryption with wrong key must fail");
  }

  #[test]
  fn decrypt_too_short_fails() {
    let result = decrypt("key", &[0u8; 5]);
    assert!(matches!(result, Err(CryptoError::CiphertextTooShort)));
  }

  #[test]
  fn each_encryption_produces_different_ciphertext() {
    let key = "deterministic-key";
    let plaintext = b"same-data";
    let a = encrypt(key, plaintext).unwrap();
    let b = encrypt(key, plaintext).unwrap();
    assert_ne!(a, b, "different nonces must produce different ciphertext");
  }
}
