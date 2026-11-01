// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ServiceProvider } from "@virgultum/editor/global/di";
import { MarkdownAdapter } from "@virgultum/editor/shared/adapters";
import type { Store } from "@virgultum/editor/store";
import type { Root, ListItem } from "mdast";
type Node = { text: string; children: Node[] };

/** AI returns one list root. Reject ambiguous forests rather than silently
 * dropping branches; inline formatting contributes its complete visible label. */
export const markdownToMindmap = (
  answer: string,
  doc: Store,
  provider: ServiceProvider,
): Node | null => {
  const markdown = new MarkdownAdapter(doc.getTransformer(), provider);
  const ast: Root = markdown["_markdownToAst"](answer);
  if (
    ast.children.length !== 1 ||
    ast.children[0].type !== "list" ||
    ast.children[0].children.length !== 1
  )
    return null;
  const label = (node: {
    type: string;
    value?: string;
    children?: unknown[];
  }): string => {
    if (node.type === "break") return "\n";
    if (typeof node.value === "string") return node.value;
    return (node.children ?? [])
      .map((child) => label(child as Parameters<typeof label>[0]))
      .join("");
  };
  const readItem = (item: ListItem): Node | null => {
    if (item.type !== "listItem") return null;
    const paragraphs = item.children.filter(
      (child) => child.type === "paragraph",
    );
    if (
      paragraphs.length !== 1 ||
      item.children.some(
        (child) => child.type !== "paragraph" && child.type !== "list",
      )
    )
      return null;
    const text = label(paragraphs[0]);
    if (!text.trim()) return null;
    const children: Node[] = [];
    for (const list of item.children) {
      if (list.type !== "list") continue;
      for (const child of list.children) {
        const parsed = readItem(child);
        if (!parsed) return null;
        children.push(parsed);
      }
    }
    return { text, children };
  };
  return readItem(ast.children[0].children[0]);
};
