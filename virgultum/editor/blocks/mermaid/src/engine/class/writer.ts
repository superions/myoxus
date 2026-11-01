// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidClassModel,
  MermaidClassNode,
  MermaidClassNamespace,
  MermaidClassNote,
} from "./model.js";
import { sourceMermaidClassName } from "./source-document.js";

function classDeclaration(node: MermaidClassNode) {
  const sourceId = sourceMermaidClassName(node.sourceId);
  const generic = node.genericType ? `~${node.genericType}~` : "";
  const label =
    node.label !== node.sourceId
      ? `["${node.label.replaceAll('"', "&quot;")}"]`
      : "";
  const annotation = node.annotations[0] ? ` <<${node.annotations[0]}>>` : "";
  const css = node.cssClasses.length ? `:::${node.cssClasses.join(",")}` : "";
  return `${sourceId}${generic}${label}${annotation}${css}`;
}

function renderClassNode(node: MermaidClassNode, indent: string) {
  const lines: string[] = [];
  if (node.members.length || node.annotations.length > 1) {
    lines.push(`${indent}class ${classDeclaration(node)} {`);
    for (const annotation of node.annotations.slice(1))
      lines.push(`${indent}  <<${annotation}>>`);
    for (const member of node.members) lines.push(`${indent}  ${member.raw}`);
    lines.push(`${indent}}`);
  } else {
    lines.push(`${indent}class ${classDeclaration(node)}`);
  }
  return lines;
}

