// SPDX-License-Identifier: AGPL-3.0-or-later
//! Authenticated delivery from the admitted immutable capture. Conditional
//! requests never bypass current session or retained-receipt authorization.
use crate::{graphql::utils, state::ApiState};
use axum::{
  body::Body,
  extract::{Path, State},
  http::{HeaderMap, StatusCode, header},
  response::{IntoResponse, Response},
};
use myoxus_application::feature_bundle::resolve_feature_artwork;
use myoxus_domain::feature_bundle::FeatureBundlePin;

#[tracing::instrument(skip_all)]
pub async fn feature_artwork_handler(
  state: State<ApiState>,
  path: Path<(String, String, String, String)>,
  headers: HeaderMap,
) -> Response {
  match serve_artwork(state, path, headers).await {
    Ok(response) => response,
    Err(status) => (
      status,
      [(header::CACHE_CONTROL, "private, no-store"), (header::VARY, "Cookie")],
    )
      .into_response(),
  }
}

async fn serve_artwork(
  State(state): State<ApiState>,
  Path((bundle, version, archive_digest, component)): Path<(String, String, String, String)>,
  headers: HeaderMap,
) -> Result<Response, StatusCode> {
  let cookies = utils::parse_cookies(&headers);
  let session_id = utils::parse_uuid_cookie(&cookies, utils::SESSION_COOKIE_NAME).ok_or(StatusCode::UNAUTHORIZED)?;
  let actor = state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .map_err(|_| StatusCode::UNAUTHORIZED)?
    .ok_or(StatusCode::UNAUTHORIZED)?
    .user
    .id;
  let sources = state.feature_sources().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
  let pin = FeatureBundlePin {
    id: bundle,
    version,
    sha256: archive_digest,
  };
  let resource = resolve_feature_artwork(&sources.bundles, &sources.resolved.active, &pin, &component)
    .map_err(|_| StatusCode::NOT_FOUND)?;
  if !resource.active {
    let mut accepted = false;
    for package in &resource.accepted_packages {
      if state
        .workspace()
        .has_accepted_starter_package(actor, package)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
      {
        accepted = true;
        break;
      }
    }
    if !accepted {
      return Err(StatusCode::NOT_FOUND);
    }
  }
  let etag = format!("\"{}\"", resource.digest);
  let unchanged = headers
    .get(header::IF_NONE_MATCH)
    .and_then(|value| value.to_str().ok())
    .is_some_and(|value| {
      value
        .split(',')
        .any(|value| value.trim() == etag || value.trim() == "*")
    });
  let mut response = Response::new(if unchanged {
    Body::empty()
  } else {
    Body::from(resource.bytes.to_vec())
  });
  *response.status_mut() = if unchanged {
    StatusCode::NOT_MODIFIED
  } else {
    StatusCode::OK
  };
  let headers = response.headers_mut();
  headers.insert(
    header::ETAG,
    etag.parse().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  // Every reuse must revalidate authorization, including after membership loss.
  headers.insert(
    header::CACHE_CONTROL,
    header::HeaderValue::from_static("private, no-cache"),
  );
  headers.insert(header::VARY, header::HeaderValue::from_static("Cookie"));
  headers.insert(
    header::CONTENT_TYPE,
    resource
      .metadata
      .media_type
      .parse()
      .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
  );
  super::blob::secure_download_headers(headers, &resource.metadata.media_type, "artwork")?;
  Ok(response)
}
