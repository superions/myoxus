import { RootBlockSchema } from "@virgultum/model";
import {
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
  HastUtils,
} from "@virgultum/shared/adapters";

export const rootBlockHtmlAdapterMatcher: BlockHtmlAdapterMatcher = {
  flavour: RootBlockSchema.model.flavour,
  toMatch: (o) => HastUtils.isElement(o.node) && o.node.tagName === "header",
  fromMatch: (o) => o.node.flavour === RootBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: (o, context) => {
      if (!HastUtils.isElement(o.node)) {
        return;
      }
      const { walkerContext } = context;
      if (o.node.tagName === "header") {
        walkerContext.skipAllChildren();
      }
    },
  },
  fromBlockSnapshot: {
    enter: (_, context) => {
      const { walkerContext } = context;
      const htmlRootDocContext =
        walkerContext.getGlobalContext("hast:html-root-doc");
      const isRootDoc = htmlRootDocContext ?? true;
      if (!isRootDoc) {
        return;
      }

      walkerContext
        .openNode(
          {
            type: "element",
            tagName: "html",
            properties: {},
            children: [],
          },
          "children",
        )
        .openNode(
          {
            type: "element",
            tagName: "head",
            properties: {},
            children: [
              {
                type: "element",
                tagName: "meta",
                properties: { charSet: "utf-8" },
                children: [],
              },
            ],
          },
          "children",
        )
        .openNode(
          {
            type: "element",
            tagName: "style",
            properties: {},
            children: [],
          },
          "children",
        )
        .openNode(
          {
            type: "text",
            value: `
            .todo-list {
              list-style: none;
              padding-inline-start: 1.5rem;
            }
            .todo-list-label {
              align-items: baseline;
              display: inline-flex;
              gap: 0.5rem;
            }
            `.replace(/\s\s+/g, ""),
          },
          "children",
        )
        .closeNode()
        .closeNode()
        .closeNode()
        .openNode(
          {
            type: "element",
            tagName: "body",
            properties: {},
            children: [],
          },
          "children",
        )
        .openNode(
          {
            type: "element",
            tagName: "div",
            properties: {
              style: "width: 70vw; margin: 60px auto;",
            },
            children: [],
          },
          "children",
        )
        .openNode({
          type: "comment",
          value: "VirgultumDocTitlePlaceholder",
        })
        .closeNode();
    },
    leave: (_, context) => {
      const { walkerContext } = context;
      const htmlRootDocContext =
        walkerContext.getGlobalContext("hast:html-root-doc");
      const isRootDoc = htmlRootDocContext ?? true;
      if (!isRootDoc) {
        return;
      }
      walkerContext.closeNode().closeNode().closeNode();
    },
  },
};

export const RootBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  rootBlockHtmlAdapterMatcher,
);
