//! OAuth2 preflight and callback route handlers.
//!
//! Implements the two-step OAuth2 flow: [`oauth_preflight`] generates an
//! authorization URL and state token for a configured provider (Google,
//! GitHub, etc.), and [`oauth_callback`] exchanges the authorization code for
//! a user identity, creates or retrieves the local account, and issues a
//! Myoxus session cookie. Provider config is read from `AppConfig` at runtime.

use async_trait::async_trait;
use axum::{
  Json,
  extract::{Query, State},
  http::{HeaderMap, header::USER_AGENT},
  response::{IntoResponse, Redirect, Response},
};
use chrono::Utc;
use oauth2::{AuthUrl, ClientId, ClientSecret, CsrfToken, RedirectUrl, Scope, TokenUrl, basic::BasicClient};
use serde::{Deserialize, Serialize};

use super::base::{SessionUserResponse, add_session_cookies, header_to_string, map_auth_error, x_forwarded_for};
use super::oidc;
use crate::{
  config::{OAuthCustomProviderConfig, OAuthGroupMappingConfig},
  error::ApiError,
  state::ApiState,
};
use myoxus_application::auth::SessionContext;
use myoxus_application::metrics::MetricsCategory;

/// Request body for `POST /api/auth/oauth/preflight`.
#[derive(Debug, Deserialize)]
pub struct OAuthPreflightRequest {
  /// OAuth provider name (e.g. `"google"`, `"github"`).
  pub provider: String,
  /// Optional redirect URI to use for the OAuth callback.
  pub redirect_uri: Option<String>,
  /// Optional client identifier (e.g. `"desktop"`) forwarded via state.
  pub client: Option<String>,
  /// Client-generated nonce verified at callback time to prevent CSRF.
  pub client_nonce: String,
}

/// Response body for the OAuth preflight — contains the provider authorization URL.
#[derive(Debug, Serialize)]
pub struct OAuthPreflightResponse {
  /// Full authorization URL to redirect the user to.
  pub url: String,
}

