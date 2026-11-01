// SPDX-License-Identifier: AGPL-3.0-or-later
//! The `Any` type — dynamically-typed values used in Yjs content.
//!
//! Clean reimplementation. Matches the y-octo wire format exactly.
//!
//! ## Deviation A-02: Object key sorting
//!
//! When writing `Any::Object`, keys are sorted **lexicographically ascending**
//! before encoding. Without this, HashMap iteration order is non-deterministic
//! and identical documents produce different binary output (P28 root cause).

use std::collections::HashMap;
use std::fmt;

use ordered_float::OrderedFloat;

use super::error::CodecResult;
use super::varint::{RawDecoder, RawEncoder};

/// Maximum safe integer in JavaScript: `Number.MAX_SAFE_INTEGER`.
const MAX_JS_INT: i64 = 0x001F_FFFF_FFFF_FFFF;
const MIN_JS_INT: i64 = -MAX_JS_INT;

/// Dynamically-typed value matching the Yjs `Any` wire format.
///
/// Tag mapping (stored as `127 - tag` on the wire):
/// - 0 = Undefined, 1 = Null, 2 = Integer, 3 = Float32, 4 = Float64
/// - 5 = BigInt64, 6 = False, 7 = True, 8 = String
/// - 9 = Object (keys sorted!), 10 = Array, 11 = Binary
#[derive(Debug, Clone, PartialEq)]
pub enum Any {
  Undefined,
  Null,
  Integer(i32),
  Float32(OrderedFloat<f32>),
  Float64(OrderedFloat<f64>),
  BigInt64(i64),
  False,
  True,
  String(String),
  Object(HashMap<String, Any>),
  Array(Vec<Any>),
  Binary(Vec<u8>),
}

impl Any {
  /// Decode a single `Any` value from the wire.
  pub fn read(dec: &mut RawDecoder) -> CodecResult<Self> {
    let tag = dec.read_u8()?;
    match 127u8.wrapping_sub(tag) {
      0 => Ok(Any::Undefined),
      1 => Ok(Any::Null),
      2 => Ok(Any::Integer(dec.read_var_i32()?)),
      3 => Ok(Any::Float32(dec.read_f32_be()?.into())),
      4 => Ok(Any::Float64(dec.read_f64_be()?.into())),
      5 => Ok(Any::BigInt64(dec.read_i64_be()?)),
      6 => Ok(Any::False),
      7 => Ok(Any::True),
      8 => Ok(Any::String(dec.read_var_string()?)),
      9 => {
        // Object: read key-value pairs
        let len = dec.read_var_u64()? as usize;
        let mut map = HashMap::with_capacity(len.min(1024));
        for _ in 0..len {
          let key = dec.read_var_string()?;
          let value = Any::read(dec)?;
          map.insert(key, value);
        }
        Ok(Any::Object(map))
      }
      10 => {
        // Array
        let len = dec.read_var_u64()? as usize;
        let mut vec = Vec::with_capacity(len.min(1024));
        for _ in 0..len {
          vec.push(Any::read(dec)?);
        }
        Ok(Any::Array(vec))
      }
      11 => Ok(Any::Binary(dec.read_var_buffer()?)),
      _ => Ok(Any::Undefined), // unknown tags → Undefined (y-octo compat)
    }
  }

