// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  scanBlockSource,
  resolveMermaidBlockSource,
} from "../../engine/block/index.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { blockRecordBindings } from "./gfx-data.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
  serializeMermaidVisualFamilyData,
  type MermaidGfxJsonValue,
} from "../runtime/gfx-family-data.js";
import { hashMermaidSource } from "../../utils.js";
/** Reserve exact unchanged ranges before unique relocated signatures. Only
 * technical bindings are persisted; the one Source parser owns all semantics. */
export function readBlockProjectionModel(
  source: string,
  visual?: MermaidVisualModel,
) {
  const records = scanBlockSource(source).records,
    bindings = visual ? blockRecordBindings(visual) : [],
    mapping = new Map<number, string>(),
    used = new Set<string>(),
    counts = new Map<string, number>();
  for (const r of records) {
    const hash = hashMermaidSource(r.raw);
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  for (const r of records) {
    const hash = hashMermaidSource(r.raw);
    let candidates = bindings.filter(
      (b) =>
        !used.has(b.key) &&
        b.start === r.range.start &&
        b.end === r.range.end &&
        b.hash === hash,
    );
    if (!candidates.length && counts.get(hash) === 1) {
      const unique = bindings.filter((b) => b.hash === hash);
      if (unique.length === 1)
        candidates = unique.filter((b) => !used.has(b.key));
    }
    if (candidates.length === 1) {
      mapping.set(r.range.start, candidates[0]!.key);
      used.add(candidates[0]!.key);
    }
  }
  const keys = new Map<string, string>(),
    objects =
      visual && mermaidVisualFamilyPayload(visual.familyData, "block")?.objects;
  if (Array.isArray(objects))
    for (const n of objects)
      if (
        n &&
        typeof n === "object" &&
        !Array.isArray(n) &&
        typeof n.sourceId === "string" &&
        typeof n.sourceKey === "string"
      )
        keys.set(n.sourceId, n.sourceKey);
  // Adopt the currently stored semantic keys at this one projection boundary.
  // Existing Surface children keep their real IDs; subsequent edits persist the
  // same Source keys, even after the authored Mermaid ID changes.
  const sourceIds = new Set(
    records.flatMap((r) => r.endpoints?.map((e) => e.id) ?? []),
  );
  for (const n of [...(visual?.nodes ?? []), ...(visual?.subgraphs ?? [])])
    if (!blockProjectionBinding(n) && sourceIds.has(n.id)) keys.set(n.id, n.id);
  return resolveMermaidBlockSource(source, undefined, mapping, keys).model;
}
export function canonicalizeBlockVisual(
  parsed: MermaidVisualModel,
  requested: MermaidVisualModel,
) {
  const records = new Map(
    blockRecordBindings(requested).map((r) => [
      `${r.kind}:${r.start}:${r.end}:${r.hash}`,
      r.key,
    ]),
  );
  const keys = new Map(
    blockRecordBindings(parsed).map((r) => [
      r.key,
      records.get(`${r.kind}:${r.start}:${r.end}:${r.hash}`) ?? r.key,
    ]),
  );
  const remap = (key: string) => {
    if (keys.has(key)) return keys.get(key)!;
    for (const [a, b] of keys)
      if (key.startsWith(a + ":")) return b + key.slice(a.length);
    return key;
  };
  const objects = mermaidVisualFamilyPayload(
    requested.familyData,
    "block",
  )?.objects;
  for (const n of [...parsed.nodes, ...(parsed.subgraphs ?? [])]) {
    const binding = blockProjectionBinding(n);
    const live = [...requested.nodes, ...(requested.subgraphs ?? [])].find(
      (o) => o.id === binding?.sourceId && !blockProjectionBinding(o),
    );
    if (live) {
      keys.set(n.id, live.id);
      continue;
    }
    const entry =
      Array.isArray(objects) &&
      objects.find(
        (o) =>
          o &&
          typeof o === "object" &&
          !Array.isArray(o) &&
          o.sourceId === binding?.sourceId,
      );
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof entry.sourceKey === "string"
    )
      keys.set(n.id, entry.sourceKey);
  }
  const fields = new Set([
    "key",
    "sourceKey",
    "anchorKey",
    "parentKey",
    "parent",
    "bodyKey",
    "recordKey",
  ]);
  const mapValue = (
    value: MermaidGfxJsonValue,
    field?: string,
  ): MermaidGfxJsonValue =>
    typeof value === "string"
      ? fields.has(field ?? "")
        ? remap(value)
        : value
      : Array.isArray(value)
        ? value.map((v) => mapValue(v))
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, mapValue(v, k)]),
            )
          : value;
  const payload = (data: MermaidVisualModel["familyData"]) =>
    data
      ? {
          ...data,
          payload: mapValue(data.payload) as Record<
            string,
            MermaidGfxJsonValue
          >,
        }
      : data;
  // The shared commit reparses Source before materialization. Adopt the checked
  // candidate's geometry as well as its advanced identities, or every free
  // move and explicit local reflow would revert to cold parser coordinates.
  return reconcileBlockVisual(
    {
      ...parsed,
      familyData: payload(parsed.familyData),
      nodes: parsed.nodes.map((n) => ({
        ...n,
        id: remap(n.id),
        // The arrow label is a real Surface child of this same Source identity.
        // Rebinding its body without its label would replace that child on the
        // next geometry readback after an earlier record changes length.
        details: n.details?.map((detail) => ({
          ...detail,
          id: remap(detail.id),
          sourceKey: detail.sourceKey ? remap(detail.sourceKey) : undefined,
        })),
        familyData: payload(n.familyData),
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
        parentId: g.parentId ? remap(g.parentId) : g.parentId,
        nodeIds: g.nodeIds.map(remap),
        familyData: payload(g.familyData),
      })),
    },
    requested,
  );
}

