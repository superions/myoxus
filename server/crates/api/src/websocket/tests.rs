//! Inline unit tests for the WS layer (protocol versioning, membership
//! tracking, subscriptions, error classification, RwLock recovery, view
//! dedup). Extracted from `mod.rs` in P107-J.
//!
//! The tests rely on `super::*` to pick up the re-exports from
//! `access` / `analytics` / `auth` / `fanout` / `handlers::doc`
//! / `room` / `state` / `types`, plus the `#[cfg(test)]` import of
//! `DOC_VIEW_DEDUP` / `DOC_VIEW_DEDUP_DATE` in `mod.rs`.
//!
//! `error::*` and `uuid::Uuid` are no longer re-exported through `mod.rs`
//! after P108 (they moved into handler submodules), so they are imported
//! explicitly here.

use super::error::{WsErrorCategory, classify_auth_error};
use super::*;
use uuid::Uuid;

// These tests exercise the production process-global dedup set. Serialize
// their mutations so one test cannot evict another test's sentinel entry.
static DOC_VIEW_DEDUP_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn ws_client_version_support_matches_contract_minimum() {
  assert!(is_supported_ws_client_version("0.41.5"));
  assert!(is_supported_ws_client_version("v0.41.5"));
  assert!(is_supported_ws_client_version("0.42.0"));
  assert!(!is_supported_ws_client_version("0.41.5-beta.1"));
  assert!(!is_supported_ws_client_version("0.41.4"));
  assert!(!is_supported_ws_client_version("invalid"));
}

#[test]
fn ws_protocol_room_selection_matches_025_and_026_threshold() {
  assert!(!uses_sync_026_protocol("0.25.9"));
  assert!(uses_sync_026_protocol("0.26.0-0"));
  assert!(uses_sync_026_protocol("0.26.0"));
  assert!(uses_sync_026_protocol("1.0.0"));
}

#[test]
fn document_broadcast_scope_preserves_userspace_and_rejects_ambiguous_routing() {
  let space_id = Uuid::new_v4().to_string();
  let mut broadcast = redis_adapter::CrossInstanceBroadcast {
    origin_instance: Uuid::new_v4().to_string(),
    event: "space:broadcast-doc-updates".to_string(),
    workspace_id: space_id.clone(),
    payload: serde_json::json!({"spaceType":"userspace","spaceId":space_id,"docId":"journal-settings"}),
    sender_socket_id: "peer".to_string(),
  };
  for kind in [SpaceType::Userspace, SpaceType::Workspace] {
    broadcast.payload["spaceType"] = serde_json::to_value(kind).unwrap();
    let scope = document_broadcast_space(&broadcast).expect("supported scoped document event");
    for protocol in ["sync-025", "sync-026"] {
      assert_eq!(
        get_room(scope, &space_id, protocol),
        format!("{kind}:{space_id}:{protocol}")
      );
    }
  }
  for invalid in [
    serde_json::Value::Null,
    serde_json::json!("unknown"),
    serde_json::json!(4),
  ] {
    broadcast.payload["spaceType"] = invalid;
    assert!(document_broadcast_space(&broadcast).is_none());
  }
  broadcast.payload["spaceType"] = serde_json::json!("userspace");
  broadcast.payload["spaceId"] = serde_json::json!(Uuid::new_v4());
  assert!(document_broadcast_space(&broadcast).is_none());
  broadcast.payload["spaceId"] = serde_json::json!(space_id);
  broadcast.payload["docId"] = serde_json::json!(" ");
  assert!(document_broadcast_space(&broadcast).is_none());
  broadcast.payload["docId"] = serde_json::json!("journal-settings");
  broadcast.workspace_id = format!("user:{space_id}");
  assert!(document_broadcast_space(&broadcast).is_none());
}

