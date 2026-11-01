// SPDX-License-Identifier: AGPL-3.0-or-later
//! HTTP-level contract for the privileged organization-unit MCP lifecycle.
//!
//! This test deliberately enters through `/mcp/`: direct tool dispatch would
//! miss bearer authentication, registry filtering and JSON-RPC projection.

use axum::{
  body::Body,
  http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

use crate::helpers;

#[path = "../../../mcp/src/output_schema_test_support.rs"]
mod output_schema_test_support;

async fn mcp(app: &axum::Router, token: &str, id: i64, method: &str, params: Value) -> Value {
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/mcp")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from(
          json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string(),
        ))
        .expect("MCP request"),
    )
    .await
    .expect("MCP response");
  assert_eq!(response.status(), StatusCode::OK);
  let bytes = response.into_body().collect().await.expect("MCP body").to_bytes();
  serde_json::from_slice(&bytes).expect("MCP JSON response")
}

async fn call(app: &axum::Router, token: &str, id: i64, name: &str, arguments: Value) -> Value {
  let response = mcp(
    app,
    token,
    id,
    "tools/call",
    json!({ "name": name, "arguments": arguments }),
  )
  .await;
  assert!(response.get("error").is_none(), "{name} failed: {response}");
  assert_ne!(response["result"]["isError"], true, "{name} failed: {response}");
  let text = response["result"]["content"][0]["text"]
    .as_str()
    .expect("tool response text");
  let value: Value = serde_json::from_str(text).expect("tool response JSON");
  assert_eq!(response["result"]["structuredContent"], value, "{name}: projections");
  if matches!(
    name,
    "organization_get"
      | "organization_unit_type_list"
      | "organization_unit_member_list"
      | "user_organization_memberships"
      | "organization_unit_list"
      | "organization_unit_get"
      | "organization_unit_delete_preview"
      | "organization_unit_create"
      | "organization_unit_update"
      | "organization_unit_move"
      | "organization_unit_set_status"
      | "organization_unit_delete_permanent"
  ) {
    let schema = &myoxus_mcp::tool_registry::find_tool(name)
      .expect("OU descriptor")
      .output_schema;
    assert!(
      output_schema_test_support::projection_schema_accepts(schema, schema, &value),
      "{name}: {value}"
    );
    for field in schema["required"].as_array().expect("required OU fields") {
      let field = field.as_str().unwrap();
      let mut invalid = value.clone();
      invalid.as_object_mut().unwrap().remove(field);
      assert!(
        !output_schema_test_support::projection_schema_accepts(schema, schema, &invalid),
        "missing {name}.{field}"
      );
      // A serde_json::Value slot accepts every JSON value, but is still required.
      if field == "metadata" {
        continue;
      }
      invalid = value.clone();
      invalid[field] = json!({});
      assert!(
        !output_schema_test_support::projection_schema_accepts(schema, schema, &invalid),
        "malformed {name}.{field}"
      );
    }
  }
  value
}

async fn call_failure(app: &axum::Router, token: &str, id: i64, name: &str, arguments: Value) -> Value {
  let response = mcp(
    app,
    token,
    id,
    "tools/call",
    json!({ "name": name, "arguments": arguments }),
  )
  .await;
  assert!(
    response.get("error").is_none(),
    "{name} returned a protocol error: {response}"
  );
  assert_eq!(
    response["result"]["isError"], true,
    "{name} unexpectedly succeeded: {response}"
  );
  response["result"]["structuredContent"].clone()
}

