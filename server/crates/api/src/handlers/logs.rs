//! Log download and live-tail endpoints for admin users.
//!
//! - `GET /api/admin/logs/download` — downloads all `.log` files as a ZIP archive
//! - `GET /api/admin/logs/tail` — SSE stream of the current log file (last 50 lines + live tail)

use std::io::{BufRead, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use axum::{
  extract::State,
  http::{HeaderMap, StatusCode, header},
  response::{IntoResponse, Sse, sse::Event as SseEvent},
};
use futures_util::stream::Stream;
use tracing::{debug, info, instrument, warn};

use crate::state::ApiState;

/// Resolve the log directory from the config's `logging.file_path`.
///
/// Returns `None` if file logging is not configured (stdout-only mode).
fn resolve_log_dir(state: &ApiState) -> Option<PathBuf> {
  let file_path = state.config.logging.file_path.as_ref()?;
  let log_path = Path::new(file_path);
  let directory = log_path
    .parent()
    .filter(|p| !p.as_os_str().is_empty())
    .unwrap_or(Path::new("."));
  Some(directory.to_path_buf())
}

/// Resolve the log filename stem from the config's `logging.file_path`.
///
/// E.g. `/opt/myoxus/logs/myoxus.log` → `"myoxus"`.
/// Falls back to `"myoxus"` if no file logging is configured.
fn resolve_log_stem(state: &ApiState) -> String {
  state
    .config
    .logging
    .file_path
    .as_deref()
    .and_then(|fp| Path::new(fp).file_stem())
    .and_then(|s| s.to_str())
    .unwrap_or("myoxus")
    .to_string()
}

/// Collect all `.log` files whose filename starts with `stem` in the given
/// directory, sorted by name.
///
/// B01: Only files that both start with the configured log stem AND end with
/// `.log` are included. This prevents unrelated `.log` files (e.g. from other
/// tools placed in the same directory) from leaking into the download archive
/// or the tail selection.
pub fn collect_log_files(dir: &Path, stem: &str) -> std::io::Result<Vec<PathBuf>> {
  let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
    .filter_map(Result::ok)
    .map(|e| e.path())
    .filter(|p| {
      if !p.is_file() {
        return false;
      }
      // Extension must be "log"
      let has_log_ext = p
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext == "log")
        .unwrap_or(false);
      if !has_log_ext {
        return false;
      }
      // Filename must start with the configured stem
      p.file_name()
        .and_then(|n| n.to_str())
        .map(|name| name.starts_with(stem))
        .unwrap_or(false)
    })
    .collect();
  files.sort();
  Ok(files)
}

/// Find the most recently modified `.log` file in the directory that matches
/// `stem`.
///
/// B02: Sort by `modified()` metadata (newest last) so that the result is
/// rotation-agnostic — the file touched most recently wins regardless of
/// naming convention. Falls back to alphabetical order if metadata is
/// unavailable for any entry.
pub fn find_current_log_file(dir: &Path, stem: &str) -> Option<PathBuf> {
  let mut files = collect_log_files(dir, stem).ok()?;
  if files.is_empty() {
    return None;
  }
  // Attempt to sort by mtime. If any metadata call fails, fall back to
  // alphabetical (already applied by collect_log_files).
  let mtime_available = files.iter().all(|p| p.metadata().and_then(|m| m.modified()).is_ok());
  if mtime_available {
    files.sort_by_key(|p| p.metadata().and_then(|m| m.modified()).ok());
  }
  files.into_iter().next_back()
}

// ---------------------------------------------------------------------------
// GET /api/admin/logs/download
// ---------------------------------------------------------------------------

