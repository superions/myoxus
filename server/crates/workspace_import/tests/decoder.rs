// SPDX-License-Identifier: AGPL-3.0-or-later

use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use myoxus_workspace_import::{
  DecodedDocumentContent, WorkspaceDecoder, WorkspaceImportDiagnosticCode, WorkspaceImportFormat,
  WorkspaceImportLimits, detect_workspace_format, extract_database_blocks,
};
use rusqlite::{Connection, OpenFlags, params};
use zip::write::SimpleFileOptions;

fn fixture(name: &str) -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

fn write_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
  let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
  let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
  for (name, bytes) in entries {
    writer.start_file(*name, options).expect("start ZIP entry");
    writer.write_all(bytes).expect("write ZIP entry");
  }
  writer.finish().expect("finish ZIP").into_inner()
}

fn obsidian_fixture_zip() -> Vec<u8> {
  let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../build/fixtures/markdown/obsidian-vault");
  let names = [
    "Projects/Shared.md",
    "People/Shared.md",
    "Unicode/Grüße 世界.md",
    "Empty note.md",
    "media/pixel.svg",
    "Unsupported.canvas",
    ".obsidian/app.json",
    ".trash/Deleted.md",
  ];
  let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
  let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
  writer.add_directory("Empty folder/", options).expect("empty folder");
  writer
    .add_directory("Projects/Empty child/", options)
    .expect("nested empty folder");
  for name in names {
    writer.start_file(name, options).expect("fixture ZIP entry");
    writer
      .write_all(&fs::read(root.join(name)).expect("fixture content"))
      .expect("fixture bytes");
  }
  writer.finish().expect("finish fixture ZIP").into_inner()
}

fn decode_obsidian_bytes(
  bytes: &[u8],
) -> Result<myoxus_workspace_import::DecodedWorkspace, WorkspaceImportDiagnosticCode> {
  let temp = tempfile::NamedTempFile::new().expect("temporary archive");
  fs::write(temp.path(), bytes).expect("write archive");
  WorkspaceDecoder::new(WorkspaceImportLimits::default())
    .decode_path_as(temp.path(), Some(WorkspaceImportFormat::ObsidianZip))
    .map_err(|diagnostic| diagnostic.code)
}

fn decode_bytes(bytes: &[u8]) -> Result<myoxus_workspace_import::DecodedWorkspace, WorkspaceImportDiagnosticCode> {
  let temp = tempfile::NamedTempFile::new().expect("temporary archive");
  fs::write(temp.path(), bytes).expect("write archive");
  WorkspaceDecoder::new(WorkspaceImportLimits::default())
    .decode_path(temp.path())
    .map_err(|diagnostic| diagnostic.code)
}

#[test]
fn canonical_sqlite_and_snapshot_fixtures_decode_to_the_same_portable_inventory() {
  let decoder = WorkspaceDecoder::new(WorkspaceImportLimits::default());
  let sqlite = decoder
    .decode_path(fixture("workspace-sqlite-v1-valid.myoxus"))
    .expect("canonical SQLite fixture");
  let snapshot = decoder
    .decode_path(fixture("workspace-snapshot-valid.zip"))
    .expect("canonical snapshot fixture");

  assert_eq!(sqlite.format, WorkspaceImportFormat::SqliteV1);
  assert_eq!(snapshot.format, WorkspaceImportFormat::SnapshotZip);
  assert_eq!(sqlite.title, "Imported workspace");
  assert_eq!(snapshot.title, sqlite.title);
  assert_eq!(snapshot.workspace_tags, sqlite.workspace_tags);
  assert_eq!(sqlite.workspace_tags.len(), 2);
  assert_eq!(
    sqlite.workspace_tags[1].description.as_deref(),
    Some("Archived portable label")
  );
  assert!(sqlite.workspace_tags[1].archived);
  assert_eq!(sqlite.documents[0].tags, ["legacy-archived", "legacy-active"]);
  assert_eq!(snapshot.documents[0].tags, sqlite.documents[0].tags);
  assert!(sqlite.documents[1].tags.is_empty());
  assert_eq!(sqlite.documents.len(), 2);
  assert_eq!(snapshot.documents.len(), sqlite.documents.len());
  assert_eq!(sqlite.assets.len(), 1);
  assert_eq!(snapshot.assets.len(), sqlite.assets.len());

  let sqlite_databases = sqlite
    .documents
    .iter()
    .map(|document| extract_database_blocks(document).expect("SQLite Database extraction"))
    .collect::<Vec<_>>();
  let snapshot_databases = snapshot
    .documents
    .iter()
    .map(|document| extract_database_blocks(document).expect("snapshot Database extraction"))
    .collect::<Vec<_>>();
  assert_eq!(sqlite_databases.iter().map(Vec::len).sum::<usize>(), 3);
  assert_eq!(snapshot_databases.iter().map(Vec::len).sum::<usize>(), 3);
  assert!(
    sqlite_databases
      .iter()
      .flatten()
      .all(|database| !database.is_reference_only())
  );
}

