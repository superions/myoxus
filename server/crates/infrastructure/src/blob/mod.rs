//! SQLx-backed blob metadata store implementation.
//!
//! [`SqlxBlobStore`] implements the [`BlobStore`] port from `myoxus-application`
//! against PostgreSQL. It tracks upload status, multi-part upload sessions,
//! comment-attachment associations, soft-delete timestamps for retention GC,
//! and per-workspace blob accounting.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::ports::blob::{
  BlobGcCandidate, BlobKey, BlobMetadata, BlobStatus, BlobStore, MultipartUploadedPart,
};
use sqlx::{PgPool, Row};
use tracing::{debug, error, info, instrument, warn};
use uuid::Uuid;

/// PostgreSQL-backed implementation of [`BlobStore`].
pub struct SqlxBlobStore {
  /// Database connection pool.
  pool: PgPool,
  /// Optional Redis cache for quota checks (P38 performance optimization).
  quota_cache: Option<std::sync::Arc<crate::quota_cache::QuotaCache>>,
  /// Default workspace storage quota in MB. 0 = unlimited.
  default_workspace_quota_mb: u64,
}

#[derive(Debug, Clone)]
pub struct OrphanedWorkspaceBlobCleanup {
  pub workspaces: Vec<(Uuid, i64)>,
  pub orphan_key_count: usize,
  pub deleted_rows: u64,
}

impl SqlxBlobStore {
  /// Construct a `SqlxBlobStore` from an existing pool.
  pub fn new(pool: PgPool) -> Self {
    Self {
      pool,
      quota_cache: None,
      default_workspace_quota_mb: 0,
    }
  }

  /// Attach a QuotaCache for faster quota enforcement.
  pub fn with_quota_cache(mut self, cache: std::sync::Arc<crate::quota_cache::QuotaCache>) -> Self {
    self.quota_cache = Some(cache);
    self
  }

  /// Configure storage quota defaults from server config.
  ///
  pub fn with_quota_config(mut self, default_workspace_quota_mb: u64) -> Self {
    self.default_workspace_quota_mb = default_workspace_quota_mb;
    self
  }

