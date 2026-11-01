// SPDX-License-Identifier: MIT
import {
  preprocessFootnoteReferences,
  type MarkdownAdapterPreprocessor,
  MarkdownPreprocessorExtension,
} from "@virgultum/shared/adapters";
export const preprocessFootnoteReference = preprocessFootnoteReferences;

const footnoteReferencePreprocessor: MarkdownAdapterPreprocessor = {
  name: "footnote-reference",
  levels: ["block", "slice", "doc"],
  preprocess: (content) => {
    return preprocessFootnoteReference(content);
  },
};

export const FootnoteReferenceMarkdownPreprocessorExtension =
  MarkdownPreprocessorExtension(footnoteReferencePreprocessor);
