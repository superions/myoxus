// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidGfxFamilyHookRegistration } from "../runtime/gfx-family-hooks-contract.js";
import type { MermaidVisualNode } from "../runtime/gfx-model.js";
import { isC4DiagramType } from "./family.js";
import {
  canonicalizeC4VisualIdentities,
  readC4ProjectionModel,
} from "./gfx-data.js";
import { c4BoundaryGfxData, c4EdgeGfxData } from "./object-data.js";
import { layoutC4Diagram } from "./layout.js";
import { c4ModelToGfxVisualModel } from "./visual-model.js";
import { reconcileC4VisualProjection } from "./reconcile.js";
import {
  projectC4NodeElement,
  projectC4ContentElement,
  projectC4MaterializedNode,
  sizeC4ContentNode,
} from "./content-projection.js";
import { projectC4BoundaryElement } from "./boundary-projection.js";
import {
  c4RelationshipDisplayLabel,
  projectC4RelationshipElement,
} from "./relationship-projection.js";

/** Preserve the shared gesture floor before measuring the C4 body content. */
function normalizeC4GestureNode(node: MermaidVisualNode) {
  return sizeC4ContentNode({
    ...node,
    width: Math.max(96, node.width),
    height: Math.max(56, node.height),
  });
}

/** Source owns membership and identities; dragging/resizing only changes geometry. */
export const c4GfxHooks: MermaidGfxFamilyHookRegistration = {
  owns: (model) => isC4DiagramType(model.diagramType),
  ownsDiagramType: isC4DiagramType,
  hooks: {
    minimumReadableZoom: (_model, minimum) => Math.max(1, minimum),
    graphEditor: true,
    usesDocumentHistory: true,
    objectEditsViaFamilyControls: true,
    detailSelectionViaFamilyControls: true,
    nodeDetailGeometryFollowsBody: true,
    includeRenderedConnectorBounds: true,
    projectionOwnerReadbackPolicy: () => ({
      preserveSourceMembership: true,
      preservePreviousSubgraphMembership: true,
      preserveMultilineNodeLabels: true,
      strictSemanticIdentities: true,
    }),
    descendantSubgraphIds: (model, parent) => {
      const ids = new Set<string>(),
        pending = [parent];
      while (pending.length) {
        const current = pending.pop()!;
        for (const group of model.subgraphs ?? [])
          if (
            group.id !== parent &&
            !ids.has(group.id) &&
            c4BoundaryGfxData(group)?.sourceParentId === current
          ) {
            ids.add(group.id);
            pending.push(group.id);
          }
      }
      return ids;
    },
    projectionOnlyNodeMutation: (patch) =>
      Object.keys(patch).every((key) =>
        [
          "model",
          "std",
          "nodeId",
          "translate",
          "height",
          "width",
          "projectionOnly",
        ].includes(key),
      ),
    projectionOnlySubgraphMutation: (patch) =>
      Object.keys(patch).every((key) =>
        [
          "model",
          "std",
          "subgraphId",
          "moveMembers",
          "x",
          "y",
          "height",
          "width",
          "projectionOnly",
        ].includes(key),
      ),
    reconcileNodeDragEnd: () => false,
    normalizeNodeDimensions: normalizeC4GestureNode,
    reconcileGeometryGesture: (_before, after) => ({
      ...after,
      // Native moves keep fractional geometry; only actual content overflow grows.
      nodes: after.nodes.map((node) => sizeC4ContentNode(node)),
    }),
    readSourceProjection: (source, stored) => {
      const model = readC4ProjectionModel(source, stored);
      if (!model) return null;
      return reconcileC4VisualProjection(
        c4ModelToGfxVisualModel({ ...model, ...layoutC4Diagram(model) }),
        stored,
        true,
      );
    },
    canonicalizeAfterSourceWrite: (reparsed, requested) =>
      reconcileC4VisualProjection(
        canonicalizeC4VisualIdentities(reparsed, requested),
        requested,
        true,
      ),
    reconcileVisualProjection: reconcileC4VisualProjection,
    // Owner readback must retain the measured minimum rather than restore an
    // undersized persisted body after family reconciliation.
    preserveManagedNodeDimensions: (_model, source, existing) => ({
      width: Math.max(source.width, existing.width),
      height: Math.max(source.height, existing.height),
    }),
    nodeElementProjection: projectC4NodeElement,
    nodeDetailElementProjection: projectC4ContentElement,
    subgraphElementProjection: projectC4BoundaryElement,
    edgeElementProjection: projectC4RelationshipElement,
    edgeLabelOffset: (_model, edge) => {
      const data = c4EdgeGfxData(edge);
      return data ? { x: data.labelOffsetX, y: data.labelOffsetY } : null;
    },
    patchEdge: (_model, edge) => {
      const data = c4EdgeGfxData(edge);
      return {
        ...edge,
        displayLabel: c4RelationshipDisplayLabel({
          label: edge.label,
          technology: data?.technology ?? "",
          description: data?.description ?? "",
          dynamicStep: data?.dynamicStep,
        }),
      };
    },
    projectMaterializedNode: (node) => projectC4MaterializedNode(node),
    readProjectionOwnerModel: (model) => model,
    syncSubgraphMembership: (model) => model,
    allowsSelfConnections: true,
    edgeReconnectable: () => false,
    createEdge: () => null,
    createSubgraph: () => null,
    deleteSelection: () => null,
  },
};
