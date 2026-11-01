import { MermaidBlockSchema } from "@virgultum/model";
import {
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
  type MarkdownAST,
} from "@virgultum/shared/adapters";
import { type DeltaInsert, nanoid } from "@virgultum/store";
import type { Code } from "mdast";

import { parseMermaidSourceToGfxVisualModel } from "../mermaid-gfx-graph-adapters.js";
import { getMermaidBlockTitle } from "../utils.js";
import { resolveMermaidBlockInsertIdentity } from "../mermaid-insert-identity.js";

export function isMermaidMarkdownCodeNode(node: MarkdownAST): node is Code {
  return (
    node.type === "code" &&
    typeof node.lang === "string" &&
    node.lang.trim().toLowerCase() === "mermaid"
  );
}

export function createMermaidBlockSnapshot(source: string, title = "") {
  const identity = resolveMermaidBlockInsertIdentity({ source, title });
  const parsed = parseMermaidSourceToGfxVisualModel(identity.source);
  return {
    type: "block" as const,
    id: nanoid(),
    flavour: MermaidBlockSchema.model.flavour,
    props: {
      diagramType: parsed.diagramType,
      diagramVersion: 1,
      displayMode: "edit",
      renderEngine: null,
      renderHash: null,
      source: {
        "$virgultum:internal:text$": true,
        delta: [
          {
            insert: identity.source,
          },
        ],
      },
      sourceHash: parsed.sourceHash,
      viewportHeight: null,
      title: {
        "$virgultum:internal:text$": true,
        delta: identity.title
          ? [
              {
                insert: identity.title,
              },
            ]
          : [],
      },
    },
    children: [],
  };
}

function textDeltaToString(text: unknown) {
  const delta = (text as { delta?: DeltaInsert[] } | undefined)?.delta ?? [];
  return delta.map((entry) => entry.insert).join("");
}

export const mermaidBlockMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher = {
  flavour: MermaidBlockSchema.model.flavour,
  toMatch: (o) => isMermaidMarkdownCodeNode(o.node),
  fromMatch: (o) => o.node.flavour === MermaidBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: (o, context) => {
      if (!isMermaidMarkdownCodeNode(o.node)) return;
      context.walkerContext
        .openNode(createMermaidBlockSnapshot(o.node.value), "children")
        .closeNode();
    },
  },
  fromBlockSnapshot: {
    enter: (o, context) => {
      const source = textDeltaToString(o.node.props.source);
      context.walkerContext
        .openNode(
          {
            type: "code",
            lang: "mermaid",
            meta: null,
            value: source,
          },
          "children",
        )
        .closeNode();
    },
  },
};

export const MermaidBlockMarkdownAdapterExtension =
  BlockMarkdownAdapterExtension(mermaidBlockMarkdownAdapterMatcher);

export const __test__ = {
  getMermaidBlockTitle,
  isMermaidMarkdownCodeNode,
};
