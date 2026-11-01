//! WebSocket session state: in-process DashMap statics + per-socket membership helpers.
//!
//! SC-M-01: Socket.IO session state architecture (local + optional Redis).
//!
//! Process-local DashMaps (always present, fast, no network):
//! - `SOCKET_USER_MAP`, `SOCKET_SESSION_MAP`, `SOCKET_SPACE_MEMBERSHIPS`, `SOCKET_AWARENESS_MEMBERSHIPS`,
//!   `SOCKET_NOTIFICATION_SUBSCRIPTIONS`, `SOCKET_COPILOT_SUBSCRIPTIONS`,
//!   `SOCKET_PENDING_NOTIFICATION_ACKS`, `SOCKET_CLIENT_VERSIONS`
//!   → Per-socket state only needed by the owning server instance.
//!
//! Optionally Redis-backed (when `redis.roles.socket.url` is configured):
//! - `WORKSPACE_SESSIONS` → also mirrored to Redis Set `ws:sessions:{workspace_id}`
//! - `NOTIFICATION_EVENT_ACKS` → also mirrored to Redis key `ws:notify:acks:{event_id}`
//! - Doc broadcasts → also published to Redis Pub/Sub `ws:broadcast:{workspace_id}`
//!
//! When the Redis socket adapter is not configured, behavior is identical to the
//! previous single-instance-only design. See `redis_adapter.rs` for details.
//!
//! Extracted from `mod.rs` in P107-D.

use dashmap::DashMap;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use uuid::Uuid;

use super::types::SpaceType;
use myoxus_application::doc::{DocLoadCancellation, DocLoadCancellationReason, DocSyncClientKind};
use myoxus_domain::ids::WorkspaceId;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct SocketClientContext {
  pub(super) kind: DocSyncClientKind,
}

/// Maximum number of entries in `NOTIFICATION_EVENT_ACKS` before forced eviction.
/// These are one-time ack records that should not grow unboundedly.
pub(super) const NOTIFICATION_EVENT_ACKS_MAX: usize = 10_000;

/// TTL for `NOTIFICATION_EVENT_ACKS` entries. Entries older than this are evicted
/// during periodic cleanup in `flush_analytics`. 10 minutes is generous — acks
/// are typically processed within seconds.
pub(super) const NOTIFICATION_EVENT_ACKS_TTL: Duration = Duration::from_secs(600);

#[derive(Default)]
struct SocketDocLoadState {
  cancellation: DocLoadCancellation,
  loads: HashSet<String>,
}

/// Maps socket ID → authenticated user UUID.
/// Populated by `auth_middleware` on connect, removed on disconnect.
/// Every event handler reads this to identify the caller.
pub(super) static SOCKET_USER_MAP: LazyLock<DashMap<String, Uuid>> = LazyLock::new(DashMap::new);

/// Maps socket ID to the authenticated session UUID. Unlike user identity,
/// this lets a single-session revoke stop only work owned by that session.
pub(super) static SOCKET_SESSION_MAP: LazyLock<DashMap<String, Uuid>> = LazyLock::new(DashMap::new);

/// Server-derived connect-time client class. Removed on every disconnect;
/// authentication and admission ownership remain session/account based.
pub(super) static SOCKET_CLIENT_CONTEXTS: LazyLock<DashMap<String, SocketClientContext>> = LazyLock::new(DashMap::new);

/// Maps workspace UUID → set of socket IDs currently joined to that workspace.
/// Used for active-user analytics (flushed periodically) and disconnect cleanup.
/// Optionally mirrored to Redis for cross-instance session tracking.
pub(super) static WORKSPACE_SESSIONS: LazyLock<DashMap<Uuid, HashSet<String>>> = LazyLock::new(DashMap::new);

/// Maps socket ID → set of space keys (format: `"{spaceType}:{spaceId}"`) the
/// socket has joined. Used by `ensure_space_joined` to avoid redundant joins
/// and by disconnect cleanup to leave all spaces atomically.
pub(super) static SOCKET_SPACE_MEMBERSHIPS: LazyLock<DashMap<String, HashSet<String>>> = LazyLock::new(DashMap::new);

