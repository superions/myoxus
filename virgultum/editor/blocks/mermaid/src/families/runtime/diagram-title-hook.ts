// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidProductDiagramType } from "../../engine/product-types.js";
import type {
  MermaidFamilyDiagramTitleHook,
  MermaidNativeDiagramTitle,
} from "./contracts.js";

export type MermaidFamilyTitleLine = {
  readonly value: string;
  readonly valueEnd: number;
  readonly valueStart: number;
};

function bodyLines(source: string) {
  const lines: Array<{
    readonly content: string;
    readonly endWithBreak: number;
    readonly start: number;
  }> = [];
  for (const match of source.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)) {
    lines.push({
      content: match[1]!,
      endWithBreak: match.index + match[0].length,
      start: match.index,
    });
    if (!match[2]) break;
  }
  const frontmatterEnd =
    lines[0]?.content.trim() === "---"
      ? lines.findIndex(
          (line, index) => index > 0 && line.content.trim() === "---",
        )
      : -1;
  return frontmatterEnd < 0 ? lines : lines.slice(frontmatterEnd + 1);
}

export function createMermaidFamilyDiagramTitleHook({
  formatTitle = (title) => title,
  parseLine,
  validate,
}: {
  readonly formatTitle?: (
    title: string,
    diagramType: MermaidProductDiagramType,
  ) => string;
  readonly parseLine: (
    line: string,
    diagramType: MermaidProductDiagramType,
  ) => MermaidFamilyTitleLine | null;
  readonly validate: (
    source: string,
    diagramType: MermaidProductDiagramType,
    title: string,
  ) => boolean;
}): MermaidFamilyDiagramTitleHook {
  const resolveAll = (
    source: string,
    diagramType: MermaidProductDiagramType,
  ): ReadonlyArray<MermaidNativeDiagramTitle> => {
    const titles: MermaidNativeDiagramTitle[] = [];
    for (const line of bodyLines(source)) {
      const parsed = parseLine(line.content, diagramType);
      if (!parsed) continue;
      titles.push({
        range: { end: line.endWithBreak, start: line.start },
        value: parsed.value,
      });
    }
    return titles;
  };
  const resolve = (source: string, diagramType: MermaidProductDiagramType) =>
    resolveAll(source, diagramType).at(-1) ?? null;
  return {
    patch: (source, diagramType, title) => {
      const current = resolve(source, diagramType);
      if (!current) return null;
      const line = source
        .slice(current.range.start, current.range.end)
        .replace(/(?:\r\n|\r|\n)$/, "");
      const parsed = parseLine(line, diagramType);
      if (!parsed) return null;
      const lineStart = current.range.start;
      const candidate = `${source.slice(
        0,
        lineStart + parsed.valueStart,
      )}${formatTitle(title, diagramType)}${source.slice(
        lineStart + parsed.valueEnd,
      )}`;
      return validate(candidate, diagramType, title) ? candidate : null;
    },
    resolve,
    resolveAll,
  };
}

export function parsePlainMermaidTitleLine(
  line: string,
  pattern: RegExp,
): MermaidFamilyTitleLine | null {
  const match = pattern.exec(line);
  if (!match || match.index !== 0 || match[1] === undefined) return null;
  const value = match[1];
  const prefix = /^\s*title\s*:?[ \t]+/i.exec(line);
  if (!prefix) return null;
  const valueStart = prefix[0].length;
  return {
    value: value.trim(),
    valueEnd: valueStart + value.length,
    valueStart,
  };
}