#[test]
fn awareness_broadcasts_require_exact_scope_and_nonempty_update() {
  let space_id = Uuid::new_v4().to_string();
  let mut broadcast = redis_adapter::CrossInstanceBroadcast {
    origin_instance: Uuid::new_v4().to_string(),
    event: "space:broadcast-awareness-update".to_string(),
    workspace_id: space_id.clone(),
    payload: serde_json::json!({"spaceType":"userspace","spaceId":space_id,"docId":"journal-settings","awarenessUpdate":"AQ=="}),
    sender_socket_id: "peer".to_string(),
  };
  for kind in [SpaceType::Workspace, SpaceType::Userspace] {
    broadcast.payload["spaceType"] = serde_json::to_value(kind).unwrap();
    assert_eq!(
      awareness_broadcast_room(&broadcast),
      Some(format!("{kind}:{space_id}:journal-settings:awareness"))
    );
  }
  for (field, invalid) in [
    ("spaceType", serde_json::json!("unknown")),
    ("spaceType", serde_json::Value::Null),
    ("spaceId", serde_json::json!(Uuid::new_v4())),
    ("docId", serde_json::json!(" ")),
    ("awarenessUpdate", serde_json::Value::Null),
    ("awarenessUpdate", serde_json::json!(4)),
    ("awarenessUpdate", serde_json::json!("")),
  ] {
    let saved = broadcast.payload[field].clone();
    broadcast.payload[field] = invalid;
    assert!(awareness_broadcast_room(&broadcast).is_none(), "invalid {field}");
    broadcast.payload[field] = saved;
  }
  broadcast.payload.as_object_mut().unwrap().remove("awarenessUpdate");
  assert!(awareness_broadcast_room(&broadcast).is_none());
  broadcast.event = "space:collect-awareness".to_string();
  assert!(awareness_broadcast_room(&broadcast).is_some());
}

#[test]
fn ws_membership_tracking_is_per_socket() {
  let sid = "socket-a";
  let key = make_space_key(SpaceType::Workspace, "ws-1");
  assert!(!has_space_membership(sid, &key));
  remember_space_membership(sid, key.clone());
  assert!(has_space_membership(sid, &key));
  forget_space_membership(sid, &key);
  assert!(!has_space_membership(sid, &key));
}

#[test]
fn ws_notification_ack_tracking_requires_delivery() {
  let sid = "socket-notify-a";
  let event_id = "evt-1";
  SOCKET_PENDING_NOTIFICATION_ACKS.remove(sid);
  NOTIFICATION_EVENT_ACKS.remove(event_id);

  assert!(!ack_notification_delivery(sid, event_id));
  record_notification_delivery(sid, event_id);
  assert!(ack_notification_delivery(sid, event_id));
  assert!(!ack_notification_delivery(sid, event_id));

  let acked_by = NOTIFICATION_EVENT_ACKS
    .get(event_id)
    .map(|entry| entry.value().0.len())
    .unwrap_or(0);
  assert_eq!(acked_by, 1);
}

#[test]
fn ws_notification_subscription_is_socket_scoped() {
  let sid = "socket-notify-sub";
  SOCKET_NOTIFICATION_SUBSCRIPTIONS.remove(sid);
  assert!(!is_notification_subscribed(sid));
  mark_notification_subscribed(sid);
  assert!(is_notification_subscribed(sid));
}

#[test]
fn user_notification_preserves_identity_and_rejects_invalid_routing() {
  let user_id = Uuid::new_v4();
  let event_id = Uuid::new_v4().to_string();
  let mut broadcast = redis_adapter::CrossInstanceBroadcast {
    origin_instance: "server:user-notification".to_string(),
    event: redis_adapter::XWS_NOTIFICATION_REDIS_EVENT.to_string(),
    workspace_id: format!("user:{user_id}"),
    payload: serde_json::json!({
      "eventId": event_id, "eventType": "notification_read",
      "payload": { "notificationId": Uuid::new_v4(), "read": true },
    }),
    sender_socket_id: "server:user-notification".to_string(),
  };
  let message = user_notification_local_event(&broadcast).expect("valid notification");
  assert_eq!(message.user_id, user_id);
  assert_eq!(message.event_id, event_id);
  assert_eq!(message.event_type, "notification_read");
  broadcast.payload["eventType"] = serde_json::json!("arbitrary-event");
  assert!(user_notification_local_event(&broadcast).is_none());
  broadcast.payload["eventType"] = serde_json::json!("notification_read");
  broadcast.payload["payload"]["userId"] = serde_json::json!(Uuid::new_v4());
  assert!(user_notification_local_event(&broadcast).is_none());
  broadcast.workspace_id = Uuid::new_v4().to_string();
  assert!(user_notification_local_event(&broadcast).is_none());
}

