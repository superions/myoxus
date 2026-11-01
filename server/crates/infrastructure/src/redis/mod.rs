//! Redis adapters: a real [`RedisAdapter`] backed by `redis-rs` and an
//! [`InMemoryRedisAdapter`] for tests.
//!
//! Both adapters implement [`RedisPort`] and [`DistributedLockPort`].  All
//! keys are automatically namespaced with a configurable prefix to avoid
//! collisions across environments.

pub mod workspace_broadcast;

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use redis::AsyncCommands;
use tokio::sync::{OnceCell, RwLock};
use tracing::{debug, instrument, trace};

use myoxus_application::ports::{DistributedLockPort, PortError, PortResult, RedisPort};

/// Production Redis adapter backed by one shared, reconnecting command
/// connection per configured Redis role.
///
/// All keys are stored under `<namespace>:<key>`.  Distributed locks use
/// `<namespace>:lock:<key>`.
#[derive(Clone)]
pub struct RedisAdapter {
  /// Underlying `redis-rs` client (connects lazily).
  client: redis::Client,
  /// Lazily initialized command connection shared by every adapter clone.
  ///
  /// Pub/Sub subscribers intentionally use dedicated connections through
  /// [`Self::client`]; sharing those with commands would let subscription mode
  /// interfere with unrelated Redis operations.
  command_connection: Arc<OnceCell<redis::aio::ConnectionManager>>,
  /// Key namespace prefix.
  namespace: String,
}

impl fmt::Debug for RedisAdapter {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter
      .debug_struct("RedisAdapter")
      .field("namespace", &self.namespace)
      .field("command_connection_initialized", &self.command_connection.initialized())
      .finish_non_exhaustive()
  }
}

impl RedisAdapter {
  /// Construct a `RedisAdapter`.  Validates the URL immediately.
  ///
  /// Returns an error if `url` cannot be parsed as a valid Redis URL.
  pub fn new(url: impl Into<String>, namespace: impl Into<String>) -> PortResult<Self> {
    let client = crate::tls::redis::client(&url.into(), None).map_err(PortError::InvalidInput)?;
    Ok(Self::from_client(client, namespace))
  }

  /// Compose a role adapter from a bootstrap-configured client. Dedicated
  /// Pub/Sub connections clone this client and retain its trust on reconnect.
  pub fn from_client(client: redis::Client, namespace: impl Into<String>) -> Self {
    Self {
      client,
      command_connection: Arc::new(OnceCell::new()),
      namespace: namespace.into(),
    }
  }

  fn namespaced_key(&self, key: &str) -> String {
    format!("{}:{}", self.namespace, key)
  }

  fn namespaced_pattern(&self, pattern: &str) -> String {
    let mut namespace = String::with_capacity(self.namespace.len());
    for character in self.namespace.chars() {
      if matches!(character, '*' | '?' | '[' | ']' | '\\') {
        namespace.push('\\');
      }
      namespace.push(character);
    }
    format!("{namespace}:{pattern}")
  }

  async fn connection(&self) -> PortResult<redis::aio::ConnectionManager> {
    self.command_connection().await
  }

  /// Return a clone of the role-scoped command connection.
  ///
  /// The first caller establishes the connection. Concurrent and later
  /// callers reuse the same multiplexed transport, and `redis-rs` reconnects
  /// it after a dropped connection. Failed initialization is not cached, so a
  /// subsequent command can recover after Redis becomes reachable.
  pub async fn command_connection(&self) -> PortResult<redis::aio::ConnectionManager> {
    let manager = self
      .command_connection
      .get_or_try_init(|| async {
        // Preserve fail-fast command semantics. Reconnection stays automatic,
        // but an outage is not hidden behind an internal multi-second loop.
        let config = redis::aio::ConnectionManagerConfig::new().set_number_of_retries(0);
        self.client.get_connection_manager_with_config(config).await
      })
      .await
      .map_err(|err| PortError::Transport(format!("redis connection failed: {err}")))?;
    Ok(manager.clone())
  }

  /// Access the underlying `redis::Client` for operations that need a
  /// dedicated connection (e.g. Pub/Sub subscriptions).
  pub fn client(&self) -> &redis::Client {
    &self.client
  }

  /// Return the configured namespace prefix.
  pub fn namespace(&self) -> &str {
    &self.namespace
  }

  /// Send a `PING` command to verify Redis connectivity.
  #[instrument(skip(self))]
  pub async fn ping(&self) -> PortResult<()> {
    let mut conn = self.connection().await?;
    redis::cmd("PING")
      .query_async::<String>(&mut conn)
      .await
      .map_err(|err| PortError::Transport(format!("redis ping failed: {err}")))?;
    Ok(())
  }
}

#[async_trait]
impl RedisPort for RedisAdapter {
  #[instrument(skip(self))]
  async fn get_string(&self, key: &str) -> PortResult<Option<String>> {
    let namespaced = self.namespaced_key(key);
    trace!(key = %namespaced, "redis get string");
    let mut conn = self.connection().await?;
    conn
      .get(namespaced)
      .await
      .map_err(|err| PortError::Transport(format!("redis get failed: {err}")))
  }

