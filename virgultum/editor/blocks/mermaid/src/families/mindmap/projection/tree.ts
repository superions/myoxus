// SPDX-License-Identifier: AGPL-3.0-or-later
import { MindmapDesign as MindmapStyle } from "./types.js";
import { mindmapStyleGetters } from "./style-getters.js";
import { mindmapConnectorMode } from "./designs.js";

import { layoutMindmapTree, type MindmapProjectionOptions } from "./layout.js";
import type {
  MermaidMindmapModel,
  MermaidMindmapNode,
  MermaidMindmapShape,
} from "../../../engine/mindmap/index.js";
import type {
  MermaidVisualModel,
  MermaidVisualNodeShape,
} from "../../runtime/gfx-model.js";
import {
  visualNode,
  edgeToVisual,
  mermaidSemanticSourceProjection,
  semanticMermaidEndpointPositionsBetween,
} from "../../gfx-visual-model-helpers.js";
import { createMermaidVisualFamilyData } from "../../runtime/gfx-family-data.js";
import { hashMermaidSource } from "../../../utils.js";
import { mindmapModelFamilyData, mindmapNodeFamilyData } from "../gfx-data.js";

export type MindmapSourceTreeNode = {
  readonly source: MermaidMindmapNode;
  readonly children: MindmapSourceTreeNode[];
};
export function mindmapSourceTree(
  model: MermaidMindmapModel,
): MindmapSourceTreeNode | null {
  const nodes = new Map<string, MindmapSourceTreeNode>();
  let root: MindmapSourceTreeNode | null = null;
  for (const source of model.nodes) {
    const node: MindmapSourceTreeNode = { source, children: [] };
    nodes.set(source.id, node);
    if (source.parentId) nodes.get(source.parentId)!.children.push(node);
    else root = node;
  }
  return root;
}

function visualShape(shape: MermaidMindmapShape): MermaidVisualNodeShape {
  if (shape === "square") return "rect";
  if (shape === "default") return "rounded";
  return shape;
}

/** Direct child shapes/derived branches use Source keys. There is no inner
 * Mindmap model, group or second tree; the shared owner reconciles these arrays. */
export function projectMindmapTree(
  model: MermaidMindmapModel,
  options: MindmapProjectionOptions = {},
): MermaidVisualModel {
  const layout = layoutMindmapTree(model, options),
    geometry = layout.nodes;
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  // Collapse removes only the derived visible projection. Every Source record
  // remains bound in familyData, so expanding recovers the same occurrences.
  const visible = new Set<string>();
  for (const node of model.nodes)
    if (
      !node.parentId ||
      (visible.has(node.parentId) &&
        !options.collapsed?.has(byId.get(node.parentId)!.sourceKey))
    )
      visible.add(node.id);
  const visibleNodes = model.nodes.filter((node) => visible.has(node.id));
  const nodes = visibleNodes.map((node) =>
    visualNode({
      id: node.sourceKey,
      label: node.label,
      displayLabel: geometry.get(node.sourceKey)!.displayLabel,
      shape: visualShape(node.shape),
      familyData: mindmapNodeFamilyData(
        node,
        node.parentId ? byId.get(node.parentId)!.sourceKey : null,
        geometry.get(node.sourceKey)!,
      ),
      x: geometry.get(node.sourceKey)?.x ?? node.x,
      y: geometry.get(node.sourceKey)?.y ?? node.y,
      width: geometry.get(node.sourceKey)?.width ?? node.width,
      height: geometry.get(node.sourceKey)?.height ?? 64,
    }),
  );
  const visuals = new Map(nodes.map((node) => [node.id, node]));
  // A geometry fingerprint invalidates display-geometry reuse on real metric or
  // layout changes; it stores no coordinates, fonts or viewer colors in Source.
  const geometryKey = hashMermaidSource(
    JSON.stringify(
      nodes.map((node) => [node.x, node.y, node.width, node.height]),
    ),
  );
  return {
    ...mermaidSemanticSourceProjection(model),
    diagramType: "mindmap",
    direction: "LR",
    version: 1,
    familyData: mindmapModelFamilyData(model, geometryKey, layout),
    nodes,
    subgraphs: [],
    styleStatements: [],
    edges: visibleNodes.flatMap((node) => {
      if (!node.parentId) return [];
      const parent = byId.get(node.parentId)!;
      return [
        edgeToVisual({
          id: `branch:${parent.sourceKey}:${node.sourceKey}`,
          familyData: createMermaidVisualFamilyData("mindmap", {
            sourceKey: node.sourceKey,
            path: geometry.get(node.sourceKey)!.path,
          }),
          source: parent.sourceKey,
          target: node.sourceKey,
          label: "",
          labelEditable: false,
          connectorMode: mindmapConnectorMode(
            mindmapStyleGetters[
              options.design ?? MindmapStyle.ONE
            ].getNodeStyle(geometry.get(node.sourceKey)!.path).connector.mode,
          ),
          linkType: "open",
          style: "solid",
          ...semanticMermaidEndpointPositionsBetween(
            visuals.get(parent.sourceKey),
            visuals.get(node.sourceKey),
          ),
        }),
      ];
    }),
  };
}