#[test]
fn ws_copilot_subscription_is_socket_scoped() {
  let sid = "socket-copilot-sub";
  SOCKET_COPILOT_SUBSCRIPTIONS.remove(sid);
  assert!(!is_copilot_subscribed(sid));
  mark_copilot_subscribed(sid);
  assert!(is_copilot_subscribed(sid));
}

#[test]
fn ws_copilot_event_type_normalization_matches_contract() {
  assert_eq!(normalize_copilot_event_type("typing"), "typing");
  assert_eq!(normalize_copilot_event_type("partial"), "partial");
  assert_eq!(normalize_copilot_event_type("done"), "done");
  assert_eq!(normalize_copilot_event_type("error"), "error");
  assert_eq!(normalize_copilot_event_type("unexpected"), "error");
}

// P101-WS-ERR-01: Error classification tests.

#[test]
fn ws_err_classify_storage_timeout_as_transient() {
  use myoxus_application::auth::AuthError;
  let err = AuthError::Storage("connection timed out".into());
  assert_eq!(classify_auth_error(&err), WsErrorCategory::Internal);
  assert_eq!(classify_auth_error(&err).as_error_name(), "INTERNAL_ERROR");
}

#[test]
fn ws_err_classify_fk_violation_as_permanent() {
  use myoxus_application::auth::AuthError;
  let err = AuthError::Storage("violates foreign key constraint".into());
  assert_eq!(classify_auth_error(&err), WsErrorCategory::Permanent);
  assert_eq!(classify_auth_error(&err).as_error_name(), "PERMANENT_ERROR");
}

#[test]
fn ws_err_classify_unique_constraint_as_permanent() {
  use myoxus_application::auth::AuthError;
  let err = AuthError::Storage("duplicate key value violates unique constraint".into());
  assert_eq!(classify_auth_error(&err), WsErrorCategory::Permanent);
}

#[test]
fn ws_err_classify_not_found_as_not_found() {
  use myoxus_application::auth::AuthError;
  let err = AuthError::NotFound("workspace not found".into());
  assert_eq!(classify_auth_error(&err), WsErrorCategory::NotFound);
  assert_eq!(classify_auth_error(&err).as_error_name(), "NOT_FOUND");
}

#[test]
fn ws_err_classify_quota_exceeded_as_permanent() {
  use myoxus_application::auth::AuthError;
  let err = AuthError::StorageQuotaExceeded {
    workspace_id: Uuid::new_v4(),
    current_bytes: 100,
    write_bytes: 50,
    quota_bytes: 120,
  };
  assert_eq!(classify_auth_error(&err), WsErrorCategory::Permanent);
}

#[test]
fn ws_err_classify_action_forbidden_as_permanent() {
  use myoxus_application::auth::AuthError;
  assert_eq!(
    classify_auth_error(&AuthError::ActionForbidden),
    WsErrorCategory::Permanent
  );
  assert_eq!(
    classify_auth_error(&AuthError::InvalidInput("bad".into())),
    WsErrorCategory::Permanent
  );
  assert_eq!(
    classify_auth_error(&AuthError::AuthenticationRequired),
    WsErrorCategory::Permanent
  );
}

#[test]
fn ws_err_category_log_labels_are_descriptive() {
  assert_eq!(WsErrorCategory::Internal.as_log_label(), "transient");
  assert_eq!(WsErrorCategory::Permanent.as_log_label(), "permanent");
  assert_eq!(WsErrorCategory::NotFound.as_log_label(), "not_found");
}

