//! Redis-backed cross-instance WebSocket state (SC-M-01).
//!
//! ## Architecture
//!
//! The WebSocket module uses two tiers of state:
//!
//! **Process-local DashMaps (fast, no network, always present):**
//! - `SOCKET_USER_MAP` — socket ID to user UUID
//! - `SOCKET_SPACE_MEMBERSHIPS` — socket ID to joined space keys
//! - `SOCKET_AWARENESS_MEMBERSHIPS` — socket ID to awareness room keys
//! - `SOCKET_NOTIFICATION_SUBSCRIPTIONS` — socket ID to subscription flag
//! - `SOCKET_COPILOT_SUBSCRIPTIONS` — socket ID to subscription flag
//! - `SOCKET_PENDING_NOTIFICATION_ACKS` — socket ID to pending event IDs
//! - `SOCKET_CLIENT_VERSIONS` — socket ID to client version string
//!
//! These are per-connection state that only the owning server instance needs.
//!
//! **Redis Socket-role cross-instance state (~0.2ms per op):**
//! - Workspace liveness — `ws:sessions:{workspace_id}` is a Redis hash of
//!   startup-instance/socket fields to authenticated user/lease deadlines.
//!   Analytics renews each local membership; Redis TIME owns expiry.
//! - Notification ACKs — event-scoped Redis strings with a 24h TTL.
//! - `ws:broadcast:{workspace_id}` — Pub/Sub channel for doc update fan-out
//!   across instances.
//!
//! ## Role availability
//!
//! Redis itself is a hard server dependency. When this role-specific adapter is
//! absent, existing non-XWS socket consumers retain their documented local
//! behavior. XWS never treats that behavior as notification-delivery fallback;
//! its durable outbox remains pending.
//!
//! ## Performance
//!
//! - Local DashMap operations: <1us
//! - Workspace membership commands are bounded and asynchronous.
//! - Redis Pub/Sub publish: ~0.1ms
//! - Redis Pub/Sub receive: event-driven, no polling

use redis::AsyncCommands;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, error, info, trace, warn};
use uuid::Uuid;

use myoxus_infrastructure::redis::RedisAdapter;

/// Internal user-scoped transport; clients consume notification:push envelopes.
pub const XWS_NOTIFICATION_REDIS_EVENT: &str = "notification:new";

pub use myoxus_infrastructure::redis::workspace_broadcast::CrossInstanceBroadcast;
use myoxus_infrastructure::redis::workspace_broadcast::publish_workspace_broadcast;

/// Redis-backed cross-instance WebSocket state coordinator.
///
/// Wraps a `RedisAdapter` (from the `socket` role) and provides workspace
/// session tracking, notification ack deduplication, and Pub/Sub broadcast
/// fan-out across multiple server instances.
pub struct RedisWsAdapter {
  /// Process identity shared with `ApiState` and the cache invalidation bus.
  ///
  /// It is injected by the startup owner rather than derived from a hostname:
  /// replicas may share an OS hostname while still requiring distinct
  /// self-suppression and Redis session identities.
  instance_id: Uuid,
  /// The Redis adapter for the `socket` role.
  adapter: Arc<RedisAdapter>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConnectionAdmissionDecision {
  pub accepted: bool,
  pub retry_after_ms: u64,
  pub session_attempts: u32,
  pub account_attempts: u32,
}

/// Redis key schema constants.
///
/// All keys use the adapter's namespace prefix automatically via `RedisAdapter`.
/// The keys documented here are the suffixes after the namespace.
///
/// ```text
/// ws:sessions:{workspace_id}  -> Hash: instance/socket -> user:expiry_seconds
/// ws:notify:acks:{event_id}   -> String "1" with TTL 86400s (24h)
/// ```
///
/// Pub/Sub channels use the same role namespace:
/// ```text
/// {namespace}:ws:broadcast:{workspace_id} -> JSON-encoded CrossInstanceBroadcast
/// ```
mod keys {
  use uuid::Uuid;

