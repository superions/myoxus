// SPDX-License-Identifier: AGPL-3.0-or-later

export type MermaidPieSourceRange = {
  end: number;
  endLine: number;
  start: number;
  startLine: number;
};

export type MermaidPieSourceField = {
  field:
    | "accessibilityDescription"
    | "accessibilityTitle"
    | "donutHole"
    | "highlightSlice"
    | "legendPosition"
    | "textPosition"
    | "title";
  range: MermaidPieSourceRange;
  valueRange: MermaidPieSourceRange;
};

type MermaidPieSourceRecordBase = {
  fingerprint: string;
  id: string;
  range: MermaidPieSourceRange;
  raw: string;
};

export type MermaidPieSourceRecord =
  | (MermaidPieSourceRecordBase & {
      fields: MermaidPieSourceField[];
      kind: "directive" | "frontmatter";
    })
  | (MermaidPieSourceRecordBase & { kind: "blank" })
  | (MermaidPieSourceRecordBase & {
      commentId: string;
      kind: "comment";
    })
  | (MermaidPieSourceRecordBase & {
      inlineCommentId?: string;
      inlineCommentRange?: MermaidPieSourceRange;
      kind: "header";
      showDataRange?: MermaidPieSourceRange;
    })
  | (MermaidPieSourceRecordBase & {
      effective: boolean;
      field: "accessibilityDescription" | "accessibilityTitle" | "title";
      format: "body" | "frontmatter";
      inlineCommentId?: string;
      inlineCommentRange?: MermaidPieSourceRange;
      kind: "metadata";
      valid: boolean;
      valueRange: MermaidPieSourceRange;
    })
  | (MermaidPieSourceRecordBase & {
      effective: boolean;
      field: "donutHole" | "highlightSlice" | "legendPosition" | "textPosition";
      kind: "option";
      sourceOwnerId: string;
      valid: boolean;
      valueRange: MermaidPieSourceRange;
    })
  | (MermaidPieSourceRecordBase & {
      conflictWith?: string;
      inlineCommentId?: string;
      inlineCommentRange?: MermaidPieSourceRange;
      kind: "slice";
      labelRange: MermaidPieSourceRange;
      sliceId?: string;
      valueRange: MermaidPieSourceRange;
    })
  | (MermaidPieSourceRecordBase & { kind: "invalid" });

export type MermaidPieSourceDocument = {
  endsWithNewline: boolean;
  lines: string[];
  newline: "\n" | "\r" | "\r\n";
  records: MermaidPieSourceRecord[];
  source: string;
};

export type MermaidPieLexicalRecord = {
  kind: "directive" | "frontmatter" | "line";
  range: MermaidPieSourceRange;
  raw: string;
};

export function mermaidPieFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function mermaidPieRecordId(
  kind: string,
  fingerprint: string,
  ordinal = 0,
) {
  return `pie-${kind}-${fingerprint}${ordinal ? `-${ordinal}` : ""}`;
}

function sourceNewline(source: string): MermaidPieSourceDocument["newline"] {
  return source.includes("\r\n") ? "\r\n" : source.includes("\r") ? "\r" : "\n";
}

function lineStarts(source: string) {
  const starts = [0];
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source[offset] === "\r" && source[offset + 1] === "\n") {
      starts.push(offset + 2);
      offset += 1;
    } else if (source[offset] === "\r" || source[offset] === "\n") {
      starts.push(offset + 1);
    }
  }
  return starts;
}

function lineEnd(source: string, starts: readonly number[], line: number) {
  const next = starts[line + 1] ?? source.length;
  let end = next;
  if (source[end - 1] === "\n") end -= 1;
  if (source[end - 1] === "\r") end -= 1;
  return end;
}

export function mermaidPieRange(
  _starts: readonly number[],
  startLine: number,
  endLine: number,
  start: number,
  end: number,
): MermaidPieSourceRange {
  return {
    end,
    endLine,
    start,
    startLine,
  };
}

export function offsetPieRange(
  record: MermaidPieLexicalRecord | Pick<MermaidPieSourceRecord, "range">,
  rawStart: number,
  rawEnd: number,
): MermaidPieSourceRange {
  const prefix = "raw" in record ? record.raw.slice(0, rawStart) : "";
  const content = "raw" in record ? record.raw.slice(rawStart, rawEnd) : "";
  const startLine =
    record.range.startLine + (prefix.match(/\r\n|\r|\n/g)?.length ?? 0);
  const endLine = startLine + (content.match(/\r\n|\r|\n/g)?.length ?? 0) + 1;
  return {
    end: record.range.start + rawEnd,
    endLine,
    start: record.range.start + rawStart,
    startLine,
  };
}

