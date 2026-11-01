//! Integration tests for the server-info endpoint (version, build metadata).
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use myoxus_api::{build_router_for_integration_tests as build_router, config::AppConfig, state::ApiState};
use serde_json::Value;
use tower::ServiceExt;

fn test_state() -> ApiState {
  let mut config = AppConfig::load().expect("config");
  // Route contracts must not depend on an operator's package-local label.
  config.server.name = "Myoxus Server".to_string();
  ApiState::new(config)
}

fn throttled_state(limit: u32) -> ApiState {
  let mut config = AppConfig::load().expect("config");
  config.throttle.enabled = true;
  config.throttle.throttlers.default.limit = limit;
  config.throttle.throttlers.default.ttl_ms = 60_000;
  ApiState::new(config)
}

#[tokio::test]
async fn test_info_endpoint() {
  let app = build_router(test_state());

  let response = app
    .oneshot(
      Request::builder()
        .uri("/info")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");

  // Version must be a non-empty semver string (X.Y.Z).
  let version = json["version"].as_str().expect("'version' must be a string");
  assert!(
    version.split('.').count() == 3 && version.split('.').all(|p| p.parse::<u32>().is_ok()),
    "'version' must match semver pattern X.Y.Z, got '{version}'"
  );
  assert_eq!(
    json["version"],
    env!("CARGO_PKG_VERSION"),
    "'version' must be the declared build version"
  );

  // Flavor must be exactly the Myoxus-Rust identifier.
  assert_eq!(json["flavor"], "myoxus-rust", "'flavor' must be 'myoxus-rust'");

  // Name must be a non-empty string.
  let name = json["name"].as_str().expect("'name' must be a string");
  assert!(!name.is_empty(), "'name' must not be empty");
  assert_eq!(
    json["name"], "Myoxus Server",
    "'name' must match the declared server name"
  );
  assert!(
    !name.contains("Rust"),
    "'name' is user-facing and must not expose implementation technology"
  );

  // initialized might be false in tests if DB is empty
  assert!(json["initialized"].is_boolean(), "'initialized' must be a boolean");
}

#[tokio::test]
async fn test_graphql_server_config() {
  let app = build_router(test_state());

  let query = r#"{"query":"{ auth { serverConfig { version flavor name baseUrl initialized oauthProviders features availableUpgrade { version url } availableUserFeatures availableWorkspaceFeatures } } serverConfig { availableUpgrade { version } availableUserFeatures availableWorkspaceFeatures } }"}"#;
  let response = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/graphql")
        .header("content-type", "application/json")
        .body(Body::from(query))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");

  let config = &json["data"]["auth"]["serverConfig"];
  assert_eq!(config["version"], env!("CARGO_PKG_VERSION"));
  assert_eq!(config["flavor"], "myoxus-rust");
  assert_eq!(config["name"], "Myoxus Server");
  assert!(
    !config["name"].as_str().unwrap_or_default().contains("Rust"),
    "serverConfig.name is rendered in clients and must stay product-facing"
  );
  assert!(config["initialized"].is_boolean());
  assert!(config["baseUrl"].as_str().is_some());
  assert!(config["oauthProviders"].as_array().is_some());
  assert!(config["availableUpgrade"].is_null());
  let available_user_features = config["availableUserFeatures"]
    .as_array()
    .expect("availableUserFeatures must be an array");
  let available_workspace_features = config["availableWorkspaceFeatures"]
    .as_array()
    .expect("availableWorkspaceFeatures must be an array");
  for forbidden in [
    "FreePlan",
    "ProPlan",
    "TeamPlan",
    "LifetimeProPlan",
    "UnlimitedWorkspace",
  ] {
    assert!(
      !available_user_features.iter().any(|v| v == forbidden),
      "availableUserFeatures must not advertise plan/quota feature {forbidden}"
    );
    assert!(
      !available_workspace_features.iter().any(|v| v == forbidden),
      "availableWorkspaceFeatures must not advertise plan/quota feature {forbidden}"
    );
  }
  let features = config["features"].as_array().expect("features array");
  assert!(!features.is_empty(), "features must be a non-empty array");
  assert!(!features.iter().any(|v| v == "Payment"));

  // P-ENUM-ENFORCE-B: advertise baseline capabilities the client expects.
  // Missing advertisements cause feature-flag checks in the web client to silently
  // disable local workspaces, search, commenting, etc.
  let feature_strs: Vec<&str> = features.iter().filter_map(|v| v.as_str()).collect();
  for required in ["OAuth", "LocalWorkspace", "Indexer", "Comment"] {
    assert!(
      feature_strs.contains(&required),
      "ServerFeature.{required} must be advertised; got {feature_strs:?}"
    );
  }

  let root_config = &json["data"]["serverConfig"];
  assert!(root_config["availableUpgrade"].is_null());
  assert!(root_config["availableUserFeatures"].as_array().is_some());
  assert!(root_config["availableWorkspaceFeatures"].as_array().is_some());
}

#[tokio::test]
async fn test_queue_trpc_routes_are_unmounted() {
  let app = build_router(test_state());

  for (method, uri) in [
    ("GET", "/api/queue/trpc/queue.list?batch=1&input=%7B%7D"),
    ("POST", "/api/queue/trpc/queue.pause?batch=1"),
  ] {
    let response = app
      .clone()
      .oneshot(
        Request::builder()
          .method(method)
          .uri(uri)
          .body(Body::empty())
          .expect("HTTP request failed"),
      )
      .await
      .expect("HTTP request failed");

    assert_eq!(
      response.status(),
      404,
      "legacy queue tRPC route must stay unmounted for {method} {uri}"
    );
  }
}

#[tokio::test]
async fn test_throttle_returns_429_when_limit_exceeded() {
  let app = build_router(throttled_state(1));

  let first = app
    .clone()
    .oneshot(
      Request::builder()
        .uri("/info")
        .header("x-forwarded-for", "203.0.113.1")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(first.status(), 200);

  let second = app
    .oneshot(
      Request::builder()
        .uri("/info")
        .header("x-forwarded-for", "203.0.113.1")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(second.status(), 429);
}

#[tokio::test]
async fn test_i18n_config_get_endpoint_returns_default_config() {
  let app = build_router(test_state());

  let response = app
    .oneshot(
      Request::builder()
        .uri("/api/i18n/config")
        .body(Body::empty())
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");

  assert_eq!(response.status(), 200);
  let body = response.into_body().collect().await.expect("collect body").to_bytes();
  let json: Value = serde_json::from_slice(&body).expect("JSON parse");
  assert_eq!(json["defaultLocale"], "en");
  assert!(json["availableLocales"].as_array().is_some_and(|arr| !arr.is_empty()));
}

#[tokio::test]
async fn test_i18n_config_put_requires_auth() {
  let app = build_router(test_state());
  let response = app
    .oneshot(
      Request::builder()
        .method("PUT")
        .uri("/api/i18n/config")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"defaultLocale":"de","availableLocales":["en","de"]}"#))
        .expect("HTTP request failed"),
    )
    .await
    .expect("HTTP request failed");
  assert_eq!(response.status(), 401);
}
