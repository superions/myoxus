<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# SBOM and server legal release process

[Documentation](../../README.md) / [Operations](../README.md) / [Release operations](./README.md)

Myoxus uses CycloneDX JSON 1.5. A software bill of materials is dependency
evidence; it does not replace the root license, third-party notices, bundled
asset licenses, or source correspondence.

Desktop releases carry one TypeScript SBOM rooted at the Electron application.
It combines the locked dependency closures of `client/apps/electron` and
`client/apps/electron-renderer`, including their workspace dependencies. This
is necessary because the CycloneDX Yarn command inventories the current
workspace recursively; running it only from the repository root does not
inventory independent workspaces such as Electron or Core.

The opt-in static-frontend audit report is rooted at the Web application and
combines the locked dependency closures of `client/web/workspaces/web` and
`client/admin/workspaces/admin`. Electron and Mobile application roots are
deliberately absent because they are separate release boundaries. The normal
OCI release does not generate this audit report or use it as a promotion gate.

Server releases carry two deliberately different SBOMs:

- `legal/sbom/server.cdx.json` describes the Rust application graph for the
  native server and CLI. Its root component records the exact server version
  and full Git revision.
- `server-oci.cdx.json` describes the final server container filesystem. It
  includes the Cargo graph and the packages installed by Debian, and its root
  component records the immutable image identity. Published images require a
  registry manifest digest; a non-published local verification records the
  immutable local image ID and labels it as such.

The mixed server image intentionally has no blanket
`org.opencontainers.image.licenses` label. Individual dependencies and bundled
assets keep their own license expressions and notices.

<details>
<summary>On this page</summary>