  /// Publish normal metadata and accounting in the Git finalization transaction.
  /// External bytes are already promoted and verified; this method writes only
  /// SQL metadata. The accounting lock serializes publication with normal uploads
  /// and unreferenced-object cleanup until the caller commits or rolls back.
  pub async fn reserve_markdown_import_assets_in_tx(
    &self,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    workspace_id: Uuid,
    assets: &[myoxus_application::markdown::PreparedMarkdownAssetWrite],
  ) -> AuthResult<std::collections::HashSet<String>> {
    let override_bytes: Option<i64> = sqlx::query_scalar(
      "SELECT storage_quota_bytes FROM workspaces WHERE id=$1 AND deleted_at IS NULL AND lifecycle_state='active'",
    )
    .bind(workspace_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    let quota = myoxus_application::quota::effective_quota_bytes(override_bytes, self.default_workspace_quota_mb);
    sqlx::query("INSERT INTO workspace_storage_stats (workspace_id,snapshot_size,blob_size) VALUES ($1,0,0) ON CONFLICT(workspace_id) DO NOTHING")
      .bind(workspace_id).execute(&mut **tx).await.map_err(Self::map_db_err)?;
    let usage: i64 = sqlx::query_scalar(
      "SELECT snapshot_size+blob_size FROM workspace_storage_stats WHERE workspace_id=$1 FOR UPDATE",
    )
    .bind(workspace_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Self::map_db_err)?;
    let mut existing = std::collections::HashSet::new();
    let mut added = 0u64;
    let mut ordered = assets.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| left.metadata.blob_key.cmp(&right.metadata.blob_key));
    for asset in ordered {
      let metadata = &asset.metadata;
      BlobKey::parse(&metadata.blob_key).map_err(AuthError::InvalidInput)?;
      let size =
        i64::try_from(metadata.size).map_err(|_| AuthError::InvalidInput("Markdown asset size exceeds i64".into()))?;
      let inserted = sqlx::query("INSERT INTO blobs (workspace_id,key,size,mime,checksum,status) VALUES ($1,$2,$3,$4,$5,'completed') ON CONFLICT(workspace_id,key) DO NOTHING")
        .bind(workspace_id).bind(&metadata.blob_key).bind(size).bind(&metadata.mime).bind(&metadata.checksum)
        .execute(&mut **tx).await.map_err(Self::map_db_err)?.rows_affected();
      let current: (i64, String, Option<String>, String, Option<chrono::DateTime<Utc>>) = sqlx::query_as(
        "SELECT size,mime,checksum,status,deleted_at FROM blobs WHERE workspace_id=$1 AND key=$2 FOR UPDATE",
      )
      .bind(workspace_id)
      .bind(&metadata.blob_key)
      .fetch_one(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
      if current.0 != size
        || current.1 != metadata.mime
        || current.2.as_deref() != Some(metadata.checksum.as_str())
        || current.3 != "completed"
        || current.4.is_some()
      {
        return Err(AuthError::InvalidInput(
          "Markdown asset metadata conflicts with existing blob".into(),
        ));
      }
      if inserted == 0 {
        existing.insert(metadata.blob_key.clone());
      } else {
        added = added
          .checked_add(metadata.size as u64)
          .ok_or_else(|| AuthError::InvalidInput("Markdown asset aggregate size overflow".into()))?;
      }
    }
    if quota > 0 && (usage.max(0) as u64).saturating_add(added) > quota {
      return Err(AuthError::StorageQuotaExceeded {
        workspace_id,
        current_bytes: usage.max(0) as u64,
        write_bytes: added,
        quota_bytes: quota,
      });
    }
    let added =
      i64::try_from(added).map_err(|_| AuthError::InvalidInput("Markdown asset aggregate size exceeds i64".into()))?;
    sqlx::query("UPDATE workspace_storage_stats SET blob_size=blob_size+$2,updated_at=now() WHERE workspace_id=$1")
      .bind(workspace_id)
      .bind(added)
      .execute(&mut **tx)
      .await
      .map_err(Self::map_db_err)?;
    Ok(existing)
  }

  /// Fence compensation of an attempt-owned external object after its SQL
  /// transaction ended. Hold this transaction through deletion: normal upload
  /// accounting serializes concurrent publication with the reference check.
  /// Legacy unscoped Git objects have no workspace accounting row.
  pub async fn lock_unreferenced_import_object_cleanup_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    storage_key: &str,
  ) -> AuthResult<bool> {
    if let Some(workspace) = storage_key.split('/').next().and_then(|key| Uuid::parse_str(key).ok()) {
      sqlx::query("INSERT INTO workspace_storage_stats(workspace_id,snapshot_size,blob_size) SELECT id,0,0 FROM workspaces WHERE id=$1 ON CONFLICT(workspace_id) DO NOTHING")
        .bind(workspace).execute(&mut **tx).await.map_err(Self::map_db_err)?;
      sqlx::query("SELECT workspace_id FROM workspace_storage_stats WHERE workspace_id=$1 FOR UPDATE")
        .bind(workspace)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Self::map_db_err)?;
    }
    let referenced:bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM git_sync_file_bindings WHERE tombstoned=false AND (blob_key=$1 OR workspace_id::text || '/' || blob_key=$1)) OR EXISTS(SELECT 1 FROM blobs WHERE workspace_id::text || '/' || key=$1)")
      .bind(storage_key).fetch_one(&mut **tx).await.map_err(Self::map_db_err)?;
    Ok(!referenced)
  }

  fn map_db_err(err: sqlx::Error) -> AuthError {
    error!(error = %err, "database error in blob store");
    AuthError::Storage(err.to_string())
  }

  fn map_blob_row(row: sqlx::postgres::PgRow) -> BlobMetadata {
    let status_str: String = row.get("status");
    let status = match status_str.to_lowercase().as_str() {
      "pending" => BlobStatus::Pending,
      "uploading" => BlobStatus::Uploading,
      "completed" => BlobStatus::Completed,
      "failed" => BlobStatus::Failed,
      _ => BlobStatus::Pending,
    };

    BlobMetadata {
      blob_id: row.get("blob_id"),
      workspace_id: row.get("workspace_id"),
      key: row.get("key"),
      size: row.get::<i64, _>("size") as u64,
      mime: row.get("mime"),
      checksum: row.get("checksum"),
      status,
      upload_id: row.get("upload_id"),
      created_at: row.get("created_at"),
      updated_at: row.get("updated_at"),
      deleted_at: row.get("deleted_at"),
    }
  }

  /// Existing rows, including trash and historical archives, protect blob bytes
  /// from delayed permanent-purge jobs produced by older callers.
  #[instrument(skip_all)]
  pub async fn workspace_record_exists(&self, workspace_id: Uuid) -> AuthResult<bool> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=$1)")
      .bind(workspace_id)
      .fetch_one(&self.pool)
      .await
      .map_err(Self::map_db_err)
  }

  /// Remove old blob rows with no Workspace record. Trash and historical
  /// archives retain their rows and bytes for lifecycle recovery.
  #[instrument(skip_all)]
  pub async fn clean_orphaned_workspace_blobs(
    &self,
    grace_hours: i64,
    workspace_limit: i64,
    key_limit: i64,
  ) -> AuthResult<OrphanedWorkspaceBlobCleanup> {
    let grace = i32::try_from(grace_hours.max(1)).unwrap_or(i32::MAX);
    let workspaces: Vec<(Uuid, i64)> = sqlx::query_as(
      "SELECT b.workspace_id, COUNT(*)::bigint FROM blobs b \
       LEFT JOIN workspaces w ON w.id = b.workspace_id \
       WHERE w.id IS NULL AND b.updated_at < NOW() - make_interval(hours => $1) \
       GROUP BY b.workspace_id LIMIT $2",
    )
    .bind(grace)
    .bind(workspace_limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if workspaces.is_empty() {
      return Ok(OrphanedWorkspaceBlobCleanup {
        workspaces,
        orphan_key_count: 0,
        deleted_rows: 0,
      });
    }
    let workspace_ids = workspaces.iter().map(|(id, _)| *id).collect::<Vec<_>>();
    let orphan_key_count =
      sqlx::query_scalar::<_, String>("SELECT key FROM blobs b WHERE workspace_id = ANY($1) AND updated_at < NOW() - make_interval(hours => $3) AND NOT EXISTS(SELECT 1 FROM workspaces w WHERE w.id=b.workspace_id) LIMIT $2")
        .bind(&workspace_ids)
        .bind(key_limit)
        .bind(grace)
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err)?
        .len();
    let deleted_rows = sqlx::query("DELETE FROM blobs b WHERE workspace_id = ANY($1) AND updated_at < NOW() - make_interval(hours => $2) AND NOT EXISTS(SELECT 1 FROM workspaces w WHERE w.id=b.workspace_id)")
      .bind(&workspace_ids)
      .bind(grace)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?
      .rows_affected();
    Ok(OrphanedWorkspaceBlobCleanup {
      workspaces,
      orphan_key_count,
      deleted_rows,
    })
  }

  /// Fail abandoned multipart uploads and remove their part ledger rows.
  pub async fn clean_stale_multipart_uploads(&self, retention_hours: i64, limit: i64) -> AuthResult<usize> {
    let upload_ids: Vec<String> = sqlx::query_scalar(
      "SELECT upload_id FROM blobs WHERE upload_id IS NOT NULL \
       AND created_at < NOW() - make_interval(hours => $1) LIMIT $2",
    )
    .bind(i32::try_from(retention_hours.max(1)).unwrap_or(i32::MAX))
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if upload_ids.is_empty() {
      return Ok(0);
    }
    let mut transaction = self.pool.begin().await.map_err(Self::map_db_err)?;
    sqlx::query(
      "UPDATE blobs SET upload_id = NULL, status = 'failed', updated_at = now() \
       WHERE upload_id = ANY($1)",
    )
    .bind(&upload_ids)
    .execute(&mut *transaction)
    .await
    .map_err(Self::map_db_err)?;
    sqlx::query("DELETE FROM multipart_blob_parts WHERE upload_id = ANY($1)")
      .bind(&upload_ids)
      .execute(&mut *transaction)
      .await
      .map_err(Self::map_db_err)?;
    transaction.commit().await.map_err(Self::map_db_err)?;
    Ok(upload_ids.len())
  }

  /// Recompute current workspace usage and persist today's trend snapshot.
  pub async fn reconcile_workspace_storage_stats(&self, day: chrono::NaiveDate) -> AuthResult<u64> {
    let mut transaction = self.pool.begin().await.map_err(Self::map_db_err)?;
    let reconciled = sqlx::query(
      r#"
      INSERT INTO workspace_storage_stats (workspace_id, snapshot_size, blob_size, updated_at)
      SELECT w.id,
        COALESCE((SELECT SUM(length(payload))::bigint FROM doc_snapshots ds WHERE ds.workspace_id = w.id), 0),
        COALESCE((SELECT SUM(size)::bigint FROM blobs b WHERE b.workspace_id = w.id), 0), now()
      FROM workspaces w WHERE w.deleted_at IS NULL
      ON CONFLICT (workspace_id) DO UPDATE SET
        snapshot_size = EXCLUDED.snapshot_size, blob_size = EXCLUDED.blob_size, updated_at = now()
      "#,
    )
    .execute(&mut *transaction)
    .await
    .map_err(Self::map_db_err)?
    .rows_affected();
    sqlx::query(
      r#"
      INSERT INTO workspace_storage_stats_daily (workspace_id, day, snapshot_size, blob_size)
      SELECT s.workspace_id, $1, s.snapshot_size, s.blob_size
      FROM workspace_storage_stats s
      WHERE EXISTS (SELECT 1 FROM workspaces w WHERE w.id = s.workspace_id)
      ON CONFLICT (workspace_id, day) DO UPDATE SET
        snapshot_size = EXCLUDED.snapshot_size, blob_size = EXCLUDED.blob_size
      "#,
    )
    .bind(day)
    .execute(&mut *transaction)
    .await
    .map_err(Self::map_db_err)?;
    transaction.commit().await.map_err(Self::map_db_err)?;
    Ok(reconciled)
  }
}

