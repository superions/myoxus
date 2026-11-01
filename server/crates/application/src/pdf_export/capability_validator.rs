// SPDX-License-Identifier: AGPL-3.0-or-later
//! L3-input validator (`P-PDF-TPL-11-04`).
//!
//! When the `exportPdf` mutation receives a [`PdfExportInputV2`], the
//! server must check that every set field corresponds to an active
//! capability declared by the template's manifest. Two failure modes:
//!
//! 1. **Capability off, field set** — e.g. `confidentiality_label =
//!    Some("Internal")` against a manifest whose
//!    `confidentialityLabels.max_items == 0`. The export refuses with
//!    [`CapabilityViolation::CapabilityDisabled`].
//! 2. **Capability on, value out of range** — e.g.
//!    `toc_behavior = Some("hard")` against a manifest whose
//!    `tocBehavior.values` is `["off", "auto", "force"]`. Refuses with
//!    [`CapabilityViolation::ValueNotAllowed`].
//!
//! The validator runs **before** the render is dispatched so doomed
//! exports never reach the worker.

use serde::Serialize;
use thiserror::Error;
use tracing::instrument;

use myoxus_domain::pdf_template_manifest::{PdfPaperSize, PdfTemplateManifest, PdfTocBehavior};

use super::render_context::PdfExportInputV2;

