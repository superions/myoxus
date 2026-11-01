// SPDX-License-Identifier: AGPL-3.0-or-later
import { changeMindmapProjection } from "../projection/options.js";
import type { MermaidGfxActionContext } from "../../runtime/editor-capabilities.js";
import { mindmapMoveProjectionOptions } from "./move.js";
import { readMindmapProjectionModel } from "../source-application.js";
import { readMindmapProjectionOptions } from "../gfx-data.js";
import { projectMindmapTree } from "../projection/tree.js";
import { runMindmapAction, type MindmapAction } from "../actions.js";

type Port = Pick<MermaidGfxActionContext, "previewVisualModel"> & {
  getSource: () => string;
  getReadonly: () => boolean;
  getVisualModel: () => MermaidGfxActionContext["visualModel"];
};

/** Checked candidates use the existing local GFX preview, never the Source writer. */
export function createMindmapPreviewConsumer(port: Port) {
  return (action: MindmapAction, basis: string): (() => void) | null => {
    if (
      port.getReadonly() ||
      port.getSource() !== basis ||
      !port.previewVisualModel
    )
      return null;
    const visual = port.getVisualModel(),
      model = readMindmapProjectionModel(basis, visual);
    if (!model) return null;
    const result = runMindmapAction(model, action);
    if (result.status === "rejected") return null;
    return port.previewVisualModel(
      projectMindmapTree(
        result.model,
        action.type === "settings"
          ? (changeMindmapProjection(visual, model, action)?.options ??
              readMindmapProjectionOptions(visual))
          : action.type === "move"
            ? mindmapMoveProjectionOptions(
                visual,
                model,
                action,
                result.changed,
              ).options
            : readMindmapProjectionOptions(visual),
      ),
      action.type === "move" || action.type === "settings"
        ? { scopeToViewport: true }
        : undefined,
    );
  };
}
