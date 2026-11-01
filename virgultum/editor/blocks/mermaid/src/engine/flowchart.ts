// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  createMermaidGfxModelHash,
  type MermaidVisualDirection,
  type MermaidVisualEdge,
  type MermaidVisualEdgeLinkType,
  type MermaidVisualEdgeStyle,
  type MermaidVisualModel,
  type MermaidVisualNode,
  type MermaidVisualNodeShape,
  type MermaidVisualSubgraph,
} from "../families/runtime/gfx-model.js";
import {
  flowchartModelFamilyData,
  type MermaidFlowchartComment,
  type MermaidFlowchartSyntax,
  type PendingFlowchartSubgraph,
} from "./flowchart-model.js";
import {
  computeFlowchartSubgraphBounds,
  layoutFlowchartNodes,
  separateFlowchartSubgraphMemberBands,
} from "./flowchart-geometry.js";
import { hashMermaidSource } from "../utils.js";
import {
  detectMermaidDiagramType,
  getMermaidSourceHeaderIndex,
} from "./diagram-types.js";
import {
  consumeMermaidCommonMetadata,
  createMermaidCommonDiagramMetadata,
} from "./common-metadata.js";
import {
  flowchartClickStatementNodeId,
  flowchartNodeData,
  flowchartNodeFamilyData,
} from "./flowchart-node.js";

export type ParsedFlowchartNodeToken = {
  end: number;
  explicit: boolean;
  id: string;
  label: string;
  markdown: boolean;
  shape: MermaidVisualNodeShape;
  start: number;
};

export type {
  MermaidFlowchartComment,
  MermaidFlowchartSyntax,
} from "./flowchart-model.js";

export function isFlowchartStyleStatement(statement: string) {
  const trimmed = statement.trim();
  return (
    /^(classDef|class|style|linkStyle)\b/i.test(trimmed) ||
    Boolean(flowchartClickStatementNodeId(trimmed))
  );
}

const NODE_ID_RE = /^[A-Za-z0-9_][\w-]*/;
export const EDGE_ID_PREFIX_RE = /^([A-Za-z_][\w-]*)@/;
const EDGE_TOKEN_RE =
  /^(o-{2,}o|x-{2,}x|<-{2,}>|<-{2,}|-{2,}>|-{3,}|={2,}>|-\.+->|-{2,}o|-{2,}x)/;
const EDGE_TEXT_TOKEN_RE =
  /^(--|==|-\.)\s+(.+?)\s+(-->|---|==>|-\.->|--o|--x|\.->)/;
const FLOWCHART_SHAPE_DELIMITERS: ReadonlyArray<{
  close: string;
  open: string;
  shape: MermaidVisualNodeShape;
}> = [
  { close: ")))", open: "(((", shape: "doublecircle" },
  { close: "]]", open: "[[", shape: "subroutine" },
  { close: ")]", open: "[(", shape: "database" },
  { close: "))", open: "((", shape: "circle" },
  { close: "}}", open: "{{", shape: "hexagon" },
  { close: "])", open: "([", shape: "stadium" },
  { close: "/]", open: "[/", shape: "parallelogram" },
  { close: "\\]", open: "[\\", shape: "parallelogram" },
  { close: "\\]", open: "[/", shape: "trapezoid" },
  { close: "/]", open: "[\\", shape: "trapezoid" },
  { close: "]", open: ">", shape: "asymmetric" },
  { close: "]", open: "[", shape: "rect" },
  { close: "}", open: "{", shape: "diamond" },
  { close: ")", open: "(", shape: "rounded" },
];
const FLOWCHART_SHAPE_SOURCE: Record<
  Extract<
    MermaidVisualNodeShape,
    | "asymmetric"
    | "circle"
    | "database"
    | "diamond"
    | "doublecircle"
    | "hexagon"
    | "parallelogram"
    | "rect"
    | "rounded"
    | "stadium"
    | "subroutine"
    | "trapezoid"
  >,
  { close: string; open: string }
