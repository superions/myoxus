// SPDX-License-Identifier: AGPL-3.0-or-later
//! OIDC group-to-organization-unit sync integration tests.
//!
//! The test IdP below is intentionally only the external boundary. Myoxus still
//! runs through the real Axum OAuth callback and SQLx-backed OU repositories so
//! the assertions cover the production reconciliation path.

use std::{collections::HashMap, sync::Arc};

use axum::{
  Json, Router,
  extract::{Form, State},
  http::{self, HeaderMap, Request, StatusCode, header},
  routing::{get, post},
};
use chrono::{DateTime, Utc};
use http_body_util::BodyExt;
use jsonwebtoken::{
  Algorithm, EncodingKey, Header,
  jwk::{Jwk, JwkSet},
};
use myoxus_api::config::{
  OAuthClaimsConfig, OAuthCustomProviderConfig, OAuthGroupMappingConfig, OAuthGroupMappingRuleConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use crate::helpers;
use tracing::instrument::WithSubscriber as _;

#[derive(Clone, Default)]
struct SsoLogCapture(Arc<std::sync::Mutex<Vec<u8>>>);
impl std::io::Write for SsoLogCapture {
  fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
    self.0.lock().expect("SSO capture lock").extend_from_slice(bytes);
    Ok(bytes.len())
  }
  fn flush(&mut self) -> std::io::Result<()> {
    Ok(())
  }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SsoLogCapture {
  type Writer = Self;
  fn make_writer(&'a self) -> Self {
    self.clone()
  }
}

#[derive(Clone)]
struct OidcFixture {
  users_by_token: Arc<HashMap<String, Value>>,
  base_url: String,
  signing_key: Arc<EncodingKey>,
  jwks: JwkSet,
}

struct OidcFixtureServer {
  base_url: String,
}

async fn spawn_oidc_fixture(users_by_code: HashMap<&'static str, Value>) -> OidcFixtureServer {
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
    .await
    .expect("bind local oidc fixture");
  let base_url = format!("http://{}", listener.local_addr().expect("fixture address"));
  let users_by_token = users_by_code
    .into_iter()
    .map(|(code, user)| (format!("token-{code}"), user))
    .collect::<HashMap<_, _>>();
  let signing_key = Arc::new(EncodingKey::from_rsa_pem(TEST_OIDC_PRIVATE_KEY.as_bytes()).expect("test OIDC key"));
  let jwk: Jwk = serde_json::from_str(TEST_OIDC_PUBLIC_JWK).expect("parse test OIDC public JWK");
  let fixture = OidcFixture {
    users_by_token: Arc::new(users_by_token),
    base_url: base_url.clone(),
    signing_key,
    jwks: JwkSet { keys: vec![jwk] },
  };
  let app = Router::new()
    .route("/authorize", get(|| async { StatusCode::OK }))
    .route("/.well-known/openid-configuration", get(discovery_handler))
    .route("/jwks", get(jwks_handler))
    .route("/token", post(token_handler))
    .route("/userinfo", get(userinfo_handler))
    .with_state(fixture);
  tokio::spawn(async move {
    axum::serve(listener, app)
      .await
      .expect("local oidc fixture server should run");
  });
  OidcFixtureServer { base_url }
}

const TEST_OIDC_KID: &str = "myoxus-test-rsa-1";

const TEST_OIDC_PUBLIC_JWK: &str = r#"{
  "kty": "RSA",
  "n": "yRE6rHuNR0QbHO3H3Kt2pOKGVhQqGZXInOduQNxXzuKlvQTLUTv4l4sggh5_CYYi_cvI-SXVT9kPWSKXxJXBXd_4LkvcPuUakBoAkfh-eiFVMh2VrUyWyj3MFl0HTVF9KwRXLAcwkREiS3npThHRyIxuy0ZMeZfxVL5arMhw1SRELB8HoGfG_AtH89BIE9jDBHZ9dLelK9a184zAf8LwoPLxvJb3Il5nncqPcSfKDDodMFBIMc4lQzDKL5gvmiXLXB1AGLm8KBjfE8s3L5xqi-yUod-j8MtvIj812dkS4QMiRVN_by2h3ZY8LYVGrqZXZTcgn2ujn8uKjXLZVD5TdQ",
  "e": "AQAB",
  "use": "sig",
  "alg": "RS256",
  "kid": "myoxus-test-rsa-1"
}"#;

