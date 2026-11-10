// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native inline field data, independent of metadata lookup and synchronization.

use serde::{Deserialize, Serialize};
use yrs::types::Attrs;

pub mod content;
mod fingerprint;

pub const FIELD_ATTRIBUTE: &str = "documentField";
pub const CAPTURE_ATTRIBUTE: &str = "documentFieldCaptured";
/// Virgultum's native inline embeds use one attributed space in Y.Text.
pub const LIVE_TEXT: &str = " ";
// Match the deployed manual-input string/name ceilings; these are native shape
// limits, not required-answer or calendar admission (owned by Application).
pub const MAX_STRING_BYTES: usize = 8 * 1024;
pub const MAX_ID_BYTES: usize = 128;
pub const MAX_OPTIONS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputKind {
  Text,
  Date,
  Datetime,
  SingleSelect,
  MultiSelect,
}

impl InputKind {
  pub const ALL: [Self; 5] = [
    Self::Text,
    Self::Date,
    Self::Datetime,
    Self::SingleSelect,
    Self::MultiSelect,
  ];

  pub const fn multiple(self) -> bool {
    matches!(self, Self::MultiSelect)
  }

  pub const fn has_options(self) -> bool {
    matches!(self, Self::SingleSelect | Self::MultiSelect)
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MetadataKey {
  Title,
  VersionLabel,
  VersionNumber,
  DocumentType,
  Status,
  Classification,
  DocumentNumber,
  Responsible,
  CreatedBy,
  UpdatedBy,
  CreatedAt,
  UpdatedAt,
  ReviewDueAt,
  ValidFrom,
  ValidUntil,
  Language,
  Audience,
  RetentionPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetadataFormat {
  Text,
  Name,
  Email,
  Date,
  Time,
  Datetime,
}

impl MetadataKey {
  pub const ALL: [Self; 18] = [
    Self::Title,
    Self::VersionLabel,
    Self::VersionNumber,
    Self::DocumentType,
    Self::Status,
    Self::Classification,
    Self::DocumentNumber,
    Self::Responsible,
    Self::CreatedBy,
    Self::UpdatedBy,
    Self::CreatedAt,
    Self::UpdatedAt,
    Self::ReviewDueAt,
    Self::ValidFrom,
    Self::ValidUntil,
    Self::Language,
    Self::Audience,
    Self::RetentionPolicy,
  ];

  pub fn formats(self) -> &'static [MetadataFormat] {
    use MetadataFormat::*;
    match self {
      Self::Responsible | Self::CreatedBy | Self::UpdatedBy => &[Name, Email],
      Self::CreatedAt | Self::UpdatedAt | Self::ReviewDueAt | Self::ValidFrom | Self::ValidUntil => {
        &[Date, Time, Datetime]
      }
      _ => &[Text],
    }
  }
}

/// Null scalars and empty multiple selections are valid unfinished answers.
/// Labels never serve as option identities. Calendar/membership validation is
/// deliberately separate from this native structural representation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum InputValue {
  Scalar(Option<String>),
  Multiple(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputOption {
  pub id: String,
  pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputDefinition {
  pub kind: InputKind,
  pub label: String,
  #[serde(default, deserialize_with = "read_present", skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  pub required: bool,
  #[serde(default, deserialize_with = "read_present", skip_serializing_if = "Option::is_none")]
  pub default: Option<InputValue>,
  #[serde(default, deserialize_with = "read_present", skip_serializing_if = "Option::is_none")]
  pub options: Option<Vec<InputOption>>,
}

// Missing optional fields stay absent. Present values are decoded as their
// actual type, so null defaults survive and null labels/options are rejected.
fn read_present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
  T::deserialize(deserializer).map(Some)
}

/// One occurrence owns one value. Metadata has no document selector or cached
/// display value: its containing document supplies the authorized facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum DocumentField {
  Input {
    id: String,
    definition: InputDefinition,
    value: InputValue,
  },
  Metadata {
    id: String,
    key: MetadataKey,
    format: MetadataFormat,
  },
}

fn bounded_id(value: &str) -> bool {
  !value.is_empty() && value.len() <= MAX_ID_BYTES && value.trim() == value
}

impl InputValue {
  fn has_shape(&self, kind: InputKind) -> bool {
    match (kind.multiple(), self) {
      (true, Self::Multiple(values)) => values.len() <= MAX_OPTIONS && values.iter().all(|v| bounded_id(v)),
      (false, Self::Scalar(value)) => value.as_ref().is_none_or(|v| v.len() <= MAX_STRING_BYTES),
      _ => false,
    }
  }
}

impl DocumentField {
  pub fn id(&self) -> &str {
    match self {
      Self::Input { id, .. } | Self::Metadata { id, .. } => id,
    }
  }

  /// Structural admission only; never fills defaults or trims literal answers.
  pub fn validate_shape(&self) -> Result<(), &'static str> {
    let valid = bounded_id(self.id())
      && match self {
        Self::Metadata { key, format, .. } => key.formats().contains(format),
        Self::Input { definition, value, .. } => {
          !definition.label.trim().is_empty()
            && definition.label.len() <= MAX_STRING_BYTES
            && definition
              .description
              .as_ref()
              .is_none_or(|v| v.len() <= MAX_STRING_BYTES)
            && value.has_shape(definition.kind)
            && definition.default.as_ref().is_none_or(|v| v.has_shape(definition.kind))
            && match (definition.kind.has_options(), &definition.options) {
              (true, Some(options)) => {
                !options.is_empty()
                  && options.len() <= MAX_OPTIONS
                  && options
                    .iter()
                    .all(|v| bounded_id(&v.id) && !v.label.trim().is_empty() && v.label.len() <= MAX_STRING_BYTES)
              }
              (false, None) => true,
              _ => false,
            }
        }
      };
    valid.then_some(()).ok_or("invalid native document field")
  }

  /// Call only for a new native occurrence, never to refresh live content.
  pub fn clone_occurrence(&self, id: String) -> Result<Self, &'static str> {
    let mut cloned = self.clone();
    match &mut cloned {
      Self::Input { id: current, .. } | Self::Metadata { id: current, .. } => *current = id,
    }
    cloned.validate_shape()?;
    Ok(cloned)
  }

