// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeDetail,
} from "../runtime/gfx-model.js";
import type { MermaidGfxFamilyHookRegistration } from "../runtime/gfx-family-hooks-contract.js";
import {
  readRequirementLegacyEdgeFamilyData,
  readRequirementLegacyModelFamilyData,
  readRequirementLegacyNodeFamilyData,
  requirementLegacyProjectionFingerprint,
} from "./legacy-gfx-data.js";
import {
  projectNeutralMermaidGfxNodeElement,
  projectNeutralMermaidGfxSubgraphElement,
} from "../runtime/gfx-element-projection-defaults.js";
import { StrokeStyle } from "@virgultum/model";
import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";
import { isRequirementDiagramType } from "./family.js";
import {
  readRequirementProjectionModel,
  reconcileRequirementProjection,
} from "./readback.js";
import { requirementModelToGfxVisualModel } from "./visual-model.js";
import { projectRequirementMaterializedNode } from "./object-projection.js";
import {
  projectRequirementConnectorElement,
  projectRequirementRelation,
  routeRequirementRelations,
} from "./relation-projection.js";
import {
  createRequirementEdge,
  createRequirementNode,
  requirementShapePalette,
} from "./gfx-creation.js";
import {
  requirementCardMetrics,
  requirementDetailText,
  separateRequirementCards,
} from "./layout.js";
import { projectedRequirementStyle } from "./style-projection.js";
import { requirementNodeGfxData } from "./gfx-data.js";
import { remapCopiedRequirementIdentities } from "./copy-identities.js";
import {
  createNeutralGfxSubgraph,
  deleteNeutralGfxSelection,
  reconnectNeutralGfxEdge,
  syncSpatialGfxSubgraphMembership,
} from "../runtime/gfx-neutral-model-operations.js";

function projectRequirementDetailElement(
  _model: MermaidVisualModel,
  node: MermaidVisualNode,
  detail: MermaidVisualNodeDetail,
) {
  const metrics = requirementCardMetrics(node),
    theme = resolveMermaidGfxProjectionTheme();
  const sourceStyle = projectedRequirementStyle(node);
  const separator = detail.kind === "separator",
    bound = metrics.details.find((row) => row.id === detail.id);
  const stereotype = node.details?.[0]?.id === detail.id;
  return {
    offsetY: 0,
    relativeBound: {
      x: metrics.padding,
      y: separator ? metrics.headerHeight : (bound?.y ?? metrics.headerHeight),
      width: Math.max(1, node.width - metrics.padding * 2),
      height: separator ? 1 : (bound?.height ?? metrics.typography.lineHeight),
    },
    text: bound?.text ?? requirementDetailText(detail),
    textVerticalAlign: "top" as const,
    color:
      sourceStyle.color ??
      (stereotype ? theme.secondaryTextColor : theme.textColor),
    filled: separator,
    fillColor: sourceStyle.strokeColor ?? theme.borderColor,
    strokeWidth: 0,
    strokeStyle: StrokeStyle.None,
    padding: [0, 0] as const,
    selectable: !separator && Boolean(detail.sourceKey),
    textDisplay: !separator,
    fontSize: metrics.typography.fontSize,
    fontFamily: metrics.typography.fontFamily,
    fontWeight: metrics.typography.fontWeight,
    fontStyle: metrics.typography.fontStyle,
  };
}

function canConnectRequirementNodes(
  model: MermaidVisualModel,
  source: string,
  target: string,
) {
  return createRequirementEdge(model, source, target) !== null;
}

function reconcileRequirementVisualProjection(
  parsed: MermaidVisualModel,
  stored: MermaidVisualModel,
  canReuseStored: boolean,
) {
  return reconcileRequirementProjection(parsed, stored, canReuseStored);
}

