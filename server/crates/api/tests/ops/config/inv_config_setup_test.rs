//! Causal integration coverage for setup completion and readiness diagnosis.

use crate::helpers;

use serde_json::json;
use uuid::Uuid;

const SETUP_STATUS_QUERY: &str = r#"
  query SetupStatus {
    serverSetupStatus {
      setupCompleted
      operationalReady
      bootstrapAvailable
      authMethods { method supported usable reasonCode }
      findings { code severity }
    }
  }
"#;

type PreviousSetupConfig = (
  serde_json::Value,
  chrono::DateTime<chrono::Utc>,
  chrono::DateTime<chrono::Utc>,
  Option<Uuid>,
);

async fn isolate_setup_completion(pool: &sqlx::PgPool) -> Option<PreviousSetupConfig> {
  let previous = sqlx::query_as(
    "SELECT value, created_at, updated_at, last_updated_by FROM app_configs WHERE id = 'system.setupCompleted'",
  )
  .fetch_optional(pool)
  .await
  .expect("snapshot existing setup completion state");
  sqlx::query("DELETE FROM app_configs WHERE id = 'system.setupCompleted'")
    .execute(pool)
    .await
    .expect("isolate setup completion state");
  previous
}

async fn cleanup_setup_test(
  pool: &sqlx::PgPool,
  user_ids: &[Uuid],
  admin_id: Uuid,
  previous: Option<PreviousSetupConfig>,
) {
  sqlx::query(
    "DELETE FROM admin_audit_log WHERE event_key = 'config.system.setupCompleted.update' AND actor_user_id = $1",
  )
  .bind(admin_id)
  .execute(pool)
  .await
  .expect("cleanup setup completion audit event");
  match previous {
    Some((value, created_at, updated_at, last_updated_by)) => {
      sqlx::query(
        r#"
          INSERT INTO app_configs (id, value, created_at, updated_at, last_updated_by)
          VALUES ('system.setupCompleted', $1, $2, $3, $4)
          ON CONFLICT (id) DO UPDATE SET
            value = EXCLUDED.value,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at,
            last_updated_by = EXCLUDED.last_updated_by
        "#,
      )
      .bind(value)
      .bind(created_at)
      .bind(updated_at)
      .bind(last_updated_by)
      .execute(pool)
      .await
      .expect("restore setup completion state");
    }
    None => {
      sqlx::query("DELETE FROM app_configs WHERE id = 'system.setupCompleted'")
        .execute(pool)
        .await
        .expect("remove isolated setup completion state");
    }
  }
  sqlx::query("DELETE FROM sessions WHERE user_id = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .expect("cleanup setup test sessions");
  sqlx::query("DELETE FROM users WHERE id = ANY($1)")
    .bind(user_ids)
    .execute(pool)
    .await
    .expect("cleanup setup test users");
}

#[tokio::test]
async fn inv_cfg_setup_status_uses_structured_runtime_contract_and_persisted_completion() {
  let _lock = helpers::SERVER_CONFIG_LOCK
    .get_or_init(|| tokio::sync::Mutex::new(()))
    .lock()
    .await;
  let (app, pool, auth_store) = helpers::setup_app_with_config_override(|config| {
    config.crypto.private_key = "myoxus-change-me-private-key".to_string();
    config.server.origin = "http://127.0.0.1:3001".to_string();
    config.throttle.enabled = false;
    config.mail.smtp_host = None;
  })
  .await;
  let previous_setup_completion = isolate_setup_completion(&pool).await;
  let (regular_user_id, regular_session_id) = helpers::seed_user(&pool, &auth_store, "setup-status-user").await;
  let (admin_id, admin_session_id) = helpers::seed_admin(&pool, &auth_store).await;

  let anonymous = helpers::gql_anon(&app, helpers::gql_query(SETUP_STATUS_QUERY)).await;
  assert!(
    anonymous.get("errors").is_some(),
    "operational setup findings must not be exposed without a session"
  );

  let before = helpers::gql(&app, regular_session_id, helpers::gql_query(SETUP_STATUS_QUERY)).await;
  assert!(before.get("errors").is_none(), "setup status query failed: {before}");
  let before_status = &before["data"]["serverSetupStatus"];
  assert_eq!(before_status["setupCompleted"], false);
  assert_eq!(before_status["operationalReady"], false);

  let method_codes = before_status["authMethods"]
    .as_array()
    .expect("authMethods array")
    .iter()
    .map(|method| method["method"].as_str().expect("method code"))
    .collect::<Vec<_>>();
  assert_eq!(
    method_codes,
    vec!["password", "magic_link", "google", "github", "oidc", "apple"],
    "GraphQL must project the stable complete method set in deterministic order"
  );
  assert!(
    before_status["authMethods"]
      .as_array()
      .expect("authMethods array")
      .iter()
      .all(|method| method["supported"] == true),
    "all currently implemented methods must be marked supported"
  );

  let finding_codes = before_status["findings"]
    .as_array()
    .expect("findings array")
    .iter()
    .map(|finding| finding["code"].as_str().expect("finding code"))
    .collect::<Vec<_>>();
  assert!(finding_codes.contains(&"CRYPTO_UNSAFE"));
  assert!(finding_codes.contains(&"SERVER_ORIGIN_INVALID"));
  assert!(finding_codes.contains(&"SMTP_UNAVAILABLE"));
  assert!(finding_codes.contains(&"RATE_LIMIT_DISABLED"));

  let update = helpers::gql(
    &app,
    admin_session_id,
    json!({
      "query": r#"
        mutation CompleteSetup($updates: [UpdateAppConfigInput!]!) {
          admin { adminUpdateConfig(updates: $updates) { applied fieldErrors { path message } } }
        }
      "#,
      "variables": {
        "updates": [{ "module": "system", "key": "setupCompleted", "value": true }]
      }
    }),
  )
  .await;
  assert!(
    update.get("errors").is_none(),
    "setup completion mutation failed: {update}"
  );
  assert_eq!(update["data"]["admin"]["adminUpdateConfig"]["applied"], true);
  assert_eq!(update["data"]["admin"]["adminUpdateConfig"]["fieldErrors"], json!([]));

  let after = helpers::gql(&app, regular_session_id, helpers::gql_query(SETUP_STATUS_QUERY)).await;
  assert!(
    after.get("errors").is_none(),
    "post-completion setup query failed: {after}"
  );
  let after_status = &after["data"]["serverSetupStatus"];
  assert_eq!(after_status["setupCompleted"], true);
  assert_eq!(
    after_status["operationalReady"], false,
    "persisted wizard completion must not hide critical runtime findings"
  );
  assert!(
    after_status["findings"]
      .as_array()
      .expect("post-completion findings")
      .iter()
      .any(|finding| finding["code"] == "CRYPTO_UNSAFE"),
    "critical findings must remain visible after completion"
  );

  cleanup_setup_test(&pool, &[regular_user_id, admin_id], admin_id, previous_setup_completion).await;
}
