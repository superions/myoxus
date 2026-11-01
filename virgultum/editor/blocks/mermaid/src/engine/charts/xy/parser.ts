// SPDX-License-Identifier: AGPL-3.0-or-later

import { hashMermaidSource } from "../../../utils.js";
import { validMermaidXyConfigFieldValue } from "./commands/appearance.js";
import {
  createMermaidXyDiagnostic,
  type MermaidXyDiagnostic,
} from "./diagnostics.js";
import {
  DEFAULT_MERMAID_XY_CONFIG,
  refreshMermaidXyIdentityArchive,
  type MermaidXyCategory,
  type MermaidXyChildIdentity,
  type MermaidXyComment,
  type MermaidXyConfig,
  type MermaidXyModel,
  type MermaidXyPlot,
  type MermaidXyPoint,
} from "./model.js";
import {
  mermaidXyFingerprint,
  mermaidXyRecordId,
  mermaidXyTextFitsForm,
  offsetXyRange,
  reconcileMermaidXyRecordIdentities,
  scanMermaidXySource,
  xyConfigFieldRanges,
  type MermaidXyLexicalRecord,
  type MermaidXySourceRange,
  type MermaidXySourceRecord,
  type MermaidXyTextForm,
} from "./source-document.js";

export type MermaidXyParseResult =
  { diagnostic: MermaidXyDiagnostic; model: null } | { model: MermaidXyModel };

const NUMBER_SOURCE = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const HEADER_RE =
  /^\s*(xychart(?:-beta)?)(?:\s+(horizontal|vertical))?\s*;?\s*$/i;
const TITLE_RE = /^\s*title\s+(.+?)\s*;?\s*$/i;
const ACC_TITLE_RE = /^\s*accTitle\s*:\s*(.*?)\s*$/i;
const ACC_DESCR_RE = /^\s*accDescr\s*:\s*(.*?)\s*$/i;

function recordIdentity(
  kind: MermaidXySourceRecord["kind"],
  lexical: MermaidXyLexicalRecord,
  occurrences: Map<string, number>,
) {
  const fingerprint = mermaidXyFingerprint(lexical.raw);
  const key = `${kind}:${fingerprint}`;
  const ordinal = occurrences.get(key) ?? 0;
  occurrences.set(key, ordinal + 1);
  return {
    fingerprint,
    id: mermaidXyRecordId(kind, fingerprint, ordinal),
    range: lexical.range,
    raw: lexical.raw,
  };
}

function matchingRange(
  lexical: MermaidXyLexicalRecord,
  value: string,
  from = 0,
) {
  const index = lexical.raw.indexOf(value, from);
  return offsetXyRange(
    lexical,
    Math.max(0, index),
    Math.max(0, index) + value.length,
  );
}

function capturedRange(
  lexical: MermaidXyLexicalRecord,
  match: RegExpExecArray,
  capture: string,
) {
  const start = (match.index ?? 0) + match[0].lastIndexOf(capture);
  return offsetXyRange(lexical, start, start + capture.length);
}

export function decodeMermaidXyText(raw: string): {
  form: MermaidXyTextForm;
  text: string;
} {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return { form: "quoted", text: value.slice(1, -1) };
  }
  if (value.startsWith("`") && value.endsWith("`") && value.length >= 2) {
    return { form: "markdown", text: value.slice(1, -1) };
  }
  return { form: "plain", text: value };
}

export function encodeMermaidXyText(text: string, form: MermaidXyTextForm) {
  if (form === "quoted") return `"${text}"`;
  if (form === "markdown") return `\`${text}\``;
  return text;
}

function splitInlineComment(raw: string) {
  let quoted = false;
  let markdown = false;
  for (let index = 0; index < raw.length - 1; index += 1) {
    const character = raw[index];
    if (character === '"' && !markdown) quoted = !quoted;
    else if (character === "`" && !quoted) markdown = !markdown;
    else if (!quoted && !markdown && raw.slice(index, index + 2) === "%%") {
      return {
        comment: raw.slice(index + 2).trim(),
        commentStart: index,
        syntax: raw.slice(0, index).trimEnd(),
      };
    }
  }
  return { comment: "", commentStart: -1, syntax: raw };
}

function splitList(raw: string) {
  const items: Array<{ end: number; raw: string; start: number }> = [];
  let start = 0;
  let quoted = false;
  let markdown = false;
  for (let index = 0; index <= raw.length; index += 1) {
    const character = raw[index];
    if (character === '"' && !markdown) quoted = !quoted;
    else if (character === "`" && !quoted) markdown = !markdown;
    if ((character === "," && !quoted && !markdown) || index === raw.length) {
      const segment = raw.slice(start, index);
      const leading = segment.match(/^\s*/)?.[0].length ?? 0;
      const trailing = segment.match(/\s*$/)?.[0].length ?? 0;
      items.push({
        end: index - trailing,
        raw: segment.trim(),
        start: start + leading,
      });
      start = index + 1;
    }
  }
  return quoted || markdown || items.some((item) => !item.raw) ? null : items;
}