const TEST_OIDC_PRIVATE_KEY: &str = r#"-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDJETqse41HRBsc
7cfcq3ak4oZWFCoZlcic525A3FfO4qW9BMtRO/iXiyCCHn8JhiL9y8j5JdVP2Q9Z
IpfElcFd3/guS9w+5RqQGgCR+H56IVUyHZWtTJbKPcwWXQdNUX0rBFcsBzCRESJL
eelOEdHIjG7LRkx5l/FUvlqsyHDVJEQsHwegZ8b8C0fz0EgT2MMEdn10t6Ur1rXz
jMB/wvCg8vG8lvciXmedyo9xJ8oMOh0wUEgxziVDMMovmC+aJctcHUAYubwoGN8T
yzcvnGqL7JSh36Pwy28iPzXZ2RLhAyJFU39vLaHdljwthUaupldlNyCfa6Ofy4qN
ctlUPlN1AgMBAAECggEAdESTQjQ70O8QIp1ZSkCYXeZjuhj081CK7jhhp/4ChK7J
GlFQZMwiBze7d6K84TwAtfQGZhQ7km25E1kOm+3hIDCoKdVSKch/oL54f/BK6sKl
qlIzQEAenho4DuKCm3I4yAw9gEc0DV70DuMTR0LEpYyXcNJY3KNBOTjN5EYQAR9s
2MeurpgK2MdJlIuZaIbzSGd+diiz2E6vkmcufJLtmYUT/k/ddWvEtz+1DnO6bRHh
xuuDMeJA/lGB/EYloSLtdyCF6sII6C6slJJtgfb0bPy7l8VtL5iDyz46IKyzdyzW
tKAn394dm7MYR1RlUBEfqFUyNK7C+pVMVoTwCC2V4QKBgQD64syfiQ2oeUlLYDm4
CcKSP3RnES02bcTyEDFSuGyyS1jldI4A8GXHJ/lG5EYgiYa1RUivge4lJrlNfjyf
dV230xgKms7+JiXqag1FI+3mqjAgg4mYiNjaao8N8O3/PD59wMPeWYImsWXNyeHS
55rUKiHERtCcvdzKl4u35ZtTqQKBgQDNKnX2bVqOJ4WSqCgHRhOm386ugPHfy+8j
m6cicmUR46ND6ggBB03bCnEG9OtGisxTo/TuYVRu3WP4KjoJs2LD5fwdwJqpgtHl
yVsk45Y1Hfo+7M6lAuR8rzCi6kHHNb0HyBmZjysHWZsn79ZM+sQnLpgaYgQGRbKV
DZWlbw7g7QKBgQCl1u+98UGXAP1jFutwbPsx40IVszP4y5ypCe0gqgon3UiY/G+1
zTLp79GGe/SjI2VpQ7AlW7TI2A0bXXvDSDi3/5Dfya9ULnFXv9yfvH1QwWToySpW
Kvd1gYSoiX84/WCtjZOr0e0HmLIb0vw0hqZA4szJSqoxQgvF22EfIWaIaQKBgQCf
34+OmMYw8fEvSCPxDxVvOwW2i7pvV14hFEDYIeZKW2W1HWBhVMzBfFB5SE8yaCQy
pRfOzj9aKOCm2FjjiErVNpkQoi6jGtLvScnhZAt/lr2TXTrl8OwVkPrIaN0bG/AS
aUYxmBPCpXu3UjhfQiWqFq/mFyzlqlgvuCc9g95HPQKBgAscKP8mLxdKwOgX8yFW
GcZ0izY/30012ajdHY+/QK5lsMoxTnn0skdS+spLxaS5ZEO4qvPVb8RAoCkWMMal
2pOhmquJQVDPDLuZHdrIiKiDM20dy9sMfHygWcZjQ4WSxf/J7T9canLZIXFhHAZT
3wc9h4G8BBCtWN2TN/LsGZdB
-----END PRIVATE KEY-----"#;

#[derive(Debug, Serialize)]
struct TestIdTokenClaims {
  iss: String,
  sub: String,
  aud: String,
  exp: i64,
  iat: i64,
  nonce: String,
  email: Option<String>,
  email_verified: Option<bool>,
  name: Option<String>,
  picture: Option<String>,
}

async fn discovery_handler(State(fixture): State<OidcFixture>) -> Json<Value> {
  Json(json!({
    "issuer": fixture.base_url,
    "authorization_endpoint": format!("{}/authorize", fixture.base_url),
    "token_endpoint": format!("{}/token", fixture.base_url),
    "userinfo_endpoint": format!("{}/userinfo", fixture.base_url),
    "jwks_uri": format!("{}/jwks", fixture.base_url)
  }))
}

async fn jwks_handler(State(fixture): State<OidcFixture>) -> Json<JwkSet> {
  Json(fixture.jwks)
}

async fn token_handler(State(fixture): State<OidcFixture>, Form(form): Form<HashMap<String, String>>) -> Json<Value> {
  let code = form.get("code").cloned().unwrap_or_default();
  let (user_code, nonce) = code
    .split_once("::")
    .map(|(user_code, nonce)| (user_code.to_string(), nonce.to_string()))
    .unwrap_or_else(|| (code.clone(), String::new()));
  let token = format!("token-{user_code}");
  let user = fixture
    .users_by_token
    .get(&token)
    .cloned()
    .unwrap_or_else(|| json!({ "sub": user_code }));
  let mut header = Header::new(Algorithm::RS256);
  header.kid = Some(TEST_OIDC_KID.to_string());
  let now = Utc::now().timestamp();
  let claims = TestIdTokenClaims {
    iss: user["_idTokenIssuer"].as_str().unwrap_or(&fixture.base_url).to_string(),
    sub: user["sub"].as_str().unwrap_or(&user_code).to_string(),
    aud: user["_idTokenAudience"].as_str().unwrap_or("myoxus-test").to_string(),
    exp: now + user["_idTokenExpDelta"].as_i64().unwrap_or(3600),
    iat: now,
    nonce,
    email: user["email"].as_str().map(str::to_string),
    email_verified: user["email_verified"].as_bool(),
    name: user["name"].as_str().map(str::to_string),
    picture: user["picture"].as_str().map(str::to_string),
  };
  let id_token = jsonwebtoken::encode(&header, &claims, &fixture.signing_key).expect("sign fixture ID token");
  Json(json!({
    "access_token": token,
    "id_token": id_token,
    "token_type": "Bearer",
    "expires_in": 3600
  }))
}

