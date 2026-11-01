// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidArchitectureCommandResult,
  MermaidArchitectureModel,
} from "../../../engine/architecture/index.js";
import type { MermaidVisualModel } from "../../runtime/gfx-model.js";
import {
  architectureNodeFamilyData,
  architectureNodeGfxData,
  architectureSubgraphFamilyData,
  architectureSubgraphGfxData,
} from "../gfx-data.js";
import { fitArchitectureOwnerGroupsToDirectChildren } from "../owner-bounds.js";
import { architectureModelToGfxVisualModel } from "../visual-model.js";
import { reconcileArchitectureVisualProjection } from "../visual-reconciliation.js";
import type { MermaidArchitectureSelection } from "./semantic.js";

const ARCHITECTURE_NODE_PROJECTION_FIELDS = new Set([
  "height",
  "model",
  "nodeId",
  "projectionOnly",
  "std",
  "translate",
  "width",
]);

const ARCHITECTURE_NODE_MUTATION_FIELDS = new Set([
  ...ARCHITECTURE_NODE_PROJECTION_FIELDS,
  "details",
  "displayLabel",
  "familyData",
  "label",
  "labelEditable",
  "shape",
  "styleClass",
  "textAlign",
  "textVerticalAlign",
]);

const ARCHITECTURE_SUBGRAPH_PROJECTION_FIELDS = new Set([
  "height",
  "model",
  "moveMembers",
  "projectionOnly",
  "std",
  "subgraphId",
  "width",
  "x",
  "y",
]);

const ARCHITECTURE_SUBGRAPH_MUTATION_FIELDS = new Set([
  ...ARCHITECTURE_SUBGRAPH_PROJECTION_FIELDS,
  "direction",
  "familyData",
  "title",
]);

function hasOnlyArchitectureProjectionFields(
  mutation: Readonly<Record<string, unknown>>,
  fields: ReadonlySet<string>,
) {
  return Object.keys(mutation).every((key) => fields.has(key));
}

export function architectureNodeMutationIsValid(
  mutation: Readonly<Record<string, unknown>>,
) {
  return (
    hasOnlyArchitectureProjectionFields(
      mutation,
      ARCHITECTURE_NODE_MUTATION_FIELDS,
    ) &&
    (mutation.projectionOnly !== true ||
      architectureProjectionOnlyNodeMutation(mutation))
  );
}

export function architectureSubgraphMutationIsValid(
  mutation: Readonly<Record<string, unknown>>,
) {
  return (
    hasOnlyArchitectureProjectionFields(
      mutation,
      ARCHITECTURE_SUBGRAPH_MUTATION_FIELDS,
    ) &&
    (mutation.projectionOnly !== true ||
      architectureProjectionOnlySubgraphMutation(mutation))
  );
}

export function architectureProjectionOnlyNodeMutation(
  mutation: Readonly<Record<string, unknown>>,
) {
  return (
    (mutation.height !== undefined ||
      mutation.translate !== undefined ||
      mutation.width !== undefined) &&
    hasOnlyArchitectureProjectionFields(
      mutation,
      ARCHITECTURE_NODE_PROJECTION_FIELDS,
    )
  );
}

export function architectureProjectionOnlySubgraphMutation(
  mutation: Readonly<Record<string, unknown>>,
) {
  return (
    (mutation.height !== undefined ||
      mutation.width !== undefined ||
      mutation.x !== undefined ||
      mutation.y !== undefined) &&
    hasOnlyArchitectureProjectionFields(
      mutation,
      ARCHITECTURE_SUBGRAPH_PROJECTION_FIELDS,
    )
  );
}

