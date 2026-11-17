import { createEmbedBlockHtmlAdapterMatcher } from "../../embed/common/adapters/html";
import { BookmarkBlockSchema } from "@virgultum/core/models";
import { BlockHtmlAdapterExtension } from "@virgultum/core/adapters";

export const bookmarkBlockHtmlAdapterMatcher =
  createEmbedBlockHtmlAdapterMatcher(BookmarkBlockSchema.model.flavour);

export const BookmarkBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  bookmarkBlockHtmlAdapterMatcher,
);
