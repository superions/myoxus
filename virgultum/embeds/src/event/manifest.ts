// SPDX-License-Identifier: AGPL-3.0-or-later

/** Event registration remains explicit and is forwarded by the Editor assembly. */

import {
  type FeatureManifest,
  featureManifestId,
} from "@virgultum/core/extensions";

import { EventStoreExtension } from "./store.js";
import { EventViewExtension } from "./view.js";

export const eventManifest: FeatureManifest = {
  id: featureManifestId("event"),
  store: [EventStoreExtension],
  view: [EventViewExtension],
  publicExports: [
    ".",
    "./blocks",
    "./store",
    "./view",
    "./manifests",
    "./painters/image",
    "./painters/note",
    "./data",
    "./card-session",
  ],
  testTags: [],
};
