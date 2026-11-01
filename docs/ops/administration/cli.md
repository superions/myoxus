<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# CLI operations

[Documentation](../../README.md) / [Operations](../README.md) / [Administration](./README.md)

The CLI is a trusted local operations interface with direct PostgreSQL access,
not an authenticated remote API client. Most database commands work without a
running API. HTTP checks and external integrations need their respective
services; queued execution needs the running worker stack.

The production server image installs `/usr/local/bin/myoxus-cli`.
Use `myoxus-cli <command> --help` for the exhaustive argument reference.

<details>
<summary>On this page</summary>

- [Connection](#connection)
- [Outgoing TLS and backups](#outgoing-tls-and-backups)
- [Configuration YAML](#configuration-yaml)
- [Global flags](#global-flags)
- [Audit log](#audit-log)
- [User operations](#user-operations)
- [Workspace lifecycle](#workspace-lifecycle)
- [Doc versions](#doc-versions)
- [Storage](#storage)
- [System](#system)
- [Git-sync](#git-sync)
- [Organization operations](#organization-operations)
- [Workspace import and document operations](#workspace-import-and-document-operations)
- [Automation and queued work](#automation-and-queued-work)
- [JSON output](#json-output)

</details>

## Audit log

`audit list` and `audit get` read the existing operator audit log directly from
PostgreSQL. They require no API, Redis, storage service or CLI principal; the
normal database credentials and bootstrap TLS configuration still apply.

```bash
myoxus-cli audit list --category organization --limit 20
myoxus-cli audit list --event-key-prefix database. --from 2026-10-01T00:00:00Z
myoxus-cli audit get <event-uuid>
```

`list` supports `--from`/`--to` (inclusive RFC 3339 timestamps),
`--event-key-prefix`, `--actor-user-id`, `--actor-kind` (`user`, `system`,
`api_key`), `--credential-type`, `--credential-id`, `--target-type`,
`--target-id`, `--category` and `--target-unit-id`. Filters combine with AND.
The event-key prefix is literal, including `_`, `%` and backslash characters.
Target IDs may be UUIDs or configuration keys and require a target type.
Results retain the store's newest-first ordering, with descending event UUID as
the tie-breaker. The default limit is 100; explicit limits must be 1–500.

Human-readable field/value tables are the default, one complete event per table;
global `--json` returns complete records. Both formats include old/new JSON,
metadata and snapshot labels exactly as stored, including historical diagnostic
content. The trusted local operator receives all audit fields without additional
masking, omission or truncation. Normal JSON encoding preserves string contents.
These commands never rewrite historical data.

An empty list succeeds. A missing event exits 1; invalid arguments (including a
reversed time range or a limit outside 1–500) exit 2 before database connection.
Storage failures exit 1 without printing raw database connection errors.

## Connection

The database URL is resolved in this order:

1. `--database-url-file <path>`
2. `MYOXUS__DATABASE__URL_FILE`
3. `DATABASE_URL_FILE`
4. The shared server config stack (package defaults, runtime overlay and
   normal `MYOXUS__*` overrides)

Production rejects the packaged development database default. In the server
container no flag or shell export is needed: the image entrypoint creates
`/run/myoxus/database-url`, and the service environment permanently points the
API and later `docker exec` commands at that file.

### Configuration imports

See [configuration lifecycle and import recovery](../configuration/README.md#effective-values-and-restart-state)
for candidate validation, partial/full imports, stdin, dry-run, structured
results and recovery after a successful database commit but failed YAML mirror.

## Outgoing TLS and backups

The CLI loads `tls.additional_ca_bundle_path` from file/ENV before opening
PostgreSQL. The immutable snapshot is also used by HTTP, S3, Git and Redis
consumers. Restart the CLI after replacing the bundle; a legacy DB-only Git
CA remains Git-only and requires the [bootstrap migration](../integrations/git-sync.md#additional-ca-migration).
See [global trust configuration](../configuration/README.md#additional-certificate-authorities)
for bundle validation, deployment and restart requirements.

Backup/restore uses a private, process-owned libpq service file for
`pg_dump`/`psql`. Its connection parameters come from the configured database
URL; credentials never enter command arguments. With global trust configured,
the service references a combined CA file containing global roots, public native
roots and any database-specific roots. A database-specific CA is never promoted
to global trust. Both temporary files remain available until the child exits
and are removed afterwards; the parent environment and configured URL remain
unchanged. SSL mode is retained, including the implicit `verify-full` policy of
libpq system trust. Connection values that cannot be represented safely in a
single-line libpq service file fail explicitly without echoing their contents.

## Configuration YAML

Configuration import and YAML export share `contracts::config_document` with
server startup and mirror writeback. YAML input is limited to one document and
4 MiB; duplicate keys, malformed/trailing documents and parser resource-limit
violations fail without exposing source values. Structured fields retain their
spelling and typed provider validation. Export preserves values and literal
dotted keys, but not source presentation or comments. Serialization failures are
sanitized. JSON transport and CLI arguments are unchanged. Use trusted input for
recovery; masked exports must not be reimported as credentials.

## Global flags

| Flag                         | Description                                    |
| ---------------------------- | ---------------------------------------------- |
| `--database-url-file <path>` | Read the PostgreSQL connection URL from a file |
| `--json`                     | Structured output where supported              |

## User operations

```bash
# List all users
myoxus-cli users list

# Filter by substring
myoxus-cli users list --filter alice

# Show user detail (UUID or email)
myoxus-cli users get alice@example.com
myoxus-cli users get 550e8400-e29b-41d4-a716-446655440000

myoxus-cli users create --email user@example.com --name "Example User"
myoxus-cli users set-password user@example.com --password-file /run/secrets/user-password
printf '%s\n' "$PASSWORD" | myoxus-cli users set-password user@example.com --password-stdin
myoxus-cli users reset-link user@example.com
myoxus-cli users set-admin user@example.com --admin
myoxus-cli users set-admin user@example.com --admin false
myoxus-cli users delete user@example.com --confirm
```

`users set-admin` grants by default; `--admin false` revokes. It refreshes
auth-session snapshots across API instances without revoking sessions or keys.
A missing target fails instead of reporting a successful change.

`users reset-link` uses the configured public server origin, canonical default
callback and effective token TTL. Its authorized output includes the secret
one-time link; the corresponding audit contains no URL or token. Missing users
fail without issuing a token.

`users disable` atomically suspends the account and revokes its sessions and
MCP API keys through the shared auth owner, including the configured session
cache barrier. `users enable` restores active status; old credentials remain
revoked. List/get read that same persisted account status.

`users create` creates a passwordless user and their one canonical personal
workspace and initialized root, including configured template defaults. Email
is normalized and an existing normalized identity is refused without changing
its profile. Output timestamps come from the persisted account. Account insertion
and workspace/root/policy provisioning are not one transaction: a later error
keeps committed objects and reports their non-secret IDs (or explicitly unknown
workspace state). It does not delete the account or silently repair/retry it.
Passwords are accepted only from stdin, an owner-only regular file,
or a hidden interactive prompt. Plaintext credentials must never be supplied as
arguments, emitted as output, or written to logs.

`users delete <id-or-email> --confirm` permanently deletes the account and its
credentials through the shared auth/content transaction and cache barrier. It
removes sole-owner workspaces/content and preserves shared workspaces, including
archived ones, under the existing ownerless principal with surviving members.
Historical UUID/name references and shared attachments remain intact. A scrubbed
terminal identity survives for attribution, with no credentials or access. It
cannot be enabled, edited or granted rights. Account discovery excludes it; a new
account at its original email receives a different UUID without inherited rights.
Missing/already-deleted targets fail without a successful deletion audit.

Deletion audit retains the name/UUID without the former email/avatar. Old reset,
magic-link and app codes cannot authenticate the deleted or recreated account.

## Sessions

`sessions list [--user <email|uuid>]` lists active sessions. Revoke with
`sessions revoke <session-uuid>`, `sessions revoke --user <email|uuid>` or
`sessions revoke --all`. The selectors and human/JSON result retain the revoked
row count; unknown or already revoked targets report zero. Revocation includes
unrevoked expired rows, just as before. `--all` targets the selected instance's
sessions and should be operated only with that scope understood.

Revocation uses the configured authentication service, session Redis epoch/cache
and cache-role publication bus. It waits for post-commit effects before exit.
Other sessions remain valid after single-session revocation; accounts and MCP
keys are unchanged. API instances receiving the event cancel targeted pending
document loads. A post-commit cache/publication failure cannot roll back the
revoked rows; authentication stays fail-closed if cache activation fails.

## Workspace lifecycle

The two command groups are deliberately retained:

- `workspaces` is the complete general lifecycle and covers normal user-owned
  workspaces plus ownership and management transitions.
- `shared-workspaces` is the concise operator surface for workspaces whose
  authoritative owner is an organization unit.

### General workspaces

```bash
# Read projections
myoxus-cli workspaces list
myoxus-cli workspaces list --user user@example.com
myoxus-cli workspaces get <workspace-id>
myoxus-cli workspaces members <workspace-id>
myoxus-cli workspaces stats <workspace-id>

# Create and update a non-personal user-owned workspace
myoxus-cli workspaces create --owner-user user@example.com --name "Operations"
myoxus-cli workspaces update <workspace-id> --name "Operations Europe"

# Memberships; Owner is assigned only through transfer-owner
myoxus-cli workspaces add-member <workspace-id> member@example.com \
  --role Collaborator --actor admin@example.com
myoxus-cli workspaces set-member-role <workspace-id> member@example.com --role Manager
myoxus-cli workspaces remove-member <workspace-id> member@example.com

# Principal and management transitions
myoxus-cli workspaces transfer-owner <workspace-id> --to-user owner@example.com
myoxus-cli workspaces transfer-owner <workspace-id> --to-unit <organization-unit-id>
myoxus-cli workspaces set-management-unit <workspace-id> --unit <organization-unit-id>
myoxus-cli workspaces set-management-unit <workspace-id> --clear

# Sharing state
myoxus-cli workspaces set-sharing <workspace-id> --enabled true
myoxus-cli workspaces set-public <workspace-id> --enabled false

# Soft-delete and idempotent restore
myoxus-cli workspaces delete <workspace-id> --confirm
myoxus-cli workspaces get <workspace-id>
myoxus-cli workspaces undelete <workspace-id>
```

`create` never creates a second personal workspace. A user transfer atomically
updates the owner principal and the accepted `Owner` membership. An OU transfer
removes every human `Owner`, retains at least one accepted `Admin`, and records
exactly one OU owner relationship. The previous owner OU remains attached as
`managed` when ownership moves between OUs. Personal workspace ownership cannot
be transferred.

Role changes and removals serialize with ownership changes. They reject removal
of a user owner and reject demotion or removal of the final accepted `Admin`
from an OU-owned workspace. `undelete` revalidates the owner, reserved name,
personal-workspace uniqueness, required membership, and OU owner relationship
before restoring the original UUID and membership set.
Trash retains document/history content and blob metadata/bytes. It does not
schedule permanent file deletion, and retained trash or archive records protect
against old queued purge jobs and orphan maintenance. Remote MCP recovery uses
`workspace_restore` with `write:workspaces` and a current global administrator;
MCP trash uses `workspace_delete` with current Delete permission and explicit
`confirm: true`. Both use durable keys and the same lifecycle services as CLI.

Existing JSON read projections for `list`, `get`, `members`, and `stats` remain
stable. `get` also reports `deleted_at`, which makes a soft-deleted workspace
diagnosable while normal lists continue to hide it.

### Workspace Tasks recovery

`myoxus-cli workspaces ensure-tasks <workspace-id>` uses the normal configured
catalog and canonical initializer. It returns the retained default ID and actual
managed readiness/reason, without impersonating a user, reseeding contents or
allocating a competing default. Run it after correcting a reported provisioning
failure. Ordinary workspace/database reads perform no hidden global backfill.

### OU-owned shared workspaces

```bash
myoxus-cli shared-workspaces list
myoxus-cli shared-workspaces get <workspace-id>
myoxus-cli shared-workspaces create \
  --name "Engineering" \
  --unit <organization-unit-id> \
  --admin admin@example.com
myoxus-cli shared-workspaces update <workspace-id> --name "Platform Engineering"
myoxus-cli shared-workspaces add-member <workspace-id> member@example.com \
  --role Collaborator --actor admin@example.com
myoxus-cli shared-workspaces set-member-role <workspace-id> member@example.com --role Manager
myoxus-cli shared-workspaces remove-member <workspace-id> member@example.com
myoxus-cli shared-workspaces delete <workspace-id> --confirm
myoxus-cli shared-workspaces undelete <workspace-id>
```

`create --admin` and `add-member --actor` are mandatory. The CLI never chooses
an arbitrary global administrator from database ordering. The selected
administrator must be active and globally privileged for these OU convenience
commands.

## Doc versions

```bash
# List named versions for a document
myoxus-cli doc versions list --doc <doc-uuid>

# Capture current document state
myoxus-cli doc versions create --doc <doc-uuid> --label "before-release"
myoxus-cli doc versions create --doc <doc-uuid> --label "reviewed" --description "QA baseline"

# Protect / unprotect from retention-GC
myoxus-cli doc versions pin --id <version-uuid>
myoxus-cli doc versions unpin --id <version-uuid>

# Append-only restore: applies the snapshot as a new update and creates a restore-* version
myoxus-cli doc versions restore --id <version-uuid>

# Show / update versioning settings
myoxus-cli doc versions settings show --doc <doc-uuid>
myoxus-cli doc versions settings set --doc <doc-uuid> --enabled true --retention-count 10 --triggers on_publish,on_pdf_export,daily
```

## Storage

```bash
# Storage stats for all workspaces
myoxus-cli storage stats

# Stats for one workspace
myoxus-cli storage stats --workspace <workspace-uuid>

# Top 10 workspaces by storage
myoxus-cli storage top

# Top 20 workspaces
myoxus-cli storage top --n 20
```

`storage orphans` and `storage gc` are intentionally disabled until the server
has authoritative blob-reference tracking. Both commands exit with a non-zero
status and never mutate data. The server's retention GC remains available for
blobs that were explicitly soft-deleted through the normal application flow.

```bash
# Safety guards: both fail without querying or changing blob records
myoxus-cli storage orphans
myoxus-cli storage gc --dry-run
myoxus-cli storage gc --confirm
```

## System

`system doctor` starts before PostgreSQL connection and prints fixed typed
diagnostic results (`check_id`, `status`, `elapsed_ms`, `detail`). Human-readable
tables are primary; `--json` returns the same rows. Current checks cover loading
database configuration, bootstrap CA validation, a PostgreSQL connection and
configuration readiness using the same findings as `config check`.
Database readiness is checked separately through the same connectivity,
required-table and privilege checks as API startup. The migration result reads
the existing ledger in a consistent read-only transaction against the binary's
embedded inventory. It distinguishes current (`pass`), known pending forwards
(`warn`) and altered/unknown/unsupported ledgers (`fail`). A fresh empty database
has the full chain pending; a schema without a ledger is not treated as fresh.
Doctor never creates `_sqlx_migrations`, runs migrations, takes a migration
advisory lock or repairs schema. Neither a valid ledger nor a reachable database
establishes worker processing.

```bash
myoxus-cli system doctor
myoxus-cli --json system doctor --strict
```

Each check has a five-second deadline and the complete report has a twenty-second
deadline. Independent checks continue after failure; a missing prerequisite is
reported as `skip` rather than assumed healthy. Any `fail` exits 1; `warn` exits
1 only with `--strict`; argument errors exit 2. Doctor prints concrete
configuration/connection errors, SQLSTATE where available, and the effective
host, port, database, user, TLS mode and socket path. Passwords, tokens, private
keys and complete credential-bearing connection URLs are not printed. Invalid production
defaults and CA policy remain failures, not reasons to fall back to development
settings or insecure TLS. A successful connection is only a CLI snapshot.

Configuration diagnostics use the canonical file/ENV sources, registered
database overrides and the existing no-write startup validator. They report
default-key, origin, mail/auth-related configuration findings and pending-restart
paths. If PostgreSQL or its configuration rows cannot be read, the database
overrides and pending-restart state are explicitly unverified; independent
file/ENV checks still run. Invalid persisted configuration fails its own check.
The CLI does not prove the configuration or authentication capabilities loaded
by an already-running API: configured OAuth/SMTP values alone do not establish
usable login. The dedicated capability result says so rather than reporting a
green authentication system. `config check` retains its colored
CRITICAL/WARNING/INFO output and exits 1 only for critical findings.

Doctor and `system status` probe the configured cache, session, queue, socket
and lock roles through the canonical Redis/TLS configuration. Session, queue
and lock are required; unconfigured cache/socket roles skip. A configured but
unreachable role fails. Diagnostics include the non-secret Redis transport
target, logical database and namespace. `system queue` probes only its queue role.
None of these commands constructs the complete CLI service graph.

Queue inspection uses the worker's queue adapter, the CLI producer's Bull prefix
and the canonical Admin queue inventory. `--queue` selects a single name.
Successful counts retain the `{queue, status, count}` shape with waiting, active,
completed, failed, delayed and stalled buckets. If even one bucket cannot be
measured (`degraded`), **all** rows for that queue are omitted; other measured
queues remain in the output. Causes appear on stderr and in status/Doctor
results. Both `status` and `queue` print available results before exiting 1 for
a failed measurement. No replacement zeroes are reported as measurements.
Worker processing itself remains a warning, not a claimed successful check:
empty queues are valid and neither prove nor disprove a running worker. These
read-only probes do not enqueue synthetic jobs or create a heartbeat service.

Doctor also checks the **configured** object store by writing one unique
`doctor-probe/<uuid>.txt` payload, comparing its bounded readback and deleting
the key. It uses the normal CLI production adapter and bootstrap trust, never
an alternate local store or a business blob/database row. Within the five-second
storage check, configuration plus write/read have up to three seconds; two
seconds are reserved for deletion, strictly inside the complete report deadline.
Deletion is attempted even after a failed or timed-out write/read. Cleanup has
its own result; failure or timeout fails Doctor and prints the exact key for
operator inspection. Network cancellation cannot guarantee that a remote store
will not finish an already accepted request later; inspect the reported key
after a timed-out operation. This diagnostic does not change startup's storage
check or repair existing storage data.

The SMTP check loads the canonical mail startup snapshot and bootstrap CA trust,
then establishes its configured transport/authentication and tests SMTP NOOP
through the existing SMTP client. Unmirrored restart-pending DB candidates do
not replace that snapshot. Unconfigured SMTP skips; rejected configuration,
connection/authentication/NOOP failure or a five-second timeout fails. Host,
port, transport, verification policy and the transport's failure phase/code are
shown; authentication credentials are not. It never sends a message, reset link
or provider action, and a passing CLI connection is not a claim about the mail
configuration or login capabilities loaded by the running API.

`system health --url` runs before any database configuration or connection and
does not construct Services. Its default remains `http://localhost:3001`.
It requests `/health` and `/ready` beneath the supplied URL's deployment prefix
with the global CA policy, a five-second deadline per request including body
reads and a 64 KiB response limit. Both results are printed even when one fails.
HTTP 200 alone is insufficient: `/health` must carry its typed `ok`, uptime and
startup-check snapshot, while `/ready` must carry `ready` and no failed startup
checks. Rejected HTTP status (including 503), malformed/HTML responses,
connection failure and timeout exit 1. The JSON fields remain `endpoint`,
`http_status`, `body_snippet`; the latter is now a bounded diagnostic summary,
never an untrusted body excerpt. URL credentials, queries and fragments are
rejected without quoting their values; redirects are not followed implicitly.
These endpoints report stored startup readiness, not live worker health.

To inspect the delivered deployment rather than only local dependencies:

```bash
myoxus-cli system doctor --external-origin https://workspace.example.test/prefix
```

The optional checks request `/health`, `/ready`, `/info`, `/admin` and
`/adminfrontend/security` beneath that prefix, independently of local dependency
results. The supplied origin/prefix must match both the CLI startup
`server.origin` and the running API's `/info.base_url`; development ports are not
blacklisted. API JSON is validated. The delivered Nginx's literal `/health`
`ok` is recognized as gateway liveness only, not API or worker readiness.
Admin responses must reach the expected Admin routes and contain recognizable
Admin HTML, not the Web fallback. This checks the entry shell only: it does not
fetch assets, sign in, contact an IdP or claim authenticated GUI functionality.

Each complete route check, including redirects and body reads, has five seconds.
JSON is limited to 64 KiB and Admin HTML to 256 KiB. At most four redirects are
followed, with every target admitted **before** requesting it: origin, deployment
prefix and this probe's known delivery routes must remain expected. Credentials,
queries, fragments, loops and unexpected login/provider routes fail without
echoing rejected targets or bodies. All requests are unauthenticated; no
credentials are forwarded and no configuration is written.

```bash
# DB connectivity + queue depths
myoxus-cli system status

# List applied migrations
myoxus-cli system migrations

# Queue stats (all queues)
myoxus-cli system queue

# Queue stats for a specific queue
myoxus-cli system queue --queue notification

# Check server HTTP health endpoints
myoxus-cli system health
myoxus-cli system health --url http://localhost:3001
```

## Git-sync

```bash
# List profiles, optionally for one workspace
myoxus-cli git-sync profiles
myoxus-cli git-sync profiles --workspace <workspace-uuid>

# Show recent runs plus explicit doc/file conflict, binding and partial counters
myoxus-cli git-sync status <profile-uuid>
myoxus-cli git-sync status <profile-uuid> --limit 20

# Show document and file conflicts. File rows include run_id/blob_key/binding_id.
myoxus-cli git-sync conflicts <profile-uuid>
myoxus-cli git-sync conflicts <profile-uuid> --all

# Create or reuse one unfinished Pending/Running run.
# Valid directions: Bidirectional, MyoxusToGit, GitToMyoxus.
myoxus-cli git-sync trigger <profile-uuid> --direction MyoxusToGit
```

`git-sync trigger` connects directly to PostgreSQL like the rest of the CLI. It
uses the shared Git-Sync store to reuse an existing unfinished run instead of
creating duplicate `Pending` rows. The running API/worker stack remains
responsible for Redis queueing and execution.

`git-sync status` includes the latest partial-sync session fields
(`partial_session_id`, `partial_status`, `partial_has_more`,
`partial_total_items`, `partial_processed_items`, `partial_failed_items`) so
large workspaces limited by `max_docs_per_sync` can be operated without a
separate Admin UI.

## Organization operations

`organization units` manages `list`, `get`, `create`, `update`, `move`, and
`archive`. Unit creation and moves require an unambiguous `--parent <uuid>` or
`--root` choice. Organization, unit, parent, and unit type are addressed by
UUID; names and slugs are not guessed as global identities. Mutations delegate
to the shared `OrganizationUnitLifecycleService`, including active type/parent,
root capability, cycle and in-use archive checks. Updates start from persisted
state: omitted parent, status, description, metadata and member limits remain
unchanged; clearing a description requires `--clear-description`. Domain audit
uses the trusted system actor.

`organization members` manages `list`, `add`, `set-role`, and `remove`. Users
are resolved by UUID or exact normalized email. Roles are `reader`, `member`,
and `manager`. Manual writes use `OrganizationMembershipService`, committing
membership and implicit Manager capability in one transaction. `add` requires
absence; `set-role` and `remove` require an existing membership under the same
locks. The first Manager assignment activates the capability, other Manager
scopes retain it, and the last removal or downgrade revokes it. Reader/Member-only
changes preserve independent global grants. Removal from an inactive OU remains
supported. Committed capability transitions invalidate the configured cache-role
Redis namespace and notify API instances through their existing cache bus;
domain audit uses the trusted system actor.

## Workspace import and document operations

Complete legacy workspace snapshots use the durable import lifecycle:

```bash
myoxus-cli workspace import preview --file <snapshot> --actor-id <user-id>
myoxus-cli workspace import apply --file <snapshot> --actor-id <user-id>
myoxus-cli workspace import status --import-id <import-id>
myoxus-cli workspace import cleanup --import-id <import-id>
```

For ZIP preparation, recovery reports and backup boundaries, see
[Obsidian vault interchange](../data/backup-and-restore.md#obsidian-vault-interchange).

An Obsidian vault is an explicit source format because an arbitrary ZIP cannot
be identified safely as a vault. ZIP the vault contents, not a wrapper folder,
then preview or apply it through the same lifecycle:

```bash
myoxus-cli workspace import preview --file <vault.zip> --actor-id <user-id> --format obsidian
myoxus-cli workspace import apply --file <vault.zip> --actor-id <user-id> --format obsidian
```

Preview reports the proposed new workspace, counts, exclusions, blocking
findings and every normalized or source-preserved construct. Apply repeats the
bound preview plan and creates one new server-owned workspace; it never merges
into an existing workspace. A failed or cancelled apply uses the normal
compensation lifecycle, and `status`/`cleanup` retain their existing operator
recovery roles. The CLI uploads opaque parts and invokes the Application
service; it contains no second vault converter.

Each `preview --file` or `apply --file` invocation stages a fresh job; `apply`
previews that new job itself, not a previous preview's ID. Worker retries within
one job reuse its identities. A new invocation intentionally creates another
workspace. `--wait-seconds` bounds waiting for each worker operation (default
7200), not the durable job's lifetime. After a timeout, inspect the import
ID with `status` before starting another import. `cleanup` retries compensation
for `cleanup_required`; it is not deletion of a successfully published workspace.
There is no `workspace import cancel` CLI command. Use the existing product/API
cancellation flow for an active import and retain its status for operator recovery.

Markdown page import and document export remain separate focused commands:

They follow the shared server [Markdown compatibility contract](../integrations/git-sync.md#markdown-compatibility),
including explicit hard-break syntax, raw-HTML restrictions and parent-local
structured footnotes. Plain source wraps normalize to spaces, both
hard-break spellings import as visible intra-paragraph breaks, and export uses
backslash-LF canonically. Direct editor import/export is a separate writer with
the same break semantics, not a promise of byte-identical Markdown style.
For the supported highlights, Mermaid, native formula source, annotations, typed/foldable callouts and whole-note
embeds, including their reading/export limits and recovery diagnostics, use the
[vault capability and inspection guidance](../data/backup-and-restore.md#obsidian-vault-interchange).
The CLI preserves source/model meaning; it does not execute plugins or validate
Mermaid rendering. Keep the loss report and available recovery source with the
export instead of treating a successful command as proof of full format parity.

```bash
myoxus-cli import-file --user user@example.com --workspace <workspace-id> <files...>
myoxus-cli export-docs --workspace <workspace-id> --output <directory>

# Export the current supported workspace content as one Obsidian vault ZIP.
# The actor must currently have workspace Read permission.
myoxus-cli export-docs --workspace <workspace-id> --format obsidian \
  --actor-id <user-id> --output <vault.zip>
```

For multiple Markdown inputs, `import-file` treats the explicit file list as
one batch rooted at its common parent. It allocates all new document identities
before conversion, so `[[target]]`, `[[target|label]]` and relative `.md` links
can resolve forward, backward or cyclically. The same frozen source batch reserves
native heading and block identities, including local fragments, before writes.
`[[target#^anchor]]` and relative heading links resolve to the actual imported
blocks; current existing documents use the normal snapshot-plus-tail reader.
Source files are not reread between preflight and persistence.
Exact normalized paths win over an
exact unique title; missing or duplicate-title targets remain visible and are
reported as safe diagnostic counts. `--dry-run` performs the same resolution
without document or blob writes. Repeating a normal import creates a new batch;
seeded imports retain their deterministic identities.

Raw block or inline HTML is rejected for the entire Markdown import. Validation
runs before data-image blob materialization and document persistence, including
normal and `--dry-run` execution, so a rejected file leaves neither a page nor
an uploaded asset. The narrow `<br>`/`<br />` spelling inside table cells,
escaped literal angle brackets and HTML shown inside fenced code remain valid.

`export-docs` plans every output path before serializing content. References to
documents in that plan become relative Markdown links with aliases preserved;
exact single-block references use retained or deterministic export-only anchors.
The matching exported target body carries that anchor, without changing live
documents. Other navigation parameters remain canonical Myoxus URLs.

The Git-oriented Markdown directory export packages normal completed image
blobs under portable `assets/` paths. It validates metadata, size and checksum
before delivery; repeated references share the same delivered bytes. Unknown
opaque sources without normal blob metadata retain their existing source
spelling. Asset-path collisions or changed bytes fail before file delivery.
Use the configured object store. For filesystem storage, configure
`MYOXUS__STORAGE__ROOT` for export to match the root used during import
(`import-file` also accepts `--storage-root`).

When reimporting a file listed in a Myoxus directory export manifest,
`import-file` materializes its packaged image files through the same bounded
blob path as embedded data images. Keep the export manifest and `assets/`
directory together; image paths and symlinks must resolve inside that canonical
assets directory.

The experimental ordinary-footnote definition-document import and dependency
export suppression are withdrawn. Footnote content belongs to the parent
document. `import-file` and the Git-oriented `export-docs` path now preserve
ordinary definitions as local native containers with normal content children.
Forward/repeated markers resolve to local block IDs; labels remain parent-scoped.
Definitions export once with portable continuation indentation, including
unreferenced bodies (reported by a safe diagnostic). Missing/duplicate/nested
definitions and invalid citation metadata reject before document or asset writes.
Normal image blobs include images below definitions; CLI document/blob metadata
and accounting publish in one transaction, and failed publication protects
pre-existing or concurrently referenced bytes. Git resolves admitted image files
through its existing file plan; normalized stored projections own its baselines.
Existing typed URL/document/attachment citations remain compatible.

Vault previews report unsupported content and preserve source where the
interchange contract provides a recovery representation.
Existing documents created by the withdrawn experiment remain unchanged; no
automatic deletion or data migration accompanies native parent-local support.

Document version commands are grouped under `doc versions`; bounded projection
scan, exact inspection, and one-target repair are grouped under
`doc projection`. Database, graph, Git-Sync, template,
PDF, publishing, and backup operations keep their own command groups rather than
being folded into workspace CRUD.

## File-authored Project creation

`database assistants --actor-user-id <user> --workspace-id <workspace>` lists
admitted Project package identities and typed inputs under that actor's current
read access. `database project` takes the same actor/workspace plus
`--package-id`, `--package-version`, `--package-digest` and `--answers <file>`.
The file is a bounded JSON map of declared tagged native values. Without
`--confirm-plan`, the command prints the canonical plan/digest and writes no
content. Supply that exact digest to `--confirm-plan`, the prepared `--locale`
and a retained UUID `--request-id` only after review. Retry with that same key
and confirmed input; `database project-status` and `database project-stop`
read or stop its optional setup without replacing results. Native
creation repeats admission/authorization and returns the ordinary Project and
its actual selected initial View. Generic creation/import remains independent.

Feature source delivery uses the same native admission as startup:
`templates feature-bundle validate --root <authoring-root> --manifest <manifest>`
or `--archive <archive>`, with repeated `--platform <archive>` for explicit
pinned dependencies. `feature-bundle pack` captures once and writes deterministic
immutable bytes; `--release-base --output <distribution-root>` additionally emits
the release catalog and independent static expectation. `feature-bundle
validate-release --root <generated-template-root> --release-manifest <expectation>`
checks the complete base/optional selection.

`templates recover-release --workspace-id <workspace>` previews explicit recovery
of system sources against the admitted release. Use `--all-workspaces` instead
for bounded native pages and resumable readback. Apply requires `--apply`;
unknown ownership additionally requires single-Workspace operator confirmation
with `--confirm-unmodified-system-documents`. Exact `--orphan-source` and
`--unknown-source` keys also require that confirmation. Neither exact overrides
nor global confirmation are allowed with `--all-workspaces`. Withdrawn slugs are
explicit inputs. Catalog publication/default changes apply globally; document
replacement remains scoped to the selected Workspaces. Native managed sources
update in place; edited sources, reader guides and explicit policy choices remain
protected. Empty suppresses implicit defaults, not explicit managed assignments.
The preview runs before service bootstrap, reads but never applies migrations,
and does not normalize historical configuration. An unsupported/altered ledger
fails closed. Unresolved ownership is printed with a nonzero exit status; check
the status as well as JSON rows before applying. Apply runs the canonical forward
migrations before initializing services.

`templates feature-bundle add-document --root <authoring-root>
--manifest features/base/manifest.yaml --bundle <native-document.zip>
--base-version <next-unpublished-version> --new-workspace-default false --dry-run`
admits an exported workspace page template into the mandatory Basis source
without PostgreSQL or Redis. Remove `--dry-run` to install the immutable child
ZIP and atomically update its component, export and Basis version. New exports
require an explicit `--new-workspace-default true|false`; omission preserves an
existing export's policy. Identical replay is unchanged, conflicting bytes at
the same document identity/version fail, and unrelated declarations/history are
preserved. The command prints the existing generation, packing and validation
commands; it does not activate, publish or push anything. See the
[direct Admin and developer journey](../integrations/document-template-bundles.md#export-an-authored-workspace-template).

`templates validate-source-set --root <generated-template-root>` prepares the
same release-aware selection without PostgreSQL/network access. The packaged
expectation is the default; source development supplies `--release-manifest`.
`--against-root <installed-root>` preserves optional choices and immutable
history. `--optional-catalog` explicitly changes optional selection;
`--prepared-root <fresh-private-directory>` writes only the already captured,
admitted bytes for the existing locked publisher. One catalog rename activates
the result. See [bundle delivery](../integrations/document-template-bundles.md).

## Automation and queued work

Read-only direct-PostgreSQL commands do not need Redis. Commands that make work
actionable for a worker require the configured queue role. For example:

```bash
myoxus-cli automation run-status <run-id>
myoxus-cli automation retry <run-id> --redis-url redis://localhost:6379
myoxus-cli automation disable <automation-id>
myoxus-cli automation dead-letter-list --workspace-id <workspace-id> --json
```

The CLI creates or repairs durable intent; it does not become a second worker.
Retry enqueue failure restores the prior database state before returning a
non-zero exit status.

## JSON output

`--json` is global, but structured output is command-specific. Read commands
with a documented JSON projection support automation; mutations do not share
a universal JSON envelope. Configuration import has its own structured result
as documented in the configuration guide.

Examples of supported read projections:

```bash
myoxus-cli --json users list | jq '.[] | .email'
myoxus-cli --json storage top --n 5
myoxus-cli --json system status
```

MCP exposes the same explicit membership operations as
`organization_unit_member_add`, `organization_unit_member_set_role` and
`organization_unit_member_remove` with UUID targets, exact `write:organization`,
current global-Admin authorization and a mandatory replay key. No ingress writes
a second capability projection.

Document Markdown import/export uses the shared Rust table codec. Exactly one
header row remains GFM; zero, multiple and absent counts use bounded standard
HTML table blocks. Headerless tables retain all body rows, basic cell marks,
links, empty cells, breaks, escaped literal tags and bounded column alignment.
Fresh import may materialize an absent count as zero. This does not mutate the
original snapshot or change untouched Public HTML/PDF legacy fallback.
Complete tables remain successful imports and exports;
unrelated HTML, active attributes, spans, nested tables and arbitrary CSS fail
before document writes. For example:

```markdown
<table><tbody><tr><td><strong>Label</strong></td><td></td></tr><tr><td>first<br>second</td><td>&lt;literal&gt;</td></tr></tbody></table>
```

Use the existing import/export commands and inspect the native table after
re-import; no fake header row or proprietary marker is needed.
