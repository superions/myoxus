// SPDX-License-Identifier: MIT
import {
  preprocessCitationDefinitions,
  type MarkdownAdapterPreprocessor,
  MarkdownPreprocessorExtension,
} from "@virgultum/shared/adapters";
export const footnoteUrlPreprocessor = preprocessCitationDefinitions;

const bookmarkBlockPreprocessor: MarkdownAdapterPreprocessor = {
  name: "bookmark-block",
  levels: ["block", "slice", "doc"],
  preprocess: footnoteUrlPreprocessor,
};
export const BookmarkBlockMarkdownPreprocessorExtension =
  MarkdownPreprocessorExtension(bookmarkBlockPreprocessor);
