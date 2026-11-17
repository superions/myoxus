import { createEmbedBlockPlainTextAdapterMatcher } from "../../embed/common/adapters/plain-text";
import { BookmarkBlockSchema } from "@virgultum/core/models";
import { BlockPlainTextAdapterExtension } from "@virgultum/core/adapters";

export const bookmarkBlockPlainTextAdapterMatcher =
  createEmbedBlockPlainTextAdapterMatcher(BookmarkBlockSchema.model.flavour);

export const BookmarkBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(bookmarkBlockPlainTextAdapterMatcher);
