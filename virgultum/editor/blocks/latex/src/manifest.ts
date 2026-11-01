// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `manifest.ts` - the `latex` feature manifest for the
 * `@virgultum/block-latex` package.
 *
 * As of P-VIRG-ARCH-C-02, the manifest for the `latex`
 * block lives next to the block's source. The editor
 * aggregate imports this manifest via the `./manifest`
 * package export and contributes it to the
 * `FeatureManifestRegistry`.
 *
 * See `block-divider/src/manifest.ts` for the full
 * design notes; the `latex` manifest follows the same
 * pattern. **No new runtime behaviour.**
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-02)
 */

import { type FeatureManifest, featureManifestId } from "@virgultum/ext-loader";

import { LatexStoreExtension } from "./store.js";
import { LatexViewExtension } from "./view.js";

export const latexManifest: FeatureManifest = {
  id: featureManifestId("latex"),
  store: [LatexStoreExtension],
  view: [LatexViewExtension],
  publicExports: [".", "./view", "./store", "./manifest"],
  testTags: [],
};