/// Download all log files as a ZIP archive.
///
/// Admin-only. Returns `application/zip` with all `.log` files from the
/// configured log directory. Returns 404 if file logging is not configured
/// or no log files exist.
#[instrument(skip_all)]
pub async fn download_handler(
  State(state): State<ApiState>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, axum::Json<serde_json::Value>)> {
  // Admin auth check
  crate::require_admin_user(&state, &headers)
    .await
    .map_err(|status| (status, axum::Json(serde_json::json!({ "error": "unauthorized" }))))?;

  let log_dir = resolve_log_dir(&state).ok_or_else(|| {
    (
      StatusCode::NOT_FOUND,
      axum::Json(serde_json::json!({
          "error": "file logging not configured (stdout-only mode)"
      })),
    )
  })?;

  let log_stem = resolve_log_stem(&state);
  let log_files = collect_log_files(&log_dir, &log_stem).map_err(|e| {
    warn!(error = %e, dir = %log_dir.display(), "failed to read log directory");
    (
      StatusCode::INTERNAL_SERVER_ERROR,
      axum::Json(serde_json::json!({
          "error": format!("failed to read log directory: {e}")
      })),
    )
  })?;

  if log_files.is_empty() {
    return Err((
      StatusCode::NOT_FOUND,
      axum::Json(serde_json::json!({
          "error": "no log files found in log directory"
      })),
    ));
  }

  info!(
      file_count = log_files.len(),
      dir = %log_dir.display(),
      "creating log archive for download"
  );

  // Build ZIP in memory
  let mut buf = Cursor::new(Vec::new());
  {
    let mut zip = zip::ZipWriter::new(&mut buf);
    let options = zip::write::FileOptions::<()>::default().compression_method(zip::CompressionMethod::Deflated);

    for path in &log_files {
      let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("unknown.log");

      zip.start_file(file_name, options).map_err(|e| {
        warn!(error = %e, file = %path.display(), "failed to add file to zip");
        (
          StatusCode::INTERNAL_SERVER_ERROR,
          axum::Json(serde_json::json!({
              "error": format!("failed to create zip entry: {e}")
          })),
        )
      })?;

      let mut file = std::fs::File::open(path).map_err(|e| {
        warn!(error = %e, file = %path.display(), "failed to open log file");
        (
          StatusCode::INTERNAL_SERVER_ERROR,
          axum::Json(serde_json::json!({
              "error": format!("failed to read log file: {e}")
          })),
        )
      })?;

      let mut contents = Vec::new();
      file.read_to_end(&mut contents).map_err(|e| {
        (
          StatusCode::INTERNAL_SERVER_ERROR,
          axum::Json(serde_json::json!({
              "error": format!("failed to read log file: {e}")
          })),
        )
      })?;

      zip.write_all(&contents).map_err(|e| {
        (
          StatusCode::INTERNAL_SERVER_ERROR,
          axum::Json(serde_json::json!({
              "error": format!("failed to write to zip: {e}")
          })),
        )
      })?;
    }

    zip.finish().map_err(|e| {
      (
        StatusCode::INTERNAL_SERVER_ERROR,
        axum::Json(serde_json::json!({
            "error": format!("failed to finalize zip: {e}")
        })),
      )
    })?;
  }

  let zip_bytes = buf.into_inner();

  Ok((
    StatusCode::OK,
    [
      (header::CONTENT_TYPE, "application/zip"),
      (header::CONTENT_DISPOSITION, "attachment; filename=\"myoxus-logs.zip\""),
    ],
    zip_bytes,
  ))
}

// ---------------------------------------------------------------------------
// GET /api/admin/logs/tail
// ---------------------------------------------------------------------------

/// Number of lines to send as initial tail.
const INITIAL_TAIL_LINES: usize = 50;

/// Poll interval for checking new log lines.
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

/// Read the last N lines from a file, returning them as a `Vec<String>`.
///
/// Returns `(lines, end_position)` where `end_position` is the byte offset at
/// which the read ended (equal to the file length at read time). This is used
/// by the SSE tail stream to resume reading from the right offset after rotation.
pub fn tail_lines(path: &Path, n: usize) -> std::io::Result<(Vec<String>, u64)> {
  let mut file = std::fs::File::open(path)?;
  let file_len = file.metadata()?.len();

  if file_len == 0 {
    return Ok((Vec::new(), 0));
  }

  // Read backwards to find the last N newlines.
  // For simplicity, read the tail portion of the file (up to 256KB).
  let read_size = std::cmp::min(file_len, 256 * 1024);
  let start_pos = file_len - read_size;
  file.seek(SeekFrom::Start(start_pos))?;

  let mut buffer = Vec::with_capacity(read_size as usize);
  file.read_to_end(&mut buffer)?;

  let text = String::from_utf8_lossy(&buffer);
  let all_lines: Vec<&str> = text.lines().collect();
  let tail: Vec<String> = all_lines
    .into_iter()
    .rev()
    .take(n)
    .collect::<Vec<_>>()
    .into_iter()
    .rev()
    .map(String::from)
    .collect();

  Ok((tail, file_len))
}

