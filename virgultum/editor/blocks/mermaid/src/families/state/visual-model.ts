// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import type { MermaidStateModel } from "../../engine/state/index.js";
import { stateModelFamilyData } from "./gfx-data.js";
import { readStateConfig } from "../../engine/state/config.js";
import { projectStateNode } from "./state-projection.js";
import {
  projectStateTransition,
  stateNoteSafePorts,
} from "./transition-projection.js";
import {
  projectStateComposites,
  projectStateRegions,
} from "./composite-projection.js";
import { projectStateNotes } from "./annotation-projection.js";
import { layoutStateHierarchy } from "./layout.js";
import { distributeMermaidPorts } from "../runtime/graph-ports.js";

export function stateStyles(model: MermaidStateModel, id: string) {
  const node = [...model.states, ...model.composites].find((n) => n.id === id),
    classes = new Set(["default", ...(node?.cssClasses ?? [])]),
    result: Record<string, string> = {};
  for (const s of model.styles)
    if (
      (s.kind === "definition" && s.owners.some((name) => classes.has(name))) ||
      (s.kind === "inline" && s.owners.includes(id))
    )
      for (const p of s.properties) result[p.name] = p.value;
  return result;
}
/** Source notation and measured cold geometry share the native GFX consumer. */
export function stateModelToVisual(
  model: MermaidStateModel,
): MermaidVisualModel {
  const { config } = readStateConfig(model.sourceDocument),
    ids = new Map(
      [...model.states, ...model.composites].map((n) => [n.id, n.sourceKey!]),
    );
  const stateNodes = model.states.map((n) => {
      const direction = n.parentId
        ? (model.composites.find((c) => c.id === n.parentId)?.direction ?? "TB")
        : model.direction;
      // V1 rotates bars in nested documents; V2 follows the local layout axis.
      const verticalFork =
        model.diagramType === "stateDiagram"
          ? Boolean(n.parentId)
          : direction === "LR" || direction === "RL";
      return projectStateNode(
        n,
        config,
        stateStyles(model, n.id),
        verticalFork,
      );
    }),
    notes = projectStateNotes(model, config),
    edges = model.transitions.map((t) =>
      projectStateTransition(t, ids, model.transitions),
    );
  const layout = layoutStateHierarchy(
    model,
    [...stateNodes, ...notes],
    edges,
    config,
    (id) => stateStyles(model, id),
  );
  const nodes = layout.nodes;
  const regions = projectStateRegions(model, layout.regionFrames, config);
  const groups = projectStateComposites(
    model,
    [...nodes, ...regions],
    layout.frames,
    config,
    (id) => stateStyles(model, id),
  );
  return {
    diagramType: model.diagramType,
    version: 1,
    direction: model.direction,
    diagramTitle: model.diagramTitle,
    accessibilityTitle: model.accessibilityTitle,
    accessibilityDescription: model.accessibilityDescription,
    nodes: [...nodes, ...regions],
    edges: stateNoteSafePorts(
      distributeMermaidPorts(edges, nodes, groups),
      nodes,
      groups,
    ),
    subgraphs: groups,
    familyData: stateModelFamilyData(model),
    sourcePreamble: model.directives,
    styleStatements: model.styleStatements,
    sourceAnnotations: [],
  };
}
