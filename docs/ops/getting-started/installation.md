<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Install Myoxus

[Documentation](../../README.md) / [Operations](../README.md) / [Getting started](./README.md)

Choose the [installation method and topology](./installation-decision.md), then
provision CPU, RAM and disk using [Sizing](../deployment/sizing.md).

<details>
<summary>On this page</summary>

- [Prerequisites](#prerequisites)
- [Container installation](#container-installation)
- [Native server packages](#native-server-packages)
- [Manual Linux installation](#manual-linux-installation)
- [Startup and migrations](#startup-and-migrations)
- [First administrator](#first-administrator)
- [Verify the installation](#verify-the-installation)
- [Local source evaluation](#local-source-evaluation)

</details>

## Prerequisites

For a server installation, provide:

- PostgreSQL 16 with pgvector available; the database owner must be permitted
  to create the `vector` extension and apply migrations;
- Redis 8 and private network access from the API;
- persistent blob storage and a persistent PDF-font backend;
- a public DNS name and HTTPS reverse proxy;
- protected database and application-encryption secrets;
- persistent runtime configuration and branding;
- backup storage on a separate system.

PostgreSQL and Redis can run on the application host or as separate services.
A multi-host cluster needs shared file storage as described in the
[cluster guide](../deployment/multi-instance.md).

## Container installation

Follow [Deploy published Myoxus images](../deployment/docker.md#deploy-published-myoxus-images).
That procedure downloads the deployment bundle, extracts Web/Admin files,
creates state directories and secrets, and starts the Compose stack.
It requires Docker and Compose, but no source build.

Select immutable server and frontend versions. Set `MYOXUS_SERVER_ORIGIN` to
the exact external origin, configure TLS, and restrict published database,
Redis and direct API ports. On an upgrade, create a recovery checkpoint before
starting the new version.

## Native server packages

Server DEB/APT and RPM packages for Linux x86_64 are available in
[Myoxus 0.41.38](https://github.com/superions/myoxus/releases/tag/v0.41.38).
Both formats use the same server bundle. Existing package installation, dependency,
permission, reinstall and removal checks passed on Ubuntu 24.04 (DEB) and
Fedora 44 (RPM). See the [package status](./installation-decision.md#distribution-packages).
Use **SERVER-PACKAGES-SHA256SUMS** for the native packages and native SBOM;
**GITHUB-SHA256SUMS** covers the original container/source release files.

When a release lists a package for your distribution, download it from that
release and verify its checksum. Install the **server** package using the native
package manager (replace `VERSION` with its actual filename version):

```bash
# Debian / Ubuntu
sudo apt install ./myoxus-server_VERSION_amd64.deb
# Fedora 44
sudo dnf install ./myoxus-server-VERSION-1.x86_64.rpm
# An explicitly supported openSUSE target
sudo zypper install ./myoxus-server-VERSION-1.x86_64.rpm
```

Packages provide the API, CLI, PDF compiler and server runtime assets. Supply
PostgreSQL 16 with pgvector, Redis 8, matching Web/Admin delivery and TLS
separately. Installation creates the service account and directories; it does
not start the server or run migrations.

Configure the connection details, public origin and encryption key in
`/etc/myoxus/local.yaml`; `/etc/myoxus/myoxus.env` can select protected secret
files. Then start the service:

```bash
sudo systemctl enable --now myoxus-api
curl -fsS http://127.0.0.1:3001/ready
```

Admin writeback uses `/var/lib/myoxus/runtime-config/local.yaml`. Uploaded files,
PDF fonts, branding and Git mirrors also stay under `/var/lib/myoxus`; logs use
`/var/log/myoxus`. Package-owned assets under `/usr/share/myoxus` are read-only
to the service. Original license notices and SBOM are installed under
`/usr/share/doc/myoxus-server`.

For an update, create a [complete checkpoint](../data/backup-and-restore.md),
stop `myoxus-api`, install the new package and start the service again. Existing
operator configuration and runtime data are retained. Removing the package
also retains those files; manage their deletion separately.

## Manual Linux installation

Follow [Manual installation on a Linux host or VM](../deployment/systemd/README.md).
That procedure builds and installs the server, CLI and PDF compiler, copies the
runtime assets, configures permissions and secrets, and starts the API service.
It also links frontend and reverse-proxy setup. Source builds need Rust and
build dependencies; local frontend builds need Node.js 26 and Yarn 4.18.0.
Build resources are additional to the server's runtime allocation.

This source procedure is an alternative to the published native packages.
Server and Electron desktop packages have separate installation roles.

## Startup and migrations

The API applies migrations at startup. There is no separate migration container
or manual SQL step. Fresh databases start at baseline `1000`; existing databases
on that baseline follow the append-only migration chain. Unsupported or altered
migration ledgers fail before readiness. Follow the
[database runbook](../runbooks/database-and-migrations.md) rather than editing
`_sqlx_migrations`.

After startup, check the API and frontend listeners. For the default container
port mappings:

```bash
curl -fsS http://localhost:3001/health
curl -fsS http://localhost:3001/ready
curl -fsS http://localhost:3010/health
curl -fsS http://localhost:3010/info
```

Also check the public HTTPS URL. Confirm that Web and Admin report the selected
frontend revision. `/ready` reports startup checks, not continuous dependency
health. Use the [startup runbook](../runbooks/startup-and-readiness.md) if it fails.

## First administrator

For a new production installation, use the one-time Admin setup route while it
is available:

```text
https://myoxus.example.com/adminfrontend/setup
```

Alternatively, use the installed `myoxus-cli` with its database URL file:

```bash
myoxus-cli --database-url-file /etc/myoxus/database-url users create \
  --email admin@example.com \
  --name "Myoxus Admin"
myoxus-cli --database-url-file /etc/myoxus/database-url users set-password \
  admin@example.com \
  --password-file /run/secrets/myoxus-initial-admin-password
myoxus-cli --database-url-file /etc/myoxus/database-url users set-admin \
  admin@example.com --admin
```

Remove the initial password file according to the operator's credential
procedure after the login has been verified. Never pass a password or database
URL as a command-line value.

## Verify the installation

- Sign in through the public URL and open Admin.
- Confirm that `server.origin` matches that URL and that WebSocket connections
  work through the reverse proxy.
- Create a document and attachment, then reload and retrieve both.
- Check a PDF export if exports will be used.
- Verify persistent data/configuration paths and service permissions.
- Restore a backup on an isolated target and inspect the restored data.

Continue with [Start Here](./start-here.md#3-configure-the-installation) to
configure organization, authentication, mail and monitoring.

## Local source evaluation

This path is for a clean checkout on a development host. It builds the server,
Web, and Admin artifacts, starts PostgreSQL and Redis, creates local-only
secret files, and bootstraps the synthetic administrator printed by the
wrapper.

From the repository root:

```bash
yarn install
MYOXUS_SERVER_ORIGIN=http://localhost:3010 \
  build/scripts/server/stack-up.sh
build/scripts/server/stack-status.sh
build/scripts/server/smoke-api.sh --quick
```

Expected endpoints:

```text
Web and Admin: http://localhost:3010
Admin:         http://localhost:3010/adminfrontend/
API:           http://localhost:3001
```

Verify all three tiers:

```bash
curl -fsS http://localhost:3001/health
curl -fsS http://localhost:3001/ready
curl -fsS http://localhost:3010/health
curl -fsS http://localhost:3010/info
```

`/ready` must report a passing status. The wrapper's printed administrator is
synthetic local data. Stop the stack without deleting data with:

```bash
build/scripts/server/stack-down.sh
```

Use the guarded clean-slate procedure in the
[Docker guide](../deployment/docker.md#uninstall-or-clean-slate-reset) only
when the named volumes are intentionally disposable.
