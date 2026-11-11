<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Release provenance and boundary aggregation

[Documentation](../../README.md) / [Operations](../README.md) / [Release operations](./README.md)

The provenance tools provide an explicit, opt-in audit of a prepared source
state. They are not part of normal build, typecheck, changed-path test
selection or `build/scripts/release/release-containers.sh`. An operator starts
the client/source audit or boundary aggregation deliberately when provenance
evidence is requested.

Within that explicit audit, the contract is fail-closed: a single missing or
wrong evidence ref marks the affected boundary `blocked`; an excluded boundary
is reported as `not-in-release` and is not part of the assertion. This status
is an audit result, not an implicit build or promotion decision.

<details>
<summary>On this page</summary>

- [Boundary status](#boundary-status)
- [Boundaries and their owners](#boundaries-and-their-owners)
- [Evidence sources](#evidence-sources)
- [Owning gate](#owning-gate)
- [Explicit invocation](#explicit-invocation)
- [Failure scenarios](#failure-scenarios)
- [Source correspondence](#source-correspondence)

</details>

## Boundary status

| Status           | Meaning                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`          | Every required evidence ref resolves, hashes match, the kind-specific validator (e.g. CycloneDX for `sbom`) accepts, and the owning gate is green. |
| `blocked`        | At least one required evidence ref is missing, has a hash mismatch, fails its kind-specific validator, or its owning gate is red.                  |
| `not-in-release` | The boundary is explicitly excluded by the boundary manifest for this release. No promotion assertion is made.                                     |

`not-in-release` carries an `exclusionReason` from
`build/scripts/release/release-boundary.json`. The exclusion is a positive
declaration; a boundary that is silently absent from the manifest is rejected
by the boundary schema validator.

The set of recognised boundary ids is fixed: `server`, `frontends`,
`electron-linux`, `electron-macos`, `electron-windows`, `android`, `ios`.
The manifest must declare at least one boundary and may not invent new
ids; extending the recognised set is a deliberate code change in
`verify-release-provenance.mjs`, not a manifest edit.

## Boundaries and their owners

| Boundary id        | Kind               | Owning gate                                            | Status              |
| ------------------ | ------------------ | ------------------------------------------------------ | ------------------- |
| `server`           | Rust container     | `build/scripts/ci/verify-server-source-provenance.mjs` | `ready` / `blocked` |
| `frontends`        | Web + Admin static | `build/scripts/ci/verify-client-source-provenance.mjs` | `ready` / `blocked` |
| `electron-linux`   | Electron desktop   | Release boundary manifest                              | `not-in-release`    |
| `electron-macos`   | Electron desktop   | Release boundary manifest                              | `not-in-release`    |
| `electron-windows` | Electron desktop   | Release boundary manifest                              | `not-in-release`    |
| `android`          | Mobile             | Release boundary manifest                              | `not-in-release`    |
| `ios`              | Mobile             | Release boundary manifest                              | `not-in-release`    |

## Evidence sources

Each `inRelease` boundary declares its required evidence refs in
`build/scripts/release/release-boundary.json`. The aggregator resolves them
relative to the repository root and hashes the resolved file. The evidence
kinds the aggregator understands are:

| Kind            | Validator                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sourceArchive` | File exists, `.sha256` sidecar matches, `.manifest` sidecar exists, and `build/scripts/ci/verify-public-source-export.mjs --archive <path>` exits 0. The delegated check validates the Server, Client and Virgultum classifications plus the secret scan against the extracted tree. |
| `manifest`      | File exists and is non-empty (provenance / classification manifest)                                                                                                                                                                                                                  |
| `lockfile`      | File exists and is non-empty (reproducibility input)                                                                                                                                                                                                                                 |
| `sbom`          | File exists, is valid JSON, `bomFormat === "CycloneDX"`, `specVersion` is one of `1.5` or `1.6`                                                                                                                                                                                      |
| `legalBundle`   | File exists and is non-empty (notices, attribution bundles)                                                                                                                                                                                                                          |
| `notice`        | File exists and is non-empty (single-notice pointer)                                                                                                                                                                                                                                 |
| `digest`        | File exists and is non-empty (OCI digest reference)                                                                                                                                                                                                                                  |

The aggregator does not guess. An evidence ref that does not resolve to a
file on disk, a sidecar that does not match, a SBOM that is not a supported
CycloneDX version, or a required-evidence array that is empty all turn the
boundary into `blocked`. A boundary that is `inRelease=true` without
`requiredEvidence` cannot be `ready`.

The aggregator is not a replacement for deep CycloneDX JSON-schema
validation; `build/scripts/release/validate-sbom.sh` is the development-time
deep check and is run independently by the release pipeline. The aggregator
enforces the contract minimums (bomFormat + specVersion) so a non-SBOM file
cannot pass silently.

## Owning gate

Every `inRelease` boundary declares an `owningGate` that points to a Node
script. When the aggregator itself is explicitly invoked, it runs that script
via `node <gate>` with a 5-minute timeout. If the gate exits non-zero, the
boundary is `blocked` with a finding that includes the gate's tail output.
Neither the owning gate nor the aggregator is selected automatically.

## Explicit invocation

The available opt-in commands are:

```bash
node build/scripts/ci/verify-server-source-provenance.mjs --source-tree
node build/scripts/ci/verify-client-source-provenance.mjs
node build/scripts/ci/verify-virgultum-source-provenance.mjs
node build/scripts/ci/verify-public-source-export.mjs --archive <archive>
node build/scripts/ci/scan-public-source-secrets.mjs --dir <extracted-tree>
node build/scripts/release/verify-release-provenance.mjs \
  --output-dir build/dist/release-provenance
```

`build/scripts/release/publish-github-mirror.sh prepare` anonymously verifies
the reviewed public `main`, runs the export, archive verifier and secret scan,
then creates exactly one child commit in an isolated scratch checkout. It also
writes the full source diff, tree inventory, archive/manifest digests and the
reviewed GitHub-settings diff. The scratch checkout has only the deliberately
named `github-mirror` remote; the canonical checkout keeps only Forgejo
`origin`.

`publish-github-mirror.sh publish` is a separate, credentialed operation. It
accepts the exact reviewed source, parent, commit, tree and digests, repeats the
archive and remote-parent checks, applies the reviewed repository settings and
uses a normal fast-forward push. A moved or divergent public branch aborts the
operation. The helper has no orphan or force-push mode. GitHub-hosted builds,
Pages and Packages stay disabled; public Issues, Pull Requests and the
`SECURITY.md` route remain available.

The corresponding matrix suites are `manual-only`, have no changed-path
selectors and can be requested by exact suite id. The container release script
does not invoke them. When requested, the aggregator writes a hashed report:

- `build/dist/release-provenance/release-provenance.json` — the report
- `build/dist/release-provenance/release-provenance.json.sha256` — the hash

The report can be consumed by a downstream review that needs to prove which
exact boundaries were `ready` for the inspected revision. It contains only
file paths and SHA-256 hashes and does not include non-public repository
material. The aggregator is the only place that decides its
`ready` / `blocked` / `not-in-release` audit status.

## Failure scenarios

| Trigger                                                | Aggregator behaviour                                     |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `build/dist/source-export.tar` missing                 | `server` and `frontends` are `blocked` (missing archive) |
| `build/dist/source-export.tar.sha256` wrong            | `server` and `frontends` are `blocked` (mismatched hash) |
| Archive fails the dedicated source-export validator    | `server` and `frontends` are `blocked` (delegated)       |
| `build/dist/server.cdx.json` not CycloneDX 1.5/1.6     | `server` is `blocked` (invalid SBOM)                     |
| `build/dist/server-legal/THIRD_PARTY_NOTICES.md` empty | `server` is `blocked` (empty legal bundle)               |
| `build/dist/frontend.cdx.json` missing or invalid      | `frontends` is `blocked` (missing or invalid SBOM)       |
| Owning gate exits non-zero                             | Boundary is `blocked` (owning gate red)                  |
| Boundary manifest missing or wrong schema              | Aggregator refuses to start; exit non-zero               |
| Unknown boundary id in manifest                        | Schema validator refuses; exit non-zero                  |
| Boundary in release but no evidence refs               | Boundary is `blocked` (no backing evidence)              |
| Boundary excluded without `exclusionReason`            | Boundary schema validator refuses; exit non-zero         |

## Source correspondence

The release aggregator must never invent provenance. It copies the SHA-256
of each referenced file from the file itself, and the boundary ids from the
declared manifest. It does not write `present` into a guessed end year, does
not rewrite copyright holders, and does not substitute a parent value for a
component value. Per-file client copyright and license metadata remains in
`client/REUSE.toml`, with aggregate component boundaries in
`client/provenance/components.json`. The exact retained upstream MIT text is
`client/provenance/LICENSE-UPSTREAM-MIT.txt`; server evidence remains in
`server/provenance/components.json`. The aggregator hashes and references all
of these evidence anchors without rewriting their contents.

The curated source archive contains Server, Web, Admin, Electron main, and
Electron renderer source. It excludes every declared Android, iOS, Mobile,
Mobile Shared, Mobile Native, and Mobile test root. The frontend boundary is
backed by the single reproducible Web/Admin report at
`build/dist/frontend.cdx.json`; Electron and Mobile application roots are not
part of that report.

### Binding a build to the curated public source

`revision` in release.json, OCI labels and SBOM properties always identifies the
canonical Forgejo build input. The curated GitHub commit is a separate identity.
After preparing that public commit, the existing provenance report can record it:

```bash
node build/scripts/release/verify-release-provenance.mjs \
  --expected-revision <canonical-build-sha> \
  --public-source-commit <curated-public-commit> \
  --public-source-tree <qualified-public-tree>
```

The commit/tree come from the existing qualified public-source preparation.
Normal Git pushes transfer the missing objects; no additional source archive is
uploaded. GitHub provides commit-specific ZIP/TAR downloads. Their compressed
bytes can change, so no permanent archive SHA-256 is claimed. The report
retains its normal boundary readiness results; attaching the mapping does not
make an unqualified boundary ready or prove public reachability. A private build
SHA must never be inserted into a GitHub commit URL. Neither the future public
commit nor the archive's own digest is an input to the exported source tree.

Set `MYOXUS_SOURCE_PROVENANCE` to this report when producing legal bundles or
SBOMs. The desktop metadata writer also accepts `--source-provenance <report>`.
Consumers reject a different build revision or invalid Git identity. Historical
archive-bound reports and their explicit URL/SHA-256 pair remain readable and
must agree when supplied. SBOMs retain the canonical revision and add public
source references without inventing hashes for generated GitHub downloads.
Unconfigured development builds make no claim about public source availability.

The OCI workflow accepts explicit `source_provenance_url` and
`source_provenance_sha256` overrides. Otherwise its shared release preparation
creates the correspondence for the exact source revision automatically; it
does not use the obsolete global `PUBLIC_SOURCE_PROVENANCE_*` variables.
It downloads only that digest-bound report
and verifies its build revision before use. Server BuildKit receives the report
through an optional secret mount, while only the resulting correspondence is
included in the legal bundle. The report is also retained with build evidence.
Old immutable artifacts are not rewritten. Anonymous public source reachability
must be checked before public artifact advertising.

### Automated GitHub release copy

For a normal, explicitly authorized publication, dispatch the existing
`publish-github-release.yml` in `mode: release`, supplying the accepted `version`
and public `notes`. It assembles its allowlist from matching immutable component
tags, sealed CI evidence, promotion receipts and the qualified public-source
cache; extracts original legal files without running the server; and uses the
existing prepare/publish functions. It never builds, regenerates an SBOM or
repackages binaries. Missing accepted OCI/native artifacts stop the copy.
The separate `prepare`/`publish` modes below retain optional exact-plan review.

A server-Dockerfile-only repair can retain the accepted frontend tag and images.
The assembler verifies that the component sources differ only in
`build/server/Dockerfile`, validates each producer against its own immutable
revision, and records both qualified source mappings in `componentSources`.
Any other source difference still stops publication; original image and SBOM
identities are never relabelled.

Dispatch `.forgejo/workflows/publish-github-release.yml` with the Forgejo URL of
the publication input JSON. It contains the version/tag, `prerelease`, inline
`notes`, the qualified OCI digest references in `containers`, and the explicit
`assets` list using the existing artifact names and SHA-256 values. Each asset
has `name`, `url`, `sha256` and optional `size`; identify original legal/SBOM
files with `kind: "legal"` / `kind: "sbom"`, and the release provenance report
with `kind: "provenance"`. New publication inputs require the qualified Git tree
and reject duplicate source-archive assets; historical reports remain readable.
Server Build starts automatically on `server-v*` tags.
After the existing Ubuntu DEB and Fedora RPM installation jobs pass, it retains
the accepted packages and original native SBOM in the runner's `server-release`
cache. The GitHub workflow automatically adds those three files from the accepted
run for the exact provenance revision/version, with download links and checksums.
Producer-approved reuse keeps original package filenames and SBOM build revisions;
the publisher does not relabel them or repeat the producer's source qualification.
Do not add them manually to the input list. If Server Build is still running or
failed, preparation stops before a GitHub write; finish or recover that existing
run and prepare again. Copying performs no build, repackaging or installation.
Desktop packages keep their separate release scope.
Set `scope: "selfhost"` for server releases; it excludes desktop packages and
update metadata. Artifacts come from Forgejo. Preparation packs the unchanged
original legal/SBOM/provenance files in one legal/provenance bundle with a
contents/checksum list. Accepted binaries are not repackaged.

The `prepare` dispatch copies the named bytes, checks their digests and source
mapping, and retains prepared bytes in the existing runner cache. The review
artifact contains only `github-release-plan.json` and its SHA-256; no duplicate
binary upload. It makes no GitHub write. Source/build qualification stays with the
existing export and release owners; the publisher does not repeat it.

After approval, dispatch `publish` with the approved `expected_plan_sha256`.
No input URL is needed: the workflow selects that retained candidate and checks
its bytes without re-preparing or re-downloading them. Missing candidates fail
without a build/version change. `GITHUB_RELEASE_TOKEN` is a repository-scoped
fine-grained credential for `superions/myoxus`; the publisher requires Metadata
read and Contents write. Preparation does not receive it. All payloads remain unchanged.
The publisher keeps incomplete uploads as drafts, compares GitHub's stored
SHA-256 digests and uploads at most three independent assets concurrently.
Only assets lacking an API digest need a full readback. Wrong existing uploaded
bytes are never replaced; same-byte retries may remove their own empty failed
draft upload placeholders. `GITHUB-SHA256SUMS` covers the complete asset set.
