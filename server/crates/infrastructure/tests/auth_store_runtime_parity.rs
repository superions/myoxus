//! Parity tests comparing in-memory and SQLx auth-store implementations.
use chrono::{Duration, Utc};
use futures_util::FutureExt;
use myoxus_application::auth::{AuthStore, MagicLinkOtp, NewConnectedAccount, NewSession};
use myoxus_infrastructure::auth::SqlxAuthStore;
use sqlx::PgPool;
use std::panic::{AssertUnwindSafe, resume_unwind};
use uuid::Uuid;

async fn setup_pool() -> PgPool {
  let database_url = std::env::var("DATABASE_URL")
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  let pool = PgPool::connect(&database_url).await.expect("db connect");
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrations");
  pool
}

async fn seed_user(pool: &PgPool) -> Uuid {
  let user_id = Uuid::new_v4();
  sqlx::query(
    r#"
    INSERT INTO users (id, email, name, is_admin, email_verified_at)
    VALUES ($1, $2, $3, FALSE, now())
    "#,
  )
  .bind(user_id)
  .bind(format!("runtime_parity_{}@example.com", user_id))
  .bind("Runtime Parity User")
  .execute(pool)
  .await
  .expect("insert user");
  user_id
}

#[tokio::test]
async fn session_refresh_roundtrip_works_against_postgres() {
  let pool = setup_pool().await;
  let user_id = seed_user(&pool).await;
  let outcome = AssertUnwindSafe(async {
    let store = SqlxAuthStore::from_pool(pool.clone());

    let session = store
      .create_session(NewSession {
        id: Uuid::new_v4(),
        user_id,
        csrf_token: "csrf".to_string(),
        user_agent: Some("agent".to_string()),
        ip_address: Some("127.0.0.1".to_string()),
        expires_at: Utc::now() + Duration::minutes(30),
        refresh_after: Utc::now() + Duration::minutes(5),
        created_at: Utc::now(),
      })
      .await
      .expect("create session");

    let new_expires = Utc::now() + Duration::hours(2);
    let new_refresh_after = Utc::now() + Duration::hours(1);
    store
      .refresh_session(session.id, new_expires, new_refresh_after)
      .await
      .expect("refresh session");

    let reloaded = store
      .get_session(session.id)
      .await
      .expect("load refreshed session")
      .expect("session exists");
    assert!(
      (reloaded.expires_at - new_expires).num_milliseconds().abs() < 1_000,
      "expires_at mismatch: got {}, expected {}",
      reloaded.expires_at,
      new_expires
    );
    assert!(
      (reloaded.refresh_after - new_refresh_after).num_milliseconds().abs() < 1_000,
      "refresh_after mismatch: got {}, expected {}",
      reloaded.refresh_after,
      new_refresh_after
    );
  })
  .catch_unwind()
  .await;
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("remove owned parity fixture");
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}

#[tokio::test]
async fn connected_account_roundtrip_works_against_postgres() {
  let pool = setup_pool().await;
  let user_id = seed_user(&pool).await;
  let outcome = AssertUnwindSafe(async {
    let store = SqlxAuthStore::from_pool(pool.clone());

    let account = store
      .create_connected_account(NewConnectedAccount {
        user_id,
        provider: "google".to_string(),
        provider_account_id: format!("google-{}", Uuid::new_v4()),
        access_token: Some("access-v1".to_string()),
        refresh_token: Some("refresh-v1".to_string()),
        expires_at: Some(Utc::now() + Duration::days(30)),
      })
      .await
      .expect("create connected account");

    let loaded = store
      .get_connected_account(&account.provider, &account.provider_account_id)
      .await
      .expect("get connected account")
      .expect("connected account exists");
    assert_eq!(loaded.access_token.as_deref(), Some("access-v1"));
    assert_eq!(loaded.refresh_token.as_deref(), Some("refresh-v1"));

    let next_exp = Utc::now() + Duration::days(60);
    store
      .update_connected_account(
        account.id,
        Some("access-v2".to_string()),
        Some("refresh-v2".to_string()),
        Some(next_exp),
      )
      .await
      .expect("update connected account");

    let updated = store
      .get_connected_account(&account.provider, &account.provider_account_id)
      .await
      .expect("reload connected account")
      .expect("connected account exists");
    assert_eq!(updated.access_token.as_deref(), Some("access-v2"));
    assert_eq!(updated.refresh_token.as_deref(), Some("refresh-v2"));
    let updated_exp = updated.expires_at.expect("expires_at");
    assert!(
      (updated_exp - next_exp).num_milliseconds().abs() < 1_000,
      "expires_at mismatch: got {}, expected {}",
      updated_exp,
      next_exp
    );
  })
  .catch_unwind()
  .await;
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("remove owned parity fixture");
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}

