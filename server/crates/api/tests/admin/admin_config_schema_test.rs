// SPDX-License-Identifier: AGPL-3.0-or-later
//! Current Admin configuration contract integration tests.

use crate::helpers;

use std::{collections::BTreeSet, sync::OnceLock};

use serde_json::{Value, json};
use tokio::sync::Mutex;

fn config_lock() -> &'static Mutex<()> {
  static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

fn fields(snapshot: &Value) -> impl Iterator<Item = &Value> {
  snapshot["modules"]
    .as_array()
    .into_iter()
    .flatten()
    .flat_map(|module| module["groups"].as_array().into_iter().flatten())
    .flat_map(|group| group["fields"].as_array().into_iter().flatten())
}

fn field<'a>(snapshot: &'a Value, path: &str) -> &'a Value {
  fields(snapshot)
    .find(|field| field["path"] == path)
    .unwrap_or_else(|| panic!("missing config field {path}"))
}

fn paths(snapshot: &Value) -> BTreeSet<String> {
  fields(snapshot)
    .filter_map(|field| field["path"].as_str().map(str::to_string))
    .collect()
}

const CONFIG_QUERY: &str = r#"
  query {
    admin {
      adminConfigSchema {
        revision
        modules {
          module
          groups {
            groupKey
            fields {
              path
              valueType
              sensitive
              enum
              min
              max
              defaultValue
              value
              requiresRestart
              databaseWritable
              immediateApply
            }
          }
        }
      }
      adminConfigValues {
        revision
        effectiveFields { path configuredValue runtimeEffectiveValue }
        modules {
          module
          groups {
            groupKey
            fields { path value }
          }
        }
      }
    }
  }
"#;

#[test]
fn admin_schema_and_values_share_the_canonical_descriptor_contract() {
  helpers::block_on_large_stack(
    "admin_schema_and_values_share_the_canonical_descriptor_contract",
    || async {
      let (app, pool, auth_store) = helpers::setup_app().await;
      let _guard = config_lock().lock().await;
      let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

      let response = helpers::gql(&app, session_id, helpers::gql_query(CONFIG_QUERY)).await;
      assert!(response.get("errors").is_none(), "config query failed: {response}");
      let schema = &response["data"]["admin"]["adminConfigSchema"];
      let values = &response["data"]["admin"]["adminConfigValues"];

      assert_eq!(schema["revision"].as_str().map(str::len), Some(64));
      assert_eq!(values["revision"].as_str().map(str::len), Some(64));
      assert_eq!(paths(schema), paths(values));

      let origin = field(schema, "server.origin");
      assert_eq!(origin["valueType"], "String");
      assert_eq!(origin["sensitive"], false);
      assert_eq!(origin["databaseWritable"], true);
      assert!(origin["value"].is_null());
      assert!(origin["defaultValue"].is_string());

      let smtp_password = field(schema, "mail.smtp_pass");
      assert_eq!(smtp_password["sensitive"], true);
      assert!(smtp_password["defaultValue"].is_null());

      let git_lock = field(schema, "git_sync.lock_ttl_seconds");
      assert_eq!(git_lock["valueType"], "Number");
      assert_eq!(git_lock["min"], 1);
      assert_eq!(git_lock["max"], 3600);
      assert_eq!(git_lock["requiresRestart"], true);

      for retired in ["git_sync.lockTtlSeconds", "branding.theme_preset"] {
        assert!(!paths(schema).contains(retired), "retired path leaked: {retired}");
      }

      helpers::cleanup_users(&pool, &[admin_id]).await;
    },
  );
}

