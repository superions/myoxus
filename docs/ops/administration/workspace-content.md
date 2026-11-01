<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Workspace content operation recovery

[Documentation](../../README.md) / [Operations](../README.md) / [Administration](./README.md)

Cross-workspace Link, Copy, Move, and Extract operations are authoritative in
PostgreSQL. Redis transports queue wake-ups and realtime notifications; shared
object storage contains operation-owned staging. Never repair these operations
by editing product tables manually.

<details>
<summary>On this page</summary>

- [Deploying deterministic content revisions](#deploying-deterministic-content-revisions)
- [Tag classifications in copy, move, extract and undo](#tag-classifications-in-copy-move-extract-and-undo)
- [Workspace tags and label recovery](#workspace-tags-and-label-recovery)
- [Sharing policy](#sharing-policy)
- [Copy without document payloads](#copy-without-document-payloads)
- [Triage](#triage)
- [Permanent deletion and folder references](#permanent-deletion-and-folder-references)
- [Recovery actions](#recovery-actions)
- [Redis and notifications](#redis-and-notifications)
- [Escalation](#escalation)
- [Collection transfer cutover](#collection-transfer-cutover)
- [Typed copy identities and attachments](#typed-copy-identities-and-attachments)
- [Contained reference omission](#contained-reference-omission)
- [Optional Project setup recovery](#optional-project-setup-recovery)

</details>

## Deploying deterministic content revisions

Object keys in Yjs values now encode in a deterministic order. This changes no
document identities, values, ACLs or wire-format decoding, and existing stored
updates remain readable. Before deploying this change, let running/queued
workspace-content operations finish on the old release. Prepare a new review
for previews created by an older release: their transient byte-derived revision
may not match the deterministic encoding. Do not replay terminal Redis jobs.

Link placement revisions now describe the validated visible Organizer tree.
Compaction and client tombstone bookkeeping do not invalidate an unchanged
placement; real folder, ordering and target-reference changes still do. Old
Link previews likewise require a fresh review when upgrading. Link selects exactly
one Document, Database or Tag. It does not copy or inventory its content. Older
uncommitted intents that point to a Database row instead of the selected Database
are rejected as stale and require a new preview; completed receipts are unchanged.

## Tag classifications in copy, move, extract and undo

Copy, Move and Extract resolve Tags automatically by normalized name, with active target metadata
winning. Historical archived source assignments may reuse archived target Tags
when no active match exists. An active source gets a new active Tag if only
archived matches exist. Technical slug collisions allocate a free slug; no
confirmation or metadata-conflict resolution is needed. Source catalogs and
aliases remain unchanged, including zero-usage Tags. Database cells, templates
and saved Tag filters use the same ordered, deduplicated map. Merged Organizer
Tag shortcuts retain an existing destination placement or the first stable
incoming placement; unselected source Tag shortcuts remain local.

Before upgrading, drain queued/running jobs on their admitting release. Old
unpublished Tag staging is rejected with `XWS_PREFLIGHT_STALE`; create a fresh
review rather than replaying or manually repairing the old plan. Historical
terminal operations remain readable. Copy service failures preserve their
registered Tag/Database cause and phase instead of becoming storage retries.

## Workspace tags and label recovery

`workspace_tags` is the authoritative generic catalog. Do not repair Database
Tags by editing Yjs metadata, `calendar_event_tags`, field config option lists
or browser storage. `workspace_tag_document_assignments` and Database Tags cell
UUID arrays must resolve to the same catalog rows. Archive is the reversible
removal lifecycle. Permanent deletion is available only through the
authenticated lifecycle API for an already archived Tag; it is never an
operator SQL repair path.

The permanent-delete transaction removes document assignments, every matching
Database `Tags` cell value and root-Yjs compatibility references before it
deletes the catalog row. It also records the canonical and legacy identifiers
in `workspace_tag_retired_ids`, preventing explicit reconciliation from
recreating retired identities. The old client bootstrap is retired and never writes. Do not delete or edit those retirement rows manually.

An archived reference is immutable historical data, not a write lock on the
whole document or cell. Users can retain or remove it while editing active tags;
the server rejects only an attempt to add an archived id that the prior value
did not contain. For a shared bulk assignment, the id must already exist on
every targeted row. `MIX_WORKSPACE_TAG_ARCHIVED_WRITE` during an unrelated tag
addition therefore indicates stale server code or a malformed client payload;
inspect both the stored prior value and submitted UUID array before remediation.

### Explicit label reconciliation

`myoxus-cli workspaces labels inspect <workspace-uuid>` is read-only. It reports
canonical catalog rows, ordered SQL and legacy-root assignments, internal UUID
and external-key mappings, unknown/retired references and SQL/root revisions.
`null` legacy assignments mean the field is absent; `[]` means an explicitly
empty legacy field. Neither means SQL is unmigrated. Use `--json` when preserving
a machine-readable inspection; the normal CLI output remains available.

Before repair, take a consistent [server backup](../data/backup-and-restore.md),
including PostgreSQL document snapshots and update tails. Inspect the selected
workspace and obtain approval for its concrete final assignments. Deploy the
coordinated API/Web/native label cutover while that workspace is not being
edited. The CLI acknowledgement does not deploy clients or disable an old
client's bootstrap path. Do not apply cleanup to a deployed workspace before
its updated clients are in place.

```bash
myoxus-cli --json workspaces labels inspect <workspace-uuid> > labels-inspection.json
myoxus-cli --json workspaces labels apply <workspace-uuid> \
  --decisions labels-decisions.json --actor <existing-user-uuid-or-email> \
  --cutover-acknowledged
```

Create the decision file from the reviewed inspection. For example:

```json
{
  "workspace_id": "<workspace-uuid>",
  "sql_revision": "<inspected-sql-revision>",
  "root_revision": "<inspected-root-revision>",
  "documents": [
    { "external_id": "document-key", "tag_ids": ["<canonical-tag-uuid>"] },
    { "external_id": "explicitly-cleared-document", "tag_ids": [] }
  ],
  "import_legacy_ids": []
}
```

Every document entry is an explicit, complete ordered replacement. Unselected
documents remain untouched. Existing SQL UUIDs and supported archived references
are preserved; retired IDs cannot be recreated. To import a legacy-only catalog
entry, explicitly list its source ID in `import_legacy_ids` and use that ID in
selected assignments. The existing portable-transfer owner validates its name,
color, description and archive metadata and assigns a deterministic target UUID.
Display-name equality never selects a SQL row. Subsequent inspection reports the
persisted source-to-target mapping. Unknown/unmapped document identities must be
resolved separately; this command cannot invent a document or silently remove it.

Apply checks both revisions inside the same transaction as assignment replacement
and removal of the selected legacy root fields. Concurrent changes reject the
repair; inspect again and review the updated choices. The root catalog remains
until every page label field has been reconciled. Updates append through the
normal document sequence/outbox path, invalidate caches after commit and create
an operator audit record. Existing snapshots and the decision file are unchanged.
A fully completed retry is a no-op, including when unrelated workspace state has
changed since the original inspection. Input size and materialization remain
bounded by the configured workspace import/document limits.

Verify with a new inspection and the updated client's document Tags control.
Rollback is a **forward repair**: inspect the current revisions, review the
previous assignment choices against the current catalog, then apply a new
explicit decision file. Do not restore obsolete root label authority or delete
retirement records. Use a reviewed decision file for each affected workspace.

Inspect catalog state and active-slug integrity:

```sql
SELECT id, workspace_id, name, slug, color_role, archived_at, updated_at
  FROM workspace_tags
 WHERE workspace_id = '<workspace-uuid>'
 ORDER BY archived_at NULLS FIRST, lower(name), id;

SELECT workspace_id, slug, count(*)
  FROM workspace_tags
 WHERE archived_at IS NULL
 GROUP BY workspace_id, slug
HAVING count(*) > 1;
```

The second query must return no rows; the partial unique index also enforces
this invariant. If a rename reports `MIX_WORKSPACE_TAG_DUPLICATE_SLUG`, inspect
the active catalog first. Archive or rename the unintended record through the
authenticated API, then retry. Do not rewrite slugs directly because collision
resolution and audit actors belong to `WorkspaceTagService`.

Verify document assignments and Database cell references:

```sql
SELECT assignment.doc_id, assignment.position, tag.id, tag.name,
       tag.slug, tag.color_role, tag.archived_at
  FROM workspace_tag_document_assignments assignment
  JOIN workspace_tags tag
    ON tag.workspace_id = assignment.workspace_id
   AND tag.id = assignment.tag_id
 WHERE assignment.workspace_id = '<workspace-uuid>'
 ORDER BY assignment.doc_id, assignment.position;

SELECT database_id, row_id, field_id, tag_id, position
  FROM database_row_tag_references
 WHERE workspace_id = '<workspace-uuid>'
 ORDER BY database_id, row_id, field_id, position;
```

If document/header labels are missing while catalog rows exist, inspect canonical
assignment reads, their ACL result and client refresh errors. Keep unavailable
reads distinct from confirmed empty assignments. `WORKSPACE_TAG_BOOTSTRAP_RETIRED`
identifies an outdated client; update it instead of retrying bootstrap. Inspect
historical mappings and SQL/Yjs conflicts with the read-only label CLI, then
apply only explicitly approved revision-bound decisions through the coordinated
[client cutover](#coordinated-label-client-cutover). Remote clients never mint label IDs or project labels into live
Yjs; the isolated local-only native branch retains its local IDs and metadata.

CSV, JSON and Notion preview returns `workspaceTagDiagnostics` before apply.
For raw imported colors, compare `sourceColor` and `colorRole`; normalization
to an approved semantic `tag.*` role is expected and names affected rows and
fields. JSON schema version 2 is the lossless round-trip format. CSV carries
`name|colorRole` and emits `MIX_DATABASE_CSV_TAG_ROUNDTRIP_LOSSY` because stable
ids/slugs cannot live in ordinary cells. Apply commits planned tags and
Database data in one SQL transaction; after an apply error, a planned tag must
not remain without the corresponding Database transaction.

### Coordinated label client cutover

Upgrade the API, Web and native clients together when switching legacy label
assignments to the canonical SQL catalog.
Use the existing [client update control](./client-updates.md)
for Browser Web; it is an operator traffic fence, not a deployment mechanism.

1. Back up SQL, document storage and configuration. Run label inspection before
   deployment and record explicit decisions for every affected existing
   workspace. Review each production reconciliation decision before applying it.
   Do not infer an empty SQL assignment from missing migration history.
2. Stop edits in affected workspaces. Use one `client-update` operation ID for
   `limit-retry` followed by `no-retry` when Browser Web traffic must stop. Close
   native editors separately: browser update control does not suspend them.
3. Deploy the matching API, Web and updated native clients through the normal
   release process. Keep workspaces closed until client versions are verified;
   use the existing native minimum-version policy as appropriate for that release.
   Old bootstrap calls now receive `WORKSPACE_TAG_BOOTSTRAP_RETIRED`; this error
   prevents writes but cannot make an old client's Yjs display authoritative.
4. Apply each approved revision-bound decision with `--cutover-acknowledged`.
   A changed root/SQL revision requires new inspection and a renewed concrete
   decision. Never force a stale decision through. Inspect again to verify the
   selected SQL assignments and root cleanup. Unresolved records are not repaired
   merely by deploying the new client.
5. Complete the same browser update operation with `update-success --action
reload` and the deployed `--required-web-build-id` where available. Reopen only
   with updated clients. Verify MCP-to-open-document readback, label add/remove,
   reload and reconnect. On failure retain the traffic fence; use the established
   failed/abort transitions and forward repair, never reactivate legacy bootstrap.

Keep workspaces with unresolved reconciliation decisions closed until their
inspection and approved repair have completed.

## Sharing policy

The current destination public/sharing policy wins automatically when Move or
Extract publishes. It can retain or reduce a document's public mode, never
publish private content. Copy is private and Link changes no publication or
access rights. A disabled/private destination requires no extra confirmation
or flag change. Public artifacts/listings are invalidated through the committed
outbox; an old source URL cannot expose the moved document. Legacy confirmation
and blocker values remain visible only in historical records.

## Copy without document payloads

An empty folder or zero-row Database is valid Copy content. Names, nested folders,
schema, views and templates are published through normal verified staging and
receipts, without inventing documents. Definition-only Tags use the same boundary.
A vanished directly selected root has its source-specific cause; genuinely empty
or corrupt requests/staging remain rejected.

## Triage

Move requires Manager-or-higher source transfer authority and destination write
capability at execution admission. Later actor revocation does not cancel the
admitted operation. Document grants and live metadata remain on the same IDs;
Move/Copy do not enroll source members or copy their workspace roles. Copy ACLs
still require explicit confirmation. Copy checks source access before staging,
not again when publishing verified staging. Link still checks current read
rights when opened; a link never grants access.

Folder extraction uses the actor's current central workspace organization
capability when execute admits the operation and creates its private target.
Workspace Manager/Admin/Owner and canonical OU-manager authority are sufficient;
per-document grants are preserved data, not additional extraction prerequisites.
Later source membership, SQL document metadata/permission or OU-manager-policy changes do not
abort an admitted extraction. They still govern ordinary access and new
operations. The target inherits the owner and accepted members captured at
admission; document IDs and their live grants remain unchanged.

1. Locate the operation through the existing audit log using its operation ID.
2. Read the redacted operator status projection.
3. Check the `workspace-content-operation` queue and Redis connectivity.
4. Check shared storage only when staging or cleanup failed.
5. For delayed document collaboration, inspect pending
   `workspace_doc_broadcast` events before restarting clients.
6. Use an operator action only after identifying the exact durable state.

Safe audit fields are actor, operation ID and kind, source/target Workspace
IDs, resource and confirmation counts, terminal status, and an optional
diagnostic process ID. Titles, comments, document payloads, Blob keys or URLs,
tokens, credentials, and raw dependency errors must not appear.

Preview audit records retain the actual blocker categories and up to 64
missing resource identities and broken reference pairs. Blob keys are excluded;
the total broken-reference count and diagnostic limit disclose truncation.
Web shows missing target kind and external ID only when authorization succeeded.

Execution failures emit `workspace_content.execution_failed` in the existing
`workers` logging group without replacing the originating validation failure.
Correlate `operation_id`, `phase`, `error_kind` and the specific `cause`;
repository diagnostics retain SQLSTATE, constraint and table under the same
operation/phase span. Organizer errors retain their exact typed variant without
formatting content-bearing row values. Specific error codes and reviewed,
server-authored reasons survive compensation and are translated in Web/Admin.
The legacy `XWS_WORKER_EXECUTION_FAILED` remains readable for old jobs; new
known failures do not use it. Arbitrary dependency strings remain excluded;
an unforeseen string has a diagnostic fingerprint instead of leaking content.
Admin Queue details show the durable operation even if a historical transport
job was marked completed. HTTP 200 for a GraphQL request is not proof that
the asynchronous operation succeeded.

Publication does not translate internal conflicts into `XWS_PREFLIGHT_STALE`.
That code is reserved for a genuinely changed reviewed preview. Registered
publication conditions retain their individual codes through SQL, GraphQL and
the shared translated Web/Admin catalog. `workspace_content.manifest_condition_failed`
emits one event per changed component with `operation_id`, `phase`, `cause`,
`component` and, for document checks, the internal document UUID. A related-row
change names the affected schema table, not its row contents. If several
conditions fail, all are logged separately; the first concrete cause is stored
on the operation. No aggregate manifest error replaces those events.

Extraction recovery has a `compensation` span carrying `initial_cause` separately
from its own failing `cause`. SQL failures include their SQLx variant as well as
SQLSTATE and schema-owned constraint/table names. A failure while saving recovery
state is logged as its own persistence error, not as the original publication
error. The existing central **Worker & Jobs** group controls these events; there
is no separate transfer logger or logging destination.

The operation's nullable `errorPhase` records the actual failing boundary. Older
records have no phase; do not infer one. Dependency retries retain their latest
cause/phase on exhaustion, while retry counts and queue budgets remain secondary
context. Cleanup errors are secondary to the original execution failure. A
committed publication receipt remains authoritative and successful publication
clears obsolete errors. A Tag FK violation alone does not prove outside-document
usage. These diagnostics cannot reconstruct exceptions discarded by an older release.

## Permanent deletion and folder references

Permanent document deletion removes the document's Organizer rows and index
entries in the same transaction as the document identity, page directory and
durable realtime outbox. Trash alone does not remove the placement. Deleted
documents are never restored as a cleanup action.

At startup the server automatically removes remaining Organizer references to
identities with durable permanent-deletion evidence from older releases. There
is no manual repair preview or approval step. Missing SQL rows, moved documents
and trash entries alone are not deletion evidence. Organizer update ingress
applies the same final cleanup so a late offline delivery cannot reintroduce
a link to a permanently deleted identity. Failures identify the workspace and
phase in structured logs; they are not reported as successful cleanup.

Move/Extract retain source Tag catalog records and aliases, even with zero usages.
Only departing assignments move, with remapped target IDs; Database cells,
templates and saved Tag filters follow that same plan. Publication does not defer
the Tag-assignment FK and does not redirect a source Tag that remains present.
Undo restores unchanged ordered classifications from the hash/receipt-bound Move
manifest, preserving both catalogs and independent usages. Changed/added values
resolve by current name/archive semantics. Deleted original IDs are never recreated.
Extract Undo restores its original folder slot only when the remaining Workspace
link still points to the receipt's extracted target. It retains the slot's parent
and order; unrelated or retargeted entries cannot be overwritten. A missing slot
can be restored as a root folder. Pre-cutover counter-operation manifests require
a fresh preview rather than reinterpretation of their persisted projection.
Search projections and workspace caches refresh through the committed outbox;
projection failure leaves the event pending for retry, without undoing publication.

Before upgrading, drain old admitted Tag relocation jobs on their original release.
Undrained plans require a fresh preview with `XWS_PREFLIGHT_STALE` and use existing
unpublished-effect compensation. Never repair their product rows, rewrite receipts
or replay historical terminal jobs on the new publisher.

Untitled documents and document titles containing whitespace are valid content,
not malformed resource names. Preflight preserves those titles and still requires
the authoritative internal document ID for permission checks.
An obsolete document-graph projection alone is not proof of an extraction blocker:
preflight reads typed references from the current leaf and resolves external keys
against active documents in the source workspace. It never derives a SQL UUID
from an external key or resolves a same-named key from another workspace.

## Recovery actions

| State                                       | Action                                                                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `queued` or `running`                       | Wait for SQL reconciliation to emit another idempotent Redis wake-up.                                                                                                                                                                            |
| `failed`                                    | Read the redacted code/reason. The originating actor may retry Move/Copy/Link only while current authorization and the preflight revision still match. A failed Extract requires a fresh folder preflight because its hidden target was removed. |
| `cleanup_required` after semantic execution | An administrator may use `resumeWorkspaceContentCleanup`; the worker reloads durable state.                                                                                                                                                      |
| `cleanup_required` after cancellation       | An administrator must use `cleanupCancelledWorkspaceContentOperation`; it deletes only unpublished operation-owned staging.                                                                                                                      |
| `succeeded`                                 | Never run cleanup. Use the permission-checked redirect or prepare an Undo counter-operation.                                                                                                                                                     |

The two cleanup actions are intentionally disjoint. For Extract failure cleanup,
`resumeWorkspaceContentCleanup` keeps the operation in `cleanup_required` and
resumes compensation only, with
the original redacted failure retained. A concurrent user cancellation remains
`cancelled` after compensation instead of being overwritten by a worker failure.
Cancellation cleanup cannot resume publication, and semantic recovery cannot
delete published staging.
Every operator action is recorded in the existing audit store.

Git-enabled Extract uses the explicit choice in the existing dialog. Its SQL
publisher and metadata worker distinguish content success
from external completion: `gitSyncPending`, `gitSyncErrorCode` and
`gitSyncRetryExhausted` accompany the unchanged `succeeded` state. A pending
receipt is never a failed content move and must not be cleaned up or extracted
again. Target editing and source sync remain available; target Git runs wait.
After repairing the current credential or remote cause, the originating actor
uses the existing Retry action with current Git-management permission on both
Workspaces. It wakes the same `<operation-id>:git` job. Exhausted/permanent
failures wait for this explicit Retry rather than restarting every reconciliation
pass. Undo, scope/profile mutation and hard deletion wait for metadata completion.
`XWS_GIT_SYNC_REMOTE_UNAVAILABLE` identifies a retryable remote/writer outage;
`XWS_GIT_SYNC_METADATA_AUTH_DENIED` requires current credential or write-access
repair, and `XWS_GIT_SYNC_METADATA_CONFLICT` requires review of changed ownership
or bytes. None of these codes means content publication should be repeated.
The worker records its prepared commit before push and recognizes an already
applied ancestor after lost acknowledgement, preserving later sibling work.

Disconnect publishes the usable Workspace without writing Git or creating a
target Git profile. `XWS_GIT_SYNC_OUTBOUND_CLEANUP_PENDING` means detached files
are retained and metadata cleanup waits for a permitted outbound source run.
Read-only and disabled profiles stay unchanged; an authorized operator may
explicitly repair direction/enablement, then run the source sync. Retry alone
does not grant a write or bypass that prerequisite. Scope changes and deletion
remain blocked while the receipt is pending. After the source run drops stale
manifest membership, cleanup deletes only unchanged, positively owned generated
outputs. Authored/edited files, shared assets and delegated descendants remain;
an external file reintroduced after a proven deletion is not deleted again.

Git-aware Undo remains the existing counter-Move, not a rollback or a second
Extract. `XWS_GIT_SYNC_UNDO_PENDING` requires completing outstanding metadata
first. `XWS_GIT_SYNC_UNDO_OWNERSHIP_CHANGED` means the receipt's root, fences,
binding identities or target configuration no longer match;
`XWS_GIT_SYNC_UNDO_CONTENT_CHANGED` means current Git bytes cannot be safely
reversed. `XWS_GIT_SYNC_UNDO_TARGET_NOT_EMPTY` protects independently added target
contents. Do not remove those guards, rewrite an old secret or delete the Git
subtree to force Undo.
The pending prerequisite also protects active/recovery runs, rotation and open
conflicts affected by reversal. An unrelated source conflict is not discarded
or resolved by Undo.

After accepted Undo publication, current documents are back in the source while
the original receipt retains pending inverse metadata under the counter-Move ID.
The source fence remains until authenticated metadata completion, so remaining
source sync stays scoped. Retry uses that counter-Move, never another Extract.
The same Git worker restores only unchanged receipt-owned frontmatter/manifests
and generated structural output from immutable Git history; intervening Myoxus
edits wait for the next normal sync. Verified completion removes the exact
originating fence and the unchanged receipt-created target profile. Source
configuration/current credentials and existing delegated descendants survive.

`cancelled` means an explicit actor cancellation. Worker failures must end in
`failed` after successful compensation or `cleanup_required` when unpublished
operation-owned cleanup is incomplete. If a worker error leaves an operation in
`queued` or `running` beyond the configured retry budget, treat that as a stale
deployment or persistence fault; do not rewrite the row to `cancelled`.

## Redis and notifications

Move and Extract create one persistent `workspace_content_moved` Inbox item per
publication-time recipient. Redis socket fanout is an acceleration after
persistence. During a Redis outage, leave recipient outbox rows pending and
restore Redis; do not enable local notification fanout or replay notifications
manually. Redis carries only the notification ID and stable type; notification
body data remains in PostgreSQL. The stable idempotency key prevents duplicate
Inbox rows.
Retained Source Blob catalogs are not counted as departed content in these
summaries; document details retain the existing recipient read checks.

Document collaboration uses a separate durable
`workspace_doc_broadcast` outbox. A pending event whose referenced document
update was removed by later workspace/document cleanup is terminally stale:
the consumer records the bounded `dropped` outcome and continues with younger
events. Repeated warnings for the same event ID indicate that the deployed
consumer is stale or cannot persist its processed marker; do not delete newer
outbox rows or replay Yjs payloads manually.

## Escalation

Escalate when the same operation remains `cleanup_required` after the matching
operator action, when a redacted terminal error repeats after dependency
recovery, or when publication receipts and operation status disagree. Preserve
the operation ID, timestamps, redacted status, queue state, and dependency
health. Do not collect content or credentials.

## Collection transfer cutover

Collections remain editable source catalogs. They cannot be selected for Copy,
Move or workspace-operation Link, including mixed selections. A folder may still
contain a Collection shortcut: publication preserves its actual source workspace
qualification without adopting its definition, rules or lateral documents.
Ordinary navigation still checks source access; a shortcut grants no access.

Before upgrading, finish or cancel queued/running legacy Collection operations
on the old release, including cleanup of unpublished staging. After upgrading,
old previews require a fresh preview; retry and Undo of Collection ownership
plans return `XWS_SELECTED_RESOURCE_UNSUPPORTED`. Historical committed receipts
remain readable. Do not rewrite receipts, bypass permissions or restore a removed
Collection publisher to retry a legacy plan.

## Typed copy identities and attachments

Copy uses separate operation-private document/Blob namespaces and preserves
ordinary text and native editor IDs. Selected references follow the clone map;
valid outgoing document references keep their actual workspace. Database Files,
template values and selected relations are published through typed mappings.
A copied template body belongs to its Database binding and does not replace a
central workspace template instance. Source documents and assets remain intact.
Unknown SQL commit outcomes retain bytes for the existing cleanup/recovery path;
cleanup cannot delete a committed or reused canonical Blob. Incompatible older
unexecuted document staging needs a fresh preview. Completed receipts remain
readable; do not guess-convert or automatically rerun older jobs.

Move/Extract/Undo preserve document and Database SQL identities. A route-key
collision allocates a free local route without overwriting the destination.
Current native, Database Files/template and comment-attachment addresses follow
the admitted typed map. Blob source metadata, bytes and usage remain intact;
Undo returns content ownership and verifies/copies assets, not Blob ownership.
Historical display and restore consume exact immutable-snapshot lineage through
all committed transfers. Unknown legacy origin stays unavailable. Old queued
reference plans require fresh admission; never guess-convert terminal receipts.

Copy and Extract staging keep independently mapped assets separate even when
bytes are identical. New object keys include the operation's bound manifest
sequence and digest. Existing verified durable staging keys remain valid on
replay; a repeated digest is not a reason to merge resources or drop assets.

Move/Undo followed by a new Move or Extract replaces the previous hop for the
newly departed address. Existing receipts remain historical; redirects continue
to check current target access and give a live source address precedence.

## Contained reference omission

Copy/Move/Extract/Undo omit proved missing/deleted or decoded malformed contained
Organizer/native references and missing SQL-UUID Database DocumentLink values.
The folder, readable text and valid child content survive. Copy preserves its
source; unselected source entries are not repaired. Valid outgoing links keep
their qualification and target access guards.

Missing selected roots, owned data or attachment bytes still fail with the
specific cause, phase and operation ID. Denial, unknown existence and decoder/
storage failures never justify deletion. There is no replacement warning or
repair command. Re-preview incompatible old previews; do not rewrite terminal
receipts or committed history lineage.

## Optional Project setup recovery

Use the original actor, Workspace and request key to read `workspace.projectSetup`
or the corresponding CLI/MCP Project status operation. The existing starter
ledger owns the Project, selected document and folder identities. Readback
separates created documents from completed placement and checks current access;
a matching title or inventory entry is not acknowledgement.

Resume the accepted request through its native creation operation. Review any
changed managed effects explicitly; do not edit stored inputs, source pins or
receipt JSON. Stop requests preserve the Workspace, its protected Tasks and
partial results. Wait for terminal Stopped before deliberately starting a new
setup. A deleted result remains unavailable under the original key and is never
silently recreated. Completed copies retain subsequent edits.