function bracketBody(syntax: string) {
  let quoted = false;
  let markdown = false;
  let start = -1;
  let end = -1;
  for (let index = 0; index < syntax.length; index += 1) {
    const character = syntax[index];
    if (character === '"' && !markdown) quoted = !quoted;
    else if (character === "`" && !quoted) markdown = !markdown;
    else if (!quoted && !markdown && character === "[") {
      if (start >= 0) return null;
      start = index;
    } else if (!quoted && !markdown && character === "]") {
      if (start < 0 || end >= 0) return null;
      end = index;
    }
  }
  if (
    quoted ||
    markdown ||
    start < 0 ||
    end < start ||
    syntax
      .slice(end + 1)
      .replace(/;\s*$/, "")
      .trim()
  ) {
    return null;
  }
  return { body: syntax.slice(start + 1, end), end, start };
}

function textIsValid(raw: string) {
  const value = raw.trim();
  if (!value) return true;
  const decoded = decodeMermaidXyText(value);
  if (decoded.form === "quoted" && !/^"[^"]*"$/.test(value)) return false;
  if (decoded.form === "markdown" && !/^`[^`]*`$/.test(value)) return false;
  return mermaidXyTextFitsForm(decoded.text, decoded.form);
}

function metadataRecord(
  lexical: MermaidXyLexicalRecord,
  occurrences: Map<string, number>,
): Extract<MermaidXySourceRecord, { kind: "metadata" }> | null {
  const title = TITLE_RE.exec(lexical.raw);
  const accTitle = ACC_TITLE_RE.exec(lexical.raw);
  const accDescr = ACC_DESCR_RE.exec(lexical.raw);
  const match = title ?? accTitle ?? accDescr;
  if (!match) return null;
  const field = title
    ? "title"
    : accTitle
      ? "accessibilityTitle"
      : "accessibilityDescription";
  const decoded = decodeMermaidXyText(match[1]);
  return {
    ...recordIdentity("metadata", lexical, occurrences),
    field,
    format: "line",
    kind: "metadata",
    textForm: decoded.form,
    valid: Boolean(match[1].trim()) && textIsValid(match[1]),
    valueRange: capturedRange(lexical, match, match[1]),
  };
}

function parseXAxisRecord(
  lexical: MermaidXyLexicalRecord,
  syntax: string,
  occurrences: Map<string, number>,
): Extract<MermaidXySourceRecord, { kind: "x-axis" }> | null {
  const keyword = /^\s*x-axis\b/i.exec(syntax);
  if (!keyword) return null;
  const rawBody = syntax.slice(keyword[0].length).replace(/;\s*$/, "").trim();
  const rawBodyStart = lexical.raw.indexOf(rawBody, keyword[0].length);
  const base = recordIdentity("x-axis", lexical, occurrences);
  const bracket = bracketBody(rawBody);
  if (bracket) {
    const rawTitle = rawBody.slice(0, bracket.start).trim();
    const titleStart = rawTitle ? rawBody.indexOf(rawTitle) : -1;
    const titleRange = rawTitle
      ? offsetXyRange(
          lexical,
          rawBodyStart + titleStart,
          rawBodyStart + titleStart + rawTitle.length,
        )
      : undefined;
    const items = splitList(bracket.body);
    const bodyStart = rawBodyStart + bracket.start + 1;
    const categories = (items ?? []).map((item) => ({
      range: offsetXyRange(
        lexical,
        bodyStart + item.start,
        bodyStart + item.end,
      ),
      textForm: decodeMermaidXyText(item.raw).form,
    }));
    return {
      ...base,
      categories,
      form: "band",
      kind: "x-axis",
      titleForm: rawTitle ? decodeMermaidXyText(rawTitle).form : undefined,
      titleRange,
      valid:
        Boolean(items?.length) &&
        textIsValid(rawTitle) &&
        items!.every((item) => textIsValid(item.raw)),
    };
  }
  const range = new RegExp(
    `^(.*?)(?:\\s+)?(${NUMBER_SOURCE})\\s+-->\\s+(${NUMBER_SOURCE})$`,
  ).exec(rawBody);
  if (range) {
    const rawTitle = range[1].trim();
    const bodyStart = rawBodyStart;
    const arrowStart = rawBody.lastIndexOf("-->");
    const minimumStart = bodyStart + rawBody.lastIndexOf(range[2], arrowStart);
    const maximumStart = bodyStart + rawBody.indexOf(range[3], arrowStart + 3);
    return {
      ...base,
      categories: [],
      form: "linear",
      kind: "x-axis",
      maximumRange: offsetXyRange(
        lexical,
        maximumStart,
        maximumStart + range[3].length,
      ),
      minimumRange: offsetXyRange(
        lexical,
        minimumStart,
        minimumStart + range[2].length,
      ),
      titleForm: rawTitle ? decodeMermaidXyText(rawTitle).form : undefined,
      titleRange: rawTitle
        ? offsetXyRange(
            lexical,
            bodyStart + rawBody.indexOf(rawTitle),
            bodyStart + rawBody.indexOf(rawTitle) + rawTitle.length,
          )
        : undefined,
      valid:
        textIsValid(rawTitle) &&
        Number.isFinite(Number(range[2])) &&
        Number.isFinite(Number(range[3])) &&
        Number(range[2]) < Number(range[3]),
    };
  }
  return {
    ...base,
    categories: [],
    form: "title-only",
    kind: "x-axis",
    titleForm: rawBody ? decodeMermaidXyText(rawBody).form : undefined,
    titleRange: rawBody
      ? offsetXyRange(lexical, rawBodyStart, rawBodyStart + rawBody.length)
      : undefined,
    valid: Boolean(rawBody) && textIsValid(rawBody),
  };
}

function parseYAxisRecord(
  lexical: MermaidXyLexicalRecord,
  syntax: string,
  occurrences: Map<string, number>,
): Extract<MermaidXySourceRecord, { kind: "y-axis" }> | null {
  const keyword = /^\s*y-axis\b/i.exec(syntax);
  if (!keyword) return null;
  const rawBody = syntax.slice(keyword[0].length).replace(/;\s*$/, "").trim();
  const rawBodyStart = lexical.raw.indexOf(rawBody, keyword[0].length);
  const base = recordIdentity("y-axis", lexical, occurrences);
  const range = new RegExp(
    `^(.*?)(?:\\s+)?(${NUMBER_SOURCE})\\s+-->\\s+(${NUMBER_SOURCE})$`,
  ).exec(rawBody);
  if (range) {
    const rawTitle = range[1].trim();
    const bodyStart = rawBodyStart;
    const arrowStart = rawBody.lastIndexOf("-->");
    const minimumStart = bodyStart + rawBody.lastIndexOf(range[2], arrowStart);
    const maximumStart = bodyStart + rawBody.indexOf(range[3], arrowStart + 3);
    return {
      ...base,
      kind: "y-axis",
      maximumRange: offsetXyRange(
        lexical,
        maximumStart,
        maximumStart + range[3].length,
      ),
      minimumRange: offsetXyRange(
        lexical,
        minimumStart,
        minimumStart + range[2].length,
      ),
      titleForm: rawTitle ? decodeMermaidXyText(rawTitle).form : undefined,
      titleRange: rawTitle
        ? offsetXyRange(
            lexical,
            bodyStart + rawBody.indexOf(rawTitle),
            bodyStart + rawBody.indexOf(rawTitle) + rawTitle.length,
          )
        : undefined,
      valid:
        textIsValid(rawTitle) &&
        Number.isFinite(Number(range[2])) &&
        Number.isFinite(Number(range[3])) &&
        Number(range[2]) < Number(range[3]),
    };
  }
  return {
    ...base,
    kind: "y-axis",
    titleForm: rawBody ? decodeMermaidXyText(rawBody).form : undefined,
    titleRange: rawBody
      ? offsetXyRange(lexical, rawBodyStart, rawBodyStart + rawBody.length)
      : undefined,
    valid: !rawBody || textIsValid(rawBody),
  };
}

function parsePlotRecord(
  lexical: MermaidXyLexicalRecord,
  syntax: string,
  occurrences: Map<string, number>,
): Extract<MermaidXySourceRecord, { kind: "plot" }> | null {
  const keyword = /^\s*(bar|line)\b/i.exec(syntax);
  if (!keyword) return null;
  const plotKind = keyword[1].toLowerCase() as "bar" | "line";
  const rawBody = syntax.slice(keyword[0].length).trim();
  const rawBodyStart = lexical.raw.indexOf(rawBody, keyword[0].length);
  const bracket = bracketBody(rawBody);
  const base = recordIdentity("plot", lexical, occurrences);
  if (!bracket) {
    return {
      ...base,
      kind: "plot",
      plotKind,
      points: [],
      valid: false,
    };
  }
  const rawTitle = rawBody.slice(0, bracket.start).trim();
  const items = splitList(bracket.body);
  const bodyStart = rawBodyStart + bracket.start + 1;
  const points = (items ?? []).map((item) => {
    const value = new RegExp(`^(${NUMBER_SOURCE})(?:\\s+(.+))?$`).exec(
      item.raw,
    );
    const valueSource = value?.[1] ?? item.raw;
    const valueStart = bodyStart + item.start + item.raw.indexOf(valueSource);
    const labelSource = value?.[2]?.trim();
    const labelStart = labelSource
      ? bodyStart + item.start + item.raw.lastIndexOf(labelSource)
      : undefined;
    return {
      labelForm: labelSource
        ? decodeMermaidXyText(labelSource).form
        : undefined,
      labelRange:
        labelStart === undefined
          ? undefined
          : offsetXyRange(
              lexical,
              labelStart,
              labelStart + labelSource!.length,
            ),
      range: offsetXyRange(
        lexical,
        bodyStart + item.start,
        bodyStart + item.end,
      ),
      valueRange: offsetXyRange(
        lexical,
        valueStart,
        valueStart + valueSource.length,
      ),
    };
  });
  const valid =
    Boolean(items?.length) &&
    textIsValid(rawTitle) &&
    items!.every((item) => {
      const value = new RegExp(`^(${NUMBER_SOURCE})(?:\\s+(.+))?$`).exec(
        item.raw,
      );
      return Boolean(
        value &&
        Number.isFinite(Number(value[1])) &&
        (!value[2] || textIsValid(value[2])),
      );
    });
  return {
    ...base,
    kind: "plot",
    plotKind,
    points,
    titleForm: rawTitle ? decodeMermaidXyText(rawTitle).form : undefined,
    titleRange: rawTitle
      ? offsetXyRange(
          lexical,
          rawBodyStart + rawBody.indexOf(rawTitle),
          rawBodyStart + rawBody.indexOf(rawTitle) + rawTitle.length,
        )
      : undefined,
    valid,
  };
}

function configValue(raw: string) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "horizontal" || raw === "vertical") return raw;
  return Number(raw);
}

function assignConfig(
  config: MermaidXyConfig,
  field: string,
  value: boolean | number | string,
) {
  if (field.startsWith("xAxis.")) {
    config.xAxis ??= {};
    Object.assign(config.xAxis, { [field.slice(6)]: value });
  } else if (field.startsWith("yAxis.")) {
    config.yAxis ??= {};
    Object.assign(config.yAxis, { [field.slice(6)]: value });
  } else Object.assign(config, { [field]: value });
}

function modelConfigField(model: MermaidXyModel | undefined, field: string) {
  if (field.startsWith("xAxis."))
    return model?.config.xAxis?.[
      field.slice(6) as keyof NonNullable<MermaidXyConfig["xAxis"]>
    ];
  if (field.startsWith("yAxis."))
    return model?.config.yAxis?.[
      field.slice(6) as keyof NonNullable<MermaidXyConfig["yAxis"]>
    ];
  return model?.config[field as keyof Omit<MermaidXyConfig, "xAxis" | "yAxis">];
}

function previousPlotForRecord(
  previous: MermaidXyModel | undefined,
  recordId: string,
) {
  return previous?.plots.find((plot) => plot.sourceRecordId === recordId);
}

function stableChildIds(
  prefix: "category" | "point",
  items: readonly {
    fingerprint: string;
    range: MermaidXySourceRange;
  }[],
  previous:
    | ReadonlyArray<{
        id: string;
        sourceFingerprint: string;
        sourceRangeStart: number;
      }>
    | undefined,
  retired: ReadonlyArray<MermaidXyChildIdentity>,
  recordId: string,
) {
  const unused = new Set(previous?.map((item) => item.id) ?? []);
  const retiredUnused = new Set(retired.map((item) => item.id));
  const ids = Array.from(
    { length: items.length },
    (): string | undefined => undefined,
  );
  const currentFingerprintCounts = new Map<string, number>();
  for (const item of items)
    currentFingerprintCounts.set(
      item.fingerprint,
      (currentFingerprintCounts.get(item.fingerprint) ?? 0) + 1,
    );
  const adopt = (index: number, id: string) => {
    ids[index] = id;
    unused.delete(id);
  };
  items.forEach(({ fingerprint }, index) => {
    const sourceMatches = previous?.filter(
      (item) => unused.has(item.id) && item.sourceFingerprint === fingerprint,
    );
    if (
      currentFingerprintCounts.get(fingerprint) === 1 &&
      sourceMatches?.length === 1
    )
      adopt(index, sourceMatches[0].id);
  });

  if (previous?.length === items.length) {
    items.forEach(({ range }, index) => {
      if (ids[index] !== undefined) return;
      const exact = previous.find(
        (item) => unused.has(item.id) && item.sourceRangeStart === range.start,
      );
      if (exact) adopt(index, exact.id);
    });
  }

  const current = items
    .map((item, index) => ({ ...item, index }))
    .filter((item) => ids[item.index] === undefined);
  const prior = (previous ?? []).filter((item) => unused.has(item.id));
  const lengths = Array.from({ length: current.length + 1 }, () =>
    Array.from({ length: prior.length + 1 }, () => 0),
  );
  for (let left = current.length - 1; left >= 0; left -= 1) {
    for (let right = prior.length - 1; right >= 0; right -= 1) {
      lengths[left][right] =
        current[left].fingerprint === prior[right].sourceFingerprint
          ? lengths[left + 1][right + 1] + 1
          : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }
  let left = 0;
  let right = 0;
  while (left < current.length && right < prior.length) {
    if (current[left].fingerprint === prior[right].sourceFingerprint) {
      adopt(current[left].index, prior[right].id);
      left += 1;
      right += 1;
    } else if (lengths[left + 1][right] >= lengths[left][right + 1]) {
      left += 1;
    } else {
      right += 1;
    }
  }

  items.forEach(({ fingerprint, range }, index) => {
    if (ids[index] !== undefined) return;
    const candidates = retired.filter(
      (item) =>
        retiredUnused.has(item.id) && item.sourceFingerprint === fingerprint,
    );
    const exact = candidates.find(
      (item) => item.sourceRangeStart === range.start,
    );
    const match =
      exact ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (match) {
      ids[index] = match.id;
      retiredUnused.delete(match.id);
    }
  });
  const occupied = new Set([
    ...ids.flatMap((id) => (id ? [id] : [])),
    ...(previous?.map((item) => item.id) ?? []),
    ...retired.map((item) => item.id),
  ]);
  return ids.map((id, index) => {
    if (id) return id;
    const base = `${recordId}-${prefix}-${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (occupied.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    occupied.add(candidate);
    return candidate;
  });
}

