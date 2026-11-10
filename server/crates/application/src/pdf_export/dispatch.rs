// SPDX-License-Identifier: AGPL-3.0-or-later
//! Canonical render snapshots, defaults, and validation shared by PDF callers.
use super::error::{PdfExportError, PdfExportErrorDetails, Result};
use myoxus_domain::entities::{DocumentMetadataValidationCode, DocumentVersion};
use myoxus_pdf_export::ir::{
  Branding, DEFAULT_BODY_FONT_SCALE, DEFAULT_HEADING_FONT_SCALE, NativeTablePalette, ThemeFontSelection,
  ThemeTypographySelection,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfThemeFontAssetRef {
  pub family_slug: String,
  pub family: String,
  pub asset_key: String,
  pub sha256: String,
  pub format: String,
}

#[derive(Debug, Clone)]
pub struct PdfThemeContext {
  pub fonts: ThemeFontSelection,
  pub typography: ThemeTypographySelection,
  pub native_table_palette: Option<NativeTablePalette>,
  pub font_assets: BTreeMap<String, PdfThemeFontAssetRef>,
  pub branding: Branding,
  pub theme_slug: String,
  pub profile_scope: String,
  pub default_paper_size: Option<String>,
  pub default_locale: Option<String>,
  pub default_color_profile: Option<String>,
  pub default_image_quality: Option<String>,
  pub ligatures_enabled: bool,
}

/// Normalized dispatch snapshot built by the shared create use case.
/// Renderer adapters consume it; it is not a separately accepted tool input.
#[derive(Clone, Debug, Default)]
pub struct PdfExportDispatchInput {
  pub workspace_id: String,
  pub doc_id: String,
  pub template_id: String,
  pub locale: Option<String>,
  pub paper_size: Option<String>,
  pub orientation: Option<String>,
  pub heading_font_scale: Option<f64>,
  pub body_font_scale: Option<f64>,
  pub image_quality: Option<String>,
  pub compliance_profile: Option<String>,
  pub color_profile: Option<String>,
  pub ligatures_enabled: Option<bool>,
  pub cover_page: Option<bool>,
  pub toc_behavior: Option<String>,
  pub footer_style: Option<String>,
  pub page_numbering: Option<String>,
  pub color_variant: Option<String>,
  pub confidentiality_label: Option<String>,
  pub typed_inputs: Option<serde_json::Value>,
  pub document_version_id: Option<String>,
  pub resolved_document_version_id: Option<String>,
  pub version_label: Option<String>,
  pub doc_history_id: Option<i64>,
  pub latest_idempotency_key: Option<String>,
  pub document_metadata_snapshot: Option<serde_json::Value>,
  pub metadata_validation: Option<serde_json::Value>,
}

/// Validate a V2 paper-size literal at the renderer boundary.
///
/// The renderer consumes V2 names directly; this function deliberately does
/// not translate into another namespace. Unsupported sizes are rejected
/// explicitly so operators never receive a silently downgraded PDF.
pub(crate) fn validate_render_paper_size(paper_size: &str) -> Result<String> {
  match paper_size {
    "A4" | "Letter" | "A3" | "A5" | "16:9" => Ok(paper_size.to_string()),
    other => {
      let mut err = PdfExportError::new(format!(
        "paper size `{other}` is not supported by the renderer (supported: A4, Letter, A3, A5, 16:9)"
      ));
      err.extensions = Some({
        let mut ext = PdfExportErrorDetails::default();
        ext.set("class", "ValidationError");
        ext.set("field", "paper_size");
        ext.set("supported", "A4|Letter|A3|A5|16:9");
        ext
      });
      Err(err)
    }
  }
}

pub(crate) fn validate_render_orientation(orientation: &str) -> Result<String> {
  match orientation {
    "portrait" | "landscape" => Ok(orientation.to_owned()),
    other => {
      let mut err = PdfExportError::new(format!(
        "orientation `{other}` is not supported (supported: portrait, landscape)"
      ));
      err.extensions = Some({
        let mut ext = PdfExportErrorDetails::default();
        ext.set("class", "ValidationError");
        ext.set("field", "orientation");
        ext.set("supported", "portrait|landscape");
        ext
      });
      Err(err)
    }
  }
}

pub(crate) fn validate_font_scale(field: &'static str, scale: f64) -> Result<f64> {
  if scale.is_finite() && (0.5..=1.5).contains(&scale) {
    return Ok(scale);
  }
  let mut err = PdfExportError::new(format!("pdf_export.{field} must be between 0.5 and 1.5"));
  err.extensions = Some({
    let mut ext = PdfExportErrorDetails::default();
    ext.set("class", "ConfigurationError");
    ext.set("field", field);
    ext
  });
  Err(err)
}

/// Validate PDF writer standards profiles before queueing a render.
///
/// This is intentionally a closed list. PDF/X is not accepted here until the
/// renderer has a real PDF/X writer/post-processor and a validator gate; the
/// API must not let clients request a profile that would silently produce a
/// normal PDF.
pub(crate) fn validate_compliance_profile(compliance_profile: &str) -> Result<String> {
  match compliance_profile {
    "standard" | "pdfa-1b" | "pdfa-2b" | "pdfa-2u" | "pdfa-3b" | "pdfua-1" => Ok(compliance_profile.to_owned()),
    other => {
      let mut err = PdfExportError::new(format!(
        "pdf compliance profile `{other}` is not supported by the renderer (supported: standard, pdfa-1b, pdfa-2b, pdfa-2u, pdfa-3b, pdfua-1)"
      ));
      err.extensions = Some({
        let mut ext = PdfExportErrorDetails::default();
        ext.set("class", "UnsupportedComplianceProfile");
        ext.set("field", "compliance_profile");
        ext.set("supported", "standard|pdfa-1b|pdfa-2b|pdfa-2u|pdfa-3b|pdfua-1");
        ext
      });
      Err(err)
    }
  }
}

/// Validate the canonical color-profile families selected through
/// `pdf_export_settings.default_color_profile_id`.
pub(crate) fn validate_render_color_profile(color_profile: &str) -> Result<String> {
  match color_profile {
    "sRGB" | "CMYK_FOGRA39" | "CMYK_SWOP" => Ok(color_profile.to_owned()),
    other => {
      let mut err = PdfExportError::new(format!(
        "color profile `{other}` is not supported by the renderer (supported: sRGB, CMYK_FOGRA39, CMYK_SWOP)"
      ));
      err.extensions = Some({
        let mut ext = PdfExportErrorDetails::default();
        ext.set("class", "ValidationError");
        ext.set("field", "color_profile");
        ext.set("supported", "sRGB|CMYK_FOGRA39|CMYK_SWOP");
        ext
      });
      Err(err)
    }
  }
}

/// Parse a V2 image-quality literal into the application-layer enum.
/// Refuses unknown values with a structured error so a typo in the
/// input never silently degrades the rendered image quality.
pub(crate) fn parse_image_quality(raw: &str) -> Result<crate::pdf_export::render_context::ImageQuality> {
  use crate::pdf_export::render_context::ImageQuality;
  match raw {
    "low" => Ok(ImageQuality::Low),
    "med" => Ok(ImageQuality::Med),
    "high" => Ok(ImageQuality::High),
    "lossless" => Ok(ImageQuality::Lossless),
    other => {
      let mut err = PdfExportError::new(format!(
        "invalid image_quality `{other}` — expected one of low|med|high|lossless"
      ));
      err.extensions = Some({
        let mut ext = PdfExportErrorDetails::default();
        ext.set("class", "ValidationError");
        ext.set("field", "image_quality");
        ext
      });
      Err(err)
    }
  }
}

pub(crate) fn non_empty_option(value: Option<&String>) -> Option<String> {
  value
    .map(|value| value.trim())
    .filter(|value| !value.is_empty())
    .map(str::to_owned)
}

pub(crate) fn apply_effective_pdf_defaults(
  input: &mut PdfExportDispatchInput,
  theme: &PdfThemeContext,
  config: &super::service::PdfExportDefaults,
  main_web_locale: &str,
) -> Result<(String, String)> {
  let locale = non_empty_option(input.locale.as_ref())
    .or_else(|| non_empty_option(theme.default_locale.as_ref()))
    .unwrap_or_else(|| {
      let locale = main_web_locale.trim();
      if locale.is_empty() { "en" } else { locale }.to_owned()
    });
  let paper_size_raw = non_empty_option(input.paper_size.as_ref())
    .or_else(|| non_empty_option(theme.default_paper_size.as_ref()))
    .unwrap_or_else(|| config.default_paper_size.clone());
  let paper_size = validate_render_paper_size(&paper_size_raw)?;

  input.locale = Some(locale.clone());
  input.paper_size = Some(paper_size.clone());
  input.orientation = Some(validate_render_orientation(
    input.orientation.as_deref().unwrap_or("portrait"),
  )?);
  if input.image_quality.is_none() {
    input.image_quality =
      non_empty_option(theme.default_image_quality.as_ref()).or_else(|| Some(config.default_image_quality.clone()));
  }
  if let Some(quality) = input.image_quality.as_deref() {
    parse_image_quality(quality)?;
  }
  let color_profile = validate_render_color_profile(
    non_empty_option(input.color_profile.as_ref())
      .or_else(|| non_empty_option(theme.default_color_profile.as_ref()))
      .unwrap_or_else(|| config.default_color_profile.clone())
      .as_str(),
  )?;
  input.color_profile = Some(color_profile);
  input.ligatures_enabled = Some(input.ligatures_enabled.unwrap_or(theme.ligatures_enabled));
  input.heading_font_scale = Some(validate_font_scale("heading_font_scale", config.heading_font_scale)?);
  input.body_font_scale = Some(validate_font_scale("body_font_scale", config.body_font_scale)?);

  Ok((locale, paper_size))
}

pub(crate) fn effective_pdf_render_appearance_hash(theme: &PdfThemeContext) -> String {
  // This is intentionally broader than document branding: the audit needs a
  // reproducible snapshot of every appearance input that can change pixels
  // without mixing in PDF export policy such as paper size or ICC profile.
  stable_hash_value(&serde_json::json!({
    "theme_slug": theme.theme_slug,
    "theme_profile_scope": theme.profile_scope,
    "document_branding": theme.branding,
    "theme_fonts": theme.fonts,
    "theme_typography": theme.typography,
    "theme_font_assets": theme.font_assets,
    "native_table_palette": theme.native_table_palette,
  }))
}

pub(crate) fn safe_sync_error_summary(class: &str) -> &'static str {
  match class {
    "TooLarge" => "pdf export rejected: document is too large for sync render",
    "Timeout" => "pdf export rejected: render exceeded the time budget",
    "RenderError" => "pdf export failed during render",
    "DecodeError" => "pdf export failed: source document could not be decoded",
    "AssetError" => "pdf export failed: a required asset is unavailable",
    "TemplateError" => "pdf export failed: template configuration is invalid",
    "StorageError" => "pdf export failed while persisting the result",
    "DocumentFieldUnavailable" => "pdf export failed: document field context is unavailable",
    "UnsupportedComplianceProfile" => "pdf export rejected: compliance profile is unsupported",
    "PdfaValidationFailed" => "pdf export failed PDF-A validation",
    "PdfuaValidationFailed" => "pdf export failed PDF-UA validation",
    _ => "pdf export failed",
  }
}