import { blockModelToVisual } from "./visual-model.js";
import { distributeBlockConnectionPorts } from "./connection-projection.js";
import { blockProjectionBinding } from "./gfx-data.js";
import {
  updateBlock,
  updateBlockConnection,
  addBlockConnection,
} from "../../engine/block/index.js";
/** Ordinary edits retain every surviving object's presentation, independently of
 * total counts. Only confirmed impact scopes replace their Source grid layout. */
export function reconcileBlockVisual(
  parsed: MermaidVisualModel,
  stored: MermaidVisualModel,
  canReuse = true,
  reflow: readonly (string | null)[] = [],
) {
  // The neutral host's count-based reuse hint cannot invalidate surviving
  // Source-bound geometry when an insertion adds a Space or another object.
  void canReuse;
  const scopes = new Set(reflow),
    reset = new Set<string>(),
    offsets = new Map<string, { x: number; y: number }>();
  const objects = [...parsed.nodes, ...(parsed.subgraphs ?? [])];
  for (const n of objects) {
    const b = blockProjectionBinding(n);
    if (b && scopes.has(b.parentKey)) reset.add(n.id);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const g of parsed.subgraphs ?? [])
      if (reset.has(g.id)) {
        for (const n of objects) {
          if (
            g.nodeIds.includes(n.id) ||
            ("parentId" in n && n.parentId === g.id)
          ) {
            if (!reset.has(n.id)) {
              reset.add(n.id);
              changed = true;
            }
          }
        }
      }
  }
  for (const scope of scopes) {
    const group = parsed.subgraphs?.find(
        (g) =>
          mermaidVisualFamilyPayload(g.familyData, "block")?.bodyKey === scope,
      ),
      old = group && stored.subgraphs?.find((g) => g.id === group.id);
    if (group && old) {
      offsets.set(scope!, { x: old.x - group.x, y: old.y - group.y });
      reset.add(group.id);
    }
  }
  const sourceOffset = (id: string): { x: number; y: number } => {
    let n = objects.find((n) => n.id === id),
      b = n && blockProjectionBinding(n);
    while (b?.parentKey) {
      const offset = offsets.get(b.parentKey);
      if (offset) return offset;
      const parent = parsed.subgraphs?.find(
        (g) =>
          mermaidVisualFamilyPayload(g.familyData, "block")?.bodyKey ===
          b!.parentKey,
      );
      b = parent && blockProjectionBinding(parent);
    }
    const own = mermaidVisualFamilyPayload(n?.familyData, "block")?.bodyKey;
    return typeof own === "string"
      ? (offsets.get(own) ?? { x: 0, y: 0 })
      : { x: 0, y: 0 };
  };
  const preserve = <
    T extends
      | MermaidVisualModel["nodes"][number]
      | NonNullable<MermaidVisualModel["subgraphs"]>[number],
  >(
    n: T,
    old: T | undefined,
  ): T => {
    if (reset.has(n.id)) {
      const offset = sourceOffset(n.id);
      return { ...n, x: n.x + offset.x, y: n.y + offset.y };
    }
    if (!old) return n;
    // Grid coordinates, record order and bindings change during foreign edits.
    // They cannot resize a surviving freely positioned body outside the reflow.
    const body = (item: T) => {
      const data = mermaidVisualFamilyPayload(item.familyData, "block");
      return {
        label: "label" in item ? item.label : item.title,
        shape: "shape" in item ? item.shape : undefined,
        arrow: Boolean(data?.contour),
        styles: data?.styles,
        span: data?.span,
        padding: data?.padding,
        headerHeight: data?.headerHeight,
      };
    };
    // Surface metadata serializes object keys canonically. Source Style keys
    // retain authored order; that order cannot trigger a foreign body reflow.
    const bodyKey = (item: T) =>
      serializeMermaidVisualFamilyData(
        createMermaidVisualFamilyData("block", body(item)),
      );
    const same = bodyKey(n) === bodyKey(old);
    return {
      ...n,
      x: old.x,
      y: old.y,
      width: same ? old.width : Math.max(n.width, old.width),
      height: same ? old.height : Math.max(n.height, old.height),
    };
  };
  const nodes = parsed.nodes.map((n) =>
      preserve(
        n,
        stored.nodes.find((o) => o.id === n.id),
      ),
    ),
    groups = (parsed.subgraphs ?? []).map((g) =>
      preserve(
        g,
        stored.subgraphs?.find((o) => o.id === g.id),
      ),
    );
  // Frames follow their actual Source children. This never assigns membership
  // from overlap, and a moved unrelated object cannot join a composite.
  for (const g of [...groups].reverse()) {
    const children = [
      ...nodes.filter((n) => g.nodeIds.includes(n.id)),
      ...groups.filter((n) => n.parentId === g.id),
    ];
    if (!children.length) continue;
    const padding =
        Number(mermaidVisualFamilyPayload(g.familyData, "block")?.padding) || 0,
      header =
        Number(
          mermaidVisualFamilyPayload(g.familyData, "block")?.headerHeight,
        ) || 0,
      right = Math.max(
        g.x + g.width,
        ...children.map((n) => n.x + n.width + padding),
      ),
      bottom = Math.max(
        g.y + g.height,
        ...children.map((n) => n.y + n.height + padding),
      ),
      left = Math.min(g.x, ...children.map((n) => n.x - padding)),
      top = Math.min(g.y, ...children.map((n) => n.y - header));
    g.x = left;
    g.y = top;
    g.width = right - left;
    g.height = bottom - top;
  }
  const edges = distributeBlockConnectionPorts(parsed.edges, nodes, groups);
  return {
    ...parsed,
    nodes,
    subgraphs: groups,
    edges,
  };
}
/** Native semantic gestures use the same minimal Source commands. Spatial
 * readback never supplies parent/order and move/resize writes no Source. */
