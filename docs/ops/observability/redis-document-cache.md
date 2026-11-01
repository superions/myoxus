# Redis document cache operations

[Documentation](../../README.md) / [Operations](../README.md) / [Observability](./README.md)

This guide documents the current Redis-backed document cache contract,
including canonical document metadata projections.

<details>
<summary>On this page</summary>

- [Cache key layout](#cache-key-layout)
- [Redis sizing](#redis-sizing)
- [Monitoring](#monitoring)
- [Configuration tuning](#configuration-tuning)
- [Emergency cache disablement](#emergency-cache-disablement)
- [Troubleshooting](#troubleshooting)

</details>

## Cache key layout

| Cache               | Key pattern                                                                | TTL           | Maximum   |
| ------------------- | -------------------------------------------------------------------------- | ------------- | --------- |
| Snapshot            | `{ns}:doc_snapshot:{ws}:{doc}`                                             | 120s baseline | 10 MB     |
| Metadata            | `{ns}:doc_meta:{doc}`                                                      | 60s           | none      |
| Metadata projection | `{ns}:doc_metadata_projection:{ws}:{doc}:{mode}:{version}`                 | 60s           | none      |
| Document list index | `{ns}:document_metadata_index:{ws}:{version}`                              | 60s           | 2 MB      |
| Database inventory  | `{ns}:database_page_inventory:{ws}:{lifecycle}:{limit}:{offset}:{version}` | 60s           | 2 MB      |
| View deduplication  | `{ns}:doc_view_dedup:{user}:{ws}:{doc}:{date}`                             | 86400s        | none      |
| Compaction lock     | `{ns}:doc_compact_lock:{doc}`                                              | 60s           | none      |
| Timestamps          | `{ns}:doc_timestamps:{ws}`                                                 | 30s           | 1000 docs |

`{ns}` above is the DocCache logical prefix (`myoxus`). The complete stored key
also begins with the configured Redis role namespace. With defaults, a snapshot
key is therefore
`myoxus:cache:myoxus:doc_snapshot:{ws}:{doc}`: `myoxus:cache` isolates the
cache role/deployment and the second `myoxus` belongs to DocCache's stable key
contract.

Admin flushes pass logical patterns such as `myoxus:doc_snapshot:*` to the
cache-role adapter. The adapter adds `myoxus:cache` exactly once and uses Redis
`SCAN`; even the logical `*` cleanup used by isolated CLI tests cannot reach
session, queue, socket, lock, another deployment, or another test namespace.

## Redis sizing

Size Redis from observed `used_memory`, key counts, snapshot-size distribution,
queue/coordination load, and the eviction policy of the selected Redis role.
Cache hit rate is a usefulness signal, not a memory multiplier. Key/value and
allocator overhead mean payload bytes alone do not predict the required
capacity.

Documents larger than the configured
`redis.doc_snapshot_cache_max_size_mb` are not cached. The baseline is 10 MB.

`doc_meta` and `doc_metadata_projection` are separate partitions.
`doc_meta` stores sync and existence metadata from the document-load path.
`doc_metadata_projection` stores only the native metadata projection generated
from canonical sources, or the explicit compatibility-boundary projection for
older clients. Projection values must never be written back as canonical truth.

`{version}` is neither a timestamp nor a payload field. It is the stable
composition of the projection contract version, `docs.metadata_revision`, the
effective organization identity, and these normalized epoch revisions:

- global: `field_definition`, `reference_values`;
- organization-wide: `policy`, `defaults`;
- workspace-wide: `defaults`.

Changing definitions, reference-value lists, organization policies, or
defaults increments the corresponding database epoch. Old Redis keys remain
until TTL expiry or a flush, but the server no longer addresses them.

Document-related subsystems exposed through `DocumentMetadataType` must use the
same freshness authority as the document header. Writes to
`document_template_state`, `document_presentation_state`,
`document_integration_state`, audience assignments and the rendered current
version label therefore increment `docs.metadata_revision`. The document
trigger also covers every projected header/system fact, including
`updated_at`, `updated_by`, lifecycle, source columns and version-head state.
Deleting a Redis key without a new projection version is not a valid freshness
mechanism.

Projection rows and their version are read from one repeatable PostgreSQL
snapshot. A cache read or fill is followed by a current-version check, so a
racing writer cannot publish older data under a newer key. Ordinary metadata,
content and history writes never run Redis `SCAN`; obsolete versioned keys are
left to their bounded TTL. Pattern scans remain reserved for explicit audited
partition/admin flushes. Non-versioned snapshot, sync-metadata and timestamp
caches keep their direct-key eviction behavior.

The document list index is a separate fixed-TTL partition. Its version combines
the serialization contract, the durable workspace list revision and the narrow
global list-reference epoch. The cached value contains actor-independent rows,
including external document IDs and valid empty inventories. Current batched
authorization is always applied after the lookup. Rows and revision are read in
one repeatable PostgreSQL snapshot and rechecked after cache use; obsolete keys
expire naturally. A cache read or write is bounded to 250 ms, and Redis failure
falls back to SQL. Entries larger than the configured limit are not truncated
or cached.

The count-free Database page inventory shares the same 60-second TTL, 2 MB
admission limit and 250 ms Redis I/O budget. Its typed key additionally carries
workspace, lifecycle and the normalized offset page. The version is backed by
the transactional workspace Database-inventory revision. PostgreSQL returns a
page and revision from one repeatable-read snapshot; after either Redis or SQL
loading, the application checks the current revision again. Workspace Read is
always authorized before cache access. Confirmed empty pages are stored, but a
Redis or PostgreSQL error is never converted into emptiness.

## Monitoring

Each of the four auto-tuned partitions (`doc_snapshot`, `doc_metadata`,
`doc_metadata_projection` and `doc_timestamps`) records one cause per cache
operation. A hit is a successfully decoded value. A miss is strictly an absent
Redis key. Decode failures, Redis read failures, disabled operations, values
rejected by the size limit, values that cannot be serialized, successful
writes and write failures are separate event fields in the hourly or daily
`document-cache event interval` log.

`eviction_attempts` counts explicit invalidation operations. It does not claim
that a direct `DEL` removed an existing key because the Redis port does not
return that fact. Pattern-based administrative flushes additionally report the
exact `evicted_keys` count returned by Redis. `eviction_errors` is separate from
both. For versioned metadata projections, `version_changes` counts freshness
changes observed while a cache read or fill was being validated. It is not a
count of every PostgreSQL mutation.

Only hits and absent keys form the hit rate used for TTL increases. Decode or
transport errors, disabled caches, oversized/uncacheable values and write
failures cannot make a TTL grow. Explicit eviction attempts and observed
version changes may lower a TTL when the existing churn rules have sufficient
traffic; version changes remain separately identified in the interval log and
are not persisted as misses or explicit evictions.

`document_metadata_index` and `database_page_inventory` use separate copies of
the same cause-specific counters but are not additional auto-tuned partitions.
Their `hits`, `absent`, `decode_errors`, `read_errors`,
`disabled`, `skipped_oversized`, `uncacheable`, `writes` and `write_errors`
remain distinct. In particular, a Redis outage or oversized inventory is not
reported as an absent key and cannot change this partition's fixed TTL.

The hourly and daily tuners own the swap-to-zero in-process event intervals.
Operational status queries read the already persisted tuning rows and must not
read-and-reset live counters, so monitoring cannot consume a future tuning
sample. The persisted `invalidations_local` value for these shared Redis
partitions means explicit eviction attempts on the reporting instance; it is
not a confirmed-deletion or remote-invalidation count.

Important Redis metrics:

```bash
redis-cli INFO stats | grep keyspace_hits
redis-cli INFO stats | grep keyspace_misses
redis-cli INFO memory | grep used_memory_human
redis-cli INFO stats | grep expired_keys
```

Inspect cache keys during diagnostics:

```bash
redis-cli SCAN 0 MATCH "myoxus:cache:myoxus:doc_snapshot:*" COUNT 1000
redis-cli SCAN 0 MATCH "myoxus:cache:myoxus:doc_metadata_projection:*" COUNT 1000
redis-cli SCAN 0 MATCH "myoxus:cache:myoxus:document_metadata_index:*" COUNT 1000
redis-cli SCAN 0 MATCH "myoxus:cache:myoxus:database_page_inventory:*" COUNT 1000
redis-cli SCAN 0 MATCH "myoxus:cache:myoxus:doc_view_dedup:*" COUNT 1000
redis-cli SCAN 0 MATCH "myoxus:cache:myoxus:doc_compact_lock:*" COUNT 100
```

## Configuration tuning

These Redis cache parameters accept YAML, environment, or validated Admin
overrides. Existing document-cache controls retain their documented runtime
behavior; the document-list index controls are restart-applied.

| Parameter                                         | Default | Purpose                                       |
| ------------------------------------------------- | ------- | --------------------------------------------- |
| `redis.doc_snapshot_cache_enabled`                | `true`  | Enable snapshot caching                       |
| `redis.cache_ttl_doc_snapshot_seconds`            | `120`   | Snapshot TTL in seconds                       |
| `redis.doc_snapshot_cache_max_size_mb`            | `10`    | Largest cached snapshot                       |
| `redis.doc_metadata_cache_enabled`                | `true`  | Enable sync/existence metadata caching        |
| `redis.cache_ttl_doc_metadata_seconds`            | `60`    | Sync/existence metadata TTL                   |
| `redis.doc_metadata_projection_cache_enabled`     | `true`  | Cache canonical document metadata projections |
| `redis.cache_ttl_doc_metadata_projection_seconds` | `60`    | Projection TTL                                |
| `redis.document_metadata_index_cache_enabled`     | `true`  | Cache actor-independent document-list rows    |
| `redis.cache_ttl_document_metadata_index_seconds` | `60`    | Fixed document-list index TTL                 |
| `redis.document_metadata_index_cache_max_size_mb` | `2`     | Largest complete list-index entry             |
| `redis.doc_view_dedup_enabled`                    | `true`  | Enable 24-hour view deduplication             |
| `redis.compaction_lock_enabled`                   | `true`  | Enable the distributed compaction lock        |
| `redis.compaction_lock_ttl_seconds`               | `60`    | Lock timeout                                  |
| `redis.doc_timestamps_cache_enabled`              | `true`  | Enable timestamp-map caching                  |
| `redis.cache_ttl_doc_timestamps_seconds`          | `30`    | Short TTL for sync freshness                  |
| `redis.doc_timestamps_cache_max_docs`             | `1000`  | Maximum documents per workspace entry         |

Environment override example:
`MYOXUS__REDIS__DOC_SNAPSHOT_CACHE_ENABLED=false`

## Emergency cache disablement

Disable the snapshot cache immediately through Admin, or at restart through an
environment override:

```bash
# Admin: Performance -> Document Cache
MYOXUS__REDIS__DOC_SNAPSHOT_CACHE_ENABLED=false
```

Cache removal is a recovery action. First disable the snapshot cache through
Admin and confirm the effective setting on every API instance. Record current
Redis memory and the matching key count. Then use the authenticated Admin
mutation, which owns the namespace pattern and records an audit event:

```graphql
mutation FlushDocumentSnapshotCache {
  admin {
    adminFlushDocSnapshotCache
  }
}
```

Abort if the result is larger than the reviewed key count or if the request is
not routed to the intended deployment. Do not flush all document caches merely
to clear snapshots. Compaction locks expire after their effective
`redis.compaction_lock_ttl_seconds`; never delete one while an owning API can
still commit. If lock recovery is required, stop every API instance, wait for
the complete TTL, and confirm the key expired before restarting.

Restart the API, require `/ready` to pass, and open/edit the affected synthetic
document. If the probe fails, keep the cache disabled and restore service from
PostgreSQL rather than restoring old Redis keys.

## Troubleshooting

**A client sees stale document state after a write:** inspect the exact key and
server projection version. Use the audited snapshot flush above only after the
canonical PostgreSQL state has been verified.

```bash
redis-cli TTL "myoxus:cache:myoxus:doc_snapshot:{ws_uuid}:{doc_uuid}"
```

**Duplicate Git Sync events:** concurrent compaction may be running on multiple
instances because the lock is ineffective.

```bash
redis-cli TTL "myoxus:cache:myoxus:doc_compact_lock:{doc_uuid}"
```

Correlate the lock with compaction logs. Change
`redis.compaction_lock_ttl_seconds` only after measuring the compaction
duration and testing concurrent writers.

**Excessive view counts:** a Redis outage causes the fallback
`is_unique = true`. New counts normalize automatically after Redis recovers.
Historical overcounts in `workspace_doc_view_daily` remain unchanged.
