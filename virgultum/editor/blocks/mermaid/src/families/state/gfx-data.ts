// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
  type MermaidVisualFamilyData,
  type MermaidGfxJsonObject,
} from "../runtime/gfx-family-data.js";
import type {
  MermaidStateModel,
  StateSourceRecord,
} from "../../engine/state/index.js";
import { readStateConfig } from "../../engine/state/config.js";
import { hashMermaidSource } from "../../utils.js";
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";

/** Nearest Source-owned painted ancestor; free XY never changes membership. */
export function stateBackgroundForeground(
  model: MermaidVisualModel,
  objects: readonly { familyData?: MermaidVisualFamilyData }[],
) {
  const ancestors = objects.map((object) => {
    const keys: string[] = [];
    let parent = stateProjectionBinding(object)?.parentId;
    while (parent && !keys.includes(parent)) {
      keys.push(parent);
      parent = stateProjectionBinding(
        model.subgraphs?.find(
          (g) => stateProjectionBinding(g)?.sourceId === parent,
        ) ?? {},
      )?.parentId;
    }
    return keys;
  });
  for (const key of ancestors[0] ?? []) {
    if (!ancestors.every((keys) => keys.includes(key))) continue;
    const group = model.subgraphs?.find(
      (g) => stateProjectionBinding(g)?.sourceId === key,
    );
    const fill = group && stateProjectedStyles(group)?.fill;
    // An unstyled Composite still paints its own theme background. It does
    // not inherit the authored fill of an outer Composite.
    return typeof fill === "string"
      ? projectMermaidSourceStyle({ fill }).color
      : undefined;
  }
  return undefined;
}

export type StateProjectionBinding = {
  sourceKey: string;
  sourceId: string;
  role: "state" | "note" | "composite" | "region";
  parentId: string | null;
  regionKey: string | null;
  kind?: string;
  fontSize: number;
  padding: number;
  headerHeight: number;
  rows: readonly { key: string; y: number; height: number }[];
  /** Measured protected content, independent of user-resized GFX bounds. */
  width?: number;
  height?: number;
};
export function stateProjectionBinding(item: {
  familyData?: MermaidVisualFamilyData;
}): StateProjectionBinding | undefined {
  const payload = mermaidVisualFamilyPayload(item.familyData, "state"),
    raw = payload?.binding,
    value =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as MermaidGfxJsonObject)
        : undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.sourceKey !== "string" ||
    typeof value.sourceId !== "string" ||
    !["state", "note", "composite", "region"].includes(String(value.role)) ||
    typeof value.fontSize !== "number" ||
    typeof value.headerHeight !== "number" ||
    typeof value.padding !== "number" ||
    (value.width !== undefined &&
      (typeof value.width !== "number" || !Number.isFinite(value.width))) ||
    (value.height !== undefined &&
      (typeof value.height !== "number" || !Number.isFinite(value.height))) ||
    !Array.isArray(value.rows) ||
    !(value.parentId === null || typeof value.parentId === "string") ||
    !(value.regionKey === null || typeof value.regionKey === "string")
  )
    return undefined;
  if (
    (value.rows as readonly unknown[]).some(
      (r) =>
        !r ||
        typeof r !== "object" ||
        Array.isArray(r) ||
        typeof (r as Record<string, unknown>).key !== "string" ||
        !Number.isFinite((r as Record<string, unknown>).y) ||
        !Number.isFinite((r as Record<string, unknown>).height),
    )
  )
    return undefined;
  return value as unknown as StateProjectionBinding;
}
export function stateProjectedStyles(item: {
  familyData?: MermaidVisualFamilyData;
}): MermaidGfxJsonObject | undefined {
  const styles = mermaidVisualFamilyPayload(item.familyData, "state")?.styles;
  return styles && typeof styles === "object" && !Array.isArray(styles)
    ? (styles as MermaidGfxJsonObject)
    : undefined;
}
export function stateProjectedRadius(
  model: MermaidVisualModel,
  width: number,
  height: number,
) {
  const config = mermaidVisualFamilyPayload(model.familyData, "state")?.config;
  const radius =
    config && typeof config === "object" && !Array.isArray(config)
      ? Number((config as MermaidGfxJsonObject).radius)
      : 0;
  return Number.isFinite(radius)
    ? Math.min(0.5, Math.max(0, radius) / Math.max(1, Math.min(width, height)))
    : 0;
}
export type StateRecordBinding = {
  key: string;
  kind: StateSourceRecord["kind"];
  start: number;
  end: number;
  hash: string;
};
/** Persist only technical identity/config contributions on the existing owner.
 * The Source and parsed model retain their single document owner. */
export function stateModelFamilyData(model: MermaidStateModel) {
  return createMermaidVisualFamilyData("state", {
    sourceHash: model.sourceHash,
    config: readStateConfig(model.sourceDocument).config,
    objects: [...model.states, ...model.composites].map((n) => ({
      sourceId: n.id,
      sourceKey: n.sourceKey!,
    })),
    comments: model.commentRecords.map((c) => ({
      key: c.id,
      anchorKind: c.anchorKind,
      anchorId: c.anchorId ?? null,
      position: c.position,
    })),
    records: model.sourceDocument.records.map((r) => ({
      key: r.sourceKey,
      kind: r.kind,
      start: r.range.start,
      end: r.range.end,
      hash: hashMermaidSource(r.raw),
    })),
  });
}
export function stateRecordBindings(
  model: Pick<MermaidVisualModel, "familyData">,
): readonly StateRecordBinding[] {
  const records = mermaidVisualFamilyPayload(
    model.familyData,
    "state",
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
      ) as unknown as StateRecordBinding[])
    : [];
}