/// Maps socket ID → set of awareness room keys (format: `"{spaceType}:{spaceId}:{docId}"`).
/// Tracks which awareness rooms a socket is subscribed to, for targeted
/// awareness-update broadcasting and disconnect cleanup.
pub(super) static SOCKET_AWARENESS_MEMBERSHIPS: LazyLock<DashMap<String, HashSet<String>>> =
  LazyLock::new(DashMap::new);

/// Maps socket ID → whether the socket has subscribed to notifications.
/// The notification fanout loop checks this before delivering events.
/// Initialized to `false` on connect, set to `true` by `notification:subscribe`.
pub(super) static SOCKET_NOTIFICATION_SUBSCRIPTIONS: LazyLock<DashMap<String, bool>> = LazyLock::new(DashMap::new);

/// Maps socket ID → whether the socket has subscribed to Copilot UI events.
/// Same pattern as `SOCKET_NOTIFICATION_SUBSCRIPTIONS`.
pub(super) static SOCKET_COPILOT_SUBSCRIPTIONS: LazyLock<DashMap<String, bool>> = LazyLock::new(DashMap::new);

/// Maps socket ID → set of event IDs that have been pushed to this socket
/// but not yet acknowledged by the client. Used for at-most-once delivery
/// tracking: the `notification:ack` handler checks this before recording the ack.
pub(super) static SOCKET_PENDING_NOTIFICATION_ACKS: LazyLock<DashMap<String, HashSet<String>>> =
  LazyLock::new(DashMap::new);

/// Maps event ID → (set of socket IDs that acknowledged, creation timestamp).
/// Global (not per-socket) to support cross-socket dedup within the same instance.
/// P84-E-02: Entries carry an `Instant` for TTL-based eviction in `flush_analytics`.
/// Entries older than `NOTIFICATION_EVENT_ACKS_TTL` are removed incrementally;
/// a hard cap at `NOTIFICATION_EVENT_ACKS_MAX` triggers full clear as safety net.
pub(super) static NOTIFICATION_EVENT_ACKS: LazyLock<DashMap<String, (HashSet<String>, Instant)>> =
  LazyLock::new(DashMap::new);

/// Maps socket ID → client version string (e.g. "0.26.1").
/// Recorded at `space:join` time so that `ensure_space_joined` (auto-join)
/// can route the socket to the correct protocol room (sync-025 vs sync-026)
/// instead of hardcoding a default version.
pub(super) static SOCKET_CLIENT_VERSIONS: LazyLock<DashMap<String, String>> = LazyLock::new(DashMap::new);

/// Socket-owned cancellation root and in-flight `space_id:doc_id` keys.
/// Authentication creates this entry; disconnect/revocation removes it.
static SOCKET_DOC_LOAD_STATES: LazyLock<DashMap<String, SocketDocLoadState>> = LazyLock::new(DashMap::new);

/// P-DB-29B-C: per-socket Database presence records.
///
/// One transport can serve several Database embeds. Membership and focus must
/// therefore be scoped to each authorized workspace/database pair, while
/// disconnect still removes every membership belonging to the socket.
pub(super) static DATABASE_PRESENCE: LazyLock<DashMap<String, HashMap<(WorkspaceId, Uuid), DatabasePresenceEntry>>> =
  LazyLock::new(DashMap::new);

/// P-DB-29B-C: per-database presence index, used by `list_database_presence`
/// to return the snapshot for a single room without scanning every socket.
pub(super) static DATABASE_PRESENCE_BY_ROOM: LazyLock<DashMap<String, HashSet<String>>> = LazyLock::new(DashMap::new);
/// Owns one socket/document singleflight slot until the handler completes.
pub(super) struct SocketDocLoadGuard {
  socket_id: String,
  load_key: String,
  cancellation: DocLoadCancellation,
}

impl SocketDocLoadGuard {
  pub(super) fn cancellation(&self) -> DocLoadCancellation {
    self.cancellation.clone()
  }
}

impl Drop for SocketDocLoadGuard {
  fn drop(&mut self) {
    if let Some(mut state) = SOCKET_DOC_LOAD_STATES.get_mut(&self.socket_id) {
      state.loads.remove(&self.load_key);
    }
  }
}

