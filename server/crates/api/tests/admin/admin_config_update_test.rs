// SPDX-License-Identifier: AGPL-3.0-or-later
//! Admin config update mutation tests — persist, read-back, rejection of invalid inputs.

use crate::helpers;

use futures_util::FutureExt;
use std::sync::OnceLock;

use serde_json::{Value, json};
use sqlx::Row;
use tokio::sync::Mutex;

use myoxus_application::organization::oidc_directory::{
  OidcDirectoryError, OidcDirectoryGroup, OidcGroupDirectoryCatalog, OidcGroupDirectoryPort, project_directory,
};

struct SavedDirectoryProbe {
  calls: std::sync::atomic::AtomicUsize,
  failure: std::sync::Mutex<Option<OidcDirectoryError>>,
}

#[async_trait::async_trait]
impl OidcGroupDirectoryPort for SavedDirectoryProbe {
  async fn retrieve(
    &self,
    connection: &myoxus_contracts::oauth_config::OAuthGroupDirectoryConfig,
  ) -> Result<OidcGroupDirectoryCatalog, OidcDirectoryError> {
    self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    match connection {
      myoxus_contracts::oauth_config::OAuthGroupDirectoryConfig::Authentik { base_url, token } => {
        assert_eq!(base_url, "https://saved-idp.example/prefix");
        assert_eq!(token, "saved-directory-token");
      }
      _ => panic!("expected saved Authentik connection"),
    }
    if let Some(error) = self.failure.lock().unwrap().take() {
      return Err(error);
    }
    project_directory(vec![OidcDirectoryGroup {
      id: "catalog-id".into(),
      display_name: "/Engineering//Core/".into(),
      path: None,
      claim_value: "/Engineering//Core/".into(),
    }])
  }
}

fn find_admin_module<'a>(snapshot: &'a Value, module: &str) -> &'a Value {
  snapshot
    .get("modules")
    .and_then(Value::as_array)
    .and_then(|modules| modules.iter().find(|entry| entry["module"] == module))
    .expect("module")
}

fn find_admin_group<'a>(module: &'a Value, group_key: &str) -> &'a Value {
  module
    .get("groups")
    .and_then(Value::as_array)
    .and_then(|groups| groups.iter().find(|entry| entry["groupKey"] == group_key))
    .expect("group")
}

fn find_admin_field<'a>(group: &'a Value, path: &str) -> &'a Value {
  group
    .get("fields")
    .and_then(Value::as_array)
    .and_then(|fields| fields.iter().find(|entry| entry["path"] == path))
    .expect("field")
}

fn admin_config_test_lock() -> &'static Mutex<()> {
  static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

