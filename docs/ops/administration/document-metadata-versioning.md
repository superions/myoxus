# Document metadata and versioning operations

[Documentation](../../README.md) / [Operations](../README.md) / [Administration](./README.md)

This runbook covers operational handling of canonical document metadata,
status schemas and document versioning.

<details>
<summary>On this page</summary>

- [Feature state](#feature-state)
- [Admin tasks](#admin-tasks)
- [Workspace tasks](#workspace-tasks)
- [Client projection cache](#client-projection-cache)
- [Saving snapshots](#saving-snapshots)
- [Browsing history](#browsing-history)
- [Restoring snapshots](#restoring-snapshots)
- [Audit](#audit)
- [Retention and GC](#retention-and-gc)
- [Performance checks](#performance-checks)
- [Incident handling](#incident-handling)

</details>

## Feature state

There is no runtime feature flag for the target model. The feature is governed
by policy data:

- global definitions in the Admin frontend Documents module;
- workspace settings in Workspace Settings > Documents;
- versioning policies;
- PDF export attribute export modes.

To make the feature passive, configure attributes as optional, keep export modes
optional/hidden and avoid required transition edges. Do not remove seeded rows.

## Admin tasks

Use **Admin frontend > Documents** for global policy:

- enable or hide canonical attributes;
- choose required modes;
- set `exportMode` for PDF export blocking;
- manage status schemas and transitions;
- manage value lists;
- manage versioning policy defaults;
- review audit entries.

Value definitions that are in use must be deactivated, not deleted. This keeps
historical documents and audit records resolvable.

## Workspace tasks

Workspace admins use Workspace Settings > Documents to select the active status
schema, version policy and defaults. Admin-locked overrides are intentionally
read-only.

Workspace Settings > Documents is the operational surface for document
metadata. Header badge visibility is a personal display preference there; it
does not change the server policy for
`visibleInHeader`, `visibleInProperties` or `visibleInLists`. A personal
preference can only hide a server-visible header badge. It cannot expose a field
that the server policy marks as hidden from the header.

The document header info action opens the document-info metadata editor. The
right workspace sidebar is not the metadata editing surface.

## Client projection cache

Web/Core clients maintain a non-authoritative document-metadata projection cache
in workspace-scoped process memory, not in a userdata database, SQLite or Yjs.
It stores the last full `documentMetadata` model per opened document and the
latest `documentMetadataIndex(workspaceId)` rows for list/filter/group/order
flows.

Operationally important boundaries:

- the server remains authoritative for metadata values, policies, validation,
  versioning and audit;
- the client cache is discarded on reload, logout or workspace disposal without
  data loss; browser storage cleanup is not needed to clear this projection;
- stale cache symptoms are limited to temporarily old header chips, document
  info values or list metadata columns until the next successful GraphQL
  refresh;
- document metadata mutations invalidate the cached list index, while cached
  lookup labels can be reused until the next lookup hydration;
- lookup hydration is tracked per family, so a loaded status label cache does
  not imply document type or classification labels are loaded;
- status/type/classification/version IDs from the index are not operator-facing
  labels and should not appear as polished UI text;
- this cache is unrelated to Redis document caches and does not require a
  server database migration or Redis maintenance action.

When users report stale metadata in the Web frontend, first verify that
`documentMetadata(workspaceId, docId)` returns the expected server state. If it does, refresh
the browser session and inspect failed metadata requests.
Do not patch server rows to match a stale client projection.

## Saving snapshots

An explicit named save waits for the editor's pending writes to be acknowledged
by the server. If the connection is unavailable or the wait times out, no
capture request is sent. Keep the document open, restore connectivity and retry
the save. A successful save closes the dialog and refreshes the current version
display. A subsequent refresh error does not mean that the snapshot was lost;
refresh the overview before creating another version.

The server commits the content snapshot, named version, label counter and
current-version pointer together. Failed capture leaves no partial version or
orphan capture. Existing version numbers and historical gaps remain unchanged.
System-created unnamed snapshots remain unnamed and do not move the current
named-version pointer.

Existing trigger settings continue to control Publish, PDF and Daily creation.
Status transitions retain their existing checkpoint policy. Daily skips content
identical to the latest named snapshot, including concurrent runs; it does not
enforce a separate calendar-day limit. PDF export of `latest` with automatic
versioning enabled creates one version and exports exactly that snapshot.
Exporting an explicit existing version creates no additional version.

## Browsing history

The document menu's **View history version** action and the Versions sidebar's
history action open the same preview. **Open snapshot** on a named version opens
that preview with the exact named reference selected. The sidebar retains
explicit named saving, editing and pinning.

The timeline shows each snapshot once, newest first. Named references annotate
their snapshot with labels, version numbers and pin/protection information.
**Load more** extends the timeline without duplicating overlapping results.
The **Document versions** selector also includes references outside the loaded
timeline. Multiple references to one snapshot remain separate choices; selecting
one preserves its identity for a named restore.

Clear the named selection to restore the selected snapshot without creating a
named version. The clear action is keyboard-accessible. Readers can open and
inspect snapshots but cannot restore them. **Back to doc** returns focus to the
opening action. Cancelling confirmation performs no restore and keeps the
preview open. A failed restore also keeps the preview open; using **Restore**
again prepares a new revision and requires a new confirmation.

Use **Historical preview** for the exact stored Page/Edgeless snapshot or
**Changes to current** for a text comparison with **Current saved document**.
The selected capture is always the source. Green additions and red struck-through
deletions describe changes toward the current server-persisted document, including
acknowledged edits not yet captured. The legend and semantic markers also identify
the direction without relying on color. Pending local uploads are awaited before
reading; failures have Retry. Current revision and server read time identify the
result, with visible refresh/pending feedback. Polling is periodic, not a claim of
instantaneous equality. Structural and partial/non-text notices state comparison
limits. **No detected text changes** does not establish formatting/image/canvas
equality. Switching back leaves the historical preview and restore target intact.

## Restoring snapshots

Restore requires document restore permission, not only read access. Both named
versions and unnamed history entries restore content through the same server
transaction. The state immediately before restoration is retained as an unnamed
recovery snapshot. A named restore creates a new named version linked to its
source; an unnamed restore retains the last named version and marks it changed.
Status, classification, ownership, audience, deadlines and other business
metadata are not rewound from the historical document content.

The Web client waits for acknowledged synchronization before preparing the
confirmation. If content changes before confirmation completes, the server
rejects the stale revision without a partial restore. Review the refreshed
history before confirming again. After a connection error with an unknown
outcome, inspect the refreshed history and current document first; do not assume
that the server failed merely because its success response was lost.

The restored content must become visible in the open editor and remain correct
after reopening. If only reopening fixes the view, inspect native editor bindings
as well as the Socket.IO delivery: a delivered delta alone does not prove that
the view consumed it. No operator-side SQL rewrite or local undo is required.

## Audit

Important audit events:

- `document_metadata.set`
- `document_metadata.transition_status`
- `document_metadata.workspace_settings.update`
- admin policy mutations under the document/version category
- PDF render audit rows with `document_metadata_snapshot` and
  `metadata_validation`

PDF render audit rows are immutable. Use the existing PDF audit purge CLI for
retention of render-audit data.

## Retention and GC

Document version retention is policy-driven. Pinned/protected versions are not
pruned by normal retention. Named restore creates append-only versions and
relations; it never rewrites an existing version row. Unnamed restore does not
create an artificial named version.

If storage pressure appears, inspect:

- document version counts per workspace;
- pinned/protected version volume;
- PDF export artifact expiry;
- render-audit retention.

## Performance checks

For slow document lists, verify the database still has the expected indexes on
the canonical targets used by `documentMetadataIndex(workspaceId)`: `docs`
for status, type, classification, review date, valid-until and current version,
plus the explicit relation/reference tables for many-valued metadata. Do not
create a parallel runtime cache in PostgreSQL to work around a slow query;
classify the query and index owner first.

## Incident handling

If a policy change blocks exports unexpectedly:

1. Inspect **Admin frontend > Documents > Metadata** for the affected field's
   `exportMode` and `requiredMode`.
2. Inspect Workspace Settings > Documents for workspace defaults and locked
   overrides.
3. Query `documentMetadata(workspaceId, docId)` and `documentMetadataValidation(workspaceId, docId, action: export_pdf)` with a native Myoxus client header to see the effective state and validation.
4. Temporarily set `exportMode=optional` for the affected attribute if exports
   must resume quickly.
5. Re-enable the blocking policy only after missing document attributes are
   backfilled or users have been notified.

Do not patch client code to bypass a blocked export. The server repeats
validation immediately before render.

History opens in the normal document Workbench. Its header identifies the
current document; the selected capture and restore controls belong to the
readonly work area. The URL retains the selected snapshot, optional named
reference and preview/changes mode across reload and browser navigation.
Back returns to the same document. Workspace capture settings overlay this
view and retain its selection. The displayed last automatic capture is
explicitly a workspace-wide fact, not evidence of this document's last capture.
Capture/name/pin require document update permission; restore and workspace
settings use their separate existing permission gates.
