// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  resolveMermaidErSource,
  editErEntity,
  editErRelationship,
  addErRelationship,
  reparentErEntity,
  reparentErSubgraph,
  editErSubgraph,
  type MermaidErModel,
  type ErCommandResult,
} from "../../engine/er/index.js";
import {
  mermaidVisualFamilyPayload,
  type MermaidGfxJsonValue,
} from "../runtime/gfx-family-data.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { hashMermaidSource } from "../../utils.js";
import { distributeErPorts } from "./edge-projection.js";
import { erModelToVisual } from "./visual-model.js";
import {
  erRecordBindings,
  erProjectionBinding,
  erSubgraphBinding,
  erEdgeGfxData,
  type ErRecordBinding,
} from "./gfx-data.js";
import { erSubgraphHeaderMetrics } from "./layout.js";
/** Reserve unchanged identity bindings before adopting newly parsed records.
 * Persisted payloads contain identity and geometry, never a second document. */
export function readErProjectionModel(
  source: string,
  visual?: MermaidVisualModel,
): MermaidErModel | null {
  const records = resolveMermaidErSource(source).document.records,
    bindings = visual ? erRecordBindings(visual) : [],
    mapping = new Map<number, string>(),
    used = new Set<string>();
  const hashes = records.map((r) => hashMermaidSource(r.raw)),
    recordCounts = new Map<string, number>(),
    byHash = new Map<string, ErRecordBinding[]>(),
    byRange = new Map<string, ErRecordBinding[]>();
  for (const hash of hashes)
    recordCounts.set(hash, (recordCounts.get(hash) ?? 0) + 1);
  for (const b of bindings) {
    const range = `${b.kind}:${b.start}:${b.end}:${b.hash}`;
    byHash.set(b.hash, [...(byHash.get(b.hash) ?? []), b]);
    byRange.set(range, [...(byRange.get(range) ?? []), b]);
  }
  // These per-read indexes preserve the ambiguity rules without hashing every
  // other record again for each candidate. They are not a Source cache.
  for (const [index, record] of records.entries()) {
    const hash = hashes[index]!,
      range = `${record.kind}:${record.range.start}:${record.range.end}:${hash}`;
    let candidates = (byRange.get(range) ?? []).filter((b) => !used.has(b.key));
    if (!candidates.length && recordCounts.get(hash) === 1) {
      const matching = byHash.get(hash) ?? [];
      if (matching.length === 1)
        candidates = matching.filter(
          (b) => !used.has(b.key) && b.kind === record.kind,
        );
    }
    if (candidates.length === 1) {
      mapping.set(record.range.start, candidates[0]!.key);
      used.add(candidates[0]!.key);
    }
  }
  const entities = new Map(
      (visual?.nodes ?? []).flatMap((n) => {
        const b = erProjectionBinding(n);
        return b ? [[b.sourceId, b.sourceKey] as const] : [];
      }),
    ),
    groups = new Map(
      (visual?.subgraphs ?? []).flatMap((g) => {
        const b = erSubgraphBinding(g);
        return b ? [[b.sourceId, b.sourceKey] as const] : [];
      }),
    );
  const payload = visual && mermaidVisualFamilyPayload(visual.familyData, "er");
  for (const [field, keys] of [
    ["entities", entities],
    ["subgraphs", groups],
  ] as const) {
    const values = payload && payload[field];
    if (Array.isArray(values))
      for (const entry of values)
        if (
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof entry.sourceId === "string" &&
          typeof entry.sourceKey === "string"
        )
          keys.set(entry.sourceId, entry.sourceKey);
  }
  return resolveMermaidErSource(source, undefined, mapping, entities, groups)
    .model;
}
/** Ordinary edits preserve existing geometry. Only changed content may grow a
 * card; relayout belongs to an explicit Appearance/Direction action. */