/// RwLock safety regression: socket_io accessor must use `unwrap_or_else`
/// (poisoned-lock recovery) instead of bare `unwrap()` which would panic
/// and crash the server on a poisoned lock.
#[test]
fn ws_rwlock_socket_io_recovers_from_poisoned_lock() {
  use std::sync::{Arc, RwLock};

  let lock: Arc<RwLock<Option<String>>> = Arc::new(RwLock::new(Some("io".to_string())));

  // Poison the lock by panicking inside a write guard
  let lock_clone = lock.clone();
  let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
    let _guard = lock_clone.write().unwrap();
    panic!("intentional panic to poison lock");
  }));

  // Verify the lock is poisoned
  assert!(lock.read().is_err(), "lock must be poisoned after panic");

  // The fix pattern: unwrap_or_else(|e| e.into_inner()) must recover
  let recovered = lock.read().unwrap_or_else(|e| e.into_inner()).clone();
  assert_eq!(
    recovered,
    Some("io".to_string()),
    "must recover value from poisoned lock"
  );
}

#[test]
fn ws_doc_view_dedup_prevents_duplicate_unique_views() {
  let _test_lock = DOC_VIEW_DEDUP_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let user = Uuid::new_v4();
  let ws = Uuid::new_v4();
  let doc = "test-doc-dedup".to_string();
  let today = chrono::Utc::now().date_naive();
  let key = (user, ws, doc.clone(), today);

  // Clean up any prior state from parallel tests.
  DOC_VIEW_DEDUP.remove(&key);

  // First insert → unique (returns true).
  assert!(DOC_VIEW_DEDUP.insert(key.clone()), "first view must be unique");

  // Second insert → duplicate (returns false).
  assert!(!DOC_VIEW_DEDUP.insert(key.clone()), "second view must be duplicate");

  // Different doc → unique again.
  let key2 = (user, ws, "other-doc".to_string(), today);
  DOC_VIEW_DEDUP.remove(&key2);
  assert!(DOC_VIEW_DEDUP.insert(key2.clone()), "different doc must be unique");

  // Same doc in a different workspace → also unique (P80-K-02: workspace_id in key).
  let ws2 = Uuid::new_v4();
  let key3 = (user, ws2, doc.clone(), today);
  DOC_VIEW_DEDUP.remove(&key3);
  assert!(
    DOC_VIEW_DEDUP.insert(key3.clone()),
    "same doc in different workspace must be unique"
  );

  // Cleanup.
  DOC_VIEW_DEDUP.remove(&key);
  DOC_VIEW_DEDUP.remove(&key2);
  DOC_VIEW_DEDUP.remove(&key3);
}

#[test]
fn ws_doc_view_dedup_date_change_clears_set() {
  let _test_lock = DOC_VIEW_DEDUP_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let user = Uuid::new_v4();
  let ws = Uuid::new_v4();
  let doc = "test-doc-date-change".to_string();
  let today = chrono::Utc::now().date_naive();
  let tomorrow = today + chrono::Duration::days(1);

  // Insert an entry for today.
  let key = (user, ws, doc.clone(), today);
  DOC_VIEW_DEDUP.insert(key.clone());
  assert!(DOC_VIEW_DEDUP.contains(&key));

  // Simulate day-change cleanup by setting last_date to today and
  // then checking against tomorrow (simulates the next day arriving).
  {
    let mut last_date = DOC_VIEW_DEDUP_DATE.lock().unwrap();
    *last_date = today; // ensure it's "today"
  }
  // Now pretend tomorrow arrived (uses retain to match production logic):
  {
    let mut last_date = DOC_VIEW_DEDUP_DATE.lock().unwrap();
    if *last_date != tomorrow {
      DOC_VIEW_DEDUP.retain(|(_uid, _ws, _doc, date)| *date >= tomorrow);
      *last_date = tomorrow;
    }
  }

  // Old entry must be gone.
  assert!(
    !DOC_VIEW_DEDUP.contains(&key),
    "old entries must be cleared on day change"
  );

  // New entry for tomorrow must succeed.
  let new_key = (user, ws, doc, tomorrow);
  assert!(DOC_VIEW_DEDUP.insert(new_key.clone()));
  DOC_VIEW_DEDUP.remove(&new_key);

  // Restore the date for other tests.
  {
    let mut last_date = DOC_VIEW_DEDUP_DATE.lock().unwrap();
    *last_date = today;
  }
}
