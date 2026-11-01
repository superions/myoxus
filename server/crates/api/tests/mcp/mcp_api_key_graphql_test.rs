//! MCP API-key GraphQL contract tests.
//!
//! The Web integration uses the `apiKeys` subroot, not generic personal
//! access tokens. These tests keep the MCP token surface tied to scoped
//! `myoxus_...` keys and verify that write scopes survive create/list/revoke.

use std::sync::Arc;

use myoxus_application::api_key::ApiKeyService;
use myoxus_infrastructure::api_key::SqlxApiKeyStore;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

use crate::helpers;

#[test]
fn inv_mcp_api_key_graphql_create_list_revoke_write_scoped_key() {
  helpers::block_on_large_stack("inv-mcp-api-key-canonical-database-scopes", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "mcp-api-key").await;

    let create = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
        mutation CreateMcpApiKey($name: String!, $scopes: [String!]!) {
          apiKeys {
            createApiKey(name: $name, scopes: $scopes) {
              id
              name
              key
              scopes
              expiresAt
            }
          }
        }
      "#,
        "variables": {
          "name": "mcp:test-workspace",
          "scopes": [
            "read:workspaces",
            "read:docs",
            "write:docs",
            "read:databases",
            "write:databases",
            "read:document_graph",
            "read:templates",
            "read:automations",
      "write:automations",
            "read:calendar",
            "write:calendar"
          ],
        }
      }),
    )
    .await;
    assert!(create.get("errors").is_none(), "createApiKey failed: {create}");

    let created = &create["data"]["apiKeys"]["createApiKey"];
    let key_id = created["id"].as_str().expect("created key id must be present");
    assert_eq!(created["name"], "mcp:test-workspace");
    assert!(
      created["key"]
        .as_str()
        .expect("created key secret must be returned once")
        .starts_with("myoxus_"),
      "MCP GraphQL must create MCP API keys, not generic personal access tokens: {created}"
    );
    assert_scope_set(
      created,
      &[
        "read:workspaces",
        "read:docs",
        "write:docs",
        "read:databases",
        "write:databases",
        "read:document_graph",
        "read:templates",
        "read:automations",
        "write:automations",
        "read:calendar",
        "write:calendar",
      ],
    );

    let listed = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
        query ListMcpApiKeys {
          apiKeys {
            listApiKeys {
              id
              name
              scopes
              lastUsedAt
              expiresAt
            }
          }
        }
      "#,
      }),
    )
    .await;
    assert!(listed.get("errors").is_none(), "listApiKeys failed: {listed}");
    let rows = listed["data"]["apiKeys"]["listApiKeys"]
      .as_array()
      .expect("listApiKeys must return an array");
    let listed_key = rows
      .iter()
      .find(|row| row["id"].as_str() == Some(key_id))
      .expect("created MCP key must be listed");
    assert_scope_set(
      listed_key,
      &[
        "read:workspaces",
        "read:docs",
        "write:docs",
        "read:automations",
        "write:automations",
      ],
    );

    let revoked = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
        mutation RevokeMcpApiKey($id: String!) {
          apiKeys {
            revokeApiKey(id: $id)
          }
        }
      "#,
        "variables": { "id": key_id },
      }),
    )
    .await;
    assert!(revoked.get("errors").is_none(), "revokeApiKey failed: {revoked}");
    assert_eq!(revoked["data"]["apiKeys"]["revokeApiKey"], true);

    helpers::cleanup_users(&pool, &[user_id]).await;
  });
}

