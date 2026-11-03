// SPDX-License-Identifier: AGPL-3.0-or-later
//! P83-C-03: CalDAV sync mock-server integration test.
//!
//! Invariant (INV-CALDAV-SYNC-01):
//!   When a CalDAV account is configured with a `caldavUrl` pointing at a
//!   minimal mock CalDAV server (PROPFIND + REPORT handlers) and a matching
//!   subscription row exists, calling `CalDavSyncService::run_sync()` must
//!   result in ≥ 1 row in `calendar_events` for that account.
//!   Continuing recurrence projects beyond two years; an unsupported replacement
//!   preserves its raw rule and previous instances without acknowledging the ctag.
//!
//! The mock server runs on a random port inside the test process (no separate
//! container), using axum's `TcpListener::bind("127.0.0.1:0")`.

use crate::helpers;

use std::panic::AssertUnwindSafe;
use std::sync::{
  Arc,
  atomic::{AtomicBool, Ordering},
};

use axum::{Router, extract::Request, response::Response};
use futures_util::FutureExt;
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
fn propfind_response(port: u16, revision: u8) -> String {
  format!(
    r#"<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>http://127.0.0.1:{port}/calendar/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Test Calendar</D:displayname>
        <CS:getctag>mock-ctag-{revision}</CS:getctag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#
  )
}

/// Keep DTSTART older than two years so sync must exercise the continuing rule,
/// rather than accidentally passing only the calculator's former fixed horizon.
fn report_response(unsupported: bool) -> String {
  let start = chrono::Utc::now().date_naive().and_hms_opt(12, 0, 0).unwrap().and_utc() - chrono::Duration::days(1095);
  let end = start + chrono::Duration::hours(1);
  let start = start.format("%Y%m%dT%H%M%SZ");
  let end = end.format("%Y%m%dT%H%M%SZ");
  let rule = if unsupported {
    "FREQ=MONTHLY;BYSETPOS=1"
  } else {
    "FREQ=DAILY"
  };
  let key = chrono::Utc::now().date_naive().and_hms_opt(12, 0, 0).unwrap().and_utc() + chrono::Duration::days(2);
  let moved = key + chrono::Duration::hours(4);
  let cancelled = key + chrono::Duration::days(1);
  let exceptions = format!(
    "BEGIN:VEVENT\nUID:inv-caldav-sync-01@mock\nRECURRENCE-ID:{}\nDTSTART:{}\nDTEND:{}\nSUMMARY:Moved source exception\nEND:VEVENT\nBEGIN:VEVENT\nUID:inv-caldav-sync-01@mock\nRECURRENCE-ID:{}\nDTSTART:{}\nDTEND:{}\nSTATUS:CANCELLED\nEND:VEVENT",
    key.format("%Y%m%dT%H%M%SZ"),
    moved.format("%Y%m%dT%H%M%SZ"),
    (moved + chrono::Duration::hours(1)).format("%Y%m%dT%H%M%SZ"),
    cancelled.format("%Y%m%dT%H%M%SZ"),
    cancelled.format("%Y%m%dT%H%M%SZ"),
    (cancelled + chrono::Duration::hours(1)).format("%Y%m%dT%H%M%SZ")
  );
  format!(
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
{exceptions}
BEGIN:VEVENT
UID:inv-caldav-sync-01@mock
DTSTART:{start}
DTEND:{end}
RRULE:{rule}
SUMMARY:Mock CalDAV Event
END:VEVENT
END:VCALENDAR</C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#
  )
}

struct MockCalDav {
  port: u16,
  unsupported: Arc<AtomicBool>,
  task: tokio::task::JoinHandle<()>,
}

impl Drop for MockCalDav {
  fn drop(&mut self) {
    self.task.abort();
  }
}

