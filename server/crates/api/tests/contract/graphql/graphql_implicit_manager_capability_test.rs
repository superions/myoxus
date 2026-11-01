// SPDX-License-Identifier: AGPL-3.0-or-later
//! Integration tests for `P-AR-2-S03` — implicit `FeatureType.Manager`
//! capability hooks.
//!
//! The global `Manager`-feature is **not UI-toggle-bar**; it is a
//! consequence of OU-membership with `role='manager'`. The four mutations
//! that flip such memberships
//!   * `assignOrganizationManager`            (admin)
//!   * `addOrganizationUnitMemberAsManager`   (manager-scoped)
//!   * `unassignOrganizationManager`          (admin)
//!   * `removeOrganizationUnitMemberAsManager` (manager-scoped)
//!
//! must therefore set / revoke the capability automatically and record a
//! `user.feature.manager.implicit_set` / `.implicit_revoke` audit event with
//! `target_unit_id = unit_id`.
//!
//! Invariants:
//!   * `inv_p_ar_2_s03_assign_manager_grants_capability` — User without
//!     capability gains it after a manager-role assign via
//!     `assignOrganizationManager`.
//!   * `inv_p_ar_2_s03_unassign_last_manager_revokes_capability` — User
//!     with exactly one manager-membership loses the capability when that
//!     last membership is removed.
//!   * `inv_p_ar_2_s03_unassign_one_of_many_keeps_capability` — User with
//!     two manager-memberships keeps the capability when one is removed.
//!   * `inv_p_ar_2_s03_role_downgrade_last_manager_revokes_capability` —
//!     User with exactly one manager-membership loses the capability when
//!     that membership is downgraded to `member`.
//!   * `inv_p_ar_2_03_unit_members_include_user_identity` — Admin member
//!     roster returns the identity fields required by the detail UI.
//!   * `inv_p_ar_2_s03_audit_carries_unit_id` — implicit set / revoke
//!     audit rows carry `target_unit_id` matching the OU action.

use crate::helpers;

use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

/// Read the `activated` flag for a user's `manager`-feature row, returning
/// `None` if no row exists yet.
async fn read_manager_feature(pool: &PgPool, user_id: Uuid) -> Option<bool> {
  sqlx::query_scalar::<_, bool>("SELECT activated FROM user_features WHERE user_id = $1 AND feature_name = 'manager'")
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .expect("query user_features")
}

/// `inv_p_ar_2_s03_assign_manager_grants_capability` — Admin assigns
/// `role=manager` on an OU. The user previously had NO `manager`-feature
/// row; afterwards `activated=true`.
#[tokio::test]
async fn inv_p_ar_2_s03_assign_manager_grants_capability() {
  let (app, pool, auth) = helpers::setup_app_with_audit().await;

  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
  let (target_id, _) = helpers::seed_user(&pool, &auth, "p_ar_2_s03_a_target").await;

  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "P-AR-2-S03 A Unit").await;

  // Pre-condition: target has NO manager-feature row.
  assert_eq!(
    read_manager_feature(&pool, target_id).await,
    None,
    "target must start with no manager-feature row"
  );

  let warm = helpers::gql(
    &app,
    admin_session,
    json!({"query":"query($id:String!){admin{userById(id:$id){features}}}","variables":{"id":target_id}}),
  )
  .await;
  assert!(warm["errors"].is_null(), "warm empty capability projection: {warm}");
  assert!(
    !warm["data"]["admin"]["userById"]["features"]
      .as_array()
      .expect("features")
      .contains(&json!("Manager"))
  );

  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation($i: AssignOrganizationManagerInput!) { admin { assignOrganizationManager(input: $i) { unitId userId role } } }",
      "variables": {"i": {
        "unitId": unit_id.to_string(),
        "userId": target_id.to_string(),
        "role": "Manager",
      }}
    }),
  )
  .await;
  assert!(
    resp["errors"].is_null(),
    "assignOrganizationManager(role=MANAGER) must succeed: {resp}"
  );

  // Capability now active.
  assert_eq!(
    read_manager_feature(&pool, target_id).await,
    Some(true),
    "manager-capability must be activated after manager-role assign, db: {:?}",
    read_manager_feature(&pool, target_id).await
  );

  let readback = helpers::gql(
    &app,
    admin_session,
    json!({"query":"query($id:String!){admin{userById(id:$id){features}}}","variables":{"id":target_id}}),
  )
  .await;
  assert!(readback["errors"].is_null(), "read committed capability: {readback}");
  assert!(
    readback["data"]["admin"]["userById"]["features"]
      .as_array()
      .expect("features")
      .contains(&json!("Manager")),
    "warm feature cache must expose committed Manager grant"
  );

  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
  helpers::cleanup_users(&pool, &[admin_id, target_id]).await;
}

