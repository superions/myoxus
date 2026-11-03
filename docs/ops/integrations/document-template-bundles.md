# Document template bundles

[Documentation](../../README.md) / [Operations](../README.md) / [Integrations](./README.md)

Use versioned native document bundles with the central Template Registry.
The maintained regular meeting offering contains Agenda, Daily, Retro and 1:1.
Fokus and Register remain immutable history for existing pins and contextual
consumers; they are not fresh regular offerings or release-managed defaults.
Release selection preserves operator publications and explicit policies.
Release-owned reusable-source defaults use `managed_until_local_edit`, so normal
reconciliation can apply a later native revision to an unchanged source without
changing its document identity. `seed_once` is the default for ordinary guide
reader copies; their edits/deletions and independent working documents are not
updated with the source. Existing release-owned seed-once source policies are
corrected only with positive publication/default ownership and native binding
evidence; unknown ownership, pins, manual updates and disabled policies remain
protected.

| Bundle                                                                 | Current version | Native content SHA-256                                             |
| ---------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------ |
| [Agenda](../../../server/templates/documents/meeting-agenda/1.4.0.zip) | 1.4.0           | `92e7f203ac32d5960df59b4198a851a8fede2e75386e60d089e3731136cc0ae5` |
| [Daily](../../../server/templates/documents/agile-standup/1.4.0.zip)   | 1.4.0           | `c06a4dda7c5ead5f67f75e2c956506e57c06abf99beade9baad392c88d2b485f` |
| [Retro](../../../server/templates/documents/agile-retro/1.4.0.zip)     | 1.4.0           | `29dca422ebb276082f30aaafdc6c66c02b48a0a1f3bab423fabe125638f20db0` |

Each ZIP contains the canonical registry `manifest.json`, native
`content.template.zip` and its declared localized payloads. The native payload
contains a supported Yjs update or a single-document native Snapshot ZIP with its
assets. Its extension alone does not identify the inner encoding.
Editable tables, column geometry, emphasis, variables and manually unchecked
attendance remain native content. These meeting bundles have no external assets.

## Export an authored workspace template

Author the source in the normal native editor under **Library → Templates**.
Leave `{{input.*}}` values open when the recipient should answer them later.
For building blocks, use automatic variables and ordinary editable text instead;
block insertion does not open a question form. Their sources use the existing
`category: building-blocks` and work-area `tags`, with the same native ZIP format.
Embedded native images travel with the source; the export retains their exact
referenced bytes. It does not resolve inputs or alter the source document.

In **Admin → Templates → Catalog**, choose **Export from workspace…**, select
the workspace and its template source, and review the identifier, version,
title, type, content language and title policy. Additional metadata is optional.
Under **Language alternatives**, select a real source for each additional
language; the exporter does not generate translations. **Download bundle**
creates the canonical native ZIP directly. A preliminary Snapshot download,
upload, Registry import or publication is unnecessary.

The server reads the selected sources' current committed content and metadata
together in one read-only transaction. Revisions displayed in the chooser are
informational; downloading uses the current state at capture time. Source and
asset access and the configured archive limits still apply.

To distribute that ZIP through the operator-owned Registry, use **Import →
Upload & Validate**, then explicitly **Publish** its revision under **Versions**.
Use **Assignments** to select the target workspace and the published template.
Materialize the assignment through the existing reconciliation operation, then
inspect its native source in **Library → Templates**. Opening the Library is a
read, not a provisioning command. The original workspace source remains independent. Import,
publication and assignment are separate operator actions, never export effects.

Under **Versions**, revision download is available for Published and Deprecated
revisions. Other states retain an explanatory disabled action. This export
retains that exact revision's manifest, locale payloads, resources and checksums.
Identical native reimports reuse the revision; changed bytes at its existing
identity/version are rejected.

## Include the same document in Basis

Developers can add the downloaded native ZIP directly to the existing mandatory
`myoxus.features.base` source. Use the matching built CLI and select a forward,
unpublished Basis version after inspecting the current manifest:

```bash
myoxus-cli templates feature-bundle add-document \
  --root server/templates --manifest features/base/manifest.yaml \
  --bundle /path/to/authored-template.zip \
  --base-version <next-unpublished-version> --new-workspace-default true --dry-run
```

