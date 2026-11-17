// SPDX-License-Identifier: AGPL-3.0-or-later
/** The bounded Rust Markdown table bridge; never general HTML admission. */
import DOMPurify from "dompurify";
import type { Element, Root, RootContent } from "hast";
import rehypeParse from "rehype-parse";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";

const parser = unified()
  .use(rehypeParse, { fragment: true, emitParseErrors: true })
  .use(() => (tree, file) => {
    file.data.tableAst = tree;
  })
  .use(rehypeStringify);
const writer = unified().use(rehypeStringify);
const maxBytes = 8 * 1024 * 1024;
export const markdownTableHtml = (node: RootContent | Root) =>
  writer.stringify(
    node.type === "root" ? node : { type: "root", children: [node] },
  );

export const safeMarkdownTableLink = (url: string) => {
  const value = url.trim();
  if (
    !value ||
    [...value].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || char === "\\";
    })
  )
    return false;
  const first = value.split(/[/?#]/u)[0];
  const colon = first.indexOf(":");
  return (
    colon < 0 ||
    ["http", "https", "mailto"].includes(first.slice(0, colon).toLowerCase())
  );
};

/** Only text-align belongs to Markdown, unlike the standalone HTML layout. */
export const markdownTableCellAlignment = (cell: Element) => {
  const style = cell.properties.style;
  if (style === undefined) return undefined;
  if (typeof style !== "string") return null;
  let alignment: "left" | "center" | "right" | undefined;
  for (const part of style.split(";").filter((part) => part.trim())) {
    const colon = part.indexOf(":");
    const value = part
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    if (
      colon < 0 ||
      part.slice(0, colon).trim().toLowerCase() !== "text-align" ||
      alignment !== undefined ||
      !(value === "left" || value === "center" || value === "right")
    )
      return null;
    alignment = value;
  }
  return alignment;
};
const elements = (node: Element | Root): Element[] | null => {
  const result: Element[] = [];
  for (const child of node.children) {
    if (child.type === "element") result.push(child);
    else if (child.type !== "text" || child.value.trim()) return null;
  }
  return result;
};
const inline = (node: Element, depth = 0, linked = false): boolean => {
  if (depth > 100) return false;
  return node.children.every((child) => {
    if (child.type === "text") return true;
    if (child.type !== "element") return false;
    if (child.tagName === "a") {
      if (
        linked ||
        Object.keys(child.properties).some((key) => key !== "href") ||
        typeof child.properties.href !== "string" ||
        !safeMarkdownTableLink(child.properties.href)
      )
        return false;
    } else if (
      Object.keys(child.properties).length ||
      !["strong", "b", "em", "i", "del", "s", "code", "br"].includes(
        child.tagName,
      )
    )
      return false;
    if (child.tagName === "br") return child.children.length === 0;
    return inline(child, depth + 1, linked || child.tagName === "a");
  });
};

/** Check raw AST before sanitizing, so removal cannot conceal unsupported input. */
export function parseMarkdownTableHtml(source: string): Element | null {
  if (
    source.length > maxBytes ||
    new TextEncoder().encode(source).length > maxBytes
  )
    return null;
  const trimmed = source.trim().toLowerCase();
  if (!trimmed.startsWith("<table") || !trimmed.endsWith("</table>"))
    return null;
  const file = parser.processSync(source);
  if (file.messages.length) return null;
  const root = file.data.tableAst as Root;
  const roots = elements(root);
  if (
    roots?.length !== 1 ||
    roots[0].tagName !== "table" ||
    Object.keys(roots[0].properties).length
  )
    return null;
  const table = roots[0];
  const sections = elements(table);
  if (!sections) return null;
  const rows: Element[] = [];
  let bodySeen = false;
  for (const section of sections) {
    if (Object.keys(section.properties).length) return null;
    if (section.tagName === "thead") {
      if (bodySeen) return null;
    } else if (["tbody", "tr"].includes(section.tagName)) bodySeen = true;
    else return null;
    const children = section.tagName === "tr" ? [section] : elements(section);
    if (!children) return null;
    rows.push(...children);
  }
  if (!rows.length) return null;
  let width: number | undefined;
  const alignments: Array<string | undefined> = [];
  for (const row of rows) {
    if (row.tagName !== "tr" || Object.keys(row.properties).length) return null;
    const cells = elements(row);
    if (!cells?.length || (width !== undefined && cells.length !== width))
      return null;
    width = cells.length;
    for (const [column, cell] of cells.entries()) {
      if (
        !["td", "th"].includes(cell.tagName) ||
        Object.keys(cell.properties).some((key) => key !== "style") ||
        !inline(cell)
      )
        return null;
      const alignment = markdownTableCellAlignment(cell);
      if (
        alignment === null ||
        (alignment !== undefined &&
          alignments[column] !== undefined &&
          alignment !== alignments[column])
      )
        return null;
      if (alignment !== undefined) alignments[column] = alignment;
    }
  }
  return (
    elements(parser.parse(DOMPurify.sanitize(source)) as Root)?.[0] ?? null
  );
}

// Registry match/enter/leave share the same parsed node without retaining files.
const admitted = new WeakMap<
  object,
  { source: string; table: Element | null }
>();
export function markdownHtmlTableNode(node: {
  type: string;
  value?: unknown;
}): Element | null {
  if (node.type !== "html" || typeof node.value !== "string") return null;
  const known = admitted.get(node);
  if (known?.source === node.value) return known.table;
  const table = parseMarkdownTableHtml(node.value);
  admitted.set(node, { source: node.value, table });
  return table;
}
