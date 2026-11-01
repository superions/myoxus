// SPDX-License-Identifier: AGPL-3.0-or-later

import { EdgelessCRUDIdentifier } from "@virgultum/block-surface";
import { Bound } from "@virgultum/global/gfx";
import type { MermaidBlockModel } from "@virgultum/model";
import type { Command } from "@virgultum/std";
import type { GfxModel } from "@virgultum/std/gfx";

import {
  addMermaidProjectionOwnerChild,
  applyMermaidVisualModelCommand,
  assignGfxProps,
  finishMermaidGfxMutation,
  getMermaidVisualElementOriginBound,
  getMermaidGfxConnector,
  getMermaidGfxElementIdMap,
  getMermaidGfxNode,
  getMermaidGfxSubgraph,
  getMermaidVisualModel,
  readMermaidVisualModelFromProjectionGroup,
  resolveMermaidProjectionGroup,
  type MermaidGfxMutationResult,
} from "../../commands.js";
import {
  resolveMermaidConnectorLabelXYWH,
  semanticMermaidEdgeLabelPlacementForEndpoints,
  toMermaidConnectorElementProps,
} from "./gfx-element-projection.js";
import type {
  MermaidVisualModel,
  MermaidVisualEdge,
  MermaidVisualSemanticStyle,
} from "./gfx-model.js";
import {
  canConnectMermaidGfxVisualNodes,
  createMermaidGfxVisualEdge,
  reconnectMermaidGfxVisualEdge,
} from "./gfx-graph-operations.js";
import type { MermaidVisualEdgeLinkType } from "./gfx-model.js";
import { mermaidGfxEdgeLabelOffset } from "./gfx-element-projection.js";
import { getMermaidGfxFamilyHooks } from "./gfx-family-hooks-registry.js";
import {
  usesTypeOwnedMermaidDocumentHistory,
  typeOwnedMermaidConnectionTargetsIncludeSubgraphs,
  typeOwnedMermaidEdgeElementProjection,
  typeOwnedMermaidEdgeSemanticStyleProps,
} from "./gfx-owner-hooks.js";

/** Source-owned families commit the checked edge and Source atomically. */
function commitDocumentHistoryEdge(
  ctx: Parameters<Command>[0] & { model: MermaidBlockModel },
  visualModel: MermaidVisualModel,
  next: (result: MermaidGfxMutationResult) => void,
) {
  if (!usesTypeOwnedMermaidDocumentHistory(visualModel.diagramType))
    return false;
  applyMermaidVisualModelCommand({ ...ctx, visualModel }, (result) => {
    if (result?.applied && result.sourceHash)
      next({
        sourceHash: result.sourceHash,
        visualModelHash: result.visualModelHash ?? null,
      });
  });
  return true;
}

function edgeStyleForLinkType(
  linkType: MermaidVisualEdgeLinkType,
): MermaidVisualEdge["style"] {
  if (linkType === "dotted") return "dotted";
  if (linkType === "thick") return "thick";
  return "solid";
}

export const addMermaidGfxEdgeCommand: Command<
  {
    model: MermaidBlockModel;
    sourcePortId?: string;
    sourcePosition?: MermaidVisualEdge["sourcePosition"];
    sourceNodeId: string;
    targetPortId?: string;
    targetPosition?: MermaidVisualEdge["targetPosition"];
    targetNodeId: string;
  },
  MermaidGfxMutationResult & { edgeId: string }
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
  if (
    !canConnectMermaidGfxVisualNodes(
      currentModel,
      ctx.sourceNodeId,
      ctx.targetNodeId,
    )
  ) {
    return;
  }
  const edge = createMermaidGfxVisualEdge(
    currentModel,
    ctx.sourceNodeId,
    ctx.targetNodeId,
    {
      sourcePortId: ctx.sourcePortId,
      sourcePosition: ctx.sourcePosition,
      targetPortId: ctx.targetPortId,
      targetPosition: ctx.targetPosition,
    },
  );
  if (!edge) return;
  if (
    commitDocumentHistoryEdge(
      ctx,
      { ...currentModel, edges: [...currentModel.edges, edge] },
      (result) => next({ ...result, edgeId: edge.id }),
    )
  )
    return;
  const idMap = getMermaidGfxElementIdMap(ctx.std.store, projectionOwner);
  const elementProjection = typeOwnedMermaidEdgeElementProjection(
    currentModel,
    edge,
    currentModel.edges.length,
  );
  const props = toMermaidConnectorElementProps(
    edge,
    idMap,
    resolveMermaidConnectorLabelXYWH({
      edge,
      elementProjection,
      ownerBound: getMermaidVisualElementOriginBound(
        currentModel,
        Bound.deserialize(projectionOwner.xywh),
      ),
      labelOffset: mermaidGfxEdgeLabelOffset(currentModel, edge),
      visualModel: currentModel,
    }),
    elementProjection,
  );
  const crud = ctx.std.get(EdgelessCRUDIdentifier);

  ctx.std.store.captureSync();
  let addedConnector: GfxModel | null = null;
  ctx.std.store.transact(() => {
    const id = crud.addElement("connector", props);
    if (!id) return;
    addedConnector = projectionOwner.surface?.getElementById(
      id,
    ) as GfxModel | null;
    if (!addedConnector) return;
    assignGfxProps(addedConnector, props);
    addMermaidProjectionOwnerChild(projectionOwner, addedConnector);
  });
  if (!addedConnector) return;
  const result = finishMermaidGfxMutation(ctx, projectionOwner);
  ctx.std.store.captureSync();
  if (result) next({ ...result, edgeId: edge.id });
};

