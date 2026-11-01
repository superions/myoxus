// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidPacketModel } from "./model.js";

export type PacketRange = { start: number; end: number; line: number };
export type PacketSourceRecord = {
  sourceKey: string;
  kind:
    | "header"
    | "field"
    | "title"
    | "accessibility-title"
    | "accessibility-description"
    | "comment"
    | "blank"
    | "frontmatter"
    | "directive"
    | "invalid";
  range: PacketRange;
  raw: string;
  eol: string;
  indent: string;
  complete: boolean;
};
export type PacketSourceDocument = {
  source: string;
  newline: string;
  records: PacketSourceRecord[];
};
let identity = 0;
export function nextPacketSourceKey() {
  return `packet-source-${++identity}`;
}

// Field tokens follow the installed Langium INT/STRING grammar. Trivia retains physical ranges.
export const PACKET_FIELD_RE =
  /^(\+)?(0|[1-9]\d*)(?:[ \t]*-[ \t]*(0|[1-9]\d*))?[ \t]*:[ \t]*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/;
export function scanPacketSource(source: string): PacketSourceDocument {
  const records: PacketSourceRecord[] = [];
  let cursor = 0,
    line = 1;
  const push = (
    kind: PacketSourceRecord["kind"],
    start: number,
    end: number,
    complete = true,
  ) => {
    const raw = source.slice(start, end);
    const eol = /^(?:\r\n|\r|\n)/.exec(source.slice(end))?.[0] ?? "";
    records.push({
      sourceKey: nextPacketSourceKey(),
      kind,
      raw,
      eol,
      range: { start, end, line },
      indent: /^[ \t]*/.exec(raw)![0],
      complete,
    });
    cursor = end + eol.length;
    line += (raw.match(/\r\n|\r|\n/g)?.length ?? 0) + (eol ? 1 : 0);
  };
  while (cursor < source.length) {
    const start = cursor;
    const tail = source.slice(start);
    const indent = /^[ \t]*/.exec(tail)![0].length;
    const text = tail.slice(indent);
    const lineEnd =
      start + (tail.search(/[\r\n]/) < 0 ? tail.length : tail.search(/[\r\n]/));
    if (start === 0 && /^---[ \t]*(?:\r?\n)/.test(text)) {
      const close = /(?:\r?\n)[ \t]*---[ \t]*(?=\r?\n|$)/.exec(
        tail.slice(indent + 3),
      );
      const end = close
        ? start + indent + 3 + close.index + close[0].length
        : source.length;
      push("frontmatter", start, end, Boolean(close));
      continue;
    }
    if (text.startsWith("%%{")) {
      const close = source.indexOf("}%%", start + indent + 3);
      push(
        "directive",
        start,
        close < 0 ? source.length : close + 3,
        close >= 0,
      );
      continue;
    }
    if (text.startsWith("%%")) {
      push("comment", start, lineEnd);
      continue;
    }
    if (!tail.slice(0, lineEnd - start).trim()) {
      push("blank", start, lineEnd);
      continue;
    }
    const header = /^packet(?:-beta)?\b/.exec(text);
    if (header) {
      const end =
        start +
        indent +
        header[0].length +
        /^[ \t]*/.exec(text.slice(header[0].length))![0].length;
      push("header", start, end);
      continue;
    }
    const description = /^accDescr[ \t]*:/.exec(text);
    const block = /^accDescr\s*\{/.exec(text);
    if (block) {
      const close = source.indexOf("}", start + indent + block[0].length);
      const end = close < 0 ? source.length : close + 1;
      const sameLineTail = source
        .slice(end)
        .split(/\r\n|\r|\n/)[0]!
        .trim();
      push(
        "accessibility-description",
        start,
        end,
        close >= 0 && (!sameLineTail || sameLineTail.startsWith("%%")),
      );
      continue;
    }
    const title = /^title(?:[ \t]|(?=\r?\n|%%|$))/.test(text);
    const accTitle = /^accTitle[ \t]*:/.test(text);
    if (title || accTitle || description) {
      const comment = source.indexOf("%%", start + indent);
      push(
        title
          ? "title"
          : accTitle
            ? "accessibility-title"
            : "accessibility-description",
        start,
        comment >= 0 && comment < lineEnd ? comment : lineEnd,
      );
      continue;
    }
    const field = PACKET_FIELD_RE.exec(text);
    if (field) {
      const fieldEnd = start + indent + field[0].length;
      const end = fieldEnd + /^[ \t]*/.exec(source.slice(fieldEnd))![0].length;
      const rest = source.slice(end);
      const complete = !rest || /^(?:\r?\n|%%)/.test(rest);
      push("field", start, complete ? end : lineEnd, complete);
      continue;
    }
    push("invalid", start, lineEnd);
  }
  return { source, records, newline: source.includes("\r\n") ? "\r\n" : "\n" };
}
export function isPacketComment(line: string) {
  return line.trim().startsWith("%%");
}
export function hasUnsupportedMermaidPacketSource(model: MermaidPacketModel) {
  return model.diagnostics.some(
    (issue) =>
      issue.code === "syntax" ||
      issue.code === "precision" ||
      issue.code === "materialization",
  );
}

export function decodePacketString(value: string) {
  return value.slice(1, -1).replace(/\\(.)/g, (_match, escaped: string) => {
    if (escaped === "b") return "\b";
    if (escaped === "f") return "\f";
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    if (escaped === "v") return "\v";
    if (escaped === "0") return "\0";
    return escaped;
  });
}

export function encodePacketString(value: string) {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\b", "\\b")
    .replaceAll("\f", "\\f")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll("\v", "\\v")
    .replaceAll("\0", "\\0")
    .replaceAll('"', '\\"')}"`;
}