async fn userinfo_handler(State(fixture): State<OidcFixture>, headers: HeaderMap) -> Result<Json<Value>, StatusCode> {
  let token = headers
    .get(header::AUTHORIZATION)
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.strip_prefix("Bearer "))
    .ok_or(StatusCode::UNAUTHORIZED)?;
  fixture
    .users_by_token
    .get(token)
    .cloned()
    .map(Json)
    .ok_or(StatusCode::UNAUTHORIZED)
}

async fn oauth_state(app: &Router, nonce: &str) -> String {
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/oauth/preflight")
        .header(header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(
          json!({
            "provider": "oidc",
            "client_nonce": nonce,
            "client": "web",
            "redirect_uri": "/workspace"
          })
          .to_string(),
        ))
        .expect("preflight request"),
    )
    .await
    .expect("preflight response");
  assert_eq!(response.status(), StatusCode::OK);
  let body = response.into_body().collect().await.expect("preflight body").to_bytes();
  let value: Value = serde_json::from_slice(&body).expect("preflight json");
  query_param(value["url"].as_str().expect("auth url"), "state")
}

async fn oauth_callback(app: &Router, code: &str, state: &str, nonce: &str) -> (StatusCode, Value) {
  oauth_callback_with_provider_code(app, &format!("{code}::{nonce}"), state, nonce).await
}

async fn oauth_callback_with_provider_code(
  app: &Router,
  provider_code: &str,
  state: &str,
  nonce: &str,
) -> (StatusCode, Value) {
  let response = app
    .clone()
    .oneshot(
      Request::builder()
        .method(http::Method::POST)
        .uri("/api/oauth/callback?code=SSO_QUERY_SECRET_SENTINEL")
        .header(header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(
          json!({
            "code": provider_code,
            "state": state,
            "client_nonce": nonce
          })
          .to_string(),
        ))
        .expect("callback request"),
    )
    .await
    .expect("callback response");
  let status = response.status();
  let request_id = response
    .headers()
    .get("x-request-id")
    .expect("OAuth callback request ID")
    .to_str()
    .expect("request ID header");
  Uuid::parse_str(request_id).expect("server-generated request UUID");
  let body = response.into_body().collect().await.expect("callback body").to_bytes();
  let value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
  (status, value)
}

fn query_param(url: &str, name: &str) -> String {
  url
    .split_once('?')
    .and_then(|(_, query)| {
      query.split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == name).then(|| urlencoding::decode(value).expect("decode query param").to_string())
      })
    })
    .unwrap_or_else(|| panic!("missing query param {name} in {url}"))
}

fn oidc_provider_config_with_rules(
  base_url: &str,
  mappings: Vec<OAuthGroupMappingRuleConfig>,
) -> OAuthCustomProviderConfig {
  OAuthCustomProviderConfig {
    client_id: "myoxus-test".to_string(),
    client_secret: "myoxus-test-secret".to_string(),
    issuer_url: Some(base_url.to_string()),
    discovery_url: Some(format!("{base_url}/.well-known/openid-configuration")),
    auth_url: format!("{base_url}/authorize"),
    token_url: format!("{base_url}/token"),
    userinfo_url: format!("{base_url}/userinfo"),
    jwks_url: Some(format!("{base_url}/jwks")),
    scopes: vec![
      "openid".to_string(),
      "profile".to_string(),
      "email".to_string(),
      "groups".to_string(),
    ],
    claims: OAuthClaimsConfig {
      subject: Some("sub".to_string()),
      email: Some("email".to_string()),
      email_verified: Some("email_verified".to_string()),
      name: Some("name".to_string()),
      avatar: Some("picture".to_string()),
      groups: Some("groups".to_string()),
      groups_source: Some("userinfo".to_string()),
    },
    group_mapping: OAuthGroupMappingConfig {
      enabled: true,
      default_role: "member".to_string(),
      remove_missing_oidc_memberships: true,
      missing_groups_policy: Default::default(),
      unknown_groups: Default::default(),
      mappings,
    },
    group_directory: None,
    user_id_field: "sub".to_string(),
    user_email_field: "email".to_string(),
    user_name_field: "name".to_string(),
    user_avatar_field: "picture".to_string(),
  }
}

fn oidc_provider_config(
  base_url: &str,
  unit_finance: Uuid,
  unit_managers: Uuid,
  unit_manual: Uuid,
) -> OAuthCustomProviderConfig {
  oidc_provider_config_with_rules(
    base_url,
    vec![
      OAuthGroupMappingRuleConfig {
        provider_group: "finance".to_string(),
        target_unit_id: unit_finance.to_string(),
        role: None,
      },
      OAuthGroupMappingRuleConfig {
        provider_group: "finance-managers".to_string(),
        target_unit_id: unit_managers.to_string(),
        role: Some("manager".to_string()),
      },
      OAuthGroupMappingRuleConfig {
        provider_group: "manual-preserve".to_string(),
        target_unit_id: unit_manual.to_string(),
        role: Some("manager".to_string()),
      },
    ],
  )
}

async fn user_id_for_email(pool: &PgPool, email: &str) -> (Uuid, Option<DateTime<Utc>>) {
  sqlx::query_as("SELECT id, email_verified_at FROM users WHERE email = $1")
    .bind(email)
    .fetch_one(pool)
    .await
    .expect("user row")
}