- [Pinned tooling](#pinned-tooling)
- [Desktop TypeScript artifacts](#desktop-typescript-artifacts)
- [Static frontend TypeScript artifact](#static-frontend-typescript-artifact)
- [Native server artifacts](#native-server-artifacts)
- [Server container artifacts](#server-container-artifacts)
- [Validation](#validation)

</details>

## Pinned tooling

Desktop and static-frontend SBOM generation use the exact root development dependency
`@cyclonedx/yarn-plugin-cyclonedx 3.3.2`, which supports Yarn 4 and Node 26.
Release jobs invoke its `cyclonedx-yarn` CLI wrapper through the locked Yarn
4.18.0 workspace. They never run `yarn plugin import`, `yarn dlx`, or install a
generator at release runtime.

Server SBOM generation requires `cargo-cyclonedx 0.5.9`. Release jobs verify
that exact version and do not install an unbounded latest version. JSON schema
validation uses pinned `ajv-cli 5.0.0`; the official CycloneDX 1.5, SPDX, and
JSF schemas are downloaded into the local cache and checked against fixed
SHA-256 values before use.

## Desktop TypeScript artifacts

Generate only the desktop TypeScript report at an explicit caller-selected
path:

```bash
build/scripts/release/generate-sbom.sh \
  --typescript-only \
  --output dist/release/sbom/desktop.cdx.json
```

The output path is resolved relative to the caller's working directory. The
command uses CycloneDX's `--output-reproducible`, `--output-format JSON`,
`--spec-version 1.5`, and `--mc-type application` options with their exact
Yarn-4 CLI spelling and casing. It unsets `NODE_ENV` for the generator so the
desktop build-time Electron dependency remains in the inventory. The command
does not generate a Rust report and does not modify `package.json`,
`yarn.lock`, `.yarnrc.yml`, or `.yarn/plugins`. A dependency license identifier
newer than the SPDX 3.21 list embedded by CycloneDX 1.5 is preserved as a named
license; recognized identifiers, including Mediabunny's `MPL-2.0`, remain SPDX
IDs.

The focused changed-path contract test generates the report twice, compares it
byte for byte, validates it against the pinned CycloneDX schema, and requires
the locked Electron and Mediabunny components:

```bash
build/scripts/ci/test-desktop-sbom.sh
```

That test guards changes to the SBOM producer; it is not rerun as a release
preflight. The Linux package job generates the publishable SBOM once together
with DEB, RPM and Flatpak.

## Static frontend TypeScript artifact

Generate the combined Web/Admin report at the release-boundary path:

```bash
build/scripts/release/generate-sbom.sh \
  --frontend-only \
  --output build/dist/frontend.cdx.json
```

The report is rooted at `@myoxus/web`, includes the Admin application as a
direct application dependency, and merges both locked dependency closures
deterministically. It must not contain Electron or Mobile application roots.
`build/scripts/ci/test-desktop-sbom.sh` owns reproducibility, schema, content,
and non-mutation checks when either TypeScript SBOM producer itself changes. A
normal container release neither generates the frontend report twice nor feeds
it into a release-boundary aggregator.

## Native server artifacts

The release-strict matrix suite builds binaries, assembles the Legal tree,
creates the archive and Debian package, and compares their contents:

```bash
build/scripts/test/run.sh --suite server.build.release --strict
```

Every native form contains these files under `legal/`, or under
`/usr/share/doc/myoxus-server/` in the Debian package:

```text
LICENSE
THIRD_PARTY_NOTICES.md
SOURCE.md
provenance/components.json
provenance/paste-consumers-source.json
licenses/yrs/LICENSE
licenses/biblatex/LICENSE-MIT
licenses/biblatex/LICENSE-APACHE
licenses/hayagriva/LICENSE-MIT
licenses/hayagriva/LICENSE-APACHE
licenses/hayagriva/NOTICE
licenses/simba/LICENSE
licenses/safer-bytes/DECLARED-MIT.txt
sbom/server.cdx.json
```

`THIRD_PARTY_NOTICES.md` is generated from the locked Cargo workspace graph and
`server/provenance/components.json`. `SOURCE.md` separates build identity
(exact input revision, server version and normalized `SOURCE_DATE_EPOCH`) from
public corresponding-source availability. A build revision is not a promise
that its Git object or history is public. No public commit URL or internal
repository export command is derived from that revision.

The manifest-only Cargo patches retain their published license and notice
files in the generated Legal tree. Safer-bytes' publisher supplies only an MIT
manifest declaration; `DECLARED-MIT.txt` preserves that fact and the standard
terms without inventing a copyright holder/year. The source-hash manifest
records the bounded patches. The Docker builder copies all patched sources and
these notice inputs; native packages and the container retain the same Legal tree.

The assembly wrapper accepts `MYOXUS_SOURCE_ARCHIVE_URL` and
`MYOXUS_SOURCE_ARCHIVE_SHA256` together; the server Dockerfile exposes the same
names as build arguments. The URL must point directly to an HTTPS source
archive, without credentials, query parameters or a fragment. The checksum
must be the archive's lowercase SHA-256. The archive may be hosted independently
of the internal build system; no GitHub-specific host is required.

Without both values, `SOURCE.md` explicitly states that no public source archive
is configured. Normal internal builds remain usable. With both values, assembly
validates their syntax and records them; it does not download the archive or
prove source/binary correspondence. Public publication must separately verify
anonymous retrieval, archive digest and correspondence to the exact build before
release. A configured URL alone is not release-readiness evidence. Internal
build logs, repository history and private source mappings are not uploaded by
this generator. The artifact manifest and SHA-256 file include the complete
Legal tree.

To generate the same Legal tree directly:

```bash
revision="$(git rev-parse HEAD)"
version="$(cargo metadata --manifest-path server/Cargo.toml --format-version=1 --no-deps | jq -r '.packages[] | select(.name == "myoxus-api") | .version')"
epoch="$(git show -s --format=%ct "$revision")"
build/scripts/release/assemble-server-legal.sh dist/server-legal "$revision" "$version" "$epoch"
```

## Server container artifacts

The server container builds the same Legal tree into
`/usr/share/doc/myoxus-server/` and records the installed Debian package set in
`os-packages.tsv`. After the final image is loaded or pushed,
`verify-server-container-legal.sh` extracts and compares the Legal files,
validates the Cargo SBOM, creates the filesystem-level OCI SBOM, validates its
digest binding, and writes the Server identity files under
`dist/container-build/server/`. The same build wrapper retains Web and Admin
image inspection plus embedded `release.json` under
`dist/container-build/{web-frontend,admin-frontend}/`.

`verify-container-build-evidence.mjs` rejects wrong roles, versions, shortened
or mixed revisions, stale/extra identity files and registry-digest claims in a
no-publish build. Published Server builds retain the stronger registry-manifest
digest requirement; Web/Admin registry digests remain owned by common
acceptance. Only after this role check does the build write and verify
`ARTIFACTS.md` and `SHA256SUMS`. Forgejo stages the three sealed directories as
`server-container-provenance`, `web-frontend-container-provenance`, and
`admin-frontend-container-provenance`.

## Validation

Validate one or more explicit reports with:

```bash
build/scripts/release/validate-sbom.sh \
  dist/server-build/bundle/myoxus-server-linux-x64/legal/sbom/server.cdx.json \
  dist/container-build/server/server-oci.cdx.json
```

For ad-hoc development reports, `generate-sbom.sh` still supports date-based
`docs/sbom/` outputs. Release automation must select exactly one generator when
passing `--output`. Server release automation also passes `--git-revision`,
`--component-version`, and `--source-date-epoch` so a report cannot float
independently of its artifact.
