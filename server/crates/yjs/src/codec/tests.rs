// SPDX-License-Identifier: AGPL-3.0-or-later
//! Tests for the Yjs v1 codec — invariant-first, covering all deviations.
//!
//! Test naming: `inv_{deviation}_{description}`.
//! Each test is 20–25 lines max, tests one invariant.

use std::collections::HashMap;

use ordered_float::OrderedFloat;

use super::*;

// ── P85-I-01: Varint round-trip ──────────────────────────────────────────────

#[test]
fn inv_varint_u64_roundtrip() {
  for val in [0u64, 1, 127, 128, 255, 300, 16383, 16384, u64::MAX >> 1, u64::MAX] {
    let mut enc = RawEncoder::default();
    enc.write_var_u64(val);
    let buf = enc.into_inner();
    let mut dec = RawDecoder::new(&buf);
    assert_eq!(dec.read_var_u64().unwrap(), val, "failed for {val}");
    assert!(dec.is_empty());
  }
}

#[test]
fn inv_varint_i32_roundtrip() {
  for val in [0i32, 1, -1, 63, -63, 64, -64, 127, -128, i32::MAX, i32::MIN + 1] {
    let mut enc = RawEncoder::default();
    enc.write_var_i32(val);
    let buf = enc.into_inner();
    let mut dec = RawDecoder::new(&buf);
    assert_eq!(dec.read_var_i32().unwrap(), val, "failed for {val}");
    assert!(dec.is_empty());
  }
}

#[test]
fn inv_varint_string_roundtrip() {
  for s in ["", "hello", "Ü🦊", "日本語テスト"] {
    let mut enc = RawEncoder::default();
    enc.write_var_string(s);
    let buf = enc.into_inner();
    let mut dec = RawDecoder::new(&buf);
    assert_eq!(dec.read_var_string().unwrap(), s);
    assert!(dec.is_empty());
  }
}

#[test]
fn inv_varint_buffer_roundtrip() {
  let data = vec![0u8, 1, 2, 255, 128];
  let mut enc = RawEncoder::default();
  enc.write_var_buffer(&data);
  let buf = enc.into_inner();
  let mut dec = RawDecoder::new(&buf);
  assert_eq!(dec.read_var_buffer().unwrap(), data);
}

#[test]
fn inv_varint_float_roundtrip() {
  let mut enc = RawEncoder::default();
  enc.write_f32_be(std::f32::consts::PI);
  enc.write_f64_be(std::f64::consts::E);
  enc.write_i64_be(-42i64);
  let buf = enc.into_inner();
  let mut dec = RawDecoder::new(&buf);
  assert_eq!(dec.read_f32_be().unwrap(), std::f32::consts::PI);
  assert_eq!(dec.read_f64_be().unwrap(), std::f64::consts::E);
  assert_eq!(dec.read_i64_be().unwrap(), -42);
  assert!(dec.is_empty());
}

#[test]
fn inv_decoder_eof_error() {
  let mut dec = RawDecoder::new(&[]);
  let err = dec.read_u8().unwrap_err();
  assert!(matches!(err, CodecError::UnexpectedEof { .. }));
}

// ── P85-I-02: Any round-trip (deviation A-02) ───────────────────────────────

#[test]
fn inv_a02_any_object_sorted_keys() {
  let mut map = HashMap::new();
  map.insert("z".to_string(), any::Any::Integer(1));
  map.insert("a".to_string(), any::Any::Integer(2));
  map.insert("m".to_string(), any::Any::Integer(3));
  let obj = any::Any::Object(map);

  let mut enc = RawEncoder::default();
  obj.write(&mut enc);
  let buf = enc.into_inner();

  let mut dec = RawDecoder::new(&buf);
  let decoded = any::Any::read(&mut dec).unwrap();
  assert_eq!(obj, decoded);

  // Verify determinism: encode twice → same bytes.
  let mut enc2 = RawEncoder::default();
  decoded.write(&mut enc2);
  assert_eq!(buf, enc2.into_inner());
}

