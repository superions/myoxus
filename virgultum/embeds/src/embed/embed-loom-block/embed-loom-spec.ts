import { EmbedLoomBlockSchema } from "@virgultum/core/models";
import { BlockViewExtension, FlavourExtension } from "@virgultum/core/runtime";
import type { ExtensionType } from "@virgultum/core/store";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";

import { createBuiltinToolbarConfigExtension } from "../configs/toolbar";
import { embedLoomSlashMenuConfig } from "./configs/slash-menu";
import { EmbedLoomBlockInteraction } from "./embed-edgeless-loom-bock";
import { EmbedLoomBlockComponent } from "./embed-loom-block";
import {
  EmbedLoomBlockOptionConfig,
  EmbedLoomBlockService,
} from "./embed-loom-service";

const flavour = EmbedLoomBlockSchema.model.flavour;

export const EmbedLoomViewExtensions: ExtensionType[] = [
  FlavourExtension(flavour),
  EmbedLoomBlockService,
  BlockViewExtension(flavour, (model) => {
    return model.parent?.flavour === "myoxus:surface"
      ? "myoxus-embed-edgeless-loom-block"
      : "myoxus-embed-loom-block";
  }),
  EmbedLoomBlockOptionConfig,
  createBuiltinToolbarConfigExtension(flavour, EmbedLoomBlockComponent),
  SlashMenuConfigExtension(flavour, embedLoomSlashMenuConfig),
  EmbedLoomBlockInteraction,
].flat();
