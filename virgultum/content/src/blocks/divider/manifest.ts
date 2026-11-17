// SPDX-License-Identifier: AGPL-3.0-or-later

/** Native divider registration within Content; the guard checks the shared package surface. */
import {
  type FeatureManifest,
  featureManifestId,
} from "@virgultum/core/extensions";

import { DividerStoreExtension } from "./store";
import { DividerViewExtension } from "./view";

export const dividerManifest: FeatureManifest = {
  id: featureManifestId("divider"),
  store: [DividerStoreExtension],
  view: [DividerViewExtension],
  publicExports: [
    ".",
    "./rich-text",
    "./effects",
    "./blocks",
    "./store",
    "./view",
    "./painters/code",
    "./manifests",
    "./painters/list",
    "./painters/paragraph",
    "./inlines",
    "./title",
    "./caption",
    "./linked-doc-title",
    "./link-preview",
    "./syntax-highlighter",
    "./reference-notification",
    "./data",
  ],
  testTags: [],
};
