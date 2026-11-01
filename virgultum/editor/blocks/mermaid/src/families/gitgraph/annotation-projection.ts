// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GitGraphRecord } from "../../engine/gitgraph/index.js";
import type { MermaidVisualNode } from "../runtime/gfx-model.js";
import { gitGraphData } from "./gfx-data.js";
export function gitGraphCommentMarker(
  r: GitGraphRecord,
  x: number,
  y: number,
  size: number,
): MermaidVisualNode {
  return {
    id: r.sourceKey,
    label: r.value ?? "",
    displayLabel: "…",
    labelEditable: false,
    shape: "rounded",
    x,
    y,
    width: size,
    height: size,
    familyData: gitGraphData({
      role: "comment",
      sourceKey: r.sourceKey,
      anchorKey: r.anchor?.sourceKey ?? null,
    }),
  };
}