/// One specific capability mismatch the validator caught.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
pub enum CapabilityViolation {
  /// The L3 input set a field but the manifest's capability is off
  /// (e.g. `coverPage.default == false` and the matrix is boolean,
  /// or `confidentialityLabels.max_items == 0`).
  #[error("input field `{field}` is not enabled by the template (capability disabled)")]
  CapabilityDisabled { field: &'static str },

  /// The L3 value is not in the manifest's allowed enum set.
  #[error("input field `{field}` value `{value}` is not in the template's allowed set {allowed:?}")]
  ValueNotAllowed {
    field: &'static str,
    value: String,
    allowed: Vec<String>,
  },

  /// The locale on the input is not declared by the manifest.
  #[error("input locale `{locale}` is not declared by the template")]
  LocaleNotDeclared { locale: String },

  /// `typed_inputs` failed validation against the manifest's
  /// `inputs_schema`. Each entry in `errors` is a structured
  /// JSON-Schema violation pinpointing the offending field with a
  /// JSON-Pointer path. `P-PDF-TPL-11-FOLLOWUP-01`.
  #[error("typed_inputs failed JSON-Schema validation: {errors:?}")]
  TypedInputsSchemaFailed {
    errors: Vec<super::typed_inputs_validator::SchemaViolation>,
  },
}

/// Validate every L3 field on `input` against `manifest`. Returns the
/// list of violations (empty when input is acceptable). The renderer
/// must abort if the list is non-empty.
#[instrument(skip(input, manifest), fields(template_id = %manifest.id))]
pub fn validate_inputs_against_manifest(
  input: &PdfExportInputV2,
  manifest: &PdfTemplateManifest,
) -> Vec<CapabilityViolation> {
  let mut violations = Vec::new();

  // ── Cover page (boolean capability — by-design always toggleable) ───────
  //
  // `coverPage` is declared as `CapabilityBoolean { kind, default }` in
  // the manifest schema. Per `LRN-V2-PDF-LAYERS` the boolean kind always
  // permits either value at render time — `default` only declares which
  // value applies when the L3 input is `None`. There is no schema
  // mechanism to express "boolean cap pinned to one value"; expressing
  // that would require a 3-state enum (`off|on|locked`), which is a
  // deliberate non-feature (the manifest's `customMargins` capability
  // works the same way).
  //
  // We log at trace level when the input flips the default so render
  // forensics can correlate `pdf_export_render_audit.l3_inputs.cover_page`
  // entries against the manifest snapshot. The validator emits no
  // violation: a `cover_page = Some(_)` against a manifest whose
  // capability key is present (always required by the schema's
  // `deny_unknown_fields`) is by-design accepted.
  if let Some(req) = input.cover_page {
    let capability_default = manifest.capabilities.cover_page.default;
    if capability_default != req {
      tracing::trace!(
        manifest_default = capability_default,
        requested = req,
        "input.cover_page overrides manifest default (boolean capability supports both)"
      );
    }
  }

  // ── Image quality (L1-Brand override — not an L2 capability) ────────────
  //
  // `image_quality` is intentionally NOT a manifest capability — it is
  // an L1-Brand-Workspace-Default-Override per the V2 architecture
  // (`docs/dev/server/pdf-export-v2-architecture.md §1`). The L3 input
  // value is normalised by the GraphQL layer (`parse_image_quality` in
  // `crates/api/src/graphql/pdf_export.rs`) and applied by the renderer
  // when the workspace's `default_image_quality` setting allows it.
  //
  // A trace log makes the intent visible in render audits; no
  // violation is emitted because no manifest contract is being
  // checked here.
  if let Some(quality) = input.image_quality {
    tracing::trace!(
      ?quality,
      "input.image_quality is an L1-Brand override; no L2 capability check applies"
    );
  }

  // ── Paper size (optional L2 capability over the L1 default) ─────────────
  //
  // Deployed manifests without `paperSize` retain the renderer's historical
  // choices. A manifest that declares the capability narrows those choices,
  // so an unsupported explicit or effective value never reaches dispatch.
  if let Some(paper) = input.paper_size.as_deref() {
    if let Some(capability) = manifest.capabilities.paper_size.as_ref() {
      let allowed = capability
        .values
        .iter()
        .map(PdfPaperSize::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
      if !allowed.iter().any(|value| value == paper) {
        violations.push(CapabilityViolation::ValueNotAllowed {
          field: "paper_size",
          value: paper.to_owned(),
          allowed,
        });
      }
    }
  }

  // ── Compliance profile (renderer/output contract) ──────────────────────
  //
  // PDF/A and PDF/UA are produced by the final PDF writer, not by a single
  // template feature. The GraphQL/API boundary validates the accepted profile
  // literals and the renderer maps them to `typst-pdf` native standards, so
  // this manifest validator only records the intent for trace-level forensics.
  if let Some(profile) = input.compliance_profile.as_deref() {
    tracing::trace!(
      compliance_profile = profile,
      "input.compliance_profile is a renderer standards override; no L2 capability check applies"
    );
  }

  // ── TOC behavior (enum capability) ───────────────────────────────────────
  if let Some(value) = input.toc_behavior.as_deref() {
    let allowed: Vec<String> = manifest
      .capabilities
      .toc_behavior
      .values
      .iter()
      .map(PdfTocBehavior::as_str)
      .map(str::to_owned)
      .collect();
    if !allowed.iter().any(|v| v == value) {
      violations.push(CapabilityViolation::ValueNotAllowed {
        field: "toc_behavior",
        value: value.to_owned(),
        allowed,
      });
    }
  }

  // Validate the same closed capability lists exposed by the export form.
  for (field, value, allowed) in [
    (
      "footer_style",
      input.footer_style.as_deref(),
      manifest
        .capabilities
        .footer_style
        .values
        .iter()
        .map(|v| v.as_str().to_owned())
        .collect::<Vec<_>>(),
    ),
    (
      "page_numbering",
      input.page_numbering.as_deref(),
      manifest
        .capabilities
        .page_numbering
        .values
        .iter()
        .map(|v| v.as_str().to_owned())
        .collect::<Vec<_>>(),
    ),
    (
      "color_variant",
      input.color_variant.as_deref(),
      manifest
        .capabilities
        .color_variant
        .values
        .iter()
        .map(|v| v.as_str().to_owned())
        .collect::<Vec<_>>(),
    ),
  ] {
    if let Some(value) = value {
      if !allowed.iter().any(|v| v == value) {
        violations.push(CapabilityViolation::ValueNotAllowed {
          field,
          value: value.to_owned(),
          allowed,
        });
      }
    }
  }

  // ── Confidentiality label (array<string> capability) ─────────────────────
  if let Some(label) = input.confidentiality_label.as_deref() {
    let cap = &manifest.capabilities.confidentiality_labels;
    if cap.max_items == 0 {
      // Capability switched off — the template author opted out of
      // classification banners. Refuse the field entirely.
      violations.push(CapabilityViolation::CapabilityDisabled {
        field: "confidentiality_label",
      });
    } else {
      let allowed = &cap.default;
      if !allowed.iter().any(|v| v == label) {
        violations.push(CapabilityViolation::ValueNotAllowed {
          field: "confidentiality_label",
          value: label.to_owned(),
          allowed: allowed.clone(),
        });
      }
    }
  }

  // ── typed_inputs against manifest.inputs_schema (FOLLOWUP-01) ───────────
  //
  // The manifest's `inputs_schema` is a JSON-Schema fragment that
  // describes the shape of valid `typed_inputs` payloads (e.g. the
  // default template requires `{"title": <non-empty string ≤ 200 chars>}`).
  // Without this guard a client could send arbitrary JSON to a template
  // that expects a specific shape — the renderer would then either
  // reject at template-compile time (loud failure, but late) or silently
  // produce garbage (silent failure, worst).
  //
  // We skip when:
  //   * the manifest declares an empty schema (`{}`) or has no
  //     `inputs_schema` key — the contract is "any JSON is fine";
  //   * `typed_inputs` is `Null` and the schema doesn't require an
  //     object root — no submitted typed inputs is fine for templates
  //     that don't need them.
  // Otherwise every JSON-Schema violation surfaces individually so the
  // GraphQL surface can render a structured client-side error.
  if !is_empty_schema(&manifest.inputs_schema) {
    let payload = if matches!(input.typed_inputs, serde_json::Value::Null) {
      &serde_json::json!({})
    } else {
      &input.typed_inputs
    };
    let schema_violations = super::typed_inputs_validator::validate(&manifest.inputs_schema, payload);
    if !schema_violations.is_empty() {
      violations.push(CapabilityViolation::TypedInputsSchemaFailed {
        errors: schema_violations,
      });
    }
  }

  // ── Locale ──────────────────────────────────────────────────────────────
  if let Some(locale) = input.locale.as_deref() {
    let declared: &[String] = &manifest.capabilities.language.values;
    if !declared.iter().any(|v| v == locale) {
      // Allow narrow→broad fallback (de-AT → de) so regional variants
      // don't get rejected. The render context's locale resolver
      // applies the fallback at render time; the validator just
      // mirrors that semantics.
      let base = locale.split('-').next().unwrap_or(locale);
      if base == locale || !declared.iter().any(|v| v == base) {
        violations.push(CapabilityViolation::LocaleNotDeclared {
          locale: locale.to_owned(),
        });
      }
    }
  }

  violations
}

/// Detect "no constraints" `inputs_schema` so the validator can short-circuit.
///
/// Treats both an empty object (`{}`) and a `{"type":"object","properties":{}}`-shape
/// without `required` as "anything goes". Anything else — even if all
/// properties happen to be optional — runs through the validator so
/// the schema author's intent is honoured.
fn is_empty_schema(schema: &serde_json::Value) -> bool {
  let serde_json::Value::Object(map) = schema else {
    return true; // null / non-object schema = no constraints
  };
  if map.is_empty() {
    return true;
  }
  // `{"type":"object"}` alone with no `properties`, no `required`, no
  // bounds — also a contractless schema.
  if map.len() == 1 && map.get("type").and_then(serde_json::Value::as_str) == Some("object") {
    return true;
  }
  false
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use uuid::Uuid;

  /// Build a manifest with the project's default capability matrix and
  /// optional overrides. Driven by JSON deserialise so we never have to
  /// chase typed-enum changes in this fixture.
  fn manifest_with_overrides(overrides: serde_json::Value) -> PdfTemplateManifest {
    let mut base = serde_json::json!({
      "schema_version": "2.0",
      "id": "tpl-cap-test",
      "name": "Cap Test",
      "description": "",
      "version": "1.0.0",
      "engine": { "name": "typst", "version": "0.15.x" },
      "provenance": {
        "license_spdx": "AGPL-3.0-or-later",
        "copyright_notice": "Copyright 2026 Myoxus test contributors",
        "source_url": "https://example.test/templates/capability-test",
        "source_revision": "1.0.0"
      },
      "entry": "main.typ",
      "assets": ["main.typ"],
      "capabilities": {
        "colorVariant":   { "kind": "enum", "values": ["mono","accent","brand"], "default": "mono" },
        "headerStyle":    { "kind": "enum", "values": ["none","minimal","branded"], "default": "minimal" },
        "footerStyle":    { "kind": "enum", "values": ["none","minimal","page-only","brand-and-page"], "default": "page-only" },
        "coverPage":      { "kind": "boolean", "default": false },
        "tocBehavior":    { "kind": "enum", "values": ["off","auto","force"], "default": "off" },
        "pageNumbering":  { "kind": "enum", "values": ["arabic","roman","none"], "default": "arabic" },
        "customMargins":  { "kind": "boolean", "default": false },
        "accentColor":    { "kind": "color", "default": "#1F2937" },
        "confidentialityLabels": {
          "kind": "array<string>", "min_items": 0, "max_items": 0,
          "item_pattern": "^.*$", "default": []
        },
        "language": { "kind": "enum", "values": ["en","de"], "default": "en" }
      },
      "inputs_schema": {"type":"object","additionalProperties":false,"properties":{}}
    });
    if let serde_json::Value::Object(ref overrides) = overrides {
      let caps = base["capabilities"].as_object_mut().expect("capabilities");
      for (k, v) in overrides {
        caps.insert(k.clone(), v.clone());
      }
    }
    serde_json::from_value(base).expect("manifest deserialise")
  }

  fn input_with_label(label: &str) -> PdfExportInputV2 {
    PdfExportInputV2 {
      workspace_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      template_id: Uuid::new_v4(),
      locale: None,
      paper_size: None,
      image_quality: None,
      compliance_profile: None,
      cover_page: None,
      toc_behavior: None,
      footer_style: None,
      page_numbering: None,
      color_variant: None,
      confidentiality_label: Some(label.into()),
      typed_inputs: serde_json::Value::Null,
    }
  }

  /// `INV-EXP-02` (`P-PDF-TPL-11-08`): a `confidentiality_label` input
  /// against a manifest whose `confidentialityLabels.max_items == 0` is
  /// rejected as `CapabilityDisabled`.
  #[test]
  fn inv_exp02_classification_field_rejected_when_capability_off() {
    let manifest = manifest_with_overrides(serde_json::json!({}));
    let input = input_with_label("Internal");
    let violations = validate_inputs_against_manifest(&input, &manifest);
    assert!(
      violations.iter().any(|v| matches!(
        v,
        CapabilityViolation::CapabilityDisabled { field } if *field == "confidentiality_label"
      )),
      "INV-EXP-02: classification field must be rejected when capability is off; got {violations:?}"
    );
  }

  /// When the capability is enabled (`max_items > 0` and
  /// `default` includes the requested value), the input is accepted.
  #[test]
  fn classification_field_accepted_when_value_in_set() {
    let manifest = manifest_with_overrides(serde_json::json!({
      "confidentialityLabels": {
        "kind": "array<string>", "min_items": 0, "max_items": 8,
        "item_pattern": "^[A-Za-z0-9 _-]{1,32}$",
        "default": ["Internal", "Confidential", "Restricted"]
      }
    }));
    let input = input_with_label("Internal");
    let violations = validate_inputs_against_manifest(&input, &manifest);
    assert!(
      violations.is_empty(),
      "expected acceptance, got violations {violations:?}"
    );
  }

  /// A value outside the manifest's `default` set is rejected as
  /// `ValueNotAllowed`.
  #[test]
  fn classification_field_rejected_when_value_not_in_set() {
    let manifest = manifest_with_overrides(serde_json::json!({
      "confidentialityLabels": {
        "kind": "array<string>", "min_items": 0, "max_items": 8,
        "item_pattern": "^[A-Za-z0-9 _-]{1,32}$",
        "default": ["Internal"]
      }
    }));
    let input = input_with_label("TopSecret");
    let violations = validate_inputs_against_manifest(&input, &manifest);
    assert!(violations.iter().any(|v| matches!(
      v,
      CapabilityViolation::ValueNotAllowed { field, value, .. }
        if *field == "confidentiality_label" && value == "TopSecret"
    )));
  }

  /// TOC value outside the enum set is rejected.
  #[test]
  fn toc_behavior_value_must_be_in_manifest_enum() {
    let manifest = manifest_with_overrides(serde_json::json!({}));
    let mut input = PdfExportInputV2 {
      workspace_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      template_id: Uuid::new_v4(),
      locale: None,
      paper_size: None,
      image_quality: None,
      compliance_profile: None,
      cover_page: None,
      toc_behavior: Some("hard".into()),
      footer_style: None,
      page_numbering: None,
      color_variant: None,
      confidentiality_label: None,
      typed_inputs: serde_json::Value::Null,
    };
    let violations = validate_inputs_against_manifest(&input, &manifest);
    assert!(violations.iter().any(|v| matches!(
      v,
      CapabilityViolation::ValueNotAllowed { field, .. } if *field == "toc_behavior"
    )));
    // Valid value passes.
    input.toc_behavior = Some("auto".into());
    assert!(validate_inputs_against_manifest(&input, &manifest).is_empty());
  }

  /// Locale that the manifest doesn't declare is rejected; narrow→broad
  /// fallback works (`de-AT` accepted because `de` is declared).
  #[test]
  fn locale_validates_against_manifest_with_broad_fallback() {
    let manifest = manifest_with_overrides(serde_json::json!({}));
    let mut input = PdfExportInputV2 {
      workspace_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      template_id: Uuid::new_v4(),
      locale: Some("zh".into()),
      paper_size: None,
      image_quality: None,
      compliance_profile: None,
      cover_page: None,
      toc_behavior: None,
      footer_style: None,
      page_numbering: None,
      color_variant: None,
      confidentiality_label: None,
      typed_inputs: serde_json::Value::Null,
    };
    let violations = validate_inputs_against_manifest(&input, &manifest);
    assert!(
      violations
        .iter()
        .any(|v| matches!(v, CapabilityViolation::LocaleNotDeclared { .. }))
    );

    input.locale = Some("de-AT".into());
    let v = validate_inputs_against_manifest(&input, &manifest);
    assert!(v.is_empty(), "de-AT must pass via narrow→broad fallback: {v:?}");
  }

  /// `cover_page` toggle is by-design accepted in either state — the
  /// boolean capability does not pin one value. This test documents that
  /// invariant so the semantics survive a future schema migration that
  /// adds a 3-state capability variant.
  #[test]
  fn cover_page_toggle_accepted_regardless_of_manifest_default() {
    let manifest = manifest_with_overrides(serde_json::json!({
      "coverPage": { "kind": "boolean", "default": false }
    }));
    for &requested in &[true, false] {
      let input = PdfExportInputV2 {
        workspace_id: Uuid::new_v4(),
        doc_id: Uuid::new_v4(),
        template_id: Uuid::new_v4(),
        locale: None,
        paper_size: None,
        image_quality: None,
        compliance_profile: None,
        cover_page: Some(requested),
        toc_behavior: None,
        footer_style: None,
        page_numbering: None,
        color_variant: None,
        confidentiality_label: None,
        typed_inputs: serde_json::Value::Null,
      };
      let v = validate_inputs_against_manifest(&input, &manifest);
      assert!(
        v.is_empty(),
        "cover_page = {requested} against manifest default = false must pass: {v:?}"
      );
    }
  }

  // ── typed_inputs JSON-Schema validation (FOLLOWUP-01) ──────────────────

  fn manifest_with_inputs_schema(inputs_schema: serde_json::Value) -> PdfTemplateManifest {
    let mut base = serde_json::json!({
      "schema_version": "2.0",
      "id": "tpl-typed-inputs",
      "name": "Typed Inputs Test",
      "description": "",
      "version": "1.0.0",
      "engine": { "name": "typst", "version": "0.15.x" },
      "provenance": {
        "license_spdx": "AGPL-3.0-or-later",
        "copyright_notice": "Copyright 2026 Myoxus test contributors",
        "source_url": "https://example.test/templates/inputs-test",
        "source_revision": "1.0.0"
      },
      "entry": "main.typ",
      "assets": ["main.typ"],
      "capabilities": {
        "colorVariant":   { "kind": "enum", "values": ["mono"], "default": "mono" },
        "headerStyle":    { "kind": "enum", "values": ["minimal"], "default": "minimal" },
        "footerStyle":    { "kind": "enum", "values": ["page-only"], "default": "page-only" },
        "coverPage":      { "kind": "boolean", "default": false },
        "tocBehavior":    { "kind": "enum", "values": ["off"], "default": "off" },
        "pageNumbering":  { "kind": "enum", "values": ["arabic"], "default": "arabic" },
        "customMargins":  { "kind": "boolean", "default": false },
        "accentColor":    { "kind": "color", "default": "#000000" },
        "confidentialityLabels": {
          "kind": "array<string>", "min_items": 0, "max_items": 0,
          "item_pattern": "^.*$", "default": []
        },
        "language": { "kind": "enum", "values": ["en"], "default": "en" }
      },
      "inputs_schema": inputs_schema,
    });
    let _ = &mut base; // suppress mut-warning in case JSON layout changes
    serde_json::from_value(base).expect("manifest deserialise")
  }

  fn input_with_typed(typed: serde_json::Value) -> PdfExportInputV2 {
    PdfExportInputV2 {
      workspace_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      template_id: Uuid::new_v4(),
      locale: None,
      paper_size: None,
      image_quality: None,
      compliance_profile: None,
      cover_page: None,
      toc_behavior: None,
      footer_style: None,
      page_numbering: None,
      color_variant: None,
      confidentiality_label: None,
      typed_inputs: typed,
    }
  }

  /// Empty `inputs_schema` → no validation, every typed_inputs is accepted.
  #[test]
  fn typed_inputs_unrestricted_when_schema_is_empty() {
    let manifest = manifest_with_inputs_schema(serde_json::json!({}));
    let input = input_with_typed(serde_json::json!({ "anything": "goes", "nested": [1, 2, 3] }));
    assert!(validate_inputs_against_manifest(&input, &manifest).is_empty());
  }

  /// A required-key constraint that's satisfied → pass.
  #[test]
  fn typed_inputs_pass_when_schema_satisfied() {
    let manifest = manifest_with_inputs_schema(serde_json::json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["title"],
      "properties": {
        "title": { "type": "string", "minLength": 1, "maxLength": 200 }
      }
    }));
    let input = input_with_typed(serde_json::json!({ "title": "Hello" }));
    let v = validate_inputs_against_manifest(&input, &manifest);
    assert!(v.is_empty(), "expected pass, got {v:?}");
  }

