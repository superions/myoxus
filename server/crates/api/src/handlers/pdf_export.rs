// SPDX-License-Identifier: AGPL-3.0-or-later
//! REST handler for downloading a completed PDF export.
//!
//! `GET /api/pdf-export/{job_id}/download` — streams the exported PDF for a completed job.

use axum::{
  extract::{Path, State},
  http::{HeaderMap, StatusCode, header},
  response::{IntoResponse, Response, Sse, sse::Event as SseEvent},
};
use chrono::{DateTime, Utc};
use futures_util::stream::Stream;
use myoxus_application::pdf_export::jobs::PdfExportJob;
use myoxus_application::permission::AccessController;
use serde::Serialize;
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

use crate::state::ApiState;

const PDF_EXPORT_JOBS_EVENTS_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
const PDF_EXPORT_JOB_EVENTS_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

#[derive(Debug, Clone)]
struct AuthorizedPdfExportJobSnapshot {
  user_id: Uuid,
  id: Uuid,
  workspace_id: Uuid,
  doc_id: Uuid,
  status: String,
  output_blob_id: Option<Uuid>,
  error_class: Option<String>,
  error_detail: Option<String>,
  created_at: DateTime<Utc>,
  started_at: Option<DateTime<Utc>>,
  finished_at: Option<DateTime<Utc>>,
  expires_at: Option<DateTime<Utc>>,
  page_count: Option<i32>,
  unmapped_font_families: Vec<String>,
}

#[derive(Debug, Serialize)]
struct PdfExportJobUpdateEvent {
  job_id: String,
  workspace_id: String,
  doc_id: String,
  status: String,
  phase: &'static str,
  download_url: Option<String>,
  error_class: Option<String>,
  error_detail: Option<String>,
  created_at: DateTime<Utc>,
  started_at: Option<DateTime<Utc>>,
  finished_at: Option<DateTime<Utc>>,
  expires_at: Option<DateTime<Utc>>,
  page_count: Option<i32>,
  unmapped_font_families: Vec<String>,
}

impl PdfExportJobUpdateEvent {
  fn from_snapshot(snapshot: &AuthorizedPdfExportJobSnapshot) -> Self {
    Self {
      job_id: snapshot.id.to_string(),
      workspace_id: snapshot.workspace_id.to_string(),
      doc_id: snapshot.doc_id.to_string(),
      status: snapshot.status.clone(),
      phase: pdf_export_phase_from_status(&snapshot.status),
      download_url: if snapshot.status == "done" && snapshot.output_blob_id.is_some() {
        Some(format!("/api/pdf-export/{}/download", snapshot.id))
      } else {
        None
      },
      error_class: snapshot.error_class.clone(),
      error_detail: snapshot.error_detail.clone(),
      created_at: snapshot.created_at,
      started_at: snapshot.started_at,
      finished_at: snapshot.finished_at,
      expires_at: snapshot.expires_at,
      page_count: snapshot.page_count,
      unmapped_font_families: snapshot.unmapped_font_families.clone(),
    }
  }

  fn fingerprint(&self) -> String {
    serde_json::json!({
      "status": self.status,
      "phase": self.phase,
      "download_url": self.download_url,
      "error_class": self.error_class,
      "error_detail": self.error_detail,
      "started_at": self.started_at,
      "finished_at": self.finished_at,
      "expires_at": self.expires_at,
      "page_count": self.page_count,
      "unmapped_font_families": self.unmapped_font_families,
    })
    .to_string()
  }

  fn event_name(&self) -> &'static str {
    match self.phase {
      "done" => "done",
      "failed" => "failed",
      _ => "update",
    }
  }
}

fn pdf_export_phase_from_status(status: &str) -> &'static str {
  match status {
    "queued" => "queued",
    "running" => "rendering",
    "validating" => "validating",
    "done" => "done",
    "failed" => "failed",
    _ => "queued",
  }
}

