use yrs::{Array, Doc, GetString, Map, Transact, Update, updates::decoder::Decode};

#[test]
fn debug_block_content() {
  let data = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/test_snapshot.bin")).unwrap();

  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");

  {
    let mut tx = doc.transact_mut();
    let u = Update::decode_v1(&data).unwrap();
    tx.apply_update(u).expect("apply yjs update");
  }

  let tx = doc.transact();
  println!("blocks length: {}", blocks.len(&tx));

  // Iterate blocks
  blocks.iter(&tx).for_each(|(key, value)| {
    println!("\n--- Block key: {:?} ---", key);
    match &value {
      yrs::Out::YMap(inner_map) => {
        println!("  (is YMap with {} entries)", inner_map.len(&tx));
        inner_map.iter(&tx).for_each(|(k, v)| match &v {
          yrs::Out::Any(any) => println!("  prop {:?} = {:?}", k, any),
          yrs::Out::YText(t) => println!("  text {:?} = {:?}", k, t.get_string(&tx)),
          yrs::Out::YMap(_) => println!("  map {:?} = (nested map)", k),
          yrs::Out::YArray(a) => println!("  array {:?} len={}", k, a.len(&tx)),
          _ => println!("  {:?} = (other type)", k),
        });
      }
      _ => println!("  (not a YMap: {:?})", value),
    }
  });
}
