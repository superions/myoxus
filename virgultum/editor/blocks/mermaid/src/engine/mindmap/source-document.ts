// SPDX-License-Identifier: AGPL-3.0-or-later

import { getMermaidSourceHeaderIndex } from "../diagram-types.js";
import {
  mindmapRuntimeContract,
  readMindmapNode,
  type MindmapNodeSyntax,
} from "./runtime-contract.js";

export type MindmapRange = { start: number; end: number; line: number };
export type MindmapRecord = {
  sourceKey: string;
  kind:
    | "preamble"
    | "header"
    | "node"
    | "icon"
    | "class"
    | "comment"
    | "blank"
    | "invalid";
  raw: string;
  range: MindmapRange;
  eol: string;
  indent: string;
  /** Empty CLASS consumes its newline; a pending SPACELIST can indent the next node. */
  nativeIndent?: string;
  indentProviderKey?: string;
  node?: MindmapNodeSyntax;
  labelRange?: MindmapRange;
  labelTokenRange?: MindmapRange;
  shapeRange?: MindmapRange;
  idRange?: MindmapRange;
  value?: string;
  valueRange?: MindmapRange;
  anchorKey?: string;
  effective?: boolean;
  diagnosticCode?: import("./diagnostics.js").MindmapDiagnosticCode;
};
export type MindmapSourceDocument = {
  source: string;
  newline: string;
  records: MindmapRecord[];
};
export type MindmapSourceBindings = {
  previous?: MindmapSourceDocument;
  /** Checked patches carry identities for changed/moved records at new offsets. */
  mapping?: ReadonlyMap<number, string>;
};

export function mindmapRange(
  source: string,
  start: number,
  end: number,
): MindmapRange {
  return {
    start,
    end,
    line: 1 + (source.slice(0, start).match(/\r\n|\r|\n/g)?.length ?? 0),
  };
}

/** Physical records cover Source exactly; normalization is never applied to ranges. */
export function scanMindmapSource(
  source: string,
  bindings: MindmapSourceBindings = {},
): MindmapSourceDocument {
  const document: MindmapSourceDocument = {
    source,
    newline: /\r\n|\r|\n/.exec(source)?.[0] ?? "\n",
    records: [],
  };
  const headerLine = getMermaidSourceHeaderIndex(source);
  let cursor = 0,
    physicalLine = 0,
    headerSeen = false;
  const push = (end: number, kind: MindmapRecord["kind"]) => {
    const raw = source.slice(cursor, end);
    const eol = /^(?:\r\n|\r|\n)/.exec(source.slice(end))?.[0] ?? "";
    const record: MindmapRecord = {
      sourceKey: `mindmap-source-${crypto.randomUUID()}`,
      kind,
      raw,
      range: mindmapRange(source, cursor, end),
      eol,
      indent: /^[^\S\r\n]*/.exec(raw)![0],
    };
    document.records.push(record);
    physicalLine += (raw.match(/\r\n|\r|\n/g)?.length ?? 0) + (eol ? 1 : 0);
    cursor = end + eol.length;
    return record;
  };
  while (cursor < source.length) {
    const tail = source.slice(cursor),
      indent = /^[^\S\r\n]*/.exec(tail)![0];
    const start = cursor + indent.length;
    const newline = tail.search(/[\r\n]/);
    const lineEnd = newline < 0 ? source.length : cursor + newline;
    if (physicalLine < headerLine) {
      push(lineEnd, "preamble");
      continue;
    }
    if (!headerSeen && physicalLine === headerLine) {
      const header = mindmapRuntimeContract.header.exec(source.slice(start));
      if (header) {
        push(start + header[0].length, "header");
        headerSeen = true;
        continue;
      }
    }
    if (!source.slice(cursor, lineEnd).trim()) {
      push(lineEnd, "blank");
      continue;
    }
    if (source.startsWith("%%", start)) {
      const r = push(lineEnd, "comment");
      r.value = source.slice(start + 2, lineEnd);
      r.valueRange = mindmapRange(source, start + 2, lineEnd);
      continue;
    }
    const lineStart =
      Math.max(
        source.lastIndexOf("\n", cursor - 1),
        source.lastIndexOf("\r", cursor - 1),
      ) + 1;
    const previous = document.records.findLast((r) => r.kind !== "blank");
    if (source.slice(lineStart, cursor).trim() && previous?.kind !== "header") {
      const r = push(lineEnd, "invalid");
      r.diagnosticCode = "mindmap.syntax.statement";
      continue;
    }
    const decoration = /^(?::::([^\r\n]*)|::icon\(([^)]*)\))/i.exec(
      source.slice(start),
    );
    if (decoration) {
      const kind = decoration[1] === undefined ? "icon" : "class";
      const r = push(start + decoration[0].length, kind);
      r.value = decoration[1] ?? decoration[2];
      const valueStart = start + (kind === "icon" ? 7 : 3);
      r.valueRange = mindmapRange(
        source,
        valueStart,
        valueStart + r.value.length,
      );
      continue;
    }
    const node = readMindmapNode(source, start);
    if (!node) {
      const r = push(lineEnd, "invalid");
      r.diagnosticCode = mindmapRuntimeContract.header.test(source.slice(start))
        ? "mindmap.syntax.header"
        : "mindmap.syntax.node";
      continue;
    }
    const r = push(node.end, "node");
    r.node = node;
    r.labelRange = mindmapRange(source, node.labelStart, node.labelEnd);
    r.labelTokenRange = mindmapRange(
      source,
      node.labelTokenStart,
      node.labelTokenEnd,
    );
    r.shapeRange = mindmapRange(source, node.openStart, node.end);
    r.idRange = mindmapRange(source, start, node.openStart);
  }
  reconcileMindmapRecords(document, bindings);
  let pendingClass: MindmapRecord | undefined;
  for (const record of document.records) {
    if (record.kind === "header" || record.kind === "preamble") continue;
    if (record.kind === "blank" || record.kind === "comment") {
      pendingClass = undefined;
      continue;
    }
    if (pendingClass && record.indent) {
      pendingClass.diagnosticCode = "mindmap.syntax.empty-class";
      pendingClass = undefined;
    }
    const emptyClass = record.kind === "class" && !record.value;
    if (pendingClass && record.kind === "node") {
      record.nativeIndent = pendingClass.indent;
      record.indentProviderKey = pendingClass.sourceKey;
    }
    if (!emptyClass) pendingClass = undefined;
    if (emptyClass && record.indent) pendingClass = record;
  }
  let lastNode: string | undefined;
  for (const record of document.records) {
    if (record.kind === "node") lastNode = record.sourceKey;
    else if (
      record.kind === "icon" ||
      record.kind === "class" ||
      record.kind === "comment"
    )
      record.anchorKey = lastNode;
  }
  return document;
}