// ---------------------------------------------------------------------------
// Compute options hash
// ---------------------------------------------------------------------------

pub(crate) fn compute_render_inputs_hash(
  doc_id: &Uuid,
  template_id: &str,
  render_inputs: &serde_json::Value,
) -> String {
  let raw = serde_json::json!({
    "doc_id": doc_id,
    "template_id": template_id,
    "render_inputs": render_inputs,
  })
  .to_string();
  let mut hasher = Sha256::new();
  hasher.update(raw.as_bytes());
  format!("{:x}", hasher.finalize())
}

pub(crate) fn build_render_inputs(input: &PdfExportDispatchInput, theme: &PdfThemeContext) -> serde_json::Value {
  let mut out = serde_json::Map::new();
  out.insert(
    "locale".into(),
    serde_json::Value::String(input.locale.as_deref().unwrap_or("en").to_string()),
  );
  out.insert(
    "paper_size".into(),
    serde_json::Value::String(input.paper_size.as_deref().unwrap_or("A4").to_string()),
  );
  out.insert(
    "orientation".into(),
    serde_json::Value::String(input.orientation.as_deref().unwrap_or("portrait").to_string()),
  );
  out.insert(
    "heading_font_scale".into(),
    serde_json::json!(input.heading_font_scale.unwrap_or(DEFAULT_HEADING_FONT_SCALE)),
  );
  out.insert(
    "body_font_scale".into(),
    serde_json::json!(input.body_font_scale.unwrap_or(DEFAULT_BODY_FONT_SCALE)),
  );
  out.insert(
    "toc_behavior".into(),
    serde_json::Value::String(input.toc_behavior.as_deref().unwrap_or("off").to_string()),
  );
  out.insert("footer_style".into(), serde_json::json!(input.footer_style));
  out.insert("page_numbering".into(), serde_json::json!(input.page_numbering));
  out.insert("color_variant".into(), serde_json::json!(input.color_variant));
  if let Some(quality) = input.image_quality.as_deref() {
    out.insert("image_quality".into(), serde_json::Value::String(quality.to_string()));
  }
  out.insert(
    "compliance_profile".into(),
    serde_json::Value::String(input.compliance_profile.as_deref().unwrap_or("standard").to_string()),
  );
  if let Some(profile) = input.color_profile.as_deref() {
    out.insert("color_profile".into(), serde_json::Value::String(profile.to_string()));
  }
  out.insert(
    "ligatures_enabled".into(),
    serde_json::Value::Bool(input.ligatures_enabled.unwrap_or(theme.ligatures_enabled)),
  );
  if let Some(cover) = input.cover_page {
    out.insert("cover_page".into(), serde_json::Value::Bool(cover));
  }
  if let Some(label) = input.confidentiality_label.as_deref() {
    out.insert(
      "confidentiality_label".into(),
      serde_json::Value::String(label.to_string()),
    );
  }
  if let Some(typed_inputs) = input.typed_inputs.as_ref() {
    out.insert("typed_inputs".into(), typed_inputs.clone());
  }
  if let Some(selector) = input.document_version_id.as_deref() {
    out.insert(
      "document_version_selector".into(),
      serde_json::Value::String(selector.to_string()),
    );
  }
  if let Some(version_id) = input.resolved_document_version_id.as_deref() {
    out.insert(
      "document_version_id".into(),
      serde_json::Value::String(version_id.to_string()),
    );
  }
  if let Some(label) = input.version_label.as_deref() {
    out.insert("version_label".into(), serde_json::Value::String(label.to_string()));
  }
  if let Some(history_id) = input.doc_history_id {
    out.insert("doc_history_id".into(), serde_json::Value::Number(history_id.into()));
  }
  if let Some(key) = input.latest_idempotency_key.as_deref() {
    out.insert(
      "latest_idempotency_key".into(),
      serde_json::Value::String(key.to_string()),
    );
  }
  out.insert(
    "theme_fonts".into(),
    serde_json::to_value(&theme.fonts).unwrap_or_else(|_| serde_json::json!({})),
  );
  out.insert(
    "theme_typography".into(),
    serde_json::to_value(&theme.typography).unwrap_or_else(|_| serde_json::json!({})),
  );
  out.insert(
    "theme_font_assets".into(),
    serde_json::to_value(&theme.font_assets).unwrap_or_else(|_| serde_json::json!({})),
  );
  out.insert(
    "document_branding".into(),
    serde_json::to_value(&theme.branding).unwrap_or_else(|_| serde_json::json!({})),
  );
  if let Some(palette) = &theme.native_table_palette {
    out.insert("native_table_palette".into(), serde_json::json!(palette));
  }
  out.insert("theme_slug".into(), serde_json::Value::String(theme.theme_slug.clone()));
  out.insert(
    "theme_profile_scope".into(),
    serde_json::Value::String(theme.profile_scope.clone()),
  );
  if let Some(snapshot) = input.document_metadata_snapshot.as_ref() {
    out.insert("documentMetadata".into(), snapshot.clone());
  }
  if let Some(validation) = input.metadata_validation.as_ref() {
    out.insert("attributeValidation".into(), validation.clone());
  }
  serde_json::Value::Object(out)
}

