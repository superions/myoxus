// SPDX-License-Identifier: AGPL-3.0-or-later
import { EditPropsStore } from "@virgultum/shared/services";
import { remapCopiedMindmapIdentities } from "./copy-identities.js";
import { mindmapPopoverAnchorSide } from "./interaction/anchors.js";
import { mindmapNodeKeyboardIntent } from "./interaction/keyboard.js";
import type { MermaidGfxFamilyHookRegistration } from "../runtime/gfx-family-hooks-contract.js";
import { projectNeutralMermaidGfxSubgraphElement } from "../runtime/gfx-element-projection-defaults.js";
import { readMindmapProjectionModel } from "./source-application.js";
import { readMindmapProjectionOptions } from "./gfx-data.js";
import {
  mindmapNodeProjection,
  mindmapBranchProjection,
} from "./projection/renderer.js";
import { projectMindmapTree } from "./projection/tree.js";
export const mindmapGfxHooks: MermaidGfxFamilyHookRegistration = {
  owns: (model) => model.diagramType === "mindmap",
  ownsDiagramType: (type) => type === "mindmap",
  hooks: {
    prepareInsertProjection: (source, visual, provider) => {
      const defaults = provider
        .getOptional(EditPropsStore)
        ?.lastProps$.peek().mindmap;
      const model = readMindmapProjectionModel(source, visual);
      return model && defaults
        ? projectMindmapTree(model, {
            layout: defaults.layoutType,
            design: defaults.style,
          })
        : visual;
    },
    graphEditor: true,
    semanticClipboard: true,
    remapCopiedIdentities: remapCopiedMindmapIdentities,
    usesDocumentHistory: true,
    objectEditsViaFamilyControls: true,
    objectEditAnchorSide: (model, _kind, key) =>
      mindmapPopoverAnchorSide(model, key),
    nodeKeyboardIntent: mindmapNodeKeyboardIntent,
    sourceDerivedGeometry: true,
    normalizeNodeDimensions: (node) => node,
    usesGenericNodeShapeMinimums: () => false,
    includeRenderedConnectorBounds: true,
    shapePalette: { all: [], core: [] },
    syncSubgraphMembership: (model) => model,
    subgraphMutationIsValid: () => false,
    minimumReadableZoom: (_model, shared) => Math.max(1, shared),
    canConnectNodes: () => false,
    createEdge: () => null,
    edgeReconnectable: () => false,
    reconnectEdge: () => null,
    createSubgraph: () => null,
    reparentNodes: () => null,
    reparentSubgraph: () => null,
    createNode: () => null,
    duplicateSelection: () => null,
    deleteSelection: () => null,
    reconcileNodeDragEnd: () => false,
    nodeConnectionPorts: () => [],
    geometrySelection: () => [],
    reconcileGeometryGesture: (before) => before,
    nodeMutationIsValid: () => false,
    canonicalizeAfterSourceWrite: (_parsed, requested, source) => {
      const model = readMindmapProjectionModel(source, requested);
      return model
        ? projectMindmapTree(model, readMindmapProjectionOptions(requested))
        : requested;
    },
    reconcileVisualProjection: (parsed) => parsed,
    nodeInlineValue: (model, key) =>
      model.nodes.find((node) => node.id === key)?.label ?? "",
    readSourceProjection: (source, stored) => {
      const model = readMindmapProjectionModel(source, stored);
      return model
        ? projectMindmapTree(model, readMindmapProjectionOptions(stored))
        : null;
    },
    preserveProjectionOwnerForInvalidSource: () => true,
    projectionOwnerReadbackPolicy: {
      preserveSourceMembership: true,
      preserveMultilineNodeLabels: true,
      strictSemanticIdentities: true,
    },
    nodeElementProjection: mindmapNodeProjection,
    edgeElementProjection: mindmapBranchProjection,
    subgraphElementProjection: () => projectNeutralMermaidGfxSubgraphElement(),
  },
};
