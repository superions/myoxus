import { ParagraphBlockSchema } from "@virgultum/model";
import {
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
  IN_PARAGRAPH_NODE_CONTEXT_KEY,
  isCalloutNode,
  type MarkdownAST,
  withMarkdownAnchor,
} from "@virgultum/shared/adapters";
import { type DeltaInsert, nanoid } from "@virgultum/store";
import type { Heading } from "mdast";

const PARAGRAPH_MDAST_TYPE = new Set(["paragraph", "heading", "blockquote"]);

const isParagraphMDASTType = (node: MarkdownAST) =>
  PARAGRAPH_MDAST_TYPE.has(node.type);

export const paragraphBlockMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher =
  {
    flavour: ParagraphBlockSchema.model.flavour,
    toMatch: (o) => isParagraphMDASTType(o.node) && !isCalloutNode(o.node),
    fromMatch: (o) => o.node.flavour === ParagraphBlockSchema.model.flavour,
    toBlockSnapshot: {
      enter: (o, context) => {
        const { walkerContext, deltaConverter } = context;
        switch (o.node.type) {
          case "paragraph": {
            // A definition's standalone image is already an ordinary content
            // child; do not add a synthetic empty body paragraph ahead of it.
            if (
              o.parent?.node.type === "footnoteDefinition" &&
              o.node.children.length === 1 &&
              o.node.children[0].type === "image"
            )
              return;
            walkerContext.setGlobalContext(IN_PARAGRAPH_NODE_CONTEXT_KEY, true);
            walkerContext
              .openNode(
                {
                  type: "block",
                  id: nanoid(),
                  flavour: "myoxus:paragraph",
                  props: {
                    type: "text",
                    markdownAnchor: o.node.data?.markdownAnchor,
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: deltaConverter.astToDelta(o.node),
                    },
                  },
                  children: [],
                },
                "children",
              )
              .closeNode();
            break;
          }
          case "heading": {
            const isCollapsed = !!o.node.data?.collapsed;
            walkerContext
              .openNode(
                {
                  type: "block",
                  id: nanoid(),
                  flavour: "myoxus:paragraph",
                  props: {
                    type: `h${o.node.depth}`,
                    collapsed: isCollapsed,
                    markdownAnchor: o.node.data?.markdownAnchor,
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: deltaConverter.astToDelta(o.node),
                    },
                  },
                  children: [],
                },
                "children",
              )
              .closeNode();
            break;
          }
          case "blockquote": {
            if (isCalloutNode(o.node)) {
              return;
            }

            const firstChild = o.node.children[0];
            walkerContext.openNode(
              {
                type: "block",
                id: nanoid(),
                flavour: "myoxus:paragraph",
                props: {
                  type: "quote",
                  markdownAnchor: o.node.data?.markdownAnchor,
                  text: {
                    "$virgultum:internal:text$": true,
                    delta:
                      firstChild?.type === "paragraph"
                        ? deltaConverter.astToDelta(firstChild)
                        : [],
                  },
                },
                children: [],
              },
              "children",
            );
            if (firstChild?.type === "paragraph") {
              walkerContext.skipChildren(1);
            }
            break;
          }
        }
      },
      leave: (o, context) => {
        const { walkerContext } = context;
        if (o.node.type === "paragraph") {
          walkerContext.setGlobalContext(IN_PARAGRAPH_NODE_CONTEXT_KEY, false);
        } else if (o.node.type === "blockquote" && !isCalloutNode(o.node)) {
          walkerContext.closeNode();
        }
      },
    },
    fromBlockSnapshot: {
      enter: (o, context) => {
        const { walkerContext, deltaConverter } = context;
        const paragraphDepth = (walkerContext.getGlobalContext(
          "myoxus:paragraph:depth",
        ) ?? 0) as number;
        const text = (o.node.props.text ?? { delta: [] }) as {
          delta: DeltaInsert[];
        };
        switch (o.node.props.type) {
          case "h1":
          case "h2":
          case "h3":
          case "h4":
          case "h5":
          case "h6": {
            walkerContext
              .openNode(
                {
                  type: "heading",
                  depth: parseInt(o.node.props.type[1]) as Heading["depth"],
                  children: withMarkdownAnchor(
                    deltaConverter.deltaToAST(text.delta, paragraphDepth),
                    o.node.props.markdownAnchor,
                  ),
                },
                "children",
              )
              .closeNode();
            break;
          }
          case "text": {
            walkerContext
              .openNode(
                {
                  type: "paragraph",
                  children: withMarkdownAnchor(
                    deltaConverter.deltaToAST(text.delta, paragraphDepth),
                    o.node.props.markdownAnchor,
                  ),
                },
                "children",
              )
              .closeNode();
            break;
          }
          case "quote": {
            walkerContext
              .openNode(
                {
                  type: "blockquote",
                  children: [],
                },
                "children",
              )
              .openNode(
                {
                  type: "paragraph",
                  children: withMarkdownAnchor(
                    deltaConverter.deltaToAST(text.delta, paragraphDepth),
                    o.node.props.markdownAnchor,
                  ),
                },
                "children",
              )
              .closeNode();
            break;
          }
        }
        if (o.node.props.type !== "quote") {
          walkerContext.setGlobalContext(
            "myoxus:paragraph:depth",
            paragraphDepth + 1,
          );
        }
      },
      leave: (o, context) => {
        const { walkerContext } = context;
        if (o.node.props.type === "quote") {
          walkerContext.closeNode();
          return;
        }
        walkerContext.setGlobalContext(
          "myoxus:paragraph:depth",
          (walkerContext.getGlobalContext("myoxus:paragraph:depth") as number) -
            1,
        );
      },
    },
  };

export const ParagraphBlockMarkdownAdapterExtension =
  BlockMarkdownAdapterExtension(paragraphBlockMarkdownAdapterMatcher);
