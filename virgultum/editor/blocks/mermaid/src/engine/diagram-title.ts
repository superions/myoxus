// SPDX-License-Identifier: AGPL-3.0-or-later

import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";
import { sourceFrontmatter } from "./source-yaml.js";

import type { MermaidProductDiagramType } from "./product-types.js";
import type {
  MermaidDiagramTitleSourceRange,
  MermaidFamilyDiagramTitleHook,
  MermaidNativeDiagramTitle,
} from "../families/runtime/contracts.js";

export type MermaidEffectiveDiagramTitle = {
  readonly kind: "frontmatter" | "legacy" | "native" | "none";
  readonly range: MermaidDiagramTitleSourceRange | null;
  readonly sourceRanges: ReadonlyArray<MermaidDiagramTitleSourceRange>;
  readonly value: string;
};

type FrontmatterTitle = MermaidNativeDiagramTitle & {
  readonly patchRange: MermaidDiagramTitleSourceRange;
  readonly displayAliasPatches: readonly {
    range: MermaidDiagramTitleSourceRange;
    value: string;
  }[];
};

function sourceLines(source: string) {
  const lines: Array<{
    readonly content: string;
    readonly end: number;
    readonly endWithBreak: number;
    readonly start: number;
  }> = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[1]!.length;
    lines.push({
      content: match[1]!,
      start,
      end,
      endWithBreak: end + match[2]!.length,
    });
    if (!match[2]) break;
  }
  return lines;
}

/** Read the same bounded YAML scalar semantics as Mermaid, preserving CST patch ranges. */
function resolveFrontmatterTitle(source: string): FrontmatterTitle | null {
  const lines = sourceLines(source);
  const frontmatter = sourceFrontmatter(source);
  if (!frontmatter) return null;
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.start === frontmatter.closingStart,
  );
  if (closingIndex < 0) return null;
  const offset = lines[0].endWithBreak;
  const document = parseDocument(frontmatter.body, {
    keepSourceTokens: true,
    uniqueKeys: true,
    schema: "core",
  });
  if (document.errors.length || !isMap(document.contents)) return null;
  const pair = document.contents.items.find(
    (item) => isScalar(item.key) && item.key.value === "title",
  );
  const node = pair?.value;
  if (
    !node ||
    !(isScalar(node) || isAlias(node)) ||
    !node.range ||
    !isScalar(pair?.key) ||
    !pair.key.range
  )
    return null;
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 100 })?.title;
  } catch {
    return null;
  }
  if (typeof value !== "string") return null;
  const start = offset + node.range[0];
  let end = offset + node.range[1];
  // Block scalars include their final line break; replacing their value must
  // leave that separator before the next property or frontmatter delimiter.
  while (end > start && /[\r\n]/.test(source[end - 1]!)) end--;
  const firstLine = lines.find(
    (line) =>
      line.start <= offset + pair.key.range![0] &&
      line.endWithBreak > offset + pair.key.range![0],
  );
  const lastLine = lines.find(
    (line) =>
      line.start <= Math.max(start, end - 1) &&
      line.endWithBreak > Math.max(start, end - 1),
  );
  if (!firstLine || !lastLine) return null;
  const range = { start: firstLine.start, end: lastLine.endWithBreak };
  const displayAliasPatches: {
    range: MermaidDiagramTitleSourceRange;
    value: string;
  }[] = [];
  if (isScalar(node) && node.anchor)
    visit(document, {
      Alias(_key, alias) {
        if (alias.resolve(document) === node && alias.range)
          displayAliasPatches.push({
            range: {
              start: offset + alias.range[0],
              end: offset + alias.range[1],
            },
            value: JSON.stringify(value),
          });
      },
    });
  return { value, range, patchRange: { start, end }, displayAliasPatches };
}

