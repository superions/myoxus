// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineMermaidFamilyRuntime } from "../runtime/factory.js";
import type { MermaidGfxFamilyHookRegistration } from "../runtime/gfx-family-hooks-contract.js";
import {
  mermaidBlockFamily,
  isBlockDiagramType,
  blockDiagramTitle,
} from "./family.js";
import { blockModelToVisual } from "./visual-model.js";
import {
  readBlockProjectionModel,
  reconcileBlockVisual,
  canonicalizeBlockVisual,
  applyBlockGfxVisualToSource,
  blockGeometrySelection,
  reconcileBlockGeometryGesture,
} from "./source-application.js";
import {
  blockNodeElementProjection,
  blockDetailElementProjection,
} from "./block-projection.js";
import { blockCompositeElementProjection } from "./composite-projection.js";
import {
  blockConnectorElementProjection,
  blockConnectorPresentationMatches,
  projectBlockConnection,
} from "./connection-projection.js";
import { blockProjectionBinding } from "./gfx-data.js";
import { blockAlignmentGuides } from "./grid-projection.js";
import { blockPageSelectionTools } from "./actions.js";
import {
  mermaidBlockHostAdapter,
  blockEdgelessToolbar,
} from "./host-adapter.js";
import {
  nextBlockSourceKey,
  blockConnectionAppearance,
} from "../../engine/block/index.js";
const geometryMutation = (p: Readonly<Record<string, unknown>>) =>
  Object.keys(p).every((k) => ["x", "y", "width", "height"].includes(k));
export const blockGfxHooks: MermaidGfxFamilyHookRegistration = {
  owns: (m) => isBlockDiagramType(m.diagramType),
  ownsDiagramType: isBlockDiagramType,
  hooks: {
    graphEditor: true,
    usesDocumentHistory: true,
    objectEditsViaFamilyControls: true,
    detailSelectionViaFamilyControls: true,
    minimumReadableZoom: (_m, n) => Math.max(1, n),
    includeRenderedConnectorBounds: true,
    projectionOwnerAppearanceMatchesTheme: blockConnectorPresentationMatches,
    allowsSelfConnections: true,
    edgeHitTestIncludesSubgraphs: true,
    connectionTargetsIncludeSubgraphs: true,
    subgraphHeaderBehindContent: true,
    alignmentGuides: blockAlignmentGuides,
    nodeInlineValue: (m, id) => m.nodes.find((n) => n.id === id)?.label ?? "",
    subgraphInlineValue: (m, id) =>
      m.subgraphs?.find((g) => g.id === id)?.title ?? "",
    nodeMutationIsValid: geometryMutation,
    subgraphMutationIsValid: geometryMutation,
    projectionOnlyNodeMutation: geometryMutation,
    projectionOnlySubgraphMutation: geometryMutation,
    geometrySelection: blockGeometrySelection,
    // Native pointer and keyboard moves consume the shared subgraph hook.
    // Reuse Source-owned expansion, never spatial containment.
    descendantSubgraphIds: (model, id) =>
      new Set(
        blockGeometrySelection(model, [id]).filter(
          (key) =>
            key !== id && model.subgraphs?.some((group) => group.id === key),
        ),
      ),
    reconcileGeometryGesture: reconcileBlockGeometryGesture,
    finalizeProjectionOwnerGeometry: (m) => reconcileBlockVisual(m, m),
    usesGenericNodeShapeMinimums: () => false,
    preserveManagedNodeDimensions: (_m, a, b) => ({
      width: Math.max(a.width, b.width),
      height: Math.max(a.height, b.height),
    }),
    preserveManagedSubgraphDimensions: (_m, a, b) => ({
      width: Math.max(a.width, b.width),
      height: Math.max(a.height, b.height),
    }),
    readSourceProjection: (source, stored) => {
      const m = readBlockProjectionModel(source, stored);
      return m ? reconcileBlockVisual(blockModelToVisual(m), stored) : null;
    },
    canConnectNodes: (m, from, to) =>
      [from, to].every((id) =>
        [...m.nodes, ...(m.subgraphs ?? [])].some(
          (n) => n.id === id && blockProjectionBinding(n)?.role !== "space",
        ),
      ),
    createEdge: (m, from, to) => {
      const nodes = [...m.nodes, ...(m.subgraphs ?? [])],
        a = blockProjectionBinding(nodes.find((n) => n.id === from) ?? {}),
        b = blockProjectionBinding(nodes.find((n) => n.id === to) ?? {});
      if (!a?.sourceId || !b?.sourceId) return null;
      const key = nextBlockSourceKey();
      return projectBlockConnection(
        {
          id: key,
          sourceKey: key,
          from: a.sourceId,
          to: b.sourceId,
          token: "-->",
          labelSource: "",
          label: "",
          order: m.edges.length,
          parentKey: null,
          resolved: true,
          ...blockConnectionAppearance("-->"),
        },
        new Map([
          [a.sourceId, from],
          [b.sourceId, to],
        ]),
        [],
      );
    },
    reconnectEdge: (m, e, end, key) =>
      [...m.nodes, ...(m.subgraphs ?? [])].some(
        (n) => n.id === key && blockProjectionBinding(n)?.role !== "space",
      )
        ? { ...e, [end]: key }
        : null,
    edgeReconnectable: () => true,
    reconcileNodeDragEnd: () => false,
    preserveProjectionOwnerForInvalidSource: () => true,
    shapePalette: { all: ["rect"], core: ["rect"] },
    canonicalizeAfterSourceWrite: canonicalizeBlockVisual,
    reconcileVisualProjection: (parsed, stored, reuse) =>
      reconcileBlockVisual(
        canonicalizeBlockVisual(parsed, stored),
        stored,
        reuse,
      ),
    projectionOwnerReadbackPolicy: {
      preserveSourceMembership: true,
      preserveMultilineNodeLabels: true,
      preservePreviousSubgraphMembership: true,
      strictSemanticIdentities: true,
    },
    readProjectionOwnerModel: (m) => m,
    nodeElementProjection: blockNodeElementProjection,
    nodeDetailElementProjection: blockDetailElementProjection,
    edgeElementProjection: blockConnectorElementProjection,
    subgraphElementProjection: blockCompositeElementProjection,
  },
};
export const mermaidBlockRuntime = defineMermaidFamilyRuntime({
  ...mermaidBlockFamily,
  preserveSourceBytes: true,
  diagramTitle: blockDiagramTitle,
  gfxHooks: blockGfxHooks,
  hostAdapter: mermaidBlockHostAdapter,
  edgelessToolbar: blockEdgelessToolbar,
  pageSelectionTools: blockPageSelectionTools,
  applyGfxVisualToSource: applyBlockGfxVisualToSource,
  parseSourceToGfxVisualModel: (source: string) => {
    const m = readBlockProjectionModel(source);
    return m ? blockModelToVisual(m) : null;
  },
  sourceDiagnostics: (source, type) =>
    mermaidBlockFamily.parseSource(source, type).diagnostics,
  renderSurface: () => "core-facade" as const,
});
