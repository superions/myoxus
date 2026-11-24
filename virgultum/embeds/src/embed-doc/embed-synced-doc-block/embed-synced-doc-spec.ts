import { EmbedSyncedDocBlockSchema } from "@virgultum/core/models";
import { BlockViewExtension, FlavourExtension } from "@virgultum/core/runtime";
import type { ExtensionType } from "@virgultum/core/store";

import { createBuiltinToolbarConfigExtension } from "./configs/toolbar";
import { HeightInitializationExtension } from "./init-height-extension";

const flavour = EmbedSyncedDocBlockSchema.model.flavour;

export const EmbedSyncedDocViewExtensions: ExtensionType[] = [
  FlavourExtension(flavour),
  BlockViewExtension(flavour, (model) => {
    return model.parent?.flavour === "myoxus:surface"
      ? "myoxus-embed-edgeless-synced-doc-block"
      : "myoxus-embed-synced-doc-block";
  }),
  createBuiltinToolbarConfigExtension(flavour),
  HeightInitializationExtension,
].flat();
