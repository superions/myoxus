// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  HastUtils,
  HtmlASTToDeltaExtension,
  InlineDeltaToHtmlAdapterExtension,
} from "@virgultum/shared/adapters";

export const latexDeltaToHtml = InlineDeltaToHtmlAdapterExtension({
  name: "inlineLatex",
  match: (delta) => typeof delta.attributes?.latex === "string",
  toAST: (delta) => ({
    type: "element",
    tagName: "code",
    properties: { dataMyoxusLatex: delta.attributes?.latex },
    children: [{ type: "text", value: delta.attributes?.latex ?? "" }],
  }),
});

export const htmlLatexToDelta = HtmlASTToDeltaExtension({
  name: "inlineLatex",
  match: (node) =>
    HastUtils.isElement(node) &&
    node.tagName === "code" &&
    typeof node.properties.dataMyoxusLatex === "string",
  toDelta: (node) =>
    HastUtils.isElement(node)
      ? [
          {
            insert: " ",
            attributes: { latex: node.properties.dataMyoxusLatex as string },
          },
        ]
      : [],
});
