// SPDX-License-Identifier: AGPL-3.0-or-later
//! Persisted HTTP membership ingress: shared atomic effects, replay and authority.
use crate::{
  helpers,
  helpers::mcp::{invoke, key, request},
};
use futures_util::FutureExt;
use serde_json::json;
use std::panic::{AssertUnwindSafe, resume_unwind};
use uuid::Uuid;

#[tokio::test]
async fn inv_mcp_memberships_share_atomic_capability_audit_and_preconditions() {
  let (app, pool, auth) = helpers::setup_app_with_mcp_and_audit().await;
  let (admin, session) = helpers::seed_admin(&pool, &auth).await;
  let (target, _) = helpers::seed_user(&pool, &auth, "mcp_membership_target").await;
  let org = helpers::default_organization_id(&pool).await;
  let kind = helpers::preset_unit_type_id(&pool, "team").await;
  let first = helpers::create_organization_unit(&pool, org, kind, None, "MCP first manager scope").await;
  let second = helpers::create_organization_unit(&pool, org, kind, None, "MCP second manager scope").await;
  let fault = format!("ua10_{}", Uuid::new_v4().simple());
  let outcome = AssertUnwindSafe(async {
    let token = key(&app, session, &["read:organization", "write:organization"]).await;
    let reader = key(&app, session, &["read:organization"]).await;
    let add = json!({"unit_id":first,"user_id":target,"role":"manager","idempotency_key":"first"});
    invoke(&app, &reader, "organization_unit_member_add", add.clone(), false).await;
    for args in [json!({"unit_id":first,"user_id":target,"role":"manager"}), json!({"unit_id":first,"user_id":target,"role":"owner","idempotency_key":"bad-role"}), json!({"unit_id":first,"user_id":target,"role":"member","metadata":{},"idempotency_key":"extra"})] {
      invoke(&app, &token, "organization_unit_member_add", args, false).await;
    }
    sqlx::query(&format!("CREATE FUNCTION {fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id = '{target}'::uuid THEN RAISE EXCEPTION 'owned capability failure'; END IF; RETURN NEW; END $$")).execute(&pool).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER {fault} BEFORE INSERT OR UPDATE ON user_features FOR EACH ROW EXECUTE FUNCTION {fault}()")).execute(&pool).await.unwrap();
    invoke(&app, &token, "organization_unit_member_add", json!({"unit_id":first,"user_id":target,"role":"manager","idempotency_key":"rollback"}), false).await;
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM organization_unit_member WHERE user_id=$1").bind(target).fetch_one(&pool).await.unwrap(),0);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM user_features WHERE user_id=$1 AND feature_name='manager'").bind(target).fetch_one(&pool).await.unwrap(),0);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM admin_audit_log WHERE target_unit_id=$1 AND event_key='organization.member.assign'").bind(first).fetch_one(&pool).await.unwrap(),0);
    sqlx::query(&format!("DROP TRIGGER {fault} ON user_features")).execute(&pool).await.unwrap();
    sqlx::query(&format!("DROP FUNCTION {fault}()")).execute(&pool).await.unwrap();
    let features = helpers::gql(&app, session,json!({"query":"query($id:String!){admin{userById(id:$id){features}}}","variables":{"id":target}})).await;
    assert!(!features["data"]["admin"]["userById"]["features"].as_array().unwrap().contains(&json!("Manager")));
    let saved = invoke(&app, &token,"organization_unit_member_add",add.clone(),true).await;
    assert_eq!(saved["manager_capability"],true);
    assert_eq!(invoke(&app,&token,"organization_unit_member_add",add.clone(),true).await,saved);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM admin_audit_log WHERE target_unit_id=$1 AND event_key='organization.member.assign'").bind(first).fetch_one(&pool).await.unwrap(),1,"replay emits no duplicate domain event");
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM admin_audit_log WHERE target_unit_id=$1 AND event_key='user.feature.manager.implicit_set'").bind(first).fetch_one(&pool).await.unwrap(),1,"replay emits no duplicate capability event");
    assert_eq!(invoke(&app,&token,"organization_unit_member_add",json!({"unit_id":first,"user_id":target,"role":"reader","idempotency_key":"duplicate"}),false).await["code"],"CONFLICT");
    let granted = helpers::gql(&app,session,json!({"query":"query($id:String!){admin{userById(id:$id){features}}}","variables":{"id":target}})).await;
    assert!(granted["data"]["admin"]["userById"]["features"].as_array().unwrap().contains(&json!("Manager")));
    invoke(&app,&token,"organization_unit_member_add",json!({"unit_id":second,"user_id":target,"role":"manager","idempotency_key":"second"}),true).await;
    let removed=invoke(&app,&token,"organization_unit_member_remove",json!({"unit_id":first,"user_id":target,"idempotency_key":"remove-first"}),true).await;
    assert_eq!(removed["manager_capability_changed"],false);
    let downgraded=invoke(&app,&token,"organization_unit_member_set_role",json!({"unit_id":second,"user_id":target,"role":"member","idempotency_key":"downgrade"}),true).await;
    assert_eq!(downgraded["previous_role"],"manager");assert_eq!(downgraded["manager_capability"],false);
    let revoked = helpers::gql(&app,session,json!({"query":"query($id:String!){admin{userById(id:$id){features}}}","variables":{"id":target}})).await;
    assert!(!revoked["data"]["admin"]["userById"]["features"].as_array().unwrap().contains(&json!("Manager")));
    let roster=invoke(&app,&token,"organization_unit_member_list",json!({"unit_id":second}),true).await;assert_eq!(roster["items"][0]["source"],"manual");assert_eq!(roster["items"][0]["role"],"member");
    invoke(&app,&token,"organization_unit_member_remove",json!({"unit_id":second,"user_id":target,"idempotency_key":"remove-second"}),true).await;
    invoke(&app,&token,"organization_unit_member_set_role",json!({"unit_id":second,"user_id":target,"role":"reader","idempotency_key":"missing-member"}),false).await;
    invoke(&app,&token,"organization_unit_member_add",json!({"unit_id":second,"user_id":Uuid::new_v4(),"role":"reader","idempotency_key":"missing-user"}),false).await;
    sqlx::query("UPDATE organization_unit SET max_members=1 WHERE id=$1").bind(second).execute(&pool).await.unwrap();
    invoke(&app,&token,"organization_unit_member_add",json!({"unit_id":second,"user_id":admin,"role":"reader","idempotency_key":"fill-limit"}),true).await;
    invoke(&app,&token,"organization_unit_member_add",json!({"unit_id":second,"user_id":target,"role":"reader","idempotency_key":"limit"}),false).await;
    sqlx::query("UPDATE organization_unit SET status='disabled' WHERE id=$1").bind(second).execute(&pool).await.unwrap();
    invoke(&app,&token,"organization_unit_member_set_role",json!({"unit_id":second,"user_id":admin,"role":"member","idempotency_key":"inactive"}),false).await;
    invoke(&app,&token,"organization_unit_member_remove",json!({"unit_id":second,"user_id":admin,"idempotency_key":"inactive-cleanup"}),true).await;
    sqlx::query("UPDATE users SET is_admin=false WHERE id=$1").bind(admin).execute(&pool).await.unwrap();
    let denied=invoke(&app,&token,"organization_unit_member_add",add,false).await;assert_eq!(denied["code"],"PERMISSION_DENIED","fresh authorization precedes replay");
    let (_, discovery)=request(&app,&reader,"tools/list",json!({})).await;assert!(discovery["result"]["tools"].as_array().unwrap().iter().all(|t|t["name"]!="organization_unit_member_add"));
  }).catch_unwind().await;
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {fault} ON user_features"))
    .execute(&pool)
    .await
    .expect("cleanup owned trigger");
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {fault}()"))
    .execute(&pool)
    .await
    .expect("cleanup owned function");
  let mut tx = pool.begin().await.unwrap();
  sqlx::query("DELETE FROM organization_unit_member WHERE unit_id=ANY($1)")
    .bind(&[first, second][..])
    .execute(&mut *tx)
    .await
    .unwrap();
  sqlx::query("DELETE FROM organization_unit WHERE id=ANY($1)")
    .bind(&[first, second][..])
    .execute(&mut *tx)
    .await
    .unwrap();
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=ANY($1) OR target_unit_id=ANY($2)")
    .bind(&[admin, target][..])
    .bind(&[first, second][..])
    .execute(&mut *tx)
    .await
    .unwrap();
  sqlx::query("DELETE FROM users WHERE id=ANY($1)")
    .bind(&[admin, target][..])
    .execute(&mut *tx)
    .await
    .unwrap();
  tx.commit().await.unwrap();
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}
