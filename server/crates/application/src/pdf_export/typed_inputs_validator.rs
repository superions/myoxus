// SPDX-License-Identifier: AGPL-3.0-or-later
//! `P-PDF-TPL-11-FOLLOWUP-01`: JSON-Schema validator for the V2 export
//! mutation's `typed_inputs` field.
//!
//! When a workspace member submits a `PdfExportInputV2` to `exportPdf`,
//! the `typed_inputs` payload is a free-form `serde_json::Value` that
//! must satisfy the template manifest's `inputs_schema`. Without
//! validation a client can send arbitrary JSON, the renderer interprets
//! it however it wants, and the audit trail records garbage that
//! looks intentional.
//!
//! ## Why a custom validator
//!
//! The PDF-Export-V2 manifest only uses a small, fixed subset of
//! JSON-Schema (`type`, `enum`, `const`, `minLength`/`maxLength`,
//! `minimum`/`maximum`, `minItems`/`maxItems`, `items`, `properties`,
//! `required`, `additionalProperties: false`, `format: "date"`). The full
//! `jsonschema-0.18` crate would pull `fraction`, `iso8601`, `num-cmp`
//! and several other transitive dependencies that bloat the lockfile
//! and slow CI without buying us anything we use.
//!
//! This validator implements exactly the construct subset the manifest
//! schema demands. Anything else (`$ref`, `allOf`/`anyOf`/`oneOf`,
//! `pattern`, formats other than `date`) is **deliberately unsupported** and surfaces as a
//! [`SchemaViolation::UnsupportedSchemaConstruct`] so the caller knows
//! the manifest is asking for a feature the validator does not
//! cover — better than silently accepting input that should have been
//! rejected.
//!
//! Mirrors the design of the test-internal validator in
//! `crates/pdf_export_templates/tests/manifest_schema.rs` but lives
//! in the `application` crate so the V2 mutation can call it.

use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

const MAX_SCHEMA_RECURSION_DEPTH: usize = 32;

/// One specific reason the `typed_inputs` payload was rejected.
///
/// Serializable so the GraphQL surface can attach the structured list
/// to `extensions.violationsJson` for client display without
/// re-formatting.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "kind")]
pub enum SchemaViolation {
  /// The instance value's runtime type does not match the schema's
  /// `type` keyword. `path` points at the offending location in the
  /// instance using JSON-Pointer syntax (e.g. `/title`,
  /// `/recipients/2/name`).
  #[error("type mismatch at `{path}`: schema expects `{expected}`, got `{actual}`")]
  TypeMismatch {
    path: String,
    expected: String,
    actual: String,
  },

  /// A `required` property was missing from an object.
  #[error("missing required property `{property}` at `{path}`")]
  MissingRequired { path: String, property: String },

  /// A property was present but the schema's
  /// `additionalProperties: false` forbids unknown keys.
  #[error("unknown property `{property}` at `{path}` (additionalProperties = false)")]
  AdditionalPropertyForbidden { path: String, property: String },

  /// The instance string was shorter or longer than the schema allows.
  #[error("string length out of range at `{path}`: {actual} not in [{min:?}, {max:?}]")]
  StringLengthOutOfRange {
    path: String,
    actual: usize,
    min: Option<usize>,
    max: Option<usize>,
  },

  /// A date string must be a real ISO calendar date, not merely date-shaped.
  #[error("invalid `{format}` string at `{path}`")]
  InvalidStringFormat { path: String, format: String },

  /// The instance number was outside the schema's `minimum` /
  /// `maximum` (or `exclusiveMinimum` / `exclusiveMaximum`) bounds.
  #[error("number out of range at `{path}`: {actual} not in {bounds}")]
  NumberOutOfRange {
    path: String,
    actual: String,
    bounds: String,
  },

  /// The instance array had fewer or more items than the schema allows.
  #[error("array length out of range at `{path}`: {actual} not in [{min:?}, {max:?}]")]
  ArrayLengthOutOfRange {
    path: String,
    actual: usize,
    min: Option<usize>,
    max: Option<usize>,
  },