#[tokio::test]
async fn inv_mcp_api_key_revoke_removes_replays_and_blocks_authentication() {
  let pool = helpers::setup_pool().await;
  let auth_store = Arc::new(myoxus_infrastructure::auth::SqlxAuthStore::from_pool(pool.clone()));
  let (user_id, _) = helpers::seed_user(&pool, &auth_store, "mcp-revoke-replay").await;
  let key_service = ApiKeyService::new(Arc::new(SqlxApiKeyStore::new(pool.clone())));
  let (key, plaintext_key) = key_service
    .generate(
      user_id,
      "mcp:revoke-replay".to_string(),
      vec!["write:docs".to_string()],
      None,
    )
    .await
    .expect("generate persisted MCP API key");
  sqlx::query(
    "INSERT INTO mcp_idempotency_keys
       (id, api_key_id, user_id, tool_name, idempotency_key, payload_sha256, response_json, completed_at)
     VALUES ($1, $2, $3, 'create_page', 'revoke-replay', $4, $5, now())",
  )
  .bind(Uuid::new_v4())
  .bind(key.id)
  .bind(user_id)
  .bind("0".repeat(64))
  .bind(json!({ "content": [{ "type": "text", "text": "stored response" }] }))
  .execute(&pool)
  .await
  .expect("seed completed replay row before key revoke");

  key_service.delete(key.id).await.expect("revoke persisted MCP API key");

  let replay_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM mcp_idempotency_keys WHERE api_key_id = $1")
    .bind(key.id)
    .fetch_one(&pool)
    .await
    .expect("count replay rows after key revoke");
  assert_eq!(replay_rows, 0, "key revoke must cascade-delete stored replay responses");
  assert!(
    key_service.authenticate(&plaintext_key).await.is_err(),
    "revoked credentials must fail authentication before any replay lookup"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_mcp_api_key_graphql_rejects_historical_admin_wildcard_scope() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "mcp-api-key-admin-scope").await;

  let create = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"
        mutation CreateMcpApiKey($name: String!, $scopes: [String!]!) {
          apiKeys {
            createApiKey(name: $name, scopes: $scopes) {
              id
            }
          }
        }
      "#,
      "variables": {
        "name": "mcp:admin-wildcard-regression",
        "scopes": ["admin"],
      }
    }),
  )
  .await;

  assert!(
    create.get("errors").is_some(),
    "createApiKey must reject unsupported MCP scopes: {create}"
  );

  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[tokio::test]
async fn inv_mcp_api_key_graphql_lifecycle_is_audited_without_secret_material() {
  let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
  let (user_id, session_id) = helpers::seed_user(&pool, &auth_store, "mcp-api-key-audit").await;

  let create = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"
        mutation CreateMcpApiKey($name: String!, $scopes: [String!]!) {
          apiKeys {
            createApiKey(name: $name, scopes: $scopes) {
              id
              key
              scopes
            }
          }
        }
      "#,
      "variables": {
        "name": "mcp:audit-lifecycle",
        "scopes": ["read:workspaces", "read:docs", "write:docs"],
      }
    }),
  )
  .await;
  assert!(create.get("errors").is_none(), "createApiKey failed: {create}");

  let created = &create["data"]["apiKeys"]["createApiKey"];
  let key_id = created["id"].as_str().expect("created key id").to_string();
  let plaintext = created["key"].as_str().expect("one-time key secret");

  let revoked = helpers::gql(
    &app,
    session_id,
    json!({
      "query": r#"
        mutation RevokeMcpApiKey($id: String!) {
          apiKeys {
            revokeApiKey(id: $id)
          }
        }
      "#,
      "variables": { "id": key_id },
    }),
  )
  .await;
  assert!(revoked.get("errors").is_none(), "revokeApiKey failed: {revoked}");
  assert_eq!(revoked["data"]["apiKeys"]["revokeApiKey"], true);

  let rows = sqlx::query(
    "SELECT event_key, category, actor_user_id, actor_kind, target_type, target_id, \
            credential_type, credential_id, old_value, new_value, metadata \
       FROM admin_audit_log \
      WHERE category = 'mcp' AND actor_user_id = $1 AND target_id = $2 \
      ORDER BY created_at ASC",
  )
  .bind(user_id)
  .bind(&key_id)
  .fetch_all(&pool)
  .await
  .expect("MCP API-key audit rows must be queryable");

  let event_keys = rows
    .iter()
    .map(|row| row.get::<String, _>("event_key"))
    .collect::<Vec<_>>();
  assert_eq!(
    event_keys,
    vec!["mcp.api_key.create".to_string(), "mcp.api_key.revoke".to_string()],
    "MCP API-key lifecycle must emit create and revoke audit rows"
  );

  for row in rows {
    assert_eq!(row.get::<String, _>("category"), "mcp");
    assert_eq!(row.get::<Option<uuid::Uuid>, _>("actor_user_id"), Some(user_id));
    assert_eq!(row.get::<String, _>("actor_kind"), "user");
    assert_eq!(row.get::<String, _>("target_type"), "mcp_api_key");
    assert_eq!(row.get::<String, _>("target_id"), key_id);
    assert!(
      row.get::<Option<String>, _>("credential_type").is_none(),
      "user-session lifecycle audit must not pretend to be delegated"
    );
    assert!(
      row.get::<Option<String>, _>("credential_id").is_none(),
      "user-session lifecycle audit must not carry credential id"
    );

    let redaction_surface = json!({
      "oldValue": row.get::<Option<Value>, _>("old_value"),
      "newValue": row.get::<Option<Value>, _>("new_value"),
      "metadata": row.get::<Option<Value>, _>("metadata"),
    })
    .to_string();
    assert!(
      !redaction_surface.contains(plaintext),
      "audit rows must never contain the one-time plaintext API key"
    );
    assert!(
      !redaction_surface.contains("key_hash"),
      "audit rows must never expose hashed key material either"
    );
  }

  sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user_id]).await;
}

