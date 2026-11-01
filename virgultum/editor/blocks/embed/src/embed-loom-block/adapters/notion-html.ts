import { EmbedLoomBlockSchema } from "@virgultum/model";
import { BlockNotionHtmlAdapterExtension } from "@virgultum/shared/adapters";

import { createEmbedBlockNotionHtmlAdapterMatcher } from "../../common/adapters/notion-html.js";
import { loomUrlRegex } from "../embed-loom-model.js";

export const embedLoomBlockNotionHtmlAdapterMatcher =
  createEmbedBlockNotionHtmlAdapterMatcher(
    EmbedLoomBlockSchema.model.flavour,
    loomUrlRegex,
  );

export const EmbedLoomBlockNotionHtmlAdapterExtension =
  BlockNotionHtmlAdapterExtension(embedLoomBlockNotionHtmlAdapterMatcher);