  /// Missing required property → `TypedInputsSchemaFailed` carrying a
  /// `MissingRequired` violation.
  #[test]
  fn typed_inputs_reject_missing_required() {
    let manifest = manifest_with_inputs_schema(serde_json::json!({
      "type": "object",
      "required": ["title"],
      "properties": { "title": { "type": "string" } }
    }));
    let input = input_with_typed(serde_json::json!({}));
    let v = validate_inputs_against_manifest(&input, &manifest);
    assert!(v.iter().any(|cv| matches!(
      cv,
      CapabilityViolation::TypedInputsSchemaFailed { errors }
        if errors.iter().any(|e| matches!(
          e,
          super::super::typed_inputs_validator::SchemaViolation::MissingRequired { property, .. } if property == "title"
        ))
    )), "expected MissingRequired for `title`, got {v:?}");
  }

  /// `additionalProperties: false` rejects unknown keys.
  #[test]
  fn typed_inputs_reject_additional_property() {
    let manifest = manifest_with_inputs_schema(serde_json::json!({
      "type": "object",
      "additionalProperties": false,
      "properties": { "title": { "type": "string" } }
    }));
    let input = input_with_typed(serde_json::json!({ "title": "x", "rogue": "y" }));
    let v = validate_inputs_against_manifest(&input, &manifest);
    assert!(
      v.iter().any(|cv| matches!(
        cv,
        CapabilityViolation::TypedInputsSchemaFailed { errors }
          if errors.iter().any(|e| matches!(
            e,
            super::super::typed_inputs_validator::SchemaViolation::AdditionalPropertyForbidden { property, .. }
              if property == "rogue"
          ))
      )),
      "expected AdditionalPropertyForbidden for `rogue`, got {v:?}"
    );
  }

