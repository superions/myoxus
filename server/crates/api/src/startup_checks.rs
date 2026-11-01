//! Server startup checks run before the HTTP listener opens.
//!
//! Provides `run_startup_checks` which tests database connectivity and
//! required table presence, validates Redis role adapters, verifies object
//! storage read/write, and optionally confirms blob path sanity. Results are
//! collected into `StartupCheckSnapshot` entries stored on `ApiState` and
//! exposed through the `/ready` health endpoint.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;

use bytes::Bytes;
use myoxus_application::ports::{BlobStoragePort, BlobWriteRequest};
use myoxus_infrastructure::redis::RedisAdapter;
use serde::Serialize;
use thiserror::Error;
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

use crate::config::{RedisConfig, RedisRole};

/// Redis adapters keyed by their functional role.
#[derive(Debug)]
pub struct RedisRoleAdapters {
  /// Optional general-purpose cache adapter.
  pub cache: Option<RedisAdapter>,
  /// Session-storage adapter (always required).
  pub session: RedisAdapter,
  /// Job-queue adapter (always required — Redis is mandatory for worker queues).
  pub queue: RedisAdapter,
  /// Optional Socket.IO pub/sub adapter.
  pub socket: Option<RedisAdapter>,
  /// Distributed-lock adapter (always required).
  pub lock: RedisAdapter,
}

/// Errors that can occur during pre-flight startup checks.
#[derive(Debug, Error)]
pub enum StartupCheckError {
  /// Could not reach the PostgreSQL server.
  #[error("database connectivity check failed: {0}")]
  DatabaseConnectivity(String),
  /// One or more required tables are absent from the schema.
  #[error("database schema check failed, missing required tables: {0}")]
  MissingTables(String),
  /// The database user lacks required privileges.
  #[error("database privilege check failed, missing required privileges: {0}")]
  MissingPrivileges(String),
  /// Redis configuration is invalid.
  #[error("redis configuration check failed: {0}")]
  RedisConfiguration(String),
  /// Could not reach a Redis instance.
  #[error("redis connectivity check failed: {0}")]
  RedisConnectivity(String),
  /// Object storage read/write round-trip failed.
  #[error("storage readiness check failed: {0}")]
  StorageReadiness(String),
  /// Search index/table read probe failed.
  #[error("search readiness check failed: {0}")]
  SearchReadiness(String),
}

/// Broad category used to group startup check results in the `/ready` response.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StartupCheckCategory {
  /// Configuration validation failure.
  Config,
  /// Network / connectivity failure.
  Network,
  /// Permission / privilege failure.
  Permissions,
  /// Storage read/write failure.
  Storage,
}

impl StartupCheckError {
  pub fn category(&self) -> StartupCheckCategory {
    match self {
      StartupCheckError::DatabaseConnectivity(_) | StartupCheckError::RedisConnectivity(_) => {
        StartupCheckCategory::Network
      }
      StartupCheckError::MissingTables(_) | StartupCheckError::MissingPrivileges(_) => {
        StartupCheckCategory::Permissions
      }
      StartupCheckError::RedisConfiguration(_) => StartupCheckCategory::Config,
      StartupCheckError::StorageReadiness(_) => StartupCheckCategory::Storage,
      StartupCheckError::SearchReadiness(_) => StartupCheckCategory::Permissions,
    }
  }

  pub fn code(&self) -> &'static str {
    match self {
      StartupCheckError::DatabaseConnectivity(_) => "db_connectivity_failed",
      StartupCheckError::MissingTables(_) => "db_schema_missing_tables",
      StartupCheckError::MissingPrivileges(_) => "db_missing_privileges",
      StartupCheckError::RedisConfiguration(_) => "redis_config_invalid",
      StartupCheckError::RedisConnectivity(_) => "redis_connectivity_failed",
      StartupCheckError::StorageReadiness(_) => "storage_readiness_failed",
      StartupCheckError::SearchReadiness(_) => "search_readiness_failed",
    }
  }
}

