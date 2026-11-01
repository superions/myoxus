// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidErModel } from "./model.js";
import {
  ATTRIBUTE_WORD_RE,
  GENERIC_ATTRIBUTE_WORD_RE,
  isMermaidErEntityCharacter,
} from "./parser.js";

export function sourceMermaidErEntityName(value: string) {
  return value &&
    !/^(?:erDiagram|direction|subgraph|end|classDef|class|style|accTitle|accDescr)$/i.test(
      value,
    ) &&
    [...value].every(isMermaidErEntityCharacter)
    ? value
    : `"${value.replaceAll('"', "&quot;")}"`;
}

function sourceRelationshipRole(value: string) {
  return value && [...value].every(isMermaidErEntityCharacter)
    ? value
    : `"${value.replaceAll('"', "&quot;")}"`;
}

function sourceErAttributeWord(value: string) {
  return ATTRIBUTE_WORD_RE.test(value) || GENERIC_ATTRIBUTE_WORD_RE.test(value)
    ? value
    : `\`${value.replaceAll("`", "")}\``;
}

export function sourceMermaidErAttribute(attribute: {
  comment?: string;
  keys?: readonly string[];
  optional?: boolean;
  name: string;
  type: string;
}) {
  const optional = attribute.optional ?? attribute.type.endsWith("?");
  const type = attribute.type.replace(/\?$/, "");
  const keyValue = attribute.keys?.join(", ");
  const keyType = keyValue ? ` ${keyValue}` : "";
  const comment = attribute.comment
    ? ` "${attribute.comment.replaceAll('"', "&quot;")}"`
    : "";
  return `${sourceErAttributeWord(type)}${optional ? "?" : ""} ${sourceErAttributeWord(attribute.name)}${keyType}${comment}`;
}

export function generateMermaidErSource(model: MermaidErModel) {
  const lines = [
    ...model.directives.filter((line) => line.trim()),
    model.headerLine || "erDiagram",
  ];
  lines.push(`  direction ${model.direction}`);
  if (model.accessibilityTitle) {
    lines.push(`  accTitle: ${model.accessibilityTitle}`);
  }
  if (model.accessibilityDescription) {
    if (model.accessibilityDescription.includes("\n")) {
      lines.push("  accDescr {");
      lines.push(
        ...model.accessibilityDescription
          .split("\n")
          .map((line) => `    ${line}`),
      );
      lines.push("  }");
    } else {
      lines.push(`  accDescr: ${model.accessibilityDescription}`);
    }
  }
  const commentLines = (
    kind: string,
    key: string | undefined,
    position: "before" | "inside" | "after",
    indent: string,
  ) =>
    model.commentRecords
      .filter(
        (c) =>
          c.anchorKind === kind &&
          c.anchorId === key &&
          c.position === position,
      )
      .map((c) => `${indent}%% ${c.text}`);
  lines.push(...commentLines("diagram", undefined, "before", "  "));
  const emitScope = (scope: string | null, indent: string) => {
    for (const group of model.subgraphs
      .filter((g) => g.parentId === scope)
      .sort((a, b) => a.order - b.order)) {
      lines.push(
        ...commentLines("subgraph", group.sourceKey, "before", indent),
      );
      lines.push(
        `${indent}subgraph ${sourceMermaidErEntityName(group.id)} [${sourceMermaidErEntityName(group.label)}]`,
      );
      if (group.direction)
        lines.push(`${indent}  direction ${group.direction}`);
      lines.push(
        ...commentLines("subgraph", group.sourceKey, "inside", indent + "  "),
      );
      emitScope(group.id, indent + "  ");
      lines.push(
        `${indent}end`,
        ...commentLines("subgraph", group.sourceKey, "after", indent),
      );
    }
    for (const entity of model.entities
      .filter((e) => e.subgraphId === scope)
      .sort((a, b) => a.order - b.order)) {
      const name = sourceMermaidErEntityName(entity.id),
        alias =
          entity.label !== entity.id
            ? `[${sourceMermaidErEntityName(entity.label)}]`
            : "",
        css = entity.cssClasses.length
          ? `:::${[...new Set(entity.cssClasses)].join(",")}`
          : "";
      lines.push(...commentLines("entity", entity.sourceKey, "before", indent));
      if (
        entity.attributes.length ||
        model.commentRecords.some(
          (c) =>
            c.anchorKind === "entity" &&
            c.anchorId === entity.sourceKey &&
            c.position === "inside",
        )
      ) {
        lines.push(
          `${indent}${name}${alias}${css} {`,
          ...commentLines("entity", entity.sourceKey, "inside", indent + "  "),
        );
        for (const attribute of entity.attributes)
          lines.push(
            ...commentLines("attribute", attribute.id, "before", indent + "  "),
            `${indent}  ${sourceMermaidErAttribute(attribute)}`,
            ...commentLines("attribute", attribute.id, "after", indent + "  "),
          );
        lines.push(`${indent}}`);
      } else lines.push(`${indent}${name}${alias}${css}`);
      lines.push(...commentLines("entity", entity.sourceKey, "after", indent));
    }
    for (const relationship of model.relationships
      .filter((r) => r.scopeId === scope)
      .sort((a, b) => a.order - b.order)) {
      lines.push(
        ...commentLines("relation", relationship.sourceKey, "before", indent),
      );
      lines.push(
        `${indent}${sourceMermaidErEntityName(relationship.from)} ${relationship.fromCardinality}${relationship.identification}${relationship.toCardinality} ${sourceMermaidErEntityName(relationship.to)} : ${sourceRelationshipRole(relationship.label)}`,
        ...commentLines("relation", relationship.sourceKey, "after", indent),
      );
    }
  };
  emitScope(null, "  ");
  lines.push(...model.styleStatements.map((line) => `  ${line}`));
  return `${lines.join("\n")}\n`;
}

