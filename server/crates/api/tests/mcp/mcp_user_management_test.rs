// SPDX-License-Identifier: AGPL-3.0-or-later
//! Privileged user lifecycle through the authenticated HTTP MCP boundary.

use crate::helpers;
use crate::helpers::mcp::{invoke, key, request};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use futures_util::FutureExt;
use myoxus_application::{api_key::ApiKeyService, auth::AuthStore};
use myoxus_infrastructure::api_key::SqlxApiKeyStore;
use serde_json::{Value, json};
use std::{
  panic::{AssertUnwindSafe, resume_unwind},
  sync::Arc,
};
use uuid::Uuid;

#[tokio::test]
async fn inv_user_http_lifecycle_preserves_authority_replay_and_committed_self_suspension() {
  let (app, pool, auth_store) = helpers::setup_app_with_mcp_and_audit().await;
  let (admin, session) = helpers::seed_admin(&pool, &auth_store).await;
  let marker = format!("mcp-users-{}", Uuid::new_v4());
  let email = format!("{marker}@example.test");
  let outcome = AssertUnwindSafe(async {
    let token = key(&app, session, &["read:users", "write:users"]).await;
    let reader = key(&app, session, &["read:users"]).await;
    let (_, discovery) = request(&app, &reader, "tools/list", json!({})).await;
    let tools = discovery["result"]["tools"].as_array().unwrap();
    assert!(tools.iter().any(|tool| tool["name"] == "user_get"));
    assert!(!tools.iter().any(|tool| tool["name"] == "user_create"));
    invoke(&app, &reader, "user_create", json!({"email":email,"idempotency_key":"denied"}), false).await;
    for arguments in [json!({"limit":101}), json!({"offset":-1}), json!({"password":"not-accepted"})] {
      invoke(&app, &token, "user_list", arguments, false).await;
    }
    invoke(&app, &token, "user_create", json!({"email":email}), false).await;
    assert!(auth_store.get_user_by_email(&email).await.unwrap().is_none());
    let creation = json!({"email":email,"name":"MCP account","idempotency_key":"create"});
    let created = invoke(&app, &token, "user_create", creation.clone(), true).await;
    let id = Uuid::parse_str(created["id"].as_str().unwrap()).unwrap();
    assert_eq!(created["has_password"], false);
    assert!(created.get("password_hash").is_none());
    let date: DateTime<Utc> = sqlx::query_scalar("SELECT created_at FROM users WHERE id=$1").bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(DateTime::parse_from_rfc3339(created["created_at"].as_str().unwrap()).unwrap().with_timezone(&Utc), date);
    let roots: i64 = sqlx::query_scalar("SELECT count(*) FROM workspaces w WHERE owner_user_id=$1 AND is_personal_workspace AND EXISTS(SELECT 1 FROM docs d WHERE d.workspace_id=w.id AND is_workspace_root) AND EXISTS(SELECT 1 FROM doc_updates u WHERE u.workspace_id=w.id AND octet_length(payload)>0)").bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(roots, 1);
    assert_eq!(invoke(&app, &token, "user_create", creation.clone(), true).await, created);
    invoke(&app, &token, "user_create", json!({"email":email,"name":"conflict","idempotency_key":"create"}), false).await;
    assert_eq!(invoke(&app, &token, "user_get", json!({"id_or_email":format!(" {} ",email.to_uppercase())}), true).await, created);
    sqlx::query("UPDATE users SET avatar_key='owned/avatar' WHERE id=$1").bind(id).execute(&pool).await.unwrap();
    let profile = invoke(&app, &token, "user_update", json!({"user_id":id,"name":"Changed","idempotency_key":"update"}), true).await;
    assert_eq!(profile["email"], email);
    assert_eq!(profile["name"], "Changed");
    assert_eq!(profile["avatar_url"], "owned/avatar");
    invoke(&app,&token,"user_update",json!({"user_id":id,"email":auth_store.get_user_by_id(admin).await.unwrap().unwrap().email,"name":"Must not change","idempotency_key":"duplicate-email"}),false).await;
    let unchanged=auth_store.get_user_by_id(id).await.unwrap().unwrap();
    assert_eq!(unchanged.email,email);
    assert_eq!(unchanged.name.as_deref(),Some("Changed"));

    assert!(profile.get("password_hash").is_none());
    let graph = helpers::gql(&app, session, json!({"query":format!("query{{admin{{userById(id:\"{id}\"){{id email name disabled hasPassword}}}}}}") })).await;
    assert!(graph.get("errors").is_none(), "Admin readback failed");
    assert_eq!(graph["data"]["admin"]["userById"]["name"], "Changed");

    let reset = json!({"user_id":id,"idempotency_key":"reset"});
    let link = invoke(&app, &token, "user_reset_link", reset.clone(), true).await;
    let url = reqwest::Url::parse(link["reset_link"].as_str().unwrap()).unwrap();
    let secret = url.query_pairs().find(|(key,_)|key=="token").unwrap().1.into_owned();
    let expiry: DateTime<Utc> = sqlx::query_scalar("SELECT expires_at FROM verification_tokens WHERE token_hash=$1").bind(&secret).fetch_one(&pool).await.unwrap();
    assert_eq!(DateTime::parse_from_rfc3339(link["expires_at"].as_str().unwrap()).unwrap().with_timezone(&Utc),expiry);
    assert!(invoke(&app, &token, "user_reset_link", reset.clone(), true).await == link, "reset replay changed its authorized result");
    let consumed = helpers::gql_anon(&app,json!({"query":"mutation($token:String!){changePassword(token:$token,newPassword:\"McpReset-2026!\")}","variables":{"token":secret}})).await;
    assert_eq!(consumed["data"]["changePassword"],true);
    assert!(invoke(&app, &token, "user_reset_link", reset.clone(), true).await == link, "reset replay changed its authorized result");
    sqlx::query("UPDATE verification_tokens SET expires_at=now()-interval '1 minute' WHERE token_hash=$1").bind(&secret).execute(&pool).await.unwrap();
    assert!(invoke(&app, &token, "user_reset_link", reset.clone(), true).await == link, "reset replay changed its authorized result");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM verification_tokens WHERE user_id=$1 AND kind='ChangePassword'").bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(count,1,"replay must never mint or refresh");
    let audit_count: i64 = sqlx::query_scalar("SELECT count(*) FROM admin_audit_log WHERE target_id=$1 AND event_key='user.reset-link-created'").bind(id.to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!(audit_count,1);
    let audits: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(a) FROM admin_audit_log a WHERE actor_user_id=$1 OR target_id=$2").bind(admin).bind(id.to_string()).fetch_all(&pool).await.unwrap();
    for audit in audits {let wire=audit.to_string();assert!(!wire.contains(&secret));assert!(!wire.contains(link["reset_link"].as_str().unwrap()));}

    // A previously authorized replay never restores a role revoked since issuance.
    sqlx::query("UPDATE users SET is_admin=false WHERE id=$1").bind(admin).execute(&pool).await.unwrap();
    invoke(&app,&token,"user_create",creation.clone(),false).await;
    sqlx::query("UPDATE users SET is_admin=true WHERE id=$1").bind(admin).execute(&pool).await.unwrap();
    let target_session = helpers::create_session(&auth_store,id).await;
    let keys = ApiKeyService::new(Arc::new(SqlxApiKeyStore::new(pool.clone())));
    let (_, target_token)= keys.generate(id,"mcp:target".into(),vec!["read:users".into()],None).await.unwrap();
    invoke(&app,&target_token,"user_get",json!({"id_or_email":id}),false).await;
    let forbidden = helpers::gql(&app,target_session,json!({"query":"mutation{apiKeys{createApiKey(name:\"forbidden\",scopes:[\"write:users\"]){id}}}"})).await;
    assert!(forbidden.get("errors").is_some());
    let suspended = invoke(&app,&token,"user_suspend",json!({"user_id":id,"idempotency_key":"suspend"}),true).await;
    assert_eq!(suspended["disabled"],true);
    assert!(auth_store.get_session(target_session).await.unwrap().unwrap().revoked_at.is_some());
    assert_eq!(request(&app,&target_token,"tools/list",json!({})).await.0,StatusCode::UNAUTHORIZED);
    let enabled = invoke(&app,&token,"user_enable",json!({"user_id":id,"idempotency_key":"enable"}),true).await;
    assert_eq!(enabled["disabled"],false);
    assert_eq!(request(&app,&target_token,"tools/list",json!({})).await.0,StatusCode::UNAUTHORIZED);
    let disabled_app = helpers::setup_app_with_pool_and_config_override(pool.clone(),|config|config.mcp.enabled=false).await.0;
    assert_eq!(request(&disabled_app,&token,"tools/list",json!({})).await.0,StatusCode::NOT_FOUND);
    let self_result=invoke(&app,&token,"user_suspend",json!({"user_id":admin,"idempotency_key":"self"}),true).await;
    assert_eq!(self_result["disabled"],true);
    assert_eq!(request(&app,&token,"tools/list",json!({})).await.0,StatusCode::UNAUTHORIZED);
    let remaining:i64=sqlx::query_scalar("SELECT count(*) FROM mcp_idempotency_keys WHERE user_id=$1").bind(admin).fetch_one(&pool).await.unwrap();
    assert_eq!(remaining,0,"self-suspension must not recreate a receipt");
  }).catch_unwind().await;
  cleanup(&pool, admin, &marker).await;
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_user_partial_creation_retains_uncertain_admission_without_repair() {
  let (app, pool, auth_store) = helpers::setup_app_with_mcp_and_audit().await;
  let (admin, session) = helpers::seed_admin(&pool, &auth_store).await;
  let marker = format!("mcp-partial-{}", Uuid::new_v4());
  let email = format!("{marker}@example.test");
  let trigger = format!("mcp_partial_{}", Uuid::new_v4().simple());
  let outcome = AssertUnwindSafe(async {
    // Fail precisely after account/workspace commit, before the usable root.
    sqlx::query(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM workspaces w JOIN users u ON u.id=w.owner_user_id WHERE w.id=NEW.workspace_id AND u.email='{email}') THEN RAISE EXCEPTION 'private-root-failure-sentinel'; END IF; RETURN NEW; END $$"))
      .execute(&pool).await.unwrap();
    sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE INSERT ON doc_updates FOR EACH ROW EXECUTE FUNCTION {trigger}()"))
      .execute(&pool).await.unwrap();
    let token = key(&app,session,&["read:users","write:users"]).await;
    let input = json!({"email":email,"name":"Partial","idempotency_key":"partial"});
    let failure = invoke(&app,&token,"user_create",input.clone(),false).await;
    let retained = auth_store.get_user_by_email(&email).await.unwrap().expect("durable partial account");
    assert!(failure.to_string().contains(&retained.id.to_string()));
    assert!(!failure.to_string().contains("private-root-failure-sentinel"));
    assert!(retained.password_hash.is_none());
    let retry = invoke(&app,&token,"user_create",input,false).await;
    assert_eq!(retry["code"], "RECOVERY_REQUIRED");
    assert_eq!(retry["retryable"], false);
    invoke(&app,&token,"user_create",json!({"email":email,"name":"Replacement","idempotency_key":"new-key"}),false).await;
    assert_eq!(auth_store.get_user_by_id(retained.id).await.unwrap().unwrap().name,retained.name);
    let pending:i64=sqlx::query_scalar("SELECT count(*) FROM mcp_idempotency_keys WHERE user_id=$1 AND tool_name='user_create'").bind(admin).fetch_one(&pool).await.unwrap();
    assert_eq!(pending,2,"uncertain and duplicate admissions stay fail-closed");
  }).catch_unwind().await;
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger} ON doc_updates"))
    .execute(&pool)
    .await
    .expect("remove failure trigger");
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {trigger}()"))
    .execute(&pool)
    .await
    .expect("remove failure function");
  cleanup(&pool, admin, &marker).await;
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}

async fn cleanup(pool: &sqlx::PgPool, admin: Uuid, marker: &str) {
  let mut ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE email LIKE $1")
    .bind(format!("{marker}%"))
    .fetch_all(pool)
    .await
    .expect("owned fixture identities");
  ids.push(admin);
  let mut tx = pool.begin().await.expect("cleanup transaction");
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=ANY($1) OR target_id=ANY($2)")
    .bind(&ids)
    .bind(ids.iter().map(ToString::to_string).collect::<Vec<_>>())
    .execute(&mut *tx)
    .await
    .expect("clean owned audits");
  sqlx::query("DELETE FROM workspaces WHERE owner_user_id=ANY($1)")
    .bind(&ids)
    .execute(&mut *tx)
    .await
    .expect("clean owned workspaces");
  sqlx::query("DELETE FROM users WHERE id=ANY($1)")
    .bind(&ids)
    .execute(&mut *tx)
    .await
    .expect("clean owned accounts");
  tx.commit().await.expect("commit cleanup");
}

#[tokio::test]
async fn inv_user_admin_role_self_demotion_retains_key_but_denies_calls_and_replay() {
  let (app, pool, auth) = helpers::setup_app_with_mcp_and_audit().await;
  let (admin, session) = helpers::seed_admin(&pool, &auth).await;
  let outcome = AssertUnwindSafe(async {
    let reader = key(&app, session, &["read:users"]).await;
    let writer = key(&app, session, &["read:users", "write:users"]).await;
    invoke(
      &app,
      &reader,
      "user_set_admin",
      json!({"user_id":admin,"is_admin":false,"idempotency_key":"denied"}),
      false,
    )
    .await;
    invoke(
      &app,
      &writer,
      "user_set_admin",
      json!({"user_id":admin,"is_admin":false}),
      false,
    )
    .await;
    assert!(auth.get_user_by_id(admin).await.unwrap().unwrap().is_admin);
    let args = json!({"user_id":admin,"is_admin":false,"idempotency_key":"self-demote"});
    let committed = invoke(&app, &writer, "user_set_admin", args.clone(), true).await;
    assert_eq!(committed["previous_is_admin"], true);
    assert_eq!(committed["is_admin"], false);
    assert_eq!(
      invoke(&app, &writer, "user_set_admin", args, false).await["code"],
      "PERMISSION_DENIED"
    );
    assert_eq!(
      invoke(&app, &writer, "user_get", json!({"id_or_email":admin}), false).await["code"],
      "PERMISSION_DENIED"
    );
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT count(*) FROM api_keys WHERE user_id=$1")
        .bind(admin)
        .fetch_one(&pool)
        .await
        .unwrap(),
      2
    );
    assert_eq!(
      sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM admin_audit_log WHERE target_id=$1 AND event_key='user.admin-role-set'"
      )
      .bind(admin.to_string())
      .fetch_one(&pool)
      .await
      .unwrap(),
      1
    );
    assert!(auth.get_session(session).await.unwrap().unwrap().revoked_at.is_none());
  })
  .catch_unwind()
  .await;
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=$1 OR target_id=$2")
    .bind(admin)
    .bind(admin.to_string())
    .execute(&pool)
    .await
    .unwrap();
  helpers::cleanup_users(&pool, &[admin]).await;
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_user_delete_validates_confirmation_before_writes_and_retains_historical_self_audit() {
  let (app, pool, auth) = helpers::setup_app_with_mcp_and_audit().await;
  let (admin, session) = helpers::seed_admin(&pool, &auth).await;
  let missing = Uuid::new_v4();
  let mut keys = Vec::<Uuid>::new();
  let outcome=AssertUnwindSafe(async {
    let reader=key(&app,session,&["read:users"]).await;
    let writer=key(&app,session,&["read:users","write:users"]).await;
    let args=json!({"user_id":admin,"confirmed_user_id":admin,"idempotency_key":"self-delete"});
    invoke(&app,&reader,"user_delete",args.clone(),false).await;
    for invalid in [json!({"user_id":admin,"idempotency_key":"missing-confirmation"}),json!({"user_id":admin,"confirmed_user_id":missing,"idempotency_key":"mismatch"}),json!({"user_id":admin,"confirmed_user_id":admin})] {
      invoke(&app,&writer,"user_delete",invalid,false).await;
    }
    assert!(auth.get_user_by_id(admin).await.unwrap().is_some());
    assert!(auth.get_session(session).await.unwrap().is_some());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM mcp_idempotency_keys WHERE user_id=$1").bind(admin).fetch_one(&pool).await.unwrap(),0,"denied/unconfirmed calls write no receipt");
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM admin_audit_log WHERE event_key='user.delete' AND target_id=$1").bind(admin.to_string()).fetch_one(&pool).await.unwrap(),0,"no successful domain event before deletion");
    invoke(&app,&writer,"user_delete",json!({"user_id":missing,"confirmed_user_id":missing,"idempotency_key":"unknown"}),false).await;
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM admin_audit_log WHERE event_key='user.delete' AND target_id=$1").bind(missing.to_string()).fetch_one(&pool).await.unwrap(),0);
    keys=sqlx::query_scalar("SELECT id FROM api_keys WHERE user_id=$1").bind(admin).fetch_all(&pool).await.unwrap();
    assert_eq!(keys.len(),2);
    let result=invoke(&app,&writer,"user_delete",args.clone(),true).await;
    assert_eq!(result,json!({"user_id":admin,"deleted":true}),"self-delete reports its committed result despite key/receipt cascades");
    assert_eq!(request(&app,&writer,"tools/call",json!({"name":"user_delete","arguments":args})).await.0,StatusCode::UNAUTHORIZED);
    assert_eq!(request(&app,&reader,"tools/list",json!({})).await.0,StatusCode::UNAUTHORIZED);
    assert!(auth.get_user_by_id(admin).await.unwrap().is_none());
    assert!(auth.get_session(session).await.unwrap().is_none());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM api_keys WHERE id=ANY($1)").bind(&keys).fetch_one(&pool).await.unwrap(),0);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM mcp_idempotency_keys WHERE user_id=$1").bind(admin).fetch_one(&pool).await.unwrap(),0,"self-deletion never recreates its receipt");
    let audit:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(a) FROM admin_audit_log a WHERE target_id=$1 AND event_key IN ('user.delete','mcp.user.delete') AND metadata->>'outcome' IS DISTINCT FROM 'failure'").bind(admin.to_string()).fetch_all(&pool).await.unwrap();
    let domain:Vec<_>=audit.iter().filter(|a|a["event_key"]=="user.delete").collect();
    let transport:Vec<_>=audit.iter().filter(|a|a["event_key"]=="mcp.user.delete" && a["metadata"]["outcome"]=="success").collect();
    assert_eq!(domain.len(),1,"exactly one domain deletion event");assert_eq!(transport.len(),1,"exactly one transport success event");
    for a in [domain[0],transport[0]] {
      assert_eq!(a["actor_user_id"],json!(admin));assert_eq!(a["metadata"]["actor_user_id"],json!(admin));
      assert_eq!(a["actor_kind"],"api_key");assert_eq!(a["credential_type"],"mcp_api_key");assert!(a["credential_id"].is_string());
      assert!(!a.to_string().contains(&writer));assert!(!a.to_string().contains(&reader));
    }
  }).catch_unwind().await;
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=$1 OR target_id=ANY($2)")
    .bind(admin)
    .bind(
      keys
        .iter()
        .chain([&admin, &missing])
        .map(ToString::to_string)
        .collect::<Vec<_>>(),
    )
    .execute(&pool)
    .await
    .unwrap();
  helpers::cleanup_users(&pool, &[admin]).await;
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}