  #[instrument(skip(self, value))]
  async fn set_string(&self, key: &str, value: &str, ttl_seconds: Option<u64>) -> PortResult<()> {
    let namespaced = self.namespaced_key(key);
    debug!(key = %namespaced, ttl_seconds = ?ttl_seconds, "redis set string");
    let mut conn = self.connection().await?;
    if let Some(ttl_seconds) = ttl_seconds {
      redis::cmd("SET")
        .arg(&namespaced)
        .arg(value)
        .arg("EX")
        .arg(ttl_seconds)
        .query_async::<()>(&mut conn)
        .await
        .map_err(|err| PortError::Transport(format!("redis set with ttl failed: {err}")))?;
    } else {
      conn
        .set::<_, _, ()>(namespaced, value)
        .await
        .map_err(|err| PortError::Transport(format!("redis set failed: {err}")))?;
    }
    Ok(())
  }

  #[instrument(skip(self))]
  async fn delete_key(&self, key: &str) -> PortResult<()> {
    let namespaced = self.namespaced_key(key);
    trace!(key = %namespaced, "redis delete key");
    let mut conn = self.connection().await?;
    conn
      .del::<_, usize>(namespaced)
      .await
      .map_err(|err| PortError::Transport(format!("redis delete failed: {err}")))?;
    Ok(())
  }

  #[instrument(skip(self, value))]
  async fn setnx_string(&self, key: &str, value: &str, ttl_seconds: Option<u64>) -> PortResult<bool> {
    let namespaced = self.namespaced_key(key);
    let mut conn = self.connection().await?;
    let response = if let Some(ttl_seconds) = ttl_seconds {
      redis::cmd("SET")
        .arg(&namespaced)
        .arg(value)
        .arg("NX")
        .arg("EX")
        .arg(ttl_seconds)
        .query_async::<Option<String>>(&mut conn)
        .await
        .map_err(|err| PortError::Transport(format!("redis setnx with ttl failed: {err}")))?
    } else {
      redis::cmd("SET")
        .arg(&namespaced)
        .arg(value)
        .arg("NX")
        .query_async::<Option<String>>(&mut conn)
        .await
        .map_err(|err| PortError::Transport(format!("redis setnx failed: {err}")))?
    };
    Ok(response.as_deref() == Some("OK"))
  }

  #[instrument(skip_all)]
  async fn compare_and_set(
    &self,
    key: &str,
    expected_value: Option<&str>,
    value: &str,
    ttl_seconds: u64,
  ) -> PortResult<bool> {
    let mut conn = self.connection().await?;
    let script = redis::Script::new(
      "local current = redis.call('get', KEYS[1]); \
       if (ARGV[1] == 'absent' and not current) or (ARGV[1] == 'present' and current == ARGV[2]) then \
         redis.call('set', KEYS[1], ARGV[3], 'EX', ARGV[4]); return 1; \
       end; return 0;",
    );
    let changed: i64 = script
      .key(self.namespaced_key(key))
      .arg(if expected_value.is_some() { "present" } else { "absent" })
      .arg(expected_value.unwrap_or_default())
      .arg(value)
      .arg(ttl_seconds.max(1))
      .invoke_async(&mut conn)
      .await
      .map_err(|error| PortError::Transport(format!("redis epoch comparison failed: {error}")))?;
    Ok(changed == 1)
  }

  #[instrument(skip(self, expected_value))]
  async fn compare_and_delete(&self, key: &str, expected_value: &str) -> PortResult<bool> {
    let namespaced = self.namespaced_key(key);
    let mut conn = self.connection().await?;
    // Atomic compare-and-delete via Lua: read current value, compare to
    // expected, DEL only on match. Eliminates the SETNX/DEL ABA race where
    // an expired-then-reacquired lock would be deleted by the original holder.
    let script = redis::Script::new(
      "if redis.call('get', KEYS[1]) == ARGV[1] then \
         return redis.call('del', KEYS[1]) \
       else \
         return 0 \
       end",
    );
    let deleted: i64 = script
      .key(&namespaced)
      .arg(expected_value)
      .invoke_async(&mut conn)
      .await
      .map_err(|err| PortError::Transport(format!("redis compare_and_delete failed: {err}")))?;
    Ok(deleted == 1)
  }

  #[instrument(skip(self, expected_value))]
  async fn compare_and_refresh(&self, key: &str, expected_value: &str, ttl_seconds: u64) -> PortResult<bool> {
    let namespaced = self.namespaced_key(key);
    let mut conn = self.connection().await?;
    // Atomic compare-and-refresh via Lua: read current value, compare to
    // expected, EXPIRE only on match. Used by the lock heartbeat so we never
    // extend a foreign lock that took over after our TTL expired.
    let script = redis::Script::new(
      "if redis.call('get', KEYS[1]) == ARGV[1] then \
         return redis.call('expire', KEYS[1], ARGV[2]) \
       else \
         return 0 \
       end",
    );
    let refreshed: i64 = script
      .key(&namespaced)
      .arg(expected_value)
      .arg(ttl_seconds as i64)
      .invoke_async(&mut conn)
      .await
      .map_err(|err| PortError::Transport(format!("redis compare_and_refresh failed: {err}")))?;
    Ok(refreshed == 1)
  }

  #[instrument(skip(self))]
  async fn has_key(&self, key: &str) -> PortResult<bool> {
    let namespaced = self.namespaced_key(key);
    let mut conn = self.connection().await?;
    let exists = conn
      .exists::<_, usize>(namespaced)
      .await
      .map_err(|err| PortError::Transport(format!("redis exists failed: {err}")))?;
    Ok(exists > 0)
  }

