# Search operations runbook

[Documentation](../../README.md) / [Operations](../README.md) / [Operations runbooks](./README.md)

Diagnose search results and indexing jobs before rebuilding the affected workspace index.

<details>
<summary>On this page</summary>

- [Architecture](#architecture)
- [Verify health](#verify-health)
- [Trigger reindex](#trigger-reindex)
- [Monitor reindex runs](#monitor-reindex-runs)
- [Test search directly](#test-search-directly)
- [Troubleshooting](#troubleshooting)
- [Performance](#performance)

</details>

## Architecture

Document search has one canonical PostgreSQL projection:

- `search_content` stores UUID document identity, title, plain text, structured
  workspace tags, the persisted `search_vector`, and the last projection time.
- `search_reindex_runs` records full and incremental reindex progress.
- `copilot_embeddings` stores the optional vector signal used by hybrid search.

Indexer snapshot, delta, deferred snapshot, workspace reindex, CLI import, tag
refresh, and cleanup paths all converge on `search_content`. Hybrid search
combines its `simple` full-text vector with document embeddings through
Reciprocal Rank Fusion (RRF).

## Verify health

Compare active documents with canonical search rows:

```sql
SELECT
  (SELECT COUNT(*)
     FROM docs
    WHERE workspace_id IS NOT NULL
      AND deleted_at IS NULL) AS active_docs,
  (SELECT COUNT(*) FROM search_content) AS indexed_docs;
```

A difference can be legitimate while indexing jobs are pending. A stable or
growing difference with no active jobs requires a reindex.

Inspect table and index size:

```sql
SELECT
  pg_size_pretty(pg_total_relation_size('search_content')) AS total_size,
  pg_size_pretty(pg_relation_size('idx_search_content_vector')) AS vector_index_size,
  pg_size_pretty(pg_relation_size('idx_search_content_workspace_updated_at')) AS scope_index_size;
```

Verify that persisted vectors exist:

```sql
SELECT COUNT(*) AS missing_vectors
FROM search_content
WHERE search_vector IS NULL;
```

## Trigger reindex

Admin GraphQL can reindex one workspace:

```graphql
mutation {
  admin {
    triggerWorkspaceReindex(workspaceId: "<workspace-uuid>")
  }
}
```

Or all workspaces:

```graphql
mutation {
  admin {
    triggerFullReindex
  }
}
```

The CLI can enqueue the established workspace job:

```bash
myoxus-cli search reindex --workspace <workspace-uuid>
```

## Monitor reindex runs

```sql
SELECT id, workspace_id, mode, status, processed_count, indexed_count,
       started_at, finished_at, error_message
FROM search_reindex_runs
ORDER BY started_at DESC
LIMIT 20;
```

Find runs that have not progressed:

```sql
SELECT id, workspace_id, status, started_at, updated_at, error_message
FROM search_reindex_runs
WHERE status = 'running'
  AND updated_at < now() - interval '1 hour';
```

Confirm the worker and Redis queue state before taking recovery action. Restart
the failed worker and recheck the run timestamp. If a run remains active
without progress, preserve its identifier and logs and escalate it as a server
recovery defect. Do not change `search_reindex_runs` directly; no public
operator transition exists for that state. Enqueue a replacement only after
the existing run is terminal.

## Test search directly

Test the persisted `simple` vector used by hybrid FTS:

```sql
SELECT doc_id, title,
       ts_rank(search_vector, plainto_tsquery('simple', 'your search terms')) AS rank
FROM search_content
WHERE workspace_id = '<workspace-uuid>'
  AND search_vector @@ plainto_tsquery('simple', 'your search terms')
ORDER BY rank DESC
LIMIT 10;
```

The normal SearchRepository additionally applies locale-aware ranking and an
`ILIKE` fallback for short terms. A direct SQL probe therefore diagnoses the
persisted projection, while an authenticated GraphQL or REST request validates
the complete authorization and ranking path.

## Troubleshooting

### Missing or stale results

1. Compare active document and `search_content` counts.
2. Inspect pending and failed indexer jobs and `search_reindex_runs`.
3. Check the affected row's `updated_at`, `plain_text`, `workspace_tags`, and
   whether `search_vector` is non-null.
4. Confirm `indexer.enabled` and worker queue health.
5. Trigger a scoped workspace reindex and verify that the row timestamp and
   vector change.

Do not write a second search table or client-side projection as a repair.

### Hybrid search returns no semantic results

Hybrid search requires:

1. a configured embedding provider;
2. `useSemanticSearch: true` on the GraphQL request;
3. document rows in both `search_content` and `copilot_embeddings`;
4. matching `workspace_id` and `source_type = 'doc'`;
5. caller read permission for the returned document IDs.

Inspect embedding coverage:

```sql
SELECT COUNT(DISTINCT source_id) AS embedded_docs
FROM copilot_embeddings
WHERE workspace_id = '<workspace-uuid>'
  AND source_type = 'doc';
```

The API filters fused candidates through the same document-read authorization
path as normal search. An embedding row never grants visibility.

## Performance

- `idx_search_content_vector` serves persisted full-text matching.
- `idx_search_content_workspace_updated_at` serves workspace-scoped ordering
  and pagination.
- Hybrid search bounds both vector and FTS CTEs by the requested limit before
  fusion.
- Reindexing uses keyset pagination on `(updated_at, id)`.
- The HNSW embedding index is memory-sensitive; monitor its relation size and
  query plans as embedding volume grows.

If PostgreSQL query statistics are enabled:

```sql
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
WHERE query LIKE '%search_content%'
ORDER BY mean_exec_time DESC
LIMIT 10;
```

Inspect canonical index usage:

```sql
SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND relname = 'search_content'
ORDER BY indexrelname;
```
