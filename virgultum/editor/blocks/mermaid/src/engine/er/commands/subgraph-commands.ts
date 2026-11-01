// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  ErDirection,
  MermaidErModel,
  MermaidErSubgraph,
} from "../model.js";
import type { ErSourceRecord } from "../source-document.js";
import { nextErSourceKey } from "../source-document.js";
import {
  sourceMermaidErEntityName,
  erNoChange,
  erRecord,
  erRecordEnd,
  erRecordGroup,
  erNewRecordPatch,
  erMoveRecords,
  writeErPatches,
  composeErCommandResults,
  type ErCommandResult,
  type ErPatch,
  type ErWriteOptions,
} from "../writer.js";
import {
  validErId,
  erQuotedField,
  erEntityDeclarations,
  deleteErSelection,
} from "./entity-commands.js";
import { mermaidMessages as m } from "../../../i18n.js";
export function erSubgraph(model: MermaidErModel, key: string) {
  return model.subgraphs.find((g) => g.sourceKey === key || g.id === key);
}
export function erSubgraphRecord(model: MermaidErModel, key: string) {
  const group = erSubgraph(model, key);
  return group ? erRecord(model, group.sourceKey) : undefined;
}
function subtree(model: MermaidErModel, id: string): MermaidErSubgraph[] {
  return model.subgraphs.filter(
    (g) => g.id === id || ancestor(model, g.parentId, id),
  );
}
function ancestor(model: MermaidErModel, parent: string | null, id: string) {
  const visited = new Set<string>();
  while (parent && !visited.has(parent)) {
    if (parent === id) return true;
    visited.add(parent);
    parent = model.subgraphs.find((g) => g.id === parent)?.parentId ?? null;
  }
  return false;
}
function subgraphUnit(model: MermaidErModel, record: ErSourceRecord) {
  const group = erRecordGroup(model, record.sourceKey)!,
    close = record.closeKey ? erRecord(model, record.closeKey) : undefined,
    end = erRecordEnd(close ?? record);
  return model.sourceDocument.records.filter(
    (r) => r.range.start >= group.range.start && r.range.start < end,
  );
}
export function addErSubgraph(
  model: MermaidErModel,
  value: {
    id: string;
    label?: string;
    parentId?: string | null;
    direction?: ErDirection;
  },
  options: ErWriteOptions = {},
) {
  if (
    !validErId(value.id) ||
    [...model.entities, ...model.subgraphs].some((n) => n.id === value.id)
  )
    return erNoChange(model, "invalid", m.erIdCollision());
  const parent = value.parentId
      ? erSubgraphRecord(model, value.parentId)
      : undefined,
    close = parent?.closeKey ? erRecord(model, parent.closeKey) : undefined;
  if (value.parentId && !close)
    return erNoChange(model, "invalid", m.erMissingObject());
  const key = nextErSourceKey(),
    indent = parent ? parent.indent + "  " : "",
    nl = model.sourceDocument.newline;
  const text = `${indent}subgraph ${sourceMermaidErEntityName(value.id)}${value.label !== undefined ? ` [${sourceMermaidErEntityName(value.label)}]` : ""}${nl}${value.direction ? `${indent}  direction ${value.direction}${nl}` : ""}${indent}end`;
  return writeErPatches(
    model,
    [
      erNewRecordPatch(
        model,
        close?.range.start ?? model.sourceDocument.source.length,
        text,
        key,
      ),
    ],
    { ...options, selection: key, focus: key },
  );
}
export function editErSubgraph(
  model: MermaidErModel,
  key: string,
  value: { id?: string; label?: string; direction?: ErDirection | null },
  options: ErWriteOptions = {},
) {
  const group = erSubgraph(model, key),
    record = erSubgraphRecord(model, key);
  if (!group || !record)
    return erNoChange(model, "invalid", m.erMissingObject());
  const patches: ErPatch[] = [],
    removed = new Set<string>();
  let subgraphKeys = options.subgraphKeys;
  if (value.id !== undefined && value.id !== group.id) {
    if (
      !validErId(value.id) ||
      [...model.entities, ...model.subgraphs].some((n) => n.id === value.id)
    )
      return erNoChange(model, "invalid", m.erIdCollision());
    for (const r of model.sourceDocument.records)
      for (const ref of r.references)
        if (ref.kind === "subgraph" && ref.id === group.id)
          patches.push({
            range: ref.range,
            value: erQuotedField(
              model.sourceDocument.source,
              ref.range,
              value.id,
            ),
          });
    subgraphKeys = new Map([[value.id, group.sourceKey]]);
  }
  if (value.label !== undefined && value.label !== group.label) {
    if (/[\r\n]/.test(value.label))
      return erNoChange(model, "invalid", m.erPatchRejected());
    if (record.values.label)
      patches.push({
        range: record.values.label,
        value: erQuotedField(
          model.sourceDocument.source,
          record.values.label,
          value.label,
        ),
      });
    else {
      const end = record.values.id!.end;
      patches.push({
        range: { start: end, end },
        value: ` [${sourceMermaidErEntityName(value.label)}]`,
      });
    }
  }
  if (
    Object.hasOwn(value, "direction") &&
    value.direction !== group.direction
  ) {
    const directions = model.sourceDocument.records.filter(
      (r) => r.kind === "direction" && r.subgraphId === group.id,
    );
    if (value.direction) {
      const existing = directions.at(-1);
      patches.push(
        existing
          ? { range: existing.values.direction!, value: value.direction }
          : erNewRecordPatch(
              model,
              erRecordEnd(record),
              `${record.indent}  direction ${value.direction}`,
            ),
      );
    } else
      for (const r of directions) {
        removed.add(r.sourceKey);
        patches.push({
          range: { start: r.range.start, end: erRecordEnd(r) },
          value: "",
        });
      }
  }
  return writeErPatches(model, patches, {
    ...options,
    removed,
    subgraphKeys,
    selection: group.sourceKey,
    focus: group.sourceKey,
  });
}
/** ER IDs are global. Reparent moves lexical units, never rewrites endpoints or
 * infers source containment from the user's canvas coordinates. */
