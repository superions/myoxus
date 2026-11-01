// SPDX-License-Identifier: AGPL-3.0-or-later
//! Storage roundtrip with cleanup reserved inside the complete Doctor deadline.

use bytes::Bytes;
use myoxus_application::ports::BlobWriteRequest;
use myoxus_infrastructure::tls::ValidatedCaBundle;

use super::{DOCTOR_CHECK_TIMEOUT, DoctorRow, DoctorStatus, Duration, Instant};

pub(super) async fn inspect(
  additional_ca: Option<&ValidatedCaBundle>,
  report_deadline: tokio::time::Instant,
) -> Vec<DoctorRow> {
  let started = Instant::now();
  let now = tokio::time::Instant::now();
  let cleanup_deadline = (now + DOCTOR_CHECK_TIMEOUT).min(report_deadline - Duration::from_millis(100));
  let operation_deadline = cleanup_deadline - Duration::from_secs(2);
  if operation_deadline <= now {
    return vec![DoctorRow::new(
      "storage.roundtrip",
      DoctorStatus::Fail,
      started,
      "insufficient report time for a storage roundtrip with reserved cleanup; no probe written",
    )];
  }
  let additional_ca = additional_ca.cloned();
  let storage = tokio::time::timeout_at(
    operation_deadline,
    tokio::task::spawn_blocking(move || crate::services::Services::configured_blob_storage(additional_ca.as_ref())),
  )
  .await;
  let storage = match storage {
    Ok(Ok(Ok(storage))) => storage,
    result => {
      let detail = match result {
        Ok(Ok(Err(error))) => error.to_string(),
        Ok(Err(_)) => "storage configuration task panicked or was cancelled".into(),
        Err(_) => "storage configuration exceeded operation deadline; no probe written".into(),
        _ => unreachable!(),
      };
      return vec![DoctorRow::new("storage.roundtrip", DoctorStatus::Fail, started, detail)];
    }
  };
  let key = format!("doctor-probe/{}.txt", uuid::Uuid::new_v4());
  let body = Bytes::from_static(b"myoxus-storage-probe");
  // Match verify_blob_storage_readiness's sequence and payload comparison, but
  // do not return on write/read failure: a failed write may have stored bytes.
  let operation = tokio::time::timeout_at(operation_deadline, async {
    storage
      .write_blob(BlobWriteRequest {
        key: key.clone(),
        content_type: Some("text/plain".into()),
        body: body.clone(),
      })
      .await
      .map_err(|error| anyhow::anyhow!("write failed: {error}"))?;
    let read = storage
      .read_blob_bounded(&key, body.len() as u64)
      .await
      .map_err(|error| anyhow::anyhow!("read failed: {error}"))?;
    anyhow::ensure!(
      read.data == body,
      "readback mismatch: expected {} bytes, got {} bytes",
      body.len(),
      read.data.len()
    );
    Ok::<_, anyhow::Error>(())
  })
  .await;
  let (status, detail): (DoctorStatus, String) = match operation {
    Ok(Ok(())) => (DoctorStatus::Pass, "write/read payload roundtrip succeeded".into()),
    Ok(Err(error)) => (DoctorStatus::Fail, error.to_string()),
    Err(_) => (
      DoctorStatus::Fail,
      "write/read operation exceeded its deadline; cleanup still attempted".into(),
    ),
  };
  let mut rows = vec![DoctorRow::new(
    "storage.roundtrip",
    status,
    started,
    format!("key={key}; {detail}"),
  )];
  let cleanup_started = Instant::now();
  let (status, detail) = match tokio::time::timeout_at(cleanup_deadline, storage.delete_blob(&key)).await {
    Ok(Ok(())) => (
      DoctorStatus::Pass,
      format!("key={key}; diagnostic object deleted (or already absent)"),
    ),
    Ok(Err(error)) => (
      DoctorStatus::Fail,
      format!("key={key}; cleanup failed: {error}; operator inspection required"),
    ),
    Err(_) => (
      DoctorStatus::Fail,
      format!("key={key}; cleanup deadline exceeded; object absence unverified; operator inspection required"),
    ),
  };
  rows.push(DoctorRow::new("storage.cleanup", status, cleanup_started, detail));
  rows
}
