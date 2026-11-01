//! Template bundle parsing, validation, and export.
//!
//! A template bundle is a ZIP archive containing:
//! - `manifest.json` — metadata (template_id, version, title, etc.)
//! - `content.template.zip` — the default native document payload
//! - declared locale payloads — fixed native alternatives with SHA-256 metadata
//! - `preview.svg` — optional preview image
//!
//! This module provides:
//! - [`parse_bundle`] — extract and validate bundle structure
//! - [`validate_manifest`] — check manifest field correctness
//! - [`create_export_bundle`] — assemble a ZIP bundle from stored data
//! - [`ParsedBundle`], [`Manifest`], [`ValidationError`] — data types

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::time::{Duration, Instant};
use tracing::{debug, warn};
use zip::ZipArchive;

use crate::auth::AuthError;
use myoxus_workspace_import::{
  ArchiveLimits, PortableArchiveKind, detect_portable_archive_kind, inspect_zip_bytes, is_ignored_archive_entry,
  validate_snapshot_archive,
};

const CANONICAL_CONTENT_ENTRY: &str = "content.template.zip";
const LEGACY_CONTENT_ENTRY: &str = "content.affine.zip";
const PREVIEW_ENTRY: &str = "preview.svg";
const MANIFEST_ENTRY: &str = "manifest.json";

const DEFAULT_MAX_ZIP_ENTRIES: usize = 256;
const DEFAULT_MAX_ZIP_SINGLE_FILE_SIZE: u64 = 50 * 1024 * 1024;
const DEFAULT_MAX_ZIP_TOTAL_UNCOMPRESSED_SIZE: u64 = 200 * 1024 * 1024;
const DEFAULT_MAX_ZIP_COMPRESSION_RATIO: f64 = 200.0;
const DEFAULT_MAX_ZIP_PATH_LENGTH: usize = 512;

// ─── Types ───────────────────────────────────────────────────────────────────

/// Severity level for bundle validation errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ValidationSeverity {
  /// Fatal — bundle cannot be imported.
  Error,
  /// Non-fatal — bundle can be imported but something is suboptimal.
  Warning,
}

/// A single validation finding from manifest or bundle structure checks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationError {
  /// Machine-readable error code (e.g. `"MISSING_FIELD"`, `"INVALID_VERSION"`).
  pub code: String,
  /// Human-readable description of the problem.
  pub message: String,
  /// The manifest field that caused the error, if applicable.
  pub field: Option<String>,
  /// JSON pointer path to the failing value, if applicable.
  pub path: Option<String>,
  /// Whether this is a fatal error or a warning.
  pub severity: ValidationSeverity,
}

/// Parsed manifest from `manifest.json` inside a template bundle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
  /// Stable template identifier (slug-like, e.g. `"weekly-standup"`).
  pub template_id: String,
  /// Semantic version string (e.g. `"1.0.0"`).
  pub version: String,
  /// Display title for the template.
  pub title: String,
  /// Optional description of the template.
  pub description: Option<String>,
  /// Organisational category (e.g. `"project-management"`).
  pub category: Option<String>,
  /// Free-form tags for filtering.
  #[serde(default)]
  pub tags: Vec<String>,
  /// Default payload language; older single-language bundles used this as a hint.
  pub locale: Option<String>,
  /// Template kind (e.g. `"page"`, `"edgeless"`).
  pub kind: Option<String>,
  /// Minimum server version required to use this template.
  pub min_server_version: Option<String>,
  /// SHA-256 checksum of `content.template.zip`.
  pub checksum: Option<String>,
  /// Native alternatives are captured with the bundle, never generated at runtime.
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub localized_contents: BTreeMap<String, LocalizedContent>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub title_policy: Option<TitlePolicy>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub purpose: Option<TemplatePurpose>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalizedContent {
  pub path: String,
  pub sha256: String,
  pub title: String,
  pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TitlePolicy {
  Template,
  TemplateDate,
  Date,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TemplatePurpose {
  Template,
  Guide,
}

/// Input format detected while parsing an uploaded template bundle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TemplateInputFormat {
  /// `manifest.json` + `content.template.zip`
  TemplateBundle,
  /// `manifest.json` + legacy `content.affine.zip`
  LegacyTemplateBundle,
  /// Raw workspace export ZIP
  RawWorkspaceZip,
  /// Raw upstream snapshot ZIP
  UpstreamSnapshotZip,
}

impl TemplateInputFormat {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::TemplateBundle => "myoxus_bundle",
      Self::LegacyTemplateBundle => "legacy_myoxus_bundle",
      Self::RawWorkspaceZip => "raw_workspace_zip",
      Self::UpstreamSnapshotZip => "upstream_snapshot_zip",
    }
  }
}

/// Backwards-compatible alias for the detected bundle format.
pub type BundleFormat = TemplateInputFormat;

/// Normalized bundle payload extracted after format detection.
#[derive(Debug, Clone)]
pub struct TemplateNormalizationResult {
  /// Parsed manifest metadata after normalization.
  pub manifest: Manifest,
  /// Raw bytes of `content.template.zip` or the raw workspace export payload.
  pub content_bytes: Vec<u8>,
  /// Locale-keyed payload bytes; every declared checksum is verified before use.
  pub localized_contents: BTreeMap<String, Vec<u8>>,
  /// Raw bytes of `preview.svg` (if present in the bundle).
  pub preview_bytes: Option<Vec<u8>>,
  /// Detected input format.
  pub format: TemplateInputFormat,
  /// Ignored archive entries such as macOS metadata noise.
  pub ignored_entries: Vec<String>,
  /// Timing breakdown for the normalization pipeline.
  pub timings: TemplateNormalizationTimings,
}

/// Timings captured while normalizing a bundle after detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TemplateNormalizationTimings {
  /// Time spent unpacking manifest, content, and preview bytes.
  pub unpack: Duration,
  /// Time spent normalizing the final parsed bundle.
  pub normalize: Duration,
}

/// A fully parsed template bundle ready for import.
#[derive(Debug)]
pub struct ParsedBundle {
  /// Parsed manifest metadata.
  pub manifest: Manifest,
  /// Raw bytes of `content.template.zip`.
  pub content_bytes: Vec<u8>,
  /// Locale-keyed payload bytes; every declared checksum is verified before use.
  pub localized_contents: BTreeMap<String, Vec<u8>>,
  /// Raw bytes of `preview.svg` (if present in the bundle).
  pub preview_bytes: Option<Vec<u8>>,
  /// Detected bundle format.
  pub format: TemplateInputFormat,
  /// Ignored archive entries such as macOS metadata noise.
  pub ignored_entries: Vec<String>,
  /// SHA-256 hex digest of the entire bundle.
  pub bundle_checksum: String,
  /// SHA-256 hex digest of `content.template.zip`.
  pub content_checksum: String,
  /// Timing breakdown for the parse pipeline.
  pub parse_timings: ParseTimings,
}

impl Manifest {
  /// Resolve once at provisioning; callers persist this key on the source.
  pub fn select_locale(&self, requested: &str) -> String {
    let normalize = |value: &str| value.trim().replace('_', "-").to_ascii_lowercase();
    let requested = normalize(requested);
    let base = requested.split('-').next().unwrap_or_default();
    for candidate in [&requested[..], base] {
      if let Some(locale) = self
        .localized_contents
        .keys()
        .find(|locale| normalize(locale) == candidate)
      {
        return locale.clone();
      }
      if self
        .locale
        .as_deref()
        .is_some_and(|locale| normalize(locale) == candidate)
      {
        return self.locale.clone().expect("matched default locale");
      }
    }
    self.locale.clone().unwrap_or(requested)
  }
}

impl ParsedBundle {
  /// Resolve once at provisioning; callers persist this key on the source.
  pub fn select_locale(&self, requested: &str) -> String {
    self.manifest.select_locale(requested)
  }

  pub fn content_for_locale(&self, locale: &str) -> &[u8] {
    self
      .localized_contents
      .get(locale)
      .map(Vec::as_slice)
      .unwrap_or(&self.content_bytes)
  }
}

/// Timings captured while parsing a bundle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseTimings {
  /// Time spent detecting and validating the archive format.
  pub detect: Duration,
  /// Time spent unpacking manifest, content, and preview bytes.
  pub unpack: Duration,
  /// Time spent normalizing the final parsed bundle.
  pub normalize: Duration,
}

/// Result of the format-detection stage before normalization.
#[derive(Debug, Clone)]
pub struct TemplateFormatDetectionResult {
  /// Detected input format.
  pub format: TemplateInputFormat,
  /// Bundle entry names collected during archive inspection.
  pub entry_names: Vec<String>,
  /// Ignored archive entries such as macOS metadata noise.
  pub ignored_entries: Vec<String>,
  /// SHA-256 hex digest of the entire bundle.
  pub bundle_checksum: String,
  /// Time spent detecting and validating the archive format.
  pub detect_duration: Duration,
}

/// Security limits used while validating uploaded template bundle ZIPs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TemplateBundleZipLimits {
  /// Maximum number of archive entries accepted.
  pub max_entries: usize,
  /// Maximum uncompressed size of a single entry.
  pub max_single_file_size: u64,
  /// Maximum combined uncompressed size of the entire archive.
  pub max_total_uncompressed_size: u64,
  /// Maximum allowed uncompressed-to-compressed ratio for a single entry.
  pub max_compression_ratio: f64,
  /// Maximum archive entry path length in bytes.
  pub max_path_length: usize,
}

impl Default for TemplateBundleZipLimits {
  fn default() -> Self {
    Self {
      max_entries: DEFAULT_MAX_ZIP_ENTRIES,
      max_single_file_size: DEFAULT_MAX_ZIP_SINGLE_FILE_SIZE,
      max_total_uncompressed_size: DEFAULT_MAX_ZIP_TOTAL_UNCOMPRESSED_SIZE,
      max_compression_ratio: DEFAULT_MAX_ZIP_COMPRESSION_RATIO,
      max_path_length: DEFAULT_MAX_ZIP_PATH_LENGTH,
    }
  }
}

impl From<TemplateBundleZipLimits> for ArchiveLimits {
  fn from(value: TemplateBundleZipLimits) -> Self {
    Self {
      max_entries: value.max_entries,
      max_entry_bytes: value.max_single_file_size,
      max_expanded_bytes: value.max_total_uncompressed_size,
      max_compression_ratio: value.max_compression_ratio.floor() as u64,
      max_path_bytes: value.max_path_length,
    }
  }
}

