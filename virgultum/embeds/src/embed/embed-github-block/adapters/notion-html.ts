import { EmbedGithubBlockSchema } from "@virgultum/core/models";
import { BlockNotionHtmlAdapterExtension } from "@virgultum/core/adapters";

import { createEmbedBlockNotionHtmlAdapterMatcher } from "../../common/adapters/notion-html.js";
import { githubUrlRegex } from "../embed-github-model.js";

export const embedGithubBlockNotionHtmlAdapterMatcher =
  createEmbedBlockNotionHtmlAdapterMatcher(
    EmbedGithubBlockSchema.model.flavour,
    githubUrlRegex,
  );

export const EmbedGithubBlockNotionHtmlAdapterExtension =
  BlockNotionHtmlAdapterExtension(embedGithubBlockNotionHtmlAdapterMatcher);