  /// Only template application initializes defaults. Ordinary duplication keeps
  /// the occurrence's current value, and archival content stays frozen.
  pub fn initialize_for_template(&self) -> Self {
    let mut initialized = self.clone();
    if let Self::Input { definition, value, .. } = &mut initialized {
      *value = definition.default.clone().unwrap_or_else(|| {
        if definition.kind.multiple() {
          InputValue::Multiple(Vec::new())
        } else {
          InputValue::Scalar(None)
        }
      });
    }
    initialized
  }
}

/// A frozen field keeps readable text in Y.Text and canonical input data in the
/// descriptor for editable restoration. The marker is not authority for live facts.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldRun {
  pub text: String,
  pub attributes: Attrs,
  pub descriptor: DocumentField,
  pub captured: bool,
}

impl FieldRun {
  pub fn decode(text: &str, attributes: &Attrs) -> Result<Option<Self>, &'static str> {
    let Some(value) = attributes.get(FIELD_ATTRIBUTE) else {
      return if attributes.contains_key(CAPTURE_ATTRIBUTE) {
        Err("native field capture has no descriptor")
      } else {
        Ok(None)
      };
    };
    let value = crate::native_snapshot::json_value(value, 0).map_err(|_| "invalid native document field")?;
    let descriptor: DocumentField = serde_json::from_value(value).map_err(|_| "invalid native document field")?;
    descriptor.validate_shape()?;
    let captured = match attributes.get(CAPTURE_ATTRIBUTE) {
      None => false,
      Some(yrs::Any::Bool(true)) => true,
      _ => return Err("invalid native field capture marker"),
    };
    if text.is_empty()
      || (!captured && text != LIVE_TEXT)
      || ["annotation", "reference", "mention", "latex", "footnote", "link"]
        .iter()
        .any(|key| attributes.contains_key(*key))
    {
      return Err("invalid native field text or inline combination");
    }
    Ok(Some(Self {
      text: text.into(),
      attributes: attributes.clone(),
      descriptor,
      captured,
    }))
  }

  /// The caller resolves readable text in its capture context. Empty/unset inputs
  /// need a readable placeholder so their native occurrence cannot disappear.
  pub fn freeze(&self, readable: String) -> Result<Self, &'static str> {
    if self.captured {
      return Err("native field is already captured");
    }
    if readable.is_empty() {
      return Err("native field capture requires readable text");
    }
    let mut frozen = self.clone();
    frozen.text = readable;
    frozen.captured = true;
    frozen.attributes.insert(CAPTURE_ATTRIBUTE.into(), yrs::Any::Bool(true));
    Ok(frozen)
  }

  pub fn reactivate(&self) -> Self {
    let mut live = self.clone();
    live.text = LIVE_TEXT.into();
    live.captured = false;
    live.attributes.remove(CAPTURE_ATTRIBUTE);
    live
  }

  /// Keep native text and marks while replacing one admitted descriptor.
  pub fn with_descriptor(&self, descriptor: DocumentField) -> Result<Self, &'static str> {
    let mut attributes = self.attributes.clone();
    attributes.insert(
      FIELD_ATTRIBUTE.into(),
      crate::json_to_yjs_any(&serde_json::to_value(descriptor).map_err(|_| "invalid native document field")?)
        .map_err(|_| "invalid native document field")?,
    );
    Self::decode(&self.text, &attributes)?.ok_or("native document field missing")
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::{Value, json};
  use yrs::{Map, ReadTxn, Text, Transact, updates::decoder::Decode};

  fn fixtures() -> Value {
    serde_json::from_str(include_str!(
      "../../../../build/fixtures/contracts/document-fields.json"
    ))
    .unwrap()
  }

  #[test]
  fn native_field_shapes_match_the_editor_contract() {
    let fixtures = fixtures();
    for value in fixtures["valid"].as_array().unwrap() {
      let field: DocumentField = serde_json::from_value(value.clone()).unwrap();
      field.validate_shape().unwrap();
      assert_eq!(serde_json::to_value(field).unwrap(), *value);
    }
    for value in fixtures["invalid"].as_array().unwrap() {
      assert!(match serde_json::from_value::<DocumentField>(value.clone()) {
        Err(_) => true,
        Ok(field) => field.validate_shape().is_err(),
      });
    }
  }

  #[test]
  fn snapshot_roundtrip_retains_adjacent_occurrences_marks_values_and_frozen_text() {
    let field: DocumentField = serde_json::from_value(fixtures()["valid"][0].clone()).unwrap();
    let attributes = Attrs::from([
      (
        FIELD_ATTRIBUTE.into(),
        crate::json_to_yjs_any(&serde_json::to_value(&field).unwrap()).unwrap(),
      ),
      ("bold".into(), yrs::Any::Bool(true)),
    ]);
    let live = FieldRun::decode(LIVE_TEXT, &attributes).unwrap().unwrap();
    let frozen = live.freeze("Nicht {{captured}} ausgefüllt".into()).unwrap();
    assert_eq!(frozen.reactivate(), live);
    assert!(frozen.freeze("changed historical value".into()).is_err());
    assert!(live.freeze(String::new()).is_err());
    let second = field.clone_occurrence("text-b".into()).unwrap();
    let second_attrs = Attrs::from([
      (
        FIELD_ATTRIBUTE.into(),
        crate::json_to_yjs_any(&serde_json::to_value(second).unwrap()).unwrap(),
      ),
      ("bold".into(), yrs::Any::Bool(true)),
    ]);
    let doc = yrs::Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let state = {
      let mut txn = doc.transact_mut();
      let page = blocks.insert(&mut txn, "page", yrs::MapPrelim::default());
      page.insert(&mut txn, "sys:id", "page");
      page.insert(&mut txn, "sys:flavour", "myoxus:page");
      page.insert(&mut txn, "sys:children", yrs::ArrayPrelim::from(["p"]));
      page.insert(&mut txn, "prop:title", yrs::TextPrelim::new("Title"));
      let block = blocks.insert(&mut txn, "p", yrs::MapPrelim::default());
      block.insert(&mut txn, "sys:id", "p");
      block.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
      block.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
      let text = block.insert(&mut txn, "prop:text", yrs::TextPrelim::new("Before "));
      text.insert_with_attributes(&mut txn, 7, LIVE_TEXT, attributes);
      text.insert_with_attributes(&mut txn, 8, LIVE_TEXT, second_attrs);
      let mut frozen_attrs = frozen.attributes.clone();
      let frozen_field = field.clone_occurrence("text-c".into()).unwrap();
      frozen_attrs.insert(
        FIELD_ATTRIBUTE.into(),
        crate::json_to_yjs_any(&serde_json::to_value(frozen_field).unwrap()).unwrap(),
      );
      text.insert_with_attributes(&mut txn, 9, &frozen.text, frozen_attrs);
      let end = text.len(&txn);
      text.insert_with_attributes(&mut txn, end, " {{unchanged}} é😀", Attrs::new());
      txn.encode_state_as_update_v1(&Default::default())
    };
    let snapshot = crate::document_to_snapshot(&state, "doc", "Title").unwrap();
    let delta = &snapshot["blocks"]
      .as_array()
      .unwrap()
      .iter()
      .find(|block| block["id"] == "p")
      .unwrap()["props"]["text"]["delta"];
    assert_eq!(delta[1]["attributes"][FIELD_ATTRIBUTE]["id"], "text-a");
    assert_eq!(delta[2]["attributes"][FIELD_ATTRIBUTE]["id"], "text-b");
    assert_eq!(delta[3]["insert"], "Nicht {{captured}} ausgefüllt");
    assert_eq!(delta[3]["attributes"][CAPTURE_ATTRIBUTE], true);
    // The same existing materializer used by native bundles must preserve the
    // descriptor, not silently replace it with displayed/brace text.
    let blocks: Vec<crate::PortableSnapshotBlock> = serde_json::from_value(snapshot["blocks"].clone()).unwrap();
    let restored = crate::snapshot_blocks_to_yjs(&blocks).unwrap();
    assert_eq!(
      crate::document_to_snapshot(&restored, "doc", "Title").unwrap(),
      snapshot
    );
    let inspection = crate::inspect_native_template(&restored).unwrap();
    assert_eq!(inspection.required_variables, vec!["unchanged"]);
    assert_eq!(inspection.native_fields.len(), 3);
    assert_eq!(
      inspection.native_fields.iter().filter(|field| field.captured).count(),
      1
    );
    let applied = crate::instantiate_native_template(&restored, &Default::default()).unwrap();
    assert_eq!(applied.unresolved_variables, vec!["unchanged"]);
    let fields = content::inspect(&applied.snapshot).unwrap();
    assert_eq!(fields.len(), 3);
    for occurrence in fields.iter().filter(|field| !field.run.captured) {
      let DocumentField::Input { value, .. } = &occurrence.run.descriptor else {
        panic!("input")
      };
      assert_eq!(value, &InputValue::Scalar(Some("  {{literal}}  ".into())));
    }
    let captured = fields.iter().find(|field| field.run.captured).unwrap();
    assert_eq!(captured.run.text, frozen.text);
    assert_eq!(captured.run.descriptor.id(), "text-c");
    let readback = yrs::Doc::new();
    readback
      .transact_mut()
      .apply_update(yrs::Update::decode_v1(&applied.snapshot).unwrap())
      .unwrap();
    let txn = readback.transact();
    let yrs::Out::YMap(block) = txn.get_map("blocks").unwrap().get(&txn, "p").unwrap() else {
      panic!("paragraph")
    };
    let native = crate::native_text::native_block_text(&block, &txn).unwrap();
    let spans = native.fields[0]
      .spans
      .iter()
      .filter(|span| span.document_field.is_some())
      .collect::<Vec<_>>();
    assert_eq!(spans.len(), 3);
    assert!(spans.iter().all(|span| span.protected));
    assert_eq!(
      spans
        .iter()
        .filter(|span| span.document_field_captured == Some(true))
        .count(),
      1
    );
    // One frozen occurrence may have several styled runs. Restoration must
    // collapse it to one atom without losing adjacent independent fields.
    let all_frozen = content::map(&state, |run| {
      if run.captured {
        Ok(run.clone())
      } else {
        run.freeze("value".into())
      }
    })
    .unwrap()
    .state;
    let split = {
      let doc = yrs::Doc::with_options(yrs::Options {
        offset_kind: yrs::OffsetKind::Bytes,
        ..Default::default()
      });
      doc
        .transact_mut()
        .apply_update(yrs::Update::decode_v1(&all_frozen).unwrap())
        .unwrap();
      let occurrence = content::inspect(&all_frozen)
        .unwrap()
        .into_iter()
        .find(|field| field.run.descriptor.id() == "text-c")
        .unwrap();
      let blocks = doc.get_or_insert_map("blocks");
      let mut txn = doc.transact_mut();
      let yrs::Out::YMap(block) = blocks.get(&txn, "p").unwrap() else {
        panic!("paragraph")
      };
      let yrs::Out::YText(text) = block.get(&txn, "prop:text").unwrap() else {
        panic!("text")
      };
      text.format(
        &mut txn,
        occurrence.start,
        5,
        Attrs::from([("italic".into(), yrs::Any::Bool(true))]),
      );
      txn.encode_state_as_update_v1(&Default::default())
    };
    assert_eq!(content::inspect(&split).unwrap().len(), 4);
    let live = content::reactivate_capture(&split).unwrap().state;
    let restored_fields = content::inspect(&live).unwrap();
    assert_eq!(restored_fields.len(), 3);
    assert!(
      restored_fields
        .iter()
        .all(|field| !field.run.captured && field.run.text == LIVE_TEXT)
    );
    assert_eq!(
      restored_fields
        .iter()
        .filter(|field| field.run.descriptor.id() == "text-c")
        .count(),
      1
    );
    assert!(
      content::reactivate_capture(&state).is_err(),
      "uncaptured history cannot be reactivated"
    );
    let copy_source = split.clone();
    let copied = {
      let doc = yrs::Doc::with_options(yrs::Options {
        offset_kind: yrs::OffsetKind::Bytes,
        ..Default::default()
      });
      doc
        .transact_mut()
        .apply_update(yrs::Update::decode_v1(&split).unwrap())
        .unwrap();
      let blocks = doc.get_or_insert_map("blocks");
      let mut txn = doc.transact_mut();
      let yrs::Out::YMap(block) = blocks.get(&txn, "p").unwrap() else {
        panic!("paragraph")
      };
      let yrs::Out::YText(text) = block.get(&txn, "prop:text").unwrap() else {
        panic!("text")
      };
      let chunks = text
        .diff(&txn, |_| ())
        .into_iter()
        .map(|chunk| {
          let yrs::Out::Any(yrs::Any::String(value)) = chunk.insert else {
            panic!("text chunk")
          };
          (
            value.to_string(),
            chunk.attributes.map(|attrs| *attrs).unwrap_or_default(),
          )
        })
        .collect::<Vec<_>>();
      let remapped = content::remap_chunks(&chunks, &mut Default::default()).unwrap();
      let copied_runs = remapped
        .iter()
        .filter_map(|(value, attrs)| FieldRun::decode(value, attrs).unwrap())
        .collect::<Vec<_>>();
      assert_eq!(copied_runs.len(), 3);
      assert!(
        copied_runs
          .iter()
          .all(|field| !field.captured && field.text == LIVE_TEXT)
      );
      content::remap_copied_text(&text, &mut txn, &mut Default::default()).unwrap();
      txn.encode_state_as_update_v1(&Default::default())
    };
    let copied_fields = content::inspect(&copied).unwrap();
    assert_eq!(copied_fields.len(), 3);
    assert!(
      copied_fields
        .iter()
        .all(|field| !field.run.captured && field.run.text == LIVE_TEXT)
    );
    assert!(
      copied_fields
        .iter()
        .all(|field| !["text-a", "text-b", "text-c"].contains(&field.run.descriptor.id()))
    );
    let originals = content::inspect(&split).unwrap();
    for (copied, original_id) in copied_fields.iter().zip(["text-a", "text-b", "text-c"]) {
      let original = originals
        .iter()
        .find(|field| field.run.descriptor.id() == original_id)
        .unwrap();
      assert_eq!(
        copied.run.descriptor,
        original
          .run
          .descriptor
          .clone_occurrence(copied.run.descriptor.id().into())
          .unwrap(),
        "copy changes identity but retains the captured input definition and value"
      );
    }
    assert_eq!(split, copy_source, "copy never rewrites its source snapshot");
    let materialized = content::copy_for_editable_document(&state).unwrap();
    assert!(materialized.delta.is_some());
    let materialized_fields = content::inspect(&materialized.state).unwrap();
    assert_eq!(materialized_fields.len(), 3);
    for (copied, original_id) in materialized_fields.iter().zip(["text-a", "text-b", "text-c"]) {
      assert!(!copied.run.captured && copied.run.text == LIVE_TEXT);
      assert_ne!(copied.run.descriptor.id(), original_id);
    }
    let plain = crate::YjsDocumentBuilder::new("Field-free").encode();
    let unchanged = content::copy_for_editable_document(&plain).unwrap();
    assert_eq!(unchanged.state, plain);
    assert!(unchanged.delta.is_none(), "field-free copies keep their exact bytes");
    let corrupt = json!({ "$virgultum:internal:text$": true, "delta": [{ "insert": "cached live text", "attributes": { FIELD_ATTRIBUTE: field } }] });
    assert!(crate::snapshot_rich_text_plain_text(&corrupt).is_err());
  }
}