/// `inv_p_ar_2_s03_unassign_last_manager_revokes_capability` — User is
/// manager on exactly one OU. After `unassignOrganizationManager` the
/// capability flips to `activated=false`.
#[tokio::test]
async fn inv_p_ar_2_s03_unassign_last_manager_revokes_capability() {
  let (app, pool, auth) = helpers::setup_app_with_audit().await;

  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
  let (target_id, _) = helpers::seed_user(&pool, &auth, "p_ar_2_s03_b_target").await;

  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "P-AR-2-S03 B Unit").await;

  // Stage: target is manager of the single OU.
  helpers::make_manager_of(&pool, target_id, unit_id).await;
  assert_eq!(
    read_manager_feature(&pool, target_id).await,
    Some(true),
    "make_manager_of must set the feature row"
  );

  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation($u: ID!, $t: ID!) { admin { unassignOrganizationManager(unitId: $u, userId: $t) } }",
      "variables": {"u": unit_id.to_string(), "t": target_id.to_string()}
    }),
  )
  .await;
  assert!(
    resp["errors"].is_null() && resp["data"]["admin"]["unassignOrganizationManager"] == true,
    "unassignOrganizationManager must succeed: {resp}"
  );

  // Capability now revoked (last manager-membership gone).
  assert_eq!(
    read_manager_feature(&pool, target_id).await,
    Some(false),
    "manager-capability must be revoked after last manager-membership removal"
  );

  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
  helpers::cleanup_users(&pool, &[admin_id, target_id]).await;
}

/// `inv_p_ar_2_s03_unassign_one_of_many_keeps_capability` — User is manager
/// on two OUs. Removing manager-role from one OU MUST keep the global
/// capability active because the user still manages another OU.
#[tokio::test]
async fn inv_p_ar_2_s03_unassign_one_of_many_keeps_capability() {
  let (app, pool, auth) = helpers::setup_app_with_audit().await;

  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
  let (target_id, _) = helpers::seed_user(&pool, &auth, "p_ar_2_s03_c_target").await;

  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_a = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "P-AR-2-S03 C Unit A").await;
  let unit_b = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "P-AR-2-S03 C Unit B").await;
  helpers::make_manager_of(&pool, target_id, unit_a).await;
  helpers::make_manager_of(&pool, target_id, unit_b).await;
  assert_eq!(read_manager_feature(&pool, target_id).await, Some(true));

  // Remove from unit_a only.
  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation($u: ID!, $t: ID!) { admin { unassignOrganizationManager(unitId: $u, userId: $t) } }",
      "variables": {"u": unit_a.to_string(), "t": target_id.to_string()}
    }),
  )
  .await;
  assert!(resp["errors"].is_null(), "unassign on unit_a must succeed: {resp}");

  // Capability MUST still be active (user still manages unit_b).
  assert_eq!(
    read_manager_feature(&pool, target_id).await,
    Some(true),
    "capability must stay active while another manager-membership exists"
  );

  helpers::cleanup_organization_units(&pool, &[unit_a, unit_b]).await;
  helpers::cleanup_users(&pool, &[admin_id, target_id]).await;
}