#[tokio::test]
async fn inv_mcp_organization_unit_http_lifecycle_is_scoped_blocker_safe_and_retryable() {
  let (app, pool, auth_store) = helpers::setup_app_with_config_override(|config| config.mcp.enabled = true).await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
  let parent_id = Uuid::new_v4();
  let child_id = Uuid::new_v4();
  let denied_unit_id = Uuid::new_v4();
  let journey = async {
    let unit_type_id: Uuid = sqlx::query_scalar(
      "SELECT id FROM organization_unit_type
       WHERE is_active AND can_be_root_level AND can_have_children
       ORDER BY key LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .expect("active structural OU type");

    let key_response = helpers::gql(
      &app,
      session_id,
      json!({
        "query": "mutation($name:String!,$scopes:[String!]!){apiKeys{createApiKey(name:$name,scopes:$scopes){key}}}",
        "variables": {
          "name": "mcp:organization-lifecycle-e2e",
          "scopes": ["read:organization", "write:organization"]
        }
      }),
    )
    .await;
    assert!(
      key_response.get("errors").is_none(),
      "API-key creation failed: {key_response}"
    );
    let token = key_response["data"]["apiKeys"]["createApiKey"]["key"]
      .as_str()
      .expect("one-time MCP key");

    let initialized = mcp(
      &app,
      token,
      1,
      "initialize",
      json!({ "protocolVersion": "2024-11-05", "clientInfo": { "name": "organization-e2e", "version": "1" } }),
    )
    .await;
    assert_eq!(initialized["result"]["serverInfo"]["name"], "myoxus");

    let listed = mcp(&app, token, 2, "tools/list", json!({})).await;
    let tool_names = listed["result"]["tools"]
      .as_array()
      .expect("tools list")
      .iter()
      .filter_map(|tool| tool["name"].as_str())
      .collect::<Vec<_>>();
    for expected in [
      "organization_get",
      "organization_unit_type_list",
      "organization_unit_member_list",
      "user_organization_memberships",
      "organization_unit_list",
      "organization_unit_get",
      "organization_unit_delete_preview",
      "organization_unit_create",
      "organization_unit_update",
      "organization_unit_move",
      "organization_unit_set_status",
      "organization_unit_delete_permanent",
    ] {
      assert!(tool_names.contains(&expected), "missing organization tool {expected}");
    }

    let org = call(&app, token, 100, "organization_get", json!({})).await;
    assert_eq!(org["key"], "myoxus");
    let types = call(&app, token, 101, "organization_unit_type_list", json!({"limit":100})).await;
    let discovered_type = types["items"]
      .as_array()
      .expect("type page")
      .iter()
      .find(|ty| ty["id"] == unit_type_id.to_string())
      .expect("persisted type discovered through MCP");
    assert_eq!(discovered_type["is_active"], true);
    assert_eq!(discovered_type["can_be_root_level"], true);
    assert_eq!(discovered_type["organization_id"], org["id"]);

    call(&app, token, 104, "organization_unit_list", json!({"status":"archived"})).await;
    let parent_name = format!("MCP Organization {parent_id}");
    let created_parent = call(
      &app,
      token,
      3,
      "organization_unit_create",
      json!({
        "unit_id": parent_id,
        "unit_type_id": unit_type_id,
        "name": parent_name,
        "slug": format!("mcp-org-{parent_id}"),
        "idempotency_key": format!("create-{parent_id}")
      }),
    )
    .await;
    let replay = call(
      &app,
      token,
      4,
      "organization_unit_create",
      json!({
        "unit_id": parent_id,
        "unit_type_id": unit_type_id,
        "name": parent_name,
        "slug": format!("mcp-org-{parent_id}"),
        "idempotency_key": format!("create-{parent_id}")
      }),
    )
    .await;
    assert_eq!(
      replay, created_parent,
      "idempotent replay must return the original unit"
    );

    call(
      &app,
      token,
      5,
      "organization_unit_create",
      json!({
        "unit_id": child_id,
        "unit_type_id": unit_type_id,
        "parent_unit_id": parent_id,
        "name": format!("MCP Child {child_id}"),
        "slug": format!("mcp-child-{child_id}"),
        "idempotency_key": format!("create-{child_id}")
      }),
    )
    .await;
    let fetched = call(&app, token, 6, "organization_unit_get", json!({ "unit_id": child_id })).await;
    assert_eq!(fetched["parentUnitId"], parent_id.to_string());
    let inventory = call(&app, token, 105, "organization_unit_list", json!({"status":"all"})).await;
    assert!(
      inventory["units"]
        .as_array()
        .unwrap()
        .iter()
        .any(|unit| unit["id"] == child_id.to_string())
    );
    sqlx::query("UPDATE organization_unit SET metadata='null'::jsonb WHERE id=$1")
      .bind(child_id)
      .execute(&pool)
      .await
      .expect("retained JSON-null metadata fixture");
    assert!(call(&app, token, 106, "organization_unit_get", json!({"unit_id":child_id})).await["metadata"].is_null());
    sqlx::query("UPDATE organization_unit SET metadata='{}'::jsonb WHERE id=$1")
      .bind(child_id)
      .execute(&pool)
      .await
      .expect("restore fixture metadata");

    sqlx::query("INSERT INTO organization_unit_member(unit_id,user_id,role,source) VALUES($1,$2,'member','manual')")
      .bind(child_id)
      .bind(admin_id)
      .execute(&pool)
      .await
      .expect("known persisted member");
    let members = call(
      &app,
      token,
      102,
      "organization_unit_member_list",
      json!({"unit_id":child_id}),
    )
    .await;
    assert_eq!(members["items"][0]["user_id"], admin_id.to_string());
    assert_eq!(members["items"][0]["role"], "member");
    assert!(members["items"][0]["email"].is_string());
    assert!(members["items"][0].get("password_hash").is_none());
    let assignments = call(
      &app,
      token,
      103,
      "user_organization_memberships",
      json!({"user_id":admin_id}),
    )
    .await;
    assert!(
      assignments["items"]
        .as_array()
        .expect("assignment page")
        .iter()
        .any(|a| a["unit_id"] == child_id.to_string() && a["role"] == "member")
    );
    let graph = helpers::gql(&app,session_id,json!({"query":"query($id:ID!){admin{organizationUnitMembers(unitId:$id){userId role userEmail}}}","variables":{"id":child_id}})).await;
    assert!(graph.get("errors").is_none(), "Admin member readback: {graph}");
    assert_eq!(
      graph["data"]["admin"]["organizationUnitMembers"][0]["userEmail"],
      members["items"][0]["email"]
    );
    sqlx::query("DELETE FROM organization_unit_member WHERE unit_id=$1 AND user_id=$2")
      .bind(child_id)
      .bind(admin_id)
      .execute(&pool)
      .await
      .expect("remove disposable member before lifecycle delete");

    let updated_name = format!("Updated MCP Child {child_id}");
    let updated = call(
      &app,
      token,
      7,
      "organization_unit_update",
      json!({ "unit_id": child_id, "name": updated_name, "idempotency_key": format!("update-{child_id}") }),
    )
    .await;
    assert_eq!(updated["name"], updated_name);
    let moved = call(
      &app,
      token,
      8,
      "organization_unit_move",
      json!({ "unit_id": child_id, "parent_unit_id": null, "idempotency_key": format!("move-{child_id}") }),
    )
    .await;
    assert!(moved["parentUnitId"].is_null());

    call(
      &app,
      token,
      9,
      "organization_unit_move",
      json!({ "unit_id": child_id, "parent_unit_id": parent_id, "idempotency_key": format!("move-back-{child_id}") }),
    )
    .await;
    let blocked = call(
      &app,
      token,
      10,
      "organization_unit_delete_preview",
      json!({ "unit_id": parent_id }),
    )
    .await;
    assert_eq!(blocked["deletable"], false);
    assert!(
      blocked["blockers"]
        .as_array()
        .expect("blockers")
        .iter()
        .any(|blocker| blocker["code"] == "CHILD_UNITS"),
      "parent preview must expose the child blocker: {blocked}"
    );

    let disabled_child = call(
      &app,
      token,
      11,
      "organization_unit_set_status",
      json!({ "unit_id": child_id, "status": "disabled", "idempotency_key": format!("disable-{child_id}") }),
    )
    .await;
    assert_eq!(disabled_child["status"], "disabled");
    let child_preview = call(
      &app,
      token,
      12,
      "organization_unit_delete_preview",
      json!({ "unit_id": child_id }),
    )
    .await;
    assert_eq!(child_preview["deletable"], true);
    call(
      &app,
      token,
      13,
      "organization_unit_delete_permanent",
      json!({
        "unit_id": child_id,
        "confirmed_name": updated_name,
        "preview_revision": child_preview["updatedAt"],
        "idempotency_key": format!("delete-{child_id}")
      }),
    )
    .await;

    call(
      &app,
      token,
      14,
      "organization_unit_set_status",
      json!({ "unit_id": parent_id, "status": "archived", "idempotency_key": format!("archive-{parent_id}") }),
    )
    .await;
    let parent_preview = call(
      &app,
      token,
      15,
      "organization_unit_delete_preview",
      json!({ "unit_id": parent_id }),
    )
    .await;
    assert_eq!(parent_preview["deletable"], true);
    let deleted = call(
      &app,
      token,
      16,
      "organization_unit_delete_permanent",
      json!({
        "unit_id": parent_id,
        "confirmed_name": parent_name,
        "preview_revision": parent_preview["updatedAt"],
        "idempotency_key": format!("delete-{parent_id}")
      }),
    )
    .await;
    assert_eq!(deleted["deleted"], true);

    let missing = mcp(
      &app,
      token,
      17,
      "tools/call",
      json!({ "name": "organization_unit_get", "arguments": { "unit_id": parent_id } }),
    )
    .await;
    assert_eq!(missing["result"]["isError"], true);
    assert_eq!(missing["result"]["structuredContent"]["code"], "NOT_FOUND");

    let read_only_key = helpers::gql(
      &app,
      session_id,
      json!({
        "query": "mutation($name:String!,$scopes:[String!]!){apiKeys{createApiKey(name:$name,scopes:$scopes){key}}}",
        "variables": {
          "name": "mcp:organization-read-only-e2e",
          "scopes": ["read:organization"]
        }
      }),
    )
    .await;
    let read_only_token = read_only_key["data"]["apiKeys"]["createApiKey"]["key"]
      .as_str()
      .expect("one-time read-only MCP key");
    let scope_denied = call_failure(
      &app,
      read_only_token,
      18,
      "organization_unit_create",
      json!({
        "unit_id": denied_unit_id,
        "unit_type_id": unit_type_id,
        "name": "must not be created",
        "slug": format!("scope-denied-{denied_unit_id}"),
        "idempotency_key": format!("scope-denied-{denied_unit_id}")
      }),
    )
    .await;
    assert_eq!(scope_denied["code"], "SCOPE_DENIED");
    let denied_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organization_unit WHERE id = $1)")
      .bind(denied_unit_id)
      .fetch_one(&pool)
      .await
      .expect("scope-denied OU existence");
    assert!(!denied_exists, "scope denial must happen before the mutation");

    sqlx::query("UPDATE users SET is_admin = FALSE WHERE id = $1")
      .bind(admin_id)
      .execute(&pool)
      .await
      .expect("revoke global admin role");
    let admin_denied = call_failure(&app, token, 19, "organization_unit_list", json!({ "status": "active" })).await;
    assert_eq!(admin_denied["code"], "PERMISSION_DENIED");
  };
  use futures_util::FutureExt;
  let result = std::panic::AssertUnwindSafe(journey).catch_unwind().await;
  let mut tx = pool.begin().await.expect("lifecycle cleanup transaction");
  let owned_units = vec![child_id, parent_id, denied_unit_id];
  sqlx::query("DELETE FROM organization_unit_member WHERE unit_id=ANY($1)")
    .bind(&owned_units)
    .execute(&mut *tx)
    .await
    .expect("cleanup lifecycle memberships");
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=$1 OR target_id=ANY($2)")
    .bind(admin_id)
    .bind(owned_units.iter().map(ToString::to_string).collect::<Vec<_>>())
    .execute(&mut *tx)
    .await
    .expect("cleanup lifecycle audit");
  sqlx::query("DELETE FROM organization_unit WHERE id=ANY($1)")
    .bind(&owned_units)
    .execute(&mut *tx)
    .await
    .expect("cleanup lifecycle units");
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(admin_id)
    .execute(&mut *tx)
    .await
    .expect("cleanup lifecycle credentials and user");
  tx.commit().await.expect("commit lifecycle cleanup");
  if let Err(panic) = result {
    std::panic::resume_unwind(panic);
  }
}

