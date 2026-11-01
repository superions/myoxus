// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  createMermaidGfxModelHash,
  type MermaidVisualModel,
} from "../runtime/gfx-model.js";
import type { MermaidGfxFamilyHookRegistration } from "../runtime/gfx-family-hooks-contract.js";
import { projectNeutralMermaidGfxDetailElementStyle } from "../runtime/gfx-detail-projection.js";
import {
  projectNeutralMermaidGfxConnectorElement,
  projectNeutralMermaidGfxNodeElement,
  projectNeutralMermaidGfxSubgraphElement,
} from "../runtime/gfx-element-projection-defaults.js";
import { mermaidMessages } from "../../i18n.js";
import { resolveMermaidArchitectureConfig } from "../../engine/architecture/index.js";
import {
  architectureGfxAllowsSelfConnections,
  architectureGfxNodeConnectionPorts,
  canConnectArchitectureGfxNodes,
  createArchitectureGfxVisualEdge,
  projectArchitectureGfxVisualEdge,
  reconnectArchitectureGfxVisualEdge,
} from "./gfx-connections.js";
import {
  applyArchitectureCreatedSubgraphMembership,
  architectureGfxShapePalette,
  createArchitectureGfxVisualNode,
  createArchitectureGfxVisualSubgraph,
  normalizeArchitectureGfxVisualNodeDimensions,
  reparentArchitectureGfxNodes,
  reparentArchitectureGfxSubgraph,
} from "./gfx-creation.js";
import {
  deleteArchitectureGfxVisualSelection,
  deleteArchitectureGfxVisualSubgraph,
} from "./gfx-deletion.js";
import {
  architectureModelGfxData,
  architectureNodeGfxData,
  architectureSubgraphGfxData,
  hasValidArchitectureGfxProjection,
} from "./gfx-data.js";
import {
  architectureGfxNodeInlineValue,
  architectureGfxSubgraphInlineValue,
  renameArchitectureGfxEdgeInline,
  renameArchitectureGfxNodeInline,
  renameArchitectureGfxSubgraphInline,
} from "./inline-mutations.js";
import {
  architectureProjectionOwnerAppearanceMatchesTheme,
  preserveArchitectureManagedNodeDimensions,
  preserveArchitectureManagedSubgraphDimensions,
  reconcileArchitectureVisualProjection,
} from "./visual-reconciliation.js";
import { architectureGfxRelationLabelOffset } from "./layout/index.js";
import { architectureConfiguredTypography } from "./layout/measurement.js";
import { architectureIconIsResolved } from "./icon-display.js";
import {
  finalizeArchitectureProjectionOwnerGeometry,
  fitArchitectureOwnerGroupsToDirectChildren,
} from "./owner-bounds.js";
import {
  architectureLegacyProjectionFingerprint,
  readArchitectureLegacyEdgeFamilyData,
  readArchitectureLegacyNodeFamilyData,
  readArchitectureLegacySubgraphFamilyData,
} from "./legacy-gfx-data.js";
import {
  architectureNodeMutationIsValid,
  architectureProjectionOnlyNodeMutation,
  architectureProjectionOnlySubgraphMutation,
  architectureSubgraphMutationIsValid,
} from "./mutations/index.js";

function architectureDescendantSubgraphIds(
  model: MermaidVisualModel,
  subgraphId: string,
) {
  const descendants = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of model.subgraphs ?? []) {
      if (candidate.id === subgraphId || descendants.has(candidate.id)) {
        continue;
      }
      const parentId = architectureSubgraphGfxData(candidate)?.parentId ?? "";
      if (parentId !== subgraphId && !descendants.has(parentId)) continue;
      descendants.add(candidate.id);
      changed = true;
    }
  }
  return descendants;
}

function architectureProjectedFontSize(model: MermaidVisualModel) {
  return resolveMermaidArchitectureConfig(
    architectureModelGfxData(model)?.config ?? {},
  ).fontSize;
}

function projectArchitectureIconDetail(
  model: MermaidVisualModel,
  node: MermaidVisualModel["nodes"][number],
  detail: NonNullable<MermaidVisualModel["nodes"][number]["details"]>[number],
) {
  const architecture = architectureNodeGfxData(node);
  const config = resolveMermaidArchitectureConfig(
    architectureModelGfxData(model)?.config ?? {},
  );
  const typography = architectureConfiguredTypography(config);
  const isTextIcon = architecture?.iconKind === "text";
  const isUnresolvedIcon = !architectureIconIsResolved(
    architecture?.icon ?? "",
    architecture?.iconKind ?? "none",
  );
  return {
    ...projectNeutralMermaidGfxDetailElementStyle(),
    filled: false,
    fontSize:
      isTextIcon || isUnresolvedIcon
        ? config.fontSize
        : Math.max(config.fontSize, config.iconSize - typography.lineHeight),
    offsetY: 0,
    padding: [0, 0] as const,
    relativeBound: {
      height: config.iconSize,
      width: config.iconSize,
      x: (node.width - config.iconSize) / 2,
      y: 0,
    },
    strokeWidth: 0,
    text: detail.label,
    textAlign: "center" as const,
    textVerticalAlign: "center" as const,
  };
}

function syncArchitectureSubgraphMembership(model: MermaidVisualModel) {
  let changed = false;
  const subgraphs = (model.subgraphs ?? []).map((subgraph) => {
    const directMemberIds = new Set(
      model.nodes
        .filter(
          (node) =>
            (architectureNodeGfxData(node)?.groupId ?? "") === subgraph.id,
        )
        .map((node) => node.id),
    );
    const retainedMemberIds = subgraph.nodeIds.filter((nodeId) =>
      directMemberIds.delete(nodeId),
    );
    const nodeIds = [
      ...retainedMemberIds,
      ...model.nodes.flatMap((node) =>
        directMemberIds.has(node.id) ? [node.id] : [],
      ),
    ];
    if (
      nodeIds.length === subgraph.nodeIds.length &&
      nodeIds.every((nodeId, index) => nodeId === subgraph.nodeIds[index])
    ) {
      return subgraph;
    }
    changed = true;
    return { ...subgraph, nodeIds };
  });
  return changed ? { ...model, subgraphs } : model;
}

