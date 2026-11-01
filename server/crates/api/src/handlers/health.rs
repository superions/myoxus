//! Health, readiness, liveness, and server-info endpoint handlers.
//!
//! These handlers implement the Kubernetes-style probe protocol:
//!
//! - `GET /health` — always returns 200 with current uptime and startup-check
//!   snapshots (even when the server is not yet fully ready).
//! - `GET /ready` — returns 200 only after startup checks pass; 503 otherwise.
//!   Kubernetes readiness probe should point here.
//! - `GET /live` — minimal liveness probe; returns 200 as long as the process
//!   is alive.  Does not consult startup checks.
//! - `GET /info` — server version, flavor, and initialisation state used by
//!   the web client to drive the initial-setup wizard.

use axum::{
  extract::State,
  http::StatusCode,
  response::{IntoResponse, Json},
};
use serde::Serialize;
use tracing::{debug, instrument, trace};

use crate::state::ApiState;
use crate::state::StartupCheckSnapshot;

/// Myoxus server version reported by public runtime metadata endpoints.
///
/// Keep this derived from the crate metadata so `/info`, GraphQL and MCP cannot
/// drift from the version declared by the server workspace.
pub(crate) const MYOXUS_SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Response body returned by `GET /health`.
#[derive(Debug, Serialize)]
pub(crate) struct HealthResponse {
  /// Always `"ok"` — the process is alive.
  status: &'static str,
  /// Seconds since the server process started.
  uptime_seconds: u64,
  /// Latest startup check snapshots (database, Redis, storage, etc.).
  checks: Vec<StartupCheckSnapshot>,
}

/// Response body returned by `GET /ready` and `GET /live`.
#[derive(Debug, Serialize)]
pub(crate) struct ReadyResponse {
  /// `"ready"` when all startup checks passed, `"not ready"` otherwise.
  /// For `/live` always `"live"`.
  pub(crate) status: &'static str,
  /// Latest startup check snapshots; empty for `/live`.
  pub(crate) checks: Vec<StartupCheckSnapshot>,
}

/// Response body returned by `GET /info`.
#[derive(Debug, Serialize)]
pub(crate) struct InfoResponse {
  /// Myoxus server version string (e.g. `"x.y.z"`).
  version: &'static str,
  /// Server implementation identifier (always `"myoxus-rust"`).
  flavor: &'static str,
  /// Human-readable server description.
  description: &'static str,
  /// Public base URL as configured.
  base_url: String,
  /// Server name.
  name: String,
  /// `true` when at least one user account exists (setup wizard is done).
  initialized: bool,
}

/// `GET /health` — always returns 200 with uptime and startup-check results.
#[instrument(skip_all, level = "debug")]
pub(crate) async fn health(State(state): State<ApiState>) -> impl IntoResponse {
  trace!("health endpoint requested");
  let checks = state.startup_checks().await;
  Json(HealthResponse {
    status: "ok",
    uptime_seconds: state.uptime_seconds(),
    checks,
  })
}

/// `GET /ready` — returns 200 when the server has passed all startup checks,
/// 503 when checks are still in progress or failed.
///
/// Kubernetes readiness probes should use this endpoint.  Load balancers must
/// not send traffic until this returns 200.
#[instrument(skip_all, level = "debug")]
pub(crate) async fn ready(State(state): State<ApiState>) -> impl IntoResponse {
  trace!("ready endpoint requested");
  let checks = state.startup_checks().await;
  if state.is_ready() {
    (
      StatusCode::OK,
      Json(ReadyResponse {
        status: "ready",
        checks,
      }),
    )
  } else {
    (
      StatusCode::SERVICE_UNAVAILABLE,
      Json(ReadyResponse {
        status: "not ready",
        checks,
      }),
    )
  }
}

/// `GET /live` — minimal liveness probe; always returns 200 while the process
/// is running.  Does not check database or Redis connectivity.
#[instrument(skip_all, level = "debug")]
pub(crate) async fn live() -> impl IntoResponse {
  trace!("live endpoint requested");
  Json(ReadyResponse {
    status: "live",
    checks: Vec::new(),
  })
}

/// `GET /info` — returns server version, flavor, and whether initial setup is complete.
///
/// The web client uses the `initialized` field to decide whether to show the
/// first-run admin-account-creation wizard.
#[instrument(skip_all)]
pub(crate) async fn info_handler(State(state): State<ApiState>) -> impl IntoResponse {
  debug!("handling info request");
  let count = state.admin().count_users(None).await.unwrap_or(0);
  Json(InfoResponse {
    version: MYOXUS_SERVER_VERSION,
    flavor: "myoxus-rust",
    description: "Myoxus Server (Rust)",
    base_url: state.config.server.origin.clone(),
    name: "Myoxus Server".to_string(),
    initialized: count > 0,
  })
}
