// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidBlockDiagramModel } from "../../engine/block/index.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
  type MermaidVisualFamilyData,
  type MermaidGfxJsonObject,
} from "../runtime/gfx-family-data.js";
import { hashMermaidSource } from "../../utils.js";
export type BlockRecordBinding = {
  key: string;
  kind: string;
  start: number;
  end: number;
  hash: string;
};
export type BlockProjectionBinding = {
  sourceKey: string;
  sourceId: string;
  role: "block" | "composite" | "space" | "connection" | "comment" | "grid";
  parentKey: string | null;
};
export function blockProjectionBinding(item: {
  familyData?: MermaidVisualFamilyData;
}): BlockProjectionBinding | undefined {
  const raw = mermaidVisualFamilyPayload(item.familyData, "block")?.binding;
  const b =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as MermaidGfxJsonObject)
      : undefined;
  if (
    !b ||
    typeof b !== "object" ||
    Array.isArray(b) ||
    typeof b.sourceKey !== "string" ||
    typeof b.sourceId !== "string" ||
    !["block", "composite", "space", "connection", "comment", "grid"].includes(
      String(b.role),
    ) ||
    !(b.parentKey === null || typeof b.parentKey === "string")
  )
    return undefined;
  return b as unknown as BlockProjectionBinding;
}
export function blockModelFamilyData(m: MermaidBlockDiagramModel) {
  return createMermaidVisualFamilyData("block", {
    sourceHash: m.sourceHash,
    config: m.config,
    columns: Number.isFinite(m.columns) ? m.columns : null,
    objects: [...m.nodes, ...m.groups].map((n) => ({
      sourceId: n.id,
      sourceKey: n.sourceKey,
    })),
    records: m.sourceDocument.records.map((r) => ({
      key: r.sourceKey,
      kind: r.kind,
      start: r.range.start,
      end: r.range.end,
      hash: hashMermaidSource(r.raw),
    })),
    comments: m.comments.map((c) => ({
      key: c.sourceKey,
      anchorKey: c.anchorKey ?? null,
      parentKey: c.parentKey,
      position: c.position,
    })),
    spaces: m.spaces.map((s) => ({
      id: s.id,
      order: s.order,
      parentId: s.parentId,
      span: Number.isFinite(s.span) ? s.span : null,
    })),
  });
}
export function blockRecordBindings(model: {
  familyData?: MermaidVisualFamilyData;
}): readonly BlockRecordBinding[] {
  const records = mermaidVisualFamilyPayload(
    model.familyData,
    "block",
  )?.records;
  return Array.isArray(records)
    ? (records.filter(
        (r) =>
          r &&
          typeof r === "object" &&
          !Array.isArray(r) &&
          typeof r.key === "string" &&
          typeof r.kind === "string" &&
          typeof r.start === "number" &&
          typeof r.end === "number" &&
          typeof r.hash === "string",
      ) as unknown as BlockRecordBinding[])
    : [];
}