#[test]
fn inv_any_all_types_roundtrip() {
  let values = vec![
    any::Any::Undefined,
    any::Any::Null,
    any::Any::Integer(42),
    any::Any::Float32(OrderedFloat(1.5f32)),
    any::Any::Float64(OrderedFloat(std::f64::consts::E)),
    any::Any::BigInt64(i64::MAX),
    any::Any::False,
    any::Any::True,
    any::Any::String("hello 🦊".into()),
    any::Any::Array(vec![any::Any::Integer(1), any::Any::Null]),
    any::Any::Binary(vec![0, 1, 2, 255]),
  ];
  for val in values {
    let mut enc = RawEncoder::default();
    val.write(&mut enc);
    let buf = enc.into_inner();
    let mut dec = RawDecoder::new(&buf);
    assert_eq!(any::Any::read(&mut dec).unwrap(), val);
  }
}

#[test]
fn inv_any_serde_json_roundtrip() {
  let any_val = any::Any::Object({
    let mut m = HashMap::new();
    m.insert("key".into(), any::Any::String("value".into()));
    m
  });
  let json = serde_json::to_string(&any_val).unwrap();
  let back: any::Any = serde_json::from_str(&json).unwrap();
  assert_eq!(any_val, back);
}

// ── P85-I-03: Content round-trip (deviations B-01, B-02, F-01–F-04) ────────

#[test]
fn inv_b01_string_utf16_clock_len() {
  assert_eq!(content::utf16_len("hello"), 5);
  assert_eq!(content::utf16_len("日本"), 2);
  assert_eq!(content::utf16_len("🦊"), 2);
  assert_eq!(content::utf16_len("a🦊b"), 4);
}

#[test]
fn inv_b02_string_split_utf16() {
  let (left, right) = content::split_utf16("a🦊b", 1);
  assert_eq!(left, "a");
  assert_eq!(right, "🦊b");

  let (left2, right2) = content::split_utf16("a🦊b", 3);
  assert_eq!(left2, "a🦊");
  assert_eq!(right2, "b");
}

#[test]
fn inv_f01_content_all_tags_roundtrip() {
  let contents = vec![
    content::Content::Deleted(5),
    content::Content::Json(vec![Some("x".into()), None]),
    content::Content::Binary(vec![1, 2, 3]),
    content::Content::String("hello".into()),
    content::Content::Embed(any::Any::Integer(42)),
    content::Content::Format {
      key: "bold".into(),
      value: any::Any::True,
    },
    content::Content::Type {
      type_ref: 0,
      tag_name: None,
    },
    content::Content::Any(vec![any::Any::Null, any::Any::Integer(1)]),
    content::Content::Doc {
      guid: "abc-123".into(),
      opts: any::Any::Undefined,
    },
  ];
  for c in contents {
    let tag = c.tag();
    let mut enc = RawEncoder::default();
    c.write(&mut enc).unwrap();
    let buf = enc.into_inner();
    let mut dec = RawDecoder::new(&buf);
    let decoded = content::Content::read(&mut dec, tag).unwrap();
    assert_eq!(c, decoded, "tag {tag} roundtrip failed");
  }
}

#[test]
fn inv_f03_content_split_string() {
  let c = content::Content::String("a🦊b".into());
  let (left, right) = c.split(1).unwrap();
  assert_eq!(left, content::Content::String("a".into()));
  assert_eq!(right, content::Content::String("🦊b".into()));
}

#[test]
fn inv_f03_content_split_unsupported() {
  let c = content::Content::Binary(vec![1, 2, 3]);
  assert!(c.split(1).is_err());
}

// ── P85-I-04: Item / Node round-trip (deviations E-01–E-05) ─────────────────

#[test]
fn inv_e01_gc_node_roundtrip() {
  let node = Node::GC {
    id: Id::new(1, 0),
    len: 5,
  };
  let mut enc = RawEncoder::default();
  node.write(&mut enc).unwrap();
  let buf = enc.into_inner();
  let mut dec = RawDecoder::new(&buf);
  let decoded = Node::read(&mut dec, Id::new(1, 0)).unwrap();
  assert_eq!(node, decoded);
  assert!(decoded.deleted());
}

