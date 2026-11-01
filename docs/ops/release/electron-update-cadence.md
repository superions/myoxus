# Electron patch cadence

[Documentation](../../README.md) / [Operations](../README.md) / [Release operations](./README.md)

This runbook separates urgent Electron security maintenance from normal
dependency maintenance. The current runtime is Electron `44.5.0`; a future
major cutover is a reviewed migration with its own compatibility and packaging
evidence.

<details>
<summary>On this page</summary>

- [Update lanes](#update-lanes)
- [Patch procedure](#patch-procedure)
- [Major update additions](#major-update-additions)
- [Forgejo renovate operation](#forgejo-renovate-operation)
- [Incident rule](#incident-rule)

</details>

## Update lanes

| Update                                           | Cadence           | Automation                                                              | Required review                                                       |
| ------------------------------------------------ | ----------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Security advisory affecting the Electron closure | Immediately       | Renovate native alert priority, label `security`, unrestricted schedule | Advisory path, release blocker, Electron tests, packaged smoke        |
| Electron-family patch or minor                   | Daily             | Renovate daily Electron group                                           | Release notes, lock diff, Electron tests                              |
| Electron major                                   | Monthly discovery | Renovate monthly major group, never automerge                           | Chromium/Node changes, native bindings, packaging and platform matrix |
| Lockfile maintenance                             | Monthly           | Renovate                                                                | Closure report and changed-path matrix                                |

Security updates do not wait for the daily or monthly Electron groups.
Renovate may open the change, but it never automerges Electron updates.

## Patch procedure

1. Read the Electron release notes and linked Chromium security notes.
2. Update the exact Electron version in every direct manifest owner and
   regenerate `yarn.lock` with Yarn 4. Do not leave mixed Root/Electron
   versions.
3. Require the Forgejo `dependency-health.yml` workflow. Its strict release
   and Electron closure policies must pass without an advisory allowlist.
4. Require the Forgejo `electron-packaging.yml` workflow. It owns Electron and
   Renderer tests plus real unsigned Linux, macOS and Windows packages on their
   platform runners. Local Electron builds and tests are diagnostics only and
   are not acceptance evidence.
5. In CI, build one unsigned package for each supported platform. Linux acceptance must
   install the exact production artifact through the native package manager,
   not run an unpacked stage or an `ELECTRON_E2E=1` twin. Verify the exact
   Electron, Chromium, and Node versions; Main, Preload, and Helper startup;
   and loading of `@myoxus/crypto`, `@myoxus/media-capture`, and
   `@myoxus/local-store` with the packaged Electron runtime.
6. Inspect application and renderer logs. A process crash, console error,
   missing native module, or stale Electron locator blocks the update.
7. Record commands, versions, platform/architecture, and artifact hashes in
   the release evidence for the inspected source commit.

Direct `@electron/packager` application bundling and native distribution
packaging share one build context, one immutable stage and one
atomic artifact contract. A patch is not accepted if either layer rebuilds a
different source tree, publishes partial output, or emits a
Squirrel/NUPKG/RELEASES artifact.

## Major update additions

A major update also requires:

- the Electron migration guides for every crossed major;
- Chromium feature-policy and sandbox review;
- bundled Node and native N-API compatibility review;
- Main/Preload IPC contract review;
- all supported package formats and update metadata;
- verification of the selected platform's declared signature mode on its owning
  runner; Developer ID/notarization and Windows Authenticode remain requirements
  of the separately selected signed-full release, not regular ad-hoc/unsigned
  platform publication;
- Linux sandbox and package-install verification;
- a rollback decision before publishing.

Flatpak runtime, Electron base-app, or Zypak updates are separate package
compatibility changes. They must rebuild the complete DEB/RPM/Flatpak set on
the Debian CI runner and repeat the Flatpak manifest, permission allowlist,
portal configuration, Chromium sandbox, SBOM, and package-metadata checks
before merge.

Do not hide a major update inside a security patch or lockfile refresh.

## Forgejo renovate operation

`.forgejo/workflows/renovate.yml` supports scheduled and manual runs. It uses
the restricted `myoxus-renovate` credential and a digest-pinned Renovate image.
A missing token is a hard failure. The resulting Dependency Dashboard is the
operator-visible queue for blocked and pending updates.

Renovate receives source-repository write access only. Release and container
publishing credentials are forbidden in this workflow. Desktop publishing to
`myoxus/packages` remains a separate release responsibility.

## Incident rule

A High or Critical advisory that reaches `runtime`, `release-build`, or
`mandatory-test` blocks Electron releases immediately. There is no temporary
allowlist. If no compatible patch exists, stop the release and either update
the owning parent through a reviewed migration or remove the vulnerable path.

Stable, Beta and Internal use identical automatic-check/download defaults and
honour device preferences. Internal has no channel-specific disablement in normal
released builds. Development, external Flatpak management and portable Windows
packages remain unavailable to the native updater. About and menu controls show
that availability; sidebar retry depends on active download progress rather than
the automatic-download preference. A failed download is idle with an error and
can be retried; newly opened consumers read the current Main snapshot.

The current `release-desktop.yml` N/N+1 jobs run only for `scope=full`.
Its macOS update wrapper requires the Apple signing/notarization environment,
while regular macOS publication deliberately emits ad-hoc packages without it.
A successful regular package publication therefore does not establish a working
macOS native update. Keep packaging, signature state and actual installation
evidence separate; a downloaded artifact is not the running application version.