  #[instrument(skip(self))]
  async fn ttl_seconds(&self, key: &str) -> PortResult<Option<u64>> {
    let namespaced = self.namespaced_key(key);
    let mut conn = self.connection().await?;
    let ttl = conn
      .ttl::<_, i64>(namespaced)
      .await
      .map_err(|err| PortError::Transport(format!("redis ttl failed: {err}")))?;
    Ok((ttl > 0).then_some(ttl as u64))
  }

  #[instrument(skip(self))]
  async fn expire_key(&self, key: &str, ttl_seconds: u64) -> PortResult<bool> {
    let namespaced = self.namespaced_key(key);
    let mut conn = self.connection().await?;
    let changed = conn
      .expire::<_, bool>(namespaced, ttl_seconds as i64)
      .await
      .map_err(|err| PortError::Transport(format!("redis expire failed: {err}")))?;
    Ok(changed)
  }

  #[instrument(skip(self))]
  async fn increase(&self, key: &str, count: i64) -> PortResult<i64> {
    let namespaced = self.namespaced_key(key);
    let mut conn = self.connection().await?;
    conn
      .incr::<_, _, i64>(namespaced, count)
      .await
      .map_err(|err| PortError::Transport(format!("redis incr failed: {err}")))
  }

  #[instrument(skip(self))]
  async fn decrease(&self, key: &str, count: i64) -> PortResult<i64> {
    self.increase(key, -count).await
  }

  #[instrument(skip(self, values))]
  async fn list_push_back(&self, key: &str, values: &[String]) -> PortResult<usize> {
    let namespaced = self.namespaced_key(key);
    let mut conn = self.connection().await?;
    conn
      .rpush::<_, _, usize>(namespaced, values)
      .await
      .map_err(|err| PortError::Transport(format!("redis rpush failed: {err}")))
  }

  #[instrument(skip(self, values))]
  async fn list_push_front(&self, key: &str, values: &[String]) -> PortResult<usize> {
    let namespaced = self.namespaced_key(key);
    let mut conn = self.connection().await?;
    conn
      .lpush::<_, _, usize>(namespaced, values)
      .await
      .map_err(|err| PortError::Transport(format!("redis lpush failed: {err}")))
  }

  #[instrument(skip(self))]
  async fn list_len(&self, key: &str) -> PortResult<usize> {
    let namespaced = self.namespaced_key(key);
    let mut conn = self.connection().await?;
    conn
      .llen::<_, usize>(namespaced)
      .await
      .map_err(|err| PortError::Transport(format!("redis llen failed: {err}")))
  }

  #[instrument(skip(self))]
  async fn list_range(&self, key: &str, start: isize, end: isize) -> PortResult<Vec<String>> {
    let namespaced = self.namespaced_key(key);
    let mut conn = self.connection().await?;
    conn
      .lrange::<_, Vec<String>>(namespaced, start, end)
      .await
      .map_err(|err| PortError::Transport(format!("redis lrange failed: {err}")))
  }

  #[instrument(skip(self))]
  async fn list_pop_front(&self, key: &str, count: usize) -> PortResult<Vec<String>> {
    if count == 0 {
      return Ok(Vec::new());
    }
    let namespaced = self.namespaced_key(key);
    let mut conn = self.connection().await?;
    let mut values = Vec::new();
    for _ in 0..count {
      let value = redis::cmd("LPOP")
        .arg(&namespaced)
        .query_async::<Option<String>>(&mut conn)
        .await
        .map_err(|err| PortError::Transport(format!("redis lpop failed: {err}")))?;
      let Some(value) = value else {
        break;
      };
      values.push(value);
    }
    Ok(values)
  }

  #[instrument(skip(self))]
  async fn list_pop_back(&self, key: &str, count: usize) -> PortResult<Vec<String>> {
    if count == 0 {
      return Ok(Vec::new());
    }
    let namespaced = self.namespaced_key(key);
    let mut conn = self.connection().await?;
    let mut values = Vec::new();
    for _ in 0..count {
      let value = redis::cmd("RPOP")
        .arg(&namespaced)
        .query_async::<Option<String>>(&mut conn)
        .await
        .map_err(|err| PortError::Transport(format!("redis rpop failed: {err}")))?;
      let Some(value) = value else {
        break;
      };
      values.push(value);
    }
    Ok(values)
  }

  #[instrument(skip(self, value))]
  async fn hash_set_string(&self, map: &str, field: &str, value: &str) -> PortResult<bool> {
    let namespaced = self.namespaced_key(map);
    let mut conn = self.connection().await?;
    let changed = conn
      .hset::<_, _, _, usize>(namespaced, field, value)
      .await
      .map_err(|err| PortError::Transport(format!("redis hset failed: {err}")))?;
    Ok(changed > 0)
  }

  #[instrument(skip(self))]
  async fn hash_get_string(&self, map: &str, field: &str) -> PortResult<Option<String>> {
    let namespaced = self.namespaced_key(map);
    let mut conn = self.connection().await?;
    conn
      .hget::<_, _, Option<String>>(namespaced, field)
      .await
      .map_err(|err| PortError::Transport(format!("redis hget failed: {err}")))
  }

  #[instrument(skip(self))]
  async fn hash_delete_key(&self, map: &str, field: &str) -> PortResult<bool> {
    let namespaced = self.namespaced_key(map);
    let mut conn = self.connection().await?;
    let changed = conn
      .hdel::<_, _, usize>(namespaced, field)
      .await
      .map_err(|err| PortError::Transport(format!("redis hdel failed: {err}")))?;
    Ok(changed > 0)
  }