  /// Encode a single `Any` value to the wire.
  ///
  /// **Deviation A-02**: Object keys are sorted lexicographically ascending.
  pub fn write(&self, enc: &mut RawEncoder) {
    match self {
      Any::Undefined => enc.write_u8(127),
      Any::Null => enc.write_u8(126),
      Any::Integer(v) => {
        enc.write_u8(125);
        enc.write_var_i32(*v);
      }
      Any::Float32(v) => {
        enc.write_u8(124);
        enc.write_f32_be(v.into_inner());
      }
      Any::Float64(v) => {
        enc.write_u8(123);
        enc.write_f64_be(v.into_inner());
      }
      Any::BigInt64(v) => {
        enc.write_u8(122);
        enc.write_i64_be(*v);
      }
      Any::False => enc.write_u8(121),
      Any::True => enc.write_u8(120),
      Any::String(s) => {
        enc.write_u8(119);
        enc.write_var_string(s);
      }
      Any::Object(map) => {
        enc.write_u8(118);
        enc.write_var_u64(map.len() as u64);
        // DEVIATION A-02: sort keys lexicographically for deterministic output.
        let mut keys: Vec<&String> = map.keys().collect();
        keys.sort();
        for key in keys {
          enc.write_var_string(key);
          map[key].write(enc);
        }
      }
      Any::Array(vec) => {
        enc.write_u8(117);
        enc.write_var_u64(vec.len() as u64);
        for val in vec {
          val.write(enc);
        }
      }
      Any::Binary(buf) => {
        enc.write_u8(116);
        enc.write_var_buffer(buf);
      }
    }
  }

  /// Read multiple `Any` values (varint count prefix).
  pub fn read_multiple(dec: &mut RawDecoder) -> CodecResult<Vec<Any>> {
    let len = dec.read_var_u64()? as usize;
    let mut vec = Vec::with_capacity(len.min(1024));
    for _ in 0..len {
      vec.push(Any::read(dec)?);
    }
    Ok(vec)
  }

  /// Write multiple `Any` values (varint count prefix).
  pub fn write_multiple(enc: &mut RawEncoder, values: &[Any]) {
    enc.write_var_u64(values.len() as u64);
    for val in values {
      val.write(enc);
    }
  }
}

// ── From impls ──────────────────────────────────────────────────────────────

impl From<bool> for Any {
  fn from(v: bool) -> Self {
    if v { Any::True } else { Any::False }
  }
}

impl From<i32> for Any {
  fn from(v: i32) -> Self {
    Any::Integer(v)
  }
}

impl From<i64> for Any {
  fn from(v: i64) -> Self {
    if (MIN_JS_INT..=MAX_JS_INT).contains(&v) {
      if v >= i32::MIN as i64 && v <= i32::MAX as i64 {
        Any::Integer(v as i32)
      } else {
        Any::Float64(OrderedFloat(v as f64))
      }
    } else {
      Any::BigInt64(v)
    }
  }
}

impl From<f64> for Any {
  fn from(v: f64) -> Self {
    if v.is_finite() && v.trunc() == v {
      (v as i64).into()
    } else if v as f32 as f64 == v {
      Any::Float32(OrderedFloat(v as f32))
    } else {
      Any::Float64(OrderedFloat(v))
    }
  }
}

impl From<String> for Any {
  fn from(v: String) -> Self {
    Any::String(v)
  }
}

impl From<&str> for Any {
  fn from(v: &str) -> Self {
    Any::String(v.to_string())
  }
}

impl From<HashMap<String, Any>> for Any {
  fn from(v: HashMap<String, Any>) -> Self {
    Any::Object(v)
  }
}

impl From<serde_json::Value> for Any {
  fn from(v: serde_json::Value) -> Self {
    match v {
      serde_json::Value::Null => Any::Null,
      serde_json::Value::Bool(b) => b.into(),
      serde_json::Value::Number(n) => {
        if let Some(i) = n.as_i64() {
          i.into()
        } else if let Some(f) = n.as_f64() {
          Any::Float64(OrderedFloat(f))
        } else {
          Any::Null
        }
      }
      serde_json::Value::String(s) => Any::String(s),
      serde_json::Value::Array(a) => Any::Array(a.into_iter().map(Any::from).collect()),
      serde_json::Value::Object(o) => Any::Object(o.into_iter().map(|(k, v)| (k, Any::from(v))).collect()),
    }
  }
}

// ── Serde (needed for Embed/Format double-JSON encoding — deviation F-02) ──