#[test]
fn inv_e01_skip_node_roundtrip() {
  let node = Node::Skip {
    id: Id::new(2, 10),
    len: 3,
  };
  let mut enc = RawEncoder::default();
  node.write(&mut enc).unwrap();
  let buf = enc.into_inner();
  let mut dec = RawDecoder::new(&buf);
  let decoded = Node::read(&mut dec, Id::new(2, 10)).unwrap();
  assert_eq!(node, decoded);
  assert!(decoded.is_skip());
}

#[test]
fn inv_e02_item_with_left_right_no_parent() {
  let item = Item {
    id: Id::new(1, 5),
    origin_left_id: Some(Id::new(1, 4)),
    origin_right_id: Some(Id::new(1, 6)),
    parent: None,
    parent_sub: None,
    content: content::Content::String("x".into()),
    deleted: false,
    countable: true,
  };
  let node = Node::Item(item);
  let mut enc = RawEncoder::default();
  node.write(&mut enc).unwrap();
  let buf = enc.into_inner();
  let mut dec = RawDecoder::new(&buf);
  let decoded = Node::read(&mut dec, Id::new(1, 5)).unwrap();
  assert_eq!(node, decoded);
}

#[test]
fn inv_e03_item_with_named_parent() {
  let item = Item {
    id: Id::new(1, 0),
    origin_left_id: None,
    origin_right_id: None,
    parent: Some(Parent::Named("blocks".into())),
    parent_sub: None,
    content: content::Content::Type {
      type_ref: 0,
      tag_name: None,
    },
    deleted: false,
    countable: true,
  };
  let node = Node::Item(item);
  let mut enc = RawEncoder::default();
  node.write(&mut enc).unwrap();
  let buf = enc.into_inner();
  let mut dec = RawDecoder::new(&buf);
  let decoded = Node::read(&mut dec, Id::new(1, 0)).unwrap();
  assert_eq!(node, decoded);
}

#[test]
fn inv_e04_item_with_parent_sub() {
  let item = Item {
    id: Id::new(1, 0),
    origin_left_id: None,
    origin_right_id: None,
    parent: Some(Parent::Id(Id::new(2, 0))),
    parent_sub: Some("title".into()),
    content: content::Content::String("Hello".into()),
    deleted: false,
    countable: true,
  };
  let node = Node::Item(item);
  let mut enc = RawEncoder::default();
  node.write(&mut enc).unwrap();
  let buf = enc.into_inner();
  let mut dec = RawDecoder::new(&buf);
  let decoded = Node::read(&mut dec, Id::new(1, 0)).unwrap();
  assert_eq!(node, decoded);
}

// ── P85-I-05: DeleteSet round-trip (deviations D-01, D-02) ──────────────────

#[test]
fn inv_d01_delete_set_single_range() {
  let mut ds = DeleteSet::default();
  ds.add(1, 10, 5);
  let mut enc = RawEncoder::default();
  ds.write(&mut enc);
  let buf = enc.into_inner();
  let mut dec = RawDecoder::new(&buf);
  let decoded = DeleteSet::read(&mut dec).unwrap();
  assert_eq!(ds, decoded);
}

#[test]
fn inv_d02_delete_set_descending_clients() {
  let mut ds = DeleteSet::default();
  ds.add(100, 0, 5);
  ds.add(50, 0, 3);
  ds.add(200, 0, 1);
  let mut enc = RawEncoder::default();
  ds.write(&mut enc);
  let buf = enc.into_inner();

  let mut dec = RawDecoder::new(&buf);
  let num_clients = dec.read_var_u64().unwrap();
  assert_eq!(num_clients, 3);
  let first_client = dec.read_var_u64().unwrap();
  assert_eq!(first_client, 200, "first client must be highest (descending)");
}

#[test]
fn inv_d01_delete_set_merge() {
  let mut ds1 = DeleteSet::default();
  ds1.add(1, 0, 5);
  let mut ds2 = DeleteSet::default();
  ds2.add(1, 3, 7);
  ds1.merge(&ds2);

  let mut enc = RawEncoder::default();
  ds1.write(&mut enc);
  let buf = enc.into_inner();
  let mut dec = RawDecoder::new(&buf);
  let decoded = DeleteSet::read(&mut dec).unwrap();
  assert_eq!(decoded.len(), 1);
}

