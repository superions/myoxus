// SPDX-License-Identifier: AGPL-3.0-or-later
//! GraphQL resolvers for MCP API key management.
//!
//! Provides `createApiKey`, `listApiKeys`, and `revokeApiKey` mutations
//! accessible to any authenticated user (for their own keys).

use async_graphql::{Context, Object, Result, SimpleObject};
use chrono::{DateTime, Duration, Utc};
use myoxus_domain::audit::{AuditActor, AuditCategory, AuditEvent, AuditTarget};
use serde_json::json;
use tracing::instrument;
use uuid::Uuid;

use crate::graphql::utils::{map_gql_error, require_session};
use crate::state::ApiState;

/// GraphQL output type for an API key (without the secret).
#[derive(SimpleObject, Clone)]
pub struct ApiKeyType {
  pub id: String,
  pub name: String,
  pub scopes: Vec<String>,
  pub created_at: DateTime<Utc>,
  pub last_used_at: Option<DateTime<Utc>>,
  pub expires_at: Option<DateTime<Utc>>,
}

/// GraphQL output type for a newly created API key (includes plaintext key, shown once).
#[derive(SimpleObject, Clone)]
pub struct CreatedApiKeyType {
  pub id: String,
  /// Plaintext key — shown exactly once. Store it securely.
  pub key: String,
  pub name: String,
  pub scopes: Vec<String>,
  pub expires_at: Option<DateTime<Utc>>,
}

pub struct ApiKeyQueryRoot;

#[Object]
impl ApiKeyQueryRoot {
  /// List all API keys for the current user.
  #[instrument(skip_all)]
  pub async fn list_api_keys(&self, ctx: &Context<'_>) -> Result<Vec<ApiKeyType>> {
    let (state, snapshot) = require_session(ctx).await?;
    if !mcp_feature_enabled(&state).await {
      return Err(async_graphql::Error::new("MCP feature is disabled"));
    }
    let keys = state
      .api_key_service()
      .list_by_user(snapshot.user.id)
      .await
      .map_err(map_gql_error)?;

    Ok(
      keys
        .into_iter()
        .map(|k| ApiKeyType {
          id: k.id.to_string(),
          name: k.name,
          scopes: k.scopes,
          created_at: k.created_at,
          last_used_at: k.last_used_at,
          expires_at: k.expires_at,
        })
        .collect(),
    )
  }
}

pub struct ApiKeyMutationRoot;