#[test]
fn format_detection_is_content_based_under_unrelated_extensions() {
  let temp = tempfile::tempdir().expect("temporary fixture copy");
  for extension in ["affine", "affine.zip", "bs.zip", "zip", "db", "myoxus"] {
    let renamed_sqlite = temp.path().join(format!("sqlite.{extension}"));
    let renamed_snapshot = temp.path().join(format!("snapshot.{extension}"));
    fs::copy(fixture("workspace-sqlite-v1-valid.myoxus"), &renamed_sqlite).expect("copy SQLite");
    fs::copy(fixture("workspace-snapshot-valid.zip"), &renamed_snapshot).expect("copy snapshot");

    assert_eq!(
      detect_workspace_format(&renamed_sqlite).expect("renamed SQLite"),
      WorkspaceImportFormat::SqliteV1
    );
    assert_eq!(
      detect_workspace_format(&renamed_snapshot).expect("renamed snapshot"),
      WorkspaceImportFormat::SnapshotZip
    );
  }
}

#[test]
fn zip_detection_requires_a_validated_snapshot_layout() {
  let generic = write_zip(&[("notes.txt", b"not a workspace")]);
  assert_eq!(
    decode_bytes(&generic).expect_err("generic ZIP must not become a snapshot"),
    WorkspaceImportDiagnosticCode::MixWorkspaceImportFormatUnsupported
  );

  let incomplete = write_zip(&[("info.json", br#"{"name":"Incomplete"}"#)]);
  assert_eq!(
    decode_bytes(&incomplete).expect_err("snapshot hints without documents must fail"),
    WorkspaceImportDiagnosticCode::MixWorkspaceImportSnapshotInvalid
  );

  let unsupported_entry = write_zip(&[
    ("doc.snapshot.json", br#"{"meta":{"id":"doc"},"blocks":[]}"#),
    ("unclassified.bin", b"must not be silently dropped"),
  ]);
  assert_eq!(
    decode_bytes(&unsupported_entry).expect_err("unknown snapshot entries must not be dropped"),
    WorkspaceImportDiagnosticCode::MixWorkspaceImportSnapshotInvalid
  );
}

#[test]
fn explicit_obsidian_preview_preserves_the_archive_root_and_bounded_inventory() {
  let bytes = obsidian_fixture_zip();
  assert_eq!(
    decode_bytes(&bytes).expect_err("automatic detection must remain unchanged"),
    WorkspaceImportDiagnosticCode::MixWorkspaceImportFormatUnsupported
  );

  let decoded = decode_obsidian_bytes(&bytes).expect("explicit Obsidian ZIP");
  assert_eq!(decoded.format, WorkspaceImportFormat::ObsidianZip);
  assert_eq!(decoded.documents.len(), 4);
  assert_eq!(decoded.assets.len(), 2);
  assert_eq!(decoded.omitted_counts.excluded_entries, 2);
  assert_eq!(decoded.directories, ["Empty folder", "Projects/Empty child"]);
  assert!(
    decoded
      .documents
      .iter()
      .any(|note| note.source_id == "Projects/Shared.md")
  );
  assert!(
    decoded
      .documents
      .iter()
      .any(|note| note.source_id == "People/Shared.md")
  );
  assert!(
    decoded
      .documents
      .iter()
      .any(|note| note.source_id == "Unicode/Grüße 世界.md")
  );
  assert!(decoded.documents.iter().any(|note| {
    note.source_id == "Empty note.md"
      && matches!(&note.content, DecodedDocumentContent::MarkdownUtf8(bytes) if bytes.is_empty())
  }));
}

#[test]
fn obsidian_selection_validates_zip_content_and_note_encoding() {
  assert_eq!(
    decode_obsidian_bytes(b"not a zip").expect_err("selection cannot bypass ZIP validation"),
    WorkspaceImportDiagnosticCode::MixWorkspaceImportFormatUnsupported
  );
  let invalid_utf8 = write_zip(&[("note.md", &[0xff, 0xfe])]);
  assert_eq!(
    decode_obsidian_bytes(&invalid_utf8).expect_err("note text must be UTF-8"),
    WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid
  );
  let no_notes = write_zip(&[("asset.bin", b"bytes")]);
  assert_eq!(
    decode_obsidian_bytes(&no_notes).expect_err("vault must contain notes"),
    WorkspaceImportDiagnosticCode::MixWorkspaceImportFormatUnsupported
  );
}

#[test]
fn snapshot_decoder_preserves_portable_trash_state() {
  let bytes = write_zip(&[(
    "trashed.snapshot.json",
    br#"{"meta":{"id":"trashed","title":"Archived note","trash":true},"blocks":[]}"#,
  )]);
  let decoded = decode_bytes(&bytes).expect("trashed snapshot document remains portable");
  assert_eq!(decoded.documents.len(), 1);
  assert!(decoded.documents[0].is_trashed);
}

#[test]
fn canonical_recursive_snapshot_is_flattened_without_losing_text_or_versions() {
  let bytes = write_zip(&[(
    "recursive.snapshot.json",
    br#"{"meta":{"id":"recursive","title":"Recursive","createDate":1710000000123},"blocks":{"type":"block","id":"page","flavour":"affine:page","version":2,"props":{"title":{"$blocksuite:internal:text$":true,"delta":[{"insert":"Recursive"}]}},"children":[{"type":"block","id":"note","flavour":"affine:note","props":{},"children":[{"type":"block","id":"paragraph","flavour":"affine:paragraph","version":1,"props":{"text":{"$blocksuite:internal:text$":true,"delta":[{"insert":"Formatted","attributes":{"bold":true}}]}},"children":[]}]}]}}"#,
  )]);
  let decoded = decode_bytes(&bytes).expect("canonical recursive snapshot");
  assert_eq!(decoded.documents[0].created_at_ms, Some(1_710_000_000_123));
  let DecodedDocumentContent::SnapshotBlocks(blocks) = &decoded.documents[0].content else {
    panic!("snapshot ZIP must retain normalized snapshot blocks");
  };
  assert_eq!(blocks.len(), 3);
  let page = blocks.iter().find(|block| block.id == "page").expect("page block");
  assert_eq!(page.version, Some(2));
  assert_eq!(page.children, ["note"]);
  let paragraph = blocks
    .iter()
    .find(|block| block.id == "paragraph")
    .expect("paragraph block");
  assert_eq!(
    yjs::snapshot_rich_text_plain_text(paragraph.props.get("text").expect("paragraph text"))
      .expect("canonical text delta"),
    "Formatted"
  );
  let update = yjs::snapshot_blocks_to_yjs(blocks).expect("normalized recursive blocks materialize as Yjs");
  let exported = yjs::document_to_snapshot(&update, "recursive", "Recursive").expect("native source capture");
  let exported_bytes = serde_json::to_vec(&exported).expect("existing Snapshot JSON");
  let roundtrip_zip = write_zip(&[("recursive.snapshot.json", &exported_bytes)]);
  let roundtrip = decode_bytes(&roundtrip_zip).expect("existing decoder accepts exported native snapshot");
  assert_eq!(roundtrip.documents[0].source_id, "recursive");
  assert_eq!(roundtrip.documents[0].title, "Recursive");
  let DecodedDocumentContent::SnapshotBlocks(roundtrip_blocks) = &roundtrip.documents[0].content else {
    panic!("native export must use the existing Snapshot representation");
  };
  let restored = yjs::snapshot_blocks_to_yjs(roundtrip_blocks).expect("editable roundtrip");
  assert!(yjs::native_documents_have_same_content(&update, &restored).expect("complete native semantic comparison"));

  let temp = tempfile::NamedTempFile::new().expect("temporary archive");
  fs::write(temp.path(), &bytes).expect("write recursive archive");
  let diagnostic = WorkspaceDecoder::new(WorkspaceImportLimits {
    max_blocks: 2,
    ..WorkspaceImportLimits::default()
  })
  .decode_path(temp.path())
  .expect_err("nested blocks count toward the global limit");
  assert_eq!(
    diagnostic.code,
    WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveLimit
  );
}

#[test]
fn snapshot_decoder_counts_only_allowlisted_non_portable_categories() {
  let bytes = write_zip(&[
    (
      "doc.snapshot.json",
      br#"{"meta":{"id":"doc"},"blocks":[]}"#,
    ),
    (
      "info.json",
      br#"{"members":[{},{}],"sessions":[{}],"publications":{"one":{}},"comments":[{},{},{}],"history":[{},{}],"credentials":{"secret":"redacted"},"unrelated":[{},{},{},{}]}"#,
    ),
  ]);
  let decoded = decode_bytes(&bytes).expect("allowlisted info categories");
  assert_eq!(decoded.omitted_counts.memberships, 2);
  assert_eq!(decoded.omitted_counts.sessions, 1);
  assert_eq!(decoded.omitted_counts.sharing_and_publications, 1);
  assert_eq!(decoded.omitted_counts.comments, 3);
  assert_eq!(decoded.omitted_counts.activity_and_history, 2);
  assert_eq!(decoded.omitted_counts.external_integrations_and_credentials, 1);
}

#[test]
fn document_index_rejects_missing_parents_and_cycles() {
  let missing_parent = write_zip(&[(
    "child.snapshot.json",
    br#"{"meta":{"id":"child","parentId":"missing"},"blocks":[]}"#,
  )]);
  assert_eq!(
    decode_bytes(&missing_parent).expect_err("missing parent must block preview"),
    WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid
  );

  let cycle = write_zip(&[
    ("a.snapshot.json", br#"{"meta":{"id":"a","parentId":"b"},"blocks":[]}"#),
    ("b.snapshot.json", br#"{"meta":{"id":"b","parentId":"a"},"blocks":[]}"#),
  ]);
  assert_eq!(
    decode_bytes(&cycle).expect_err("hierarchy cycle must block preview"),
    WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid
  );

  let unsupported_mode = write_zip(&[(
    "canvas.snapshot.json",
    br#"{"meta":{"id":"canvas","mode":"unknown"},"blocks":[]}"#,
  )]);
  assert_eq!(
    decode_bytes(&unsupported_mode).expect_err("unsupported mode must block preview"),
    WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid
  );
}

#[test]
fn sqlite_decoder_rejects_missing_blob_references() {
  let temp = tempfile::NamedTempFile::new().expect("temporary SQLite source");
  fs::copy(fixture("workspace-sqlite-v1-valid.myoxus"), temp.path()).expect("copy SQLite fixture");
  let connection = Connection::open(temp.path()).expect("open copied fixture");
  connection
    .execute("DELETE FROM blobs", [])
    .expect("remove declared assets");
  drop(connection);

  let diagnostic = WorkspaceDecoder::new(WorkspaceImportLimits::default())
    .decode_path(temp.path())
    .expect_err("missing SQLite asset must block preview");
  assert_eq!(
    diagnostic.code,
    WorkspaceImportDiagnosticCode::MixWorkspaceImportAssetMissing
  );
}

#[test]
fn current_doc_storage_schema_is_decoded_through_the_same_neutral_model() {
  let source = Connection::open_with_flags(
    fixture("workspace-sqlite-v1-valid.myoxus"),
    OpenFlags::SQLITE_OPEN_READ_ONLY,
  )
  .expect("open v1 fixture");
  let updates = {
    let mut statement = source
      .prepare("SELECT COALESCE(doc_id, ''), data FROM updates ORDER BY id")
      .expect("prepare source updates");
    statement
      .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)))
      .expect("query source updates")
      .collect::<Result<Vec<_>, _>>()
      .expect("read source updates")
  };
  let assets = {
    let mut statement = source
      .prepare("SELECT key, data FROM blobs ORDER BY key")
      .expect("prepare source assets");
    statement
      .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)))
      .expect("query source assets")
      .collect::<Result<Vec<_>, _>>()
      .expect("read source assets")
  };

  let temp = tempfile::NamedTempFile::new().expect("current DocStorage fixture");
  let current = Connection::open(temp.path()).expect("create current DocStorage");
  current
    .execute_batch(
      r#"
      CREATE TABLE meta (space_id VARCHAR PRIMARY KEY NOT NULL);
      CREATE TABLE snapshots (
        doc_id VARCHAR PRIMARY KEY NOT NULL,
        data BLOB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP NOT NULL
      );
      CREATE TABLE updates (
        doc_id VARCHAR NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (doc_id, created_at)
      );
      CREATE TABLE blobs (
        key VARCHAR PRIMARY KEY NOT NULL,
        data BLOB NOT NULL,
        mime VARCHAR NOT NULL,
        size INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        deleted_at TIMESTAMP
      );
      "#,
    )
    .expect("create current schema");
  current
    .execute("INSERT INTO meta(space_id) VALUES ('root-doc')", [])
    .expect("write metadata");
  let initial_root = yjs::create_initial_workspace_doc("Current workspace");
  let page_entries = updates
    .iter()
    .map(|(doc_id, _)| (doc_id.clone(), format!("Page {doc_id}")))
    .collect::<Vec<_>>();
  let root_delta =
    yjs::add_pages_to_root_doc(std::slice::from_ref(&initial_root), &page_entries).expect("create root page directory");
  let root = yjs::merge_updates(vec![initial_root, root_delta]).expect("merge root document");
  let root = yjs::project_workspace_tags_in_root_doc(&root,
    &serde_json::json!([{"id": "legacy-root", "value": "Root label", "color": "tag.red", "description": "Retained", "archived": true}]),
    &std::collections::HashMap::from([("doc-home".to_string(), vec!["legacy-root".to_string()])]),
  ).expect("portable root label projection");
  current
    .execute(
      "INSERT INTO snapshots(doc_id, data, updated_at) VALUES ('root-doc', ?1, CURRENT_TIMESTAMP)",
      params![root],
    )
    .expect("write current root snapshot");
  for helper_id in ["db$folders", "userdata$owner$documentMetadataCache"] {
    current
      .execute(
        "INSERT INTO snapshots(doc_id, data, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)",
        params![helper_id, vec![0_u8, 0]],
      )
      .expect("write reserved helper snapshot");
  }
  for (doc_id, update) in updates {
    current
      .execute(
        "INSERT INTO snapshots(doc_id, data, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)",
        params![doc_id, update],
      )
      .expect("write current snapshot");
  }
  for (key, data) in assets {
    let size = data.len();
    current
      .execute(
        "INSERT INTO blobs(key, data, mime, size) VALUES (?1, ?2, 'application/octet-stream', ?3)",
        params![key, data, size],
      )
      .expect("write current asset");
  }
  drop(current);

  let decoded = WorkspaceDecoder::new(WorkspaceImportLimits::default())
    .decode_path(temp.path())
    .expect("decode current DocStorage");
  assert_eq!(decoded.format, WorkspaceImportFormat::SqliteDocStorage);
  assert_eq!(decoded.title, "Current workspace");
  assert_eq!(decoded.workspace_tags[0].name, "Root label");
  assert!(decoded.workspace_tags[0].archived);
  assert_eq!(decoded.workspace_tags[0].description.as_deref(), Some("Retained"));
  assert_eq!(
    decoded
      .documents
      .iter()
      .find(|doc| doc.source_id == "doc-home")
      .unwrap()
      .tags,
    ["legacy-root"]
  );
  assert_eq!(decoded.documents.len(), 2);
  assert_eq!(decoded.assets.len(), 1);
  assert_eq!(
    decoded
      .documents
      .iter()
      .map(|document| extract_database_blocks(document).expect("Database blocks").len())
      .sum::<usize>(),
    3
  );
  let reserved_page = yjs::add_pages_to_root_doc(
    std::slice::from_ref(&root),
    &[("db$folders".to_string(), "Invalid page".to_string())],
  )
  .expect("construct invalid reserved page reference");
  let invalid_root = yjs::merge_updates(vec![root, reserved_page]).expect("merge invalid root");
  let current = Connection::open(temp.path()).expect("reopen disposable fixture");
  current
    .execute(
      "UPDATE snapshots SET data=?1 WHERE doc_id='root-doc'",
      params![invalid_root],
    )
    .expect("write invalid root");
  drop(current);
  assert_eq!(
    WorkspaceDecoder::new(WorkspaceImportLimits::default())
      .decode_path(temp.path())
      .expect_err("a user page must not silently resolve to a helper document")
      .code,
    WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid
  );
}

