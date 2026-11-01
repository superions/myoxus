// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineMermaidFamilyRuntime } from "../runtime/factory.js";
import type { MermaidGfxFamilyHookRegistration } from "../runtime/gfx-family-hooks-contract.js";
import { mermaidSequenceFamily, isSequenceDiagramType } from "./family.js";
import { sequenceDiagramTitle } from "./diagram-title.js";
import { sequenceModelToVisual } from "./visual-model.js";
import {
  readSequenceProjectionModel,
  canonicalizeSequenceVisual,
  applySequenceGfxVisualToSource,
} from "./source-application.js";
import { nextSequenceSourceKey } from "../../engine/sequence/index.js";
import { sequenceObjectFamilyData } from "./gfx-data.js";
import { sequenceNodeBinding, sequenceFamilyPayload } from "./gfx-data.js";
import {
  sequenceParticipantElementProjection,
  sequenceParticipantDetailProjection,
} from "./participant-projection.js";
import { sequenceActivationElementProjection } from "./activation-projection.js";
import { sequenceNoteElementProjection } from "./annotation-projection.js";
import {
  sequenceBranchElementProjection,
  sequenceFragmentElementProjection,
} from "./fragment-projection.js";
import { sequenceBackgroundElementProjection } from "./background-projection.js";
import { sequenceMessageElementProjection } from "./message-projection.js";
import { sequencePageSelectionTools } from "./actions.js";
import {
  mermaidSequenceHostAdapter,
  sequenceEdgelessToolbar,
} from "./host-adapter.js";

