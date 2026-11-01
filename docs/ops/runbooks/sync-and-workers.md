# Sync and worker troubleshooting

[Documentation](../../README.md) / [Operations](../README.md) / [Operations runbooks](./README.md)

Diagnose collaboration delivery and background jobs using the owning queue, worker and connection state.

## WebSocket / sync issues — connection drops

### Symptom: repeated "ping timeout" or "io client disconnect" in logs, client sync broken

Connection-pool exhaustion is one possible cause, alongside proxy timeouts,
Redis/socket fanout failures, process restarts, and client/network loss. Start
from the correlated API and proxy signals instead of assuming one cause.

**What happens:**

- WebSocket ACK handlers (e.g. `space:load-doc`) wait for a pool connection before responding.
- If the configured pool is exhausted, an ACK handler can wait up to
  `database.acquire_timeout_seconds` for a connection.
- The client receives no ACK within its timeout window, disconnects, and immediately reconnects.
- The reconnect loop drains the pool further, creating a feedback loop.

**Diagnosis:**

Check `pg_stat_activity` to see if connections are saturated:

```sql
SELECT state, wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE datname = 'myoxus'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

Compare the connection count with the effective pool sizes across all API
instances and with PostgreSQL's connection budget. `pg_stat_activity` alone
does not prove that an application pool is exhausted.

Check the API logs for `pool timed out` or `PoolTimedOut`:

```bash
docker compose -f build/server/docker-compose.selfhost.yml logs api | grep -i "pool\|timed out\|timeout"
```

**Fix:**

1. Inspect the effective `database.max_connections` and the number of API
   instances. Size the combined pools below the database's operator-reserved
   connection budget; do not assume that the packaged default is correct for
   every topology.

2. Compare `database.acquire_timeout_seconds` with observed database latency and
   client/proxy timeouts. Change it only with an explicit failure and load test.

3. Correlate slow or blocked PostgreSQL queries with the owning request or
   worker log. Queue state itself lives in Redis; do not look for or create a
   PostgreSQL `worker_jobs` table.

4. If the pool is the measured bottleneck, tune query/index behavior and the
   pool together. Preserve connections for database administration and other
   clients; the sum of all API pools is not the entire PostgreSQL budget.

---

## Redis WebSocket cross-instance issues

**Symptoms:** In one logical deployment with multiple API instances, document
or Database changes made through one instance are not visible to clients on
another instance. Workspace-session or notification-acknowledgement state
differs between instances.

Document and Database realtime use Redis workspace fanout. Native Calendar
mutations use a local fast path plus that Redis fanout, and XWS notification
wakeups cross nodes; their durable rows remain authoritative in PostgreSQL.
Awareness and active Copilot stream state remain process-local and do not have
general cross-node replay. The configuration steps below restore the shipped
fanout paths but do not turn those transient states into durable data.

**Diagnosis:**

1. Check whether the affected API instance passed startup and which
   startup-check snapshot it exposes. By default the `socket` role shares the
   main Redis URL:

   ```bash
   # In the API container
   curl -sS http://localhost:3001/ready | jq '.checks'
   ```

   `/ready` does not re-run the Redis probe on every request. A green response
   after startup therefore does not prove current Pub/Sub connectivity.

2. Verify current Redis connectivity with the platform's credential-safe
   Redis probe and inspect API logs for `redis pubsub` reconnect or publish
   warnings. The broadcast channel format is
   `{namespace}:ws:broadcast:{workspace_id}`:

   ```bash
   redis-cli --host localhost --port 6379 \
     PUBSUB CHANNELS "myoxus:socket:ws:broadcast:*"
   ```

3. Check that every API instance in the logical deployment uses the same Redis
   URL and namespace for the `socket` role. Different values mean no shared
   Pub/Sub.

4. Look for Redis connection errors in the API logs:
   ```bash
   docker compose -f build/server/docker-compose.selfhost.yml logs api | grep -i "redis.*socket\|ws.*failed\|RedisWsAdapter"
   ```

**Resolution:**

1. Ensure `redis.roles.socket.url` points to the same logical Redis service
   for all API instances in the deployment.

2. If the socket-role Redis adapter is absent or its admission operation fails,
   new connections fail closed with `temporarily_unavailable`. Connections
   admitted before a later Redis failure can retain process-local delivery, but
   cross-instance membership/fanout is degraded. Restore Redis rather than
   adding a process-local admission fallback.

3. Workspace session entries are removed on a normal disconnect. A hard
   process crash can leave stale members; correlate them with the process ID
   and current connection metrics instead of treating the Redis Set as a
   canonical user-presence source.

See also:
[Multi-Instance-Cluster](../deployment/multi-instance.md) guide.

---
