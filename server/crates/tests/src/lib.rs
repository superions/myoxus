//! `myoxus-tests` — shared test helpers for integration tests.
//!
//! Provides helpers for loading API contract inventory fixtures used by
//! contract-inventory tests.  All inventory files are baked into the
//! `myoxus-contracts` crate and accessed via the wrappers below so that
//! contract tests in this crate can use a uniform, named API instead of
//! calling `myoxus_contracts::load_inventory_file` with a bare string literal.

use myoxus_contracts::load_inventory_file;

pub mod smtp_fixture;
pub mod sync_incident_fixture;

/// Load the GraphQL operation inventory JSON used by contract tests.
///
/// Reads `myoxus-contracts/inventory/graphql_operations.json`.
pub fn load_graphql_inventory() -> std::io::Result<String> {
  load_inventory_file("graphql_operations.json")
}

/// Load the REST endpoint inventory JSON used by contract tests.
///
/// Reads `myoxus-contracts/inventory/rest_endpoints.json`.
pub fn load_rest_inventory() -> std::io::Result<String> {
  load_inventory_file("rest_endpoints.json")
}

/// Load the blob-attachment contract seed JSON used by contract tests.
///
/// Reads `myoxus-contracts/inventory/blob_attachment_contract.json`.
pub fn load_blob_attachment_contract() -> std::io::Result<String> {
  load_inventory_file("blob_attachment_contract.json")
}

/// Load the Copilot contract seed JSON used by contract tests.
///
/// Reads `myoxus-contracts/inventory/copilot_contract.json`.
pub fn load_copilot_contract() -> std::io::Result<String> {
  load_inventory_file("copilot_contract.json")
}