  pub fn workspace_sessions(workspace_id: Uuid) -> String {
    format!("ws:sessions:{workspace_id}")
  }

  pub fn notification_ack(event_id: &str) -> String {
    format!("ws:notify:acks:{event_id}")
  }

  pub fn broadcast_channel(namespace: &str, workspace_id: &str) -> String {
    myoxus_infrastructure::redis::workspace_broadcast::broadcast_channel(namespace, workspace_id)
  }

  pub fn database_presence(workspace_id: Uuid, database_id: Uuid) -> String {
    format!("ws:database:presence:{workspace_id}:{database_id}")
  }
}

/// TTL for notification ack records in Redis (24 hours).
const NOTIFICATION_ACK_TTL_SECONDS: u64 = 86_400;

impl RedisWsAdapter {
  /// Create an adapter for the startup-owned process identity.
  pub fn new(instance_id: Uuid, adapter: Arc<RedisAdapter>) -> Self {
    info!(
        %instance_id,
        "RedisWsAdapter initialized for cross-instance WebSocket state"
    );
    Self { instance_id, adapter }
  }

  /// Verify that the shared Socket.IO coordination transport is reachable.
  ///
  /// This diagnostic is not an XWS admission check. XWS persists business
  /// state first and retries post-commit fanout from its durable outbox.
  pub async fn ping(&self) -> Result<(), String> {
    self.adapter.ping().await.map_err(|error| error.to_string())
  }

  fn session_member(&self, socket_id: &str) -> String {
    format!("{}:{socket_id}", self.instance_id)
  }

  pub(super) fn should_forward(instance_id: Uuid, broadcast: &CrossInstanceBroadcast) -> bool {
    broadcast.origin_instance != instance_id.to_string()
  }

  /// Atomically admit one new Socket.IO namespace connection against the
  /// session and account sliding windows shared by every API replica.
  ///
  /// Redis `TIME` is the only clock, so replica clock skew cannot widen the
  /// window. Both sorted-set keys share the account hash tag and therefore one
  /// Redis Cluster slot. The Lua operation removes attempts at least 1,000 ms
  /// old, records the current attempt in both windows, and then returns the
  /// strictest retry delay. Rejected attempts remain counted; retry floods
  /// cannot keep probing the boundary for free. Keys expire after two idle
  /// seconds. Callers must fail closed on every returned transport error.
  #[tracing::instrument(skip_all)]
  pub async fn admit_connection(
    &self,
    session_key: &str,
    account_key: &str,
    max_connections_per_second: u32,
  ) -> Result<ConnectionAdmissionDecision, String> {
    let session_window = format!(
      "{}:ws:admission:{{{account_key}}}:session:{session_key}",
      self.adapter.namespace()
    );
    let account_window = format!("{}:ws:admission:{{{account_key}}}:account", self.adapter.namespace());
    let attempt_member = Uuid::new_v4().simple().to_string();
    let mut connection = self
      .adapter
      .command_connection()
      .await
      .map_err(|error| format!("redis connection admission unavailable: {error}"))?;
    let script = redis::Script::new(
      r#"
local server_time = redis.call('TIME')
local now_ms = (server_time[1] * 1000) + math.floor(server_time[2] / 1000)
local cutoff_ms = now_ms - 1000
local limit = tonumber(ARGV[1])
local member = ARGV[2]

for index = 1, 2 do
  redis.call('ZREMRANGEBYSCORE', KEYS[index], '-inf', cutoff_ms)
  redis.call('ZADD', KEYS[index], now_ms, member)
  redis.call('PEXPIRE', KEYS[index], 2000)
end

local session_count = redis.call('ZCARD', KEYS[1])
local account_count = redis.call('ZCARD', KEYS[2])
local accepted = 1
if session_count > limit or account_count > limit then
  accepted = 0
end

local retry_after_ms = 0
if accepted == 0 then
  for index = 1, 2 do
    local count = redis.call('ZCARD', KEYS[index])
    if count > limit then
      local oldest = redis.call('ZRANGE', KEYS[index], 0, 0, 'WITHSCORES')
      if oldest[2] then
        retry_after_ms = math.max(retry_after_ms, tonumber(oldest[2]) + 1000 - now_ms)
      end
    end
  end
  retry_after_ms = math.max(1, retry_after_ms)
end

return { accepted, retry_after_ms, session_count, account_count }
"#,
    );
    let result: Vec<i64> = script
      .key(session_window)
      .key(account_window)
      .arg(max_connections_per_second)
      .arg(attempt_member)
      .invoke_async(&mut connection)
      .await
      .map_err(|error| format!("redis connection admission script failed: {error}"))?;
    if result.len() != 4 {
      return Err("redis connection admission returned an invalid result".to_string());
    }

    Ok(ConnectionAdmissionDecision {
      accepted: result[0] == 1,
      retry_after_ms: result[1].max(0) as u64,
      session_attempts: u32::try_from(result[2]).unwrap_or(u32::MAX),
      account_attempts: u32::try_from(result[3]).unwrap_or(u32::MAX),
    })
  }

