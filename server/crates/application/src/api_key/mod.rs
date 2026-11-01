// SPDX-License-Identifier: AGPL-3.0-or-later
//! MCP API key management: storage port trait, service, and in-memory stub.
//!
//! API keys authenticate MCP clients (Claude Desktop, Cursor, etc.) via
//! `Authorization: Bearer myoxus_<key>` headers. The key is SHA-256 hashed
//! before storage; the plaintext key is returned only once at creation.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_domain::entities::ApiKey;
use myoxus_domain::ids::{ApiKeyId, UserId};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio;
use tracing::{debug, instrument};
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};

/// Input DTO for creating a new API key.
#[derive(Debug, Clone)]
pub struct NewApiKey {
  pub user_id: UserId,
  pub name: String,
  pub key_hash: String,
  pub scopes: Vec<String>,
  pub expires_at: Option<DateTime<Utc>>,
}

/// Storage port for MCP API keys.
///
/// Infrastructure crate implements this for PostgreSQL; tests use the
/// in-memory stub provided in this module.
#[async_trait]
pub trait ApiKeyStore: Send + Sync {
  /// Persist a new API key record.
  async fn create(&self, key: NewApiKey) -> AuthResult<ApiKey>;

  /// Look up a key by its SHA-256 hash.  Returns `None` if the hash is not
  /// found or the key has expired.
  async fn find_by_hash(&self, hash: &str) -> AuthResult<Option<ApiKey>>;

  /// Revalidate an already authenticated identity without retaining its token.
  /// Production implementations also require the owner's account to be active.
  async fn find_active_by_owner(&self, _id: ApiKeyId, _owner: UserId) -> AuthResult<Option<ApiKey>> {
    Err(AuthError::Storage(
      "API key identity revalidation is unavailable".into(),
    ))
  }

  /// Update `last_used_at` to now (best-effort; errors are logged and ignored).
  async fn touch_last_used(&self, id: ApiKeyId) -> AuthResult<()>;

  /// Permanently delete a key.
  async fn delete(&self, id: ApiKeyId) -> AuthResult<()>;

  /// List all API keys for a user (without hashes for security).
  async fn list_by_user(&self, user_id: UserId) -> AuthResult<Vec<ApiKey>>;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/// Application service wrapping [`ApiKeyStore`].
///
/// Handles key generation (random bytes + base62 encoding), hashing, and
/// delegation to the store.
#[derive(Clone)]
pub struct ApiKeyService {
  pub store: Arc<dyn ApiKeyStore>,
}

impl std::fmt::Debug for ApiKeyService {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("ApiKeyService").finish_non_exhaustive()
  }
}

impl ApiKeyService {
  pub fn new(store: Arc<dyn ApiKeyStore>) -> Self {
    Self { store }
  }

  /// Generate a new API key, store it (hashed), and return the plaintext key.
  ///
  /// The returned plaintext (`myoxus_<base62>`) is shown once and never stored.
  #[instrument(skip(self))]
  pub async fn generate(
    &self,
    user_id: UserId,
    name: String,
    scopes: Vec<String>,
    expires_at: Option<DateTime<Utc>>,
  ) -> AuthResult<(ApiKey, String)> {
    use rand::Rng;
    use sha2::{Digest, Sha256};

    let random_bytes: [u8; 32] = rand::thread_rng().r#gen();
    let base62 = encode_base62(&random_bytes);
    let plaintext = format!("myoxus_{}", base62);

    let hash = hex::encode(Sha256::digest(plaintext.as_bytes()));

    let record = self
      .store
      .create(NewApiKey {
        user_id,
        name,
        key_hash: hash,
        scopes,
        expires_at,
      })
      .await?;

    debug!(key_id = %record.id, user_id = %user_id, "generated new API key");
    Ok((record, plaintext))
  }

  /// Authenticate a raw `myoxus_...` key, returning the resolved [`ApiKey`]
  /// if valid.  Updates `last_used_at` asynchronously.
  #[instrument(skip_all)]
  pub async fn authenticate(&self, raw_key: &str) -> AuthResult<ApiKey> {
    use sha2::{Digest, Sha256};

    let hash = hex::encode(Sha256::digest(raw_key.as_bytes()));
    let key = self.store.find_by_hash(&hash).await?.ok_or(AuthError::InvalidToken)?;

    // Check expiry
    if let Some(expires_at) = key.expires_at
      && expires_at < Utc::now()
    {
      return Err(AuthError::ExpiredToken);
    }

    // Touch last_used_at (fire-and-forget)
    let store = self.store.clone();
    let id = key.id;
    tokio::spawn(async move {
      if let Err(e) = store.touch_last_used(id).await {
        tracing::warn!(key_id = %id, error = %e, "failed to update api key last_used_at");
      }
    });

    Ok(key)
  }

