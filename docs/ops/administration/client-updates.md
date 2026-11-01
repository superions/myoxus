# Browser client update control

[Documentation](../../README.md) / [Operations](../README.md) / [Administration](./README.md)

Use the client update control plane when a deployment requires Browser Web
clients to reduce or stop automatic data traffic, reload onto a new frontend,
or discard only their synchronized Cloud working copies. It is an operator
fence, not a deployment orchestrator: it neither deploys artifacts nor tracks
individual browsers.

<details>
<summary>On this page</summary>

- [Preconditions](#preconditions)
- [Standard update](#standard-update)
- [Cache synchronization policy cutover](#cache-synchronization-policy-cutover)
- [Failure and abort](#failure-and-abort)
- [Browser semantics](#browser-semantics)
- [Operational verification](#operational-verification)
- [Rollback](#rollback)

</details>

## Preconditions

- Run `myoxus-cli` with the normal trusted PostgreSQL configuration. In the
  packaged deployment it is available inside the API container.
- Generate one UUID for the complete operation. Every transition in that
  operation must use the same value.
- Verify the current state before changing it:

```bash
myoxus-cli client-update status --json
operation_id="$(uuidgen)"
```

Do not begin a second operation while another operation is active. A
conflicting operation ID is rejected without a partial write.

## Standard update

Reduce background retries before changing the deployment:

```bash
myoxus-cli client-update limit-retry \
  --operation-id "$operation_id" \
  --max-attempts 2 \
  --retry-after-ms 5000
myoxus-cli client-update status --json
```

When no further automatic Browser Web data attempt is safe, suspend it:

```bash
myoxus-cli client-update no-retry --operation-id "$operation_id"
myoxus-cli client-update status --json
```

Deploy and migrate through the topology's normal release procedure. After the
new API and frontend are healthy, select exactly one completion action:

```bash
# No browser-side completion action:
myoxus-cli client-update update-success \
  --operation-id "$operation_id" --action none

# Update the service worker and reload each visible tab once:
myoxus-cli client-update update-success \
  --operation-id "$operation_id" --action reload

# Delete only synchronized, registered Browser Web Cloud working copies:
myoxus-cli client-update update-success \
  --operation-id "$operation_id" --action reset-local-cache
```

Use `--required-web-build-id <build-id>` with `reload` when completion must wait
until the active service worker reports a specific build. Always inspect the
final state:

```bash
myoxus-cli client-update status --json
```

## Cache synchronization policy cutover

When deploying a frontend that replaces IndexedDB document leases with atomic
transactions, retire every older Browser Web storage worker for that browser
and origin before reopening the fixed bundle against the preserved cache.
First acknowledge pending document and workspace writes and outstanding uploads.
Close all tabs for that origin; a full browser restart without deleting data is
the bounded way to retire workers pinned by hidden tabs or other open clients.
Then reopen the matching fixed frontend and verify saved content after reload.
Do not run old lease-based and new transactional writers concurrently.

The existing `reload` completion action updates visible clients; server update
completion does not count individual browsers or prove hidden-tab worker
retirement. Keep the normal deployment/update-control procedure and verify the
actual frontend and storage-worker identities. This cutover keeps the existing
IndexedDB schema and data, including inert legacy lease records; it requires no
cache reset or database migration.

## Failure and abort

If deployment completed unsuccessfully and automatic retries must stay
disabled:

```bash
myoxus-cli client-update update-failed --operation-id "$operation_id"
```

`failed` is intentionally retry-free. It remains visible until the same
operation is aborted or superseded through a valid transition. Use abort only
when returning Browser Web to normal operation is safe:

```bash
myoxus-cli client-update update-abort --operation-id "$operation_id"
```

The CLI commits PostgreSQL state before publishing a wake-up. A wake-up failure
therefore returns a non-successful CLI result but does not roll back committed
state. Check `status --json`; clients converge through their cache-free control
read, reconnect/online read, or sparse active-state poll.

## Browser semantics

- `limited` shows a non-blocking warning and applies the operation's retry
  budget independently in each Browser Web runtime.
- `suspended` and `failed` replace product routes with a global blocking
  surface. New Browser Web data sockets are rejected; native clients are not
  affected.
- `reload` reloads a visible tab once. A hidden tab waits until its next
  visible transition.
- `reset-local-cache` first waits for confirmed document and blob
  synchronization. It then closes and deletes only exact, endpoint-registered
  Browser Web Cloud IndexedDB names.
- A blocked or failed delete retains the durable cache-epoch fence. Retry from
  the visible error surface or restart the browser; the next boot resumes the
  same idempotent reset.
- No browser acknowledgement, target list, command history or per-browser
  completion state exists. Do not wait for one.

## Operational verification

After a production deployment, verify API/frontend health, open an existing
workspace in two tabs, and confirm the chosen visible behavior. Review browser
console, page and worker errors. The control query and response are explicitly
`no-store`; cached or browser-invented desired state is not valid evidence.

## Rollback

The control plane does not make schema or data rollback safe. Decide database
rollback from the migration and backup contract of the deployment topology.
If the previous frontend remains compatible, deploy it through the normal
release path and complete the active operation with `reload`. If safety is
uncertain, keep the operation `failed` and restore from the documented
recovery point before returning clients to `normal`.
