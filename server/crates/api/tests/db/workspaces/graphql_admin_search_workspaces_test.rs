// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration tests for `P-AR-0-S03` — admin workspace search.
//!
//! Invarianten:
//!   * `inv_p_ar_0_s03_admin_can_search` — Admin findet einen Workspace
//!     ueber ein Substring im Namen; Antwort enthaelt `id`, `name`,
//!     `ownerUserId`, `ownerEmail` und `linkedOuIds`.
//!   * `inv_p_ar_0_s03_ou_filter_works` — `ouId` filtert auf
//!     OU-verlinkte Workspaces. Workspaces ohne Link zur OU duerfen
//!     nicht erscheinen, auch wenn der Name passt.
//!   * `inv_p_ar_2_04_exclude_unit_filter_works` — `excludeUnitId`
//!     entfernt bereits verlinkte Workspaces serverseitig, damit Add-Picker
//!     keine Dubletten anbieten.
//!   * `inv_p_ar_0_s03_non_admin_denied` — Non-Admin bekommt
//!     `ActionForbidden` (errors-Array nicht leer, `data.adminSearchWorkspaces`
//!     null), nicht eine leere Liste — sonst Information-Leak.

use crate::helpers;

use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

/// Insert a workspace with a custom name (so tests can search for a unique
/// substring) plus an Owner-membership. Returns the new workspace id.
async fn insert_named_workspace(pool: &PgPool, owner_id: Uuid, name: &str) -> Uuid {
  let id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO workspaces
         (id, owner_user_id, name, public, enable_ai, enable_sharing, enable_url_preview, enable_doc_embedding)
       VALUES ($1, $2, $3, FALSE, TRUE, TRUE, TRUE, TRUE)"#,
  )
  .bind(id)
  .bind(owner_id)
  .bind(name)
  .execute(pool)
  .await
  .expect("insert workspace");
  sqlx::query(
    r#"INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'Owner', 'Accepted', now())"#,
  )
  .bind(id)
  .bind(owner_id)
  .execute(pool)
  .await
  .expect("insert membership");
  id
}

async fn link_workspace_to_ou(pool: &PgPool, unit_id: Uuid, workspace_id: Uuid) {
  sqlx::query(
    r#"INSERT INTO organization_unit_workspace
         (unit_id, workspace_id, relationship, created_at)
       VALUES ($1, $2, 'owner', now())"#,
  )
  .bind(unit_id)
  .bind(workspace_id)
  .execute(pool)
  .await
  .expect("link OU↔workspace");
}

/// `inv_p_ar_0_s03_admin_can_search` — Admin can locate a workspace via a
/// name-substring and the response carries owner snapshot + linked OUs.
#[test]
fn inv_p_ar_0_s03_admin_can_search() {
  helpers::block_on_large_stack("inv_p_ar_0_s03_admin_can_search", || async {
    let (app, pool, auth) = helpers::setup_app().await;

    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
    let owner_id = helpers::create_user(&pool, "p_ar_s03_a_owner", false).await;

    // Unique substring no other workspace can carry.
    let token = format!("p-ar-s03-a-{}", &Uuid::new_v4().to_string()[..8]);
    let ws_name = format!("Atelier {token} Workspace");
    let ws_id = insert_named_workspace(&pool, owner_id, &ws_name).await;

    // Link to one OU so we can assert linkedOuIds is non-empty.
    let org_id = helpers::default_organization_id(&pool).await;
    let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
    let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "P-AR-S03-A Unit").await;
    link_workspace_to_ou(&pool, unit_id, ws_id).await;

    let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "query($q: String!) { admin { adminSearchWorkspaces(query: $q) { id name ownerUserId ownerEmail linkedOuIds } } }",
      "variables": {"q": token}
    }),
  )
  .await;
    assert!(resp["errors"].is_null(), "admin search must succeed: {resp}");

    let hits = resp["data"]["admin"]["adminSearchWorkspaces"]
      .as_array()
      .expect("array");
    assert_eq!(hits.len(), 1, "exactly one match for unique token, got: {resp}");
    let hit = &hits[0];
    assert_eq!(hit["id"].as_str(), Some(ws_id.to_string().as_str()));
    assert_eq!(hit["name"].as_str(), Some(ws_name.as_str()));
    assert_eq!(hit["ownerUserId"].as_str(), Some(owner_id.to_string().as_str()));
    assert!(
      hit["ownerEmail"].as_str().is_some_and(|s| !s.is_empty()),
      "ownerEmail snapshot must be present, got: {hit}"
    );
    let linked = hit["linkedOuIds"].as_array().expect("linkedOuIds array");
    assert_eq!(linked.len(), 1);
    assert_eq!(linked[0].as_str(), Some(unit_id.to_string().as_str()));

    helpers::cleanup_organization_units(&pool, &[unit_id]).await;
    helpers::cleanup_users(&pool, &[admin_id, owner_id]).await;
  });
}

