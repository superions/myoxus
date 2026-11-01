// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualNodeShape } from "../runtime/gfx-model.js";
import { mermaidShapeSyntaxLabel } from "../../mermaid-block-shape-helpers.js";

export function resolveFlowchartGfxShapeLabel(shape: MermaidVisualNodeShape) {
  return mermaidShapeSyntaxLabel(shape);
}
