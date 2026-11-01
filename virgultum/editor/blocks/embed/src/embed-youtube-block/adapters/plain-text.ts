import { EmbedYoutubeBlockSchema } from "@virgultum/model";
import { BlockPlainTextAdapterExtension } from "@virgultum/shared/adapters";

import { createEmbedBlockPlainTextAdapterMatcher } from "../../common/adapters/plain-text.js";

export const embedYoutubeBlockPlainTextAdapterMatcher =
  createEmbedBlockPlainTextAdapterMatcher(
    EmbedYoutubeBlockSchema.model.flavour,
  );

export const EmbedYoutubeBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(embedYoutubeBlockPlainTextAdapterMatcher);
