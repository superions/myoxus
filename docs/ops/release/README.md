<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Release downloads and verification

[Documentation](../../README.md) / [Operations](../README.md)

**[Myoxus releases on GitHub →](https://github.com/superions/myoxus/releases)**

GitHub provides the public release downloads, source, checksums and installation
entry points. The [download overview](../../user/downloads.md) records which
container, native server and desktop distributions are actually available.
Myoxus is beta software; an artifact channel named Stable does not change that
product status.

## Select a release

A self-hosting release identifies the matching Rust Server, Browser Web and
Admin images, including immutable OCI digests. Follow its
[container installation](../deployment/docker.md#deploy-published-myoxus-images)
using that set. Web/Admin images contain static files and the deployment bundle;
the operator's Nginx serves them.

Native server DEB/APT and RPM packages are a separate installation route for the
same application. Use only packages and distribution versions explicitly listed
in a published GitHub release. Desktop DEB/RPM packages install the Electron
client and cannot substitute for a server package.

The [macOS 0.42.1 client](https://github.com/superions/myoxus/releases/tag/macos-client-v0.42.1)
is released independently of those server/container packages. It supplies both
architectures as DMG/ZIP with original build provenance, SBOM and legal notices.
Its [Homebrew installation and update route](../../user/downloads.md#macos-installation-and-updates)
downloads checksum-pinned GitHub assets. No native macOS updater, Developer ID
signature or notarization is claimed.

## Source, checksums and legal material

The release links its corresponding public source commit and source download,
and includes checksums, license and
notice material, SBOMs and source correspondence. Download assets from the
selected GitHub release and compare their SHA-256 values with its checksum file.
The exact build source remains identifiable even when the latest README or
installation documentation is updated independently.

The [provenance guide](./provenance.md) explains the relationship between build
revision, public source commit and source archive. The
[SBOM guide](./sbom.md) describes the dependency reports. These reports describe
the artifacts; they do not change the license of individual source files.

## Prepare an update

Read the selected release's supported upgrade path and installation requirements.
Record the current version and image/package identities, then create a complete
[backup](../data/backup-and-restore.md) before updating. Preserve operator
configuration, application-encryption keys, database data, blobs and PDF fonts.

Follow the upgrade instructions for the installed format:

- [Container upgrades](../deployment/docker.md#upgrade-procedure).
- Native server package instructions provided with an accepted DEB/RPM release.
- Desktop platform/package instructions provided with the selected desktop release.

The [Electron patch cadence](./electron-update-cadence.md) covers security and
dependency maintenance, packaging acceptance and native update limitations.

A new source snapshot or a documentation update does not make an older binary a
new release and does not require rebuilding unchanged binaries.
