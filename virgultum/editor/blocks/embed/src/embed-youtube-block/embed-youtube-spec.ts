import { EmbedYoutubeBlockSchema } from "@virgultum/model";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
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
