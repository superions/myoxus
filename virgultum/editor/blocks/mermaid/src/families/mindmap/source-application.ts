// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMermaidMindmapSource } from "../../engine/mindmap/index.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { hashMermaidSource } from "../../utils.js";
import {
  mindmapRecordBindings,
  type MindmapRecordBinding,
} from "./gfx-data.js";

/** Reserve every unchanged occurrence before unique shifted matches, as Sequence
 * does. Equal labels/raw hashes alone never select one of several occurrences. */
export function readMindmapProjectionModel(
  source: string,
  visual?: Pick<MermaidVisualModel, "familyData">,
) {
  const first = parseMermaidMindmapSource(source);
  if (!first) return null;
  const records = first.sourceDocument.records,
    bindings = mindmapRecordBindings(visual);
  if (!bindings.length) return first;
  const mapping = new Map<number, string>(),
    used = new Set<string>();
  const signature = (kind: string, hash: string) => `${kind}:${hash}`;
  const counts = new Map<string, number>();
  const hashes = records.map((record) =>
    hashMermaidSource(record.raw + record.eol),
  );
  // Stored bindings retain fingerprints, not another Source copy. Reserve the
  // unchanged leading/trailing record runs before matching individual ranges;
  // a preceding comment edit can shift several identical node occurrences.
  const same = (current: number, previous: number) =>
    records[current].kind === bindings[previous].kind &&
    hashes[current] === bindings[previous].hash;
  const reserve = (current: number, previous: number) => {
    const binding = bindings[previous];
    if (used.has(binding.key)) return;
    mapping.set(records[current].range.start, binding.key);
    used.add(binding.key);
  };
  let prefix = 0,
    suffix = 0;
  const limit = Math.min(records.length, bindings.length);
  while (prefix < limit && same(prefix, prefix)) {
    reserve(prefix, prefix);
    prefix++;
  }
  while (
    suffix < limit - prefix &&
    same(records.length - suffix - 1, bindings.length - suffix - 1)
  ) {
    reserve(records.length - suffix - 1, bindings.length - suffix - 1);
    suffix++;
  }
  const byRange = new Map<string, MindmapRecordBinding[]>(),
    bySignature = new Map<string, MindmapRecordBinding[]>();
  for (const binding of bindings) {
    const kindHash = signature(binding.kind, binding.hash);
    const range = `${kindHash}:${binding.start}:${binding.end}`;
    byRange.set(range, [...(byRange.get(range) ?? []), binding]);
    bySignature.set(kindHash, [...(bySignature.get(kindHash) ?? []), binding]);
  }
  for (const [index, record] of records.entries()) {
    const id = signature(record.kind, hashes[index]!);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [index, record] of records.entries()) {
    if (mapping.has(record.range.start)) continue;
    const id = `${signature(record.kind, hashes[index]!)}:${record.range.start}:${record.range.end}`;
    const exact = (byRange.get(id) ?? []).filter(
      (binding) => !used.has(binding.key),
    );
    if (exact.length === 1) {
      mapping.set(record.range.start, exact[0].key);
      used.add(exact[0].key);
    }
  }
  for (const [index, record] of records.entries()) {
    if (mapping.has(record.range.start)) continue;
    const id = signature(record.kind, hashes[index]!);
    if (counts.get(id) !== 1) continue;
    const matches = (bySignature.get(id) ?? []).filter(
      (binding) => !used.has(binding.key),
    );
    if (matches.length === 1) {
      mapping.set(record.range.start, matches[0].key);
      used.add(matches[0].key);
    }
  }
  return parseMermaidMindmapSource(source, { mapping });
}