export function reparentErSubgraph(
  model: MermaidErModel,
  key: string,
  parentId: string | null,
  options: ErWriteOptions = {},
) {
  const group = erSubgraph(model, key),
    record = erSubgraphRecord(model, key),
    parent = parentId ? erSubgraphRecord(model, parentId) : undefined,
    close = parent?.closeKey ? erRecord(model, parent.closeKey) : undefined;
  if (
    !group ||
    !record ||
    (parentId && !close) ||
    parentId === group.id ||
    ancestor(model, parentId, group.id)
  )
    return erNoChange(model, "invalid", m.erInvalidMembership());
  if (parentId === group.parentId) return erNoChange(model);
  return writeErPatches(
    model,
    erMoveRecords(
      model,
      subgraphUnit(model, record),
      close?.range.start ?? model.sourceDocument.source.length,
    ),
    { ...options, selection: group.sourceKey, focus: group.sourceKey },
  );
}
function entityUnits(model: MermaidErModel, key: string) {
  const entity = model.entities.find((e) => e.sourceKey === key);
  if (!entity) return null;
  const declarations = erEntityDeclarations(model, entity.id);
  // Moving only a subset of repeated cross-scope declarations would lie about
  // makeUniq membership. The caller reports this local ambiguity in the draft.
  if (
    !declarations.length ||
    declarations.some((r) => r.subgraphId !== entity.scopeId) ||
    entity.scopeId !== entity.subgraphId
  )
    return null;
  return declarations.map((open) => {
    const lexical = erRecordGroup(model, open.sourceKey)!,
      close = open.closeKey ? erRecord(model, open.closeKey) : undefined,
      end = erRecordEnd(close ?? open);
    return model.sourceDocument.records.filter(
      (r) => r.range.start >= lexical.range.start && r.range.start < end,
    );
  });
}
export function erGroupAllowed(model: MermaidErModel, keys: readonly string[]) {
  if (keys.length < 2 || new Set(keys).size !== keys.length) return false;
  const entities = keys.map((key) =>
    model.entities.find((e) => e.sourceKey === key),
  );
  return entities.every(
    (e) =>
      e &&
      e.scopeId === entities[0]!.scopeId &&
      entityUnits(model, e.sourceKey),
  );
}
function transferEntities(
  model: MermaidErModel,
  keys: readonly string[],
  parentId: string | null,
  newGroup: { id: string; label?: string; direction?: ErDirection } | undefined,
  options: ErWriteOptions,
) {
  const units = keys.flatMap((key) => entityUnits(model, key) ?? []);
  if (units.length < keys.length)
    return erNoChange(model, "invalid", m.erInvalidMembership());
  const parent = parentId ? erSubgraphRecord(model, parentId) : undefined,
    close = parent?.closeKey ? erRecord(model, parent.closeKey) : undefined;
  if (parentId && !close)
    return erNoChange(model, "invalid", m.erMissingObject());
  if (
    newGroup &&
    (!validErId(newGroup.id) ||
      [...model.entities, ...model.subgraphs].some((n) => n.id === newGroup.id))
  )
    return erNoChange(model, "invalid", m.erIdCollision());
  const key = nextErSourceKey(),
    nl = model.sourceDocument.newline,
    indent = parent ? parent.indent + "  " : "",
    identities: [number, string][] = newGroup ? [[0, key]] : [],
    patches: ErPatch[] = [];
  let text = newGroup
    ? `${indent}subgraph ${sourceMermaidErEntityName(newGroup.id)}${newGroup.label !== undefined ? ` [${sourceMermaidErEntityName(newGroup.label)}]` : ""}${nl}`
    : "";
  if (newGroup?.direction)
    text += `${indent}  direction ${newGroup.direction}${nl}`;
  for (const records of units) {
    const start = records[0]!.range.start,
      end = erRecordEnd(records.at(-1)!);
    for (const r of records)
      identities.push([text.length + r.range.start - start, r.sourceKey]);
    text += model.sourceDocument.source.slice(start, end);
    if (!/[\r\n]$/.test(text)) text += nl;
    patches.push({ range: { start, end }, value: "" });
  }
  if (newGroup) text += `${indent}end`;
  const insertion = erNewRecordPatch(
      model,
      close?.range.start ?? model.sourceDocument.source.length,
      text,
    ),
    prefix = insertion.value.indexOf(text);
  insertion.identities = identities.map(([offset, id]) => [
    prefix + offset,
    id,
  ]);
  patches.push(insertion);
  return writeErPatches(model, patches, {
    ...options,
    selection: newGroup ? key : keys[0],
    focus: newGroup ? key : keys[0],
  });
}
export function groupErEntities(
  model: MermaidErModel,
  keys: readonly string[],
  value: { id: string; label?: string; direction?: ErDirection },
  options: ErWriteOptions = {},
) {
  if (!erGroupAllowed(model, keys))
    return erNoChange(model, "invalid", m.erInvalidMembership());
  return transferEntities(
    model,
    keys,
    model.entities.find((e) => e.sourceKey === keys[0])!.scopeId,
    value,
    options,
  );
}
export function reparentErEntity(
  model: MermaidErModel,
  key: string,
  parentId: string | null,
  options: ErWriteOptions = {},
) {
  return transferEntities(model, [key], parentId, undefined, options);
}
export function deleteErSubgraph(
  model: MermaidErModel,
  key: string,
  strategy: "ungroup" | "delete",
  options: ErWriteOptions = {},
): ErCommandResult {
  const group = erSubgraph(model, key),
    record = erSubgraphRecord(model, key);
  if (!group || !record || !record.closeKey)
    return erNoChange(model, "invalid", m.erMissingObject());
  if (strategy === "ungroup") {
    const close = erRecord(model, record.closeKey)!,
      directions = model.sourceDocument.records.filter(
        (r) => r.kind === "direction" && r.subgraphId === group.id,
      ),
      uses = groupUsePatches(
        model,
        new Set([group.id]),
        record.range.start,
        record.range.start,
      ),
      remove = [record, close, ...directions, ...uses.removed],
      comments = model.commentRecords.filter(
        (c) => c.anchorKind === "subgraph" && c.anchorId === group.sourceKey,
      );
    const result = writeErPatches(
      model,
      [
        ...remove
          .filter((r) => !uses.removed.includes(r))
          .map((r) => ({
            range: { start: r.range.start, end: erRecordEnd(r) },
            value: "",
          })),
        ...uses.patches,
      ],
      {
        ...options,
        removed: new Set(remove.map((r) => r.sourceKey)),
        commentTransfers: new Set(comments.map((c) => c.id)),
        impact: {
          records: [
            ...remove,
            ...comments.flatMap((c) => erRecord(model, c.id) ?? []),
          ].map((r) => ({
            id: r.sourceKey,
            kind: r.kind,
            label: r.raw.trim(),
          })),
        },
      },
    );
    return result;
  }
  const groups = subtree(model, group.id),
    ids = new Set(groups.map((g) => g.id)),
    entities = model.entities.filter(
      (e) => e.subgraphId && ids.has(e.subgraphId),
    ),
    deleted = deleteErSelection(
      model,
      entities.map((e) => e.sourceKey),
    );
  if (deleted.status === "rejected") return deleted;
  const remaining = erSubgraphRecord(deleted.model, group.sourceKey)!;
  const unit = subgraphUnit(deleted.model, remaining),
    start = unit[0]!.range.start,
    end = erRecordEnd(unit.at(-1)!),
    removed = new Set(unit.map((r) => r.sourceKey));
  // Only the deleted owners disappear from a shared style use.
  const uses = groupUsePatches(deleted.model, ids, start, end);
  const external = uses.impacted;
  for (const r of uses.removed) removed.add(r.sourceKey);
  const result = writeErPatches(
    deleted.model,
    [{ range: { start, end }, value: "" }, ...uses.patches],
    {
      removed,
      impact: {
        records: [
          ...deleted.impact.records,
          ...unit.map((r) => ({
            id: r.sourceKey,
            kind: r.kind,
            label: r.raw.trim(),
          })),
          ...external.map((r) => ({
            id: r.sourceKey,
            kind: r.kind,
            label: r.raw.trim(),
          })),
        ],
      },
    },
  );
  return composeErCommandResults(model, result, options);
}