export const applyMermaidGfxEdgeCommand: Command<
  {
    edgeId: string;
    familyData?: MermaidVisualEdge["familyData"];
    label?: string;
    linkType?: MermaidVisualEdgeLinkType;
    model: MermaidBlockModel;
    sourcePosition?: MermaidVisualEdge["sourcePosition"];
    sourceAttachment?: string;
    style?: "dotted" | "solid" | "thick";
    targetPosition?: MermaidVisualEdge["targetPosition"];
    targetAttachment?: string;
    visualStyle?: MermaidVisualSemanticStyle | "";
  },
  MermaidGfxMutationResult
> = (ctx, next) => {
  const projectionOwner = resolveMermaidProjectionGroup(ctx.model);
  if (!projectionOwner) return;
  const connector = getMermaidGfxConnector(
    ctx.std.store,
    projectionOwner,
    ctx.edgeId,
  );
  if (!connector) return;
  const currentModel = readMermaidVisualModelFromProjectionGroup(
    ctx.std.store,
    projectionOwner,
    getMermaidVisualModel(ctx.model),
    ctx.model.props.diagramType,
  );
  const edgeIndex =
    currentModel?.edges.findIndex((candidate) => candidate.id === ctx.edgeId) ??
    -1;
  const edge = edgeIndex >= 0 ? currentModel?.edges[edgeIndex] : null;
  if (!currentModel || !edge) return;
  const linkType =
    ctx.linkType ??
    (ctx.style
      ? ctx.style === "dotted"
        ? "dotted"
        : ctx.style === "thick"
          ? "thick"
          : "arrow"
      : (edge.linkType ?? "arrow"));
  const sourcePosition = ctx.sourcePosition ?? edge.sourcePosition;
  const targetPosition = ctx.targetPosition ?? edge.targetPosition;
  const nextLabel = ctx.label === undefined ? edge.label : ctx.label.trim();
  const nextFamilyData = ctx.familyData ?? edge.familyData;
  const nextEdge: MermaidVisualEdge = {
    ...edge,
    displayLabel: nextLabel,
    familyData: nextFamilyData,
    label: nextLabel,
    labelPlacement:
      ctx.sourcePosition !== undefined || ctx.targetPosition !== undefined
        ? semanticMermaidEdgeLabelPlacementForEndpoints({
            sourcePosition,
            targetPosition,
          })
        : edge.labelPlacement,
    linkType,
    sourcePosition,
    sourceAttachment:
      ctx.sourceAttachment === undefined
        ? edge.sourceAttachment
        : ctx.sourceAttachment || undefined,
    style:
      ctx.style ?? (ctx.linkType ? edgeStyleForLinkType(linkType) : edge.style),
    targetPosition,
    targetAttachment:
      ctx.targetAttachment === undefined
        ? edge.targetAttachment
        : ctx.targetAttachment || undefined,
  };
  const projectedEdge =
    getMermaidGfxFamilyHooks(currentModel)?.patchEdge?.(
      currentModel,
      nextEdge,
      {
        ...(ctx.familyData === undefined ? {} : { familyData: nextFamilyData }),
        ...(ctx.label === undefined ? {} : { label: nextLabel }),
      },
    ) ?? nextEdge;
  if (
    commitDocumentHistoryEdge(
      ctx,
      {
        ...currentModel,
        edges: currentModel.edges.map((candidate) =>
          candidate.id === projectedEdge.id ? projectedEdge : candidate,
        ),
      },
      next,
    )
  )
    return;
  const idMap = getMermaidGfxElementIdMap(ctx.std.store, projectionOwner);
  const ownerBound = getMermaidVisualElementOriginBound(
    currentModel,
    Bound.deserialize(projectionOwner.xywh),
  );
  ctx.std.store.captureSync();
  ctx.std.store.transact(() => {
    const elementProjection = typeOwnedMermaidEdgeElementProjection(
      currentModel,
      projectedEdge,
      edgeIndex,
    );
    const props = toMermaidConnectorElementProps(
      projectedEdge,
      idMap,
      resolveMermaidConnectorLabelXYWH({
        edge: projectedEdge,
        elementProjection,
        ownerBound,
        labelOffset: mermaidGfxEdgeLabelOffset(currentModel, projectedEdge),
        visualModel: currentModel,
      }),
      elementProjection,
    );
    assignGfxProps(connector, {
      ...props,
      ...(ctx.visualStyle === undefined
        ? {}
        : typeOwnedMermaidEdgeSemanticStyleProps(
            currentModel,
            ctx.visualStyle,
          )),
    });
  });
  const result = finishMermaidGfxMutation(ctx, projectionOwner);
  ctx.std.store.captureSync();
  if (result) next(result);
};

