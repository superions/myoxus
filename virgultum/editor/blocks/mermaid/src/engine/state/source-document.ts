// SPDX-License-Identifier: AGPL-3.0-or-later
import { hashMermaidSource } from "../../utils.js";
import type { StateSourceDiagnostic } from "./diagnostics.js";

export type StateRange = { start: number; end: number; line: number };
export type StateRecordKind =
  | "statement"
  | "header"
  | "state"
  | "description"
  | "pseudostate"
  | "transition"
  | "composite"
  | "end"
  | "region"
  | "direction"
  | "note"
  | "link"
  | "class-definition"
  | "class-assignment"
  | "style"
  | "comment"
  | "blank"
  | "frontmatter"
  | "directive"
  | "accessibility-title"
  | "accessibility-description"
  | "source-option"
  | "opaque";
export type StateSourceRecord = {
  sourceKey: string;
  kind: StateRecordKind;
  raw: string;
  range: StateRange;
  indent: string;
  eol: string;
  complete: boolean;
  parentId: string | null;
  parentKey: string | null;
  regionKey: string | null;
  regionIndex: number;
  ownerId?: string;
  closeKey?: string;
  values: Record<string, StateRange>;
  references: Array<{ id: string; range: StateRange }>;
};
export type StateSourceDocument = {
  source: string;
  newline: string;
  records: StateSourceRecord[];
  diagnostics: StateSourceDiagnostic[];
};
/** Native layout visits declarations, relation endpoints and attached Notes.
 * Class/style/link references retain Source ownership without creating nodes. */
export function stateRenderReferences(record: StateSourceRecord) {
  return [
    "state",
    "description",
    "pseudostate",
    "composite",
    "transition",
  ].includes(record.kind) ||
    (record.kind === "note" &&
      /^\s*note\s+(?:left|right)\s+of\b/i.test(record.raw))
    ? record.references
    : [];
}
export function nextStateSourceKey() {
  return `state-source-${crypto.randomUUID()}`;
}

/** Existing Myoxus State sources can include href plus a tooltip. Native
 * 11.17.2 has separate href/no-tooltip and URL/tooltip productions. Project
 * only that known link spelling to the equivalent URL/tooltip production;
 * preserve stored/exported bytes and native diagnostic positions. */
export function projectStateNativeRenderSource(source: string) {
  let result = source;
  for (const record of scanStateSource(source).records) {
    if (record.kind !== "statement") continue;
    const link =
      /^(\s*click\s+[^:\s{}-]+\s+)(href)(\s+"[^"]*"\s+"[^"]*"\s*)$/i.exec(
        record.raw,
      );
    if (!link) continue;
    const start = record.range.start + link[1]!.length;
    result =
      result.slice(0, start) +
      " ".repeat(link[2]!.length) +
      result.slice(start + link[2]!.length);
  }
  return result;
}

/** Preserve physical bytes, including inline braces. This scanner does not
 * decide runtime validity; the State parser assigns semantics and diagnostics. */
