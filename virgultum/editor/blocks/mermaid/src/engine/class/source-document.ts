// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ClassSourceDiagnostic } from "./diagnostics.js";
import { reconcileSourceRecordBindings } from "../source-record-bindings.js";

export const CLASS_NAME_SOURCE =
  "(?:`[^`]+`|[\\p{L}\\p{N}_-]+(?:\\.[\\p{L}\\p{N}_-]+)*)";
export const CLASS_GENERIC_TYPE_SOURCE = String.raw`[^~]*`;
export const CLASS_REFERENCE_SOURCE = `${CLASS_NAME_SOURCE}(?:\\s*~${CLASS_GENERIC_TYPE_SOURCE}~)?`;
export const INTERACTION_OWNER_RE = new RegExp(
  `^(?:link|callback|click)\\s+(${CLASS_NAME_SOURCE})(?:\\s*~(${CLASS_GENERIC_TYPE_SOURCE})~)?\\s+`,
  "du",
);

export function retargetMermaidClassInteraction(
  interaction: string,
  sourceId: string,
  genericType = "",
) {
  const owner = INTERACTION_OWNER_RE.exec(interaction);
  const command = /^(?:link|callback|click)\s+/.exec(interaction)?.[0];
  if (!owner || !command) return interaction;
  const reference = `${sourceMermaidClassName(sourceId)}${
    genericType ? `~${genericType}~` : ""
  }`;
  return `${command}${reference} ${interaction.slice(owner[0].length)}`;
}

export function getMermaidClassNoteDisplayText(value: string) {
  return value.replaceAll(/<br\s*\/?>/gi, "\n").replaceAll("\\n", "\n");
}

export function sourceMermaidClassName(value: string) {
  return /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u.test(value)
    ? value
    : `\`${value.replaceAll("`", "")}\``;
}

export type ClassRange = { start: number; end: number; line: number };
export type ClassSourceRecord = {
  sourceKey: string;
  kind:
    | "statement"
    | "header"
    | "class"
    | "member"
    | "annotation"
    | "namespace"
    | "note"
    | "relation"
    | "interaction"
    | "style-definition"
    | "style"
    | "style-assignment"
    | "direction"
    | "accessibility-title"
    | "accessibility-description"
    | "comment"
    | "blank"
    | "frontmatter"
    | "directive"
    | "close"
    | "invalid";
  range: ClassRange;
  raw: string;
  indent: string;
  eol: string;
  complete: boolean;
  ownerId?: string;
  namespaceId?: string | null;
  blockKey?: string;
  closeKey?: string;
  values: Record<string, ClassRange>;
  references: Array<{
    kind: "class" | "namespace" | "style";
    id: string;
    range: ClassRange;
  }>;
};
export type ClassSourceDocument = {
  source: string;
  diagnostics: ClassSourceDiagnostic[];
  newline: string;
  records: ClassSourceRecord[];
};
let sourceIdentity = 0;
export function nextClassSourceKey() {
  return `class-source-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}-${++sourceIdentity}`;
}

/** Bound physical statements without interpreting members as top-level keywords.
 * Semantic ownership and validation are assigned by the single Class parser. */
export function scanClassSource(source: string): ClassSourceDocument {
  const records: ClassSourceRecord[] = [];
  let cursor = 0,
    line = 1,
    inClass = false;
  const push = (
    kind: ClassSourceRecord["kind"],
    end: number,
    complete = true,
  ) => {
    const start = cursor,
      raw = source.slice(start, end);
    const eol = /^(?:\r\n|\r|\n)/.exec(source.slice(end))?.[0] ?? "";
    records.push({
      // Cold reads of the same Source must resolve the same projection keys.
      // Subsequent commands reconcile these seeds with the retained identities.
      sourceKey: `class-record-${start}-${stableRecordHash(raw)}`,
      kind,
      raw,
      range: { start, end, line },
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
    const start = cursor,
      tail = source.slice(start),
      indent = /^[ \t]*/.exec(tail)![0].length;
    const text = tail.slice(indent);
    const lineEnd =
      start + (tail.search(/[\r\n]/) < 0 ? tail.length : tail.search(/[\r\n]/));
    if (start === 0 && /^---[ \t]*(?:\r\n|\r|\n)/.test(text)) {
      const close = /(?:\r\n|\r|\n)[ \t]*---[ \t]*(?=\r\n|\r|\n|$)/.exec(
        tail.slice(indent + 3),
      );
      push(
        "frontmatter",
        close
          ? start + indent + 3 + close.index + close[0].length
          : source.length,
        Boolean(close),
      );
      continue;
    }
    if (text.startsWith("%%{")) {
      const close = source.indexOf("}%%", start + indent + 3);
      push("directive", close < 0 ? source.length : close + 3, close >= 0);
      continue;
    }
    if (text.startsWith("%%")) {
      push("comment", lineEnd);
      continue;
    }
    if (!tail.slice(0, lineEnd - start).trim()) {
      push("blank", lineEnd);
      continue;
    }
    if (!inClass && /^accDescr\s*\{/.test(text)) {
      const open = source.indexOf("{", start + indent),
        close = source.indexOf("}", open + 1);
      push(
        "accessibility-description",
        close < 0 ? source.length : close + 1,
        close >= 0,
      );
      continue;
    }
    let quote = "",
      generic = false,
      referencePosition = true,
      end = start + indent,
      complete = true;
    for (; end < source.length; end++) {
      const c = source[end]!;
      if (!inClass && !quote && referencePosition && c === "~") {
        generic = !generic;
        continue;
      }
      if (generic) continue;
      if ((c === '"' || c === "`") && (!quote || quote === c)) {
        quote = quote ? "" : c;
        continue;
      }
      if (quote) {
        if (inClass && /[\r\n]/.test(c)) break;
        continue;
      }
      if (c === ":") referencePosition = false;
      if (c === "}") {
        if (end === start + indent) {
          end++;
          inClass = false;
        }
        break;
      }
      if (c === "{") {
        if (inClass) complete = false;
        end++;
        if (/^class\s/.test(text)) inClass = true;
        break;
      }
      if (/\r|\n/.test(c)) break;
      if (!inClass && c === ";") {
        end++;
        break;
      }
      if (!inClass && source.slice(end, end + 2) === "%%") break;
    }
    if (
      end === start + indent &&
      source[end] !== undefined &&
      !/[\r\n]/.test(source[end]!)
    ) {
      end++;
      complete = false;
    }
    if ((quote && !inClass) || generic) complete = false;
    push(text.startsWith("}") ? "close" : "statement", end, complete);
  }
  return {
    source,
    diagnostics: [],
    newline: source.includes("\r\n")
      ? "\r\n"
      : source.includes("\r")
        ? "\r"
        : "\n",
    records,
  };
}
function stableRecordHash(raw: string) {
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index++) {
    hash = Math.imul(hash ^ raw.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(36);
}
export function classRecordRange(
  record: ClassSourceRecord,
  start: number,
  end: number,
): ClassRange {
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
export function reconcileClassSource(
  document: ClassSourceDocument,
  previous?: ClassSourceDocument,
  mapping?: ReadonlyMap<number, string>,
) {
  return reconcileSourceRecordBindings(
    document,
    previous,
    mapping,
    (r) => `${r.kind}\0${r.ownerId ?? ""}\0${r.namespaceId ?? ""}\0${r.raw}`,
    nextClassSourceKey,
  );
}
