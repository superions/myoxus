import { getMermaidFrontmatterTitle } from "../diagram-types.js";

export type MermaidArchitectureStatementKind =
  "alignment" | "edge" | "group" | "junction" | "service";

export type MermaidArchitectureSourceRecord =
  | {
      endLine: number;
      fingerprint: string;
      id: string;
      inlineDirectives?: string[];
      kind: "comment";
      startLine: number;
    }
  | {
      commentId?: string;
      commentFingerprint?: string;
      endLine: number;
      inlineDirectives?: string[];
      kind: "header";
      startLine: number;
    }
  | {
      commentId?: string;
      commentSuffix: string;
      effective: boolean;
      endLine: number;
      field: "accessibilityDescription" | "accessibilityTitle" | "diagramTitle";
      format?: "body" | "frontmatter";
      fingerprint: string;
      inlineDirectives?: string[];
      kind: "metadata";
      startLine: number;
    }
  | {
      commentId?: string;
      commentSuffix: string;
      endLine: number;
      fingerprint: string;
      id: string;
      inlineDirectives?: string[];
      kind: "statement";
      startLine: number;
      statementKind: MermaidArchitectureStatementKind;
    };

export type MermaidArchitectureSourceDocument = {
  lines: string[];
  newline: "\n" | "\r\n" | "\r";
  records: MermaidArchitectureSourceRecord[];
};

export function architectureSourceLines(source: string) {
  const newline = source.includes("\r\n")
    ? ("\r\n" as const)
    : source.includes("\r")
      ? ("\r" as const)
      : ("\n" as const);
  return {
    lines: source.split(/\r\n|\r|\n/),
    newline,
  };
}

export function decodeArchitectureFrontmatterScalar(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

export function splitArchitectureFrontmatterValue(value: string) {
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (quote === '"' && char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return {
        commentSuffix: value.slice(index).trim(),
        value: value.slice(0, index).trimEnd(),
      };
    }
  }
  return { commentSuffix: "", value: value.trimEnd() };
}

export function architectureFrontmatterMetadata(lines: readonly string[]) {
  const fields: Array<{
    commentSuffix: string;
    endLine: number;
    field: "diagramTitle";
    line: number;
    value: string;
  }> = [];
  if (lines[0]?.trim() !== "---") return;
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (end < 0) return fields;
  for (let index = 1; index < end; index += 1) {
    const match = /^\s*title\s*:\s*(.*?)\s*$/.exec(lines[index]);
    if (!match) continue;
    const scalar = splitArchitectureFrontmatterValue(match[1]);
    if (/^[>|][+-]?$/.test(scalar.value)) {
      let endLine = index + 1;
      while (
        endLine < end &&
        (!lines[endLine].trim() || /^\s/.test(lines[endLine]))
      ) {
        endLine += 1;
      }
      fields.push({
        commentSuffix: scalar.commentSuffix,
        endLine,
        field: "diagramTitle",
        line: index,
        value: getMermaidFrontmatterTitle(lines) ?? "",
      });
      return fields;
    }
    fields.push({
      commentSuffix: scalar.commentSuffix,
      endLine: index + 1,
      field: "diagramTitle",
      line: index,
      value: decodeArchitectureFrontmatterScalar(scalar.value),
    });
    return fields;
  }
  return fields;
}

export function architectureDirectiveProjection(lines: readonly string[]) {
  const text = lines.join("\n");
  const projected = Array.from({ length: lines.length }, () => "");
  const directives: Array<{
    endLine: number;
    source: string;
    startLine: number;
  }> = [];
  const frontmatterEnd =
    lines[0]?.trim() === "---"
      ? lines.findIndex((line, index) => index > 0 && line.trim() === "---")
      : -1;
  let line = 0;
  let logicalLine = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") {
      projected[line] = logicalLine;
      logicalLine = "";
      line += 1;
      continue;
    }
    if (frontmatterEnd >= 0 && line <= frontmatterEnd) {
      logicalLine += char;
      continue;
    }
    if (!text.startsWith("%%{", index)) {
      logicalLine += char;
      continue;
    }
    const end = text.indexOf("}%%", index + 3);
    if (end < 0) {
      logicalLine += char;
      continue;
    }
    const endOffset = end + 3;
    const source = text.slice(index, endOffset);
    const endLine = line + source.split("\n").length;
    directives.push({
      endLine,
      source,
      startLine: line,
    });
    line = endLine - 1;
    index = endOffset - 1;
  }
  projected[line] = logicalLine;
  return {
    directives,
    lines: projected,
  };
}

export function architectureSourceRecordRange(
  directives: readonly {
    endLine: number;
    source: string;
    startLine: number;
  }[],
  startLine: number,
  endLine: number,
) {
  const attached = directives.filter(
    (directive) =>
      directive.startLine < endLine && directive.endLine > startLine,
  );
  return {
    endLine: Math.max(endLine, ...attached.map((item) => item.endLine)),
    inlineDirectives: attached.map((item) => item.source),
    startLine: Math.min(startLine, ...attached.map((item) => item.startLine)),
  };
}

export function architectureHeaderIndex(
  semanticLines: readonly string[],
  sourceLines: readonly string[],
) {
  let index = 0;
  if (sourceLines[0]?.trim() === "---") {
    const end = sourceLines.findIndex(
      (line, candidate) => candidate > 0 && line.trim() === "---",
    );
    if (end < 0) return -1;
    index = end + 1;
  }
  while (index < semanticLines.length) {
    const line = semanticLines[index].trim();
    if (!line || line.startsWith("%%") || line.startsWith("#")) {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}
