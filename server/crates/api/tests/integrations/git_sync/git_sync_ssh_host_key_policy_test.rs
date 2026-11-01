//! Git-Sync SSH host-key policy and known-host GraphQL contracts.

use crate::helpers;
use serde_json::{Value, json};
use sqlx::Row;

const LIST_KEYS_QUERY: &str = r#"
query GitSyncSshHostKeys {
  gitSyncSshHostKeys {
    host
    port
    keyType
    fingerprintSha256
    source
    createdBy
    enabled
  }
}
"#;

const DISABLE_KEY_MUTATION: &str = r#"
mutation DisableGitSyncSshHostKey($host: String!, $port: Int!, $keyType: String!) {
  disableGitSyncSshHostKey(host: $host, port: $port, keyType: $keyType)
}
"#;

const DELETE_KEY_MUTATION: &str = r#"
mutation DeleteGitSyncSshHostKey($host: String!, $port: Int!, $keyType: String!) {
  deleteGitSyncSshHostKey(host: $host, port: $port, keyType: $keyType)
}
"#;

fn key_vars() -> Value {
  json!({"host": "git-policy.example.test", "port": 2222, "keyType": "ssh-ed25519"})
}

#[tokio::test]
async fn inv_gsh15_admin_can_list_disable_and_delete_ssh_host_key_pins() {
  let _guard = helpers::GIT_SYNC_LOCK
    .get_or_init(|| std::sync::Mutex::new(()))
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

  sqlx::query("DELETE FROM git_sync_ssh_host_keys WHERE host = 'git-policy.example.test'")
    .execute(&pool)
    .await
    .expect("cleanup stale ssh host key");
  sqlx::query(
    r#"
    INSERT INTO git_sync_ssh_host_keys
      (host, port, key_type, fingerprint_sha256, source, created_by, enabled)
    VALUES ('git-policy.example.test', 2222, 'ssh-ed25519', 'SHA256:testpin', 'test', $1, TRUE)
    "#,
  )
  .bind(admin_id)
  .execute(&pool)
  .await
  .expect("insert ssh host key");

  let listed = helpers::gql(&app, session_id, helpers::gql_query(LIST_KEYS_QUERY)).await;
  assert!(listed.get("errors").is_none(), "list failed: {listed}");
  let keys = listed["data"]["gitSyncSshHostKeys"].as_array().expect("keys array");
  let key = keys
    .iter()
    .find(|key| key["host"] == "git-policy.example.test")
    .expect("inserted key visible");
  assert_eq!(key["port"], 2222);
  assert_eq!(key["keyType"], "ssh-ed25519");
  assert_eq!(key["fingerprintSha256"], "SHA256:testpin");
  assert_eq!(key["enabled"], true);
  assert_eq!(key["createdBy"], admin_id.to_string());

  let disabled = helpers::gql(
    &app,
    session_id,
    helpers::gql_query_vars(DISABLE_KEY_MUTATION, key_vars()),
  )
  .await;
  assert!(disabled.get("errors").is_none(), "disable failed: {disabled}");
  assert_eq!(disabled["data"]["disableGitSyncSshHostKey"], true);
  let enabled: bool =
    sqlx::query("SELECT enabled FROM git_sync_ssh_host_keys WHERE host = $1 AND port = $2 AND key_type = $3")
      .bind("git-policy.example.test")
      .bind(2222_i32)
      .bind("ssh-ed25519")
      .fetch_one(&pool)
      .await
      .expect("host key row after disable")
      .get("enabled");
  assert!(!enabled, "disable mutation must persist enabled=false");

  let deleted = helpers::gql(
    &app,
    session_id,
    helpers::gql_query_vars(DELETE_KEY_MUTATION, key_vars()),
  )
  .await;
  assert!(deleted.get("errors").is_none(), "delete failed: {deleted}");
  assert_eq!(deleted["data"]["deleteGitSyncSshHostKey"], true);
  let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM git_sync_ssh_host_keys WHERE host = $1")
    .bind("git-policy.example.test")
    .fetch_one(&pool)
    .await
    .expect("remaining count");
  assert_eq!(remaining, 0);

  helpers::cleanup_users(&pool, &[admin_id]).await;
}
