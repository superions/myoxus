// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  flowchartModelData,
  withFlowchartComments,
  type MermaidFlowchartComment,
} from "../../engine/flowchart-model.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { mermaidMessages } from "../../i18n.js";

export type MermaidFlowchartCommentAnchor = Pick<
  MermaidFlowchartComment,
  "anchorId" | "anchorKind"
>;

function commentLine(value: string) {
  const text = value.replaceAll(/\s*\r?\n\s*/g, " ").trim();
  return text ? `%% ${text}` : "";
}

export function flowchartComments(model: MermaidVisualModel) {
  return flowchartModelData(model).comments;
}

export function flowchartCommentAnchorLabel(
  model: MermaidVisualModel,
  anchor: MermaidFlowchartCommentAnchor,
) {
  if (anchor.anchorKind === "node") {
    const node = model.nodes.find(({ id }) => id === anchor.anchorId);
    return node?.label || node?.id || mermaidMessages.visualEditorLabel();
  }
  if (anchor.anchorKind === "edge") {
    const edge = model.edges.find(({ id }) => id === anchor.anchorId);
    return (
      edge?.label ||
      (edge ? `${edge.source} → ${edge.target}` : undefined) ||
      mermaidMessages.visualEditorLabel()
    );
  }
  if (anchor.anchorKind === "subgraph") {
    const subgraph = model.subgraphs?.find(({ id }) => id === anchor.anchorId);
    return (
      subgraph?.title || subgraph?.id || mermaidMessages.visualEditorLabel()
    );
  }
  return model.diagramTitle || mermaidMessages.visualEditorLabel();
}

export function addFlowchartComment(
  model: MermaidVisualModel,
  anchor: MermaidFlowchartCommentAnchor,
  value: string,
) {
  const line = commentLine(value);
  if (!line) return null;
  const comments = [...flowchartComments(model)];
  const ids = new Set(comments.map((comment) => comment.id));
  let index = comments.length + 1;
  while (ids.has(`comment-${index}`)) index += 1;
  comments.push({
    ...anchor,
    id: `comment-${index}`,
    line,
    position: "before",
  });
  return withFlowchartComments(model, comments);
}

export function updateFlowchartComment(
  model: MermaidVisualModel,
  commentId: string,
  value: string,
) {
  const line = commentLine(value);
  if (!line) return null;
  const comments = flowchartComments(model);
  if (!comments.some((comment) => comment.id === commentId)) return null;
  return withFlowchartComments(
    model,
    comments.map((comment) =>
      comment.id === commentId ? { ...comment, line } : comment,
    ),
  );
}

export function deleteFlowchartComment(
  model: MermaidVisualModel,
  commentId: string,
) {
  const comments = flowchartComments(model);
  if (!comments.some((comment) => comment.id === commentId)) return null;
  return withFlowchartComments(
    model,
    comments.filter((comment) => comment.id !== commentId),
  );
}
