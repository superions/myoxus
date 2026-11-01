// SPDX-License-Identifier: AGPL-3.0-or-later
//! Direct semantic mutations for active Virgultum Yjs documents.
//!
//! The helpers in this module operate on the canonical block map and emit only
//! the CRDT delta and its private post-mutation projection state. They do not parse or
//! generate Markdown/HTML and never expose Yjs clocks to callers.

pub use crate::document_properties::{
  DocumentCalloutAppearance, DocumentCalloutIcon, DocumentParagraphPresentation, DocumentTextAlignment,
};

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;
use yrs::types::Attrs;
use yrs::updates::decoder::Decode;
use yrs::{Any, Array, GetString, Map, ReadTxn, Text, Transact, Update};

use super::{
  MarkdownDocumentReference, YjsTextSegment, create_yjs_block, create_yjs_table_block, create_yjs_text_block,
  insert_yjs_segments, resolve_flavour,
};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTextSegment {
  pub text: String,
  #[serde(default)]
  pub bold: bool,
  #[serde(default)]
  pub italic: bool,
  #[serde(default)]
  pub strike: bool,
  #[serde(default)]
  pub code: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub underline: Option<bool>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub color: Option<DocumentPaletteColor>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub background: Option<DocumentPaletteColor>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label_tone: Option<DocumentLabelTone>,
  /// Inline formula source; stored runs may coalesce adjacent native spaces.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub latex: Option<String>,
  /// Private native formula provenance, never admitted from structured input.
  /// Serialized only for semantic replay identity; native copying must retain
  /// attributes not represented by the authoring palette or reading renderer.
  #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
  pub native_latex_attributes: Option<serde_json::Value>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub link: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub reference: Option<MarkdownDocumentReference>,
  /// Native citation payload or a local definition identity, rebound on insertion.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub footnote: Option<serde_json::Value>,
  /// Insertion-local grouping key, rebound to a fresh native identity on insertion.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub annotation_id: Option<String>,
  /// One native space with a member identity; authorization belongs to the caller.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub mention: Option<crate::NativeMemberMention>,
}

impl From<&DocumentTextSegment> for YjsTextSegment {
  fn from(value: &DocumentTextSegment) -> Self {
    Self {
      text: value.text.clone(),
      bold: value.bold,
      italic: value.italic,
      strike: value.strike,
      code: value.code,
      underline: value.underline.unwrap_or(false),
      color: value.color.map(|color| color.native_value(true)),
      background: value.background.map(|color| color.native_value(false)),
      label_tone: value.label_tone.map(|tone| tone.as_str().to_string()),
      latex: value.latex.clone(),
      native_latex_attributes: value.native_latex_attributes.clone(),
      link: value.link.clone(),
      reference: value.reference.clone(),
      footnote: value.footnote.clone(),
      annotation: value.annotation_id.clone(),
      mention: value.mention.clone(),
      ..Self::default()
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum DocumentFragmentBlock {
  Paragraph {
    #[serde(
      default,
      skip_serializing_if = "Option::is_none",
      deserialize_with = "crate::document_properties::present_option"
    )]
    properties: Option<DocumentBlockProperties>,
    #[serde(rename = "spans", alias = "text")]
    text: Vec<DocumentTextSegment>,
  },
  Heading {
    #[serde(
      default,
      skip_serializing_if = "Option::is_none",
      deserialize_with = "crate::document_properties::present_option"
    )]
    properties: Option<DocumentBlockProperties>,
    level: u8,
    #[serde(rename = "spans", alias = "text")]
    text: Vec<DocumentTextSegment>,
  },
  ListItem {
    #[serde(
      default,
      skip_serializing_if = "Option::is_none",
      deserialize_with = "crate::document_properties::present_option"
    )]
    properties: Option<DocumentBlockProperties>,
    list_kind: DocumentListKind,
    #[serde(rename = "spans", alias = "text")]
    text: Vec<DocumentTextSegment>,
    #[serde(default)]
    checked: bool,
    #[serde(default)]
    children: Vec<DocumentFragmentBlock>,
  },
  Quote {
    #[serde(
      default,
      skip_serializing_if = "Option::is_none",
      deserialize_with = "crate::document_properties::present_option"
    )]
    properties: Option<DocumentBlockProperties>,
    #[serde(rename = "spans", alias = "text")]
    text: Vec<DocumentTextSegment>,
  },
  Callout {
    #[serde(
      default,
      skip_serializing_if = "Option::is_none",
      deserialize_with = "crate::document_properties::present_option"
    )]
    properties: Option<DocumentBlockProperties>,
    #[serde(rename = "spans", alias = "text")]
    text: Vec<DocumentTextSegment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    callout_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    foldable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_open: Option<bool>,
    #[serde(default)]
    children: Vec<DocumentFragmentBlock>,
  },
  FootnoteDefinition {
    /// Fragment-local identity; the writer allocates the persisted block ID.
    definition_id: String,
    label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    placement: Option<crate::footnote::FootnotePlacement>,
    children: Vec<DocumentFragmentBlock>,
  },
  CitationDefinition {
    label: String,
    reference: serde_json::Value,
  },
  Code {
    #[serde(
      default,
      skip_serializing_if = "Option::is_none",
      deserialize_with = "crate::document_properties::present_option"
    )]
    properties: Option<DocumentBlockProperties>,
    /// Imported native formula provenance; not a new structured authoring kind.
    #[serde(default, skip_deserializing, skip_serializing_if = "std::ops::Not::not")]
    native_latex: bool,
    #[serde(default)]
    language: String,
    text: String,
  },
  Annotation {
    text: String,
  },
  /// Native block formula; authored source maps to the editor's `myoxus:latex` block.
  Latex {
    latex: String,
  },
  Mermaid {
    source: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    caption: String,
  },
  Divider,
  Image {
    source: String,
    #[serde(default)]
    alt: String,
  },
  Bookmark {
    url: String,
    #[serde(default)]
    title: String,
  },
  Table {
    #[serde(
      default,
      skip_serializing_if = "Option::is_none",
      deserialize_with = "crate::document_properties::present_option"
    )]
    properties: Option<DocumentTableProperties>,
    rows: Vec<Vec<Vec<DocumentTextSegment>>>,
    /// Leading native header rows; omission preserves the shipped absent property.
    #[serde(
      default,
      skip_serializing_if = "Option::is_none",
      deserialize_with = "deserialize_header_rows"
    )]
    header_rows: Option<usize>,
  },
}

/// A supplied count is an integer, never JSON null. Missing fields use the default.
fn deserialize_header_rows<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<usize>, D::Error> {
  usize::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentListKind {
  Bulleted,
  Numbered,
  Todo,
}

/// Public text positions, distinct from CRDT identities. Omitting the unit
/// preserves the shipped UTF-8 byte offsets; combining marks are separate
/// Unicode scalars, not grapheme clusters. Native embeds consume one position.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentTextRangeUnit {
  Utf8Bytes,
  Utf16CodeUnits,
  UnicodeScalars,
}

/// Public field names, never caller-supplied Yjs property keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentTextField {
  Text,
  Title,
}

/// The editor palette, stored as theme references rather than resolved colors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentPaletteColor {
  Red,
  Orange,
  Yellow,
  Green,
  Teal,
  Blue,
  Purple,
  Grey,
}

impl DocumentPaletteColor {
  pub fn native_value(self, foreground: bool) -> String {
    let name = match self {
      Self::Red => "red",
      Self::Orange => "orange",
      Self::Yellow => "yellow",
      Self::Green => "green",
      Self::Teal => "teal",
      Self::Blue => "blue",
      Self::Purple => "purple",
      Self::Grey => "grey",
    };
    format!(
      "var(--myoxus-text-highlight-{}{name})",
      if foreground { "foreground-" } else { "" }
    )
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentLabelTone {
  Neutral,
  Info,
  Positive,
  Warning,
  Danger,
  Accent,
}

impl DocumentLabelTone {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Neutral => "neutral",
      Self::Info => "info",
      Self::Positive => "positive",
      Self::Warning => "warning",
      Self::Danger => "danger",
      Self::Accent => "accent",
    }
  }
}

/// Removal has an empty named payload so Serde rejects ignored extra fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum DocumentAttributeChange<T> {
  Set { value: T },
  Remove {},
}

/// Only these native marks may be changed; omitted fields preserve existing
/// attributes, while false flags remove the mark rather than storing false.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentTextFormatting {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub underline: Option<bool>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub color: Option<DocumentAttributeChange<DocumentPaletteColor>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub background: Option<DocumentAttributeChange<DocumentPaletteColor>>,
  #[serde(default, skip_serializing_if = "Option::is_none", rename = "labelTone")]
  pub label_tone: Option<DocumentAttributeChange<DocumentLabelTone>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub bold: Option<bool>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub italic: Option<bool>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub strike: Option<bool>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub code: Option<bool>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub link: Option<DocumentTextLinkChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum DocumentTextLinkChange {
  Set { href: String },
  // A named empty variant enforces deny_unknown_fields for removal too.
  Remove {},
}

impl DocumentTextFormatting {
  pub fn is_empty(&self) -> bool {
    self.bold.is_none()
      && self.italic.is_none()
      && self.strike.is_none()
      && self.code.is_none()
      && self.link.is_none()
      && self.underline.is_none()
      && self.color.is_none()
      && self.background.is_none()
      && self.label_tone.is_none()
  }
  fn native_attributes(&self) -> Attrs {
    let mut attributes = Attrs::new();
    for (name, value) in [
      ("bold", self.bold),
      ("italic", self.italic),
      ("strike", self.strike),
      ("code", self.code),
      ("underline", self.underline),
    ] {
      if let Some(value) = value {
        attributes.insert(name.into(), if value { Any::Bool(true) } else { Any::Null });
      }
    }
    for (name, change) in [("color", &self.color), ("background", &self.background)] {
      if let Some(change) = change {
        attributes.insert(
          name.into(),
          match change {
            DocumentAttributeChange::Set { value } => Any::String(value.native_value(name == "color").into()),
            DocumentAttributeChange::Remove {} => Any::Null,
          },
        );
      }
    }
    if let Some(change) = &self.label_tone {
      attributes.insert(
        "labelTone".into(),
        match change {
          DocumentAttributeChange::Set { value } => Any::String(value.as_str().into()),
          DocumentAttributeChange::Remove {} => Any::Null,
        },
      );
    }
    if let Some(link) = &self.link {
      attributes.insert(
        "link".into(),
        match link {
          DocumentTextLinkChange::Set { href } => Any::String(href.as_str().into()),
          DocumentTextLinkChange::Remove {} => Any::Null,
        },
      );
    }
    attributes
  }
}

pub const DOCUMENT_FRAGMENT_SCHEMA: &str = "myoxus.document-fragment.v1";
const MAX_FRAGMENT_BLOCKS: usize = 10_000;
const MAX_FRAGMENT_DEPTH: usize = 64;
pub(crate) const MAX_FRAGMENT_TEXT_BYTES: usize = 1024 * 1024;
const MAX_REFERENCE_LABEL_BYTES: usize = 4 * 1024;

fn default_fragment_schema() -> String {
  DOCUMENT_FRAGMENT_SCHEMA.to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFragment {
  pub schema_version: String,
  pub blocks: Vec<DocumentFragmentBlock>,
}

impl Default for DocumentFragment {
  fn default() -> Self {
    Self {
      schema_version: default_fragment_schema(),
      blocks: Vec::new(),
    }
  }
}

/// Native paragraph/list targets. Cross-flavour conversion replaces the model
/// because an open editor binds its model class when the block is constructed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentTextBlockKind {
  Paragraph,
  Quote,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Bulleted,
  Numbered,
  Todo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum DocumentMutation {
  AppendBlocks {
    fragment: DocumentFragment,
  },
  PrependBlocks {
    fragment: DocumentFragment,
  },
  InsertAfterBlock {
    block_id: String,
    fragment: DocumentFragment,
  },
  ReplaceBlock {
    block_id: String,
    fragment: DocumentFragment,
  },
  ReplaceHeadingSection {
    heading: String,
    fragment: DocumentFragment,
  },
  AppendToHeading {
    heading: String,
    fragment: DocumentFragment,
  },
  DeleteBlock {
    block_id: String,
  },
  MoveBlock {
    block_id: String,
    after_block_id: Option<String>,
    parent_block_id: Option<String>,
  },
  ConvertBlock {
    block_id: String,
    block_kind: DocumentTextBlockKind,
  },
  DuplicateBlock {
    block_id: String,
  },
  SplitBlock {
    block_id: String,
    position: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    range_unit: Option<DocumentTextRangeUnit>,
  },
  JoinBlocks {
    block_id: String,
    source_block_id: String,
  },
  EditText {
    block_id: String,
    start: u32,
    end: u32,
    replacement: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    replacement_spans: Option<Vec<DocumentTextSegment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text_field: Option<DocumentTextField>,
    // Omitted fields retain the serialized payload of admitted shipped writes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    range_unit: Option<DocumentTextRangeUnit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_text: Option<String>,
  },
  EditAnnotation {
    block_id: String,
    annotation_id: String,
    start: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    range_unit: Option<DocumentTextRangeUnit>,
    replacement: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    row_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    column_id: Option<String>,
  },
  FormatText {
    block_id: String,
    start: u32,
    end: u32,
    formatting: DocumentTextFormatting,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    row_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    column_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    range_unit: Option<DocumentTextRangeUnit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_text: Option<String>,
  },
  UpdateTableCoordinateProperties {
    block_id: String,
    axis: DocumentTableAxis,
    id: String,
    properties: DocumentTableCoordinateProperties,
  },
  EditTableAxis {
    block_id: String,
    axis: DocumentTableAxis,
    change: DocumentTableAxisChange,
  },
  EditTableCell {
    block_id: String,
    row_id: String,
    column_id: String,
    start: u32,
    end: u32,
    replacement: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    replacement_spans: Option<Vec<DocumentTextSegment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    range_unit: Option<DocumentTextRangeUnit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_text: Option<String>,
  },
  UpdateBlockProperties {
    block_id: String,
    properties: DocumentBlockProperties,
  },
  /// Consistently revise one citation source across every inline occurrence and
  /// its optional native source card. The selector is the existing normalized
  /// label; at least one of `new_label` / `reference` is required. Omission
  /// preserves that part; a supplied reference replaces the source fields.
  UpdateCitation {
    label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    new_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reference: Option<serde_json::Value>,
  },
  InsertLinkedPageReference {
    target_external_id: String,
    label: String,
    after_block_id: Option<String>,
  },
  ReplaceAll {
    fragment: DocumentFragment,
  },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
// New fields are omitted from old semantic payloads. Shipped plain properties
// retain their original serialization and meaning.
pub struct DocumentBlockProperties {
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub table: Option<DocumentTableProperties>,
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub text_align: Option<DocumentAttributeChange<DocumentTextAlignment>>,

  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub presentation: Option<DocumentAttributeChange<DocumentParagraphPresentation>>,

  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub collapsed: Option<DocumentAttributeChange<bool>>,

  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub order: Option<DocumentAttributeChange<i64>>,

  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub callout_type: Option<DocumentAttributeChange<String>>,

  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub icon: Option<DocumentAttributeChange<DocumentCalloutIcon>>,

  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub background_color_name: Option<DocumentAttributeChange<String>>,

  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub appearance: Option<DocumentAttributeChange<DocumentCalloutAppearance>>,

  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub foldable: Option<DocumentAttributeChange<bool>>,

  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub default_open: Option<DocumentAttributeChange<bool>>,

  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub wrap: Option<DocumentAttributeChange<bool>>,

  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub caption: Option<DocumentAttributeChange<String>>,

  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub preview: Option<DocumentAttributeChange<bool>>,

  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub line_number: Option<DocumentAttributeChange<bool>>,

  pub heading_level: Option<u8>,
  pub list_kind: Option<DocumentListKind>,
  pub checked: Option<bool>,
  pub language: Option<String>,
  pub alt: Option<String>,
  pub title: Option<String>,
  pub url: Option<String>,
  /// Omission preserves designation and the hashes of shipped property edits.
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "deserialize_header_rows"
  )]
  pub header_rows: Option<usize>,
  /// Local footnote definition label; only `myoxus:footnote-definition` admits
  /// it. Set-only: a rename, not a set/remove; omission preserves the label.
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub label: Option<String>,
  /// Local footnote placement; only `myoxus:footnote-definition` admits it.
  /// Remove reverts to the legacy absent footnote default without rewriting
  /// stored data.
  #[serde(
    default,
    skip_serializing_if = "Option::is_none",
    deserialize_with = "crate::document_properties::present_option"
  )]
  pub placement: Option<DocumentAttributeChange<crate::footnote::FootnotePlacement>>,
  /// Block formula source; only `myoxus:latex` admits it. Omission preserves
  /// the source; an explicit empty string clears it without deleting or
  /// converting the block.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub latex: Option<String>,
}

