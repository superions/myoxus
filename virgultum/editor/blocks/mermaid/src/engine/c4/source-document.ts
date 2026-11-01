// SPDX-License-Identifier: AGPL-3.0-or-later

import { c4Diagnostic, type C4SourceDiagnostic } from "./diagnostics.js";
export type { C4SourceDiagnostic } from "./diagnostics.js";
import { hashMermaidSource } from "../../utils.js";
import type { C4SelectionBinding, MermaidC4Argument } from "./model.js";
import { C4_CALLS, HEADERS } from "./runtime-contract.js";

export type C4Range = { start: number; end: number; line: number };
export type C4ArgumentBinding = {
  range: C4Range;
  value: C4Range;
  key?: C4Range;
  form: "empty" | "quoted" | "named" | "raw";
};
export type C4SourceRecord = {
  sourceKey: string;
  kind:
    | "header"
    | "frontmatter"
    | "directive"
    | "title"
    | "accessibility-title"
    | "accessibility-description"
    | "element"
    | "boundary-open"
    | "boundary-brace"
    | "boundary-close"
    | "relationship"
    | "element-update"
    | "relationship-update"
    | "layout-update"
    | "comment"
    | "blank"
    | "invalid";
  range: C4Range;
  raw: string;
  indent: string;
  eol: string;
  complete: boolean;
  scopeKeys: string[];
  scopeAliases: string[];
  callKind?: string;
  arguments?: MermaidC4Argument[];
  argumentBindings?: C4ArgumentBinding[];
  callRange?: C4Range;
  valueRange?: C4Range;
  value?: string;
  blockKey?: string;
  braceKey?: string;
  closeKey?: string;
  previousKey?: string;
  nextKey?: string;
  anchor?: { sourceKey: string; position: "before" | "after" | "inline" };
};
export type C4SourceDocument = {
  source: string;
  newline: string;
  records: C4SourceRecord[];
  diagnostics: C4SourceDiagnostic[];
  selectionBindings?: C4SelectionBinding[];
};
export type C4SourceBindings = {
  previous?: C4SourceDocument;
  mapping?: ReadonlyMap<number, string>;
};

let sourceIdentity = 0;
export function nextC4SourceKey() {
  return `c4-source-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}-${++sourceIdentity}`;
}
function lineAt(source: string, start: number) {
  return 1 + (source.slice(0, start).match(/\r\n|\r|\n/g)?.length ?? 0);
}
function range(source: string, start: number, end: number): C4Range {
  return { start, end, line: lineAt(source, start) };
}
function decode(value: string) {
  return value.trim().replaceAll("#quot;", '"').replaceAll("&quot;", '"');
}

/** Attributes are lexer tokens, not CSV fields. A single comma is skipped;
 * paired commas and quoted empty strings emit one explicit empty DB slot. */
