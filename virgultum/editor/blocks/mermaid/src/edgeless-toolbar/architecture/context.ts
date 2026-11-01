// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidBlockModel } from "@virgultum/model";
import type { ToolbarContext } from "@virgultum/shared/services";

import {
  applyMermaidVisualModelCommand,
  getMermaidGfxConnector,
  getMermaidGfxNode,
  getMermaidGfxSubgraph,
} from "../../commands.js";
import { parseMermaidVisualFamilyData } from "../../families/runtime/gfx-family-data.js";
import type { MermaidPageSelectionItem } from "../../families/runtime/contracts.js";
import type { ArchitectureInteractionResolution } from "../../families/architecture/interaction-controller.js";
import { architectureVisualSelectionAfter } from "../../families/architecture/interaction-controller.js";
import { mermaidMessages } from "../../i18n.js";
import {
  readMermaidGfxEdgeId,
  readMermaidGfxMeta,
  readMermaidGfxNodeId,
  readMermaidGfxSubgraphId,
} from "../../mermaid-gfx-metadata.js";
import {
  resolveMermaidEdgelessSelection,
  runMermaidEdgelessMutation,
} from "../selection-context.js";

function isArchitectureGfxModel(model: unknown) {
  return [
    "mermaidNodeFamilyData",
    "mermaidSubgraphFamilyData",
    "mermaidEdgeFamilyData",
  ].some(
    (key) =>
      parseMermaidVisualFamilyData(readMermaidGfxMeta(model, key))?.family ===
      "architecture",
  );
}

export function selectedArchitectureModels(context: ToolbarContext) {
  return context.getSurfaceModels().filter(isArchitectureGfxModel);
}

export function selectedArchitectureItems(
  context: ToolbarContext,
): MermaidPageSelectionItem[] {
  return selectedArchitectureModels(context).flatMap<MermaidPageSelectionItem>(
    (model) => {
      const nodeId = readMermaidGfxNodeId(model);
      if (nodeId) return [{ editKey: nodeId, kind: "node" }];
      const edgeId = readMermaidGfxEdgeId(model);
      if (edgeId) return [{ editKey: edgeId, kind: "edge" }];
      const subgraphId = readMermaidGfxSubgraphId(model);
      return subgraphId ? [{ editKey: subgraphId, kind: "subgraph" }] : [];
    },
  );
}

export function architectureOwnerForSelection(context: ToolbarContext) {
  const state = resolveMermaidEdgelessSelection(context);
  return state?.visualModel?.diagramType === "architecture" && state.projection
    ? {
        owner: state.owner,
        projection: state.projection,
        visualModel: state.visualModel,
      }
    : null;
}

export type ArchitectureEdgelessOwnerState = NonNullable<
  ReturnType<typeof architectureOwnerForSelection>
>;

export function runArchitectureMutation(
  context: ToolbarContext,
  owner: MermaidBlockModel,
  run: () => boolean,
) {
  return runMermaidEdgelessMutation(context, owner, run);
}

export function applyArchitectureEdgelessInteraction(
  context: ToolbarContext,
  state: NonNullable<ReturnType<typeof architectureOwnerForSelection>>,
  mutation: ArchitectureInteractionResolution,
) {
  if (!mutation.changed) return mutation.diagnostic;
  let diagnostic: string | undefined;
  const applied = runArchitectureMutation(context, state.owner, () => {
    const [, result] = context.command.exec(applyMermaidVisualModelCommand, {
      model: state.owner,
      visualModel: mutation.visualModel,
    });
    diagnostic = result?.diagnostic;
    return result?.applied === true;
  });
  if (applied) {
    const selection = architectureVisualSelectionAfter(
      mutation.visualModel,
      mutation.selectionAfter,
    );
    const model =
      selection?.kind === "node"
        ? getMermaidGfxNode(context.store, state.projection.model, selection.id)
        : selection?.kind === "subgraph"
          ? getMermaidGfxSubgraph(
              context.store,
              state.projection.model,
              selection.id,
            )
          : selection?.kind === "edge"
            ? getMermaidGfxConnector(
                context.store,
                state.projection.model,
                selection.id,
              )
            : null;
    selectArchitectureElement(context, model?.id);
  }
  return applied
    ? null
    : diagnostic || mermaidMessages.architectureInvalidProperties();
}

export function selectArchitectureElement(
  context: ToolbarContext,
  elementId: string | undefined,
) {
  if (elementId) {
    context.gfx.selection.set({ editing: false, elements: [elementId] });
  }
}

export function architectureSelection(
  context: ToolbarContext,
  state: NonNullable<ReturnType<typeof architectureOwnerForSelection>>,
) {
  const selected = selectedArchitectureModels(context);
  if (selected.length !== 1) return null;
  const model = selected[0];
  const nodeId = readMermaidGfxNodeId(model);
  const edgeId = readMermaidGfxEdgeId(model);
  const subgraphId = readMermaidGfxSubgraphId(model);
  const selectedNode = state.visualModel.nodes.find(
    (candidate) => candidate.id === nodeId,
  );
  const selectedEdge = state.visualModel.edges.find(
    (candidate) => candidate.id === edgeId,
  );
  const selectedSubgraph = state.visualModel.subgraphs?.find(
    (candidate) => candidate.id === subgraphId,
  );
  if (!selectedNode && !selectedEdge && !selectedSubgraph) return null;
  return {
    edgeId: selectedEdge?.id,
    nodeId: selectedNode?.id,
    subgraphId: selectedSubgraph?.id,
  };
}

export function architectureSelectionDescriptor(context: ToolbarContext) {
  const selected = selectedArchitectureModels(context);
  const edgeIds = selected
    .map(readMermaidGfxEdgeId)
    .filter((id): id is string => Boolean(id));
  const nodeIds = selected
    .map(readMermaidGfxNodeId)
    .filter((id): id is string => Boolean(id));
  const subgraphIds = selected
    .map(readMermaidGfxSubgraphId)
    .filter((id): id is string => Boolean(id));
  return edgeIds.length || nodeIds.length || subgraphIds.length
    ? { edgeIds, nodeIds, subgraphIds }
    : null;
}