#[test]
fn admin_update_config_persists_and_returns_structured_field_errors() {
  helpers::block_on_large_stack(
    "admin_update_config_persists_and_returns_structured_field_errors",
    || async {
      let (app, pool, auth_store) = helpers::setup_app_with_audit().await;
      let _app_config_lock = admin_config_test_lock().lock().await;
      let (admin_id, session_id) = helpers::seed_admin(&pool, &auth_store).await;
      let result = std::panic::AssertUnwindSafe(async {
        let catalog = tempfile::tempdir().expect("operator catalog directory");
        let repository = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        // The checkout is an authoring tree, not a packed release. Reuse the
        // same admitted native selection as the API fixture's composition root.
        let features = helpers::feature_source_set();
        std::fs::create_dir_all(catalog.path().join("features")).expect("create Feature catalog directory");
        std::fs::write(catalog.path().join("features/catalog.yaml"), myoxus_contracts::config_document::encode_config_yaml(&features.catalog).unwrap()).expect("write admitted Feature catalog");
        for bundle in &features.bundles {
          let path = catalog.path().join("features").join(bundle.pin().archive_path());
          std::fs::create_dir_all(path.parent().unwrap()).expect("create Feature archive directory");
          std::fs::write(path, &bundle.archive_bytes).expect("write captured Feature archive");
        }
        let source = repository.join("server/templates");
        let mut directories = vec![std::path::PathBuf::from("mail"), std::path::PathBuf::from("html")];
        while let Some(relative) = directories.pop() {
          std::fs::create_dir_all(catalog.path().join(&relative)).expect("create operator template directory");
          for entry in std::fs::read_dir(source.join(&relative)).expect("read canonical templates") {
            let entry = entry.expect("canonical template entry");
            let relative = relative.join(entry.file_name());
            if entry.file_type().expect("template type").is_dir() { directories.push(relative); }
            else { std::fs::copy(entry.path(), catalog.path().join(relative)).expect("copy canonical template"); }
          }
        }
        let template = catalog.path().join("mail/en/smtp-test.html");
        let source = std::fs::read_to_string(&template).expect("SMTP test template");
        std::fs::write(
          &template,
          source.replace("Myoxus · SMTP test message", "Operator startup catalog"),
        )
        .expect("customize operator subject");
        sqlx::query("INSERT INTO app_configs (id, value) VALUES ('templates.root_dir', $1)")
          .bind(json!(catalog.path().to_str().expect("catalog path")))
          .execute(&pool)
          .await
          .expect("persist restart-bound catalog override");
        // The helper keeps the stock file baseline and applies persisted DB values
        // before building the actual GraphQL consumer, just like server startup.
        let (smtp_app, _, _) = helpers::setup_app_with_pool(pool.clone()).await;
        // Filesystem edits after capture must not affect this running consumer.
        std::fs::write(
          &template,
          source.replace("Myoxus · SMTP test message", "Edited after startup"),
        )
        .expect("edit catalog after capture");
        let sink = myoxus_tests::smtp_fixture::SmtpFixture::start(
          myoxus_tests::smtp_fixture::SmtpFixtureOptions::plain(myoxus_tests::smtp_fixture::SmtpFixtureAuth::None),
        )
        .await;
        let sent = helpers::gql(
          &smtp_app,
          session_id,
          json!({
            "query": "mutation($config: JSON!) { admin { sendTestEmail(config: $config) } }",
            "variables": {"config": {"host": sink.host(), "port": sink.port(), "transport": "plain",
              "sender": "Myoxus <noreply@example.test>"}}
          }),
        )
        .await;
        assert!(sent.get("errors").is_none(), "SMTP test GraphQL failed: {sent}");
        assert_eq!(sent["data"]["admin"]["sendTestEmail"], true);
        let messages = sink.messages().await;
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("Subject: Operator startup catalog"));
        drop(smtp_app);

        let success = helpers::gql(
          &app,
          session_id,
          json!({
            "query": r#"
        mutation Update($updates: [UpdateAppConfigInput!]!) {
          admin {
            adminUpdateConfig(updates: $updates) {
              applied
              writeback
              fieldErrors {
                module
                key
                path
                message
              }
              config {
                modules {
                  module
                  groups {
                    groupKey
                    fields {
                      path
                      value
                    }
                  }
                }
              }
            }
          }
        }
      "#,
            "variables": {
              "updates": [
                {"module": "doc", "key": "decoder_concurrency", "value": 16},
                {"module": "server", "key": "origin", "value": "http://admin.localhost:3010"},
                {"module": "mail", "key": "smtp_host", "value": "smtp.admin.local"},
                {"module": "oauth", "key": "providers.oidc", "value": {
                  "client_id": "admin-roundtrip-client",
                  "client_secret": "admin-roundtrip-secret",
                  "auth_url": "https://idp.admin.test/authorize",
                  "token_url": "https://idp.admin.test/token",
                  "userinfo_url": "https://idp.admin.test/userinfo",
                  "group_directory": {"type": "authentik", "base_url": "https://idp.admin.test/provider-prefix", "token": "directory-read-secret"},
                  "claims": {"email_verified": "verified"},
                  "group_mapping": {
                    "enabled": false,
                    "default_role": "member",
                    "remove_missing_oidc_memberships": true,
                    "missing_groups_policy": "deny_login",
                    "unknown_groups": "ignore",
                    "mappings": []
                  }
                }}
              ]
            }
          }),
        )
        .await;
        assert!(
          success.get("errors").is_none(),
          "positive adminUpdateConfig failed: {success}"
        );
        assert_eq!(success["data"]["admin"]["adminUpdateConfig"]["applied"], true);
        assert!(matches!(
          success["data"]["admin"]["adminUpdateConfig"]["writeback"].as_str(),
          Some("written" | "unchanged" | "disabled" | "failed")
        ));
        assert!(
          success["data"]["admin"]["adminUpdateConfig"]["fieldErrors"]
            .as_array()
            .expect("fieldErrors must be array")
            .is_empty()
        );

        let success_config = &success["data"]["admin"]["adminUpdateConfig"]["config"];
        assert!(!success.to_string().contains("admin-roundtrip-secret") && !success.to_string().contains("directory-read-secret"), "mutation response leaked provider credentials");
        let success_server = find_admin_module(success_config, "server");
        let success_server_group = find_admin_group(success_server, "system");
        assert_eq!(
          find_admin_field(success_server_group, "server.origin")["value"],
          "http://admin.localhost:3010"
        );

        let saved_row = sqlx::query("SELECT value FROM app_configs WHERE id = $1")
          .bind("server.origin")
          .fetch_one(&pool)
          .await
          .expect("server config row");
        let saved_value: Value = saved_row.get("value");
        assert_eq!(saved_value, Value::String("http://admin.localhost:3010".to_string()));
        let provider: Value = sqlx::query_scalar("SELECT value FROM app_configs WHERE id = 'oauth.providers.oidc'")
          .fetch_one(&pool)
          .await
          .expect("OIDC provider row");
        assert_eq!(provider["clientId"], "admin-roundtrip-client");
        assert_eq!(provider["claims"]["emailVerified"], "verified");
        assert_eq!(provider["groupMapping"]["defaultRole"], "member");
        let audit_count: i64 = sqlx::query_scalar(
          "SELECT COUNT(*) FROM admin_audit_log \
         WHERE actor_user_id = $1 AND category = 'config' \
           AND target_id IN ('server.origin', 'mail.smtp_host', 'oauth.providers.oidc')",
        )
        .bind(admin_id)
        .fetch_one(&pool)
        .await
        .expect("configuration audit rows");
        assert_eq!(
          audit_count, 3,
          "each committed field must produce one config audit event"
        );

        let readback = helpers::gql(&app, session_id, json!({
          "query": "{ admin { adminConfigValues { modules { module groups { groupKey fields { path value } } } } } }"
        })).await;
        assert!(readback.get("errors").is_none(), "Admin config readback failed: {readback}");
        assert!(!readback.to_string().contains("admin-roundtrip-secret") && !readback.to_string().contains("directory-read-secret"), "config query leaked provider credentials");
        let oauth = find_admin_module(&readback["data"]["admin"]["adminConfigValues"], "oauth");
        let mut provider_draft = find_admin_field(find_admin_group(oauth, "oauth"), "oauth.providers.oidc")["value"].clone();
        assert_eq!(provider_draft["clientSecret"], myoxus_contracts::effective_config::MASKED_CONFIG_VALUE);
        assert_eq!(provider_draft["groupDirectory"]["token"], myoxus_contracts::effective_config::MASKED_CONFIG_VALUE);
        provider_draft["claims"]["emailVerified"] = json!("email_verified");
        let roundtrip = helpers::gql(&app, session_id, json!({
          "query": "mutation($updates: [UpdateAppConfigInput!]!) { admin { adminUpdateConfig(updates: $updates) { applied fieldErrors { path message } config { modules { module groups { groupKey fields { path value } } } } } } }",
          "variables": {"updates": [{"module": "oauth", "key": "providers.oidc", "value": provider_draft}]}
        })).await;
        assert!(roundtrip.get("errors").is_none(), "masked OIDC roundtrip failed: {roundtrip}");
        assert_eq!(roundtrip["data"]["admin"]["adminUpdateConfig"]["applied"], true);
        assert!(!roundtrip.to_string().contains("admin-roundtrip-secret") && !roundtrip.to_string().contains("directory-read-secret"), "roundtrip response leaked provider credentials");
        let provider: Value = sqlx::query_scalar("SELECT value FROM app_configs WHERE id = 'oauth.providers.oidc'")
          .fetch_one(&pool).await.expect("provider after masked roundtrip");
        assert_eq!(provider["clientSecret"], "admin-roundtrip-secret");
        assert_eq!(provider["claims"]["emailVerified"], "email_verified");
        assert_eq!(provider["groupDirectory"], json!({"type":"authentik", "baseUrl":"https://idp.admin.test/provider-prefix", "token":"directory-read-secret"}));

        let oauth = find_admin_module(&roundtrip["data"]["admin"]["adminUpdateConfig"]["config"], "oauth");
        let mut without_directory = find_admin_field(find_admin_group(oauth, "oauth"), "oauth.providers.oidc")["value"].clone();
        without_directory["groupDirectory"] = Value::Null;
        let disconnected = helpers::gql(&app, session_id, json!({
          "query": "mutation($updates: [UpdateAppConfigInput!]!) { admin { adminUpdateConfig(updates: $updates) { applied fieldErrors { path message } } } }",
          "variables": {"updates": [{"module":"oauth", "key":"providers.oidc", "value":without_directory}]}
        })).await;
        assert!(disconnected.get("errors").is_none(), "directory removal failed: {disconnected}");
        assert_eq!(disconnected["data"]["admin"]["adminUpdateConfig"]["applied"], true);
        let provider: Value = sqlx::query_scalar("SELECT value FROM app_configs WHERE id = 'oauth.providers.oidc'")
          .fetch_one(&pool).await.expect("login provider after directory removal");
        assert!(provider["groupDirectory"].is_null());
        assert!(!provider.to_string().contains("directory-read-secret"));
        let decoded = myoxus_contracts::oauth_config::decode_oauth_provider_named("oidc", provider.clone()).expect("login's effective provider decoder");
        let myoxus_contracts::oauth_config::OAuthProviderConfig::Custom(decoded) = decoded else { panic!("OIDC custom provider shape"); };
        assert!(decoded.group_directory.is_none());
        assert_eq!(provider["clientSecret"], "admin-roundtrip-secret");

        let removal = helpers::gql(
          &app,
          session_id,
          json!({
            "query": r#"
        mutation Update($updates: [UpdateAppConfigInput!]!) {
          admin {
            adminUpdateConfig(updates: $updates) {
              applied
              writeback
              fieldErrors { path message }
            }
          }
        }
      "#,
            "variables": {
              "updates": [
                {"module": "oauth", "key": "providers.oidc", "value": null}
              ]
            }
          }),
        )
        .await;
        assert!(removal.get("errors").is_none(), "OIDC removal failed: {removal}");
        assert_eq!(removal["data"]["admin"]["adminUpdateConfig"]["applied"], true);
        assert!(
          removal["data"]["admin"]["adminUpdateConfig"]["fieldErrors"]
            .as_array()
            .is_some_and(Vec::is_empty)
        );
        let provider_after_removal: Option<Value> =
          sqlx::query_scalar("SELECT value FROM app_configs WHERE id = 'oauth.providers.oidc'")
            .fetch_optional(&pool)
            .await
            .expect("query removed OIDC provider");
        assert!(
          provider_after_removal.is_none(),
          "null must release the provider override"
        );

        let failure = helpers::gql(
          &app,
          session_id,
          json!({
            "query": r#"
        mutation Update($updates: [UpdateAppConfigInput!]!) {
          admin {
            adminUpdateConfig(updates: $updates) {
              applied
              writeback
              fieldErrors {
                module
                key
                path
                message
              }
            }
          }
        }
      "#,
            "variables": {
              "updates": [
                {"module": "throttle", "key": "enabled", "value": "yes"},
                {"module": "doc", "key": "decoder_concurrency", "value": 0},
                {"module": "server", "key": "doesNotExist", "value": true}
              ]
            }
          }),
        )
        .await;
        assert!(
          failure.get("errors").is_none(),
          "negative adminUpdateConfig should return structured field errors: {failure}"
        );
        assert_eq!(failure["data"]["admin"]["adminUpdateConfig"]["applied"], false);
        assert!(failure["data"]["admin"]["adminUpdateConfig"]["writeback"].is_null());

        let field_errors = failure["data"]["admin"]["adminUpdateConfig"]["fieldErrors"]
          .as_array()
          .expect("field errors");
        assert_eq!(field_errors.len(), 3, "expected all invalid fields to be reported");
        assert!(
          field_errors
            .iter()
            .any(|error| error["path"] == "doc.decoder_concurrency")
        );
        let capacity: Value = sqlx::query_scalar("SELECT value FROM app_configs WHERE id = 'doc.decoder_concurrency'")
          .fetch_one(&pool)
          .await
          .expect("persisted decoder capacity");
        assert_eq!(
          capacity,
          json!(16),
          "invalid capacity must not replace the persisted value"
        );
        assert!(field_errors.iter().any(|error| {
          error["module"] == "throttle"
            && error["key"] == "enabled"
            && error["path"] == "throttle.enabled"
            && error["message"]
              .as_str()
              .is_some_and(|msg| msg.contains("expected boolean"))
        }));
        assert!(field_errors.iter().any(|error| {
          error["module"] == "server"
            && error["key"] == "doesNotExist"
            && error["path"] == "server.doesNotExist"
            && error["message"]
              .as_str()
              .is_some_and(|msg| msg.contains("unknown config key"))
        }));

        let persisted_row = sqlx::query("SELECT value FROM app_configs WHERE id = $1")
          .bind("server.origin")
          .fetch_one(&pool)
          .await
          .expect("server config row");
        let persisted_value: Value = persisted_row.get("value");
        assert_eq!(
          persisted_value,
          Value::String("http://admin.localhost:3010".to_string())
        );
      })
      .catch_unwind()
      .await;

      // Cleanup: remove all config rows written by this test to avoid cross-test
      // interference when tests run in parallel across different test binaries.
      sqlx::query("DELETE FROM app_configs WHERE id IN ('server.origin', 'mail.smtp_host', 'oauth.providers.oidc', 'doc.decoder_concurrency', 'templates.root_dir')")
        .execute(&pool)
        .await
        .expect("cleanup app config rows written by admin config update test");
      sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id = $1 AND category = 'config'")
        .bind(admin_id)
        .execute(&pool)
        .await
        .expect("cleanup config audit rows");
      helpers::cleanup_users(&pool, &[admin_id]).await;
      if let Err(panic) = result {
        std::panic::resume_unwind(panic);
      }
    },
  );
}

