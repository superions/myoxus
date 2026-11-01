// SPDX-License-Identifier: AGPL-3.0-or-later

import { hashMermaidSource } from "../../../utils.js";
import { decodeMermaidLangiumString } from "../../chart-string.js";
import { detectMermaidDiagramType } from "../../diagram-types.js";

import {
  createMermaidPieDiagnostic,
  type MermaidPieDiagnostic,
} from "./diagnostics.js";
import {
  DEFAULT_MERMAID_PIE_OPTIONS,
  type MermaidPieComment,
  type MermaidPieLegendPosition,
  type MermaidPieModel,
  type MermaidPieOptions,
  type MermaidPieSlice,
} from "./model.js";
import {
  mermaidPieFingerprint,
  mermaidPieRecordId,
  offsetPieRange,
  pieSourceFieldRanges,
  scanMermaidPieSource,
  type MermaidPieLexicalRecord,
  type MermaidPieSourceField,
  type MermaidPieSourceRange,
  type MermaidPieSourceRecord,
} from "./source-document.js";

export type MermaidPieParseResult =
  | { diagnostic: MermaidPieDiagnostic; model: null }
  | { diagnostic: null; model: MermaidPieModel };

const SLICE_RE =
  /^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*:\s*(-?(?:0|[1-9]\d*)(?:\.\d+)?)\s*$/;
const SLICE_PREFIX_RE =
  /^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*:\s*(.*?)\s*$/;
export const MERMAID_PIE_11_16_1_SYNTAX_CONTRACT = {
  accessibility: {
    guiOwner: "more",
    runtimeFields: ["accessibilityTitle", "accessibilityDescription"],
    sourceForms: ["accTitle-colon", "accDescr-colon", "accDescr-block"],
    writerRule: "patch-effective-metadata-record",
  },
  comments: {
    guiOwner: "chart-or-legend-marker",
    runtimeField: "comments",
    sourceForms: ["standalone-percent-comment", "inline-percent-comment"],
    writerRule: "patch-anchored-comment-record",
  },
  header: {
    accepted: "pie [showData]",
    guiOwner: "data-toggle",
    runtimeField: "showData",
    writerRule: "patch-header-token",
  },
  options: {
    donutHole: {
      guiOwner: "appearance",
      maximum: 0.9,
      minimum: 0,
      runtimeField: "options.donutHole",
    },
    highlightSlice: {
      guiOwner: "appearance",
      runtimeField: "options.highlightSlice",
    },
    legendPosition: {
      accepted: ["bottom", "center", "left", "right", "top"],
      guiOwner: "appearance",
      runtimeField: "options.legendPosition",
    },
    sourceForms: ["frontmatter-config-pie", "init-directive-pie"],
    textPosition: {
      guiOwner: "appearance",
      maximum: 1,
      minimum: 0,
      runtimeField: "options.textPosition",
    },
    writerRule: "patch-effective-option-field",
  },
  slices: {
    accepted: "quoted-label : finite-number",
    duplicateRuntimeRule: "first-label-statement-wins",
    guiOwner: "chart-legend-or-data",
    runtimeField: "slices",
    writerRule: "patch-exact-statement-field",
  },
  title: {
    guiOwner: "global-diagram-title",
    runtimeField: "title",
    sourceForms: ["title-statement", "frontmatter-title"],
    writerRule: "patch-effective-title-record",
  },
} as const;

const LEGEND_POSITIONS = new Set<MermaidPieLegendPosition>(
  MERMAID_PIE_11_16_1_SYNTAX_CONTRACT.options.legendPosition.accepted,
);

