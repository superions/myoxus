//! OIDC-specific claim handling and organization-unit reconciliation.
//!
//! OAuth itself only proves that a provider authenticated a browser session.
//! OIDC adds identity claims such as `email_verified` and `groups`. Myoxus maps
//! those groups to organization units instead of granting global admin rights or
//! direct workspace roles, keeping IdP-managed access inside the existing OU
//! permission model. This module is intentionally separate from `oauth.rs` so
//! non-OIDC providers do not inherit OIDC policy branches.

use std::{collections::HashSet, sync::Arc};

use jsonwebtoken::{
  Algorithm, DecodingKey, Validation, decode, decode_header,
  jwk::{AlgorithmParameters, Jwk, JwkSet, KeyAlgorithm},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
  config::{
    OAuthClaimsConfig, OAuthCustomProviderConfig, OAuthGroupMappingConfig, OAuthMissingGroupsPolicy,
    OAuthUnknownGroupsPolicy,
  },
  error::ApiError,
  state::{ApiState, CacheLoadError},
};
use myoxus_application::organization::oidc_sync::normalize_group_name;
use myoxus_application::organization::{
  OidcGroupMapping, OidcGroupMappingRule, OidcGroupSyncAction, OidcGroupSyncError, OidcGroupSyncEvent,
  OidcGroupSyncInput, OidcGroupSyncService, OidcMissingGroupsPolicy, OidcUnknownGroupsPolicy,
};
use myoxus_domain::audit::{AuditActor, AuditCategory, AuditEvent, AuditTarget};
use myoxus_domain::entities::{OrganizationUnitMemberSource, OrganizationUnitRole};

const MAX_OIDC_GROUPS: usize = 512;

/// Subset of the OpenID Provider discovery document consumed by Myoxus.
///
/// The document is cached as public provider metadata only. It never contains
/// client credentials, user claims, access tokens, ID tokens or session data.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct OidcDiscoveryDocument {
  pub issuer: String,
  pub authorization_endpoint: Option<String>,
  pub token_endpoint: String,
  pub userinfo_endpoint: Option<String>,
  pub jwks_uri: String,
}

fn oidc_error(name: &str, message: &str) -> ApiError {
  ApiError::Forbidden {
    name: name.to_string(),
    message: message.to_string(),
  }
}

pub(crate) fn claim_value<'a>(root: &'a serde_json::Value, path: &str) -> &'a serde_json::Value {
  let mut current = root;
  for segment in path.split('.') {
    if segment.is_empty() {
      return &serde_json::Value::Null;
    }
    current = current.get(segment).unwrap_or(&serde_json::Value::Null);
  }
  current
}

pub(crate) fn string_claim(root: &serde_json::Value, path: &str) -> Option<String> {
  let value = claim_value(root, path);
  value
    .as_str()
    .map(|value| value.to_string())
    .or_else(|| value.as_i64().map(|value| value.to_string()))
}

pub(crate) fn bool_claim(root: &serde_json::Value, path: Option<&str>) -> Option<bool> {
  path.and_then(|field| claim_value(root, field).as_bool())
}

pub(crate) fn groups_claim(root: &serde_json::Value, path: Option<&str>) -> Option<Vec<String>> {
  let value = claim_value(root, path?);
  if value.is_null() {
    return None;
  }
  let collect_groups = |items: Vec<&str>| {
    let mut seen = HashSet::new();
    let groups = items
      .into_iter()
      .filter_map(normalize_group_name)
      .filter(|group| seen.insert(group.clone()))
      .take(MAX_OIDC_GROUPS)
      .collect::<Vec<_>>();
    Some(groups)
  };
  if let Some(items) = value.as_array() {
    return collect_groups(items.iter().filter_map(|item| item.as_str()).collect());
  }
  value.as_str().and_then(normalize_group_name).map(|item| vec![item])
}

