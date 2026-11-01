// SPDX-License-Identifier: AGPL-3.0-or-later

import { hashMermaidSource } from "../../../utils.js";
import { detectMermaidDiagramType } from "../../diagram-types.js";

import {
  createMermaidQuadrantDiagnostic,
  type MermaidQuadrantDiagnostic,
} from "./diagnostics.js";
import type {
  MermaidQuadrantClassDef,
  MermaidQuadrantComment,
  MermaidQuadrantCommentAnchor,
  MermaidQuadrantConfig,
  MermaidQuadrantInlineStyle,
  MermaidQuadrantModel,
  MermaidQuadrantPoint,
} from "./model.js";
import {
  mermaidQuadrantFingerprint,
  mermaidQuadrantRecordId,
  offsetQuadrantRange,
  quadrantConfigFieldRanges,
  reconcileQuadrantRecordIdentities,
  scanMermaidQuadrantSource,
  type MermaidQuadrantAxisForm,
  type MermaidQuadrantLexicalRecord,
  type MermaidQuadrantSourceDocument,
  type MermaidQuadrantSourceRecord,
  type MermaidQuadrantTextForm,
} from "./source-document.js";

export const MERMAID_QUADRANT_11_16_1_SYNTAX_CONTRACT = {
  accessibility: {
    guiOwner: "more",
    sourceForms: ["accTitle-colon", "accDescr-colon", "accDescr-block"],
    writerRule: "patch-effective-metadata-record",
  },
  axes: {
    acceptedForms: ["both", "single", "left-open"],
    guiOwner: "visible-axis-text",
    rejectedForms: ["right-only-open-arrow"],
    writerRule: "patch-preserved-axis-form",
  },
  config: {
    fields: [
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
    ],
    guiOwner: "appearance",
    sourceForms: ["frontmatter-config-quadrantChart", "init-directive"],
    writerRule: "patch-effective-config-field",
  },
  points: {
    acceptedLabelForms: ["plain", "quoted", "markdown"],
    classAssignment: "label:::class: [x, y]",
    coordinateRange: [0, 1],
    guiOwner: "chart-point",
    inlineStyles: ["radius", "color", "stroke-color", "stroke-width"],
    runtimeOrder: "reverse-builder-insertion",
    writerRule: "patch-exact-point-fields",
  },
  rejectedStatements: ["class", "section", "style"],
  title: {
    guiOwner: "global-diagram-title",
    writerRule: "patch-effective-title-record",
  },
} as const;

export type MermaidQuadrantParseResult =
  | { diagnostic: MermaidQuadrantDiagnostic; model: null }
  | { diagnostic: null; model: MermaidQuadrantModel };

const NUMBER = String.raw`(?:0(?:\.\d+)?|1(?:\.0+)?)`;
const AXIS_RE = /^\s*([xy])-axis\s+(.+?)\s*$/i;
const QUADRANT_RE = /^\s*quadrant-([1-4])\s+(.+?)\s*;?\s*$/i;
const POINT_RE = new RegExp(
  String.raw`^\s*(.+?)(?:[:]{3}\s*([A-Za-z]\w*))?\s*(?<!:):(?!:)\s*\[\s*(${NUMBER})\s*,\s*(${NUMBER})\s*\]\s*(.*?)\s*;?\s*$`,
);
const CLASS_DEF_RE = /^\s*classDef\s+([A-Za-z]\w*)\s+(.+?)\s*;?\s*$/i;

function normalizedLineValue(value: string) {
  return value.trim().replace(/[\t ]{2,}/g, " ");
}

export function decodeMermaidQuadrantText(source: string) {
  const trimmed = source.trim();
  if (trimmed.startsWith('"`') && trimmed.endsWith('`"')) {
    return {
      form: "markdown" as const,
      text: trimmed.slice(2, -2),
    };
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed) as unknown;
      return {
        form: "quoted" as const,
        text: typeof decoded === "string" ? decoded : trimmed.slice(1, -1),
      };
    } catch {
      return { form: "quoted" as const, text: trimmed.slice(1, -1) };
    }
  }
  return { form: "plain" as const, text: normalizedLineValue(trimmed) };
}