export function generateMermaidClassSource(model: MermaidClassModel) {
  const lines = [
    ...model.directives.filter((line) => line.trim()),
    model.headerLine || model.diagramType,
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
  lines.push(...model.comments.map((comment) => `  %% ${comment}`));
  const explicitNamespaces = [...model.namespaces]
    .filter((namespace) => namespace.explicit)
    .sort((a, b) => a.order - b.order);
  const explicitNamespaceIds = new Set(
    explicitNamespaces.map((namespace) => namespace.id),
  );
  const explicitParentId = (namespace: MermaidClassNamespace) => {
    let parentId = namespace.parentId;
    while (parentId && !explicitNamespaceIds.has(parentId)) {
      parentId =
        model.namespaces.find((candidate) => candidate.id === parentId)
          ?.parentId ?? null;
    }
    return parentId;
  };
  const childrenByNamespace = new Map<string | null, MermaidClassNamespace[]>();
  for (const namespace of explicitNamespaces) {
    const parentId = explicitParentId(namespace);
    const children = childrenByNamespace.get(parentId) ?? [];
    children.push(namespace);
    childrenByNamespace.set(parentId, children);
  }
  const nodesByNamespace = new Map<string | null, MermaidClassNode[]>();
  for (const node of [...model.nodes]
    .filter((candidate) => candidate.kind === "class")
    .sort((a, b) => a.order - b.order)) {
    const children = nodesByNamespace.get(node.namespaceId) ?? [];
    children.push(node);
    nodesByNamespace.set(node.namespaceId, children);
  }
  const notesByNamespace = new Map<string | null, MermaidClassNote[]>();
  for (const note of [...model.notes].sort((a, b) => a.order - b.order)) {
    const children = notesByNamespace.get(note.namespaceId) ?? [];
    children.push(note);
    notesByNamespace.set(note.namespaceId, children);
  }
  const renderNote = (note: MermaidClassNote, indent: string) => {
    const owner = note.classId
      ? ` for ${sourceMermaidClassName(note.classId)}`
      : "";
    lines.push(
      `${indent}note${owner} "${note.text.replaceAll('"', "&quot;")}"`,
    );
  };
  const renderNamespace = (namespace: MermaidClassNamespace, depth: number) => {
    const indent = "  ".repeat(depth);
    const parentId = explicitParentId(namespace);
    const sourceId = parentId
      ? namespace.id.slice(parentId.length + 1)
      : namespace.id;
    const label =
      namespace.label !== sourceId
        ? `["${namespace.label.replaceAll('"', "&quot;")}"]`
        : "";
    lines.push(
      `${indent}namespace ${sourceMermaidClassName(sourceId)}${label} {`,
    );
    for (const node of nodesByNamespace.get(namespace.id) ?? [])
      lines.push(...renderClassNode(node, `${indent}  `));
    for (const note of notesByNamespace.get(namespace.id) ?? [])
      renderNote(note, `${indent}  `);
    for (const child of childrenByNamespace.get(namespace.id) ?? [])
      renderNamespace(child, depth + 1);
    lines.push(`${indent}}`);
  };
  for (const node of nodesByNamespace.get(null) ?? [])
    lines.push(...renderClassNode(node, "  "));
  for (const note of notesByNamespace.get(null) ?? []) renderNote(note, "  ");
  for (const namespace of childrenByNamespace.get(null) ?? [])
    renderNamespace(namespace, 1);
  for (const node of [...model.nodes].sort((a, b) => a.order - b.order)) {
    if (node.kind === "class" && node.interaction) {
      lines.push(`  ${node.interaction}`);
    }
  }
  const sourceReferenceByNodeId = new Map(
    model.nodes.map((node) => [
      node.id,
      `${sourceMermaidClassName(node.sourceId)}${
        node.kind === "lollipop-interface" && node.genericType
          ? `~${node.genericType}~`
          : ""
      }`,
    ]),
  );
  for (const relation of [...model.relations].sort(
    (a, b) => a.order - b.order,
  )) {
    const left = relation.fromCardinality
      ? ` "${relation.fromCardinality}"`
      : "";
    const right = relation.toCardinality ? `"${relation.toCardinality}" ` : "";
    const label = relation.label ? ` : ${relation.label}` : "";
    lines.push(
      `  ${sourceReferenceByNodeId.get(relation.from) ?? sourceMermaidClassName(relation.from)}${left} ${relation.kind} ${right}${sourceReferenceByNodeId.get(relation.to) ?? sourceMermaidClassName(relation.to)}${label}`,
    );
  }
  lines.push(...model.styleStatements.map((line) => `  ${line}`));
  return `${lines.join("\n")}\n`;
}

import { mermaidMessages as messages } from "../../i18n.js";
import { resolveMermaidClassSource } from "./parser.js";
import { classSourceDiagnostic } from "./diagnostics.js";
import type { ClassSourceRecord } from "./source-document.js";
import type { SourceValuePatch } from "../source-yaml.js";

export type ClassPatch = SourceValuePatch & {
  identities?: readonly (readonly [number, string])[];
};
export type ClassImpact = {
  records: readonly { id: string; kind: string; label: string }[];
  attachedNotes: readonly string[];
};
export type ClassCommandResult = {
  status: "changed" | "rejected" | "no-op";
  changed: boolean;
  source: string;
  model: MermaidClassModel;
  patches: readonly ClassPatch[];
  reason:
    "applied" | "no-change" | "conflict" | "invalid" | "readonly" | "cancelled";
  diagnostic?: string;
  selection?: string;
  focus?: string;
  remap: ReadonlyMap<string, string>;
  impact: ClassImpact;
};
export type ClassWriteOptions = {
  baseSource?: string;
  readonly?: boolean;
  intent?: "confirm" | "preview" | "cancel";
  removed?: ReadonlySet<string>;
  classKeys?: ReadonlyMap<string, string>;
  commentTransfers?: ReadonlySet<string>;
  selection?: string;
  focus?: string;
  impact?: ClassImpact;
};
export function classNoChange(
  model: MermaidClassModel,
  reason: ClassCommandResult["reason"] = "no-change",
  diagnostic?: string,
): ClassCommandResult {
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
    impact: { records: [], attachedNotes: [] },
  };
}
/** Exact basis validation and candidate reparse precede the sole host transaction.
 * Reserved record starts carry identity across equal signatures and moved units. */
