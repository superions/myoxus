// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared, transport-neutral OAuth provider configuration.
//!
//! Provider objects cross startup YAML, environment, PostgreSQL and API
//! boundaries. This module keeps their spelling and structural validation
//! identical without moving API startup configuration or OAuth behavior into
//! Contracts.

use std::fmt;

use serde::{Deserialize, Serialize, de::DeserializeOwned};

/// Credentials used by providers whose endpoints and claim contract are fixed
/// by the built-in Google or GitHub implementation.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OAuthSimpleProviderConfig {
  #[serde(alias = "client_id")]
  pub client_id: String,
  #[serde(alias = "client_secret")]
  pub client_secret: String,
}

/// Configurable OIDC claim names used by a generic OAuth provider.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OAuthClaimsConfig {
  /// Provider subject claim. Falls back to the legacy `userIdField`.
  pub subject: Option<String>,
  /// Provider e-mail claim. Falls back to the legacy `userEmailField`.
  pub email: Option<String>,
  /// Provider e-mail verification claim.
  #[serde(alias = "email_verified")]
  pub email_verified: Option<String>,
  /// Provider display-name claim. Falls back to the legacy `userNameField`.
  pub name: Option<String>,
  /// Provider avatar/picture claim. Falls back to the legacy `userAvatarField`.
  pub avatar: Option<String>,
  /// Provider group-list claim. Defaults to `groups` when mapping is enabled.
  pub groups: Option<String>,
  /// Authoritative claim source for group mapping.
  #[serde(default, alias = "groups_source")]
  pub groups_source: Option<String>,
}

/// Policy for a missing group claim while OIDC group mapping is enabled.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OAuthMissingGroupsPolicy {
  /// Reject login instead of silently dropping mapped memberships.
  DenyLogin,
  /// Allow login without reconciling OIDC-sourced memberships.
  AllowWithoutMemberships,
}

impl Default for OAuthMissingGroupsPolicy {
  fn default() -> Self {
    Self::DenyLogin
  }
}

/// Policy for provider groups without a configured organization-unit mapping.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OAuthUnknownGroupsPolicy {
  /// Ignore groups that have no explicit mapping.
  Ignore,
  /// Reject login when any provider group is unmapped.
  DenyLogin,
}

impl Default for OAuthUnknownGroupsPolicy {
  fn default() -> Self {
    Self::Ignore
  }
}

fn default_oauth_group_mapping_role() -> String {
  "member".to_string()
}

fn default_remove_missing_oidc_memberships() -> bool {
  true
}

/// One explicit IdP-group to organization-unit mapping rule.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OAuthGroupMappingRuleConfig {
  /// Exact provider group value emitted by the configured groups claim.
  #[serde(alias = "provider_group")]
  pub provider_group: String,
  /// Authoritative target organization-unit UUID.
  #[serde(alias = "target_unit_id")]
  pub target_unit_id: String,
  /// Optional role override; otherwise the mapping default applies.
  pub role: Option<String>,
}

/// OIDC group-to-organization-unit reconciliation policy.
///
/// These values describe provider claims and requested mappings; they grant no
/// permission by themselves. The application-owned reconciliation service
/// still validates roles and mutates only OIDC-sourced memberships, preserving
/// manual and other externally managed memberships.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OAuthGroupMappingConfig {
  #[serde(default)]
  pub enabled: bool,
  #[serde(default = "default_oauth_group_mapping_role", alias = "default_role")]
  pub default_role: String,
  #[serde(
    default = "default_remove_missing_oidc_memberships",
    alias = "remove_missing_oidc_memberships"
  )]
  pub remove_missing_oidc_memberships: bool,
  #[serde(default, alias = "missing_groups_policy")]
  pub missing_groups_policy: OAuthMissingGroupsPolicy,
  #[serde(default, alias = "unknown_groups")]
  pub unknown_groups: OAuthUnknownGroupsPolicy,
  #[serde(default)]
  pub mappings: Vec<OAuthGroupMappingRuleConfig>,
}