export function scanMermaidPieSource(source: string) {
  const starts = lineStarts(source);
  const lines = starts.map((start, line) =>
    source.slice(start, lineEnd(source, starts, line)),
  );
  const lexicalRecords: MermaidPieLexicalRecord[] = [];
  let line = 0;

  if (lines[0]?.trim() === "---") {
    const endLine = lines.findIndex(
      (candidate, index) => index > 0 && candidate.trim() === "---",
    );
    const exclusiveEnd = endLine < 0 ? lines.length : endLine + 1;
    const start = starts[0];
    const end =
      exclusiveEnd < starts.length ? starts[exclusiveEnd] : source.length;
    lexicalRecords.push({
      kind: "frontmatter",
      range: mermaidPieRange(starts, 0, exclusiveEnd, start, end),
      raw: source.slice(start, end),
    });
    line = exclusiveEnd;
  }

  while (line < lines.length) {
    const rawLine = lines[line] ?? "";
    if (rawLine.includes("%%{")) {
      const startColumn = rawLine.indexOf("%%{");
      const start = starts[line] + startColumn;
      let endLine = line;
      let end = -1;
      while (endLine < lines.length) {
        const closeColumn = lines[endLine].indexOf(
          "}%%",
          endLine === line ? startColumn + 3 : 0,
        );
        if (closeColumn >= 0) {
          end = starts[endLine] + closeColumn + 3;
          break;
        }
        endLine += 1;
      }
      if (end < 0) {
        endLine = lines.length - 1;
        end = source.length;
      }
      if (start > starts[line]) {
        lexicalRecords.push({
          kind: "line",
          range: mermaidPieRange(starts, line, line + 1, starts[line], start),
          raw: source.slice(starts[line], start),
        });
      }
      lexicalRecords.push({
        kind: "directive",
        range: mermaidPieRange(starts, line, endLine + 1, start, end),
        raw: source.slice(start, end),
      });
      const physicalEnd = lineEnd(source, starts, endLine);
      if (end < physicalEnd) {
        lexicalRecords.push({
          kind: "line",
          range: mermaidPieRange(
            starts,
            endLine,
            endLine + 1,
            end,
            physicalEnd,
          ),
          raw: source.slice(end, physicalEnd),
        });
      }
      line = endLine + 1;
      continue;
    }
    const start = starts[line];
    const end = lineEnd(source, starts, line);
    lexicalRecords.push({
      kind: "line",
      range: mermaidPieRange(starts, line, line + 1, start, end),
      raw: source.slice(start, end),
    });
    line += 1;
  }

  return {
    document: {
      endsWithNewline: /(?:\r\n|\r|\n)$/.test(source),
      lines,
      newline: sourceNewline(source),
      records: [] as MermaidPieSourceRecord[],
      source,
    },
    lexicalRecords,
  };
}

export function pieSourceFieldRanges(
  record: MermaidPieLexicalRecord,
): MermaidPieSourceField[] {
  const fields: MermaidPieSourceField[] = [];
  const fieldPattern =
    /\b(textPosition|donutHole|legendPosition|highlightSlice)\b[\t ]*:[\t ]*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,\s}\r\n#]+)/g;
  for (const match of record.raw.matchAll(fieldPattern)) {
    if (match.index === undefined) continue;
    const lineStart = Math.max(
      record.raw.lastIndexOf("\n", match.index - 1),
      record.raw.lastIndexOf("\r", match.index - 1),
    );
    if (
      record.raw
        .slice(lineStart + 1, match.index)
        .trimStart()
        .startsWith("#")
    ) {
      continue;
    }
    const field = match[1] as MermaidPieSourceField["field"];
    const valueStart = match.index + match[0].lastIndexOf(match[2]);
    fields.push({
      field,
      range: offsetPieRange(record, match.index, match.index + match[0].length),
      valueRange: offsetPieRange(
        record,
        valueStart,
        valueStart + match[2].length,
      ),
    });
  }
  if (record.kind === "frontmatter") {
    const titlePattern =
      /(?:^|\r?\n|\r)title[\t ]*:[\t ]*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\r\n#]*)/;
    const title = titlePattern.exec(record.raw);
    if (title?.index !== undefined) {
      const keyStart = title.index + title[0].indexOf("title");
      const valueStart = title.index + title[0].lastIndexOf(title[1]);
      let fieldEnd = title.index + title[0].length;
      let valueEnd = valueStart + title[1].trimEnd().length;
      if (/^[>|][+-]?\s*$/.test(title[1])) {
        let cursor = fieldEnd;
        while (cursor < record.raw.length) {
          const separator = /\r\n|\r|\n/y;
          separator.lastIndex = cursor;
          const matchedSeparator = separator.exec(record.raw);
          if (!matchedSeparator) break;
          const nextStart = cursor + matchedSeparator[0].length;
          const relativeNextEnd = record.raw
            .slice(nextStart)
            .search(/\r\n|\r|\n/);
          const nextEnd =
            relativeNextEnd < 0
              ? record.raw.length
              : nextStart + relativeNextEnd;
          const nextLine = record.raw.slice(nextStart, nextEnd);
          if (
            nextLine.trim() === "---" ||
            (nextLine.trim() && !/^\s/.test(nextLine))
          ) {
            break;
          }
          cursor = nextEnd;
          fieldEnd = cursor;
          valueEnd = cursor;
        }
      }
      fields.push({
        field: "title",
        range: offsetPieRange(record, keyStart, fieldEnd),
        valueRange: offsetPieRange(record, valueStart, valueEnd),
      });
    }
  }
  return fields.sort((left, right) => left.range.start - right.range.start);
}