Review the admitted paths, then repeat the command without `--dry-run` to apply.
The command works without PostgreSQL or Redis. It validates the complete native
candidate, installs `documents/<identifier>/<version>.zip`, adds its ordinary
document component/export and atomically replaces the checked source manifest.
Existing identities are immutable: identical replay changes nothing; different
bytes at the same identity/version are rejected. Unrelated components, links,
history and policies are retained. Several documents may share one unpublished
Basis version.

For a new export, choose `--new-workspace-default true` or `false` explicitly.
Omit that option for an existing export to preserve its policy. Maintained building
blocks use `true`, so eligible new workspaces receive their sources through the
normal assignment/materialization lifecycle. Their category still excludes them
from whole-document creation pickers. This command admits page templates with `purpose: template`; it is
not the guide-authoring path. It prints the existing client-assets generator,
Feature pack and release-validation commands. Run those commands and the normal
release delivery below before claiming system installation. Source admission
does not publish a Registry revision, activate a runtime or push Git changes.

## Distribution

The release artifact contains one mandatory Feature Bundle under
`templates/features/<bundle-id>/<version>.myoxus.zip`, plus explicitly selected
optional bundles. Superseded Feature archives are not part of the runtime selection. `features/catalog.yaml` is the
sole activation pointer. The independently packaged `static/features/release.yaml`
fixes the required base ID, version and archive digest outside the configurable
root. Startup captures and verifies the whole selection before document
registration, managed reconciliation, workers or traffic. There is no loose
Database/assistant/document/workflow catalog fallback. Workflow authoring files
are excluded from loose runtime collection and template seeding too.

Authoring remains in `server/templates/{databases,assistants,documents,workflows}/` and
`features/base/manifest.yaml`. A Feature archive contains native YAML definitions,
canonical document ZIPs and declared static Artwork. Views remain native Database
definitions. Each child keeps its identity and exact bytes; wrapper-only changes
require a new wrapper version, not a new Database schema. Free Generic copies
remain unbound. Native Database catalogs also retain pinned Update YAMLs at
`<template-id>/updates/<from>-to-<to>.yaml` and both exact definition endpoints.
The existing native decoder admits their closure; there is no loose update root
or additional registry. Current selection requires a complete forward route,
and the package includes those declared dependencies. Previous authoring versions
remain in Git; installed Feature wrapper history is not copied into a new release. Structural-only edges use
`operations: []`; the closed `map_select_options` operation supports a stable
`field_key` and explicit `mapping` from old to target option IDs. Unknown
operations/keys, duplicate mapping keys and invalid endpoint/variant references
fail before instance writes. Field/View definitions remain the target schema;
files never grant permissions, run scripts or enable assistant actions.

A `workflow` component supplies a strict versioned YAML source and native identity.
A typed `workflow` link binds the whole assistant export to that source. The
`createContextDocument` nodes select existing native document components;
`createTaskFromDocument` uses native Task capture. Components keep their authored
input/context/reference bindings. `awaitSignal` declares a stable wait ID and
absolute-deadline input; `branch` selects a bounded declared outcome from that
wait. Each native consumer admits its supported graph and bindings. Document
review supplies typed Document, single-reviewer and deadline inputs, with no
script, expression or generic permission rule in the package.
Capability and binding versions participate in the accepted definition identity.
The server lowers these nodes to Glirulus stages for folder, native creation,
placement and completion, or correlated waits and native Task effects. Native
commands authorize and retain business decisions; technical event delivery
cannot approve a document. It does not execute a YAML interpreter. Active sources
admit new requests; an accepted request retains its exact source bytes and native
receipt independently of later offering changes. Delivery alone starts no run.

Assistant availability is authored once in the native assistant catalog's
`enabled` field; omission means true. Disabled entries and their exact source
pins still undergo native/Feature validation and remain retained inventory.
Feature exports do not reactivate them: they provide no fresh offering, default,
saved-configuration selection or execution admission. A context without enabled
offerings needs no active default; Task-container assistance may be empty.
Empty Workspace, Project and ordinary Task contexts remain required.

Base `myoxus.features.base` version `1.0.13` disables Prepare meeting, Capture
decision, Review work, Request document review, Handover after prerequisites,
Check Task contents and Prepare contents for new Tasks. The three ordinary
Project offerings and Empty workspace creation remain enabled. Activation
changes require a new Feature wrapper version/digest and the normal restart;
they neither edit immutable assistant bodies nor create an operator setting.

Pack an explicit source root with an already-built matching CLI:

```bash
myoxus-cli templates feature-bundle pack --root /path/to/templates \
  --manifest features/base/manifest.yaml --release-base --output /path/to/distribution
myoxus-cli templates feature-bundle validate-release \
  --root /path/to/distribution/templates \
  --release-manifest /path/to/distribution/static/features/release.yaml
```

The normal OCI/native packaging runs that same CLI and ships both projections.
For a standalone extension use `feature-bundle pack` without `--release-base`,
with `--output <archive>` and explicit `--platform <base-archive>` when needed.
No checkout or application rebuild is needed to author a combination of supported
native components. Unknown capabilities, unresolved typed links, changed immutable
identities and undeclared files are admission errors.

Deployments mount `MYOXUS_TEMPLATE_HOST_DIR` read-only at `/opt/myoxus/templates`.
Run the existing `prepare-templates.sh --server-image <matching-image> --output
<absolute-root>` before coordinated stop/prepare/start. Native/source delivery
uses `--source-dir <generated-template-root> --validator <matching-cli>
--release-manifest <distribution/static/features/release.yaml>`.
`validate-source-set` supports the same explicit expectation and
`--against-root <installed-root>` without PostgreSQL/network access. Optional
selection changes use `--optional-catalog <catalog.yaml>`; release refreshes
otherwise preserve installed optional pins and their order.

The former `template_registry.shipped_document_templates`,
`new_workspace_default_slugs` and `replaced_default_slugs` configuration lists
are replaced by the Feature manifest's document exports/policies. Remove these
obsolete keys from an operator overlay and author its additional sources in an
explicit optional bundle; the strict configuration decoder rejects them instead
of silently discarding a customization. Existing Registry policies/content remain
in their native persisted owners.

Preparation holds the existing publication lock across capture, admission and
publication. It stages captured bytes, publishes immutable dependencies first and
renames only `features/catalog.yaml` last on the destination filesystem. Failure
before that rename leaves the previous catalog active. A lost response after it
requires readback of the complete current selection; retry reuses verified bytes.
Filesystem activation and native SQL registration are separate boundaries. Never
repair an immutable archive in place or promote an older artifact over a newer
installed base. After activation, preparation removes Feature files outside the
selected publication. Registry revisions and workspace pins remain in their
persisted native owners; they do not require duplicate old Feature wrappers.

Mail, PDF and HTML remain separate operator-owned families in the same root;
preparation preserves their existing policy. Keep the complete root mounted.
See [PDF template operations](../data/pdf-export-templates.md).

Document sources use the existing Registry importer, validators and Blob owner.
Native current/history/default selection commits atomically. It then schedules
affected Workspaces through the existing durable Registry jobs: changed/missing
managed sources, eligible new defaults and withdrawn managed assignments.
Workers use normal reconciliation and revision-fenced retirement; source reads
and previews never activate a release. Unchanged startup/replay does not schedule
a full rebuild, and pending jobs resume through existing queue recovery.
Eligible existing non-Empty Workspaces receive new release-owned defaults; Empty
receives none implicitly but explicitly installed managed sources still update.
Same-template updates retain source document identity. Removed exports, including
identities entirely absent from the new archive, lose standalone/default delivery;
their unchanged managed sources are deleted through DocService. A false default
flag alone does not withdraw an active assigned export. Retained components and
immutable revisions remain usable for contextual consumers and genuine pins.
Edited sources are preserved as custom, and ordinary working/guide copies remain
independent. A withdrawn source's matching page/journal default is cleared only
after actual deletion, without guessing a replacement or changing another choice.
Operator revisions, pins, disabled policies and status survive release activation.
Native revision publication records release ownership
separately from authorship: an explicit Admin publication relinquishes release
ownership even when the revision has no author. Existing publication ownership is
never inferred from a missing author. New release-owned default policies record their
ownership in `template_default_policies`; an explicit operator edit relinquishes
it. Existing policies are never inferred to be release-owned. Empty Workspaces
continue to suppress implicit content provisioning.

Historical Builtin instances with genuine revision bindings can change catalog
attribution without instance writes. Truly legacy instances without revision
bindings fail with a concrete diagnostic and require the existing explicit native
release transition; startup does not silently adopt or rewrite them. The retired
Meeting Notes source remains immutable historical evidence. Bundle activation
never runs its old content-retirement operation.

### Upgrade existing installations

Use the candidate distribution's matching CLI and its admitted template root;
an old installed CLI or a loose authoring directory is not the candidate release.
First validate the candidate without database writes:

```bash
myoxus-cli templates feature-bundle validate-release \
  --root /path/to/candidate/templates \
  --release-manifest /path/to/candidate/static/features/release.yaml
MYOXUS__TEMPLATES__ROOT_DIR=/path/to/candidate/templates \
  myoxus-cli --json templates recover-release --all-workspaces
```

The second command is read-only: it inspects the canonical migration ledger,
frozen native baselines and ownership before complete service bootstrap. It
requires no successful candidate API startup. Read both the rows and exit status.
Unresolved system ownership is actionable non-success, not a warning to ignore.
Review the named Workspace/source and retain custom content. Exact unknown/orphan
keys and confirmation are allowed only in a single-Workspace scope after the
operator has confirmed that those exact system documents are unmodified; there
is no all-Workspace confirmation shortcut. See the
[CLI recovery options](../administration/cli.md).

Use the installation's normal backup and coordinated stop/prepare/start procedure.
Stop API/workers before applying the candidate. Prepare the mounted root through
the existing distribution procedure, then apply the reviewed recovery with the
matching CLI and database/storage configuration:

```bash
MYOXUS__TEMPLATES__ROOT_DIR=/path/to/candidate/templates \
  myoxus-cli --json templates recover-release --all-workspaces --apply
```

Apply runs the canonical forward migrations and frozen-baseline adoption before
current selection and native reconciliation. Unsupported or altered ledgers fail
closed. Real pins, disables, manual policies, opt-outs, edited sources and ordinary
guide/working copies remain protected. Empty suppresses implicit defaults only.
Use the same reviewed scope on retry: a materialization/deletion failure is not
completion, and an intervening edit needs inspection rather than renewed blind
confirmation. The next read-only preview and repeated Apply must converge without
new source identities or extra content updates.

After restarting the matching API and frontend artifacts, inspect durable jobs,
actual source revisions/bindings and the served Library. Check changed native
content, absent withdrawn sources, new defaults, retained explicit Empty sources,
and unchanged independent documents/preferences. Source lists and previews do not
finish an upgrade on the client's behalf. These are operator-run steps; development
acceptance does not establish an Office Live rollout.

Artwork is validated PNG/WebP/static SVG with exact dimensions and localized
metadata. Delivery resolves declared component IDs from the captured snapshot,
authenticates before cache responses and isolates SVG navigation. Current images
are available to authenticated users; retained images require the actor's accepted
native setup receipt and current access to its live result. Retain database/blob
backups alongside authored archives. A root change requires restart.

An optional bundle can link a Project presentation group to an exact base
document export for manual Library use. The linked source must already be
assigned and materialized in that Workspace, remain readable and retain its
native revision and content. Missing, detached, edited or trashed sources stay
unavailable. Opening the association provisions nothing in an Empty Workspace;
the user applies a usable source through the existing Library action.

See the [registry operations guide](template-registry.md).
Use Admin import for additional operator-owned bundles; the existing CLI
metadata import is not a replacement for the content-bearing startup path.

Fokus `1.1.0` adds committed EN/DE/FR/ES native payloads in one bundle.
The German standard payload is byte-identical to `1.0.1`; tables, emphasis,
variables and the manually unchecked attendance list retain the accepted layout.
Older published revisions remain available for pins. A source chooses its
language once at provisioning; later client-language changes do not replace it.
Review all declared locale payloads when editing a release: changing only an
alternative language still requires a new immutable version. Export retains the
complete bundle; existing independently created documents are untouched.
Version `1.1.1` shortens one Spanish metadata label to keep it on one line in
the existing layout. The German, English and French payloads and all older
published bundle bytes remain unchanged.

## Apply and maintain templates

In Admin, select a published revision and assign it to the intended workspaces,
or set a default policy for newly created workspaces. Use the Registry's update
mode and revision pins to control later adoption. Template variables resolve
when creating a document; the resulting working document remains editable.

Publish changes as new revisions rather than replacing existing bundle bytes.
The Registry validates content and checksums on import. Journals and ordinary
onboarding guides are delivered as individually versioned native bundles.

Onboarding belongs to **Basis 1.0.27**. Each document is referenced individually
by a component and an export in `server/templates/features/base/manifest.yaml`.
That configuration selects the active revision and new-workspace default.
For guides, export order also defines the native-client learning order.
The client generator derives its onboarding list from those configured default
exports and the referenced bundle's `purpose: guide`; it does not scan for a
second package or require a fixed number of documents. To add a guide, add its
native component and export in Basis. There is no separate onboarding ZIP or
onboarding package version to maintain.

