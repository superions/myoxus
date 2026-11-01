// SPDX-License-Identifier: AGPL-3.0-or-later
//! Invariant test: P100-SRV-B — serverDirectories query
//!
//! Invariant: admin { serverDirectories } returns at least 1 directory entry
//! with a non-empty path and valid (non-negative) byte counts.

use crate::helpers;

use serde_json::json;

#[tokio::test]
async fn inv_b_server_directories_returns_paths() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (_admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  let resp = helpers::gql(
    &app,
    session_id,
    json!({
      "query": "{ admin { serverDirectories { name path exists totalBytes freeBytes capacityBytes entryCount } } }"
    }),
  )
  .await;

  let dirs = resp["data"]["admin"]["serverDirectories"]
    .as_array()
    .expect("serverDirectories must be an array");

  assert!(!dirs.is_empty(), "must return at least one directory");

  for dir in dirs {
    let path = dir["path"].as_str().expect("path must be a string");
    assert!(!path.is_empty(), "path must not be empty");

    // All byte counts must be non-negative
    assert!(
      dir["totalBytes"].as_i64().unwrap_or(-1) >= 0,
      "totalBytes must be >= 0 for {path}"
    );
    assert!(
      dir["freeBytes"].as_i64().unwrap_or(-1) >= 0,
      "freeBytes must be >= 0 for {path}"
    );
    assert!(
      dir["capacityBytes"].as_i64().unwrap_or(-1) >= 0,
      "capacityBytes must be >= 0 for {path}"
    );
    assert!(
      dir["entryCount"].as_i64().unwrap_or(-1) >= 0,
      "entryCount must be >= 0 for {path}"
    );
  }
}