export function reconcileErVisual(
  parsed: MermaidVisualModel,
  stored: MermaidVisualModel,
  canReuse = true,
): MermaidVisualModel {
  if (!canReuse) return parsed;
  const nodes = parsed.nodes.map((n) => {
    const old =
      stored.nodes.find((o) => o.id === n.id) ||
      stored.nodes.find(
        (o) =>
          !erProjectionBinding(o) && o.id === erProjectionBinding(n)?.sourceId,
      );
    if (!old) return n;
    const unchanged =
      JSON.stringify(n.familyData) === JSON.stringify(old.familyData);
    return {
      ...n,
      x: old.x,
      y: old.y,
      width: unchanged ? old.width : Math.max(n.width, old.width),
      height: unchanged ? old.height : Math.max(n.height, old.height),
    };
  });
  const subgraphs: NonNullable<MermaidVisualModel["subgraphs"]> = [];
  for (const g of [...(parsed.subgraphs ?? [])].reverse()) {
    const old =
      stored.subgraphs?.find((o) => o.id === g.id) ||
      stored.subgraphs?.find(
        (o) => !erSubgraphBinding(o) && o.id === erSubgraphBinding(g)?.sourceId,
      );
    const children = [
      ...nodes.filter((n) => g.nodeIds.includes(n.id)),
      ...subgraphs.filter((child) => child.parentId === g.id),
    ];
    const rawStyles = mermaidVisualFamilyPayload(g.familyData, "er")?.styles,
      styles = Object.fromEntries(
        Object.entries(
          rawStyles &&
            typeof rawStyles === "object" &&
            !Array.isArray(rawStyles)
            ? rawStyles
            : {},
        ).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      header = erSubgraphHeaderMetrics(g.displayLabel ?? g.title, styles),
      x = Math.min(old?.x ?? g.x, ...children.map((n) => n.x - 24)),
      y = Math.min(old?.y ?? g.y, ...children.map((n) => n.y - header.height));
    const right = Math.max(
        old ? old.x + old.width : g.x + g.width,
        ...children.map((n) => n.x + n.width + 24),
      ),
      bottom = Math.max(
        old ? old.y + old.height : g.y + g.height,
        ...children.map((n) => n.y + n.height + 24),
      );
    subgraphs.push({
      ...g,
      x,
      y,
      width: Math.max(right - x, header.width),
      height: bottom - y,
    });
  }
  const ports = new Map(
    distributeErPorts(parsed.edges, nodes, subgraphs).map((edge) => [
      edge.id,
      edge,
    ]),
  );
  const connections = (
    edges: readonly MermaidVisualModel["edges"][number][],
    id: string,
  ) =>
    edges
      .filter((edge) => edge.source === id || edge.target === id)
      .map((edge) => `${edge.id}:${edge.source}:${edge.target}`)
      .sort()
      .join("\n");
  const unchangedConnections = (id: string) =>
    connections(parsed.edges, id) === connections(stored.edges, id);
  return {
    ...parsed,
    nodes,
    edges: parsed.edges.map((e) => {
      const old = stored.edges.find((o) => o.id === e.id);
      const allocated = ports.get(e.id)!;
      return old
        ? {
            ...e,
            connectorMode: e.connectorMode,
            labelPlacement: old.labelPlacement ?? e.labelPlacement,
            sourcePosition:
              old.source === e.source && unchangedConnections(e.source)
                ? (old.sourcePosition ?? e.sourcePosition)
                : allocated.sourcePosition,
            targetPosition:
              old.target === e.target && unchangedConnections(e.target)
                ? (old.targetPosition ?? e.targetPosition)
                : allocated.targetPosition,
          }
        : allocated;
    }),
    subgraphs: subgraphs.reverse(),
  };
}
/** Adopt checked candidate identities, while taking all semantic payload from
 * fresh Source. This must not rerun the writer with already advanced bindings. */
export function canonicalizeErVisual(
  parsed: MermaidVisualModel,
  requested: MermaidVisualModel,
) {
  const bindings = new Map(
      erRecordBindings(requested).map((b) => [
        `${b.kind}:${b.start}:${b.end}:${b.hash}`,
        b.key,
      ]),
    ),
    keys = new Map(
      erRecordBindings(parsed).map((b) => [
        b.key,
        bindings.get(`${b.kind}:${b.start}:${b.end}:${b.hash}`) ?? b.key,
      ]),
    );
  for (const n of parsed.nodes) {
    const id = erProjectionBinding(n)?.sourceId,
      old = requested.nodes.find(
        (o) => erProjectionBinding(o)?.sourceId === id,
      );
    if (old) keys.set(n.id, old.id);
  }
  for (const g of parsed.subgraphs ?? []) {
    const id = erSubgraphBinding(g)?.sourceId,
      old = requested.subgraphs?.find(
        (o) => erSubgraphBinding(o)?.sourceId === id,
      );
    if (old) keys.set(g.id, old.id);
  }
  const remap = (key: string): string => {
    if (keys.has(key)) return keys.get(key)!;
    for (const [from, to] of keys)
      if (key.startsWith(from + ":")) return to + key.slice(from.length);
    return key;
  };
  const payload = (
    data: MermaidVisualModel["familyData"],
  ): MermaidVisualModel["familyData"] => {
    if (!data) return data;
    const values = { ...data.payload };
    for (const field of ["records", "entities", "subgraphs", "attributes"]) {
      const list = values[field];
      if (Array.isArray(list))
        values[field] = list.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return entry;
          const value = { ...entry };
          for (const name of ["key", "sourceKey", "id"])
            if (typeof value[name] === "string")
              value[name] = remap(value[name]);
          return value;
        });
    }
    if (typeof values.sourceKey === "string")
      values.sourceKey = remap(values.sourceKey);
    const b = values.binding as
      import("../runtime/gfx-family-data.js").MermaidGfxJsonObject | undefined;
    if (b && typeof b === "object" && !Array.isArray(b))
      values.binding = { ...b, sourceKey: remap(String(b.sourceKey)) };
    return { ...data, payload: values as Record<string, MermaidGfxJsonValue> };
  };
  return reconcileErVisual(
    {
      ...parsed,
      familyData: payload(parsed.familyData),
      nodes: parsed.nodes.map((n) => ({
        ...n,
        id: remap(n.id),
        familyData: payload(n.familyData),
        details: n.details?.map((d) => ({
          ...d,
          id: remap(d.id),
          ...(d.sourceKey ? { sourceKey: remap(d.sourceKey) } : {}),
        })),
      })),
      edges: parsed.edges.map((e) => ({
        ...e,
        id: remap(e.id),
        source: remap(e.source),
        target: remap(e.target),
        familyData: payload(e.familyData),
      })),
      subgraphs: parsed.subgraphs?.map((g) => ({
        ...g,
        id: remap(g.id),
        parentId: g.parentId ? remap(g.parentId) : undefined,
        nodeIds: g.nodeIds.map(remap),
        familyData: payload(g.familyData),
      })),
    },
    requested,
  );
}
/** Native gesture readback changes only semantics explicitly changed by the GFX
 * command. Move/Resize comes through the projection-only path and writes no Source. */
