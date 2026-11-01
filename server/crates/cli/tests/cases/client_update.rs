// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::support;

use std::{process::Output, sync::LazyLock};

use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};
use support::database_url;
use tokio::sync::Mutex;
use uuid::Uuid;

const CONFIG_KEY: &str = "client.updateControl";
static TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

async fn setup_pool() -> PgPool {
  let pool = PgPoolOptions::new()
    .max_connections(4)
    .connect(&database_url())
    .await
    .expect("connect isolated test database");
  myoxus_infrastructure::migrations::run(&pool)
    .await
    .expect("apply migrations for client-update CLI tests");
  pool
}

fn cli_command(args: &[&str]) -> support::CliCommand {
  let mut command = support::cli_command();
  command
    .env("MYOXUS__DATABASE__URL", database_url())
    .arg("--json")
    .arg("client-update")
    .args(args);
  command
}

fn run_success(args: &[&str]) -> Value {
  let output = cli_command(args).output().expect("run myoxus-cli client-update");
  assert_success(&output);
  serde_json::from_slice(&output.stdout).expect("successful CLI stdout must be JSON")
}

fn run_failure(args: &[&str]) -> Output {
  let output = cli_command(args).output().expect("run failing myoxus-cli command");
  assert!(
    !output.status.success(),
    "CLI unexpectedly succeeded\nstdout: {}\nstderr: {}",
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
  output
}

fn assert_success(output: &Output) {
  assert!(
    output.status.success(),
    "CLI failed\nstatus: {}\nstdout: {}\nstderr: {}",
    output.status,
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  );
}

async fn delete_control(pool: &PgPool) {
  sqlx::query("DELETE FROM app_configs WHERE id = $1")
    .bind(CONFIG_KEY)
    .execute(pool)
    .await
    .expect("delete client update control");
}

#[tokio::test]
async fn client_update_cli_preserves_atomic_idempotent_single_row_control() {
  let _guard = TEST_LOCK.lock().await;
  let pool = setup_pool().await;
  delete_control(&pool).await;

  let baseline = run_success(&["status"]);
  assert_eq!(baseline["phase"], "normal");
  assert_eq!(baseline["cacheEpoch"], 0);
  let missing_count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM app_configs WHERE id = $1")
    .bind(CONFIG_KEY)
    .fetch_one(&pool)
    .await
    .expect("count baseline rows");
  assert_eq!(missing_count, 0, "status must not persist the fixed baseline");

  let first_operation = Uuid::new_v4().to_string();
  let limited = run_success(&[
    "limit-retry",
    "--operation-id",
    &first_operation,
    "--max-attempts",
    "3",
    "--retry-after-ms",
    "5000",
  ]);
  let limited_state_id = limited["state"]["stateId"].as_str().expect("limited state ID");
  assert_eq!(limited["committed"], true);
  assert_eq!(limited["changed"], true);
  assert_eq!(limited["wakeupSent"], true);
  assert_eq!(limited["state"]["phase"], "limited");

  let repeated_limit = run_success(&[
    "limit-retry",
    "--operation-id",
    &first_operation,
    "--max-attempts",
    "3",
    "--retry-after-ms",
    "5000",
  ]);
  assert_eq!(repeated_limit["changed"], false);
  assert_eq!(repeated_limit["state"]["stateId"], limited_state_id);

  run_success(&["no-retry", "--operation-id", &first_operation]);
  run_success(&["update-failed", "--operation-id", &first_operation]);
  let completed = run_success(&[
    "update-success",
    "--operation-id",
    &first_operation,
    "--action",
    "reset-local-cache",
    "--required-web-build-id",
    "0.38.0-test",
  ]);
  let completion_state_id = completed["state"]["stateId"].as_str().expect("completion state ID");
  assert_eq!(completed["state"]["cacheEpoch"], 1);

  let repeated_completion = run_success(&[
    "update-success",
    "--operation-id",
    &first_operation,
    "--action",
    "reset-local-cache",
    "--required-web-build-id",
    "0.38.0-test",
  ]);
  assert_eq!(repeated_completion["changed"], false);
  assert_eq!(repeated_completion["state"]["cacheEpoch"], 1);
  assert_eq!(repeated_completion["state"]["stateId"], completion_state_id);

  let second_operation = Uuid::new_v4().to_string();
  run_success(&[
    "limit-retry",
    "--operation-id",
    &second_operation,
    "--max-attempts",
    "1",
    "--retry-after-ms",
    "1000",
  ]);
  let before_conflict = sqlx::query_scalar::<_, Value>("SELECT value FROM app_configs WHERE id = $1")
    .bind(CONFIG_KEY)
    .fetch_one(&pool)
    .await
    .expect("read state before conflict");
  let conflict = run_failure(&[
    "update-success",
    "--operation-id",
    &first_operation,
    "--action",
    "reload",
  ]);
  assert!(String::from_utf8_lossy(&conflict.stderr).contains("conflicts with the current operation"));
  let after_conflict = sqlx::query_scalar::<_, Value>("SELECT value FROM app_configs WHERE id = $1")
    .bind(CONFIG_KEY)
    .fetch_one(&pool)
    .await
    .expect("read state after conflict");
  assert_eq!(after_conflict, before_conflict, "conflict must not partially write");
  run_success(&["update-abort", "--operation-id", &second_operation]);

  let concurrent_operation = Uuid::new_v4().to_string();
  let first_args = concurrent_operation.clone();
  let second_args = concurrent_operation.clone();
  let first = tokio::task::spawn_blocking(move || {
    run_success(&[
      "limit-retry",
      "--operation-id",
      &first_args,
      "--max-attempts",
      "2",
      "--retry-after-ms",
      "1000",
    ])
  });
  let second = tokio::task::spawn_blocking(move || {
    run_success(&[
      "limit-retry",
      "--operation-id",
      &second_args,
      "--max-attempts",
      "2",
      "--retry-after-ms",
      "1000",
    ])
  });
  let (first, second) = tokio::join!(first, second);
  let changed_count = [first.expect("first CLI task"), second.expect("second CLI task")]
    .into_iter()
    .filter(|result| result["changed"] == true)
    .count();
  assert_eq!(changed_count, 1, "concurrent identical commands must produce one write");

  sqlx::query("UPDATE app_configs SET value = $2 WHERE id = $1")
    .bind(CONFIG_KEY)
    .bind(serde_json::json!({ "schemaVersion": 1, "phase": "normal" }))
    .execute(&pool)
    .await
    .expect("seed corrupt update control");
  let corrupt_status = run_failure(&["status"]);
  assert!(String::from_utf8_lossy(&corrupt_status.stderr).contains("requires operator repair"));

  delete_control(&pool).await;
}
