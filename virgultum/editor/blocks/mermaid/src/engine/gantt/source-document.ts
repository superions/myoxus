// SPDX-License-Identifier: AGPL-3.0-or-later

import type { GanttConfigNumberField } from "./config.js";

export type GanttRange = {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly endLine: number;
};

export type GanttStatementKind =
  | "frontmatter"
  | "directive"
  | "header"
  | "title"
  | "accessibility-title"
  | "accessibility-description"
  | "option"
  | "section"
  | "task"
  | "click"
  | "comment"
  | "blank"
  | "unknown";

export type GanttOptionName =
  | "dateFormat"
  | "inclusiveEndDates"
  | "topAxis"
  | "axisFormat"
  | "tickInterval"
  | "includes"
  | "excludes"
  | "todayMarker"
  | "weekday"
  | "weekend"
  | "displayMode"
  | "useMaxWidth"
  | GanttConfigNumberField;

export type GanttSourceStatement = {
  readonly id: string;
  readonly kind: GanttStatementKind;
  readonly range: GanttRange;
  readonly raw: string;
  readonly indent: string;
  readonly complete: boolean;
  readonly optionName?: GanttOptionName;
};

export type GanttSourceDocument = {
  readonly source: string;
  readonly newline: "\n" | "\r\n" | "\r";
  readonly statements: readonly GanttSourceStatement[];
};

const OPTION_NAMES: readonly GanttOptionName[] = [
  "dateFormat",
  "inclusiveEndDates",
  "topAxis",
  "axisFormat",
  "tickInterval",
  "includes",
  "excludes",
  "todayMarker",
  "weekday",
  "weekend",
];

function lineEnd(source: string, start: number) {
  let end = start;
  while (end < source.length && source[end] !== "\r" && source[end] !== "\n")
    end += 1;
  return end;
}

export function ganttAfterLine(source: string, end: number) {
  return source.startsWith("\r\n", end)
    ? end + 2
    : end < source.length
      ? end + 1
      : end;
}

function lineCount(text: string) {
  return text.match(/\r\n|\r|\n/g)?.length ?? 0;
}

function optionNameFor(trimmed: string): GanttOptionName | undefined {
  // A bare statement is still the option; Mermaid accepts `inclusiveEndDates`
  // without a value and treats it as true.
  return OPTION_NAMES.find((name) =>
    new RegExp(`^${name}($|\\s)`, "i").test(trimmed),
  );
}

function classifyGanttLine(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "blank" as const };
  if (/^gantt$/i.test(trimmed)) return { kind: "header" as const };
  if (trimmed.startsWith("%%")) return { kind: "comment" as const };
  if (/^title\s/i.test(trimmed) || /^title$/i.test(trimmed))
    return { kind: "title" as const };
  if (/^accTitle\s*:/i.test(trimmed))
    return { kind: "accessibility-title" as const };
  // Mermaid still accepts the historical `accDescription` spelling; the writer
  // keeps that exact source form until the user changes it deliberately.
  if (
    /^accDescr(?:\s*:|\s*\{)/i.test(trimmed) ||
    /^accDescription(?:\s*:|\s*\{)/i.test(trimmed)
  )
    return { kind: "accessibility-description" as const };
  if (/^(?:click|href)\s/i.test(trimmed)) return { kind: "click" as const };
  if (/^section\s/i.test(trimmed) || /^section$/i.test(trimmed))
    return { kind: "section" as const };
  const optionName = optionNameFor(trimmed);
  if (optionName) return { kind: "option" as const, optionName };
  if (trimmed.includes(":")) return { kind: "task" as const };
  return { kind: "unknown" as const };
}

let statementCounter = 0;
function nextStatementId() {
  statementCounter += 1;
  return `gantt-stmt-${statementCounter}`;
}

/**
 * Scans Gantt source without normalizing line endings, indentation or trivia.
 * Statement ranges point into the original string so every visual command can
 * patch exactly its own statement and leave unrelated bytes untouched.
 */
export function scanGanttSource(source: string): GanttSourceDocument {
  const statements: GanttSourceStatement[] = [];
  let offset = 0;
  let line = 1;
  while (offset < source.length) {
    const start = offset;
    const startLine = line;
    let end = lineEnd(source, start);
    let raw = source.slice(start, end);
    let complete = true;
    let kind: GanttStatementKind;
    let optionName: GanttOptionName | undefined;
    if (start === 0 && raw.trim() === "---") {
      kind = "frontmatter";
      complete = false;
      let cursor = ganttAfterLine(source, end);
      while (cursor < source.length) {
        const nextEnd = lineEnd(source, cursor);
        if (source.slice(cursor, nextEnd).trim() === "---") {
          end = nextEnd;
          complete = true;
          break;
        }
        cursor = ganttAfterLine(source, nextEnd);
      }
      if (!complete) end = source.length;
      raw = source.slice(start, end);
    } else if (raw.trimStart().startsWith("%%{")) {
      kind = "directive";
      const close = source.indexOf("}%%", start);
      complete = close >= 0;
      end = complete ? close + 3 : source.length;
      raw = source.slice(start, end);
    } else {
      const classified = classifyGanttLine(raw);
      kind = classified.kind;
      optionName = classified.optionName;
      if (kind === "accessibility-description" && /\{/.test(raw)) {
        const open = source.indexOf("{", start);
        const close = source.indexOf("}", open + 1);
        complete = close >= 0;
        end = complete ? close + 1 : source.length;
        raw = source.slice(start, end);
      }
    }
    const indent = raw.match(/^[ \t]*/)?.[0] ?? "";
    statements.push({
      complete,
      id: nextStatementId(),
      indent,
      kind,
      optionName,
      range: {
        end,
        endLine: startLine + lineCount(raw),
        line: startLine,
        start,
      },
      raw,
    });
    const next = ganttAfterLine(source, end);
    line += lineCount(source.slice(start, next));
    offset = next;
  }
  return {
    newline: source.includes("\r\n")
      ? "\r\n"
      : source.includes("\r")
        ? "\r"
        : "\n",
    source,
    statements,
  };
}

/** Range including the statement's line ending, for delete/move patches. */
export function ganttStatementRangeWithEnding(
  document: GanttSourceDocument,
  statement: GanttSourceStatement,
) {
  return {
    end: ganttAfterLine(document.source, statement.range.end),
    start: statement.range.start,
  };
}
