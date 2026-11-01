// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidBlockDiagramModel } from "../model.js";
import { isBlockColumns } from "../config.js";
import {
  blockNoChange,
  writeBlockPatches,
  type BlockWriteOptions,
  type BlockPatch,
} from "../writer.js";
import {
  isBlockNode,
  isBlockGroup,
  blockItems,
  blockRecord,
  blockUnitRange,
  blockInsertion,
  blockParentCanContain,
  blockDeletionPatches,
  materializeBlockEndpoints,
} from "./block-commands.js";
import { editBlockMetadata } from "./metadata-commands.js";
export function updateBlockColumns(
  m: MermaidBlockDiagramModel,
  parent: string | null,
  columns: number,
  o: BlockWriteOptions = {},
) {
  if (!isBlockColumns(columns)) return blockNoChange(m, "invalid");
  const group = parent
    ? m.groups.find((g) => g.sourceKey === parent || g.bodyKey === parent)
    : null;
  if (parent && !group) return blockNoChange(m, "invalid");
  const key = group ? group.columnsKey : m.columnsKey,
    value = columns === -1 ? "auto" : String(columns);
  const record = key ? blockRecord(m, key) : null;
  let patch: BlockPatch;
  if (record) patch = { range: record.values.columns!, value };
  else {
    const anchor = group
      ? blockRecord(m, group.bodyKey)!
      : m.sourceDocument.records.find((r) => r.kind === "header")!;
    const start = anchor.range.end + anchor.eol.length;
    patch = {
      range: { start, end: start },
      value: `${anchor.eol ? "" : m.sourceDocument.newline}${anchor.indent}${group ? "  " : ""}columns ${value}${m.sourceDocument.newline}`,
    };
  }
  return writeBlockPatches(m, [patch], {
    ...o,
    impact: { records: [], grids: [group?.bodyKey ?? null] },
  });
}
/** Move explicit Source units with their comments. Free geometry has no engine
 * command; this path is reached only through a confirmed grid/parent action. */