pub(super) fn register_socket_doc_load_state(socket_id: &str) {
  SOCKET_DOC_LOAD_STATES.insert(socket_id.to_string(), SocketDocLoadState::default());
}

/// Reserve one expensive load per socket/document pair.
///
/// The cancellation object belongs to the socket, while this guard owns only
/// the singleflight key. Disconnect removes the registry and flips the shared
/// cancellation signal; a later socket can never inherit either state.
pub(super) fn try_begin_doc_load(socket_id: &str, space_id: Uuid, doc_id: Uuid) -> Option<SocketDocLoadGuard> {
  let mut state = SOCKET_DOC_LOAD_STATES.get_mut(socket_id)?;
  let load_key = format!("{space_id}:{doc_id}");
  if !state.loads.insert(load_key.clone()) {
    return None;
  }
  let cancellation = state.cancellation.clone();
  Some(SocketDocLoadGuard {
    socket_id: socket_id.to_string(),
    load_key,
    cancellation,
  })
}

pub(super) fn cancel_socket_doc_loads(socket_id: &str, reason: DocLoadCancellationReason) -> bool {
  if let Some((_, state)) = SOCKET_DOC_LOAD_STATES.remove(socket_id) {
    state.cancellation.cancel_with_reason(reason);
    return !state.loads.is_empty();
  }
  false
}

pub(super) fn cancel_session_doc_loads(session_id: Uuid) -> usize {
  let socket_ids: Vec<String> = SOCKET_SESSION_MAP
    .iter()
    .filter(|entry| *entry.value() == session_id)
    .map(|entry| entry.key().clone())
    .collect();
  socket_ids
    .iter()
    .filter(|socket_id| cancel_socket_doc_loads(socket_id, DocLoadCancellationReason::SessionRevoked))
    .count()
}

pub(super) fn cancel_user_doc_loads(user_id: Uuid) -> usize {
  let socket_ids: Vec<String> = SOCKET_USER_MAP
    .iter()
    .filter(|entry| *entry.value() == user_id)
    .map(|entry| entry.key().clone())
    .collect();
  socket_ids
    .iter()
    .filter(|socket_id| cancel_socket_doc_loads(socket_id, DocLoadCancellationReason::SessionRevoked))
    .count()
}

pub(super) fn cancel_all_doc_loads() -> usize {
  let socket_ids: Vec<String> = SOCKET_DOC_LOAD_STATES.iter().map(|entry| entry.key().clone()).collect();
  socket_ids
    .iter()
    .filter(|socket_id| cancel_socket_doc_loads(socket_id, DocLoadCancellationReason::Shutdown))
    .count()
}

#[cfg(test)]
mod doc_load_tests {
  use super::*;

  #[test]
  fn socket_doc_load_registry_enforces_singleflight_and_disconnect_cancellation() {
    let socket_id = format!("sync-load-test-{}", Uuid::new_v4());
    register_socket_doc_load_state(&socket_id);
    let space_id = Uuid::new_v4();
    let doc_id = Uuid::new_v4();
    let first = try_begin_doc_load(&socket_id, space_id, doc_id).expect("first load owns the slot");
    let cancellation = first.cancellation();
    assert!(try_begin_doc_load(&socket_id, space_id, doc_id).is_none());

    drop(first);
    let second = try_begin_doc_load(&socket_id, space_id, doc_id).expect("completed load releases the slot");
    assert!(cancel_socket_doc_loads(
      &socket_id,
      DocLoadCancellationReason::Disconnect
    ));
    assert!(cancellation.is_cancelled());
    assert_eq!(cancellation.reason(), Some(DocLoadCancellationReason::Disconnect));
    assert!(second.cancellation().is_cancelled());
    drop(second);
    assert!(!SOCKET_DOC_LOAD_STATES.contains_key(&socket_id));
    assert!(
      try_begin_doc_load(&socket_id, space_id, doc_id).is_none(),
      "a late handler must not recreate socket-owned state after disconnect"
    );
  }