function architectureReconciledProjection(
  parsed: MermaidVisualModel,
  stored: MermaidVisualModel,
  canReuseStored: boolean,
) {
  const reconciled = canReuseStored
    ? (reconcileArchitectureVisualProjection(parsed, stored) ?? parsed)
    : parsed;
  const fitted = fitArchitectureOwnerGroupsToDirectChildren(reconciled);
  return createMermaidGfxModelHash(fitted) === createMermaidGfxModelHash(stored)
    ? stored
    : fitted;
}

export const mermaidArchitectureGfxHookRegistration: MermaidGfxFamilyHookRegistration =
  {
    hooks: {
      alignmentGuides: (model) =>
        architectureModelGfxData(model)?.alignments ?? [],
      legacyProjectionFingerprint: architectureLegacyProjectionFingerprint,
      readLegacyEdgeFamilyData: readArchitectureLegacyEdgeFamilyData,
      readLegacyNodeFamilyData: readArchitectureLegacyNodeFamilyData,
      readLegacySubgraphFamilyData: readArchitectureLegacySubgraphFamilyData,
      allowsSelfConnections: architectureGfxAllowsSelfConnections,
      applyCreatedSubgraphMembership:
        applyArchitectureCreatedSubgraphMembership,
      canConnectNodes: canConnectArchitectureGfxNodes,
      canonicalizeAfterSourceWrite: (reparsed, requested) =>
        architectureReconciledProjection(reparsed, requested, true),
      descendantSubgraphIds: architectureDescendantSubgraphIds,
      createEdge: createArchitectureGfxVisualEdge,
      createNode: createArchitectureGfxVisualNode,
      createSubgraph: createArchitectureGfxVisualSubgraph,
      deleteSelection: deleteArchitectureGfxVisualSelection,
      deleteSubgraph: deleteArchitectureGfxVisualSubgraph,
      edgeElementProjection: (model, edge) => ({
        ...projectNeutralMermaidGfxConnectorElement(edge),
        fontSize: architectureProjectedFontSize(model),
      }),
      edgeLabelOffset: architectureGfxRelationLabelOffset,
      edgeInlineRename: renameArchitectureGfxEdgeInline,
      edgeReconnectable: () => true,
      finalizeProjectionOwnerGeometry:
        finalizeArchitectureProjectionOwnerGeometry,
      hasValidGeometry: hasValidArchitectureGfxProjection,
      graphEditor: true,
      keepsFamilyDisplaySurface: true,
      projectionOwnerAppearanceMatchesTheme:
        architectureProjectionOwnerAppearanceMatchesTheme,
      nodeInlineRename: renameArchitectureGfxNodeInline,
      nodeConnectionPorts: architectureGfxNodeConnectionPorts,
      nodeDetailElementProjection: projectArchitectureIconDetail,
      nodeElementProjection: (model, node) => ({
        ...projectNeutralMermaidGfxNodeElement(node),
        fontSize: architectureProjectedFontSize(model),
      }),
      nodeInlineValue: (model, nodeId) =>
        architectureGfxNodeInlineValue(model, nodeId) ?? "",
      normalizeNodeDimensions: normalizeArchitectureGfxVisualNodeDimensions,
      preserveManagedNodeDimensions: preserveArchitectureManagedNodeDimensions,
      preserveManagedSubgraphDimensions:
        preserveArchitectureManagedSubgraphDimensions,
      preserveProjectionOwnerForInvalidSource: () => true,
      projectionOnlyNodeMutation: architectureProjectionOnlyNodeMutation,
      projectionOnlySubgraphMutation:
        architectureProjectionOnlySubgraphMutation,
      nodeMutationIsValid: architectureNodeMutationIsValid,
      patchEdge: projectArchitectureGfxVisualEdge,
      subgraphMutationIsValid: architectureSubgraphMutationIsValid,
      reconcileNodeDragEnd: () => false,
      reconnectEdge: reconnectArchitectureGfxVisualEdge,
      reparentNodes: reparentArchitectureGfxNodes,
      reparentSubgraph: reparentArchitectureGfxSubgraph,
      reconcileVisualProjection: architectureReconciledProjection,
      subgraphDimension: (_model, value) => value,
      subgraphHeaderBehindContent: true,
      subgraphDimensionsAreValid: (height, width) =>
        (height === undefined || height > 0) &&
        (width === undefined || width > 0),
      subgraphInlineRename: renameArchitectureGfxSubgraphInline,
      subgraphElementProjection: (model) => ({
        ...projectNeutralMermaidGfxSubgraphElement(),
        fontSize: architectureProjectedFontSize(model),
      }),
      subgraphInlineValue: (model, subgraphId) =>
        architectureGfxSubgraphInlineValue(model, subgraphId) ?? "",
      syncSubgraphMembership: syncArchitectureSubgraphMembership,
      shapePalette: architectureGfxShapePalette,
      usesGenericNodeShapeMinimums: () => false,
      visualMutationRejectedMessage: () =>
        mermaidMessages.visualMutationSourceRejected("Architecture"),
      nodeDimensionsAreValid: (height, width) =>
        (height === undefined || height > 0) &&
        (width === undefined || width > 0),
    },
    owns: (model) => model.diagramType === "architecture",
    ownsDiagramType: (diagramType) => diagramType === "architecture",
  };
