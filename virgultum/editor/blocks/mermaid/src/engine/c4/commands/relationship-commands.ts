// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  C4_CALLS,
  c4CallSource,
  c4RequiredArgumentIssues,
  isC4RelationshipKind,
  type MermaidC4RelationshipKind,
} from "../runtime-contract.js";
import { writeC4Patches } from "../writer.js";
import type { MermaidC4Argument } from "../model.js";
import type { MermaidC4Model } from "../model.js";
import { cloneC4Model, c4CommandResult, c4NoChange } from "./model.js";
import { C4WriteError, type C4Patch } from "../patches.js";
import {
  c4CallPatch,
  insertC4Record,
  type C4InsertTarget,
} from "../record-writer.js";
import { c4PairArguments } from "../identity-arguments.js";
import { mermaidMessages as m } from "../../../i18n.js";

export function renameMermaidC4Relationship(
  model: MermaidC4Model,
  relationshipId: string,
  label: string,
) {
  const next = cloneC4Model(model);
  const relationship = next.relationships.find(
    (candidate) => candidate.id === relationshipId,
  );
  if (relationship) relationship.label = label.trim();
  return next;
}

export function addMermaidC4Relationship(
  model: MermaidC4Model,
  from: string,
  to: string,
  { kind = "Rel", label = "uses", technology = "" } = {},
) {
  const next = cloneC4Model(model);
  if (
    !next.elements.some((element) => element.id === from) ||
    !next.elements.some((element) => element.id === to)
  ) {
    return next;
  }
  const order = next.relationships.length;
  next.relationships.push({
    callArguments: [],
    description: "",
    from,
    id: `relationship-${from}-${to}-${order + 1}`,
    index: null,
    kind,
    label: label.trim() || "uses",
    link: "",
    order,
    sprite: "",
    tags: "",
    technology: technology.trim(),
    to,
  });
  return next;
}

/** A local record edit never folds the other declarations of its directed pair. */
export function editC4RelationshipRecord(
  model: MermaidC4Model,
  sourceKey: string,
  kind: MermaidC4RelationshipKind,
  arguments_: readonly MermaidC4Argument[],
) {
  const record = model.sourceDocument.records.find(
    (r) => r.sourceKey === sourceKey && r.kind === "relationship",
  );
  if (
    !record ||
    C4_CALLS[kind]?.category !== "relationship" ||
    c4RequiredArgumentIssues(kind, arguments_).length
  )
    return null;
  if (
    kind === record.callKind &&
    JSON.stringify(arguments_) === JSON.stringify(record.arguments)
  )
    return { source: model.sourceDocument.source, model };
  return writeC4Patches(model, [
    c4CallPatch(model, sourceKey, kind, arguments_),
  ]);
}
export function deleteC4RelationshipRecord(
  model: MermaidC4Model,
  sourceKey: string,
) {
  const record = model.sourceDocument.records.find(
    (r) => r.sourceKey === sourceKey && r.kind === "relationship",
  );
  return record
    ? writeC4Patches(model, [
        {
          start: record.range.start,
          end: record.range.end + record.eol.length,
          text: "",
        },
      ])
    : null;
}