fn pdf_export_is_terminal_status(status: &str) -> bool {
  matches!(status, "done" | "failed")
}

async fn load_authorized_pdf_export_job_snapshot(
  state: &ApiState,
  headers: &HeaderMap,
  job_id: Uuid,
) -> Result<AuthorizedPdfExportJobSnapshot, StatusCode> {
  let cookies = crate::graphql::utils::parse_cookies(headers);
  let session_id = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
    .ok_or(StatusCode::UNAUTHORIZED)?;
  let snapshot = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(|_| StatusCode::UNAUTHORIZED)?
    .ok_or(StatusCode::UNAUTHORIZED)?;
  let job = state
    .pdf_export_jobs()
    .get(job_id)
    .await
    .map_err(|error| {
      warn!(job_id = %job_id, error = %error, "PDF export job snapshot load failed");
      StatusCode::INTERNAL_SERVER_ERROR
    })?
    .ok_or(StatusCode::NOT_FOUND)?;

  if job.requested_by != snapshot.user.id {
    state
      .permission_service()
      .assert(
        &myoxus_application::permission::WorkspaceResource {
          user_id: snapshot.user.id,
          workspace_id: job.workspace_id,
        },
        myoxus_domain::permission::WorkspaceAction::Read,
      )
      .await
      .map_err(|_| StatusCode::FORBIDDEN)?;
  }

  Ok(AuthorizedPdfExportJobSnapshot {
    user_id: snapshot.user.id,
    id: job.id,
    workspace_id: job.workspace_id,
    doc_id: job.doc_id,
    status: job.status,
    output_blob_id: job.output_blob_id,
    error_class: job.error_class,
    error_detail: job.error_detail,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    expires_at: job.expires_at,
    page_count: job.page_count,
    unmapped_font_families: job.unmapped_font_families,
  })
}

// ---------------------------------------------------------------------------
// GET /api/admin/pdf-export/jobs/events
// ---------------------------------------------------------------------------

/// Admin-only SSE stream that invalidates the PDF Export jobs table.
///
/// The stream intentionally sends a compact snapshot fingerprint rather than
/// full job rows. The admin frontend already owns the typed GraphQL projection;
/// SSE only needs to tell SWR when queued/running/done/failed state changed.
#[instrument(skip_all)]
pub async fn pdf_export_admin_jobs_events_handler(
  State(state): State<ApiState>,
  headers: HeaderMap,
) -> Result<
  Sse<impl Stream<Item = Result<SseEvent, std::convert::Infallible>>>,
  (StatusCode, axum::Json<serde_json::Value>),
> {
  crate::require_admin_user(&state, &headers)
    .await
    .map_err(|status| (status, axum::Json(serde_json::json!({ "error": "unauthorized" }))))?;

  info!("pdf export admin jobs SSE stream opened");

  let stream = async_stream::stream! {
    let mut last_snapshot = String::new();

    loop {
      let snapshot = state
        .pdf_export_jobs()
        .recent_signals(Utc::now() - chrono::Duration::hours(24), 200)
        .await
        .and_then(|signals| {
          serde_json::to_string(&signals)
            .map_err(|error| myoxus_domain::repositories::RepositoryError::Storage(error.to_string()))
        });

      match snapshot {
        Ok(snapshot) if snapshot != last_snapshot => {
          last_snapshot = snapshot.clone();
          yield Ok(SseEvent::default()
            .event("jobs")
            .data(serde_json::json!({ "snapshot": snapshot }).to_string()));
        }
        Ok(_) => {
          yield Ok(SseEvent::default().event("heartbeat").data("{}"));
        }
        Err(error) => {
          warn!(error = %error, "pdf export admin jobs SSE snapshot failed");
          yield Ok(SseEvent::default()
            .event("error")
            .data(serde_json::json!({ "error": "snapshot_failed" }).to_string()));
        }
      }

      tokio::time::sleep(PDF_EXPORT_JOBS_EVENTS_INTERVAL).await;
    }
  };

  Ok(Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default()))
}

