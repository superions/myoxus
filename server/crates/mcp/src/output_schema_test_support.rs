// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared, deliberately bounded output-schema assertions for unit and actual
//! tool-boundary integration fixtures. This module is not compiled in production.

use serde_json::Value;
use uuid::Uuid;

// Deliberately limited to the projection schema vocabulary; unsupported
// assertions fail the test instead of silently treating them as validated.
pub(crate) fn projection_schema_accepts(root: &Value, schema: &Value, value: &Value) -> bool {
  for keyword in schema.as_object().expect("schema object").keys() {
    assert!(
      [
        "$ref",
        "$defs",
        "type",
        "oneOf",
        "anyOf",
        "const",
        "enum",
        "required",
        "additionalProperties",
        "properties",
        "propertyNames",
        "maxProperties",
        "items",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "contentEncoding",
        "maxItems",
        "minItems",
        "uniqueItems",
        "format",
        "pattern",
        "description"
      ]
      .contains(&keyword.as_str()),
      "unhandled projection assertion: {keyword}"
    );
  }
  if let Some(pattern) = schema.get("pattern") {
    // Native package identities and plan digests use this one canonical SHA-256
    // spelling. This bounded assertion is deliberately not a regex engine.
    assert_eq!(
      pattern.as_str(),
      Some("^[a-f0-9]{64}$"),
      "unsupported projection pattern"
    );
  }
  if let Some(reference) = schema["$ref"].as_str() {
    return projection_schema_accepts(
      root,
      root
        .pointer(reference.strip_prefix('#').unwrap())
        .expect("local schema reference"),
      value,
    );
  }
  if let Some(variants) = schema["oneOf"].as_array() {
    if variants
      .iter()
      .filter(|schema| projection_schema_accepts(root, schema, value))
      .count()
      != 1
    {
      return false;
    }
  }
  if let Some(variants) = schema["anyOf"].as_array()
    && !variants
      .iter()
      .any(|variant| projection_schema_accepts(root, variant, value))
  {
    return false;
  }
  if let Some(expected) = schema.get("const") {
    if value != expected {
      return false;
    }
  }
  if let Some(variants) = schema["enum"].as_array() {
    if !variants.contains(value) {
      return false;
    }
  }
  if let Some(types) = schema.get("type") {
    let types = types.as_array().cloned().unwrap_or_else(|| vec![types.clone()]);
    if !types.iter().any(|kind| match kind.as_str().unwrap() {
      "object" => value.is_object(),
      "array" => value.is_array(),
      "string" => value.is_string(),
      // JSON Schema integers include integral JSON numbers such as native Yjs 1.0.
      "integer" => value
        .as_f64()
        .is_some_and(|number| number.is_finite() && number.fract() == 0.0),
      "number" => value.is_number(),
      "boolean" => value.is_boolean(),
      "null" => value.is_null(),
      _ => panic!("unknown schema type"),
    }) {
      return false;
    }
  }
  if let Some(object) = value.as_object() {
    if schema["maxProperties"]
      .as_u64()
      .is_some_and(|max| object.len() as u64 > max)
    {
      return false;
    }
    if schema["required"]
      .as_array()
      .is_some_and(|keys| keys.iter().any(|key| !object.contains_key(key.as_str().unwrap())))
    {
      return false;
    }
    for (key, value) in object {
      if let Some(property) = schema["properties"].get(key) {
        if !projection_schema_accepts(root, property, value) {
          return false;
        }
      } else if schema["additionalProperties"] == false {
        return false;
      } else if schema["additionalProperties"].is_object()
        && !projection_schema_accepts(root, &schema["additionalProperties"], value)
      {
        return false;
      }
      if let Some(names) = schema.get("propertyNames")
        && !projection_schema_accepts(root, names, &Value::String(key.clone()))
      {
        return false;
      }
    }
  }
  if let Some(values) = value.as_array() {
    if schema["uniqueItems"] == true
      && values
        .iter()
        .enumerate()
        .any(|(index, value)| values[..index].contains(value))
    {
      return false;
    }
    if schema["minItems"]
      .as_u64()
      .is_some_and(|min| values.len() < min as usize)
    {
      return false;
    }
    if schema["maxItems"]
      .as_u64()
      .is_some_and(|max| values.len() > max as usize)
    {
      return false;
    }
    if let Some(items) = schema.get("items") {
      if values
        .iter()
        .any(|value| !projection_schema_accepts(root, items, value))
      {
        return false;
      }
    }
  }
  if let Some(text) = value.as_str() {
    if schema.get("pattern").is_some() {
      if text.len() != 64 {
        return false;
      }
      let Ok(bytes) = hex::decode(text) else { return false };
      if bytes.len() != 32 || hex::encode(bytes) != text {
        return false;
      }
    }
    if schema["maxLength"]
      .as_u64()
      .is_some_and(|max| text.chars().count() > max as usize)
    {
      return false;
    }
    if let Some(encoding) = schema["contentEncoding"].as_str() {
      assert_eq!(encoding, "base64", "unsupported content encoding");
      use base64::Engine;
      if base64::engine::general_purpose::STANDARD.decode(text).is_err() {
        return false;
      }
    }
    if schema["minLength"]
      .as_u64()
      .is_some_and(|min| text.chars().count() < min as usize)
    {
      return false;
    }
    if schema["format"] == "uuid" && Uuid::parse_str(text).is_err() {
      return false;
    }
    if schema["format"] == "date-time" && chrono::DateTime::parse_from_rfc3339(text).is_err() {
      return false;
    }
    if schema["format"] == "date" && chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").is_err() {
      return false;
    }
  }
  if let Some(number) = value.as_f64() {
    if schema["minimum"].as_f64().is_some_and(|min| number < min)
      || schema["maximum"].as_f64().is_some_and(|max| number > max)
    {
      return false;
    }
  }
  true
}

/// Scope the additional integration assertions to the unchanged core projections.
pub(crate) fn has_core_contract(name: &str) -> bool {
  static CONTRACTS: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
  CONTRACTS.get_or_init(|| serde_json::from_str(include_str!("tool_registry/core-contracts.json")).unwrap())["tools"]
    .get(name)
    .is_some()
}

/// Check actual output, then prove that required members are enforced. Opaque
/// serde JSON slots accept every JSON value; their presence still gets checked.
pub(crate) fn assert_required_output(root: &Value, value: &Value) {
  assert!(
    projection_schema_accepts(root, root, value),
    "output violates schema: {value}"
  );
  let shape = if let Some(variants) = root["oneOf"].as_array() {
    variants
      .iter()
      .find(|variant| projection_schema_accepts(root, variant, value))
      .unwrap()
  } else {
    root
  };
  for field in shape["required"].as_array().expect("required result members") {
    let field = field.as_str().unwrap();
    let mut missing = value.clone();
    missing.as_object_mut().unwrap().remove(field);
    assert!(
      !projection_schema_accepts(root, root, &missing),
      "missing required {field}"
    );
    if let Some(invalid) = [
      serde_json::json!(false),
      serde_json::json!({}),
      serde_json::json!([]),
      Value::Null,
    ]
    .into_iter()
    .find(|candidate| !projection_schema_accepts(root, &shape["properties"][field], candidate))
    {
      let mut malformed = value.clone();
      malformed[field] = invalid;
      assert!(
        !projection_schema_accepts(root, root, &malformed),
        "malformed required {field}"
      );
    }
  }
}
