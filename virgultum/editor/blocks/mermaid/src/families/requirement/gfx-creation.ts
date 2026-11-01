// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeShape,
} from "../runtime/gfx-model.js";
import {
  requirementEdgeFamilyData,
  requirementNodeFamilyData,
} from "./gfx-data.js";

function nextId(model: MermaidVisualModel, prefix: string) {
  const ids = new Set(model.nodes.map((node) => node.id));
  let index = model.nodes.length + 1;
  while (ids.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

function placement(
  model: MermaidVisualModel,
  width: number,
  height: number,
  requested?: { readonly centerX: number; readonly centerY: number },
) {
  if (requested) {
    return {
      x: requested.centerX - width / 2,
      y: requested.centerY - height / 2,
    };
  }
  const last = model.nodes.at(-1);
  return model.direction === "LR"
    ? { x: (last?.x ?? 0) + 190, y: last?.y ?? 0 }
    : { x: last?.x ?? 0, y: (last?.y ?? 0) + 190 };
}

export function createRequirementNode(
  model: MermaidVisualModel,
  requestedShape?: MermaidVisualNodeShape,
  requestedPlacement?: { readonly centerX: number; readonly centerY: number },
): MermaidVisualNode {
  const index = model.nodes.length + 1;

  const id = nextId(model, "req");
  return {
    ...placement(model, 170, 96, requestedPlacement),
    familyData: requirementNodeFamilyData({
      kind: "requirement",
      requirementId: "",
      requirementType: "requirement",
      risk: "",
      text: "",
      verifyMethod: "",
    }),
    height: 96,
    id,
    label: `Requirement ${index}`,
    shape: requestedShape ?? "doc",
    width: 170,
  };
}

export function createRequirementEdge(
  model: MermaidVisualModel,
  source: string,
  target: string,
): MermaidVisualEdge | null {
  if (
    !model.nodes.some((node) => node.id === source) ||
    !model.nodes.some((node) => node.id === target)
  )
    return null;
  const index = model.edges.length + 1;
  return {
    familyData: requirementEdgeFamilyData({ relationKind: "satisfies" }),
    id: `relation-${source}-${target}-${index}`,
    label: "",
    connectorMode: "straight",
    labelPlacement: "top",
    linkType: "arrow",
    source,
    style: "solid",
    target,
  };
}

export function requirementShapePalette() {
  const all = ["doc", "rect"] as const;
  return { all, core: all };
}
