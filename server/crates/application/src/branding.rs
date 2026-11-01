// SPDX-License-Identifier: AGPL-3.0-or-later
//! Persistence boundary for app/server branding assets.

use async_trait::async_trait;
use uuid::Uuid;

use crate::auth::{AuthError, AuthResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlobalBrandAssetSlot {
  Logo,
  ProductMark,
  FaviconPack,
}

#[derive(Debug, Clone)]
pub struct GlobalBrandAssetUpsert {
  pub slot: GlobalBrandAssetSlot,
  pub storage_key: String,
  pub public_path: String,
  pub mime: String,
  pub sha256: String,
  pub byte_size: i64,
  pub created_by: Uuid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicBrandAsset {
  pub storage_key: String,
  pub mime: String,
  pub sha256: String,
}

#[async_trait]
pub trait BrandingAssetRepository: Send + Sync {
  async fn upsert_global_asset(&self, asset: GlobalBrandAssetUpsert) -> AuthResult<()>;
  async fn public_style_asset(&self, public_path: &str) -> AuthResult<Option<PublicBrandAsset>>;
  async fn favicon_pack_asset(&self) -> AuthResult<Option<PublicBrandAsset>>;
}

/// Fail-fast adapter used by API tests that do not configure branding storage.
pub struct UnavailableBrandingAssetRepository;

#[async_trait]
impl BrandingAssetRepository for UnavailableBrandingAssetRepository {
  async fn upsert_global_asset(&self, _asset: GlobalBrandAssetUpsert) -> AuthResult<()> {
    Err(AuthError::Storage(
      "branding asset repository is not configured".to_string(),
    ))
  }

  async fn public_style_asset(&self, _public_path: &str) -> AuthResult<Option<PublicBrandAsset>> {
    Err(AuthError::Storage(
      "branding asset repository is not configured".to_string(),
    ))
  }

  async fn favicon_pack_asset(&self) -> AuthResult<Option<PublicBrandAsset>> {
    Err(AuthError::Storage(
      "branding asset repository is not configured".to_string(),
    ))
  }
}
