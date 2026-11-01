<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Myoxus operations manual

[Documentation](../README.md)

Install, administer and maintain your own Myoxus system. Start with an
installation path, then establish access, data protection and monitoring.
Commands assume the repository root unless a guide specifies another directory.

## Start an installation

| Step              | Guide                                                                                                   | Result                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **1 · Choose**    | [Installation choices](./getting-started/installation-decision.md) and [sizing](./deployment/sizing.md) | A topology and initial resource budget             |
| **2 · Install**   | [Installation](./getting-started/installation.md)                                                       | Running services and the first administrator       |
| **3 · Configure** | [Start here](./getting-started/start-here.md)                                                           | Identity, workspaces, storage and enabled services |
| **4 · Protect**   | [Backups](./data/backup-and-restore.md) and [monitoring](./observability/README.md)                     | Recoverable data and visible service health        |

## Find an operating guide

| Area                                           | Use it for                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| [Getting started](./getting-started/README.md) | Installation choice, prerequisites and first login                 |
| [Deployment](./deployment/README.md)           | Linux/containers, scaling, networking, persistence and upgrades    |
| [Configuration](./configuration/README.md)     | Precedence, secrets, live changes and the complete key reference   |
| [Administration](./administration/README.md)   | Admin frontend, organizations, SSO, workspaces and client controls |
| [Data](./data/README.md)                       | Storage, databases, backup/restore, Typst PDF and HTML publishing  |
| [Integrations](./integrations/README.md)       | Git, calendars, AI, MCP and central templates                      |
| [Observability](./observability/README.md)     | Health, logs, metrics, telemetry, queues and monitoring            |
| [Security](./security/README.md)               | Authentication, CAPTCHA, privacy and security updates              |
| [Runbooks](./runbooks/README.md)               | Diagnosis and recovery by observed symptom                         |
| [Release operations](./release/README.md)      | Artifact identity, provenance, SBOMs and update procedures         |

## Operating essentials

- Back up PostgreSQL, blobs and uploaded PDF fonts at a consistent point. Prove
  recovery in an isolated environment; Redis is rebuildable coordination state.
- Align the public origin, TLS, cookies and OAuth callback URLs.
- Use liveness and startup readiness alongside dependency monitoring to detect
  outages that begin after startup.
- Manage access and product state through Admin, the trusted local CLI and
  documented APIs. Migration history remains owned by the migration runner.
- Keep connection URLs, passwords, session cookies and tokens in protected
  configuration or secret files. CLI examples use the configured container or
  the documented database-URL file.
- Define retention, recovery objectives, maintenance windows and capacity
  thresholds for your organization.

For everyday workspace use, see [User guides](../user/README.md).
