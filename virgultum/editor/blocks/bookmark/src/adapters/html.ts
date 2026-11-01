import { createEmbedBlockHtmlAdapterMatcher } from "@virgultum/block-embed";
import { BookmarkBlockSchema } from "@virgultum/model";
import { BlockHtmlAdapterExtension } from "@virgultum/shared/adapters";

export const bookmarkBlockHtmlAdapterMatcher =
  createEmbedBlockHtmlAdapterMatcher(BookmarkBlockSchema.model.flavour);

export const BookmarkBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  bookmarkBlockHtmlAdapterMatcher,
);