function readArguments(source: string, start: number) {
  const args: MermaidC4Argument[] = [],
    bindings: C4ArgumentBinding[] = [];
  let cursor = start;
  const empty = (at: number, end: number) => {
    args.push({ key: "", value: "" });
    bindings.push({
      range: range(source, at, end),
      value: range(source, end, end),
      form: "empty",
    });
  };
  const failed = (at: number) => ({ args, bindings, end: at, complete: false });
  // The LPAREN lexer has a distinct opening-empty rule: ([ ]*,.
  const openingEmpty = /^[ ]*,/.exec(source.slice(cursor));
  if (openingEmpty) {
    empty(cursor, cursor + openingEmpty[0].length);
    cursor += openingEmpty[0].length;
  }
  while (cursor < source.length) {
    if (source[cursor] === ")")
      return { args, bindings, end: cursor + 1, complete: args.length > 0 };
    if (source.startsWith(",,", cursor)) {
      empty(cursor, cursor + 2);
      cursor += 2;
      continue;
    }
    if (source[cursor] === ",") {
      cursor++;
      continue;
    }
    const fieldStart = cursor;
    const spaces = /^[ ]*/.exec(source.slice(cursor))![0].length;
    const tokenStart = cursor + spaces;
    let quoteStart = tokenStart,
      key = "",
      keyRange: C4Range | undefined;
    if (source[tokenStart] === "$") {
      const equal = source.indexOf("=", tokenStart + 1);
      if (equal < 0) return failed(source.length);
      const keyRaw = source.slice(tokenStart + 1, equal);
      key = keyRaw.trim();
      const keyStart =
        tokenStart + 1 + (key ? keyRaw.indexOf(key) : keyRaw.length);
      keyRange = range(source, keyStart, keyStart + key.length);
      quoteStart = equal + 1 + /^[ ]*/.exec(source.slice(equal + 1))![0].length;
      if (source[quoteStart] !== '"') return failed(quoteStart);
    }
    if (source[quoteStart] === '"') {
      const close = source.indexOf('"', quoteStart + 1);
      if (close < 0) return failed(source.length);
      if (keyRange && close === quoteStart + 1) return failed(close + 1);
      cursor = close + 1;
      args.push({
        key,
        value: decode(source.slice(quoteStart + 1, close)),
        ...(keyRange && !key ? { named: true as const } : {}),
      });
      bindings.push({
        range: range(source, fieldStart, cursor),
        value: range(source, quoteStart + 1, close),
        key: keyRange,
        form: keyRange
          ? "named"
          : close === quoteStart + 1
            ? "empty"
            : "quoted",
      });
      // Adjacent quoted/named attributes need no comma in the native grammar.
    } else {
      const comma = source.indexOf(",", cursor);
      // STR consumes everything up to a comma, including unquoted parentheses.
      if (comma < 0) return failed(source.length);
      const raw = source.slice(cursor, comma),
        text = raw.trim();
      args.push({ key: "", value: decode(raw) });
      const valueStart = cursor + (text ? raw.indexOf(text) : raw.length);
      bindings.push({
        range: range(source, cursor, comma),
        value: range(source, valueStart, valueStart + text.length),
        form: text ? "raw" : "empty",
      });
      cursor = comma;
    }
  }
  return failed(cursor);
}

export function splitArgs(value: string): MermaidC4Argument[] | null {
  const parsed = readArguments(`${value})`, 0);
  return parsed.complete ? parsed.args : null;
}

/** Physical records own all source bytes; syntax and scope never depend on geometry.
 * Boundary calls and braces may occupy different physical lines in the grammar. */
