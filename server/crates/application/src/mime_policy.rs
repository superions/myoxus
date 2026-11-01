//! MIME detection + policy enforcement for uploads and git-sync.
//!
//! Detection strategy (in order of confidence):
//! 1. Magic bytes via `infer` (primary — content-based)
//! 2. Extension fallback via `mime_guess` (secondary — name-based)
//! 3. Declared MIME from client (lowest confidence)
//! 4. Unknown falls back to `application/octet-stream`
//!
//! Policy enforcement: Blocklist > Allowlist. Modes: strict (deny) or warn (allow+log).

use std::fmt;
use std::path::Path;

/// Result of MIME type detection for a file.
#[derive(Debug, Clone)]
pub struct MimeDetectionResult {
  /// The MIME type declared by the client/caller (may be empty).
  pub declared_mime: String,
  /// The MIME type detected by content analysis.
  pub detected_mime: String,
  /// The effective MIME type used for policy evaluation (best available).
  pub effective_mime: String,
  /// Confidence level of the detection.
  pub confidence: MimeConfidence,
}

/// How confident we are in the detected MIME type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MimeConfidence {
  /// Detected via magic bytes (highest confidence).
  MagicBytes,
  /// Inferred from file extension.
  Extension,
  /// Fell back to the client-declared MIME type.
  Declared,
  /// Could not determine — defaulted to application/octet-stream.
  Unknown,
}

impl fmt::Display for MimeConfidence {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::MagicBytes => f.write_str("magic_bytes"),
      Self::Extension => f.write_str("extension"),
      Self::Declared => f.write_str("declared"),
      Self::Unknown => f.write_str("unknown"),
    }
  }
}

/// Policy decision after evaluating a MIME type against allow/block lists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MimePolicyDecision {
  /// The MIME type is allowed.
  Allow,
  /// The MIME type is denied (strict mode). Contains the reason.
  Deny { reason: String },
  /// The MIME type is questionable but allowed with a warning (warn mode). Contains the reason.
  Warn { reason: String },
}

/// Configuration for MIME policy enforcement.
#[derive(Debug, Clone)]
pub struct MimePolicyConfig {
  /// Allowed MIME types. Supports wildcards like "image/*".
  pub allowlist: Vec<String>,
  /// Blocked MIME types. Takes priority over allowlist.
  pub blocklist: Vec<String>,
  /// Enforcement mode.
  pub mode: MimeValidationMode,
}

/// MIME validation enforcement mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MimeValidationMode {
  /// Deny files that fail policy checks.
  Strict,
  /// Allow files that fail policy checks but emit a warning log.
  Warn,
}

impl MimeValidationMode {
  /// Parse from string. Returns `None` for invalid values.
  pub fn parse_mode(s: &str) -> Option<Self> {
    match s {
      "strict" => Some(Self::Strict),
      "warn" => Some(Self::Warn),
      _ => None,
    }
  }
}

impl fmt::Display for MimeValidationMode {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Strict => f.write_str("strict"),
      Self::Warn => f.write_str("warn"),
    }
  }
}

const FALLBACK_MIME: &str = "application/octet-stream";

/// Detect the MIME type of file content using multiple strategies.
///
/// Strategy priority:
/// 1. Magic bytes analysis via `infer` (examines file header)
/// 2. Extension-based guess via `mime_guess`
/// 3. Declared MIME from the caller
/// 4. Fallback to `application/octet-stream`
///
/// The `effective_mime` field contains the best available type for policy evaluation.
pub fn detect_mime(bytes: &[u8], file_name: &str, declared_mime: &str) -> MimeDetectionResult {
  // Strategy 1: magic bytes
  if let Some(kind) = infer::get(bytes) {
    let detected = kind.mime_type().to_string();
    tracing::trace!(
      file_name = file_name,
      detected_mime = %detected,
      declared_mime = declared_mime,
      confidence = "magic_bytes",
      "MIME detected via magic bytes"
    );
    return MimeDetectionResult {
      declared_mime: declared_mime.to_string(),
      detected_mime: detected.clone(),
      effective_mime: detected,
      confidence: MimeConfidence::MagicBytes,
    };
  }

  // Strategy 2: extension-based guess
  let extension_guess = mime_guess::from_path(Path::new(file_name)).first();
  if let Some(guessed) = extension_guess {
    let guessed_str = guessed.as_ref().to_string();
    tracing::trace!(
      file_name = file_name,
      detected_mime = %guessed_str,
      declared_mime = declared_mime,
      confidence = "extension",
      "MIME detected via file extension"
    );
    return MimeDetectionResult {
      declared_mime: declared_mime.to_string(),
      detected_mime: guessed_str.clone(),
      effective_mime: guessed_str,
      confidence: MimeConfidence::Extension,
    };
  }

  // Strategy 3: use declared MIME if non-empty and parseable
  let declared_trimmed = declared_mime.trim();
  if !declared_trimmed.is_empty() && declared_trimmed.parse::<mime::Mime>().is_ok() {
    tracing::trace!(
      file_name = file_name,
      declared_mime = declared_trimmed,
      confidence = "declared",
      "MIME using declared value (no magic bytes or extension match)"
    );
    return MimeDetectionResult {
      declared_mime: declared_trimmed.to_string(),
      detected_mime: String::new(),
      effective_mime: declared_trimmed.to_string(),
      confidence: MimeConfidence::Declared,
    };
  }

  // Strategy 4: unknown
  tracing::trace!(
    file_name = file_name,
    declared_mime = declared_mime,
    confidence = "unknown",
    fallback = FALLBACK_MIME,
    "MIME type unknown, falling back to application/octet-stream"
  );
  MimeDetectionResult {
    declared_mime: declared_mime.to_string(),
    detected_mime: String::new(),
    effective_mime: FALLBACK_MIME.to_string(),
    confidence: MimeConfidence::Unknown,
  }
}