  /// Register or renew an authenticated socket's workspace membership.
  ///
  /// Each record lives for three analytics intervals (two missed heartbeats of
  /// grace). Redis TIME avoids replica clock skew. The same key replaces the
  /// old non-expiring Set; all API nodes must restart for this ephemeral cutover.
  pub async fn join_workspace(
    &self,
    workspace_id: Uuid,
    socket_id: &str,
    user_id: Uuid,
    heartbeat_seconds: u64,
  ) -> Result<(), String> {
    let lease_seconds = heartbeat_seconds
      .checked_mul(3)
      .filter(|seconds| *seconds > 0 && *seconds <= 9_007_199_254_740_991)
      .ok_or_else(|| "workspace heartbeat lease exceeds Redis integer precision".to_string())?;
    let key = format!(
      "{}:{}",
      self.adapter.namespace(),
      keys::workspace_sessions(workspace_id)
    );
    let member = self.session_member(socket_id);
    tokio::time::timeout(Duration::from_secs(5), async {
      let mut connection = self
        .adapter
        .command_connection()
        .await
        .map_err(|error| error.to_string())?;
      redis::Script::new(
        r#"
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'set' then redis.call('DEL', KEYS[1])
elseif kind ~= 'none' and kind ~= 'hash' then return redis.error_reply('invalid workspace membership type') end
local now = tonumber(redis.call('TIME')[1])
local expiry = now + tonumber(ARGV[3])
if expiry > 9007199254740991 then return redis.error_reply('workspace lease overflow') end
-- Keep observed-empty workspaces discoverable after pruning or a failed SQL
-- sample. Socket fields expire independently; this marker carries no presence.
redis.call('HSET', KEYS[1], '__observed__', '1', ARGV[1], ARGV[2] .. ':' .. string.format('%.0f', expiry))
return 1
"#,
      )
      .key(key)
      .arg(member)
      .arg(user_id.to_string())
      .arg(lease_seconds)
      .invoke_async::<i64>(&mut connection)
      .await
      .map_err(|error| error.to_string())?;
      Ok(())
    })
    .await
    .map_err(|_| "workspace membership Redis deadline".to_string())?
  }