#[test]
fn archive_boundary_rejects_traversal_absolute_duplicate_symlink_and_bombs() {
  let snapshot = br#"{"meta":{"id":"doc"},"blocks":[]}"#;
  let cases = [
    write_zip(&[("../doc.snapshot.json", snapshot)]),
    write_zip(&[("/doc.snapshot.json", snapshot)]),
    write_zip(&[("C:/doc.snapshot.json", snapshot)]),
    write_zip(&[("doc.snapshot.json", snapshot), ("DOC.SNAPSHOT.JSON", snapshot)]),
  ];
  for bytes in cases {
    assert_eq!(
      decode_bytes(&bytes).expect_err("unsafe archive must fail"),
      WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid
    );
  }

  let mut symlink = zip::ZipWriter::new(Cursor::new(Vec::new()));
  symlink
    .add_symlink(
      "doc.snapshot.json",
      "target",
      SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
    )
    .expect("write symlink entry");
  let symlink = symlink.finish().expect("finish symlink ZIP").into_inner();
  assert_eq!(
    decode_bytes(&symlink).expect_err("symlink archive must fail"),
    WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid
  );

  let mut bomb = zip::ZipWriter::new(Cursor::new(Vec::new()));
  bomb
    .start_file(
      "doc.snapshot.json",
      SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
    )
    .expect("start compressed entry");
  bomb.write_all(&vec![b' '; 64 * 1024]).expect("write compressed entry");
  let bomb = bomb.finish().expect("finish compressed ZIP").into_inner();
  let temp = tempfile::NamedTempFile::new().expect("temporary bomb");
  fs::write(temp.path(), bomb).expect("write bomb");
  let diagnostic = WorkspaceDecoder::new(WorkspaceImportLimits {
    max_compression_ratio: 1,
    ..WorkspaceImportLimits::default()
  })
  .decode_path(temp.path())
  .expect_err("compression bomb must fail before JSON parsing");
  assert_eq!(
    diagnostic.code,
    WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveLimit
  );
}

