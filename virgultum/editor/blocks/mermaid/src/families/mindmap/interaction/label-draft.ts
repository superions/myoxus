// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidGfxActionContext } from "../../runtime/editor-capabilities.js";
import type { MermaidVisualModel } from "../../runtime/gfx-model.js";
import { readMindmapProjectionModel } from "../source-application.js";
import { readMindmapProjectionOptions } from "../gfx-data.js";
import { projectMindmapTree } from "../projection/tree.js";
import { runMindmapAction } from "../actions.js";
import type {
  MindmapEditIntent,
  MindmapReactHostProps,
} from "../react-host-contract.js";
import { mermaidMessages as m } from "../../../i18n.js";
import { mindmapChildSideOptions } from "./handles.js";
import type { ShapeTextEditDraft } from "@virgultum/gfx-shape";

export type MindmapLabelDraft = { cancel: () => void; valid: () => boolean };
type Port = Pick<
  MermaidGfxActionContext,
  "previewVisualModel" | "mountShapeDraft"
> & {
  getSource: () => string;
  getReadonly: () => boolean;
  getVisualModel: () => MermaidVisualModel;
  command: MindmapReactHostProps["onCommand"];
  clearSelection: () => void;
  selectAfterPreview: (key: string) => void;
  subscribeInvalidation?: (invalidate: () => void) => () => void;
  restoreSelection: () => void;
  finish: () => void;
  renderActions?: ShapeTextEditDraft["renderActions"];
};

/** Existing and newly reserved occurrences share a local text/metric preview.
 * Only confirmation invokes the checked Source writer on the original basis. */
export function beginMindmapLabelDraft(
  port: Port,
  intent: Exclude<
    MindmapEditIntent,
    {
      type:
        | "layout"
        | "import"
        | "properties"
        | "move"
        | "delete"
        | "duplicate"
        | "toggle-collapse";
    }
  >,
): MindmapLabelDraft | null {
  if (port.getReadonly() || !port.previewVisualModel || !port.mountShapeDraft)
    return null;
  const basis = port.getSource(),
    visual = port.getVisualModel();
  const model = readMindmapProjectionModel(basis, visual);
  if (!model) return null;
  const existing =
    intent.type === "rename"
      ? model.nodes.find((node) => node.sourceKey === intent.key)
      : undefined;
  if (intent.type === "rename" && !existing) return null;
  const initial = existing?.label ?? m.nodePlaceholder();
  const prepared = existing
    ? null
    : runMindmapAction(model, { ...intent, label: initial });
  if (!existing && (!prepared?.changed || !prepared.selection)) return null;
  const key = existing?.sourceKey ?? prepared!.selection!;
  const candidate = existing ? model : prepared!.model;
  const options =
    intent.type === "add-child"
      ? mindmapChildSideOptions(visual, model, key, intent.key, intent.side)
      : readMindmapProjectionOptions(visual);
  let preview = port.previewVisualModel(projectMindmapTree(candidate, options));
  const shape = preview.resolveNode?.(key);
  if (!shape) {
    preview();
    return null;
  }
  let finished = false,
    committing = false,
    closeEditor: (() => void) | null = null;
  const valid = () => {
    if (committing) return true;
    if (finished || port.getReadonly() || port.getSource() !== basis)
      return false;
    const current = port.getVisualModel();
    // Source-neutral remote Collapse must also invalidate hidden drafts.
    if (
      "key" in intent &&
      !current.nodes.some((node) => node.id === intent.key)
    )
      return false;
    return (
      intent.type !== "add-child" ||
      !readMindmapProjectionOptions(current).collapsed?.has(intent.key) ||
      Boolean(readMindmapProjectionOptions(visual).collapsed?.has(intent.key))
    );
  };
  const cancel = () => {
    if (finished || committing) return;
    finished = true;
    preview();
    closeEditor?.();
    port.restoreSelection();
    port.finish();
  };
  try {
    port.clearSelection();
    closeEditor = port.mountShapeDraft(shape, {
      ariaLabel: m.selectedNodeLabel(),
      value: initial,
      isValid: valid,
      cancel,
      renderActions: port.renderActions,
      subscribeInvalidation: (invalidate) =>
        port.subscribeInvalidation?.(() => {
          if (!valid()) invalidate();
        }) ?? (() => {}),
      preview: (label) => {
        const next = {
          ...candidate,
          nodes: candidate.nodes.map((node) =>
            node.sourceKey === key ? { ...node, label } : node,
          ),
        };
        preview();
        preview = port.previewVisualModel!(projectMindmapTree(next, options));
        return preview.resolveNode?.(key) ?? undefined;
      },
      apply: (label) => {
        // Reconcile can synchronously invalidate the old basis during this
        // accepted write. It must not cancel and restore the previous selection.
        committing = true;
        let result;
        try {
          result = port.command(
            intent.type === "rename"
              ? { ...intent, label, form: existing?.syntax?.labelForm }
              : { ...intent, label, sourceKey: key },
            basis,
          );
        } finally {
          committing = false;
        }
        if (!result.changed && result.diagnostic)
          return { applied: false, diagnostic: result.diagnostic };
        finished = true;
        preview();
        // Removing a selected local model clears the scoped GFX selection.
        // Restore the accepted occurrence only after that preview is gone.
        port.selectAfterPreview(key);
        port.finish();
        return true;
      },
    });
    if (!closeEditor) {
      cancel();
      return null;
    }
    return { cancel, valid };
  } catch (error) {
    cancel();
    throw error;
  }
}
