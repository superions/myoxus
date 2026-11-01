// SPDX-License-Identifier: AGPL-3.0-or-later
//! P83-C-03: CalDAV sync mock-server integration test.
//!
//! Invariant (INV-CALDAV-SYNC-01):
//!   When a CalDAV account is configured with a `caldavUrl` pointing at a
//!   minimal mock CalDAV server (PROPFIND + REPORT handlers) and a matching
//!   subscription row exists, calling `CalDavSyncService::run_sync()` must
//!   result in ≥ 1 row in `calendar_events` for that account.
//!
//! The mock server runs on a random port inside the test process (no separate
//! container), using axum's `TcpListener::bind("127.0.0.1:0")`.

use crate::helpers;

use std::sync::Arc;

use axum::{Router, extract::Request, response::Response};
use myoxus_application::ports::RedisPort;
use myoxus_infrastructure::caldav::{CalDavSyncService, PlaintextCredentialDecryptor};
use myoxus_infrastructure::calendar::SqlxCalendarRepository;
use myoxus_infrastructure::redis::{InMemoryRedisAdapter, RedisAdapter};
use myoxus_infrastructure::redis_lease::RedisLease;
use tokio::net::TcpListener;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Minimal mock CalDAV server (PROPFIND + REPORT → 207 Multi-Status XML)
// ---------------------------------------------------------------------------

/// PROPFIND response: one calendar at `/calendar/` with a unique ctag.
fn propfind_response(port: u16) -> String {
  format!(
    r#"<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>http://127.0.0.1:{port}/calendar/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Test Calendar</D:displayname>
        <CS:getctag>mock-ctag-1</CS:getctag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#
  )
}

/// REPORT response: one VEVENT with a fixed UID.
fn report_response() -> &'static str {
  r#"<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/calendar/test-event.ics</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>"mock-etag-1"</D:getetag>
        <C:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//MockCalDAV//EN
BEGIN:VEVENT
UID:inv-caldav-sync-01@mock
DTSTART:20260101T120000Z
DTEND:20260101T130000Z
SUMMARY:Mock CalDAV Event
END:VEVENT
END:VCALENDAR</C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#
}

/// Start the mock CalDAV server, return the bound port.
async fn start_mock_caldav_server() -> u16 {
  let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind mock caldav port");
  let port = listener.local_addr().expect("local_addr").port();

  let port_clone = port;
  let app = Router::new().fallback(move |req: Request| {
    let port = port_clone;
    async move {
      let method = req.method().to_string();
      if method == "PROPFIND" {
        Response::builder()
          .status(207)
          .header("content-type", "application/xml; charset=utf-8")
          .body(axum::body::Body::from(propfind_response(port)))
          .expect("propfind response")
      } else {
        // REPORT
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        Response::builder()
          .status(207)
          .header("content-type", "application/xml; charset=utf-8")
          .body(axum::body::Body::from(report_response()))
          .expect("report response")
      }
    }
  });

  tokio::spawn(async move {
    axum::serve(listener, app).await.ok();
  });

  port
}

// ---------------------------------------------------------------------------
// INV-CALDAV-SYNC-01
// ---------------------------------------------------------------------------

