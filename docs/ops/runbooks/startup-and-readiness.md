# Startup and readiness troubleshooting

[Documentation](../../README.md) / [Operations](../README.md) / [Operations runbooks](./README.md)

Find the dependency or startup check preventing readiness, and confirm recovery before returning traffic.

<details>
<summary>On this page</summary>

- [Startup failures](#startup-failures)
- [Logging issues](#logging-issues)
- [Log level diagnosis](#log-level-diagnosis)
- [Using the health check script](#using-the-health-check-script)

</details>

## Startup failures

### `/ready` returns 503 or server exits immediately

The server performs startup checks on launch. If any check fails, the process exits with a non-zero code. Look at the logs first:

```bash
# Docker
docker compose -f build/server/docker-compose.selfhost.yml logs api

# systemd
journalctl -u myoxus-api -n 200

# Check /health and /ready for detailed check results
curl -sS http://localhost:3001/health
curl -sS http://localhost:3001/ready
```

The `/ready` response includes a `checks` array identifying which check failed and why.

---

## Logging issues

### No log file appearing

- `logging.file_path` must be set in the config. If it is `null` (the default), logs go to stdout only.
- The complete directory path is created automatically. Its nearest existing
  parent must be writable by the server user.
- In Docker, the log directory is mounted from the host — check the mount:
  ```bash
  docker compose -f build/server/docker-compose.selfhost.yml exec api \
    ls -la /opt/myoxus/data/logs
  ```

### Adjusting log verbosity

To increase log detail for the next process start:

- Set `RUST_LOG=debug` in the process environment or add it to
  `/etc/myoxus/myoxus.env`, then restart the service.
- `RUST_LOG` overrides `logging.level` and supports per-module filtering: `RUST_LOG=myoxus_api=debug,myoxus_infrastructure=info`

### Journald: logs missing

If the API writes logs to a file but they do not appear in `journalctl`:

- stdout is always captured by journald, regardless of file logging.
- Both sinks (stdout and file) are active when `logging.file_path` is set.
- If journald entries are absent, check that the systemd service is running (`systemctl status myoxus-api`).

---

## Log level diagnosis

### Increase verbosity for a specific subsystem at runtime

No restart is needed. Use **Admin > System > Logging** or submit the following
GraphQL operation through an authenticated Admin client that already applies
the session-cookie and CSRF double-submit contract:

```graphql
mutation EnableTemporaryAuthDebug {
  admin {
    updateLogModuleLevel(input: { group: "auth", level: "DEBUG", autoRevertMinutes: 15 }) {
      group
      level
    }
  }
}
```

Available groups: `api`, `websocket`, `auth`, `database`, `sync_protocol`,
`workers`, `copilot`, `mcp`, `public_publishing`, `git_sync`, `storage`,
`http_internals`, and `template_registry`.

See [logging.md](../observability/logging.md) for the full logging operations guide.

### Diagnosing startup without running stack

Set `RUST_LOG=debug` before starting:

```bash
(cd server && RUST_LOG=debug cargo run -p myoxus-api --bin server)
```

Or for the repository development stack:

```bash
MYOXUS_LOG_LEVEL=debug build/scripts/server/stack-rebuild-api.sh
```

This wrapper projects `MYOXUS_LOG_LEVEL` into the API container as
`MYOXUS__LOGGING__LEVEL`. For a deployed Compose file, set `RUST_LOG` or
`MYOXUS__LOGGING__LEVEL` in the API service environment and recreate that
service. Remove the temporary override after diagnosis.

---

## Using the health check script

The built-in health check script provides a structured report:

```bash
# Quick liveness check
./build/scripts/server/check-health.sh health

# Full readiness check (all startup checks)
./build/scripts/server/check-health.sh ready

# Override base URL
MYOXUS_BASE_URL=http://127.0.0.1:3001 ./build/scripts/server/check-health.sh ready
```

The script exits 0 on success, 1 on failure — usable in monitoring scripts.
