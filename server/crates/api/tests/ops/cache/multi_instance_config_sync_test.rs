//! Multi-instance config sync integration tests (P84-I-12).
//!
//! Verifies that configuration changes made through one server instance are
//! visible when queried through a second instance that shares the same database.
//!
//! Both instances use cold caches (freshly constructed `ApiState`), so each
//! read that misses the local moka-cache will go to the DB — the source of
//! truth.  This tests the fundamental DB-consistency invariant for multi-instance
//! deployments, independent of Redis Pub/Sub.

use crate::helpers;

use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// Query/mutation constants
// ---------------------------------------------------------------------------

const UPDATE_CONFIG: &str = r#"
  mutation Update($updates: [UpdateAppConfigInput!]!) {
    admin {
      adminUpdateConfig(updates: $updates) {
        applied
        fieldErrors { module key path message }
      }
    }
  }
"#;

const QUERY_CONFIG: &str = r#"
  query {
    admin {
      adminConfigValues {
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
"#;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

fn find_config_field<'a>(config: &'a Value, path: &str) -> Option<&'a str> {
  config.get("modules").and_then(Value::as_array).and_then(|modules| {
    modules.iter().find_map(|module| {
      module.get("groups").and_then(Value::as_array).and_then(|groups| {
        groups.iter().find_map(|group| {
          group.get("fields").and_then(Value::as_array).and_then(|fields| {
            fields.iter().find_map(|f| {
              if f.get("path").and_then(Value::as_str) == Some(path) {
                f.get("value").and_then(Value::as_str)
              } else {
                None
              }
            })
          })
        })
      })
    })
  })
}

// ---------------------------------------------------------------------------
// INV-MI-01
// ---------------------------------------------------------------------------

/// INV-MI-01: A configuration value written through instance A must be
/// readable through instance B when B's cache is cold (cache miss → DB read).
///
/// This invariant holds as long as both instances share the same PostgreSQL
/// database.  It does not depend on Redis Pub/Sub.
#[test]
fn inv_mi01_config_change_on_instance_a_visible_on_instance_b() {
  helpers::block_on_large_stack("inv_mi01_config_change_on_instance_a_visible_on_instance_b", || async {
    let _lock = helpers::SERVER_CONFIG_LOCK
      .get_or_init(|| tokio::sync::Mutex::new(()))
      .lock()
      .await;
    // Pre-clean stale server.origin so instances start with cold cache on this key.
    let pre_pool = helpers::setup_pool().await;
    sqlx::query("DELETE FROM app_configs WHERE id = 'server.origin'")
      .execute(&pre_pool)
      .await
      .expect("clear server origin before multi-instance assertion");
    drop(pre_pool);
    let (app_a, app_b, pool, _) = helpers::multi_instance_setup().await;
    let (admin_id, session_id) = helpers::seed_admin_db(&pool).await;

    let sentinel = format!("http://mi01.localhost:{}", admin_id.as_fields().0 & 0xFFFF);

    // Write via instance A
    let update = helpers::gql(
      &app_a,
      session_id,
      json!({
        "query": UPDATE_CONFIG,
        "variables": {"updates": [{"module": "server", "key": "origin", "value": sentinel}]}
      }),
    )
    .await;
    assert!(update.get("errors").is_none(), "update on A failed: {update}");
    assert_eq!(update["data"]["admin"]["adminUpdateConfig"]["applied"], true);

    // Read via instance B (cold cache -> DB read)
    let query = helpers::gql(&app_b, session_id, json!({"query": QUERY_CONFIG})).await;
    assert!(query.get("errors").is_none(), "query on B failed: {query}");

    let actual = find_config_field(&query["data"]["admin"]["adminConfigValues"], "server.origin");
    assert_eq!(
      actual,
      Some(sentinel.as_str()),
      "INV-MI-01: value from A must be visible on B"
    );

    sqlx::query("DELETE FROM app_configs WHERE id = 'server.origin'")
      .execute(&pool)
      .await
      .expect("clean server origin after multi-instance assertion");
    helpers::cleanup_users(&pool, &[admin_id]).await;
  });
}
