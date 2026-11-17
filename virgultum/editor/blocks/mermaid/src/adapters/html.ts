import { MermaidBlockSchema } from "@virgultum/core/models";
import {
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
} from "@virgultum/core/adapters";

import { getMermaidBlockSource } from "../utils.js";

export const mermaidBlockHtmlAdapterMatcher: BlockHtmlAdapterMatcher = {
  flavour: MermaidBlockSchema.model.flavour,
  toMatch: () => false,
  fromMatch: (o) => o.node.flavour === MermaidBlockSchema.model.flavour,
  toBlockSnapshot: {},
  fromBlockSnapshot: {
    enter: async (o, context) => {
      const { getMermaidEffectiveBlockExportLabel } =
        await import("../mermaid-title-projection.js");
      context.walkerContext
        .openNode(
          {
            type: "element",
            tagName: "figure",
            properties: {
              ariaLabel: getMermaidEffectiveBlockExportLabel(o.node.props),
              className: ["myoxus-mermaid"],
              dataMyoxusBlockFlavour: MermaidBlockSchema.model.flavour,
              dataMyoxusMermaidSource: getMermaidBlockSource(o.node.props),
              role: "group",
            },
            children: [],
          },
          "children",
        )
        .closeNode();
    },
  },
};

export const MermaidBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  mermaidBlockHtmlAdapterMatcher,
);
