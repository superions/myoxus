// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualEdge,
  MermaidVisualNode,
} from "../runtime/gfx-model.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
  type MermaidVisualFamilyData,
} from "../runtime/gfx-family-data.js";

import { nextClassSourceKey } from "../../engine/class/source-document.js";

const CLASS_FAMILY = "class";

export type MermaidClassNodeGfxData = {
  readonly annotations: readonly string[];
  readonly cssClasses: readonly string[];
  readonly family: typeof CLASS_FAMILY;
  readonly genericType: string;
  readonly interaction: string;
  readonly kind: "class" | "lollipop-interface" | "note";
  readonly members: readonly string[];
  readonly memberKeys: readonly string[];
  readonly noteFor: string;
  readonly noteText: string;
};

export type MermaidClassEdgeGfxData = {
  readonly family: typeof CLASS_FAMILY;
  readonly fromCardinality: string;
  readonly noteLink: boolean;
  readonly relationKind: string;
  readonly toCardinality: string;
};

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

export function classNodeGfxData(
  node: Pick<MermaidVisualNode, "familyData">,
): MermaidClassNodeGfxData | undefined {
  const data = mermaidVisualFamilyPayload(node.familyData, CLASS_FAMILY);
  const annotations = stringArray(data?.annotations);
  const cssClasses = stringArray(data?.cssClasses);
  const members = stringArray(data?.members);
  if (
    !data ||
    !annotations ||
    !cssClasses ||
    !members ||
    typeof data.genericType !== "string" ||
    typeof data.interaction !== "string" ||
    (data.kind !== "class" &&
      data.kind !== "lollipop-interface" &&
      data.kind !== "note") ||
    typeof data.noteFor !== "string" ||
    typeof data.noteText !== "string"
  ) {
    return undefined;
  }
  return {
    annotations,
    cssClasses,
    family: CLASS_FAMILY,
    genericType: data.genericType,
    interaction: data.interaction,
    kind: data.kind,
    members,
    memberKeys: stringArray(data.memberKeys) ?? [],
    noteFor: data.noteFor,
    noteText: data.noteText,
  };
}

export function classEdgeGfxData(
  edge: Pick<MermaidVisualEdge, "familyData">,
): MermaidClassEdgeGfxData | undefined {
  const data = mermaidVisualFamilyPayload(edge.familyData, CLASS_FAMILY);
  if (
    !data ||
    typeof data.fromCardinality !== "string" ||
    typeof data.noteLink !== "boolean" ||
    typeof data.relationKind !== "string" ||
    typeof data.toCardinality !== "string"
  ) {
    return undefined;
  }
  return {
    family: CLASS_FAMILY,
    fromCardinality: data.fromCardinality,
    noteLink: data.noteLink,
    relationKind: data.relationKind,
    toCardinality: data.toCardinality,
  };
}

export function classNodeFamilyData({
  annotations,
  cssClasses,
  genericType,
  interaction,
  kind,
  members,
  memberKeys,
  noteFor,
  noteText,
}: Omit<MermaidClassNodeGfxData, "family" | "memberKeys"> & {
  memberKeys?: readonly string[];
}): MermaidVisualFamilyData {
  return createMermaidVisualFamilyData(CLASS_FAMILY, {
    annotations: [...annotations],
    cssClasses: [...cssClasses],
    genericType,
    interaction,
    kind,
    members: [...members],
    memberKeys: members.map(
      (_member, index) => memberKeys?.[index] ?? nextClassSourceKey(),
    ),
    noteFor,
    noteText,
  });
}

export function classEdgeFamilyData({
  fromCardinality,
  noteLink,
  relationKind,
  toCardinality,
}: Omit<MermaidClassEdgeGfxData, "family">): MermaidVisualFamilyData {
  return createMermaidVisualFamilyData(CLASS_FAMILY, {
    fromCardinality,
    noteLink,
    relationKind,
    toCardinality,
  });
}

import type {
  MermaidClassModel,
  ClassSourceRecord,
} from "../../engine/class/index.js";
import { hashMermaidSource } from "../../utils.js";
import type {
  MermaidVisualModel,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";
export type ClassProjectionBinding = {
  sourceKey: string;
  sourceId: string;
  namespaceId: string | null;
  headerHeight: number;
  rowHeight: number;
  padding: number;
  attributeHeight: number;
  hideEmpty: boolean;
};
export function classProjectionBinding(
  node: Pick<MermaidVisualNode, "familyData">,
): ClassProjectionBinding | undefined {
  const payload = mermaidVisualFamilyPayload(node.familyData, "class"),
    value = payload?.binding;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const b = value as Record<string, unknown>;
  if (
    typeof b.sourceKey !== "string" ||
    typeof b.sourceId !== "string" ||
    !(b.namespaceId === null || typeof b.namespaceId === "string") ||
    typeof b.hideEmpty !== "boolean" ||
    ["headerHeight", "rowHeight", "padding", "attributeHeight"].some(
      (key) => typeof b[key] !== "number",
    )
  )
    return undefined;
  return b as ClassProjectionBinding;
}
export function classBoundNodeFamilyData(
  data: Parameters<typeof classNodeFamilyData>[0],
  binding: ClassProjectionBinding,
  styles: Readonly<Record<string, string>> = {},
) {
  const base = classNodeFamilyData(data);
  return createMermaidVisualFamilyData("class", {
    ...base.payload,
    binding,
    styles,
  });
}
export function classNamespaceBinding(
  subgraph: Pick<MermaidVisualSubgraph, "familyData">,
) {
  const p = mermaidVisualFamilyPayload(subgraph.familyData, "class");
  return p?.kind === "namespace" &&
    typeof p.sourceId === "string" &&
    typeof p.sourceKey === "string"
    ? { sourceId: p.sourceId, sourceKey: p.sourceKey }
    : undefined;
}
type ClassRecordBinding = {
  key: string;
  kind: ClassSourceRecord["kind"];
  start: number;
  end: number;
  hash: string;
};
export function classModelFamilyData(model: MermaidClassModel) {
  return createMermaidVisualFamilyData("class", {
    sourceHash: model.sourceHash,
    namespaces: model.namespaces.map((n) => ({
      sourceId: n.id,
      sourceKey: n.sourceKey,
    })),
    classes: model.nodes
      .filter((n) => n.kind === "class")
      .map((n) => ({ sourceId: n.sourceId, sourceKey: n.sourceKey })),
    records: model.sourceDocument.records.map((r) => ({
      key: r.sourceKey,
      kind: r.kind,
      start: r.range.start,
      end: r.range.end,
      hash: hashMermaidSource(r.raw),
    })),
  });
}
export function classRecordBindings(
  model: Pick<MermaidVisualModel, "familyData">,
): readonly ClassRecordBinding[] {
  const p = mermaidVisualFamilyPayload(model.familyData, "class");
  return Array.isArray(p?.records)
    ? (p.records.filter((r) =>
        Boolean(
          r &&
          typeof r === "object" &&
          !Array.isArray(r) &&
          typeof r.key === "string" &&
          typeof r.kind === "string" &&
          typeof r.start === "number" &&
          typeof r.end === "number" &&
          typeof r.hash === "string",
        ),
      ) as readonly ClassRecordBinding[])
    : [];
}