pub(crate) fn build_l3_inputs(input: &PdfExportDispatchInput, theme: &PdfThemeContext) -> serde_json::Value {
  let mut value = build_render_inputs(input, theme);
  if let Some(obj) = value.as_object_mut() {
    obj.remove("document_version_selector");
    obj.remove("document_version_id");
    obj.remove("version_label");
    obj.remove("doc_history_id");
    obj.remove("latest_idempotency_key");
  }
  value
}

pub(crate) fn canonical_json(value: &serde_json::Value) -> String {
  match value {
    serde_json::Value::Null => "null".to_string(),
    serde_json::Value::Bool(value) => value.to_string(),
    serde_json::Value::Number(value) => value.to_string(),
    serde_json::Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string()),
    serde_json::Value::Array(values) => {
      let parts = values.iter().map(canonical_json).collect::<Vec<_>>().join(",");
      format!("[{parts}]")
    }
    serde_json::Value::Object(values) => {
      let mut parts = values
        .iter()
        .map(|(key, value)| {
          let key = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
          format!("{key}:{}", canonical_json(value))
        })
        .collect::<Vec<_>>();
      parts.sort();
      format!("{{{}}}", parts.join(","))
    }
  }
}

pub(crate) fn stable_hash_value(value: &serde_json::Value) -> String {
  let mut hasher = Sha256::new();
  hasher.update(canonical_json(value).as_bytes());
  format!("{:x}", hasher.finalize())
}