export function reorderBlockItem(
  m: MermaidBlockDiagramModel,
  key: string,
  parent: string | null,
  before?: string,
  o: BlockWriteOptions = {},
): import("../writer.js").BlockCommandResult {
  const item = blockItems(m).find((n) => n.sourceKey === key),
    record = item
      ? blockRecord(
          m,
          isBlockGroup(item)
            ? item.bodyKey
            : isBlockNode(item)
              ? (item.recordKeys.find((k) =>
                  ["block", "connection"].includes(
                    blockRecord(m, k)?.kind ?? "",
                  ),
                ) ?? item.sourceKey)
              : item.sourceKey,
        )
      : undefined;
  if (!item || !record) return blockNoChange(m, "invalid");
  if (record.kind === "connection") {
    const prepared = materializeBlockEndpoints(m, record, o);
    if (!prepared.changed) return prepared;
    const result = reorderBlockItem(prepared.model, key, parent, before, {
      ...o,
      baseSource: prepared.source,
    });
    return result.status === "rejected"
      ? result
      : { ...result, changed: true, status: "changed" };
  }
  const group = parent
    ? m.groups.find((g) => g.sourceKey === parent || g.bodyKey === parent)
    : null;
  if ((parent && !group) || before === key)
    return blockNoChange(m, before === key ? "no-change" : "invalid");
  if (!blockParentCanContain(m, key, group?.bodyKey ?? null))
    return blockNoChange(m, "invalid");
  const initialInsertion = blockInsertion(m, group?.bodyKey ?? null, before);
  if (!initialInsertion) return blockNoChange(m, "invalid");
  const primaryRange = blockUnitRange(m, record);
  const threshold = Math.max(
    initialInsertion.start,
    isBlockGroup(item) ? record.range.end : 0,
  );
  const blocksFirstPlacement = (
    r: import("../source-document.js").BlockSourceRecord,
  ) =>
    r.range.start < threshold &&
    !(r.range.start >= primaryRange.start && r.range.end <= primaryRange.end);
  // Every occurrence that could precede the moved declaration must follow it.
  // Preserve unrelated endpoint placements and multi-target class assignments
  // before composing those exact Source units into one confirmed move.
  if (isBlockNode(item)) {
    const connection = m.sourceDocument.records.find(
      (r) =>
        r.kind === "connection" &&
        blocksFirstPlacement(r) &&
        r.references.some((ref) => ref.id === item.id) &&
        [...m.nodes, ...m.groups].some(
          (n) => n.id !== item.id && n.recordKeys[0] === r.sourceKey,
        ),
    );
    if (connection) {
      const prepared = materializeBlockEndpoints(m, connection, o);
      if (!prepared.changed) return prepared;
      const result = reorderBlockItem(prepared.model, key, parent, before, {
        ...o,
        baseSource: prepared.source,
      });
      return result.status === "rejected"
        ? result
        : { ...result, changed: true, status: "changed" };
    }
    const assignment = m.styleStatements.find(
      (s) =>
        s.kind === "class" &&
        blocksFirstPlacement(blockRecord(m, s.sourceKey)!) &&
        s.targets.split(/,\s*/).includes(item.id) &&
        s.targets.split(/,\s*/).length > 1,
    );
    if (assignment) {
      const targets = assignment.targets
        .split(/,\s*/)
        .filter((id) => id !== item.id)
        .join(",");
      const split = editBlockMetadata(
        m,
        { ...assignment, key: assignment.sourceKey, targets },
        o,
      );
      if (!split.changed) return split;
      const single = editBlockMetadata(
        split.model,
        {
          kind: "class",
          targets: item.id,
          value: assignment.value,
          parent: assignment.parentKey,
        },
        { ...o, baseSource: split.source },
      );
      if (single.status === "rejected") return single;
      const result = reorderBlockItem(single.model, key, parent, before, {
        ...o,
        baseSource: single.source,
      });
      return result.status === "rejected"
        ? result
        : { ...result, changed: true, status: "changed" };
    }
  }
  const insertion = blockInsertion(m, group?.bodyKey ?? null, before);
  if (!insertion) return blockNoChange(m, "invalid");
  const candidates = m.sourceDocument.records.filter(
    (r) =>
      r.sourceKey === record.sourceKey ||
      (isBlockNode(item) &&
        blocksFirstPlacement(r) &&
        r.references.some((ref) => ref.id === item.id)),
  );
  const units: Array<{ start: number; end: number }> = [];
  for (const r of candidates) {
    const range = blockUnitRange(m, r);
    if (units.some((u) => u.start <= range.start && u.end >= range.end))
      continue;
    for (let i = units.length - 1; i >= 0; i--)
      if (range.start <= units[i]!.start && range.end >= units[i]!.end)
        units.splice(i, 1);
    units.push(range);
  }
  units.sort((a, b) => {
    if (
      record.kind === "block" ||
      blockRecord(m, isBlockNode(item) ? item.recordKeys[0]! : item.sourceKey)
        ?.kind === "class"
    ) {
      const aOwn = a.start <= record.range.start && a.end >= record.range.end,
        bOwn = b.start <= record.range.start && b.end >= record.range.end;
      if (aOwn !== bOwn) return aOwn ? -1 : 1;
    }
    return a.start - b.start;
  });
  if (units.some((u) => insertion.start > u.start && insertion.start < u.end))
    return blockNoChange(m, "invalid");
  const source = m.sourceDocument.source,
    identities: Array<readonly [number, string]> = [],
    records = m.sourceDocument.records.filter((r) =>
      units.some((u) => r.range.start >= u.start && r.range.start < u.end),
    );
  let value = insertion.prefix;
  for (const unit of units) {
    for (const r of records.filter(
      (r) => r.range.start >= unit.start && r.range.start < unit.end,
    ))
      identities.push([value.length + r.range.start - unit.start, r.sourceKey]);
    const raw = source.slice(unit.start, unit.end);
    value += raw + (/[\r\n]$/.test(raw) ? "" : insertion.newline);
  }
  const moved = new Set(records.map((r) => r.sourceKey));
  const deletions = blockDeletionPatches(m, moved, units);
  for (const patch of deletions)
    if (
      patch.value &&
      records.some(
        (r) =>
          r.parentKey === (group?.bodyKey ?? null) &&
          r.range.start >= patch.range.start &&
          r.range.end <= patch.range.end,
      )
    )
      patch.value = "";
  const patches: BlockPatch[] = [
    ...deletions,
    {
      range: { start: insertion.start, end: insertion.start },
      value,
      identities,
    },
  ];
  return writeBlockPatches(m, patches, {
    ...o,
    selection: key,
    commentTransfers: new Set(
      m.comments.filter((c) => moved.has(c.sourceKey)).map((c) => c.sourceKey),
    ),
    impact: {
      records: records.map((r) => ({
        id: r.sourceKey,
        kind: r.kind,
        label: r.raw.trim(),
      })),
      grids: [...new Set([item.parentKey, group?.bodyKey ?? null])],
    },
  });
}

export function blockGridSlots(
  m: MermaidBlockDiagramModel,
  parent: string | null,
) {
  const columns = parent
    ? (m.groups.find((g) => g.bodyKey === parent || g.sourceKey === parent)
        ?.columns ?? -1)
    : m.columns;
  let slot = 0;
  return blockItems(m)
    .filter(
      (i) =>
        i.parentKey === parent && (!("gridPlacement" in i) || i.gridPlacement),
    )
    .sort((a, b) => a.order - b.order)
    .map((i) => {
      const column = columns > 0 ? slot % columns : slot,
        row = columns > 0 ? Math.floor(slot / columns) : 0,
        span = i.span;
      // Space occupies its full width through row breaks; block body width and
      // native truncated slot advance are deliberately different quantities.
      const advance = !("syntax" in i)
        ? span
        : columns > 0
          ? Math.min(span, columns - column)
          : span;
      const result = {
        key: i.sourceKey,
        slot,
        column,
        row,
        span,
        advance,
        overflow: columns > 0 && span > columns - column,
      };
      slot += advance;
      return result;
    });
}