import { mermaidMessages as messages } from "../../i18n.js";
import { resolveMermaidErSource } from "./parser.js";
import { erSourceDiagnostic } from "./diagnostics.js";
import type { ErSourceRecord } from "./source-document.js";
import type { SourceValuePatch } from "../source-yaml.js";

export type ErPatch = SourceValuePatch & {
  identities?: readonly (readonly [number, string])[];
};
export type ErImpact = {
  records: readonly { id: string; kind: string; label: string }[];
};
export type ErCommandResult = {
  status: "changed" | "rejected" | "no-op";
  changed: boolean;
  source: string;
  model: MermaidErModel;
  patches: readonly ErPatch[];
  reason:
    "applied" | "no-change" | "conflict" | "invalid" | "readonly" | "cancelled";
  diagnostic?: string;
  selection?: string;
  focus?: string;
  remap: ReadonlyMap<string, string>;
  impact: ErImpact;
};
export type ErWriteOptions = {
  baseSource?: string;
  readonly?: boolean;
  intent?: "confirm" | "preview" | "cancel";
  removed?: ReadonlySet<string>;
  entityKeys?: ReadonlyMap<string, string>;
  subgraphKeys?: ReadonlyMap<string, string>;
  commentTransfers?: ReadonlySet<string>;
  selection?: string;
  focus?: string;
  impact?: ErImpact;
};
export function erNoChange(
  model: MermaidErModel,
  reason: ErCommandResult["reason"] = "no-change",
  diagnostic?: string,
): ErCommandResult {
  return {
    status:
      reason === "no-change" || reason === "cancelled" ? "no-op" : "rejected",
    changed: false,
    source: model.sourceDocument.source,
    model,
    patches: [],
    reason,
    diagnostic,
    remap: new Map(),
    impact: { records: [] },
  };
}
/** Exact basis validation and candidate reparse precede the sole host transaction.
 * Reserved record starts carry identity across equal signatures and moved units. */
