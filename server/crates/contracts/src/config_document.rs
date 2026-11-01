// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared, bounded codec for operator-supplied configuration documents.
//!
//! YAML uses `yaml_serde`; JSON keeps its existing `serde_json` backend. Main
//! documents retain map-entry visibility to reject duplicates before JSON
//! conversion; typed auxiliary files retain their own Serde schema and YAML
//! enum/tag behavior. Backend errors never expose values.

use std::{collections::HashSet, fmt};

use serde::{Deserialize, Serialize, de};

/// Maximum accepted UTF-8 configuration document size.
pub const MAX_CONFIG_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;

/// Syntax selected by an admitted configuration transport.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigDocumentFormat {
  Json,
  Yaml,
}

/// Sanitized configuration-document decoding failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigDocumentError {
  message: String,
}

impl ConfigDocumentError {
  pub fn message(&self) -> &str {
    &self.message
  }
}

impl fmt::Display for ConfigDocumentError {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(&self.message)
  }
}

impl std::error::Error for ConfigDocumentError {}

/// Decode exactly one bounded JSON or YAML document without resolving files,
/// includes, interpolation or any other external input.
pub fn decode_config_document(
  input: &str,
  format: ConfigDocumentFormat,
) -> Result<serde_json::Value, ConfigDocumentError> {
  if input.len() > MAX_CONFIG_DOCUMENT_BYTES {
    return Err(config_document_error(format!(
      "configuration document exceeds the {MAX_CONFIG_DOCUMENT_BYTES}-byte limit"
    )));
  }
  match format {
    ConfigDocumentFormat::Json => {
      let mut deserializer = serde_json::Deserializer::from_str(input);
      let value = StrictConfigValue::deserialize(&mut deserializer)
        .map_err(|error| sanitized_json_error(&error))?
        .0;
      deserializer.end().map_err(|error| sanitized_json_error(&error))?;
      Ok(value)
    }
    ConfigDocumentFormat::Yaml => {
      if input.trim().is_empty() {
        return Ok(serde_json::Value::Null);
      }
      decode_typed_yaml_document::<StrictConfigValue>(input).map(StrictConfigValue::into_value)
    }
  }
}

/// Decode one bounded auxiliary YAML document directly into its owning schema.
/// Unlike main configuration decoding, this preserves typed YAML enum tags and
/// does not normalize source fields. Defaults and feature filtering belong to
/// the consumer; size, document framing and sanitized errors belong here.
pub fn decode_typed_yaml_document<T: de::DeserializeOwned>(input: &str) -> Result<T, ConfigDocumentError> {
  if input.len() > MAX_CONFIG_DOCUMENT_BYTES {
    return Err(config_document_error(format!(
      "configuration document exceeds the {MAX_CONFIG_DOCUMENT_BYTES}-byte limit"
    )));
  }
  let mut documents = yaml_serde::Deserializer::from_str(input);
  // Retain the deployed backend's depth (128) and alias-repetition safeguards
  // (100 times the document event count), in addition to the input-size cap.
  let first = documents
    .next()
    .ok_or_else(|| config_document_error("configuration document is empty"))?;
  let value = T::deserialize(first).map_err(|error| sanitized_yaml_error(&error))?;
  if documents.next().is_some() {
    return Err(config_document_error(
      "configuration input must contain exactly one YAML document",
    ));
  }
  Ok(value)
}

/// Serialize configuration without forwarding backend or custom-Serde errors,
/// which can contain unredacted values. Presentation is not a persistence contract.
pub fn encode_config_yaml<T: Serialize + ?Sized>(value: &T) -> Result<String, ConfigDocumentError> {
  yaml_serde::to_string(value).map_err(|_| config_document_error("YAML configuration could not be serialized"))
}

fn sanitized_json_error(error: &serde_json::Error) -> ConfigDocumentError {
  if let Some(duplicate) = duplicate_key_message(&error.to_string()) {
    return config_document_error(duplicate);
  }
  config_document_error(format!(
    "invalid JSON configuration document at line {}, column {}",
    error.line(),
    error.column()
  ))
}

