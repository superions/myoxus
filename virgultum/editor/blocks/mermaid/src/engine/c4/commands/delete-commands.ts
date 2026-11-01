// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Model } from "../model.js";
import type { C4SourceRecord } from "../source-document.js";
import { c4AliasArguments } from "../identity-arguments.js";
import { c4RecordEnd, c4RecordUnit } from "../source-unit.js";
import { c4CallPatch } from "../record-writer.js";
import { c4RelationshipStyleRecords } from "./relationship-appearance-commands.js";
import { C4WriteError, writeC4Patches, type C4Patch } from "../patches.js";
import { c4ModelImpact, type C4MoveImpact } from "./model-impact.js";
import {
  c4PairFieldImpact,
  type C4PairFieldImpact,
} from "./record-reconnect-commands.js";
import { c4CommandResult, c4NoChange, type C4CommandResult } from "./model.js";
import { mermaidMessages as m } from "../../../i18n.js";

export type C4DeleteTarget = Readonly<{
  selectionId: string;
  /** Omitted means the complete native object/pair, including every declaration and reference. */
  recordKey?: string;
  children?:
    | Readonly<{ strategy: "delete" }>
    | Readonly<{ strategy: "adopt"; parentKey: string | null }>;
}>;
export type C4DeleteRecordImpact = Readonly<{
  sourceKey: string;
  call: string;
  line: number;
  afterLine?: number;
  beforeScope: readonly string[];
  afterScope?: readonly string[];
}>;
export type C4DeleteStyleImpact = Readonly<{
  sourceKey: string;
  call: string;
  line: number;
  beforeApplied: boolean;
  afterApplied: boolean;
  beforeFields: readonly string[];
  afterFields: readonly string[];
}>;
export type C4DeleteDraft = Readonly<{
  basis: string;
  target: C4DeleteTarget;
  removed: readonly C4DeleteRecordImpact[];
  moved: readonly C4DeleteRecordImpact[];
  impact: readonly C4MoveImpact[];
  pairs: readonly C4PairFieldImpact[];
  styles: readonly C4DeleteStyleImpact[];
}>;
export type C4DeletePreparation = Readonly<{
  draft?: C4DeleteDraft;
  result?: C4CommandResult;
  diagnostic?: string;
}>;
function fail(): C4DeletePreparation {
  return { diagnostic: m.classPatchRejected() };
}
function hasErrors(model: MermaidC4Model) {
  return model.sourceDocument.diagnostics.some((d) => d.severity === "error");
}
function objects(model: MermaidC4Model) {
  return [...model.elements, ...model.boundaries];
}
function mergedRanges(ranges: readonly { start: number; end: number }[]) {
  const merged: { start: number; end: number }[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end)
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
function recordImpact(
  record: C4SourceRecord,
  after?: C4SourceRecord,
): C4DeleteRecordImpact {
  return {
    sourceKey: record.sourceKey,
    call:
      record.callKind ??
      (record.kind === "frontmatter"
        ? "YAML"
        : record.raw.trim().split(/\s/)[0] || "—"),
    line: record.range.line,
    afterLine: after?.range.line,
    beforeScope: record.scopeAliases,
    afterScope: after?.scopeAliases,
  };
}

/** A delete previews a complete replay, never a geometry-derived alias or cascade. */
function prepareDelete(
  model: MermaidC4Model,
  target: C4DeleteTarget,
): C4DeletePreparation {
  if (hasErrors(model)) return fail();
  const owner = [...objects(model), ...model.relationships].find(
    (o) => o.resolution!.selectionId === target.selectionId,
  );
  if (!owner) return fail();
  const records = model.sourceDocument.records,
    declarations = new Set(
      target.recordKey ? [target.recordKey] : owner.resolution!.sourceKeys,
    );
  if (
    [...declarations].some((key) => !owner.resolution!.sourceKeys.includes(key))
  )
    return fail();
  const boundary = "parentId" in owner,
    relation = "from" in owner;
  if (boundary && !target.children) return fail();
  if (!boundary && target.children) return fail();
  const deleted = new Set<string>(),
    retarget = new Map<string, C4Patch>(),
    adoptBodies: C4SourceRecord[][] = [];
  const complete =
    !target.recordKey || owner.resolution!.sourceKeys.length === 1;
  const removedOwners = new Set(complete ? [target.selectionId] : []);
  const structural = (record: C4SourceRecord) => {
    deleted.add(record.sourceKey);
    if (record.braceKey) deleted.add(record.braceKey);
    if (record.closeKey) deleted.add(record.closeKey);
  };
  for (const key of declarations)
    structural(records.find((r) => r.sourceKey === key)!);
  const selectedBoundaries = boundary
    ? records.filter((r) => declarations.has(r.sourceKey))
    : [];
  if (boundary && target.children?.strategy === "delete") {
    // Children are visible native owners as well as physical declarations. The
    // preview names every repeated declaration removed by this explicit cascade.
    let changed = true;
    while (changed) {
      changed = false;
      for (const object of objects(model)) {
        if (removedOwners.has(object.resolution!.selectionId)) continue;
        const physical = object.resolution!.sourceKeys.some((key) =>
          records
            .find((r) => r.sourceKey === key)!
            .scopeKeys.some((scope) => declarations.has(scope)),
        );
        const parent =
          "boundaryId" in object ? object.boundaryId : object.parentId;
        const semantic = objects(model).some(
          (candidate) =>
            "parentId" in candidate &&
            candidate.alias === parent &&
            removedOwners.has(candidate.resolution!.selectionId),
        );
        if (physical || semantic) {
          removedOwners.add(object.resolution!.selectionId);
          object.resolution!.sourceKeys.forEach((key) => declarations.add(key));
          changed = true;
        }
      }
    }
  }
  let parent: C4SourceRecord | undefined;
  if (boundary && target.children?.strategy === "adopt") {
    const parentKey = target.children.parentKey;
    parent = parentKey
      ? records.find((r) => r.sourceKey === parentKey)
      : undefined;
    if (
      target.children.parentKey &&
      (!parent ||
        parent.kind !== "boundary-open" ||
        !parent.closeKey ||
        declarations.has(parent.sourceKey) ||
        parent.scopeKeys.some((key) => declarations.has(key)))
    )
      return fail();
    for (const record of selectedBoundaries) {
      if (!record.closeKey) return fail();
      const close = records.find((r) => r.sourceKey === record.closeKey)!;
      adoptBodies.push(
        records.filter(
          (r) =>
            r.range.start > record.range.start &&
            r.range.start < close.range.start,
        ),
      );
    }
  }
  for (const object of objects(model).filter((o) =>
    removedOwners.has(o.resolution!.selectionId),
  )) {
    const declarationKeys = new Set(object.resolution!.sourceKeys);
    for (const record of records) {
      const refs = c4AliasArguments(
        model,
        record,
        { alias: object.alias, resolution: object.resolution! },
        declarationKeys,
      );
      if (!refs.length) continue;
      if (
        boundary &&
        target.children?.strategy === "adopt" &&
        refs.every((ref) => ref.field === "parentBoundary")
      ) {
        const args = record.arguments!.map((a) => ({ ...a }));
        refs.forEach(({ index }) => {
          args[index].value = parent
            ? model.boundaries.find((b) =>
                b.resolution!.sourceKeys.includes(parent!.sourceKey),
              )!.alias
            : "global";
        });
        retarget.set(
          record.sourceKey,
          c4CallPatch(model, record.sourceKey, record.callKind!, args),
        );
      } else structural(record);
    }
  }
  if (relation && complete) {
    for (const record of c4RelationshipStyleRecords(
      model,
      target.selectionId,
    )) {
      const occurrence = model.occurrences.find(
        (o) => o.sourceKey === record.sourceKey,
      )!;
      if (occurrence.selectionId === target.selectionId || !occurrence.applied)
        deleted.add(record.sourceKey);
    }
  }
  for (const key of declarations)
    structural(records.find((r) => r.sourceKey === key)!);
  // Syntax and comments belonging to removed declarations disappear together.
  for (const record of records)
    if (record.anchor && deleted.has(record.anchor.sourceKey))
      deleted.add(record.sourceKey);
  const ranges: { start: number; end: number }[] = [];
  for (const record of records.filter((r) => deleted.has(r.sourceKey))) {
    if (record.kind === "boundary-open") {
      const unit = c4RecordUnit(model, record);
      if (!unit) return fail();
      ranges.push({
        start: unit[0].range.start,
        end: c4RecordEnd(unit.at(-1)!),
      });
    } else ranges.push({ start: record.range.start, end: c4RecordEnd(record) });
  }
  const removal = mergedRanges(ranges),
    patches: C4Patch[] = removal.map((r) => ({ ...r, text: "" }));
  let text = "";
  const identities: (readonly [number, string])[] = [];
  for (const body of adoptBodies)
    for (const record of body) {
      if (deleted.has(record.sourceKey)) continue;
      let raw = record.raw;
      const patch = retarget.get(record.sourceKey);
      if (patch)
        raw =
          raw.slice(0, patch.start - record.range.start) +
          patch.text +
          raw.slice(patch.end - record.range.start);
      identities.push([text.length, record.sourceKey]);
      text += raw + record.eol;
    }
  if (text) {
    const close =
      parent && records.find((r) => r.sourceKey === parent!.closeKey)!;
    const offset = close?.range.start ?? model.sourceDocument.source.length;
    if (removal.some((r) => r.start < offset && offset < r.end)) return fail();
    const prefix =
      offset > 0 &&
      !/[\r\n]$/.test(model.sourceDocument.source.slice(0, offset))
        ? model.sourceDocument.newline
        : "";
    patches.push({
      start: offset,
      end: offset,
      text:
        prefix +
        text +
        (!/[\r\n]$/.test(text) ? model.sourceDocument.newline : ""),
      identities: identities.map(([i, key]) => [prefix.length + i, key]),
    });
  }
  for (const [key, patch] of retarget)
    if (
      !deleted.has(key) &&
      !removal.some((r) => r.start <= patch.start && patch.end <= r.end)
    )
      patches.push(patch);
  const next = writeC4Patches(model, patches);
  if (hasErrors(next.model)) return fail();
  const remaining = [...objects(next.model), ...next.model.relationships].find(
    (o) => o.resolution!.selectionId === target.selectionId,
  );
  const priorParent = !relation
    ? "boundaryId" in owner
      ? owner.boundaryId
      : owner.parentId
    : undefined;
  const fallback = parent
    ? next.model.occurrences.find((o) => o.sourceKey === parent!.sourceKey)
        ?.selectionId
    : next.model.boundaries.find((b) => b.alias === priorParent)?.resolution!
        .selectionId;
  const result = c4CommandResult(
    model,
    next,
    remaining?.resolution!.selectionId ?? fallback,
  );
  return {
    result,
    draft: {
      basis: model.sourceDocument.source,
      target: structuredClone(target),
      ...c4DeleteImpact(model, next.model),
    },
  };
}
/** Complete original-to-final impact is shared by single and atomic batch deletion. */
export function c4DeleteImpact(model: MermaidC4Model, next: MermaidC4Model) {
  const records = model.sourceDocument.records;
  const removed: C4DeleteRecordImpact[] = [],
    moved: C4DeleteRecordImpact[] = [];
  for (const record of records) {
    const after = next.sourceDocument.records.find(
      (r) => r.sourceKey === record.sourceKey,
    );
    if (!after) removed.push(recordImpact(record));
    else if (
      JSON.stringify(record.scopeKeys) !== JSON.stringify(after.scopeKeys)
    )
      moved.push(recordImpact(record, after));
  }
  const styles = model.occurrences
    .filter((o) => o.category === "update" && o.kind !== "UpdateLayoutConfig")
    .flatMap((o) => {
      const after = next.occurrences.find((n) => n.sourceKey === o.sourceKey);
      if (
        after &&
        o.applied === after.applied &&
        JSON.stringify(o.effectiveFields) ===
          JSON.stringify(after.effectiveFields) &&
        o.selectionId === after.selectionId
      )
        return [];
      const r = records.find((r) => r.sourceKey === o.sourceKey)!;
      return [
        {
          sourceKey: r.sourceKey,
          call: r.callKind!,
          line: r.range.line,
          beforeApplied: o.applied,
          afterApplied: after?.applied ?? false,
          beforeFields: o.effectiveFields,
          afterFields: after?.effectiveFields ?? [],
        },
      ];
    });
  return {
    removed,
    moved,
    impact: c4ModelImpact(model, next),
    pairs: c4PairFieldImpact(model, next),
    styles,
  };
}
export function prepareC4Delete(
  model: MermaidC4Model,
  target: C4DeleteTarget,
): C4DeletePreparation {
  try {
    return prepareDelete(model, target);
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return fail();
  }
}
/** Confirmation replays the exact intent against its checked Source basis once. */
export function deleteC4(
  model: MermaidC4Model,
  draft: C4DeleteDraft,
  confirmed: boolean,
) {
  if (!confirmed) return c4NoChange(model);
  if (draft.basis !== model.sourceDocument.source)
    return c4NoChange(model, m.chartSourceChanged());
  const checked = prepareC4Delete(model, draft.target);
  return (
    checked.result ??
    c4NoChange(model, checked.diagnostic ?? m.classPatchRejected())
  );
}