impl Default for OAuthGroupMappingConfig {
  fn default() -> Self {
    Self {
      enabled: false,
      default_role: default_oauth_group_mapping_role(),
      remove_missing_oidc_memberships: default_remove_missing_oidc_memberships(),
      missing_groups_policy: OAuthMissingGroupsPolicy::default(),
      unknown_groups: OAuthUnknownGroupsPolicy::default(),
      mappings: Vec::new(),
    }
  }
}

/// Optional read connection, separate from the credentials used for login.
/// Catalog reads never participate in login or membership reconciliation.
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum OAuthGroupDirectoryConfig {
  Authentik {
    #[serde(rename = "baseUrl", alias = "base_url")]
    base_url: String,
    token: String,
  },
  Keycloak {
    #[serde(rename = "baseUrl", alias = "base_url")]
    base_url: String,
    realm: String,
    #[serde(rename = "clientId", alias = "client_id")]
    client_id: String,
    #[serde(rename = "clientSecret", alias = "client_secret")]
    client_secret: String,
    #[serde(rename = "claimValueMode", alias = "claim_value_mode")]
    claim_value_mode: OAuthDirectoryClaimValueMode,
  },
}

/// Must match the Keycloak Group Membership mapper's Full group path setting.
/// No default: choosing names versus paths changes persisted mapping identities.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OAuthDirectoryClaimValueMode {
  Name,
  Path,
}

impl fmt::Debug for OAuthGroupDirectoryConfig {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    // Configuration can be inspected before validation; even a rejected URL
    // could contain credentials. Do not Debug-format either input here.
    match self {
      Self::Authentik { .. } => formatter.debug_struct("Authentik").finish_non_exhaustive(),
      Self::Keycloak { .. } => formatter.debug_struct("Keycloak").finish_non_exhaustive(),
    }
  }
}

impl OAuthGroupDirectoryConfig {
  /// Validate before request construction, including for typed port callers.
  pub fn validate(&self) -> Result<(), OAuthProviderConfigError> {
    let base_url = match self {
      Self::Authentik { base_url, .. } | Self::Keycloak { base_url, .. } => base_url,
    };
    let url =
      parse_safe_oidc_config_url(base_url).map_err(|error| field_error(format!("groupDirectory.baseUrl: {error}")))?;
    if url.query().is_some() || url.fragment().is_some() {
      return Err(field_error(
        "groupDirectory.baseUrl must not contain a query or fragment",
      ));
    }
    match self {
      Self::Authentik { token, .. } => {
        if token.trim().is_empty() || token.chars().any(char::is_control) {
          return Err(field_error(
            "groupDirectory.token must be nonempty without control characters",
          ));
        }
      }
      Self::Keycloak {
        realm,
        client_id,
        client_secret,
        ..
      } => {
        for (field, value) in [
          ("realm", realm),
          ("clientId", client_id),
          ("clientSecret", client_secret),
        ] {
          if value.trim().is_empty() || value.chars().any(char::is_control) {
            return Err(field_error(format!(
              "groupDirectory.{field} must be nonempty without control characters"
            )));
          }
        }
        if matches!(realm.as_str(), "." | "..") {
          return Err(field_error("groupDirectory.realm must not be a dot path segment"));
        }
      }
    }
    Ok(())
  }
}