  #[instrument(skip(self))]
  async fn hash_keys(&self, map: &str) -> PortResult<Vec<String>> {
    let namespaced = self.namespaced_key(map);
    let mut conn = self.connection().await?;
    conn
      .hkeys::<_, Vec<String>>(namespaced)
      .await
      .map_err(|err| PortError::Transport(format!("redis hkeys failed: {err}")))
  }

  #[instrument(skip(self))]
  async fn hash_random_key(&self, map: &str) -> PortResult<Option<String>> {
    let namespaced = self.namespaced_key(map);
    let mut conn = self.connection().await?;
    redis::cmd("HRANDFIELD")
      .arg(&namespaced)
      .query_async::<Option<String>>(&mut conn)
      .await
      .map_err(|err| PortError::Transport(format!("redis hrandfield failed: {err}")))
  }

  #[instrument(skip(self))]
  async fn hash_len(&self, map: &str) -> PortResult<usize> {
    let namespaced = self.namespaced_key(map);
    let mut conn = self.connection().await?;
    conn
      .hlen::<_, usize>(namespaced)
      .await
      .map_err(|err| PortError::Transport(format!("redis hlen failed: {err}")))
  }

  #[instrument(skip(self))]
  async fn hash_increase(&self, map: &str, field: &str, count: i64) -> PortResult<i64> {
    let namespaced = self.namespaced_key(map);
    let mut conn = self.connection().await?;
    redis::cmd("HINCRBY")
      .arg(&namespaced)
      .arg(field)
      .arg(count)
      .query_async::<i64>(&mut conn)
      .await
      .map_err(|err| PortError::Transport(format!("redis hincrby failed: {err}")))
  }

  #[instrument(skip(self))]
  async fn hash_decrease(&self, map: &str, field: &str, count: i64) -> PortResult<i64> {
    self.hash_increase(map, field, -count).await
  }

  /// Scan for logical keys matching `pattern` and delete them in batches.
  ///
  /// [`RedisPort`] callers never include this adapter's role namespace. The
  /// adapter applies it once before `SCAN`, matching every other key method
  /// and preventing a bulk cleanup from reaching another Redis role.
  #[instrument(skip(self))]
  async fn delete_by_pattern(&self, pattern: &str) -> PortResult<usize> {
    let namespaced_pattern = self.namespaced_pattern(pattern);
    debug!(logical_pattern = %pattern, redis_pattern = %namespaced_pattern, "redis delete_by_pattern");
    let mut conn = self.connection().await?;
    let mut cursor: u64 = 0;
    let mut total_deleted: usize = 0;
    loop {
      let (next_cursor, keys): (u64, Vec<String>) = redis::cmd("SCAN")
        .arg(cursor)
        .arg("MATCH")
        .arg(&namespaced_pattern)
        .arg("COUNT")
        .arg(100u64)
        .query_async(&mut conn)
        .await
        .map_err(|err| PortError::Transport(format!("redis scan failed: {err}")))?;
      if !keys.is_empty() {
        let count = conn
          .del::<_, usize>(&keys)
          .await
          .map_err(|err| PortError::Transport(format!("redis del failed: {err}")))?;
        total_deleted += count;
      }
      cursor = next_cursor;
      if cursor == 0 {
        break;
      }
    }
    debug!(logical_pattern = %pattern, redis_pattern = %namespaced_pattern, total_deleted, "redis delete_by_pattern complete");
    Ok(total_deleted)
  }
}

#[async_trait]
impl DistributedLockPort for RedisAdapter {
  #[instrument(skip(self))]
  async fn acquire(&self, key: &str, ttl_seconds: u64) -> PortResult<bool> {
    let namespaced = self.namespaced_key(&format!("lock:{key}"));
    let mut conn = self.connection().await?;
    let response = redis::cmd("SET")
      .arg(&namespaced)
      .arg("1")
      .arg("NX")
      .arg("EX")
      .arg(ttl_seconds)
      .query_async::<Option<String>>(&mut conn)
      .await
      .map_err(|err| PortError::Transport(format!("redis lock acquire failed: {err}")))?;
    Ok(response.as_deref() == Some("OK"))
  }

  #[instrument(skip(self))]
  async fn release(&self, key: &str) -> PortResult<()> {
    let namespaced = self.namespaced_key(&format!("lock:{key}"));
    let mut conn = self.connection().await?;
    conn
      .del::<_, usize>(namespaced)
      .await
      .map_err(|err| PortError::Transport(format!("redis lock release failed: {err}")))?;
    Ok(())
  }
}

/// All state held by the in-memory Redis adapter.
#[derive(Debug, Default)]
struct InMemoryRedisState {
  /// Simple string key-value pairs.
  kv: HashMap<String, String>,
  /// Integer counters (separate from string KV to match Redis semantics).
  counters: HashMap<String, i64>,
  /// Lists (FIFO/LIFO queues).
  lists: HashMap<String, VecDeque<String>>,
  /// Hash maps.
  hashes: HashMap<String, HashMap<String, String>>,
  /// TTL expiration times, keyed by the fully-namespaced key.
  expirations: HashMap<String, Instant>,
}

