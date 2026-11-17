import { EmbedGithubBlockSchema } from "@virgultum/core/models";
import { BlockPlainTextAdapterExtension } from "@virgultum/core/adapters";

import { createEmbedBlockPlainTextAdapterMatcher } from "../../common/adapters/plain-text.js";

export const embedGithubBlockPlainTextAdapterMatcher =
  createEmbedBlockPlainTextAdapterMatcher(EmbedGithubBlockSchema.model.flavour);

export const EmbedGithubBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(embedGithubBlockPlainTextAdapterMatcher);
