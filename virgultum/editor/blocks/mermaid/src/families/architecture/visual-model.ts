// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidArchitectureModel } from "../../engine/architecture/index.js";
import { mermaidArchitectureDiagramConfig } from "../../engine/architecture/index.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { architectureModelFamilyData } from "./gfx-data.js";
import {
  layoutArchitectureGfxModel,
  projectArchitectureGfxRelations,
} from "./layout/index.js";
import { mermaidSemanticSourceProjection } from "../gfx-visual-model-helpers.js";

export function architectureModelToGfxVisualModel(
  model: MermaidArchitectureModel,
): MermaidVisualModel {
  const layout = layoutArchitectureGfxModel(model);

  return {
    ...mermaidSemanticSourceProjection(model),
    diagramType: "architecture",
    direction: "TD",
    familyData: architectureModelFamilyData(
      model.alignments,
      model.comments ?? [],
      {
        config: mermaidArchitectureDiagramConfig(model),
        directives: model.directives,
      },
    ),
    edges: projectArchitectureGfxRelations(model, layout.nodes),
    nodes: layout.nodes,
    styleStatements: [],
    subgraphs: layout.subgraphs,
    version: 1,
  };
}
