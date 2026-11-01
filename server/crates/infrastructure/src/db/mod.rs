//! Database configuration and infrastructure sub-modules.
//!
//! [`DatabaseConfig`] is deserialized from the YAML/env configuration and
//! passed to the SQLx pool builder.  The sub-modules document schema design
//! decisions (ID strategy, schema manifest, migration mappings, transaction
//! boundary notes) at compile time without incurring runtime cost.

pub mod id_strategy;
pub mod migration_mappings;
pub mod schema_manifest;
pub mod transaction_boundaries;

use serde::{Deserialize, Serialize};

/// Configuration for the PostgreSQL connection pool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseConfig {
  /// PostgreSQL connection URL (e.g. `postgres://user:pass@host/db`).
  pub url: String,
  /// Maximum number of connections the pool will maintain.
  pub max_connections: u32,
  /// Minimum number of idle connections kept warm.
  pub min_connections: u32,
  /// Maximum time (in seconds) to wait for a connection before erroring.
  pub connect_timeout_seconds: u64,
}
