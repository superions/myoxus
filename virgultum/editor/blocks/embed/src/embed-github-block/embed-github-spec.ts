import { EmbedGithubBlockSchema } from "@virgultum/model";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { literal } from "lit/static-html.js";

import { createBuiltinToolbarConfigExtension } from "../configs/toolbar";
import { embedGithubSlashMenuConfig } from "./configs/slash-menu";
import { EmbedGithubBlockInteraction } from "./embed-edgeless-github-block";
import { EmbedGithubBlockComponent } from "./embed-github-block";
import {
  EmbedGithubBlockOptionConfig,
  EmbedGithubBlockService,
} from "./embed-github-service";

const flavour = EmbedGithubBlockSchema.model.flavour;

export const EmbedGithubViewExtensions: ExtensionType[] = [
  FlavourExtension(flavour),
  EmbedGithubBlockService,
  BlockViewExtension(flavour, (model) => {
    return model.parent?.flavour === "myoxus:surface"
      ? literal`myoxus-embed-edgeless-github-block`
      : literal`myoxus-embed-github-block`;
  }),
  EmbedGithubBlockOptionConfig,
  EmbedGithubBlockInteraction,
  createBuiltinToolbarConfigExtension(flavour, EmbedGithubBlockComponent),
  SlashMenuConfigExtension(flavour, embedGithubSlashMenuConfig),
].flat();