/// Return the sorted list of tables that appear in `required` but not in
/// `existing`.
pub fn find_missing_tables(required: &[&str], existing: &HashSet<String>) -> Vec<String> {
  let mut missing = required
    .iter()
    .filter(|table| !existing.contains(**table))
    .map(|table| (*table).to_string())
    .collect::<Vec<_>>();
  missing.sort();
  missing
}

/// Return the sorted list of tables where `privilege` (e.g. `"SELECT"`) has
/// not been granted according to `granted`.
pub fn find_missing_privileges(required: &[&str], granted: &HashSet<String>, privilege: &str) -> Vec<String> {
  let mut missing = required
    .iter()
    .filter(|table| !granted.contains(**table))
    .map(|table| format!("{table}({privilege})"))
    .collect::<Vec<_>>();
  missing.sort();
  missing
}

#[instrument(skip(pool))]
/// Run all database startup checks: connectivity, required table presence, and
/// required DML/DDL privileges.
pub async fn verify_database_readiness(pool: &sqlx::PgPool) -> Result<(), StartupCheckError> {
  let ping = sqlx::query_scalar::<_, i64>("SELECT 1::bigint")
    .fetch_one(pool)
    .await
    .map_err(|err| StartupCheckError::DatabaseConnectivity(err.to_string()))?;
  if ping != 1 {
    return Err(StartupCheckError::DatabaseConnectivity(
      "unexpected ping response".to_string(),
    ));
  }

  let rows = sqlx::query_scalar::<_, String>("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'")
    .fetch_all(pool)
    .await
    .map_err(|err| StartupCheckError::DatabaseConnectivity(err.to_string()))?;
  let existing = rows.into_iter().collect::<HashSet<_>>();
  let missing = find_missing_tables(
    myoxus_infrastructure::db::schema_manifest::CORE_SCHEMA_TABLES,
    &existing,
  );
  if !missing.is_empty() {
    warn!(missing = ?missing, "database schema readiness check failed");
    return Err(StartupCheckError::MissingTables(missing.join(", ")));
  }

  let required_tables = myoxus_infrastructure::db::schema_manifest::CORE_SCHEMA_TABLES;
  let table_names = required_tables
    .iter()
    .map(|table| (*table).to_string())
    .collect::<Vec<_>>();
  let privileges = sqlx::query_as::<_, (String, bool, bool, bool, bool)>(
    r#"
        SELECT
            t,
            has_table_privilege(current_user, format('public.%I', t), 'SELECT') AS can_select,
            has_table_privilege(current_user, format('public.%I', t), 'INSERT') AS can_insert,
            has_table_privilege(current_user, format('public.%I', t), 'UPDATE') AS can_update,
            has_table_privilege(current_user, format('public.%I', t), 'DELETE') AS can_delete
        FROM unnest($1::text[]) AS t
        "#,
  )
  .bind(&table_names)
  .fetch_all(pool)
  .await
  .map_err(|err| StartupCheckError::DatabaseConnectivity(err.to_string()))?;
  let select_granted = privileges
    .iter()
    .filter(|(_, can_select, _, _, _)| *can_select)
    .map(|(table, _, _, _, _)| table.clone())
    .collect::<HashSet<_>>();
  let insert_granted = privileges
    .iter()
    .filter(|(_, _, can_insert, _, _)| *can_insert)
    .map(|(table, _, _, _, _)| table.clone())
    .collect::<HashSet<_>>();
  let update_granted = privileges
    .iter()
    .filter(|(_, _, _, can_update, _)| *can_update)
    .map(|(table, _, _, _, _)| table.clone())
    .collect::<HashSet<_>>();
  let delete_granted = privileges
    .iter()
    .filter(|(_, _, _, _, can_delete)| *can_delete)
    .map(|(table, _, _, _, _)| table.clone())
    .collect::<HashSet<_>>();
  let mut missing_privileges = Vec::new();
  missing_privileges.extend(find_missing_privileges(required_tables, &select_granted, "SELECT"));
  missing_privileges.extend(find_missing_privileges(required_tables, &insert_granted, "INSERT"));
  missing_privileges.extend(find_missing_privileges(required_tables, &update_granted, "UPDATE"));
  missing_privileges.extend(find_missing_privileges(required_tables, &delete_granted, "DELETE"));
  if !missing_privileges.is_empty() {
    warn!(missing_privileges = ?missing_privileges, "database privilege readiness check failed");
    return Err(StartupCheckError::MissingPrivileges(missing_privileges.join(", ")));
  }

  debug!(
    required_table_count = myoxus_infrastructure::db::schema_manifest::CORE_SCHEMA_TABLES.len(),
    "database schema readiness check passed"
  );
  info!("database readiness checks passed");
  Ok(())
}