  /// Null typed_inputs against a schema that requires fields → still
  /// validated (treated as `{}`) so the missing field surfaces.
  #[test]
  fn null_typed_inputs_validates_as_empty_object() {
    let manifest = manifest_with_inputs_schema(serde_json::json!({
      "type": "object",
      "required": ["title"],
      "properties": { "title": { "type": "string" } }
    }));
    let input = input_with_typed(serde_json::Value::Null);
    let v = validate_inputs_against_manifest(&input, &manifest);
    assert!(
      v.iter()
        .any(|cv| matches!(cv, CapabilityViolation::TypedInputsSchemaFailed { .. })),
      "null typed_inputs must trigger schema validation when schema is non-empty: {v:?}"
    );
  }

  /// Legacy manifests without `paperSize` keep the established renderer
  /// choices, while image quality remains an unconditional L1 override.
  #[test]
  fn absent_paper_size_capability_preserves_legacy_choices() {
    let manifest = manifest_with_overrides(serde_json::json!({}));
    let input = PdfExportInputV2 {
      workspace_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      template_id: Uuid::new_v4(),
      locale: None,
      paper_size: Some("A3".into()),
      image_quality: Some(super::super::render_context::ImageQuality::Lossless),
      compliance_profile: Some("pdfa-2b".into()),
      cover_page: None,
      toc_behavior: None,
      footer_style: None,
      page_numbering: None,
      color_variant: None,
      confidentiality_label: None,
      typed_inputs: serde_json::Value::Null,
    };
    let v = validate_inputs_against_manifest(&input, &manifest);
    assert!(
      v.is_empty(),
      "an absent paper-size capability must preserve deployed manifests: {v:?}"
    );
  }

  #[test]
  fn declared_paper_size_capability_rejects_unsupported_effective_format() {
    let manifest = manifest_with_overrides(serde_json::json!({
      "paperSize": { "kind": "enum", "values": ["A4", "16:9"], "default": "16:9" }
    }));
    let mut input = input_with_label("");
    input.confidentiality_label = None;
    input.paper_size = Some("Letter".into());
    let violations = validate_inputs_against_manifest(&input, &manifest);
    assert!(violations.iter().any(|violation| matches!(
      violation,
      CapabilityViolation::ValueNotAllowed { field: "paper_size", value, allowed }
        if value == "Letter" && allowed == &["A4".to_owned(), "16:9".to_owned()]
    )));
  }
}