async fn membership(pool: &PgPool, unit_id: Uuid, user_id: Uuid) -> Option<(String, String)> {
  sqlx::query_as("SELECT role::text, source::text FROM organization_unit_member WHERE unit_id = $1 AND user_id = $2")
    .bind(unit_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .expect("membership row")
}

async fn membership_metadata(pool: &PgPool, unit_id: Uuid, user_id: Uuid) -> serde_json::Value {
  sqlx::query_scalar("SELECT metadata FROM organization_unit_member WHERE unit_id = $1 AND user_id = $2")
    .bind(unit_id)
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("membership metadata")
}

async fn manager_feature_active(pool: &PgPool, user_id: Uuid) -> bool {
  sqlx::query_scalar::<_, Option<bool>>(
    "SELECT activated FROM user_features WHERE user_id = $1 AND feature_name = 'manager'",
  )
  .bind(user_id)
  .fetch_optional(pool)
  .await
  .expect("manager feature row")
  .flatten()
  .unwrap_or(false)
}

#[derive(Debug, Deserialize)]
struct AuthentikMatrix {
  groups: Vec<AuthentikMatrixGroup>,
  users: Vec<AuthentikMatrixUser>,
  #[serde(rename = "expectedCounts")]
  expected_counts: AuthentikMatrixCounts,
}

#[derive(Debug, Deserialize)]
struct AuthentikMatrixGroup {
  name: String,
  role: Option<String>,
  mapped: bool,
}

#[derive(Debug, Deserialize)]
struct AuthentikMatrixUser {
  username: String,
  email: String,
  #[serde(default)]
  groups: Option<Vec<String>>,
  #[serde(rename = "expectedMemberships", default)]
  expected_memberships: Vec<String>,
  #[serde(rename = "expectedDenied", default)]
  expected_denied: bool,
}

#[derive(Debug, Deserialize)]
struct AuthentikMatrixCounts {
  users: usize,
  groups: usize,
  #[serde(rename = "mappedGroups")]
  mapped_groups: usize,
}

#[tokio::test]
async fn oidc_matrix_runs_fifty_users_through_real_http_oidc_endpoints() {
  let matrix: AuthentikMatrix =
    serde_json::from_str(include_str!("../fixtures/authentik_oidc_ou_matrix.json")).expect("fixture matrix");
  assert_eq!(matrix.users.len(), matrix.expected_counts.users);
  assert_eq!(matrix.groups.len(), matrix.expected_counts.groups);
  assert_eq!(
    matrix.groups.iter().filter(|group| group.mapped).count(),
    matrix.expected_counts.mapped_groups
  );

  let users_by_code = matrix
    .users
    .iter()
    .map(|user| {
      let mut payload = json!({
        "sub": user.username,
        "email": user.email,
        "email_verified": true,
        "name": user.username
      });
      if let Some(groups) = &user.groups {
        payload["groups"] = json!(groups);
      }
      (
        Box::leak(user.username.clone().into_boxed_str()) as &'static str,
        payload,
      )
    })
    .collect::<HashMap<_, _>>();
  let fixture = spawn_oidc_fixture(users_by_code).await;

  let pool = helpers::setup_pool().await;
  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let mut units_by_group = HashMap::new();
  let mut unit_ids = Vec::new();
  for group in matrix.groups.iter().filter(|group| group.mapped) {
    let unit_id =
      helpers::create_organization_unit(&pool, org_id, unit_type_id, None, &format!("OIDC {}", group.name)).await;
    units_by_group.insert(group.name.clone(), unit_id);
    unit_ids.push(unit_id);
  }

  let mappings = matrix
    .groups
    .iter()
    .filter(|group| group.mapped)
    .map(|group| OAuthGroupMappingRuleConfig {
      provider_group: group.name.clone(),
      target_unit_id: units_by_group[&group.name].to_string(),
      role: group.role.clone().filter(|role| role != "member"),
    })
    .collect::<Vec<_>>();
  let provider_config = oidc_provider_config_with_rules(&fixture.base_url, mappings);
  let (app, pool, _) = helpers::setup_app_with_pool_and_config_override(pool, move |config| {
    config.oauth.providers.insert("oidc".to_string(), provider_config);
  })
  .await;

  let mut created_users = Vec::new();
  for (index, user) in matrix.users.iter().enumerate() {
    let nonce = format!("matrix-nonce-{index}");
    let state = oauth_state(&app, &nonce).await;
    let (status, body) = oauth_callback(&app, &user.username, &state, &nonce).await;
    if user.expected_denied {
      assert_eq!(status, StatusCode::FORBIDDEN, "{}: {body}", user.username);
      continue;
    }
    assert_eq!(status, StatusCode::OK, "{}: {body}", user.username);
    let (user_id, _) = user_id_for_email(&pool, &user.email).await;
    created_users.push(user_id);

    let oidc_count: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM organization_unit_member WHERE user_id = $1 AND source = 'oidc'")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .expect("oidc membership count");
    assert_eq!(
      oidc_count as usize,
      user.expected_memberships.len(),
      "{}",
      user.username
    );

    for group in &user.expected_memberships {
      let unit_id = units_by_group[group];
      let expected_role = matrix
        .groups
        .iter()
        .find(|item| &item.name == group)
        .and_then(|item| item.role.clone())
        .unwrap_or_else(|| "member".to_string());
      assert_eq!(
        membership(&pool, unit_id, user_id).await,
        Some((expected_role, "oidc".to_string())),
        "{} -> {}",
        user.username,
        group
      );
    }
  }

  helpers::cleanup_users(&pool, &created_users).await;
  helpers::cleanup_organization_units(&pool, &unit_ids).await;
}

#[tokio::test]
async fn oidc_group_mapping_syncs_revokes_and_preserves_manual_ou_memberships() {
  let fixture = spawn_oidc_fixture(HashMap::from([
    (
      "initial-login",
      json!({
        "sub": "authentik-user-1",
        "email": "authentik-user-1@example.test",
        "email_verified": true,
        "name": "Authentik User One",
        "groups": ["finance", "finance-managers", "unmapped-provider-group"]
      }),
    ),
    (
      "revoked-login",
      json!({
        "sub": "authentik-user-1",
        "email": "authentik-user-1@example.test",
        "email_verified": true,
        "name": "Authentik User One",
        "groups": ["finance", "manual-preserve", "import-preserve"]
      }),
    ),
    (
      "nonce-mismatch-login",
      json!({
        "sub": "authentik-user-nonce",
        "email": "nonce-mismatch@example.test",
        "email_verified": true,
        "name": "Nonce Mismatch",
        "groups": ["finance"]
      }),
    ),
    (
      "missing-groups-login",
      json!({
        "sub": "authentik-user-missing-groups",
        "email": "missing-groups@example.test",
        "email_verified": true,
        "name": "Missing Groups"
      }),
    ),
  ]))
  .await;

  let pool = helpers::setup_pool().await;
  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_finance = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "OIDC Finance").await;
  let unit_managers =
    helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "OIDC Finance Managers").await;
  let unit_manual =
    helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "OIDC Manual Preservation").await;
  let unit_import =
    helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "OIDC Import Preservation").await;

  let mut provider_config = oidc_provider_config(&fixture.base_url, unit_finance, unit_managers, unit_manual);
  provider_config
    .group_mapping
    .mappings
    .push(OAuthGroupMappingRuleConfig {
      provider_group: "import-preserve".to_string(),
      target_unit_id: unit_import.to_string(),
      role: Some("manager".to_string()),
    });
  let (app, pool, _) = helpers::setup_app_with_pool_and_config_override(pool, move |config| {
    config.oauth.providers.insert("oidc".to_string(), provider_config);
  })
  .await;

  let state = oauth_state(&app, "nonce-initial").await;
  let capture = SsoLogCapture::default();
  let subscriber = tracing_subscriber::fmt()
    .with_env_filter("off,myoxus_application::auth=debug,myoxus_api::auth=debug,myoxus_api::handlers::middleware=debug")
    .with_ansi(false)
    .without_time()
    .with_writer(capture.clone())
    .finish();
  let (status, body) = oauth_callback(&app, "initial-login", &state, "nonce-initial")
    .with_subscriber(subscriber)
    .await;
  let logs = String::from_utf8(capture.0.lock().expect("SSO capture lock").clone()).expect("UTF8 logs");
  assert!(
    logs.contains("sso.callback.completed"),
    "successful callback must log completion: {logs}"
  );
  assert!(
    logs.contains("sso.claims.group_preview")
      && logs.contains("pseudonym=")
      && logs.contains("mapped=true")
      && logs.contains("mapped=false"),
    "group diagnostics must include bounded pseudonyms and mapping decisions: {logs}"
  );
  for secret in [
    state.as_str(),
    "nonce-initial",
    "finance",
    "unmapped-provider-group",
    "authentik-user-1@example.test",
    "token-initial-login",
    "SSO_QUERY_SECRET_SENTINEL",
  ] {
    assert!(!logs.contains(secret), "SSO tracing exposed sensitive input");
  }
  assert_eq!(status, StatusCode::OK, "{body}");

  let (user_id, verified_at) = user_id_for_email(&pool, "authentik-user-1@example.test").await;
  assert!(
    verified_at.is_some(),
    "email_verified=true should mark the Myoxus account verified"
  );
  assert_eq!(
    membership(&pool, unit_finance, user_id).await,
    Some(("member".to_string(), "oidc".to_string()))
  );
  assert_eq!(
    membership(&pool, unit_managers, user_id).await,
    Some(("manager".to_string(), "oidc".to_string()))
  );
  assert!(
    manager_feature_active(&pool, user_id).await,
    "OIDC manager OU membership must materialize the shared Manager capability"
  );
  let manager_metadata = membership_metadata(&pool, unit_managers, user_id).await;
  assert_eq!(manager_metadata["source"], "oidc");
  assert_eq!(manager_metadata["provider"], "oidc");
  assert!(
    manager_metadata.get("providerGroup").is_none(),
    "OIDC membership metadata must not persist raw provider group names"
  );
  assert!(
    manager_metadata
      .get("providerGroupHash")
      .and_then(|value| value.as_str())
      .is_some_and(|value| value.len() == 64),
    "OIDC membership metadata should carry a stable group hash for diagnostics"
  );

  sqlx::query(
    r#"INSERT INTO organization_unit_member (unit_id, user_id, role, source, metadata, created_at, updated_at)
       VALUES ($1, $2, 'reader', 'manual', '{}'::jsonb, now(), now())"#,
  )
  .bind(unit_manual)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("insert manual membership");
  sqlx::query(
    r#"INSERT INTO organization_unit_member (unit_id, user_id, role, source, metadata, created_at, updated_at)
       VALUES ($1, $2, 'reader', 'import', '{}'::jsonb, now(), now())"#,
  )
  .bind(unit_import)
  .bind(user_id)
  .execute(&pool)
  .await
  .expect("insert import membership");

  let state = oauth_state(&app, "nonce-revoked").await;
  let (status, body) = oauth_callback(&app, "revoked-login", &state, "nonce-revoked").await;
  assert_eq!(status, StatusCode::OK, "{body}");
  assert_eq!(
    membership(&pool, unit_finance, user_id).await,
    Some(("member".to_string(), "oidc".to_string()))
  );
  assert_eq!(membership(&pool, unit_managers, user_id).await, None);
  assert!(
    !manager_feature_active(&pool, user_id).await,
    "revoking the last OIDC manager OU membership must revoke the shared Manager capability"
  );
  assert_eq!(
    membership(&pool, unit_manual, user_id).await,
    Some(("reader".to_string(), "manual".to_string())),
    "OIDC sync must not overwrite or delete administrator-owned memberships"
  );
  assert_eq!(
    membership(&pool, unit_import, user_id).await,
    Some(("reader".to_string(), "import".to_string())),
    "OIDC sync must not overwrite or delete imported memberships"
  );

  let state = oauth_state(&app, "nonce-missing").await;
  let capture = SsoLogCapture::default();
  let subscriber = tracing_subscriber::fmt()
    .with_env_filter("off,myoxus_application::auth=debug,myoxus_api::auth=debug,myoxus_api::handlers::middleware=debug,myoxus_application::organization::oidc_sync=debug")
    .with_ansi(false).without_time().with_writer(capture.clone()).finish();
  let (status, body) = oauth_callback(&app, "missing-groups-login", &state, "nonce-missing")
    .with_subscriber(subscriber)
    .await;
  let logs = String::from_utf8(capture.0.lock().expect("SSO capture lock").clone()).expect("UTF8 logs");
  assert!(
    logs.contains("sso.callback.failed") && logs.contains("OIDC_GROUPS_CLAIM_MISSING") && logs.contains("group_policy"),
    "missing-groups rejection must identify phase and reason: {logs}"
  );
  assert!(
    logs.contains("sso.claims.inspected") && logs.contains("missing_or_null"),
    "claim diagnostics must explain the missing source: {logs}"
  );
  assert!(logs.contains("sso_operation_id"), "callback logs must be correlated");
  for secret in [
    state.as_str(),
    "nonce-missing",
    "missing-groups@example.test",
    "authentik-user-missing-groups",
    "token-missing-groups-login",
    "SSO_QUERY_SECRET_SENTINEL",
  ] {
    assert!(!logs.contains(secret), "SSO tracing exposed sensitive input");
  }
  assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
  assert_eq!(body["name"], "OIDC_GROUPS_CLAIM_MISSING");
  let denied_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE email = 'missing-groups@example.test'")
    .fetch_one(&pool)
    .await
    .expect("denied user count");
  assert_eq!(denied_count, 0, "deny_login must stop before local user creation");

  let state = oauth_state(&app, "nonce-expected").await;
  let (status, body) = oauth_callback_with_provider_code(
    &app,
    "nonce-mismatch-login::nonce-from-attacker",
    &state,
    "nonce-expected",
  )
  .await;
  assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
  assert_eq!(body["name"], "OIDC_ID_TOKEN_NONCE_INVALID");
  let denied_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE email = 'nonce-mismatch@example.test'")
    .fetch_one(&pool)
    .await
    .expect("nonce denied user count");
  assert_eq!(
    denied_count, 0,
    "invalid ID-token nonce must stop before local user creation"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
  helpers::cleanup_organization_units(&pool, &[unit_import, unit_manual, unit_managers, unit_finance]).await;
}

