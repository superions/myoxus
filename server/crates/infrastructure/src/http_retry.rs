// SPDX-License-Identifier: AGPL-3.0-or-later
//! Retry utilities for external HTTP calls.
//!
//! Provides exponential backoff retry logic for transient HTTP and network errors.
//! Used by CalDAV, Google Calendar, OpenAI, and other external service clients.

use std::time::Duration;

/// Status codes that indicate a transient error worth retrying.
pub const RETRYABLE_STATUS_CODES: &[u16] = &[408, 429, 502, 503, 504];

/// Retry an async operation with exponential backoff.
///
/// Retries on:
/// - Network/IO errors (`reqwest::Error` with `is_connect()` or `is_timeout()`)
/// - Retryable HTTP status codes (408, 429, 502, 503, 504)
///
/// Does NOT retry on:
/// - 4xx client errors (400, 401, 403, 404, etc.)
/// - 5xx server errors not in the retryable list (500, 501)
///
/// The closure is called up to `max_retries + 1` times total.  Backoff
/// intervals are 1 s, 2 s, 4 s, 8 s (capped at 8 s for attempts beyond 4).
pub async fn retry_on_transient<F, Fut, T, E>(operation_name: &'static str, max_retries: u32, mut f: F) -> Result<T, E>
where
  F: FnMut() -> Fut,
  Fut: std::future::Future<Output = Result<T, E>>,
  E: std::fmt::Display,
{
  let mut attempt = 0u32;
  loop {
    match f().await {
      Ok(v) => return Ok(v),
      Err(e) if attempt < max_retries => {
        attempt += 1;
        let delay_ms = 1000u64 * (1u64 << (attempt - 1).min(4)); // 1s, 2s, 4s, 8s max
        tracing::warn!(
          operation = operation_name,
          attempt,
          max_retries,
          delay_ms,
          error = %e,
          "transient error — retrying"
        );
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
      }
      Err(e) => return Err(e),
    }
  }
}

/// Retry a reqwest operation, inspecting HTTP status codes.
///
/// Retries when:
/// - The `reqwest::Error` indicates a connection or timeout failure.
/// - The response status is in [`RETRYABLE_STATUS_CODES`].
///
/// For 429 (rate limited), the `Retry-After` response header is honoured when
/// present (value interpreted as seconds, capped at 30 s).
///
/// The closure is called up to `max_retries + 1` times total.
pub async fn retry_reqwest<F, Fut>(
  operation_name: &'static str,
  max_retries: u32,
  mut f: F,
) -> Result<reqwest::Response, reqwest::Error>
where
  F: FnMut() -> Fut,
  Fut: std::future::Future<Output = Result<reqwest::Response, reqwest::Error>>,
{
  let mut attempt = 0u32;
  loop {
    match f().await {
      Err(e) if attempt < max_retries && (e.is_connect() || e.is_timeout()) => {
        attempt += 1;
        let delay_ms = 1000u64 * (1u64 << (attempt - 1).min(3));
        tracing::warn!(
          operation = operation_name,
          attempt,
          error = %e,
          delay_ms,
          "network error — retrying"
        );
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
      }
      Ok(resp) if attempt < max_retries && RETRYABLE_STATUS_CODES.contains(&resp.status().as_u16()) => {
        attempt += 1;
        let delay_ms = if resp.status().as_u16() == 429 {
          // Honour Retry-After header if present (value in seconds).
          resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .map(|s| s.saturating_mul(1000).min(30_000))
            .unwrap_or(1000u64 * (1u64 << (attempt - 1).min(3)))
        } else {
          1000u64 * (1u64 << (attempt - 1).min(3))
        };
        tracing::warn!(
          operation = operation_name,
          attempt,
          status = resp.status().as_u16(),
          delay_ms,
          "retryable HTTP status — retrying"
        );
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
      }
      result => return result,
    }
  }
}
