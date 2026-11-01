// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualNodeDetail,
  MermaidVisualSemanticStyle,
  MermaidVisualSubgraph,
} from "./gfx-model.js";
import {
  getMermaidGfxFamilyHooks,
  getMermaidGfxFamilyHooksForDiagramType,
} from "./gfx-family-hooks-registry.js";

export function hasValidTypeOwnedMermaidGfxGeometry(model: MermaidVisualModel) {
  return getMermaidGfxFamilyHooks(model)?.hasValidGeometry?.(model) ?? true;
}

export function typeOwnedMermaidObjectEditAnchorSide(
  model: MermaidVisualModel,
  kind: "node" | "subgraph",
  id: string,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.objectEditAnchorSide?.(model, kind, id) ??
    "end"
  );
}

export function typeOwnedMermaidSubgraphDimension(
  model: MermaidVisualModel,
  value: number,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.subgraphDimension?.(model, value) ?? null
  );
}

export function typeOwnedMermaidDescendantSubgraphIds(
  model: MermaidVisualModel,
  subgraphId: string,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.descendantSubgraphIds?.(
      model,
      subgraphId,
    ) ?? null
  );
}

export function usesGenericMermaidNodeShapeMinimums(model: MermaidVisualModel) {
  return (
    getMermaidGfxFamilyHooks(model)?.usesGenericNodeShapeMinimums?.(model) ??
    true
  );
}

export function typeOwnedMermaidMinimumReadableZoom(
  model: MermaidVisualModel,
  sharedMinimum: number,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.minimumReadableZoom?.(
      model,
      sharedMinimum,
    ) ?? sharedMinimum
  );
}

export function keepsTypeOwnedMermaidDisplaySurface(model: MermaidVisualModel) {
  return getMermaidGfxFamilyHooks(model)?.keepsFamilyDisplaySurface ?? false;
}

export function typeOwnedMermaidEdgeHitTestIncludesSubgraphs(
  model: MermaidVisualModel,
) {
  return getMermaidGfxFamilyHooks(model)?.edgeHitTestIncludesSubgraphs ?? false;
}

export function typeOwnedMermaidConnectionTargetsIncludeSubgraphs(
  model: MermaidVisualModel,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.connectionTargetsIncludeSubgraphs ?? false
  );
}

export function typeOwnedMermaidSubgraphHeaderBehindContent(
  model: MermaidVisualModel,
) {
  return getMermaidGfxFamilyHooks(model)?.subgraphHeaderBehindContent ?? false;
}

export function typeOwnedMermaidAlignmentGuides(model: MermaidVisualModel) {
  return getMermaidGfxFamilyHooks(model)?.alignmentGuides?.(model) ?? [];
}

export function shouldReconcileTypeOwnedMermaidNodeDragEnd(
  model: MermaidVisualModel,
) {
  return getMermaidGfxFamilyHooks(model)?.reconcileNodeDragEnd?.(model) ?? null;
}

export function typeOwnedMermaidProjectionOwnerAppearanceMatchesTheme(
  model: MermaidVisualModel,
  elements: readonly unknown[],
  connectors: readonly unknown[],
) {
  return (
    getMermaidGfxFamilyHooks(model)?.projectionOwnerAppearanceMatchesTheme?.(
      model,
      elements,
      connectors,
    ) ?? true
  );
}

export function preserveTypeOwnedMermaidManagedNodeDimensions(
  model: MermaidVisualModel,
  source: MermaidVisualNode,
  existing: MermaidVisualNode,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.preserveManagedNodeDimensions?.(
      model,
      source,
      existing,
    ) ?? null
  );
}

export function usesTypeOwnedMermaidSourceGeometry(model: MermaidVisualModel) {
  return getMermaidGfxFamilyHooks(model)?.sourceDerivedGeometry === true;
}

export function preserveTypeOwnedMermaidManagedSubgraphDimensions(
  model: MermaidVisualModel,
  source: MermaidVisualSubgraph,
  existing: MermaidVisualSubgraph,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.preserveManagedSubgraphDimensions?.(
      model,
      source,
      existing,
    ) ?? null
  );
}

export function typeOwnedMermaidSubgraphUsesTemporalRangeGeometry(
  model: MermaidVisualModel,
  subgraph: MermaidVisualSubgraph,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.subgraphUsesTemporalRangeGeometry?.(
      subgraph,
    ) ?? false
  );
}

