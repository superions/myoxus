import { ImageBlockSchema } from "@virgultum/core/models";
import { BlockViewExtension, FlavourExtension } from "@virgultum/core/runtime";
import type { ExtensionType } from "@virgultum/core/store";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";

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
      return "myoxus-edgeless-image";
    }

    return "myoxus-image";
  }),
  ImageDropOption,
  ImageEdgelessBlockInteraction,
  createBuiltinToolbarConfigExtension(flavour),
  SlashMenuConfigExtension(flavour, imageSlashMenuConfig),
].flat();
