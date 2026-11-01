// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidArchitectureComment,
  MermaidArchitectureModel,
} from "../../engine/architecture/index.js";
import { mermaidMessages } from "../../i18n.js";
import type { MermaidGfxActionContext } from "../runtime/editor-capabilities.js";
import {
  architectureEdgeGfxData,
  architectureNodeGfxData,
  architectureSubgraphGfxData,
} from "./gfx-data.js";
import type {
  MermaidArchitectureCommentAnchor,
  MermaidArchitectureCommentMarkerProjection,
  MermaidArchitectureCommentProjection,
} from "./react-host-contract.js";

export function architectureCommentAnchorLabel(
  model: MermaidArchitectureModel | null,
  comment: MermaidArchitectureComment,
) {
  if (comment.anchorKind === "metadata") {
    if (comment.anchorId === "diagramTitle") {
      return model?.diagramTitle || mermaidMessages.visualEditorLabel();
    }
    if (comment.anchorId === "accessibilityTitle") {
      return model?.accessibilityTitle || mermaidMessages.visualEditorLabel();
    }
    if (comment.anchorId === "accessibilityDescription") {
      return (
        model?.accessibilityDescription || mermaidMessages.visualEditorLabel()
      );
    }
  }
  if (comment.anchorKind === "service") {
    const service = model?.services.find(
      (candidate) => candidate.id === comment.anchorId,
    );
    return service?.label || service?.id || mermaidMessages.visualEditorLabel();
  }
  if (comment.anchorKind === "junction") {
    return (
      model?.junctions.find((candidate) => candidate.id === comment.anchorId)
        ?.id || mermaidMessages.visualEditorLabel()
    );
  }
  if (comment.anchorKind === "group") {
    const group = model?.groups.find(
      (candidate) => candidate.id === comment.anchorId,
    );
    return group?.label || group?.id || mermaidMessages.visualEditorLabel();
  }
  if (comment.anchorKind === "edge") {
    const edge = model?.edges.find(
      (candidate) => candidate.id === comment.anchorId,
    );
    return (
      edge?.label ||
      (edge ? `${edge.from} → ${edge.to}` : undefined) ||
      mermaidMessages.visualEditorLabel()
    );
  }
  if (comment.anchorKind === "alignment") {
    const alignment = model?.alignments.find(
      (candidate) => candidate.id === comment.anchorId,
    );
    if (alignment) {
      const label =
        alignment.direction === "row"
          ? mermaidMessages.architectureAlignRow()
          : mermaidMessages.architectureAlignColumn();
      return `${label}: ${alignment.members.join(", ")}`;
    }
  }
  return model?.diagramTitle || mermaidMessages.visualEditorLabel();
}

type VisualCommentAnchor = {
  readonly id?: string;
  readonly kind:
    "alignment" | "diagram" | "edge" | "node" | "subgraph" | "title";
};

function resolveArchitectureVisualCommentAnchor(
  visualModel: MermaidGfxActionContext["visualModel"],
  comment: MermaidArchitectureCommentProjection,
): VisualCommentAnchor | undefined {
  if (comment.anchorKind === "service" || comment.anchorKind === "junction") {
    const node = visualModel.nodes.find(
      (candidate) =>
        candidate.id === comment.anchorId ||
        architectureNodeGfxData(candidate)?.sourceId === comment.anchorId,
    );
    return node ? { id: node.id, kind: "node" } : undefined;
  }
  if (comment.anchorKind === "group") {
    const group = visualModel.subgraphs?.find(
      (candidate) =>
        candidate.id === comment.anchorId ||
        architectureSubgraphGfxData(candidate)?.sourceId === comment.anchorId,
    );
    return group ? { id: group.id, kind: "subgraph" } : undefined;
  }
  if (comment.anchorKind === "edge") {
    const edge = visualModel.edges.find(
      (candidate) =>
        candidate.id === comment.anchorId ||
        architectureEdgeGfxData(candidate)?.sourceId === comment.anchorId,
    );
    return edge ? { id: edge.id, kind: "edge" } : undefined;
  }
  if (comment.anchorKind === "alignment") {
    return { id: comment.anchorId, kind: "alignment" };
  }
  if (comment.anchorKind === "diagram") {
    return { id: comment.anchorId, kind: "diagram" };
  }
  if (
    comment.anchorKind === "metadata" &&
    comment.anchorId === "diagramTitle"
  ) {
    return { kind: "title" };
  }
  return undefined;
}

export function projectArchitectureComments(
  model: MermaidArchitectureModel | null,
  comments: readonly MermaidArchitectureComment[],
  context: Pick<MermaidGfxActionContext, "resolveVisualAnchor" | "visualModel">,
): {
  readonly commentMarkers: readonly MermaidArchitectureCommentMarkerProjection[];
  readonly comments: readonly MermaidArchitectureCommentProjection[];
} {
  const projectedComments = comments.map((comment) => ({
    anchor: architectureCommentAnchorLabel(model, comment),
    anchorId: comment.anchorId,
    anchorKind: comment.anchorKind,
    id: comment.id,
    text: comment.line.replace(/^%%\s*/, ""),
  }));
  const commentGroups = new Map<
    string,
    {
      anchor: MermaidArchitectureCommentAnchor;
      comments: MermaidArchitectureCommentProjection[];
      visualAnchor: VisualCommentAnchor | undefined;
    }
  >();
  for (const comment of projectedComments) {
    const key = `${comment.anchorKind}:${comment.anchorId ?? ""}`;
    const existing = commentGroups.get(key);
    if (existing) {
      existing.comments.push(comment);
      continue;
    }
    commentGroups.set(key, {
      anchor: {
        anchorId: comment.anchorId,
        anchorKind: comment.anchorKind,
      },
      comments: [comment],
      visualAnchor: resolveArchitectureVisualCommentAnchor(
        context.visualModel,
        comment,
      ),
    });
  }
  return {
    commentMarkers: [...commentGroups].flatMap(
      ([key, { anchor, comments: anchoredComments, visualAnchor }]) => {
        const position = visualAnchor
          ? context.resolveVisualAnchor(visualAnchor.kind, visualAnchor.id)
          : null;
        return position
          ? [
              {
                anchor,
                comments: anchoredComments,
                key,
                ...position,
              },
            ]
          : [];
      },
    ),
    comments: projectedComments,
  };
}
