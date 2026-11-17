import { EmbedYoutubeBlockSchema } from "@virgultum/core/models";
import { BlockViewExtension, FlavourExtension } from "@virgultum/core/runtime";
import type { ExtensionType } from "@virgultum/core/store";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";
import { literal } from "lit/static-html.js";

import { createBuiltinToolbarConfigExtension } from "../configs/toolbar";
import { embedYoutubeSlashMenuConfig } from "./configs/slash-menu";
import { EmbedYoutubeBlockInteraction } from "./embed-edgeless-youtube-block";
import { EmbedYoutubeBlockComponent } from "./embed-youtube-block";
import {
  EmbedYoutubeBlockOptionConfig,
  EmbedYoutubeBlockService,
} from "./embed-youtube-service";

const flavour = EmbedYoutubeBlockSchema.model.flavour;

export const EmbedYoutubeViewExtensions: ExtensionType[] = [
  FlavourExtension(flavour),
  EmbedYoutubeBlockService,
  BlockViewExtension(flavour, (model) => {
    return model.parent?.flavour === "myoxus:surface"
      ? literal`myoxus-embed-edgeless-youtube-block`
      : literal`myoxus-embed-youtube-block`;
  }),
  EmbedYoutubeBlockOptionConfig,
  createBuiltinToolbarConfigExtension(flavour, EmbedYoutubeBlockComponent),
  SlashMenuConfigExtension("myoxus:embed-youtube", embedYoutubeSlashMenuConfig),
  EmbedYoutubeBlockInteraction,
].flat();