/// Query/body parameters for the OAuth callback endpoint.
#[derive(Debug, Deserialize)]
pub struct OAuthCallbackRequest {
  /// Authorization code returned by the provider.
  pub code: String,
  /// Opaque state token (stores the serialized [`OAuthStatePayload`]).
  pub state: String,
  /// Client nonce echoed back from the browser; must match the stored payload.
  pub client_nonce: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OAuthCallbackRedirectRequest {
  pub code: Option<String>,
  pub state: Option<String>,
  pub error: Option<String>,
  pub error_description: Option<String>,
}

/// Opaque state blob stored in Redis and round-tripped via the OAuth `state` parameter.
#[derive(Debug, Serialize, Deserialize)]
pub struct OAuthStatePayload {
  /// Normalized provider name.
  pub provider: String,
  /// Redirect URI originally supplied by the client.
  pub redirect_uri: Option<String>,
  /// Optional client identifier.
  pub client: Option<String>,
  /// CSRF nonce that the browser must echo back.
  pub client_nonce: String,
  /// Optional PKCE verifier for providers that require it.
  pub pkce: Option<OAuthPkceState>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthCallbackResponse {
  #[serde(flatten)]
  user: SessionUserResponse,
  redirect_uri: Option<String>,
}

/// PKCE verifier state for OAuth flows that require Proof Key for Code Exchange.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthPkceState {
  /// Base64-URL-encoded random verifier string.
  pub code_verifier: String,
  /// Challenge method (always `"S256"` when used).
  pub code_challenge_method: String,
}

/// OAuth token set obtained after a successful code exchange.
#[derive(Debug, Serialize, Deserialize)]
pub struct OAuthTokens {
  /// Bearer access token for API calls.
  pub access_token: String,
  /// OIDC ID token. Required for configured OpenID Connect providers because
  /// UserInfo alone is not a verifiable identity anchor.
  pub id_token: Option<String>,
  /// Optional refresh token (not all providers return one).
  pub refresh_token: Option<String>,
  /// Access token lifetime in seconds, if advertised by the provider.
  pub expires_in: Option<i64>,
}

/// Normalized user identity returned by an OAuth provider's userinfo endpoint.
pub struct OAuthAccount {
  /// Provider-scoped user identifier (opaque string or numeric ID).
  pub id: String,
  /// Primary e-mail address.
  pub email: String,
  /// Display name, if available.
  pub name: Option<String>,
  /// Avatar image URL, if available.
  pub avatar_url: Option<String>,
  /// OIDC e-mail verification claim, when supplied by the provider.
  pub email_verified: Option<bool>,
  /// OIDC groups claim, when supplied by the provider userinfo response.
  pub groups: Option<Vec<String>>,
}

/// Abstraction over a single OAuth2 identity provider.
///
/// Implementations exist for Google, GitHub, and a generic OIDC-compatible
/// provider driven by config YAML.  Each implementation is responsible for
/// constructing the authorization URL, exchanging the code for tokens, and
/// fetching the user's profile from the provider's userinfo endpoint.
#[async_trait]
pub trait OAuthProvider: Send + Sync {
  /// Short provider identifier (e.g. `"google"`, `"github"`).
  fn name(&self) -> &str;
  /// Build the authorization URL to redirect the browser to.
  fn get_auth_url(&self, state: &str, nonce: &str, redirect_uri: &str) -> String;
  /// Exchange the authorization code for access + refresh tokens.
  async fn get_token(
    &self,
    code: &str,
    redirect_uri: &str,
    pkce: Option<&OAuthPkceState>,
  ) -> Result<OAuthTokens, ApiError>;
  /// Fetch and validate the authenticated user's provider identity.
  ///
  /// Generic OIDC providers use `state` for cached discovery/JWKS metadata and
  /// `nonce` to bind the ID token back to the preflight request. Non-OIDC
  /// providers ignore both values.
  async fn get_user(&self, state: &ApiState, tokens: &OAuthTokens, nonce: &str) -> Result<OAuthAccount, ApiError>;
  /// Optional OIDC group-to-OU mapping. Built-in OAuth providers do not expose
  /// IdP groups and therefore return `None`.
  fn group_mapping(&self) -> Option<OAuthGroupMappingConfig> {
    None
  }
}

/// Google OAuth2 provider using the standard OpenID Connect endpoints.
pub struct GoogleProvider {
  client_id: String,
  client_secret: String,
  server_origin: String,
  /// P84-D-01: Shared HTTP client (avoids per-request allocation).
  http_client: reqwest::Client,
  trust_snapshot_id: String,
}

impl GoogleProvider {
  pub fn new(
    client_id: String,
    client_secret: String,
    server_origin: String,
    http_client: reqwest::Client,
    trust_snapshot_id: String,
  ) -> Self {
    Self {
      client_id,
      client_secret,
      server_origin,
      http_client,
      trust_snapshot_id,
    }
  }
}

/// GitHub OAuth2 provider using GitHub's non-standard token endpoint.
pub struct GitHubProvider {
  client_id: String,
  client_secret: String,
  server_origin: String,
  /// P84-D-01: Shared HTTP client (avoids per-request allocation).
  http_client: reqwest::Client,
  trust_snapshot_id: String,
}

impl GitHubProvider {
  pub fn new(
    client_id: String,
    client_secret: String,
    server_origin: String,
    http_client: reqwest::Client,
    trust_snapshot_id: String,
  ) -> Self {
    Self {
      client_id,
      client_secret,
      server_origin,
      http_client,
      trust_snapshot_id,
    }
  }
}

/// Generic OAuth2 provider driven entirely by configuration YAML.
///
/// Supports any OIDC-compatible provider by specifying `auth_url`, `token_url`,
/// `userinfo_url`, and the field names used by that provider's userinfo response.
pub struct GenericOAuthProvider {
  name: String,
  client_id: String,
  client_secret: String,
  auth_url: String,
  token_url: String,
  userinfo_url: String,
  scopes: Vec<String>,
  user_id_field: String,
  user_email_field: String,
  user_name_field: String,
  user_avatar_field: String,
  email_verified_field: Option<String>,
  groups_field: Option<String>,
  claims: crate::config::OAuthClaimsConfig,
  config: OAuthCustomProviderConfig,
  group_mapping: OAuthGroupMappingConfig,
  /// P84-D-01: Shared HTTP client (avoids per-request allocation).
  http_client: reqwest::Client,
  trust_snapshot_id: String,
}

impl GenericOAuthProvider {
  pub fn new(
    name: String,
    config: OAuthCustomProviderConfig,
    http_client: reqwest::Client,
    trust_snapshot_id: String,
  ) -> Result<Self, ApiError> {
    // Validate endpoint URLs once at provider construction.
    AuthUrl::new(config.auth_url.clone()).map_err(|e| ApiError::BadRequest {
      name: "INVALID_INPUT".into(),
      message: format!("Invalid auth_url for provider '{name}': {e}"),
      data: None,
    })?;
    TokenUrl::new(config.token_url.clone()).map_err(|e| ApiError::BadRequest {
      name: "INVALID_INPUT".into(),
      message: format!("Invalid token_url for provider '{name}': {e}"),
      data: None,
    })?;

    let user_id_field = config
      .claims
      .subject
      .clone()
      .unwrap_or_else(|| config.user_id_field.clone());
    let user_email_field = config
      .claims
      .email
      .clone()
      .unwrap_or_else(|| config.user_email_field.clone());
    let user_name_field = config
      .claims
      .name
      .clone()
      .unwrap_or_else(|| config.user_name_field.clone());
    let user_avatar_field = config
      .claims
      .avatar
      .clone()
      .unwrap_or_else(|| config.user_avatar_field.clone());
    let groups_field = config
      .claims
      .groups
      .clone()
      .or_else(|| config.group_mapping.enabled.then(|| "groups".to_string()));

    Ok(Self {
      name,
      client_id: config.client_id.clone(),
      client_secret: config.client_secret.clone(),
      auth_url: config.auth_url.clone(),
      token_url: config.token_url.clone(),
      userinfo_url: config.userinfo_url.clone(),
      scopes: config.scopes.clone(),
      user_id_field,
      user_email_field,
      user_name_field,
      user_avatar_field,
      email_verified_field: config.claims.email_verified.clone(),
      groups_field,
      claims: config.claims.clone(),
      group_mapping: config.group_mapping.clone(),
      config,
      http_client,
      trust_snapshot_id,
    })
  }
}

#[derive(Debug, Deserialize)]
struct GenericTokenEndpointResponse {
  access_token: String,
  #[serde(default)]
  id_token: Option<String>,
  #[serde(default)]
  refresh_token: Option<String>,
  #[serde(default)]
  expires_in: Option<i64>,
}

#[async_trait]
impl OAuthProvider for GenericOAuthProvider {
  fn name(&self) -> &str {
    &self.name
  }

  fn get_auth_url(&self, state: &str, nonce: &str, redirect_uri: &str) -> String {
    let auth_url = AuthUrl::new(self.auth_url.clone()).expect("validated oauth provider auth_url");
    let token_url = TokenUrl::new(self.token_url.clone()).expect("validated oauth provider token_url");
    let redirect_url = RedirectUrl::new(redirect_uri.to_string()).expect("validated oauth redirect_uri");
    let client = BasicClient::new(ClientId::new(self.client_id.clone()))
      .set_client_secret(ClientSecret::new(self.client_secret.clone()))
      .set_auth_uri(auth_url)
      .set_token_uri(token_url)
      .set_redirect_uri(redirect_url);

    let mut auth_request = client.authorize_url(|| CsrfToken::new(state.to_string()));
    for scope in &self.scopes {
      auth_request = auth_request.add_scope(Scope::new(scope.clone()));
    }
    let (auth_url, _) = auth_request.url();
    let mut url = auth_url.to_string();

    if !nonce.is_empty() {
      if url.contains('?') {
        url.push('&');
      } else {
        url.push('?');
      }
      url.push_str("nonce=");
      url.push_str(&urlencoding::encode(nonce));
    }

    url
  }

