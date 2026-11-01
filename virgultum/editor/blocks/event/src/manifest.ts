// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `manifest.ts` - the `event` feature manifest for the
 * `@virgultum/block-event` package.
 *
 * As of P-VIRG-ARCH-C-02, the manifest for the `event`
 * block lives next to the block's source. The editor
 * aggregate imports this manifest via the `./manifest`
 * package export and contributes it to the
 * `FeatureManifestRegistry`.
 *
 * See `block-divider/src/manifest.ts` for the full
 * design notes; the `event` manifest follows the same
 * pattern. **No new runtime behaviour.**
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §C
 *      (P-VIRG-ARCH-C-02)
 */

import { type FeatureManifest, featureManifestId } from "@virgultum/ext-loader";

import { EventStoreExtension } from "./store.js";
import { EventViewExtension } from "./view.js";

export const eventManifest: FeatureManifest = {
  id: featureManifestId("event"),
  store: [EventStoreExtension],
  view: [EventViewExtension],
  publicExports: [".", "./view", "./store", "./manifest"],
  testTags: [],
};