#[test]
fn inv_mcp_audit_graphql_filters_category_and_folder_prefix() {
  helpers::block_on_large_stack("inv-mcp-audit-graphql-filters", || async {
    let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
    let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let key_id = uuid::Uuid::new_v4().to_string();

    for (event_key, target_id) in [("mcp.folder.create", "folder-test-1"), ("mcp.doc.create", "doc-test-1")] {
      sqlx::query(
        "INSERT INTO admin_audit_log \
         (event_key, category, target_type, target_id, actor_user_id, actor_label, \
          actor_kind, credential_type, credential_id, metadata) \
       VALUES ($1, 'mcp', $2, $3, $4, 'mcp-api-key:test', 'api_key', 'mcp_api_key', $5, '{}'::jsonb)",
      )
      .bind(event_key)
      .bind(if event_key.contains(".folder.") {
        "folder"
      } else {
        "document"
      })
      .bind(target_id)
      .bind(admin_id)
      .bind(&key_id)
      .execute(&pool)
      .await
      .expect("seed MCP audit row");
    }

    let body = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": r#"
        query McpAuditFilter($credentialId: String!) {
          admin {
            adminAuditLog(
              filter: {
                category: "mcp"
                eventKeyPrefix: "mcp.folder."
                credentialId: $credentialId
              }
              limit: 10
              offset: 0
            ) {
              eventKey
              category
              actor {
                kind
                credentialType
                credentialId
              }
            }
            adminAuditLogCount(
              filter: {
                category: "mcp"
                eventKeyPrefix: "mcp.folder."
                credentialId: $credentialId
              }
            )
          }
        }
      "#,
        "variables": { "credentialId": key_id },
      }),
    )
    .await;
    assert!(body.get("errors").is_none(), "adminAuditLog failed: {body}");

    let rows = body["data"]["admin"]["adminAuditLog"]
      .as_array()
      .expect("audit rows array");
    assert_eq!(rows.len(), 1, "folder prefix must exclude other mcp rows: {body}");
    assert_eq!(rows[0]["eventKey"], "mcp.folder.create");
    assert_eq!(rows[0]["category"], "mcp");
    assert_eq!(rows[0]["actor"]["kind"], "api_key");
    assert_eq!(rows[0]["actor"]["credentialType"], "mcp_api_key");
    assert_eq!(rows[0]["actor"]["credentialId"], key_id);
    assert_eq!(body["data"]["admin"]["adminAuditLogCount"], 1);

    sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1")
      .bind(admin_id)
      .execute(&pool)
      .await
      .ok();
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

fn assert_scope_set(value: &Value, expected: &[&str]) {
  let scopes = value["scopes"].as_array().expect("scopes must be an array");
  for scope in expected {
    assert!(
      scopes.iter().any(|actual| actual.as_str() == Some(scope)),
      "scope {scope} missing from {value}"
    );
  }
}