/// Live-tail the current log file via Server-Sent Events.
///
/// Admin-only. Sends the last 50 lines initially, then streams new lines
/// as they are appended to the log file. The stream ends cleanly when the
/// client disconnects.
#[instrument(skip_all)]
pub async fn tail_handler(
  State(state): State<ApiState>,
  headers: HeaderMap,
) -> Result<
  Sse<impl Stream<Item = Result<SseEvent, std::convert::Infallible>>>,
  (StatusCode, axum::Json<serde_json::Value>),
> {
  // Admin auth check
  crate::require_admin_user(&state, &headers)
    .await
    .map_err(|status| (status, axum::Json(serde_json::json!({ "error": "unauthorized" }))))?;

  let log_dir = resolve_log_dir(&state).ok_or_else(|| {
    (
      StatusCode::NOT_FOUND,
      axum::Json(serde_json::json!({
          "error": "file logging not configured (stdout-only mode)"
      })),
    )
  })?;

  let log_stem = resolve_log_stem(&state);
  let log_file = find_current_log_file(&log_dir, &log_stem).ok_or_else(|| {
    (
      StatusCode::NOT_FOUND,
      axum::Json(serde_json::json!({
          "error": "no log files found in log directory"
      })),
    )
  })?;

  info!(file = %log_file.display(), "starting log tail SSE stream");

  // Read initial tail
  let (initial_lines, mut last_pos) = tail_lines(&log_file, INITIAL_TAIL_LINES).map_err(|e| {
    warn!(error = %e, file = %log_file.display(), "failed to read log file for tail");
    (
      StatusCode::INTERNAL_SERVER_ERROR,
      axum::Json(serde_json::json!({
          "error": format!("failed to read log file: {e}")
      })),
    )
  })?;

  // Clone log_dir and stem for use inside the stream (log_file starts as first target).
  let mut current_file = log_file;

  let stream = async_stream::stream! {
      // Send initial lines
      for line in initial_lines {
          yield Ok(SseEvent::default().data(line));
      }

      // Poll for new lines; transparently follow log rotation.
      loop {
          tokio::time::sleep(POLL_INTERVAL).await;

          // Check current file size
          let metadata = match tokio::fs::metadata(&current_file).await {
              Ok(m) => m,
              Err(_) => {
                  // File disappeared — log was probably rotated.  Try to find
                  // the new current log file and follow it.
                  match find_current_log_file(&log_dir, &log_stem) {
                      Some(new_file) if new_file != current_file => {
                          info!(
                              old = %current_file.display(),
                              new = %new_file.display(),
                              "log file rotated, switching to new file"
                          );
                          current_file = new_file;
                          last_pos = 0;
                          continue;
                      }
                      _ => {
                          debug!(file = %current_file.display(), "log file disappeared and no replacement found, ending tail stream");
                          break;
                      }
                  }
              }
          };

          let current_len = metadata.len();

          if current_len < last_pos {
              // File was truncated — reset position
              debug!("log file truncated, resetting position");
              last_pos = 0;
          }

          if current_len > last_pos {
              // Read new bytes
              let new_bytes = match std::fs::File::open(&current_file) {
                  Ok(mut f) => {
                      if f.seek(SeekFrom::Start(last_pos)).is_err() {
                          continue;
                      }
                      let mut buf = Vec::new();
                      if f.read_to_end(&mut buf).is_err() {
                          continue;
                      }
                      buf
                  }
                  Err(_) => continue,
              };

              last_pos = current_len;

              // Parse into lines and send each as an SSE event
              let cursor = Cursor::new(new_bytes);
              for line in cursor.lines() {
                  if let Ok(line) = line
                      && !line.is_empty() {
                          yield Ok(SseEvent::default().data(line));
                      }
              }
          }
      }
  };

  Ok(
    Sse::new(stream).keep_alive(
      axum::response::sse::KeepAlive::new()
        .interval(std::time::Duration::from_secs(15))
        .text("keepalive"),
    ),
  )
}