#[tracing::instrument(skip_all, fields(metadata_kind = cache_kind))]
async fn fetch_json_cached(state: &ApiState, url: &str, cache_kind: &str) -> Result<serde_json::Value, ApiError> {
  let key = url.to_string();
  let client = state.http_client().clone();
  let cache = match cache_kind {
    "oidc_discovery" => state.query_cache.oidc_discovery.clone(),
    "oidc_jwks" => state.query_cache.oidc_jwks.clone(),
    _ => {
      return Err(ApiError::Internal(format!(
        "unsupported OIDC metadata cache kind: {cache_kind}"
      )));
    }
  };

  let value: Result<serde_json::Value, Arc<CacheLoadError>> = cache
    .try_get_with(key.clone(), async move {
      let response = client
        .get(&key)
        .send()
        .await
        .map_err(|e| CacheLoadError(http_error_reason(&e).into()))?;
      if !response.status().is_success() {
        return Err(CacheLoadError(format!(
          "http_rejected (HTTP {})",
          response.status().as_u16()
        )));
      }
      response
        .json::<serde_json::Value>()
        .await
        .map_err(|_| CacheLoadError("invalid_response".into()))
    })
    .await;

  value.map_err(|e| {
    let trust_snapshot_id = myoxus_infrastructure::tls::snapshot_id(state.config.additional_ca.as_ref());
    // CacheLoadError is created above only from fixed categories and numeric
    // HTTP status. Never put an arbitrary provider body or reqwest Display here.
    tracing::warn!(event = "sso.metadata.failed", phase = cache_kind, reason = %e, trust_snapshot_id, "OIDC metadata fetch failed");
    ApiError::Internal(format!("SSO {cache_kind} failed: {e}"))
  })
}

/// Load and validate the configured discovery document, if one is configured.
///
/// Discovery is intentionally optional so existing explicit endpoint configs
/// remain valid, but any configured discovery document becomes authoritative for
/// issuer/JWKS validation once the login reaches ID-token verification.
pub(crate) async fn discovery_document(
  state: &ApiState,
  config: &OAuthCustomProviderConfig,
) -> Result<Option<OidcDiscoveryDocument>, ApiError> {
  let Some(discovery_url) = config.discovery_url.as_deref().filter(|url| !url.trim().is_empty()) else {
    return Ok(None);
  };

  let value = fetch_json_cached(state, discovery_url, "oidc_discovery").await?;
  let document: OidcDiscoveryDocument = serde_json::from_value(value).map_err(|_| {
    tracing::warn!(
      event = "sso.metadata.failed",
      reason = "invalid_document_shape",
      phase = "oidc_discovery",
      trust_snapshot_id = myoxus_infrastructure::tls::snapshot_id(state.config.additional_ca.as_ref()),
      "OIDC discovery document shape is invalid"
    );
    ApiError::Internal("OIDC discovery document is invalid".into())
  })?;
  if let Some(expected_issuer) = config.issuer_url.as_deref()
    && document.issuer.trim_end_matches('/') != expected_issuer.trim_end_matches('/')
  {
    return Err(oidc_error(
      "OIDC_DISCOVERY_ISSUER_MISMATCH",
      "OIDC discovery issuer does not match configured issuer",
    ));
  }
  Ok(Some(document))
}

fn is_oidc_flow(config: &OAuthCustomProviderConfig) -> bool {
  config.scopes.iter().any(|scope| scope == "openid")
    || config.issuer_url.is_some()
    || config.discovery_url.is_some()
    || config.jwks_url.is_some()
}

fn allowed_id_token_algorithm(alg: Algorithm) -> bool {
  matches!(
    alg,
    Algorithm::RS256
      | Algorithm::RS384
      | Algorithm::RS512
      | Algorithm::PS256
      | Algorithm::PS384
      | Algorithm::PS512
      | Algorithm::ES256
      | Algorithm::ES384
      | Algorithm::EdDSA
  )
}

