// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::Deserialize;
use yrs::encoding::read::Cursor;
use yrs::encoding::serde::from_any;
use yrs::updates::decoder::Decode;
use yrs::{Any, Doc, Map, Number, ReadTxn, StateVector, Transact, Update};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
  full_v1: Vec<u8>,
  full_v2: Vec<u8>,
}

fn assert_numbers(doc: &Doc) {
  let txn = doc.transact();
  let map = txn.get_map("numbers").unwrap();
  for (key, expected) in [
    ("small", 42.0),
    ("fractional", 1.5),
    ("wide", 2147483648.0),
    ("safe", 9007199254740991.0),
    ("negativeZero", 0.0),
  ] {
    let Some(yrs::Out::Any(Any::Number(value))) = map.get(&txn, key) else {
      panic!("{key} must remain a JavaScript Number")
    };
    assert_eq!(value.as_f64(), Some(expected));
  }
  for (key, expected) in [
    ("bigintSmall", 42),
    ("bigintMax", i64::MAX),
    ("bigintMin", i64::MIN),
    ("bigintUnsafe", 9007199254740993),
  ] {
    assert_eq!(map.get(&txn, key), Some(yrs::Out::Any(Any::BigInt(expected))));
    let value = Any::BigInt(expected);
    assert_eq!(from_any::<i64>(&value).unwrap(), expected);
    assert_eq!(serde_json::to_value(&value).unwrap(), serde_json::json!(expected));
    let mut encoded = Vec::new();
    value.encode(&mut encoded);
    assert_eq!(encoded[0], 122, "the JS peer must still decode a BigInt");
    assert_eq!(Any::decode(&mut Cursor::new(&encoded)).unwrap(), value);
  }
}

#[test]
fn persisted_yjs_numbers_and_bigints_survive_v1_v2_materialization() {
  // These immutable bytes come from the unchanged Yjs peer, not the new Rust encoder.
  let fixture: Fixture = serde_json::from_str(include_str!("fixtures/numeric-wire.json")).unwrap();
  for (v2, bytes) in [(false, fixture.full_v1), (true, fixture.full_v2)] {
    let doc = Doc::new();
    let update = if v2 {
      Update::decode_v2(&bytes)
    } else {
      Update::decode_v1(&bytes)
    }
    .unwrap();
    doc.transact_mut().apply_update(update).unwrap();
    assert_numbers(&doc);
    let restored = Doc::new();
    let bytes = doc.transact().encode_state_as_update_v1(&StateVector::default());
    restored
      .transact_mut()
      .apply_update(Update::decode_v1(&bytes).unwrap())
      .unwrap();
    assert_numbers(&restored);
  }
}

#[test]
fn numeric_boundaries_do_not_round_i64_max_into_a_float() {
  assert_eq!(Number::Int(i64::MAX).as_f64(), None);
  assert_eq!(Number::Float(-(i64::MIN as f64)).as_i64(), None);
  assert_eq!(Number::Float(i64::MIN as f64).as_i64(), Some(i64::MIN));
  assert_eq!(Any::from(i64::MAX), Any::BigInt(i64::MAX));
  assert_eq!(Any::try_from(i64::MAX as u64).unwrap(), Any::BigInt(i64::MAX));
  assert!(Any::try_from(u64::MAX).is_err());
  let mut bytes = Vec::new();
  Any::Number(Number::Int(i64::MAX)).encode(&mut bytes);
  assert_eq!(bytes[0], 122);
  assert_eq!(Any::decode(&mut Cursor::new(&bytes)).unwrap(), Any::BigInt(i64::MAX));
}
