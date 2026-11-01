//! Blob storage adapter backed by opendal (local filesystem or S3).
//!
//! [`StorageAdapter`] implements [`BlobStoragePort`] and supports two storage
//! backends:
//!
//! - **Filesystem** (`StorageBackend::Fs`): writes are atomic (write-to-temp
//!   then rename with size verification) to avoid partial files.
//! - **S3** (`StorageBackend::S3`): writes, reads, and deletes are retried up
//!   to `S3_MAX_ATTEMPTS` times with exponential back-off and a per-attempt
//!   timeout of `DEFAULT_S3_IO_TIMEOUT` (configurable).
//!
//! Multipart uploads are simulated in-process using temporary part files
//! that are concatenated on completion.

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::TryStreamExt;
use opendal::Operator;
use opendal::services::{Fs, S3};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::RwLock;
use tracing::{debug, error, info, instrument, warn};
use uuid::Uuid;

use myoxus_application::ports::{
  BlobPathWriteRequest, BlobReadResponse, BlobStoragePort, BlobWriteRequest, MultipartCompleteRequest,
  MultipartCreateRequest, MultipartCreateResponse, MultipartPartUrlRequest, MultipartPartUrlResponse, PortError,
  PortResult,
};

/// Which storage backend the adapter is using.
#[derive(Debug, Clone, Copy)]
enum StorageBackend {
  /// Local filesystem via opendal `Fs` service.
  Fs,
  /// Amazon S3 (or S3-compatible) via opendal `S3` service.
  S3,
}

/// Default per-attempt I/O timeout for S3 operations.
const DEFAULT_S3_IO_TIMEOUT: Duration = Duration::from_secs(15);

/// Default maximum number of attempts for each S3 operation before giving up.
const DEFAULT_S3_MAX_ATTEMPTS: usize = 3;

/// opendal-backed blob storage adapter.
pub struct StorageAdapter {
  /// The opendal operator (configured for either Fs or S3).
  op: Operator,
  /// Which backend is active.
  backend: StorageBackend,
  /// Per-attempt I/O timeout for S3 operations.
  io_timeout: Duration,
  /// Maximum number of attempts for each S3 operation.
  s3_max_attempts: usize,
  /// In-process multipart upload sessions keyed by upload ID.
  multipart_sessions: Arc<RwLock<HashMap<Uuid, MultipartSession>>>,
}

/// Configuration for an S3 or S3-compatible storage backend.
pub struct S3StorageConfig<'a> {
  pub bucket: &'a str,
  pub prefix: Option<&'a str>,
  pub endpoint: Option<&'a str>,
  pub region: Option<&'a str>,
  pub access_key: Option<&'a str>,
  pub secret_key: Option<&'a str>,
  pub io_timeout_seconds: Option<u64>,
  pub max_retries: Option<usize>,
}

/// State for an in-progress multipart upload.
#[derive(Debug, Clone)]
struct MultipartSession {
  /// Final destination key for the assembled object.
  key: String,
  /// Part numbers that have been registered so far.
  parts: BTreeSet<i32>,
}

impl StorageAdapter {
  /// Create a `StorageAdapter` backed by the local filesystem at `root`.
  pub fn new_fs(root: &str) -> PortResult<Self> {
    let mut builder = Fs::default();
    builder = builder.root(root);

    let op = Operator::new(builder).map_err(|e| PortError::Transport(e.to_string()))?;

    info!(root, "initialized local fs storage adapter");
    Ok(Self {
      op,
      backend: StorageBackend::Fs,
      io_timeout: DEFAULT_S3_IO_TIMEOUT,
      s3_max_attempts: DEFAULT_S3_MAX_ATTEMPTS,
      multipart_sessions: Arc::new(RwLock::new(HashMap::new())),
    })
  }

