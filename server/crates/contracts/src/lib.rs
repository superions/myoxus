//! `myoxus-contracts` — shared runtime contracts and test inventory helpers.
//!
//! Provides utilities for loading API contract fixtures from the `inventory/`
//! directory baked into the crate at compile time. Used by contract-inventory
//! tests in `crates/contracts/tests/` to verify that all required GraphQL
//! operations and copilot endpoints are present and correctly typed.

use std::path::{Path, PathBuf};

pub mod client_update;
pub mod config_document;
pub mod copilot;
pub mod effective_config;
pub mod oauth_config;
pub mod runtime_config;

/// Return the path to the `inventory/` directory adjacent to this crate's
/// `Cargo.toml`.
pub fn inventory_dir() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("inventory")
}

/// Read an inventory fixture file by name and return its contents as a
/// `String`.  Returns an `io::Error` if the file does not exist or cannot
/// be read.
pub fn load_inventory_file(file_name: &str) -> std::io::Result<String> {
  std::fs::read_to_string(inventory_dir().join(file_name))
}
