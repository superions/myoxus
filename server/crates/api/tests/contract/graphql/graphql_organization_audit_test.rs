// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration tests for ORG-G-06 — Manager-scoped Audit-Log.
//!
//! Invarianten:
//!   * `INV-G-06-A` — Audit-Events fuer OU-Mutationen tragen
//!     `target_unit_id`. Eine Mutation auf OU `X` schreibt eine Zeile mit
//!     `target_unit_id = X`.
//!   * `INV-G-06-B` — `myOrganizationAuditLog(unitId)` returns nur Eintraege
//!     mit `target_unit_id = unitId`. Cross-OU-Leak ist Regression.
//!   * `INV-G-06-C` — Non-Manager auf einer OU bekommt `ActionForbidden`,
//!     keine leere Liste.

use crate::helpers;

use serde_json::json;

/// `INV-G-06-A` — Member-Assign auf einer OU schreibt eine Audit-Row mit
/// `target_unit_id = unit_id`.
#[tokio::test]
async fn inv_g06_a_member_assign_writes_target_unit_id() {
  let (app, pool, auth) = helpers::setup_app_with_audit().await;

  let (admin_user_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
  let (target_user_id, _) = helpers::seed_user(&pool, &auth, "g06_target").await;
  sqlx::query("UPDATE users SET name=$2 WHERE id=$1")
    .bind(target_user_id)
    .bind("\t g06_target \u{2003}")
    .execute(&pool)
    .await
    .expect("stage Unicode-padded audit label");

  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "G06 A Unit").await;

  let assign = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation($i: AssignOrganizationManagerInput!) { admin { assignOrganizationManager(input: $i) { unitId } } }",
      "variables": {"i": {
        "unitId": unit_id.to_string(),
        "userId": target_user_id.to_string(),
        "role": "Member",
      }}
    }),
  )
  .await;
  assert!(
    assign["errors"].is_null(),
    "assignOrganizationManager must succeed: {assign}"
  );

  // Scope the read to OUR unit so parallel tests do not leak rows into the
  // assertion window. target_label must be human-readable; raw UUID labels are
  // unusable in the Web organisation settings audit panel.
  let row: Option<(sqlx::types::Uuid, String)> = sqlx::query_as(
    "SELECT target_unit_id, target_label FROM admin_audit_log
       WHERE event_key = 'organization.member.assign'
         AND target_unit_id = $1
       ORDER BY created_at DESC LIMIT 1",
  )
  .bind(unit_id)
  .fetch_optional(&pool)
  .await
  .expect("query audit row");

  let (got_unit, got_label) = row.expect("audit row missing — recorder may not have flushed yet");
  assert_eq!(
    got_unit, unit_id,
    "audit row for organization.member.assign must carry target_unit_id = unit_id"
  );
  assert_eq!(
    got_label, "g06_target",
    "audit row target_label must carry the assigned user's display name"
  );

  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
  helpers::cleanup_users(&pool, &[admin_user_id, target_user_id]).await;
}

/// `INV-G-06-B` — Manager A sieht NUR Audit-Eintraege fuer OU A, nicht
/// fuer OU B. Cross-OU-Leak waere Regression.
#[tokio::test]
async fn inv_g06_b_manager_audit_log_isolates_units() {
  let (app, pool, auth) = helpers::setup_app_with_audit().await;

  let (admin_user_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
  let (manager_a_id, manager_a_session) = helpers::seed_user(&pool, &auth, "g06_b_mgr_a").await;
  // Two extra users so the admin can stage an audit row on each unit
  // without overwriting manager_a's manager-role.
  let other_a_id = helpers::create_user(&pool, "g06_b_other_a", false).await;
  let other_b_id = helpers::create_user(&pool, "g06_b_other_b", false).await;

  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_a = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "G06 B Unit A").await;
  let unit_b = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "G06 B Unit B").await;
  helpers::make_manager_of(&pool, manager_a_id, unit_a).await;

  // Stage one audit event per unit by performing a member-assign on each
  // — using fresh users so manager_a stays a manager on unit_a.
  let _ = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation($i: AssignOrganizationManagerInput!) { admin { assignOrganizationManager(input: $i) { unitId } } }",
      "variables": {"i": {"unitId": unit_a.to_string(), "userId": other_a_id.to_string(), "role": "Member"}}
    }),
  ).await;
  let _ = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation($i: AssignOrganizationManagerInput!) { admin { assignOrganizationManager(input: $i) { unitId } } }",
      "variables": {"i": {"unitId": unit_b.to_string(), "userId": other_b_id.to_string(), "role": "Member"}}
    }),
  ).await;
  tokio::time::sleep(std::time::Duration::from_millis(80)).await;

  let resp = helpers::gql(
    &app,
    manager_a_session,
    json!({
      "query": "query($u: ID!) { myOrganizationAuditLog(unitId: $u, take: 50) { eventKey targetUnitId target { label } } }",
      "variables": {"u": unit_a.to_string()}
    }),
  )
  .await;
  assert!(resp["errors"].is_null(), "manager-A query must succeed: {resp}");
  let entries = resp["data"]["myOrganizationAuditLog"].as_array().expect("array");
  assert!(
    !entries.is_empty(),
    "manager A must see at least one entry for own unit, got: {resp}"
  );
  for e in entries {
    assert_eq!(
      e["targetUnitId"].as_str(),
      Some(unit_a.to_string().as_str()),
      "every returned entry must target unit_a, got: {e}"
    );
  }
  let member_assign = entries
    .iter()
    .find(|e| e["eventKey"].as_str() == Some("organization.member.assign"))
    .expect("manager audit log must include the staged member assign row");
  assert_eq!(
    member_assign["target"]["label"].as_str(),
    Some("g06_b_other_a"),
    "manager audit target label must be the user display name, not a UUID"
  );

  helpers::cleanup_organization_units(&pool, &[unit_a, unit_b]).await;
  helpers::cleanup_users(&pool, &[admin_user_id, manager_a_id, other_a_id, other_b_id]).await;
}

/// `INV-G-06-C` — Non-Manager bekommt `ActionForbidden`, nicht eine leere
/// Liste. Stiller Erfolg waere ein Information-Leak (Existenz der OU).
#[tokio::test]
async fn inv_g06_c_non_manager_is_forbidden() {
  let (app, pool, auth) = helpers::setup_app_with_audit().await;

  let (outsider_id, outsider_session) = helpers::seed_user(&pool, &auth, "g06_c_outsider").await;

  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "G06 C Unit").await;

  let resp = helpers::gql(
    &app,
    outsider_session,
    json!({
      "query": "query($u: ID!) { myOrganizationAuditLog(unitId: $u) { eventKey } }",
      "variables": {"u": unit_id.to_string()}
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
    resp["data"]["myOrganizationAuditLog"].is_null(),
    "non-manager must not receive payload, got: {resp}"
  );

  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
  helpers::cleanup_users(&pool, &[outsider_id]).await;
}