#[test]
fn admin_locale_roundtrip_uses_one_canonical_row() {
  helpers::block_on_large_stack("admin_locale_roundtrip_uses_one_canonical_row", || async {
    let (app, pool, auth_store) = helpers::setup_app().await;
    let _guard = config_lock().lock().await;
    let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;

    let update = helpers::gql(
      &app,
      session_id,
      json!({
        "query": r#"
          mutation Update($updates: [UpdateAppConfigInput!]!) {
            admin {
              adminUpdateConfig(updates: $updates) {
                applied
                fieldErrors { path message }
              }
            }
          }
        "#,
        "variables": {
          "updates": [{
            "module": "admin_i18n",
            "key": "default_locale",
            "value": "de"
          }]
        }
      }),
    )
    .await;
    assert!(update.get("errors").is_none(), "locale update failed: {update}");
    assert_eq!(update["data"]["admin"]["adminUpdateConfig"]["applied"], true);

    let response = helpers::gql(&app, session_id, helpers::gql_query(CONFIG_QUERY)).await;
    let values = &response["data"]["admin"]["adminConfigValues"];
    assert_eq!(field(values, "admin_i18n.default_locale")["value"], "de");

    let persisted: Value = sqlx::query_scalar("SELECT value FROM app_configs WHERE id = 'admin_i18n.default_locale'")
      .fetch_one(&pool)
      .await
      .expect("canonical locale row");
    assert_eq!(persisted, json!("de"));
    sqlx::query("DELETE FROM app_configs WHERE id = 'admin_i18n.default_locale'")
      .execute(&pool)
      .await
      .expect("cleanup locale row");
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}

#[test]
fn default_currency_validation_uses_the_shared_registry_contract() {
  helpers::block_on_large_stack(
    "default_currency_validation_uses_the_shared_registry_contract",
    || async {
      let (app, pool, auth_store) = helpers::setup_app().await;
      let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
      let response = helpers::gql(
        &app,
        session_id,
        json!({
          "query": r#"
          query Validate($updates: [UpdateAppConfigInput!]!) {
            admin { validateAppConfig(updates: $updates) { module key valid error } }
          }
        "#,
          "variables": {
            "updates": [
              {"module": "i18n", "key": "default_currency", "value": "EUR"},
              {"module": "i18n", "key": "default_currency", "value": "EURO"}
            ]
          }
        }),
      )
      .await;
      assert!(response.get("errors").is_none(), "validation query failed: {response}");
      let results = response["data"]["admin"]["validateAppConfig"]
        .as_array()
        .expect("validation results");
      assert_eq!(results[0]["module"], "i18n");
      assert_eq!(results[0]["key"], "default_currency");
      assert_eq!(results[0]["valid"], true);
      assert_eq!(results[1]["module"], "i18n");
      assert_eq!(results[1]["key"], "default_currency");
      assert_eq!(results[1]["valid"], false);
      assert!(results[1]["error"].as_str().is_some_and(|error| !error.is_empty()));
      helpers::cleanup_users(&pool, &[admin_id]).await;
    },
  );
}

/// The saved value, running engine snapshot and reset baseline have distinct
/// lifetimes. The complete owned database is dropped by SQLx on every exit.
#[sqlx::test(migrations = false)]
async fn engine_heartbeat_writes_restart_projection_and_reset_are_atomic(pool: sqlx::PgPool) {
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("owned config migrations");
  let baseline = myoxus_api::config::AppConfig::load().expect("file/ENV baseline");
  let (app, pool, auth) = helpers::setup_app_with_pool(pool).await;
  let (_, session) = helpers::seed_admin(&pool, &auth).await;
  let query = r#"{ admin { adminConfigValues { modules { module groups { fields { path value } } }
    effectiveFields { path configuredValue runtimeEffectiveValue runtimeEffectiveState requiresRestart } } } }"#;
  let mutation = r#"mutation Update($updates:[UpdateAppConfigInput!]!) { admin { adminUpdateConfig(updates:$updates) {
    applied fieldErrors {path message} } } }"#;
  let heartbeat = |interval: Value, timeout: Value| {
    json!([
      {"module":"websocket","key":"eio_ping_interval_seconds","value":interval},
      {"module":"websocket","key":"eio_ping_timeout_seconds","value":timeout}
    ])
  };
  let saved = helpers::gql(
    &app,
    session,
    json!({"query":mutation,"variables":{"updates":heartbeat(json!(2),json!(3))}}),
  )
  .await;
  assert!(saved["errors"].is_null(), "save: {saved}");
  assert_eq!(saved["data"]["admin"]["adminUpdateConfig"]["applied"], true);
  let values = helpers::gql(&app, session, json!({"query":query})).await;
  let snapshot = &values["data"]["admin"]["adminConfigValues"];
  assert_eq!(field(snapshot, "websocket.eio_ping_interval_seconds")["value"], 2);
  let effective = |snapshot: &Value, path: &str| {
    snapshot["effectiveFields"]
      .as_array()
      .expect("effective fields")
      .iter()
      .find(|value| value["path"] == path)
      .expect("heartbeat metadata")
      .clone()
  };
  let pending = effective(snapshot, "websocket.eio_ping_interval_seconds");
  assert_eq!(
    pending["runtimeEffectiveValue"],
    baseline.websocket.eio_ping_interval_seconds
  );
  assert_eq!(pending["runtimeEffectiveState"], "PENDING_RESTART");
  assert_eq!(pending["requiresRestart"], true);

  let (restarted, _, _) = helpers::setup_app_with_pool(pool.clone()).await;
  let values = helpers::gql(&restarted, session, json!({"query":query})).await;
  let active = effective(
    &values["data"]["admin"]["adminConfigValues"],
    "websocket.eio_ping_interval_seconds",
  );
  assert_eq!(active["runtimeEffectiveValue"], 2);
  assert_eq!(active["runtimeEffectiveState"], "EFFECTIVE");
  let mirror = myoxus_infrastructure::app_config::writeback_path()
    .map(|path| (path.clone(), std::fs::read(path).expect("owned mirror")));
  // CLI writes use this same transactional port and typed startup validator,
  // without the GraphQL precheck. A valid first field must not partially commit.
  use myoxus_infrastructure::app_config::{ConfigBatchMode, ConfigMutation, write_config_batch};
  assert!(
    write_config_batch(
      &pool,
      &[
        ConfigMutation::Set {
          path: "websocket.eio_ping_interval_seconds".to_string(),
          value: json!(7)
        },
        ConfigMutation::Set {
          path: "websocket.eio_ping_timeout_seconds".to_string(),
          value: json!(2_147_483)
        },
      ],
      ConfigBatchMode::Partial,
      None,
      &myoxus_api::config::AppConfigStartupValidator
    )
    .await
    .is_err()
  );
  for invalid in [json!(0), json!(-1), json!(1.5), json!(2_147_483), json!(u64::MAX)] {
    let response = helpers::gql(
      &restarted,
      session,
      json!({"query":mutation,
      "variables":{"updates":heartbeat(json!(7),invalid)}}),
    )
    .await;
    assert!(response["errors"].is_null(), "structured rejection: {response}");
    assert_eq!(response["data"]["admin"]["adminUpdateConfig"]["applied"], false);
    assert!(
      !response["data"]["admin"]["adminUpdateConfig"]["fieldErrors"]
        .as_array()
        .expect("field errors")
        .is_empty()
    );
    let rows: Vec<(String,Value)> = sqlx::query_as("SELECT id,value FROM app_configs WHERE id IN ('websocket.eio_ping_interval_seconds','websocket.eio_ping_timeout_seconds') ORDER BY id")
      .fetch_all(&pool).await.expect("unchanged heartbeat rows");
    assert_eq!(
      rows,
      vec![
        ("websocket.eio_ping_interval_seconds".to_string(), json!(2)),
        ("websocket.eio_ping_timeout_seconds".to_string(), json!(3))
      ]
    );
    if let Some((path, original)) = &mirror {
      assert_eq!(&std::fs::read(path).expect("mirror after rejected batch"), original);
    }
  }
  let removed = helpers::gql(
    &restarted,
    session,
    json!({"query":mutation,"variables":{"updates":heartbeat(Value::Null,Value::Null)}}),
  )
  .await;
  assert!(removed["errors"].is_null(), "remove: {removed}");
  assert_eq!(removed["data"]["admin"]["adminUpdateConfig"]["applied"], true);
  let values = helpers::gql(&restarted, session, json!({"query":query})).await;
  let snapshot = &values["data"]["admin"]["adminConfigValues"];
  let pending = effective(snapshot, "websocket.eio_ping_interval_seconds");
  assert_eq!(
    field(snapshot, "websocket.eio_ping_interval_seconds")["value"],
    baseline.websocket.eio_ping_interval_seconds
  );
  assert_eq!(pending["runtimeEffectiveValue"], 2);
  assert_eq!(pending["runtimeEffectiveState"], "PENDING_RESTART");
  let (reset, _, _) = helpers::setup_app_with_pool(pool.clone()).await;
  let values = helpers::gql(&reset, session, json!({"query":query})).await;
  let active = effective(
    &values["data"]["admin"]["adminConfigValues"],
    "websocket.eio_ping_interval_seconds",
  );
  assert_eq!(
    active["runtimeEffectiveValue"],
    baseline.websocket.eio_ping_interval_seconds
  );
  assert_eq!(active["runtimeEffectiveState"], "EFFECTIVE");
}