  /// The instance value was not a member of the schema's `enum` set.
  #[error("value at `{path}` is not in the schema's enum: {value} not in {allowed}")]
  EnumMismatch {
    path: String,
    value: String,
    allowed: String,
  },

  /// The instance value did not match the schema's `const`.
  #[error("value at `{path}` does not match the schema const: expected {expected}, got {actual}")]
  ConstMismatch {
    path: String,
    expected: String,
    actual: String,
  },

  /// The schema uses a JSON-Schema construct this validator does not
  /// implement (e.g. `$ref`, `pattern`, `allOf`). Surfacing this as a
  /// violation is the load-bearing safety net: it prevents accidental
  /// silent acceptance of input the schema author intended to gate.
  #[error("schema at `{path}` uses unsupported JSON-Schema construct `{construct}`")]
  UnsupportedSchemaConstruct { path: String, construct: String },

  /// The schema itself is malformed (e.g. `type` is not a string,
  /// `properties` is not an object). Distinct from
  /// `UnsupportedSchemaConstruct`: the construct exists but the value
  /// shape is invalid.
  #[error("schema at `{path}` is malformed: {detail}")]
  MalformedSchema { path: String, detail: String },
}

/// Validate `instance` against `schema`, returning every violation.
///
/// An empty result means the instance satisfies the schema. The
/// validator never panics on adversarial input — malformed schemas
/// surface as [`SchemaViolation::MalformedSchema`] so a template
/// author's bug doesn't take the V2 mutation down.
pub fn validate(schema: &Value, instance: &Value) -> Vec<SchemaViolation> {
  let mut violations = Vec::new();
  validate_at(schema, instance, "", 0, &mut violations);
  violations
}

fn validate_at(schema: &Value, instance: &Value, path: &str, depth: usize, violations: &mut Vec<SchemaViolation>) {
  if depth > MAX_SCHEMA_RECURSION_DEPTH {
    violations.push(SchemaViolation::MalformedSchema {
      path: path.to_string(),
      detail: format!("schema recursion depth exceeded {MAX_SCHEMA_RECURSION_DEPTH} levels"),
    });
    return;
  }

  let Some(schema_obj) = schema.as_object() else {
    violations.push(SchemaViolation::MalformedSchema {
      path: path.to_string(),
      detail: format!("schema is not a JSON object: {}", short_repr(schema)),
    });
    return;
  };

  // Reject unsupported keywords up front so we do not silently
  // accept input the schema author intended to gate. The list mirrors
  // the JSON-Schema 2020-12 keywords that we *don't* implement.
  for unsupported in [
    "$ref",
    "$dynamicRef",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "pattern",
    "patternProperties",
    "contentEncoding",
    "contentMediaType",
    "contains",
    "uniqueItems",
    "dependencies",
    "dependentRequired",
    "dependentSchemas",
  ] {
    if schema_obj.contains_key(unsupported) {
      violations.push(SchemaViolation::UnsupportedSchemaConstruct {
        path: path.to_string(),
        construct: unsupported.to_string(),
      });
    }
  }

  if let Some(format) = schema_obj.get("format")
    && format.as_str() != Some("date")
  {
    violations.push(SchemaViolation::UnsupportedSchemaConstruct {
      path: path.to_string(),
      construct: "format".into(),
    });
  }

  // ── type ────────────────────────────────────────────────────────────────
  if let Some(t) = schema_obj.get("type") {
    let Some(t_str) = t.as_str() else {
      violations.push(SchemaViolation::MalformedSchema {
        path: path.to_string(),
        detail: format!("`type` must be a string, got {}", short_repr(t)),
      });
      return;
    };
    if !runtime_type_matches(instance, t_str) {
      violations.push(SchemaViolation::TypeMismatch {
        path: path.to_string(),
        expected: t_str.to_string(),
        actual: runtime_type_name(instance).to_string(),
      });
      // Type mismatch invalidates further per-keyword checks for this
      // node — the keywords below assume the instance is the right type.
      return;
    }
  }

  // ── enum ────────────────────────────────────────────────────────────────
  if let Some(en) = schema_obj.get("enum") {
    let Some(values) = en.as_array() else {
      violations.push(SchemaViolation::MalformedSchema {
        path: path.to_string(),
        detail: format!("`enum` must be an array, got {}", short_repr(en)),
      });
      return;
    };
    if !values.iter().any(|v| v == instance) {
      violations.push(SchemaViolation::EnumMismatch {
        path: path.to_string(),
        value: short_repr(instance),
        allowed: short_repr(en),
      });
    }
  }

  // ── const ───────────────────────────────────────────────────────────────
  if let Some(c) = schema_obj.get("const")
    && c != instance
  {
    violations.push(SchemaViolation::ConstMismatch {
      path: path.to_string(),
      expected: short_repr(c),
      actual: short_repr(instance),
    });
  }

  // ── per-runtime-type checks ────────────────────────────────────────────
  match instance {
    Value::String(s) => check_string(schema_obj, s, path, violations),
    Value::Number(n) => check_number(schema_obj, n, path, violations),
    Value::Array(a) => check_array(schema_obj, a, path, depth, violations),
    Value::Object(o) => check_object(schema_obj, o, path, depth, violations),
    Value::Bool(_) | Value::Null => {}
  }
}

