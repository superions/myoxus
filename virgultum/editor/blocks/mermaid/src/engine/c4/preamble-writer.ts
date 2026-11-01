// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Model } from "./model.js";
import type { C4Patch } from "./patches.js";
import { scanC4Source } from "./source-document.js";

/** Replace only physical preamble owners, retaining interleaved comments.
 * Explicit raw matches carry directive keys when the model requests a reorder. */
export function c4PreamblePatches(
  model: MermaidC4Model,
  lines: readonly string[],
): C4Patch[] {
  const document = model.sourceDocument,
    newline = document.newline;
  const isPreamble = (r: (typeof document.records)[number]) =>
    r.kind === "frontmatter" || r.kind === "directive";
  const old = document.records.filter(isPreamble);
  const desired = scanC4Source(
    lines.join(newline) + newline + model.headerLine,
  ).records.filter(isPreamble);
  const identities = new Map<number, string>(),
    used = new Set<string>();
  for (const [i, next] of desired.entries()) {
    const same = old.find(
      (r) =>
        !used.has(r.sourceKey) && r.kind === next.kind && r.raw === next.raw,
    );
    if (same) {
      identities.set(i, same.sourceKey);
      used.add(same.sourceKey);
    }
  }
  for (const [i, next] of desired.entries())
    if (!identities.has(i)) {
      const owner = old.find(
        (r) => !used.has(r.sourceKey) && r.kind === next.kind,
      );
      if (owner) {
        identities.set(i, owner.sourceKey);
        used.add(owner.sourceKey);
      }
    }
  const patches: C4Patch[] = [];
  for (const [i, record] of old.entries()) {
    const next = desired[i];
    if (!next)
      patches.push({
        start: record.range.start,
        end: record.range.end + record.eol.length,
        text: "",
      });
    else if (next.raw !== record.raw || identities.get(i) !== record.sourceKey)
      patches.push({
        start: record.range.start,
        end: record.range.end,
        text: next.raw,
        identities: identities.has(i) ? [[0, identities.get(i)!]] : undefined,
      });
  }
  const at = document.records.find((r) => r.kind === "header")!.range.start;
  for (const [i, next] of desired.entries())
    if (i >= old.length)
      patches.push({
        start: at,
        end: at,
        text: next.raw + newline,
        identities: identities.has(i) ? [[0, identities.get(i)!]] : undefined,
      });
  return patches;
}
