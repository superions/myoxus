//! P-SRV-P0-AUDIT-03 user-suspension regression coverage.
//!
//! These tests exercise the SQL transaction and the admin GraphQL ingress.
//! Application-level cache barrier behaviour is covered by the auth unit tests
//! because the integration app intentionally does not share a test Redis
//! namespace with every router instance.

use crate::helpers;

use futures_util::future::join_all;
use myoxus_application::{
  api_key::ApiKeyService,
  auth::{AuthError, AuthStore, NewSession},
};
use myoxus_infrastructure::{api_key::SqlxApiKeyStore, auth::SqlxAuthStore};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::Barrier;
use uuid::Uuid;

fn assert_graphql_success(response: &Value, operation: &str) {
  assert!(
    response.get("errors").is_none(),
    "{operation} must succeed, got {response}"
  );
}

async fn count_active_sessions(pool: &PgPool, user_id: Uuid) -> i64 {
  sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL")
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("active session count")
}

async fn count_api_keys(pool: &PgPool, user_id: Uuid) -> i64 {
  sqlx::query_scalar("SELECT COUNT(*) FROM api_keys WHERE user_id = $1")
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("api key count")
}

#[test]
fn api_key_is_rejected_immediately_after_ban() {
  helpers::block_on_large_stack("api-key-is-rejected-immediately-after-ban", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let (_admin_id, admin_session) = helpers::seed_admin(&pool, &auth_store).await;
    let (target_id, target_session) = helpers::seed_user(&pool, &auth_store, "suspend-api-key").await;
    let key_service = ApiKeyService::new(Arc::new(SqlxApiKeyStore::new(pool.clone())));

    let (_record, plaintext) = key_service
      .generate(
        target_id,
        "suspension regression".to_string(),
        vec!["read:docs".to_string()],
        None,
      )
      .await
      .expect("create API key");
    assert!(
      key_service.authenticate(&plaintext).await.is_ok(),
      "key must work before ban"
    );

    let banned = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation Ban($id: String!) { admin { banUser(id: $id) { id disabled } } }",
        "variables": { "id": target_id.to_string() }
      }),
    )
    .await;
    assert_graphql_success(&banned, "banUser");
    assert_eq!(banned["data"]["admin"]["banUser"]["disabled"], true);

    let session = auth_store
      .get_session(target_session)
      .await
      .expect("session lookup")
      .expect("session");
    assert!(session.revoked_at.is_some(), "ban must revoke existing sessions");
    assert_eq!(count_active_sessions(&pool, target_id).await, 0);
    assert_eq!(count_api_keys(&pool, target_id).await, 0);
    assert!(
      matches!(key_service.authenticate(&plaintext).await, Err(AuthError::InvalidToken)),
      "a deleted API key must fail closed immediately"
    );

    let enabled = helpers::gql(
      &app,
      admin_session,
      json!({
        "query": "mutation Enable($id: String!) { admin { enableUser(id: $id) { id disabled } } }",
        "variables": { "id": target_id.to_string() }
      }),
    )
    .await;
    assert_graphql_success(&enabled, "enableUser");
    assert_eq!(enabled["data"]["admin"]["enableUser"]["disabled"], false);
    assert!(
      matches!(key_service.authenticate(&plaintext).await, Err(AuthError::InvalidToken)),
      "enableUser must not revive deleted API keys"
    );
    assert!(
      auth_store
        .create_session(NewSession {
          id: Uuid::new_v4(),
          user_id: target_id,
          csrf_token: "new-session-after-enable".to_string(),
          user_agent: None,
          ip_address: None,
          expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
          refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
          created_at: chrono::Utc::now(),
        })
        .await
        .is_ok(),
      "an enabled user may create a new session"
    );
    assert!(
      key_service
        .generate(target_id, "new key after enable".to_string(), vec![], None)
        .await
        .is_ok(),
      "an enabled user may create a new API key"
    );

    helpers::cleanup_users(&pool, &[target_id, _admin_id]).await;
  });
}

