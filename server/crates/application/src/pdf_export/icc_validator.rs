// SPDX-License-Identifier: AGPL-3.0-or-later
//! ICC color profile header validator for PDF-Export V2.
//!
//! Uses the `moxcms` crate (a pure-Rust ICC parser, no native libs required)
//! to parse profile headers and reject files that are not valid sRGB or CMYK
//! ICC profiles. The spec originally listed `lcms2 = "6"` but `lcms2` is not
//! available in the offline cargo registry; `moxcms` provides equivalent
//! `ColorProfile::new_from_slice` + `DataColorSpace` + `ProfileClass` APIs.
//!
//! Deviation from spec: `lcms2` replaced by `moxcms = "0.8"`.

use moxcms::{ColorProfile, DataColorSpace, ProfileClass};

use myoxus_domain::entities::PdfIccProfileType;

/// Result of a successful ICC validation.
#[derive(Debug, Clone)]
pub struct DetectedIcc {
  /// moxcms profile class (InputDevice, DisplayDevice, OutputDevice, …).
  pub profile_class: ProfileClass,
  /// moxcms color-space signature (Rgb, Cmyk, …).
  pub color_space: DataColorSpace,
  /// Human-readable description extracted from the profile, if present.
  pub description: Option<String>,
  /// Mapped Myoxus profile type.
  pub claimed_type: PdfIccProfileType,
}

/// Reasons an ICC file can be rejected.
#[derive(Debug, thiserror::Error)]
pub enum IccValidationError {
  /// The byte slice is empty.
  #[error("empty ICC profile")]
  Empty,
  /// moxcms could not parse the profile header.
  #[error("invalid ICC header: {0}")]
  InvalidHeader(String),
  /// Profile color space is not RGB or CMYK.
  #[error("unsupported ICC color space: {0}")]
  UnsupportedColorSpace(String),
}

/// Validate raw ICC profile bytes.
///
/// Accepts profiles whose color space is `RGB` or `CMYK` and whose profile
/// class is `InputDevice`, `DisplayDevice`, or `OutputDevice`.
/// Returns a [`DetectedIcc`] describing the parsed profile, or an
/// [`IccValidationError`] explaining why it was rejected.
pub fn validate_icc_bytes(bytes: &[u8]) -> Result<DetectedIcc, IccValidationError> {
  if bytes.is_empty() {
    return Err(IccValidationError::Empty);
  }

  let profile = ColorProfile::new_from_slice(bytes).map_err(|e| IccValidationError::InvalidHeader(e.to_string()))?;

  // Accept only Display, Input, and Output profile classes.
  match profile.profile_class {
    ProfileClass::DisplayDevice | ProfileClass::InputDevice | ProfileClass::OutputDevice => {}
    other => {
      return Err(IccValidationError::InvalidHeader(format!(
        "profile class {:?} is not accepted (must be Display, Input, or Output)",
        other
      )));
    }
  }

  let claimed_type = match profile.color_space {
    DataColorSpace::Rgb => PdfIccProfileType::Srgb,
    DataColorSpace::Cmyk => PdfIccProfileType::Cmyk,
    other => {
      return Err(IccValidationError::UnsupportedColorSpace(format!("{:?}", other)));
    }
  };

  let description = extract_description(&profile);

  Ok(DetectedIcc {
    profile_class: profile.profile_class,
    color_space: profile.color_space,
    description,
    claimed_type,
  })
}

fn extract_description(profile: &ColorProfile) -> Option<String> {
  use moxcms::ProfileText;
  profile.description.as_ref().map(|text| match text {
    ProfileText::PlainString(s) => s.clone(),
    ProfileText::Localizable(lc) => lc.first().map(|l| l.value.clone()).unwrap_or_default(),
    ProfileText::Description(d) => d.ascii_string.clone(),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  /// inv_icc01: a valid in-memory sRGB profile serialised by moxcms passes validation.
  #[test]
  fn inv_icc01_upload_validates_header() {
    // Build an sRGB profile using moxcms defaults and serialise it.
    let profile = moxcms::ColorProfile::new_srgb();
    let icc_bytes = profile.encode().expect("moxcms must serialize sRGB profile");
    let result = validate_icc_bytes(&icc_bytes);
    assert!(result.is_ok(), "valid sRGB profile must pass validation: {:?}", result);
    let detected = result.unwrap();
    assert_eq!(detected.claimed_type, PdfIccProfileType::Srgb);
    assert_eq!(detected.color_space, DataColorSpace::Rgb);
  }

  /// inv_icc02: a corrupt byte slice is rejected with InvalidHeader.
  #[test]
  fn inv_icc02_corrupt_profile_rejected() {
    let result = validate_icc_bytes(b"NOT AN ICC FILE");
    assert!(
      matches!(result, Err(IccValidationError::InvalidHeader(_))),
      "corrupt bytes must produce InvalidHeader, got: {:?}",
      result
    );
  }
}
