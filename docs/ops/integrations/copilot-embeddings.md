# Copilot embeddings — operations runbook

[Documentation](../../README.md) / [Operations](../README.md) / [Integrations](./README.md)

## Provider setup

Chat and embeddings are separately configured. A working chat or vision model
does not establish an embedding capability. Configure an existing endpoint that
actually returns OpenAI-compatible vectors:

```yaml
copilot:
  enabled: true
  embedding:
    endpoint: "https://embedding.example.org/v1"
    model: "operator-selected-embedding-model"
    dimensions: 1536
    send_task_type: false
    batch_size: 20
    # Supply api_key through the deployment's protected secret mechanism.
```

`MYOXUS__COPILOT__EMBEDDING__API_KEY` or an `env:` reference may supply the
credential. It may differ from the chat key. Do not dump effective secrets,
container environments or provider request bodies into support output.
Admin's **AI → Copilot → Embedding API** edits the dedicated endpoint, protected
key, model, dimensions and **Task-specific embedding encoding** switch. These
controls do not edit the regular generation provider. The server supplies numeric
bounds, write policy and restart metadata; invalid dimensions block Save.
Save persists the embedding changes, reload retains them with the key masked,
and restarting activates the configured transport. A settings save is not an
index rebuild or proof of successful retrieval.
`copilot.embedding_model` is not the productive indexing/query model selector.
Apply configuration through the normal server lifecycle; the transport is
startup-bound. See [configuration reference](../configuration/reference.md).

The normal startup migration preserves existing vectors while allowing the
configured model's dimensions (1–16000). Set `dimensions: 768` for a provider
returning 768-dimensional vectors; do not pad or relabel old vectors. A model or
dimension change needs reindexing before its vectors are available. Queries and
readiness do not mix models/dimensions. Chat fallback providers are never
embedding fallbacks, and configuring embeddings does not replace the chat model.
Normal semantic document search uses the same query encoder; its lexical FTS
branch remains separate and usable when embeddings are unavailable.

For endpoints requiring task-specific encoding, set `send_task_type: true`:
indexing sends `task_type: "document"`, searches send `task_type: "query"`.
Leave it false for standard endpoints that do not accept the extension. This
startup-bound option uses the same central YAML/ENV/DB configuration owner;
it is not a generation-model option. Rebuild old E5 source vectors when switching
to another model, even if dimensions happen to match. Retained old-model rows
are not current readiness and are not consumed by the new model.

Respect the provider's input and batch limits. For example, a provider accepting
at most eight texts per request needs `batch_size: 8`, supplied through YAML or
`MYOXUS__COPILOT__EMBEDDING__BATCH_SIZE`; the Admin form does not expose this
field. Batch size does not increase the provider's per-text token limit.

Without an endpoint, workspace search is explicitly unavailable. Plain chat and
explicitly selected document/file context still work. The warning in native chat
uses the existing dismissible notification instead of occupying the composer.
It does not mean selected files were discarded. A successful empty search and
an unavailable search are different outcomes.

## Trigger and observe indexing

Authenticated `queueWorkspaceEmbedding(workspaceId, docId)` dispatches selected
readable documents through the existing `copilot` worker queue. An empty document
list selects readable workspace documents; root and reserved `db$`/`userdata$`
state are excluded. Dispatch records durable SQL job identity; an accepted
mutation is not proof of a finished index. Requeue changed sources through this
same operation to refresh their vectors. Successfully materialized empty pages
need no provider request: their old vectors are cleared atomically and the job
records zero chunks. They are excluded from the indexable-document total only
after successful completion, never on a failed or pending attempt.

Use `queryWorkspaceEmbeddingStatus(workspaceId)` for `total`, `embedded`,
`available`, `status`, `error`. Zero documents or a historical timestamp does not
mean a successful ready index. Failed replacement retains old bytes without
advertising them as current success. A partial failure remains visible in
`status`/`error`, while `available` stays true if other current sources are usable.
Failed-source vectors cannot enter retrieval. A workspace with only empty pages
has no usable index (`available: false`), even after all jobs finish. A valid
provider and completed indexing are both necessary for real retrieval acceptance.

The completed vectors also serve general document searches that request
`useSemanticSearch: true`. They are shared with Copilot retrieval within the
indexed workspace; creating a separate search index is unnecessary. Existing
workspace and document permissions still apply. Other workspaces require their
own indexing, and ordinary lexical requests do not automatically become semantic.

Read-only database diagnosis may inspect the selected workspace:

```sql
SELECT job_type, state, error_message, created_at
FROM copilot_jobs
WHERE workspace_id = '<workspace-uuid>'
  AND job_type = 'copilot.embedding.add'
ORDER BY created_at DESC LIMIT 20;

SELECT model, source_type, count(*) AS chunks
FROM copilot_embeddings
WHERE workspace_id = '<workspace-uuid>'
GROUP BY model, source_type;
```

Stored rows alone cannot prove retrieval readiness or model context use. The
latest source job, model, active source, ignored-document policy and current ACL
also constrain consumption. Inspect API worker logs with the repository's
`build/scripts/server/stack-logs.sh api` wrapper, without logging source text.
Redis owns execution; there is no SQL `worker_jobs` queue. Do not use direct SQL
inserts to manufacture successful progress or delete a live index to retry it.

## Troubleshooting

- **No vectors:** verify endpoint support, exact model, protected credential and
  output matching the configured dimensions. HTTP 200 with HTML is not an
  embedding response.
- **Accepted but failed work:** inspect the durable job outcome and worker logs.
  MIME/byte/parser limits, revoked access, missing source, provider errors and
  malformed vectors do not count as success. Correct the cause and requeue the
  selected source; atomic refresh does not require prior deletion.
- **No matches:** distinguish unavailable status from a successful empty search;
  check model consistency, ignored sources, active files and caller access.
- **Disk pressure:** inspect table/index size read-only. Cleanup and schema
  changes need their own bounded operations workflow, not ad-hoc row deletion.

Speech uses independent `transcription.*` settings; see
[external transcription](./transcription.md). General document-search FTS and
reindex controls are separate from native Copilot vector retrieval.
