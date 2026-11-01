// SPDX-License-Identifier: AGPL-3.0-or-later
import { getMermaidFrontmatterTitle } from "../../engine/diagram-types.js";
import { readErConfig, type MermaidErModel } from "../../engine/er/index.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import { erModelFamilyData, erNodeFamilyData } from "./gfx-data.js";
import { erAttributeDetails } from "./entity-projection.js";
import { erEntityMetrics, layoutErHierarchy } from "./layout.js";
import {
  distributeErPorts,
  erRelationshipProjection,
} from "./edge-projection.js";
import { erSubgraphProjection } from "./subgraph-projection.js";
export function erStyles(model: MermaidErModel, id: string) {
  const config = readErConfig(model.sourceDocument).config,
    values: Record<string, string> = {},
    node = [...model.entities, ...model.subgraphs].find((n) => n.id === id),
    classes = new Set(node?.cssClasses ?? []);
  if (config.fill) values.fill = config.fill;
  if (config.stroke) values.stroke = config.stroke;
  for (const style of model.styles)
    if (
      (style.kind === "definition" &&
        style.owners.some((o) => classes.has(o))) ||
      (style.kind === "inline" && style.owners.includes(id))
    )
      for (const property of style.properties)
        values[property.name] = property.value;
  return values;
}
export function erModelToVisual(model: MermaidErModel): MermaidVisualModel {
  const { config } = readErConfig(model.sourceDocument),
    ids = new Map(
      [...model.entities, ...model.subgraphs].map((n) => [n.id, n.sourceKey]),
    );
  let nodes: MermaidVisualNode[] = model.entities.map((entity) => {
    const styles = erStyles(model, entity.id),
      metrics = erEntityMetrics(entity, config, styles);
    return {
      id: entity.sourceKey,
      label: entity.label,
      displayLabel: entity.label,
      labelEditable: false,
      shape: "rect",
      textAlign: "left",
      textVerticalAlign: "top",
      x: 0,
      y: 0,
      width: metrics.width,
      height: metrics.height,
      details: erAttributeDetails(entity),
      familyData: erNodeFamilyData(
        entity,
        {
          sourceKey: entity.sourceKey,
          sourceId: entity.id,
          subgraphId: entity.subgraphId,
          headerHeight: metrics.headerHeight,
          rowHeight: metrics.rowHeight,
          padding: metrics.padding,
          columns: metrics.columns,
          fontSize: metrics.fontSize,
        },
        styles,
      ),
    };
  });
  const edges = model.relationships.map((r) =>
    erRelationshipProjection(r, ids, model.relationships),
  );
  const hierarchy = layoutErHierarchy(model, nodes, edges, config, (id) =>
    erStyles(model, id),
  );
  nodes = hierarchy.nodes;
  const subgraphs = erSubgraphProjection(
    model,
    nodes,
    (id) => erStyles(model, id),
    hierarchy.frames,
  );
  return {
    diagramType: "erDiagram",
    version: 1,
    direction: model.direction,
    diagramTitle: getMermaidFrontmatterTitle(model.directives),
    accessibilityTitle: model.accessibilityTitle,
    accessibilityDescription: model.accessibilityDescription,
    nodes,
    edges: distributeErPorts(edges, nodes, subgraphs),
    subgraphs,
    familyData: erModelFamilyData(model),
    sourcePreamble: model.directives,
    styleStatements: model.styleStatements,
    sourceAnnotations: [],
  };
}
