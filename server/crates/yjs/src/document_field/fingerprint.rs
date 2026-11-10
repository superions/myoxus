// SPDX-License-Identifier: AGPL-3.0-or-later
//! Read-only operation fingerprints; never the encoder used by synchronization.

use yrs::updates::{
  decoder::Decode,
  encoder::{Encode, Encoder, EncoderV1},
};
use yrs::{Any, ID, Update, block::ClientID, encoding::write::Write};

/// Comparison input for field-containing native captures. Never persist,
/// synchronize or apply it: all productive content retains its original codec.
/// Format/embed objects use JSON on the wire; Yrs re-encoding can reorder their
/// keys. Canonicalize only that JSON, delegating every native value, identity,
/// clock and delete to the existing encoder, including full-width numbers.
/// None retains the existing field-free fingerprint path.
pub fn fingerprint_input(snapshot: &[u8]) -> Result<Option<Vec<u8>>, &'static str> {
  // V1 writes format keys as literal UTF-8. This is only a fast negative;
  // the encoder below still establishes whether a real field key was visited.
  if !snapshot
    .windows(super::FIELD_ATTRIBUTE.len())
    .any(|bytes| bytes == super::FIELD_ATTRIBUTE.as_bytes())
  {
    return Ok(None);
  }
  let update = Update::decode_v1(snapshot).map_err(|_| "invalid native fingerprint input")?;
  let mut encoder = FingerprintEncoder {
    native: EncoderV1::new(),
    fields: false,
    invalid_json: false,
  };
  update.encode(&mut encoder);
  if !encoder.fields {
    return Ok(None);
  }
  if encoder.invalid_json {
    return Err("invalid native fingerprint JSON");
  }
  Ok(Some(encoder.to_vec()))
}

struct FingerprintEncoder {
  native: EncoderV1,
  fields: bool,
  invalid_json: bool,
}

impl Write for FingerprintEncoder {
  fn write_all(&mut self, bytes: &[u8]) {
    self.native.write_all(bytes);
  }
}

impl Encoder for FingerprintEncoder {
  fn to_vec(self) -> Vec<u8> {
    self.native.to_vec()
  }
  fn reset_ds_cur_val(&mut self) {
    self.native.reset_ds_cur_val();
  }
  fn write_ds_clock(&mut self, clock: u32) {
    self.native.write_ds_clock(clock);
  }
  fn write_ds_len(&mut self, len: u32) {
    self.native.write_ds_len(len);
  }
  fn write_left_id(&mut self, id: &ID) {
    self.native.write_left_id(id);
  }
  fn write_right_id(&mut self, id: &ID) {
    self.native.write_right_id(id);
  }
  fn write_client(&mut self, client: ClientID) {
    self.native.write_client(client);
  }
  fn write_info(&mut self, info: u8) {
    self.native.write_info(info);
  }
  fn write_parent_info(&mut self, is_y_key: bool) {
    self.native.write_parent_info(is_y_key);
  }
  fn write_type_ref(&mut self, info: u8) {
    self.native.write_type_ref(info);
  }
  fn write_len(&mut self, len: u32) {
    self.native.write_len(len);
  }
  fn write_any(&mut self, any: &Any) {
    self.native.write_any(any);
  }
  fn write_key(&mut self, key: &str) {
    self.fields |= key == super::FIELD_ATTRIBUTE;
    self.native.write_key(key);
  }
  fn write_json(&mut self, any: &Any) {
    let mut source = String::new();
    any.to_json(&mut source);
    match serde_json::from_str::<serde_json::Value>(&source) {
      Ok(mut value) => {
        value.sort_all_objects();
        self.native.write_string(&value.to_string());
      }
      Err(_) => {
        // Encoder is infallible; reject its complete output at the boundary.
        self.invalid_json = true;
        self.native.write_json(any);
      }
    }
  }
}