fn sanitized_yaml_error(error: &yaml_serde::Error) -> ConfigDocumentError {
  if let Some(duplicate) = duplicate_key_message(&error.to_string()) {
    return config_document_error(duplicate);
  }
  if let Some(location) = error.location() {
    config_document_error(format!(
      "invalid YAML configuration document at line {}, column {}",
      location.line(),
      location.column()
    ))
  } else {
    config_document_error("invalid YAML configuration document")
  }
}

fn duplicate_key_message(message: &str) -> Option<&str> {
  message
    .strip_prefix("duplicate configuration key ")
    .map(|remainder| remainder.split(" at line").next().unwrap_or(remainder))
    .map(|field| &message[.."duplicate configuration key ".len() + field.len()])
}

fn config_document_error(message: impl Into<String>) -> ConfigDocumentError {
  ConfigDocumentError {
    message: message.into(),
  }
}

/// Serde value wrapper that rejects duplicate map keys recursively. HTTP
/// transports can use this before their request object becomes a generic map.
pub struct StrictConfigValue(serde_json::Value);

impl StrictConfigValue {
  pub fn into_value(self) -> serde_json::Value {
    self.0
  }
}

impl<'de> Deserialize<'de> for StrictConfigValue {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    deserializer.deserialize_any(StrictValueVisitor)
  }
}

struct StrictValueVisitor;

impl<'de> de::Visitor<'de> for StrictValueVisitor {
  type Value = StrictConfigValue;

  fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str("a JSON-compatible configuration value")
  }

  fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
    Ok(StrictConfigValue(value.into()))
  }

  fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
    Ok(StrictConfigValue(value.into()))
  }

  fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
    Ok(StrictConfigValue(value.into()))
  }

  fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
  where
    E: de::Error,
  {
    serde_json::Number::from_f64(value)
      .map(serde_json::Value::Number)
      .map(StrictConfigValue)
      .ok_or_else(|| E::custom("configuration numbers must be finite"))
  }

  fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
  where
    E: de::Error,
  {
    Ok(StrictConfigValue(value.to_string().into()))
  }

  fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
    Ok(StrictConfigValue(value.into()))
  }

  fn visit_none<E>(self) -> Result<Self::Value, E> {
    Ok(StrictConfigValue(serde_json::Value::Null))
  }

  fn visit_unit<E>(self) -> Result<Self::Value, E> {
    Ok(StrictConfigValue(serde_json::Value::Null))
  }

  fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    StrictConfigValue::deserialize(deserializer)
  }

  fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
  where
    A: de::SeqAccess<'de>,
  {
    let mut values = Vec::new();
    while let Some(value) = sequence.next_element::<StrictConfigValue>()? {
      values.push(value.0);
    }
    Ok(StrictConfigValue(serde_json::Value::Array(values)))
  }

  fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
  where
    A: de::MapAccess<'de>,
  {
    let mut keys = HashSet::new();
    let mut values = serde_json::Map::new();
    while let Some(key) = map.next_key::<String>()? {
      if !keys.insert(key.clone()) {
        return Err(de::Error::custom(format!("duplicate configuration key `{key}`")));
      }
      let value = map.next_value::<StrictConfigValue>()?;
      values.insert(key, value.0);
    }
    Ok(StrictConfigValue(serde_json::Value::Object(values)))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn preserves_supported_yaml_values_and_anchors() {
    let value = decode_config_document(
      "defaults: &defaults\n  enabled: true\n  values: [1, null, text]\ncopy: *defaults\n",
      ConfigDocumentFormat::Yaml,
    )
    .unwrap();
    assert_eq!(value["copy"]["enabled"], true);
    assert_eq!(value["copy"]["values"], serde_json::json!([1, null, "text"]));
  }

  #[test]
  fn rejects_duplicate_keys_and_multiple_yaml_documents() {
    for (input, format) in [
      (r#"{"server": 1, "server": 2}"#, ConfigDocumentFormat::Json),
      ("server: 1\nserver: 2\n", ConfigDocumentFormat::Yaml),
    ] {
      let error = decode_config_document(input, format).unwrap_err();
      assert!(error.message().contains("duplicate configuration key `server`"));
    }
    assert!(decode_config_document("server: one\n---\nserver: two\n", ConfigDocumentFormat::Yaml).is_err());
  }

  #[test]
  fn rejects_oversized_documents_before_parsing() {
    // Valid scalars prove the cap, rather than failing merely on invalid syntax.
    let input = format!("\"{}\"", "x".repeat(MAX_CONFIG_DOCUMENT_BYTES));
    for format in [ConfigDocumentFormat::Json, ConfigDocumentFormat::Yaml] {
      let error = decode_config_document(&input, format).unwrap_err();
      assert!(error.message().contains("byte limit"));
    }
    assert!(
      decode_typed_yaml_document::<String>(&input)
        .unwrap_err()
        .message()
        .contains("byte limit")
    );
  }

  #[test]
  fn retains_deployed_yaml_scalar_key_tag_and_merge_semantics() {
    for (input, expected) in [
      ("", serde_json::Value::Null),
      ("# comment only\n", serde_json::Value::Null),
      ("---\n", serde_json::Value::Null),
      (
        "bool: true\nquoted: 'true'\nnullValue: null\nhex: 0xB\nfloat: 1.5\n",
        serde_json::json!({"bool": true, "quoted": "true", "nullValue": null, "hex": 11, "float": 1.5}),
      ),
      (
        "null: value\n0xB: hex-key\n11: decimal-key\n",
        serde_json::json!({"null": "value", "0xB": "hex-key", "11": "decimal-key"}),
      ),
      (
        "binary: !!binary SGVsbG8=\ntext: !!str true\n",
        serde_json::json!({"binary": "SGVsbG8=", "text": "true"}),
      ),
      (
        "base: &base {enabled: true}\ncopy: {<<: *base, name: retained}\n",
        serde_json::json!({"base": {"enabled": true}, "copy": {"<<": {"enabled": true}, "name": "retained"}}),
      ),
    ] {
      let value = decode_config_document(input, ConfigDocumentFormat::Yaml).unwrap();
      assert_eq!(value, expected);
      assert_eq!(
        decode_config_document(&encode_config_yaml(&value).unwrap(), ConfigDocumentFormat::Yaml).unwrap(),
        expected
      );
    }
  }

  #[test]
  fn rejects_nested_duplicates_tags_nonfinite_and_malformed_documents_without_values() {
    for input in [
      "nested: {value: one, value: two}\n",
      "value: !custom synthetic-tag-secret\n",
      "value: .nan\n",
      "value: .inf\n",
      "value: [synthetic-syntax-secret,\n",
      "value: accepted\n---\nvalue: [synthetic-tail-secret,\n",
      "---\n---\n",
    ] {
      let error = decode_config_document(input, ConfigDocumentFormat::Yaml).unwrap_err();
      assert!(!error.message().contains("synthetic-"));
    }
  }

  #[test]
  fn retains_parser_depth_and_alias_repetition_safeguards() {
    let too_deep = format!("{}null{}", "[".repeat(129), "]".repeat(129));
    assert!(decode_config_document(&too_deep, ConfigDocumentFormat::Yaml).is_err());
    assert!(decode_typed_yaml_document::<serde_json::Value>(&too_deep).is_err());
    let admitted = format!("{}null{}", "[".repeat(16), "]".repeat(16));
    assert!(decode_config_document(&admitted, ConfigDocumentFormat::Yaml).is_ok());
    assert!(decode_config_document("cycle: &cycle [*cycle]\n", ConfigDocumentFormat::Yaml).is_err());
    let mut aliases = "level0: &level0 [value]\n".to_string();
    for level in 1..8 {
      aliases.push_str(&format!(
        "level{level}: &level{level} [*level{}, *level{}, *level{}, *level{}]\n",
        level - 1,
        level - 1,
        level - 1,
        level - 1
      ));
    }
    assert!(decode_config_document(&aliases, ConfigDocumentFormat::Yaml).is_err());
  }
}