function groupUsePatches(
  model: MermaidErModel,
  ids: ReadonlySet<string>,
  start: number,
  end: number,
) {
  const impacted = model.sourceDocument.records.filter(
    (r) =>
      r.kind !== "subgraph" &&
      r.references.some((ref) => ref.kind === "subgraph" && ids.has(ref.id)) &&
      !(r.range.start >= start && r.range.start < end),
  );
  const removed: ErSourceRecord[] = [],
    patches: ErPatch[] = [];
  for (const record of impacted) {
    const targets = record.references.filter(
      (ref) => ref.kind === "entity" || ref.kind === "subgraph",
    );
    const remaining = targets.filter(
      (ref) => ref.kind !== "subgraph" || !ids.has(ref.id),
    );
    if (
      ["style", "style-assignment"].includes(record.kind) &&
      remaining.length
    ) {
      if (!record.values.owners) continue;
      patches.push({
        range: record.values.owners,
        value: remaining
          .map((ref) =>
            model.sourceDocument.source.slice(ref.range.start, ref.range.end),
          )
          .join(","),
      });
    } else {
      removed.push(record);
      patches.push({
        range: { start: record.range.start, end: erRecordEnd(record) },
        value: "",
      });
      for (const comment of model.commentRecords.filter(
        (c) => c.anchorId === record.sourceKey,
      )) {
        const owned = erRecord(model, comment.id);
        if (!owned) continue;
        removed.push(owned);
        patches.push({
          range: { start: owned.range.start, end: erRecordEnd(owned) },
          value: "",
        });
      }
    }
  }
  return {
    impacted: [...impacted, ...removed.filter((r) => !impacted.includes(r))],
    removed,
    patches,
  };
}
