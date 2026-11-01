// SPDX-License-Identifier: AGPL-3.0-or-later
import { planMindmapIndicator } from "./indicator-plan.js";
import { type MindmapInsertPosition } from "./drop-plan.js";
import { StrokeStyle } from "@virgultum/model";
import { resolveMermaidGfxProjectionTheme } from "../../../mermaid-gfx-theme.js";
import type { MermaidGfxPreview } from "../../runtime/gfx-preview.js";
import { Bound } from "@virgultum/global/gfx";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../../runtime/gfx-model.js";

export function mindmapDropIndicator(
  visual: MermaidVisualModel,
  parent: MermaidVisualNode,
  target: MermaidVisualNode,
  lastChild: MermaidVisualNode | undefined,
  insert: MindmapInsertPosition,
  balanced: boolean,
  firstLevel: boolean,
  reorder: boolean,
): MermaidVisualModel {
  const bound = (node: MermaidVisualNode) =>
    new Bound(node.x, node.y, node.width, node.height);
  const marker = planMindmapIndicator({
    parent: bound(parent),
    target: bound(target),
    lastChild: lastChild ? bound(lastChild) : null,
    insert,
    balanced,
    firstLevel,
    direction: insert.layoutDir,
  });
  const id = "mindmap-local-drop-indicator";
  return {
    ...visual,
    nodes: [
      ...visual.nodes,
      {
        id,
        label: "",
        shape: "rounded",
        x: marker.x,
        y: reorder ? marker.y + marker.h / 2 : marker.y,
        width: marker.w,
        height: reorder ? 3 : marker.h,
      },
    ],
    edges: [
      ...visual.edges,
      ...(reorder
        ? []
        : [
            {
              id: `${id}-branch`,
              source: parent.id,
              target: id,
              label: "",
              connectorMode: "curve" as const,
              style: "dotted" as const,
              linkType: "open" as const,
            },
          ]),
    ],
  };
}

/** Only the transient marker uses selection feedback; authored appearance stays intact. */
export function styleMindmapDropIndicator(
  preview: MermaidGfxPreview,
  reorder: boolean,
) {
  const marker = preview.resolveNode?.("mindmap-local-drop-indicator");
  if (!marker) return;
  marker.filled = reorder;
  marker.fillColor = resolveMermaidGfxProjectionTheme().processingColor;
  marker.strokeStyle = reorder ? StrokeStyle.Solid : StrokeStyle.Dash;
  marker.strokeColor = resolveMermaidGfxProjectionTheme().processingColor;
}