export function writeErPatches(
  model: MermaidErModel,
  patches: readonly ErPatch[],
  options: ErWriteOptions = {},
): ErCommandResult {
  const source = model.sourceDocument.source;
  if (options.intent === "cancel") return erNoChange(model, "cancelled");
  if (options.readonly) return erNoChange(model, "readonly");
  if (options.baseSource !== undefined && options.baseSource !== source)
    return erNoChange(model, "conflict", messages.erSourceConflict());
  const sorted = [...patches].sort(
    (a, b) => a.range.start - b.range.start || a.range.end - b.range.end,
  );
  const mapping = new Map<number, string>(),
    reserved = new Set<string>();
  let next = "",
    cursor = 0;
  for (const patch of sorted) {
    if (
      !Number.isSafeInteger(patch.range.start) ||
      !Number.isSafeInteger(patch.range.end) ||
      patch.range.start < cursor ||
      patch.range.end < patch.range.start ||
      patch.range.end > source.length
    )
      return erNoChange(model, "invalid", messages.erPatchRejected());
    next += source.slice(cursor, patch.range.start);
    for (const [offset, id] of patch.identities ?? []) {
      if (offset < 0 || offset > patch.value.length || reserved.has(id))
        return erNoChange(model, "invalid", messages.erPatchRejected());
      mapping.set(next.length + offset, id);
      reserved.add(id);
    }
    next += patch.value;
    cursor = patch.range.end;
  }
  next += source.slice(cursor);
  if (next === source) return erNoChange(model);
  for (const record of model.sourceDocument.records) {
    if (
      reserved.has(record.sourceKey) ||
      options.removed?.has(record.sourceKey)
    )
      continue;
    let offset = record.range.start,
      removed = false;
    for (const patch of sorted) {
      if (patch.range.start > record.range.start) break;
      if (
        patch.range.end > patch.range.start &&
        record.range.start >= patch.range.start &&
        record.range.start < patch.range.end
      ) {
        if (
          patch.range.start === record.range.start &&
          patch.value &&
          patch.range.end <= record.range.end
        )
          break;
        removed = true;
        break;
      }
      offset += patch.value.length - (patch.range.end - patch.range.start);
    }
    if (!removed) mapping.set(offset, record.sourceKey);
  }
  const resolution = resolveMermaidErSource(
    next,
    model,
    mapping,
    options.entityKeys,
    options.subgraphKeys,
  );
  if (!resolution.model)
    return erNoChange(
      model,
      "invalid",
      resolution.diagnostics[0]
        ? erSourceDiagnostic(resolution.diagnostics[0])
        : messages.erPatchRejected(),
    );
  const keys = new Set(resolution.document.records.map((r) => r.sourceKey));
  for (const record of model.sourceDocument.records)
    if (!options.removed?.has(record.sourceKey) && !keys.has(record.sourceKey))
      return erNoChange(model, "invalid", messages.erPatchRejected());
  for (const comment of model.commentRecords) {
    if (
      options.removed?.has(comment.id) ||
      options.commentTransfers?.has(comment.id)
    )
      continue;
    const retained = resolution.model.commentRecords.find(
      (c) => c.id === comment.id,
    );
    if (
      !retained ||
      retained.anchorKind !== comment.anchorKind ||
      retained.anchorId !== comment.anchorId ||
      retained.position !== comment.position
    )
      return erNoChange(model, "invalid", messages.erPatchRejected());
  }
  const remap = new Map<string, string>();
  for (const key of keys) remap.set(key, key);
  for (const node of model.entities) {
    const retained = resolution.model.entities.find(
      (n) => n.sourceKey === node.sourceKey,
    );
    if (retained) remap.set(node.sourceKey, retained.sourceKey);
  }
  return {
    status: "changed",
    changed: true,
    source: next,
    model: resolution.model,
    patches: sorted,
    reason: "applied",
    selection: options.selection,
    focus: options.focus,
    remap,
    impact: options.impact ?? { records: [] },
  };
}
export function erRecord(model: MermaidErModel, key: string) {
  return model.sourceDocument.records.find((r) => r.sourceKey === key);
}
export function erRecordEnd(record: ErSourceRecord) {
  return record.range.end + record.eol.length;
}
export function erRecordGroup(model: MermaidErModel, key: string) {
  const record = erRecord(model, key);
  if (!record) return null;
  const comments = model.commentRecords.filter((c) => c.anchorId === key);
  const records = [
    record,
    ...comments.flatMap((c) => {
      const r = erRecord(model, c.id);
      return r ? [r] : [];
    }),
  ].sort((a, b) => a.range.start - b.range.start);
  const start = records[0]!.range.start,
    end = erRecordEnd(records.at(-1)!);
  return {
    records: model.sourceDocument.records.filter(
      (r) => r.range.start >= start && r.range.start < end,
    ),
    range: { start, end },
  };
}
export function erNewRecordPatch(
  model: MermaidErModel,
  offset: number,
  text: string,
  key?: string,
): ErPatch {
  const source = model.sourceDocument.source,
    newline = model.sourceDocument.newline;
  const previous = model.sourceDocument.records.findLast(
    (record) => erRecordEnd(record) <= offset && record.kind !== "blank",
  );
  const prefix =
    (offset > 0 && !/[\r\n]/.test(source[offset - 1]!) ? newline : "") +
    (previous?.kind === "comment" &&
    !text.trimStart().startsWith("%%") &&
    !/[\r\n]{2}$/.test(source.slice(0, offset))
      ? newline
      : "");
  const suffix =
    offset < source.length || /[\r\n]$/.test(source) ? newline : "";
  return {
    range: { start: offset, end: offset },
    value: prefix + text + suffix,
    identities: key ? [[prefix.length, key]] : undefined,
  };
}
/** Move one lexical unit; only a required EOF separator may be added. */
export function erMoveRecords(
  model: MermaidErModel,
  records: readonly ErSourceRecord[],
  offset: number,
): ErPatch[] {
  const start = records[0]!.range.start,
    end = erRecordEnd(records.at(-1)!);
  if (offset >= start && offset <= end) return [];
  let value = model.sourceDocument.source.slice(start, end);
  const newline = model.sourceDocument.newline;
  const insertion = erNewRecordPatch(
    model,
    offset,
    value,
    records[0]!.sourceKey,
  );
  const prefix = insertion.value.slice(0, insertion.identities![0]![0]);
  if (offset < model.sourceDocument.source.length && !/[\r\n]$/.test(value))
    value += newline;
  return [
    { range: { start, end }, value: "" },
    {
      range: { start: offset, end: offset },
      value: prefix + value,
      identities: records.map(
        (r) => [prefix.length + r.range.start - start, r.sourceKey] as const,
      ),
    },
  ];
}