export function applyErGfxVisualToSource(
  source: string,
  visual: MermaidVisualModel,
) {
  let model = readErProjectionModel(source, visual);
  if (!model) throw new Error("Invalid ER Source");
  const apply = (result: ErCommandResult) => {
    if (result.status === "rejected")
      throw new Error(result.diagnostic ?? "Rejected ER mutation");
    model = result.model;
  };
  for (const node of visual.nodes) {
    const b = erProjectionBinding(node);
    if (!b) continue;
    const entity = model.entities.find((e) => e.sourceKey === b.sourceKey);
    if (entity && entity.label !== node.label)
      apply(editErEntity(model, entity.sourceKey, { label: node.label }));
  }
  for (const edge of visual.edges) {
    const data = erEdgeGfxData(edge);
    if (!data) continue;
    const from =
        erProjectionBinding(
          visual.nodes.find((n) => n.id === edge.source) ?? {},
        )?.sourceId ??
        erSubgraphBinding(
          visual.subgraphs?.find((g) => g.id === edge.source) ?? {},
        )?.sourceId,
      to =
        erProjectionBinding(
          visual.nodes.find((n) => n.id === edge.target) ?? {},
        )?.sourceId ??
        erSubgraphBinding(
          visual.subgraphs?.find((g) => g.id === edge.target) ?? {},
        )?.sourceId;
    if (!from || !to) continue;
    const original = model.relationships.find((r) => r.sourceKey === edge.id);
    const value = {
      from,
      to,
      cardinalityA: data.cardinalityA,
      cardinalityB: data.cardinalityB,
      identification: data.identification,
      label: edge.label,
    };
    if (original) apply(editErRelationship(model, original.sourceKey, value));
    else {
      const added = addErRelationship(model, { ...value, sourceKey: edge.id });
      if (added.status === "rejected") apply(added);
      else model = added.model;
    }
  }
  for (const group of visual.subgraphs ?? []) {
    const b = erSubgraphBinding(group),
      original = b && model.subgraphs.find((g) => g.sourceKey === b.sourceKey);
    if (!original) continue;
    if (original.label !== group.title)
      apply(editErSubgraph(model, original.sourceKey, { label: group.title }));
    const parent = group.parentId
      ? (erSubgraphBinding(
          visual.subgraphs?.find((g) => g.id === group.parentId) ?? {},
        )?.sourceId ?? null)
      : null;
    if (parent !== original.parentId)
      apply(reparentErSubgraph(model, original.sourceKey, parent));
  }
  for (const node of visual.nodes) {
    const b = erProjectionBinding(node),
      original = b && model.entities.find((e) => e.sourceKey === b.sourceKey);
    if (!original) continue;
    const parent = visual.subgraphs?.find((g) => g.nodeIds.includes(node.id)),
      id = parent ? (erSubgraphBinding(parent)?.sourceId ?? null) : null;
    if (id !== original.subgraphId)
      apply(reparentErEntity(model, original.sourceKey, id));
  }
  return {
    source: model.sourceDocument.source,
    visualModel: reconcileErVisual(erModelToVisual(model), visual),
    diagnostics: [],
  };
}

