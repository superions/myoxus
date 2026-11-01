# Myoxus MCP integration

`resources/list` returns an empty inventory when the key lacks `read:workspaces`
or the authorized actor has no workspaces. A Workspace storage failure returns
JSON-RPC error `-32002` with a safe unavailable message; retry discovery after
restoring the backend. It is not a successful empty inventory.

Every discovered tool declares its concrete output schema. Keep `structuredContent` as the authoritative folder payload when text is a short summary. Blob reads retain base64 bytes; absent page continuation cursors are omitted. Disabled template/PDF registries return a successful diagnostic message, and reconcile only reports state.

[Documentation](../../../README.md) / [Operations](../../README.md) / [Integrations](../README.md)

Client examples and recovery:

- [Claude Desktop configuration](./claude_desktop_config.json)
- [Cursor configuration](./cursor_mcp.json)
- [Troubleshooting](./troubleshooting.md)

Myoxus exposes a server-hosted Model Context Protocol (MCP) endpoint at
`/mcp`. MCP clients can search, read, create, patch, update, soft-delete,
version, and metadata-edit documents, can manage workspace folders and folder
entries, can read controlled workspace blob data, and can operate
server-backed Databases, Document Graph, Template Suggestions and Automation
retry tools when the API key and the key owner both have the required
permissions.

<details>
<summary>On this page</summary>

