//! Multi-instance session-isolation integration tests (P84-I-17).
//!
//! Verifies that sessions stored in PostgreSQL are equally valid across all
//! server instances, and that deleting a session from the DB immediately
//! invalidates it on every instance (since sessions are never cached in moka
//! — they are always read from the DB on first use per request path).
//!
//! Both instances use cold caches, ensuring every authentication check goes
//! straight to the DB.  This validates the DB-level consistency invariant for
//! session management in multi-instance deployments.

use crate::helpers;

use serde_json::json;
use std::sync::OnceLock;
use tokio::sync::Mutex;

fn session_lock() -> &'static Mutex<()> {
  static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

// ---------------------------------------------------------------------------
// INV-MI-07
// ---------------------------------------------------------------------------

/// INV-MI-07: A session created on instance A (i.e. seeded into the shared DB)
/// must be usable on instance B without any cross-instance coordination.
///
/// Sessions are stored in PostgreSQL and every request path reads from the DB
/// on a cache miss.  Because B starts cold, its first auth check goes to the
/// DB and succeeds.
#[tokio::test]
async fn inv_mi07_session_valid_on_b_when_created_on_a() {
  let _lock = session_lock().lock().await;
  let (app_a, app_b, pool, _) = helpers::multi_instance_setup().await;
  let (admin_id, session_id) = helpers::seed_admin_db(&pool).await;

  // Confirm session works on A
  let resp_a = helpers::gql(&app_a, session_id, json!({"query": "query { currentUser { id } }"})).await;
  assert!(resp_a.get("errors").is_none(), "currentUser on A failed: {resp_a}");
  assert!(
    !resp_a["data"]["currentUser"]["id"].is_null(),
    "INV-MI-07: currentUser.id must be set on A"
  );

  // Same session must work on B (cold cache → DB read)
  let resp_b = helpers::gql(&app_b, session_id, json!({"query": "query { currentUser { id } }"})).await;
  assert!(resp_b.get("errors").is_none(), "currentUser on B failed: {resp_b}");
  assert_eq!(
    resp_b["data"]["currentUser"]["id"], resp_a["data"]["currentUser"]["id"],
    "INV-MI-07: session created on A must yield the same user on B"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}

// ---------------------------------------------------------------------------
// INV-MI-08
// ---------------------------------------------------------------------------

/// INV-MI-08: After a session is deleted from the DB (simulating logout),
/// instance B must no longer accept it — no stale-session risk.
///
/// Both instances have cold caches.  After deletion the next request on B
/// goes to the DB, finds no session, and returns an auth error / null user.
#[tokio::test]
async fn inv_mi08_deleted_session_rejected_on_b() {
  let _lock = session_lock().lock().await;
  let (_, app_b, pool, _) = helpers::multi_instance_setup().await;
  let (admin_id, session_id) = helpers::seed_admin_db(&pool).await;

  // Delete the session directly from the DB (table is named `sessions`)
  sqlx::query("DELETE FROM sessions WHERE id = $1")
    .bind(session_id)
    .execute(&pool)
    .await
    .expect("delete session");

  // B must reject the now-invalidated session
  let resp_b = helpers::gql(&app_b, session_id, json!({"query": "query { currentUser { id } }"})).await;

  let is_rejected =
    resp_b.get("errors").is_some() || resp_b["data"]["currentUser"].is_null() || resp_b["data"].is_null();
  assert!(
    is_rejected,
    "INV-MI-08: deleted session must be rejected on B, got: {resp_b}"
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}