/// Complete configuration for a named OAuth/OIDC provider.
///
/// External objects serialize with camelCase. Explicit snake_case aliases are
/// accepted for deployed overlays, but Serde rejects a source containing both
/// spellings as a duplicate field. Unknown fields are rejected at every typed
/// nested boundary; strings and provider-owned map values are never folded.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OAuthCustomProviderConfig {
  #[serde(alias = "client_id")]
  pub client_id: String,
  #[serde(alias = "client_secret")]
  pub client_secret: String,
  #[serde(default, alias = "issuer_url", skip_serializing_if = "Option::is_none")]
  pub issuer_url: Option<String>,
  #[serde(default, alias = "discovery_url", skip_serializing_if = "Option::is_none")]
  pub discovery_url: Option<String>,
  #[serde(default, alias = "auth_url", skip_serializing_if = "String::is_empty")]
  pub auth_url: String,
  #[serde(default, alias = "token_url", skip_serializing_if = "String::is_empty")]
  pub token_url: String,
  #[serde(default, alias = "userinfo_url", skip_serializing_if = "String::is_empty")]
  pub userinfo_url: String,
  #[serde(default, alias = "jwks_url", skip_serializing_if = "Option::is_none")]
  pub jwks_url: Option<String>,
  #[serde(default = "default_oauth_scopes", skip_serializing_if = "is_default_oauth_scopes")]
  pub scopes: Vec<String>,
  #[serde(default, skip_serializing_if = "OAuthClaimsConfig::is_empty")]
  pub claims: OAuthClaimsConfig,
  #[serde(
    default,
    alias = "group_mapping",
    skip_serializing_if = "OAuthGroupMappingConfig::is_default"
  )]
  pub group_mapping: OAuthGroupMappingConfig,
  #[serde(default, alias = "group_directory", skip_serializing_if = "Option::is_none")]
  pub group_directory: Option<OAuthGroupDirectoryConfig>,
  #[serde(
    default = "default_user_id_field",
    alias = "user_id_field",
    skip_serializing_if = "is_default_user_id_field"
  )]
  pub user_id_field: String,
  #[serde(
    default = "default_user_email_field",
    alias = "user_email_field",
    skip_serializing_if = "is_default_user_email_field"
  )]
  pub user_email_field: String,
  #[serde(
    default = "default_user_name_field",
    alias = "user_name_field",
    skip_serializing_if = "is_default_user_name_field"
  )]
  pub user_name_field: String,
  #[serde(
    default = "default_user_avatar_field",
    alias = "user_avatar_field",
    skip_serializing_if = "is_default_user_avatar_field"
  )]
  pub user_avatar_field: String,
}

impl From<OAuthSimpleProviderConfig> for OAuthCustomProviderConfig {
  fn from(provider: OAuthSimpleProviderConfig) -> Self {
    Self {
      client_id: provider.client_id,
      client_secret: provider.client_secret,
      issuer_url: None,
      discovery_url: None,
      auth_url: String::new(),
      token_url: String::new(),
      userinfo_url: String::new(),
      jwks_url: None,
      scopes: default_oauth_scopes(),
      claims: OAuthClaimsConfig::default(),
      group_mapping: OAuthGroupMappingConfig::default(),
      group_directory: None,
      user_id_field: default_user_id_field(),
      user_email_field: default_user_email_field(),
      user_name_field: default_user_name_field(),
      user_avatar_field: default_user_avatar_field(),
    }
  }
}

/// Provider shape retained by the API startup snapshot.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum OAuthProviderConfig {
  Simple(OAuthSimpleProviderConfig),
  Custom(OAuthCustomProviderConfig),
}

fn default_oauth_scopes() -> Vec<String> {
  vec!["openid".to_string(), "profile".to_string(), "email".to_string()]
}

fn is_default_oauth_scopes(value: &Vec<String>) -> bool {
  value == &default_oauth_scopes()
}

impl OAuthClaimsConfig {
  fn is_empty(&self) -> bool {
    self == &Self::default()
  }
}

impl OAuthGroupMappingConfig {
  fn is_default(&self) -> bool {
    self == &Self::default()
  }
}

fn default_user_id_field() -> String {
  "sub".to_string()
}

fn default_user_email_field() -> String {
  "email".to_string()
}

fn default_user_name_field() -> String {
  "name".to_string()
}

fn default_user_avatar_field() -> String {
  "picture".to_string()
}

fn is_default_user_id_field(value: &str) -> bool {
  value == "sub"
}

fn is_default_user_email_field(value: &str) -> bool {
  value == "email"
}

fn is_default_user_name_field(value: &str) -> bool {
  value == "name"
}

fn is_default_user_avatar_field(value: &str) -> bool {
  value == "picture"
}

/// Sanitized provider-structure failure suitable for transport diagnostics.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct OAuthProviderConfigError {
  message: String,
}

impl OAuthProviderConfigError {
  /// Structural field diagnostic without the rejected source payload.
  pub fn message(&self) -> &str {
    &self.message
  }
}

impl fmt::Display for OAuthProviderConfigError {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(&self.message)
  }
}

impl std::error::Error for OAuthProviderConfigError {}

