<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Operations runbooks

[Documentation](../../README.md) / [Operations](../README.md)

Start from the observed symptom. Stop a procedure when its expected signal is
absent; collect logs and state before attempting a broader recovery. A clean
process exit is not proof of recovery—repeat readiness and the affected user
journey.

| Symptom                                                          | Runbook                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| API fails to start, readiness is red, or logs are missing        | [Startup and readiness](./startup-and-readiness.md)         |
| PostgreSQL is unavailable or the migration ledger is rejected    | [Database and migrations](./database-and-migrations.md)     |
| Blob access, disk permissions, uploads, or Redis fail            | [Storage and Redis](./storage-and-redis.md)                 |
| WebSocket sync, cross-instance delivery, queues, or workers fail | [Sync and workers](./sync-and-workers.md)                   |
| Web/Admin routing, cookies, CORS, OIDC, or client state fail     | [Frontend and authentication](./frontend-and-auth.md)       |
| A broader incident needs containment and evidence preservation   | [Incident recovery](./incident-recovery.md)                 |
| Logs need bounded retention                                      | [Log rotation](./log-rotation.md)                           |
| Document lifecycle state needs supported repair                  | [Document lifecycle repair](./document-lifecycle-repair.md) |
| Document synchronization needs protocol-level diagnosis          | [Document synchronization](./document-sync.md)              |
| Search indexing or query behavior is unhealthy                   | [Search](./search.md)                                       |

Integration-specific procedures remain with [Integrations](../integrations/README.md)
so credentials, scopes, disable paths, and recovery are not duplicated.
