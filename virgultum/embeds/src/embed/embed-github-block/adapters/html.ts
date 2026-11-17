import { EmbedGithubBlockSchema } from "@virgultum/core/models";
import { BlockHtmlAdapterExtension } from "@virgultum/core/adapters";

import { createEmbedBlockHtmlAdapterMatcher } from "../../common/adapters/html.js";

export const embedGithubBlockHtmlAdapterMatcher =
  createEmbedBlockHtmlAdapterMatcher(EmbedGithubBlockSchema.model.flavour);

export const EmbedGithubBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  embedGithubBlockHtmlAdapterMatcher,
);
