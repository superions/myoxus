<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Privacy operations

[Documentation](../../README.md) / [Operations](../README.md) / [Security operations](./README.md)

This guide maps current Myoxus controls to common privacy operations. It is a
technical inventory, not a certification or legal opinion. The operator is the
owner of legal basis, notices, data-processing agreements, retention, legal
holds, response deadlines, and the final scope of any data-subject request.
For the authoritative EU text, see
[Regulation (EU) 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=en).

<details>
<summary>On this page</summary>

- [Data inventory](#data-inventory)
- [Prepare a request](#prepare-a-request)
- [Access and portability](#access-and-portability)
- [Rectification](#rectification)
- [Erasure](#erasure)
- [Restriction, objection, and telemetry choice](#restriction-objection-and-telemetry-choice)
- [Security and incident response](#security-and-incident-response)
- [Operator checklist](#operator-checklist)

</details>

## Data inventory

| Store or channel                      | Potential personal data                                            | Myoxus control                                            |
| ------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| `users`                               | Name, e-mail address, locale, provider subject                     | Admin UI and `myoxus-cli users`                           |
| `sessions`, access tokens, API keys   | Account link, user agent, IP/session metadata, credential state    | Session/API-key revocation and account suspension         |
| Workspaces, documents, history, blobs | User-authored content and attachments                              | Workspace UI, export, retention, deletion                 |
| Calendar accounts and events          | Provider account data, encrypted credentials, titles and attendees | Account unlinking and calendar operations                 |
| `telemetry_events`                    | User/client/session identifiers and scrubbed event JSON            | Telemetry export, purge, category and master switches     |
| `telemetry_daily`                     | Aggregated daily counters without a `user_id` column               | Configured aggregate retention                            |
| Audit records and application logs    | Actor, target, request and diagnostic metadata                     | Operator retention and access policy                      |
| Backups and external monitoring       | Copies of any included data                                        | Operator-owned encryption, retention and deletion process |

Do not assume that logs are free of personal data merely because secrets and
raw payloads are prohibited. Treat logs, metrics labels, support bundles and
backups according to the fields actually collected in the deployed system.

## Prepare a request

1. Authenticate the requester through the operator's approved process.
2. Resolve the account with `myoxus-cli --json users get
<user-uuid-or-email>` and record the stable UUID without copying secrets.
3. Check legal holds, shared-workspace ownership and the rights of other users
   before exporting or deleting shared content.
4. Work from a protected destination with restricted permissions. Never write
   an export into the repository or application log.
5. Record the request, decision, commands, outputs and verification in the
   operator's case-management system, not in Myoxus source files.

The CLI examples below assume `MYOXUS__DATABASE__URL_FILE` points to the
owner-only database URL file for this installation. Set only that path in the
operator environment; never put the URL itself in an argument or shell
history.

## Access and portability

Export the account record and user-linked telemetry separately:

```bash
export MYOXUS__DATABASE__URL_FILE=/protected/path/database-url
umask 077
myoxus-cli --json users get <user-uuid-or-email> > account.json
myoxus-cli telemetry export-user <user-uuid-or-email> > telemetry.json
```

Export documents and blobs through the normal workspace export flow. Myoxus
does not provide one command that assembles a complete account archive. The
operator must identify every workspace in scope, review shared content and
combine the relevant outputs. Before delivery, inspect the archive for data
belonging to other people and transfer it through the approved secure channel.

Verify the result by parsing every JSON file, comparing the resolved account
UUID, and checking the expected workspace/export inventory. Remove the working
copy according to the case policy after delivery.

## Rectification

Correct profile and document data through the normal authenticated UI or
domain-specific Admin operation. Telemetry events are immutable observations;
if retained telemetry must be removed, purge the user's telemetry and let new
events reflect the corrected product state. Do not edit event or audit rows
directly.

## Erasure

Before account deletion, confirm the request, legal holds, workspace ownership,
required transfers and the backup-retention effect. Capture the account UUID
and a pre-action inventory, then choose the narrowest supported action:

```bash
# Keep the account and remove its raw telemetry events.
myoxus-cli telemetry purge-user <user-uuid-or-email>

# Delete the account after required ownership transfers and explicit review.
myoxus-cli users delete <user-uuid-or-email> --confirm
```

Account deletion cascades user-linked raw telemetry rows. Daily telemetry is
aggregated and has no `user_id`, so it cannot be selected by user. Backups,
audit data and shared content have separate operator-owned retention and legal
boundaries; document these instead of promising immediate removal from every
copy.

After the action, verify that `myoxus-cli --json users get` no longer returns
an active account when deletion was selected, that `telemetry export-user`
returns no retained raw events, and that transferred workspaces remain usable.
Restore from backup only if the operation affected data outside the approved
scope; a restore reintroduces data and therefore requires a new privacy review.

## Restriction, objection, and telemetry choice

The Admin Telemetry page can disable ingestion globally or by category.
Clients can declare telemetry opt-out; accepted opt-out events are discarded
before persistence. `/api/telemetry/status` exposes the effective public
ingestion policy without revealing credentials.

Myoxus does not provide a universal per-user legal-restriction workflow. An
operator may suspend an account, purge raw telemetry or disable a category when
those actions match the approved decision, but must not equate a technical
switch with satisfaction of a legal request without review.

## Security and incident response

- Terminate production traffic with TLS and protect session cookies at the
  reverse proxy and public origin.
- Encrypt PostgreSQL, blob storage, backups and export destinations using the
  operator's platform controls; Myoxus does not claim transparent database
  encryption.
- Restrict database, storage, Admin and monitoring access and review their
  audit trails.
- Rotate exposed credentials through their owning mechanism and revoke active
  sessions with `myoxus-cli sessions revoke --all` when the incident scope
  requires it.
- Preserve the incident timeline and assess notification obligations under the
  applicable law. GDPR Article 33 uses a risk-based notification rule and a
  72-hour target where notification is required; the operator or counsel must
  make that determination.

Follow [Incident recovery](../runbooks/incident-recovery.md) for service
containment and [Backup and restore](../data/backup-and-restore.md) for
evidence-preserving recovery.

## Operator checklist

- [ ] Data inventory matches enabled providers, integrations and monitoring.
- [ ] Legal basis, notices, processors, recipients and retention are approved.
- [ ] Telemetry master/category switches and client opt-out were exercised.
- [ ] Account, telemetry and workspace exports were tested on synthetic data.
- [ ] Deletion was tested together with ownership transfer and restore policy.
- [ ] Audit, log, metric, backup and support-bundle retention is documented.
- [ ] Export destinations are encrypted, access-controlled and cleaned up.
- [ ] Incident contacts and applicable notification process are current.

Related technical owners:

- [Telemetry operations](../observability/telemetry.md)
- [Authentication and credential controls](./authentication.md)
- [Storage ownership](../data/storage.md)
- [Logging](../observability/logging.md)
