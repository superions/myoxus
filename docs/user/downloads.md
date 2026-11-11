# Downloads and release channels

[Documentation](../README.md) / [User guides](./README.md)

**[Myoxus releases on GitHub →](https://github.com/superions/myoxus/releases)**

GitHub is the public entry point for Myoxus source, release downloads,
checksums and installation instructions. Myoxus is beta software.

## Choose your installation

| Distribution                                    | Download and instructions                                                                                                                                        | Current status                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Server, Browser Web and Admin in containers** | [GitHub Releases](https://github.com/superions/myoxus/releases) · [Docker Compose installation](../ops/deployment/docker.md#deploy-published-myoxus-images)      | GitHub prereleases list each published Server/Web/Admin set with exact image digests and corresponding source. |
| **Native Linux server — DEB/APT**               | [GitHub Releases](https://github.com/superions/myoxus/releases) · [Server package status](../ops/getting-started/installation-decision.md#distribution-packages) | Published for Linux x86_64; follow the selected server release's version and installation instructions.        |
| **Native Linux server — RPM**                   | [GitHub Releases](https://github.com/superions/myoxus/releases) · [Server package status](../ops/getting-started/installation-decision.md#distribution-packages) | Published for Linux x86_64; follow the selected server release's version and installation instructions.        |
| **macOS desktop client**                        | [macOS 0.42.1](https://github.com/superions/myoxus/releases/tag/macos-client-v0.42.1) · [Installation and updates](#macos-installation-and-updates)              | Intel and Apple Silicon DMG/ZIP; externally managed Homebrew updates from GitHub.                              |
| **Linux and Windows desktop clients**           | [GitHub Releases](https://github.com/superions/myoxus/releases) · [Web and rich clients](./web-and-rich-clients.md)                                              | Publication is independent; use only platform versions listed in an actual release.                            |
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

Published native server releases include DEB and RPM files and one legal/provenance
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

## macOS installation and updates

[macOS 0.42.1 release notes and downloads](https://github.com/superions/myoxus/releases/tag/macos-client-v0.42.1)
provide the Intel (`x64`) and Apple Silicon (`arm64`) DMG and ZIP files.
The applications are ad-hoc signed, without Apple Developer ID or notarization.
Standard macOS first-start approval may be required; keep Gatekeeper enabled.

For an installation managed by Homebrew, use the published
[Myoxus Cask](https://github.com/superions/myoxus/blob/main/Casks/myoxus.rb):

```bash
brew tap superions/myoxus https://github.com/superions/myoxus.git
brew install --cask superions/myoxus/myoxus
brew upgrade --cask superions/myoxus/myoxus
```

The Cask selects the matching architecture and checks its exact SHA-256 before
installation. Both installation and later upgrades download the published
GitHub DMG. Updates are external; the application does not run Homebrew or offer
a native macOS updater. Check the selected release notes before an upgrade.

If Myoxus was installed directly from a DMG/ZIP, an explicit
`brew install --cask --adopt superions/myoxus/myoxus` handover works only when
that application exactly matches the Cask. For a different installed version,
quit Myoxus and remove only the old application bundle before installing the
Cask. Preserve application profiles, local documents, sessions, configured
servers and recordings; do not use `--zap`.

The first upgrade to this macOS cookie-storage policy requires one normal
Myoxus sign-in. Later restarts retain the session without repeated Keychain
requests. Cookies are stored without additional cookie encryption in a private
profile restricted to the macOS user; processes running as the same user remain
inside that access boundary. Recording/transcription acceptance remains separate
and is not claimed by this package release.