/// In-memory [`RedisPort`] + [`DistributedLockPort`] implementation for tests.
///
/// Behaviour mirrors real Redis including TTL expiry (lazily checked on
/// access) and `SETNX` semantics.  Not suitable for production use.
#[derive(Debug, Clone, Default)]
pub struct InMemoryRedisAdapter {
  /// Key namespace prefix.
  namespace: String,
  /// Shared state protected by a tokio `RwLock`.
  state: Arc<RwLock<InMemoryRedisState>>,
  /// Distributed lock state (expiration times keyed by namespaced lock key).
  locks: Arc<RwLock<HashMap<String, Instant>>>,
}

impl InMemoryRedisAdapter {
  /// Construct an `InMemoryRedisAdapter` with the given namespace prefix.
  pub fn new(namespace: impl Into<String>) -> Self {
    Self {
      namespace: namespace.into(),
      state: Arc::new(RwLock::new(InMemoryRedisState::default())),
      locks: Arc::new(RwLock::new(HashMap::new())),
    }
  }

  fn namespaced_key(&self, key: &str) -> String {
    format!("{}:{}", self.namespace, key)
  }

  fn lock_key(&self, key: &str) -> String {
    self.namespaced_key(&format!("lock:{key}"))
  }

  fn purge_if_expired(state: &mut InMemoryRedisState, key: &str) {
    if state
      .expirations
      .get(key)
      .copied()
      .map(|at| at <= Instant::now())
      .unwrap_or(false)
    {
      state.expirations.remove(key);
      state.kv.remove(key);
      state.counters.remove(key);
      state.lists.remove(key);
      state.hashes.remove(key);
    }
  }

  fn set_expiration(state: &mut InMemoryRedisState, key: &str, ttl_seconds: Option<u64>) {
    if let Some(ttl_seconds) = ttl_seconds {
      state
        .expirations
        .insert(key.to_string(), Instant::now() + Duration::from_secs(ttl_seconds));
    } else {
      state.expirations.remove(key);
    }
  }

  fn list_range(values: &VecDeque<String>, start: isize, end: isize) -> Vec<String> {
    if values.is_empty() {
      return Vec::new();
    }
    let len = values.len() as isize;
    let norm = |idx: isize| if idx < 0 { len + idx } else { idx };
    let start = norm(start).max(0);
    let end = norm(end).min(len - 1);
    if start > end || start >= len {
      return Vec::new();
    }
    (start..=end)
      .filter_map(|idx| values.get(idx as usize).cloned())
      .collect()
  }
}

