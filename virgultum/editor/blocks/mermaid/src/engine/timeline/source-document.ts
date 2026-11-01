// SPDX-License-Identifier: AGPL-3.0-or-later

export type TimelineSourceRange = {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly endLine?: number;
};

export type TimelineStatementKind =
  | "frontmatter"
  | "directive"
  | "header"
  | "title"
  | "accessibility-title"
  | "accessibility-description"
  | "section"
  | "period"
  | "event"
  | "comment"
  | "blank"
  | "invalid";

export type TimelineEventSegment = {
  readonly id: string;
  readonly range: TimelineSourceRange;
  readonly valueRange: TimelineSourceRange;
  readonly raw: string;
  readonly separator: string;
};

export type TimelineSourceStatement = TimelineSourceLine & {
  readonly id: string;
  readonly kind: TimelineStatementKind;
  readonly complete: boolean;
  readonly indent: string;
  readonly valueRange?: TimelineSourceRange;
  readonly segments: readonly TimelineEventSegment[];
};

export type TimelineSourceDocument = {
  readonly source: string;
  readonly newline: "\n" | "\r" | "\r\n";
  readonly statements: readonly TimelineSourceStatement[];
};

export type TimelineIdentityMapping = {
  readonly statements: ReadonlyMap<number, string>;
  readonly segments: ReadonlyMap<number, string>;
};

let identityCounter = 0;
/** Session identity never encodes a label, source fingerprint or array position. */
export function nextTimelineIdentity() {
  return `timeline-record-${++identityCounter}`;
}

function trimRange(raw: string, start: number, end = raw.length) {
  while (start < end && /\s/.test(raw[start]!)) start++;
  while (end > start && /\s/.test(raw[end - 1]!)) end--;
  return { start, end };
}

