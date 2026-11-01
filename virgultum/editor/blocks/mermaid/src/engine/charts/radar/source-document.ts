// SPDX-License-Identifier: AGPL-3.0-or-later

export type MermaidRadarSourceRange = {
  readonly end: number;
  readonly endLine: number;
  readonly start: number;
  readonly startLine: number;
};

export type MermaidRadarQuoteForm = "double" | "single";
export type MermaidRadarValueForm = "detailed" | "mixed" | "positional";

type RadarSourceRecordBase = {
  readonly fingerprint: string;
  id: string;
  readonly range: MermaidRadarSourceRange;
  readonly raw: string;
};

export const MERMAID_RADAR_CONFIG_FIELDS = [
  "useMaxWidth",
  "width",
  "height",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "axisScaleFactor",
  "axisLabelFactor",
  "curveTension",
] as const;

export type MermaidRadarConfigFieldName =
  (typeof MERMAID_RADAR_CONFIG_FIELDS)[number];

export type MermaidRadarConfigField = {
  readonly field: MermaidRadarConfigFieldName;
  readonly range: MermaidRadarSourceRange;
  readonly valueRange: MermaidRadarSourceRange;
};

export type MermaidRadarConfigScope = {
  readonly format: "json" | "yaml";
  readonly indentation: string;
  readonly range: MermaidRadarSourceRange;
};

export type MermaidRadarAxisSource = {
  id?: string;
  readonly labelQuote?: MermaidRadarQuoteForm;
  readonly labelRange?: MermaidRadarSourceRange;
  readonly nameRange: MermaidRadarSourceRange;
  readonly range: MermaidRadarSourceRange;
};

export type MermaidRadarEntrySource = {
  readonly axisNameRange?: MermaidRadarSourceRange;
  readonly colon: boolean;
  id?: string;
  readonly range: MermaidRadarSourceRange;
  readonly valueRange?: MermaidRadarSourceRange;
};

export type MermaidRadarCurveSource = {
  id?: string;
  readonly entries: MermaidRadarEntrySource[];
  readonly form: MermaidRadarValueForm;
  readonly labelQuote?: MermaidRadarQuoteForm;
  readonly labelRange?: MermaidRadarSourceRange;
  readonly nameRange: MermaidRadarSourceRange;
  readonly range: MermaidRadarSourceRange;
};

export type MermaidRadarOptionName =
  "graticule" | "max" | "min" | "showLegend" | "ticks";

export type MermaidRadarOptionSource = {
  readonly name: MermaidRadarOptionName;
  readonly nameRange: MermaidRadarSourceRange;
  readonly range: MermaidRadarSourceRange;
  readonly valid: boolean;
  readonly valueRange: MermaidRadarSourceRange;
};

export type MermaidRadarSourceRecord =
  | (RadarSourceRecordBase & {
      readonly configFields: MermaidRadarConfigField[];
      readonly configScope: MermaidRadarConfigScope | null;
      readonly kind: "directive" | "frontmatter";
    })
  | (RadarSourceRecordBase & { readonly kind: "blank" })
  | (RadarSourceRecordBase & {
      anchorId?: string;
      readonly kind: "comment";
    })
  | (RadarSourceRecordBase & {
      readonly form: "colon" | "plain" | "spaced-colon";
      readonly kind: "header";
    })
  | (RadarSourceRecordBase & {
      readonly field:
        "accessibilityDescription" | "accessibilityTitle" | "title";
      readonly format: "block" | "line";
      readonly kind: "metadata";
      readonly valid: boolean;
      readonly valueRange: MermaidRadarSourceRange;
    })
  | (RadarSourceRecordBase & {
      readonly axes: MermaidRadarAxisSource[];
      readonly kind: "axis";
      readonly valid: boolean;
    })
  | (RadarSourceRecordBase & {
      readonly curves: MermaidRadarCurveSource[];
      readonly kind: "curve";
      readonly valid: boolean;
    })
  | (RadarSourceRecordBase & {
      readonly complete: boolean;
      readonly kind: "options";
      readonly options: MermaidRadarOptionSource[];
      readonly valid: boolean;
    })
  | (RadarSourceRecordBase & { readonly kind: "invalid" });

