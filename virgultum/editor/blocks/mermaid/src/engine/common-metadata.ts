// SPDX-License-Identifier: AGPL-3.0-or-later

export type MermaidCommonDiagramMetadata = {
  accessibilityDescription: string;
  accessibilityTitle: string;
  diagramTitle: string;
};

export function createMermaidCommonDiagramMetadata(): MermaidCommonDiagramMetadata {
  return {
    accessibilityDescription: "",
    accessibilityTitle: "",
    diagramTitle: "",
  };
}

export type MermaidCommonMetadataParseResult =
  | { kind: "consumed"; multiline: boolean; nextIndex: number }
  | { kind: "invalid" }
  | { kind: "not-common" };

function normalizedSingleLineMetadata(value: string) {
  return value.trim().replace(/[\t ]{2,}/g, " ");
}

function normalizedMultilineDescription(value: string) {
  return value
    .replace(/^\s*/gm, "")
    .replace(/\s+$/gm, "")
    .replace(/[\t ]{2,}/gm, " ")
    .replace(/[\n\r]{2,}/gm, "\n");
}

export function consumeMermaidCommonMetadata(
  lines: readonly string[],
  index: number,
  metadata: MermaidCommonDiagramMetadata,
): MermaidCommonMetadataParseResult {
  const raw = lines[index] ?? "";
  const commentIndex = raw.indexOf("%%");
  const syntax = commentIndex < 0 ? raw : raw.slice(0, commentIndex);
  const trimmed = syntax.trim();
  const title = /^title(?:\s+(.*?))?$/.exec(trimmed);
  if (title) {
    metadata.diagramTitle = normalizedSingleLineMetadata(title[1] ?? "");
    return { kind: "consumed", multiline: false, nextIndex: index + 1 };
  }
  const accessibilityTitle = /^accTitle\s*:\s*(.*?)$/.exec(trimmed);
  if (accessibilityTitle) {
    metadata.accessibilityTitle = normalizedSingleLineMetadata(
      accessibilityTitle[1],
    );
    return { kind: "consumed", multiline: false, nextIndex: index + 1 };
  }
  const accessibilityDescription = /^accDescr\s*:\s*(.*?)$/.exec(trimmed);
  if (accessibilityDescription) {
    metadata.accessibilityDescription = normalizedSingleLineMetadata(
      accessibilityDescription[1],
    );
    return { kind: "consumed", multiline: false, nextIndex: index + 1 };
  }
  const opening = /^\s*accDescr\s*\{/.exec(raw);
  if (!opening) return { kind: "not-common" };
  const description: string[] = [];
  for (let nextIndex = index; nextIndex < lines.length; nextIndex += 1) {
    const content =
      nextIndex === index
        ? lines[nextIndex].slice(opening[0].length)
        : lines[nextIndex];
    const closeIndex = content.indexOf("}");
    if (closeIndex >= 0) {
      const remainder = content.slice(closeIndex + 1).trim();
      if (remainder && !remainder.startsWith("%%")) return { kind: "invalid" };
      description.push(content.slice(0, closeIndex));
      metadata.accessibilityDescription = normalizedMultilineDescription(
        description.join("\n"),
      );
      return { kind: "consumed", multiline: true, nextIndex: nextIndex + 1 };
    }
    description.push(content);
  }
  return { kind: "invalid" };
}

export function generateMermaidCommonMetadataLines(
  metadata: MermaidCommonDiagramMetadata,
) {
  const lines: string[] = [];
  if (metadata.diagramTitle) lines.push(`  title ${metadata.diagramTitle}`);
  if (metadata.accessibilityTitle) {
    lines.push(`  accTitle: ${metadata.accessibilityTitle}`);
  }
  if (metadata.accessibilityDescription.includes("\n")) {
    lines.push("  accDescr {");
    lines.push(
      ...metadata.accessibilityDescription
        .split("\n")
        .map((line) => `    ${line}`),
    );
    lines.push("  }");
  } else if (metadata.accessibilityDescription) {
    lines.push(`  accDescr: ${metadata.accessibilityDescription}`);
  }
  return lines;
}