fn jwk_algorithm_matches(jwk: &Jwk, alg: Algorithm) -> bool {
  match jwk.common.key_algorithm {
    None => true,
    Some(KeyAlgorithm::RS256) => alg == Algorithm::RS256,
    Some(KeyAlgorithm::RS384) => alg == Algorithm::RS384,
    Some(KeyAlgorithm::RS512) => alg == Algorithm::RS512,
    Some(KeyAlgorithm::PS256) => alg == Algorithm::PS256,
    Some(KeyAlgorithm::PS384) => alg == Algorithm::PS384,
    Some(KeyAlgorithm::PS512) => alg == Algorithm::PS512,
    Some(KeyAlgorithm::ES256) => alg == Algorithm::ES256,
    Some(KeyAlgorithm::ES384) => alg == Algorithm::ES384,
    Some(KeyAlgorithm::EdDSA) => alg == Algorithm::EdDSA,
    _ => false,
  }
}

async fn jwks(
  state: &ApiState,
  config: &OAuthCustomProviderConfig,
  discovery: Option<&OidcDiscoveryDocument>,
) -> Result<JwkSet, ApiError> {
  let jwks_url = config
    .jwks_url
    .as_deref()
    .filter(|url| !url.trim().is_empty())
    .or_else(|| discovery.map(|document| document.jwks_uri.as_str()))
    .ok_or_else(|| oidc_error("OIDC_JWKS_MISSING", "OIDC provider JWKS URL is required"))?;
  let value = fetch_json_cached(state, jwks_url, "oidc_jwks").await?;
  serde_json::from_value(value).map_err(|_| {
    tracing::warn!(
      event = "sso.metadata.failed",
      reason = "invalid_document_shape",
      phase = "oidc_jwks",
      trust_snapshot_id = myoxus_infrastructure::tls::snapshot_id(state.config.additional_ca.as_ref()),
      "OIDC JWKS shape is invalid"
    );
    ApiError::Internal("OIDC JWKS document is invalid".into())
  })
}