function decodeScalar(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return decodeMermaidLangiumString(trimmed).replaceAll("''", "'");
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function normalizedMetadata(value: string, multiline = false) {
  return multiline
    ? value
        .replace(/^\s+/gm, "")
        .replace(/[\t ]+$/gm, "")
        .replace(/[\t ]{2,}/g, " ")
        .trim()
    : value.trim().replace(/[\t ]{2,}/g, " ");
}

function decodeFrontmatterTitle(source: string, field: MermaidPieSourceField) {
  const raw = source.slice(field.valueRange.start, field.valueRange.end);
  const [indicator, ...body] = raw.split(/\r\n|\r|\n/);
  if (!/^[>|][+-]?\s*$/.test(indicator.trim())) return decodeScalar(raw);
  const lines = body.map((line) => line.replace(/^\s+/, ""));
  return indicator.trim().startsWith(">")
    ? lines
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ")
    : lines.join("\n").trim();
}

function splitInlineComment(raw: string) {
  let quote = "";
  for (let index = 0; index < raw.length - 1; index += 1) {
    const character = raw[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (raw.startsWith("%%", index)) {
      return {
        comment: raw.slice(index + 2).trim(),
        commentStart: index,
        syntax: raw.slice(0, index),
      };
    }
  }
  return { comment: "", commentStart: -1, syntax: raw };
}

function nextRecordId(
  kind: string,
  raw: string,
  occurrences: Map<string, number>,
) {
  const fingerprint = mermaidPieFingerprint(raw);
  const key = `${kind}:${fingerprint}`;
  const ordinal = occurrences.get(key) ?? 0;
  occurrences.set(key, ordinal + 1);
  return {
    fingerprint,
    id: mermaidPieRecordId(kind, fingerprint, ordinal),
  };
}

function optionValue(source: string, field: MermaidPieSourceField): string {
  return source.slice(field.valueRange.start, field.valueRange.end).trim();
}

function applyOptionField(
  source: string,
  field: MermaidPieSourceField,
  options: MermaidPieOptions,
  diagnostics: MermaidPieDiagnostic[],
  recordId: string,
) {
  const raw = optionValue(source, field);
  if (field.field === "textPosition" || field.field === "donutHole") {
    const value = Number(raw);
    const contract = MERMAID_PIE_11_16_1_SYNTAX_CONTRACT.options[field.field];
    const upper = contract.maximum;
    if (!Number.isFinite(value) || value < 0 || value > upper) {
      diagnostics.push(
        createMermaidPieDiagnostic(
          "invalid-option",
          `${field.field} must be between 0 and ${upper}.`,
          field.valueRange,
          recordId,
        ),
      );
      return false;
    }
    options[field.field] = value;
    return true;
  }
  const value = decodeScalar(raw);
  if (field.field === "legendPosition") {
    if (!LEGEND_POSITIONS.has(value as MermaidPieLegendPosition)) {
      diagnostics.push(
        createMermaidPieDiagnostic(
          "invalid-option",
          "legendPosition must be top, bottom, left, right, or center.",
          field.valueRange,
          recordId,
        ),
      );
      return false;
    }
    options.legendPosition = value as MermaidPieLegendPosition;
    return true;
  } else if (field.field === "highlightSlice") {
    options.highlightSlice = value;
    return true;
  }
  return false;
}

function hasNamedConfigScope(
  raw: string,
  field: MermaidPieSourceField,
  scope: "config" | "pie",
) {
  const relativeFieldStart = field.range.start;
  const scopePattern = new RegExp(
    `(?:^|[,{\\r\\n])\\s*["']?${scope}["']?\\s*:`,
    "gi",
  );
  for (const match of raw.matchAll(scopePattern)) {
    if (match.index === undefined || match.index > relativeFieldStart) continue;
    const keyOffset =
      match.index +
      Math.max(0, match[0].search(new RegExp(`["']?${scope}["']?\\s*:`, "i")));
    const colon = match.index + match[0].lastIndexOf(":");
    let valueStart = colon + 1;
    while (/[\t ]/.test(raw[valueStart] ?? "")) valueStart += 1;
    if (raw[valueStart] === "{") {
      let depth = 0;
      let quote = "";
      for (let index = valueStart; index < raw.length; index += 1) {
        const character = raw[index];
        if (quote) {
          if (character === "\\") index += 1;
          else if (character === quote) quote = "";
          continue;
        }
        if (character === '"' || character === "'") {
          quote = character;
          continue;
        }
        if (character === "{") depth += 1;
        if (character !== "}") continue;
        depth -= 1;
        if (depth === 0 && relativeFieldStart < index) return true;
        if (depth === 0) break;
      }
      continue;
    }

    const scopeLineStart = Math.max(
      raw.lastIndexOf("\n", keyOffset - 1),
      raw.lastIndexOf("\r", keyOffset - 1),
    );
    const scopeIndent =
      /^\s*/.exec(raw.slice(scopeLineStart + 1, keyOffset))?.[0].length ?? 0;
    const fieldLineStart = Math.max(
      raw.lastIndexOf("\n", relativeFieldStart - 1),
      raw.lastIndexOf("\r", relativeFieldStart - 1),
    );
    const fieldIndent =
      /^\s*/.exec(raw.slice(fieldLineStart + 1, relativeFieldStart))?.[0]
        .length ?? 0;
    if (fieldLineStart <= keyOffset || fieldIndent <= scopeIndent) continue;
    const intervening = raw
      .slice(colon + 1, fieldLineStart)
      .split(/\r\n|\r|\n/);
    const escapedScope = intervening.some((line) => {
      if (!line.trim() || line.trimStart().startsWith("#")) return false;
      return (line.match(/^\s*/)?.[0].length ?? 0) <= scopeIndent;
    });
    if (!escapedScope) return true;
  }
  return false;
}

function acceptedConfigField(
  lexical: MermaidPieLexicalRecord,
  field: MermaidPieSourceField,
) {
  if (field.field === "title") return lexical.kind === "frontmatter";
  if (
    lexical.kind === "directive" &&
    !/^%%\{\s*(?:init|initialize)\s*:/i.test(lexical.raw)
  ) {
    return false;
  }
  const relativeField = {
    ...field,
    range: {
      ...field.range,
      end: field.range.end - lexical.range.start,
      start: field.range.start - lexical.range.start,
    },
  };
  return (
    hasNamedConfigScope(lexical.raw, relativeField, "pie") &&
    (lexical.kind !== "frontmatter" ||
      hasNamedConfigScope(lexical.raw, relativeField, "config"))
  );
}

function reconcileSliceIds(
  slices: MermaidPieSlice[],
  previous: MermaidPieModel | undefined,
) {
  const recordIds = new Map<string, string>();
  const sliceIds = new Map<string, string>();
  if (!previous) return { recordIds, sliceIds };
  const previousByRecordId = new Map([
    ...previous.slices
      .map((slice) => ({
        id: slice.id,
        label: slice.label,
        sourceFingerprint: slice.sourceFingerprint,
        sourceRecordId: slice.sourceRecordId,
        value: slice.value,
      }))
      .map((statement) => [statement.sourceRecordId, statement] as const),
    ...previous.conflicts
      .map((conflict) => ({
        id: conflict.sliceId,
        label: conflict.label,
        sourceFingerprint: conflict.sourceFingerprint,
        sourceRecordId: conflict.sourceRecordId,
        value: conflict.value,
      }))
      .map((statement) => [statement.sourceRecordId, statement] as const),
  ]);
  const previousStatements = previous.sourceDocument.records.flatMap(
    (record) => {
      if (record.kind !== "slice") return [];
      const statement = previousByRecordId.get(record.id);
      return statement ? [statement] : [];
    },
  );
  const available = new Set(
    previousStatements.map((statement) => statement.id),
  );
  const reconciled = new Set<MermaidPieSlice>();
  const reconcile = (
    slice: MermaidPieSlice,
    previousSlice: (typeof previousStatements)[number],
  ) => {
    const provisionalSliceId = slice.id;
    const provisionalRecordId = slice.sourceRecordId;
    slice.id = previousSlice.id;
    sliceIds.set(provisionalSliceId, slice.id);
    if (provisionalRecordId && previousSlice.sourceRecordId) {
      slice.sourceRecordId = previousSlice.sourceRecordId;
      recordIds.set(provisionalRecordId, previousSlice.sourceRecordId);
    }
    available.delete(slice.id);
    reconciled.add(slice);
  };
  for (const slice of slices) {
    const exact = previousStatements.filter(
      (candidate) =>
        available.has(candidate.id) &&
        candidate.sourceFingerprint &&
        candidate.sourceFingerprint === slice.sourceFingerprint,
    );
    if (exact.length === 1) reconcile(slice, exact[0]);
  }
  for (let index = 0; index < slices.length; index += 1) {
    const slice = slices[index];
    if (reconciled.has(slice)) continue;
    const before = slices[index - 1]?.label ?? "";
    const after = slices[index + 1]?.label ?? "";
    const candidates = previousStatements
      .filter((candidate) => available.has(candidate.id))
      .map((candidate) => {
        const previousIndex = previousStatements.indexOf(candidate);
        let score = 0;
        if (candidate.label === slice.label) score += 6;
        if (candidate.value === slice.value) score += 3;
        if ((previousStatements[previousIndex - 1]?.label ?? "") === before)
          score += 2;
        if ((previousStatements[previousIndex + 1]?.label ?? "") === after)
          score += 2;
        return { candidate, score };
      })
      .sort((left, right) => right.score - left.score);
    if (
      !candidates[0] ||
      candidates[0].score < 3 ||
      candidates[0].score === candidates[1]?.score
    ) {
      continue;
    }
    reconcile(slice, candidates[0].candidate);
  }
  return { recordIds, sliceIds };
}

function reconcileCommentIds(
  comments: MermaidPieComment[],
  previous: MermaidPieModel | undefined,
) {
  const replacements = new Map<string, string>();
  if (!previous) return replacements;
  const available = new Set(previous.comments.map((comment) => comment.id));
  for (const comment of comments) {
    const candidates = previous.comments
      .filter((candidate) => available.has(candidate.id))
      .map((candidate) => {
        let score = 0;
        if (candidate.text === comment.text) score += 8;
        if (candidate.anchorKind === comment.anchorKind) score += 3;
        if (candidate.anchorId === comment.anchorId) score += 4;
        if (candidate.position === comment.position) score += 2;
        return { candidate, score };
      })
      .sort((left, right) => right.score - left.score);
    if (
      !candidates[0] ||
      candidates[0].score < 5 ||
      candidates[0].score === candidates[1]?.score
    ) {
      continue;
    }
    const oldId = comment.id;
    comment.id = candidates[0].candidate.id;
    replacements.set(oldId, comment.id);
    available.delete(comment.id);
  }
  return replacements;
}

function commentId(raw: string, occurrence: number) {
  return mermaidPieRecordId("comment", mermaidPieFingerprint(raw), occurrence);
}

function recordRangeFromLexicalGroup(
  records: readonly MermaidPieLexicalRecord[],
  start: number,
  end: number,
): MermaidPieSourceRange {
  return {
    end: records[end - 1].range.end,
    endLine: records[end - 1].range.endLine,
    start: records[start].range.start,
    startLine: records[start].range.startLine,
  };
}

export function parseMermaidPieSource(
  source: string,
  previous?: MermaidPieModel,
): MermaidPieModel | null {
  return parseMermaidPieSourceResult(source, previous).model;
}

export function parseMermaidPieSourceResult(
  source: string,
  previous?: MermaidPieModel,
): MermaidPieParseResult {
  const { document, lexicalRecords } = scanMermaidPieSource(source);
  const fallbackRange: MermaidPieSourceRange = {
    end: Math.min(source.length, 3),
    endLine: 1,
    start: 0,
    startLine: 0,
  };
  if (detectMermaidDiagramType(source) !== "pie") {
    return {
      diagnostic: createMermaidPieDiagnostic(
        "invalid-header",
        "Pie source requires a pie header.",
        fallbackRange,
      ),
      model: null,
    };
  }

  const diagnostics: MermaidPieDiagnostic[] = [];
  const directives: string[] = [];
  const comments: MermaidPieComment[] = [];
  const records: MermaidPieSourceRecord[] = [];
  const slices: MermaidPieSlice[] = [];
  const options: MermaidPieOptions = { ...DEFAULT_MERMAID_PIE_OPTIONS };
  const occurrences = new Map<string, number>();
  const commentOccurrences = new Map<string, number>();
  const pendingCommentIndexes: number[] = [];
  let accessibilityDescription = "";
  let accessibilityTitle = "";
  let headerSeen = false;
  let showData = false;
  let title = "";

  const addComment = (
    text: string,
    position: MermaidPieComment["position"],
    anchorKind: MermaidPieComment["anchorKind"] = "diagram",
    anchorId?: string,
  ) => {
    const normalized = text.trim();
    const occurrence = commentOccurrences.get(normalized) ?? 0;
    commentOccurrences.set(normalized, occurrence + 1);
    const comment: MermaidPieComment = {
      anchorId,
      anchorKind,
      id: commentId(normalized, occurrence),
      position,
      text: normalized,
    };
    comments.push(comment);
    return comment;
  };

  for (let index = 0; index < lexicalRecords.length; index += 1) {
    const lexical = lexicalRecords[index];
    const identity = nextRecordId(lexical.kind, lexical.raw, occurrences);
    if (lexical.kind === "frontmatter" || lexical.kind === "directive") {
      const sourceOwnerValid =
        lexical.kind === "frontmatter"
          ? /^---(?:\r\n|\r|\n)[\s\S]*---(?:\r\n|\r|\n)?$/.test(lexical.raw)
          : lexical.raw.endsWith("}%%");
      const fields = pieSourceFieldRanges(lexical).filter((field) =>
        acceptedConfigField(lexical, field),
      );
      const record: MermaidPieSourceRecord = {
        ...identity,
        fields,
        kind: lexical.kind,
        range: lexical.range,
        raw: lexical.raw,
      };
      records.push(record);
      if (lexical.kind === "frontmatter") {
        if (!sourceOwnerValid) {
          diagnostics.push(
            createMermaidPieDiagnostic(
              "unterminated-frontmatter",
              "The Mermaid frontmatter block is not terminated.",
              lexical.range,
              record.id,
            ),
          );
        }
        const titleField = fields.find((field) => field.field === "title");
        if (titleField) {
          if (sourceOwnerValid) {
            for (const candidate of records) {
              if (
                candidate.kind === "metadata" &&
                candidate.field === "title"
              ) {
                candidate.effective = false;
              }
            }
            title = decodeFrontmatterTitle(source, titleField);
          }
          records.push({
            ...nextRecordId(
              "metadata",
              source.slice(titleField.range.start, titleField.range.end),
              occurrences,
            ),
            effective: sourceOwnerValid,
            field: "title",
            format: "frontmatter",
            kind: "metadata",
            range: titleField.range,
            raw: source.slice(titleField.range.start, titleField.range.end),
            valid: sourceOwnerValid,
            valueRange: titleField.valueRange,
          });
        }
      } else {
        directives.push(lexical.raw);
        if (!sourceOwnerValid) {
          diagnostics.push(
            createMermaidPieDiagnostic(
              "unterminated-directive",
              "The Mermaid directive is not terminated.",
              lexical.range,
              record.id,
            ),
          );
        }
      }
      for (const field of fields) {
        if (
          field.field === "donutHole" ||
          field.field === "highlightSlice" ||
          field.field === "legendPosition" ||
          field.field === "textPosition"
        ) {
          const optionIdentity = nextRecordId(
            "option",
            source.slice(field.range.start, field.range.end),
            occurrences,
          );
          const candidateOptions = { ...options };
          const valid =
            sourceOwnerValid &&
            applyOptionField(
              source,
              field,
              candidateOptions,
              diagnostics,
              optionIdentity.id,
            );
          if (valid) {
            for (const candidate of records) {
              if (
                candidate.kind === "option" &&
                candidate.field === field.field
              ) {
                candidate.effective = false;
              }
            }
            Object.assign(options, candidateOptions);
          }
          records.push({
            ...optionIdentity,
            effective: valid,
            field: field.field,
            kind: "option",
            range: field.range,
            raw: source.slice(field.range.start, field.range.end),
            sourceOwnerId: record.id,
            valid,
            valueRange: field.valueRange,
          });
        }
      }
      continue;
    }

    const raw = lexical.raw;
    const trimmed = raw.trim();
    if (!trimmed) {
      records.push({
        ...identity,
        kind: "blank",
        range: lexical.range,
        raw,
      });
      pendingCommentIndexes.length = 0;
      continue;
    }
    if (trimmed.startsWith("%%")) {
      const comment = addComment(trimmed.slice(2), "before");
      records.push({
        ...identity,
        commentId: comment.id,
        kind: "comment",
        range: lexical.range,
        raw,
      });
      pendingCommentIndexes.push(comments.length - 1);
      continue;
    }

    const inline = splitInlineComment(raw);
    const syntax = inline.syntax.trim();
    const inlineComment = inline.comment
      ? addComment(inline.comment, "after")
      : undefined;
    if (!headerSeen) {
      const header = /^pie(?:\s+(showData))?$/.exec(syntax);
      if (!header) {
        return {
          diagnostic: createMermaidPieDiagnostic(
            "invalid-header",
            "Pie source requires exactly `pie` with optional `showData`.",
            lexical.range,
          ),
          model: null,
        };
      }
      headerSeen = true;
      showData = Boolean(header[1]);
      const showDataStart = header[1] ? raw.indexOf(header[1]) : -1;
      records.push({
        ...identity,
        inlineCommentId: inlineComment?.id,
        inlineCommentRange:
          inline.commentStart >= 0
            ? offsetPieRange(lexical, inline.commentStart, raw.length)
            : undefined,
        kind: "header",
        range: lexical.range,
        raw,
        showDataRange:
          showDataStart >= 0
            ? offsetPieRange(
                lexical,
                showDataStart,
                showDataStart + header[1].length,
              )
            : undefined,
      });
      if (inlineComment) inlineComment.anchorKind = "diagram";
      pendingCommentIndexes.length = 0;
      continue;
    }

    const titleMatch = /^title(?:\s+(.*?))?$/.exec(syntax);
    const accTitleMatch = /^accTitle\s*:\s*(.*?)$/.exec(syntax);
    const accDescrMatch = /^accDescr\s*:\s*(.*?)$/.exec(syntax);
    const accDescrBlock = /^accDescr\s*\{(.*)$/.exec(inline.syntax.trimStart());
    if (titleMatch || accTitleMatch || accDescrMatch || accDescrBlock) {
      let groupEnd = index + 1;
      let field: "accessibilityDescription" | "accessibilityTitle" | "title";
      let value = "";
      let valueStart = 0;
      let valueEnd = raw.length;
      let blockValueRange: MermaidPieSourceRange | undefined;
      let metadataValid = true;
      let resolvedInlineComment = inlineComment;
      let resolvedInlineCommentRange =
        inline.commentStart >= 0
          ? offsetPieRange(lexical, inline.commentStart, raw.length)
          : undefined;
      if (titleMatch) {
        field = "title";
        value = normalizedMetadata(titleMatch[1] ?? "");
        valueStart = titleMatch[1]
          ? raw.indexOf(titleMatch[1])
          : inline.commentStart >= 0
            ? inline.commentStart
            : inline.syntax.length;
        valueEnd = valueStart + (titleMatch[1]?.length ?? 0);
        title = value;
      } else if (accTitleMatch) {
        field = "accessibilityTitle";
        value = normalizedMetadata(accTitleMatch[1]);
        valueStart = accTitleMatch[1]
          ? raw.indexOf(accTitleMatch[1])
          : inline.commentStart >= 0
            ? inline.commentStart
            : inline.syntax.length;
        valueEnd = valueStart + accTitleMatch[1].length;
        accessibilityTitle = value;
      } else if (accDescrMatch) {
        field = "accessibilityDescription";
        value = normalizedMetadata(accDescrMatch[1]);
        valueStart = accDescrMatch[1]
          ? raw.indexOf(accDescrMatch[1])
          : inline.commentStart >= 0
            ? inline.commentStart
            : inline.syntax.length;
        valueEnd = valueStart + accDescrMatch[1].length;
        accessibilityDescription = value;
      } else {
        field = "accessibilityDescription";
        const blockParts = [accDescrBlock?.[1] ?? ""];
        let closed = blockParts[0].includes("}");
        let closingBrace = closed
          ? lexical.range.start + raw.indexOf("}", raw.indexOf("{") + 1)
          : -1;
        while (!closed && groupEnd < lexicalRecords.length) {
          const candidate = lexicalRecords[groupEnd];
          if (candidate.kind !== "line") break;
          blockParts.push(candidate.raw);
          groupEnd += 1;
          closed = candidate.raw.includes("}");
          if (closed) {
            const closeIndex = candidate.raw.indexOf("}");
            closingBrace = candidate.range.start + closeIndex;
            const remainder = candidate.raw.slice(closeIndex + 1);
            const commentMatch = /^\s*%%(.*)$/.exec(remainder);
            if (commentMatch) {
              resolvedInlineComment = addComment(
                commentMatch[1],
                "after",
                "metadata",
                field,
              );
              const commentStart = closeIndex + 1 + remainder.indexOf("%%");
              resolvedInlineCommentRange = offsetPieRange(
                candidate,
                commentStart,
                candidate.raw.length,
              );
            }
          }
        }
        const joined = blockParts.join(document.newline);
        const close = joined.indexOf("}");
        if (
          close < 0 ||
          joined
            .slice(close + 1)
            .trim()
            .replace(/^%%/, "")
            .trim()
        ) {
          metadataValid = false;
          diagnostics.push(
            createMermaidPieDiagnostic(
              "invalid-accessibility",
              "The multiline accDescr block is invalid or unterminated.",
              recordRangeFromLexicalGroup(lexicalRecords, index, groupEnd),
              identity.id,
            ),
          );
        } else {
          value = normalizedMetadata(joined.slice(0, close), true);
          accessibilityDescription = value;
        }
        valueStart = raw.indexOf("{") + 1;
        if (closingBrace >= 0) {
          blockValueRange = {
            end: closingBrace,
            endLine: lexicalRecords[groupEnd - 1].range.startLine + 1,
            start: lexical.range.start + valueStart,
            startLine: lexical.range.startLine,
          };
        }
      }
      const range = recordRangeFromLexicalGroup(
        lexicalRecords,
        index,
        groupEnd,
      );
      if (metadataValid) {
        for (const candidate of records) {
          if (candidate.kind === "metadata" && candidate.field === field) {
            candidate.effective = false;
          }
        }
      }
      records.push({
        ...identity,
        effective: metadataValid,
        field,
        format: "body",
        inlineCommentId: resolvedInlineComment?.id,
        inlineCommentRange: resolvedInlineCommentRange,
        kind: "metadata",
        range,
        raw: source.slice(range.start, range.end),
        valid: metadataValid,
        valueRange: blockValueRange ?? {
          end: Math.min(range.end, lexical.range.start + valueEnd),
          endLine: range.endLine,
          start: lexical.range.start + valueStart,
          startLine: lexical.range.startLine,
        },
      });
      for (const pending of pendingCommentIndexes) {
        comments[pending].anchorKind = "metadata";
        comments[pending].anchorId = field;
      }
      if (resolvedInlineComment) {
        resolvedInlineComment.anchorKind = "metadata";
        resolvedInlineComment.anchorId = field;
      }
      pendingCommentIndexes.length = 0;
      index = groupEnd - 1;
      continue;
    }

    const sliceMatch = SLICE_RE.exec(syntax);
    const slicePrefix = sliceMatch ? null : SLICE_PREFIX_RE.exec(syntax);
    if (sliceMatch) {
      const label = decodeMermaidLangiumString(sliceMatch[1]);
      const value = Number(sliceMatch[2]);
      const labelStart = raw.indexOf(sliceMatch[1]);
      const valueStart = raw.indexOf(
        sliceMatch[2],
        labelStart + sliceMatch[1].length,
      );
      const fingerprint = mermaidPieFingerprint(syntax);
      const recordId = identity.id;
      const sliceIdentity = nextRecordId("slice", syntax, occurrences);
      const slice: MermaidPieSlice = {
        id: sliceIdentity.id,
        label,
        order: slices.length,
        sourceFingerprint: fingerprint,
        sourceRecordId: recordId,
        value,
      };
      slices.push(slice);
      records.push({
        ...identity,
        inlineCommentId: inlineComment?.id,
        inlineCommentRange:
          inline.commentStart >= 0
            ? offsetPieRange(lexical, inline.commentStart, raw.length)
            : undefined,
        kind: "slice",
        labelRange: offsetPieRange(
          lexical,
          labelStart,
          labelStart + sliceMatch[1].length,
        ),
        range: lexical.range,
        raw,
        sliceId: slice.id,
        valueRange: offsetPieRange(
          lexical,
          valueStart,
          valueStart + sliceMatch[2].length,
        ),
      });
      if (value < 0) {
        diagnostics.push(
          createMermaidPieDiagnostic(
            "invalid-value",
            "Pie slice values must be greater than or equal to zero.",
            offsetPieRange(
              lexical,
              valueStart,
              valueStart + sliceMatch[2].length,
            ),
            recordId,
          ),
        );
      }
      for (const pending of pendingCommentIndexes) {
        comments[pending].anchorKind = "slice";
        comments[pending].anchorId = slice.id;
      }
      if (inlineComment) {
        inlineComment.anchorKind = "slice";
        inlineComment.anchorId = slice.id;
      }
      pendingCommentIndexes.length = 0;
      continue;
    }

    records.push({
      ...identity,
      kind: "invalid",
      range: lexical.range,
      raw,
    });
    diagnostics.push(
      createMermaidPieDiagnostic(
        slicePrefix ? "invalid-value" : "invalid-statement",
        slicePrefix
          ? "The Pie slice value is not a finite Mermaid number."
          : syntax === "showData"
            ? "Mermaid 11.17.2 accepts showData only on the pie header."
            : "This Pie statement is not recognized by Mermaid 11.17.2.",
        lexical.range,
        identity.id,
      ),
    );
    pendingCommentIndexes.length = 0;
  }

  if (!headerSeen) {
    return {
      diagnostic: createMermaidPieDiagnostic(
        "invalid-header",
        "Pie source requires a pie header.",
        fallbackRange,
      ),
      model: null,
    };
  }

  const sliceReconciliation = reconcileSliceIds(slices, previous);
  for (const record of records) {
    if (record.kind !== "slice") continue;
    record.id = sliceReconciliation.recordIds.get(record.id) ?? record.id;
    if (record.sliceId) {
      record.sliceId =
        sliceReconciliation.sliceIds.get(record.sliceId) ?? record.sliceId;
    }
  }
  for (const diagnostic of diagnostics) {
    if (!diagnostic.recordId) continue;
    diagnostic.recordId =
      sliceReconciliation.recordIds.get(diagnostic.recordId) ??
      diagnostic.recordId;
  }
  for (const comment of comments) {
    if (comment.anchorKind !== "slice" || !comment.anchorId) continue;
    comment.anchorId =
      sliceReconciliation.sliceIds.get(comment.anchorId) ?? comment.anchorId;
  }
  const commentIdReplacements = reconcileCommentIds(comments, previous);
  for (const record of records) {
    if (record.kind === "comment") {
      record.commentId =
        commentIdReplacements.get(record.commentId) ?? record.commentId;
    }
    if (
      (record.kind === "header" ||
        record.kind === "metadata" ||
        record.kind === "slice") &&
      record.inlineCommentId
    ) {
      record.inlineCommentId =
        commentIdReplacements.get(record.inlineCommentId) ??
        record.inlineCommentId;
    }
  }

  const conflicts: MermaidPieModel["conflicts"] = [];
  const firstByLabel = new Map<string, MermaidPieSlice>();
  for (const slice of slices) {
    const first = firstByLabel.get(slice.label);
    if (!first) {
      firstByLabel.set(slice.label, slice);
      continue;
    }
    const record = records.find(
      (candidate) =>
        candidate.kind === "slice" &&
        candidate.sliceId === slice.id &&
        candidate.id === slice.sourceRecordId,
    );
    if (!record || record.kind !== "slice") continue;
    record.conflictWith = first.id;
    record.sliceId = undefined;
    const diagnostic = createMermaidPieDiagnostic(
      "duplicate-label",
      `Mermaid renders only the first slice labelled “${slice.label}”; this later statement is preserved as a local conflict.`,
      record.labelRange,
      record.id,
    );
    diagnostics.push(diagnostic);
    conflicts.push({
      diagnosticId: diagnostic.id,
      firstSliceId: first.id,
      id: mermaidPieRecordId("conflict", mermaidPieFingerprint(record.id)),
      label: slice.label,
      sliceId: slice.id,
      sourceFingerprint: slice.sourceFingerprint ?? record.fingerprint,
      sourceRecordId: record.id,
      value: slice.value,
    });
  }
  const runtimeLabels = new Set<string>();
  const runtimeSlices = slices
    .filter((slice) => {
      if (runtimeLabels.has(slice.label)) return false;
      runtimeLabels.add(slice.label);
      return true;
    })
    .map((slice, order) => ({ ...slice, order }));

  document.records = records.sort(
    (left, right) =>
      left.range.start - right.range.start || left.range.end - right.range.end,
  );
  return {
    diagnostic: null,
    model: {
      accessibilityDescription,
      accessibilityTitle,
      comments,
      conflicts,
      diagramType: "pie",
      diagnostics,
      directives,
      headerLine: showData ? "pie showData" : "pie",
      options,
      showData,
      slices: runtimeSlices,
      sourceDocument: document,
      sourceHash: hashMermaidSource(source),
      title,
      version: 1,
    },
  };
}