function semanticAnchor(
  record: MermaidXySourceRecord | undefined,
  plots: readonly MermaidXyPlot[],
): MermaidXyComment["anchor"] {
  if (!record || record.kind === "header") return { kind: "diagram" };
  if (record.kind === "x-axis") return { id: "xy-axis-x", kind: "x-axis" };
  if (record.kind === "y-axis") return { id: "xy-axis-y", kind: "y-axis" };
  if (record.kind === "plot") {
    const plot = plots.find(
      (candidate) => candidate.sourceRecordId === record.id,
    );
    return plot ? { id: plot.id, kind: "plot" } : { kind: "diagram" };
  }
  if (record.kind === "metadata") return { id: record.field, kind: "metadata" };
  return { kind: "diagram" };
}

function isAnchorRecord(record: MermaidXySourceRecord) {
  return ["header", "metadata", "plot", "x-axis", "y-axis"].includes(
    record.kind,
  );
}

export function parseMermaidXySourceResult(
  source: string,
  previousModel?: MermaidXyModel,
): MermaidXyParseResult {
  const scanned = scanMermaidXySource(source);
  const diagnostics: MermaidXyDiagnostic[] = [];
  const occurrences = new Map<string, number>();
  const records: MermaidXySourceRecord[] = [];
  let headerSeen = false;

  for (let index = 0; index < scanned.lexicalRecords.length; index += 1) {
    const lexical = scanned.lexicalRecords[index];
    if (lexical.kind === "frontmatter") {
      records.push({
        ...recordIdentity("frontmatter", lexical, occurrences),
        configFields: /xychart/i.test(lexical.raw)
          ? xyConfigFieldRanges(lexical)
          : [],
        kind: "frontmatter",
      });
      continue;
    }
    if (lexical.kind === "directive") {
      const close = lexical.raw.lastIndexOf("}%%");
      if (close < 0)
        return {
          diagnostic: createMermaidXyDiagnostic(
            "ambiguous-source",
            `Unclosed XY directive starting on line ${lexical.range.startLine + 1}.`,
            lexical.range,
            "xy-directive",
            "config",
          ),
          model: null,
        };
      if (lexical.raw.slice(close + 3).trim()) {
        const invalid = {
          ...recordIdentity("invalid", lexical, occurrences),
          kind: "invalid" as const,
        };
        records.push(invalid);
        diagnostics.push(
          createMermaidXyDiagnostic(
            "invalid-statement",
            `Invalid XY directive on line ${lexical.range.startLine + 1}.`,
            lexical.range,
            invalid.id,
            "config",
          ),
        );
        continue;
      }
      records.push({
        ...recordIdentity("directive", lexical, occurrences),
        configFields: /xychart/i.test(lexical.raw)
          ? xyConfigFieldRanges(lexical)
          : [],
        kind: "directive",
      });
      continue;
    }
    const trimmed = lexical.raw.trim();
    if (!trimmed) {
      records.push({
        ...recordIdentity("blank", lexical, occurrences),
        kind: "blank",
      });
      continue;
    }
    if (trimmed.startsWith("%%")) {
      const base = recordIdentity("comment", lexical, occurrences);
      records.push({
        ...base,
        commentId: `${base.id}-comment`,
        kind: "comment",
      });
      continue;
    }
    const header = HEADER_RE.exec(lexical.raw);
    if (headerSeen && header)
      return {
        diagnostic: createMermaidXyDiagnostic(
          "ambiguous-source",
          `Duplicate XY header on line ${lexical.range.startLine + 1}.`,
          lexical.range,
          "xy-header",
          "diagram",
        ),
        model: null,
      };
    if (!headerSeen && !header)
      return {
        diagnostic: createMermaidXyDiagnostic(
          "ambiguous-source",
          `XY header must precede diagram statements (line ${lexical.range.startLine + 1}).`,
          lexical.range,
          "xy-header",
          "diagram",
        ),
        model: null,
      };
    if (header) {
      const orientation = header[2]?.toLowerCase() as
        "horizontal" | "vertical" | undefined;
      records.push({
        ...recordIdentity("header", lexical, occurrences),
        form: header[1].toLowerCase() as "xychart" | "xychart-beta",
        kind: "header",
        orientation,
        orientationRange: orientation
          ? matchingRange(lexical, header[2])
          : undefined,
      });
      headerSeen = true;
      continue;
    }
    if (/^\s*accDescr\s*\{\s*$/i.test(lexical.raw)) {
      let endIndex = index + 1;
      while (
        endIndex < scanned.lexicalRecords.length &&
        !/^\s*}\s*$/.test(scanned.lexicalRecords[endIndex].raw)
      )
        endIndex += 1;
      if (endIndex < scanned.lexicalRecords.length) {
        const closing = scanned.lexicalRecords[endIndex];
        const raw = source.slice(lexical.range.start, closing.range.end);
        const combined: MermaidXyLexicalRecord = {
          kind: "line",
          range: {
            end: closing.range.end,
            endLine: closing.range.endLine,
            start: lexical.range.start,
            startLine: lexical.range.startLine,
          },
          raw,
        };
        records.push({
          ...recordIdentity("metadata", combined, occurrences),
          field: "accessibilityDescription",
          format: "block",
          kind: "metadata",
          textForm: "plain",
          valid: true,
          valueRange: offsetXyRange(
            combined,
            raw.indexOf("{") + 1,
            raw.lastIndexOf("}"),
          ),
        });
        index = endIndex;
        continue;
      }
      return {
        diagnostic: createMermaidXyDiagnostic(
          "ambiguous-source",
          `Unclosed XY accessibility description starting on line ${lexical.range.startLine + 1}.`,
          {
            end: source.length,
            endLine:
              scanned.lexicalRecords.at(-1)?.range.endLine ??
              lexical.range.endLine,
            start: lexical.range.start,
            startLine: lexical.range.startLine,
          },
          "xy-accessibility-description",
          "diagram",
        ),
        model: null,
      };
    }
    const metadata = metadataRecord(lexical, occurrences);
    if (metadata) {
      records.push(metadata);
      if (!metadata.valid) {
        diagnostics.push(
          createMermaidXyDiagnostic(
            "invalid-statement",
            `Invalid XY ${metadata.field} statement on line ${lexical.range.startLine + 1}.`,
            lexical.range,
            metadata.id,
            "diagram",
          ),
        );
      }
      continue;
    }
    const inline = splitInlineComment(lexical.raw);
    const xAxis = parseXAxisRecord(lexical, inline.syntax, occurrences);
    const yAxis = xAxis
      ? null
      : parseYAxisRecord(lexical, inline.syntax, occurrences);
    const plot =
      xAxis || yAxis
        ? null
        : parsePlotRecord(lexical, inline.syntax, occurrences);
    const parsed = xAxis ?? yAxis ?? plot;
    if (parsed) {
      records.push({
        ...parsed,
        inlineCommentId: inline.comment
          ? `${parsed.id}-inline-comment`
          : undefined,
        inlineCommentRange:
          inline.commentStart >= 0
            ? offsetXyRange(lexical, inline.commentStart, lexical.raw.length)
            : undefined,
      });
      if (!parsed.valid) {
        diagnostics.push(
          createMermaidXyDiagnostic(
            parsed.kind === "plot" ? "invalid-number" : "invalid-range",
            `Invalid XY ${parsed.kind} statement on line ${lexical.range.startLine + 1}.`,
            lexical.range,
            parsed.id,
            parsed.kind,
          ),
        );
      }
      continue;
    }
    const invalid = {
      ...recordIdentity("invalid", lexical, occurrences),
      kind: "invalid" as const,
    };
    records.push(invalid);
    diagnostics.push(
      createMermaidXyDiagnostic(
        /^(?:area|pie|section|style)\b/i.test(trimmed)
          ? "unsupported-statement"
          : "invalid-statement",
        `XY statement on line ${lexical.range.startLine + 1} cannot be edited safely.`,
        lexical.range,
        invalid.id,
        "diagram",
      ),
    );
  }

  reconcileMermaidXyRecordIdentities(records, previousModel?.sourceDocument);
  scanned.document.records = records;
  const header = records.find(
    (record): record is Extract<MermaidXySourceRecord, { kind: "header" }> =>
      record.kind === "header",
  );
  if (!header) {
    const record = records[0];
    const diagnostic = createMermaidXyDiagnostic(
      "ambiguous-source",
      "XY source requires one unambiguous xychart or xychart-beta header.",
      record?.range ?? {
        end: source.length,
        endLine: 1,
        start: 0,
        startLine: 0,
      },
      record?.id ?? "xy-source",
      "diagram",
    );
    return { diagnostic, model: null };
  }

  const config: MermaidXyConfig = {};
  let title = "";
  let titleForm: MermaidXyTextForm | undefined;
  let accessibilityTitle = "";
  let accessibilityDescription = "";
  const validMetadata = new Set<
    "accessibilityDescription" | "accessibilityTitle" | "title"
  >();
  const invalidMetadata = new Set<
    "accessibilityDescription" | "accessibilityTitle" | "title"
  >();
  for (const record of records) {
    if (record.kind === "frontmatter" || record.kind === "directive") {
      for (const field of record.configFields) {
        const raw = source.slice(field.valueRange.start, field.valueRange.end);
        const parsed = configValue(raw);
        if (validMermaidXyConfigFieldValue(field.field, parsed))
          assignConfig(config, field.field, parsed);
        else {
          const previousValue = modelConfigField(previousModel, field.field);
          if (previousValue !== undefined)
            assignConfig(config, field.field, previousValue);
          diagnostics.push(
            createMermaidXyDiagnostic(
              "invalid-config",
              `Invalid XY config value for ${field.field}.`,
              field.valueRange,
              record.id,
              "config",
            ),
          );
        }
      }
    } else if (record.kind === "metadata" && !record.valid) {
      invalidMetadata.add(record.field);
    } else if (record.kind === "metadata") {
      validMetadata.add(record.field);
      let value = source.slice(record.valueRange.start, record.valueRange.end);
      if (record.format === "block") {
        value = value
          .split(/\r\n|\r|\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .join("\n");
      } else value = decodeMermaidXyText(value).text;
      if (record.field === "title") {
        title = value;
        titleForm = record.textForm;
      } else if (record.field === "accessibilityTitle")
        accessibilityTitle = value;
      else accessibilityDescription = value;
    }
  }
  if (
    previousModel &&
    invalidMetadata.has("title") &&
    !validMetadata.has("title")
  ) {
    title = previousModel.title;
    titleForm = previousModel.titleForm;
  }
  if (
    previousModel &&
    invalidMetadata.has("accessibilityTitle") &&
    !validMetadata.has("accessibilityTitle")
  )
    accessibilityTitle = previousModel.accessibilityTitle;
  if (
    previousModel &&
    invalidMetadata.has("accessibilityDescription") &&
    !validMetadata.has("accessibilityDescription")
  )
    accessibilityDescription = previousModel.accessibilityDescription;

  const xRecord = [...records]
    .reverse()
    .find(
      (record): record is Extract<MermaidXySourceRecord, { kind: "x-axis" }> =>
        record.kind === "x-axis" && record.valid,
    );
  const invalidXRecord = [...records]
    .reverse()
    .find(
      (record): record is Extract<MermaidXySourceRecord, { kind: "x-axis" }> =>
        record.kind === "x-axis" && !record.valid,
    );
  const yRecord = [...records]
    .reverse()
    .find(
      (record): record is Extract<MermaidXySourceRecord, { kind: "y-axis" }> =>
        record.kind === "y-axis" && record.valid,
    );
  const invalidYRecord = [...records]
    .reverse()
    .find(
      (record): record is Extract<MermaidXySourceRecord, { kind: "y-axis" }> =>
        record.kind === "y-axis" && !record.valid,
    );
  const previousCategories = previousModel?.xAxis.categories;
  const retiredCategories =
    previousModel?.identityArchive?.categories.filter(
      (identity) =>
        !previousCategories?.some((category) => category.id === identity.id),
    ) ?? [];
  const categoryIds = stableChildIds(
    "category",
    xRecord?.categories.map((category) => ({
      fingerprint: mermaidXyFingerprint(
        source.slice(category.range.start, category.range.end),
      ),
      range: category.range,
    })) ?? [],
    previousCategories,
    retiredCategories,
    xRecord?.id ?? "xy-axis-x",
  );
  const categories: MermaidXyCategory[] = xRecord
    ? xRecord.categories.map((category, order) => ({
        id: categoryIds[order],
        label: decodeMermaidXyText(
          source.slice(category.range.start, category.range.end),
        ).text,
        order,
        sourceFingerprint: mermaidXyFingerprint(
          source.slice(category.range.start, category.range.end),
        ),
        sourceRangeStart: category.range.start,
        textForm: category.textForm,
      }))
    : invalidXRecord && previousModel
      ? previousModel.xAxis.categories.map((category) => ({ ...category }))
      : [];
  xRecord?.categories.forEach((category, order) => {
    category.id = categoryIds[order];
  });

  const plots: MermaidXyPlot[] = [];
  for (const record of records) {
    if (record.kind !== "plot") continue;
    const order = plots.length;
    const previous = previousPlotForRecord(previousModel, record.id);
    const archived = previousModel?.identityArchive?.plots.find(
      (plot) => plot.sourceRecordId === record.id,
    );
    if (!record.valid) {
      if (previous)
        plots.push({
          ...previous,
          order,
          points: previous.points.map((point) => ({ ...point })),
        });
      continue;
    }
    const plotId = previous?.id ?? archived?.id ?? `${record.id}-plot`;
    const pointIds = stableChildIds(
      "point",
      record.points.map((point) => ({
        fingerprint: mermaidXyFingerprint(
          source.slice(point.range.start, point.range.end),
        ),
        range: point.range,
      })),
      previous?.points,
      archived?.points.filter(
        (identity) =>
          !previous?.points.some((point) => point.id === identity.id),
      ) ?? [],
      record.id,
    );
    const points: MermaidXyPoint[] = record.points.map((point, pointOrder) => {
      const valueSource = source.slice(
        point.valueRange.start,
        point.valueRange.end,
      );
      const labelSource = point.labelRange
        ? source.slice(point.labelRange.start, point.labelRange.end)
        : "";
      return {
        id: pointIds[pointOrder],
        label: labelSource ? decodeMermaidXyText(labelSource).text : "",
        labelForm: point.labelForm,
        order: pointOrder,
        plotId,
        sourceFingerprint: mermaidXyFingerprint(
          source.slice(point.range.start, point.range.end),
        ),
        sourceRangeStart: point.range.start,
        value: Number(valueSource),
      };
    });
    record.plotId = plotId;
    record.points.forEach((point, pointOrder) => {
      point.id = pointIds[pointOrder];
    });
    const titleSource = record.titleRange
      ? source.slice(record.titleRange.start, record.titleRange.end)
      : "";
    plots.push({
      id: plotId,
      kind: record.plotKind,
      order,
      points,
      sourceFingerprint: record.fingerprint,
      sourceRecordId: record.id,
      title: titleSource
        ? decodeMermaidXyText(titleSource).text
        : record.plotKind,
      titleExplicit: Boolean(titleSource),
      titleForm: record.titleForm,
    });
  }

  const xSourceForm =
    xRecord?.form ??
    (invalidXRecord && previousModel
      ? previousModel.xAxis.sourceForm
      : "omitted");
  const firstPlotLength = plots[0]?.points.length ?? 0;
  const xMinimum = xRecord?.minimumRange
    ? Number(source.slice(xRecord.minimumRange.start, xRecord.minimumRange.end))
    : invalidXRecord && previousModel
      ? previousModel.xAxis.effectiveMinimum
      : 1;
  const xMaximum = xRecord?.maximumRange
    ? Number(source.slice(xRecord.maximumRange.start, xRecord.maximumRange.end))
    : invalidXRecord && previousModel
      ? previousModel.xAxis.effectiveMaximum
      : Math.max(1, firstPlotLength);
  // Overflow band points remain visible source data and therefore participate
  // in the same automatic value range as points that have category labels.
  const values = plots.flatMap((plot) =>
    plot.points.map((point) => point.value),
  );
  const yMinimum = yRecord?.minimumRange
    ? Number(source.slice(yRecord.minimumRange.start, yRecord.minimumRange.end))
    : invalidYRecord && previousModel
      ? previousModel.yAxis.minimum
      : values.length
        ? Math.min(...values)
        : 0;
  const yMaximum = yRecord?.maximumRange
    ? Number(source.slice(yRecord.maximumRange.start, yRecord.maximumRange.end))
    : invalidYRecord && previousModel
      ? previousModel.yAxis.maximum
      : values.length
        ? Math.max(...values)
        : 1;

  if (xSourceForm === "band") {
    for (const plot of plots) {
      if (plot.points.length === categories.length) continue;
      diagnostics.push(
        createMermaidXyDiagnostic(
          "length-mismatch",
          `${plot.title} has ${plot.points.length} points for ${categories.length} categories; values remain source-preserved.`,
          records.find((record) => record.id === plot.sourceRecordId)!.range,
          plot.sourceRecordId,
          "plot",
          "warning",
        ),
      );
    }
  }

  const comments: MermaidXyComment[] = [];
  for (const [index, record] of records.entries()) {
    if (
      (record.kind === "plot" ||
        record.kind === "x-axis" ||
        record.kind === "y-axis") &&
      record.inlineCommentId &&
      record.inlineCommentRange
    ) {
      comments.push({
        anchor: semanticAnchor(record, plots),
        id: record.inlineCommentId,
        position: "after",
        sourceRecordId: record.id,
        text: source
          .slice(record.inlineCommentRange.start, record.inlineCommentRange.end)
          .replace(/^%%\s?/, ""),
      });
    }
    if (record.kind !== "comment") continue;
    const previousAnchorIndex = records
      .slice(0, index)
      .findLastIndex(isAnchorRecord);
    const nextRelativeIndex = records
      .slice(index + 1)
      .findIndex(isAnchorRecord);
    const nextAnchorIndex =
      nextRelativeIndex < 0 ? -1 : index + 1 + nextRelativeIndex;
    const previousAnchor = records[previousAnchorIndex];
    const nextAnchor = records[nextAnchorIndex];
    const separatedFromPrevious = records
      .slice(previousAnchorIndex + 1, index)
      .some((candidate) => candidate.kind === "blank");
    const separatedFromNext =
      nextAnchorIndex >= 0 &&
      records
        .slice(index + 1, nextAnchorIndex)
        .some((candidate) => candidate.kind === "blank");
    const belongsBeforeNext =
      Boolean(nextAnchor) &&
      !separatedFromNext &&
      (!previousAnchor || separatedFromPrevious);
    const owner = belongsBeforeNext
      ? nextAnchor
      : (previousAnchor ?? nextAnchor ?? header);
    comments.push({
      anchor: semanticAnchor(owner, plots),
      id: record.commentId ?? `${record.id}-comment`,
      position: belongsBeforeNext || !previousAnchor ? "before" : "after",
      sourceRecordId: record.id,
      text: record.raw.trim().replace(/^%%\s?/, ""),
    });
  }
  const xTitleSource = xRecord?.titleRange
    ? source.slice(xRecord.titleRange.start, xRecord.titleRange.end)
    : "";
  const yTitleSource = yRecord?.titleRange
    ? source.slice(yRecord.titleRange.start, yRecord.titleRange.end)
    : "";
  const orientation =
    header.orientation ??
    config.chartOrientation ??
    DEFAULT_MERMAID_XY_CONFIG.chartOrientation;
  const model: MermaidXyModel = {
    accessibilityDescription,
    accessibilityTitle,
    comments,
    config,
    diagnostics,
    diagramType: "xychart",
    directives: records
      .filter(
        (record) =>
          record.kind === "directive" || record.kind === "frontmatter",
      )
      .map((record) => record.raw),
    headerForm: header.form,
    headerLine: header.raw.trim(),
    headerOrientation: header.orientation,
    identityArchive: previousModel?.identityArchive
      ? {
          categories: previousModel.identityArchive.categories.map(
            (identity) => ({ ...identity }),
          ),
          plots: previousModel.identityArchive.plots.map((identity) => ({
            ...identity,
            points: identity.points.map((point) => ({ ...point })),
          })),
        }
      : { categories: [], plots: [] },
    orientation,
    plots,
    sourceDocument: scanned.document,
    sourceHash: hashMermaidSource(source),
    title,
    titleForm,
    version: 2,
    xAxis: {
      categories,
      effectiveKind: xSourceForm === "band" ? "band" : "linear",
      effectiveMaximum: xMaximum,
      effectiveMinimum: xMinimum,
      id: "xy-axis-x",
      sourceForm: xSourceForm,
      sourceRecordId: xRecord?.id ?? invalidXRecord?.id,
      title: xTitleSource
        ? decodeMermaidXyText(xTitleSource).text
        : invalidXRecord && previousModel
          ? previousModel.xAxis.title
          : "",
      titleForm:
        xRecord?.titleForm ??
        (invalidXRecord ? previousModel?.xAxis.titleForm : undefined),
    },
    yAxis: {
      id: "xy-axis-y",
      maximum: yMaximum === yMinimum ? yMinimum + 1 : yMaximum,
      minimum: yMinimum,
      rangeExplicit:
        Boolean(yRecord?.minimumRange && yRecord.maximumRange) ||
        Boolean(invalidYRecord && previousModel?.yAxis.rangeExplicit),
      sourceRecordId: yRecord?.id ?? invalidYRecord?.id,
      title: yTitleSource
        ? decodeMermaidXyText(yTitleSource).text
        : invalidYRecord && previousModel
          ? previousModel.yAxis.title
          : "",
      titleForm:
        yRecord?.titleForm ??
        (invalidYRecord ? previousModel?.yAxis.titleForm : undefined),
    },
  };
  refreshMermaidXyIdentityArchive(model);
  return { model };
}

export function parseMermaidXySource(
  source: string,
  previousModel?: MermaidXyModel,
) {
  return parseMermaidXySourceResult(source, previousModel).model;
}