/// Validate an OIDC ID Token and return its claims as the authoritative
/// identity anchor.
///
/// UserInfo can enrich profile data, but it cannot replace this validation:
/// the token signature, issuer, audience, expiry and nonce bind the provider
/// authentication result to the exact Myoxus OAuth preflight.
#[tracing::instrument(skip_all, fields(provider = provider_name))]
pub(crate) async fn validate_id_token(
  state: &ApiState,
  provider_name: &str,
  config: &OAuthCustomProviderConfig,
  id_token: Option<&str>,
  expected_nonce: &str,
) -> Result<Option<serde_json::Value>, ApiError> {
  if !is_oidc_flow(config) {
    return Ok(None);
  }

  let token = id_token.ok_or_else(|| {
    tracing::warn!(provider = %provider_name, "OIDC provider did not return an ID token");
    oidc_error("OIDC_ID_TOKEN_MISSING", "OIDC provider did not return an ID token")
  })?;
  let discovery = discovery_document(state, config).await?;
  let issuer = discovery
    .as_ref()
    .map(|document| document.issuer.as_str())
    .or(config.issuer_url.as_deref())
    .ok_or_else(|| oidc_error("OIDC_ISSUER_MISSING", "OIDC issuer is required for ID token validation"))?;

  let header = decode_header(token).map_err(|e| {
    tracing::warn!(provider = %provider_name, reason = jwt_error_reason(&e), "OIDC ID token header decode failed");
    oidc_error("OIDC_ID_TOKEN_INVALID", "OIDC ID token could not be decoded")
  })?;
  if !allowed_id_token_algorithm(header.alg) {
    tracing::warn!(provider = %provider_name, algorithm = ?header.alg, "OIDC ID token algorithm is not accepted");
    return Err(oidc_error(
      "OIDC_ID_TOKEN_ALGORITHM_REJECTED",
      "OIDC ID token algorithm is not accepted",
    ));
  }
  let kid = header.kid.as_deref().ok_or_else(|| {
    tracing::warn!(provider = %provider_name, "OIDC ID token header is missing kid");
    oidc_error("OIDC_ID_TOKEN_INVALID", "OIDC ID token key id is missing")
  })?;
  let jwks = jwks(state, config, discovery.as_ref()).await?;
  let jwk = jwks.find(kid).ok_or_else(|| {
    tracing::warn!(provider = %provider_name, "OIDC JWKS does not contain token key id");
    oidc_error("OIDC_ID_TOKEN_INVALID", "OIDC ID token key is unknown")
  })?;
  if matches!(jwk.algorithm, AlgorithmParameters::OctetKey(_)) || !jwk_algorithm_matches(jwk, header.alg) {
    tracing::warn!(provider = %provider_name, "OIDC JWKS key is not valid for token algorithm");
    return Err(oidc_error(
      "OIDC_ID_TOKEN_ALGORITHM_REJECTED",
      "OIDC ID token key is not valid for the token algorithm",
    ));
  }

  let decoding_key = DecodingKey::from_jwk(jwk).map_err(|e| {
    tracing::warn!(provider = %provider_name, reason = jwt_error_reason(&e), "OIDC JWKS key could not be used");
    ApiError::Internal("OIDC JWKS key could not be used for validation".into())
  })?;
  let mut validation = Validation::new(header.alg);
  validation.set_audience(&[config.client_id.as_str()]);
  validation.set_issuer(&[issuer]);
  validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);

  let claims = decode::<serde_json::Value>(token, &decoding_key, &validation)
    .map_err(|e| {
      tracing::warn!(provider = %provider_name, event = "sso.token.rejected", reason = jwt_error_reason(&e), "OIDC ID token validation failed");
      oidc_error("OIDC_ID_TOKEN_INVALID", "OIDC ID token is invalid")
    })?
    .claims;

  if string_claim(&claims, "nonce").as_deref() != Some(expected_nonce) {
    tracing::warn!(provider = %provider_name, "OIDC ID token nonce mismatch");
    return Err(oidc_error(
      "OIDC_ID_TOKEN_NONCE_INVALID",
      "OIDC ID token nonce does not match the OAuth preflight",
    ));
  }

  tracing::debug!(event = "sso.token.validated", "OIDC ID token validated");
  Ok(Some(claims))
}

pub(crate) fn groups_from_sources(
  claims: &OAuthClaimsConfig,
  id_token_claims: Option<&serde_json::Value>,
  userinfo_claims: &serde_json::Value,
) -> Option<Vec<String>> {
  let groups_path = claims.groups.as_deref();
  match claims.groups_source.as_deref().unwrap_or("userinfo") {
    "id_token" => id_token_claims.and_then(|claims| groups_claim(claims, groups_path)),
    "both" => {
      let mut seen = HashSet::new();
      let mut groups = Vec::new();
      for source in [
        id_token_claims.and_then(|claims| groups_claim(claims, groups_path)),
        groups_claim(userinfo_claims, groups_path),
      ]
      .into_iter()
      .flatten()
      {
        for group in source {
          if seen.insert(group.clone()) {
            groups.push(group);
          }
        }
      }
      (!groups.is_empty()).then_some(groups)
    }
    _ => groups_claim(userinfo_claims, groups_path),
  }
}

fn parse_role(role: &str, field: &str) -> Result<OrganizationUnitRole, ApiError> {
  match role {
    "reader" => Ok(OrganizationUnitRole::Reader),
    "member" => Ok(OrganizationUnitRole::Member),
    "manager" => Ok(OrganizationUnitRole::Manager),
    _ => Err(ApiError::BadRequest {
      name: "OIDC_GROUP_MAPPING_INVALID".into(),
      message: format!("{field} must be one of reader, member, manager"),
      data: None,
    }),
  }
}

