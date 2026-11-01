// SPDX-License-Identifier: AGPL-3.0-or-later
//! Content variants stored inside CRDT items.
//!
//! Clean reimplementation. Wire format matches y-octo exactly.
//!
//! ## Deviation B-01: UTF-16 string clocks
//!
//! String lengths are measured in **UTF-16 code units** (JavaScript
//! `String.length` semantics), not UTF-8 bytes or Unicode codepoints.
//!
//! ## Deviation B-02: UTF-16 string splitting
//!
//! `Content::String` splits at a **UTF-16 offset**, not a byte offset.
//!
//! ## Deviation F-01: Content tag mapping (tags 1-9)
//! ## Deviation F-02: Embed and Format use double-JSON encoding
//! ## Deviation F-03: Only String/Json/Any/Deleted are splittable

use super::any::Any;
use super::error::{CodecError, CodecResult};
use super::varint::{RawDecoder, RawEncoder};

/// Content stored inside a CRDT item.
///
/// Tag mapping (deviation F-01):
/// - 1 = Deleted, 2 = Json, 3 = Binary, 4 = String, 5 = Embed
/// - 6 = Format, 7 = Type, 8 = Any, 9 = Doc
#[derive(Debug, Clone, PartialEq)]
pub enum Content {
  /// Tag 1: N deleted characters.
  Deleted(u64),
  /// Tag 2: Array of optional JSON strings.
  Json(Vec<Option<String>>),
  /// Tag 3: Raw binary data.
  Binary(Vec<u8>),
  /// Tag 4: UTF-16-aware text string.
  String(String),
  /// Tag 5: Embedded value (double-JSON encoded on wire).
  Embed(Any),
  /// Tag 6: Formatting attribute (key + double-JSON value).
  Format { key: String, value: Any },
  /// Tag 7: Nested CRDT type (Array/Map/Text/XML*).
  Type {
    /// Type discriminant (0=Array..6=XMLText).
    type_ref: u64,
    /// Tag name for XMLElement (3) and XMLHook (5).
    tag_name: Option<String>,
  },
  /// Tag 8: Array of Any values.
  Any(Vec<Any>),
  /// Tag 9: Shared document reference.
  Doc { guid: String, opts: Any },
}

impl Content {
  /// Decode content from the wire given the tag from the info byte.
  pub fn read(dec: &mut RawDecoder, tag: u8) -> CodecResult<Self> {
    match tag {
      1 => Ok(Content::Deleted(dec.read_var_u64()?)),
      2 => {
        let len = dec.read_var_u64()? as usize;
        let mut strings = Vec::with_capacity(len.min(1024));
        for _ in 0..len {
          let s = dec.read_var_string()?;
          strings.push(if s == "undefined" { None } else { Some(s) });
        }
        Ok(Content::Json(strings))
      }
      3 => Ok(Content::Binary(dec.read_var_buffer()?)),
      4 => Ok(Content::String(dec.read_var_string()?)),
      5 => {
        // DEVIATION F-02: Embed is stored as a JSON string on the wire,
        // not as direct Any encoding. Parse JSON → Any.
        let json_str = dec.read_var_string()?;
        let value: Any = serde_json::from_str(&json_str).map_err(|e| CodecError::DamagedJson(e.to_string()))?;
        Ok(Content::Embed(value))
      }
      6 => {
        // DEVIATION F-02: Format value is also double-JSON encoded.
        let key = dec.read_var_string()?;
        let json_str = dec.read_var_string()?;
        let value: Any = serde_json::from_str(&json_str).map_err(|e| CodecError::DamagedJson(e.to_string()))?;
        Ok(Content::Format { key, value })
      }
      7 => {
        let type_ref = dec.read_var_u64()?;
        let tag_name = match type_ref {
          3 | 5 => Some(dec.read_var_string()?), // XMLElement | XMLHook
          0..=6 => None,
          _ => {
            return Err(CodecError::UnknownTypeRef(type_ref));
          }
        };
        Ok(Content::Type { type_ref, tag_name })
      }
      8 => Ok(Content::Any(Any::read_multiple(dec)?)),
      9 => {
        let guid = dec.read_var_string()?;
        let opts = Any::read(dec)?;
        Ok(Content::Doc { guid, opts })
      }
      other => Err(CodecError::InvalidTag(other)),
    }
  }

  /// The content tag (first 5 bits of the info byte).
  pub fn tag(&self) -> u8 {
    match self {
      Content::Deleted(_) => 1,
      Content::Json(_) => 2,
      Content::Binary(_) => 3,
      Content::String(_) => 4,
      Content::Embed(_) => 5,
      Content::Format { .. } => 6,
      Content::Type { .. } => 7,
      Content::Any(_) => 8,
      Content::Doc { .. } => 9,
    }
  }