#[tokio::test]
async fn oidc_group_mapping_uses_reader_default_role_when_rule_has_no_override() {
  let fixture = spawn_oidc_fixture(HashMap::from([(
    "reader-default-login",
    json!({
      "sub": "authentik-reader-default",
      "email": "authentik-reader-default@example.test",
      "email_verified": true,
      "name": "Authentik Reader Default",
      "groups": ["finance"]
    }),
  )]))
  .await;

  let pool = helpers::setup_pool().await;
  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_finance = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "OIDC Reader Default").await;
  let mut provider_config = oidc_provider_config_with_rules(
    &fixture.base_url,
    vec![OAuthGroupMappingRuleConfig {
      provider_group: "finance".to_string(),
      target_unit_id: unit_finance.to_string(),
      role: None,
    }],
  );
  provider_config.group_mapping.default_role = "reader".to_string();
  let (app, pool, _) = helpers::setup_app_with_pool_and_config_override(pool, move |config| {
    config.oauth.providers.insert("oidc".to_string(), provider_config);
  })
  .await;

  let state = oauth_state(&app, "reader-default-nonce").await;
  let (status, body) = oauth_callback(&app, "reader-default-login", &state, "reader-default-nonce").await;
  assert_eq!(status, StatusCode::OK, "{body}");

  let (user_id, _) = user_id_for_email(&pool, "authentik-reader-default@example.test").await;
  assert_eq!(
    membership(&pool, unit_finance, user_id).await,
    Some(("reader".to_string(), "oidc".to_string())),
    "rule without role override must use groupMapping.defaultRole"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
  helpers::cleanup_organization_units(&pool, &[unit_finance]).await;
}