#[async_trait]
impl BlobStore for SqlxBlobStore {
  /// Insert or reset a blob metadata row (upserts on `(workspace_id, key)`).
  /// Also atomically updates `workspace_storage_stats.blob_size` (BF-SRV-02d).
  #[instrument(skip(self))]
  async fn create_blob_metadata(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    size: u64,
    mime: &str,
    checksum: Option<&str>,
  ) -> AuthResult<BlobMetadata> {
    debug!(%workspace_id, key = %key.as_str(), size, mime, checksum = ?checksum, "creating blob metadata row");

    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;

    // P37-B-03 + P38 + P112-QUOTA-B-01: Enforce workspace storage quota (cache-first).
    //
    // Priority chain (see quota_resolver::resolve_effective_quota_with_config):
    //   1. workspaces.storage_quota_bytes (workspace-level override)
    //   2. config default_workspace_quota_mb
    //   4. 0 = unlimited
    //
    // MED-09: Race condition mitigation for concurrent uploads.
    // On a cache-miss, the effective LIMIT is resolved using a non-transactional
    // pool read (quota limits change rarely).  The per-workspace USAGE is read
    // with SELECT ... FOR UPDATE inside the transaction to serialise concurrent
    // uploads for the same workspace.
    let effective_quota = if let Some(cache) = &self.quota_cache {
      match cache.get_quota(workspace_id).await {
        Some(q) => q,
        None => {
          // Cache miss: resolve via JOIN query honouring the full 4-level hierarchy.
          let effective =
            crate::quota_resolver::resolve_effective_quota(&self.pool, workspace_id, self.default_workspace_quota_mb)
              .await;
          cache.set_quota(workspace_id, effective).await;
          effective
        }
      }
    } else {
      // No cache: resolve directly via JOIN query.
      crate::quota_resolver::resolve_effective_quota(&self.pool, workspace_id, self.default_workspace_quota_mb).await
    };

    if effective_quota > 0 {
      let current_usage = if let Some(cache) = &self.quota_cache {
        match cache.get_usage(workspace_id).await {
          Some((snap, blob)) => (snap + blob) as i64,
          None => {
            // MED-09: FOR UPDATE locks the row to prevent concurrent uploads from
            // both passing the quota check. This serializes quota enforcement per workspace.
            sqlx::query_scalar(
              "SELECT COALESCE(snapshot_size, 0) + COALESCE(blob_size, 0) FROM workspace_storage_stats WHERE workspace_id = $1 FOR UPDATE",
            )
            .bind(workspace_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(Self::map_db_err)?
            .unwrap_or(0)
          }
        }
      } else {
        // MED-09: FOR UPDATE locks the row to prevent concurrent uploads from
        // both passing the quota check.
        sqlx::query_scalar(
          "SELECT COALESCE(snapshot_size, 0) + COALESCE(blob_size, 0) FROM workspace_storage_stats WHERE workspace_id = $1 FOR UPDATE",
        )
        .bind(workspace_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?
        .unwrap_or(0)
      };

      let projected = (current_usage as u64).saturating_add(size);
      if projected > effective_quota {
        warn!(
          %workspace_id, key = %key.as_str(), current_usage, quota = effective_quota, size,
          "blob write rejected: storage quota exceeded"
        );
        return Err(AuthError::StorageQuotaExceeded {
          workspace_id,
          current_bytes: current_usage as u64,
          write_bytes: size,
          quota_bytes: effective_quota,
        });
      }
    }

    let row = sqlx::query(
            r#"
            INSERT INTO blobs (workspace_id, key, size, mime, checksum, status)
            VALUES ($1, $2, $3, $4, $5, 'pending')
            ON CONFLICT (workspace_id, key) DO UPDATE
            SET size = EXCLUDED.size,
                mime = EXCLUDED.mime,
                checksum = EXCLUDED.checksum,
                status = 'pending',
                upload_id = NULL,
                deleted_at = NULL,
                updated_at = now()
            RETURNING blob_id, workspace_id, key, size, mime, checksum, status, upload_id, created_at, updated_at, deleted_at
            "#
        )
        .bind(workspace_id)
        .bind(key.as_str())
        .bind(size as i64)
        .bind(mime)
        .bind(checksum)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;

    // MED-12 + LOW-09: O(1) atomic increment of workspace_storage_stats.blob_size.
    // Uses blob_size + $2 instead of recalculating SUM(size) on every insert.
    // The nightly reconcileStorageStats job corrects any drift.
    // The ON CONFLICT upsert makes this idempotent — first insert initializes
    // with the new blob size, subsequent inserts atomically increment.
    sqlx::query(
      r#"
      INSERT INTO workspace_storage_stats (workspace_id, snapshot_size, blob_size, updated_at)
      VALUES ($1, 0, $2, now())
      ON CONFLICT (workspace_id) DO UPDATE SET
        blob_size = workspace_storage_stats.blob_size + $2,
        updated_at = now()
      "#,
    )
    .bind(workspace_id)
    .bind(size as i64)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    tx.commit().await.map_err(Self::map_db_err)?;

    // P38: Invalidate usage cache after successful write
    if let Some(cache) = &self.quota_cache {
      cache.invalidate_usage(workspace_id).await;
    }

    let mapped = Self::map_blob_row(row);
    info!(%workspace_id, key = %key.as_str(), blob_id = %mapped.blob_id, "blob metadata created, storage stats updated");
    Ok(mapped)
  }

  #[instrument(skip(self))]
  async fn register_completed_blob_metadata(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    size: u64,
    mime: &str,
  ) -> AuthResult<()> {
    let size = i64::try_from(size).map_err(|_| AuthError::InvalidInput("Blob size exceeds i64".to_string()))?;
    sqlx::query(
      "INSERT INTO blobs (workspace_id, key, size, mime, status, created_at) \
       VALUES ($1, $2, $3, $4, 'completed', NOW()) ON CONFLICT DO NOTHING",
    )
    .bind(workspace_id)
    .bind(key.as_str())
    .bind(size)
    .bind(mime)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Fetch a non-deleted blob's metadata, returning `None` when not found.
  #[instrument(skip(self))]
  async fn get_blob_metadata(&self, workspace_id: Uuid, key: &BlobKey) -> AuthResult<Option<BlobMetadata>> {
    debug!(%workspace_id, key = %key.as_str(), "fetching blob metadata row");
    let row = sqlx::query(
            r#"
            SELECT blob_id, workspace_id, key, size, mime, checksum, status, upload_id, created_at, updated_at, deleted_at
            FROM blobs
            WHERE workspace_id = $1 AND key = $2 AND deleted_at IS NULL
            "#
        )
        .bind(workspace_id)
        .bind(key.as_str())
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    let found = row.is_some();
    debug!(%workspace_id, key = %key.as_str(), found, "blob metadata lookup completed");
    Ok(row.map(Self::map_blob_row))
  }

  /// Update the upload-lifecycle status of a blob.
  #[instrument(skip(self))]
  async fn update_blob_status(&self, workspace_id: Uuid, key: &BlobKey, status: BlobStatus) -> AuthResult<()> {
    let status_str = match status {
      BlobStatus::Pending => "pending",
      BlobStatus::Uploading => "uploading",
      BlobStatus::Completed => "completed",
      BlobStatus::Failed => "failed",
    };

    let result = sqlx::query(
      "UPDATE blobs SET status = $3, updated_at = now() WHERE workspace_id = $1 AND key = $2 AND deleted_at IS NULL",
    )
    .bind(workspace_id)
    .bind(key.as_str())
    .bind(status_str)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      warn!(%workspace_id, key = %key.as_str(), status = status_str, "blob status update affected no rows");
    } else {
      info!(%workspace_id, key = %key.as_str(), status = status_str, "blob status updated");
    }
    Ok(())
  }

  /// Persist the S3 multipart `upload_id` and transition the blob to
  /// `uploading`.
  #[instrument(skip(self))]
  async fn set_upload_id(&self, workspace_id: Uuid, key: &BlobKey, upload_id: &str) -> AuthResult<()> {
    let result = sqlx::query("UPDATE blobs SET upload_id = $3, status = 'uploading', updated_at = now() WHERE workspace_id = $1 AND key = $2 AND deleted_at IS NULL")
            .bind(workspace_id)
            .bind(key.as_str())
            .bind(upload_id)
            .execute(&self.pool)
            .await
            .map_err(Self::map_db_err)?;
    if result.rows_affected() == 0 {
      warn!(%workspace_id, key = %key.as_str(), upload_id, "set_upload_id affected no rows");
    } else {
      info!(%workspace_id, key = %key.as_str(), upload_id, "set blob upload id");
    }
    Ok(())
  }

  /// Hard-delete blob metadata immediately (bypasses soft-delete).
  #[instrument(skip(self))]
  async fn delete_blob_metadata(&self, workspace_id: Uuid, key: &BlobKey) -> AuthResult<()> {
    let result = sqlx::query("DELETE FROM blobs WHERE workspace_id = $1 AND key = $2")
      .bind(workspace_id)
      .bind(key.as_str())
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    debug!(%workspace_id, key = %key.as_str(), rows_affected = result.rows_affected(), "deleted blob metadata rows");
    Ok(())
  }

  /// Record (or update) a completed multipart part's ETag.
  #[instrument(skip(self))]
  async fn upsert_multipart_part(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    upload_id: &str,
    part_number: i32,
    etag: &str,
  ) -> AuthResult<()> {
    debug!(%workspace_id, key = %key.as_str(), upload_id, part_number, "upserting multipart part etag");
    sqlx::query(
      r#"
            INSERT INTO multipart_blob_parts (workspace_id, key, upload_id, part_number, etag)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (workspace_id, key, upload_id, part_number)
            DO UPDATE SET etag = EXCLUDED.etag, updated_at = now()
            "#,
    )
    .bind(workspace_id)
    .bind(key.as_str())
    .bind(upload_id)
    .bind(part_number)
    .bind(etag)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    info!(%workspace_id, key = %key.as_str(), upload_id, part_number, "multipart part upserted");
    Ok(())
  }

  /// List all completed parts for a multipart upload, ordered by part number.
  #[instrument(skip(self))]
  async fn list_multipart_parts(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    upload_id: &str,
  ) -> AuthResult<Vec<MultipartUploadedPart>> {
    let rows = sqlx::query(
      r#"
            SELECT part_number, etag
            FROM multipart_blob_parts
            WHERE workspace_id = $1 AND key = $2 AND upload_id = $3
            ORDER BY part_number ASC
            "#,
    )
    .bind(workspace_id)
    .bind(key.as_str())
    .bind(upload_id)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let out = rows
      .into_iter()
      .map(|row| MultipartUploadedPart {
        part_number: row.get("part_number"),
        etag: row.get("etag"),
      })
      .collect::<Vec<_>>();
    debug!(%workspace_id, key = %key.as_str(), upload_id, parts = out.len(), "listed multipart parts");
    Ok(out)
  }

  /// Delete all part records for a multipart upload after it has been
  /// completed or aborted.
  ///
  /// MED-11 Accepted: Part records are only cleaned up when this method is
  /// called explicitly (on successful complete or abort). If a multipart upload
  /// is abandoned (client disconnects mid-upload), the DB part records remain
  /// indefinitely. These should be cleaned by a nightly GC job (similar to
  /// `nightly_cleanup`) that identifies uploads older than a configurable
  /// threshold (e.g. 24h) and removes their part records + aborts the
  /// corresponding storage-backend multipart upload.
  /// TODO(P82): Implement nightly GC for abandoned multipart uploads.
  /// Identify uploads older than a configurable threshold (e.g. 24h), remove
  /// their DB part records, and abort the corresponding storage-backend
  /// multipart upload. Track in todo/server.md under P82.
  #[instrument(skip(self))]
  async fn clear_multipart_parts(&self, workspace_id: Uuid, key: &BlobKey, upload_id: &str) -> AuthResult<()> {
    let result =
      sqlx::query("DELETE FROM multipart_blob_parts WHERE workspace_id = $1 AND key = $2 AND upload_id = $3")
        .bind(workspace_id)
        .bind(key.as_str())
        .bind(upload_id)
        .execute(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    info!(%workspace_id, key = %key.as_str(), upload_id, rows_affected = result.rows_affected(), "cleared multipart parts");
    Ok(())
  }

  /// Create a `comment_attachments` row linking a blob key to a comment
  /// document without yet assigning it to a specific comment.
  #[instrument(skip(self))]
  async fn bind_comment_attachment(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    key: &BlobKey,
    mime: &str,
    size: u64,
    created_by: Uuid,
  ) -> AuthResult<()> {
    debug!(%workspace_id, %doc_id, key = %key.as_str(), mime, size, %created_by, "binding comment attachment");
    sqlx::query(
      r#"
            INSERT INTO comment_attachments (workspace_id, doc_id, storage_key, mime_type, size_bytes, created_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(key.as_str())
    .bind(mime)
    .bind(size as i64)
    .bind(created_by)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    info!(%workspace_id, %doc_id, key = %key.as_str(), %created_by, "comment attachment bound");
    Ok(())
  }

  /// Associate an existing attachment record with a specific comment ID.
  /// Returns `true` when the update matched a row.
  #[instrument(skip(self))]
  async fn attach_comment_attachment_to_comment(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    comment_id: Uuid,
    key: &BlobKey,
    user_id: Uuid,
  ) -> AuthResult<bool> {
    let result = sqlx::query(
      r#"
            UPDATE comment_attachments
            SET comment_id = $4
            WHERE workspace_id = $1
              AND doc_id = $2
              AND storage_key = $3
              AND (comment_id IS NULL OR comment_id = $4)
              AND created_by = $5
            "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(key.as_str())
    .bind(comment_id)
    .bind(user_id)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    let attached = result.rows_affected() > 0;
    info!(
        %workspace_id,
        %doc_id,
        %comment_id,
        key = %key.as_str(),
        %user_id,
        attached,
        "comment attachment linkage request completed"
    );
    Ok(attached)
  }

  /// Mark a blob as deleted without removing the row immediately (for GC
  /// later).  Returns `true` when a row was updated.
  /// Also atomically updates `workspace_storage_stats.blob_size` (BF-SRV-02d).
  #[instrument(skip(self))]
  async fn soft_delete_blob_metadata(
    &self,
    workspace_id: Uuid,
    key: &BlobKey,
    when: DateTime<Utc>,
  ) -> AuthResult<bool> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;

    // MED-10: Check if the blob has an active multipart upload before soft-deleting.
    // If it does, log a warning. The upload_id is set to NULL below. The orphaned
    // multipart upload parts on the storage backend will be cleaned by the nightly
    // GC job `nightly.cleanStaleMultipartUploads` which identifies blobs with
    // non-null upload_id older than 24h, aborts them via BlobStoragePort, and
    // clears the upload_id. The BlobStore trait intentionally does not hold a
    // BlobStoragePort reference — abort is handled at the handler/GC layer.
    let active_upload_id: Option<String> =
      sqlx::query_scalar("SELECT upload_id FROM blobs WHERE workspace_id = $1 AND key = $2 AND upload_id IS NOT NULL")
        .bind(workspace_id)
        .bind(key.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?
        .flatten();

    if let Some(ref uid) = active_upload_id {
      warn!(
        %workspace_id,
        key = %key.as_str(),
        upload_id = %uid,
        "soft-deleting blob with active multipart upload — orphaned parts will be cleaned by nightly GC"
      );
    }

    let result = sqlx::query(
            "UPDATE blobs SET deleted_at = COALESCE(deleted_at, $3), status = CASE WHEN status = 'completed' THEN status ELSE 'failed' END, upload_id = NULL, updated_at = now() WHERE workspace_id = $1 AND key = $2"
        )
        .bind(workspace_id)
        .bind(key.as_str())
        .bind(when)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;

    let deleted = result.rows_affected() > 0;

    if deleted {
      // MED-12: O(1) atomic decrement of workspace_storage_stats.blob_size.
      // Fetch the blob's size to subtract it from the running total.
      let blob_size: Option<i64> = sqlx::query_scalar("SELECT size FROM blobs WHERE workspace_id = $1 AND key = $2")
        .bind(workspace_id)
        .bind(key.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;

      if let Some(sz) = blob_size {
        sqlx::query(
          r#"
          UPDATE workspace_storage_stats SET
            blob_size = GREATEST(blob_size - $2, 0),
            updated_at = now()
          WHERE workspace_id = $1
          "#,
        )
        .bind(workspace_id)
        .bind(sz)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      }
    }

    tx.commit().await.map_err(Self::map_db_err)?;

    info!(%workspace_id, key = %key.as_str(), deleted, when = %when, "soft-delete blob metadata completed, storage stats updated");
    Ok(deleted)
  }

  /// Permanently remove a blob row that has already been soft-deleted.
  /// Returns `true` when a row was deleted.
  #[instrument(skip(self))]
  async fn hard_delete_blob_metadata(&self, workspace_id: Uuid, key: &BlobKey) -> AuthResult<bool> {
    let result = sqlx::query("DELETE FROM blobs WHERE workspace_id = $1 AND key = $2 AND deleted_at IS NOT NULL")
      .bind(workspace_id)
      .bind(key.as_str())
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    let deleted = result.rows_affected() > 0;
    info!(%workspace_id, key = %key.as_str(), deleted, "hard-delete blob metadata request completed");
    Ok(deleted)
  }

  /// List soft-deleted blobs whose `deleted_at` is at or before
  /// `deleted_before`, up to `limit` rows, for GC processing.
  #[instrument(skip(self))]
  async fn list_retention_gc_candidates(
    &self,
    deleted_before: DateTime<Utc>,
    limit: i64,
  ) -> AuthResult<Vec<BlobGcCandidate>> {
    let rows = sqlx::query(
      r#"
            SELECT workspace_id, key, deleted_at
            FROM blobs
            WHERE deleted_at IS NOT NULL
              AND deleted_at <= $1
            ORDER BY deleted_at ASC
            LIMIT $2
            "#,
    )
    .bind(deleted_before)
    .bind(limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let candidates = rows
      .into_iter()
      .map(|row| BlobGcCandidate {
        workspace_id: row.get("workspace_id"),
        key: row.get("key"),
        deleted_at: row.get("deleted_at"),
      })
      .collect::<Vec<_>>();
    debug!(deleted_before = %deleted_before, limit, candidates = candidates.len(), "loaded retention GC candidates");
    Ok(candidates)
  }

  /// List blobs in a workspace with offset pagination.  When
  /// `include_deleted` is `false`, soft-deleted blobs are excluded.
  #[instrument(skip(self))]
  async fn list_workspace_blobs(
    &self,
    workspace_id: Uuid,
    limit: i64,
    offset: i64,
    include_deleted: bool,
  ) -> AuthResult<Vec<BlobMetadata>> {
    let clamped_limit = limit.clamp(1, 200);
    let clamped_offset = offset.max(0);
    let rows = sqlx::query(
            r#"
            SELECT blob_id, workspace_id, key, size, mime, checksum, status, upload_id, created_at, updated_at, deleted_at
            FROM blobs
            WHERE workspace_id = $1
              AND ($4 OR deleted_at IS NULL)
            ORDER BY created_at DESC, key ASC
            LIMIT $2 OFFSET $3
            "#
        )
        .bind(workspace_id)
        .bind(clamped_limit)
        .bind(clamped_offset)
        .bind(include_deleted)
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err)?;
    Ok(rows.into_iter().map(Self::map_blob_row).collect())
  }

  #[instrument(skip(self))]
  async fn list_workspace_blob_keys_for_deletion(&self, workspace_id: Uuid) -> AuthResult<Vec<String>> {
    sqlx::query_scalar("SELECT key FROM blobs WHERE workspace_id = $1 ORDER BY created_at DESC, key ASC")
      .bind(workspace_id)
      .fetch_all(&self.pool)
      .await
      .map_err(Self::map_db_err)
  }

  /// Return the total byte usage of blobs in a workspace.
  #[instrument(skip(self))]
  async fn sum_workspace_blob_size(&self, workspace_id: Uuid, include_deleted: bool) -> AuthResult<u64> {
    let row = sqlx::query(
      r#"
            SELECT COALESCE(SUM(size), 0)::bigint AS total_size
            FROM blobs
            WHERE workspace_id = $1
              AND ($2 OR deleted_at IS NULL)
            "#,
    )
    .bind(workspace_id)
    .bind(include_deleted)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    let total_size: i64 = row.get("total_size");
    Ok(total_size.max(0) as u64)
  }

  #[instrument(skip(self))]
  async fn sum_user_workspace_blob_size(&self, user_id: Uuid) -> AuthResult<u64> {
    let total = sqlx::query_scalar::<_, i64>(
      r#"SELECT COALESCE(SUM(b.size), 0)::bigint
         FROM blobs b
         WHERE b.deleted_at IS NULL
           AND b.workspace_id IN (
             SELECT membership.workspace_id
             FROM workspace_memberships membership
             JOIN workspaces workspace ON workspace.id = membership.workspace_id
               AND workspace.lifecycle_state = 'active'
               AND workspace.deleted_at IS NULL
             WHERE membership.user_id = $1
           )"#,
    )
    .bind(user_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(total.max(0) as u64)
  }

  /// Unconditionally hard-delete a blob row regardless of `deleted_at`.
  /// Returns `true` when a row was removed.
  #[instrument(skip(self))]
  async fn hard_delete_blob(&self, workspace_id: Uuid, key: &BlobKey) -> AuthResult<bool> {
    let result = sqlx::query("DELETE FROM blobs WHERE workspace_id = $1 AND key = $2")
      .bind(workspace_id)
      .bind(key.as_str())
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(result.rows_affected() > 0)
  }

  #[instrument(skip(self))]
  async fn get_comment_attachment_download(
    &self,
    workspace_id: Uuid,
    doc_id: Uuid,
    key: &BlobKey,
  ) -> AuthResult<Option<myoxus_application::ports::blob::CommentAttachmentDownload>> {
    let row = sqlx::query(
      r#"
      SELECT mime_type, size_bytes, storage_key
      FROM comment_attachments
      WHERE workspace_id = $1 AND doc_id = $2 AND storage_key = $3
      LIMIT 1
      "#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(key.as_str())
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(
      row.map(|row| myoxus_application::ports::blob::CommentAttachmentDownload {
        storage_key: row.get("storage_key"),
        mime_type: row.get("mime_type"),
        size_bytes: row.get::<i64, _>("size_bytes").max(0) as u64,
      }),
    )
  }

  /// Fetch GC candidates scoped to a single workspace, up to `limit` rows.
  #[instrument(skip(self))]
  async fn release_deleted_blobs_in_workspace(
    &self,
    workspace_id: Uuid,
    deleted_before: DateTime<Utc>,
    limit: i64,
  ) -> AuthResult<Vec<BlobGcCandidate>> {
    let safe_limit = limit.clamp(1, 5000);
    let rows = sqlx::query(
      r#"
            SELECT workspace_id, key, deleted_at
            FROM blobs
            WHERE workspace_id = $1
              AND deleted_at IS NOT NULL
              AND deleted_at <= $2
            ORDER BY deleted_at ASC
            LIMIT $3
            "#,
    )
    .bind(workspace_id)
    .bind(deleted_before)
    .bind(safe_limit)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(
      rows
        .into_iter()
        .map(|row| BlobGcCandidate {
          workspace_id: row.get("workspace_id"),
          key: row.get("key"),
          deleted_at: row.get("deleted_at"),
        })
        .collect(),
    )
  }
}
