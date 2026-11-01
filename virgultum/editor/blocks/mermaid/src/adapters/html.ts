import { MermaidBlockSchema } from "@virgultum/model";
import {
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
} from "@virgultum/shared/adapters";

import { getMermaidBlockSource } from "../utils.js";
import { getMermaidEffectiveBlockExportLabel } from "../mermaid-title-projection.js";

export const mermaidBlockHtmlAdapterMatcher: BlockHtmlAdapterMatcher = {
  flavour: MermaidBlockSchema.model.flavour,
  toMatch: () => false,
  fromMatch: (o) => o.node.flavour === MermaidBlockSchema.model.flavour,
  toBlockSnapshot: {},
  fromBlockSnapshot: {
    enter: (o, context) => {
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
