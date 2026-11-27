// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type FeatureManifest,
  featureManifestId,
} from "@virgultum/core/extensions";
import { TableOfContentsStoreExtension } from "./store";
import { TableOfContentsViewExtension } from "./view";

export const tableOfContentsManifest: FeatureManifest = {
  id: featureManifestId("table-of-contents"),
  store: [TableOfContentsStoreExtension],
  view: [TableOfContentsViewExtension],
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
