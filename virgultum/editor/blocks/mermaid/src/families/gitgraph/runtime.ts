// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineMermaidFamilyRuntime } from "../runtime/factory.js";
import type { MermaidGfxFamilyHookRegistration } from "../runtime/gfx-family-hooks-contract.js";
import { mermaidGitGraphFamily, isGitGraphDiagramType } from "./family.js";
import { mermaidGitGraphHostAdapter } from "./host-adapter.js";
import { gitGraphEdgelessToolbar } from "./edgeless-toolbar.js";
import { mermaidGitGraphRendererToken } from "./react-host-contract.js";
import { gitGraphDiagramTitle } from "./diagram-title.js";
import { gitGraphModelToVisual } from "./visual-model.js";
import {
  gitGraphBinding,
  gitGraphPayload,
  readGitGraphProjectionModel,
  readGitGraphProjectionOwner,
} from "./gfx-data.js";
import {
  applyGitGraphVisualToSource,
  canonicalizeGitGraphSourceWrite,
  reconcileGitGraphVisual,
  reconcileGitGraphTypographyGeometry,
} from "./source-application.js";
import { GITGRAPH_COMMANDS, gitGraphPageSelectionTools } from "./actions.js";
import { projectGitGraphNode } from "./commit-projection.js";
import { projectGitGraphRelationship } from "./relationship-projection.js";
import { projectNeutralMermaidGfxSubgraphElement } from "../runtime/gfx-element-projection-defaults.js";
export const gitGraphGfxHooks: MermaidGfxFamilyHookRegistration = {
  owns: (model) => isGitGraphDiagramType(model.diagramType),
  ownsDiagramType: isGitGraphDiagramType,
  hooks: {
    graphEditor: true,
    nodePaintLayer: (_model, node) =>
      gitGraphBinding(node)?.role === "rail" ? "background" : "content",
    diagramTitleTopMargin: (model) =>
      Number(gitGraphPayload(model)?.titleTopMargin ?? 0),
    usesDocumentHistory: true,
    objectEditsViaFamilyControls: true,
    detailSelectionViaFamilyControls: true,
    sourceDerivedGeometry: true,
    geometrySelection: () => [],
    normalizeNodeDimensions: (node) => node,
    usesGenericNodeShapeMinimums: () => false,
    reconcileGeometryGesture: (before) => before,
    reconcileNodeDragEnd: () => false,
    includeRenderedConnectorBounds: true,
    preserveProjectionOwnerForInvalidSource: () => true,
    readSourceProjection: (source, stored) => {
      const model = readGitGraphProjectionModel(source, stored);
      return model &&
        !model.derivedGraph?.diagnostics.some((d) => d.severity === "error")
        ? gitGraphModelToVisual(model)
        : null;
    },
    canonicalizeAfterSourceWrite: canonicalizeGitGraphSourceWrite,
    reconcileVisualProjection: reconcileGitGraphVisual,
    reconcileProjectionOwnerGeometry: reconcileGitGraphTypographyGeometry,
    projectionOnlyNodeMutation: (patch) =>
      Object.keys(patch).every((k) =>
        ["x", "y", "width", "height"].includes(k),
      ),
    projectionOnlySubgraphMutation: () => false,
    nodeMutationIsValid: () => false,
    subgraphMutationIsValid: () => false,
    projectionOwnerReadbackPolicy: {
      preserveSourceMembership: true,
      preserveMultilineNodeLabels: true,
      strictSemanticIdentities: true,
    },
    createNode: () => null,
    createEdge: () => null,
    createSubgraph: () => null,
    canConnectNodes: () => false,
    nodeConnectionPorts: () => [],
    edgeReconnectable: () => false,
    deleteSelection: () => null,
    reparentNodes: () => null,
    reparentSubgraph: () => null,
    shapePalette: { all: [], core: [] },
    nodeElementProjection: projectGitGraphNode,
    subgraphElementProjection: projectNeutralMermaidGfxSubgraphElement,
    edgeElementProjection: projectGitGraphRelationship,
    readProjectionOwnerModel: readGitGraphProjectionOwner,
    syncSubgraphMembership: (model) => model,
  },
};
/** One Source owner supplies both Page and native/embedded GFX consumers. */
export const mermaidGitGraphRuntime = defineMermaidFamilyRuntime({
  ...mermaidGitGraphFamily,
  preserveSourceBytes: true,
  rendererToken: mermaidGitGraphRendererToken,
  semanticCommands: GITGRAPH_COMMANDS,
  pageSelectionTools: gitGraphPageSelectionTools,
  diagramTitle: gitGraphDiagramTitle,
  gfxHooks: gitGraphGfxHooks,
  hostAdapter: mermaidGitGraphHostAdapter,
  edgelessToolbar: gitGraphEdgelessToolbar,
  applyGfxVisualToSource: (source, visual) => ({
    diagnostics: [],
    ...applyGitGraphVisualToSource(source, visual),
  }),
  parseSourceToGfxVisualModel: (source) => {
    const model = readGitGraphProjectionModel(source);
    return model &&
      !model.derivedGraph?.diagnostics.some((d) => d.severity === "error")
      ? gitGraphModelToVisual(model)
      : null;
  },
  sourceDiagnostics: (source) =>
    mermaidGitGraphFamily.parseSource(source, "gitGraph").diagnostics,
  renderSurface: () => "core-facade" as const,
});
