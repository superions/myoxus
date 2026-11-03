// SPDX-License-Identifier: AGPL-3.0-or-later
//! Private edit coordinates from original native text, independent of display labels.

use crate::DocumentTextRangeUnit;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use yrs::{Any, Map, ReadTxn, Text};

/// Exact typed native footnote marker payload. Local footnotes carry the
/// definition identity; citations carry the reference payload (MTE-13b).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFootnote {
  pub label: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub definition_id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub reference: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTextSpan {
  pub start: u32,
  pub end: u32,
  pub text: Option<String>,
  pub bold: bool,
  pub italic: bool,
  pub strike: bool,
  pub code: bool,
  pub underline: bool,
  pub link: Option<String>,
  pub color: Option<String>,
  pub background: Option<String>,
  pub label_tone: Option<String>,
  /// Semantic content retains its source width even before its authoring API exists.
  pub protected: bool,
  /// Canonical identity only; the body and offsets remain in this native span.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub annotation_id: Option<String>,
  /// Public external document key and authored label; navigation params stay native.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub reference: Option<crate::MarkdownDocumentReference>,
  /// Absence means the containing workspace. Preserve explicit malformed/null
  /// scopes so authorization consumers cannot reinterpret them as absence.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub reference_workspace: Option<serde_json::Value>,
  /// Private native identity only. MCP filters current member visibility; the
  /// historical notification link is never part of this editing projection.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub mention: Option<crate::NativeMemberMention>,
  /// Inline formula source; adjacent native spaces may be coalesced in this run.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub latex: Option<String>,
  /// Exact typed native footnote marker payload; the span text is the single
  /// native space.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub footnote: Option<NativeFootnote>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTextField {
  pub field: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub row_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub column_id: Option<String>,
  pub range_unit: DocumentTextRangeUnit,
  pub length: u32,
  pub spans: Vec<NativeTextSpan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBlockText {
  pub kind: String,
  pub fields: Vec<NativeTextField>,
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub properties: BTreeMap<String, serde_json::Value>,
}

fn field(text: &yrs::TextRef, txn: &impl ReadTxn, name: &str) -> NativeTextField {
  let mut position = 0;
  let spans = text
    .diff(txn, |_| ())
    .into_iter()
    .map(|chunk| {
      let attrs = chunk.attributes.as_deref();
      let flag = |name: &str| matches!(attrs.and_then(|attrs| attrs.get(name)), Some(Any::Bool(true)));
      let string = |name: &str| match attrs.and_then(|attrs| attrs.get(name)) {
        Some(Any::String(value)) => Some(value.to_string()),
        _ => None,
      };
      let source = match chunk.insert {
        yrs::Out::Any(Any::String(value)) => Some(value.to_string()),
        _ => None,
      };
      let start = position;
      position += source.as_ref().map_or(1, |text| text.len() as u32);
      let protected = source.is_none()
        || attrs.is_some_and(|attrs| {
          ["latex", "reference", "mention", "footnote", "annotation"]
            .iter()
            .any(|name| attrs.contains_key(*name))
        });
      NativeTextSpan {
        start,
        end: position,
        text: source,
        bold: flag("bold"),
        italic: flag("italic"),
        strike: flag("strike"),
        code: flag("code"),
        underline: flag("underline"),
        link: string("link"),
        color: string("color"),
        background: string("background"),
        label_tone: string("labelTone"),
        protected,
        annotation_id: crate::annotation::annotation_id(attrs).map(str::to_string),
        mention: attrs.and_then(|attrs| match attrs.get("mention")? {
          Any::Map(value) => match value.get("member")? {
            Any::String(member) if !member.is_empty() => Some(crate::NativeMemberMention {
              member: member.to_string(),
            }),
            _ => None,
          },
          _ => None,
        }),
        reference: attrs.and_then(|attrs| match attrs.get("reference")? {
          Any::Map(value) => {
            let Any::String(page_id) = value.get("pageId")? else {
              return None;
            };
            if page_id.is_empty() {
              return None;
            }
            Some(crate::MarkdownDocumentReference {
              page_id: page_id.to_string(),
              title: match value.get("title") {
                Some(Any::String(title)) => Some(title.to_string()),
                _ => None,
              },
              description: match value.get("description") {
                Some(Any::String(description)) => Some(description.to_string()),
                _ => None,
              },
              // Private export/edit consumers need the exact navigation
              // occurrence, not only a Page identity. URL owners still admit
              // the supported keys before producing navigable destinations.
              params: value.get("params").map(crate::yjs_any_to_json),
            })
          }
          _ => None,
        }),
        reference_workspace: attrs.and_then(|attrs| match attrs.get("reference")? {
          Any::Map(value) => value.get("workspaceId").map(crate::yjs_any_to_json),
          _ => None,
        }),
        latex: attrs.and_then(|attrs| match attrs.get("latex")? {
          Any::String(value) => Some(value.to_string()),
          _ => None,
        }),
        footnote: attrs.and_then(|attrs| match attrs.get("footnote")? {
          Any::Map(value) => {
            let label = value.get("label").and_then(|value| match value {
              Any::String(label) => Some(label.to_string()),
              _ => None,
            })?;
            Some(NativeFootnote {
              definition_id: value.get("definitionId").and_then(|value| match value {
                Any::String(id) if !id.is_empty() => Some(id.to_string()),
                _ => None,
              }),
              reference: value.get("reference").map(|value| crate::yjs_any_to_json(value)),
              label,
            })
          }
          _ => None,
        }),
      }
    })
    .collect();
  NativeTextField {
    field: name.into(),
    row_id: None,
    column_id: None,
    range_unit: DocumentTextRangeUnit::Utf8Bytes,
    length: position,
    spans,
  }
}

/// Called in the projection's existing read transaction; never loads another head.
pub fn native_block_text(block: &yrs::MapRef, txn: &impl ReadTxn) -> Option<NativeBlockText> {
  let kind = match block.get(txn, "sys:flavour").or_else(|| block.get(txn, "flavour")) {
    Some(yrs::Out::Any(Any::String(value))) => crate::resolve_flavour(&value).to_string(),
    _ => return None,
  };
  if !matches!(
    kind.as_str(),
    "myoxus:paragraph"
      | "myoxus:list"
      | "myoxus:callout"
      | "myoxus:code"
      | "myoxus:table"
      | "myoxus:latex"
      | "myoxus:mermaid"
      | "myoxus:annotation"
      | "myoxus:page"
      | "myoxus:note"
      | "myoxus:footnote-definition"
      | "myoxus:bookmark"
      | "myoxus:embed-linked-doc"
      | "myoxus:attachment"
  ) {
    return None;
  }
  // Only recognized citation cards are enriched; arbitrary embeds stay out of
  // the private native projection.
  if matches!(
    kind.as_str(),
    "myoxus:bookmark" | "myoxus:embed-linked-doc" | "myoxus:attachment"
  ) && crate::markdown::native_citation_definition(block, txn).is_none()
  {
    return None;
  }
  let mut fields = Vec::new();
  for name in ["text", "title", "source"] {
    if let Some(yrs::Out::YText(text)) = block.get(txn, &format!("prop:{name}")).or_else(|| block.get(txn, name)) {
      fields.push(field(&text, txn, name));
    }
  }
  if kind == "myoxus:latex" {
    // The block formula source is a native plain string, not a YText field.
    if let Some(yrs::Out::Any(Any::String(source))) = block.get(txn, "prop:latex") {
      let length = source.len() as u32;
      fields.push(NativeTextField {
        field: "source".into(),
        row_id: None,
        column_id: None,
        range_unit: DocumentTextRangeUnit::Utf8Bytes,
        length,
        spans: vec![NativeTextSpan {
          start: 0,
          end: length,
          text: Some(source.to_string()),
          bold: false,
          italic: false,
          strike: false,
          code: false,
          underline: false,
          link: None,
          color: None,
          background: None,
          label_tone: None,
          protected: false,
          annotation_id: None,
          reference: None,
          reference_workspace: None,
          mention: None,
          latex: None,
          footnote: None,
        }],
      });
    }
  }
  if kind == "myoxus:table" {
    for (key, value) in block.iter(txn) {
      let Some(coordinate) = key
        .strip_prefix("prop:cells.")
        .and_then(|key| key.strip_suffix(".text"))
      else {
        continue;
      };
      let Some((row, column)) = coordinate.split_once(':') else {
        continue;
      };
      if let yrs::Out::YText(text) = value {
        let mut cell = field(&text, txn, "text");
        cell.row_id = Some(row.into());
        cell.column_id = Some(column.into());
        fields.push(cell);
      }
    }
    fields.sort_by(|left, right| (&left.row_id, &left.column_id).cmp(&(&right.row_id, &right.column_id)));
  }
  let properties = if kind == "myoxus:table" {
    crate::document_mutation::table::read_axis_properties(block, txn)
  } else {
    crate::document_properties::read(block, txn, &kind)
  };
  Some(NativeBlockText {
    kind,
    fields,
    properties,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use yrs::Transact;

  #[test]
  fn embeds_without_mark_attributes_are_protected_at_their_native_width() {
    let doc = yrs::Doc::new();
    let block = doc.get_or_insert_map("block");
    let mut txn = doc.transact_mut();
    block.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
    let text = block.insert(&mut txn, "prop:text", yrs::TextPrelim::new("é😀"));
    text.insert_embed(&mut txn, 6, Any::Map(Default::default()));
    let native = native_block_text(&block, &txn).unwrap();
    let field = &native.fields[0];
    assert_eq!(field.length, 7);
    assert_eq!(field.spans[1].start, 6);
    assert_eq!(field.spans[1].end, 7);
    assert!(field.spans[1].text.is_none());
    assert!(field.spans[1].protected);
  }
}
