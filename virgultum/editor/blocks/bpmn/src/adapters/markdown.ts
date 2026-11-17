import { BpmnBlockSchema } from "@virgultum/core/models";
import {
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
} from "@virgultum/core/adapters";

import { getBpmnBlockExportMetadata } from "../utils.js";

export const bpmnBlockMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher = {
  flavour: BpmnBlockSchema.model.flavour,
  toMatch: () => false,
  fromMatch: (o) => o.node.flavour === BpmnBlockSchema.model.flavour,
  toBlockSnapshot: {},
  fromBlockSnapshot: {
    enter: (o, context) => {
      const { walkerContext } = context;
      const metadata = getBpmnBlockExportMetadata(o.node.props);
      walkerContext
        .openNode(
          {
            type: "blockquote",
            children: [
              {
                type: "paragraph",
                children: [
                  {
                    type: "text",
                    value: metadata.label,
                  },
                ],
              },
            ],
          },
          "children",
        )
        .closeNode();
    },
  },
};

export const BpmnBlockMarkdownAdapterExtension = BlockMarkdownAdapterExtension(
  bpmnBlockMarkdownAdapterMatcher,
);
