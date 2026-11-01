use std::fs;
use std::path::{Path, PathBuf};

const FORBIDDEN: &[&str] = &[
  "StartPdfExportInput",
  "startPdfExport",
  "start_pdf_export",
  "export_options",
  "merge_l3_inputs",
  "V2-\u{2192}V1",
  "V2->V1",
  "renderer-normalisierte V1",
  "V1-Dispatch",
];

const SCAN_PATHS: &[&str] = &[
  "server/crates/api/src",
  "server/crates/application/src/pdf_export",
  "server/crates/worker/src",
  "server/crates/pdf_export/src",
  "client/libs/core/src/components/hooks/myoxus/use-export-page.ts",
  "client/libs/graphql/src/graphql",
  "client/libs/graphql/src/schema.ts",
  "docs/dev/clients/pdf-export-architecture.md",
  "docs/dev/server/pdf-export-v2-architecture.md",
  "docs/ops/data/pdf-export-templates.md",
  "server/config/default.yaml",
  "server/crates/api/src/config.rs",
];

#[test]
fn inv_pdf_export_contract_source_gate_forbids_old_api_payload_terms() {
  let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("../../..")
    .canonicalize()
    .expect("repo root");
  let mut findings = Vec::new();

  for relative in SCAN_PATHS {
    let path = repo_root.join(relative);
    scan_path(&path, &mut findings);
  }

  assert!(
    findings.is_empty(),
    "PDF export V2 contract source gate found forbidden old terms:\n{}",
    findings.join("\n")
  );
}

#[test]
fn inv_pdf_export_job_updates_are_wired_as_existing_sse_transport() {
  let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("../../..")
    .canonicalize()
    .expect("repo root");
  let lib = fs::read_to_string(repo_root.join("server/crates/api/src/lib.rs")).expect("read api lib");
  let handler =
    fs::read_to_string(repo_root.join("server/crates/api/src/handlers/pdf_export.rs")).expect("read pdf handler");

  assert!(
    lib.contains("/api/pdf-export/{job_id}/events"),
    "job-specific PDF export SSE route must stay wired next to the download route"
  );
  assert!(
    lib.contains("pdf_export_job_events_handler"),
    "job-specific PDF export SSE route must call pdf_export_job_events_handler"
  );
  assert!(
    handler.contains("phase: pdf_export_phase_from_status")
      && handler.contains("\"running\" => \"rendering\"")
      && handler.contains("\"done\" => \"done\"")
      && handler.contains("\"failed\" => \"failed\""),
    "PDF export SSE payload must keep the stable phase projection used by web clients"
  );
}

#[test]
fn inv_pdf_export_history_query_exposes_redownload_and_v2_inputs() {
  let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("../../..")
    .canonicalize()
    .expect("repo root");
  let gql = fs::read_to_string(repo_root.join("server/crates/api/src/graphql/pdf_export.rs")).expect("read pdf gql");
  let root = fs::read_to_string(repo_root.join("server/crates/api/src/graphql/mod.rs")).expect("read gql root");

  assert!(
    root.contains("document_pdf_export_history"),
    "documentPdfExportHistory must stay registered on ApiQueryRoot"
  );
  assert!(
    gql.contains("PdfExportHistoryEntryType")
      && gql.contains("render_inputs")
      && gql.contains("download_url")
      && gql.contains("WorkspaceAction::Read"),
    "history entries must include re-download URL, V2 render inputs, and workspace-read authorization"
  );
}

#[test]
fn inv_pdf_export_cancel_is_requester_or_admin_scoped() {
  let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("../../..")
    .canonicalize()
    .expect("repo root");
  let gql = fs::read_to_string(repo_root.join("server/crates/api/src/graphql/pdf_export.rs")).expect("read pdf gql");
  let root = fs::read_to_string(repo_root.join("server/crates/api/src/graphql/mod.rs")).expect("read gql root");
  let cancel_start = gql.find("pub async fn cancel_pdf_export_job").expect("cancel resolver");
  let cancel_end = gql[cancel_start..]
    .find("pub async fn export_pdf(")
    .map(|idx| cancel_start + idx)
    .expect("next resolver doc");
  let cancel_resolver = &gql[cancel_start..cancel_end];

  assert!(
    root.contains("Cancel a queued PDF export job as the requester or as an admin"),
    "root schema docs must not describe cancelPdfExportJob as admin-only"
  );
  assert!(
    cancel_resolver.contains("actor_is_owner")
      && cancel_resolver.contains("actor_is_admin")
      && cancel_resolver.contains("cancelled by requester")
      && !cancel_resolver.contains("ensure_admin(ctx, state).await?;"),
    "cancelPdfExportJob must remain requester-or-admin scoped, not admin-only"
  );
}

fn scan_path(path: &Path, findings: &mut Vec<String>) {
  if path.is_dir() {
    for entry in fs::read_dir(path).unwrap_or_else(|e| panic!("read_dir {}: {e}", path.display())) {
      let entry = entry.expect("dir entry");
      scan_path(&entry.path(), findings);
    }
    return;
  }

  let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
    return;
  };
  if !matches!(ext, "rs" | "ts" | "tsx" | "gql" | "md" | "yaml" | "yml") {
    return;
  }

  let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
  for (line_idx, line) in text.lines().enumerate() {
    for forbidden in FORBIDDEN {
      if line.contains(forbidden) {
        findings.push(format!("{}:{} contains `{}`", path.display(), line_idx + 1, forbidden));
      }
    }
  }
}
