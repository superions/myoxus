// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidStateModel,
  StateComment,
} from "../../engine/state/index.js";
import type { StateConfig } from "../../engine/state/config.js";
import type { MermaidVisualNode } from "../runtime/gfx-model.js";
import type { MermaidGfxActionContext } from "../runtime/editor-capabilities.js";
import { createMermaidVisualFamilyData } from "../runtime/gfx-family-data.js";
import { measureMermaidGfxText } from "../../mermaid-gfx-theme.js";
import { stateTypography, stateDisplayText } from "./layout.js";
import { stateImpact, stateRecord } from "../../engine/state/index.js";
export function projectStateNotes(
  model: MermaidStateModel,
  config: StateConfig,
): MermaidVisualNode[] {
  const type = stateTypography(config, {});
  return model.notes
    .filter((n) => n.effective)
    .map((note) => {
      const text = stateDisplayText(note.label),
        measured = measureMermaidGfxText(text, type);
      const width = Math.max(
          type.fontSize * 4,
          measured.width + config.noteMargin * 2,
        ),
        height = measured.height + config.noteMargin * 2;
      return {
        id: note.id,
        label: note.label,
        displayLabel: text,
        labelEditable: false,
        shape: "doc",
        textAlign: "left",
        textVerticalAlign: "top",
        x: 0,
        y: 0,
        width,
        height,
        familyData: createMermaidVisualFamilyData("state", {
          role: "note",
          noteStateId: note.stateId ?? "",
          notePlacement: note.placement,
          noteFloatingId: note.floatingId ?? "",
          binding: {
            sourceKey: note.id,
            sourceId: note.floatingId ?? note.id,
            role: "note",
            parentId: note.parentId ?? null,
            regionKey: note.regionKey ?? null,
            fontSize: type.fontSize,
            padding: config.noteMargin,
            headerHeight: height,
            rows: [],
            width,
            height,
          },
        }),
      };
    });
}
export type StateCommentMarker = {
  key: string;
  label: string;
  anchor: Pick<StateComment, "anchorKind" | "anchorId" | "position">;
  left: number;
  top: number;
  count: number;
};
export function stateCommentMarkers(
  model: MermaidStateModel,
  resolve: MermaidGfxActionContext["resolveVisualAnchor"],
): StateCommentMarker[] {
  const groups = new Map<string, StateCommentMarker>();
  for (const c of model.commentRecords) {
    const key = `${c.anchorKind}:${c.anchorId ?? ""}`,
      existing = groups.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    const kind =
      c.anchorKind === "diagram"
        ? "diagram"
        : c.anchorKind === "transition"
          ? "edge"
          : c.anchorKind === "composite"
            ? "subgraph"
            : c.anchorKind === "description"
              ? "detail"
              : "node";
    let id = c.anchorId;
    if (c.anchorKind === "record") {
      const record = model.sourceDocument.records.find(
        (r) => r.sourceKey === id,
      );
      id = [...model.states, ...model.composites].find(
        (n) => n.id === record?.ownerId,
      )?.sourceKey;
    }
    const position = resolve(kind, id) ?? resolve("diagram");
    if (position)
      groups.set(key, {
        key,
        label: stateDisplayText(
          [...model.states, ...model.composites].find(
            (n) => n.sourceKey === c.anchorId,
          )?.label ??
            model.states
              .flatMap((n) => n.descriptions ?? [])
              .find((d) => d.id === c.anchorId)?.text ??
            model.notes.find((n) => n.id === c.anchorId)?.label ??
            (c.anchorId && stateRecord(model, c.anchorId)
              ? stateImpact(model, [stateRecord(model, c.anchorId)!]).records[0]
                  ?.label
              : undefined) ??
            model.diagramTitle,
        ),
        anchor: {
          anchorKind: c.anchorKind,
          anchorId: c.anchorId,
          position: c.position,
        },
        count: 1,
        ...position,
      });
  }
  return [...groups.values()];
}
