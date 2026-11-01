import {
  MERMAID_GFX_EDGE_ROLE,
  MERMAID_GFX_NODE_ROLE,
  MERMAID_GFX_SUBGRAPH_ROLE,
  MERMAID_GFX_TITLE_ROLE,
} from "./families/runtime/gfx-element-roles.js";

export type MermaidGfxRole =
  | typeof MERMAID_GFX_EDGE_ROLE
  | typeof MERMAID_GFX_NODE_ROLE
  | typeof MERMAID_GFX_SUBGRAPH_ROLE
  | typeof MERMAID_GFX_TITLE_ROLE
  | string;

type MermaidGfxLike = {
  [key: string]: unknown;
  id?: string;
  mermaidRole?: string;
  props?: Record<string, unknown> & {
    mermaidRole?: string;
    source?: { id?: string };
    target?: { id?: string };
    type?: string;
  };
  source?: { id?: string };
  target?: { id?: string };
  type?: string;
  yMap?: {
    get?: (key: string) => unknown;
    set?: (key: string, value: unknown) => void;
  };
};

export function readMermaidGfxMeta(model: unknown, key: string) {
  const raw = model as MermaidGfxLike | null | undefined;
  if (!raw) return "";
  const value = raw.yMap?.get?.(key) ?? raw.props?.[key] ?? raw[key];
  return value == null ? "" : String(value);
}

export function hasMermaidGfxMeta(model: unknown, key: string) {
  const raw = model as MermaidGfxLike | null | undefined;
  if (!raw) return false;
  const yMapValue = raw.yMap?.get?.(key);
  if (yMapValue !== undefined && yMapValue !== null) return true;
  const propValue = raw.props?.[key];
  if (propValue !== undefined && propValue !== null) return true;
  const directValue = raw[key];
  return directValue !== undefined && directValue !== null;
}

export function writeMermaidGfxMeta(
  model: unknown,
  key: string,
  value: unknown,
) {
  const raw = model as MermaidGfxLike | null | undefined;
  if (!raw) return;
  if (key.startsWith("mermaid")) raw.yMap?.set?.(key, value);
  if (raw.props) raw.props[key] = value;
  raw[key] = value;
}

export function readMermaidGfxRole(model: unknown) {
  return readMermaidGfxMeta(model, "mermaidRole") as MermaidGfxRole;
}

export function readMermaidGfxElementType(model: unknown) {
  const raw = model as MermaidGfxLike | null | undefined;
  return String(raw?.type ?? raw?.props?.type ?? "");
}

export function readMermaidGfxNodeId(model: unknown) {
  return readMermaidGfxMeta(model, "mermaidNodeId");
}

export function readMermaidGfxNodeLabel(model: unknown) {
  return readMermaidGfxMeta(model, "mermaidNodeLabel");
}

export function readMermaidGfxNodeDisplayLabel(model: unknown) {
  return readMermaidGfxMeta(model, "mermaidNodeDisplayLabel");
}

function normalizedDisplayText(value: string) {
  return value.replace(/\r/g, "").trim();
}

function flattenedDisplayText(value: string) {
  return normalizedDisplayText(value).replace(/\n/g, "");
}

function firstDisplayLabelLine(value: string) {
  return normalizedDisplayText(value)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

export function resolveMermaidGfxNodeLabelsFromVisibleText(
  model: unknown,
  visibleText: string,
) {
  const currentLabel = readMermaidGfxNodeLabel(model);
  const currentDisplayLabel = readMermaidGfxNodeDisplayLabel(model);
  const nextDisplayLabel = normalizedDisplayText(visibleText);
  const visibleMatchesCurrentDisplay =
    currentDisplayLabel &&
    flattenedDisplayText(nextDisplayLabel) ===
      flattenedDisplayText(currentDisplayLabel);

  return {
    displayLabel: visibleMatchesCurrentDisplay
      ? currentDisplayLabel
      : nextDisplayLabel,
    label: visibleMatchesCurrentDisplay
      ? currentLabel
      : (firstDisplayLabelLine(nextDisplayLabel) ?? currentLabel),
  };
}

export function syncMermaidGfxNodeLabelsFromVisibleText(
  model: unknown,
  visibleText: string,
) {
  const next = resolveMermaidGfxNodeLabelsFromVisibleText(model, visibleText);
  let changed = false;
  if (readMermaidGfxNodeLabel(model) !== next.label) {
    writeMermaidGfxMeta(model, "mermaidNodeLabel", next.label);
    changed = true;
  }
  if (readMermaidGfxNodeDisplayLabel(model) !== next.displayLabel) {
    writeMermaidGfxMeta(model, "mermaidNodeDisplayLabel", next.displayLabel);
    changed = true;
  }
  return changed;
}

export function readMermaidGfxEdgeId(model: unknown) {
  return readMermaidGfxMeta(model, "mermaidEdgeId");
}

export function readMermaidGfxSubgraphId(model: unknown) {
  return readMermaidGfxMeta(model, "mermaidSubgraphId");
}

export function isMermaidGfxNodeModel(model: unknown) {
  return readMermaidGfxRole(model) === MERMAID_GFX_NODE_ROLE;
}

export function isMermaidGfxEdgeModel(model: unknown) {
  return readMermaidGfxRole(model) === MERMAID_GFX_EDGE_ROLE;
}

export function isMermaidGfxSubgraphModel(model: unknown) {
  return readMermaidGfxRole(model) === MERMAID_GFX_SUBGRAPH_ROLE;
}

export function isManagedMermaidGfxElement(model: unknown) {
  const type = readMermaidGfxElementType(model);
  const role = readMermaidGfxRole(model);
  return (
    type === "shape" ||
    type === "connector" ||
    role === MERMAID_GFX_NODE_ROLE ||
    role === MERMAID_GFX_EDGE_ROLE ||
    role === MERMAID_GFX_SUBGRAPH_ROLE ||
    role === MERMAID_GFX_TITLE_ROLE
  );
}

export function hasMermaidDanglingConnector(
  model: unknown,
  allowedElementIds: ReadonlySet<string>,
) {
  const raw = model as MermaidGfxLike;
  if (
    readMermaidGfxElementType(model) !== "connector" &&
    !isMermaidGfxEdgeModel(model)
  ) {
    return false;
  }
  const sourceId = raw.source?.id ?? raw.props?.source?.id;
  const targetId = raw.target?.id ?? raw.props?.target?.id;
  return (
    !sourceId ||
    !targetId ||
    !allowedElementIds.has(sourceId) ||
    !allowedElementIds.has(targetId)
  );
}
