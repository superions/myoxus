// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Integration coverage for AdminRoot queue operations.
//!
//! Queue state is operator/business data. The admin frontend must use the
//! generated `admin { ... }` GraphQL surface and must not call the old
//! `/api/queue/trpc/*` bridge.

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
fn admin_queue_status_jobs_and_auth_are_graphql_only() {
  helpers::block_on_large_stack("admin-queue-graphql", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (user_id, user_session) = helpers::seed_user(&pool, &auth_store, "queue-user").await;

    let status_query = r#"
      query AdminQueueStatus {
        admin {
          queueStatus {
            redisAvailable
            degraded
            queues {
              name
              displayName
              paused
              degraded
              counts { waiting active completed failed delayed stalled }
              history { timestamp pending }
            }
          }
        }
      }
    "#;
    let status = helpers::gql(&app, admin_session, json!({ "query": status_query })).await;
    assert_no_graphql_errors(&status, "admin queue status");
    let queues = status["data"]["admin"]["queueStatus"]["queues"]
      .as_array()
      .expect("queueStatus.queues must be an array");
    let names: Vec<&str> = queues.iter().filter_map(|queue| queue["name"].as_str()).collect();
    for expected in [
      "notification",
      "doc",
      "nightly",
      "workspace",
      "workspace-import",
      "telemetry-flush",
      "metrics-flush",
      "copilot",
      "indexer",
      "calendar-reminder",
      "git-sync",
      "template-registry",
      "caldav-sync",
      "google-calendar-sync",
      "pdf-export",
      "database",
      "document-graph",
      "workspace-automation",
      "workspace-content-operation",
    ] {
      assert!(names.contains(&expected), "missing queue {expected}: {names:?}");
    }

    let jobs_query = r#"
      query AdminQueueJobs($queueName: String!, $status: String!, $cursor: Int!, $limit: Int!) {
        admin {
          queueJobs(queueName: $queueName, status: $status, cursor: $cursor, limit: $limit) {
            totalCount
            numOfPages
            nextCursor
            jobs { id name timestamp attemptsMade finishedOn failedReason data returnValue }
          }
        }
      }
    "#;
    let jobs = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": jobs_query,
        "variables": { "queueName": "notification", "status": "waiting", "cursor": 0, "limit": 10 }
      }),
    )
    .await;
    assert_no_graphql_errors(&jobs, "admin queue jobs");
    assert!(jobs["data"]["admin"]["queueJobs"]["totalCount"].is_number());
    assert!(jobs["data"]["admin"]["queueJobs"]["jobs"].as_array().is_some());

    let non_admin = helpers::gql(&app, user_session, json!({ "query": status_query })).await;
    assert_graphql_rejected(&non_admin, "non-admin queue status");

    let anonymous = helpers::gql_anon(
      &app,
      json!({
        "query": "query { admin { queueStatus { queues { name history { timestamp pending } } } } }"
      }),
    )
    .await;
    assert_graphql_rejected(&anonymous, "anonymous queue status");

    helpers::cleanup_users(&pool, &[admin_id, user_id]).await;
  });
}

