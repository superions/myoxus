// SPDX-License-Identifier: AGPL-3.0-or-later

import type { C4FieldValue, MermaidC4Model } from "../model.js";
import { c4RecordUnit, c4RecordEnd } from "../source-unit.js";
import { C4WriteError, writeC4Patches, type C4Patch } from "../patches.js";
import { c4CommandResult, c4NoChange } from "./model.js";
import { mermaidMessages as m } from "../../../i18n.js";

export type C4DynamicOrderDraft = Readonly<{
  basis: string;
  selectionId: string;
  beforePair: string | null;
  records: readonly {
    sourceKey: string;
    call: string;
    line: number;
    fromScope: readonly string[];
    firstOccurrence: boolean;
  }[];
  targetScope: readonly string[];
  targetLine: number;
  steps: readonly {
    selectionId: string;
    from: string;
    to: string;
    before: number;
    after: number;
  }[];
  fields: readonly {
    selectionId: string;
    from: string;
    to: string;
    field: string;
    before?: C4FieldValue;
    after?: C4FieldValue;
  }[];
}>;
/** Dynamic order belongs to first native pair creation. Move the pair's ordered declarations
 * and applied updates as real Source units; moving only its latest shadowed record cannot do this. */
export function prepareC4DynamicOrder(
  model: MermaidC4Model,
  selectionId: string,
  beforePair: string | null,
): {
  draft?: C4DynamicOrderDraft;
  model?: MermaidC4Model;
  diagnostic?: string;
} {
  const reject = () => ({ diagnostic: m.classPatchRejected() });
  if (model.headerLine !== "C4Dynamic") return reject();
  const owner = model.relationships.find(
    (r) => r.resolution!.selectionId === selectionId,
  );
  const target = beforePair
    ? model.relationships.find((r) => r.resolution!.selectionId === beforePair)
    : undefined;
  if (!owner || (beforePair && !target)) return reject();
  const firstOwn = model.sourceDocument.records.find(
    (r) => r.sourceKey === owner.resolution!.sourceKeys[0],
  )!;
  const draft: C4DynamicOrderDraft = {
    basis: model.sourceDocument.source,
    selectionId,
    beforePair,
    records: [],
    targetScope: [...firstOwn.scopeAliases],
    targetLine: firstOwn.range.line,
    steps: [],
    fields: [],
  };
  const ids = model.relationships.map((r) => r.resolution!.selectionId);
  if (beforePair === selectionId) return { draft, model };
  const expected = ids.filter((id) => id !== selectionId),
    targetIndex = target ? expected.indexOf(beforePair!) : expected.length;
  expected.splice(targetIndex, 0, selectionId);
  if (JSON.stringify(expected) === JSON.stringify(ids)) return { draft, model };
  const records = model.sourceDocument.records;
  const owned = new Set(
    model.occurrences
      .filter(
        (o) =>
          o.selectionId === selectionId &&
          o.applied &&
          (o.category === "relationship" || o.kind === "UpdateRelStyle"),
      )
      .map((o) => o.sourceKey),
  );
  const units = records
    .filter((r) => owned.has(r.sourceKey))
    .map((r) => ({ record: r, unit: c4RecordUnit(model, r) }));
  if (!units.length || units.some((u) => !u.unit?.length)) return reject();
  const first =
    target &&
    records.find((r) => r.sourceKey === target.resolution!.sourceKeys[0]);
  const offset = first
    ? c4RecordUnit(model, first)?.[0]?.range.start
    : model.sourceDocument.source.length;
  if (offset === undefined) return reject();
  let text = "";
  const identities: (readonly [number, string])[] = [],
    patches: C4Patch[] = [];
  // Keep exact unit bytes/order. Identity offsets refer to the single atomic insertion.
  for (const { unit } of units) {
    const start = unit![0].range.start,
      end = c4RecordEnd(unit!.at(-1)!);
    if (offset > start && offset < end) return reject();
    const content = model.sourceDocument.source.slice(start, end);
    identities.push(
      ...unit!.map(
        (r) => [text.length + r.range.start - start, r.sourceKey] as const,
      ),
    );
    text += content;
    if (!/[\r\n]$/.test(text)) text += model.sourceDocument.newline;
    patches.push({ start, end, text: "" });
  }
  const prefix =
    offset > 0 && !/[\r\n]$/.test(model.sourceDocument.source.slice(0, offset))
      ? model.sourceDocument.newline
      : "";
  patches.push({
    start: offset,
    end: offset,
    text: prefix + text,
    identities: identities.map(([at, key]) => [at + prefix.length, key]),
  });
  try {
    const next = writeC4Patches(model, patches).model;
    // Replay can merge/split mutable pairs. Never advertise the requested order if it did not happen.
    if (
      JSON.stringify(
        next.relationships.map((r) => r.resolution!.selectionId),
      ) !== JSON.stringify(expected)
    )
      return reject();
    const moved = next.sourceDocument.records.find(
      (r) => r.sourceKey === units[0].record.sourceKey,
    )!;
    const fields: C4DynamicOrderDraft["fields"][number][] = [];
    const steps: C4DynamicOrderDraft["steps"][number][] = [];
    for (const after of next.relationships) {
      const before = model.relationships.find(
        (r) => r.resolution!.selectionId === after.resolution!.selectionId,
      )!;
      if (before.dynamicStep !== after.dynamicStep)
        steps.push({
          selectionId: after.resolution!.selectionId,
          from: after.from,
          to: after.to,
          before: before.dynamicStep!,
          after: after.dynamicStep!,
        });
      for (const field of new Set([
        ...Object.keys(before.resolution!.fields),
        ...Object.keys(after.resolution!.fields),
      ])) {
        const a = before.resolution!.fields[field],
          b = after.resolution!.fields[field];
        if (JSON.stringify(a) !== JSON.stringify(b))
          fields.push({
            selectionId: after.resolution!.selectionId,
            from: after.from,
            to: after.to,
            field,
            before: a,
            after: b,
          });
      }
    }
    return {
      model: next,
      draft: {
        ...draft,
        records: units.flatMap(({ unit }) =>
          unit!.map((record) => ({
            sourceKey: record.sourceKey,
            call: record.callKind ?? record.raw.trim(),
            line: record.range.line,
            fromScope: [...record.scopeAliases],
            firstOccurrence: record.sourceKey === firstOwn.sourceKey,
          })),
        ),
        targetScope: [...moved.scopeAliases],
        targetLine: moved.range.line,
        steps,
        fields,
      },
    };
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return reject();
  }
}
export function reorderC4DynamicPair(
  model: MermaidC4Model,
  draft: C4DynamicOrderDraft,
  confirmed: boolean,
) {
  if (!confirmed) return c4NoChange(model);
  if (draft.basis !== model.sourceDocument.source)
    return c4NoChange(model, m.chartSourceChanged());
  const checked = prepareC4DynamicOrder(
    model,
    draft.selectionId,
    draft.beforePair,
  );
  return checked.model
    ? c4CommandResult(
        model,
        { source: checked.model.sourceDocument.source, model: checked.model },
        draft.selectionId,
      )
    : c4NoChange(model, checked.diagnostic ?? m.classPatchRejected());
}