#[tokio::test]
async fn inv_mcp_organization_discovery_pages_safe_profiles_and_inactive_assignments() {
  use futures_util::FutureExt;
  use std::panic::{AssertUnwindSafe, resume_unwind};
  let (app, pool, auth) = helpers::setup_app_with_mcp_and_audit().await;
  let (admin, session) = helpers::seed_admin(&pool, &auth).await;
  let org = helpers::default_organization_id(&pool).await;
  let ty: Uuid = sqlx::query_scalar("SELECT id FROM organization_unit_type WHERE organization_id=$1 AND is_active AND can_be_root_level ORDER BY key LIMIT 1")
    .bind(org).fetch_one(&pool).await.expect("active root-capable fixture type");
  let users = (0..125).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
  let units = (0..125).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
  let type_ids = (0..125).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
  let journey = async {
    let mut tx = pool.begin().await.expect("fixture transaction");
    for (index, user) in users.iter().enumerate() {
      sqlx::query("INSERT INTO users(id,email,name,status,avatar_key) VALUES($1,$2,'Paged organization profile','active','owned/page-avatar')")
        .bind(user).bind(format!("org-page-{user}@example.test")).execute(&mut *tx).await.expect("page user");
      sqlx::query("INSERT INTO organization_unit_type(id,organization_id,key,label,is_active,is_structural,can_have_children,can_be_root_level,can_be_manager_created,can_have_cross_unit_members,can_own_workspaces,can_manage_workspaces) SELECT $1,organization_id,$2,'Paged type',$3,is_structural,can_have_children,can_be_root_level,can_be_manager_created,can_have_cross_unit_members,can_own_workspaces,can_manage_workspaces FROM organization_unit_type WHERE id=$4")
        .bind(type_ids[index]).bind(format!("org-page-type-{:03}-{}",index,type_ids[index])).bind(index<100).bind(ty).execute(&mut *tx).await.expect("paged type");
      sqlx::query("INSERT INTO organization_unit(id,organization_id,unit_type_id,name,slug,status,max_members) VALUES($1,$2,$3,$4,$5,$6::organization_unit_status,150)")
        .bind(units[index]).bind(org).bind(ty).bind(format!("Paged {index:03} {}",units[index]))
        .bind(format!("org-page-{}",units[index])).bind(if index<100{"active"}else{"archived"})
        .execute(&mut *tx).await.expect("page unit");
    }
    for user in &users {
      sqlx::query("INSERT INTO organization_unit_member(unit_id,user_id,role,source,created_at) VALUES($1,$2,'member','manual','2026-01-01T00:00:00Z')")
        .bind(units[0]).bind(user).execute(&mut *tx).await.expect("tied member");
    }
    for unit in units.iter().skip(1) {
      sqlx::query("INSERT INTO organization_unit_member(unit_id,user_id,role,source) VALUES($1,$2,'reader','manual')")
        .bind(unit)
        .bind(users[0])
        .execute(&mut *tx)
        .await
        .expect("indexed user assignment");
    }
    tx.commit().await.expect("commit fixtures");
    let key=helpers::gql(&app,session,json!({"query":"mutation{apiKeys{createApiKey(name:\"mcp:org-discovery\",scopes:[\"read:organization\"]){key}}}"})).await;
    assert!(key.get("errors").is_none(), "organization key failed");
    let token = key["data"]["apiKeys"]["createApiKey"]["key"].as_str().expect("key");
    for include_inactive in [false, true] {
      let mut offset = 0;
      let mut own = Vec::new();
      loop {
        let page = call(
          &app,
          token,
          100,
          "organization_unit_type_list",
          json!({"offset":offset,"limit":100,"include_inactive":include_inactive}),
        )
        .await;
        for item in page["items"].as_array().expect("type page") {
          let id = item["id"].as_str().unwrap().parse::<Uuid>().unwrap();
          if type_ids.contains(&id) {
            own.push(id);
            assert_eq!(item["organization_id"], org.to_string());
          }
        }
        match page["next_offset"].as_i64() {
          Some(next) => {
            assert!(next > offset);
            offset = next;
          }
          None => break,
        }
      }
      assert_eq!(
        own,
        if include_inactive {
          type_ids.clone()
        } else {
          type_ids[..100].to_vec()
        },
        "type discovery must exhaust deterministic active/diagnostic pages"
      );
    }
    let first = call(
      &app,
      token,
      1,
      "organization_unit_member_list",
      json!({"unit_id":units[0],"limit":100}),
    )
    .await;
    let second = call(
      &app,
      token,
      2,
      "organization_unit_member_list",
      json!({"unit_id":units[0],"offset":first["next_offset"],"limit":100}),
    )
    .await;
    assert_eq!(first["items"].as_array().unwrap().len(), 100);
    assert_eq!(second["items"].as_array().unwrap().len(), 25);
    assert!(second["next_offset"].is_null());
    let actual = first["items"]
      .as_array()
      .unwrap()
      .iter()
      .chain(second["items"].as_array().unwrap())
      .map(|m| m["user_id"].as_str().unwrap().parse::<Uuid>().unwrap())
      .collect::<Vec<_>>();
    let mut expected = users.clone();
    expected.sort();
    assert_eq!(
      actual, expected,
      "tied members must paginate deterministically without loss"
    );
    for member in first["items"].as_array().unwrap() {
      assert_eq!(member["name"], "Paged organization profile");
      assert_eq!(member["avatar_url"], "owned/page-avatar");
      assert!(member.get("password_hash").is_none());
      assert!(member.get("is_admin").is_none());
    }
    let default = call(
      &app,
      token,
      3,
      "organization_unit_member_list",
      json!({"unit_id":units[0]}),
    )
    .await;
    assert_eq!(default["items"].as_array().unwrap().len(), 20);
    assert_eq!(default["next_offset"], 20);
    let active = call(
      &app,
      token,
      4,
      "user_organization_memberships",
      json!({"user_id":users[0],"limit":100}),
    )
    .await;
    assert_eq!(active["items"].as_array().unwrap().len(), 100);
    assert!(active["next_offset"].is_null());
    let diagnostic = call(
      &app,
      token,
      5,
      "user_organization_memberships",
      json!({"user_id":users[0],"include_inactive":true,"offset":100,"limit":100}),
    )
    .await;
    assert_eq!(diagnostic["items"].as_array().unwrap().len(), 25);
    assert!(diagnostic["next_offset"].is_null());
    assert!(
      diagnostic["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|m| m["unit_status"] == "archived" && m.get("email").is_none())
    );
    let graph=helpers::gql(&app,session,json!({"query":"query($user:ID!,$unit:ID!){admin{userOrganizationMemberships(userId:$user){unitId unitName role source joinedAt} organizationUnitMembers(unitId:$unit){userId userName userAvatarUrl}}}","variables":{"user":users[0],"unit":units[0]}})).await;
    assert!(graph.get("errors").is_none(), "shared Admin read: {graph}");
    assert_eq!(
      graph["data"]["admin"]["userOrganizationMemberships"]
        .as_array()
        .unwrap()
        .len(),
      125,
      "legacy Admin diagnostics remain complete"
    );
    assert_eq!(
      graph["data"]["admin"]["organizationUnitMembers"]
        .as_array()
        .unwrap()
        .len(),
      125,
      "legacy Admin roster remains complete"
    );
    let inactive = call_failure(
      &app,
      token,
      6,
      "organization_unit_member_list",
      json!({"unit_id":units[124]}),
    )
    .await;
    assert!(inactive["code"].is_string());
    let retained = call(
      &app,
      token,
      7,
      "organization_unit_member_list",
      json!({"unit_id":units[124],"include_inactive":true}),
    )
    .await;
    assert_eq!(retained["items"][0]["user_id"], users[0].to_string());
    for args in [
      json!({"unit_id":units[0],"limit":101}),
      json!({"unit_id":units[0],"offset":-1}),
      json!({"unit_id":units[0],"include_inactive":"yes"}),
      json!({"unit_id":units[0],"password":"forbidden"}),
    ] {
      call_failure(&app, token, 8, "organization_unit_member_list", args).await;
    }
    let forbidden = call_failure(&app, token, 9, "user_get", json!({"id_or_email":admin})).await;
    assert_eq!(
      forbidden["code"], "SCOPE_DENIED",
      "organization scope grants no full user discovery"
    );
    sqlx::query("UPDATE users SET is_admin=false WHERE id=$1")
      .bind(admin)
      .execute(&pool)
      .await
      .expect("fresh role revocation");
    let revoked = call_failure(
      &app,
      token,
      10,
      "user_organization_memberships",
      json!({"user_id":users[0]}),
    )
    .await;
    assert_eq!(revoked["code"], "PERMISSION_DENIED");
  };
  let result = AssertUnwindSafe(journey).catch_unwind().await;
  let mut tx = pool.begin().await.expect("cleanup transaction");
  sqlx::query("DELETE FROM organization_unit_member WHERE unit_id=ANY($1)")
    .bind(&units)
    .execute(&mut *tx)
    .await
    .expect("cleanup memberships");
  sqlx::query("DELETE FROM organization_unit WHERE id=ANY($1)")
    .bind(&units)
    .execute(&mut *tx)
    .await
    .expect("cleanup units");
  sqlx::query("DELETE FROM organization_unit_type WHERE id=ANY($1)")
    .bind(&type_ids)
    .execute(&mut *tx)
    .await
    .expect("cleanup types");
  let mut all_users = users;
  all_users.push(admin);
  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=ANY($1)")
    .bind(&all_users)
    .execute(&mut *tx)
    .await
    .expect("cleanup audit");
  sqlx::query("DELETE FROM users WHERE id=ANY($1)")
    .bind(&all_users)
    .execute(&mut *tx)
    .await
    .expect("cleanup credentials/users");
  tx.commit().await.expect("cleanup commit");
  if let Err(panic) = result {
    resume_unwind(panic);
  }
}
