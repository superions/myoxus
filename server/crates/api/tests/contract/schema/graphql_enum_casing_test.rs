//! Generic GraphQL enum casing enforcement (P-ENUM-ENFORCE-A).
//!
//! Invariant: no GraphQL enum variant may serialize as SCREAMING_SNAKE_CASE
//! unless explicitly allowlisted below. async-graphql's default serialization
//! is SCREAMING_SNAKE_CASE, so forgetting `#[graphql(rename_items = "PascalCase")]`
//! on a new enum introduces silent drift vs. the TypeScript client.
//!
//! See learnings/graphql-api.md (LRN-20260409-DT1) — PascalCase is the canonical
//! GraphQL enum wire format for this project.
//!
//! The test introspects the live schema and flags any enum value that either
//! (a) contains `_` (SCREAMING_SNAKE_CASE), or
//! (b) is >=5 chars and fully uppercase (e.g. READER / FAILED),
//! unless the enum type is on the allowlist with a documented reason.

use crate::helpers;

use serde_json::{Value, json};

/// Enums whose values are intentionally NOT PascalCase on the wire.
/// Adding to this list requires a rationale comment.
const CASING_EXEMPT_ENUMS: &[(&str, &str)] = &[
  // Error names follow the SCREAMING_SNAKE_CASE convention of the legacy
  // error contract shared with the TypeScript client.
  ("ErrorNames", "legacy error-name contract (ACCESS_DENIED, etc.)"),
  // Tantivy query occur tokens — lowercase is the upstream contract.
  ("SearchQueryOccur", "tantivy occur tokens (must, must_not, should)"),
  // Upstream Copilot embed status tokens — lowercase wire contract.
  (
    "ContextEmbedStatus",
    "upstream embed status tokens (failed, finished, processing)",
  ),
  // Document metadata projection mode is a format negotiation contract. The
  // values are referenced by generated TypeScript clients and the public
  // document-metadata contract; do not silently rename during generic casing
  // cleanup.
  (
    "DocumentMetadataProjectionModeType",
    "document metadata wire-format markers (MYOXUS_NATIVE, AFFINE_LEGACY)",
  ),
  // Document metadata source/inheritance values are intentionally kept in the
  // current documented contract until a dedicated schema migration updates the
  // server, generated clients and contract docs together.
  (
    "DocumentMetadataSourceType",
    "document metadata contract values documented/generated as uppercase",
  ),
  (
    "DocumentMetadataInheritanceModeType",
    "document metadata contract values documented/generated as uppercase",
  ),
  // Database JSON import modes and conflict strategies shipped as uppercase
  // command tokens. Ops documentation, generated clients and import contract
  // tests all consume these exact values; changing them requires an explicit
  // API migration rather than a generic casing cleanup.
  (
    "DatabaseJsonImportModeType",
    "Database JSON import command tokens (CREATE, MERGE, REPLACE)",
  ),
  (
    "DatabaseJsonConflictStrategyType",
    "Database JSON conflict command tokens (ABORT, RENAME, OVERWRITE)",
  ),
  // Workspace-content operation failures are stable machine-readable error
  // codes shared with persisted operation state and worker payloads.
  (
    "WorkspaceContentErrorCodeType",
    "workspace-content operation error codes (XWS_* contract)",
  ),
];

fn is_exempt(type_name: &str) -> bool {
  CASING_EXEMPT_ENUMS.iter().any(|(n, _)| *n == type_name)
}

fn is_screaming_snake_variant(name: &str) -> bool {
  if name.is_empty() {
    return false;
  }
  let all_upper_or_digit_or_underscore = name
    .chars()
    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
  if !all_upper_or_digit_or_underscore {
    return false;
  }
  // Flag: (a) contains underscore, or (b) length >= 5 all uppercase — catches
  // `READER`, `FAILED`, `PENDING`, `MANAGER`, etc.; allows acronyms up to 4 chars
  // (`AI`, `EA`, `OIDC`, `HTTP`).
  name.contains('_') || name.len() >= 5
}

async fn introspect(app: &axum::Router, session: uuid::Uuid) -> Value {
  helpers::gql(
    app,
    session,
    json!({
      "query": r#"
        {
          __schema {
            types {
              kind
              name
              enumValues { name }
            }
          }
        }
      "#
    }),
  )
  .await
}

#[tokio::test]
async fn all_graphql_enums_use_canonical_casing() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session) = helpers::seed_admin(&pool, &auth_store).await;

  let schema = introspect(&app, session).await;
  assert!(schema.get("errors").is_none(), "introspection failed: {schema}");

  let types = schema["data"]["__schema"]["types"].as_array().expect("types array");

  let mut violations: Vec<String> = Vec::new();

  for t in types {
    if t["kind"].as_str() != Some("ENUM") {
      continue;
    }
    let type_name = match t["name"].as_str() {
      Some(n) if !n.starts_with("__") => n,
      _ => continue,
    };
    if is_exempt(type_name) {
      continue;
    }
    let Some(values) = t["enumValues"].as_array() else {
      continue;
    };
    for v in values {
      let Some(name) = v["name"].as_str() else {
        continue;
      };
      if is_screaming_snake_variant(name) {
        violations.push(format!(
          "  {type_name}.{name} — add #[graphql(rename_items = \"PascalCase\")] \
           on the Rust enum, or allowlist the type in CASING_EXEMPT_ENUMS with a rationale"
        ));
      }
    }
  }

  helpers::cleanup_users(&pool, &[admin_id]).await;

  assert!(
    violations.is_empty(),
    "GraphQL enum casing drift detected ({} variant(s)):\n{}",
    violations.len(),
    violations.join("\n")
  );
}

#[test]
fn exempt_allowlist_is_well_formed() {
  for (name, reason) in CASING_EXEMPT_ENUMS {
    assert!(!name.is_empty(), "empty exempt name");
    assert!(
      reason.len() > 10,
      "exempt {name} needs a meaningful rationale, got {reason:?}"
    );
  }
}