fn group_mapping_from_config(mapping: &OAuthGroupMappingConfig) -> Result<OidcGroupMapping, ApiError> {
  Ok(OidcGroupMapping {
    default_role: parse_role(&mapping.default_role, "groupMapping.defaultRole")?,
    remove_missing_oidc_memberships: mapping.remove_missing_oidc_memberships,
    missing_groups_policy: match mapping.missing_groups_policy {
      OAuthMissingGroupsPolicy::DenyLogin => OidcMissingGroupsPolicy::DenyLogin,
      OAuthMissingGroupsPolicy::AllowWithoutMemberships => OidcMissingGroupsPolicy::AllowWithoutMemberships,
    },
    unknown_groups: match mapping.unknown_groups {
      OAuthUnknownGroupsPolicy::Ignore => OidcUnknownGroupsPolicy::Ignore,
      OAuthUnknownGroupsPolicy::DenyLogin => OidcUnknownGroupsPolicy::DenyLogin,
    },
    mappings: mapping
      .mappings
      .iter()
      .map(|rule| {
        let target_unit_id = Uuid::parse_str(&rule.target_unit_id).map_err(|_| ApiError::BadRequest {
          name: "OIDC_GROUP_MAPPING_INVALID".into(),
          message: format!(
            "groupMapping targetUnitId for '{}' is not a valid UUID",
            rule.provider_group
          ),
          data: None,
        })?;
        Ok(OidcGroupMappingRule {
          provider_group: rule.provider_group.clone(),
          target_unit_id,
          role: rule
            .role
            .as_deref()
            .map(|role| parse_role(role, "groupMapping.mappings[].role"))
            .transpose()?,
        })
      })
      .collect::<Result<Vec<_>, ApiError>>()?,
  })
}

/// Validate group claims before the callback creates or links a local user.
///
/// This keeps `deny_login` genuinely fail-closed: a missing required groups
/// claim or forbidden unknown group blocks the login before Myoxus persists a
/// new OAuth account for that IdP subject.
pub(crate) fn validate_login_claims(
  provider_groups: Option<&[String]>,
  mapping: &OAuthGroupMappingConfig,
) -> Result<(), ApiError> {
  let Some(provider_groups) = provider_groups else {
    return match mapping.missing_groups_policy {
      OAuthMissingGroupsPolicy::AllowWithoutMemberships => Ok(()),
      OAuthMissingGroupsPolicy::DenyLogin => Err(ApiError::Forbidden {
        name: "OIDC_GROUPS_CLAIM_MISSING".into(),
        message: "OIDC groups claim is required for this provider".into(),
      }),
    };
  };

  if mapping.unknown_groups == OAuthUnknownGroupsPolicy::DenyLogin {
    let mapped_groups = mapping
      .mappings
      .iter()
      .map(|rule| rule.provider_group.trim())
      .collect::<HashSet<_>>();
    let unknown = provider_groups
      .iter()
      .map(|group| group.trim())
      .filter(|group| !group.is_empty() && !mapped_groups.contains(*group))
      .map(str::to_string)
      .collect::<Vec<_>>();
    if !unknown.is_empty() {
      return Err(ApiError::Forbidden {
        name: "OIDC_GROUPS_UNMAPPED".into(),
        message: format!("{} OIDC groups are not mapped to organization units", unknown.len()),
      });
    }
  }

  Ok(())
}

