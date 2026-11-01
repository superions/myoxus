import { BpmnBlockSchema } from "@virgultum/model";
import {
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
} from "@virgultum/shared/adapters";

import { getBpmnBlockExportMetadata } from "../utils.js";

export const bpmnBlockHtmlAdapterMatcher: BlockHtmlAdapterMatcher = {
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
            type: "element",
            tagName: "figure",
            properties: {
              className: ["myoxus-bpmn"],
              dataMyoxusBlockFlavour: BpmnBlockSchema.model.flavour,
              role: "group",
            },
            children: [
              {
                type: "element",
                tagName: "figcaption",
                properties: {},
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

export const BpmnBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  bpmnBlockHtmlAdapterMatcher,
);