  async fn get_token(
    &self,
    code: &str,
    redirect_uri: &str,
    _pkce: Option<&OAuthPkceState>,
  ) -> Result<OAuthTokens, ApiError> {
    RedirectUrl::new(redirect_uri.to_string()).map_err(|_| ApiError::Internal("invalid OAuth redirect URI".into()))?;
    // Use a direct token-endpoint request for custom OIDC providers so the
    // response keeps provider-specific fields such as `id_token`. The oauth2
    // BasicClient type erases those fields for the basic token response.
    let response = self
      .http_client
      .post(&self.token_url)
      .basic_auth(&self.client_id, Some(&self.client_secret))
      .form(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
      ])
      .send()
      .await
      .map_err(|e| oidc::provider_http_error(&e, "token_exchange", &self.trust_snapshot_id))?;

    if !response.status().is_success() {
      return Err(oidc::provider_http_rejection(
        response.status(),
        "token_exchange",
        &self.trust_snapshot_id,
      ));
    }
    let token_response: GenericTokenEndpointResponse = response
      .json()
      .await
      .map_err(|e| oidc::provider_http_error(&e, "token_exchange", &self.trust_snapshot_id))?;

    Ok(OAuthTokens {
      access_token: token_response.access_token,
      id_token: token_response.id_token,
      refresh_token: token_response.refresh_token,
      expires_in: token_response.expires_in,
    })
  }

  async fn get_user(&self, state: &ApiState, tokens: &OAuthTokens, nonce: &str) -> Result<OAuthAccount, ApiError> {
    let id_token_claims =
      oidc::validate_id_token(state, &self.name, &self.config, tokens.id_token.as_deref(), nonce).await?;

    // P84-D-01: Reuse shared HTTP client.
    let res = self
      .http_client
      .get(&self.userinfo_url)
      .bearer_auth(&tokens.access_token)
      .send()
      .await
      .map_err(|e| oidc::provider_http_error(&e, "userinfo", &self.trust_snapshot_id))?;

    if !res.status().is_success() {
      return Err(oidc::provider_http_rejection(
        res.status(),
        "userinfo",
        &self.trust_snapshot_id,
      ));
    }

    let user: serde_json::Value = res
      .json()
      .await
      .map_err(|e| oidc::provider_http_error(&e, "userinfo", &self.trust_snapshot_id))?;

    oidc::log_claim_diagnostics(&self.claims, &self.config, id_token_claims.as_ref(), &user);
    let id_claim_root = id_token_claims.as_ref().unwrap_or(&user);
    let id = oidc::string_claim(id_claim_root, &self.user_id_field).ok_or_else(|| {
      tracing::warn!(
        event = "sso.claims.rejected",
        reason = "subject_missing_or_invalid",
        "OIDC subject claim is missing or invalid"
      );
      ApiError::Internal(format!(
        "{} OIDC ID token missing subject field '{}'",
        self.name, self.user_id_field
      ))
    })?;
    let email = oidc::string_claim(&user, &self.user_email_field)
      .or_else(|| {
        id_token_claims
          .as_ref()
          .and_then(|claims| oidc::string_claim(claims, &self.user_email_field))
      })
      .ok_or_else(|| {
        tracing::warn!(
          event = "sso.claims.rejected",
          reason = "email_missing_or_invalid",
          "OIDC email claim is missing or invalid"
        );
        ApiError::Internal(format!(
          "{} OIDC identity missing email field '{}'",
          self.name, self.user_email_field
        ))
      })?;
    let name = oidc::string_claim(&user, &self.user_name_field).or_else(|| {
      id_token_claims
        .as_ref()
        .and_then(|claims| oidc::string_claim(claims, &self.user_name_field))
    });
    let avatar_url = oidc::string_claim(&user, &self.user_avatar_field).or_else(|| {
      id_token_claims
        .as_ref()
        .and_then(|claims| oidc::string_claim(claims, &self.user_avatar_field))
    });
    let email_verified = oidc::bool_claim(&user, self.email_verified_field.as_deref()).or_else(|| {
      id_token_claims
        .as_ref()
        .and_then(|claims| oidc::bool_claim(claims, self.email_verified_field.as_deref()))
    });
    let groups = oidc::groups_from_sources(&self.claims, id_token_claims.as_ref(), &user)
      .or_else(|| oidc::groups_claim(&user, self.groups_field.as_deref()));

    Ok(OAuthAccount {
      id,
      email,
      name,
      avatar_url,
      email_verified,
      groups,
    })
  }

  fn group_mapping(&self) -> Option<OAuthGroupMappingConfig> {
    self.group_mapping.enabled.then(|| self.group_mapping.clone())
  }
}

#[async_trait]
impl OAuthProvider for GitHubProvider {
  fn name(&self) -> &str {
    "github"
  }

  fn get_auth_url(&self, state: &str, _nonce: &str, _redirect_uri: &str) -> String {
    let redirect_uri = format!("{}/api/oauth/callback", self.server_origin);
    format!(
      "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&scope=read:user%20user:email&state={}",
      self.client_id,
      urlencoding::encode(&redirect_uri),
      urlencoding::encode(state)
    )
  }

  async fn get_token(
    &self,
    code: &str,
    redirect_uri: &str,
    _pkce: Option<&OAuthPkceState>,
  ) -> Result<OAuthTokens, ApiError> {
    // P84-D-01: Reuse shared HTTP client.
    let res = self
      .http_client
      .post("https://github.com/login/oauth/access_token")
      .header("Accept", "application/json")
      .header("User-Agent", "myoxus-api")
      .form(&[
        ("code", code),
        ("client_id", &self.client_id),
        ("client_secret", &self.client_secret),
        ("redirect_uri", redirect_uri),
      ])
      .send()
      .await
      .map_err(|e| oidc::provider_http_error(&e, "token_exchange", &self.trust_snapshot_id))?;

    if !res.status().is_success() {
      return Err(oidc::provider_http_rejection(
        res.status(),
        "token_exchange",
        &self.trust_snapshot_id,
      ));
    }

    let tokens: serde_json::Value = res
      .json()
      .await
      .map_err(|e| oidc::provider_http_error(&e, "token_exchange", &self.trust_snapshot_id))?;
    let access_token = tokens["access_token"]
      .as_str()
      .ok_or_else(|| ApiError::Internal("No access_token".into()))?
      .to_string();

    Ok(OAuthTokens {
      access_token,
      id_token: None,
      refresh_token: tokens["refresh_token"].as_str().map(|s| s.to_string()),
      expires_in: tokens["expires_in"].as_i64(),
    })
  }

