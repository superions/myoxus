<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Security updates

[Documentation](../../README.md) / [Operations](../README.md) / [Security operations](./README.md)

Myoxus pins Rust and JavaScript dependencies in committed lockfiles and ships
separate server, frontend, and Electron runtime closures. The operator owns the
review cadence, severity policy, deployment window, and accepted-risk process.

## Repository-owned checks

Run the checks from a clean checkout of the candidate commit:

```bash
build/scripts/ci/cargo-audit-local.sh
build/scripts/ci/yarn-audit-local.sh
# Linux CI/diagnostic host: no product compilation required
bash build/scripts/ci/scan-server-dependencies.sh server/Cargo.lock dist/container-security
```

Review findings against the exact versions in `server/Cargo.lock`, the root
`Cargo.lock`, and `yarn.lock`. An advisory is relevant only when the affected
version and vulnerable path are present, but a dismissal requires recorded
technical evidence.

Container releases require a passing High/Critical Rust dependency scan before
any image build. Scanner/database errors also fail closed. RustSec and GHSA
coverage differ; a green `cargo audit` alone does not establish that a container
is free of known vulnerabilities. This preflight does not scan OS packages.
Release builds resolve current upstream base images with `--pull`; Debian package
findings must be evaluated against Debian's security tracker and available stable
updates, not dismissed because the base image is current.

## Triage and response

1. Record the advisory identifier, affected component, installed version, and
   source commit.
2. Determine whether the vulnerable path is reachable in Server, Web, Admin,
   Electron, build tooling, or tests.
3. Apply the organization's severity and deployment policy. Myoxus does not
   define response-time targets for the operator.
4. Update the direct dependency owner and regenerate the canonical lockfile.
5. Run the changed-path matrix and the owning runtime/package gate.
6. Build a complete candidate from one source commit; do not publish a partial
   server/frontend or Electron artifact set.
7. Re-run both audit scripts and retain the release evidence with the candidate.

Do not suppress a finding merely to make the audit green. A suppression must
name the advisory, explain why the shipped path is not affected, identify the
reviewer and expiry condition, and live in the audit tool's existing policy
file.

## High-risk dependency families

- DOMPurify changes require the existing XSS payload tests and consuming
  frontend gates because the editor renders user-controlled HTML.
- Yjs and the Rust `yrs` implementation require the repository compatibility
  gate because client and server share a synchronization protocol.
- Electron updates require the complete packaged runtime closure, native-module
  loading, sandbox, and package-install evidence described in
  [Electron update cadence](../release/electron-update-cadence.md).

## Verification and rollback

Before deployment, verify the patched version in the generated SBOM and the
runtime artifact itself. After deployment, repeat readiness and the affected
user journey. Roll back only to a previously verified artifact that is not
affected by the same advisory and is compatible with the current database
schema. Database restore requirements are documented in
[Backup and restore](../data/backup-and-restore.md).