> = {
  asymmetric: { close: "]", open: ">" },
  circle: { close: "))", open: "((" },
  database: { close: ")]", open: "[(" },
  diamond: { close: "}", open: "{" },
  doublecircle: { close: ")))", open: "(((" },
  hexagon: { close: "}}", open: "{{" },
  parallelogram: { close: "/]", open: "[/" },
  rect: { close: "]", open: "[" },
  rounded: { close: ")", open: "(" },
  stadium: { close: "])", open: "([" },
  subroutine: { close: "]]", open: "[[" },
  trapezoid: { close: "\\]", open: "[/" },
};
const EXPANDED_FLOWCHART_SHAPE_ALIASES: Record<string, MermaidVisualNodeShape> =
  {
    bang: "bang",
    "bow-rect": "bow-rect",
    "bow-tie-rectangle": "bow-rect",
    bolt: "bolt",
    brace: "brace",
    "brace-l": "brace",
    "brace-r": "brace-r",
    braces: "braces",
    card: "notch-rect",
    circ: "circle",
    circle: "circle",
    cloud: "cloud",
    collate: "hourglass",
    "com-link": "bolt",
    comment: "brace",
    "cross-circ": "cross-circ",
    "crossed-circle": "cross-circ",
    "curv-trap": "curv-trap",
    "curved-trapezoid": "curv-trap",
    cyl: "database",
    cylinder: "database",
    das: "h-cyl",
    "data-store": "datastore",
    database: "database",
    datastore: "datastore",
    db: "database",
    decision: "diamond",
    delay: "delay",
    diam: "diamond",
    diamond: "diamond",
    "dbl-circ": "doublecircle",
    disk: "lin-cyl",
    display: "curv-trap",
    "double-circle": "doublecircle",
    "div-proc": "div-rect",
    "div-rect": "div-rect",
    "divided-process": "div-rect",
    "divided-rectangle": "div-rect",
    doc: "doc",
    document: "doc",
    documents: "docs",
    docs: "docs",
    event: "rounded",
    extract: "tri",
    "f-circ": "f-circ",
    "filled-circle": "f-circ",
    flag: "flag",
    "flip-tri": "flip-tri",
    "flipped-triangle": "flip-tri",
    fork: "fork",
    "fr-circ": "fr-circ",
    "fr-rect": "fr-rect",
    "framed-circle": "fr-circ",
    "framed-rectangle": "fr-rect",
    "h-cyl": "h-cyl",
    "half-rounded-rectangle": "delay",
    hex: "hexagon",
    hexagon: "hexagon",
    "horizontal-cylinder": "h-cyl",
    hourglass: "hourglass",
    "in-out": "lean-r",
    "internal-storage": "win-pane",
    "inv-trapezoid": "trap-t",
    join: "fork",
    junction: "f-circ",
    "lean-left": "lean-l",
    "lean-l": "lean-l",
    "lean-r": "lean-r",
    "lean-right": "lean-r",
    "lightning-bolt": "bolt",
    "lin-cyl": "lin-cyl",
    "lin-doc": "lin-doc",
    "lin-proc": "lin-rect",
    "lin-rect": "lin-rect",
    "lined-cylinder": "lin-cyl",
    "lined-document": "lin-doc",
    "lined-process": "lin-rect",
    "lined-rectangle": "lin-rect",
    "loop-limit": "notch-pent",
    manual: "trap-t",
    "manual-file": "flip-tri",
    "manual-input": "sl-rect",
    "notch-pent": "notch-pent",
    "notch-rect": "notch-rect",
    "notched-pentagon": "notch-pent",
    "notched-rectangle": "notch-rect",
    odd: "odd",
    "out-in": "lean-l",
    "paper-tape": "flag",
    pill: "stadium",
    prepare: "hexagon",
    priority: "trap-b",
    proc: "rect",
    process: "rect",
    processes: "st-rect",
    procs: "st-rect",
    question: "diamond",
    rect: "rect",
    rectangle: "rect",
    rounded: "rounded",
    "shaded-process": "lin-rect",
    "sl-rect": "sl-rect",
    "sloped-rectangle": "sl-rect",
    "small-circle": "sm-circ",
    "sm-circ": "sm-circ",
    "st-doc": "docs",
    "st-rect": "st-rect",
    "stacked-document": "docs",
    "stacked-rectangle": "st-rect",
    stadium: "stadium",
    start: "sm-circ",
    stop: "fr-circ",
    "stored-data": "bow-rect",
    subproc: "fr-rect",
    subprocess: "fr-rect",
    subroutine: "subroutine",
    summary: "cross-circ",
    "tag-doc": "tag-doc",
    "tag-proc": "tag-rect",
    "tag-rect": "tag-rect",
    "tagged-document": "tag-doc",
    "tagged-process": "tag-rect",
    "tagged-rectangle": "tag-rect",
    terminal: "stadium",
    text: "text",
    "trap-b": "trap-b",
    "trap-t": "trap-t",
    trapezoid: "trap-b",
    "trapezoid-bottom": "trap-b",
    "trapezoid-top": "trap-t",
    tri: "tri",
    triangle: "tri",
    "win-pane": "win-pane",
    "window-pane": "win-pane",
  };