#[instrument(skip(pool))]
/// Verify canonical search-content readiness against the migrated schema.
///
/// Checks:
/// 1. `search_content` table exists.
/// 2. Basic read query on the table succeeds.
/// 3. PostgreSQL full-text operators are operational.
pub async fn verify_search_content_readiness(pool: &sqlx::PgPool) -> Result<(), StartupCheckError> {
  let has_search_content = sqlx::query_scalar::<_, bool>(
    "SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'search_content')",
  )
  .fetch_one(pool)
  .await
  .map_err(|err| StartupCheckError::SearchReadiness(err.to_string()))?;
  if !has_search_content {
    return Err(StartupCheckError::MissingTables("search_content".to_string()));
  }

  let _row_count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM search_content")
    .fetch_one(pool)
    .await
    .map_err(|err| StartupCheckError::SearchReadiness(err.to_string()))?;

  let fts_probe = sqlx::query_scalar::<_, bool>(
    "SELECT to_tsvector('english', 'myoxus search readiness') @@ plainto_tsquery('english', 'myoxus')",
  )
  .fetch_one(pool)
  .await
  .map_err(|err| StartupCheckError::SearchReadiness(err.to_string()))?;
  if !fts_probe {
    return Err(StartupCheckError::SearchReadiness(
      "fts probe returned false".to_string(),
    ));
  }

  info!("search readiness checks passed");
  Ok(())
}

/// Check whether the `search_content` table is empty while the `docs` table has
/// rows.  When this is the case a first-boot or post-migration reindex is
/// needed.  Returns `true` if a reindex was enqueued, `false` otherwise.
///
/// This is a best-effort check: if the search store is unavailable the server
/// still starts (search degradation is acceptable).
#[instrument(skip(pool))]
pub async fn check_search_content_first_boot(pool: &sqlx::PgPool) -> Result<bool, StartupCheckError> {
  let has_search_content = sqlx::query_scalar::<_, bool>(
    "SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'search_content')",
  )
  .fetch_one(pool)
  .await
  .map_err(|err| StartupCheckError::SearchReadiness(err.to_string()))?;

  if !has_search_content {
    debug!("search_content table does not exist, skipping first-boot check");
    return Ok(false);
  }

  let content_count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM search_content")
    .fetch_one(pool)
    .await
    .map_err(|err| StartupCheckError::SearchReadiness(err.to_string()))?;

  if content_count > 0 {
    debug!(
      content_count,
      "search_content is populated, no first-boot reindex needed"
    );
    return Ok(false);
  }

  let docs_count = sqlx::query_scalar::<_, i64>(
    "SELECT COUNT(*)::bigint FROM docs WHERE workspace_id IS NOT NULL AND deleted_at IS NULL",
  )
  .fetch_one(pool)
  .await
  .map_err(|err| StartupCheckError::SearchReadiness(err.to_string()))?;

  if docs_count == 0 {
    debug!("both search_content and docs are empty, no reindex needed");
    return Ok(false);
  }

  warn!(
    docs_count,
    "search_content is empty but docs table has {docs_count} rows — first-boot reindex recommended"
  );
  Ok(true)
}