function quotedYamlTitle(value: string) {
  return JSON.stringify(value.replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
}

export function resolveMermaidDiagramTitle({
  diagramType,
  familyTitle,
  legacyTitle = "",
  source,
}: {
  readonly diagramType: MermaidProductDiagramType;
  readonly familyTitle?: MermaidFamilyDiagramTitleHook;
  readonly legacyTitle?: string;
  readonly source: string;
}): MermaidEffectiveDiagramTitle {
  // Mermaid 11.17.2 applies frontmatter metadata before invoking the family
  // parser. A family-native title statement therefore wins when both exist.
  const native = familyTitle?.resolve(source, diagramType);
  const frontmatter = resolveFrontmatterTitle(source);
  const sourceRanges = [
    ...(frontmatter ? [frontmatter.range] : []),
    ...(familyTitle
      ?.resolveAll(source, diagramType)
      .map(({ range }) => range) ?? []),
  ];
  if (native?.value.trim()) {
    return {
      kind: "native",
      range: native.range,
      sourceRanges,
      value: native.value.trim(),
    };
  }
  if (frontmatter?.value.trim()) {
    return {
      kind: "frontmatter",
      range: frontmatter.range,
      sourceRanges,
      value: frontmatter.value.trim(),
    };
  }
  const legacy = legacyTitle.trim();
  return legacy
    ? { kind: "legacy", range: null, sourceRanges, value: legacy }
    : { kind: "none", range: null, sourceRanges, value: "" };
}

export function writeMermaidDiagramTitle({
  diagramType,
  familyTitle,
  source,
  title,
}: {
  readonly diagramType: MermaidProductDiagramType;
  readonly familyTitle?: MermaidFamilyDiagramTitleHook;
  readonly source: string;
  readonly title: string;
}) {
  const nextTitle = title.trim();
  if (!nextTitle) return null;
  const native = familyTitle?.resolve(source, diagramType);
  if (native) return familyTitle?.patch(source, diagramType, nextTitle) ?? null;
  const frontmatter = resolveFrontmatterTitle(source);
  if (frontmatter) {
    return `${source.slice(0, frontmatter.patchRange.start)}${quotedYamlTitle(
      nextTitle,
    )}${source.slice(frontmatter.patchRange.end)}`;
  }
  const lines = sourceLines(source);
  if (lines[0]?.content.trim() === "---") {
    const frontmatter = sourceFrontmatter(source);
    if (!frontmatter) return null;
    const closing = lines.find(
      (line, index) => index > 0 && line.start === frontmatter.closingStart,
    );
    if (!closing) return null;
    const document = parseDocument(frontmatter.body, {
      uniqueKeys: true,
      schema: "core",
    });
    // An invalid or non-scalar existing title is not a missing title. Adding
    // another key would corrupt the frontmatter instead of editing safely.
    if (
      document.errors.length ||
      !isMap(document.contents) ||
      document.contents.has("title")
    )
      return null;
    const newline = source.match(/\r\n|\r|\n/)?.[0] ?? "\n";
    return `${source.slice(0, closing.start)}${frontmatter.prefix}title: ${quotedYamlTitle(
      nextTitle,
    )}${newline}${source.slice(closing.start)}`;
  }
  const newline = source.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  return `---${newline}title: ${quotedYamlTitle(nextTitle)}${newline}---${newline}${source}`;
}

export function projectMermaidViewSourceWithoutTitle(
  source: string,
  title: MermaidEffectiveDiagramTitle,
) {
  // Removing an anchored title must not leave dangling references elsewhere
  // in display-only frontmatter. Persisted source and standalone exports keep it.
  const aliases = resolveFrontmatterTitle(source)?.displayAliasPatches ?? [];
  return [
    ...title.sourceRanges.map((range) => ({ range, value: "" })),
    ...aliases.filter(
      (patch) =>
        !title.sourceRanges.some(
          (range) =>
            range.start <= patch.range.start && range.end >= patch.range.end,
        ),
    ),
  ]
    .sort((left, right) => right.range.start - left.range.start)
    .reduce(
      (projected, patch) =>
        `${projected.slice(0, patch.range.start)}${patch.value}${projected.slice(patch.range.end)}`,
      source,
    );
}
