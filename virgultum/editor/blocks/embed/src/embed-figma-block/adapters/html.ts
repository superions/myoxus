import { EmbedFigmaBlockSchema } from "@virgultum/model";
import { BlockHtmlAdapterExtension } from "@virgultum/shared/adapters";

import { createEmbedBlockHtmlAdapterMatcher } from "../../common/adapters/html.js";

export const embedFigmaBlockHtmlAdapterMatcher =
  createEmbedBlockHtmlAdapterMatcher(EmbedFigmaBlockSchema.model.flavour);

export const EmbedFigmaBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  embedFigmaBlockHtmlAdapterMatcher,
);
