<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Document template variables

[Documentation](../../README.md) / [Operations](../README.md) / [Integrations](./README.md)

Document templates insert point-in-time text into an editable document. The
Web/Core template action resolves server-backed facts through the authoritative
document-template application service. Native transformations and regional
date formatting remain in Core. MCP resolves omitted supported automatic values
through the same authorized facts. Existing explicit caller values remain
caller-authored, except for reserved organization, placement, applying-account
and ISO-week-year values.
Neither is a live field that changes when
its source changes later.

<details>
<summary>On this page</summary>

- [Making an authored template available in Browser Web](#making-an-authored-template-available-in-browser-web)
- [Building blocks](#building-blocks)
- [Authoring syntax and supported positions](#authoring-syntax-and-supported-positions)
- [Check a source without applying it](#check-a-source-without-applying-it)
- [Manual text inputs](#manual-text-inputs)
- [Native input data](#native-input-data)
- [Automatic values in Web/core](#automatic-values-in-webcore)
- [MCP automatic and caller-authored values](#mcp-automatic-and-caller-authored-values)
- [Native repetition for workspace members](#native-repetition-for-workspace-members)
- [Web/core versus server/MCP](#webcore-versus-servermcp)
- [Failure, concurrency and privacy](#failure-concurrency-and-privacy)
- [Troubleshooting](#troubleshooting)

</details>

## Making an authored template available in Browser Web

Create a workspace-owned source with **Library → Templates → New template**.
The completed source appears in the same Library inventory and creation pickers;
it does not need an Admin publication step. Open or edit the source from the
Library, or convert it back to an ordinary document. Moving or converting a
source does not change documents already created from it.

The [Template Registry runbook](template-registry.md) covers a different
workflow: administrators import, publish and assign shared catalog templates.
Those operations retain their existing Admin permissions. Document edit access
does not grant Registry publication or assignment rights.

An actively managed Registry source remains editable so authors can maintain
its unresolved variables and repeat bindings. Its assignment protects the
source from client-side conversion, trash and permanent deletion. Unassigned
custom sources and `seed_once` sources keep the ordinary document lifecycle;
documents already instantiated from any source remain independent.

Database row-template bodies use the same server-owned variable and repeat
expansion as document templates. The selected body is inspected before creation;
required `input.*` values use the same application dialog. Cancel creates no Row.
Static and cell-only templates retain one-click creation. Row titles and typed
field defaults are separate from body inputs; variables in the source title are
ignored. Creator and creation-time values refer to the actual new Row document.
Folder/parent values require real context and are not inferred from navigation.

Bindings retain the Registry source identity and publication/workspace guards,
but grant no source-read permission. Inspection and creation both check current
source access; creation also checks the captured source revision. Missing values,
unsupported context, stale captures and revoked access fail before adding a Row.
Body creation/attachment failures use the existing compensating cleanup. A lost
write response is not proof of rollback: the input dialog retains answers but
blocks replay, and the operator must inspect the Database before another attempt.
Task creation retains its existing bounded readback for unconfirmed writes.

MCP `database_row_from_template` accepts the same literal text map as `body_inputs`
and an optional captured `source_revision`; it does not accept client overrides
for automatic body facts. Answers are trimmed, required strings with the same
8 KiB value limit and are never expanded again. Applying a body leaves its source
unchanged, removes successful repeat bindings and creates ordinary editable text.

## Browsing document templates

Library → Templates offers List and Gallery views with the same search,
origin filter, sort and source actions. The view choice is personal to your
account in this Workspace and survives reload. List is the initial default.
Gallery shows actual document previews where supported; an unavailable preview
does not prevent using an otherwise available template. Switching views does
not create documents or expand variables. Building blocks keep their separate
source list and insertion preview.

## Building blocks

Under **Library → Templates**, select **Building blocks**. Search, work-area,
origin and sort filters share this route with document templates. The preview
shows the unresolved, read-only native body. Building blocks are excluded from
whole-document, Journal and Database Row creation choices.

In an editable Page or Edgeless Note, choose **Insert building block…** from the
slash menu or text toolbar's **More** menu. A caret inserts at its native text
position; a selected range inserts after the selection without replacing it.
Table-cell carets and a canvas without an editable Note are unsupported targets.
Cancel restores the captured selection. The complete insertion is one native
undo step. The source and all inserted copies remain independent.

Only the body is inserted. The source title and document properties do not
replace the target's metadata. Automatic values use the actual target and the
applying account/time; an existing target keeps its own creator and creation
date. The preview remains unresolved until insertion. There is no fill-in form:
author native input fields for structured answers, ordinary editable text for free
notes, and supported automatic variables for capture context. Fill native inputs
directly in the inserted paragraph or cell. Each insertion has independent answer
identities; entering a value does not change the source or another inserted copy.
Older `input.*` tokens in a block become ordinary bracketed text for editing
after insertion. Document templates retain the manual-input flow below.
That older syntax is not needed for native inputs. A source containing only native
inputs can be applied with its required answers still unfinished; required status
is shown at the actual inline field, not as a mandatory creation questionnaire.

Caller-owned configured content remains a separate use of substitutions. For
example, the Task preparation Agenda retains `{{input.notes}}` for the existing
assistant's literal personal notes; its remaining Agenda answers use native fields.
Do not turn those configured notes into a guessed field answer or evaluate template
syntax inside a native field's literal default.

**New building block** creates a workspace source using the selected work area.
**Make own copy** retains the complete unresolved source and classification
with a new identity. **Save selection as building block…** in the editor's
**More** menu captures native selected text or body blocks and asks only for the
new source's name. These actions open the acknowledged source in the ordinary
editor; use **Check template** there. A custom source's menu also offers
**Change template type and work areas**. Registry classification stays in Admin.

Web and Electron share the insertion operation. Native-local Electron uses its
local source metadata and available local values; required server facts remain
explicitly unavailable. Creating or browsing an Empty workspace does not seed
content. Browser Web does not persist local workspaces.

## Authoring syntax and supported positions

Use double braces, for example `{{workspace.name}}`. Optional whitespace inside
the braces is ignored. Each path segment starts with an ASCII letter and may
contain letters, digits, underscores or hyphens; dots separate nonempty
segments. Names are case-sensitive. Use the exact lowercase names below.
Malformed braces, empty segments and unknown paths fail the Web/Core operation.
There are no flat aliases for dotted automatic paths.

Variables are supported in canonical block text, native table-cell text and
the effective target title selected by the template's title policy. They are
not substituted in arbitrary block properties, URLs, captions or source-code
properties. A preserved target title is not scanned or rewritten. Existing
date, template-title and combined template/date title policies are unchanged.

Only the token ranges are replaced. Surrounding inline formatting is retained;
a replacement inherits the marks of the opening brace, including when a token
crosses differently formatted text runs. Inserted values are literal: braces
inside a workspace or member name are never evaluated again.

### Insert variables in a template source

In a writable template source, use **Insert variable** from the text toolbar,
the native table-cell context menu (right-click or Shift+F10), or the title
context menu. Web and Electron use the same searchable dialog. The
chooser groups the variables below by document, workspace, date, explicit
context and applying actor. Each entry shows the literal token, its source and where it is
available. Choosing an entry inserts ordinary brace text at the current caret;
undo and redo treat the insertion as one edit and focus returns to the source.
Type a label or token to filter, move with the arrow keys and confirm with Enter.
Escape closes the dialog without changing the source and restores editor focus.

For example, author `Status · {{workspace.name}} · {{date_long}}` in a title,
or use `Created {{document.created_at.datetime}} by {{creator.name}}` in body
text or a native table cell. Context-dependent values such as
`{{parent_page_title}}` and `{{folder_name}}` are shown with their narrower
availability. Ordinary documents and readonly template sources do not expose
this authoring action. Member fields remain available only inside the native
**Repeat for → Workspace members** binding described below.

## Check a source without applying it

Choose **Check template** in a source's Library menu or its document menu.
Readable sources can be checked even when they are readonly. The shared Web and
server-connected Electron editor checks one synchronized native source revision,
including the title, canonical block text and native table cells. It does not
create a target, change source content or metadata, reserve an application,
create an idempotency entry or open an input dialog. `required_variables` is an
inventory summary, not a substitute for these native diagnostics. Rust native
inspection shares the repeat preflight and reports native UTF-16 token offsets
and table row/column identities without expansion; malformed sources stay
available in the readable Library inventory.

The dialog distinguishes malformed syntax, unknown paths, invalid repeat bindings
or placement, and unavailable context or facts. Its summary counts each status. **Available now** describes facts
read for this check. Creator and creation-time facts are **Resolved on application**:
there is no target whose creation metadata could be inspected yet. Valid
`input.*` tokens are **Input required**, not broken variables. This action does
not require the separate interactive-input application flow to have shipped.
Folder and parent values are **Context required** without explicit application context; checking from a
source menu does not infer a destination from the source's current location.
Capability labels and descriptions match the existing variable chooser.

**Open source location** opens the same source and selects the affected token
in its actual title, text block or table cell. Invalid repeat units navigate to
their prototype text or table unit. If the source changes during the check or
while results are open, the dialog marks the result as outdated and disables
location navigation. Choose **Check again** to capture the corrected revision;
results never silently follow later edits. Closing or pressing Escape returns
focus to the invoking menu button. Opening a location instead focuses the source.

A check is point-in-time feedback. Application still checks current permissions,
context, source content and target facts through its normal owner. A successful
check neither reserves a target nor guarantees a later application will succeed.

## Manual inputs

Use `{{input.project_name}}` for a required, manually entered text value. The
name after `input.` is one identifier segment: start with an ASCII letter, then
use letters, digits, underscores or hyphens. In **Insert variable**, type the
complete `input.name`, then choose **Text**, **Date** or **Date and time** in
the existing keyboard-operated chooser. The explicit namespace declares the
input type; field names never imply one:

| Source token                      | Input control             | Canonical MCP answer                          |
| --------------------------------- | ------------------------- | --------------------------------------------- |
| `{{input.topic}}`                 | Text                      | Any nonempty literal string                   |
| `{{input.date.meeting_date}}`     | Date picker or typed date | `2026-11-04` (`YYYY-MM-DD`)                   |
| `{{input.datetime.next_meeting}}` | Date and time picker      | `2026-11-04 09:30:00` (`YYYY-MM-DD HH:mm:ss`) |

Only these two typed namespaces extend `input.name`; other nested paths remain
unsupported. Every identifier and the complete name retain the existing bounds.
Dates and date/time answers are the calendar day and clock time deliberately
chosen in the form. They are not zoned instants and never shift when the
account or browser timezone differs. Invalid dates and clock times fail before
a target is written. The existing regional date/time formatters project the
admitted answer once, using the applying account's display preferences.

Application scans one captured effective title, body and native table content.
Each name appears once in a Mantine/Facade dialog, in a stable order, with a
readable label and its exact token. Every answer is trimmed and must contain
a nonempty string of at most 8 KiB; temporal strings must have the canonical
format above. Names are limited to 128 bytes and the existing
100-variable bound applies. Values are literal, including any braces inside
answers. The source keeps its tokens; answers belong only to this operation.

For a project brief, combine `{{input.project_name}}`, `{{input.reference}}` and
`{{input.scope}}` with `{{workspace.name}}`. For a handover, use
`{{input.recipient}}`, `{{input.open_issues}}` and `{{input.deadline}}`. For an
incident report, use `{{input.affected_service}}` and `{{input.impact}}`.
`input.deadline` remains ordinary text. Use `input.date.deadline` when an
explicit calendar date is required. After application, answers are ordinary
editable text; the source retains its typed tokens.

Cancel creates or writes nothing. Submit is single-flight. On a recoverable
failure, the dialog retains the answers and waits for an explicit retry; it
never reapplies automatically. A retry checks a fresh source and current
permissions. Static sources remain one-click. Journal defaults cannot require
manual inputs; selecting one is rejected without replacing the current default.
An older input-bearing default fails without overwriting an existing Journal.

MCP supplies these same strings in the existing `variables` argument. Missing,
empty, structured or incorrectly named `input.*` values fail before a document
is published. Unrelated deployed explicit MCP variable names retain their
existing contract. This does not introduce a form schema, answer history or
cross-workspace input cache. Existing shipped templates gain no mandatory inputs.

## Native input data

Native input descriptors are separate from `input.*` substitutions. They store
one occurrence's own value and copied definition, not an answer map indexed by
name. Definition validation admits `text`, `date`, `datetime`, `single-select`
and `multi-select`. Scalar unset is `null`; multiple-selection unset is `[]`.
Required native fields may remain unfinished in a draft. Text is literal and
untrimmed, including braces; ordinary manual creation answers keep their existing
trimmed, required-before-creation behavior.

Saved history retains the field's readable value as it was captured, including
selection labels and formatting. Historical reading output uses that text rather
than resolving today's metadata. HTML, Markdown and plain-text projections are
reading formats: they contain ordinary text, not an editable field definition or
its independent stored answer. Native archival snapshots retain the descriptor
and captured text. A historical field whose original value was never captured
is unavailable; today's values cannot reconstruct it.
When native field content is copied into an editable document, each copied
occurrence becomes an independent live field with its stored input definition
and answer; metadata fields refer to the destination document.
The same distinction applies when materializing a native snapshot as a new
editable document: the archival source is not rewritten.

Existing live fields are visible in the editor. On an editable, unprotected
occurrence, **Convert to text** replaces the field with its displayed value in
one undoable edit; the result is ordinary text and stays literal across later
copies and restores. An unanswered input converts to empty text, not its label.
For metadata, conversion rechecks the current authorized value and refuses a
value that is unavailable or has changed. An unset metadata value converts to
the displayed dash. Historical snapshots remain unchanged.

Applying a template or inserting a building block initializes each live input
from its explicit default, or leaves it unset. A filled source/preview answer is
not that default. Ordinary native copy/paste and document duplication retain the
filled answers. Repeated rows and inserted fragments have independent native
occurrence identities even when their labels match. Stored input values and
frozen text containing braces are never processed as template expressions.

Calendar values must describe a real day/clock using `YYYY-MM-DD` or floating
`YYYY-MM-DD HH:mm:ss`, with years 0001–9999 and no timezone conversion. Selections
use option IDs, never labels; definitions have at most 100 unique, nonempty IDs
and nonempty labels. Multiple answers are deduplicated in authored option order.
Unknown IDs, invalid calendar values and invalid defaults are rejected. Defaults
are validated without filling an unanswered occurrence. Presentation uses stored
values and authored labels, never the latest source definition or viewer-locale
translations of those labels. Input-only validation/presentation needs no source
permissions, document metadata lookup or capability-discovery request.

These data contracts do not add brace syntax or silently convert existing
sources. In writable template body text and native table cells, the existing
field/variable chooser can insert native input definitions with their label,
kind, optional description, required flag, options and default. The same chooser
offers document metadata fields in writable ordinary and template bodies and
table cells; document titles support only the existing static variables. The
source checker lists native fields and links to their source positions. Editing
an existing input definition is available from that field in a writable source;
its occurrence identity, answer and option identities are preserved. A changed
field must be reopened before saving.

In a created document, activate the field where it occurs to fill or revisit its
own value. Text and multiple selection use a local draft with **Apply** and
**Cancel**; **Escape** discards that draft. Multiple-selection **Clear** clears
the draft, which is saved with **Apply**. Dates and single selections commit
the accepted choice directly; date/time commits with the native **Confirm**
control. Scalar **Clear** writes the unset value, including for required fields.
Invalid unfinished values remain local. A field changed while its draft was open
must be reopened rather than overwritten. Confirmed answers are native undoable
edits, not replacement text. Readonly views expose no filling controls.

**Open metadata** uses the existing document-info dialog and its access checks;
readonly editors may open viewing only. **Remove** deletes just the occurrence.
Native-only sources do not introduce a pre-creation form. A mixed source still
asks for its deliberate `input.*` substitutions before creation, leaving native
fields for direct editing afterward.

### Selectively fixed native text

In an editable template source, select one paragraph, list item or callout and use
**Protect text when used** in the editor toolbar. A single table cell exposes the
same action in its context menu. **Keep text editable when used** removes this
source setting. The source remains editable, including its field definitions;
source changes affect subsequent uses, not existing copies.

Application stores the selected owner's mode as `fixed` in the resulting native
document. Literal text, formatting, field definitions and removal of that owner
are blocked locally. Input answers remain fillable and undoable. Checklist state
and intact layout moves remain usable; unmarked neighbors stay ordinary editable
content. A fixed owner has no unlock action, even if the target is subsequently
classified as a template source. The text tooltip explains the mode.

Native copies retain this mode. Pasting a protected text fragment into a table
cell requires replacing the whole cell, rather than extending protection over
unrelated text. HTML, Markdown and plain-text reading exports do not enforce
native editor protection.

## Automatic values in Web/core

All values in this table are strings.

| Path                           | Authoritative input and value                                                | Availability                                           |
| ------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `date`                         | Application date, formatted using regional date preferences                  | Local and server-backed                                |
| `date_long`                    | Application date in localized long form                                      | Local and server-backed                                |
| `weekday`                      | Localized weekday of the application date                                    | Local and server-backed                                |
| `week`                         | ISO week number of the application date                                      | Local and server-backed                                |
| `calendar.iso_week_year`       | ISO week-numbering year of the same application date                         | Local and server-backed                                |
| `month`                        | Localized month and year of the application date                             | Local and server-backed                                |
| `quarter`                      | `Q1`–`Q4` and year of the application date                                   | Local and server-backed                                |
| `year`                         | Year of the application date                                                 | Local and server-backed                                |
| `iso`                          | Application calendar date as `YYYY-MM-DD`                                    | Local and server-backed                                |
| `workspace.name`               | Trimmed current workspace name projection                                    | Local and server-backed                                |
| `creator.name`                 | Trimmed accepted-member name matching the target's server `createdBy`        | Server-backed; member enumeration permission required  |
| `creator.email`                | Trimmed accepted-member email matching the same `createdBy`                  | Server-backed; member enumeration permission required  |
| `actor.name`                   | Trimmed name of the authenticated applying account                           | Server-backed; authenticated self-account read         |
| `actor.email`                  | Trimmed email of the same applying account                                   | Server-backed; authenticated self-account read         |
| `document.created_at.date`     | Regional date from the target's server `createdAt`                           | Server-backed                                          |
| `document.created_at.time`     | Regional time from the same `createdAt`                                      | Server-backed                                          |
| `document.created_at.datetime` | Regional date and time from the same `createdAt`                             | Server-backed                                          |
| `organization_name`            | Trimmed name of the installation's canonical Organization                    | Server-backed; Workspace Read                          |
| `organization_unit_name`       | Trimmed name of the workspace's verified owner OU                            | OU-owned server-backed; Workspace Read                 |
| `parent_page_title`            | Trimmed current title of the explicit readable parent                        | Explicit same-workspace context; no inferred nesting   |
| `folder_name`                  | Trimmed terminal destination folder name                                     | Exact MCP destination or sole existing Web target link |
| `folder.path`                  | Validated destination ancestor names joined with `/`, without synthetic root | Same validated placement as `folder_name`              |

The existing application date may be a Journal calendar day; a date-only input
retains that day rather than shifting across timezones. Creation-time values
instead project one authoritative instant through the account's effective
locale, timezone, date and time preferences. Applying a template to an existing
document preserves its original creator and creation instant. The currently
signed-in account and the client clock are not substitutes for these facts.

`actor.name` and `actor.email` instead read the current stored profile of the
authenticated account applying the template. They do not name the document's
original creator, a responsible person, sender or moderator. This is an
authenticated self-account read, not a member-directory read: it neither
requires nor grants `UsersRead`. Existing workspace, source, target and creation
permissions still apply. Only requested fields must be nonempty; an email-only
template does not require a name. An unavailable account or requested field
fails explicitly. Local/offline workspaces cannot attest an actor and do not
substitute a cached identity.

`week` and `calendar.iso_week_year` use the same effective Gregorian calendar
day. For example, Journal day `2021-01-01` is week `53` of ISO year `2020`,
regardless of account timezone. Instant inputs first use the effective timezone;
date-only Journal inputs retain the authored day. The protected ISO-year value
is never inferred from caller-formatted date text. These four new automatic
paths reject caller overrides even when unused.

Date-only and workspace-name templates do not read target creation metadata or
enumerate members. Creation-time templates read canonical server metadata after
target creation is acknowledged, without loading member lookup lists. Creator
templates use the original target creator's accepted membership through the
existing `UsersRead` boundary; they never substitute the applying user. Member
repeats enumerate accepted members once on the server. Name and email are
independent: an empty requested name
does not silently fall back to email, or vice versa. Member pagination is
bounded by the first server count and is best-effort during membership churn,
not a transactional membership snapshot.

The deferred context request also checks the existing target's Update access,
or CreateDoc access before creating a new target. Source syntax and requested
target-independent facts are captured and validated before target creation;
only committed creator/time facts remain pending in the compensated write
phase. An unavailable member lookup therefore creates no target and copies no
body. Once created, the target lifecycle signal also cancels stale fact reads.

### Organization context

Use the exact names `{{organization_name}}` and `{{organization_unit_name}}`
in native body text, table cells or the effective title, for example
`Minutes · {{organization_name}} · {{organization_unit_name}}`.
The dedicated `workspace(id).templateContext` projection requires Workspace
Read, including at its child field resolvers; it does not grant organization
administration or require the actor to be an OU manager/member.

Only requested fields are read. The organization name comes from the canonical
Organization row, never branding. The OU name requires an OU owner principal
and exactly one matching `owner` relationship. `managed` and `linked` relations
are not ownership. Missing/empty names, absent principals, duplicate owners or
principal/link mismatch leave that field unavailable and abort an application
that requests it. Organization-only use still works for a personal workspace;
OU-only use does not depend on the organization name being nonempty.
Transport or authorization failure aborts the request rather than supplying a
fallback. Local workspaces have no organization or OU source.

Both names are reserved in Web/Core and MCP: even an unused caller-supplied
value is rejected. MCP resolves them during zero-write preflight, while Web
uses its existing target trash/restore boundary. Later organization/OU renames
never rewrite previously instantiated content.

### Explicit creation and placement context

`{{parent_page_title}}` is the trimmed current title of an explicitly supplied,
readable, non-trashed document in the same workspace. It cannot be the template
or target. This is substitution context, not a persistent parent relationship.
Current Web entry points do not create child pages and therefore supply no
parent. MCP accepts `context_parent_external_id` for this purpose.

`{{folder_name}}` is the trimmed terminal name, not the complete folder path.
The Starter Bar resolves the existing target's sole Organizer document link;
zero or multiple links, a missing/non-folder ancestor, a cycle or an empty name
abort application. An explicit Web folder must match that sole link; specifying
a folder never silently places a new document. Sidebar, All Contents,
Collection and Journal supply an empty creation context and do
not infer placement or a parent from navigation. Creating from a Collection
action adds the completed ordinary target to that Collection only after
template application succeeds; this membership is not variable context. MCP
uses its already validated exact destination folder.

`{{folder.path}}` uses that same authorized, unique destination chain, including
all real ancestor names and the terminal folder, joined with `/`. It excludes
the synthetic Organizer root. Missing, ambiguous or invalid placement fails
rather than using the current navigation path. Local/native placement retains
the existing FolderStore resolution. A Web context query requires an existing
target even when a folder is supplied; it does not attest future placement.

All three parent/placement tokens are reserved even when unused. Context is read only when requested
in native body, table or effective title. For example,
`Minutes for {{parent_page_title}} · {{folder_name}}` requires both valid sources.
Local documents can use explicit same-workspace parent/Organizer context; there
is no server organization fallback. Web failures retain the existing atomic
trash/restore behavior. Feedback names the unavailable context class, never its
title, path or document identity.

Resolved names are point-in-time snapshot content. MCP idempotency uses authored
title, caller variables, canonical destination and parent identities; a later
context rename does not rewrite or recreate a completed result. Existing
authorization and preflight still run before a replay is returned, so a now
unreadable or unavailable requested context fails closed.

### Optional Project context

`project.title`, `project.goal`, `project.scope`, `project.start_date`,
`project.end_date` and `project.people` are optional literal text values. Each
accepts at most 8 KiB. Ordinary manual application without explicit Project
context resolves them to empty text; navigation never infers a Project, people,
attendance, assignments or dates. Unknown paths and required `input.*` values
retain their normal validation.

Optional Project setup supplies these values from the confirmed review and
freezes them with the selected source revision. Inserted braces are literal,
including across recovery. Creator, Workspace and creation-time values still
come from the actual native target lifecycle. Editing or moving the result
does not reevaluate its text or change the original source.

## MCP automatic and caller-authored values

When `document_template_instantiate` omits a supported automatic name from
`variables`, the server resolves it. Workspace, organization, parent and folder
facts are checked before creating a target. Requested creator and creation-time
facts come from the actual committed target, not the source or a guessed clock;
late lookup or materialization failure uses the existing compensation boundary.
The captured native source is not reread during this write phase. A concurrent
target revision change rejects late materialization instead of overwriting edits.

For application-date values, one server instant is captured per attempt. The
authenticated applying account's effective locale, timezone, date and time
preferences use the same Auth owner and server defaults as the account UI.
There are no MCP date/locale arguments or inferred Journal dates. Chrono owns
instants, IANA timezones and ISO calculations; ICU supplies locale/calendar
presentation. Creation-time formatting uses those preferences but the target's
separate stored creation instant.

Existing explicit scalar, list and record values, including date, workspace and
creator values, remain caller-authored literal inputs. They are not server
attestations. The four existing reserved context names and `actor.name`,
`actor.email`, `folder.path`, `calendar.iso_week_year` reject overrides even
when unused. An explicit legacy `week` still remains caller-authored and is not
an attested pair with the automatic ISO year.
Unknown omitted names, malformed syntax and unavailable requested context fail
before creation; only recognized automatic creation facts may remain pending.
Completed idempotent replay checks current authorization/preflight and returns
the original result without rewriting it after profile, date or preference
changes. Its semantic payload contains authored inputs and stable identities,
not their resolved presentation.

## Native repetition for workspace members

In a writable document created with **Create new template**, select exactly
one paragraph or list item and open **Repeat for → Workspace members** in its
text toolbar. For a native table, use the row handle's **Row options → Repeat
for → Workspace members**. The row handle also accepts Enter or Space; menu
navigation and Escape return focus to the selected unit. Readonly documents
and ordinary non-template documents expose no repeat-authoring action.

The binding is native metadata `{ source: "workspace.members", alias: "member" }`,
not visible marker text. The control explains the scoped fields locally and
disables a new binding unless the unit contains `{{member.name}}` or
`{{member.email}}`. A paragraph/list with children cannot repeat. Invalid
bindings remain visible and removable; **Remove repeat** preserves all text.
Any remaining scoped fields must then be edited before instantiation. Undo/redo
uses native history. Splitting retains the binding only on the original unit;
merging retains the surviving unit's binding. Converting to an unsupported
format drops the binding in the same undoable operation.

Three independent examples, each with its own binding:

- An unchecked native Todo: `{{member.name}} · {{member.email}}`.
- An email-only bullet: `{{member.email}}`.
- A native two-column table row: `{{member.name}}` in the first cell and
  `{{member.email}}` in the second.

Web/Core reads the accepted-member inventory once, before target content copy,
through the existing member-enumeration permission boundary. Requested creator
fields use a single accepted-member lookup after authoritative creation metadata
is available; they do not traverse the inventory again. The repeat input is a point-in-time, best-effort inventory during
membership churn, not a live relation. Names and emails are trimmed; every
referenced field must be nonempty. An email-only unit does not require a name.
There are no sample people, fallback addresses or silent truncation.

MCP resolves omitted `workspace.members` through the same bounded, authorized
accepted-member lookup. Explicit records remain caller-authored and retain their
order; they are not filtered against membership or represented as attested
members. For example, the existing variables argument accepts:

```json
{
  "workspace.members": [
    { "name": "Alex Example", "email": "alex@example.invalid" },
    { "name": "Sam Example", "email": "sam@example.invalid" }
  ]
}
```

Collections allow at most 500 records, 100 fields per record, 128 UTF-8 bytes
per field name and 8 KiB per string value. Field names consist of dot-separated
segments beginning with an ASCII letter and followed by letters, digits,
underscores or hyphens. Only `member.name` and `member.email` are currently
supported scoped fields. Introspection reports the actionable top-level
requirement `workspace.members`, not independent `member.*` inputs. Existing
scalar and exact-list string-array inputs remain supported; `[]` remains a
legacy string array but is invalid when supplied to a repeat.

Each record generates one ordinary native unit, in accepted-member order for
automatic resolution or caller-array order for explicit MCP records. Inline marks, punctuation, list checked/type
state and table cell styles are retained. Cloned blocks and rows receive fresh
IDs; table column IDs remain unchanged and cells use the new `rowId:columnId`
keys. Clones replace the prototype contiguously. Targets contain no repeat
binding, and their editable content no longer follows member changes. Native
snapshots and copy/paste retain bindings on source templates. A custom source
is immediately available through the workspace Library; use the Registry flow
only when an administrator intends to distribute a shared catalog template.

Unknown bindings, unsupported units, missing parents/rows/fields, empty or
over-limit collections, denied member reads and fetch failures abort the whole
application. `member.*` outside its binding and direct scalar
`{{workspace.members}}` are invalid. Web uses the existing target trash/restore
boundary described below; MCP validates the local expanded snapshot before
publication, including the normal document-ingress byte/decoder limits, and
retains lifecycle compensation. No partial success is returned. Repeat failure
feedback does not contain member data or source identities. Inserted member
information is ordinary document content and therefore inherits document
sharing, publication, export and retention rules.

## Web/core versus server/MCP

| Value family                                      | Web/Core template action                                     | Server/MCP template instantiation                                                      |
| ------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Existing date names                               | Generated from the application date and regional preferences | Omitted: server application instant and account preferences; explicit: caller-authored |
| `calendar.iso_week_year`                          | ISO year paired with the effective application day's `week`  | ISO year of the captured server application day; caller values rejected                |
| `workspace.name`                                  | Current workspace projection                                 | Omitted: current workspace; explicit: caller-authored                                  |
| `creator.name`, `creator.email`                   | Authoritative target creator matched to accepted members     | Omitted: actual committed target creator; explicit: caller-authored                    |
| `actor.name`, `actor.email`                       | Authenticated applying account, not original creator         | Same authenticated self-account resolution; caller values rejected                     |
| `document.created_at.*`                           | Authoritative target creation instant                        | Omitted: actual committed target creation instant; explicit: caller-authored           |
| `organization_name`, `organization_unit_name`     | Automatically resolved, server-backed only                   | Automatically resolved; caller values rejected                                         |
| `parent_page_title`, `folder_name`, `folder.path` | Explicit creation context / unique existing target placement | Explicit readable parent / preflighted destination; caller values rejected             |
| `workspace.members`                               | Accepted-member record collection, resolved once before copy | Omitted: bounded accepted-member lookup; explicit: literal ordered caller records      |

Do not interpret caller-supplied server/MCP values as server-attested identity
or timestamps. Omitted automatic values use authoritative resolution;
organization, explicit creation-context, applying-account and ISO-week-year
names always use their automatic resolution.

## Failure, concurrency and privacy

Unknown syntax and values available without target materialization are checked
before content copying. Creation metadata is resolved after copying, with a
finite 30-second operation deadline covering synchronization and data reads.
Cancellation, disposal, synchronization failure, unavailable metadata, denied
member reads and empty requested fields reject the complete application.

For a new target, failure moves it to trash. For an existing target, failure
after writes attempts to restore content, title and copied properties. This
is compensating rollback: intermediate synchronized content and history may
already exist. It is not an invisible or zero-write transaction. Concurrent
target changes stop the operation rather than overwrite another edit; such a
target is neither blindly restored nor trashed. Failed compensation is
reported separately and requires inspection of the target before retrying.
The shared feedback controller presents that outcome once; it does not perform
a second copy or rollback and never reports a failed application as success.

Inserted names and email addresses become ordinary document content, subject
to its sharing, publication, export, retention and access rules. Choose a
template accordingly before applying it to a widely shared document.

For example, an internal template can contain:

```text
Workspace: {{workspace.name}}
Created: {{document.created_at.datetime}}
Author: {{creator.name}}
```

## Troubleshooting

The shared template application controller reports expected failures once in
the current UI language. Invalid variables, unavailable required data, member
access/read failures, unsupported local use and interrupted synchronization
have safe localized explanations. The initiating action is busy until the
operation settles; repeated activation cannot copy again or duplicate success
navigation. Ordinary failure returns focus to the invoking action for retry.

Concurrent edits and failed restoration require inspecting the target, not a
blind retry. A failed restoration keeps a persistent notification with an
action to open the affected document; its internal identity is used only for
navigation, never notification text or logs. Journal creation and calendar
navigation remain available even when its optional template fails.

Operational logs retain reason codes, not variable values, member addresses,
document IDs or raw provider errors. For `invalid-syntax` or
`unresolved-variable`, review authored tokens. For `member-fetch`, verify the
actor's member-list permission. For `metadata-unavailable` or `sync-timeout`,
check connectivity and creation acknowledgement before retrying. For
`empty-field`, correct the requested authoritative field rather than supplying
an implicit fallback. For `conflict` or `rollback-failed`, inspect the actual
target and preserve newer edits before deciding whether to reapply.
For `organization-unavailable` or `owner-unit-unavailable`, inspect the
authoritative organization/ownership configuration with the appropriate admin
rights. User feedback and operational errors never include those names or IDs.

The document-template application service owns requested server-backed facts
and uses the existing workspace, member, document, organizer and organization
owners. `workspace(id).templateContext.requestedValues` exposes only the requested
template facts, not a general context API. The existing Core `DocsService`
operation and `DocsStore` lifecycle bridge retain native transformation,
regional rendering and offline resolution. The native Transformer fences
import-batch writes through the operation's concurrency guard.
