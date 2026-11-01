// SPDX-License-Identifier: AGPL-3.0-or-later
//! Invariant tests for template_registry config binding/defaults.

use myoxus_api::config::{TemplateRegistryConfig, TemplateRegistryZipLimitsConfig};
use myoxus_application::template_registry::TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION;
use serde::Deserialize;

#[test]
fn inv_tr_cfg_zip01_zip_limits_defaults() {
  let cfg = TemplateRegistryZipLimitsConfig::default();
  assert_eq!(cfg.max_entries, 256);
  assert_eq!(cfg.max_total_uncompressed_size_mb, 200);
  assert_eq!(cfg.max_entry_uncompressed_size_mb, 50);
  assert_eq!(cfg.max_compression_ratio, 200.0);
  assert_eq!(cfg.max_path_length, 512);
}

#[test]
fn inv_tr_cfg_zip02_zip_limits_yaml_full_override() {
  let yaml = r#"
max_entries: 900
max_total_uncompressed_size_mb: 320
max_entry_uncompressed_size_mb: 75
max_compression_ratio: 80.5
max_path_length: 1024
"#;
  let cfg: TemplateRegistryZipLimitsConfig = yaml_serde::from_str(yaml).expect("zip limits YAML should parse");
  assert_eq!(cfg.max_entries, 900);
  assert_eq!(cfg.max_total_uncompressed_size_mb, 320);
  assert_eq!(cfg.max_entry_uncompressed_size_mb, 75);
  assert_eq!(cfg.max_compression_ratio, 80.5);
  assert_eq!(cfg.max_path_length, 1024);
}

#[test]
fn inv_tr_cfg_zip03_zip_limits_yaml_partial_uses_defaults() {
  let yaml = r#"
max_entries: 42
max_compression_ratio: 12.0
"#;
  let cfg: TemplateRegistryZipLimitsConfig = yaml_serde::from_str(yaml).expect("partial zip limits YAML should parse");
  assert_eq!(cfg.max_entries, 42);
  assert_eq!(cfg.max_compression_ratio, 12.0);
  assert_eq!(cfg.max_total_uncompressed_size_mb, 200);
  assert_eq!(cfg.max_entry_uncompressed_size_mb, 50);
  assert_eq!(cfg.max_path_length, 512);
}

#[test]
fn inv_tr_cfg_zip04_template_registry_defaults_embed_zip_defaults() {
  let cfg = TemplateRegistryConfig::default();
  assert!(!cfg.enabled);
  assert_eq!(cfg.import_max_bundle_size_mb, 50);
  assert_eq!(cfg.reconcile_default_mode, "managed_until_local_edit");
  assert!(cfg.drift_scan_enabled);
  assert_eq!(cfg.drift_scan_interval_seconds, 3600);
  assert_eq!(cfg.zip_limits.max_entries, 256);
  assert_eq!(cfg.zip_limits.max_total_uncompressed_size_mb, 200);
  assert_eq!(cfg.zip_limits.max_entry_uncompressed_size_mb, 50);
  assert_eq!(cfg.zip_limits.max_compression_ratio, 200.0);
  assert_eq!(cfg.zip_limits.max_path_length, 512);
}

#[derive(Deserialize)]
struct TemplateRegistryWrapper {
  template_registry: TemplateRegistryConfig,
}

#[test]
fn inv_tr_cfg_zip05_yaml_binding_for_template_registry_zip_limits() {
  let yaml = r#"
template_registry:
  enabled: true
  import_max_bundle_size_mb: 80
  zip_limits:
    max_entries: 777
    max_total_uncompressed_size_mb: 555
"#;
  let cfg: TemplateRegistryWrapper = yaml_serde::from_str(yaml).expect("template_registry YAML should parse");
  let tr = cfg.template_registry;

  assert!(tr.enabled);
  assert_eq!(tr.import_max_bundle_size_mb, 80);
  assert_eq!(tr.zip_limits.max_entries, 777);
  assert_eq!(tr.zip_limits.max_total_uncompressed_size_mb, 555);
  // Unspecified nested keys must still come from defaults.
  assert_eq!(tr.zip_limits.max_entry_uncompressed_size_mb, 50);
  assert_eq!(tr.zip_limits.max_compression_ratio, 200.0);
  assert_eq!(tr.zip_limits.max_path_length, 512);
}

#[test]
fn inv_tr_cfg_zip06_error_catalog_version_format_guard() {
  let v = TEMPLATE_REGISTRY_ERROR_CATALOG_VERSION;
  let (date, revision) = v.split_once(".v").expect("error catalog version must contain '.v'");
  assert_eq!(date.len(), 10, "date must use YYYY-MM-DD");
  assert_eq!(&date[4..5], "-");
  assert_eq!(&date[7..8], "-");
  assert!(
    date.chars().enumerate().all(|(idx, c)| {
      if idx == 4 || idx == 7 {
        c == '-'
      } else {
        c.is_ascii_digit()
      }
    }),
    "date must match YYYY-MM-DD"
  );
  assert!(!revision.is_empty(), "revision suffix must not be empty");
  assert!(
    revision.chars().all(|c| c.is_ascii_digit()),
    "revision suffix must be numeric"
  );
}