#[test]
fn transcription_setup_persists_and_hotreloads_with_copilot_disabled() {
  helpers::block_on_large_stack(
    "transcription_setup_persists_and_hotreloads_with_copilot_disabled",
    || async {
      use futures_util::FutureExt;
      let (app, pool, auth_store) =
        helpers::setup_app_with_config_override(|config| config.copilot.enabled = false).await;
      let _guard = config_lock().lock().await;
      let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
      let values = [
        ("copilot.enabled", json!(false)),
        ("transcription.enabled", json!(true)),
        ("transcription.endpoint", json!("http://operator-stt.invalid/v1")),
        ("transcription.model", json!("operator-model")),
        ("transcription.language", json!("de")),
        ("transcription.api_key", json!("deliberately-fake-test-key")),
        ("transcription.max_input_bytes", json!(4096)),
      ];
      let mut previous = Vec::new();
      for (path, _) in &values {
        let value: Option<Value> = sqlx::query_scalar("SELECT value FROM app_configs WHERE id = $1")
          .bind(path)
          .fetch_optional(&pool)
          .await
          .unwrap();
        let (module, key) = path.split_once('.').unwrap();
        previous.push(json!({"module": module, "key": key, "value": value}));
      }
      let mutation = r#"mutation Update($updates: [UpdateAppConfigInput!]!) {
      admin { adminUpdateConfig(updates: $updates) { applied fieldErrors { path message } } }
    }"#;
      assert!(
        sqlx::query_scalar::<_, Value>("SELECT value FROM app_configs WHERE id = 'copilot.transcription_model'")
          .fetch_optional(&pool)
          .await
          .unwrap()
          .is_none()
      );
      // Restore shared configuration even when a consuming assertion panics;
      // resume the original failure after cleanup rather than hiding it.
      let outcome = std::panic::AssertUnwindSafe(async {
        sqlx::query("INSERT INTO app_configs (id, value) VALUES ('copilot.transcription_model', $1)")
          .bind(json!("legacy-operator-model"))
          .execute(&pool)
          .await
          .unwrap();
        let ingress = helpers::gql(&app, session_id, helpers::gql_query(CONFIG_QUERY)).await;
        assert!(ingress.get("errors").is_none(), "{ingress}");
        let snapshot = &ingress["data"]["admin"]["adminConfigValues"];
        assert_eq!(field(snapshot, "transcription.model")["value"], "legacy-operator-model");
        let effective = snapshot["effectiveFields"]
          .as_array()
          .unwrap()
          .iter()
          .find(|field| field["path"] == "transcription.model")
          .unwrap();
        assert_eq!(effective["configuredValue"], "legacy-operator-model");
        assert_eq!(effective["runtimeEffectiveValue"], "legacy-operator-model");
        let migration = helpers::gql(
          &app,
          session_id,
          json!({"query": mutation, "variables": {"updates": [
            {"module": "transcription", "key": "enabled", "value": false}
          ]}}),
        )
        .await;
        assert!(migration.get("errors").is_none(), "{migration}");
        assert_eq!(
          migration["data"]["admin"]["adminUpdateConfig"]["applied"], true,
          "{migration}"
        );
        let retired: i64 =
          sqlx::query_scalar("SELECT count(*) FROM app_configs WHERE id = 'copilot.transcription_model'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(retired, 0);
        let migrated: Value = sqlx::query_scalar("SELECT value FROM app_configs WHERE id = 'transcription.model'")
          .fetch_one(&pool)
          .await
          .unwrap();
        assert_eq!(migrated, json!("legacy-operator-model"));
        let updates: Vec<_> = values
          .iter()
          .map(|(path, value)| {
            let (module, key) = path.split_once('.').unwrap();
            json!({"module": module, "key": key, "value": value})
          })
          .collect();
        let saved = helpers::gql(
          &app,
          session_id,
          json!({"query": mutation, "variables": {"updates": updates}}),
        )
        .await;
        assert!(saved.get("errors").is_none(), "{saved}");
        assert_eq!(saved["data"]["admin"]["adminUpdateConfig"]["applied"], true, "{saved}");
        let response = helpers::gql(&app, session_id, helpers::gql_query(CONFIG_QUERY)).await;
        assert!(response.get("errors").is_none(), "{response}");
        let schema = &response["data"]["admin"]["adminConfigSchema"];
        let readback = &response["data"]["admin"]["adminConfigValues"];
        assert_eq!(field(schema, "transcription.model")["databaseWritable"], true);
        assert_eq!(field(schema, "transcription.api_key")["sensitive"], true);
        assert!(field(schema, "transcription.api_key")["defaultValue"].is_null());
        assert!(!paths(schema).contains("copilot.transcription_model"));
        assert_eq!(field(readback, "transcription.model")["value"], "operator-model");
        assert_eq!(field(readback, "transcription.max_input_bytes")["value"], 4096);
        assert_eq!(
          field(readback, "transcription.api_key")["value"],
          myoxus_contracts::effective_config::MASKED_CONFIG_VALUE
        );
        assert!(!response.to_string().contains("deliberately-fake-test-key"));
        let capability_query =
          "{ serverConfig { features transcription { enabled configured status maxInputBytes } } }";
        let live = helpers::gql(&app, session_id, helpers::gql_query(capability_query)).await;
        assert!(live.get("errors").is_none(), "{live}");
        assert!(
          !live["data"]["serverConfig"]["features"]
            .as_array()
            .unwrap()
            .contains(&json!("Copilot"))
        );
        assert_eq!(live["data"]["serverConfig"]["transcription"]["status"], "NotChecked");
        assert_eq!(live["data"]["serverConfig"]["transcription"]["enabled"], true);
        assert_eq!(live["data"]["serverConfig"]["transcription"]["maxInputBytes"], 4096);
        assert!(!live.to_string().contains("operator-stt"));
        // Recreate the consuming router from the saved rows, not a seeded capability.
        let (reloaded, _, _) =
          helpers::setup_app_with_pool_and_config_override(pool.clone(), |config| config.copilot.enabled = false).await;
        let live = helpers::gql(&reloaded, session_id, helpers::gql_query(capability_query)).await;
        assert!(live.get("errors").is_none(), "{live}");
        assert_eq!(live["data"]["serverConfig"]["transcription"]["status"], "NotChecked");
        assert_eq!(live["data"]["serverConfig"]["transcription"]["maxInputBytes"], 4096);
      })
      .catch_unwind()
      .await;
      sqlx::query("DELETE FROM app_configs WHERE id = 'copilot.transcription_model'")
        .execute(&pool)
        .await
        .unwrap();
      let restored = helpers::gql(
        &app,
        session_id,
        json!({"query": mutation, "variables": {"updates": previous}}),
      )
      .await;
      sqlx::query("DELETE FROM config_changelog WHERE changed_by = $1")
        .bind(admin_id)
        .execute(&pool)
        .await
        .unwrap();
      helpers::cleanup_users(&pool, &[admin_id]).await;
      assert!(restored.get("errors").is_none(), "{restored}");
      assert_eq!(
        restored["data"]["admin"]["adminUpdateConfig"]["applied"], true,
        "{restored}"
      );
      if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
      }
    },
  );
}

