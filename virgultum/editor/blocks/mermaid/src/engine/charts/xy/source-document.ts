// SPDX-License-Identifier: AGPL-3.0-or-later

export type MermaidXySourceRange = {
  end: number;
  endLine: number;
  start: number;
  startLine: number;
};

export type MermaidXyTextForm = "markdown" | "plain" | "quoted";
export type MermaidXyHeaderForm = "xychart" | "xychart-beta";
export type MermaidXyOrientation = "horizontal" | "vertical";
export type MermaidXyXAxisSourceForm =
  "band" | "linear" | "omitted" | "title-only";

type SourceRecordBase = {
  fingerprint: string;
  id: string;
  range: MermaidXySourceRange;
  raw: string;
};

export const MERMAID_XY_CONFIG_FIELDS = [
  "useMaxWidth",
  "width",
  "height",
  "showTitle",
  "titleFontSize",
  "titlePadding",
  "showDataLabel",
  "showDataLabelOutsideBar",
  "chartOrientation",
  "plotReservedSpacePercent",
  "xAxis.showLabel",
  "xAxis.labelFontSize",
  "xAxis.labelPadding",
  "xAxis.showTitle",
  "xAxis.titleFontSize",
  "xAxis.titlePadding",
  "xAxis.showTick",
  "xAxis.tickLength",
  "xAxis.tickWidth",
  "xAxis.showAxisLine",
  "xAxis.axisLineWidth",
  "xAxis.labelRotation",
  "yAxis.showLabel",
  "yAxis.labelFontSize",
  "yAxis.labelPadding",
  "yAxis.showTitle",
  "yAxis.titleFontSize",
  "yAxis.titlePadding",
  "yAxis.showTick",
  "yAxis.tickLength",
  "yAxis.tickWidth",
  "yAxis.showAxisLine",
  "yAxis.axisLineWidth",
  "yAxis.labelRotation",
] as const;

export type MermaidXyConfigFieldName =
  (typeof MERMAID_XY_CONFIG_FIELDS)[number];

export type MermaidXyConfigField = {
  field: MermaidXyConfigFieldName;
  range: MermaidXySourceRange;
  valueRange: MermaidXySourceRange;
};

export type MermaidXyPointSource = {
  id?: string;
  labelForm?: MermaidXyTextForm;
  labelRange?: MermaidXySourceRange;
  range: MermaidXySourceRange;
  valueRange: MermaidXySourceRange;
};

export type MermaidXyCategorySource = {
  id?: string;
  range: MermaidXySourceRange;
  textForm: MermaidXyTextForm;
};

export type MermaidXySourceRecord =
  | (SourceRecordBase & {
      configFields: MermaidXyConfigField[];
      kind: "directive" | "frontmatter";
    })
  | (SourceRecordBase & { kind: "blank" })
  | (SourceRecordBase & { commentId?: string; kind: "comment" })
  | (SourceRecordBase & {
      form: MermaidXyHeaderForm;
      kind: "header";
      orientation?: MermaidXyOrientation;
      orientationRange?: MermaidXySourceRange;
    })
  | (SourceRecordBase & {
      field: "accessibilityDescription" | "accessibilityTitle" | "title";
      format: "block" | "line";
      kind: "metadata";
      textForm: MermaidXyTextForm;
      valid: boolean;
      valueRange: MermaidXySourceRange;
    })
  | (SourceRecordBase & {
      categories: MermaidXyCategorySource[];
      form: MermaidXyXAxisSourceForm;
      inlineCommentId?: string;
      inlineCommentRange?: MermaidXySourceRange;
      kind: "x-axis";
      maximumRange?: MermaidXySourceRange;
      minimumRange?: MermaidXySourceRange;
      titleForm?: MermaidXyTextForm;
      titleRange?: MermaidXySourceRange;
      valid: boolean;
    })
  | (SourceRecordBase & {
      inlineCommentId?: string;
      inlineCommentRange?: MermaidXySourceRange;
      kind: "y-axis";
      maximumRange?: MermaidXySourceRange;
      minimumRange?: MermaidXySourceRange;
      titleForm?: MermaidXyTextForm;
      titleRange?: MermaidXySourceRange;
      valid: boolean;
    })
  | (SourceRecordBase & {
      inlineCommentId?: string;
      inlineCommentRange?: MermaidXySourceRange;
      kind: "plot";
      plotId?: string;
      plotKind: "bar" | "line";
      points: MermaidXyPointSource[];
      titleForm?: MermaidXyTextForm;
      titleRange?: MermaidXySourceRange;
      valid: boolean;
    })
  | (SourceRecordBase & { kind: "invalid" });

