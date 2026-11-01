// SPDX-License-Identifier: AGPL-3.0-or-later
import { hashMermaidSource } from "../../utils.js";
import type { SequenceSourceDiagnostic } from "./diagnostics.js";

export type SequenceRange = { start: number; end: number; line: number };
export type SequenceRecordKind =
  | "statement"
  | "header"
  | "participant"
  | "message"
  | "activation"
  | "create"
  | "destroy"
  | "note"
  | "fragment"
  | "branch"
  | "end"
  | "box"
  | "rect"
  | "link"
  | "properties"
  | "details"
  | "autonumber"
  | "title"
  | "accessibility-title"
  | "accessibility-description"
  | "frontmatter"
  | "directive"
  | "comment"
  | "blank"
  | "invalid";
export type SequenceSourceRecord = {
  sourceKey: string;
  kind: SequenceRecordKind;
  range: SequenceRange;
  raw: string;
  indent: string;
  eol: string;
  complete: boolean;
  parentId: string | null;
  branchId: string | null;
  ownerId?: string;
  closeKey?: string;
  blockKey?: string;
  primaryBranchKey?: string;
  temporal: boolean;
  values: Record<string, SequenceRange>;
  references: Array<{ id: string; range: SequenceRange }>;
};
export type SequenceSourceDocument = {
  source: string;
  newline: string;
  records: SequenceSourceRecord[];
  diagnostics: SequenceSourceDiagnostic[];
};

export function nextSequenceSourceKey() {
  return `sequence-source-${crypto.randomUUID()}`;
}

/** Preserve physical bytes and delimiters; the single parser assigns semantics
 * and scopes. Semicolons delimit statements except inside escapes or participant metadata. */