  async fn get_user(&self, _state: &ApiState, tokens: &OAuthTokens, _nonce: &str) -> Result<OAuthAccount, ApiError> {
    // P84-D-01: Reuse shared HTTP client.
    let res = self
      .http_client
      .get("https://api.github.com/user")
      .header("Accept", "application/vnd.github+json")
      .header("User-Agent", "myoxus-api")
      .bearer_auth(&tokens.access_token)
      .send()
      .await
      .map_err(|e| oidc::provider_http_error(&e, "userinfo", &self.trust_snapshot_id))?;

    if !res.status().is_success() {
      return Err(oidc::provider_http_rejection(
        res.status(),
        "userinfo",
        &self.trust_snapshot_id,
      ));
    }

    let user: serde_json::Value = res
      .json()
      .await
      .map_err(|e| oidc::provider_http_error(&e, "userinfo", &self.trust_snapshot_id))?;
    let id = user["id"]
      .as_i64()
      .map(|v| v.to_string())
      .or_else(|| user["id"].as_str().map(|v| v.to_string()))
      .ok_or_else(|| ApiError::Internal("No id".into()))?;

    let mut email = user["email"].as_str().map(|v| v.to_string());
    if email.is_none() {
      let emails_res = self
        .http_client
        .get("https://api.github.com/user/emails")
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "myoxus-api")
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|e| oidc::provider_http_error(&e, "userinfo", &self.trust_snapshot_id))?;

      if emails_res.status().is_success() {
        let emails: serde_json::Value = emails_res
          .json()
          .await
          .map_err(|e| oidc::provider_http_error(&e, "userinfo", &self.trust_snapshot_id))?;

        if let Some(items) = emails.as_array() {
          email = items
            .iter()
            .find(|item| item["primary"].as_bool() == Some(true) && item["verified"].as_bool() == Some(true))
            .or_else(|| items.iter().find(|item| item["verified"].as_bool() == Some(true)))
            .and_then(|item| item["email"].as_str())
            .map(|v| v.to_string());
        }
      }
    }

    let email = email.ok_or_else(|| ApiError::Internal("No email".into()))?;
    let name = user["name"]
      .as_str()
      .map(|v| v.to_string())
      .or_else(|| user["login"].as_str().map(|v| v.to_string()));
    let avatar_url = user["avatar_url"].as_str().map(|v| v.to_string());

    Ok(OAuthAccount {
      id,
      email,
      name,
      avatar_url,
      email_verified: None,
      groups: None,
    })
  }
}

#[async_trait]
impl OAuthProvider for GoogleProvider {
  fn name(&self) -> &str {
    "google"
  }

  fn get_auth_url(&self, state: &str, _nonce: &str, _redirect_uri: &str) -> String {
    let redirect_uri = format!("{}/api/oauth/callback", self.server_origin);
    format!(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope=openid%20email%20profile&state={}&access_type=offline&prompt=consent",
      self.client_id,
      urlencoding::encode(&redirect_uri),
      urlencoding::encode(state)
    )
  }

  async fn get_token(
    &self,
    code: &str,
    redirect_uri: &str,
    _pkce: Option<&OAuthPkceState>,
  ) -> Result<OAuthTokens, ApiError> {
    // P84-D-01: Reuse shared HTTP client.
    let res = self
      .http_client
      .post("https://oauth2.googleapis.com/token")
      .form(&[
        ("code", code),
        ("client_id", &self.client_id),
        ("client_secret", &self.client_secret),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
      ])
      .send()
      .await
      .map_err(|e| oidc::provider_http_error(&e, "token_exchange", &self.trust_snapshot_id))?;

    if !res.status().is_success() {
      return Err(oidc::provider_http_rejection(
        res.status(),
        "token_exchange",
        &self.trust_snapshot_id,
      ));
    }

    let tokens: serde_json::Value = res
      .json()
      .await
      .map_err(|e| oidc::provider_http_error(&e, "token_exchange", &self.trust_snapshot_id))?;
    Ok(OAuthTokens {
      access_token: tokens["access_token"]
        .as_str()
        .ok_or_else(|| ApiError::Internal("No access_token".into()))?
        .to_string(),
      id_token: tokens["id_token"].as_str().map(|s| s.to_string()),
      refresh_token: tokens["refresh_token"].as_str().map(|s| s.to_string()),
      expires_in: tokens["expires_in"].as_i64(),
    })
  }

  async fn get_user(&self, _state: &ApiState, tokens: &OAuthTokens, _nonce: &str) -> Result<OAuthAccount, ApiError> {
    // P84-D-01: Reuse shared HTTP client.
    let res = self
      .http_client
      .get("https://www.googleapis.com/oauth2/v3/userinfo")
      .bearer_auth(&tokens.access_token)
      .send()
      .await
      .map_err(|e| oidc::provider_http_error(&e, "userinfo", &self.trust_snapshot_id))?;

    if !res.status().is_success() {
      return Err(oidc::provider_http_rejection(
        res.status(),
        "userinfo",
        &self.trust_snapshot_id,
      ));
    }

    let user: serde_json::Value = res
      .json()
      .await
      .map_err(|e| oidc::provider_http_error(&e, "userinfo", &self.trust_snapshot_id))?;
    Ok(OAuthAccount {
      id: user["sub"]
        .as_str()
        .ok_or_else(|| ApiError::Internal("No sub".into()))?
        .to_string(),
      email: user["email"]
        .as_str()
        .ok_or_else(|| ApiError::Internal("No email".into()))?
        .to_string(),
      name: user["name"].as_str().map(|s| s.to_string()),
      avatar_url: user["picture"].as_str().map(|s| s.to_string()),
      email_verified: user["email_verified"].as_bool(),
      groups: None,
    })
  }
}

