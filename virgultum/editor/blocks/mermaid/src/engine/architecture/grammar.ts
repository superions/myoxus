import { hashMermaidSource } from "../../utils.js";

export const ARCHITECTURE_ID = "\\w(?:[-\\w]*\\w)?";
export const ARCHITECTURE_ID_VALUE_RE = new RegExp(`^${ARCHITECTURE_ID}$`);
export const ARCHITECTURE_STRING = `(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
export const ARCHITECTURE_ICON = `\\([\\w:-]+\\)`;
export const ARCHITECTURE_ICON_VALUE_RE = /^[\w:-]+$/;
export const ARCHITECTURE_TITLE = `\\[(?:${ARCHITECTURE_STRING}|[\\w ]+)\\]`;
export const ARCHITECTURE_PARENT = `(?:(?:\\s+|(?<=[\\)\\]"']))in\\s+(${ARCHITECTURE_ID}))?`;
export const GROUP_RE = new RegExp(
  `^\\s*group\\s+(${ARCHITECTURE_ID})(?:\\s*(${ARCHITECTURE_ICON}))?(?:\\s*(${ARCHITECTURE_TITLE}))?${ARCHITECTURE_PARENT}\\s*$`,
);
export const SERVICE_RE = new RegExp(
  `^\\s*service\\s+(${ARCHITECTURE_ID})(?:\\s*(${ARCHITECTURE_ICON}|${ARCHITECTURE_STRING}))?(?:\\s*(${ARCHITECTURE_TITLE}))?${ARCHITECTURE_PARENT}\\s*$`,
);
export const JUNCTION_RE = new RegExp(
  `^\\s*junction\\s+(${ARCHITECTURE_ID})(?:\\s+in\\s+(${ARCHITECTURE_ID}))?\\s*$`,
);
export const ALIGN_RE = new RegExp(
  `^\\s*align\\s+(row|column)\\s+(${ARCHITECTURE_ID}(?:\\s+${ARCHITECTURE_ID})+)\\s*$`,
);
export const EDGE_RE = new RegExp(
  `^\\s*(${ARCHITECTURE_ID})\\s*(\\{group\\})?\\s*:\\s*([RLTB])\\s*([<>])?\\s*(?:--|-\\s*(${ARCHITECTURE_TITLE})\\s*-)\\s*([<>])?\\s*([RLTB])\\s*:\\s*(${ARCHITECTURE_ID})\\s*(\\{group\\})?\\s*$`,
);

export function decodedArchitectureEscape(char: string) {
  if (char === "b") return "\b";
  if (char === "f") return "\f";
  if (char === "n") return "\n";
  if (char === "r") return "\r";
  if (char === "t") return "\t";
  if (char === "v") return "\v";
  if (char === "0") return "\0";
  return char;
}

export function decodeArchitectureString(value: string) {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || !value.endsWith(quote)) return null;
  let decoded = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      if (index >= value.length - 1) return null;
      decoded += decodedArchitectureEscape(value[index]);
      continue;
    }
    decoded += value[index];
  }
  return decoded;
}

export function decodeArchitectureTitle(value: string) {
  const inner = value.slice(1, -1).trim();
  if (
    (inner.startsWith('"') && inner.endsWith('"')) ||
    (inner.startsWith("'") && inner.endsWith("'"))
  ) {
    return inner.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\'", "'");
  }
  return inner;
}

export function quotedArchitectureString(value: string) {
  let quoted = '"';
  for (const char of value) {
    if (char === "\\") quoted += "\\\\";
    else if (char === '"') quoted += '\\"';
    else if (char === "\b") quoted += "\\b";
    else if (char === "\f") quoted += "\\f";
    else if (char === "\n") quoted += "\\n";
    else if (char === "\r") quoted += "\\r";
    else if (char === "\t") quoted += "\\t";
    else if (char === "\v") quoted += "\\v";
    else if (char.codePointAt(0) === 0) quoted += "\\0";
    else quoted += char;
  }
  return `${quoted}"`;
}

export function architectureTitleSource(value: string) {
  return `[${quotedArchitectureString(value)}]`;
}

export function splitArchitectureComment(line: string) {
  let quote = "";
  for (let index = 0; index < line.length - 1; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "%" && line[index + 1] === "%") {
      return {
        annotation: line.slice(index + 2).trim(),
        commentIndex: index,
        hasComment: true,
        syntax: line.slice(0, index).trimEnd(),
      };
    }
  }
  return {
    annotation: "",
    commentIndex: -1,
    hasComment: false,
    syntax: line,
  };
}

export function architectureCommentLine(annotation: string) {
  return annotation ? `%% ${annotation}` : "%%";
}

export function architectureSemanticFingerprint(value: unknown) {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const { order: _order, ...semantic } = value as Record<string, unknown>;
  return JSON.stringify(semantic);
}

export function architectureStableStatementId(
  kind: "alignment" | "edge",
  semanticKey: string,
  occurrence: number,
) {
  return `${kind}-${hashMermaidSource(semanticKey).slice("fnv1a:".length)}-${occurrence}`;
}
