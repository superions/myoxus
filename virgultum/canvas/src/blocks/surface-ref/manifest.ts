// SPDX-License-Identifier: AGPL-3.0-or-later

/** Existing Surface-ref registration, composed by Editor assembly. */

import {
  type FeatureManifest,
  featureManifestId,
} from "@virgultum/core/extensions";

import { SurfaceRefStoreExtension } from "./store.js";
import { SurfaceRefViewExtension } from "./view.js";

export const surfaceRefManifest: FeatureManifest = {
  id: featureManifestId("surface-ref"),
  store: [SurfaceRefStoreExtension],
  view: [SurfaceRefViewExtension],
  publicExports: [
    ".",
    "./gfx",
    "./store",
    "./view",
    "./blocks",
    "./widgets",
    "./manifest",
  ],
  testTags: [],
};
