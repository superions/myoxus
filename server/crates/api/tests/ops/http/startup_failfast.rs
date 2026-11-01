//! Tests verifying that the server fails fast on misconfiguration at startup.
//! Also includes a readiness-check invariant test for the search indexer
//! startup gate (P101-CODE-REVIEW-2).
use std::path::Path;
use std::process::Command;

fn write_base_config(config_dir: &Path) {
  std::fs::create_dir_all(config_dir).expect("create config dir");
  let yaml = r#"
server:
  port: 3001
  host: "127.0.0.1"
  origin: "http://localhost:3001"
  session_ttl: 1296000
  session_ttr: 604800
database:
  url: "postgres://myoxus:myoxus@localhost:5432/myoxus"
redis:
  url: null
  namespace: "myoxus"
mail:
  sender: "noreply@myoxus.local"
  smtp_port: 587
storage:
  backend: "local"
  root: "./storage"
  min_free_space_bytes: 0
oauth:
  google_client_id: null
  google_client_secret: null
  github_client_id: null
  github_client_secret: null
logging:
  level: "info"
  file_path: null
  rotation: "daily"
  max_files: 7
"#;
  std::fs::write(config_dir.join("default.yaml"), yaml).expect("write default.yaml");
}

fn run_server_with_env(workdir: &Path, envs: &[(&str, &str)]) -> std::process::Output {
  let mut cmd = Command::new(env!("CARGO_BIN_EXE_server"));
  cmd.current_dir(workdir);
  cmd.env("RUN_MODE", "development");
  for (key, value) in envs {
    cmd.env(key, value);
  }
  cmd.output().expect("execute server")
}

async fn db_reachable(url: &str) -> bool {
  sqlx::postgres::PgPoolOptions::new()
    .acquire_timeout(std::time::Duration::from_secs(2))
    .connect(url)
    .await
    .map(|pool| {
      drop(pool);
      true
    })
    .unwrap_or(false)
}

#[test]
fn startup_failfast_on_invalid_db_config() {
  let temp = tempfile::tempdir().expect("tempdir");
  let config_dir = temp.path().join("config");
  write_base_config(&config_dir);

  let output = run_server_with_env(
    temp.path(),
    &[
      ("MYOXUS__DATABASE__URL", "postgres://invalid:@@@"),
      ("MYOXUS__SERVER__PORT", "0"),
    ],
  );
  assert!(!output.status.success(), "server must fail fast on invalid DB config");
}

#[tokio::test]
async fn startup_failfast_on_unreachable_redis_when_enabled() {
  let db_url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  if !db_reachable(&db_url).await {
    eprintln!("skip: no reachable postgres for redis failfast test");
    return;
  }

  let temp = tempfile::tempdir().expect("tempdir");
  let config_dir = temp.path().join("config");
  write_base_config(&config_dir);

  let output = run_server_with_env(
    temp.path(),
    &[
      ("MYOXUS__DATABASE__URL", db_url.as_str()),
      ("MYOXUS__REDIS__URL", "redis://127.0.0.1:1"),
      ("MYOXUS__SERVER__PORT", "0"),
    ],
  );
  assert!(!output.status.success(), "server must fail fast on unreachable redis");
}

#[tokio::test]
async fn startup_failfast_on_unwritable_blob_storage() {
  let db_url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());
  if !db_reachable(&db_url).await {
    eprintln!("skip: no reachable postgres for blob failfast test");
    return;
  }

  let temp = tempfile::tempdir().expect("tempdir");
  let config_dir = temp.path().join("config");
  write_base_config(&config_dir);

  let output = run_server_with_env(
    temp.path(),
    &[
      ("MYOXUS__DATABASE__URL", db_url.as_str()),
      ("MYOXUS__STORAGE__BACKEND", "local"),
      ("MYOXUS__STORAGE__ROOT", "/proc/myoxus-forbidden-storage"),
      ("MYOXUS__SERVER__PORT", "0"),
    ],
  );
  assert!(
    !output.status.success(),
    "server must fail fast on unwritable blob storage"
  );
}

/// INV-STARTUP-SEARCH-01: verify_search_content_readiness passes against a
/// migrated test database.
///
/// Invariant: once migrations have run, the `search_content` table exists
/// and the PostgreSQL FTS operators are operational. The startup check must
/// pass without error — ensuring the server will not fail-fast on a correctly
/// provisioned database regardless of `indexer.enabled`.
///
/// P101-CODE-REVIEW-2: documents the conscious architectural decision that the
/// search readiness check is unconditional (not gated on indexer.enabled).
#[tokio::test]
async fn inv_startup_search01_readiness_passes_on_migrated_db() {
  use myoxus_api::startup_checks::verify_search_content_readiness;
  use sqlx::postgres::PgPoolOptions;

  let url = std::env::var("TEST_DATABASE_URL")
    .or_else(|_| std::env::var("DATABASE_URL"))
    .unwrap_or_else(|_| "postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test".to_string());

  let pool = match PgPoolOptions::new()
    .acquire_timeout(std::time::Duration::from_secs(3))
    .connect(&url)
    .await
  {
    Ok(p) => p,
    Err(_) => {
      eprintln!("skip: no reachable postgres for search readiness test");
      return;
    }
  };

  // Run migrations so the search_content table exists.
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrations");

  let result = verify_search_content_readiness(&pool).await;
  assert!(
    result.is_ok(),
    "verify_search_content_readiness must pass on a migrated DB: {result:?}"
  );
}