export function scanSequenceSource(source: string): SequenceSourceDocument {
  const records: SequenceSourceRecord[] = [];
  let cursor = 0,
    line = 1;
  const push = (kind: SequenceRecordKind, end: number, complete = true) => {
    const raw = source.slice(cursor, end),
      eol = /^(?:\r\n|\r|\n)/.exec(source.slice(end))?.[0] ?? "";
    records.push({
      sourceKey: `sequence-record-${cursor}-${hashMermaidSource(raw)}`,
      kind,
      range: { start: cursor, end, line },
      raw,
      indent: /^[ \t]*/.exec(raw)![0],
      eol,
      complete,
      parentId: null,
      branchId: null,
      temporal: false,
      values: {},
      references: [],
    });
    cursor = end + eol.length;
    line += (raw.match(/\r\n|\r|\n/g)?.length ?? 0) + (eol ? 1 : 0);
  };
  while (cursor < source.length) {
    const tail = source.slice(cursor),
      indent = /^[ \t]*/.exec(tail)![0].length,
      text = tail.slice(indent),
      lineOffset = tail.search(/[\r\n]/),
      lineEnd = cursor + (lineOffset < 0 ? tail.length : lineOffset);
    if (!tail.slice(0, lineEnd - cursor).trim()) {
      push("blank", lineEnd);
      continue;
    }
    if (cursor === 0 && /^---[ \t]*(?:\r\n|\r|\n)/.test(text)) {
      const close = /(?:\r\n|\r|\n)[ \t]*---[ \t]*(?=\r\n|\r|\n|$)/.exec(
        tail.slice(indent + 3),
      );
      push(
        "frontmatter",
        close
          ? cursor + indent + 3 + close.index + close[0].length
          : source.length,
        Boolean(close),
      );
      continue;
    }
    if (text.startsWith("%%{")) {
      const end = source.indexOf("}%%", cursor + indent + 3);
      push("directive", end < 0 ? source.length : end + 3, end >= 0);
      continue;
    }
    if (text.startsWith("%") || text.startsWith("#")) {
      push("comment", lineEnd);
      continue;
    }
    if (/^accDescr\s*\{/i.test(text)) {
      const end = source.indexOf("}", cursor + indent);
      push(
        "accessibility-description",
        end < 0 ? source.length : end + 1,
        end >= 0,
      );
      continue;
    }
    let quote = "",
      depth = 0,
      end = cursor + indent,
      label = false;
    for (; end < source.length; end++) {
      const c = source[end]!;
      if (quote) {
        if (c === quote && source[end - 1] !== "\\") quote = "";
        continue;
      }
      if ((c === '"' || c === "'") && depth > 0) {
        quote = c;
        continue;
      }
      if (depth > 0 && (c === "{" || c === "[")) depth++;
      else if (!label && c === "{" && /@\s*$/.test(source.slice(cursor, end)))
        depth++;
      if (depth > 0 && (c === "}" || c === "]")) depth--;
      if (depth > 0) continue;
      if (c === ":" && source[end - 1] !== "@") label = true;
      if (/[\r\n]/.test(c)) break;
      if (
        (!label && c === "%") ||
        (c === "#" && !/^#(?:\d+|[A-Za-z]+);/.test(source.slice(end)))
      )
        break;
      if (c === ";") {
        // Mermaid text escapes such as #59; must remain in their owning label.
        if (label && /#(?:\d+|[A-Za-z]+)$/.test(source.slice(cursor, end)))
          continue;
        end++;
        break;
      }
    }
    if (end === cursor + indent) end++;
    push("statement", end, !quote && depth === 0);
  }
  return {
    source,
    records,
    diagnostics: [],
    newline: source.includes("\r\n")
      ? "\r\n"
      : source.includes("\r")
        ? "\r"
        : "\n",
  };
}

/** Store exact token ranges, including repeated endpoint IDs on self messages. */
export function sequenceRecordValue(
  record: SequenceSourceRecord,
  field: string,
  value: string,
  after = 0,
) {
  if (!value) return after;
  const start = record.raw.indexOf(value, after);
  if (start < 0) return after;
  record.values[field] = {
    start: record.range.start + start,
    end: record.range.start + start + value.length,
    line: record.range.line,
  };
  return start + value.length;
}

export function reconcileSequenceSource(
  document: SequenceSourceDocument,
  previous?: SequenceSourceDocument,
  mapping?: ReadonlyMap<number, string>,
) {
  if (!previous && !mapping) return document;
  const reserved = new Set(mapping?.values()),
    matches = new Map<number, string>();
  const exact = new Map<string, SequenceSourceRecord[]>(),
    incoming = new Map<string, SequenceSourceRecord[]>();
  const signature = (r: SequenceSourceRecord) => r.raw;
  for (const r of previous?.records ?? []) {
    if (reserved.has(r.sourceKey)) continue;
    const group = exact.get(signature(r)) ?? [];
    group.push(r);
    exact.set(signature(r), group);
  }
  for (const r of document.records) {
    if (mapping?.has(r.range.start)) continue;
    const group = incoming.get(signature(r)) ?? [];
    group.push(r);
    incoming.set(signature(r), group);
  }
  for (const [key, group] of incoming) {
    const old = exact.get(key);
    if (group.length === 1 && old?.length === 1) {
      matches.set(group[0]!.range.start, old[0]!.sourceKey);
      reserved.add(old[0]!.sourceKey);
    }
  }
  let prefix = 0,
    suffix = 0;
  if (previous) {
    const limit = Math.min(document.source.length, previous.source.length);
    while (
      prefix < limit &&
      document.source[prefix] === previous.source[prefix]
    )
      prefix++;
    while (
      suffix < limit - prefix &&
      document.source[document.source.length - suffix - 1] ===
        previous.source[previous.source.length - suffix - 1]
    )
      suffix++;
    const delta = document.source.length - previous.source.length;
    for (const r of document.records) {
      if (mapping?.has(r.range.start) || matches.has(r.range.start)) continue;
      const candidates = (exact.get(signature(r)) ?? []).filter(
        (old) =>
          !reserved.has(old.sourceKey) &&
          (old.range.end <= prefix
            ? old.range.start
            : old.range.start >= previous.source.length - suffix
              ? old.range.start + delta
              : undefined) === r.range.start,
      );
      if (candidates.length === 1) {
        matches.set(r.range.start, candidates[0]!.sourceKey);
        reserved.add(candidates[0]!.sourceKey);
      }
    }
  }
  const used = new Set<string>();
  const remapped = new Map<string, string>();
  for (const r of document.records) {
    const key = mapping?.get(r.range.start) ?? matches.get(r.range.start);
    if (key && !used.has(key)) {
      remapped.set(r.sourceKey, key);
      r.sourceKey = key;
      used.add(key);
    }
  }
  for (const record of document.records) {
    if (record.blockKey)
      record.blockKey = remapped.get(record.blockKey) ?? record.blockKey;
    if (record.closeKey)
      record.closeKey = remapped.get(record.closeKey) ?? record.closeKey;
  }
  for (const diagnostic of document.diagnostics) {
    if (diagnostic.sourceKey)
      diagnostic.sourceKey =
        remapped.get(diagnostic.sourceKey) ?? diagnostic.sourceKey;
  }
  return document;
}
