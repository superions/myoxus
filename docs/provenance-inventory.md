# Source provenance and licenses

[Documentation](./README.md)

This overview records source origins and license boundaries: independently
developed Myoxus code, retained MIT-licensed client/editor lineage and separately
licensed components. Component inventories provide the precise file, source and
package evidence. A baseline applies to its recorded scope; it does not approve
later source additions or a binary release automatically.

| Foundation                         | Reviewed status                                                             |
| ---------------------------------- | --------------------------------------------------------------------------- |
| **Rust server and Admin frontend** | Independent Myoxus implementations, AGPL-3.0-or-later                       |
| **Browser, desktop and Virgultum** | Reviewed Myoxus work and retained MIT-licensed AFFiNE/BlockSuite lineage    |
| **Third-party material**           | Identified components with their original licenses and notices              |
| **Release artifacts**              | Exact dependency versions, notices and source identity recorded per release |

<details>
<summary>On this page</summary>

- [Reading the classifications](#reading-the-classifications)
- [Source areas](#source-areas)
- [Component notices](#component-notices)
- [Historical license boundary](#historical-license-boundary)
- [Source and binary releases](#source-and-binary-releases)

</details>

## Reading the classifications

| Code | Origin                                                                    |
| ---- | ------------------------------------------------------------------------- |
| `M0` | Independently developed Myoxus implementation                             |
| `F1` | Retained AFFiNE/BlockSuite source modified by Myoxus                      |
| `F2` | Retained source moved or renamed from that lineage                        |
| `C0` | Compatible name, schema, protocol or persisted-format marker              |
| `T1` | Separately licensed third-party source, asset, font or generated material |

These describe origin; SPDX identifiers describe licenses. A compatible API,
import format or stored identifier does not make independently written code
upstream-derived. Renaming or modifying retained source preserves its original
attribution. Generated assets derive their notices from the recorded source
inputs and generators.

Copyright identifies the rights holders and the years associated with their
contributions. A license states the permissions and conditions for use. The
[MIT terms](https://opensource.org/license/mit) require retention of the original
copyright and permission notices. Our fork does not end the original authors'
rights; independently protectable Myoxus changes can have additional rights
alongside them (see [§ 3 UrhG](https://www.gesetze-im-internet.de/urhg/__3.html)).

The retained AFFiNE/BlockSuite lineage is frozen at the reviewed **4 March 2026**
cutoff. No later upstream contributions are incorporated. Our file-level upstream
attribution therefore uses **2022–2026**, while Myoxus contributions have their
own separate attribution beginning in 2026. That closed range describes the
retained contributions; it neither ends the original authors' rights nor changes
their license. There is no general ban on closed copyright year ranges.

The historical publisher notice is a separate fact. Copies kept as primary
license/notice evidence preserve the published `2022-present` wording. This is a
quotation of the pinned source, not an attribution of subsequent Myoxus changes
to AFFiNE. The client inventory records this original notice separately under
`upstreamMitLicense.originalCopyrightNotice`; its source attribution and cutoff
record the bounded contributions actually retained in Myoxus.

The source license is assigned **per file**, from its reviewed origin. Daniel
Scharf reaffirmed this policy on **30 October 2026**:

- A retained MIT file remains **MIT**, including Myoxus changes in that file.
  Both the retained authors and Myoxus contributions remain attributed.
- An independently authored new Myoxus file is **AGPL-3.0-or-later**.
- Retained third-party files keep their original recorded license, including
  changes to those files. Original Apache/BSD/MIT-0 notices remain intact.
- The explicitly approved Linux AppStream metadata XML is **CC0-1.0**.

There is no MIT/AGPL split between old and new lines in a retained MIT file.
Its file declaration is `SPDX-License-Identifier: MIT`. Source origin and explicit
owner decisions determine that declaration; a package label or automatic header
does not. Package and generated-bundle summaries can list multiple licenses
because they contain separately identified files or component inputs. Such a
summary does not relicense any source file.

Virgultum's [reviewed file inventory](../virgultum/provenance/sources.json)
records exact paths, origins, content fingerprints and pinned original Git blob
identities. The generated snapshot derives source licenses from that inventory,
independently of package labels. Unclassified or changed source requires review;
regeneration alone does not classify it. Package declarations describe the
resulting distribution and never choose a file's license.

Technical inventory checkpoint: **31 October 2026** — 4,913 exact client paths,
3,791 Virgultum paths (3,783 in the public projection), 74 editor packages and
nine embedded editor components. The Server inventory retains the reviewed
fonts/ICC/vendor evidence, including 494 parsed font files. This baseline covers
the recorded paths and retained evidence under the file-level policy above.
Release archives, reproducible builds and binary publication retain their own
acceptance gates.

## Source areas

| Area                                | Reviewed origin                                             | License boundary                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Server** · `server/`              | `M0`, with `C0` data/API contracts                          | AGPL-3.0-or-later; dependencies and bundled assets keep their recorded licenses                                      |
| **Admin** · `client/admin/`         | `M0`                                                        | AGPL-3.0-or-later and separately licensed dependencies                                                               |
| **Browser** · `client/web/`         | `F1/F2/M0`                                                  | Retained MIT files including modifications; independently new AGPL files                                             |
| **Desktop** · Electron and renderer | `F1/F2/M0`                                                  | Recorded client licenses plus Electron/Chromium runtime notices                                                      |
| **Shared client libraries**         | `F1/F2/M0/C0/T1`                                            | Exact file declarations distinguish MIT lineage, AGPL work and third-party exceptions                                |
| **BPMN editor**                     | Apache KIE source, Myoxus additions and official OMG inputs | New independent files are AGPL; retained Apache files including changes remain Apache; OMG inputs retain their terms |
| **Crypto and document indexer**     | `M0`, with `C0` indexer markers                             | AGPL-3.0-or-later                                                                                                    |
| **Local store**                     | `F1/F2/M0`                                                  | Retained frontend-native files including changes are MIT; independently new files are AGPL                           |
| **Media capture**                   | Retained implementation and Myoxus wrapper                  | Retained inner files including changes are MIT; independent new inner files and outer wrapper are AGPL               |
| **Icons and branding**              | `M0`, with recorded third-party inputs                      | Myoxus AGPL work; input geometry/fonts retain their own licenses                                                     |
| **Virgultum editor**                | `F1/F2/M0/C0/T1`                                            | Retained MIT files including changes; independently new AGPL files; nested vendor grants                             |
| **Build tools and tests**           | Reviewed Myoxus work and retained source/fixtures           | Existing component and fixture declarations apply                                                                    |
| **Documentation**                   | Myoxus material and attributed embedded assets              | Project license with recorded asset exceptions                                                                       |

Platform-client source follows its reviewed component declarations. A desktop
release covers its listed desktop artifacts; mobile payloads are outside the
current public release scope. Generated Web/Admin roots are rebuilt from the
reviewed source.

## Component notices

| Component                                      | License and attribution                                                                             | Evidence                                                                                                                                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Client source**                              | File-level MIT/AGPL and exception declarations                                                      | [REUSE inventory](../client/REUSE.toml), [component inventory](../client/provenance/components.json), [upstream MIT grant](../client/provenance/LICENSE-UPSTREAM-MIT.txt)                                                                     |
| **Virgultum**                                  | Reviewed packages and nested third-party components                                                 | [License inventory](../virgultum/provenance/licenses.json)                                                                                                                                                                                    |
| **BPMN editor and generator**                  | Retained Apache files including changes; independently new AGPL files; recorded OMG/generated terms | [Source inventory](../client/libs/bpmn-editor/provenance.json), [Apache license](../client/libs/bpmn-editor/LICENSE), [original NOTICE](../client/libs/bpmn-editor/NOTICE), [OMG/W3C notices](../client/libs/bpmn-editor/THIRD-PARTY-NOTICES) |
| **Glirulus workflow runtime**                  | MIT, Copyright (c) 2026 Sayiir; Daniel Scharf's fork modifications                                  | Published `1.0.0` packages; [fork provenance and original archive identities](https://github.com/superions/glirulus/blob/v1.0.0/UPSTREAM.md); each resolved package's `LICENSE` and `NOTICE`, Cargo checksums and release legal bundle        |
| **Rust server assets**                         | Fonts, ICC profiles and vendored Typst modules                                                      | [Server component inventory](../server/provenance/components.json)                                                                                                                                                                            |
| **Media capture**                              | MIT retained implementation; AGPL wrapper                                                           | [Notice](../client/libs/media-capture/NOTICE.md), [inner license](../client/libs/media-capture/media_capture/LICENSE)                                                                                                                         |
| **Lit React component**                        | Google Lit source, BSD-3-Clause; embedded Google LLC notice                                         | [Component source](../client/libs/lit-react/src/create-component.ts)                                                                                                                                                                          |
| **Icons**                                      | Myoxus artwork/generators and attributed MIT Tabler inputs                                          | [Client provenance](../client/libs/icons/PROVENANCE.md), [Virgultum icon provenance](../virgultum/icons/PROVENANCE.md)                                                                                                                        |
| **Bundled fonts**                              | OFL-1.1, Bitstream Vera/public-domain changes and GUST Font License, by family                      | [Font manifest](../server/static/fonts/manifest.json), [license texts](../server/static/fonts/licenses/)                                                                                                                                      |
| **Typst documentation/presentation templates** | MIT-0 ilm including changes; independent AGPL adapters; MIT Touying and uniwarn                     | [Vendor notices](../server/templates/pdf/vendor/NOTICE)                                                                                                                                                                                       |
| **Electron and Chromium**                      | MIT Electron and the runtime's component notices                                                    | Exact runtime notices shipped with desktop artifacts                                                                                                                                                                                          |
| **Mediabunny**                                 | MPL-2.0 dependency                                                                                  | Release notice bundle, original license, upstream source and SBOM entry                                                                                                                                                                       |

File-level origin evidence, explicit author decisions and retained licenses/notices
are authoritative. Package labels do not determine source licensing. The project's
[AGPL-3.0-or-later license](../LICENSE) does not replace third-party grants.

Virgultum's Lit signal adapters retain their Google LLC copyright and
BSD-3-Clause source headers. The [complete retained BSD license](../virgultum/provenance/LICENSE-LIT-BSD-3-Clause.txt)
also preserves The Lit Project Contributors' notice; its exact publisher source
and SHA-256 are recorded in the editor inventory. Tabler's embedded MIT geometry
and notice remain separate from the Myoxus icon implementation.

The client inventory also covers the Electron main/helper/preload and renderer
source. Its per-file declarations separate retained MIT material from independent
Myoxus additions; AppStream metadata, including Myoxus additions, uses the single explicitly
authorized CC0-1.0 exception (Daniel Scharf, 29 October 2026). Private
helper/test workspaces can omit npm package license metadata; that omission is
not evidence about source rights. Source licensing follows the actual file and
component declarations and retained notices. All package manifests inside the
client inventory have explicit license metadata.

## Historical license boundary

The reviewed upstream cutoff is AFFiNE **0.26.3**, commit
`e31cca33540af2737dc9e520b70acac170c0709e`, dated **4 March 2026**.
The independent Myoxus repository retains the relevant license evidence and
reviewed source classifications.

At that point, the upstream MIT grant covered material outside
`packages/backend/` and `packages/common/native/`, subject to component-specific
licenses. Those two restricted source areas were removed. The Myoxus Rust
server implementation is independent of that restricted source; separately
licensed dependencies such as the Glirulus fork of Sayiir retain their own grants. Required common-native functions were
replaced by Myoxus components, including the crypto library and document
indexer.

The local-store and inner media-capture lineage comes from
`packages/frontend/native/`, which was covered by the MIT grant. It is distinct
from the removed `packages/common/native/` tree. Virgultum descends from the
MIT-licensed BlockSuite editor tree and retains the appropriate notices.
Historical names in protocols or stored data preserve compatibility.

## Source and binary releases

Public source carries the preferred source form, build inputs, generators,
lockfiles and applicable attribution. Compiled server containers, frontend
artifacts and desktop packages carry version-specific notice bundles and
CycloneDX SBOMs.

| Evidence                                   | What it identifies                                    |
| ------------------------------------------ | ----------------------------------------------------- |
| **Component inventories and notices**      | Source origins, license boundaries and attribution    |
| **SBOM**                                   | The exact resolved dependency graph in an artifact    |
| **Source archive and hashes**              | Rebuildable source corresponding to the released work |
| **Checksums, signatures and attestations** | Artifact identity and distribution integrity          |

Use [release provenance](./ops/release/provenance.md) and
[SBOM/legal evidence](./ops/release/sbom.md) for artifact verification.
