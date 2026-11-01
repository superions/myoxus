// SPDX-License-Identifier: AGPL-3.0-or-later
//! Admin config journal settings tests — defaults, overrides, 3-tier hierarchy.

use crate::helpers;

use std::sync::OnceLock;

use serde_json::json;
use tokio::sync::Mutex;

fn admin_config_test_lock() -> &'static Mutex<()> {
  static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

/// BF-SRV-03e: serverConfig.journal returns defaults and reflects overrides.
#[test]
fn server_config_journal_returns_defaults_and_overrides() {
  helpers::block_on_large_stack("server_config_journal_returns_defaults_and_overrides", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let _app_config_lock = admin_config_test_lock().lock().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

    let resp = helpers::gql(
      &app,
      session_id,
      json!({"query": "query { serverConfig { journal { showCalendarWeeks firstDayOfWeek } } }"}),
    )
    .await;
    assert!(resp.get("errors").is_none(), "default query failed: {resp}");
    let journal = &resp["data"]["serverConfig"]["journal"];
    assert_eq!(
      journal["showCalendarWeeks"], true,
      "default showCalendarWeeks must be true"
    );
    assert_eq!(
      journal["firstDayOfWeek"], "monday",
      "default firstDayOfWeek must be monday"
    );

    let resp = helpers::gql(
    &app,
    session_id,
    json!({"query": "mutation { admin { adminUpdateConfig(updates:[{module:\"journal\", key:\"show_calendar_weeks\", value:false},{module:\"journal\", key:\"first_day_of_week\", value:\"sunday\"}]) { applied } } }"}),
  )
  .await;
    assert!(resp.get("errors").is_none(), "mutation failed: {resp}");

    let resp = helpers::gql(
      &app,
      session_id,
      json!({"query": "query { serverConfig { journal { showCalendarWeeks firstDayOfWeek } } }"}),
    )
    .await;
    assert!(resp.get("errors").is_none(), "override query failed: {resp}");
    let journal = &resp["data"]["serverConfig"]["journal"];
    assert_eq!(
      journal["showCalendarWeeks"], false,
      "overridden showCalendarWeeks must be false"
    );
    assert_eq!(
      journal["firstDayOfWeek"], "sunday",
      "overridden firstDayOfWeek must be sunday"
    );

    sqlx::query("DELETE FROM app_configs WHERE id LIKE 'journal.%'")
      .execute(&pool)
      .await
      .expect("cleanup journal configs");
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

/// User preferences resolve over the server default captured at API startup.
#[test]
fn user_journal_settings_use_startup_default_and_user_override() {
  helpers::block_on_large_stack(
    "user_journal_settings_use_startup_default_and_user_override",
    || async {
      let (app, pool, auth_store) = helpers::setup_app().await;
      let _app_config_lock = admin_config_test_lock().lock().await;
      let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
      sqlx::query("DELETE FROM user_preferences WHERE user_id = $1")
        .bind(admin_id)
        .execute(&pool)
        .await
        .expect("reset deterministic user preference fixture");

      // Persist both restart-required server defaults, then construct the
      // runtime whose effective config is authoritative for preference
      // resolution. Explicit values keep this test independent from earlier
      // runtime-config mutations in the shared integration process.
      let response = helpers::gql(
    &app,
    session_id,
    json!({"query": "mutation { admin { adminUpdateConfig(updates:[{module:\"journal\", key:\"first_day_of_week\", value:\"sunday\"},{module:\"journal\", key:\"show_calendar_weeks\", value:true}]) { applied } } }"}),
  )
  .await;
      assert!(
        response.get("errors").is_none(),
        "server default update failed: {response}"
      );
      let (app, _, _) = helpers::setup_app().await;

      let resp = helpers::gql(
      &app,
      session_id,
      json!({"query": "query { currentUser { preferences { effectiveValues { journalFirstDayOfWeek journalShowCalendarWeeks } } } }"}),
    )
    .await;
      assert!(resp.get("errors").is_none(), "settings query failed: {resp}");
      let settings = &resp["data"]["currentUser"]["preferences"]["effectiveValues"];
      assert_eq!(
        settings["journalFirstDayOfWeek"], "sunday",
        "user without a setting must get the startup server default"
      );
      assert_eq!(
        settings["journalShowCalendarWeeks"], true,
        "showCalendarWeeks must retain the startup server default"
      );

      // A persisted user value overrides the runtime's server default.
      let resp = helpers::gql(
      &app,
      session_id,
      json!({"query": "mutation { updatePreferences(input: { journalFirstDayOfWeek: \"monday\" }) { values { journalFirstDayOfWeek } } }"}),
    )
    .await;
      assert!(resp.get("errors").is_none(), "updatePreferences failed: {resp}");

      let resp = helpers::gql(
        &app,
        session_id,
        json!({"query": "query { currentUser { preferences { effectiveValues { journalFirstDayOfWeek } } } }"}),
      )
      .await;
      assert_eq!(
        resp["data"]["currentUser"]["preferences"]["effectiveValues"]["journalFirstDayOfWeek"], "monday",
        "user setting must override the startup server default"
      );

      sqlx::query("DELETE FROM user_preferences WHERE user_id = $1")
        .bind(admin_id)
        .execute(&pool)
        .await
        .expect("cleanup user preference fixture");
      sqlx::query("DELETE FROM app_configs WHERE id LIKE 'journal.%'")
        .execute(&pool)
        .await
        .expect("cleanup journal config fixture");
      helpers::cleanup_users(&pool, &[admin_id]).await;
    },
  );
}
