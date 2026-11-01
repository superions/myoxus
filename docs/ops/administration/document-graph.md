# Document graph operations

[Documentation](../../README.md) / [Operations](../README.md) / [Administration](./README.md)

The Document Graph is maintained asynchronously. Normal document writes mark
index state stale and enqueue worker jobs; users do not wait for graph
extraction.

## Runtime controls

Queue:

- `document-graph`
- `documentGraph.reindexDocument`
- `documentGraph.reindexWorkspaceBatch`

Runtime-reloadable:

- `job.queues.document-graph.concurrency`

Restart-required:

- `document_graph.max_graph_nodes`
- `document_graph.max_graph_edges`
- `document_graph.max_occurrences_per_edge`
- `document_graph.max_reindex_batch`
- `document_graph.max_catch_up_workspaces`
- `document_graph.preview_max_chars`
- `document_graph.stale_after_seconds`
- `document_graph.enqueue_delay_ms`
- `document_graph.max_reindex_attempts`
- `worker.polling.document_graph_reindex_interval_ms`

Use the existing Admin Queue page for queue state and actions. Use the existing
Performance page for limits and worker polling interval settings. There is no
separate Document Graph admin dashboard.

## CLI

Run diagnostics and backfills through the service-backed CLI:

```bash
myoxus-cli graph status --workspace-id <workspace-id>
myoxus-cli graph status --workspace-id <workspace-id> --doc-id <doc-id>
myoxus-cli graph enqueue-doc --workspace-id <workspace-id> --doc-id <doc-id>
myoxus-cli graph run-doc --workspace-id <workspace-id> --doc-id <doc-id>
myoxus-cli graph enqueue-workspace --workspace-id <workspace-id> --limit <n>
myoxus-cli graph run-workspace-batch --workspace-id <workspace-id> --limit <n>
```

For enqueue commands, provide `REDIS_URL` through the process's protected
runtime environment when the central `MYOXUS__REDIS__URL` is not already
available. Use `--redis-prefix` only when the deployment intentionally changed
the queue prefix. Do not place a credential-bearing Redis URL in command
arguments.

## Failure modes

- `MIX_GRAPH_REINDEX_ENQUEUE_FAILED`: write path succeeded, enqueue failed,
  index state remains stale and catch-up can retry later.
- `MIX_GRAPH_REINDEX_FAILED`: extraction or repository update failed during a
  worker/CLI reindex.
- `MIX_GRAPH_QUERY_INVALID`: invalid GraphQL input, CLI input or worker
  payload.
- `MIX_GRAPH_SERVICE_UNAVAILABLE`: Graph service is not wired in a narrow test
  state.

GraphQL redaction is part of the read path. Operators must not treat a redacted
edge as data loss; it means the target exists but the current user cannot read
its details.

## Runtime verification

Use a synthetic workspace with at least two linked documents. Open All Docs,
choose a visible document, open the document header menu and select **Links &
references**. Verify Backlinks and Outgoing links, then run the CLI status
command for the same workspace. Review browser/API errors and remove the
synthetic links through the normal editor flow.
