// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `manifest.ts` - the `mermaid` feature manifest for the
 * `@virgultum/block-mermaid` package.
 *
 * As of P-VIRG-ARCH-I-02, the manifest for the `mermaid`
 * block lives next to the block's source. The editor
 * aggregate (`@virgultum/editor/all`) imports this
 * manifest via the `./manifest` package export and
 * contributes it to the `FeatureManifestRegistry`
 * alongside the other features.
 *
 * The manifest is the **single source of truth** for
 * what this package contributes to the editor
 * aggregate: one store extension, one view extension,
 * and the entry-points (`./`, `./view`, `./store`,
 * `./manifest`) the package surfaces. The C-03
 * consistency guard will fail the build if the
 * `package.json` `exports` map and the `publicExports`
 * array drift apart.
 *
 * The `FeatureManifest` types are imported from
 * `@virgultum/ext-loader` (a leaf package the block
 * packages already depend on) to avoid a circular
 * dependency on `@virgultum/editor/all`.
 *
 * **No new runtime behaviour.** The store/view
 * extension classes referenced here are the same
 * classes the aggregate imported inline pre-I-02; the
 * manifest is a declaration, not a re-implementation.
 *
 * **Mermaid-specific design notes:**
 *
 * - **`hostServices: []`** is declared explicitly even
 *   though Mermaid currently does not call any host
 *   service. This is intentional: the I-01 inventory
 *   closed I-PRE-FIND-05 by establishing that Mermaid
 *   has no host-service consumer today. A future
 *   server capability would have to declare its typed
 *   host-service dependency here.
 *   Declaring the slot as an empty array now documents
 *   the contract and unblocks the manifest-slot-shape
 *   guard (C-03) without forcing a later migration.
 *   See `docs/dev/virgultum/closeouts/phase-i.md`
 *   Befund 3 for the original finding.
 *
 * - **No `scopes` override** — the Mermaid block
 *   registers in both `page` and `edgeless` mode (the
 *   default). The I-01 inventory documented
 *   `mermaid-block.ts:1619-1624` reads
 *   `DocModeProvider.getEditorMode()` directly; the fix
 *   is scheduled for I-03 and will keep both modes
 *   active.
 *
 * - **`testTags: []`** — the Mermaid package has a
 *   dedicated `mermaid-block.unit.spec.ts` today but
 *   no `testTags` is wired through the registry; this
 *   is consistent with the four C-02 migrations
 *   (`divider`, `event`, `latex`, `surface-ref`).
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-02 reference)
 * @see docs/dev/virgultum/closeouts/phase-i.md
 *      (P-VIRG-ARCH-I-01 inventory)
 */

import { type FeatureManifest, featureManifestId } from "@virgultum/ext-loader";

import { MermaidStoreExtension } from "./store.js";
import { MermaidViewExtension } from "./view.js";

/**
 * The `mermaid` feature manifest. The id matches the
 * `FeatureManifestId` the editor aggregate uses to
 * position this feature in the store and view
 * orderings.
 */
export const mermaidManifest: FeatureManifest = {
  id: featureManifestId("mermaid"),
  store: [MermaidStoreExtension],
  view: [MermaidViewExtension],
  /**
   * Entry-points the package surfaces. Mirrors the
   * `exports` field in `package.json`. The C-03 guard
   * verifies that every entry-point listed here is
   * also declared in `package.json` and that the
   * manifest itself is exported at `./manifest`.
   */
  publicExports: [".", "./view", "./store", "./manifest"],
  /**
   * Host-service capabilities the feature requires.
   * Mermaid currently consumes no host service. The
   * slot is declared as an empty array to document
   * the contract; a future server capability would add
   * its typed dependency here.
   *
   * Typed as `ReadonlyArray<string>` per the loose
   * contract in `@virgultum/ext-loader`. The editor
   * aggregate re-exports a stricter variant bound to
   * `MyoxusHostCapability`; block packages are
   * expected to use this loose version.
   */
  hostServices: [],
  /**
   * Test tags the mermaid block's specs add. Empty
   * until a future migration wires tags through the
   * registry (consistent with the C-02 pattern).
   */
  testTags: [],
};