export function encodeMermaidQuadrantText(
  text: string,
  form: MermaidQuadrantTextForm,
) {
  const normalized = text.trim();
  if (form === "markdown") return `"\`${normalized}\`"`;
  if (form === "quoted") return JSON.stringify(normalized);
  return normalized;
}

function splitInlineComment(raw: string) {
  let quote = "";
  let markdown = false;
  for (let index = 0; index < raw.length - 1; index += 1) {
    const character = raw[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (quote === '"' && character === "`") markdown = !markdown;
      else if (character === quote && !markdown) quote = "";
      continue;
    }
    if (character === '"') {
      quote = character;
      markdown = raw[index + 1] === "`";
      continue;
    }
    if (raw.startsWith("%%", index)) {
      return {
        comment: raw.slice(index + 2).trim(),
        commentStart: index,
        syntax: raw.slice(0, index).trimEnd(),
      };
    }
  }
  return { comment: "", commentStart: -1, syntax: raw };
}

function nextRecordIdentity(
  kind: MermaidQuadrantSourceRecord["kind"],
  raw: string,
  occurrences: Map<string, number>,
) {
  const fingerprint = mermaidQuadrantFingerprint(raw);
  const key = `${kind}:${fingerprint}`;
  const ordinal = occurrences.get(key) ?? 0;
  occurrences.set(key, ordinal + 1);
  return {
    fingerprint,
    id: mermaidQuadrantRecordId(kind, fingerprint, ordinal),
  };
}

function sourceRecord(
  kind: MermaidQuadrantSourceRecord["kind"],
  lexical: MermaidQuadrantLexicalRecord,
  occurrences: Map<string, number>,
) {
  return {
    ...nextRecordIdentity(kind, lexical.raw, occurrences),
    range: lexical.range,
    raw: lexical.raw,
  };
}

function matchingRange(
  lexical: MermaidQuadrantLexicalRecord,
  value: string,
  from = 0,
) {
  const index = lexical.raw.indexOf(value, from);
  return offsetQuadrantRange(
    lexical,
    Math.max(0, index),
    Math.max(0, index) + value.length,
  );
}

function parseAxis(
  lexical: MermaidQuadrantLexicalRecord,
  syntax: string,
  occurrences: Map<string, number>,
): Extract<MermaidQuadrantSourceRecord, { kind: "axis" }> | null {
  const match = AXIS_RE.exec(syntax);
  if (!match) return null;
  const body = match[2].replace(/;\s*$/, "").trim();
  if (body.startsWith("-->")) return null;
  const arrow = body.indexOf("-->");
  let form: MermaidQuadrantAxisForm = "single";
  let start = body;
  let end: string | undefined;
  if (arrow >= 0) {
    start = body.slice(0, arrow).trim();
    end = body.slice(arrow + 3).trim();
    form = end ? "both" : "left-open";
  }
  if (!start) return null;
  const base = sourceRecord("axis", lexical, occurrences);
  const startRange = matchingRange(
    lexical,
    start,
    lexical.raw.indexOf(match[2]),
  );
  return {
    ...base,
    axis: match[1].toLowerCase() as "x" | "y",
    endRange: end
      ? matchingRange(lexical, end, startRange.end - lexical.range.start)
      : undefined,
    form,
    kind: "axis",
    startRange,
  };
}

function parseStyleList(raw: string) {
  const style: MermaidQuadrantInlineStyle = {};
  const diagnostics: Array<{ code: "invalid-style"; message: string }> = [];
  if (!raw.trim()) return { diagnostics, style };
  for (const item of raw.split(",")) {
    const [rawName, rawValue] = item.split(/\s*:\s*/, 2);
    const name = rawName?.trim();
    const value = rawValue?.trim() ?? "";
    if (name === "radius" && /^\d+$/.test(value)) style.radius = Number(value);
    else if (name === "color" && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value))
      style.color = value;
    else if (
      name === "stroke-color" &&
      /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)
    )
      style.strokeColor = value;
    else if (name === "stroke-width" && /^\d+px$/.test(value))
      style.strokeWidth = value;
    else
      diagnostics.push({
        code: "invalid-style",
        message: `Unsupported or invalid Quadrant style: ${item.trim()}.`,
      });
  }
  return { diagnostics, style };
}

