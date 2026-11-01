// SPDX-License-Identifier: AGPL-3.0-or-later
//! End-to-end contract for current-state `export-docs` JSON output.

use crate::support;

use std::sync::Arc;

use base64::Engine as _;
use myoxus_application::doc::DocService;
use myoxus_application::git_sync::export::{ExportFrontmatter, split_markdown_file};
use myoxus_application::markdown::content_hash;
use myoxus_application::organizer::{CreateOrganizerFolder, CreateOrganizerLink, OrganizerLinkType, OrganizerService};
use myoxus_infrastructure::doc::SqlxDocStore;
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use support::database_url;
use uuid::Uuid;

const MARKDOWN_BREADTH_FIXTURE: &str = include_str!(concat!(
  env!("CARGO_MANIFEST_DIR"),
  "/../../../build/fixtures/seed-documents/complex/03-operations-runbook-fixture.md"
));

#[tokio::test]
async fn export_docs_json_is_clean_and_preserves_current_client_shaped_markdown() {
  let pool = PgPoolOptions::new()
    .max_connections(2)
    .connect(&database_url())
    .await
    .expect("connect isolated test database");
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");

  let user_id = Uuid::new_v4();
  let user_email = format!("export-{user_id}@test.local");
  sqlx::query("INSERT INTO users (id, email, name, email_verified_at) VALUES ($1, $2, 'Export fixture', now())")
    .bind(user_id)
    .bind(&user_email)
    .execute(&pool)
    .await
    .expect("user");
  let workspace_id = Uuid::new_v4();
  sqlx::query("INSERT INTO workspaces (id, owner_user_id, name, public) VALUES ($1, $2, 'Export fixture', false)")
    .bind(workspace_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("workspace");
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, 'Collaborator', 'Accepted', now(), now())",
  )
  .bind(workspace_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("workspace membership");

  let external_user_id = Uuid::new_v4();
  let reimport_workspace = Uuid::new_v4();
  let journey_pool = pool.clone();
  let journey = tokio::spawn(async move {
  let pool = journey_pool;
  let import_dir = tempfile::tempdir().expect("compiled import fixture directory");
  let import_path = import_dir.path().join("operations-runbook-fixture.md");
  const SCOPED_ASSET_SOURCE: &str = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  let footnotes = include_str!("../../../../../build/fixtures/markdown/obsidian-vault/Structured footnotes.md")
    .replace("media/pixel.svg", SCOPED_ASSET_SOURCE);
  const HEADER_TABLES: &str = "<table><tbody><tr><td style=\"text-align:left\"><strong>Headerless label</strong></td><td style=\"text-align:right\"></td></tr><tr><td style=\"text-align:left\">first<br>second</td><td style=\"text-align:right\">&lt;literal&gt;</td></tr></tbody></table>\n\n<table><thead><tr><th>First header</th></tr><tr><th><em>Second header</em></th></tr></thead><tbody><tr><td>Body</td></tr></tbody></table>";
  let import_markdown = format!(
    "{MARKDOWN_BREADTH_FIXTURE}\n\nAsset literal {SCOPED_ASSET_SOURCE}\n\n`{SCOPED_ASSET_SOURCE}`\n\n[asset link]({SCOPED_ASSET_SOURCE})\n\n![first]({SCOPED_ASSET_SOURCE})\n\n![second]({SCOPED_ASSET_SOURCE})\n\n{footnotes}\n\n{HEADER_TABLES}"
  );
  std::fs::write(&import_path, import_markdown).expect("write compiled import fixture");
  let storage_dir = tempfile::tempdir().expect("compiled import storage directory");
  for attempt in 1..=2 {
    let output = support::cli_command()
      .env("MYOXUS__DATABASE__URL", database_url())
      .arg("import-file")
      .arg("--user")
      .arg(&user_email)
      .arg("--workspace")
      .arg(workspace_id.to_string())
      .arg("--seed-key-prefix")
      .arg("compiled-markdown-pipeline")
      .arg("--storage-root")
      .arg(storage_dir.path())
      .arg(&import_path)
      .output()
      .expect("run compiled import-file");
    assert!(
      output.status.success(),
      "compiled import attempt {attempt} failed: {}\n{}",
      String::from_utf8_lossy(&output.stdout),
      String::from_utf8_lossy(&output.stderr)
    );
  }
  let imported_doc_id: Uuid = sqlx::query_scalar(
    "SELECT id FROM docs WHERE workspace_id = $1 AND title = 'Operations Runbook Fixture' AND deleted_at IS NULL",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("compiled import created exactly one fixture document");
  let imported_doc_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*)::bigint FROM docs
     WHERE workspace_id = $1 AND title = 'Operations Runbook Fixture' AND deleted_at IS NULL",
  )
  .bind(workspace_id)
  .fetch_one(&pool)
  .await
  .expect("count compiled fixture imports");
  assert_eq!(imported_doc_count, 1, "repeat import must update instead of duplicate");

  let invalid_table_path = import_dir.path().join("invalid-table.md");
  std::fs::write(&invalid_table_path,"# Rejected table\n\n<table><tbody><tr><td onclick=\"private()\">Bad</td></tr></tbody></table>").unwrap();
  let before:i64=sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1").bind(workspace_id).fetch_one(&pool).await.unwrap();
  let invalid_table = support::cli_command().env("MYOXUS__DATABASE__URL",database_url()).arg("import-file").arg("--user").arg(&user_email).arg("--workspace").arg(workspace_id.to_string()).arg("--storage-root").arg(storage_dir.path()).arg(&invalid_table_path).output().unwrap();
  assert!(!invalid_table.status.success(), "HTML must fail during Markdown preflight: stdout={} stderr={}", String::from_utf8_lossy(&invalid_table.stdout), String::from_utf8_lossy(&invalid_table.stderr));assert!(String::from_utf8_lossy(&invalid_table.stderr).contains("unsupported raw HTML in Markdown"), "wrong rejection: {}", String::from_utf8_lossy(&invalid_table.stderr));assert!(!String::from_utf8_lossy(&invalid_table.stderr).contains("private"));
  let after:i64=sqlx::query_scalar("SELECT count(*) FROM docs WHERE workspace_id=$1").bind(workspace_id).fetch_one(&pool).await.unwrap();assert_eq!(before,after);


  let blobs_before_rejection: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blobs WHERE workspace_id=$1")
    .bind(workspace_id).fetch_one(&pool).await.expect("count normal imported blobs");
  let invalid_images_path = import_dir.path().join("invalid-images.md");
  std::fs::write(&invalid_images_path, format!(
    "# Invalid images\n\n![valid first]({SCOPED_ASSET_SOURCE})\n\n![invalid second](data:image/png;base64,%%%)\n"
  )).expect("write rejected image fixture");
  let invalid_images = support::cli_command()
    .env("MYOXUS__DATABASE__URL", database_url())
    .arg("import-file").arg("--user").arg(&user_email)
    .arg("--workspace").arg(workspace_id.to_string())
    .arg("--storage-root").arg(storage_dir.path())
    .arg(&invalid_images_path).output().expect("run invalid second-image import");
  let rejection_report = String::from_utf8_lossy(&invalid_images.stderr);
  // The established CLI reports per-file failures in its summary and continues.
  assert!(rejection_report.contains("embedded Markdown asset materialization failed"),
    "the rejected image must be reported: {rejection_report}");
  assert!(rejection_report.contains("Imported: 0"), "no file may import: {rejection_report}");
  let blobs_after_rejection: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blobs WHERE workspace_id=$1")
    .bind(workspace_id).fetch_one(&pool).await.expect("count blobs after rejected image import");
  assert_eq!(blobs_after_rejection, blobs_before_rejection,
    "a malformed second image must fail before the first image is uploaded");
  let rejected_image_docs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id=$1 AND title='Invalid images'")
    .bind(workspace_id).fetch_one(&pool).await.expect("count rejected image documents");
  assert_eq!(rejected_image_docs, 0, "rejected images must not publish a document");

  let batch_dir = tempfile::tempdir().expect("compiled reference batch");
  let source_path = batch_dir.path().join("source.md");
  let target_path = batch_dir.path().join("target.md");
  std::fs::write(&source_path, "# Batch source\n\n[[target|Target alias]]\n\n[Heading alias](target.md#%C3%9Cber%20Gr%C3%B6%C3%9Fe)\n\n[[target#^release|Instruction alias]]\n\n[Local alias](#Local)\n\n## Local\n").expect("source fixture");
  std::fs::write(
    &target_path,
    "# Batch target\n\n## Über Größe\n\nRelease instruction ^release\n\n[[source|Source alias]]",
  )
  .expect("target fixture");
  let rejected = support::cli_command()
    .env("MYOXUS__DATABASE__URL", database_url())
    .arg("import-file")
    .arg("--user")
    .arg(&user_email)
    .arg("--workspace")
    .arg(workspace_id.to_string())
    .arg(&source_path)
    .arg(&target_path)
    .arg(batch_dir.path().join("missing.md"))
    .output()
    .expect("run missing-source batch");
  assert!(
    !rejected.status.success(),
    "an explicitly requested missing source must reject the batch"
  );
  let count_after_rejection: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM docs WHERE workspace_id=$1 AND NOT is_workspace_root")
      .bind(workspace_id)
      .fetch_one(&pool)
      .await
      .expect("document count after rejected batch");
  assert_eq!(
    count_after_rejection, 1,
    "source capture fails before any batch document is written"
  );
  for attempt in 1..=2 {
    let output = support::cli_command()
      .env("MYOXUS__DATABASE__URL", database_url())
      .arg("import-file")
      .arg("--user")
      .arg(&user_email)
      .arg("--workspace")
      .arg(workspace_id.to_string())
      .arg("--storage-root")
      .arg(storage_dir.path())
      .arg(&source_path)
      .arg(&target_path)
      .output()
      .expect("run compiled reference import");
    assert!(
      output.status.success(),
      "compiled reference import {attempt} failed: {}",
      String::from_utf8_lossy(&output.stderr)
    );
  }
  let batch_sources: Vec<(Uuid, String)> = sqlx::query_as(
    "SELECT id, external_id FROM docs WHERE workspace_id=$1 AND title='Batch source' ORDER BY created_at, id",
  )
  .bind(workspace_id)
  .fetch_all(&pool)
  .await
  .expect("batch sources");
  let batch_targets: Vec<(Uuid, String)> = sqlx::query_as(
    "SELECT id, external_id FROM docs WHERE workspace_id=$1 AND title='Batch target' ORDER BY created_at, id",
  )
  .bind(workspace_id)
  .fetch_all(&pool)
  .await
  .expect("batch targets");
  assert_eq!(batch_sources.len(), 2, "ordinary repeat import creates a new source");
  assert_eq!(batch_targets.len(), 2, "ordinary repeat import creates a new target");
  for ((source_id, source_external_id), (target_id, target_external_id)) in batch_sources.iter().zip(&batch_targets) {
    let payload: Vec<u8> = sqlx::query_scalar(
      "SELECT payload FROM doc_updates WHERE workspace_id=$1 AND doc_id=$2 ORDER BY sequence DESC LIMIT 1",
    )
    .bind(workspace_id)
    .bind(source_id)
    .fetch_one(&pool)
    .await
    .expect("batch source payload");
    let fragment = myoxus_application::doc::document_fragment_from_yjs(&payload).expect("batch source fragment");
    let reference = fragment.blocks.iter().find_map(|block| match block {
      yjs::DocumentFragmentBlock::Paragraph { text, .. } => text.iter().find_map(|segment| segment.reference.as_ref()),
      _ => None,
    });
    assert_eq!(
      reference.map(|reference| reference.page_id.as_str()),
      Some(target_external_id.as_str())
    );
    assert_eq!(
      reference.and_then(|reference| reference.title.as_deref()),
      Some("Target alias")
    );
    let service = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())));
    let target_payload = service
      .load_full_doc(workspace_id, *target_id)
      .await
      .expect("current target payload");
    let targets = yjs::markdown::markdown_native_targets(&target_payload).expect("target native tree");
    let local_targets = yjs::markdown::markdown_native_targets(&payload).expect("source native tree");
    let references = yjs::extract_document_references_from_yjs(&payload).expect("native references");
    for (alias, external_id, tree, fragment) in [
      ("Heading alias", target_external_id, &targets, "Über Größe"),
      ("Instruction alias", target_external_id, &targets, "^release"),
      ("Local alias", source_external_id, &local_targets, "Local"),
    ] {
      let target = yjs::markdown::resolve_markdown_target(tree, fragment).expect("unique actual native target");
      let reference = references
        .occurrences
        .iter()
        .find(|reference| reference.params_json["title"] == alias)
        .unwrap_or_else(|| panic!("missing imported native reference {alias}"));
      assert_eq!(&reference.raw_target_doc_id, external_id);
      assert_eq!(
        reference.params_json["params"]["blockIds"],
        serde_json::json!([target.block_id])
      );
    }
  }

  let current_doc_id = Uuid::new_v4();
  let empty_doc_id = Uuid::new_v4();
  let list_doc_id = Uuid::new_v4();
  let native_list_doc_id = Uuid::new_v4();
  let omitted_doc_id = Uuid::new_v4();
  let omitted_external_id = "AuthorizedOmittedTarget1";
  let current_external_id = "ExportNanoPlacement8kR";
  for (doc_id, external_id, title) in [
    (current_doc_id, current_external_id.to_string(), "Current"),
    (empty_doc_id, empty_doc_id.to_string(), "Empty"),
    (list_doc_id, list_doc_id.to_string(), "Client shaped lists"),
    (
      native_list_doc_id,
      native_list_doc_id.to_string(),
      "Native list fidelity",
    ),
    (
      omitted_doc_id,
      omitted_external_id.to_string(),
      "Authorized omitted target",
    ),
  ] {
    sqlx::query(
      "INSERT INTO docs (id, external_id, workspace_id, title, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)",
    )
    .bind(doc_id)
    .bind(&external_id)
    .bind(workspace_id)
    .bind(title)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("document");
  }

  let mut builder = yjs::YjsDocumentBuilder::new("Current");
  let mut empty_reference = yjs::YjsTextSegment::plain("Empty alias");
  empty_reference.reference = Some(yjs::MarkdownDocumentReference {
    page_id: empty_doc_id.to_string(),
    title: Some("Empty alias".to_string()),
    description: None,
    params: None,
  });
  let mut omitted_reference = yjs::YjsTextSegment::plain("Omitted alias");
  omitted_reference.reference = Some(yjs::MarkdownDocumentReference {
    page_id: omitted_external_id.to_string(),
    title: Some("Omitted alias".to_string()),
    description: None,
    params: None,
  });
  builder.push_paragraph(&[
    yjs::YjsTextSegment::plain("Snapshot body links to "),
    empty_reference,
    yjs::YjsTextSegment::plain(" and "),
    omitted_reference,
  ]);
  let snapshot = builder.encode_state();
  let snapshot_vector = builder.state_vector();
  builder.push_paragraph(&[yjs::YjsTextSegment::plain("Pending body")]);
  builder.push_mermaid("graph TD\n  A --> B\n``` embedded", "", "");
  let tail = builder.encode_diff(&snapshot_vector);
  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence)
     VALUES ($1, $2, $3, 0)",
  )
  .bind(current_doc_id)
  .bind(workspace_id)
  .bind(snapshot)
  .execute(&pool)
  .await
  .expect("snapshot");
  sqlx::query(
    "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
     VALUES ($1, $2, $3, 1)",
  )
  .bind(current_doc_id)
  .bind(workspace_id)
  .bind(tail)
  .execute(&pool)
  .await
  .expect("tail");

  for sequence in 1..=2_i64 {
    sqlx::query(
      "INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
       VALUES ($1, $2, $3, $4)",
    )
    .bind(omitted_doc_id)
    .bind(workspace_id)
    .bind(vec![0xff, sequence as u8])
    .bind(sequence)
    .execute(&pool)
    .await
    .expect("invalid omitted-target update");
  }

  let list_snapshot =
    myoxus_application::markdown::prepare_markdown_import("Client shaped lists", MARKDOWN_BREADTH_FIXTURE)
      .expect("build client-shaped list fixture")
      .yjs_binary;
  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence)
     VALUES ($1, $2, $3, 0)",
  )
  .bind(list_doc_id)
  .bind(workspace_id)
  .bind(list_snapshot)
  .execute(&pool)
  .await
  .expect("list snapshot");

  let native_list_snapshot = base64::engine::general_purpose::STANDARD
    .decode(
      include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../build/fixtures/seed-documents/complex/native-yjs-list-fidelity.b64"
      ))
      .trim(),
    )
    .expect("decode native Yjs list fixture");
  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence)
     VALUES ($1, $2, $3, 0)",
  )
  .bind(native_list_doc_id)
  .bind(workspace_id)
  .bind(native_list_snapshot)
  .execute(&pool)
  .await
  .expect("native list snapshot");

  let organizer = OrganizerService::new(DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))));
  organizer
    .create_folder(
      workspace_id,
      CreateOrganizerFolder {
        id: "export-folder".to_string(),
        parent_id: None,
        name: "Nano folder".to_string(),
        index: Some("a0".to_string()),
      },
    )
    .await
    .expect("create export Organizer folder");
  organizer
    .create_link(
      workspace_id,
      CreateOrganizerLink {
        id: "export-entry".to_string(),
        parent_id: "export-folder".to_string(),
        link_type: OrganizerLinkType::Doc,
        target_id: current_external_id.to_string(),
        target_workspace_id: None,
        index: Some("a0".to_string()),
      },
    )
    .await
    .expect("create NanoID Organizer link");

  let output_dir = tempfile::tempdir().expect("output directory");
  std::fs::create_dir(output_dir.path().join("content")).unwrap();
  std::fs::write(output_dir.path().join("content/README.md"), "User-owned README\n").unwrap();
  let output = support::cli_command()
    .env("MYOXUS__DATABASE__URL", database_url())
    .env("MYOXUS__STORAGE__ROOT", storage_dir.path())
    .arg("--json")
    .arg("export-docs")
    .arg("--workspace")
    .arg(workspace_id.to_string())
    .arg("--output")
    .arg(output_dir.path())
    .output()
    .expect("run export-docs");
  assert!(
    !output.status.success(),
    "the intentionally unreadable omitted target must make the compiled command report a partial failure"
  );
  assert!(
    String::from_utf8_lossy(&output.stderr).contains("1 document export(s) failed"),
    "stderr must summarize the isolated omitted-target failure: {}",
    String::from_utf8_lossy(&output.stderr)
  );
  let result: Value = serde_json::from_slice(&output.stdout).expect("stdout is exactly one JSON document");
  let exported = result["exported"].as_array().expect("exported");
  assert_eq!(exported.len(), 9, "every readable active document must materialize");
  assert!(result["skipped"].as_array().expect("skipped").is_empty());
  let failed = result["failed"].as_array().expect("failed");
  assert_eq!(failed.len(), 1, "only the invalid omitted target must fail");
  assert_eq!(failed[0]["objectId"], omitted_doc_id.to_string());
  assert!(
    exported
      .iter()
      .all(|item| item["objectId"] != omitted_doc_id.to_string()),
    "an omitted reference target must not be added to the file inventory"
  );

  let exported_by_id = |doc_id: Uuid| {
    exported
      .iter()
      .find(|item| item["objectId"] == doc_id.to_string())
      .unwrap_or_else(|| panic!("missing exported document {doc_id}"))
  };
  for ((source_id, _), (target_id, _)) in batch_sources.iter().zip(&batch_targets) {
    let source_path = exported_by_id(*source_id)["path"].as_str().expect("source export path");
    let target_path = exported_by_id(*target_id)["path"].as_str().expect("target export path");
    let source_file = std::fs::read_to_string(output_dir.path().join(source_path)).expect("source Markdown");
    let target_file = std::fs::read_to_string(output_dir.path().join(target_path)).expect("target Markdown");
    let (_, source_body) = split_markdown_file(&source_file);
    let (_, target_body) = split_markdown_file(&target_file);
    let target_name = std::path::Path::new(target_path).file_name().unwrap().to_str().unwrap();
    assert!(
      source_body.contains(&format!("[Instruction alias]({target_name}#%5Erelease)")),
      "retained exact block anchor: {source_body}"
    );
    assert!(target_body.contains("Release instruction ^release"));
    for alias in ["Heading alias", "Local alias"] {
      let start = source_body.find(&format!("[{alias}](")).expect("precise link") + alias.len() + 3;
      let href = source_body[start..].split(')').next().expect("link URL");
      let fragment = href.split_once('#').expect("target fragment").1;
      let anchor = fragment.strip_prefix("%5E").expect("generated native anchor");
      let body = if alias == "Local alias" {
        &source_body
      } else {
        &target_body
      };
      assert!(
        body.contains(&format!(" ^{anchor}")),
        "serialized target must actually carry {anchor}: {body}"
      );
    }
  }
  let current_item = exported_by_id(current_doc_id);
  let current_path = current_item["path"].as_str().expect("current export path");
  assert_eq!(current_path, "content/nano-folder/current.md");
  let current_file = std::fs::read_to_string(output_dir.path().join(current_path)).expect("current Markdown file");
  let (current_yaml, current_body) = split_markdown_file(&current_file);
  let current_frontmatter =
    ExportFrontmatter::from_yaml(&current_yaml.expect("current document frontmatter")).expect("valid frontmatter");
  assert_eq!(current_frontmatter.doc_id, current_doc_id);
  assert_eq!(current_frontmatter.workspace_id, workspace_id);
  assert!(current_body.contains("Snapshot body"));
  assert!(current_body.contains("Pending body"));
  assert!(current_body.contains("````mermaid\ngraph TD\n  A --> B\n``` embedded\n````"));
  assert!(
    current_body.contains("[Empty alias](../empty.md)"),
    "batch export must use the final relative path and preserve the alias: {current_body}"
  );
  assert!(
    current_body.contains("[Omitted alias](http")
      && current_body.contains(&format!("/workspace/{workspace_id}/{omitted_external_id})")),
    "authorized targets omitted from the file inventory need a canonical link: {current_body}"
  );

  let imported_item = exported_by_id(imported_doc_id);
  let imported_path = imported_item["path"].as_str().expect("compiled import export path");
  let imported_file =
    std::fs::read_to_string(output_dir.path().join(imported_path)).expect("compiled import Markdown export");
  let (_, imported_body) = split_markdown_file(&imported_file);
  assert!(imported_body.contains("| :--- | :---: | ---: | --- |"));
  assert!(imported_body.contains("```mermaid"));
  assert!(imported_body.contains("- [x] Record the verified outcome."));
  assert_eq!(
    imported_body.matches(SCOPED_ASSET_SOURCE).count(),
    3,
    "prose, code and ordinary-link data URLs must remain byte-identical"
  );
  sqlx::query("INSERT INTO workspaces(id,owner_user_id,name,public) VALUES($1,$2,'Alignment reimport',false)")
    .bind(reimport_workspace)
    .bind(user_id)
    .execute(&pool)
    .await
    .unwrap();
  sqlx::query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'Collaborator','Accepted')",
  )
  .bind(reimport_workspace)
  .bind(user_id)
  .execute(&pool)
  .await
  .unwrap();
  let reimport = support::cli_command()
    .env("MYOXUS__DATABASE__URL", database_url())
    .arg("import-file")
    .arg("--user")
    .arg(&user_email)
    .arg("--workspace")
    .arg(reimport_workspace.to_string())
    .arg("--storage-root")
    .arg(storage_dir.path())
    .arg(output_dir.path().join(imported_path))
    .output()
    .unwrap();
  assert!(
    reimport.status.success(),
    "compiled export reimport: {}",
    String::from_utf8_lossy(&reimport.stderr)
  );
  let reimport_id: Uuid = sqlx::query_scalar("SELECT id FROM docs WHERE workspace_id=$1 AND NOT is_workspace_root")
    .bind(reimport_workspace)
    .fetch_one(&pool)
    .await
    .unwrap();
  let reimport_payload = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
    .load_full_doc(reimport_workspace, reimport_id)
    .await
    .unwrap();
  {
    use yrs::{Map, Transact, updates::decoder::Decode};
    let native = yrs::Doc::new();
    let blocks = native.get_or_insert_map("blocks");
    native
      .transact_mut()
      .apply_update(yrs::Update::decode_v1(&reimport_payload).unwrap())
      .unwrap();
    let txn = native.transact();
    let table = blocks
      .iter(&txn)
      .find_map(|(_, value)| {
        let yrs::Out::YMap(block) = value else { return None };
        (block.get(&txn, "prop:columns.col-0003.columnId").is_some()
          && block.get(&txn, "prop:columns.col-0000.textAlign").is_some())
        .then_some(block)
      })
      .expect("reimported runbook table");
    for (column, expected) in [(0, Some("left")), (1, Some("center")), (2, Some("right")), (3, None)] {
      let key = format!("prop:columns.col-{column:04}.textAlign");
      assert_eq!(
        table.get(&txn, &key).map(|value| value.to_string(&txn)).as_deref(),
        expected
      );
    }
  }
  let reexport_dir = tempfile::tempdir().unwrap();
  let reexport = support::cli_command()
    .env("MYOXUS__DATABASE__URL", database_url())
    .env("MYOXUS__STORAGE__ROOT", storage_dir.path())
    .arg("--json")
    .arg("export-docs")
    .arg("--workspace")
    .arg(reimport_workspace.to_string())
    .arg("--output")
    .arg(reexport_dir.path())
    .output()
    .unwrap();
  assert!(
    reexport.status.success(),
    "compiled reimport export: {}",
    String::from_utf8_lossy(&reexport.stderr)
  );
  let reexport: Value = serde_json::from_slice(&reexport.stdout).unwrap();
  let reexport_path = reexport["exported"][0]["path"]
    .as_str()
    .expect("reexported document path");
  let reexport_file = std::fs::read_to_string(reexport_dir.path().join(reexport_path)).unwrap();
  assert!(reexport_file.contains("| :--- | :---: | ---: | --- |"));
  use myoxus_application::ports::BlobStoragePort;
  let source_payload = DocService::new(Arc::new(SqlxDocStore::new(pool.clone())))
    .load_full_doc(workspace_id, imported_doc_id).await.unwrap();
  let imported_storage = myoxus_infrastructure::storage::StorageAdapter::new_fs(storage_dir.path().to_str().unwrap()).unwrap();
  let mut materialized = Vec::new();
  for (workspace, payload) in [(workspace_id, &source_payload), (reimport_workspace, &reimport_payload)] {
    let mut bytes = Vec::new();
    for image in yjs::extract_portable_asset_references(payload).unwrap().into_iter()
      .filter(|image| image.source_key.starts_with("markdown-import/")) {
      let key = myoxus_application::ports::blob::BlobKey::parse(&image.source_key).unwrap();
      bytes.push(imported_storage.read_blob(&key.storage_key(workspace)).await.expect("materialized imported image").data.to_vec());
    }
    bytes.sort();
    materialized.push(bytes);
  }
  assert_eq!(materialized[0], materialized[1], "packaged images must survive reimport as native bytes");

  std::fs::write(
    output_dir.path().join("escape.png"),
    b"outside the packaged assets directory",
  )
  .unwrap();
  let guarded_path = output_dir.path().join(imported_path);
  std::fs::write(&guarded_path, format!("{imported_file}\n\n![escape](../escape.png)\n")).unwrap();
  let escaped = support::cli_command()
    .env("MYOXUS__DATABASE__URL", database_url())
    .arg("import-file")
    .arg("--user")
    .arg(&user_email)
    .arg("--workspace")
    .arg(reimport_workspace.to_string())
    .arg("--dry-run")
    .arg(&guarded_path)
    .output()
    .unwrap();
  assert!(!escaped.status.success());
  assert!(String::from_utf8_lossy(&escaped.stderr).contains("escapes export assets directory"));
  std::fs::write(&guarded_path, &imported_file).unwrap();

  let materialized_images = imported_body
    .lines()
    .filter(|line| line.trim_start().starts_with("![") && line.contains("assets/") && line.ends_with(".gif)"))
    .collect::<Vec<_>>();
  assert_eq!(materialized_images.len(), 3, "normal body and definition images all materialize");
  assert!(imported_body.contains("[^Research]: Definition body"));
  assert!(imported_body.contains("    3. Ordered item"));
  assert!(imported_body.contains("    | :--- | :---: | ---: |"));
  assert!(imported_body.contains("<table><tbody><tr><td style=\"text-align: left\"><strong>Headerless label</strong>"));
  assert!(imported_body.contains("<thead><tr><th>First header</th></tr><tr><th><em>Second header</em>"));
  let table_roundtrip = myoxus_application::markdown::markdown_to_yjs("CLI tables", &imported_body).expect("CLI export reimport");
  let table_projection = myoxus_application::markdown::yjs_to_markdown(&table_roundtrip).unwrap().unwrap();
  assert!(!table_projection.partial);
  assert!(table_projection.markdown.contains("<strong>Headerless label</strong>"));
  assert!(table_projection.markdown.contains("first<br>second"));
  assert!(table_projection.markdown.contains("&lt;literal&gt;"));
  assert!(table_projection.markdown.contains("text-align: right"));

  assert_eq!(imported_body.matches("[^Research]:").count(), 1);
  assert_eq!(imported_body.matches("[^2]:").count(), 1);
  let first_key = materialized_images[0]
    .split_once('(')
    .and_then(|(_, value)| value.strip_suffix(')'))
    .expect("first materialized image key");
  let second_key = materialized_images[1]
    .split_once('(')
    .and_then(|(_, value)| value.strip_suffix(')'))
    .expect("second materialized image key");
  assert_eq!(
    first_key, second_key,
    "repeated image bytes must deduplicate to one blob key"
  );
  assert!(materialized_images.iter().all(|line| line.split_once('(').unwrap().1.strip_suffix(')').unwrap() == first_key),
    "definition and body images share the normal blob object");

  let asset_path = std::path::Path::new(imported_path).parent().unwrap().join(first_key);
  assert_eq!(
    std::fs::read(output_dir.path().join(&asset_path)).expect("portable normal image bytes"),
    base64::engine::general_purpose::STANDARD
      .decode(SCOPED_ASSET_SOURCE.split_once(',').unwrap().1)
      .unwrap()
  );
  let list_item = exported_by_id(list_doc_id);
  let list_path = list_item["path"].as_str().expect("list export path");
  let list_file = std::fs::read_to_string(output_dir.path().join(list_path)).expect("list Markdown file");
  let (_, list_body) = split_markdown_file(&list_file);
  for expected in [
    "# Operations Runbook Fixture",
    "## Scope",
    "### Incident Overview",
    "#### Severity Definitions",
    "##### Severity Notes",
    "###### Severity Leaf",
    "**confirmed regression**",
    "*suspected regression*",
    "`servedBundleHash`",
    "[API](https://example.test/api)",
    "literal \\*marker\\* and A \\| B",
    "A soft line break normalizes to a space, while this hard break\\\nalso normalizes without losing either side.",
    "> Keep the incident channel factual; quote verified observations and preserve literal Markdown punctuation in exported evidence.",
    "1. Create a narrow patch.",
    "   1. Keep unrelated changes out.",
    "- [ ] Confirm the impacted workspace.",
    "- [x] Record the verified outcome.",
    "  - [ ] Link the nested follow-up evidence.",
    "| Severity | Description | Response Target | Evidence |",
    "| :--- | :---: | ---: | --- |",
    "| SEV-4 |  | Planned | Minor copy mismatch |",
    "| Unaligned | Empty | Rich |",
    "| Plain |  | **bold** and `code` |",
    "```bash\nbuild/scripts/server/stack-status.sh",
    "```mermaid\ngraph TD\n    Observe --> Diagnose\n    Diagnose --> Verify\n```",
    "data:image/svg+xml",
    "data:image/png;base64",
    "![Repository diagram](assets/runbook-diagram.svg)",
  ] {
    assert!(
      list_body.contains(expected),
      "missing `{expected}` in exported Markdown:\n{list_body}"
    );
  }
  assert!(
    !list_body.contains("- [ ] Remove accidental local CSS"),
    "bullets must not become unchecked tasks:\n{list_body}"
  );
  assert!(
    !list_body.contains("- [ ] Create a narrow patch"),
    "numbered items must not become unchecked tasks:\n{list_body}"
  );

  let native_item = exported_by_id(native_list_doc_id);
  let native_path = native_item["path"].as_str().expect("native list export path");
  let native_file = std::fs::read_to_string(output_dir.path().join(native_path)).expect("native list Markdown file");
  let (_, native_body) = split_markdown_file(&native_file);
  assert_eq!(
    native_body.trim(),
    concat!(
      "- Bullet absent\n",
      "  - Bullet false\n",
      "- Bullet true\n",
      "1. Numbered absent\n",
      "   1. Numbered false\n",
      "1. Numbered true\n",
      "- [ ] Open\n",
      "  - [x] Nested done\n",
      "- [x] Done",
    ),
    "normal native lists must not inherit checkbox syntax from checked properties"
  );

  let empty_item = exported_by_id(empty_doc_id);
  assert_eq!(empty_item["contentHash"], content_hash(""));
  let empty_path = empty_item["path"].as_str().expect("empty export path");
  let empty_file = std::fs::read_to_string(output_dir.path().join(empty_path)).expect("empty Markdown file");
  let (empty_yaml, empty_body) = split_markdown_file(&empty_file);
  let empty_frontmatter =
    ExportFrontmatter::from_yaml(&empty_yaml.expect("empty document frontmatter")).expect("valid frontmatter");
  assert_eq!(empty_frontmatter.doc_id, empty_doc_id);
  assert_eq!(empty_frontmatter.workspace_id, workspace_id);
  assert_eq!(empty_frontmatter.title, "Empty");
  assert!(empty_body.is_empty(), "empty document body must remain empty");
  let manifest: Value =
    serde_json::from_slice(&std::fs::read(output_dir.path().join(".myoxus/git-sync-manifest.json")).unwrap())
      .expect("manifest JSON");
  assert!(
    manifest["documents"]
      .as_array()
      .expect("manifest documents")
      .iter()
      .any(|document| document["docId"] == current_doc_id.to_string())
  );
  let typed: myoxus_application::git_sync::export::GitSyncManifest = serde_json::from_value(manifest.clone()).unwrap();
  typed.validate_overviews(workspace_id, std::iter::empty()).unwrap();
  let root = typed.overview.as_ref().expect("workspace README");
  assert_ne!(root.repo_path, "content/README.md");
  assert_eq!(std::fs::read_to_string(output_dir.path().join("content/README.md")).unwrap(), "User-owned README\n");
  for output in typed.overview_outputs() {
    let bytes = std::fs::read(output_dir.path().join(&output.repo_path)).unwrap();
    myoxus_application::git_sync::overview::verify_git_overview_bytes(&bytes, &output.content_hash).unwrap();
  }
  let folder_output = typed.folders.iter().find(|folder| folder.organizer_id == "export-folder").unwrap().overview.as_ref().expect("folder README");
  let folder_readme = std::fs::read_to_string(output_dir.path().join(&folder_output.repo_path)).unwrap();
  assert!(folder_readme.contains("[Current](current.md)"), "register must target actual native output");
  assert!(std::fs::read_to_string(output_dir.path().join(&root.repo_path)).unwrap().contains("## Folders"));
  let current_manifest = manifest["documents"]
    .as_array()
    .expect("manifest documents")
    .iter()
    .find(|document| document["docId"] == current_doc_id.to_string())
    .expect("current manifest document");
  assert_eq!(current_manifest["organizerEntryId"], "export-entry");
  assert_eq!(
    current_manifest["organizerFolderIds"],
    serde_json::json!(["export-folder"])
  );
  assert_eq!(current_manifest["repoPath"], current_path);
  let empty_manifest = manifest["documents"]
    .as_array()
    .expect("manifest documents")
    .iter()
    .find(|document| document["docId"] == empty_doc_id.to_string())
    .expect("empty manifest document");
  assert_eq!(empty_manifest["repoPath"], empty_path);
  assert_eq!(empty_manifest["contentHash"], content_hash(""));

  let second_output_dir = tempfile::tempdir().expect("repeat output directory");
  std::fs::create_dir(second_output_dir.path().join("content")).unwrap();
  std::fs::write(second_output_dir.path().join("content/README.md"), "User-owned README\n").unwrap();
  let repeat = support::cli_command()
    .env("MYOXUS__DATABASE__URL", database_url())
    .env("MYOXUS__STORAGE__ROOT", storage_dir.path())
    .arg("--json")
    .arg("export-docs")
    .arg("--workspace")
    .arg(workspace_id.to_string())
    .arg("--output")
    .arg(second_output_dir.path())
    .output()
    .expect("repeat export-docs");
  assert!(
    !repeat.status.success(),
    "the same unreadable document must remain the only repeat-export failure"
  );
  assert_eq!(
    std::fs::read(output_dir.path().join(&asset_path)).unwrap(),
    std::fs::read(second_output_dir.path().join(&asset_path)).expect("repeat portable asset")
  );
  let repeat_result: Value = serde_json::from_slice(&repeat.stdout).expect("repeat stdout JSON");
  assert_eq!(repeat_result["failed"].as_array().expect("repeat failures").len(), 1);
  for output in typed.overview_outputs() {
    assert_eq!(std::fs::read(output_dir.path().join(&output.repo_path)).unwrap(),
      std::fs::read(second_output_dir.path().join(&output.repo_path)).unwrap());
  }
  for relative_path in [
    current_path,
    imported_path,
    list_path,
    native_path,
    empty_path,
    ".myoxus/git-sync-manifest.json",
  ] {
    assert_eq!(
      std::fs::read(output_dir.path().join(relative_path)).expect("first export bytes"),
      std::fs::read(second_output_dir.path().join(relative_path)).expect("repeat export bytes"),
      "unchanged CLI exports must be byte-identical for {relative_path}"
    );
  }

  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(omitted_doc_id)
    .execute(&pool)
    .await
    .expect("remove intentionally corrupt Git-export fixture before vault export");
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(list_doc_id)
    .execute(&pool)
    .await
    .expect("remove Git fixture whose deliberately absent local image must fail a vault export");
  sqlx::query("DELETE FROM docs WHERE id = $1")
    .bind(imported_doc_id)
    .execute(&pool)
    .await
    .expect("remove imported breadth fixture with the same deliberately absent local image");

  let current_tag_id = Uuid::new_v4();
  sqlx::query("UPDATE docs SET meta = $1 WHERE workspace_id = $2 AND id = $3")
    .bind(serde_json::json!({
      "obsidian": {
        "properties": {
          "documentNumber": "stale-number",
          "tags": ["stale-tag"]
        }
      }
    }))
    .bind(workspace_id)
    .bind(current_doc_id)
    .execute(&pool)
    .await
    .expect("seed stale imported metadata provenance");
  sqlx::query(
    "INSERT INTO workspace_tags
       (id, workspace_id, name, slug, color_role, created_by, updated_by)
     VALUES ($1, $2, 'Current tag', 'current-tag', 'tag.blue', $3, $3)",
  )
  .bind(current_tag_id)
  .bind(workspace_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("current workspace tag");
  sqlx::query(
    "INSERT INTO workspace_tag_document_assignments
       (workspace_id, doc_id, tag_id, position, created_by)
     VALUES ($1, $2, $3, 0, $4)",
  )
  .bind(workspace_id)
  .bind(current_doc_id)
  .bind(current_tag_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("current document tag assignment");

  sqlx::query("INSERT INTO users (id, email, name, email_verified_at) VALUES ($1, $2, 'External export', now())")
    .bind(external_user_id)
    .bind(format!("external-export-{external_user_id}@test.local"))
    .execute(&pool)
    .await
    .expect("external export user");
  sqlx::query(
    "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, 'External', 'Accepted', now(), now())",
  )
  .bind(workspace_id)
  .bind(external_user_id)
  .execute(&pool)
  .await
  .expect("external workspace membership");
  let denied_vault_dir = tempfile::tempdir().expect("external vault directory");
  let denied_vault_path = denied_vault_dir.path().join("denied.obsidian.zip");
  let denied_export = support::cli_command()
    .env("MYOXUS__DATABASE__URL", database_url())
    .env("MYOXUS__STORAGE__BACKEND", "local")
    .env("MYOXUS__STORAGE__ROOT", storage_dir.path())
    .arg("export-docs")
    .arg("--workspace")
    .arg(workspace_id.to_string())
    .arg("--format")
    .arg("obsidian")
    .arg("--actor-id")
    .arg(external_user_id.to_string())
    .arg("--output")
    .arg(&denied_vault_path)
    .output()
    .expect("run denied Obsidian vault export");
  assert!(
    !denied_export.status.success(),
    "External must not export a workspace vault"
  );

  let oversized_blob_key = format!("oversized-export-{workspace_id}");
  sqlx::query(
    "INSERT INTO blobs (workspace_id, key, size, mime, status)
     VALUES ($1, $2, $3, 'application/octet-stream', 'completed')",
  )
  .bind(workspace_id)
  .bind(&oversized_blob_key)
  .bind(512_i64 * 1024 * 1024 + 1)
  .execute(&pool)
  .await
  .expect("oversized metadata-only blob");
  let oversized_vault_dir = tempfile::tempdir().expect("oversized vault directory");
  let oversized_vault_path = oversized_vault_dir.path().join("oversized.obsidian.zip");
  let oversized_export = support::cli_command()
    .env("MYOXUS__DATABASE__URL", database_url())
    .env("MYOXUS__STORAGE__BACKEND", "local")
    .env("MYOXUS__STORAGE__ROOT", storage_dir.path())
    .arg("export-docs")
    .arg("--workspace")
    .arg(workspace_id.to_string())
    .arg("--format")
    .arg("obsidian")
    .arg("--actor-id")
    .arg(user_id.to_string())
    .arg("--output")
    .arg(&oversized_vault_path)
    .output()
    .expect("run oversized Obsidian vault export");
  assert!(
    !oversized_export.status.success()
      && String::from_utf8_lossy(&oversized_export.stderr).contains("uncompressed limit"),
    "blob metadata must reject the export before the absent body is read: {}",
    String::from_utf8_lossy(&oversized_export.stderr)
  );
  sqlx::query("DELETE FROM blobs WHERE workspace_id = $1 AND key = $2")
    .bind(workspace_id)
    .bind(&oversized_blob_key)
    .execute(&pool)
    .await
    .expect("remove oversized metadata-only blob");

  let vault_dir = tempfile::tempdir().expect("vault export directory");
  let vault_path = vault_dir.path().join("workspace.obsidian.zip");
  let vault_export = support::cli_command()
    .env("MYOXUS__DATABASE__URL", database_url())
    .env("MYOXUS__STORAGE__BACKEND", "local")
    .env("MYOXUS__STORAGE__ROOT", storage_dir.path())
    .arg("--json")
    .arg("export-docs")
    .arg("--workspace")
    .arg(workspace_id.to_string())
    .arg("--format")
    .arg("obsidian")
    .arg("--actor-id")
    .arg(user_id.to_string())
    .arg("--output")
    .arg(&vault_path)
    .output()
    .expect("run Obsidian vault export");
  assert!(
    vault_export.status.success(),
    "Obsidian vault export failed: {}\n{}",
    String::from_utf8_lossy(&vault_export.stdout),
    String::from_utf8_lossy(&vault_export.stderr)
  );
  let vault_result: Value =
    serde_json::from_slice(&vault_export.stdout).expect("vault export stdout is exactly one JSON document");
  assert_eq!(vault_result["workspaceId"], workspace_id.to_string());
  assert_eq!(vault_result["output"], vault_path.to_string_lossy().as_ref());
  let vault_bytes = std::fs::read(&vault_path).expect("vault ZIP");
  let vault_index = myoxus_workspace_import::inspect_zip_bytes(
    &vault_bytes,
    myoxus_workspace_import::ArchiveLimits {
      max_entries: 10_000,
      max_entry_bytes: 512 * 1024 * 1024,
      max_expanded_bytes: 512 * 1024 * 1024,
      max_compression_ratio: 1_000,
      max_path_bytes: 1_024,
    },
  )
  .expect("inspect CLI vault ZIP");
  let vault_entries = vault_index.entry_names();
  assert!(vault_entries.iter().any(|path| path == "myoxus-export-report.json"));
  assert!(
    vault_entries.iter().any(|path| path.ends_with("/Current.md")),
    "server-owned projection must emit current Markdown: {vault_entries:?}"
  );
  let current_vault_path = vault_entries
    .iter()
    .find(|path| path.ends_with("/Current.md"))
    .expect("current document vault path");
  let decoded_vault = myoxus_workspace_import::WorkspaceDecoder::new(Default::default())
    .decode_path_as(
      &vault_path,
      Some(myoxus_workspace_import::WorkspaceImportFormat::ObsidianZip),
    )
    .expect("decode exported vault through the import boundary");
  let current_vault_markdown = decoded_vault
    .documents
    .iter()
    .find(|document| document.source_id == current_vault_path.as_str())
    .and_then(|document| match &document.content {
      myoxus_workspace_import::DecodedDocumentContent::MarkdownUtf8(bytes) => {
        Some(std::str::from_utf8(bytes).expect("exported Markdown must be UTF-8"))
      }
      _ => None,
    })
    .expect("read current vault document");
  assert!(current_vault_markdown.contains("tags:\n- Current tag"));
  assert!(!current_vault_markdown.contains("stale-tag"));
  assert!(!current_vault_markdown.contains("stale-number"));

  sqlx::query(
    "DELETE FROM workspace_tag_document_assignments
     WHERE workspace_id = $1 AND doc_id = $2",
  )
  .bind(workspace_id)
  .bind(current_doc_id)
  .execute(&pool)
  .await
  .expect("clear current document tags");
  let cleared_vault_path = vault_dir.path().join("workspace-cleared.obsidian.zip");
  let cleared_export = support::cli_command()
    .env("MYOXUS__DATABASE__URL", database_url())
    .env("MYOXUS__STORAGE__BACKEND", "local")
    .env("MYOXUS__STORAGE__ROOT", storage_dir.path())
    .arg("export-docs")
    .arg("--workspace")
    .arg(workspace_id.to_string())
    .arg("--format")
    .arg("obsidian")
    .arg("--actor-id")
    .arg(user_id.to_string())
    .arg("--output")
    .arg(&cleared_vault_path)
    .output()
    .expect("run cleared-tag Obsidian vault export");
  assert!(
    cleared_export.status.success(),
    "cleared-tag vault export failed: {}",
    String::from_utf8_lossy(&cleared_export.stderr)
  );
  let decoded_cleared_vault = myoxus_workspace_import::WorkspaceDecoder::new(Default::default())
    .decode_path_as(
      &cleared_vault_path,
      Some(myoxus_workspace_import::WorkspaceImportFormat::ObsidianZip),
    )
    .expect("decode cleared-tag vault through the import boundary");
  let cleared_markdown = decoded_cleared_vault
    .documents
    .iter()
    .find(|document| document.source_id == current_vault_path.as_str())
    .and_then(|document| match &document.content {
      myoxus_workspace_import::DecodedDocumentContent::MarkdownUtf8(bytes) => {
        Some(std::str::from_utf8(bytes).expect("exported Markdown must be UTF-8"))
      }
      _ => None,
    })
    .expect("read cleared-tag current document");
  assert!(!cleared_markdown.contains("tags:"));
  assert!(!cleared_markdown.contains("stale-tag"));

  }).await;
  for cleanup_workspace in [workspace_id, reimport_workspace] {
    sqlx::query("DELETE FROM blobs WHERE workspace_id=$1")
      .bind(cleanup_workspace)
      .execute(&pool)
      .await
      .expect("cleanup export fixture blobs");
    sqlx::query("DELETE FROM workspace_storage_stats WHERE workspace_id=$1")
      .bind(cleanup_workspace)
      .execute(&pool)
      .await
      .expect("cleanup export fixture accounting");
    sqlx::query("DELETE FROM workspaces WHERE id = $1")
      .bind(cleanup_workspace)
      .execute(&pool)
      .await
      .expect("delete export workspace");
  }
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(external_user_id)
    .execute(&pool)
    .await
    .expect("delete external export user");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("delete export user");
  journey.expect("compiled current-state export journey");
}