#[instrument(skip_all)]
/// Connect to each configured Redis instance and return the role adapters.
/// Redis is a hard dependency — the server will fail to start if any required role is unreachable.
pub async fn verify_redis_readiness(
  redis: &RedisConfig,
  additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
) -> Result<RedisRoleAdapters, StartupCheckError> {
  async fn verify_redis_role(
    redis: &RedisConfig,
    role: RedisRole,
    required: bool,
    additional_ca: Option<&myoxus_infrastructure::tls::ValidatedCaBundle>,
  ) -> Result<Option<RedisAdapter>, StartupCheckError> {
    let Some(redis_url) = redis.role_url(role) else {
      if required {
        return Err(StartupCheckError::RedisConfiguration(format!(
          "redis role '{}' has no url; configure redis.url or redis.roles.{}.url",
          role.as_str(),
          role.as_str()
        )));
      }
      info!(redis_role = role.as_str(), "redis role disabled (no url configured)");
      return Ok(None);
    };

    let namespace = redis.role_namespace(role);
    let client = myoxus_infrastructure::tls::redis::client(&redis_url, additional_ca)
      .map_err(StartupCheckError::RedisConfiguration)?;
    let adapter = RedisAdapter::from_client(client, namespace.clone());
    adapter
      .ping()
      .await
      .map_err(|err| StartupCheckError::RedisConnectivity(format!("role={} {err}", role.as_str())))?;
    info!(
      redis_role = role.as_str(),
      redis_namespace = %namespace,
      "redis connectivity check succeeded"
    );
    Ok(Some(adapter))
  }

  let cache = verify_redis_role(redis, RedisRole::Cache, false, additional_ca).await?;
  let socket = verify_redis_role(redis, RedisRole::Socket, false, additional_ca).await?;
  let session = verify_redis_role(redis, RedisRole::Session, true, additional_ca)
    .await?
    .expect("required redis role must produce adapter");
  let queue = verify_redis_role(redis, RedisRole::Queue, true, additional_ca)
    .await?
    .expect("required redis role must produce adapter");
  let lock = verify_redis_role(redis, RedisRole::Lock, true, additional_ca)
    .await?
    .expect("required redis role must produce adapter");

  if cache.is_none() {
    debug!("redis cache role is disabled; api runtime currently uses session profile for cache workloads");
  }
  Ok(RedisRoleAdapters {
    cache,
    session,
    queue,
    socket,
    lock,
  })
}

#[instrument(skip(storage))]
/// Perform a write + read + delete round-trip against the blob storage backend
/// to confirm it is operational.
pub async fn verify_blob_storage_readiness(storage: &dyn BlobStoragePort) -> Result<(), StartupCheckError> {
  let probe_key = format!("startup-probe/{}.txt", Uuid::new_v4());
  let probe_body = Bytes::from_static(b"myoxus-storage-probe");
  let write_request = BlobWriteRequest {
    key: probe_key.clone(),
    content_type: Some("text/plain".to_string()),
    body: probe_body.clone(),
  };
  storage
    .write_blob(write_request)
    .await
    .map_err(|err| StartupCheckError::StorageReadiness(format!("write failed for {probe_key}: {err}")))?;

  let read_response = storage
    .read_blob(&probe_key)
    .await
    .map_err(|err| StartupCheckError::StorageReadiness(format!("read failed for {probe_key}: {err}")))?;
  if read_response.data != probe_body {
    return Err(StartupCheckError::StorageReadiness(format!(
      "readback mismatch for {probe_key}: expected {} bytes, got {} bytes",
      probe_body.len(),
      read_response.data.len()
    )));
  }

  storage
    .delete_blob(&probe_key)
    .await
    .map_err(|err| StartupCheckError::StorageReadiness(format!("delete failed for {probe_key}: {err}")))?;
  info!(probe_key = %probe_key, "blob storage readiness check passed");
  Ok(())
}

