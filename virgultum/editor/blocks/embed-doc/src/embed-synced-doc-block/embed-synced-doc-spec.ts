import { EmbedSyncedDocBlockSchema } from "@virgultum/model";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import { literal } from "lit/static-html.js";

import { createBuiltinToolbarConfigExtension } from "./configs/toolbar";
import { HeightInitializationExtension } from "./init-height-extension";

const flavour = EmbedSyncedDocBlockSchema.model.flavour;

export const EmbedSyncedDocViewExtensions: ExtensionType[] = [
  FlavourExtension(flavour),
  BlockViewExtension(flavour, (model) => {
    return model.parent?.flavour === "myoxus:surface"
      ? literal`myoxus-embed-edgeless-synced-doc-block`
      : literal`myoxus-embed-synced-doc-block`;
  }),
  createBuiltinToolbarConfigExtension(flavour),
  HeightInitializationExtension,
].flat();