/// `POST /api/auth/oauth/preflight` — generate an OAuth2 authorization URL.
///
/// Serializes the request context (provider, redirect URI, client nonce) into
/// a Redis-backed state token, then calls the provider's `get_auth_url` to
/// construct the redirect URL that the browser should follow.
pub async fn oauth_preflight(
  State(state): State<ApiState>,
  Json(req): Json<OAuthPreflightRequest>,
) -> Result<Json<OAuthPreflightResponse>, ApiError> {
  if let Some(redirect_uri) = &req.redirect_uri {
    validate_oauth_redirect_target(redirect_uri)?;
  }

  let normalized_provider = normalize_provider_name(&req.provider);
  let provider = get_provider(&state, &normalized_provider).await?;

  let pkce = None;

  let state_payload = OAuthStatePayload {
    provider: normalized_provider,
    redirect_uri: req.redirect_uri.clone(),
    client: req.client.clone(),
    client_nonce: req.client_nonce.clone(),
    pkce,
  };

  let state_token = state
    .auth()
    .save_oauth_state(
      "OAuthState",
      serde_json::to_value(&state_payload)
        .map_err(|e| ApiError::Internal(format!("failed to serialize OAuth state: {e}")))?,
    )
    .await
    .map_err(map_auth_error)?;

  let redirect_uri = format!("{}/api/oauth/callback", state.config.server.origin);
  Ok(Json(OAuthPreflightResponse {
    url: provider.get_auth_url(&state_token, &req.client_nonce, &redirect_uri),
  }))
}

/// `POST /api/oauth/callback` — complete the OAuth2 authorization code flow.
///
/// Validates the state token, exchanges the code for tokens, fetches the
/// user profile, upserts the local account and connected-account record, and
/// issues a Myoxus session cookie.
pub async fn oauth_callback(
  State(state): State<ApiState>,
  headers: HeaderMap,
  Json(req): Json<OAuthCallbackRequest>,
) -> Result<Response, ApiError> {
  handle_oauth_callback(state, headers, req).await
}

/// `GET /api/oauth/callback` — same as `oauth_callback` but reads params from query string.
///
/// Some providers (e.g. Apple) use a `GET` redirect instead of a `POST` body.
pub async fn oauth_callback_get(
  State(state): State<ApiState>,
  headers: HeaderMap,
  Query(req): Query<OAuthCallbackRequest>,
) -> Result<Response, ApiError> {
  handle_oauth_callback(state, headers, req).await
}

/// `GET /api/oauth/callback` — provider browser handoff for the Myoxus app.
///
/// OAuth providers are registered against `/api/oauth/callback`. The browser
/// callback must land in the frontend `/oauth/callback` route so the shared
/// auth UI can complete the POST callback, close popup windows, and revalidate
/// sessions consistently.
pub async fn oauth_callback_frontend_redirect(
  State(state): State<ApiState>,
  Query(req): Query<OAuthCallbackRedirectRequest>,
) -> Redirect {
  let Some(code) = req.code else {
    return Redirect::temporary(&sign_in_error_redirect(
      req
        .error_description
        .or(req.error)
        .unwrap_or_else(|| "Invalid oauth callback parameters".to_string()),
    ));
  };
  let Some(state_token) = req.state else {
    return Redirect::temporary(&sign_in_error_redirect("Invalid oauth callback parameters"));
  };

  let payload = match load_oauth_state_payload(&state, &state_token).await {
    Ok(payload) => payload,
    Err(message) => return Redirect::temporary(&sign_in_error_redirect(message)),
  };

  if let Some(client) = payload.client.as_deref()
    && client != "web"
  {
    return Redirect::temporary(&open_app_oauth_redirect(
      client,
      &code,
      &state_token,
      &payload.provider,
      &state.config.server.origin,
    ));
  }

  Redirect::temporary(&format!(
    "/oauth/callback?code={}&state={}",
    urlencoding::encode(&code),
    urlencoding::encode(&state_token)
  ))
}

fn sign_in_error_redirect(message: impl AsRef<str>) -> String {
  format!("/sign-in?error={}", urlencoding::encode(message.as_ref()))
}

fn validate_oauth_redirect_target(redirect_uri: &str) -> Result<(), ApiError> {
  let trimmed = redirect_uri.trim();

  if trimmed.eq_ignore_ascii_case("CLOSE_POPUP") {
    return Ok(());
  }

  if trimmed.is_empty()
    || !trimmed.starts_with('/')
    || trimmed.starts_with("//")
    || trimmed.starts_with("/\\")
    || starts_with_encoded_slash(trimmed)
  {
    return Err(ApiError::BadRequest {
      name: "INVALID_REDIRECT_URI".into(),
      message: "redirect_uri must be a local relative path".into(),
      data: None,
    });
  }

  Ok(())
}

fn starts_with_encoded_slash(value: &str) -> bool {
  let lower = value.to_ascii_lowercase();
  lower.starts_with("/%2f") || lower.starts_with("/%5c")
}

async fn load_oauth_state_payload_api(state: &ApiState, state_token: &str) -> Result<OAuthStatePayload, ApiError> {
  let vt = state
    .auth()
    .get_oauth_state("OAuthState", state_token)
    .await
    .map_err(map_auth_error)?
    .ok_or_else(|| ApiError::BadRequest {
      name: "OAUTH_STATE_EXPIRED".into(),
      message: "Invalid or expired oauth state".into(),
      data: None,
    })?;

  vt.extra
    .clone()
    .ok_or_else(|| ApiError::BadRequest {
      name: "OAUTH_STATE_CORRUPT".into(),
      message: "OAuth state is missing its payload".into(),
      data: None,
    })
    .and_then(|v| {
      serde_json::from_value(v).map_err(|_| ApiError::BadRequest {
        name: "OAUTH_STATE_CORRUPT".into(),
        message: "OAuth state payload could not be decoded".into(),
        data: None,
      })
    })
}

async fn load_oauth_state_payload(state: &ApiState, state_token: &str) -> Result<OAuthStatePayload, String> {
  load_oauth_state_payload_api(state, state_token)
    .await
    .map_err(|e| match e {
      ApiError::BadRequest { message, .. } => message,
      _ => "Invalid oauth callback parameters".to_string(),
    })
}

fn is_supported_oauth_client(client: &str) -> bool {
  matches!(client, "myoxus" | "myoxus-beta" | "myoxus-internal" | "myoxus-dev")
}