/// Reconcile IdP groups into OU memberships for the OIDC source only.
///
/// The configured group claim is authoritative for `source=oidc` memberships:
/// mapped groups are upserted, missing mapped groups are removed when
/// configured, and manual/import/LDAP/SCIM memberships are never deleted or
/// overwritten. This keeps IdP-driven access separate from administrator-owned
/// exceptions while still allowing fail-closed login when required claims are
/// absent or unknown groups are not allowed.
pub(crate) async fn reconcile_group_memberships(
  state: &ApiState,
  provider: &str,
  provider_subject: &str,
  user_id: Uuid,
  provider_groups: Option<&[String]>,
  mapping: &OAuthGroupMappingConfig,
) -> Result<(), ApiError> {
  if state
    .auth()
    .get_user_by_id(user_id)
    .await
    .map_err(|_| ApiError::Internal("failed to resolve OIDC account".into()))?
    .is_none()
  {
    return Err(ApiError::Forbidden {
      name: "AUTHENTICATION_REQUIRED".into(),
      message: "account is no longer operational".into(),
    });
  }
  let unit_repo = state.organization_unit_repo().ok_or_else(|| {
    ApiError::Internal("OIDC group mapping requires the organization unit repository to be configured".into())
  })?;
  let member_repo = state.organization_unit_member_repo().ok_or_else(|| {
    ApiError::Internal("OIDC group mapping requires the organization unit member repository to be configured".into())
  })?;

  let normalized_mapping = group_mapping_from_config(mapping)?;
  let service = OidcGroupSyncService::new(
    unit_repo,
    member_repo,
    Arc::new(crate::organization::ManagerCapabilityWriterAdapter::new(Arc::new(
      state.clone(),
    ))),
  );
  let report = service
    .reconcile(OidcGroupSyncInput {
      user_id,
      provider,
      provider_subject,
      provider_groups,
      mapping: &normalized_mapping,
    })
    .await
    .map_err(map_oidc_sync_error)?;
  record_oidc_sync_audit(state, user_id, provider, &report.events).await;
  tracing::info!(
    user_id = %user_id,
    provider,
    desired_memberships = report.desired_memberships,
    ignored_unmapped_groups = report.ignored_unmapped_groups,
    event_count = report.events.len(),
    "oidc group memberships reconciled"
  );
  Ok(())
}

fn map_oidc_sync_error(error: OidcGroupSyncError) -> ApiError {
  match error {
    OidcGroupSyncError::GroupsClaimMissing => ApiError::Forbidden {
      name: "OIDC_GROUPS_CLAIM_MISSING".into(),
      message: "OIDC groups claim is required for this provider".into(),
    },
    OidcGroupSyncError::UnknownGroups(count) => ApiError::Forbidden {
      name: "OIDC_GROUPS_UNMAPPED".into(),
      message: format!("{count} OIDC groups are not mapped to organization units"),
    },
    OidcGroupSyncError::TargetUnitMissing(unit_id) => ApiError::BadRequest {
      name: "OIDC_GROUP_MAPPING_INVALID".into(),
      message: format!("groupMapping targetUnitId '{unit_id}' does not exist"),
      data: None,
    },
    OidcGroupSyncError::TargetUnitInactive(unit_id) => ApiError::BadRequest {
      name: "OIDC_GROUP_MAPPING_INACTIVE".into(),
      message: format!("groupMapping targetUnitId '{unit_id}' is inactive"),
      data: None,
    },
    OidcGroupSyncError::Repository(message) | OidcGroupSyncError::ManagerCapability(message) => {
      ApiError::Internal(message)
    }
  }
}

