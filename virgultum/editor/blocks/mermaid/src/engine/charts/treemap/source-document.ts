// SPDX-License-Identifier: AGPL-3.0-or-later

export type TreemapRange = {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly endLine: number;
};

export type TreemapRecordKind =
  | "frontmatter"
  | "directive"
  | "header"
  | "title"
  | "accessibility-title"
  | "accessibility-description"
  | "comment"
  | "blank"
  | "class-def"
  | "node"
  | "unknown";

export type TreemapSourceRecord = {
  readonly id: string;
  readonly kind: TreemapRecordKind;
  readonly range: TreemapRange;
  readonly raw: string;
  readonly complete: boolean;
};

export type TreemapSourceDocument = {
  readonly source: string;
  readonly newline: "\n" | "\r\n" | "\r";
  readonly records: readonly TreemapSourceRecord[];
};

function lineEnd(source: string, start: number) {
  let end = start;
  while (end < source.length && source[end] !== "\r" && source[end] !== "\n")
    end += 1;
  return end;
}

export function treemapAfterLine(source: string, end: number) {
  return source.startsWith("\r\n", end)
    ? end + 2
    : end < source.length
      ? end + 1
      : end;
}

function lineCount(source: string) {
  return source.match(/\r\n|\r|\n/g)?.length ?? 0;
}

function classifyTreemapLine(raw: string, headerSeen: boolean) {
  const trimmed = raw.trim();
  if (!trimmed) return "blank" as const;
  if (!headerSeen && /^treemap(?:-beta)?$/i.test(trimmed))
    return "header" as const;
  if (trimmed.startsWith("%%")) return "comment" as const;
  if (/^title(?:\s|$)/i.test(trimmed)) return "title" as const;
  if (/^accTitle\s*:/i.test(trimmed)) return "accessibility-title" as const;
  if (/^accDescr(?:\s*:|\s*\{)/i.test(trimmed))
    return "accessibility-description" as const;
  if (/^classDef(?:\s|$)/i.test(trimmed)) return "class-def" as const;
  // A line beginning with a quote is a bounded hierarchy statement even when
  // its closing quote is malformed. Keeping that record typed lets the visual
  // editor expose a local repair anchor instead of reducing it to global trivia.
  if (/^[ \t]*["']/.test(raw)) return "node" as const;
  return "unknown" as const;
}

/**
 * Scans source without normalizing line endings or trivia. Record ranges point
 * into the original string so every visual command can patch only its owner.
 */
export function scanTreemapSource(source: string): TreemapSourceDocument {
  const records: TreemapSourceRecord[] = [];
  let offset = 0;
  let line = 1;
  let headerSeen = false;
  while (offset < source.length) {
    const start = offset;
    const startLine = line;
    let end = lineEnd(source, start);
    let raw = source.slice(start, end);
    let kind: TreemapRecordKind;
    let complete = true;
    if (start === 0 && raw.trim() === "---") {
      kind = "frontmatter";
      complete = false;
      let cursor = treemapAfterLine(source, end);
      while (cursor < source.length) {
        const nextEnd = lineEnd(source, cursor);
        if (source.slice(cursor, nextEnd).trim() === "---") {
          end = nextEnd;
          complete = true;
          break;
        }
        cursor = treemapAfterLine(source, nextEnd);
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
      kind = classifyTreemapLine(raw, headerSeen);
      if (kind === "accessibility-description" && /\{/.test(raw)) {
        const open = source.indexOf("{", start);
        const close = source.indexOf("}", open + 1);
        complete = close >= 0;
        end = complete ? close + 1 : source.length;
        raw = source.slice(start, end);
      }
    }
    if (kind === "header") headerSeen = true;
    const endLine = startLine + lineCount(raw);
    records.push({
      id: crypto.randomUUID(),
      kind,
      range: { start, end, line: startLine, endLine },
      raw,
      complete,
    });
    const next = treemapAfterLine(source, end);
    line += lineCount(source.slice(start, next));
    offset = next;
  }
  return {
    source,
    newline: source.includes("\r\n")
      ? "\r\n"
      : source.includes("\r")
        ? "\r"
        : "\n",
    records,
  };
}

export function treemapRecordRangeWithEnding(
  document: TreemapSourceDocument,
  record: TreemapSourceRecord,
) {
  return {
    start: record.range.start,
    end: treemapAfterLine(document.source, record.range.end),
  };
}
