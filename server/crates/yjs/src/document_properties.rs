// SPDX-License-Identifier: AGPL-3.0-or-later
//! Typed ordinary text properties for the existing native mutation owner.

use crate::document_mutation::{
  DocumentAttributeChange as Change, DocumentBlockProperties, DocumentMutationError as Error, DocumentPaletteColor,
};
use serde::{Deserialize, Serialize};
use yrs::{Map, ReadTxn};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentTextAlignment {
  Left,
  Center,
  Right,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentParagraphPresentation {
  Eyebrow,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentCalloutAppearance {
  Soft,
  Accent,
  Outline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum DocumentCalloutIcon {
  #[serde(rename = "emoji")]
  Emoji { unicode: String },
  #[serde(rename = "myoxus-icon")]
  MyoxusIcon { name: String, color: DocumentPaletteColor },
}

/// Null is not omission: explicit resets use the existing set/remove contract.
pub(crate) fn present_option<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
  d: D,
) -> Result<Option<T>, D::Error> {
  T::deserialize(d).map(Some)
}

pub(crate) fn validate_values(p: &DocumentBlockProperties) -> Result<(), Error> {
  if let Some(table) = &p.table {
    crate::document_mutation::table::validate_presentation(table)?;
  }
  if let Some(Change::Set { value }) = &p.callout_type {
    let mut chars = value.chars();
    if value.len() > 128
      || !chars.next().is_some_and(|c| c.is_ascii_alphabetic())
      || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
      return Err(Error::InvalidBlockProperties);
    }
  }
  if let Some(Change::Set { value }) = &p.background_color_name {
    if value != "default" && serde_json::from_value::<DocumentPaletteColor>(serde_json::json!(value)).is_err() {
      return Err(Error::InvalidBlockProperties);
    }
  }
  if let Some(Change::Set { value }) = &p.caption {
    if value.chars().count() > 4096 {
      return Err(Error::InvalidBlockProperties);
    }
  }
  if let Some(Change::Set { value }) = &p.order {
    // The editor uses JS integer positions; preserve exact native numbers.
    if value.unsigned_abs() > 9_007_199_254_740_991 {
      return Err(Error::InvalidBlockProperties);
    }
  }
  if let Some(Change::Set { value }) = &p.icon {
    let valid = match value {
      DocumentCalloutIcon::Emoji { unicode } => {
        !unicode.is_empty() && unicode.chars().count() <= 64 && !unicode.chars().any(char::is_control)
      }
      DocumentCalloutIcon::MyoxusIcon { name, .. } => {
        // Reuse the editor's canonical glyph catalog, not a second allowlist.
        static NAMES: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
        NAMES
          .get_or_init(|| {
            serde_json::from_str(include_str!("../../../../virgultum/icons/src/icon-names.json"))
              .expect("canonical icon catalog")
          })
          .contains(&format!("{name}Icon"))
      }
    };
    if !valid {
      return Err(Error::InvalidBlockProperties);
    }
  }
  if let Some(label) = &p.label {
    // Newly authored labels are admitted through the existing Markdown parser;
    // normalization alone is not syntax validation.
    if !crate::markdown::valid_footnote_label(label) {
      return Err(Error::InvalidBlockProperties);
    }
  }
  if let Some(value) = &p.latex {
    // Bound the block formula source the same way the fragment-creation path
    // bounds it, so `update_block_properties` cannot write an unbounded source.
    if value.len() > crate::document_mutation::MAX_FRAGMENT_TEXT_BYTES {
      return Err(Error::InvalidBlockProperties);
    }
  }
  Ok(())
}

/// Validate the resulting kind before changing any property. This is also
/// called for fragments, whose native kind is already known before admission.
pub(crate) fn validate_kind(p: &DocumentBlockProperties, kind: &str, subtype: Option<&str>) -> Result<(), Error> {
  validate_values(p)?;
  let paragraph = kind == "myoxus:paragraph";
  let list = kind == "myoxus:list";
  let callout = kind == "myoxus:callout";
  let code = kind == "myoxus:code";
  let footnote_definition = kind == "myoxus:footnote-definition";
  let heading = matches!(subtype, Some("h1" | "h2" | "h3" | "h4" | "h5" | "h6"));
  if p.table.is_some() && kind != "myoxus:table"
    || p.label.is_some() && !footnote_definition
    || p.placement.is_some() && !footnote_definition
    || p.text_align.is_some() && !(paragraph || list)
    || p.presentation.is_some() && !paragraph
    || matches!(p.presentation, Some(Change::Set { .. })) && !matches!(subtype, None | Some("text"))
    || p.collapsed.is_some() && !(list || paragraph && heading)
    || p.order.is_some() && !list
    || matches!(p.order, Some(Change::Set { .. })) && subtype != Some("numbered")
    || [
      p.callout_type.is_some(),
      p.icon.is_some(),
      p.background_color_name.is_some(),
      p.appearance.is_some(),
      p.foldable.is_some(),
      p.default_open.is_some(),
    ]
    .into_iter()
    .any(|v| v)
      && !callout
    || [
      p.wrap.is_some(),
      p.caption.is_some(),
      p.preview.is_some(),
      p.line_number.is_some(),
    ]
    .into_iter()
    .any(|v| v)
      && !code
  {
    return Err(Error::InvalidBlockProperties);
  }
  Ok(())
}

pub(crate) fn write<T: Serialize>(
  block: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  key: &str,
  change: &Option<Change<T>>,
) -> Result<(), Error> {
  match change {
    Some(Change::Set { value }) => {
      let value = crate::json_to_yjs_any(&serde_json::to_value(value).map_err(|_| Error::InvalidBlockProperties)?)
        .map_err(|_| Error::InvalidBlockProperties)?;
      block.insert(txn, format!("prop:{key}"), value);
    }
    Some(Change::Remove {}) => {
      block.remove(txn, &format!("prop:{key}"));
    }
    None => {}
  }
  Ok(())
}

pub(crate) fn update(
  block: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  p: &DocumentBlockProperties,
) -> Result<(), Error> {
  if let Some(table) = &p.table {
    crate::document_mutation::table::update_presentation(block, txn, table)?;
  }
  write(block, txn, "textAlign", &p.text_align)?;
  write(block, txn, "presentation", &p.presentation)?;
  write(block, txn, "collapsed", &p.collapsed)?;
  write(block, txn, "order", &p.order)?;
  write(block, txn, "type", &p.callout_type)?;
  write(block, txn, "backgroundColorName", &p.background_color_name)?;
  write(block, txn, "appearance", &p.appearance)?;
  write(block, txn, "foldable", &p.foldable)?;
  write(block, txn, "defaultOpen", &p.default_open)?;
  write(block, txn, "wrap", &p.wrap)?;
  write(block, txn, "caption", &p.caption)?;
  write(block, txn, "preview", &p.preview)?;
  write(block, txn, "lineNumber", &p.line_number)?;
  if let Some(icon) = &p.icon {
    let native = match icon {
      Change::Remove {} => Change::Remove {},
      Change::Set { value } => {
        let mut json = serde_json::to_value(value).map_err(|_| Error::InvalidBlockProperties)?;
        if let DocumentCalloutIcon::MyoxusIcon { color, .. } = value {
          json["color"] = color.native_value(true).into();
        }
        Change::Set { value: json }
      }
    };
    write(block, txn, "icon", &Some(native))?;
  }
  Ok(())
}

/// Relevant native properties only; unknown authored strings remain read-only.
pub(crate) fn read(
  block: &yrs::MapRef,
  txn: &impl ReadTxn,
  kind: &str,
) -> std::collections::BTreeMap<String, serde_json::Value> {
  let names: &[&str] = match kind {
    "myoxus:paragraph" => &["type", "textAlign", "presentation", "collapsed"],
    "myoxus:list" => &["type", "textAlign", "checked", "collapsed", "order"],
    "myoxus:callout" => &[
      "type",
      "icon",
      "backgroundColorName",
      "appearance",
      "foldable",
      "defaultOpen",
    ],
    "myoxus:code" => &["language", "wrap", "caption", "preview", "lineNumber"],
    "myoxus:footnote-definition" => &["label", "placement"],
    "myoxus:latex" => &["latex"],
    _ => &["type"],
  };
  let mut properties: std::collections::BTreeMap<String, serde_json::Value> = names
    .iter()
    .filter_map(|name| {
      let yrs::Out::Any(value) = block.get(txn, &format!("prop:{name}"))? else {
        return None;
      };
      let mut json = crate::yjs_any_to_json(&value);
      let valid = match *name {
        "icon" => {
          // Only text icon metadata belongs to this projection; media stays with
          // its existing owner and unknown stored data is never rewritten.
          if let Some(icon) = json.as_object_mut() {
            icon.retain(|k, v| ["type", "unicode", "name", "color"].contains(&k.as_str()) && v.is_string());
            true
          } else {
            false
          }
        }
        "collapsed" | "checked" | "foldable" | "defaultOpen" | "wrap" | "preview" | "lineNumber" => {
          json.is_boolean() || json.is_null()
        }
        "order" => json.is_number() || json.is_null(),
        _ => json.is_string() || json.is_null(),
      };
      valid.then_some(((*name).into(), json))
    })
    .collect();
  // Only recognized citation cards expose the typed source projection; arbitrary
  // embeds of the same flavour stay out of the private readback.
  if matches!(
    kind,
    "myoxus:bookmark" | "myoxus:embed-linked-doc" | "myoxus:attachment"
  ) && let Some((label, reference)) = crate::markdown::native_citation_definition(block, txn)
  {
    properties.insert(
      "citation".into(),
      serde_json::json!({"label": label, "reference": reference}),
    );
  }
  properties
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::document_mutation::{DocumentFragment, DocumentMutation, apply_document_mutation};
  use serde_json::{Value, json};
  use yrs::{Transact, updates::decoder::Decode};
  fn native(state: &[u8], id: &str) -> (crate::native_text::NativeBlockText, Value, Vec<String>) {
    let doc = yrs::Doc::new();
    doc
      .transact_mut()
      .apply_update(yrs::Update::decode_v1(state).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let txn = doc.transact();
    let yrs::Out::YMap(block) = blocks.get(&txn, id).unwrap() else {
      panic!("native block")
    };
    (
      crate::native_text::native_block_text(&block, &txn).unwrap(),
      crate::yjs_any_to_json(&yrs::types::ToJson::to_json(&block, &txn)),
      ["prop:text", "prop:title"]
        .into_iter()
        .filter_map(|key| match block.get(&txn, key) {
          Some(yrs::Out::YText(text)) => Some(format!("{:?}", AsRef::<yrs::branch::Branch>::as_ref(&text).id())),
          _ => None,
        })
        .collect(),
    )
  }
  #[test]
  fn latex_property_is_bounded_like_fragment_creation() {
    let mut props = DocumentBlockProperties::default();
    props.latex = Some("x".repeat(crate::document_mutation::MAX_FRAGMENT_TEXT_BYTES + 1));
    assert!(validate_values(&props).is_err());
    props.latex = Some("x".repeat(crate::document_mutation::MAX_FRAGMENT_TEXT_BYTES));
    assert!(validate_values(&props).is_ok());
  }
  #[test]
  fn properties_share_creation_updates_resets_and_resulting_kind_validation() {
    let original = crate::markdown_to_yjs("Properties", "Protected neighbor").unwrap();
    let fragment:DocumentFragment=serde_json::from_value(json!({"schemaVersion":crate::DOCUMENT_FRAGMENT_SCHEMA,"blocks":[
      {"kind":"heading","level":2,"spans":[{"text":"Heading é😀","bold":true}],"properties":{"textAlign":{"action":"set","value":"center"},"collapsed":{"action":"set","value":false}}},
      {"kind":"list_item","listKind":"numbered","spans":[{"text":"List","underline":true}],"children":[{"kind":"paragraph","spans":[{"text":"Child"}]}],"properties":{"order":{"action":"set","value":7},"collapsed":{"action":"set","value":true},"textAlign":{"action":"set","value":"right"}}},
      {"kind":"callout","title":"Plain title","calloutType":"info","spans":[{"text":"Body","italic":true}],"properties":{"icon":{"action":"set","value":{"type":"myoxus-icon","name":"Info","color":"blue"}},"backgroundColorName":{"action":"set","value":"yellow"},"appearance":{"action":"set","value":"accent"},"foldable":{"action":"set","value":true},"defaultOpen":{"action":"set","value":false}}},
      {"kind":"code","language":"rust","text":"let value = 1;","properties":{"wrap":{"action":"set","value":true},"caption":{"action":"set","value":"Caption"},"preview":{"action":"set","value":false},"lineNumber":{"action":"set","value":true}}},
      {"kind":"paragraph","spans":[{"text":"Eyebrow"}],"properties":{"presentation":{"action":"set","value":"eyebrow"}}}
    ]})).unwrap();
    let output = apply_document_mutation(&original, &DocumentMutation::AppendBlocks { fragment }).unwrap();
    let ids = output.inserted_block_ids;
    let mut state = output.state;
    let doc = yrs::Doc::new();
    doc
      .transact_mut()
      .apply_update(yrs::Update::decode_v1(&state).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    let yrs::Out::YMap(heading) = blocks.get(&txn, &ids[0]).unwrap() else {
      panic!("heading")
    };
    heading.insert(
      &mut txn,
      "prop:comments",
      yrs::Any::Map(std::sync::Arc::new(std::collections::HashMap::from([(
        "anchor-protected".into(),
        yrs::Any::Bool(true),
      )]))),
    );
    heading.insert(&mut txn, "prop:markdownAnchor", "retained-source-anchor");
    state = txn.encode_state_as_update_v1(&yrs::StateVector::default());
    drop(txn);
    let snapshots: Vec<_> = ids.iter().map(|id| native(&state, id)).collect();
    assert_eq!(snapshots[0].0.properties["textAlign"], "center");
    assert_eq!(snapshots[4].0.properties["presentation"], "eyebrow");
    assert_eq!(snapshots[0].0.properties["collapsed"], false);
    assert_eq!(snapshots[1].0.properties["order"].as_f64(), Some(7.0));
    assert_eq!(snapshots[1].0.properties["textAlign"], "right");
    assert_eq!(snapshots[1].0.properties["collapsed"], true);
    assert_eq!(
      snapshots[2].0.properties["icon"],
      json!({"type":"myoxus-icon","name":"Info","color":"var(--myoxus-text-highlight-foreground-blue)"})
    );
    assert_eq!(snapshots[2].0.properties["appearance"], "accent");
    assert_eq!(snapshots[2].0.properties["backgroundColorName"], "yellow");
    assert_eq!(snapshots[2].0.properties["foldable"], true);
    assert_eq!(snapshots[2].0.properties["defaultOpen"], false);
    assert_eq!(snapshots[3].0.properties["wrap"], true);
    assert_eq!(snapshots[3].0.properties["caption"], "Caption");
    assert_eq!(snapshots[3].0.properties["preview"], false);
    assert_eq!(snapshots[3].0.properties["lineNumber"], true);
    let mutate = |state: &[u8], id: &str, properties: Value| {
      apply_document_mutation(
        state,
        &DocumentMutation::UpdateBlockProperties {
          block_id: id.into(),
          properties: serde_json::from_value(properties).unwrap(),
        },
      )
    };
    state = mutate(
      &state,
      &ids[1],
      json!({"listKind":"todo","checked":true,"order":{"action":"remove"}}),
    )
    .unwrap()
    .state;
    assert_eq!(native(&state, &ids[1]).0.properties["type"], "todo");
    assert_eq!(native(&state, &ids[1]).0.properties["checked"], true);
    state=mutate(&state,&ids[2],json!({"calloutType":{"action":"set","value":"warning"},"icon":{"action":"set","value":{"type":"emoji","unicode":"⚠️"}}})).unwrap().state;
    assert_eq!(native(&state, &ids[2]).0.properties["type"], "warning");
    assert_eq!(
      native(&state, &ids[2]).0.properties["icon"],
      json!({"type":"emoji","unicode":"⚠️"})
    );
    for (index, keys) in [
      vec!["textAlign", "presentation", "collapsed"],
      vec!["textAlign", "collapsed", "order"],
      vec![
        "calloutType",
        "icon",
        "backgroundColorName",
        "appearance",
        "foldable",
        "defaultOpen",
      ],
      vec!["wrap", "caption", "preview", "lineNumber"],
      vec!["presentation"],
    ]
    .into_iter()
    .enumerate()
    {
      let reset = Value::Object(
        keys
          .iter()
          .map(|key| ((*key).into(), json!({"action":"remove"})))
          .collect(),
      );
      state = mutate(&state, &ids[index], reset).unwrap().state;
      let current = native(&state, &ids[index]);
      assert_eq!(current.0.fields, snapshots[index].0.fields);
      assert_eq!(current.2, snapshots[index].2, "shared text identities");
      for key in [
        "sys:children",
        "sys:id",
        "sys:flavour",
        "prop:comments",
        "prop:markdownAnchor",
      ] {
        assert_eq!(current.1[key], snapshots[index].1[key], "{key}");
      }
      for key in keys {
        assert!(
          !current
            .0
            .properties
            .contains_key(if key == "calloutType" { "type" } else { key }),
          "{key}"
        );
      }
    }
    for (id, properties) in [
      (&ids[0], json!({"wrap":{"action":"set","value":true}})),
      (&ids[0], json!({"presentation":{"action":"set","value":"eyebrow"}})),
      (&ids[1], json!({"order":{"action":"set","value":7}})),
      (&ids[2], json!({"backgroundColorName":{"action":"set","value":"#fff"}})),
      (
        &ids[2],
        json!({"icon":{"action":"set","value":{"type":"myoxus-icon","name":"UnknownUnshippedGlyph","color":"blue"}}}),
      ),
    ] {
      assert_eq!(mutate(&state, id, properties), Err(Error::InvalidBlockProperties));
    }
    for invalid in [
      json!({"wrap":null}),
      json!({"wrap":{"action":"remove","value":false}}),
      json!({"wrap":{"action":"set","value":true,"ignored":1}}),
      json!({"unknown":true}),
    ] {
      assert!(serde_json::from_value::<DocumentBlockProperties>(invalid).is_err());
    }
  }
}
