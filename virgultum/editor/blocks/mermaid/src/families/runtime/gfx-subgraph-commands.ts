// SPDX-License-Identifier: AGPL-3.0-or-later

import { EdgelessCRUDIdentifier } from "@virgultum/block-surface";
import type { MermaidBlockModel } from "@virgultum/model";
import type { Command } from "@virgultum/std";
import type { GfxModel } from "@virgultum/std/gfx";

import {
  addMermaidProjectionOwnerChild,
  assignGfxProps,
  finishMermaidGfxMutation,
  getMermaidVisualElementOriginBound,
  getMermaidGfxNode,
  getMermaidGfxSubgraph,
  getMermaidVisualModel,
  resizeMermaidProjectionOwnerToVisualModel,
  updateMermaidElementsInPlaceIfCompatible,
  readMermaidVisualModelFromProjectionGroup,
  resolveMermaidProjectionGroup,
  type MermaidGfxMutationResult,
} from "../../commands.js";
import {
  toMermaidShapeElementProps,
  toMermaidSubgraphElementProps,
} from "./gfx-element-projection.js";
import {
  createMermaidGfxModelHash,
  type MermaidVisualModel,
  type MermaidVisualSubgraph,
} from "./gfx-model.js";
import { addMermaidVisualSubgraph } from "../../mermaid-visual-model-operations.js";
import {
  isTypeOwnedMermaidProjectionOnlySubgraphMutation,
  typeOwnedMermaidNodeElementProjection,
  typeOwnedMermaidDescendantSubgraphIds,
  typeOwnedMermaidSubgraphDimension,
  typeOwnedMermaidSubgraphDimensionsAreValid,
  typeOwnedMermaidSubgraphMutationIsValid,
  typeOwnedMermaidSubgraphElementProjection,
} from "./gfx-owner-hooks.js";

export const addMermaidGfxSubgraphCommand: Command<
  { model: MermaidBlockModel; selectedNodeIds: readonly string[] },
  MermaidGfxMutationResult & { subgraphId: string }
> = (ctx, next) => {
  const projectionOwner = resolveMermaidProjectionGroup(ctx.model);
  if (!projectionOwner) return;
  const currentModel = readMermaidVisualModelFromProjectionGroup(
    ctx.std.store,
    projectionOwner,
    getMermaidVisualModel(ctx.model),
    ctx.model.props.diagramType,
  );
  if (!currentModel) return;
  const previousSubgraphIds = new Set(
    (currentModel.subgraphs ?? []).map(({ id }) => id),
  );
  const nextModel = addMermaidVisualSubgraph(currentModel, ctx.selectedNodeIds);
  const subgraph = nextModel.subgraphs?.find(
    ({ id }) => !previousSubgraphIds.has(id),
  );
  if (!subgraph) return;
  const crud = ctx.std.get(EdgelessCRUDIdentifier);

  ctx.std.store.captureSync();
  let addedSubgraph: GfxModel | null = null;
  ctx.std.store.transact(() => {
    const resizedFrameBound = resizeMermaidProjectionOwnerToVisualModel(
      projectionOwner,
      nextModel,
      currentModel,
    );
    const elementOriginBound = getMermaidVisualElementOriginBound(
      nextModel,
      resizedFrameBound,
    );
    const props = toMermaidSubgraphElementProps(
      subgraph,
      elementOriginBound,
      typeOwnedMermaidSubgraphElementProjection(nextModel, subgraph),
    );
    const id = crud.addElement("shape", props);
    if (!id) return;
    addedSubgraph = projectionOwner.surface?.getElementById(
      id,
    ) as GfxModel | null;
    if (!addedSubgraph) return;
    assignGfxProps(addedSubgraph, props);
    addMermaidProjectionOwnerChild(projectionOwner, addedSubgraph);
    if (
      !updateMermaidElementsInPlaceIfCompatible({
        ctx,
        projectionOwner,
        ownerBound: resizedFrameBound,
        visualModel: nextModel,
      })
    ) {
      throw new Error("Failed to materialize Mermaid subgraph mutation.");
    }
  });
  if (!addedSubgraph) return;
  const result = finishMermaidGfxMutation(ctx, projectionOwner, nextModel);
  ctx.std.store.captureSync();
  if (result) next({ ...result, subgraphId: subgraph.id });
};

export const applyMermaidGfxSubgraphCommand: Command<
  {
    familyData?: MermaidVisualSubgraph["familyData"];
    direction?: MermaidVisualSubgraph["direction"];
    height?: number;
    model: MermaidBlockModel;
    moveMembers?: boolean;
    projectionOnly?: boolean;
    subgraphId: string;
    title?: string;
    width?: number;
    x?: number;
    y?: number;
  },
  MermaidGfxMutationResult
