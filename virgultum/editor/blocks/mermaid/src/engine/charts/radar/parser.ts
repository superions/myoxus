// SPDX-License-Identifier: AGPL-3.0-or-later

import { hashMermaidSource } from "../../../utils.js";
import {
  createMermaidRadarDiagnostic,
  type MermaidRadarDiagnostic,
} from "./diagnostics.js";
import {
  DEFAULT_MERMAID_RADAR_CONFIG,
  DEFAULT_MERMAID_RADAR_OPTIONS,
  mermaidRadarConfigDiagnosis,
  type MermaidRadarAxis,
  type MermaidRadarComment,
  type MermaidRadarConfig,
  type MermaidRadarCurve,
  type MermaidRadarEntry,
  type MermaidRadarIdentityArchive,
  type MermaidRadarModel,
  type MermaidRadarOptions,
  type MermaidRadarVertex,
} from "./model.js";
import {
  mermaidRadarFingerprint,
  mermaidRadarRecordId,
  offsetRadarRange,
  radarConfigFieldRanges,
  radarConfigScope,
  radarRangeAtEnd,
  scanMermaidRadarSource,
  type MermaidRadarAxisSource,
  type MermaidRadarCurveSource,
  type MermaidRadarEntrySource,
  type MermaidRadarLexicalRecord,
  type MermaidRadarOptionName,
  type MermaidRadarOptionSource,
  type MermaidRadarQuoteForm,
  type MermaidRadarSourceDocument,
  type MermaidRadarSourceRange,
  type MermaidRadarSourceRecord,
  type MermaidRadarValueForm,
} from "./source-document.js";

export type MermaidRadarParseResult =
  | { readonly diagnostic: MermaidRadarDiagnostic; readonly model: null }
  | { readonly model: MermaidRadarModel };

type Segment = { end: number; start: number; text: string };

const RADAR_NUMBER = /^(?:0|[1-9]\d*|\d+\.\d+)$/;
const OPTION_NAMES = new Set<MermaidRadarOptionName>([
  "graticule",
  "max",
  "min",
  "showLegend",
  "ticks",
]);

function splitTopLevel(value: string): Segment[] | null {
  const segments: Segment[] = [];
  let quote = "";
  let escaped = false;
  let bracketDepth = 0;
  let braceDepth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[") bracketDepth += 1;
    else if (character === "]") {
      if (--bracketDepth < 0) return null;
    } else if (character === "{") braceDepth += 1;
    else if (character === "}") {
      if (--braceDepth < 0) return null;
    } else if (character === "," && bracketDepth === 0 && braceDepth === 0) {
      const raw = value.slice(start, index);
      if (!raw.trim()) return null;
      const leading = raw.length - raw.trimStart().length;
      const trailing = raw.length - raw.trimEnd().length;
      segments.push({
        end: index - trailing,
        start: start + leading,
        text: raw.trim(),
      });
      start = index + 1;
    }
  }
  if (quote || bracketDepth !== 0 || braceDepth !== 0) return null;
  const raw = value.slice(start);
  if (!raw.trim()) return null;
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  segments.push({
    end: value.length - trailing,
    start: start + leading,
    text: raw.trim(),
  });
  return segments;
}

function inlineCommentStart(value: string) {
  let quote = "";
  let escaped = false;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth -= 1;
    else if (character === "{") braceDepth += 1;
    else if (character === "}") braceDepth -= 1;
    else if (
      character === "%" &&
      value[index + 1] === "%" &&
      bracketDepth === 0 &&
      braceDepth === 0
    )
      return index;
  }
  return -1;
}

