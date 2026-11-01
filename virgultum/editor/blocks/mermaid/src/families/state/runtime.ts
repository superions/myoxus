// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineMermaidFamilyRuntime } from "../runtime/factory.js";
import { validateMermaidSource } from "../../renderer.js";
import { mermaidStateFamily } from "./family.js";
import {
  mermaidStateHostAdapter,
  stateEdgelessToolbar,
} from "./host-adapter.js";
import { applyStateGfxVisualToSource } from "./source-application.js";
import { stateDiagramTitle } from "./diagram-title.js";
import { statePageSelectionTools } from "./actions.js";
import type { MermaidGfxFamilyHookRegistration } from "../runtime/gfx-family-hooks-contract.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { stateProjectionBinding } from "./gfx-data.js";
import {
  canonicalizeStateVisual,
  readStateProjectionModel,
  reconcileStateVisual,
} from "./source-application.js";
import { stateModelToVisual } from "./visual-model.js";
import {
  stateNodeElementProjection,
  stateDetailElementProjection,
  normalizeStateNodeDimensions,
} from "./state-projection.js";
import {
  stateConnectorElementProjection,
  projectStateTransition,
} from "./transition-projection.js";
import {
  stateCompositeElementProjection,
  stateRegionElementProjection,
} from "./composite-projection.js";
import { nextStateSourceKey } from "../../engine/state/index.js";
import { resolveMermaidGfxProjectionTheme } from "../../mermaid-gfx-theme.js";
import { mermaidVisualFamilyPayload } from "../runtime/gfx-family-data.js";

const isStateType = (type: string) =>
  type === "stateDiagram" || type === "stateDiagram-v2";
// Command contexts also carry std/model/selection ports. Validate semantic
// fields, rather than rejecting a geometry gesture for its transport fields.
const nodeGeometryMutation = (patch: Readonly<Record<string, unknown>>) =>
  [
    "label",
    "displayLabel",
    "shape",
    "styleClass",
    "details",
    "familyData",
    "labelEditable",
    "textAlign",
    "textVerticalAlign",
  ].every((k) => patch[k] === undefined);
const subgraphGeometryMutation = (patch: Readonly<Record<string, unknown>>) =>
  ["title", "direction", "nodeIds", "parentId", "familyData"].every(
    (k) => patch[k] === undefined,
  );
function stateEndpointBinding(model: MermaidVisualModel, id: string) {
  const b = stateProjectionBinding(
    [...model.nodes, ...(model.subgraphs ?? [])].find((n) => n.id === id) ?? {},
  );
  return b?.role === "state" || b?.role === "composite" ? b : undefined;
}
function canConnectState(model: MermaidVisualModel, from: string, to: string) {
  const a = stateEndpointBinding(model, from),
    b = stateEndpointBinding(model, to);
  return Boolean(a && b && a.kind !== "end" && b.kind !== "start");
}
/** Geometry gestures use the existing surface and document history. Source
 * commands validate identity and membership before that same commit boundary. */
