// SPDX-License-Identifier: AGPL-3.0-or-later
//! End-to-end password-policy projection and enforcement invariants.

use serde_json::{Value, json};
use uuid::Uuid;

use crate::helpers;

#[tokio::test]
async fn persisted_password_policy_is_projected_and_blocks_partial_admin_user_creation() {
  let _guard = helpers::AUTH_CONFIG_LOCK
    .get_or_init(|| tokio::sync::Mutex::new(()))
    .lock()
    .await;
  let pool = helpers::setup_pool().await;
  let previous_policy =
    sqlx::query_scalar::<_, Value>("SELECT value FROM app_configs WHERE id = 'auth.password_requirements'")
      .fetch_optional(&pool)
      .await
      .expect("read prior password policy");
  sqlx::query(
    "INSERT INTO app_configs (id, value) VALUES ('auth.password_requirements', $1) \
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
  )
  .bind(json!({ "min": 12, "max": 64 }))
  .execute(&pool)
  .await
  .expect("set test password policy");

  let (app, pool, auth_store) = helpers::setup_app_with_pool(pool).await;
  let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
  let email = format!("password-policy-{}@test.local", Uuid::new_v4());

  let result: Result<(), Box<dyn std::error::Error + Send + Sync>> = async {
    let config = helpers::gql_anon(
      &app,
      json!({
        "query": "{ serverConfig { credentialsRequirement { password { minLength maxLength } } } }"
      }),
    )
    .await;
    if config.get("errors").is_some() {
      return Err(std::io::Error::other(format!("serverConfig failed: {config}")).into());
    }
    if config["data"]["serverConfig"]["credentialsRequirement"]["password"]
      != json!({ "minLength": 12, "maxLength": 64 })
    {
      return Err(std::io::Error::other(format!(
        "serverConfig did not project the persisted policy: {config}"
      ))
      .into());
    }

    let rejected = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation Create($email: String!) { admin { createUser(input: { email: $email, name: \"Policy Rejected\", password: \"too-short\" }) { id } } }",
        "variables": { "email": email }
      }),
    )
    .await;
    if rejected.get("errors").is_none() {
      return Err(std::io::Error::other(format!("short password must fail: {rejected}")).into());
    }
    let rejected_user_count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE email = $1")
      .bind(&email)
      .fetch_one(&pool)
      .await?;
    if rejected_user_count != 0 {
      return Err(std::io::Error::other("policy validation must precede user creation").into());
    }

    let accepted = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation Create($email: String!) { admin { createUser(input: { email: $email, name: \"Policy Accepted\", password: \"valid-policy-password\" }) { id hasPassword } } }",
        "variables": { "email": email }
      }),
    )
    .await;
    if accepted.get("errors").is_some() {
      return Err(std::io::Error::other(format!("valid password failed: {accepted}")).into());
    }
    if accepted["data"]["admin"]["createUser"]["hasPassword"] != true {
      return Err(std::io::Error::other(format!("created user has no password: {accepted}")).into());
    }
    accepted["data"]["admin"]["createUser"]["id"]
      .as_str()
      .ok_or_else(|| std::io::Error::other("created user id missing"))?
      .parse::<Uuid>()
      .map_err(|error| std::io::Error::other(format!("invalid created user UUID: {error}")))?;
    Ok(())
  }
  .await;

  if let Some(user_id) = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email = $1")
    .bind(&email)
    .fetch_optional(&pool)
    .await
    .expect("find policy-test user for cleanup")
  {
    sqlx::query("DELETE FROM workspaces WHERE owner_user_id = $1")
      .bind(user_id)
      .execute(&pool)
      .await
      .expect("delete policy-test workspace");
    helpers::cleanup_users(&pool, &[user_id]).await;
  }
  helpers::cleanup_users(&pool, &[admin_id]).await;
  if let Some(policy) = previous_policy {
    sqlx::query("UPDATE app_configs SET value = $1, updated_at = now() WHERE id = 'auth.password_requirements'")
      .bind(policy)
      .execute(&pool)
      .await
      .expect("restore password policy");
  } else {
    sqlx::query("DELETE FROM app_configs WHERE id = 'auth.password_requirements'")
      .execute(&pool)
      .await
      .expect("remove password policy");
  }
  result.expect("persisted password policy contract");
}
