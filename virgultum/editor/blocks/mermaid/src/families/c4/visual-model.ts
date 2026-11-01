// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  c4RelationshipLabelOffset,
  type MermaidC4Model,
} from "../../engine/c4/index.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  mermaidSemanticSourceProjection,
  mermaidVisualNodeIndex,
  semanticMermaidEdge,
} from "../gfx-visual-model-helpers.js";
import { c4BoundaryFamilyData, c4EdgeFamilyData } from "./object-data.js";

import {
  c4RelationshipDisplayLabel,
  c4RelationshipLinkType,
} from "./relationship-projection.js";
import { c4BoundaryDisplayLabel } from "./boundary-projection.js";
import { readC4Config } from "../../engine/c4/config.js";
import { projectC4ElementNode } from "./node-projection.js";
import {
  c4NativeSourceStyles,
  c4SourceFontStyles,
} from "./style-projection.js";
import { c4IdentityFamilyData } from "./gfx-data.js";

type C4EffectiveElementUpdate = {
  backgroundColor?: string;
  borderColor?: string;
  fontColor?: string;
  legendSprite?: string;
  legendText?: string;
  shadowing?: string;
  shape?: string;
  sprite?: string;
  technology?: string;
};

function c4EffectiveElementUpdate(model: MermaidC4Model, elementId: string) {
  const effective: C4EffectiveElementUpdate = {};
  const resolution = [...model.elements, ...model.boundaries].find(
    (e) => e.id === elementId,
  )?.resolution;
  const fields = [
    ["backgroundColor", 1, ["bgColor"]],
    ["fontColor", 2, ["fontColor"]],
    ["borderColor", 3, ["borderColor"]],
    ["shadowing", 4, ["shadowing"]],
    ["shape", 5, ["shape"]],
    ["sprite", 6, ["sprite"]],
    ["technology", 7, ["techn", "technology"]],
    ["legendText", 8, ["legendText"]],
    ["legendSprite", 9, ["legendSprite"]],
  ] as const;
  if (resolution) {
    for (const [field, , names] of fields) {
      const value = resolution.fields[names[0]];
      if (typeof value === "string") effective[field] = value;
    }
    return effective;
  }
  return effective;
}

function c4EffectiveRelationshipUpdate(
  model: MermaidC4Model,
  from: string,
  to: string,
) {
  const effective: {
    lineColor?: string;
    offsetX?: string;
    offsetY?: string;
    textColor?: string;
  } = {};
  const fields = [
    ["textColor", 2, ["textColor"]],
    ["lineColor", 3, ["lineColor"]],
    ["offsetX", 4, ["offsetX"]],
    ["offsetY", 5, ["offsetY"]],
  ] as const;
  const resolution = model.relationships.find(
    (r) => r.from === from && r.to === to,
  )?.resolution;
  if (resolution) {
    for (const [field, , names] of fields) {
      const value = resolution.fields[names[0]];
      if (typeof value === "string" || typeof value === "number")
        effective[field] = String(value);
    }
    return effective;
  }
  return effective;
}

function c4StyleStatements(model: MermaidC4Model) {
  const statements: string[] = [];
  const appendElementStyle = (id: string, baseDeclarations: string[] = []) => {
    const style = c4EffectiveElementUpdate(model, id);
    const declarations = [
      ...baseDeclarations,
      style.backgroundColor && `fill:${style.backgroundColor}`,
      style.fontColor && `color:${style.fontColor}`,
      style.borderColor && `stroke:${style.borderColor}`,
    ].filter((value): value is string => Boolean(value));
    if (declarations.length) {
      const selectionId =
        [...model.elements, ...model.boundaries].find((e) => e.id === id)
          ?.resolution?.selectionId ?? id;
      statements.push(`style ${selectionId} ${declarations.join(",")}`);
    }
  };
  for (const element of model.elements) appendElementStyle(element.id);
  for (const boundary of model.boundaries) {
    appendElementStyle(
      boundary.id,
      boundary.nodeType ? [] : ["stroke-dasharray:7 7"],
    );
  }
  for (const [index, relationship] of model.relationships.entries()) {
    const style = c4EffectiveRelationshipUpdate(
      model,
      relationship.from,
      relationship.to,
    );
    const declarations = [
      style.textColor && `color:${style.textColor}`,
      style.lineColor && `stroke:${style.lineColor}`,
    ].filter((value): value is string => Boolean(value));
    if (declarations.length) {
      statements.push(`linkStyle ${index} ${declarations.join(",")}`);
    }
  }
  return statements;
}