#[async_trait]
impl RedisPort for InMemoryRedisAdapter {
  #[instrument(skip(self))]
  async fn get_string(&self, key: &str) -> PortResult<Option<String>> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    Ok(state.kv.get(&key).cloned())
  }

  #[instrument(skip(self, value))]
  async fn set_string(&self, key: &str, value: &str, ttl_seconds: Option<u64>) -> PortResult<()> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    state.kv.insert(key.clone(), value.to_string());
    Self::set_expiration(&mut state, &key, ttl_seconds);
    Ok(())
  }

  #[instrument(skip(self))]
  async fn delete_key(&self, key: &str) -> PortResult<()> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    state.kv.remove(&key);
    state.counters.remove(&key);
    state.lists.remove(&key);
    state.hashes.remove(&key);
    state.expirations.remove(&key);
    Ok(())
  }

  #[instrument(skip(self, value))]
  async fn setnx_string(&self, key: &str, value: &str, ttl_seconds: Option<u64>) -> PortResult<bool> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    if state.kv.contains_key(&key)
      || state.counters.contains_key(&key)
      || state.lists.contains_key(&key)
      || state.hashes.contains_key(&key)
    {
      return Ok(false);
    }
    state.kv.insert(key.clone(), value.to_string());
    Self::set_expiration(&mut state, &key, ttl_seconds);
    Ok(true)
  }

  #[instrument(skip_all)]
  async fn compare_and_set(
    &self,
    key: &str,
    expected_value: Option<&str>,
    value: &str,
    ttl_seconds: u64,
  ) -> PortResult<bool> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    if state.kv.get(&key).map(String::as_str) != expected_value {
      return Ok(false);
    }
    state.kv.insert(key.clone(), value.to_string());
    Self::set_expiration(&mut state, &key, Some(ttl_seconds.max(1)));
    Ok(true)
  }

  #[instrument(skip(self, expected_value))]
  async fn compare_and_delete(&self, key: &str, expected_value: &str) -> PortResult<bool> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    match state.kv.get(&key) {
      Some(actual) if actual == expected_value => {
        state.kv.remove(&key);
        state.expirations.remove(&key);
        Ok(true)
      }
      _ => Ok(false),
    }
  }

  #[instrument(skip(self, expected_value))]
  async fn compare_and_refresh(&self, key: &str, expected_value: &str, ttl_seconds: u64) -> PortResult<bool> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    match state.kv.get(&key) {
      Some(actual) if actual == expected_value => {
        Self::set_expiration(&mut state, &key, Some(ttl_seconds.max(1)));
        Ok(true)
      }
      _ => Ok(false),
    }
  }

  #[instrument(skip(self))]
  async fn has_key(&self, key: &str) -> PortResult<bool> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    Ok(
      state.kv.contains_key(&key)
        || state.counters.contains_key(&key)
        || state.lists.contains_key(&key)
        || state.hashes.contains_key(&key),
    )
  }

  #[instrument(skip(self))]
  async fn ttl_seconds(&self, key: &str) -> PortResult<Option<u64>> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    if let Some(expires_at) = state.expirations.get(&key).copied() {
      let remaining = expires_at.saturating_duration_since(Instant::now()).as_secs();
      return Ok(Some(remaining.max(1)));
    }
    Ok(None)
  }

  #[instrument(skip(self))]
  async fn expire_key(&self, key: &str, ttl_seconds: u64) -> PortResult<bool> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    let exists = state.kv.contains_key(&key)
      || state.counters.contains_key(&key)
      || state.lists.contains_key(&key)
      || state.hashes.contains_key(&key);
    if !exists {
      return Ok(false);
    }
    Self::set_expiration(&mut state, &key, Some(ttl_seconds.max(1)));
    Ok(true)
  }

  #[instrument(skip(self))]
  async fn increase(&self, key: &str, count: i64) -> PortResult<i64> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    let current = *state.counters.get(&key).unwrap_or(&0);
    let next = current.saturating_add(count);
    state.counters.insert(key, next);
    Ok(next)
  }

  #[instrument(skip(self))]
  async fn decrease(&self, key: &str, count: i64) -> PortResult<i64> {
    self.increase(key, -count).await
  }

  #[instrument(skip(self, values))]
  async fn list_push_back(&self, key: &str, values: &[String]) -> PortResult<usize> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    let list = state.lists.entry(key).or_default();
    for value in values {
      list.push_back(value.clone());
    }
    Ok(list.len())
  }

  #[instrument(skip(self, values))]
  async fn list_push_front(&self, key: &str, values: &[String]) -> PortResult<usize> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    let list = state.lists.entry(key).or_default();
    for value in values {
      list.push_front(value.clone());
    }
    Ok(list.len())
  }

  #[instrument(skip(self))]
  async fn list_len(&self, key: &str) -> PortResult<usize> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    Ok(state.lists.get(&key).map(|list| list.len()).unwrap_or(0))
  }

  #[instrument(skip(self))]
  async fn list_range(&self, key: &str, start: isize, end: isize) -> PortResult<Vec<String>> {
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    let Some(values) = state.lists.get(&key) else {
      return Ok(Vec::new());
    };
    Ok(Self::list_range(values, start, end))
  }

  #[instrument(skip(self))]
  async fn list_pop_front(&self, key: &str, count: usize) -> PortResult<Vec<String>> {
    if count == 0 {
      return Ok(Vec::new());
    }
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    let Some(list) = state.lists.get_mut(&key) else {
      return Ok(Vec::new());
    };
    let mut result = Vec::new();
    for _ in 0..count {
      let Some(value) = list.pop_front() else {
        break;
      };
      result.push(value);
    }
    Ok(result)
  }

  #[instrument(skip(self))]
  async fn list_pop_back(&self, key: &str, count: usize) -> PortResult<Vec<String>> {
    if count == 0 {
      return Ok(Vec::new());
    }
    let key = self.namespaced_key(key);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &key);
    let Some(list) = state.lists.get_mut(&key) else {
      return Ok(Vec::new());
    };
    let mut result = Vec::new();
    for _ in 0..count {
      let Some(value) = list.pop_back() else {
        break;
      };
      result.push(value);
    }
    Ok(result)
  }

  #[instrument(skip(self, value))]
  async fn hash_set_string(&self, map: &str, field: &str, value: &str) -> PortResult<bool> {
    let map = self.namespaced_key(map);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &map);
    let hash = state.hashes.entry(map).or_default();
    let changed = hash.insert(field.to_string(), value.to_string()).is_none();
    Ok(changed)
  }

  #[instrument(skip(self))]
  async fn hash_get_string(&self, map: &str, field: &str) -> PortResult<Option<String>> {
    let map = self.namespaced_key(map);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &map);
    Ok(state.hashes.get(&map).and_then(|hash| hash.get(field).cloned()))
  }

  #[instrument(skip(self))]
  async fn hash_delete_key(&self, map: &str, field: &str) -> PortResult<bool> {
    let map = self.namespaced_key(map);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &map);
    let Some(hash) = state.hashes.get_mut(&map) else {
      return Ok(false);
    };
    Ok(hash.remove(field).is_some())
  }

  #[instrument(skip(self))]
  async fn hash_keys(&self, map: &str) -> PortResult<Vec<String>> {
    let map = self.namespaced_key(map);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &map);
    Ok(
      state
        .hashes
        .get(&map)
        .map(|hash| hash.keys().cloned().collect())
        .unwrap_or_default(),
    )
  }

  #[instrument(skip(self))]
  async fn hash_random_key(&self, map: &str) -> PortResult<Option<String>> {
    let map = self.namespaced_key(map);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &map);
    Ok(state.hashes.get(&map).and_then(|hash| hash.keys().next().cloned()))
  }

  #[instrument(skip(self))]
  async fn hash_len(&self, map: &str) -> PortResult<usize> {
    let map = self.namespaced_key(map);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &map);
    Ok(state.hashes.get(&map).map(|hash| hash.len()).unwrap_or(0))
  }

  #[instrument(skip(self))]
  async fn hash_increase(&self, map: &str, field: &str, count: i64) -> PortResult<i64> {
    let map = self.namespaced_key(map);
    let mut state = self.state.write().await;
    Self::purge_if_expired(&mut state, &map);
    let hash = state.hashes.entry(map).or_default();
    let current = hash.get(field).and_then(|value| value.parse::<i64>().ok()).unwrap_or(0);
    let next = current.saturating_add(count);
    hash.insert(field.to_string(), next.to_string());
    Ok(next)
  }

  #[instrument(skip(self))]
  async fn hash_decrease(&self, map: &str, field: &str, count: i64) -> PortResult<i64> {
    self.hash_increase(map, field, -count).await
  }

  /// Delete all in-memory keys whose logical key matches `pattern`.
  ///
  /// Only simple glob patterns ending with `*` are supported (prefix match).
  /// For example, `myoxus:doc_snapshot:*` deletes snapshot cache keys inside
  /// this adapter's namespace only (P103-B-04).
  #[instrument(skip(self))]
  async fn delete_by_pattern(&self, pattern: &str) -> PortResult<usize> {
    // Namespace the pattern first (consistent with how set_string stores keys),
    // then derive the prefix by stripping a trailing `*`.
    let namespaced_pattern = self.namespaced_key(pattern);
    let prefix = namespaced_pattern.trim_end_matches('*');
    let mut state = self.state.write().await;
    let now = Instant::now();
    let keys_to_delete: Vec<String> = state
      .kv
      .keys()
      .chain(state.counters.keys())
      .chain(state.lists.keys())
      .chain(state.hashes.keys())
      .filter(|k| k.starts_with(prefix))
      .filter(|k| state.expirations.get(*k).map(|exp| *exp > now).unwrap_or(true))
      .cloned()
      .collect();
    // Deduplicate (a key may appear in multiple maps).
    let mut unique: std::collections::HashSet<String> = keys_to_delete.into_iter().collect();
    let count = unique.len();
    for key in unique.drain() {
      state.kv.remove(&key);
      state.counters.remove(&key);
      state.lists.remove(&key);
      state.hashes.remove(&key);
      state.expirations.remove(&key);
    }
    Ok(count)
  }
}