function decodeLabel(raw: string) {
  const quote = raw[0] as '"' | "'";
  const body = raw.slice(1, -1);
  if (quote === '"') {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return body;
    }
  }
  return body.replace(/\\(['\\])/g, "$1");
}

function namedLabel(
  segment: Segment,
  offset: number,
  lexical: MermaidRadarLexicalRecord,
) {
  const match =
    /^([\w](?:[-\w]*\w)?)(?:\[\s*((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*'))\s*\])?$/.exec(
      segment.text,
    );
  if (!match) return null;
  const name = match[1];
  const nameStart = segment.start;
  const labelRaw = match[2];
  const labelStart = labelRaw ? segment.text.indexOf(labelRaw) : -1;
  const range = offsetRadarRange(
    lexical,
    offset + segment.start,
    offset + segment.end,
  );
  const labelQuote: MermaidRadarQuoteForm | undefined = labelRaw
    ? labelRaw.startsWith('"')
      ? "double"
      : "single"
    : undefined;
  return {
    label: labelRaw ? decodeLabel(labelRaw) : name,
    labelExplicit: Boolean(labelRaw),
    labelQuote,
    labelRange:
      labelStart >= 0
        ? offsetRadarRange(
            lexical,
            offset + segment.start + labelStart + 1,
            offset + segment.start + labelStart + labelRaw.length - 1,
          )
        : undefined,
    name,
    nameRange: offsetRadarRange(
      lexical,
      offset + nameStart,
      offset + nameStart + name.length,
    ),
    range,
  };
}

function recordIdentity(
  kind: string,
  lexical: MermaidRadarLexicalRecord,
  occurrences: Map<string, number>,
  raw = lexical.raw,
  range = lexical.range,
) {
  const fingerprint = mermaidRadarFingerprint(`${kind}:${raw.trim()}`);
  const occurrence = occurrences.get(`${kind}:${fingerprint}`) ?? 0;
  occurrences.set(`${kind}:${fingerprint}`, occurrence + 1);
  return {
    fingerprint,
    id: mermaidRadarRecordId(kind, fingerprint, occurrence),
    range,
    raw,
  };
}

function reconcileRecords(
  records: MermaidRadarSourceRecord[],
  previous?: MermaidRadarSourceDocument,
) {
  if (!previous) return;
  const unused = new Set(previous.records.map((record) => record.id));
  const assigned = new Set<string>();
  const reconciled = new Set<MermaidRadarSourceRecord>();

  // Reserve every unambiguous lexical identity before proximity fallback.
  // Otherwise an inserted/restored record can steal the identity of a later
  // unchanged record and make two source owners address the same range.
  for (const record of records) {
    const exact = previous.records.filter(
      (candidate) =>
        unused.has(candidate.id) &&
        candidate.kind === record.kind &&
        candidate.fingerprint === record.fingerprint,
    );
    if (exact.length !== 1) continue;
    const candidate = exact[0];
    unused.delete(candidate.id);
    assigned.add(candidate.id);
    reconciled.add(record);
    record.id = candidate.id;
  }
  for (const record of records) {
    if (reconciled.has(record)) continue;
    const candidate = previous.records
      .filter((item) => unused.has(item.id) && item.kind === record.kind)
      .sort(
        (left, right) =>
          Math.abs(left.range.start - record.range.start) -
          Math.abs(right.range.start - record.range.start),
      )[0];
    if (candidate) {
      unused.delete(candidate.id);
      assigned.add(candidate.id);
      reconciled.add(record);
      record.id = candidate.id;
      continue;
    }
    const base = record.id;
    for (let suffix = 1; assigned.has(record.id); suffix += 1)
      record.id = `${base}-${suffix}`;
    assigned.add(record.id);
  }
}

function parseNumber(raw: string) {
  if (!RADAR_NUMBER.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function numberPrecision(raw: string) {
  const decimal = raw.trim().split(".")[1];
  return decimal ? 10 ** -decimal.length : 1;
}

function parseAxisStatement(
  lexical: MermaidRadarLexicalRecord,
  statementRaw: string,
  statementRange: MermaidRadarSourceRange,
  occurrences: Map<string, number>,
) {
  const match = /^(\s*axis\s+)([\s\S]*?)\s*$/.exec(statementRaw);
  if (!match) return null;
  const prefix = match[1];
  const segments = splitTopLevel(match[2]);
  const identity = recordIdentity(
    "axis",
    lexical,
    occurrences,
    statementRaw,
    statementRange,
  );
  const axes = segments?.map((segment) =>
    namedLabel(segment, prefix.length, lexical),
  );
  return {
    record: {
      ...identity,
      axes: (axes?.filter(Boolean) ?? []) as MermaidRadarAxisSource[],
      kind: "axis" as const,
      valid: Boolean(axes && axes.length > 0 && axes.every(Boolean)),
    },
    values: axes?.filter(Boolean) ?? [],
  };
}

function parseCurveEntry(
  segment: Segment,
  valueOffset: number,
  lexical: MermaidRadarLexicalRecord,
) {
  const positional = parseNumber(segment.text);
  if (positional !== null) {
    const range = offsetRadarRange(
      lexical,
      valueOffset + segment.start,
      valueOffset + segment.end,
    );
    return {
      axisName: undefined,
      colon: false,
      source: {
        colon: false,
        range,
        valueRange: range,
      } satisfies MermaidRadarEntrySource,
      precision: numberPrecision(segment.text),
      value: positional,
    };
  }
  const detailed = /^([\w](?:[-\w]*\w)?)(\s*:\s*|\s+)(.+)$/.exec(segment.text);
  if (!detailed) return null;
  const value = parseNumber(detailed[3].trim());
  if (value === null) return null;
  const axisName = detailed[1];
  const axisStart = valueOffset + segment.start;
  const valueRawStart = segment.text.lastIndexOf(detailed[3]);
  const valueLeading = detailed[3].length - detailed[3].trimStart().length;
  return {
    axisName,
    colon: detailed[2].includes(":"),
    source: {
      axisNameRange: offsetRadarRange(
        lexical,
        axisStart,
        axisStart + axisName.length,
      ),
      colon: detailed[2].includes(":"),
      range: offsetRadarRange(
        lexical,
        valueOffset + segment.start,
        valueOffset + segment.end,
      ),
      valueRange: offsetRadarRange(
        lexical,
        valueOffset + segment.start + valueRawStart + valueLeading,
        valueOffset +
          segment.start +
          valueRawStart +
          detailed[3].trimEnd().length,
      ),
    } satisfies MermaidRadarEntrySource,
    precision: numberPrecision(detailed[3]),
    value,
  };
}

function parseCurveSegment(
  segment: Segment,
  tailOffset: number,
  lexical: MermaidRadarLexicalRecord,
) {
  const match =
    /^([\w](?:[-\w]*\w)?(?:\[\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\])?)\s*\{([\s\S]*)\}$/.exec(
      segment.text,
    );
  if (!match) return null;
  const nameEnd = match[1].length;
  const nameSegment = { end: nameEnd, start: 0, text: match[1] };
  const named = namedLabel(nameSegment, tailOffset + segment.start, lexical);
  if (!named) return null;
  const open = segment.text.indexOf("{", nameEnd);
  const entriesRaw = match[2];
  const entriesOffset = tailOffset + segment.start + open + 1;
  const entrySegments = splitTopLevel(entriesRaw);
  const entries = entrySegments?.map((entry) =>
    parseCurveEntry(entry, entriesOffset, lexical),
  );
  const parsed = entries?.filter(Boolean) ?? [];
  const positionalCount = parsed.filter((entry) => !entry!.axisName).length;
  const detailedCount = parsed.length - positionalCount;
  const form: MermaidRadarValueForm =
    positionalCount > 0 && detailedCount > 0
      ? "mixed"
      : detailedCount > 0
        ? "detailed"
        : "positional";
  return {
    ...named,
    entries: parsed,
    form,
    range: offsetRadarRange(
      lexical,
      tailOffset + segment.start,
      tailOffset + segment.end,
    ),
    valid: Boolean(
      entrySegments &&
      entrySegments.length > 0 &&
      entries?.every(Boolean) &&
      form !== "mixed",
    ),
  };
}

function parseCurveStatement(
  lexical: MermaidRadarLexicalRecord,
  statementRaw: string,
  statementRange: MermaidRadarSourceRange,
  occurrences: Map<string, number>,
) {
  const match = /^(\s*curve\s+)([\s\S]*?)\s*$/.exec(statementRaw);
  if (!match) return null;
  const segments = splitTopLevel(match[2]);
  const values = segments?.map((segment) =>
    parseCurveSegment(segment, match[1].length, lexical),
  );
  const identity = recordIdentity(
    "curve",
    lexical,
    occurrences,
    statementRaw,
    statementRange,
  );
  return {
    record: {
      ...identity,
      curves: (values?.filter(Boolean).map((curve) => ({
        entries: curve!.entries.map((entry) => entry!.source),
        form: curve!.form,
        labelQuote: curve!.labelQuote,
        labelRange: curve!.labelRange,
        nameRange: curve!.nameRange,
        range: curve!.range,
      })) ?? []) as MermaidRadarCurveSource[],
      kind: "curve" as const,
      valid: Boolean(
        values && values.length > 0 && values.every((value) => value?.valid),
      ),
    },
    values: values?.filter(Boolean) ?? [],
  };
}

function parseOptionStatement(
  lexical: MermaidRadarLexicalRecord,
  statementRaw: string,
  statementRange: MermaidRadarSourceRange,
  occurrences: Map<string, number>,
) {
  const leading = statementRaw.length - statementRaw.trimStart().length;
  const segments = splitTopLevel(statementRaw.trim());
  if (!segments) return null;
  const options = segments.map((segment) => {
    const match = /^(showLegend|ticks|max|min|graticule)\s+(.+)$/.exec(
      segment.text,
    );
    if (!match || !OPTION_NAMES.has(match[1] as MermaidRadarOptionName))
      return null;
    const name = match[1] as MermaidRadarOptionName;
    const value = match[2].trim();
    const valueStart =
      segment.text.lastIndexOf(match[2]) +
      (match[2].length - match[2].trimStart().length);
    const valid =
      name === "showLegend"
        ? /^(?:true|false)$/.test(value)
        : name === "graticule"
          ? /^(?:circle|polygon)$/.test(value)
          : parseNumber(value) !== null;
    return {
      name,
      nameRange: offsetRadarRange(
        lexical,
        leading + segment.start,
        leading + segment.start + name.length,
      ),
      range: offsetRadarRange(
        lexical,
        leading + segment.start,
        leading + segment.end,
      ),
      valid,
      valueRange: offsetRadarRange(
        lexical,
        leading + segment.start + valueStart,
        leading + segment.start + valueStart + value.length,
      ),
    } satisfies MermaidRadarOptionSource;
  });
  if (!options.some(Boolean)) return null;
  return {
    ...recordIdentity(
      "options",
      lexical,
      occurrences,
      statementRaw,
      statementRange,
    ),
    complete: options.every(Boolean),
    kind: "options" as const,
    options: options.filter(Boolean) as MermaidRadarOptionSource[],
    valid: options.every((option) => option?.valid),
  };
}

function metadataRecord(
  lexical: MermaidRadarLexicalRecord,
  raw: string,
  range: MermaidRadarSourceRange,
  occurrences: Map<string, number>,
) {
  const title = /^(\s*)title(?:[\t ]+([^\r\n]*?))?[\t ]*$/.exec(raw);
  const accessibilityTitle =
    /^(\s*)accTitle[\t ]*:[\t ]*([^\r\n]*?)[\t ]*$/.exec(raw);
  const line = title ?? accessibilityTitle;
  if (line) {
    const field = title ? ("title" as const) : ("accessibilityTitle" as const);
    const value = line[2] ?? "";
    const valueStart = value ? raw.lastIndexOf(value) : raw.length;
    return {
      ...recordIdentity("metadata", lexical, occurrences, raw, range),
      field,
      format: "line" as const,
      kind: "metadata" as const,
      valid: true,
      valueRange: offsetRadarRange(
        lexical,
        valueStart,
        valueStart + value.length,
      ),
    };
  }
  const description = /^(\s*)accDescr\s*:\s*([\s\S]*?)\s*$/.exec(raw);
  if (description) {
    const value = description[2];
    const start = raw.indexOf(value, description[1].length);
    return {
      ...recordIdentity("metadata", lexical, occurrences, raw, range),
      field: "accessibilityDescription" as const,
      format: "line" as const,
      kind: "metadata" as const,
      valid: true,
      valueRange: offsetRadarRange(lexical, start, start + value.length),
    };
  }
  const block = /^(\s*)accDescr\s*\{([\s\S]*)\}\s*$/.exec(raw);
  if (!block) return null;
  const value = block[2];
  const start = raw.indexOf(value, block[1].length);
  return {
    ...recordIdentity("metadata", lexical, occurrences, raw, range),
    field: "accessibilityDescription" as const,
    format: "block" as const,
    kind: "metadata" as const,
    valid: true,
    valueRange: offsetRadarRange(lexical, start, start + value.length),
  };
}

function parseConfigValue(raw: string): boolean | number | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function validConfigValue(
  field: keyof MermaidRadarConfig,
  value: boolean | number | null,
) {
  if (field === "useMaxWidth") return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (field === "width" || field === "height") return value > 0;
  if (field.startsWith("margin")) return value >= 0;
  if (field === "axisScaleFactor" || field === "axisLabelFactor")
    return value > 0;
  return field === "curveTension" && value >= 0;
}

function identityForAxis(
  name: string,
  fingerprint: string,
  rangeStart: number,
  order: number,
  sourceRecordId: string,
  sourceRecordOrder: number,
  reserved: ReadonlySet<string>,
  used: Set<string>,
  previous?: MermaidRadarModel,
) {
  const archived = previous?.identityArchive.axes ?? [];
  const sameName = [...(previous?.axes ?? []), ...archived].filter(
    (axis, index, candidates) =>
      axis.name === name &&
      candidates.findIndex((candidate) => candidate.id === axis.id) === index,
  );
  if (sameName.length === 1 && !used.has(sameName[0].id)) {
    used.add(sameName[0].id);
    return sameName[0].id;
  }
  const exact =
    archived.filter(
      (axis) =>
        axis.sourceFingerprint === fingerprint &&
        axis.sourceRangeStart === rangeStart,
    ) ?? [];
  if (exact.length === 1 && !used.has(exact[0].id)) {
    used.add(exact[0].id);
    return exact[0].id;
  }
  const anchored = previous?.axes.filter(
    (axis) => axis.sourceRecordId === sourceRecordId,
  )[sourceRecordOrder];
  if (anchored && !used.has(anchored.id)) {
    used.add(anchored.id);
    return anchored.id;
  }
  const positional = previous?.axes[order]?.id;
  const base = `radar-axis-${fingerprint}-${order}`;
  let id =
    positional && !used.has(positional) && !reserved.has(positional)
      ? positional
      : base;
  for (let suffix = 1; used.has(id); suffix += 1) id = `${base}-${suffix}`;
  used.add(id);
  return id;
}

function identityForCurve(
  name: string,
  fingerprint: string,
  rangeStart: number,
  order: number,
  sourceRecordId: string,
  sourceRecordOrder: number,
  reserved: ReadonlySet<string>,
  used: Set<string>,
  previous?: MermaidRadarModel,
) {
  const archived = previous?.identityArchive.curves ?? [];
  const sameName = [...(previous?.curves ?? []), ...archived].filter(
    (curve, index, candidates) =>
      curve.name === name &&
      candidates.findIndex((candidate) => candidate.id === curve.id) === index,
  );
  if (sameName.length === 1 && !used.has(sameName[0].id)) {
    used.add(sameName[0].id);
    return sameName[0].id;
  }
  const exact =
    archived.filter(
      (curve) =>
        curve.sourceFingerprint === fingerprint &&
        curve.sourceRangeStart === rangeStart,
    ) ?? [];
  if (exact.length === 1 && !used.has(exact[0].id)) {
    used.add(exact[0].id);
    return exact[0].id;
  }
  const anchored = previous?.curves.filter(
    (curve) => curve.sourceRecordId === sourceRecordId,
  )[sourceRecordOrder];
  if (anchored && !used.has(anchored.id)) {
    used.add(anchored.id);
    return anchored.id;
  }
  const positional = previous?.curves[order]?.id;
  const base = `radar-curve-${fingerprint}-${order}`;
  let id =
    positional && !used.has(positional) && !reserved.has(positional)
      ? positional
      : base;
  for (let suffix = 1; used.has(id); suffix += 1) id = `${base}-${suffix}`;
  used.add(id);
  return id;
}

function identityForEntry(
  curveId: string,
  axisId: string | undefined,
  axisName: string | undefined,
  fingerprint: string,
  rangeStart: number,
  order: number,
  used: Set<string>,
  previous?: MermaidRadarModel,
) {
  const previousCurve = previous?.curves.find((curve) => curve.id === curveId);
  const archivedEntries =
    previous?.identityArchive.curves.find((curve) => curve.id === curveId)
      ?.entries ?? [];
  const identityEntries = [
    ...(previousCurve?.entries ?? []),
    ...archivedEntries,
  ].filter(
    (entry, index, entries) =>
      entries.findIndex((candidate) => candidate.id === entry.id) === index,
  );
  const sameReference = axisName
    ? identityEntries.filter((entry) => entry.axisName === axisName)
    : [];
  if (sameReference.length === 1 && !used.has(sameReference[0].id)) {
    used.add(sameReference[0].id);
    return sameReference[0].id;
  }
  const sameAxis = axisId
    ? identityEntries.filter((entry) => entry.axisId === axisId)
    : [];
  if (sameAxis.length === 1 && !used.has(sameAxis[0].id)) {
    used.add(sameAxis[0].id);
    return sameAxis[0].id;
  }
  // A positional entry belongs to its projected axis, not to an array slot.
  // Prefer that semantic owner before lexical proximity so reordering axes
  // with equal values does not exchange vertex identity, focus or selection.
  // Detailed duplicates deliberately fall through to their distinct source
  // anchors because no single axis reference can identify either entry.
  const exact =
    identityEntries.filter(
      (entry) =>
        entry.sourceFingerprint === fingerprint &&
        entry.sourceRangeStart === rangeStart,
    ) ?? [];
  if (exact.length === 1 && !used.has(exact[0].id)) {
    used.add(exact[0].id);
    return exact[0].id;
  }
  const positional = previousCurve?.entries[order]?.id;
  const base = `radar-entry-${curveId}-${fingerprint}-${order}`;
  let id = positional && !used.has(positional) ? positional : base;
  for (let suffix = 1; used.has(id); suffix += 1) id = `${base}-${suffix}`;
  used.add(id);
  return id;
}

function commentAnchor(
  record: MermaidRadarSourceRecord | undefined,
  axes: readonly MermaidRadarAxis[],
  curves: readonly MermaidRadarCurve[],
): MermaidRadarComment["anchor"] {
  if (!record || record.kind === "header") return { kind: "diagram" };
  if (record.kind === "axis") {
    const matching = axes.filter(
      (candidate) => candidate.sourceRecordId === record.id,
    );
    return matching.length === 1
      ? { id: matching[0].id, kind: "axis" }
      : { kind: "diagram" };
  }
  if (record.kind === "curve") {
    const matching = curves.filter(
      (candidate) => candidate.sourceRecordId === record.id,
    );
    return matching.length === 1
      ? { id: matching[0].id, kind: "curve" }
      : { kind: "diagram" };
  }
  if (record.kind === "metadata") return { id: record.field, kind: "metadata" };
  if (record.kind === "options") return { id: record.id, kind: "options" };
  return { kind: "diagram" };
}

function anchorRecord(record: MermaidRadarSourceRecord) {
  return ["axis", "curve", "header", "metadata", "options"].includes(
    record.kind,
  );
}

function projectedVertices(
  axes: readonly MermaidRadarAxis[],
  curve: Omit<MermaidRadarCurve, "vertices">,
  minimum: number,
  maximum: number | null,
) {
  return axes.map((axis, order) => {
    const ambiguousAxisName =
      curve.sourceForm === "detailed" &&
      axes.filter((candidate) => candidate.name === axis.name).length > 1;
    const candidates =
      curve.sourceForm === "positional"
        ? curve.entries.filter((entry) => entry.order === order)
        : curve.entries.filter((entry) => entry.axisName === axis.name);
    const entry = candidates[0];
    const state: MermaidRadarVertex["state"] = ambiguousAxisName
      ? "duplicate"
      : !entry
        ? "missing"
        : candidates.length > 1
          ? "duplicate"
          : entry.value < minimum
            ? "clipped-low"
            : maximum !== null && entry.value > maximum
              ? "clipped-high"
              : "present";
    return {
      axisId: axis.id,
      curveId: curve.id,
      entryId: entry?.id,
      id: entry
        ? `radar-vertex-${curve.id}-${axis.id}-${entry.id}`
        : `radar-missing-${curve.id}-${axis.id}`,
      order,
      state,
      value: entry?.value,
    } satisfies MermaidRadarVertex;
  });
}

export function parseMermaidRadarSourceResult(
  source: string,
  previous?: MermaidRadarModel,
): MermaidRadarParseResult {
  const scanned = scanMermaidRadarSource(source);
  const records: MermaidRadarSourceRecord[] = [];
  const diagnostics: MermaidRadarDiagnostic[] = [];
  const occurrences = new Map<string, number>();
  const rawAxes: Array<
    NonNullable<ReturnType<typeof namedLabel>> & {
      record: Extract<MermaidRadarSourceRecord, { kind: "axis" }>;
    }
  > = [];
  const rawCurves: Array<
    NonNullable<ReturnType<typeof parseCurveSegment>> & {
      record: Extract<MermaidRadarSourceRecord, { kind: "curve" }>;
    }
  > = [];
  let headerSeen = false;

  for (let index = 0; index < scanned.lexicalRecords.length; index += 1) {
    const lexical = scanned.lexicalRecords[index];
    if (lexical.kind === "frontmatter" || lexical.kind === "directive") {
      records.push({
        ...recordIdentity(lexical.kind, lexical, occurrences),
        configFields: /radar/i.test(lexical.raw)
          ? radarConfigFieldRanges(lexical)
          : [],
        configScope: /radar/i.test(lexical.raw)
          ? radarConfigScope(lexical)
          : null,
        kind: lexical.kind,
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
      records.push({
        ...recordIdentity("comment", lexical, occurrences),
        kind: "comment",
      });
      continue;
    }
    const commentStart = inlineCommentStart(lexical.raw);
    const statementRaw =
      commentStart < 0
        ? lexical.raw
        : lexical.raw.slice(0, commentStart).trimEnd();
    const statementRange = offsetRadarRange(lexical, 0, statementRaw.length);
    const inlineComment =
      commentStart < 0
        ? null
        : {
            ...recordIdentity(
              "comment",
              lexical,
              occurrences,
              lexical.raw.slice(commentStart),
              offsetRadarRange(lexical, commentStart, lexical.raw.length),
            ),
            kind: "comment" as const,
          };
    const header = /^\s*radar-beta(\s*:\s*)?\s*$/.exec(statementRaw);
    if (!headerSeen) {
      if (!header) {
        return {
          diagnostic: createMermaidRadarDiagnostic(
            "invalid-header",
            statementRange,
            "diagram",
          ),
          model: null,
        };
      }
      headerSeen = true;
      const separator = header[1] ?? "";
      records.push({
        ...recordIdentity(
          "header",
          lexical,
          occurrences,
          statementRaw,
          statementRange,
        ),
        form: separator
          ? separator.startsWith(" ")
            ? "spaced-colon"
            : "colon"
          : "plain",
        kind: "header",
      });
      if (inlineComment) records.push(inlineComment);
      continue;
    }
    if (header) {
      return {
        diagnostic: createMermaidRadarDiagnostic(
          "ambiguous-source",
          statementRange,
          "diagram",
        ),
        model: null,
      };
    }
    if (
      /^\s*accDescr\s*\{/.test(statementRaw) &&
      !/\}\s*$/.test(statementRaw)
    ) {
      let combined = lexical.raw;
      let closed = false;
      let trailingComment: Extract<
        MermaidRadarSourceRecord,
        { kind: "comment" }
      > | null = null;
      let blockEnd = lexical.range.end;
      while (++index < scanned.lexicalRecords.length) {
        const current = scanned.lexicalRecords[index];
        const trailingCommentStart = inlineCommentStart(current.raw);
        const blockLine =
          trailingCommentStart < 0
            ? current.raw
            : current.raw.slice(0, trailingCommentStart).trimEnd();
        combined += scanned.newline + blockLine;
        blockEnd = current.range.end;
        if (!/\}\s*$/.test(blockLine)) continue;
        closed = true;
        blockEnd = current.range.start + blockLine.length;
        if (trailingCommentStart >= 0)
          trailingComment = {
            ...recordIdentity(
              "comment",
              current,
              occurrences,
              current.raw.slice(trailingCommentStart),
              offsetRadarRange(
                current,
                trailingCommentStart,
                current.raw.length,
              ),
            ),
            kind: "comment",
          };
        break;
      }
      const endLexical =
        scanned.lexicalRecords[
          Math.min(index, scanned.lexicalRecords.length - 1)
        ];
      const range = {
        end: blockEnd,
        endLine: endLexical.range.endLine,
        start: lexical.range.start,
        startLine: lexical.range.startLine,
      };
      if (!closed)
        return {
          diagnostic: createMermaidRadarDiagnostic(
            "ambiguous-source",
            range,
            "diagram",
          ),
          model: null,
        };
      const metadata = metadataRecord(
        { ...lexical, range, raw: combined },
        combined,
        range,
        occurrences,
      );
      if (metadata) records.push(metadata);
      else {
        const invalid = {
          ...recordIdentity("invalid", lexical, occurrences, combined, range),
          kind: "invalid" as const,
        };
        records.push(invalid);
        diagnostics.push(
          createMermaidRadarDiagnostic(
            "invalid-statement",
            range,
            "diagram",
            invalid.id,
          ),
        );
      }
      if (trailingComment) records.push(trailingComment);
      continue;
    }
    const metadata = metadataRecord(
      lexical,
      statementRaw,
      statementRange,
      occurrences,
    );
    if (metadata) {
      records.push(metadata);
      if (inlineComment) records.push(inlineComment);
      continue;
    }
    const axis = parseAxisStatement(
      lexical,
      statementRaw,
      statementRange,
      occurrences,
    );
    if (axis) {
      records.push(axis.record);
      axis.values.forEach((value) =>
        rawAxes.push({ ...value!, record: axis.record }),
      );
      if (!axis.record.valid)
        diagnostics.push(
          createMermaidRadarDiagnostic(
            "invalid-statement",
            statementRange,
            "axis",
            axis.record.id,
          ),
        );
      if (inlineComment) records.push(inlineComment);
      continue;
    }
    const curve = parseCurveStatement(
      lexical,
      statementRaw,
      statementRange,
      occurrences,
    );
    if (curve) {
      records.push(curve.record);
      curve.values.forEach((value) =>
        rawCurves.push({ ...value!, record: curve.record }),
      );
      if (!curve.record.valid)
        diagnostics.push(
          createMermaidRadarDiagnostic(
            curve.values.some((value) => value?.form === "mixed")
              ? "mixed-value-form"
              : "invalid-number",
            statementRange,
            "curve",
            curve.record.id,
          ),
        );
      if (inlineComment) records.push(inlineComment);
      continue;
    }
    const options = parseOptionStatement(
      lexical,
      statementRaw,
      statementRange,
      occurrences,
    );
    if (options) {
      records.push(options);
      if (!options.valid)
        diagnostics.push(
          createMermaidRadarDiagnostic(
            "invalid-option",
            statementRange,
            "option",
            options.id,
          ),
        );
      if (inlineComment) records.push(inlineComment);
      continue;
    }
    const invalid = {
      ...recordIdentity(
        "invalid",
        lexical,
        occurrences,
        statementRaw,
        statementRange,
      ),
      kind: "invalid" as const,
    };
    records.push(invalid);
    diagnostics.push(
      createMermaidRadarDiagnostic(
        "invalid-statement",
        statementRange,
        "diagram",
        invalid.id,
      ),
    );
    if (inlineComment) records.push(inlineComment);
  }

  if (!headerSeen) {
    return {
      diagnostic: createMermaidRadarDiagnostic(
        "invalid-header",
        radarRangeAtEnd({ lines: scanned.lines, source }),
        "diagram",
      ),
      model: null,
    };
  }
  reconcileRecords(records, previous?.sourceDocument);
  const sourceDocument: MermaidRadarSourceDocument = {
    endsWithNewline: scanned.endsWithNewline,
    lines: scanned.lines,
    newline: scanned.newline,
    records,
    source,
  };

  const usedAxisIds = new Set<string>();
  const reservedAxisIds = new Set(
    rawAxes.flatMap((raw) => {
      const matches = previous?.axes.filter((axis) => axis.name === raw.name);
      return matches?.length === 1 ? [matches[0].id] : [];
    }),
  );
  const axes: MermaidRadarAxis[] = rawAxes.flatMap((raw, order) => {
    if (!raw) return [];
    const nameOccurrence = rawAxes
      .slice(0, order)
      .filter((candidate) => candidate?.name === raw.name).length;
    const fingerprint = mermaidRadarFingerprint(
      `axis:${raw.name}:${nameOccurrence}`,
    );
    const id = identityForAxis(
      raw.name,
      fingerprint,
      raw.range.start,
      order,
      raw.record.id,
      rawAxes
        .slice(0, order)
        .filter((candidate) => candidate.record.id === raw.record.id).length,
      reservedAxisIds,
      usedAxisIds,
      previous,
    );
    const sourceRecord = raw.record;
    if (sourceRecord?.kind === "axis") {
      const sourceAxis = sourceRecord.axes.find(
        (candidate) => candidate.range.start === raw.range.start,
      );
      if (sourceAxis) sourceAxis.id = id;
    }
    return [
      {
        id,
        label: raw.label,
        labelExplicit: raw.labelExplicit,
        labelQuote: raw.labelQuote,
        name: raw.name,
        order,
        sourceFingerprint: fingerprint,
        sourceRangeStart: raw.range.start,
        sourceRecordId: sourceRecord.id,
      },
    ];
  });
  const duplicateAxisNames = new Set(
    axes
      .filter(
        (axis, index) =>
          axes.findIndex((candidate) => candidate.name === axis.name) !== index,
      )
      .map((axis) => axis.name),
  );
  for (const axis of axes.filter((candidate) =>
    duplicateAxisNames.has(candidate.name),
  ))
    diagnostics.push(
      createMermaidRadarDiagnostic(
        "duplicate-name",
        records.find((record) => record.id === axis.sourceRecordId)?.range ??
          radarRangeAtEnd(sourceDocument),
        "axis",
        axis.id,
      ),
    );

  const usedCurveIds = new Set<string>();
  const reservedCurveIds = new Set(
    rawCurves.flatMap((raw) => {
      const matches = previous?.curves.filter(
        (curve) => curve.name === raw.name,
      );
      return matches?.length === 1 ? [matches[0].id] : [];
    }),
  );
  const curvesWithoutVertices: Array<Omit<MermaidRadarCurve, "vertices">> =
    rawCurves.flatMap((raw, order) => {
      if (!raw) return [];
      const nameOccurrence = rawCurves
        .slice(0, order)
        .filter((candidate) => candidate?.name === raw.name).length;
      const fingerprint = mermaidRadarFingerprint(
        `curve:${raw.name}:${nameOccurrence}`,
      );
      const id = identityForCurve(
        raw.name,
        fingerprint,
        raw.range.start,
        order,
        raw.record.id,
        rawCurves
          .slice(0, order)
          .filter((candidate) => candidate.record.id === raw.record.id).length,
        reservedCurveIds,
        usedCurveIds,
        previous,
      );
      const sourceRecord = raw.record;
      const sourceCurve =
        sourceRecord?.kind === "curve"
          ? sourceRecord.curves.find(
              (candidate) => candidate.range.start === raw.range.start,
            )
          : undefined;
      if (sourceCurve) sourceCurve.id = id;
      const usedEntryIds = new Set<string>();
      const entries: MermaidRadarEntry[] = raw.entries.flatMap(
        (entry, entryOrder) => {
          if (!entry) return [];
          const axis = entry.axisName
            ? axes.find((candidate) => candidate.name === entry.axisName)
            : axes[entryOrder];
          // A value is mutable content, not vertex identity. Positional
          // entries belong to the projected Axis; detailed entries belong to
          // their Mermaid reference and local duplicate occurrence. Only an
          // unresolved extra has to retain its lexical anchor as a fallback.
          const referenceOccurrence = entry.axisName
            ? raw.entries
                .slice(0, entryOrder)
                .filter((candidate) => candidate?.axisName === entry.axisName)
                .length
            : 0;
          const entryOwner = entry.axisName
            ? `detailed:${entry.axisName}:${referenceOccurrence}`
            : axis
              ? `positional:${axis.id}`
              : `extra:${entry.source.range.start}`;
          const entryFingerprint = mermaidRadarFingerprint(entryOwner);
          const entryId = identityForEntry(
            id,
            axis?.id,
            entry.axisName,
            entryFingerprint,
            entry.source.range.start,
            entryOrder,
            usedEntryIds,
            previous,
          );
          const sourceEntry = sourceCurve?.entries.find(
            (candidate) => candidate.range.start === entry.source.range.start,
          );
          if (sourceEntry) sourceEntry.id = entryId;
          return [
            {
              axisId: axis?.id,
              axisName: entry.axisName,
              colon: entry.colon,
              id: entryId,
              order: entryOrder,
              precision: entry.precision,
              sourceFingerprint: entryFingerprint,
              sourceRangeStart: entry.source.range.start,
              status: axis ? "resolved" : entry.axisName ? "unknown" : "extra",
              value: entry.value,
            },
          ];
        },
      );
      if (raw.form === "detailed") {
        for (const entry of entries) {
          const matching = entries.filter(
            (candidate) => candidate.axisName === entry.axisName,
          );
          if (matching.length > 1)
            (entry as { status: MermaidRadarEntry["status"] }).status =
              "duplicate";
          if (entry.status === "unknown")
            diagnostics.push(
              createMermaidRadarDiagnostic(
                "unknown-reference",
                raw.range,
                "vertex",
                entry.id,
              ),
            );
          else if (entry.status === "duplicate")
            diagnostics.push(
              createMermaidRadarDiagnostic(
                "duplicate-reference",
                raw.range,
                "vertex",
                entry.id,
              ),
            );
        }
        for (const axis of axes) {
          if (!entries.some((entry) => entry.axisName === axis.name))
            diagnostics.push(
              createMermaidRadarDiagnostic(
                "missing-reference",
                raw.range,
                "vertex",
                id,
              ),
            );
        }
      } else if (entries.length !== axes.length) {
        diagnostics.push(
          createMermaidRadarDiagnostic(
            "length-mismatch",
            raw.range,
            "curve",
            id,
          ),
        );
      }
      return [
        {
          entries,
          id,
          label: raw.label,
          labelExplicit: raw.labelExplicit,
          labelQuote: raw.labelQuote,
          name: raw.name,
          order,
          sourceFingerprint: fingerprint,
          sourceForm: raw.form,
          sourceRangeStart: raw.range.start,
          sourceRecordId: sourceRecord.id,
        },
      ];
    });
  const duplicateCurveNames = new Set(
    curvesWithoutVertices
      .filter(
        (curve, index) =>
          curvesWithoutVertices.findIndex(
            (candidate) => candidate.name === curve.name,
          ) !== index,
      )
      .map((curve) => curve.name),
  );
  for (const curve of curvesWithoutVertices.filter((candidate) =>
    duplicateCurveNames.has(candidate.name),
  ))
    diagnostics.push(
      createMermaidRadarDiagnostic(
        "duplicate-name",
        records.find((record) => record.id === curve.sourceRecordId)?.range ??
          radarRangeAtEnd(sourceDocument),
        "curve",
        curve.id,
      ),
    );

  const explicit: MermaidRadarOptions["explicit"] = {};
  const sourceRecordIds: MermaidRadarOptions["sourceRecordIds"] = {};
  const projectOptionValue = (
    name: MermaidRadarOptionName,
    value: boolean | number | string,
  ) => {
    if (name === "showLegend") explicit.showLegend = value === true;
    else if (name === "graticule")
      explicit.graticule = value as "circle" | "polygon";
    else if (name === "ticks") explicit.ticks = Number(value);
    else if (name === "min") explicit.min = Number(value);
    else explicit.max = Number(value);
  };
  for (const record of records) {
    if (record.kind !== "options") continue;
    for (const option of record.options) {
      if (!option.valid) {
        const previousValue = previous?.options.explicit[option.name];
        if (
          previousValue !== undefined &&
          previous?.options.sourceRecordIds[option.name] === record.id
        ) {
          sourceRecordIds[option.name] = record.id;
          projectOptionValue(option.name, previousValue);
        }
        continue;
      }
      const raw = source.slice(option.valueRange.start, option.valueRange.end);
      sourceRecordIds[option.name] = record.id;
      projectOptionValue(
        option.name,
        option.name === "showLegend" ? raw === "true" : raw,
      );
    }
  }
  const renderableValues = curvesWithoutVertices.flatMap((curve) =>
    curve.entries
      .filter((entry) => entry.status === "resolved")
      .map((entry) => entry.value),
  );
  const minimum = explicit.min ?? DEFAULT_MERMAID_RADAR_OPTIONS.min;
  const maximum =
    explicit.max ??
    (renderableValues.length > 0 ? Math.max(...renderableValues) : null);
  if (
    (explicit.max !== undefined || curvesWithoutVertices.length > 0) &&
    (maximum === null || maximum <= minimum)
  )
    diagnostics.push(
      createMermaidRadarDiagnostic(
        "invalid-range",
        radarRangeAtEnd(sourceDocument),
        "option",
      ),
    );
  const options: MermaidRadarOptions = {
    effective: {
      graticule: explicit.graticule ?? DEFAULT_MERMAID_RADAR_OPTIONS.graticule,
      maximum,
      minimum,
      showLegend:
        explicit.showLegend ?? DEFAULT_MERMAID_RADAR_OPTIONS.showLegend,
      ticks: Math.min(
        32,
        explicit.ticks ?? DEFAULT_MERMAID_RADAR_OPTIONS.ticks,
      ),
    },
    explicit,
    sourceRecordIds,
  };
  const curves: MermaidRadarCurve[] = curvesWithoutVertices.map((curve) => ({
    ...curve,
    vertices: projectedVertices(axes, curve, minimum, maximum),
  }));

  const config: MermaidRadarConfig = {};
  let title = "";
  let accessibilityTitle = "";
  let accessibilityDescription = "";
  for (const record of records) {
    if (record.kind === "frontmatter" || record.kind === "directive") {
      for (const field of record.configFields) {
        const raw = source.slice(field.valueRange.start, field.valueRange.end);
        const value = parseConfigValue(raw);
        if (validConfigValue(field.field, value))
          (config as Record<string, boolean | number>)[field.field] = value!;
        else {
          const previousValue = previous?.config[field.field];
          if (previousValue !== undefined)
            (config as Record<string, boolean | number>)[field.field] =
              previousValue;
          diagnostics.push(
            createMermaidRadarDiagnostic(
              "invalid-config",
              field.valueRange,
              "config",
              record.id,
            ),
          );
        }
      }
    } else if (record.kind === "metadata" && record.valid) {
      const raw = source.slice(record.valueRange.start, record.valueRange.end);
      const value =
        record.format === "block"
          ? raw
              .split(/\r\n|\r|\n/)
              .map((line) => line.trim())
              .filter(Boolean)
              .join("\n")
          : raw.trim();
      if (record.field === "title") title = value;
      else if (record.field === "accessibilityTitle")
        accessibilityTitle = value;
      else accessibilityDescription = value;
    }
  }
  const projectedConfig = {
    ...DEFAULT_MERMAID_RADAR_CONFIG,
    ...config,
  };
  const configDiagnosis = mermaidRadarConfigDiagnosis(projectedConfig);
  if (
    configDiagnosis === "radar.config.horizontalGeometry" ||
    configDiagnosis === "radar.config.verticalGeometry"
  ) {
    const sourceRecord = records.findLast(
      (record) =>
        (record.kind === "frontmatter" || record.kind === "directive") &&
        record.configFields.length > 0,
    );
    if (sourceRecord) {
      diagnostics.push(
        createMermaidRadarDiagnostic(
          "invalid-config",
          sourceRecord.range,
          "config",
          sourceRecord.id,
        ),
      );
    }
    const fallback = {
      ...DEFAULT_MERMAID_RADAR_CONFIG,
      ...previous?.config,
    };
    if (configDiagnosis === "radar.config.horizontalGeometry") {
      config.width = fallback.width;
      config.marginLeft = fallback.marginLeft;
      config.marginRight = fallback.marginRight;
    } else {
      config.height = fallback.height;
      config.marginTop = fallback.marginTop;
      config.marginBottom = fallback.marginBottom;
    }
  }
  const comments: MermaidRadarComment[] = [];
  records.forEach((record, index) => {
    if (record.kind !== "comment") return;
    const previousRecord = records.slice(0, index).findLast(anchorRecord);
    const nextRecord = records.slice(index + 1).find(anchorRecord);
    const previousDistance = previousRecord
      ? record.range.startLine - previousRecord.range.endLine
      : Number.POSITIVE_INFINITY;
    const nextDistance = nextRecord
      ? nextRecord.range.startLine - record.range.endLine
      : Number.POSITIVE_INFINITY;
    const anchorSource =
      previousDistance <= nextDistance ? previousRecord : nextRecord;
    const position = anchorSource === previousRecord ? "after" : "before";
    record.anchorId = anchorSource?.id;
    comments.push({
      anchor: commentAnchor(anchorSource, axes, curves),
      id: `${record.id}-comment`,
      position,
      sourceRecordId: record.id,
      text: record.raw.replace(/^\s*%%\s?/, "").trimEnd(),
    });
    const ambiguousGroupedAnchor =
      anchorSource?.kind === "axis"
        ? axes.filter((axis) => axis.sourceRecordId === anchorSource.id)
            .length > 1
        : anchorSource?.kind === "curve"
          ? curves.filter((curve) => curve.sourceRecordId === anchorSource.id)
              .length > 1
          : false;
    if (ambiguousGroupedAnchor)
      diagnostics.push(
        createMermaidRadarDiagnostic(
          "ambiguous-source",
          record.range,
          "diagram",
          `${record.id}-comment`,
        ),
      );
  });
  const currentArchivedAxes = axes.map(
    ({ id, name, sourceFingerprint, sourceRangeStart }) => ({
      id,
      name,
      sourceFingerprint,
      sourceRangeStart,
    }),
  );
  const currentArchivedCurves = curves.map(
    ({ entries, id, name, sourceFingerprint, sourceRangeStart }) => ({
      entries: [
        ...entries.map(
          ({
            axisId,
            axisName,
            id: entryId,
            sourceFingerprint: entryFingerprint,
            sourceRangeStart: entryStart,
          }) => ({
            axisId,
            axisName,
            id: entryId,
            sourceFingerprint: entryFingerprint,
            sourceRangeStart: entryStart,
          }),
        ),
        ...(
          previous?.identityArchive.curves.find(
            (candidate) => candidate.id === id,
          )?.entries ?? []
        ).filter(
          (archived) => !entries.some((entry) => entry.id === archived.id),
        ),
      ].slice(0, 512),
      id,
      name,
      sourceFingerprint,
      sourceRangeStart,
    }),
  );
  const identityArchive: MermaidRadarIdentityArchive = {
    axes: [
      ...currentArchivedAxes,
      ...(previous?.identityArchive.axes ?? []).filter(
        (archived) => !axes.some((axis) => axis.id === archived.id),
      ),
    ].slice(0, 256),
    curves: [
      ...currentArchivedCurves,
      ...(previous?.identityArchive.curves ?? []).filter(
        (archived) => !curves.some((curve) => curve.id === archived.id),
      ),
    ].slice(0, 256),
  };
  return {
    model: {
      accessibilityDescription,
      accessibilityTitle,
      axes,
      comments,
      config,
      curves,
      diagnostics,
      diagramType: "radar",
      headerLine:
        records.find((record) => record.kind === "header")?.raw.trim() ??
        "radar-beta",
      identityArchive,
      options,
      sourceDocument,
      sourceHash: hashMermaidSource(source),
      title,
      version: 2,
    },
  };
}

export function parseMermaidRadarSource(
  source: string,
  previous?: MermaidRadarModel,
) {
  const result = parseMermaidRadarSourceResult(source, previous);
  return result.model;
}

export function effectiveMermaidRadarConfig(model: MermaidRadarModel) {
  return { ...DEFAULT_MERMAID_RADAR_CONFIG, ...model.config };
}