function metadataRecord(
  lexical: MermaidQuadrantLexicalRecord,
  occurrences: Map<string, number>,
): MermaidQuadrantSourceRecord | null {
  const title = /^\s*title\s+(.+?)\s*;?\s*$/i.exec(lexical.raw);
  const accTitle = /^\s*accTitle\s*:\s*(.*?)\s*$/i.exec(lexical.raw);
  const accDescr = /^\s*accDescr\s*:\s*(.*?)\s*$/i.exec(lexical.raw);
  const match = title ?? accTitle ?? accDescr;
  if (!match) return null;
  const field = title
    ? "title"
    : accTitle
      ? "accessibilityTitle"
      : "accessibilityDescription";
  return {
    ...sourceRecord("metadata", lexical, occurrences),
    field,
    format: "line",
    kind: "metadata",
    valid: Boolean(match[1].trim()),
    valueRange: matchingRange(lexical, match[1]),
  };
}

function configValue(raw: string, field: string): unknown {
  if (field === "useMaxWidth") return raw === "true";
  if (field === "xAxisPosition" || field === "yAxisPosition") return raw;
  return Number(raw);
}

function semanticAnchor(
  record: MermaidQuadrantSourceRecord | undefined,
  axes: MermaidQuadrantModel["axes"],
  quadrantTexts: MermaidQuadrantModel["quadrantTexts"],
  points: readonly MermaidQuadrantPoint[],
  classes: readonly MermaidQuadrantClassDef[],
): MermaidQuadrantCommentAnchor {
  if (!record) return { kind: "diagram" };
  if (record.kind === "axis") return { id: axes[record.axis].id, kind: "axis" };
  if (record.kind === "quadrant")
    return { id: quadrantTexts[record.quadrant - 1].id, kind: "quadrantText" };
  if (record.kind === "point") {
    const point = points.find(
      (candidate) => candidate.sourceRecordId === record.id,
    );
    return point ? { id: point.id, kind: "point" } : { kind: "diagram" };
  }
  if (record.kind === "classDef") {
    const classDef = classes.find(
      (candidate) => candidate.sourceRecordId === record.id,
    );
    return classDef
      ? { id: classDef.id, kind: "classDef" }
      : { kind: "diagram" };
  }
  return { kind: "diagram" };
}

function isAnchorRecord(record: MermaidQuadrantSourceRecord) {
  return ["axis", "classDef", "header", "point", "quadrant"].includes(
    record.kind,
  );
}