function cleanNodeLabel(label: string) {
  const trimmed = label.trim();
  const quote = trimmed[0];
  const unquoted =
    (quote === '"' || quote === "'") && trimmed.at(-1) === quote
      ? trimmed
          .slice(1, -1)
          .replace(new RegExp(`\\\\([\\\\${quote}])`, "g"), "$1")
      : trimmed;
  return unquoted.replace(/<br\s*\/?>/gi, "\n").replaceAll("&#124;", "|");
}

function parseFlowchartNodeLabel(label: string) {
  const trimmed = label.trim();
  const cleaned = cleanNodeLabel(label);
  const markdown =
    trimmed.startsWith('"') &&
    trimmed.endsWith('"') &&
    cleaned.startsWith("`") &&
    cleaned.endsWith("`") &&
    cleaned.length >= 2;
  return {
    label: markdown ? cleaned.slice(1, -1) : cleaned,
    markdown,
  };
}

function escapeFlowchartAttribute(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function flowchartLabelSource(value: string) {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\n", "<br/>")
    .replaceAll("|", "&#124;");
}

export function flowchartEdgeLabelSource(value: string) {
  const label = flowchartLabelSource(value);
  return label === label.trim()
    ? label
    : `"${escapeFlowchartAttribute(label)}"`;
}

function splitFlowchartAttributes(input: string) {
  const parts: string[] = [];
  let current = "";
  let escaped = false;
  let quote: '"' | "'" | null = null;
  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      if (quote === character) quote = null;
      else if (!quote) quote = character;
      current += character;
      continue;
    }
    if (character === "," && !quote) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (quote || escaped) return null;
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function parseExpandedShapeAttributes(input: string) {
  const parts = splitFlowchartAttributes(input);
  if (!parts) return null;
  const attributes = new Map<string, string>();
  for (const part of parts) {
    const separator = part.indexOf(":");
    if (separator <= 0) return null;
    const key = part.slice(0, separator).trim().toLowerCase();
    const value = part.slice(separator + 1).trim();
    if ((key !== "label" && key !== "shape") || !value || attributes.has(key)) {
      return null;
    }
    attributes.set(key, value);
  }
  const shapeName = attributes.get("shape");
  if (!shapeName) return null;
  const shape =
    EXPANDED_FLOWCHART_SHAPE_ALIASES[cleanNodeLabel(shapeName).toLowerCase()] ??
    null;
  if (!shape) return null;
  return {
    label: attributes.has("label")
      ? cleanNodeLabel(attributes.get("label") ?? "")
      : undefined,
    shape,
  };
}

function parseFlowchartHeader(header: string) {
  const match =
    /^(flowchart-elk|flowchart|graph)(?:\s+(TB|TD|BT|LR|RL))?$/.exec(header);
  if (!match) return null;
  return {
    direction: (match[2] ?? "TD") as MermaidVisualDirection,
    syntax: match[1] as MermaidFlowchartSyntax,
  };
}

function parseFlowchartSubgraphDirection(statement: string) {
  const match = /^direction\s+(TB|TD|BT|LR|RL)$/.exec(statement);
  return (match?.[1] as MermaidVisualDirection | undefined) ?? null;
}

function partiallyModeledFlowchartStatement(statement: string) {
  const trimmed = statement.trim().replace(/;$/, "").trim();
  if (/^[A-Za-z0-9_][\w-]*(?:[^\n]*?):::[A-Za-z0-9_-]+$/.test(trimmed)) {
    return true;
  }
  if (/^[A-Za-z0-9_][\w-]*\s*~~~\s*[A-Za-z0-9_][\w-]*$/.test(trimmed)) {
    return true;
  }
  if (
    trimmed.includes("&") &&
    /(?:-->|---|==>|-\.->|--o|--x)/.test(trimmed) &&
    /[A-Za-z0-9_][\w-]*/.test(trimmed)
  ) {
    return true;
  }
  return (
    /^[A-Za-z0-9_][\w-]*@\{[\s\S]*\}$/.test(trimmed) &&
    /\b(?:icon|img|image)\s*:/.test(trimmed)
  );
}

function getFlowchartDirectiveEndIndex(
  lines: readonly string[],
  startIndex: number,
) {
  for (let index = startIndex; index < lines.length; index += 1) {
    let closeIndex = lines[index].indexOf("}%%");
    while (closeIndex >= 0) {
      if (!lines[index].slice(closeIndex + 3).trim()) return index;
      closeIndex = lines[index].indexOf("}%%", closeIndex + 3);
    }
  }
  return -1;
}

function findFlowchartTokenClose(
  input: string,
  close: string,
  startIndex: number,
) {
  let escaped = false;
  let quote: '"' | "'" | null = null;
  for (let index = startIndex; index < input.length; index += 1) {
    const character = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      if (quote === character) quote = null;
      else if (!quote) quote = character;
      continue;
    }
    if (!quote && input.startsWith(close, index)) return index;
  }
  return -1;
}

