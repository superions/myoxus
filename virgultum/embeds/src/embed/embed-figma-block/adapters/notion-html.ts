import { EmbedFigmaBlockSchema } from "@virgultum/core/models";
import { BlockNotionHtmlAdapterExtension } from "@virgultum/core/adapters";

import { createEmbedBlockNotionHtmlAdapterMatcher } from "../../common/adapters/notion-html.js";
import { figmaUrlRegex } from "../embed-figma-model.js";

export const embedFigmaBlockNotionHtmlAdapterMatcher =
  createEmbedBlockNotionHtmlAdapterMatcher(
    EmbedFigmaBlockSchema.model.flavour,
    figmaUrlRegex,
  );

export const EmbedFigmaBlockNotionHtmlAdapterExtension =
  BlockNotionHtmlAdapterExtension(embedFigmaBlockNotionHtmlAdapterMatcher);