/// Identify the validated DB/blob bundle independently of its stable ID and
/// SemVer: external system files may change under the same manifest version.
pub(crate) fn template_bundle_digest(template: &myoxus_pdf_export::template_v2::LoadedTemplate) -> String {
  let files: std::collections::BTreeMap<_, _> = template
    .files
    .iter()
    .map(|(path, bytes)| (path, format!("{:x}", Sha256::digest(bytes))))
    .collect();
  stable_hash_value(&serde_json::json!({ "manifest": &template.manifest, "files": files }))
}

pub(crate) fn stable_latest_idempotency_key(input: &PdfExportDispatchInput, theme: &PdfThemeContext) -> Option<String> {
  if input.document_version_id.as_deref() != Some("latest") {
    return None;
  }
  let mut metadata_snapshot = input
    .document_metadata_snapshot
    .clone()
    .unwrap_or_else(|| serde_json::json!({}));
  if let Some(obj) = metadata_snapshot.as_object_mut() {
    // The export itself updates these derived fields. They are intentionally
    // excluded from the latest-selector key while all actual document
    // metadata fields remain part of the key.
    obj.insert("version".to_string(), serde_json::Value::Null);
    obj.remove("validation");
  }
  let value = serde_json::json!({
    "workspace_id": input.workspace_id,
    "doc_id": input.doc_id,
    "template_id": input.template_id,
    "locale": input.locale.as_deref().unwrap_or("en"),
    "paper_size": input.paper_size.as_deref().unwrap_or("A4"),
    "image_quality": input.image_quality,
    "color_profile": input.color_profile,
    "ligatures_enabled": input.ligatures_enabled.unwrap_or(theme.ligatures_enabled),
    "cover_page": input.cover_page,
    "toc_behavior": input.toc_behavior.as_deref().unwrap_or("off"),
    "footer_style": input.footer_style,
    "page_numbering": input.page_numbering,
    "color_variant": input.color_variant,
    "confidentiality_label": input.confidentiality_label,
    "typed_inputs": input.typed_inputs,
    "documentMetadata": metadata_snapshot,
    "theme_fonts": &theme.fonts,
    "theme_typography": &theme.typography,
    "theme_font_assets": &theme.font_assets,
    "document_branding": &theme.branding,
    "theme_slug": &theme.theme_slug,
    "theme_profile_scope": &theme.profile_scope,
  });
  Some(stable_hash_value(&value))
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedDocumentVersion {
  pub(crate) id: Uuid,
  pub(crate) label: String,
  pub(crate) history_id: i64,
  pub(crate) version: DocumentVersion,
}

pub(crate) fn apply_resolved_document_version(input: &mut PdfExportDispatchInput, resolved: &ResolvedDocumentVersion) {
  input.resolved_document_version_id = Some(resolved.id.to_string());
  input.version_label = Some(resolved.label.clone());
  input.doc_history_id = Some(resolved.history_id);
}

pub(crate) fn validation_error(message: impl Into<String>, field: &'static str) -> PdfExportError {
  let mut err = PdfExportError::new(message.into());
  err.extensions = Some({
    let mut ext = PdfExportErrorDetails::default();
    ext.set("class", "ValidationError");
    ext.set("field", field);
    ext
  });
  err
}

pub(crate) fn document_metadata_export_error(
  validation: &myoxus_domain::entities::DocumentMetadataValidation,
) -> PdfExportError {
  let mut err = validation_error("document metadata block PDF export", "documentMetadata");
  if let Some(ext) = err.extensions.as_mut() {
    ext.set("code", DocumentMetadataValidationCode::DocumentExportBlocked.as_str());
    ext.set(
      "blockedActionsJson",
      serde_json::to_string(&validation.blocked_actions).unwrap_or_else(|_| "[]".to_string()),
    );
    ext.set(
      "validationJson",
      serde_json::to_string(validation).unwrap_or_else(|_| "{}".to_string()),
    );
  }
  err
}

pub(crate) fn json_time(value: Option<chrono::DateTime<chrono::Utc>>) -> serde_json::Value {
  value
    .map(|dt| serde_json::Value::String(dt.to_rfc3339()))
    .unwrap_or(serde_json::Value::Null)
}

pub(crate) fn document_version_snapshot(version: Option<&DocumentVersion>) -> serde_json::Value {
  match version {
    Some(version) => serde_json::json!({
      "versionId": version.id,
      "label": version.label,
      "kind": version.kind.as_str(),
      "event": version.event.as_str(),
      "isPinned": version.is_pinned,
      "isProtected": version.is_protected,
      "docHistoryId": version.doc_history_id,
      "createdAt": version.created_at.to_rfc3339(),
    }),
    None => serde_json::Value::Null,
  }
}

/// Build the renderer-facing document metadata snapshot with the same
/// camelCase field names as the public GraphQL contract. The source is the
/// native document metadata projection; `documentMetadata` remains only the
/// renderer-template input envelope, not an internal persistence model.
pub(crate) fn document_metadata_render_snapshot(
  projection: &myoxus_domain::entities::DocumentMetadataProjection,
  validation: &myoxus_domain::entities::DocumentMetadataValidation,
  version: Option<&DocumentVersion>,
) -> serde_json::Value {
  let status = reference_metadata_field_snapshot(projection, "status");
  let document_type = reference_metadata_field_snapshot(projection, "documentType");
  let classification = reference_metadata_field_snapshot(projection, "classification");
  let retention_policy = reference_metadata_field_snapshot(projection, "retentionPolicy");
  let language = metadata_field(projection, "language")
    .and_then(|field| field.reference.as_ref())
    .map(|reference| {
      serde_json::json!({
        "id": reference.id,
        "tag": reference.key,
        "key": reference.key,
        "label": reference.label,
      })
    })
    .unwrap_or(serde_json::Value::Null);
  let responsible = metadata_field(projection, "responsible")
    .and_then(|field| field.user_id)
    .map(|user_id| serde_json::json!([{ "kind": "user", "id": user_id }]))
    .unwrap_or_else(|| serde_json::json!([]));
  let audience = serde_json::Value::Array(
    projection
      .audience
      .iter()
      .map(|audience| reference_snapshot(&audience.value))
      .collect(),
  );
  serde_json::json!({
    "docId": projection.doc_id,
    "workspaceId": projection.workspace_id,
    "status": status,
    "documentType": document_type,
    "version": document_version_snapshot(version),
    "responsible": responsible,
    "reviewDueAt": json_time(timestamp_attribute(projection, "reviewDueAt")),
    "validFrom": json_time(timestamp_attribute(projection, "validFrom")),
    "validUntil": json_time(timestamp_attribute(projection, "validUntil")),
    "classification": classification,
    "documentNumber": text_attribute(projection, "documentNumber").map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
    "language": language,
    "audience": audience,
    "retentionPolicy": retention_policy,
    "validation": validation,
  })
}

pub(crate) fn metadata_field<'a>(
  projection: &'a myoxus_domain::entities::DocumentMetadataProjection,
  key: &str,
) -> Option<&'a myoxus_domain::entities::DocumentMetadataFieldValue> {
  projection.fields.iter().find(|field| field.key == key)
}

