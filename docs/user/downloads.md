# Downloads and release channels

[Documentation](../README.md) / [User guides](./README.md)

**[Myoxus releases on GitHub →](https://github.com/superions/myoxus/releases)**

GitHub is the public entry point for Myoxus source, release downloads,
checksums and installation instructions. Myoxus is beta software.

## Choose your installation

| Distribution                                    | Download and instructions                                                                                                                                        | Current status                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Server, Browser Web and Admin in containers** | [GitHub Releases](https://github.com/superions/myoxus/releases) · [Docker Compose installation](../ops/deployment/docker.md#deploy-published-myoxus-images)      | GitHub prereleases list each published Server/Web/Admin set with exact image digests and corresponding source. |
| **Native Linux server — DEB/APT**               | [GitHub Releases](https://github.com/superions/myoxus/releases) · [Server package status](../ops/getting-started/installation-decision.md#distribution-packages) | Available in 0.41.38 for Linux x86_64; package installation checked on Ubuntu 24.04.                           |
| **Native Linux server — RPM**                   | [GitHub Releases](https://github.com/superions/myoxus/releases) · [Server package status](../ops/getting-started/installation-decision.md#distribution-packages) | Available in 0.41.38 for Linux x86_64; package installation checked on Fedora 44.                              |
| **Desktop clients**                             | [GitHub Releases](https://github.com/superions/myoxus/releases) · [Web and rich clients](./web-and-rich-clients.md)                                              | Desktop publication follows separately. No GitHub desktop download or update feed is currently advertised.     |
| **Application source**                          | [Browse the source](https://github.com/superions/myoxus) · [Build from source](../../CONTRIBUTING.md)                                                            | Published for Server, Web/Admin, Electron and Virgultum.                                                       |

Container and native package installations are both distribution targets for
the same server. Desktop DEB/RPM files install the Electron client, not the
server. Only the formats, architectures and distribution versions named in an
actual release are available. Mobile packages are outside the current release scope.

## Read the selected release

The release identifies its source, exact assets, checksums and installation
requirements. The self-hosting beta includes the Server/Web/Admin image
references, corresponding source and legal/SBOM material. Follow its linked
[installation guide](../ops/getting-started/installation.md) and use a matching
set of server and frontend versions.

The 0.41.38 server release includes DEB and RPM files and one legal/provenance
bundle containing the original SBOMs and notices. **GITHUB-SHA256SUMS** covers
the packages and bundle. Source downloads come from the release's public Git
commit. Follow the
[native package installation](../ops/getting-started/installation.md#native-server-packages).
The [manual Linux source installation](../ops/deployment/systemd/README.md)
remains available.

## Channels and updates

**Beta** releases are marked as GitHub prereleases. **Stable** is an artifact
channel; it does not change Myoxus's beta product maturity. **Internal** does
not promise a public download. An empty channel has no downloadable artifact
or update manifest.

Browser Web and Admin update with the installation operated by your administrator.
Desktop updates follow the selected platform, package format and channel.
Signature and installation requirements are stated in each desktop release;
only an explicitly available update route should be used.

See [release information](../ops/release/README.md) for source correspondence,
checksums and update preparation.
