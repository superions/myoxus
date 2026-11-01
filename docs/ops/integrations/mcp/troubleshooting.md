# MCP troubleshooting

`resources/list` returns an empty inventory when the key lacks `read:workspaces`
or the authorized actor has no workspaces. A Workspace storage failure returns
JSON-RPC error `-32002` with a safe unavailable message; retry discovery after
restoring the backend. It is not a successful empty inventory.

Validate successful responses against the tool’s discovered `outputSchema`, including its referenced definitions and variants. A disabled template/PDF registry can return a diagnostic `message` instead of an inventory. Folder text summaries need not equal the full `structuredContent`; base64 blob payloads remain encoded.

[Documentation](../../../README.md) / [Operations](../../README.md) / [Integrations](../README.md) / [MCP](./README.md)

Use the active global `/mcp` endpoint with an MCP API key. The workspace bridge
under `/api/workspaces/<id>/mcp/` is not the product tool endpoint.

<details>
<summary>On this page</summary>

- [Authentication](#authentication)
- [Initialize and discovery](#initialize-and-discovery)
- [Tool failures](#tool-failures)
- [Safe write retries](#safe-write-retries)
- [Unicode text replacement](#unicode-text-replacement)
- [Organizer order-key repair](#organizer-order-key-repair)
- [Bounded document projection repair](#bounded-document-projection-repair)
- [Document normalization loss](#document-normalization-loss)
- [Document search continuation](#document-search-continuation)
- [Native text formatting](#native-text-formatting)
- [Missing table headers](#missing-table-headers)
- [Native table cell edits](#native-table-cell-edits)
- [Named version reads](#named-version-reads)

</details>

## Authentication

- HTTP 401 means the Bearer header is missing, malformed, revoked or expired.

The endpoint uses the native rmcp Streamable HTTP service. Raw HTTP probes must
send `Content-Type: application/json` and
`Accept: application/json, text/event-stream`; malformed transport requests use
SDK HTTP errors rather than the former always-200 parser. A rejected Host or
Origin must be corrected to the server's configured public origin (or loopback
for direct operations), not bypassed by disabling SDK validation. POST bodies
remain bounded to 2 MiB. Modern `2026-07-28` callers use `server/discover` and
per-request protocol/capability metadata; older callers retain `initialize`.
Modern callers must also supply `Mcp-Method` and the applicable `Mcp-Name`
standard headers. SDK-backed clients generate them; raw HTTP probes must not
omit them. Invalid JSON receives HTTP 415 from rmcp.

- A structured `SCOPE_DENIED` tool result means the key lacks the exact scope.
- `PERMISSION_DENIED` means the key scope is present but the key owner lacks the
  target workspace or object ACL.
- Never place API keys, tool arguments or returned document content in support
  logs. Rotate a key that was exposed.

## Initialize and discovery

- Supported protocol versions are `2024-11-05`, `2025-06-18` and
  `2025-11-25`. An unknown requested version negotiates to `2025-11-25`.
- An empty or reduced `tools/list` is usually caused by key scopes or optional
  services not being wired. It is not evidence that handlers were removed.
- Follow `nextCursor` until it is absent. Cursors are opaque and specific to the
  visible tool set.
- `resources/subscribe` is not implemented and correctly returns JSON-RPC
  `-32601`; `resources.subscribe=false` is advertised during initialization.

### Client configuration

| Symptom                                          | Safe diagnosis                                                                                                      | Resolution                                                                                       | Escalate when                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Codex lists Myoxus but sends no Bearer token     | Run `codex mcp get myoxus --json`; inspect only the URL and `bearer_token_env_var`, never the token value.          | Export the named variable in the Codex process environment and restart the client.               | A generic initialize with the same environment token succeeds but Codex still receives HTTP 401.      |
| Copilot does not load the server                 | Run `copilot mcp get myoxus --json`; verify `type=http`, URL and that the header uses `${COPILOT_MCP_*}` expansion. | Export the referenced variable before launching Copilot. Check enterprise MCP allow/deny policy. | Generic HTTP succeeds and enterprise policy allows the endpoint, but Copilot still cannot initialize. |
| Client sees fewer tools than documentation       | Follow all `nextCursor` values, then compare the key scopes and enabled optional services.                          | Issue the smallest corrected scope set or enable the owning service; do not widen ACLs.          | The complete pagination returns duplicate tools, invalid schemas or a tool outside the key scopes.    |
| Client displays text but ignores structured data | Inspect one call result and compare parsed `content[0].text` with `structuredContent`.                              | Upgrade/configure the client to consume structured results; Myoxus retains both projections.     | The two projections differ; this is a server contract defect.                                         |

For a reproducible served-runtime check, use the explicit matrix suite
`mcp.client-runtime.smoke`. Its output is redacted and records source/served
revision, image digest, versions and negotiated protocol. Never attach client
configuration files or command output containing authorization headers to a
support ticket.

## Tool failures

Known-tool failures are normal JSON-RPC results with `isError=true` and a
structured `{ code, message, retryable }` payload. Retry only when `retryable`
is true. Unknown tool names are JSON-RPC `-32601` errors. Backend SQL, Redis and
payload details are intentionally redacted from client responses; inspect the
server's `mcp` tracing group and low-cardinality MCP metrics for correlation.

### Document identity

- Carry `externalId` returned by `list_pages`, `search_docs` or `create_page`
  unchanged into the next tool's `external_id`, together with the owning
  `workspace_id`. NanoID-shaped and UUID-shaped external keys are both opaque
  workspace-local values.
- Never substitute an internal `docs.id` UUID or infer a workspace from a
  document key. A not-found result after changing workspaces is the expected
  isolation boundary.
- Calendar links use `source_external_id` on writes and `sourceExternalId` in
  results. Resources use `myoxus://<workspace_id>/<external-key>`.
- `page_projection_inspect` intentionally retains `external_doc_id`; this is
  the explicit bounded repair selector, not a core-tool compatibility alias.

Calendar clients must retain null recurrence/document links and accept empty
event/conflict lists. A missing required result member is a server contract defect.

For OU lifecycle results, keep the returned parent/null metadata and preview
revision. Nonempty delete blockers are valid successful preview results, not
transport errors; permanent deletion still requires an unblocked current preview.

### Database calls

When checking a Database response against `outputSchema`, retain nullable
members and UUID-keyed maps. Missing required fields or malformed cell variants
are server contract defects; do not invent columns from discovery metadata.

- `MIX_DATABASE_VIEW_*` from `database_query` means the referenced saved view
  or its searchable-field configuration is no longer valid. Repair the
  Database/view through the product UI and restart from a cursorless query;
  never edit filter JSON in the MCP client.
- An invalid cursor returns `-32602`. Cursors are opaque and belong to the
  exact Database/view/search traversal that produced them.
- A row update failure after one field was removed or changed type means the
  complete patch batch was rolled back. Re-read the row and Database schema,
  then retry the corrected payload with a new idempotency key.
- Row not-found after `database_row_delete` is expected. Use
  `database_row_restore` with the same Database and row IDs; MCP does not expose
  permanent row deletion.
- Correlate failures by bounded `tool`, `outcome`, `access` and `target_type`
  metric labels. Audit rows contain Database/row IDs but never search text,
  saved filters or cell values.

For runtime status and redacted logs use the repository stack wrappers:

```bash
build/scripts/server/stack-status.sh
build/scripts/server/stack-logs.sh api
```

## Safe write retries

- Reuse an `idempotency_key` only for the same tool and semantically identical
  input. `MIX_MCP_IDEMPOTENCY_CONFLICT` (`-32010`) means the key was already
  bound to different input; choose a new key only for the intentionally changed
  command.
- `MIX_MCP_IDEMPOTENCY_IN_PROGRESS` (`-32010`, `retryable=true`) means an
  identical call has an outstanding admission. It may still be running; legacy
  or unacknowledged composed writes can also retain unknown effects. Wait and
  retry the same key and payload; if the original invocation has stopped,
  investigate its resource through the existing owner before repairing it. Do
  not submit a second key, because that would authorize a second mutation.
- A completed retry returns the original response. It does not emit another
  domain mutation, outbox event or mutation audit.
- Keyed document create/patch/rename/replace-all/trash/restore commit their
  outcome with the document transaction. After an interrupted response, repeat
  the identical call. Recovered content readback may be explicitly unavailable;
  `read_doc` obtains current content without re-executing the write.
- A proven rolled-back document failure releases its pending guard. An abandoned
  new pre-commit admission is recoverable after 60 seconds; a live writer remains
  fenced from overlapping retries. Legacy pending rows have unknown effects and
  require investigation instead of expiration or blind replay.
- `RECOVERY_REQUIRED` (`retryable=true`) means completion durability is uncertain.
  Keep the same tool, key and payload. A new key can create a duplicate write.
  Inspect redacted MCP logs if that same-key recovery remains unavailable.
- Revoked API keys cannot replay: authentication fails and their replay rows
  are cascade-deleted. Never replace a revoked key merely to recover an old
  response.

### Interrupted composed writes

`document_import` commits a bounded creation receipt with the page, including
the preallocated Organizer entry identity. Placement or compensation cannot
erase that receipt. A fully completed import replays its original success.
An interrupted import returns `RECOVERY_REQUIRED` with `retryable=false`, the
existing external/entry identities and its last durable step (`created`,
`compensating`, `compensated` or `compensation_incomplete`). This is an explicit
recovery failure, not permission to create another page. Inspect that page and
its folder entries through the existing read tools. The last durable step does
not prove an overlapping original invocation has stopped; establish that before
repairing its placement or cleanup. Complete placement or
cleanup of those identities through the existing document/Organizer owners.
The replay checks current workspace authority and document Read again.

Compensation removes placement before trashing the target. If entry removal is
uncertain, the target remains live so a possibly published entry never points
at a newly trashed page. Uncertain metadata/placement cleanup follows the same
rule in the existing template owner; no template workflow is added.

Other shared-guard writes retain admission when an error does not prove
rollback, including template calls and failures during post-commit readback.
They return an explicit uncertain outcome on retry rather than automatically
executing again. Investigate the existing resource using its owning tools;
never change the key to bypass recovery. A missing optional service is checked
before admission where it can be established without a write.

Shipped write tools accept an optional key for compatibility and remain
non-idempotent when it is omitted. Newer tools whose schema requires the key
must not be called without one. Use `tools/list` as the authoritative schema for
the connected server.

## Unicode text replacement

For `doc_patch` / `edit_text`, omitted `range_unit` means UTF-8 bytes; JavaScript
string positions need `utf16_code_units`. `unicode_scalars` counts each combining
mark separately. `MIX_DOCUMENT_MUTATION_TEXT_RANGE_INVALID` rejects out-of-bounds
positions or a split UTF-8 character/UTF-16 surrogate pair before any write.
`MIX_DOCUMENT_MUTATION_EXPECTED_TEXT_MISMATCH` rejects an exact-text mismatch
without returning the protected original or the submitted expected string.
Read the current structured content and revision, calculate complete encoding
boundaries and submit an intentional corrected edit. Do not remove revision or
expected-text checks to force a stale replacement. Native embeds count as one
position but cannot be verified by an expected plain string.

## Organizer order-key repair

`MIX_ORGANIZER_REINDEX_REQUIRED` means a sibling group contains legacy-invalid
or duplicate order keys. This is a Yjs data repair independent of document
identity; it is never a SQL migration, startup action or automatic MCP write.
Use the trusted local CLI and review the default dry-run first:

```bash
myoxus-cli organizer reindex-order --workspace-id <uuid>
myoxus-cli organizer reindex-order --workspace-id <uuid> --apply
```

The report contains the planned Organizer revision, affected exact-parent
groups, row counts and before/after keys, but no document titles or content.
`--apply` plans once and appends exactly one index-only Yjs update if that
revision still matches under the canonical document lock. `unchanged` means no
repair is necessary. `MIX_ORGANIZER_REINDEX_STALE` means a collaborative write
won the race; nothing was appended, so obtain and review a new dry-run rather
than retrying the old plan.

Before any production invocation, take and verify a database backup and obtain
separate authorization for the specific workspace and dry-run. The existing
append-only Yjs history plus that pre-operation backup are the recovery
boundary. Do not run an all-workspace sweep, edit `doc_updates` or Organizer
rows with SQL, or treat a dry-run from another revision as approval. Rollback or
restore is a separately reviewed operator action; a second successful dry-run
after apply must report zero affected groups.

## Bounded document projection repair

Projection recovery is explicit and external-key scoped. Start with paginated
`page_projection_scan`, inspect one finding with `page_projection_inspect`, and
pass that exact fingerprint to one `page_projection_repair` dry-run. Scan never
decodes a leaf; inspection and repair decode at most the selected target. An
invalid cursor or `MIX_PAGE_PROJECTION_ROOT_CHANGED` requires a new cursorless
scan. `MIX_PAGE_REPAIR_REPORT_STALE` requires a new exact inspection.

The commands are never scheduled, invoked at startup, or permitted to repair a
batch. The retired `page_lifecycle_audit` and `page_lifecycle_repair` names are
intentionally unknown. Before any production apply, obtain separate operator
authorization for the exact workspace/key, verify a current backup, review the
dry-run, and follow the
[Document Projection Repair runbook](../../runbooks/document-lifecycle-repair.md).

## Document normalization loss

When a write returns normalization findings:

1. Inspect each finding's code and source path against the input.
2. Correct unsupported structure or deliberately accept the reported conversion.
3. Use `strict_loss: true` to reject a lossy conversion before writing.
4. Reuse the original key and payload after an interrupted committed response;
   read back the document to inspect its current content.

The [normalization contract](./README.md#document-normalization-loss) defines
supported transformations, formula preservation and the returned diagnostics.

## Document search continuation

- `MIX_MCP_SEARCH_CURSOR_INVALID` means the cursor is malformed, changed, or
  belongs to another query, language, workspace or authenticated user. Restart
  without a cursor; keep the query/language context identical between pages.
- Follow `next_cursor` until `exhausted` is true. An empty page with a cursor
  reflects the bounded candidate scan; it does not declare global exhaustion.
- `total_count` is the returned page count, not all indexed or accessible hits.
  Current access checks suppress denied, deleted and stale candidates; an older
  cursor does not preserve revoked access.
- Search indexing is asynchronous. A recent write may be directly readable
  before it appears in search. Cursors traverse the current index, so concurrent
  index changes may reorder matches; they do not hold an immutable snapshot.

## Native text formatting

Use `format_text` with a nonempty `formatting` object and a nonempty native
text range. Omitted marks remain unchanged; false flags or link `remove` delete
only those attributes. Nulls, unknown attributes, unsafe links and mismatched
Unicode boundaries fail before a content write. Link errors are redacted; check
the canonical allowed schemes and the 4,096-byte input/normalized URL bound.
`expected_text` checks exact, unnormalized original text under the content lock;
a revision conflict requires rereading the current document. Preserve the
original idempotency key and payload for a retry, including the chosen range
unit and precondition. Current permissions apply even to an earlier receipt.

For color/background/label changes, use palette or tone names in typed
`set`/`remove` objects, not RGB, CSS or null. Foreground and background use
different native theme variables. Read `native.fields` on the returned block
for exact source offsets; visible math/link labels are not native text positions.

For rich replacement, supply `replacement_spans` without `replacement`, even
when plain replacement would be empty. New runs do not inherit neighboring
marks. Reuse `native.fields` positions and the named callout `text_field`
(`text`/`title`); table formatting requires both stable coordinate IDs.
An absent callout title accepts insertion at 0–0; a title on another kind,
missing cell or rich code edit rejects without changing the document.

Callout titles appear in Web only when `calloutType` is set. Both Web and MCP
edit titles as single-line plain text. Use `replacement`, not rich spans or
`format_text`, for `text_field: "title"`.

For an inline document reference, supply exactly one native space plus `reference: { pageId, title? }`; the rendered label has no editable source offsets of its own. Replace the complete protected span. Missing/inaccessible targets fail before admission, including retries whose target access was revoked. Do not add native navigation params; select a public external document key in the same workspace.

## Literal annotations

Use `annotationId` only with literal text and plain/default marks. Read the
assigned native identity after insertion; the input key is local to that
insertion. For `edit_annotation`, pass `annotation_id` and `start` from the first
run of the complete contiguous body, plus optional `range_unit`, `expected_text`
and paired cell coordinates. An interior run's offset or another identity is
refused. The expected text covers the whole body, even when formatting splits
native runs. Empty replacement removes that body only.

Standalone blocks appear in private structured reads with
`native.kind: "myoxus:annotation"` and the original `text` field. Use plain
`edit_text` for their body and existing `delete_block` for the block. Public
renderer/search omission and Markdown import/export behavior are unchanged.

## Formulas

An inline formula is one native space plus `latex: "<LaTeX source>"`; it
admits no other marks or semantic atoms. `kind: "latex"` creates a block
formula written to the native `myoxus:latex` block (plain-string source), not
a code block or a format conversion. To edit a block formula's source, use
`update_block_properties` with a `latex` field; omission preserves the source,
an explicit empty string clears it, and non-`myoxus:latex` targets are
rejected.
Private native readback exposes the block source as a single plain `source`
field and the inline formula's `latex` attribute on its protected span.
Markdown import retains its existing `Code { native_latex: true }` readback
projection.

## Footnotes

A local footnote definition is renamed with `update_block_properties`
`label` (set-only; it must pass the Markdown footnote-label grammar and not
collide with an existing definition, footnoteIdentifier or marker, compared
normalized) and repositioned with `placement`
`{ "action": "set", "value": "footnote" | "endnote" }` or
`{ "action": "remove" }`. A rename updates the definition and every marker
carrying its identity (body, title and table cells) in one mutation; the
collision check runs before any write, so a rejected rename leaves no effect
and no revision change. `placement` removal reverts to the legacy
absent-footnote default without rewriting stored data. The definition's
native ID is preserved. Private native readback exposes the typed marker
payload (label, definitionId, reference) and the definition's
label/placement.

## Citations

`doc_patch` with `operation: "update_citation"` renames or replaces the
canonical source of an existing citation by `label` (normalized comparison),
supplying at least one of `new_label` or a typed `reference`
(`doc` / `url` / `attachment`). The inline citation marker is authoritative;
the optional source card is patched in place for same-flavour updates and
replaced with a fresh block ID at the same parent/position for
cross-flavour updates. Target authorization is rechecked before
idempotency admission, including exact replay: `doc` targets require current
Read on the referenced document, `attachment` targets require current blob
read, and `url` targets need no target check. A missing source, label
collision or conflicting inline source rejects before any write, leaving no
revision change. `update_block_properties` `url`/`title` on a citation
bookmark card routes through the same updater.
Do not send null for an unchanged `new_label`, `reference` or block property;
omit it. Remove unknown fields and fields belonging to a different reference
type instead of expecting them to be ignored. Explicit `workspaceId` values
must be UUID strings; empty, null or whitespace-padded values never select the
document workspace. Conflicting inline sources must be resolved explicitly;
neither a replacement reference nor a card edit implicitly repairs them.

## Missing table headers

A table's first row can contain labels without being a designated header.
GFM import through MCP and the direct editor now persists exactly one header
row. Structured creation accepts zero, one or multiple leading `headerRows`;
omission preserves an absent native property. Follow
[Document table headers](./README.md#document-table-headers) for creation and
`read_doc` verification. Existing tables are unchanged; correct their count
through `doc_patch` with `operation: "update_block_properties"` and
`properties: { "headerRows": 1 }`, or through editor Table settings. Read the
current table block ID and revision first; use zero to remove designation.
Counts outside the current row range or including a repeat prototype are
rejected without effects. Bold text alone does not designate a header.
Historical completed Markdown retries retain their original response. A pending
historical request whose normalization changed remains in progress; resolve its
original outcome rather than issuing another key to repeat uncertain work.

## Native table cell edits

Use the target table's `document.tableIdentities[blockId]` from structured
`read_doc`, not guessed numeric coordinates or Database row IDs. The matching
`rowIds`/`columnIds` preserve native ordering. A missing table, declared row,
column or cell TextRef fails without creating a cell. Legacy layouts without
these native coordinates retain their existing reading projection.
`edit_table_cell` takes plain `replacement`, `start` and `end`, with the same
range units and optional exact original text/revision checks as `edit_text`.
The replacement limit is 1,048,576 Unicode characters. A stale revision or
changed original span requires rereading; an interrupted identical write uses
the original durable key, payload and precondition. Read-only keys and current
revoked Update permission remain denied, including receipt replays.

## Named version reads

A missing named snapshot or a version belonging to another workspace/document
returns not-found. Use the exact ID returned by version listing/creation; no
nearest-time or live fallback exists. A continuation belongs to one version,
snapshot and reader. Changed or cross-context cursors fail with
`MIX_MCP_DOCUMENT_CURSOR_INVALID`; restart that exact version without a cursor.
Live document edits do not stale immutable pages. Permission revocation still
blocks subsequent pages, even with a previously valid cursor. Inspect
`projection.complete` and its extraction diagnostics for unsupported native
content. Oversized blocks or envelopes fail explicitly rather than truncating
content; reduce the page limit when the combined envelope is too large.

## Workspace creation

`workspace_create` requires `write:workspaces` and a durable `idempotency_key`.
An optional normalized `name` uses the existing Workspace naming rules and
conflict suggestions. Without `owner_unit_id`, the current active key owner
owns the new user-owned Workspace; arbitrary user-owner selection is rejected.
An active organization-unit owner requires a fresh global administrator.
The shared WorkspaceService provisions ownership, the root and configured
template defaults. MCP initializes the user-owned root through the same service
with the final normalized name; GraphQL retains its optional-upload behavior.
Success returns `id`, `classification` and `initialized: true`. Authorization
is checked again before replay. A provisioning failure after possible durable
effects returns `RECOVERY_REQUIRED` with `retryable: false`; inspect the
original Workspace inventory and repair through its owning operations. Neither
the same key nor a new key is a safe way to repeat an uncertain creation.

## Workspace trash and recovery

`workspace_delete` requires `write:workspaces`, current `WorkspaceAction::Delete`,
`workspace_id`, `confirm: true` and a durable `idempotency_key`. It returns the
original `id` and `deleted: true` after soft deletion. Trash retains content,
history and blobs and removes ordinary access; a trashed target therefore also
loses ordinary Delete replay authority. `workspace_restore` requires the same
scope, ID and key plus a fresh global administrator. Its lifecycle owner
revalidates the original principal, name reservation, personal uniqueness,
required membership and OU ownership before recovering the same ID/content.
It returns `id` and `restored: true`; already active targets are idempotent.
Current global authority is checked before replay. Name conflicts include the
existing deterministic suggestion. Uncertain writes require inspection and
never authorize repeating the effect with another key. Permanent purge is not
an MCP capability. Old purge jobs skip every retained Workspace record, and
maintenance does not classify trash or archives as orphaned blob owners.

### Workspace members

`workspace_member_list` requires `read:workspaces` and current `UsersRead`;
its accepted-member inventory returns bounded pages (1–200, default 50), an
optional name/email query and `next_offset`. `workspace_member_add` requires
`write:workspaces`, a fresh global administrator and an exact active user;
it uses direct accepted membership, with Collaborator as the default role.
`workspace_member_set_role` and `workspace_member_remove` require
`write:workspaces` and classify the current target through the shared Workspace
preflight used by GraphQL. Admin changes need `AdministratorsManage`; Owner
changes use ownership transfer. Effective OU-manager authority applies to
ordinary member management without creating direct or OU membership.

All three writes require `idempotency_key`. Current actor/target authority is
checked before replay; removed targets cannot authorize removal replay.
Self-revoke, inactive/deleted targets and protected Owner operations are refused.
Existing transactional last-active-admin protection and membership effects
remain authoritative. A Workspace role never grants OU-manager capability.

### Workspace invitations

`workspace_member_invite` requires `write:workspaces`, current `UsersManage`
and an exact active recipient. It creates the existing Pending/Collaborator
membership and invitation outbox intent; normal recipient acceptance remains
separate. Same-key replay returns the original receipt without another intent
or changing a subsequently accepted membership.

`workspace_invite_link_get` requires `read:workspaces` plus `UsersManage` and
returns only `workspaceId`, `active` and nullable `expiresAt`. The existing
owner treats revoked/expired links as inactive. `workspace_invite_link_create`
requires `write:workspaces`, `UsersManage`, `idempotency_key` and the shipped
`expire_time` choice (`OneDay`, `ThreeDays`, `OneWeek`, `OneMonth`). GraphQL and
MCP share Application duration and server-origin URL projection. Creation may
return the join URL to the authorized actor; state reads, tracing and audit
metadata omit join credentials. `workspace_invite_link_revoke` uses the same
write authority and durable key to revoke existing links.

Current authority precedes replay. Historical creation replay does not rotate
or reopen a revoked/expired link. Joining remains the existing flow: new link
joiners enter UnderReview, while pending invitees can accept. Revoked/expired
links refuse joining without granting membership. Uncertain composed-write
outcomes retain admission for inspection, as for other Workspace writes.

### Workspace owner and management administration

`workspace_owner_transfer` requires `write:workspaces`, `idempotency_key` and
explicit `mode`. `member` requires `user_id`, current `TransferOwner` and the
same atomic current-owner transaction as GraphQL `grantMember`. A former owner
cannot replay without regaining that authority. `principal` requires a fresh
global admin and exactly one of `user_id` or `owner_unit_id`; it uses the same
principal transaction as the trusted CLI. Active targets, personal-workspace
protection, normalized name reservation and OU last-active-admin guards remain
in the canonical owners.

`workspace_management_unit_set` requires the same write scope, a durable key,
a fresh global admin and explicit `unit_id` (UUID to set, `null` to clear).
Its existing transaction keeps the scalar management projection and managed
relationship synchronized while preserving the owner relationship. Current
actor and active Workspace/target checks precede execution and replay. Owner,
management and OU membership are separate; neither tool grants global or OU
roles. Results are original durable receipts, not a live principal inventory;
use normal GraphQL/CLI reads to inspect current state.

### Comment reads

`comment_thread_list`, `comment_reply_list` and `comment_history_list` require
`read:docs`, current `CommentsRead`, and the shared comment/attribution owners.
Use `workspace_id` and the workspace-local `external_id`; parent/comment UUIDs
must belong to that same document. Bodies retain canonical stored JSON. Authors
and editors expose only UUID/display name, including terminal historical names.
Attachment keys do not confer blob access; the existing blob authorization applies.

`offset` defaults to 0, `limit` to 50 (1–200). `next_offset` is null on a short
page; a full page can advertise a final empty page. Thread `filter` accepts
`all`, `open`, `resolved`, or `mine` (authored by the caller), applied before
pagination by the same Store query used by GraphQL. Threads include `readAt`
and `unread`; replies take `parent_comment_id`, history takes `comment_id`.
Pages also respect the configured document-export byte limit. On a size error,
request a smaller page; content is never silently truncated. Cross-document IDs
and current permission failures return no comment content.

### Comment creation

`comment_create` requires `write:docs`, current `CommentsCreate`, and a required
`idempotency_key`. Supply `workspace_id`, workspace-local `external_id`, and
canonical JSON `body`; no Markdown conversion is performed. Optional
`parent_comment_id` targets a live comment in that document, including the
existing nested-reply behavior. Optional `attachment_keys` use existing
`uploadCommentAttachment` keys (at most 100 distinct keys, 1024 bytes each).
The whole input is bounded by the configured document-export byte ceiling.

`selection_anchor` retains the existing quote/start/end/prefix/suffix model;
offsets are nonnegative byte positions, quote/context strings allow 8192
characters, and optional `doc_text` allows at most 8 Mi characters within the
whole-input byte bound. An anchor without text keeps the existing skipped-anchor
behavior. The shared Application composition now serves GraphQL and MCP;
GraphQL field names, arguments, results and valid input workflows are unchanged.

The result contains `commentId`, `parentCommentId`, `created`, actually linked
`attachmentKeys`, and the persisted `selectionAnchor` or null. Available
permission/parent/document-attachment/anchor preconditions are checked before
admission and durable creation. The existing atomic comment/notification-intent
commit precedes attachment and anchor writes. Later errors are not atomic
rollbacks: MCP returns non-retryable `RECOVERY_REQUIRED`, retains the uncertain
admission, and requires operator readback. Never retry that uncertainty with a
new key. Identical currently authorized retries replay the result without
recreating comments, bindings or recipient intents. Changed arguments conflict.
Replies and canonical mention attributes retain the existing deduplicated
recipient union and outbox; normal download authorization remains in force.

`comment_update`, `comment_set_resolved`, `comment_delete`,
`comment_thread_mark_read` and `comment_threads_mark_all_read` require
`write:docs` and a durable `idempotency_key`. Each uses `workspace_id` and the
workspace-local `external_id`; single-comment operations additionally require
`comment_id`. Update accepts canonical bounded `body`; resolution requires an
explicit boolean `resolved` (false reopens). Current document binding and the
shared action/author rule precede admission and replay. Authors retain their
`CommentsCreate` fallback for managing their own comments. Deletion is soft;
edit history remains readable, while deleted comments leave ordinary lists.

Read-state writes require current `CommentsRead`, affect only the key owner,
and report `userId`. A single mark rejects foreign, missing, deleted and reply
IDs before writing: its target must be a live top-level thread of the selected
document. Bulk marking is one document-scoped Store upsert across every live
top-level thread, including already-read threads, and returns the actual
`affectedThreads` count without a pagination cap. GraphQL shares both
corrections. Replies, other documents and other users' timestamps are untouched.
Identical authorized replay returns the original metadata/count without another
write; changed arguments conflict. Unknown admitted outcomes require operator
readback and must not be retried under a new key. Update bodies stay out of audit
metadata; read tools supply body/history readback.

### Database schema and lifecycle tools

`database_get` requires `read:databases` and returns the canonical complete
schema record (Database metadata, fields, saved views, roles and edit revisions).
Rows remain separately paginated. `database_create`, `database_update`,
`database_trash`, `database_restore` and `database_delete_permanently` require
`write:databases` and the existing durable `idempotency_key`.

Creation uses the existing title validation, Workspace CreateDoc policy and
initial table/kanban schema. Metadata/lifecycle calls preserve the current
creator-or-manager policy and require `expected_edit_revision` from the record;
optimistic comparison remains in the SQL transaction. Update omission preserves
properties; explicit `description: null` clears the description. Trash/restore
retain identities, rows, fields, saved views and attachments. Restore uses the
trash-aware owner rather than an active-only read probe.

Permanent deletion requires an already-trashed record, its captured revision,
`workspace_id` bound to that record and `confirm: true`. A completed purge returns
only its Database/Workspace IDs, original creator UUID and deletion flag. Its
same-key replay rechecks current Workspace read and creator/manager authority
using the trusted receipt; caller-supplied creator assertions are not accepted.
Changed arguments conflict. An unknown storage outcome or oversized post-write
readback retains an uncertain admission and requires operator readback; a fresh
key must not automatically repeat it. Inputs/readback obey the server document
byte ceiling and never silently truncate the schema. Audit retains IDs and
operation outcomes, never titles, descriptions, field content or row payloads.

### Database field tools

`database_field_create`, `database_field_update`, `database_field_delete` and
`database_field_reorder` require `write:databases`, current Database
creator/manager authority and a durable `idempotency_key`. They call the same
DatabaseDefinitionService commands as GraphQL. Creation accepts a canonical
`field_type` and optional complete kind-tagged `config`; omission uses the
existing type defaults. Update accepts name/config/required, never a field-type
replacement. Copy canonical config from `database_get`; unknown or incomplete
config keys are refused. Names are limited to 512 characters, config to 65536
bytes and options to 200 entries; the server document byte ceiling also applies.

Update/delete require the captured field `expected_edit_revision`. Reorder
requires every `field_ids` entry exactly once and an `expected_edit_revisions`
object mapping each UUID to its captured positive revision (at most 200 fields).
SQL compares revisions atomically and binds updates to the authorized Workspace.
Protected/foreign fields and invalid options remain governed by the existing
owner. Stable option IDs keep populated values intact when labels change;
removal uses the canonical cell/dependency/role effects. Returned fields carry
current IDs, typed config, order and revisions. Identical authorized retries
replay, changed arguments conflict, and current authority is checked again.
Formula dependencies are composed writes; unknown storage/projection outcomes
retain admission and require operator readback. Audit records IDs and outcomes,
never field names, options, formulas or cell content.

## MCP saved-view administration

`database_view_get` uses `read:databases` and the current actor's effective-view
read policy. `database_view_{create,update,delete,reorder}` use `write:databases`,
current Database manager/creator authority and required durable keys before
execution or replay. The existing Schema and View query owners preserve rows
and personal overrides; revisions never force stale writes. See
[MCP saved-view guide](README.md#mcp-saved-view-administration) for canonical config/icon
inputs, omission/null semantics, required-role replacements, bounded output and
uncertain-admission recovery. Audit carries IDs/outcome/size, never query content.

### Read-only Workspace Automation discovery

Automation reads require `read:automations` separately from `write:automations` and current Workspace Read permission. Missing tools can indicate an unavailable automation service. A null `jobId` means the optional Redis wake identity is unavailable; do not infer a missing or unexecuted job from it. Error summaries intentionally omit raw webhook/action details. For oversized list output, reduce `limit`. See the [automation read contract](README.md#read-only-workspace-automation-discovery).

The shared Rust Markdown table codec now preserves zero/multiple/absent header
counts through bounded standard HTML table blocks; exactly one header stays
GFM. Import validates table structure, basic marks/links/breaks and bounded
alignment before native writes. Active HTML, spans, nested tables and unrelated
CSS are rejected safely. The same Application codec serves MCP, CLI and Git
Sync. Newly admitted HTML cannot use historical GFM receipt comparison.
See the [table roundtrip workflow](./README.md#document-table-headers).

For new ordinary text-block properties, use a typed set/remove object, not null,
a raw value or arbitrary native keys. Wrong block kinds, a numbered start on a
non-numbered resulting list, unknown glyphs and extra reset fields are rejected.
Use `calloutType` for the semantic type, and `edit_text` with `text_field: title`
for its plain title. A numbered-list order removed through MCP can be initialized
by the existing Web list model on the next load; this is native editor behavior.

A reset acts on the locked native state. On a later load, the existing Web
model can materialize its declared required defaults (for example paragraph
`type: text` and `collapsed: false`, or a list order). Readback reports those
actual subsequent client writes; the server does not silently reapply a reset.

`presentation: eyebrow` can be set only on plain text paragraphs. Heading and
quote renderers do not apply it; explicit removal can clear a retained value.
The code `preview` flag takes effect when the editor has a preview renderer
registered for the block's language.

For `convert_block`, use `block_kind` (`paragraph`, `quote`, `heading1`–`heading6`, `bulleted`, `numbered`, `todo`). A paragraph/list flavour change retires the old ID; use `insertedBlockIds` for the next edit. Protected comments or explicit local block anchors can prevent this bounded replacement. Reread on conflict; retain the same key and arguments when recovering an uncertain response.

For `split_block`, `position` uses UTF-8 bytes unless `range_unit` is explicit.
Do not split within an annotation or encoding boundary. Empty lists require
explicit conversion/move instead of keyboard exit behavior. With expanded
children, a nonzero split creates the first child; inspect returned identities
before joining. `join_blocks` accepts only the following compatible sibling and
rejects source repeat bindings, imported anchors, comments or conflicting
metadata that would be lost. Its children become siblings at the source position.

A start split can leave an empty original list unit. It remains a valid
`read_doc` block selector and join destination, even if a reading export omits
its empty marker. Use native fields and selection identities for edit positions
and child links rather than reconstructing native structure from reading groups.

For `duplicate_block`, continue at `insertedBlockIds[0]`; source IDs remain
originals. Copied descendants and canonical annotation IDs are independent,
while local footnote markers still target the original definition. Protected
comments/import anchors, definition cards, tables/managed GFX or unsupported
children cause rejection instead of a flattened copy. Do not use a fresh key to
recover an uncertain response.

To remove a container, first preserve its title and own attributed text as
explicit content, then move its children to the intended parent and delete the
empty wrapper. Keep a wrapper when its protected/unknown content cannot be
faithfully transferred. `delete_block` deletes its remaining subtree; it does
not transfer text or children. `insert_after_block` already uses the anchor's
parent. No separate wrap/unwrap operation is needed.

Native table edits require declared flat coordinates, rectangular existing cells
and a leaf table model. Foreign IDs, unsupported child-table storage and malformed
coordinates reject without a repair pass. After last-axis deletion, use structured
`read_doc` and its surviving `tableIdentities` to insert again; public rendering's
existing empty-table limitation is unchanged.

A repeat prototype must remain outside explicit headers and retain its scoped
member expression and required cells. Moves, clears or coordinate deletion that
violate the existing repeat rules reject before persistence. These commands do
not instantiate a template. Native header counts are JS numbers, including
integral Yjs Number values. Column widths must be finite and at least 60;
240 is an automatic-width fallback, not a resize maximum. Set/remove changes
leave all omitted native values, GFM alignments and defaults untouched.

### Native person mention rejected or absent in private readback

Use one space plus `mention: { member: "<member-uuid>" }`; use the existing
workspace member inventory rather than a display name or global user ID search.
The caller needs current UsersRead authority and the selected person must be
an active accepted member of this workspace. These checks also run on replay.
`MIX_MCP_DOCUMENT_MEMBER_UNAVAILABLE` deliberately does not distinguish foreign,
missing or inactive identities. `MIX_MCP_DOCUMENT_MEMBER_LOOKUP_FAILED` means
the existing membership service could not resolve the request; no write occurs.

Optional native mention metadata is omitted after permission or membership
changes, even from cached receipts. The underlying historical atom remains
untouched. Retarget through a complete native range replacement, without a
notification ID; text editing does not dispatch `mention_user` or erase links
on other mentions.
