// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ShapeTextEditDraft } from "@virgultum/gfx-shape";
import {
  addRequirementObject,
  nextRequirementAlias,
  type RequirementObjectKind,
} from "../../engine/requirement/index.js";
import { mermaidMessages as m } from "../../i18n.js";
import type { MermaidGfxActionContext } from "../runtime/editor-capabilities.js";
import {
  readRequirementProjectionModel,
  reconcileRequirementProjection,
} from "./readback.js";
import type { RequirementReactHostProps } from "./react-host-contract.js";
import { requirementModelToGfxVisualModel } from "./visual-model.js";

export type RequirementCreationDraft = {
  cancel: () => void;
  valid: () => boolean;
};
type Port = Pick<
  MermaidGfxActionContext,
  "previewVisualModel" | "mountShapeDraft"
> & {
  getSource: () => string;
  getReadonly: () => boolean;
  getVisualModel: () => MermaidGfxActionContext["visualModel"];
  command: RequirementReactHostProps["onCreate"];
  clearSelection: () => void;
  selectAfterPreview: (id: string) => void;
  restoreSelection: () => void;
  subscribeInvalidation?: (invalidate: () => void) => () => void;
  renderActions?: ShapeTextEditDraft["renderActions"];
  finish: () => void;
};

/** Creation previews only local GFX shapes on the active viewport. The reserved
 * preview identity never enters the document; one confirmed command creates the
 * actual Source record and its checked binding. */
export function beginRequirementCreationDraft(
  port: Port,
  kind: RequirementObjectKind,
  placement: { centerX: number; centerY: number },
): RequirementCreationDraft | null {
  if (port.getReadonly() || !port.previewVisualModel || !port.mountShapeDraft)
    return null;
  const basis = port.getSource(),
    stored = port.getVisualModel();
  const model = readRequirementProjectionModel(basis, stored);
  if (!model) return null;
  const initial = nextRequirementAlias(model, kind),
    prepared = addRequirementObject(model, kind, initial);
  if (!prepared.changed || !prepared.selection) return null;
  const candidate = reconcileRequirementProjection(
      requirementModelToGfxVisualModel(prepared.model),
      stored,
    ),
    key = prepared.selection;
  const node = candidate.nodes.find((node) => node.id === key);
  if (!node) return null;
  node.x = placement.centerX - node.width / 2;
  node.y = placement.centerY - node.height / 2;
  let preview = port.previewVisualModel(candidate, {
    scopeToViewport: true,
    includeInNavigation: true,
  });
  const shape = preview.resolveNode?.(key);
  if (!shape) {
    preview();
    return null;
  }
  let finished = false,
    committing = false,
    closeEditor: (() => void) | null = null;
  const valid = () =>
    committing ||
    (!finished && !port.getReadonly() && port.getSource() === basis);
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
      applyOnBlur: false,
      cancel,
      renderActions: port.renderActions,
      subscribeInvalidation: (invalidate) =>
        port.subscribeInvalidation?.(() => {
          if (!valid()) invalidate();
        }) ?? (() => {}),
      preview: (label) => {
        preview();
        preview = port.previewVisualModel!(
          {
            ...candidate,
            nodes: candidate.nodes.map((node) =>
              node.id === key ? { ...node, label, displayLabel: label } : node,
            ),
          },
          { scopeToViewport: true, includeInNavigation: true },
        );
        return preview.resolveNode?.(key) ?? undefined;
      },
      apply: (name) => {
        committing = true;
        let result;
        try {
          result = port.command(kind, name, basis, placement);
        } finally {
          committing = false;
        }
        if (result.diagnostic)
          return { applied: false, diagnostic: result.diagnostic };
        if (!result.changed) return false;
        finished = true;
        preview();
        if (result.selection) port.selectAfterPreview(result.selection);
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