export const requirementGfxHooks: MermaidGfxFamilyHookRegistration = {
  hooks: {
    sessionSelectionKinds: ["edge"],
    usesDocumentHistory: true,
    semanticClipboard: true,
    remapCopiedIdentities: remapCopiedRequirementIdentities,
    objectEditsViaFamilyControls: true,
    connectionsViaFamilyControls: true,
    nodeKeyboardIntent: (_model, id, key) =>
      key === "Duplicate" && id
        ? { kind: "node", id, action: "duplicate" }
        : null,
    allowsSelfConnections: true,
    detailSelectionViaFamilyControls: true,
    nodeDetailGeometryFollowsBody: true,
    // Managed geometry restoration runs after Source reconciliation. Repair
    // only newly invalid overlaps at its existing final family boundary too.
    finalizeProjectionOwnerGeometry: (model) =>
      routeRequirementRelations({
        ...model,
        nodes: separateRequirementCards(model.nodes),
      }),
    preserveManagedNodeDimensions: (_model, source, existing) => ({
      width: Math.max(source.width, existing.width),
      height: Math.max(source.height, existing.height),
    }),
    readSourceProjection: (source, stored) => {
      const model = readRequirementProjectionModel(source, stored);
      return model
        ? reconcileRequirementProjection(
            requirementModelToGfxVisualModel(model),
            stored,
          )
        : null;
    },
    projectionOwnerReadbackPolicy: {
      preserveSourceMembership: true,
      preserveMultilineNodeLabels: true,
      strictSemanticIdentities: true,
    },
    descendantSubgraphIds: () => null,
    projectionOnlyNodeMutation: (patch) =>
      patch.projectionOnly === true ||
      Object.keys(patch).every((key) =>
        ["x", "y", "width", "height"].includes(key),
      ),
    projectionOnlySubgraphMutation: (patch) => patch.projectionOnly === true,
    reconcileNodeDragEnd: () => false,
    legacyProjectionFingerprint: requirementLegacyProjectionFingerprint,
    canConnectNodes: canConnectRequirementNodes,
    canonicalizeAfterSourceWrite: (reparsed, requested) =>
      reconcileRequirementVisualProjection(reparsed, requested, true),
    createEdge: createRequirementEdge,
    createNode: createRequirementNode,
    createSubgraph: (model, ids) =>
      createNeutralGfxSubgraph(model, ids, "Group"),
    deleteSelection: deleteNeutralGfxSelection,
    edgeElementProjection: projectRequirementConnectorElement,
    edgeLabelOffset: () => null,
    edgeReconnectable: () => true,
    patchEdge: (_model, edge) => projectRequirementRelation(edge),
    projectMaterializedNode: projectRequirementMaterializedNode,
    // The renderer carrier is rectangular/rounded, but Requirement's Source
    // notation owns the semantic shape. A native move is not a shape edit.
    readProjectionOwnerModel: (model) => ({
      ...model,
      nodes: model.nodes.map((node) => ({
        ...node,
        shape:
          requirementNodeGfxData(node)?.kind === "element" ? "rect" : "doc",
      })),
    }),
    graphEditor: true,
    readLegacyEdgeFamilyData: readRequirementLegacyEdgeFamilyData,
    readLegacyModelFamilyData: readRequirementLegacyModelFamilyData,
    readLegacyNodeFamilyData: readRequirementLegacyNodeFamilyData,
    nodeElementProjection: (_model, node) => {
      const theme = resolveMermaidGfxProjectionTheme();
      const metrics = requirementCardMetrics(node);
      const sourceStyle = projectedRequirementStyle(node);
      return {
        ...projectNeutralMermaidGfxNodeElement({ ...node, shape: "rect" }),
        color: theme.textColor,
        fillColor: theme.surfaceColor,
        strokeColor: theme.borderColor,
        ...sourceStyle,
        padding: [metrics.nameY, metrics.padding] as const,
        fontSize: metrics.typography.fontSize,
        fontFamily: metrics.typography.fontFamily,
        fontWeight: sourceStyle.fontWeight ?? "bold",
        fontStyle: metrics.typography.fontStyle,
      };
    },
    nodeDetailElementProjection: projectRequirementDetailElement,
    reconnectEdge: (model, edge, endpoint, nodeId) =>
      reconnectNeutralGfxEdge(
        model,
        edge,
        endpoint,
        nodeId,
        canConnectRequirementNodes,
      ),
    reconcileVisualProjection: reconcileRequirementVisualProjection,
    shapePalette: requirementShapePalette,
    minimumReadableZoom: (_model, minimum) => minimum,
    subgraphElementProjection: () => projectNeutralMermaidGfxSubgraphElement(),
    syncSubgraphMembership: syncSpatialGfxSubgraphMembership,
  },
  owns: (model) => isRequirementDiagramType(model.diagramType),
  ownsDiagramType: isRequirementDiagramType,
};
