// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidErModel } from "../model.js";

import { nextErSourceKey } from "../source-document.js";
import {
  sourceMermaidErEntityName,
  writeErPatches,
  erNoChange,
  erRecord,
  erRecordEnd,
  erNewRecordPatch,
  composeErCommandResults,
  type ErCommandResult,
  type ErPatch,
  type ErWriteOptions,
  type ErImpact,
} from "../writer.js";
import { deleteErSubgraph } from "./subgraph-commands.js";
import { mermaidMessages as m } from "../../../i18n.js";
export function validErId(id: string) {
  return Boolean(id.trim()) && !/["\r\n]/.test(id);
}
export function erQuotedField(
  source: string,
  range: { start: number; end: number },
  value: string,
  encode = sourceMermaidErEntityName,
) {
  const previous = source.slice(range.start, range.end);
  return previous.startsWith('"')
    ? `"${value.replaceAll('"', "&quot;")}"`
    : previous.startsWith("`")
      ? `\`${value.replaceAll("`", "")}\``
      : encode(value);
}
export function erEntity(model: MermaidErModel, key: string) {
  return model.entities.find((n) => n.sourceKey === key || n.id === key);
}
export function erEntityDeclarations(model: MermaidErModel, id: string) {
  return model.sourceDocument.records.filter(
    (r) =>
      r.kind === "entity" &&
      r.references.some((ref) => ref.kind === "entity" && ref.id === id),
  );
}
export function addErEntity(
  model: MermaidErModel,
  value: { id: string; label?: string; subgraphId?: string | null },
  options: ErWriteOptions = {},
) {
  if (!validErId(value.id) || /[\r\n]/.test(value.label ?? ""))
    return erNoChange(model, "invalid", m.erPatchRejected());
  if ([...model.entities, ...model.subgraphs].some((n) => n.id === value.id))
    return erNoChange(model, "invalid", m.erIdCollision());
  const parent = value.subgraphId
    ? model.subgraphs.find((g) => g.id === value.subgraphId)
    : undefined;
  if (value.subgraphId && !parent)
    return erNoChange(model, "invalid", m.erMissingObject());
  const open = parent ? erRecord(model, parent.sourceKey) : undefined,
    close = open?.closeKey ? erRecord(model, open.closeKey) : undefined,
    key = nextErSourceKey();
  const text = `${open ? open.indent + "  " : ""}${sourceMermaidErEntityName(value.id)}${value.label !== undefined ? `["${value.label.replaceAll('"', "&quot;")}"]` : ""}`;
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
    {
      ...options,
      entityKeys: new Map([[value.id, key]]),
      selection: key,
      focus: key,
    },
  );
}
export function editErEntity(
  model: MermaidErModel,
  key: string,
  changes: { id?: string; label?: string },
  options: ErWriteOptions = {},
) {
  const entity = erEntity(model, key);
  if (!entity) return erNoChange(model, "invalid", m.erMissingObject());
  const patches: ErPatch[] = [],
    declarations = erEntityDeclarations(model, entity.id);
  let entityKeys = options.entityKeys;
  if (changes.id !== undefined && changes.id !== entity.id) {
    if (
      !validErId(changes.id) ||
      [...model.entities, ...model.subgraphs].some((n) => n.id === changes.id)
    )
      return erNoChange(model, "invalid", m.erIdCollision());
    for (const record of model.sourceDocument.records)
      for (const ref of record.references)
        if (ref.kind === "entity" && ref.id === entity.id)
          patches.push({
            range: ref.range,
            value: erQuotedField(
              model.sourceDocument.source,
              ref.range,
              changes.id,
            ),
          });
    entityKeys = new Map([[changes.id, entity.sourceKey]]);
  }
  if (changes.label !== undefined && changes.label !== entity.label) {
    if (/[\r\n]/.test(changes.label))
      return erNoChange(model, "invalid", m.erPatchRejected());
    const declaration =
        declarations.find((r) => r.values.label) ?? declarations[0],
      value = `"${changes.label.replaceAll('"', "&quot;")}"`;
    if (declaration?.values.label)
      patches.push({ range: declaration.values.label, value });
    else if (declaration?.values.id) {
      const end = declaration.values.id.end;
      patches.push({ range: { start: end, end }, value: `[${value}]` });
    } else
      patches.push(
        erNewRecordPatch(
          model,
          model.sourceDocument.source.length,
          `${sourceMermaidErEntityName(changes.id ?? entity.id)}[${value}]`,
          nextErSourceKey(),
        ),
      );
  }
  return writeErPatches(model, patches, {
    ...options,
    entityKeys,
    selection: entity.sourceKey,
    focus: entity.sourceKey,
  });
}
/** Delete is the exact union of selected semantic records and their owned impact.
 * Shared style definitions and unrelated targets survive. */
export function erDeleteImpact(
  model: MermaidErModel,
  keys: readonly string[],
): ErImpact {
  const selected = new Set(keys),
    entities = model.entities.filter((e) => selected.has(e.sourceKey)),
    ids = new Set(entities.map((e) => e.id));
  const records = new Map<
    string,
    { id: string; kind: string; label: string }
  >();
  for (const entity of entities) {
    records.set(entity.sourceKey, {
      id: entity.sourceKey,
      kind: "entity",
      label: entity.label,
    });
    for (const attr of entity.attributes)
      records.set(attr.id, {
        id: attr.id,
        kind: "attribute",
        label: attr.name,
      });
  }
  for (const attr of model.entities.flatMap((e) => e.attributes))
    if (selected.has(attr.id))
      records.set(attr.id, {
        id: attr.id,
        kind: "attribute",
        label: attr.name,
      });
  for (const relation of model.relationships)
    if (
      selected.has(relation.id) ||
      ids.has(relation.from) ||
      ids.has(relation.to)
    )
      records.set(relation.id, {
        id: relation.id,
        kind: "relation",
        label: relation.label,
      });
  for (const style of model.styles)
    if (style.kind !== "definition" && style.owners.some((id) => ids.has(id)))
      records.set(style.id, {
        id: style.id,
        kind: "style",
        label: style.owners.join(", "),
      });
  for (const comment of model.commentRecords)
    if (
      selected.has(comment.id) ||
      (comment.anchorId && records.has(comment.anchorId))
    )
      records.set(comment.id, {
        id: comment.id,
        kind: "comment",
        label: comment.text,
      });
  return { records: [...records.values()] };
}
export function deleteErSelection(
  model: MermaidErModel,
  keys: readonly string[],
  options: ErWriteOptions = {},
): ErCommandResult {
  const selectedGroups = model.subgraphs.filter((g) =>
    keys.includes(g.sourceKey),
  );
  if (selectedGroups.length) {
    let current = model;
    const cascade: ErImpact["records"][number][] = [];
    for (const group of selectedGroups) {
      if (!current.subgraphs.some((g) => g.sourceKey === group.sourceKey))
        continue;
      const result = deleteErSubgraph(current, group.sourceKey, "delete");
      if (result.status === "rejected")
        return erNoChange(model, "invalid", result.diagnostic);
      current = result.model;
      cascade.push(...result.impact.records);
    }
    const result = deleteErSelection(
      current,
      keys.filter((key) => !selectedGroups.some((g) => g.sourceKey === key)),
    );
    result.impact = {
      records: [
        ...new Map(
          [...cascade, ...result.impact.records].map((r) => [r.id, r]),
        ).values(),
      ],
    };
    return composeErCommandResults(model, result, options);
  }
  const impact = erDeleteImpact(model, keys),
    removed = new Set(
      impact.records.filter((r) => r.kind !== "style").map((r) => r.id),
    ),
    entityIds = new Set(
      model.entities.filter((e) => keys.includes(e.sourceKey)).map((e) => e.id),
    ),
    patches: ErPatch[] = [];
  for (const record of model.sourceDocument.records) {
    if (
      record.kind === "entity" &&
      record.references.some(
        (ref) => ref.kind === "entity" && entityIds.has(ref.id),
      )
    ) {
      const close = record.closeKey
        ? erRecord(model, record.closeKey)
        : undefined;
      const end = close ? erRecordEnd(close) : erRecordEnd(record);
      for (const child of model.sourceDocument.records)
        if (child.range.start >= record.range.start && child.range.start < end)
          removed.add(child.sourceKey);
      patches.push({ range: { start: record.range.start, end }, value: "" });
      continue;
    }
    if (
      removed.has(record.sourceKey) &&
      !patches.some(
        (p) =>
          record.range.start >= p.range.start &&
          record.range.start < p.range.end,
      )
    ) {
      patches.push({
        range: { start: record.range.start, end: erRecordEnd(record) },
        value: "",
      });
      continue;
    }
    if (record.kind !== "style" && record.kind !== "style-assignment") continue;
    const targets = record.references.filter((ref) => ref.kind === "entity"),
      remaining = targets.filter((ref) => !entityIds.has(ref.id));
    if (targets.length === remaining.length) continue;
    if (!remaining.length) {
      removed.add(record.sourceKey);
      patches.push({
        range: { start: record.range.start, end: erRecordEnd(record) },
        value: "",
      });
    } else
      patches.push({
        range: record.values.owners!,
        value: remaining
          .map((ref) =>
            model.sourceDocument.source.slice(ref.range.start, ref.range.end),
          )
          .join(","),
      });
  }
  return writeErPatches(model, patches, { ...options, removed, impact });
}