export function reconcileErSubgraphLayout(
  model: MermaidErModel,
  parsed: MermaidVisualModel,
  stored: MermaidVisualModel,
  key: string,
) {
  const group = model.subgraphs.find((g) => g.sourceKey === key);
  if (!group) return reconcileErVisual(parsed, stored);
  const ids = new Set([group.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const g of model.subgraphs)
      if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) {
        ids.add(g.id);
        changed = true;
      }
  }
  const groups = new Set(
    model.subgraphs.filter((g) => ids.has(g.id)).map((g) => g.sourceKey),
  );
  const nodes = new Set(
    model.entities
      .filter((e) => e.subgraphId && ids.has(e.subgraphId))
      .map((e) => e.sourceKey),
  );
  const old = stored.subgraphs?.find((g) => g.id === key),
    fresh = parsed.subgraphs?.find((g) => g.id === key),
    dx = old && fresh ? old.x - fresh.x : 0,
    dy = old && fresh ? old.y - fresh.y : 0;
  const positioned = {
    ...parsed,
    nodes: parsed.nodes.map((n) =>
      nodes.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n,
    ),
    subgraphs: parsed.subgraphs?.map((g) =>
      groups.has(g.id) ? { ...g, x: g.x + dx, y: g.y + dy } : g,
    ),
  };
  return reconcileErVisual(positioned, {
    ...stored,
    nodes: stored.nodes.filter((n) => !nodes.has(n.id)),
    subgraphs: stored.subgraphs?.filter((g) => !groups.has(g.id)),
  });
}