export type C4RelationshipCreate = Readonly<{
  from: string;
  to: string;
  kind: MermaidC4RelationshipKind;
  label: string;
  target: C4InsertTarget;
  selectSource?: boolean;
}>;
function validEndpoints(model: MermaidC4Model, from: string, to: string) {
  return [from, to].every((alias) =>
    model.elements.some((e) => e.alias === alias),
  );
}
/** Native Shape endpoints are final element aliases. Boundaries never qualify by geometry. */
export function createC4Relationship(
  model: MermaidC4Model,
  value: C4RelationshipCreate,
) {
  if (
    !isC4RelationshipKind(value.kind) ||
    !validEndpoints(model, value.from, value.to)
  )
    return c4NoChange(model, m.visualConnectionInvalidTarget());
  const existing = model.relationships.find(
    (r) => r.from === value.from && r.to === value.to,
  );
  // Default create selects the existing directed pair; it never inserts a shadowed duplicate.
  if (existing)
    return c4CommandResult(
      model,
      { source: model.sourceDocument.source, model },
      existing.resolution!.selectionId,
    );
  const args = [value.from, value.to, value.label].map((value) => ({
    key: "",
    value,
  }));
  if (value.kind === "RelIndex") args.unshift({ key: "", value: "0" });
  try {
    const next = insertC4Record(
      model,
      value.target,
      `  ${c4CallSource(value.kind, args)}`,
    );
    const relation = next.model.relationships.find(
      (r) => r.from === value.from && r.to === value.to,
    );
    if (!relation) return c4NoChange(model, m.classPatchRejected());
    return c4CommandResult(
      model,
      next,
      value.selectSource
        ? model.elements.find((e) => e.alias === value.from)!.resolution!
            .selectionId
        : relation.resolution!.selectionId,
    );
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}
export type C4ReconnectDraft = Readonly<{
  basis: string;
  selectionId: string;
  from: string;
  to: string;
  impact: readonly {
    sourceKey: string;
    call: string;
    line: number;
    fields: readonly string[];
  }[];
}>;
export type C4ReconnectPreparation = {
  draft?: C4ReconnectDraft;
  model?: MermaidC4Model;
  collision?: string;
  diagnostic?: string;
};
function reconnectPatches(
  model: MermaidC4Model,
  selectionId: string,
  from: string,
  to: string,
) {
  const owner = model.relationships.find(
    (r) => r.resolution!.selectionId === selectionId,
  )!;
  const patches: C4Patch[] = [];
  const impact: C4ReconnectDraft["impact"][number][] = [];
  for (const record of model.sourceDocument.records) {
    const refs = c4PairArguments(model, record, selectionId);
    if (!refs.length) continue;
    const args = record.arguments!.map((a) => ({ ...a }));
    const fields: string[] = [];
    for (const { index, field } of refs) {
      const value = field === "from" ? from : to;
      // An unchanged final end retains earlier raw endpoints and native mutations.
      if (owner[field] === value || args[index].value === value) continue;
      args[index].value = value;
      fields.push(field);
    }
    if (!fields.length) continue;
    patches.push(c4CallPatch(model, record.sourceKey, record.callKind!, args));
    impact.push({
      sourceKey: record.sourceKey,
      call: record.callKind!,
      line: record.range.line,
      fields,
    });
  }
  return { patches, impact };
}
/** Both endpoints and the complete applied style-pair impact are checked before a single commit. */
export function prepareC4Reconnect(
  model: MermaidC4Model,
  selectionId: string,
  from: string,
  to: string,
): C4ReconnectPreparation {
  const owner = model.relationships.find(
    (r) => r.resolution!.selectionId === selectionId,
  );
  if (!owner || !validEndpoints(model, from, to))
    return { diagnostic: m.visualConnectionInvalidTarget() };
  const collision = model.relationships.find(
    (r) =>
      r.resolution!.selectionId !== selectionId &&
      r.from === from &&
      r.to === to,
  );
  if (collision)
    return {
      collision: collision.resolution!.selectionId,
      diagnostic: m.classPatchRejected(),
    };
  if (owner.from === from && owner.to === to)
    return {
      draft: {
        basis: model.sourceDocument.source,
        selectionId,
        from,
        to,
        impact: [],
      },
      model,
    };
  try {
    const change = reconnectPatches(model, selectionId, from, to);
    const next = writeC4Patches(model, change.patches);
    const after = next.model.relationships.find(
      (r) => r.from === from && r.to === to,
    );
    if (!after || after.resolution!.selectionId !== selectionId)
      return { diagnostic: m.classPatchRejected() };
    return {
      draft: {
        basis: model.sourceDocument.source,
        selectionId,
        from,
        to,
        impact: change.impact,
      },
      model: next.model,
    };
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return { diagnostic: m.classPatchRejected() };
  }
}
export function reconnectC4Relationship(
  model: MermaidC4Model,
  draft: C4ReconnectDraft,
  confirmed: boolean,
) {
  if (!confirmed) return c4NoChange(model);
  if (draft.basis !== model.sourceDocument.source)
    return c4NoChange(model, m.chartSourceChanged());
  const checked = prepareC4Reconnect(
    model,
    draft.selectionId,
    draft.from,
    draft.to,
  );
  if (!checked.draft || !checked.model)
    return c4NoChange(model, checked.diagnostic ?? m.classPatchRejected());
  return c4CommandResult(
    model,
    { source: checked.model.sourceDocument.source, model: checked.model },
    draft.selectionId,
  );
}

export type C4NotationDraft = Readonly<{
  basis: string;
  recordKey: string;
  kind: MermaidC4RelationshipKind;
  removedIndex?: string;
}>;
export function prepareC4RelationshipNotation(
  model: MermaidC4Model,
  recordKey: string,
  kind: MermaidC4RelationshipKind,
) {
  const record = model.sourceDocument.records.find(
    (r) => r.sourceKey === recordKey && r.kind === "relationship",
  );
  if (!record || !isC4RelationshipKind(kind))
    return { diagnostic: m.classPatchRejected() };
  const draft: C4NotationDraft = {
    basis: model.sourceDocument.source,
    recordKey,
    kind,
    ...(record.callKind === "RelIndex" && kind !== "RelIndex"
      ? { removedIndex: record.arguments![0].value }
      : {}),
  };
  const args = record.arguments!.map((a) => ({ ...a }));
  if (record.callKind === "RelIndex" && kind !== "RelIndex") args.shift();
  if (record.callKind !== "RelIndex" && kind === "RelIndex")
    args.unshift({ key: "", value: "0" });
  try {
    const next = editC4RelationshipRecord(model, recordKey, kind, args);
    return next
      ? { draft, model: next.model }
      : { diagnostic: m.classPatchRejected() };
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return { diagnostic: m.classPatchRejected() };
  }
}
/** RelIndex is a preserved Source slot, not a native Dynamic numbering override. */
export function changeC4RelationshipNotation(
  model: MermaidC4Model,
  draft: C4NotationDraft,
  confirmedLoss: boolean,
) {
  if (draft.basis !== model.sourceDocument.source)
    return c4NoChange(model, m.chartSourceChanged());
  const checked = prepareC4RelationshipNotation(
    model,
    draft.recordKey,
    draft.kind,
  );
  if (!checked.model || !checked.draft)
    return c4NoChange(model, checked.diagnostic ?? m.classPatchRejected());
  if (checked.draft.removedIndex !== undefined && !confirmedLoss)
    return c4NoChange(model);
  const owner = checked.model.occurrences.find(
    (o) => o.sourceKey === draft.recordKey,
  );
  return c4CommandResult(
    model,
    { source: checked.model.sourceDocument.source, model: checked.model },
    owner?.selectionId,
  );
}
/** Single-record removal deliberately leaves other declarations and explicit style records intact. */
export function removeC4RelationshipRecord(
  model: MermaidC4Model,
  recordKey: string,
  confirmed: boolean,
) {
  if (!confirmed) return c4NoChange(model);
  try {
    const owner = model.occurrences.find(
      (o) => o.sourceKey === recordKey,
    )?.selectionId;
    const next = deleteC4RelationshipRecord(model, recordKey);
    const retained = next?.model.relationships.find(
      (r) => r.resolution!.selectionId === owner,
    );
    return next
      ? c4CommandResult(model, next, retained?.resolution!.selectionId)
      : c4NoChange(model, m.classPatchRejected());
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}