function remapArchitectureSelectionIdentity(
  visualModel: MermaidVisualModel,
  selectionBefore: MermaidArchitectureSelection,
  selectionAfter: MermaidArchitectureCommandResult["selectionAfter"],
) {
  const previousId =
    selectionBefore.nodeId ?? selectionBefore.subgraphId ?? undefined;
  const nextId = selectionAfter.id;
  if (!previousId || !nextId || previousId === nextId) return visualModel;
  if (selectionAfter.kind === "service" || selectionAfter.kind === "junction") {
    return {
      ...visualModel,
      edges: visualModel.edges.map((edge) => ({
        ...edge,
        source: edge.source === previousId ? nextId : edge.source,
        target: edge.target === previousId ? nextId : edge.target,
      })),
      nodes: visualModel.nodes.map((node) => {
        if (node.id !== previousId) return node;
        const data = architectureNodeGfxData(node);
        return {
          ...node,
          familyData: data
            ? architectureNodeFamilyData({ ...data, sourceId: previousId })
            : node.familyData,
          id: nextId,
        };
      }),
      subgraphs: visualModel.subgraphs?.map((subgraph) => ({
        ...subgraph,
        nodeIds: subgraph.nodeIds.map((id) =>
          id === previousId ? nextId : id,
        ),
      })),
    };
  }
  if (selectionAfter.kind !== "group") return visualModel;
  return {
    ...visualModel,
    edges: visualModel.edges.map((edge) => ({
      ...edge,
      sourceAttachment:
        edge.sourceAttachment === previousId ? nextId : edge.sourceAttachment,
      targetAttachment:
        edge.targetAttachment === previousId ? nextId : edge.targetAttachment,
    })),
    nodes: visualModel.nodes.map((node) => {
      const data = architectureNodeGfxData(node);
      return data?.groupId === previousId
        ? {
            ...node,
            familyData: architectureNodeFamilyData({
              ...data,
              groupId: nextId,
            }),
          }
        : node;
    }),
    subgraphs: visualModel.subgraphs?.map((subgraph) => {
      const data = architectureSubgraphGfxData(subgraph);
      return {
        ...subgraph,
        ...(subgraph.id === previousId ? { id: nextId } : {}),
        familyData: data
          ? architectureSubgraphFamilyData({
              ...data,
              parentId: data.parentId === previousId ? nextId : data.parentId,
              sourceId: subgraph.id === previousId ? previousId : data.sourceId,
            })
          : subgraph.familyData,
      };
    }),
  };
}

/** Projects authoritative command output while retaining compatible user GFX. */
export function projectArchitectureSemanticCommand({
  model,
  preserveGeometry = true,
  selectionAfter,
  selectionBefore,
  visualModel,
}: {
  readonly model: MermaidArchitectureModel;
  readonly preserveGeometry?: boolean;
  readonly selectionAfter: MermaidArchitectureCommandResult["selectionAfter"];
  readonly selectionBefore: MermaidArchitectureSelection;
  readonly visualModel: MermaidVisualModel;
}) {
  if (visualModel.diagramType !== "architecture") return null;
  const parsed = architectureModelToGfxVisualModel(model);
  const identityMatched = remapArchitectureSelectionIdentity(
    visualModel,
    selectionBefore,
    selectionAfter,
  );
  const reconciled = reconcileArchitectureVisualProjection(
    parsed,
    identityMatched,
    {
      preserveGeometry,
    },
  );
  if (!reconciled) return fitArchitectureOwnerGroupsToDirectChildren(parsed);
  const previousId = selectionBefore.nodeId ?? selectionBefore.subgraphId;
  const nextId = selectionAfter.id;
  const pendingIdentity =
    previousId && nextId && previousId !== nextId
      ? {
          ...reconciled,
          nodes: reconciled.nodes.map((node) => {
            if (node.id !== nextId || !selectionBefore.nodeId) return node;
            const data = architectureNodeGfxData(node);
            return data
              ? {
                  ...node,
                  familyData: architectureNodeFamilyData({
                    ...data,
                    sourceId: previousId,
                  }),
                }
              : node;
          }),
          subgraphs: reconciled.subgraphs?.map((subgraph) => {
            if (subgraph.id !== nextId || !selectionBefore.subgraphId) {
              return subgraph;
            }
            const data = architectureSubgraphGfxData(subgraph);
            return data
              ? {
                  ...subgraph,
                  familyData: architectureSubgraphFamilyData({
                    ...data,
                    sourceId: previousId,
                  }),
                }
              : subgraph;
          }),
        }
      : reconciled;
  return fitArchitectureOwnerGroupsToDirectChildren(pendingIdentity);
}