#[tokio::test]
async fn oidc_group_mapping_cannot_exceed_typed_ou_member_limit() {
  let fixture = spawn_oidc_fixture(HashMap::from([(
    "member-limit-login",
    json!({
      "sub": "authentik-member-limit",
      "email": "authentik-member-limit@example.test",
      "email_verified": true,
      "name": "Authentik Member Limit",
      "groups": ["limited"]
    }),
  )]))
  .await;

  let pool = helpers::setup_pool().await;
  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "OIDC member limit").await;
  sqlx::query("UPDATE organization_unit SET max_members = 1 WHERE id = $1")
    .bind(unit_id)
    .execute(&pool)
    .await
    .expect("limit OIDC target unit");
  let occupying_user = Uuid::new_v4();
  sqlx::query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)")
    .bind(occupying_user)
    .bind(format!("oidc-limit-occupant-{occupying_user}@example.test"))
    .bind("OIDC limit occupant")
    .execute(&pool)
    .await
    .expect("create occupying user");
  sqlx::query(
    "INSERT INTO organization_unit_member (unit_id, user_id, role, source)
     VALUES ($1, $2, 'member', 'manual')",
  )
  .bind(unit_id)
  .bind(occupying_user)
  .execute(&pool)
  .await
  .expect("occupy final OU member slot");

  let provider_config = oidc_provider_config_with_rules(
    &fixture.base_url,
    vec![OAuthGroupMappingRuleConfig {
      provider_group: "limited".to_string(),
      target_unit_id: unit_id.to_string(),
      role: None,
    }],
  );
  let (app, pool, _) = helpers::setup_app_with_pool_and_config_override(pool, move |config| {
    config.oauth.providers.insert("oidc".to_string(), provider_config);
  })
  .await;

  let state = oauth_state(&app, "member-limit-nonce").await;
  let (status, body) = oauth_callback(&app, "member-limit-login", &state, "member-limit-nonce").await;
  assert_eq!(
    status,
    StatusCode::INTERNAL_SERVER_ERROR,
    "repository rejection must fail reconciliation: {body}"
  );
  let member_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organization_unit_member WHERE unit_id = $1")
    .bind(unit_id)
    .fetch_one(&pool)
    .await
    .expect("count limited OU members");
  assert_eq!(member_count, 1, "OIDC must not materialize an over-limit membership");

  let rejected_user: Option<Uuid> =
    sqlx::query_scalar("SELECT id FROM users WHERE email = 'authentik-member-limit@example.test'")
      .fetch_optional(&pool)
      .await
      .expect("load rejected OIDC user");
  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
  let mut users = vec![occupying_user];
  users.extend(rejected_user);
  helpers::cleanup_users(&pool, &users).await;
}