fn check_string(schema: &serde_json::Map<String, Value>, s: &str, path: &str, violations: &mut Vec<SchemaViolation>) {
  if schema.get("format").and_then(Value::as_str) == Some("date") {
    // A roundtrip also rejects Chrono's permissive non-padded input forms.
    let valid = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
      .is_ok_and(|date| date.format("%Y-%m-%d").to_string() == s && s.len() == 10);
    if !valid {
      violations.push(SchemaViolation::InvalidStringFormat {
        path: path.into(),
        format: "date".into(),
      });
    }
  }
  let len = s.chars().count();
  let min = read_usize(schema, "minLength");
  let max = read_usize(schema, "maxLength");
  let too_short = min.map(|m| len < m).unwrap_or(false);
  let too_long = max.map(|m| len > m).unwrap_or(false);
  if too_short || too_long {
    violations.push(SchemaViolation::StringLengthOutOfRange {
      path: path.to_string(),
      actual: len,
      min,
      max,
    });
  }
}

fn check_number(
  schema: &serde_json::Map<String, Value>,
  n: &serde_json::Number,
  path: &str,
  violations: &mut Vec<SchemaViolation>,
) {
  let value = match n.as_f64() {
    Some(v) => v,
    None => return,
  };
  let mut bounds: Vec<String> = Vec::new();
  let mut violated = false;
  if let Some(min) = read_f64(schema, "minimum") {
    bounds.push(format!(">= {min}"));
    if value < min {
      violated = true;
    }
  }
  if let Some(max) = read_f64(schema, "maximum") {
    bounds.push(format!("<= {max}"));
    if value > max {
      violated = true;
    }
  }
  if let Some(emin) = read_f64(schema, "exclusiveMinimum") {
    bounds.push(format!("> {emin}"));
    if value <= emin {
      violated = true;
    }
  }
  if let Some(emax) = read_f64(schema, "exclusiveMaximum") {
    bounds.push(format!("< {emax}"));
    if value >= emax {
      violated = true;
    }
  }
  if violated {
    violations.push(SchemaViolation::NumberOutOfRange {
      path: path.to_string(),
      actual: value.to_string(),
      bounds: if bounds.is_empty() {
        "(unbounded)".into()
      } else {
        bounds.join(" and ")
      },
    });
  }
}

