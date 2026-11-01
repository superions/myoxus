// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidGfxFamilyHookRegistration } from "../runtime/gfx-family-hooks-contract.js";
import {
  projectNeutralMermaidGfxNodeElement,
  projectNeutralMermaidGfxSubgraphElement,
} from "../runtime/gfx-element-projection-defaults.js";
import {
  applyFlowchartCreatedSubgraphMembership,
  canConnectFlowchartGfxNodes,
  createFlowchartGfxEdge,
  createFlowchartGfxNode,
  createFlowchartGfxSubgraph,
  deleteFlowchartGfxSelection,
  duplicateFlowchartGfxSelection,
  flowchartGfxShapePalette,
  flowchartSubgraphDescendantIds,
  reconnectFlowchartGfxEdge,
  reparentFlowchartGfxNodes,
  reparentFlowchartGfxSubgraph,
  renameFlowchartGfxEdge,
  renameFlowchartGfxNode,
  renameFlowchartGfxSubgraph,
  syncFlowchartGfxSubgraphMembership,
} from "./gfx-operations.js";
import { finalizeFlowchartProjectionOwnerReadback } from "./owner-readback.js";
import { reconcileFlowchartProjectionOwnerGeometry } from "./owner-geometry.js";
import { finalizeFlowchartAdoptedNodeElementProps } from "./gfx-adoption.js";
import {
  canonicalizeFlowchartProjectionAfterSourceWrite,
  reconcileFlowchartVisualProjection,
  readFlowchartSourceProjection,
} from "./projection-reconciliation.js";
import {
  flowchartEdgeElementStyle,
  flowchartEdgeSemanticStyleProps,
  flowchartMinimumReadableZoom,
  flowchartProjectionOwnerAppearanceMatchesTheme,
  flowchartNodeElementStyle,
  flowchartNodeSemanticStyleProps,
  flowchartSubgraphElementStyle,
  readFlowchartEdgeSemanticStyle,
  readFlowchartNodeSemanticStyle,
} from "./gfx-style-projection.js";
import { flowchartNodeConnectionPorts } from "./connection-ports.js";
import { layoutMeasuredFlowchart } from "./layout.js";
import { flowchartConnectorRoutingProjection } from "./connection-projection.js";

export const mermaidFlowchartGfxHookRegistration: MermaidGfxFamilyHookRegistration =
  {
    hooks: {
      prepareInsertProjection: (_source, model) =>
        layoutMeasuredFlowchart(model, { fromSource: true }),
      allowsSelfConnections: false,
      applyCreatedSubgraphMembership: applyFlowchartCreatedSubgraphMembership,
      canConnectNodes: canConnectFlowchartGfxNodes,
      canonicalizeAfterSourceWrite:
        canonicalizeFlowchartProjectionAfterSourceWrite,
      createEdge: createFlowchartGfxEdge,
      createNode: createFlowchartGfxNode,
      createSubgraph: createFlowchartGfxSubgraph,
      deleteSelection: deleteFlowchartGfxSelection,
      descendantSubgraphIds: flowchartSubgraphDescendantIds,
      duplicateSelection: duplicateFlowchartGfxSelection,
      edgeHitTestIncludesSubgraphs: true,
      edgeElementProjection: (model, edge, edgeIndex) => ({
        ...flowchartConnectorRoutingProjection(model, edge),
        ...flowchartEdgeElementStyle(model, edge, edgeIndex),
      }),
      edgeSemanticStyleProps: flowchartEdgeSemanticStyleProps,
      edgeInlineRename: renameFlowchartGfxEdge,
      readEdgeSemanticStyle: readFlowchartEdgeSemanticStyle,
      finalizeAdoptedNodeElementProps: finalizeFlowchartAdoptedNodeElementProps,
      finalizeProjectionOwnerReadback: finalizeFlowchartProjectionOwnerReadback,
      graphEditor: true,
      keepsFamilyDisplaySurface: true,
      projectionOwnerAppearanceMatchesTheme:
        flowchartProjectionOwnerAppearanceMatchesTheme,
      projectionOwnerReadbackPolicy: {
        preserveMultilineNodeLabels: true,
        preservePreviousSubgraphMembership: true,
        strictSemanticIdentities: true,
      },
      minimumReadableZoom: flowchartMinimumReadableZoom,
      nodeInlineRename: renameFlowchartGfxNode,
      nodeConnectionPorts: flowchartNodeConnectionPorts,
      readNodeSemanticStyle: readFlowchartNodeSemanticStyle,
      nodeElementProjection: (model, node) => ({
        ...projectNeutralMermaidGfxNodeElement(node),
        ...flowchartNodeElementStyle(model, node),
      }),
      nodeSemanticStyleProps: flowchartNodeSemanticStyleProps,
      reconcileVisualProjection: reconcileFlowchartVisualProjection,
      readSourceProjection: readFlowchartSourceProjection,
      reconcileProjectionOwnerGeometry:
        reconcileFlowchartProjectionOwnerGeometry,
      normalizeNodeDimensions: (node) => ({
        ...node,
        height: Math.max(56, Math.round(node.height)),
        width: Math.max(96, Math.round(node.width)),
      }),
      reconnectEdge: reconnectFlowchartGfxEdge,
      reparentNodes: reparentFlowchartGfxNodes,
      reparentSubgraph: reparentFlowchartGfxSubgraph,
      shapePalette: flowchartGfxShapePalette,
      subgraphInlineRename: renameFlowchartGfxSubgraph,
      subgraphElementProjection: (model, subgraph) => ({
        ...projectNeutralMermaidGfxSubgraphElement(),
        ...flowchartSubgraphElementStyle(model, subgraph),
      }),
      syncSubgraphMembership: syncFlowchartGfxSubgraphMembership,
      usesGenericNodeShapeMinimums: () => true,
    },
    owns: (model) =>
      model.diagramType === "flowchart" ||
      model.diagramType === "flowchart-elk",
    ownsDiagramType: (diagramType) =>
      diagramType === "flowchart" || diagramType === "flowchart-elk",
  };