#[test]
fn snapshot_database_extraction_rejects_duplicate_block_identities() {
  let bytes = write_zip(&[(
    "doc.snapshot.json",
    br#"{"meta":{"id":"doc"},"blocks":[{"id":"same","flavour":"affine:database","props":{}},{"id":"same","flavour":"myoxus:database","props":{}}]}"#,
  )]);
  assert_eq!(
    decode_bytes(&bytes).expect_err("duplicate block id must fail during normalization"),
    WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid
  );
}

#[test]
fn snapshot_database_extraction_accepts_canonical_virgultum_token_fields() {
  let bytes = write_zip(&[(
    "doc.snapshot.json",
    br#"{"meta":{"id":"doc"},"blocks":{"database":{"sys:flavour":"affine:database","sys:children":["row"],"prop:databaseId":"legacy-db","prop:title":"Projects","prop:columns":[{"id":"title","type":"title"}],"prop:views":[{"id":"table","mode":"table"}],"prop:cells":{"row":{"title":{"value":"First"}}}},"row":{"sys:flavour":"affine:paragraph","prop:text":"First"}}}"#,
  )]);
  let decoded = decode_bytes(&bytes).expect("token-field snapshot");
  let databases = extract_database_blocks(&decoded.documents[0]).expect("Database extraction");
  assert_eq!(databases.len(), 1);
  assert_eq!(databases[0].source_database_id.as_deref(), Some("legacy-db"));
  assert_eq!(databases[0].title, "Projects");
  assert_eq!(databases[0].rows[0].title, "First");
}