export function parseMermaidQuadrantSourceResult(
  source: string,
  previousDocument?: MermaidQuadrantSourceDocument,
): MermaidQuadrantParseResult {
  const scanned = scanMermaidQuadrantSource(source);
  const diagnostics: MermaidQuadrantDiagnostic[] = [];
  const occurrences = new Map<string, number>();
  const records: MermaidQuadrantSourceRecord[] = [];
  let headerSeen = false;

  for (let index = 0; index < scanned.lexicalRecords.length; index += 1) {
    const lexical = scanned.lexicalRecords[index];
    if (lexical.kind === "frontmatter" || lexical.kind === "directive") {
      records.push({
        ...sourceRecord(lexical.kind, lexical, occurrences),
        configFields: lexical.raw.includes("quadrantChart")
          ? quadrantConfigFieldRanges(lexical)
          : [],
        kind: lexical.kind,
      });
      continue;
    }
    const trimmed = lexical.raw.trim();
    if (!trimmed) {
      records.push({
        ...sourceRecord("blank", lexical, occurrences),
        kind: "blank",
      });
      continue;
    }
    if (trimmed.startsWith("%%")) {
      const base = sourceRecord("comment", lexical, occurrences);
      records.push({
        ...base,
        commentId: `${base.id}-comment`,
        kind: "comment",
      });
      continue;
    }
    if (!headerSeen && /^quadrantChart\s*;?$/i.test(trimmed)) {
      records.push({
        ...sourceRecord("header", lexical, occurrences),
        kind: "header",
      });
      headerSeen = true;
      continue;
    }
    if (/^\s*accDescr\s*\{\s*$/i.test(lexical.raw)) {
      const start = lexical.range.start;
      let endIndex = index + 1;
      while (
        endIndex < scanned.lexicalRecords.length &&
        !/^\s*}\s*$/.test(scanned.lexicalRecords[endIndex].raw)
      ) {
        endIndex += 1;
      }
      if (endIndex < scanned.lexicalRecords.length) {
        const closing = scanned.lexicalRecords[endIndex];
        const raw = source.slice(start, closing.range.end);
        const combined: MermaidQuadrantLexicalRecord = {
          kind: "line",
          range: {
            end: closing.range.end,
            endLine: closing.range.endLine,
            start,
            startLine: lexical.range.startLine,
          },
          raw,
        };
        const openEnd = raw.indexOf("{") + 1;
        const closeStart = raw.lastIndexOf("}");
        records.push({
          ...sourceRecord("metadata", combined, occurrences),
          field: "accessibilityDescription",
          format: "block",
          kind: "metadata",
          valid: true,
          valueRange: offsetQuadrantRange(combined, openEnd, closeStart),
        });
        index = endIndex;
        continue;
      }
    }
    const metadata = metadataRecord(lexical, occurrences);
    if (metadata) {
      records.push(metadata);
      continue;
    }
    const inline = splitInlineComment(lexical.raw);
    const axis = parseAxis(lexical, inline.syntax, occurrences);
    if (axis) {
      records.push({
        ...axis,
        inlineCommentId: inline.comment
          ? `${axis.id}-inline-comment`
          : undefined,
        inlineCommentRange:
          inline.commentStart >= 0
            ? offsetQuadrantRange(
                lexical,
                inline.commentStart,
                lexical.raw.length,
              )
            : undefined,
      });
      continue;
    }
    const quadrant = QUADRANT_RE.exec(inline.syntax);
    if (quadrant) {
      const decoded = decodeMermaidQuadrantText(quadrant[2]);
      const base = sourceRecord("quadrant", lexical, occurrences);
      records.push({
        ...base,
        inlineCommentId: inline.comment
          ? `${base.id}-inline-comment`
          : undefined,
        inlineCommentRange:
          inline.commentStart >= 0
            ? offsetQuadrantRange(
                lexical,
                inline.commentStart,
                lexical.raw.length,
              )
            : undefined,
        kind: "quadrant",
        quadrant: Number(quadrant[1]) as 1 | 2 | 3 | 4,
        textForm: decoded.form,
        textRange: matchingRange(lexical, quadrant[2]),
      });
      continue;
    }
    const point = POINT_RE.exec(inline.syntax);
    if (point) {
      const base = sourceRecord("point", lexical, occurrences);
      const labelRange = matchingRange(lexical, point[1]);
      const classNameStart = point[2]
        ? lexical.raw.indexOf(point[2], labelRange.end - lexical.range.start)
        : -1;
      const xStart = lexical.raw.indexOf(
        point[3],
        (classNameStart >= 0
          ? classNameStart + point[2].length
          : labelRange.end) - lexical.range.start,
      );
      const yStart = lexical.raw.indexOf(point[4], xStart + point[3].length);
      const stylesStart = point[5]
        ? lexical.raw.indexOf(point[5], yStart + point[4].length)
        : -1;
      records.push({
        ...base,
        classNameRange:
          classNameStart >= 0
            ? offsetQuadrantRange(
                lexical,
                classNameStart,
                classNameStart + point[2].length,
              )
            : undefined,
        inlineCommentId: inline.comment
          ? `${base.id}-inline-comment`
          : undefined,
        inlineCommentRange:
          inline.commentStart >= 0
            ? offsetQuadrantRange(
                lexical,
                inline.commentStart,
                lexical.raw.length,
              )
            : undefined,
        kind: "point",
        labelForm: decodeMermaidQuadrantText(point[1]).form,
        labelRange,
        pointId: `${base.id}-point`,
        stylesRange:
          stylesStart >= 0
            ? offsetQuadrantRange(
                lexical,
                stylesStart,
                stylesStart + point[5].length,
              )
            : undefined,
        xRange: offsetQuadrantRange(lexical, xStart, xStart + point[3].length),
        yRange: offsetQuadrantRange(lexical, yStart, yStart + point[4].length),
      });
      continue;
    }
    const classDef = CLASS_DEF_RE.exec(inline.syntax);
    if (classDef) {
      const base = sourceRecord("classDef", lexical, occurrences);
      const nameRange = matchingRange(lexical, classDef[1]);
      records.push({
        ...base,
        classDefId: `${base.id}-class`,
        classNameRange: nameRange,
        inlineCommentId: inline.comment
          ? `${base.id}-inline-comment`
          : undefined,
        inlineCommentRange:
          inline.commentStart >= 0
            ? offsetQuadrantRange(
                lexical,
                inline.commentStart,
                lexical.raw.length,
              )
            : undefined,
        kind: "classDef",
        stylesRange: matchingRange(
          lexical,
          classDef[2],
          nameRange.end - lexical.range.start,
        ),
      });
      continue;
    }
    const invalid = {
      ...sourceRecord("invalid", lexical, occurrences),
      kind: "invalid" as const,
    };
    records.push(invalid);
    diagnostics.push(
      createMermaidQuadrantDiagnostic(
        /^(?:class|section|style)\b/i.test(trimmed)
          ? "unsupported-statement"
          : /^(?:x|y)-axis\b/i.test(trimmed)
            ? "invalid-axis"
            : "ambiguous-source",
        `Quadrant statement on line ${lexical.range.startLine + 1} cannot be edited safely.`,
        lexical.range,
        invalid.id,
      ),
    );
  }

  reconcileQuadrantRecordIdentities(records, previousDocument);
  scanned.document.records = records;

  const header = records.find((record) => record.kind === "header");
  if (!header || detectMermaidDiagramType(source) !== "quadrantChart") {
    const record =
      records.find((candidate) => candidate.kind === "invalid") ?? records[0];
    const range = record?.range ?? {
      end: source.length,
      endLine: 1,
      start: 0,
      startLine: 0,
    };
    return {
      diagnostic: createMermaidQuadrantDiagnostic(
        "ambiguous-source",
        "Quadrant source requires one unambiguous quadrantChart header.",
        range,
        record?.id ?? "quadrant-source",
      ),
      model: null,
    };
  }

  const axes: MermaidQuadrantModel["axes"] = {
    x: {
      end: "",
      endForm: "plain",
      form: "single",
      id: "quadrant-axis-x",
      role: "x",
      start: "",
      startForm: "plain",
    },
    y: {
      end: "",
      endForm: "plain",
      form: "single",
      id: "quadrant-axis-y",
      role: "y",
      start: "",
      startForm: "plain",
    },
  };
  const quadrantTexts = [1, 2, 3, 4].map((quadrant) => ({
    form: "plain" as const,
    id: `quadrant-text-${quadrant}`,
    quadrant: quadrant as 1 | 2 | 3 | 4,
    text: "",
  })) as MermaidQuadrantModel["quadrantTexts"];
  const points: MermaidQuadrantPoint[] = [];
  const classes: MermaidQuadrantClassDef[] = [];
  const config: MermaidQuadrantConfig = {};
  let title = "";
  let accessibilityTitle = "";
  let accessibilityDescription = "";

  for (const record of records) {
    if (record.kind === "frontmatter" || record.kind === "directive") {
      for (const field of record.configFields) {
        const raw = source.slice(field.valueRange.start, field.valueRange.end);
        const parsed = configValue(raw, field.field);
        const valid =
          (field.field === "useMaxWidth" && typeof parsed === "boolean") ||
          (field.field === "xAxisPosition" &&
            ["top", "bottom"].includes(String(parsed))) ||
          (field.field === "yAxisPosition" &&
            ["left", "right"].includes(String(parsed))) ||
          (typeof parsed === "number" &&
            Number.isFinite(parsed) &&
            parsed >= 0);
        if (valid) {
          Object.assign(config, { [field.field]: parsed });
        } else {
          diagnostics.push(
            createMermaidQuadrantDiagnostic(
              "invalid-config",
              `Invalid Quadrant config value for ${field.field}.`,
              field.valueRange,
              record.id,
            ),
          );
        }
      }
    } else if (record.kind === "metadata" && record.valid) {
      let value = source.slice(record.valueRange.start, record.valueRange.end);
      if (record.format === "block") {
        value = value
          .split(/\r\n|\r|\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .join("\n");
      } else value = normalizedLineValue(value);
      if (record.field === "title")
        title = decodeMermaidQuadrantText(value).text;
      else if (record.field === "accessibilityTitle")
        accessibilityTitle = value;
      else accessibilityDescription = value;
    } else if (record.kind === "axis") {
      const start = decodeMermaidQuadrantText(
        source.slice(record.startRange.start, record.startRange.end),
      );
      const end = record.endRange
        ? decodeMermaidQuadrantText(
            source.slice(record.endRange.start, record.endRange.end),
          )
        : { form: "plain" as const, text: "" };
      axes[record.axis] = {
        end: end.text,
        endForm: end.form,
        form: record.form,
        id: `quadrant-axis-${record.axis}`,
        role: record.axis,
        sourceRecordId: record.id,
        start: start.text,
        startForm: start.form,
      };
    } else if (record.kind === "quadrant") {
      const text = decodeMermaidQuadrantText(
        source.slice(record.textRange.start, record.textRange.end),
      );
      quadrantTexts[record.quadrant - 1] = {
        form: text.form,
        id: `quadrant-text-${record.quadrant}`,
        quadrant: record.quadrant,
        sourceRecordId: record.id,
        text: text.text,
      };
    } else if (record.kind === "point") {
      const label = decodeMermaidQuadrantText(
        source.slice(record.labelRange.start, record.labelRange.end),
      );
      const styleResult = parseStyleList(
        record.stylesRange
          ? source.slice(record.stylesRange.start, record.stylesRange.end)
          : "",
      );
      for (const finding of styleResult.diagnostics) {
        diagnostics.push(
          createMermaidQuadrantDiagnostic(
            finding.code,
            finding.message,
            record.stylesRange ?? record.range,
            record.id,
          ),
        );
      }
      points.push({
        className: record.classNameRange
          ? source.slice(record.classNameRange.start, record.classNameRange.end)
          : undefined,
        id: record.pointId ?? `${record.id}-point`,
        inlineStyle: styleResult.style,
        label: label.text,
        labelForm: label.form,
        order: points.length,
        runtimePaintOrder: 0,
        sourceFingerprint: record.fingerprint,
        sourceRecordId: record.id,
        x: Number(source.slice(record.xRange.start, record.xRange.end)),
        y: Number(source.slice(record.yRange.start, record.yRange.end)),
      });
    } else if (record.kind === "classDef") {
      const styleResult = parseStyleList(
        source.slice(record.stylesRange.start, record.stylesRange.end),
      );
      for (const finding of styleResult.diagnostics) {
        diagnostics.push(
          createMermaidQuadrantDiagnostic(
            finding.code,
            finding.message,
            record.stylesRange,
            record.id,
          ),
        );
      }
      classes.push({
        id: record.classDefId ?? `${record.id}-class`,
        name: source.slice(
          record.classNameRange.start,
          record.classNameRange.end,
        ),
        sourceRecordId: record.id,
        style: styleResult.style,
      });
    }
  }

  for (const point of points) {
    if (
      point.className &&
      !classes.some((classDef) => classDef.name === point.className)
    ) {
      diagnostics.push(
        createMermaidQuadrantDiagnostic(
          "invalid-class",
          `Quadrant point references missing class ${point.className}.`,
          records.find((record) => record.id === point.sourceRecordId)?.range ??
            header.range,
          point.sourceRecordId,
        ),
      );
    }
  }

  // Mermaid 11.17.2 inserts parsed points at the builder front. Its SVG
  // therefore paints the last source point first; retain source order for
  // editing while exposing the proven runtime overpaint order explicitly.
  points.forEach((point, sourceIndex) => {
    point.runtimePaintOrder = points.length - sourceIndex - 1;
  });

  const comments: MermaidQuadrantComment[] = [];
  records.forEach((record, index) => {
    if (record.kind === "comment") {
      const previousIndex = records
        .slice(0, index)
        .findLastIndex(isAnchorRecord);
      const resolvedPreviousIndex = previousIndex < 0 ? -1 : previousIndex;
      const nextOffset = records.slice(index + 1).findIndex(isAnchorRecord);
      const nextIndex = nextOffset < 0 ? -1 : index + 1 + nextOffset;
      const followsPreviousWithoutBlank =
        resolvedPreviousIndex >= 0 &&
        !records
          .slice(resolvedPreviousIndex + 1, index)
          .some((candidate) => candidate.kind === "blank");
      const usesPrevious =
        followsPreviousWithoutBlank ||
        (nextIndex < 0 && resolvedPreviousIndex >= 0);
      const anchorRecord = usesPrevious
        ? records[resolvedPreviousIndex]
        : nextIndex >= 0
          ? records[nextIndex]
          : resolvedPreviousIndex >= 0
            ? records[resolvedPreviousIndex]
            : undefined;
      comments.push({
        anchor: semanticAnchor(
          anchorRecord,
          axes,
          quadrantTexts,
          points,
          classes,
        ),
        id: record.commentId,
        position: usesPrevious ? "after" : "before",
        sourceRecordId: record.id,
        text: record.raw.trim().replace(/^%%\s*/, ""),
      });
    } else if (
      "inlineCommentId" in record &&
      record.inlineCommentId &&
      record.inlineCommentRange
    ) {
      comments.push({
        anchor: semanticAnchor(record, axes, quadrantTexts, points, classes),
        id: record.inlineCommentId,
        position: "after",
        sourceRecordId: record.id,
        text: source
          .slice(record.inlineCommentRange.start, record.inlineCommentRange.end)
          .replace(/^%%\s*/, "")
          .trim(),
      });
    }
  });

  const model: MermaidQuadrantModel = {
    accessibilityDescription,
    accessibilityTitle,
    axes,
    classes,
    comments,
    config,
    diagnostics,
    diagramType: "quadrantChart",
    directives: records
      .filter(
        (record) =>
          record.kind === "directive" || record.kind === "frontmatter",
      )
      .map((record) => record.raw),
    headerLine: header.raw.trim(),
    points,
    quadrantLabels: quadrantTexts.map((item) => item.text) as [
      string,
      string,
      string,
      string,
    ],
    quadrantTexts,
    sourceDocument: scanned.document,
    sourceHash: hashMermaidSource(source),
    title,
    version: 2,
    xAxisEnd: axes.x.end,
    xAxisStart: axes.x.start,
    yAxisEnd: axes.y.end,
    yAxisStart: axes.y.start,
  };
  return { diagnostic: null, model };
}

export function parseMermaidQuadrantSource(
  source: string,
  previousDocument?: MermaidQuadrantSourceDocument,
) {
  return parseMermaidQuadrantSourceResult(source, previousDocument).model;
}
