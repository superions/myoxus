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
  getMermaidVisualModel,
  resizeMermaidProjectionOwnerToVisualModel,
  updateMermaidElementsInPlaceIfCompatible,
  readMermaidVisualModelFromProjectionGroup,
  resolveMermaidProjectionGroup,
  visualNodeWithDiagramDetails,
  type MermaidGfxMutationResult,
} from "../../commands.js";
import { toMermaidShapeElementProps } from "./gfx-element-projection.js";
import {
  createMermaidGfxModelHash,
  type MermaidVisualModel,
  type MermaidVisualNode,
  type MermaidVisualNodeShape,
  type MermaidVisualSemanticStyle,
} from "./gfx-model.js";
import { normalizeMermaidGfxVisualNodeDimensions } from "./gfx-graph-operations.js";
import {
  addMermaidVisualNode,
  visualNodeWithLabel,
} from "../../mermaid-visual-model-operations.js";
import {
  isTypeOwnedMermaidProjectionOnlyNodeMutation,
  typeOwnedMermaidNodeElementProjection,
  typeOwnedMermaidNodeDimensionsAreValid,
  typeOwnedMermaidNodeMutationIsValid,
  typeOwnedMermaidNodeSemanticStyleProps,
  usesGenericMermaidNodeShapeMinimums,
} from "./gfx-owner-hooks.js";

export const applyMermaidGfxNodeCommand: Command<
  {
    displayLabel?: string;
    familyData?: MermaidVisualNode["familyData"];
    height?: number;
    label?: string;
    labelEditable?: boolean;
    model: MermaidBlockModel;
    nodeId: string;
    projectionOnly?: boolean;
    details?: MermaidVisualNode["details"];
    shape?: MermaidVisualNodeShape;
    styleClass?: MermaidVisualSemanticStyle | "";
    textAlign?: MermaidVisualNode["textAlign"];
    textVerticalAlign?: MermaidVisualNode["textVerticalAlign"];
    translate?: { dx: number; dy: number };
    width?: number;
  },
  MermaidGfxMutationResult
> = (ctx, next) => {
  const projectionOwner = resolveMermaidProjectionGroup(ctx.model);
  if (!projectionOwner) return;
  const nodeElement = getMermaidGfxNode(
    ctx.std.store,
    projectionOwner,
    ctx.nodeId,
  );
  if (!nodeElement) return;
  const currentModel = readMermaidVisualModelFromProjectionGroup(
    ctx.std.store,
    projectionOwner,
    getMermaidVisualModel(ctx.model),
    ctx.model.props.diagramType,
  );
  const node = currentModel?.nodes.find(
    (candidate) => candidate.id === ctx.nodeId,
  );
  if (!currentModel || !node) return;
  if (
    !typeOwnedMermaidNodeMutationIsValid(
      currentModel,
      ctx as unknown as Record<string, unknown>,
    )
  ) {
    return;
  }
  const numericMutationValues = [
    ctx.height,
    ctx.width,
    ctx.translate?.dx,
    ctx.translate?.dy,
  ].filter((value): value is number => value !== undefined);
  if (
    numericMutationValues.some((value) => !Number.isFinite(value)) ||
    !typeOwnedMermaidNodeDimensionsAreValid(currentModel, ctx.height, ctx.width)
  ) {
    return;
  }
  const labelledNode = visualNodeWithLabel(
    node,
    ctx.label === undefined ? node.label : ctx.label,
  );
  const nextNode: MermaidVisualNode = {
    ...labelledNode,
    details: ctx.details ?? node.details,
    displayLabel:
      ctx.displayLabel === undefined
        ? labelledNode.displayLabel
        : ctx.displayLabel,
    familyData: ctx.familyData ?? node.familyData,
    height: ctx.height ?? node.height,
    labelEditable: ctx.labelEditable ?? node.labelEditable,
    textAlign: ctx.textAlign ?? node.textAlign,
    textVerticalAlign: ctx.textVerticalAlign ?? node.textVerticalAlign,
    shape: ctx.shape ?? node.shape,
    width: ctx.width ?? node.width,
    x: node.x + (ctx.translate?.dx ?? 0),
    y: node.y + (ctx.translate?.dy ?? 0),
  };
  if (ctx.shape && usesGenericMermaidNodeShapeMinimums(currentModel)) {
    nextNode.height = Math.max(
      ctx.shape === "diamond" ? 104 : 64,
      nextNode.height,
    );
    nextNode.width = Math.max(
      ctx.shape === "diamond" ? 140 : 120,
      nextNode.width,
    );
  }
  const projectedNode = visualNodeWithDiagramDetails(
    normalizeMermaidGfxVisualNodeDimensions(currentModel, nextNode),
    currentModel.diagramType,
  );
  const nextModel: MermaidVisualModel = {
    ...currentModel,
    nodes: currentModel.nodes.map((candidate) =>
      candidate.id === projectedNode.id ? projectedNode : candidate,
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
      const props = toMermaidShapeElementProps(
        projectedNode,
        elementOriginBound,
        currentModel.direction,
        currentModel.diagramTitle,
        typeOwnedMermaidNodeElementProjection(currentModel, projectedNode),
      );
      assignGfxProps(nodeElement, props);
    }
    if (ctx.styleClass !== undefined) {
      const nextNodeElement =
        getMermaidGfxNode(ctx.std.store, projectionOwner, ctx.nodeId) ??
        nodeElement;
      assignGfxProps(
        nextNodeElement,
        typeOwnedMermaidNodeSemanticStyleProps(currentModel, ctx.styleClass),
      );
    }
  });
  const result = isTypeOwnedMermaidProjectionOnlyNodeMutation(
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

export const addMermaidGfxNodeCommand: Command<
  {
    centerX?: number;
    centerY?: number;
    model: MermaidBlockModel;
    shape?: MermaidVisualNodeShape;
  },
  MermaidGfxMutationResult & { nodeId: string }
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
  const placement =
    Number.isFinite(ctx.centerX) && Number.isFinite(ctx.centerY)
      ? { centerX: ctx.centerX!, centerY: ctx.centerY! }
      : undefined;
  const nextModel = addMermaidVisualNode(currentModel, ctx.shape, placement);
  const node = nextModel.nodes.at(-1);
  if (!node) return;
  const crud = ctx.std.get(EdgelessCRUDIdentifier);

  ctx.std.store.captureSync();
  let addedNode: GfxModel | null = null;
  ctx.std.store.transact(() => {
    const ownerBound = resizeMermaidProjectionOwnerToVisualModel(
      projectionOwner,
      nextModel,
      currentModel,
    );
    const elementOriginBound = getMermaidVisualElementOriginBound(
      nextModel,
      ownerBound,
    );
    const id = crud.addElement(
      "shape",
      toMermaidShapeElementProps(
        node,
        elementOriginBound,
        nextModel.direction,
        nextModel.diagramTitle,
        typeOwnedMermaidNodeElementProjection(nextModel, node),
      ),
    );
    if (!id) return;
    addedNode = projectionOwner.surface?.getElementById(id) as GfxModel | null;
    if (!addedNode) return;
    assignGfxProps(
      addedNode,
      toMermaidShapeElementProps(
        node,
        elementOriginBound,
        nextModel.direction,
        nextModel.diagramTitle,
        typeOwnedMermaidNodeElementProjection(nextModel, node),
      ),
    );
    addMermaidProjectionOwnerChild(projectionOwner, addedNode);
  });
  if (!addedNode) return;
  const result = finishMermaidGfxMutation(ctx, projectionOwner);
  ctx.std.store.captureSync();
  if (result) next({ ...result, nodeId: node.id });
};
