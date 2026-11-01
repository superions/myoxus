// SPDX-License-Identifier: AGPL-3.0-or-later

type SourceRecord = {
  sourceKey: string;
  range: { start: number; end: number };
  blockKey?: string;
  closeKey?: string;
};
type SourceDocument = {
  source: string;
  records: SourceRecord[];
  diagnostics: Array<{ sourceKey?: string }>;
};

/** Reserve explicit writer mappings and unique unchanged records before matching
 * duplicate occurrences by their unchanged prefix/suffix coordinates. */
export function reconcileSourceRecordBindings<T extends SourceDocument>(
  document: T,
  previous: T | undefined,
  mapping: ReadonlyMap<number, string> | undefined,
  signature: (record: T["records"][number]) => string,
  nextKey: () => string,
): T {
  if (!previous && !mapping) return document;
  const reserved = new Set(mapping?.values());
  const matches = new Map<number, string>();
  const exact = new Map<string, T["records"][number][]>();
  const incoming = new Map<string, T["records"][number][]>();
  for (const record of previous?.records ?? []) {
    if (reserved.has(record.sourceKey)) continue;
    const key = signature(record);
    const group = exact.get(key) ?? [];
    group.push(record);
    exact.set(key, group);
  }
  for (const record of document.records) {
    if (mapping?.has(record.range.start)) continue;
    const key = signature(record);
    const group = incoming.get(key) ?? [];
    group.push(record);
    incoming.set(key, group);
  }
  for (const [key, group] of incoming) {
    const old = exact.get(key);
    if (group.length === 1 && old?.length === 1) {
      matches.set(group[0]!.range.start, old[0]!.sourceKey);
      reserved.add(old[0]!.sourceKey);
    }
  }
  let prefix = 0;
  let suffix = 0;
  if (previous) {
    const limit = Math.min(document.source.length, previous.source.length);
    while (
      prefix < limit &&
      document.source[prefix] === previous.source[prefix]
    )
      prefix++;
    while (
      suffix < limit - prefix &&
      document.source[document.source.length - suffix - 1] ===
        previous.source[previous.source.length - suffix - 1]
    )
      suffix++;
    const delta = document.source.length - previous.source.length;
    for (const record of document.records) {
      if (mapping?.has(record.range.start) || matches.has(record.range.start))
        continue;
      const candidates = (exact.get(signature(record)) ?? []).filter(
        (old) =>
          !reserved.has(old.sourceKey) &&
          (old.range.end <= prefix
            ? old.range.start
            : old.range.start >= previous.source.length - suffix
              ? old.range.start + delta
              : undefined) === record.range.start,
      );
      if (candidates.length === 1) {
        matches.set(record.range.start, candidates[0]!.sourceKey);
        reserved.add(candidates[0]!.sourceKey);
      }
    }
  }
  const used = new Set<string>();
  const remapped = new Map<string, string>();
  for (const record of document.records) {
    const original = record.sourceKey;
    let key =
      mapping?.get(record.range.start) ?? matches.get(record.range.start);
    // An inserted identical record may have the old seed of a moved occurrence.
    // It must not steal a reserved identity merely by occupying its old offset.
    if (!key && !reserved.has(original) && !used.has(original)) key = original;
    if (!key || used.has(key)) {
      do key = nextKey();
      while (reserved.has(key) || used.has(key));
    }
    remapped.set(original, key);
    record.sourceKey = key;
    used.add(key);
  }
  for (const record of document.records) {
    if (record.blockKey)
      record.blockKey = remapped.get(record.blockKey) ?? record.blockKey;
    if (record.closeKey)
      record.closeKey = remapped.get(record.closeKey) ?? record.closeKey;
  }
  for (const diagnostic of document.diagnostics) {
    if (diagnostic.sourceKey)
      diagnostic.sourceKey =
        remapped.get(diagnostic.sourceKey) ?? diagnostic.sourceKey;
  }
  return document;
}