/// URL policy for directory connections and the Admin OIDC diagnostic only.
/// Existing login endpoint URLs retain their own deployed validation contract.
/// Rejected inputs are never included in errors.
pub fn parse_safe_oidc_config_url(raw_url: &str) -> Result<url::Url, OAuthProviderConfigError> {
  let url = url::Url::parse(raw_url).map_err(|_| field_error("invalid URL"))?;
  if !url.username().is_empty() || url.password().is_some() {
    return Err(field_error("URL credentials are not allowed"));
  }
  match url.scheme() {
    "https" => Ok(url),
    "http" => {
      let loopback = matches!(url.host(), Some(url::Host::Domain("localhost")))
        || matches!(url.host(), Some(url::Host::Ipv4(address)) if address == std::net::Ipv4Addr::LOCALHOST)
        || matches!(url.host(), Some(url::Host::Ipv6(address)) if address == std::net::Ipv6Addr::LOCALHOST);
      if loopback {
        Ok(url)
      } else {
        Err(field_error(
          "only HTTPS URLs are allowed except localhost development endpoints",
        ))
      }
    }
    _ => Err(field_error("unsupported URL scheme")),
  }
}

/// Decode one complete provider through the shared strict field contract.
pub fn decode_oauth_provider(value: serde_json::Value) -> Result<OAuthCustomProviderConfig, OAuthProviderConfigError> {
  let value = normalize_oauth_provider_source_layer(value)?;
  let object = value
    .as_object()
    .ok_or_else(|| field_error("provider must be an object"))?;
  for (canonical, alias) in [
    ("clientId", "client_id"),
    ("clientSecret", "client_secret"),
    ("authUrl", "auth_url"),
    ("tokenUrl", "token_url"),
    ("userinfoUrl", "userinfo_url"),
  ] {
    if !object.contains_key(canonical) && !object.contains_key(alias) {
      return Err(field_error(format!("missing field `{canonical}`")));
    }
  }
  let provider: OAuthCustomProviderConfig = deserialize_provider(value)?;
  if let Some(directory) = &provider.group_directory {
    directory.validate()?;
  }
  Ok(provider)
}

/// Decode a provider using the shape owned by its runtime implementation.
pub fn decode_oauth_provider_named(
  provider_name: &str,
  value: serde_json::Value,
) -> Result<OAuthProviderConfig, OAuthProviderConfigError> {
  if matches!(provider_name.to_ascii_lowercase().as_str(), "google" | "github") {
    let value = normalize_oauth_provider_source_layer_named(provider_name, value)?;
    deserialize_provider(value).map(OAuthProviderConfig::Simple)
  } else {
    decode_oauth_provider(value).map(OAuthProviderConfig::Custom)
  }
}

/// Normalize an accepted provider object to its canonical camelCase spelling.
///
/// Call this independently for every source layer before precedence merging.
/// That permits a higher-precedence alias to replace a lower-precedence
/// canonical field while duplicate spellings within one layer remain errors.
pub fn normalize_oauth_provider(value: serde_json::Value) -> Result<serde_json::Value, OAuthProviderConfigError> {
  let provider = decode_oauth_provider(value)?;
  serde_json::to_value(provider).map_err(|error| OAuthProviderConfigError {
    message: error.to_string(),
  })
}

