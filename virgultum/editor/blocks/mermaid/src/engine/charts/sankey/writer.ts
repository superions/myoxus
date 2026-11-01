// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SankeyField, SankeyRange } from "./source-document.js";
import type { SankeyModel } from "./model.js";
import { parseSankeySource } from "./parser.js";

export type SankeySelection = {
  readonly kind: "node" | "link" | "comment";
  readonly id: string;
} | null;
export type SankeyCommandResult = {
  readonly changed: boolean;
  readonly diagnosis: string;
  readonly model: SankeyModel;
  readonly source: string;
  readonly selection: SankeySelection;
};

export function sankeyNoChange(
  model: SankeyModel,
  diagnosis: string,
): SankeyCommandResult {
  return {
    changed: false,
    diagnosis,
    model,
    source: model.sourceDocument.source,
    selection: null,
  };
}

/** Reparse before commit; pre-existing unrelated errors do not block repair. */
export function sankeyPatchedResult(
  model: SankeyModel,
  patches: readonly SankeyPatch[],
  selection: SankeySelection,
  relocated?: ReadonlyMap<number, string>,
): SankeyCommandResult {
  if (model.ambiguous) return sankeyNoChange(model, "ambiguous-record");
  const source = applySankeyPatches(model.sourceDocument.source, patches);
  if (source === null) return sankeyNoChange(model, "conflict");
  if (source === model.sourceDocument.source)
    return sankeyNoChange(model, "no-change");
  const mapping = new Map<number, string>();
  for (const record of model.sourceDocument.records) {
    if (
      patches.some(
        (patch) =>
          patch.range.start <= record.range.start &&
          patch.range.end >= record.range.end &&
          !patch.value,
      )
    )
      continue;
    mapping.set(patchedOffset(record.range.start, patches), record.id);
  }
  for (const [offset, id] of relocated ?? []) mapping.set(offset, id);
  const next = parseSankeySource(source, model, mapping);
  if (!next || next.ambiguous) return sankeyNoChange(model, "ambiguous-record");
  const detachedSeparators = new Set<number>();
  for (const comment of next.comments) {
    const old = model.comments.find((candidate) => candidate.id === comment.id);
    if (!old || old.linkId === comment.linkId) continue;
    if (old.linkId !== undefined)
      return sankeyNoChange(model, "comment-conflict");
    // Removing the preceding CSV row can turn a diagram comment into a bound
    // link comment. Retain ownership by separating its whole original block
    // from the following row, without moving or rewriting the comment text.
    const index = model.sourceDocument.records.findIndex(
      (record) => record.id === old.id,
    );
    let last = index;
    while (model.sourceDocument.records[last + 1]?.kind === "comment") last++;
    detachedSeparators.add(model.sourceDocument.records[last].range.end);
  }
  if (detachedSeparators.size) {
    const separators = [...detachedSeparators].map((position) => ({
      range: { start: position, end: position },
      value: model.sourceDocument.newline,
    }));
    if (
      separators.some((separator) =>
        patches.some(
          (patch) =>
            patch.range.start === separator.range.start &&
            patch.range.end === separator.range.end,
        ),
      )
    )
      return sankeyNoChange(model, "comment-conflict");
    return sankeyPatchedResult(
      model,
      [...patches, ...separators],
      selection,
      relocated
        ? new Map(
            [...relocated].map(([offset, id]) => [
              offset +
                separators
                  .filter(
                    (separator) =>
                      patchedOffset(separator.range.start, patches) <= offset,
                  )
                  .reduce((sum, separator) => sum + separator.value.length, 0),
              id,
            ]),
          )
        : undefined,
    );
  }
  const introduced = next.diagnostics.find(
    (diagnostic) =>
      diagnostic.code !== "conflict" &&
      !model.diagnostics.some(
        (old) =>
          old.recordId === diagnostic.recordId &&
          old.code === diagnostic.code &&
          old.field === diagnostic.field &&
          old.configField === diagnostic.configField,
      ),
  );
  if (introduced) return sankeyNoChange(model, introduced.code);
  return { changed: true, diagnosis: "ok", model: next, source, selection };
}

export type SankeyPatch = {
  readonly range: Pick<SankeyRange, "start" | "end">;
  readonly value: string;
};

function patchedOffset(position: number, patches: readonly SankeyPatch[]) {
  return patches.reduce(
    (offset, patch) =>
      patch.range.end <= position
        ? offset + patch.value.length - (patch.range.end - patch.range.start)
        : offset,
    position,
  );
}

/** Applies non-overlapping original-source ranges; never regenerates a graph. */
export function applySankeyPatches(
  source: string,
  patches: readonly SankeyPatch[],
) {
  const ordered = [...patches].sort((a, b) => b.range.start - a.range.start);
  let result = source;
  let boundary = source.length;
  for (const { range, value } of ordered) {
    if (range.start < 0 || range.end < range.start || range.end > boundary)
      return null;
    result = result.slice(0, range.start) + value + result.slice(range.end);
    boundary = range.start;
  }
  return result;
}

export function encodeSankeyField(value: string, previous?: SankeyField) {
  if (!value.trim() || !/^[\x20-\x7e\r\n]+$/.test(value)) return null;
  const quoted = previous?.quoted || /[",\r\n]/.test(value);
  const raw = previous?.quoted
    ? previous.raw.trim().slice(1, -1)
    : (previous?.raw ?? "");
  const leading = raw.match(/^ */)?.[0] ?? "";
  const trailing = raw.match(/ *$/)?.[0] ?? "";
  const content = leading + value + trailing;
  // Jison does not permit whitespace outside a quoted CSV field. Preserve
  // existing endpoint whitespace inside quotes when quoting becomes necessary.
  return quoted ? `"${content.replaceAll('"', '""')}"` : content;
}
