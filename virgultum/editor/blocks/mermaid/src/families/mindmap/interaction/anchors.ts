// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidVisualModel } from "../../runtime/gfx-model.js";
import { mermaidVisualFamilyPayload } from "../../runtime/gfx-family-data.js";
import {
  isMindmapComment,
  type MermaidMindmapModel,
} from "../../../engine/mindmap/index.js";
import type { MermaidGfxActionContext } from "../../runtime/editor-capabilities.js";

export type MindmapCommentMarker = {
  key: string;
  sourceKeys: string[];
  left: number;
  top: number;
};

/** The preceding Source occurrence owns interstatement comments. Presentation
 * follows its GFX anchor without inferring ownership from canvas geometry. */
export function mindmapCommentMarkers(
  model: MermaidMindmapModel,
  resolve: MermaidGfxActionContext["resolveVisualAnchor"],
): MindmapCommentMarker[] {
  const groups = new Map<string, MindmapCommentMarker>();
  for (const record of model.sourceDocument.records.filter(isMindmapComment)) {
    const key = record.anchorKey ?? "diagram";
    const group = groups.get(key);
    if (group) {
      group.sourceKeys.push(record.sourceKey);
      continue;
    }
    const point = resolve(
      record.anchorKey ? "node" : "diagram",
      record.anchorKey,
    );
    if (point)
      groups.set(key, { key, sourceKeys: [record.sourceKey], ...point });
  }
  return [...groups.values()];
}

/** Keep the popover on the root-facing side so a shape preview can grow away
 * from it. Geometry chooses a floating anchor, never tree membership/order. */
export function mindmapPopoverAnchorSide(
  model: MermaidVisualModel,
  key: string,
) {
  const node = model.nodes.find((node) => node.id === key);
  const root = model.nodes.find(
    (node) =>
      mermaidVisualFamilyPayload(node.familyData, "mindmap")?.parentKey ===
      null,
  );
  return node && root && node.x < root.x ? "end" : "start";
}
