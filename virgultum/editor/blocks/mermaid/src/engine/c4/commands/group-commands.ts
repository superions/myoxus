// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Model } from "../model.js";
import { C4WriteError, writeC4Patches, type C4Patch } from "../patches.js";
import { c4CallPatch } from "../record-writer.js";
import { c4RecordEnd, c4RecordUnit } from "../source-unit.js";
import {
  c4CallSource,
  isC4BoundaryKind,
  type MermaidC4BoundaryKind,
} from "../runtime-contract.js";
import { isC4Alias } from "./alias-commands.js";
import { nextC4ElementAlias } from "./element-commands.js";
import { c4CommandResult, c4NoChange, type C4CommandResult } from "./model.js";
import { c4ModelImpact, type C4MoveImpact } from "./model-impact.js";
import { mermaidMessages as m } from "../../../i18n.js";

export type C4GroupingValue = Readonly<{
  kind: MermaidC4BoundaryKind;
  label: string;
  alias?: string;
}>;
export type C4GroupingDraft = Readonly<{
  basis: string;
  selectionIds: readonly string[];
  value: C4GroupingValue;
  parent: string;
  objects: readonly {
    alias: string;
    kind: string;
    parent: string;
    sourceKeys: readonly string[];
  }[];
  records: readonly { sourceKey: string; call: string; line: number }[];
  impact: readonly C4MoveImpact[];
}>;

/** Source membership consumes the entire checked selection, never spatial neighbours
 * or a filtered subset. Physical units retain their bytes and relative order. */