  /// Remove only this startup instance's socket field. Other replicas and the
  /// observed-empty marker remain; a failed removal ages out at its lease.
  pub async fn leave_workspace(&self, workspace_id: Uuid, socket_id: &str) {
    let key = format!(
      "{}:{}",
      self.adapter.namespace(),
      keys::workspace_sessions(workspace_id)
    );
    let member = self.session_member(socket_id);
    let result = tokio::time::timeout(Duration::from_secs(5), async {
      let mut connection = self
        .adapter
        .command_connection()
        .await
        .map_err(|error| error.to_string())?;
      redis::Script::new(
        r#"
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'set' then redis.call('DEL', KEYS[1]); redis.call('HSET', KEYS[1], '__observed__', '1')
elseif kind == 'hash' then redis.call('HDEL', KEYS[1], ARGV[1])
elseif kind ~= 'none' then return redis.error_reply('invalid workspace membership type') end
return 1
"#,
      )
      .key(key)
      .arg(member)
      .invoke_async::<i64>(&mut connection)
      .await
      .map_err(|error| error.to_string())
    })
    .await;
    if !matches!(result, Ok(Ok(_))) {
      warn!(%workspace_id, "workspace membership removal unavailable; lease will expire");
    }
  }

  /// Read distinct live users for every observed workspace. Pruning and counting
  /// happen in one Lua operation, so stale cleanup cannot erase a renewal.
  /// Empty markers survive SQL failures and late positive writers; every later
  /// heartbeat can publish zero without a local socket or a crashed-node callback.
  pub async fn workspace_active_users(&self) -> Result<HashMap<Uuid, i32>, String> {
    tokio::time::timeout(Duration::from_secs(5), async {
      let prefix = format!("{}:ws:sessions:", self.adapter.namespace());
      let mut pattern = String::new();
      for character in prefix.chars() {
        if matches!(character, '*' | '?' | '[' | ']' | '\\') {
          pattern.push('\\');
        }
        pattern.push(character);
      }
      pattern.push('*');
      let mut connection = self
        .adapter
        .command_connection()
        .await
        .map_err(|error| error.to_string())?;
      let script = redis::Script::new(
        r#"
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'set' then redis.call('DEL', KEYS[1]); redis.call('HSET', KEYS[1], '__observed__', '1'); return 0 end
if kind == 'none' then return 0 end
if kind ~= 'hash' then return redis.error_reply('invalid workspace membership type') end
local now = tonumber(redis.call('TIME')[1])
local entries = redis.call('HGETALL', KEYS[1])
local users = {}
local count = 0
for index = 1, #entries, 2 do
  local field = entries[index]
  if field ~= '__observed__' then
    local user, expiry = string.match(entries[index + 1], '^([%x%-]+):(%d+)$')
    if user and tonumber(expiry) > now then
      if not users[user] then users[user] = true; count = count + 1 end
    else redis.call('HDEL', KEYS[1], field) end
  end
end
return count
"#,
      );
      let mut counts = HashMap::new();
      let mut cursor = 0u64;
      loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
          .arg(cursor)
          .arg("MATCH")
          .arg(&pattern)
          .arg("COUNT")
          .arg(200u32)
          .query_async(&mut connection)
          .await
          .map_err(|error| error.to_string())?;
        for key in keys {
          let Some(workspace_id) = key.strip_prefix(&prefix).and_then(|id| Uuid::parse_str(id).ok()) else {
            continue;
          };
          let count: i64 = script
            .key(key)
            .invoke_async(&mut connection)
            .await
            .map_err(|error| error.to_string())?;
          let count = i32::try_from(count).map_err(|_| "workspace user count overflow".to_string())?;
          counts.insert(workspace_id, count);
        }
        cursor = next;
        if cursor == 0 {
          break;
        }
      }
      Ok(counts)
    })
    .await
    .map_err(|_| "workspace analytics Redis deadline".to_string())?
  }

  /// Remove all workspace session entries for this instance's socket.
  ///
  /// Called on socket disconnect to clean up all workspace memberships.
  /// Iterates the local DashMap entries to find which workspaces the socket
  /// was in, then removes from Redis.
  pub async fn leave_all_workspaces(&self, socket_id: &str, workspace_ids: &[Uuid]) {
    for ws_id in workspace_ids {
      self.leave_workspace(*ws_id, socket_id).await;
    }
  }

