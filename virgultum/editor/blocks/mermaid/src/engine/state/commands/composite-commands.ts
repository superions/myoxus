// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidStateModel, MermaidStateDirection } from "../model.js";
import type { StateSourceRecord } from "../source-document.js";
import {
  nextStateSourceKey,
  stateRenderReferences,
} from "../source-document.js";
import { mermaidMessages as m } from "../../../i18n.js";
import {
  stateObject,
  setStateHeading,
  renameStateId,
  deleteStateObjects,
} from "./state-commands.js";
import {
  stateRecord,
  stateRecordEnd,
  stateNoChange,
  stateInsertAnchor,
  stateNewRecordPatch,
  stateTextValue,
  stateSourceIdValue,
  stateSpan,
  stateRecordGroup,
  stateRelocateRecords,
  stateImpact,
  composeStateCommandResults,
  writeStatePatches,
  type StateInsertAnchor,
  type StateWriteOptions,
  type StatePatch,
} from "../writer.js";

export function stateCompositeRecord(model: MermaidStateModel, key: string) {
  const c = model.composites.find((c) => c.sourceKey === key || c.id === key);
  return c?.recordKeys
    ?.map((k) => stateRecord(model, k))
    .find((r) => r?.kind === "composite");
}
function objectRecords(model: MermaidStateModel, key: string) {
  const node = stateObject(model, key);
  if (!node) return [];
  const records: StateSourceRecord[] = [];
  for (const k of node.recordKeys ?? []) {
    const r = stateRecord(model, k);
    if (!r) continue;
    records.push(
      ...(r.kind === "composite"
        ? stateSpan(model, k)
        : stateRecordGroup(model, k))!.records,
    );
  }
  for (const note of model.notes.filter((n) => n.stateId === node.id))
    records.push(...stateRecordGroup(model, note.id)!.records);
  return [...new Set(records)];
}
export function stateCompositeSelectionAllowed(
  model: MermaidStateModel,
  keys: readonly string[],
) {
  const nodes = keys.map((key) => stateObject(model, key));
  return (
    keys.length >= 2 &&
    new Set(keys).size === keys.length &&
    nodes.every((n) => n && "kind" in n) &&
    nodes.every(
      (n) =>
        n!.parentId === nodes[0]!.parentId &&
        n!.regionKey === nodes[0]!.regionKey,
    ) &&
    nodes.every(
      (node) =>
        !node ||
        !("kind" in node) ||
        (node.kind !== "start" && node.kind !== "end") ||
        model.transitions
          .filter((t) => node.relationKeys?.includes(t.id))
          .every(
            (t) =>
              nodes.some((n) => n?.id === t.from) &&
              nodes.some((n) => n?.id === t.to) &&
              t.parentId === node.parentId &&
              t.regionKey === node.regionKey,
          ),
    )
  );
}
export function addStateComposite(
  model: MermaidStateModel,
  value: {
    id: string;
    label?: string;
    anchor?: StateInsertAnchor;
    selection?: readonly string[];
  },
  options: StateWriteOptions = {},
) {
  const nodes = (value.selection ?? []).map((k) => stateObject(model, k));
  if (
    !stateSourceIdValue(
      value.id,
      value.label === undefined ? "state" : "composite-alias",
    ) ||
    stateObject(model, value.id) ||
    (value.selection && !stateCompositeSelectionAllowed(model, value.selection))
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const records = nodes.flatMap((n) => objectRecords(model, n!.sourceKey!));
  const ids = new Set(nodes.map((n) => n!.id));
  // Only explicitly enclosed internal relations travel with a grouped selection;
  // external statement scopes remain their authored scopes.
  for (const t of model.transitions)
    if (
      ids.has(t.from) &&
      ids.has(t.to) &&
      t.parentId === nodes[0]?.parentId &&
      t.regionKey === nodes[0]?.regionKey
    )
      records.push(...stateRecordGroup(model, t.id)!.records);
  const anchor = value.anchor ?? {
    parentId: nodes[0]?.parentId,
    regionKey: nodes[0]?.regionKey,
  };
  if (
    nodes.length &&
    ((anchor.parentId ?? undefined) !== nodes[0]!.parentId ||
      (anchor.regionKey ?? nodes[0]!.regionKey) !== nodes[0]!.regionKey)
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const at = stateInsertAnchor(model, anchor);
  if (!at) return stateNoChange(model, "invalid", m.classPatchRejected());
  const open = nextStateSourceKey(),
    close = nextStateSourceKey();
  const heading =
    value.label === undefined
      ? value.id
      : `"${stateTextValue(value.label).replaceAll('"', "#34;")}" as ${value.id}`;
  const implicit = nodes
    .filter(
      (n) =>
        !n!.recordKeys?.length &&
        "kind" in n! &&
        n.kind !== "start" &&
        n.kind !== "end",
    )
    .map((n) => `${at.indent}  ${n!.id}`)
    .join(model.sourceDocument.newline);
  const prefix = `${at.indent}state ${heading} {${model.sourceDocument.newline}${implicit}${implicit ? model.sourceDocument.newline : ""}`;
  const patches = stateRelocateRecords(
    model,
    records,
    at.offset,
    prefix,
    `${at.indent}}`,
    [open, close],
  );
  if (!patches) return stateNoChange(model, "invalid", m.classPatchRejected());
  return writeStatePatches(model, patches, {
    ...options,
    stateKeys: new Map(
      model.states.map((node) => [
        ids.has(node.id) &&
        model.diagramType === "stateDiagram-v2" &&
        (node.kind === "start" || node.kind === "end")
          ? `${open}:region::__${node.kind}__`
          : node.id,
        node.sourceKey!,
      ]),
    ),
    impact: stateImpact(model, records),
    selection: value.id,
    focus: value.id,
  });
}
export function editStateComposite(
  model: MermaidStateModel,
  key: string,
  value: { id?: string; label?: string; direction?: MermaidStateDirection },
  options: StateWriteOptions = {},
) {
  const c = model.composites.find((c) => c.sourceKey === key || c.id === key);
  if (!c) return stateNoChange(model, "invalid", m.stateMissingObject());
  let result = writeStatePatches(model, [], options);
  if (value.id !== undefined)
    result = renameStateId(model, key, value.id, options);
  if (result.status === "rejected") return result;
  if (value.label !== undefined)
    result = setStateHeading(result.model, c.sourceKey!, value.label, {
      ...options,
      baseSource: result.source,
    });
  if (result.status === "rejected")
    return stateNoChange(model, result.reason, result.diagnostic);
  if (value.direction !== undefined) {
    if (!["LR", "RL", "TB", "BT"].includes(value.direction))
      return stateNoChange(model, "invalid", m.classPatchRejected());
    const next = result.model;
    const open = stateCompositeRecord(next, c.sourceKey!)!;
    const dir = next.sourceDocument.records.findLast(
      (r) => r.kind === "direction" && r.parentKey === open.sourceKey,
    );
    result = writeStatePatches(
      next,
      dir
        ? [{ range: dir.values.direction!, value: value.direction }]
        : [
            stateNewRecordPatch(
              next,
              stateRecordEnd(open),
              `${open.indent}  direction ${value.direction}`,
            ),
          ],
      {
        ...options,
        baseSource: result.source,
        selection: c.sourceKey,
        focus: c.sourceKey,
      },
    );
  }
  return composeStateCommandResults(model, result, options);
}
export function reparentStateObject(
  model: MermaidStateModel,
  key: string,
  anchor: StateInsertAnchor,
  options: StateWriteOptions = {},
) {
  const node = stateObject(model, key),
    at = stateInsertAnchor(model, anchor);
  if (!node || !at || ("kind" in node && ["start", "end"].includes(node.kind)))
    return stateNoChange(model, "invalid", m.classPatchRejected());
  let parent = anchor.parentId;
  while (parent) {
    if (parent === node.id)
      return stateNoChange(model, "invalid", m.classPatchRejected());
    parent = model.composites.find((c) => c.id === parent)?.parentId;
  }
  const records = objectRecords(model, key);
  const owned = new Set(records);
  // Nested endpoint appearances can override a relocated declaration. External
  // relations move explicitly to root (shown in the impact preview), where they
  // cannot change either endpoint's parent. Preserve implicit neighbour scopes.
  const external = model.sourceDocument.records
    .filter(
      (record) =>
        !owned.has(record) &&
        record.parentId &&
        (record.parentId !== at.parentId ||
          record.regionKey !== at.regionKey) &&
        stateRenderReferences(record).some((ref) => ref.id === node.id),
    )
    .flatMap((record) => stateRecordGroup(model, record.sourceKey)!.records);
  const foreign = [...new Set(external)].filter((record) => !owned.has(record));
  const neighbours = new Map<
    string,
    NonNullable<ReturnType<typeof stateObject>>
  >();
  for (const record of foreign)
    for (const ref of stateRenderReferences(record)) {
      const other = stateObject(model, ref.id);
      if (
        !other ||
        other.id === node.id ||
        !other.parentId ||
        ("kind" in other && ["start", "end"].includes(other.kind)) ||
        neighbours.has(other.id)
      )
        continue;
      neighbours.set(other.id, other);
    }
  const root = stateInsertAnchor(model)!;
  const move = stateRelocateRecords(
    model,
    at.parentId ? records : [...records, ...foreign],
    at.offset,
  );
  const relations =
    at.parentId && foreign.length
      ? stateRelocateRecords(model, foreign, root.offset)
      : [];
  if (!move || !relations)
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const patches = [...move, ...relations];
  if (!node.recordKeys?.length)
    patches.push(
      stateNewRecordPatch(
        model,
        at.offset,
        `${at.indent}${node.id}`,
        nextStateSourceKey(),
      ),
    );
  const writeOptions = {
    ...options,
    impact: stateImpact(model, [...new Set([...records, ...foreign])]),
    selection: node.sourceKey,
    focus: node.sourceKey,
  };
  let result = writeStatePatches(model, patches, writeOptions);
  if (result.status !== "changed") return result;
  for (const other of neighbours.values()) {
    const next = stateObject(result.model, other.sourceKey!);
    if (
      next?.parentId === other.parentId &&
      next?.regionKey === other.regionKey
    )
      continue;
    const scope = stateInsertAnchor(model, {
      parentId: other.parentId,
      regionKey: other.regionKey,
    });
    if (!scope) return stateNoChange(model, "invalid", m.classPatchRejected());
    patches.push(
      stateNewRecordPatch(
        model,
        scope.offset,
        `${scope.indent}${other.id}`,
        nextStateSourceKey(),
      ),
    );
  }
  if (
    patches.length !==
    move.length + relations.length + (node.recordKeys?.length ? 0 : 1)
  )
    result = writeStatePatches(model, patches, writeOptions);
  const moved = stateObject(result.model, node.sourceKey!);
  if (
    result.status === "changed" &&
    ((moved?.parentId ?? null) !== at.parentId ||
      (moved?.regionKey ?? null) !== at.regionKey)
  )
    return stateNoChange(model, "invalid", m.classPatchRejected());
  return result;
}
export function addStateRegion(
  model: MermaidStateModel,
  key: string,
  value?: { regionKey: string; position: "before" | "after" },
  options: StateWriteOptions = {},
) {
  const scope = value && stateRegionRecords(model, value.regionKey);
  const open = scope?.open ?? stateCompositeRecord(model, key),
    close = open?.closeKey && stateRecord(model, open.closeKey);
  if (!open || !close)
    return stateNoChange(model, "invalid", m.stateMissingObject());
  if (value && (!scope || scope.open.ownerId !== open.ownerId))
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const sourceKey = nextStateSourceKey();
  const beforePrimary = Boolean(
    value?.position === "before" && !scope?.divider,
  );
  const transferred = beforePrimary
    ? model.commentRecords.filter(
        (c) =>
          c.anchorKind === "region" &&
          c.anchorId === `${open.sourceKey}:region`,
      )
    : [];
  return writeStatePatches(
    model,
    [
      stateNewRecordPatch(
        model,
        scope
          ? value?.position === "before"
            ? (scope.divider?.range.start ?? scope.start)
            : scope.end
          : close.range.start,
        `${open.indent}  --`,
        sourceKey,
      ),
    ],
    {
      ...options,
      selection: beforePrimary ? `${open.sourceKey}:region` : sourceKey,
      focus: beforePrimary ? `${open.sourceKey}:region` : sourceKey,
      commentTransfers: new Set(transferred.map((c) => c.id)),
      commentAnchors: new Map(
        transferred.map((c) => [c.id, { ...c, anchorId: sourceKey }]),
      ),
      ...(beforePrimary
        ? {
            stateKeys: stateRegionObjectKeys(
              model,
              new Map([[`${open.sourceKey}:region`, sourceKey]]),
            ),
          }
        : {}),
    },
  );
}
function stateRegionObjectKeys(
  model: MermaidStateModel,
  regions: ReadonlyMap<string, string>,
) {
  return new Map(
    [...model.states, ...model.composites].map((n) => {
      const region = n.regionKey && regions.get(n.regionKey);
      const id =
        region &&
        "kind" in n &&
        (n.kind === "start" || n.kind === "end") &&
        model.diagramType === "stateDiagram-v2"
          ? `${region}::__${n.kind}__`
          : n.id;
      return [id, n.sourceKey!] as const;
    }),
  );
}
export function stateRegionRecords(model: MermaidStateModel, key: string) {
  const region = model.regions.find((r) => r.id === key);
  const open = region
    ? stateRecord(model, stateRecord(model, region.id)!.parentKey!)
    : model.sourceDocument.records.find(
        (r) => `${r.sourceKey}:region` === key && r.kind === "composite",
      );
  if (!open) return null;
  const start = region
    ? stateRecordEnd(stateRecord(model, key)!)
    : stateRecordEnd(open);
  const next = model.sourceDocument.records.find(
    (r) =>
      r.parentKey === open.sourceKey &&
      r.kind === "region" &&
      r.range.start >= start,
  );
  const end =
    next?.range.start ?? stateRecord(model, open.closeKey!)!.range.start;
  return {
    open,
    divider: region ? stateRecord(model, key)! : null,
    start,
    end,
    records: model.sourceDocument.records.filter(
      (r) => r.range.start >= start && r.range.start < end,
    ),
  };
}
/** Divider keys identify the following region. Reordering swaps complete bodies
 * and remaps those dividers; primary scope still uses its opener's stable key. */
export function reorderStateRegion(
  model: MermaidStateModel,
  key: string,
  beforeKey: string,
  options: StateWriteOptions = {},
) {
  const from = stateRegionRecords(model, key),
    to = stateRegionRecords(model, beforeKey);
  if (!from || !to || from.open.sourceKey !== to.open.sourceKey)
    return stateNoChange(model, "invalid", m.classPatchRejected());
  if (key === beforeKey) return writeStatePatches(model, [], options);
  // Moving a primary region requires changing which body follows the opener;
  // the divider between the exchanged bodies remains an explicit Source record.
  const scopes = [
    `${from.open.sourceKey}:region`,
    ...model.regions
      .filter((r) => r.compositeId === from.open.ownerId)
      .filter(
        (r) => stateRecord(model, r.id)!.parentKey === from.open.sourceKey,
      )
      .map((r) => r.id),
  ];
  const reordered = scopes.filter((k) => k !== key);
  reordered.splice(reordered.indexOf(beforeKey), 0, key);
  if (reordered.every((k, index) => k === scopes[index]))
    return writeStatePatches(model, [], options);
  const primary = scopes[0]!;
  const regionKeys = new Map(
    scopes.map((k) => [
      k,
      reordered[0] === k ? primary : k === primary ? reordered[0]! : k,
    ]),
  );
  const regionComments = model.commentRecords.filter(
    (c) =>
      c.anchorKind === "region" && c.anchorId && regionKeys.has(c.anchorId),
  );
  const movedComments = new Set(regionComments.map((c) => c.id));
  let text = "";
  const identities: Array<readonly [number, string]> = [];
  const append = (r: StateSourceRecord) => {
    identities.push([text.length, r.sourceKey]);
    text += r.raw + r.eol;
    if (!r.eol) text += model.sourceDocument.newline;
  };
  for (const [i, k] of reordered.entries()) {
    const scope = stateRegionRecords(model, k)!;
    const comments = regionComments.filter((c) => c.anchorId === k);
    const before = comments.filter((c) => c.position === "before");
    const after = comments.filter((c) => c.position !== "before");
    if (i > 0) {
      for (const c of before) append(stateRecord(model, c.id)!);
      const dividerKey = regionKeys.get(k)!;
      const divider = stateRecord(model, dividerKey)!;
      append(divider);
    }
    for (const c of i === 0 ? comments : after)
      append(stateRecord(model, c.id)!);
    for (const r of scope.records) {
      if (!movedComments.has(r.sourceKey)) append(r);
    }
    if (text && !/[\r\n]$/.test(text)) text += model.sourceDocument.newline;
  }
  const start = stateRecordEnd(from.open),
    end = stateRecord(model, from.open.closeKey!)!.range.start;
  const result = writeStatePatches(
    model,
    [{ range: { start, end }, value: text, identities }],
    {
      ...options,
      selection: regionKeys.get(key),
      focus: regionKeys.get(key),
      stateKeys: stateRegionObjectKeys(model, regionKeys),
      commentTransfers: movedComments,
      commentAnchors: new Map(
        regionComments.map((c) => [
          c.id,
          { ...c, anchorId: regionKeys.get(c.anchorId!) },
        ]),
      ),
      impact: stateImpact(
        model,
        model.sourceDocument.records.filter(
          (r) => r.range.start >= start && r.range.start < end,
        ),
      ),
    },
  );
  return { ...result, remap: new Map([...result.remap, ...regionKeys]) };
}
export function deleteStateRegion(
  model: MermaidStateModel,
  key: string,
  value: { children: "delete" | "reassign"; targetRegion?: string },
  options: StateWriteOptions = {},
) {
  const scope = stateRegionRecords(model, key);
  if (!scope?.divider)
    return stateNoChange(model, "invalid", m.classPatchRejected());
  if (value.children === "reassign") {
    const target =
      value.targetRegion && stateRegionRecords(model, value.targetRegion);
    if (
      !target ||
      target.open.sourceKey !== scope.open.sourceKey ||
      value.targetRegion === key
    )
      return stateNoChange(model, "invalid", m.classPatchRejected());
    const moves = stateRelocateRecords(model, scope.records, target.end);
    if (!moves) return stateNoChange(model, "invalid", m.classPatchRejected());
    return writeStatePatches(
      model,
      [
        ...moves,
        {
          range: {
            start: scope.divider.range.start,
            end: stateRecordEnd(scope.divider),
          },
          value: "",
        },
      ],
      {
        ...options,
        removed: new Set([key]),
        commentTransfers: new Set(
          model.commentRecords
            .filter((c) => c.anchorId === key)
            .map((c) => c.id),
        ),
        impact: stateImpact(model, [scope.divider, ...scope.records]),
        selection: value.targetRegion,
      },
    );
  }
  if (value.children !== "delete")
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const ids = descendantIds(
    model,
    [...model.states, ...model.composites]
      .filter((n) => n.parentId === scope.open.ownerId && n.regionKey === key)
      .map((n) => n.id),
  );
  return deleteStateObjects(
    model,
    [...ids],
    [
      ...scope.records.filter(
        (r) => !["style", "class-assignment"].includes(r.kind),
      ),
      scope.divider,
    ],
    options,
  );
}
function descendantIds(model: MermaidStateModel, roots: readonly string[]) {
  const ids = new Set(roots);
  let added = true;
  while (added) {
    added = false;
    for (const n of [...model.states, ...model.composites])
      if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) {
        ids.add(n.id);
        added = true;
      }
  }
  return ids;
}
export function deleteStateComposite(
  model: MermaidStateModel,
  key: string,
  value: { children: "delete" | "reassign"; anchor?: StateInsertAnchor },
  options: StateWriteOptions = {},
) {
  const open = stateCompositeRecord(model, key),
    node = open && stateObject(model, open.ownerId!);
  if (!open || !node)
    return stateNoChange(model, "invalid", m.stateMissingObject());
  const openers = (node.recordKeys ?? []).flatMap((key) => {
    const record = stateRecord(model, key);
    return record?.kind === "composite" ? [record] : [];
  });
  const spans = openers.map((record) => stateSpan(model, record.sourceKey)!);
  const records = spans.flatMap((span) => span.records);
  if (value.children === "reassign") {
    const at = stateInsertAnchor(
      model,
      value.anchor ?? {
        parentId: node.parentId,
        regionKey: node.regionKey,
        beforeKey: open.sourceKey,
      },
    );
    if (
      !at ||
      spans.some(
        (span) => at.offset > span.range.start && at.offset < span.range.end,
      )
    )
      return stateNoChange(model, "invalid", m.classPatchRejected());
    const body = records.filter(
      (r) =>
        !openers.some(
          (open) =>
            r.sourceKey === open.sourceKey || r.sourceKey === open.closeKey,
        ) &&
        !(r.parentId === node.id && ["region", "direction"].includes(r.kind)),
    );
    const moves = stateRelocateRecords(model, body, at.offset);
    if (!moves) return stateNoChange(model, "invalid", m.classPatchRejected());
    const removedRecords = records.filter((r) => !body.includes(r));
    const patches: StatePatch[] = [
      ...moves,
      ...removedRecords.map((r) => ({
        range: { start: r.range.start, end: stateRecordEnd(r) },
        value: "",
      })),
    ];
    const moved = writeStatePatches(model, patches, {
      ...options,
      removed: new Set(removedRecords.map((r) => r.sourceKey)),
      commentTransfers: new Set(
        model.commentRecords
          .filter(
            (c) =>
              c.anchorId === node.sourceKey ||
              removedRecords.some((r) => r.sourceKey === c.anchorId),
          )
          .map((c) => c.id),
      ),
      impact: stateImpact(model, records),
    });
    if (moved.status === "rejected") return moved;
    const deleted = deleteStateObjects(moved.model, [node.id], [], {
      ...options,
      baseSource: moved.source,
    });
    return composeStateCommandResults(
      model,
      {
        ...deleted,
        impact: {
          records: [...moved.impact.records, ...deleted.impact.records],
        },
      },
      options,
    );
  }
  if (value.children !== "delete")
    return stateNoChange(model, "invalid", m.classPatchRejected());
  const ids = descendantIds(model, [node.id]);
  // Preserve useful comments and global class definitions; only records owned
  // by the explicit subtree and references into it belong to this deletion.
  return deleteStateObjects(
    model,
    [...ids],
    records.filter((r) => !["style", "class-assignment"].includes(r.kind)),
    options,
  );
}