#[test]
fn oidc_directory_requires_admin_and_uses_saved_effective_configuration() {
  helpers::block_on_large_stack(
    "oidc_directory_requires_admin_and_uses_saved_effective_configuration",
    || async {
      use std::sync::atomic::Ordering;
      let provider = |base: &str, token: &str| {
        json!({
          "clientId":"login-client", "clientSecret":"login-secret",
          "authUrl":"https://login.example/authorize", "tokenUrl":"https://login.example/token", "userinfoUrl":"https://login.example/userinfo",
          "groupDirectory":{"type":"authentik", "baseUrl":base, "token":token}
        })
      };
      let startup = provider("https://startup-idp.example", "startup-directory-token");
      let (_, pool, auth, state) = helpers::setup_app_with_config_override_and_state(move |config| {
        config.oauth.providers.insert(
          "oidc".into(),
          myoxus_contracts::oauth_config::decode_oauth_provider(startup).unwrap(),
        );
      })
      .await;
      let _lock = admin_config_test_lock().lock().await;
      let probe = std::sync::Arc::new(SavedDirectoryProbe {
        calls: Default::default(),
        failure: Default::default(),
      });
      let app = myoxus_api::build_router_for_integration_tests(state.with_oidc_group_directory(probe.clone()));
      let (admin_id, admin_session) = helpers::seed_admin(&pool, &auth).await;
      let (user_id, user_session) = helpers::seed_user(&pool, &auth, "oidc-directory-guard").await;
      let query =
        json!({"query":"{ admin { oidcGroupDirectory { entries { id displayName path claimValue state } } } }"});
      let result = std::panic::AssertUnwindSafe(async {
      for response in [helpers::gql_anon(&app, query.clone()).await, helpers::gql(&app, user_session, query.clone()).await] {
        assert!(response.get("errors").is_some(), "unauthorized directory query must fail");
      }
      assert_eq!(probe.calls.load(Ordering::SeqCst), 0, "non-admin must not invoke the provider port");
      let save = helpers::gql(&app, admin_session, json!({
        "query":"mutation($updates: [UpdateAppConfigInput!]!) { admin { adminUpdateConfig(updates:$updates) { applied fieldErrors { path message } } } }",
        "variables":{"updates":[{"module":"oauth", "key":"providers.oidc", "value":provider("https://saved-idp.example/prefix", "saved-directory-token")}]}
      })).await;
      assert!(save.get("errors").is_none(), "save failed: {save}");
      assert_eq!(save["data"]["admin"]["adminUpdateConfig"]["applied"], true);
      let catalog = helpers::gql(&app, admin_session, query.clone()).await;
      assert!(catalog.get("errors").is_none(), "saved directory query failed: {catalog}");
      assert_eq!(catalog["data"]["admin"]["oidcGroupDirectory"]["entries"], json!([{
        "id":"catalog-id", "displayName":"/Engineering//Core/", "path":null, "claimValue":"Engineering/Core", "state":"AVAILABLE"
      }]));
      assert!(!catalog.to_string().contains("saved-directory-token") && !catalog.to_string().contains("login-secret"));
      assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
      for (failure, code) in [
        (OidcDirectoryError::AccessDenied(403), "OIDC_GROUP_DIRECTORY_ACCESS_DENIED"),
        (OidcDirectoryError::Timeout, "OIDC_GROUP_DIRECTORY_TIMEOUT"),
        (OidcDirectoryError::LimitExceeded, "OIDC_GROUP_DIRECTORY_LIMIT_EXCEEDED"),
      ] {
        *probe.failure.lock().unwrap() = Some(failure);
        let response = helpers::gql(&app, admin_session, query.clone()).await;
        assert_eq!(response["errors"][0]["extensions"]["code"], code);
        assert!(!response.to_string().contains("saved-directory-token") && !response.to_string().contains("login-secret"));
      }
      let calls = probe.calls.load(Ordering::SeqCst);
      let mut disconnected = provider("https://saved-idp.example/prefix", "saved-directory-token");
      disconnected["groupDirectory"] = Value::Null;
      let save = helpers::gql(&app, admin_session, json!({
        "query":"mutation($updates: [UpdateAppConfigInput!]!) { admin { adminUpdateConfig(updates:$updates) { applied fieldErrors { path message } } } }",
        "variables":{"updates":[{"module":"oauth", "key":"providers.oidc", "value":disconnected}]}
      })).await;
      assert!(save.get("errors").is_none());
      assert_eq!(save["data"]["admin"]["adminUpdateConfig"]["applied"], true);
      let response = helpers::gql(&app, admin_session, query).await;
      assert_eq!(response["errors"][0]["extensions"]["code"], "OIDC_GROUP_DIRECTORY_UNCONFIGURED");
      assert_eq!(probe.calls.load(Ordering::SeqCst), calls, "unconfigured query must not invoke the provider");
    }).catch_unwind().await;
      sqlx::query("DELETE FROM app_configs WHERE id='oauth.providers.oidc'")
        .execute(&pool)
        .await
        .expect("remove owned provider fixture");
      sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=$1 AND category='config'")
        .bind(admin_id)
        .execute(&pool)
        .await
        .expect("remove owned config audits");
      helpers::cleanup_users(&pool, &[admin_id, user_id]).await;
      if let Err(panic) = result {
        std::panic::resume_unwind(panic);
      }
    },
  );
}
