// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { scanStateSource } from "../../engine/state/source-document.js";
import { hashMermaidSource } from "../../utils.js";
import {
  resolveMermaidStateSource,
  setStateHeading,
  editStateTransition,
  addStateTransition,
  editStateNote,
  type StateCommandResult,
  type StateComment,
} from "../../engine/state/index.js";

import {
  stateProjectionBinding,
  stateRecordBindings,
  type StateRecordBinding,
} from "./gfx-data.js";
import { mermaidVisualFamilyPayload } from "../runtime/gfx-family-data.js";
import { stateModelToVisual } from "./visual-model.js";
import { stateDisplayText } from "../../engine/state/source-document.js";
import { normalizeStateNodeDimensions } from "./state-projection.js";
import { distributeMermaidPorts } from "../runtime/graph-ports.js";
import { stateNoteSafePorts } from "./transition-projection.js";
import type { MermaidGfxJsonValue } from "../runtime/gfx-family-data.js";

/** Reserve exact unchanged records before unique relocated signatures. Raw
 * Source is scanned once, then the single parser consumes advanced bindings. */
export function readStateProjectionModel(
  source: string,
  visual?: MermaidVisualModel,
) {
  const records = scanStateSource(source).records,
    bindings = visual ? stateRecordBindings(visual) : [],
    mapping = new Map<number, string>(),
    used = new Set<string>();
  const hashes = records.map((r) => hashMermaidSource(r.raw)),
    counts = new Map<string, number>(),
    byHash = new Map<string, StateRecordBinding[]>(),
    byRange = new Map<string, StateRecordBinding[]>();
  for (const h of hashes) counts.set(h, (counts.get(h) ?? 0) + 1);
  for (const b of bindings) {
    byHash.set(b.hash, [...(byHash.get(b.hash) ?? []), b]);
    const key = `${b.start}:${b.end}:${b.hash}`;
    byRange.set(key, [...(byRange.get(key) ?? []), b]);
  }
  for (const [i, r] of records.entries()) {
    const hash = hashes[i]!;
    let candidates = (
      byRange.get(`${r.range.start}:${r.range.end}:${hash}`) ?? []
    ).filter((b) => !used.has(b.key));
    if (
      !candidates.length &&
      counts.get(hash) === 1 &&
      byHash.get(hash)?.length === 1
    )
      candidates = byHash.get(hash)!.filter((b) => !used.has(b.key));
    if (candidates.length === 1) {
      mapping.set(r.range.start, candidates[0]!.key);
      used.add(candidates[0]!.key);
    }
  }
  const keys = new Map<string, string>();
  for (const n of [...(visual?.nodes ?? []), ...(visual?.subgraphs ?? [])]) {
    const b = stateProjectionBinding(n);
    if (b && (b.role === "state" || b.role === "composite"))
      keys.set(b.sourceId, b.sourceKey);
    // Existing source-owned element IDs may be retained during the cutover;
    // technical bindings are materialized normally, never migrated speculatively.
    else if (
      !b &&
      (mermaidVisualFamilyPayload(n.familyData, "state")?.role === "node" ||
        "nodeIds" in n)
    )
      keys.set(n.id, n.id);
  }
  const payload =
      visual && mermaidVisualFamilyPayload(visual.familyData, "state"),
    objects = payload?.objects;
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
  const anchors = new Map<
    string,
    Pick<StateComment, "anchorKind" | "anchorId" | "position">
  >();
  if (Array.isArray(payload?.comments))
    for (const c of payload.comments)
      if (
        c &&
        typeof c === "object" &&
        !Array.isArray(c) &&
        typeof c.key === "string" &&
        typeof c.anchorKind === "string" &&
        ["before", "after", "inside"].includes(String(c.position))
      )
        anchors.set(c.key, {
          anchorKind: c.anchorKind as StateComment["anchorKind"],
          anchorId: typeof c.anchorId === "string" ? c.anchorId : undefined,
          position: c.position as StateComment["position"],
        });
  return resolveMermaidStateSource(source, undefined, mapping, keys, anchors)
    .model;
}
/** Fresh Source owns semantics; checked candidate bindings own retained edit
 * identities. A cold parse must not replace UUIDs allocated by the writer. */