Welcome, Editor Basics and Tasks contain their distinct original Myoxus WebP images in
each localized native Snapshot ZIP. The full transparent motifs retain their 3:2
ratio at approximately half the text width. Welcome uses the caption “Myoxus
hilft dir bei vielem.” in German. Installation uploads the exact asset bytes
through the workspace blob service before publishing the page.

Editor Basics explains document creation, selecting text, the floating formatting
bar, B/I, heading levels, links and comments. Editor Blocks covers block handles,
duplication, moving, lists, tables, images, attachments and document references.
The Database guide is a brief introduction to useful collections and the meaning
of entries, fields and views; it contains no practice-data or persistence exercise.
Importing separately documents direct Markdown imports, Obsidian preview/apply
into a new workspace and Notion HTML/ZIP preview/apply into a new Database.
It retains media-path, source-retention, failed-apply, CSV/JSON and bounded
recovery facts; it does not promise full source-workspace fidelity.
Tasks explains creating a task, choosing its workspace/project destination,
assignees and due date, updating status, completing and finding closed work,
capturing document text and inserting a reference to an existing task. It
distinguishes the filtered My tasks view from access permissions and explains
when a document checklist is sufficient. Its original `assistant-first-task.webp`
artwork is included in each localized Snapshot ZIP, with a localized caption.
Organization explains choosing and finding through folders, favorites, tags and
collections, including the difference between removing a link and trashing a
document. Meetings compares Agenda, Daily, Retro and 1:1 and explains creating
an independent working document.

These revisions apply to new deliveries or the explicit Admin action to install
another guide copy. Existing readers, including their edits and titles, remain
unchanged under `seed_once`. Loading a package does not restore a removed
assignment or enable a disabled default. Attendance remains a manual check in
an independent working document.

See [Template Registry](./template-registry.md) for assignments and
[template variables](./template-variables.md) for automatic values.

The maintained journal bodies are `business-daily`, `eisenhower`,
`time-blocking`, `personal-journal` and `gtd-weekly-review`.
`hybrid-day-sprint` remains immutable history for existing documents and
explicit operator choices; it is omitted from fresh release and offline offerings.
The five journals use renewed native bodies at 1.3.0 with EN/DE/FR/ES content.
The new ordinary templates are Handover, Project status, Incident report,
Rollout/rollback, Architecture decision and 1:1, each at 1.2.0. They are
assignable and have no new-workspace default. Their guarded registration
preserves policy identities, disables, pins and edited sources. There are no
client content builders or builder fallback. Native first-open uses the same
manifest-derived files; Browser Web never creates local workspaces.

The regular sources retain native automatic variables for their relevant
dates, workspace context and authorship. Authorship does not assign operational
responsibility. GTD uses `week` with `calendar.iso_week_year`. Agenda, Daily and
Retro retain the native workspace-member repeat with unchecked attendance. Only
Agenda (topic), Handover (subject), Project status (project) and Architecture
decision (decision question) each request one localized `input.*` value. Journals
request none; the onboarding guides contain no variables. The regular bundles use
`title_policy: template`, preserving their authored variable-based titles.

Author or edit the native document, export the bundle, and publish a new semantic
version for any content change. Regenerate offline assets with
`node build/scripts/templates/generate-document-bundles.mjs` and verify the
result with `templates.native-assets`, which runs the same command plus `--check`. Keep earlier published ZIP bytes immutable.

Offline native clients do not open these ZIPs at runtime. The generator uses
pinned build-only `@zip.js/zip.js` 2.24.0 to verify archive signatures/CRC, bounded
paths/output and every declared locale checksum. It emits content-addressed
direct payloads and assets under `client/libs/core/public/document-bundles/`
and records their hashes and actual `yjs`/`snapshot` encoding in the generated
index. A `.template.zip` filename is not an encoding discriminator.

The native consumer captures its language choice once, with regional/base/default
fallback, verifies that payload and its assets, then enters the same native
document lifecycle. Snapshot assets are rebound to hash-addressed local blob
keys before creation is published. No shared source, authored delta or image
byte is rewritten. Existing delivery bindings still suppress reseeding deleted
copies; language changes do not refresh existing documents. The source ZIPs
remain the Registry publication format, not client parsing dependencies.
Historical builder protocol fields remain only for deployed-client and persisted
cutover compatibility; current clients neither complete builders nor expose
builder-version actions.
