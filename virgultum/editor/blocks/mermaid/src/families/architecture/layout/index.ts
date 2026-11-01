// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidArchitectureModel } from "../../../engine/architecture/index.js";
import { hasFiniteArchitectureGfxGeometry } from "../gfx-data.js";
import { measureArchitectureLayout } from "./measurement.js";
import { placeArchitectureLayout } from "./placement.js";

export { architectureGfxRelationLabelOffset } from "./routing.js";

export function layoutArchitectureGfxModel(model: MermaidArchitectureModel) {
  const layout = {
    diagramType: "architecture" as const,
    ...placeArchitectureLayout(model, measureArchitectureLayout(model)),
  };
  if (!hasFiniteArchitectureGfxGeometry(layout)) {
    throw new Error("Architecture layout produced non-finite geometry.");
  }
  return layout;
}

export { projectArchitectureGfxRelations } from "./routing.js";