  /// Publish a broadcast message to all instances subscribed to this workspace.
  ///
  /// The message is published on the Redis Pub/Sub channel
  /// `{namespace}:ws:broadcast:{workspace_id}`. The originating instance
  /// includes its `instance_id` so that the subscriber callback can skip
  /// local re-delivery (the local broadcast was already done via socketioxide).
  pub async fn broadcast_to_workspace(
    &self,
    workspace_id: &str,
    event: &str,
    payload: &serde_json::Value,
    sender_socket_id: &str,
  ) {
    if let Err(e) = self
      .try_broadcast_to_workspace(workspace_id, event, payload, sender_socket_id)
      .await
    {
      warn!(%workspace_id, %event, error = %e,
            "redis: failed to publish broadcast — remote instances will not receive this update");
    }
  }

  /// Publish one cross-instance event and return transport failures to callers
  /// that own durable retry state, such as the document-broadcast outbox.
  pub async fn try_broadcast_to_workspace(
    &self,
    workspace_id: &str,
    event: &str,
    payload: &serde_json::Value,
    sender_socket_id: &str,
  ) -> Result<(), String> {
    let message = CrossInstanceBroadcast {
      origin_instance: self.instance_id.to_string(),
      event: event.to_string(),
      workspace_id: workspace_id.to_string(),
      payload: payload.clone(),
      sender_socket_id: sender_socket_id.to_string(),
    };
    let receivers = publish_workspace_broadcast(&self.adapter, &message).await?;
    trace!(%workspace_id, %event, receivers, "redis: broadcast published");
    Ok(())
  }

  /// Publish an event that the originating API instance must consume too.
  ///
  /// Ordinary socket broadcasts are delivered locally before Redis and can
  /// suppress their own instance UUID. XWS workers do not own a local
  /// Socket.IO handle, so their transport origin deliberately sits outside
  /// the API-instance UUID namespace.
  pub async fn try_broadcast_to_all_workspace_instances(
    &self,
    workspace_id: &str,
    event: &str,
    payload: &serde_json::Value,
  ) -> Result<(), String> {
    let message = CrossInstanceBroadcast {
      origin_instance: "server:xws".to_string(),
      event: event.to_string(),
      workspace_id: workspace_id.to_string(),
      payload: payload.clone(),
      sender_socket_id: "server:xws".to_string(),
    };
    publish_workspace_broadcast(&self.adapter, &message).await?;
    Ok(())
  }

  fn user_notification_signal(
    user_id: Uuid,
    event_id: &str,
    event_type: &str,
    payload: &serde_json::Value,
  ) -> CrossInstanceBroadcast {
    CrossInstanceBroadcast {
      // A server-owned signal deliberately reaches the publisher's API too.
      origin_instance: "server:user-notification".to_string(),
      event: XWS_NOTIFICATION_REDIS_EVENT.to_string(),
      workspace_id: format!("user:{user_id}"),
      payload: serde_json::json!({ "eventId": event_id, "eventType": event_type, "payload": payload }),
      sender_socket_id: "server:user-notification".to_string(),
    }
  }

  /// Shared user transport. Unlike ordinary acceleration, the XWS outbox
  /// consumes errors here and retries; this method must never hide failures.
  pub async fn try_publish_user_notification_to_all_instances(
    &self,
    user_id: Uuid,
    event_id: &str,
    event_type: &str,
    payload: &serde_json::Value,
  ) -> Result<(), String> {
    let message = Self::user_notification_signal(user_id, event_id, event_type, payload);
    let channel = keys::broadcast_channel(self.adapter.namespace(), &message.workspace_id);
    let serialized = serde_json::to_string(&message).map_err(|error| error.to_string())?;
    self.publish(&channel, &serialized).await?;
    Ok(())
  }

