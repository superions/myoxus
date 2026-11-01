// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bearer-authenticated HTTP contract for the MCP calendar tool family.
//!
//! The journey deliberately crosses API-key issuance, discovery, scope and
//! workspace authorization, JSON-RPC projection, application services,
//! PostgreSQL persistence and transport idempotency. Cheaper direct-dispatch
//! tests cannot prove that complete boundary.

use axum::{
  body::Body,
  http::{Request, StatusCode},
};
use chrono::{Duration, TimeZone, Utc};
use futures_util::FutureExt;
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
  let schema = &myoxus_mcp::tool_registry::find_tool(name)
    .expect("Calendar descriptor")
    .output_schema;
  assert!(
    output_schema_test_support::projection_schema_accepts(schema, schema, &value),
    "{name}: {value}"
  );
  for field in schema["required"].as_array().expect("required Calendar fields") {
    let field = field.as_str().unwrap();
    let mut invalid = value.clone();
    invalid.as_object_mut().unwrap().remove(field);
    assert!(
      !output_schema_test_support::projection_schema_accepts(schema, schema, &invalid),
      "missing {name}.{field}"
    );
    // Boolean members accept both truth values; use an object as their wrong type.
    invalid = value.clone();
    invalid[field] = json!({});
    assert!(
      !output_schema_test_support::projection_schema_accepts(schema, schema, &invalid),
      "malformed {name}.{field}"
    );
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

async fn issue_key(app: &axum::Router, session_id: Uuid, name: &str, scopes: &[&str]) -> String {
  let response = helpers::gql(
    app,
    session_id,
    json!({
      "query": "mutation($name:String!,$scopes:[String!]!){apiKeys{createApiKey(name:$name,scopes:$scopes){key}}}",
      "variables": { "name": name, "scopes": scopes }
    }),
  )
  .await;
  assert!(response.get("errors").is_none(), "API-key creation failed: {response}");
  response["data"]["apiKeys"]["createApiKey"]["key"]
    .as_str()
    .expect("one-time MCP key")
    .to_string()
}

#[tokio::test]
async fn inv_mcp_calendar_http_lifecycle_is_bounded_scoped_read_only_and_retryable() {
  let (app, pool, auth_store) = helpers::setup_app_with_config_override(|config| config.mcp.enabled = true).await;
  let (owner_id, owner_session) = helpers::seed_user(&pool, &auth_store, "mcp-calendar-owner").await;
  let (foreign_id, foreign_session) = helpers::seed_user(&pool, &auth_store, "mcp-calendar-foreign").await;
  let outcome = std::panic::AssertUnwindSafe(async {
  let workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let source_doc_id = helpers::create_doc(&pool, workspace_id, owner_id).await;
  let second_owner_workspace_id = helpers::create_workspace(&pool, owner_id).await;
  let token = issue_key(
    &app,
    owner_session,
    "mcp:calendar-lifecycle-e2e",
    &["read:calendar", "write:calendar"],
  )
  .await;

  let initialized = mcp(
    &app,
    &token,
    1,
    "initialize",
    json!({ "protocolVersion": "2024-11-05", "clientInfo": { "name": "calendar-e2e", "version": "1" } }),
  )
  .await;
  assert_eq!(initialized["result"]["serverInfo"]["name"], "myoxus");

  let listed_tools = mcp(&app, &token, 2, "tools/list", json!({})).await;
  let tool_names = listed_tools["result"]["tools"]
    .as_array()
    .expect("tools list")
    .iter()
    .filter_map(|tool| tool["name"].as_str())
    .collect::<Vec<_>>();
  for expected in [
    "calendar_events_list",
    "calendar_conflicts_check",
    "calendar_event_create",
    "calendar_event_update",
    "calendar_event_delete",
  ] {
    assert!(tool_names.contains(&expected), "missing calendar tool {expected}");
  }

  let empty_window = json!({"workspace_id": workspace_id, "from":"2026-07-21T00:00:00Z", "to":"2026-07-23T00:00:00Z"});
  assert_eq!(
    call(&app, &token, 20, "calendar_events_list", empty_window.clone()).await["events"],
    json!([])
  );
  assert_eq!(
    call(&app, &token, 21, "calendar_conflicts_check", empty_window).await["conflicts"],
    json!([])
  );
  let starts_at = "2026-07-22T10:00:00+02:00";
  let ends_at = "2026-07-22T11:00:00+02:00";
  let create_arguments = json!({
    "workspace_id": workspace_id,
    "title": "MCP calendar lifecycle",
    "starts_at": starts_at,
    "ends_at": ends_at,
    "source_external_id": source_doc_id.to_string(),
    "reminders": [{ "minutes_before": 15, "channel": "in_app" }],
    "idempotency_key": format!("calendar-create-{workspace_id}")
  });
  let created = call(&app, &token, 3, "calendar_event_create", create_arguments.clone()).await;
  let event_id = Uuid::parse_str(created["id"].as_str().expect("created event id")).expect("event UUID");
  assert_eq!(created["origin"], "native");
  assert_eq!(created["workspaceId"], workspace_id.to_string());
  assert_eq!(created["sourceExternalId"], source_doc_id.to_string());
  assert!(created.get("sourceDocId").is_none());
  let create_replay = call(&app, &token, 4, "calendar_event_create", create_arguments).await;
  assert_eq!(create_replay, created, "create replay must return the original event");
  let created_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE id = $1")
    .bind(event_id)
    .fetch_one(&pool)
    .await
    .expect("created event count");
  assert_eq!(created_count, 1, "create replay must not persist a second event");

  let window = json!({
    "workspace_id": workspace_id,
    "from": "2026-07-21T00:00:00Z",
    "to": "2026-07-23T00:00:00Z"
  });
  let events = call(&app, &token, 5, "calendar_events_list", window.clone()).await;
  assert_eq!(events["events"].as_array().map(Vec::len), Some(1));
  assert_eq!(events["events"][0]["id"], event_id.to_string());
  assert_eq!(events["events"][0]["sourceExternalId"], source_doc_id.to_string());
  let persisted_source: Option<Uuid> = sqlx::query_scalar("SELECT source_doc_id FROM calendar_events WHERE id = $1")
    .bind(event_id)
    .fetch_one(&pool)
    .await
    .expect("persisted Calendar document link");
  assert_eq!(persisted_source, Some(source_doc_id));
  let conflicts = call(&app, &token, 6, "calendar_conflicts_check", window.clone()).await;
  assert_eq!(conflicts["conflicts"].as_array().map(Vec::len), Some(1));
  assert_eq!(conflicts["conflicts"][0]["eventId"], event_id.to_string());

  let update_arguments = json!({
    "workspace_id": workspace_id,
    "event_id": event_id,
    "title": "Updated MCP calendar lifecycle",
    "idempotency_key": format!("calendar-update-{event_id}")
  });
  let updated = call(&app, &token, 7, "calendar_event_update", update_arguments.clone()).await;
  assert_eq!(updated["title"], "Updated MCP calendar lifecycle");
  let update_replay = call(&app, &token, 8, "calendar_event_update", update_arguments).await;
  assert_eq!(update_replay, updated, "update replay must return the original result");

  let read_only_token = issue_key(&app, owner_session, "mcp:calendar-read-only-e2e", &["read:calendar"]).await;
  let scope_denied = call_failure(
    &app,
    &read_only_token,
    9,
    "calendar_event_create",
    json!({
      "workspace_id": workspace_id,
      "starts_at": starts_at,
      "ends_at": ends_at,
      "idempotency_key": "scope-denied"
    }),
  )
  .await;
  assert_eq!(scope_denied["code"], "SCOPE_DENIED");

  let foreign_token = issue_key(
    &app,
    foreign_session,
    "mcp:calendar-foreign-e2e",
    &["read:calendar", "write:calendar"],
  )
  .await;
  let acl_denied = call_failure(&app, &foreign_token, 10, "calendar_events_list", window.clone()).await;
  assert_eq!(acl_denied["code"], "PERMISSION_DENIED");

  let cross_workspace = call_failure(
    &app,
    &token,
    11,
    "calendar_event_update",
    json!({
      "workspace_id": second_owner_workspace_id,
      "event_id": event_id,
      "title": "must not cross workspace boundaries",
      "idempotency_key": "cross-workspace-update"
    }),
  )
  .await;
  assert_eq!(cross_workspace["code"], "NOT_FOUND");

  let invalid_range = call_failure(
    &app,
    &token,
    12,
    "calendar_events_list",
    json!({
      "workspace_id": workspace_id,
      "from": "2026-07-23T00:00:00Z",
      "to": "2026-07-22T00:00:00Z"
    }),
  )
  .await;
  assert_eq!(invalid_range["code"], "INVALID_ARGUMENT");
  let oversized_window = call_failure(
    &app,
    &token,
    13,
    "calendar_events_list",
    json!({
      "workspace_id": workspace_id,
      "from": "2026-01-01T00:00:00Z",
      "to": "2026-05-01T00:00:00Z"
    }),
  )
  .await;
  assert_eq!(oversized_window["code"], "INVALID_ARGUMENT");
  let invalid_create = call_failure(
    &app,
    &token,
    14,
    "calendar_event_create",
    json!({
      "workspace_id": workspace_id,
      "starts_at": "2026-07-22T12:00:00Z",
      "ends_at": "2026-07-22T11:00:00Z",
      "idempotency_key": "invalid-create-range"
    }),
  )
  .await;
  assert_eq!(invalid_create["code"], "INVALID_ARGUMENT");

  let account_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config) VALUES ($1, $2, 'caldav', $3, '{}'::jsonb)",
  )
  .bind(account_id)
  .bind(owner_id)
  .bind(format!("mcp-calendar-{account_id}"))
  .execute(&pool)
  .await
  .expect("external calendar account");
  let external_event_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO calendar_events (id, origin, account_id, workspace_id, remote_event_id, starts_at, ends_at, title, payload) VALUES ($1, 'external', $2, $3, $4, $5, $6, $7, '{}'::jsonb)",
  )
  .bind(external_event_id)
  .bind(account_id)
  .bind(workspace_id)
  .bind(format!("remote-{external_event_id}"))
  .bind(Utc.with_ymd_and_hms(2026, 7, 22, 12, 0, 0).single().expect("external start"))
  .bind(Utc.with_ymd_and_hms(2026, 7, 22, 13, 0, 0).single().expect("external end"))
  .bind("Sensitive external event")
  .execute(&pool)
  .await
  .expect("external calendar event");
  let external_list = call(&app, &token, 22, "calendar_events_list", window.clone()).await;
  assert!(
    external_list["events"]
      .as_array()
      .unwrap()
      .iter()
      .any(|event| event["origin"] == "external")
  );

  for (request_id, tool_name) in [(15, "calendar_event_update"), (16, "calendar_event_delete")] {
    let mut arguments = json!({
      "workspace_id": workspace_id,
      "event_id": external_event_id,
      "idempotency_key": format!("external-{tool_name}")
    });
    if tool_name == "calendar_event_update" {
      arguments["title"] = json!("must remain unchanged");
    }
    let read_only = call_failure(&app, &token, request_id, tool_name, arguments).await;
    assert_eq!(read_only["code"], "CALENDAR_EVENT_READ_ONLY");
  }
  let external_title: String = sqlx::query_scalar("SELECT title FROM calendar_events WHERE id = $1")
    .bind(external_event_id)
    .fetch_one(&pool)
    .await
    .expect("external event remains");
  assert_eq!(external_title, "Sensitive external event");

  let delete_arguments = json!({
    "workspace_id": workspace_id,
    "event_id": event_id,
    "idempotency_key": format!("calendar-delete-{event_id}")
  });
  let deleted = call(&app, &token, 17, "calendar_event_delete", delete_arguments.clone()).await;
  assert_eq!(deleted["deleted"], true);
  let delete_replay = call(&app, &token, 18, "calendar_event_delete", delete_arguments).await;
  assert_eq!(
    delete_replay, deleted,
    "delete replay must survive removal of the event"
  );
  let deleted_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM calendar_events WHERE id = $1)")
    .bind(event_id)
    .fetch_one(&pool)
    .await
    .expect("deleted event existence");
  assert!(!deleted_exists);

  let bulk_start = Utc.with_ymd_and_hms(2026, 7, 24, 8, 0, 0).single().expect("bulk start");
  sqlx::query(
    r#"INSERT INTO calendar_events
         (id, origin, workspace_id, starts_at, ends_at, title, payload)
       SELECT gen_random_uuid(), 'native', $1,
              $2 + (series * interval '1 second'),
              $2 + (series * interval '1 second') + interval '30 minutes',
              'bounded MCP result fixture', '{}'::jsonb
         FROM generate_series(1, 501) AS series"#,
  )
  .bind(workspace_id)
  .bind(bulk_start)
  .execute(&pool)
  .await
  .expect("bounded-result fixtures");
  let too_many = call_failure(
    &app,
    &token,
    19,
    "calendar_events_list",
    json!({
      "workspace_id": workspace_id,
      "from": bulk_start - Duration::minutes(1),
      "to": bulk_start + Duration::hours(1)
    }),
  )
  .await;
  assert_eq!(too_many["code"], "RESULT_TOO_LARGE");

  }).catch_unwind().await;
  // Cleanup runs before propagating a failed HTTP/schema assertion.
  helpers::cleanup_users(&pool, &[owner_id, foreign_id]).await;
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
