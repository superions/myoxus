// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Nodes } from "mdast";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import { unified } from "unified";
import { decodeAnnotationBody } from "./annotation-syntax";
import { remarkGfm } from "./gfm";
import { getHtmlTagInfo } from "./delta-converter";

export type PreparedAnnotationSource = {
  source: string;
  bodies: Map<number, { end: number; body: string }>;
  pending: Set<number>;
  protectedRanges: { start: number; end: number; html?: boolean }[];
  unsupportedRanges: { start: number; end: number }[];
};

function getMathRanges(source: string): { start: number; end: number }[] {
  if (!source.includes("$")) return [];
  const ranges: { start: number; end: number }[] = [];
  const inspect = (node: Nodes) => {
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (
      (node.type === "math" || node.type === "inlineMath") &&
      start !== undefined &&
      end !== undefined
    )
      ranges.push({ start, end });
    if ("children" in node) node.children.forEach(inspect);
  };
  inspect(
    unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(source),
  );
  return ranges;
}

/**
 * Native Markdown supplies code/HTML boundaries. The delimiter-only scan then
 * makes literal bodies opaque before the authoritative parse, preserving UTF-16
 * source positions even for blank lines and table pipes. This is conversion-local
 * source metadata, never a second editor model or persisted body.
 */
export function prepareAnnotationSource(
  source: string,
): PreparedAnnotationSource {
  const result: PreparedAnnotationSource = {
    source,
    bodies: new Map(),
    pending: new Set(),
    protectedRanges: [],
    unsupportedRanges: [],
  };
  const protectedRanges = result.protectedRanges;
  const paragraphs: { start: number; end: number; prefix: string }[] = [];
  const htmlCode: { name: string; start: number }[] = [];
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
  const mathRanges = getMathRanges(source);
  const inspect = (node: Nodes) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (node.type === "code" || node.type === "inlineCode")
        protectedRanges.push({ start, end });
      if (node.type === "html") {
        protectedRanges.push({ start, end, html: true });
        const tag = getHtmlTagInfo(node.value);
        if (tag && (tag.name === "code" || tag.name === "pre")) {
          if (tag.kind === "close") {
            const index = htmlCode.findLastIndex(
              (open) => open.name === tag.name,
            );
            if (index !== -1) {
              protectedRanges.push({ start: htmlCode[index].start, end });
              htmlCode.splice(index);
            }
          } else htmlCode.push({ name: tag.name, start });
        }
      }
      if (node.type === "paragraph")
        paragraphs.push({
          start,
          end,
          prefix: source.slice(source.lastIndexOf("\n", start - 1) + 1, start),
        });
    }
    if ("children" in node) node.children.forEach(inspect);
  };
  inspect(tree);
  htmlCode.forEach((open) =>
    protectedRanges.push({ start: open.start, end: source.length }),
  );
  protectedRanges.sort((a, b) => a.start - b.start || b.end - a.end);
  if (!source.includes("%%")) return result;
  let boundary = 0;
  let mathBoundary = 0;
  let opening: number | undefined;
  let blocked = false;
  let backslashes = 0;
  const pieces: string[] = [];
  let copied = 0;
  let paragraphIndex = 0;
  for (let index = 0; index < source.length; index++) {
    while (mathRanges[mathBoundary]?.end <= index) mathBoundary++;
    const math = mathRanges[mathBoundary];
    if (opening === undefined && math?.start <= index) {
      index = math.end - 1;
      backslashes = 0;
      continue;
    }
    while (protectedRanges[boundary]?.end <= index) boundary++;
    const range = protectedRanges[boundary];
    if (
      range &&
      range.start <= index &&
      (!range.html || opening === undefined)
    ) {
      if (opening !== undefined) blocked = true;
      index = range.end - 1;
      backslashes = 0;
      continue;
    }
    const escaped = backslashes % 2 === 1;
    if (source[index] === "\\") {
      backslashes++;
      continue;
    }
    backslashes = 0;
    if (source[index] !== "%" || source[index + 1] !== "%" || escaped) continue;
    if (opening === undefined) {
      opening = index;
      blocked = false;
    } else {
      if (!blocked) {
        const start = opening;
        const end = index + 2;
        while (paragraphs[paragraphIndex]?.end <= start) paragraphIndex++;
        const candidate = paragraphs[paragraphIndex];
        const paragraph = candidate?.start <= start ? candidate : undefined;
        let rawBody = source.slice(start + 2, index);
        // The native container prefix is structural, not literal annotation text.
        if (paragraph?.prefix) {
          const continuation = paragraph.prefix.replace(
            /(?:[-+*]|\d+[.)])\s+$/,
            (match) => " ".repeat(match.length),
          );
          rawBody = rawBody
            .split("\n")
            .map((line, lineIndex) =>
              lineIndex && line.startsWith(continuation)
                ? line.slice(continuation.length)
                : line,
            )
            .join("\n");
        }
        result.bodies.set(start, { end, body: decodeAnnotationBody(rawBody) });
        pieces.push(
          source.slice(copied, start + 2),
          "x".repeat(index - start - 2),
        );
        copied = index;
      } else {
        result.unsupportedRanges.push({ start: opening, end: index + 2 });
      }
      opening = undefined;
    }
    index++;
  }
  if (opening !== undefined && !blocked) result.pending.add(opening);
  pieces.push(source.slice(copied));
  result.source = pieces.join("");
  return result;
}

/** Clipboard cleanup must preserve code/HTML/math and literal annotation bodies. */
export function getMarkdownCodeRanges(
  source: string,
): { start: number; end: number }[] {
  const prepared = prepareAnnotationSource(source);
  const annotations = [...prepared.bodies].map(([start, body]) => ({
    start,
    end: body.end,
  }));
  return [
    ...prepared.protectedRanges,
    ...getMathRanges(source),
    ...annotations,
    ...prepared.unsupportedRanges,
    ...[...prepared.pending].map((start) => ({ start, end: source.length })),
  ].sort((a, b) => a.start - b.start || b.end - a.end);
}
