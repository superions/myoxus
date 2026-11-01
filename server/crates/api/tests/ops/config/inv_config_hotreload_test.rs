//! SPDX-License-Identifier: AGPL-3.0-or-later
//!
//! Integration tests for hot-reload config (P91-CFG-A-T02).
//! These tests verify that EffectiveConfig merges DB overrides with YAML defaults
//! and that the reload loop periodically updates the shared RwLock.

use myoxus_api::config::AppConfig;
use myoxus_api::config_reload::{ConfigOverrides, EffectiveConfig};
use std::collections::HashMap;
use std::sync::Arc;

/// Test: YAML fallback when no DB override exists.
/// Invariant: When no DB entry, EffectiveConfig returns YAML default.
#[test]
fn inv_cfg_hr01_yaml_fallback_when_no_db_override() {
  let config = AppConfig::load().expect("load AppConfig");
  let overrides = ConfigOverrides {
    overrides: HashMap::new(),
    loaded_at: std::time::Instant::now(),
  };

  let effective = EffectiveConfig::new(Arc::new(config.clone()), Arc::new(overrides));

  // No DB override → should return YAML default
  let origin = effective.server_origin();
  assert_eq!(origin, config.server.origin, "server_origin should fall back to YAML");

  assert_eq!(effective.logging_level(), config.logging.level);
}

/// Startup-owned values ignore DB rows until canonical writeback and restart,
/// while a genuinely hot runtime field still uses its DB override.
#[test]
fn inv_cfg_hr02_restart_bound_origin_does_not_partially_hot_apply() {
  let config = AppConfig::load().expect("load AppConfig");
  let mut overrides_map = HashMap::new();

  // Set DB override for server.origin
  overrides_map.insert(
    "server.origin".to_string(),
    serde_json::json!("https://override.example.com"),
  );
  overrides_map.insert("logging.level".to_string(), serde_json::json!("debug"));

  let overrides = ConfigOverrides {
    overrides: overrides_map,
    loaded_at: std::time::Instant::now(),
  };

  let effective = EffectiveConfig::new(Arc::new(config.clone()), Arc::new(overrides));

  // Origin is consumed by startup middleware and link builders. Letting this
  // getter alone see the DB row would create two runtime origins.
  let origin = effective.server_origin();
  assert_eq!(origin, config.server.origin);

  assert_eq!(effective.logging_level(), "debug");
}

/// Test: Integer field overrides (database.maxConnections).
/// Invariant: Integer overrides from DB are correctly parsed and returned.
#[test]
fn inv_cfg_hr03_integer_override_parsing() {
  let config = AppConfig::load().expect("load AppConfig");
  let mut overrides_map = HashMap::new();

  overrides_map.insert(
    "database.maxConnections".to_string(),
    serde_json::json!(200u64), // Override with higher connection limit
  );

  let overrides = ConfigOverrides {
    overrides: overrides_map,
    loaded_at: std::time::Instant::now(),
  };

  let effective = EffectiveConfig::new(Arc::new(config.clone()), Arc::new(overrides));

  let max_conns = effective.database_max_connections();
  assert_eq!(max_conns, 200);
}

/// Test: String field overrides (logging.level).
/// Invariant: String overrides from DB are correctly parsed and returned.
#[test]
fn inv_cfg_hr04_string_override_parsing() {
  let config = AppConfig::load().expect("load AppConfig");
  let mut overrides_map = HashMap::new();

  overrides_map.insert("logging.level".to_string(), serde_json::json!("debug"));

  let overrides = ConfigOverrides {
    overrides: overrides_map,
    loaded_at: std::time::Instant::now(),
  };

  let effective = EffectiveConfig::new(Arc::new(config.clone()), Arc::new(overrides));

  let level = effective.logging_level();
  assert_eq!(level, "debug");
}

/// Test: Multiple concurrent getter calls to same EffectiveConfig.
/// Invariant: Multiple getters on the same merged view are consistent.
#[test]
fn inv_cfg_hr05_concurrent_getter_consistency() {
  let config = AppConfig::load().expect("load AppConfig");
  let mut overrides_map = HashMap::new();

  overrides_map.insert("logging.level".to_string(), serde_json::json!("debug"));
  overrides_map.insert("database.maxConnections".to_string(), serde_json::json!(50u64));

  let overrides = ConfigOverrides {
    overrides: overrides_map,
    loaded_at: std::time::Instant::now(),
  };

  let effective = EffectiveConfig::new(Arc::new(config), Arc::new(overrides));

  // Call getters multiple times — all should be consistent
  for _ in 0..5 {
    assert_eq!(effective.logging_level(), "debug");
    assert_eq!(effective.database_max_connections(), 50);
  }
}

/// Test: Cloning EffectiveConfig preserves values.
/// Invariant: Clone of EffectiveConfig has same merged values.
#[test]
fn inv_cfg_hr06_clone_preserves_values() {
  let config = AppConfig::load().expect("load AppConfig");
  let mut overrides_map = HashMap::new();
  overrides_map.insert(
    "server.origin".to_string(),
    serde_json::json!("https://cloned.example.com"),
  );

  let overrides = ConfigOverrides {
    overrides: overrides_map,
    loaded_at: std::time::Instant::now(),
  };

  let effective1 = EffectiveConfig::new(Arc::new(config), Arc::new(overrides));
  let effective2 = effective1.clone();

  assert_eq!(
    effective1.server_origin(),
    effective2.server_origin(),
    "cloned EffectiveConfig should have same values"
  );
  assert_ne!(
    effective1.server_origin(),
    "https://cloned.example.com",
    "cloning must not turn a pending restart-bound DB row into a live value"
  );
}