async fn record_oidc_sync_audit(state: &ApiState, user_id: Uuid, provider: &str, events: &[OidcGroupSyncEvent]) {
  for event in events {
    let capability_event = matches!(
      event.action,
      OidcGroupSyncAction::ManagerCapabilitySet | OidcGroupSyncAction::ManagerCapabilityRevoked
    );
    let event_key = match event.action {
      OidcGroupSyncAction::Added => "organization.member.oidc_sync.add",
      OidcGroupSyncAction::Updated => "organization.member.oidc_sync.update",
      OidcGroupSyncAction::Removed => "organization.member.oidc_sync.remove",
      OidcGroupSyncAction::SkippedConflict => "organization.member.oidc_sync.skipped_conflict",
      OidcGroupSyncAction::ManagerCapabilitySet => "user.feature.manager.implicit_set",
      OidcGroupSyncAction::ManagerCapabilityRevoked => "user.feature.manager.implicit_revoke",
    };
    state
      .audit_recorder()
      .record(
        AuditEvent::mutation(
          event_key,
          if capability_event {
            AuditCategory::User
          } else {
            AuditCategory::Organization
          },
          Some(AuditTarget::entity(
            if capability_event {
              "user"
            } else {
              "organization_unit_member"
            },
            if capability_event { user_id } else { event.unit_id },
            None,
          )),
          AuditActor::system(),
          event
            .previous_role
            .map(|role| serde_json::json!({ "role": role.as_str() })),
          Some(serde_json::json!({
            "user_id": user_id.to_string(),
            "unit_id": event.unit_id.to_string(),
            "provider": provider,
            "action": event.action,
            "role": event.role.map(|role| role.as_str()),
            "source_conflict": event.source_conflict.map(OrganizationUnitMemberSource::as_str),
          })),
        )
        .with_unit(event.unit_id),
      )
      .await;
  }
}

// These categories deliberately exclude Display/Debug payloads and arbitrary
// JWT claim names; serde and HTTP errors can embed provider-controlled data.
fn jwt_error_reason(error: &jsonwebtoken::errors::Error) -> &'static str {
  use jsonwebtoken::errors::ErrorKind;
  match error.kind() {
    ErrorKind::ExpiredSignature => "expired",
    ErrorKind::InvalidIssuer => "issuer_mismatch",
    ErrorKind::InvalidAudience => "audience_mismatch",
    ErrorKind::InvalidSignature => "invalid_signature",
    ErrorKind::ImmatureSignature => "not_yet_valid",
    ErrorKind::MissingRequiredClaim(_) => "required_claim_missing",
    ErrorKind::InvalidAlgorithm => "invalid_algorithm",
    ErrorKind::Json(_) => "invalid_claim_type_or_json",
    _ => "invalid_token_or_key",
  }
}

pub(crate) fn http_error_reason(error: &reqwest::Error) -> &'static str {
  myoxus_infrastructure::tls::http_error::reason(error)
}

pub(crate) fn provider_http_error(error: &reqwest::Error, phase: &'static str, trust_snapshot_id: &str) -> ApiError {
  ApiError::Internal(provider_http_diagnosis(error, phase, trust_snapshot_id))
}

pub(crate) fn provider_http_diagnosis(error: &reqwest::Error, phase: &'static str, trust_snapshot_id: &str) -> String {
  let reason = http_error_reason(error);
  tracing::warn!(
    event = "sso.provider.failed",
    phase,
    reason,
    trust_snapshot_id,
    "SSO provider request failed"
  );
  format!("SSO {phase} failed: {reason}")
}

pub(crate) fn provider_http_rejection(
  status: reqwest::StatusCode,
  phase: &'static str,
  trust_snapshot_id: &str,
) -> ApiError {
  ApiError::Internal(provider_http_rejection_diagnosis(status, phase, trust_snapshot_id))
}

pub(crate) fn provider_http_rejection_diagnosis(
  status: reqwest::StatusCode,
  phase: &'static str,
  trust_snapshot_id: &str,
) -> String {
  tracing::warn!(
    event = "sso.provider.failed",
    phase,
    reason = "http_rejected",
    status = status.as_u16(),
    trust_snapshot_id,
    "SSO provider rejected request"
  );
  format!("SSO {phase} failed: http_rejected (HTTP {})", status.as_u16())
}

fn claim_shape(value: &serde_json::Value) -> &'static str {
  match value {
    serde_json::Value::Null => "missing_or_null",
    serde_json::Value::String(_) => "string",
    serde_json::Value::Bool(_) => "boolean",
    serde_json::Value::Number(_) => "number",
    serde_json::Value::Array(_) => "array",
    serde_json::Value::Object(_) => "object",
  }
}