/// A wrapper and its native document/payload ZIPs share one cumulative budget.
/// Counting each ZIP independently would admit an unbounded collection of valid
/// children. Call once for each actual archive layer, never for ordinary files.
pub struct NestedArchiveBudget {
  limits: TemplateBundleZipLimits,
  expanded: u64,
  max_expanded_bytes: u64,
  entries: usize,
}
impl NestedArchiveBudget {
  pub fn new(limits: TemplateBundleZipLimits) -> Self {
    Self::with_aggregate_limit(limits, limits.max_total_uncompressed_size)
  }

  /// A source set may contain multiple pinned versions. Its cumulative bound
  /// is separate from the unchanged limits inspected for each individual ZIP.
  pub fn with_aggregate_limit(limits: TemplateBundleZipLimits, max_expanded_bytes: u64) -> Self {
    Self {
      limits,
      expanded: 0,
      max_expanded_bytes,
      entries: 0,
    }
  }

  pub fn account(&mut self, bytes: &[u8]) -> Result<myoxus_workspace_import::ArchiveIndex, AuthError> {
    let index =
      inspect_zip_bytes(bytes, self.limits.into()).map_err(|error| AuthError::InvalidInput(error.to_string()))?;
    self.expanded = self
      .expanded
      .checked_add(index.expanded_bytes)
      .ok_or_else(|| AuthError::InvalidInput("expanded size overflow".into()))?;
    self.entries = self
      .entries
      .checked_add(index.entries.len())
      .ok_or_else(|| AuthError::InvalidInput("entry count overflow".into()))?;
    if self.expanded > self.max_expanded_bytes || self.entries > self.limits.max_entries {
      return Err(AuthError::InvalidInput(
        "aggregate nested archive limit exceeded".into(),
      ));
    }
    Ok(index)
  }
}

// ─── Bundle Parsing ──────────────────────────────────────────────────────────

/// Sanitize a filename into a valid slug (lowercase alphanumeric + hyphens).
fn sanitize_slug(name: &str) -> String {
  let stem = name
    .trim_end_matches(".zip")
    .trim_end_matches(".template")
    .trim_end_matches(".affine");
  let slug: String = stem
    .chars()
    .map(|c| {
      if c.is_ascii_alphanumeric() {
        c.to_ascii_lowercase()
      } else {
        '-'
      }
    })
    .collect();
  // Collapse consecutive hyphens, trim leading/trailing hyphens
  let mut result = String::with_capacity(slug.len());
  let mut prev_hyphen = true; // treat start as hyphen to skip leading
  for ch in slug.chars() {
    if ch == '-' {
      if !prev_hyphen {
        result.push('-');
      }
      prev_hyphen = true;
    } else {
      result.push(ch);
      prev_hyphen = false;
    }
  }
  // Trim trailing hyphen
  while result.ends_with('-') {
    result.pop();
  }
  if result.is_empty() {
    "imported-template".to_string()
  } else {
    result
  }
}

/// Parse a template bundle from raw ZIP bytes.
///
/// Supports four bundle formats:
/// 1. ZIP with `manifest.json` + `content.template.zip` (canonical format)
/// 2. ZIP with `manifest.json` + legacy `content.affine.zip`
/// 3. ZIP with `content.template.zip` only (auto-generates manifest)
/// 4. ZIP that IS a raw workspace/snapshot export
///
/// Optionally extracts `preview.svg`.
/// Returns an error if the ZIP is malformed or no usable content is found.
pub fn parse_bundle(data: &[u8]) -> Result<ParsedBundle, AuthError> {
  parse_bundle_with_filename_and_limits(data, "import", TemplateBundleZipLimits::default())
}

/// Parse a template bundle, using the provided filename hint for auto-manifest generation.
pub fn parse_bundle_with_filename(data: &[u8], filename: &str) -> Result<ParsedBundle, AuthError> {
  parse_bundle_with_filename_and_limits(data, filename, TemplateBundleZipLimits::default())
}

/// Parse a template bundle with explicit ZIP security limits.
pub fn parse_bundle_with_limits(data: &[u8], limits: TemplateBundleZipLimits) -> Result<ParsedBundle, AuthError> {
  parse_bundle_with_filename_and_limits(data, "import", limits)
}

/// Parse a template bundle, using the provided filename hint and ZIP security limits.
pub fn parse_bundle_with_filename_and_limits(
  data: &[u8],
  filename: &str,
  limits: TemplateBundleZipLimits,
) -> Result<ParsedBundle, AuthError> {
  let detected = detect_template_format_with_limits(data, limits)?;
  let TemplateFormatDetectionResult {
    format,
    entry_names,
    ignored_entries,
    bundle_checksum,
    detect_duration,
  } = detected;

  let normalized = normalize_template_input(data, filename, &entry_names, format, ignored_entries)?;

  // Compute content checksum
  let mut content_hasher = Sha256::new();
  content_hasher.update(&normalized.content_bytes);
  let content_checksum = format!("{:x}", content_hasher.finalize());

  debug!(
    format = format.as_str(),
    template_id = %normalized.manifest.template_id,
    version = %normalized.manifest.version,
    content_size = normalized.content_bytes.len(),
    has_preview = normalized.preview_bytes.is_some(),
    ignored_entry_count = normalized.ignored_entries.len(),
    "template bundle parsed successfully"
  );

  Ok(ParsedBundle {
    manifest: normalized.manifest,
    content_bytes: normalized.content_bytes,
    localized_contents: normalized.localized_contents,
    preview_bytes: normalized.preview_bytes,
    format: normalized.format,
    ignored_entries: normalized.ignored_entries,
    bundle_checksum,
    content_checksum,
    parse_timings: ParseTimings {
      detect: detect_duration,
      unpack: normalized.timings.unpack,
      normalize: normalized.timings.normalize,
    },
  })
}

/// Detect the input format of an uploaded template bundle with ZIP limits.
pub fn detect_template_format_with_limits(
  data: &[u8],
  limits: TemplateBundleZipLimits,
) -> Result<TemplateFormatDetectionResult, AuthError> {
  if looks_like_template_json(data) {
    warn!(
      error_code = "UNSUPPORTED_TEMPLATE_JSON",
      "rejecting unsupported upstream template JSON input"
    );
    return Err(template_input_error(
      "UNSUPPORTED_TEMPLATE_JSON",
      "upstream template JSON input is not supported; upload the ZIP bundle instead",
    ));
  }

  let detect_started = Instant::now();
  let archive_limits = ArchiveLimits::from(limits);
  let archive_index =
    inspect_zip_bytes(data, archive_limits).map_err(|error| AuthError::InvalidInput(error.to_string()))?;
  let entry_names = archive_index.entry_names();
  let ignored_entries = archive_index.ignored_entry_names();
  if !ignored_entries.is_empty() {
    debug!(
      ignored_entry_count = ignored_entries.len(),
      ignored_entries = ?ignored_entries,
      "ignoring noisy template bundle entries"
    );
  }

  let format = detect_template_input_format(&entry_names)?;
  if format == TemplateInputFormat::UpstreamSnapshotZip {
    validate_snapshot_archive(data, archive_limits).map_err(|error| AuthError::InvalidInput(error.to_string()))?;
  }
  let detect_duration = detect_started.elapsed();

  // Compute bundle-level checksum.
  let mut bundle_hasher = Sha256::new();
  bundle_hasher.update(data);
  let bundle_checksum = format!("{:x}", bundle_hasher.finalize());

  Ok(TemplateFormatDetectionResult {
    format,
    entry_names,
    ignored_entries,
    bundle_checksum,
    detect_duration,
  })
}

fn open_zip_archive(data: &[u8]) -> Result<ZipArchive<Cursor<&[u8]>>, AuthError> {
  let cursor = Cursor::new(data);
  ZipArchive::new(cursor).map_err(|e| {
    warn!(error = %e, "template bundle is not a valid ZIP archive");
    AuthError::InvalidInput(format!("invalid ZIP archive: {e}"))
  })
}

fn template_input_error(code: &str, message: impl Into<String>) -> AuthError {
  AuthError::InvalidInput(format!("{code}: {}", message.into()))
}

fn looks_like_template_json(data: &[u8]) -> bool {
  let text = match std::str::from_utf8(data) {
    Ok(text) => text,
    Err(_) => return false,
  };

  let trimmed = text.trim_start_matches('\u{feff}').trim_start();
  if !matches!(trimmed.as_bytes().first(), Some(b'{')) {
    return false;
  }

  let value: serde_json::Value = match serde_json::from_str(trimmed) {
    Ok(value) => value,
    Err(_) => return false,
  };

  let Some(object) = value.as_object() else {
    return false;
  };

  object.contains_key("name") && object.contains_key("type") && object.contains_key("content")
}