// ── P85-I-06: StateVector round-trip (deviations A-01 part 3, G-02) ─────────

#[test]
fn inv_a01_state_vector_ascending_clients() {
  let sv = StateVector::from([(100, 5u64), (50, 3), (200, 1)]);

  let mut enc = RawEncoder::default();
  sv.write(&mut enc);
  let buf = enc.into_inner();

  let mut dec = RawDecoder::new(&buf);
  let num = dec.read_var_u64().unwrap();
  assert_eq!(num, 3);
  let first = dec.read_var_u64().unwrap();
  assert_eq!(first, 50, "first client must be lowest (ascending)");
}

#[test]
fn inv_g02_state_vector_omits_zero_clock() {
  let sv = StateVector::from([(1, 0u64), (2, 5)]);
  let mut enc = RawEncoder::default();
  sv.write(&mut enc);
  let buf = enc.into_inner();
  let mut dec = RawDecoder::new(&buf);
  let decoded = StateVector::read(&mut dec).unwrap();
  assert_eq!(decoded.get(&1), 0);
  assert_eq!(decoded.get(&2), 5);
}

// ── P85-I-07: Update encode/decode round-trip (deviations A-01, F-04) ───────

#[test]
fn inv_g01_empty_update_sentinel() {
  let update = Update::default();
  let bytes = update.encode_v1().unwrap();
  assert_eq!(bytes, vec![0, 0]);
  let decoded = Update::decode_v1(&bytes).unwrap();
  assert!(decoded.is_empty());
}

#[test]
fn inv_a01_update_descending_clients() {
  let mut update = Update::default();
  let node1 = Node::GC {
    id: Id::new(100, 0),
    len: 1,
  };
  let node2 = Node::GC {
    id: Id::new(50, 0),
    len: 1,
  };
  update.structs.insert(100, vec![node1].into());
  update.structs.insert(50, vec![node2].into());

  let bytes = update.encode_v1().unwrap();
  let mut dec = RawDecoder::new(&bytes);
  let num = dec.read_var_u64().unwrap();
  assert_eq!(num, 2);
  let _num_structs = dec.read_var_u64().unwrap();
  let first_client = dec.read_var_u64().unwrap();
  assert_eq!(first_client, 100, "update clients must be descending");
}

#[test]
fn inv_f04_update_clock_accumulation() {
  let mut update = Update::default();
  let item1 = Node::Item(Item {
    id: Id::new(1, 0),
    origin_left_id: None,
    origin_right_id: None,
    parent: Some(Parent::Named("test".into())),
    parent_sub: None,
    content: content::Content::String("abc".into()),
    deleted: false,
    countable: true,
  });
  let item2 = Node::Item(Item {
    id: Id::new(1, 3),
    origin_left_id: Some(Id::new(1, 2)),
    origin_right_id: None,
    parent: None,
    parent_sub: None,
    content: content::Content::String("d".into()),
    deleted: false,
    countable: true,
  });
  update.structs.insert(1, vec![item1, item2].into());

  let bytes = update.encode_v1().unwrap();
  let decoded = Update::decode_v1(&bytes).unwrap();
  let nodes = &decoded.structs[&1];
  assert_eq!(nodes.len(), 2);
  assert_eq!(nodes[0].id().clock, 0);
  assert_eq!(nodes[1].id().clock, 3);
}

#[test]
fn inv_update_not_fully_consumed() {
  let mut enc = RawEncoder::default();
  enc.write_var_u64(0);
  enc.write_var_u64(0);
  enc.write_u8(0xFF);
  let err = Update::decode_v1(enc.into_inner()).unwrap_err();
  assert!(matches!(err, CodecError::UpdateNotFullyConsumed { remaining: 1 }));
}

// ── P85-I-08: Merge (deviations C-01–C-04) ──────────────────────────────────

