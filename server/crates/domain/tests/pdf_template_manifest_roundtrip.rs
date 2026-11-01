// SPDX-License-Identifier: AGPL-3.0-or-later
//! Round-trip invariant tests for [`PdfTemplateManifest`].
//!
//! Each test deserialises a seed manifest JSON file into a typed
//! [`PdfTemplateManifest`], re-serialises back to a [`serde_json::Value`], and
//! asserts the result is identical to the original.  This guarantees:
//!
//! 1. No fields are silently dropped during deserialisation.
//! 2. No fields are silently renamed/transformed during serialisation.
//! 3. `deny_unknown_fields` on the top-level struct (and nested structs)
//!    catches schema drift early.

use myoxus_domain::pdf_template_manifest::PdfTemplateManifest;

/// Load a manifest JSON file from the seed templates directory and return both
/// the original [`serde_json::Value`] and the round-tripped one.
fn round_trip(path: &str) -> (serde_json::Value, serde_json::Value) {
  let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
  let original: serde_json::Value =
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("cannot parse JSON {path}: {e}"));
  let mft: PdfTemplateManifest = serde_json::from_value(original.clone())
    .unwrap_or_else(|e| panic!("cannot deserialise PdfTemplateManifest from {path}: {e}"));
  let back: serde_json::Value =
    serde_json::to_value(&mft).unwrap_or_else(|e| panic!("cannot serialise PdfTemplateManifest from {path}: {e}"));
  (original, back)
}

/// Invariant MFT-01: the `default` seed manifest round-trips without loss.
///
/// Regression: if any field is dropped by `deny_unknown_fields` or renamed by
/// a serde attribute mismatch, the two `Value`s will differ and this test
/// fails.
#[test]
fn inv_mft01_default_seed_round_trips() {
  let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../templates/pdf/default/manifest.json");
  let (original, back) = round_trip(path);
  assert_eq!(
    original,
    back,
    "default manifest round-trip produced different JSON.\nOriginal:\n{}\nRound-tripped:\n{}",
    serde_json::to_string_pretty(&original).unwrap(),
    serde_json::to_string_pretty(&back).unwrap(),
  );
}

/// Invariant MFT-02: the `report` seed manifest round-trips without loss.
#[test]
fn inv_mft02_report_seed_round_trips() {
  let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../templates/pdf/report/manifest.json");
  let (original, back) = round_trip(path);
  assert_eq!(
    original,
    back,
    "report manifest round-trip produced different JSON.\nOriginal:\n{}\nRound-tripped:\n{}",
    serde_json::to_string_pretty(&original).unwrap(),
    serde_json::to_string_pretty(&back).unwrap(),
  );
}

/// Invariant MFT-03: the `letter` seed manifest round-trips without loss.
#[test]
fn inv_mft03_letter_seed_round_trips() {
  let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../templates/pdf/letter/manifest.json");
  let (original, back) = round_trip(path);
  assert_eq!(
    original,
    back,
    "letter manifest round-trip produced different JSON.\nOriginal:\n{}\nRound-tripped:\n{}",
    serde_json::to_string_pretty(&original).unwrap(),
    serde_json::to_string_pretty(&back).unwrap(),
  );
}

/// Invariant MFT-04: an unknown top-level field is rejected by `deny_unknown_fields`.
///
/// This proves that `PdfTemplateManifest` enforces strict schema adherence and
/// that template bundles cannot smuggle unreviewed keys past the server.
#[test]
fn inv_mft04_unknown_top_level_field_rejected() {
  let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../templates/pdf/default/manifest.json");
  let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read default manifest: {e}"));
  let mut val: serde_json::Value =
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("cannot parse default manifest: {e}"));

  // Inject a foreign top-level key.
  val
    .as_object_mut()
    .expect("manifest must be a JSON object")
    .insert("foo".to_owned(), serde_json::json!("bar"));

  let result = serde_json::from_value::<PdfTemplateManifest>(val);
  assert!(
    result.is_err(),
    "expected deserialisation to fail for unknown field 'foo', but it succeeded"
  );
}
