// SPDX-License-Identifier: AGPL-3.0-or-later

export type MermaidQuadrantSourceRange = {
  end: number;
  endLine: number;
  start: number;
  startLine: number;
};

export type MermaidQuadrantTextForm = "markdown" | "plain" | "quoted";
export type MermaidQuadrantAxisForm = "both" | "left-open" | "single";

type MermaidQuadrantSourceRecordBase = {
  fingerprint: string;
  id: string;
  range: MermaidQuadrantSourceRange;
  raw: string;
};

export type MermaidQuadrantConfigField = {
  field:
    | "chartHeight"
    | "chartWidth"
    | "pointLabelFontSize"
    | "pointRadius"
    | "pointTextPadding"
    | "quadrantExternalBorderStrokeWidth"
    | "quadrantInternalBorderStrokeWidth"
    | "quadrantLabelFontSize"
    | "quadrantPadding"
    | "quadrantTextTopPadding"
    | "titleFontSize"
    | "titlePadding"
    | "useMaxWidth"
    | "xAxisLabelFontSize"
    | "xAxisLabelPadding"
    | "xAxisPosition"
    | "yAxisLabelFontSize"
    | "yAxisLabelPadding"
    | "yAxisPosition";
  range: MermaidQuadrantSourceRange;
  valueRange: MermaidQuadrantSourceRange;
};

export type MermaidQuadrantSourceRecord =
  | (MermaidQuadrantSourceRecordBase & {
      configFields: MermaidQuadrantConfigField[];
      kind: "directive" | "frontmatter";
    })
  | (MermaidQuadrantSourceRecordBase & { kind: "blank" })
  | (MermaidQuadrantSourceRecordBase & {
      commentId: string;
      kind: "comment";
    })
  | (MermaidQuadrantSourceRecordBase & { kind: "header" })
  | (MermaidQuadrantSourceRecordBase & {
      field: "accessibilityDescription" | "accessibilityTitle" | "title";
      format: "block" | "line";
      kind: "metadata";
      valid: boolean;
      valueRange: MermaidQuadrantSourceRange;
    })
  | (MermaidQuadrantSourceRecordBase & {
      axis: "x" | "y";
      endRange?: MermaidQuadrantSourceRange;
      form: MermaidQuadrantAxisForm;
      inlineCommentId?: string;
      inlineCommentRange?: MermaidQuadrantSourceRange;
      kind: "axis";
      startRange: MermaidQuadrantSourceRange;
    })
  | (MermaidQuadrantSourceRecordBase & {
      inlineCommentId?: string;
      inlineCommentRange?: MermaidQuadrantSourceRange;
      kind: "quadrant";
      quadrant: 1 | 2 | 3 | 4;
      textForm: MermaidQuadrantTextForm;
      textRange: MermaidQuadrantSourceRange;
    })
  | (MermaidQuadrantSourceRecordBase & {
      classNameRange?: MermaidQuadrantSourceRange;
      inlineCommentId?: string;
      inlineCommentRange?: MermaidQuadrantSourceRange;
      kind: "point";
      labelForm: MermaidQuadrantTextForm;
      labelRange: MermaidQuadrantSourceRange;
      pointId?: string;
      stylesRange?: MermaidQuadrantSourceRange;
      xRange: MermaidQuadrantSourceRange;
      yRange: MermaidQuadrantSourceRange;
    })
  | (MermaidQuadrantSourceRecordBase & {
      classDefId?: string;
      classNameRange: MermaidQuadrantSourceRange;
      inlineCommentId?: string;
      inlineCommentRange?: MermaidQuadrantSourceRange;
      kind: "classDef";
      stylesRange: MermaidQuadrantSourceRange;
    })
  | (MermaidQuadrantSourceRecordBase & { kind: "invalid" });

export type MermaidQuadrantSourceDocument = {
  endsWithNewline: boolean;
  lines: string[];
  newline: "\n" | "\r" | "\r\n";
  records: MermaidQuadrantSourceRecord[];
  source: string;
};

