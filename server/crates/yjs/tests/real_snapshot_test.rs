#[test]
fn extract_from_real_db_snapshot() {
  let data =
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/test_snapshot.bin")).expect("read test snapshot");
  println!("Payload: {} bytes", data.len());

  let result = yjs::extract_text_from_yjs(&data);
  match &result {
    Ok(r) => {
      println!("Title: {:?}", r.title);
      println!("Markdown len: {}", r.markdown.len());
      println!("Markdown preview: {:?}", &r.markdown[..r.markdown.len().min(500)]);
    }
    Err(e) => {
      println!("ERROR: {}", e);
    }
  }
  assert!(result.is_ok(), "extraction must not fail on a real snapshot");
  let r = result.unwrap();
  assert!(
    !r.markdown.trim().is_empty(),
    "markdown must not be empty for a real doc"
  );
}