fn open_app_oauth_redirect(client: &str, code: &str, state_token: &str, provider: &str, server_origin: &str) -> String {
  if !is_supported_oauth_client(client) {
    return sign_in_error_redirect("Invalid oauth callback parameters");
  }

  let payload = serde_json::json!({
    "state": state_token,
    "code": code,
    "provider": provider,
  });
  let mut auth_params = Vec::new();
  auth_params.push("method=oauth".to_string());
  auth_params.push(format!("payload={}", urlencoding::encode(&payload.to_string())));
  auth_params.push(format!("server={}", urlencoding::encode(server_origin)));

  let url_to_open = format!("{}://authentication?{}", client, auth_params.join("&"));

  format!("/open-app/url?url={}", urlencoding::encode(&url_to_open))
}

// Never format ApiError here: provider responses, URLs and repository errors can
// contain credentials or claim values. Only known codes cross the log boundary.
fn sso_error_reason(error: &ApiError) -> &'static str {
  let name = match error {
    ApiError::BadRequest { name, .. } | ApiError::Forbidden { name, .. } | ApiError::Unauthorized { name, .. } => {
      name.as_str()
    }
    ApiError::Internal(_) => return "internal_error",
    ApiError::ServiceUnavailable(_) => return "service_unavailable",
    _ => return "request_rejected",
  };
  match name {
    "OAUTH_STATE_EXPIRED" => "OAUTH_STATE_EXPIRED",
    "OAUTH_STATE_CORRUPT" => "OAUTH_STATE_CORRUPT",
    "INVALID_AUTH_STATE" => "INVALID_AUTH_STATE",
    "OIDC_ID_TOKEN_MISSING" => "OIDC_ID_TOKEN_MISSING",
    "OIDC_ID_TOKEN_INVALID" => "OIDC_ID_TOKEN_INVALID",
    "OIDC_ID_TOKEN_NONCE_INVALID" => "OIDC_ID_TOKEN_NONCE_INVALID",
    "OIDC_ID_TOKEN_ALGORITHM_REJECTED" => "OIDC_ID_TOKEN_ALGORITHM_REJECTED",
    "OIDC_DISCOVERY_ISSUER_MISMATCH" => "OIDC_DISCOVERY_ISSUER_MISMATCH",
    "OIDC_JWKS_MISSING" => "OIDC_JWKS_MISSING",
    "OIDC_ISSUER_MISSING" => "OIDC_ISSUER_MISSING",
    "OIDC_GROUPS_CLAIM_MISSING" => "OIDC_GROUPS_CLAIM_MISSING",
    "OIDC_GROUPS_UNMAPPED" => "OIDC_GROUPS_UNMAPPED",
    "OIDC_GROUP_MAPPING_INVALID" => "OIDC_GROUP_MAPPING_INVALID",
    "OIDC_GROUP_MAPPING_INACTIVE" => "OIDC_GROUP_MAPPING_INACTIVE",
    "USER_DISABLED" => "USER_DISABLED",
    "EMAIL_VERIFICATION_REQUIRED" => "EMAIL_VERIFICATION_REQUIRED",
    "SIGNUP_DISABLED" => "SIGNUP_DISABLED",
    "EMAIL_DOMAIN_INVALID" => "EMAIL_DOMAIN_INVALID",
    _ => "request_rejected",
  }
}