/** Collapse preparatory lexical materialization and the requested operation into
 * original-basis record patches. The host still receives exactly one command. */
export function composeErCommandResults(
  original: MermaidErModel,
  result: ErCommandResult,
  options: ErWriteOptions = {},
): ErCommandResult {
  if (result.status === "rejected")
    return {
      ...result,
      source: original.sourceDocument.source,
      model: original,
      patches: [],
    };
  const old = original.sourceDocument.records,
    next = result.model.sourceDocument.records;
  const indices = new Map(
    old.map((record, index) => [record.sourceKey, index]),
  );
  const anchors: { old: ErSourceRecord; next: ErSourceRecord }[] = [];
  let last = -1;
  for (const record of next) {
    const index = indices.get(record.sourceKey);
    if (index === undefined || index <= last) continue;
    const previous = old[index]!;
    if (previous.raw !== record.raw || previous.eol !== record.eol) continue;
    anchors.push({ old: previous, next: record });
    last = index;
  }
  const patches: ErPatch[] = [];
  let start = 0,
    nextStart = 0;
  const boundaries = anchors.map((anchor) => ({
    oldStart: anchor.old.range.start,
    oldEnd: erRecordEnd(anchor.old),
    nextStart: anchor.next.range.start,
    nextEnd: erRecordEnd(anchor.next),
  }));
  boundaries.push({
    oldStart: original.sourceDocument.source.length,
    oldEnd: original.sourceDocument.source.length,
    nextStart: result.source.length,
    nextEnd: result.source.length,
  });
  for (const anchor of boundaries) {
    const end = anchor.oldStart,
      nextEnd = anchor.nextStart;
    const value = result.source.slice(nextStart, nextEnd);
    if (original.sourceDocument.source.slice(start, end) !== value)
      patches.push({
        range: { start, end },
        value,
        identities: next
          .filter((r) => r.range.start >= nextStart && r.range.start < nextEnd)
          .map((r) => [r.range.start - nextStart, r.sourceKey] as const),
      });
    start = anchor.oldEnd;
    nextStart = anchor.nextEnd;
  }
  const retained = new Set(next.map((r) => r.sourceKey));
  return writeErPatches(original, patches, {
    ...options,
    removed: new Set(
      old.filter((r) => !retained.has(r.sourceKey)).map((r) => r.sourceKey),
    ),
    entityKeys: new Map(result.model.entities.map((n) => [n.id, n.sourceKey])),
    subgraphKeys: new Map(
      result.model.subgraphs.map((n) => [n.id, n.sourceKey]),
    ),
    // Only a deliberately removed owner boundary can transfer a retained comment.
    commentTransfers: new Set([
      ...(options.commentTransfers ?? []),
      ...original.commentRecords
        .filter(
          (comment) =>
            comment.anchorId &&
            !retained.has(comment.anchorId) &&
            retained.has(comment.id),
        )
        .map((comment) => comment.id),
    ]),
    selection: result.selection,
    focus: result.focus,
    impact: result.impact,
  });
}