export const sequenceGfxHooks: MermaidGfxFamilyHookRegistration = {
  owns: (model) => isSequenceDiagramType(model.diagramType),
  ownsDiagramType: isSequenceDiagramType,
  hooks: {
    graphEditor: true,
    usesDocumentHistory: true,
    objectEditsViaFamilyControls: true,
    objectEditAnchorSide: (model, kind, id) =>
      kind === "subgraph" ||
      sequenceNodeBinding(model.nodes.find((node) => node.id === id) ?? {})
        ?.role === "branch"
        ? "start"
        : "end",
    detailSelectionViaFamilyControls: true,
    allowsSelfConnections: true,
    includeRenderedConnectorBounds: true,
    subgraphHeaderBehindContent: true,
    minimumReadableZoom: (_model, minimum) => Math.max(1, minimum),
    geometrySelection: () => [],
    reconcileGeometryGesture: (before) => before,
    reconcileNodeDragEnd: () => false,
    sourceDerivedGeometry: true,
    preserveProjectionOwnerForInvalidSource: () => true,
    readSourceProjection: (source, stored) => {
      const model = readSequenceProjectionModel(source, stored);
      return model ? sequenceModelToVisual(model) : null;
    },
    canonicalizeAfterSourceWrite: canonicalizeSequenceVisual,
    reconcileVisualProjection: (parsed, stored) =>
      canonicalizeSequenceVisual(parsed, stored),
    projectionOnlyNodeMutation: (patch) =>
      Object.keys(patch).every((key) =>
        ["x", "y", "width", "height"].includes(key),
      ),
    projectionOnlySubgraphMutation: (patch) =>
      Object.keys(patch).every((key) =>
        ["x", "y", "width", "height"].includes(key),
      ),
    nodeMutationIsValid: (patch) =>
      !Object.keys(patch).some((key) =>
        ["shape", "x", "y", "width", "height"].includes(key),
      ),
    subgraphMutationIsValid: (patch) =>
      !Object.keys(patch).some((key) =>
        ["x", "y", "width", "height", "nodeIds", "parentId"].includes(key),
      ),
    projectionOwnerReadbackPolicy: {
      preserveSourceMembership: true,
      preserveMultilineNodeLabels: true,
      preservePreviousSubgraphMembership: true,
      strictSemanticIdentities: true,
    },
    canConnectNodes: (model, from, to) =>
      [from, to].every((key) => {
        const binding = sequenceNodeBinding(
          model.nodes.find((node) => node.id === key) ?? {},
        );
        return Boolean(
          binding &&
          !binding.mirror &&
          (binding.role === "participant" || binding.role === "lifeline"),
        );
      }),
    // An explicit Connect appends one temporal statement. Spatial placement is
    // discarded by the checked Source projection, never converted into order.
    createEdge: (model, from, to) => {
      const a = sequenceNodeBinding(
          model.nodes.find((node) => node.id === from) ?? {},
        ),
        b = sequenceNodeBinding(
          model.nodes.find((node) => node.id === to) ?? {},
        );
      if (!a?.participantId || !b?.participantId) return null;
      return {
        id: nextSequenceSourceKey(),
        label: "",
        source: a.participantKey ?? a.sourceKey,
        target: b.participantKey ?? b.sourceKey,
        sourceAttachment: `${a.sourceKey}:lifeline`,
        targetAttachment: `${b.sourceKey}:lifeline`,
        sourcePosition: [0.5, 1],
        targetPosition: [0.5, 1],
        sourceMarker: "none",
        targetMarker: "triangle",
        connectorMode: "straight",
        style: "solid",
        labelPlacement: "top",
        familyData: sequenceObjectFamilyData({
          arrow: "->>",
          centralFrom: false,
          centralTo: false,
        }),
      };
    },
    nodeConnectionPorts: (_model, node) => {
      const binding = sequenceNodeBinding(node);
      return binding &&
        !binding.mirror &&
        (binding.role === "participant" || binding.role === "lifeline")
        ? [{ id: "timeline-end", position: [0.5, 1] }]
        : [];
    },
    reconnectEdge: (model, edge, endpoint, key) => {
      const binding = sequenceNodeBinding(
        model.nodes.find((node) => node.id === key) ?? {},
      );
      // Header and Lifeline are two hits for one semantic Participant. A drop
      // on the line must never persist its derived node ID as the endpoint.
      return binding &&
        !binding.mirror &&
        (binding.role === "participant" || binding.role === "lifeline")
        ? {
            ...edge,
            [endpoint]: binding.participantKey ?? binding.sourceKey,
            [`${endpoint}Attachment`]: `${binding.sourceKey}:lifeline`,
          }
        : null;
    },
    edgeReconnectable: () => true,
    deleteSelection: () => null,
    reparentNodes: () => null,
    reparentSubgraph: () => null,
    shapePalette: { all: ["rect"], core: ["rect"] },
    nodeInlineValue: (model, key) =>
      model.nodes.find((node) => node.id === key)?.label ?? "",
    readProjectionOwnerModel: (model) => model,
    diagramTitleTopMargin: (model) =>
      Number(
        (
          sequenceFamilyPayload(model)?.config as
            Record<string, unknown> | undefined
        )?.titleTopMargin,
      ) || 0,
    nodeElementProjection: (model, node) => {
      switch (sequenceNodeBinding(node)?.role) {
        case "activation":
          return sequenceActivationElementProjection(model, node);
        case "note":
          return sequenceNoteElementProjection(model, node);
        case "branch":
          return sequenceBranchElementProjection(model, node);
        default:
          return sequenceParticipantElementProjection(model, node);
      }
    },
    nodeDetailElementProjection: sequenceParticipantDetailProjection,
    edgeElementProjection: sequenceMessageElementProjection,
    subgraphElementProjection: (model, group) =>
      sequenceFamilyPayload(group)?.role === "fragment"
        ? sequenceFragmentElementProjection()
        : sequenceBackgroundElementProjection(model, group),
    subgraphUsesTemporalRangeGeometry: () => true,
  },
};
export const mermaidSequenceRuntime = defineMermaidFamilyRuntime({
  ...mermaidSequenceFamily,
  preserveSourceBytes: true,
  diagramTitle: sequenceDiagramTitle,
  gfxHooks: sequenceGfxHooks,
  hostAdapter: mermaidSequenceHostAdapter,
  edgelessToolbar: sequenceEdgelessToolbar,
  pageSelectionTools: sequencePageSelectionTools,
  applyGfxVisualToSource: applySequenceGfxVisualToSource,
  parseSourceToGfxVisualModel: (source: string) => {
    const model = readSequenceProjectionModel(source);
    return model ? sequenceModelToVisual(model) : null;
  },
  sourceDiagnostics: (source: string) =>
    mermaidSequenceFamily.parseSource(source, "sequenceDiagram").diagnostics,
  renderSurface: () => "core-facade" as const,
});
