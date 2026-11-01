import { EmbedLinkedDocBlockSchema } from "@virgultum/model";
import {
  AdapterTextUtils,
  configuredDocumentReferenceTitle,
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
} from "@virgultum/shared/adapters";

export const embedLinkedDocBlockHtmlAdapterMatcher: BlockHtmlAdapterMatcher = {
  flavour: EmbedLinkedDocBlockSchema.model.flavour,
  toMatch: () => false,
  fromMatch: (o) => o.node.flavour === EmbedLinkedDocBlockSchema.model.flavour,
  toBlockSnapshot: {},
  fromBlockSnapshot: {
    enter: (o, context) => {
      const { configs, walkerContext } = context;
      // Parse as link
      if (!o.node.props.pageId) {
        return;
      }
      const title =
        configuredDocumentReferenceTitle(
          configs,
          String(o.node.props.pageId),
          o.node.props.workspaceId as string | undefined,
        ) ?? "untitled";
      const url = AdapterTextUtils.generateDocUrl(
        configs.get("docLinkBaseUrl") ?? "",
        String(o.node.props.pageId),
        o.node.props.params ?? Object.create(null),
        o.node.props.workspaceId as string | undefined,
      );

      walkerContext
        .openNode(
          {
            type: "element",
            tagName: "div",
            properties: {
              className: ["myoxus-paragraph-block-container"],
            },
            children: [],
          },
          "children",
        )
        .openNode(
          {
            type: "element",
            tagName: "a",
            properties: {
              href: url,
            },
            children: [
              {
                type: "text",
                value: title,
              },
            ],
          },
          "children",
        )
        .closeNode()
        .closeNode();
    },
  },
};

export const EmbedLinkedDocHtmlAdapterExtension = BlockHtmlAdapterExtension(
  embedLinkedDocBlockHtmlAdapterMatcher,
);
