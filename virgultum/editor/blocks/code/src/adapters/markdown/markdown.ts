import { CodeBlockSchema } from "@virgultum/model";
import {
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
  CODE_BLOCK_WRAP_KEY,
  IN_PARAGRAPH_NODE_CONTEXT_KEY,
  type MarkdownAST,
  markdownHtmlTableNode,
} from "@virgultum/shared/adapters";
import { type DeltaInsert, nanoid } from "@virgultum/store";
import type { Code, Html } from "mdast";

const isCodeNode = (node: MarkdownAST): node is Code => node.type === "code";
const isHtmlNode = (node: MarkdownAST): node is Html => node.type === "html";

const isCodeOrHtmlNode = (node: MarkdownAST): node is Code | Html =>
  isCodeNode(node) || isHtmlNode(node);

const isMermaidCodeNode = (node: MarkdownAST): node is Code =>
  isCodeNode(node) &&
  typeof node.lang === "string" &&
  node.lang.trim().toLowerCase() === "mermaid";

export const codeBlockMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher = {
  flavour: CodeBlockSchema.model.flavour,
  toMatch: (o) =>
    isCodeOrHtmlNode(o.node) &&
    !isMermaidCodeNode(o.node) &&
    !markdownHtmlTableNode(o.node),
  fromMatch: (o) => o.node.flavour === "myoxus:code",
  toBlockSnapshot: {
    enter: (o, context) => {
      if (!isCodeOrHtmlNode(o.node)) {
        return;
      }

      const { walkerContext, configs } = context;
      const wrap = configs.get(CODE_BLOCK_WRAP_KEY) === "true";
      let language = "plain text";
      switch (o.node.type) {
        case "code": {
          if (o.node.lang) {
            language = o.node.lang;
          }
          break;
        }
        case "html": {
          const inParagraphNode = !!walkerContext.getGlobalContext(
            IN_PARAGRAPH_NODE_CONTEXT_KEY,
          );
          // only handle top level html node
          if (inParagraphNode) {
            return;
          }
          if (
            o.node.value.trim().toLowerCase().startsWith("<table") &&
            context.markdownImportDiagnostics
          ) {
            context.markdownImportDiagnostics.unsupportedTables =
              (context.markdownImportDiagnostics.unsupportedTables ?? 0) + 1;
          }
          language = "html";
          break;
        }
      }
      walkerContext
        .openNode(
          {
            type: "block",
            id: nanoid(),
            flavour: "myoxus:code",
            props: {
              language,
              wrap,
              text: {
                "$virgultum:internal:text$": true,
                delta: [
                  {
                    insert: o.node.value,
                  },
                ],
              },
            },
            children: [],
          },
          "children",
        )
        .closeNode();
    },
  },
  fromBlockSnapshot: {
    enter: (o, context) => {
      const text = (o.node.props.text ?? { delta: [] }) as {
        delta: DeltaInsert[];
      };
      const { walkerContext } = context;
      walkerContext
        .openNode(
          {
            type: "code",
            lang: (o.node.props.language as string) ?? null,
            meta: null,
            value: text.delta.map((delta) => delta.insert).join(""),
          },
          "children",
        )
        .closeNode();
    },
  },
};

export const CodeBlockMarkdownAdapterExtension = BlockMarkdownAdapterExtension(
  codeBlockMarkdownAdapterMatcher,
);