  /// Create a `StorageAdapter` backed by an S3 (or S3-compatible) bucket.
  ///
  /// `io_timeout_seconds` sets the per-attempt I/O timeout for S3 operations.
  /// Pass `None` to use the default (15 s).
  ///
  /// `max_retries` sets the maximum number of retry attempts for each S3 operation.
  /// Pass `None` to use the default (3).
  pub fn new_s3(
    config: S3StorageConfig<'_>,
    additional_ca: Option<&crate::tls::ValidatedCaBundle>,
  ) -> PortResult<Self> {
    // OpenDAL requires explicit service registration with default features off.
    crate::tls::initialize_crypto_provider();
    opendal::init_default_registry();
    // Each operator owns its trust. Never replace a process-global transport or
    // drop public roots when adding the immutable bootstrap bundle.
    let mut http = reqwest::Client::builder();
    if let Some(bundle) = additional_ca {
      let roots = bundle
        .certificates()
        .iter()
        .map(|der| reqwest::Certificate::from_der(der))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PortError::Transport("invalid OpenDAL bootstrap CA roots".into()))?;
      http = http.tls_certs_merge(roots);
    }
    let http = http
      .build()
      .map_err(|_| PortError::Transport("OpenDAL TLS client initialization failed".into()))?;
    let context = opendal::OperationContext::new().with_http_transport(opendal::HttpTransporter::new(
      opendal_http_transport_reqwest::ReqwestTransport::new(http),
    ));
    let mut builder = S3::default();
    builder = builder.bucket(config.bucket);
    if let Some(p) = config.prefix {
      builder = builder.root(p);
    }
    if let Some(e) = config.endpoint {
      builder = builder.endpoint(e);
    }
    if let Some(r) = config.region {
      builder = builder.region(r);
    }
    if let Some(ak) = config.access_key {
      builder = builder.access_key_id(ak);
    }
    if let Some(sk) = config.secret_key {
      builder = builder.secret_access_key(sk);
    }

    let op = Operator::new(builder).map_err(|e| PortError::Transport(e.to_string()))?;

    let op = op.with_context(context);
    let io_timeout = config
      .io_timeout_seconds
      .map(Duration::from_secs)
      .unwrap_or(DEFAULT_S3_IO_TIMEOUT);
    let s3_max_attempts = config.max_retries.unwrap_or(DEFAULT_S3_MAX_ATTEMPTS);
    info!(
      bucket = config.bucket,
      prefix = ?config.prefix,
      endpoint = ?config.endpoint,
      io_timeout_secs = io_timeout.as_secs(),
      s3_max_attempts,
      "initialized s3 storage adapter"
    );
    Ok(Self {
      op,
      backend: StorageBackend::S3,
      io_timeout,
      s3_max_attempts,
      multipart_sessions: Arc::new(RwLock::new(HashMap::new())),
    })
  }

  /// Borrow a clone of the underlying opendal operator.
  ///
  /// Used by typed sub-stores (e.g. [`crate::pdf_export::PdfBlobStore`]) that
  /// want to share the same backend configuration (Fs vs. S3) but enforce
  /// their own path conventions on top of it.
  pub fn operator(&self) -> Operator {
    self.op.clone()
  }

  fn multipart_part_key(upload_id: Uuid, part_number: i32) -> String {
    format!("__multipart/{upload_id}/{part_number:05}")
  }

  #[instrument(skip_all, level = "trace")]
  async fn read_multipart_part(&self, upload_id: Uuid, part_number: i32) -> PortResult<Bytes> {
    let key = Self::multipart_part_key(upload_id, part_number);
    self
      .op
      .read(&key)
      .await
      .map(|b| b.to_bytes())
      .map_err(|e| Self::map_storage_error(&key, e))
  }

  #[instrument(skip_all, level = "trace")]
  async fn delete_multipart_part(&self, upload_id: Uuid, part_number: i32) {
    let key = Self::multipart_part_key(upload_id, part_number);
    let _ = self.op.delete(&key).await;
  }

  #[instrument(skip_all, level = "trace")]
  async fn write_blob_fs_atomic(&self, req: &BlobWriteRequest) -> PortResult<()> {
    let temp_key = format!("{}.tmp-{}", req.key, Uuid::new_v4());
    debug!(key = %req.key, temp_key, size = req.body.len(), "writing blob through fs atomic path");

    self
      .op
      .write(&temp_key, req.body.clone())
      .await
      .map_err(|e| PortError::Transport(e.to_string()))?;

    // Verify write before commit: reject partial writes early.
    let stat = self
      .op
      .stat(&temp_key)
      .await
      .map_err(|e| PortError::Transport(e.to_string()))?;
    if stat.content_length() != req.body.len() as u64 {
      warn!(
        key = %req.key,
        temp_key,
        expected_size = req.body.len(),
        actual_size = stat.content_length(),
        "atomic fs write verification failed on size check"
      );
      let _ = self.op.delete(&temp_key).await;
      return Err(PortError::Transport(
        "atomic fs write size verification failed".to_string(),
      ));
    }

    self.op.rename(&temp_key, &req.key).await.map_err(|e| {
      error!(key = %req.key, temp_key, error = %e, "failed to commit atomic fs write");
      PortError::Transport(e.to_string())
    })?;
    Ok(())
  }

  fn map_storage_error(key: &str, err: opendal::Error) -> PortError {
    if err.kind() == opendal::ErrorKind::NotFound {
      return PortError::NotFound(key.to_string());
    }
    PortError::Transport(err.to_string())
  }
}

