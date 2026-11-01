// SPDX-License-Identifier: AGPL-3.0-or-later
//! P6 integration tests — PDF export GraphQL API and download handler.
//!
//! Invariants checked:
//! - PDFEXP-01: export_pdf requires authentication.
//! - PDFEXP-02: export_pdf rejects non-members (no workspace Read permission).
//! - PDFEXP-03: authorized user gets a queued job row in the DB.
//! - PDFEXP-04: second identical request within 60 s returns the same job (idempotency).
//! - PDFEXP-05: pdf_export_job query returns the job for the owner.
//! - PDFEXP-06: download handler returns 202 while the job is queued.
//! - PDFEXP-07: download handler requires authentication.
//! - PDFEXP-08: download handler returns 403 for non-member.
//! - PDFEXP-09: per-workspace concurrency cap rejects with class=Throttled
//!   and does not create an additional job row.
//! - PDFEXP-10: when `pdf_export.sync_threshold_blocks > 0` and the document
//!   fits, the mutation renders inline and returns status=`done` with a
//!   downloadUrl on the first round-trip; the row carries `sync_or_async='sync'`
//!   and an `output_blob_id`.
//! - PDFEXP-11: when `sync_threshold_blocks > 0` but the document exceeds the
//!   threshold, the mutation falls through to the async path (status=`queued`,
//!   `sync_or_async='async'`, no `output_blob_id`).
//! - PDFEXP-12: a finished job served via `GET /api/pdf-export/{id}/download`
//!   returns 200 with `Content-Type: application/pdf`, an `attachment`
//!   `Content-Disposition` filename, `Cache-Control: no-store`, and a body
//!   that starts with the PDF magic header (`%PDF-`).
//! - PDFEXP-13: a sync-rendered job exposes a non-null `pageCount` on the
//!   GraphQL response and the polled query, and the underlying DB row has the
//!   same value populated. Queued/running rows must report `pageCount == null`.
//! - PDFEXP-14: idempotency is *per user* — two members of the same workspace
//!   firing the same `exportPdf` within 60 s must each get their own
//!   job row (different IDs, both with `requested_by` set to themselves).
//!   Closes PDFREV-SEC-01: without this scope, member B would download the
//!   blob rendered for member A.
//! - PDFEXP-15: `startedAt` exposes the worker-pickup timestamp on the wire.
//!   PDFREV-API-03 — the column existed in `pdf_export_jobs` but was never
//!   surfaced via GraphQL. A queued (async) job must report `startedAt:
//!   null`; a sync-rendered (status=`done`) job must report a non-null
//!   `startedAt` whose value matches the DB row.
//! - PDFEXP-16: PDFREV-API-04 — `GET /api/pdf-export/{id}/download` for a
//!   failed job must respond `410 Gone` (not `404`), surface the stable
//!   `error_class` via `X-Pdf-Export-Error-Class` header, and serve a
//!   JSON body `{"error_class": "...", "message": "..."}` so clients can
//!   branch on the failure category without a GraphQL round-trip.
//! - PDFEXP-17: global theme-font diagnostics —
//!   `pdf_export_jobs.unmapped_font_families`
//!   surfaces end-to-end on the `PdfExportJobType.unmappedFontFamilies`
//!   GraphQL field. A fresh sync render with global-theme defaults produces
//!   an empty array. When the column is seeded with a non-empty JSONB array
//!   (mirroring what the renderer writes for an unmapped role), the poll
//!   query must echo it back verbatim.
//! - PDFEXP-17b: the effective global branding profile is resolved into the
//!   canonical `render_inputs.theme_fonts` object before sync rendering when
//!   no workspace branding profile exists. The exported payload must contain
//!   role names (`heading`, `body`, `mono`, `symbol`) and must not resurrect an
//!   old body-font dispatch key.
//! - PDFEXP-17c: workspace branding profiles override global theme fonts for
//!   PDF rendering and are materialised into the same `render_inputs.theme_fonts`
//!   contract.
//! - PDFEXP-18: queued PDF export cancellation is user-scoped. The original
//!   requester can cancel their own queued job, admins retain operational
//!   cancel authority, and unrelated authenticated users receive `false`
//!   without mutating the row.
//! - PDFEXP-19: documentPdfExportHistory accepts the same client doc IDs as
//!   exportPdf. A compact/nanoid doc ID must resolve through the canonical
//!   doc-id parser and return existing export rows instead of `invalid doc_id`.
//! - PDFEXP-20: the user-facing PDF-export SSE endpoint emits the current
//!   job state immediately and then changed states in order
//!   `queued -> rendering -> done`, including the terminal download URL.
//! - PDFEXP-21: the admin diagnostics query accepts one input-object filter
//!   and applies status/workspace/user predicates without loose root args.
//! - PDFEXP-22: a long real-text document derived from the PDF architecture
//!   docs renders through the sync GraphQL path into a multi-page downloadable
//!   PDF, while keeping the canonical `theme_fonts` render contract.
//! - PDFEXP-24: long rich documents export once for each document color policy
//!   (`theme_palette`, `plain`, `custom`) and prove tables, code, links,
//!   glyphs, document logo/footer, render audit and Recent Exports history.
//! - PDFEXP-23: Edgeless snapshot export resolves the uploaded workspace blob
//!   and embeds a real image XObject instead of rendering the missing-canvas
//!   placeholder.

use crate::helpers;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::Row;
use std::{path::Path, sync::Arc};
use tower::ServiceExt;
use uuid::Uuid;
use yrs::{Any, Array, Doc, Map, ReadTxn, Text, Transact};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn pdf_theme_config_guard() -> tokio::sync::MutexGuard<'static, ()> {
  helpers::THEME_BRANDING_LOCK
    .get_or_init(|| tokio::sync::Mutex::new(()))
    .lock()
    .await
}

fn assert_render_inputs_have_pinned_theme_assets(render_inputs: &Value, invariant: &str) {
  let assets = render_inputs
    .get("theme_font_assets")
    .and_then(Value::as_object)
    .unwrap_or_else(|| panic!("{invariant}: render_inputs.theme_font_assets must be an object: {render_inputs}"));

  for role in ["heading", "body", "mono", "symbol"] {
    let asset = assets
      .get(role)
      .and_then(Value::as_object)
      .unwrap_or_else(|| panic!("{invariant}: theme_font_assets.{role} must be an object: {render_inputs}"));
    for field in ["family", "familySlug", "assetKey", "sha256", "format"] {
      assert!(
        asset
          .get(field)
          .and_then(Value::as_str)
          .is_some_and(|value| !value.is_empty()),
        "{invariant}: theme_font_assets.{role}.{field} must be a non-empty string: {render_inputs}"
      );
    }
    let sha = asset.get("sha256").and_then(Value::as_str).unwrap_or_default();
    assert_eq!(
      sha.len(),
      64,
      "{invariant}: theme_font_assets.{role}.sha256 must be a hex SHA-256 digest: {render_inputs}"
    );
  }
}

async fn cleanup_pdf_export_jobs(pool: &sqlx::PgPool, workspace_id: Uuid) {
  let output_blob_ids: Vec<Uuid> = sqlx::query_scalar(
    "SELECT output_blob_id FROM pdf_export_jobs WHERE workspace_id = $1 AND output_blob_id IS NOT NULL",
  )
  .bind(workspace_id)
  .fetch_all(pool)
  .await
  .expect("query owned PDF output blobs for cleanup");
  for blob_id in output_blob_ids {
    let result = std::fs::remove_file(
      Path::new("./test-storage").join(myoxus_worker::pdf_export_storage_key(workspace_id, blob_id)),
    );
    if let Err(error) = result {
      assert_eq!(
        error.kind(),
        std::io::ErrorKind::NotFound,
        "remove owned PDF artifact: {error}"
      );
    }
  }
  sqlx::query("DELETE FROM pdf_export_jobs WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean owned PDF test records");
  sqlx::query("DELETE FROM pdf_export_render_audit WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean owned PDF test records");
  sqlx::query("DELETE FROM document_brand_profiles WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean owned PDF test records");
  sqlx::query("DELETE FROM brand_assets WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean owned PDF test records");
  sqlx::query("DELETE FROM blobs WHERE workspace_id = $1 AND key LIKE 'pdf-export/%'")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean owned PDF test records");
  sqlx::query("DELETE FROM doc_snapshots WHERE workspace_id = $1")
    .bind(workspace_id)
    .execute(pool)
    .await
    .expect("clean owned PDF test records");
  for namespace in ["pdf-brand", "pdf-export"] {
    if let Err(error) = std::fs::remove_dir_all(
      Path::new("./test-storage")
        .join(namespace)
        .join(workspace_id.to_string()),
    ) {
      assert_eq!(
        error.kind(),
        std::io::ErrorKind::NotFound,
        "remove owned PDF directory: {error}"
      );
    }
  }
}

async fn cleanup_workspace_blob(pool: &sqlx::PgPool, workspace_id: Uuid, key: &str) {
  sqlx::query("DELETE FROM blobs WHERE workspace_id = $1 AND key = $2")
    .bind(workspace_id)
    .bind(key)
    .execute(pool)
    .await
    .ok();
  let _ = std::fs::remove_file(Path::new("./test-storage").join(workspace_id.to_string()).join(key));
}

async fn set_pdf_export_global_theme(pool: &sqlx::PgPool, theme_slug: &str) {
  myoxus_infrastructure::branding::set_theme_profile(pool, None, theme_slug, "system", None)
    .await
    .unwrap_or_else(|err| panic!("set global PDF theme `{theme_slug}`: {err}"));
}

async fn set_pdf_export_workspace_theme(pool: &sqlx::PgPool, workspace_id: Uuid, theme_slug: &str) {
  myoxus_infrastructure::branding::set_theme_profile(pool, Some(workspace_id), theme_slug, "system", None)
    .await
    .unwrap_or_else(|err| panic!("set workspace PDF theme `{theme_slug}`: {err}"));
}

async fn clear_pdf_export_theme_config(pool: &sqlx::PgPool, workspace_id: Option<Uuid>) {
  if let Some(workspace_id) = workspace_id {
    sqlx::query("DELETE FROM theme_profiles WHERE scope = 'workspace' AND workspace_id = $1")
      .bind(workspace_id)
      .execute(pool)
      .await
      .ok();
  }
  set_pdf_export_global_theme(pool, "stuttgart").await;
}

fn build_pdf_doc_yjs(paragraphs: usize) -> Vec<u8> {
  let text = (0..paragraphs)
    .map(|i| format!("PDF export regression paragraph {i}: server rendered text must survive Yjs to Typst."))
    .collect::<Vec<_>>();
  build_pdf_doc_yjs_from_paragraphs("PDF Export Test", &text)
}

/// Build a Yjs v1 update binary with a `myoxus:page` root block and real
/// paragraph text. Empty paragraph-only fixtures once missed content-level PDF
/// regressions, so new E2E paths use this helper to exercise Y.Text decoding.
fn build_pdf_doc_yjs_from_paragraphs(title: &str, paragraphs: &[String]) -> Vec<u8> {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();

  blocks.insert(&mut txn, "page-1", yrs::MapPrelim::default());
  let page_map = match blocks.get(&txn, "page-1") {
    Some(yrs::Out::YMap(m)) => m,
    _ => panic!("page-1 missing"),
  };
  page_map.insert(&mut txn, "sys:flavour", "myoxus:page");
  page_map.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  page_map.insert(&mut txn, "prop:title", yrs::TextPrelim::new(title));
  let children = match page_map.get(&txn, "sys:children") {
    Some(yrs::Out::YArray(a)) => a,
    _ => panic!("sys:children missing"),
  };

  for (i, paragraph) in paragraphs.iter().enumerate() {
    let id = format!("p-{i}");
    children.push_back(&mut txn, Any::String(id.clone().into()));
    blocks.insert(&mut txn, id.as_str(), yrs::MapPrelim::default());
    let bmap = match blocks.get(&txn, id.as_str()) {
      Some(yrs::Out::YMap(m)) => m,
      _ => panic!("paragraph {id} missing"),
    };
    bmap.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
    bmap.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
    bmap.insert(&mut txn, "prop:text", yrs::TextPrelim::new(paragraph.as_str()));
  }

  drop(txn);
  doc.transact().encode_state_as_update_v1(&yrs::StateVector::default())
}

fn build_rich_pdf_doc_yjs(title: &str, paragraphs: &[String]) -> Vec<u8> {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();

  blocks.insert(&mut txn, "page-1", yrs::MapPrelim::default());
  let page_map = match blocks.get(&txn, "page-1") {
    Some(yrs::Out::YMap(m)) => m,
    _ => panic!("page-1 missing"),
  };
  page_map.insert(&mut txn, "sys:flavour", "myoxus:page");
  page_map.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  page_map.insert(&mut txn, "prop:title", yrs::TextPrelim::new(title));
  let children = match page_map.get(&txn, "sys:children") {
    Some(yrs::Out::YArray(a)) => a,
    _ => panic!("sys:children missing"),
  };

  children.push_back(&mut txn, Any::String("heading-main".into()));
  blocks.insert(&mut txn, "heading-main", yrs::MapPrelim::default());
  let heading = match blocks.get(&txn, "heading-main") {
    Some(yrs::Out::YMap(m)) => m,
    _ => panic!("heading-main missing"),
  };
  heading.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
  heading.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  heading.insert(&mut txn, "prop:type", "h1");
  heading.insert(&mut txn, "prop:text", yrs::TextPrelim::new(title));

  children.push_back(&mut txn, Any::String("glyphs".into()));
  blocks.insert(&mut txn, "glyphs", yrs::MapPrelim::default());
  let glyphs = match blocks.get(&txn, "glyphs") {
    Some(yrs::Out::YMap(m)) => m,
    _ => panic!("glyphs missing"),
  };
  glyphs.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
  glyphs.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  glyphs.insert(
    &mut txn,
    "prop:text",
    yrs::TextPrelim::new("Sonderzeichen äöü ÄÖÜ ß € ✓ Tabellen-Gate und Glyphen-Gate."),
  );

  children.push_back(&mut txn, Any::String("link-mark".into()));
  blocks.insert(&mut txn, "link-mark", yrs::MapPrelim::default());
  let link = match blocks.get(&txn, "link-mark") {
    Some(yrs::Out::YMap(m)) => m,
    _ => panic!("link-mark missing"),
  };
  link.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
  link.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  let link_text = "Link target https://example.org/pdf-export and inline code token pdf_export_jobs.";
  let link_ref = link.insert(&mut txn, "prop:text", yrs::TextPrelim::new(link_text));
  let url = "https://example.org/pdf-export";
  let link_start = link_text.find(url).expect("url offset") as u32;
  link_ref.format(
    &mut txn,
    link_start,
    url.len() as u32,
    yrs::types::Attrs::from([(Arc::from("link"), Any::String(url.into()))]),
  );
  let code_token = "pdf_export_jobs";
  let code_start = link_text.find(code_token).expect("code offset") as u32;
  link_ref.format(
    &mut txn,
    code_start,
    code_token.len() as u32,
    yrs::types::Attrs::from([(Arc::from("code"), Any::Bool(true))]),
  );

  children.push_back(&mut txn, Any::String("tbl".into()));
  blocks.insert(&mut txn, "tbl", yrs::MapPrelim::default());
  let table = match blocks.get(&txn, "tbl") {
    Some(yrs::Out::YMap(m)) => m,
    _ => panic!("tbl missing"),
  };
  table.insert(&mut txn, "sys:flavour", "myoxus:table");
  table.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  let table_children = match table.get(&txn, "sys:children") {
    Some(yrs::Out::YArray(a)) => a,
    _ => panic!("table children missing"),
  };
  table_children.push_back(&mut txn, Any::String("row-h".into()));
  table_children.push_back(&mut txn, Any::String("row-b".into()));

  for (row_id, is_header, cells) in [
    (
      "row-h",
      true,
      [("cell-h-1", "Metrik"), ("cell-h-2", "Wert"), ("cell-h-3", "Status")],
    ),
    (
      "row-b",
      false,
      [
        ("cell-b-1", "Tabellen-Gate"),
        ("cell-b-2", "42"),
        ("cell-b-3", "✓ stabil"),
      ],
    ),
  ] {
    blocks.insert(&mut txn, row_id, yrs::MapPrelim::default());
    let row = match blocks.get(&txn, row_id) {
      Some(yrs::Out::YMap(m)) => m,
      _ => panic!("table row missing"),
    };
    row.insert(&mut txn, "sys:flavour", "myoxus:table-row");
    if is_header {
      row.insert(&mut txn, "prop:type", "tableHeaderRow");
    }
    row.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
    let row_children = match row.get(&txn, "sys:children") {
      Some(yrs::Out::YArray(a)) => a,
      _ => panic!("row children missing"),
    };
    for (cell_id, text) in cells {
      row_children.push_back(&mut txn, Any::String(cell_id.into()));
      blocks.insert(&mut txn, cell_id, yrs::MapPrelim::default());
      let cell = match blocks.get(&txn, cell_id) {
        Some(yrs::Out::YMap(m)) => m,
        _ => panic!("table cell missing"),
      };
      cell.insert(&mut txn, "sys:flavour", "myoxus:table-cell");
      cell.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
      cell.insert(&mut txn, "prop:text", yrs::TextPrelim::new(text));
    }
  }

  children.push_back(&mut txn, Any::String("code-block".into()));
  blocks.insert(&mut txn, "code-block", yrs::MapPrelim::default());
  let code = match blocks.get(&txn, "code-block") {
    Some(yrs::Out::YMap(m)) => m,
    _ => panic!("code-block missing"),
  };
  code.insert(&mut txn, "sys:flavour", "myoxus:code");
  code.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  code.insert(&mut txn, "prop:language", "rust");
  code.insert(
    &mut txn,
    "prop:text",
    yrs::TextPrelim::new("fn main() { println!(\"pdf export gate\"); }"),
  );

  for (i, paragraph) in paragraphs.iter().enumerate() {
    let id = format!("rich-p-{i}");
    children.push_back(&mut txn, Any::String(id.clone().into()));
    blocks.insert(&mut txn, id.as_str(), yrs::MapPrelim::default());
    let bmap = match blocks.get(&txn, id.as_str()) {
      Some(yrs::Out::YMap(m)) => m,
      _ => panic!("paragraph missing"),
    };
    bmap.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
    bmap.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
    bmap.insert(&mut txn, "prop:text", yrs::TextPrelim::new(paragraph.as_str()));
  }

  drop(txn);
  doc.transact().encode_state_as_update_v1(&yrs::StateVector::default())
}

fn build_edgeless_pdf_doc_yjs(snapshot_blob_id: &str, width_px: u32, height_px: u32) -> Vec<u8> {
  let doc = Doc::new();
  let blocks = doc.get_or_insert_map("blocks");
  let mut txn = doc.transact_mut();

  blocks.insert(&mut txn, "page-1", yrs::MapPrelim::default());
  let page_map = match blocks.get(&txn, "page-1") {
    Some(yrs::Out::YMap(m)) => m,
    _ => panic!("page-1 missing"),
  };
  page_map.insert(&mut txn, "sys:flavour", "myoxus:page");
  page_map.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  page_map.insert(&mut txn, "prop:title", yrs::TextPrelim::new("Edgeless PDF Export"));
  let children = match page_map.get(&txn, "sys:children") {
    Some(yrs::Out::YArray(a)) => a,
    _ => panic!("sys:children missing"),
  };

  children.push_back(&mut txn, Any::String("p-0".into()));
  blocks.insert(&mut txn, "p-0", yrs::MapPrelim::default());
  let paragraph = match blocks.get(&txn, "p-0") {
    Some(yrs::Out::YMap(m)) => m,
    _ => panic!("p-0 missing"),
  };
  paragraph.insert(&mut txn, "sys:flavour", "myoxus:paragraph");
  paragraph.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  paragraph.insert(
    &mut txn,
    "prop:text",
    yrs::TextPrelim::new("Edgeless canvas export must embed the uploaded raster snapshot."),
  );

  children.push_back(&mut txn, Any::String("surface-1".into()));
  blocks.insert(&mut txn, "surface-1", yrs::MapPrelim::default());
  let surface = match blocks.get(&txn, "surface-1") {
    Some(yrs::Out::YMap(m)) => m,
    _ => panic!("surface-1 missing"),
  };
  surface.insert(&mut txn, "sys:flavour", "myoxus:surface");
  surface.insert(&mut txn, "sys:children", yrs::ArrayPrelim::default());
  surface.insert(&mut txn, "prop:exportSnapshotBlobId", snapshot_blob_id);
  surface.insert(&mut txn, "prop:exportSnapshotWidth", width_px as i64);
  surface.insert(&mut txn, "prop:exportSnapshotHeight", height_px as i64);

  drop(txn);
  doc.transact().encode_state_as_update_v1(&yrs::StateVector::default())
}

