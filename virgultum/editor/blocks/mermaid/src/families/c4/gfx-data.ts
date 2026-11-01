// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseMermaidC4Source,
  type MermaidC4Model,
} from "../../engine/c4/index.js";
import { scanC4Source } from "../../engine/c4/source-document.js";
import {
  C4_CALLS,
  relationshipArgumentIndexes,
} from "../../engine/c4/runtime-contract.js";
import { hashMermaidSource } from "../../utils.js";
import { projectC4MaterializedNode } from "./content-projection.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
  type MermaidVisualFamilyData,
  type MermaidGfxJsonObject,
} from "../runtime/gfx-family-data.js";

function recordIdentity(
  record: ReturnType<typeof scanC4Source>["records"][number],
) {
  if (!record.callKind || !record.arguments) return "";
  if (C4_CALLS[record.callKind].category === "relationship") {
    const indexes = relationshipArgumentIndexes(record.callKind);
    return JSON.stringify([
      record.arguments[indexes.from]?.value,
      record.arguments[indexes.to]?.value,
    ]);
  }
  return record.arguments[0]?.value ?? "";
}

function c4RecordBindingMapping(
  records: readonly MermaidGfxJsonObject[],
  previous: readonly MermaidGfxJsonObject[],
) {
  const mapping = new Map<string, string>(),
    used = new Set<string>();
  const choose = (
    record: MermaidGfxJsonObject,
    candidates: readonly MermaidGfxJsonObject[],
  ) => {
    if (
      candidates.length !== 1 ||
      typeof record.key !== "string" ||
      typeof candidates[0].key !== "string"
    )
      return;
    mapping.set(record.key, candidates[0].key);
    used.add(candidates[0].key);
  };
  for (const record of records)
    choose(
      record,
      previous.filter(
        (old) =>
          old.kind === record.kind &&
          old.hash === record.hash &&
          old.start === record.start &&
          old.end === record.end &&
          typeof old.key === "string" &&
          !used.has(old.key),
      ),
    );
  for (const record of records) {
    if (mapping.has(String(record.key))) continue;
    if (
      records.filter((r) => r.kind === record.kind && r.hash === record.hash)
        .length === 1
    )
      choose(
        record,
        previous.filter(
          (old) =>
            old.kind === record.kind &&
            old.hash === record.hash &&
            typeof old.key === "string" &&
            !used.has(old.key),
        ),
      );
  }
  for (const record of records) {
    if (mapping.has(String(record.key)) || !record.identity) continue;
    if (
      records.filter(
        (r) =>
          r.kind === record.kind &&
          r.identity === record.identity &&
          !mapping.has(String(r.key)),
      ).length === 1
    )
      choose(
        record,
        previous.filter(
          (old) =>
            old.kind === record.kind &&
            old.identity === record.identity &&
            typeof old.key === "string" &&
            !used.has(old.key),
        ),
      );
  }
  return mapping;
}

/** Only identities and source fingerprints are persisted. Authored source remains
 * the single document owner; the payload cannot become a second semantic store. */
export function c4IdentityFamilyData(model: MermaidC4Model) {
  return createMermaidVisualFamilyData("c4", {
    records: model.sourceDocument.records.map((r) => ({
      key: r.sourceKey,
      kind: r.kind,
      start: r.range.start,
      end: r.range.end,
      hash: hashMermaidSource(r.raw),
      identity: recordIdentity(r),
    })),
    selections: (model.sourceDocument.selectionBindings ?? []).map((b) => ({
      ...b,
      sourceKeys: [...b.sourceKeys],
    })),
  });
}

/** Reserve unchanged records first, then reconcile an unambiguous edited call.
 * Repeated calls are never assigned identities using their list position. */
