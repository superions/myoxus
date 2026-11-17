import { EmbedYoutubeBlockSchema } from "@virgultum/core/models";
import { BlockPlainTextAdapterExtension } from "@virgultum/core/adapters";

import { createEmbedBlockPlainTextAdapterMatcher } from "../../common/adapters/plain-text.js";

export const embedYoutubeBlockPlainTextAdapterMatcher =
  createEmbedBlockPlainTextAdapterMatcher(
    EmbedYoutubeBlockSchema.model.flavour,
  );

export const EmbedYoutubeBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(embedYoutubeBlockPlainTextAdapterMatcher);