export function typeOwnedMermaidNodeElementProjection(
  model: MermaidVisualModel,
  node: MermaidVisualNode,
) {
  const hooks = getMermaidGfxFamilyHooks(model);
  if (!hooks) {
    throw new Error(
      `Mermaid ${model.diagramType} does not own node element projection`,
    );
  }
  return hooks.nodeElementProjection(model, node);
}

export function typeOwnedMermaidNodeConnectionPorts(
  model: MermaidVisualModel,
  node: MermaidVisualNode,
) {
  return getMermaidGfxFamilyHooks(model)?.nodeConnectionPorts?.(model, node);
}

export function typeOwnedMermaidEdgeElementProjection(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
  edgeIndex: number,
) {
  const hooks = getMermaidGfxFamilyHooks(model);
  if (!hooks) {
    throw new Error(
      `Mermaid ${model.diagramType} does not own connector element projection`,
    );
  }
  return hooks.edgeElementProjection(model, edge, edgeIndex);
}

export function typeOwnedMermaidNodeDetailElementProjection(
  model: MermaidVisualModel,
  node: MermaidVisualNode,
  detail: MermaidVisualNodeDetail,
) {
  return getMermaidGfxFamilyHooks(model)?.nodeDetailElementProjection?.(
    model,
    node,
    detail,
  );
}

export function typeOwnedMermaidNodeSemanticStyleProps(
  model: MermaidVisualModel,
  styleName: MermaidVisualSemanticStyle | "",
) {
  return (
    getMermaidGfxFamilyHooks(model)?.nodeSemanticStyleProps?.(styleName) ?? {}
  );
}

export function typeOwnedMermaidEdgeSemanticStyleProps(
  model: MermaidVisualModel,
  styleName: MermaidVisualSemanticStyle | "",
) {
  return (
    getMermaidGfxFamilyHooks(model)?.edgeSemanticStyleProps?.(styleName) ?? {}
  );
}

export function readTypeOwnedMermaidNodeSemanticStyle(
  model: MermaidVisualModel,
  node: MermaidVisualNode,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.readNodeSemanticStyle?.(model, node) ?? ""
  );
}

export function readTypeOwnedMermaidEdgeSemanticStyle(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.readEdgeSemanticStyle?.(model, edge) ?? ""
  );
}

export function typeOwnedMermaidSubgraphElementProjection(
  model: MermaidVisualModel,
  subgraph: MermaidVisualSubgraph,
) {
  const hooks = getMermaidGfxFamilyHooks(model);
  if (!hooks) {
    throw new Error(
      `Mermaid ${model.diagramType} does not own subgraph element projection`,
    );
  }
  return hooks.subgraphElementProjection(model, subgraph);
}

export function projectTypeOwnedMermaidMaterializedNode(
  node: MermaidVisualNode,
  diagramType: MermaidVisualModel["diagramType"],
) {
  return (
    getMermaidGfxFamilyHooksForDiagramType(
      diagramType,
    )?.projectMaterializedNode?.(node, diagramType) ?? node
  );
}

export function readTypeOwnedMermaidProjectionOwnerModel(
  model: MermaidVisualModel | null,
) {
  if (!model) return null;
  const hooks = getMermaidGfxFamilyHooks(model);
  if (!hooks) return null;
  return hooks.readProjectionOwnerModel?.(model) ?? model;
}

export function typeOwnedMermaidSourceSyncIncludesEndpointPositions(
  diagramType: MermaidVisualModel["diagramType"],
) {
  return (
    getMermaidGfxFamilyHooksForDiagramType(
      diagramType,
    )?.sourceSyncIncludesEndpointPositions?.(diagramType) ?? false
  );
}

export function finalizeTypeOwnedMermaidProjectionOwnerGeometry(
  model: MermaidVisualModel,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.finalizeProjectionOwnerGeometry?.(model) ??
    model
  );
}

export function reconcileTypeOwnedMermaidProjectionOwnerGeometry(
  model: MermaidVisualModel,
  sourceModel: MermaidVisualModel,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.reconcileProjectionOwnerGeometry?.(
      model,
      sourceModel,
    ) ?? model
  );
}

export function finalizeTypeOwnedMermaidAdoptedNodeElementProps(
  model: MermaidVisualModel,
  existingElement: unknown,
  projectedProps: Readonly<Record<string, unknown>>,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.finalizeAdoptedNodeElementProps?.(
      model,
      existingElement,
      projectedProps,
    ) ?? { ...projectedProps }
  );
}