/// Evaluate a detected MIME type against the policy configuration.
///
/// Evaluation order:
/// 1. If `effective_mime` matches any blocklist entry -> deny/warn (blocklist wins)
/// 2. If allowlist is empty -> allow (no restrictions)
/// 3. If `effective_mime` matches any allowlist entry -> allow
/// 4. Otherwise -> deny/warn depending on mode
pub fn evaluate_policy(detection: &MimeDetectionResult, config: &MimePolicyConfig) -> MimePolicyDecision {
  let effective = &detection.effective_mime;

  // Step 1: check blocklist (takes priority)
  if mime_matches_list(effective, &config.blocklist) {
    let reason = format!(
      "MIME type '{}' is blocklisted (confidence: {})",
      effective, detection.confidence
    );
    tracing::warn!(
      effective_mime = %effective,
      confidence = %detection.confidence,
      file_declared_mime = %detection.declared_mime,
      mode = %config.mode,
      "MIME policy: type is blocklisted"
    );
    return match config.mode {
      MimeValidationMode::Strict => MimePolicyDecision::Deny { reason },
      MimeValidationMode::Warn => MimePolicyDecision::Warn { reason },
    };
  }

  // Step 2: empty allowlist = no restrictions
  if config.allowlist.is_empty() {
    tracing::trace!(
      effective_mime = %effective,
      "MIME policy: allowlist empty, allowing all types"
    );
    return MimePolicyDecision::Allow;
  }

  // Step 3: check allowlist
  if mime_matches_list(effective, &config.allowlist) {
    tracing::trace!(
      effective_mime = %effective,
      confidence = %detection.confidence,
      "MIME policy: type is on allowlist"
    );
    return MimePolicyDecision::Allow;
  }

  // Step 4: not on allowlist
  let reason = format!(
    "MIME type '{}' is not on the allowlist (confidence: {})",
    effective, detection.confidence
  );
  tracing::warn!(
    effective_mime = %effective,
    confidence = %detection.confidence,
    file_declared_mime = %detection.declared_mime,
    mode = %config.mode,
    "MIME policy: type not on allowlist"
  );
  match config.mode {
    MimeValidationMode::Strict => MimePolicyDecision::Deny { reason },
    MimeValidationMode::Warn => MimePolicyDecision::Warn { reason },
  }
}

/// Check if a MIME type matches any pattern in the list.
/// Supports exact matches and wildcard patterns like "image/*".
fn mime_matches_list(mime_type: &str, patterns: &[String]) -> bool {
  for pattern in patterns {
    if mime_matches_pattern(mime_type, pattern) {
      return true;
    }
  }
  false
}

/// Check if a MIME type matches a single pattern.
/// Supports:
/// - Exact match: "image/png" matches "image/png"
/// - Wildcard subtype: "image/*" matches "image/png", "image/jpeg", etc.
/// - Full wildcard: "*/*" matches anything
fn mime_matches_pattern(mime_type: &str, pattern: &str) -> bool {
  // Exact match (case-insensitive)
  if mime_type.eq_ignore_ascii_case(pattern) {
    return true;
  }

  // Wildcard match: split both into type/subtype
  let Some((pattern_type, pattern_subtype)) = pattern.split_once('/') else {
    return false;
  };
  let Some((mime_type_part, _mime_subtype)) = mime_type.split_once('/') else {
    return false;
  };

  // "*/*" matches everything
  if pattern_type == "*" && pattern_subtype == "*" {
    return true;
  }

  // "type/*" matches any subtype of the given type
  if pattern_subtype == "*" && mime_type_part.eq_ignore_ascii_case(pattern_type) {
    return true;
  }

  false
}

#[cfg(test)]
mod tests {
  use super::*;

  // ── Detection tests ─────────────────────────────────────────────────

  #[test]
  fn detect_png_by_magic_bytes() {
    // Minimal PNG header: 8-byte signature
    let png_header = [
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    ];
    let result = detect_mime(&png_header, "test.png", "");
    assert_eq!(result.effective_mime, "image/png");
    assert_eq!(result.confidence, MimeConfidence::MagicBytes);
  }

  #[test]
  fn detect_by_extension_when_no_magic() {
    let result = detect_mime(b"not-magic-bytes", "document.md", "");
    assert_eq!(result.effective_mime, "text/markdown");
    assert_eq!(result.confidence, MimeConfidence::Extension);
  }