#[instrument]
/// Verify that the local storage root directory exists and is writable.
pub fn verify_local_storage_path_readiness(root: &str) -> Result<(), StartupCheckError> {
  let root_path = Path::new(root);
  if root_path.exists() && !root_path.is_dir() {
    return Err(StartupCheckError::StorageReadiness(format!(
      "local storage root is not a directory: {root}"
    )));
  }
  fs::create_dir_all(root_path).map_err(|err| {
    StartupCheckError::StorageReadiness(format!(
      "failed to create local storage root {root}: {err}{}",
      local_storage_permission_hint(root, &err)
    ))
  })?;
  let probe_path = root_path.join(format!("startup-local-probe-{}.tmp", Uuid::new_v4()));
  fs::write(&probe_path, b"myoxus-local-storage-probe").map_err(|err| {
    StartupCheckError::StorageReadiness(format!(
      "failed to write local storage probe {}: {err}{}",
      probe_path.display(),
      local_storage_permission_hint(root, &err)
    ))
  })?;
  fs::remove_file(&probe_path).map_err(|err| {
    StartupCheckError::StorageReadiness(format!(
      "failed to remove local storage probe {}: {err}{}",
      probe_path.display(),
      local_storage_permission_hint(root, &err)
    ))
  })?;
  info!(root, "local storage path readiness check passed");
  Ok(())
}

fn local_storage_permission_hint(root: &str, err: &io::Error) -> String {
  if err.kind() != io::ErrorKind::PermissionDenied {
    return String::new();
  }
  format!(
    ". Permission hint: ensure the mounted path is writable by the API runtime user. \
Set `MYOXUS_API_USER` to the host uid:gid (e.g. `MYOXUS_API_USER=$(id -u):$(id -g)` in compose env), \
or fix ownership with `chown -R <uid>:<gid> {root}`."
  )
}

#[instrument]
/// Verify that the filesystem containing `root` has at least
/// `min_free_space_bytes` available.
pub fn verify_local_storage_free_space(root: &str, min_free_space_bytes: u64) -> Result<(), StartupCheckError> {
  if min_free_space_bytes == 0 {
    debug!(root, "local storage free-space check disabled (min_free_space_bytes=0)");
    return Ok(());
  }
  let available = fs2::available_space(Path::new(root)).map_err(|err| {
    StartupCheckError::StorageReadiness(format!(
      "failed to determine free space for local storage root {root}: {err}"
    ))
  })?;
  if available < min_free_space_bytes {
    return Err(StartupCheckError::StorageReadiness(format!(
      "insufficient free space for local storage root {root}: available={available} required={min_free_space_bytes}"
    )));
  }
  info!(
    root,
    available, min_free_space_bytes, "local storage free-space check passed"
  );
  Ok(())
}

#[cfg(test)]
mod tests {
  use std::collections::HashSet;
  use std::fs;
  use std::io;
  use std::path::PathBuf;
  use std::time::{SystemTime, UNIX_EPOCH};

  use async_trait::async_trait;
  use myoxus_application::ports::{
    BlobReadResponse, BlobStoragePort, BlobWriteRequest, MultipartCompleteRequest, MultipartCreateRequest,
    MultipartCreateResponse, MultipartPartUrlRequest, MultipartPartUrlResponse, PortError, PortResult,
  };
  use sqlx::postgres::PgPoolOptions;
  use tokio::sync::RwLock;
  use uuid::Uuid;

  use super::{
    StartupCheckError, find_missing_privileges, find_missing_tables, verify_blob_storage_readiness,
    verify_database_readiness, verify_local_storage_free_space, verify_local_storage_path_readiness,
    verify_redis_readiness, verify_search_content_readiness,
  };
  use crate::config::RedisConfig;

  #[test]
  fn find_missing_tables_reports_missing_entries_sorted() {
    let existing = HashSet::from(["users".to_string(), "workspaces".to_string()]);
    let missing = find_missing_tables(&["users", "sessions", "workspaces", "docs"], &existing);
    assert_eq!(missing, vec!["docs".to_string(), "sessions".to_string()]);
  }