/** Reserve explicit and uniquely unchanged records before matching duplicate records at
 * unchanged prefix/suffix coordinates. An ambiguous external edit receives a fresh key. */
export function reconcilePacketSource(
  document: PacketSourceDocument,
  previous?: PacketSourceDocument,
  mapping?: ReadonlyMap<number, string>,
) {
  if (!previous && !mapping) return document;
  const reserved = new Set(mapping?.values());
  const matches = new Map<number, string>();
  const exact = new Map<string, PacketSourceRecord[]>();
  const incoming = new Map<string, PacketSourceRecord[]>();
  const signature = (r: PacketSourceRecord) => `${r.kind}\0${r.raw}`;
  for (const r of previous?.records ?? []) {
    if (reserved.has(r.sourceKey)) continue;
    const key = signature(r);
    const group = exact.get(key) ?? [];
    group.push(r);
    exact.set(key, group);
  }
  for (const r of document.records) {
    if (mapping?.has(r.range.start)) continue;
    const key = signature(r);
    const group = incoming.get(key) ?? [];
    group.push(r);
    incoming.set(key, group);
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
  for (const r of document.records) {
    const key = mapping?.get(r.range.start) ?? matches.get(r.range.start);
    if (key && !used.has(key)) {
      r.sourceKey = key;
      used.add(key);
    }
  }
  return document;
}
export function packetRecordRange(
  record: PacketSourceRecord,
  start: number,
  end: number,
): PacketRange {
  return {
    start: record.range.start + start,
    end: record.range.start + end,
    line:
      record.range.line +
      (record.raw.slice(0, start).match(/\r\n|\r|\n/g)?.length ?? 0),
  };
}

/** The move/delete unit owns only the field and explicitly attached comments.
 * Positional comments, metadata and directives outside that unit remain at their Source slot. */
export function packetFieldRecordGroup(
  model: MermaidPacketModel,
  fieldKey: string,
) {
  const field = model.fields.find((f) => f.id === fieldKey);
  if (!field?.statementRange) return null;
  const keys = new Set([
    fieldKey,
    ...(model.comments ?? [])
      .filter((c) => c.anchorId === fieldKey && c.affinity === "object")
      .map((c) => c.id),
  ]);
  const records = model.sourceDocument.records.filter((r) =>
    keys.has(r.sourceKey),
  );
  const start = Math.min(...records.map((r) => r.range.start));
  const end = Math.max(...records.map((r) => r.range.end + r.eol.length));
  // Incomplete inline trivia must never pull an unrelated directive into a move.
  if (
    model.sourceDocument.records.some(
      (r) =>
        r.range.start >= start &&
        r.range.end <= end &&
        !keys.has(r.sourceKey) &&
        r.kind !== "blank",
    )
  )
    return null;
  return {
    field,
    records: model.sourceDocument.records.filter(
      (r) => r.range.start >= start && r.range.end <= end,
    ),
    range: { start, end },
    raw: model.sourceDocument.source.slice(start, end),
  };
}
