# Myoxus Branding Source Assets

This directory stores editable Myoxus branding source artwork and reviewed
exports.

## Contents

| File                     | Purpose                                 |
| ------------------------ | --------------------------------------- |
| `myoxus_text.afdesign`   | Editable text logo source.              |
| `myoxus_text.svg`        | SVG export of the text logo.            |
| `myoxus_mascot.afdesign` | Editable mascot mark source.            |
| `myoxus_mascot.svg`      | SVG export of the mascot mark.          |
| `myoxus_mac_.afdesign`   | Editable macOS-oriented source artwork. |

The approved illustration originals and provenance manifest are stored in
`artwork/`. Their generated SVG/WebP runtime pairs live in
`client/branding/artwork/`. See the
[deployment path contract](../../docs/dev/branding/assets/deployment-paths.md)
for conversion and validation commands.

## Documentation Illustrations

The fourteen `docs-*` and `guide-*` motifs extend the same **Keramik & Licht**
style for onboarding, the user handbook and documentation README pages. They
are proposed artwork for review; existing product illustrations retain their
approval. All originals have transparent backgrounds and language-neutral
subjects, with matching self-contained SVG and lossless WebP files in the
central runtime artwork directory.

| Motif               | Intended use                                                   |
| ------------------- | -------------------------------------------------------------- |
| `docs-hero`         | Project and documentation README; Welcome guide                |
| `docs-handbook`     | User-guide index and handbook cover                            |
| `guide-start`       | First steps onboarding; handbook chapter 01                    |
| `guide-write`       | Writing and editing; handbook chapter 02                       |
| `guide-organize`    | Folders onboarding; handbook chapter 03                        |
| `guide-data`        | Database onboarding; handbook chapter 04                       |
| `guide-collaborate` | Sharing and collaboration; handbook chapter 05                 |
| `guide-exchange`    | Import and export; handbook chapter 06                         |
| `guide-recovery`    | History and recovery; handbook chapter 07                      |
| `guide-help`        | Clients, updates and help; handbook chapter 08                 |
| `guide-meeting`     | Meetings onboarding                                            |
| `docs-operate`      | Operations, installation, deployment and security README pages |
| `docs-develop`      | Developer, component, contribution and test documentation      |
| `docs-integrate`    | API and integrations README pages                              |

The [prompt set and intended placements](artwork/documentation-prompts.json)
record the built-in Imagegen inputs and reference roles. The manifest marks
these additions as `reviewStatus: proposed`. They have not been inserted into
reader-owned onboarding documents or published handbook editions. Handbook
publication follows the existing editorial document and PDF export workflow;
onboarding artwork belongs in the native document bundles alongside their
internal image assets.

Use a larger title illustration for a README or cover, then smaller relevant
chapter illustrations alongside the real interface screenshots. Preserve the
original aspect ratio, transparency and framing. The detailed mascot remains
an illustration rather than a replacement for the canonical product mark.

## Workspace And Assistant Illustrations

The twenty `assistant-*` motifs use the exact material, mascot and lighting of
the documentation series. They are proposed artwork for workspace setup,
assistance choices and everyday product moments. Each motif has a transparent
1536 × 1024 PNG original and matching central SVG/lossless WebP derivatives.

| Number | Motif                           | Subject                                    |
| ------ | ------------------------------- | ------------------------------------------ |
| 01     | `assistant-hello`               | Friendly greeting with “Hi”                |
| 02     | `assistant-welcome-to-my-hedge` | Leaf branches and “Welcome to my hedge”    |
| 03     | `assistant-fresh-start`         | Blank notebook and fresh shoot             |
| 04     | `assistant-choose-your-path`    | Three equivalent paths                     |
| 05     | `assistant-manual`              | Blank sheet and pencil                     |
| 06     | `assistant-guided`              | Compass and three stepping stones          |
| 07     | `assistant-automatic`           | Ordered document cards and small gear      |
| 08     | `assistant-first-task`          | Empty checkbox and pencil                  |
| 09     | `assistant-simple-project`      | Folder, planning sheet and target          |
| 10     | `assistant-roadmap`             | Three milestones and a goal pennant        |
| 11     | `assistant-issue-tracker`       | Magnified bug on a task card               |
| 12     | `assistant-prepare-meeting`     | Agenda, clock and empty speech bubble      |
| 13     | `assistant-capture-decision`    | Two paths with one selected outcome        |
| 14     | `assistant-knowledge-garden`    | An open book with growing branches         |
| 15     | `assistant-team-wiki`           | Three linked document cards                |
| 16     | `assistant-organize`            | Three differently sized cards in a folder  |
| 17     | `assistant-focus`               | Calm expression and one task card          |
| 18     | `assistant-review`              | Two documents, magnifier and checkmark     |
| 19     | `assistant-resume`              | Book, ribbon bookmark and forward arrow    |
| 20     | `assistant-all-set`             | Satisfied mascot, checkmark and two leaves |

Motifs 01 and 02 also have `-blank` variants in all three formats, making 22
files per format. Their text is typeset in the repository's Lobster font with
HarfBuzz shaping. The self-contained glyph outlines in `artwork/lettering/`
preserve the exact lettering without a runtime font dependency. Blank variants
retain the same illustration and speech bubble for translation.

The new series renders traced color regions with `crispEdges` while keeping
the separate alpha mask smooth, avoiding dark antialiasing seams in small SVG
previews. Text SVGs combine the traced empty bubble with the actual Lobster
outlines rather than tracing rasterized letters.

The [assistant prompt set](artwork/assistant-prompts.json) records the binding
references, prompts, focused correction and lettering method. The manifest
records the ordinal, review status, blank/text relationship and font source
hash. These assets are ready for review; adding them does not install new
workspace features or replace reader-owned content.

## Runtime Assets

Runtime-served branding files live in `client/branding/` and are exposed as
`/style/*` by the web and admin frontend images. Do not place editable source
files such as `.afdesign` in `client/branding/`, because that directory is
copied into release images and may be served publicly.

When a source asset in this directory should become part of the product, export
or normalize the required runtime files into `client/branding/` and keep the
source file here.

`client/libs/icons/src/assets/platform/browser-favicon.svg` is the reduced
B2-3 product mark used as the bundled runtime-branding fallback for the
`productMark` slot and as the source material for `/style/product-mark.svg`.
Browser favicons use the same B2-3 mark as a transparent, unframed icon. The
generated Electron/platform app icons use the same fixed B2-3 foreground
geometry inside their channel-specific app-icon background from
`client/libs/icons/scripts/build-assets.mjs`, not runtime-customizable branding.
`client/branding/` must not contain copied logo SVGs; build and dev tooling
materialize `/style/logo.svg` from `assets/branding/myoxus_text.svg`.
The About Myoxus screen uses the same fixed canonical wordmark source. It must
not consume runtime-customizable app/server branding. The old abstract
`Myoxus.*.svg` line marks are not valid Myoxus brand assets and must not be
regenerated.
