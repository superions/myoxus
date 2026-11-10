# Template registry — operations runbook

[Documentation](../../README.md) / [Operations](../README.md) / [Integrations](./README.md)

The Template Registry manages reusable document templates that users can apply
when creating new pages. Operators can import template bundles, publish
revisions, assign templates to workspaces, and monitor reconciliation jobs and
workspace instances. During startup, server releases also register the native
document bundles configured by the release base.

Building blocks use this same Registry with `category: building-blocks` and
work-area tags. Admin category filtering, native import/export, publication,
assignment and pin/disable policies retain their ordinary owners. In the
workspace Library they appear under the **Building blocks** type filter and
are inserted from an existing document, rather than used to create a whole page.

**Admin UI location:** `/adminfrontend/templates`

**Worker queue:** `template-registry` (concurrency 1 by default)

<details>
<summary>On this page</summary>

- [Prerequisites](#prerequisites)
- [Workspace-owned templates](#workspace-owned-templates)
- [Exporting a workspace template](#exporting-a-workspace-template)
- [Configuration](#configuration)
- [Importing a template bundle](#importing-a-template-bundle)
- [Onboarding guides in Basis](#onboarding-guides-in-basis)
- [Release-supplied meeting bundles](#release-supplied-meeting-bundles)
- [Workspace-purpose document sources](#workspace-purpose-document-sources)
- [Released system identities](#released-system-identities)
- [Publishing templates](#publishing-templates)
- [Assigning templates to workspaces](#assigning-templates-to-workspaces)
- [Monitoring drift](#monitoring-drift)
- [Monitor template registry jobs](#monitor-template-registry-jobs)
- [Archiving templates](#archiving-templates)
- [Troubleshooting](#troubleshooting)
- [Disabling the template registry](#disabling-the-template-registry)
- [Related documents](#related-documents)

</details>

## Prerequisites

- Myoxus server running and healthy
- Admin account with the `admin` role
- Template bundle: a ZIP archive containing template documents and a manifest

---

## Workspace-owned templates

Users with document-creation permission create workspace-owned sources under
**Library → Templates**. These sources appear directly in the workspace Library
and creation pickers and do not require an Admin import, publication or
assignment. Catalog reads and source previews share one Workspace admission:
the existing effective role must allow Workspace Read and must not be External,
even with document grants or a public Workspace. Every admitted internal reader
sees all offered sources; there are no per-template read grants. This does not
change ordinary-document or public Workspace/document access. Editing, conversion
and recoverable trash keep their existing document-write permissions, and use/
insert keeps destination-write authorization. Conversion or trash changes future availability
and defaults; documents already created from the source remain unchanged.

The Library requests a bounded inventory page; **Load more** explicitly appends
the next page. Search, origin, work-area and sorting are applied by the server,
including matches beyond the first page. Selecting a source or choosing Use/
Insert checks that exact source rather than rescanning the catalog. Preview uses
the selected document's read-only native snapshot. Withdrawn or changed sources
stop the operation; these reads never activate a Feature or materialize sources.

An enabled `managed_until_local_edit` or `manual_update` Registry assignment
changes only the destructive rights of its bound source. Workspace editors may
continue editing the source, but ordinary clients cannot unmark it, move it to
trash or delete it permanently. Removing the central assignment in Admin
permanently deletes that bound source through the server document lifecycle;
documents previously created from it remain unchanged. `seed_once` sources,
including onboarding documents, reader-owned guides and unassigned custom
sources retain normal document lifecycle rights.

The Registry remains the administrator-owned path for shared catalog bundles,
revisions and workspace assignments. The Library does not expose Registry
publication, pinning or assignment controls.

---

## Exporting a workspace template

In **Catalog**, choose **Export from workspace…**, select the workspace and
template, then review its native bundle metadata. Optional language alternatives
must name real authored sources. **Download bundle** captures the current
committed sources together, including referenced native images and open inputs.
It requires no preliminary Snapshot export/import or publication and changes no
source or Registry state. Import the downloaded ZIP through the existing
**Import** tab when you want to publish and assign it centrally.

The same ZIP can enter the developer-owned mandatory Basis Feature through
`myoxus-cli templates feature-bundle add-document`. See the complete
[native source and Basis authoring journey](document-template-bundles.md#export-an-authored-workspace-template).

---

## Configuration

```yaml
template_registry:
  enabled: true # default: true
  import_max_bundle_size_mb: 50 # maximum ZIP upload size
  zip_limits:
    max_entries: 256 # max files inside ZIP
    max_total_uncompressed_size_mb: 200 # safety limit for ZIP bomb protection
    max_entry_uncompressed_size_mb: 50 # per-file limit
    max_compression_ratio: 200.0 # ratio safety limit
    max_path_length: 512
  reconcile_default_mode: "managed_until_local_edit" # reconciliation strategy
  drift_scan_enabled: true
  drift_scan_interval_seconds: 3600 # drift scan every hour
```

ENV overrides:

```bash
MYOXUS__TEMPLATE_REGISTRY__ENABLED=true
MYOXUS__TEMPLATE_REGISTRY__IMPORT_MAX_BUNDLE_SIZE_MB=100
MYOXUS__TEMPLATE_REGISTRY__DRIFT_SCAN_INTERVAL_SECONDS=7200
```

### Reconciliation modes

| Mode                       | Behaviour                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `seed_once`                | Create the initial document from the selected revision and do not manage later updates              |
| `managed_until_local_edit` | Apply managed updates until the workspace document is locally edited; then retain the local version |
| `manual_update`            | Report available updates and require an explicit reconciliation action                              |

---

## Importing a template bundle

### Via Admin UI

1. Navigate to **Admin → Templates → Import**.
2. Upload a ZIP archive containing the template bundle.
3. Review the import preview (file list, manifest validation).
4. Confirm the import. The response reports the catalog entry, imported
   revision, and validation warnings.
5. Confirm the new entry in **Catalog** and its revision in **Versions**.

For automation, use [Template Registry administration via API](../../api/server/template-registry.md#import-a-bundle).

The trusted local `myoxus-cli templates import <bundle.zip>` command creates
Registry metadata without a fabricated user actor, but it has no blob-storage
port and is not the content-bearing Admin/startup import path.

### Expected outcome

After a successful import:

- Template records appear in the **Catalog** tab.
- The imported revision is validated and must be published before assignment.
- Validation warnings, if any, are visible in the import result.

## Onboarding guides in Basis

Onboarding is a group of ordinary documents within Basis. Each guide's native
component, active revision, default delivery and learning order are configured
in `server/templates/features/base/manifest.yaml`. Server delivery and the
generated native-client index consume those same references. There is no
separately versioned onboarding ZIP, guide allowlist or required document count.
Add a guide by adding its component and export to Basis.

Assign published guides using the existing Assignments tab or configure
their normal new-workspace defaults. Guides use `seed_once` and appear as
ordinary documents, with no Library Templates, journal-picker or Database
row-template classification. Readers can edit and delete their copies; later
automatic provisioning preserves those decisions. **Install another guide
copy** deliberately creates a fresh ordinary document and keeps previous
copies. Disabled assignments must be enabled before that action is available.

Admin imports accept individual native document bundles through the existing
Import tab. These imports do not select or replace the release base. Earlier
ordinary reader documents, publications, disabled policies, revision pins and
historical import job reports remain intact.

## Release-supplied meeting bundles

The mandatory release base contains the declared native meeting revisions and
explicit current/default exports. Startup validates the complete release-pinned
selection before staging immutable native content and atomically publishing its
current/history/default selection. Retained revisions never become new defaults.
Same-version checksum conflicts fail closed. Explicit operator publications,
default policies, pins, disabled entries and existing workspace documents survive
activation. Existing Workspaces are not backfilled by base publication; explicitly
Empty Workspaces continue to suppress automatic content provisioning.

For source authoring, coordinated stop/prepare/start, independent release pins and
optional additions, use [Feature Bundle delivery](document-template-bundles.md).

Upgrade existing eligible assignments with the bounded CLI operation. Run it
without `--apply` first, then apply the reviewed batch:

```bash
myoxus-cli templates replace-default \
  --source-slug <retired-slug> \
  --replacement-slug <published-bundle-slug> \
  --limit 100 --apply
```

Use the last reported policy ID with `--after-policy-id` for the next batch.
Explicit opt-outs, pins, manual choices and detached sources are preserved.

---

## Workspace-purpose document sources

The release base also declares the native `knowledge-home`, `research-note`,
`team-wiki-home`, `procedure` and `decision-record` bundles at version `1.0.0`,
with English, German, French and Spanish documents. Personal Knowledge and Team
Wiki reference these admitted Registry sources through the existing assistant
catalog. Their selected documents are ordinary working copies, not Registry
assignments; future publication or source editing does not rewrite those copies.

Creation confirms source metadata before allocating the Workspace and performs
native body preflight against that real Workspace afterward. The existing
creation receipt reserves document and Organizer identities. The shared Sayiir
workflow advances those native operations with their transactional effect
acknowledgements. A failed or repeated attempt resumes the same request and
results. Missing retained sources or removed results require explicit recovery;
operators must not substitute another source under an accepted request key.

Guided Home opens the setup's acknowledged research-note or procedure working
copy for its first edit. The declared source identity selects the matching
result; current personal mode and document permissions still apply. An
unselected, removed or unreadable copy offers no action. This creates no
Registry assignment and leaves the Library's existing source rules intact.

Personal reusable setup preferences retain admitted package, published document,
Database starter and workflow references with supported structural defaults.
They contain no working document or Task copies, private answers, accepted
request or running instance. Loading resolves current offerings and exposes
unavailable references for explicit clearing; the ordinary native preparation
and fresh confirmation remain required. Published document sources retain
their Registry owner, and compatible Row-template contents retain the existing
native Task/Database owner. Saved preferences introduce no alternate Task
schema, Registry or template updater. Managed definitions use current release
admission, while a Generic starter still creates an independent unbound copy.
Merely opening Home creates no document or content.
The accompanying Research Index is a separate free Generic database created
from a frozen native starter; it receives no managed schema binding or automatic
source updates.

## Released system identities

Business Daily and the ordinary reader guides retain their native identities,
localized content and document lifecycle. The release manifest declares their
exact current source versions. Cloud clients consume native Registry sources;
Electron local delivery is generated from the same declared source selection.
Existing guide bindings remain seed-once, including suppression for deleted
copies. Explicit fresh copies use the selected current revision and preserve
previous reader documents.

The historical released-builtin identity-adoption path was removed after both
production migrations completed. Genuine revision-bound instances keep their
bindings and content. Current selection and `templates recover-release` reject
unsupported NULL-revision bindings instead of adopting them. Fresh empty seed
entries use normal trusted staging/current selection. Back up database and blobs before coordinated
updates; preserve the append-only migration ledger and retained source history.

## Publishing templates

An imported catalog entry can have draft revisions. Publish the intended
revision before assigning it to workspaces:

1. Navigate to **Admin → Templates → Versions**.
2. Select the catalog entry, then publish the intended revision.

The [API publication example](../../api/server/template-registry.md#publish-a-revision)
uses the same authenticated operation.

---

## Assigning templates to workspaces

Templates can be assigned to specific workspaces so users see them in the template picker:

1. Navigate to **Admin → Templates → Assignments**.
2. Select a workspace and assign one or more templates.

For bundle-backed templates, a successful assignment also completes the
workspace source before it returns. If source creation fails, Admin reports the
failure while retaining the assignment so **Trigger Reconcile** can retry it.
Only unconverted native builtin assignments remain temporarily on the existing
client builder path; converted entries use their genuine bundle revisions.

Web and Electron revalidate the selected workspace source before application.
If the source was unmarked, trashed or removed after the picker loaded, the
application fails without copying content or reporting a created document.

For automation, see the [API assignment example](../../api/server/template-registry.md#assign-a-workspace-template).

Use `Published` for the current published revision. For `PinnedRevision`, also
send `selectedRevisionId`; Admin lists both the currently published revision
and its still-usable deprecated predecessors. Publishing a successor does not
move a pinned assignment away from the selected predecessor. Draft, validated,
archived, missing, and revisions from another template are rejected.

A normal reconcile reports a successor for
`manual_update` as `update_available` without changing the workspace source.
Choose the usable revision in Admin and select **Apply update** to apply it.
That explicit operation uses the same live-content conflict check as managed
updates. A failed or conflicting update reports the failure and retains the
previous revision and source content.

The [manual-update API example](../../api/server/template-registry.md#apply-a-manual-update)
performs the same explicit operation.

### Retire and reassign

**Remove** in either existing Admin assignment surface is deliberate central
retirement. The server marks the Registry instance retired, permanently deletes
the builtin or bundle source together with its root entry and owned dependent
records, records the retirement audit event, and removes the active policy.
Retry the same action after a transport or server failure; completed cleanup is
idempotent and unfinished cleanup resumes. A disabled Registry, an empty client
response or loss of connectivity never triggers retirement.

Previously created ordinary documents are preserved. To make the template
available again, assign it explicitly in Admin. That assignment creates one new
source from the historical binding; reopening Web or reconnecting a client does
not resurrect the retired source.

---

## Monitoring drift

Drift occurs when a managed workspace document differs from its last applied
template state. When enabled, the scanner runs at
`drift_scan_interval_seconds` (one hour by default).

### Check drift status via Admin UI

Navigate to **Admin → Templates → Assignments**, select the workspace, and
review its instances and current reconciliation state:

- `ok`: the instance is current;
- `update_available`: a newer applicable revision is available;
- `detached`: local ownership has replaced managed reconciliation;
- `retired`: the instance is no longer active;
- `error`: reconciliation failed; inspect the recorded error code and message.

For automation, [inspect workspace instances through the API](../../api/server/template-registry.md#inspect-workspace-instances).

### Trigger manual drift scan

The drift scan job runs automatically every `drift_scan_interval_seconds`. To
trigger it immediately, select the workspace under **Admin -> Templates ->
Assignments** and choose **Scan for drift**. The
[API scan example](../../api/server/template-registry.md#trigger-a-drift-scan)
uses the same authenticated operation.

---

## Monitor template registry jobs

### Via Admin UI

Navigate to **Admin → Templates → Jobs**. The most recent import and reconcile
jobs are listed with state, timestamps, template, and workspace identifiers.

The [jobs API example](../../api/server/template-registry.md#inspect-jobs)
returns the same bounded job inventory.

---

## Archiving templates

Templates can be archived to remove them from the catalog without deleting history:

1. Navigate to **Admin → Templates → Catalog**.
2. Open the template action menu and select **Archive**.
3. Use the **Archive** tab to review archived entries or enable one again.

Archived templates no longer appear in the user template picker. Existing workspace documents created from the template are unaffected.

Archive also disables enabled workspace assignment policies in the same
transaction. A policy-write failure leaves both catalog and assignments
unchanged. Disable changes only the catalog status. Enable clears the archive
timestamp and does not re-enable policies that archive or an operator disabled.
Revision history, source documents, bindings and default choices remain intact.
CLI `templates archive <id>` and `templates enable <id>` use this same lifecycle
owner and record successful operations with the trusted system actor. Already
archived entries are refused; repeated CLI enable remains successful. GraphQL
continues to refuse an already-active enable.

---

## Troubleshooting

### Contextual template suggestions

Workspace creation menus call the public GraphQL field
`workspace(id).templateSuggestions(input:)`. This is a read-only suggestion
projection; it does not enqueue reconcile jobs and does not copy template
content. Actual creation still happens through the existing document duplicate
flow after a user selects an available template.

Menus show the first ranked page immediately (eight choices by default, at most
twenty), without waiting for passive cloud reconciliation or the whole catalog.
After that page is rendered, an open menu may prepare exactly one next metadata
page. **Load more** consumes it without closing the menu or changing selection;
only then may the following page be prepared. Sources and preview bodies are not
preloaded. A failed continuation keeps the current choices and offers **Retry**.
Closing the menu or changing its account, Workspace or creation context discards
unconsumed continuation data. Native-local initialization remains offline-owned.

Guide/default-preference maintenance retains its existing Workspace/locale
lifecycle and explicit repair path. A ready menu response can also supply the
existing compare-and-set default replacements without another discovery request.
None of these reads reapplies a template to an existing document copy.

Use the [API discovery query and variables](../../api/server/template-registry.md#discover-available-templates)
to inspect the suggestion projection.

Important states:

| State                                   | Meaning                                                                       | Operator action                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `available: true`, `InstanceOk`         | The template has a usable workspace document instance.                        | No action required.                                                                                |
| `available: false`, `ReconcileRequired` | The catalog or policy exists, but a workspace instance is missing or retired. | Inspect delivery state or trigger the existing explicit template reconcile path for the workspace. |
| `InstanceError`                         | The last materialization failed.                                              | Inspect template registry jobs/audit entries for the template and workspace.                       |
| `Detached`                              | The user-edited instance is intentionally protected.                          | Do not overwrite unless an explicit user/admin action reattaches it.                               |
| `hasNextPage: true`                     | More ACL-filtered suggestions follow this page.                               | Pass `endCursor` as the next request's `after` value.                                              |
| `stale: true`                           | The projection may no longer be current.                                      | Retry discovery and inspect assignment/reconcile state; do not treat it as pagination.             |

Default policies are consumed when a workspace is created. Later discovery
uses that workspace's assignments, so a current default cannot override an
explicit disable or silently enroll an existing workspace. Internal Workspace
readers share centrally admitted template offerings without per-source grants;
External members cannot enter the catalog. Ordinary guide deliveries retain
their normal document ACL. Invalid or no-longer-present cursors return
`MIX_TEMPLATE_SUGGESTIONS_INPUT_INVALID` and should restart discovery from the
first page.

Structured resolver error codes:

- `MIX_TEMPLATE_SUGGESTIONS_UNAVAILABLE`
- `MIX_TEMPLATE_SUGGESTIONS_INPUT_INVALID`
- `MIX_TEMPLATE_SUGGESTIONS_METADATA_INVALID`
- `MIX_TEMPLATE_SUGGESTIONS_TEMPLATE_FORBIDDEN`

Workspace access failures are usually raised by the parent `workspace(id)`
resolver before `templateSuggestions` runs and therefore use the existing global
GraphQL `FORBIDDEN` error. Verify workspace membership first when the response
has no `workspace.templateSuggestions` path.

Suggestion spans carry `workspace_id`, `user_id`, `surface`, `document_type_id`,
`status_id` and `classification_id`; the bounded Store page span also carries
`limit`. Discovery does not log native bodies or resolved field values.

### Import job fails immediately

**Symptoms:** Import job transitions to `failed` within seconds of upload.

**Common causes:**

1. **ZIP archive exceeds size limit**: Check `import_max_bundle_size_mb` (default: 50 MB). Increase if needed:

   ```yaml
   template_registry:
     import_max_bundle_size_mb: 100
   ```

2. **ZIP safety limits exceeded**: Check `zip_limits` — the archive may contain too many files or a suspicious compression ratio (ZIP bomb protection).

3. **Invalid manifest**: The ZIP must contain a valid `manifest.json`. Check the import error in the Admin UI or database for the specific validation failure.

4. **Storage backend unavailable**: The import pipeline writes extracted files to blob storage. Verify storage is healthy (`GET /ready`).

### Drift scan not running

1. Verify `drift_scan_enabled: true` in configuration.
2. Check the durable registry/import state in Admin and correlate the run ID
   with bounded `template-registry` API logs. The general `/metrics` queue list
   does not currently expose this queue.
3. Confirm the scheduler registered the drift scan at API startup. There is no
   PostgreSQL `worker_jobs` table or generic queue repair operation.

### Template not appearing in user picker

1. Verify the catalog entry is active and has a published selected revision.
2. Verify the template is assigned to the user's workspace and the assignment is enabled.
3. If the template registry is disabled (`enabled: false`), no templates are served.

---

## Disabling the template registry

To disable the template registry feature:

```yaml
template_registry:
  enabled: false
```

When disabled:

- The template picker in the UI returns an empty catalog.
- Import and drift scan endpoints return feature-disabled errors.
- The `template-registry` worker queue continues to exist but enqueues no new jobs.

---

## Related documents

- [Document template variables](./template-variables.md) — automatic values,
  authoring syntax, permissions and rollback behavior.

- [worker-domain.md](../observability/worker-runtime.md) — worker queue monitoring and re-enqueue procedures
- [configuration.md](../configuration/reference.md) — `template_registry.*` config reference

## Builder version notifications

`templates bump-builder-version` and Admin `bumpBuilderVersion` call the same
registry owner. Each call commits one increment, resolves workspaces with an
enabled builtin policy and attempts `template:reconcile-needed` through the
configured Redis **socket** role and namespace. The event retains `workspaceId`,
`slug` and `builderVersion`; every API instance, including the publisher's,
forwards it to connected workspace clients. Notification failures are
best-effort and never undo or retry the increment. GraphQL `workspacesNotified`
is a target count, not a delivery acknowledgement. Disconnected clients read
the current builder version through the existing reconcile query; do not run
another bump merely to deliver a missed hint. CLI JSON remains
`{slug, newBuilderVersion}`.