/// Canonicalize the fields present in one provider source layer.
///
/// Source layers may intentionally be partial because `config` merges them by
/// precedence. Required fields are therefore checked only after merging, while
/// aliases, duplicates, unknown fields and nested spelling are checked here so
/// two spellings cannot become independent merge keys.
pub fn normalize_oauth_provider_source_layer(
  value: serde_json::Value,
) -> Result<serde_json::Value, OAuthProviderConfigError> {
  let value = normalize_object(
    value,
    "provider",
    &[
      ("clientId", "client_id"),
      ("clientSecret", "client_secret"),
      ("issuerUrl", "issuer_url"),
      ("discoveryUrl", "discovery_url"),
      ("authUrl", "auth_url"),
      ("tokenUrl", "token_url"),
      ("userinfoUrl", "userinfo_url"),
      ("jwksUrl", "jwks_url"),
      ("scopes", "scopes"),
      ("claims", "claims"),
      ("groupMapping", "group_mapping"),
      ("groupDirectory", "group_directory"),
      ("userIdField", "user_id_field"),
      ("userEmailField", "user_email_field"),
      ("userNameField", "user_name_field"),
      ("userAvatarField", "user_avatar_field"),
    ],
  )?;
  let mut object = value.as_object().cloned().expect("normalize_object returns an object");
  if let Some(directory) = object.get_mut("groupDirectory") {
    // Each source may contain only a token or URL override. Type and required
    // fields are validated by the complete decoder after precedence merging.
    // Explicit null removes the optional connection rather than an empty map.
    if !directory.is_null() {
      *directory = normalize_object(
        directory.take(),
        "groupDirectory",
        &[
          ("type", "type"),
          ("baseUrl", "base_url"),
          ("token", "token"),
          ("realm", "realm"),
          ("clientId", "client_id"),
          ("clientSecret", "client_secret"),
          ("claimValueMode", "claim_value_mode"),
        ],
      )?;
    }
  }
  if let Some(claims) = object.remove("claims") {
    object.insert(
      "claims".to_string(),
      normalize_object(
        claims,
        "claims",
        &[
          ("subject", "subject"),
          ("email", "email"),
          ("emailVerified", "email_verified"),
          ("name", "name"),
          ("avatar", "avatar"),
          ("groups", "groups"),
          ("groupsSource", "groups_source"),
        ],
      )?,
    );
  }
  if let Some(mapping) = object.remove("groupMapping") {
    let mapping = normalize_object(
      mapping,
      "groupMapping",
      &[
        ("enabled", "enabled"),
        ("defaultRole", "default_role"),
        ("removeMissingOidcMemberships", "remove_missing_oidc_memberships"),
        ("missingGroupsPolicy", "missing_groups_policy"),
        ("unknownGroups", "unknown_groups"),
        ("mappings", "mappings"),
      ],
    )?;
    let mut mapping = mapping
      .as_object()
      .cloned()
      .expect("normalize_object returns an object");
    if let Some(rules) = mapping.remove("mappings") {
      let rules = rules
        .as_array()
        .ok_or_else(|| field_error("groupMapping.mappings must be an array"))?;
      let normalized = rules
        .iter()
        .cloned()
        .map(|rule| {
          normalize_object(
            rule,
            "groupMapping.mappings[]",
            &[
              ("providerGroup", "provider_group"),
              ("targetUnitId", "target_unit_id"),
              ("role", "role"),
            ],
          )
        })
        .collect::<Result<Vec<_>, _>>()?;
      mapping.insert("mappings".to_string(), serde_json::Value::Array(normalized));
    }
    object.insert("groupMapping".to_string(), serde_json::Value::Object(mapping));
  }
  Ok(serde_json::Value::Object(object))
}

/// Canonicalize the partial source-layer shape owned by a named provider.
pub fn normalize_oauth_provider_source_layer_named(
  provider_name: &str,
  value: serde_json::Value,
) -> Result<serde_json::Value, OAuthProviderConfigError> {
  if matches!(provider_name.to_ascii_lowercase().as_str(), "google" | "github") {
    normalize_object(
      value,
      "provider",
      &[("clientId", "client_id"), ("clientSecret", "client_secret")],
    )
  } else {
    normalize_oauth_provider_source_layer(value)
  }
}

fn normalize_object(
  value: serde_json::Value,
  path: &str,
  fields: &[(&str, &str)],
) -> Result<serde_json::Value, OAuthProviderConfigError> {
  let object = value
    .as_object()
    .ok_or_else(|| field_error(format!("{path} must be an object")))?;
  let mut normalized = serde_json::Map::new();
  for (field, value) in object {
    let Some((canonical, _)) = fields
      .iter()
      .find(|(canonical, alias)| field == canonical || field == alias)
    else {
      return Err(field_error(format!("unknown field `{path}.{field}`")));
    };
    if normalized.insert((*canonical).to_string(), value.clone()).is_some() {
      return Err(field_error(format!("duplicate field `{path}.{canonical}`")));
    }
  }
  Ok(serde_json::Value::Object(normalized))
}

fn field_error(message: impl Into<String>) -> OAuthProviderConfigError {
  OAuthProviderConfigError {
    message: message.into(),
  }
}