  #[test]
  fn find_missing_tables_is_empty_when_all_exist() {
    let existing = HashSet::from(["users".to_string(), "sessions".to_string(), "workspaces".to_string()]);
    let missing = find_missing_tables(&["users", "sessions", "workspaces"], &existing);
    assert!(missing.is_empty());
  }

  #[test]
  fn find_missing_privileges_reports_missing_entries_sorted() {
    let granted = HashSet::from(["users".to_string()]);
    let missing = find_missing_privileges(&["users", "sessions", "docs"], &granted, "SELECT");
    assert_eq!(
      missing,
      vec!["docs(SELECT)".to_string(), "sessions(SELECT)".to_string()]
    );
  }

  #[tokio::test]
  async fn verify_redis_readiness_fails_when_no_url_configured() {
    let cfg = RedisConfig {
      url: None,
      namespace: "myoxus".to_string(),
      roles: Default::default(),
      session_cache: Default::default(),
      ..Default::default()
    };
    let err = verify_redis_readiness(&cfg, None)
      .await
      .expect_err("missing url must fail");
    assert!(matches!(err, StartupCheckError::RedisConfiguration(_)));
    assert!(err.to_string().contains("has no url"));
  }

  struct TestBlobStorage {
    data: RwLock<Option<bytes::Bytes>>,
    key: RwLock<Option<String>>,
  }

  impl TestBlobStorage {
    fn new() -> Self {
      Self {
        data: RwLock::new(None),
        key: RwLock::new(None),
      }
    }
  }

  #[async_trait]
  impl BlobStoragePort for TestBlobStorage {
    async fn write_blob(&self, req: BlobWriteRequest) -> PortResult<()> {
      *self.data.write().await = Some(req.body);
      *self.key.write().await = Some(req.key);
      Ok(())
    }

    async fn read_blob(&self, key: &str) -> PortResult<BlobReadResponse> {
      match (self.key.read().await.clone(), self.data.read().await.clone()) {
        (Some(stored_key), Some(stored_data)) if stored_key == key => Ok(BlobReadResponse {
          key: stored_key,
          content_type: Some("text/plain".to_string()),
          data: stored_data.clone(),
          last_modified: None,
          content_length: stored_data.len() as u64,
        }),
        _ => Err(PortError::NotFound(key.to_string())),
      }
    }

    async fn delete_blob(&self, key: &str) -> PortResult<()> {
      if self.key.read().await.clone().as_deref() == Some(key) {
        *self.key.write().await = None;
        *self.data.write().await = None;
      }
      Ok(())
    }

    async fn put_avatar(&self, _key: &str, _data: bytes::Bytes, _content_type: &str) -> PortResult<String> {
      Err(PortError::InvalidInput("unused".to_string()))
    }

    async fn get_avatar(&self, _key: &str) -> PortResult<BlobReadResponse> {
      Err(PortError::InvalidInput("unused".to_string()))
    }

    async fn delete_avatar(&self, _key: &str) -> PortResult<()> {
      Err(PortError::InvalidInput("unused".to_string()))
    }

    async fn create_multipart_upload(&self, _req: MultipartCreateRequest) -> PortResult<MultipartCreateResponse> {
      Err(PortError::InvalidInput("unused".to_string()))
    }

    async fn create_multipart_part_url(&self, _req: MultipartPartUrlRequest) -> PortResult<MultipartPartUrlResponse> {
      Err(PortError::InvalidInput("unused".to_string()))
    }

    async fn complete_multipart_upload(&self, _req: MultipartCompleteRequest) -> PortResult<()> {
      Err(PortError::InvalidInput("unused".to_string()))
    }

    async fn abort_multipart_upload(&self, _upload_id: Uuid) -> PortResult<()> {
      Err(PortError::InvalidInput("unused".to_string()))
    }
  }

  #[tokio::test]
  async fn verify_blob_storage_readiness_runs_write_read_delete_probe() {
    let storage = TestBlobStorage::new();
    verify_blob_storage_readiness(&storage)
      .await
      .expect("probe should succeed");
  }