#[test]
fn transcription_connection_check_is_admin_only_saved_bounded_and_invalidated() {
  helpers::block_on_large_stack(
    "transcription_connection_check_is_admin_only_saved_bounded_and_invalidated",
    || async {
      use futures_util::FutureExt;
      use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
      };
      let (app, pool, store) = helpers::setup_app_with_config_override(|config| config.copilot.enabled = false).await;
      let _guard = config_lock().lock().await;
      let (admin, session) = helpers::seed_admin(&pool, &store).await;
      let (user, user_session) = helpers::seed_user(&pool, &store, "speech-check-member").await;
      let mode = Arc::new(AtomicUsize::new(0));
      let requests = Arc::new(AtomicUsize::new(0));
      let authenticated = Arc::new(AtomicBool::new(true));
      let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
      let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
      let router = axum::Router::new().route(
        "/v1/models",
        axum::routing::get({
          let mode = mode.clone();
          let requests = requests.clone();
          let authenticated = authenticated.clone();
          move |headers: axum::http::HeaderMap| {
            let mode = mode.clone();
            let requests = requests.clone();
            let authenticated = authenticated.clone();
            async move {
              requests.fetch_add(1, Ordering::SeqCst);
              if headers
                .get("authorization")
                .map(|value| value.to_str().expect("bearer header is valid ASCII"))
                != Some("Bearer deliberately-fake-check-key")
              {
                authenticated.store(false, Ordering::SeqCst);
              }
              match mode.load(Ordering::SeqCst) {
                0 => (
                  axum::http::StatusCode::OK,
                  r#"{"object":"list","data":[{"id":"operator-model"}]}"#,
                ),
                1 => (axum::http::StatusCode::NOT_FOUND, "protected-response-body"),
                2 => (axum::http::StatusCode::UNAUTHORIZED, "protected-response-body"),
                _ => {
                  tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                  (axum::http::StatusCode::OK, r#"{"object":"list","data":[]}"#)
                }
              }
            }
          }
        }),
      );
      let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
      });
      let updates = [
        ("copilot.enabled", json!(false)),
        ("transcription.enabled", json!(false)),
        ("transcription.endpoint", json!(endpoint)),
        ("transcription.model", json!("operator-model")),
        ("transcription.api_key", json!("deliberately-fake-check-key")),
        ("transcription.request_timeout_ms", json!(2000)),
        ("transcription.max_response_bytes", json!(1024)),
      ];
      let mut previous = Vec::new();
      for (path, _) in &updates {
        let value: Option<Value> = sqlx::query_scalar("SELECT value FROM app_configs WHERE id = $1")
          .bind(path)
          .fetch_optional(&pool)
          .await
          .unwrap();
        let (module, key) = path.split_once('.').unwrap();
        previous.push(json!({"module": module, "key": key, "value": value}));
      }
      let mutation = "mutation($updates:[UpdateAppConfigInput!]!){admin{adminUpdateConfig(updates:$updates){applied fieldErrors{path message}}}}";
      let check = "mutation{admin{checkTranscriptionConnection{successful catalogSupported modelListed error}}}";
      let status = "{admin{transcriptionStatus{capability{enabled configured status}lastConnectionCheck{successful catalogSupported modelListed error}}}}";
      let outcome = std::panic::AssertUnwindSafe(async {
      for query in [check, status] {
        let denied = helpers::gql(&app, user_session, helpers::gql_query(query)).await;
        assert!(denied["errors"].as_array().is_some_and(|errors| !errors.is_empty()));
      }
      assert_eq!(requests.load(Ordering::SeqCst), 0);
      let input: Vec<_> = updates.iter().map(|(path, value)| {
        let (module, key) = path.split_once('.').unwrap();
        json!({"module":module,"key":key,"value":value})
      }).collect();
      let saved = helpers::gql(&app, session, json!({"query":mutation,"variables":{"updates":input}})).await;
      assert!(saved.get("errors").is_none(), "{saved}");
      assert_eq!(saved["data"]["admin"]["adminUpdateConfig"]["applied"], true);
      let before = helpers::gql(&app, session, helpers::gql_query(status)).await;
      assert!(before["errors"].is_null(), "{before}");
      assert_eq!(before["data"]["admin"]["transcriptionStatus"]["capability"]["status"], "Disabled");
      assert!(before["data"]["admin"]["transcriptionStatus"]["lastConnectionCheck"].is_null());
      assert_eq!(requests.load(Ordering::SeqCst), 0);
      let checked = helpers::gql(&app, session, helpers::gql_query(check)).await;
      assert!(checked["errors"].is_null(), "{checked}");
      assert_eq!(checked["data"]["admin"]["checkTranscriptionConnection"], json!({"successful":true,"catalogSupported":true,"modelListed":true,"error":null}));
      let readback = helpers::gql(&app, session, helpers::gql_query(status)).await;
      assert_eq!(readback["data"]["admin"]["transcriptionStatus"]["lastConnectionCheck"], checked["data"]["admin"]["checkTranscriptionConnection"]);
      assert_eq!(readback["data"]["admin"]["transcriptionStatus"]["capability"]["status"], "Disabled");
      assert_eq!(requests.load(Ordering::SeqCst), 1);
      let enabled = helpers::gql(&app, session, json!({"query":mutation,"variables":{"updates":[{"module":"transcription","key":"enabled","value":true}]}})).await;
      assert_eq!(enabled["data"]["admin"]["adminUpdateConfig"]["applied"], true);
      let reset = helpers::gql(&app, session, helpers::gql_query(status)).await;
      assert!(reset["data"]["admin"]["transcriptionStatus"]["lastConnectionCheck"].is_null());
      assert_eq!(reset["data"]["admin"]["transcriptionStatus"]["capability"]["status"], "NotChecked");
      mode.store(1, Ordering::SeqCst);
      let unsupported = helpers::gql(&app, session, helpers::gql_query(check)).await;
      assert_eq!(unsupported["data"]["admin"]["checkTranscriptionConnection"], json!({"successful":true,"catalogSupported":false,"modelListed":null,"error":null}));
      mode.store(2, Ordering::SeqCst);
      let rejected = helpers::gql(&app, session, helpers::gql_query(check)).await;
      assert_eq!(rejected["data"]["admin"]["checkTranscriptionConnection"]["successful"], false);
      assert!(rejected["data"]["admin"]["checkTranscriptionConnection"]["error"].as_str().unwrap().contains("HTTP 401"));
      assert!(!rejected.to_string().contains("protected-response-body"));
      assert!(!rejected.to_string().contains("deliberately-fake-check-key"));
      let bounded = helpers::gql(&app, session, json!({"query":mutation,"variables":{"updates":[{"module":"transcription","key":"request_timeout_ms","value":100}]}})).await;
      assert_eq!(bounded["data"]["admin"]["adminUpdateConfig"]["applied"], true);
      mode.store(3, Ordering::SeqCst);
      let timed_out = helpers::gql(&app, session, helpers::gql_query(check)).await;
      assert_eq!(timed_out["data"]["admin"]["checkTranscriptionConnection"]["successful"], false);
      assert!(timed_out["data"]["admin"]["checkTranscriptionConnection"]["error"].as_str().unwrap().starts_with("timeout:"));
      assert_eq!(requests.load(Ordering::SeqCst), 4);
      assert!(authenticated.load(Ordering::SeqCst));
    }).catch_unwind().await;
      server.abort();
      assert!(server.await.unwrap_err().is_cancelled());
      let restored = helpers::gql(
        &app,
        session,
        json!({"query":mutation,"variables":{"updates":previous}}),
      )
      .await;
      sqlx::query("DELETE FROM config_changelog WHERE changed_by = $1")
        .bind(admin)
        .execute(&pool)
        .await
        .unwrap();
      helpers::cleanup_users(&pool, &[admin, user]).await;
      assert!(restored["errors"].is_null(), "{restored}");
      assert_eq!(restored["data"]["admin"]["adminUpdateConfig"]["applied"], true);
      if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
      }
    },
  );
}
