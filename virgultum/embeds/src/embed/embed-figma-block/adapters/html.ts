import { EmbedFigmaBlockSchema } from "@virgultum/core/models";
import { BlockHtmlAdapterExtension } from "@virgultum/core/adapters";

import { createEmbedBlockHtmlAdapterMatcher } from "../../common/adapters/html.js";

export const embedFigmaBlockHtmlAdapterMatcher =
  createEmbedBlockHtmlAdapterMatcher(EmbedFigmaBlockSchema.model.flavour);

export const EmbedFigmaBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  embedFigmaBlockHtmlAdapterMatcher,
);
