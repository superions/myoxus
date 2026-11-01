// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
  type MermaidGfxJsonObject,
} from "../runtime/gfx-family-data.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualEdge,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
import type {
  MermaidErModel,
  MermaidErEntity,
  MermaidErRelationship,
  ErSourceRecord,
  ErCardinality,
} from "../../engine/er/index.js";
import { readErConfig } from "../../engine/er/config.js";
import { hashMermaidSource } from "../../utils.js";
export type ErProjectionBinding = {
  sourceKey: string;
  sourceId: string;
  subgraphId: string | null;
  headerHeight: number;
  rowHeight: number;
  padding: number;
  columns: readonly [number, number, number];
  fontSize: number;
};
export function erProjectionBinding(
  node: Pick<MermaidVisualNode, "familyData">,
): ErProjectionBinding | undefined {
  const p = mermaidVisualFamilyPayload(node.familyData, "er"),
    raw = p?.binding,
    b =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as MermaidGfxJsonObject)
        : undefined;
  if (
    !b ||
    typeof b !== "object" ||
    Array.isArray(b) ||
    typeof b.sourceKey !== "string" ||
    typeof b.sourceId !== "string" ||
    !(b.subgraphId === null || typeof b.subgraphId === "string") ||
    ["headerHeight", "rowHeight", "padding", "fontSize"].some(
      (k) => typeof b[k] !== "number",
    ) ||
    !Array.isArray(b.columns) ||
    b.columns.length !== 3 ||
    b.columns.some((v) => typeof v !== "number")
  )
    return undefined;
  return b as unknown as ErProjectionBinding;
}
export function erNodeFamilyData(
  entity: MermaidErEntity,
  binding: ErProjectionBinding,
  styles: Readonly<Record<string, string>>,
) {
  return createMermaidVisualFamilyData("er", {
    binding,
    styles,
    cssClasses: entity.cssClasses,
    attributes: entity.attributes.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      optional: a.optional,
      keys: a.keys,
      comment: a.comment ?? "",
    })),
  });
}
export function erEdgeFamilyData(relation: MermaidErRelationship) {
  return createMermaidVisualFamilyData("er", {
    sourceKey: relation.sourceKey,
    from: relation.from,
    to: relation.to,
    cardinalityA: relation.cardinalityA,
    cardinalityB: relation.cardinalityB,
    identification: relation.identification,
  });
}
export function erEdgeGfxData(edge: Pick<MermaidVisualEdge, "familyData">) {
  const p = mermaidVisualFamilyPayload(edge.familyData, "er");
  return p &&
    typeof p.sourceKey === "string" &&
    typeof p.from === "string" &&
    typeof p.to === "string" &&
    [p.cardinalityA, p.cardinalityB].every(
      (c) =>
        typeof c === "string" &&
        [
          "exactly-one",
          "zero-or-one",
          "one-or-many",
          "zero-or-many",
          "mermaid-parent",
        ].includes(c),
    ) &&
    (p.identification === "--" || p.identification === "..")
    ? (p as unknown as {
        sourceKey: string;
        from: string;
        to: string;
        cardinalityA: ErCardinality;
        cardinalityB: ErCardinality;
        identification: "--" | "..";
      })
    : undefined;
}
export function erSubgraphBinding(
  group: Pick<MermaidVisualSubgraph, "familyData">,
) {
  const p = mermaidVisualFamilyPayload(group.familyData, "er");
  return p && typeof p.sourceKey === "string" && typeof p.sourceId === "string"
    ? { sourceKey: p.sourceKey, sourceId: p.sourceId }
    : undefined;
}
export type ErRecordBinding = {
  key: string;
  kind: ErSourceRecord["kind"];
  start: number;
  end: number;
  hash: string;
};
/** Identity metadata lives on the existing projection owner; no Source or model
 * copy is persisted here. Reserved records survive duplicate signatures. */
export function erModelFamilyData(model: MermaidErModel) {
  return createMermaidVisualFamilyData("er", {
    config: readErConfig(model.sourceDocument).config,
    sourceHash: model.sourceHash,
    entities: model.entities.map((n) => ({
      sourceId: n.id,
      sourceKey: n.sourceKey,
    })),
    subgraphs: model.subgraphs.map((g) => ({
      sourceId: g.id,
      sourceKey: g.sourceKey,
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
export function erRecordBindings(
  model: Pick<MermaidVisualModel, "familyData">,
): readonly ErRecordBinding[] {
  const p = mermaidVisualFamilyPayload(model.familyData, "er");
  return Array.isArray(p?.records)
    ? (p.records.filter(
        (r) =>
          r &&
          typeof r === "object" &&
          !Array.isArray(r) &&
          typeof r.key === "string" &&
          typeof r.kind === "string" &&
          typeof r.start === "number" &&
          typeof r.end === "number" &&
          typeof r.hash === "string",
      ) as unknown as ErRecordBinding[])
    : [];
}
export function erProjectedStyles(
  node: Pick<MermaidVisualNode, "familyData">,
): MermaidGfxJsonObject | undefined {
  const styles = mermaidVisualFamilyPayload(node.familyData, "er")?.styles;
  return styles && typeof styles === "object" && !Array.isArray(styles)
    ? (styles as MermaidGfxJsonObject)
    : undefined;
}
