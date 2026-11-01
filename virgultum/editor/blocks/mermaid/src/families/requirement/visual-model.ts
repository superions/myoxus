// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import {
  mermaidSemanticSourceProjection,
  semanticMermaidEdge,
  visualNode,
} from "../gfx-visual-model-helpers.js";
import type { MermaidRequirementModel } from "../../engine/requirement/index.js";
import { createRequirementDetails } from "./object-projection.js";
import {
  requirementEdgeFamilyData,
  requirementNodeFamilyData,
} from "./gfx-data.js";
import { createMermaidVisualFamilyData } from "../runtime/gfx-family-data.js";
import { hashMermaidSource } from "../../engine/source-hash.js";
import {
  projectRequirementRelation,
  routeRequirementRelations,
} from "./relation-projection.js";
import { requirementCardMetrics, layoutRequirementGraph } from "./layout.js";
import { requirementSourceStyles } from "./style-projection.js";

function measuredRequirementNode(node: MermaidVisualNode) {
  const measured = requirementCardMetrics(node);
  return {
    ...node,
    width: Math.max(node.width, measured.width),
    height: measured.height,
  };
}

export function requirementModelToGfxVisualModel(
  model: Extract<
    MermaidRequirementModel,
    { diagramType: "requirementDiagram" }
  >,
): MermaidVisualModel {
  const nodes = [
    ...model.requirements.map((requirement) => {
      const details = createRequirementDetails({
        ownerId: requirement.id,
        sourceKey: requirement.sourceKey,
        propertyKeys: requirement.propertyKeys,
        requirementId: requirement.requirementId,
        requirementRisk: requirement.risk,
        requirementText: requirement.text,
        requirementType: requirement.requirementType,
        requirementVerifyMethod: requirement.verifyMethod,
      });
      return measuredRequirementNode(
        visualNode({
          details,
          displayLabel: requirement.name,
          height: 0,
          id: requirement.id,
          label: requirement.name,
          familyData: requirementNodeFamilyData({
            sourceKey: requirement.sourceKey,
            propertyKeys: requirement.propertyKeys,
            styles: requirementSourceStyles(requirement.cssStyles),
            kind: "requirement",
            requirementId: requirement.requirementId,
            requirementType: requirement.requirementType,
            risk: requirement.risk,
            text: requirement.text,
            verifyMethod: requirement.verifyMethod,
          }),
          shape: "doc",
          textAlign: "left",
          textVerticalAlign: "top",
          width: requirement.width,
          x: requirement.x,
          y: requirement.y,
        }),
      );
    }),
    ...model.elements.map((element) => {
      const details = createRequirementDetails({
        ownerId: element.id,
        sourceKey: element.sourceKey,
        propertyKeys: element.propertyKeys,
        requirementDocRef: element.docRef,
        requirementElementType: element.elementType,
      });
      return measuredRequirementNode(
        visualNode({
          details,
          displayLabel: element.name,
          height: 0,
          id: element.id,
          label: element.name,
          familyData: requirementNodeFamilyData({
            sourceKey: element.sourceKey,
            propertyKeys: element.propertyKeys,
            styles: requirementSourceStyles(element.cssStyles),
            docRef: element.docRef,
            elementType: element.elementType,
            kind: "element",
          }),
          shape: "rect",
          textAlign: "left",
          textVerticalAlign: "top",
          width: element.width,
          x: element.x,
          y: element.y,
        }),
      );
    }),
  ];
  return routeRequirementRelations(
    layoutRequirementGraph({
      ...mermaidSemanticSourceProjection(model),
      accessibilityTitle: model.accTitle,
      accessibilityDescription: model.accDescr,
      familyData: createMermaidVisualFamilyData("requirement", {
        records:
          model.sourceDocument?.records.map((r) => ({
            key: r.sourceKey,
            kind: r.kind,
            start: r.range.start,
            end: r.range.end,
            hash: hashMermaidSource(r.raw),
          })) ?? [],
      }),
      diagramType: "requirementDiagram",
      direction: model.direction ?? "TB",
      edges: model.relations
        .filter((relation) => relation.fromId && relation.toId)
        .map((relation) =>
          projectRequirementRelation(
            semanticMermaidEdge({
              connectorMode: "straight",
              id: relation.id,
              label: "",
              labelEditable: false,
              labelPlacement: "top",
              familyData: requirementEdgeFamilyData({
                sourceKey: relation.sourceKey,
                relationKind: relation.kind,
              }),
              source: relation.fromId!,
              target: relation.toId!,
            }),
          ),
        ),
      nodes,
      styleStatements: [],
      subgraphs: [],
      version: 1,
    }),
  );
}
