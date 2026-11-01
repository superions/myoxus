use crate::ir::{AssetRef, Block, PublicDocIr};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicAssetCandidate {
  pub asset_hash: String,
  pub filename: String,
  pub blob_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetResolution {
  pub source: String,
  pub public_url: Option<String>,
}

/// Private export manifest entry. The renderer references `relative_path`;
/// callers fetch the bytes through their existing authenticated blob boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrivateAssetManifestEntry {
  pub source: String,
  pub relative_path: String,
}

pub fn resolve_asset_candidates(ir: &PublicDocIr) -> Vec<PublicAssetCandidate> {
  let mut seen = HashSet::new();
  ir.document
    .assets
    .iter()
    .filter_map(candidate_from_asset)
    .filter(|candidate| seen.insert((candidate.asset_hash.clone(), candidate.filename.clone())))
    .collect()
}

/// Bind a blob-backed IR asset to its public manifest URL.
///
/// Public delivery only rewrites assets that were explicitly resolved into the
/// manifest. External image URLs are left untouched; internal blob references
/// receive the stable `/public-assets/...` URL after the caller has verified
/// blob metadata or materialized a diagnostic HTML snapshot.
pub fn apply_public_asset_url(ir: &mut PublicDocIr, source: &str, public_url: &str) {
  for asset in &mut ir.document.assets {
    if normalized_asset_source(&asset.source) == source {
      asset.public_url = Some(public_url.to_string());
    }
  }
  for block in &mut ir.document.blocks {
    apply_block_asset_url(block, source, public_url);
  }
}

fn apply_block_asset_url(block: &mut Block, source: &str, public_url: &str) {
  match block {
    Block::Image { asset, .. } if normalized_asset_source(&asset.source) == source => {
      asset.public_url = Some(public_url.to_string());
    }
    Block::Callout { children, .. } | Block::FootnoteDefinition { children, .. } => {
      for child in children {
        apply_block_asset_url(child, source, public_url);
      }
    }
    Block::List { list, .. } => {
      for item in &mut list.items {
        for child in &mut item.children {
          apply_block_asset_url(child, source, public_url);
        }
      }
    }
    _ => {}
  }
}

/// Rewrite internal image sources to deterministic relative export paths.
///
/// No bytes or public URLs are embedded. The returned manifest is deliberately
/// transport-neutral so MCP can add authenticated `blob_read` arguments while
/// other private exporters can materialize the same paths themselves.
pub fn apply_private_asset_paths(ir: &mut PublicDocIr) -> Vec<PrivateAssetManifestEntry> {
  let candidates = resolve_asset_candidates(ir);
  let mut manifest = Vec::with_capacity(candidates.len());
  for candidate in candidates {
    let relative_path = format!("assets/{}/{}", candidate.asset_hash, candidate.filename);
    apply_public_asset_url(ir, &candidate.blob_key, &relative_path);
    manifest.push(PrivateAssetManifestEntry {
      source: candidate.blob_key,
      relative_path,
    });
  }
  manifest
}

fn candidate_from_asset(asset: &AssetRef) -> Option<PublicAssetCandidate> {
  if is_external_asset_source(&asset.source) || asset.source.trim().is_empty() {
    return None;
  }
  let blob_key = normalized_asset_source(&asset.source);
  let filename = safe_asset_filename(&blob_key);
  let mut hasher = Sha256::new();
  hasher.update(blob_key.as_bytes());
  Some(PublicAssetCandidate {
    asset_hash: hex::encode(hasher.finalize()),
    filename,
    blob_key,
  })
}

/// Return whether an asset source is an externally hosted HTTP resource.
///
/// Private exporters use the same classification as the public renderer so an
/// external URL can never be misrepresented as an authenticated workspace blob.
pub fn is_external_asset_source(value: &str) -> bool {
  value.starts_with("http://") || value.starts_with("https://")
}

fn normalized_asset_source(value: &str) -> String {
  value.trim().trim_start_matches('/').to_string()
}

/// Produce a portable leaf name for a relative export bundle.
///
/// Blob keys are identifiers, not trusted filesystem paths. Restricting the
/// rendered leaf to a compact ASCII set prevents traversal segments, control
/// characters and platform-specific separators from becoming export paths.
fn safe_asset_filename(blob_key: &str) -> String {
  let leaf = blob_key.rsplit(['/', '\\']).next().unwrap_or_default();
  let mut safe = leaf
    .chars()
    .take(160)
    .map(|character| {
      if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
        character
      } else {
        '_'
      }
    })
    .collect::<String>();
  if safe.is_empty() || safe == "." || safe == ".." {
    safe = "asset".to_string();
  }
  safe
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn private_asset_filenames_are_relative_and_portable() {
    assert_eq!(safe_asset_filename("folder/image one.png"), "image_one.png");
    assert_eq!(safe_asset_filename(r"folder\windows.svg"), "windows.svg");
    assert_eq!(safe_asset_filename("folder/.."), "asset");
    assert_eq!(safe_asset_filename("folder/<script>.svg"), "_script_.svg");
  }
}