impl serde::Serialize for Any {
  fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
    use serde::ser::{SerializeMap, SerializeSeq};
    match self {
      Any::Null | Any::Undefined => ser.serialize_none(),
      Any::True => ser.serialize_bool(true),
      Any::False => ser.serialize_bool(false),
      Any::Integer(v) => ser.serialize_i32(*v),
      Any::Float32(v) => ser.serialize_f32(v.0),
      Any::Float64(v) => ser.serialize_f64(v.0),
      Any::BigInt64(v) => ser.serialize_i64(*v),
      Any::String(v) => ser.serialize_str(v),
      Any::Array(vec) => {
        let mut seq = ser.serialize_seq(Some(vec.len()))?;
        for v in vec {
          seq.serialize_element(v)?;
        }
        seq.end()
      }
      Any::Object(map) => {
        let mut m = ser.serialize_map(Some(map.len()))?;
        for (k, v) in map {
          m.serialize_entry(k, v)?;
        }
        m.end()
      }
      Any::Binary(buf) => ser.serialize_bytes(buf),
    }
  }
}

impl<'de> serde::Deserialize<'de> for Any {
  fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
    use serde::de::{MapAccess, SeqAccess, Visitor};

    struct AnyVisitor;

    impl<'de> Visitor<'de> for AnyVisitor {
      type Value = Any;

      fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
      }

      fn visit_bool<E>(self, v: bool) -> Result<Any, E> {
        Ok(if v { Any::True } else { Any::False })
      }
      fn visit_i64<E>(self, v: i64) -> Result<Any, E> {
        Ok(v.into())
      }
      fn visit_u64<E>(self, v: u64) -> Result<Any, E> {
        Ok((v as i64).into())
      }
      fn visit_f64<E>(self, v: f64) -> Result<Any, E> {
        Ok(Any::Float64(OrderedFloat(v)))
      }
      fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Any, E> {
        Ok(Any::String(v.to_string()))
      }
      fn visit_string<E>(self, v: String) -> Result<Any, E> {
        Ok(Any::String(v))
      }
      fn visit_none<E>(self) -> Result<Any, E> {
        Ok(Any::Null)
      }
      fn visit_some<D: serde::Deserializer<'de>>(self, de: D) -> Result<Any, D::Error> {
        serde::Deserialize::deserialize(de)
      }
      fn visit_unit<E>(self) -> Result<Any, E> {
        Ok(Any::Null)
      }
      fn visit_seq<V: SeqAccess<'de>>(self, mut seq: V) -> Result<Any, V::Error> {
        let mut vec = Vec::new();
        while let Some(elem) = seq.next_element()? {
          vec.push(elem);
        }
        Ok(Any::Array(vec))
      }
      fn visit_map<V: MapAccess<'de>>(self, mut map: V) -> Result<Any, V::Error> {
        let mut obj = HashMap::new();
        while let Some((k, v)) = map.next_entry()? {
          obj.insert(k, v);
        }
        Ok(Any::Object(obj))
      }
    }

    de.deserialize_any(AnyVisitor)
  }
}

impl fmt::Display for Any {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Any::Undefined => write!(f, "undefined"),
      Any::Null => write!(f, "null"),
      Any::True => write!(f, "true"),
      Any::False => write!(f, "false"),
      Any::Integer(v) => write!(f, "{v}"),
      Any::Float32(v) => write!(f, "{v}"),
      Any::Float64(v) => write!(f, "{v}"),
      Any::BigInt64(v) => write!(f, "{v}"),
      Any::String(s) => write!(f, "\"{s}\""),
      Any::Object(m) => {
        write!(f, "{{")?;
        for (i, (k, v)) in m.iter().enumerate() {
          if i > 0 {
            write!(f, ", ")?;
          }
          write!(f, "{k}: {v}")?;
        }
        write!(f, "}}")
      }
      Any::Array(a) => {
        write!(f, "[")?;
        for (i, v) in a.iter().enumerate() {
          if i > 0 {
            write!(f, ", ")?;
          }
          write!(f, "{v}")?;
        }
        write!(f, "]")
      }
      Any::Binary(b) => write!(f, "{b:?}"),
    }
  }
}