- [Endpoint](#endpoint)
- [Protocol and discovery](#protocol-and-discovery)
- [Document resources](#document-resources)
- [Document discovery and metadata](#document-discovery-and-metadata)
- [Create an API key](#create-an-api-key)
- [Global user administration](#global-user-administration)
- [Scopes and permissions](#scopes-and-permissions)
- [Tool overview](#tool-overview)
- [Document templates](#document-templates)
- [Write idempotency](#write-idempotency)
- [Reading and editing documents](#reading-and-editing-documents)
- [Generic streamable HTTP configuration](#generic-streamable-http-configuration)
- [Codex CLI configuration](#codex-cli-configuration)
- [GitHub Copilot CLI configuration](#github-copilot-cli-configuration)
- [Other client configuration](#other-client-configuration)
- [Resource URIs](#resource-uris)
- [Feature gate](#feature-gate)
- [Security notes](#security-notes)
- [Observability](#observability)
- [Runtime verification](#runtime-verification)
- [Document normalization loss](#document-normalization-loss)
- [Continue document search](#continue-document-search)
- [Format a native text span](#format-a-native-text-span)
- [Document table headers](#document-table-headers)
- [Edit one native table cell](#edit-one-native-table-cell)
- [Read one named version](#read-one-named-version)
- [Restore one named version](#restore-one-named-version)
- [Create, poll, download and inspect a PDF](#create-poll-download-and-inspect-a-pdf)

</details>

## Endpoint

Use the global endpoint:

```text
http://localhost:3001/mcp
```

Do not configure MCP clients against `/api/workspaces/{workspace_id}/mcp/`.
That route is only a legacy session-authenticated compatibility bridge and does
not expose the active tool list.

## Protocol and discovery

The endpoint negotiates `2024-11-05`, `2025-06-18` and `2025-11-25` and falls
back to the newest verified version when a client requests an unknown version.
`tools/list` is credential-specific: it omits tools outside the key's scopes and
tools whose optional server service is not running. Results are paginated with
an opaque `nextCursor`; clients must pass that value back without decoding or
modifying it.

Successful tool calls always contain text content and additionally expose the
authoritative JSON object as `structuredContent`. Existing tools retain their
identical JSON text projection; new payload-heavy reads such as `folder_tree`
use a short text summary so clients do not pay for the full tree twice. A known
tool can return `isError=true` with a stable error code and retry hint. JSON-RPC
errors are reserved for malformed requests, unknown methods and unknown tool
names.

Database tools advertise precise output schemas. Nullable values and empty
collections are valid; row-template default maps use field UUIDs as keys.
Response names and JSON/text projections remain unchanged.

Calendar discovery includes exact event/conflict/delete output schemas.
Nullable recurrence links and empty windows are valid; list results stay bounded.

OU lifecycle discovery includes exact unit, flat inventory, delete-preview
and permanent-delete schemas. Nullable parents and retained JSON-null metadata
are valid; deletion consumes the returned preview revision.

## Document resources

`resources/read` preserves `myoxus://{workspace_id}/{external_id}` and returns
Markdown in `contents[].text`. It requires both `read:workspaces` and `read:docs`,
accepted workspace access and the key owner's current document Read permission.
External members can read explicitly granted documents, not other workspace
documents. Workspace-only URIs continue to return JSON with `read:workspaces`.

Document resources use the same complete snapshot-plus-tail projection as
`read_doc`, including output limits and private-asset authorization. They never
return truncated Markdown or raw bytes as a fallback. If the resource cannot
be returned completely, use `read_doc` with `representation: "structured"` and
follow its `page.nextCursor`; keep passing the cursor unchanged.

## Document discovery and metadata

Document discovery (`list_pages`, `search_docs`) returns only currently readable,
live documents, including the explicitly granted subset for External members.
The same document Read permission protects versions, metadata, document tags
and targeted projection inspection. Lists continue past denied candidates;
pass `next_cursor` back unchanged, including after an empty bounded page.
Search counts describe only returned readable matches. If its 4,000-candidate
budget is exhausted, narrow the query or use paginated `list_pages`.
Projection scans are likewise ACL-filtered and do not expose orphan identities
or claim whole-workspace health after filtering.

## Create an API key

The easiest path is Web settings:

1. Open Workspace Settings.
2. Open Integrations.
3. Select MCP Server.
4. Choose whether to include write access.
5. Create the key and copy the generated client configuration immediately.

The secret is shown only once. If it is lost, revoke the key and create a new
one.

The key belongs to your user account, even when created from Workspace
Settings. It can access multiple workspaces according to its scopes and your
current permissions. A name such as `mcp:<workspace_id>` or the workspace name
in the copied configuration is only a label. It does not restrict the key to
that workspace. Use `list_workspaces` to discover your available targets and
pass the intended `workspace_id` to workspace/document calls.

API keys can also be created through GraphQL:

```graphql
mutation createMcpKey($name: String!, $scopes: [String!]!) {
  apiKeys {
    createApiKey(name: $name, scopes: $scopes) {
      id
      name
      key
      scopes
      expiresAt
    }
  }
}
```

Example variables:

```json
{
  "name": "mcp:workspace-id",
  "scopes": ["read:workspaces", "write:workspaces", "read:docs", "write:docs", "read:calendar", "write:calendar", "read:databases", "write:databases", "read:document_graph", "read:templates", "read:automations", "write:automations"]
}
```

## Global user administration

An active global administrator can issue a user-administration key with the
same GraphQL mutation above and these variables:

```json
{ "name": "mcp:user-administration", "scopes": ["read:users", "write:users"] }
```

Workspace UI defaults remain unchanged. The server checks the owner's current
active global-admin role on every user call and before replay; workspace ownership,
OU management and a legacy `admin` scope do not grant this authority.

`user_list` accepts optional `keyword`, `offset` (default 0), and `limit`
(default 20, maximum 100). Continue with `next_offset` until null. `user_get`
accepts `id_or_email`: one UUID or exact email, normalized for lookup. Both reads
return persisted public profile/timestamps without passwords, hashes or sessions.
The user writes require an `idempotency_key`. `user_create` accepts `email` and
optional `name`, creates a passwordless account and provisions its personal
workspace/root. `user_update` accepts `user_id` and optional `email`/`name`;
omitted fields are retained. `user_suspend`, `user_enable` and `user_reset_link`
accept `user_id`. Update/status responses are safe committed account projections.
Suspension revokes existing sessions and keys; enable allows fresh authentication
without resurrecting credentials.

`user_set_admin` accepts `user_id`, explicit boolean `is_admin`, and a mandatory
`idempotency_key`; it returns `user_id`, `previous_is_admin`, and `is_admin`.
Existing sessions and keys remain valid credentials, but demotion immediately
removes Admin authority. The existing email-verification policy still applies.
A self-demotion returns its committed result; subsequent privileged calls and
replays are denied even though the issuing key remains stored.

`user_delete` permanently deletes the account, sessions, keys and sole-owner
workspaces/content. Shared workspaces (including archived ones) remain with
surviving members under the existing ownerless principal; historical UUID/name
references and shared attachment bytes survive. Supply explicit `user_id`, matching `confirmed_user_id` and an
`idempotency_key`. Missing/mismatched confirmation performs no write. The result
is `{ "user_id": "<uuid>", "deleted": true }`; replay does not delete content or
emit the domain audit again. Self-deletion returns the known committed result
without recreating its cascaded key/receipt; later bearer requests are denied.

A scrubbed terminal UUID/name identity remains for historical readers, with empty
public email and no avatar. It grants no access, cannot enable or change profile,
password, role or features, and rejects new operational grants/private state.
Operational user discovery excludes it. A new signup at the released email gets
a different UUID and no inherited rights; old reset, magic-link and app codes
remain invalid. A fresh deletion retry is not-found; only an admitted replay
returns the original result. The deletion audit keeps name/UUID, without old email.

Reset-link creation uses configured server origin and the default callback,
takes no password or URL input, and returns `user_id`, `reset_link`, `expires_at`.
The authorized reset URL is sensitive. Its exact URL/expiry is intentionally
retained only in the existing API-key-scoped replay response until key deletion;
it never enters logs, audit or ordinary account lists. Replay does not mint a
token, extend expiry or revive a consumed/expired link. Protect this result like
the credential that obtained it.

Partial account creation retains durable state and fails closed. An uncertain
admission is not permission to retry with a new key or automatically repair the
account. Self-suspension returns the confirmed result after deleting its own key
and receipt; subsequent requests fail authentication. Replays do not emit another
domain mutation event; MCP transport audit remains separate.

## Scopes and permissions

Scopes define what the key may attempt. The server still enforces the key
owner's workspace and document permissions for the target resource.

| Scope                 | Allows                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read:workspaces`     | Workspace resource listing, workspace metadata, builtin-template/PDF-template reads.                                                                                    |
| `write:workspaces`    | Workspace name, plain-text overview description and explicit public/sharing settings changes; `read:workspaces` is also required for result readback.                   |
| `read:docs`           | Page, document, publication status, metadata, folder/folder-entry, workspace Tag/document-assignment, and controlled blob reads.                                        |
| `write:docs`          | Document writes, publication/revocation, versions, metadata/status and workspace Tag lifecycle writes, folder/entry writes, and blob uploads/deletes with matching ACL. |
| `read:databases`      | Bounded Database/view queries, single-row reads and exports through the server-owned Database service.                                                                  |
| `write:databases`     | Retry-safe Database row create/update/soft-delete/restore, cell updates, imports and row-from-template.                                                                 |
| `read:document_graph` | ACL-redacted Document Graph reads.                                                                                                                                      |
| `read:templates`      | Contextual Template Suggestions and Database row-template binding diagnostics.                                                                                          |
| `read:automations`    | Workspace Automation inventory, run status and dead letters through current Workspace Read permission.                                                                  |
| `write:automations`   | Workspace Automation run retry through the automation service and queue adapter.                                                                                        |
| `read:calendar`       | Bounded workspace event listing and overlap checks for native and external events.                                                                                      |
| `write:calendar`      | Retry-safe create/update/delete for native workspace events; external events remain read-only.                                                                          |
| `read:users`          | Bounded account list and exact account detail; current active global administrator required.                                                                            |
| `write:users`         | Account create/update/suspend/enable/reset link; current active global administrator and retry key required.                                                            |
| `read:organization`   | Organization/type/member discovery and organization-unit list, detail and deletion preview for active global administrators.                                            |
| `write:organization`  | Retry-safe organization-unit lifecycle writes for active global administrators.                                                                                         |

`admin` is not a supported self-service MCP scope and is not treated as a
wildcard by the MCP server. Use explicit read/write scopes.

The existing workspace integration dialog offers document, calendar and
workspace write switches before key creation. Workspace write access starts
off and adds `write:workspaces` only when selected. Once a key exists the
switches are locked; revoke and create a replacement to change scopes. Scopes
apply across the key owner's account and remain bounded by each workspace ACL:
the workspace-named key is not a workspace-restricted credential.
Database access uses only the canonical Database API:
`read:databases`, `write:databases` and `database_*` tool names are the only
supported Database MCP contract.

Organization discovery starts with `organization_get` (persisted default
organization ID/key/name/slug), then `organization_unit_type_list` (persisted
labels, active state and capabilities). Use the returned type UUID with the
existing `organization_unit_create` tool. `organization_unit_member_list` takes
`unit_id` and optional `role`; `user_organization_memberships` takes `user_id`
and exposes OU identity/status, role, source and join time without unrestricted
user profiles. All four need `read:organization` and current active global Admin
status; `read:users` and legacy `admin` do not substitute for this scope.

The three lists accept `offset` (default 0), `limit` (default 20, range 1..100)
and `include_inactive` (default false). Results contain `items`, `offset`,
`limit` and nullable `next_offset`. Continue with that offset until it is null;
no inventory is silently truncated. Types default to active, per-user results
exclude inactive OUs, and an inactive-unit roster requires explicit diagnostic
inclusion. Member profiles expose only email/name/avatar with membership data,
not hashes, sessions, API keys or global/workspace grants. Diagnostic inclusion
does not confer administrative permissions.

Organization scopes are issued only to active global administrators and are
rechecked on every tool call. Use `organization_unit_delete_preview` before a
permanent delete. Resolve every reported blocker through its owning Admin or
API workflow, request a fresh preview, then pass its `updatedAt` revision and
the exact unit name to `organization_unit_delete_permanent`. The operation is
irreversible and never cascades referenced data. All organization writes need
an `idempotency_key`; retry the same semantic request with the same key.

Important write ACLs:

- creating pages and folders requires workspace create-doc permission;
- creating or moving folder entries requires workspace create-doc permission;
- updating document content, patching documents and creating versions require
  document update permission;
- soft-deleting a document requires document trash permission;
- metadata updates and status transitions require document properties-update
  permission.
- Database row creation requires workspace create-doc permission;
- Database cell updates require update permission on the row and any linked
  document metadata touched by the operation;
- Workspace Automation retry requires workspace manager permission.

## Tool overview

Read tools:

- `list_workspaces`
- `workspace_get`
- `list_pages`
- `read_doc`
- `doc_publication_get`
- `search_docs`
- `page_projection_scan`
- `page_projection_inspect`
- `folder_tree`
- `folder_list`
- `workspace_tag_list`
- `workspace_tag_get`
- `document_tags_get`
- `doc_version_list`
- `doc_version_read`
- `doc_metadata_get`
- `doc_metadata_validate`
- `blob_list`
- `blob_get_metadata`
- `blob_read`
- `template_list_for_workspace`
- `template_request_reconcile`
- `document_template_list`
- `document_template_get`
- `pdf_template_list`
- `pdf_export_get`
- `database_list`
- `database_query`
- `database_row_get`
- `database_csv_export`
- `document_graph_read`
- `template_suggestions`
- `database_row_templates_list`

Write tools:

- `pdf_export_create` (requires `read:docs`; it exports without editing content)
- `workspace_update`
- `doc_publication_set`
- `create_page`
- `document_import`
- `document_image_insert`
- `document_reference_insert`
- `document_template_create`
- `document_template_instantiate`
- `document_template_mark`
- `document_template_unmark`
- `update_doc`
- `doc_patch`
- `delete_page`
- `restore_page`
- `page_projection_repair`
- `folder_create`
- `folder_path_ensure`
- `folder_update`
- `folder_delete`
- `folder_entry_place`
- `folder_entry_create`
- `folder_entry_update`
- `folder_entry_delete`
- `workspace_tag_create`
- `workspace_tag_rename`
- `workspace_tag_recolor`
- `workspace_tag_description_update`
- `workspace_tag_archive`
- `workspace_tag_restore`
- `workspace_tag_delete_permanently`
- `document_tags_set`
- `blob_upload`
- `document_asset_upload_prepare`
- `blob_delete`
- `doc_version_create`
- `doc_version_restore`
- `doc_metadata_transition`
- `doc_metadata_update`
- `database_row_create`
- `database_cell_update`
- `database_row_update`
- `database_row_delete`
- `database_row_restore`
- `database_row_from_template`
- `automation_run_retry`

`delete_page` and `restore_page` form the reversible trash lifecycle. Permanent
document deletion is not exposed through MCP.

`doc_publication_get` requires `read:docs` plus Document Read.
`doc_publication_set` additionally requires `write:docs`, Document Publish and
a mandatory `idempotency_key`. Publish mode is `Page` by default or
`Edgeless`; revocation uses `public: false` without a mode and remains available
when public delivery is disabled. Both tools use the workspace-local external
document ID and return the stored selection plus effective anonymous URL. They
never enable workspace sharing/publication or server delivery switches. A
completed retry returns its original result; call `doc_publication_get` for
current effective availability.

`page_projection_scan`, `page_projection_inspect`, and
`page_projection_repair` expose the guarded recovery path for pre-existing
SQL/leaf/root projection drift. Scan is paginated and leaf-free; inspection and
repair accept exactly one opaque external document key. The default dry-run is
non-mutating. Apply requires the exact inspection fingerprint and an
idempotency key; ambiguous findings remain unchanged. These commands are never
scheduled or invoked at startup, and their availability is not authorization
for production repair. The retired lifecycle tool names have no aliases. Follow the
[Document Lifecycle Repair runbook](../../runbooks/document-lifecycle-repair.md).

Database tools are thin MCP adapters over the server-owned Database application
service. They do not read Collections, browser-local state or GraphQL resolver
code. `database_query` returns the Database record plus at most 200 ACL-redacted
rows. Pass `view_id` to apply that saved view's filters/sorts, optional `search`
for its searchable fields and the returned opaque `nextCursor` as `cursor` for
the next page. Inaccessible linked document metadata is redacted rather than
used as row-owned storage. `database_row_get` reads one live row and returns
not-found for deleted rows. `database_csv_export` returns the same CSV payload
as the server CSV export contract.

`database_row_update` applies 1-200 cell patches atomically. It does not accept
a revision or force flag; a removed field, invalid value or deleted row fails
without a partial write. `database_row_delete` is always a recoverable
soft-delete, and `database_row_restore` reverses it. These tools and
`database_row_create`, `database_cell_update` and `database_row_from_template`
require `idempotency_key`.

Typical bounded lifecycle arguments (send them as `tools/call` arguments):

```json
{ "name": "database_query", "arguments": { "database_id": "<database-uuid>", "view_id": "<view-uuid>", "search": "quarterly", "limit": 50, "cursor": "<nextCursor>" } }
{ "name": "database_row_update", "arguments": { "database_id": "<database-uuid>", "row_id": "<row-uuid>", "patches": [{ "field_id": "<field-uuid>", "value": { "kind": "text", "value": "Reviewed" } }], "idempotency_key": "<unique-retry-key>" } }
{ "name": "database_row_delete", "arguments": { "database_id": "<database-uuid>", "row_id": "<row-uuid>", "idempotency_key": "<unique-retry-key>" } }
{ "name": "database_row_restore", "arguments": { "database_id": "<database-uuid>", "row_id": "<row-uuid>", "idempotency_key": "<unique-retry-key>" } }
```

Omit `cursor` on the first query. Reuse a write key only for an exact retry of
the same tool arguments; a corrected or intentionally changed write gets a new
key.

`document_graph_read` uses `DocumentGraphService` and returns the same
ACL-redacted graph model as the product Graph API. It accepts optional
`external_id`, `direction`, `include_occurrences`, `limit` and `offset`
parameters. `template_suggestions` accepts `current_external_id` for its
optional current-document context.

`template_suggestions` is a read-only dry run over
`TemplateSuggestionService`; it never materializes templates. Use
`database_row_templates_list` to inspect Database row-template bindings backed
by the Template Registry.

`automation_run_retry` resets only failed or dead-lettered Workspace Automation
runs and enqueues the normal `workspace-automation` job. It requires
`write:automations`, workspace manager permission and `idempotency_key`.

Calendar clients should request the smallest useful RFC 3339 window. Both
timestamps must include an offset and the window may span at most 93 days. A
list with more than 500 matches returns `RESULT_TOO_LARGE`; narrow the window
instead of expecting truncation. `calendar_conflicts_check` may include native
and external events. Create/update/delete apply only to native events and need
`idempotency_key`; `CALENDAR_EVENT_READ_ONLY` means the event must be changed
through its provider workflow. Link a native event to a document with
`source_external_id`; event results expose the same key as
`sourceExternalId`.

## Document templates

Use `document_template_list` to page through readable workspace document
templates and `document_template_get` for one template's compact metadata. The
tools return the external document ID, title, `isTemplate` and sorted required
`{{ variable }}` names. They never return the body, internal UUID or persisted
template-state value; call `read_doc` explicitly to inspect content.

`template_list_for_workspace` and `template_request_reconcile` are different:
they are read-only diagnostics for builtin provisioning. The latter only
reports missing or stale instances and never marks, enqueues or rebuilds them.
Neither diagnostic is a user document-template catalog.

An API key needs `read:docs`; the key owner must additionally have workspace
Read and document Read. This matters for External members, whose list contains
only explicitly granted template documents.

Use `document_template_create` with exactly one `fragment` or
`content_markdown`, exactly one existing `folder_id` or exact `folder_path`, and
an `idempotency_key`. The key owner needs `write:docs` and Workspace CreateDoc.
The operation creates through the ordinary page lifecycle, marks the canonical
template property and places the document through the existing Folder owner;
metadata or placement failure is compensated rather than returned as partial
success.

Use `document_template_instantiate` when the source is an existing readable
user document template and native editor fidelity matters. Supply its
workspace-local `template_external_id`, exactly one existing `folder_id` or
exact `folder_path`, an `idempotency_key`, optional final `title`, and at most
100 variables. Variable values are bounded strings, string lists or native repeat
records. A list
value is valid only for a complete list-item placeholder and expands into
native list items. The key owner needs source Document Read and destination
Workspace CreateDoc. When the template references existing workspace assets,
it also needs BlobsRead and every asset must be completed and visible.

Omitted supported automatic values resolve through the authoritative document
template application owner. Requested creator/time values come from the actual
committed target; target-independent facts and syntax are checked before writes.
Late resolution failure is compensated before success is reported. Automatic
member enumeration requires UsersRead and follows its bounded accepted-member
policy. Existing explicit scalar/list/record values remain caller-authored,
preserving their order and literal semantics; explicit member records are not
silently filtered or attested. Unknown omitted values fail without creating a
target.

`actor.name` and `actor.email` read the authenticated applying account's stored
profile, independently of the original target creator. They are self-account
facts, not directory enumeration or a responsible-person assignment.
`folder.path` joins the validated real destination ancestor names with `/`,
excluding the synthetic root. `calendar.iso_week_year` uses the same effective
application day as automatic `week`. All four reject caller overrides even
when unused; other explicit legacy values keep their literal semantics.

Omitted application-date values use one server instant per attempt and the
applying account's effective Auth regional preferences and server defaults.
Creation timestamps remain separate stored facts. No date/locale input or
Journal-navigation inference is introduced. Replay uses authored inputs and
stable context identities, not resolved dates or names; profile/preference
changes do not rewrite a completed result under the existing replay policy.

Optional `context_parent_external_id` supplies a readable, non-trashed,
same-workspace document solely as substitution context. It creates no nesting
and cannot reference the source template. The existing destination supplies its
terminal folder name. These automatic values are reserved; see the
[template variable reference](../template-variables.md) for exact names,
availability and point-in-time semantics.

```json
{
  "name": "document_template_instantiate",
  "arguments": {
    "workspace_id": "<workspace UUID>",
    "template_external_id": "<template external key>",
    "context_parent_external_id": "<readable parent external key>",
    "folder_id": "<existing folder ID>",
    "idempotency_key": "meeting-context-01"
  }
}
```

Context names belong to the created snapshot, not caller identity. Retrying the
same request after a context rename returns the first result without changing
it, provided current authorization and preflight still succeed.

Instantiation clones the canonical Yjs snapshot directly. Native image blocks,
document references and unrelated formatting therefore remain native. It
creates an ordinary non-template document and never copies Workspace Tag
assignments. Use `document_import` instead for external Markdown or structured
content; after either workflow, set Tags explicitly with `document_tags_set`.
Metadata or folder-publication failure compensates the page, metadata and entry
as one semantic operation. The response contains only the new external ID,
folder/entry identity and document/root revisions.

`document_template_mark` and `document_template_unmark` accept a workspace-local
`external_id` and `idempotency_key`. They require `write:docs` plus Document
Properties.Update. This narrower permission is intentional: template status is
a document property, not content editing or Organizer administration. Results
expose `isTemplate`, never the persisted state literal. Continue to use
`doc_patch`/`update_doc` for title or body changes and `delete_page` for trash.

## Write idempotency

All MCP write tools expose one of two explicit retry contracts. Shipped tools
keep `idempotency_key` optional for client compatibility and remain
non-idempotent when it is omitted. Newer protected writes require the key and
advertise `idempotentHint=true`. The current required set is `update_doc`,
`doc_patch`, `page_projection_repair`, `document_template_create`,
`document_template_instantiate`, `document_template_mark`,
`document_template_unmark`, `workspace_update`, `doc_publication_set`, `database_row_create`,
`database_cell_update`, `database_row_update`, `database_row_delete`,
`database_row_restore`, `database_row_from_template`, `automation_run_retry`,
the three Calendar mutations, the five Organization mutations and the five
User mutations; inspect
`tools/list` rather than hard-coding this list in clients.

The key is scoped to the MCP API key, tool name and canonical semantic payload
hash:

- retrying the same tool with the same key and identical payload returns the
  stored response without creating a second product mutation;
- retrying with the same key but a changed payload returns
  `MIX_MCP_IDEMPOTENCY_CONFLICT` with JSON-RPC code `-32010`;
- an overlapping identical call returns retryable
  `MIX_MCP_IDEMPOTENCY_IN_PROGRESS`;
- a proven rolled-back document mutation releases its pending key; committed or
  ambiguous outcomes are retained for recovery;
- current scope and object ACL are checked before a stored response is replayed.

The replay guard is stored in `mcp_idempotency_keys`. It is transport evidence,
not a product data source. Revoking an API key deletes its replay rows. Replay
does not create a second domain mutation, outbox event or mutation audit.

Keyed document create, patch, rename, replace-all, trash and restore persist a
bounded outcome in the same transaction as their document changes. If a request
is interrupted after commit, repeat the identical call: the existing document,
revision and recovery identity are returned without another write. Affected
content whose post-commit readback was interrupted is explicitly unavailable;
use `read_doc` to request current content separately.

An abandoned, provably uncommitted document admission is recoverable after
60 seconds. A still-running transaction keeps its ownership. Legacy ambiguous
pending rows are not expired. `RECOVERY_REQUIRED` means completion durability
could not be confirmed: retry the same key and payload, never invent a new key
for that retry. Keyless shipped calls retain their non-idempotent behavior.

Example row create payload:

```json
{
  "database_id": "00000000-0000-0000-0000-000000000001",
  "title": "Incident follow-up",
  "initial_cells": [
    {
      "field_id": "00000000-0000-0000-0000-000000000002",
      "value": { "kind": "url", "value": "https://example.test" }
    }
  ],
  "idempotency_key": "incident-follow-up-20260702-1"
}
```

Folder-entry tools manage links inside workspace folders. They can link
documents, tags and collections into folders, move those links, retarget them
and remove them. Removing a folder entry never deletes the linked target.
Document link targets are checked against the workspace document store; tag
and collection targets keep their existing workspace-local identifiers, and
the server does not expose them as independent repository-owned resources.

Use `folder_tree` when an agent needs the current hierarchy and its readable
contents in one call:

```json
{
  "name": "folder_tree",
  "arguments": {
    "workspace_id": "00000000-0000-0000-0000-000000000000",
    "max_depth": 8
  }
}
```

Read the nested folders and entries from `structuredContent`. Folder and entry
`id` values are stable folder or entry IDs; document entries expose the workspace-local
`externalId` used by document tools. Paths are arrays of display names, so
duplicate names remain unambiguous through their distinct IDs. Hidden or
deleted targets are omitted. A concurrent folder revision change is retried
once and otherwise returns a retryable `CONFLICT` without stale partial data.

For the common write path, ensure a display-name path and place an existing
document without manually chaining primitive folder calls:

```json
{
  "name": "folder_path_ensure",
  "arguments": {
    "workspace_id": "00000000-0000-0000-0000-000000000000",
    "path": ["Projects", "2026"],
    "idempotency_key": "projects-2026-path"
  }
}
```

Then call `folder_entry_place` with the returned `folderId` or the same exact
`folder_path`, the document `external_id`, and a new idempotency key. The result
states `created`, `already_placed`, or `moved`. Exact paths never guess between
duplicate sibling names: `FOLDER_PATH_AMBIGUOUS` returns their candidate folder
IDs and writes no missing suffix. These shortcuts retain the existing
folder and entry rows and do not create document-parent metadata.

To create and place one document in a folder that already exists, call
`document_import` instead of chaining page creation, folder listing, entry
creation and readback:

```json
{
  "name": "document_import",
  "arguments": {
    "workspace_id": "00000000-0000-0000-0000-000000000000",
    "title": "Incident follow-up",
    "content_markdown": "# Follow-up\n\nOwner: Platform",
    "folder_path": ["Projects", "2026"],
    "idempotency_key": "incident-follow-up-import-1"
  }
}
```

Use exactly one of `content_markdown` or a
`myoxus.document-fragment.v1` `fragment`, and exactly one of `folder_id` or an
exact `folder_path`. The destination must exist. Markdown is convenient and
lossy; fragments preserve the supported block structure. Structured image
blocks accept only a completed same-workspace `assetRef` returned by
`document_asset_upload_prepare`; every referenced asset is checked before the
page is created. Markdown image URLs retain the existing external/lossy
behavior and are not reported as migrated assets. Native document references
remain a separate operation. The response is compact
and contains `externalId`, document/root revisions, folder/path, `entryId`,
`blockCount`, `inputMode` and `markdownDiagnosticCount`, but no submitted content
or internal UUID. Creation durably records the page and preallocated entry
identities. Compensation removes placement before trashing its target; if
removal is uncertain, the page stays live. Interrupted imports return an
explicit `RECOVERY_REQUIRED` state with those existing identities and the last
durable step, rather than creating a duplicate or claiming success. Verify the
original invocation has stopped before repairing those identities with the
existing document/folder tools. Keep the same key; see
[interrupted composed writes](troubleshooting.md#interrupted-composed-writes).

To add an internal document link after creation, call
`document_reference_insert` with the source `external_id`, the readable
`target_external_id`, a visible `label`, an optional stable `after_block_id`
and an idempotency key. The server resolves both opaque keys in the supplied
workspace and writes one native `LinkedPage` paragraph. Omitting
`after_block_id` appends it. The response contains only both external keys, the
inserted block ID and the new revision. URL links are unaffected; no internal
UUID or parallel relation record is stored, and the normal Document Graph
index supplies edges and backlinks.

For a native image, hash the bytes with SHA-256 and call
`document_asset_upload_prepare` with `workspace_id`, filename, MIME type, byte
size and the hexadecimal hash. Upload the bytes with `PUT` to the returned
signed `/api/storage/upload` URL; the HTTP owner verifies signature, declared
size, actual SHA-256 and the shared MIME policy before completing the existing
blob metadata. Matching retries keep the same opaque `assetRef`, issue a valid
URL while incomplete and return `alreadyUploaded: true` without a URL after
completion. Raw bytes never pass through this tool. Then call
`document_image_insert` with the document external key, `asset_ref`, optional
`after_block_id`/`caption`, and an idempotency key. It writes the existing
native Image block; `blob_upload` remains the small-Base64 fallback.

Omit `index` on `folder_create` and `folder_entry_create` to append using the
server-owned order-key generator. Omitted order on a move similarly appends in
the destination folder. Explicit keys must use the Web
`fractional-indexing@3.2.0` grammar; numeric timestamp values are invalid.
`MIX_ORGANIZER_ORDER_KEY_INVALID` (`-32602`) means the supplied folder-order key was rejected
without a write. `MIX_ORGANIZER_REINDEX_REQUIRED` (`-32009`) means the target
sibling group contains a legacy-invalid folder-order key and must be repaired explicitly
before an ordered insertion or move. Ordinary reads, renames, retargets and
deletes remain available and do not silently rewrite legacy ordering.
These two code literals are stable wire identifiers; Folder remains the public
product concept and there is no second hierarchy to configure.
For an explicitly authorized legacy repair, follow the backup, dry-run,
revision-conflict and recovery procedure in
[MCP troubleshooting](./troubleshooting.md#organizer-order-key-repair); no MCP
tool or server startup path applies this maintenance operation automatically.

Workspace Tag reads use `read:docs` plus the API-key owner's current workspace
Read permission. This is intentionally the ordinary read permission: Tags are
workspace-visible document metadata, not Folder administration, and none of
these calls mutates the catalog. A key with the scope but no workspace
membership is denied.

Start with `workspace_tag_list`; omit pagination for the default 50 rows or use
`offset` and `limit` up to 200. Active Tags are the default, while
`include_archived: true` includes archived rows. Use the returned canonical
`id` with `workspace_tag_get` when the optional description is needed. To read
one document's assignments, pass its actor-facing `external_id` to
`document_tags_get`; the returned Tags retain their assignment order and no
internal document UUID or Tag slug is exposed.

```json
{ "name": "workspace_tag_list", "arguments": { "workspace_id": "00000000-0000-0000-0000-000000000000", "limit": 50 } }
{ "name": "document_tags_get", "arguments": { "workspace_id": "00000000-0000-0000-0000-000000000000", "external_id": "project-brief" } }
```

The supported theme roles are `tag.red`, `tag.magenta`, `tag.orange`,
`tag.yellow`, `tag.green`, `tag.teal`, `tag.blue`, `tag.purple` and `tag.grey`.
Treat them as semantic roles; do not convert them into locally chosen hex
colors.

Tag lifecycle writes require `write:docs`, the API-key owner's current
workspace `CreateDoc` permission, and a unique `idempotency_key`. The two checks
serve different purposes: scope admits the key to document writes, while
`CreateDoc` authorizes that user in the selected workspace. No organizer/admin
permission is needed because Tags are document metadata, not Folder or
organization configuration.

Use the separately named create, rename, recolor, description-update, archive,
and restore tools. The server derives and collision-suffixes slugs; clients do
not submit or receive them. Pass `null` (or blank text) to clear a description.
Each mutation returns the compact Tag fields `id`, `name`, `colorRole`,
`archived`, and `description`, never the retry key.

`workspace_tag_delete_permanently` is the irreversible exception: it accepts
only an archived Tag, requires `confirm_permanent_delete: true`, and the actor
must have `PropertiesDelete` in addition to the key's `write:docs` scope. Its
compact acknowledgement contains only `tagId` and `deleted`; replay the same
request with the same key instead of retrying under a new identity.

Workspace Labels use the existing Tag tool names. Their `tools/list`
descriptions and property schemas expose this workflow directly: read
`document_tags_get`, select canonical UUIDs from every needed
`workspace_tag_list` page, explicitly create missing Labels with
`workspace_tag_create`, then call `document_tags_set` with the complete ordered
`tag_ids` array. `external_id` is the external document key within
`workspace_id`, never an internal document UUID. Repeating a partial list removes omitted assignments;
an empty list clears them. Names are never resolved and missing Tags are never
created by this operation. Archived Tags may be retained or removed from their
existing document, but cannot be newly added.

Create and set require `idempotency_key`. Retry identical arguments with the
same key to receive the original response without another write. Use a new key
for a changed request. A replay does not reapply an old assignment after another
write; use `document_tags_get` to read current state. Get returns `tags: []` for
a confirmed empty assignment; missing/forbidden documents return an error.
Discovery marks reads read-only, creation non-destructive and complete replacement
destructive; both writes advertise their existing idempotency contract.

```json
{ "name": "workspace_tag_create", "arguments": { "workspace_id": "00000000-0000-0000-0000-000000000000", "name": "Ready", "color_role": "tag.green", "idempotency_key": "tag-ready-create-1" } }
{ "name": "workspace_tag_description_update", "arguments": { "workspace_id": "00000000-0000-0000-0000-000000000000", "tag_id": "00000000-0000-0000-0000-000000000001", "description": null, "idempotency_key": "tag-ready-clear-1" } }
{ "name": "workspace_tag_delete_permanently", "arguments": { "workspace_id": "00000000-0000-0000-0000-000000000000", "tag_id": "00000000-0000-0000-0000-000000000001", "confirm_permanent_delete": true, "idempotency_key": "tag-ready-delete-1" } }
{ "name": "document_tags_set", "arguments": { "workspace_id": "00000000-0000-0000-0000-000000000000", "external_id": "project-brief", "tag_ids": ["00000000-0000-0000-0000-000000000001"], "idempotency_key": "project-brief-tags-1" } }
```

Blob tools use the existing workspace blob service. They list blob metadata,
return metadata for a single key, read small completed blobs as base64, upload
small single-part blobs from standard base64, and delete blobs through the same
soft-/hard-delete service used by GraphQL. `blob_read` enforces a
caller-provided `max_bytes` with a 5 MiB server cap and never returns signed
storage URLs. `blob_upload` enforces the configured storage upload-size limit
and the shared live MIME policy from `app_configs`/startup config before bytes
are written. Oversized Base64 envelopes are rejected before decoding, and MIME
denial logs identify the blob key only by hash plus bounded sanitized extension.
It returns metadata only. MCP does not expose a generic document
attachment service. `document_asset_upload_prepare` and
`document_image_insert` are the bounded native document-image path.

## Reading and editing documents

For knowledge collaboration, select an authorized workspace with
`list_workspaces`, then use keyword `search_docs` before creating another page.
Choose the returned opaque document key; read its structured outline/section
and `doc_metadata_get` before editing. Search index times are indexing facts,
not verification. Follow sources with the target's current authorization;
unavailable source facts do not establish absence or verification.

Use `create_page` for a new native document and `doc_patch` for content/title.
Patch against the observed content `revision`, send an `idempotency_key`, and
use `strict_loss: true` for Markdown conversions. On human-edit conflicts,
reread the current section and continue from its revision. Never replace a
whole document from a partial read. Full replacement retains its explicit
confirmation and atomic recovery point.

Use `doc_metadata_update` for native type/deadlines (with the observed
`expectedMetadataRevision`) and `doc_metadata_transition` for status discovered
through `doc_metadata_get`. Use `document_tags_set` with canonical Tag IDs and
`folder_path_ensure` / `folder_entry_place` for the existing Organizer. Each
call has its own transaction/retry boundary: if a later placement, metadata or
content call fails, earlier successful calls remain available for readback and
continuation. Reuse the original key and identical arguments after a lost
response or restart; current scopes and permissions also protect replay.

Read `representation: "markdown", include_okf_frontmatter: true` after native
edits to obtain rebuilt frontmatter. Explicit native type/status and the earlier
review/validity deadline affect that projection; an opening summary and explicit
citation footnotes supply derived description/sources. Keep frontmatter out of
the native body and do not maintain a second editable copy. Native mutations
retain imported properties. Declared underlying-asset resources and unknown
extensions currently come from retained imports, not an arbitrary metadata-write
capability. The `myoxus://<workspace>/<key>` retrieval reference identifies the
knowledge document, not necessarily its underlying asset. Related links and
Tags retain their existing roles; an ordinary related link is not automatically
a source citation.

Unavailable producer attribution remains unknown: the authenticated caller,
editing, indexing and workflow approval do not prove who generated content or
verified a source. Use existing named content versions and recovery when needed;
current native metadata alongside an old content version is not historically
captured metadata. Restoring content preserves current workflow/type/deadline
fields and does not establish source verification.

Treat every document key as opaque and workspace-local. Take the NanoID-shaped
`externalId` returned by `list_pages`, `search_docs` or `create_page` and pass
it unchanged as `external_id` to `read_doc`, `doc_patch`, metadata/version
tools and `document_graph_read`. The server never infers the workspace from an
internal UUID. For Folder placement, use that same external key as the existing
document `folder_entry_create.target_id`; `parent_id` continues to name the
containing folder. A document resource then uses
`myoxus://<workspace_id>/<external-key>`.

Start with the structured representation. It retains stable block IDs, rich
text marks, lists, tables, assets and projection diagnostics; the opaque cursor
pages blocks without cutting serialized content:

```json
{
  "name": "read_doc",
  "arguments": {
    "workspace_id": "00000000-0000-0000-0000-000000000000",
    "external_id": "V1StGXR8_Z5jdHi6B-myT",
    "representation": "structured",
    "limit": 50
  }
}
```

Structured reads accept exactly one optional selector: `block_id` selects a native
content block and its descendants, `heading_block_id` selects a section from
that heading through (excluding) the next equal-or-higher-level heading, and
`outline: true` selects headings only. Heading IDs distinguish duplicate labels.
Selectors cannot be combined with export representations or the legacy `format`.
For block/section reads, `neighbor_context` adds at most 10 preceding and 10
following content blocks; context is identified explicitly.

Selected pages are flat and preserve each native list-item ID. `selection.identities`
reports native parent/child IDs (including container parents), counts and explicit
identity-list completeness; each identity list is capped at 200. `limit` still
bounds the entire returned page, including context, to 1–200 blocks.
`selection.totalBlocks` counts the selected content and requested neighbors;
`selection.complete` becomes true only on the final page with no projection
diagnostics. `projection.complete` continues to describe projection fidelity.
Continue with `page.nextCursor` and the same selector/context. Cursors bind both
the document revision and selection; changed state or scope fails as stale.
Missing content IDs fail explicitly. Unselected reads and their cursors retain
the existing nested representation.

For example, call `read_doc` with `heading_block_id: "heading-from-outline"`
and `limit: 20`, or with `block_id: "nested-item-from-read"` and
`neighbor_context: 1`. The existing `representation: "html"` export provides a
whole-document private preview; selectors do not introduce a second HTML renderer.

Use `doc_patch` for normal edits. It applies typed block operations directly to
the current canonical Yjs state and preserves unrelated content:

Supported operations also include `delete_block`, `move_block`, `edit_text`,
`format_text`, `edit_table_cell`, `update_block_properties` and
`update_citation`. These operations do not take fragments. Each request
must contain only its operation's fields (plus workspace/document identity,
idempotency key and optional revision):

| Operation                 | Operation fields                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `delete_block`            | `block_id`                                                                                             |
| `convert_block`           | `block_id`, `block_kind` (`paragraph`, `quote`, `heading1`–`heading6`, `bulleted`, `numbered`, `todo`) |
| `split_block`             | `block_id`, `position`; optional `range_unit`; right unit may become first child                       |
| `join_blocks`             | destination `block_id`, following compatible sibling `source_block_id`; children lift to parent        |
| `duplicate_block`         | `block_id`; returns fresh copied root/descendant IDs, source retained                                  |
| `move_block`              | `block_id`, optional `after_block_id` and `parent_block_id`                                            |
| `edit_text`               | `block_id`, `start`, `end`, exactly one replacement form; optional `text_field`                        |
| `format_text`             | `block_id`, `start`, `end`, non-empty `formatting`; optional callout field or paired cell IDs          |
| `edit_table_cell`         | `block_id`, `row_id`, `column_id`, `start`, `end`, exactly one replacement form                        |
| `update_block_properties` | `block_id`, non-empty `properties`                                                                     |
| `update_citation`         | `label`, at least one of `new_label` or `reference`                                                    |
| `update_title`            | `title`                                                                                                |

For example, `{"operation":"delete_block","block_id":"block-from-read"}`
needs no dummy fragment. Append/prepend (including shipped `append`/`prepend`
aliases), insertion and replacement require exactly one of `fragment` or
`content_markdown`, plus their block or heading target where applicable.
Conflicting, unknown or irrelevant operation fields fail before a write.
Structured reads describe native Callout containers with their appearance and
nested children, including nested list items; this is not a new Callout write API.

`edit_text` uses UTF-8 byte offsets when `range_unit` is omitted, preserving
the shipped Yrs configuration. Explicit units are `utf8_bytes`,
`utf16_code_units` (JavaScript string positions) and `unicode_scalars`.
The half-open `[start,end)` range must lie on encoding boundaries; UTF-8
characters and UTF-16 surrogate pairs cannot be split. Combining marks count
separately in scalar mode; no Unicode normalization or grapheme expansion occurs.
Optional `expected_text` must exactly match the selected original text under
the canonical content lock; a mismatch or invalid boundary writes nothing.
Native rich-text attributes, references, block identities and neighbors outside
the range are retained. Native embeds consume one position in each unit; an
expected string cannot attest to replacing embedded content.

For example, given `A😀B`, use
`{"operation":"edit_text","block_id":"block-from-read","range_unit":"utf16_code_units","start":1,"end":3,"expected_text":"😀","replacement":"🌿"}`,
with workspace/document identity and an idempotency key.
Pass `expected_revision` from the latest structured
`read_doc` result to reject stale writes; successful mutations return that new
revision as `revision` and identify changed blocks in `affectedBlockIds`.

The same optional `expected_revision` applies to `update_title`, every other
`doc_patch`, `update_doc`, `document_image_insert` and
`document_reference_insert`. Omit it only when deliberately accepting
revisionless writes; explicit null, negative or non-integer values are rejected.
A stale revision returns `MIX_DOCUMENT_MUTATION_CONFLICT` with expected/current
revision numbers and makes no document, title, history or outbox change. Title
preconditions are checked under the atomic root/leaf rename lock. Retrying an
identical idempotency key and payload returns its original committed result;
changing the precondition requires a new key and a newly considered edit.

Content mutations return `updatedBlocks` from exactly their committed `revision`,
not from a later read of the document's first page. Affected IDs work beyond
block 200 and inside nested lists/children. `insertedBlockIds` includes newly
created descendants; `removedBlockIds` includes removed descendants, which have
no updated content. Public list projections may group native list items, but
each affected item's own ID remains addressable in the returned blocks.

Always inspect `readback`: `{"status":"complete"}` means all affected live
IDs are represented (a pure removal legitimately returns an empty array).
`{"status":"unavailable","reason":"output_limit"}` means the write committed
but its readback exceeded 200 affected live IDs, 1 MiB per projected block or the
configured output budget. Other reasons are `read_access_denied`,
`asset_access_denied`, `projection_failed`, `affected_block_unavailable` and
`legacy_commit_unavailable`. Unavailable readback contains no `updatedBlocks`;
it is not a failed write and must not trigger an automatic repeat mutation.
Use bounded `read_doc` to inspect the current state, whose revision may now be
newer. Content requires current Read permission and `read:docs`, including on
idempotent replay; replay never rereads a newer head to fill missing content.
Older stored responses without a commit-bound projection explicitly report
`legacy_commit_unavailable` instead of claiming their old first-page result is
complete. Title-only lifecycle results remain block-free.

Every `read_doc` representation returns `revision`, the committed content
sequence read together with the complete native snapshot and update tail.
This is neither the metadata revision nor a named document version ID. Reading
does not create a history entry. Read the content and its revision, choose the
stable target IDs, then supply that revision with the next content mutation;
on conflict, read again before deciding whether to retry. Cursors belong to
the source revision: any newer content commit, including a title-only update,
makes continuation stale. Compaction alone preserves the revision and cursor.

```json
{
  "name": "doc_patch",
  "arguments": {
    "workspace_id": "00000000-0000-0000-0000-000000000000",
    "external_id": "V1StGXR8_Z5jdHi6B-myT",
    "operation": "append_to_heading",
    "heading": "Decisions",
    "fragment": {
      "schemaVersion": "myoxus.document-fragment.v1",
      "blocks": [
        {
          "kind": "paragraph",
          "spans": [{ "text": "Approved", "bold": false }]
        }
      ]
    },
    "idempotency_key": "decision-20260722-1"
  }
}
```

Missing block or heading targets fail without a write. Ambiguous headings also
fail; use the stable `blockId` from a structured read for exact block
operations. Concurrent Web, Electron and MCP updates are serialized through
the same document lock and delivered through the normal workspace sync path.
Create, title update, trash and restore are committed with one durable broadcast
event. Connected clients receive the leaf/root deltas without a reload. If the
API process exits after commit, the periodic outbox consumer replays the event;
duplicate Yjs delivery is safe and does not create a second lifecycle write or
audit row.

`update_doc` is not the normal edit tool. It replaces all blocks, requires
`confirm_replace_all=true`, and creates a recovery history point. Use it only
for an intentional import/recovery replacement. `content_markdown` remains a
compatibility input that is normalized once; it is not a lossless document
roundtrip.

Use `representation=html` for a portable private HTML bundle. Internal images
are listed as relative asset paths plus `blob_read` arguments and remain under
the API-key owner's ACL. External images must use HTTPS; insecure HTTP image
sources are omitted with a projection diagnostic. `markdown` and `plain_text` are explicitly lossy;
`raw_yjs` is an advanced transport format. Oversized exports fail rather than
returning truncated content.

## Generic streamable HTTP configuration

All clients use the same `/mcp` endpoint and Bearer credential. A minimal
initialize request is useful when diagnosing a client independently:

```bash
curl --fail-with-body "$MYOXUS_MCP_URL" \
  --header "Authorization: Bearer $MYOXUS_MCP_TOKEN" \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"http-diagnostic","version":"1"}}}'
```

Keep the URL and token in environment variables or a credential store. Do not
put the token in shell history, support output or a committed MCP config.

## Codex CLI configuration

Codex supports Streamable HTTP and reads the Bearer token from an environment
variable, so its persisted config contains no credential:

```bash
read -rsp 'One-time Myoxus API key: ' MYOXUS_MCP_TOKEN
printf '\n'
export MYOXUS_MCP_TOKEN
codex mcp add myoxus \
  --url 'https://myoxus.example/mcp' \
  --bearer-token-env-var MYOXUS_MCP_TOKEN
codex mcp get myoxus --json
```

The last command must report `transport.type=streamable_http`, the configured
URL and `bearer_token_env_var=MYOXUS_MCP_TOKEN`.

## GitHub Copilot CLI configuration

Copilot supports environment-variable expansion in remote MCP headers. Place
this in `~/.copilot/mcp-config.json` and export the token before starting the
client:

```json
{
  "mcpServers": {
    "myoxus": {
      "type": "http",
      "url": "https://myoxus.example/mcp",
      "headers": {
        "Authorization": "Bearer ${COPILOT_MCP_MYOXUS_TOKEN}"
      },
      "tools": ["*"]
    }
  }
}
```

```bash
read -rsp 'One-time Myoxus API key: ' COPILOT_MCP_MYOXUS_TOKEN
printf '\n'
export COPILOT_MCP_MYOXUS_TOKEN
copilot mcp get myoxus --json
```

Remote MCP servers are untrusted inputs to Copilot and each tool call remains
subject to the client's permission flow. See the
[Copilot CLI MCP documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
for client-side policy and configuration details.

## Other client configuration

Use the current Streamable HTTP style when your client supports it:

```json
{
  "mcpServers": {
    "myoxus": {
      "type": "streamable-http",
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY_HERE"
      }
    }
  }
}
```

Some clients still expect a nested transport object:

```json
{
  "mcpServers": {
    "myoxus": {
      "transport": {
        "type": "http",
        "url": "http://localhost:3001/mcp",
        "headers": {
          "Authorization": "Bearer YOUR_API_KEY_HERE"
        }
      }
    }
  }
}
```

### Cursor

```json
{
  "mcpServers": {
    "myoxus": {
      "type": "streamable-http",
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY_HERE"
      }
    }
  }
}
```

## Resource URIs

`myoxus-workspace://{workspace_id}/inventory` is a current authorized document
and structure inventory, not activity history. It requires `read:workspaces`
and `read:docs`, membership and workspace Read; documents and links are filtered
by current ACLs. Rows expose external keys, titles and durable content/metadata
revision identities, never raw Yjs or internal document IDs. Follow
`nextCursor` by adding `?cursor=<URL-encoded cursor>` to this URI. Re-read from
the start after reconnect; concurrent edits can change current-state pages.
Root/Organizer revisions are not public inventory revisions. Storage failures
or oversized projections fail explicitly instead of returning partial success.

For import progress, supply the SDK request metadata `_meta.progressToken` to
`tools/call`. The active request receives monotonic validation/create/placement/
completion notifications; the transport can switch that response to SSE. A
replay reports replay rather than a second creation. Calls without a token keep
their ordinary result. Disconnect/cancellation stops pure reads/completion but
does **not** promise write rollback: inspect/retry with the same idempotency key.
PDF Create/Get retain their existing durable job lifetime.

Discover URI templates through `resources/templates/list`; use SDK
`completion/complete` with a `ref/resource` template reference for argument
suggestions. Workspace completion returns readable member workspace IDs.
Document completion requires `context.arguments.workspace_id`, `read:workspaces`
and `read:docs`; only live readable external keys are suggested. Responses have
at most 100 values; `hasMore` can also indicate that the bounded candidate scan
is incomplete. Use paginated `list_pages` for full discovery.

The canonical document template is
`myoxus-document://{workspace_id}/{external_id}`. Apply RFC 6570 simple expansion
to the external key as **one path component**: slash becomes `%2F`, literal
percent becomes `%25`, and Unicode becomes percent-encoded UTF-8. It is decoded
exactly once before lookup. For example, key `a/b` differs from key `a%2Fb`.
Existing `myoxus://` references below retain literal keys; do not rewrite their
stored percent sequences. Both schemes use the same authorized document reader.

MCP resources are read-only:

```text
myoxus://{workspace_id}
myoxus://{workspace_id}/{external-key}
```

Workspace resources return workspace metadata. Document resources return
Markdown when extraction succeeds and base64 raw content when extraction fails.

`resources/subscribe` remains unimplemented (`-32601`); the legacy GET `/mcp`
stream remains keep-alive only. Modern `2026-07-28` clients instead use the
SDK's `subscriptions/listen` with `notifications.resourceSubscriptions` containing
inventory and/or document resource URIs. Modern discovery advertises resource
subscriptions only; legacy `initialize` continues to report `subscribe=false`.
When using rmcp 3.8.0 as a consumer, select
`ClientLifecycleMode::Discover` through `ClientServiceExt::serve_with_lifecycle`.
The SDK's default `.serve()` still initializes a legacy connection; setting
only its version field does not select the modern lifecycle.

An acknowledgment means supported syntax, not target authorization. After current
key/account, scope and object admission, an initial hint requests current-state
readback. Later hints follow visible committed changes; read the resource again
after each hint and after reconnect. A workspace inventory subscription discovers
new visible pages and placement changes without one subscription per page.
Hidden-only edits remain silent. A removed/unreadable selected document loses
its binding without disclosing its new location; an authorized inventory can
refresh its filtered list. Disconnect releases bindings. The shared 15-second
heartbeat repairs missing lifecycle wakeups; this is not durable event history.

Codex/Copilot ordinary-call acceptance does not imply automatic context refresh:
the verified target clients still lack the workspace/document content-subscription
consumer. This server capability requires a modern subscription-capable client;
no client bridge, fork or old-protocol fallback is provided.

## Feature gate

MCP is enabled by the `mcp.enabled` app configuration value. When disabled:

- global `/mcp` returns `404`;
- the legacy workspace bridge returns `404`;
- GraphQL API-key operations for MCP keys fail with a feature-disabled error.

The restart-bound server setting `mcp.documentExportMaxBytes` (environment:
`MYOXUS__MCP__DOCUMENT_EXPORT_MAX_BYTES`) limits the complete serialized
`read_doc` envelope. It defaults to 8 MiB and accepts 64 KiB through 64 MiB.
The server rejects an oversized result as a whole; it never truncates a block,
HTML document or asset manifest.

## Security notes

- API keys are bearer credentials. Store them like passwords.
- Revoke keys that are no longer needed.
- Prefer read-only keys unless the client actually needs to write.
- `write:docs` does not bypass workspace/document roles.
- Mismatched workspace/document identities and targets denied by your current
  permissions are rejected even with a valid key. The same key can access other
  workspaces when its scopes and your permissions allow it.
- Empty replacement fragments are valid only through an explicitly confirmed
  `update_doc`/`replace_all`; targeted patch fragments must contain a block.

## Observability

Operators use the existing Admin and server observability surfaces:

- Admin Audit Log: filter category `mcp` to inspect MCP API-key lifecycle,
  successful write tools and write-intent permission denials. API-key actors are
  shown as delegated credentials; audit rows never contain plaintext keys,
  hashes or document content.
- System -> Logging: the existing `mcp` log group controls runtime verbosity for
  MCP transport, tool dispatch and failures.
- System -> Metrics: the existing business-metrics category toggle includes
  `mcp`. Prometheus series use names such as
  `myoxus_metric_mcp_transport_request`,
  `myoxus_metric_mcp_auth_denied`,
  `myoxus_metric_mcp_invalid_request`, `myoxus_metric_mcp_tool_call`,
  `myoxus_metric_mcp_write`, `myoxus_metric_mcp_permission_denied` and
  `myoxus_metric_mcp_scope_denied`. Lifecycle tool calls add
  `myoxus_metric_mcp_page_lifecycle_tool_total`; durable fanout is reported in
  the `collab` category as `myoxus_metric_collab_workspace_doc_broadcast_total`.
  Repair outcomes use `myoxus_metric_collab_page_lifecycle_repair_total` with
  bounded drift-class, mode and outcome labels.

Persisted MCP audit events are intentionally low volume:

| Event key                             | When it is written                                              |
| ------------------------------------- | --------------------------------------------------------------- |
| `mcp.api_key.create`                  | A user creates an MCP API key through GraphQL.                  |
| `mcp.api_key.revoke`                  | A user revokes an owned MCP API key through GraphQL.            |
| `mcp.doc.create`                      | `create_page` succeeds.                                         |
| `mcp.doc.import`                      | `document_import` succeeds.                                     |
| `mcp.doc.image.insert`                | `document_image_insert` succeeds.                               |
| `mcp.document_asset.upload.prepare`   | `document_asset_upload_prepare` initializes or reuses metadata. |
| `mcp.doc.patch`                       | `doc_patch` succeeds.                                           |
| `mcp.doc.update`                      | `update_doc` succeeds.                                          |
| `mcp.doc.trash`                       | `delete_page` succeeds.                                         |
| `mcp.doc.restore`                     | `restore_page` succeeds.                                        |
| `mcp.doc.projection.repair`           | An explicit apply changes exactly one selected projection.      |
| `mcp.doc.metadata.update`             | `doc_metadata_transition` or `doc_metadata_update` succeeds.    |
| `mcp.doc_version.create`              | `doc_version_create` succeeds.                                  |
| `mcp.folder.create`                   | `folder_create` succeeds.                                       |
| `mcp.folder.update`                   | `folder_update` succeeds.                                       |
| `mcp.folder.delete`                   | `folder_delete` succeeds.                                       |
| `mcp.folder_entry.create`             | `folder_entry_create` succeeds.                                 |
| `mcp.folder_entry.update`             | `folder_entry_update` succeeds.                                 |
| `mcp.folder_entry.delete`             | `folder_entry_delete` succeeds.                                 |
| `mcp.blob.upload`                     | `blob_upload` succeeds.                                         |
| `mcp.blob.delete`                     | `blob_delete` succeeds.                                         |
| `mcp.database.row.create`             | `database_row_create` succeeds.                                 |
| `mcp.database.cell.update`            | `database_cell_update` succeeds.                                |
| `mcp.database.row.update`             | `database_row_update` commits an atomic patch batch.            |
| `mcp.database.row.delete`             | `database_row_delete` soft-deletes a row.                       |
| `mcp.database.row.restore`            | `database_row_restore` restores a soft-deleted row.             |
| `mcp.database.row.from_template`      | `database_row_from_template` succeeds.                          |
| `mcp.workspace_automation.run.retry`  | `automation_run_retry` succeeds.                                |
| `mcp.organization_unit.create`        | Organization-unit creation succeeds.                            |
| `mcp.organization_unit.update`        | Organization-unit attributes are updated.                       |
| `mcp.organization_unit.move`          | Organization-unit parent is changed.                            |
| `mcp.organization_unit.status.update` | Organization-unit status changes.                               |
| `mcp.organization_unit.delete`        | An inactive, unreferenced organization unit is deleted.         |
| `mcp.calendar_event.create`           | A native workspace event is created.                            |
| `mcp.calendar_event.update`           | A native workspace event or occurrence is updated.              |
| `mcp.calendar_event.delete`           | A native workspace event or occurrence is deleted.              |
| `mcp.permission.denied`               | A write-intent tool is denied by missing scope or ACL.          |

Validation, not-found and backend errors stay in logs/metrics and do not create
durable audit rows. Audit metadata may include tool name, outcome, required
scope, target type, workspace/doc/folder/event ids and request payload size. It
must never include document content, event title/description/participants/
reminders, plaintext API keys or key hashes.

## Runtime verification

The repository's manual `mcp.client-runtime.smoke` owner runs
`build/scripts/test/smoke-mcp-clients.sh`. Use the standard development Admin
credentials from `build/scripts/test/seed-test-users.sh` through
`MYOXUS_MCP_SMOKE_EMAIL`/`MYOXUS_MCP_SMOKE_PASSWORD`, never a production account.
The script verifies the served revision/image, retains its generic HTTP journey,
and additionally uses Codex app-server and Copilot headless RPC to make real
MCP reads, a Calendar write with exact same-key replay and committed readback,
then explicit authentication rejection on a fresh native connection with the
same revoked key. No model prompt or inference is
needed. Native client traces supply protocol-version evidence; importing a
configuration alone is not acceptance. The dedicated workspace is permanently
removed through Admin, client process groups are stopped and private CLI homes
are removed; cleanup failure fails the smoke.

Create a short-lived key for a synthetic user with the minimum required scope.
From the intended client, verify initialization, paginated tool discovery, one
read and one idempotent write in the synthetic workspace. Confirm a deliberately
out-of-scope operation is denied, review the corresponding redacted audit
event, then revoke the key and require the old credential to return HTTP 401.

Do not reuse a production key for this probe. Remove the synthetic resource and
client configuration afterward, and verify no plaintext key or content payload
appeared in logs or support output.

## Document normalization loss

`create_page`, `document_import`, `update_doc` and fragment-based `doc_patch`
operations accept `strict_loss: true` to reject any parser or normalization
finding before document, history, placement or outbox writes. The default
preserves Markdown acceptance and returns `normalizationDiagnostics`,
`normalizationDiagnosticCount` and `normalizationDiagnosticsTruncated` when
findings exist. At most 100 payload-free findings are returned; the total still
counts all findings. Each finding supplies `code`, `sourcePath` and `sourceKind`.
Paths refer to input Markdown or its ordered native projection, not referenced
private documents. Lossless responses keep their existing shape.

The native-to-fragment owner reports `omitted_unsupported_block` and
`omitted_table_placeholder`; other parser/projection findings remain explicit.
Typed inline citations retain their labels and reference payloads. Local
footnotes retain their ordinary definition children in the same document;
fragment-local `definitionId` values are rebound to new native block IDs.
Callouts retain their type, authored title, folding defaults and ordered children.
No existing-document Markdown roundtrip is performed. Sources and footnotes are
optional; unknown structured fields/containers are rejected.

Structured fragments may use `callout`, `footnote_definition` and
`citation_definition`. A `footnote` span uses a protected space and exactly one
of `reference` (the existing `doc` / `url` / `attachment` payload) or
`definitionId`, with its authored `label`. The writer uses the existing codec's
label comparison and checks the destination as well as the incoming fragment.
A conflicting citation target, duplicate local definition or dangling local
reference fails before persistence; labels are never automatically renumbered.
Untouched blocks and their links/identities remain native.

For example, supported `> [!warning]- Title` callouts pass `strict_loss: true`.
A formula inside a link, such as `[formula $x$](https://example.test)`, still
produces `markdown_UnsupportedMath` and fails strict mode without a write. Correct or
explicitly accept a reported transformation before retrying. A committed
fallback receipt retains warnings after interruption; reuse its original key
instead of authorizing another write.

Markdown formulas remain native editable content through create/import/fragment
patch and replacement: display math uses `myoxus:latex` version 1 and inline
math retains the atomic `latex` attribute. Lossless formulas also pass
`strict_loss: true`; ordinary LaTeX code remains code. Private import provenance
is retained through the existing projection/mutation owners and distinguishes
formula writes from code in idempotency payloads. Markdown import retains its
existing `Code { native_latex: true }` readback projection; it does not change
HTML/PDF/structured reading contracts.

The structured write path is separate from Markdown import: `create_page`,
`document_import`, `update_doc` and fragment-based `doc_patch` admit a `latex`
block kind (native `myoxus:latex` block with a plain-string source) and an
inline `latex` span (one native space, no other marks or semantic atoms).
`doc_patch` `update_block_properties` with a `latex` field edits a block
formula's plain-string source in place; omission preserves the source, an
explicit empty string clears it, and non-`myoxus:latex` targets are rejected.
Private native readback exposes the block source as a single plain `source`
field and the inline formula's `latex` attribute on its protected span.

## Continue document search

Call `search_docs` with `workspace_id`, `query`, an optional `language` and
`limit` (default 10, maximum 50):

```json
{ "name": "search_docs", "arguments": { "workspace_id": "<workspace UUID>", "query": "release", "language": "en-US", "limit": 50 } }
```

Each result includes `results`, `total_count` (returned count), `next_cursor` and
`exhausted`. Repeat the same query, language and workspace with the returned
opaque `cursor` until `exhausted` is true. A final `next_cursor` is null. Keep
following an empty page if it still has a cursor: each request scans at most
4,000 candidates, with current permissions and live-document checks. Cursors
belong to the authenticated user and fail on context mismatch. An unchanged
index gives duplicate-free traversal; concurrent index updates may reorder hits.

## Format a native text span

Native structured spans also accept `underline`, `color`, `background` and
`labelTone`. Colors use the editor palette: `red`, `orange`, `yellow`, `green`,
`teal`, `blue`, `purple`, `grey`; label tones are `neutral`, `info`,
`positive`, `warning`, `danger`, `accent`. Formatting sets a color/tone with
`{"action":"set","value":"blue"}` (or a tone) and removes it with
`{"action":"remove"}`. `underline: false` removes underline. Omission keeps
existing attributes; arbitrary CSS and null changes are rejected.

Structured block responses and mutation `updatedBlocks` include `native`
editing details. Each text field reports exact source spans, `rangeUnit` and
`length`, including protected semantic runs. Use those coordinates rather than
visible formula/reference labels. Empty native paragraphs/headings remain valid
private edit targets. Public rendering and export formats retain their contracts.
This includes the page lifecycle's existing blank starter paragraph. Address
returned blocks by ID and source spans rather than fixed array positions.

`doc_patch` accepts `operation: "format_text"` with `block_id`, `start`, `end`
and a nonempty typed `formatting` object. It changes the original native text;
block IDs, neighboring spans, references and formula attributes are preserved.
As with `edit_text`, ranges default to UTF-8 bytes; explicit
`utf16_code_units` and `unicode_scalars` are available. Encoding boundaries are
required, not grapheme boundaries. Use `expected_text` and `expected_revision`
to reject changed content before a write, plus the required durable key.

```json
{
  "name": "doc_patch",
  "arguments": {
    "workspace_id": "<workspace UUID>",
    "external_id": "<externalId>",
    "operation": "format_text",
    "block_id": "<native block ID>",
    "start": 0,
    "end": 4,
    "range_unit": "unicode_scalars",
    "expected_text": "café",
    "expected_revision": 7,
    "formatting": {
      "bold": true,
      "italic": false,
      "link": { "action": "set", "href": "https://example.com/" }
    },
    "idempotency_key": "format-cafe-once"
  }
}
```

The only flags are `bold`, `italic`, `strike` and `code`. `true` sets a mark,
`false` removes it, and omission preserves it. Links use the explicit `set`
shape above or `{"action":"remove"}`. The canonical link validator normalizes
HTTP/HTTPS, mailto and tel links and rejects unsafe schemes/private targets;
input and normalized URLs stay within 4,096 UTF-8 bytes. Empty changes, empty
ranges, nulls and arbitrary attribute names are rejected. Native references
and formula attributes are never supplied through this operation. An exact
retry returns its original result without duplicate updates, history or events.

## Document table headers

Tables without headers are valid document content. Header designation is a
native table property, independent of bold cell text.
In a structured `read_doc` result, `headerRows: 0` means no header and a positive
count designates that many leading rows. An absent property is legacy state:
the editor does not designate a header, while HTML/PDF retain their first-row
fallback.

GFM designates exactly one header row: both direct editor import and the
shared Rust importer persist `headerRows: 1`. MCP retains that count through
`create_page`, `document_import`, fragment patches and confirmed `update_doc`.
Structured table fragments accept optional `headerRows`, an integer from zero
through the row count. Explicit zero designates no header; omission leaves the
native property absent. Null, negative, fractional and excessive values fail
before admission or writes. Text formatting does not infer a header.

For example, create a headerless table with:

```json
{
  "name": "create_page",
  "arguments": {
    "workspace_id": "00000000-0000-0000-0000-000000000000",
    "title": "Headerless table",
    "fragment": {
      "schemaVersion": "myoxus.document-fragment.v1",
      "blocks": [{ "kind": "table", "headerRows": 0, "rows": [[[{ "text": "First body row" }]], [[{ "text": "Second body row" }]]] }]
    },
    "strict_loss": true,
    "idempotency_key": "headerless-table-1"
  }
}
```

Use one or two for that many leading header rows, or omit `headerRows` to retain
absent designation. Call `read_doc` with the returned `externalId` and inspect
`document.blocks[].headerRows` to verify the native state. `strict_loss: true`
accepts these representable fragments and GFM tables. Existing table counts can also be corrected through `doc_patch` or editor Table
settings. Read the table block ID and revision first, then patch it without
replacing its rows or cells:

```json
{
  "name": "doc_patch",
  "arguments": {
    "workspace_id": "WORKSPACE_UUID",
    "external_id": "DOCUMENT_EXTERNAL_ID",
    "operation": "update_block_properties",
    "block_id": "TABLE_BLOCK_ID",
    "properties": { "headerRows": 2 },
    "expected_revision": 123,
    "idempotency_key": "correct-table-headers-1"
  }
}
```

Replace `123` with the revision returned by `read_doc`. Read back the affected
block to confirm the count. Zero removes designation;
omission preserves it. The count is checked against current native row order
and cannot include a template-repeat prototype. Wrong block kinds, stale
revisions and invalid counts leave the document unchanged. The existing
`write:docs` scope and document Update permission apply.

Document receipts preserve their normalization format. Completed historical
Markdown receipts replay against the exact former payload with only the derived
GFM count removed; they create no new document effects. Historical pending
receipts with that changed hash remain in progress. Structured header changes
and new-format receipts never use the historical comparison. An unchanged
payload retains ordinary fenced lease recovery.

Markdown export/re-import preserves these tables. Exactly one header row uses
GFM pipes. Zero, multiple or absent counts use a standard HTML table block in
Markdown: `tbody/tr/td` for zero/absence and leading `thead/tr/th` rows for
multiple headers. A fresh import may store an absent count as explicit zero;
export does not alter the original native property or HTML/PDF legacy fallback.
Representable tables add no loss diagnostic and remain `complete: true`;
Markdown retains its existing format-wide `lossy: true` flag. Import accepts
`strict_loss: true`. Basic marks, links, empty cells, breaks and literal
HTML characters survive. Unrelated HTML, active attributes/tags, arbitrary CSS,
spans and nested tables fail safely before server writes. Desktop client
Markdown import/export uses the same bounded table mapping; unsupported table
HTML is retained as inert source code with a visible diagnostic.

For example, import a genuine headerless table into an existing folder path:

```json
{
  "name": "document_import",
  "arguments": {
    "workspace_id": "WORKSPACE_UUID",
    "folder_path": ["Documents"],
    "title": "Body rows",
    "content_markdown": "<table><tbody><tr><td><strong>Label</strong></td><td></td></tr><tr><td>first<br>second</td><td>&lt;literal&gt;</td></tr></tbody></table>",
    "strict_loss": true,
    "idempotency_key": "import-body-table-1"
  }
}
```

Use `read_doc` with `representation: "markdown"` to export, then import its
`data` as `content_markdown`. Leading header sections carry their real row count;
no fake row or metadata marker is added. Newly admitted table HTML never uses
historical GFM receipt fallback; fenced/literal HTML retains its classification.

To designate a header on an existing table, open the document in the editor and
use the row or column menu's **Table settings → First row**. The row menu also
offers **Header through this row**; **No header** removes designation. Read the
table again through MCP to confirm the resulting `headerRows`. Keep cell-only
changes on `edit_table_cell`, which preserves an existing header count; replacing
the table through a fragment uses its supplied header designation and creates
new native identities. Editor tables use document tools, rather than Database tools.

## Edit one native table cell

Read the structured document first. For each returned native table,
`document.tableIdentities[blockId].rowIds` and `.columnIds` correspond to its
`rows`/cell positions. Use those opaque IDs with `operation: "edit_table_cell"`;
numeric row/column positions are not mutation identities. A whole-cell edit
uses the range from zero through the native text length; a narrower range
replaces only that span. `replacement` is plain text, up to 1,048,576 Unicode
characters, using existing native insertion semantics. Untouched rich spans,
references, adjacent cells, headers, presentation and column dimensions stay
intact. No row/column creation, deletion or resizing is exposed.

```json
{
  "name": "doc_patch",
  "arguments": {
    "workspace_id": "00000000-0000-0000-0000-000000000001",
    "external_id": "document-from-read",
    "operation": "edit_table_cell",
    "block_id": "table-from-read",
    "row_id": "row-from-table-identities",
    "column_id": "column-from-table-identities",
    "start": 0,
    "end": 4,
    "range_unit": "unicode_scalars",
    "expected_text": "café",
    "replacement": "Café",
    "expected_revision": 7,
    "idempotency_key": "cell-edit-1"
  }
}
```

Range units, exact `expected_text`, revision checks and retry behavior match
the existing targeted text mutation contract. Missing coordinates or cell
TextRefs fail without creating content. IDs are returned only for the tables
on the current structured page/selection; continue reads normally or select
the table's block ID. Export representations retain their existing contracts.
Editor tables use document tools, never the server-backed Database tools.

## Read one named version

Use the version ID from `doc_version_list` or `doc_version_create`, together
with its workspace and external document key:

```json
{
  "name": "doc_version_read",
  "arguments": {
    "workspace_id": "00000000-0000-0000-0000-000000000001",
    "external_id": "document-key",
    "version_id": "00000000-0000-0000-0000-000000000002",
    "limit": 50
  }
}
```

The result contains `versionId`, `docHistoryId`, structured `document`,
`projection` and `page`. Read `projection.complete` and `diagnostics` before
assuming every native block was extracted. The source is
`named_version_snapshot`, with historical title/content and no live business
metadata badges or live write `revision`. Follow `page.nextCursor` with the
same version and authenticated user; limits range from 1 to 200. Live edits do
not change historical pages. Each call still requires `read:docs`, current
workspace membership and document Read; private assets use existing permission
checks and authenticated `blob_read` references. Missing or foreign versions
fail instead of returning nearby or current content.

## Restore one named version

Read the current document revision with `read_doc`, then confirm the selected
version explicitly. Keep the same arguments and key when retrying a lost reply:

```json
{
  "name": "doc_version_restore",
  "arguments": {
    "workspace_id": "00000000-0000-0000-0000-000000000001",
    "external_id": "workspace-local-document-key",
    "version_id": "00000000-0000-0000-0000-000000000002",
    "confirm_restore": true,
    "expected_revision": 42,
    "idempotency_key": "restore-reviewed-version-once"
  }
}
```

This requires `write:docs` and current document Update permission. A stale
revision rejects a new restore; a previously committed identical retry returns
its original committed result, even after later edits. Current permissions are
checked again before replay. The response identifies the new server-labelled
version, restored source, committed revision and append-only
`recoveryHistoryId`. The source snapshot remains immutable, the pre-restore
content remains recoverable, and current business metadata remains current.
The native editor can reload and continue editing the restored content. Missing
confirmation, revision or key is rejected. This operation uses the existing
atomic history owner and its API-key audit, not a separate restoration engine.

## Create, poll, download and inspect a PDF

Use the global `/mcp` endpoint with an API key carrying `read:docs` and current
workspace/document Read. Reuse the key and unchanged arguments for retries.
Omit `template_id` to consume the already assigned workspace default, or select
an assigned template explicitly. The bundled `default` and `report` templates
require their typed `title` input; omission of the selector does not bypass the
selected manifest's input requirements.

Both `default` and `report` render their typed title override. For `default`,
this replaces only the visible first-page title: PDF metadata and download names
remain derived from the native snapshot title. The native document is unchanged.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "pdf_export_create",
    "arguments": {
      "workspace_id": "<workspace UUID>",
      "external_id": "<document external ID>",
      "idempotency_key": "report-export-001",
      "template_id": "report",
      "locale": "de",
      "paper_size": "A4",
      "orientation": "portrait",
      "image_quality": "med",
      "typed_inputs": { "title": "Selected report title" }
    }
  }
}
```

The structured result can be synchronous `done` or asynchronous `queued`.
Call `pdf_export_get` with `{"job_id":"<returned jobId>"}` until the job is
terminal. A create retry returns its original durable receipt; use polling to
observe later completion. When `delivery.available` is true, fetch the returned
`delivery.url` with `Authorization: Bearer <same API key>` using normal HTTP.
The URL uses current user permissions and is not a signed bearer link.

Inspect actual PDF text (for example `pdftotext export.pdf -`) and rendered
pages; verify both document content and the selected typed title. Inspect
`source.historyId`, optional named version identity and the native snapshot
SHA-256 revision, plus `diagnostics.findings`/`unmappedFontFamilies`. Coverage
reports only observed pipeline findings, not universal readiness.
Missing stored image files can fail compilation. A failed queued job retains
known findings. A synchronous `PDF_EXPORT_FAILED` result carries its safe class
and findings as JSON in `message`, without private paths or compiler source.
Preflight input errors retain actionable field metadata; an unsupported
`compliance_profile` value is an input error, rather than a completed render.

`artifactExpiresAt` reports the artifact retention boundary; expiry removes
delivery availability and downloading returns 410. Revoked/expired API keys,
missing `read:docs` or lost current workspace/document access cannot download
PDF bytes. Do not work around a retry error by inventing a new idempotency key.

### Manual OU membership mutations

`organization_unit_member_add`, `organization_unit_member_set_role` and
`organization_unit_member_remove` require `write:organization`, an active global
Admin at call/replay time, and `idempotency_key`. All take explicit `unit_id` and
`user_id` UUIDs; add/set-role also require `reader`, `member` or `manager`.
Add rejects existing membership; set-role/remove reject absent membership.
The same `OrganizationMembershipService` serves Admin GraphQL and CLI, committing
manual membership and its derived Manager transition atomically. First Manager
grants the capability; another Manager OU retains it; last removal/downgrade
revokes it. API and CLI invalidate the same feature caches after commit.
Reader/Member-only changes retain independent global Manager grants. Removal
from inactive OUs remains possible; assignment/role change enforces active status
and member limits. Stable safe errors distinguish those cases and missing users.
Replay returns the committed result without another membership/capability audit.
These tools create no user, workspace membership, mirroring or manager-mode MCP
capability. Reduced runtimes without the shared membership owner omit them.

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

`database_view_get` requires `read:databases` and current Workspace read
authority. It returns the canonical `view` separately from the current actor's
`effectiveSort`, `effectiveFilterTree`, `searchText`, `effectiveFieldWidths` and
`canEditShared`, resolved by the existing View query owner. It neither changes
personal overrides nor exposes another user's state. Use `database_query`
with the returned view ID to consume that same effective query policy.

`database_view_create`, `database_view_update`, `database_view_delete` and
`database_view_reorder` require `write:databases`, current Database manager/creator
authority and durable `idempotency_key`. Config and icon inputs use complete
canonical tagged DTOs from `database_get`; config is bounded to 65536 bytes.
Create requires name/kind/config. Update/delete require the captured positive
`expected_edit_revision`; reorder includes every view once (1–200 IDs) and an
exact `expected_edit_revisions` UUID map. No force overwrite is exposed.
Omitted update icon preserves it; null clears it and has a distinct replay hash.
Kind-only changes must match the retained config. Existing required profile
roles use the canonical compatible `replacement_view_id` deletion rule.

Shared Schema service commands preserve rows and retained views' personal
state. Every replay rechecks current parent authority, including after a
disposable view has been deleted. SQL updates carry the authorized Workspace
binding; ambiguous write/readback retains admission. Audit records use
`mcp.database.view.{create,update,delete,reorder}` with IDs/outcome/size, never
view names, query text, filter values or personal settings. Response size uses
the existing configured MCP byte ceiling; oversized reads fail visibly and
post-write oversize remains fenced for operator readback.

### Read-only Workspace Automation discovery

`automation_list`, `automation_run_list`, `automation_run_get` and
`automation_dead_letter_list` require `read:automations` plus current Workspace
Read permission. `write:automations` does not imply read access; read-only keys
cannot call `automation_run_retry`. All four tools disappear from discovery if
the existing WorkspaceAutomationService is unavailable.

Lists accept `workspace_id`, `limit` (1–200, default 50) and `offset` (default
zero), returning `has_more` and nullable `next_offset`. Run lists additionally
accept `automation_id` and `include_dead_letter` (default false). A foreign
Workspace's automation ID does not select its runs. `automation_run_get` accepts
one `run_id` and authorizes its actual Workspace. No read enqueues jobs.

Inventory contains identities, status, trigger/action types and attribution,
without descriptions, action configuration or trigger content. Run projection
contains canonical status, attempts, dead-letter state, timestamps, nullable
`jobId`, known error code and a static safe error summary. It excludes raw
errors, trigger events and idempotency keys. An accepted queue job's identity
is retained on the existing run; historical or unavailable identities remain
null. This metadata does not change execution, retry or queue ownership. If a
metadata write fails after enqueue acceptance, work remains accepted and is not
restored or enqueued a second time. Oversized output returns a bounded error;
reduce the page limit instead of expecting silently truncated content.

### Runtime OKF document reads

Use `read_doc` with `representation: "markdown"` and
`include_okf_frontmatter: true` to retrieve generated YAML frontmatter with the
native Markdown body. The default representation is unchanged. Outline and
selected-section reads stay on `representation: "structured"`.

The accompanying `okf` result contains native metadata revision/catalog version,
canonical tag references, bounded diagnostics and `myoxus://<workspace>/<key>` as
its retrieval reference. That reference identifies the document; `resource`
describes an explicitly declared underlying asset. Current title/tags and
explicit native type/status assignments override import declarations, whose
superseded values remain in `retained_frontmatter`. Inherited defaults yield to
valid imported type/status. The earlier review/validity deadline becomes
`stale_after`. Frontmatter is a read-time representation, never a second editable
copy or a native body prefix.

Source IDs use the existing citation labels. Authorized internal source title,
modification and page-view facts are bounded and independently read; failed or
denied facts remain unknown with diagnostics. Usage windows cover the previous
28 complete SQL analytics days with exact offset-qualified boundaries. Declared
provenance/extensions remain retained, while producer attribution, verification
and computation execution are never inferred from the caller, editing or reads.
An incomplete Markdown projection remains incomplete. Content and metadata
revisions describe separate components rather than one atomic snapshot.

## MCP search metadata

Authorized returned hits include available `okf_type`, canonical `tags`,
`document_updated_at` and `metadata_updated_at`. `updated_at` remains the
index timestamp. Opening `description` is separate from the query-centered
`snippet`; `description_source` distinguishes retained declarations from
indexed excerpts, which also carry `description_index_updated_at`.
Unavailable enrichment is omitted with `enrichment_diagnostics`, never
confirmed empty or verified. Only the returned page (at most 50 documents) is
enriched; source bodies are not loaded. The configured output bound covers
the complete result. Request a smaller limit if it is exceeded.

### Rich replacements and callout titles

Use exactly one of `replacement: "plain text"` and
`replacement_spans: [{"text":"plain"},{"text":"styled","bold":true}]`
with `edit_text` or `edit_table_cell`. Empty spans delete the selected range.
Each inserted rich run has exactly its admitted attributes, including plain
runs inside styled text. Plain `replacement` retains existing native style
inheritance. Both forms use the existing ranges, `range_unit`, `expected_text`,
revision preconditions and durable retry keys.

For `edit_text` on a callout, `text_field: "text"` (the default) selects its
body; `text_field: "title"` selects its single-line plain title and accepts only
`replacement`. An absent title accepts insertion at range 0–0. Existing title
TextRefs remain intact. `update_block_properties` with a `latex` field targets
a block formula's plain-string source; omission preserves the source, an
explicit empty string clears it, and non-`myoxus:latex` targets are rejected.
Structured creation retains plain `title`. `format_text` supports body text and
table cells with
both `row_id` and `column_id`; title formatting is rejected. Copy stable
coordinates from the existing read output. Code and captions remain plain fields.

The Web callout title input appears when `calloutType` is set. MCP does not add
or change the type implicitly when editing a title.

### Ordinary text-block properties

Ordinary native block properties use the existing `update_block_properties`
operation. New fields take `{ "action": "set", "value": ... }` or
`{ "action": "remove" }`; omission preserves the stored value. Removal deletes
only that native property, whereas setting `false` stores an authored false.
Paragraphs/lists support `textAlign`; paragraphs support `presentation: eyebrow`;
headings/lists support `collapsed`; numbered lists support integer `order`.
Callouts support `calloutType`, `icon`, `backgroundColorName`, `appearance`,
`foldable` and authored `defaultOpen`. Code supports `wrap`, plain `caption`,
`preview` and `lineNumber`. Existing plain property fields retain their shipped
shape and meaning. Combined `listKind: todo` and `checked: true` is one atomic
edit. The existing editor may initialize a removed numbered-list order on load.
Local footnote definitions support a set-only `label` rename and a
`placement` of `footnote` or `endnote` through the same operation; the rename
updates the definition and every marker carrying its identity in one mutation,
and the collision check runs before any write. `placement` removal reverts to
the legacy absent-footnote default without rewriting stored data.

Structured ordinary fragments accept the same new fields in `properties`,
validated for that fragment's native kind and written through the existing
property updater. Existing creation fields remain available; do not supply
both a flat callout field and its corresponding property change. Callout titles
use the separate plain-title text operation so their TextRef is retained.
Icons accept `{ "type": "emoji", "unicode": "💡" }` or
`{ "type": "myoxus-icon", "name": "Info", "color": "blue" }` with the
existing editor glyph catalog and text palette. Backgrounds use the existing
palette plus `default`; appearance is `soft`, `accent` or `outline`. No arbitrary
CSS or media payload is admitted. Private native readback reports present
properties without resolving unknown stored color strings or injecting defaults.

A reset acts on the locked native state. On a later load, the existing Web
model can materialize its declared required defaults (for example paragraph
`type: text` and `collapsed: false`, or a list order). Readback reports those
actual subsequent client writes; the server does not silently reapply a reset.

`presentation: eyebrow` can be set only on plain text paragraphs. Heading and
quote renderers do not apply it; explicit removal can clear a retained value.
The code `preview` flag takes effect when the editor has a preview renderer
registered for the block's language.

### Native authoring example

Use `create_page` with a structured fragment. Substitute an authorized workspace
ID; the example requires no Markdown conversion:

```json
{
  "workspace_id": "<workspace-id>",
  "title": "Native editing example",
  "idempotency_key": "native-example-create",
  "fragment": {
    "schemaVersion": "myoxus.document-fragment.v1",
    "blocks": [
      {
        "kind": "paragraph",
        "spans": [
          { "text": "Draft " },
          {
            "text": "café 😀",
            "bold": true,
            "underline": true,
            "color": "blue",
            "background": "yellow",
            "labelTone": "info"
          }
        ],
        "properties": { "textAlign": { "action": "set", "value": "left" } }
      },
      {
        "kind": "callout",
        "calloutType": "warning",
        "title": "Plain title",
        "spans": [{ "text": "Editable rich body", "italic": true }],
        "properties": {
          "backgroundColorName": { "action": "set", "value": "yellow" },
          "appearance": { "action": "set", "value": "outline" },
          "foldable": { "action": "set", "value": true },
          "defaultOpen": { "action": "set", "value": false }
        }
      },
      {
        "kind": "table",
        "headerRows": 1,
        "rows": [[[{ "text": "Header", "bold": true }]], [[{ "text": "Cell" }]]]
      }
    ]
  }
}
```

Keep `externalId` from creation and read the document with `read_doc`. Copy the
paragraph's `blockId` and current `revision`. Then call `doc_patch` with these substituted
values (the illustrative revision `1` must be replaced by the actual read):

```json
{
  "workspace_id": "<workspace-id>",
  "external_id": "<created-external-id>",
  "operation": "edit_text",
  "block_id": "<paragraph-block-id>",
  "expected_revision": 1,
  "idempotency_key": "native-example-replace",
  "range_unit": "utf16_code_units",
  "start": 6,
  "end": 13,
  "expected_text": "café 😀",
  "replacement_spans": [{ "text": "Résumé " }, { "text": "🌿", "underline": true, "color": "green" }]
}
```

The plain replacement run clears inherited marks; the explicitly styled run
contains only its requested marks. To continue in a cell, copy its native
`rowId`/`columnId` from that same read, use `edit_table_cell` for replacement or
`format_text` for marks, and supply `row_id`/`column_id`. For the callout title,
use `edit_text` with `text_field: "title"` and plain `replacement`. Refresh the
revision and native field positions after each successful edit. Protected
semantic runs retain their native widths: a document-reference label can render
many characters while occupying one protected native space. Use the returned
native spans, never offsets derived from that visible label. For an uncertain
write, replay the exact original arguments and key.

Conversion within a native paragraph/list flavour retains its ID. Paragraph ↔ list
returns a fresh ID in `insertedBlockIds` and the retired ID in `removedBlockIds`.
Continue subsequent edits at that returned ID; rich text and descendants survive.
Protected comment/block anchors and unsupported parentage reject before writes.

Nesting uses `move_block` with `parent_block_id` and optional `after_block_id`.
Both IDs must describe the actual destination; native leaf/invalid parents and
cycles reject. For an explicit unwrap, preserve wrapper title/own text first,
move existing children out in order, then delete the empty wrapper. A deletion
never transfers remaining content. `duplicate_block` copies supported native
text/callout structure; `native.fields[].spans[].annotationId` distinguishes its
new annotation identities. Local footnote definitions remain shared in the same
document. Repeat is retained under its existing validity rules.

### Maintain an existing native table

Read the table and its revision with `read_doc`. Use `tableIdentities` for
ordered stable row/column IDs. `doc_patch` supports insert/delete/move/duplicate/clear
for each axis, with `block_id` and the relevant `row_id`/`column_id`. Insert/move
use optional `after_row_id`/`after_column_id`; omission means first position.
Read back after a change to obtain newly allocated coordinates. Clearing removes
content while keeping the coordinate; deleting the final axis retains the table
and surviving opposite coordinates for later insertion.

For presentation, use `update_block_properties` with, for example,
`properties: { "table": { "appearance": { "action": "set", "value": "ruled" },
"density": { "action": "set", "value": "compact" } } }`.
`update_table_row_properties` sets/removes palette `backgroundColor`.
`update_table_column_properties` also sets/removes left/center/right `textAlign`
and finite `width` values of at least 60 pixels. Each property resets through
`{ "action": "remove" }`; omission keeps the existing value. Header counts,
cell contents and stable IDs remain intact during presentation changes.

### Edit an inline document reference

Use a structured span `{"text":" ","reference":{"pageId":"<target-external-id>","title":"Optional label"}}` in a fragment or `replacement_spans`. Resolve targets through existing document inventory. Read `native.fields[].spans[].reference` and its native start/end; replace the full atom with a new reference to change its target or label, or with `replacement_spans: []` to remove it. Insertion uses an empty range. The caller needs current Read access to each new target on every call/replay. Arbitrary navigation params, private IDs and links combined with references are refused. `document_reference_insert` remains available for inserting a reference paragraph.

### Author literal annotations

A fragment can contain `{"kind":"annotation","text":"Literal $x$ %%body%%"}`
and an inline span `{"text":"Literal https://example.test/$x$","annotationId":"note-1"}`.
The span's key groups its body within that insertion; the server allocates a
fresh native identity. Read the returned block's `native.fields[].spans` for
that actual `annotationId`, source text and positions.

Use `doc_patch` with `operation: "edit_annotation"`, `block_id`, `annotation_id`,
`start` and plain `replacement`. `start` selects the beginning of the contiguous
body; ordinary `range_unit`, `expected_text`, `expected_revision` and retry-key
rules apply. In a cell, supply both `row_id` and `column_id`. Adjacent native runs
with one ID form one body; separated bodies with that ID have distinct starts.
An empty replacement removes only the selected body. For standalone annotations,
use ordinary plain `edit_text`, or `delete_block` to remove the block.

Bodies stay literal, including URLs, formula syntax and delimiters. Existing
public renderer/search omission remains intact; private structured reads and
block/section selection retain these native edit targets. Markdown codecs and
the separate Markdown-to-fragment path retain their existing contracts.

### Insert or revise a person mention without notification

Discover an active accepted member with `workspace_member_list`, then use
`{"text":" ","mention":{"member":"<member-uuid>"}}` in a structured fragment
or `replacement_spans` for `edit_text`/`edit_table_cell`. Current UsersRead
authority is checked again on every call/replay. Read the optional
`native.fields[].spans[].mention.member` and the atom's native start/end; an
insertion uses an empty range, replacement retargets the whole one-position
atom, and `replacement_spans: []` removes it. Display names are resolved by the
existing editor. Missing, inactive, pending or foreign members and supplied
notification IDs are rejected before writes.

These are text objects inserted **without notification**. `mention_user` remains
a separate explicit notification action. A retargeted atom has no old
notification link; unmodified historical mentions retain theirs. Private
metadata is omitted when current member visibility is unavailable, including
cached write receipts; source widths and stored content remain unchanged.

### Rename a local footnote or change its placement

Use `update_block_properties` on a local footnote definition with `label`
and/or `placement`. `label` is a set-only rename: it must pass the Markdown
footnote-label grammar and not collide with an existing definition,
footnoteIdentifier or marker (normalized comparison); omission preserves the
current label. A rename updates the definition and every marker carrying its
identity (body, title and table cells) in one mutation, and the collision
check runs before any write, so a rejected rename leaves no effect.
`placement` is `{ "action": "set", "value": "footnote" | "endnote" }` or
`{ "action": "remove" }`; removal reverts to the legacy absent-footnote
default without rewriting stored data. The definition's native ID is
preserved. Private native readback exposes the typed marker payload (label,
definitionId, reference) and the definition's label/placement.

### Update a citation source or label

Use `doc_patch` with `operation: "update_citation"`, `label` and at least one
of `new_label` or `reference`. `label` selects the existing citation by its
source label (normalized comparison); `new_label` renames the source and
`reference` replaces it with a typed `doc` / `url` / `attachment` payload.
The inline citation marker is authoritative; the optional source card is
patched in place for same-flavour updates and replaced with a fresh block ID
at the same parent/position for cross-flavour updates. Target authorization is
rechecked before idempotency admission, including exact replay: `doc` targets
require current Read on the referenced document, `attachment` targets require
current blob read, and `url` targets need no target check.
`update_block_properties` `url`/`title` on a citation bookmark card routes
through the same updater. A missing source, label collision or conflicting
inline source rejects before any write.
Omitting `new_label` preserves each stored spelling, even when occurrences
differ. Omit unchanged optional fields rather than sending null. A supplied
`workspaceId` must be a UUID and is canonicalized for checking and storage;
only absence selects the document workspace. Unknown/type-incompatible
reference fields and additional forwarded card properties reject the whole
request. A replacement reference does not bypass conflicting-inline rejection.