export type MermaidRadarSourceDocument = {
  readonly endsWithNewline: boolean;
  readonly lines: string[];
  readonly newline: "\n" | "\r" | "\r\n";
  readonly records: MermaidRadarSourceRecord[];
  readonly source: string;
};

export type MermaidRadarLexicalRecord = {
  readonly kind: "directive" | "frontmatter" | "line";
  readonly range: MermaidRadarSourceRange;
  readonly raw: string;
};

export function mermaidRadarFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function mermaidRadarRecordId(
  kind: string,
  fingerprint: string,
  ordinal = 0,
) {
  return `radar-${kind}-${fingerprint}${ordinal ? `-${ordinal}` : ""}`;
}

export function offsetRadarRange(
  record: Pick<MermaidRadarLexicalRecord, "range" | "raw">,
  rawStart: number,
  rawEnd: number,
): MermaidRadarSourceRange {
  const prefix = record.raw.slice(0, rawStart);
  const content = record.raw.slice(rawStart, rawEnd);
  const startLine =
    record.range.startLine + (prefix.match(/\r\n|\r|\n/g)?.length ?? 0);
  return {
    end: record.range.start + rawEnd,
    endLine: startLine + (content.match(/\r\n|\r|\n/g)?.length ?? 0),
    start: record.range.start + rawStart,
    startLine,
  };
}

function sourceNewline(source: string): MermaidRadarSourceDocument["newline"] {
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

/** Separates frontmatter and init directives before family syntax is parsed. */
export function scanMermaidRadarSource(source: string) {
  const starts = lineStarts(source);
  const lines = starts.map((start, line) =>
    source.slice(start, lineEnd(source, starts, line)),
  );
  const lexicalRecords: MermaidRadarLexicalRecord[] = [];
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
      range: { end, endLine: exclusiveEnd - 1, start: 0, startLine: 0 },
      raw: source.slice(0, end),
    });
    line = exclusiveEnd;
  }
  while (line < lines.length) {
    if (lines[line].trim().startsWith("%%{")) {
      const startLine = line;
      let endLine = line;
      while (endLine < lines.length && !lines[endLine].includes("}%%"))
        endLine += 1;
      const exclusiveEnd = Math.min(lines.length, endLine + 1);
      const start = starts[startLine];
      const end =
        exclusiveEnd < starts.length ? starts[exclusiveEnd] : source.length;
      lexicalRecords.push({
        kind: "directive",
        range: { end, endLine, start, startLine },
        raw: source.slice(start, end),
      });
      line = exclusiveEnd;
      continue;
    }
    const start = starts[line];
    lexicalRecords.push({
      kind: "line",
      range: {
        end: lineEnd(source, starts, line),
        endLine: line,
        start,
        startLine: line,
      },
      raw: lines[line],
    });
    line += 1;
  }
  return {
    endsWithNewline: /\r\n$|\r$|\n$/.test(source),
    lexicalRecords,
    lines,
    newline: sourceNewline(source),
  };
}

export function radarRangeAtEnd(
  document: Pick<MermaidRadarSourceDocument, "lines" | "source">,
): MermaidRadarSourceRange {
  const line = Math.max(0, document.lines.length - 1);
  return {
    end: document.source.length,
    endLine: line,
    start: document.source.length,
    startLine: line,
  };
}

function configPattern(field: MermaidRadarConfigFieldName) {
  return new RegExp(
    `(?<![\\w])["']?${field}["']?\\s*:\\s*((?:true|false|-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))(?=\\s*(?:[,}\\r\\n#]|$))|[^\\s,}\\r\\n#]+)`,
    "gi",
  );
}

