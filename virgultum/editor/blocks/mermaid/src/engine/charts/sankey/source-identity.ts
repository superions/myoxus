// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SankeySourceDocument } from "./source-document.js";

/** Local writers provide the old ID at its explicitly mapped new offset. */
export type SankeyRecordMapping = ReadonlyMap<number, string>;

export function reconcileSankeyRecords(
  document: SankeySourceDocument,
  previous?: SankeySourceDocument,
  mapping?: SankeyRecordMapping,
) {
  if (!previous) return { document, conflicts: [] as string[] };
  const used = new Set<string>();
  const conflicts = new Set<string>();
  const unchanged = document.source === previous.source;
  const key = (record: SankeySourceDocument["records"][number]) =>
    `${record.kind}\0${record.raw}`;
  const oldGroups = Map.groupBy(previous.records, key);
  const newGroups = Map.groupBy(document.records, key);
  const records = document.records.map((record) => {
    const mapped = mapping?.get(record.range.start);
    if (mapped && !used.has(mapped)) {
      used.add(mapped);
      return { ...record, id: mapped };
    }
    const candidates = (oldGroups.get(key(record)) ?? []).filter(
      (old) => !used.has(old.id),
    );
    const count = newGroups.get(key(record))!.length;
    const exact = unchanged
      ? candidates.find((old) => old.range.start === record.range.start)
      : undefined;
    const match =
      exact ??
      (candidates.length === 1 && count === 1 ? candidates[0] : undefined);
    if (match) {
      used.add(match.id);
      return { ...record, id: match.id };
    }
    if (record.kind === "csv" && candidates.length > 0)
      for (const old of candidates) conflicts.add(old.id);
    return record;
  });
  // An external one-field edit may retain an identity only inside the same
  // uniquely anchored neighbourhood. Duplicate records are deliberately not
  // matched this way: their apparent position does not establish ownership.
  const oldPositions = new Map(
    previous.records.map((record, index) => [record.id, index]),
  );
  const anchors = [
    { next: -1, old: -1 },
    ...records.flatMap((record, index) => {
      const old = oldPositions.get(record.id);
      return old === undefined ? [] : [{ next: index, old }];
    }),
    { next: records.length, old: previous.records.length },
  ];
  for (let i = 1; i < anchors.length; i++) {
    const left = anchors[i - 1];
    const right = anchors[i];
    if (right.next - left.next !== 2 || right.old - left.old !== 2) continue;
    const record = records[left.next + 1];
    const old = previous.records[left.old + 1];
    if (
      record.kind !== "csv" ||
      old.kind !== "csv" ||
      used.has(old.id) ||
      (oldGroups.get(key(old))?.length ?? 0) !== 1 ||
      (newGroups.get(key(record))?.length ?? 0) !== 1 ||
      old.fields.length !== 3 ||
      record.fields.length !== 3 ||
      record.fields.filter(
        (field, index) => field.raw === old.fields[index].raw,
      ).length < 2
    )
      continue;
    records[left.next + 1] = { ...record, id: old.id };
    used.add(old.id);
  }
  for (const old of previous.records)
    if (old.kind === "csv" && !used.has(old.id)) conflicts.add(old.id);
  return { document: { ...document, records }, conflicts: [...conflicts] };
}