export const reconnectMermaidGfxEdgeCommand: Command<
  {
    edgeId: string;
    endpoint: "source" | "target";
    model: MermaidBlockModel;
    nodeId: string;
    portId?: string;
    position?: MermaidVisualEdge["sourcePosition"];
  },
  MermaidGfxMutationResult
> = (ctx, next) => {
  const projectionOwner = resolveMermaidProjectionGroup(ctx.model);
  if (!projectionOwner) return;
  const connector = getMermaidGfxConnector(
    ctx.std.store,
    projectionOwner,
    ctx.edgeId,
  );
  if (!connector) return;
  const currentModel = readMermaidVisualModelFromProjectionGroup(
    ctx.std.store,
    projectionOwner,
    getMermaidVisualModel(ctx.model),
    ctx.model.props.diagramType,
  );
  const edge = currentModel?.edges.find(
    (candidate) => candidate.id === ctx.edgeId,
  );
  if (!currentModel || !edge) return;
  const nodeElement =
    getMermaidGfxNode(ctx.std.store, projectionOwner, ctx.nodeId) ??
    (typeOwnedMermaidConnectionTargetsIncludeSubgraphs(currentModel)
      ? getMermaidGfxSubgraph(ctx.std.store, projectionOwner, ctx.nodeId)
      : null);
  if (!nodeElement) return;
  const nextEdge = reconnectMermaidGfxVisualEdge(
    currentModel,
    edge,
    ctx.endpoint,
    ctx.nodeId,
    { portId: ctx.portId, position: ctx.position },
  );
  if (!nextEdge) return;
  if (
    commitDocumentHistoryEdge(
      ctx,
      {
        ...currentModel,
        edges: currentModel.edges.map((candidate) =>
          candidate.id === nextEdge.id ? nextEdge : candidate,
        ),
      },
      next,
    )
  )
    return;
  const idMap = getMermaidGfxElementIdMap(ctx.std.store, projectionOwner);
  const ownerBound = getMermaidVisualElementOriginBound(
    currentModel,
    Bound.deserialize(projectionOwner.xywh),
  );

  ctx.std.store.captureSync();
  ctx.std.store.transact(() => {
    const elementProjection = typeOwnedMermaidEdgeElementProjection(
      currentModel,
      nextEdge,
      currentModel.edges.findIndex((candidate) => candidate.id === edge.id),
    );
    assignGfxProps(
      connector,
      toMermaidConnectorElementProps(
        nextEdge,
        idMap,
        resolveMermaidConnectorLabelXYWH({
          edge: nextEdge,
          elementProjection,
          ownerBound,
          labelOffset: mermaidGfxEdgeLabelOffset(currentModel, nextEdge),
          visualModel: currentModel,
        }),
        elementProjection,
      ),
    );
  });
  const result = finishMermaidGfxMutation(ctx, projectionOwner);
  ctx.std.store.captureSync();
  if (result) next(result);
};