export function parseFlowchartNodeToken(
  input: string,
  start = 0,
): ParsedFlowchartNodeToken | null {
  const leading = input.slice(start).match(/^\s*/)?.[0].length ?? 0;
  const idStart = start + leading;
  const idMatch = NODE_ID_RE.exec(input.slice(idStart));
  if (!idMatch) return null;

  const id = idMatch[0];
  const shapeStart = idStart + id.length;
  const rest = input.slice(shapeStart);
  if (rest.startsWith("@{")) {
    const closeIndex = findFlowchartTokenClose(input, "}", shapeStart + 2);
    if (closeIndex < 0) return null;
    const attributes = parseExpandedShapeAttributes(
      input.slice(shapeStart + 2, closeIndex),
    );
    if (!attributes) return null;
    const expandedLabel = attributes.label ?? id;
    const markdown =
      expandedLabel.startsWith("`") &&
      expandedLabel.endsWith("`") &&
      expandedLabel.length >= 2;
    return {
      end: closeIndex + 1,
      explicit: true,
      id,
      label: markdown ? expandedLabel.slice(1, -1) : expandedLabel,
      markdown,
      shape: attributes.shape,
      start: idStart,
    };
  }
  for (const delimiter of FLOWCHART_SHAPE_DELIMITERS) {
    if (!rest.startsWith(delimiter.open)) continue;
    const labelStart = shapeStart + delimiter.open.length;
    const closeIndex = findFlowchartTokenClose(
      input,
      delimiter.close,
      labelStart,
    );
    if (closeIndex < 0) return null;
    const parsedLabel = parseFlowchartNodeLabel(
      input.slice(labelStart, closeIndex),
    );
    return {
      end: closeIndex + delimiter.close.length,
      explicit: true,
      id,
      label: parsedLabel.label,
      markdown: parsedLabel.markdown,
      shape: delimiter.shape,
      start: idStart,
    };
  }

  return {
    end: shapeStart,
    explicit: false,
    id,
    label: id,
    markdown: false,
    shape: "rect",
    start: idStart,
  };
}

function parseSubgraphHeader(
  input: string,
  index: number,
  usedIds: ReadonlySet<string>,
): PendingFlowchartSubgraph | null {
  const match = /^subgraph\s+([\s\S]+)$/.exec(input);
  const rest = match?.[1].trim() ?? "";
  if (!rest) return null;
  const titledIdMatch = rest.match(/^([A-Za-z0-9_][\w-]*)\s*\[([\s\S]*)\]$/);
  if (titledIdMatch) {
    return {
      id: titledIdMatch[1],
      nodeIds: new Set(),
      title: cleanNodeLabel(titledIdMatch[2]),
    };
  }

  if (NODE_ID_RE.exec(rest)?.[0] === rest) {
    return {
      id: rest,
      nodeIds: new Set(),
      title: rest,
    };
  }
  const title = cleanNodeLabel(rest);
  let generatedIndex = index + 1;
  while (usedIds.has(`SG${generatedIndex}`)) generatedIndex += 1;
  return {
    id: `SG${generatedIndex}`,
    nodeIds: new Set(),
    title,
  };
}

function isSubgraphEndpoint(
  token: ParsedFlowchartNodeToken,
  subgraphs: PendingFlowchartSubgraph[],
) {
  return (
    !token.explicit && subgraphs.some((subgraph) => subgraph.id === token.id)
  );
}

function edgeStyle(token: string): MermaidVisualEdgeStyle {
  if (token === "==>") return "thick";
  if (token === "-.->") return "dotted";
  return "solid";
}

