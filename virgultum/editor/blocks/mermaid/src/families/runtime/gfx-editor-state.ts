// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeShape,
  MermaidVisualSemanticStyle,
  MermaidVisualSubgraph,
} from "./gfx-model.js";
import {
  getMermaidGfxShapePalette,
  type MermaidGfxShapePalette,
} from "./gfx-graph-operations.js";
import {
  readTypeOwnedMermaidEdgeSemanticStyle,
  readTypeOwnedMermaidNodeSemanticStyle,
} from "./gfx-owner-hooks.js";

/**
 * Filter the full shape palette to the
 * visible subset.
 *
 * - `showAll === true` → returns
 *   `MERMAID_FLOWCHART_SHAPES` (the full
 *   set) verbatim.
 * - `showAll === false` → returns
 *   `MERMAID_FLOWCHART_SHAPES` filtered to
 *   shapes that are in `primaryShapes`
 *   (the `MERMAID_FLOWCHART_CORE_SHAPES`
 *   set), or match `selectedShape` (the
 *   currently-selected node's shape, so
 *   the user can change it), or match
 *   `pendingShape` (the in-flight insert
 *   shape, so the just-clicked palette
 *   button stays visible).
 *
 * Matches the inline IIFE at Z. 8372-8382
 * of the pre-I-04e file. The `primaryShapeSet`
 * `Set` allocation is moved to the helper.
 *
 * The `MERMAID_FLOWCHART_CORE_SHAPES` constant
 * reference, which was hard-coded in the inline
 * code, is promoted to a `primaryShapes`
 * parameter (the call site at
 * `mermaid-block.ts:8361` passes the constant
 * explicitly). This keeps the helper testable
 * with arbitrary primary-shape sets.
 */
export function filterVisibleMermaidGfxShapes(
  shapes: ReadonlyArray<MermaidVisualNodeShape>,
  primaryShapes: ReadonlyArray<MermaidVisualNodeShape>,
  showAll: boolean,
  selectedShape: MermaidVisualNodeShape | undefined,
  pendingShape: MermaidVisualNodeShape | null,
): MermaidVisualNodeShape[] {
  if (showAll) return [...shapes];
  const primaryShapeSet = new Set<MermaidVisualNodeShape>(primaryShapes);
  return shapes.filter(
    (shape) =>
      primaryShapeSet.has(shape) ||
      selectedShape === shape ||
      pendingShape === shape,
  );
}

export type MermaidGfxEditorState = {
  selectedEdge: MermaidVisualEdge | undefined;
  selectedEdgeStyleStatement: MermaidVisualSemanticStyle | "";
  selectedNode: MermaidVisualNode | undefined;
  selectedNodeStyleClass: string;
  selectedSubgraph: MermaidVisualSubgraph | undefined;
  shapePalette: MermaidGfxShapePalette;
  visibleShapes: MermaidVisualNodeShape[];
};

export function resolveMermaidGfxEditorState({
  pendingShape,
  selectedEdgeId,
  selectedNodeId,
  selectedSubgraphId,
  allowExpandedShapePalette,
  showAllShapes,
  visualModel,
}: {
  pendingShape: MermaidVisualNodeShape | null;
  selectedEdgeId: string;
  selectedNodeId: string;
  selectedSubgraphId: string;
  allowExpandedShapePalette: boolean;
  showAllShapes: boolean;
  visualModel: MermaidVisualModel;
}): MermaidGfxEditorState {
  const selectedNode = visualModel.nodes.find(
    (node) => node.id === selectedNodeId,
  );
  const selectedEdge = visualModel.edges.find(
    (edge) => edge.id === selectedEdgeId,
  );
  const selectedSubgraph = visualModel.subgraphs?.find(
    (subgraph) => subgraph.id === selectedSubgraphId,
  );
  const shapePalette = getMermaidGfxShapePalette(visualModel.diagramType);
  const showExpandedShapes = showAllShapes && allowExpandedShapePalette;

  return {
    selectedEdge,
    selectedEdgeStyleStatement: selectedEdge
      ? readTypeOwnedMermaidEdgeSemanticStyle(visualModel, selectedEdge)
      : "",
    selectedNode,
    selectedNodeStyleClass: selectedNode
      ? readTypeOwnedMermaidNodeSemanticStyle(visualModel, selectedNode)
      : "",
    selectedSubgraph,
    shapePalette,
    visibleShapes: filterVisibleMermaidGfxShapes(
      shapePalette.all,
      shapePalette.core,
      showExpandedShapes,
      selectedNode?.shape,
      pendingShape,
    ),
  };
}
