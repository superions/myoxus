// SPDX-License-Identifier: AGPL-3.0-or-later
//! Invariant test for triggerCleanupTrashedDocEmbeddings admin mutation (P95-API-17).
//!
//! **Invariant INV-P17-01**: The mutation MUST be callable by an admin via
//! `admin { triggerCleanupTrashedDocEmbeddings }` without errors and MUST return
//! a non-negative integer representing the number of rows cleaned up.
//!
//! **Invariant INV-P17-02**: The admin sub-root version returns i32 (row count),
//! distinguishing it from the legacy flat-root version which returns bool.

use crate::helpers;

use serde_json::json;

/// INV-P17-01: triggerCleanupTrashedDocEmbeddings is reachable under admin { }
/// and returns a non-negative integer row count.
#[test]
fn inv_p17_01_cleanup_trashed_embeddings_returns_non_negative_i32() {
  helpers::block_on_large_stack("inv-p17-cleanup-trashed-embeddings", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_search_repository().await;
    let (admin_id, session) = helpers::seed_admin(&pool, &auth_store).await;

    let resp = helpers::gql(
      &app,
      session,
      json!({
        "query": "mutation { admin { triggerCleanupTrashedDocEmbeddings } }"
      }),
    )
    .await;

    helpers::cleanup_users(&pool, &[admin_id]).await;

    assert!(
      resp.get("errors").is_none(),
      "INV-P17-01 FAIL: mutation returned errors: {resp}"
    );
    let count = resp["data"]["admin"]["triggerCleanupTrashedDocEmbeddings"]
      .as_i64()
      .expect("INV-P17-01 FAIL: result must be an integer");
    assert!(count >= 0, "INV-P17-01 FAIL: result must be >= 0, got {count}");
  });
}

/// INV-P17-02: The field is present on the AdminRoot type (introspection check).
#[test]
fn inv_p17_02_cleanup_present_on_admin_root_type() {
  helpers::block_on_large_stack("inv-p17-cleanup-introspection", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, session) = helpers::seed_admin(&pool, &auth_store).await;

    let resp = helpers::gql(
      &app,
      session,
      json!({ "query": r#"{ __type(name: "AdminRoot") { fields { name } } }"# }),
    )
    .await;

    helpers::cleanup_users(&pool, &[admin_id]).await;

    let admin_fields: Vec<String> = resp["data"]["__type"]["fields"]
      .as_array()
      .unwrap_or(&vec![])
      .iter()
      .filter_map(|f| f["name"].as_str().map(String::from))
      .collect();

    assert!(
      admin_fields.contains(&"triggerCleanupTrashedDocEmbeddings".to_string()),
      "INV-P17-02 FAIL: AdminRoot missing triggerCleanupTrashedDocEmbeddings. Has: {admin_fields:?}"
    );
  });
}