// ---------------------------------------------------------------------------
// GET /api/pdf-export/{job_id}/events
// ---------------------------------------------------------------------------

/// User-facing SSE stream for one PDF export job.
///
/// The API intentionally lives next to the existing download route instead of
/// opening a second GraphQL/WebSocket transport. Each connection performs the
/// established owner-or-workspace-read status authorization, emits the current
/// snapshot immediately, then re-emits only changed snapshots until the job
/// reaches a terminal phase. The web client can therefore use this as its
/// primary progress channel and keep `pdfExportJob` polling as fallback.
#[instrument(skip_all, fields(raw_job_id = %job_id))]
pub async fn pdf_export_job_events_handler(
  State(state): State<ApiState>,
  Path(job_id): Path<String>,
  headers: HeaderMap,
) -> Result<
  Sse<impl Stream<Item = Result<SseEvent, std::convert::Infallible>>>,
  (StatusCode, axum::Json<serde_json::Value>),
> {
  let job_uuid = Uuid::parse_str(&job_id).map_err(|_| {
    (
      StatusCode::BAD_REQUEST,
      axum::Json(serde_json::json!({ "error": "invalid_job_id" })),
    )
  })?;

  let initial_snapshot = load_authorized_pdf_export_job_snapshot(&state, &headers, job_uuid)
    .await
    .map_err(|status| {
      (
        status,
        axum::Json(serde_json::json!({ "error": status.canonical_reason().unwrap_or("pdf export job unavailable") })),
      )
    })?;
  let user_id = initial_snapshot.user_id;

  info!(
    job_id = %job_uuid,
    user_id = %user_id,
    status = %initial_snapshot.status,
    phase = pdf_export_phase_from_status(&initial_snapshot.status),
    "pdf export job SSE stream opened"
  );

  let stream = async_stream::stream! {
    let mut last_fingerprint = String::new();

    loop {
      let snapshot = match load_authorized_pdf_export_job_snapshot(&state, &headers, job_uuid).await {
        Ok(snapshot) => snapshot,
        Err(status) => {
          warn!(
            job_id = %job_uuid,
            user_id = %user_id,
            http_status = status.as_u16(),
            "pdf export job SSE snapshot failed"
          );
          yield Ok(SseEvent::default()
            .event("error")
            .data(serde_json::json!({
              "job_id": job_uuid.to_string(),
              "error": status.canonical_reason().unwrap_or("pdf export job unavailable"),
            }).to_string()));
          break;
        }
      };

      let event = PdfExportJobUpdateEvent::from_snapshot(&snapshot);
      let fingerprint = event.fingerprint();
      if fingerprint != last_fingerprint {
        last_fingerprint = fingerprint;
        let event_name = event.event_name();
        match serde_json::to_string(&event) {
          Ok(data) => {
            debug!(
              job_id = %job_uuid,
              user_id = %user_id,
              status = %event.status,
              phase = event.phase,
              event = event_name,
              "pdf export job SSE update emitted"
            );
            yield Ok(SseEvent::default().event(event_name).data(data));
          }
          Err(error) => {
            warn!(job_id = %job_uuid, error = %error, "pdf export job SSE serialization failed");
            yield Ok(SseEvent::default()
              .event("error")
              .data(serde_json::json!({
                "job_id": job_uuid.to_string(),
                "error": "serialization_failed",
              }).to_string()));
            break;
          }
        }
      } else {
        yield Ok(SseEvent::default()
          .event("heartbeat")
          .data(serde_json::json!({
            "job_id": job_uuid.to_string(),
            "phase": event.phase,
          }).to_string()));
      }

      if pdf_export_is_terminal_status(&snapshot.status) {
        info!(
          job_id = %job_uuid,
          user_id = %user_id,
          status = %snapshot.status,
          "pdf export job SSE stream closed after terminal status"
        );
        break;
      }

      tokio::time::sleep(PDF_EXPORT_JOB_EVENTS_INTERVAL).await;
    }
  };

  Ok(Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default()))
}

