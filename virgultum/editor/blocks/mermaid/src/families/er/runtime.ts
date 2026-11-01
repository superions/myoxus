// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineMermaidFamilyRuntime } from "../runtime/factory.js";
import { mermaidErFamily, isErDiagramType } from "./family.js";
import { erDiagramTitle } from "./diagram-title.js";
import { erModelToVisual } from "./visual-model.js";
import {
  readErProjectionModel,
  reconcileErVisual,
  canonicalizeErVisual,
  applyErGfxVisualToSource,
} from "./source-application.js";
import {
  erNodeElementProjection,
  erDetailElementProjection,
} from "./entity-projection.js";
import {
  erRelationshipProjection,
  erConnectorElementProjection,
} from "./edge-projection.js";
import { erProjectionBinding } from "./gfx-data.js";
import { erPageSelectionTools } from "./actions.js";
import { mermaidErHostAdapter, erEdgelessToolbar } from "./host-adapter.js";
import { nextErSourceKey } from "../../engine/er/index.js";
import { projectNeutralMermaidGfxSubgraphElement } from "../runtime/gfx-element-projection-defaults.js";
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";
import { mermaidVisualFamilyPayload } from "../runtime/gfx-family-data.js";
import type { MermaidGfxFamilyHookRegistration } from "../runtime/gfx-family-hooks-contract.js";
export const erGfxHooks: MermaidGfxFamilyHookRegistration = {
  owns: (m) => isErDiagramType(m.diagramType),
  ownsDiagramType: isErDiagramType,
  hooks: {
    graphEditor: true,
    usesDocumentHistory: true,
    objectEditsViaFamilyControls: true,
    detailSelectionViaFamilyControls: true,
    // Active compartment editing keeps authored text at actual size. Passive
    // Notes may still fit the complete diagram; fixed Page zoom remains explicit.
    minimumReadableZoom: (_model, sharedMinimum) => Math.max(1, sharedMinimum),
    includeRenderedConnectorBounds: true,
    allowsSelfConnections: true,
    subgraphHeaderBehindContent: true,
    nodeInlineValue: (model, id) =>
      model.nodes.find((n) => n.id === id)?.label ?? "",
    preserveManagedNodeDimensions: (_model, source, existing) => ({
      width: Math.max(source.width, existing.width),
      height: Math.max(source.height, existing.height),
    }),
    preserveManagedSubgraphDimensions: (_model, source, existing) => ({
      width: Math.max(source.width, existing.width),
      height: Math.max(source.height, existing.height),
    }),
    readSourceProjection: (source, stored) => {
      const model = readErProjectionModel(source, stored);
      return model ? reconcileErVisual(erModelToVisual(model), stored) : null;
    },
    canConnectNodes: (model, from, to) =>
      [from, to].every((id) => model.nodes.some((n) => n.id === id)),
    createEdge: (model, from, to) => {
      const a = erProjectionBinding(
          model.nodes.find((n) => n.id === from) ?? {},
        ),
        b = erProjectionBinding(model.nodes.find((n) => n.id === to) ?? {});
      if (!a || !b) return null;
      const key = nextErSourceKey();
      return erRelationshipProjection(
        {
          id: key,
          sourceKey: key,
          from: a.sourceId,
          to: b.sourceId,
          cardinalityA: "exactly-one",
          cardinalityB: "zero-or-many",
          fromCardinality: "||",
          toCardinality: "o{",
          identification: "--",
          label: "",
          order: model.edges.length,
          scopeId: null,
        },
        new Map([
          [a.sourceId, from],
          [b.sourceId, to],
        ]),
      );
    },
    reconnectEdge: (model, edge, endpoint, key) =>
      model.nodes.some((n) => n.id === key)
        ? { ...edge, [endpoint]: key }
        : null,
    edgeReconnectable: () => true,
    reconcileNodeDragEnd: () => false,
    preserveProjectionOwnerForInvalidSource: () => true,
    shapePalette: { all: ["rect"], core: ["rect"] },
    canonicalizeAfterSourceWrite: canonicalizeErVisual,
    reconcileVisualProjection: (parsed, stored, canReuse) =>
      reconcileErVisual(canonicalizeErVisual(parsed, stored), stored, canReuse),
    projectionOnlyNodeMutation: (patch) =>
      Object.keys(patch).every((k) =>
        ["x", "y", "width", "height"].includes(k),
      ),
    projectionOnlySubgraphMutation: (patch) =>
      Object.keys(patch).every((k) =>
        ["x", "y", "width", "height"].includes(k),
      ),
    projectionOwnerReadbackPolicy: {
      preserveSourceMembership: true,
      preserveMultilineNodeLabels: true,
      preservePreviousSubgraphMembership: true,
      strictSemanticIdentities: true,
    },
    reparentNodes: (model, ids, parentId) =>
      !ids.length ||
      ids.some((id) => !model.nodes.some((n) => n.id === id)) ||
      (parentId && !model.subgraphs?.some((g) => g.id === parentId))
        ? null
        : {
            ...model,
            subgraphs: model.subgraphs?.map((g) => ({
              ...g,
              nodeIds:
                g.id === parentId
                  ? [...new Set([...g.nodeIds, ...ids])]
                  : g.nodeIds.filter((id) => !ids.includes(id)),
            })),
          },
    reparentSubgraph: (model, id, parentId) => ({
      ...model,
      subgraphs: model.subgraphs?.map((g) =>
        g.id === id ? { ...g, parentId: parentId || undefined } : g,
      ),
    }),
    readProjectionOwnerModel: (model) => model,
    diagramTitleTopMargin: (model) =>
      Number(
        (
          mermaidVisualFamilyPayload(model.familyData, "er")?.config as
            Record<string, unknown> | undefined
        )?.titleTopMargin,
      ) || 0,
    nodeElementProjection: erNodeElementProjection,
    nodeDetailElementProjection: erDetailElementProjection,
    edgeElementProjection: erConnectorElementProjection,
    subgraphElementProjection: (_model, group) => ({
      ...projectNeutralMermaidGfxSubgraphElement(),
      filled: Boolean(
        (
          mermaidVisualFamilyPayload(group.familyData, "er")?.styles as
            Record<string, unknown> | undefined
        )?.fill,
      ),
      ...projectMermaidSourceStyle(
        mermaidVisualFamilyPayload(group.familyData, "er")?.styles,
      ),
    }),
  },
};
export const mermaidErRuntime = defineMermaidFamilyRuntime({
  ...mermaidErFamily,
  preserveSourceBytes: true,
  diagramTitle: erDiagramTitle,
  gfxHooks: erGfxHooks,
  hostAdapter: mermaidErHostAdapter,
  edgelessToolbar: erEdgelessToolbar,
  pageSelectionTools: erPageSelectionTools,
  applyGfxVisualToSource: applyErGfxVisualToSource,
  parseSourceToGfxVisualModel: (source) => {
    const model = readErProjectionModel(source);
    return model ? erModelToVisual(model) : null;
  },
  sourceDiagnostics: (source, type) =>
    mermaidErFamily.parseSource(source, type).diagnostics,
  renderSurface: () => "core-facade" as const,
});
