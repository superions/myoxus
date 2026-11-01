import { EmbedGithubBlockSchema } from "@virgultum/model";
import { BlockPlainTextAdapterExtension } from "@virgultum/shared/adapters";

import { createEmbedBlockPlainTextAdapterMatcher } from "../../common/adapters/plain-text.js";

export const embedGithubBlockPlainTextAdapterMatcher =
  createEmbedBlockPlainTextAdapterMatcher(EmbedGithubBlockSchema.model.flavour);

export const EmbedGithubBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(embedGithubBlockPlainTextAdapterMatcher);
