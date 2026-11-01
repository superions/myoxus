//! Integration tests for MinIO/S3 blob storage via the opendal backend.
use bytes::Bytes;
use myoxus_application::ports::{BlobReadResponse, BlobStoragePort, BlobWriteRequest};
use myoxus_infrastructure::storage::{S3StorageConfig, StorageAdapter};

fn env_var(name: &str) -> Option<String> {
  std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

#[tokio::test]
async fn minio_s3_adapter_roundtrip_and_idempotent_delete() {
  let endpoint = match env_var("MINIO_ENDPOINT") {
    Some(v) => v,
    None => {
      eprintln!("MINIO_ENDPOINT not set, skipping minio integration test");
      return;
    }
  };
  let bucket = env_var("MINIO_BUCKET").unwrap_or_else(|| "myoxus-ci".to_string());
  let access_key = env_var("MINIO_ACCESS_KEY").unwrap_or_else(|| "minioadmin".to_string());
  let secret_key = env_var("MINIO_SECRET_KEY").unwrap_or_else(|| "minioadmin".to_string());
  let region = env_var("MINIO_REGION").unwrap_or_else(|| "us-east-1".to_string());

  let adapter = StorageAdapter::new_s3(
    S3StorageConfig {
      bucket: &bucket,
      prefix: Some("integration-tests"),
      endpoint: Some(&endpoint),
      region: Some(&region),
      access_key: Some(&access_key),
      secret_key: Some(&secret_key),
      io_timeout_seconds: None,
      max_retries: None,
    },
    None,
  )
  .expect("s3 adapter should initialize against minio");

  let key = format!("workspace-{}/blob.bin", uuid::Uuid::new_v4());
  let body = Bytes::from_static(b"minio-roundtrip-payload");
  adapter
    .write_blob(BlobWriteRequest {
      key: key.clone(),
      body: body.clone(),
      content_type: Some("application/octet-stream".to_string()),
    })
    .await
    .expect("write to minio should succeed");

  let read: BlobReadResponse = adapter.read_blob(&key).await.expect("read from minio should succeed");
  assert_eq!(read.data, body);

  adapter
    .delete_blob(&key)
    .await
    .expect("first minio delete should succeed");
  adapter
    .delete_blob(&key)
    .await
    .expect("second minio delete should be idempotent");
}
