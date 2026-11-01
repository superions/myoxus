// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolveMermaidRequirementSource } from "../../engine/requirement/index.js";
import { hashMermaidSource } from "../../engine/source-hash.js";
import {
  mermaidVisualFamilyPayload,
  createMermaidVisualFamilyData,
} from "../runtime/gfx-family-data.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  requirementNodeGfxData,
  requirementEdgeGfxData,
  requirementNodeFamilyData,
  requirementEdgeFamilyData,
} from "./gfx-data.js";
import { requirementCardMetrics, separateRequirementCards } from "./layout.js";
import { routeRequirementRelations } from "./relation-projection.js";

type RecordBinding = {
  key: string;
  kind: string;
  start: number;
  end: number;
  hash: string;
};
export function requirementRecordBindings(
  visual: MermaidVisualModel,
): RecordBinding[] {
  const records = mermaidVisualFamilyPayload(
    visual.familyData,
    "requirement",
  )?.records;
  if (!Array.isArray(records)) return [];
  return records.flatMap((r) =>
    r &&
    typeof r === "object" &&
    !Array.isArray(r) &&
    typeof r.key === "string" &&
    typeof r.kind === "string" &&
    typeof r.start === "number" &&
    typeof r.end === "number" &&
    typeof r.hash === "string"
      ? [{ key: r.key, kind: r.kind, start: r.start, end: r.end, hash: r.hash }]
      : [],
  );
}
function bindingMapping(
  records: readonly RecordBinding[],
  previous: readonly RecordBinding[],
) {
  const result = new Map<string, string>(),
    used = new Set<string>();
  const signature = (r: RecordBinding) => `${r.kind}:${r.hash}`;
  const counts = new Map<string, number>(),
    bySignature = new Map<string, RecordBinding[]>(),
    byRange = new Map<string, RecordBinding[]>();
  for (const r of records)
    counts.set(signature(r), (counts.get(signature(r)) ?? 0) + 1);
  for (const r of previous) {
    const sig = signature(r),
      range = `${sig}:${r.start}:${r.end}`;
    bySignature.set(sig, [...(bySignature.get(sig) ?? []), r]);
    byRange.set(range, [...(byRange.get(range) ?? []), r]);
  }
  // Reserve unique untouched records before equal-range fallback, as in Class/ER.
  for (const record of records) {
    const sig = signature(record),
      old = bySignature.get(sig) ?? [];
    if (counts.get(sig) === 1 && old.length === 1 && !used.has(old[0]!.key)) {
      result.set(record.key, old[0]!.key);
      used.add(old[0]!.key);
    }
  }
  for (const record of records) {
    if (result.has(record.key)) continue;
    const old = (
      byRange.get(`${signature(record)}:${record.start}:${record.end}`) ?? []
    ).filter((r) => !used.has(r.key));
    if (old.length === 1) {
      result.set(record.key, old[0]!.key);
      used.add(old[0]!.key);
    }
  }
  return result;
}

/** Stored payloads carry record identities/ranges and geometry, never Source or
 * effective property data as a second authoring model. */
export function readRequirementProjectionModel(
  source: string,
  visual?: MermaidVisualModel,
) {
  const initial = resolveMermaidRequirementSource(source);
  if (!initial.model || !visual) return initial.model;
  const records = initial.document.records.map((r) => ({
    key: r.sourceKey,
    kind: r.kind,
    start: r.range.start,
    end: r.range.end,
    hash: hashMermaidSource(r.raw),
  }));
  const keys = bindingMapping(records, requirementRecordBindings(visual));
  const mapping = new Map(
    records.flatMap((r) =>
      keys.has(r.key) ? [[r.start, keys.get(r.key)!] as const] : [],
    ),
  );
  const model = resolveMermaidRequirementSource(
    source,
    undefined,
    mapping,
  ).model;
  if (!model) return null;
  for (const item of [...model.requirements, ...model.elements]) {
    const node =
      visual.nodes.find(
        (n) => requirementNodeGfxData(n)?.sourceKey === item.sourceKey,
      ) ??
      visual.nodes.find(
        (n) => !requirementNodeGfxData(n)?.sourceKey && n.id === item.id,
      );
    if (node) item.id = node.id;
  }
  for (const item of model.relations) {
    const edge =
      visual.edges.find(
        (e) => requirementEdgeGfxData(e)?.sourceKey === item.sourceKey,
      ) ??
      visual.edges.find(
        (e) => !requirementEdgeGfxData(e)?.sourceKey && e.id === item.id,
      );
    if (edge) item.id = edge.id;
  }
  const reqs = new Map(model.requirements.map((n) => [n.name, n.id])),
    els = new Map(model.elements.map((n) => [n.name, n.id]));
  for (const r of model.relations) {
    r.fromId = reqs.get(r.from) ?? els.get(r.from);
    r.toId = reqs.get(r.to) ?? els.get(r.to);
  }
  return model;
}