#[async_trait]
impl BlobStoragePort for StorageAdapter {
  #[instrument(skip(self, req))]
  async fn write_blob(&self, req: BlobWriteRequest) -> PortResult<()> {
    let expected_size = req.body.len();
    debug!(key = %req.key, size = expected_size, "writing blob");
    match self.backend {
      StorageBackend::Fs => self.write_blob_fs_atomic(&req).await?,
      StorageBackend::S3 => {
        let mut last_error = None;
        for attempt in 1..=self.s3_max_attempts {
          let write_fut = if let Some(ct) = req.content_type.as_deref() {
            self.op.write_with(&req.key, req.body.clone()).content_type(ct)
          } else {
            self.op.write_with(&req.key, req.body.clone())
          };
          let write_result = tokio::time::timeout(self.io_timeout, write_fut).await;
          match write_result {
            Ok(Ok(_metadata)) => {
              debug!(key = %req.key, attempt, "s3 write succeeded");
              last_error = None;
              break;
            }
            Ok(Err(err)) => {
              warn!(key = %req.key, attempt, error = %err, "s3 write failed");
              last_error = Some(Self::map_storage_error(&req.key, err));
            }
            Err(_) => {
              warn!(key = %req.key, attempt, timeout_secs = self.io_timeout.as_secs(), "s3 write timed out");
              last_error = Some(PortError::Transport(format!(
                "s3 write timeout after {}s",
                self.io_timeout.as_secs()
              )));
            }
          }
          if last_error.is_some() && attempt < self.s3_max_attempts {
            let backoff = Duration::from_millis(100 * attempt as u64);
            tokio::time::sleep(backoff).await;
          }
        }
        if let Some(err) = last_error {
          error!(key = %req.key, error = %err, "s3 write failed after retries");
          return Err(err);
        }
      }
    }

    // Verify-read contract: read metadata right after write.
    let stat = self
      .op
      .stat(&req.key)
      .await
      .map_err(|e| PortError::Transport(e.to_string()))?;
    if stat.content_length() == 0 && expected_size > 0 {
      warn!(key = %req.key, expected_size, "write verification returned empty object for non-empty payload");
      return Err(PortError::Transport(
        "write verification failed after blob write".to_string(),
      ));
    }
    Ok(())
  }

