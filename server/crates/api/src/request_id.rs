//! Request-ID middleware for distributed tracing correlation.
//!
//! The [`attach_request_id`] Axum middleware generates a UUID v4 per request,
//! stores it as a [`RequestId`] extension for downstream handlers and error
//! formatters, and echoes it back in the `x-request-id` response header.
//! Request counting remains owned by the request logger.

use axum::{
  http::{HeaderName, HeaderValue, Request},
  middleware::Next,
  response::Response,
};
use uuid::Uuid;

/// The HTTP response header used to echo the generated request ID.
pub const REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");

/// Opaque wrapper around the per-request UUID string.
#[derive(Debug, Clone, Default)]
pub struct RequestId(pub String);

/// Axum middleware that assigns a UUID v4 request ID, stores it as a request
/// extension and echoes the ID in
/// `x-request-id`.
pub async fn attach_request_id(mut request: Request<axum::body::Body>, next: Next) -> Response {
  let request_id = RequestId(Uuid::new_v4().to_string());
  request.extensions_mut().insert(request_id.clone());

  let mut response = next.run(request).await;
  if let Ok(value) = HeaderValue::from_str(&request_id.0) {
    response.headers_mut().insert(REQUEST_ID_HEADER, value);
  }
  response
}
