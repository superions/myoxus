// SPDX-License-Identifier: AGPL-3.0-or-later

import type { C4FieldValue, MermaidC4Model } from "../model.js";
import { C4WriteError, writeC4Patches, type C4Patch } from "../patches.js";
import { c4RecordUnit, c4RecordEnd } from "../source-unit.js";
import { c4CallPatch } from "../record-writer.js";
import { c4PairArguments } from "../identity-arguments.js";
import { c4CommandResult, c4NoChange } from "./model.js";
import { mermaidMessages as m } from "../../../i18n.js";

export type C4RecordStylePolicy = "keep" | "transfer";
export type C4RecordReconnectDraft = Readonly<{
  basis: string;
  sourceKey: string;
  from: string;
  to: string;
  policy: C4RecordStylePolicy;
}>;
export type C4PairFieldImpact = Readonly<{
  selectionId: string;
  beforePair?: string;
  afterPair?: string;
  beforeStep?: number;
  afterStep?: number;
  fields: readonly {
    field: string;
    before?: C4FieldValue;
    after?: C4FieldValue;
  }[];
}>;
/** Compare replayed native objects; partial reconnect can split a pair or change style applicability. */
export function c4PairFieldImpact(
  before: MermaidC4Model,
  after: MermaidC4Model,
): C4PairFieldImpact[] {
  return [
    ...new Set(
      [...before.relationships, ...after.relationships].map(
        (r) => r.resolution!.selectionId,
      ),
    ),
  ].flatMap((selectionId) => {
    const a = before.relationships.find(
        (r) => r.resolution!.selectionId === selectionId,
      ),
      b = after.relationships.find(
        (r) => r.resolution!.selectionId === selectionId,
      );
    const fields = [
      ...new Set([
        ...Object.keys(a?.resolution?.fields ?? {}),
        ...Object.keys(b?.resolution?.fields ?? {}),
      ]),
    ].flatMap((field) => {
      const x = a?.resolution?.fields[field],
        y = b?.resolution?.fields[field];
      return Object.is(x, y) ||
        (x &&
          y &&
          typeof x === "object" &&
          typeof y === "object" &&
          x.text === y.text)
        ? []
        : [{ field, before: x, after: y }];
    });
    return fields.length || !a || !b || a.dynamicStep !== b.dynamicStep
      ? [
          {
            selectionId,
            beforePair: a && `${a.from} → ${a.to}`,
            afterPair: b && `${b.from} → ${b.to}`,
            beforeStep: a?.dynamicStep,
            afterStep: b?.dynamicStep,
            fields,
          },
        ]
      : [];
  });
}
/** A retained or transferred early style must follow its declaration to keep an actual native effect. */
function moveEarlyStyles(
  model: MermaidC4Model,
  sourceKey: string,
  styleKeys: readonly string[],
) {
  const records = model.sourceDocument.records,
    anchor = records.find((r) => r.sourceKey === sourceKey)!;
  const anchorUnit = c4RecordUnit(model, anchor)!,
    offset = c4RecordEnd(anchorUnit.at(-1)!);
  const styles = records.filter(
    (r) =>
      styleKeys.includes(r.sourceKey) &&
      r.range.start < anchorUnit[0].range.start,
  );
  if (!styles.length) return model;
  let text = "";
  const identities: (readonly [number, string])[] = [],
    patches: C4Patch[] = [];
  for (const record of styles) {
    const unit = c4RecordUnit(model, record)!,
      start = unit[0].range.start,
      end = c4RecordEnd(unit.at(-1)!);
    identities.push(
      ...unit.map(
        (r) => [text.length + r.range.start - start, r.sourceKey] as const,
      ),
    );
    text += model.sourceDocument.source.slice(start, end);
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
  return writeC4Patches(model, patches).model;
}
function prepareC4RecordReconnectImpl(
  model: MermaidC4Model,
  sourceKey: string,
  from: string,
  to: string,
  policy: C4RecordStylePolicy | null,
) {
  const record = model.sourceDocument.records.find(
      (r) => r.sourceKey === sourceKey && r.kind === "relationship",
    ),
    occurrence = model.occurrences.find((o) => o.sourceKey === sourceKey);
  const owner = model.relationships.find(
    (r) => r.resolution!.selectionId === occurrence?.selectionId,
  );
  const reject = () => ({
    diagnostic: m.visualConnectionInvalidTarget(),
    needsPolicy: false,
  });
  if (
    !record ||
    !owner ||
    ![from, to].every((alias) =>
      model.elements.some((e) => e.alias === alias),
    ) ||
    (policy !== null && policy !== "keep" && policy !== "transfer")
  )
    return reject();
  const collision = model.relationships.find(
    (r) => r !== owner && r.from === from && r.to === to,
  );
  if (collision)
    return { ...reject(), collision: collision.resolution!.selectionId };
  const styles = model.sourceDocument.records.filter(
    (r) =>
      r.kind === "relationship-update" &&
      model.occurrences.some(
        (o) =>
          o.sourceKey === r.sourceKey &&
          o.selectionId === owner.resolution!.selectionId &&
          o.applied,
      ),
  );
  const changes = owner.from !== from || owner.to !== to;
  const remaining = owner.resolution!.sourceKeys.length > 1;
  const needsPolicy =
    changes && remaining && !!styles.length && policy === null;
  if (needsPolicy) return { needsPolicy, diagnostic: undefined };
  const chosen = remaining ? (policy ?? "keep") : "transfer";
  const selected = [record, ...(chosen === "transfer" ? styles : [])];
  try {
    const patches = selected.flatMap((r) => {
      const args = r.arguments!.map((a) => ({ ...a }));
      let edited = false;
      for (const ref of c4PairArguments(
        model,
        r,
        owner.resolution!.selectionId,
      )) {
        const value = ref.field === "from" ? from : to;
        if (owner[ref.field] === value || args[ref.index].value === value)
          continue;
        args[ref.index].value = value;
        edited = true;
      }
      return edited ? [c4CallPatch(model, r.sourceKey, r.callKind!, args)] : [];
    });
    const patched = writeC4Patches(model, patches);
    const anchor =
      chosen === "transfer"
        ? sourceKey
        : model.sourceDocument.records.find(
            (r) =>
              r.sourceKey !== sourceKey &&
              owner.resolution!.sourceKeys.includes(r.sourceKey),
          )?.sourceKey;
    const next = {
      model:
        changes && anchor
          ? moveEarlyStyles(
              patched.model,
              anchor,
              styles.map((r) => r.sourceKey),
            )
          : patched.model,
    };
    if (
      changes &&
      styles.some((style) => {
        const occurrence = next.model.occurrences.find(
          (o) => o.sourceKey === style.sourceKey,
        );
        const pair = next.model.relationships.find(
          (r) => r.resolution!.selectionId === occurrence?.selectionId,
        );
        return (
          !occurrence?.applied ||
          pair?.from !== (chosen === "transfer" ? from : owner.from) ||
          pair?.to !== (chosen === "transfer" ? to : owner.to)
        );
      })
    )
      return reject();
    const nextId = next.model.occurrences.find(
      (o) => o.sourceKey === sourceKey,
    )?.selectionId;
    const actual = next.model.relationships.find(
      (r) => r.resolution!.selectionId === nextId,
    );
    if (!actual || actual.from !== from || actual.to !== to) return reject();
    const draft: C4RecordReconnectDraft = {
      basis: model.sourceDocument.source,
      sourceKey,
      from,
      to,
      policy: chosen,
    };
    return {
      needsPolicy: false,
      model: next.model,
      selection: nextId,
      draft,
      impact: c4PairFieldImpact(model, next.model),
      styles: styles.map((r) => {
        const before = model.occurrences.find(
            (o) => o.sourceKey === r.sourceKey,
          )!,
          after = next.model.occurrences.find(
            (o) => o.sourceKey === r.sourceKey,
          )!;
        const target = next.model.relationships.find(
          (p) => p.resolution!.selectionId === after.selectionId,
        );
        return {
          sourceKey: r.sourceKey,
          call: r.callKind!,
          line: r.range.line,
          afterLine: next.model.sourceDocument.records.find(
            (n) => n.sourceKey === r.sourceKey,
          )!.range.line,
          beforeScope: r.scopeAliases,
          afterScope: next.model.sourceDocument.records.find(
            (n) => n.sourceKey === r.sourceKey,
          )!.scopeAliases,
          beforeFields: before.effectiveFields,
          afterFields: after.effectiveFields,
          applied: after.applied,
          target: target && `${target.from} → ${target.to}`,
        };
      }),
    };
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return reject();
  }
}
export type C4RecordReconnectPreparation = {
  needsPolicy: boolean;
  diagnostic?: string;
  collision?: string;
  model?: MermaidC4Model;
  selection?: string;
  draft?: C4RecordReconnectDraft;
  impact?: readonly C4PairFieldImpact[];
  styles?: readonly {
    sourceKey: string;
    call: string;
    line: number;
    afterLine: number;
    beforeScope: readonly string[];
    afterScope: readonly string[];
    beforeFields: readonly string[];
    afterFields: readonly string[];
    applied: boolean;
    target?: string;
  }[];
};
export function prepareC4RecordReconnect(
  model: MermaidC4Model,
  sourceKey: string,
  from: string,
  to: string,
  policy: C4RecordStylePolicy | null,
): C4RecordReconnectPreparation {
  return prepareC4RecordReconnectImpl(model, sourceKey, from, to, policy);
}
export function reconnectC4Record(
  model: MermaidC4Model,
  draft: C4RecordReconnectDraft,
  confirmed: boolean,
) {
  if (!confirmed) return c4NoChange(model);
  if (model.sourceDocument.source !== draft.basis)
    return c4NoChange(model, m.chartSourceChanged());
  const checked = prepareC4RecordReconnect(
    model,
    draft.sourceKey,
    draft.from,
    draft.to,
    draft.policy,
  );
  return checked.model
    ? c4CommandResult(
        model,
        { source: checked.model.sourceDocument.source, model: checked.model },
        checked.selection,
      )
    : c4NoChange(model, checked.diagnostic ?? m.classPatchRejected());
}