#[test]
fn malformed_sources_return_stable_blocking_diagnostics() {
  let decoder = WorkspaceDecoder::new(WorkspaceImportLimits::default());
  let cases = [
    (
      "invalid/format-unsupported.bin",
      WorkspaceImportDiagnosticCode::MixWorkspaceImportFormatUnsupported,
    ),
    (
      "invalid/archive-invalid.zip",
      WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid,
    ),
    (
      "invalid/sqlite-invalid.db",
      WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
    ),
    (
      "invalid/sqlite-schema-unsupported.db",
      WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteSchemaUnsupported,
    ),
    (
      "invalid/snapshot-invalid.zip",
      WorkspaceImportDiagnosticCode::MixWorkspaceImportSnapshotInvalid,
    ),
    (
      "invalid/asset-missing.zip",
      WorkspaceImportDiagnosticCode::MixWorkspaceImportAssetMissing,
    ),
    (
      "invalid/yjs-invalid.myoxus",
      WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
    ),
  ];
  for (name, expected) in cases {
    let diagnostic = decoder.decode_path(fixture(name)).expect_err(name);
    assert_eq!(diagnostic.code, expected, "wrong diagnostic for {name}");
  }
}

#[test]
fn every_decoder_resource_limit_is_enforced_at_its_consuming_boundary() {
  let sqlite = fixture("workspace-sqlite-v1-valid.myoxus");
  let snapshot = fixture("workspace-snapshot-valid.zip");
  let cases = [
    (
      WorkspaceImportLimits {
        max_upload_bytes: 1,
        ..WorkspaceImportLimits::default()
      },
      &snapshot,
    ),
    (
      WorkspaceImportLimits {
        max_sqlite_bytes: 1,
        ..WorkspaceImportLimits::default()
      },
      &sqlite,
    ),
    (
      WorkspaceImportLimits {
        max_document_bytes: 1,
        ..WorkspaceImportLimits::default()
      },
      &snapshot,
    ),
    (
      WorkspaceImportLimits {
        max_expanded_bytes: 1,
        ..WorkspaceImportLimits::default()
      },
      &snapshot,
    ),
    (
      WorkspaceImportLimits {
        max_archive_entries: 1,
        ..WorkspaceImportLimits::default()
      },
      &snapshot,
    ),
    (
      WorkspaceImportLimits {
        max_entry_bytes: 1,
        ..WorkspaceImportLimits::default()
      },
      &snapshot,
    ),
    (
      WorkspaceImportLimits {
        max_compression_ratio: 0,
        ..WorkspaceImportLimits::default()
      },
      &snapshot,
    ),
    (
      WorkspaceImportLimits {
        max_documents: 1,
        ..WorkspaceImportLimits::default()
      },
      &snapshot,
    ),
    (
      WorkspaceImportLimits {
        max_blocks: 1,
        ..WorkspaceImportLimits::default()
      },
      &snapshot,
    ),
    (
      WorkspaceImportLimits {
        max_assets: 0,
        ..WorkspaceImportLimits::default()
      },
      &snapshot,
    ),
    (
      WorkspaceImportLimits {
        max_asset_bytes: 0,
        ..WorkspaceImportLimits::default()
      },
      &snapshot,
    ),
  ];
  for (limits, path) in cases {
    let diagnostic = WorkspaceDecoder::new(limits)
      .decode_path(path)
      .expect_err("limit must reject fixture");
    assert!(
      matches!(
        diagnostic.code,
        WorkspaceImportDiagnosticCode::MixWorkspaceImportUploadLimit
          | WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveLimit
          | WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid
      ),
      "unexpected limit diagnostic: {diagnostic:?}"
    );
  }
}
