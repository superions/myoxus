// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidBlockDiagramModel,
  MermaidBlockNodeSyntax,
} from "../model.js";
import { nextBlockSourceKey } from "../source-document.js";
import {
  blockNoChange,
  writeBlockPatches,
  type BlockWriteOptions,
  type BlockPatch,
} from "../writer.js";
import {
  isBlockNode,
  blockDeclaration,
  isBlockId,
  blockObject,
  blockRecord,
  blockItemRecord,
  materializeBlockEndpoints,
  blockDeletionPatches,
  blockUnitRange,
  blockInsertion,
  blockParentCanContain,
  blockItems,
} from "./block-commands.js";
export function addBlockComposite(
  m: MermaidBlockDiagramModel,
  args: {
    id?: string;
    label?: string;
    syntax?: MermaidBlockNodeSyntax;
    span?: number;
    parent?: string | null;
    before?: string;
    children?: readonly string[];
  },
  o: BlockWriteOptions = {},
): import("../writer.js").BlockCommandResult {
  const explicit = args.id !== undefined;
  if (explicit && (!isBlockId(args.id!) || blockObject(m, args.id!)))
    return blockNoChange(m, "invalid");
  const selected = (args.children ?? []).map((k) =>
    blockItems(m).find((n) => n.sourceKey === k),
  );
  if (
    args.children &&
    (selected.length < 2 ||
      selected.some((n) => !n || "bodyKey" in n!) ||
      new Set(selected.map((n) => n!.parentKey)).size !== 1 ||
      selected.some((n) => n!.parentKey !== (args.parent ?? null)))
  )
    return blockNoChange(m, "invalid");
  const implicit = selected
    .map((n) => n && blockItemRecord(m, n.sourceKey))
    .find((r) => r?.kind === "connection");
  if (implicit) {
    const prepared = materializeBlockEndpoints(m, implicit, o);
    if (!prepared.changed) return prepared;
    const result = addBlockComposite(prepared.model, args, {
      ...o,
      baseSource: prepared.source,
    });
    return result.status === "rejected"
      ? result
      : { ...result, changed: true, status: "changed" };
  }
  const children = selected
    .filter((n): n is NonNullable<typeof n> => Boolean(n))
    .sort((a, b) => a.order - b.order);
  const insert = blockInsertion(
    m,
    args.parent ?? null,
    args.before ?? children[0]?.sourceKey,
  );
  if (!insert) return blockNoChange(m, "invalid");
  const key = nextBlockSourceKey(),
    closeKey = nextBlockSourceKey(),
    header = explicit
      ? blockDeclaration(
          args.id!,
          args.label ?? args.id!,
          args.syntax ?? "rectangle",
          [],
          args.span ?? 1,
        )
      : "block";
  if (!header) return blockNoChange(m, "invalid");
  let value =
    insert.prefix +
    insert.indent +
    (explicit ? "block:" : "") +
    header +
    insert.newline;
  const identities: Array<readonly [number, string]> = [
      [insert.prefix.length, key],
    ],
    patches: BlockPatch[] = [],
    transfers = new Set<string>();
  if (!children.length)
    value += insert.indent + "  columns auto" + insert.newline;
  for (const child of children) {
    const r = blockItemRecord(m, child.sourceKey)!,
      range = blockUnitRange(m, r),
      raw = m.sourceDocument.source.slice(range.start, range.end);
    for (const record of m.sourceDocument.records.filter(
      (r) => r.range.start >= range.start && r.range.start < range.end,
    ))
      identities.push([
        value.length + record.range.start - range.start,
        record.sourceKey,
      ]);
    for (const c of m.comments.filter((c) => {
      const record = blockRecord(m, c.sourceKey)!;
      return (
        record.range.start >= range.start && record.range.start < range.end
      );
    }))
      transfers.add(c.sourceKey);
    value += raw + (/[\r\n]$/.test(raw) ? "" : insert.newline);
    patches.push({ range, value: "" });
  }
  identities.push([value.length, closeKey]);
  value += insert.indent + "end" + insert.newline;
  patches.push({
    range: { start: insert.start, end: insert.start },
    value,
    identities,
  });
  return writeBlockPatches(m, patches, {
    ...o,
    selection: key,
    commentTransfers: transfers,
    impact: {
      records: children.map((n) => ({
        id: n.sourceKey,
        kind: "block",
        label: isBlockNode(n) ? n.label : n.id,
      })),
      grids: [args.parent ?? null, key],
    },
  });
}
function retainedCompositeBody(
  m: MermaidBlockDiagramModel,
  record: import("../source-document.js").BlockSourceRecord,
) {
  const close = blockRecord(m, record.closeKey!)!,
    start = record.range.end + record.eol.length,
    end = close.range.start;
  const children = m.sourceDocument.records.filter(
    (r) =>
      r.range.start >= start &&
      r.range.start < end &&
      !(r.kind === "columns" && r.parentKey === record.sourceKey),
  );
  const columns = m.sourceDocument.records.filter(
    (r) => r.kind === "columns" && r.parentKey === record.sourceKey,
  );
  let value = "",
    cursor = start;
  const identities: Array<readonly [number, string]> = [];
  for (const column of columns) {
    for (const child of children.filter(
      (r) => r.range.start >= cursor && r.range.start < column.range.start,
    ))
      identities.push([
        value.length + child.range.start - cursor,
        child.sourceKey,
      ]);
    value += m.sourceDocument.source.slice(cursor, column.range.start);
    cursor = column.range.end + column.eol.length;
  }
  for (const child of children.filter((r) => r.range.start >= cursor))
    identities.push([
      value.length + child.range.start - cursor,
      child.sourceKey,
    ]);
  value += m.sourceDocument.source.slice(cursor, end);
  return { value, identities, children };
}
export function deleteBlockComposite(
  m: MermaidBlockDiagramModel,
  key: string,
  args: {
    children: "delete" | "retain";
    parent?: string | null;
    before?: string;
  },
  o: BlockWriteOptions = {},
): import("../writer.js").BlockCommandResult {
  const group = m.groups.find((g) => g.sourceKey === key);
  if (!group) return blockNoChange(m, "invalid");
  const r = blockRecord(m, group.bodyKey)!,
    range = blockUnitRange(m, r),
    records = m.sourceDocument.records.filter(
      (r) => r.range.start >= range.start && r.range.start < range.end,
    ),
    removed = new Set<string>(),
    transfers = new Set<string>();
  const patches: BlockPatch[] = [{ range, value: "" }],
    impact = {
      records: records.map((r) => ({
        id: r.sourceKey,
        kind: r.kind,
        label: r.raw.trim(),
      })),
      grids: [group.parentKey, args.parent ?? group.parentKey],
    };
  if (args.children === "retain") {
    const insert = blockInsertion(
      m,
      args.parent ?? group.parentKey,
      args.before,
    );
    if (
      !insert ||
      !blockParentCanContain(m, key, args.parent ?? group.parentKey) ||
      (insert.start > range.start && insert.start < range.end)
    )
      return blockNoChange(m, "invalid");
    const { value, identities, children } = retainedCompositeBody(m, r);
    for (const c of m.comments.filter((c) =>
      children.some((r) => r.sourceKey === c.sourceKey),
    ))
      transfers.add(c.sourceKey);
    patches.push({
      range: { start: insert.start, end: insert.start },
      value: insert.prefix + value,
      identities: identities.map(
        ([offset, k]) => [offset + insert.prefix.length, k] as const,
      ),
    });
    for (const rec of records)
      if (!children.some((c) => c.sourceKey === rec.sourceKey))
        removed.add(rec.sourceKey);
  } else for (const rec of records) removed.add(rec.sourceKey);
  const bodyRanges = group.recordKeys.flatMap((k) => {
    const record = blockRecord(m, k);
    return record?.kind === "composite"
      ? [blockUnitRange(m, record, false)]
      : [];
  });
  const scopes = new Set(
    m.sourceDocument.records
      .filter(
        (r) =>
          r.kind === "composite" &&
          bodyRanges.some(
            (b) => r.range.start >= b.start && r.range.end <= b.end,
          ),
      )
      .map((r) => r.sourceKey),
  );
  const ids = new Set([
    group.id,
    ...(args.children === "delete"
      ? [...m.nodes, ...m.groups]
          .filter((n) => n.parentKey && scopes.has(n.parentKey))
          .map((n) => n.id)
      : []),
  ]);
  const references = m.sourceDocument.records.filter(
    (c) => !records.includes(c) && c.references.some((ref) => ids.has(ref.id)),
  );
  // An outside endpoint must survive removal of its sole connection record.
  // Materialization stays in memory; the host still commits this one result.
  const implicit = references.find(
    (rec) =>
      rec.kind === "connection" &&
      m.nodes.some(
        (n) =>
          !ids.has(n.id) &&
          n.recordKeys[0] === rec.sourceKey &&
          n.recordKeys.every(
            (k) =>
              records.some((r) => r.sourceKey === k) ||
              references.some((r) => r.sourceKey === k),
          ),
      ),
  );
  if (implicit) {
    const prepared = materializeBlockEndpoints(m, implicit, o);
    if (prepared.changed) {
      const result = deleteBlockComposite(prepared.model, key, args, {
        ...o,
        baseSource: prepared.source,
      });
      return result.status === "rejected"
        ? result
        : { ...result, changed: true, status: "changed" };
    }
  }
  for (const rec of references) {
    const ownedRange = blockUnitRange(m, rec, false);
    if (
      args.children === "retain" &&
      rec.kind === "composite" &&
      rec.endpoints?.[0]?.id === group.id
    ) {
      const insert = blockInsertion(
        m,
        args.parent ?? group.parentKey,
        args.before,
      );
      if (!insert) return blockNoChange(m, "invalid");
      const body = retainedCompositeBody(m, rec),
        retained = new Set(body.children.map((r) => r.sourceKey));
      for (const child of m.sourceDocument.records.filter(
        (c) =>
          c.range.start >= ownedRange.start && c.range.end <= ownedRange.end,
      ))
        if (!retained.has(child.sourceKey)) removed.add(child.sourceKey);
      for (const comment of m.comments.filter((c) => retained.has(c.sourceKey)))
        transfers.add(comment.sourceKey);
      patches.push(
        { range: ownedRange, value: "" },
        {
          range: { start: insert.start, end: insert.start },
          value: insert.prefix + body.value,
          identities: body.identities.map(
            ([offset, k]) => [offset + insert.prefix.length, k] as const,
          ),
        },
      );
      continue;
    }
    for (const child of m.sourceDocument.records.filter(
      (c) => c.range.start >= ownedRange.start && c.range.end <= ownedRange.end,
    ))
      removed.add(child.sourceKey);
    removed.add(rec.sourceKey);
    patches.push({ range: ownedRange, value: "" });
  }
  for (const comment of m.comments.filter(
    (c) => c.anchorKey && removed.has(c.anchorKey) && !removed.has(c.sourceKey),
  )) {
    const record = blockRecord(m, comment.sourceKey)!;
    removed.add(record.sourceKey);
    patches.push({ range: blockUnitRange(m, record, false), value: "" });
  }
  for (const rec of m.sourceDocument.records.filter((r) =>
    removed.has(r.sourceKey),
  ))
    if (!impact.records.some((r) => r.id === rec.sourceKey))
      impact.records.push({
        id: rec.sourceKey,
        kind: rec.kind,
        label: rec.raw.trim(),
      });
  const deletions = patches.filter((p) => !p.value),
    inserts = patches.filter((p) => Boolean(p.value));
  const deletionPatches = blockDeletionPatches(
    m,
    removed,
    deletions.map((p) => p.range),
  );
  if (args.children === "retain" && inserts.some((p) => p.value.trim()))
    for (const p of deletionPatches)
      if (
        m.sourceDocument.records.some(
          (r) =>
            r.parentKey === (args.parent ?? group.parentKey) &&
            r.range.start >= p.range.start &&
            r.range.end <= p.range.end,
        )
      )
        p.value = "";
  return writeBlockPatches(m, [...deletionPatches, ...inserts], {
    ...o,
    removed,
    commentTransfers: transfers,
    impact,
  });
}