export const stateGfxHooks: MermaidGfxFamilyHookRegistration = {
  owns: (model) => isStateType(model.diagramType),
  ownsDiagramType: isStateType,
  hooks: {
    graphEditor: true,
    usesDocumentHistory: true,
    objectEditsViaFamilyControls: true,
    detailSelectionViaFamilyControls: true,
    minimumReadableZoom: (_model, minimum) => Math.max(1, minimum),
    includeRenderedConnectorBounds: true,
    diagramTitleTopMargin: (model) =>
      Number(
        (
          mermaidVisualFamilyPayload(model.familyData, "state")?.config as
            Record<string, unknown> | undefined
        )?.titleTopMargin,
      ) || 0,
    allowsSelfConnections: true,
    edgeHitTestIncludesSubgraphs: true,
    connectionTargetsIncludeSubgraphs: true,
    subgraphHeaderBehindContent: true,
    nodePaintLayer: (_model, node) =>
      stateProjectionBinding(node)?.role === "region"
        ? "background"
        : "content",
    nodeInlineValue: (model, id) =>
      model.nodes.find((n) => n.id === id)?.label ?? "",
    subgraphInlineValue: (model, id) =>
      model.subgraphs?.find((g) => g.id === id)?.title ?? "",
    nodeMutationIsValid: nodeGeometryMutation,
    subgraphMutationIsValid: subgraphGeometryMutation,
    projectionOnlyNodeMutation: nodeGeometryMutation,
    projectionOnlySubgraphMutation: subgraphGeometryMutation,
    normalizeNodeDimensions: normalizeStateNodeDimensions,
    usesGenericNodeShapeMinimums: () => false,
    geometrySelection: (model, ids) => {
      const selected = ids.filter(
        (id) =>
          stateProjectionBinding(model.nodes.find((n) => n.id === id) ?? {})
            ?.role !== "region",
      );
      const targets = new Set(
        [...model.nodes, ...(model.subgraphs ?? [])]
          .filter((n) => selected.includes(n.id))
          .map((n) => stateProjectionBinding(n)?.sourceId),
      );
      return [
        ...new Set([
          ...selected,
          ...model.nodes
            .filter((n) => {
              const target = mermaidVisualFamilyPayload(
                n.familyData,
                "state",
              )?.noteStateId;
              return typeof target === "string" && targets.has(target);
            })
            .map((n) => n.id),
        ]),
      ];
    },
    reconcileGeometryGesture: (before, after) => {
      const objects = [...after.nodes, ...(after.subgraphs ?? [])];
      const oldObjects = new Map(
        [...before.nodes, ...(before.subgraphs ?? [])].map((n) => [n.id, n]),
      );
      const adjusted = {
        ...after,
        nodes: after.nodes.map((note) => {
          const targetId = mermaidVisualFamilyPayload(
            note.familyData,
            "state",
          )?.noteStateId;
          const oldNote = oldObjects.get(note.id);
          const target =
            targetId &&
            objects.find(
              (n) => stateProjectionBinding(n)?.sourceId === targetId,
            );
          const oldTarget = target && oldObjects.get(target.id);
          // Expanded drag selections already moved their notes; only follow an
          // owner gesture when the note itself retained its previous position.
          if (
            !oldNote ||
            !target ||
            !oldTarget ||
            note.x !== oldNote.x ||
            note.y !== oldNote.y
          )
            return note;
          return {
            ...note,
            x: note.x + target.x - oldTarget.x,
            y: note.y + target.y - oldTarget.y,
          };
        }),
      };
      return reconcileStateVisual(adjusted, adjusted);
    },
    finalizeProjectionOwnerGeometry: (model) =>
      reconcileStateVisual(model, model),
    descendantSubgraphIds: (model, id) => {
      const ids = new Set<string>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const g of model.subgraphs ?? [])
          if (
            g.parentId &&
            (g.parentId === id || ids.has(g.parentId)) &&
            !ids.has(g.id)
          ) {
            ids.add(g.id);
            changed = true;
          }
      }
      return ids;
    },
    preserveManagedNodeDimensions: (_model, source, existing) => ({
      width: Math.max(source.width, existing.width),
      height: Math.max(source.height, existing.height),
    }),
    preserveManagedSubgraphDimensions: (_model, source, existing) => ({
      width: Math.max(source.width, existing.width),
      height: Math.max(source.height, existing.height),
    }),
    readSourceProjection: (source, stored) => {
      const model = readStateProjectionModel(source, stored);
      return model
        ? reconcileStateVisual(stateModelToVisual(model), stored)
        : null;
    },
    canonicalizeAfterSourceWrite: canonicalizeStateVisual,
    reconcileVisualProjection: (parsed, stored, reuse) =>
      reconcileStateVisual(
        canonicalizeStateVisual(parsed, stored),
        stored,
        reuse,
      ),
    projectionOwnerReadbackPolicy: {
      preserveSourceMembership: true,
      preserveMultilineNodeLabels: true,
      preservePreviousSubgraphMembership: true,
      strictSemanticIdentities: true,
    },
    preserveProjectionOwnerForInvalidSource: () => true,
    readProjectionOwnerModel: (model) => model,
    reconcileNodeDragEnd: () => false,
    shapePalette: { all: [], core: [] },
    canConnectNodes: canConnectState,
    createEdge: (model, from, to) => {
      if (!canConnectState(model, from, to)) return null;
      const a = stateEndpointBinding(model, from)!,
        b = stateEndpointBinding(model, to)!,
        key = nextStateSourceKey();
      const transition = {
        id: key,
        sourceKey: key,
        from: a.sourceId,
        to: b.sourceId,
        parentId: a.parentId ?? undefined,
        regionKey: a.regionKey,
        label: "",
        order: model.edges.length,
      };
      return projectStateTransition(
        transition,
        new Map([
          [a.sourceId, from],
          [b.sourceId, to],
        ]),
        [transition],
      );
    },
    reconnectEdge: (model, edge, endpoint, id) =>
      canConnectState(
        model,
        endpoint === "source" ? id : edge.source,
        endpoint === "target" ? id : edge.target,
      )
        ? { ...edge, [endpoint]: id }
        : null,
    edgeReconnectable: () => true,
    // Group, Delete and Reparent need explicit Source impact/confirmation.
    createSubgraph: () => null,
    deleteSelection: () => null,
    deleteSubgraph: () => null,
    reparentNodes: () => null,
    reparentSubgraph: () => null,
    nodeElementProjection: (model, node) => {
      const b = stateProjectionBinding(node),
        base = stateNodeElementProjection(model, node);
      if (b?.role === "region")
        return { ...base, ...stateRegionElementProjection() };
      if (b?.role === "note") {
        const theme = resolveMermaidGfxProjectionTheme();
        return {
          ...base,
          textDisplay: true,
          filled: true,
          color: theme.textColor,
          fillColor: theme.secondarySurfaceColor,
          strokeColor: theme.borderColor,
        };
      }
      return base;
    },
    nodeDetailElementProjection: stateDetailElementProjection,
    edgeElementProjection: stateConnectorElementProjection,
    subgraphElementProjection: stateCompositeElementProjection,
  },
};

export const mermaidStateRuntime = defineMermaidFamilyRuntime({
  ...mermaidStateFamily,
  preserveSourceBytes: true,
  validateSource: validateMermaidSource,
  diagramTitle: stateDiagramTitle,
  gfxHooks: stateGfxHooks,
  hostAdapter: mermaidStateHostAdapter,
  edgelessToolbar: stateEdgelessToolbar,
  pageSelectionTools: statePageSelectionTools,
  applyGfxVisualToSource: applyStateGfxVisualToSource,
  parseSourceToGfxVisualModel: (source: string) => {
    const model = readStateProjectionModel(source);
    return model ? stateModelToVisual(model) : null;
  },
  sourceDiagnostics: (source: string, type) =>
    mermaidStateFamily.parseSource(source, type).diagnostics,
  renderSurface: () => "core-facade" as const,
});