async fn start_mock_caldav_server() -> MockCalDav {
  let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind mock caldav port");
  let port = listener.local_addr().expect("local_addr").port();

  let port_clone = port;
  let unsupported = Arc::new(AtomicBool::new(false));
  let state = Arc::clone(&unsupported);
  let app = Router::new().fallback(move |req: Request| {
    let port = port_clone;
    let unsupported = state.load(Ordering::SeqCst);
    async move {
      let method = req.method().to_string();
      if method == "PROPFIND" {
        Response::builder()
          .status(207)
          .header("content-type", "application/xml; charset=utf-8")
          .body(axum::body::Body::from(propfind_response(
            port,
            if unsupported { 2 } else { 1 },
          )))
          .expect("propfind response")
      } else {
        // REPORT
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        Response::builder()
          .status(207)
          .header("content-type", "application/xml; charset=utf-8")
          .body(axum::body::Body::from(report_response(unsupported)))
          .expect("report response")
      }
    }
  });

  let task = tokio::spawn(async move {
    axum::serve(listener, app).await.expect("serve mock CalDAV");
  });

  MockCalDav {
    port,
    unsupported,
    task,
  }
}

async fn wait_for_release(redis: &dyn RedisPort, key: &str) {
  for _ in 0..20 {
    if redis.get_string(key).await.expect("read released lease").is_none() {
      return;
    }
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
  }
  panic!("test-owned CalDAV lease was not released");
}

// ---------------------------------------------------------------------------
// INV-CALDAV-SYNC-01
// ---------------------------------------------------------------------------