  /// Store one Database presence record in a room-scoped Redis hash. Each
  /// record carries its own `lastActiveAt`; readers prune stale fields rather
  /// than relying on a room-wide TTL that an active user could keep alive.
  pub async fn upsert_database_presence(
    &self,
    workspace_id: Uuid,
    database_id: Uuid,
    socket_id: &str,
    payload: &serde_json::Value,
  ) {
    let key = keys::database_presence(workspace_id, database_id);
    let namespaced = format!("{}:{key}", self.adapter.namespace());
    let serialized = match serde_json::to_string(payload) {
      Ok(value) => value,
      Err(error) => {
        warn!(%workspace_id, %database_id, %socket_id, %error, "failed to serialize database presence");
        return;
      }
    };
    let mut connection = match self.adapter.command_connection().await {
      Ok(connection) => connection,
      Err(error) => {
        warn!(%workspace_id, %database_id, %socket_id, %error, "database presence Redis connection failed");
        return;
      }
    };
    if let Err(error) = connection.hset::<_, _, _, ()>(&namespaced, socket_id, serialized).await {
      warn!(%workspace_id, %database_id, %socket_id, %error, "database presence Redis write failed");
    }
  }

  pub async fn remove_database_presence(&self, workspace_id: Uuid, database_id: Uuid, socket_id: &str) {
    let key = keys::database_presence(workspace_id, database_id);
    let namespaced = format!("{}:{key}", self.adapter.namespace());
    let mut connection = match self.adapter.command_connection().await {
      Ok(connection) => connection,
      Err(error) => {
        warn!(%workspace_id, %database_id, %socket_id, %error, "database presence Redis connection failed");
        return;
      }
    };
    if let Err(error) = connection.hdel::<_, _, ()>(&namespaced, socket_id).await {
      warn!(%workspace_id, %database_id, %socket_id, %error, "database presence Redis removal failed");
    }
  }