pub(crate) fn timestamp_attribute(
  projection: &myoxus_domain::entities::DocumentMetadataProjection,
  key: &str,
) -> Option<chrono::DateTime<chrono::Utc>> {
  metadata_field(projection, key).and_then(|field| field.timestamp_value)
}

pub(crate) fn text_attribute(
  projection: &myoxus_domain::entities::DocumentMetadataProjection,
  key: &str,
) -> Option<String> {
  metadata_field(projection, key).and_then(|field| field.text_value.clone())
}

pub(crate) fn reference_metadata_field_snapshot(
  projection: &myoxus_domain::entities::DocumentMetadataProjection,
  key: &str,
) -> serde_json::Value {
  metadata_field(projection, key)
    .and_then(|field| field.reference.as_ref())
    .map(reference_snapshot)
    .unwrap_or(serde_json::Value::Null)
}

pub(crate) fn reference_snapshot(
  reference: &myoxus_domain::entities::DocumentMetadataReferenceValue,
) -> serde_json::Value {
  serde_json::json!({
    "id": reference.id,
    "key": reference.key,
    "label": reference.label,
    "isActive": reference.is_active,
  })
}

#[cfg(test)]
mod tests {
  use super::{
    PdfExportDispatchInput, PdfThemeContext, PdfThemeFontAssetRef, build_l3_inputs, build_render_inputs,
    compute_render_inputs_hash, safe_sync_error_summary, validate_font_scale, validate_render_orientation,
    validate_render_paper_size,
  };

  use std::collections::BTreeMap;

  use myoxus_pdf_export::ir::{
    Branding, DEFAULT_BODY_FONT_SCALE, DEFAULT_HEADING_FONT_SCALE, ThemeFontSelection, ThemeTypographySelection,
    ThemeTypographyStyle,
  };
  use uuid::Uuid;