function normalizeFlowchartEdgeToken(token: string) {
  if (/^o-{2,}o$/.test(token)) return "o--o";
  if (/^x-{2,}x$/.test(token)) return "x--x";
  if (/^<-{2,}>$/.test(token)) return "<-->";
  if (/^<-{2,}$/.test(token)) return "<--";
  if (/^={2,}>$/.test(token)) return "==>";
  if (/^-\.+->$/.test(token)) return "-.->";
  if (/^-{2,}o$/.test(token)) return "--o";
  if (/^-{2,}x$/.test(token)) return "--x";
  if (/^-{2,}>$/.test(token)) return "-->";
  return "---";
}

function normalizeEdgeTextToken(
  start: string,
  end: string,
): "<-->" | "-->" | "---" | "==>" | "-.->" | "--o" | "--x" {
  if (start === "-." && end === ".->") return "-.->";
  if (start === "==" && end === "==>") return "==>";
  if (
    start === "--" &&
    (end === "-->" || end === "---" || end === "--o" || end === "--x")
  ) {
    return end;
  }
  return "-->";
}

export function parseFlowchartEdgeTokenWithLabel(input: string) {
  const textMatch = EDGE_TEXT_TOKEN_RE.exec(input);
  if (textMatch) {
    return {
      label: cleanNodeLabel(textMatch[2] ?? ""),
      token: normalizeEdgeTextToken(
        textMatch[1] ?? "--",
        textMatch[3] ?? "-->",
      ),
      end: textMatch[0].length,
    };
  }

  const edgeMatch = EDGE_TOKEN_RE.exec(input);
  if (!edgeMatch) return null;
  const sourceToken = edgeMatch[1]!;
  const token = normalizeFlowchartEdgeToken(sourceToken);
  let end = sourceToken.length;
  let label = "";
  const rest = input.slice(end).trimStart();
  const skippedWhitespace = input.slice(end).length - rest.length;
  if (rest.startsWith("|")) {
    const labelEnd = rest.indexOf("|", 1);
    if (labelEnd < 0) return null;
    label = cleanNodeLabel(rest.slice(1, labelEnd));
    end += skippedWhitespace + labelEnd + 1;
  }
  return { end, label, token };
}

function linkTypeFromToken(token: string): MermaidVisualEdgeLinkType {
  if (token === "<-->") return "bidirectional";
  if (token === "<--") return "reverse";
  if (token === "---") return "open";
  if (token === "==>") return "thick";
  if (token === "-.->") return "dotted";
  if (token === "--o") return "circle";
  if (token === "--x") return "cross";
  return "arrow";
}

function endpointMarkersFromToken(token: string) {
  if (token === "o--o") {
    return { sourceMarker: "circle" as const, targetMarker: "circle" as const };
  }
  if (token === "x--x") {
    return { sourceMarker: "cross" as const, targetMarker: "cross" as const };
  }
  return {};
}

function edgeTokenFromStyle(style: MermaidVisualEdgeStyle) {
  if (style === "thick") return "==>";
  if (style === "dotted") return "-.->";
  return "-->";
}

export function flowchartEdgeTokenSource(edge: MermaidVisualEdge) {
  const token = (() => {
    if (edge.sourceMarker === "circle" && edge.targetMarker === "circle") {
      return "o--o";
    }
    if (edge.sourceMarker === "cross" && edge.targetMarker === "cross") {
      return "x--x";
    }
    switch (
      edge.linkType ??
      linkTypeFromToken(edgeTokenFromStyle(edge.style))
    ) {
      case "bidirectional":
        return "<-->";
      case "circle":
        return "--o";
      case "cross":
        return "--x";
      case "dotted":
        return "-.->";
      case "open":
        return "---";
      case "reverse":
        return "<--";
      case "thick":
        return "==>";
      case "arrow":
      default:
        return "-->";
    }
  })();
  return edge.mermaidId ? `${edge.mermaidId}@${token}` : token;
}

export function flowchartNodeSource(node: MermaidVisualNode) {
  const delimiter =
    FLOWCHART_SHAPE_SOURCE[node.shape as keyof typeof FLOWCHART_SHAPE_SOURCE];
  const plainLabel = flowchartLabelSource(node.label);
  const markdown = flowchartNodeData(node).markdown;
  const label = markdown
    ? '"`' + escapeFlowchartAttribute(plainLabel) + '`"'
    : plainLabel;
  if (
    delimiter &&
    label === label.trim() &&
    !label.includes(delimiter.open) &&
    !label.includes(delimiter.close)
  ) {
    return `${node.id}${delimiter.open}${label}${delimiter.close}`;
  }
  const expandedLabel = markdown ? "`" + plainLabel + "`" : plainLabel;
  return `${node.id}@{ shape: ${node.shape}, label: "${escapeFlowchartAttribute(expandedLabel)}" }`;
}