async fn upload_workspace_blob_via_graphql(
  app: &axum::Router,
  session_id: Uuid,
  workspace_id: Uuid,
  filename: &str,
  content_type: &str,
  content: &[u8],
) -> String {
  let boundary = format!("X-MYOXUS-PDF-BOUNDARY-{}", Uuid::new_v4().simple());
  let operations = json!({
    "query": "mutation SetBlob($workspaceId: String!, $blob: Upload!) { setBlob(workspaceId: $workspaceId, blob: $blob) }",
    "variables": {
      "workspaceId": workspace_id.to_string(),
      "blob": null
    }
  })
  .to_string();
  let map = json!({ "0": ["variables.blob"] }).to_string();

  let mut body = Vec::new();
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"operations\"\r\n\r\n");
  body.extend_from_slice(operations.as_bytes());
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"map\"\r\n\r\n");
  body.extend_from_slice(map.as_bytes());
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(format!("Content-Disposition: form-data; name=\"0\"; filename=\"{filename}\"\r\n").as_bytes());
  body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
  body.extend_from_slice(content);
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(body))
        .expect("multipart request"),
    )
    .await
    .expect("multipart response");
  let bytes = response.into_body().collect().await.expect("multipart body").to_bytes();
  let value: Value = serde_json::from_slice(&bytes).expect("multipart json");
  assert!(value.get("errors").is_none(), "setBlob upload failed: {value}");
  value["data"]["setBlob"]
    .as_str()
    .unwrap_or_else(|| panic!("setBlob must return blob key: {value}"))
    .to_string()
}

async fn upload_document_brand_logo_via_graphql(
  app: &axum::Router,
  session_id: Uuid,
  workspace_id: Uuid,
  kind: &str,
  filename: &str,
  content_type: &str,
  content: &[u8],
) -> Value {
  let boundary = "X-BOUNDARY-PDF-EXP-BRAND-UPLOAD";
  let operations = json!({
    "query": "mutation Up($ws: ID!, $kind: BrandLogoKind!, $file: Upload!) { \
      admin { \
        uploadDocumentBrandLogo(workspaceId: $ws, kind: $kind, file: $file) { \
          workspaceId logoLargeBlob logoSmallBlob \
        } \
      } \
    }",
    "variables": {
      "ws": workspace_id.to_string(),
      "kind": kind,
      "file": null
    }
  })
  .to_string();
  let map = json!({ "0": ["variables.file"] }).to_string();

  let mut body = Vec::new();
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"operations\"\r\n\r\n");
  body.extend_from_slice(operations.as_bytes());
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(b"Content-Disposition: form-data; name=\"map\"\r\n\r\n");
  body.extend_from_slice(map.as_bytes());
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
  body.extend_from_slice(format!("Content-Disposition: form-data; name=\"0\"; filename=\"{filename}\"\r\n").as_bytes());
  body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
  body.extend_from_slice(content);
  body.extend_from_slice(b"\r\n");
  body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::from(body))
        .expect("multipart request"),
    )
    .await
    .expect("multipart response");
  let bytes = response.into_body().collect().await.expect("multipart body").to_bytes();
  serde_json::from_slice(&bytes).expect("multipart json")
}

fn long_pdf_architecture_doc_paragraphs() -> Vec<String> {
  const SOURCE: &str = include_str!("../../../../../docs/dev/server/pdf-export-v2-architecture.md");
  fn scrub(line: &str) -> String {
    line
      .replace('✅', "[done]")
      .replace('❌', "[open]")
      .replace('⚠', "[warning]")
      .replace('→', "->")
      .replace('—', "-")
      // The architecture document legitimately names the renderer fallback
      // string. The long-doc regression must assert renderer output, not fail
      // because its own fixture text quotes the placeholder contract.
      .replace("[Canvas snapshot not available]", "[canvas snapshot placeholder]")
  }

  let mut base = Vec::new();
  let mut current = String::new();
  let mut in_code = false;
  for line in SOURCE.lines() {
    let trimmed = line.trim();
    if trimmed.starts_with("```") {
      in_code = !in_code;
      continue;
    }
    if trimmed.is_empty() {
      if !current.trim().is_empty() {
        base.push(current.trim().to_owned());
        current.clear();
      }
      continue;
    }
    if !current.is_empty() {
      current.push(' ');
    }
    current.push_str(&scrub(if in_code {
      trimmed.trim_start_matches('#')
    } else {
      trimmed
    }));
  }
  if !current.trim().is_empty() {
    base.push(current.trim().to_owned());
  }
  assert!(
    base.len() >= 40,
    "PDF architecture doc fixture must provide enough paragraphs, got {}",
    base.len()
  );

  let mut paragraphs = Vec::with_capacity(180);
  let mut cycle = 1usize;
  while paragraphs.len() < 180 {
    for (idx, paragraph) in base.iter().enumerate() {
      paragraphs.push(format!("Abschnitt {cycle}.{}: {paragraph}", idx + 1));
      if paragraphs.len() >= 180 {
        break;
      }
    }
    cycle += 1;
  }
  paragraphs
}

async fn insert_doc_snapshot(pool: &sqlx::PgPool, workspace_id: Uuid, doc_id: Uuid, payload: Vec<u8>) {
  sqlx::query(
    "INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence, updated_at) \
     VALUES ($1, $2, $3, 0, now())",
  )
  .bind(doc_id)
  .bind(workspace_id)
  .bind(payload)
  .execute(pool)
  .await
  .expect("insert doc_snapshots");
}

async fn insert_queued_pdf_export_job(
  pool: &sqlx::PgPool,
  workspace_id: Uuid,
  doc_id: Uuid,
  requested_by: Uuid,
) -> Uuid {
  sqlx::query_scalar(
    "INSERT INTO pdf_export_jobs \
       (workspace_id, doc_id, requested_by, template_id, render_inputs, options_hash, status, sync_or_async) \
     VALUES ($1, $2, $3, 'default', '{}', $4, 'queued', 'async') \
     RETURNING id",
  )
  .bind(workspace_id)
  .bind(doc_id)
  .bind(requested_by)
  .bind(format!("queued-cancel-hash-{}", Uuid::new_v4()))
  .fetch_one(pool)
  .await
  .expect("insert queued pdf export job")
}

fn start_export_mutation(workspace_id: Uuid, doc_id: Uuid) -> Value {
  json!({
    "query": r#"
      mutation ExportPdf($input: PdfExportInputV2Input!) {
        exportPdf(input: $input) {
          id workspaceId docId status downloadUrl createdAt
        }
      }
    "#,
    "variables": {
      "input": {
        "workspaceId": workspace_id.to_string(),
        "docId": doc_id.to_string(),
        "templateId": "default",
        "typedInputs": { "title": "PDF Export Test" }
      }
    }
  })
}

fn cancel_export_mutation(job_id: &str) -> Value {
  json!({
    "query": r#"mutation CancelPdfExportJob($jobId: String!) { cancelPdfExportJob(jobId: $jobId) }"#,
    "variables": { "jobId": job_id }
  })
}

fn document_history_query(workspace_id: Uuid, doc_id: &str) -> Value {
  json!({
    "query": r#"
      query DocumentPdfExportHistory($workspaceId: String!, $docId: String!) {
        documentPdfExportHistory(workspaceId: $workspaceId, docId: $docId, limit: 5) {
          id
          docId
          status
          downloadUrl
        }
      }
    "#,
    "variables": { "workspaceId": workspace_id.to_string(), "docId": doc_id }
  })
}

