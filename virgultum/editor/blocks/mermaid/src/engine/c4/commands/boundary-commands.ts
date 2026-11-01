// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidC4Model,
  MermaidC4Argument,
  C4FieldProvider,
} from "../model.js";
import { c4RecordUnit, c4RecordEnd } from "../source-unit.js";
import { C4WriteError, writeC4Patches, type C4Patch } from "../patches.js";
import {
  c4CallPatch,
  insertC4Record,
  insertC4StyleUpdate,
  type C4InsertTarget,
} from "../record-writer.js";
import {
  C4_CALLS,
  c4CallSource,
  isC4BoundaryKind,
  type MermaidC4BoundaryKind,
} from "../runtime-contract.js";
import { c4ResolvedText } from "../resolve.js";
import { nextC4ElementAlias } from "./element-commands.js";
import { isC4Alias } from "./alias-commands.js";
import { c4CommandResult, c4NoChange } from "./model.js";
import { mermaidMessages as m } from "../../../i18n.js";
import { c4ModelImpact, type C4MoveImpact } from "./model-impact.js";
export type { C4MoveImpact } from "./model-impact.js";

export type C4BoundaryCreate = {
  kind: MermaidC4BoundaryKind;
  label: string;
  alias?: string;
  target: C4InsertTarget;
};
/** Empty lexical boundaries are real native objects; creation never invents children. */
export function createC4Boundary(
  model: MermaidC4Model,
  value: C4BoundaryCreate,
) {
  const alias = value.alias ?? nextC4ElementAlias(model, value.kind);
  if (
    !isC4BoundaryKind(value.kind) ||
    !isC4Alias(alias) ||
    [...model.elements, ...model.boundaries].some((e) => e.alias === alias)
  )
    return c4NoChange(model, m.classPatchRejected());
  const parent = model.sourceDocument.records.find(
    (r) => r.sourceKey === value.target.parentKey,
  );
  const indent = parent ? parent.indent + "  " : "  ";
  try {
    const next = insertC4Record(
      model,
      value.target,
      `${indent}${c4CallSource(value.kind, [
        { key: "", value: alias },
        { key: "", value: value.label },
      ])} {${model.sourceDocument.newline}${indent}}`,
    );
    return c4CommandResult(
      model,
      next,
      next.model.boundaries.find((b) => b.alias === alias)!.resolution!
        .selectionId,
    );
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}

export type C4BoundaryFields = Partial<
  Record<"label" | "type" | "descr" | "tags" | "link", string>
>;
/** The local header exposes the selected call's real slots, not injected/ignored fields. */
export function readC4BoundaryFields(
  model: MermaidC4Model,
  selectionId: string,
): C4BoundaryFields {
  const boundary = model.boundaries.find(
    (b) => b.resolution?.selectionId === selectionId,
  );
  if (!boundary?.resolution) return {};
  const contract = C4_CALLS[boundary.kind];
  return Object.fromEntries(
    contract.slots
      .filter((field) =>
        ["label", "type", "descr", "tags", "link"].includes(field),
      )
      .map((field) => [field, c4ResolvedText(boundary.resolution!, field)]),
  );
}
export function editC4BoundaryFields(
  model: MermaidC4Model,
  selectionId: string,
  fields: Readonly<C4BoundaryFields>,
) {
  const boundary = model.boundaries.find(
    (b) => b.resolution?.selectionId === selectionId,
  );
  if (!boundary?.resolution) return c4NoChange(model, m.classPatchRejected());
  const allowed = readC4BoundaryFields(model, selectionId),
    calls = new Map<
      string,
      {
        kind: string;
        args: MermaidC4Argument[];
      }
    >(),
    inserted: { key: string; value: string }[] = [];
  if (
    Object.entries(fields).some(
      ([field, value]) =>
        !Object.hasOwn(allowed, field) || typeof value !== "string",
    )
  )
    return c4NoChange(model, m.classPatchRejected());
  for (const [field, value] of Object.entries(fields)) {
    if (value === allowed[field as keyof C4BoundaryFields]) continue;
    const provider: C4FieldProvider | undefined =
      boundary.resolution.providers[field];
    if (provider?.argumentIndex === undefined || provider.form === "omitted") {
      inserted.push({ key: field, value });
      continue;
    }
    const key = provider.sourceKey;
    const record = model.sourceDocument.records.find(
      (r) => r.sourceKey === key,
    )!;
    const call = calls.get(key) ?? {
      kind: record.callKind!,
      args: record.arguments!.map((a) => ({ ...a })),
    };
    const index = provider.argumentIndex;
    call.args[index] = { ...call.args[index], value };
    calls.set(key, call);
  }
  try {
    let next = writeC4Patches(
      model,
      [...calls].map(([key, call]) =>
        c4CallPatch(model, key, call.kind, call.args),
      ),
    );
    if (inserted.length)
      next = insertC4StyleUpdate(next.model, "UpdateElementStyle", [
        { key: "", value: boundary.alias },
        ...inserted,
      ]);
    return c4CommandResult(model, next, selectionId);
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}

export type C4RecordMoveTarget = Readonly<{
  parentKey: string | null;
  beforeKey?: string;
}>;
export type C4RecordMoveDraft = Readonly<{
  basis: string;
  recordKey: string;
  target: C4RecordMoveTarget;
  intent?: "reparent" | "reorder";
  previousScope: readonly string[];
  previousPosition: number;
  previousLine: number;
  targetScope: readonly string[];
  targetPosition: number;
  targetLine: number;
  movedKeys: readonly string[];
  reflowScopes: readonly (string | null)[];
  impact: readonly C4MoveImpact[];
  objectNames: Readonly<Record<string, string>>;
}>;

function recordMove(
  model: MermaidC4Model,
  recordKey: string,
  target: C4RecordMoveTarget,
  intent?: C4RecordMoveDraft["intent"],
) {
  const records = model.sourceDocument.records;
  const record = records.find((r) => r.sourceKey === recordKey);
  if (
    !record ||
    (record.kind !== "element" &&
      record.kind !== "boundary-open" &&
      record.kind !== "relationship")
  )
    return null;
  const previousParent = record.scopeKeys.at(-1) ?? null;
  if (intent === "reorder" && target.parentKey !== previousParent) return null;
  const parent = target.parentKey
    ? records.find((r) => r.sourceKey === target.parentKey)
    : undefined;
  if (
    target.parentKey &&
    (!parent || parent.kind !== "boundary-open" || !parent.closeKey)
  )
    return null;
  const before = records.find(
    (r) => r.sourceKey === (target.beforeKey ?? parent?.closeKey),
  );
  if ((target.beforeKey || parent) && !before) return null;
  if (before && (before.scopeKeys.at(-1) ?? null) !== target.parentKey)
    return null;
  if (
    before &&
    (before.kind === "header" ||
      before.kind === "frontmatter" ||
      before.kind === "directive")
  )
    return null;
  const unit = c4RecordUnit(model, record);
  if (!unit?.length) return null;
  const start = unit[0].range.start,
    end = c4RecordEnd(unit.at(-1)!);
  if (parent && parent.range.start >= start && parent.range.start < end)
    return null;
  const offset = before
    ? (c4RecordUnit(model, before)?.[0]?.range.start ?? before.range.start)
    : model.sourceDocument.source.length;
  if (offset >= start && offset <= end) {
    if ((record.scopeKeys.at(-1) ?? null) !== target.parentKey) return null;
    return { model, source: model.sourceDocument.source, unit, offset, parent };
  }
  if (intent === "reparent" && target.parentKey === previousParent) return null;
  let text = model.sourceDocument.source.slice(start, end);
  const prefix =
    offset > 0 && !/[\r\n]$/.test(model.sourceDocument.source.slice(0, offset))
      ? model.sourceDocument.newline
      : "";
  if (offset < model.sourceDocument.source.length && !/[\r\n]$/.test(text))
    text += model.sourceDocument.newline;
  const patches: C4Patch[] = [
    { start, end, text: "" },
    {
      start: offset,
      end: offset,
      text: prefix + text,
      identities: unit.map(
        (r) => [prefix.length + r.range.start - start, r.sourceKey] as const,
      ),
    },
  ];
  try {
    return { ...writeC4Patches(model, patches), unit, offset, parent };
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    // A lexical move can create an effective parent cycle through repetitions.
    return null;
  }
}

/** Preparation only previews Source scope/order and real DB field impact.
 * Confirmation recomputes the move against the exact same Source basis. */
export function prepareC4RecordMove(
  model: MermaidC4Model,
  recordKey: string,
  target: C4RecordMoveTarget,
  intent?: C4RecordMoveDraft["intent"],
): C4RecordMoveDraft | null {
  const moved = recordMove(model, recordKey, target, intent);
  if (!moved) return null;
  const previous = model.sourceDocument.records.find(
    (r) => r.sourceKey === recordKey,
  )!;
  const next = moved.model.sourceDocument.records.find(
    (r) => r.sourceKey === recordKey,
  )!;
  const impact = c4ModelImpact(model, moved.model);
  const reflowScopes = new Set<string | null>();
  if (
    impact.some((i) => i.selectionId === "c4-layout" && i.before !== i.after)
  ) {
    reflowScopes.add(null);
    for (const boundary of moved.model.boundaries)
      reflowScopes.add(boundary.resolution!.selectionId);
  }
  const scopeOrders = [];
  // Global creation indices can change while a boundary's local order does not.
  // Compare real memberships/orders per stable scope, never every moved child.
  for (const sourceModel of [model, moved.model]) {
    const scopes = new Map<
      string | null,
      { elements: string[]; boundaries: string[] }
    >([[null, { elements: [], boundaries: [] }]]);
    for (const boundary of sourceModel.boundaries)
      scopes.set(boundary.resolution!.selectionId, {
        elements: [],
        boundaries: [],
      });
    for (const object of [
      ...sourceModel.elements,
      ...sourceModel.boundaries,
    ].sort((a, b) => a.order - b.order)) {
      const alias =
        "boundaryId" in object ? object.boundaryId : object.parentId;
      const parent = sourceModel.boundaries.find((b) => b.alias === alias);
      if (alias && !parent) return null;
      const scope = scopes.get(parent?.resolution!.selectionId ?? null)!;
      ("boundaryId" in object ? scope.elements : scope.boundaries).push(
        object.resolution!.selectionId,
      );
    }
    scopeOrders.push(scopes);
  }
  for (const scope of new Set([
    ...scopeOrders[0].keys(),
    ...scopeOrders[1].keys(),
  ]))
    if (
      JSON.stringify(scopeOrders[0].get(scope)) !==
      JSON.stringify(scopeOrders[1].get(scope))
    )
      reflowScopes.add(scope);
  return {
    basis: model.sourceDocument.source,
    recordKey,
    target: { ...target },
    intent,
    previousScope: [...previous.scopeAliases],
    previousPosition: previous.range.start,
    previousLine: previous.range.line,
    targetScope: [...next.scopeAliases],
    targetPosition: next.range.start,
    targetLine: next.range.line,
    movedKeys: moved.unit.map((r) => r.sourceKey),
    reflowScopes: [...reflowScopes],
    impact,
    objectNames: Object.fromEntries(
      [model, moved.model].flatMap((sourceModel) =>
        [
          ...sourceModel.elements,
          ...sourceModel.boundaries,
          ...sourceModel.relationships,
        ].map((object) => [
          object.resolution!.selectionId,
          "alias" in object ? object.alias : `${object.from} → ${object.to}`,
        ]),
      ),
    ),
  };
}
export function confirmC4RecordMove(
  model: MermaidC4Model,
  draft: C4RecordMoveDraft,
  confirmed: boolean,
) {
  const unchanged = (
    status: "cancelled" | "stale" | "invalid" | "unchanged",
  ) => ({ status, source: model.sourceDocument.source, model });
  if (!confirmed) return unchanged("cancelled");
  if (draft.basis !== model.sourceDocument.source) return unchanged("stale");
  const moved = recordMove(model, draft.recordKey, draft.target, draft.intent);
  if (!moved) return unchanged("invalid");
  if (moved.source === model.sourceDocument.source)
    return unchanged("unchanged");
  return {
    status: "changed" as const,
    source: moved.source,
    model: moved.model,
  };
}

/** The catalog adapter carries checked bindings and only the previewed packing intent. */
export function moveC4SourceRecord(
  model: MermaidC4Model,
  draft: C4RecordMoveDraft,
  confirmed: boolean,
) {
  if (!confirmed) return c4NoChange(model);
  if (draft.basis !== model.sourceDocument.source)
    return c4NoChange(model, m.chartSourceChanged());
  const checked = prepareC4RecordMove(
    model,
    draft.recordKey,
    draft.target,
    draft.intent,
  );
  if (!checked) return c4NoChange(model, m.classPatchRejected());
  const moved = confirmC4RecordMove(model, checked, true);
  if (moved.status === "invalid" || moved.status === "stale")
    return c4NoChange(model, m.classPatchRejected());
  const result = c4CommandResult(model, moved);
  return result.status === "changed"
    ? { ...result, reflowScopes: checked.reflowScopes }
    : result;
}