  pub async fn list_database_presence(&self, workspace_id: Uuid, database_id: Uuid) -> Vec<serde_json::Value> {
    let key = keys::database_presence(workspace_id, database_id);
    let namespaced = format!("{}:{key}", self.adapter.namespace());
    let mut connection = match self.adapter.command_connection().await {
      Ok(connection) => connection,
      Err(error) => {
        warn!(%workspace_id, %database_id, %error, "database presence Redis connection failed");
        return Vec::new();
      }
    };
    let entries: std::collections::HashMap<String, String> = match connection.hgetall(&namespaced).await {
      Ok(entries) => entries,
      Err(error) => {
        warn!(%workspace_id, %database_id, %error, "database presence Redis read failed");
        return Vec::new();
      }
    };
    let now = chrono::Utc::now();
    let mut live = Vec::with_capacity(entries.len());
    let mut stale = Vec::new();
    for (socket_id, encoded) in entries {
      let Ok(payload) = serde_json::from_str::<serde_json::Value>(&encoded) else {
        stale.push(socket_id);
        continue;
      };
      let active = payload
        .get("lastActiveAt")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|last_active| {
          now
            .signed_duration_since(last_active.with_timezone(&chrono::Utc))
            .num_seconds()
            < 90
        });
      if active {
        live.push(payload);
      } else {
        stale.push(socket_id);
      }
    }
    if !stale.is_empty()
      && let Err(error) = connection.hdel::<_, _, ()>(&namespaced, stale).await
    {
      warn!(%workspace_id, %database_id, %error, "database presence stale cleanup failed");
    }
    live
  }

  /// Check if a notification event has already been acknowledged (cross-instance).
  ///
  /// Uses a simple key existence check with the event ID.
  pub async fn is_notification_acked(&self, event_id: &str) -> bool {
    let key = keys::notification_ack(event_id);
    match self.exists(&key).await {
      Ok(exists) => exists,
      Err(e) => {
        warn!(event_id, error = %e,
                    "redis: failed to check notification ack — assuming not acked");
        false
      }
    }
  }

  /// Mark a notification event as acknowledged (cross-instance).
  ///
  /// Sets a key with a 24h TTL so ack records auto-expire.
  pub async fn ack_notification(&self, event_id: &str) {
    let key = keys::notification_ack(event_id);
    match self.set_with_ttl(&key, "1", NOTIFICATION_ACK_TTL_SECONDS).await {
      Ok(_) => {
        trace!(event_id, "redis: notification ack recorded");
      }
      Err(e) => {
        warn!(event_id, error = %e,
                    "redis: failed to record notification ack — local ack still valid");
      }
    }
  }

  /// P84-E-03: Channel capacity for cross-instance broadcast forwarding.
  /// 10,000 messages provides ~10s of buffer at 1000 msg/s. If the consumer
  /// falls behind, messages are dropped with a warning (backpressure signal).
  const BROADCAST_CHANNEL_CAPACITY: usize = 10_000;

  /// Start the Pub/Sub subscription listener for workspace broadcasts.
  ///
  /// Spawns a background tokio task that subscribes to workspace broadcast
  /// channels using Redis Pub/Sub pattern matching. When a message arrives
  /// from another instance, it is forwarded through the returned channel.
  ///
  /// The caller (websocket init) should spawn a task that reads from the
  /// returned receiver and dispatches to local socketioxide rooms.
  ///
  /// Returns a receiver for cross-instance broadcast messages. Messages from
  /// the injected local process identity are filtered out.
  pub async fn start_subscriber(&self) -> Result<mpsc::Receiver<CrossInstanceBroadcast>, String> {
    let (tx, rx) = mpsc::channel(Self::BROADCAST_CHANNEL_CAPACITY);
    let client = self.adapter.client().clone();
    let pattern = format!("{}:ws:broadcast:*", self.adapter.namespace());
    let instance_id = self.instance_id;
    let namespace = self.adapter.namespace().to_string();

    tokio::spawn(async move {
      info!(pattern = %pattern, "redis pubsub: starting workspace broadcast subscriber");
      loop {
        match client.get_async_pubsub().await {
          Ok(mut pubsub) => {
            if let Err(e) = pubsub.psubscribe(&pattern).await {
              error!(error = %e, "redis pubsub: failed to subscribe — retrying in 5s");
              tokio::time::sleep(std::time::Duration::from_secs(5)).await;
              continue;
            }
            info!(pattern = %pattern, "redis pubsub: subscribed to workspace broadcasts");

            loop {
              let msg = pubsub.on_message().next().await;
              match msg {
                Some(msg) => {
                  let payload: String = match msg.get_payload() {
                    Ok(p) => p,
                    Err(e) => {
                      warn!(error = %e, "redis pubsub: invalid message payload");
                      continue;
                    }
                  };
                  let broadcast: CrossInstanceBroadcast = match serde_json::from_str(&payload) {
                    Ok(b) => b,
                    Err(e) => {
                      warn!(error = %e, "redis pubsub: malformed broadcast JSON");
                      continue;
                    }
                  };
                  if msg.get_channel_name() != keys::broadcast_channel(&namespace, &broadcast.workspace_id) {
                    continue;
                  }
                  // Skip messages from this instance — already handled locally.
                  if !Self::should_forward(instance_id, &broadcast) {
                    trace!("redis pubsub: skipping self-originated broadcast");
                    continue;
                  }
                  debug!(
                      workspace_id = %broadcast.workspace_id,
                      event = %broadcast.event,
                      origin = %broadcast.origin_instance,
                      "redis pubsub: received cross-instance broadcast"
                  );
                  // P84-E-03: Use try_send on bounded channel. If full,
                  // log a warning (backpressure) but don't block the subscriber.
                  match tx.try_send(broadcast) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(_)) => {
                      warn!(
                        "redis pubsub: broadcast channel full (capacity {}), dropping message — consumer is falling behind",
                        Self::BROADCAST_CHANNEL_CAPACITY,
                      );
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                      info!("redis pubsub: receiver dropped — stopping subscriber");
                      return;
                    }
                  }
                }
                None => {
                  warn!("redis pubsub: message stream ended — reconnecting in 2s");
                  tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                  break; // Break inner loop to reconnect
                }
              }
            }
          }
          Err(e) => {
            error!(error = %e, "redis pubsub: connection failed — retrying in 5s");
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
          }
        }
      }
    });

    Ok(rx)
  }

  // ---- Low-level Redis helpers (namespaced via the adapter) ----

  async fn exists(&self, key: &str) -> Result<bool, String> {
    let namespaced = format!("{}:{}", self.adapter.namespace(), key);
    let mut conn = self
      .adapter
      .command_connection()
      .await
      .map_err(|e| format!("redis connection: {e}"))?;
    conn.exists(&namespaced).await.map_err(|e| format!("redis EXISTS: {e}"))
  }

  async fn set_with_ttl(&self, key: &str, value: &str, ttl_seconds: u64) -> Result<(), String> {
    let namespaced = format!("{}:{}", self.adapter.namespace(), key);
    let mut conn = self
      .adapter
      .command_connection()
      .await
      .map_err(|e| format!("redis connection: {e}"))?;
    conn
      .set_ex::<_, _, ()>(&namespaced, value, ttl_seconds)
      .await
      .map_err(|e| format!("redis SET EX: {e}"))
  }

  async fn publish(&self, channel: &str, message: &str) -> Result<usize, String> {
    let mut conn = self
      .adapter
      .command_connection()
      .await
      .map_err(|e| format!("redis connection: {e}"))?;
    conn
      .publish(channel, message)
      .await
      .map_err(|e| format!("redis PUBLISH: {e}"))
  }
}

