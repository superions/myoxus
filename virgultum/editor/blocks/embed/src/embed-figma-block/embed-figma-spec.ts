import { EmbedFigmaBlockSchema } from "@virgultum/model";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { literal } from "lit/static-html.js";

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
      ? literal`myoxus-embed-edgeless-figma-block`
      : literal`myoxus-embed-figma-block`;
  }),
  EmbedFigmaBlockOptionConfig,
  createBuiltinToolbarConfigExtension(flavour, EmbedFigmaBlockComponent),
  SlashMenuConfigExtension(flavour, embedFigmaSlashMenuConfig),
  EmbedFigmaBlockInteraction,
].flat();
