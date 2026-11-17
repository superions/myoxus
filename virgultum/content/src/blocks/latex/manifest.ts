// SPDX-License-Identifier: AGPL-3.0-or-later

/** Native latex registration within Content; the guard checks the shared package surface. */
import {
  type FeatureManifest,
  featureManifestId,
} from "@virgultum/core/extensions";

import { LatexStoreExtension } from "./store";
import { LatexViewExtension } from "./view";

export const latexManifest: FeatureManifest = {
  id: featureManifestId("latex"),
  store: [LatexStoreExtension],
  view: [LatexViewExtension],
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
