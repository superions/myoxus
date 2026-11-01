//! Socket.IO room naming and client-version protocol routing.
//!
//! - `get_room` / `get_protocol_rooms`: build socketioxide room names from
//!   `SpaceType`, `space_id`, and a protocol tag (`sync` / `sync-025` / `sync-026`).
//! - Version utilities: normalize raw client version strings, parse to
//!   `semver::Version`, check minimum support, and decide whether the client
//!   uses the batched 0.26 sync protocol.
//!
//! Extracted from `mod.rs` in P107-F.

use semver::Version;

use super::types::SpaceType;

/// First Myoxus release in which every shipped CRDT runtime can consume yrs
/// 0.27 updates. This threshold is a persisted rollout boundary, not a moving
/// alias for the current server version.
const YRS_027_MIN_CLIENT_VERSION: &str = "0.41.5";

pub(super) fn get_room(space_type: SpaceType, space_id: &str, room_type: &str) -> String {
  format!("{}:{}:{}", space_type, space_id, room_type)
}

/// Determine the primary and secondary sync rooms based on the client's protocol version.
///
/// Returns `(target_room, other_room)` — the socket joins `target_room` and
/// leaves `other_room` to ensure it receives broadcasts in exactly one format.
/// Clients >= 0.26.0 use the batched protocol (sync-026); older clients use
/// the single-update protocol (sync-025).
pub(super) fn get_protocol_rooms(space_type: SpaceType, space_id: &str, client_version: &str) -> (String, String) {
  if uses_sync_026_protocol(client_version) {
    (
      get_room(space_type, space_id, "sync-026"),
      get_room(space_type, space_id, "sync-025"),
    )
  } else {
    (
      get_room(space_type, space_id, "sync-025"),
      get_room(space_type, space_id, "sync-026"),
    )
  }
}

pub(super) fn normalize_ws_client_version(client_version: &str) -> Option<String> {
  let raw = client_version.trim();
  if raw.is_empty() {
    return None;
  }
  Some(raw.strip_prefix('v').unwrap_or(raw).to_string())
}

pub(super) fn parse_normalized_ws_version(client_version: &str) -> Option<Version> {
  let normalized = normalize_ws_client_version(client_version)?;
  Version::parse(&normalized).ok()
}

pub(super) fn is_supported_ws_client_version(client_version: &str) -> bool {
  let Some(parsed) = parse_normalized_ws_version(client_version) else {
    return false;
  };
  static MINIMUM: std::sync::OnceLock<Version> = std::sync::OnceLock::new();
  let minimum =
    MINIMUM.get_or_init(|| Version::parse(YRS_027_MIN_CLIENT_VERSION).expect("static: valid yrs rollout version"));
  parsed >= *minimum
}

pub(super) fn uses_sync_026_protocol(client_version: &str) -> bool {
  static THRESHOLD: std::sync::OnceLock<Version> = std::sync::OnceLock::new();
  let Some(parsed) = parse_normalized_ws_version(client_version) else {
    return false;
  };
  let threshold = THRESHOLD.get_or_init(|| Version::parse("0.26.0-0").expect("static: valid semver constant"));
  parsed >= *threshold
}
