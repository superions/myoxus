import { EmbedLoomBlockSchema } from "@virgultum/core/models";
import { BlockHtmlAdapterExtension } from "@virgultum/core/adapters";

import { createEmbedBlockHtmlAdapterMatcher } from "../../common/adapters/html.js";

export const embedLoomBlockHtmlAdapterMatcher =
  createEmbedBlockHtmlAdapterMatcher(EmbedLoomBlockSchema.model.flavour);

export const EmbedLoomBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  embedLoomBlockHtmlAdapterMatcher,
);
