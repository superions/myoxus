// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration tests for `P-AR-2-S02` — admin-surface
//! `userOrganizationMemberships(userId)` resolver.
//!
//! Invarianten:
//!   * `inv_p_ar_2_s02_returns_all_ous_for_user` — Ein User der in zwei
//!     OUs Mitglied ist (eine als `manager`, eine als `member`) bekommt
//!     beide Memberships zurueck. Jede Antwortzeile traegt
//!     `unitId`, `unitName`, `unitSlug`, `role`, `source`, `joinedAt`.
//!     Sortierung: OU-Name ASC.
//!   * `inv_p_ar_2_s02_non_admin_denied` — Non-Admin (regulaerer User)
//!     bekommt `errors`, kein Daten-Payload (`data.admin` ist `null` oder
//!     `data.admin.userOrganizationMemberships` ist `null`).

use crate::helpers;

use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

/// Insert a `member`-role membership directly via SQL. Distinct from the
/// `make_manager_of` helper which always uses role `manager` and also
/// flips the user-feature flag.
async fn add_member_of(pool: &PgPool, user_id: Uuid, unit_id: Uuid) {
  sqlx::query(
    r#"INSERT INTO organization_unit_member (unit_id, user_id, role, source, metadata, created_at, updated_at)
       VALUES ($1, $2, 'member', 'manual', '{}'::jsonb, now(), now())
       ON CONFLICT (unit_id, user_id) DO UPDATE SET role = 'member', updated_at = now()"#,
  )
  .bind(unit_id)
  .bind(user_id)
  .execute(pool)
  .await
  .expect("upsert org member (member role)");
}

/// `inv_p_ar_2_s02_returns_all_ous_for_user` — Admin queries memberships
/// for a user that is in two OUs. Both rows surface with the correct
/// roles and OU snapshots, sorted by OU name ASC.
#[tokio::test]
async fn inv_p_ar_2_s02_returns_all_ous_for_user() {
  let (app, pool, auth) = helpers::setup_app().await;

  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
  let (target_id, _target_session) = helpers::seed_user(&pool, &auth, "p_ar_2_s02_a_target").await;

  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  // Names chosen so ASC sort order is deterministic ("Alpha" < "Beta").
  let unit_name_alpha = format!("P-AR-2-S02-A Alpha {}", &Uuid::new_v4().to_string()[..6]);
  let unit_name_beta = format!("P-AR-2-S02-A Beta {}", &Uuid::new_v4().to_string()[..6]);
  let unit_alpha = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, &unit_name_alpha).await;
  let unit_beta = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, &unit_name_beta).await;

  // Alpha: target as plain `member`. Beta: target as `manager`.
  add_member_of(&pool, target_id, unit_alpha).await;
  helpers::make_manager_of(&pool, target_id, unit_beta).await;
  // Admin discovery retains inactive assignments for diagnosis; this must not
  // silently adopt MCP's active-only default.
  sqlx::query("UPDATE organization_unit SET status='archived' WHERE id=$1")
    .bind(unit_beta)
    .execute(&pool)
    .await
    .expect("retain archived assignment");

  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "query($u: ID!) { admin { userOrganizationMemberships(userId: $u) \
                  { unitId unitName unitSlug role source joinedAt } } }",
      "variables": {"u": target_id.to_string()}
    }),
  )
  .await;
  assert!(resp["errors"].is_null(), "admin query must succeed: {resp}");

  let hits = resp["data"]["admin"]["userOrganizationMemberships"]
    .as_array()
    .expect("array");
  assert_eq!(hits.len(), 2, "expected exactly two memberships, got: {resp}");

  // Sorted ASC by unit name → Alpha first, Beta second.
  let first = &hits[0];
  let second = &hits[1];
  assert_eq!(first["unitId"].as_str(), Some(unit_alpha.to_string().as_str()));
  assert_eq!(first["unitName"].as_str(), Some(unit_name_alpha.as_str()));
  assert_eq!(first["role"].as_str(), Some("member"));
  assert_eq!(first["source"].as_str(), Some("manual"));
  assert!(
    first["unitSlug"].as_str().is_some_and(|s| !s.is_empty()),
    "unitSlug must be non-empty, got: {first}"
  );
  assert!(
    first["joinedAt"].as_str().is_some(),
    "joinedAt must be a string, got: {first}"
  );

  assert_eq!(second["unitId"].as_str(), Some(unit_beta.to_string().as_str()));
  assert_eq!(second["unitName"].as_str(), Some(unit_name_beta.as_str()));
  assert_eq!(second["role"].as_str(), Some("manager"));
  assert_eq!(second["source"].as_str(), Some("manual"));

  helpers::cleanup_organization_units(&pool, &[unit_alpha, unit_beta]).await;
  helpers::cleanup_users(&pool, &[admin_id, target_id]).await;
}

/// `inv_p_ar_2_s02_non_admin_denied` — Non-Admin gets ActionForbidden.
/// Endpoint must NOT silently return an empty list.
#[tokio::test]
async fn inv_p_ar_2_s02_non_admin_denied() {
  let (app, pool, auth) = helpers::setup_app().await;

  let (user_id, user_session) = helpers::seed_user(&pool, &auth, "p_ar_2_s02_b_user").await;
  let (target_id, _target_session) = helpers::seed_user(&pool, &auth, "p_ar_2_s02_b_target").await;

  let resp = helpers::gql(
    &app,
    user_session,
    json!({
      "query": "query($u: ID!) { admin { userOrganizationMemberships(userId: $u) { unitId } } }",
      "variables": {"u": target_id.to_string()}
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
  // Either the whole `admin` selection is null, or the field is null —
  // depending on how `ensure_admin` propagates. Both shapes prove that
  // no payload leaked.
  let leaked = resp["data"]["admin"]["userOrganizationMemberships"].as_array();
  assert!(
    leaked.is_none(),
    "non-admin must not receive any membership payload, got: {resp}"
  );

  helpers::cleanup_users(&pool, &[user_id, target_id]).await;
}