fn check_array(
  schema: &serde_json::Map<String, Value>,
  a: &[Value],
  path: &str,
  depth: usize,
  violations: &mut Vec<SchemaViolation>,
) {
  let len = a.len();
  let min = read_usize(schema, "minItems");
  let max = read_usize(schema, "maxItems");
  let too_short = min.map(|m| len < m).unwrap_or(false);
  let too_long = max.map(|m| len > m).unwrap_or(false);
  if too_short || too_long {
    violations.push(SchemaViolation::ArrayLengthOutOfRange {
      path: path.to_string(),
      actual: len,
      min,
      max,
    });
  }
  // `items` may be either a single schema (applied to every entry) or an
  // array of per-position schemas (Draft 7 tuple form). We support the
  // single-schema form only — the V2 manifest never emits the tuple form.
  if let Some(items) = schema.get("items") {
    if items.is_object() {
      for (i, entry) in a.iter().enumerate() {
        let entry_path = format!("{path}/{i}");
        validate_at(items, entry, &entry_path, depth + 1, violations);
      }
    } else if items.is_array() {
      violations.push(SchemaViolation::UnsupportedSchemaConstruct {
        path: format!("{path}/items"),
        construct: "items as tuple-array".to_string(),
      });
    } else {
      violations.push(SchemaViolation::MalformedSchema {
        path: format!("{path}/items"),
        detail: "`items` must be a schema object".to_string(),
      });
    }
  }
}

