// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GitGraphRecord } from "../../engine/gitgraph/index.js";
import type { MermaidVisualNode } from "../runtime/gfx-model.js";
import { gitGraphData } from "./gfx-data.js";
export function gitGraphStatementMarker(
  r: GitGraphRecord,
  x: number,
  y: number,
  size: number,
): MermaidVisualNode {
  return {
    id: r.sourceKey,
    label: r.reference?.value ?? r.kind,
    displayLabel: r.kind === "checkout" ? "↪" : "◌",
    labelEditable: false,
    shape: "text",
    x,
    y,
    width: size,
    height: size,
    familyData: gitGraphData({ role: "statement", sourceKey: r.sourceKey }),
  };
}