#[tracing::instrument(skip_all, fields(sso_operation_id = %uuid::Uuid::new_v4(), provider = tracing::field::Empty))]
async fn handle_oauth_callback(
  state: ApiState,
  headers: HeaderMap,
  req: OAuthCallbackRequest,
) -> Result<Response, ApiError> {
  let started = std::time::Instant::now();
  let mut phase = "state_validation";
  tracing::debug!(event = "sso.callback.started", "SSO callback started");
  let result = async {
    let payload = load_oauth_state_payload_api(&state, &req.state).await?;
    let provider_name = normalize_provider_name(&payload.provider);
    tracing::Span::current().record("provider", provider_name.as_str());
    phase = "provider_config";
    let provider = get_provider(&state, &provider_name).await?;
    phase = "client_nonce";

    if let Some(nonce) = &req.client_nonce {
      if nonce != &payload.client_nonce {
        return Err(ApiError::BadRequest {
          name: "INVALID_AUTH_STATE".into(),
          message: "Invalid client nonce".into(),
          data: None,
        });
      }
    } else if provider_name != "apple" {
      return Err(ApiError::BadRequest {
        name: "INVALID_AUTH_STATE".into(),
        message: "Missing client nonce".into(),
        data: None,
      });
    }

    phase = "token_exchange";
    let redirect_uri = format!("{}/api/oauth/callback", state.config.server.origin);
    let tokens = provider
      .get_token(&req.code, &redirect_uri, payload.pkce.as_ref())
      .await?;
    phase = "identity_claims";
    let external_user = provider.get_user(&state, &tokens, &payload.client_nonce).await?;
    phase = "group_policy";
    let group_mapping = provider.group_mapping();
    if let Some(mapping) = &group_mapping {
      oidc::validate_login_claims(external_user.groups.as_deref(), mapping)?;
    }
    phase = "account_policy";
    let require_verified_email = crate::auth::base::is_email_verification_required(&state).await;
    let external_email_verified = external_user.email_verified == Some(true);

    let connected = state
      .auth()
      .store
      .get_connected_account(&provider_name, &external_user.id)
      .await
      .map_err(map_auth_error)?;

    let mut user = match connected {
      Some(acc) => {
        let u = state
          .auth()
          .store
          .get_user_by_id(acc.user_id)
          .await
          .map_err(map_auth_error)?
          .ok_or_else(|| ApiError::Internal("User lost".into()))?;
        if u.disabled {
          tracing::warn!(
            user_id = %u.id,
            provider = %provider_name,
            "OAuth sign-in rejected for disabled linked user"
          );
          return Err(ApiError::Forbidden {
            name: "USER_DISABLED".into(),
            message: "User account is disabled".into(),
          });
        }
        if require_verified_email && !external_email_verified && u.email_verified_at.is_none() {
          return Err(ApiError::Forbidden {
            name: "EMAIL_VERIFICATION_REQUIRED".into(),
            message: "Verified e-mail is required for OAuth sign-in".into(),
          });
        }
        state
          .auth()
          .store
          .update_connected_account(
            acc.id,
            Some(tokens.access_token.clone()),
            tokens.refresh_token.clone(),
            tokens.expires_in.map(|s| Utc::now() + chrono::Duration::seconds(s)),
          )
          .await
          .map_err(map_auth_error)?;
        state.metrics().record(
          MetricsCategory::Auth,
          "user_signin",
          &[("method", "oauth"), ("provider", provider_name.as_str())],
        );
        u
      }
      None => {
        // Gate signup: if auth.allowSignup or auth.allowSignupForOauth is false,
        // reject new OAuth user creation (existing users can still log in).
        if !crate::auth::base::is_signup_allowed(&state).await
          || !crate::auth::base::is_signup_for_oauth_allowed(&state).await
        {
          return Err(ApiError::Forbidden {
            name: "SIGNUP_DISABLED".into(),
            message: "New user signup via OAuth is disabled".into(),
          });
        }

        // P42-B-01: Domain verification for new OAuth signups.
        if let Err(reason) = crate::auth::base::validate_email_domain_for_signup(&state, &external_user.email).await {
          return Err(ApiError::Forbidden {
            name: "EMAIL_DOMAIN_INVALID".into(),
            message: reason,
          });
        }

        if let Some(existing_user) = state
          .auth()
          .store
          .get_user_by_email(&external_user.email)
          .await
          .map_err(map_auth_error)?
        {
          if existing_user.disabled {
            tracing::warn!(
              user_id = %existing_user.id,
              provider = %provider_name,
              "OAuth sign-in rejected for disabled same-email user"
            );
            return Err(ApiError::Forbidden {
              name: "USER_DISABLED".into(),
              message: "User account is disabled".into(),
            });
          }
          if require_verified_email && !external_email_verified && existing_user.email_verified_at.is_none() {
            return Err(ApiError::Forbidden {
              name: "EMAIL_VERIFICATION_REQUIRED".into(),
              message: "Verified e-mail is required for OAuth sign-in".into(),
            });
          }
        } else if require_verified_email && !external_email_verified {
          return Err(ApiError::Forbidden {
            name: "EMAIL_VERIFICATION_REQUIRED".into(),
            message: "Verified e-mail is required for OAuth sign-up".into(),
          });
        }

        let user = state
          .auth()
          .store
          .fulfill_user(
            &external_user.email,
            external_user.name.as_deref(),
            external_user.avatar_url.as_deref(),
          )
          .await
          .map_err(map_auth_error)?;
        state
          .auth()
          .store
          .create_connected_account(myoxus_application::auth::NewConnectedAccount {
            user_id: user.id,
            provider: provider_name.clone(),
            provider_account_id: external_user.id.clone(),
            access_token: Some(tokens.access_token.clone()),
            refresh_token: tokens.refresh_token.clone(),
            expires_at: tokens.expires_in.map(|s| Utc::now() + chrono::Duration::seconds(s)),
          })
          .await
          .map_err(map_auth_error)?;
        if user.disabled {
          return Err(ApiError::Forbidden {
            name: "USER_DISABLED".into(),
            message: "User account is disabled".into(),
          });
        }
        state.metrics().record(
          MetricsCategory::Auth,
          "user_signup",
          &[("method", "oauth"), ("provider", provider_name.as_str())],
        );
        user
      }
    };

    if external_user.email_verified == Some(true) && user.email_verified_at.is_none() {
      state
        .auth()
        .store
        .set_email_verified(user.id, Utc::now())
        .await
        .map_err(map_auth_error)?;
      user.email_verified_at = Some(Utc::now());
    }

    phase = "group_reconciliation";
    if let Some(mapping) = group_mapping {
      oidc::reconcile_group_memberships(
        &state,
        &provider_name,
        &external_user.id,
        user.id,
        external_user.groups.as_deref(),
        &mapping,
      )
      .await?;
    }

    // Provision a personal workspace for the user if they don't have one yet
    // (INV-WS-01).  This is idempotent: existing users are unaffected.  We
    // call it for BOTH new and returning OAuth users because an invited user's
    // stub account may not have a workspace yet if they are signing in for the
    // first time after an email invite.
    if let Err(_err) = state
      .workspace()
      .ensure_personal_workspace(user.id, user.name.as_deref())
      .await
    {
      // Workspace provisioning failure is non-fatal for the sign-in flow itself,
      // but it breaks INV-WS-01.  Log at error level so it is immediately visible
      // in monitoring without blocking the user from signing in.
      tracing::error!(
        user_id = %user.id,
        reason = "workspace_provisioning_failed",
        "oauth_callback: failed to provision personal workspace — user may see empty workspace list (INV-WS-01 broken)"
      );
    }

    phase = "session_creation";
    let context = SessionContext {
      user_agent: header_to_string(&headers, USER_AGENT),
      ip_address: x_forwarded_for(&headers),
    };
    let session = state
      .auth()
      .create_user_session(user.id, context)
      .await
      .map_err(map_auth_error)?;

    let redirect_uri = payload.redirect_uri.clone();
    let mut response = Json(OAuthCallbackResponse {
      user: SessionUserResponse::from(user),
      redirect_uri,
    })
    .into_response();
    add_session_cookies(response.headers_mut(), &state, session.user_id, &session);

    if state.auth().consume_oauth_state(&req.state).await.is_err() {
      tracing::warn!(
        event = "sso.state_cleanup.failed",
        reason = "state_store_failure",
        "OAuth state cleanup failed"
      );
    }

    Ok(response)
  }
  .await;
  let duration_ms = started.elapsed().as_millis() as u64;
  match &result {
    Ok(_) => tracing::info!(
      event = "sso.callback.completed",
      outcome = "success",
      duration_ms,
      "SSO login completed"
    ),
    Err(error) => tracing::warn!(
      event = "sso.callback.failed",
      outcome = "failed",
      phase,
      reason = sso_error_reason(error),
      duration_ms,
      "SSO login failed"
    ),
  }
  result
}

