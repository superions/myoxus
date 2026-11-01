// SPDX-License-Identifier: AGPL-3.0-or-later

use serde::Deserialize;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, Options, ReadTxn, StateVector, Text, Transact, Update};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
  before: String,
  after: String,
  full_v1: Vec<u8>,
  full_v2: Vec<u8>,
  incremental_v1: Vec<u8>,
  incremental_v2: Vec<u8>,
}

#[test]
fn string_storage_preserves_existing_yjs_v1_v2_and_utf16_edits() {
  // Immutable bytes from the unchanged JS peer precede the Rust storage change.
  // Non-BMP characters and a removed combining mark force real string splits.
  let fixture: Fixture = serde_json::from_str(include_str!("fixtures/string-storage-wire.json")).unwrap();
  for v2 in [false, true] {
    let mut options = Options::with_client_id(yrs::ClientID::new(811));
    options.offset_kind = yrs::OffsetKind::Utf16;
    options.skip_gc = true;
    let doc = Doc::with_options(options);
    let text = doc.get_or_insert_text("text");
    let (full, incremental) = if v2 {
      (&fixture.full_v2, &fixture.incremental_v2)
    } else {
      (&fixture.full_v1, &fixture.incremental_v1)
    };
    let decode = |bytes: &[u8]| {
      if v2 {
        Update::decode_v2(bytes)
      } else {
        Update::decode_v1(bytes)
      }
      .unwrap()
    };
    doc.transact_mut().apply_update(decode(full)).unwrap();
    assert_eq!(text.get_string(&doc.transact()), fixture.before);
    doc.transact_mut().apply_update(decode(incremental)).unwrap();
    assert_eq!(text.get_string(&doc.transact()), fixture.after);

    let peer = Doc::with_options(Options {
      skip_gc: true,
      ..Options::with_client_id(yrs::ClientID::new(812))
    });
    peer.transact_mut().apply_update(decode(full)).unwrap();
    peer.transact_mut().apply_update(decode(incremental)).unwrap();
    let peer_text = peer.get_or_insert_text("text");
    let previous = peer.transact().state_vector();
    let mut txn = doc.transact_mut();
    text.remove_range(&mut txn, 1, 2);
    text.insert(&mut txn, 1, "🌱");
    text.insert(&mut txn, 3, "é");
    let delta = txn.encode_state_as_update_v1(&previous);
    drop(txn);
    let expected = fixture.after.replacen("🧭", "🌱é", 1);
    assert_eq!(text.get_string(&doc.transact()), expected);
    peer
      .transact_mut()
      .apply_update(Update::decode_v1(&delta).unwrap())
      .unwrap();
    assert_eq!(peer_text.get_string(&peer.transact()), expected);
    assert_eq!(doc.transact().state_vector(), peer.transact().state_vector());

    let restored = Doc::new();
    let snapshot = doc.transact().encode_state_as_update_v1(&StateVector::default());
    restored
      .transact_mut()
      .apply_update(Update::decode_v1(&snapshot).unwrap())
      .unwrap();
    assert_eq!(
      restored.get_or_insert_text("text").get_string(&restored.transact()),
      expected
    );
  }
}