/// INV-CALDAV-SYNC-01: CalDavSyncService must upsert ≥ 1 event into
/// `calendar_events` when the mock CalDAV server returns one VEVENT.
#[tokio::test]
async fn inv_caldav_sync_01_events_land_in_db_after_sync() {
  let pool = helpers::setup_pool().await;

  // Pre-cleanup: remove stale calendar accounts from previous test runs that
  // panicked before cleanup. run_sync() picks up ALL accounts, so stale rows
  // cause spurious errors:
  //  1. Orphaned accounts (user deleted): "no credentials configured"
  //  2. Stale 127.0.0.1 mock server accounts (server closed): network errors
  //  3. No-credential accounts left by calendar recurrence/write tests
  sqlx::query("DELETE FROM calendar_accounts WHERE user_id NOT IN (SELECT id FROM users)")
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM calendar_accounts WHERE config->>'caldavUrl' LIKE 'http://127.0.0.1:%'")
    .execute(&pool)
    .await
    .ok();
  // Remove accounts with no credentials at all (empty config, no tokens):
  // these are stale from calendar tests that panic'd before cleanup.
  sqlx::query(
    "DELETE FROM calendar_accounts
     WHERE access_token_ciphertext IS NULL
       AND refresh_token_ciphertext IS NULL
       AND config::text = '{}'",
  )
  .execute(&pool)
  .await
  .ok();

  let user_id = helpers::create_user(&pool, "caldav-sync-test", false).await;
  let port = start_mock_caldav_server().await;

  // Insert calendar_account pointing at the mock server.
  // remote_account_id = username for Basic auth (password in access_token_ciphertext).
  let base_url = format!("http://127.0.0.1:{port}");
  let calendar_url = format!("http://127.0.0.1:{port}/calendar/");
  let account_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_accounts
       (user_id, provider, remote_account_id, access_token_ciphertext, config)
     VALUES ($1, 'caldav', $2, $3, $4)
     RETURNING id",
  )
  .bind(user_id)
  .bind(format!("testuser-{}", Uuid::new_v4()))
  .bind("testpassword")
  .bind(serde_json::json!({ "caldavUrl": base_url }))
  .fetch_one(&pool)
  .await
  .expect("insert calendar_account");

  // Insert calendar_subscription for the mock calendar.
  let _sub_id: Uuid = sqlx::query_scalar(
    "INSERT INTO calendar_subscriptions (account_id, remote_calendar_id, updated_at)
     VALUES ($1, $2, now())
     RETURNING id",
  )
  .bind(account_id)
  .bind(&calendar_url)
  .fetch_one(&pool)
  .await
  .expect("insert calendar_subscription");

  // Redis acquisition failure is a technical run error and must not start a
  // provider request or a local replacement path.
  let unavailable_redis: Arc<dyn RedisPort> =
    Arc::new(RedisAdapter::new("redis://127.0.0.1:1", "caldav-unavailable").expect("unreachable Redis adapter"));
  let unavailable_svc = CalDavSyncService::new(
    Arc::new(SqlxCalendarRepository::new(pool.clone())),
    Arc::new(PlaintextCredentialDecryptor),
    unavailable_redis,
    7,
    90,
    None,
  );
  assert!(
    unavailable_svc.run_sync().await.is_err(),
    "unavailable mandatory Redis coordination must abort the run"
  );
  let unavailable_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE account_id = $1")
    .bind(account_id)
    .fetch_one(&pool)
    .await
    .expect("unavailable calendar_events count query");
  assert_eq!(
    unavailable_count, 0,
    "Redis acquisition failure must not enter a local fallback"
  );

  // A foreign distributed owner must prevent all provider and persistence
  // work. A process-local lock implementation would ignore this holder and
  // make the assertion below fail.
  let lock_redis: Arc<dyn RedisPort> = Arc::new(InMemoryRedisAdapter::new("caldav-integration"));
  let lease_key = format!("calendar-sync:caldav:{account_id}");
  let foreign_holder = RedisLease::acquire(lock_redis.clone(), lease_key.clone(), 300)
    .await
    .expect("lease transport")
    .expect("foreign holder");
  let blocked_svc = CalDavSyncService::new(
    Arc::new(SqlxCalendarRepository::new(pool.clone())),
    Arc::new(PlaintextCredentialDecryptor),
    lock_redis.clone(),
    7,
    90,
    None,
  );
  let blocked = blocked_svc.run_sync().await.expect("contended lease is not an error");
  assert_eq!(
    blocked.events_upserted, 0,
    "a foreign account lease must prevent materialization"
  );
  let blocked_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE account_id = $1")
    .bind(account_id)
    .fetch_one(&pool)
    .await
    .expect("blocked calendar_events count query");
  assert_eq!(
    blocked_count, 0,
    "a contended account must have no persistence side effects"
  );
  drop(foreign_holder);
  for _ in 0..20 {
    if lock_redis
      .get_string(&lease_key)
      .await
      .expect("read released lease")
      .is_none()
    {
      break;
    }
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
  }

  // Two independently constructed services share only Redis coordination.
  // The delayed REPORT keeps the winner active while the contender reaches
  // acquisition, so exactly one service can materialize the account.
  let svc_a = CalDavSyncService::new(
    Arc::new(SqlxCalendarRepository::new(pool.clone())),
    Arc::new(PlaintextCredentialDecryptor),
    lock_redis.clone(),
    7,
    90,
    None,
  );
  let svc_b = CalDavSyncService::new(
    Arc::new(SqlxCalendarRepository::new(pool.clone())),
    Arc::new(PlaintextCredentialDecryptor),
    lock_redis,
    7,
    90,
    None,
  );
  let (result_a, result_b) = tokio::join!(svc_a.run_sync(), svc_b.run_sync());
  let result_a = result_a.expect("first distributed lease");
  let result_b = result_b.expect("second distributed lease");
  let materializing_services = [result_a.events_upserted, result_b.events_upserted]
    .into_iter()
    .filter(|count| *count > 0)
    .count();
  assert_eq!(
    materializing_services, 1,
    "exactly one service may materialize a shared CalDAV account"
  );
  let result = if result_a.events_upserted > 0 {
    result_a
  } else {
    result_b
  };

  // INV-CALDAV-SYNC-01: at least 1 event must be in calendar_events.
  assert_eq!(
    result.errors.len(),
    0,
    "INV-CALDAV-SYNC-01: sync must complete without errors, got: {:?}",
    result.errors
  );
  assert!(
    result.events_upserted >= 1,
    "INV-CALDAV-SYNC-01: sync must upsert ≥ 1 event, got: {}",
    result.events_upserted
  );

  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE account_id = $1")
    .bind(account_id)
    .fetch_one(&pool)
    .await
    .expect("calendar_events count query");
  assert!(
    count >= 1,
    "INV-CALDAV-SYNC-01: calendar_events must have ≥ 1 row for account {account_id}, got: {count}"
  );

  // Cleanup.
  sqlx::query("DELETE FROM calendar_events WHERE account_id = $1")
    .bind(account_id)
    .execute(&pool)
    .await
    .ok();
  sqlx::query("DELETE FROM calendar_accounts WHERE id = $1")
    .bind(account_id)
    .execute(&pool)
    .await
    .ok();
  helpers::cleanup_users(&pool, &[user_id]).await;
}
