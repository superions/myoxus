// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidVisualNode } from "../runtime/gfx-model.js";
import { mermaidVisualFamilyPayload } from "../runtime/gfx-family-data.js";
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";
export function projectedClassStyle(node: MermaidVisualNode) {
  return projectMermaidSourceStyle(
    mermaidVisualFamilyPayload(node.familyData, "class")?.styles,
  );
}