export function c4ModelToGfxVisualModel(
  model: MermaidC4Model,
): MermaidVisualModel {
  const config = readC4Config(model.sourceDocument).config;
  const nodesByBoundary = new Map<string, string[]>();
  const nodes = model.elements.map((element) => {
    if (element.boundaryId) {
      const nodeIds = nodesByBoundary.get(element.boundaryId) ?? [];
      nodeIds.push(element.id);
      nodesByBoundary.set(element.boundaryId, nodeIds);
    }
    return projectC4ElementNode(element, config, model.sourceDocument);
  });
  const nodesById = mermaidVisualNodeIndex(nodes);
  return {
    ...mermaidSemanticSourceProjection(
      { ...model, sourceAnnotations: [] },
      model.title,
    ),
    familyData: c4IdentityFamilyData(model),
    diagramType: "c4",
    direction: model.direction === "TB" ? "TB" : model.direction,
    edges: model.relationships.map((relationship) => {
      return semanticMermaidEdge(
        {
          familyData: c4EdgeFamilyData({
            styles: {
              ...c4SourceFontStyles(config, "message"),
              ...(typeof relationship.resolution?.fields.textColor ===
                "string" && relationship.resolution.fields.textColor
                ? { color: relationship.resolution.fields.textColor }
                : {}),
              ...(typeof relationship.resolution?.fields.lineColor ===
                "string" && relationship.resolution.fields.lineColor
                ? { stroke: relationship.resolution.fields.lineColor }
                : {}),
            },
            description: relationship.description,
            dynamicStep: relationship.dynamicStep,
            index: relationship.index,
            labelOffsetX: c4RelationshipLabelOffset(
              relationship.resolution?.fields.offsetX,
            ),
            labelOffsetY: c4RelationshipLabelOffset(
              relationship.resolution?.fields.offsetY,
            ),
            link: relationship.link,
            relationshipKind: relationship.kind,
            sprite: relationship.sprite,
            tags: relationship.tags,
            technology: relationship.technology,
          }),
          displayLabel: c4RelationshipDisplayLabel(relationship),
          id: relationship.resolution?.selectionId ?? relationship.id,
          label: relationship.label,
          linkType: c4RelationshipLinkType(relationship),
          source:
            model.elements.find((e) => e.alias === relationship.from)
              ?.resolution?.selectionId ?? relationship.from,
          target:
            model.elements.find((e) => e.alias === relationship.to)?.resolution
              ?.selectionId ?? relationship.to,
        },
        nodesById,
      );
    }),
    nodes,
    styleStatements: c4StyleStatements(model),
    subgraphs: model.boundaries.map((boundary) => {
      const updateStyle = c4EffectiveElementUpdate(model, boundary.id);
      const effectiveSprite = updateStyle.sprite ?? boundary.sprite;
      return {
        familyData: c4BoundaryFamilyData({
          styles: c4NativeSourceStyles(boundary, config),
          nativeNode: !!boundary.nodeType,
          sourceParentId:
            model.boundaries.find((b) => b.id === boundary.parentId)?.resolution
              ?.selectionId ?? "",
          boundaryKind: boundary.kind,
          boundaryType: boundary.boundaryType,
          description: boundary.description,
          effectiveSprite,
          label: boundary.label,
          link: boundary.link,
          sprite: boundary.sprite,
          spriteOverridden: model.occurrences.some(
            (r) =>
              r.kind === "UpdateElementStyle" &&
              r.sourceKey === boundary.resolution?.providers.sprite?.sourceKey,
          ),
          tags: boundary.tags,
        }),
        height: boundary.height,
        id: boundary.resolution?.selectionId ?? boundary.id,
        nodeIds: (nodesByBoundary.get(boundary.id) ?? []).map(
          (id) =>
            model.elements.find((e) => e.id === id)?.resolution?.selectionId ??
            id,
        ),
        displayLabel: c4BoundaryDisplayLabel(boundary),
        title: boundary.label,
        width: boundary.width,
        x: boundary.x,
        y: boundary.y,
      };
    }),
    version: 1,
  };
}