fn check_object(
  schema: &serde_json::Map<String, Value>,
  o: &serde_json::Map<String, Value>,
  path: &str,
  depth: usize,
  violations: &mut Vec<SchemaViolation>,
) {
  // ── required ──────────────────────────────────────────────────────────
  if let Some(req) = schema.get("required") {
    if let Some(req_arr) = req.as_array() {
      for r in req_arr {
        let Some(name) = r.as_str() else {
          violations.push(SchemaViolation::MalformedSchema {
            path: path.to_string(),
            detail: format!("`required` entry is not a string: {}", short_repr(r)),
          });
          continue;
        };
        if !o.contains_key(name) {
          violations.push(SchemaViolation::MissingRequired {
            path: path.to_string(),
            property: name.to_string(),
          });
        }
      }
    } else {
      violations.push(SchemaViolation::MalformedSchema {
        path: path.to_string(),
        detail: format!("`required` must be an array, got {}", short_repr(req)),
      });
    }
  }

  // ── properties + additionalProperties ─────────────────────────────────
  let properties = schema.get("properties").and_then(Value::as_object);
  let additional = schema.get("additionalProperties");

  for (key, value) in o {
    let key_path = format!("{path}/{}", escape_json_pointer_segment(key));
    if let Some(props) = properties
      && let Some(prop_schema) = props.get(key)
    {
      validate_at(prop_schema, value, &key_path, depth + 1, violations);
      continue;
    }
    // Property is not declared. additionalProperties decides:
    //   - missing       → allowed (default)
    //   - bool false    → forbidden
    //   - bool true     → allowed (default)
    //   - schema object → validate against it
    match additional {
      None => {} // default: allowed
      Some(Value::Bool(false)) => violations.push(SchemaViolation::AdditionalPropertyForbidden {
        path: path.to_string(),
        property: key.clone(),
      }),
      Some(Value::Bool(true)) => {} // explicitly allowed
      Some(other) if other.is_object() => {
        validate_at(other, value, &key_path, depth + 1, violations);
      }
      Some(other) => violations.push(SchemaViolation::MalformedSchema {
        path: path.to_string(),
        detail: format!(
          "`additionalProperties` must be bool or schema, got {}",
          short_repr(other)
        ),
      }),
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

fn escape_json_pointer_segment(segment: &str) -> String {
  segment.replace('~', "~0").replace('/', "~1")
}

fn runtime_type_name(v: &Value) -> &'static str {
  match v {
    Value::Null => "null",
    Value::Bool(_) => "boolean",
    Value::Number(n) => {
      if n.is_i64() || n.is_u64() {
        "integer"
      } else {
        "number"
      }
    }
    Value::String(_) => "string",
    Value::Array(_) => "array",
    Value::Object(_) => "object",
  }
}

fn runtime_type_matches(v: &Value, expected: &str) -> bool {
  match expected {
    "null" => v.is_null(),
    "boolean" => v.is_boolean(),
    "string" => v.is_string(),
    // JSON-Schema treats 1.0 as integer-valued; we match accordingly so
    // a manifest declaring `"type": "integer"` does not fail an instance
    // that came in as `1` (always integer in serde_json) or `1.0`
    // (number with `as_i64` Some).
    "integer" => v.is_i64() || v.is_u64() || v.as_f64().is_some_and(|f| f.fract() == 0.0),
    "number" => v.is_number(),
    "array" => v.is_array(),
    "object" => v.is_object(),
    _ => false,
  }
}

fn read_usize(schema: &serde_json::Map<String, Value>, key: &str) -> Option<usize> {
  schema
    .get(key)
    .and_then(Value::as_u64)
    .and_then(|n| usize::try_from(n).ok())
}

fn read_f64(schema: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
  schema.get(key).and_then(Value::as_f64)
}

/// Compact, length-bounded representation of a JSON value for error
/// messages — keeps the violation payload readable in logs without
/// dumping the whole instance.
fn short_repr(v: &Value) -> String {
  let s = serde_json::to_string(v).unwrap_or_else(|_| "<unrepresentable>".into());
  if s.len() <= 80 { s } else { format!("{}…", &s[..77]) }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  // ── runtime-type matching ────────────────────────────────────────────────

  #[test]
  fn type_mismatch_is_reported() {
    let schema = json!({ "type": "string" });
    let instance = json!(42);
    let v = validate(&schema, &instance);
    assert_eq!(v.len(), 1);
    assert!(matches!(v[0], SchemaViolation::TypeMismatch { .. }));
  }

  #[test]
  fn integer_type_accepts_whole_floats() {
    // serde_json parses `1.0` as a Number that `as_f64` exposes as 1.0;
    // JSON-Schema treats this as integer-valued.
    let schema = json!({ "type": "integer" });
    assert!(validate(&schema, &json!(1)).is_empty());
    // 1.5 must fail.
    let v = validate(&schema, &json!(1.5));
    assert!(matches!(v[0], SchemaViolation::TypeMismatch { .. }));
  }

  // ── object with required + additionalProperties ──────────────────────────

  #[test]
  fn missing_required_property_reported() {
    let schema = json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["title"],
      "properties": { "title": { "type": "string" } }
    });
    let v = validate(&schema, &json!({}));
    assert!(
      v.iter()
        .any(|x| matches!(x, SchemaViolation::MissingRequired { property, .. } if property == "title"))
    );
  }

  #[test]
  fn additional_property_rejected_when_strict() {
    let schema = json!({
      "type": "object",
      "additionalProperties": false,
      "properties": { "title": { "type": "string" } }
    });
    let v = validate(&schema, &json!({ "title": "x", "rogue": "y" }));
    assert!(
      v.iter()
        .any(|x| matches!(x, SchemaViolation::AdditionalPropertyForbidden { property, .. } if property == "rogue"))
    );
  }

  #[test]
  fn additional_property_allowed_when_default() {
    let schema = json!({
      "type": "object",
      "properties": { "title": { "type": "string" } }
    });
    // No `additionalProperties` → default permissive behaviour.
    assert!(validate(&schema, &json!({ "title": "x", "rogue": "y" })).is_empty());
  }

  // ── string length ────────────────────────────────────────────────────────

  #[test]
  fn string_length_bounds_enforced() {
    let schema = json!({ "type": "string", "minLength": 1, "maxLength": 5 });
    assert!(
      validate(&schema, &json!(""))
        .iter()
        .any(|x| matches!(x, SchemaViolation::StringLengthOutOfRange { .. }))
    );
    assert!(
      validate(&schema, &json!("toolong"))
        .iter()
        .any(|x| matches!(x, SchemaViolation::StringLengthOutOfRange { .. }))
    );
    assert!(validate(&schema, &json!("ok")).is_empty());
  }

  // ── number bounds ────────────────────────────────────────────────────────

  #[test]
  fn number_inclusive_bounds_enforced() {
    let schema = json!({ "type": "number", "minimum": 0, "maximum": 100 });
    assert!(
      validate(&schema, &json!(-1))
        .iter()
        .any(|x| matches!(x, SchemaViolation::NumberOutOfRange { .. }))
    );
    assert!(
      validate(&schema, &json!(101))
        .iter()
        .any(|x| matches!(x, SchemaViolation::NumberOutOfRange { .. }))
    );
    assert!(validate(&schema, &json!(50)).is_empty());
  }

  #[test]
  fn number_exclusive_bounds_enforced() {
    let schema = json!({ "type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1 });
    assert!(
      validate(&schema, &json!(0))
        .iter()
        .any(|x| matches!(x, SchemaViolation::NumberOutOfRange { .. }))
    );
    assert!(
      validate(&schema, &json!(1))
        .iter()
        .any(|x| matches!(x, SchemaViolation::NumberOutOfRange { .. }))
    );
    assert!(validate(&schema, &json!(0.5)).is_empty());
  }

  // ── enum / const ─────────────────────────────────────────────────────────

  #[test]
  fn enum_match_required() {
    let schema = json!({ "enum": ["a", "b", "c"] });
    assert!(
      validate(&schema, &json!("d"))
        .iter()
        .any(|x| matches!(x, SchemaViolation::EnumMismatch { .. }))
    );
    assert!(validate(&schema, &json!("a")).is_empty());
  }

  #[test]
  fn const_match_required() {
    let schema = json!({ "const": "frozen" });
    assert!(
      validate(&schema, &json!("hot"))
        .iter()
        .any(|x| matches!(x, SchemaViolation::ConstMismatch { .. }))
    );
    assert!(validate(&schema, &json!("frozen")).is_empty());
  }

  // ── nested objects ───────────────────────────────────────────────────────

  #[test]
  fn nested_property_violations_carry_jsonpointer_path() {
    let schema = json!({
      "type": "object",
      "properties": {
        "recipient": {
          "type": "object",
          "required": ["name"],
          "properties": { "name": { "type": "string" } }
        }
      }
    });
    let v = validate(&schema, &json!({ "recipient": {} }));
    assert!(v.iter().any(|x| matches!(
      x,
      SchemaViolation::MissingRequired { path, property } if path == "/recipient" && property == "name"
    )));
  }

  #[test]
  fn property_names_are_escaped_for_jsonpointer_paths() {
    let schema = json!({
      "type": "object",
      "properties": {
        "a/b~c": { "type": "string", "minLength": 2 }
      }
    });
    let v = validate(&schema, &json!({ "a/b~c": "" }));
    assert!(v.iter().any(|x| matches!(
      x,
      SchemaViolation::StringLengthOutOfRange { path, .. } if path == "/a~1b~0c"
    )));
  }

  #[test]
  fn schema_recursion_depth_is_capped() {
    let mut schema = json!({ "type": "string", "minLength": 1 });
    for _ in 0..=MAX_SCHEMA_RECURSION_DEPTH {
      schema = json!({
        "type": "object",
        "properties": { "nested": schema }
      });
    }
    let mut instance = json!("");
    for _ in 0..=MAX_SCHEMA_RECURSION_DEPTH {
      instance = json!({ "nested": instance });
    }

    let v = validate(&schema, &instance);
    assert!(v.iter().any(|x| matches!(
      x,
      SchemaViolation::MalformedSchema { detail, .. } if detail.contains("schema recursion depth exceeded")
    )));
  }

  // ── array items ──────────────────────────────────────────────────────────

  #[test]
  fn array_items_validated_per_entry() {
    let schema = json!({
      "type": "array",
      "items": { "type": "string", "minLength": 1 }
    });
    let v = validate(&schema, &json!([""]));
    assert!(v.iter().any(|x| matches!(
      x,
      SchemaViolation::StringLengthOutOfRange { path, .. } if path == "/0"
    )));
  }

  #[test]
  fn array_length_bounds_enforced() {
    let schema = json!({ "type": "array", "minItems": 1, "maxItems": 2 });
    assert!(
      validate(&schema, &json!([]))
        .iter()
        .any(|x| matches!(x, SchemaViolation::ArrayLengthOutOfRange { .. }))
    );
    assert!(
      validate(&schema, &json!([1, 2, 3]))
        .iter()
        .any(|x| matches!(x, SchemaViolation::ArrayLengthOutOfRange { .. }))
    );
    assert!(validate(&schema, &json!([1])).is_empty());
  }

  // ── unsupported schemas refuse explicitly ────────────────────────────────

  #[test]
  fn unsupported_constructs_are_explicitly_rejected() {
    let schema = json!({
      "type": "object",
      "allOf": [{ "type": "object" }]
    });
    let v = validate(&schema, &json!({}));
    assert!(v.iter().any(|x| matches!(
      x,
      SchemaViolation::UnsupportedSchemaConstruct { construct, .. } if construct == "allOf"
    )));
  }

  #[test]
  fn unsupported_pattern_is_rejected() {
    let schema = json!({ "type": "string", "pattern": "^[a-z]+$" });
    let v = validate(&schema, &json!("abc"));
    assert!(v.iter().any(|x| matches!(
      x,
      SchemaViolation::UnsupportedSchemaConstruct { construct, .. } if construct == "pattern"
    )));
  }

  #[test]
  fn documentation_date_requires_a_real_canonical_calendar_date() {
    let manifest: Value = serde_json::from_str(include_str!("../../../../templates/pdf/myoxus-doc/manifest.json"))
      .expect("documentation manifest");
    let schema = &manifest["inputs_schema"];
    assert!(
      validate(schema, &json!({})).is_empty(),
      "metadata defaults remain optional"
    );
    for date in ["2026-09-19", "2024-02-29"] {
      assert!(
        validate(schema, &json!({"report_date": date})).is_empty(),
        "valid date {date}"
      );
    }
    for date in ["2026-02-29", "2026-04-31", "2026-9-19", "19.09.2026", ""] {
      assert!(
        validate(schema, &json!({"report_date": date}))
          .iter()
          .any(|violation| matches!(
            violation, SchemaViolation::InvalidStringFormat { path, format }
            if path == "/report_date" && format == "date"
          )),
        "invalid date {date} must fail before Typst dispatch"
      );
    }
    assert!(
      validate(&json!({"type": "string", "format": "email"}), &json!("a@b.test"))
        .iter()
        .any(|violation| matches!(violation,
        SchemaViolation::UnsupportedSchemaConstruct { construct, .. } if construct == "format"))
    );
  }

  // ── malformed schemas surface as MalformedSchema, never panic ────────────

  #[test]
  fn malformed_schema_does_not_panic() {
    // `type` should be a string, not an array.
    let schema = json!({ "type": ["string", "number"] });
    let v = validate(&schema, &json!("x"));
    assert!(v.iter().any(|x| matches!(x, SchemaViolation::MalformedSchema { .. })));
  }

  // ── default-template real schema (the bundled `default` manifest) ────────

  #[test]
  fn validates_real_default_manifest_inputs_schema() {
    // Mirrors `templates/pdf/default/manifest.json`
    // `inputs_schema`. A clean input passes; missing required → fails;
    // extra property → fails (additionalProperties: false).
    let schema = json!({
      "type": "object",
      "additionalProperties": false,
      "required": ["title"],
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Document title rendered at the top of the first page."
        }
      }
    });

    // Happy path.
    assert!(validate(&schema, &json!({ "title": "Sample" })).is_empty());

    // Missing required.
    assert!(validate(&schema, &json!({})).iter().any(|x| matches!(
      x,
      SchemaViolation::MissingRequired { property, .. } if property == "title"
    )));

    // Empty title (minLength = 1).
    assert!(
      validate(&schema, &json!({ "title": "" }))
        .iter()
        .any(|x| matches!(x, SchemaViolation::StringLengthOutOfRange { .. }))
    );

    // Extra property.
    assert!(
      validate(&schema, &json!({ "title": "ok", "rogue": "y" }))
        .iter()
        .any(|x| matches!(
          x,
          SchemaViolation::AdditionalPropertyForbidden { property, .. } if property == "rogue"
        ))
    );
  }
}