export function scanStateSource(source: string): StateSourceDocument {
  const records: StateSourceRecord[] = [];
  let cursor = 0,
    line = 1;
  const push = (kind: StateRecordKind, end: number, complete = true) => {
    const raw = source.slice(cursor, end),
      eol = /^(?:\r\n|\r|\n)/.exec(source.slice(end))?.[0] ?? "";
    records.push({
      sourceKey: `state-record-${cursor}-${hashMermaidSource(raw)}`,
      kind,
      raw,
      range: { start: cursor, end, line },
      indent: /^[ \t]*/.exec(raw)![0],
      eol,
      complete,
      parentId: null,
      parentKey: null,
      regionKey: null,
      regionIndex: 0,
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
    const lineLength = tail.search(/[\r\n]/),
      lineEnd = cursor + (lineLength < 0 ? tail.length : lineLength);
    if (!source.slice(cursor, lineEnd).trim()) {
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
    if (text.startsWith("%%") || text.startsWith("#")) {
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
    if (
      /^note\s+(?:left|right)\s+of\s+[^:\r\n]+[ \t]*(?:\r\n|\r|\n)/i.test(text)
    ) {
      const end = /(?:\r\n|\r|\n)[ \t]*end[ \t]+note\b/i.exec(text);
      push(
        "note",
        end ? cursor + indent + end.index + end[0].length : source.length,
        Boolean(end),
      );
      continue;
    }
    let quote = false,
      end = cursor + indent;
    const floating = /^note\s+"/i.test(text),
      alias = /^state\s+"/i.test(text);
    for (; end < source.length; end++) {
      const c = source[end]!;
      if (c === '"' && source[end - 1] !== "\\") {
        quote = !quote;
        continue;
      }
      if (quote) continue;
      if (/[\r\n]/.test(c)) break;
      if (c === "}" && end === cursor + indent) {
        end++;
        break;
      }
      if (c === "{" && /^state\s+/i.test(text)) {
        end++;
        break;
      }
      if (c === "}" && !floating && !alias && /\s/.test(source[end - 1] ?? ""))
        break;
      if (
        c === "%" &&
        source[end + 1] === "%" &&
        (floating || alias || !text.includes(":"))
      )
        break;
    }
    if (end === cursor + indent) end++;
    // Native IDs are whitespace-delimited, not line-delimited. A semicolon is
    // an ID character except where it terminates a description token. Preserve
    // each lexical statement separately, including its interstitial spaces.
    if (
      !/^(?:state\s|stateDiagram\b|stateDiagram-v2\b|note\s|class(?:Def)?\s|style\s|click\s|direction\s|accTitle\b|accDescr\b|hide\s|scale\s|--$|\})/i.test(
        text,
      )
    ) {
      const candidate = source.slice(cursor + indent, end);
      const endpoint = /^(?:\[\*\]|[^:\s{-]+)(?::::[^:\s{-]+)?/;
      const first = endpoint.exec(candidate);
      if (first) {
        let length = first[0].length;
        const arrow = /^\s*-->\s*/.exec(candidate.slice(length));
        if (arrow) {
          const target = endpoint.exec(
            candidate.slice(length + arrow[0].length),
          );
          if (target) length += arrow[0].length + target[0].length;
          else {
            push("statement", end, !quote);
            continue;
          }
        }
        const colon = /^\s*:(?!:)/.exec(candidate.slice(length));
        if (colon) {
          length += colon[0].length;
          while (length < candidate.length) {
            const entity = /^#\w+;/.exec(candidate.slice(length));
            if (entity) {
              length += entity[0].length;
              continue;
            }
            if (candidate[length] === ";") break;
            length++;
          }
        }
        if (length < candidate.length) end = cursor + indent + length;
      }
    }
    push("statement", end, !quote);
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

/** Token ranges distinguish the two occurrences of a self-transition endpoint. */
export function stateRecordValue(
  record: StateSourceRecord,
  field: string,
  value: string,
  after = 0,
) {
  const start = record.raw.indexOf(value, after);
  if (start < 0) return after;
  record.values[field] = {
    start: record.range.start + start,
    end: record.range.start + start + value.length,
    line: record.range.line,
  };
  return start + value.length;
}

/** Writer mappings reserve changed/moved records. For external edits, match
 * unique unchanged bytes first, then unchanged prefix/suffix occurrences. */
export function reconcileStateSource(
  document: StateSourceDocument,
  previous?: StateSourceDocument,
  mapping?: ReadonlyMap<number, string>,
) {
  if (!previous && !mapping) return document;
  const reserved = new Set(mapping?.values()),
    matches = new Map<number, string>();
  const old = new Map<string, StateSourceRecord[]>(),
    incoming = new Map<string, StateSourceRecord[]>();
  for (const r of previous?.records ?? []) {
    if (reserved.has(r.sourceKey)) continue;
    const group = old.get(r.raw) ?? [];
    group.push(r);
    old.set(r.raw, group);
  }
  for (const r of document.records) {
    if (mapping?.has(r.range.start)) continue;
    const group = incoming.get(r.raw) ?? [];
    group.push(r);
    incoming.set(r.raw, group);
  }
  for (const [raw, group] of incoming) {
    const candidates = old.get(raw);
    if (group.length === 1 && candidates?.length === 1) {
      matches.set(group[0]!.range.start, candidates[0]!.sourceKey);
      reserved.add(candidates[0]!.sourceKey);
    }
  }
  if (previous) {
    let prefix = 0,
      suffix = 0;
    const limit = Math.min(previous.source.length, document.source.length);
    while (
      prefix < limit &&
      previous.source[prefix] === document.source[prefix]
    )
      prefix++;
    while (
      suffix < limit - prefix &&
      previous.source.at(-suffix - 1) === document.source.at(-suffix - 1)
    )
      suffix++;
    const delta = document.source.length - previous.source.length;
    for (const r of document.records) {
      if (mapping?.has(r.range.start) || matches.has(r.range.start)) continue;
      const candidates = (old.get(r.raw) ?? []).filter(
        (p) =>
          !reserved.has(p.sourceKey) &&
          (p.range.end <= prefix
            ? p.range.start
            : p.range.start >= previous.source.length - suffix
              ? p.range.start + delta
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

/** Decode Mermaid text escapes for both the rendered label and its typed draft. */
export function stateDisplayText(text: string) {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    quot: '"',
    lt: "<",
    gt: ">",
    infin: "∞",
  };
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/#(\d+);/g, (match, number) => {
      const n = Number(number);
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    })
    .replace(
      /#([a-z]+);/gi,
      (match, name: string) => entities[name.toLowerCase()] ?? match,
    );
}