#[tokio::test]
async fn oidc_group_mapping_rejects_an_inactive_target_unit() {
  let fixture = spawn_oidc_fixture(HashMap::from([(
    "inactive-target-login",
    json!({
      "sub": "authentik-inactive-target",
      "email": "authentik-inactive-target@example.test",
      "email_verified": true,
      "name": "Authentik Inactive Target",
      "groups": ["inactive-unit"]
    }),
  )]))
  .await;

  let pool = helpers::setup_pool().await;
  let org_id = helpers::default_organization_id(&pool).await;
  let unit_type_id = helpers::preset_unit_type_id(&pool, "team").await;
  let unit_id = helpers::create_organization_unit(&pool, org_id, unit_type_id, None, "OIDC Inactive Target").await;
  sqlx::query("UPDATE organization_unit SET status = 'disabled' WHERE id = $1")
    .bind(unit_id)
    .execute(&pool)
    .await
    .expect("disable target OU");
  let provider_config = oidc_provider_config_with_rules(
    &fixture.base_url,
    vec![OAuthGroupMappingRuleConfig {
      provider_group: "inactive-unit".to_string(),
      target_unit_id: unit_id.to_string(),
      role: None,
    }],
  );
  let (app, pool, _) = helpers::setup_app_with_pool_and_config_override(pool, move |config| {
    config.oauth.providers.insert("oidc".to_string(), provider_config);
  })
  .await;

  let nonce = "inactive-target-nonce";
  let state = oauth_state(&app, nonce).await;
  let (status, body) = oauth_callback(&app, "inactive-target-login", &state, nonce).await;
  assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
  assert_eq!(body["name"], "OIDC_GROUP_MAPPING_INACTIVE", "{body}");
  let membership_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organization_unit_member WHERE unit_id = $1")
    .bind(unit_id)
    .fetch_one(&pool)
    .await
    .expect("inactive target membership count");
  assert_eq!(
    membership_count, 0,
    "inactive OUs must not receive new OIDC memberships"
  );

  let created_user: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
    .bind("authentik-inactive-target@example.test")
    .fetch_optional(&pool)
    .await
    .expect("lookup denied OIDC user");
  if let Some(user_id) = created_user {
    helpers::cleanup_users(&pool, &[user_id]).await;
  }
  helpers::cleanup_organization_units(&pool, &[unit_id]).await;
}

