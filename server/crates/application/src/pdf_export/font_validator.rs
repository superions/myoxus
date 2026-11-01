// SPDX-License-Identifier: AGPL-3.0-or-later
//! Font binary validator for PDF-Export V2 (`P-PDF-TPL-FONT-01-{02,03}`).
//!
//! Sniffs the magic bytes of an uploaded font binary, rejects webfont
//! containers (WOFF/WOFF2), parses the OS/2 + `name` tables via
//! `ttf-parser`, and auto-detects the license from the `name` table (id 13
//! "License Description" + id 14 "License URL").
//!
//! The output is a [`FontMetadata`] consumed by the `uploadPdfFont` GraphQL
//! mutation — it carries the family/style/weight/license fields needed to
//! persist a `pdf_fonts` row.

use myoxus_domain::entities::PdfFontLicense;
use ttf_parser::name::name_id;

/// PDF-hotpath font container detected from the file's magic bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontContainer {
  /// Raw SFNT (TrueType / OpenType). Magic: `0x00010000`, `OTTO`, or `true`.
  Sfnt,
}

impl FontContainer {
  /// Suggested file extension for this container, used when constructing
  /// blob storage keys.
  pub fn extension(self) -> &'static str {
    match self {
      Self::Sfnt => "ttf",
    }
  }
}

/// Successfully validated and parsed font metadata.
#[derive(Debug, Clone)]
pub struct FontMetadata {
  /// Container format detected from the input bytes.
  pub container: FontContainer,
  /// Typographic family name (`name` table id 16, falling back to id 1).
  pub family_name: String,
  /// Typographic subfamily / style (`name` table id 17, falling back to id 2).
  pub style: String,
  /// CSS-style weight in [100, 900], read from the OS/2 `usWeightClass` field.
  pub weight: u16,
  /// License auto-detected from the `name` table. `None` means no
  /// recognisable hint was found and the admin must pick one explicitly when
  /// approving.
  pub detected_license: Option<PdfFontLicense>,
  /// Raw license-description text (`name` table id 13), if present. Stored
  /// for audit / display purposes.
  pub license_description: Option<String>,
  /// License URL (`name` table id 14), if present.
  pub license_url: Option<String>,
}

