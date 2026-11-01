import { ImageBlockSchema } from "@virgultum/model";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { literal } from "lit/static-html.js";

import { imageSlashMenuConfig } from "./configs/slash-menu";
import { createBuiltinToolbarConfigExtension } from "./configs/toolbar";
import { ImageEdgelessBlockInteraction } from "./image-edgeless-block";
import { ImageDropOption } from "./image-service";

const flavour = ImageBlockSchema.model.flavour;

export const ImageBlockSpec: ExtensionType[] = [
  FlavourExtension(flavour),
  BlockViewExtension(flavour, (model) => {
    const parent = model.store.getParent(model.id);

    if (parent?.flavour === "myoxus:surface") {
      return literal`myoxus-edgeless-image`;
    }

    return literal`myoxus-image`;
  }),
  ImageDropOption,
  ImageEdgelessBlockInteraction,
  createBuiltinToolbarConfigExtension(flavour),
  SlashMenuConfigExtension(flavour, imageSlashMenuConfig),
].flat();
