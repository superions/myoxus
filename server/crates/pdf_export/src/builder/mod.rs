// SPDX-License-Identifier: AGPL-3.0-or-later
//! Yjs → IR builder and asset resolution traits.

use crate::error::AssetError;
use crate::ir::block::AssetData;

/// Resolves binary blob assets (images, attachments) by their blob ID.
// The async fn is used only with concrete generic bounds (not dyn), so the
// missing Send bound is not a problem in practice.
#[allow(async_fn_in_trait)]
///
/// Implementations fetch the raw bytes from storage (opendal, in-memory, etc.)
/// and return them wrapped in [`AssetData`].
pub trait AssetResolver: Send + Sync {
  async fn resolve(&mut self, blob_id: &str) -> Result<AssetData, AssetError>;
}

/// A no-op resolver that always returns `AssetError::BlobNotFound`.
/// Used in tests and when asset resolution is not required.
pub struct NullAssetResolver;

impl AssetResolver for NullAssetResolver {
  async fn resolve(&mut self, blob_id: &str) -> Result<AssetData, AssetError> {
    Err(AssetError::BlobNotFound {
      id: blob_id.to_string(),
    })
  }
}

pub mod yjs;
pub use yjs::YjsIrBuilder;
