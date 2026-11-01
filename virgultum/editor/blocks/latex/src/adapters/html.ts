// SPDX-License-Identifier: AGPL-3.0-or-later
import { LatexBlockSchema } from "@virgultum/model";
import {
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
  HastUtils,
} from "@virgultum/shared/adapters";
import { nanoid } from "@virgultum/store";

export const latexBlockHtmlAdapterMatcher: BlockHtmlAdapterMatcher = {
  flavour: LatexBlockSchema.model.flavour,
  toMatch: ({ node }) =>
    HastUtils.isElement(node) &&
    node.tagName === "pre" &&
    typeof node.properties.dataMyoxusLatex === "string",
  fromMatch: ({ node }) => node.flavour === LatexBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: ({ node }, { walkerContext }) => {
      if (!HastUtils.isElement(node)) return;
      walkerContext
        .openNode(
          {
            type: "block",
            id: nanoid(),
            flavour: LatexBlockSchema.model.flavour,
            props: { latex: node.properties.dataMyoxusLatex as string },
            children: [],
          },
          "children",
        )
        .closeNode();
      walkerContext.skipAllChildren();
    },
  },
  fromBlockSnapshot: {
    enter: ({ node }, { walkerContext }) => {
      const latex = String(node.props.latex ?? "");
      // Portable reading HTML has no MathJax runtime. Show complete source and
      // retain a semantic marker for the registered HTML clipboard importer.
      walkerContext
        .openNode(
          {
            type: "element",
            tagName: "pre",
            properties: { dataMyoxusLatex: latex },
            children: [
              {
                type: "element",
                tagName: "code",
                properties: {},
                children: [{ type: "text", value: latex }],
              },
            ],
          },
          "children",
        )
        .closeNode();
    },
  },
};

export const LatexBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  latexBlockHtmlAdapterMatcher,
);