#[tokio::test]
async fn oidc_id_token_validation_rejects_issuer_audience_and_expiry() {
  let fixture = spawn_oidc_fixture(HashMap::from([
    (
      "wrong-issuer",
      json!({
        "sub": "oidc-wrong-issuer",
        "email": "oidc-wrong-issuer@example.test",
        "email_verified": true,
        "name": "Wrong Issuer",
        "groups": [],
        "_idTokenIssuer": "https://issuer.example.invalid"
      }),
    ),
    (
      "wrong-audience",
      json!({
        "sub": "oidc-wrong-audience",
        "email": "oidc-wrong-audience@example.test",
        "email_verified": true,
        "name": "Wrong Audience",
        "groups": [],
        "_idTokenAudience": "another-client"
      }),
    ),
    (
      "expired-token",
      json!({
        "sub": "oidc-expired-token",
        "email": "oidc-expired-token@example.test",
        "email_verified": true,
        "name": "Expired Token",
        "groups": [],
        "_idTokenExpDelta": -3600
      }),
    ),
  ]))
  .await;

  let pool = helpers::setup_pool().await;
  let provider_config = oidc_provider_config_with_rules(&fixture.base_url, Vec::new());
  let (app, pool, _) = helpers::setup_app_with_pool_and_config_override(pool, move |config| {
    config.oauth.providers.insert("oidc".to_string(), provider_config);
  })
  .await;

  for code in ["wrong-issuer", "wrong-audience", "expired-token"] {
    let nonce = format!("nonce-{code}");
    let state = oauth_state(&app, &nonce).await;
    let capture = SsoLogCapture::default();
    let subscriber = tracing_subscriber::fmt()
      .with_env_filter("off,myoxus_application::auth=debug,myoxus_api::auth=debug")
      .with_ansi(false)
      .without_time()
      .with_writer(capture.clone())
      .finish();
    let (status, body) = oauth_callback(&app, code, &state, &nonce)
      .with_subscriber(subscriber)
      .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{code}: {body}");
    assert_eq!(body["name"], "OIDC_ID_TOKEN_INVALID", "{code}: {body}");
    let logs = String::from_utf8(capture.0.lock().expect("SSO capture lock").clone()).expect("UTF8 logs");
    let reason = match code {
      "wrong-issuer" => "issuer_mismatch",
      "wrong-audience" => "audience_mismatch",
      _ => "expired",
    };
    assert!(
      logs.contains("sso.token.rejected") && logs.contains(reason) && logs.contains("sso.callback.failed"),
      "JWT rejection must explain its specific cause: {logs}"
    );
    assert!(
      !logs.contains(&nonce) && !logs.contains(&state) && !logs.contains("@example.test"),
      "JWT diagnostics exposed credentials or claims"
    );
  }

  let denied_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE email = ANY($1)")
    .bind(vec![
      "oidc-wrong-issuer@example.test",
      "oidc-wrong-audience@example.test",
      "oidc-expired-token@example.test",
    ])
    .fetch_one(&pool)
    .await
    .expect("invalid token denied user count");
  assert_eq!(
    denied_count, 0,
    "invalid issuer/audience/expiry must stop before local user creation"
  );
}

#[tokio::test]
async fn oidc_callback_rejects_disabled_users_and_unverified_mail_policy() {
  let _guard = helpers::AUTH_CONFIG_LOCK
    .get_or_init(|| tokio::sync::Mutex::new(()))
    .lock()
    .await;
  let fixture = spawn_oidc_fixture(HashMap::from([
    (
      "disabled-same-email",
      json!({
        "sub": "oidc-disabled-same-email",
        "email": "oidc-disabled-same-email@example.test",
        "email_verified": true,
        "name": "Disabled Same Email",
        "groups": []
      }),
    ),
    (
      "unverified-policy",
      json!({
        "sub": "oidc-unverified-policy",
        "email": "oidc-unverified-policy@example.test",
        "email_verified": false,
        "name": "Unverified Policy",
        "groups": []
      }),
    ),
  ]))
  .await;

  let pool = helpers::setup_pool().await;
  sqlx::query("DELETE FROM app_configs WHERE id = 'auth.require_email_verification'")
    .execute(&pool)
    .await
    .expect("clear email verification config");
  sqlx::query(
    "INSERT INTO app_configs (id, value, created_at, updated_at)
     VALUES ('auth.require_email_verification', 'true'::jsonb, now(), now())
     ON CONFLICT (id) DO UPDATE SET value = excluded.value, updated_at = now()",
  )
  .execute(&pool)
  .await
  .expect("enable email verification policy");

  let disabled_user_id = Uuid::new_v4();
  sqlx::query(
    "INSERT INTO users (id, email, name, status, is_admin, email_verified_at)
     VALUES ($1, 'oidc-disabled-same-email@example.test', 'Disabled OIDC User', 'disabled', false, now())",
  )
  .bind(disabled_user_id)
  .execute(&pool)
  .await
  .expect("insert disabled user");

  let provider_config = oidc_provider_config_with_rules(&fixture.base_url, Vec::new());
  let (app, pool, _) = helpers::setup_app_with_pool_and_config_override(pool, move |config| {
    config.oauth.providers.insert("oidc".to_string(), provider_config);
  })
  .await;

  let state = oauth_state(&app, "nonce-disabled").await;
  let (status, body) = oauth_callback(&app, "disabled-same-email", &state, "nonce-disabled").await;
  assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
  assert_eq!(body["name"], "USER_DISABLED");
  let connected_count: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM connected_accounts WHERE provider_account_id = 'oidc-disabled-same-email'",
  )
  .fetch_one(&pool)
  .await
  .expect("disabled connected account count");
  assert_eq!(
    connected_count, 0,
    "disabled user rejection must not link the OIDC account"
  );

  let state = oauth_state(&app, "nonce-unverified").await;
  let (status, body) = oauth_callback(&app, "unverified-policy", &state, "nonce-unverified").await;
  assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
  assert_eq!(body["name"], "EMAIL_VERIFICATION_REQUIRED");
  let user_count: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE email = 'oidc-unverified-policy@example.test'")
      .fetch_one(&pool)
      .await
      .expect("unverified user count");
  assert_eq!(
    user_count, 0,
    "unverified OIDC mail must not create a local user when policy requires verification"
  );

  sqlx::query("DELETE FROM app_configs WHERE id = 'auth.require_email_verification'")
    .execute(&pool)
    .await
    .expect("cleanup email verification config");
  helpers::cleanup_users(&pool, &[disabled_user_id]).await;
}