  #[test]
  fn detect_falls_back_to_declared() {
    let result = detect_mime(b"random data", "noext", "text/plain");
    assert_eq!(result.effective_mime, "text/plain");
    assert_eq!(result.confidence, MimeConfidence::Declared);
  }

  #[test]
  fn detect_unknown_when_nothing_matches() {
    let result = detect_mime(b"random data", "noext", "");
    assert_eq!(result.effective_mime, "application/octet-stream");
    assert_eq!(result.confidence, MimeConfidence::Unknown);
  }

  #[test]
  fn detect_ignores_invalid_declared_mime() {
    let result = detect_mime(b"random data", "noext", "not-a-valid-mime");
    assert_eq!(result.effective_mime, "application/octet-stream");
    assert_eq!(result.confidence, MimeConfidence::Unknown);
  }

  // ── Pattern matching tests ──────────────────────────────────────────

  #[test]
  fn exact_mime_match() {
    assert!(mime_matches_pattern("image/png", "image/png"));
    assert!(!mime_matches_pattern("image/png", "image/jpeg"));
  }

  #[test]
  fn wildcard_subtype_match() {
    assert!(mime_matches_pattern("image/png", "image/*"));
    assert!(mime_matches_pattern("image/jpeg", "image/*"));
    assert!(!mime_matches_pattern("text/plain", "image/*"));
  }

  #[test]
  fn full_wildcard_match() {
    assert!(mime_matches_pattern("image/png", "*/*"));
    assert!(mime_matches_pattern("application/json", "*/*"));
  }

  #[test]
  fn case_insensitive_match() {
    assert!(mime_matches_pattern("Image/PNG", "image/png"));
    assert!(mime_matches_pattern("image/png", "Image/*"));
  }

  // ── Policy tests ────────────────────────────────────────────────────

  fn make_detection(effective: &str) -> MimeDetectionResult {
    MimeDetectionResult {
      declared_mime: String::new(),
      detected_mime: effective.to_string(),
      effective_mime: effective.to_string(),
      confidence: MimeConfidence::MagicBytes,
    }
  }

  #[test]
  fn policy_allow_on_allowlist() {
    let config = MimePolicyConfig {
      allowlist: vec!["image/png".into(), "text/plain".into()],
      blocklist: vec![],
      mode: MimeValidationMode::Strict,
    };
    let detection = make_detection("image/png");
    assert_eq!(evaluate_policy(&detection, &config), MimePolicyDecision::Allow);
  }

  #[test]
  fn policy_deny_not_on_allowlist_strict() {
    let config = MimePolicyConfig {
      allowlist: vec!["image/png".into()],
      blocklist: vec![],
      mode: MimeValidationMode::Strict,
    };
    let detection = make_detection("application/exe");
    assert!(matches!(
      evaluate_policy(&detection, &config),
      MimePolicyDecision::Deny { .. }
    ));
  }

  #[test]
  fn policy_warn_not_on_allowlist_warn_mode() {
    let config = MimePolicyConfig {
      allowlist: vec!["image/png".into()],
      blocklist: vec![],
      mode: MimeValidationMode::Warn,
    };
    let detection = make_detection("application/exe");
    assert!(matches!(
      evaluate_policy(&detection, &config),
      MimePolicyDecision::Warn { .. }
    ));
  }

  #[test]
  fn policy_blocklist_overrides_allowlist() {
    let config = MimePolicyConfig {
      allowlist: vec!["image/*".into()],
      blocklist: vec!["image/svg+xml".into()],
      mode: MimeValidationMode::Strict,
    };
    let detection = make_detection("image/svg+xml");
    assert!(matches!(
      evaluate_policy(&detection, &config),
      MimePolicyDecision::Deny { .. }
    ));
  }

  #[test]
  fn policy_empty_allowlist_allows_all() {
    let config = MimePolicyConfig {
      allowlist: vec![],
      blocklist: vec![],
      mode: MimeValidationMode::Strict,
    };
    let detection = make_detection("anything/goes");
    assert_eq!(evaluate_policy(&detection, &config), MimePolicyDecision::Allow);
  }

  #[test]
  fn policy_wildcard_allowlist() {
    let config = MimePolicyConfig {
      allowlist: vec!["image/*".into(), "text/*".into()],
      blocklist: vec![],
      mode: MimeValidationMode::Strict,
    };
    assert_eq!(
      evaluate_policy(&make_detection("image/webp"), &config),
      MimePolicyDecision::Allow
    );
    assert_eq!(
      evaluate_policy(&make_detection("text/markdown"), &config),
      MimePolicyDecision::Allow
    );
    assert!(matches!(
      evaluate_policy(&make_detection("application/zip"), &config),
      MimePolicyDecision::Deny { .. }
    ));
  }

  #[test]
  fn validation_mode_from_str() {
    assert_eq!(
      MimeValidationMode::parse_mode("strict"),
      Some(MimeValidationMode::Strict)
    );
    assert_eq!(MimeValidationMode::parse_mode("warn"), Some(MimeValidationMode::Warn));
    assert_eq!(MimeValidationMode::parse_mode("invalid"), None);
  }
}
