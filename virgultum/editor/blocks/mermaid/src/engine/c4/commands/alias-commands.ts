// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as m } from "../../../i18n.js";
import type { MermaidC4Model } from "../model.js";
import { c4CallSource, c4Quote } from "../runtime-contract.js";
import { splitArgs } from "../source-document.js";
import { C4WriteError, writeC4Patches, type C4Patch } from "../patches.js";
import { c4CommandResult, c4NoChange } from "./model.js";
import { c4AliasArguments } from "../identity-arguments.js";

export type C4AliasImpact = Readonly<{
  sourceKey: string;
  call: string;
  line: number;
  fields: readonly string[];
  effectiveFields: readonly string[];
}>;
export type C4AliasRenameDraft = Readonly<{
  basis: string;
  selectionId: string;
  recordKey?: string;
  previousAlias: string;
  alias: string;
  impact: readonly C4AliasImpact[];
  retainedReferences: readonly C4AliasImpact[];
  remainingKeys: readonly string[];
}>;
export type C4AliasPreparation = Readonly<{
  draft?: C4AliasRenameDraft;
  model?: MermaidC4Model;
  diagnostic?: string;
}>;

/** Quoted aliases are native strings, not an identifier regex. Require exact lexer roundtrip. */
export function isC4Alias(value: string) {
  if (!value || value === "global" || value !== value.trim()) return false;
  const source = c4CallSource("Person", [
    { key: "", value },
    { key: "", value: "" },
  ]);
  return (
    splitArgs(source.slice(source.indexOf("(") + 1, -1))?.[0]?.value === value
  );
}
function aliasOwner(model: MermaidC4Model, selectionId: string) {
  return [...model.elements, ...model.boundaries].find(
    (e) => e.resolution?.selectionId === selectionId,
  );
}
/** Group rename owns every declaration and reference, including currently ineffective updates.
 * A single-record split changes only that declaration and leaves old-alias references intact. */
export function prepareC4AliasRename(
  model: MermaidC4Model,
  selectionId: string,
  alias: string,
  recordKey?: string,
): C4AliasPreparation {
  const owner = aliasOwner(model, selectionId);
  const reject = () => ({
    diagnostic: m.classPatchRejected(),
    draft: undefined,
  });
  if (!owner?.resolution || !isC4Alias(alias)) return reject();
  const all = [...model.elements, ...model.boundaries];
  if (
    all.some(
      (e) => e.alias === alias && e.resolution?.selectionId !== selectionId,
    )
  )
    return reject();
  if (recordKey && !owner.resolution.sourceKeys.includes(recordKey))
    return reject();
  // A single declaration may split an object, never merge it into another one.
  if (recordKey && alias !== owner.alias && all.some((e) => e.alias === alias))
    return reject();
  const declarations = new Set(
      recordKey ? [recordKey] : owner.resolution.sourceKeys,
    ),
    impact: C4AliasImpact[] = [],
    retainedReferences: C4AliasImpact[] = [],
    patches: C4Patch[] = [];
  for (const record of model.sourceDocument.records) {
    const indexes = c4AliasArguments(
      model,
      record,
      { alias: owner.alias, resolution: owner.resolution },
      declarations,
      !!recordKey,
    );
    const occurrence = model.occurrences.find(
      (o) => o.sourceKey === record.sourceKey,
    );
    if (recordKey) {
      const retained = c4AliasArguments(
        model,
        record,
        { alias: owner.alias, resolution: owner.resolution! },
        new Set(),
        false,
      );
      if (retained.length)
        retainedReferences.push({
          sourceKey: record.sourceKey,
          call: record.callKind!,
          line: record.range.line,
          fields: retained.map((i) => i.field),
          effectiveFields: occurrence?.effectiveFields ?? [],
        });
    }
    if (!indexes.length) continue;
    impact.push({
      sourceKey: record.sourceKey,
      call: record.callKind!,
      line: record.range.line,
      fields: indexes.map((i) => i.field),
      effectiveFields: occurrence?.effectiveFields ?? [],
    });
    for (const { index } of indexes) {
      const binding = record.argumentBindings?.[index];
      if (!binding) return reject();
      // Replacing the token's value preserves its original spacing and quotes.
      const text =
        model.sourceDocument.source[binding.value.start - 1] === '"' &&
        model.sourceDocument.source[binding.value.end] === '"'
          ? c4Quote(alias).slice(1, -1)
          : c4Quote(alias);
      patches.push({
        start: binding.value.start,
        end: binding.value.end,
        text,
      });
    }
  }
  if (!impact.length) return reject();
  try {
    const next =
      alias === owner.alias
        ? { source: model.sourceDocument.source, model }
        : writeC4Patches(model, patches);
    const draft: C4AliasRenameDraft = {
      basis: model.sourceDocument.source,
      selectionId,
      recordKey,
      previousAlias: owner.alias,
      alias,
      impact,
      retainedReferences,
      remainingKeys: recordKey
        ? owner.resolution.sourceKeys.filter((k) => k !== recordKey)
        : [],
    };
    return { draft, diagnostic: undefined, model: next.model };
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return reject();
  }
}
/** Recompute the impact on the same basis; cancel/stale/no-op never yield a write. */
export function renameC4Alias(
  model: MermaidC4Model,
  draft: C4AliasRenameDraft,
  confirmed: boolean,
) {
  if (!confirmed) return c4NoChange(model);
  if (draft.basis !== model.sourceDocument.source)
    return c4NoChange(model, m.chartSourceChanged());
  const prepared = prepareC4AliasRename(
    model,
    draft.selectionId,
    draft.alias,
    draft.recordKey,
  );
  if (!prepared.draft || !prepared.model)
    return c4NoChange(model, prepared.diagnostic);
  return c4CommandResult(
    model,
    { source: prepared.model.sourceDocument.source, model: prepared.model },
    prepared.model.sourceDocument.selectionBindings?.find(
      (b) =>
        b.sourceKeys.some((k) =>
          prepared.draft!.impact.some((i) => i.sourceKey === k),
        ) && b.identity === draft.alias,
    )?.selectionId ?? draft.selectionId,
  );
}