  #[tokio::test]
  async fn committed_session_and_user_revocation_cancel_owned_loads() {
    let user_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let socket_id = format!("sync-session-revoke-{session_id}");
    SOCKET_USER_MAP.insert(socket_id.clone(), user_id);
    SOCKET_SESSION_MAP.insert(socket_id.clone(), session_id);
    register_socket_doc_load_state(&socket_id);
    let guard = try_begin_doc_load(&socket_id, Uuid::new_v4(), Uuid::new_v4()).expect("load owns slot");
    let cancellation = guard.cancellation();

    let cache = crate::cache::QueryCache::new(&crate::cache::CacheConfig::default());
    crate::cache_bus::apply_invalidation(&cache, "auth_session_revoked", &session_id.to_string(), None).await;
    assert_eq!(cancellation.reason(), Some(DocLoadCancellationReason::SessionRevoked));
    assert_eq!(cancel_user_doc_loads(user_id), 0, "the same load is not counted twice");
    let peer_session = Uuid::new_v4();
    let peer_socket = format!("sync-user-revoke-{peer_session}");
    SOCKET_USER_MAP.insert(peer_socket.clone(), user_id);
    SOCKET_SESSION_MAP.insert(peer_socket.clone(), peer_session);
    register_socket_doc_load_state(&peer_socket);
    let peer_guard = try_begin_doc_load(&peer_socket, Uuid::new_v4(), Uuid::new_v4()).expect("peer load");
    crate::cache_bus::apply_invalidation(&cache, "auth_session_revoked", &session_id.to_string(), None).await;
    assert_eq!(
      peer_guard.cancellation().reason(),
      None,
      "single event preserves other sessions"
    );
    crate::cache_bus::apply_invalidation(&cache, "auth_user_sessions_revoked", &user_id.to_string(), None).await;
    assert_eq!(
      peer_guard.cancellation().reason(),
      Some(DocLoadCancellationReason::SessionRevoked)
    );
    drop(peer_guard);
    SOCKET_SESSION_MAP.remove(&peer_socket);
    SOCKET_USER_MAP.remove(&peer_socket);
    assert!(
      try_begin_doc_load(&socket_id, Uuid::new_v4(), Uuid::new_v4()).is_none(),
      "a revoked session must not admit another load"
    );

    drop(guard);
    SOCKET_SESSION_MAP.remove(&socket_id);
    SOCKET_USER_MAP.remove(&socket_id);
  }
}

/// P-DB-29B-C: stored presence entry. `database_id` is a `Uuid` rather than
/// the `DatabaseId` alias so the state module does not need to depend on the
/// domain crate's newtype.
#[derive(Debug, Clone)]
pub(super) struct DatabasePresenceEntry {
  pub workspace_id: WorkspaceId,
  pub database_id: Uuid,
  pub user_id: Uuid,
  pub display_name: String,
  pub view_id: Option<Uuid>,
  pub row_id: Option<Uuid>,
  pub field_id: Option<Uuid>,
  pub dragging: bool,
  pub last_active_at: Instant,
}

const DATABASE_PRESENCE_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(90);

// ---------------------------------------------------------------------------
// Membership key helpers
// ---------------------------------------------------------------------------

pub(super) fn make_space_key(space_type: SpaceType, space_id: &str) -> String {
  format!("{}:{space_id}", space_type)
}

pub(super) fn make_awareness_key(space_type: SpaceType, space_id: &str, doc_id: &str) -> String {
  format!("{}:{space_id}:{doc_id}", space_type)
}

// ---------------------------------------------------------------------------
// Space membership
// ---------------------------------------------------------------------------

pub(super) fn remember_space_membership(socket_id: &str, space_key: String) {
  SOCKET_SPACE_MEMBERSHIPS
    .entry(socket_id.to_string())
    .or_default()
    .insert(space_key);
}

pub(super) fn forget_space_membership(socket_id: &str, space_key: &str) {
  if let Some(mut entry) = SOCKET_SPACE_MEMBERSHIPS.get_mut(socket_id) {
    entry.value_mut().remove(space_key);
  }
}

