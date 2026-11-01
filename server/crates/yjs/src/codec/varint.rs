// SPDX-License-Identifier: AGPL-3.0-or-later
//! Variable-length integer encoding and the `RawDecoder` / `RawEncoder` types.
//!
//! Clean reimplementation — no nom, no byteorder Cursor wrappers.
//! Reads directly from `&[u8]` with a tracked position.

use byteorder::{BigEndian, ByteOrder};

use super::error::{CodecError, CodecResult};

// ────────────────────────────────────────────────────────────────────────────
// RawDecoder — reads Yjs v1 binary from a byte slice
// ────────────────────────────────────────────────────────────────────────────

/// Binary reader for Yjs v1 format. Tracks position in a borrowed byte slice.
pub struct RawDecoder<'a> {
  buf: &'a [u8],
  pos: usize,
}

impl<'a> RawDecoder<'a> {
  /// Create a new decoder over `buf`.
  #[inline]
  pub fn new(buf: &'a [u8]) -> Self {
    Self { buf, pos: 0 }
  }

  /// True when all bytes have been consumed.
  #[inline]
  pub fn is_empty(&self) -> bool {
    self.pos >= self.buf.len()
  }

  /// Number of remaining bytes.
  #[inline]
  pub fn remaining(&self) -> usize {
    self.buf.len().saturating_sub(self.pos)
  }

  /// Peek at the remaining unconsumed slice.
  #[inline]
  pub fn rest(&self) -> &[u8] {
    &self.buf[self.pos..]
  }

  // ── Primitive readers ──────────────────────────────────────────────────

  /// Read a single byte.
  #[inline]
  pub fn read_u8(&mut self) -> CodecResult<u8> {
    if self.pos < self.buf.len() {
      let b = self.buf[self.pos];
      self.pos += 1;
      Ok(b)
    } else {
      Err(CodecError::UnexpectedEof {
        offset: self.pos,
        need: 1,
      })
    }
  }

  /// Read N bytes as a slice, advancing the cursor.
  fn read_bytes(&mut self, n: usize) -> CodecResult<&'a [u8]> {
    if self.pos + n <= self.buf.len() {
      let slice = &self.buf[self.pos..self.pos + n];
      self.pos += n;
      Ok(slice)
    } else {
      Err(CodecError::UnexpectedEof {
        offset: self.pos,
        need: n,
      })
    }
  }

  /// Read an unsigned variable-length integer (LEB128).
  pub fn read_var_u64(&mut self) -> CodecResult<u64> {
    let mut num: u64 = 0;
    let mut shift: u32 = 0;
    loop {
      let byte = self.read_u8()?;
      num |= ((byte & 0x7F) as u64).wrapping_shl(shift);
      if byte & 0x80 == 0 {
        return Ok(num);
      }
      shift += 7;
    }
  }

  /// Read a signed variable-length integer.
  ///
  /// Wire format: first byte stores 6 data bits + sign bit (bit 6) +
  /// continuation bit (bit 7). Subsequent bytes store 7 data bits each.
  pub fn read_var_i32(&mut self) -> CodecResult<i32> {
    let first = self.read_u8()?;
    let sign = (first >> 6) & 1;
    let mut num = (first & 0x3F) as i64;
    let mut shift: u32 = 6;

    if first & 0x80 != 0 {
      loop {
        let byte = self.read_u8()?;
        num |= ((byte & 0x7F) as i64).wrapping_shl(shift);
        shift += 7;
        if byte & 0x80 == 0 {
          break;
        }
      }
    }

    if sign == 1 {
      num = -num;
    }
    Ok(num as i32)
  }

  /// Read a variable-length string (varint length prefix + UTF-8 bytes).
  pub fn read_var_string(&mut self) -> CodecResult<String> {
    let len = self.read_var_u64()? as usize;
    let bytes = self.read_bytes(len)?;
    String::from_utf8(bytes.to_vec()).map_err(|_| CodecError::InvalidUtf8(self.pos - len))
  }

  /// Read a variable-length buffer (varint length prefix + raw bytes).
  pub fn read_var_buffer(&mut self) -> CodecResult<Vec<u8>> {
    let len = self.read_var_u64()? as usize;
    let bytes = self.read_bytes(len)?;
    Ok(bytes.to_vec())
  }

  /// Read a big-endian f32 (4 bytes).
  pub fn read_f32_be(&mut self) -> CodecResult<f32> {
    let bytes = self.read_bytes(4)?;
    Ok(BigEndian::read_f32(bytes))
  }

  /// Read a big-endian f64 (8 bytes).
  pub fn read_f64_be(&mut self) -> CodecResult<f64> {
    let bytes = self.read_bytes(8)?;
    Ok(BigEndian::read_f64(bytes))
  }

  /// Read a big-endian i64 (8 bytes).
  pub fn read_i64_be(&mut self) -> CodecResult<i64> {
    let bytes = self.read_bytes(8)?;
    Ok(BigEndian::read_i64(bytes))
  }

  /// Read a Yjs item ID: `[varint: client][varint: clock]`.
  #[inline]
  pub fn read_item_id(&mut self) -> CodecResult<super::item::Id> {
    let client = self.read_var_u64()?;
    let clock = self.read_var_u64()?;
    Ok(super::item::Id { client, clock })
  }
}

