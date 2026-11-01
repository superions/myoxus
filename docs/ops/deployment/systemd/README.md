# Manual installation on a Linux host or VM

[Documentation](../../../README.md) / [Operations](../../README.md) / [Deployment](../README.md)

This procedure builds Myoxus from source and installs it directly on a Linux
VM or physical host. The example uses Debian/Ubuntu package names and systemd
for service management. It is a manual installation, not a DEB/RPM installation.

Read the [deployment overview](../../getting-started/installation-decision.md)
for topology diagrams and the current package-build status. Provision runtime
resources from [Sizing](../sizing.md), and allow separate capacity for compiling.

The deployable examples beside this guide are
[`myoxus-api.service`](./myoxus-api.service) and
[`myoxus.env.example`](./myoxus.env.example). Copy them to the platform's
systemd and configuration locations only after reviewing every path and secret
reference.

---

<details>
<summary>On this page</summary>

- [Prerequisites](#prerequisites)
- [Step 1: install build dependencies](#step-1-install-build-dependencies)
- [Step 2: build the binary](#step-2-build-the-binary)
- [Step 3: create system user and directories](#step-3-create-system-user-and-directories)
- [Step 4: install the binary and supporting files](#step-4-install-the-binary-and-supporting-files)
- [Step 5: create the configuration file](#step-5-create-the-configuration-file)
- [Step 6: create the environment file](#step-6-create-the-environment-file)
- [Step 7: verify PostgreSQL and Redis](#step-7-verify-postgresql-and-redis)
- [Step 8: database migrations](#step-8-database-migrations)
- [Step 9: install the systemd service](#step-9-install-the-systemd-service)
- [Step 10: start and verify](#step-10-start-and-verify)
- [Log rotation](#log-rotation)
- [Service management](#service-management)
- [Upgrading](#upgrading)
- [Health check monitoring](#health-check-monitoring)

</details>

## Prerequisites

- A systemd-based Linux distribution with Debian-compatible package names for
  the commands below; adapt package installation and paths on other distributions
- PostgreSQL **16** with the `vector` extension available to the Myoxus
  database owner
- The Rust toolchain selected by the checked-out `rust-toolchain.toml`
- Build dependencies: `pkg-config`, `libssl-dev`, `ca-certificates`
- Runtime tools: `git` for Git sync and `curl` for the supplied health script
- Redis 8+ (**required** — the server will not start without a reachable Redis instance)

---

## Step 1: install build dependencies

```bash
sudo apt-get update
sudo apt-get install -y pkg-config libssl-dev ca-certificates curl git build-essential
```

Install Rust if not already installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup show
```

---

## Step 2: build the binary

From the repository root:

```bash
build/scripts/test/cargo-diagnostic.sh --timeout-seconds 1800 -- \
  build --locked --release --bins --manifest-path server/Cargo.toml \
  -p myoxus-api -p myoxus-cli -p myoxus-pdf-export
```

The outputs are `server/target/release/server`, `server/target/release/myoxus-cli`
and `server/target/release/myoxus-pdf-compiler`. The API locates its PDF compiler
beside its own executable; install both in the same directory. PDF compiler
memory isolation requires 64-bit Linux.

---

## Step 3: create system user and directories

```bash
# On a new host, create the service group and non-login user.
sudo groupadd --system myoxus
sudo useradd --system --gid myoxus --no-create-home --shell /usr/sbin/nologin myoxus

# Create application directories
sudo install -d -m 755 -o myoxus -g myoxus /opt/myoxus
sudo install -d -m 755 -o myoxus -g myoxus /opt/myoxus/config
sudo install -d -m 750 -o myoxus -g myoxus /opt/myoxus/storage
sudo install -d -m 750 -o myoxus -g myoxus /opt/myoxus/logs
sudo install -d -m 750 -o myoxus -g myoxus /opt/myoxus/git-sync
sudo install -d -m 750 -o myoxus -g myoxus /opt/myoxus/pdf-fonts
sudo install -d -m 750 -o myoxus -g myoxus /opt/myoxus/public

# Create the environment directory
sudo install -d -m 755 /etc/myoxus
```

---

## Step 4: install the binary and supporting files

```bash
# Install binary
sudo install -m 755 server/target/release/server /usr/local/bin/myoxus-server
sudo install -m 755 server/target/release/myoxus-cli /usr/local/bin/myoxus-cli
sudo install -m 755 server/target/release/myoxus-pdf-compiler /usr/local/bin/myoxus-pdf-compiler

# Install configuration defaults without changing an existing runtime local.yaml
sudo install -d -m 755 -o myoxus -g myoxus /opt/myoxus/config
sudo install -m 644 -o myoxus -g myoxus \
  server/config/default.yaml \
  server/config/features.user.yaml \
  server/config/features.workspace.yaml \
  /opt/myoxus/config/

# Install matching release static assets (theme catalog, ICC profiles, branding)
sudo install -d -m 755 /opt/myoxus/static
sudo cp -r server/static/. /opt/myoxus/static/

# Install email templates
sudo install -d -m 755 -o myoxus -g myoxus /opt/myoxus/templates
sudo cp -r server/templates/. /opt/myoxus/templates/
sudo chown -R myoxus:myoxus /opt/myoxus/templates

# Install helper scripts
sudo install -d -m 755 /opt/myoxus/scripts
sudo cp build/scripts/server/check-health.sh /opt/myoxus/scripts/
sudo chmod +x /opt/myoxus/scripts/*.sh
```

The recursive ownership change applies only to the templates copied in this
step. Do not recursively change `/opt/myoxus`: its data
directories may contain restored state with deliberately preserved ownership.

---

## Step 5: create the configuration file

```bash
sudo install -m 640 -o myoxus -g myoxus /dev/null /opt/myoxus/config/local.yaml
sudoedit /opt/myoxus/config/local.yaml
```

Edit `/opt/myoxus/config/local.yaml` and set non-sensitive values at minimum:

```yaml
server:
  origin: "https://myoxus.example.com"

storage:
  backend: "local"
  root: "/opt/myoxus/storage"
  pdf_fonts:
    driver: "opendal"
    opendal:
      backend: "fs"
      root: "/opt/myoxus/pdf-fonts"

git_sync:
  repo_base_dir: "/opt/myoxus/git-sync"

public_publishing:
  static_export_root: "/opt/myoxus/public"

logging:
  level: "info"
  file_path: "/opt/myoxus/logs/myoxus.log"
  rotation: "daily"
  max_files: 14
```

The next step supplies the database URL and crypto key through protected files.
Set both before the first start; the defaults are for development. The crypto
key encrypts integration credentials and signs document cursors. Keep it with
the recovery material: there is no general in-place key-rotation workflow.

See the [configuration reference](../../configuration/reference.md) for all
available options.

---

## Step 6: create the environment file

The systemd unit reads `/etc/myoxus/myoxus.env`. Install the reviewed example,
create the application-encryption key, and enter the provisioned database URL through
`sudoedit` so neither credential enters shell history:

```bash
sudo install -m 640 -o root -g myoxus \
  docs/ops/deployment/systemd/myoxus.env.example /etc/myoxus/myoxus.env
sudo sh -c 'umask 027; openssl rand -hex 32 > /etc/myoxus/crypto-private-key'
sudo install -m 640 -o root -g myoxus /dev/null /etc/myoxus/database-url
sudoedit /etc/myoxus/database-url
sudo chmod 640 /etc/myoxus/myoxus.env /etc/myoxus/crypto-private-key /etc/myoxus/database-url
sudo chown root:myoxus /etc/myoxus/myoxus.env /etc/myoxus/crypto-private-key /etc/myoxus/database-url
```

Set `/etc/myoxus/database-url` to the complete URL of a dedicated, empty
PostgreSQL 16 database. Keep both secret files owned by `root:myoxus`, mode
`0640`. `MYOXUS__CONFIG__WRITEBACK_PATH` selects `local.yaml` for Admin writeback.
The service account must be able to write both that file and its directory
because writeback uses a temporary file and rename.

---

## Step 7: verify PostgreSQL and Redis

```bash
# Verify that the local database listener is reachable without exposing the
# database URL. Startup readiness performs the authenticated check.
pg_isready -h 127.0.0.1 -p 5432

# Verify Redis through its locally configured authentication mechanism.
redis-cli ping
```

Abort before starting Myoxus if either probe fails. The central migration
runner creates the required `vector` extension and schema; the database owner
must have permission to do so.

---

## Step 8: database migrations

Database migrations are applied automatically by the central Infrastructure
runner when the server starts. No manual migration step is needed. See the
[database and migration runbook](../../runbooks/database-and-migrations.md)
for the supported baseline and release-upgrade states.

---

## Step 9: install the systemd service

The service file is at `docs/ops/deployment/systemd/myoxus-api.service`. Its contents:

```ini
[Unit]
Description=Myoxus API Server
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=myoxus
Group=myoxus
WorkingDirectory=/opt/myoxus
EnvironmentFile=-/etc/myoxus/myoxus.env
ExecStart=/usr/local/bin/myoxus-server
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/myoxus/config /opt/myoxus/storage /opt/myoxus/logs /opt/myoxus/git-sync /opt/myoxus/pdf-fonts /opt/myoxus/public
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

Install and enable it:

```bash
sudo cp docs/ops/deployment/systemd/myoxus-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable myoxus-api
```

---

## Step 10: start and verify

```bash
sudo systemctl start myoxus-api
sudo systemctl status myoxus-api
```

Check logs:

```bash
journalctl -u myoxus-api -f
journalctl -u myoxus-api -n 100
```

Check health endpoints:

```bash
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:3001/ready
```

The `/ready` endpoint returns a JSON object. All checks must show `"status": "pass"`.

Create the first administrator through the one-time setup route exposed by the
frontend or with the installed CLI and protected input files:

```bash
sudo install -m 640 -o root -g myoxus /dev/null \
  /etc/myoxus/initial-admin-password
sudoedit /etc/myoxus/initial-admin-password
sudo -u myoxus myoxus-cli \
  --database-url-file /etc/myoxus/database-url \
  users create --email admin@example.com --name "Myoxus Admin"
sudo -u myoxus myoxus-cli \
  --database-url-file /etc/myoxus/database-url \
  users set-password admin@example.com \
  --password-file /etc/myoxus/initial-admin-password
sudo -u myoxus myoxus-cli \
  --database-url-file /etc/myoxus/database-url \
  users set-admin admin@example.com --admin
```

After a verified login, remove `/etc/myoxus/initial-admin-password` according
to the operator's credential-destruction procedure.

The API service does not serve the Web/Admin static roots. Materialize the two
matching frontend artifacts and configure the Nginx server as described
in [Prebuilt frontend artifacts](../prebuilt-images.md) and
[Reverse proxy and TLS](../reverse-proxy.md).

---

## Log rotation

The server handles its own log file rotation based on `logging.rotation` and `logging.max_files` in the config. journald also captures stdout/stderr separately.

To view journald logs:

```bash
journalctl -u myoxus-api --since "1 hour ago"
journalctl -u myoxus-api --since today
```

Set journald retention and capacity limits through the host's logging policy.
Myoxus does not prescribe a journal size. See the
[log rotation runbook](../../runbooks/log-rotation.md) before changing either
journald or application-file retention.

---

## Service management

```bash
# Start
sudo systemctl start myoxus-api

# Stop (graceful — sends SIGTERM, waits for in-flight requests)
sudo systemctl stop myoxus-api

# Restart after config change
sudo systemctl restart myoxus-api

# Reload (not supported — use restart)
sudo systemctl restart myoxus-api

# Disable autostart
sudo systemctl disable myoxus-api

# View service status
sudo systemctl status myoxus-api

# Live log tail
journalctl -u myoxus-api -f
```

---

## Upgrading

1. Fetch and review the intended source commit in the repository checkout,
   create a verified backup, build all three binaries, and prepare the matching Web
   and Admin artifacts in a new versioned frontend directory. Follow
   [Prebuilt frontend artifacts](../prebuilt-images.md) and verify that both
   frontend identities contain the same reviewed revision before the service
   stop. Retain a versioned copy of the installed release config defaults,
   templates and static assets together with the binary rollback set; these
   must roll back to the same release. Keep operator secrets and `local.yaml`
   outside that release copy:

```bash
git fetch origin
git switch --detach <reviewed-commit>
build/scripts/test/cargo-diagnostic.sh --timeout-seconds 1800 -- \
  build --locked --release --bins --manifest-path server/Cargo.toml \
  -p myoxus-api -p myoxus-cli -p myoxus-pdf-export
```

2. Stop the service, retain all three previous binaries for rollback, install the
   new binaries and matching release config defaults, templates and static
   assets from the reviewed release (Step 4), preserving runtime `local.yaml`,
   secrets and writable data, and start the API while the edge remains in maintenance.
   Migrations are applied automatically at startup:

```bash
sudo systemctl stop myoxus-api
sudo cp -a /usr/local/bin/myoxus-server /usr/local/bin/myoxus-server.previous
sudo cp -a /usr/local/bin/myoxus-cli /usr/local/bin/myoxus-cli.previous
sudo cp -a /usr/local/bin/myoxus-pdf-compiler /usr/local/bin/myoxus-pdf-compiler.previous
sudo install -m 755 server/target/release/server /usr/local/bin/myoxus-server
sudo install -m 755 server/target/release/myoxus-cli /usr/local/bin/myoxus-cli
sudo install -m 755 server/target/release/myoxus-pdf-compiler /usr/local/bin/myoxus-pdf-compiler
sudo systemctl start myoxus-api
```

3. Verify direct API readiness, atomically activate the prepared frontend
   directory through the operator-owned reverse-proxy configuration, and then
   verify public frontend identity, authentication, and the affected functions. If startup fails before a forward-only migration commits, stop
   the service, restore all three previous binaries and their release
   defaults/templates/static assets, retain the previous frontend directory,
   and restart. After a migration commits, follow the documented
   database rollback boundary and restore the matching checkpoint rather than
   starting an older binary against the newer schema.

```bash
curl -fsS http://127.0.0.1:3001/ready
```

---

## Health check monitoring

For monitoring systems (e.g. Prometheus blackbox exporter, uptime monitors):

```bash
# Liveness
curl -fsS http://127.0.0.1:3001/health

# Stored startup-readiness result
curl -fsS http://127.0.0.1:3001/ready

# Using the built-in check script
MYOXUS_BASE_URL=http://127.0.0.1:3001 /opt/myoxus/scripts/check-health.sh health
MYOXUS_BASE_URL=http://127.0.0.1:3001 /opt/myoxus/scripts/check-health.sh ready
```

The health script exits with code 0 on success and non-zero on failure. Because
`/ready` stores the startup result, pair it with continuous PostgreSQL, Redis,
storage, and authenticated request probes for failures that begin after startup.