export function applyBlockGfxVisualToSource(
  source: string,
  visual: MermaidVisualModel,
) {
  let model = readBlockProjectionModel(source, visual);
  if (!model) throw new Error("Invalid Block Source");
  const apply = (
    r: import("../../engine/block/writer.js").BlockCommandResult,
  ) => {
    if (r.status === "rejected")
      throw new Error(r.diagnostic ?? "Rejected Block command");
    model = r.model;
  };
  for (const n of visual.nodes) {
    const b = blockProjectionBinding(n),
      original = b && model.nodes.find((x) => x.sourceKey === b.sourceKey);
    if (original && original.label !== n.label)
      apply(updateBlock(model, original.sourceKey, { label: n.label }));
  }
  for (const g of visual.subgraphs ?? []) {
    const original = model.groups.find((x) => x.sourceKey === g.id);
    if (original && original.label !== g.title)
      apply(updateBlock(model, original.sourceKey, { label: g.title }));
  }
  for (const e of visual.edges) {
    const original = model.edges.find((x) => x.sourceKey === e.id),
      from = blockProjectionBinding(
        [...visual.nodes, ...(visual.subgraphs ?? [])].find(
          (n) => n.id === e.source,
        ) ?? {},
      )?.sourceId,
      to = blockProjectionBinding(
        [...visual.nodes, ...(visual.subgraphs ?? [])].find(
          (n) => n.id === e.target,
        ) ?? {},
      )?.sourceId;
    if (!from || !to) continue;
    if (original)
      apply(updateBlockConnection(model, e.id, { from, to, label: e.label }));
    else
      apply(
        addBlockConnection(model, { from, to, label: e.label, token: "-->" }),
      );
  }
  return {
    source: model.sourceDocument.source,
    visualModel: reconcileBlockVisual(blockModelToVisual(model), visual),
    diagnostics: [],
  };
}
export function blockGeometrySelection(
  model: MermaidVisualModel,
  ids: readonly string[],
) {
  const selected = new Set(ids);
  for (let changed = true; changed;) {
    changed = false;
    for (const g of model.subgraphs ?? [])
      if (selected.has(g.id))
        for (const n of [...model.nodes, ...(model.subgraphs ?? [])])
          if (
            g.nodeIds.includes(n.id) ||
            ("parentId" in n && n.parentId === g.id)
          ) {
            if (!selected.has(n.id)) {
              selected.add(n.id);
              changed = true;
            }
          }
  }
  return [...selected];
}
export function reconcileBlockGeometryGesture(
  before: MermaidVisualModel,
  after: MermaidVisualModel,
) {
  const objects = [...after.nodes, ...(after.subgraphs ?? [])],
    old = new Map(
      [...before.nodes, ...(before.subgraphs ?? [])].map((n) => [n.id, n]),
    );
  for (const g of before.subgraphs ?? []) {
    const next = after.subgraphs?.find((n) => n.id === g.id);
    if (!next || next.width !== g.width || next.height !== g.height) continue;
    const dx = next.x - g.x,
      dy = next.y - g.y;
    if (!dx && !dy) continue;
    for (const id of blockGeometrySelection(before, [g.id])) {
      if (id === g.id) continue;
      const n = objects.find((n) => n.id === id),
        prior = old.get(id);
      if (n && prior && n.x === prior.x && n.y === prior.y) {
        n.x += dx;
        n.y += dy;
      }
    }
  }
  return reconcileBlockVisual(after, after);
}