export function flowchartSubgraphSource(subgraph: MermaidVisualSubgraph) {
  const title = flowchartLabelSource(subgraph.title);
  return `${subgraph.id} ["${escapeFlowchartAttribute(title)}"]`;
}

function flowchartPositionedComments(
  lines: readonly string[],
  headerIndex: number,
  model: Pick<MermaidVisualModel, "edges">,
) {
  const comments: MermaidFlowchartComment[] = [];
  let pending: MermaidFlowchartComment[] = [];
  let edgeIndex = 0;
  let inDirective = false;
  const subgraphStack: string[] = [];
  const anchorPending = (
    anchorKind: MermaidFlowchartComment["anchorKind"],
    anchorId?: string,
  ) => {
    comments.push(
      ...pending.map((comment) => ({ ...comment, anchorId, anchorKind })),
    );
    pending = [];
  };
  const flushDiagram = () => anchorPending("diagram");

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (inDirective) {
      if (trimmed.includes("}%%")) inDirective = false;
      continue;
    }
    if (trimmed.startsWith("%%{")) {
      inDirective = !trimmed.includes("}%%");
      continue;
    }
    if (trimmed.startsWith("%%")) {
      pending.push({
        anchorKind: "diagram",
        id: `comment-${comments.length + pending.length + 1}`,
        line: trimmed,
        position: "before",
      });
      continue;
    }
    if (!trimmed) continue;

    const subgraph = /^subgraph\s+([A-Za-z0-9_][\w-]*)/.exec(trimmed);
    if (subgraph?.[1]) {
      anchorPending("subgraph", subgraph[1]);
      subgraphStack.push(subgraph[1]);
      continue;
    }
    if (/^end\s*;?$/.test(trimmed)) {
      if (pending.length) anchorPending("subgraph", subgraphStack.at(-1));
      subgraphStack.pop();
      continue;
    }
    if (
      isFlowchartStyleStatement(trimmed) ||
      /^(?:accTitle|accDescr|title|direction)\s*:/i.test(trimmed) ||
      /^direction\b/.test(trimmed)
    ) {
      flushDiagram();
      continue;
    }

    if (partiallyModeledFlowchartStatement(trimmed)) {
      flushDiagram();
      continue;
    }

    const sourceNode = parseFlowchartNodeToken(trimmed);
    if (!sourceNode) {
      flushDiagram();
      continue;
    }
    let rest = trimmed.slice(sourceNode.end).trim();
    let statementEdgeCount = 0;
    while (rest && rest !== ";") {
      const edgeIdMatch = EDGE_ID_PREFIX_RE.exec(rest);
      if (edgeIdMatch) rest = rest.slice(edgeIdMatch[0].length).trim();
      const edge = parseFlowchartEdgeTokenWithLabel(rest);
      if (!edge) break;
      rest = rest.slice(edge.end).trim();
      const target = parseFlowchartNodeToken(rest);
      if (!target) break;
      rest = rest.slice(target.end).trim();
      statementEdgeCount += 1;
    }
    if (statementEdgeCount) {
      anchorPending("edge", model.edges[edgeIndex]?.id);
      edgeIndex += statementEdgeCount;
    } else {
      anchorPending("node", sourceNode.id);
    }
  }
  flushDiagram();
  return comments;
}