export type MermaidQuadrantLexicalRecord = {
  kind: "directive" | "frontmatter" | "line";
  range: MermaidQuadrantSourceRange;
  raw: string;
};

export function mermaidQuadrantFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function mermaidQuadrantRecordId(
  kind: string,
  fingerprint: string,
  ordinal = 0,
) {
  return `quadrant-${kind}-${fingerprint}${ordinal ? `-${ordinal}` : ""}`;
}

function sourceNewline(
  source: string,
): MermaidQuadrantSourceDocument["newline"] {
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

export function offsetQuadrantRange(
  record:
    | MermaidQuadrantLexicalRecord
    | Pick<MermaidQuadrantSourceRecord, "range" | "raw">,
  rawStart: number,
  rawEnd: number,
): MermaidQuadrantSourceRange {
  const prefix = record.raw.slice(0, rawStart);
  const content = record.raw.slice(rawStart, rawEnd);
  const startLine =
    record.range.startLine + (prefix.match(/\r\n|\r|\n/g)?.length ?? 0);
  return {
    end: record.range.start + rawEnd,
    endLine: startLine + (content.match(/\r\n|\r|\n/g)?.length ?? 0) + 1,
    start: record.range.start + rawStart,
    startLine,
  };
}

export function scanMermaidQuadrantSource(source: string) {
  const starts = lineStarts(source);
  const lines = starts.map((start, line) =>
    source.slice(start, lineEnd(source, starts, line)),
  );
  const lexicalRecords: MermaidQuadrantLexicalRecord[] = [];
  let line = 0;

  if (lines[0]?.trim() === "---") {
    const endLine = lines.findIndex(
      (candidate, index) => index > 0 && candidate.trim() === "---",
    );
    const exclusiveEnd = endLine < 0 ? lines.length : endLine + 1;
    const end =
      exclusiveEnd < starts.length ? starts[exclusiveEnd] : source.length;
    lexicalRecords.push({
      kind: "frontmatter",
      range: { end, endLine: exclusiveEnd, start: 0, startLine: 0 },
      raw: source.slice(0, end),
    });
    line = exclusiveEnd;
  }

  while (line < lines.length) {
    const rawLine = lines[line] ?? "";
    const directiveColumn = rawLine.indexOf("%%{");
    if (directiveColumn >= 0) {
      const start = starts[line] + directiveColumn;
      let endLine = line;
      let end = -1;
      while (endLine < lines.length) {
        const closeColumn = lines[endLine].indexOf(
          "}%%",
          endLine === line ? directiveColumn + 3 : 0,
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
      lexicalRecords.push({
        kind: "directive",
        range: {
          end,
          endLine: endLine + 1,
          start,
          startLine: line,
        },
        raw: source.slice(start, end),
      });
      line = endLine + 1;
      continue;
    }
    const start = starts[line];
    const end = lineEnd(source, starts, line);
    lexicalRecords.push({
      kind: "line",
      range: { end, endLine: line + 1, start, startLine: line },
      raw: source.slice(start, end),
    });
    line += 1;
  }

  return {
    document: {
      endsWithNewline: /(?:\r\n|\r|\n)$/.test(source),
      lines,
      newline: sourceNewline(source),
      records: [] as MermaidQuadrantSourceRecord[],
      source,
    },
    lexicalRecords,
  };
}

const CONFIG_FIELDS = [
  "useMaxWidth",
  "chartWidth",
  "chartHeight",
  "titleFontSize",
  "titlePadding",
  "quadrantPadding",
  "xAxisLabelPadding",
  "yAxisLabelPadding",
  "xAxisLabelFontSize",
  "yAxisLabelFontSize",
  "quadrantLabelFontSize",
  "quadrantTextTopPadding",
  "pointTextPadding",
  "pointLabelFontSize",
  "pointRadius",
  "xAxisPosition",
  "yAxisPosition",
  "quadrantInternalBorderStrokeWidth",
  "quadrantExternalBorderStrokeWidth",
] as const;

export function quadrantConfigFieldRanges(
  record: MermaidQuadrantLexicalRecord,
): MermaidQuadrantConfigField[] {
  const names = CONFIG_FIELDS.join("|");
  const pattern = new RegExp(
    `\\b(${names})\\b["']?[\\t ]*:[\\t ]*(true|false|top|bottom|left|right|-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))`,
    "g",
  );
  return [...record.raw.matchAll(pattern)].flatMap((match) => {
    if (match.index === undefined) return [];
    const valueStart = match.index + match[0].lastIndexOf(match[2]);
    return [
      {
        field: match[1] as MermaidQuadrantConfigField["field"],
        range: offsetQuadrantRange(
          record,
          match.index,
          match.index + match[0].length,
        ),
        valueRange: offsetQuadrantRange(
          record,
          valueStart,
          valueStart + match[2].length,
        ),
      },
    ];
  });
}

type IdentifiableRecord = MermaidQuadrantSourceRecord & {
  fingerprint: string;
  id: string;
};

/**
 * Reuses identities by semantic record kind and exact raw fingerprint. The
 * nearest prior ordinal disambiguates duplicate statements; a changed record
 * receives a new identity unless the parser explicitly carries its patched ID.
 */
export function reconcileQuadrantRecordIdentities(
  records: MermaidQuadrantSourceRecord[],
  previous?: MermaidQuadrantSourceDocument,
) {
  if (!previous) return records;
  const used = new Set<string>();
  const available = new Map<string, IdentifiableRecord[]>();
  for (const record of previous.records) {
    const key = `${record.kind}:${record.fingerprint}`;
    const candidates = available.get(key) ?? [];
    candidates.push(record as IdentifiableRecord);
    available.set(key, candidates);
  }
  for (const record of records) {
    const key = `${record.kind}:${record.fingerprint}`;
    const candidate = available.get(key)?.shift();
    if (!candidate) continue;
    used.add(candidate.id);
    record.id = candidate.id;
    if (record.kind === "point" && candidate.kind === "point") {
      record.pointId = candidate.pointId;
    } else if (record.kind === "classDef" && candidate.kind === "classDef") {
      record.classDefId = candidate.classDefId;
    } else if (record.kind === "comment" && candidate.kind === "comment") {
      record.commentId = candidate.commentId;
    }
  }

  const semanticKinds = new Set([
    "axis",
    "classDef",
    "comment",
    "metadata",
    "point",
    "quadrant",
  ]);
  const previousSemantic = previous.records.filter((record) =>
    semanticKinds.has(record.kind),
  );
  const currentSemantic = records.filter((record) =>
    semanticKinds.has(record.kind),
  );
  currentSemantic.forEach((record, currentIndex) => {
    if (used.has(record.id)) return;
    const candidates = previousSemantic.filter(
      (candidate) => candidate.kind === record.kind && !used.has(candidate.id),
    );
    if (!candidates.length) return;
    const before = currentSemantic[currentIndex - 1]?.fingerprint;
    const after = currentSemantic[currentIndex + 1]?.fingerprint;
    const scored = candidates
      .map((candidate) => {
        const previousIndex = previousSemantic.indexOf(candidate);
        let score = 0;
        if (
          before &&
          previousSemantic[previousIndex - 1]?.fingerprint === before
        )
          score += 4;
        if (after && previousSemantic[previousIndex + 1]?.fingerprint === after)
          score += 4;
        score -= Math.abs(currentIndex - previousIndex) / 1000;
        return { candidate, score };
      })
      .sort((left, right) => right.score - left.score);
    const winner = scored[0];
    const tied = scored[1] && scored[1].score === winner.score;
    if (!winner || tied || (candidates.length > 1 && winner.score <= 0)) return;
    used.add(winner.candidate.id);
    record.id = winner.candidate.id;
    if (record.kind === "point" && winner.candidate.kind === "point") {
      record.pointId = winner.candidate.pointId;
    } else if (
      record.kind === "classDef" &&
      winner.candidate.kind === "classDef"
    ) {
      record.classDefId = winner.candidate.classDefId;
    } else if (
      record.kind === "comment" &&
      winner.candidate.kind === "comment"
    ) {
      record.commentId = winner.candidate.commentId;
    }
  });
  return records;
}