export function canonicalizeStateVisual(
  parsed: MermaidVisualModel,
  requested: MermaidVisualModel,
): MermaidVisualModel {
  const requestedRecords = new Map(
    stateRecordBindings(requested).map((r) => [
      `${r.kind}:${r.start}:${r.end}:${r.hash}`,
      r.key,
    ]),
  );
  const keys = new Map(
    stateRecordBindings(parsed).map((r) => [
      r.key,
      requestedRecords.get(`${r.kind}:${r.start}:${r.end}:${r.hash}`) ?? r.key,
    ]),
  );
  const remap = (key: string): string => {
    if (keys.has(key)) return keys.get(key)!;
    // Derived description and primary-region keys follow their Source record.
    for (const [from, to] of keys)
      if (key.startsWith(from + ":")) return to + key.slice(from.length);
    return key;
  };
  const sourceId = (id: string) => {
    for (const kind of ["start", "end"])
      if (id.startsWith(`${kind}-`))
        return `${kind}-${remap(id.slice(kind.length + 1))}`;
    return remap(id);
  };
  const objects = [...requested.nodes, ...(requested.subgraphs ?? [])];
  for (const item of [...parsed.nodes, ...(parsed.subgraphs ?? [])]) {
    const b = stateProjectionBinding(item);
    if (!b) continue;
    const previous = objects.find((o) => {
      const ob = stateProjectionBinding(o);
      return ob?.role === b.role && ob.sourceId === sourceId(b.sourceId);
    });
    if (previous) keys.set(item.id, previous.id);
  }
  const requestedComments = mermaidVisualFamilyPayload(
    requested.familyData,
    "state",
  )?.comments;
  const commentAnchors = new Map(
    (Array.isArray(requestedComments) ? requestedComments : []).flatMap((c) =>
      c &&
      typeof c === "object" &&
      !Array.isArray(c) &&
      typeof c.key === "string"
        ? [[c.key, c] as const]
        : [],
    ),
  );
  const technicalFields = new Set([
    "key",
    "sourceKey",
    "recordKey",
    "anchorId",
    "regionKey",
    "previousKey",
  ]);
  const remapValue = (
    value: MermaidGfxJsonValue,
    field?: string,
  ): MermaidGfxJsonValue => {
    if (typeof value === "string")
      return technicalFields.has(field ?? "")
        ? remap(value)
        : ["sourceId", "from", "to"].includes(field ?? "")
          ? sourceId(value)
          : value;
    if (Array.isArray(value)) return value.map((v) => remapValue(v));
    if (value && typeof value === "object") {
      const result = Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [
          name,
          remapValue(entry, name),
        ]),
      );
      // Comment anchoring is a checked Source binding, not a new adjacency guess.
      const c =
        typeof result.key === "string" && "anchorKind" in result
          ? commentAnchors.get(result.key)
          : undefined;
      return c
        ? {
            ...result,
            anchorKind: c.anchorKind!,
            anchorId: c.anchorId ?? null,
            position: c.position!,
          }
        : result;
    }
    return value;
  };
  const payload = (
    data: MermaidVisualModel["familyData"],
  ): MermaidVisualModel["familyData"] =>
    data
      ? {
          ...data,
          payload: remapValue(data.payload) as Record<
            string,
            MermaidGfxJsonValue
          >,
        }
      : data;
  return reconcileStateVisual(
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
/** Live coordinates survive record counts and ordering changes. Containers
 * protect their actual children; no geometric containment becomes membership. */
export function reconcileStateVisual(
  parsed: MermaidVisualModel,
  stored: MermaidVisualModel,
  reuse = true,
  reflowScopes: readonly string[] = [],
): MermaidVisualModel {
  if (
    !reuse ||
    parsed.direction !== stored.direction ||
    parsed.diagramType !== stored.diagramType
  )
    return parsed;
  const sourceGroups = parsed.subgraphs ?? [],
    byGroupId = new Map(sourceGroups.map((g) => [g.id, g])),
    bySourceId = new Map(
      sourceGroups.map((g) => [stateProjectionBinding(g)?.sourceId, g]),
    ),
    oldGroups = new Map((stored.subgraphs ?? []).map((g) => [g.id, g])),
    oldBySourceId = new Map(
      (stored.subgraphs ?? []).map((g) => [
        stateProjectionBinding(g)?.sourceId,
        g,
      ]),
    );
  const layoutScopes = new Set([
    ...reflowScopes,
    ...sourceGroups
      .filter((g) => {
        const old = oldGroups.get(g.id);
        return old && (g.direction ?? "TB") !== (old.direction ?? "TB");
      })
      .map((g) => g.id),
  ]);
  // A Source ID rename retains the technical parent identity and manual XY.
  const sameMembership = (
    a: ReturnType<typeof stateProjectionBinding>,
    b: ReturnType<typeof stateProjectionBinding>,
  ) =>
    (bySourceId.get(a?.parentId ?? undefined)?.id ?? a?.parentId) ===
      (oldBySourceId.get(b?.parentId ?? undefined)?.id ?? b?.parentId) &&
    a?.regionKey === b?.regionKey;
  const noteTargetKey = (model: MermaidVisualModel, sourceId: unknown) =>
    [...model.nodes, ...(model.subgraphs ?? [])].find(
      (n) => stateProjectionBinding(n)?.sourceId === sourceId,
    )?.id ?? sourceId;
  const reflowRoot = (id: string): string | undefined => {
    const g = byGroupId.get(id);
    return layoutScopes.has(id)
      ? id
      : g?.parentId
        ? reflowRoot(g.parentId)
        : undefined;
  };
  const placedGroups = new Map<
    string,
    NonNullable<MermaidVisualModel["subgraphs"]>[number]
  >();
  const placeGroup = (
    id: string,
  ): NonNullable<MermaidVisualModel["subgraphs"]>[number] => {
    const cached = placedGroups.get(id);
    if (cached) return cached;
    const g = byGroupId.get(id)!,
      old = oldGroups.get(id),
      root = reflowRoot(id);
    const parent = g.parentId ? placeGroup(g.parentId) : undefined,
      sourceParent = g.parentId ? byGroupId.get(g.parentId) : undefined,
      oldParent = g.parentId ? oldGroups.get(g.parentId) : undefined;
    let x: number, y: number;
    if (
      old &&
      (root === id ||
        (!root &&
          sameMembership(
            stateProjectionBinding(g),
            stateProjectionBinding(old),
          )))
    ) {
      x = old.x + (parent && oldParent ? parent.x - oldParent.x : 0);
      y = old.y + (parent && oldParent ? parent.y - oldParent.y : 0);
    } else {
      x = g.x + (parent && sourceParent ? parent.x - sourceParent.x : 0);
      y = g.y + (parent && sourceParent ? parent.y - sourceParent.y : 0);
    }
    const value = {
      ...g,
      x,
      y,
      width: root ? g.width : Math.max(g.width, old?.width ?? 0),
      height: root ? g.height : Math.max(g.height, old?.height ?? 0),
    };
    placedGroups.set(id, value);
    return value;
  };
  for (const g of sourceGroups) placeGroup(g.id);
  const storedNodes = new Map(stored.nodes.map((n) => [n.id, n]));
  const nodes = parsed.nodes.map((n) => {
    const b = stateProjectionBinding(n),
      old =
        storedNodes.get(n.id) ??
        stored.nodes.find(
          (o) => !stateProjectionBinding(o) && o.id === b?.sourceId,
        ),
      parent = bySourceId.get(b?.parentId ?? undefined),
      placedParent = parent && placedGroups.get(parent.id),
      oldParent = parent && oldGroups.get(parent.id),
      reflow = parent && reflowRoot(parent.id);
    const data = mermaidVisualFamilyPayload(n.familyData, "state"),
      previousData = old && mermaidVisualFamilyPayload(old.familyData, "state"),
      noteTargetChanged =
        b?.role === "note" &&
        noteTargetKey(parsed, data?.noteStateId) !==
          noteTargetKey(stored, previousData?.noteStateId);
    const keep =
      old &&
      !reflow &&
      sameMembership(b, stateProjectionBinding(old)) &&
      !noteTargetChanged;
    return normalizeStateNodeDimensions({
      ...n,
      x: keep
        ? old.x + (placedParent && oldParent ? placedParent.x - oldParent.x : 0)
        : n.x + (placedParent && parent ? placedParent.x - parent.x : 0),
      y: keep
        ? old.y + (placedParent && oldParent ? placedParent.y - oldParent.y : 0)
        : n.y + (placedParent && parent ? placedParent.y - parent.y : 0),
      width:
        b?.role === "region" || !old || reflow
          ? n.width
          : Math.max(n.width, old.width),
      height:
        b?.role === "region" || !old || reflow
          ? n.height
          : Math.max(n.height, old.height),
    });
  });
  // Attached notes follow an explicitly changed attachment, including a target
  // whose live position differs from its cold Source layout.
  for (const note of nodes) {
    const data = mermaidVisualFamilyPayload(note.familyData, "state"),
      old = storedNodes.get(note.id),
      oldData = old && mermaidVisualFamilyPayload(old.familyData, "state");
    if (
      !data?.noteStateId ||
      (old &&
        noteTargetKey(stored, oldData?.noteStateId) ===
          noteTargetKey(parsed, data.noteStateId))
    )
      continue;
    const target =
        nodes.find(
          (n) => stateProjectionBinding(n)?.sourceId === data.noteStateId,
        ) ??
        [...placedGroups.values()].find(
          (g) => stateProjectionBinding(g)?.sourceId === data.noteStateId,
        ),
      coldTarget = [...parsed.nodes, ...sourceGroups].find(
        (n) => stateProjectionBinding(n)?.sourceId === data.noteStateId,
      ),
      coldNote = parsed.nodes.find((n) => n.id === note.id);
    if (target && coldTarget && coldNote) {
      note.x = coldNote.x + target.x - coldTarget.x;
      note.y = coldNote.y + target.y - coldTarget.y;
    }
  }
  const groups: NonNullable<MermaidVisualModel["subgraphs"]> = [];
  for (const original of [...sourceGroups].reverse()) {
    const g = placedGroups.get(original.id)!,
      b = stateProjectionBinding(g),
      padding = b?.padding ?? 0,
      header = b?.headerHeight ?? 0,
      children = [
        ...nodes.filter(
          (n) =>
            g.nodeIds.includes(n.id) &&
            stateProjectionBinding(n)?.role !== "region",
        ),
        ...groups.filter((c) => c.parentId === g.id),
      ];
    // Extending the enclosing frame must not move the authored child geometry.
    const x = Math.min(g.x, ...children.map((n) => n.x - padding)),
      y = Math.min(g.y, ...children.map((n) => n.y - header - padding));
    const width =
        Math.max(
          g.x + g.width,
          ...children.map((n) => n.x + n.width + padding),
        ) - x,
      height =
        Math.max(
          g.y + g.height,
          ...children.map((n) => n.y + n.height + padding),
        ) - y;
    groups.push({ ...g, x, y, width, height });
  }
  for (const node of nodes.filter(
    (n) => stateProjectionBinding(n)?.role === "region",
  )) {
    const parent = groups.find(
      (g) =>
        stateProjectionBinding(g)?.sourceId ===
        stateProjectionBinding(node)?.parentId,
    );
    if (parent) {
      const padding = stateProjectionBinding(parent)?.padding ?? 0;
      node.x = parent.x + padding;
      node.width = Math.max(1, parent.width - padding * 2);
    }
  }
  const byEdgeId = new Map(stored.edges.map((e) => [e.id, e]));
  const edges = distributeMermaidPorts(parsed.edges, nodes, groups).map((e) => {
    const old = byEdgeId.get(e.id);
    return old && old.source === e.source && old.target === e.target
      ? {
          ...e,
          sourcePosition: old.sourcePosition ?? e.sourcePosition,
          targetPosition: old.targetPosition ?? e.targetPosition,
        }
      : e;
  });
  return {
    ...parsed,
    nodes,
    subgraphs: groups.reverse(),
    edges: stateNoteSafePorts(edges, nodes, groups),
  };
}
/** Native gesture changes have the same checked record writer as typed forms.
 * XY, size, containment and array order never produce semantic Source edits. */
export function applyStateGfxVisualToSource(
  source: string,
  visual: MermaidVisualModel,
) {
  let model = readStateProjectionModel(source, visual);
  if (!model) throw new Error("Invalid State Source");
  const apply = (result: StateCommandResult) => {
    if (result.status === "rejected")
      throw new Error(result.diagnostic ?? "Rejected State mutation");
    model = result.model;
  };
  for (const node of visual.nodes) {
    const b = stateProjectionBinding(node);
    if (b?.role === "state") {
      const state = model.states.find((s) => s.sourceKey === b.sourceKey);
      if (state?.kind === "state" && state.label !== node.label)
        apply(
          setStateHeading(model, b.sourceKey, stateDisplayText(node.label)),
        );
    } else if (b?.role === "note") {
      const note = model.notes.find((n) => n.id === b.sourceKey);
      if (note && note.label !== node.label)
        apply(
          editStateNote(model, note.id, {
            form: note.form!,
            text: stateDisplayText(node.label),
            target: note.stateId,
            floatingId: note.floatingId,
            side: note.placement,
          }),
        );
    }
  }
  const endpoint = (key: string) =>
    stateProjectionBinding(
      [...visual.nodes, ...(visual.subgraphs ?? [])].find(
        (n) => n.id === key,
      ) ?? {},
    )?.sourceId;
  for (const edge of visual.edges) {
    const from = endpoint(edge.source),
      to = endpoint(edge.target);
    if (!from || !to) continue;
    const original = model.transitions.find((t) => t.id === edge.id);
    if (original)
      apply(
        editStateTransition(model, edge.id, {
          from,
          to,
          label: stateDisplayText(edge.label),
          fromClass: original.fromClass,
          toClass: original.toClass,
        }),
      );
    else {
      const b = stateProjectionBinding(
        visual.nodes.find((n) => n.id === edge.source) ??
          visual.subgraphs?.find((n) => n.id === edge.source) ??
          {},
      );
      apply(
        addStateTransition(model, {
          sourceKey: edge.id,
          from,
          to,
          label: stateDisplayText(edge.label),
          anchor: { parentId: b?.parentId, regionKey: b?.regionKey },
        }),
      );
    }
  }
  for (const g of visual.subgraphs ?? []) {
    const b = stateProjectionBinding(g),
      node = model.composites.find((c) => c.sourceKey === b?.sourceKey);
    if (node && node.label !== g.title)
      apply(setStateHeading(model, node.sourceKey!, stateDisplayText(g.title)));
  }
  const projected = stateModelToVisual(model);
  return {
    source: model.sourceDocument.source,
    diagnostics: [],
    visualModel: reconcileStateVisual(projected, visual),
  };
}
