// SPDX-License-Identifier: AGPL-3.0-or-later

export type SankeyRange = {
  readonly start: number;
  readonly end: number;
  readonly line: number;
};

export type SankeyField = {
  readonly range: SankeyRange;
  readonly raw: string;
  readonly value: string;
  readonly quoted: boolean;
  readonly valid: boolean;
};

export type SankeyRecord = {
  readonly id: string;
  readonly kind:
    "frontmatter" | "directive" | "header" | "comment" | "blank" | "csv";
  readonly range: SankeyRange;
  readonly raw: string;
  readonly fields: readonly SankeyField[];
  readonly complete: boolean;
};

export type SankeySourceDocument = {
  readonly source: string;
  readonly newline: "\n" | "\r\n" | "\r";
  readonly records: readonly SankeyRecord[];
};

function lineEnd(source: string, start: number) {
  let end = start;
  while (end < source.length && source[end] !== "\r" && source[end] !== "\n")
    end++;
  return end;
}

function afterLine(source: string, end: number) {
  return source.startsWith("\r\n", end)
    ? end + 2
    : end < source.length
      ? end + 1
      : end;
}

/**
 * Source offsets always address the original text. Runtime whitespace cleanup
 * must not erase quoted newlines, comments or CRLF from subsequent field edits.
 */
export function scanSankeySource(source: string): SankeySourceDocument {
  const records: SankeyRecord[] = [];
  let offset = 0;
  let line = 1;
  let headerSeen = false;
  while (offset < source.length) {
    const start = offset;
    const startLine = line;
    const end = lineEnd(source, start);
    const text = source.slice(start, end).trim();
    let kind: SankeyRecord["kind"] = "csv";
    let complete = true;
    let contentEnd = end;
    let fields: SankeyField[] = [];
    if (start === 0 && text === "---") {
      kind = "frontmatter";
      let cursor = afterLine(source, end);
      complete = false;
      while (cursor < source.length) {
        const nextEnd = lineEnd(source, cursor);
        if (source.slice(cursor, nextEnd).trim() === "---") {
          contentEnd = nextEnd;
          complete = true;
          break;
        }
        cursor = afterLine(source, nextEnd);
      }
      if (!complete) contentEnd = source.length;
    } else if (text.startsWith("%%{")) {
      kind = "directive";
      const close = source.indexOf("}%%", start);
      complete = close >= 0;
      contentEnd = complete ? close + 3 : source.length;
    } else if (text.startsWith("%%")) kind = "comment";
    else if (!text) kind = "blank";
    else if (!headerSeen && /^sankey(?:-beta)?$/i.test(text)) {
      kind = "header";
      headerSeen = true;
    } else {
      let cursor = start;
      let fieldStart = start;
      let fieldLine = line;
      let state: "start" | "plain" | "quoted" | "closed" = "start";
      let valid = true;
      let quoted = false;
      const finishField = () => {
        const raw = source.slice(fieldStart, cursor);
        const trimmed = raw.trim();
        const encoded = quoted ? trimmed.slice(1, -1) : trimmed;
        fields.push({
          range: { start: fieldStart, end: cursor, line: fieldLine },
          raw,
          quoted,
          valid:
            valid &&
            state !== "quoted" &&
            (quoted ? trimmed.endsWith('"') : !raw.includes('"')),
          value: encoded
            .replaceAll('""', '"')
            .replace(/\r\n?/g, "\n")
            .replace(/\n+/g, "\n")
            .trim(),
        });
      };
      for (; cursor < source.length; cursor++) {
        const character = source[cursor];
        if (state === "quoted") {
          if (character === '"') {
            if (source[cursor + 1] === '"') cursor++;
            else state = "closed";
          } else if (!/[\x20-\x7e\r\n]/.test(character)) valid = false;
          continue;
        }
        if (character === ",") {
          finishField();
          fieldStart = cursor + 1;
          fieldLine =
            startLine +
            (source.slice(start, fieldStart).match(/\r\n|\r|\n/g)?.length ?? 0);
          state = "start";
          quoted = false;
          valid = true;
        } else if (character === "\r" || character === "\n") break;
        else if (state === "start" && character === '"') {
          state = "quoted";
          quoted = true;
        } else if (state === "closed") {
          if (source.slice(cursor).trim() !== "") valid = false;
        } else {
          if (!/[\x20-\x21\x23-\x2b\x2d-\x7e]/.test(character)) valid = false;
          state = "plain";
        }
      }
      complete = state !== "quoted";
      finishField();
      contentEnd = cursor;
    }
    records.push({
      id: crypto.randomUUID(),
      kind,
      range: { start, end: contentEnd, line: startLine },
      raw: source.slice(start, contentEnd),
      fields,
      complete,
    });
    offset = afterLine(source, contentEnd);
    line += source.slice(start, offset).match(/\r\n|\r|\n/g)?.length ?? 0;
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