#[tokio::test]
async fn create_session_is_retry_safe_for_same_session_id() {
  let pool = setup_pool().await;
  let user_id = seed_user(&pool).await;
  let outcome = AssertUnwindSafe(async {
    let store = SqlxAuthStore::from_pool(pool.clone());

    let session_id = Uuid::new_v4();
    let created_at = Utc::now();
    let first = store
      .create_session(NewSession {
        id: session_id,
        user_id,
        csrf_token: "csrf-1".to_string(),
        user_agent: Some("agent-a".to_string()),
        ip_address: Some("127.0.0.1".to_string()),
        expires_at: Utc::now() + Duration::minutes(20),
        refresh_after: Utc::now() + Duration::minutes(5),
        created_at,
      })
      .await
      .expect("create first session");
    assert_eq!(first.id, session_id);

    let second = store
      .create_session(NewSession {
        id: session_id,
        user_id,
        csrf_token: "csrf-2".to_string(),
        user_agent: Some("agent-b".to_string()),
        ip_address: Some("127.0.0.2".to_string()),
        expires_at: Utc::now() + Duration::minutes(45),
        refresh_after: Utc::now() + Duration::minutes(15),
        created_at,
      })
      .await
      .expect("retry create session");

    assert_eq!(second.id, session_id);
    assert_eq!(second.csrf_token, "csrf-2");
    assert_eq!(second.user_agent.as_deref(), Some("agent-b"));
    assert!(
      second
        .ip_address
        .as_deref()
        .map(|value| value.starts_with("127.0.0.2"))
        .unwrap_or(false),
      "expected ip address to start with 127.0.0.2, got {:?}",
      second.ip_address
    );
  })
  .catch_unwind()
  .await;
  sqlx::query("DELETE FROM users WHERE id=$1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("remove owned parity fixture");
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}

#[tokio::test]
async fn magic_link_otp_upsert_replaces_the_active_email_record() {
  let pool = setup_pool().await;
  let email = format!("runtime_magic_{}@example.com", Uuid::new_v4());
  let outcome = AssertUnwindSafe(async {
    let store = SqlxAuthStore::from_pool(pool.clone());

    for otp in ["123456", "654321"] {
      let token = store
        .create_verification_token(
          None,
          "SignIn",
          &Uuid::new_v4().to_string(),
          Some(&email),
          Utc::now() + Duration::minutes(30),
          None,
        )
        .await
        .expect("create bound OTP verification record");
      store
        .upsert_magic_link_otp(MagicLinkOtp {
          email: email.clone(),
          otp: otp.to_string(),
          verification_token_id: token.id,
          client_nonce: Some("runtime-parity".to_string()),
          expires_at: Utc::now() + Duration::minutes(30),
        })
        .await
        .expect("upsert magic-link OTP");
    }

    assert!(
      store
        .get_magic_link_otp(&email, "123456")
        .await
        .expect("read replaced magic-link OTP")
        .is_none(),
      "the first OTP must no longer be accepted after replacement"
    );
    assert!(
      store
        .get_magic_link_otp(&email, "654321")
        .await
        .expect("read active magic-link OTP")
        .is_some(),
      "the replacement OTP must remain active"
    );
  })
  .catch_unwind()
  .await;
  sqlx::query("DELETE FROM magic_link_otps WHERE email = $1")
    .bind(&email)
    .execute(&pool)
    .await
    .expect("clean up magic-link OTP fixture");
  sqlx::query("DELETE FROM verification_tokens WHERE email=$1")
    .bind(&email)
    .execute(&pool)
    .await
    .expect("clean up verification fixture");
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}

#[derive(Debug)]
struct NoCacheBarrier;

#[async_trait::async_trait]
impl myoxus_application::auth::SessionRevocationBarrier for NoCacheBarrier {
  async fn block(
    &self,
    users: &[Uuid],
  ) -> myoxus_application::auth::AuthResult<Vec<myoxus_application::auth::UserSessionEpoch>> {
    Ok(
      users
        .iter()
        .map(|id| myoxus_application::auth::UserSessionEpoch {
          user_id: *id,
          epoch: None,
        })
        .collect(),
    )
  }
  async fn rollback(&self, _: &[myoxus_application::auth::UserSessionEpoch]) {}
}

#[tokio::test]
async fn email_change_is_atomic_and_serializes_token_consumption() {
  use myoxus_application::auth::AuthError;
  let pool = setup_pool().await;
  let user_id = seed_user(&pool).await;
  let other_id = seed_user(&pool).await;
  let token = format!("email-change-{}", Uuid::new_v4());
  let trigger = format!("email_change_{}", Uuid::new_v4().simple());
  let outcome = AssertUnwindSafe(async {
    let store = SqlxAuthStore::from_pool(pool.clone());
    let original = store.get_user_by_id(user_id).await.expect("user").expect("exists");
    let occupied = store.get_user_by_id(other_id).await.expect("peer").expect("exists");
    let session = store.create_session(NewSession {
      id: Uuid::new_v4(), user_id, csrf_token: "email-change-csrf".into(),
      user_agent: None, ip_address: None, expires_at: Utc::now()+Duration::hours(1),
      refresh_after: Utc::now()+Duration::minutes(5), created_at: Utc::now(),
    }).await.expect("session");
    store.create_verification_token(Some(user_id), "VerifyEmail", &token, None, Utc::now()+Duration::hours(1), None).await.expect("token");
    let barrier = NoCacheBarrier;
    let now = Utc::now();
    assert!(matches!(store.commit_email_change(user_id, "missing", "new@example.test", now, &barrier).await, Err(AuthError::InvalidToken)));
    assert!(matches!(store.commit_email_change(other_id, &token, "new@example.test", now, &barrier).await, Err(AuthError::InvalidToken)));
    assert!(matches!(store.commit_email_change(user_id, &token, &occupied.email, now, &barrier).await, Err(AuthError::ActionForbidden)));
    assert!(matches!(store.commit_email_change(user_id, &token, "new@example.test", now+Duration::hours(2), &barrier).await, Err(AuthError::ExpiredToken)));
    sqlx::query("UPDATE verification_tokens SET kind='ChangePassword' WHERE token_hash=$1").bind(&token).execute(&pool).await.expect("different purpose");
    assert!(matches!(store.commit_email_change(user_id, &token, "new@example.test", now, &barrier).await, Err(AuthError::InvalidToken)));
    sqlx::query("UPDATE verification_tokens SET kind='VerifyEmail' WHERE token_hash=$1").bind(&token).execute(&pool).await.expect("restore purpose");
    sqlx::query("UPDATE users SET status='disabled' WHERE id=$1").bind(user_id).execute(&pool).await.expect("suspend");
    assert!(matches!(store.commit_email_change(user_id, &token, "new@example.test", now, &barrier).await, Err(AuthError::InvalidToken)));
    sqlx::query("UPDATE users SET status='active' WHERE id=$1").bind(user_id).execute(&pool).await.expect("restore active account");
    // Fail the last write, after email and token changes, to prove actual DB
    // rollback rather than only validation before any writes.
    sqlx::query(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned email-change rollback probe'; END $$"))
      .execute(&pool).await.expect("failure function");
    sqlx::query(&format!("CREATE TRIGGER {trigger} BEFORE UPDATE ON sessions FOR EACH ROW WHEN (OLD.user_id = '{user_id}'::uuid) EXECUTE FUNCTION {trigger}()"))
      .execute(&pool).await.expect("failure trigger");
    assert!(store.commit_email_change(user_id, &token, "rollback@example.test", now, &barrier).await.is_err());
    assert_eq!(store.get_user_by_id(user_id).await.expect("user").expect("exists").email, original.email);
    assert!(store.get_verification_token(&token).await.expect("token").expect("exists").used_at.is_none());
    assert!(store.get_session(session.id).await.expect("session").expect("exists").revoked_at.is_none());
    assert_eq!(store.get_user_by_id(user_id).await.expect("user").expect("exists").email_verified_at, original.email_verified_at);
    sqlx::query(&format!("DROP TRIGGER {trigger} ON sessions")).execute(&pool).await.expect("remove failure trigger");
    let first_email = format!("first-{user_id}@example.test");
    let second_email = format!("second-{user_id}@example.test");
    let (first, second) = tokio::join!(
      store.commit_email_change(user_id, &token, &first_email, now, &barrier),
      store.commit_email_change(user_id, &token, &second_email, now, &barrier)
    );
    assert_eq!(usize::from(first.is_ok())+usize::from(second.is_ok()), 1, "one token has one winner");
    let winner = match (first, second) {
      (Ok(commit), Err(AuthError::InvalidToken)) | (Err(AuthError::InvalidToken), Ok(commit)) => commit,
      _ => panic!("duplicate token must be rejected"),
    };
    assert_eq!(winner.revoked_session_ids, vec![session.id]);
    assert_eq!(store.get_user_by_id(user_id).await.expect("user").expect("exists").email, winner.user.email);
    assert!((winner.user.email_verified_at.expect("verified")-now).num_milliseconds().abs() < 1);
    assert!(store.get_verification_token(&token).await.expect("token").expect("exists").used_at.is_some());
    assert!(store.get_session(session.id).await.expect("session").expect("exists").revoked_at.is_some());
  }).catch_unwind().await;
  sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger} ON sessions"))
    .execute(&pool)
    .await
    .expect("cleanup trigger");
  sqlx::query(&format!("DROP FUNCTION IF EXISTS {trigger}()"))
    .execute(&pool)
    .await
    .expect("cleanup function");
  sqlx::query("DELETE FROM verification_tokens WHERE token_hash=$1")
    .bind(&token)
    .execute(&pool)
    .await
    .expect("cleanup token");
  sqlx::query("DELETE FROM users WHERE id=ANY($1)")
    .bind(vec![user_id, other_id])
    .execute(&pool)
    .await
    .expect("cleanup accounts");
  if let Err(panic) = outcome {
    resume_unwind(panic);
  }
}
