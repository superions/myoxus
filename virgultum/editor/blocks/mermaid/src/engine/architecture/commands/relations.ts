// SPDX-License-Identifier: AGPL-3.0-or-later

import { architectureStableStatementId } from "../grammar.js";
import type { MermaidArchitectureModel } from "../model.js";
import {
  architectureCommandResult,
  architectureNodeGroupId,
  cloneArchitectureModel,
  refreshArchitectureSourceAnnotations,
  unchangedArchitectureCommand,
} from "./shared.js";

type MermaidArchitectureEdgePatch = Partial<
  Pick<
    MermaidArchitectureModel["edges"][number],
    | "from"
    | "fromArrow"
    | "fromGroup"
    | "fromPort"
    | "label"
    | "to"
    | "toArrow"
    | "toGroup"
    | "toPort"
  >
>;

function architectureEdgeCandidateIsValid(
  model: MermaidArchitectureModel,
  edge: MermaidArchitectureModel["edges"][number],
) {
  const nodeIds = new Set([
    ...model.services.map(({ id }) => id),
    ...model.junctions.map(({ id }) => id),
  ]);
  if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
    return "architecture.edge-endpoint-not-found";
  }
  if (!/^[RLTB]$/.test(edge.fromPort) || !/^[RLTB]$/.test(edge.toPort)) {
    return "architecture.edge-port-invalid";
  }
  const fromGroupId = architectureNodeGroupId(model, edge.from);
  const toGroupId = architectureNodeGroupId(model, edge.to);
  if (
    (edge.fromGroup || edge.toGroup) &&
    Boolean(fromGroupId) &&
    fromGroupId === toGroupId
  ) {
    return "architecture.edge-group-endpoint-invalid";
  }
  return null;
}

export function renameMermaidArchitectureEdge(
  model: MermaidArchitectureModel,
  edgeId: string,
  label: string,
) {
  return updateMermaidArchitectureEdge(
    model,
    edgeId,
    {
      label: label.trim(),
    },
    "edge-label",
  );
}

export function addMermaidArchitectureEdge(
  model: MermaidArchitectureModel,
  from: string,
  to: string,
  {
    fromArrow = false,
    fromGroup = false,
    fromPort = "R",
    label = "",
    toArrow = true,
    toGroup = false,
    toPort = "L",
  }: {
    fromArrow?: boolean;
    fromGroup?: boolean;
    fromPort?: string;
    label?: string;
    toArrow?: boolean;
    toGroup?: boolean;
    toPort?: string;
  } = {},
) {
  const selectionAfter = { kind: "diagram" } as const;
  const edgeIds = new Set(model.edges.map(({ id }) => id));
  let occurrence =
    model.edges.filter((edge) => edge.from === from && edge.to === to).length +
    1;
  let id = architectureStableStatementId("edge", `${from}\n${to}`, occurrence);
  while (edgeIds.has(id)) {
    occurrence += 1;
    id = architectureStableStatementId("edge", `${from}\n${to}`, occurrence);
  }
  const edge = {
    from,
    fromArrow,
    fromGroup,
    fromPort,
    id,
    label: label.trim(),
    order: model.edges.length,
    to,
    toArrow,
    toGroup,
    toPort,
  };
  const diagnosis = architectureEdgeCandidateIsValid(model, edge);
  if (diagnosis) {
    return unchangedArchitectureCommand(
      model,
      selectionAfter,
      "canvas",
      diagnosis,
    );
  }
  const next = cloneArchitectureModel(model);
  next.edges.push(edge);
  return architectureCommandResult(
    next,
    true,
    { id: edge.id, kind: "edge" },
    "canvas",
  );
}

export function updateMermaidArchitectureEdge(
  model: MermaidArchitectureModel,
  edgeId: string,
  patch: MermaidArchitectureEdgePatch,
  focusAfter: "canvas" | "edge-label" = "canvas",
) {
  const selection = { id: edgeId, kind: "edge" } as const;
  const edge = model.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) {
    return unchangedArchitectureCommand(
      model,
      selection,
      focusAfter,
      "architecture.edge-not-found",
    );
  }
  const candidate = { ...edge, ...patch };
  const diagnosis = architectureEdgeCandidateIsValid(model, candidate);
  if (diagnosis) {
    return unchangedArchitectureCommand(
      model,
      selection,
      focusAfter,
      diagnosis,
    );
  }
  const next = cloneArchitectureModel(model);
  Object.assign(
    next.edges.find((candidate) => candidate.id === edgeId)!,
    patch,
  );
  const changed = JSON.stringify(next) !== JSON.stringify(model);
  return changed
    ? architectureCommandResult(next, true, selection, focusAfter)
    : unchangedArchitectureCommand(
        model,
        selection,
        focusAfter,
        "architecture.no-change",
      );
}

export function deleteMermaidArchitectureEdge(
  model: MermaidArchitectureModel,
  edgeId: string,
) {
  if (!model.edges.some(({ id }) => id === edgeId)) {
    return unchangedArchitectureCommand(
      model,
      { kind: "diagram" },
      "canvas",
      "architecture.edge-not-found",
    );
  }
  const next = cloneArchitectureModel(model);
  const removedCommentIds = (next.comments ?? [])
    .filter(
      (comment) => comment.anchorKind === "edge" && comment.anchorId === edgeId,
    )
    .map(({ id }) => id);
  const removedCommentIdSet = new Set(removedCommentIds);
  next.edges = next.edges.filter(({ id }) => id !== edgeId);
  next.comments = (next.comments ?? []).filter(
    (comment) => !removedCommentIdSet.has(comment.id),
  );
  refreshArchitectureSourceAnnotations(next);
  return architectureCommandResult(
    next,
    true,
    { kind: "diagram" },
    "canvas",
    undefined,
    { removedCommentIds, removedEdgeIds: [edgeId] },
  );
}