fn deserialize_provider<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, OAuthProviderConfigError> {
  let bytes = serde_json::to_vec(&value).map_err(|_| field_error("provider could not be decoded"))?;
  let mut deserializer = serde_json::Deserializer::from_slice(&bytes);
  serde_path_to_error::deserialize(&mut deserializer).map_err(|error| {
    let path = error.path().to_string();
    if path.is_empty() || path == "." {
      field_error("invalid provider field type or value")
    } else {
      field_error(format!("invalid field `{path}` type or value"))
    }
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn provider() -> serde_json::Value {
    serde_json::json!({
      "clientId": "CaseSensitiveClient",
      "clientSecret": "secret",
      "authUrl": "https://idp.example/authorize",
      "tokenUrl": "https://idp.example/token",
      "userinfoUrl": "https://idp.example/userinfo",
      "claims": { "emailVerified": "EmailVerified", "groupsSource": "id_token" },
      "groupMapping": {
        "defaultRole": "manager",
        "mappings": [{
          "providerGroup": "Engineering/Admins",
          "targetUnitId": "00000000-0000-0000-0000-000000000001",
          "role": "reader"
        }]
      }
    })
  }

  #[test]
  fn canonical_and_deployed_aliases_decode_to_the_same_provider() {
    let mut value = provider();
    value["groupDirectory"] =
      serde_json::json!({"type":"authentik", "baseUrl":"https://idp.example/prefix", "token":"read-token"});
    let canonical = decode_oauth_provider(value).unwrap();
    let snake = decode_oauth_provider(serde_json::json!({
      "client_id": "CaseSensitiveClient",
      "client_secret": "secret",
      "auth_url": "https://idp.example/authorize",
      "token_url": "https://idp.example/token",
      "userinfo_url": "https://idp.example/userinfo",
      "group_directory": { "type": "authentik", "base_url": "https://idp.example/prefix", "token": "read-token" },
      "claims": { "email_verified": "EmailVerified", "groups_source": "id_token" },
      "group_mapping": {
        "default_role": "manager",
        "mappings": [{
          "provider_group": "Engineering/Admins",
          "target_unit_id": "00000000-0000-0000-0000-000000000001",
          "role": "reader"
        }]
      }
    }))
    .unwrap();

    assert_eq!(
      serde_json::to_value(canonical).unwrap(),
      serde_json::to_value(snake).unwrap()
    );
    for mode in ["name", "path"] {
      let mut canonical = provider();
      canonical["groupDirectory"] = serde_json::json!({
        "type":"keycloak", "baseUrl":"https://idp.example/prefix", "realm":"Tenant/Case", "clientId":"ReadClient",
        "clientSecret":"private-keycloak-marker", "claimValueMode":mode,
      });
      let mut alias = provider();
      alias["group_directory"] = serde_json::json!({
        "type":"keycloak", "base_url":"https://idp.example/prefix", "realm":"Tenant/Case", "client_id":"ReadClient",
        "client_secret":"private-keycloak-marker", "claim_value_mode":mode,
      });
      let decoded = decode_oauth_provider(alias).unwrap();
      assert!(!format!("{:?}", decoded.group_directory).contains("private-keycloak-marker"));
      assert_eq!(
        serde_json::to_value(decoded).unwrap()["groupDirectory"],
        canonical["groupDirectory"]
      );
      for (field, invalid) in [
        ("claimValueMode", serde_json::Value::Null),
        ("claimValueMode", serde_json::json!("auto")),
        ("realm", serde_json::json!("..")),
        ("clientSecret", serde_json::json!("")),
      ] {
        let mut value = canonical.clone();
        value["groupDirectory"][field] = invalid;
        let error = decode_oauth_provider(value).unwrap_err().to_string();
        assert!(!error.contains("private-keycloak-marker"));
      }
      let mut duplicate = canonical;
      duplicate["groupDirectory"]["client_secret"] = serde_json::json!("other");
      assert!(
        decode_oauth_provider(duplicate)
          .unwrap_err()
          .message()
          .contains("duplicate field")
      );
    }
  }

  #[test]
  fn aliases_are_canonicalized_without_folding_values() {
    let normalized = normalize_oauth_provider(provider()).unwrap();
    assert_eq!(normalized["clientId"], "CaseSensitiveClient");
    assert_eq!(normalized["claims"]["emailVerified"], "EmailVerified");
    assert_eq!(
      normalized["groupMapping"]["mappings"][0]["providerGroup"],
      "Engineering/Admins"
    );
    assert!(normalized.get("client_id").is_none());
    assert!(
      normalized.get("groupDirectory").is_none(),
      "omission must preserve the deployed serialized shape"
    );
  }

  #[test]
  fn duplicate_aliases_and_unknown_nested_fields_are_rejected() {
    let mut duplicate = provider();
    duplicate["client_id"] = serde_json::json!("duplicate");
    assert!(
      decode_oauth_provider(duplicate)
        .unwrap_err()
        .message()
        .contains("duplicate field")
    );

    let mut unknown = provider();
    unknown["claims"]["mailVerified"] = serde_json::json!("typo");
    assert!(
      decode_oauth_provider(unknown)
        .unwrap_err()
        .message()
        .contains("unknown field")
    );
    for directory in [
      serde_json::json!({"type":"authentik", "baseUrl":"https://idp.example", "base_url":"https://idp.example", "token":"read-token"}),
      serde_json::json!({"type":"authentik", "baseUrl":"https://idp.example", "token":"read-token", "unknown":"private-marker"}),
      serde_json::json!({"type":"keycloak", "baseUrl":"https://idp.example", "token":"read-token"}),
      serde_json::json!({"type":"authentik", "baseUrl":"https://idp.example"}),
    ] {
      let mut value = provider();
      value["groupDirectory"] = directory;
      assert!(decode_oauth_provider(value).is_err());
    }
  }

  #[test]
  fn directory_urls_require_safe_transport_without_echoing_rejected_credentials() {
    for base in [
      "https://idp.example/prefix",
      "http://localhost:9000/prefix",
      "http://127.0.0.1:9000",
      "http://[::1]:9000",
    ] {
      let mut value = provider();
      value["groupDirectory"] = serde_json::json!({"type":"authentik", "baseUrl":base, "token":"private-token-marker"});
      let decoded = decode_oauth_provider(value).unwrap();
      assert!(!format!("{:?}", decoded.group_directory).contains("private-token-marker"));
      assert_eq!(
        serde_json::to_value(decoded).unwrap()["groupDirectory"]["baseUrl"],
        base
      );
    }
    for base in [
      "http://idp.example",
      "file:///private-marker",
      "https://private-marker:password@idp.example",
      "https://idp.example/?token=private-marker",
      "https://idp.example/#private-marker",
    ] {
      let mut value = provider();
      value["groupDirectory"] = serde_json::json!({"type":"authentik", "baseUrl":base, "token":"private-token-marker"});
      let error = decode_oauth_provider(value).unwrap_err().to_string();
      assert!(!error.contains("private-marker") && !error.contains("private-token-marker"));
    }
    let mut value = provider();
    value["groupDirectory"] = serde_json::Value::Null;
    assert!(decode_oauth_provider(value).unwrap().group_directory.is_none());
  }

  #[test]
  fn named_provider_decoder_retains_runtime_specific_shapes() {
    for name in ["google", "GitHub"] {
      let simple_value = serde_json::json!({"client_id": "built-in-id", "client_secret": "secret"});
      let OAuthProviderConfig::Simple(simple) = decode_oauth_provider_named(name, simple_value).unwrap() else {
        panic!("{name} must keep the built-in credential shape");
      };
      assert_eq!(
        serde_json::to_value(OAuthCustomProviderConfig::from(simple)).unwrap(),
        serde_json::json!({"clientId": "built-in-id", "clientSecret": "secret"})
      );
    }
    for name in ["apple", "AcmeIdentity"] {
      assert!(matches!(
        decode_oauth_provider_named(name, provider()).unwrap(),
        OAuthProviderConfig::Custom(_)
      ));
    }
    assert!(
      decode_oauth_provider_named("github", provider())
        .unwrap_err()
        .message()
        .contains("unknown field")
    );
  }
}