  #[instrument(skip(self))]
  pub async fn list_by_user(&self, user_id: UserId) -> AuthResult<Vec<ApiKey>> {
    self.store.list_by_user(user_id).await
  }

  /// Fresh authority for a long-lived transport; labels and workspace settings
  /// never constrain the personal key. Each target still needs current ACLs.
  #[instrument(skip_all)]
  pub async fn revalidate(&self, id: ApiKeyId, owner: UserId) -> AuthResult<ApiKey> {
    let key = self
      .store
      .find_active_by_owner(id, owner)
      .await?
      .ok_or(AuthError::InvalidToken)?;
    if key.expires_at.is_some_and(|expiry| expiry <= Utc::now()) {
      return Err(AuthError::ExpiredToken);
    }
    Ok(key)
  }

  #[instrument(skip(self))]
  pub async fn delete(&self, id: ApiKeyId) -> AuthResult<()> {
    self.store.delete(id).await
  }
}

/// Encode 32 bytes as base62 (characters: 0-9, A-Z, a-z).
///
/// Treats the input as a single 256-bit big-endian unsigned integer and
/// converts it to base-62 via repeated division, preserving full entropy.
/// Output is always 43 characters (zero-padded), since ceil(256 * log2 / log62) = 43.
pub(crate) fn encode_base62(bytes: &[u8]) -> String {
  const CHARS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const OUTPUT_LEN: usize = 43; // ceil(256 * ln2 / ln62)

  // Work on a mutable copy of the big-endian byte array.
  let mut num = [0u8; 32];
  num.copy_from_slice(&bytes[..32]);

  let mut digits = Vec::with_capacity(OUTPUT_LEN);

  // Repeated schoolbook division of the 256-bit number by 62.
  for _ in 0..OUTPUT_LEN {
    let mut remainder: u16 = 0;
    for byte in num.iter_mut() {
      let dividend = (remainder << 8) | (*byte as u16);
      *byte = (dividend / 62) as u8;
      remainder = dividend % 62;
    }
    digits.push(CHARS[remainder as usize]);
  }

  // Digits were collected LSB-first; reverse for big-endian output.
  digits.reverse();
  String::from_utf8(digits).unwrap_or_default()
}

// ─── In-memory stub (tests) ───────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct InMemoryApiKeyStore {
  keys: Mutex<HashMap<ApiKeyId, ApiKey>>,
}

#[async_trait]
impl ApiKeyStore for InMemoryApiKeyStore {
  async fn find_active_by_owner(&self, id: ApiKeyId, owner: UserId) -> AuthResult<Option<ApiKey>> {
    Ok(
      self
        .keys
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&id)
        .filter(|key| key.user_id == owner && key.expires_at.is_none_or(|expiry| expiry > Utc::now()))
        .cloned(),
    )
  }
  async fn create(&self, input: NewApiKey) -> AuthResult<ApiKey> {
    let key = ApiKey {
      id: Uuid::new_v4(),
      user_id: input.user_id,
      name: input.name,
      key_hash: input.key_hash,
      scopes: input.scopes,
      created_at: Utc::now(),
      last_used_at: None,
      expires_at: input.expires_at,
    };
    self
      .keys
      .lock()
      .expect("test: InMemoryApiKeyStore mutex poisoned")
      .insert(key.id, key.clone());
    Ok(key)
  }

  async fn find_by_hash(&self, hash: &str) -> AuthResult<Option<ApiKey>> {
    let now = Utc::now();
    Ok(
      self
        .keys
        .lock()
        .expect("test: InMemoryApiKeyStore mutex poisoned")
        .values()
        .find(|k| k.key_hash == hash && k.expires_at.map(|e| e > now).unwrap_or(true))
        .cloned(),
    )
  }

  async fn touch_last_used(&self, id: ApiKeyId) -> AuthResult<()> {
    if let Some(key) = self
      .keys
      .lock()
      .expect("test: InMemoryApiKeyStore mutex poisoned")
      .get_mut(&id)
    {
      key.last_used_at = Some(Utc::now());
    }
    Ok(())
  }

  async fn delete(&self, id: ApiKeyId) -> AuthResult<()> {
    self
      .keys
      .lock()
      .expect("test: InMemoryApiKeyStore mutex poisoned")
      .remove(&id);
    Ok(())
  }

  async fn list_by_user(&self, user_id: UserId) -> AuthResult<Vec<ApiKey>> {
    Ok(
      self
        .keys
        .lock()
        .expect("test: InMemoryApiKeyStore mutex poisoned")
        .values()
        .filter(|k| k.user_id == user_id)
        .cloned()
        .collect(),
    )
  }
}
