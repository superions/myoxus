// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TreemapModel, TreemapQuote, TreemapSelection } from "./model.js";
import { parseTreemapSource } from "./parser.js";
import type { TreemapRange } from "./source-document.js";

export type TreemapPatch = {
  readonly range: Pick<TreemapRange, "start" | "end">;
  readonly value: string;
};

export type TreemapCommandResult = {
  readonly changed: boolean;
  readonly diagnosis: string;
  readonly model: TreemapModel;
  readonly source: string;
  readonly selection: TreemapSelection;
};

export function treemapNoChange(
  model: TreemapModel,
  diagnosis: string,
): TreemapCommandResult {
  return {
    changed: false,
    diagnosis,
    model,
    source: model.sourceDocument.source,
    selection: null,
  };
}

export function applyTreemapPatches(
  source: string,
  patches: readonly TreemapPatch[],
) {
  const ordered = [...patches].sort(
    (left, right) => right.range.start - left.range.start,
  );
  let result = source;
  let boundary = source.length;
  for (const patch of ordered) {
    if (
      patch.range.start < 0 ||
      patch.range.end < patch.range.start ||
      patch.range.end > boundary
    )
      return null;
    result =
      result.slice(0, patch.range.start) +
      patch.value +
      result.slice(patch.range.end);
    boundary = patch.range.start;
  }
  return result;
}

export function treemapPatchedOffset(
  position: number,
  patches: readonly TreemapPatch[],
) {
  return patches.reduce(
    (offset, patch) =>
      patch.range.end <= position
        ? offset + patch.value.length - (patch.range.end - patch.range.start)
        : offset,
    position,
  );
}

function sameDiagnostic(
  left: TreemapModel["diagnostics"][number],
  right: TreemapModel["diagnostics"][number],
) {
  return (
    left.code === right.code &&
    left.recordId === right.recordId &&
    left.field === right.field
  );
}

/** Reparse the patch before commit and reject only newly introduced defects. */
export function treemapPatchedResult(
  model: TreemapModel,
  patches: readonly TreemapPatch[],
  selection: TreemapSelection,
  relocated?: ReadonlyMap<number, string>,
): TreemapCommandResult {
  if (model.ambiguous) return treemapNoChange(model, "ambiguous-source");
  const source = applyTreemapPatches(model.sourceDocument.source, patches);
  if (source === null) return treemapNoChange(model, "conflict");
  if (source === model.sourceDocument.source)
    return treemapNoChange(model, "no-change");
  const mapping = new Map<number, string>();
  for (const record of model.sourceDocument.records) {
    if (
      patches.some(
        (patch) =>
          patch.range.start <= record.range.start &&
          patch.range.end >= record.range.end,
      )
    )
      continue;
    mapping.set(treemapPatchedOffset(record.range.start, patches), record.id);
  }
  for (const [offset, id] of relocated ?? []) mapping.set(offset, id);
  const next = parseTreemapSource(source, model, mapping);
  if (!next || next.ambiguous)
    return treemapNoChange(model, "ambiguous-source");
  const introduced = next.diagnostics.find(
    (diagnostic) =>
      diagnostic.code !== "conflict" &&
      diagnostic.code !== "unresolved-class" &&
      !model.diagnostics.some((old) => sameDiagnostic(old, diagnostic)),
  );
  if (introduced) return treemapNoChange(model, introduced.code);
  return { changed: true, diagnosis: "ok", model: next, source, selection };
}

export function encodeTreemapLabel(
  label: string,
  preferred: TreemapQuote = "double",
) {
  const value = label.trim();
  if (!value || (value.includes('"') && value.includes("'"))) return null;
  const preferredCharacter = preferred === "double" ? '"' : "'";
  const quote: TreemapQuote = value.includes(preferredCharacter)
    ? preferred === "double"
      ? "single"
      : "double"
    : preferred;
  return quote === "double" ? `"${value}"` : `'${value}'`;
}

export function encodeTreemapValue(value: number) {
  if (!Number.isFinite(value) || value < 0) return null;
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toPrecision(12)));
}

export function treemapInsertionOffset(model: TreemapModel, parentId?: string) {
  if (!parentId) {
    const header = model.sourceDocument.records.find(
      (record) => record.kind === "header",
    );
    return header?.range.end ?? model.sourceDocument.source.length;
  }
  const descendants = new Set<string>([parentId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of model.nodes) {
      if (
        node.parentId &&
        descendants.has(node.parentId) &&
        !descendants.has(node.id)
      ) {
        descendants.add(node.id);
        changed = true;
      }
    }
  }
  const last = model.nodes
    .filter((node) => descendants.has(node.id))
    .sort((left, right) => right.sourceOrder - left.sourceOrder)[0];
  return last
    ? (model.sourceDocument.records.find(
        (record) => record.id === last.recordId,
      )?.range.end ?? model.sourceDocument.source.length)
    : model.sourceDocument.source.length;
}

export function treemapChildIndent(model: TreemapModel, parentId: string) {
  const parent = model.nodes.find((node) => node.id === parentId);
  if (!parent) return null;
  const sibling = model.nodes.find((node) => node.parentId === parentId);
  if (sibling) return sibling.indent;
  const ownUnit = parent.indent.match(/([ \t]+)$/)?.[1];
  return parent.indent + (ownUnit || "  ");
}
