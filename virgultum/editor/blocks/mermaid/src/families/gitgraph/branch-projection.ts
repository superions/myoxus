// SPDX-License-Identifier: AGPL-3.0-or-later
import { gitGraphData } from "./gfx-data.js";
import type { MermaidVisualNode } from "../runtime/gfx-model.js";
export function gitGraphBranchLabel(
  key: string,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  runtimeName = name,
): MermaidVisualNode {
  return {
    id: `${key}:branch`,
    label: name,
    labelEditable: false,
    shape: "rounded",
    x,
    y,
    width,
    height,
    textAlign: "center",
    familyData: gitGraphData({
      role: "branch",
      sourceKey: key,
      branch: runtimeName,
    }),
  };
}