/// Use Futures for the pubsub `.on_message().next()` call.
use futures_util::StreamExt;

#[cfg(test)]
mod tests {
  use super::*;

  fn adapter(instance_id: Uuid) -> RedisWsAdapter {
    RedisWsAdapter::new(
      instance_id,
      Arc::new(RedisAdapter::new("redis://127.0.0.1:1", "node-identity-test").expect("valid lazy Redis client")),
    )
  }

  #[test]
  fn injected_process_identity_scopes_sessions_and_self_suppression() {
    let first_id = Uuid::new_v4();
    let second_id = Uuid::new_v4();
    let first = adapter(first_id);
    let second = adapter(second_id);
    let socket_id = "same-socket-id";
    let first_broadcast = CrossInstanceBroadcast {
      origin_instance: first_id.to_string(),
      event: "space:broadcast-doc-update".to_string(),
      workspace_id: Uuid::new_v4().to_string(),
      payload: serde_json::json!({}),
      sender_socket_id: socket_id.to_string(),
    };

    assert_ne!(
      first.session_member(socket_id),
      second.session_member(socket_id),
      "separate processes must never collide even when their socket IDs and hostnames match"
    );
    assert!(
      !RedisWsAdapter::should_forward(first_id, &first_broadcast),
      "the publisher must suppress its own Redis echo"
    );
    assert!(
      RedisWsAdapter::should_forward(second_id, &first_broadcast),
      "another process must treat the same message as remote"
    );
    let xws_broadcast = CrossInstanceBroadcast {
      origin_instance: "server:xws".to_string(),
      event: myoxus_application::workspace_content_operation::coordination::WORKSPACE_CONTENT_SYNC_RECONNECT_EVENT
        .to_string(),
      ..first_broadcast
    };
    assert!(
      RedisWsAdapter::should_forward(first_id, &xws_broadcast)
        && RedisWsAdapter::should_forward(second_id, &xws_broadcast),
      "worker-owned reconnect signals must reach every API instance, including the worker's colocated API"
    );
  }
}
