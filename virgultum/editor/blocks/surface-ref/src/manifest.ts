// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `manifest.ts` - the `surface-ref` feature manifest
 * for the `@virgultum/block-surface-ref` package.
 *
 * As of P-VIRG-ARCH-C-02, the manifest for the
 * `surface-ref` block lives next to the block's
 * source. The editor aggregate imports this manifest
 * via the `./manifest` package export and contributes
 * it to the `FeatureManifestRegistry`.
 *
 * See `block-divider/src/manifest.ts` for the full
 * design notes; the `surface-ref` manifest follows the
 * same pattern. **No new runtime behaviour.**
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-02)
 */

import { type FeatureManifest, featureManifestId } from "@virgultum/ext-loader";

import { SurfaceRefStoreExtension } from "./store.js";
import { SurfaceRefViewExtension } from "./view.js";

export const surfaceRefManifest: FeatureManifest = {
  id: featureManifestId("surface-ref"),
  store: [SurfaceRefStoreExtension],
  view: [SurfaceRefViewExtension],
  publicExports: [".", "./view", "./store", "./manifest"],
  testTags: [],
};