export function parseMermaidSourceToVisualModel(source: string) {
  const sourceHash = hashMermaidSource(source);
  const diagramType = detectMermaidDiagramType(source);
  if (diagramType !== "flowchart" && diagramType !== "flowchart-elk") {
    return { diagramType, model: null, sourceHash, visualModelHash: null };
  }

  const lines = source
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  const headerIndex = getMermaidSourceHeaderIndex(source);
  if (headerIndex < 0) {
    return { diagramType, model: null, sourceHash, visualModelHash: null };
  }
  const header = headerIndex >= 0 ? lines[headerIndex].trim() : "flowchart TD";
  const parsedHeader = parseFlowchartHeader(header);
  if (!parsedHeader) {
    return { diagramType, model: null, sourceHash, visualModelHash: null };
  }
  const { direction, syntax } = parsedHeader;
  const nodes = new Map<
    string,
    Omit<MermaidVisualNode, "height" | "width" | "x" | "y">
  >();
  const edges: MermaidVisualEdge[] = [];
  const edgeIds = new Set<string>();
  const explicitEdgeIds = new Set<string>();
  const subgraphs: PendingFlowchartSubgraph[] = [];
  const subgraphIds = new Set<string>();
  const subgraphIdByNodeId = new Map<string, string>();
  const styleStatements: string[] = [];
  const sourceAnnotations: string[] = [];
  const metadata = createMermaidCommonDiagramMetadata();
  let hasIdentityConflict = false;
  const subgraphStack: PendingFlowchartSubgraph[] = [];
  const upsertNode = ({
    explicit,
    id,
    label,
    markdown,
    shape,
  }: {
    explicit: boolean;
    id: string;
    label: string;
    markdown: boolean;
    shape: MermaidVisualNodeShape;
  }) => {
    if (subgraphIds.has(id) || explicitEdgeIds.has(id)) {
      hasIdentityConflict = true;
      return;
    }
    const existing = nodes.get(id);
    if (existing && !explicit) return;
    nodes.set(id, {
      familyData: explicit
        ? flowchartNodeFamilyData(markdown)
        : existing?.familyData,
      id,
      label: explicit ? label : (existing?.label ?? label),
      shape: explicit ? shape : (existing?.shape ?? "rect"),
    });
  };
  const addNodeToCurrentSubgraph = (id: string) => {
    const currentSubgraph = subgraphStack.at(-1);
    if (!currentSubgraph) return;
    const owner = subgraphIdByNodeId.get(id);
    if (owner) return;
    subgraphIdByNodeId.set(id, currentSubgraph.id);
    currentSubgraph.nodeIds.add(id);
  };

  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("%%{")) {
      const directiveEndIndex = getFlowchartDirectiveEndIndex(lines, index);
      if (directiveEndIndex >= 0) {
        while (index <= directiveEndIndex) {
          sourceAnnotations.push(lines[index]);
          index += 1;
        }
        index -= 1;
        continue;
      }
      return {
        diagramType,
        model: null,
        sourceHash,
        visualModelHash: null,
      };
    }
    if (trimmed.startsWith("%%")) {
      continue;
    }
    if (isFlowchartStyleStatement(trimmed)) {
      styleStatements.push(trimmed);
      continue;
    }
    const commonMetadata = consumeMermaidCommonMetadata(lines, index, metadata);
    if (commonMetadata.kind === "invalid") {
      return {
        diagramType,
        model: null,
        sourceHash,
        visualModelHash: null,
      };
    }
    if (commonMetadata.kind === "consumed") {
      index = commonMetadata.nextIndex - 1;
      continue;
    }
    if (/^subgraph\b/i.test(trimmed)) {
      const subgraph = parseSubgraphHeader(
        trimmed,
        subgraphs.length,
        new Set([...nodes.keys(), ...subgraphIds, ...explicitEdgeIds]),
      );
      if (
        !subgraph ||
        subgraphIds.has(subgraph.id) ||
        nodes.has(subgraph.id) ||
        explicitEdgeIds.has(subgraph.id)
      ) {
        return {
          diagramType,
          model: null,
          sourceHash,
          visualModelHash: null,
        };
      }
      subgraph.parentId = subgraphStack.at(-1)?.id;
      subgraphIds.add(subgraph.id);
      subgraphs.push(subgraph);
      subgraphStack.push(subgraph);
      continue;
    }
    if (trimmed === "end") {
      if (!subgraphStack.length) {
        return {
          diagramType,
          model: null,
          sourceHash,
          visualModelHash: null,
        };
      }
      subgraphStack.pop();
      continue;
    }
    if (/^direction\b/.test(trimmed)) {
      const currentSubgraph = subgraphStack.at(-1);
      const subgraphDirection = parseFlowchartSubgraphDirection(trimmed);
      if (!currentSubgraph || !subgraphDirection) {
        return {
          diagramType,
          model: null,
          sourceHash,
          visualModelHash: null,
        };
      }
      currentSubgraph.direction = subgraphDirection;
      continue;
    }

    if (partiallyModeledFlowchartStatement(trimmed)) {
      sourceAnnotations.push(line);
      continue;
    }

    const sourceNode = parseFlowchartNodeToken(trimmed);
    if (!sourceNode) {
      return {
        diagramType,
        model: null,
        sourceHash,
        visualModelHash: null,
      };
    }

    let rest = trimmed.slice(sourceNode.end).trim();
    if (!rest || rest === ";") {
      upsertNode({
        explicit: sourceNode.explicit,
        id: sourceNode.id,
        label: sourceNode.label,
        markdown: sourceNode.markdown,
        shape: sourceNode.shape,
      });
      addNodeToCurrentSubgraph(sourceNode.id);
      continue;
    }

    if (!isSubgraphEndpoint(sourceNode, subgraphs)) {
      upsertNode({
        explicit: sourceNode.explicit,
        id: sourceNode.id,
        label: sourceNode.label,
        markdown: sourceNode.markdown,
        shape: sourceNode.shape,
      });
      addNodeToCurrentSubgraph(sourceNode.id);
    }

    let activeSourceNode = sourceNode;
    while (rest && rest !== ";") {
      const edgeIdMatch = EDGE_ID_PREFIX_RE.exec(rest);
      const mermaidId = edgeIdMatch?.[1];
      if (edgeIdMatch) {
        rest = rest.slice(edgeIdMatch[0].length).trim();
      }
      const edgeToken = parseFlowchartEdgeTokenWithLabel(rest);
      if (!edgeToken) {
        return {
          diagramType,
          model: null,
          sourceHash,
          visualModelHash: null,
        };
      }
      rest = rest.slice(edgeToken.end).trim();

      const targetNode = parseFlowchartNodeToken(rest);
      if (!targetNode) {
        return {
          diagramType,
          model: null,
          sourceHash,
          visualModelHash: null,
        };
      }
      rest = rest.slice(targetNode.end).trim();

      if (!isSubgraphEndpoint(targetNode, subgraphs)) {
        upsertNode({
          explicit: targetNode.explicit,
          id: targetNode.id,
          label: targetNode.label,
          markdown: targetNode.markdown,
          shape: targetNode.shape,
        });
        addNodeToCurrentSubgraph(targetNode.id);
      }
      const edgeId =
        mermaidId ??
        `edge-${activeSourceNode.id}-${targetNode.id}-${edges.length + 1}`;
      if (
        edgeIds.has(edgeId) ||
        (mermaidId && (nodes.has(mermaidId) || subgraphIds.has(mermaidId)))
      ) {
        return {
          diagramType,
          model: null,
          sourceHash,
          visualModelHash: null,
        };
      }
      edgeIds.add(edgeId);
      if (mermaidId) explicitEdgeIds.add(mermaidId);
      edges.push({
        ...endpointMarkersFromToken(edgeToken.token),
        id: edgeId,
        label: edgeToken.label,
        linkType: linkTypeFromToken(edgeToken.token),
        mermaidId,
        source: activeSourceNode.id,
        style: edgeStyle(edgeToken.token),
        target: targetNode.id,
      });
      activeSourceNode = targetNode;
    }
  }

  if (
    subgraphStack.length ||
    hasIdentityConflict ||
    [...edgeIds].some((id) => nodes.has(id) || subgraphIds.has(id))
  ) {
    return {
      diagramType,
      model: null,
      sourceHash,
      visualModelHash: null,
    };
  }

  const laidOutNodes = separateFlowchartSubgraphMemberBands(
    subgraphs,
    layoutFlowchartNodes([...nodes.values()], edges, direction),
    direction,
  );
  const modelWithoutComments: MermaidVisualModel = {
    accessibilityDescription: metadata.accessibilityDescription,
    accessibilityTitle: metadata.accessibilityTitle,
    diagramType,
    diagramTitle: metadata.diagramTitle,
    direction,
    edges,
    nodes: laidOutNodes,
    sourceAnnotations,
    sourcePreamble: lines.slice(0, headerIndex),
    styleStatements,
    subgraphs: computeFlowchartSubgraphBounds(subgraphs, laidOutNodes),
    familyData: flowchartModelFamilyData(syntax),
    version: 1,
  };
  const model: MermaidVisualModel = {
    ...modelWithoutComments,
    familyData: flowchartModelFamilyData(
      syntax,
      flowchartPositionedComments(lines, headerIndex, modelWithoutComments),
    ),
  };

  return {
    diagramType,
    model,
    sourceHash,
    visualModelHash: createMermaidGfxModelHash(model),
  };
}