/// `inv_p_ar_2_s03_role_downgrade_last_manager_revokes_capability` —
/// Inline role editing in the adminfrontend uses `assignOrganizationManager`
/// for both upgrades and downgrades. A downgrade from `manager` to `member`
/// must therefore run the same implicit-revoke invariant as a removal.
#[tokio::test]
async fn inv_p_ar_2_s03_role_downgrade_last_manager_revokes_capability() {
  let (app, pool, auth) = helpers::setup_app_with_audit().await;

  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
  let (target_id, _) = helpers::seed_user(&pool, &auth, "p_ar_2_s03_e_target").await;

  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "P-AR-2-S03 E Unit").await;

  helpers::make_manager_of(&pool, target_id, unit_id).await;
  assert_eq!(
    read_manager_feature(&pool, target_id).await,
    Some(true),
    "precondition: manager feature must be active"
  );

  let warm = helpers::gql(
    &app,
    admin_session,
    json!({"query":"query($id:String!){admin{userById(id:$id){features}}}","variables":{"id":target_id}}),
  )
  .await;
  assert!(
    warm["data"]["admin"]["userById"]["features"]
      .as_array()
      .expect("warm features")
      .contains(&json!("Manager"))
  );

  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation($i: AssignOrganizationManagerInput!) { admin { assignOrganizationManager(input: $i) { unitId userId role } } }",
      "variables": {"i": {
        "unitId": unit_id.to_string(),
        "userId": target_id.to_string(),
        "role": "Member",
      }}
    }),
  )
  .await;
  assert!(
    resp["errors"].is_null(),
    "role downgrade through assignOrganizationManager must succeed: {resp}"
  );
  assert_eq!(
    resp["data"]["admin"]["assignOrganizationManager"]["role"], "Member",
    "membership role must be downgraded to MEMBER"
  );
  assert_eq!(
    read_manager_feature(&pool, target_id).await,
    Some(false),
    "last manager-role downgrade must revoke manager capability"
  );

  let readback = helpers::gql(
    &app,
    admin_session,
    json!({"query":"query($id:String!){admin{userById(id:$id){features}}}","variables":{"id":target_id}}),
  )
  .await;
  assert!(readback["errors"].is_null(), "read revoked capability: {readback}");
  assert!(
    !readback["data"]["admin"]["userById"]["features"]
      .as_array()
      .expect("features")
      .contains(&json!("Manager")),
    "warm feature cache must drop the last derived Manager grant"
  );

  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
  helpers::cleanup_users(&pool, &[admin_id, target_id]).await;
}

/// `inv_p_ar_2_03_unit_members_include_user_identity` — P-AR-2-03's member
/// table renders Avatar | Name | E-Mail | Role | Source. The GraphQL
/// projection must therefore enrich membership rows with user snapshots,
/// not force the adminfrontend to issue one query per member.
#[tokio::test]
async fn inv_p_ar_2_03_unit_members_include_user_identity() {
  let (app, pool, auth) = helpers::setup_app_with_audit().await;

  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
  let suffix = "p_ar_2_03_identity_target";
  let (target_id, _) = helpers::seed_user(&pool, &auth, suffix).await;

  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "P-AR-2-03 Identity Unit").await;

  let assign = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation($i: AssignOrganizationManagerInput!) { admin { assignOrganizationManager(input: $i) { unitId userId role } } }",
      "variables": {"i": {
        "unitId": unit_id.to_string(),
        "userId": target_id.to_string(),
        "role": "Member",
      }}
    }),
  )
  .await;
  assert!(assign["errors"].is_null(), "membership assign must succeed: {assign}");

  let resp = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "query($unit: ID!) { admin { organizationUnitMembers(unitId: $unit) { userId userEmail userName userAvatarUrl role source } } }",
      "variables": {"unit": unit_id.to_string()}
    }),
  )
  .await;
  assert!(
    resp["errors"].is_null(),
    "organizationUnitMembers identity projection must succeed: {resp}"
  );
  let members = resp["data"]["admin"]["organizationUnitMembers"]
    .as_array()
    .expect("members array");
  let member = members
    .iter()
    .find(|row| row["userId"].as_str() == Some(target_id.to_string().as_str()))
    .expect("target membership row");
  let expected_email = format!("{suffix}_{target_id}@example.test");
  assert_eq!(
    member["userEmail"].as_str(),
    Some(expected_email.as_str()),
    "member roster must expose e-mail for UI column"
  );
  assert_eq!(
    member["userName"].as_str(),
    Some(suffix),
    "member roster must expose display name for UI column"
  );
  assert_eq!(member["role"].as_str(), Some("Member"));
  assert_eq!(member["source"].as_str(), Some("Manual"));
  assert!(
    member.get("userAvatarUrl").is_some(),
    "avatar field must exist even when no avatar is configured"
  );

  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
  helpers::cleanup_users(&pool, &[admin_id, target_id]).await;
}