function objectEnd(raw: string, start: number) {
  let depth = 0;
  let quote = "";
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote) {
      if (character === quote && raw[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index + 1;
  }
  return -1;
}

function objectScope(raw: string, requireConfigParent: boolean) {
  let searchStart = 0;
  let searchEnd = raw.length;
  if (requireConfigParent) {
    const config = /["']?config["']?\s*:/i.exec(raw);
    if (!config || config.index === undefined) return null;
    const configStart = raw.indexOf("{", config.index + config[0].length);
    if (configStart < 0) return null;
    const configEnd = objectEnd(raw, configStart);
    if (configEnd < 0) return null;
    searchStart = configStart + 1;
    searchEnd = configEnd - 1;
  }
  const scoped = raw.slice(searchStart, searchEnd);
  const key = /["']?radar["']?\s*:/i.exec(scoped);
  if (!key || key.index === undefined) return null;
  const start = raw.indexOf("{", searchStart + key.index + key[0].length);
  if (start < 0 || start >= searchEnd) return null;
  const end = objectEnd(raw, start);
  return end < 0 || end > searchEnd + 1
    ? null
    : {
        end,
        format: "json" as const,
        indentation: "",
        start,
      };
}

function yamlScope(raw: string, requireConfigParent: boolean) {
  const starts = lineStarts(raw);
  const lines = starts.map((start, index) =>
    raw.slice(start, lineEnd(raw, starts, index)),
  );
  let firstLine = 0;
  let lastLine = lines.length;
  if (requireConfigParent) {
    const configIndex = lines.findIndex((line) =>
      /^(\s*)config\s*:/i.test(line),
    );
    if (configIndex < 0) return null;
    const configIndent = lines[configIndex].match(/^\s*/)?.[0].length ?? 0;
    firstLine = configIndex + 1;
    lastLine = lines.findIndex(
      (line, index) =>
        index > configIndex &&
        Boolean(line.trim()) &&
        (line.match(/^\s*/)?.[0].length ?? 0) <= configIndent,
    );
    if (lastLine < 0) lastLine = lines.length;
  }
  for (let index = firstLine; index < lastLine; index += 1) {
    const line = lines[index];
    const match = /^(\s*)radar\s*:/i.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    let end = lineEnd(raw, starts, index);
    for (const [relativeIndex, next] of lines.slice(index + 1).entries()) {
      const nextIndent = next.match(/^\s*/)?.[0].length ?? 0;
      if (next.trim() && nextIndent <= indent) break;
      end = lineEnd(raw, starts, index + relativeIndex + 1);
    }
    return {
      end,
      format: "yaml" as const,
      indentation: `${match[1]}  `,
      start: starts[index],
    };
  }
  return null;
}

export function radarConfigFieldRanges(
  record: MermaidRadarLexicalRecord,
): MermaidRadarConfigField[] {
  const requireConfigParent = record.kind === "frontmatter";
  const scopeRange =
    objectScope(record.raw, requireConfigParent) ??
    yamlScope(record.raw, requireConfigParent);
  if (!scopeRange) return [];
  const scope = record.raw.slice(scopeRange.start, scopeRange.end);
  return MERMAID_RADAR_CONFIG_FIELDS.flatMap((field) =>
    Array.from(scope.matchAll(configPattern(field))).flatMap((match) => {
      if (match.index === undefined) return [];
      const start = scopeRange.start + match.index;
      const captured = match[1];
      const capturedStart = match[0].lastIndexOf(captured);
      const valueStart = start + capturedStart;
      return [
        {
          field,
          range: offsetRadarRange(record, start, start + match[0].length),
          valueRange: offsetRadarRange(
            record,
            valueStart,
            valueStart + captured.length,
          ),
        },
      ];
    }),
  ).sort((left, right) => left.range.start - right.range.start);
}

export function radarConfigScope(
  record: MermaidRadarLexicalRecord,
): MermaidRadarConfigScope | null {
  const requireConfigParent = record.kind === "frontmatter";
  const scope =
    objectScope(record.raw, requireConfigParent) ??
    yamlScope(record.raw, requireConfigParent);
  return scope
    ? {
        format: scope.format,
        indentation: scope.indentation,
        range: offsetRadarRange(record, scope.start, scope.end),
      }
    : null;
}
