// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  FootNoteReferenceParamsSchema,
  type FootNoteReferenceParams,
} from "@virgultum/model";
import type { FootnoteDefinition, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { remarkGfm } from "./gfm";

export const LOCAL_FOOTNOTE_PREFIX = "localFootnote:";

/** Paste whitespace cleanup must preserve the parser-owned definition body. */
export function getMarkdownFootnoteRanges(source: string) {
  const ast = unified().use(remarkParse).use(remarkGfm).parse(source);
  const ranges: { start: number; end: number }[] = [];
  visit(ast, "footnoteDefinition", (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) ranges.push({ start, end });
  });
  return ranges;
}

/** Use the existing GFM identifier convention while retaining source labels. */
export const normalizeFootnoteLabel = (label: string) =>
  label
    .replace(/[\t\n\r ]+/g, " ")
    .trim()
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();

export function citationDefinition(
  node: FootnoteDefinition,
): FootNoteReferenceParams | undefined {
  if (node.children.length !== 1) return;
  const paragraph = node.children[0];
  if (
    paragraph.type !== "paragraph" ||
    paragraph.children.some((child) => child.type !== "text")
  )
    return;
  const text = paragraph.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    if (
      text.trimStart().startsWith("{") &&
      /"type"\s*:\s*"(?:doc|attachment|url)"/.test(text)
    )
      throw new Error(
        `Invalid citation definition: ${node.label ?? node.identifier}`,
      );
    return;
  }
  if (!value || typeof value !== "object" || !("type" in value)) return;
  if (
    !(
      typeof value.type === "string" &&
      ["doc", "attachment", "url"].includes(value.type)
    ) &&
    !["docId", "blobId", "url"].some((key) => key in value)
  )
    return;
  const result = FootNoteReferenceParamsSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      `Invalid citation definition: ${node.label ?? node.identifier}`,
    );
  const reference = result.data;
  const target =
    reference.type === "doc"
      ? reference.docId
      : reference.type === "attachment"
        ? reference.blobId
        : reference.url;
  if (!target?.trim())
    throw new Error(
      `Missing citation target: ${node.label ?? node.identifier}`,
    );
  return reference;
}

function validateCitationEncoding(
  reference: FootNoteReferenceParams | undefined,
  label: string,
) {
  for (const key of ["url", "favicon"] as const) {
    const value = reference?.[key];
    if (!value || value.includes(":") || !value.includes("%")) continue;
    try {
      decodeURIComponent(value);
    } catch {
      throw new Error(`Invalid citation URL encoding: ${label}`);
    }
  }
}

/** Validate the complete AST before any block/asset adapter can materialize it. */
export function validateFootnoteDefinitions(root: Root) {
  const definitions = new Map<string, FootnoteDefinition>();
  const visit = (
    node:
      Root | Root["children"][number] | FootnoteDefinition["children"][number],
    insideDefinition = false,
  ) => {
    if (node.type === "footnoteDefinition") {
      if (insideDefinition)
        throw new Error(
          `Nested footnote definition: ${node.label ?? node.identifier}`,
        );
      const key = normalizeFootnoteLabel(node.identifier);
      if (definitions.has(key))
        throw new Error(
          `Conflicting footnote definition: ${node.label ?? node.identifier}`,
        );
      definitions.set(key, node);
      validateCitationEncoding(
        citationDefinition(node),
        node.label ?? node.identifier,
      );
      for (const child of node.children) visit(child, true);
    } else if (node.type === "footnoteReference") {
      if (insideDefinition)
        throw new Error(
          `Nested footnote reference: ${node.label ?? node.identifier}`,
        );
    } else if ("children" in node) {
      for (const child of node.children)
        visit(child as Parameters<typeof visit>[0], insideDefinition);
    }
  };
  visit(root);
  const check = (node: Parameters<typeof visit>[0]) => {
    if (
      node.type === "footnoteReference" &&
      !definitions.has(normalizeFootnoteLabel(node.identifier))
    )
      throw new Error(
        `Missing footnote definition: ${node.label ?? node.identifier}`,
      );
    if ("children" in node)
      for (const child of node.children)
        check(child as Parameters<typeof visit>[0]);
  };
  check(root);
  return definitions;
}

function isFullyEncoded(uri: string): boolean {
  try {
    return uri === encodeURIComponent(decodeURIComponent(uri));
  } catch {
    return false;
  }
}

/** Rewrite only AST-owned complete legacy citations, never code or rich bodies. */
export function preprocessCitationDefinitions(content: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm, { deferAutolinks: true, withoutAutolinks: true });
  const ast = processor.runSync(processor.parse(content)) as Root;
  const replacements: { start: number; end: number; value: string }[] = [];
  visit(ast, "footnoteDefinition", (node) => {
    let reference: FootNoteReferenceParams | undefined;
    try {
      reference = citationDefinition(node);
      validateCitationEncoding(reference, node.label ?? node.identifier);
    } catch {
      return;
    }
    const paragraph = node.children[0];
    if (!reference || paragraph?.type !== "paragraph") return;
    const start = paragraph.position?.start.offset;
    const end = paragraph.position?.end.offset;
    if (start === undefined || end === undefined) return;
    for (const key of ["url", "favicon"] as const) {
      const value = reference[key];
      if (value && !isFullyEncoded(value))
        reference[key] = encodeURIComponent(value);
    }
    const definitionStart = node.position?.start.offset ?? start;
    const prefix = content.slice(definitionStart, start);
    const sameLine = !/[\r\n]/.test(prefix);
    replacements.push({
      start: sameLine ? definitionStart + prefix.trimEnd().length : start,
      end,
      value: (sameLine ? " " : "") + JSON.stringify(reference),
    });
  });
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    content =
      content.slice(0, replacement.start) +
      replacement.value +
      content.slice(replacement.end);
  return content;
}

/** URL adjacency normalization uses parser-owned markers, leaving code/escapes literal. */
export function preprocessFootnoteReferences(content: string): string {
  const processor = unified().use(remarkParse).use(remarkGfm, {
    deferAutolinks: true,
    allowMissingFootnotes: true,
    withoutAutolinks: true,
  });
  const ast = processor.runSync(processor.parse(content)) as Root;
  const offsets: number[] = [];
  let previousMarkerEnd = 0;
  visit(ast, "footnoteReference", (node) => {
    const start = node.position?.start.offset;
    if (start === undefined) return;
    const previous =
      content.slice(previousMarkerEnd, start).split(/\s/).pop() ?? "";
    previousMarkerEnd = node.position?.end.offset ?? start;
    try {
      new URL(previous);
      offsets.push(start);
    } catch {
      /* Ordinary adjacent text needs no normalization. */
    }
  });
  for (const offset of offsets.sort((a, b) => b - a))
    content = content.slice(0, offset) + " " + content.slice(offset);
  return content;
}
