// SPDX-License-Identifier: AGPL-3.0-or-later

import type { C4SourceDocument } from "./source-document.js";
import type { MermaidC4Model } from "./model.js";
import { parseMermaidC4SourceWithDiagnostics } from "./parser.js";

/** Expected lexical/identity rejection, distinct from a programmer/runtime error. */
export class C4WriteError extends Error {}

export type C4Patch = {
  start: number;
  end: number;
  text: string;
  /** Sourcekeys of inserted or relocated records, relative to replacement text. */
  identities?: readonly (readonly [number, string])[];
};

/** Apply original-basis patches and advance physical bindings in the same result.
 * Lexical moves retain record keys; callers never reparse against a gesture basis. */
export function writeC4SourcePatches(
  document: C4SourceDocument,
  patches: readonly C4Patch[],
) {
  const ordered = [...patches].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  let previousEnd = 0;
  for (const patch of ordered) {
    if (
      !Number.isInteger(patch.start) ||
      !Number.isInteger(patch.end) ||
      patch.start < previousEnd ||
      patch.end < patch.start ||
      patch.end > document.source.length
    )
      throw new C4WriteError("Invalid or overlapping C4 source patches");
    previousEnd = patch.end;
  }
  let source = document.source;
  for (const patch of [...ordered].reverse())
    source =
      source.slice(0, patch.start) + patch.text + source.slice(patch.end);
  const mapping = new Map<number, string>();
  for (const record of document.records) {
    const covering = ordered.find(
      (p) => p.start <= record.range.start && record.range.start < p.end,
    );
    if (covering && (!covering.text || covering.start !== record.range.start))
      continue;
    const delta = ordered
      .filter(
        (p) =>
          p.end <= record.range.start &&
          (p.start < record.range.start || p.start === p.end),
      )
      .reduce((sum, p) => sum + p.text.length - (p.end - p.start), 0);
    mapping.set(record.range.start + delta, record.sourceKey);
  }
  let delta = 0;
  for (const patch of ordered) {
    for (const [offset, key] of patch.identities ?? [])
      mapping.set(patch.start + delta + offset, key);
    delta += patch.text.length - (patch.end - patch.start);
  }
  const resolved = parseMermaidC4SourceWithDiagnostics(source, {
    previous: document,
    mapping,
  });
  return { ...resolved, bindings: { previous: resolved.document } };
}

/** Model consumers reject unresolved syntax/identity; local diagnostic controls can
 * repair those records through writeC4SourcePatches without inventing a model. */
export function writeC4Patches(
  model: MermaidC4Model,
  patches: readonly C4Patch[],
) {
  const result = writeC4SourcePatches(model.sourceDocument, patches);
  if (!result.model)
    throw new C4WriteError("The patched C4 source cannot be resolved");
  return {
    source: result.source,
    model: result.model,
    bindings: result.bindings,
  };
}