export function reconcileTypeOwnedMermaidVisualProjection(
  parsed: MermaidVisualModel,
  stored: MermaidVisualModel,
  canReuseStored: boolean,
) {
  return (
    getMermaidGfxFamilyHooks(parsed)?.reconcileVisualProjection?.(
      parsed,
      stored,
      canReuseStored,
    ) ?? null
  );
}

export function canonicalizeTypeOwnedMermaidVisualProjectionAfterSourceWrite(
  reparsed: MermaidVisualModel,
  requested: MermaidVisualModel,
  source: string,
) {
  const canonicalized =
    getMermaidGfxFamilyHooks(reparsed)?.canonicalizeAfterSourceWrite?.(
      reparsed,
      requested,
      source,
    ) ?? requested;
  return {
    ...canonicalized,
    // The direct Surface consumer projects the block title as owner chrome.
    // Family canonicalizers own diagram semantics and geometry, but must not
    // erase that owner field merely because standalone Mermaid source reparses
    // without the block's title metadata.
    diagramTitle: requested.diagramTitle,
  };
}

export function typeOwnedMermaidNodeDimensionsAreValid(
  model: MermaidVisualModel,
  height: number | undefined,
  width: number | undefined,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.nodeDimensionsAreValid?.(height, width) ??
    true
  );
}

export function typeOwnedMermaidNodeMutationIsValid(
  model: MermaidVisualModel,
  mutation: Readonly<Record<string, unknown>>,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.nodeMutationIsValid?.(mutation) ?? true
  );
}

export function typeOwnedMermaidSubgraphDimensionsAreValid(
  model: MermaidVisualModel,
  height: number | undefined,
  width: number | undefined,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.subgraphDimensionsAreValid?.(
      height,
      width,
    ) ?? true
  );
}

export function typeOwnedMermaidSubgraphMutationIsValid(
  model: MermaidVisualModel,
  mutation: Readonly<Record<string, unknown>>,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.subgraphMutationIsValid?.(mutation) ?? true
  );
}

export function isTypeOwnedMermaidProjectionOnlyNodeMutation(
  model: MermaidVisualModel,
  mutation: Readonly<Record<string, unknown>>,
) {
  const validate = getMermaidGfxFamilyHooks(model)?.projectionOnlyNodeMutation;
  return validate
    ? validate(mutation, model)
    : mutation.projectionOnly === true;
}

export function isTypeOwnedMermaidProjectionOnlySubgraphMutation(
  model: MermaidVisualModel,
  mutation: Readonly<Record<string, unknown>>,
) {
  const validate =
    getMermaidGfxFamilyHooks(model)?.projectionOnlySubgraphMutation;
  return validate
    ? validate(mutation, model)
    : mutation.projectionOnly === true;
}

export function shouldPreserveTypeOwnedProjectionOwnerForInvalidSource(
  diagramType: string,
) {
  return (
    getMermaidGfxFamilyHooksForDiagramType(
      diagramType,
    )?.preserveProjectionOwnerForInvalidSource?.() ?? false
  );
}

export function typeOwnedMermaidVisualMutationRejectedMessage(
  model: MermaidVisualModel,
) {
  return (
    getMermaidGfxFamilyHooks(model)?.visualMutationRejectedMessage?.() ?? null
  );
}

/** A Source-owned family may validate persisted identity/geometry before consumers use it. */
export function readTypeOwnedMermaidSourceProjection(
  source: string,
  stored: MermaidVisualModel,
) {
  return (
    getMermaidGfxFamilyHooks(stored)?.readSourceProjection?.(source, stored) ??
    stored
  );
}

export function typeOwnedMermaidGeometrySelection(
  model: MermaidVisualModel,
  ids: readonly string[],
) {
  return (
    getMermaidGfxFamilyHooks(model)?.geometrySelection?.(model, ids) ?? ids
  );
}
export function reconcileTypeOwnedMermaidGeometryGesture(
  before: MermaidVisualModel,
  after: MermaidVisualModel,
) {
  return (
    getMermaidGfxFamilyHooks(after)?.reconcileGeometryGesture?.(
      before,
      after,
    ) ?? after
  );
}

/** Minimal-patch owners restore complete transactions, including opaque Source records. */
export function usesTypeOwnedMermaidDocumentHistory(
  diagramType: string | null,
) {
  return (
    diagramType !== null &&
    (getMermaidGfxFamilyHooksForDiagramType(diagramType)?.usesDocumentHistory ??
      false)
  );
}