export function readC4ProjectionModel(
  source: string,
  stored?: MermaidVisualModel,
) {
  const document = scanC4Source(source);
  const payload = stored && mermaidVisualFamilyPayload(stored.familyData, "c4");
  const old = Array.isArray(payload?.records)
    ? payload.records.filter((r): r is MermaidGfxJsonObject =>
        Boolean(r && typeof r === "object" && !Array.isArray(r)),
      )
    : [];
  const current = document.records.map((r) => ({
    key: r.sourceKey,
    kind: r.kind,
    start: r.range.start,
    end: r.range.end,
    hash: hashMermaidSource(r.raw),
    identity: recordIdentity(r),
  }));
  const keys = c4RecordBindingMapping(current, old);
  const mapping = new Map(
    current.flatMap((r) =>
      keys.has(r.key) ? [[r.start, keys.get(r.key)!] as const] : [],
    ),
  );
  const previous = scanC4Source("");
  previous.selectionBindings = Array.isArray(payload?.selections)
    ? payload.selections.flatMap((b) => {
        if (
          !b ||
          typeof b !== "object" ||
          Array.isArray(b) ||
          typeof b.identity !== "string" ||
          typeof b.selectionId !== "string" ||
          !["element", "boundary", "relationship"].includes(
            String(b.category),
          ) ||
          !Array.isArray(b.sourceKeys)
        )
          return [];
        return [
          {
            identity: b.identity,
            category: b.category as "element" | "boundary" | "relationship",
            selectionId: b.selectionId,
            sourceKeys: b.sourceKeys.filter(
              (k: unknown): k is string => typeof k === "string",
            ),
          },
        ];
      })
    : [];
  const model = parseMermaidC4Source(source, { previous, mapping });
  if (model && stored && !payload) {
    const selections = new Map(
      [...model.elements, ...model.boundaries, ...model.relationships].map(
        (value) => [value.resolution!, value.resolution!.selectionId],
      ),
    );
    // Existing served children provide their real identity at the first binding
    // materialization; no alias-derived replacement ID is assigned to them.
    for (const element of model.elements) {
      const existing = stored.nodes.find((n) => n.id === element.alias);
      if (existing && element.resolution)
        element.resolution.selectionId = existing.id;
    }
    for (const boundary of model.boundaries) {
      const existing = stored.subgraphs?.find((g) => g.id === boundary.id);
      if (existing && boundary.resolution)
        boundary.resolution.selectionId = existing.id;
    }
    for (const relation of model.relationships) {
      const existing = stored.edges.find((e) => e.id === relation.id);
      if (existing && relation.resolution)
        relation.resolution.selectionId = existing.id;
    }
    model.sourceDocument.selectionBindings =
      model.sourceDocument.selectionBindings?.map((b) => {
        const group = [
          ...model.elements,
          ...model.boundaries,
          ...model.relationships,
        ].find((g) =>
          g.resolution?.sourceKeys.some((k) => b.sourceKeys.includes(k)),
        );
        return group?.resolution
          ? { ...b, selectionId: group.resolution.selectionId }
          : b;
      });
    const reconciled = new Map(
      [...selections].map(([group, old]) => [old, group.selectionId]),
    );
    for (const occurrence of model.occurrences)
      if (occurrence.selectionId)
        occurrence.selectionId =
          reconciled.get(occurrence.selectionId) ?? occurrence.selectionId;
  }
  return model;
}