/// `GET /api/pdf-export/{job_id}/download`
///
/// Authentication accepts the existing cookie session or an MCP API key with
/// `read:docs`. Both require current workspace and document Read permission.
///
/// - `200 OK` with `Content-Type: application/pdf` and the PDF bytes when done.
/// - `202 Accepted` while the job is still processing (queued / running).
/// - `410 Gone` when the artifact expired or the job has terminally failed; the response carries an
///   `X-Pdf-Export-Error-Class` header (PDFREV-API-04) and a JSON body
///   `{"error_class": "...", "message": "...";}` so clients can branch on
///   the failure category without a separate GraphQL round-trip.
/// - `404 Not Found` when the job row does not exist (or was already
///   purged by the nightly cleanup).
#[instrument(skip_all)]
pub async fn pdf_export_download_handler(
  State(state): State<ApiState>,
  Path(job_id): Path<String>,
  headers: HeaderMap,
) -> Response {
  // An explicit bearer credential never falls back to a more privileged cookie.
  // Both transports resolve the same application user; ACL remains authoritative.
  let user_id = if headers.contains_key(header::AUTHORIZATION) {
    let Some(token) = myoxus_mcp::auth::extract_bearer(&headers) else {
      return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    };
    let key = match state.api_key_service().authenticate(&token).await {
      Ok(key) => key,
      Err(_) => return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response(),
    };
    if !key.scopes.iter().any(|scope| scope == "read:docs") {
      return (StatusCode::FORBIDDEN, "Scope 'read:docs' required").into_response();
    }
    key.user_id
  } else {
    let cookies = crate::graphql::utils::parse_cookies(&headers);
    let Some(session_id) =
      crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
    else {
      return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    };
    match state.auth().get_session_snapshot(session_id).await {
      Ok(Some(snapshot)) => snapshot.user.id,
      _ => return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response(),
    }
  };

  let job_uuid = match Uuid::parse_str(&job_id) {
    Ok(u) => u,
    Err(_) => {
      warn!(raw_job_id = %job_id, "pdf export download: invalid job_id");
      return (StatusCode::BAD_REQUEST, "invalid job_id").into_response();
    }
  };

  let download = match state.pdf_export_jobs().get_download(job_uuid).await {
    Ok(Some(download)) => download,
    Ok(None) => {
      debug!(job_id = %job_uuid, "pdf export download: job not found");
      return (StatusCode::NOT_FOUND, "job not found").into_response();
    }
    Err(e) => {
      warn!(job_id = %job_uuid, error = %e, "PDF export download projection failed");
      return (StatusCode::INTERNAL_SERVER_ERROR, "PDF export state unavailable").into_response();
    }
  };
  let PdfExportJob {
    workspace_id,
    doc_id,
    status: status_str,
    output_blob_id,
    error_class,
    expires_at,
    ..
  } = download.job;

  // A historical requester identity cannot bypass a later ACL revocation.
  let permission = state.permission_service();
  if permission
    .assert(
      &myoxus_application::permission::WorkspaceResource { user_id, workspace_id },
      myoxus_domain::permission::WorkspaceAction::Read,
    )
    .await
    .is_err()
    || permission
      .assert(
        &myoxus_application::permission::DocResource {
          user_id,
          workspace_id,
          doc_id,
        },
        myoxus_domain::permission::DocAction::Read,
      )
      .await
      .is_err()
  {
    return (StatusCode::FORBIDDEN, "Forbidden").into_response();
  }
  if expires_at.is_some_and(|expiry| expiry <= Utc::now()) {
    return (
      StatusCode::GONE,
      [
        (header::CACHE_CONTROL, "no-store"),
        (
          header::HeaderName::from_static("x-pdf-export-error-class"),
          "ArtifactExpired",
        ),
      ],
      axum::Json(serde_json::json!({"error_class":"ArtifactExpired","message":"pdf export artifact expired"})),
    )
      .into_response();
  }

  match status_str.as_str() {
    "queued" | "running" => {
      debug!(job_id = %job_uuid, status = %status_str, "pdf export download: still processing");
      return (StatusCode::ACCEPTED, "processing").into_response();
    }
    "failed" => {
      // PDFREV-API-04: a failed job is a permanently-unavailable artefact.
      // 410 Gone is the semantic match (vs 404, which implies "the row does
      // not exist"). We surface the stable `error_class` both as a custom
      // header and inside a JSON body so clients can branch on the failure
      // category without polling GraphQL again.
      let error_class = error_class.unwrap_or_else(|| "Unknown".to_string());
      debug!(
        job_id = %job_uuid,
        error_class = %error_class,
        "pdf export download: job failed (410 Gone)"
      );
      let body = serde_json::json!({
        "error_class": error_class,
        "message": "pdf export job failed",
      })
      .to_string();
      return (
        StatusCode::GONE,
        [
          (header::CONTENT_TYPE, "application/json".to_string()),
          (header::CACHE_CONTROL, "no-store".to_string()),
          (header::HeaderName::from_static("x-pdf-export-error-class"), error_class),
        ],
        body,
      )
        .into_response();
    }
    "done" => {}
    _ => {
      warn!(job_id = %job_uuid, status = %status_str, "pdf export download: unknown status");
      return (StatusCode::INTERNAL_SERVER_ERROR, "unknown status").into_response();
    }
  }

  let Some(blob_id) = output_blob_id else {
    warn!(job_id = %job_uuid, "pdf export download: done but no output_blob_id");
    return (StatusCode::INTERNAL_SERVER_ERROR, "no output blob").into_response();
  };

  // Job authorization resolves the workspace first. The normal blob owner
  // reads completed metadata and adds its physical workspace prefix once.
  let blob_key = myoxus_application::pdf_export::jobs::pdf_export_blob_key(blob_id);
  let blob_bytes = match state.blob().get_blob(workspace_id, &blob_key).await {
    Ok(response) => response.data.to_vec(),
    Err(e) => {
      warn!(
        job_id = %job_uuid,
        blob_id = %blob_id,
        error = %e,
        "pdf export download: blob not found in storage"
      );
      return (StatusCode::INTERNAL_SERVER_ERROR, "output blob missing").into_response();
    }
  };

  info!(
    job_id = %job_uuid,
    user_id = %user_id,
    blob_id = %blob_id,
    bytes = blob_bytes.len(),
    "pdf export download served"
  );
  let content_disposition = pdf_content_disposition(download.document_title.as_deref());

  (
    StatusCode::OK,
    [
      (header::CONTENT_TYPE, "application/pdf".to_string()),
      (header::CONTENT_DISPOSITION, content_disposition),
      (header::CACHE_CONTROL, "no-store".to_string()),
    ],
    blob_bytes,
  )
    .into_response()
}