/// Report bounded shapes and pseudonyms, never raw paths or claim values.
/// Both sources are inspected so operators can diagnose a wrong claim source.
pub(crate) fn log_claim_diagnostics(
  claims: &OAuthClaimsConfig,
  config: &OAuthCustomProviderConfig,
  id_token: Option<&serde_json::Value>,
  userinfo: &serde_json::Value,
) {
  if !tracing::enabled!(tracing::Level::DEBUG) {
    return;
  }
  // An unlogged random salt permits within-attempt comparisons without stable
  // identity fingerprints or dictionary attacks against common group names.
  let salt = Uuid::new_v4();
  let group_source = match claims.groups_source.as_deref() {
    Some("id_token") => "id_token",
    Some("both") => "both",
    _ => "userinfo",
  };
  tracing::debug!(
    event = "sso.claims.policy",
    group_source,
    mapping_enabled = config.group_mapping.enabled,
    "OIDC claim source policy"
  );
  for (source, root) in [("id_token", id_token), ("userinfo", Some(userinfo))] {
    let root = root.unwrap_or(&serde_json::Value::Null);
    for (claim, path) in [
      (
        "subject",
        Some(claims.subject.as_deref().unwrap_or(&config.user_id_field)),
      ),
      (
        "email",
        Some(claims.email.as_deref().unwrap_or(&config.user_email_field)),
      ),
      ("email_verified", claims.email_verified.as_deref()),
      (
        "groups",
        claims
          .groups
          .as_deref()
          .or_else(|| config.group_mapping.enabled.then_some("groups")),
      ),
    ] {
      let value = path
        .map(|path| claim_value(root, path))
        .unwrap_or(&serde_json::Value::Null);
      tracing::debug!(
        event = "sso.claims.inspected",
        source,
        claim,
        configured = path.is_some(),
        shape = claim_shape(value),
        string_length = value.as_str().map(str::len),
        item_count = value.as_array().map(Vec::len),
        "OIDC claim shape inspected"
      );
      if matches!(claim, "subject" | "email")
        && let Some(text) = value.as_str()
      {
        tracing::debug!(event = "sso.claims.value_preview", source, claim, pseudonym = %group_pseudonym(salt, text), "OIDC claim pseudonym");
      }
      if claim == "email_verified" {
        tracing::debug!(
          event = "sso.claims.verification",
          source,
          verified = value.as_bool(),
          "OIDC email verification claim"
        );
      }
      if claim == "groups" {
        let groups = groups_claim(root, path).unwrap_or_default();
        let mapped_count = groups
          .iter()
          .filter(|group| {
            config
              .group_mapping
              .mappings
              .iter()
              .any(|rule| rule.provider_group.trim() == group.as_str())
          })
          .count();
        let invalid_items = value
          .as_array()
          .map(|items| {
            items
              .iter()
              .filter(|item| item.as_str().and_then(normalize_group_name).is_none())
              .count()
          })
          .unwrap_or(0);
        tracing::debug!(
          event = "sso.claims.groups",
          source,
          normalized_count = groups.len(),
          mapped_count,
          invalid_items,
          preview_count = groups.len().min(8),
          "OIDC group claim summary"
        );
        for (index, group) in groups.iter().take(8).enumerate() {
          let mapping_index = config
            .group_mapping
            .mappings
            .iter()
            .position(|rule| rule.provider_group.trim() == group.as_str());
          tracing::debug!(event = "sso.claims.group_preview", source, index, pseudonym = %group_pseudonym(salt, group), mapped = mapping_index.is_some(), mapping_index, "OIDC group pseudonym");
        }
      }
    }
  }
}

fn group_pseudonym(salt: Uuid, group: &str) -> String {
  use sha2::{Digest, Sha256};
  let mut hash = Sha256::new();
  hash.update(salt.as_bytes());
  hash.update(group.as_bytes());
  format!("{:x}", hash.finalize())[..24].to_string()
}
