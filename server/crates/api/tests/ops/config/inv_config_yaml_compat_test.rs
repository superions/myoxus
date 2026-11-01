// SPDX-License-Identifier: AGPL-3.0-or-later
//! P91-CFG-G-03 — YAML Backwards Compatibility Invariant Tests.
//!
//! Verifies that old byte-based YAML keys are accepted via serde aliases
//! on StorageConfig and WebSocketConfig.  The aliases allow legacy YAML
//! configs (using `maxUploadBytes`, `multipartThresholdBytes`, etc.) to
//! deserialize into the new MB-named fields.

use myoxus_api::config::{StorageConfig, WebSocketConfig};
use myoxus_contracts::config_document::decode_typed_yaml_document;

/// INV-YAML-01: Old `maxUploadBytes` key deserializes into `max_upload_mb` via alias.
#[test]
fn inv_yaml01_max_upload_bytes_alias() {
  let yaml = "maxUploadBytes: 536870912";
  let cfg: StorageConfig = decode_typed_yaml_document(yaml).expect("alias should parse");
  assert_eq!(
    cfg.max_upload_mb, 536_870_912,
    "alias should put value into max_upload_mb"
  );
}

/// INV-YAML-02: Having both an alias and its canonical key in the same YAML
/// document is a parse error (serde treats both as duplicates for the same field).
/// Correct migration: replace the alias key with the canonical key.
#[test]
fn inv_yaml02_canonical_key_overrides_alias() {
  // Using both alias (maxUploadBytes) and canonical (max_upload_mb) is a
  // duplicate-field error with serde — the operator must use only one.
  let yaml_both = "maxUploadBytes: 536870912\nmax_upload_mb: 100";
  assert!(
    decode_typed_yaml_document::<StorageConfig>(yaml_both).is_err(),
    "Having both alias and canonical key in the same YAML document must be a parse error"
  );

  // Canonical key alone works correctly.
  let yaml_canonical = "max_upload_mb: 100";
  let cfg: StorageConfig = decode_typed_yaml_document(yaml_canonical).expect("canonical key should parse");
  assert_eq!(cfg.max_upload_mb, 100, "canonical key should deserialize correctly");
}

/// INV-YAML-03: `multipartThresholdBytes` alias deserializes correctly.
#[test]
fn inv_yaml03_multipart_threshold_alias() {
  let yaml = "multipartThresholdBytes: 8388608";
  let cfg: StorageConfig = decode_typed_yaml_document(yaml).expect("alias should parse");
  assert_eq!(cfg.multipart_threshold_mb, 8_388_608);
}

/// INV-YAML-04: `minFreeSpaceBytes` alias deserializes correctly.
#[test]
fn inv_yaml04_min_free_space_alias() {
  let yaml = "minFreeSpaceBytes: 1073741824";
  let cfg: StorageConfig = decode_typed_yaml_document(yaml).expect("alias should parse");
  assert_eq!(cfg.min_free_space_mb, 1_073_741_824);
}

/// INV-YAML-05: WebSocket `maxHttpBufferSize` alias deserializes into `max_http_buffer_size_mb`.
#[test]
fn inv_yaml05_ws_max_buffer_alias() {
  let yaml = "maxHttpBufferSize: 104857600";
  let cfg: WebSocketConfig = decode_typed_yaml_document(yaml).expect("alias should parse");
  assert_eq!(cfg.max_http_buffer_size_mb, 104_857_600);
}

/// INV-YAML-06: Canonical MB keys still work for StorageConfig.
#[test]
fn inv_yaml06_canonical_mb_keys() {
  let yaml = "max_upload_mb: 512\nmultipart_threshold_mb: 8\nmin_free_space_mb: 100";
  let cfg: StorageConfig = decode_typed_yaml_document(yaml).expect("canonical keys should parse");
  assert_eq!(cfg.max_upload_mb, 512);
  assert_eq!(cfg.multipart_threshold_mb, 8);
  assert_eq!(cfg.min_free_space_mb, 100);
}

/// INV-YAML-07: Canonical MB key works for WebSocket config.
#[test]
fn inv_yaml07_ws_canonical_mb_key() {
  let yaml = "max_http_buffer_size_mb: 200";
  let cfg: WebSocketConfig = decode_typed_yaml_document(yaml).expect("canonical key should parse");
  assert_eq!(cfg.max_http_buffer_size_mb, 200);
}