/// Reasons a font upload can be rejected.
#[derive(Debug, thiserror::Error)]
pub enum FontValidationError {
  /// The byte slice is empty.
  #[error("empty font binary")]
  Empty,
  /// The leading bytes do not match any supported container.
  #[error("unrecognised font format (magic bytes: {0})")]
  UnknownFormat(String),
  /// Webfont containers are valid for browsers but forbidden in the PDF path.
  #[error("{0} is not supported for PDF export; upload TTF or OTF")]
  UnsupportedWebFont(&'static str),
  /// `ttf-parser` could not parse the SFNT tables.
  #[error("invalid font binary: {0}")]
  InvalidSfnt(String),
  /// OS/2 weight class was outside the legal CSS range [1, 1000].
  #[error("invalid weight class {0} (must be 1..=1000)")]
  InvalidWeight(u16),
  /// Required `name` table entries (family, style) were absent or empty.
  #[error("font is missing required name table entries: {0}")]
  MissingNameEntries(&'static str),
}

/// Inspect the leading bytes and decide which container format we have.
fn sniff_container(bytes: &[u8]) -> Result<FontContainer, FontValidationError> {
  if bytes.len() < 4 {
    return Err(FontValidationError::UnknownFormat(format!(
      "{} bytes is too short to contain a magic number",
      bytes.len()
    )));
  }
  let magic = &bytes[..4];
  match magic {
    // SFNT (TrueType): version 1.0 stored big-endian.
    [0x00, 0x01, 0x00, 0x00] => Ok(FontContainer::Sfnt),
    // SFNT (TrueType, legacy Apple): "true".
    b"true" => Ok(FontContainer::Sfnt),
    // SFNT (OpenType / CFF): "OTTO".
    b"OTTO" => Ok(FontContainer::Sfnt),
    // SFNT (TrueType collection — not supported, single-font only).
    b"ttcf" => Err(FontValidationError::UnknownFormat(
      "TrueType collections (.ttc) are not supported — upload a single-font file".to_owned(),
    )),
    // WOFF/WOFF2 are browser webfont containers. Typst/PDF hotpath only
    // accepts raw SFNT TTF/OTF bytes so uploads fail before persistence.
    b"wOFF" => Err(FontValidationError::UnsupportedWebFont("WOFF")),
    b"wOF2" => Err(FontValidationError::UnsupportedWebFont("WOFF2")),
    other => {
      let printable: String = other
        .iter()
        .map(|b| {
          if b.is_ascii_graphic() {
            (*b as char).to_string()
          } else {
            format!("\\x{:02X}", b)
          }
        })
        .collect();
      Err(FontValidationError::UnknownFormat(printable))
    }
  }
}

/// Return raw SFNT bytes for the PDF hotpath.
fn decode_to_sfnt(container: FontContainer, bytes: &[u8]) -> Result<Vec<u8>, FontValidationError> {
  match container {
    FontContainer::Sfnt => Ok(bytes.to_vec()),
  }
}

/// Pull a UTF-16BE name table entry, preferring the Windows platform.
fn name_table_string(face: &ttf_parser::Face, target_id: u16) -> Option<String> {
  let names = face.names();
  // Pass 1: prefer Windows platform / Unicode encoding (en-US locale 0x0409
  // when present, otherwise the first match of any locale).
  let mut best_us: Option<String> = None;
  let mut best_any: Option<String> = None;
  for i in 0..names.len() {
    let n = names.get(i)?;
    if n.name_id != target_id {
      continue;
    }
    // ttf-parser only decodes Unicode-shaped name records via `to_string`.
    let Some(text) = n.to_string() else { continue };
    if text.is_empty() {
      continue;
    }
    if n.platform_id == ttf_parser::PlatformId::Windows && n.language_id == 0x0409 && best_us.is_none() {
      best_us = Some(text.clone());
    }
    if best_any.is_none() {
      best_any = Some(text);
    }
  }
  best_us.or(best_any)
}

/// Match license keywords with case-insensitive substring search. Order
/// matters — more specific identifiers (e.g. "OFL-1.1") take precedence over
/// generic ones ("MIT").
fn detect_license_from_text(text: &str) -> Option<PdfFontLicense> {
  let lower = text.to_lowercase();
  // SIL Open Font License — single most common open-font license.
  if lower.contains("open font license") || lower.contains("ofl-1.1") || lower.contains("ofl 1.1") {
    return Some(PdfFontLicense::Ofl11);
  }
  if lower.contains("apache license") || lower.contains("apache-2.0") || lower.contains("apache 2.0") {
    return Some(PdfFontLicense::Apache20);
  }
  // GPL must be checked before MIT because some licenses include "MIT" in
  // attribution boilerplate but are GPL.
  if lower.contains("gnu general public license") || lower.contains("gpl") {
    return Some(PdfFontLicense::Gpl);
  }
  if lower.contains("mit license") || lower.contains("mit-0") || lower.contains("mit/x11") {
    return Some(PdfFontLicense::Mit);
  }
  None
}

/// Validate raw font bytes uploaded by an admin.
///
/// Performs all checks needed to safely persist a `pdf_fonts` row:
///
/// 1. Empty-input rejection.
/// 2. Container sniffing (TTF/OTF only; WOFF/WOFF2 fail closed).
/// 3. Parsing of OS/2 + `name` tables via `ttf-parser`.
/// 4. License auto-detection from `name` table id 13/14.
pub fn validate_font_bytes(bytes: &[u8]) -> Result<FontMetadata, FontValidationError> {
  if bytes.is_empty() {
    return Err(FontValidationError::Empty);
  }

  let container = sniff_container(bytes)?;
  let sfnt = decode_to_sfnt(container, bytes)?;

  let face = ttf_parser::Face::parse(&sfnt, 0).map_err(|e| FontValidationError::InvalidSfnt(e.to_string()))?;

  // Family: prefer the typographic family name (id 16); fall back to the
  // legacy compatible-family (id 1). One of the two is always populated for
  // any conformant font.
  let family_name = name_table_string(&face, name_id::TYPOGRAPHIC_FAMILY)
    .or_else(|| name_table_string(&face, name_id::FAMILY))
    .ok_or(FontValidationError::MissingNameEntries(
      "missing family name (name table id 1 or 16)",
    ))?;

  // Style: prefer typographic subfamily (id 17), fall back to subfamily (id 2).
  let style = name_table_string(&face, name_id::TYPOGRAPHIC_SUBFAMILY)
    .or_else(|| name_table_string(&face, name_id::SUBFAMILY))
    .unwrap_or_else(|| "Regular".to_owned());

  // Weight class: ttf-parser exposes the OS/2 `usWeightClass` via Face::weight().
  let weight: u16 = face.weight().to_number();
  if !(1..=1000).contains(&weight) {
    return Err(FontValidationError::InvalidWeight(weight));
  }

  let license_description = name_table_string(&face, name_id::LICENSE);
  let license_url = name_table_string(&face, name_id::LICENSE_URL);

  let detected_license = license_description
    .as_deref()
    .and_then(detect_license_from_text)
    .or_else(|| license_url.as_deref().and_then(detect_license_from_text));

  Ok(FontMetadata {
    container,
    family_name,
    style,
    weight,
    detected_license,
    license_description,
    license_url,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn empty_input_is_rejected() {
    let err = validate_font_bytes(&[]).unwrap_err();
    assert!(matches!(err, FontValidationError::Empty), "got: {err:?}");
  }

  #[test]
  fn random_bytes_are_rejected_with_unknown_format() {
    let mut bytes = vec![0u8; 64];
    bytes[0] = 0x42;
    bytes[1] = 0x43;
    bytes[2] = 0x44;
    bytes[3] = 0x45;
    let err = validate_font_bytes(&bytes).unwrap_err();
    assert!(matches!(err, FontValidationError::UnknownFormat(_)), "got: {err:?}");
  }

  #[test]
  fn truncated_input_is_rejected() {
    let err = validate_font_bytes(b"OT").unwrap_err();
    assert!(
      matches!(err, FontValidationError::UnknownFormat(_)),
      "fewer than 4 bytes must fail container sniffing, got: {err:?}"
    );
  }

  #[test]
  fn ttc_collection_rejected_explicitly() {
    let mut bytes = b"ttcf".to_vec();
    bytes.extend_from_slice(&[0u8; 64]);
    let err = validate_font_bytes(&bytes).unwrap_err();
    match err {
      FontValidationError::UnknownFormat(msg) => assert!(
        msg.contains("collection") || msg.contains("ttc"),
        "ttc rejection must mention collections: {msg}"
      ),
      other => panic!("expected UnknownFormat, got: {other:?}"),
    }
  }

  #[test]
  fn woff1_rejected_with_clear_message() {
    let mut bytes = b"wOFF".to_vec();
    bytes.extend_from_slice(&[0u8; 60]);
    let err = validate_font_bytes(&bytes).unwrap_err();
    match err {
      FontValidationError::UnsupportedWebFont(format) => {
        assert_eq!(format, "WOFF");
      }
      other => panic!("expected UnsupportedWebFont for WOFF1, got: {other:?}"),
    }
  }

  #[test]
  fn woff2_rejected_with_clear_message() {
    let mut bytes = b"wOF2".to_vec();
    bytes.extend_from_slice(&[0u8; 60]);
    let err = validate_font_bytes(&bytes).unwrap_err();
    match err {
      FontValidationError::UnsupportedWebFont(format) => {
        assert_eq!(format, "WOFF2");
        assert!(err.to_string().contains("upload TTF or OTF"));
      }
      other => panic!("expected UnsupportedWebFont for WOFF2, got: {other:?}"),
    }
  }

  #[test]
  fn detect_license_recognises_ofl_keyword() {
    let lic = detect_license_from_text("This font is licensed under the SIL Open Font License, Version 1.1.").unwrap();
    assert!(matches!(lic, PdfFontLicense::Ofl11));
  }

  #[test]
  fn detect_license_recognises_apache_keyword() {
    let lic = detect_license_from_text("Licensed under the Apache License, Version 2.0").unwrap();
    assert!(matches!(lic, PdfFontLicense::Apache20));
  }

  #[test]
  fn detect_license_recognises_mit_keyword() {
    let lic = detect_license_from_text("Released under the MIT License.").unwrap();
    assert!(matches!(lic, PdfFontLicense::Mit));
  }

  #[test]
  fn detect_license_returns_none_for_proprietary_text() {
    assert!(detect_license_from_text("All rights reserved. Commercial license required.").is_none());
  }

  #[test]
  fn real_inter_woff2_fixture_is_rejected() {
    // The fixture lives under `server/static/fonts/` at the workspace root.
    // CARGO_MANIFEST_DIR points at `server/crates/application` for this crate.
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture = manifest_dir.join("../../static/fonts/inter-regular-latin.woff2");
    let Ok(bytes) = std::fs::read(&fixture) else {
      eprintln!("skipping: {} not present in this checkout", fixture.display());
      return;
    };
    let err = validate_font_bytes(&bytes).expect_err("real Inter WOFF2 must be rejected");
    assert!(
      matches!(err, FontValidationError::UnsupportedWebFont("WOFF2")),
      "got: {err:?}"
    );
  }
}