/// Extract an optional file from the ZIP archive.  Returns `None` if not found.
fn extract_file_optional(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Option<Vec<u8>> {
  let mut file = archive.by_name(name).ok()?;
  let mut buf = Vec::with_capacity(file.size() as usize);
  file.read_to_end(&mut buf).ok()?;
  Some(buf)
}

pub fn detect_template_input_format(entry_names: &[String]) -> Result<TemplateInputFormat, AuthError> {
  let canonical_content_present = entry_names.iter().any(|entry| entry == CANONICAL_CONTENT_ENTRY);
  let legacy_content_present = entry_names.iter().any(|entry| entry == LEGACY_CONTENT_ENTRY);
  let has_snapshot_entries = entry_names.iter().any(|entry| {
    if is_ignored_archive_entry(entry) {
      return false;
    }

    let lower = entry.to_ascii_lowercase();
    myoxus_workspace_import::is_snapshot_json_path(&lower)
  });

  if canonical_content_present {
    return Ok(TemplateInputFormat::TemplateBundle);
  }

  if legacy_content_present {
    warn!(entry = LEGACY_CONTENT_ENTRY, "accepting legacy template content entry");
    return Ok(TemplateInputFormat::LegacyTemplateBundle);
  }

  if detect_portable_archive_kind(entry_names) == PortableArchiveKind::SnapshotIncomplete && !has_snapshot_entries {
    return Err(template_input_error(
      "SNAPSHOT_ENTRY_MISSING",
      "snapshot-like ZIP is missing required '*.snapshot.json' entries",
    ));
  }

  let raw_format = match detect_portable_archive_kind(entry_names) {
    PortableArchiveKind::Snapshot => Some(TemplateInputFormat::UpstreamSnapshotZip),
    PortableArchiveKind::RawWorkspace => Some(TemplateInputFormat::RawWorkspaceZip),
    PortableArchiveKind::SnapshotIncomplete | PortableArchiveKind::Unknown => None,
  };
  if let Some(raw_format) = raw_format {
    debug!(
      format = raw_format.as_str(),
      "ZIP appears to be a raw workspace export, treating it as content"
    );
    return Ok(raw_format);
  }

  Err(AuthError::InvalidInput(
    "This ZIP doesn't contain a template manifest or AFFiNE content. \
                     Expected either manifest.json + content.template.zip, manifest.json + legacy content.affine.zip, or a raw workspace export ZIP."
      .to_string(),
  ))
}

/// Normalize a detected input format into the canonical import payload.
pub fn normalize_template_input(
  data: &[u8],
  filename: &str,
  entry_names: &[String],
  format: TemplateInputFormat,
  ignored_entries: Vec<String>,
) -> Result<TemplateNormalizationResult, AuthError> {
  let mut archive = open_zip_archive(data)?;
  normalize_template_input_from_archive(data, filename, &mut archive, entry_names, format, ignored_entries)
}

fn normalize_template_input_from_archive(
  data: &[u8],
  filename: &str,
  archive: &mut ZipArchive<Cursor<&[u8]>>,
  entry_names: &[String],
  format: TemplateInputFormat,
  ignored_entries: Vec<String>,
) -> Result<TemplateNormalizationResult, AuthError> {
  let unpack_started = Instant::now();
  let manifest_present = entry_names.iter().any(|entry| entry == MANIFEST_ENTRY);
  let canonical_content_present = entry_names.iter().any(|entry| entry == CANONICAL_CONTENT_ENTRY);
  let legacy_content_present = entry_names.iter().any(|entry| entry == LEGACY_CONTENT_ENTRY);

  let manifest_parsed = if manifest_present {
    let manifest_bytes = extract_file_optional(archive, MANIFEST_ENTRY)
      .ok_or_else(|| AuthError::InvalidInput("failed to extract manifest.json from ZIP archive".to_string()))?;
    Some(serde_json::from_slice(&manifest_bytes).map_err(|error| {
      warn!(%error, "failed to parse supplied manifest.json");
      template_input_error("MANIFEST_INVALID", "supplied manifest.json is malformed")
    })?)
  } else {
    None
  };

  let content_bytes = if canonical_content_present {
    extract_file_optional(archive, CANONICAL_CONTENT_ENTRY)
      .ok_or_else(|| AuthError::InvalidInput(format!("failed to extract {CANONICAL_CONTENT_ENTRY} from ZIP archive")))?
  } else if legacy_content_present {
    extract_file_optional(archive, LEGACY_CONTENT_ENTRY)
      .ok_or_else(|| AuthError::InvalidInput(format!("failed to extract {LEGACY_CONTENT_ENTRY} from ZIP archive")))?
  } else {
    data.to_vec()
  };

  let preview_bytes = extract_file_optional(archive, PREVIEW_ENTRY);
  let unpack_duration = unpack_started.elapsed();

  let normalize_started = Instant::now();
  let manifest: Manifest = manifest_parsed.unwrap_or_else(|| {
    let title = filename.trim_end_matches(".zip").to_string();
    debug!(filename = %filename, "auto-generating manifest for bundle without manifest.json");
    Manifest {
      template_id: sanitize_slug(filename),
      version: "1.0.0".to_string(),
      title,
      description: Some("Auto-imported template".to_string()),
      category: None,
      tags: vec![],
      locale: None,
      kind: Some("page".to_string()),
      min_server_version: None,
      checksum: None,
      localized_contents: BTreeMap::new(),
      title_policy: None,
      purpose: None,
    }
  });
  let mut localized_contents = BTreeMap::new();
  let mut declared_paths = std::collections::HashSet::new();
  let mut declared_locales = std::collections::HashSet::new();
  for (locale, variant) in &manifest.localized_contents {
    if !declared_locales.insert(locale.replace('_', "-").to_ascii_lowercase())
      || locale.trim().is_empty()
      || !locale
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
      return Err(template_input_error(
        "LOCALE_INVALID",
        "invalid localized content locale",
      ));
    }
    let path = std::path::Path::new(&variant.path);
    if path.is_absolute()
      || variant.path.contains('\\')
      || path
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
      || [
        MANIFEST_ENTRY,
        CANONICAL_CONTENT_ENTRY,
        LEGACY_CONTENT_ENTRY,
        PREVIEW_ENTRY,
      ]
      .contains(&variant.path.as_str())
      || !declared_paths.insert(variant.path.clone())
      || variant.title.trim().is_empty()
    {
      return Err(template_input_error(
        "LOCALIZED_CONTENT_INVALID",
        "invalid or duplicate localized content path/title",
      ));
    }
    let bytes = extract_file_optional(archive, &variant.path)
      .ok_or_else(|| template_input_error("LOCALIZED_CONTENT_MISSING", "declared localized payload is missing"))?;
    if format!("{:x}", Sha256::digest(&bytes)) != variant.sha256 {
      return Err(template_input_error(
        "CHECKSUM_MISMATCH",
        "localized payload checksum does not match manifest",
      ));
    }
    if manifest.locale.as_deref().is_some_and(|default| {
      default
        .replace('_', "-")
        .eq_ignore_ascii_case(&locale.replace('_', "-"))
    }) && bytes != content_bytes
    {
      return Err(template_input_error(
        "DEFAULT_LOCALE_CONFLICT",
        "default language has conflicting payloads",
      ));
    }
    localized_contents.insert(locale.clone(), bytes);
  }
  // The shared archive index canonicalizes directory names without a trailing
  // slash. Keep their type here: a folder is not an undeclared payload file.
  let archive_names = archive
    .file_names()
    .collect::<Result<Vec<_>, _>>()
    .map_err(|_| template_input_error("ZIP_ENTRY_INVALID", "ZIP entry name cannot be decoded"))?;
  let directories: std::collections::HashSet<String> = archive_names
    .iter()
    .filter(|name| name.ends_with('/'))
    .map(|name| {
      std::path::Path::new(name.as_ref())
        .components()
        .filter_map(|part| {
          if let std::path::Component::Normal(segment) = part {
            Some(segment.to_string_lossy().into_owned())
          } else {
            None
          }
        })
        .collect::<Vec<_>>()
        .join("/")
    })
    .collect();
  if entry_names.iter().any(|name| {
    !directories.contains(name)
      && !is_ignored_archive_entry(name)
      && ![
        MANIFEST_ENTRY,
        CANONICAL_CONTENT_ENTRY,
        LEGACY_CONTENT_ENTRY,
        PREVIEW_ENTRY,
      ]
      .contains(&name.as_str())
      && !declared_paths.contains(name)
      && (!localized_contents.is_empty() || name.starts_with("localized/") || name.ends_with(".template.zip"))
  }) {
    return Err(template_input_error(
      "UNDECLARED_CONTENT",
      "bundle contains undeclared payloads",
    ));
  }
  let normalize_duration = normalize_started.elapsed();

  Ok(TemplateNormalizationResult {
    manifest,
    content_bytes,
    localized_contents,
    preview_bytes,
    format,
    ignored_entries,
    timings: TemplateNormalizationTimings {
      unpack: unpack_duration,
      normalize: normalize_duration,
    },
  })
}

// ─── Manifest Validation ────────────────────────────────────────────────────

/// Validate a parsed manifest, returning a list of validation findings.
///
/// An empty return value means the manifest is valid.  Fatal errors have
/// severity [`ValidationSeverity::Error`]; non-fatal issues are warnings.
pub fn validate_manifest(manifest: &Manifest) -> Vec<ValidationError> {
  let mut errors = Vec::new();
  let manifest_path = |field: &str| format!("/manifest/{field}");

  // template_id: required, must be a valid slug (lowercase alphanumeric + hyphens)
  if manifest.template_id.is_empty() {
    errors.push(ValidationError {
      code: "MISSING_FIELD".to_string(),
      message: "template_id is required".to_string(),
      field: Some("template_id".to_string()),
      path: Some(manifest_path("template_id")),
      severity: ValidationSeverity::Error,
    });
  } else if !is_valid_slug(&manifest.template_id) {
    errors.push(ValidationError {
      code: "INVALID_SLUG".to_string(),
      message: "template_id must contain only lowercase alphanumeric characters and hyphens, and must not start or end with a hyphen".to_string(),
      field: Some("template_id".to_string()),
      path: Some(manifest_path("template_id")),
      severity: ValidationSeverity::Error,
    });
  }

  // version: required, must be valid semver
  if manifest.version.is_empty() {
    errors.push(ValidationError {
      code: "MISSING_FIELD".to_string(),
      message: "version is required".to_string(),
      field: Some("version".to_string()),
      path: Some(manifest_path("version")),
      severity: ValidationSeverity::Error,
    });
  } else if semver::Version::parse(&manifest.version).is_err() {
    errors.push(ValidationError {
      code: "INVALID_VERSION".to_string(),
      message: format!(
        "version '{}' is not valid semver (expected format: MAJOR.MINOR.PATCH)",
        manifest.version
      ),
      field: Some("version".to_string()),
      path: Some(manifest_path("version")),
      severity: ValidationSeverity::Error,
    });
  }

  // title: required
  if manifest.title.is_empty() {
    errors.push(ValidationError {
      code: "MISSING_FIELD".to_string(),
      message: "title is required".to_string(),
      field: Some("title".to_string()),
      path: Some(manifest_path("title")),
      severity: ValidationSeverity::Error,
    });
  }

  // category: warn if missing (not fatal)
  if manifest.category.is_none() {
    errors.push(ValidationError {
      code: "MISSING_OPTIONAL_FIELD".to_string(),
      message: "category is not set; template will be uncategorized".to_string(),
      field: Some("category".to_string()),
      path: Some(manifest_path("category")),
      severity: ValidationSeverity::Warning,
    });
  }

  // tags: warn if empty
  if manifest.tags.is_empty() {
    errors.push(ValidationError {
      code: "EMPTY_TAGS".to_string(),
      message: "no tags specified; template may be harder to find".to_string(),
      field: Some("tags".to_string()),
      path: Some(manifest_path("tags")),
      severity: ValidationSeverity::Warning,
    });
  }

  if let Some(kind) = manifest.kind.as_deref()
    && !matches!(kind, "page" | "edgeless")
  {
    errors.push(ValidationError {
      code: "UNSUPPORTED_DOCUMENT_KIND".to_string(),
      message: format!("template kind '{kind}' is not supported"),
      field: Some("kind".to_string()),
      path: Some(manifest_path("kind")),
      severity: ValidationSeverity::Error,
    });
  }

  if let Some(minimum) = manifest.min_server_version.as_deref() {
    match (
      semver::Version::parse(minimum),
      semver::Version::parse(env!("CARGO_PKG_VERSION")),
    ) {
      (Ok(minimum), Ok(current)) if minimum > current => errors.push(ValidationError {
        code: "UNSUPPORTED_SERVER_VERSION".to_string(),
        message: format!("template requires server version {minimum} or newer; current version is {current}"),
        field: Some("min_server_version".to_string()),
        path: Some(manifest_path("min_server_version")),
        severity: ValidationSeverity::Error,
      }),
      (Err(_), _) => errors.push(ValidationError {
        code: "INVALID_SERVER_VERSION".to_string(),
        message: format!("min_server_version '{minimum}' is not valid semver"),
        field: Some("min_server_version".to_string()),
        path: Some(manifest_path("min_server_version")),
        severity: ValidationSeverity::Error,
      }),
      _ => {}
    }
  }

  errors
}

