// SPDX-License-Identifier: AGPL-3.0-or-later

import { EdgelessCRUDIdentifier } from "@virgultum/block-surface";
import type { MermaidBlockModel } from "@virgultum/model";
import type { Command } from "@virgultum/std";
import type { GfxModel } from "@virgultum/std/gfx";

import {
  finishMermaidGfxMutation,
  getMermaidProjectionOwnerChildrenByRole,
  getMermaidProjectionOwnerChildrenByType,
  getMermaidGfxConnector,
  getMermaidGfxNode,
  getMermaidGfxSubgraph,
  getMermaidVisualModel,
  reconcileMermaidProjectionOwnerWithVisualModel,
  readMermaidVisualModelFromProjectionGroup,
  resolveMermaidProjectionGroup,
  type MermaidGfxMutationResult,
} from "../../commands.js";
import { MERMAID_GFX_DETAIL_ROLE } from "./gfx-element-roles.js";
import { readMermaidGfxMeta } from "../../mermaid-gfx-metadata.js";
import {
  deleteTypeOwnedMermaidGfxVisualSubgraph,
  resolveTypeOwnedMermaidGfxDeletionPlan,
} from "./gfx-graph-operations.js";
import { getMermaidVisualSelectionDeletedNodeIds } from "../../mermaid-visual-model-operations.js";

export const deleteMermaidGfxSelectionCommand: Command<
  {
    edgeId?: string;
    edgeIds?: readonly string[];
    model: MermaidBlockModel;
    nodeId?: string;
    nodeIds?: readonly string[];
    subgraphId?: string;
    subgraphIds?: readonly string[];
  },
  MermaidGfxMutationResult
> = (ctx, next) => {
  const projectionOwner = resolveMermaidProjectionGroup(ctx.model);
  if (!projectionOwner) return;
  const currentModel = readMermaidVisualModelFromProjectionGroup(
    ctx.std.store,
    projectionOwner,
    getMermaidVisualModel(ctx.model),
    ctx.model.props.diagramType,
  );
  const typeOwnedDeletionPlan = currentModel
    ? resolveTypeOwnedMermaidGfxDeletionPlan(currentModel, {
        edgeId: ctx.edgeId,
        edgeIds: ctx.edgeIds,
        nodeId: ctx.nodeId,
        nodeIds: ctx.nodeIds,
        subgraphId: ctx.subgraphId,
        subgraphIds: ctx.subgraphIds,
      })
    : null;
  if (typeOwnedDeletionPlan) {
    ctx.std.store.captureSync();
    ctx.std.store.transact(() => {
      reconcileMermaidProjectionOwnerWithVisualModel(
        ctx,
        projectionOwner,
        typeOwnedDeletionPlan.visualModel,
      );
    });
    // The remaining owner connectors must be read back against the
    // post-delete semantic model. Using the pre-delete block model here makes
    // the first surviving connector inherit the deleted connector's identity
    // when siblings share an endpoint (for example two Decision branches).
    const result = finishMermaidGfxMutation(
      ctx,
      projectionOwner,
      typeOwnedDeletionPlan.visualModel,
    );
    ctx.std.store.captureSync();
    if (result) next(result);
    return;
  }
  const typeOwnedSubgraphDeletion =
    ctx.subgraphId && currentModel
      ? deleteTypeOwnedMermaidGfxVisualSubgraph(currentModel, ctx.subgraphId)
      : null;
  if (typeOwnedSubgraphDeletion) {
    ctx.std.store.captureSync();
    ctx.std.store.transact(() => {
      reconcileMermaidProjectionOwnerWithVisualModel(
        ctx,
        projectionOwner,
        typeOwnedSubgraphDeletion,
      );
    });
    const result = finishMermaidGfxMutation(
      ctx,
      projectionOwner,
      typeOwnedSubgraphDeletion,
    );
    ctx.std.store.captureSync();
    if (result) next(result);
    return;
  }
  const crud = ctx.std.get(EdgelessCRUDIdentifier);
  const removals = new Set<GfxModel>();
  const removedEndpointElementIds = new Set<string>();
  const nodeIdsToRemove = currentModel
    ? getMermaidVisualSelectionDeletedNodeIds(currentModel, {
        edgeId: ctx.edgeId,
        nodeId: ctx.nodeId,
        nodeIds: ctx.nodeIds,
        subgraphId: ctx.subgraphId,
      })
    : new Set([...(ctx.nodeIds ?? []), ...(ctx.nodeId ? [ctx.nodeId] : [])]);
  for (const subgraphId of new Set([
    ...(ctx.subgraphIds ?? []),
    ...(ctx.subgraphId ? [ctx.subgraphId] : []),
  ])) {
    const subgraph = getMermaidGfxSubgraph(
      ctx.std.store,
      projectionOwner,
      subgraphId,
    );
    if (subgraph) {
      removals.add(subgraph);
      removedEndpointElementIds.add(subgraph.id);
    }
  }
  for (const edgeId of new Set([
    ...(ctx.edgeIds ?? []),
    ...(ctx.edgeId ? [ctx.edgeId] : []),
  ])) {
    const connector = getMermaidGfxConnector(
      ctx.std.store,
      projectionOwner,
      edgeId,
    );
    if (connector) removals.add(connector);
  }
  for (const nodeId of nodeIdsToRemove) {
    const node = getMermaidGfxNode(ctx.std.store, projectionOwner, nodeId);
    if (node) {
      removals.add(node);
      removedEndpointElementIds.add(node.id);
    }
    for (const detail of getMermaidProjectionOwnerChildrenByRole(
      ctx.std.store,
      projectionOwner,
      "shape",
      MERMAID_GFX_DETAIL_ROLE,
    )) {
      if (readMermaidGfxMeta(detail, "mermaidDetailOwnerNodeId") === nodeId) {
        removals.add(detail);
      }
    }
  }
  for (const connector of getMermaidProjectionOwnerChildrenByType(
    ctx.std.store,
    projectionOwner,
    "connector",
  )) {
    const raw = connector as unknown as {
      source?: { id?: string };
      target?: { id?: string };
    };
    if (
      (raw.source?.id && removedEndpointElementIds.has(raw.source.id)) ||
      (raw.target?.id && removedEndpointElementIds.has(raw.target.id))
    ) {
      removals.add(connector);
    }
  }
  if (removals.size === 0) return;

  ctx.std.store.captureSync();
  ctx.std.store.transact(() => {
    const models = [...removals];
    projectionOwner.removeChildren(models);
    for (const model of models.reverse()) {
      crud.removeElement(model.id);
    }
  });
  const result = finishMermaidGfxMutation(ctx, projectionOwner);
  ctx.std.store.captureSync();
  if (result) next(result);
};
