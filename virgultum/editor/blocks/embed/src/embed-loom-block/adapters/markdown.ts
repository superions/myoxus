import { EmbedLoomBlockSchema } from "@virgultum/model";
import { BlockMarkdownAdapterExtension } from "@virgultum/shared/adapters";

import { createEmbedBlockMarkdownAdapterMatcher } from "../../common/adapters/markdown.js";

export const embedLoomBlockMarkdownAdapterMatcher =
  createEmbedBlockMarkdownAdapterMatcher(EmbedLoomBlockSchema.model.flavour);

export const EmbedLoomMarkdownAdapterExtension = BlockMarkdownAdapterExtension(
  embedLoomBlockMarkdownAdapterMatcher,
);
