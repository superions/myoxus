// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidClassModel,
  ClassCommentAnchor,
} from "../../engine/class/index.js";
import type { MermaidGfxActionContext } from "../runtime/editor-capabilities.js";
export type ClassCommentMarker = {
  key: string;
  anchor: ClassCommentAnchor;
  left: number;
  top: number;
  count: number;
};
/** Comment positions follow semantic Source anchors through the existing GFX viewport. */
export function classCommentMarkers(
  model: MermaidClassModel,
  resolve: MermaidGfxActionContext["resolveVisualAnchor"],
): ClassCommentMarker[] {
  const groups = new Map<string, ClassCommentMarker>();
  for (const comment of model.commentRecords) {
    const key = `${comment.anchorKind}:${comment.anchorId ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      continue;
    }

    const kind =
      comment.anchorKind === "member"
        ? "detail"
        : comment.anchorKind === "relation"
          ? "edge"
          : comment.anchorKind === "namespace"
            ? "subgraph"
            : comment.anchorKind === "diagram"
              ? "diagram"
              : "node";
    const position = resolve(kind, comment.anchorId);
    if (position)
      groups.set(key, {
        key,
        anchor: {
          anchorKind: comment.anchorKind,
          anchorId: comment.anchorId,
          position: comment.position,
        },
        count: 1,
        ...position,
      });
  }
  return [...groups.values()];
}