/// `inv_p_ar_2_s03_audit_carries_unit_id` — Both implicit transitions emit
/// audit rows tagged with `target_unit_id = unit_id` so an OU-scoped audit
/// log query surfaces them.
#[tokio::test]
async fn inv_p_ar_2_s03_audit_carries_unit_id() {
  let (app, pool, auth) = helpers::setup_app_with_audit().await;

  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
  let (target_id, _) = helpers::seed_user(&pool, &auth, "p_ar_2_s03_d_target").await;

  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "P-AR-2-S03 D Unit").await;

  // Trigger implicit_set via admin assign with role=MANAGER.
  let resp_assign = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation($i: AssignOrganizationManagerInput!) { admin { assignOrganizationManager(input: $i) { unitId } } }",
      "variables": {"i": {
        "unitId": unit_id.to_string(),
        "userId": target_id.to_string(),
        "role": "Manager",
      }}
    }),
  )
  .await;
  assert!(resp_assign["errors"].is_null(), "assign must succeed: {resp_assign}");

  // The recorder is fire-and-forget — give the spawned task a tick.
  tokio::time::sleep(std::time::Duration::from_millis(120)).await;

  let set_row: Option<(sqlx::types::Uuid, String)> = sqlx::query_as(
    "SELECT target_unit_id, target_id FROM admin_audit_log
       WHERE event_key = 'user.feature.manager.implicit_set'
         AND target_unit_id = $1
       ORDER BY created_at DESC LIMIT 1",
  )
  .bind(unit_id)
  .fetch_optional(&pool)
  .await
  .expect("query implicit_set audit row");
  let (got_unit, got_target) = set_row.expect("implicit_set audit row missing");
  assert_eq!(got_unit, unit_id, "implicit_set must carry target_unit_id = unit_id");
  assert_eq!(
    got_target,
    target_id.to_string(),
    "implicit_set audit target_id must be the user_id"
  );

  // Trigger implicit_revoke via unassign of the only manager-membership.
  let resp_unassign = helpers::gql(
    &app,
    admin_session,
    json!({
      "query": "mutation($u: ID!, $t: ID!) { admin { unassignOrganizationManager(unitId: $u, userId: $t) } }",
      "variables": {"u": unit_id.to_string(), "t": target_id.to_string()}
    }),
  )
  .await;
  assert!(
    resp_unassign["errors"].is_null(),
    "unassign must succeed: {resp_unassign}"
  );

  tokio::time::sleep(std::time::Duration::from_millis(120)).await;

  let revoke_row: Option<(sqlx::types::Uuid, String)> = sqlx::query_as(
    "SELECT target_unit_id, target_id FROM admin_audit_log
       WHERE event_key = 'user.feature.manager.implicit_revoke'
         AND target_unit_id = $1
       ORDER BY created_at DESC LIMIT 1",
  )
  .bind(unit_id)
  .fetch_optional(&pool)
  .await
  .expect("query implicit_revoke audit row");
  let (got_unit_r, got_target_r) = revoke_row.expect("implicit_revoke audit row missing");
  assert_eq!(
    got_unit_r, unit_id,
    "implicit_revoke must carry target_unit_id = unit_id"
  );
  assert_eq!(
    got_target_r,
    target_id.to_string(),
    "implicit_revoke audit target_id must be the user_id"
  );

  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
  helpers::cleanup_users(&pool, &[admin_id, target_id]).await;
}

