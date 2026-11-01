// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Integration coverage for admin runtime GraphQL surfaces.
//!
//! Metrics and telemetry runtime state is business/operator data. It must live
//! under the existing `admin { ... }` root and use the normal admin auth gate;
//! the admin frontend must not poll separate REST roots for these aggregates.

use crate::helpers;
use axum::{body::Body, http::Request};
use serde_json::{Value, json};
use tower::ServiceExt;

fn assert_no_graphql_errors(response: &Value, label: &str) {
  assert!(
    response.get("errors").is_none(),
    "{label} returned GraphQL errors: {response}"
  );
}

fn assert_graphql_rejected(response: &Value, label: &str) {
  assert!(
    response["errors"].as_array().is_some_and(|errors| !errors.is_empty()),
    "{label} must reject unauthorized access: {response}"
  );
}

async fn route_status(app: &axum::Router, method: &str, uri: &str) -> u16 {
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .expect("request"),
    )
    .await
    .expect("response");
  response.status().as_u16()
}

#[test]
fn admin_runtime_status_and_flush_are_admin_graphql_only() {
  helpers::block_on_large_stack("admin-runtime-status", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (user_id, user_session) = helpers::seed_user(&pool, &auth_store, "runtime-user").await;

    let status_query = r#"
    query AdminRuntimeStatus {
      admin {
        metricsStatus {
          enabled
          activeSeries
          persisted24h
          dailyRollups7d
          counters {
            offeredTotal
            acceptedTotal
            cardinalityDropsTotal
          }
          topSeries { category name labels value }
        }
        telemetryStatus {
          enabled
          hotBufferLen
          persisted24h
          dailyRollups7d
          dedupeHitRate
          counters {
            offeredTotal
            acceptedTotal
            rejectedInvalidTotal
          }
        }
      }
    }
  "#;

    let admin_status = helpers::gql(&app, admin_session, json!({ "query": status_query })).await;
    assert_no_graphql_errors(&admin_status, "admin runtime status");
    assert!(admin_status["data"]["admin"]["metricsStatus"]["activeSeries"].is_number());
    assert!(admin_status["data"]["admin"]["telemetryStatus"]["hotBufferLen"].is_number());

    let flush_mutation = r#"
    mutation AdminRuntimeFlush {
      admin {
        flushMetrics { buffered inserted }
        flushTelemetry { buffered inserted }
      }
    }
  "#;
    let admin_flush = helpers::gql(&app, admin_session, json!({ "query": flush_mutation })).await;
    assert_no_graphql_errors(&admin_flush, "admin runtime flush");
    assert!(admin_flush["data"]["admin"]["flushMetrics"]["buffered"].is_number());
    assert!(admin_flush["data"]["admin"]["flushTelemetry"]["inserted"].is_number());

    let non_admin_status = helpers::gql(&app, user_session, json!({ "query": status_query })).await;
    assert_graphql_rejected(&non_admin_status, "non-admin runtime status");

    let anon_flush = helpers::gql_anon(&app, json!({ "query": flush_mutation })).await;
    assert_graphql_rejected(&anon_flush, "anonymous runtime flush");

    helpers::cleanup_users(&pool, &[admin_id, user_id]).await;
  });
}

#[test]
fn admin_runtime_operations_are_not_flat_root_fields() {
  helpers::block_on_large_stack("admin-runtime-introspection", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

    let response = helpers::gql(
    &app,
    admin_session,
    json!({ "query": "{ __schema { queryType { fields(includeDeprecated: true) { name } } mutationType { fields(includeDeprecated: true) { name } } } __type(name: \"AdminRoot\") { fields(includeDeprecated: true) { name } } }" }),
  )
  .await;
    assert_no_graphql_errors(&response, "admin runtime introspection");

    let query_fields: Vec<String> = response["data"]["__schema"]["queryType"]["fields"]
      .as_array()
      .unwrap_or(&vec![])
      .iter()
      .filter_map(|entry| entry["name"].as_str().map(ToOwned::to_owned))
      .collect();
    let mutation_fields: Vec<String> = response["data"]["__schema"]["mutationType"]["fields"]
      .as_array()
      .unwrap_or(&vec![])
      .iter()
      .filter_map(|entry| entry["name"].as_str().map(ToOwned::to_owned))
      .collect();
    let admin_fields: Vec<String> = response["data"]["__type"]["fields"]
      .as_array()
      .unwrap_or(&vec![])
      .iter()
      .filter_map(|entry| entry["name"].as_str().map(ToOwned::to_owned))
      .collect();

    for name in ["metricsStatus", "flushMetrics", "telemetryStatus", "flushTelemetry"] {
      assert!(admin_fields.contains(&name.to_string()), "AdminRoot missing {name}");
      assert!(
        !query_fields.contains(&name.to_string()),
        "{name} leaked to flat Query root"
      );
      assert!(
        !mutation_fields.contains(&name.to_string()),
        "{name} leaked to flat Mutation root"
      );
    }

    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn admin_runtime_legacy_rest_routes_are_not_mounted() {
  helpers::block_on_large_stack("admin-runtime-no-rest", || async {
    let (app, _pool, _auth_store) = helpers::setup_app().await;

    for (method, uri) in [
      ("GET", "/api/admin/metrics/status"),
      ("POST", "/api/admin/metrics/flush"),
      ("GET", "/api/admin/telemetry/status"),
      ("POST", "/api/admin/telemetry/flush"),
    ] {
      assert_eq!(
        route_status(&app, method, uri).await,
        404,
        "{method} {uri} must stay unmounted; admin runtime data is GraphQL-only under admin {{ ... }}"
      );
    }
  });
}
