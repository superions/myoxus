import { EmbedIframeBlockSchema } from "@virgultum/model";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { literal } from "lit/static-html.js";

import { embedIframeSlashMenuConfig } from "./configs/slash-menu/slash-menu";
import { createBuiltinToolbarConfigExtension } from "./configs/toolbar";
import { EmbedIframeInteraction } from "./embed-edgeless-iframe-block";

const flavour = EmbedIframeBlockSchema.model.flavour;

export const EmbedIframeViewExtensions: ExtensionType[] = [
  FlavourExtension(flavour),
  BlockViewExtension(flavour, (model) => {
    return model.parent?.flavour === "myoxus:surface"
      ? literal`myoxus-embed-edgeless-iframe-block`
      : literal`myoxus-embed-iframe-block`;
  }),
  createBuiltinToolbarConfigExtension(flavour),
  SlashMenuConfigExtension(flavour, embedIframeSlashMenuConfig),
  EmbedIframeInteraction,
].flat();
