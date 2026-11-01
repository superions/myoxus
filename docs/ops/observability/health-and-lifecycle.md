<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Health and lifecycle

[Documentation](../../README.md) / [Operations](../README.md) / [Observability](./README.md)

This guide connects routine service signals to operator action after
installation. The operator defines inspection cadence, alert thresholds,
retention, and recovery objectives for the deployment.

## Routine checks

| Signal                    | Healthy result                                            | Action when unhealthy                                                                                              |
| ------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/health`                 | Process responds successfully                             | Inspect process or container state and logs.                                                                       |
| `/ready`                  | The stored startup checks passed                          | Follow [Startup and readiness](../runbooks/startup-and-readiness.md); probe dependencies separately after startup. |
| Error and latency metrics | Within the operator's established baseline                | Correlate structured logs and the affected route.                                                                  |
| Worker queues             | Pending and failed counts remain within policy            | Follow [Sync and workers](../runbooks/sync-and-workers.md).                                                        |
| Durable storage           | Free space and provider errors remain within policy       | Follow [Storage and Redis](../runbooks/storage-and-redis.md).                                                      |
| Backup evidence           | The last backup and restore drill satisfy operator policy | Follow [Backup and restore](../data/backup-and-restore.md).                                                        |
| Admin audit               | No unexplained configuration or access changes            | Contain the account and preserve audit evidence.                                                                   |

Review credential expiry, administrator and manager access, database growth,
retention settings, and security advisories at the cadence defined by the
organization's policy.

### Live CLI dependency and queue inspection

`myoxus-cli system doctor` makes bounded live Redis role and queue measurements;
`system status` uses the same probes alongside its PostgreSQL ping. The required
session, queue and lock roles must be configured and reachable. Cache and socket
skip only when unconfigured. These are CLI configuration snapshots, not proof
of which settings a running API has loaded.

`myoxus-cli system queue [--queue <name>]` reads the configured queue role with
the normal TLS policy and producer namespace. A failed or partially degraded
measurement is not an empty queue: all affected count rows are omitted, causes
are reported, successful queues remain visible, and the command exits nonzero.
`system status` also exits nonzero after printing failed measurements. No probe
creates a job or heartbeat. Missing worker-processing evidence is reported as a
warning; empty queues alone are not a worker failure. Inspect real execution
and logs using [Sync and workers](../runbooks/sync-and-workers.md).

`system doctor --external-origin <public-url[/prefix]>` additionally checks
gateway liveness, API readiness/info and the delivered Admin entry routes. It
compares the origin/prefix with the CLI startup projection and `/info.base_url`,
validates JSON and recognizable Admin HTML, and bounds same-origin delivery
redirects before requesting each hop. A gateway `ok`, startup readiness, an
Admin 200 or a login shell never qualifies live worker processing or an
authenticated GUI journey. The check sends no credentials, contacts no IdP and
performs no configuration writes. See [CLI](../administration/cli.md#system) for
deadlines, size limits and the exact route contract.

## Upgrade sequence

1. Identify the exact source and image digests and read their release evidence.
2. Capture a consistent PostgreSQL, blob, and PDF-font checkpoint.
3. Define the readiness and user journeys that accept the rollout.
4. Start the new version through the topology's normal wrapper or orchestrator.
5. Require `/ready`, the API smoke, frontend delivery, and critical Admin flows
   to pass.
6. If validation fails, stop the rollout. Reuse an earlier artifact only when
   it is compatible with the current schema; otherwise restore the checkpoint
   into an isolated environment before changing production state.

## Incident entry

| Symptom                                      | Owner                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| API does not start or readiness is red       | [Startup and readiness](../runbooks/startup-and-readiness.md)                                   |
| Queue backlog, jobs, or synchronization fail | [Sync and workers](../runbooks/sync-and-workers.md)                                             |
| Search or Copilot is incomplete              | [Search](../runbooks/search.md) and [Copilot embeddings](../integrations/copilot-embeddings.md) |
| Git Sync or Calendar fails                   | [Git Sync](../integrations/git-sync.md) or [Calendar](../integrations/calendar.md)              |
| Logs exhaust storage                         | [Logging](./logging.md) and [Log rotation](../runbooks/log-rotation.md)                         |
| Blob or Redis access fails                   | [Storage and Redis](../runbooks/storage-and-redis.md)                                           |

Maintain the deployment decision, public origin, dependency endpoints, backup
and restore evidence, identity providers, administrator access reviews, and
upgrade/rollback evidence in the operator's secured operations system—not in
the source repository.