#[test]
fn admin_queue_mutations_are_admin_only_and_validate_queue_names() {
  helpers::block_on_large_stack("admin-queue-mutations", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (user_id, user_session) = helpers::seed_user(&pool, &auth_store, "queue-mutation-user").await;

    let mutation = r#"
      mutation QueueOps($queueName: String!) {
        admin {
          pauseQueue(queueName: $queueName) { ok name error }
          resumeQueue(queueName: $queueName) { ok name error }
          cleanQueue(queueName: $queueName, status: "completed", gracePeriodMs: 0) { ok name removed error }
          emptyQueue(queueName: $queueName) { ok name removed error }
          retryJob(queueName: $queueName, jobId: "missing-test-job") { ok name jobId error }
          promoteJob(queueName: $queueName, jobId: "missing-test-job") { ok name jobId error }
        }
      }
    "#;
    let admin = helpers::gql(
      &app,
      admin_session,
      json!({ "query": mutation, "variables": { "queueName": "notification" } }),
    )
    .await;
    assert_no_graphql_errors(&admin, "admin queue mutations");
    assert!(admin["data"]["admin"]["pauseQueue"]["ok"].is_boolean());
    assert!(
      admin["data"]["admin"]["cleanQueue"]["removed"].is_number()
        || admin["data"]["admin"]["cleanQueue"]["removed"].is_null()
    );
    assert!(admin["data"]["admin"]["retryJob"]["ok"].is_boolean());
    assert_eq!(admin["data"]["admin"]["retryJob"]["jobId"], "missing-test-job");
    assert!(admin["data"]["admin"]["promoteJob"]["ok"].is_boolean());
    assert_eq!(admin["data"]["admin"]["promoteJob"]["jobId"], "missing-test-job");

    let non_admin = helpers::gql(
      &app,
      user_session,
      json!({ "query": mutation, "variables": { "queueName": "notification" } }),
    )
    .await;
    assert_graphql_rejected(&non_admin, "non-admin queue mutations");

    let durable_retry = helpers::gql(
      &app, admin_session,
      json!({ "query": "mutation { admin { retryJob(queueName: \"workspace-content-operation\", jobId: \"terminal-operation\") { ok } } }" }),
    ).await;
    assert_graphql_rejected(
      &durable_retry,
      "durable workspace operations cannot bypass their feature-owned retry",
    );

    let invalid = helpers::gql(
      &app,
      admin_session,
      json!({ "query": mutation, "variables": { "queueName": "does-not-exist" } }),
    )
    .await;
    assert_graphql_rejected(&invalid, "invalid queue mutation");

    helpers::cleanup_users(&pool, &[admin_id, user_id]).await;
  });
}

#[test]
fn admin_queue_operations_are_not_flat_root_and_legacy_trpc_is_unmounted() {
  helpers::block_on_large_stack("admin-queue-no-trpc", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;

    let response = helpers::gql(
      &app,
      admin_session,
      json!({ "query": "{ __schema { queryType { fields(includeDeprecated: true) { name } } mutationType { fields(includeDeprecated: true) { name } } } __type(name: \"AdminRoot\") { fields(includeDeprecated: true) { name } } }" }),
    )
    .await;
    assert_no_graphql_errors(&response, "admin queue introspection");
    let query_fields: Vec<String> = response["data"]["__schema"]["queryType"]["fields"]
      .as_array()
      .map(|fields| {
        fields
          .iter()
          .filter_map(|entry| entry["name"].as_str().map(ToOwned::to_owned))
          .collect()
      })
      .unwrap_or_default();
    let mutation_fields: Vec<String> = response["data"]["__schema"]["mutationType"]["fields"]
      .as_array()
      .map(|fields| {
        fields
          .iter()
          .filter_map(|entry| entry["name"].as_str().map(ToOwned::to_owned))
          .collect()
      })
      .unwrap_or_default();
    let admin_fields: Vec<String> = response["data"]["__type"]["fields"]
      .as_array()
      .map(|fields| {
        fields
          .iter()
          .filter_map(|entry| entry["name"].as_str().map(ToOwned::to_owned))
          .collect()
      })
      .unwrap_or_default();

    for name in [
      "queueStatus",
      "queueJobs",
      "pauseQueue",
      "resumeQueue",
      "pauseAllQueues",
      "resumeAllQueues",
      "cleanQueue",
      "emptyQueue",
      "retryJob",
      "promoteJob",
    ] {
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

    for (method, uri) in [
      ("GET", "/api/queue/trpc/queue.list?batch=1&input=%7B%7D"),
      ("POST", "/api/queue/trpc/queue.pause?batch=1"),
    ] {
      assert_eq!(
        route_status(&app, method, uri).await,
        404,
        "{method} {uri} must stay unmounted; queue admin data is GraphQL-only"
      );
    }

    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}