/// Exercise locked preconditions and rollback in the same PostgreSQL owner used
/// by all three adapters; then cross the manager GraphQL authorization boundary.
#[tokio::test]
async fn inv_manual_membership_transaction_rolls_back_and_serializes_manager_targets() {
  use futures_util::FutureExt;
  use myoxus_application::organization::{MembershipChange, MembershipOperation, OrganizationMembershipWriter};
  use myoxus_domain::entities::OrganizationUnitRole;
  use myoxus_infrastructure::organization::PgOrganizationMembershipWriter;
  use std::panic::AssertUnwindSafe;
  let (app, pool, auth) = helpers::setup_app_with_audit().await;
  let (manager, manager_session) = helpers::seed_user(&pool, &auth, "manual_membership_manager").await;
  let (target, _) = helpers::seed_user(&pool, &auth, "manual_membership_target").await;
  let org = helpers::default_organization_id(&pool).await;
  let kind = helpers::preset_unit_type_id(&pool, "team").await;
  let unit = helpers::create_organization_unit(&pool, org, kind, None, "Manual atomic membership").await;
  let original_policy: bool =
    sqlx::query_scalar("SELECT manager_can_manage_ou_members FROM organization_policy WHERE organization_id=$1")
      .bind(org)
      .fetch_one(&pool)
      .await
      .expect("read initial test policy");
  let failure_name = format!("ua09_{}", Uuid::new_v4().simple());
  let writer = PgOrganizationMembershipWriter::new(pool.clone());
  let change = MembershipChange {
    organization_id: Some(org),
    unit_id: unit,
    user_id: target,
    operation: MembershipOperation::Add,
    role: OrganizationUnitRole::Manager,
    metadata: json!({"assigned_by":"transaction-test"}),
    manager_id: None,
  };
  let result = AssertUnwindSafe(async {
    // The fault applies only to this disposable user's capability row. Failure
    // must roll back the already-written membership, not just the feature row.
    sqlx::query(&format!("CREATE FUNCTION {failure_name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id = '{target}'::uuid THEN RAISE EXCEPTION 'owned capability failure'; END IF; RETURN NEW; END $$"))
      .execute(&pool).await.expect("create owned failure function");
    sqlx::query(&format!("CREATE TRIGGER {failure_name} BEFORE INSERT OR UPDATE ON user_features FOR EACH ROW EXECUTE FUNCTION {failure_name}()"))
      .execute(&pool).await.expect("create owned failure trigger");
    assert!(writer.commit(&change).await.is_err(), "capability fault must reject aggregate");
    assert!(!sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM organization_unit_member WHERE unit_id=$1 AND user_id=$2)")
      .bind(unit).bind(target).fetch_one(&pool).await.expect("read rollback membership"));
    assert_eq!(read_manager_feature(&pool,target).await, None);
    sqlx::query(&format!("DROP TRIGGER {failure_name} ON user_features")).execute(&pool).await.expect("drop fault trigger");
    sqlx::query(&format!("DROP FUNCTION {failure_name}()")).execute(&pool).await.expect("drop fault function");
    let (a,b) = tokio::join!(writer.commit(&change), writer.commit(&change));
    assert_eq!(usize::from(a.is_ok())+usize::from(b.is_ok()),1,"add-only must have one winner");
    assert_eq!(read_manager_feature(&pool,target).await,Some(true));
    helpers::make_manager_of(&pool, manager, unit).await;
    sqlx::query("UPDATE organization_policy SET manager_can_manage_ou_members=true WHERE organization_id=$1")
      .bind(org).execute(&pool).await.expect("enable test member policy");
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM admin_audit_log WHERE target_unit_id=$1")
      .bind(unit).fetch_one(&pool).await.expect("audit before manager refusals");
    for (query,variables) in [
      ("mutation($u: ID!, $t: ID!) { addOrganizationUnitMemberAsManager(unitId:$u,userId:$t,role:Member) { role } }",json!({"u":unit,"t":target})),
      ("mutation($u: ID!, $t: ID!) { removeOrganizationUnitMemberAsManager(unitId:$u,userId:$t) }",json!({"u":unit,"t":target})),
    ] {
      let response=helpers::gql(&app,manager_session,json!({"query":query,"variables":variables})).await;
      assert!(!response["errors"].is_null(),"manager target must be forbidden: {response}");
    }
    assert_eq!(sqlx::query_scalar::<_,String>("SELECT role::text FROM organization_unit_member WHERE unit_id=$1 AND user_id=$2")
      .bind(unit).bind(target).fetch_one(&pool).await.expect("unchanged target role"),"manager");
    assert_eq!(read_manager_feature(&pool,target).await,Some(true));
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM admin_audit_log WHERE target_unit_id=$1")
      .bind(unit).fetch_one(&pool).await.expect("audit after manager refusals"),before);
    let removed=writer.commit(&MembershipChange { operation:MembershipOperation::RemoveExisting,..change.clone() }).await.expect("remove existing manager");
    assert_eq!(removed.manager_capability,Some(false));
    assert!(writer.commit(&MembershipChange { operation:MembershipOperation::SetRole,..change.clone() }).await.is_err());
    assert!(writer.commit(&MembershipChange { operation:MembershipOperation::RemoveExisting,..change.clone() }).await.is_err());
    // An explicit global grant is not owned by Reader/Member-only writes.
    sqlx::query("UPDATE user_features SET activated=true,reason='explicit test grant' WHERE user_id=$1 AND feature_name='manager'")
      .bind(target).execute(&pool).await.expect("explicit manager grant");
    writer.commit(&MembershipChange { role:OrganizationUnitRole::Reader,..change.clone() }).await.expect("reader assignment");
    let response=helpers::gql(&app,manager_session,json!({"query":"mutation($u: ID!, $t: ID!) { addOrganizationUnitMemberAsManager(unitId:$u,userId:$t,role:Member) { role } }","variables":{"u":unit,"t":target}})).await;
    assert!(response["errors"].is_null(),"valid reader-to-member manager update: {response}");
    assert_eq!(response["data"]["addOrganizationUnitMemberAsManager"]["role"],"Member");
    assert_eq!(read_manager_feature(&pool,target).await,Some(true));
  }).catch_unwind().await;
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {failure_name} ON user_features"))
    .execute(&pool)
    .await
    .expect("cleanup owned trigger");
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {failure_name}()"))
    .execute(&pool)
    .await
    .expect("cleanup owned function");
  let mut cleanup = pool.begin().await.expect("begin owned fixture cleanup");
  sqlx::query("UPDATE organization_policy SET manager_can_manage_ou_members=$2 WHERE organization_id=$1")
    .bind(org)
    .bind(original_policy)
    .execute(&mut *cleanup)
    .await
    .expect("restore isolated test policy");
  sqlx::query("DELETE FROM admin_audit_log WHERE target_unit_id=$1 OR actor_user_id=ANY($2) OR target_id=ANY($3)")
    .bind(unit)
    .bind(&[manager, target][..])
    .bind(vec![manager.to_string(), target.to_string(), unit.to_string()])
    .execute(&mut *cleanup)
    .await
    .expect("delete owned audit");
  sqlx::query("DELETE FROM organization_unit WHERE id=$1")
    .bind(unit)
    .execute(&mut *cleanup)
    .await
    .expect("delete owned unit and members");
  sqlx::query("DELETE FROM users WHERE id=ANY($1)")
    .bind(&[manager, target][..])
    .execute(&mut *cleanup)
    .await
    .expect("delete owned accounts and credentials");
  cleanup.commit().await.expect("commit owned cleanup");
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}