export function prepareC4Grouping(
  model: MermaidC4Model,
  selectionIds: readonly string[],
  value: C4GroupingValue,
): { draft?: C4GroupingDraft; result?: C4CommandResult; diagnostic?: string } {
  const fail = () => ({ diagnostic: m.classPatchRejected() });
  if (
    selectionIds.length < 2 ||
    new Set(selectionIds).size !== selectionIds.length ||
    !isC4BoundaryKind(value.kind)
  )
    return fail();
  const selected = selectionIds.map((id) =>
    model.elements.find((e) => e.resolution!.selectionId === id),
  );
  if (selected.some((e) => !e)) return fail();
  const elements = selected.filter((e) => !!e);
  const parents = new Set(elements.map((e) => e.boundaryId));
  if (parents.size !== 1) return fail();
  const parentAlias = elements[0].boundaryId;
  const parent = parentAlias
    ? model.boundaries.find((b) => b.alias === parentAlias)
    : undefined;
  if (parentAlias && !parent) return fail();
  const records = model.sourceDocument.records;
  const parentRecord =
    parent &&
    records.find((r) => r.sourceKey === parent.resolution!.declarationKey);
  const close =
    parentRecord && records.find((r) => r.sourceKey === parentRecord.closeKey);
  if (parentRecord && !close) return fail();
  const alias = value.alias ?? nextC4ElementAlias(model, value.kind);
  if (
    !isC4Alias(alias) ||
    alias === "global" ||
    [...model.elements, ...model.boundaries].some((e) => e.alias === alias)
  )
    return fail();
  const ids = new Set(selectionIds),
    keys = new Set(elements.flatMap((e) => e.resolution!.sourceKeys));
  const aliases = new Set(
    elements.flatMap((e) => [
      e.alias,
      ...records
        .filter((r) => e.resolution!.sourceKeys.includes(r.sourceKey))
        .map((r) => r.arguments![0].value),
    ]),
  );
  // Include unapplied early updates as well: moving a later first declaration
  // ahead of them would silently turn an ignored native update into an effect.
  for (const record of records) {
    if (
      record.callKind === "UpdateElementStyle" &&
      (aliases.has(record.arguments?.[0]?.value ?? "") ||
        model.occurrences.some(
          (o) =>
            o.sourceKey === record.sourceKey &&
            o.selectionId &&
            ids.has(o.selectionId),
        ))
    )
      keys.add(record.sourceKey);
  }
  const units = records
    .filter((r) => keys.has(r.sourceKey))
    .map((r) => c4RecordUnit(model, r));
  if (units.some((u) => !u?.length)) return fail();
  const moved = new Map(
    units.flatMap((u) => u!.map((r) => [r.sourceKey, r] as const)),
  );
  const physical = [...moved.values()].sort(
    (a, b) => a.range.start - b.range.start,
  );
  const ranges: { start: number; end: number }[] = [];
  for (const r of physical) {
    const last = ranges.at(-1);
    if (last && last.end === r.range.start) last.end = c4RecordEnd(r);
    else ranges.push({ start: r.range.start, end: c4RecordEnd(r) });
  }
  const newline = model.sourceDocument.newline,
    offset = close?.range.start ?? model.sourceDocument.source.length;
  if (ranges.some((r) => r.start < offset && offset < r.end)) return fail();
  const indent = parentRecord ? parentRecord.indent + "  " : "  ";
  let text =
    (offset && !/[\r\n]$/.test(model.sourceDocument.source.slice(0, offset))
      ? newline
      : "") +
    indent +
    c4CallSource(value.kind, [
      { key: "", value: alias },
      { key: "", value: value.label },
    ]) +
    " {" +
    newline;
  const identities: (readonly [number, string])[] = [];
  for (const range of ranges) {
    const start = text.length;
    for (const r of physical.filter(
      (r) => r.range.start >= range.start && r.range.start < range.end,
    ))
      identities.push([start + r.range.start - range.start, r.sourceKey]);
    text += model.sourceDocument.source.slice(range.start, range.end);
    if (!/[\r\n]$/.test(text)) text += newline;
  }
  text +=
    indent +
    "}" +
    (close || /[\r\n]$/.test(model.sourceDocument.source) ? newline : "");
  const patches: C4Patch[] = [
    ...ranges.map((r) => ({ ...r, text: "" })),
    { start: offset, end: offset, text, identities },
  ];
  try {
    let next = writeC4Patches(model, patches);
    const boundary = next.model.boundaries.find((b) => b.alias === alias);
    if (!boundary) return fail();
    for (const id of selectionIds) {
      const element = next.model.elements.find(
        (e) => e.resolution!.selectionId === id,
      );
      if (!element) return fail();
      if (element.boundaryId === alias) continue;
      const provider = element.resolution!.providers.parentBoundary;
      const record = records.find((r) => r.sourceKey === provider?.sourceKey);
      if (provider?.argumentIndex === undefined || !record?.arguments)
        return fail();
      const current = next.model.sourceDocument.records.find(
        (r) => r.sourceKey === record.sourceKey,
      )!;
      const args = current.arguments!.map((a) => ({ ...a }));
      args[provider.argumentIndex].value = alias;
      next = writeC4Patches(next.model, [
        c4CallPatch(
          next.model.sourceDocument,
          current.sourceKey,
          current.callKind!,
          args,
        ),
      ]);
    }
    // Grouping changes membership, not the effectiveness of retained updates.
    if (
      model.occurrences.some((before) => {
        const after = next.model.occurrences.find(
          (o) => o.sourceKey === before.sourceKey,
        );
        return !after || before.applied !== after.applied;
      })
    )
      return fail();
    const impact = c4ModelImpact(model, next.model);
    if (
      impact.some(
        (i) =>
          i.kind === "field" &&
          i.selectionId !== boundary.resolution!.selectionId &&
          !(ids.has(i.selectionId) && i.field === "parentBoundary"),
      )
    )
      return fail();
    if (
      selectionIds.some(
        (id) =>
          next.model.elements.find((e) => e.resolution!.selectionId === id)
            ?.boundaryId !== alias,
      )
    )
      return fail();
    const result = c4CommandResult(
      model,
      next,
      boundary.resolution!.selectionId,
    );
    result.boundaryFromSelection = [...selectionIds];
    return {
      result,
      draft: {
        basis: model.sourceDocument.source,
        selectionIds: [...selectionIds],
        value: { ...value, alias },
        parent: parentAlias,
        objects: elements.map((e) => ({
          alias: e.alias,
          kind: e.kind,
          parent: e.boundaryId,
          sourceKeys: [...e.resolution!.sourceKeys],
        })),
        records: physical.map((r) => ({
          sourceKey: r.sourceKey,
          call: r.callKind ?? r.kind,
          line: r.range.line,
        })),
        impact,
      },
    };
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return fail();
  }
}

export function groupC4Elements(
  model: MermaidC4Model,
  draft: C4GroupingDraft,
  confirmed: boolean,
) {
  if (!confirmed) return c4NoChange(model);
  if (draft.basis !== model.sourceDocument.source)
    return c4NoChange(model, m.chartSourceChanged());
  const checked = prepareC4Grouping(model, draft.selectionIds, draft.value);
  return checked.result ?? c4NoChange(model, checked.diagnostic);
}
