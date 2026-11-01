import { EmbedLoomBlockSchema } from "@virgultum/model";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { literal } from "lit/static-html.js";

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
      ? literal`myoxus-embed-edgeless-loom-block`
      : literal`myoxus-embed-loom-block`;
  }),
  EmbedLoomBlockOptionConfig,
  createBuiltinToolbarConfigExtension(flavour, EmbedLoomBlockComponent),
  SlashMenuConfigExtension(flavour, embedLoomSlashMenuConfig),
  EmbedLoomBlockInteraction,
].flat();
