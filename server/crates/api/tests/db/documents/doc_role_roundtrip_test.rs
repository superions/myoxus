//! INF-RV-01c: Regression tests for DocRole DB round-trip fidelity.
//!
//! Verifies that every DocRole variant (External, Reader, Commenter, Editor,
//! Manager, Owner) survives write -> read through `doc_user_permissions` without
//! silent degradation to `DocRole::None`.

use crate::helpers;

use myoxus_application::doc::DocPermissionStore;
use myoxus_domain::entities::DocRole;
use myoxus_infrastructure::doc::SqlxDocStore;
use uuid::Uuid;

/// All DocRole variants that represent real permissions (excludes None).
const ALL_GRANT_ROLES: &[(DocRole, &str)] = &[
  (DocRole::External, "External"),
  (DocRole::Reader, "Reader"),
  (DocRole::Commenter, "Commenter"),
  (DocRole::Editor, "Editor"),
  (DocRole::Manager, "Manager"),
  (DocRole::Owner, "Owner"),
];

/// INF-RV-01c: Each DocRole variant round-trips through upsert/get without degradation.
#[tokio::test]
async fn inv_rv01c_doc_role_roundtrip_all_variants() {
  let pool = helpers::setup_pool().await;
  let owner_id = helpers::create_user(&pool, "docrole-owner", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  let user_id = helpers::create_user(&pool, "docrole-subject", false).await;

  let store = SqlxDocStore::new(pool.clone());

  for &(role, label) in ALL_GRANT_ROLES {
    // Write
    store
      .upsert_user_doc_role(user_id, doc_id, role)
      .await
      .unwrap_or_else(|e| panic!("upsert {label} failed: {e}"));

    // Read back
    let got = store
      .get_user_doc_role(user_id, doc_id)
      .await
      .unwrap_or_else(|e| panic!("get {label} failed: {e}"))
      .unwrap_or_else(|| panic!("get {label} returned None — row missing"));

    assert_eq!(got, role, "DocRole::{label} degraded after round-trip");
    assert_ne!(got, DocRole::None, "DocRole::{label} silently became None");

    // Verify DB row exists and the raw role string is non-empty
    let raw: String = sqlx::query_scalar("SELECT role FROM doc_user_permissions WHERE user_id = $1 AND doc_id = $2")
      .bind(user_id)
      .bind(doc_id)
      .fetch_one(&pool)
      .await
      .unwrap_or_else(|e| panic!("DB row for {label} missing: {e}"));
    assert!(
      !raw.is_empty(),
      "raw role value in DB must be non-empty for DocRole::{label}"
    );
  }

  // Cleanup
  sqlx::query("DELETE FROM doc_user_permissions WHERE doc_id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[owner_id, user_id]).await;
}

/// INF-RV-01c: list_doc_permissions returns the correct role for each user.
#[tokio::test]
async fn inv_rv01c_doc_role_list_permissions_preserves_variants() {
  let pool = helpers::setup_pool().await;
  let owner_id = helpers::create_user(&pool, "docrole-list-owner", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;

  let store = SqlxDocStore::new(pool.clone());

  // Create one user per role variant and grant that role
  let mut user_role_pairs: Vec<(Uuid, DocRole, &str)> = Vec::new();
  for &(role, label) in ALL_GRANT_ROLES {
    let uid = helpers::create_user(&pool, &format!("docrole-list-{label}"), false).await;
    store
      .upsert_user_doc_role(uid, doc_id, role)
      .await
      .expect("upsert user doc role must succeed");
    user_role_pairs.push((uid, role, label));
  }

  // Retrieve all permissions and verify each one
  let perms = store
    .list_doc_permissions(doc_id)
    .await
    .expect("list_doc_permissions must succeed");
  for &(uid, expected_role, label) in &user_role_pairs {
    let found = perms.iter().find(|(u, _)| *u == uid);
    let (_, actual_role) = found.unwrap_or_else(|| panic!("user for {label} missing from list"));
    assert_eq!(*actual_role, expected_role, "list_doc_permissions: {label} mismatch");
  }

  // Cleanup
  sqlx::query("DELETE FROM doc_user_permissions WHERE doc_id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  let all_uids: Vec<Uuid> = std::iter::once(owner_id)
    .chain(user_role_pairs.iter().map(|(u, _, _)| *u))
    .collect();
  helpers::cleanup_users(&pool, &all_uids).await;
}

/// INF-RV-01c: Upgrading a role overwrites correctly (no stale cached value).
#[tokio::test]
async fn inv_rv01c_doc_role_upgrade_overwrites() {
  let pool = helpers::setup_pool().await;
  let owner_id = helpers::create_user(&pool, "docrole-upg-owner", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  let user_id = helpers::create_user(&pool, "docrole-upg-user", false).await;

  let store = SqlxDocStore::new(pool.clone());

  // Start with Reader, upgrade to Owner
  store
    .upsert_user_doc_role(user_id, doc_id, DocRole::Reader)
    .await
    .expect("initial Reader role upsert must succeed");
  store
    .upsert_user_doc_role(user_id, doc_id, DocRole::Owner)
    .await
    .expect("upgrade to Owner role upsert must succeed");

  let got = store
    .get_user_doc_role(user_id, doc_id)
    .await
    .expect("get_user_doc_role must not error")
    .expect("role row must exist after upsert");
  assert_eq!(got, DocRole::Owner, "upgrade from Reader to Owner did not persist");

  // Cleanup
  sqlx::query("DELETE FROM doc_user_permissions WHERE doc_id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[owner_id, user_id]).await;
}

/// INF-RV-01c: Downgrading a role overwrites correctly.
#[tokio::test]
async fn inv_rv01c_doc_role_downgrade_overwrites() {
  let pool = helpers::setup_pool().await;
  let owner_id = helpers::create_user(&pool, "docrole-dng-owner", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  let user_id = helpers::create_user(&pool, "docrole-dng-user", false).await;

  let store = SqlxDocStore::new(pool.clone());

  // Start with Owner, downgrade to External
  store
    .upsert_user_doc_role(user_id, doc_id, DocRole::Owner)
    .await
    .expect("initial Owner role upsert must succeed");
  store
    .upsert_user_doc_role(user_id, doc_id, DocRole::External)
    .await
    .expect("downgrade to External role upsert must succeed");

  let got = store
    .get_user_doc_role(user_id, doc_id)
    .await
    .expect("get_user_doc_role must not error")
    .expect("role row must exist after upsert");
  assert_eq!(
    got,
    DocRole::External,
    "downgrade from Owner to External did not persist"
  );

  // Cleanup
  sqlx::query("DELETE FROM doc_user_permissions WHERE doc_id = $1")
    .bind(doc_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[owner_id, user_id]).await;
}

/// INF-RV-01c: Deleting a role returns None on subsequent read.
#[tokio::test]
async fn inv_rv01c_doc_role_delete_removes_row() {
  let pool = helpers::setup_pool().await;
  let owner_id = helpers::create_user(&pool, "docrole-del-owner", false).await;
  let ws_id = helpers::create_workspace(&pool, owner_id).await;
  let doc_id = helpers::create_doc(&pool, ws_id, owner_id).await;
  let user_id = helpers::create_user(&pool, "docrole-del-user", false).await;

  let store = SqlxDocStore::new(pool.clone());

  store
    .upsert_user_doc_role(user_id, doc_id, DocRole::Editor)
    .await
    .expect("Editor role upsert must succeed");
  store
    .delete_user_doc_role(user_id, doc_id)
    .await
    .expect("delete_user_doc_role must succeed");

  let got = store
    .get_user_doc_role(user_id, doc_id)
    .await
    .expect("get_user_doc_role after deletion must not error");
  assert!(got.is_none(), "role should be None after deletion, got {:?}", got);

  // Cleanup
  helpers::cleanup_users(&pool, &[owner_id, user_id]).await;
}