export function scanC4Source(
  source: string,
  bindings: C4SourceBindings = {},
): C4SourceDocument {
  const document: C4SourceDocument = {
    source,
    newline: source.includes("\r\n")
      ? "\r\n"
      : source.includes("\r")
        ? "\r"
        : "\n",
    records: [],
    diagnostics: [],
  };
  const stack: C4SourceRecord[] = [];
  let cursor = 0,
    pending: C4SourceRecord | undefined,
    separatorRequired = false,
    headerSeen = false;
  const push = (
    kind: C4SourceRecord["kind"],
    end: number,
    complete = true,
  ): C4SourceRecord => {
    if (end <= cursor && !/^(?:\r\n|\r|\n)/.test(source.slice(end)))
      end = Math.min(source.length, cursor + 1);
    const raw = source.slice(cursor, end),
      eol = /^(?:\r\n|\r|\n)/.exec(source.slice(end))?.[0] ?? "";
    const record: C4SourceRecord = {
      sourceKey: `c4-record-${cursor}-${hashMermaidSource(raw)}`,
      kind,
      range: range(source, cursor, end),
      raw,
      indent: /^[ \t]*/.exec(raw)![0],
      eol,
      complete,
      scopeKeys: stack.map((r) => r.sourceKey),
      scopeAliases: stack.map((r) => r.arguments?.[0]?.value ?? ""),
    };
    document.records.push(record);
    cursor = end + eol.length;
    if (eol) separatorRequired = false;
    return record;
  };
  const diagnose = (record: C4SourceRecord, code: string, message: string) =>
    document.diagnostics.push(
      c4Diagnostic(
        record,
        code,
        message,
        code === "c4.boundary.unclosed"
          ? { correction: "boundary-close" as const }
          : code === "c4.boundary.open-missing"
            ? { correction: "boundary-open" as const }
            : {},
      ),
    );
  while (cursor < source.length) {
    const start = cursor,
      tail = source.slice(start),
      indent = /^[ \t]*/.exec(tail)![0].length,
      text = tail.slice(indent);
    const contentStart = start + indent;
    const newline = tail.search(/[\r\n]/),
      lineEnd = newline < 0 ? source.length : start + newline;
    if (!tail.slice(0, lineEnd - start).trim()) {
      push("blank", lineEnd);
      continue;
    }
    if (text.startsWith("%%{")) {
      const end = source.indexOf("}%%", contentStart + 3);
      const record = push(
        "directive",
        end < 0 ? source.length : end + 3,
        end >= 0,
      );
      if (!record.complete)
        diagnose(
          record,
          "c4.directive.unclosed",
          "Close the initialization directive with }%%.",
        );
      continue;
    }
    if (text.startsWith("%%")) {
      push("comment", lineEnd);
      continue;
    }
    if (separatorRequired) {
      const record = push("invalid", lineEnd, false);
      diagnose(
        record,
        "c4.statement.separator",
        "C4 statements require a newline separator.",
      );
      continue;
    }
    if (!headerSeen && /^---[ \t]*(?:\r\n|\r|\n)/.test(text)) {
      const close = /(?:\r\n|\r|\n)[ \t]*---[ \t]*(?=\r\n|\r|\n|$)/.exec(
        source.slice(contentStart + 3),
      );
      const record = push(
        "frontmatter",
        close
          ? contentStart + 3 + close.index + close[0].length
          : source.length,
        Boolean(close),
      );
      if (!record.complete)
        diagnose(
          record,
          "c4.frontmatter.unclosed",
          "Close the YAML frontmatter with ---.",
        );
      continue;
    }
    const token = /^[A-Za-z_]\w*/.exec(text)?.[0] ?? "";
    if (!headerSeen && HEADERS.has(token)) {
      const record = push("header", contentStart + token.length);
      record.value = token;
      headerSeen = true;
      separatorRequired = !record.eol;
      continue;
    }
    if (text.startsWith("{") && pending) {
      const record = push("boundary-brace", contentStart + 1);
      record.blockKey = pending.sourceKey;
      pending.braceKey = record.sourceKey;
      stack.push(pending);
      pending = undefined;
      separatorRequired = !record.eol;
      continue;
    }
    if (pending) {
      diagnose(
        pending,
        "c4.boundary.open-missing",
        "The boundary call requires an opening brace.",
      );
      pending.complete = false;
      pending = undefined;
    }
    if (text.startsWith("}")) {
      const record = push("boundary-close", contentStart + 1),
        open = stack.pop();
      if (!open)
        diagnose(
          record,
          "c4.boundary.close-unmatched",
          "This closing brace has no open C4 boundary.",
        );
      else {
        record.blockKey = open.sourceKey;
        open.closeKey = record.sourceKey;
      }
      separatorRequired = !record.eol;
      continue;
    }
    const metadata =
      /^(title\s|accTitle\s*:\s*|accDescr\s*:\s*|accDescription\s|accDescr\s*\{\s*)/.exec(
        text,
      );
    if (metadata) {
      const prefix = metadata[0],
        valueStart = contentStart + prefix.length;
      const multiline = prefix.includes("{"),
        isTitle = prefix.startsWith("title");
      const close = multiline ? source.indexOf("}", valueStart) : -1;
      const valueNewline = source.slice(valueStart).search(/[\r\n]/);
      const valueLineEnd =
        valueNewline < 0 ? source.length : valueStart + valueNewline;
      const terminator =
        isTitle || prefix.startsWith("accDescription")
          ? source.slice(valueStart, valueLineEnd).search(/[#;]/)
          : -1;
      const valueEnd = multiline
        ? close < 0
          ? source.length
          : close
        : terminator < 0
          ? valueLineEnd
          : valueStart + terminator;
      const kind = isTitle
        ? "title"
        : prefix.startsWith("accTitle")
          ? "accessibility-title"
          : "accessibility-description";
      const record = push(
        kind,
        multiline && close >= 0 ? close + 1 : valueEnd,
        !multiline || close >= 0,
      );
      record.valueRange = range(source, valueStart, valueEnd);
      record.value = source.slice(valueStart, valueEnd).trim();
      if (!record.complete)
        diagnose(
          record,
          "c4.accessibility.unclosed",
          "Close the multiline accessibility description with a brace.",
        );
      if (isTitle && valueEnd === valueStart)
        document.diagnostics.push(
          c4Diagnostic(
            record,
            "c4.title.empty",
            "The native title lexer requires a title value; remove this statement or enter a title.",
            { correction: "title-value" },
          ),
        );
      if (isTitle && terminator >= 0)
        document.diagnostics.push(
          c4Diagnostic(
            record,
            "c4.title.terminator",
            "The native title lexer ends before # or ;. Correct this title value.",
            {
              range: range(source, valueEnd, valueLineEnd),
              correction: "title-value",
            },
          ),
        );
      separatorRequired = !record.eol;
      continue;
    }
    const contract = C4_CALLS[token];
    if (contract && source[contentStart + token.length] === "(") {
      const parsed = readArguments(source, contentStart + token.length + 1);
      const kind: C4SourceRecord["kind"] =
        contract.category === "element"
          ? "element"
          : contract.category === "boundary"
            ? "boundary-open"
            : contract.category === "relationship"
              ? "relationship"
              : token === "UpdateElementStyle"
                ? "element-update"
                : token === "UpdateRelStyle"
                  ? "relationship-update"
                  : "layout-update";
      const record = push(
        kind,
        Math.max(contentStart + token.length + 1, parsed.end),
        parsed.complete,
      );
      record.callKind = token;
      record.arguments = parsed.args;
      record.argumentBindings = parsed.bindings;
      record.callRange = range(source, contentStart, record.range.end);
      if (!record.complete)
        diagnose(
          record,
          "c4.call.invalid",
          `Correct ${token}'s argument delimiters or close its quoted value and call.`,
        );
      if (contract.category === "boundary" && record.complete) pending = record;
      else separatorRequired = !record.eol;
      continue;
    }
    const record = push("invalid", lineEnd, false);
    diagnose(
      record,
      "c4.statement.unsupported",
      `Unsupported C4 statement on line ${record.range.line}.`,
    );
  }
  if (pending) {
    pending.complete = false;
    diagnose(
      pending,
      "c4.boundary.open-missing",
      "The boundary call requires an opening brace.",
    );
  }
  for (const open of stack) {
    open.complete = false;
    diagnose(
      open,
      "c4.boundary.unclosed",
      `Close ${open.callKind}(${open.arguments?.[0]?.value ?? ""}) with }.`,
    );
  }
  document.selectionBindings = bindings.previous?.selectionBindings;
  return reconcileC4Source(document, bindings);
}

/** Reserve explicit edit mappings and unique retained records before ambiguous duplicates.
 * This is the same identity discipline used by the existing ER source owner. */
export function reconcileC4Source(
  document: C4SourceDocument,
  { previous, mapping }: C4SourceBindings = {},
) {
  const signature = (r: C4SourceRecord) =>
    `${r.kind}\0${r.callKind ?? ""}\0${r.scopeAliases.join("\0")}\0${r.raw}`;
  const reserved = new Set(mapping?.values()),
    matches = new Map<number, string>();
  const oldGroups = new Map<string, C4SourceRecord[]>(),
    groups = new Map<string, C4SourceRecord[]>();
  for (const record of previous?.records ?? []) {
    if (reserved.has(record.sourceKey)) continue;
    const group = oldGroups.get(signature(record)) ?? [];
    group.push(record);
    oldGroups.set(signature(record), group);
  }
  for (const record of document.records) {
    if (mapping?.has(record.range.start)) continue;
    const group = groups.get(signature(record)) ?? [];
    group.push(record);
    groups.set(signature(record), group);
  }
  for (const [key, group] of groups) {
    const old = oldGroups.get(key);
    if (group.length === 1 && old?.length === 1) {
      matches.set(group[0].range.start, old[0].sourceKey);
      reserved.add(old[0].sourceKey);
    }
  }
  let prefix = 0,
    suffix = 0;
  if (previous) {
    const limit = Math.min(previous.source.length, document.source.length);
    while (
      prefix < limit &&
      previous.source[prefix] === document.source[prefix]
    )
      prefix++;
    while (
      suffix < limit - prefix &&
      previous.source[previous.source.length - suffix - 1] ===
        document.source[document.source.length - suffix - 1]
    )
      suffix++;
    const delta = document.source.length - previous.source.length;
    for (const record of document.records) {
      if (mapping?.has(record.range.start) || matches.has(record.range.start))
        continue;
      const old = (oldGroups.get(signature(record)) ?? []).filter(
        (r) =>
          !reserved.has(r.sourceKey) &&
          (r.range.end <= prefix
            ? r.range.start
            : r.range.start >= previous.source.length - suffix
              ? r.range.start + delta
              : undefined) === record.range.start,
      );
      if (old.length === 1) {
        matches.set(record.range.start, old[0].sourceKey);
        reserved.add(old[0].sourceKey);
      }
    }
  }
  // Fresh records must not steal a retained identity when an insertion happens
  // to reproduce a previous cold key at the same byte offset.
  const used = new Set<string>(),
    remapped = new Map<string, string>();
  for (const record of document.records) {
    const key =
      mapping?.get(record.range.start) ?? matches.get(record.range.start);
    const candidate = key && !used.has(key) ? key : record.sourceKey;
    const assigned =
      used.has(candidate) || (!key && reserved.has(candidate))
        ? nextC4SourceKey()
        : candidate;
    remapped.set(record.sourceKey, assigned);
    record.sourceKey = assigned;
    used.add(assigned);
  }
  for (const record of document.records) {
    record.scopeKeys = record.scopeKeys.map((key) => remapped.get(key) ?? key);
    if (record.blockKey)
      record.blockKey = remapped.get(record.blockKey) ?? record.blockKey;
    if (record.braceKey)
      record.braceKey = remapped.get(record.braceKey) ?? record.braceKey;
    if (record.closeKey)
      record.closeKey = remapped.get(record.closeKey) ?? record.closeKey;
  }
  for (const diagnostic of document.diagnostics)
    if (diagnostic.sourceKey)
      diagnostic.sourceKey =
        remapped.get(diagnostic.sourceKey) ?? diagnostic.sourceKey;
  for (let index = 0; index < document.records.length; index++) {
    const record = document.records[index];
    record.previousKey = document.records[index - 1]?.sourceKey;
    record.nextKey = document.records[index + 1]?.sourceKey;
    if (record.kind !== "comment" && record.kind !== "blank") continue;
    const before = document.records
      .slice(0, index)
      .findLast((r) => r.kind !== "comment" && r.kind !== "blank");
    const after = document.records
      .slice(index + 1)
      .find((r) => r.kind !== "comment" && r.kind !== "blank");
    const inline = before?.range.line === record.range.line && !before.eol;
    record.anchor =
      inline && before
        ? { sourceKey: before.sourceKey, position: "inline" }
        : after
          ? { sourceKey: after.sourceKey, position: "before" }
          : before
            ? { sourceKey: before.sourceKey, position: "after" }
            : undefined;
  }
  return document;
}
