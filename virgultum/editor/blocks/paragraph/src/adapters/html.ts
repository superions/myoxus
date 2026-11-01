import {
  AnnotationSchema,
  ParagraphBlockSchema,
  type ParagraphPresentation,
} from "@virgultum/model";
import {
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
  HastUtils,
  type HtmlAST,
} from "@virgultum/shared/adapters";
import { type DeltaInsert, nanoid, type NodeProps } from "@virgultum/store";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";

type ParagraphDelta = DeltaInsert<MyoxusTextAttributes>;

const paragraphBlockMatchTags = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "body",
  "div",
  "span",
  "footer",
]);

const getParagraphPresentation = (
  value: unknown,
): ParagraphPresentation | undefined =>
  value === "eyebrow" ? value : undefined;

const tagsInAncestor = (o: NodeProps<HtmlAST>, tagNames: Array<string>) => {
  let parent = o.parent;
  while (parent) {
    if (
      HastUtils.isElement(parent.node) &&
      tagNames.includes(parent.node.tagName)
    ) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
};

const insideLocalDefinition = (o: NodeProps<HtmlAST>) => {
  let parent = o.parent;
  while (parent) {
    if (
      HastUtils.isElement(parent.node) &&
      parent.node.properties.dataMyoxusFootnoteDefinition !== undefined
    )
      return true;
    parent = parent.parent;
  }
  return false;
};

const splitDeltaByNewline = (delta: ParagraphDelta[]) => {
  const lines: ParagraphDelta[][] = [[]];
  const pending = [...delta];

  while (pending.length > 0) {
    const op = pending.shift();
    if (!op) continue;

    const insert = op.insert;
    // A recognized annotation is one logical body, including its line breaks.
    // Splitting it into paragraphs would duplicate its identity and lose pairing.
    if (AnnotationSchema.safeParse(op.attributes?.annotation).success) {
      lines[lines.length - 1].push(op);
      continue;
    }
    if (typeof insert !== "string") {
      lines[lines.length - 1].push(op);
      continue;
    }

    if (!insert.includes("\n")) {
      if (insert.length === 0) {
        continue;
      }
      lines[lines.length - 1].push(op);
      continue;
    }

    const splitIndex = insert.indexOf("\n");
    const linePart = insert.slice(0, splitIndex);
    const remainPart = insert.slice(splitIndex + 1);
    if (linePart.length > 0) {
      lines[lines.length - 1].push({ ...op, insert: linePart });
    }
    lines.push([]);
    if (remainPart) {
      pending.unshift({ ...op, insert: remainPart });
    }
  }

  return lines;
};

const hasBlockElementDescendant = (node: HtmlAST): boolean => {
  if (!HastUtils.isElement(node)) {
    return false;
  }
  return node.children.some((child) => {
    if (!HastUtils.isElement(child)) {
      return false;
    }
    return (
      (HastUtils.isTagBlock(child.tagName) && child.tagName !== "br") ||
      hasBlockElementDescendant(child)
    );
  });
};

const getParagraphDeltas = (
  node: HtmlAST,
  delta: ParagraphDelta[],
  keepHardBreaks = false,
): ParagraphDelta[][] => {
  // A native definition's normal paragraph owns its hard breaks. The generic
  // external-HTML line-to-paragraph fallback must not split that body block.
  if (keepHardBreaks) return [delta];
  if (!HastUtils.isElement(node)) return [delta];
  if (hasBlockElementDescendant(node)) return [delta];

  const hasBr = !!HastUtils.querySelector(node, "br");
  if (!hasBr) return [delta];

  const hasNewline = delta.some(
    (op) => typeof op.insert === "string" && op.insert.includes("\n"),
  );
  if (!hasNewline) return [delta];

  return splitDeltaByNewline(delta);
};

const openParagraphBlocks = (
  deltas: ParagraphDelta[][],
  type: string,
  // AST walker context from html adapter transform pipeline.
  walkerContext: any,
  presentation?: ParagraphPresentation,
) => {
  for (const delta of deltas) {
    walkerContext
      .openNode(
        {
          type: "block",
          id: nanoid(),
          flavour: "myoxus:paragraph",
          props: {
            type,
            ...(presentation ? { presentation } : {}),
            text: { "$virgultum:internal:text$": true, delta },
          },
          children: [],
        },
        "children",
      )
      .closeNode();
  }
};

const MULTI_PARAGRAPH_EMITTED_NODES_CONTEXT_KEY =
  "myoxus:paragraph:multi-emitted-nodes";

const markMultiParagraphEmitted = (walkerContext: any, node: HtmlAST) => {
  const emittedNodes =
    (walkerContext.getGlobalContext(
      MULTI_PARAGRAPH_EMITTED_NODES_CONTEXT_KEY,
    ) as WeakSet<object> | undefined) ?? new WeakSet<object>();
  emittedNodes.add(node as object);
  walkerContext.setGlobalContext(
    MULTI_PARAGRAPH_EMITTED_NODES_CONTEXT_KEY,
    emittedNodes,
  );
};

const consumeMultiParagraphEmittedMark = (
  walkerContext: any,
  node: HtmlAST,
) => {
  const emittedNodes = walkerContext.getGlobalContext(
    MULTI_PARAGRAPH_EMITTED_NODES_CONTEXT_KEY,
  ) as WeakSet<object> | undefined;
  if (!emittedNodes) {
    return false;
  }
  return emittedNodes.delete(node as object);
};

export const paragraphBlockHtmlAdapterMatcher: BlockHtmlAdapterMatcher = {
  flavour: ParagraphBlockSchema.model.flavour,
  toMatch: (o) =>
    HastUtils.isElement(o.node) &&
    paragraphBlockMatchTags.has(o.node.tagName) &&
    o.node.properties.dataMyoxusDocumentEmbed !== "reference",
  fromMatch: (o) => o.node.flavour === ParagraphBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: (o, context) => {
      if (!HastUtils.isElement(o.node)) {
        return;
      }
      const { walkerContext, deltaConverter } = context;
      switch (o.node.tagName) {
        case "blockquote": {
          walkerContext.setGlobalContext("hast:blockquote", true);
          // Special case for no paragraph in blockquote
          const texts = HastUtils.getTextChildren(o.node);
          // check if only blank text
          const onlyBlankText = texts.every((text) => !text.value.trim());
          if (texts && !onlyBlankText) {
            walkerContext
              .openNode(
                {
                  type: "block",
                  id: nanoid(),
                  flavour: "myoxus:paragraph",
                  props: {
                    type: "quote",
                    text: {
                      "$virgultum:internal:text$": true,
                      delta: deltaConverter.astToDelta(
                        HastUtils.getTextChildrenOnlyAst(o.node),
                      ),
                    },
                  },
                  children: [],
                },
                "children",
              )
              .closeNode();
          }
          break;
        }
        case "body":
        case "div":
        case "span":
        case "footer": {
          if (
            o.node.properties.className instanceof Array &&
            o.node.properties.className.includes(
              "myoxus-block-children-container",
            ) &&
            !o.node.children.length
          ) {
            walkerContext.skipAllChildren();
            break;
          }
          if (
            o.parent?.node.type === "element" &&
            !tagsInAncestor(o, ["p", "li"]) &&
            HastUtils.isParagraphLike(o.node)
          ) {
            const delta = deltaConverter.astToDelta(o.node);
            const deltas = getParagraphDeltas(
              o.node,
              delta,
              insideLocalDefinition(o),
            );
            openParagraphBlocks(deltas, "text", walkerContext);
            walkerContext.skipAllChildren();
          }
          break;
        }
        case "p": {
          const type = walkerContext.getGlobalContext("hast:blockquote")
            ? "quote"
            : "text";
          const presentation =
            type === "text"
              ? getParagraphPresentation(
                  o.node.properties.dataMyoxusParagraphPresentation,
                )
              : undefined;
          const delta = deltaConverter.astToDelta(o.node);
          const deltas = getParagraphDeltas(
            o.node,
            delta,
            insideLocalDefinition(o),
          );

          if (deltas.length > 1) {
            openParagraphBlocks(deltas, type, walkerContext, presentation);
            markMultiParagraphEmitted(walkerContext, o.node);
            walkerContext.skipAllChildren();
            break;
          }

          walkerContext.openNode(
            {
              type: "block",
              id: nanoid(),
              flavour: "myoxus:paragraph",
              props: {
                type,
                ...(presentation ? { presentation } : {}),
                text: {
                  "$virgultum:internal:text$": true,
                  delta,
                },
              },
              children: [],
            },
            "children",
          );
          break;
        }
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6": {
          walkerContext
            .openNode(
              {
                type: "block",
                id: nanoid(),
                flavour: "myoxus:paragraph",
                props: {
                  type: o.node.tagName,
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
          walkerContext.skipAllChildren();
          break;
        }
      }
    },
    leave: (o, context) => {
      if (!HastUtils.isElement(o.node)) {
        return;
      }
      const { walkerContext } = context;
      switch (o.node.tagName) {
        case "div": {
          if (
            o.parent?.node.type === "element" &&
            o.parent.node.tagName !== "li" &&
            Array.isArray(o.node.properties?.className)
          ) {
            if (
              o.node.properties.className.includes(
                "myoxus-paragraph-block-container",
              ) ||
              o.node.properties.className.includes(
                "myoxus-block-children-container",
              ) ||
              o.node.properties.className.includes("indented")
            ) {
              // Generated paragraph/children wrappers may both reach leave.
              // Neither wrapper owns the surrounding local definition frame.
              if (
                walkerContext.currentNode()?.flavour !==
                "myoxus:footnote-definition"
              )
                walkerContext.closeNode();
            }
          }
          break;
        }
        case "blockquote": {
          walkerContext.setGlobalContext("hast:blockquote", false);
          break;
        }
        case "p": {
          if (consumeMultiParagraphEmittedMark(walkerContext, o.node)) {
            break;
          }
          if (
            o.next?.type === "element" &&
            o.next.tagName === "div" &&
            Array.isArray(o.next.properties?.className) &&
            (o.next.properties.className.includes(
              "myoxus-block-children-container",
            ) ||
              o.next.properties.className.includes("indented"))
          ) {
            // Close the node when leaving div indented
            break;
          }
          if (
            walkerContext.currentNode()?.flavour !==
            "myoxus:footnote-definition"
          )
            walkerContext.closeNode();
          break;
        }
      }
    },
  },
  fromBlockSnapshot: {
    enter: (o, context) => {
      const text = (o.node.props.text ?? { delta: [] }) as {
        delta: DeltaInsert[];
      };
      const { walkerContext, deltaConverter } = context;
      switch (o.node.props.type) {
        case "text": {
          const presentation = getParagraphPresentation(
            o.node.props.presentation,
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
                tagName: "p",
                properties: presentation
                  ? { dataMyoxusParagraphPresentation: presentation }
                  : {},
                children: deltaConverter.deltaToAST(text.delta),
              },
              "children",
            )
            .closeNode()
            .openNode(
              {
                type: "element",
                tagName: "div",
                properties: {
                  className: ["myoxus-block-children-container"],
                  style: "padding-left: 26px;",
                },
                children: [],
              },
              "children",
            );
          break;
        }
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6": {
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
                tagName: o.node.props.type,
                properties: {},
                children: deltaConverter.deltaToAST(text.delta),
              },
              "children",
            )
            .closeNode()
            .openNode(
              {
                type: "element",
                tagName: "div",
                properties: {
                  className: ["myoxus-block-children-container"],
                  style: "padding-left: 26px;",
                },
                children: [],
              },
              "children",
            );
          break;
        }
        case "quote": {
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
                tagName: "blockquote",
                properties: {
                  className: ["quote"],
                },
                children: [],
              },
              "children",
            )
            .openNode(
              {
                type: "element",
                tagName: "p",
                properties: {},
                children: deltaConverter.deltaToAST(text.delta),
              },
              "children",
            )
            .closeNode()
            .closeNode()
            .openNode(
              {
                type: "element",
                tagName: "div",
                properties: {
                  className: ["myoxus-block-children-container"],
                  style: "padding-left: 26px;",
                },
                children: [],
              },
              "children",
            );
          break;
        }
      }
    },
    leave: (_, context) => {
      const { walkerContext } = context;
      walkerContext.closeNode().closeNode();
    },
  },
};

export const ParagraphBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  paragraphBlockHtmlAdapterMatcher,
);
