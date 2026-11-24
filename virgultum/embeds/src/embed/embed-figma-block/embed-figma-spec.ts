import { EmbedFigmaBlockSchema } from "@virgultum/core/models";
import { BlockViewExtension, FlavourExtension } from "@virgultum/core/runtime";
import type { ExtensionType } from "@virgultum/core/store";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";

import { createBuiltinToolbarConfigExtension } from "../configs/toolbar";
import { embedFigmaSlashMenuConfig } from "./configs/slash-menu";
import { EmbedFigmaBlockInteraction } from "./embed-edgeless-figma-block";
import { EmbedFigmaBlockComponent } from "./embed-figma-block";
import { EmbedFigmaBlockOptionConfig } from "./embed-figma-service";

const flavour = EmbedFigmaBlockSchema.model.flavour;

export const EmbedFigmaViewExtensions: ExtensionType[] = [
  FlavourExtension(flavour),
  BlockViewExtension(flavour, (model) => {
    return model.parent?.flavour === "myoxus:surface"
      ? "myoxus-embed-edgeless-figma-block"
      : "myoxus-embed-figma-block";
  }),
  EmbedFigmaBlockOptionConfig,
  createBuiltinToolbarConfigExtension(flavour, EmbedFigmaBlockComponent),
  SlashMenuConfigExtension(flavour, embedFigmaSlashMenuConfig),
  EmbedFigmaBlockInteraction,
].flat();