export function c4VisualWithSourceIdentities(
  model: MermaidC4Model,
  visual: MermaidVisualModel,
): MermaidVisualModel {
  const aliases = new Map([
    ...model.elements.map(
      (e) => [e.resolution?.selectionId ?? e.id, e.alias] as const,
    ),
    ...model.boundaries.map(
      (b) => [b.resolution?.selectionId ?? b.id, b.id] as const,
    ),
  ]);
  const payload = mermaidVisualFamilyPayload(visual.familyData, "c4");
  if (Array.isArray(payload?.selections))
    for (const binding of payload.selections) {
      if (
        binding &&
        typeof binding === "object" &&
        !Array.isArray(binding) &&
        (binding.category === "element" || binding.category === "boundary") &&
        typeof binding.selectionId === "string" &&
        typeof binding.identity === "string" &&
        !aliases.has(binding.selectionId)
      )
        aliases.set(binding.selectionId, binding.identity);
    }
  const edges = new Map(
    model.relationships.map((r) => [r.resolution?.selectionId ?? r.id, r.id]),
  );
  return {
    ...visual,
    nodes: visual.nodes.map((n) => ({ ...n, id: aliases.get(n.id) ?? n.id })),
    subgraphs: visual.subgraphs?.map((g) => ({
      ...g,
      id: aliases.get(g.id) ?? g.id,
      nodeIds: g.nodeIds.map((id) => aliases.get(id) ?? id),
    })),
    edges: visual.edges.map((e) => ({
      ...e,
      id: edges.get(e.id) ?? e.id,
      source: aliases.get(e.source) ?? e.source,
      target: aliases.get(e.target) ?? e.target,
    })),
  };
}

/** Resolve an existing projection binding for semantic commands and assertions. */
export function c4ProjectionSelectionId(
  visual: MermaidVisualModel,
  category: "element" | "boundary" | "relationship",
  identity: string,
) {
  const data = mermaidVisualFamilyPayload(visual.familyData, "c4");
  if (!Array.isArray(data?.selections)) return undefined;
  const binding = data.selections.find(
    (b) =>
      b &&
      typeof b === "object" &&
      !Array.isArray(b) &&
      b.category === category &&
      b.identity === identity,
  );
  return binding &&
    typeof binding === "object" &&
    !Array.isArray(binding) &&
    typeof binding.selectionId === "string"
    ? binding.selectionId
    : undefined;
}

/** Adopt the writer's advanced bindings before matching materialized children.
 * Both candidates describe the same newly written source at this boundary. */
export function canonicalizeC4VisualIdentities(
  parsed: MermaidVisualModel,
  requested: MermaidVisualModel,
): MermaidVisualModel {
  const fresh = mermaidVisualFamilyPayload(parsed.familyData, "c4");
  const advanced = mermaidVisualFamilyPayload(requested.familyData, "c4");
  if (
    !fresh ||
    !advanced ||
    !Array.isArray(fresh.records) ||
    !Array.isArray(advanced.records) ||
    !Array.isArray(fresh.selections) ||
    !Array.isArray(advanced.selections)
  )
    return parsed;
  const object = (value: unknown): value is MermaidGfxJsonObject =>
    Boolean(value && typeof value === "object" && !Array.isArray(value));
  const freshRecords = fresh.records.filter(object);
  const keys = c4RecordBindingMapping(
    freshRecords,
    advanced.records.filter(object),
  );
  const records = freshRecords.map((record) => ({
    ...record,
    key: keys.get(String(record.key)) ?? record.key,
  }));
  const ids = new Map<string, string>(),
    reserved = new Set<string>();
  const previous = advanced.selections.filter(object);
  const selections = fresh.selections.filter(object).map((binding) => {
    if (
      !Array.isArray(binding.sourceKeys) ||
      typeof binding.selectionId !== "string"
    )
      return binding;
    const sourceKeys = binding.sourceKeys
      .filter((k: unknown): k is string => typeof k === "string")
      .map((k) => keys.get(k) ?? k);
    const matching = previous.filter(
      (old) =>
        old.category === binding.category &&
        old.identity === binding.identity &&
        typeof old.selectionId === "string" &&
        !reserved.has(old.selectionId) &&
        Array.isArray(old.sourceKeys) &&
        old.sourceKeys.some((k: unknown) => sourceKeys.includes(String(k))),
    );
    const id =
      matching.length === 1
        ? String(matching[0].selectionId)
        : binding.selectionId;
    reserved.add(id);
    ids.set(binding.selectionId, id);
    return { ...binding, selectionId: id, sourceKeys };
  });
  const remap = (id: string) => ids.get(id) ?? id;
  return {
    ...parsed,
    familyData: createMermaidVisualFamilyData("c4", { records, selections }),
    // Content role IDs derive from their Source owner. Rebuild them after the
    // owner remap so the commit and the following ensure reuse the same children.
    nodes: parsed.nodes.map((n) =>
      projectC4MaterializedNode({ ...n, id: remap(n.id) }),
    ),
    edges: parsed.edges.map((e) => ({
      ...e,
      id: remap(e.id),
      source: remap(e.source),
      target: remap(e.target),
      ...(e.sourceAttachment
        ? { sourceAttachment: remap(e.sourceAttachment) }
        : {}),
      ...(e.targetAttachment
        ? { targetAttachment: remap(e.targetAttachment) }
        : {}),
    })),
    subgraphs: parsed.subgraphs?.map((g) => {
      const data = mermaidVisualFamilyPayload(g.familyData, "c4");
      return {
        ...g,
        id: remap(g.id),
        nodeIds: g.nodeIds.map(remap),
        familyData:
          data && typeof data.sourceParentId === "string"
            ? createMermaidVisualFamilyData("c4", {
                ...data,
                sourceParentId: remap(data.sourceParentId),
              })
            : g.familyData,
      };
    }),
    styleStatements: parsed.styleStatements?.map((s) =>
      s.replace(/^style (\S+) /, (_, id: string) => `style ${remap(id)} `),
    ),
  };
}

