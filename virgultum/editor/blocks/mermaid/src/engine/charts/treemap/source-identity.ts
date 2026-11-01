// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  TreemapSourceDocument,
  TreemapSourceRecord,
} from "./source-document.js";

export type TreemapRecordMapping = ReadonlyMap<number, string>;

function exactMatches(
  candidates: readonly TreemapSourceRecord[],
  record: TreemapSourceRecord,
) {
  return candidates.filter(
    (candidate) =>
      candidate.kind === record.kind && candidate.raw === record.raw,
  );
}

/**
 * Reconciles ephemeral source identities. Explicit command mappings win;
 * external edits retain an ID only when range or unchanged source is unique.
 */
export function reconcileTreemapSource(
  document: TreemapSourceDocument,
  previous?: TreemapSourceDocument,
  mapping?: TreemapRecordMapping,
) {
  const available = new Map(
    (previous?.records ?? []).map((record) => [record.id, record]),
  );
  const conflicts: string[] = [];
  const assigned = new Set<string>();
  const unchangedSource = document.source === previous?.source;
  const records = document.records.map((record) => {
    const mappedId = mapping?.get(record.range.start);
    const mapped = mappedId ? available.get(mappedId) : undefined;
    const sameRange = [...available.values()].filter(
      (candidate) =>
        candidate.kind === record.kind &&
        candidate.range.start === record.range.start,
    );
    const exact = exactMatches([...available.values()], record);
    const candidate =
      mapped ??
      (exact.length === 1
        ? exact[0]
        : sameRange.length === 1 && (exact.length === 0 || unchangedSource)
          ? sameRange[0]
          : undefined);
    // Commands allocate an explicit record ID for newly inserted statements.
    // Such IDs cannot exist in `previous`; they are valid unless the same ID
    // was already consumed by another record in this parse.
    if (mappedId && !mapped) {
      if (assigned.has(mappedId)) conflicts.push(mappedId);
      else {
        assigned.add(mappedId);
        return { ...record, id: mappedId };
      }
    }
    if (!candidate) {
      if (exact.length > 1) conflicts.push(record.id);
      return record;
    }
    available.delete(candidate.id);
    assigned.add(candidate.id);
    return { ...record, id: candidate.id };
  });
  return { document: { ...document, records }, conflicts };
}
