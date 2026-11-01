// SPDX-License-Identifier: MIT
import type { Blockquote, Literal, Root, Nodes } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

export interface CalloutHeader extends Literal {
  type: "myoxusCalloutHeader";
  value: string;
}
declare module "mdast" {
  interface PhrasingContentMap {
    myoxusCalloutHeader: CalloutHeader;
  }
  interface RootContentMap {
    myoxusCalloutHeader: CalloutHeader;
  }
  interface BlockquoteData {
    isCallout?: boolean;
    calloutEmoji?: string;
    calloutType?: string;
    calloutTitle?: string;
    calloutFoldable?: boolean;
    calloutDefaultOpen?: boolean;
    unsupportedCallout?: boolean;
  }
}

export const admittedCalloutChildren = (node: Blockquote): boolean => {
  let supported = true;
  visit(node, (child) => {
    if (child === node) return;
    if (
      [
        "html",
        "table",
        "math",
        "image",
        "thematicBreak",
        "myoxusDocumentEmbed",
      ].includes(child.type)
    )
      supported = false;
    if (child.type === "code" && child.lang?.toLowerCase() === "mermaid")
      supported = false;
  });
  return supported;
};

/** Extend the existing quote parser; unsupported constructs keep their full AST. */
export const remarkCallout: Plugin<[], Root> = function () {
  (this.data().toMarkdownExtensions ??= []).push({
    handlers: { myoxusCalloutHeader: (node) => (node as CalloutHeader).value },
  });
  return (tree, file) => {
    // Match the canonical codec's existing 100-block export bound, including
    // the page/note containers. Reject before the adapter creates any models.
    const pending: { node: Nodes; depth: number }[] = [
      { node: tree, depth: 2 },
    ];
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      const nextDepth =
        depth +
        (node.type === "blockquote" || node.type === "listItem" ? 1 : 0);
      if (nextDepth > 100)
        throw new Error(
          "Markdown block nesting exceeds the document recursion limit",
        );
      if ("children" in node)
        for (const child of node.children) {
          if ("children" in child)
            pending.push({ node: child, depth: nextDepth });
        }
    }
    const source = String(file.value ?? "");
    visit(tree, "blockquote", (node) => {
      const first = node.children[0];
      if (first?.type !== "paragraph") return;
      const offset = first.position?.start.offset;
      if (offset === undefined) return;
      const header = source.slice(offset).split(/\r?\n/, 1)[0];
      const typed = /^\[!([^\]]*)\]([^\r\n]*)$/.exec(header);
      if (!typed) return;
      const legacy = /^[\p{Extended_Pictographic}]?$/u.test(typed[1]);
      const semantic = /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(typed[1]);
      if ((!legacy && !semantic) || !admittedCalloutChildren(node)) {
        node.data = { ...node.data, unsupportedCallout: true };
        return;
      }
      node.data = {
        ...node.data,
        isCallout: true,
        ...(semantic
          ? {
              calloutType: typed[1],
              calloutTitle: typed[2].replace(/^[+-]/, "").trim(),
              calloutFoldable: /^[+-]/.test(typed[2]),
              calloutDefaultOpen: !typed[2].startsWith("-"),
            }
          : { calloutEmoji: typed[1] }),
      };
      if (semantic) {
        // Title occupies the complete first line, including its inline AST.
        // Keep all following body formatting and paragraph/list children.
        let bodyStarted = false;
        first.children = first.children.flatMap((child) => {
          if (bodyStarted) return [child];
          if (child.type === "text" && child.value.includes("\n")) {
            bodyStarted = true;
            const value = child.value.slice(child.value.indexOf("\n") + 1);
            return value ? [{ ...child, value }] : [];
          }
          if (
            (child.position?.start.line ?? 0) >
            (first.position?.start.line ?? 0)
          ) {
            bodyStarted = true;
            return [child];
          }
          return [];
        });
      } else {
        const initial = first.children[0];
        if (initial?.type === "text")
          initial.value = initial.value.replace(/^\[![^\]]*\][ \t]*\n?/, "");
        first.children = first.children.filter(
          (child) => child.type !== "text" || child.value.length > 0,
        );
      }
      if (!first.children.length) node.children = node.children.slice(1);
    });
  };
};
