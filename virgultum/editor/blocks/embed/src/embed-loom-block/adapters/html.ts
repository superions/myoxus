import { EmbedLoomBlockSchema } from "@virgultum/model";
import { BlockHtmlAdapterExtension } from "@virgultum/shared/adapters";

import { createEmbedBlockHtmlAdapterMatcher } from "../../common/adapters/html.js";

export const embedLoomBlockHtmlAdapterMatcher =
  createEmbedBlockHtmlAdapterMatcher(EmbedLoomBlockSchema.model.flavour);

export const EmbedLoomBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  embedLoomBlockHtmlAdapterMatcher,
);