export function reconcileRequirementProjection(
  parsed: MermaidVisualModel,
  stored: MermaidVisualModel,
  canReuse = true,
): MermaidVisualModel {
  if (!canReuse) return parsed;
  const keys = bindingMapping(
    requirementRecordBindings(parsed),
    requirementRecordBindings(stored),
  );
  const ids = new Map<string, string>();
  const nodes = parsed.nodes.map((node) => {
    const data = requirementNodeGfxData(node),
      key = data?.sourceKey && (keys.get(data.sourceKey) ?? data.sourceKey);
    const old =
      stored.nodes.find(
        (n) => key && requirementNodeGfxData(n)?.sourceKey === key,
      ) ?? stored.nodes.find((n) => n.id === node.id);
    ids.set(node.id, old?.id ?? node.id);
    let familyData = node.familyData;
    if (data) {
      const { family: _family, ...payload } = data;
      familyData = requirementNodeFamilyData({
        ...payload,
        sourceKey: key || undefined,
        propertyKeys:
          payload.propertyKeys &&
          Object.fromEntries(
            Object.entries(payload.propertyKeys).map(([field, providers]) => [
              field,
              providers.map((provider) => keys.get(provider) ?? provider),
            ]),
          ),
      });
    }
    // Wrap at the retained usable width before choosing a minimum height. The
    // parser's cold width must not force extra lines into a widened manual card.
    const dimensions =
      old &&
      requirementCardMetrics({
        ...node,
        width: Math.max(old.width, node.width),
      });
    const details = node.details?.map((detail) => {
      // Separators and the element stereotype have no Source provider. Their
      // role within this bound card survives an alias-derived cold detail ID.
      const sourceKey =
        detail.sourceKey && (keys.get(detail.sourceKey) ?? detail.sourceKey);
      return {
        ...detail,
        sourceKey,
        id:
          old?.details?.find((d) =>
            sourceKey
              ? d.sourceKey === sourceKey
              : d.id === detail.id ||
                (!d.sourceKey &&
                  d.kind === detail.kind &&
                  d.order === detail.order),
          )?.id ?? detail.id,
      };
    });
    return {
      ...node,
      id: old?.id ?? node.id,
      familyData,
      details,
      ...(old
        ? {
            x: old.x,
            y: old.y,
            width: Math.max(old.width, dimensions!.width),
            height: Math.max(old.height, dimensions!.height),
          }
        : {}),
    };
  });
  const edges = parsed.edges.map((edge) => {
    const data = requirementEdgeGfxData(edge),
      key = data?.sourceKey && (keys.get(data.sourceKey) ?? data.sourceKey);
    const old =
      stored.edges.find(
        (e) => key && requirementEdgeGfxData(e)?.sourceKey === key,
      ) ?? stored.edges.find((e) => e.id === edge.id);
    let familyData = edge.familyData;
    if (data) {
      const { family: _family, ...payload } = data;
      familyData = requirementEdgeFamilyData({
        ...payload,
        sourceKey: key || undefined,
        ...(old
          ? {
              layoutSourcePosition:
                requirementEdgeGfxData(old)?.layoutSourcePosition,
              layoutTargetPosition:
                requirementEdgeGfxData(old)?.layoutTargetPosition,
            }
          : {}),
      });
    }
    return {
      ...edge,
      id: old?.id ?? edge.id,
      source: ids.get(edge.source) ?? edge.source,
      target: ids.get(edge.target) ?? edge.target,
      familyData,
      ...(old
        ? {
            connectorMode: old.connectorMode,
            labelPlacement: old.labelPlacement,
            sourcePosition: old.sourcePosition,
            targetPosition: old.targetPosition,
            sourcePortId: old.sourcePortId,
            targetPortId: old.targetPortId,
          }
        : {}),
    };
  });
  return routeRequirementRelations({
    ...parsed,
    nodes: separateRequirementCards(nodes),
    edges,
    familyData: createMermaidVisualFamilyData("requirement", {
      records: requirementRecordBindings(parsed).map((r) => ({
        ...r,
        key: keys.get(r.key) ?? r.key,
      })),
    }),
  });
}
