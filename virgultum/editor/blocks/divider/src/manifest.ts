// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `manifest.ts` - the `divider` feature manifest for the
 * `@virgultum/block-divider` package.
 *
 * As of P-VIRG-ARCH-C-02, the manifest for the `divider`
 * block lives next to the block's source. The editor
 * aggregate (`@virgultum/editor/all`) imports this
 * manifest via the `./manifest` package export and
 * contributes it to the
 * `FeatureManifestRegistry` alongside the other
 * features.
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
 * classes the aggregate imported inline in C-01; the
 * manifest is a declaration, not a re-implementation.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-02)
 */

import { type FeatureManifest, featureManifestId } from "@virgultum/ext-loader";

import { DividerStoreExtension } from "./store.js";
import { DividerViewExtension } from "./view.js";

/**
 * The `divider` feature manifest. The id matches the
 * `FeatureManifestId` the editor aggregate uses to
 * position this feature in the store and view
 * orderings.
 */
export const dividerManifest: FeatureManifest = {
  id: featureManifestId("divider"),
  store: [DividerStoreExtension],
  view: [DividerViewExtension],
  /**
   * Entry-points the package surfaces. Mirrors the
   * `exports` field in `package.json`. The C-03 guard
   * verifies that every entry-point listed here is
   * also declared in `package.json` and that the
   * manifest itself is exported at `./manifest`.
   */
  publicExports: [".", "./view", "./store", "./manifest"],
  /**
   * Test tags the divider block's specs add. The
   * divider package has no dedicated spec today; the
   * entry stays empty until one is added (and C-03
   * will assert that the spec's tag, when added, is
   * listed here).
   */
  testTags: [],
};