> = (ctx, next) => {
  const projectionOwner = resolveMermaidProjectionGroup(ctx.model);
  if (!projectionOwner) return;
  const subgraphElement = getMermaidGfxSubgraph(
    ctx.std.store,
    projectionOwner,
    ctx.subgraphId,
  );
  if (!subgraphElement) return;
  const currentModel = readMermaidVisualModelFromProjectionGroup(
    ctx.std.store,
    projectionOwner,
    getMermaidVisualModel(ctx.model),
    ctx.model.props.diagramType,
  );
  const subgraph = currentModel?.subgraphs?.find(
    (candidate) => candidate.id === ctx.subgraphId,
  );
  if (!currentModel || !subgraph) return;
  if (
    !typeOwnedMermaidSubgraphMutationIsValid(
      currentModel,
      ctx as unknown as Record<string, unknown>,
    )
  ) {
    return;
  }
  const numericMutationValues = [ctx.height, ctx.width, ctx.x, ctx.y].filter(
    (value): value is number => value !== undefined,
  );
  if (
    numericMutationValues.some((value) => !Number.isFinite(value)) ||
    !typeOwnedMermaidSubgraphDimensionsAreValid(
      currentModel,
      ctx.height,
      ctx.width,
    )
  ) {
    return;
  }
  const nextSubgraph: MermaidVisualSubgraph = {
    ...subgraph,
    direction: ctx.direction ?? subgraph.direction,
    height:
      ctx.height === undefined
        ? subgraph.height
        : (typeOwnedMermaidSubgraphDimension(currentModel, ctx.height) ??
          Math.max(120, Math.round(ctx.height))),
    title:
      ctx.title === undefined
        ? subgraph.title
        : ctx.title.trim() || subgraph.id,
    width:
      ctx.width === undefined
        ? subgraph.width
        : (typeOwnedMermaidSubgraphDimension(currentModel, ctx.width) ??
          Math.max(180, Math.round(ctx.width))),
    x: ctx.x === undefined ? subgraph.x : Math.round(ctx.x),
    y: ctx.y === undefined ? subgraph.y : Math.round(ctx.y),
    familyData: ctx.familyData ?? subgraph.familyData,
  };
  const moveMembers =
    ctx.moveMembers === true &&
    (nextSubgraph.x !== subgraph.x || nextSubgraph.y !== subgraph.y);
  const memberDelta = {
    x: nextSubgraph.x - subgraph.x,
    y: nextSubgraph.y - subgraph.y,
  };
  const typeOwnedDescendantIds = typeOwnedMermaidDescendantSubgraphIds(
    currentModel,
    subgraph.id,
  );
  const nestedSubgraphs = moveMembers
    ? (currentModel.subgraphs ?? []).filter((candidate) =>
        typeOwnedDescendantIds
          ? typeOwnedDescendantIds.has(candidate.id)
          : candidate.id !== subgraph.id &&
            candidate.x >= subgraph.x &&
            candidate.y >= subgraph.y &&
            candidate.x + candidate.width <= subgraph.x + subgraph.width &&
            candidate.y + candidate.height <= subgraph.y + subgraph.height,
      )
    : [];
  const movedSubgraphs = nestedSubgraphs.map((candidate) => ({
    ...candidate,
    x: candidate.x + memberDelta.x,
    y: candidate.y + memberDelta.y,
  }));
  const movedSubgraphsById = new Map(
    movedSubgraphs.map((candidate) => [candidate.id, candidate]),
  );
  const movedMemberIds = new Set([
    ...subgraph.nodeIds,
    ...nestedSubgraphs.flatMap((candidate) => candidate.nodeIds),
  ]);
  const movedNodes =
    moveMembers && movedMemberIds.size > 0
      ? currentModel.nodes
          .filter((node) => movedMemberIds.has(node.id))
          .map((node) => ({
            ...node,
            x: node.x + memberDelta.x,
            y: node.y + memberDelta.y,
          }))
      : [];
  const movedNodesById = new Map(movedNodes.map((node) => [node.id, node]));
  const nextModel: MermaidVisualModel = {
    ...currentModel,
    nodes:
      movedNodesById.size > 0
        ? currentModel.nodes.map((node) => movedNodesById.get(node.id) ?? node)
        : currentModel.nodes,
    subgraphs: (currentModel.subgraphs ?? []).map((candidate) =>
      candidate.id === nextSubgraph.id
        ? nextSubgraph
        : (movedSubgraphsById.get(candidate.id) ?? candidate),
    ),
  };
  ctx.std.store.captureSync();
  ctx.std.store.transact(() => {
    const resizedFrameBound = resizeMermaidProjectionOwnerToVisualModel(
      projectionOwner,
      nextModel,
      currentModel,
    );
    const elementOriginBound = getMermaidVisualElementOriginBound(
      nextModel,
      resizedFrameBound,
    );
    const updatedInPlace = updateMermaidElementsInPlaceIfCompatible({
      ctx,
      projectionOwner,
      ownerBound: resizedFrameBound,
      visualModel: nextModel,
    });
    if (!updatedInPlace) {
      assignGfxProps(
        subgraphElement,
        toMermaidSubgraphElementProps(
          nextSubgraph,
          elementOriginBound,
          typeOwnedMermaidSubgraphElementProjection(nextModel, nextSubgraph),
        ),
      );
      for (const movedSubgraph of movedSubgraphs) {
        const movedSubgraphElement = getMermaidGfxSubgraph(
          ctx.std.store,
          projectionOwner,
          movedSubgraph.id,
        );
        if (!movedSubgraphElement) continue;
        assignGfxProps(
          movedSubgraphElement,
          toMermaidSubgraphElementProps(
            movedSubgraph,
            elementOriginBound,
            typeOwnedMermaidSubgraphElementProjection(nextModel, movedSubgraph),
          ),
        );
      }
      for (const node of movedNodes) {
        const nodeElement = getMermaidGfxNode(
          ctx.std.store,
          projectionOwner,
          node.id,
        );
        if (!nodeElement) continue;
        assignGfxProps(
          nodeElement,
          toMermaidShapeElementProps(
            node,
            elementOriginBound,
            currentModel.direction,
            currentModel.diagramTitle,
            typeOwnedMermaidNodeElementProjection(nextModel, node),
          ),
        );
      }
    }
  });
  const result = isTypeOwnedMermaidProjectionOnlySubgraphMutation(
    currentModel,
    ctx as unknown as Record<string, unknown>,
  )
    ? {
        sourceHash: ctx.model.props.sourceHash,
        visualModelHash: createMermaidGfxModelHash(currentModel),
      }
    : finishMermaidGfxMutation(ctx, projectionOwner);
  ctx.std.store.captureSync();
  if (result) next(result);
};