#[Object]
impl ApiKeyMutationRoot {
  /// Create a new MCP API key for the current user.
  ///
  /// The returned `key` field contains the plaintext key; it is shown only once.
  /// Supported scopes: `read:workspaces`, `write:workspaces`, `read:docs`, `write:docs`,
  /// `read:databases`, `write:databases`, `read:document_graph`,
  /// `read:templates`, `read:automations`, `write:automations`, `read:organization`,
  /// `write:organization`, `read:users`, `write:users`, `read:calendar`, `write:calendar`. User and organization
  /// scopes are reserved for active global administrators and are rechecked on
  /// every tool call.
  ///
  /// Database access uses the canonical `read:databases` and
  /// `write:databases` scopes. Older pre-P-DB-01 Database scope names are not
  /// accepted after the naming cleanup.
  #[instrument(skip_all)]
  pub async fn create_api_key(
    &self,
    ctx: &Context<'_>,
    name: String,
    scopes: Vec<String>,
    // Optional expiry in days (default: never expires).
    expires_in_days: Option<i32>,
  ) -> Result<CreatedApiKeyType> {
    let (state, snapshot) = require_session(ctx).await?;
    if !mcp_feature_enabled(&state).await {
      return Err(async_graphql::Error::new("MCP feature is disabled"));
    }

    // Validate scopes
    let valid_scopes = [
      "read:workspaces",
      "write:workspaces",
      "read:docs",
      "write:docs",
      "read:databases",
      "write:databases",
      "read:document_graph",
      "read:templates",
      "read:automations",
      "write:automations",
      "read:organization",
      "write:organization",
      "read:users",
      "write:users",
      "read:calendar",
      "write:calendar",
    ];
    for scope in &scopes {
      if !valid_scopes.contains(&scope.as_str()) {
        return Err(async_graphql::Error::new(format!("Invalid scope: {scope}")));
      }
    }
    let organization_scope = scopes
      .iter()
      .any(|scope| matches!(scope.as_str(), "read:organization" | "write:organization"));
    let user_scope = scopes
      .iter()
      .any(|scope| matches!(scope.as_str(), "read:users" | "write:users"));
    if organization_scope || user_scope {
      let current = state
        .auth()
        .get_user_by_id(snapshot.user.id)
        .await
        .map_err(map_gql_error)?;
      if !current.is_some_and(|user| user.is_admin && !user.disabled) {
        return Err(async_graphql::Error::new(if user_scope {
          "User MCP scopes require an active global administrator"
        } else {
          "Organization MCP scopes require an active global administrator"
        }));
      }
    }

    let expires_at = expires_in_days.map(|days| Utc::now() + Duration::days(days as i64));

    let (key_record, plaintext) = state
      .api_key_service()
      .generate(snapshot.user.id, name, scopes, expires_at)
      .await
      .map_err(map_gql_error)?;

    state
      .audit_recorder()
      .record(
        AuditEvent::mutation(
          "mcp.api_key.create",
          AuditCategory::Mcp,
          Some(AuditTarget {
            target_type: "mcp_api_key".to_string(),
            target_id: key_record.id.to_string(),
            target_label: Some(key_record.name.clone()),
          }),
          AuditActor::user(snapshot.user.id, Some("user".to_string())),
          None,
          Some(json!({
            "key_id": key_record.id.to_string(),
            "name": key_record.name.clone(),
            "scopes": key_record.scopes.clone(),
            "expires_at": key_record.expires_at.map(|value| value.to_rfc3339()),
            "secret_returned_once": true
          })),
        )
        .with_metadata(json!({
          "origin": "graphql",
          "credential_type": "mcp_api_key",
          "api_key_id": key_record.id.to_string()
        })),
      )
      .await;

    Ok(CreatedApiKeyType {
      id: key_record.id.to_string(),
      key: plaintext,
      name: key_record.name,
      scopes: key_record.scopes,
      expires_at: key_record.expires_at,
    })
  }

  /// Revoke (delete) an API key.
  #[instrument(skip_all)]
  pub async fn revoke_api_key(&self, ctx: &Context<'_>, id: String) -> Result<bool> {
    let (state, snapshot) = require_session(ctx).await?;
    if !mcp_feature_enabled(&state).await {
      return Err(async_graphql::Error::new("MCP feature is disabled"));
    }
    let key_id = Uuid::parse_str(&id).map_err(|_| async_graphql::Error::new("Invalid key ID"))?;

    // Verify ownership
    let keys = state
      .api_key_service()
      .list_by_user(snapshot.user.id)
      .await
      .map_err(map_gql_error)?;

    let Some(key_record) = keys.iter().find(|k| k.id == key_id).cloned() else {
      return Err(async_graphql::Error::new("API key not found or not owned by you"));
    };

    state.api_key_service().delete(key_id).await.map_err(map_gql_error)?;
    state
      .audit_recorder()
      .record(
        AuditEvent::mutation(
          "mcp.api_key.revoke",
          AuditCategory::Mcp,
          Some(AuditTarget {
            target_type: "mcp_api_key".to_string(),
            target_id: key_record.id.to_string(),
            target_label: Some(key_record.name.clone()),
          }),
          AuditActor::user(snapshot.user.id, Some("user".to_string())),
          Some(json!({
            "key_id": key_record.id.to_string(),
            "name": key_record.name.clone(),
            "scopes": key_record.scopes.clone(),
            "expires_at": key_record.expires_at.map(|value| value.to_rfc3339())
          })),
          None,
        )
        .with_metadata(json!({
          "origin": "graphql",
          "credential_type": "mcp_api_key",
          "api_key_id": key_record.id.to_string()
        })),
      )
      .await;
    Ok(true)
  }
}

async fn mcp_feature_enabled(state: &ApiState) -> bool {
  state
    .effective_config()
    .await
    .bool("mcp.enabled")
    .unwrap_or(state.config_file_baseline.mcp.enabled)
}