#[test]
fn suspension_transaction_rolls_back_status_sessions_and_keys() {
  helpers::block_on_large_stack("suspension-transaction-rollback", || async {
    let pool = helpers::setup_pool().await;
    let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
    let user_id = helpers::create_user(&pool, "suspend-rollback", false).await;
    let session_id = helpers::create_session(&auth_store, user_id).await;
    let key_service = ApiKeyService::new(Arc::new(SqlxApiKeyStore::new(pool.clone())));
    key_service
      .generate(user_id, "rollback".to_string(), vec![], None)
      .await
      .expect("API key");

    // Inject a failure after users and sessions have been touched. The
    // production transaction must roll both writes back when key deletion
    // fails; the trigger is scoped to this test user only.
    let suffix = user_id.simple().to_string();
    let function_name = format!("myoxus_test_suspend_failure_{suffix}");
    let trigger_name = format!("myoxus_test_suspend_trigger_{suffix}");
    sqlx::query(&format!(
      r#"CREATE FUNCTION "{function_name}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           IF OLD.user_id = '{user_id}'::uuid THEN
             RAISE EXCEPTION 'intentional suspension rollback test failure';
           END IF;
           RETURN OLD;
         END;
         $$"#
    ))
    .execute(&pool)
    .await
    .expect("create rollback trigger function");
    sqlx::query(&format!(
      r#"CREATE TRIGGER "{trigger_name}" BEFORE DELETE ON api_keys
         FOR EACH ROW EXECUTE FUNCTION "{function_name}"()"#
    ))
    .execute(&pool)
    .await
    .expect("create rollback trigger");

    let result = auth_store.commit_user_suspension(user_id, chrono::Utc::now()).await;

    sqlx::query(&format!(r#"DROP TRIGGER "{trigger_name}" ON api_keys"#))
      .execute(&pool)
      .await
      .expect("drop rollback trigger");
    sqlx::query(&format!(r#"DROP FUNCTION "{function_name}""#))
      .execute(&pool)
      .await
      .expect("drop rollback trigger function");

    assert!(
      result.is_err(),
      "the injected delete failure must abort the transaction"
    );
    let status: String = sqlx::query_scalar("SELECT status FROM users WHERE id = $1")
      .bind(user_id)
      .fetch_one(&pool)
      .await
      .expect("user status");
    assert_eq!(status, "active", "user status must roll back");
    let revoked: Option<chrono::DateTime<chrono::Utc>> =
      sqlx::query_scalar("SELECT revoked_at FROM sessions WHERE id = $1")
        .bind(session_id)
        .fetch_one(&pool)
        .await
        .expect("session state");
    assert!(revoked.is_none(), "session revoke must roll back");
    assert_eq!(
      count_api_keys(&pool, user_id).await,
      1,
      "API-key deletion must roll back"
    );

    helpers::cleanup_users(&pool, &[user_id]).await;
  });
}

#[test]
fn concurrent_session_create_is_revoked_or_rejected() {
  helpers::block_on_large_stack("concurrent-session-creation-never-succeeds", || async {
    let pool = helpers::setup_pool().await;
    let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
    let user_id = helpers::create_user(&pool, "suspend-session-race", false).await;
    let barrier = Arc::new(Barrier::new(17));

    let suspension_store = auth_store.clone();
    let suspension_barrier = barrier.clone();
    let suspension = tokio::spawn(async move {
      suspension_barrier.wait().await;
      suspension_store
        .commit_user_suspension(user_id, chrono::Utc::now())
        .await
        .expect("suspend user");
    });

    let creates = (0..16)
      .map(|index| {
        let store = auth_store.clone();
        let barrier = barrier.clone();
        tokio::spawn(async move {
          barrier.wait().await;
          store
            .create_session(NewSession {
              id: Uuid::new_v4(),
              user_id,
              csrf_token: format!("race-session-{index}"),
              user_agent: None,
              ip_address: None,
              expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
              refresh_after: chrono::Utc::now() + chrono::Duration::minutes(30),
              created_at: chrono::Utc::now(),
            })
            .await
        })
      })
      .collect::<Vec<_>>();

    suspension.await.expect("suspension task");
    let results = join_all(creates).await;
    for result in results {
      let session_result = result.expect("session task");
      if let Ok(session) = session_result {
        assert!(
          session.revoked_at.is_some()
            || sqlx::query_scalar::<_, bool>("SELECT revoked_at IS NOT NULL FROM sessions WHERE id = $1",)
              .bind(session.id)
              .fetch_one(&pool)
              .await
              .expect("session revocation state"),
          "a session admitted before the suspension lock must be revoked by the same transaction"
        );
      } else {
        assert!(
          matches!(session_result, Err(AuthError::AuthenticationRequired)),
          "post-suspension session creation must fail closed"
        );
      }
    }
    assert_eq!(count_active_sessions(&pool, user_id).await, 0);
    helpers::cleanup_users(&pool, &[user_id]).await;
  });
}

#[test]
fn concurrent_api_key_create_is_deleted_or_rejected() {
  helpers::block_on_large_stack("concurrent-api-key-creation-never-succeeds", || async {
    let pool = helpers::setup_pool().await;
    let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
    let key_store = Arc::new(SqlxApiKeyStore::new(pool.clone()));
    let key_service = Arc::new(ApiKeyService::new(key_store));
    let user_id = helpers::create_user(&pool, "suspend-key-race", false).await;
    let barrier = Arc::new(Barrier::new(17));

    let suspension_store = auth_store.clone();
    let suspension_barrier = barrier.clone();
    let suspension = tokio::spawn(async move {
      suspension_barrier.wait().await;
      suspension_store
        .commit_user_suspension(user_id, chrono::Utc::now())
        .await
        .expect("suspend user");
    });

    let creates = (0..16)
      .map(|index| {
        let service = key_service.clone();
        let barrier = barrier.clone();
        tokio::spawn(async move {
          barrier.wait().await;
          service
            .generate(
              user_id,
              format!("race-key-{index}"),
              vec!["read:docs".to_string()],
              None,
            )
            .await
        })
      })
      .collect::<Vec<_>>();

    suspension.await.expect("suspension task");
    let results = join_all(creates).await;
    for result in results {
      let key_result = result.expect("API-key task");
      if let Err(error) = key_result {
        assert!(
          matches!(error, AuthError::InvalidToken),
          "post-suspension API-key creation must fail without exposing user state"
        );
      }
    }
    assert_eq!(count_api_keys(&pool, user_id).await, 0);
    helpers::cleanup_users(&pool, &[user_id]).await;
  });
}

#[test]
fn sql_suspension_commit_returns_only_non_secret_credential_ids() {
  helpers::block_on_large_stack("sql-suspension-commit-projection", || async {
    let pool = helpers::setup_pool().await;
    let auth_store = Arc::new(SqlxAuthStore::from_pool(pool.clone()));
    let user_id = helpers::create_user(&pool, "suspend-commit-projection", false).await;
    let session_id = helpers::create_session(&auth_store, user_id).await;
    let key_service = ApiKeyService::new(Arc::new(SqlxApiKeyStore::new(pool.clone())));
    let (key_record, _plaintext) = key_service
      .generate(user_id, "projection".to_string(), vec![], None)
      .await
      .expect("API key");

    let commit = auth_store
      .commit_user_suspension(user_id, chrono::Utc::now())
      .await
      .expect("suspension commit");
    assert_eq!(commit.user.id, user_id);
    assert!(commit.user.disabled);
    assert_eq!(commit.revoked_session_ids, vec![session_id]);
    assert_eq!(commit.deleted_api_key_ids, vec![key_record.id]);
    assert_eq!(count_active_sessions(&pool, user_id).await, 0);
    assert_eq!(count_api_keys(&pool, user_id).await, 0);
    helpers::cleanup_users(&pool, &[user_id]).await;
  });
}
