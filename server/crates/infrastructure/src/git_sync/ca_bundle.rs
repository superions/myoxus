// SPDX-License-Identifier: AGPL-3.0-or-later
//! Process-wide libgit2 adapter for the shared additional CA bundle.

use crate::tls::{ValidatedCaBundle, load_bundle};
use std::path::Path;

/// Initialize libgit2 before constructing any Git transport or starting Git work.
pub fn materialize(root: &Path, configured: &str) -> Result<Option<ValidatedCaBundle>, String> {
  let bundle = load_bundle(root, configured)?;
  if let Some(bundle) = &bundle {
    initialize(bundle)?;
  }
  Ok(bundle)
}

/// Apply the startup snapshot before concurrent Git work. Keep its owner alive
/// for the entire process: libgit2 can reopen the materialized file later.
pub fn initialize(bundle: &ValidatedCaBundle) -> Result<(), String> {
  // SAFETY: composition roots call this before concurrent Git operations.
  unsafe {
    git2::opts::set_ssl_cert_file(bundle.materialized_path())
      .map_err(|error| format!("could not configure the Git-Sync CA bundle: {error}"))?;
  }
  Ok(())
}