// ---------------------------------------------------------------------------
// PDFEXP-01: export_pdf requires authentication
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_pdfexp01_start_requires_auth() {
  let (app, pool, _auth) = helpers::setup_app().await;
  let user_id = helpers::create_user(&pool, "pdfexp01", false).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .body(Body::from(start_export_mutation(ws_id, doc_id).to_string()))
        .unwrap(),
    )
    .await
    .unwrap();
  let body: Value = serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
  assert!(body.get("errors").is_some(), "expected auth error, got: {body}");

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-02: non-member cannot start export
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_pdfexp02_start_rejects_non_member() {
  let (app, pool, auth) = helpers::setup_app().await;
  let owner_id = helpers::create_user(&pool, "pdfexp02_owner", false).await;
  let intruder_id = helpers::create_user(&pool, "pdfexp02_intruder", false).await;
  let intruder_session = helpers::create_session(&auth, intruder_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  let resp = helpers::gql(&app, intruder_session, start_export_mutation(ws_id, doc_id)).await;
  assert!(
    resp.get("errors").is_some(),
    "expected permission error for non-member, got: {resp}"
  );

  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pdf_export_jobs WHERE workspace_id = $1")
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(count, 0, "no job should be created for non-member");

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id, intruder_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-03: authorized user gets a queued DB row
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_pdfexp03_start_creates_queued_job() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(0).await;
  let owner_id = helpers::create_user(&pool, "pdfexp03", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  let resp = helpers::gql(&app, session_id, start_export_mutation(ws_id, doc_id)).await;
  assert!(resp.get("errors").is_none(), "mutation failed: {resp}");

  let job_id: Uuid = resp["data"]["exportPdf"]["id"]
    .as_str()
    .and_then(|s| s.parse().ok())
    .expect("job id");
  assert_eq!(resp["data"]["exportPdf"]["status"], "queued");

  let row = sqlx::query("SELECT status::TEXT AS status, doc_id, requested_by FROM pdf_export_jobs WHERE id = $1")
    .bind(job_id)
    .fetch_one(&pool)
    .await
    .expect("job row must exist");
  let status: String = row.get("status");
  let stored_doc_id: Uuid = row.get("doc_id");
  let stored_by: Uuid = row.get("requested_by");
  assert_eq!(status, "queued");
  assert_eq!(stored_doc_id, doc_id);
  assert_eq!(stored_by, owner_id);

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-04: second identical request within 60 s returns same job
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_pdfexp04_idempotent_within_60s() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(0).await;
  let owner_id = helpers::create_user(&pool, "pdfexp04", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  let first = helpers::gql(&app, session_id, start_export_mutation(ws_id, doc_id)).await;
  assert!(first.get("errors").is_none(), "first request failed: {first}");
  let first_id = first["data"]["exportPdf"]["id"].as_str().unwrap();

  let second = helpers::gql(&app, session_id, start_export_mutation(ws_id, doc_id)).await;
  assert!(second.get("errors").is_none(), "second request failed: {second}");
  let second_id = second["data"]["exportPdf"]["id"].as_str().unwrap();

  assert_eq!(first_id, second_id, "idempotent: same job must be returned");

  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pdf_export_jobs WHERE workspace_id = $1 AND doc_id = $2")
    .bind(ws_id)
    .bind(doc_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(count, 1, "only one job row must exist (idempotency)");

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-05: pdf_export_job query returns status for job owner
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_pdfexp05_query_returns_job_status() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(0).await;
  let owner_id = helpers::create_user(&pool, "pdfexp05", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  let create_resp = helpers::gql(&app, session_id, start_export_mutation(ws_id, doc_id)).await;
  let job_id = create_resp["data"]["exportPdf"]["id"].as_str().unwrap();

  let query_resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"query PdfExportJob($jobId: String!) { pdfExportJob(jobId: $jobId) { id status workspaceId } }"#,
      "variables": { "jobId": job_id }
    }),
  )
  .await;
  assert!(query_resp.get("errors").is_none(), "query failed: {query_resp}");
  assert_eq!(query_resp["data"]["pdfExportJob"]["id"], job_id);
  assert_eq!(query_resp["data"]["pdfExportJob"]["status"], "queued");
  assert_eq!(query_resp["data"]["pdfExportJob"]["workspaceId"], ws_id.to_string());

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-18: queued export cancellation is requester/admin scoped
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_pdfexp18_requester_can_cancel_queued_job() {
  let (app, pool, auth) = helpers::setup_app().await;
  let owner_id = helpers::create_user(&pool, "pdfexp18_owner", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  let job_id = insert_queued_pdf_export_job(&pool, ws_id, doc_id, owner_id).await;
  let job_id_str = job_id.to_string();

  let cancel_resp = helpers::gql(&app, session_id, cancel_export_mutation(&job_id_str)).await;
  assert!(cancel_resp.get("errors").is_none(), "cancel failed: {cancel_resp}");
  assert_eq!(cancel_resp["data"]["cancelPdfExportJob"], true);

  let (status, error_class, error_detail): (String, Option<String>, Option<String>) =
    sqlx::query_as("SELECT status::TEXT, error_class, error_detail FROM pdf_export_jobs WHERE id = $1")
      .bind(job_id)
      .fetch_one(&pool)
      .await
      .expect("job row");
  assert_eq!(status, "failed");
  assert_eq!(error_class.as_deref(), Some("Cancelled"));
  assert_eq!(error_detail.as_deref(), Some("cancelled by requester"));

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[tokio::test]
async fn inv_pdfexp18_non_owner_cannot_cancel_or_mutate_job() {
  let (app, pool, auth) = helpers::setup_app().await;
  let owner_id = helpers::create_user(&pool, "pdfexp18_owner2", false).await;
  let intruder_id = helpers::create_user(&pool, "pdfexp18_intruder", false).await;
  let intruder_session = helpers::create_session(&auth, intruder_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  let job_id = insert_queued_pdf_export_job(&pool, ws_id, doc_id, owner_id).await;
  let job_id_str = job_id.to_string();

  let cancel_resp = helpers::gql(&app, intruder_session, cancel_export_mutation(&job_id_str)).await;
  assert!(
    cancel_resp.get("errors").is_none(),
    "cancel should not leak via GraphQL error: {cancel_resp}"
  );
  assert_eq!(cancel_resp["data"]["cancelPdfExportJob"], false);

  let status: String = sqlx::query_scalar("SELECT status::TEXT FROM pdf_export_jobs WHERE id = $1")
    .bind(job_id)
    .fetch_one(&pool)
    .await
    .expect("job row");
  assert_eq!(status, "queued", "non-owner cancel must not mutate the job row");

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id, intruder_id]).await;
}

#[tokio::test]
async fn inv_pdfexp18_admin_can_cancel_any_queued_job() {
  let (app, pool, auth) = helpers::setup_app().await;
  let owner_id = helpers::create_user(&pool, "pdfexp18_owner3", false).await;
  let admin_id = helpers::create_user(&pool, "pdfexp18_admin", true).await;
  let admin_session = helpers::create_session(&auth, admin_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  let job_id = insert_queued_pdf_export_job(&pool, ws_id, doc_id, owner_id).await;
  let job_id_str = job_id.to_string();

  let cancel_resp = helpers::gql(&app, admin_session, cancel_export_mutation(&job_id_str)).await;
  assert!(
    cancel_resp.get("errors").is_none(),
    "admin cancel failed: {cancel_resp}"
  );
  assert_eq!(cancel_resp["data"]["cancelPdfExportJob"], true);

  let (status, error_detail): (String, Option<String>) =
    sqlx::query_as("SELECT status::TEXT, error_detail FROM pdf_export_jobs WHERE id = $1")
      .bind(job_id)
      .fetch_one(&pool)
      .await
      .expect("job row");
  assert_eq!(status, "failed");
  assert_eq!(error_detail.as_deref(), Some("cancelled by admin"));

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id, admin_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-06: download returns 202 for a queued job
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_pdfexp06_download_202_while_queued() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(0).await;
  let owner_id = helpers::create_user(&pool, "pdfexp06", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  let create_resp = helpers::gql(&app, session_id, start_export_mutation(ws_id, doc_id)).await;
  let job_id = create_resp["data"]["exportPdf"]["id"].as_str().unwrap();

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/api/pdf-export/{job_id}/download"))
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(resp.status().as_u16(), 202, "expected 202 Accepted for queued job");

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-07: download requires authentication
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_pdfexp07_download_requires_auth() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(0).await;
  let owner_id = helpers::create_user(&pool, "pdfexp07", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  let create_resp = helpers::gql(&app, session_id, start_export_mutation(ws_id, doc_id)).await;
  let job_id = create_resp["data"]["exportPdf"]["id"].as_str().unwrap();

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/api/pdf-export/{job_id}/download"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(resp.status().as_u16(), 401, "expected 401 without session cookie");

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-08: download returns 403 for non-member
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_pdfexp08_download_forbidden_for_non_member() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(0).await;
  let owner_id = helpers::create_user(&pool, "pdfexp08_owner", false).await;
  let owner_session = helpers::create_session(&auth, owner_id).await;
  let intruder_id = helpers::create_user(&pool, "pdfexp08_intruder", false).await;
  let intruder_session = helpers::create_session(&auth, intruder_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  let create_resp = helpers::gql(&app, owner_session, start_export_mutation(ws_id, doc_id)).await;
  let job_id = create_resp["data"]["exportPdf"]["id"].as_str().unwrap();

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/api/pdf-export/{job_id}/download"))
        .header("cookie", format!("affine_session={intruder_session}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(resp.status().as_u16(), 403, "expected 403 for non-member");

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id, intruder_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-09: per-workspace concurrency cap
//
// The default cap is `max_concurrent_per_workspace = 3`. Three distinct docs
// must each succeed (the idempotency window matches on docId, so distinct
// docs bypass it). The fourth distinct doc must fail with class=Throttled
// and must not create a fourth pdf_export_jobs row.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn inv_pdfexp09_concurrency_cap_rejects_fourth_distinct_doc() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(0).await;
  let owner_id = helpers::create_user(&pool, "pdfexp09", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;

  let mut docs: Vec<Uuid> = Vec::with_capacity(4);
  for _ in 0..4 {
    docs.push(helpers::create_doc(&pool, ws_id, owner_id).await);
  }

  // First three docs queue successfully.
  for (i, doc_id) in docs.iter().take(3).enumerate() {
    let resp = helpers::gql(&app, session_id, start_export_mutation(ws_id, *doc_id)).await;
    assert!(
      resp.get("errors").is_none(),
      "doc {i} (under cap) must queue, got: {resp}"
    );
    assert_eq!(resp["data"]["exportPdf"]["status"], "queued");
  }

  // Fourth distinct doc must be rejected with class=Throttled.
  let blocked = helpers::gql(&app, session_id, start_export_mutation(ws_id, docs[3])).await;
  let errors = blocked.get("errors").expect("4th doc must be rejected");
  let class = errors[0]["extensions"]["class"]
    .as_str()
    .expect("error must carry class extension");
  assert_eq!(class, "Throttled", "expected Throttled, got: {blocked}");

  // No fourth job row must exist.
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pdf_export_jobs WHERE workspace_id = $1")
    .bind(ws_id)
    .fetch_one(&pool)
    .await
    .unwrap();
  assert_eq!(count, 3, "throttled request must not create a 4th row");

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-10: sync render path produces status=done + downloadUrl in one trip
//
// With `pdf_export.sync_threshold_blocks = 50` (well above the 1-page +
// 1-paragraph fixture) the mutation must render inline, persist the PDF blob,
// and write a job row with `status='done'`, `sync_or_async='sync'` and a
// non-NULL `output_blob_id`. The GraphQL response carries `downloadUrl`.
// ---------------------------------------------------------------------------

#[test]
fn inv_pdfexp10_sync_path_returns_done_with_download_url() {
  helpers::block_on_large_stack_multithread("inv_pdfexp10_sync_path_returns_done_with_download_url", 2, || async {
    inv_pdfexp10_sync_path_returns_done_with_download_url_inner().await;
  });
}

async fn inv_pdfexp10_sync_path_returns_done_with_download_url_inner() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(50).await;
  let owner_id = helpers::create_user(&pool, "pdfexp10", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  insert_doc_snapshot(&pool, ws_id, doc_id, build_pdf_doc_yjs(1)).await;

  let resp = helpers::gql(&app, session_id, start_export_mutation(ws_id, doc_id)).await;
  assert!(resp.get("errors").is_none(), "sync mutation failed: {resp}");
  assert_eq!(
    resp["data"]["exportPdf"]["status"], "done",
    "sync path must return status=done immediately, got: {resp}"
  );
  let download_url = resp["data"]["exportPdf"]["downloadUrl"]
    .as_str()
    .expect("downloadUrl must be set when status=done");
  assert!(
    download_url.starts_with("/api/pdf-export/"),
    "downloadUrl shape unexpected: {download_url}"
  );

  let job_id: Uuid = resp["data"]["exportPdf"]["id"]
    .as_str()
    .and_then(|s| s.parse().ok())
    .expect("job id");
  let row = sqlx::query(
    "SELECT status::TEXT AS status, sync_or_async::TEXT AS soa, output_blob_id, expires_at \
     FROM pdf_export_jobs WHERE id = $1",
  )
  .bind(job_id)
  .fetch_one(&pool)
  .await
  .expect("job row exists");
  let status: String = row.get("status");
  let soa: String = row.get("soa");
  let output_blob_id: Option<Uuid> = row.try_get("output_blob_id").unwrap_or(None);
  let expires_at: Option<chrono::DateTime<chrono::Utc>> = row.try_get("expires_at").unwrap_or(None);
  assert_eq!(status, "done");
  assert_eq!(soa, "sync");
  assert!(output_blob_id.is_some(), "sync done row must point at a blob");
  assert!(expires_at.is_some(), "sync done row must have an expires_at");

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-11: above the threshold, fall through to the async/queued path
//
// With `sync_threshold_blocks = 2` and a doc that contains 1 page + 5 child
// paragraphs the sync attempt must hit `BlockLimitExceeded`. The mutation
// must NOT surface that as an error — it must continue to the async branch
// and return `status='queued'`, `sync_or_async='async'` with no blob.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexp11_above_threshold_falls_back_to_async() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(2).await;
  let owner_id = helpers::create_user(&pool, "pdfexp11", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  insert_doc_snapshot(&pool, ws_id, doc_id, build_pdf_doc_yjs(5)).await;

  let resp = helpers::gql(&app, session_id, start_export_mutation(ws_id, doc_id)).await;
  assert!(
    resp.get("errors").is_none(),
    "above-threshold mutation must not surface a sync error: {resp}"
  );
  assert_eq!(
    resp["data"]["exportPdf"]["status"], "queued",
    "above-threshold doc must fall through to the async path, got: {resp}"
  );
  assert!(
    resp["data"]["exportPdf"]["downloadUrl"].is_null(),
    "queued job must not yet have a downloadUrl"
  );

  let job_id: Uuid = resp["data"]["exportPdf"]["id"]
    .as_str()
    .and_then(|s| s.parse().ok())
    .expect("job id");
  let row = sqlx::query(
    "SELECT status::TEXT AS status, sync_or_async::TEXT AS soa, output_blob_id \
     FROM pdf_export_jobs WHERE id = $1",
  )
  .bind(job_id)
  .fetch_one(&pool)
  .await
  .expect("job row exists");
  let status: String = row.get("status");
  let soa: String = row.get("soa");
  let output_blob_id: Option<Uuid> = row.try_get("output_blob_id").unwrap_or(None);
  assert_eq!(status, "queued");
  assert_eq!(soa, "async");
  assert!(output_blob_id.is_none(), "queued row must not yet point at a blob");

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-12: finished sync export downloads as a real PDF
//
// Drives the sync render path to completion (status=done, output_blob_id set,
// PDF bytes persisted to opendal) and then exercises the REST download
// handler. The handler must:
//   * return `200 OK`
//   * set `Content-Type: application/pdf`
//   * set `Content-Disposition` with an `attachment` filename
//   * set `Cache-Control: no-store` (export blobs are user-specific, never cache)
//   * stream the actual PDF bytes (not a placeholder fallback,
//     which would indicate the storage write/read pair is wired wrong).
//
// The download URL is what `exportPdf` already advertises via
// `downloadUrl`, so the test exercises the same path the client uses.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexp12_download_returns_pdf_mime_and_filename() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(50).await;
  let owner_id = helpers::create_user(&pool, "pdfexp12", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  insert_doc_snapshot(&pool, ws_id, doc_id, build_pdf_doc_yjs(1)).await;

  // 1. Sync render to done.
  let resp = helpers::gql(&app, session_id, start_export_mutation(ws_id, doc_id)).await;
  assert!(resp.get("errors").is_none(), "sync mutation failed: {resp}");
  assert_eq!(resp["data"]["exportPdf"]["status"], "done");
  let job_id = resp["data"]["exportPdf"]["id"].as_str().expect("job id");
  let download_url = resp["data"]["exportPdf"]["downloadUrl"]
    .as_str()
    .expect("downloadUrl must be set when status=done");

  // 2. Download via the URL the client actually receives.
  let download = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(download_url)
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();

  assert_eq!(download.status().as_u16(), 200, "expected 200 OK for finished job");

  let headers = download.headers().clone();
  let ct = headers
    .get(axum::http::header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .expect("Content-Type header");
  assert_eq!(ct, "application/pdf", "Content-Type must be application/pdf");

  let cd = headers
    .get(axum::http::header::CONTENT_DISPOSITION)
    .and_then(|v| v.to_str().ok())
    .expect("Content-Disposition header");
  assert!(
    cd.starts_with("attachment;"),
    "Content-Disposition must request a download (attachment;…), got: {cd}"
  );
  assert!(
    cd.contains("filename="),
    "Content-Disposition must carry a filename, got: {cd}"
  );
  assert!(
    cd.contains(".pdf"),
    "Content-Disposition filename must end in .pdf, got: {cd}"
  );
  assert!(
    cd.contains(&format!("filename=\"doc-{doc_id}.pdf\"")),
    "Content-Disposition must use the exported document title, got: {cd}"
  );

  let cache = headers
    .get(axum::http::header::CACHE_CONTROL)
    .and_then(|v| v.to_str().ok())
    .expect("Cache-Control header");
  assert_eq!(cache, "no-store", "export blobs must not be cached");

  // 3. Body must be a real PDF, not the placeholder fallback.
  let body_bytes = download.into_body().collect().await.unwrap().to_bytes();
  assert!(body_bytes.len() >= 5, "PDF body too short: {} bytes", body_bytes.len());
  assert!(
    body_bytes.starts_with(b"%PDF-"),
    "body must start with the PDF magic header (job_id={job_id}, len={}); \
     a `PDF_PLACEHOLDER_*` body indicates the worker→storage write/read \
     pair is broken",
    body_bytes.len()
  );

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-13: page_count is surfaced end-to-end on the sync-render path
//
// PDFREV-API-01 — the worker computes the rendered page count but the
// pre-fix GraphQL row mapper threw it away (`page_count: _page_count`). The
// client uses this number to render an "N pages exported" toast and to
// decide whether to offer a "split per chapter" follow-up. The invariants:
//
//   * `exportPdf` (sync path → status=done) carries a non-null
//     `pageCount` on the GraphQL response.
//   * `pdfExportJob` polling returns the same `pageCount`.
//   * The underlying DB row has `page_count` populated.
//   * The value is ≥ 1 (any successful render produces at least one page).
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexp13_response_carries_page_count() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(50).await;
  let owner_id = helpers::create_user(&pool, "pdfexp13", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  insert_doc_snapshot(&pool, ws_id, doc_id, build_pdf_doc_yjs(1)).await;

  let mutation = json!({
    "query": r#"
      mutation ExportPdf($input: PdfExportInputV2Input!) {
        exportPdf(input: $input) {
          id status pageCount
        }
      }
    "#,
    "variables": {
      "input": {
        "workspaceId": ws_id.to_string(),
        "docId": doc_id.to_string(),
        "templateId": "default",
        "typedInputs": { "title": "PDF Export Test" }
      }
    }
  });
  let resp = helpers::gql(&app, session_id, mutation).await;
  assert!(resp.get("errors").is_none(), "sync mutation failed: {resp}");
  assert_eq!(resp["data"]["exportPdf"]["status"], "done");

  let mut_pages = resp["data"]["exportPdf"]["pageCount"]
    .as_i64()
    .unwrap_or_else(|| panic!("mutation must surface pageCount, got: {resp}"));
  assert!(mut_pages >= 1, "successful render must report ≥1 page, got {mut_pages}");

  let job_id_str = resp["data"]["exportPdf"]["id"].as_str().expect("job id");
  let job_id: Uuid = job_id_str.parse().expect("job id parses");

  let query = json!({
    "query": "query Q($id: String!) { pdfExportJob(jobId: $id) { id status pageCount } }",
    "variables": { "id": job_id_str }
  });
  let poll = helpers::gql(&app, session_id, query).await;
  assert!(poll.get("errors").is_none(), "poll failed: {poll}");
  let poll_pages = poll["data"]["pdfExportJob"]["pageCount"]
    .as_i64()
    .unwrap_or_else(|| panic!("poll must surface pageCount, got: {poll}"));
  assert_eq!(poll_pages, mut_pages, "mutation and poll must agree on pageCount");

  let row_pages: Option<i32> = sqlx::query_scalar("SELECT page_count FROM pdf_export_jobs WHERE id = $1")
    .bind(job_id)
    .fetch_one(&pool)
    .await
    .expect("row exists");
  assert_eq!(
    row_pages.map(i64::from),
    Some(mut_pages),
    "DB row page_count must match GraphQL response"
  );

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-14: idempotency is per-user (PDFREV-SEC-01)
//
// Two different members of the same workspace fire `exportPdf` against
// the same doc + options inside the 60 s idempotency window. The pre-fix
// SELECT only filtered by (workspace_id, doc_id, options_hash) and would
// therefore return User A's row to User B — handing User B a download URL
// for a blob that was rendered for someone else. After the fix, each user
// must receive their own job_id and the rows must carry the matching
// `requested_by`.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexp14_idempotency_is_per_user() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(0).await;
  let owner_id = helpers::create_user(&pool, "pdfexp14_owner", false).await;
  let collab_id = helpers::create_user(&pool, "pdfexp14_collab", false).await;
  let owner_session = helpers::create_session(&auth, owner_id).await;
  let collab_session = helpers::create_session(&auth, collab_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  sqlx::query(
    r#"INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'Collaborator', 'Accepted', now())"#,
  )
  .bind(ws_id)
  .bind(collab_id)
  .execute(&pool)
  .await
  .expect("add collaborator");
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  let r1 = helpers::gql(&app, owner_session, start_export_mutation(ws_id, doc_id)).await;
  assert!(r1.get("errors").is_none(), "owner mutation failed: {r1}");
  let owner_job_id = r1["data"]["exportPdf"]["id"]
    .as_str()
    .expect("owner job id")
    .to_string();

  let r2 = helpers::gql(&app, collab_session, start_export_mutation(ws_id, doc_id)).await;
  assert!(r2.get("errors").is_none(), "collab mutation failed: {r2}");
  let collab_job_id = r2["data"]["exportPdf"]["id"]
    .as_str()
    .expect("collab job id")
    .to_string();

  assert_ne!(
    owner_job_id, collab_job_id,
    "different users hitting the same doc within 60s must each receive their own job_id (PDFREV-SEC-01)"
  );

  let owner_uuid: Uuid = owner_job_id.parse().unwrap();
  let collab_uuid: Uuid = collab_job_id.parse().unwrap();
  let owner_req_by: Uuid = sqlx::query_scalar("SELECT requested_by FROM pdf_export_jobs WHERE id = $1")
    .bind(owner_uuid)
    .fetch_one(&pool)
    .await
    .expect("owner row");
  let collab_req_by: Uuid = sqlx::query_scalar("SELECT requested_by FROM pdf_export_jobs WHERE id = $1")
    .bind(collab_uuid)
    .fetch_one(&pool)
    .await
    .expect("collab row");
  assert_eq!(owner_req_by, owner_id, "owner row must record owner as requester");
  assert_eq!(collab_req_by, collab_id, "collab row must record collab as requester");

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[owner_id, collab_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-15: PDFREV-API-03 — `startedAt` is exposed on PdfExportJobType.
//
// Queued (async) jobs report `startedAt: null`. Sync-rendered jobs (status=
// done) carry a non-null `startedAt` and the GraphQL value must match the
// `started_at` column on the underlying row. This is the contract the
// polling client uses to estimate render-in-progress duration.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexp15_started_at_exposed_on_status_transitions() {
  // ----- Async/queued case: startedAt MUST be null on the wire.
  {
    let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(0).await;
    let user_id = helpers::create_user(&pool, "pdfexp15_async", false).await;
    let session_id = helpers::create_session(&auth, user_id).await;
    let ws_id = helpers::create_workspace(&pool, user_id).await;
    let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;

    let mutation = json!({
      "query": r#"
        mutation Start($input: PdfExportInputV2Input!) {
          exportPdf(input: $input) { id status startedAt }
        }
      "#,
      "variables": { "input": { "workspaceId": ws_id.to_string(), "docId": doc_id.to_string(), "templateId": "default", "typedInputs": { "title": "PDF Export Test" } } }
    });
    let resp = helpers::gql(&app, session_id, mutation).await;
    assert!(resp.get("errors").is_none(), "queued mutation failed: {resp}");
    assert_eq!(resp["data"]["exportPdf"]["status"], "queued");
    assert!(
      resp["data"]["exportPdf"]["startedAt"].is_null(),
      "queued job must report startedAt=null, got: {}",
      resp["data"]["exportPdf"]["startedAt"]
    );

    cleanup_pdf_export_jobs(&pool, ws_id).await;
    helpers::cleanup_users(&pool, &[user_id]).await;
  }

  // ----- Sync/done case: startedAt MUST be non-null and match the DB row.
  {
    let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(50).await;
    let user_id = helpers::create_user(&pool, "pdfexp15_sync", false).await;
    let session_id = helpers::create_session(&auth, user_id).await;
    let ws_id = helpers::create_workspace(&pool, user_id).await;
    let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
    insert_doc_snapshot(&pool, ws_id, doc_id, build_pdf_doc_yjs(1)).await;

    let mutation = json!({
      "query": r#"
        mutation Start($input: PdfExportInputV2Input!) {
          exportPdf(input: $input) { id status startedAt }
        }
      "#,
      "variables": { "input": { "workspaceId": ws_id.to_string(), "docId": doc_id.to_string(), "templateId": "default", "typedInputs": { "title": "PDF Export Test" } } }
    });
    let resp = helpers::gql(&app, session_id, mutation).await;
    assert!(resp.get("errors").is_none(), "sync mutation failed: {resp}");
    assert_eq!(resp["data"]["exportPdf"]["status"], "done");

    let started_at_str = resp["data"]["exportPdf"]["startedAt"]
      .as_str()
      .unwrap_or_else(|| panic!("done job must report startedAt, got: {resp}"));
    let started_at_gql: chrono::DateTime<chrono::Utc> = started_at_str
      .parse()
      .unwrap_or_else(|_| panic!("startedAt must be RFC3339, got {started_at_str}"));

    let job_id_str = resp["data"]["exportPdf"]["id"].as_str().expect("job id");
    let job_id: Uuid = job_id_str.parse().expect("job id parses");

    // DB row carries the same timestamp.
    let row_started: Option<chrono::DateTime<chrono::Utc>> =
      sqlx::query_scalar("SELECT started_at FROM pdf_export_jobs WHERE id = $1")
        .bind(job_id)
        .fetch_one(&pool)
        .await
        .expect("row exists");
    let row_started = row_started.expect("DB row must have started_at populated");
    assert_eq!(
      started_at_gql, row_started,
      "GraphQL startedAt must match DB row started_at"
    );

    // Poll path returns the same value.
    let poll = helpers::gql(
      &app,
      session_id,
      json!({
        "query": "query Q($id: String!) { pdfExportJob(jobId: $id) { startedAt } }",
        "variables": { "id": job_id_str }
      }),
    )
    .await;
    let poll_started_str = poll["data"]["pdfExportJob"]["startedAt"]
      .as_str()
      .unwrap_or_else(|| panic!("poll must surface startedAt, got: {poll}"));
    let poll_started: chrono::DateTime<chrono::Utc> = poll_started_str.parse().expect("poll startedAt parses");
    assert_eq!(poll_started, started_at_gql, "mutation and poll must agree");

    cleanup_pdf_export_jobs(&pool, ws_id).await;
    helpers::cleanup_users(&pool, &[user_id]).await;
  }
}

// ---------------------------------------------------------------------------
// PDFEXP-16: PDFREV-API-04 — failed download → 410 Gone + error_class header
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexp16_failed_download_returns_410_with_error_class() {
  let (app, pool, auth) = helpers::setup_app().await;
  let user_id = helpers::create_user(&pool, "pdfexp16", false).await;
  let session_id = helpers::create_session(&auth, user_id).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;

  // Insert a failed row directly so we don't need to drive the worker.
  let job_id: Uuid = sqlx::query_scalar(
    "INSERT INTO pdf_export_jobs \
       (workspace_id, doc_id, requested_by, template_id, render_inputs, options_hash, status, sync_or_async, error_class, error_detail, started_at, finished_at) \
     VALUES ($1, $2, $3, 'default', '{}', $4, 'failed', 'async', 'RenderError', 'simulated render failure', NOW(), NOW()) \
     RETURNING id",
  )
  .bind(ws_id)
  .bind(doc_id)
  .bind(user_id)
  .bind(format!("failed-hash-{}", Uuid::new_v4()))
  .fetch_one(&pool)
  .await
  .expect("insert failed row");

  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(format!("/api/pdf-export/{job_id}/download"))
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();

  assert_eq!(
    resp.status().as_u16(),
    410,
    "failed download must respond 410 Gone (PDFREV-API-04)"
  );
  let class_header = resp
    .headers()
    .get("x-pdf-export-error-class")
    .and_then(|h| h.to_str().ok())
    .map(|s| s.to_string())
    .expect("X-Pdf-Export-Error-Class header must be present");
  assert_eq!(class_header, "RenderError", "header must carry stable error_class");
  let content_type = resp
    .headers()
    .get(axum::http::header::CONTENT_TYPE)
    .and_then(|h| h.to_str().ok())
    .map(|s| s.to_string())
    .expect("Content-Type header");
  assert!(
    content_type.starts_with("application/json"),
    "failed download body must be JSON, got {content_type}"
  );

  let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
  let body: Value = serde_json::from_slice(&body_bytes).expect("body must be valid JSON");
  assert_eq!(body["error_class"], "RenderError");
  assert!(body["message"].is_string(), "body must carry a `message` field");

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-17: unmapped_font_families round-trips via GraphQL
//
// The renderer (pdf_export crate) already produces
// `RenderReport.unmapped_font_families` whenever a requested global-theme
// font role fails the FontBook lookup. The pipeline persists that list on the
// `pdf_export_jobs` row and the GraphQL `PdfExportJobType` exposes it as
// `unmappedFontFamilies`. A zero-config render uses bundled defaults and must
// therefore produce an empty array (phase 1).
//
// Phase 2 seeds the column directly via SQL and re-polls to prove the GraphQL
// row mapper reads JSONB → Vec<String> correctly. Without this proof the field
// could stay at `[]` forever when a real renderer diagnostic is persisted.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexp17_unmapped_font_families_round_trips() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(50).await;
  let _guard = pdf_theme_config_guard().await;
  let owner_id = helpers::create_user(&pool, "pdfexp17", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  insert_doc_snapshot(&pool, ws_id, doc_id, build_pdf_doc_yjs(1)).await;
  clear_pdf_export_theme_config(&pool, Some(ws_id)).await;
  set_pdf_export_global_theme(&pool, "wien").await;

  // Phase 1: sync render → expect empty array on the wire and on disk.
  let mutation = json!({
    "query": r#"
      mutation ExportPdf($input: PdfExportInputV2Input!) {
        exportPdf(input: $input) {
          id status unmappedFontFamilies
        }
      }
    "#,
    "variables": {
      "input": {
        "workspaceId": ws_id.to_string(),
        "docId": doc_id.to_string(),
        "templateId": "default",
        "typedInputs": { "title": "PDF Export Test" }
      }
    }
  });
  let resp = helpers::gql(&app, session_id, mutation).await;
  assert!(resp.get("errors").is_none(), "sync mutation failed: {resp}");
  assert_eq!(resp["data"]["exportPdf"]["status"], "done");
  let baseline_unmapped = &resp["data"]["exportPdf"]["unmappedFontFamilies"];
  assert!(
    baseline_unmapped.is_array(),
    "field must be an array, got: {baseline_unmapped}"
  );
  assert_eq!(
    baseline_unmapped.as_array().unwrap().len(),
    0,
    "fresh render with bundled global-theme defaults must yield empty unmappedFontFamilies, got {baseline_unmapped}"
  );

  let job_id_str = resp["data"]["exportPdf"]["id"].as_str().expect("job id");
  let job_id: Uuid = job_id_str.parse().expect("job id parses");

  let baseline_row: serde_json::Value =
    sqlx::query_scalar("SELECT unmapped_font_families FROM pdf_export_jobs WHERE id = $1")
      .bind(job_id)
      .fetch_one(&pool)
      .await
      .expect("baseline row exists");
  assert_eq!(baseline_row, json!([]), "DB column default must be empty JSONB array");

  // Phase 2: seed the column with a non-empty array and re-poll. This mirrors
  // the worker write path when Typst reports an unmapped theme-font role.
  let seeded = json!(["BogusFontA", "BogusFontB"]);
  sqlx::query("UPDATE pdf_export_jobs SET unmapped_font_families = $2 WHERE id = $1")
    .bind(job_id)
    .bind(&seeded)
    .execute(&pool)
    .await
    .expect("seed unmapped_font_families");

  let query = json!({
    "query": "query Q($id: String!) { pdfExportJob(jobId: $id) { id unmappedFontFamilies } }",
    "variables": { "id": job_id_str }
  });
  let poll = helpers::gql(&app, session_id, query).await;
  assert!(poll.get("errors").is_none(), "poll failed: {poll}");
  let poll_unmapped = &poll["data"]["pdfExportJob"]["unmappedFontFamilies"];
  assert_eq!(
    poll_unmapped,
    &json!(["BogusFontA", "BogusFontB"]),
    "GraphQL row mapper must echo seeded JSONB array verbatim, got {poll_unmapped}"
  );

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  clear_pdf_export_theme_config(&pool, Some(ws_id)).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-19: history accepts compact client document IDs.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexp19_history_accepts_client_doc_id() {
  let (app, pool, auth) = helpers::setup_app().await;
  let user_id = helpers::create_user(&pool, "pdfexp19", false).await;
  let session_id = helpers::create_session(&auth, user_id).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let client_doc_id = format!("pdfexp19ClientDoc{}", Uuid::new_v4().simple());
  let doc_id = Uuid::new_v4();

  sqlx::query(
    r#"INSERT INTO docs (id, workspace_id, title, external_id, default_role, is_workspace_root, created_by, updated_by)
       VALUES ($1, $2, 'History Client Doc', $3, 'viewer', false, $4, $4)"#,
  )
  .bind(doc_id)
  .bind(ws_id)
  .bind(&client_doc_id)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("insert compact-id doc");

  let output_blob_id = Uuid::new_v4();
  let job_id: Uuid = sqlx::query_scalar(
    "INSERT INTO pdf_export_jobs \
       (workspace_id, doc_id, requested_by, template_id, render_inputs, options_hash, status, sync_or_async, output_blob_id, started_at, finished_at) \
     VALUES ($1, $2, $3, 'default', '{}', $4, 'done', 'sync', $5, NOW(), NOW()) \
     RETURNING id",
  )
  .bind(ws_id)
  .bind(doc_id)
  .bind(user_id)
  .bind(format!("history-hash-{}", Uuid::new_v4()))
  .bind(output_blob_id)
  .fetch_one(&pool)
  .await
  .expect("insert history row");

  let resp = helpers::gql(&app, session_id, document_history_query(ws_id, &client_doc_id)).await;
  assert!(
    resp.get("errors").is_none(),
    "history must accept compact client doc IDs, got: {resp}"
  );
  let rows = resp["data"]["documentPdfExportHistory"]
    .as_array()
    .unwrap_or_else(|| panic!("history rows missing: {resp}"));
  assert_eq!(rows.len(), 1, "history must return the seeded export row: {resp}");
  assert_eq!(rows[0]["id"].as_str(), Some(job_id.to_string().as_str()));
  assert_eq!(rows[0]["docId"].as_str(), Some(doc_id.to_string().as_str()));
  assert_eq!(rows[0]["status"].as_str(), Some("done"));

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-20: job-specific SSE emits phases in order.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_exp03_sse_emits_phases_in_order() {
  let (app, pool, auth) = helpers::setup_app().await;
  let user_id = helpers::create_user(&pool, "pdfexp20", false).await;
  let session_id = helpers::create_session(&auth, user_id).await;
  let ws_id = helpers::create_workspace(&pool, user_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, user_id).await;
  let job_id = Uuid::new_v4();
  let output_blob_id = Uuid::new_v4();

  sqlx::query(
    "INSERT INTO pdf_export_jobs \
       (id, workspace_id, doc_id, requested_by, template_id, render_inputs, options_hash, status, sync_or_async) \
     VALUES ($1, $2, $3, $4, 'default', '{}'::jsonb, $5, 'queued', 'async')",
  )
  .bind(job_id)
  .bind(ws_id)
  .bind(doc_id)
  .bind(user_id)
  .bind(format!("sse-{job_id}"))
  .execute(&pool)
  .await
  .expect("insert queued pdf export job");

  let app_for_stream = app.clone();
  let (stream_started_tx, stream_started_rx) = tokio::sync::oneshot::channel();
  let stream_task = tokio::spawn(async move {
    let response = app_for_stream
      .oneshot(
        Request::builder()
          .method("GET")
          .uri(format!("/api/pdf-export/{job_id}/events"))
          .header("cookie", format!("affine_session={session_id}"))
          .body(Body::empty())
          .expect("sse request"),
      )
      .await
      .expect("sse response");
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let _ = stream_started_tx.send(());
    let body = tokio::time::timeout(std::time::Duration::from_secs(5), response.into_body().collect())
      .await
      .expect("sse stream must finish after terminal status")
      .expect("sse body");
    String::from_utf8(body.to_bytes().to_vec()).expect("sse utf8")
  });

  stream_started_rx.await.expect("sse stream started");
  // Give the body stream one scheduler turn to emit the initial queued
  // snapshot before the simulated worker transitions the row. The handler
  // then polls the DB every second and emits only changed fingerprints.
  tokio::time::sleep(std::time::Duration::from_millis(250)).await;

  sqlx::query("UPDATE pdf_export_jobs SET status = 'running', started_at = NOW() WHERE id = $1")
    .bind(job_id)
    .execute(&pool)
    .await
    .expect("transition job to running");
  tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

  sqlx::query(
    "UPDATE pdf_export_jobs \
       SET status = 'done', output_blob_id = $2, page_count = 2, \
           unmapped_font_families = $3, finished_at = NOW(), expires_at = NOW() + INTERVAL '24 hours' \
     WHERE id = $1",
  )
  .bind(job_id)
  .bind(output_blob_id)
  .bind(json!(["Iosevka Slab"]))
  .execute(&pool)
  .await
  .expect("transition job to done");

  let sse_text = stream_task.await.expect("sse task joins");
  let queued_idx = sse_text
    .find("\"phase\":\"queued\"")
    .unwrap_or_else(|| panic!("SSE stream must contain queued phase: {sse_text}"));
  let rendering_idx = sse_text
    .find("\"phase\":\"rendering\"")
    .unwrap_or_else(|| panic!("SSE stream must contain rendering phase: {sse_text}"));
  let done_idx = sse_text
    .find("\"phase\":\"done\"")
    .unwrap_or_else(|| panic!("SSE stream must contain done phase: {sse_text}"));
  assert!(
    queued_idx < rendering_idx && rendering_idx < done_idx,
    "INV-PDFEXP-20: SSE phases must be emitted in queued -> rendering -> done order: {sse_text}"
  );
  assert!(
    sse_text.contains("event: update") && sse_text.contains("event: done"),
    "INV-PDFEXP-20: SSE stream must name update and terminal done events: {sse_text}"
  );
  assert!(
    sse_text.contains(&format!("/api/pdf-export/{job_id}/download")),
    "INV-PDFEXP-20: done payload must expose the download URL: {sse_text}"
  );
  assert!(
    sse_text.contains("Iosevka Slab"),
    "INV-PDFEXP-20: done payload must mirror unmapped font families: {sse_text}"
  );

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  helpers::cleanup_users(&pool, &[user_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-21: admin diagnostics query uses one filter input object.
// ---------------------------------------------------------------------------

#[test]
fn inv_pdfexp21_admin_jobs_filter_input_filters_rows() {
  helpers::block_on_large_stack("inv-pdfexp21-admin-jobs-filter", || async {
    let (app, pool, auth) = helpers::setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
    let owner_id = helpers::create_user(&pool, "pdfexp21", false).await;
    let ws_id = helpers::create_workspace(&pool, owner_id).await;
    let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
    let done_job_id = Uuid::new_v4();
    let failed_job_id = Uuid::new_v4();

    for (job_id, status) in [(done_job_id, "done"), (failed_job_id, "failed")] {
      sqlx::query(
        "INSERT INTO pdf_export_jobs \
       (id, workspace_id, doc_id, requested_by, template_id, render_inputs, options_hash, \
          status, sync_or_async, output_blob_id, started_at, finished_at, expires_at) \
       VALUES ($1, $2, $3, $4, 'default', '{}'::jsonb, $5, $6::pdf_export_status, 'sync', $7, NOW(), NOW(), NOW() + INTERVAL '24 hours')",
      )
      .bind(job_id)
      .bind(ws_id)
      .bind(doc_id)
      .bind(owner_id)
      .bind(format!("filter-{job_id}"))
      .bind(status)
      .bind(Uuid::new_v4())
      .execute(&pool)
      .await
      .expect("insert filtered admin pdf export job");
    }

    let response = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": r#"
        query AdminJobs($filter: AdminPdfExportJobsFilterInput) {
          admin {
            pdfExportJobs(filter: $filter) {
              id
              status
              workspaceId
              requestedBy
            }
          }
        }
      "#,
        "variables": {
          "filter": {
            "status": "done",
            "workspaceId": ws_id.to_string(),
            "userId": owner_id.to_string(),
            "limit": 10
          }
        }
      }),
    )
    .await;

    assert!(
      response.get("errors").is_none(),
      "admin filter query failed: {response}"
    );
    let rows = response["data"]["admin"]["pdfExportJobs"]
      .as_array()
      .expect("admin jobs rows");
    assert_eq!(rows.len(), 1, "filter input must narrow to the done job: {response}");
    assert_eq!(rows[0]["id"], done_job_id.to_string());
    assert_eq!(rows[0]["status"], "done");
    assert_eq!(rows[0]["workspaceId"], ws_id.to_string());
    assert_eq!(rows[0]["requestedBy"], owner_id.to_string());

    cleanup_pdf_export_jobs(&pool, ws_id).await;
    helpers::cleanup_users(&pool, &[owner_id, admin_id]).await;
  });
}

// ---------------------------------------------------------------------------
// PDFEXP-17b: the effective global branding profile is materialised as
// canonical render_inputs.theme_fonts when no workspace profile is configured.
// No old body-font dispatch key is kept.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexp17b_global_theme_fonts_thread_into_render_inputs() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(50).await;
  let _guard = pdf_theme_config_guard().await;
  let owner_id = helpers::create_user(&pool, "pdfexp17b", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  insert_doc_snapshot(&pool, ws_id, doc_id, build_pdf_doc_yjs(1)).await;

  clear_pdf_export_theme_config(&pool, Some(ws_id)).await;
  set_pdf_export_global_theme(&pool, "wien").await;

  let mutation = json!({
    "query": r#"
      mutation ExportPdf($input: PdfExportInputV2Input!) {
        exportPdf(input: $input) {
          id status unmappedFontFamilies
        }
      }
    "#,
    "variables": {
      "input": {
        "workspaceId": ws_id.to_string(),
        "docId": doc_id.to_string(),
        "templateId": "default",
        "typedInputs": { "title": "PDF Export Test" }
      }
    }
  });
  let resp = helpers::gql(&app, session_id, mutation).await;
  assert!(resp.get("errors").is_none(), "sync mutation failed: {resp}");
  assert_eq!(
    resp["data"]["exportPdf"]["status"], "done",
    "PDFEXP-17b: render must complete sync with globally configured bundled fonts"
  );

  let unmapped = &resp["data"]["exportPdf"]["unmappedFontFamilies"];
  let arr = unmapped.as_array().expect("unmappedFontFamilies must be an array");
  assert!(
    arr.is_empty(),
    "PDFEXP-17b: bundled global theme fonts must not surface unmapped diagnostics; got {unmapped}"
  );

  let job_id_str = resp["data"]["exportPdf"]["id"].as_str().expect("job id");
  let job_id: Uuid = job_id_str.parse().expect("job id parses");

  let render_inputs: serde_json::Value = sqlx::query_scalar("SELECT render_inputs FROM pdf_export_jobs WHERE id = $1")
    .bind(job_id)
    .fetch_one(&pool)
    .await
    .expect("row exists");
  assert_eq!(render_inputs["theme_fonts"]["heading"], "Lora");
  assert_eq!(render_inputs["theme_fonts"]["body"], "Inter");
  assert_eq!(render_inputs["theme_fonts"]["mono"], "JetBrains Mono");
  assert_eq!(render_inputs["theme_fonts"]["symbol"], "JetBrains Mono");
  assert_eq!(render_inputs["theme_typography"]["heading"]["font_weight"], 600);
  assert_eq!(render_inputs["theme_typography"]["heading"]["size_px"], 32.0);
  assert_eq!(
    render_inputs["theme_typography"]["heading"]["letter_spacing_em"],
    -0.005
  );
  assert_eq!(render_inputs["theme_typography"]["body"]["line_height"], 1.55);
  assert_render_inputs_have_pinned_theme_assets(&render_inputs, "PDFEXP-17b");
  assert!(
    render_inputs.get("body_font_family").is_none(),
    "PDFEXP-17b: render_inputs must not keep the old body_font_family key: {render_inputs}"
  );

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  clear_pdf_export_theme_config(&pool, Some(ws_id)).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-17c: a workspace branding profile overrides global theme fonts.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexp17c_workspace_fonts_override_global_theme_fonts() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(50).await;
  let _guard = pdf_theme_config_guard().await;
  let owner_id = helpers::create_user(&pool, "pdfexp17c", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  insert_doc_snapshot(&pool, ws_id, doc_id, build_pdf_doc_yjs(1)).await;

  clear_pdf_export_theme_config(&pool, Some(ws_id)).await;
  set_pdf_export_global_theme(&pool, "wien").await;
  set_pdf_export_workspace_theme(&pool, ws_id, "porto").await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"
        mutation ExportPdf($input: PdfExportInputV2Input!) {
          exportPdf(input: $input) { id status }
        }
      "#,
      "variables": {
        "input": {
          "workspaceId": ws_id.to_string(),
          "docId": doc_id.to_string(),
          "templateId": "default",
        "typedInputs": { "title": "PDF Export Test" }
        }
      }
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "sync mutation failed: {resp}");
  assert_eq!(resp["data"]["exportPdf"]["status"], "done");

  let job_id: Uuid = resp["data"]["exportPdf"]["id"]
    .as_str()
    .expect("job id")
    .parse()
    .expect("job id parses");
  let render_inputs: serde_json::Value = sqlx::query_scalar("SELECT render_inputs FROM pdf_export_jobs WHERE id = $1")
    .bind(job_id)
    .fetch_one(&pool)
    .await
    .expect("row exists");
  assert_eq!(
    render_inputs["theme_fonts"]["heading"], "Merriweather",
    "workspace heading role must override global theme role"
  );
  assert_eq!(
    render_inputs["theme_fonts"]["body"], "Lato",
    "workspace body role must override global theme role"
  );
  assert_eq!(render_inputs["theme_fonts"]["mono"], "JetBrains Mono");
  assert_eq!(render_inputs["theme_fonts"]["symbol"], "JetBrains Mono");
  assert_eq!(render_inputs["theme_typography"]["heading"]["font_weight"], 700);
  assert_eq!(render_inputs["theme_typography"]["heading"]["size_px"], 34.0);
  assert_eq!(render_inputs["theme_typography"]["body"]["line_height"], 1.6);
  assert_render_inputs_have_pinned_theme_assets(&render_inputs, "PDFEXP-17c");
  assert!(
    render_inputs.get("body_font_family").is_none(),
    "PDFEXP-17c: render_inputs must not keep the old body_font_family key: {render_inputs}"
  );

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  clear_pdf_export_theme_config(&pool, Some(ws_id)).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

// ---------------------------------------------------------------------------
// PDFEXP-22: long real-text document renders end-to-end as multi-page PDF.
//
// This is intentionally not a blank-block stress test. The fixture derives
// from the PDF architecture documentation and writes actual Y.Text paragraph
// content into the snapshot, so the test covers the user-visible path:
// Yjs text -> IR -> Typst -> stored PDF -> REST download.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inv_pdfexp22_long_docs_page_exports_multi_page_pdf() {
  let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(500).await;
  let _guard = pdf_theme_config_guard().await;
  let owner_id = helpers::create_user(&pool, "pdfexp22", false).await;
  let session_id = helpers::create_session(&auth, owner_id).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  let paragraphs = long_pdf_architecture_doc_paragraphs();
  assert!(paragraphs.len() >= 180, "long fixture precondition");
  insert_doc_snapshot(
    &pool,
    ws_id,
    doc_id,
    build_pdf_doc_yjs_from_paragraphs("PDF Export V2 Architecture", &paragraphs),
  )
  .await;

  clear_pdf_export_theme_config(&pool, Some(ws_id)).await;
  set_pdf_export_global_theme(&pool, "wien").await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"
          mutation ExportPdf($input: PdfExportInputV2Input!) {
            exportPdf(input: $input) {
              id
              status
              pageCount
              downloadUrl
              unmappedFontFamilies
            }
          }
        "#,
      "variables": {
        "input": {
          "workspaceId": ws_id.to_string(),
          "docId": doc_id.to_string(),
          "templateId": "default",
          "typedInputs": { "title": "PDF Export V2 Architecture" }
        }
      }
    }),
  )
  .await;
  assert!(resp.get("errors").is_none(), "long-doc sync mutation failed: {resp}");
  let job = &resp["data"]["exportPdf"];
  assert_eq!(
    job["status"], "done",
    "long-doc export must finish in sync path: {resp}"
  );
  let page_count = job["pageCount"].as_i64().expect("pageCount must be set");
  assert!(
    page_count >= 2,
    "long docs-derived export must be multi-page, got pageCount={page_count}: {resp}"
  );
  assert_eq!(
    job["unmappedFontFamilies"],
    json!([]),
    "bundled global theme fonts must not report unmapped diagnostics"
  );
  let download_url = job["downloadUrl"]
    .as_str()
    .expect("downloadUrl must be set for sync done export");
  let job_id: Uuid = job["id"].as_str().expect("job id").parse().expect("job id parses");

  let render_inputs: serde_json::Value = sqlx::query_scalar("SELECT render_inputs FROM pdf_export_jobs WHERE id = $1")
    .bind(job_id)
    .fetch_one(&pool)
    .await
    .expect("job row exists");
  assert_eq!(render_inputs["theme_fonts"]["heading"], "Lora");
  assert_eq!(render_inputs["theme_fonts"]["body"], "Inter");
  assert_eq!(render_inputs["theme_fonts"]["mono"], "JetBrains Mono");
  assert_eq!(render_inputs["theme_fonts"]["symbol"], "JetBrains Mono");
  assert_render_inputs_have_pinned_theme_assets(&render_inputs, "PDFEXP-22");
  assert!(
    render_inputs.get("body_font_family").is_none(),
    "PDFEXP-22: long-doc render inputs must not resurrect body_font_family: {render_inputs}"
  );

  let download = app
    .clone()
    .oneshot(
      Request::builder()
        .method("GET")
        .uri(download_url)
        .header("cookie", format!("affine_session={session_id}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(download.status().as_u16(), 200, "long-doc download must succeed");
  let body_bytes = download.into_body().collect().await.unwrap().to_bytes();
  assert!(
    body_bytes.starts_with(b"%PDF-"),
    "long-doc download body must be a PDF, got {} bytes",
    body_bytes.len()
  );
  assert!(
    body_bytes.len() > 20_000,
    "long-doc PDF should be non-trivial, got {} bytes",
    body_bytes.len()
  );
  let pdf_text = pdf_extract::extract_text_from_mem(&body_bytes).expect("long-doc PDF text must be extractable");
  assert!(
    pdf_text.contains("PDF Export V2 Architecture") || pdf_text.contains("Abschnitt 1.1"),
    "long-doc PDF must contain real document text, extracted:\n{pdf_text}"
  );
  assert!(
    !pdf_text.contains("Canvas snapshot not available"),
    "page-mode long-doc export must not leak edgeless placeholder text, extracted:\n{pdf_text}"
  );

  cleanup_pdf_export_jobs(&pool, ws_id).await;
  clear_pdf_export_theme_config(&pool, Some(ws_id)).await;
  helpers::cleanup_users(&pool, &[owner_id]).await;
}

#[test]
fn inv_pdfexp22b_documentation_customization_survives_worker_dispatch() {
  helpers::block_on_large_stack_multithread(
    "inv_pdfexp22b_documentation_customization_survives_worker_dispatch",
    2,
    || async {
      let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(500).await;
      // Both app builders seed themes under THEME_BRANDING_LOCK. Build them
      // before holding the fixture lock across the two export paths.
      let (queued_app, _, _) = helpers::setup_app_with_pdf_sync_threshold(0).await;
      let _guard = pdf_theme_config_guard().await;
      let owner_id = helpers::create_user(&pool, "pdfexp22-doc", false).await;
      let session_id = helpers::create_session(&auth, owner_id).await;
      let ws_id = helpers::create_workspace(&pool, owner_id).await;
      let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
      let lifetime_template_id = Uuid::new_v4();
      let mut lifetime_blobs = Vec::new();
      use futures_util::FutureExt;
      let outcome = std::panic::AssertUnwindSafe(async {
        let template_id = myoxus_infrastructure::pdf_export::system_template_id("myoxus-doc");
        super::pdf_export_v2_mutation_test::assign_template(&pool, ws_id, template_id, owner_id).await;
        // Pagination stress remains in PDFEXP-22 and the renderer's long fixture.
        // This bounded source isolates dispatch/snapshot fidelity in both paths.
        let paragraphs: Vec<_> = long_pdf_architecture_doc_paragraphs().into_iter().take(8).collect();
        insert_doc_snapshot(
          &pool,
          ws_id,
          doc_id,
          build_pdf_doc_yjs_from_paragraphs("PDF Export V2 Architecture", &paragraphs),
        )
        .await;

        clear_pdf_export_theme_config(&pool, Some(ws_id)).await;
        set_pdf_export_global_theme(&pool, "wien").await;

        let request = json!({
          "query": r#"
          mutation ExportPdf($input: PdfExportInputV2Input!) {
            exportPdf(input: $input) {
              id
              status
              pageCount
              downloadUrl
              unmappedFontFamilies
            }
          }
        "#,
          "variables": {
            "input": {
              "workspaceId": ws_id.to_string(),
              "docId": doc_id.to_string(),
              "templateId": template_id.to_string(),
              "footerStyle": "page-only",
              "pageNumbering": "roman",
              "colorVariant": "mono",
              "typedInputs": { "report_date": "2026-09-19" }
            }
          }
        });
        let resp = helpers::gql(&app, session_id, request.clone()).await;
        assert!(resp.get("errors").is_none(), "long-doc sync mutation failed: {resp}");
        let job = &resp["data"]["exportPdf"];
        assert_eq!(
          job["status"], "done",
          "long-doc export must finish in sync path: {resp}"
        );
        let page_count = job["pageCount"].as_i64().expect("pageCount must be set");
        assert!(
          page_count >= 2,
          "long docs-derived export must be multi-page, got pageCount={page_count}: {resp}"
        );
        assert_eq!(
          job["unmappedFontFamilies"],
          json!([]),
          "bundled global theme fonts must not report unmapped diagnostics"
        );
        let download_url = job["downloadUrl"]
          .as_str()
          .expect("downloadUrl must be set for sync done export");
        let job_id: Uuid = job["id"].as_str().expect("job id").parse().expect("job id parses");

        let render_inputs: serde_json::Value =
          sqlx::query_scalar("SELECT render_inputs FROM pdf_export_jobs WHERE id = $1")
            .bind(job_id)
            .fetch_one(&pool)
            .await
            .expect("job row exists");
        assert_eq!(render_inputs["theme_fonts"]["heading"], "Lora");
        assert_eq!(render_inputs["theme_fonts"]["body"], "Inter");
        assert_eq!(render_inputs["theme_fonts"]["mono"], "JetBrains Mono");
        assert_eq!(render_inputs["theme_fonts"]["symbol"], "JetBrains Mono");
        assert_render_inputs_have_pinned_theme_assets(&render_inputs, "PDFEXP-22");
        assert!(
          render_inputs.get("body_font_family").is_none(),
          "PDFEXP-22: long-doc render inputs must not resurrect body_font_family: {render_inputs}"
        );

        let download = app
          .clone()
          .oneshot(
            Request::builder()
              .method("GET")
              .uri(download_url)
              .header("cookie", format!("affine_session={session_id}"))
              .body(Body::empty())
              .unwrap(),
          )
          .await
          .unwrap();
        assert_eq!(download.status().as_u16(), 200, "long-doc download must succeed");
        let body_bytes = download.into_body().collect().await.unwrap().to_bytes();
        assert!(
          body_bytes.starts_with(b"%PDF-"),
          "long-doc download body must be a PDF, got {} bytes",
          body_bytes.len()
        );
        // Compression and font subsetting change byte size without losing
        // content. Inspect the actual pages and every source paragraph instead.
        let parsed_pdf = lopdf::Document::load_mem(&body_bytes).expect("valid rendered PDF");
        assert!(parsed_pdf.get_pages().len() >= 2, "actual PDF must be multi-page");
        let pdf_text = pdf_extract::extract_text_from_mem(&body_bytes).expect("long-doc PDF text must be extractable");
        let page_ids = parsed_pdf.get_pages().keys().copied().collect::<Vec<_>>();
        let complete_text = parsed_pdf.extract_text(&page_ids).expect("complete PDF Unicode text");
        // In this fixture lopdf emits a discretionary wrapping hyphen on its
        // own line. Normalize that layout artifact, retaining literal inline
        // hyphens such as `server-managed` from the source.
        let normalized_text = complete_text
          .replace("\n-\n", "")
          .split_whitespace()
          .collect::<String>();
        for paragraph in &paragraphs {
          assert!(
            normalized_text.contains(&paragraph.split_whitespace().collect::<String>()),
            "complete source paragraph must survive rendering: {paragraph}; extracted: {complete_text}"
          );
        }
        assert!(
          pdf_text.contains("PDF Export V2 Architecture") && pdf_text.contains("Abschnitt 1.1"),
          "long-doc PDF must contain real document text, extracted:\n{pdf_text}"
        );
        assert!(
          !pdf_text.contains("Canvas snapshot not available"),
          "page-mode long-doc export must not leak edgeless placeholder text, extracted:\n{pdf_text}"
        );

        assert!(pdf_text.contains("2026-09-19"), "typed date reaches the cover");
        assert!(
          pdf_text.contains("pdfexp22-doc"),
          "document attribution reaches the cover"
        );
        for (key, value) in [
          ("footer_style", "page-only"),
          ("page_numbering", "roman"),
          ("color_variant", "mono"),
        ] {
          assert_eq!(render_inputs[key], value, "dispatch snapshot retains {key}");
        }

        // Remove the completed artifact before redispatch so idempotency cannot
        // return the sync PDF and accidentally make the queued comparison pass.
        let storage =
          Arc::new(myoxus_infrastructure::storage::StorageAdapter::new_fs("./test-storage").expect("PDF storage"));
        let sync_blob: Uuid = sqlx::query_scalar("SELECT output_blob_id FROM pdf_export_jobs WHERE id = $1")
          .bind(job_id)
          .fetch_one(&pool)
          .await
          .expect("sync output blob");
        // Generated artifacts are ordinary workspace blobs. Exercise the same
        // reader used by Vault export, not only the PDF-specific download.
        let sync_blob_key = format!("pdf-export/{sync_blob}");
        let registered_key: String = sqlx::query_scalar("SELECT key FROM blobs WHERE workspace_id = $1 AND key = $2")
          .bind(ws_id)
          .bind(&sync_blob_key)
          .fetch_one(&pool)
          .await
          .expect("PDF metadata uses a workspace-relative key");
        assert_eq!(registered_key, sync_blob_key);
        let generic_download = app
          .clone()
          .oneshot(
            Request::builder()
              .method("GET")
              .uri(format!("/api/workspaces/{ws_id}/blobs/{sync_blob_key}"))
              .header("cookie", format!("affine_session={session_id}"))
              .body(Body::empty())
              .unwrap(),
          )
          .await
          .expect("general workspace PDF download");
        assert_eq!(generic_download.status().as_u16(), 200);
        assert_eq!(
          generic_download.into_body().collect().await.unwrap().to_bytes(),
          body_bytes
        );

        use myoxus_application::ports::BlobStoragePort;
        storage
          .delete_blob(&myoxus_worker::pdf_export_handler::pdf_export_storage_key(
            ws_id, sync_blob,
          ))
          .await
          .expect("remove sync artifact");
        sqlx::query("DELETE FROM pdf_export_render_audit WHERE job_id = $1")
          .bind(job_id)
          .execute(&pool)
          .await
          .expect("remove sync audit");
        sqlx::query("DELETE FROM pdf_export_jobs WHERE id = $1")
          .bind(job_id)
          .execute(&pool)
          .await
          .expect("remove sync job without touching the source");
        let queued = helpers::gql(&queued_app, session_id, request).await;
        assert!(queued.get("errors").is_none(), "queued dispatch: {queued}");
        assert_eq!(queued["data"]["exportPdf"]["status"], "queued");
        let queued_id: Uuid = queued["data"]["exportPdf"]["id"].as_str().unwrap().parse().unwrap();
        assert_ne!(queued_id, job_id);
        let queued_inputs: Value = sqlx::query_scalar("SELECT render_inputs FROM pdf_export_jobs WHERE id = $1")
          .bind(queued_id)
          .fetch_one(&pool)
          .await
          .expect("queued snapshot");
        for key in [
          "footer_style",
          "page_numbering",
          "color_variant",
          "typed_inputs",
          "theme_fonts",
          "theme_typography",
          "document_branding",
        ] {
          assert_eq!(queued_inputs[key], render_inputs[key], "same selected {key}");
        }
        let blobs = Arc::new(myoxus_application::ports::blob_service::BlobService::new(
          Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(pool.clone())),
          storage.clone(),
          "test-key".into(),
        ));
        let mut handler = myoxus_worker::PdfExportJobHandler::new(
          Arc::new(myoxus_infrastructure::pdf_export::PgPdfExportJobStore::new(
            pool.clone(),
          )),
          Arc::new(myoxus_application::doc::DocService::new(Arc::new(
            myoxus_infrastructure::doc::SqlxDocStore::new(pool.clone()),
          ))),
          blobs,
          Arc::new(myoxus_infrastructure::pdf_export::PgPdfFontRepository::new(
            pool.clone(),
          )),
          Path::new(env!("CARGO_MANIFEST_DIR")).join("../../static/fonts"),
          Arc::new(myoxus_api::pdf_export_adapter::PdfExportBlobWriterAdapter {
            storage: storage.clone(),
          }),
          myoxus_worker::PdfExportLimits::default(),
          Arc::new(myoxus_infrastructure::pdf_export::PgPdfTemplateRegistry::new(
            pool.clone(),
            Arc::new(myoxus_infrastructure::pdf_export::PgPdfTemplateRepository::new(
              pool.clone(),
            )),
            Arc::new(myoxus_infrastructure::pdf_export::PdfBlobStore::new(storage.operator())),
          )),
        );
        handler.font_reader = Some(Arc::new(myoxus_api::pdf_export_adapter::PdfExportFontReaderAdapter {
          storage: storage.clone(),
        }));
        handler.asset_reader = Some(Arc::new(myoxus_api::pdf_export_adapter::PdfExportAssetReaderAdapter {
          storage: storage.clone(),
        }));
        use myoxus_worker::JobHandler;
        handler
          .process(&myoxus_worker::Job {
            id: queued_id.to_string(),
            name: "pdf-export".into(),
            data: json!({"job_id": queued_id, "workspace_id": ws_id, "doc_id": doc_id,
      "template_id": template_id, "render_inputs": queued_inputs}),
            opts: Default::default(),
            timestamp: 0,
            attempts_made: 0,
            finished_on: None,
            failed_reason: None,
            heartbeat: None,
            return_value: None,
          })
          .await
          .expect("production queued PDF handler");
        let row =
          sqlx::query("SELECT status::text AS status, output_blob_id, page_count FROM pdf_export_jobs WHERE id = $1")
            .bind(queued_id)
            .fetch_one(&pool)
            .await
            .expect("completed queue row");
        assert_eq!(row.get::<String, _>("status"), "done");
        assert_eq!(i64::from(row.get::<i32, _>("page_count")), page_count);
        let queued_blob: Uuid = row.get("output_blob_id");
        let queued_key = myoxus_worker::pdf_export_handler::pdf_export_storage_key(ws_id, queued_blob);
        let queued_pdf = storage.read_blob(&queued_key).await.expect("queued PDF artifact");
        let queued_blob_key = format!("pdf-export/{queued_blob}");
        for uri in [
          format!("/api/workspaces/{ws_id}/blobs/{queued_blob_key}"),
          format!("/api/pdf-export/{queued_id}/download"),
        ] {
          let download = queued_app
            .clone()
            .oneshot(
              Request::builder()
                .method("GET")
                .uri(&uri)
                .header("cookie", format!("affine_session={session_id}"))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .expect("queued PDF download");
          assert_eq!(download.status().as_u16(), 200, "{uri}");
          assert_eq!(
            download.into_body().collect().await.unwrap().to_bytes().as_ref(),
            queued_pdf.data.as_ref()
          );
        }

        let queued_text = pdf_extract::extract_text_from_mem(&queued_pdf.data).expect("queued selectable text");
        assert_eq!(
          queued_text, pdf_text,
          "sync and worker must render identical content and selected inputs"
        );
        // A private persisted revision reaches the real handler without weakening
        // upload validation, which correctly rejects this finite expensive work.
        use myoxus_domain::repositories::PdfTemplateRepository;
        use myoxus_application::pdf_export::jobs::{PdfExportJobStore, PdfExportJobInsert};
        let templates = myoxus_infrastructure::pdf_export::PgPdfTemplateRepository::new(pool.clone());
        let mut expensive = templates.get_by_id(template_id).await.unwrap().unwrap();
        expensive.id = lifetime_template_id;
        expensive.slug = format!("lifetime-{}", lifetime_template_id.simple());
        expensive.manifest["id"] = json!(expensive.slug);
        expensive.created_by = Some(owner_id);
        let mut files = templates.list_files(template_id).await.unwrap();
        let blob_store = myoxus_infrastructure::pdf_export::PdfBlobStore::new(storage.operator());
        let (key, hash) = blob_store.put_template_revision_file(lifetime_template_id, "preamble.typ", b"#for n in range(10000) { for m in range(10000) { let s = str(n + m) } }").await.expect("expensive private revision");
        lifetime_blobs.push(key.clone());
        for file in &mut files {
          file.template_id = lifetime_template_id;
          if file.file_path == "preamble.typ" { file.blob_key = key.clone(); file.content_hash = hash.clone(); }
        }
        templates.create(&expensive, &files, None).await.expect("private template fixture");
        let jobs = myoxus_infrastructure::pdf_export::PgPdfExportJobStore::new(pool.clone());
        let failed_id = Uuid::new_v4();
        jobs.insert_queued(&PdfExportJobInsert { id: failed_id, workspace_id: ws_id, doc_id, requested_by: owner_id, template_id: lifetime_template_id.to_string(), render_inputs: queued_inputs.clone(), options_hash: format!("lifetime-{failed_id}") }).await.expect("isolated pending job");
        handler.limits.render_timeout = std::time::Duration::from_secs(1);
        handler.process(&myoxus_worker::Job {
          id: failed_id.to_string(), name: "pdf-export".into(),
          data: json!({"job_id": failed_id, "workspace_id": ws_id, "doc_id": doc_id, "template_id": lifetime_template_id, "render_inputs": queued_inputs}),
          opts: Default::default(), timestamp: 0, attempts_made: 0, finished_on: None, failed_reason: None, heartbeat: None, return_value: None,
        }).await.expect_err("production work must time out");
        let failed = jobs.get(failed_id).await.unwrap().unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.error_class.as_deref(), Some("Timeout"));
        assert!(failed.output_blob_id.is_none(), "timeout cannot publish an artifact");
        let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM pdf_export_render_audit WHERE job_id = $1").bind(failed_id).fetch_one(&pool).await.unwrap();
        assert_eq!(audits, 0, "failed execution cannot publish a success audit");
        handler.limits.render_timeout = std::time::Duration::from_secs(30);
        let marker = "private_doc_payload_marker";
        let (diagnostic_key, diagnostic_hash) = blob_store.put_template_revision_file(lifetime_template_id, "preamble.typ", format!("#{marker}").as_bytes()).await.unwrap();
        lifetime_blobs.push(diagnostic_key.clone());
        sqlx::query("UPDATE pdf_template_files SET blob_key = $1, content_hash = $2 WHERE template_id = $3 AND file_path = 'preamble.typ'").bind(&diagnostic_key).bind(&diagnostic_hash).bind(lifetime_template_id).execute(&pool).await.unwrap();
        let diagnostic_id = Uuid::new_v4();
        jobs.insert_queued(&PdfExportJobInsert { id: diagnostic_id, workspace_id: ws_id, doc_id, requested_by: owner_id, template_id: lifetime_template_id.to_string(), render_inputs: queued_inputs.clone(), options_hash: format!("lifetime-{diagnostic_id}") }).await.unwrap();
        let failure = handler.process(&myoxus_worker::Job {
          id: diagnostic_id.to_string(), name: "pdf-export".into(), data: json!({"job_id": diagnostic_id, "workspace_id": ws_id, "doc_id": doc_id, "template_id": lifetime_template_id, "render_inputs": queued_inputs}),
          opts: Default::default(), timestamp: 0, attempts_made: 0, finished_on: None, failed_reason: None, heartbeat: None, return_value: None,
        }).await.expect_err("private compile diagnostic");
        assert!(!failure.to_string().contains(marker), "outer queue failure must be safe to log");
        let diagnostic = jobs.get(diagnostic_id).await.unwrap().unwrap();
        assert_eq!(diagnostic.error_class.as_deref(), Some("RenderError"));
        assert!(diagnostic.error_detail.as_deref().unwrap().contains(marker), "protected operator detail retains diagnostics");
        assert!(diagnostic.output_blob_id.is_none());
        let original_files = templates.list_files(template_id).await.unwrap();
        let original_preamble = original_files.iter().find(|file| file.file_path == "preamble.typ").unwrap();
        let mut memory_source = blob_store.get_template_file(&original_preamble.blob_key).await.unwrap();
        memory_source.extend_from_slice(b"\n#let heap = range(12000000)");
        let (memory_key, memory_hash) = blob_store.put_template_revision_file(lifetime_template_id, "preamble.typ", &memory_source).await.unwrap();
        lifetime_blobs.push(memory_key.clone());
        sqlx::query("UPDATE pdf_template_files SET blob_key = $1, content_hash = $2 WHERE template_id = $3 AND file_path = 'preamble.typ'").bind(&memory_key).bind(&memory_hash).bind(lifetime_template_id).execute(&pool).await.unwrap();
        for budget in [1024, 512] {
          let memory_id = Uuid::new_v4();
          jobs.insert_queued(&PdfExportJobInsert { id: memory_id, workspace_id: ws_id, doc_id, requested_by: owner_id, template_id: lifetime_template_id.to_string(), render_inputs: queued_inputs.clone(), options_hash: format!("memory-{memory_id}") }).await.unwrap();
          handler.limits.max_memory_mb = budget;
          let result = handler.process(&myoxus_worker::Job {
            id: memory_id.to_string(), name: "pdf-export".into(), data: json!({"job_id": memory_id, "workspace_id": ws_id, "doc_id": doc_id, "template_id": lifetime_template_id, "render_inputs": queued_inputs}),
            opts: Default::default(), timestamp: 0, attempts_made: 0, finished_on: None, failed_reason: None, heartbeat: None, return_value: None,
          }).await;
          let job = jobs.get(memory_id).await.unwrap().unwrap();
          if budget == 1024 {
            result.expect("existing default must fit this same source");
            assert_eq!(job.status, "done");
            let bytes = storage.read_blob(&myoxus_worker::pdf_export_handler::pdf_export_storage_key(ws_id, job.output_blob_id.unwrap())).await.unwrap();
            assert_eq!(pdf_extract::extract_text_from_mem(&bytes.data).unwrap(), pdf_text);
          } else {
            result.expect_err("the configured smaller memory budget must exhaust execution");
            assert_eq!(job.status, "failed");
            assert_eq!(job.error_class.as_deref(), Some("TooLarge"));
            assert!(job.output_blob_id.is_none());
            let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM pdf_export_render_audit WHERE job_id = $1").bind(memory_id).fetch_one(&pool).await.unwrap();
            assert_eq!(audits, 0);
            let alive = helpers::gql(&queued_app, session_id, json!({"query":"{ __typename }"})).await;
            assert!(alive.get("errors").is_none(), "API must remain responsive after compiler exhaustion: {alive}");
          }
        }
        // Redispatch unchanged source and inputs under a fresh job identity. This
        // must execute again, rather than return either preceding cached job.
        let next_id = Uuid::new_v4();
        jobs.insert_queued(&PdfExportJobInsert { id: next_id, workspace_id: ws_id, doc_id, requested_by: owner_id, template_id: template_id.to_string(), render_inputs: queued_inputs.clone(), options_hash: format!("lifetime-{next_id}") }).await.unwrap();
        handler.limits = myoxus_worker::PdfExportLimits::default();
        handler.process(&myoxus_worker::Job {
          id: next_id.to_string(), name: "pdf-export".into(), data: json!({"job_id": next_id, "workspace_id": ws_id, "doc_id": doc_id, "template_id": template_id, "render_inputs": queued_inputs}),
          opts: Default::default(), timestamp: 0, attempts_made: 0, finished_on: None, failed_reason: None, heartbeat: None, return_value: None,
        }).await.expect("normal export after timeout");
        let next = jobs.get(next_id).await.unwrap().unwrap();
        assert_eq!(next.status, "done");
        let next_pdf = storage.read_blob(&myoxus_worker::pdf_export_handler::pdf_export_storage_key(ws_id, next.output_blob_id.unwrap())).await.unwrap();
        assert_eq!(pdf_extract::extract_text_from_mem(&next_pdf.data).unwrap(), pdf_text);
        storage.delete_blob(&queued_key).await.expect("remove queued artifact");
      })
      .catch_unwind()
      .await;
      cleanup_pdf_export_jobs(&pool, ws_id).await;
      sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
        .bind(lifetime_template_id)
        .execute(&pool)
        .await
        .expect("remove private template");
      for key in lifetime_blobs {
        use myoxus_application::ports::BlobStoragePort;
        myoxus_infrastructure::storage::StorageAdapter::new_fs("./test-storage")
          .unwrap()
          .delete_blob(&key)
          .await
          .expect("remove private source blob");
      }
      clear_pdf_export_theme_config(&pool, Some(ws_id)).await;
      helpers::cleanup_users(&pool, &[owner_id]).await;
      if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// PDFEXP-24: long rich documents cover document color policies and history.
//
// This is the regression gate for the user-visible failures that short
// paragraph-only tests missed: missing table text, unreadable glyphs,
// document-branding values not reaching Typst/render audit, and the sidebar
// Recent Exports query returning `invalid doc_id` despite successful exports.
// ---------------------------------------------------------------------------

#[test]
fn inv_pdfexp24_long_rich_doc_covers_brand_policies_and_history() {
  helpers::block_on_large_stack_multithread(
    "inv_pdfexp24_long_rich_doc_covers_brand_policies_and_history",
    2,
    || async {
      let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(500).await;
      let _guard = pdf_theme_config_guard().await;
      let admin_id = helpers::create_user(&pool, "pdfexp24-admin", true).await;
      let admin_session = helpers::create_session(&auth, admin_id).await;
      let owner_id = helpers::create_user(&pool, "pdfexp24-owner", false).await;
      let session_id = helpers::create_session(&auth, owner_id).await;
      let ws_id = helpers::create_workspace(&pool, owner_id).await;

      clear_pdf_export_theme_config(&pool, Some(ws_id)).await;
      set_pdf_export_global_theme(&pool, "wien").await;

      let logo = include_bytes!("../../../pdf_export/fixtures/edgeless_snapshot_4x4_red.png");
      let uploaded_logo =
        upload_document_brand_logo_via_graphql(&app, admin_session, ws_id, "Large", "doc-logo.png", "image/png", logo)
          .await;
      assert!(
        uploaded_logo.get("errors").is_none(),
        "PDFEXP-24: document logo upload must succeed: {uploaded_logo}"
      );

      let footer = helpers::gql(
        &app,
        admin_session,
        json!({
          "query": "mutation Footer($ws: ID!, $text: String) { admin { updateDocumentBrandingText(workspaceId: $ws, footerText: $text) { footerText logoLargeBlob } } }",
          "variables": {
            "ws": ws_id.to_string(),
            "text": "PDFEXP-24 Langdokument Footer"
          }
        }),
      )
      .await;
      assert!(
        footer.get("errors").is_none(),
        "PDFEXP-24: footer save must succeed: {footer}"
      );
      assert_eq!(
        footer
          .pointer("/data/admin/updateDocumentBrandingText/footerText")
          .and_then(Value::as_str),
        Some("PDFEXP-24 Langdokument Footer")
      );

      let paragraphs = long_pdf_architecture_doc_paragraphs()
        .into_iter()
        .take(90)
        .collect::<Vec<_>>();
      assert!(paragraphs.len() >= 90, "rich fixture precondition");

      for (policy, palette_key, custom_colors) in [
        ("theme_palette", Some("muted"), None),
        ("plain", Some("plain"), None),
        ("custom", None, Some(("#123456", "#654321"))),
      ] {
        if let Some((primary, accent)) = custom_colors {
          let custom = helpers::gql(
            &app,
            admin_session,
            json!({
              "query": "mutation Custom($ws: ID!, $primary: String, $accent: String) { admin { updateDocumentBrandingColors(workspaceId: $ws, primary: $primary, accent: $accent) { colorPolicy colorPaletteKey brandColorPrimary brandColorAccent brandColorRule } } }",
              "variables": {
                "ws": ws_id.to_string(),
                "primary": primary,
                "accent": accent
              }
            }),
          )
          .await;
          assert!(
            custom.get("errors").is_none(),
            "PDFEXP-24: custom color setup must succeed for {policy}: {custom}"
          );
        } else {
          let palette_key = palette_key.expect("palette policy has key");
          let palette = helpers::gql(
            &app,
            admin_session,
            json!({
              "query": "mutation Palette($ws: ID!, $policy: DocumentBrandColorPolicy!, $key: String!) { admin { setDocumentBrandingColorPolicy(workspaceId: $ws, policy: $policy, paletteKey: $key) { colorPolicy colorPaletteKey brandColorRule brandColorText brandColorBackground } } }",
              "variables": {
                "ws": ws_id.to_string(),
                "policy": policy,
                "key": palette_key
              }
            }),
          )
          .await;
          assert!(
            palette.get("errors").is_none(),
            "PDFEXP-24: palette setup must succeed for {policy}/{palette_key}: {palette}"
          );
        }

        let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
        let title = format!("PDFEXP-24 Rich {policy}");
        insert_doc_snapshot(&pool, ws_id, doc_id, build_rich_pdf_doc_yjs(&title, &paragraphs)).await;

        let resp = helpers::gql(
          &app,
          session_id,
          json!({
            "query": r#"
          mutation ExportPdf($input: PdfExportInputV2Input!) {
            exportPdf(input: $input) {
              id
              status
              pageCount
              downloadUrl
              unmappedFontFamilies
            }
          }
        "#,
            "variables": {
              "input": {
                "workspaceId": ws_id.to_string(),
                "docId": doc_id.to_string(),
                "templateId": "default",
                "typedInputs": { "title": title }
              }
            }
          }),
        )
        .await;
        assert!(
          resp.get("errors").is_none(),
          "PDFEXP-24: export must succeed for {policy}: {resp}"
        );
        let job = &resp["data"]["exportPdf"];
        assert_eq!(
          job["status"], "done",
          "PDFEXP-24: export must finish sync for {policy}: {resp}"
        );
        assert!(
          job["pageCount"].as_i64().unwrap_or_default() >= 2,
          "PDFEXP-24: rich long document must be multi-page for {policy}: {resp}"
        );
        assert_eq!(
          job["unmappedFontFamilies"],
          json!([]),
          "PDFEXP-24: theme fonts must fully resolve for {policy}: {resp}"
        );
        let download_url = job["downloadUrl"]
          .as_str()
          .unwrap_or_else(|| panic!("PDFEXP-24: downloadUrl missing for {policy}: {resp}"));
        let job_id: Uuid = job["id"]
          .as_str()
          .unwrap_or_else(|| panic!("PDFEXP-24: job id missing for {policy}: {resp}"))
          .parse()
          .expect("job id parses");

        let render_inputs: Value = sqlx::query_scalar("SELECT render_inputs FROM pdf_export_jobs WHERE id = $1")
          .bind(job_id)
          .fetch_one(&pool)
          .await
          .expect("job row exists");
        assert_eq!(
          render_inputs.pointer("/document_branding/color_policy"),
          Some(&json!(policy)),
          "PDFEXP-24: render_inputs must carry document color policy for {policy}: {render_inputs}"
        );
        if let Some(key) = palette_key {
          assert_eq!(
            render_inputs.pointer("/document_branding/color_palette_key"),
            Some(&json!(key)),
            "PDFEXP-24: render_inputs must carry palette key for {policy}: {render_inputs}"
          );
        } else {
          assert!(
            render_inputs
              .pointer("/document_branding/color_palette_key")
              .is_some_and(Value::is_null),
            "PDFEXP-24: custom policy must not keep a palette key: {render_inputs}"
          );
        }
        assert_eq!(
          render_inputs.pointer("/document_branding/footer_text"),
          Some(&json!("PDFEXP-24 Langdokument Footer")),
          "PDFEXP-24: render_inputs must carry document footer for {policy}: {render_inputs}"
        );
        assert!(
          render_inputs
            .pointer("/document_branding/logo_large_blob")
            .and_then(Value::as_str)
            .is_some_and(|blob| blob.starts_with("pdf-brand/")),
          "PDFEXP-24: render_inputs must carry document logo blob for {policy}: {render_inputs}"
        );
        assert!(
          render_inputs
            .pointer("/document_branding/rule")
            .and_then(Value::as_str)
            .is_some_and(|value| value.starts_with('#')),
          "PDFEXP-24: render_inputs must carry resolved rule color for {policy}: {render_inputs}"
        );

        let audit_l3: Value = sqlx::query_scalar("SELECT l3_inputs FROM pdf_export_render_audit WHERE job_id = $1")
          .bind(job_id)
          .fetch_one(&pool)
          .await
          .unwrap_or_else(|err| panic!("PDFEXP-24: render audit row missing for {policy}: {err}"));
        assert_eq!(
          audit_l3.pointer("/document_branding/color_policy"),
          Some(&json!(policy)),
          "PDFEXP-24: audit L3 inputs must carry document color policy for {policy}: {audit_l3}"
        );
        assert_eq!(
          audit_l3.pointer("/document_branding/footer_text"),
          Some(&json!("PDFEXP-24 Langdokument Footer")),
          "PDFEXP-24: audit L3 inputs must carry document footer for {policy}: {audit_l3}"
        );

        let history = helpers::gql(
          &app,
          session_id,
          json!({
            "query": r#"
          query History($workspaceId: String!, $docId: String!) {
            documentPdfExportHistory(workspaceId: $workspaceId, docId: $docId, limit: 5) {
              id
              docId
              status
              downloadUrl
              pageCount
              renderInputs
            }
          }
        "#,
            "variables": { "workspaceId": ws_id.to_string(), "docId": doc_id.to_string() }
          }),
        )
        .await;
        assert!(
          history.get("errors").is_none(),
          "PDFEXP-24: Recent Exports history must accept exported doc id for {policy}: {history}"
        );
        let rows = history["data"]["documentPdfExportHistory"]
          .as_array()
          .unwrap_or_else(|| panic!("PDFEXP-24: history rows missing for {policy}: {history}"));
        assert_eq!(
          rows.len(),
          1,
          "PDFEXP-24: history must return one row for {policy}: {history}"
        );
        assert_eq!(rows[0]["id"].as_str(), Some(job_id.to_string().as_str()));
        assert_eq!(rows[0]["status"].as_str(), Some("done"));
        assert_eq!(rows[0]["docId"].as_str(), Some(doc_id.to_string().as_str()));
        assert!(
          rows[0]["downloadUrl"].as_str().is_some_and(|url| url == download_url),
          "PDFEXP-24: history row must expose the same download URL for {policy}: {history}"
        );
        assert!(
          rows[0]["pageCount"].as_i64().unwrap_or_default() >= 2,
          "PDFEXP-24: history row must carry pageCount for {policy}: {history}"
        );
        assert_eq!(
          rows[0]["renderInputs"]["document_branding"]["color_policy"],
          json!(policy),
          "PDFEXP-24: history renderInputs must carry policy for {policy}: {history}"
        );

        let download = app
          .clone()
          .oneshot(
            Request::builder()
              .method("GET")
              .uri(download_url)
              .header("cookie", format!("affine_session={session_id}"))
              .body(Body::empty())
              .unwrap(),
          )
          .await
          .unwrap();
        assert_eq!(
          download.status().as_u16(),
          200,
          "PDFEXP-24: rich-doc download must succeed for {policy}"
        );
        let body_bytes = download.into_body().collect().await.unwrap().to_bytes();
        assert!(
          body_bytes.starts_with(b"%PDF-"),
          "PDFEXP-24: body must be a PDF for {policy}"
        );
        assert!(
          body_bytes.len() > 18_000,
          "PDFEXP-24: rich PDF should be non-trivial for {policy}, got {} bytes",
          body_bytes.len()
        );
        let pdf_text =
          pdf_extract::extract_text_from_mem(&body_bytes).expect("PDFEXP-24: rich PDF text must be extractable");
        let normalized_pdf_text = pdf_text
          .replace("\\_", "_")
          .split_whitespace()
          .collect::<Vec<_>>()
          .join(" ");
        for expected in [
          title.as_str(),
          "Sonderzeichen",
          "äöü",
          "€",
          "✓",
          "Tabellen-Gate",
          "42",
          "fn main",
          "pdf_export_jobs",
          "https://example.org/pdf-export",
        ] {
          assert!(
            normalized_pdf_text.contains(expected),
            "PDFEXP-24: extracted PDF text for {policy} must contain `{expected}`:\n{pdf_text}"
          );
        }
        assert!(
          !pdf_text.contains("Canvas snapshot not available"),
          "PDFEXP-24: page-mode rich export must not leak edgeless placeholder for {policy}:\n{pdf_text}"
        );
      }

      cleanup_pdf_export_jobs(&pool, ws_id).await;
      clear_pdf_export_theme_config(&pool, Some(ws_id)).await;
      helpers::cleanup_users(&pool, &[owner_id, admin_id]).await;
    },
  );
}

// ---------------------------------------------------------------------------
// PDFEXP-23: Edgeless snapshot export resolves the uploaded workspace blob.
//
// Regression target: the shared PDF pipeline used a NullAssetResolver while
// the editor correctly wrote `exportSnapshotBlobId/Width/Height`. Real
// edgeless exports therefore rendered the placeholder text instead of the
// captured canvas. This test exercises the production path:
// GraphQL setBlob -> Yjs snapshot props -> exportPdf sync render -> REST
// download, then asserts an image XObject and no placeholder text.
// ---------------------------------------------------------------------------

#[test]
fn inv_pdfexp23_edgeless_snapshot_export_embeds_uploaded_canvas() {
  helpers::block_on_large_stack_multithread(
    "inv_pdfexp23_edgeless_snapshot_export_embeds_uploaded_canvas",
    2,
    || async {
      let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(50).await;
      let _guard = pdf_theme_config_guard().await;
      let owner_id = helpers::create_user(&pool, "pdfexp23", false).await;
      let session_id = helpers::create_session(&auth, owner_id).await;
      let ws_id = helpers::create_workspace(&pool, owner_id).await;
      let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
      let png = include_bytes!("../../../pdf_export/fixtures/edgeless_snapshot_4x4_red.png");
      let blob_key = format!("edgeless-snapshot-{}.png", Uuid::new_v4().simple());
      let uploaded_key = upload_workspace_blob_via_graphql(&app, session_id, ws_id, &blob_key, "image/png", png).await;
      assert_eq!(uploaded_key, blob_key, "setBlob must return the key stored in Yjs");

      insert_doc_snapshot(&pool, ws_id, doc_id, build_edgeless_pdf_doc_yjs(&uploaded_key, 4, 4)).await;
      clear_pdf_export_theme_config(&pool, Some(ws_id)).await;
      set_pdf_export_global_theme(&pool, "wien").await;

      let resp = helpers::gql(
        &app,
        session_id,
        json!({
          "query": r#"
          mutation ExportPdf($input: PdfExportInputV2Input!) {
            exportPdf(input: $input) {
              id
              status
              pageCount
              downloadUrl
            }
          }
        "#,
          "variables": {
            "input": {
              "workspaceId": ws_id.to_string(),
              "docId": doc_id.to_string(),
              "templateId": "default",
              "typedInputs": { "title": "Edgeless PDF Export" }
            }
          }
        }),
      )
      .await;
      assert!(resp.get("errors").is_none(), "edgeless sync mutation failed: {resp}");
      let job = &resp["data"]["exportPdf"];
      assert_eq!(
        job["status"], "done",
        "edgeless export must finish in sync path: {resp}"
      );
      assert!(
        job["pageCount"].as_i64().unwrap_or_default() >= 1,
        "edgeless export must report a rendered page count: {resp}"
      );
      let download_url = job["downloadUrl"]
        .as_str()
        .expect("downloadUrl must be set for sync done export");

      let download = app
        .clone()
        .oneshot(
          Request::builder()
            .method("GET")
            .uri(download_url)
            .header("cookie", format!("affine_session={session_id}"))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
      assert_eq!(download.status().as_u16(), 200, "edgeless download must succeed");
      let body_bytes = download.into_body().collect().await.unwrap().to_bytes();
      assert!(body_bytes.starts_with(b"%PDF-"), "edgeless body must be a PDF");
      let pdf = lopdf::Document::load_mem(&body_bytes).expect("edgeless response must be a parseable PDF");
      assert!(
        pdf.objects.values().any(|object| {
          let lopdf::Object::Stream(stream) = object else {
            return false;
          };
          stream
            .dict
            .get(b"Subtype")
            .and_then(lopdf::Object::as_name)
            .is_ok_and(|name| name == b"Image")
        }),
        "edgeless PDF must contain an embedded image XObject"
      );
      let pdf_text = pdf_extract::extract_text_from_mem(&body_bytes).expect("edgeless PDF text must be extractable");
      assert!(
        pdf_text.contains("Edgeless canvas export"),
        "edgeless PDF must contain the surrounding document text, extracted:\n{pdf_text}"
      );
      assert!(
        !pdf_text.contains("Canvas snapshot not available"),
        "edgeless export must not render the missing-snapshot placeholder, extracted:\n{pdf_text}"
      );

      cleanup_pdf_export_jobs(&pool, ws_id).await;
      cleanup_workspace_blob(&pool, ws_id, &uploaded_key).await;
      clear_pdf_export_theme_config(&pool, Some(ws_id)).await;
      helpers::cleanup_users(&pool, &[owner_id]).await;
    },
  );
}

/// MCP journeys use the same production router, PDF pipeline and download
/// boundary as GraphQL. SQL faults occur after immutable source capture, rather
/// than replacing the behavior under test with an always-successful mock.
mod mcp_export {
  use super::*;
  use futures_util::FutureExt;
  use myoxus_application::api_key::ApiKeyService;
  use myoxus_infrastructure::api_key::SqlxApiKeyStore;
  use std::panic::AssertUnwindSafe;

  fn with_omissions(payload: Vec<u8>, missing_image: bool) -> Vec<u8> {
    use yrs::updates::decoder::Decode;
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    let mut txn = doc.transact_mut();
    txn.apply_update(yrs::Update::decode_v1(&payload).unwrap()).unwrap();
    let Some(yrs::Out::YMap(page)) = blocks.get(&txn, "page-1") else {
      panic!("fixture page");
    };
    let Some(yrs::Out::YArray(children)) = page.get(&txn, "sys:children") else {
      panic!("fixture children");
    };
    for (id, flavour) in [
      (
        "missing-object",
        if missing_image { "myoxus:image" } else { "myoxus:frame" },
      ),
      ("future-block", "myoxus:future-block"),
    ] {
      let block = blocks.insert(&mut txn, id, yrs::MapPrelim::default());
      block.insert(&mut txn, "sys:flavour", flavour);
      block.insert(&mut txn, "prop:sourceId", "private/missing.png");
      block.insert(&mut txn, "prop:text", yrs::TextPrelim::new("Unknown block fallback"));
      children.push_back(&mut txn, id);
    }
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
  }

  async fn key(pool: &sqlx::PgPool, user: Uuid, scopes: &[&str]) -> (Uuid, String) {
    let (key, raw) = ApiKeyService::new(Arc::new(SqlxApiKeyStore::new(pool.clone())))
      .generate(
        user,
        "mcp-pdf-contract".into(),
        scopes.iter().map(|s| s.to_string()).collect(),
        None,
      )
      .await
      .expect("generate authenticated MCP key");
    (key.id, raw)
  }

  async fn rpc(app: &axum::Router, key: &str, tool: &str, args: Value) -> Value {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .method("POST")
          .uri("/mcp")
          .header("authorization", format!("Bearer {key}"))
          .header("content-type", "application/json")
          .body(Body::from(
            json!({"jsonrpc":"2.0", "id":1, "method":"tools/call",
        "params":{"name":tool,"arguments":args}})
            .to_string(),
          ))
          .unwrap(),
      )
      .await
      .unwrap();
    assert_eq!(response.status(), 200);
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
  }

  fn success(value: &Value) -> Value {
    assert!(value.get("error").is_none(), "JSON-RPC failure: {value}");
    assert_ne!(value["result"]["isError"], true, "MCP tool failure: {value}");
    let content = value["result"]["structuredContent"].clone();
    assert!(content.is_object(), "structured PDF result: {value}");
    assert_eq!(
      serde_json::from_str::<Value>(value["result"]["content"][0]["text"].as_str().unwrap()).unwrap(),
      content
    );
    content
  }

  async fn download(app: &axum::Router, id: Uuid, bearer: Option<&str>, session: Option<Uuid>) -> (u16, Vec<u8>) {
    let mut request = Request::builder().uri(format!("/api/pdf-export/{id}/download"));
    if let Some(bearer) = bearer {
      request = request.header("authorization", format!("Bearer {bearer}"));
    }
    if let Some(session) = session {
      request = request.header("cookie", format!("affine_session={session}"));
    }
    let response = app.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status().as_u16();
    if status == 200 {
      assert_eq!(response.headers()["content-type"], "application/pdf");
    }
    let error_class = response
      .headers()
      .get("x-pdf-export-error-class")
      .map(|value| value.to_str().unwrap().to_owned());
    let bytes = response.into_body().collect().await.unwrap().to_bytes().to_vec();
    if status == 410 {
      let body: Value = serde_json::from_slice(&bytes).unwrap();
      assert_eq!(
        error_class.as_deref(),
        body["error_class"].as_str(),
        "terminal download class is stable in header and body"
      );
      assert!(error_class.is_some());
    }
    (status, bytes)
  }

  fn complete_pdf_text(bytes: &[u8]) -> String {
    let pdf = lopdf::Document::load_mem(bytes).expect("valid downloaded PDF");
    let pages = pdf.get_pages().keys().copied().collect::<Vec<_>>();
    pdf
      .extract_text(&pages)
      .expect("complete Unicode text from every PDF page")
  }

  async fn assignments(pool: &sqlx::PgPool, ws: Uuid) -> Vec<(Uuid, bool)> {
    sqlx::query_as("SELECT template_id, is_default FROM pdf_workspace_template_assignments WHERE workspace_id=$1 ORDER BY template_id")
      .bind(ws).fetch_all(pool).await.unwrap()
  }

  async fn finish(pool: &sqlx::PgPool, ws: Uuid, users: &[Uuid]) {
    cleanup_pdf_export_jobs(pool, ws).await;
    helpers::cleanup_users(pool, users).await;
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id=ANY($1)")
      .bind(users)
      .fetch_one(pool)
      .await
      .unwrap();
    assert_eq!(remaining, 0, "fixture cleanup must not silently fail");
  }

  #[test]
  fn authenticated_sync_defaults_typed_content_replay_acl_and_expiry() {
    helpers::block_on_large_stack_multithread("mcp-pdf-sync-contract", 2, || async {
      let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(100).await;
      let user = helpers::create_user(&pool, "mcp-pdf-sync", false).await;
      let reader = helpers::create_user(&pool, "mcp-pdf-doc-reader", false).await;
      let session = helpers::create_session(&auth, user).await;
      let ws = helpers::create_workspace(&pool, user).await;
      let doc = helpers::create_doc(&pool, ws, user).await;
      let ack = format!("mcp_pdf_ack_{}", Uuid::new_v4().simple());
      let outcome = AssertUnwindSafe(async {
        let external = "mcp-pdf-external-source";
        sqlx::query("UPDATE docs SET external_id=$2 WHERE id=$1")
          .bind(doc)
          .bind(external)
          .execute(&pool)
          .await
          .unwrap();
        insert_doc_snapshot(
          &pool,
          ws,
          doc,
          with_omissions(build_pdf_doc_yjs_from_paragraphs("Native PDF source", &["Pinned original body marker.".into()]), false),
        )
        .await;
        // Workspaces created after startup receive assignments from the same
        // existing provisioning owner; MCP itself may only consume them.
        myoxus_infrastructure::pdf_export::ensure_default_pdf_template_assignments(&pool)
          .await
          .unwrap();
        use myoxus_domain::repositories::PdfWorkspaceTemplateAssignmentRepository;
        myoxus_infrastructure::pdf_export::PgPdfWorkspaceTemplateAssignmentRepository::new(pool.clone())
          .assign(ws, myoxus_infrastructure::pdf_export::system_template_id("report"), user, None)
          .await
          .unwrap();
        let before = assignments(&pool, ws).await;
        let (key_id, raw) = key(&pool, user, &["read:docs"]).await;
        let (_, wrong_scope) = key(&pool, user, &["read:workspaces"]).await;
        let args = json!({"workspace_id":ws,"external_id":external,"idempotency_key":"explicit-report",
        "template_id":"report", "locale":"de", "image_quality":"med", "paper_size":"A4",
        "orientation":"portrait", "compliance_profile":"standard", "toc_behavior":"off", "cover_page":true,
        "typed_inputs":{"title":"Typed report title", "executive_summary":"Typed summary marker."}});
        sqlx::query(&format!("CREATE FUNCTION {ack}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.mutation_committed AND NEW.api_key_id='{key_id}'::uuid AND NEW.tool_name='pdf_export_create' AND NEW.completed_at IS NOT NULL THEN RAISE EXCEPTION 'owned PDF acknowledgement lost'; END IF; RETURN NEW; END $$")).execute(&pool).await.unwrap();
        sqlx::query(&format!("CREATE TRIGGER {ack} BEFORE UPDATE ON mcp_idempotency_keys FOR EACH ROW EXECUTE FUNCTION {ack}()" )).execute(&pool).await.unwrap();
        let interrupted=rpc(&app,&raw,"pdf_export_create",args.clone()).await;
        assert_eq!(interrupted["result"]["structuredContent"]["code"],"RECOVERY_REQUIRED", "real post-commit acknowledgement failure: {interrupted}");
        let receipt: Value=sqlx::query_scalar("SELECT response_json FROM mcp_idempotency_keys WHERE api_key_id=$1 AND tool_name='pdf_export_create' AND mutation_committed")
          .bind(key_id).fetch_one(&pool).await.unwrap();
        let created = success(&rpc(&app, &raw, "pdf_export_create", args.clone()).await);
        assert_eq!(created,serde_json::from_str::<Value>(receipt["content"][0]["text"].as_str().unwrap()).unwrap(),"retry exposes the committed PDF receipt");
        sqlx::query(&format!("DROP TRIGGER {ack} ON mcp_idempotency_keys")).execute(&pool).await.unwrap();
        sqlx::query(&format!("DROP FUNCTION {ack}()")).execute(&pool).await.unwrap();
        assert_eq!(created["status"], "done");
        assert_eq!(created["execution"], "sync");
        assert_eq!(created["externalId"], external);
        assert_eq!(created["source"]["revision"]["kind"], "yjs_sha256");
        assert_eq!(created["source"]["revision"]["value"].as_str().unwrap().len(), 64);
        assert_eq!(created["diagnostics"]["coverage"], "pipeline_reported");
        assert_eq!(created["diagnostics"]["findings"], json!([{ "code":"missing_canvas_snapshot","count":1},{"code":"unsupported_block","count":1}]));
        let id: Uuid = created["jobId"].as_str().unwrap().parse().unwrap();
        sqlx::query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status,joined_at) VALUES($1,$2,'External','Accepted',now())")
          .bind(ws).bind(reader).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO doc_user_permissions(user_id,doc_id,role) VALUES($1,$2,'Reader')")
          .bind(reader).bind(doc).execute(&pool).await.unwrap();
        let (_, reader_key) = key(&pool, reader, &["read:docs"]).await;
        let reader_session = helpers::create_session(&auth, reader).await;
        assert_eq!(download(&app,id,Some(&reader_key),None).await.0,200,"another authorized document reader may download");
        assert_eq!(download(&app,id,None,Some(reader_session)).await.0,200);
        assert_eq!(success(&rpc(&app,&reader_key,"pdf_export_get",json!({"job_id":id})).await)["jobId"],json!(id));
        sqlx::query("DELETE FROM doc_user_permissions WHERE user_id=$1 AND doc_id=$2").bind(reader).bind(doc).execute(&pool).await.unwrap();
        let membership: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_memberships WHERE user_id=$1 AND workspace_id=$2 AND status='Accepted')")
          .bind(reader).bind(ws).fetch_one(&pool).await.unwrap();
        assert!(membership,"document denial is isolated from workspace membership");
        assert_eq!(download(&app,id,Some(&reader_key),None).await.0,403,"current document ACL, not historical requester identity");
        assert_eq!(download(&app,id,None,Some(reader_session)).await.0,403);
        for (tool,args) in [("pdf_export_get",json!({"job_id":id})),("pdf_export_create",json!({"workspace_id":ws,"external_id":external,
          "idempotency_key":"denied-doc","typed_inputs":{"title":"Denied read"}}))] {
          let denied=rpc(&app,&reader_key,tool,args).await;
          assert_eq!(denied["result"]["structuredContent"]["code"],"PERMISSION_DENIED","{denied}");
        }
        assert!(
          created["delivery"]["url"]
            .as_str()
            .unwrap()
            .ends_with(&format!("/api/pdf-export/{id}/download"))
        );
        let (status, bytes) = download(&app, id, Some(&raw), None).await;
        assert_eq!(status, 200);
        let text = complete_pdf_text(&bytes);
        for marker in [
          "Pinned original body marker",
          "Typed report title",
          "Typed summary marker",
          "Unknown block fallback",
          "Canvas snapshot not available",
        ] {
          assert!(text.contains(marker), "actual PDF must contain {marker}: {text}");
        }
        assert_eq!(
          download(&app, id, None, Some(session)).await.0,
          200,
          "same session user"
        );
        assert_eq!(
          download(&app, id, Some(&wrong_scope), Some(session)).await.0,
          403,
          "bad bearer cannot fall back to valid cookie"
        );
        assert_eq!(download(&app, id, Some("myoxus_invalid"), Some(session)).await.0, 401);
        sqlx::query("UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1").bind(key_id).execute(&pool).await.unwrap();
        assert_eq!(download(&app,id,Some(&raw),None).await.0,401,"expired API key");
        sqlx::query("UPDATE api_keys SET expires_at=NULL WHERE id=$1").bind(key_id).execute(&pool).await.unwrap();
        sqlx::query("UPDATE doc_snapshots SET payload=$2 WHERE doc_id=$1")
          .bind(doc)
          .bind(build_pdf_doc_yjs_from_paragraphs(
            "Later source",
            &["Newer body must not replace retry.".into()],
          ))
          .execute(&pool)
          .await
          .unwrap();
        assert_eq!(
          success(&rpc(&app, &raw, "pdf_export_create", args.clone()).await),
          created
        );
        assert_eq!(download(&app, id, Some(&raw), None).await.1, bytes);
        let mut conflict = args.clone();
        conflict["paper_size"] = json!("A5");
        let conflict = rpc(&app, &raw, "pdf_export_create", conflict).await;
        assert!(
          conflict["result"]["isError"] == true || conflict.get("error").is_some(),
          "key conflict: {conflict}"
        );
        let default = success(
          &rpc(
            &app,
            &raw,
            "pdf_export_create",
            json!({"workspace_id":ws,"external_id":external,
        "idempotency_key":"assigned-default", "typed_inputs":{"title":"Assigned default title"}}),
          )
          .await,
        );
        let default_id = before.iter().find(|(_, default)| *default).unwrap().0;
        assert_eq!(default["templateId"], json!(default_id));
        let captured:Value=sqlx::query_scalar("SELECT render_inputs FROM pdf_export_jobs WHERE id=$1").bind(default["jobId"].as_str().unwrap().parse::<Uuid>().unwrap()).fetch_one(&pool).await.unwrap();
        assert_eq!(captured["compliance_profile"],"pdfa-2u");
        assert_eq!(assignments(&pool, ws).await, before, "MCP may not change assignments");
        for field in ["paper_size", "orientation", "image_quality", "compliance_profile"] {
          let mut invalid = args.clone();
          invalid["idempotency_key"] = json!(format!("invalid-{field}"));
          invalid[field] = json!("invalid");
          let result = rpc(&app, &raw, "pdf_export_create", invalid).await;
          assert!(
            result["result"]["isError"] == true || result.get("error").is_some(),
            "canonical validation: {result}"
          );
          assert!(result.to_string().contains(field), "actionable field error: {result}");
        }
        for invalid in [json!({"workspace_id":ws,"external_id":external}),
          json!({"workspace_id":ws,"external_id":external,"idempotency_key":""}),
          json!({"workspace_id":ws,"external_id":external,"idempotency_key":"unexpected","unexpected":true})] {
          let response=rpc(&app,&raw,"pdf_export_create",invalid).await;
          assert!(response["result"]["isError"]==true || response.get("error").is_some());
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pdf_export_jobs WHERE workspace_id=$1")
          .bind(ws)
          .fetch_one(&pool)
          .await
          .unwrap();
        assert_eq!(count, 2, "validation and key conflict must create no jobs");
        sqlx::query("UPDATE doc_snapshots SET payload=$2 WHERE doc_id=$1").bind(doc)
          .bind(with_omissions(build_pdf_doc_yjs_from_paragraphs("Broken stored asset", &["Visible body remains intact.".into()]), true))
          .execute(&pool).await.unwrap();
        let failed = rpc(&app, &raw, "pdf_export_create", json!({"workspace_id":ws,"external_id":external,
          "idempotency_key":"missing-asset-sync","typed_inputs":{"title":"Missing asset title"}})).await;
        assert_eq!(failed["result"]["structuredContent"]["code"], "PDF_EXPORT_FAILED");
        let failure: Value = serde_json::from_str(failed["result"]["structuredContent"]["message"].as_str().unwrap()).unwrap();
        assert_eq!(failure["class"], "RenderError");
        assert_eq!(failure["diagnostics"],json!({"coverage":"pipeline_reported","findings":[{"code":"missing_asset","count":1},{"code":"unsupported_block","count":1}]}));
        assert!(!failed.to_string().contains("private/missing.png"), "private paths never enter the tool error");
        let count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pdf_export_jobs WHERE workspace_id=$1").bind(ws).fetch_one(&pool).await.unwrap();
        assert_eq!(count_after, count, "a failed sync render must not publish a successful job");
        sqlx::query("UPDATE pdf_export_jobs SET expires_at=now()-interval '1 second' WHERE id=$1")
          .bind(id)
          .execute(&pool)
          .await
          .unwrap();
        let expired = success(&rpc(&app, &raw, "pdf_export_get", json!({"job_id":id})).await);
        assert_eq!(expired["delivery"]["available"], false);
        assert!(expired["delivery"]["url"].is_null());
        let (status, body) = download(&app, id, Some(&raw), None).await;
        assert_eq!(status, 410);
        assert!(!body.starts_with(b"%PDF"));
        sqlx::query("DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2")
          .bind(ws)
          .bind(user)
          .execute(&pool)
          .await
          .unwrap();
        assert_eq!(
          download(&app, id, Some(&raw), None).await.0,
          403,
          "requester privilege cannot bypass current workspace ACL"
        );
        assert_eq!(download(&app, id, None, Some(session)).await.0, 403);
        let denied = rpc(&app, &raw, "pdf_export_create", args).await;
        assert!(
          denied["result"]["isError"] == true || denied.get("error").is_some(),
          "replay needs current permission"
        );
        ApiKeyService::new(Arc::new(SqlxApiKeyStore::new(pool.clone())))
          .delete(key_id)
          .await
          .unwrap();
        assert_eq!(download(&app, id, Some(&raw), None).await.0, 401, "revoked key");
      })
      .catch_unwind()
      .await;
      sqlx::query(&format!("DROP TRIGGER IF EXISTS {ack} ON mcp_idempotency_keys"))
        .execute(&pool)
        .await
        .unwrap();
      sqlx::query(&format!("DROP FUNCTION IF EXISTS {ack}()"))
        .execute(&pool)
        .await
        .unwrap();
      finish(&pool, ws, &[user, reader]).await;
      if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
      }
    });
  }

  #[test]
  fn source_capture_survives_sql_rollback_client_abort_and_queued_render() {
    helpers::block_on_large_stack_multithread("mcp-pdf-abort-contract", 2, || async {
      let redis_url = std::env::var("TEST_REDIS_URL").unwrap();
      let prefix = format!("mcp-pdf-test-{}", Uuid::new_v4().simple());
      let queue = myoxus_worker::RedisQueue::new(&redis_url, &prefix).unwrap();
      let (app, pool, _) = helpers::setup_app_with_pdf_queue(0, queue.clone()).await;
      // The production fixture intentionally has only two SQL connections.
      // Keep fault coordination outside that pool so observing a blocked writer
      // cannot itself wait behind the transaction being observed.
      let observer = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&std::env::var("TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
      let user = helpers::create_user(&pool, "mcp-pdf-abort", false).await;
      let ws = helpers::create_workspace(&pool, user).await;
      let doc = helpers::create_doc(&pool, ws, user).await;
      let suffix = Uuid::new_v4().simple().to_string();
      let function = format!("mcp_pdf_fault_{suffix}");
      let trigger = format!("mcp_pdf_trigger_{suffix}");
      let outcome = AssertUnwindSafe(async {
      insert_doc_snapshot(
        &pool,
        ws,
        doc,
        with_omissions(build_pdf_doc_yjs_from_paragraphs("Pinned queue source", &["Original queued content marker.".into()]), false),
      )
      .await;
      myoxus_infrastructure::pdf_export::ensure_default_pdf_template_assignments(&pool)
        .await
        .unwrap();
      sqlx::query("INSERT INTO document_versioning_settings (doc_id,enabled,auto_version_on,retention_count) VALUES ($1,true,ARRAY['on-pdf-export'],25)")
        .bind(doc).execute(&pool).await.unwrap();
      let (_, raw) = key(&pool, user, &["read:docs"]).await;
      let args = json!({"workspace_id":ws,"external_id":doc,"idempotency_key":"abort-exact-source","document_version_id":"latest","typed_inputs":{"title":"Pinned queue source"}});

      let sql = format!(
        "CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='{ws}'::uuid THEN RAISE EXCEPTION 'owned PDF job rollback'; END IF; RETURN NEW; END $$"
      );
      sqlx::query(&sql).execute(&pool).await.unwrap();
      sqlx::query(&format!(
        "CREATE TRIGGER {trigger} BEFORE INSERT ON pdf_export_jobs FOR EACH ROW EXECUTE FUNCTION {function}()"
      ))
      .execute(&pool)
      .await
      .unwrap();
      let failed = rpc(&app, &raw, "pdf_export_create", args.clone()).await;
      assert!(
        failed["result"]["isError"] == true || failed.get("error").is_some(),
        "real SQL rollback: {failed}"
      );
      let histories: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_histories WHERE doc_id=$1")
        .bind(doc)
        .fetch_one(&pool)
        .await
        .unwrap();
      assert_eq!(histories, 1, "captured source survives the job rollback: {failed}");
      sqlx::query("UPDATE doc_snapshots SET payload=$2 WHERE doc_id=$1")
        .bind(doc)
        .bind(build_pdf_doc_yjs_from_paragraphs(
          "Newer source",
          &["Newer content must not leak into old request.".into()],
        ))
        .execute(&pool)
        .await
        .unwrap();
      // Block the real INSERT behind a transaction-owned lock. Observing its
      // wait establishes that immutable capture and admission already happened.
      let lock_id = i64::from_be_bytes(doc.as_bytes()[..8].try_into().unwrap()) & i64::MAX;
      let mut blocker = observer.begin().await.unwrap();
      sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(lock_id)
        .execute(&mut *blocker)
        .await
        .unwrap();
      sqlx::query(&format!("CREATE OR REPLACE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='{ws}'::uuid THEN PERFORM pg_advisory_xact_lock({lock_id}); END IF; RETURN NEW; END $$")).execute(&pool).await.unwrap();
      let app_request = app.clone();
      let raw_request = raw.clone();
      let args_request = args.clone();
      let waiter =
        tokio::spawn(async move { rpc(&app_request, &raw_request, "pdf_export_create", args_request).await });
      tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
          let waiting: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid::bigint=$1)",
          )
          .bind(lock_id & 0xffff_ffff)
          .fetch_one(&observer)
          .await
          .unwrap();
          if waiting {
            break;
          }
          tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
      })
      .await
      .expect("PDF insert reached owned lock");
      waiter.abort();
      assert!(waiter.await.unwrap_err().is_cancelled());
      // Exceed the renewal period while the job transaction holds its MCP
      // receipt row. The old inline await deadlocks after the blocker releases.
      tokio::time::sleep(std::time::Duration::from_secs(16)).await;
      let mut redis=redis::Client::open(redis_url.as_str()).unwrap().get_multiplexed_async_connection().await.unwrap();
      let wait_key=format!("{prefix}:pdf-export:wait");
      let _: ()=redis::cmd("SET").arg(&wait_key).arg("owned-wrong-type").query_async(&mut redis).await.unwrap();
      blocker.commit().await.unwrap();
      tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
          let complete: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM mcp_idempotency_keys WHERE user_id=$1 AND tool_name='pdf_export_create' AND mutation_committed)")
            .bind(user).fetch_one(&pool).await.unwrap();
          if complete { break; }
          tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
      }).await.expect("admitted creation finishes after HTTP abort");
      sqlx::query(&format!("DROP TRIGGER {trigger} ON pdf_export_jobs"))
        .execute(&pool)
        .await
        .unwrap();
      sqlx::query(&format!("DROP FUNCTION {function}()"))
        .execute(&pool)
        .await
        .unwrap();
      let persisted_id: Uuid=sqlx::query_scalar("SELECT id FROM pdf_export_jobs WHERE workspace_id=$1").bind(ws).fetch_one(&pool).await.unwrap();
      tokio::time::timeout(std::time::Duration::from_secs(20),async {
        while queue.get_job("pdf-export",&persisted_id.to_string()).await.unwrap().is_none() {
          tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
      }).await.expect("actual enqueue attempted after committed receipt");
      let broken: String=redis::cmd("GET").arg(&wait_key).query_async(&mut redis).await.unwrap();
      assert_eq!(broken,"owned-wrong-type");
      let _:usize=redis::cmd("DEL").arg(&wait_key).query_async(&mut redis).await.unwrap();
      let queued = success(&rpc(&app, &raw, "pdf_export_create", args.clone()).await);
      assert_eq!(queued["status"], "queued");
      assert!(queued["delivery"]["url"].is_null());
      let job_id: Uuid = queued["jobId"].as_str().unwrap().parse().unwrap();
      assert_eq!(success(&rpc(&app, &raw, "pdf_export_create", args).await), queued);
      for table in ["pdf_export_jobs", "doc_histories", "document_version"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE workspace_id=$1"))
          .bind(ws)
          .fetch_one(&pool)
          .await
          .unwrap();
        assert_eq!(count, 1, "exactly one {table} after rollback, abort and retries");
      }
      let waiting: Vec<String>=redis::cmd("LRANGE").arg(&wait_key).arg(0).arg(-1).query_async(&mut redis).await.unwrap();
      assert_eq!(waiting,vec![job_id.to_string()],"same-key repair enqueues exactly one worker job");
      let mut job = queue
        .get_job("pdf-export", &job_id.to_string())
        .await
        .unwrap()
        .expect("same durable queue identity");
      assert_eq!(job.data["render_inputs"]["compliance_profile"],"pdfa-2u");
      // Simulate a pre-default durable capture in this owned fixture only.
      // Receipt replay must retain it; the worker must interpret absence as standard.
      job.data["render_inputs"].as_object_mut().unwrap().remove("compliance_profile");
      sqlx::query("UPDATE pdf_export_jobs SET render_inputs=render_inputs-'compliance_profile' WHERE id=$1")
        .bind(job_id).execute(&pool).await.unwrap();
      let storage = Arc::new(myoxus_infrastructure::storage::StorageAdapter::new_fs("./test-storage").unwrap());
      let mut handler = myoxus_worker::PdfExportJobHandler::new(
        Arc::new(myoxus_infrastructure::pdf_export::PgPdfExportJobStore::new(
          pool.clone(),
        )),
        Arc::new(myoxus_application::doc::DocService::new(Arc::new(
          myoxus_infrastructure::doc::SqlxDocStore::new(pool.clone()),
        ))),
        Arc::new(myoxus_application::ports::blob_service::BlobService::new(
          Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(pool.clone())),
          storage.clone(),
          "test-key".into(),
        )),
        Arc::new(myoxus_infrastructure::pdf_export::PgPdfFontRepository::new(
          pool.clone(),
        )),
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../static/fonts"),
        Arc::new(myoxus_api::pdf_export_adapter::PdfExportBlobWriterAdapter {
          storage: storage.clone(),
        }),
        myoxus_worker::PdfExportLimits::default(),
        Arc::new(myoxus_infrastructure::pdf_export::PgPdfTemplateRegistry::new(
          pool.clone(),
          Arc::new(myoxus_infrastructure::pdf_export::PgPdfTemplateRepository::new(
            pool.clone(),
          )),
          Arc::new(myoxus_infrastructure::pdf_export::PdfBlobStore::new(storage.operator())),
        )),
      );
      handler.font_reader = Some(Arc::new(myoxus_api::pdf_export_adapter::PdfExportFontReaderAdapter {
        storage: storage.clone(),
      }));
      handler.asset_reader = Some(Arc::new(myoxus_api::pdf_export_adapter::PdfExportAssetReaderAdapter {
        storage,
      }));
      use myoxus_worker::JobHandler;
      handler
        .process(&job)
        .await
        .expect("same production queued compiler path");
      let done = success(&rpc(&app, &raw, "pdf_export_get", json!({"job_id":job_id})).await);
      assert_eq!(done["status"], "done");
      assert_eq!(done["source"], queued["source"]);
      assert_eq!(done["diagnostics"]["coverage"], "pipeline_reported");
      assert_eq!(done["diagnostics"]["findings"],json!([{ "code":"missing_canvas_snapshot","count":1},{"code":"unsupported_block","count":1}]));
      let (status, bytes) = download(&app, job_id, Some(&raw), None).await;
      assert_eq!(status, 200);
      let legacy_pdf=lopdf::Document::load_mem(&bytes).unwrap();
      assert_eq!(legacy_pdf.version,"1.7");
      assert!(legacy_pdf.catalog().unwrap().get(b"StructTreeRoot").is_ok());
      assert_eq!(success(&rpc(&app,&raw,"pdf_export_create",json!({"workspace_id":ws,"external_id":doc,"idempotency_key":"abort-exact-source","document_version_id":"latest","typed_inputs":{"title":"Pinned queue source"}})).await),queued);

      let text = complete_pdf_text(&bytes);
      assert!(
        text.contains("Original queued content marker"),
        "pinned original PDF: {text}"
      );
      assert!(!text.contains("Newer content must not leak"));
      assert!(text.contains("Unknown block fallback"));
      assert!(text.contains("Canvas snapshot not available"));
      // A genuinely missing stored asset retains the existing fail-closed
      // compiler behavior, while its already-observed report survives failure.
      sqlx::query("UPDATE doc_snapshots SET payload=$2 WHERE doc_id=$1").bind(doc)
        .bind(with_omissions(build_pdf_doc_yjs_from_paragraphs("Broken queued asset", &["Visible original body.".into()]), true))
        .execute(&pool).await.unwrap();
      let broken = success(&rpc(&app,&raw,"pdf_export_create",json!({"workspace_id":ws,"external_id":doc,
        "idempotency_key":"missing-asset-queued","typed_inputs":{"title":"Missing queued asset title"}})).await);
      let broken_id: Uuid = broken["jobId"].as_str().unwrap().parse().unwrap();
      let broken_job = queue.get_job("pdf-export", &broken_id.to_string()).await.unwrap().unwrap();
      assert!(handler.process(&broken_job).await.is_err(), "missing private asset cannot produce a successful PDF");
      let failed=success(&rpc(&app,&raw,"pdf_export_get",json!({"job_id":broken_id})).await);
      assert_eq!(failed["status"],"failed");
      assert_eq!(failed["errorClass"],"RenderError");
      assert_eq!(failed["diagnostics"]["coverage"],"pipeline_reported");
      assert_eq!(failed["diagnostics"]["findings"],json!([{"code":"missing_asset","count":1},{"code":"unsupported_block","count":1}]));
      assert_eq!(failed["delivery"]["available"],false);
      assert!(failed["delivery"]["url"].is_null());
      assert!(!failed.to_string().contains("private/missing.png"));
      assert_eq!(download(&app,broken_id,Some(&raw),None).await.0,410);
      }).catch_unwind().await;
      sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger} ON pdf_export_jobs"))
        .execute(&pool)
        .await
        .unwrap();
      sqlx::query(&format!("DROP FUNCTION IF EXISTS {function}()"))
        .execute(&pool)
        .await
        .unwrap();
      let mut redis = redis::Client::open(redis_url)
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .unwrap();
      let keys: Vec<String> = redis::cmd("KEYS")
        .arg(format!("{prefix}:*"))
        .query_async(&mut redis)
        .await
        .unwrap();
      if !keys.is_empty() {
        let _: usize = redis::cmd("DEL").arg(keys).query_async(&mut redis).await.unwrap();
      }
      finish(&pool, ws, &[user]).await;
      observer.close().await;
      if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
      }
    });
  }
}

/// Identical GraphQL retries reuse a job only while the captured bundle is
/// unchanged, including the separate latest-selector lookup.
#[test]
fn inv_same_version_bundle_changes_invalidate_pdf_reuse() {
  helpers::block_on_large_stack("pdf-bundle-reuse", || async {
    use futures_util::FutureExt;
    use myoxus_domain::repositories::PdfTemplateRepository;
    let (app, pool, auth) = helpers::setup_app_with_pdf_sync_threshold(0).await;
    let owner = helpers::create_user(&pool, "pdf-bundle-reuse", false).await;
    let session = helpers::create_session(&auth, owner).await;
    let ws = helpers::create_workspace(&pool, owner).await;
    let doc = helpers::create_doc(&pool, ws, owner).await;
    insert_doc_snapshot(&pool, ws, doc, build_pdf_doc_yjs(1)).await;
    let templates = myoxus_infrastructure::pdf_export::PgPdfTemplateRepository::new(pool.clone());
    let template_id = Uuid::new_v4();
    let mut template = templates.get_by_slug("default").await.unwrap().unwrap();
    let mut files = templates.list_files(template.id).await.unwrap();
    template.id = template_id;
    template.slug = format!("pdf-reuse-{}", template_id.simple());
    template.manifest["id"] = template.slug.clone().into();
    template.created_by = Some(owner);
    for file in &mut files {
      file.template_id = template_id;
    }
    let storage = myoxus_infrastructure::storage::StorageAdapter::new_fs("./test-storage").unwrap();
    let blobs = myoxus_infrastructure::pdf_export::PdfBlobStore::new(storage.operator());
    let mut written = Vec::new();
    let result = std::panic::AssertUnwindSafe(async {
      templates.create(&template, &files, None).await.unwrap();
      super::pdf_export_v2_mutation_test::assign_template(&pool, ws, template_id, owner).await;
      let latest_ws = helpers::create_workspace(&pool, owner).await;
      let latest_doc = helpers::create_doc(&pool, latest_ws, owner).await;
      insert_doc_snapshot(&pool, latest_ws, latest_doc, build_pdf_doc_yjs(1)).await;
      super::pdf_export_v2_mutation_test::assign_template(&pool, latest_ws, template_id, owner).await;
      let mut previous = Vec::new();
      for changed in [false, true] {
        if changed {
          let file = files.iter_mut().find(|file| file.file_path == "preamble.typ").unwrap();
          let mut bytes = blobs.get_template_file(&file.blob_key).await.unwrap();
          bytes.extend_from_slice(b"\n// external same-version revision\n");
          let (key, hash) = blobs
            .put_template_revision_file(template_id, &file.file_path, &bytes)
            .await
            .unwrap();
          written.push(key.clone());
          let observed_files = templates.list_files(template_id).await.unwrap();
          file.blob_key = key;
          file.content_hash = hash;
          templates
            .replace_bundle(&template, &files, &template, &observed_files, None)
            .await
            .unwrap();
        }
        for (index, latest) in [false, true].into_iter().enumerate() {
          // Each workspace stays below the normal three-job admission limit.
          let mut request = if latest {
            start_export_mutation(latest_ws, latest_doc)
          } else {
            start_export_mutation(ws, doc)
          };
          request["variables"]["input"]["templateId"] = template_id.to_string().into();
          if latest {
            request["variables"]["input"]["documentVersionId"] = "latest".into();
          }
          let first = helpers::gql(&app, session, request.clone()).await;
          assert!(first.get("errors").is_none(), "bundle export: {first}");
          let second = helpers::gql(&app, session, request).await;
          assert!(second.get("errors").is_none(), "bundle retry: {second}");
          let id = first["data"]["exportPdf"]["id"].clone();
          assert_eq!(
            id, second["data"]["exportPdf"]["id"],
            "unchanged bundle remains idempotent"
          );
          if changed {
            assert_ne!(
              id, previous[index],
              "same-version file change must invalidate both lookups"
            );
          } else {
            previous.push(id);
          }
        }
      }
    })
    .catch_unwind()
    .await;
    sqlx::query(
      "DELETE FROM pdf_export_render_audit WHERE job_id IN (SELECT id FROM pdf_export_jobs WHERE requested_by = $1)",
    )
    .bind(owner)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM pdf_export_jobs WHERE requested_by = $1")
      .bind(owner)
      .execute(&pool)
      .await
      .unwrap();
    sqlx::query("DELETE FROM pdf_workspace_template_assignments WHERE template_id = $1")
      .bind(template_id)
      .execute(&pool)
      .await
      .unwrap();
    sqlx::query("DELETE FROM pdf_templates WHERE id = $1")
      .bind(template_id)
      .execute(&pool)
      .await
      .unwrap();
    for key in written {
      blobs.delete(&key).await.unwrap();
    }
    helpers::cleanup_users(&pool, &[owner]).await;
    if let Err(panic) = result {
      std::panic::resume_unwind(panic);
    }
  });
}

/// The HTTP adapter and both productive render consumers must reject an
/// unvalidated report before any PDF bytes, completion or success audit escape.
#[test]
fn inv_pdfexp_validator_verdict_gates_sync_and_queued_publication() {
  helpers::block_on_large_stack_multithread(
    "inv_pdfexp_validator_verdict_gates_sync_and_queued_publication",
    2,
    || async {
      use axum::response::IntoResponse;
      use futures_util::FutureExt;
      use myoxus_application::pdf_export::jobs::PdfExportJobStore;
      use myoxus_worker::JobHandler;
      use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
      };

      let response = Arc::new(Mutex::new((axum::http::StatusCode::OK, json!({}))));
      let calls = Arc::new(AtomicUsize::new(0));
      let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
      let url = format!("http://{}", listener.local_addr().unwrap());
      let fixture = axum::Router::new().route(
        "/api/validate/{profile}",
        axum::routing::post({
          let response = response.clone();
          let calls = calls.clone();
          move |headers: axum::http::HeaderMap, body: axum::body::Bytes| {
            let response = response.clone();
            let calls = calls.clone();
            async move {
              assert_eq!(headers[axum::http::header::ACCEPT], "application/json");
              assert!(
                body.windows(5).any(|bytes| bytes == b"%PDF-"),
                "validator receives rendered PDF multipart bytes"
              );
              calls.fetch_add(1, Ordering::SeqCst);
              let (status, report) = response.lock().unwrap().clone();
              if report == json!("timeout") {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
              }
              if report == json!("disconnect") {
                let body = Body::from_stream(futures_util::stream::once(async {
                  Err::<Vec<u8>, _>(std::io::Error::new(
                    std::io::ErrorKind::ConnectionReset,
                    "owned validator disconnect",
                  ))
                }));
                return body.into_response();
              }
              let body = if report == json!("invalid-json") {
                vec![b'{']
              } else {
                serde_json::to_vec(&report).unwrap()
              };
              (status, [(axum::http::header::CONTENT_TYPE, "application/json")], body).into_response()
            }
          }
        }),
      );
      let server = tokio::spawn(async move { axum::serve(listener, fixture).await.unwrap() });
      let mut workspaces = Vec::new();
      let mut users = Vec::new();
      let mut cleanup_pool = None;
      let outcome = std::panic::AssertUnwindSafe(async {
      let mut apps = Vec::new();
      for configured in [true, false] {
        for threshold in [50, 0] {
          let url = configured.then(|| url.clone());
          apps.push(helpers::setup_app_with_pdf_config(move |config| {
            config.pdf_export.sync_threshold_blocks = threshold;
            config.pdf_export.verapdf_validator_url = url;
            config.pdf_export.verapdf_timeout_seconds=1;
          }).await);
        }
      }
      let pool = &apps[0].1; cleanup_pool = Some(pool.clone());
      let owner = helpers::create_user(pool, "pdf-validator", false).await; users.push(owner);
      let session = helpers::create_session(&apps[0].2, owner).await;
      let storage = Arc::new(myoxus_infrastructure::storage::StorageAdapter::new_fs("./test-storage").unwrap());
      let jobs = Arc::new(myoxus_infrastructure::pdf_export::PgPdfExportJobStore::new(pool.clone()));
      let blob_service = Arc::new(myoxus_application::ports::blob_service::BlobService::new(
        Arc::new(myoxus_infrastructure::blob::SqlxBlobStore::new(pool.clone())), storage.clone(), "test-key".into()));
      let mut handler = myoxus_worker::PdfExportJobHandler::new(jobs.clone(),
        Arc::new(myoxus_application::doc::DocService::new(Arc::new(myoxus_infrastructure::doc::SqlxDocStore::new(pool.clone())))),
        blob_service, Arc::new(myoxus_infrastructure::pdf_export::PgPdfFontRepository::new(pool.clone())),
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../static/fonts"),
        Arc::new(myoxus_api::pdf_export_adapter::PdfExportBlobWriterAdapter { storage: storage.clone() }),
        myoxus_worker::PdfExportLimits::default(),
        Arc::new(myoxus_infrastructure::pdf_export::PgPdfTemplateRegistry::new(pool.clone(),
          Arc::new(myoxus_infrastructure::pdf_export::PgPdfTemplateRepository::new(pool.clone())),
          Arc::new(myoxus_infrastructure::pdf_export::PdfBlobStore::new(storage.operator())))));
      handler.font_reader = Some(Arc::new(myoxus_api::pdf_export_adapter::PdfExportFontReaderAdapter { storage: storage.clone() }));
      handler.asset_reader = Some(Arc::new(myoxus_api::pdf_export_adapter::PdfExportAssetReaderAdapter { storage: storage.clone() }));
      let validator: Arc<dyn myoxus_pdf_export::render_v2::pdfa::VerapdfClient> = Arc::new(
        myoxus_infrastructure::pdf_export::ReqwestVerapdfClient::new(url, std::time::Duration::from_secs(1), None).unwrap());
      // Detailed malformed-shape coverage belongs to the reducer unit tests.
      // Here only distinct publication branches cross the real HTTP boundary.
      let cases = [
        ("positive", true, true, axum::http::StatusCode::OK, json!({"report":{"jobs":[{"validationResult":[{"compliant":true,"details":{"failedRules":0}}]}]}})),
        ("wrong-profile", true, false, axum::http::StatusCode::OK, json!({"report":{"jobs":[{"validationResult":{"profileName":"PDF/A-1b validation profile","compliant":true}}]}})),
        ("negative", true, false, axum::http::StatusCode::OK, json!({"report":{"jobs":[{"validationResult":{"isCompliant":false,"failedRules":2}}]}})),
        ("missing", true, false, axum::http::StatusCode::OK, json!({"report":{"jobs":[{"validationResult":{}}]}})),
        ("partial", true, false, axum::http::StatusCode::OK, json!({"report":{"jobs":[{"validationResult":{"isCompliant":true}},{}]}})),
        ("broken", true, false, axum::http::StatusCode::BAD_GATEWAY, json!({"error":"source payload must not enter diagnostics"})),
        ("invalid-json", true, false, axum::http::StatusCode::OK, json!("invalid-json")),
        ("unsupported", true, false, axum::http::StatusCode::NOT_FOUND, json!({"error":"unsupported UA"})),
        ("disconnect", true, false, axum::http::StatusCode::OK, json!("disconnect")),
        ("timeout", true, false, axum::http::StatusCode::OK, json!("timeout")),
        ("native-only", false, true, axum::http::StatusCode::OK, json!({})),
      ];
      for requested in [Some("pdfa-2b"),Some("pdfa-2u"),None,Some("  "),Some("standard"),Some("pdfua-1")] {
      let compliance=requested.filter(|value|!value.trim().is_empty()).unwrap_or("pdfa-2u");
      let error_class=if compliance=="pdfua-1" {"PdfuaValidationFailed"} else {"PdfaValidationFailed"};
      for (label, configured, allowed, status, report) in &cases {
        if compliance!="pdfua-1" && ["unsupported","disconnect","timeout"].contains(label) {continue;}
        if compliance=="standard" && !["positive","native-only"].contains(label) {continue;}
        let (label,configured,allowed,status) = (*label,*configured,*allowed,*status);
        let mut report=report.clone();
        if label=="positive" {report["report"]["jobs"][0]["validationResult"][0]["profileName"]=json!(if compliance=="pdfa-2u" {"PDF/A-2u validation profile"} else if compliance=="pdfua-1" {"PDF/UA-1 validation profile"} else {"PDF/A-2b validation profile"});}
        for sync in [true, false] {
          let (app, _, _) = &apps[usize::from(!configured) * 2 + usize::from(!sync)];
          let workspace = helpers::create_workspace(pool, owner).await; workspaces.push(workspace);
          let doc = helpers::create_doc(pool, workspace, owner).await;
          insert_doc_snapshot(pool, workspace, doc, build_pdf_doc_yjs_from_paragraphs("Validator source", &["Preserved transcript-independent PDF source, äöü and café.".into()])).await;
          *response.lock().unwrap() = (status, report.clone());
          let before_calls = calls.load(Ordering::SeqCst);
          let result = helpers::gql(app, session, json!({"query":"mutation($input:PdfExportInputV2Input!){exportPdf(input:$input){id status downloadUrl}}",
            "variables":{"input":{"workspaceId":workspace.to_string(),"docId":doc.to_string(),"templateId":"default","complianceProfile":requested,"typedInputs":{"title":"Validator source"}}}})).await;
          let job_id = if sync && !allowed {
            assert_eq!(result["errors"][0]["extensions"]["class"], error_class, "{label}: {result}");
            assert!(result["data"].is_null());
            None
          } else {
            assert!(result.get("errors").is_none(), "{label}: {result}");
            let job_id: Uuid = result["data"]["exportPdf"]["id"].as_str().unwrap().parse().unwrap();
            if !sync {
              assert_eq!(result["data"]["exportPdf"]["status"], "queued");
              let queued = jobs.get(job_id).await.unwrap().unwrap();
              handler.verapdf_client = configured.then(|| validator.clone());
              let processed = handler.process(&myoxus_worker::Job { id:job_id.to_string(), name:"pdf-export".into(),
                data:json!({"job_id":job_id,"workspace_id":workspace,"doc_id":doc,"template_id":queued.template_id,"render_inputs":queued.render_inputs}),
                opts:Default::default(), timestamp:0, attempts_made:0, finished_on:None, failed_reason:None, heartbeat:None, return_value:None }).await;
              assert_eq!(processed.is_ok(), allowed, "{label}: {processed:?}");
            }
            let job = jobs.get(job_id).await.unwrap().unwrap();
            assert_eq!(job.render_inputs["compliance_profile"],compliance,"new admission captures the resolved profile before dispatch");
            assert_eq!(job.status, if allowed {"done"} else {"failed"}, "{label}");
            assert_eq!(job.output_blob_id.is_some(), allowed, "{label}");
            if !allowed {
              assert_eq!(job.error_class.as_deref(), Some(error_class));
              assert!(job.error_detail.as_ref().is_some_and(|detail| !detail.is_empty() && !detail.contains("source payload")));
              assert!(job.render_inputs.get("renderer_diagnostics").is_some());
            }
            let download = app.clone().oneshot(Request::builder().uri(format!("/api/pdf-export/{job_id}/download"))
              .header("Cookie",format!("{}={session}", myoxus_api::auth::SESSION_COOKIE_NAME)).body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(download.status().as_u16(), if allowed {200} else {410}, "{label}");
            if allowed {
              let pdf = download.into_body().collect().await.unwrap().to_bytes();
              let parsed=lopdf::Document::load_mem(&pdf).unwrap();
              if compliance=="standard" {
                assert_eq!(parsed.version,"1.7");
                let catalog=parsed.catalog().unwrap();
                let (_,mark)=parsed.dereference(catalog.get(b"MarkInfo").unwrap()).unwrap();
                assert!(mark.as_dict().unwrap().get(b"Marked").unwrap().as_bool().unwrap());
                assert!(catalog.get(b"StructTreeRoot").is_ok());
              }
              let text = pdf_extract::extract_text_from_mem(&pdf).unwrap();
              assert!(text.contains("Preserved transcript-independent PDF source"), "{label}: {text}");
            }
            Some(job_id)
          };
          assert_eq!(calls.load(Ordering::SeqCst) - before_calls, usize::from(configured && compliance!="standard"), "{label}: no hidden validation/downgrade");
          let blobs:i64 = sqlx::query_scalar("SELECT count(*) FROM blobs WHERE workspace_id=$1 AND key LIKE 'pdf-export/%'")
            .bind(workspace).fetch_one(pool).await.unwrap();
          assert_eq!(blobs,i64::from(allowed), "{label}: rejected PDFs leave no registered artifact");
          let directory = Path::new("./test-storage").join(workspace.to_string()).join("pdf-export");
          let files = match std::fs::read_dir(&directory) {
            Ok(entries) => entries.map(|entry| entry.unwrap()).count(),
            Err(error) if error.kind()==std::io::ErrorKind::NotFound => 0,
            Err(error) => panic!("inspect PDF storage: {error}"),
          };
          assert_eq!(files,usize::from(allowed), "{label}: validation precedes physical storage");
          let (requests,successful):(i64,i64) = sqlx::query_as("SELECT count(*),count(*) FILTER(WHERE j.status='done') FROM pdf_export_render_audit a LEFT JOIN pdf_export_jobs j ON j.id=a.job_id WHERE a.workspace_id=$1")
            .bind(workspace).fetch_one(pool).await.unwrap();
          assert_eq!(requests,1,"{label}: retain request audit even on failure");
          assert_eq!(successful,i64::from(allowed),"{label}: no successful-output audit on failure");
          if job_id.is_none() {
            let count:i64=sqlx::query_scalar("SELECT count(*) FROM pdf_export_jobs WHERE workspace_id=$1").bind(workspace).fetch_one(pool).await.unwrap();
            assert_eq!(count,0,"sync rejection must not insert a completed/queued job");
          }
        }
      }
      }
    }).catch_unwind().await;
      server.abort();
      let stopped = server.await;
      assert!(stopped.unwrap_err().is_cancelled());
      if let Some(pool) = cleanup_pool {
        for workspace in workspaces {
          cleanup_pdf_export_jobs(&pool, workspace).await;
          // Every fixture has its own workspace; remove its empty output tree
          // as well as the registered files, including after a failed assertion.
          if let Err(error) = std::fs::remove_dir_all(Path::new("./test-storage").join(workspace.to_string())) {
            assert_eq!(
              error.kind(),
              std::io::ErrorKind::NotFound,
              "clean owned workspace output tree: {error}"
            );
          }
        }
        helpers::cleanup_users(&pool, &users).await;
      }
      if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
      }
    },
  );
}
