// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidBlockDiagramModel } from "./model.js";
import type { SourceValuePatch } from "../source-yaml.js";
import { resolveMermaidBlockSource } from "./parser.js";
import { mermaidMessages as m } from "../../i18n.js";
export type BlockPatch = SourceValuePatch & {
  identities?: readonly (readonly [number, string])[];
};
export type BlockImpact = {
  records: readonly { id: string; kind: string; label: string }[];
  grids: readonly (string | null)[];
};
export type BlockCommandResult = {
  changed: boolean;
  status: "changed" | "no-op" | "rejected";
  source: string;
  model: MermaidBlockDiagramModel;
  patches: readonly BlockPatch[];
  reason:
    "applied" | "no-change" | "invalid" | "conflict" | "readonly" | "cancelled";
  diagnostic?: string;
  selection?: string;
  impact: BlockImpact;
};
export type BlockWriteOptions = {
  baseSource?: string;
  readonly?: boolean;
  intent?: "preview" | "confirm" | "cancel";
  removed?: ReadonlySet<string>;
  selection?: string;
  impact?: BlockImpact;
  commentTransfers?: ReadonlySet<string>;
};
export function blockNoChange(
  model: MermaidBlockDiagramModel,
  reason: BlockCommandResult["reason"] = "no-change",
  diagnostic?: string,
): BlockCommandResult {
  return {
    changed: false,
    status:
      reason === "no-change" || reason === "cancelled" ? "no-op" : "rejected",
    source: model.sourceDocument.source,
    model,
    patches: [],
    reason,
    diagnostic,
    impact: { records: [], grids: [] },
  };
}
/** One exact Source basis, one candidate parse, one host commit. Explicit record
 * mappings survive inserts/moves even when identical Source statements repeat. */
export function writeBlockPatches(
  model: MermaidBlockDiagramModel,
  patches: readonly BlockPatch[],
  options: BlockWriteOptions = {},
): BlockCommandResult {
  const source = model.sourceDocument.source;
  if (options.intent === "cancel") return blockNoChange(model, "cancelled");
  if (options.readonly) return blockNoChange(model, "readonly");
  if (options.baseSource !== undefined && options.baseSource !== source)
    return blockNoChange(model, "conflict", m.stateSourceConflict());
  const sorted = [...patches].sort(
      (a, b) => a.range.start - b.range.start || a.range.end - b.range.end,
    ),
    mapping = new Map<number, string>(),
    reserved = new Set<string>();
  let next = "",
    cursor = 0;
  for (const p of sorted) {
    if (
      !Number.isSafeInteger(p.range.start) ||
      !Number.isSafeInteger(p.range.end) ||
      p.range.start < cursor ||
      p.range.end < p.range.start ||
      p.range.end > source.length
    )
      return blockNoChange(model, "invalid", m.classPatchRejected());
    next += source.slice(cursor, p.range.start);
    for (const [offset, key] of p.identities ?? []) {
      if (offset < 0 || offset > p.value.length || reserved.has(key))
        return blockNoChange(model, "invalid", m.classPatchRejected());
      mapping.set(next.length + offset, key);
      reserved.add(key);
    }
    next += p.value;
    cursor = p.range.end;
  }
  next += source.slice(cursor);
  if (source === next) return blockNoChange(model);
  for (const r of model.sourceDocument.records) {
    if (reserved.has(r.sourceKey) || options.removed?.has(r.sourceKey))
      continue;
    let start = r.range.start,
      removed = false;
    for (const p of sorted) {
      if (p.range.start > r.range.start) break;
      if (
        p.range.end > p.range.start &&
        r.range.start >= p.range.start &&
        r.range.start < p.range.end
      ) {
        if (
          p.range.start === r.range.start &&
          p.value &&
          p.range.end <= r.range.end
        )
          break;
        removed = true;
        break;
      }
      start += p.value.length - (p.range.end - p.range.start);
    }
    if (!removed) mapping.set(start, r.sourceKey);
  }
  const resolution = resolveMermaidBlockSource(next, model, mapping);
  if (!resolution.model)
    return blockNoChange(model, "invalid", m.classPatchRejected());
  const keys = new Set(resolution.document.records.map((r) => r.sourceKey));
  for (const r of model.sourceDocument.records)
    if (!options.removed?.has(r.sourceKey) && !keys.has(r.sourceKey))
      return blockNoChange(model, "invalid", m.classPatchRejected());
  for (const c of model.comments) {
    if (
      options.removed?.has(c.sourceKey) ||
      options.commentTransfers?.has(c.sourceKey)
    )
      continue;
    const after = resolution.model.comments.find(
      (n) => n.sourceKey === c.sourceKey,
    );
    if (
      !after ||
      after.anchorKey !== c.anchorKey ||
      after.position !== c.position ||
      after.parentKey !== c.parentKey
    )
      return blockNoChange(model, "invalid", m.classPatchRejected());
  }
  return {
    changed: true,
    status: "changed",
    source: next,
    model: resolution.model,
    patches: sorted,
    reason: "applied",
    selection: options.selection,
    impact: options.impact ?? { records: [], grids: [] },
  };
}
/** Full generation is reserved for the initial empty diagram. Existing models
 * already own exact Source bytes; all subsequent edits use record patches. */
export function generateMermaidBlockDiagramSource(
  model: MermaidBlockDiagramModel,
) {
  return model.sourceDocument.source || "block-beta\ncolumns auto\n";
}
