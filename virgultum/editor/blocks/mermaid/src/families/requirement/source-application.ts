// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import {
  writeRequirementModel,
  type MermaidRequirementElement,
  type MermaidRequirementNode,
  type MermaidRequirementRelation,
  parseMermaidRequirementSource,
} from "../../engine/requirement/index.js";
import { requirementModelToGfxVisualModel } from "./visual-model.js";
import {
  readRequirementProjectionModel,
  reconcileRequirementProjection,
} from "./readback.js";
import { requirementEdgeGfxData, requirementNodeGfxData } from "./gfx-data.js";

function upsertRequirementNodes(
  items: MermaidRequirementNode[],
  nodes: MermaidVisualNode[],
): MermaidRequirementNode[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return nodes.map((node, order) => {
    const existing = byId.get(node.id);
    const data = requirementNodeGfxData(node);
    const requirement = data?.kind === "requirement" ? data : undefined;
    return {
      ...existing,
      id: node.id,
      name: existing ? node.label || existing.name : node.id,
      order,
      requirementId:
        requirement?.requirementId ?? existing?.requirementId ?? "",
      requirementType:
        requirement?.requirementType ??
        existing?.requirementType ??
        "requirement",
      risk: requirement?.risk ?? existing?.risk ?? "",
      text: requirement?.text ?? existing?.text ?? "",
      verifyMethod: requirement?.verifyMethod ?? existing?.verifyMethod ?? "",
      width: node.width,
      x: node.x,
      y: node.y,
    };
  });
}

function upsertRequirementElements(
  items: MermaidRequirementElement[],
  nodes: MermaidVisualNode[],
): MermaidRequirementElement[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return nodes.map((node, order) => {
    const existing = byId.get(node.id);
    const data = requirementNodeGfxData(node);
    const element = data?.kind === "element" ? data : undefined;
    return {
      ...existing,
      docRef: element?.docRef ?? existing?.docRef ?? "",
      elementType: element?.elementType ?? existing?.elementType ?? "",
      id: node.id,
      name: existing ? node.label || existing.name : node.id,
      order,
      width: node.width,
      x: node.x,
      y: node.y,
    };
  });
}

function upsertRequirementRelations(
  items: MermaidRequirementRelation[],
  visualModel: MermaidVisualModel,
  aliases: ReadonlyMap<string, string>,
): MermaidRequirementRelation[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return visualModel.edges.map((edge, order) => ({
    ...byId.get(edge.id),
    from: aliases.get(edge.source) ?? edge.source,
    id: edge.id,
    kind:
      requirementEdgeGfxData(edge)?.relationKind ??
      byId.get(edge.id)?.kind ??
      "satisfies",
    order,
    to: aliases.get(edge.target) ?? edge.target,
  }));
}

export function applyRequirementGfxVisualToSource(
  source: string,
  visualModel: MermaidVisualModel,
) {
  const base =
    readRequirementProjectionModel(source, visualModel) ??
    (!source.trim()
      ? parseMermaidRequirementSource("requirementDiagram\n")
      : null);
  if (!base) throw new Error("Invalid Requirement Source");
  const requirementIds = new Set(base.requirements.map(({ id }) => id));
  const elementIds = new Set(base.elements.map(({ id }) => id));
  const requirementNodes = visualModel.nodes.filter(
    (node) =>
      requirementIds.has(node.id) ||
      (!elementIds.has(node.id) && node.shape === "doc"),
  );
  const requirementNodeIds = new Set(requirementNodes.map(({ id }) => id));
  const elementNodes = visualModel.nodes.filter(
    (node) => !requirementNodeIds.has(node.id),
  );
  const requirements = upsertRequirementNodes(
    base.requirements,
    requirementNodes,
  );
  const elements = upsertRequirementElements(base.elements, elementNodes);
  const aliases = new Map(
    [...requirements, ...elements].map((item) => [item.id, item.name]),
  );
  const desired = {
    ...base,
    directives: base.directives.length
      ? base.directives
      : (visualModel.sourcePreamble ?? []),
    elements,
    sourceAnnotations: visualModel.sourceAnnotations ?? base.sourceAnnotations,
    relations: [
      ...base.relations.filter((r) => !r.fromId || !r.toId),
      ...upsertRequirementRelations(base.relations, visualModel, aliases),
    ],
    requirements,
  };
  const result = writeRequirementModel(base, desired);
  if (result.status === "rejected")
    throw new Error(`Rejected Requirement mutation: ${result.reason}`);
  return {
    source: result.source,
    visualModel: reconcileRequirementProjection(
      requirementModelToGfxVisualModel(result.model),
      visualModel,
    ),
  };
}
