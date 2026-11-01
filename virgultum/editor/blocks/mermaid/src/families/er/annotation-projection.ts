// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidErModel, ErCommentAnchor } from "../../engine/er/index.js";
import type { MermaidGfxActionContext } from "../runtime/editor-capabilities.js";
export type ErCommentMarker = {
  key: string;
  anchor: ErCommentAnchor;
  left: number;
  top: number;
  count: number;
};
/** Comment positions follow semantic Source anchors through the existing GFX viewport. */
export function erCommentMarkers(
  model: MermaidErModel,
  resolve: MermaidGfxActionContext["resolveVisualAnchor"],
): ErCommentMarker[] {
  const groups = new Map<string, ErCommentMarker>();
  for (const comment of model.commentRecords) {
    const key = `${comment.anchorKind}:${comment.anchorId ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      continue;
    }

    const kind =
      comment.anchorKind === "attribute"
        ? "detail"
        : comment.anchorKind === "relation"
          ? "edge"
          : comment.anchorKind === "subgraph"
            ? "subgraph"
            : comment.anchorKind === "diagram"
              ? "diagram"
              : "node";
    let position = resolve(kind, comment.anchorId);
    if (comment.anchorKind === "attribute" && position) {
      const owner = model.entities.find((e) =>
          e.attributes.some((a) => a.id === comment.anchorId),
        ),
        card = owner && resolve("node", owner.sourceKey);
      if (card) position = { left: card.left, top: position.top };
    }
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
