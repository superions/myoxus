<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Start here

[Documentation](../../README.md) / [Operations](../README.md) / [Getting started](./README.md)

Use this sequence for a new self-hosted installation. The linked guides contain
the commands and configuration details.

## 1. Choose and size the deployment

The [deployment guide](./installation-decision.md) shows single-host containers,
a direct installation on a Linux VM or physical host, and a cluster with shared
data services. It also explains the current DEB/RPM server-package status.
Use [Sizing](../deployment/sizing.md) to choose an initial resource allocation.

A single API instance can serve multiple users, organizations and workspaces.
Use multiple instances when measured load or availability requirements justify
it, and check the [cluster requirements](../deployment/multi-instance.md) first.

## 2. Install and create the first administrator

Follow [Install Myoxus](./installation.md) for prerequisites, the container or
manual Linux procedure, startup checks and the first administrator account.
Before startup, set the exact public URL, configure TLS and protect the database
and application-encryption secrets. Keep runtime files on persistent storage.

Verify API readiness, Web/Admin delivery and login through the public URL.
Create a document, reload it and check that its content persists. Upload and
retrieve an attachment. If PDF export is needed, export a document and inspect
the result. The [startup runbook](../runbooks/startup-and-readiness.md) explains
how to diagnose a failed first start.

## 3. Configure the installation

| Area           | Initial configuration                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization   | Set the organization name, create the required units and assign managers. See [Organization](../administration/organization.md).                            |
| Authentication | Configure the intended login methods. Test OAuth callbacks against the public URL if OAuth is enabled. See [Authentication](../security/authentication.md). |
| Mail           | Configure SMTP and send a test email before using invitations or magic links. See [System operations](../administration/system-operations.md#1-system).     |
| Storage        | Check the blob and PDF-font paths or buckets, permissions and available capacity. See [Storage](../data/storage.md).                                        |
| AI             | If required, configure the provider and embedding endpoint, then test the enabled functions. See [AI integration](../integrations/ai.md).                   |

Use [System operations](../administration/system-operations.md) for Admin
settings. Set `crypto.private_key` before storing encrypted credentials and
keep it with the protected recovery material. Changing it later requires a
reviewed decrypt/re-encrypt procedure.

## 4. Back up and monitor

Back up PostgreSQL, uploaded files and PDF fonts together with the configuration
and secrets needed for recovery. Restore onto an isolated target and verify
login, documents and attachments before relying on the backup. Follow
[Backup and restore](../data/backup-and-restore.md).

Monitor API and frontend reachability, runtime dependencies, CPU/RAM, free disk,
queue backlog and backup completion. `/ready` reports the stored startup result;
it does not continuously test the database or Redis. See
[Monitoring](../observability/monitoring/README.md) for the ongoing checks.

For updates, return to the installation method's upgrade procedure and read the
[release guide](../release/README.md). Keep a matching database/file checkpoint
and the previous application artifacts available for recovery.