#[test]
fn inv_c01_merge_fills_clock_gaps() {
  let mut u1 = Update::default();
  u1.structs.insert(
    1,
    vec![Node::GC {
      id: Id::new(1, 0),
      len: 3,
    }]
    .into(),
  );
  let mut u2 = Update::default();
  u2.structs.insert(
    1,
    vec![Node::GC {
      id: Id::new(1, 5),
      len: 2,
    }]
    .into(),
  );

  let merged = merge::merge(vec![u1, u2]);
  let nodes = &merged.structs[&1];
  assert_eq!(nodes.len(), 3, "should be: GC + Skip + GC");
  assert!(nodes[1].is_skip(), "middle node must be Skip");
  assert_eq!(nodes[1].id().clock, 3);
  assert_eq!(nodes[1].len(), 2);
}

#[test]
fn inv_c02_merge_dedup_identical_nodes() {
  let gc = Node::GC {
    id: Id::new(1, 0),
    len: 5,
  };
  let mut u1 = Update::default();
  u1.structs.insert(1, vec![gc.clone()].into());
  let mut u2 = Update::default();
  u2.structs.insert(1, vec![gc].into());

  let merged = merge::merge(vec![u1, u2]);
  assert_eq!(merged.structs[&1].len(), 1, "duplicates must be removed");
}

#[test]
fn inv_c03_merge_sorts_by_clock() {
  let mut u = Update::default();
  u.structs.insert(
    1,
    vec![
      Node::GC {
        id: Id::new(1, 5),
        len: 1,
      },
      Node::GC {
        id: Id::new(1, 0),
        len: 3,
      },
    ]
    .into(),
  );

  let merged = merge::merge(vec![u]);
  let nodes = &merged.structs[&1];
  assert_eq!(nodes[0].id().clock, 0, "first node must have lowest clock");
}

#[test]
fn inv_c04_merge_strips_input_skips() {
  let mut u = Update::default();
  u.structs.insert(
    1,
    vec![
      Node::GC {
        id: Id::new(1, 0),
        len: 2,
      },
      Node::Skip {
        id: Id::new(1, 2),
        len: 3,
      },
      Node::GC {
        id: Id::new(1, 5),
        len: 1,
      },
    ]
    .into(),
  );

  let merged = merge::merge(vec![u]);
  let nodes = &merged.structs[&1];
  assert_eq!(nodes.len(), 3);
  assert!(nodes[1].is_skip());
}

#[test]
fn inv_merge_delete_sets_union() {
  let mut u1 = Update::default();
  u1.set_delete_set({
    let mut ds = DeleteSet::default();
    ds.add(1, 0, 5);
    ds
  });
  let mut u2 = Update::default();
  u2.set_delete_set({
    let mut ds = DeleteSet::default();
    ds.add(2, 0, 3);
    ds
  });

  let merged = merge::merge(vec![u1, u2]);
  let ds = merged.clone_delete_set();
  assert_eq!(ds.len(), 2);
}

// ── End-to-end: encode → decode → re-encode determinism ─────────────────────

#[test]
fn inv_encode_decode_reencode_deterministic() {
  let mut update = Update::default();
  update.structs.insert(
    42,
    vec![Node::Item(Item {
      id: Id::new(42, 0),
      origin_left_id: None,
      origin_right_id: None,
      parent: Some(Parent::Named("blocks".into())),
      parent_sub: None,
      content: content::Content::String("hello 🦊".into()),
      deleted: false,
      countable: true,
    })]
    .into(),
  );
  let mut ds = DeleteSet::default();
  ds.add(42, 100, 5);
  update.set_delete_set(ds);

  let bytes1 = update.encode_v1().unwrap();
  let decoded = Update::decode_v1(&bytes1).unwrap();
  let bytes2 = decoded.encode_v1().unwrap();
  assert_eq!(bytes1, bytes2, "re-encode must produce identical bytes");
}

#[test]
fn inv_merge_updates_v1_api() {
  let mut u1 = Update::default();
  u1.structs.insert(
    1,
    vec![Node::GC {
      id: Id::new(1, 0),
      len: 1,
    }]
    .into(),
  );
  let bytes1 = u1.encode_v1().unwrap();

  let mut u2 = Update::default();
  u2.structs.insert(
    2,
    vec![Node::GC {
      id: Id::new(2, 0),
      len: 1,
    }]
    .into(),
  );
  let bytes2 = u2.encode_v1().unwrap();

  let merged = merge_updates_v1(vec![bytes1, bytes2]).unwrap();
  assert_eq!(merged.structs.len(), 2);
}