// ────────────────────────────────────────────────────────────────────────────
// RawEncoder — writes Yjs v1 binary into a Vec<u8>
// ────────────────────────────────────────────────────────────────────────────

/// Binary writer for Yjs v1 format. Appends to an internal `Vec<u8>`.
#[derive(Default)]
pub struct RawEncoder {
  buf: Vec<u8>,
}

impl RawEncoder {
  /// Consume the encoder and return the written bytes.
  #[inline]
  pub fn into_inner(self) -> Vec<u8> {
    self.buf
  }

  /// Current length of the written buffer.
  #[inline]
  pub fn len(&self) -> usize {
    self.buf.len()
  }

  /// Whether the encoder has not written any bytes yet.
  #[inline]
  pub fn is_empty(&self) -> bool {
    self.buf.is_empty()
  }

  // ── Primitive writers ──────────────────────────────────────────────────

  /// Write a single byte.
  #[inline]
  pub fn write_u8(&mut self, byte: u8) {
    self.buf.push(byte);
  }

  /// Write an unsigned variable-length integer (LEB128).
  pub fn write_var_u64(&mut self, mut num: u64) {
    while num >= 0x80 {
      self.buf.push((num as u8 & 0x7F) | 0x80);
      num >>= 7;
    }
    self.buf.push(num as u8 & 0x7F);
  }

  /// Write a signed variable-length integer.
  ///
  /// Wire format: first byte stores 6 data bits + sign bit (bit 6) +
  /// continuation bit (bit 7). Subsequent bytes store 7 data bits each.
  pub fn write_var_i32(&mut self, num: i32) {
    let mut val = num as i64;
    let is_negative = val < 0;
    if is_negative {
      val = -val;
    }

    let mut first = val as u8 & 0x3F;
    if is_negative {
      first |= 0x40;
    }
    val >>= 6;
    if val > 0 {
      first |= 0x80;
    }
    self.buf.push(first);

    while val > 0 {
      let mut byte = val as u8 & 0x7F;
      val >>= 7;
      if val > 0 {
        byte |= 0x80;
      }
      self.buf.push(byte);
    }
  }

  /// Write a variable-length string (varint length prefix + UTF-8).
  pub fn write_var_string(&mut self, s: &str) {
    self.write_var_u64(s.len() as u64);
    self.buf.extend_from_slice(s.as_bytes());
  }

  /// Write a variable-length buffer (varint length prefix + raw bytes).
  pub fn write_var_buffer(&mut self, data: &[u8]) {
    self.write_var_u64(data.len() as u64);
    self.buf.extend_from_slice(data);
  }

  /// Write a big-endian f32 (4 bytes).
  pub fn write_f32_be(&mut self, val: f32) {
    let mut bytes = [0u8; 4];
    BigEndian::write_f32(&mut bytes, val);
    self.buf.extend_from_slice(&bytes);
  }

  /// Write a big-endian f64 (8 bytes).
  pub fn write_f64_be(&mut self, val: f64) {
    let mut bytes = [0u8; 8];
    BigEndian::write_f64(&mut bytes, val);
    self.buf.extend_from_slice(&bytes);
  }

  /// Write a big-endian i64 (8 bytes).
  pub fn write_i64_be(&mut self, val: i64) {
    let mut bytes = [0u8; 8];
    BigEndian::write_i64(&mut bytes, val);
    self.buf.extend_from_slice(&bytes);
  }

  /// Write a Yjs item ID: `[varint: client][varint: clock]`.
  #[inline]
  pub fn write_item_id(&mut self, id: &super::item::Id) {
    self.write_var_u64(id.client);
    self.write_var_u64(id.clock);
  }
}