/// Validate the content checksum against the manifest's declared checksum.
///
/// Returns `Ok(())` if the manifest has no checksum field (validation skipped)
/// or the checksums match.
pub fn validate_content_checksum(manifest: &Manifest, computed_checksum: &str) -> Result<(), ValidationError> {
  if let Some(ref declared) = manifest.checksum
    && declared != computed_checksum
  {
    return Err(ValidationError {
      code: "CHECKSUM_MISMATCH".to_string(),
      message: format!(
        "content checksum mismatch: manifest declares '{}', computed '{}'",
        declared, computed_checksum
      ),
      field: Some("checksum".to_string()),
      path: Some("/manifest/checksum".to_string()),
      severity: ValidationSeverity::Error,
    });
  }
  Ok(())
}

/// Check whether a string is a valid slug (lowercase alphanumeric + hyphens,
/// no leading/trailing hyphen, no consecutive hyphens).
fn is_valid_slug(s: &str) -> bool {
  if s.is_empty() || s.starts_with('-') || s.ends_with('-') || s.contains("--") {
    return false;
  }
  s.chars()
    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

// ─── Bundle Export ──────────────────────────────────────────────────────────

/// Create a ZIP bundle from stored revision data.
///
/// This is the inverse of [`parse_bundle`]: given a manifest, content bytes,
/// optional preview bytes and all captured locale payloads, it produces a ZIP
/// without authoring document content or changing declared checksums.
pub fn create_export_bundle(
  manifest: &Manifest,
  content_bytes: &[u8],
  preview_bytes: Option<&[u8]>,
  localized_contents: &BTreeMap<String, Vec<u8>>,
) -> Result<Vec<u8>, AuthError> {
  let mut buf = Vec::new();
  {
    let cursor = Cursor::new(&mut buf);
    let mut writer = zip::ZipWriter::new(cursor);
    let options = zip::write::FileOptions::<()>::default().compression_method(zip::CompressionMethod::Deflated);

    // Write manifest.json
    let manifest_json = serde_json::to_vec_pretty(manifest)
      .map_err(|e| AuthError::InvalidInput(format!("failed to serialize manifest: {e}")))?;
    writer
      .start_file("manifest.json", options)
      .map_err(|e| AuthError::InvalidInput(format!("failed to write manifest.json: {e}")))?;
    std::io::Write::write_all(&mut writer, &manifest_json)
      .map_err(|e| AuthError::InvalidInput(format!("failed to write manifest.json: {e}")))?;

    // Write content.template.zip
    writer
      .start_file(CANONICAL_CONTENT_ENTRY, options)
      .map_err(|e| AuthError::InvalidInput(format!("failed to write {CANONICAL_CONTENT_ENTRY}: {e}")))?;
    std::io::Write::write_all(&mut writer, content_bytes)
      .map_err(|e| AuthError::InvalidInput(format!("failed to write {CANONICAL_CONTENT_ENTRY}: {e}")))?;

    if localized_contents.len() != manifest.localized_contents.len() {
      return Err(template_input_error(
        "LOCALIZED_CONTENT_MISSING",
        "export requires every declared locale payload",
      ));
    }
    for (locale, variant) in &manifest.localized_contents {
      let bytes = localized_contents.get(locale).ok_or_else(|| {
        template_input_error(
          "LOCALIZED_CONTENT_MISSING",
          "export requires every declared locale payload",
        )
      })?;
      if format!("{:x}", Sha256::digest(bytes)) != variant.sha256 {
        return Err(template_input_error(
          "CHECKSUM_MISMATCH",
          "export locale checksum does not match manifest",
        ));
      }
      writer
        .start_file(variant.path.as_str(), options)
        .map_err(|_| template_input_error("BUNDLE_WRITE_FAILED", "cannot write localized payload"))?;
      std::io::Write::write_all(&mut writer, bytes)
        .map_err(|_| template_input_error("BUNDLE_WRITE_FAILED", "cannot write localized payload"))?;
    }

    // Write preview.svg (if present)
    if let Some(preview) = preview_bytes {
      writer
        .start_file(PREVIEW_ENTRY, options)
        .map_err(|e| AuthError::InvalidInput(format!("failed to write preview.svg: {e}")))?;
      std::io::Write::write_all(&mut writer, preview)
        .map_err(|e| AuthError::InvalidInput(format!("failed to write preview.svg: {e}")))?;
    }

    writer
      .finish()
      .map_err(|e| AuthError::InvalidInput(format!("failed to finalize export bundle: {e}")))?;
  }

  debug!(
      template_id = %manifest.template_id,
      version = %manifest.version,
      bundle_size = buf.len(),
      "export bundle created"
  );

  Ok(buf)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use sha2::{Digest, Sha256};

  const VALID_SNAPSHOT_JSON: &[u8] = br#"{"meta":{"id":"page:home"},"blocks":[]}"#;

  fn make_valid_manifest() -> Manifest {
    Manifest {
      template_id: "weekly-standup".to_string(),
      version: "1.0.0".to_string(),
      title: "Weekly Standup".to_string(),
      description: Some("A template for weekly standups".to_string()),
      category: Some("meeting-notes".to_string()),
      tags: vec!["meetings".to_string(), "agile".to_string()],
      locale: Some("en".to_string()),
      kind: Some("page".to_string()),
      min_server_version: None,
      checksum: None,
      localized_contents: BTreeMap::new(),
      title_policy: None,
      purpose: None,
    }
  }

  fn create_test_bundle(manifest: &Manifest, content: &[u8], preview: Option<&[u8]>) -> Vec<u8> {
    let mut buf = Vec::new();
    {
      let cursor = Cursor::new(&mut buf);
      let mut writer = zip::ZipWriter::new(cursor);
      let options = zip::write::FileOptions::<()>::default();

      let manifest_json = serde_json::to_vec(manifest).unwrap();
      writer.start_file("manifest.json", options).unwrap();
      std::io::Write::write_all(&mut writer, &manifest_json).unwrap();

      writer.start_file(CANONICAL_CONTENT_ENTRY, options).unwrap();
      std::io::Write::write_all(&mut writer, content).unwrap();

      if let Some(preview) = preview {
        writer.start_file("preview.svg", options).unwrap();
        std::io::Write::write_all(&mut writer, preview).unwrap();
      }

      writer.finish().unwrap();
    }
    buf
  }

  fn create_zip_with_entries(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
      let cursor = Cursor::new(&mut buf);
      let mut writer = zip::ZipWriter::new(cursor);
      let options = zip::write::FileOptions::<()>::default();
      for (name, content) in entries {
        writer.start_file(*name, options).unwrap();
        std::io::Write::write_all(&mut writer, content).unwrap();
      }
      writer.finish().unwrap();
    }
    buf
  }

  fn create_zip_with_entries_and_options(entries: &[(&str, &[u8])], options: zip::write::SimpleFileOptions) -> Vec<u8> {
    let mut buf = Vec::new();
    {
      let cursor = Cursor::new(&mut buf);
      let mut writer = zip::ZipWriter::new(cursor);
      for (name, content) in entries {
        writer.start_file(*name, options).unwrap();
        std::io::Write::write_all(&mut writer, content).unwrap();
      }
      writer.finish().unwrap();
    }
    buf
  }

  fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
  }

  fn zip_entry_names(bytes: &[u8]) -> Vec<String> {
    let reader = Cursor::new(bytes);
    let mut archive = ZipArchive::new(reader).unwrap();
    (0..archive.len())
      .map(|index| archive.by_index(index).unwrap().name().unwrap().into_owned())
      .collect()
  }

  fn zip_entry_payloads(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let reader = Cursor::new(bytes);
    let mut archive = ZipArchive::new(reader).unwrap();
    let mut entries = Vec::with_capacity(archive.len());

    for index in 0..archive.len() {
      let mut file = archive.by_index(index).unwrap();
      let name = file.name().unwrap().into_owned();
      let mut content = Vec::new();
      std::io::Read::read_to_end(&mut file, &mut content).unwrap();
      entries.push((name, content));
    }

    entries
  }

  #[test]
  fn parse_bundle_valid() {
    let manifest = make_valid_manifest();
    let content = b"fake-content-zip-data";
    let preview = b"<svg></svg>";
    let bundle = create_test_bundle(&manifest, content, Some(preview));

    let parsed = parse_bundle(&bundle).unwrap();
    assert_eq!(parsed.manifest.template_id, "weekly-standup");
    assert_eq!(parsed.manifest.version, "1.0.0");
    assert_eq!(parsed.content_bytes, content);
    assert_eq!(parsed.preview_bytes.as_deref(), Some(preview.as_slice()));
    assert_eq!(parsed.format, BundleFormat::TemplateBundle);
    assert!(!parsed.bundle_checksum.is_empty());
    assert!(!parsed.content_checksum.is_empty());
    let total = parsed.parse_timings.detect + parsed.parse_timings.unpack + parsed.parse_timings.normalize;
    assert!(total < Duration::from_secs(5), "unexpected parse duration: {total:?}");
  }

  #[test]
  fn parse_bundle_without_preview() {
    let manifest = make_valid_manifest();
    let content = b"fake-content";
    let bundle = create_test_bundle(&manifest, content, None);

    let parsed = parse_bundle(&bundle).unwrap();
    assert!(parsed.preview_bytes.is_none());
  }

  #[test]
  fn supplied_malformed_manifest_never_uses_generated_fallback() {
    let bundle = create_zip_with_entries(&[
      (MANIFEST_ENTRY, br#"{"template_id":"broken""#),
      (CANONICAL_CONTENT_ENTRY, b"content"),
    ]);
    let error = parse_bundle_with_filename(&bundle, "fallback-name.zip").expect_err("malformed manifest must fail");
    assert!(error.to_string().contains("MANIFEST_INVALID"));
  }

  #[test]
  fn manifest_rejects_unsupported_server_and_document_kind() {
    let mut manifest = make_valid_manifest();
    manifest.min_server_version = Some("9999.0.0".to_string());
    manifest.kind = Some("database".to_string());
    let errors = validate_manifest(&manifest);
    assert!(errors.iter().any(|error| error.code == "UNSUPPORTED_SERVER_VERSION"));
    assert!(errors.iter().any(|error| error.code == "UNSUPPORTED_DOCUMENT_KIND"));
  }

  #[test]
  fn parse_bundle_rejects_malformed_inputs_without_panicking() {
    let zip_slip = create_zip_with_entries(&[
      (
        "manifest.json",
        serde_json::to_vec(&make_valid_manifest()).unwrap().as_slice(),
      ),
      (CANONICAL_CONTENT_ENTRY, b"content"),
      ("../evil.txt", b"boom"),
    ]);
    let too_many_entries = create_zip_with_entries(&[
      (
        "manifest.json",
        serde_json::to_vec(&make_valid_manifest()).unwrap().as_slice(),
      ),
      (CANONICAL_CONTENT_ENTRY, b"content"),
      ("a.txt", b"1"),
      ("b.txt", b"2"),
    ]);

    let malformed_cases: Vec<(&str, Vec<u8>, &str, Vec<&'static str>)> = vec![
      ("empty", Vec::new(), "empty.zip", vec!["invalid ZIP archive"]),
      (
        "plain-text",
        b"not a zip".to_vec(),
        "plain-text.zip",
        vec!["invalid ZIP archive"],
      ),
      (
        "template-json",
        br#"{"name":"weekly-standup","type":"template","content":{"blocks":[]}}"#.to_vec(),
        "template.json",
        vec!["UNSUPPORTED_TEMPLATE_JSON"],
      ),
      ("zip-slip", zip_slip, "zip-slip.zip", vec!["ZIP_SLIP_PATH"]),
    ];

    for (name, bytes, filename, expected_fragments) in malformed_cases {
      let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        parse_bundle_with_filename(&bytes, filename)
      }));
      assert!(outcome.is_ok(), "parse_bundle_with_filename panicked for case {name}");

      let err = outcome.unwrap().unwrap_err();
      assert!(
        matches!(err, AuthError::InvalidInput(_)),
        "case {name} returned unexpected error variant: {err:?}"
      );
      let msg = err.to_string();
      for fragment in expected_fragments {
        assert!(
          msg.contains(fragment),
          "case {name} expected error fragment {fragment:?}, got: {msg}"
        );
      }
    }

    let too_many_outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
      parse_bundle_with_limits(
        &too_many_entries,
        TemplateBundleZipLimits {
          max_entries: 2,
          max_single_file_size: DEFAULT_MAX_ZIP_SINGLE_FILE_SIZE,
          max_total_uncompressed_size: DEFAULT_MAX_ZIP_TOTAL_UNCOMPRESSED_SIZE,
          max_compression_ratio: DEFAULT_MAX_ZIP_COMPRESSION_RATIO,
          max_path_length: DEFAULT_MAX_ZIP_PATH_LENGTH,
        },
      )
    }));
    assert!(
      too_many_outcome.is_ok(),
      "parse_bundle_with_limits panicked for too-many-entries case"
    );
    let err = too_many_outcome.unwrap().unwrap_err();
    assert!(
      matches!(err, AuthError::InvalidInput(_)),
      "too-many-entries case returned unexpected error variant: {err:?}"
    );
    let msg = err.to_string();
    assert!(msg.contains("ZIP_LIMIT_ENTRIES"), "unexpected error: {msg}");
  }

  #[test]
  fn parse_bundle_missing_content() {
    // Bundle with manifest only, no content.template.zip
    let mut buf = Vec::new();
    {
      let cursor = Cursor::new(&mut buf);
      let mut writer = zip::ZipWriter::new(cursor);
      let options = zip::write::FileOptions::<()>::default();
      let manifest = make_valid_manifest();
      let manifest_json = serde_json::to_vec(&manifest).unwrap();
      writer.start_file("manifest.json", options).unwrap();
      std::io::Write::write_all(&mut writer, &manifest_json).unwrap();
      writer.finish().unwrap();
    }

    let result = parse_bundle(&buf);
    assert!(result.is_err());
  }

  #[test]
  fn parse_bundle_not_a_zip() {
    let result = parse_bundle(b"this is not a zip file");
    assert!(result.is_err());
  }

  #[test]
  fn parse_bundle_rejects_template_json_input() {
    let result = parse_bundle(br#"{"name":"weekly-standup","type":"template","content":{"blocks":[]}}"#);
    let err_msg = result.unwrap_err().to_string();
    assert!(err_msg.contains("UNSUPPORTED_TEMPLATE_JSON"), "{err_msg}");
  }

  #[test]
  fn parse_bundle_rejects_zip_slip_paths() {
    let manifest = make_valid_manifest();
    let content = b"fake-content";
    let bundle = create_zip_with_entries(&[
      (MANIFEST_ENTRY, serde_json::to_vec(&manifest).unwrap().as_slice()),
      (CANONICAL_CONTENT_ENTRY, content),
      ("../evil.txt", b"pwned"),
    ]);

    let err = parse_bundle(&bundle).unwrap_err();
    let err_msg = err.to_string();
    assert!(err_msg.contains("ZIP_SLIP_PATH"), "{err_msg}");
  }

  #[test]
  fn parse_bundle_rejects_oversized_single_entry() {
    let manifest = make_valid_manifest();
    let content = vec![b'x'; 16];
    let bundle = create_zip_with_entries(&[
      (MANIFEST_ENTRY, serde_json::to_vec(&manifest).unwrap().as_slice()),
      (CANONICAL_CONTENT_ENTRY, content.as_slice()),
    ]);

    let limits = TemplateBundleZipLimits {
      max_entries: 10,
      max_single_file_size: 8,
      max_total_uncompressed_size: 1024,
      max_compression_ratio: 200.0,
      max_path_length: 512,
    };

    let err = parse_bundle_with_limits(&bundle, limits).unwrap_err();
    let err_msg = err.to_string();
    assert!(err_msg.contains("ZIP_LIMIT_FILE_SIZE"), "{err_msg}");
  }

  #[test]
  fn parse_bundle_rejects_too_many_entries() {
    let manifest = make_valid_manifest();
    let content = b"fake-content";
    let bundle = create_zip_with_entries(&[
      (MANIFEST_ENTRY, serde_json::to_vec(&manifest).unwrap().as_slice()),
      (CANONICAL_CONTENT_ENTRY, content),
      ("extra.txt", b"1"),
      ("extra-2.txt", b"2"),
    ]);

    let limits = TemplateBundleZipLimits {
      max_entries: 3,
      max_single_file_size: 1024,
      max_total_uncompressed_size: 1024,
      max_compression_ratio: 200.0,
      max_path_length: 512,
    };

    let err = parse_bundle_with_limits(&bundle, limits).unwrap_err();
    let err_msg = err.to_string();
    assert!(err_msg.contains("ZIP_LIMIT_ENTRIES"), "{err_msg}");
  }

  #[test]
  fn parse_bundle_rejects_path_length_limit() {
    let manifest = make_valid_manifest();
    let content = b"fake-content";
    let long_name = format!("{}/preview.svg", "a".repeat(600));
    let bundle = create_zip_with_entries(&[
      (MANIFEST_ENTRY, serde_json::to_vec(&manifest).unwrap().as_slice()),
      (CANONICAL_CONTENT_ENTRY, content),
      (long_name.as_str(), b"preview"),
    ]);

    let limits = TemplateBundleZipLimits {
      max_entries: 10,
      max_single_file_size: 1024,
      max_total_uncompressed_size: 1024 * 1024,
      max_compression_ratio: 200.0,
      max_path_length: 128,
    };

    let err = parse_bundle_with_limits(&bundle, limits).unwrap_err();
    let err_msg = err.to_string();
    assert!(err_msg.contains("ZIP_LIMIT_PATH_LENGTH"), "{err_msg}");
  }

  #[test]
  fn parse_bundle_rejects_compression_ratio_limit() {
    let manifest = make_valid_manifest();
    let content = vec![b'a'; 32 * 1024];
    let options = zip::write::FileOptions::<()>::default().compression_method(zip::CompressionMethod::Deflated);
    let bundle = create_zip_with_entries_and_options(
      &[
        (MANIFEST_ENTRY, serde_json::to_vec(&manifest).unwrap().as_slice()),
        (CANONICAL_CONTENT_ENTRY, content.as_slice()),
      ],
      options,
    );

    let limits = TemplateBundleZipLimits {
      max_entries: 10,
      max_single_file_size: 1024 * 1024,
      max_total_uncompressed_size: 1024 * 1024,
      max_compression_ratio: 1.5,
      max_path_length: 512,
    };

    let err = parse_bundle_with_limits(&bundle, limits).unwrap_err();
    let err_msg = err.to_string();
    assert!(err_msg.contains("ZIP_LIMIT_COMPRESSION_RATIO"), "{err_msg}");
  }

  #[test]
  fn parse_bundle_rejects_total_uncompressed_size_limit() {
    let manifest = make_valid_manifest();
    let content = vec![b'x'; 64];
    let bundle = create_zip_with_entries(&[
      (MANIFEST_ENTRY, serde_json::to_vec(&manifest).unwrap().as_slice()),
      (CANONICAL_CONTENT_ENTRY, content.as_slice()),
      ("preview.svg", vec![b'y'; 64].as_slice()),
    ]);

    let limits = TemplateBundleZipLimits {
      max_entries: 10,
      max_single_file_size: 1024,
      max_total_uncompressed_size: 100,
      max_compression_ratio: 200.0,
      max_path_length: 512,
    };

    let err = parse_bundle_with_limits(&bundle, limits).unwrap_err();
    let err_msg = err.to_string();
    assert!(err_msg.contains("ZIP_LIMIT_TOTAL_SIZE"), "{err_msg}");
  }

  #[test]
  fn validate_manifest_valid() {
    let manifest = make_valid_manifest();
    let errors = validate_manifest(&manifest);
    // Only warnings expected (no errors)
    assert!(errors.iter().all(|e| e.severity == ValidationSeverity::Warning));
  }

  #[test]
  fn validate_manifest_missing_template_id() {
    let mut manifest = make_valid_manifest();
    manifest.template_id = String::new();
    let errors = validate_manifest(&manifest);
    assert!(errors.iter().any(|e| {
      e.code == "MISSING_FIELD"
        && e.field.as_deref() == Some("template_id")
        && e.path.as_deref() == Some("/manifest/template_id")
    }));
  }

  #[test]
  fn validate_manifest_invalid_slug() {
    let mut manifest = make_valid_manifest();
    manifest.template_id = "Invalid_SLUG!".to_string();
    let errors = validate_manifest(&manifest);
    assert!(errors.iter().any(|e| e.code == "INVALID_SLUG"));
  }

  #[test]
  fn validate_manifest_invalid_version() {
    let mut manifest = make_valid_manifest();
    manifest.version = "not-semver".to_string();
    let errors = validate_manifest(&manifest);
    assert!(
      errors
        .iter()
        .any(|e| e.code == "INVALID_VERSION" && e.path.as_deref() == Some("/manifest/version"))
    );
  }

  #[test]
  fn validate_manifest_missing_title() {
    let mut manifest = make_valid_manifest();
    manifest.title = String::new();
    let errors = validate_manifest(&manifest);
    assert!(errors.iter().any(|e| {
      e.code == "MISSING_FIELD" && e.field.as_deref() == Some("title") && e.path.as_deref() == Some("/manifest/title")
    }));
  }

  #[test]
  fn validate_content_checksum_match() {
    let mut manifest = make_valid_manifest();
    manifest.checksum = Some("abc123".to_string());
    assert!(validate_content_checksum(&manifest, "abc123").is_ok());
  }

  #[test]
  fn validate_content_checksum_mismatch() {
    let mut manifest = make_valid_manifest();
    manifest.checksum = Some("abc123".to_string());
    assert!(validate_content_checksum(&manifest, "def456").is_err());
  }

  #[test]
  fn validate_content_checksum_none_skips() {
    let manifest = make_valid_manifest();
    assert!(validate_content_checksum(&manifest, "anything").is_ok());
  }

  #[test]
  fn slug_validation() {
    assert!(is_valid_slug("weekly-standup"));
    assert!(is_valid_slug("a"));
    assert!(is_valid_slug("hello-world-123"));
    assert!(!is_valid_slug(""));
    assert!(!is_valid_slug("-leading"));
    assert!(!is_valid_slug("trailing-"));
    assert!(!is_valid_slug("double--hyphen"));
    assert!(!is_valid_slug("UPPERCASE"));
    assert!(!is_valid_slug("has space"));
    assert!(!is_valid_slug("has_underscore"));
  }

  #[test]
  fn parse_bundle_without_manifest_auto_generates() {
    // ZIP with only content.template.zip, no manifest.json → auto-manifest
    let content = b"fake-myoxus-content";
    let mut buf = Vec::new();
    {
      let cursor = Cursor::new(&mut buf);
      let mut writer = zip::ZipWriter::new(cursor);
      let options = zip::write::FileOptions::<()>::default();
      writer.start_file(CANONICAL_CONTENT_ENTRY, options).unwrap();
      std::io::Write::write_all(&mut writer, content).unwrap();
      writer.finish().unwrap();
    }

    let parsed = parse_bundle_with_filename(&buf, "my-cool-template.zip").unwrap();
    assert_eq!(parsed.manifest.template_id, "my-cool-template");
    assert_eq!(parsed.manifest.version, "1.0.0");
    assert_eq!(parsed.manifest.title, "my-cool-template");
    assert_eq!(parsed.manifest.description.as_deref(), Some("Auto-imported template"));
    assert_eq!(parsed.content_bytes, content);
    assert_eq!(parsed.format, BundleFormat::TemplateBundle);
  }

  #[test]
  fn parse_bundle_accepts_legacy_content_entry_as_fallback() {
    let manifest = make_valid_manifest();
    let content = b"legacy-content";
    let mut buf = Vec::new();
    {
      let cursor = Cursor::new(&mut buf);
      let mut writer = zip::ZipWriter::new(cursor);
      let options = zip::write::FileOptions::<()>::default();

      let manifest_json = serde_json::to_vec(&manifest).unwrap();
      writer.start_file(MANIFEST_ENTRY, options).unwrap();
      std::io::Write::write_all(&mut writer, &manifest_json).unwrap();
      writer.start_file(LEGACY_CONTENT_ENTRY, options).unwrap();
      std::io::Write::write_all(&mut writer, content).unwrap();
      writer.finish().unwrap();
    }

    let parsed = parse_bundle(&buf).unwrap();
    assert_eq!(parsed.content_bytes, content);
    assert_eq!(parsed.format, BundleFormat::LegacyTemplateBundle);
  }

  #[test]
  fn parse_bundle_raw_workspace_zip() {
    // ZIP that IS an .affine.zip (contains workspace-like content)
    let mut buf = Vec::new();
    {
      let cursor = Cursor::new(&mut buf);
      let mut writer = zip::ZipWriter::new(cursor);
      let options = zip::write::FileOptions::<()>::default();
      writer.start_file("doc-data/abc.snapshot", options).unwrap();
      std::io::Write::write_all(&mut writer, b"snapshot-data").unwrap();
      writer.finish().unwrap();
    }

    let parsed = parse_bundle_with_filename(&buf, "Meeting Notes.affine.zip").unwrap();
    assert_eq!(parsed.manifest.template_id, "meeting-notes");
    assert_eq!(parsed.manifest.title, "Meeting Notes.affine");
    assert_eq!(parsed.format, BundleFormat::RawWorkspaceZip);
    // Content should be the raw ZIP bytes themselves
    assert_eq!(parsed.content_bytes, buf);
  }

  #[test]
  fn parse_bundle_detects_upstream_snapshot_zip_from_snapshot_json() {
    let buf = create_zip_with_entries(&[("workspace/page.snapshot.json", VALID_SNAPSHOT_JSON)]);

    let parsed = parse_bundle_with_filename(&buf, "snapshot-import.zip").unwrap();
    assert_eq!(parsed.format, BundleFormat::UpstreamSnapshotZip);
    assert_eq!(parsed.content_bytes, buf);
  }

  #[test]
  fn parse_bundle_snapshot_pattern_accepts_colon_filename() {
    let buf = create_zip_with_entries(&[("workspace/page:home.snapshot.json", VALID_SNAPSHOT_JSON)]);

    let parsed = parse_bundle_with_filename(&buf, "upstream.zip").unwrap();
    assert_eq!(parsed.format, BundleFormat::UpstreamSnapshotZip);
  }

  #[test]
  fn parse_bundle_upstream_snapshot_requires_valid_snapshot_json() {
    let buf = create_zip_with_entries(&[("workspace/page.snapshot.json", br#"{"meta":{"id":"page:home"}"#)]);
    let err = parse_bundle_with_filename(&buf, "broken-upstream.zip").unwrap_err();
    let message = err.to_string();
    assert!(message.contains("SNAPSHOT_JSON_INVALID"), "unexpected error: {message}");
    assert!(message.contains("/snapshots/0"), "unexpected error: {message}");
  }

  #[test]
  fn parse_bundle_upstream_snapshot_requires_meta_id() {
    let buf = create_zip_with_entries(&[("workspace/page.snapshot.json", br#"{"meta":{},"blocks":[]}"#)]);
    let err = parse_bundle_with_filename(&buf, "missing-meta-id.zip").unwrap_err();
    let message = err.to_string();
    assert!(
      message.contains("SNAPSHOT_META_ID_MISSING"),
      "unexpected error: {message}"
    );
    assert!(message.contains("/snapshots/0/meta/id"), "unexpected error: {message}");
  }

  #[test]
  fn parse_bundle_upstream_snapshot_requires_blocks() {
    let buf = create_zip_with_entries(&[("workspace/page.snapshot.json", br#"{"meta":{"id":"page:home"}}"#)]);
    let err = parse_bundle_with_filename(&buf, "missing-blocks.zip").unwrap_err();
    let message = err.to_string();
    assert!(
      message.contains("SNAPSHOT_BLOCKS_MISSING"),
      "unexpected error: {message}"
    );
    assert!(message.contains("/snapshots/0/blocks"), "unexpected error: {message}");
  }

  #[test]
  fn parse_bundle_upstream_snapshot_accepts_optional_info_json_object() {
    let buf = create_zip_with_entries(&[
      ("workspace/page.snapshot.json", VALID_SNAPSHOT_JSON),
      ("info.json", br#"{"name":"fixture"}"#),
    ]);
    let parsed = parse_bundle_with_filename(&buf, "upstream-with-info.zip").unwrap();
    assert_eq!(parsed.format, BundleFormat::UpstreamSnapshotZip);
  }

  #[test]
  fn parse_bundle_upstream_snapshot_rejects_invalid_info_json() {
    let buf = create_zip_with_entries(&[
      ("workspace/page.snapshot.json", VALID_SNAPSHOT_JSON),
      ("info.json", br#"{"name":"fixture""#),
    ]);
    let err = parse_bundle_with_filename(&buf, "upstream-invalid-info.zip").unwrap_err();
    let message = err.to_string();
    assert!(message.contains("INFO_JSON_INVALID"), "unexpected error: {message}");
  }

  #[test]
  fn parse_bundle_snapshot_like_archive_without_snapshot_entries_fails() {
    let buf = create_zip_with_entries(&[
      ("workspace/info.json", br#"{"name":"fixture"}"#),
      ("assets/asset-1.bin", b"asset-data"),
    ]);
    let err = parse_bundle_with_filename(&buf, "snapshot-like-missing-snapshot.zip").unwrap_err();
    let message = err.to_string();
    assert!(
      message.contains("SNAPSHOT_ENTRY_MISSING"),
      "unexpected error: {message}"
    );
  }

  #[test]
  fn parse_bundle_upstream_snapshot_validates_asset_references() {
    let snapshot = br#"{"meta":{"id":"page:home"},"blocks":[{"props":{"sourceId":"asset-1.bin"}}]}"#;
    let buf = create_zip_with_entries(&[
      ("workspace/page.snapshot.json", snapshot),
      ("assets/asset-1.bin", b"asset-data"),
    ]);
    let parsed = parse_bundle_with_filename(&buf, "upstream-assets.zip").unwrap();
    assert_eq!(parsed.format, BundleFormat::UpstreamSnapshotZip);
  }

  #[test]
  fn parse_bundle_upstream_snapshot_accepts_extensionless_source_id() {
    let snapshot = br#"{"meta":{"id":"page:home"},"blocks":[{"props":{"sourceId":"asset-1"}}]}"#;
    let buf = create_zip_with_entries(&[
      ("workspace/page.snapshot.json", snapshot),
      ("assets/asset-1.png", b"asset-data"),
    ]);
    let parsed = parse_bundle_with_filename(&buf, "upstream-assets-extensionless.zip").unwrap();
    assert_eq!(parsed.format, BundleFormat::UpstreamSnapshotZip);
  }

  #[test]
  fn snapshot_asset_index_uses_hash_based_stable_target_keys() {
    let snapshot = br#"{"meta":{"id":"page:home"},"blocks":[{"props":{"sourceId":"asset-1"}}]}"#;
    let buf = create_zip_with_entries(&[
      ("workspace/page.snapshot.json", snapshot),
      ("assets/asset-1.png", b"asset-data"),
      ("workspace/assets/asset-1.png", b"asset-data"),
    ]);

    let snapshot = validate_snapshot_archive(&buf, ArchiveLimits::from(TemplateBundleZipLimits::default())).unwrap();

    assert_eq!(snapshot.assets.len(), 1);
    assert_eq!(snapshot.assets[0].source_key, "assets/asset-1.png");
    assert_eq!(snapshot.assets[0].content_hash, sha256_hex(b"asset-data"));
  }

  #[test]
  fn parse_bundle_upstream_snapshot_rejects_asset_alias_conflicts() {
    let snapshot = br#"{"meta":{"id":"page:home"},"blocks":[{"props":{"sourceId":"asset-1.png"}}]}"#;
    let buf = create_zip_with_entries(&[
      ("workspace/page.snapshot.json", snapshot),
      ("assets/asset-1.png", b"asset-data-a"),
      ("workspace/assets/asset-1.png", b"asset-data-b"),
    ]);

    let err = parse_bundle_with_filename(&buf, "upstream-assets-conflict.zip").unwrap_err();
    let message = err.to_string();
    assert!(
      message.contains("SNAPSHOT_ASSET_ALIAS_CONFLICT"),
      "unexpected error: {message}"
    );
  }

  #[test]
  fn parse_bundle_upstream_snapshot_accepts_virgultum_token_fields() {
    let snapshot = br#"{
      "meta":{"id":"page:home","flavour":"affine:page"},
      "blocks":[
        {
          "id":"block:paragraph-1",
          "flavour":"affine:paragraph",
          "props":{
            "sourceId":"asset-1.bin",
            "sys:children":["block:paragraph-2"],
            "prop:locked":false
          }
        }
      ]
    }"#;
    let buf = create_zip_with_entries(&[
      ("workspace/page.snapshot.json", snapshot),
      ("assets/asset-1.bin", b"asset-data"),
    ]);
    let parsed = parse_bundle_with_filename(&buf, "upstream-token-fields.zip").unwrap();
    assert_eq!(parsed.format, BundleFormat::UpstreamSnapshotZip);
    assert_eq!(
      parsed.content_bytes, buf,
      "upstream payload with virgultum-like tokens must pass through unchanged"
    );
  }

  #[test]
  fn parse_bundle_upstream_snapshot_rejects_missing_asset_reference() {
    let snapshot = br#"{"meta":{"id":"page:home"},"blocks":[{"props":{"sourceId":"asset-missing.bin"}}]}"#;
    let buf = create_zip_with_entries(&[("workspace/page.snapshot.json", snapshot)]);
    let err = parse_bundle_with_filename(&buf, "upstream-missing-asset.zip").unwrap_err();
    let message = err.to_string();
    assert!(
      message.contains("SNAPSHOT_ASSET_REFERENCE_MISSING"),
      "unexpected error: {message}"
    );
    assert!(message.contains("/snapshots/0"), "unexpected error: {message}");
  }

  #[test]
  fn parse_bundle_noise_only_archive_fails() {
    let buf = create_zip_with_entries(&[
      ("__MACOSX/._foo", b"noise"),
      (".DS_Store", b"noise"),
      ("assets/._bar", b"noise"),
    ]);
    let err = parse_bundle_with_filename(&buf, "noise.zip").unwrap_err();
    assert!(
      err
        .to_string()
        .contains("Expected either manifest.json + content.template.zip")
    );
  }

  #[test]
  fn parse_bundle_snapshot_pattern_rejects_non_matching_suffixes() {
    let only_snapshot_without_json = create_zip_with_entries(&[("workspace/foo.snapshot", br#"{}"#)]);
    let parsed = parse_bundle_with_filename(&only_snapshot_without_json, "workspace.zip").unwrap();
    assert_eq!(parsed.format, BundleFormat::RawWorkspaceZip);

    let plain_json = create_zip_with_entries(&[("foo.json", br#"{}"#)]);
    let err = parse_bundle_with_filename(&plain_json, "workspace.zip").unwrap_err();
    assert!(
      err
        .to_string()
        .contains("Expected either manifest.json + content.template.zip")
    );
  }

  #[test]
  fn parse_bundle_detection_does_not_depend_on_container_extension() {
    let payload = create_zip_with_entries(&[("workspace/page.snapshot.json", VALID_SNAPSHOT_JSON)]);
    let parsed_zip = parse_bundle_with_filename(&payload, "template.zip").unwrap();
    let parsed_affine = parse_bundle_with_filename(&payload, "template.affine.zip").unwrap();
    let parsed_bs = parse_bundle_with_filename(&payload, "template.bs.zip").unwrap();

    assert_eq!(parsed_zip.format, BundleFormat::UpstreamSnapshotZip);
    assert_eq!(parsed_affine.format, BundleFormat::UpstreamSnapshotZip);
    assert_eq!(parsed_bs.format, BundleFormat::UpstreamSnapshotZip);
  }

  #[test]
  fn parse_bundle_prioritizes_internal_bundle_over_snapshot_markers() {
    let manifest = make_valid_manifest();
    let manifest_json = serde_json::to_vec(&manifest).unwrap();
    let content = b"canonical-content";
    let bundle = create_zip_with_entries(&[
      (MANIFEST_ENTRY, manifest_json.as_slice()),
      (CANONICAL_CONTENT_ENTRY, content),
      ("workspace/page.snapshot.json", VALID_SNAPSHOT_JSON),
    ]);

    let parsed = parse_bundle_with_filename(&bundle, "hybrid-input.zip").unwrap();
    assert_eq!(parsed.format, BundleFormat::TemplateBundle);
    assert_eq!(parsed.content_bytes, content);
  }

  #[test]
  fn detect_template_input_format_prioritizes_internal_bundle_over_snapshot_markers() {
    let entry_names = vec![
      MANIFEST_ENTRY.to_string(),
      CANONICAL_CONTENT_ENTRY.to_string(),
      "workspace/page.snapshot.json".to_string(),
    ];

    let format = detect_template_input_format(&entry_names).unwrap();
    assert_eq!(format, TemplateInputFormat::TemplateBundle);
  }

  #[test]
  fn normalize_template_input_extracts_internal_bundle_payload() {
    let manifest = make_valid_manifest();
    let content = b"canonical-content";
    let preview = b"<svg>preview</svg>";
    let bundle = create_zip_with_entries(&[
      (MANIFEST_ENTRY, serde_json::to_vec(&manifest).unwrap().as_slice()),
      (CANONICAL_CONTENT_ENTRY, content),
      (PREVIEW_ENTRY, preview),
      ("__MACOSX/._content.template.zip", b"noise"),
    ]);

    let archive_index = inspect_zip_bytes(&bundle, ArchiveLimits::from(TemplateBundleZipLimits::default())).unwrap();
    let entry_names = archive_index.entry_names();
    let ignored_entries = archive_index.ignored_entry_names();

    let normalized = normalize_template_input(
      &bundle,
      "input.zip",
      &entry_names,
      TemplateInputFormat::TemplateBundle,
      ignored_entries,
    )
    .unwrap();

    assert_eq!(normalized.format, TemplateInputFormat::TemplateBundle);
    assert_eq!(normalized.manifest.template_id, manifest.template_id);
    assert_eq!(normalized.content_bytes, content);
    assert_eq!(normalized.preview_bytes.as_deref(), Some(preview.as_slice()));
    assert!(
      normalized
        .ignored_entries
        .iter()
        .any(|entry| entry == "__MACOSX/._content.template.zip")
    );
  }

  #[test]
  fn detect_and_normalize_pipeline_stages_are_independently_callable() {
    let manifest = make_valid_manifest();
    let content = b"canonical-content";
    let bundle = create_zip_with_entries(&[
      (MANIFEST_ENTRY, serde_json::to_vec(&manifest).unwrap().as_slice()),
      (CANONICAL_CONTENT_ENTRY, content),
      ("__MACOSX/._content.template.zip", b"noise"),
    ]);

    let detection = detect_template_format_with_limits(&bundle, TemplateBundleZipLimits::default())
      .expect("format detection should succeed for canonical bundle");
    assert_eq!(detection.format, TemplateInputFormat::TemplateBundle);
    assert!(
      detection
        .ignored_entries
        .iter()
        .any(|entry| entry == "__MACOSX/._content.template.zip")
    );

    let normalized = normalize_template_input(
      &bundle,
      "input.zip",
      &detection.entry_names,
      detection.format,
      detection.ignored_entries.clone(),
    )
    .expect("normalization should succeed from detached detection result");
    assert_eq!(normalized.manifest.template_id, manifest.template_id);
    assert_eq!(normalized.content_bytes, content);
  }

  #[test]
  fn parse_bundle_counts_ignored_noise_entries() {
    let manifest = make_valid_manifest();
    let content = b"canonical-content";
    let mut buf = Vec::new();
    {
      let cursor = Cursor::new(&mut buf);
      let mut writer = zip::ZipWriter::new(cursor);
      let options = zip::write::FileOptions::<()>::default();

      let manifest_json = serde_json::to_vec(&manifest).unwrap();
      writer.start_file(MANIFEST_ENTRY, options).unwrap();
      std::io::Write::write_all(&mut writer, &manifest_json).unwrap();
      writer.start_file(CANONICAL_CONTENT_ENTRY, options).unwrap();
      std::io::Write::write_all(&mut writer, content).unwrap();
      writer.start_file("__MACOSX/._content.template.zip", options).unwrap();
      std::io::Write::write_all(&mut writer, b"noise").unwrap();
      writer.start_file(".DS_Store", options).unwrap();
      std::io::Write::write_all(&mut writer, b"noise").unwrap();
      writer.start_file("assets/._preview.svg", options).unwrap();
      std::io::Write::write_all(&mut writer, b"noise").unwrap();
      writer.finish().unwrap();
    }

    let parsed = parse_bundle(&buf).unwrap();
    assert_eq!(parsed.ignored_entries.len(), 3);
    assert!(
      parsed
        .ignored_entries
        .iter()
        .any(|entry| entry == "__MACOSX/._content.template.zip")
    );
    assert!(parsed.ignored_entries.iter().any(|entry| entry == ".DS_Store"));
    assert!(
      parsed
        .ignored_entries
        .iter()
        .any(|entry| entry == "assets/._preview.svg")
    );
  }

  #[test]
  fn parse_bundle_no_content_returns_helpful_error() {
    // ZIP with neither manifest nor AFFiNE content
    let mut buf = Vec::new();
    {
      let cursor = Cursor::new(&mut buf);
      let mut writer = zip::ZipWriter::new(cursor);
      let options = zip::write::FileOptions::<()>::default();
      writer.start_file("random.txt", options).unwrap();
      std::io::Write::write_all(&mut writer, b"hello").unwrap();
      writer.finish().unwrap();
    }

    let result = parse_bundle(&buf);
    assert!(result.is_err());
    let err_msg = format!("{}", result.unwrap_err());
    assert!(
      err_msg.contains("template manifest") || err_msg.contains("AFFiNE content"),
      "Error should mention missing manifest/content, got: {err_msg}"
    );
  }

  #[test]
  fn parse_bundle_with_manifest_still_works() {
    // Canonical format: manifest.json + content.template.zip
    let manifest = make_valid_manifest();
    let content = b"canonical-content";
    let bundle = create_test_bundle(&manifest, content, None);
    let parsed = parse_bundle(&bundle).unwrap();
    assert_eq!(parsed.manifest.template_id, "weekly-standup");
    assert_eq!(parsed.content_bytes, content);
  }

  #[test]
  fn sanitize_slug_works() {
    assert_eq!(sanitize_slug("Hello World.zip"), "hello-world");
    assert_eq!(sanitize_slug("My Template"), "my-template");
    assert_eq!(sanitize_slug("test.affine.zip"), "test");
    assert_eq!(sanitize_slug("test.template.zip"), "test");
    assert_eq!(sanitize_slug("---"), "imported-template");
    assert_eq!(sanitize_slug("UPPER_case"), "upper-case");
  }

  #[test]
  fn export_then_parse_roundtrip() {
    let manifest = make_valid_manifest();
    let content = b"some template content data";
    let preview = b"<svg>preview</svg>";

    let exported = create_export_bundle(&manifest, content, Some(preview), &BTreeMap::new()).unwrap();
    let parsed = parse_bundle(&exported).unwrap();

    assert_eq!(parsed.manifest.template_id, manifest.template_id);
    assert_eq!(parsed.manifest.version, manifest.version);
    assert_eq!(parsed.manifest.title, manifest.title);
    assert_eq!(parsed.content_bytes, content);
    assert_eq!(parsed.preview_bytes.as_deref(), Some(preview.as_slice()));
    assert_eq!(parsed.format, BundleFormat::TemplateBundle);
  }

  #[test]
  fn export_bundle_preserves_manifest_fields_exactly() {
    let mut manifest = make_valid_manifest();
    manifest.description = Some("Detailed description".to_string());
    manifest.category = Some("planning".to_string());
    manifest.tags = vec!["alpha".to_string(), "beta".to_string(), "gamma".to_string()];
    manifest.locale = Some("de".to_string());
    manifest.kind = Some("edgeless".to_string());
    manifest.min_server_version = Some("2.3.4".to_string());
    manifest.checksum = Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string());

    let content = b"manifest-stability-content";
    let exported = create_export_bundle(&manifest, content, None, &BTreeMap::new()).unwrap();
    let parsed = parse_bundle(&exported).unwrap();

    assert_eq!(parsed.manifest.template_id, manifest.template_id);
    assert_eq!(parsed.manifest.version, manifest.version);
    assert_eq!(parsed.manifest.title, manifest.title);
    assert_eq!(parsed.manifest.description, manifest.description);
    assert_eq!(parsed.manifest.category, manifest.category);
    assert_eq!(parsed.manifest.tags, manifest.tags);
    assert_eq!(parsed.manifest.locale, manifest.locale);
    assert_eq!(parsed.manifest.kind, manifest.kind);
    assert_eq!(parsed.manifest.min_server_version, manifest.min_server_version);
    assert_eq!(parsed.manifest.checksum, manifest.checksum);
    assert_eq!(parsed.content_bytes, content);
  }

  #[test]
  fn export_bundle_preview_policy_contract() {
    let manifest = make_valid_manifest();
    let content = b"preview-policy-content";
    let preview = b"<svg>expected-preview</svg>";

    let without_preview = create_export_bundle(&manifest, content, None, &BTreeMap::new()).unwrap();
    let parsed_without_preview = parse_bundle(&without_preview).unwrap();
    assert!(parsed_without_preview.preview_bytes.is_none());
    assert_eq!(
      zip_entry_names(&without_preview),
      vec![MANIFEST_ENTRY.to_string(), CANONICAL_CONTENT_ENTRY.to_string()]
    );

    let with_preview = create_export_bundle(&manifest, content, Some(preview), &BTreeMap::new()).unwrap();
    let parsed_with_preview = parse_bundle(&with_preview).unwrap();
    assert_eq!(parsed_with_preview.preview_bytes.as_deref(), Some(preview.as_slice()));
    assert_eq!(
      zip_entry_names(&with_preview),
      vec![
        MANIFEST_ENTRY.to_string(),
        CANONICAL_CONTENT_ENTRY.to_string(),
        PREVIEW_ENTRY.to_string(),
      ]
    );

    let preview_payload = zip_entry_payloads(&with_preview)
      .into_iter()
      .find(|(name, _)| name == PREVIEW_ENTRY)
      .map(|(_, payload)| payload)
      .expect("preview.svg entry should exist");
    assert_eq!(preview_payload, preview);
  }

  #[test]
  fn export_bundle_entry_order_is_deterministic() {
    let manifest = make_valid_manifest();
    let content = b"entry-order-content";
    let preview = b"<svg>entry-order-preview</svg>";

    let without_preview = create_export_bundle(&manifest, content, None, &BTreeMap::new()).unwrap();
    assert_eq!(
      zip_entry_names(&without_preview),
      vec![MANIFEST_ENTRY.to_string(), CANONICAL_CONTENT_ENTRY.to_string()]
    );

    let with_preview = create_export_bundle(&manifest, content, Some(preview), &BTreeMap::new()).unwrap();
    assert_eq!(
      zip_entry_names(&with_preview),
      vec![
        MANIFEST_ENTRY.to_string(),
        CANONICAL_CONTENT_ENTRY.to_string(),
        PREVIEW_ENTRY.to_string(),
      ]
    );
  }

  #[test]
  fn export_bundle_contains_only_internal_entries() {
    let manifest = make_valid_manifest();
    let content = b"some template content data";
    let exported = create_export_bundle(&manifest, content, None, &BTreeMap::new()).unwrap();
    assert_eq!(
      zip_entry_names(&exported),
      vec![MANIFEST_ENTRY.to_string(), CANONICAL_CONTENT_ENTRY.to_string()]
    );
  }

  #[test]
  fn export_bundle_with_preview_contains_only_internal_entries() {
    let manifest = make_valid_manifest();
    let content = b"some template content data";
    let preview = b"<svg>preview</svg>";
    let exported = create_export_bundle(&manifest, content, Some(preview), &BTreeMap::new()).unwrap();
    assert_eq!(
      zip_entry_names(&exported),
      vec![
        MANIFEST_ENTRY.to_string(),
        CANONICAL_CONTENT_ENTRY.to_string(),
        PREVIEW_ENTRY.to_string(),
      ]
    );
  }

  #[test]
  fn export_bundle_content_checksum_matches_payload_checksum() {
    let mut manifest = make_valid_manifest();
    let content = b"checksum-sensitive content payload";
    let expected_checksum = sha256_hex(content);
    manifest.checksum = Some(expected_checksum.clone());

    let exported = create_export_bundle(&manifest, content, None, &BTreeMap::new()).unwrap();
    let parsed = parse_bundle(&exported).unwrap();

    assert_eq!(parsed.content_checksum, expected_checksum);
    assert_eq!(parsed.manifest.checksum.as_deref(), Some(expected_checksum.as_str()));
    assert!(validate_content_checksum(&parsed.manifest, &parsed.content_checksum).is_ok());
  }

  #[test]
  fn export_bundle_is_semantically_stable_for_identical_inputs() {
    let manifest = make_valid_manifest();
    let content = b"some template content data";
    let preview = b"<svg>preview</svg>";

    let first = create_export_bundle(&manifest, content, Some(preview), &BTreeMap::new()).unwrap();
    let second = create_export_bundle(&manifest, content, Some(preview), &BTreeMap::new()).unwrap();

    // Strict byte-for-byte stability is not asserted: ZIP file metadata uses current-time defaults.
    assert_eq!(zip_entry_names(&first), zip_entry_names(&second));
    assert_eq!(zip_entry_payloads(&first), zip_entry_payloads(&second));

    let parsed_first = parse_bundle(&first).unwrap();
    let parsed_second = parse_bundle(&second).unwrap();
    assert_eq!(parsed_first.manifest.template_id, parsed_second.manifest.template_id);
    assert_eq!(parsed_first.manifest.version, parsed_second.manifest.version);
    assert_eq!(parsed_first.manifest.title, parsed_second.manifest.title);
    assert_eq!(parsed_first.content_bytes, parsed_second.content_bytes);
    assert_eq!(parsed_first.preview_bytes, parsed_second.preview_bytes);
    assert_eq!(parsed_first.content_checksum, parsed_second.content_checksum);
    assert_eq!(parsed_first.format, parsed_second.format);
  }

  #[test]
  fn bundle_format_string_contract_is_stable() {
    assert_eq!(BundleFormat::TemplateBundle.as_str(), "myoxus_bundle");
    assert_eq!(BundleFormat::LegacyTemplateBundle.as_str(), "legacy_myoxus_bundle");
    assert_eq!(BundleFormat::UpstreamSnapshotZip.as_str(), "upstream_snapshot_zip");
    assert_eq!(BundleFormat::RawWorkspaceZip.as_str(), "raw_workspace_zip");
  }
}