/// Instantiate the [`OAuthProvider`] for the given normalized provider name.
///
/// Reads the provider from the shared effective configuration snapshot and
/// returns `400 Bad Request` for unknown or unconfigured providers.
async fn get_provider(state: &ApiState, name: &str) -> Result<Box<dyn OAuthProvider>, ApiError> {
  let normalized = normalize_provider_name(name);
  let origin = state.config.server.origin.clone();
  // P84-D-01: Clone the shared HTTP client once and pass it to all providers.
  let http_client = state.http_client().clone();
  let trust_snapshot_id = myoxus_infrastructure::tls::snapshot_id(state.config.additional_ca.as_ref()).to_owned();

  let db_config = state
    .effective_config()
    .await
    .value(&format!("oauth.providers.{normalized}"))
    .filter(|value| !value.is_null());

  if let Some(db_config) = db_config {
    tracing::debug!(provider = %normalized, "using effective OAuth provider configuration");
    let provider_config =
      myoxus_contracts::oauth_config::decode_oauth_provider_named(&normalized, db_config).map_err(|error| {
        ApiError::BadRequest {
          name: "INVALID_INPUT".into(),
          message: format!("Invalid OAuth DB config for provider '{normalized}': {error}"),
          data: None,
        }
      })?;
    match normalized.as_str() {
      "google" => {
        let myoxus_contracts::oauth_config::OAuthProviderConfig::Simple(config) = provider_config else {
          return Err(ApiError::BadRequest {
            name: "INVALID_INPUT".into(),
            message: "Google OAuth configuration has the wrong provider shape".into(),
            data: None,
          });
        };
        return Ok(Box::new(GoogleProvider::new(
          config.client_id,
          config.client_secret,
          origin,
          http_client,
          trust_snapshot_id,
        )));
      }
      "github" => {
        let myoxus_contracts::oauth_config::OAuthProviderConfig::Simple(config) = provider_config else {
          return Err(ApiError::BadRequest {
            name: "INVALID_INPUT".into(),
            message: "GitHub OAuth configuration has the wrong provider shape".into(),
            data: None,
          });
        };
        return Ok(Box::new(GitHubProvider::new(
          config.client_id,
          config.client_secret,
          origin,
          http_client,
          trust_snapshot_id,
        )));
      }
      _ => {
        let myoxus_contracts::oauth_config::OAuthProviderConfig::Custom(custom_config) = provider_config else {
          return Err(ApiError::BadRequest {
            name: "INVALID_INPUT".into(),
            message: format!("OAuth provider '{normalized}' requires a complete custom-provider configuration"),
            data: None,
          });
        };
        return Ok(Box::new(GenericOAuthProvider::new(
          normalized,
          custom_config,
          http_client,
          trust_snapshot_id,
        )?));
      }
    }
  }

  // --- 2. Fall back to the startup source stack. Named provider objects and
  // the older top-level Google/GitHub credential fields retain their distinct
  // runtime implementations.
  match normalized.as_str() {
    "google" => {
      let (id, secret) = state
        .config
        .oauth
        .built_in_provider_credentials(&normalized)
        .ok_or_else(|| ApiError::BadRequest {
          name: "INVALID_INPUT".into(),
          message: "Google OAuth not configured".into(),
          data: None,
        })?;
      Ok(Box::new(GoogleProvider::new(
        id.to_string(),
        secret.to_string(),
        origin,
        http_client,
        trust_snapshot_id,
      )))
    }
    "github" => {
      let (id, secret) = state
        .config
        .oauth
        .built_in_provider_credentials(&normalized)
        .ok_or_else(|| ApiError::BadRequest {
          name: "INVALID_INPUT".into(),
          message: "GitHub OAuth not configured".into(),
          data: None,
        })?;
      Ok(Box::new(GitHubProvider::new(
        id.to_string(),
        secret.to_string(),
        origin,
        http_client,
        trust_snapshot_id,
      )))
    }
    _ => {
      let provider = state
        .config
        .oauth
        .custom_provider(&normalized)
        .cloned()
        .ok_or_else(|| ApiError::BadRequest {
          name: "INVALID_INPUT".into(),
          message: format!("Unknown provider: {name}"),
          data: None,
        })?;
      Ok(Box::new(GenericOAuthProvider::new(
        normalized,
        provider,
        http_client,
        trust_snapshot_id,
      )?))
    }
  }
}

/// Validate a runtime provider through the exact construction path used by
/// OAuth sign-in. Missing or malformed configuration is unavailable; storage
/// failures remain errors for structured setup diagnostics.
pub(crate) async fn is_provider_usable_runtime(state: &ApiState, name: &str) -> Result<bool, ApiError> {
  match get_provider(state, name).await {
    Ok(_) => Ok(true),
    Err(ApiError::BadRequest { name, .. }) if name == "INVALID_INPUT" => Ok(false),
    Err(error) => Err(error),
  }
}

/// Normalize an OAuth provider name to a canonical lowercase identifier.
///
/// Aliases like `"git_hub"` → `"github"` and `"openidconnect"` → `"oidc"` are
/// collapsed so that config lookups are deterministic.
fn normalize_provider_name(name: &str) -> String {
  let value = name.trim().to_ascii_lowercase();
  match value.as_str() {
    "google" => "google".to_string(),
    "github" | "git_hub" => "github".to_string(),
    "apple" => "apple".to_string(),
    "oidc" | "openid" | "openidconnect" | "open_id_connect" => "oidc".to_string(),
    _ => value,
  }
}

#[cfg(test)]
mod tests {
  use super::validate_oauth_redirect_target;

  #[test]
  fn oauth_redirect_target_accepts_local_paths_and_popup_close() {
    assert!(validate_oauth_redirect_target("/adminfrontend").is_ok());
    assert!(validate_oauth_redirect_target("/workspace/1?mode=doc#b1").is_ok());
    assert!(validate_oauth_redirect_target("CLOSE_POPUP").is_ok());
  }

  #[test]
  fn oauth_redirect_target_rejects_external_targets() {
    assert!(validate_oauth_redirect_target("https://example.invalid").is_err());
    assert!(validate_oauth_redirect_target("//example.invalid").is_err());
    assert!(validate_oauth_redirect_target("/%2f%2fexample.invalid").is_err());
    assert!(validate_oauth_redirect_target("javascript:alert(1)").is_err());
    assert!(validate_oauth_redirect_target("").is_err());
  }
}