export function writeClassPatches(
  model: MermaidClassModel,
  patches: readonly ClassPatch[],
  options: ClassWriteOptions = {},
): ClassCommandResult {
  const source = model.sourceDocument.source;
  if (options.intent === "cancel") return classNoChange(model, "cancelled");
  if (options.readonly) return classNoChange(model, "readonly");
  if (options.baseSource !== undefined && options.baseSource !== source)
    return classNoChange(model, "conflict", messages.classSourceConflict());
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
      return classNoChange(model, "invalid", messages.classPatchRejected());
    next += source.slice(cursor, patch.range.start);
    for (const [offset, id] of patch.identities ?? []) {
      if (offset < 0 || offset > patch.value.length || reserved.has(id))
        return classNoChange(model, "invalid", messages.classPatchRejected());
      mapping.set(next.length + offset, id);
      reserved.add(id);
    }
    next += patch.value;
    cursor = patch.range.end;
  }
  next += source.slice(cursor);
  if (next === source) return classNoChange(model);
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
  const resolution = resolveMermaidClassSource(
    next,
    model,
    mapping,
    options.classKeys,
  );
  if (!resolution.model)
    return classNoChange(
      model,
      "invalid",
      resolution.diagnostics[0]
        ? classSourceDiagnostic(resolution.diagnostics[0])
        : messages.classPatchRejected(),
    );
  const keys = new Set(resolution.document.records.map((r) => r.sourceKey));
  for (const record of model.sourceDocument.records)
    if (!options.removed?.has(record.sourceKey) && !keys.has(record.sourceKey))
      return classNoChange(model, "invalid", messages.classPatchRejected());
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
      return classNoChange(model, "invalid", messages.classPatchRejected());
  }
  const remap = new Map<string, string>();
  for (const key of keys) remap.set(key, key);
  for (const node of model.nodes) {
    const retained = resolution.model.nodes.find(
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
    impact: options.impact ?? { records: [], attachedNotes: [] },
  };
}
export function classRecord(model: MermaidClassModel, key: string) {
  return model.sourceDocument.records.find((r) => r.sourceKey === key);
}
export function classRecordEnd(record: ClassSourceRecord) {
  return record.range.end + record.eol.length;
}
export function classRecordGroup(model: MermaidClassModel, key: string) {
  const record = classRecord(model, key);
  if (!record) return null;
  const comments = model.commentRecords.filter((c) => c.anchorId === key);
  const records = [
    record,
    ...comments.flatMap((c) => {
      const r = classRecord(model, c.id);
      return r ? [r] : [];
    }),
  ].sort((a, b) => a.range.start - b.range.start);
  const start = records[0]!.range.start,
    end = classRecordEnd(records.at(-1)!);
  return {
    records: model.sourceDocument.records.filter(
      (r) => r.range.start >= start && r.range.start < end,
    ),
    range: { start, end },
  };
}
export function classNewRecordPatch(
  model: MermaidClassModel,
  offset: number,
  text: string,
  key?: string,
): ClassPatch {
  const source = model.sourceDocument.source,
    newline = model.sourceDocument.newline;
  const previous = model.sourceDocument.records.findLast(
    (record) => classRecordEnd(record) <= offset && record.kind !== "blank",
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
export function classMoveRecords(
  model: MermaidClassModel,
  records: readonly ClassSourceRecord[],
  offset: number,
): ClassPatch[] {
  const start = records[0]!.range.start,
    end = classRecordEnd(records.at(-1)!);
  if (offset >= start && offset <= end) return [];
  let value = model.sourceDocument.source.slice(start, end);
  const newline = model.sourceDocument.newline;
  const insertion = classNewRecordPatch(
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
export function composeClassCommandResults(
  original: MermaidClassModel,
  result: ClassCommandResult,
  options: ClassWriteOptions = {},
): ClassCommandResult {
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
  const anchors: { old: ClassSourceRecord; next: ClassSourceRecord }[] = [];
  let last = -1;
  for (const record of next) {
    const index = indices.get(record.sourceKey);
    if (index === undefined || index <= last) continue;
    const previous = old[index]!;
    if (previous.raw !== record.raw || previous.eol !== record.eol) continue;
    anchors.push({ old: previous, next: record });
    last = index;
  }
  const patches: ClassPatch[] = [];
  let start = 0,
    nextStart = 0;
  const boundaries = anchors.map((anchor) => ({
    oldStart: anchor.old.range.start,
    oldEnd: classRecordEnd(anchor.old),
    nextStart: anchor.next.range.start,
    nextEnd: classRecordEnd(anchor.next),
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
  return writeClassPatches(original, patches, {
    ...options,
    removed: new Set(
      old.filter((r) => !retained.has(r.sourceKey)).map((r) => r.sourceKey),
    ),
    classKeys: new Map(
      result.model.nodes
        .filter((n) => n.kind === "class")
        .map((n) => [n.sourceId, n.sourceKey]),
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
