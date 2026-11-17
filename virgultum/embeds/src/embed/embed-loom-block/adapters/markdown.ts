import { EmbedLoomBlockSchema } from "@virgultum/core/models";
import { BlockMarkdownAdapterExtension } from "@virgultum/core/adapters";

import { createEmbedBlockMarkdownAdapterMatcher } from "../../common/adapters/markdown.js";

export const embedLoomBlockMarkdownAdapterMatcher =
  createEmbedBlockMarkdownAdapterMatcher(EmbedLoomBlockSchema.model.flavour);

export const EmbedLoomMarkdownAdapterExtension = BlockMarkdownAdapterExtension(
  embedLoomBlockMarkdownAdapterMatcher,
);
