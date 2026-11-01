# Document projection repair

[Documentation](../../README.md) / [Operations](../README.md) / [Operations runbooks](./README.md)

Use this runbook only to reconcile existing page metadata across the SQL
`docs` row, the page leaf Yjs document, and the workspace-root `meta.pages`
projection. Normal create, rename, trash, and restore operations are already
atomic. No projection command is scheduled, run at startup, or authorized to
operate on production automatically.

<details>
<summary>On this page</summary>

- [Safety contract](#safety-contract)
- [Drift classes](#drift-classes)
- [Procedure](#procedure)
- [Observability and escalation](#observability-and-escalation)

</details>

## Safety contract

- Take and verify a current database backup before applying a repair.
- Scan, inspection, and dry-run are read-only. `--apply` is never implied.
- Scan is bounded to 1-200 results and its opaque cursor belongs to one
  workspace, scan lane, last key, and observed root sequence. It never decodes
  leaf content and incomplete output never claims workspace health.
- Inspect and repair select exactly one opaque workspace-local
  `external_doc_id`. There is no internal-ID fallback or batch repair.
- Repair re-inspects the selected state and rejects a stale fingerprint.
- Invalid identities, leaf-only orphans, duplicate/non-bijective root entries,
  and ambiguous titles are evidence only.
- A completed replay is a no-op: it emits no SQL/Yjs update, outbox event, or
  mutation audit row.
- Availability of these commands is not authorization for a production repair.
  Production apply requires a separate operator decision, verified backup,
  reviewed dry-run, and bounded rollback plan.

## Drift classes

| Class                  | Meaning                                                             | Repair                          |
| ---------------------- | ------------------------------------------------------------------- | ------------------------------- |
| `missing_root_entry`   | SQL page exists but `meta.pages` has no matching entry.             | yes                             |
| `missing_sql_metadata` | Root page exists without a normal SQL page row.                     | if unambiguous                  |
| `missing_leaf`         | SQL or root identity exists without leaf Yjs state.                 | yes                             |
| `title_mismatch`       | SQL, root, and leaf titles disagree.                                | only with unambiguous authority |
| `trash_mismatch`       | SQL and root trash state disagree.                                  | yes                             |
| `orphan`               | Identity cannot be linked safely, is invalid, or belongs elsewhere. | no                              |

A non-empty leaf title is authoritative because the Web client writes it before
the delayed SQL/root projection flush. Without one, equal SQL/root titles or one
available title are usable. Conflicting SQL/root titles remain unchanged.

A valid empty Y.Text title on exactly one page block is title evidence too.
When SQL is also untitled and the root entry is absent, exact-target repair
registers the page with that empty title without rewriting its leaf payload.
A missing/malformed title or ambiguous page structure is not an empty title;
repair rejects it. Empty leaf evidence conflicting with nonempty metadata is
also rejected. Successful repair confirms registration through the existing
write owner, so normal list/open and trash operations can resume.

## Procedure

### Local content awaiting registration

A successful upload confirms retained bytes, not membership in the workspace
page list. New clients retain explicit creation intent across restart. A
`pending` registration resumes as the missing content arrives; `unresolved`
means that the server has no creation evidence for that cached page.

The Web “All content” view shows retained local documents without membership.
“Recover local documents” is an explicit decision to add them to this workspace;
it persists that decision before retrying ordinary sync. Repeated attempts keep
the same intent. A rejected or incomplete attempt retains the local bytes and
shows recovery feedback. Server-confirmed permanent deletion is different:
`DOC_DELETED` causes the client to remove that document's local cache and sync
clocks instead of offering recovery. Connected clients receive a server hint;
clients that missed it reconcile the retained deletion evidence on reconnect.
An ordinary `DOC_NOT_FOUND` response does not authorize cache deletion.
Deletes predating retained server evidence cannot be inferred from absence;
their unidentified local remnants remain unresolved rather than being purged.
Do not clear the browser cache to resolve unresolved registration.
For existing SQL/leaf projection drift, use the exact-target inspection and
repair sequence below. Cache presence, a title and timestamps alone are never
permission to register every unknown leaf.

### Exact-target projection repair

1. Record the verified backup identifier.
2. Traverse bounded scan pages until `nextCursor` is absent:

   ```bash
   myoxus-cli --json doc projection scan --workspace <workspace-uuid> --limit 50
   myoxus-cli --json doc projection scan --workspace <workspace-uuid> \
     --limit 50 --cursor <opaque-next-cursor>
   ```

3. For each approved repairable external key, obtain its exact state:

   ```bash
   myoxus-cli --json doc projection inspect \
     --workspace <workspace-uuid> --external-doc-id <external-key>
   ```

4. Preview exactly that target with the returned fingerprint:

   ```bash
   myoxus-cli --json doc projection repair \
     --workspace <workspace-uuid> \
     --external-doc-id <external-key> \
     --fingerprint <inspection-fingerprint>
   ```

5. Apply the identical target by adding `--apply` and
   `--actor <operator-user-uuid>`. Stop on
   `MIX_PAGE_REPAIR_REPORT_STALE` or `MIX_PAGE_REPAIR_TARGET_CHANGED`;
   obtain a new exact inspection instead of bypassing either error.
6. Inspect the target again, then continue the bounded scan. Confirm the finding
   is absent and only deliberately unresolved evidence remains.
7. Verify the page through the normal list/read path and inspect collab delivery
   metrics. A changed document emits one `workspace_doc_broadcast`.

MCP uses the same operations: `page_projection_scan` and
`page_projection_inspect` require `read:docs` plus workspace membership;
`page_projection_repair` requires `write:docs`, an idempotency key,
workspace `CreateDoc`, and `DocAction::Update` for an existing page. The
retired `page_lifecycle_audit` and `page_lifecycle_repair` names are unknown;
there are no aliases.

Projection repair preserves `docs.id`, foreign keys, and the browser-visible
external key. It is not a document-identity migration. Never compensate for a
failure with direct SQL, a startup repair, or an automatic workspace sweep.

For optional Project setup, first inspect the original setup receipt. Native
leaf/root creation, attribution and ordinary template-state cleanup share the
creation acknowledgement; Organizer placement is a later acknowledged step.
A created but unplaced document is a recoverable setup result, not evidence that
its body must be recreated. Resume that request through its native owner before
considering projection repair. Never replace its reserved ID or replay a source
snapshot over edited content.

## Observability and escalation

`page_lifecycle_repair_total` is emitted in the `collab` metrics category
with `drift_class`, `mode`, and `outcome` (`previewed`, `repaired`, or
`unchanged`). Read-only commands, dry-run, and unchanged replay do not create
mutation audit rows. A successful MCP apply records
`mcp.doc.projection.repair` without titles, content, credentials, or raw
fingerprints.

Escalate instead of applying when the root cannot be decoded, the selected leaf
is malformed, an identity is invalid, duplicate, non-bijective, or
cross-workspace, SQL/root titles conflict without a usable leaf title, or the
fingerprint repeatedly becomes stale. Preserve bounded evidence and redacted
server logs, but never document content or credentials.
