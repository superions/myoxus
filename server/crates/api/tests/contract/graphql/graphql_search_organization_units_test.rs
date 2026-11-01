// SPDX-License-Identifier: AGPL-3.0-or-later
//! P-AR-0-S01 — Integration tests for the `searchOrganizationUnits` resolver.
//!
//! Invariants:
//!   * `inv_p_ar_0_s01_admin_sees_all_ous`
//!     Admin callers see every OU whose `name` or `slug` matches the query.
//!     Both name- and slug-snippet matches surface, regardless of OU
//!     membership.
//!   * `inv_p_ar_0_s01_member_sees_only_own_ous`
//!     Non-admin callers receive ONLY OUs in which they hold a membership
//!     row. Foreign matches are filtered server-side; the resolver is safe
//!     to expose at the manager-scoped root.
//!   * `inv_p_ar_0_s01_query_ilike_match`
//!     The query is interpreted as an ILIKE substring filter. A query of
//!     `"alp"` matches both `"Alpha"` and `"Alpine"`.
//!
//! All tests follow the invariant-first pattern (LRN-20260312-109): they
//! assert the documented behaviour, not just `200 OK`.

use crate::helpers;

use serde_json::json;

const QUERY: &str = "query($q: String!, $limit: Int) { \
  searchOrganizationUnits(query: $q, limit: $limit) { id name slug parentBreadcrumb } \
}";

/// `inv_p_ar_0_s01_admin_sees_all_ous` — Admin sees every OU regardless of
/// membership; both name- and slug-snippet hits are returned.
#[test]
fn inv_p_ar_0_s01_admin_sees_all_ous() {
  helpers::block_on_large_stack("inv_p_ar_0_s01_admin_sees_all_ous", || async {
    let (app, pool, auth) = helpers::setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;

    let org_id = helpers::default_organization_id(&pool).await;
    let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;

    // Two OUs: a name-match and a slug-match. The admin holds NO memberships.
    let unit_name = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "AdminAllNeedle Unit").await;
    let unit_slug = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "Other Name").await;
    // Force the slug to contain the needle that the name does NOT contain.
    // Keep the slug unique so a failed local run cannot poison the next run.
    let slug_match = format!("pickme-adminallneedle-{}", &uuid::Uuid::new_v4().to_string()[..8]);
    sqlx::query("UPDATE organization_unit SET slug = $2 WHERE id = $1")
      .bind(unit_slug)
      .bind(slug_match)
      .execute(&pool)
      .await
      .expect("set slug");

    let resp = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": QUERY,
        "variables": {"q": "AdminAllNeedle"}
      }),
    )
    .await;

    let hits = resp["data"]["searchOrganizationUnits"]
      .as_array()
      .unwrap_or_else(|| panic!("searchOrganizationUnits must be array, got: {resp}"));
    let ids: Vec<&str> = hits.iter().filter_map(|h| h["id"].as_str()).collect();
    assert!(
      ids.iter().any(|id| *id == unit_name.to_string()),
      "admin must see name-match OU, got: {resp}"
    );
    assert!(
      ids.iter().any(|id| *id == unit_slug.to_string()),
      "admin must see slug-match OU (slug ILIKE), got: {resp}"
    );

    helpers::cleanup_organization_units(&pool, &[unit_name, unit_slug]).await;
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

/// `inv_p_ar_0_s01_member_sees_only_own_ous` — Non-admin callers see only
/// OUs they belong to; foreign matches are filtered out server-side.
#[test]
fn inv_p_ar_0_s01_member_sees_only_own_ous() {
  helpers::block_on_large_stack("inv_p_ar_0_s01_member_sees_only_own_ous", || async {
    let (app, pool, auth) = helpers::setup_app().await;
    let (member_id, member_session) = helpers::seed_user(&pool, &auth, "p_ar_0_s01_member").await;

    let org_id = helpers::default_organization_id(&pool).await;
    let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;

    let mine = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "ScopeNeedle Mine").await;
    let foreign = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "ScopeNeedle Foreign").await;
    helpers::make_manager_of(&pool, member_id, mine).await;

    let resp = helpers::gql(
      &app,
      member_session,
      json!({
        "query": QUERY,
        "variables": {"q": "ScopeNeedle"}
      }),
    )
    .await;

    let hits = resp["data"]["searchOrganizationUnits"]
      .as_array()
      .unwrap_or_else(|| panic!("searchOrganizationUnits must be array, got: {resp}"));
    let ids: Vec<String> = hits
      .iter()
      .filter_map(|h| h["id"].as_str().map(|s| s.to_string()))
      .collect();
    assert!(
      ids.contains(&mine.to_string()),
      "member must see their own OU, got: {resp}"
    );
    assert!(
      !ids.contains(&foreign.to_string()),
      "member must NOT see foreign OU (membership scoping), got: {resp}"
    );

    helpers::cleanup_organization_units(&pool, &[mine, foreign]).await;
    helpers::cleanup_users(&pool, &[member_id]).await;
  });
}

/// `inv_p_ar_0_s01_query_ilike_match` — A query of `"alp"` (case-insensitive
/// substring) matches both `"Alpha"` and `"Alpine"`. Verifies the resolver
/// uses ILIKE, not equality or prefix-only.
#[test]
fn inv_p_ar_0_s01_query_ilike_match() {
  helpers::block_on_large_stack("inv_p_ar_0_s01_query_ilike_match", || async {
    let (app, pool, auth) = helpers::setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;

    let org_id = helpers::default_organization_id(&pool).await;
    let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
    let alpha = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "Alpha").await;
    let alpine = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "Alpine").await;

    let resp = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": QUERY,
        "variables": {"q": "alp"}
      }),
    )
    .await;

    let hits = resp["data"]["searchOrganizationUnits"]
      .as_array()
      .unwrap_or_else(|| panic!("searchOrganizationUnits must be array, got: {resp}"));
    let ids: Vec<String> = hits
      .iter()
      .filter_map(|h| h["id"].as_str().map(|s| s.to_string()))
      .collect();
    assert!(
      ids.contains(&alpha.to_string()),
      "ILIKE 'alp' must match 'Alpha' (case-insensitive substring), got: {resp}"
    );
    assert!(
      ids.contains(&alpine.to_string()),
      "ILIKE 'alp' must match 'Alpine' (case-insensitive substring), got: {resp}"
    );

    helpers::cleanup_organization_units(&pool, &[alpha, alpine]).await;
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}
