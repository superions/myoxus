//! Source-level guards for Git-Sync architecture invariants.
//!
//! These tests intentionally inspect active Rust source. They are cheap and
//! catch accidental reintroduction of second Git execution paths before a
//! heavier runner test would notice semantic drift.

use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .ancestors()
    .nth(3)
    .expect("api crate lives under server/crates/api")
    .to_path_buf()
}

fn visit_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
  let entries = fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()));
  for entry in entries {
    let entry = entry.unwrap_or_else(|e| panic!("read_dir entry {}: {e}", dir.display()));
    let path = entry.path();
    if path.is_dir() {
      visit_rs_files(&path, out);
    } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
      out.push(path);
    }
  }
}

#[test]
fn inv_gitsync_source_01_no_second_adapter_or_cli_git_path() {
  let root = repo_root();
  let source_roots = [
    root.join("server/crates/application/src/git_sync"),
    root.join("server/crates/api/src/git_sync_engine"),
    root.join("server/crates/infrastructure/src/git_sync"),
  ];

  let mut files = Vec::new();
  for source_root in source_roots {
    visit_rs_files(&source_root, &mut files);
  }

  let mut findings = Vec::new();
  for path in files {
    let source = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    for forbidden in ["gix_adapter", "GixAdapter", "Command::new(\"git\")"] {
      if source.contains(forbidden) {
        findings.push(format!(
          "{} contains forbidden Git-Sync fallback marker {forbidden}",
          path.display()
        ));
      }
    }
  }

  assert!(
    findings.is_empty(),
    "Git-Sync production source must stay on the single Git2Adapter/GitRepositoryPort path:\n{}",
    findings.join("\n")
  );
}
