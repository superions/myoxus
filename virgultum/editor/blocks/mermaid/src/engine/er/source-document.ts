// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ErSourceDiagnostic } from "./diagnostics.js";
import { takeErAttributeWord } from "./parser.js";
import { hashMermaidSource } from "../../utils.js";

export type ErRange = { start: number; end: number; line: number };
export type ErSourceRecord = {
  sourceKey: string;
  kind:
    | "statement"
    | "header"
    | "entity"
    | "attribute"
    | "relation"
    | "subgraph"
    | "entity-close"
    | "subgraph-end"
    | "style-definition"
    | "style-assignment"
    | "style"
    | "direction"
    | "comment"
    | "accessibility-title"
    | "accessibility-description"
    | "frontmatter"
    | "directive"
    | "blank"
    | "invalid";
  range: ErRange;
  raw: string;
  indent: string;
  eol: string;
  complete: boolean;
  ownerId?: string;
  subgraphId?: string | null;
  blockKey?: string;
  closeKey?: string;
  values: Record<string, ErRange>;
  references: Array<{
    kind: "entity" | "subgraph" | "style";
    id: string;
    range: ErRange;
  }>;
};
export type ErSourceDocument = {
  source: string;
  newline: string;
  records: ErSourceRecord[];
  diagnostics: ErSourceDiagnostic[];
};
export function nextErSourceKey() {
  return `er-source-${crypto.randomUUID()}`;
}

/** Physical records preserve delimiters; the one ER parser assigns semantic scope.
 * A cardinality brace is not an entity block boundary. */
export function scanErSource(source: string): ErSourceDocument {
  const records: ErSourceRecord[] = [];
  let cursor = 0,
    line = 1,
    inEntity = false;
  const push = (kind: ErSourceRecord["kind"], end: number, complete = true) => {
    const raw = source.slice(cursor, end);
    const eol = /^(?:\r\n|\r|\n)/.exec(source.slice(end))?.[0] ?? "";
    records.push({
      sourceKey: `er-record-${cursor}-${hashMermaidSource(raw)}`,
      kind,
      range: { start: cursor, end, line },
      raw,
      indent: /^[ \t]*/.exec(raw)![0],
      eol,
      complete,
      values: {},
      references: [],
    });
    cursor = end + eol.length;
    line += (raw.match(/\r\n|\r|\n/g)?.length ?? 0) + (eol ? 1 : 0);
  };
  while (cursor < source.length) {
    const tail = source.slice(cursor),
      indent = /^[ \t]*/.exec(tail)![0].length,
      text = tail.slice(indent);
    const lineEnd =
      cursor +
      (tail.search(/[\r\n]/) < 0 ? tail.length : tail.search(/[\r\n]/));
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
    if (text.startsWith("%%")) {
      push("comment", lineEnd);
      continue;
    }
    if (!tail.slice(0, lineEnd - cursor).trim()) {
      push("blank", lineEnd);
      continue;
    }
    if (!inEntity && /^accDescr\s*\{/i.test(text)) {
      const end = source.indexOf("}", cursor + indent);
      push(
        "accessibility-description",
        end < 0 ? source.length : end + 1,
        end >= 0,
      );
      continue;
    }
    if (inEntity && !text.startsWith("}")) {
      // Reuse the existing attribute lexer, including backticks and generics.
      // The pinned grammar also accepts several attributes on one physical line.
      const type = takeErAttributeWord(text, true);
      if (type) {
        let rest = type.rest;
        const optional = /^\s*\?/.exec(rest);
        if (optional) rest = rest.slice(optional[0].length);
        const name = takeErAttributeWord(rest);
        if (name) {
          rest = name.rest;
          const keys = /^\s*(?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*/i.exec(rest);
          if (keys) rest = rest.slice(keys[0].length);
          const comment = /^\s*"[^"]*"/.exec(rest);
          if (comment) rest = rest.slice(comment[0].length);
          const separator = /^\s*;/.exec(rest);
          if (separator && !/[\r\n]/.test(separator[0]))
            rest = rest.slice(separator[0].length);
          push("statement", cursor + indent + text.length - rest.length);
          continue;
        }
      }
    }
    let quote = "",
      generic = false,
      end = cursor + indent;
    // Detect the declaration prefix, excluding quoted marker-like names.
    const entityDeclaration =
      !inEntity &&
      /^(?:"[^"]*"|(?:[\u0080-\uFFFF]|\w|[-*.])+)(?:\s*\[(?:"[^"]*"|[^\]\r\n]+)\])?(?:\s*:::\s*[\p{L}\p{N}_.,-]+)?\s*\{/u.test(
        text,
      );

    for (; end < source.length; end++) {
      const c = source[end]!;
      if ((c === '"' || c === "`") && (!quote || quote === c)) {
        quote = quote ? "" : c;
        continue;
      }
      if (quote) continue;
      if (inEntity && c === "~") {
        generic = !generic;
        continue;
      }
      if (generic) continue;
      if (/[\r\n]/.test(c)) break;
      if (inEntity && c === "}") {
        if (end === cursor + indent) {
          end++;
          inEntity = false;
        }
        break;
      }
      if (entityDeclaration && c === "{") {
        end++;
        inEntity = true;
        break;
      }
      if (c === ";" || source.slice(end, end + 2) === "%%") {
        if (c === ";") end++;
        break;
      }
    }
    if (end === cursor + indent && source[end] && !/[\r\n]/.test(source[end]!))
      end++;
    push(
      text.startsWith("}") ? "entity-close" : "statement",
      end,
      !quote && !generic,
    );
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
export function erRecordRange(
  record: ErSourceRecord,
  start: number,
  end: number,
): ErRange {
  return {
    start: record.range.start + start,
    end: record.range.start + end,
    line:
      record.range.line +
      (record.raw.slice(0, start).match(/\r\n|\r|\n/g)?.length ?? 0),
  };
}

/** Explicit writer mappings and unique retained records are reserved before
 * duplicate-record coordinates, so an insertion cannot steal a neighbour key. */
export function reconcileErSource(
  document: ErSourceDocument,
  previous?: ErSourceDocument,
  mapping?: ReadonlyMap<number, string>,
) {
  if (!previous && !mapping) return document;
  const reserved = new Set(mapping?.values()),
    matches = new Map<number, string>();
  const exact = new Map<string, ErSourceRecord[]>(),
    incoming = new Map<string, ErSourceRecord[]>();
  const signature = (r: ErSourceRecord) =>
    `${r.kind}\0${r.ownerId ?? ""}\0${r.subgraphId ?? ""}\0${r.raw}`;
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
