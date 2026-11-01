import { EmbedLoomBlockSchema } from "@virgultum/model";
import { BlockPlainTextAdapterExtension } from "@virgultum/shared/adapters";

import { createEmbedBlockPlainTextAdapterMatcher } from "../../common/adapters/plain-text.js";

export const embedLoomBlockPlainTextAdapterMatcher =
  createEmbedBlockPlainTextAdapterMatcher(EmbedLoomBlockSchema.model.flavour);

export const EmbedLoomBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(embedLoomBlockPlainTextAdapterMatcher);
