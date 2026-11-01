# Document identity operations

[Documentation](../../README.md) / [Operations](../README.md) / [Administration](./README.md)

The canonical schema stores stable document identity in `docs.external_id` and
enforces workspace/userspace uniqueness. There is no second document-identity
read or write path.
Schema changes run at normal API startup through the central Infrastructure
migration runner; no separate migration container is used.

<details>
<summary>On this page</summary>

- [Integrity checks](#integrity-checks)
- [Backup and restore](#backup-and-restore)
- [Repair](#repair)
- [Transfer reference plans](#transfer-reference-plans)

</details>

## Integrity checks

Run these read-only queries after an upgrade or restore:

```sql
SELECT COUNT(*) AS invalid_external_keys
FROM docs
WHERE external_id IS NULL OR btrim(external_id) = '';

SELECT workspace_id, external_id, COUNT(*)
FROM docs
WHERE workspace_id IS NOT NULL
GROUP BY workspace_id, external_id
HAVING COUNT(*) > 1;

SELECT userspace_owner_id, external_id, COUNT(*)
FROM docs
WHERE userspace_owner_id IS NOT NULL
GROUP BY userspace_owner_id, external_id
HAVING COUNT(*) > 1;
```

All three results must be empty/zero. To inspect one browser-visible key:

```sql
SELECT id, workspace_id, external_id, title, created_at, updated_at, deleted_at
FROM docs
WHERE workspace_id = $1 AND external_id = $2;
```

Never query only by `external_id` when diagnosing access, sync or public
publishing. Equal values across different workspaces are valid and expected.

Bounded projection scan reports external keys and may expose an internal source
identifier only for a non-repairable leaf-only orphan. Exact inspection and
repair accept only `(workspace_id, external_doc_id)` plus the inspection
fingerprint; they never accept an internal-ID fallback. Root metadata joins SQL
only by `(workspace_id, meta.pages[].id = docs.external_id)`; leaf presence
joins by internal `docs.id`. UUID-shaped external keys are not internal-ID hints.

## Backup and restore

For vault heading/block-link diagnostics, distinguish the workspace-local
external document key, the native `blockIds` target and the source
`markdownAnchor`. They are not interchangeable even if their strings look like
UUIDs. `VAULT_REFERENCE_TARGET_NATIVE` indicates that the preview resolved the
source selector uniquely into its prepared native tree. Missing or duplicate
selectors remain source-preserved diagnostics. Check the current target content
and source spelling; do not repair links by substituting document UUIDs or
guessing heading slugs. A changed conversion policy invalidates earlier staged
confirmations and requires a fresh preview.

Vault export reports precise-reference projection failures instead of replacing
a missing target with a whole-document link. Generated anchors exist in the
downloaded target Markdown, not as writes to the live editor. Inspect precise
references in the intended destination and use the export report to resolve
missing or ambiguous targets.

For native copy failures, distinguish the OS clipboard capability from document
read access and format conversion. Target preparation can wait for the current
document lifecycle; a read revocation or failed conversion must not replace the
clipboard with a partial result. Cut may leave the original content in place
when another edit or selection change occurred during that wait. Missing precise
targets are non-navigable labels in the HTML copy, not whole-document links.

Back up and restore `docs` together with its downstream document tables. The
internal `docs.id` values and foreign keys must remain unchanged; do not rebuild
them from `external_id`. After restore, run the integrity queries above before
opening traffic.

## Repair

Do not merge or renumber rows automatically. If startup validation reports
duplicates, stop startup, identify the workspace and inspect downstream rows
for each internal UUID. Repair requires an explicit per-workspace decision and
a transactional reassignment of all dependent foreign keys. A global UUID hash
or prefix rewrite is not a valid repair.

Useful runtime evidence is a resolver log containing workspace ID and external
key, followed by internal operations containing `docs.id`. Logs and client
errors must not expose an internal UUID from a workspace the actor cannot read.

No identity migration is required for NanoID, UUID-shaped or system external
keys. Projection repair may restore one missing projection only after exact
external-key inspection and dry-run; it refuses duplicate or ambiguous root
observations. Scan and inspection are explicit, bounded commands and no command
is scheduled automatically. Production apply is not an upgrade step and
requires separate operator authorization, a verified backup, and a reviewed
rollback plan.

## Transfer reference plans

Native reference qualification is workspace-local even when a key looks like a
UUID. Explicit target qualification never authorizes a read; the actual target
workspace guard still applies. Transfers use versioned, snapshot-bound occurrence plans. Copy now enables private
operation/kind-namespaced allocation and schema-3 typed staging; completed
receipts remain readable. Move/Extract/Undo preserve SQL document identities
and native editor IDs while allocating a free local route on collision.
Source Blob rows and bytes remain; target references use verified copies.
Historical display/restore projects only exact, committed per-snapshot lineage.
Migration `1030` retains reference origin for new history; it never reconstructs
older origin from timestamps. An unproved historical target stays unavailable.
Drain already admitted older jobs before updating their producer. Incompatible unexecuted plans
require a fresh preview; do not convert or automatically rerun them. Keep
historical operation/receipt records readable.

Database DocumentLink readers retain the stored SQL UUID and workspace hint after
a Move/Extract/Undo. When ownership differs, the existing committed revision
manifest and matching publication receipt must prove the original workspace.
The reader then checks current document permissions in the actual owning
workspace before exposing its route, title or owner. A route-key redirect alone
is insufficient proof; an unproved or denied target remains redacted. Row
content attachments still require ownership by their containing Database
workspace and do not follow this lateral-link rule.
