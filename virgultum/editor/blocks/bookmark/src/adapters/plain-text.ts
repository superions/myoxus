import { createEmbedBlockPlainTextAdapterMatcher } from "@virgultum/block-embed";
import { BookmarkBlockSchema } from "@virgultum/model";
import { BlockPlainTextAdapterExtension } from "@virgultum/shared/adapters";

export const bookmarkBlockPlainTextAdapterMatcher =
  createEmbedBlockPlainTextAdapterMatcher(BookmarkBlockSchema.model.flavour);

export const BookmarkBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(bookmarkBlockPlainTextAdapterMatcher);