impl DocumentMutation {
  pub const fn name(&self) -> &'static str {
    match self {
      Self::AppendBlocks { .. } => "append_blocks",
      Self::PrependBlocks { .. } => "prepend_blocks",
      Self::InsertAfterBlock { .. } => "insert_after_block",
      Self::ReplaceBlock { .. } => "replace_block",
      Self::ReplaceHeadingSection { .. } => "replace_heading_section",
      Self::AppendToHeading { .. } => "append_to_heading",
      Self::DeleteBlock { .. } => "delete_block",
      Self::MoveBlock { .. } => "move_block",
      Self::ConvertBlock { .. } => "convert_block",
      Self::DuplicateBlock { .. } => "duplicate_block",
      Self::SplitBlock { .. } => "split_block",
      Self::JoinBlocks { .. } => "join_blocks",
      Self::EditText { .. } => "edit_text",
      Self::EditAnnotation { .. } => "edit_annotation",
      Self::FormatText { .. } => "format_text",
      Self::EditTableCell { .. } => "edit_table_cell",
      Self::EditTableAxis { axis, change, .. } => change.name(*axis),
      Self::UpdateTableCoordinateProperties {
        axis: DocumentTableAxis::Row,
        ..
      } => "update_table_row_properties",
      Self::UpdateTableCoordinateProperties {
        axis: DocumentTableAxis::Column,
        ..
      } => "update_table_column_properties",
      Self::UpdateBlockProperties { .. } => "update_block_properties",
      Self::UpdateCitation { .. } => "update_citation",
      Self::InsertLinkedPageReference { .. } => "insert_linked_page_reference",
      Self::ReplaceAll { .. } => "replace_all",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentMutationOutput {
  pub delta: Vec<u8>,
  /// Full post-mutation state, captured before another writer can contribute.
  pub state: Vec<u8>,
  pub inserted_block_ids: Vec<String>,
  pub removed_block_ids: Vec<String>,
  /// Existing native units changed indirectly, e.g. contiguous list numbering.
  pub updated_block_ids: Vec<String>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum DocumentMutationError {
  #[error("canonical Yjs document state is invalid")]
  InvalidDocument,
  #[error("document has no active page/note content root")]
  MissingContentRoot,
  #[error("target block was not found")]
  TargetNotFound,
  #[error("target heading is ambiguous")]
  AmbiguousHeading,
  #[error("document fragment is empty")]
  EmptyFragment,
  #[error("document fragment contains an invalid block")]
  InvalidFragment,
  #[error("text range is invalid")]
  InvalidTextRange,
  #[error("selected text differs from the expected original text")]
  ExpectedTextMismatch,
  #[error("block move would create a cycle")]
  MoveCycle,
  #[error("block properties are invalid for this block")]
  InvalidBlockProperties,
}

/// Apply one semantic operation and return the minimal Yjs v1 delta.
pub fn apply_document_mutation(
  state: &[u8],
  mutation: &DocumentMutation,
) -> Result<DocumentMutationOutput, DocumentMutationError> {
  validate_mutation_fragment(mutation)?;
  // Pin the shipped indexing policy instead of depending on future Yrs defaults.
  let doc = yrs::Doc::with_options(yrs::Options {
    offset_kind: yrs::OffsetKind::Bytes,
    ..Default::default()
  });
  let blocks = doc.get_or_insert_map("blocks");
  if !state.is_empty() {
    let update = Update::decode_v1(state).map_err(|_| DocumentMutationError::InvalidDocument)?;
    doc
      .transact_mut()
      .apply_update(update)
      .map_err(|_| DocumentMutationError::InvalidDocument)?;
  }
  let before = doc.transact().state_vector();
  let unchanged_delta = doc.transact().encode_diff_v1(&before);
  let mut inserted = Vec::new();
  let mut removed = Vec::new();
  let mut updated = Vec::new();

  {
    let mut txn = doc.transact_mut();
    let content_root = find_content_root(&blocks, &txn).ok_or(DocumentMutationError::MissingContentRoot)?;
    validate_destination_citations(&blocks, &txn, mutation)?;
    match mutation {
      DocumentMutation::AppendBlocks { fragment } => {
        let ids = create_fragment(&blocks, &mut txn, fragment)?;
        for id in &ids {
          content_root.push_back(&mut txn, id.as_str());
        }
        inserted.extend(ids);
      }
      DocumentMutation::PrependBlocks { fragment } => {
        let ids = create_fragment(&blocks, &mut txn, fragment)?;
        insert_ids(&content_root, &mut txn, 0, &ids);
        inserted.extend(ids);
      }
      DocumentMutation::InsertAfterBlock { block_id, fragment } => {
        let (parent_map, parent, index) = structure::unique_parent(&blocks, &txn, block_id)?;
        structure::require_fragment_parent(&parent_map, &txn, fragment)?;
        let ids = create_fragment(&blocks, &mut txn, fragment)?;
        insert_ids(&parent, &mut txn, index + 1, &ids);
        inserted.extend(ids);
      }
      DocumentMutation::ReplaceBlock { block_id, fragment } => {
        let (parent, index) = find_parent(&blocks, &txn, block_id).ok_or(DocumentMutationError::TargetNotFound)?;
        let ids = create_fragment(&blocks, &mut txn, fragment)?;
        parent.remove(&mut txn, index);
        collect_and_remove_subtree(&blocks, &mut txn, block_id, &mut removed);
        insert_ids(&parent, &mut txn, index, &ids);
        inserted.extend(ids);
      }
      DocumentMutation::ReplaceHeadingSection { heading, fragment } => {
        let (start, end) = heading_section(&blocks, &txn, &content_root, heading)?;
        let ids = create_fragment(&blocks, &mut txn, fragment)?;
        // The selected heading is the stable section anchor. Replace only its
        // body, matching the shipped Markdown-facing operation while avoiding
        // a lossy export/import roundtrip.
        let body_start = start + 1;
        let old = array_string_values(&content_root, &txn)[body_start as usize..end as usize].to_vec();
        for _ in body_start..end {
          content_root.remove(&mut txn, body_start);
        }
        for id in old {
          collect_and_remove_subtree(&blocks, &mut txn, &id, &mut removed);
        }
        insert_ids(&content_root, &mut txn, body_start, &ids);
        inserted.extend(ids);
      }
      DocumentMutation::AppendToHeading { heading, fragment } => {
        let (_, end) = heading_section(&blocks, &txn, &content_root, heading)?;
        let ids = create_fragment(&blocks, &mut txn, fragment)?;
        insert_ids(&content_root, &mut txn, end, &ids);
        inserted.extend(ids);
      }
      DocumentMutation::DeleteBlock { block_id } => {
        let (parent, index) = find_parent(&blocks, &txn, block_id).ok_or(DocumentMutationError::TargetNotFound)?;
        parent.remove(&mut txn, index);
        collect_and_remove_subtree(&blocks, &mut txn, block_id, &mut removed);
      }
      DocumentMutation::MoveBlock {
        block_id,
        after_block_id,
        parent_block_id,
      } => {
        let source = structure::native_block(&blocks, &txn, block_id)?;
        let (_, source_parent, source_index) = structure::unique_parent(&blocks, &txn, block_id)?;
        let destination_map = if let Some(parent_id) = parent_block_id {
          if parent_id == block_id || is_descendant(&blocks, &txn, block_id, parent_id) {
            return Err(DocumentMutationError::MoveCycle);
          }
          let yrs::Out::YMap(parent) = blocks
            .get(&txn, parent_id)
            .ok_or(DocumentMutationError::TargetNotFound)?
          else {
            return Err(DocumentMutationError::TargetNotFound);
          };
          parent
        } else {
          blocks
            .iter(&txn)
            .find_map(|(_, value)| match value {
              yrs::Out::YMap(map) if block_array(&map, &txn, "children").as_ref() == Some(&content_root) => Some(map),
              _ => None,
            })
            .ok_or(DocumentMutationError::MissingContentRoot)?
        };
        structure::require_parent(&destination_map, &txn, &structure::flavour(&source, &txn))?;
        let destination_parent =
          block_array(&destination_map, &txn, "children").ok_or(DocumentMutationError::TargetNotFound)?;
        let destination_index = if let Some(after_id) = after_block_id {
          let (_, after_parent, after_index) = structure::unique_parent(&blocks, &txn, after_id)?;
          if after_parent != destination_parent {
            return Err(DocumentMutationError::TargetNotFound);
          }
          after_index + 1
        } else {
          0
        };
        source_parent.remove(&mut txn, source_index);
        let adjusted_index = if source_parent == destination_parent && source_index < destination_index {
          destination_index - 1
        } else {
          destination_index
        };
        destination_parent.insert(&mut txn, adjusted_index, block_id.as_str());
      }
      DocumentMutation::ConvertBlock { block_id, block_kind } => {
        convert_text_block(&blocks, &mut txn, block_id, *block_kind, &mut inserted, &mut removed)?;
      }
      DocumentMutation::DuplicateBlock { block_id } => {
        structure::duplicate_text_subtree(&blocks, &mut txn, block_id, &mut inserted)?;
      }
      DocumentMutation::SplitBlock {
        block_id,
        position,
        range_unit,
      } => {
        structure::split_text_block(
          &blocks,
          &mut txn,
          block_id,
          *position,
          *range_unit,
          &mut inserted,
          &mut updated,
        )?;
      }
      DocumentMutation::JoinBlocks {
        block_id,
        source_block_id,
      } => {
        structure::join_text_blocks(&blocks, &mut txn, block_id, source_block_id, &mut removed)?;
      }
      DocumentMutation::EditText {
        block_id,
        start,
        end,
        replacement,
        replacement_spans,
        text_field,
        range_unit,
        expected_text,
      } => {
        let yrs::Out::YMap(block) = blocks
          .get(&txn, block_id)
          .ok_or(DocumentMutationError::TargetNotFound)?
        else {
          return Err(DocumentMutationError::TargetNotFound);
        };
        let text = resolve_text_field(&block, &mut txn, *text_field, replacement_spans.is_some())?;
        let (start, end) = resolve_text_range(&text, &txn, *start, *end, *range_unit, expected_text.as_deref())?;
        text.remove_range(&mut txn, start, end - start);
        if *text_field == Some(DocumentTextField::Title) {
          // The editor's title input admits plain text, independently of old stored marks.
          text.insert_with_attributes(&mut txn, start, replacement, Default::default());
        } else {
          insert_replacement(&text, &mut txn, start, replacement, replacement_spans.as_deref());
        }
      }
      DocumentMutation::EditAnnotation {
        block_id,
        annotation_id,
        start,
        range_unit,
        replacement,
        expected_text,
        row_id,
        column_id,
      } => {
        let yrs::Out::YMap(block) = blocks
          .get(&txn, block_id)
          .ok_or(DocumentMutationError::TargetNotFound)?
        else {
          return Err(DocumentMutationError::TargetNotFound);
        };
        let text = match (row_id, column_id) {
          (Some(row), Some(column)) => resolve_table_cell(&block, &txn, row, column)?,
          (None, None) => resolve_text_field(&block, &mut txn, None, true)?,
          _ => return Err(DocumentMutationError::InvalidBlockProperties),
        };
        let (start, _) = resolve_text_range(&text, &txn, *start, *start, *range_unit, None)?;
        crate::annotation::replace_body(
          &text,
          &mut txn,
          annotation_id,
          start,
          replacement,
          expected_text.as_deref(),
        )?;
      }
      DocumentMutation::FormatText {
        block_id,
        start,
        end,
        formatting,
        row_id,
        column_id,
        range_unit,
        expected_text,
      } => {
        let yrs::Out::YMap(block) = blocks
          .get(&txn, block_id)
          .ok_or(DocumentMutationError::TargetNotFound)?
        else {
          return Err(DocumentMutationError::TargetNotFound);
        };
        let text = match (row_id, column_id) {
          (Some(row), Some(column)) => resolve_table_cell(&block, &txn, row, column)?,
          // Preserve the shipped default target; only new rich replacement
          // admits a narrower set of editable rich-text kinds.
          (None, None) => resolve_text_field(&block, &mut txn, None, false)?,
          _ => return Err(DocumentMutationError::InvalidBlockProperties),
        };
        let (start, end) = resolve_text_range(&text, &txn, *start, *end, *range_unit, expected_text.as_deref())?;
        if start == end {
          return Err(DocumentMutationError::InvalidTextRange);
        }
        // Keep the shared TextRef and change only the supplied marks.
        text.format(&mut txn, start, end - start, formatting.native_attributes());
      }
      DocumentMutation::UpdateTableCoordinateProperties {
        block_id,
        axis,
        id,
        properties,
      } => {
        table::update_coordinate(&blocks, &mut txn, block_id, *axis, id, properties)?;
        updated.push(block_id.clone());
      }
      DocumentMutation::EditTableAxis { block_id, axis, change } => {
        table::edit_axis(&blocks, &mut txn, block_id, *axis, change)?;
        updated.push(block_id.clone());
      }
      DocumentMutation::EditTableCell {
        block_id,
        row_id,
        column_id,
        start,
        end,
        replacement,
        replacement_spans,
        range_unit,
        expected_text,
      } => {
        let yrs::Out::YMap(block) = blocks
          .get(&txn, block_id)
          .ok_or(DocumentMutationError::TargetNotFound)?
        else {
          return Err(DocumentMutationError::TargetNotFound);
        };
        let text = resolve_table_cell(&block, &txn, row_id, column_id)?;
        let (start, end) = resolve_text_range(&text, &txn, *start, *end, *range_unit, expected_text.as_deref())?;
        text.remove_range(&mut txn, start, end - start);
        insert_replacement(&text, &mut txn, start, replacement, replacement_spans.as_deref());
      }
      DocumentMutation::UpdateBlockProperties { block_id, properties } => {
        // A citation bookmark card's url/title is a semantic source field: route
        // it through the citation updater so every inline marker and the card
        // stay consistent. Ordinary bookmarks retain the plain property behavior.
        let routed = blocks.get(&txn, block_id).and_then(|value| match value {
          yrs::Out::YMap(block) => {
            let flavour = block_string(&block, &txn, "flavour").unwrap_or_default();
            (resolve_flavour(&flavour) == "myoxus:bookmark"
              && block_string(&block, &txn, "style").as_deref() == Some("citation")
              && (properties.url.is_some() || properties.title.is_some()))
            .then(|| crate::markdown::native_citation_definition(&block, &txn))
            .flatten()
          }
          _ => None,
        });
        if let Some((label, card_reference)) = routed {
          // This forwarding path only consumes source fields. Reject the whole
          // request rather than silently dropping unrelated block properties.
          if properties
            != &(DocumentBlockProperties {
              url: properties.url.clone(),
              title: properties.title.clone(),
              ..Default::default()
            })
          {
            return Err(DocumentMutationError::InvalidBlockProperties);
          }
          // Base the url/title change on the authoritative inline reference, not
          // the possibly-stale card copy, so the correct source of every inline
          // marker is preserved.
          let selector = crate::markdown::normalize_footnote_label(&label);
          let source = collect_citation_source(&blocks, &txn, &selector);
          let base_reference = if !source.inline.is_empty() {
            canonical_reference(&label, &source.inline[0].4)?
          } else {
            card_reference
          };
          let mut new_reference = base_reference;
          if let Some(url) = &properties.url {
            if url.trim().is_empty() {
              return Err(DocumentMutationError::InvalidBlockProperties);
            }
            new_reference["url"] = serde_json::Value::String(url.clone());
          }
          if let Some(title) = &properties.title {
            new_reference["title"] = serde_json::Value::String(title.clone());
          }
          update_citation_source(
            &blocks,
            &mut txn,
            &label,
            None,
            Some(&new_reference),
            &mut updated,
            &mut inserted,
            &mut removed,
          )?;
        } else {
          let marker_ids = update_block_properties(&blocks, &mut txn, block_id, properties)?;
          updated.push(block_id.clone());
          updated.extend(marker_ids);
        }
      }
      DocumentMutation::UpdateCitation {
        label,
        new_label,
        reference,
      } => {
        update_citation_source(
          &blocks,
          &mut txn,
          label,
          new_label.as_deref(),
          reference.as_ref(),
          &mut updated,
          &mut inserted,
          &mut removed,
        )?;
      }
      DocumentMutation::InsertLinkedPageReference {
        target_external_id,
        label,
        after_block_id,
      } => {
        let id = create_linked_page_reference_block(&blocks, &mut txn, target_external_id, label);
        if let Some(after_block_id) = after_block_id {
          let (parent, index) =
            find_parent(&blocks, &txn, after_block_id).ok_or(DocumentMutationError::TargetNotFound)?;
          parent.insert(&mut txn, index + 1, id.as_str());
        } else {
          content_root.push_back(&mut txn, id.as_str());
        }
        inserted.push(id);
      }
      DocumentMutation::ReplaceAll { fragment } => {
        let ids = if fragment.blocks.is_empty() {
          Vec::new()
        } else {
          create_fragment(&blocks, &mut txn, fragment)?
        };
        let old = array_string_values(&content_root, &txn);
        for _ in 0..old.len() {
          content_root.remove(&mut txn, 0);
        }
        for id in old {
          collect_and_remove_subtree(&blocks, &mut txn, &id, &mut removed);
        }
        insert_ids(&content_root, &mut txn, 0, &ids);
        inserted.extend(ids);
      }
    }
  }

  if let DocumentMutation::EditTableAxis { block_id, .. } = mutation {
    // Inspect only the edited table's findings using the existing repeat rules.
    // This is still a disposable local snapshot: a rejection emits no delta or
    // persisted write, and never evaluates or expands a template prototype.
    let (_, diagnostics) =
      crate::native_template_repeat::inspect(&doc, &blocks, &mut std::collections::BTreeSet::new());
    if diagnostics.iter().any(|finding| finding.block_id == *block_id) {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
  }

  // Fragment creation returns roots whose descendants are all new. Structural
  // split/conversion already report their new IDs and retain existing children.
  let txn = doc.transact_mut();
  if !matches!(
    mutation,
    DocumentMutation::ConvertBlock { .. } | DocumentMutation::SplitBlock { .. }
  ) {
    let mut seen: HashSet<String> = inserted.iter().cloned().collect();
    let mut position = 0;
    while position < inserted.len() {
      if let Some(yrs::Out::YMap(block)) = blocks.get(&txn, &inserted[position]) {
        if let Some(children) = block_array(&block, &txn, "children") {
          for child in array_string_values(&children, &txn) {
            if seen.insert(child.clone()) {
              inserted.push(child);
            }
          }
        }
      }
      position += 1;
    }
  }
  validate_native_footnotes(&blocks, &txn)?;
  let delta = txn.encode_diff_v1(&before);
  // Deltas include pre-existing delete sets even for a no-op. Preserve the
  // input state in that case so write owners can compare without decoding again.
  let state = if delta == unchanged_delta {
    state.to_vec()
  } else {
    txn.encode_diff_v1(&yrs::StateVector::default())
  };
  Ok(DocumentMutationOutput {
    delta,
    state,
    inserted_block_ids: inserted,
    removed_block_ids: removed,
    updated_block_ids: updated,
  })
}

/// Resolve encoding boundaries against native rich text before any change.
/// `get_string` omits embeds, so its byte offsets would target the wrong text
/// after an embed. Diff traversal retains their one-position indexing without
/// changing their identities or attributes. An expected string cannot attest
/// to deleting embedded content and fails closed for such a selection.
fn resolve_text_range(
  text: &yrs::TextRef,
  txn: &impl ReadTxn,
  start: u32,
  end: u32,
  unit: Option<DocumentTextRangeUnit>,
  expected: Option<&str>,
) -> Result<(u32, u32), DocumentMutationError> {
  if start > end {
    return Err(DocumentMutationError::InvalidTextRange);
  }
  let unit = unit.unwrap_or(DocumentTextRangeUnit::Utf8Bytes);
  let mut requested_position = 0_u64;
  let mut native_position = 0_u64;
  let mut native_start = None;
  let mut native_end = None;
  let mut selected = String::new();
  let mut selected_embed = false;
  let mut visit = |character: Option<char>| {
    if requested_position == u64::from(start) {
      native_start = Some(native_position);
    }
    if requested_position == u64::from(end) {
      native_end = Some(native_position);
    }
    if let Some(character) = character {
      let width = match unit {
        DocumentTextRangeUnit::Utf8Bytes => character.len_utf8(),
        DocumentTextRangeUnit::Utf16CodeUnits => character.len_utf16(),
        DocumentTextRangeUnit::UnicodeScalars => 1,
      } as u64;
      if expected.is_some() && requested_position >= u64::from(start) && requested_position + width <= u64::from(end) {
        selected.push(character);
      }
      requested_position += width;
      native_position += character.len_utf8() as u64;
    } else {
      selected_embed |= requested_position >= u64::from(start) && requested_position < u64::from(end);
      requested_position += 1;
      native_position += 1;
    }
  };
  for chunk in text.diff(txn, |_| ()) {
    if let yrs::Out::Any(Any::String(value)) = chunk.insert {
      for character in value.chars() {
        visit(Some(character));
      }
    } else {
      visit(None);
    }
  }
  // Also admit the empty insertion range at the end of the native text.
  if requested_position == u64::from(start) {
    native_start = Some(native_position);
  }
  if requested_position == u64::from(end) {
    native_end = Some(native_position);
  }
  let (Some(start), Some(end)) = (native_start, native_end) else {
    return Err(DocumentMutationError::InvalidTextRange);
  };
  if native_position != u64::from(text.len(txn)) {
    return Err(DocumentMutationError::InvalidTextRange);
  }
  if expected.is_some_and(|expected| selected_embed || expected != selected) {
    return Err(DocumentMutationError::ExpectedTextMismatch);
  }
  Ok((
    u32::try_from(start).map_err(|_| DocumentMutationError::InvalidTextRange)?,
    u32::try_from(end).map_err(|_| DocumentMutationError::InvalidTextRange)?,
  ))
}

/// Byte-range resolution for plain-string sources (block formulas) that have no
/// native embeds. Mirrors [`resolve_text_range`] unit semantics.
fn resolve_table_cell(
  block: &yrs::MapRef,
  txn: &impl ReadTxn,
  row: &str,
  column: &str,
) -> Result<yrs::TextRef, DocumentMutationError> {
  if resolve_flavour(&block_string(block, txn, "flavour").unwrap_or_default()) != "myoxus:table" {
    return Err(DocumentMutationError::InvalidBlockProperties);
  }
  for (key, id) in [
    (format!("prop:rows.{row}.rowId"), row),
    (format!("prop:columns.{column}.columnId"), column),
  ] {
    if !matches!(block.get(txn, &key), Some(yrs::Out::Any(Any::String(value))) if value.as_ref() == id) {
      return Err(DocumentMutationError::TargetNotFound);
    }
  }
  match block.get(txn, &format!("prop:cells.{row}:{column}.text")) {
    Some(yrs::Out::YText(text)) => Ok(text),
    _ => Err(DocumentMutationError::TargetNotFound),
  }
}

fn resolve_text_field(
  block: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  field: Option<DocumentTextField>,
  rich: bool,
) -> Result<yrs::TextRef, DocumentMutationError> {
  let kind = block_string(block, txn, "flavour").unwrap_or_default();
  let title = field == Some(DocumentTextField::Title);
  if title && (rich || resolve_flavour(&kind) != "myoxus:callout")
    || rich
      && !matches!(
        resolve_flavour(&kind),
        "myoxus:paragraph" | "myoxus:list" | "myoxus:callout"
      )
  {
    return Err(DocumentMutationError::InvalidBlockProperties);
  }
  let name = if title { "title" } else { "text" };
  match block.get(txn, &format!("prop:{name}")).or_else(|| block.get(txn, name)) {
    Some(yrs::Out::YText(text)) => Ok(text),
    None | Some(yrs::Out::Any(Any::Undefined | Any::Null)) if title => {
      // An absent optional title is materialized under the canonical lock.
      // Existing titles always keep their shared identity and anchors.
      Ok(block.insert(txn, "prop:title", yrs::TextPrelim::new("")))
    }
    _ => Err(DocumentMutationError::InvalidBlockProperties),
  }
}

fn insert_replacement(
  text: &yrs::TextRef,
  txn: &mut yrs::TransactionMut<'_>,
  start: u32,
  plain: &str,
  rich: Option<&[DocumentTextSegment]>,
) {
  if let Some(rich) = rich {
    insert_yjs_segments(text, txn, start, &segments(rich, &mut HashMap::new()));
  } else {
    // Shipped plain calls retain Yjs's adjacent-style inheritance.
    text.insert(txn, start, plain);
  }
}

/// Shared span/atom and byte-budget validation for fragments and replacements.
/// Destination-bound footnote identities are checked again on the locked state.
pub fn validate_document_text_segments(spans: &[DocumentTextSegment]) -> Result<(), DocumentMutationError> {
  let mut bytes = 0usize;
  let mut add = |text: &str| {
    bytes = bytes.saturating_add(text.len());
    if bytes > MAX_FRAGMENT_TEXT_BYTES {
      Err(DocumentMutationError::InvalidFragment)
    } else {
      Ok(())
    }
  };
  for span in spans {
    validate_fragment_span(span, &mut add)?;
  }
  Ok(())
}

pub fn validate_mutation_fragment(mutation: &DocumentMutation) -> Result<(), DocumentMutationError> {
  if let DocumentMutation::EditAnnotation {
    annotation_id,
    replacement,
    expected_text,
    row_id,
    column_id,
    ..
  } = mutation
  {
    if annotation_id.is_empty()
      || annotation_id.len() > 4096
      || replacement.len() > MAX_FRAGMENT_TEXT_BYTES
      || expected_text
        .as_ref()
        .is_some_and(|text| text.len() > MAX_FRAGMENT_TEXT_BYTES)
      || row_id.is_some() != column_id.is_some()
    {
      return Err(DocumentMutationError::InvalidFragment);
    }
  }
  if let DocumentMutation::UpdateTableCoordinateProperties { axis, properties, .. } = mutation {
    table::validate_coordinate_properties(*axis, properties)?;
  }
  if let DocumentMutation::UpdateBlockProperties { properties, .. } = mutation {
    crate::document_properties::validate_values(properties)?;
  }
  if let DocumentMutation::UpdateCitation {
    label,
    new_label,
    reference,
  } = mutation
  {
    if crate::markdown::normalize_footnote_label(label).is_empty()
      || new_label.is_none() && reference.is_none()
      || new_label
        .as_deref()
        .is_some_and(|value| !crate::markdown::valid_footnote_label(value))
      || reference
        .as_ref()
        .is_some_and(|value| crate::markdown::canonical_citation_reference(value, label).is_err())
    {
      return Err(DocumentMutationError::InvalidFragment);
    }
    return Ok(());
  }

  if let DocumentMutation::EditText {
    text_field: Some(DocumentTextField::Title),
    replacement,
    replacement_spans,
    ..
  } = mutation
  {
    if replacement_spans.is_some() || replacement.contains(['\r', '\n']) {
      return Err(DocumentMutationError::InvalidFragment);
    }
  }
  if let DocumentMutation::EditText {
    replacement,
    replacement_spans,
    ..
  }
  | DocumentMutation::EditTableCell {
    replacement,
    replacement_spans,
    ..
  } = mutation
  {
    if replacement.chars().count() > 1048576 || replacement_spans.is_some() && !replacement.is_empty() {
      return Err(DocumentMutationError::InvalidFragment);
    }
    if let Some(spans) = replacement_spans {
      validate_document_text_segments(spans)?;
    }
  }
  if let DocumentMutation::InsertLinkedPageReference {
    target_external_id,
    label,
    after_block_id,
  } = mutation
  {
    if target_external_id.trim().is_empty()
      || label.trim().is_empty()
      || label.len() > MAX_REFERENCE_LABEL_BYTES
      || after_block_id.as_ref().is_some_and(|value| value.trim().is_empty())
    {
      return Err(DocumentMutationError::InvalidFragment);
    }
    return Ok(());
  }
  if let DocumentMutation::FormatText { formatting, .. } = mutation {
    if formatting.is_empty()
      || matches!(&formatting.link, Some(DocumentTextLinkChange::Set { href }) if href.len() > 4096 || href.trim().is_empty())
    {
      return Err(DocumentMutationError::InvalidFragment);
    }
    return Ok(());
  }
  let fragment = match mutation {
    DocumentMutation::AppendBlocks { fragment }
    | DocumentMutation::PrependBlocks { fragment }
    | DocumentMutation::InsertAfterBlock { fragment, .. }
    | DocumentMutation::ReplaceBlock { fragment, .. }
    | DocumentMutation::ReplaceHeadingSection { fragment, .. }
    | DocumentMutation::AppendToHeading { fragment, .. }
    | DocumentMutation::ReplaceAll { fragment } => fragment,
    DocumentMutation::DeleteBlock { .. }
    | DocumentMutation::MoveBlock { .. }
    | DocumentMutation::DuplicateBlock { .. }
    | DocumentMutation::SplitBlock { .. }
    | DocumentMutation::JoinBlocks { .. }
    | DocumentMutation::ConvertBlock { .. }
    | DocumentMutation::EditText { .. }
    | DocumentMutation::EditAnnotation { .. }
    | DocumentMutation::FormatText { .. }
    | DocumentMutation::EditTableCell { .. }
    | DocumentMutation::EditTableAxis { .. }
    | DocumentMutation::UpdateTableCoordinateProperties { .. }
    | DocumentMutation::UpdateBlockProperties { .. } => return Ok(()),
    DocumentMutation::InsertLinkedPageReference { .. } => unreachable!("handled above"),
    DocumentMutation::UpdateCitation { .. } => unreachable!("handled above"),
  };
  if fragment.schema_version != DOCUMENT_FRAGMENT_SCHEMA {
    return Err(DocumentMutationError::InvalidFragment);
  }
  if fragment.blocks.is_empty() && !matches!(mutation, DocumentMutation::ReplaceAll { .. }) {
    return Err(DocumentMutationError::EmptyFragment);
  }
  let mut block_count = 0_usize;
  let mut text_bytes = 0_usize;
  validate_fragment_blocks(&fragment.blocks, 0, &mut block_count, &mut text_bytes)
}

fn create_linked_page_reference_block(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  target_external_id: &str,
  label: &str,
) -> String {
  let id = format!("mcp-block-{}", Uuid::new_v4().simple());
  let (block, _) = create_yjs_block(blocks, txn, &id, "myoxus:paragraph");
  let text = block.insert(txn, "prop:text", yrs::TextPrelim::new(""));
  let reference = HashMap::from([
    ("type".to_string(), Any::String(Arc::from("LinkedPage"))),
    (
      "pageId".to_string(),
      Any::String(Arc::from(target_external_id.to_string())),
    ),
    ("title".to_string(), Any::String(Arc::from(label.to_string()))),
  ]);
  // Virgultum's native reference inline is represented by one protected space;
  // the visible fallback label belongs to the reference payload's `title`.
  text.insert_with_attributes(
    txn,
    0,
    " ",
    Attrs::from([(Arc::from("reference"), Any::Map(Arc::new(reference)))]),
  );
  id
}

fn validate_fragment_blocks(
  blocks: &[DocumentFragmentBlock],
  depth: usize,
  block_count: &mut usize,
  text_bytes: &mut usize,
) -> Result<(), DocumentMutationError> {
  if depth > MAX_FRAGMENT_DEPTH {
    return Err(DocumentMutationError::InvalidFragment);
  }
  for block in blocks {
    if let Some((kind, subtype, properties)) = fragment_properties(block) {
      if properties.presentation.is_some() && !matches!(block, DocumentFragmentBlock::Paragraph { .. }) {
        return Err(DocumentMutationError::InvalidBlockProperties);
      }

      if [
        properties.heading_level.is_some(),
        properties.list_kind.is_some(),
        properties.checked.is_some(),
        properties.language.is_some(),
        properties.alt.is_some(),
        properties.title.is_some(),
        properties.url.is_some(),
        properties.header_rows.is_some(),
      ]
      .into_iter()
      .any(|v| v)
      {
        return Err(DocumentMutationError::InvalidBlockProperties);
      }
      if let DocumentFragmentBlock::Callout {
        callout_type,
        title: _,
        foldable,
        default_open,
        ..
      } = block
      {
        if callout_type.is_some() && properties.callout_type.is_some()
          || foldable.is_some() && properties.foldable.is_some()
          || default_open.is_some() && properties.default_open.is_some()
        {
          return Err(DocumentMutationError::InvalidBlockProperties);
        }
      }
      let strings = [&properties.callout_type, &properties.caption];
      let mut added = strings
        .into_iter()
        .filter_map(|v| match v {
          Some(DocumentAttributeChange::Set { value }) => Some(value.len()),
          _ => None,
        })
        .sum::<usize>();
      if let Some(DocumentAttributeChange::Set { value }) = &properties.icon {
        added = added.saturating_add(match value {
          DocumentCalloutIcon::Emoji { unicode } => unicode.len(),
          DocumentCalloutIcon::MyoxusIcon { name, .. } => name.len(),
        });
      }
      *text_bytes = text_bytes.saturating_add(added);
      if *text_bytes > MAX_FRAGMENT_TEXT_BYTES {
        return Err(DocumentMutationError::InvalidFragment);
      }
      crate::document_properties::validate_kind(properties, kind, subtype.as_deref())?;
    }
    *block_count = block_count.saturating_add(1);
    if *block_count > MAX_FRAGMENT_BLOCKS {
      return Err(DocumentMutationError::InvalidFragment);
    }
    let mut add_text = |value: &str| {
      *text_bytes = text_bytes.saturating_add(value.len());
      (*text_bytes <= MAX_FRAGMENT_TEXT_BYTES)
        .then_some(())
        .ok_or(DocumentMutationError::InvalidFragment)
    };
    let spans: &[DocumentTextSegment] = match block {
      DocumentFragmentBlock::Paragraph { text, .. }
      | DocumentFragmentBlock::Heading { text, .. }
      | DocumentFragmentBlock::Quote { text, .. }
      | DocumentFragmentBlock::ListItem { text, .. }
      | DocumentFragmentBlock::Callout { text, .. } => text,
      _ => &[],
    };
    for span in spans {
      validate_fragment_span(span, &mut add_text)?;
    }
    match block {
      DocumentFragmentBlock::ListItem { children, .. } => {
        validate_fragment_blocks(children, depth + 1, block_count, text_bytes)?
      }
      DocumentFragmentBlock::Callout {
        callout_type,
        title,
        children,
        ..
      } => {
        if let Some(value) = callout_type {
          add_text(value)?;
        }
        if let Some(value) = title {
          add_text(value)?;
        }
        if children.iter().any(|child| {
          !matches!(
            child,
            DocumentFragmentBlock::Paragraph { .. }
              | DocumentFragmentBlock::Heading { .. }
              | DocumentFragmentBlock::Quote { .. }
              | DocumentFragmentBlock::ListItem { .. }
              | DocumentFragmentBlock::Callout { .. }
              | DocumentFragmentBlock::Code { .. }
              | DocumentFragmentBlock::Annotation { .. }
          )
        }) {
          return Err(DocumentMutationError::InvalidFragment);
        }
        validate_fragment_blocks(children, depth + 1, block_count, text_bytes)?;
      }
      DocumentFragmentBlock::FootnoteDefinition {
        definition_id,
        label,
        children,
        ..
      } => {
        add_text(definition_id)?;
        add_text(label)?;
        if depth != 0 || definition_id.is_empty() || crate::markdown::normalize_footnote_label(label).is_empty() {
          return Err(DocumentMutationError::InvalidFragment);
        }
        if children.iter().any(|child| {
          matches!(
            child,
            DocumentFragmentBlock::FootnoteDefinition { .. }
              | DocumentFragmentBlock::CitationDefinition { .. }
              | DocumentFragmentBlock::Bookmark { .. }
          )
        }) {
          return Err(DocumentMutationError::InvalidFragment);
        }
        validate_fragment_blocks(children, depth + 1, block_count, text_bytes)?;
      }
      DocumentFragmentBlock::CitationDefinition { label, reference } => {
        add_text(label)?;
        add_text(&reference.to_string())?;
        canonical_reference(label, reference)?;
      }
      DocumentFragmentBlock::Code { language, text, .. } => {
        add_text(language)?;
        add_text(text)?;
      }
      DocumentFragmentBlock::Annotation { text } => add_text(text)?,
      DocumentFragmentBlock::Latex { latex } => add_text(latex)?,
      DocumentFragmentBlock::Mermaid { source, title, caption } => {
        add_text(source)?;
        add_text(title)?;
        add_text(caption)?;
      }
      DocumentFragmentBlock::Image { source, alt } => {
        add_text(source)?;
        add_text(alt)?;
      }
      DocumentFragmentBlock::Bookmark { url, title } => {
        add_text(url)?;
        add_text(title)?;
      }
      DocumentFragmentBlock::Table {
        rows,
        header_rows,
        properties,
      } => {
        if let Some(properties) = properties {
          table::validate_presentation(properties)?;
        }
        if header_rows.is_some_and(|count| count > rows.len()) {
          return Err(DocumentMutationError::InvalidFragment);
        }
        for span in rows.iter().flatten().flatten() {
          validate_fragment_span(span, &mut add_text)?;
        }
      }
      _ => {}
    }
  }
  Ok(())
}

#[derive(Default)]
struct NativeFootnotes {
  citations: HashMap<String, serde_json::Value>,
  definitions: HashMap<String, String>,
  references: Vec<(String, String)>,
}

fn insert_citation(
  claims: &mut NativeFootnotes,
  label: &str,
  reference: &serde_json::Value,
) -> Result<(), DocumentMutationError> {
  let key = crate::markdown::normalize_footnote_label(label);
  let reference = canonical_reference(label, reference)?;
  if claims.definitions.contains_key(&key)
    || claims
      .citations
      .get(&key)
      .is_some_and(|existing| existing != &reference)
  {
    return Err(DocumentMutationError::InvalidFragment);
  }
  claims.citations.insert(key, reference);
  Ok(())
}

fn native_footnotes(blocks: &yrs::MapRef, txn: &impl ReadTxn) -> Result<NativeFootnotes, DocumentMutationError> {
  fn inspect(
    value: yrs::Out,
    txn: &impl ReadTxn,
    claims: &mut NativeFootnotes,
    depth: usize,
  ) -> Result<(), DocumentMutationError> {
    if depth > MAX_FRAGMENT_DEPTH {
      return Err(DocumentMutationError::InvalidFragment);
    }
    match value {
      yrs::Out::YText(text) => {
        for diff in text.diff(txn, |_| ()) {
          if let Some(note) = diff.attributes.as_ref().and_then(|attrs| attrs.get("footnote")) {
            let note = crate::yjs_any_to_json(note);
            if note.get("reference").is_some() && note.get("definitionId").is_some() {
              return Err(DocumentMutationError::InvalidFragment);
            }
            let label = note["label"].as_str().ok_or(DocumentMutationError::InvalidFragment)?;
            if let Some(reference) = note.get("reference") {
              insert_citation(claims, label, reference)?;
            } else {
              let id = note["definitionId"]
                .as_str()
                .ok_or(DocumentMutationError::InvalidFragment)?;
              claims
                .references
                .push((crate::markdown::normalize_footnote_label(label), id.into()));
            }
          }
        }
      }
      yrs::Out::YMap(map) => {
        for (_, value) in map.iter(txn) {
          inspect(value, txn, claims, depth + 1)?;
        }
      }
      yrs::Out::YArray(array) => {
        for value in array.iter(txn) {
          inspect(value, txn, claims, depth + 1)?;
        }
      }
      _ => {}
    }
    Ok(())
  }
  let mut claims = NativeFootnotes::default();
  let mut parents = HashMap::new();
  for (id, value) in blocks.iter(txn) {
    let yrs::Out::YMap(block) = value else { continue };
    let flavour = block.get(txn, "sys:flavour").or_else(|| block.get(txn, "flavour"));
    let flavour = match flavour {
      Some(yrs::Out::Any(Any::String(value))) => value.to_string(),
      _ => String::new(),
    };
    if let Some(yrs::Out::YArray(children)) = block.get(txn, "sys:children").or_else(|| block.get(txn, "children")) {
      for value in children.iter(txn) {
        if let yrs::Out::Any(Any::String(child)) = value {
          parents
            .entry(child.to_string())
            .or_insert_with(Vec::new)
            .push((id.to_string(), flavour.clone()));
        }
      }
    }
    if resolve_flavour(&flavour) == "myoxus:footnote-definition" {
      let label = block.get(txn, "prop:label").or_else(|| block.get(txn, "label"));
      let Some(yrs::Out::Any(Any::String(label))) = label else {
        return Err(DocumentMutationError::InvalidFragment);
      };
      let label = crate::markdown::normalize_footnote_label(&label);
      if label.is_empty() || claims.definitions.insert(label, id.to_string()).is_some() {
        return Err(DocumentMutationError::InvalidFragment);
      }
    }
    inspect(yrs::Out::YMap(block), txn, &mut claims, 0)?;
  }
  for id in claims.definitions.values() {
    if parents
      .get(id)
      .is_none_or(|parents| parents.len() != 1 || resolve_flavour(&parents[0].1) != "myoxus:note")
    {
      return Err(DocumentMutationError::InvalidFragment);
    }
  }
  let inline_labels: HashSet<_> = claims.citations.keys().cloned().collect();
  // Inline payloads are authoritative, exactly as in the existing codec. Cards
  // with an already cited label are display copies, not competing provenance.
  for (_, value) in blocks.iter(txn) {
    if let yrs::Out::YMap(block) = value {
      if let Some((label, reference)) = crate::markdown::native_citation_definition(&block, txn) {
        if !inline_labels.contains(&crate::markdown::normalize_footnote_label(&label)) {
          insert_citation(&mut claims, &label, &reference)?;
        }
      }
    }
  }
  Ok(claims)
}

fn validate_native_footnotes(blocks: &yrs::MapRef, txn: &impl ReadTxn) -> Result<(), DocumentMutationError> {
  let claims = native_footnotes(blocks, txn)?;
  if claims
    .definitions
    .keys()
    .any(|label| claims.citations.contains_key(label))
    || claims
      .references
      .iter()
      .any(|(label, id)| claims.definitions.get(label) != Some(id))
  {
    return Err(DocumentMutationError::InvalidFragment);
  }
  Ok(())
}

/// Compare new claims with the current destination before removing any blocks.
/// A full replacement cannot quietly retarget a previously cited label either.
fn validate_destination_citations(
  blocks: &yrs::MapRef,
  txn: &impl ReadTxn,
  mutation: &DocumentMutation,
) -> Result<(), DocumentMutationError> {
  fn check_spans(spans: &[DocumentTextSegment], claims: &mut NativeFootnotes) -> Result<(), DocumentMutationError> {
    for span in spans {
      if let Some(note) = &span.footnote {
        if let Some(reference) = note.get("reference") {
          insert_citation(
            claims,
            note["label"].as_str().ok_or(DocumentMutationError::InvalidFragment)?,
            reference,
          )?;
        }
      }
    }
    Ok(())
  }
  if let DocumentMutation::EditText {
    replacement_spans: Some(replacement),
    ..
  }
  | DocumentMutation::EditTableCell {
    replacement_spans: Some(replacement),
    ..
  } = mutation
  {
    return check_spans(replacement, &mut native_footnotes(blocks, txn)?);
  }
  let fragment = match mutation {
    DocumentMutation::AppendBlocks { fragment }
    | DocumentMutation::PrependBlocks { fragment }
    | DocumentMutation::InsertAfterBlock { fragment, .. }
    | DocumentMutation::ReplaceBlock { fragment, .. }
    | DocumentMutation::ReplaceHeadingSection { fragment, .. }
    | DocumentMutation::AppendToHeading { fragment, .. }
    | DocumentMutation::ReplaceAll { fragment } => fragment,
    _ => return Ok(()),
  };
  let mut claims = native_footnotes(blocks, txn)?;
  fn visit(blocks: &[DocumentFragmentBlock], claims: &mut NativeFootnotes) -> Result<(), DocumentMutationError> {
    for block in blocks {
      let spans: &[DocumentTextSegment] = match block {
        DocumentFragmentBlock::Paragraph { text, .. }
        | DocumentFragmentBlock::Heading { text, .. }
        | DocumentFragmentBlock::Quote { text, .. }
        | DocumentFragmentBlock::Callout { text, .. }
        | DocumentFragmentBlock::ListItem { text, .. } => text,
        _ => &[],
      };
      check_spans(spans, claims)?;
      match block {
        DocumentFragmentBlock::CitationDefinition { label, reference } => insert_citation(claims, label, reference)?,
        DocumentFragmentBlock::FootnoteDefinition { label, children, .. } => {
          if claims
            .citations
            .contains_key(&crate::markdown::normalize_footnote_label(label))
          {
            return Err(DocumentMutationError::InvalidFragment);
          }
          visit(children, claims)?;
        }
        DocumentFragmentBlock::Callout { children, .. } => visit(children, claims)?,
        DocumentFragmentBlock::ListItem { children, .. } => visit(children, claims)?,
        DocumentFragmentBlock::Table { rows, .. } => {
          for cell in rows.iter().flatten() {
            check_spans(cell, claims)?;
          }
        }
        _ => {}
      }
    }
    Ok(())
  }
  visit(&fragment.blocks, &mut claims)
}

fn canonical_reference(label: &str, reference: &serde_json::Value) -> Result<serde_json::Value, DocumentMutationError> {
  if crate::markdown::normalize_footnote_label(label).is_empty() {
    return Err(DocumentMutationError::InvalidFragment);
  }
  crate::markdown::canonical_citation_reference(reference, label).map_err(|_| DocumentMutationError::InvalidFragment)
}

/// The normalized selector's inline citation markers (authoritative) and its
/// source cards. Inline payloads are authoritative; a card is a display copy
/// that may lag behind the inline source. Every card for the label is retained
/// so a revision updates them all.
struct CitationSource {
  /// Inline markers: (block_id, text_key, start, length, reference, stored label).
  inline: Vec<(String, String, u32, u32, serde_json::Value, String)>,
  /// Every source card: (block_id, resolved flavour, reference, stored label).
  cards: Vec<(String, String, serde_json::Value, String)>,
}

fn collect_citation_source(blocks: &yrs::MapRef, txn: &impl ReadTxn, selector: &str) -> CitationSource {
  let mut inline = Vec::new();
  let mut cards = Vec::new();
  for (id, value) in blocks.iter(txn) {
    let yrs::Out::YMap(block) = value else { continue };
    if let Some((label, reference)) = crate::markdown::native_citation_definition(&block, txn) {
      if crate::markdown::normalize_footnote_label(&label) == selector {
        cards.push((
          id.to_string(),
          resolve_flavour(&block_string(&block, txn, "flavour").unwrap_or_default()).to_string(),
          reference,
          label,
        ));
        continue;
      }
    }
    // Collect the text property keys, ending the block iterator's borrow.
    let keys: Vec<String> = block
      .iter(txn)
      .map(|(key, _)| key.to_string())
      .filter(|key| is_block_text_key(key))
      .collect();
    for key in keys {
      let Some(yrs::Out::YText(text)) = block.get(txn, &key) else {
        continue;
      };
      let mut offset = 0;
      for diff in text.diff(txn, |_| ()) {
        let length = match diff.insert {
          yrs::Out::Any(yrs::Any::String(value)) => value.len(),
          _ => 1,
        };
        let start = offset;
        offset += length;
        if let Some(note) = diff.attributes.as_ref().and_then(|attrs| attrs.get("footnote")) {
          let note_json = crate::yjs_any_to_json(note);
          // A citation marker carries a reference and no definition identity.
          if note_json.get("definitionId").is_none()
            && note_json.get("reference").is_some()
            && note_json
              .get("label")
              .and_then(|value| value.as_str())
              .is_some_and(|label| crate::markdown::normalize_footnote_label(label) == selector)
          {
            inline.push((
              id.to_string(),
              key.clone(),
              start as u32,
              length as u32,
              note_json.get("reference").cloned().unwrap_or(serde_json::Value::Null),
              note_json["label"].as_str().unwrap().to_string(),
            ));
          }
        }
      }
    }
  }
  CitationSource { inline, cards }
}

/// The normalized label is used by another local footnote definition or another
/// citation (inline marker or source card); the target's own markers and card
/// (the selector) are excluded.
fn citation_label_collision(
  blocks: &yrs::MapRef,
  txn: &impl ReadTxn,
  label: &str,
  selector: &str,
) -> Result<bool, DocumentMutationError> {
  let normalized = crate::markdown::normalize_footnote_label(label);
  let mut collision = false;
  for (_id, value) in blocks.iter(txn) {
    let yrs::Out::YMap(block) = value else { continue };
    if resolve_flavour(&block_string(&block, txn, "flavour").unwrap_or_default()) == "myoxus:footnote-definition" {
      if let Some(existing) = block_string(&block, txn, "label") {
        if crate::markdown::normalize_footnote_label(&existing) == normalized {
          collision = true;
        }
      }
    }
    if let Some((card_label, _)) = crate::markdown::native_citation_definition(&block, txn) {
      let card_normalized = crate::markdown::normalize_footnote_label(&card_label);
      if card_normalized == normalized && card_normalized != selector {
        collision = true;
      }
    }
    for text in block_texts(&block, txn) {
      for diff in text.diff(txn, |_| ()) {
        if let Some(note) = diff.attributes.as_ref().and_then(|attrs| attrs.get("footnote")) {
          let note_json = crate::yjs_any_to_json(note);
          if note_json.get("definitionId").is_none()
            && note_json.get("reference").is_some()
            && note_json
              .get("label")
              .and_then(|value| value.as_str())
              .is_some_and(|marker_label| {
                let marker_normalized = crate::markdown::normalize_footnote_label(marker_label);
                marker_normalized == normalized && marker_normalized != selector
              })
          {
            collision = true;
          }
        }
      }
    }
  }
  Ok(collision)
}

/// The source card flavour implied by a canonical reference type.
fn citation_flavour(reference: &serde_json::Value) -> Option<&'static str> {
  match reference.get("type").and_then(|kind| kind.as_str()) {
    Some("url") => Some("myoxus:bookmark"),
    Some("doc") => Some("myoxus:embed-linked-doc"),
    Some("attachment") => Some("myoxus:attachment"),
    _ => None,
  }
}

/// Rewrite an existing citation source card in place: update the label and
/// reference fields, remove superseded fields, preserve the ID and unrelated
/// metadata.
fn patch_citation_card(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  id: &str,
  label: &str,
  reference: &serde_json::Value,
) -> Result<(), DocumentMutationError> {
  let Some(yrs::Out::YMap(block)) = blocks.get(txn, id) else {
    return Err(DocumentMutationError::TargetNotFound);
  };
  if block_string(&block, txn, "footnoteIdentifier").as_deref() != Some(label) {
    block.insert(txn, "prop:footnoteIdentifier", label);
  }
  // Rewrite the citation field props: set the new fields, remove superseded ones.
  for (field, prop) in [
    ("url", "url"),
    ("docId", "pageId"),
    ("workspaceId", "workspaceId"),
    ("blobId", "sourceId"),
    ("fileName", "name"),
    ("fileType", "type"),
    ("title", "title"),
    ("description", "description"),
    ("favicon", "icon"),
  ] {
    match reference[field].as_str() {
      Some(value) => {
        // Rewriting an equal URL still emits a native map event and starts the
        // browser's bookmark preview refresh on an unrelated title/label edit.
        if block_string(&block, txn, prop).as_deref() != Some(value) {
          block.insert(txn, format!("prop:{prop}"), value);
        }
      }
      None => {
        let key = format!("prop:{prop}");
        // Editor defaults such as description/icon may be explicitly null.
        // They carry no reference value; removing them causes hydration writes
        // and changes edit metadata on the next Web load.
        if !matches!(block.get(txn, &key), Some(yrs::Out::Any(Any::Null))) {
          block.remove(txn, key.as_str());
        }
      }
    }
  }
  Ok(())
}

fn push_unique(values: &mut Vec<String>, value: String) {
  if !values.contains(&value) {
    values.push(value);
  }
}

/// Consistently revise one citation source: every inline marker and the
/// optional source card. Inline payloads are authoritative; a card is patched in
/// place when the source type keeps its flavour, and replaced with a fresh ID
/// at the same parent/position when the type changes the flavour.
fn update_citation_source(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  label: &str,
  new_label: Option<&str>,
  reference: Option<&serde_json::Value>,
  updated: &mut Vec<String>,
  inserted: &mut Vec<String>,
  removed: &mut Vec<String>,
) -> Result<(), DocumentMutationError> {
  let selector = crate::markdown::normalize_footnote_label(label);
  let source = collect_citation_source(blocks, txn, &selector);
  // A citation must have inline markers or a source card.
  if source.inline.is_empty() && source.cards.is_empty() {
    return Err(DocumentMutationError::InvalidFragment);
  }
  // Only an explicit rename unifies labels. Otherwise each occurrence retains
  // its own spelling, including when its source card must be replaced.
  let renamed_label = new_label.map(crate::markdown::normalize_footnote_label);
  // A renamed label must not collide with another definition or citation. The
  // normalized form is used for the comparison; the stored label stays verbatim.
  let final_normalized = renamed_label.as_deref().unwrap_or(&selector);
  if final_normalized != selector && citation_label_collision(blocks, txn, final_normalized, &selector)? {
    return Err(DocumentMutationError::InvalidFragment);
  }
  // Existing inline sources must agree even when a replacement reference was
  // supplied (including forwarded card edits). Never silently repair ambiguity.
  let mut existing_reference = None;
  for marker in &source.inline {
    let canonical = canonical_reference(label, &marker.4)?;
    if existing_reference.as_ref().is_some_and(|first| first != &canonical) {
      return Err(DocumentMutationError::InvalidFragment);
    }
    existing_reference = Some(canonical);
  }
  // The supplied reference wins only after validating the existing source.
  let new_reference = match reference {
    Some(reference) => canonical_reference(label, reference)?,
    None => {
      if let Some(reference) = existing_reference {
        reference
      } else {
        let card_reference = source
          .cards
          .first()
          .map(|card| &card.2)
          .ok_or(DocumentMutationError::TargetNotFound)?;
        canonical_reference(label, card_reference)?
      }
    }
  };
  // Update every inline marker to the final label and reference.
  if !source.inline.is_empty() {
    let native_reference =
      crate::json_to_yjs_any(&new_reference).map_err(|_| DocumentMutationError::InvalidFragment)?;
    for (block_id, key, start, length, _, stored_label) in &source.inline {
      let final_label = renamed_label.as_ref().unwrap_or(stored_label);
      let footnote = HashMap::from([
        ("label".to_string(), Any::String(final_label.clone().into())),
        ("reference".to_string(), native_reference.clone()),
      ]);
      let attrs = Attrs::from_iter([(Arc::from("footnote"), Any::Map(Arc::new(footnote)))]);
      let Some(yrs::Out::YMap(block)) = blocks.get(txn, block_id) else {
        continue;
      };
      let Some(yrs::Out::YText(text)) = block.get(txn, key) else {
        continue;
      };
      text.format(txn, *start, *length, attrs.clone());
      push_unique(updated, block_id.clone());
    }
  }
  // Update every source card for the label, patching same-flavour cards in
  // place and replacing type-changed cards with a fresh ID at the same
  // parent/position.
  for (card_id, card_flavour, _, stored_label) in &source.cards {
    let final_label = renamed_label.as_ref().unwrap_or(stored_label);
    let target_flavour = citation_flavour(&new_reference).ok_or(DocumentMutationError::InvalidFragment)?;
    if card_flavour == target_flavour {
      patch_citation_card(blocks, txn, card_id, final_label, &new_reference)?;
      push_unique(updated, card_id.clone());
    } else {
      let (parent, index) = find_parent(blocks, txn, card_id).ok_or(DocumentMutationError::TargetNotFound)?;
      let new_id = format!("mcp-block-{}", Uuid::new_v4().simple());
      crate::markdown::write_native_citation_definition(blocks, txn, &new_id, final_label, &new_reference);
      parent.remove(txn, index);
      collect_and_remove_subtree(blocks, txn, card_id, removed);
      parent.insert(txn, index, new_id.as_str());
      inserted.push(new_id);
    }
  }
  Ok(())
}

fn validate_fragment_span(
  span: &DocumentTextSegment,
  add_text: &mut impl FnMut(&str) -> Result<(), DocumentMutationError>,
) -> Result<(), DocumentMutationError> {
  add_text(&span.text)?;
  if span.native_latex_attributes.as_ref().is_some_and(|attributes| {
    span.latex.is_none()
      || !attributes.is_object()
      || attributes.get("latex").and_then(|value| value.as_str()) != span.latex.as_deref()
  }) {
    return Err(DocumentMutationError::InvalidFragment);
  }
  if let Some(id) = &span.annotation_id {
    add_text(id)?;
    if id.is_empty()
      || id.len() > 4096
      || span.text.is_empty()
      || span.bold
      || span.italic
      || span.strike
      || span.code
      || span.underline.unwrap_or(false)
      || span.color.is_some()
      || span.background.is_some()
      || span.label_tone.is_some()
      || span.link.is_some()
      || span.reference.is_some()
      || span.footnote.is_some()
      || span.latex.is_some()
      || span.mention.is_some()
    {
      return Err(DocumentMutationError::InvalidFragment);
    }
  }
  if let Some(mention) = &span.mention {
    add_text(&mention.member)?;
    if mention.member.is_empty()
      || mention.member.len() > 4096
      || span.text != " "
      || span.link.is_some()
      || span.reference.is_some()
      || span.footnote.is_some()
      || span.latex.is_some()
      || span.annotation_id.is_some()
    {
      return Err(DocumentMutationError::InvalidFragment);
    }
  }
  if span.latex.is_some() {
    // Preserve coalesced/formatted native atoms. New structured authoring has
    // stricter admission at the MCP boundary, not in this shared native writer.
    if span.text.is_empty()
      || !span.text.chars().all(|character| character == ' ')
      || span.reference.is_some()
      || span.footnote.is_some()
      || span.annotation_id.is_some()
      || span.mention.is_some()
    {
      return Err(DocumentMutationError::InvalidFragment);
    }
  }
  for value in [&span.latex, &span.link].into_iter().flatten() {
    add_text(value)?;
  }
  if let Some(reference) = &span.reference {
    add_text(&serde_json::to_string(reference).map_err(|_| DocumentMutationError::InvalidFragment)?)?;
  }
  if let Some(note) = &span.footnote {
    add_text(&note.to_string())?;
    let object = note.as_object().ok_or(DocumentMutationError::InvalidFragment)?;
    let label = note["label"].as_str().ok_or(DocumentMutationError::InvalidFragment)?;
    if crate::markdown::normalize_footnote_label(label).is_empty()
      || span.text.is_empty()
      || !span.text.chars().all(|character| character == ' ')
      || span.link.is_some()
      || span.reference.is_some()
      || span.latex.is_some()
      || span.mention.is_some()
    {
      return Err(DocumentMutationError::InvalidFragment);
    }
    if let Some(reference) = note.get("reference") {
      if object.keys().any(|key| !["label", "reference"].contains(&key.as_str())) {
        return Err(DocumentMutationError::InvalidFragment);
      }
      let canonical = canonical_reference(label, reference)?;
      if &canonical != reference {
        return Err(DocumentMutationError::InvalidFragment);
      }
    } else if note["definitionId"].as_str().is_none_or(str::is_empty)
      || object
        .keys()
        .any(|key| !["label", "definitionId"].contains(&key.as_str()))
    {
      return Err(DocumentMutationError::InvalidFragment);
    }
  }
  Ok(())
}

fn find_content_root(blocks: &yrs::MapRef, txn: &yrs::TransactionMut<'_>) -> Option<yrs::ArrayRef> {
  let mut page_children = None;
  for (_, value) in blocks.iter(txn) {
    let yrs::Out::YMap(block) = value else { continue };
    let Some(flavour) = block_string(&block, txn, "flavour") else {
      continue;
    };
    if resolve_flavour(&flavour) == "myoxus:page" {
      page_children = block_array(&block, txn, "children");
      break;
    }
  }
  let page_children = page_children?;
  for child_id in array_string_values(&page_children, txn) {
    let Some(yrs::Out::YMap(block)) = blocks.get(txn, &child_id) else {
      continue;
    };
    let Some(flavour) = block_string(&block, txn, "flavour") else {
      continue;
    };
    if resolve_flavour(&flavour) == "myoxus:note" {
      return block_array(&block, txn, "children");
    }
  }
  None
}

fn find_parent(blocks: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, target: &str) -> Option<(yrs::ArrayRef, u32)> {
  for (_, value) in blocks.iter(txn) {
    let yrs::Out::YMap(block) = value else { continue };
    let Some(children) = block_array(&block, txn, "children") else {
      continue;
    };
    if let Some(index) = array_string_values(&children, txn).iter().position(|id| id == target) {
      return Some((children, index as u32));
    }
  }
  None
}

fn is_descendant(blocks: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, ancestor: &str, candidate: &str) -> bool {
  let mut pending = vec![ancestor.to_string()];
  let mut visited = HashSet::new();
  while let Some(id) = pending.pop() {
    if !visited.insert(id.clone()) {
      continue;
    }
    let Some(yrs::Out::YMap(block)) = blocks.get(txn, &id) else {
      continue;
    };
    if let Some(children) = block_array(&block, txn, "children") {
      for child in array_string_values(&children, txn) {
        if child == candidate {
          return true;
        }
        pending.push(child);
      }
    }
  }
  false
}

// Structural commands stay separate from builders/imports: their admission rules
// apply to an existing native graph, not to ordinary document creation.
#[path = "document_structure.rs"]
mod structure;
use structure::convert_text_block;

#[path = "document_table.rs"]
pub(crate) mod table;
pub use table::{
  DocumentTableAppearance, DocumentTableAxis, DocumentTableAxisChange, DocumentTableCoordinateProperties,
  DocumentTableDensity, DocumentTableProperties,
};

/// Returns the IDs of marker blocks changed by a footnote-label rename, so the
/// caller can report every unit the mutation touched.
fn update_block_properties(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  block_id: &str,
  properties: &DocumentBlockProperties,
) -> Result<Vec<String>, DocumentMutationError> {
  let yrs::Out::YMap(block) = blocks.get(txn, block_id).ok_or(DocumentMutationError::TargetNotFound)? else {
    return Err(DocumentMutationError::TargetNotFound);
  };
  let flavour = block_string(&block, txn, "flavour").unwrap_or_default();
  let block_type = properties
    .list_kind
    .map(|kind| {
      match kind {
        DocumentListKind::Bulleted => "bulleted",
        DocumentListKind::Numbered => "numbered",
        DocumentListKind::Todo => "todo",
      }
      .to_string()
    })
    .or_else(|| properties.heading_level.map(|level| format!("h{level}")))
    .or_else(|| block_string(&block, txn, "type"));
  crate::document_properties::validate_kind(properties, resolve_flavour(&flavour), block_type.as_deref())?;
  // A rejected rename must leave no durable effect, so the collision check runs
  // before any write. The target's own definition and markers are excluded.
  if let Some(label) = &properties.label {
    if footnote_label_occupied(blocks, txn, label, block_id)? {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
  }
  if let Some(count) = properties.header_rows {
    if resolve_flavour(&flavour) != "myoxus:table" {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    let rows = super::native_template_repeat::ordered_native_table_rows(&block, txn);
    // A leading header cannot contain the repeat prototype (MT-08). Check the
    // captured native order under the canonical mutation lock, before any edit.
    if count > rows.len()
      || rows.iter().take(count).any(|(_, id)| {
        let prefix = format!("prop:rows.{id}.repeat");
        block
          .iter(txn)
          .any(|(key, _)| key == prefix || key.starts_with(&format!("{prefix}.")))
      })
    {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
  }
  if let Some(level) = properties.heading_level {
    if resolve_flavour(&flavour) != "myoxus:paragraph" || !(1..=6).contains(&level) {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    block.insert(txn, "prop:type", format!("h{level}"));
  }
  if let Some(kind) = properties.list_kind {
    if resolve_flavour(&flavour) != "myoxus:list" {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    block.insert(
      txn,
      "prop:type",
      match kind {
        DocumentListKind::Bulleted => "bulleted",
        DocumentListKind::Numbered => "numbered",
        DocumentListKind::Todo => "todo",
      },
    );
  }
  if let Some(checked) = properties.checked {
    if resolve_flavour(&flavour) != "myoxus:list" || block_type.as_deref() != Some("todo") {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    block.insert(txn, "prop:checked", checked);
  }
  if let Some(language) = &properties.language {
    if resolve_flavour(&flavour) != "myoxus:code" {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    block.insert(txn, "prop:language", language.as_str());
  }
  if let Some(alt) = &properties.alt {
    if resolve_flavour(&flavour) != "myoxus:image" {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    block.insert(txn, "prop:caption", alt.as_str());
  }
  if let Some(title) = &properties.title {
    if !matches!(resolve_flavour(&flavour), "myoxus:bookmark" | "myoxus:mermaid") {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    block.insert(txn, "prop:title", title.as_str());
  }
  if let Some(url) = &properties.url {
    if resolve_flavour(&flavour) != "myoxus:bookmark" || url.trim().is_empty() {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    block.insert(txn, "prop:url", url.as_str());
  }
  if let Some(count) = properties.header_rows {
    block.insert(txn, "prop:headerRows", count as f64);
  }
  let mut marker_ids = Vec::new();
  if let Some(label) = &properties.label {
    if resolve_flavour(&flavour) != "myoxus:footnote-definition" {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    block.insert(txn, "prop:label", label.as_str());
    marker_ids = rename_footnote_markers(blocks, txn, block_id, label)?;
  }
  if let Some(placement) = &properties.placement {
    if resolve_flavour(&flavour) != "myoxus:footnote-definition" {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    match placement {
      DocumentAttributeChange::Set { value } => {
        block.insert(
          txn,
          "prop:placement",
          match value {
            crate::footnote::FootnotePlacement::Footnote => "footnote",
            crate::footnote::FootnotePlacement::Endnote => "endnote",
          },
        );
      }
      DocumentAttributeChange::Remove {} => {
        block.remove(txn, "prop:placement");
      }
    }
  }
  if let Some(latex) = &properties.latex {
    if resolve_flavour(&flavour) != "myoxus:latex" {
      return Err(DocumentMutationError::InvalidBlockProperties);
    }
    block.insert(txn, "prop:latex", latex.as_str());
  }
  crate::document_properties::update(&block, txn, properties)?;
  Ok(marker_ids)
}

/// The normalized label is occupied by another definition, another
/// `footnoteIdentifier`, or another marker; the target's own definition and
/// markers are excluded. Mirrors the editor's `labelOccupied`.
fn footnote_label_occupied(
  blocks: &yrs::MapRef,
  txn: &impl ReadTxn,
  label: &str,
  except_id: &str,
) -> Result<bool, DocumentMutationError> {
  let normalized = crate::markdown::normalize_footnote_label(label);
  let mut occupied = false;
  for (id, value) in blocks.iter(txn) {
    let yrs::Out::YMap(block) = value else { continue };
    if id != except_id
      && resolve_flavour(&block_string(&block, txn, "flavour").unwrap_or_default()) == "myoxus:footnote-definition"
    {
      if let Some(existing) = block_string(&block, txn, "label") {
        if crate::markdown::normalize_footnote_label(&existing) == normalized {
          occupied = true;
        }
      }
    }
    if let Some(identifier) = block_string(&block, txn, "footnoteIdentifier") {
      if crate::markdown::normalize_footnote_label(&identifier) == normalized {
        occupied = true;
      }
    }
    for text in block_texts(&block, txn) {
      for diff in text.diff(txn, |_| ()) {
        if let Some(note) = diff.attributes.as_ref().and_then(|attrs| attrs.get("footnote")) {
          let note_json = crate::yjs_any_to_json(note);
          if let Some(marker_label) = note_json.get("label").and_then(|value| value.as_str()) {
            let definition_id = note_json.get("definitionId").and_then(|value| value.as_str());
            if definition_id != Some(except_id) && crate::markdown::normalize_footnote_label(marker_label) == normalized
            {
              occupied = true;
            }
          }
        }
      }
    }
  }
  Ok(occupied)
}

/// Update every marker carrying this `definitionId` to the renamed label in the
/// same mutation, including nested text and table cells. The definition's own
/// identity and the marker's definition identity are retained. Returns the IDs
/// of the blocks that actually carried a renamed marker, so the mutation can
/// report every changed unit.
fn rename_footnote_markers(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  definition_id: &str,
  label: &str,
) -> Result<Vec<String>, DocumentMutationError> {
  let mut footnote = std::collections::HashMap::new();
  footnote.insert("label".to_string(), yrs::Any::String(label.into()));
  footnote.insert("definitionId".to_string(), yrs::Any::String(definition_id.into()));
  let attrs = yrs::types::Attrs::from_iter([(Arc::from("footnote"), yrs::Any::Map(Arc::new(footnote)))]);
  // Collect IDs first so the map iterator's borrow ends before any write.
  let ids: Vec<String> = blocks.iter(txn).map(|(id, _)| id.to_string()).collect();
  let mut modified = Vec::new();
  for id in ids {
    let Some(yrs::Out::YMap(block)) = blocks.get(txn, &id) else {
      continue;
    };
    // Collect the text property keys, ending the block iterator's borrow.
    let keys: Vec<String> = block
      .iter(txn)
      .map(|(key, _)| key.to_string())
      .filter(|key| is_block_text_key(key))
      .collect();
    let mut block_modified = false;
    for key in keys {
      let Some(yrs::Out::YText(text)) = block.get(txn, &key) else {
        continue;
      };
      let mut offset = 0;
      let ranges: Vec<(u32, u32)> = text
        .diff(txn, |_| ())
        .into_iter()
        .filter_map(|diff| {
          let length = match diff.insert {
            yrs::Out::Any(yrs::Any::String(value)) => value.len(),
            _ => 1,
          };
          let start = offset;
          offset += length;
          let matches = diff
            .attributes
            .as_ref()
            .and_then(|attrs| attrs.get("footnote"))
            .is_some_and(|note| {
              crate::yjs_any_to_json(note)
                .get("definitionId")
                .and_then(|value| value.as_str())
                == Some(definition_id)
            });
          matches.then_some((start as u32, length as u32))
        })
        .collect();
      for (start, length) in ranges {
        text.format(txn, start, length, attrs.clone());
        block_modified = true;
      }
    }
    if block_modified {
      modified.push(id);
    }
  }
  Ok(modified)
}

/// A block property that holds editable YText: body, title and table cells.
fn is_block_text_key(key: &str) -> bool {
  key == "prop:text"
    || key == "text"
    || key == "prop:title"
    || key == "title"
    || key
      .strip_prefix("prop:cells.")
      .is_some_and(|key| key.ends_with(".text"))
}

/// The YText values owned by a block: body, title and table cell text.
fn block_texts(block: &yrs::MapRef, txn: &impl ReadTxn) -> Vec<yrs::TextRef> {
  let mut texts = Vec::new();
  if let Some(yrs::Out::YText(text)) = block.get(txn, "prop:text").or_else(|| block.get(txn, "text")) {
    texts.push(text);
  }
  if let Some(yrs::Out::YText(text)) = block.get(txn, "prop:title").or_else(|| block.get(txn, "title")) {
    texts.push(text);
  }
  for (key, value) in block.iter(txn) {
    if key
      .strip_prefix("prop:cells.")
      .is_some_and(|key| key.ends_with(".text"))
    {
      if let yrs::Out::YText(text) = value {
        texts.push(text);
      }
    }
  }
  texts
}

fn heading_section(
  blocks: &yrs::MapRef,
  txn: &yrs::TransactionMut<'_>,
  content_root: &yrs::ArrayRef,
  heading: &str,
) -> Result<(u32, u32), DocumentMutationError> {
  let children = array_string_values(content_root, txn);
  let normalized = normalize_heading(heading);
  let matches = children
    .iter()
    .enumerate()
    .filter_map(|(index, id)| {
      heading_info(blocks, txn, id)
        .filter(|(_, text)| normalize_heading(text) == normalized)
        .map(|value| (index, value.0))
    })
    .collect::<Vec<_>>();
  let [(start, level)] = matches.as_slice() else {
    return if matches.is_empty() {
      Err(DocumentMutationError::TargetNotFound)
    } else {
      Err(DocumentMutationError::AmbiguousHeading)
    };
  };
  let end = children
    .iter()
    .enumerate()
    .skip(start + 1)
    .find_map(|(index, id)| {
      heading_info(blocks, txn, id)
        .filter(|(candidate, _)| candidate <= level)
        .map(|_| index)
    })
    .unwrap_or(children.len());
  Ok((*start as u32, end as u32))
}

fn heading_info(blocks: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, id: &str) -> Option<(u8, String)> {
  let yrs::Out::YMap(block) = blocks.get(txn, id)? else {
    return None;
  };
  let flavour = block_string(&block, txn, "flavour")?;
  if resolve_flavour(&flavour) != "myoxus:paragraph" {
    return None;
  }
  let block_type = block_string(&block, txn, "type")?;
  let level = block_type.strip_prefix('h')?.parse::<u8>().ok()?.clamp(1, 6);
  let text = match block.get(txn, "prop:text").or_else(|| block.get(txn, "text")) {
    Some(yrs::Out::YText(text)) => text.get_string(txn),
    Some(yrs::Out::Any(value)) => value.to_string(),
    _ => String::new(),
  };
  Some((level, text))
}

fn create_fragment(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  fragment: &DocumentFragment,
) -> Result<Vec<String>, DocumentMutationError> {
  if fragment.blocks.is_empty() {
    return Err(DocumentMutationError::EmptyFragment);
  }
  let mut fragment = fragment.clone();
  let mut identities = HashMap::new();
  for block in &fragment.blocks {
    if let DocumentFragmentBlock::FootnoteDefinition { definition_id, .. } = block {
      if identities
        .insert(definition_id.clone(), format!("mcp-block-{}", Uuid::new_v4().simple()))
        .is_some()
      {
        return Err(DocumentMutationError::InvalidFragment);
      }
    }
  }
  rebind_fragment_definitions(&mut fragment.blocks, &identities);
  let mut annotations = HashMap::new();
  fragment
    .blocks
    .iter()
    .map(|block| create_fragment_block(blocks, txn, block, &mut annotations))
    .collect()
}

fn rebind_fragment_definitions(blocks: &mut [DocumentFragmentBlock], identities: &HashMap<String, String>) {
  let rebind = |spans: &mut [DocumentTextSegment]| {
    for span in spans {
      if let Some(note) = &mut span.footnote {
        if let Some(id) = note["definitionId"].as_str().and_then(|id| identities.get(id)).cloned() {
          note["definitionId"] = id.into();
        }
      }
    }
  };
  for block in blocks {
    match block {
      DocumentFragmentBlock::Paragraph { text, .. }
      | DocumentFragmentBlock::Heading { text, .. }
      | DocumentFragmentBlock::Quote { text, .. } => rebind(text),
      DocumentFragmentBlock::Callout { text, children, .. } => {
        rebind(text);
        rebind_fragment_definitions(children, identities);
      }
      DocumentFragmentBlock::ListItem { text, children, .. } => {
        rebind(text);
        rebind_fragment_definitions(children, identities);
      }
      DocumentFragmentBlock::FootnoteDefinition {
        definition_id,
        children,
        ..
      } => {
        if let Some(id) = identities.get(definition_id) {
          *definition_id = id.clone();
        }
        rebind_fragment_definitions(children, identities);
      }
      DocumentFragmentBlock::Table { rows, .. } => {
        for cell in rows.iter_mut().flatten() {
          rebind(cell);
        }
      }
      _ => {}
    }
  }
}

fn fragment_properties(
  block: &DocumentFragmentBlock,
) -> Option<(&'static str, Option<String>, &DocumentBlockProperties)> {
  match block {
    DocumentFragmentBlock::Paragraph {
      properties: Some(p), ..
    } => Some(("myoxus:paragraph", None, p)),
    DocumentFragmentBlock::Quote {
      properties: Some(p), ..
    } => Some(("myoxus:paragraph", Some("quote".into()), p)),
    DocumentFragmentBlock::Heading {
      level,
      properties: Some(p),
      ..
    } => Some(("myoxus:paragraph", Some(format!("h{level}")), p)),
    DocumentFragmentBlock::ListItem {
      list_kind,
      properties: Some(p),
      ..
    } => Some((
      "myoxus:list",
      Some(
        match list_kind {
          DocumentListKind::Bulleted => "bulleted",
          DocumentListKind::Numbered => "numbered",
          DocumentListKind::Todo => "todo",
        }
        .into(),
      ),
      p,
    )),
    DocumentFragmentBlock::Callout {
      callout_type,
      properties: Some(p),
      ..
    } => Some(("myoxus:callout", callout_type.clone(), p)),
    DocumentFragmentBlock::Code {
      properties: Some(p), ..
    } => Some(("myoxus:code", None, p)),
    _ => None,
  }
}

fn create_fragment_block(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  fragment: &DocumentFragmentBlock,
  annotations: &mut HashMap<String, String>,
) -> Result<String, DocumentMutationError> {
  let id = match fragment {
    DocumentFragmentBlock::FootnoteDefinition { definition_id, .. } => definition_id.clone(),
    _ => format!("mcp-block-{}", Uuid::new_v4().simple()),
  };
  match fragment {
    DocumentFragmentBlock::Paragraph { text, .. } => {
      create_yjs_text_block(blocks, txn, &id, "myoxus:paragraph", &segments(text, annotations));
    }
    DocumentFragmentBlock::Heading { level, text, .. } => {
      if !(1..=6).contains(level) {
        return Err(DocumentMutationError::InvalidFragment);
      }
      let block = create_yjs_text_block(blocks, txn, &id, "myoxus:paragraph", &segments(text, annotations));
      block.insert(txn, "prop:type", format!("h{level}"));
      block.insert(txn, "prop:collapsed", false);
    }
    DocumentFragmentBlock::ListItem {
      list_kind,
      text,
      checked,
      children,
      ..
    } => {
      let block = create_yjs_text_block(blocks, txn, &id, "myoxus:list", &segments(text, annotations));
      block.insert(
        txn,
        "prop:type",
        match list_kind {
          DocumentListKind::Bulleted => "bulleted",
          DocumentListKind::Numbered => "numbered",
          DocumentListKind::Todo => "todo",
        },
      );
      if *list_kind == DocumentListKind::Todo {
        block.insert(txn, "prop:checked", *checked);
      }
      let children_ref = block_array(&block, txn, "children").ok_or(DocumentMutationError::InvalidDocument)?;
      for child in children {
        let child_id = create_fragment_block(blocks, txn, child, annotations)?;
        children_ref.push_back(txn, child_id.as_str());
      }
    }
    DocumentFragmentBlock::Quote { text, .. } => {
      let block = create_yjs_text_block(blocks, txn, &id, "myoxus:paragraph", &segments(text, annotations));
      block.insert(txn, "prop:type", "quote");
    }
    DocumentFragmentBlock::Callout {
      text,
      callout_type,
      title,
      foldable,
      default_open,
      children,
      ..
    } => {
      let block = create_yjs_text_block(blocks, txn, &id, "myoxus:callout", &segments(text, annotations));
      if let Some(value) = callout_type {
        block.insert(txn, "prop:type", value.as_str());
      }
      if let Some(value) = title {
        block.insert(txn, "prop:title", yrs::TextPrelim::new(value));
      }
      if let Some(value) = foldable {
        block.insert(txn, "prop:foldable", *value);
      }
      if let Some(value) = default_open {
        block.insert(txn, "prop:defaultOpen", *value);
      }
      let children_ref = block_array(&block, txn, "children").ok_or(DocumentMutationError::InvalidDocument)?;
      for child in children {
        let child_id = create_fragment_block(blocks, txn, child, annotations)?;
        children_ref.push_back(txn, child_id.as_str());
      }
    }
    DocumentFragmentBlock::FootnoteDefinition {
      label,
      placement,
      children,
      ..
    } => {
      let (block, children_ref) = create_yjs_block(blocks, txn, &id, "myoxus:footnote-definition");
      block.insert(txn, "prop:label", label.as_str());
      if let Some(value) = placement {
        block.insert(
          txn,
          "prop:placement",
          match value {
            crate::footnote::FootnotePlacement::Footnote => "footnote",
            crate::footnote::FootnotePlacement::Endnote => "endnote",
          },
        );
      }
      for child in children {
        let child_id = create_fragment_block(blocks, txn, child, annotations)?;
        children_ref.push_back(txn, child_id.as_str());
      }
    }
    DocumentFragmentBlock::CitationDefinition { label, reference } => {
      crate::markdown::write_native_citation_definition(blocks, txn, &id, label, reference)
    }
    DocumentFragmentBlock::Code {
      native_latex,
      language,
      text,
      ..
    } => {
      if *native_latex {
        let (block, _) = create_yjs_block(blocks, txn, &id, "myoxus:latex");
        block.insert(txn, "sys:version", 1.0);
        block.insert(txn, "prop:latex", text.as_str());
      } else {
        let (block, _) = create_yjs_block(blocks, txn, &id, "myoxus:code");
        block.insert(txn, "prop:text", yrs::TextPrelim::new(text));
        block.insert(txn, "prop:language", language.as_str());
      }
    }
    DocumentFragmentBlock::Annotation { text } => {
      create_yjs_text_block(blocks, txn, &id, "myoxus:annotation", &[YjsTextSegment::plain(text)]);
    }
    DocumentFragmentBlock::Latex { latex } => {
      // Reuse the editor's native block formula encoding; the source is a plain string.
      let (block, _) = create_yjs_block(blocks, txn, &id, "myoxus:latex");
      block.insert(txn, "sys:version", 1.0);
      block.insert(txn, "prop:latex", latex.as_str());
    }
    DocumentFragmentBlock::Mermaid { source, title, caption } => {
      if source.trim().is_empty() {
        return Err(DocumentMutationError::InvalidFragment);
      }
      let (block, _) = create_yjs_block(blocks, txn, &id, "myoxus:mermaid");
      block.insert(txn, "prop:source", yrs::TextPrelim::new(source));
      block.insert(txn, "prop:title", yrs::TextPrelim::new(title));
      block.insert(txn, "prop:caption", caption.as_str());
    }
    DocumentFragmentBlock::Divider => {
      create_yjs_block(blocks, txn, &id, "myoxus:divider");
    }
    DocumentFragmentBlock::Image { source, alt } => {
      if source.trim().is_empty() {
        return Err(DocumentMutationError::InvalidFragment);
      }
      let (block, _) = create_yjs_block(blocks, txn, &id, "myoxus:image");
      block.insert(txn, "prop:sourceId", source.as_str());
      block.insert(txn, "prop:caption", alt.as_str());
    }
    DocumentFragmentBlock::Bookmark { url, title } => {
      if url.trim().is_empty() {
        return Err(DocumentMutationError::InvalidFragment);
      }
      let (block, _) = create_yjs_block(blocks, txn, &id, "myoxus:bookmark");
      block.insert(txn, "prop:url", url.as_str());
      block.insert(txn, "prop:title", title.as_str());
    }
    DocumentFragmentBlock::Table {
      rows,
      header_rows,
      properties,
    } => {
      let rows = rows
        .iter()
        .map(|row| row.iter().map(|cell| segments(cell, annotations)).collect::<Vec<_>>())
        .collect::<Vec<_>>();
      let block = create_yjs_table_block(blocks, txn, &id, &rows, &[], *header_rows)
        .ok_or(DocumentMutationError::InvalidFragment)?;
      if let Some(properties) = properties {
        table::update_presentation(&block, txn, properties)?;
      }
    }
  }
  if let Some((_, _, properties)) = fragment_properties(fragment) {
    update_block_properties(blocks, txn, &id, properties)?;
  }
  Ok(id)
}

fn collect_and_remove_subtree(
  blocks: &yrs::MapRef,
  txn: &mut yrs::TransactionMut<'_>,
  id: &str,
  removed: &mut Vec<String>,
) {
  if removed.iter().any(|candidate| candidate == id) {
    return;
  }
  let children = match blocks.get(txn, id) {
    Some(yrs::Out::YMap(block)) => block_array(&block, txn, "children")
      .map(|children| array_string_values(&children, txn))
      .unwrap_or_default(),
    _ => Vec::new(),
  };
  for child in children {
    collect_and_remove_subtree(blocks, txn, &child, removed);
  }
  blocks.remove(txn, id);
  removed.push(id.to_string());
}

fn insert_ids(array: &yrs::ArrayRef, txn: &mut yrs::TransactionMut<'_>, start: u32, ids: &[String]) {
  for (offset, id) in ids.iter().enumerate() {
    array.insert(txn, start + offset as u32, id.as_str());
  }
}

fn segments(values: &[DocumentTextSegment], annotations: &mut HashMap<String, String>) -> Vec<YjsTextSegment> {
  values
    .iter()
    .map(|value| {
      let mut segment = YjsTextSegment::from(value);
      if let Some(id) = &segment.annotation {
        segment.annotation = Some(crate::annotation::rebind_id(id, annotations));
      }
      segment
    })
    .collect()
}

fn block_string(block: &yrs::MapRef, txn: &impl ReadTxn, key: &str) -> Option<String> {
  block
    .get(txn, &format!("sys:{key}"))
    .or_else(|| block.get(txn, &format!("prop:{key}")))
    .or_else(|| block.get(txn, key))
    .and_then(|value| match value {
      yrs::Out::Any(yrs::Any::String(value)) => Some(value.to_string()),
      yrs::Out::YText(value) => Some(value.get_string(txn)),
      _ => None,
    })
}

fn block_array(block: &yrs::MapRef, txn: &yrs::TransactionMut<'_>, key: &str) -> Option<yrs::ArrayRef> {
  block
    .get(txn, &format!("sys:{key}"))
    .or_else(|| block.get(txn, key))
    .and_then(|value| match value {
      yrs::Out::YArray(array) => Some(array),
      _ => None,
    })
}

fn array_string_values(array: &yrs::ArrayRef, txn: &yrs::TransactionMut<'_>) -> Vec<String> {
  array
    .iter(txn)
    .filter_map(|value| match value {
      yrs::Out::Any(yrs::Any::String(value)) => Some(value.to_string()),
      _ => None,
    })
    .collect()
}

/// Shared heading identity normalization; never guess a generated slug.
pub fn normalize_heading(value: &str) -> String {
  value.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rich_replacements_have_exact_attributes_and_preserve_native_text_identity() {
    let mut builder = super::super::YjsDocumentBuilder::new("Rich replacement");
    let mut bold = YjsTextSegment::plain("ABCDE");
    bold.bold = true;
    let mut atom = YjsTextSegment::plain(" ");
    atom.latex = Some("x^2".into());
    builder.push_paragraph(&[bold, atom, YjsTextSegment::plain("tail")]);
    let original = builder.encode();
    let id = content_block_ids(&original)[0].clone();
    let inspect = |state: &[u8]| {
      let doc = yrs::Doc::new();
      doc
        .transact_mut()
        .apply_update(Update::decode_v1(state).unwrap())
        .unwrap();
      let blocks = doc.get_or_insert_map("blocks");
      let txn = doc.transact();
      let yrs::Out::YMap(block) = blocks.get(&txn, &id).unwrap() else {
        panic!("block")
      };
      let yrs::Out::YText(text) = block.get(&txn, "prop:text").unwrap() else {
        panic!("text")
      };
      (
        AsRef::<yrs::branch::Branch>::as_ref(&text).id(),
        text.diff(&txn, |_| ()),
      )
    };
    let before = inspect(&original);
    let rich = DocumentMutation::EditText {
      block_id: id.clone(),
      start: 2,
      end: 3,
      replacement: String::new(),
      replacement_spans: Some(vec![
        DocumentTextSegment {
          text: "é".into(),
          ..Default::default()
        },
        DocumentTextSegment {
          text: "😀".into(),
          underline: Some(true),
          ..Default::default()
        },
      ]),
      text_field: None,
      range_unit: None,
      expected_text: Some("C".into()),
    };
    let output = apply_document_mutation(&original, &rich).unwrap();
    let after = inspect(&output.state);
    assert_eq!(before.0, after.0);
    assert!(output.inserted_block_ids.is_empty());
    assert!(output.removed_block_ids.is_empty());
    assert_eq!(after.1[0].insert, yrs::Out::Any(Any::String("AB".into())));
    assert_eq!(after.1[1].insert, yrs::Out::Any(Any::String("é".into())));
    assert!(after.1[1].attributes.as_ref().is_none_or(|attrs| attrs.is_empty()));
    let attrs = after.1[2].attributes.as_ref().unwrap();
    assert_eq!(attrs.len(), 1);
    assert_eq!(attrs.get("underline"), Some(&Any::Bool(true)));
    assert_eq!(after.1[3].insert, yrs::Out::Any(Any::String("DE".into())));
    assert_eq!(after.1[3].attributes, before.1[0].attributes);
    assert_eq!(after.1[4..], before.1[1..]);
    let adjacent = DocumentMutation::EditText {
      block_id: id.clone(),
      start: 6,
      end: 6,
      replacement: String::new(),
      replacement_spans: Some(text("plain")),
      text_field: None,
      range_unit: None,
      expected_text: Some(String::new()),
    };
    let adjacent = inspect(&apply_document_mutation(&original, &adjacent).unwrap().state);
    let inserted = adjacent
      .1
      .iter()
      .find(|run| run.insert == yrs::Out::Any(Any::String("plaintail".into())))
      .unwrap();
    assert!(inserted.attributes.as_ref().is_none_or(|attrs| attrs.is_empty()));
    let legacy = DocumentMutation::EditText {
      block_id: id.clone(),
      start: 2,
      end: 3,
      replacement: "x".into(),
      replacement_spans: None,
      text_field: None,
      range_unit: None,
      expected_text: Some("C".into()),
    };
    let legacy = inspect(&apply_document_mutation(&original, &legacy).unwrap().state);
    assert_eq!(legacy.1[0].insert, yrs::Out::Any(Any::String("ABxDE".into())));
    assert_eq!(legacy.1[0].attributes, before.1[0].attributes);
  }

  #[test]
  fn block_formula_writes_native_latex_encoding_and_source_edits_preserve_plain_string() {
    let mut builder = super::super::YjsDocumentBuilder::new("Formula");
    builder.push_paragraph(&[YjsTextSegment::plain("anchor")]);
    let original = builder.encode();
    let anchor = content_block_ids(&original)[0].clone();
    let fragment = DocumentFragment {
      schema_version: DOCUMENT_FRAGMENT_SCHEMA.to_string(),
      blocks: vec![DocumentFragmentBlock::Latex {
        latex: "a^2 + b^2".into(),
      }],
    };
    let output = apply_document_mutation(&original, &DocumentMutation::AppendBlocks { fragment }).unwrap();
    let id = output.inserted_block_ids[0].clone();
    // A plain-string property reads back as a string; a YText would yield None.
    let block_string = |state: &[u8], key: &str| -> Option<String> {
      let doc = yrs::Doc::new();
      doc
        .transact_mut()
        .apply_update(Update::decode_v1(state).unwrap())
        .unwrap();
      let blocks = doc.get_or_insert_map("blocks");
      let txn = doc.transact();
      let yrs::Out::YMap(block) = blocks.get(&txn, &id).unwrap() else {
        panic!("block")
      };
      match block.get(&txn, key) {
        Some(yrs::Out::Any(Any::String(value))) => Some(value.to_string()),
        _ => None,
      }
    };
    assert_eq!(block_string(&output.state, "sys:flavour"), Some("myoxus:latex".into()));
    assert_eq!(block_string(&output.state, "prop:latex"), Some("a^2 + b^2".into()));
    // Property edit: replace the source with "a^2 + c^2".
    let edit = DocumentMutation::UpdateBlockProperties {
      block_id: id.clone(),
      properties: DocumentBlockProperties {
        latex: Some("a^2 + c^2".into()),
        ..Default::default()
      },
    };
    let edited = apply_document_mutation(&output.state, &edit).unwrap();
    assert_eq!(block_string(&edited.state, "prop:latex"), Some("a^2 + c^2".into()));
    // An explicit empty string clears the source without deleting the block.
    let clear = DocumentMutation::UpdateBlockProperties {
      block_id: id.clone(),
      properties: DocumentBlockProperties {
        latex: Some(String::new()),
        ..Default::default()
      },
    };
    let cleared = apply_document_mutation(&edited.state, &clear).unwrap();
    assert_eq!(block_string(&cleared.state, "prop:latex"), Some("".into()));
    assert_eq!(block_string(&cleared.state, "sys:flavour"), Some("myoxus:latex".into()));
    // A latex property on a non-latex block is rejected.
    let wrong = DocumentMutation::UpdateBlockProperties {
      block_id: anchor,
      properties: DocumentBlockProperties {
        latex: Some("x".into()),
        ..Default::default()
      },
    };
    assert_eq!(
      apply_document_mutation(&cleared.state, &wrong),
      Err(DocumentMutationError::InvalidBlockProperties)
    );
    // Structured readback exposes the formula source as a plain-string field.
    let doc = yrs::Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&edited.state).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let txn = doc.transact();
    let yrs::Out::YMap(block) = blocks.get(&txn, &id).unwrap() else {
      panic!("block")
    };
    let native = crate::native_text::native_block_text(&block, &txn).unwrap();
    assert_eq!(native.kind, "myoxus:latex");
    let source = native.fields.iter().find(|field| field.field == "source").unwrap();
    assert_eq!(source.length, 9);
    assert_eq!(source.spans[0].text.as_deref(), Some("a^2 + c^2"));
    assert_eq!(source.spans[0].latex, None);
  }

  #[test]
  fn inline_formula_is_a_single_space_atom_and_reads_back_its_source() {
    let mut builder = super::super::YjsDocumentBuilder::new("Inline formula");
    builder.push_paragraph(&[YjsTextSegment::plain("anchor")]);
    let original = builder.encode();
    // A valid inline formula (single space, no other marks) is admitted.
    let valid = DocumentFragment {
      schema_version: DOCUMENT_FRAGMENT_SCHEMA.to_string(),
      blocks: vec![DocumentFragmentBlock::Paragraph {
        properties: None,
        text: vec![
          DocumentTextSegment {
            text: "before ".into(),
            ..Default::default()
          },
          DocumentTextSegment {
            text: " ".into(),
            latex: Some("x^2".into()),
            ..Default::default()
          },
          DocumentTextSegment {
            text: "after".into(),
            ..Default::default()
          },
        ],
      }],
    };
    let output = apply_document_mutation(&original, &DocumentMutation::AppendBlocks { fragment: valid }).unwrap();
    let id = output.inserted_block_ids[0].clone();
    // Native encoding: a single space carries the latex attribute; the code mark is absent.
    let doc = yrs::Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&output.state).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let txn = doc.transact();
    let yrs::Out::YMap(block) = blocks.get(&txn, &id).unwrap() else {
      panic!("block")
    };
    let yrs::Out::YText(text) = block.get(&txn, "prop:text").unwrap() else {
      panic!("text")
    };
    let atom = text
      .diff(&txn, |_| ())
      .into_iter()
      .find(|run| run.insert == yrs::Out::Any(Any::String(" ".into())))
      .unwrap();
    let attrs = atom.attributes.as_ref().unwrap();
    assert_eq!(attrs.get("latex"), Some(&Any::String("x^2".into())));
    assert_eq!(attrs.get("code"), None);
    // Structured readback exposes the formula source and marks the atom protected.
    let native = crate::native_text::native_block_text(&block, &txn).unwrap();
    let source = native.fields.iter().find(|field| field.field == "text").unwrap();
    let span = source.spans.iter().find(|span| span.latex.is_some()).unwrap();
    assert_eq!(span.text.as_deref(), Some(" "));
    assert_eq!(span.latex.as_deref(), Some("x^2"));
    assert!(span.protected);
    // Existing native runs may coalesce and carry formatting, including code.
    let marked = DocumentFragment {
      schema_version: DOCUMENT_FRAGMENT_SCHEMA.to_string(),
      blocks: vec![DocumentFragmentBlock::Paragraph {
        properties: None,
        text: vec![DocumentTextSegment {
          text: "  ".into(),
          latex: Some("x^2".into()),
          bold: true,
          italic: true,
          strike: true,
          code: true,
          underline: Some(true),
          link: Some("https://example.test/formula".into()),
          ..Default::default()
        }],
      }],
    };
    let marked = apply_document_mutation(&original, &DocumentMutation::AppendBlocks { fragment: marked }).unwrap();
    let doc = yrs::Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&marked.state).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let txn = doc.transact();
    let yrs::Out::YMap(block) = blocks.get(&txn, &marked.inserted_block_ids[0]).unwrap() else {
      panic!("block")
    };
    let native = crate::native_text::native_block_text(&block, &txn).unwrap();
    let span = &native.fields[0].spans[0];
    assert_eq!(span.text.as_deref(), Some("  "));
    assert!(span.bold && span.italic && span.strike && span.code && span.underline);
    assert_eq!(span.link.as_deref(), Some("https://example.test/formula"));
    // Ordinary non-space text cannot impersonate a native formula atom.
    let wide = DocumentFragment {
      schema_version: DOCUMENT_FRAGMENT_SCHEMA.to_string(),
      blocks: vec![DocumentFragmentBlock::Paragraph {
        properties: None,
        text: vec![DocumentTextSegment {
          text: "ab".into(),
          latex: Some("x^2".into()),
          ..Default::default()
        }],
      }],
    };
    assert_eq!(
      apply_document_mutation(&original, &DocumentMutation::AppendBlocks { fragment: wide }),
      Err(DocumentMutationError::InvalidFragment)
    );
  }

  #[test]
  fn plain_callout_titles_and_table_formatting_keep_their_shared_fields() {
    let original = super::super::markdown_to_yjs("Fields", "Before").unwrap();
    let fragment: DocumentFragment=serde_json::from_value(serde_json::json!({"schemaVersion":DOCUMENT_FRAGMENT_SCHEMA,"blocks":[{"kind":"callout","spans":[{"text":"body"}],"title":"é😀"},{"kind":"callout","spans":[{"text":"empty title"}]},{"kind":"table","rows":[[[{"text":"cell","italic":true}]]]}]})).unwrap();
    let output = apply_document_mutation(&original, &DocumentMutation::AppendBlocks { fragment }).unwrap();
    let ids = output.inserted_block_ids;
    let mut state = output.state;
    let field = |state: &[u8], id: &str, key: &str| {
      let doc = yrs::Doc::new();
      doc
        .transact_mut()
        .apply_update(Update::decode_v1(state).unwrap())
        .unwrap();
      let blocks = doc.get_or_insert_map("blocks");
      let txn = doc.transact();
      let yrs::Out::YMap(block) = blocks.get(&txn, id).unwrap() else {
        panic!("block")
      };
      let yrs::Out::YText(text) = block.get(&txn, key).unwrap() else {
        panic!("text")
      };
      (
        AsRef::<yrs::branch::Branch>::as_ref(&text).id(),
        text.get_string(&txn),
        text.diff(&txn, |_| ()),
      )
    };
    let title = field(&state, &ids[0], "prop:title");
    assert_eq!(title.1, "é😀");
    for id in &ids[..2] {
      let end = if id == &ids[0] { 6 } else { 0 };
      let expected = if end == 0 { "" } else { "é😀" };
      state = apply_document_mutation(
        &state,
        &DocumentMutation::EditText {
          block_id: id.clone(),
          start: 0,
          end,
          replacement: "Title".into(),
          replacement_spans: None,
          text_field: Some(DocumentTextField::Title),
          range_unit: None,
          expected_text: Some(expected.into()),
        },
      )
      .unwrap()
      .state;
    }
    assert_eq!(field(&state, &ids[0], "prop:title").0, title.0);
    assert_eq!(field(&state, &ids[1], "prop:title").1, "Title");
    let cell = field(&state, &ids[2], "prop:cells.row-0000:col-0000.text");
    state = apply_document_mutation(
      &state,
      &DocumentMutation::FormatText {
        block_id: ids[2].clone(),
        start: 0,
        end: 4,
        formatting: DocumentTextFormatting {
          underline: Some(true),
          ..Default::default()
        },
        row_id: Some("row-0000".into()),
        column_id: Some("col-0000".into()),
        range_unit: None,
        expected_text: Some("cell".into()),
      },
    )
    .unwrap()
    .state;
    let after = field(&state, &ids[2], "prop:cells.row-0000:col-0000.text");
    assert_eq!(after.0, cell.0);
    assert_eq!(after.1, cell.1);
    let attrs = after.2[0].attributes.as_ref().unwrap();
    assert_eq!(attrs.get("italic"), Some(&Any::Bool(true)));
    assert_eq!(attrs.get("underline"), Some(&Any::Bool(true)));
    let invalid = DocumentMutation::EditText {
      block_id: ids[0].clone(),
      start: 0,
      end: 0,
      replacement: String::new(),
      replacement_spans: Some(vec![DocumentTextSegment {
        text: " ".into(),
        footnote: Some(serde_json::json!({"label":"missing","definitionId":"absent"})),
        ..Default::default()
      }]),
      text_field: Some(DocumentTextField::Title),
      range_unit: None,
      expected_text: None,
    };
    assert_eq!(
      apply_document_mutation(&state, &invalid),
      Err(DocumentMutationError::InvalidFragment)
    );
  }

  #[test]
  fn missing_native_marks_keep_legacy_semantic_payloads_and_removal_is_strict() {
    let legacy_span = serde_json::json!({"text":"legacy","bold":false,"italic":false,"strike":false,"code":false});
    let span: DocumentTextSegment = serde_json::from_value(legacy_span.clone()).unwrap();
    assert_eq!(serde_json::to_value(span).unwrap(), legacy_span);
    let legacy_format = serde_json::json!({"bold":true,"link":{"action":"remove"}});
    let formatting: DocumentTextFormatting = serde_json::from_value(legacy_format.clone()).unwrap();
    assert_eq!(serde_json::to_value(formatting).unwrap(), legacy_format);
    for invalid in [
      serde_json::json!({"color":{"action":"remove","value":"red"}}),
      serde_json::json!({"background":{"action":"set","value":"#fff"}}),
      serde_json::json!({"labelTone":{"action":"set","value":"blue"}}),
    ] {
      assert!(serde_json::from_value::<DocumentTextFormatting>(invalid).is_err());
    }
  }

  #[test]
  fn targeted_table_cell_edits_preserve_native_identity_geometry_and_neighbor_content() {
    let state = super::super::markdown_to_yjs("Cells", "Before\n\n| H1 | H2 | H3 |\n| --- | --- | --- |\n| A1 | **Prefix café 😀 é** [keep](https://example.test/keep) | A3 |\n| B1 | B2 | B3 |\n\nAfter $x^2$").unwrap();
    let ids = content_block_ids(&state);
    let table_id = &ids[1];
    let cell_key = "prop:cells.row-0001:col-0001.text";
    let load = |state: &[u8]| {
      let doc = yrs::Doc::new();
      doc
        .transact_mut()
        .apply_update(Update::decode_v1(state).unwrap())
        .unwrap();
      doc
    };
    let native = load(&state);
    let blocks = native.get_or_insert_map("blocks");
    let mut txn = native.transact_mut();
    let yrs::Out::YMap(table) = blocks.get(&txn, table_id).unwrap() else {
      panic!("native table")
    };
    table.insert(&mut txn, "prop:headerRows", 1);
    table.insert(&mut txn, "prop:appearance", "ruled");
    table.insert(&mut txn, "prop:density", "compact");
    table.insert(&mut txn, "prop:columns.col-0001.width", 237);
    table.insert(&mut txn, "prop:columns.col-0001.textAlign", "right");
    table.insert(&mut txn, "prop:comments.protected", true);
    let original = txn.encode_diff_v1(&yrs::StateVector::default());
    drop(txn);
    let snapshot = |state: &[u8]| {
      let native = load(state);
      let blocks = native.get_or_insert_map("blocks");
      let txn = native.transact();
      let yrs::Out::YMap(table) = blocks.get(&txn, table_id).unwrap() else {
        panic!("same table")
      };
      let mut props = std::collections::BTreeMap::new();
      let mut rich = std::collections::BTreeMap::new();
      for (key, value) in table.iter(&txn) {
        if key == cell_key {
          continue;
        }
        if let yrs::Out::YText(text) = &value {
          rich.insert(key.to_owned(), text.diff(&txn, |_| ()));
        }
        props.insert(key.to_owned(), super::super::yjs_out_to_json(value, &txn));
      }
      let protected = [ids[0].clone(), ids[2].clone()].map(|id| {
        let value = blocks.get(&txn, &id).unwrap();
        let yrs::Out::YMap(block) = &value else {
          panic!("protected block")
        };
        let Some(yrs::Out::YText(text)) = block.get(&txn, "prop:text") else {
          panic!("protected rich text")
        };
        (super::super::yjs_out_to_json(value, &txn), text.diff(&txn, |_| ()))
      });
      (props, rich, protected)
    };
    let protected = snapshot(&original);
    let text = "Prefix café 😀 é keep";
    let selected = "café 😀 é";
    let start = text.find(selected).unwrap();
    let end = start + selected.len();
    for unit in [
      None,
      Some(DocumentTextRangeUnit::Utf8Bytes),
      Some(DocumentTextRangeUnit::Utf16CodeUnits),
      Some(DocumentTextRangeUnit::UnicodeScalars),
    ] {
      let count = |text: &str| match unit {
        Some(DocumentTextRangeUnit::Utf16CodeUnits) => text.encode_utf16().count() as u32,
        Some(DocumentTextRangeUnit::UnicodeScalars) => text.chars().count() as u32,
        _ => text.len() as u32,
      };
      let edit = DocumentMutation::EditTableCell {
        block_id: table_id.clone(),
        row_id: "row-0001".into(),
        column_id: "col-0001".into(),
        start: count(&text[..start]),
        end: count(&text[..end]),
        replacement: "Café 🧮".into(),
        replacement_spans: None,
        range_unit: unit,
        expected_text: Some(selected.into()),
      };
      let changed = apply_document_mutation(&original, &edit).unwrap();
      assert!(changed.inserted_block_ids.is_empty() && changed.removed_block_ids.is_empty());
      assert_eq!(content_block_ids(&changed.state), ids);
      assert_eq!(snapshot(&changed.state), protected);

      // Apply the server delta to an independent native consumer. Its original
      // TextRef must survive, and a subsequent ordinary edit must reload intact.
      let client = load(&original);
      let blocks = client.get_or_insert_map("blocks");
      let yrs::Out::YMap(table) = blocks.get(&client.transact(), table_id).unwrap() else {
        panic!("native table")
      };
      let yrs::Out::YText(text) = table.get(&client.transact(), cell_key).unwrap() else {
        panic!("native cell")
      };
      client
        .transact_mut()
        .apply_update(Update::decode_v1(&changed.delta).unwrap())
        .unwrap();
      let yrs::Out::YText(after) = table.get(&client.transact(), cell_key).unwrap() else {
        panic!("same cell")
      };
      assert_eq!(after, text);
      assert_eq!(text.get_string(&client.transact()), "Prefix Café 🧮 keep");
      let spans = text.diff(&client.transact(), |_| ());
      assert!(spans.iter().any(|span| {
        matches!(&span.insert, yrs::Out::Any(Any::String(value)) if value.contains("Café 🧮"))
          && span
            .attributes
            .as_ref()
            .is_some_and(|attrs| attrs.get("bold") == Some(&Any::Bool(true)))
      }));
      assert!(spans.iter().any(|span| {
        span
          .attributes
          .as_ref()
          .is_some_and(|attrs| attrs.get("link") == Some(&Any::String("https://example.test/keep".into())))
      }));
      text.insert(&mut client.transact_mut(), 0, "Client ");
      let reloaded = client
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
      assert_eq!(snapshot(&reloaded), protected);
      let loaded = load(&reloaded);
      let yrs::Out::YMap(table) = loaded
        .get_or_insert_map("blocks")
        .get(&loaded.transact(), table_id)
        .unwrap()
      else {
        panic!("reloaded table")
      };
      let yrs::Out::YText(text) = table.get(&loaded.transact(), cell_key).unwrap() else {
        panic!("reloaded cell")
      };
      assert_eq!(text.get_string(&loaded.transact()), "Client Prefix Café 🧮 keep");

      let mut mismatch = edit.clone();
      if let DocumentMutation::EditTableCell { expected_text, .. } = &mut mismatch {
        *expected_text = Some("wrong".into());
      }
      assert_eq!(
        apply_document_mutation(&original, &mismatch).unwrap_err(),
        DocumentMutationError::ExpectedTextMismatch
      );
      let mut missing = edit.clone();
      if let DocumentMutation::EditTableCell { row_id, .. } = &mut missing {
        *row_id = "missing".into();
      }
      assert_eq!(
        apply_document_mutation(&original, &missing).unwrap_err(),
        DocumentMutationError::TargetNotFound
      );
      let sparse = load(&original);
      let yrs::Out::YMap(table) = sparse
        .get_or_insert_map("blocks")
        .get(&sparse.transact(), table_id)
        .unwrap()
      else {
        panic!("sparse table")
      };
      table.remove(&mut sparse.transact_mut(), cell_key);
      let state = sparse
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
      assert_eq!(
        apply_document_mutation(&state, &edit).unwrap_err(),
        DocumentMutationError::TargetNotFound
      );
    }
  }

  fn content_block_ids(update: &[u8]) -> Vec<String> {
    let doc = yrs::Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let decoded = Update::decode_v1(update).expect("decode fixture");
    doc.transact_mut().apply_update(decoded).expect("apply fixture");
    let mut txn = doc.transact_mut();
    let root = find_content_root(&blocks, &txn).expect("content root");
    array_string_values(&root, &mut txn)
  }

  fn text(value: &str) -> Vec<DocumentTextSegment> {
    vec![DocumentTextSegment {
      text: value.to_string(),
      ..Default::default()
    }]
  }

  fn fragment(value: &str) -> DocumentFragment {
    DocumentFragment {
      schema_version: DOCUMENT_FRAGMENT_SCHEMA.to_string(),
      blocks: vec![DocumentFragmentBlock::Paragraph {
        properties: None,
        text: text(value),
      }],
    }
  }

  #[test]
  fn targeted_formatting_preserves_native_spans_references_formulas_and_identities() {
    let original = super::super::markdown_to_yjs(
      "Format",
      "Before\n\n**Prefix é😀é** [keep](https://example.test/keep)\n\nAfter $x^2$",
    )
    .unwrap();
    let ids = content_block_ids(&original);
    let native = yrs::Doc::new();
    native
      .transact_mut()
      .apply_update(Update::decode_v1(&original).unwrap())
      .unwrap();
    let blocks = native.get_or_insert_map("blocks");
    let mut txn = native.transact_mut();
    let yrs::Out::YMap(block) = blocks.get(&txn, &ids[1]).unwrap() else {
      panic!("native block")
    };
    let yrs::Out::YText(text) = block.get(&txn, "prop:text").unwrap() else {
      panic!("native text")
    };
    text.format(&mut txn, 7, 9, Attrs::from([("underline".into(), Any::Bool(true))]));
    let label = text.get_string(&txn).find("keep").unwrap() as u32;
    text.format(
      &mut txn,
      label,
      4,
      Attrs::from([(
        "reference".into(),
        Any::Map(Arc::new(HashMap::from([
          ("type".into(), Any::String("LinkedPage".into())),
          ("pageId".into(), Any::String("protected-native-target".into())),
        ]))),
      )]),
    );
    let original = txn.encode_diff_v1(&yrs::StateVector::default());
    drop(txn);
    let rich = |state: &[u8], id: &str| {
      let native = yrs::Doc::new();
      native
        .transact_mut()
        .apply_update(Update::decode_v1(state).unwrap())
        .unwrap();
      let blocks = native.get_or_insert_map("blocks");
      let txn = native.transact();
      let yrs::Out::YMap(block) = blocks.get(&txn, id).unwrap() else {
        panic!("same native block")
      };
      let yrs::Out::YText(text) = block.get(&txn, "prop:text").unwrap() else {
        panic!("same native text")
      };
      text.diff(&txn, |_| ())
    };
    let before = rich(&original, &ids[1]);
    for (unit, end) in [
      (None, 16),
      (Some(DocumentTextRangeUnit::Utf8Bytes), 16),
      (Some(DocumentTextRangeUnit::Utf16CodeUnits), 12),
      (Some(DocumentTextRangeUnit::UnicodeScalars), 11),
    ] {
      let set = DocumentMutation::FormatText {
        block_id: ids[1].clone(),
        start: 7,
        end,
        row_id: None,
        column_id: None,
        range_unit: unit,
        expected_text: Some("é😀é".into()),
        formatting: DocumentTextFormatting {
          bold: Some(false),
          italic: Some(true),
          strike: Some(true),
          code: Some(true),
          color: Some(DocumentAttributeChange::Set {
            value: DocumentPaletteColor::Blue,
          }),
          background: Some(DocumentAttributeChange::Set {
            value: DocumentPaletteColor::Yellow,
          }),
          label_tone: Some(DocumentAttributeChange::Set {
            value: DocumentLabelTone::Positive,
          }),
          link: Some(DocumentTextLinkChange::Set {
            href: "https://example.test/new".into(),
          }),
          ..Default::default()
        },
      };
      let changed = apply_document_mutation(&original, &set).unwrap();
      assert!(changed.inserted_block_ids.is_empty());
      assert!(changed.removed_block_ids.is_empty());
      assert_eq!(content_block_ids(&changed.state), ids);
      let after = rich(&changed.state, &ids[1]);
      let selected = after
        .iter()
        .find(|part| part.insert == yrs::Out::Any(Any::String("é😀é".into())))
        .unwrap();
      let attrs = selected.attributes.as_ref().unwrap();
      assert!(attrs.get("bold").is_none());
      for key in ["italic", "strike", "code", "underline"] {
        assert_eq!(attrs.get(key), Some(&Any::Bool(true)));
      }
      assert_eq!(attrs.get("link"), Some(&Any::String("https://example.test/new".into())));
      assert_eq!(
        attrs.get("color"),
        Some(&Any::String("var(--myoxus-text-highlight-foreground-blue)".into()))
      );
      assert_eq!(
        attrs.get("background"),
        Some(&Any::String("var(--myoxus-text-highlight-yellow)".into()))
      );
      assert_eq!(attrs.get("labelTone"), Some(&Any::String("positive".into())));
      for id in [&ids[0], &ids[2]] {
        assert_eq!(
          rich(&changed.state, id),
          rich(&original, id),
          "protected neighbor/formula"
        );
      }
      for protected in before
        .iter()
        .filter(|part| part.insert != yrs::Out::Any(Any::String("é😀é".into())))
      {
        assert!(after.contains(protected), "unaffected native span/reference");
      }
      let removed = apply_document_mutation(
        &changed.state,
        &DocumentMutation::FormatText {
          block_id: ids[1].clone(),
          start: 7,
          end,
          row_id: None,
          column_id: None,
          range_unit: unit,
          expected_text: Some("é😀é".into()),
          formatting: DocumentTextFormatting {
            bold: Some(false),
            italic: Some(false),
            strike: Some(false),
            code: Some(false),
            color: Some(DocumentAttributeChange::Remove {}),
            background: Some(DocumentAttributeChange::Remove {}),
            label_tone: Some(DocumentAttributeChange::Remove {}),
            link: Some(DocumentTextLinkChange::Remove {}),
            ..Default::default()
          },
        },
      )
      .unwrap();
      let removed_spans = rich(&removed.state, &ids[1]);
      let attrs = removed_spans
        .iter()
        .find(|part| part.insert == yrs::Out::Any(Any::String("é😀é".into())))
        .unwrap()
        .attributes
        .as_ref()
        .unwrap();
      assert_eq!(attrs.len(), 1);
      assert_eq!(attrs.get("underline"), Some(&Any::Bool(true)));
      assert_eq!(content_block_ids(&removed.state), ids);
      let edited = apply_document_mutation(
        &removed.state,
        &DocumentMutation::EditText {
          block_id: ids[1].clone(),
          start: 7,
          end: 9,
          replacement: "è".into(),
          replacement_spans: None,
          text_field: None,
          range_unit: None,
          expected_text: Some("é".into()),
        },
      )
      .unwrap();
      let edited_spans = rich(&edited.state, &ids[1]);
      let native_text = edited_spans
        .iter()
        .map(|span| match &span.insert {
          yrs::Out::Any(Any::String(text)) => text.as_ref(),
          _ => panic!("plain-text fixture unexpectedly contains an embed"),
        })
        .collect::<String>();
      // Markdown may split adjacent marks around newly inserted text. The
      // consuming native text, not its serialized markup, owns content fidelity.
      assert_eq!(
        native_text, "Prefix è😀é keep",
        "formatted native text remains editable after reload"
      );
      for protected in before.iter().filter(|span| {
        span
          .attributes
          .as_ref()
          .is_some_and(|attrs| attrs.contains_key("reference"))
      }) {
        assert!(
          edited_spans.contains(protected),
          "native edit preserves the protected reference"
        );
      }
      for id in [&ids[0], &ids[2]] {
        assert_eq!(
          rich(&edited.state, id),
          rich(&original, id),
          "native edit preserves neighbors and formulas"
        );
      }
    }
    for mutation in [
      DocumentMutation::FormatText {
        block_id: ids[1].clone(),
        start: 7,
        end: 16,

        row_id: None,
        column_id: None,
        range_unit: None,
        expected_text: Some("wrong".into()),
        formatting: DocumentTextFormatting {
          bold: Some(true),
          ..Default::default()
        },
      },
      DocumentMutation::FormatText {
        block_id: ids[1].clone(),
        start: 8,
        end: 16,

        row_id: None,
        column_id: None,
        range_unit: None,
        expected_text: None,
        formatting: DocumentTextFormatting {
          bold: Some(true),
          ..Default::default()
        },
      },
      DocumentMutation::FormatText {
        block_id: ids[1].clone(),
        start: 7,
        end: 7,

        row_id: None,
        column_id: None,
        range_unit: None,
        expected_text: None,
        formatting: DocumentTextFormatting {
          bold: Some(true),
          ..Default::default()
        },
      },
      DocumentMutation::FormatText {
        block_id: ids[1].clone(),
        start: 7,
        end: 16,

        row_id: None,
        column_id: None,
        range_unit: None,
        expected_text: None,
        formatting: DocumentTextFormatting::default(),
      },
    ] {
      assert!(apply_document_mutation(&original, &mutation).is_err());
    }
  }

  #[test]
  fn unicode_offsets_account_for_native_embeds_without_losing_them() {
    let doc = yrs::Doc::with_options(yrs::Options {
      offset_kind: yrs::OffsetKind::Bytes,
      ..Default::default()
    });
    let text = doc.get_or_insert_text("native");
    let mut txn = doc.transact_mut();
    text.insert(&mut txn, 0, "é😀");
    text.insert_embed(
      &mut txn,
      2,
      Any::Map(Arc::new(HashMap::from([(
        "reference".to_string(),
        Any::String("protected".into()),
      )]))),
    );
    assert_eq!(
      resolve_text_range(
        &text,
        &txn,
        2,
        4,
        Some(DocumentTextRangeUnit::Utf16CodeUnits),
        Some("😀")
      ),
      Ok((3, 7))
    );
    assert_eq!(
      resolve_text_range(
        &text,
        &txn,
        2,
        3,
        Some(DocumentTextRangeUnit::UnicodeScalars),
        Some("😀")
      ),
      Ok((3, 7))
    );
    assert_eq!(
      resolve_text_range(&text, &txn, 1, 2, Some(DocumentTextRangeUnit::UnicodeScalars), Some("")),
      Err(DocumentMutationError::ExpectedTextMismatch)
    );
    let (start, end) = resolve_text_range(
      &text,
      &txn,
      2,
      3,
      Some(DocumentTextRangeUnit::UnicodeScalars),
      Some("😀"),
    )
    .expect("range beyond embed");
    text.remove_range(&mut txn, start, end - start);
    text.insert(&mut txn, start, "🌿");
    assert_eq!(text.get_string(&txn), "é🌿");
    assert!(text.diff(&txn,|_|()).iter().any(|part| matches!(&part.insert,yrs::Out::Any(Any::Map(map)) if map.get("reference")==Some(&Any::String("protected".into())))),"native embedded identity remains untouched");
  }

  #[test]
  fn prepend_and_replace_mutate_existing_tree_without_reimporting_it() {
    let original = crate::markdown_to_yjs("Document", "## Keep\n\nOriginal\n\n## Replace\n\nOld").expect("fixture");
    let prepended = apply_document_mutation(
      &original,
      &DocumentMutation::PrependBlocks {
        fragment: fragment("Prepended"),
      },
    )
    .expect("prepend");
    assert!(!prepended.delta.is_empty());
    let merged = crate::merge_updates(vec![original, prepended.delta]).expect("merge prepend");
    let replaced = apply_document_mutation(
      &merged,
      &DocumentMutation::ReplaceHeadingSection {
        heading: "Replace".to_string(),
        fragment: fragment("New"),
      },
    )
    .expect("replace section");
    let merged = crate::merge_updates(vec![merged, replaced.delta]).expect("merge replacement");
    let markdown = crate::extract_text_from_yjs(&merged).expect("extract").markdown;
    assert!(markdown.contains("Keep"));
    assert!(markdown.contains("Prepended"));
    assert!(markdown.contains("New"));
    assert!(!markdown.contains("Old"));
    assert_eq!(markdown.matches("## Replace").count(), 1);
  }

  #[test]
  fn heading_target_must_be_unique_and_missing_block_never_writes() {
    let original = crate::markdown_to_yjs("Document", "## Same\n\nOne\n\n## Same\n\nTwo").expect("fixture");
    assert_eq!(
      apply_document_mutation(
        &original,
        &DocumentMutation::AppendToHeading {
          heading: "Same".to_string(),
          fragment: fragment("No write"),
        },
      ),
      Err(DocumentMutationError::AmbiguousHeading)
    );
    assert_eq!(
      apply_document_mutation(
        &original,
        &DocumentMutation::ReplaceBlock {
          block_id: "missing".to_string(),
          fragment: fragment("No write"),
        },
      ),
      Err(DocumentMutationError::TargetNotFound)
    );
  }

  #[test]
  fn delete_move_and_text_edit_change_only_the_requested_content() {
    let original = crate::markdown_to_yjs("Document", "First\n\nSecond\n\nThird").expect("fixture");
    let ids = content_block_ids(&original);
    let edited = apply_document_mutation(
      &original,
      &DocumentMutation::EditText {
        block_id: ids[1].clone(),
        start: 0,
        end: 6,
        replacement: "Changed".to_string(),
        replacement_spans: None,
        text_field: None,
        range_unit: None,
        expected_text: None,
      },
    )
    .expect("edit existing text");
    let edited = crate::merge_updates(vec![original.clone(), edited.delta]).expect("edited state");
    assert_eq!(content_block_ids(&edited), ids);
    assert_eq!(
      crate::extract_text_from_yjs(&edited).unwrap().markdown.trim(),
      "First\n\nChanged\n\nThird"
    );
    let moved = apply_document_mutation(
      &edited,
      &DocumentMutation::MoveBlock {
        block_id: ids[2].clone(),
        after_block_id: Some(ids[0].clone()),
        parent_block_id: None,
      },
    )
    .expect("move existing block");
    let moved = crate::merge_updates(vec![edited, moved.delta]).expect("moved state");
    assert_eq!(
      content_block_ids(&moved),
      vec![ids[0].clone(), ids[2].clone(), ids[1].clone()]
    );
    let deleted = apply_document_mutation(
      &moved,
      &DocumentMutation::DeleteBlock {
        block_id: ids[2].clone(),
      },
    )
    .expect("delete existing block");
    assert_eq!(deleted.removed_block_ids, vec![ids[2].clone()]);
    let deleted = crate::merge_updates(vec![moved, deleted.delta]).expect("deleted state");
    assert_eq!(content_block_ids(&deleted), vec![ids[0].clone(), ids[1].clone()]);
    assert_eq!(
      crate::extract_text_from_yjs(&deleted).unwrap().markdown.trim(),
      "First\n\nChanged"
    );
    let first = apply_document_mutation(
      &original,
      &DocumentMutation::EditText {
        block_id: "missing".to_string(),
        start: 0,
        end: 1,
        replacement: "X".to_string(),
        replacement_spans: None,
        text_field: None,
        range_unit: None,
        expected_text: None,
      },
    );
    assert_eq!(first, Err(DocumentMutationError::TargetNotFound));

    let blocks = crate::extract_text_from_yjs(&original).expect("extract");
    assert!(blocks.markdown.contains("First"));
  }

  #[test]
  fn block_property_validation_rejects_wrong_block_types() {
    let original = crate::markdown_to_yjs("Document", "Body").expect("fixture");
    let id = content_block_ids(&original).remove(0);
    let changed = apply_document_mutation(
      &original,
      &DocumentMutation::UpdateBlockProperties {
        block_id: id.clone(),
        properties: DocumentBlockProperties {
          heading_level: Some(2),
          ..Default::default()
        },
      },
    )
    .expect("paragraph can become heading");
    let changed = crate::merge_updates(vec![original.clone(), changed.delta]).expect("heading state");
    assert_eq!(
      crate::extract_text_from_yjs(&changed).unwrap().markdown.trim(),
      "## Body"
    );
    assert_eq!(
      apply_document_mutation(
        &original,
        &DocumentMutation::UpdateBlockProperties {
          block_id: id,
          properties: DocumentBlockProperties {
            checked: Some(true),
            ..Default::default()
          },
        }
      ),
      Err(DocumentMutationError::InvalidBlockProperties)
    );
    let result = apply_document_mutation(
      &original,
      &DocumentMutation::UpdateBlockProperties {
        block_id: "missing".to_string(),
        properties: DocumentBlockProperties {
          heading_level: Some(2),
          ..Default::default()
        },
      },
    );
    assert_eq!(result, Err(DocumentMutationError::TargetNotFound));
  }

  /// A page/note with two footnote definitions and a paragraph plus a table cell
  /// carrying repeated markers for `def1`.
  fn footnote_fixture() -> Vec<u8> {
    let doc = yrs::Doc::with_options(yrs::Options {
      offset_kind: yrs::OffsetKind::Bytes,
      ..Default::default()
    });
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    let (_, page_children) = crate::create_yjs_block(&blocks, &mut txn, "page", "myoxus:page");
    let (_, note_children) = crate::create_yjs_block(&blocks, &mut txn, "note", "myoxus:note");
    page_children.push_back(&mut txn, "note");
    let (def1, _) = crate::create_yjs_block(&blocks, &mut txn, "def1", "myoxus:footnote-definition");
    def1.insert(&mut txn, "prop:label", "First");
    note_children.push_back(&mut txn, "def1");
    let (def2, _) = crate::create_yjs_block(&blocks, &mut txn, "def2", "myoxus:footnote-definition");
    def2.insert(&mut txn, "prop:label", "Second");
    note_children.push_back(&mut txn, "def2");
    let marker = |label: &str, definition_id: &str| {
      let mut map = std::collections::HashMap::new();
      map.insert("label".to_string(), yrs::Any::String(label.into()));
      map.insert("definitionId".to_string(), yrs::Any::String(definition_id.into()));
      yrs::types::Attrs::from_iter([(Arc::from("footnote"), yrs::Any::Map(Arc::new(map)))])
    };
    let (para, _) = crate::create_yjs_block(&blocks, &mut txn, "para", "myoxus:paragraph");
    let text = para.insert(&mut txn, "prop:text", yrs::TextPrelim::new("body text"));
    text.insert(&mut txn, 0, " ");
    text.format(&mut txn, 0, 1, marker("First", "def1"));
    text.insert(&mut txn, 10, " ");
    text.format(&mut txn, 10, 1, marker("First", "def1"));
    page_children.push_back(&mut txn, "para");
    let (table, _) = crate::create_yjs_block(&blocks, &mut txn, "table", "myoxus:table");
    let cell = table.insert(&mut txn, "prop:cells.0:0.text", yrs::TextPrelim::new(""));
    cell.insert(&mut txn, 0, " ");
    cell.format(&mut txn, 0, 1, marker("First", "def1"));
    page_children.push_back(&mut txn, "table");
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
  }

  /// Every footnote marker in a state, as (block, label, definitionId).
  fn footnote_markers(state: &[u8]) -> Vec<(String, String, String)> {
    let doc = yrs::Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(state).expect("decode fixture"))
      .expect("apply fixture");
    let txn = doc.transact();
    let mut result = Vec::new();
    for (id, value) in blocks.iter(&txn) {
      let yrs::Out::YMap(block) = value else { continue };
      for (key, value) in block.iter(&txn) {
        if !super::is_block_text_key(key) {
          continue;
        }
        if let yrs::Out::YText(text) = value {
          for diff in text.diff(&txn, |_| ()) {
            if let Some(note) = diff.attributes.as_ref().and_then(|attrs| attrs.get("footnote")) {
              let json = crate::yjs_any_to_json(note);
              result.push((
                id.to_string(),
                json
                  .get("label")
                  .and_then(|value| value.as_str())
                  .unwrap_or_default()
                  .to_string(),
                json
                  .get("definitionId")
                  .and_then(|value| value.as_str())
                  .unwrap_or_default()
                  .to_string(),
              ));
            }
          }
        }
      }
    }
    result
  }

  /// A page/note with equivalent but differently spelled inline/card labels.
  fn citation_fixture() -> Vec<u8> {
    let doc = yrs::Doc::with_options(yrs::Options {
      offset_kind: yrs::OffsetKind::Bytes,
      ..Default::default()
    });
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    let (_, page_children) = crate::create_yjs_block(&blocks, &mut txn, "page", "myoxus:page");
    let (_, note_children) = crate::create_yjs_block(&blocks, &mut txn, "note", "myoxus:note");
    page_children.push_back(&mut txn, "note");
    // Inline citation marker: label "Ref " (normalizes to "ref"), url reference.
    let (para, _) = crate::create_yjs_block(&blocks, &mut txn, "para", "myoxus:paragraph");
    let text = para.insert(&mut txn, "prop:text", yrs::TextPrelim::new("body text"));
    text.insert(&mut txn, 0, " ");
    let mut note_map = std::collections::HashMap::new();
    note_map.insert("label".to_string(), yrs::Any::String("Ref ".into()));
    note_map.insert(
      "reference".to_string(),
      crate::json_to_yjs_any(&serde_json::json!({"type":"url","url":"https://example.com/original"}))
        .expect("reference"),
    );
    text.format(
      &mut txn,
      0,
      1,
      yrs::types::Attrs::from_iter([(Arc::from("footnote"), yrs::Any::Map(Arc::new(note_map)))]),
    );
    text.insert_with_attributes(
      &mut txn,
      1,
      " ",
      Attrs::from_iter([(
        Arc::from("footnote"),
        crate::json_to_yjs_any(
          &serde_json::json!({"label":"rEf","reference":{"type":"url","url":"https://example.com/original"}}),
        )
        .unwrap(),
      )]),
    );
    page_children.push_back(&mut txn, "para");
    for (card_id, label) in [("card1", "REF"), ("card2", "ref ")] {
      let (card, _) = crate::create_yjs_block(&blocks, &mut txn, card_id, "myoxus:bookmark");
      card.insert(&mut txn, "prop:style", "citation");
      card.insert(&mut txn, "prop:footnoteIdentifier", label);
      card.insert(&mut txn, "prop:url", "https://example.com/original");
      card.insert(&mut txn, "prop:description", Any::Null);
      card.insert(&mut txn, "prop:icon", Any::Null);
      note_children.push_back(&mut txn, card_id);
    }
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
  }

  /// Every inline citation marker in a state, as (block, label, reference).
  fn citation_markers(state: &[u8]) -> Vec<(String, String, serde_json::Value)> {
    let doc = yrs::Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(state).expect("decode fixture"))
      .expect("apply fixture");
    let txn = doc.transact();
    let mut result = Vec::new();
    for (id, value) in blocks.iter(&txn) {
      let yrs::Out::YMap(block) = value else { continue };
      for (key, value) in block.iter(&txn) {
        if !super::is_block_text_key(key) {
          continue;
        }
        if let yrs::Out::YText(text) = value {
          for diff in text.diff(&txn, |_| ()) {
            if let Some(note) = diff.attributes.as_ref().and_then(|attrs| attrs.get("footnote")) {
              let json = crate::yjs_any_to_json(note);
              // A citation marker carries a reference and no definition identity.
              if json.get("definitionId").is_none() && json.get("reference").is_some() {
                result.push((
                  id.to_string(),
                  json
                    .get("label")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                  json.get("reference").cloned().unwrap_or(serde_json::Value::Null),
                ));
              }
            }
          }
        }
      }
    }
    result
  }

  fn prop_string(state: &[u8], block_id: &str, key: &str) -> Option<String> {
    let doc = yrs::Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(state).expect("decode fixture"))
      .expect("apply fixture");
    let txn = doc.transact();
    let yrs::Out::YMap(block) = blocks.get(&txn, block_id)? else {
      return None;
    };
    block.get(&txn, &format!("prop:{key}")).and_then(|value| match value {
      yrs::Out::Any(yrs::Any::String(value)) => Some(value.to_string()),
      _ => None,
    })
  }

  #[test]
  fn footnote_label_rename_updates_all_markers_and_rejects_collisions() {
    let original = footnote_fixture();
    // A valid rename updates the definition label and every marker (body and
    // table cell) in the same mutation, retaining the definition identity.
    let renamed = apply_document_mutation(
      &original,
      &DocumentMutation::UpdateBlockProperties {
        block_id: "def1".to_string(),
        properties: DocumentBlockProperties {
          label: Some("Renamed".to_string()),
          ..Default::default()
        },
      },
    )
    .expect("valid rename");
    assert_eq!(prop_string(&renamed.state, "def1", "label").as_deref(), Some("Renamed"));
    let markers = footnote_markers(&renamed.state);
    let def1_markers = markers
      .iter()
      .filter(|(_, _, definition_id)| definition_id == "def1")
      .count();
    assert_eq!(def1_markers, 3, "body and table-cell markers");
    assert!(
      markers
        .iter()
        .filter(|(_, _, definition_id)| definition_id == "def1")
        .all(|(_, label, _)| label == "Renamed")
    );
    // The rename reports the definition and every marker block it changed,
    // and leaves the untouched definition out of the report.
    let mut reported = renamed.updated_block_ids.clone();
    reported.sort();
    assert_eq!(
      reported,
      vec!["def1".to_string(), "para".to_string(), "table".to_string()]
    );
    // The second definition and its label stay untouched.
    assert_eq!(prop_string(&renamed.state, "def2", "label").as_deref(), Some("Second"));
    // Omission preserves the label.
    let preserved = apply_document_mutation(
      &renamed.state,
      &DocumentMutation::UpdateBlockProperties {
        block_id: "def1".to_string(),
        properties: DocumentBlockProperties::default(),
      },
    )
    .expect("omission preserves");
    assert_eq!(
      prop_string(&preserved.state, "def1", "label").as_deref(),
      Some("Renamed")
    );
    // A colliding label (normalized comparison) is rejected without persistence.
    assert_eq!(
      apply_document_mutation(
        &renamed.state,
        &DocumentMutation::UpdateBlockProperties {
          block_id: "def1".to_string(),
          properties: DocumentBlockProperties {
            label: Some("second".to_string()),
            ..Default::default()
          },
        },
      ),
      Err(DocumentMutationError::InvalidBlockProperties)
    );
    // A marker-occupied label is rejected even with no matching definition.
    assert_eq!(
      apply_document_mutation(
        &renamed.state,
        &DocumentMutation::UpdateBlockProperties {
          block_id: "def2".to_string(),
          properties: DocumentBlockProperties {
            label: Some("renamed".to_string()),
            ..Default::default()
          },
        },
      ),
      Err(DocumentMutationError::InvalidBlockProperties)
    );
    // A malformed label (fails the Markdown parser check) is rejected.
    assert_eq!(
      apply_document_mutation(
        &original,
        &DocumentMutation::UpdateBlockProperties {
          block_id: "def1".to_string(),
          properties: DocumentBlockProperties {
            label: Some("a]b".to_string()),
            ..Default::default()
          },
        },
      ),
      Err(DocumentMutationError::InvalidBlockProperties)
    );
    // A non-footnote-definition block is rejected.
    assert_eq!(
      apply_document_mutation(
        &original,
        &DocumentMutation::UpdateBlockProperties {
          block_id: "para".to_string(),
          properties: DocumentBlockProperties {
            label: Some("Renamed".to_string()),
            ..Default::default()
          },
        },
      ),
      Err(DocumentMutationError::InvalidBlockProperties)
    );
  }

  #[test]
  fn footnote_placement_set_and_remove_revert_to_the_legacy_default() {
    let original = footnote_fixture();
    // Set writes the native placement.
    let endnote = apply_document_mutation(
      &original,
      &DocumentMutation::UpdateBlockProperties {
        block_id: "def1".to_string(),
        properties: DocumentBlockProperties {
          placement: Some(DocumentAttributeChange::Set {
            value: crate::footnote::FootnotePlacement::Endnote,
          }),
          ..Default::default()
        },
      },
    )
    .expect("placement set");
    assert_eq!(
      prop_string(&endnote.state, "def1", "placement").as_deref(),
      Some("endnote")
    );
    // Remove reverts to the legacy absent default without rewriting stored data.
    let removed = apply_document_mutation(
      &endnote.state,
      &DocumentMutation::UpdateBlockProperties {
        block_id: "def1".to_string(),
        properties: DocumentBlockProperties {
          placement: Some(DocumentAttributeChange::Remove {}),
          ..Default::default()
        },
      },
    )
    .expect("placement remove");
    assert_eq!(prop_string(&removed.state, "def1", "placement"), None);
    // A non-footnote-definition block is rejected.
    assert_eq!(
      apply_document_mutation(
        &original,
        &DocumentMutation::UpdateBlockProperties {
          block_id: "para".to_string(),
          properties: DocumentBlockProperties {
            placement: Some(DocumentAttributeChange::Set {
              value: crate::footnote::FootnotePlacement::Endnote,
            }),
            ..Default::default()
          },
        },
      ),
      Err(DocumentMutationError::InvalidBlockProperties)
    );
  }

  #[test]
  fn valid_footnote_label_round_trips_through_the_markdown_parser() {
    assert!(crate::markdown::valid_footnote_label("First"));
    assert!(crate::markdown::valid_footnote_label("1"));
    assert!(crate::markdown::valid_footnote_label("some label"));
    // A closing bracket breaks the definition syntax.
    assert!(!crate::markdown::valid_footnote_label("a]b"));
    // Whitespace-only labels normalize to empty.
    assert!(!crate::markdown::valid_footnote_label("   "));
  }

  #[test]
  fn citation_updates_reject_ambiguous_inline_sources_even_with_replacements() {
    let original = citation_fixture();
    let doc = yrs::Doc::new();
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&original).unwrap())
      .unwrap();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    let yrs::Out::YMap(para) = blocks.get(&txn, "para").unwrap() else {
      panic!("paragraph")
    };
    let yrs::Out::YText(text) = para.get(&txn, "prop:text").unwrap() else {
      panic!("text")
    };
    let reference =
      serde_json::json!({"label":"ref","reference":{"type":"url","url":"https://example.com/contradiction"}});
    text.insert_with_attributes(
      &mut txn,
      1,
      " ",
      Attrs::from_iter([(Arc::from("footnote"), crate::json_to_yjs_any(&reference).unwrap())]),
    );
    let conflicting = txn.encode_state_as_update_v1(&yrs::StateVector::default());
    drop(txn);
    for mutation in [
      DocumentMutation::UpdateCitation {
        label: "ref".into(),
        new_label: Some("renamed".into()),
        reference: None,
      },
      DocumentMutation::UpdateCitation {
        label: "ref".into(),
        new_label: None,
        reference: Some(serde_json::json!({"type":"url","url":"https://example.com/new"})),
      },
      DocumentMutation::UpdateBlockProperties {
        block_id: "card1".into(),
        properties: DocumentBlockProperties {
          title: Some("New title".into()),
          ..Default::default()
        },
      },
    ] {
      assert_eq!(
        apply_document_mutation(&conflicting, &mutation),
        Err(DocumentMutationError::InvalidFragment)
      );
    }
  }

  #[test]
  fn citation_update_preserves_stored_label_verbatim_and_updates_all_cards() {
    use yrs::Observable;
    let original = citation_fixture();
    // Web observes URL map events to refresh previews. A title-only edit must
    // not emit one, even if the stored and written URL strings compare equal.
    let observed = yrs::Doc::new();
    observed
      .transact_mut()
      .apply_update(Update::decode_v1(&original).unwrap())
      .unwrap();
    let observed_blocks = observed.get_or_insert_map("blocks");
    let yrs::Out::YMap(card) = observed_blocks.get(&observed.transact(), "card1").unwrap() else {
      panic!("card")
    };
    let changed_keys = Arc::new(std::sync::Mutex::new(Vec::new()));
    let keys = changed_keys.clone();
    card.observe("citation-title-only", move |txn, event| {
      keys
        .lock()
        .unwrap()
        .extend(event.keys(txn).keys().map(|key| key.to_string()));
    });
    let title_update = apply_document_mutation(
      &original,
      &DocumentMutation::UpdateBlockProperties {
        block_id: "card1".into(),
        properties: DocumentBlockProperties {
          title: Some("New title".into()),
          ..Default::default()
        },
      },
    )
    .unwrap();
    observed
      .transact_mut()
      .apply_update(Update::decode_v1(&title_update.delta).unwrap())
      .unwrap();
    assert_eq!(*changed_keys.lock().unwrap(), vec!["prop:title"]);
    assert_eq!(
      apply_document_mutation(
        &original,
        &DocumentMutation::UpdateBlockProperties {
          block_id: "card1".into(),
          properties: DocumentBlockProperties {
            title: Some("Valid source title".into()),
            latex: Some("ignored before forwarding".into()),
            ..Default::default()
          },
        }
      ),
      Err(DocumentMutationError::InvalidBlockProperties)
    );
    // Reference-only edits preserve each distinct stored label, not just the
    // first marker's spelling. Keep this fixture non-uniform.
    let updated = apply_document_mutation(
      &original,
      &DocumentMutation::UpdateCitation {
        label: "ref".to_string(),
        new_label: None,
        reference: Some(serde_json::json!({"type":"url","url":"https://example.com/updated"})),
      },
    )
    .expect("citation update");
    let markers = citation_markers(&updated.state);
    assert_eq!(
      markers.iter().map(|marker| marker.1.as_str()).collect::<Vec<_>>(),
      vec!["Ref ", "rEf"]
    );
    assert!(
      markers
        .iter()
        .all(|marker| marker.2["url"] == "https://example.com/updated")
    );
    // Both source cards are updated to the new reference.
    for card_id in ["card1", "card2"] {
      assert_eq!(
        prop_string(&updated.state, card_id, "footnoteIdentifier"),
        prop_string(&original, card_id, "footnoteIdentifier")
      );
      assert_eq!(
        prop_string(&updated.state, card_id, "url").as_deref(),
        Some("https://example.com/updated")
      );
    }
    // The affected report includes the inline marker block and both cards.
    let mut affected = updated.updated_block_ids.clone();
    affected.sort();
    assert_eq!(
      affected,
      vec!["card1".to_string(), "card2".to_string(), "para".to_string()]
    );
    let replaced = apply_document_mutation(
      &original,
      &DocumentMutation::UpdateCitation {
        label: "ref".into(),
        new_label: None,
        reference: Some(serde_json::json!({"type":"doc","docId":"target"})),
      },
    )
    .unwrap();
    let mut labels = replaced
      .inserted_block_ids
      .iter()
      .map(|id| prop_string(&replaced.state, id, "footnoteIdentifier").unwrap())
      .collect::<Vec<_>>();
    labels.sort();
    assert_eq!(labels, vec!["REF", "ref "]);
    assert_eq!(
      citation_markers(&replaced.state)
        .iter()
        .map(|marker| marker.1.as_str())
        .collect::<Vec<_>>(),
      vec!["Ref ", "rEf"]
    );
  }

  #[test]
  fn structured_fragments_are_bounded_before_any_yjs_mutation() {
    let original = crate::markdown_to_yjs("Document", "Body").expect("fixture");
    let oversized = DocumentFragment {
      schema_version: DOCUMENT_FRAGMENT_SCHEMA.to_string(),
      blocks: vec![DocumentFragmentBlock::Paragraph {
        properties: None,
        text: text(&"x".repeat(MAX_FRAGMENT_TEXT_BYTES + 1)),
      }],
    };
    assert_eq!(
      apply_document_mutation(&original, &DocumentMutation::AppendBlocks { fragment: oversized }),
      Err(DocumentMutationError::InvalidFragment)
    );
  }

  #[test]
  fn fragment_wire_uses_schema_documented_camel_case_fields() {
    let value = serde_json::json!({
      "schemaVersion": DOCUMENT_FRAGMENT_SCHEMA,
      "blocks": [{
        "kind": "list_item",
        "listKind": "todo",
        "spans": [{ "text": "Ship it" }],
        "checked": true,
        "children": []
      }]
    });
    let fragment: DocumentFragment = serde_json::from_value(value).expect("documented fragment wire format");
    assert!(matches!(
      fragment.blocks.as_slice(),
      [DocumentFragmentBlock::ListItem {
        list_kind: DocumentListKind::Todo,
        checked: true,
        ..
      }]
    ));
    let wire = serde_json::to_value(fragment).expect("fragment wire JSON");
    assert_eq!(wire["blocks"][0]["listKind"], "todo");
    assert!(wire["blocks"][0].get("list_kind").is_none());
  }

  #[test]
  fn linked_page_reference_is_incremental_positioned_and_preserves_url_links() {
    let original = crate::markdown_to_yjs("Document", "First\n\n[External](https://example.com/reference)\n\nLast")
      .expect("fixture");
    let original_ids = content_block_ids(&original);
    let appended = apply_document_mutation(
      &original,
      &DocumentMutation::InsertLinkedPageReference {
        target_external_id: "target-external-key".to_string(),
        label: "Target page".to_string(),
        after_block_id: None,
      },
    )
    .expect("append reference");
    assert!(!appended.delta.is_empty());
    let appended_id = appended.inserted_block_ids[0].clone();
    let merged = crate::merge_updates(vec![original, appended.delta]).expect("merge append");
    let merged_ids = content_block_ids(&merged);
    assert_eq!(merged_ids.last(), Some(&appended_id));

    let extracted = crate::extract_document_references_from_yjs(&merged).expect("extract references");
    assert_eq!(extracted.occurrences.len(), 1);
    let reference = &extracted.occurrences[0];
    assert_eq!(reference.source_block_id, appended_id);
    assert_eq!(reference.raw_target_doc_id, "target-external-key");
    assert!(reference.markdown_preview.is_empty());
    assert_eq!(reference.params_json["title"], "Target page");
    let markdown = crate::extract_text_from_yjs(&merged).expect("extract text").markdown;
    assert!(markdown.contains("https://example.com/reference"));

    let inserted = apply_document_mutation(
      &merged,
      &DocumentMutation::InsertLinkedPageReference {
        target_external_id: "second-target".to_string(),
        label: "Second target".to_string(),
        after_block_id: Some(original_ids[0].clone()),
      },
    )
    .expect("insert reference after block");
    let inserted_id = inserted.inserted_block_ids[0].clone();
    let merged = crate::merge_updates(vec![merged, inserted.delta]).expect("merge insertion");
    let merged_ids = content_block_ids(&merged);
    assert_eq!(merged_ids[1], inserted_id);
    let extracted = crate::extract_document_references_from_yjs(&merged).expect("extract references");
    assert_eq!(extracted.occurrences.len(), 2);
  }
}
