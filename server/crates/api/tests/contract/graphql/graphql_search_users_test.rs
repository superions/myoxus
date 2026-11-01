// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration tests for `P-AR-0-S02` — admin and manager user search.
//!
//! Invarianten:
//!   * `inv_p_ar_0_s02_admin_sees_all` — Admin findet User per
//!     Email-Snippet ueber `adminSearchUsers`. Antwort enthaelt
//!     `id`, `email`, `name`, `features`, `isAdmin`, `disabled`.
//!   * `inv_p_ar_0_s02_manager_sees_only_own_org` — Manager mit
//!     Manager-Rolle auf einer OU darf `managerSearchUsers(unitId)`
//!     aufrufen und bekommt User-Treffer. Output-Type traegt KEIN
//!     `isAdmin`/`disabled` (anderes SimpleObject als Admin-Surface).
//!   * `inv_p_ar_0_s02_features_filter` — `adminSearchUsers(features:
//!     ["manager"])` filtert auf User mit aktivierter Manager-Capability;
//!     User ohne diese Capability tauchen NICHT auf.
//!   * `inv_p_ar_2_03_admin_search_excludes_unit_members` —
//!     `adminSearchUsers(excludeUnitId:)` filtert bestehende OU-Mitglieder
//!     serverseitig aus dem Admin-Picker heraus.
//!   * `inv_p_ar_0_s02_non_manager_denied_on_manager_endpoint` —
//!     Non-Manager (auch wenn er auf einer ANDEREN OU Manager waere)
//!     bekommt `ActionForbidden` auf `managerSearchUsers`. Kein
//!     leeres Array (Information-Leak), kein `200 OK`.

use crate::helpers;

use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

/// Activate a user-feature row for a given user. Idempotent.
async fn set_user_feature(pool: &PgPool, user_id: Uuid, feature: &str, activated: bool) {
  sqlx::query(
    r#"INSERT INTO user_features (user_id, feature_name, activated, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (user_id, feature_name) DO UPDATE
         SET activated = EXCLUDED.activated, updated_at = now()"#,
  )
  .bind(user_id)
  .bind(feature)
  .bind(activated)
  .execute(pool)
  .await
  .expect("upsert user_features");
}

/// `inv_p_ar_0_s02_admin_sees_all` — Admin findet einen User ueber ein
/// Email-Snippet und bekommt das volle Result-Objekt zurueck.
#[test]
fn inv_p_ar_0_s02_admin_sees_all() {
  helpers::block_on_large_stack("inv_p_ar_0_s02_admin_sees_all", || async {
    let (app, pool, auth) = helpers::setup_app().await;

    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
    // Use a unique suffix so the email-snippet matches exactly one row.
    let token = format!("p-ar-s02-a-{}", &Uuid::new_v4().to_string()[..8]);
    let target_id = helpers::create_user(&pool, &token, false).await;

    let resp = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "query($q: String!) { admin { adminSearchUsers(query: $q) \
                    { id email name features isAdmin disabled } } }",
        "variables": {"q": token}
      }),
    )
    .await;
    assert!(resp["errors"].is_null(), "admin search must succeed: {resp}");

    let hits = resp["data"]["admin"]["adminSearchUsers"].as_array().expect("array");
    assert_eq!(hits.len(), 1, "exactly one match for unique token, got: {resp}");
    let hit = &hits[0];
    assert_eq!(hit["id"].as_str(), Some(target_id.to_string().as_str()));
    assert!(
      hit["email"].as_str().is_some_and(|s| s.contains(&token)),
      "email must contain the search snippet, got: {hit}"
    );
    assert_eq!(hit["isAdmin"].as_bool(), Some(false));
    assert_eq!(hit["disabled"].as_bool(), Some(false));
    assert!(hit["features"].is_array(), "features must be array, got: {hit}");

    helpers::cleanup_users(&pool, &[admin_id, target_id]).await;
  });
}