  #[tokio::test]
  async fn verify_database_readiness_accepts_basic_ping_and_core_schema() {
    let db_url = std::env::var("TEST_DATABASE_URL")
      .or_else(|_| std::env::var("DATABASE_URL"))
      .unwrap_or_else(|_| "postgres://myoxus:myoxus@localhost:5432/myoxus".to_string());
    let pool = match PgPoolOptions::new().max_connections(1).connect(&db_url).await {
      Ok(pool) => pool,
      Err(_) => {
        eprintln!("skip: no reachable postgres for database readiness test");
        return;
      }
    };

    match verify_database_readiness(&pool).await {
      Ok(()) => {}
      Err(StartupCheckError::MissingTables(_)) | Err(StartupCheckError::MissingPrivileges(_)) => {
        eprintln!("skip: reachable postgres without full migrated/privileged core schema");
      }
      Err(err) => panic!("database readiness should not fail on connectivity path: {err}"),
    }
  }

  #[tokio::test]
  async fn verify_search_content_readiness_accepts_search_content_and_fts() {
    let db_url = std::env::var("TEST_DATABASE_URL")
      .or_else(|_| std::env::var("DATABASE_URL"))
      .unwrap_or_else(|_| "postgres://myoxus:myoxus@localhost:5432/myoxus".to_string());
    let pool = match PgPoolOptions::new().max_connections(1).connect(&db_url).await {
      Ok(pool) => pool,
      Err(_) => {
        eprintln!("skip: no reachable postgres for search readiness test");
        return;
      }
    };

    match verify_search_content_readiness(&pool).await {
      Ok(()) => {}
      Err(StartupCheckError::MissingTables(_)) | Err(StartupCheckError::MissingPrivileges(_)) => {
        eprintln!("skip: reachable postgres without full migrated/privileged search schema");
      }
      Err(err) => panic!("search readiness should not fail on connectivity path: {err}"),
    }
  }

  fn unique_temp_path(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("time should be monotonic")
      .as_nanos();
    std::env::temp_dir().join(format!("{prefix}-{nanos}"))
  }

  #[test]
  fn verify_local_storage_path_readiness_creates_missing_directory() {
    let root = unique_temp_path("myoxus-local-storage-root");
    let root_str = root.to_string_lossy().to_string();
    verify_local_storage_path_readiness(&root_str).expect("path readiness should pass");
    assert!(root.exists());
    assert!(root.is_dir());
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn verify_local_storage_path_readiness_rejects_non_directory_root() {
    let path = unique_temp_path("myoxus-local-storage-file");
    fs::write(&path, b"not a directory").expect("write file");
    let err = verify_local_storage_path_readiness(&path.to_string_lossy()).expect_err("file path must fail");
    assert!(matches!(err, StartupCheckError::StorageReadiness(_)));
    assert!(err.to_string().contains("not a directory"));
    let _ = fs::remove_file(&path);
  }

  #[test]
  fn verify_local_storage_free_space_works_with_default_off_setting() {
    let root = std::env::temp_dir();
    verify_local_storage_free_space(&root.to_string_lossy(), 0).expect("min_free_space_bytes=0 should skip check");
  }

  #[test]
  fn verify_local_storage_free_space_reports_insufficient_capacity() {
    let root = std::env::temp_dir();
    let err =
      verify_local_storage_free_space(&root.to_string_lossy(), u64::MAX).expect_err("extreme threshold should fail");
    assert!(matches!(err, StartupCheckError::StorageReadiness(_)));
    assert!(err.to_string().contains("insufficient free space"));
  }

  #[test]
  fn local_storage_permission_hint_is_added_for_permission_denied() {
    let err = io::Error::from(io::ErrorKind::PermissionDenied);
    let msg = super::local_storage_permission_hint("/tmp/myoxus", &err);
    assert!(msg.contains("MYOXUS_API_USER"));
    assert!(msg.contains("chown -R"));
  }
}
