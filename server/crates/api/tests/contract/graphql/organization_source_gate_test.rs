// SPDX-License-Identifier: AGPL-3.0-or-later
//! Static guard for the Organization-management migration (`ORG-I-05`).
//!
//! Ensures server organization code cannot re-introduce the retired 1:1
//! Team-Workspace coupling. The OU-type literal `"team"` remains a valid
//! domain preset.
//!
//! Forbidden under `crates/api/src/graphql/organization.rs` and
//! `crates/application/src/organization/`:
//!  - `Team` as a struct/enum name in the new surface (would re-introduce
//!    1:1 team-workspace product semantics).
//!  - `team_id` / `teamId` field references — the new model uses
//!    `unit_id`/`organization_unit_id`.

use std::fs;
use std::path::{Path, PathBuf};

const SCAN_PATHS: &[&str] = &[
  "server/crates/api/src/graphql/organization.rs",
  "server/crates/api/src/organization",
  "server/crates/application/src/organization",
];

const FORBIDDEN: &[&str] = &["TeamWorkspace", "team_id:", "teamId:"];
const LEGACY_SCAN_PATHS: &[&str] = &[
  "server/crates/api/src",
  "server/crates/application/src",
  "server/crates/domain/src",
  "server/crates/infrastructure/src",
  "server/crates/cli/src",
  "server/crates/mcp/src",
  "server/config",
  "server/templates",
  "client/admin/workspaces/admin/src",
  "client/apps/ios/App/Packages/AffineGraphQL/Sources",
  "client/apps/ios/App/Packages/Intelligents/Sources",
  "client/libs/core/src",
  "client/libs/graphql/src",
  "tests/client/adminfrontend/e2e",
  "tests/client/webfrontend",
  "build/scripts/server",
];
const LEGACY_FORBIDDEN: &[&str] = &[
  "TeamService",
  "TeamStore",
  "TeamsConfig",
  "TeamId",
  "TeamRole",
  "TeamMember",
  "TeamWorkspace",
  "isManagedTeam",
  "is_team_workspace",
  "filter_team_workspace_ids",
  "team_ws",
  "team_data",
  "setOrganizationUnitWorkspaceQuota",
  "TeamOverride",
  "teamOverrideBytes",
  "isTeamWorkspace",
  "teamMaxMembers",
  "default_team_workspace_quota_mb",
  "send_team_invitation",
  "team-invitation",
  "AuditCategory::Team",
];

#[test]
fn inv_org_i_05_organization_surface_must_not_reintroduce_team_workspace_coupling() {
  let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("../../..")
    .canonicalize()
    .expect("repo root");
  let mut findings: Vec<String> = Vec::new();

  for relative in SCAN_PATHS {
    let path = repo_root.join(relative);
    scan_path(&path, &mut findings);
  }

  assert!(
    findings.is_empty(),
    "Organization surface re-introduced legacy 1:1 team-workspace terms:\n{}",
    findings.join("\n")
  );
}

/// The admin route table must not retain a Team product module.
#[test]
fn inv_org_i_06_admin_routes_must_not_register_new_team_modules() {
  let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("../../..")
    .canonicalize()
    .expect("repo root");
  let routes_path = repo_root.join("client/libs/routes/src/routes.ts");
  let text = fs::read_to_string(&routes_path).unwrap_or_else(|e| panic!("read routes.ts: {e}"));

  let forbidden_patterns = [
    "teams:",
    "/teams",
    "teamSettings",
    "teamHub",
    "teamModule",
    "teams2",
    "team-management",
    "team_management",
  ];
  let mut findings: Vec<String> = Vec::new();
  for (idx, line) in text.lines().enumerate() {
    for pat in forbidden_patterns {
      if line.contains(pat) {
        findings.push(format!(
          "{}:{} contains forbidden new team-module segment `{}`",
          routes_path.display(),
          idx + 1,
          pat
        ));
      }
    }
  }
  assert!(
    findings.is_empty(),
    "@myoxus/routes registered new team-module segments:\n{}",
    findings.join("\n")
  );
}

#[test]
fn legacy_team_parallel_model_must_not_reenter_active_product_source() {
  let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("../../..")
    .canonicalize()
    .expect("repo root");
  let mut findings = Vec::new();

  for relative in LEGACY_SCAN_PATHS {
    scan_product_path(&repo_root.join(relative), &mut findings);
  }

  assert!(
    findings.is_empty(),
    "active product source reintroduced the retired Team parallel model:\n{}",
    findings.join("\n")
  );
}

#[test]
fn legacy_team_source_gate_detects_a_synthetic_reintroduction() {
  let findings = find_forbidden_in_text("struct TeamService;\nconst TYPE: &str = \"team\";");
  assert_eq!(findings, vec!["TeamService"]);
}

#[test]
fn operational_graphql_probes_use_workspace_classification() {
  let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    .join("../../..")
    .canonicalize()
    .expect("repo root");
  let path = repo_root.join("build/scripts/server/perf-diagnosis.sh");
  let text = fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));

  assert!(
    text.contains("role workspaceType"),
    "performance diagnosis must request the canonical workspaceType field"
  );
  assert!(
    !text.contains("role team"),
    "performance diagnosis must not request the retired workspace.team field"
  );
}

fn scan_path(path: &Path, findings: &mut Vec<String>) {
  if path.is_dir() {
    for entry in fs::read_dir(path).expect("read dir") {
      let entry = entry.expect("dir entry");
      scan_path(&entry.path(), findings);
    }
    return;
  }
  let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
    return;
  };
  if ext != "rs" {
    return;
  }
  let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
  for (idx, line) in text.lines().enumerate() {
    let trimmed = line.trim_start();
    if trimmed.starts_with("//") || trimmed.starts_with("///") || trimmed.starts_with("//!") {
      continue;
    }
    for forbidden in FORBIDDEN {
      if line.contains(forbidden) {
        findings.push(format!("{}:{} contains `{}`", path.display(), idx + 1, forbidden));
      }
    }
  }
}

fn scan_product_path(path: &Path, findings: &mut Vec<String>) {
  if path.is_dir() {
    for entry in fs::read_dir(path).expect("read product source directory") {
      let entry = entry.expect("product source entry");
      scan_product_path(&entry.path(), findings);
    }
    return;
  }
  let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
    return;
  };
  if !matches!(ext, "rs" | "ts" | "tsx" | "gql" | "yaml" | "html" | "swift" | "sh") {
    return;
  }
  let text = fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
  for (index, line) in text.lines().enumerate() {
    if line.trim_start().starts_with("//") {
      continue;
    }
    for forbidden in find_forbidden_in_text(line) {
      findings.push(format!("{}:{} contains `{forbidden}`", path.display(), index + 1));
    }
  }
}

fn find_forbidden_in_text(text: &str) -> Vec<&'static str> {
  LEGACY_FORBIDDEN
    .iter()
    .copied()
    .filter(|forbidden| text.contains(forbidden))
    .collect()
}