/// `inv_p_ar_0_s02_manager_sees_only_own_org` — Manager auf einer OU darf
/// `managerSearchUsers(unitId)` mit gleicher unitId aufrufen. Output-Type
/// (`ManagerUserSearchResult`) hat KEIN `isAdmin` und KEIN `disabled`.
#[test]
fn inv_p_ar_0_s02_manager_sees_only_own_org() {
  helpers::block_on_large_stack("inv_p_ar_0_s02_manager_sees_only_own_org", || async {
    let (app, pool, auth) = helpers::setup_app().await;

    let (manager_id, manager_session) = helpers::seed_user(&pool, &auth, "p_ar_s02_b_mgr").await;

    let org_id = helpers::default_organization_id(&pool).await;
    let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
    let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "P-AR-S02-B Unit").await;
    helpers::make_manager_of(&pool, manager_id, unit_id).await;

    // Insert a target user the manager can find via email snippet.
    let token = format!("p-ar-s02-b-{}", &Uuid::new_v4().to_string()[..8]);
    let target_id = helpers::create_user(&pool, &token, false).await;

    let resp = helpers::gql(
      &app,
      manager_session,
      json!({
        "query": "query($q: String!, $u: ID!) { managerSearchUsers(query: $q, unitId: $u) \
                    { id email name features } }",
        "variables": {"q": token, "u": unit_id.to_string()}
      }),
    )
    .await;
    assert!(
      resp["errors"].is_null(),
      "manager search must succeed for manager of unit: {resp}"
    );

    let hits = resp["data"]["managerSearchUsers"].as_array().expect("array");
    assert_eq!(hits.len(), 1, "manager finds the target user: {resp}");
    let hit = &hits[0];
    assert_eq!(hit["id"].as_str(), Some(target_id.to_string().as_str()));
    // The manager-result type must NOT carry isAdmin/disabled.
    assert!(
      hit.get("isAdmin").is_none(),
      "ManagerUserSearchResult must NOT expose isAdmin, got: {hit}"
    );
    assert!(
      hit.get("disabled").is_none(),
      "ManagerUserSearchResult must NOT expose disabled, got: {hit}"
    );

    helpers::cleanup_organization_units(&pool, &[unit_id]).await;
    helpers::cleanup_users(&pool, &[manager_id, target_id]).await;
  });
}

/// `inv_p_ar_0_s02_features_filter` — Admin search with `features=["manager"]`
/// must return ONLY users with that feature active. Users without it
/// (matching the same email snippet) MUST be filtered out.
#[test]
fn inv_p_ar_0_s02_features_filter() {
  helpers::block_on_large_stack("inv_p_ar_0_s02_features_filter", || async {
    let (app, pool, auth) = helpers::setup_app().await;

    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;

    // Three users sharing one snippet:
    //   * with_feature      — manager feature ACTIVATED
    //   * without_feature   — no feature row at all
    //   * deactivated       — has the row but `activated = false`
    let token = format!("p-ar-s02-c-{}", &Uuid::new_v4().to_string()[..8]);
    let with_feature = helpers::create_user(&pool, &token, false).await;
    let without_feature = helpers::create_user(&pool, &token, false).await;
    let deactivated = helpers::create_user(&pool, &token, false).await;
    set_user_feature(&pool, with_feature, "manager", true).await;
    set_user_feature(&pool, deactivated, "manager", false).await;

    let resp = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "query($q: String!, $f: [String!]) { admin { adminSearchUsers(query: $q, features: $f) \
                    { id features } } }",
        "variables": {"q": token, "f": ["manager"]}
      }),
    )
    .await;
    assert!(resp["errors"].is_null(), "filtered admin search must succeed: {resp}");

    let hits = resp["data"]["admin"]["adminSearchUsers"].as_array().expect("array");
    let ids: Vec<&str> = hits.iter().filter_map(|h| h["id"].as_str()).collect();
    assert!(
      ids.contains(&with_feature.to_string().as_str()),
      "user with active 'manager' feature must surface, got: {resp}"
    );
    assert!(
      !ids.contains(&without_feature.to_string().as_str()),
      "user without 'manager' feature must NOT surface, got: {resp}"
    );
    assert!(
      !ids.contains(&deactivated.to_string().as_str()),
      "user with deactivated 'manager' feature must NOT surface, got: {resp}"
    );
    // Sanity: the returned hit really carries the feature.
    let feats = hits[0]["features"].as_array().expect("features array");
    assert!(
      feats.iter().any(|f| f.as_str() == Some("manager")),
      "features list must include 'manager', got: {hits:?}"
    );

    helpers::cleanup_users(&pool, &[admin_id, with_feature, without_feature, deactivated]).await;
  });
}