  /// PDFREV-SEC-03 — every stable error class must map to a deterministic
  /// summary, none of which leak the raw `detail` string. The set of classes
  /// mirrors `worker::pdf_export_handler::{ir,render}_error_to_class`.
  #[test]
  fn safe_summary_does_not_leak_detail_for_known_classes() {
    let renderer_detail_artifact = "syntax error at /tmp/render-12345.typ:42:7 (token 'foo')";
    for class in [
      "TooLarge",
      "Timeout",
      "RenderError",
      "DecodeError",
      "AssetError",
      "TemplateError",
      "StorageError",
      "UnsupportedComplianceProfile",
      "PdfaValidationFailed",
      "PdfuaValidationFailed",
    ] {
      let summary = safe_sync_error_summary(class);
      assert!(
        !summary.contains(renderer_detail_artifact),
        "{class} summary leaked an internal artifact"
      );
      assert!(
        !summary.contains('/'),
        "{class} summary contains a path-like character: {summary}"
      );
      assert!(
        summary.starts_with("pdf export"),
        "{class} summary should start with 'pdf export', got: {summary}"
      );
    }
  }

  #[test]
  fn safe_summary_falls_back_for_unknown_class() {
    let summary = safe_sync_error_summary("SomethingBrandNew");
    assert_eq!(summary, "pdf export failed");
  }

  #[test]
  fn orientation_and_global_font_scale_validation_are_closed_and_bounded() {
    assert_eq!(validate_render_paper_size("16:9").expect("widescreen"), "16:9");
    assert!(validate_render_paper_size("4:3").is_err());
    assert_eq!(validate_render_orientation("portrait").expect("portrait"), "portrait");
    assert_eq!(
      validate_render_orientation("landscape").expect("landscape"),
      "landscape"
    );
    assert!(validate_render_orientation("auto").is_err());
    assert_eq!(
      validate_font_scale("heading_font_scale", DEFAULT_HEADING_FONT_SCALE).expect("scale"),
      DEFAULT_HEADING_FONT_SCALE
    );
    assert!(validate_font_scale("body_font_scale", 0.49).is_err());
    assert!(validate_font_scale("body_font_scale", 1.51).is_err());
  }

  fn base_dispatch_input() -> PdfExportDispatchInput {
    PdfExportDispatchInput {
      workspace_id: Uuid::new_v4().to_string(),
      doc_id: Uuid::new_v4().to_string(),
      template_id: "default".into(),
      locale: Some("en".into()),
      paper_size: Some("A4".into()),
      orientation: Some("portrait".into()),
      heading_font_scale: Some(DEFAULT_HEADING_FONT_SCALE),
      body_font_scale: Some(DEFAULT_BODY_FONT_SCALE),
      image_quality: Some("high".into()),
      compliance_profile: Some("pdfa-2b".into()),
      color_profile: Some("CMYK_SWOP".into()),
      ligatures_enabled: Some(false),
      cover_page: Some(true),
      toc_behavior: Some("auto".into()),
      footer_style: None,
      page_numbering: None,
      color_variant: None,
      confidentiality_label: Some("Internal".into()),
      typed_inputs: Some(serde_json::json!({"department": "Finance"})),
      document_version_id: Some("latest".into()),
      resolved_document_version_id: Some(Uuid::new_v4().to_string()),
      version_label: Some("pdf-export-20260501-120000".into()),
      doc_history_id: Some(42),
      latest_idempotency_key: Some("latest-key".into()),
      document_metadata_snapshot: Some(serde_json::json!({
        "status": null,
        "documentType": null,
        "version": {
          "versionId": Uuid::new_v4(),
          "label": "pdf-export-20260501-120000",
          "kind": "exported",
          "event": "pdf_export",
          "isPinned": false,
          "isProtected": false
        },
        "classification": null
      })),
      metadata_validation: Some(
        serde_json::json!({"errors":[],"warnings":[],"blockedActions":[],"missingRequiredMetadataFields":[]}),
      ),
    }
  }

  fn asset(role: &str, family_slug: &str, family: &str) -> (String, PdfThemeFontAssetRef) {
    (
      role.to_owned(),
      PdfThemeFontAssetRef {
        family_slug: family_slug.to_owned(),
        family: family.to_owned(),
        asset_key: format!("fonts/{family_slug}.ttf"),
        sha256: format!("sha256-{family_slug}"),
        format: "ttf".to_owned(),
      },
    )
  }

