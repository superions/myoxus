// SPDX-License-Identifier: AGPL-3.0-or-later

import { DocModeProvider } from "@virgultum/editor/shared/services";
import { TextSelection } from "@virgultum/editor/std";
import type { BlockStdScope } from "@virgultum/editor/std";
import type { BlockModel } from "@virgultum/editor/store";

export const TASK_CAPTURE_TEXT_LIMIT = 8000;
export type TaskCaptureSelection = {
  sourceExternalId: string;
  blockId: string;
  selectionAnchor?: string;
  excerpt: string;
};

/** Snapshot only the selected text before opening an asynchronous capture UI.
 * No editor mutation or live selection is retained by the SQL capture request.
 */
export function snapshotTaskCaptureSelection(
  std: BlockStdScope,
  models: BlockModel[],
): TaskCaptureSelection | null {
  if (
    !models.length ||
    models.some(
      (model) => !["myoxus:paragraph", "myoxus:list"].includes(model.flavour),
    )
  )
    return null;
  const mode = std.getOptional(DocModeProvider)?.getEditorMode() ?? "page";
  const notes = models.map((model) => {
    let current: BlockModel | null = model;
    const seen = new Set<string>();
    while (current && current.flavour !== "myoxus:note") {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      current = std.store.getParent(current);
    }
    return current;
  });
  const note = notes[0];
  if (
    mode === "edgeless" &&
    (!note || notes.some((parent) => parent?.id !== note.id))
  )
    return null;
  const selection = std.selection.find(TextSelection);
  if (selection && !selection.isCollapsed()) {
    const endpointIds = new Set([
      selection.from.blockId,
      selection.to?.blockId ?? selection.from.blockId,
    ]);
    if (
      !endpointIds.has(models[0].id) ||
      !endpointIds.has(models[models.length - 1].id) ||
      !models.some((model) => model.id === selection.from.blockId) ||
      (selection.to &&
        !models.some((model) => model.id === selection.to!.blockId)) ||
      (endpointIds.size === 1 && models.length !== 1)
    )
      return null;
    for (const point of [selection.from, selection.to]) {
      if (!point) continue;
      const value = models
        .find((model) => model.id === point.blockId)
        ?.text?.toString();
      if (
        typeof value !== "string" ||
        point.index < 0 ||
        point.length < 0 ||
        point.index + point.length > value.length
      )
        return null;
    }
  }
  const parts = models.map((model) => {
    const text = model.text;
    if (!text || typeof text.toString !== "function") return "";
    const value = text.toString();
    if (!selection || selection.isCollapsed()) return value;
    if (model.id === selection.from.blockId)
      return value.slice(
        selection.from.index,
        selection.from.index + selection.from.length,
      );
    if (model.id === selection.to?.blockId)
      return value.slice(
        selection.to.index,
        selection.to.index + selection.to.length,
      );
    return value;
  });
  const excerpt = parts.join("\n").trim();
  if (!excerpt || excerpt.length > TASK_CAPTURE_TEXT_LIMIT) return null;
  // Native selection JSON also carries the frozen placement mode/Note. Retained
  // captures must not adopt a later canvas selection or a moved source fragment.
  const nativeSelection =
    selection && !selection.isCollapsed()
      ? selection.toJSON()
      : note
        ? new TextSelection({
            from: {
              blockId: models[0].id,
              index: 0,
              length: models[0].text?.length ?? parts[0].length,
            },
            to:
              models.length > 1
                ? {
                    blockId: models[models.length - 1].id,
                    index: 0,
                    length: parts[parts.length - 1].length,
                  }
                : null,
          }).toJSON()
        : undefined;
  return {
    sourceExternalId: std.store.doc.id,
    blockId: models[0].id,
    selectionAnchor: nativeSelection
      ? JSON.stringify({
          ...nativeSelection,
          ...(note ? { captureMode: mode, noteId: note.id } : {}),
        })
      : undefined,
    excerpt,
  };
}
