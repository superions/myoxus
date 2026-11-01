// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  requirementComments,
  type RequirementCommentAnchor,
  type MermaidRequirementModel,
} from "../../engine/requirement/index.js";
import type { MermaidGfxActionContext } from "../runtime/editor-capabilities.js";
import {
  measureMermaidGfxText,
  mermaidGfxTypographyForNode,
} from "../../mermaid-gfx-theme.js";

export type RequirementCommentMarker = {
  key: string;
  anchor: RequirementCommentAnchor;
  left: number;
  top: number;
  count: number;
  commentKeys: string[];
};
/** Resolve literal occurrences through the already-bound visible card/row/edge.
 * Unrendered statements keep their neighbour anchor rather than a dummy node. */
export function requirementCommentMarkers(
  model: MermaidRequirementModel,
  resolve: MermaidGfxActionContext["resolveVisualAnchor"],
  detailId: (key: string) => string | undefined,
  scale = 1,
): RequirementCommentMarker[] {
  const records = model.sourceDocument?.records ?? [],
    groups = new Map<string, RequirementCommentMarker>();
  for (const comment of requirementComments(model)) {
    const key = `${comment.anchor.key ?? "diagram"}:${comment.anchor.position}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      existing.commentKeys.push(comment.key);
      continue;
    }
    const record = records.find(
      (record) => record.sourceKey === comment.anchor.key,
    );
    const object =
      record &&
      [...model.requirements, ...model.elements].find(
        (object) => object.sourceKey === (record.blockKey ?? record.sourceKey),
      );
    const relation =
      record &&
      model.relations.find(
        (relation) => relation.sourceKey === record.sourceKey,
      );
    const detail = record && detailId(record.sourceKey);
    let edgeAnchor = relation;
    let position = detail
      ? resolve("detail", detail)
      : object
        ? resolve("node", object.id)
        : relation
          ? resolve("edge", relation.id)
          : null;
    if (!position && record) {
      const index = records.indexOf(record),
        neighbour = [
          ...records.slice(index),
          ...records.slice(0, index).reverse(),
        ].find((candidate) =>
          [...model.requirements, ...model.elements, ...model.relations].some(
            (object) => object.sourceKey === candidate.sourceKey,
          ),
        );
      const object = [...model.requirements, ...model.elements].find(
          (object) => object.sourceKey === neighbour?.sourceKey,
        ),
        edge = model.relations.find(
          (edge) => edge.sourceKey === neighbour?.sourceKey,
        );
      position = object
        ? resolve("node", object.id)
        : edge
          ? resolve("edge", edge.id)
          : null;
      edgeAnchor = edge;
    }
    position ??= resolve("diagram");
    if (position && edgeAnchor) {
      // Edge anchors resolve at the painted label centre. Keep the marker
      // outside its measured ink at the live viewport scale, not over the text.
      const typography = mermaidGfxTypographyForNode({}),
        label = measureMermaidGfxText(`<<${edgeAnchor.kind}>>`, typography);
      position = {
        left: position.left + (label.width * scale) / 2 + typography.lineHeight,
        top: position.top,
      };
    }
    if (position) {
      const coincident = [...groups.values()].find(
        (marker) =>
          marker.left === position.left && marker.top === position.top,
      );
      if (coincident) {
        coincident.count++;
        coincident.commentKeys.push(comment.key);
      } else
        groups.set(key, {
          key,
          anchor: comment.anchor,
          count: 1,
          commentKeys: [comment.key],
          ...position,
        });
    }
  }
  return [...groups.values()];
}
