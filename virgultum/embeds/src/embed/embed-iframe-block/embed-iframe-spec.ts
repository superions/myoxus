import { EmbedIframeBlockSchema } from "@virgultum/core/models";
import { BlockViewExtension, FlavourExtension } from "@virgultum/core/runtime";
import type { ExtensionType } from "@virgultum/core/store";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";

import { embedIframeSlashMenuConfig } from "./configs/slash-menu/slash-menu";
import { createBuiltinToolbarConfigExtension } from "./configs/toolbar";
import { EmbedIframeInteraction } from "./embed-edgeless-iframe-block";

const flavour = EmbedIframeBlockSchema.model.flavour;

export const EmbedIframeViewExtensions: ExtensionType[] = [
  FlavourExtension(flavour),
  BlockViewExtension(flavour, (model) => {
    return model.parent?.flavour === "myoxus:surface"
      ? "myoxus-embed-edgeless-iframe-block"
      : "myoxus-embed-iframe-block";
  }),
  createBuiltinToolbarConfigExtension(flavour),
  SlashMenuConfigExtension(flavour, embedIframeSlashMenuConfig),
  EmbedIframeInteraction,
].flat();
