import { EmbedFigmaBlockSchema } from "@virgultum/model";
import { BlockMarkdownAdapterExtension } from "@virgultum/shared/adapters";

import { createEmbedBlockMarkdownAdapterMatcher } from "../../common/adapters/markdown.js";

export const embedFigmaBlockMarkdownAdapterMatcher =
  createEmbedBlockMarkdownAdapterMatcher(EmbedFigmaBlockSchema.model.flavour);

export const EmbedFigmaMarkdownAdapterExtension = BlockMarkdownAdapterExtension(
  embedFigmaBlockMarkdownAdapterMatcher,
);