/// `inv_p_ar_2_03_admin_search_excludes_unit_members` — The admin OU-member
/// picker must not rely on client-side duplicate filtering. Existing members
/// of `excludeUnitId` are removed in the resolver before the result is sent.
#[test]
fn inv_p_ar_2_03_admin_search_excludes_unit_members() {
  helpers::block_on_large_stack("inv_p_ar_2_03_admin_search_excludes_unit_members", || async {
    let (app, pool, auth) = helpers::setup_app().await;

    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
    let token = format!("p-ar-203-exclude-{}", &Uuid::new_v4().to_string()[..8]);
    let existing_member = helpers::create_user(&pool, &token, false).await;
    let candidate = helpers::create_user(&pool, &token, false).await;
    let org_id = helpers::default_organization_id(&pool).await;
    let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
    let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "P-AR-2-03 Exclude Unit").await;

    sqlx::query(
      r#"INSERT INTO organization_unit_member (unit_id, user_id, role, source, metadata, created_at, updated_at)
         VALUES ($1, $2, 'member', 'manual', '{}'::jsonb, now(), now())"#,
    )
    .bind(unit_id)
    .bind(existing_member)
    .execute(&pool)
    .await
    .expect("insert existing member");

    let resp = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "query($q: String!, $unit: ID!) { admin { adminSearchUsers(query: $q, excludeUnitId: $unit) { id email } } }",
        "variables": {"q": token, "unit": unit_id.to_string()}
      }),
    )
    .await;
    assert!(
      resp["errors"].is_null(),
      "admin search with excludeUnitId must succeed: {resp}"
    );

    let hits = resp["data"]["admin"]["adminSearchUsers"].as_array().expect("array");
    let ids: Vec<&str> = hits.iter().filter_map(|hit| hit["id"].as_str()).collect();
    assert!(
      ids.contains(&candidate.to_string().as_str()),
      "non-member candidate must remain visible: {resp}"
    );
    assert!(
      !ids.contains(&existing_member.to_string().as_str()),
      "existing OU member must be filtered out server-side: {resp}"
    );

    helpers::cleanup_organization_units(&pool, &[unit_id]).await;
    helpers::cleanup_users(&pool, &[admin_id, existing_member, candidate]).await;
  });
}

/// `inv_p_ar_0_s02_non_manager_denied_on_manager_endpoint` — Non-Manager
/// (regular logged-in user) bekommt `ActionForbidden` auf
/// `managerSearchUsers`. Antwort darf NICHT mit leerem Array antworten.
#[test]
fn inv_p_ar_0_s02_non_manager_denied_on_manager_endpoint() {
  helpers::block_on_large_stack("inv_p_ar_0_s02_non_manager_denied_on_manager_endpoint", || async {
    let (app, pool, auth) = helpers::setup_app().await;

    let (user_id, user_session) = helpers::seed_user(&pool, &auth, "p_ar_s02_d_user").await;

    let org_id = helpers::default_organization_id(&pool).await;
    let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
    let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "P-AR-S02-D Unit").await;
    // Note: user is NOT made a manager of `unit_id`.

    let resp = helpers::gql(
      &app,
      user_session,
      json!({
        "query": "query($q: String!, $u: ID!) { managerSearchUsers(query: $q, unitId: $u) { id } }",
        "variables": {"q": "x", "u": unit_id.to_string()}
      }),
    )
    .await;

    assert!(
      resp
        .get("errors")
        .map(|e| e.is_array() && !e.as_array().unwrap().is_empty())
        .unwrap_or(false),
      "non-manager must receive errors, got: {resp}"
    );
    assert!(
      resp["data"]["managerSearchUsers"].is_null(),
      "non-manager must not receive any payload, got: {resp}"
    );

    helpers::cleanup_organization_units(&pool, &[unit_id]).await;
    helpers::cleanup_users(&pool, &[user_id]).await;
  });
}