  fn theme_context() -> PdfThemeContext {
    let mut font_assets = BTreeMap::new();
    for (role, asset) in [
      asset("heading", "lora", "Lora"),
      asset("body", "inter", "Inter"),
      asset("mono", "jetbrains-mono", "JetBrains Mono"),
      asset("symbol", "inter-symbols", "Inter"),
    ] {
      font_assets.insert(role, asset);
    }
    PdfThemeContext {
      fonts: ThemeFontSelection {
        heading: Some("Lora".into()),
        body: Some("Inter".into()),
        mono: Some("JetBrains Mono".into()),
        symbol: Some("Inter".into()),
      },
      typography: ThemeTypographySelection {
        heading: Some(ThemeTypographyStyle {
          font_weight: 600,
          font_style: "normal".into(),
          size_px: 32.0,
          line_height: 1.2,
          letter_spacing_em: -0.005,
          text_transform: "none".into(),
          decoration: "none".into(),
        }),
        body: Some(ThemeTypographyStyle {
          font_weight: 400,
          font_style: "normal".into(),
          size_px: 14.0,
          line_height: 1.55,
          letter_spacing_em: 0.0,
          text_transform: "none".into(),
          decoration: "none".into(),
        }),
        mono: Some(ThemeTypographyStyle {
          font_weight: 400,
          font_style: "normal".into(),
          size_px: 13.0,
          line_height: 1.55,
          letter_spacing_em: 0.0,
          text_transform: "none".into(),
          decoration: "none".into(),
        }),
        symbol: Some(ThemeTypographyStyle {
          font_weight: 400,
          font_style: "normal".into(),
          size_px: 13.0,
          line_height: 1.55,
          letter_spacing_em: 0.0,
          text_transform: "none".into(),
          decoration: "none".into(),
        }),
      },
      font_assets,
      branding: Branding {
        organization_name: Some("Forest Org".into()),
        footer_text: Some("Forest footer".into()),
        legal_text: Some("Forest legal".into()),
        logo_large_blob: Some("pdf-brand/workspace/logo-large".into()),
        logo_large_sha256: Some("sha-large".into()),
        logo_small_blob: Some("pdf-brand/workspace/logo-small".into()),
        logo_small_sha256: Some("sha-small".into()),
        color_policy: Some("custom".into()),
        color_palette_key: None,
        primary: Some("#184c32".into()),
        accent: Some("#2f6f4e".into()),
        rule: Some("#2f6f4e".into()),
        text_primary: Some("#152017".into()),
        background: Some("#f8f3e8".into()),
        code_background: Some("#e2dcd0".into()),
        ..Branding::default()
      },
      theme_slug: "forest-briefing".into(),
      native_table_palette: Some(BTreeMap::from([(
        "--myoxus-sem-status-success-paper".into(),
        myoxus_pdf_export::ir::NativeTablePaint {
          fill: "#c7e5d2".into(),
          foreground: "#000000".into(),
        },
      )])),
      profile_scope: "global".into(),
      default_paper_size: None,
      default_locale: None,
      default_color_profile: None,
      default_image_quality: None,
      ligatures_enabled: true,
    }
  }

  #[test]
  fn render_inputs_hash_changes_for_every_render_relevant_v2_field() {
    let doc_id = Uuid::new_v4();
    let base = base_dispatch_input();
    let base_hash = compute_render_inputs_hash(
      &doc_id,
      &base.template_id,
      &build_render_inputs(&base, &theme_context()),
    );

    let mutations: [fn(&mut PdfExportDispatchInput); 19] = [
      |i: &mut PdfExportDispatchInput| i.locale = Some("de".into()),
      |i: &mut PdfExportDispatchInput| i.paper_size = Some("Letter".into()),
      |i: &mut PdfExportDispatchInput| i.orientation = Some("landscape".into()),
      |i: &mut PdfExportDispatchInput| i.heading_font_scale = Some(0.8),
      |i: &mut PdfExportDispatchInput| i.body_font_scale = Some(0.82),
      |i: &mut PdfExportDispatchInput| i.image_quality = Some("lossless".into()),
      |i: &mut PdfExportDispatchInput| i.compliance_profile = Some("pdfua-1".into()),
      |i: &mut PdfExportDispatchInput| i.color_profile = Some("CMYK_FOGRA39".into()),
      |i: &mut PdfExportDispatchInput| i.ligatures_enabled = Some(true),
      |i: &mut PdfExportDispatchInput| i.cover_page = Some(false),
      |i: &mut PdfExportDispatchInput| i.toc_behavior = Some("force".into()),
      |i: &mut PdfExportDispatchInput| i.confidentiality_label = Some("Confidential".into()),
      |i: &mut PdfExportDispatchInput| i.typed_inputs = Some(serde_json::json!({"department": "Legal"})),
      |i: &mut PdfExportDispatchInput| i.document_version_id = Some(Uuid::new_v4().to_string()),
      |i: &mut PdfExportDispatchInput| i.resolved_document_version_id = Some(Uuid::new_v4().to_string()),
      |i: &mut PdfExportDispatchInput| i.version_label = Some("named-version".into()),
      |i: &mut PdfExportDispatchInput| i.doc_history_id = Some(84),
      |i: &mut PdfExportDispatchInput| i.latest_idempotency_key = Some("changed-key".into()),
      |i: &mut PdfExportDispatchInput| {
        i.document_metadata_snapshot = Some(serde_json::json!({"documentNumber":"DOC-2"}))
      },
    ];
    for mutate in mutations {
      let mut changed = base.clone();
      mutate(&mut changed);
      let changed_hash = compute_render_inputs_hash(
        &doc_id,
        &changed.template_id,
        &build_render_inputs(&changed, &theme_context()),
      );
      assert_ne!(base_hash, changed_hash);
    }
  }

  #[test]
  fn render_inputs_hash_changes_for_theme_context() {
    let doc_id = Uuid::new_v4();
    let base = base_dispatch_input();
    let base_hash = compute_render_inputs_hash(
      &doc_id,
      &base.template_id,
      &build_render_inputs(&base, &theme_context()),
    );
    let mut changed_context = theme_context();
    changed_context.fonts.heading = Some("Poppins".into());
    changed_context
      .font_assets
      .get_mut("heading")
      .expect("heading asset")
      .sha256 = "sha256-poppins".into();
    let changed_hash = compute_render_inputs_hash(
      &doc_id,
      &base.template_id,
      &build_render_inputs(&base, &changed_context),
    );
    assert_ne!(base_hash, changed_hash);

    let mut changed_typography = theme_context();
    changed_typography
      .typography
      .heading
      .as_mut()
      .expect("heading typography")
      .size_px = 38.0;
    let changed_typography_hash = compute_render_inputs_hash(
      &doc_id,
      &base.template_id,
      &build_render_inputs(&base, &changed_typography),
    );
    assert_ne!(base_hash, changed_typography_hash);

    let mut changed_display_style = theme_context();
    changed_display_style
      .typography
      .heading
      .as_mut()
      .expect("heading typography")
      .text_transform = "uppercase".into();
    let changed_display_style_hash = compute_render_inputs_hash(
      &doc_id,
      &base.template_id,
      &build_render_inputs(&base, &changed_display_style),
    );
    assert_ne!(base_hash, changed_display_style_hash);

    let mut changed_code_surface = theme_context();
    changed_code_surface.branding.code_background = Some("#d8dee5".into());
    let changed_code_surface_hash = compute_render_inputs_hash(
      &doc_id,
      &base.template_id,
      &build_render_inputs(&base, &changed_code_surface),
    );
    assert_ne!(base_hash, changed_code_surface_hash);

    let mut changed_palette = theme_context();
    changed_palette
      .native_table_palette
      .as_mut()
      .unwrap()
      .get_mut("--myoxus-sem-status-success-paper")
      .unwrap()
      .fill = "#def4e7".into();
    assert_ne!(
      base_hash,
      compute_render_inputs_hash(
        &doc_id,
        &base.template_id,
        &build_render_inputs(&base, &changed_palette)
      )
    );
    assert_ne!(
      super::effective_pdf_render_appearance_hash(&theme_context()),
      super::effective_pdf_render_appearance_hash(&changed_palette)
    );
  }

