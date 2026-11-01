// SPDX-License-Identifier: AGPL-3.0-or-later

import { sourceValuesEqual } from "../source-yaml.js";

import type { MermaidKanbanModel } from "./model.js";
import type { SourceValuePatch } from "../source-yaml.js";
import { parseMermaidKanbanSource } from "./parser.js";

export type KanbanPatch = SourceValuePatch & {
  identities?: readonly (readonly [number, string])[];
};
export type KanbanCommandResult = {
  changed: boolean;
  source: string;
  model: MermaidKanbanModel;
  reason: "applied" | "no-change" | "conflict" | "invalid" | "readonly";
  selection?: { cardId?: string; columnId?: string };
};
export function kanbanNoChange(
  model: MermaidKanbanModel,
  reason: KanbanCommandResult["reason"] = "no-change",
): KanbanCommandResult {
  return { changed: false, source: model.sourceDocument.source, model, reason };
}

/** Apply all patches in memory and verify identity, independent membership and diagnostics before history. */
export function writeKanbanPatches(
  model: MermaidKanbanModel,
  patches: readonly KanbanPatch[],
  options: {
    removed?: ReadonlySet<string>;
    memberships?: ReadonlyMap<string, string>;
    selection?: KanbanCommandResult["selection"];
    edited?: {
      id: string;
      label?: boolean;
      nativeId?: boolean;
      icon?: boolean;
      className?: boolean;
      metadataField?: string;
    };
  } = {},
): KanbanCommandResult {
  const source = model.sourceDocument.source;
  const sorted = [...patches].sort(
    (a, b) => a.range.start - b.range.start || a.range.end - b.range.end,
  );
  const mapping = new Map<number, string>();
  const reserved = new Set<string>();
  let cursor = 0;
  let next = "";
  for (const patch of sorted) {
    if (
      patch.range.start < cursor ||
      patch.range.end < patch.range.start ||
      patch.range.end > source.length
    )
      return kanbanNoChange(model, "invalid");
    next += source.slice(cursor, patch.range.start);
    for (const [offset, id] of patch.identities ?? []) {
      mapping.set(next.length + offset, id);
      reserved.add(id);
    }
    next += patch.value;
    cursor = patch.range.end;
  }
  next += source.slice(cursor);
  // Structural edits preserve the document's original final-EOL convention too.
  if (source && !/[\r\n]$/.test(source) && /[\r\n]$/.test(next))
    next = next.replace(/(?:\r\n|\r|\n)$/, "");
  if (next === source) return kanbanNoChange(model);
  for (const record of model.sourceDocument.records) {
    if (
      options.removed?.has(record.sourceKey) ||
      reserved.has(record.sourceKey)
    )
      continue;
    let offset = record.range.start;
    let deleted = false;
    for (const patch of sorted) {
      if (record.range.start < patch.range.start) break;
      if (
        patch.range.end > patch.range.start &&
        record.range.start >= patch.range.start &&
        record.range.start < patch.range.end
      ) {
        // A field replacement at a node's exact start retains that node; whole-line removal does not.
        if (
          patch.range.start === record.range.start &&
          patch.value &&
          patch.range.end <= record.range.end
        )
          break;
        deleted = true;
        break;
      }
      offset += patch.value.length - (patch.range.end - patch.range.start);
    }
    if (!deleted) mapping.set(offset, record.sourceKey);
  }
  const parsed = parseMermaidKanbanSource(next, model, mapping);
  if (
    !parsed ||
    parsed.ambiguous ||
    parsed.diagnostics.some(
      (error) =>
        !model.diagnostics.some(
          (old) => old.code === error.code && old.anchorId === error.anchorId,
        ),
    )
  )
    return kanbanNoChange(model, "invalid");
  const objects = [...parsed.columns, ...parsed.cards];
  if (new Set(objects.map((item) => item.id)).size !== objects.length)
    return kanbanNoChange(model, "conflict");
  for (const column of model.columns) {
    if (
      !options.removed?.has(column.id) &&
      !parsed.columns.some((item) => item.id === column.id)
    )
      return kanbanNoChange(model, "invalid");
  }
  for (const node of [...model.columns, ...model.cards]) {
    if (options.removed?.has(node.id)) continue;
    const retained = objects.find((item) => item.id === node.id);
    if (!retained) return kanbanNoChange(model, "invalid");
    const permission =
      options.edited?.id === node.id ? options.edited : undefined;
    if (
      (!permission?.label && retained.label !== node.label) ||
      (!permission?.nativeId && retained.nativeId !== node.nativeId) ||
      (!permission?.icon && retained.icon !== node.icon) ||
      (!permission?.className && retained.className !== node.className)
    )
      return kanbanNoChange(model, "invalid");
    for (const field of new Set([
      ...Object.keys(node.metadata),
      ...Object.keys(retained.metadata),
    ])) {
      if (
        field !== permission?.metadataField &&
        !sourceValuesEqual(node.metadata[field], retained.metadata[field])
      )
        return kanbanNoChange(model, "invalid");
    }
  }
  for (const card of model.cards) {
    if (options.removed?.has(card.id)) continue;
    const retained = parsed.cards.find((item) => item.id === card.id);
    if (
      !retained ||
      retained.columnId !== (options.memberships?.get(card.id) ?? card.columnId)
    )
      return kanbanNoChange(model, "invalid");
  }
  for (const comment of model.comments) {
    if (options.removed?.has(comment.id)) continue;
    const retained = parsed.comments.find((item) => item.id === comment.id);
    if (
      !retained ||
      retained.anchorId !== comment.anchorId ||
      retained.affinity !== comment.affinity
    )
      return kanbanNoChange(model, "invalid");
  }
  return {
    changed: true,
    source: next,
    model: parsed,
    reason: "applied",
    selection: options.selection,
  };
}

/** New-template serialization only. Existing source is always exported from sourceDocument. */
export function generateMermaidKanbanSource(model: MermaidKanbanModel) {
  return model.sourceDocument.source;
}