  #[instrument(skip(self, req), fields(key = %req.key, expected_size = req.expected_size))]
  async fn write_blob_from_path(&self, req: BlobPathWriteRequest) -> PortResult<()> {
    let metadata = tokio::fs::metadata(&req.path)
      .await
      .map_err(|error| PortError::Transport(error.to_string()))?;
    if metadata.len() != req.expected_size {
      return Err(PortError::InvalidInput(
        "path-backed blob size does not match the declared size".to_string(),
      ));
    }
    let write_key = match self.backend {
      StorageBackend::Fs => format!("{}.tmp-{}", req.key, Uuid::new_v4()),
      StorageBackend::S3 => req.key.clone(),
    };
    let mut writer = if let Some(content_type) = req.content_type.as_deref() {
      self
        .op
        .writer_with(&write_key)
        .content_type(content_type)
        .await
        .map_err(|error| PortError::Transport(error.to_string()))?
    } else {
      self
        .op
        .writer(&write_key)
        .await
        .map_err(|error| PortError::Transport(error.to_string()))?
    };
    let mut file = tokio::fs::File::open(&req.path)
      .await
      .map_err(|error| PortError::Transport(error.to_string()))?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
      let read = file
        .read(&mut buffer)
        .await
        .map_err(|error| PortError::Transport(error.to_string()))?;
      if read == 0 {
        break;
      }
      if let Err(error) = writer.write(Bytes::copy_from_slice(&buffer[..read])).await {
        let _ = writer.abort().await;
        let _ = self.op.delete(&write_key).await;
        return Err(PortError::Transport(error.to_string()));
      }
    }
    writer
      .close()
      .await
      .map_err(|error| PortError::Transport(error.to_string()))?;
    let stat = self
      .op
      .stat(&write_key)
      .await
      .map_err(|error| PortError::Transport(error.to_string()))?;
    if stat.content_length() != req.expected_size {
      let _ = self.op.delete(&write_key).await;
      return Err(PortError::Transport("path-backed blob verification failed".to_string()));
    }
    if matches!(self.backend, StorageBackend::Fs) {
      self
        .op
        .rename(&write_key, &req.key)
        .await
        .map_err(|error| PortError::Transport(error.to_string()))?;
    }
    Ok(())
  }

  #[instrument(skip(self))]
  async fn read_blob(&self, key: &str) -> PortResult<BlobReadResponse> {
    debug!(key, "reading blob");
    let data = match self.backend {
      StorageBackend::Fs => self.op.read(key).await.map_err(|e| Self::map_storage_error(key, e))?,
      StorageBackend::S3 => {
        let mut last_error = None;
        let mut read_data = None;
        for attempt in 1..=self.s3_max_attempts {
          let read_result = tokio::time::timeout(self.io_timeout, self.op.read(key)).await;
          match read_result {
            Ok(Ok(bytes)) => {
              debug!(key, attempt, "s3 read succeeded");
              read_data = Some(bytes);
              last_error = None;
              break;
            }
            Ok(Err(err)) => {
              warn!(key, attempt, error = %err, "s3 read failed");
              last_error = Some(Self::map_storage_error(key, err));
            }
            Err(_) => {
              warn!(
                key,
                attempt,
                timeout_secs = self.io_timeout.as_secs(),
                "s3 read timed out"
              );
              last_error = Some(PortError::Transport(format!(
                "s3 read timeout after {}s",
                self.io_timeout.as_secs()
              )));
            }
          }
          if last_error.is_some() && attempt < self.s3_max_attempts {
            let backoff = Duration::from_millis(100 * attempt as u64);
            tokio::time::sleep(backoff).await;
          }
        }
        match (read_data, last_error) {
          (Some(bytes), _) => bytes,
          (None, Some(err)) => {
            error!(key, error = %err, "s3 read failed after retries");
            return Err(err);
          }
          (None, None) => return Err(PortError::Transport("s3 read failed without error".to_string())),
        }
      }
    };

    let metadata = self.op.stat(key).await.ok();

    Ok(BlobReadResponse {
      key: key.to_string(),
      content_type: metadata.as_ref().and_then(|m| m.content_type().map(|s| s.to_string())),
      data: data.to_bytes(),
      last_modified: metadata
        .as_ref()
        .and_then(|metadata| metadata.last_modified())
        .and_then(|timestamp| timestamp.to_string().parse().ok()),
      content_length: metadata.as_ref().map(|m| m.content_length()).unwrap_or(0),
    })
  }

  #[instrument(skip_all)]
  async fn read_blob_bounded(&self, key: &str, max_bytes: u64) -> PortResult<BlobReadResponse> {
    let end = max_bytes
      .checked_add(1)
      .ok_or_else(|| PortError::InvalidInput("invalid blob read limit".into()))?;
    tokio::time::timeout(self.io_timeout, async {
      let metadata = self
        .op
        .stat(key)
        .await
        .map_err(|error| Self::map_storage_error(key, error))?;
      if metadata.content_length() > max_bytes {
        return Err(PortError::InvalidInput(
          "blob exceeds the configured input limit".into(),
        ));
      }
      // Open-ended reads may end before the limit. Fixed oversized ranges are
      // invalid on FS. Single, bounded chunks avoid full-object allocation even
      // if the object grows between the metadata check and reader creation.
      let reader = self
        .op
        .reader_with(key)
        .concurrent(1)
        .chunk(end.min(8192) as usize)
        .await
        .map_err(|error| Self::map_storage_error(key, error))?;
      let mut stream = reader
        .into_bytes_stream(..)
        .await
        .map_err(|error| Self::map_storage_error(key, error))?;
      let capacity =
        usize::try_from(metadata.content_length()).map_err(|_| PortError::InvalidInput("invalid blob size".into()))?;
      let mut data = Vec::with_capacity(capacity);
      while let Some(chunk) = stream
        .try_next()
        .await
        .map_err(|error| PortError::Transport(error.to_string()))?
      {
        let size = (data.len() as u64)
          .checked_add(chunk.len() as u64)
          .ok_or_else(|| PortError::InvalidInput("invalid blob size".into()))?;
        if size > max_bytes || size > metadata.content_length() {
          return Err(PortError::InvalidInput("blob size changed during read".into()));
        }
        data.extend_from_slice(&chunk);
      }
      let current = self
        .op
        .stat(key)
        .await
        .map_err(|error| Self::map_storage_error(key, error))?;
      if data.len() as u64 != metadata.content_length()
        || current.content_length() != metadata.content_length()
        || current.etag() != metadata.etag()
        || current.last_modified() != metadata.last_modified()
      {
        return Err(PortError::InvalidInput("blob size changed during read".into()));
      }
      Ok(BlobReadResponse {
        key: key.into(),
        content_type: metadata.content_type().map(str::to_owned),
        content_length: data.len() as u64,
        data: data.into(),
        last_modified: metadata
          .last_modified()
          .and_then(|timestamp| timestamp.to_string().parse().ok()),
      })
    })
    .await
    .map_err(|_| PortError::Transport("bounded blob read deadline exceeded".into()))?
  }

  #[instrument(skip(self))]
  async fn delete_blob(&self, key: &str) -> PortResult<()> {
    debug!(key, "deleting blob");
    match self.backend {
      StorageBackend::Fs => {
        if let Err(e) = self.op.delete(key).await {
          if e.kind() == opendal::ErrorKind::NotFound {
            debug!(key, "delete treated as idempotent because blob did not exist");
            return Ok(());
          }
          return Err(PortError::Transport(e.to_string()));
        }
      }
      StorageBackend::S3 => {
        let mut last_error = None;
        for attempt in 1..=self.s3_max_attempts {
          let delete_result = tokio::time::timeout(self.io_timeout, self.op.delete(key)).await;
          match delete_result {
            Ok(Ok(())) => {
              debug!(key, attempt, "s3 delete succeeded");
              last_error = None;
              break;
            }
            Ok(Err(err)) if err.kind() == opendal::ErrorKind::NotFound => {
              debug!(key, attempt, "s3 delete treated as idempotent for missing blob");
              last_error = None;
              break;
            }
            Ok(Err(err)) => {
              warn!(key, attempt, error = %err, "s3 delete failed");
              last_error = Some(PortError::Transport(err.to_string()));
            }
            Err(_) => {
              warn!(
                key,
                attempt,
                timeout_secs = self.io_timeout.as_secs(),
                "s3 delete timed out"
              );
              last_error = Some(PortError::Transport(format!(
                "s3 delete timeout after {}s",
                self.io_timeout.as_secs()
              )));
            }
          }
          if last_error.is_some() && attempt < self.s3_max_attempts {
            let backoff = Duration::from_millis(100 * attempt as u64);
            tokio::time::sleep(backoff).await;
          }
        }
        if let Some(err) = last_error {
          error!(key, error = %err, "s3 delete failed after retries");
          return Err(err);
        }
      }
    }
    Ok(())
  }

  #[instrument(skip(self, data))]
  async fn put_avatar(&self, key: &str, data: Bytes, content_type: &str) -> PortResult<String> {
    let path = format!("avatars/{}", key);
    self
      .write_blob(BlobWriteRequest {
        key: path.clone(),
        body: data,
        content_type: Some(content_type.to_string()),
      })
      .await?;
    Ok(key.to_string())
  }

  #[instrument(skip_all)]
  async fn get_avatar(&self, key: &str) -> PortResult<BlobReadResponse> {
    self.read_blob(&format!("avatars/{}", key)).await
  }

  #[instrument(skip_all)]
  async fn delete_avatar(&self, key: &str) -> PortResult<()> {
    self.delete_blob(&format!("avatars/{}", key)).await
  }

  #[instrument(skip_all)]
  async fn create_multipart_upload(&self, req: MultipartCreateRequest) -> PortResult<MultipartCreateResponse> {
    let upload_id = Uuid::new_v4();
    let mut sessions = self.multipart_sessions.write().await;
    sessions.insert(
      upload_id,
      MultipartSession {
        key: req.key,
        parts: BTreeSet::new(),
      },
    );
    Ok(MultipartCreateResponse {
      upload_id,
      provider_upload_id: upload_id.to_string(),
    })
  }

  #[instrument(skip_all)]
  async fn create_multipart_part_url(&self, req: MultipartPartUrlRequest) -> PortResult<MultipartPartUrlResponse> {
    if req.part_number <= 0 {
      return Err(PortError::InvalidInput("part_number must be > 0".to_string()));
    }
    let mut sessions = self.multipart_sessions.write().await;
    let Some(session) = sessions.get_mut(&req.upload_id) else {
      return Err(PortError::NotFound(format!(
        "multipart upload {} not found",
        req.upload_id
      )));
    };
    session.parts.insert(req.part_number);
    let key = Self::multipart_part_key(req.upload_id, req.part_number);
    Ok(MultipartPartUrlResponse {
      upload_id: req.upload_id,
      part_number: req.part_number,
      upload_url: format!("multipart://{key}"),
    })
  }

  #[instrument(skip_all)]
  async fn complete_multipart_upload(&self, req: MultipartCompleteRequest) -> PortResult<()> {
    let session = {
      let mut sessions = self.multipart_sessions.write().await;
      sessions
        .remove(&req.upload_id)
        .ok_or_else(|| PortError::NotFound(format!("multipart upload {} not found", req.upload_id)))?
    };
    if req.e_tags.is_empty() {
      return Err(PortError::InvalidInput(
        "multipart complete requires at least one part".to_string(),
      ));
    }

    // Read all parts concurrently instead of sequentially (P84-F-01).
    // Parts are independent I/O operations; concurrent reads reduce latency
    // proportional to the number of parts (especially on S3 backends).
    let part_count = req.e_tags.len();
    let read_futures: Vec<_> = (0..part_count)
      .map(|idx| {
        let part_number = idx as i32 + 1;
        self.read_multipart_part(req.upload_id, part_number)
      })
      .collect();
    let parts: Vec<Bytes> = futures_util::future::try_join_all(read_futures).await?;

    // Concatenate in order (futures were spawned in part-number order).
    let total_size: usize = parts.iter().map(|p| p.len()).sum();
    let mut combined = Vec::with_capacity(total_size);
    for part in &parts {
      combined.extend_from_slice(part);
    }

    self
      .write_blob(BlobWriteRequest {
        key: session.key,
        content_type: Some("application/octet-stream".to_string()),
        body: Bytes::from(combined),
      })
      .await?;

    // Delete part files concurrently (P84-F-01).
    let delete_futures: Vec<_> = (0..part_count)
      .map(|idx| self.delete_multipart_part(req.upload_id, idx as i32 + 1))
      .collect();
    futures_util::future::join_all(delete_futures).await;

    Ok(())
  }

  #[instrument(skip_all)]
  async fn abort_multipart_upload(&self, upload_id: Uuid) -> PortResult<()> {
    let session = {
      let mut sessions = self.multipart_sessions.write().await;
      sessions.remove(&upload_id)
    };
    if let Some(session) = session {
      // Delete part files concurrently (P84-F-01).
      let delete_futures: Vec<_> = session
        .parts
        .iter()
        .map(|&part_number| self.delete_multipart_part(upload_id, part_number))
        .collect();
      futures_util::future::join_all(delete_futures).await;
    }
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::{SystemTime, UNIX_EPOCH};

  fn unique_temp_root() -> String {
    let suffix = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .expect("time should be monotonic")
      .as_nanos();
    format!("/tmp/myoxus-storage-test-{suffix}")
  }

  #[tokio::test]
  async fn bounded_storage_read_rejects_oversize_without_truncation() {
    let root = tempfile::tempdir().expect("owned temporary storage");
    let adapter = StorageAdapter::new_fs(root.path().to_str().unwrap()).unwrap();
    adapter
      .write_blob(BlobWriteRequest {
        key: "workspace/audio.wav".into(),
        content_type: Some("audio/wav".into()),
        body: Bytes::from_static(b"whole audio"),
      })
      .await
      .unwrap();
    assert!(adapter.read_blob_bounded("workspace/audio.wav", 5).await.is_err());
    let read = adapter.read_blob_bounded("workspace/audio.wav", 11).await.unwrap();
    assert_eq!(read.data.as_ref(), b"whole audio");
    assert_eq!(read.content_length, 11);
    let read = adapter.read_blob_bounded("workspace/audio.wav", 100).await.unwrap();
    assert_eq!(read.data.as_ref(), b"whole audio");
    assert!(adapter.read_blob_bounded("workspace/missing.wav", 100).await.is_err());
  }

  #[tokio::test]
  async fn fs_storage_atomic_write_and_verify_read() {
    let root = unique_temp_root();
    std::fs::create_dir_all(&root).expect("temp dir should be created");

    let adapter = StorageAdapter::new_fs(&root).expect("fs adapter must initialize");
    let data = Bytes::from_static(b"atomic blob payload");
    let req = BlobWriteRequest {
      key: "workspace/blob-a.txt".to_string(),
      content_type: Some("text/plain".to_string()),
      body: data.clone(),
    };

    adapter.write_blob(req).await.expect("write must succeed");
    let read = adapter
      .read_blob("workspace/blob-a.txt")
      .await
      .expect("read must succeed");
    assert_eq!(read.data, data);

    let _ = std::fs::remove_dir_all(root);
  }

  #[tokio::test]
  async fn fs_storage_delete_is_idempotent() {
    let root = unique_temp_root();
    std::fs::create_dir_all(&root).expect("temp dir should be created");

    let adapter = StorageAdapter::new_fs(&root).expect("fs adapter must initialize");
    adapter
      .delete_blob("workspace/non-existing.bin")
      .await
      .expect("first delete should succeed");
    adapter
      .delete_blob("workspace/non-existing.bin")
      .await
      .expect("second delete should succeed");

    let _ = std::fs::remove_dir_all(root);
  }

  #[tokio::test]
  async fn fs_storage_multipart_roundtrip_works() {
    let root = unique_temp_root();
    std::fs::create_dir_all(&root).expect("temp dir should be created");
    let adapter = StorageAdapter::new_fs(&root).expect("fs adapter must initialize");

    let created = adapter
      .create_multipart_upload(MultipartCreateRequest {
        key: "workspace/multipart-final.bin".to_string(),
        content_type: Some("application/octet-stream".to_string()),
      })
      .await
      .expect("create multipart upload");

    let p1 = adapter
      .create_multipart_part_url(MultipartPartUrlRequest {
        upload_id: created.upload_id,
        part_number: 1,
      })
      .await
      .expect("part1 url");
    let p2 = adapter
      .create_multipart_part_url(MultipartPartUrlRequest {
        upload_id: created.upload_id,
        part_number: 2,
      })
      .await
      .expect("part2 url");

    let k1 = p1.upload_url.trim_start_matches("multipart://");
    let k2 = p2.upload_url.trim_start_matches("multipart://");
    adapter
      .write_blob(BlobWriteRequest {
        key: k1.to_string(),
        content_type: Some("application/octet-stream".to_string()),
        body: Bytes::from_static(b"hello "),
      })
      .await
      .expect("write part1");
    adapter
      .write_blob(BlobWriteRequest {
        key: k2.to_string(),
        content_type: Some("application/octet-stream".to_string()),
        body: Bytes::from_static(b"world"),
      })
      .await
      .expect("write part2");

    adapter
      .complete_multipart_upload(MultipartCompleteRequest {
        upload_id: created.upload_id,
        e_tags: vec!["\"p1\"".to_string(), "\"p2\"".to_string()],
      })
      .await
      .expect("complete multipart");

    let read = adapter
      .read_blob("workspace/multipart-final.bin")
      .await
      .expect("read final blob");
    assert_eq!(read.data, Bytes::from_static(b"hello world"));

    let _ = std::fs::remove_dir_all(root);
  }
}