#[async_trait]
impl DistributedLockPort for InMemoryRedisAdapter {
  #[instrument(skip(self))]
  async fn acquire(&self, key: &str, ttl_seconds: u64) -> PortResult<bool> {
    let key = self.lock_key(key);
    let mut locks = self.locks.write().await;
    if let Some(expires_at) = locks.get(&key).copied() {
      if expires_at > Instant::now() {
        return Ok(false);
      }
      locks.remove(&key);
    }
    locks.insert(key, Instant::now() + Duration::from_secs(ttl_seconds.max(1)));
    Ok(true)
  }

  #[instrument(skip(self))]
  async fn release(&self, key: &str) -> PortResult<()> {
    self.locks.write().await.remove(&self.lock_key(key));
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use std::time::Duration;

  use super::{InMemoryRedisAdapter, RedisAdapter};
  use myoxus_application::ports::{DistributedLockPort, RedisPort};

  #[test]
  fn redis_adapter_rejects_invalid_url() {
    let adapter = RedisAdapter::new("://invalid", "myoxus");
    assert!(adapter.is_err());
  }

  #[test]
  fn invalid_redis_url_error_does_not_echo_credentials() {
    let error = RedisAdapter::new("redis://operator:secret@[invalid", "myoxus").expect_err("invalid URL");
    assert!(!error.to_string().contains("operator"));
    assert!(!error.to_string().contains("secret"));
  }

  #[test]
  fn redis_adapter_namespaces_keys() {
    let adapter = RedisAdapter::new("redis://localhost:6379", "myoxus").expect("adapter");
    assert_eq!(adapter.namespaced_key("session:a"), "myoxus:session:a");
  }

  #[tokio::test]
  async fn redis_lock_operations_return_transport_error_when_unreachable() {
    let adapter = RedisAdapter::new("redis://127.0.0.1:1", "myoxus").expect("adapter");
    let acquire = adapter
      .acquire("lock-k", 10)
      .await
      .expect_err("expected transport error");
    assert!(acquire.to_string().contains("transport failure"));
    let release = adapter.release("lock-k").await.expect_err("expected transport error");
    assert!(release.to_string().contains("transport failure"));
  }

  #[tokio::test]
  async fn in_memory_redis_adapter_supports_ttl_and_locks() {
    let adapter = InMemoryRedisAdapter::new("myoxus");
    adapter.set_string("k1", "v1", Some(1)).await.expect("set value");
    assert_eq!(
      adapter.get_string("k1").await.expect("get value"),
      Some("v1".to_string())
    );
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert_eq!(adapter.get_string("k1").await.expect("get expired"), None);

    assert!(adapter.acquire("a", 5).await.expect("acquire 1"));
    assert!(!adapter.acquire("a", 5).await.expect("acquire 2"));
    adapter.release("a").await.expect("release");
    assert!(adapter.acquire("a", 5).await.expect("acquire 3"));
  }

  #[tokio::test]
  async fn in_memory_redis_adapter_supports_legacy_cache_primitives() {
    let adapter = InMemoryRedisAdapter::new("myoxus");

    assert!(adapter.setnx_string("nx", "1", Some(10)).await.expect("setnx first"));
    assert!(!adapter.setnx_string("nx", "2", Some(10)).await.expect("setnx second"));
    assert!(adapter.has_key("nx").await.expect("exists"));
    assert!(adapter.ttl_seconds("nx").await.expect("ttl").is_some());
    assert!(adapter.expire_key("nx", 1).await.expect("expire"));

    assert_eq!(adapter.increase("counter", 2).await.expect("increase 1"), 2);
    assert_eq!(adapter.increase("counter", 3).await.expect("increase 2"), 5);
    assert_eq!(adapter.decrease("counter", 2).await.expect("decrease"), 3);

    assert_eq!(
      adapter
        .list_push_back("list", &["1".to_string(), "2".to_string(), "3".to_string()])
        .await
        .expect("list push back"),
      3
    );
    assert_eq!(adapter.list_len("list").await.expect("list len"), 3);
    assert_eq!(
      adapter.list_range("list", 0, -1).await.expect("list range"),
      vec!["1".to_string(), "2".to_string(), "3".to_string()]
    );
    assert_eq!(
      adapter.list_pop_front("list", 2).await.expect("list pop front"),
      vec!["1".to_string(), "2".to_string()]
    );
    assert_eq!(
      adapter.list_pop_back("list", 1).await.expect("list pop back"),
      vec!["3".to_string()]
    );

    assert!(adapter.hash_set_string("h", "a", "1").await.expect("hset a"));
    assert!(adapter.hash_set_string("h", "b", "2").await.expect("hset b"));
    assert_eq!(
      adapter.hash_get_string("h", "a").await.expect("hget a"),
      Some("1".to_string())
    );
    assert_eq!(adapter.hash_len("h").await.expect("hlen"), 2);
    let keys = adapter.hash_keys("h").await.expect("hkeys");
    assert!(keys.contains(&"a".to_string()));
    assert!(keys.contains(&"b".to_string()));
    assert!(adapter.hash_random_key("h").await.expect("hrandfield").is_some());
    assert_eq!(adapter.hash_increase("h", "num", 5).await.expect("hincr"), 5);
    assert_eq!(adapter.hash_decrease("h", "num", 2).await.expect("hdecr"), 3);
    assert!(adapter.hash_delete_key("h", "a").await.expect("hdel a"));
  }

  // ── ROB-23: compare_and_delete / compare_and_refresh atomicity ──────────

  #[tokio::test]
  async fn epoch_comparison_preserves_foreign_owners_and_distinguishes_absent_from_empty() {
    let adapter = InMemoryRedisAdapter::new("epoch-test");
    assert!(adapter.compare_and_set("epoch", None, "", 300).await.expect("create"));
    assert!(
      !adapter
        .compare_and_set("epoch", None, "foreign", 300)
        .await
        .expect("absent mismatch")
    );
    assert!(
      adapter
        .compare_and_set("epoch", Some(""), "blocked:owner", 300)
        .await
        .expect("claim")
    );
    assert!(
      !adapter
        .compare_and_set("epoch", Some("blocked:foreign"), "active:foreign", 300)
        .await
        .expect("owner mismatch")
    );
    assert_eq!(
      adapter.get_string("epoch").await.expect("still blocked").as_deref(),
      Some("blocked:owner")
    );
    assert!(
      adapter
        .compare_and_set("epoch", Some("blocked:owner"), "active:owner", 300)
        .await
        .expect("activate")
    );
  }

  #[tokio::test]
  async fn compare_and_delete_only_removes_when_value_matches() {
    let adapter = InMemoryRedisAdapter::new("myoxus");
    adapter.set_string("lock", "owner-A", Some(60)).await.expect("set");

    // Wrong value: must NOT delete.
    assert!(
      !adapter
        .compare_and_delete("lock", "owner-B")
        .await
        .expect("compare wrong"),
      "compare_and_delete must return false on value mismatch"
    );
    assert_eq!(
      adapter.get_string("lock").await.expect("still there"),
      Some("owner-A".to_string()),
      "key must not be deleted when value mismatched"
    );

    // Right value: deletes.
    assert!(
      adapter
        .compare_and_delete("lock", "owner-A")
        .await
        .expect("compare right")
    );
    assert_eq!(adapter.get_string("lock").await.expect("after del"), None);
  }

  #[tokio::test]
  async fn compare_and_delete_returns_false_for_missing_key() {
    let adapter = InMemoryRedisAdapter::new("myoxus");
    assert!(!adapter.compare_and_delete("absent", "anything").await.expect("missing"));
  }

  #[tokio::test]
  async fn compare_and_refresh_only_extends_when_value_matches() {
    let adapter = InMemoryRedisAdapter::new("myoxus");
    adapter.set_string("lock", "owner-A", Some(1)).await.expect("set");

    // Wrong value: TTL not extended.
    assert!(
      !adapter
        .compare_and_refresh("lock", "owner-B", 60)
        .await
        .expect("refresh wrong"),
      "compare_and_refresh must return false on value mismatch"
    );

    // Right value: TTL extended; key survives past original 1s expiry.
    assert!(
      adapter
        .compare_and_refresh("lock", "owner-A", 60)
        .await
        .expect("refresh right")
    );
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(
      adapter.get_string("lock").await.expect("still alive"),
      Some("owner-A".to_string()),
      "TTL refresh must keep the key alive past its original expiry"
    );
  }

  #[tokio::test]
  async fn compare_and_refresh_returns_false_for_missing_key() {
    let adapter = InMemoryRedisAdapter::new("myoxus");
    assert!(
      !adapter
        .compare_and_refresh("absent", "anything", 60)
        .await
        .expect("missing")
    );
  }
}