export type MermaidXySourceDocument = {
  endsWithNewline: boolean;
  lines: string[];
  newline: "\n" | "\r" | "\r\n";
  records: MermaidXySourceRecord[];
  source: string;
};

export type MermaidXyLexicalRecord = {
  kind: "directive" | "frontmatter" | "line";
  range: MermaidXySourceRange;
  raw: string;
};

export function mermaidXyFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Mirrors the text tokens accepted by Mermaid 11.16.1's XY lexer. */
export function mermaidXyTextFitsForm(text: string, form: MermaidXyTextForm) {
  if (/\r|\n/.test(text)) return false;
  if (form === "quoted") return !text.includes('"');
  if (form === "markdown") return !text.includes("`") && !text.includes('"');
  return /^[A-Za-z0-9_+\-=*.#&\s]*$/.test(text);
}

export function mermaidXyRecordId(
  kind: string,
  fingerprint: string,
  ordinal = 0,
) {
  return `xy-${kind}-${fingerprint}${ordinal ? `-${ordinal}` : ""}`;
}

export function offsetXyRange(
  record: Pick<MermaidXyLexicalRecord, "range" | "raw">,
  rawStart: number,
  rawEnd: number,
): MermaidXySourceRange {
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

function sourceNewline(source: string): MermaidXySourceDocument["newline"] {
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

export function scanMermaidXySource(source: string) {
  const starts = lineStarts(source);
  const lines = starts.map((start, line) =>
    source.slice(start, lineEnd(source, starts, line)),
  );
  const lexicalRecords: MermaidXyLexicalRecord[] = [];
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
    const trimmedLine = rawLine.trimStart();
    const directiveColumn = rawLine.length - trimmedLine.length;
    if (trimmedLine.startsWith("%%{")) {
      const start = starts[line];
      let endLine = line;
      let end = -1;
      while (endLine < lines.length) {
        const closeColumn = lines[endLine].indexOf(
          "}%%",
          endLine === line ? directiveColumn + 3 : 0,
        );
        if (closeColumn >= 0) {
          end = lineEnd(source, starts, endLine);
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
        range: { end, endLine: endLine + 1, start, startLine: line },
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
      records: [] as MermaidXySourceRecord[],
      source,
    },
    lexicalRecords,
  };
}

function configPattern(field: MermaidXyConfigFieldName) {
  const leaf = field.includes(".")
    ? field.slice(field.indexOf(".") + 1)
    : field;
  return new RegExp(
    `\\b${leaf}\\b["']?[\\t ]*:[\\t ]*("[^"]*"|'[^']*'|[^,}\\r\\n]+)`,
    "g",
  );
}

function objectScope(raw: string, name: "xyChart" | "xAxis" | "yAxis") {
  const key = new RegExp(`["']?${name}["']?\\s*:`, "i").exec(raw);
  if (!key || key.index === undefined) return null;
  const start = raw.indexOf("{", key.index + key[0].length);
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '"' && raw[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0)
      return { end: index + 1, start };
  }
  return null;
}

function yamlScope(raw: string, name: "xyChart" | "xAxis" | "yAxis") {
  const starts = lineStarts(raw);
  const lines = starts.map((start, index) =>
    raw.slice(start, lineEnd(raw, starts, index)),
  );
  for (const [index, line] of lines.entries()) {
    const match = new RegExp(`^(\\s*)${name}\\s*:`, "i").exec(line);
    if (!match) continue;
    const indent = match[1].length;
    let end = lineEnd(raw, starts, index);
    for (const [relativeIndex, next] of lines.slice(index + 1).entries()) {
      const nextIndent = next.match(/^\s*/)?.[0].length ?? 0;
      if (next.trim() && nextIndent <= indent) break;
      end = lineEnd(raw, starts, index + relativeIndex + 1);
    }
    return { end, start: starts[index] };
  }
  return null;
}

export function xyConfigFieldRanges(
  record: MermaidXyLexicalRecord,
): MermaidXyConfigField[] {
  const fields: MermaidXyConfigField[] = [];
  const chartScope =
    objectScope(record.raw, "xyChart") ?? yamlScope(record.raw, "xyChart");
  if (!chartScope) return fields;
  const chartRaw = record.raw.slice(chartScope.start, chartScope.end);
  const axisScopes = {
    xAxis: objectScope(chartRaw, "xAxis") ?? yamlScope(chartRaw, "xAxis"),
    yAxis: objectScope(chartRaw, "yAxis") ?? yamlScope(chartRaw, "yAxis"),
  };
  for (const axis of ["xAxis", "yAxis"] as const) {
    if (!axisScopes[axis]) continue;
    axisScopes[axis] = {
      end: chartScope.start + axisScopes[axis]!.end,
      start: chartScope.start + axisScopes[axis]!.start,
    };
  }
  for (const field of MERMAID_XY_CONFIG_FIELDS) {
    const axis = field.startsWith("xAxis.")
      ? "xAxis"
      : field.startsWith("yAxis.")
        ? "yAxis"
        : null;
    const scopeRange = axis ? axisScopes[axis] : chartScope;
    if (!scopeRange) continue;
    const scope = record.raw.slice(scopeRange.start, scopeRange.end);
    for (const match of scope.matchAll(configPattern(field))) {
      if (match.index === undefined) continue;
      const start = scopeRange.start + match.index;
      if (
        !axis &&
        Object.values(axisScopes).some(
          (candidate) =>
            candidate && start >= candidate.start && start < candidate.end,
        )
      )
        continue;
      const captured = match[1];
      const trimmed = captured.trim();
      const capturedStart = match[0].lastIndexOf(captured);
      const leading = captured.length - captured.trimStart().length;
      const quoted =
        trimmed.length >= 2 &&
        ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
          (trimmed.startsWith("'") && trimmed.endsWith("'")));
      const valueStart = start + capturedStart + leading + (quoted ? 1 : 0);
      const valueLength = trimmed.length - (quoted ? 2 : 0);
      fields.push({
        field,
        range: offsetXyRange(record, start, start + match[0].length),
        valueRange: offsetXyRange(record, valueStart, valueStart + valueLength),
      });
    }
  }
  return fields.sort((left, right) => left.range.start - right.range.start);
}

export function reconcileMermaidXyRecordIdentities(
  records: MermaidXySourceRecord[],
  previous?: MermaidXySourceDocument,
) {
  if (!previous) return;
  const unused = new Set(previous.records.map((record) => record.id));
  const matched = new Set<MermaidXySourceRecord>();
  const adopt = (
    record: MermaidXySourceRecord,
    candidate: MermaidXySourceRecord,
  ) => {
    unused.delete(candidate.id);
    matched.add(record);
    record.id = candidate.id;
    if (record.kind === "comment" && candidate.kind === "comment")
      record.commentId = candidate.commentId;
  };

  for (const record of records) {
    const candidates = previous.records.filter(
      (candidate) =>
        unused.has(candidate.id) &&
        candidate.kind === record.kind &&
        candidate.fingerprint === record.fingerprint,
    );
    const currentCount = records.filter(
      (candidate) =>
        candidate.kind === record.kind &&
        candidate.fingerprint === record.fingerprint,
    ).length;
    if (candidates.length === 1 && currentCount === 1)
      adopt(record, candidates[0]);
  }

  for (const record of records) {
    if (matched.has(record)) continue;
    const sameKindCardinality =
      records.filter((candidate) => candidate.kind === record.kind).length ===
      previous.records.filter((candidate) => candidate.kind === record.kind)
        .length;
    if (!sameKindCardinality) continue;
    const candidates = previous.records.filter(
      (candidate) =>
        unused.has(candidate.id) &&
        candidate.kind === record.kind &&
        candidate.range.start === record.range.start,
    );
    if (candidates.length === 1) adopt(record, candidates[0]);
  }

  // Preserve duplicate records around an insertion/deletion by their ordered
  // source neighbourhood. Unique fingerprints above already cover true moves;
  // this LCS pass only resolves the remaining ordered anchors.
  for (const kind of new Set(records.map((record) => record.kind))) {
    const current = records.filter(
      (record) => record.kind === kind && !matched.has(record),
    );
    const prior = previous.records.filter(
      (record) => record.kind === kind && unused.has(record.id),
    );
    const lengths = Array.from({ length: current.length + 1 }, () =>
      Array.from({ length: prior.length + 1 }, () => 0),
    );
    for (let left = current.length - 1; left >= 0; left -= 1) {
      for (let right = prior.length - 1; right >= 0; right -= 1) {
        lengths[left][right] =
          current[left].fingerprint === prior[right].fingerprint
            ? lengths[left + 1][right + 1] + 1
            : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
      }
    }
    let left = 0;
    let right = 0;
    while (left < current.length && right < prior.length) {
      if (current[left].fingerprint === prior[right].fingerprint) {
        adopt(current[left], prior[right]);
        left += 1;
        right += 1;
      } else if (lengths[left + 1][right] >= lengths[left][right + 1]) {
        left += 1;
      } else {
        right += 1;
      }
    }
  }

  for (const kind of new Set(records.map((record) => record.kind))) {
    const current = records.filter(
      (record) => record.kind === kind && !matched.has(record),
    );
    const prior = previous.records.filter(
      (record) => record.kind === kind && unused.has(record.id),
    );
    if (current.length !== prior.length) continue;
    current.forEach((record, index) => adopt(record, prior[index]));
  }
}