export type C4BoundaryBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type C4BoundaryPresentation = {
  collapsed?: boolean;
  expandedBounds?: C4BoundaryBounds;
};
/** Presentation belongs to the stable materialized boundary, never the Source model. */
export function c4BoundaryPresentation(
  familyData: MermaidVisualFamilyData | undefined,
): C4BoundaryPresentation {
  const data = mermaidVisualFamilyPayload(familyData, "c4"),
    raw = data?.expandedBounds;
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as MermaidGfxJsonObject)
      : undefined;
  const bounds =
    value &&
    ["x", "y", "width", "height"].every(
      (k) => typeof value[k] === "number" && Number.isFinite(value[k]),
    ) &&
    Number(value.width) > 0 &&
    Number(value.height) > 0
      ? {
          x: Number(value.x),
          y: Number(value.y),
          width: Number(value.width),
          height: Number(value.height),
        }
      : undefined;
  return {
    collapsed: data?.collapsed === true,
    ...(bounds ? { expandedBounds: bounds } : {}),
  };
}
/** Source reconciliation keeps presentation even when the Source changes object counts. */
export function reconcileC4BoundaryPresentation(
  parsed: MermaidVisualModel,
  stored: MermaidVisualModel,
): MermaidVisualModel {
  const previous = new Map(stored.subgraphs?.map((g) => [g.id, g]));
  return {
    ...parsed,
    subgraphs: parsed.subgraphs?.map((g) => {
      const old = previous.get(g.id),
        data = mermaidVisualFamilyPayload(g.familyData, "c4");
      return old && data
        ? {
            ...g,
            ...(c4BoundaryPresentation(old.familyData).collapsed
              ? { x: old.x, y: old.y, width: old.width }
              : {}),
            familyData: createMermaidVisualFamilyData("c4", {
              ...data,
              ...c4BoundaryPresentation(old.familyData),
            }),
          }
        : g;
    }),
  };
}

/** Only collapse and its recovery rectangle are presentation-only. All other
 * C4 payload fields keep participating in the shared Source comparison. */
export function c4SourceSemanticFamilyData(
  data: MermaidVisualFamilyData | undefined,
) {
  if (data?.family !== "c4") return data;
  const {
    collapsed: _collapsed,
    expandedBounds: _expanded,
    ...payload
  } = data.payload;
  return { ...data, payload };
}
