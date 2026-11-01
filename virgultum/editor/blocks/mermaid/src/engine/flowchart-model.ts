// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
} from "../families/runtime/gfx-family-data.js";
import type { MermaidVisualModel } from "../families/runtime/gfx-model.js";
import type { MermaidVisualDirection } from "../families/runtime/gfx-model.js";

export type MermaidFlowchartSyntax = "flowchart" | "flowchart-elk" | "graph";

export type PendingFlowchartSubgraph = {
  direction?: MermaidVisualDirection;
  id: string;
  nodeIds: Set<string>;
  parentId?: string;
  title: string;
};

export type MermaidFlowchartComment = {
  readonly anchorId?: string;
  readonly anchorKind: "diagram" | "edge" | "node" | "subgraph";
  readonly id: string;
  readonly line: string;
  readonly position: "after" | "before";
};

export type MermaidFlowchartModelData = {
  readonly comments: readonly MermaidFlowchartComment[];
  readonly syntax: MermaidFlowchartSyntax;
};

function validComment(value: unknown): value is MermaidFlowchartComment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const comment = value as Record<string, unknown>;
  return (
    typeof comment.id === "string" &&
    Boolean(comment.id) &&
    typeof comment.line === "string" &&
    /^%%(?:\s|$)/.test(comment.line) &&
    (comment.anchorKind === "diagram" ||
      comment.anchorKind === "edge" ||
      comment.anchorKind === "node" ||
      comment.anchorKind === "subgraph") &&
    (comment.anchorId === undefined || typeof comment.anchorId === "string") &&
    (comment.position === "after" || comment.position === "before")
  );
}

export function flowchartModelData(
  model: Pick<MermaidVisualModel, "familyData"> &
    Partial<Pick<MermaidVisualModel, "diagramType">>,
): MermaidFlowchartModelData {
  const payload = mermaidVisualFamilyPayload(model.familyData, "flowchart");
  const syntax = payload?.syntax;
  const comments = Array.isArray(payload?.comments)
    ? payload.comments.filter(validComment)
    : [];
  return {
    comments,
    syntax:
      syntax === "flowchart" || syntax === "flowchart-elk" || syntax === "graph"
        ? syntax
        : model.diagramType === "flowchart-elk"
          ? "flowchart-elk"
          : "flowchart",
  };
}

export function flowchartModelFamilyData(
  syntax: MermaidFlowchartSyntax,
  comments: readonly MermaidFlowchartComment[] = [],
) {
  return createMermaidVisualFamilyData("flowchart", {
    comments: comments.map((comment) => ({ ...comment })),
    syntax,
  });
}

export function withFlowchartComments(
  model: MermaidVisualModel,
  comments: readonly MermaidFlowchartComment[],
) {
  return {
    ...model,
    familyData: flowchartModelFamilyData(
      flowchartModelData(model).syntax,
      comments,
    ),
  };
}