fn pdf_content_disposition(document_title: Option<&str>) -> String {
  let raw_stem = document_title
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .unwrap_or("export");
  let raw_stem = raw_stem
    .strip_suffix(".pdf")
    .or_else(|| raw_stem.strip_suffix(".PDF"))
    .unwrap_or(raw_stem);
  let safe_unicode = raw_stem
    .chars()
    .map(|character| match character {
      '/' | '\\' | '?' | '%' | '*' | ':' | '|' | '"' | '<' | '>' => '-',
      character if character.is_control() => '-',
      character => character,
    })
    .collect::<String>();
  let safe_unicode = safe_unicode.trim_matches([' ', '.']);
  let safe_unicode = if safe_unicode.is_empty() {
    "export"
  } else {
    safe_unicode
  };
  let ascii_stem = safe_unicode
    .chars()
    .map(|character| if character.is_ascii() { character } else { '-' })
    .collect::<String>();
  let ascii_stem = ascii_stem.trim_matches([' ', '.', '-']);
  let ascii_stem = if ascii_stem.is_empty() { "export" } else { ascii_stem };
  let unicode_filename = format!("{safe_unicode}.pdf");
  format!(
    "attachment; filename=\"{ascii_stem}.pdf\"; filename*=UTF-8''{}",
    urlencoding::encode(&unicode_filename)
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  fn snapshot(status: &str, output_blob_id: Option<Uuid>) -> AuthorizedPdfExportJobSnapshot {
    let now = Utc::now();
    AuthorizedPdfExportJobSnapshot {
      user_id: Uuid::new_v4(),
      id: Uuid::new_v4(),
      workspace_id: Uuid::new_v4(),
      doc_id: Uuid::new_v4(),
      status: status.to_string(),
      output_blob_id,
      error_class: if status == "failed" {
        Some("RenderError".to_string())
      } else {
        None
      },
      error_detail: if status == "failed" {
        Some("render failed".to_string())
      } else {
        None
      },
      created_at: now,
      started_at: if status == "queued" { None } else { Some(now) },
      finished_at: if pdf_export_is_terminal_status(status) {
        Some(now)
      } else {
        None
      },
      expires_at: if status == "done" { Some(now) } else { None },
      page_count: if status == "done" { Some(3) } else { None },
      unmapped_font_families: if status == "done" {
        vec!["Iosevka Slab".to_string()]
      } else {
        Vec::new()
      },
    }
  }

  #[test]
  fn pdf_export_job_update_phase_contract_is_stable() {
    let cases = [
      ("queued", "queued", "update"),
      ("running", "rendering", "update"),
      ("validating", "validating", "update"),
      ("done", "done", "done"),
      ("failed", "failed", "failed"),
    ];

    for (status, phase, event_name) in cases {
      let output_blob_id = (status == "done").then(Uuid::new_v4);
      let event = PdfExportJobUpdateEvent::from_snapshot(&snapshot(status, output_blob_id));
      assert_eq!(event.status, status);
      assert_eq!(event.phase, phase);
      assert_eq!(event.event_name(), event_name);
    }
  }

  #[test]
  fn pdf_export_job_update_done_payload_contains_download_url_only_when_blob_exists() {
    let done_without_blob = PdfExportJobUpdateEvent::from_snapshot(&snapshot("done", None));
    assert!(done_without_blob.download_url.is_none());

    let blob_id = Uuid::new_v4();
    let done = PdfExportJobUpdateEvent::from_snapshot(&snapshot("done", Some(blob_id)));
    assert_eq!(
      done.download_url.as_deref(),
      Some(format!("/api/pdf-export/{}/download", done.job_id).as_str())
    );

    let json = serde_json::to_value(&done).expect("event serializes");
    assert_eq!(json["phase"], "done");
    assert_eq!(json["page_count"], 3);
    assert_eq!(json["unmapped_font_families"][0], "Iosevka Slab");
  }

  #[test]
  fn pdf_download_filename_uses_safe_document_title_and_unicode_extension() {
    assert_eq!(
      pdf_content_disposition(Some("Quartalsbericht")),
      "attachment; filename=\"Quartalsbericht.pdf\"; filename*=UTF-8''Quartalsbericht.pdf"
    );
    let unicode = pdf_content_disposition(Some("Überblick/Q3.pdf"));
    assert!(unicode.contains("filename=\"berblick-Q3.pdf\""));
    assert!(!unicode.contains("filename*=UTF-8''%C3%9Cberblick%2FQ3.pdf"));
    assert!(unicode.contains("filename*=UTF-8''%C3%9Cberblick-Q3.pdf"));
    assert_eq!(
      pdf_content_disposition(Some("  .  ")),
      "attachment; filename=\"export.pdf\"; filename*=UTF-8''export.pdf"
    );
  }
}