pub(super) fn has_space_membership(socket_id: &str, space_key: &str) -> bool {
  SOCKET_SPACE_MEMBERSHIPS
    .get(socket_id)
    .map(|set| set.contains(space_key))
    .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Awareness membership
// ---------------------------------------------------------------------------

pub(super) fn remember_awareness_membership(socket_id: &str, awareness_key: String) {
  SOCKET_AWARENESS_MEMBERSHIPS
    .entry(socket_id.to_string())
    .or_default()
    .insert(awareness_key);
}

pub(super) fn forget_awareness_membership(socket_id: &str, awareness_key: &str) {
  if let Some(mut entry) = SOCKET_AWARENESS_MEMBERSHIPS.get_mut(socket_id) {
    entry.value_mut().remove(awareness_key);
  }
}

pub(super) fn has_awareness_membership(socket_id: &str, awareness_key: &str) -> bool {
  SOCKET_AWARENESS_MEMBERSHIPS
    .get(socket_id)
    .map(|set| set.contains(awareness_key))
    .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Notification / Copilot subscriptions
// ---------------------------------------------------------------------------

pub(super) fn mark_notification_subscribed(socket_id: &str) {
  SOCKET_NOTIFICATION_SUBSCRIPTIONS.insert(socket_id.to_string(), true);
}

pub(super) fn is_notification_subscribed(socket_id: &str) -> bool {
  SOCKET_NOTIFICATION_SUBSCRIPTIONS
    .get(socket_id)
    .map(|value| *value)
    .unwrap_or(false)
}

pub(super) fn mark_copilot_subscribed(socket_id: &str) {
  SOCKET_COPILOT_SUBSCRIPTIONS.insert(socket_id.to_string(), true);
}

pub(super) fn is_copilot_subscribed(socket_id: &str) -> bool {
  SOCKET_COPILOT_SUBSCRIPTIONS
    .get(socket_id)
    .map(|value| *value)
    .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Notification ack tracking
// ---------------------------------------------------------------------------

pub(super) fn record_notification_delivery(socket_id: &str, event_id: &str) {
  SOCKET_PENDING_NOTIFICATION_ACKS
    .entry(socket_id.to_string())
    .or_default()
    .insert(event_id.to_string());
}

pub(super) fn ack_notification_delivery(socket_id: &str, event_id: &str) -> bool {
  let mut acked = false;
  if let Some(mut entry) = SOCKET_PENDING_NOTIFICATION_ACKS.get_mut(socket_id) {
    acked = entry.value_mut().remove(event_id);
  }
  if acked {
    NOTIFICATION_EVENT_ACKS
      .entry(event_id.to_string())
      .or_insert_with(|| (HashSet::new(), Instant::now()))
      .0
      .insert(socket_id.to_string());
  }
  acked
}

// ---------------------------------------------------------------------------
// Database presence (P-DB-29B-C)
// ---------------------------------------------------------------------------

/// Key the per-room index by `database:{database_id}` so that `list_*` does
/// not need to walk every socket entry. Workspace isolation is enforced at
/// the handler layer (the access predicate checks the `workspace_id`
/// matches); the index itself is purely a lookup optimisation.
pub(super) fn database_room_key(workspace_id: WorkspaceId, database_id: Uuid) -> String {
  let _ = workspace_id;
  format!("database:{database_id}")
}

pub(super) fn remember_database_presence(
  socket_id: &str,
  workspace_id: WorkspaceId,
  database_id: Uuid,
  user_id: Uuid,
  display_name: String,
) {
  let room = database_room_key(workspace_id, database_id);
  let mut memberships = DATABASE_PRESENCE.entry(socket_id.to_string()).or_default();
  DATABASE_PRESENCE_BY_ROOM
    .entry(room.clone())
    .or_default()
    .insert(socket_id.to_string());
  memberships.insert(
    (workspace_id, database_id),
    DatabasePresenceEntry {
      workspace_id,
      database_id,
      user_id,
      display_name,
      view_id: None,
      row_id: None,
      field_id: None,
      dragging: false,
      last_active_at: Instant::now(),
    },
  );
}

fn remove_database_presence_index(socket_id: &str, entry: &DatabasePresenceEntry) {
  let room = database_room_key(entry.workspace_id, entry.database_id);
  if let Some(mut set) = DATABASE_PRESENCE_BY_ROOM.get_mut(&room) {
    set.remove(socket_id);
  }
  DATABASE_PRESENCE_BY_ROOM.remove_if(&room, |_, sockets| sockets.is_empty());
}

pub(super) fn forget_database_presence(socket_id: &str) -> Vec<DatabasePresenceEntry> {
  let Some((_, memberships)) = DATABASE_PRESENCE.remove(socket_id) else {
    return Vec::new();
  };
  memberships
    .into_values()
    .inspect(|entry| remove_database_presence_index(socket_id, entry))
    .collect()
}

fn forget_database_room_presence_if(
  socket_id: &str,
  workspace_id: WorkspaceId,
  database_id: Uuid,
  should_remove: impl FnOnce(&DatabasePresenceEntry) -> bool,
) -> Option<DatabasePresenceEntry> {
  let entry = {
    let mut memberships = DATABASE_PRESENCE.get_mut(socket_id)?;
    let key = (workspace_id, database_id);
    if !memberships.get(&key).is_some_and(should_remove) {
      return None;
    }
    let entry = memberships.remove(&key)?;
    // Keep the socket guard until its room index is updated. A concurrent
    // rejoin must not have its newly inserted index removed by this leave.
    remove_database_presence_index(socket_id, &entry);
    entry
  };
  DATABASE_PRESENCE.remove_if(socket_id, |_, memberships| memberships.is_empty());
  Some(entry)
}

pub(super) fn forget_database_room_presence(
  socket_id: &str,
  workspace_id: WorkspaceId,
  database_id: Uuid,
) -> Option<DatabasePresenceEntry> {
  forget_database_room_presence_if(socket_id, workspace_id, database_id, |_| true)
}

pub(super) fn update_database_presence(
  socket_id: &str,
  workspace_id: WorkspaceId,
  database_id: Uuid,
  view_id: Option<Uuid>,
  row_id: Option<Uuid>,
  field_id: Option<Uuid>,
  dragging: bool,
) {
  if let Some(mut memberships) = DATABASE_PRESENCE.get_mut(socket_id)
    && let Some(entry) = memberships.get_mut(&(workspace_id, database_id))
  {
    entry.view_id = view_id;
    entry.row_id = row_id;
    entry.field_id = field_id;
    entry.dragging = dragging;
    entry.last_active_at = Instant::now();
  }
}

#[derive(Debug, Clone)]
pub(super) struct DatabasePresenceSnapshot {
  pub socket_id: String,
  pub user_id: Uuid,
  pub display_name: String,
  pub view_id: Option<Uuid>,
  pub row_id: Option<Uuid>,
  pub field_id: Option<Uuid>,
  pub dragging: bool,
  pub last_active_at: chrono::DateTime<chrono::Utc>,
}

pub(super) fn list_database_presence(workspace_id: WorkspaceId, database_id: Uuid) -> Vec<DatabasePresenceSnapshot> {
  let room = database_room_key(workspace_id, database_id);
  let Some(sockets) = DATABASE_PRESENCE_BY_ROOM.get(&room) else {
    return Vec::new();
  };
  let socket_ids = sockets.value().iter().cloned().collect::<Vec<_>>();
  drop(sockets);
  let mut snapshot = Vec::with_capacity(socket_ids.len());
  let mut stale = Vec::new();
  for sid in socket_ids {
    if let Some(memberships) = DATABASE_PRESENCE.get(&sid)
      && let Some(entry) = memberships.get(&(workspace_id, database_id))
    {
      let elapsed = entry.last_active_at.elapsed();
      if elapsed >= DATABASE_PRESENCE_STALE_AFTER {
        stale.push(sid.clone());
        continue;
      }
      snapshot.push(DatabasePresenceSnapshot {
        socket_id: sid.clone(),
        user_id: entry.user_id,
        display_name: entry.display_name.clone(),
        view_id: entry.view_id,
        row_id: entry.row_id,
        field_id: entry.field_id,
        dragging: entry.dragging,
        last_active_at: chrono::Utc::now()
          - chrono::Duration::from_std(elapsed).unwrap_or_else(|_| chrono::Duration::zero()),
      });
    }
  }
  for sid in stale {
    // Recheck under the socket guard: a heartbeat may have refreshed this
    // membership since the snapshot observed it as stale.
    let _ = forget_database_room_presence_if(&sid, workspace_id, database_id, |entry| {
      entry.last_active_at.elapsed() >= DATABASE_PRESENCE_STALE_AFTER
    });
  }
  snapshot
}