/** Reserve explicit and unchanged bindings first; only unique moved records can
 * reuse remaining keys. Neither ordinal, parent path nor raw content is identity. */
export function reconcileMindmapRecords(
  document: MindmapSourceDocument,
  { previous, mapping }: MindmapSourceBindings,
) {
  const used = new Set<string>(),
    assigned = new Set<MindmapRecord>();
  const reserve = (record: MindmapRecord, key: string | undefined) => {
    if (!key || used.has(key)) return;
    record.sourceKey = key;
    used.add(key);
    assigned.add(record);
  };
  for (const record of document.records)
    reserve(record, mapping?.get(record.range.start));
  if (!previous) return;
  let prefix = 0,
    suffix = 0;
  const limit = Math.min(previous.source.length, document.source.length);
  while (prefix < limit && previous.source[prefix] === document.source[prefix])
    prefix++;
  while (
    suffix < limit - prefix &&
    previous.source.at(-suffix - 1) === document.source.at(-suffix - 1)
  )
    suffix++;
  const signature = (record: MindmapRecord) =>
    `${record.kind}\0${record.raw}\0${record.eol}`;
  const oldBySignature = new Map<string, MindmapRecord[]>();
  for (const old of previous.records) {
    const key = signature(old);
    oldBySignature.set(key, [...(oldBySignature.get(key) ?? []), old]);
  }
  const delta = document.source.length - previous.source.length;
  for (const record of document.records) {
    if (assigned.has(record)) continue;
    const exact = (oldBySignature.get(signature(record)) ?? []).filter(
      (old) => {
        if (used.has(old.sourceKey)) return false;
        const end = old.range.end + old.eol.length;
        const shifted =
          end <= prefix
            ? old.range.start
            : old.range.start >= previous.source.length - suffix
              ? old.range.start + delta
              : undefined;
        return shifted === record.range.start;
      },
    );
    if (exact.length === 1) reserve(record, exact[0].sourceKey);
  }
  const pending = document.records.filter((record) => !assigned.has(record));
  for (const record of pending) {
    const signatureKey = signature(record);
    const matches = (oldBySignature.get(signatureKey) ?? []).filter(
      (old) => !used.has(old.sourceKey),
    );
    if (
      matches.length === 1 &&
      pending.filter((other) => signature(other) === signatureKey).length === 1
    )
      reserve(record, matches[0].sourceKey);
  }
}
