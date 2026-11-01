import { EmbedGithubBlockSchema } from "@virgultum/model";
import { BlockMarkdownAdapterExtension } from "@virgultum/shared/adapters";

import { createEmbedBlockMarkdownAdapterMatcher } from "../../common/adapters/markdown.js";

export const embedGithubBlockMarkdownAdapterMatcher =
  createEmbedBlockMarkdownAdapterMatcher(EmbedGithubBlockSchema.model.flavour);

export const EmbedGithubMarkdownAdapterExtension =
  BlockMarkdownAdapterExtension(embedGithubBlockMarkdownAdapterMatcher);
