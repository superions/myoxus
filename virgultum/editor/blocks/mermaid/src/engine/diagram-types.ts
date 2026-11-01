import { mindmapRuntimeContract } from "./mindmap/runtime-contract.js";
import { scanTimelineSource } from "./timeline/source-document.js";
export type MermaidDiagramType =
  | "architecture"
  | "block"
  | "c4"
  | "classDiagram"
  | "classDiagram-v2"
  | "erDiagram"
  | "flowchart"
  | "flowchart-elk"
  | "gantt"
  | "gitGraph"
  | "journey"
  | "kanban"
  | "mindmap"
  | "packet"
  | "pie"
  | "quadrantChart"
  | "radar"
  | "requirementDiagram"
  | "sankey"
  | "sequenceDiagram"
  | "stateDiagram"
  | "stateDiagram-v2"
  | "timeline"
  | "treemap"
  | "unknown"
  | "xychart";

export const MERMAID_DETECTOR_PATTERNS: ReadonlyArray<{
  readonly diagramType: MermaidDiagramType;
  readonly pattern: RegExp;
}> = [
  {
    diagramType: "c4",
    pattern: /^(?:C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/,
  },
  { diagramType: "architecture", pattern: /^architecture(?:-beta)?\b/ },
  { diagramType: "block", pattern: /^block(?:-beta)?\b/ },
  { diagramType: "classDiagram-v2", pattern: /^classDiagram-v2\b/ },
  { diagramType: "classDiagram", pattern: /^classDiagram\b/ },
  { diagramType: "erDiagram", pattern: /^erDiagram\b/ },
  { diagramType: "flowchart-elk", pattern: /^flowchart-elk\b/ },
  { diagramType: "flowchart", pattern: /^(?:flowchart|graph)\b/ },
  { diagramType: "gantt", pattern: /^gantt\b/ },
  { diagramType: "gitGraph", pattern: /^gitGraph\b/ },
  { diagramType: "journey", pattern: /^journey\b/ },
  { diagramType: "kanban", pattern: /^kanban\b/i },
  { diagramType: "mindmap", pattern: mindmapRuntimeContract.header },
  { diagramType: "packet", pattern: /^packet(?:-beta)?\b/ },
  { diagramType: "pie", pattern: /^pie\b/ },
  { diagramType: "quadrantChart", pattern: /^quadrantChart\b/ },
  { diagramType: "radar", pattern: /^radar-beta\b/ },
  { diagramType: "requirementDiagram", pattern: /^requirement(?:Diagram)?\b/i },
  { diagramType: "sankey", pattern: /^sankey(?:-beta)?\b/ },
  { diagramType: "sequenceDiagram", pattern: /^sequenceDiagram\b/ },
  { diagramType: "stateDiagram-v2", pattern: /^stateDiagram-v2\b/ },
  { diagramType: "stateDiagram", pattern: /^stateDiagram\b/ },
  { diagramType: "timeline", pattern: /^timeline\b/i },
  { diagramType: "treemap", pattern: /^treemap(?:-beta)?\b/ },
  { diagramType: "xychart", pattern: /^xychart(?:-beta)?\b/ },
];

const EMPTY_MERMAID_VISUAL_MODEL_DIAGRAM_TYPES = new Set<MermaidDiagramType>([
  "architecture",
  "c4",
  "classDiagram",
  "classDiagram-v2",
  "erDiagram",
  "flowchart",
  "flowchart-elk",
  "gitGraph",
  "mindmap",
  "requirementDiagram",
]);

export function allowsEmptyMermaidVisualModel(diagramType: MermaidDiagramType) {
  return EMPTY_MERMAID_VISUAL_MODEL_DIAGRAM_TYPES.has(diagramType);
}

export function hasTerminalMermaidDirectiveEnd(line: string) {
  const closeIndex = line.lastIndexOf("}%%");
  return closeIndex >= 0 && !line.slice(closeIndex + 3).trim();
}

function cleanMermaidFrontmatterScalar(value: string) {
  const trimmed = value
    .trim()
    .replace(/\s+#.*$/, "")
    .trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed : trimmed.slice(1, -1);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function getMermaidFrontmatterTitle(lines: readonly string[]) {
  const start = lines.findIndex((line) => line.trim() === "---");
  if (start < 0) return undefined;
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === "---",
  );
  if (end < 0) return undefined;
  for (let index = start + 1; index < end; index += 1) {
    const match = /^title\s*:\s*(.*)$/i.exec(lines[index].trim());
    if (!match) continue;
    const value = match[1].trim();
    if (!/^[>|][+-]?$/.test(value)) {
      return cleanMermaidFrontmatterScalar(value) || undefined;
    }
    const blockLines: string[] = [];
    for (let lineIndex = index + 1; lineIndex < end; lineIndex += 1) {
      const line = lines[lineIndex];
      if (line.trim() && !/^\s/.test(line)) break;
      blockLines.push(line.replace(/^\s+/, ""));
    }
    const title = value.startsWith(">")
      ? blockLines
          .map((line) => line.trim())
          .filter(Boolean)
          .join(" ")
      : blockLines.join("\n").trim();
    return title || undefined;
  }
  return undefined;
}

function projectMermaidSourceHeaderLines(source: string) {
  const lines = source
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  const projected = Array.from(lines.join("\n"));
  const frontMatterEnd =
    lines[0]?.trim() === "---"
      ? lines.findIndex(
          (line, candidate) => candidate > 0 && line.trim() === "---",
        )
      : -1;
  if (lines[0]?.trim() === "---" && frontMatterEnd < 0) return null;
  let lineIndex = 0;
  const text = lines.join("\n");
  for (let offset = 0; offset < text.length; offset += 1) {
    if (text[offset] === "\n") {
      lineIndex += 1;
      continue;
    }
    if (frontMatterEnd >= 0 && lineIndex <= frontMatterEnd) continue;
    if (!text.startsWith("%%{", offset)) continue;
    const end = text.indexOf("}%%", offset + 3);
    if (end < 0) return null;
    const endOffset = end + 3;
    for (let index = offset; index < endOffset; index += 1) {
      if (projected[index] !== "\n") projected[index] = " ";
    }
    lineIndex += text.slice(offset, endOffset).split("\n").length - 1;
    offset = endOffset - 1;
  }
  return {
    frontMatterEnd,
    lines: projected.join("").split("\n"),
  };
}

export function getMermaidSourceHeaderIndex(source: string) {
  const projection = projectMermaidSourceHeaderLines(source);
  if (!projection) return -1;
  let index = 0;
  if (projection.frontMatterEnd >= 0) index = projection.frontMatterEnd + 1;
  while (index < projection.lines.length) {
    const line = projection.lines[index].trim();
    if (!line || line.startsWith("%%") || line.startsWith("#")) {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

export function getMermaidSourceHeader(source: string) {
  const projection = projectMermaidSourceHeaderLines(source);
  if (!projection) return "";
  const headerIndex = getMermaidSourceHeaderIndex(source);
  return headerIndex < 0 ? "" : (projection.lines[headerIndex] ?? "").trim();
}

export function hasInvalidMermaidHashPreambleLine(lines: readonly string[]) {
  const hasFrontmatter = lines[0]?.trim() === "---";
  const frontmatterEnd = hasFrontmatter
    ? lines.findIndex((line, index) => index > 0 && line.trim() === "---")
    : -1;
  return lines.some(
    (line, index) =>
      line.trim().startsWith("#") &&
      !(hasFrontmatter && index > 0 && index < frontmatterEnd),
  );
}

export function partitionMermaidSourcePreamble(lines: readonly string[]) {
  const comments: string[] = [];
  const directives: string[] = [];
  const hasFrontmatter = lines[0]?.trim() === "---";
  const frontmatterEnd = hasFrontmatter
    ? lines.findIndex((line, index) => index > 0 && line.trim() === "---")
    : -1;
  let inDirective = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (hasFrontmatter && index <= frontmatterEnd) {
      directives.push(line);
      continue;
    }
    if (!inDirective && trimmed.startsWith("%%{")) {
      inDirective = true;
    }
    if (inDirective) {
      directives.push(line);
      if (hasTerminalMermaidDirectiveEnd(line)) inDirective = false;
      continue;
    }
    if (trimmed.startsWith("%%")) {
      comments.push(trimmed.slice(2).trim());
    } else {
      directives.push(line);
    }
  }
  return { comments, directives };
}

export function detectMermaidDiagramType(source: string): MermaidDiagramType {
  const header = getMermaidSourceHeader(source);
  if (!header) return "unknown";
  const detected = MERMAID_DETECTOR_PATTERNS.find(({ pattern }) =>
    pattern.test(header),
  )?.diagramType;
  if (detected) return detected;
  // Timeline's bound lexer accepts single-percent comments; other families keep their existing detection contract.
  if (header.startsWith("%")) {
    const first = scanTimelineSource(source).statements.find(
      (record) =>
        !["frontmatter", "directive", "comment", "blank"].includes(record.kind),
    );
    if (first?.kind === "header" && /^timeline\b/i.test(first.raw.trim()))
      return "timeline";
  }
  return "unknown";
}

export function isKnownMermaidSource(source: string) {
  return detectMermaidDiagramType(source) !== "unknown";
}