function classify(raw: string): TimelineStatementKind {
  const text = raw.trim();
  if (!text) return "blank";
  if (/^%%\{/.test(text)) return "directive";
  if (/^[%#]/.test(text)) return "comment";
  if (/^timeline\b/i.test(text)) return "header";
  if (/^\s*title\s[^\r\n]+$/i.test(raw)) return "title";
  if (/^accTitle\s*:/i.test(text)) return "accessibility-title";
  if (/^accDescr\s*[:{]/i.test(text)) return "accessibility-description";
  if (/^\s*section\s[^:\r\n]+/i.test(raw)) return "section";
  if (text.startsWith(":")) return "event";
  return "period";
}

/** One scanner owns statement and inline-segment boundaries in the original bytes. */
export function scanTimelineSource(source: string): TimelineSourceDocument {
  const lines = [...scanTimelineSourceLines(source)];
  const statements: TimelineSourceStatement[] = [];
  for (let index = 0; index < lines.length; index++) {
    const first = lines[index]!;
    let last = first;
    let kind = classify(first.raw);
    let complete = true;
    if (index === 0 && first.raw.trim() === "---") {
      kind = "frontmatter";
      complete = false;
      while (++index < lines.length) {
        last = lines[index]!;
        if (last.raw.trim() === "---") {
          complete = true;
          break;
        }
      }
    } else if (
      kind === "directive" ||
      (kind === "accessibility-description" &&
        /^\s*accDescr\s*\{/i.test(first.raw))
    ) {
      const close = kind === "directive" ? "}%%" : "}";
      complete = first.raw.includes(close);
      while (!complete && index + 1 < lines.length) {
        last = lines[++index]!;
        complete = last.raw.includes(close);
      }
    }
    let statementEol = last.eol;
    let statementEnd = last.range.end;
    if (
      complete &&
      (kind === "directive" ||
        (kind === "accessibility-description" &&
          /^\s*accDescr\s*\{/i.test(first.raw)))
    ) {
      const close = kind === "directive" ? "}%%" : "}";
      const end = last.raw.indexOf(close) + close.length;
      if (end < last.raw.length) {
        statementEnd = last.range.start + end;
        statementEol = "";
        // The native lexer resumes after the closing token, even on the same physical line.
        lines.splice(index + 1, 0, {
          range: { ...last.range, start: statementEnd },
          raw: last.raw.slice(end),
          eol: last.eol,
        });
      }
    }
    const range = {
      ...first.range,
      end: statementEnd,
      endLine: last.range.line,
    };
    const raw = source.slice(range.start, range.end);
    const indent = raw.match(/^[ \t]*/)?.[0] ?? "";
    const offset = (start: number, end: number): TimelineSourceRange => ({
      start: range.start + start,
      end: range.start + end,
      line:
        range.line + (raw.slice(0, start).match(/\r\n|\r|\n/g)?.length ?? 0),
    });
    let valueRange: TimelineSourceRange | undefined;
    const segments: TimelineEventSegment[] = [];
    if (kind === "section" || kind === "title") {
      const start = raw.match(/^\s*\S+\s+/)?.[0].length ?? raw.length;
      const value = trimRange(
        raw,
        start,
        kind === "section" && raw.indexOf(":", start) >= 0
          ? raw.indexOf(":", start)
          : raw.length,
      );
      valueRange = offset(value.start, value.end);
    } else if (
      kind === "accessibility-title" ||
      kind === "accessibility-description"
    ) {
      const opening = raw.search(/[:{]/);
      const value = trimRange(
        raw,
        opening < 0 ? raw.length : opening + 1,
        opening >= 0 && raw[opening] === "{" && complete
          ? raw.lastIndexOf("}")
          : raw.length,
      );
      valueRange = offset(value.start, value.end);
    } else if (kind === "period" || kind === "event") {
      let firstColon = raw.indexOf(":");
      const hash = raw.indexOf("#");
      if (
        kind === "period" &&
        hash >= 0 &&
        (firstColon < 0 || hash < firstColon)
      )
        firstColon = -1;
      if (kind === "period") {
        const hash = raw.indexOf("#");
        const end =
          firstColon >= 0 ? firstColon : hash >= 0 ? hash : raw.length;
        const value = trimRange(raw, 0, end);
        valueRange = offset(value.start, value.end);
      }
      if (firstColon >= 0) {
        // The bound Jison lexer ends an event only at a colon followed by whitespace.
        const tail = raw.slice(firstColon);
        const expression = /:\s(?:[^:\r\n]|:(?!\s))+/g;
        let consumed = 0;
        for (const match of tail.matchAll(expression)) {
          if (
            match.index !== consumed &&
            tail.slice(consumed, match.index).trim()
          )
            break;
          const start = firstColon + match.index!;
          const value = trimRange(raw, start + 2, start + match[0].length);
          segments.push({
            id: nextTimelineIdentity(),
            range: offset(start, start + match[0].length),
            valueRange: offset(value.start, value.end),
            raw: raw.slice(value.start, value.end),
            separator: raw.slice(start, value.start),
          });
          consumed = match.index! + match[0].length;
        }
      }
    }
    if (kind === "section") {
      const firstColon = raw.indexOf(":");
      if (firstColon >= 0) {
        let consumed = firstColon;
        for (const match of raw
          .slice(firstColon)
          .matchAll(/:\s(?:[^:\r\n]|:(?!\s))+/g)) {
          const start = firstColon + match.index!;
          if (raw.slice(consumed, start).trim()) break;
          const value = trimRange(raw, start + 2, start + match[0].length);
          segments.push({
            id: nextTimelineIdentity(),
            range: offset(start, start + match[0].length),
            valueRange: offset(value.start, value.end),
            raw: raw.slice(value.start, value.end),
            separator: raw.slice(start, value.start),
          });
          consumed = start + match[0].length;
        }
      }
    }
    const hash = raw.indexOf("#");
    const colon = raw.indexOf(":");
    if (kind === "period" && hash >= 0 && (colon < 0 || hash < colon)) {
      statements.push({
        id: nextTimelineIdentity(),
        range: { ...range, end: range.start + hash },
        raw: raw.slice(0, hash),
        eol: "",
        kind,
        complete,
        indent,
        valueRange,
        segments,
      });
      statements.push({
        id: nextTimelineIdentity(),
        range: { ...range, start: range.start + hash },
        raw: raw.slice(hash),
        eol: statementEol,
        kind: "comment",
        complete,
        indent: "",
        segments: [],
      });
    } else
      statements.push({
        id: nextTimelineIdentity(),
        range,
        raw,
        eol: statementEol,
        kind,
        complete,
        indent,
        valueRange,
        segments,
      });
    if (!complete) break; // An unterminated block owns the ambiguous remainder.
  }
  return {
    source,
    newline: source.includes("\r\n")
      ? "\r\n"
      : source.includes("\r")
        ? "\r"
        : "\n",
    statements,
  };
}

/** Reserve explicit destinations and unchanged source anchors before rename fallback. */
export function reconcileTimelineSource(
  document: TimelineSourceDocument,
  previous?: TimelineSourceDocument,
  mapping?: TimelineIdentityMapping,
): TimelineSourceDocument {
  if (!previous) return document;
  const reserved = new Set(mapping?.statements.values());
  const used = new Set<string>();
  const old = previous.statements;
  const unchangedOwners = new Map<string, number>();
  const unchangedAt = new Map<number, string>();
  let prefix = 0;
  while (
    prefix < Math.min(document.source.length, previous.source.length) &&
    document.source[prefix] === previous.source[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix <
      Math.min(document.source.length, previous.source.length) - prefix &&
    document.source[document.source.length - suffix - 1] ===
      previous.source[previous.source.length - suffix - 1]
  )
    suffix++;
  const delta = document.source.length - previous.source.length;
  for (const record of document.statements) {
    const candidates = old.filter(
      (item) =>
        !reserved.has(item.id) &&
        item.kind === record.kind &&
        item.raw === record.raw,
    );
    const count = document.statements.filter(
      (item) => item.kind === record.kind && item.raw === record.raw,
    ).length;
    // An unrelated edit may shift repeated records without changing them.
    // Multiplicity changes stay ambiguous unless the writer supplied a mapping.
    const anchored =
      candidates.length === count
        ? candidates.find((item) => {
            const start =
              item.range.end <= prefix
                ? item.range.start
                : item.range.start >= previous.source.length - suffix
                  ? item.range.start + delta
                  : undefined;
            return start === record.range.start;
          })
        : undefined;
    if (anchored) {
      unchangedOwners.set(anchored.id, record.range.start);
      unchangedAt.set(record.range.start, anchored.id);
    } else if (candidates.length === 1 && count === 1)
      unchangedOwners.set(candidates[0]!.id, record.range.start);
  }
  const statements = document.statements.map((record) => {
    const explicit = mapping?.statements.get(record.range.start);
    const available = old.filter(
      (item) =>
        !used.has(item.id) &&
        !reserved.has(item.id) &&
        (!unchangedOwners.has(item.id) ||
          unchangedOwners.get(item.id) === record.range.start) &&
        item.kind === record.kind,
    );
    const exact = available.filter((item) => item.raw === record.raw);
    const atRange = available.filter(
      (item) => item.range.start === record.range.start,
    );
    const previousRecord = explicit
      ? old.find((item) => item.id === explicit)
      : unchangedAt.has(record.range.start)
        ? available.find(
            (item) => item.id === unchangedAt.get(record.range.start),
          )
        : exact.length === 1
          ? exact[0]
          : atRange.length === 1 &&
              (exact.length === 0 || document.source === previous.source)
            ? atRange[0]
            : undefined;
    const id = explicit ?? previousRecord?.id ?? record.id;
    used.add(id);
    const oldSegments = previousRecord?.segments ?? [];
    const segmentReservations = new Set<string>();
    for (const segment of record.segments) {
      const explicitSegment = mapping?.segments.get(segment.range.start);
      if (explicitSegment) segmentReservations.add(explicitSegment);
      const matches = oldSegments.filter((item) => item.raw === segment.raw);
      if (
        matches.length === 1 &&
        record.segments.filter((item) => item.raw === segment.raw).length === 1
      )
        segmentReservations.add(matches[0]!.id);
    }
    const assigned = new Set<string>();
    const segments = record.segments.map((segment, index) => {
      const mapped = mapping?.segments.get(segment.range.start);
      const exactSegments = oldSegments.filter(
        (item) => !assigned.has(item.id) && item.raw === segment.raw,
      );
      const sameSlot = oldSegments[index];
      const match =
        exactSegments.length === 1
          ? exactSegments[0]
          : sameSlot &&
              !assigned.has(sameSlot.id) &&
              !segmentReservations.has(sameSlot.id) &&
              (record.raw === previousRecord?.raw ||
                (record.segments.length === oldSegments.length &&
                  exactSegments.length === 0))
            ? sameSlot
            : undefined;
      const segmentId = mapped ?? match?.id ?? segment.id;
      assigned.add(segmentId);
      return { ...segment, id: segmentId };
    });
    return { ...record, id, segments };
  });
  return { ...document, statements };
}
export type TimelineSourceLine = {
  readonly range: TimelineSourceRange;
  readonly raw: string;
  readonly eol: string;
};

/** Original offsets and EOLs remain authoritative; projection never rewrites them. */
export function scanTimelineSourceLines(
  source: string,
): readonly TimelineSourceLine[] {
  const lines: TimelineSourceLine[] = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  for (const match of source.matchAll(pattern)) {
    if (!match[0] && match.index === source.length && lines.length) break;
    lines.push({
      range: {
        start: match.index!,
        end: match.index! + match[1]!.length,
        line: lines.length + 1,
      },
      raw: match[1]!,
      eol: match[2]!,
    });
  }
  return lines;
}
