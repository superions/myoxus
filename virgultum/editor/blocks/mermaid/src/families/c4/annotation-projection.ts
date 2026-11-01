// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Model } from "../../engine/c4/index.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { c4BoundaryHiddenBy } from "./boundary-projection.js";
import type { MermaidGfxActionContext } from "../runtime/editor-capabilities.js";
export type C4CommentMarker = {
  key: string;
  sourceKeys: readonly string[];
  left: number;
  top: number;
  count: number;
};
/** Group coincident visible anchors, retaining each physical comment/record key.
 * Between-record and trailing diagram comments use the existing quiet canvas anchor. */
export function c4CommentMarkers(
  model: MermaidC4Model,
  resolve: MermaidGfxActionContext["resolveVisualAnchor"],
  visual?: MermaidVisualModel,
): C4CommentMarker[] {
  const groups = new Map<string, C4CommentMarker>();
  for (const comment of model.sourceDocument.records.filter(
    (r) => r.kind === "comment",
  )) {
    const record = model.sourceDocument.records.find(
      (r) => r.sourceKey === comment.anchor?.sourceKey,
    );
    const occurrence = model.occurrences.find(
      (o) => o.sourceKey === record?.sourceKey,
    );
    const boundary = model.boundaries.find(
      (b) =>
        b.resolution!.selectionId === occurrence?.selectionId ||
        b.resolution!.sourceKeys.some((key) => {
          const open = model.sourceDocument.records.find(
            (r) => r.sourceKey === key,
          );
          return (
            !!record &&
            (open?.braceKey === record.sourceKey ||
              open?.closeKey === record.sourceKey)
          );
        }),
    );
    const element = model.elements.find(
        (e) => e.resolution!.selectionId === occurrence?.selectionId,
      ),
      relation = model.relationships.find(
        (r) => r.resolution!.selectionId === occurrence?.selectionId,
      );
    const owner = boundary ?? element ?? relation;
    const kind =
      comment.anchor?.position === "after" || !owner
        ? "diagram"
        : boundary
          ? "subgraph"
          : relation
            ? "edge"
            : "node";
    const id = kind === "diagram" ? undefined : owner?.resolution!.selectionId;
    let hidden =
      visual && id && !relation ? c4BoundaryHiddenBy(visual, id) : undefined;
    if (visual && relation) {
      const ends = [relation.from, relation.to]
        .map(
          (alias) =>
            model.elements.find((e) => e.alias === alias)?.resolution!
              .selectionId,
        )
        .map((id) => (id ? c4BoundaryHiddenBy(visual, id) : undefined));
      if (ends[0] && ends[0] === ends[1]) hidden = ends[0];
    }
    const specific = resolve(hidden ? "subgraph" : kind, hidden ?? id);
    const key = specific
      ? `${hidden ? "subgraph" : kind}:${hidden ?? id ?? ""}`
      : "diagram:";
    const old = groups.get(key);
    if (old) {
      groups.set(key, {
        ...old,
        sourceKeys: [...old.sourceKeys, comment.sourceKey],
        count: old.count + 1,
      });
      continue;
    }
    const point = specific ?? resolve("diagram");
    if (point)
      groups.set(key, {
        key,
        sourceKeys: [comment.sourceKey],
        count: 1,
        ...point,
      });
  }
  return [...groups.values()];
}
