// SPDX-License-Identifier: AGPL-3.0-or-later
//! Source guard for workspace-local document identity.
//!
//! Client-visible document keys are opaque strings. API code must resolve them
//! through the workspace-scoped SQL boundary and must never derive a global
//! UUID from the string.

use std::fs;
use std::path::{Path, PathBuf};

const FORBIDDEN: &[&str] = &[
  "myoxus_domain::doc_id",
  "doc_id::parse(",
  "parse_doc_id(",
  "SYSTEM_DOC_NS",
];

fn scan_dir(dir: &Path, violations: &mut Vec<String>) {
  for entry in fs::read_dir(dir).unwrap_or_else(|error| panic!("readdir {}: {error}", dir.display())) {
    let path = entry.expect("directory entry").path();
    if path.is_dir() {
      scan_dir(&path, violations);
      continue;
    }
    if path.extension().and_then(|extension| extension.to_str()) != Some("rs") {
      continue;
    }
    let content = fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    for (index, line) in content.lines().enumerate() {
      let trimmed = line.trim_start();
      if trimmed.starts_with("//") {
        continue;
      }
      for forbidden in FORBIDDEN {
        if line.contains(forbidden) {
          violations.push(format!(
            "{}:{} contains `{forbidden}`: {trimmed}",
            path.display(),
            index + 1
          ));
        }
      }
    }
  }
}

#[test]
fn external_document_keys_are_never_globally_derived() {
  let crate_src: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
  let mut violations = Vec::new();
  scan_dir(&crate_src, &mut violations);
  assert!(
    violations.is_empty(),
    "Client document keys must use the workspace-scoped resolver:\n{}",
    violations.join("\n")
  );

  let graphql_utils = fs::read_to_string(crate_src.join("graphql/utils.rs")).expect("read GraphQL identity boundary");
  assert!(graphql_utils.contains("resolve_document_key(workspace_id, DocSpaceKind::Workspace"));

  let graphql_root = fs::read_to_string(crate_src.join("graphql/mod.rs")).expect("read GraphQL root");
  let update_default_role = graphql_root
    .split("async fn update_doc_default_role")
    .nth(1)
    .and_then(|tail| tail.split("async fn publish_doc").next())
    .expect("updateDocDefaultRole resolver source");
  assert!(update_default_role.contains("resolve_doc_id(state, workspace_uuid, &external_doc_id)"));
  assert!(!update_default_role.contains("parse_str(&external_doc_id)"));

  let document_resolvers =
    fs::read_to_string(crate_src.join("graphql/auth/document.rs")).expect("read document resolvers");
  let granted_users = document_resolvers
    .split("async fn granted_users_list")
    .nth(1)
    .and_then(|tail| tail.split("async fn last_accessed_members").next())
    .expect("grantedUsersList resolver source");
  assert!(granted_users.contains("resolve_doc_id(&state, workspace_uuid, &self.id)"));
  assert!(!granted_users.contains("Uuid::parse_str(&self.id)"));

  let renderer = fs::read_to_string(crate_src.join("handlers/workspace_doc.rs")).expect("read workspace renderer");
  let renderer_document_branch = renderer
    .split("if is_doc_path")
    .nth(1)
    .and_then(|tail| tail.split("let Some(workspace) = workspace else").next())
    .expect("workspace renderer document branch source");
  assert!(renderer_document_branch.contains("DocumentKey::parse(doc_raw)"));
  assert!(renderer_document_branch.contains("resolve_document_key("));
  assert!(!renderer_document_branch.contains("Uuid::parse_str(doc_raw)"));

  let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
    .ancestors()
    .nth(3)
    .expect("repository root");
  let core_doc = fs::read_to_string(repo_root.join("client/libs/core/src/modules/doc/entities/doc.ts"))
    .expect("read Core document entity");
  let permission_client =
    fs::read_to_string(repo_root.join("client/libs/core/src/modules/permissions/services/doc-granted-users.ts"))
      .expect("read Core permission client");
  assert!(core_doc.contains("return this.scope.props.docId"));
  assert!(permission_client.contains("externalDocId: this.docService.doc.id"));
  assert!(!permission_client.contains("docId: this.docService.doc.id"));

  let permission_mutations = graphql_root
    .split("async fn grant_doc_user_roles")
    .nth(1)
    .and_then(|tail| tail.split("async fn publish_doc").next())
    .expect("permission mutation source");
  assert_eq!(
    permission_mutations
      .matches("required_external_doc_id(input.external_doc_id, input.doc_id)")
      .count(),
    4
  );
  assert!(!permission_mutations.contains("Uuid::parse_str(&external_doc_id)"));
}
