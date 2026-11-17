import { DividerBlockSchema } from "@virgultum/core/models";
import {
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
  HastUtils,
} from "@virgultum/core/adapters";
import { nanoid } from "@virgultum/core/store";

export const dividerBlockHtmlAdapterMatcher: BlockHtmlAdapterMatcher = {
  flavour: DividerBlockSchema.model.flavour,
  toMatch: (o) => HastUtils.isElement(o.node) && o.node.tagName === "hr",
  fromMatch: (o) => o.node.flavour === DividerBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: (o, context) => {
      if (!HastUtils.isElement(o.node)) {
        return;
      }
      const { walkerContext } = context;
      walkerContext
        .openNode(
          {
            type: "block",
            id: nanoid(),
            flavour: "myoxus:divider",
            props: {},
            children: [],
          },
          "children",
        )
        .closeNode();
    },
  },
  fromBlockSnapshot: {
    enter: (_, context) => {
      const { walkerContext } = context;
      walkerContext
        .openNode(
          {
            type: "element",
            tagName: "hr",
            properties: {},
            children: [],
          },
          "children",
        )
        .closeNode();
    },
  },
};

export const DividerBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  dividerBlockHtmlAdapterMatcher,
);
