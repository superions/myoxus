// SPDX-License-Identifier: AGPL-3.0-or-later

import { MermaidBlockSchema } from "@virgultum/core/models";
import {
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
  type MarkdownAST,
} from "@virgultum/core/adapters";
import { type DeltaInsert } from "@virgultum/core/store";
import type { Code } from "mdast";

import { getMermaidBlockTitle } from "../utils.js";

export function isMermaidMarkdownCodeNode(node: MarkdownAST): node is Code {
  return (
    node.type === "code" &&
    typeof node.lang === "string" &&
    node.lang.trim().toLowerCase() === "mermaid"
  );
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
    enter: async (o, context) => {
      if (!isMermaidMarkdownCodeNode(o.node)) return;
      const { createMermaidBlockSnapshot } = await import("./markdown.js");
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
