import { hashMermaidSource } from "./engine/source-hash.js";
export { hashMermaidSource } from "./engine/source-hash.js";
import {
  DEFAULT_MERMAID_BLOCK_TITLE,
  type MermaidBlockModel,
} from "@virgultum/model";

import { MERMAID_PRODUCT_DIAGRAM_SPECS } from "./engine/product-types.js";
import { localizeMermaidDiagramTypeLabel, mermaidMessages } from "./i18n.js";

export type MermaidBlockSnapshotLike = {
  source?: unknown;
  title?: unknown;
};

function deltaToString(value: unknown) {
  const delta = (value as { delta?: Array<{ insert?: unknown }> } | undefined)
    ?.delta;
  if (!Array.isArray(delta)) return null;
  return delta
    .map((entry) => (typeof entry.insert === "string" ? entry.insert : ""))
    .join("");
}

export function coerceMermaidBlockText(value: unknown) {
  if (typeof value === "string") return value.trim();
  const deltaText = deltaToString(value);
  if (deltaText !== null) return deltaText.trim();
  if (value && typeof value === "object" && "toString" in value) {
    if ("length" in value && value.length === 0) return "";
    const toString = (value as { toString?: () => string }).toString;
    if (typeof toString !== "function") return "";
    const text = toString.call(value).trim();
    return text === "[object Object]" ? "" : text;
  }
  return "";
}

function readMermaidSourceText(value: unknown) {
  if (typeof value === "string") return value;
  const deltaText = deltaToString(value);
  if (deltaText !== null) return deltaText;
  if (value && typeof value === "object" && "toString" in value) {
    const toString = (value as { toString?: () => string }).toString;
    if (typeof toString !== "function") return "";
    const text = toString.call(value);
    return text === "[object Object]" ? "" : text;
  }
  return "";
}

export function coerceMermaidSource(value: unknown) {
  return readMermaidSourceText(value).replaceAll("\r\n", "\n");
}

export function normalizeMermaidSourceInput(value: unknown) {
  const source = coerceMermaidSource(value).trim();
  const exactFence = source.match(
    /^\s*```(?:mermaid|mmd)\b[^\n]*\n([\s\S]*?)\n?```\s*$/i,
  );
  if (exactFence) return exactFence[1].replaceAll("\r\n", "\n").trimEnd();

  const fenced = source.match(/```(?:mermaid|mmd)\b[^\n]*\n([\s\S]*?)\n```/i);
  return (fenced?.[1] ?? source).replaceAll("\r\n", "\n");
}

export function getMermaidBlockTitle(props: MermaidBlockSnapshotLike) {
  return (
    coerceMermaidBlockText(props.title) ||
    DEFAULT_MERMAID_BLOCK_TITLE ||
    mermaidMessages.defaultTitle()
  );
}

export function getMermaidBlockSource(props: MermaidBlockSnapshotLike) {
  // Persisted-source reads also serve clipboard/export and opening-source
  // comparisons; normalization belongs only to explicit import/write paths.
  return readMermaidSourceText(props.source);
}

const MERMAID_PRODUCT_LABEL_BY_TYPE = new Map<string, string>(
  MERMAID_PRODUCT_DIAGRAM_SPECS.map(({ diagramType, label }) => [
    diagramType,
    label,
  ]),
);

const MERMAID_AUTOMATIC_BLOCK_TITLES = new Set<string>([
  DEFAULT_MERMAID_BLOCK_TITLE,
  ...MERMAID_PRODUCT_DIAGRAM_SPECS.map(({ label }) => label),
]);

export function getMermaidDiagramTypeLabel(diagramType: string) {
  const fallback = MERMAID_PRODUCT_LABEL_BY_TYPE.get(diagramType) ?? "";
  return fallback ? localizeMermaidDiagramTypeLabel(diagramType, fallback) : "";
}

export function isMermaidAutomaticBlockTitle(title: string) {
  const normalized = title.trim();
  return (
    MERMAID_AUTOMATIC_BLOCK_TITLES.has(normalized) ||
    normalized === mermaidMessages.defaultTitle() ||
    MERMAID_PRODUCT_DIAGRAM_SPECS.some(
      ({ diagramType }) =>
        normalized === getMermaidDiagramTypeLabel(diagramType),
    )
  );
}

export function setMermaidBlockText(
  model: MermaidBlockModel,
  key: "source" | "title",
  value: string,
  {
    preserveSourceBytes = false,
  }: { readonly preserveSourceBytes?: boolean } = {},
) {
  const normalized = preserveSourceBytes
    ? value
    : value.replaceAll("\r\n", "\n");
  const text = model.props[key];
  if (text.toString() === normalized) {
    if (key === "source") {
      model.props.sourceHash = hashMermaidSource(normalized);
    }
    return false;
  }
  text.delete(0, text.length);
  text.insert(normalized, 0);
  if (key === "source") {
    model.props.sourceHash = hashMermaidSource(normalized);
  }
  return true;
}