/// INV-CALDAV-SYNC-01: CalDavSyncService must upsert ≥ 1 event into
/// `calendar_events` when the mock CalDAV server returns one VEVENT.
#[tokio::test]
async fn inv_caldav_sync_01_events_land_in_db_after_sync() {
  let pool = helpers::setup_pool().await;

  let user_id = helpers::create_user(&pool, "caldav-sync-test", false).await;
  let outcome = AssertUnwindSafe(async {
    let mock = start_mock_caldav_server().await;
    let port = mock.port;

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
    wait_for_release(lock_redis.as_ref(), &lease_key).await;

    // Deployed source/cache IDs need not equal today's deterministic proposals.
    // Insert only after the lock-failure cases so those keep proving zero writes.
    let deployed_master=Uuid::new_v4();let deployed_instance=Uuid::new_v4();
    let original=chrono::Utc::now().date_naive().and_hms_opt(12,0,0).unwrap().and_utc()+chrono::Duration::days(2);
    sqlx::query("INSERT INTO calendar_events(id,account_id,remote_event_id,title,starts_at,ends_at,payload,updated_at) VALUES($1,$2,'inv-caldav-sync-01@mock','Previous source',$3,$4,'{}',now())")
      .bind(deployed_master).bind(account_id).bind(original-chrono::Duration::days(1097)).bind(original-chrono::Duration::days(1097)+chrono::Duration::hours(1)).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO calendar_event_instances(id,event_id,starts_at,ends_at,instance_start,instance_end,is_override,is_cancelled,created_at) VALUES($1,$2,$3,$4,$3,$4,false,false,now())")
      .bind(deployed_instance).bind(deployed_master).bind(original).bind(original+chrono::Duration::hours(1)).execute(&pool).await.unwrap();

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
      lock_redis.clone(),
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

    let event_id: Uuid = sqlx::query_scalar("SELECT id FROM calendar_events WHERE account_id = $1")
      .bind(account_id)
      .fetch_one(&pool)
      .await
      .expect("persisted recurring master");
    assert_eq!(event_id,deployed_master,"continue the persisted source ID returned by account/UID conflict, not a fresh UUID proposal");
    let source:(String,String)=sqlx::query_as("SELECT title,payload->>'rrule' FROM calendar_events WHERE id=$1").bind(event_id).fetch_one(&pool).await.unwrap();
    assert_eq!(source,("Mock CalDAV Event".into(),"FREQ=DAILY".into()),"same-UID exceptions must never overwrite the retained master");
    let exceptions:Vec<(Uuid,chrono::DateTime<chrono::Utc>,bool,serde_json::Value)>=sqlx::query_as("SELECT id,instance_start,is_cancelled,override_payload FROM calendar_event_instances WHERE event_id=$1 AND is_override ORDER BY instance_start").bind(event_id).fetch_all(&pool).await.unwrap();
    assert_eq!(exceptions.len(),2);
    assert_eq!(exceptions[0].0,deployed_instance,"turning an exposed ordinary slot into a provider override must retain its ID");
    assert!(exceptions[0].1!=exceptions[0].3["starts_at"].as_str().unwrap().parse::<chrono::DateTime<chrono::Utc>>().unwrap(),"RECURRENCE-ID, not the changed DTSTART, owns the original key");
    assert!(exceptions[1].2,"source cancellation must not become a visible second occurrence");
    let repo=SqlxCalendarRepository::new(pool.clone());
    use myoxus_domain::repositories::CalendarRepository;
    let projected=repo.list_event_instances(event_id,chrono::Utc::now(),chrono::Utc::now()+chrono::Duration::days(7)).await.unwrap();
    assert!(projected.iter().any(|slot|slot.id==exceptions[0].0&&slot.instance_start==exceptions[0].1));
    let instances: Vec<Uuid> =
      sqlx::query_scalar("SELECT id FROM calendar_event_instances WHERE event_id = $1 ORDER BY id")
        .bind(event_id)
        .fetch_all(&pool)
        .await
        .expect("persisted future instances");
    assert!(
      !instances.is_empty(),
      "a series older than two years must still project future instances"
    );
    let token: Option<String> =
      sqlx::query_scalar("SELECT sync_token FROM calendar_subscriptions WHERE account_id = $1")
        .bind(account_id)
        .fetch_one(&pool)
        .await
        .expect("successful sync token");
    mock.unsupported.store(true, Ordering::SeqCst);
    // Repeating the failed revision proves that ctag is not acknowledged as a
    // successful empty series. The original projection must survive both attempts.
    for _ in 0..2 {
      wait_for_release(lock_redis.as_ref(), &lease_key).await;
      let failed = svc_a.run_sync().await.expect("unsupported import is not a lease error");
      assert!(
        failed
          .errors
          .iter()
          .any(|(id, message)| *id == account_id && message.contains("unsupported imported recurrence rule"))
      );
      let raw: String = sqlx::query_scalar("SELECT payload->>'rrule' FROM calendar_events WHERE id = $1")
        .bind(event_id)
        .fetch_one(&pool)
        .await
        .expect("preserved unsupported source");
      assert_eq!(raw, "FREQ=MONTHLY;BYSETPOS=1");
      let retained: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM calendar_event_instances WHERE event_id = $1 ORDER BY id")
          .bind(event_id)
          .fetch_all(&pool)
          .await
          .expect("retained instance identities");
      assert_eq!(retained, instances);
      let repeated:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM calendar_event_instances WHERE event_id=$1 AND is_override ORDER BY instance_start").bind(event_id).fetch_all(&pool).await.unwrap();
      assert_eq!(repeated,exceptions.iter().map(|entry|entry.0).collect::<Vec<_>>(),"a repeated provider pull preserves exception identities");
      let unchanged: Option<String> =
        sqlx::query_scalar("SELECT sync_token FROM calendar_subscriptions WHERE account_id = $1")
          .bind(account_id)
          .fetch_one(&pool)
          .await
          .expect("failed sync token");
      assert_eq!(unchanged, token);
    }
  })
  .catch_unwind()
  .await;

  // Account children cascade. Clean only this fixture, including after a failed
  // assertion, rather than deleting other tests' accounts before each run.
  sqlx::query("DELETE FROM calendar_accounts WHERE user_id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("cleanup fixture calendar account");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("cleanup fixture user");
  if let Err(panic) = outcome {
    std::panic::resume_unwind(panic);
  }
}