  /// Encode content to the wire (tag is already written as part of the info byte).
  pub fn write(&self, enc: &mut RawEncoder) -> CodecResult<()> {
    match self {
      Content::Deleted(len) => enc.write_var_u64(*len),
      Content::Json(strings) => {
        enc.write_var_u64(strings.len() as u64);
        for s in strings {
          match s {
            Some(s) => enc.write_var_string(s),
            None => enc.write_var_string("undefined"),
          }
        }
      }
      Content::Binary(buf) => enc.write_var_buffer(buf),
      Content::String(s) => enc.write_var_string(s),
      Content::Embed(val) => {
        // DEVIATION F-02: serialize Any → JSON string, then write as var_string.
        let json = serde_json::to_string(val).map_err(|e| CodecError::DamagedJson(e.to_string()))?;
        enc.write_var_string(&json);
      }
      Content::Format { key, value } => {
        enc.write_var_string(key);
        // DEVIATION F-02: double-JSON for format value.
        let json = serde_json::to_string(value).map_err(|e| CodecError::DamagedJson(e.to_string()))?;
        enc.write_var_string(&json);
      }
      Content::Type { type_ref, tag_name } => {
        enc.write_var_u64(*type_ref);
        // XMLElement (3) and XMLHook (5) have a tag name.
        if matches!(type_ref, 3 | 5)
          && let Some(name) = tag_name
        {
          enc.write_var_string(name);
        }
      }
      Content::Any(values) => Any::write_multiple(enc, values),
      Content::Doc { guid, opts } => {
        enc.write_var_string(guid);
        opts.write(enc);
      }
    }
    Ok(())
  }

  /// Clock length of this content.
  ///
  /// **Deviation B-01**: String length is counted in **UTF-16 code units**,
  /// not UTF-8 bytes or Unicode codepoints.
  pub fn clock_len(&self) -> u64 {
    match self {
      Content::Deleted(n) => *n,
      Content::Json(v) => v.len() as u64,
      // DEVIATION B-01: UTF-16 code units.
      Content::String(s) => utf16_len(s),
      Content::Any(v) => v.len() as u64,
      Content::Binary(_) | Content::Embed(_) | Content::Format { .. } | Content::Type { .. } | Content::Doc { .. } => 1,
    }
  }

  /// Whether this content type is countable (contributes to parent length).
  pub fn countable(&self) -> bool {
    !matches!(self, Content::Format { .. } | Content::Deleted(_))
  }

  /// Split this content at `offset`.
  ///
  /// **Deviation F-03**: Only String, Json, Any, and Deleted are splittable.
  /// All other types return `Err(ContentSplitNotSupported)`.
  ///
  /// **Deviation B-02**: String splits at a **UTF-16 offset**.
  pub fn split(&self, offset: u64) -> CodecResult<(Content, Content)> {
    match self {
      Content::String(s) => {
        // DEVIATION B-02: split at UTF-16 offset.
        let (left, right) = split_utf16(s, offset);
        Ok((Content::String(left.to_string()), Content::String(right.to_string())))
      }
      Content::Json(v) => {
        let i = offset as usize;
        Ok((Content::Json(v[..i].to_vec()), Content::Json(v[i..].to_vec())))
      }
      Content::Any(v) => {
        let i = offset as usize;
        Ok((Content::Any(v[..i].to_vec()), Content::Any(v[i..].to_vec())))
      }
      Content::Deleted(len) => Ok((Content::Deleted(offset), Content::Deleted(*len - offset))),
      _ => Err(CodecError::ContentSplitNotSupported {
        tag: self.tag_name(),
        offset,
      }),
    }
  }

  fn tag_name(&self) -> &'static str {
    match self {
      Content::Deleted(_) => "Deleted",
      Content::Json(_) => "Json",
      Content::Binary(_) => "Binary",
      Content::String(_) => "String",
      Content::Embed(_) => "Embed",
      Content::Format { .. } => "Format",
      Content::Type { .. } => "Type",
      Content::Any(_) => "Any",
      Content::Doc { .. } => "Doc",
    }
  }
}

// ── UTF-16 helpers (deviations B-01, B-02) ──────────────────────────────────

/// Compute string length in UTF-16 code units (JavaScript `String.length`).
///
/// ASCII chars = 1 unit. CJK chars = 1 unit. Emoji/supplementary = 2 units (surrogate pair).
pub fn utf16_len(s: &str) -> u64 {
  s.chars().map(|c| c.len_utf16() as u64).sum()
}

/// Split a string at a UTF-16 code unit offset.
///
/// Returns `(left, right)` where `utf16_len(left) == offset`.
pub fn split_utf16(s: &str, offset: u64) -> (&str, &str) {
  let mut utf16_count: u64 = 0;
  let mut byte_offset = 0;
  for ch in s.chars() {
    utf16_count += ch.len_utf16() as u64;
    byte_offset += ch.len_utf8();
    if utf16_count >= offset {
      break;
    }
  }
  s.split_at(byte_offset)
}
