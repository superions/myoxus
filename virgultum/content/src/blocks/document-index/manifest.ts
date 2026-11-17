// SPDX-License-Identifier: AGPL-3.0-or-later

/** Native document-index registration within Content; the guard checks the shared package surface. */
import {
  type FeatureManifest,
  featureManifestId,
} from "@virgultum/core/extensions";
import { DocumentIndexStoreExtension } from "./store";
import { DocumentIndexViewExtension } from "./view";
export const documentIndexManifest: FeatureManifest = {
  id: featureManifestId("document-index"),
  store: [DocumentIndexStoreExtension],
  view: [DocumentIndexViewExtension],
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