  #[test]
  fn render_inputs_use_calibrated_font_scales_when_the_dispatch_omits_them() {
    let mut input = base_dispatch_input();
    input.heading_font_scale = None;
    input.body_font_scale = None;

    let render_inputs = build_render_inputs(&input, &theme_context());

    assert_eq!(render_inputs["heading_font_scale"], DEFAULT_HEADING_FONT_SCALE);
    assert_eq!(render_inputs["body_font_scale"], DEFAULT_BODY_FONT_SCALE);
  }

  #[test]
  fn render_inputs_include_full_document_branding_and_pdf_policy() {
    let render_inputs = build_render_inputs(&base_dispatch_input(), &theme_context());

    assert_eq!(render_inputs["color_profile"], "CMYK_SWOP");
    assert_eq!(render_inputs["orientation"], "portrait");
    assert_eq!(render_inputs["heading_font_scale"], DEFAULT_HEADING_FONT_SCALE);
    assert_eq!(render_inputs["body_font_scale"], DEFAULT_BODY_FONT_SCALE);
    assert_eq!(render_inputs["compliance_profile"], "pdfa-2b");
    assert_eq!(render_inputs["ligatures_enabled"], false);
    assert_eq!(
      render_inputs["native_table_palette"]["--myoxus-sem-status-success-paper"]["fill"],
      "#c7e5d2"
    );
    assert_eq!(render_inputs["theme_typography"]["heading"]["font_weight"], 600);
    assert_eq!(render_inputs["theme_typography"]["heading"]["size_px"], 32.0);
    assert_eq!(render_inputs["theme_typography"]["body"]["line_height"], 1.55);
    assert_eq!(render_inputs["document_branding"]["organization_name"], "Forest Org");
    assert_eq!(render_inputs["document_branding"]["footer_text"], "Forest footer");
    assert_eq!(render_inputs["document_branding"]["legal_text"], "Forest legal");
    assert_eq!(
      render_inputs["document_branding"]["logo_large_blob"],
      "pdf-brand/workspace/logo-large"
    );
    assert_eq!(render_inputs["document_branding"]["logo_large_sha256"], "sha-large");
    assert_eq!(
      render_inputs["document_branding"]["logo_small_blob"],
      "pdf-brand/workspace/logo-small"
    );
    assert_eq!(render_inputs["document_branding"]["logo_small_sha256"], "sha-small");
    assert_eq!(render_inputs["document_branding"]["color_policy"], "custom");
    assert_eq!(
      render_inputs["document_branding"]["color_palette_key"],
      serde_json::Value::Null
    );
    assert_eq!(render_inputs["document_branding"]["primary"], "#184c32");
    assert_eq!(render_inputs["document_branding"]["accent"], "#2f6f4e");
    assert_eq!(render_inputs["document_branding"]["rule"], "#2f6f4e");
    assert_eq!(render_inputs["document_branding"]["code_background"], "#e2dcd0");
  }

  #[test]
  fn audit_l3_inputs_uses_only_v2_field_names() {
    let l3 = build_l3_inputs(&base_dispatch_input(), &theme_context());
    for key in [
      "locale",
      "paper_size",
      "image_quality",
      "compliance_profile",
      "color_profile",
      "ligatures_enabled",
      "cover_page",
      "toc_behavior",
      "confidentiality_label",
      "documentMetadata",
      "attributeValidation",
      "theme_fonts",
      "theme_typography",
      "theme_font_assets",
      "native_table_palette",
      "document_branding",
      "theme_slug",
      "theme_profile_scope",
    ] {
      assert!(l3.get(key).is_some(), "missing V2 key {key} in {l3}");
    }
    let old_page_key = ["page", "format"].join("_");
    let old_toc_key = ["include", "toc"].join("_");
    let old_body_font_key = ["body", "font", "family"].join("_");
    for old_key in [
      "language",
      old_page_key.as_str(),
      old_toc_key.as_str(),
      "template_id",
      old_body_font_key.as_str(),
      "theme_branding",
      "branding_profile_scope",
      "document_version_selector",
      "document_version_id",
      "version_label",
      "doc_history_id",
      "latest_idempotency_key",
    ] {
      assert!(l3.get(old_key).is_none(), "unexpected old/non-L3 key {old_key} in {l3}");
    }
  }
}
