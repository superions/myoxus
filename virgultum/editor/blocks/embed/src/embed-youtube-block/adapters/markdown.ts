import { EmbedYoutubeBlockSchema } from "@virgultum/model";
import { BlockMarkdownAdapterExtension } from "@virgultum/shared/adapters";

import { createEmbedBlockMarkdownAdapterMatcher } from "../../common/adapters/markdown.js";

export const embedYoutubeBlockMarkdownAdapterMatcher =
  createEmbedBlockMarkdownAdapterMatcher(EmbedYoutubeBlockSchema.model.flavour);

export const EmbedYoutubeMarkdownAdapterExtension =
  BlockMarkdownAdapterExtension(embedYoutubeBlockMarkdownAdapterMatcher);