/// `inv_p_ar_0_s03_ou_filter_works` — `ouId` restricts hits to workspaces
/// linked to that OU. A name-matching workspace WITHOUT the link must be
/// excluded.
#[test]
fn inv_p_ar_0_s03_ou_filter_works() {
  helpers::block_on_large_stack("inv_p_ar_0_s03_ou_filter_works", || async {
    let (app, pool, auth) = helpers::setup_app().await;

    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
    let owner_id = helpers::create_user(&pool, "p_ar_s03_b_owner", false).await;

    let token = format!("p-ar-s03-b-{}", &Uuid::new_v4().to_string()[..8]);
    let linked_name = format!("Linked {token}");
    let unlinked_name = format!("Unlinked {token}");
    let linked_ws = insert_named_workspace(&pool, owner_id, &linked_name).await;
    let unlinked_ws = insert_named_workspace(&pool, owner_id, &unlinked_name).await;

    let org_id = helpers::default_organization_id(&pool).await;
    let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
    let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "P-AR-S03-B Unit").await;
    link_workspace_to_ou(&pool, unit_id, linked_ws).await;

    let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "query($q: String!, $u: ID!) { admin { adminSearchWorkspaces(query: $q, ouId: $u) { id linkedOuIds } } }",
      "variables": {"q": token, "u": unit_id.to_string()}
    }),
  )
  .await;
    assert!(resp["errors"].is_null(), "filtered search must succeed: {resp}");

    let hits = resp["data"]["admin"]["adminSearchWorkspaces"]
      .as_array()
      .expect("array");
    assert_eq!(hits.len(), 1, "OU filter must drop the unlinked workspace, got: {resp}");
    assert_eq!(hits[0]["id"].as_str(), Some(linked_ws.to_string().as_str()));

    // Sanity: without the filter, both show up.
    let resp2 = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "query($q: String!) { admin { adminSearchWorkspaces(query: $q) { id } } }",
        "variables": {"q": token}
      }),
    )
    .await;
    let unfiltered = resp2["data"]["admin"]["adminSearchWorkspaces"]
      .as_array()
      .expect("array");
    assert_eq!(
      unfiltered.len(),
      2,
      "without OU filter both workspaces match, got: {resp2}"
    );

    helpers::cleanup_organization_units(&pool, &[unit_id]).await;
    // unlinked_ws has no OU link — cleanup_users will pick it up via owner.
    let _ = unlinked_ws;
    helpers::cleanup_users(&pool, &[admin_id, owner_id]).await;
  });
}

/// `inv_p_ar_2_04_exclude_unit_filter_works` — `excludeUnitId` removes
/// workspaces already linked to the target OU while keeping unlinked matches.
#[test]
fn inv_p_ar_2_04_exclude_unit_filter_works() {
  helpers::block_on_large_stack("inv_p_ar_2_04_exclude_unit_filter_works", || async {
    let (app, pool, auth) = helpers::setup_app().await;

    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
    let owner_id = helpers::create_user(&pool, "p_ar_204_owner", false).await;

    let token = format!("p-ar-204-{}", &Uuid::new_v4().to_string()[..8]);
    let linked_ws = insert_named_workspace(&pool, owner_id, &format!("Linked {token}")).await;
    let available_ws = insert_named_workspace(&pool, owner_id, &format!("Available {token}")).await;

    let org_id = helpers::default_organization_id(&pool).await;
    let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
    let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "P-AR-2-04 Unit").await;
    link_workspace_to_ou(&pool, unit_id, linked_ws).await;

    let resp = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "query($q: String!, $u: ID!) { admin { adminSearchWorkspaces(query: $q, excludeUnitId: $u) { id linkedOuIds } } }",
        "variables": {"q": token, "u": unit_id.to_string()}
      }),
    )
    .await;
    assert!(resp["errors"].is_null(), "excludeUnitId search must succeed: {resp}");

    let hits = resp["data"]["admin"]["adminSearchWorkspaces"]
      .as_array()
      .expect("array");
    assert_eq!(hits.len(), 1, "excludeUnitId must drop linked workspace, got: {resp}");
    assert_eq!(hits[0]["id"].as_str(), Some(available_ws.to_string().as_str()));

    helpers::cleanup_organization_units(&pool, &[unit_id]).await;
    helpers::cleanup_users(&pool, &[admin_id, owner_id]).await;
  });
}

/// `inv_p_ar_0_s03_non_admin_denied` — Non-admin sees `ActionForbidden`,
/// not an empty payload (which would leak existence).
#[test]
fn inv_p_ar_0_s03_non_admin_denied() {
  helpers::block_on_large_stack("inv_p_ar_0_s03_non_admin_denied", || async {
    let (app, pool, auth) = helpers::setup_app().await;

    let (user_id, user_session) = helpers::seed_user(&pool, &auth, "p_ar_s03_c_user").await;

    let resp = helpers::gql(
      &app,
      user_session,
      json!({
        "query": "query { admin { adminSearchWorkspaces(query: \"x\") { id } } }",
      }),
    )
    .await;

    assert!(
      resp
        .get("errors")
        .map(|e| e.is_array() && !e.as_array().unwrap().is_empty())
        .unwrap_or(false),
      "non-admin must receive errors, got: {resp}"
    );
    // async-graphql nulls the entire `admin` sub-root when the field
    // resolver bubbles `ActionForbidden` (the inner Vec has no default
    // and the parent admin object cannot be partially populated).
    assert!(
      resp["data"]["admin"].is_null() || resp["data"]["admin"]["adminSearchWorkspaces"].is_null(),
      "non-admin must not receive payload, got: {resp}"
    );

    helpers::cleanup_users(&pool, &[user_id]).await;
  });
}
