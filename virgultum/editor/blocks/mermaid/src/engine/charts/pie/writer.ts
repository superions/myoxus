// SPDX-License-Identifier: AGPL-3.0-or-later

import { hashMermaidSource } from "../../../utils.js";
import { mermaidChartDecimal } from "../../chart-number.js";
import { encodeMermaidLangiumString } from "../../chart-string.js";

import {
  applyMermaidPieCommand,
  type MermaidPieCommand,
  type MermaidPieCommandDiagnosis,
  type MermaidPieCommandResult,
  type MermaidPieCommandSelection,
} from "./commands.js";
import type { MermaidPieDiagnostic } from "./diagnostics.js";
import type { MermaidPieModel, MermaidPieOptions } from "./model.js";
import { parseMermaidPieSourceResult } from "./parser.js";
import type { MermaidPieSourceRecord } from "./source-document.js";

type MermaidPieSourcePatch = {
  readonly end: number;
  readonly replacement: string;
  readonly start: number;
};

type MermaidPieCommentOwnerRecord = Extract<
  MermaidPieSourceRecord,
  { kind: "comment" | "header" | "metadata" | "slice" }
>;

function normalizedSingleLine(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizedCommentText(value: string) {
  return value.trim().replace(/^%%\s*/, "");
}

export type MermaidPieSourceApplyIntent =
  "cancel" | "commit" | "draft" | "escape" | "invalid" | "preview";

export type MermaidPieSourceApplyInput = {
  readonly baseSourceHash?: string;
  readonly command: MermaidPieCommand;
  readonly intent?: MermaidPieSourceApplyIntent;
  readonly previousModel?: MermaidPieModel;
  readonly readonly?: boolean;
  readonly source: string;
};

export type MermaidPieSourceApplyResult = {
  readonly anchorMapping: Readonly<Record<string, string>>;
  readonly changed: boolean;
  readonly command: MermaidPieCommandResult | null;
  readonly diagnosis: MermaidPieCommandDiagnosis;
  readonly diagnostics: readonly MermaidPieDiagnostic[];
  readonly model: MermaidPieModel | null;
  readonly selectionAfter: MermaidPieCommandSelection;
  readonly source: string;
};

function applyPatches(
  source: string,
  patches: readonly MermaidPieSourcePatch[],
) {
  const ordered = [...patches].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].start < ordered[index].end) {
      throw new Error("Overlapping Pie source patches");
    }
  }
  return ordered.reduce(
    (current, patch) =>
      `${current.slice(0, patch.start)}${patch.replacement}${current.slice(patch.end)}`,
    source,
  );
}

function sliceRecord(model: MermaidPieModel, sliceId: string) {
  const slice = model.slices.find((candidate) => candidate.id === sliceId);
  if (!slice?.sourceRecordId) return undefined;
  return model.sourceDocument.records.find(
    (record): record is Extract<MermaidPieSourceRecord, { kind: "slice" }> =>
      record.kind === "slice" && record.id === slice.sourceRecordId,
  );
}

function effectiveMetadata(
  model: MermaidPieModel,
  field: "accessibilityDescription" | "accessibilityTitle" | "title",
) {
  return model.sourceDocument.records.find(
    (record): record is Extract<MermaidPieSourceRecord, { kind: "metadata" }> =>
      record.kind === "metadata" &&
      record.field === field &&
      record.effective &&
      record.valid,
  );
}

function effectiveOption(
  model: MermaidPieModel,
  field: keyof MermaidPieOptions,
) {
  return model.sourceDocument.records.find(
    (record): record is Extract<MermaidPieSourceRecord, { kind: "option" }> =>
      record.kind === "option" &&
      record.field === field &&
      record.effective &&
      record.valid,
  );
}

function headerRecord(model: MermaidPieModel) {
  return model.sourceDocument.records.find(
    (record): record is Extract<MermaidPieSourceRecord, { kind: "header" }> =>
      record.kind === "header",
  );
}

function encodedScalarLike(raw: string, value: string, newline: string) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (/^[>|][+-]?(?:\r\n|\r|\n|$)/.test(trimmed)) {
    const [indicator] = trimmed.split(/\r\n|\r|\n/);
    const indentation = raw.match(/(?:\r\n|\r|\n)([\t ]+)\S/)?.[1] ?? "  ";
    return `${indicator}${newline}${value
      .split(/\r\n|\r|\n/)
      .map((line) => `${indentation}${line}`)
      .join(newline)}`;
  }
  return value && !/[#:\r\n]/.test(value) ? value : JSON.stringify(value);
}

function encodedOptionValue(
  raw: string,
  value: MermaidPieOptions[keyof MermaidPieOptions],
) {
  if (typeof value === "number") return mermaidChartDecimal(value);
  const trimmed = raw.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return /^[^,\s}\r\n#]+$/.test(value) ? value : JSON.stringify(value);
}

function encodedSliceLabelLike(raw: string, value: string) {
  return raw.startsWith("'")
    ? `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
    : encodeMermaidLangiumString(value);
}

function insertionAfterRecord(
  model: MermaidPieModel,
  record: MermaidPieSourceRecord,
  line: string,
): MermaidPieSourcePatch {
  return {
    end: record.range.end,
    replacement: `${model.sourceDocument.newline}${line}`,
    start: record.range.end,
  };
}

function bodyMetadataLine(
  field: "accessibilityDescription" | "accessibilityTitle" | "title",
  value: string,
  indent: string,
  newline: string,
) {
  if (field === "title") return `${indent}title ${value}`;
  if (field === "accessibilityTitle") return `${indent}accTitle: ${value}`;
  if (!value.includes("\n") && !value.includes("\r")) {
    return `${indent}accDescr: ${value}`;
  }
  const childIndent = `${indent}  `;
  return `${indent}accDescr {${newline}${value
    .split(/\r\n|\r|\n/)
    .map((line) => `${childIndent}${line}`)
    .join(newline)}${newline}${indent}}`;
}

function metadataPatch(
  model: MermaidPieModel,
  field: "accessibilityDescription" | "accessibilityTitle" | "title",
  value: string,
): MermaidPieSourcePatch | null {
  const record = effectiveMetadata(model, field);
  if (!record) {
    const header = headerRecord(model);
    if (!header) return null;
    const indent = header.raw.match(/^\s*/)?.[0] ?? "";
    return insertionAfterRecord(
      model,
      header,
      bodyMetadataLine(
        field,
        value,
        `${indent}  `,
        model.sourceDocument.newline,
      ),
    );
  }
  const source = model.sourceDocument.source;
  if (record.format === "frontmatter") {
    const raw = source.slice(record.valueRange.start, record.valueRange.end);
    return {
      end: record.valueRange.end,
      replacement: encodedScalarLike(raw, value, model.sourceDocument.newline),
      start: record.valueRange.start,
    };
  }
  if (
    field === "accessibilityDescription" &&
    (record.raw.includes("{") || value.includes("\n") || value.includes("\r"))
  ) {
    const indent = record.raw.match(/^\s*/)?.[0] ?? "";
    const inlineComment = record.inlineCommentRange
      ? source.slice(
          record.inlineCommentRange.start,
          record.inlineCommentRange.end,
        )
      : "";
    return {
      end: record.range.end,
      replacement: `${bodyMetadataLine(
        field,
        value,
        indent,
        model.sourceDocument.newline,
      )}${inlineComment ? ` ${inlineComment.trimStart()}` : ""}`,
      start: record.range.start,
    };
  }
  return {
    end: record.valueRange.end,
    replacement: value,
    start: record.valueRange.start,
  };
}

function showDataPatch(model: MermaidPieModel, showData: boolean) {
  const header = headerRecord(model);
  if (!header) return null;
  if (!showData && header.showDataRange) {
    const source = model.sourceDocument.source;
    let start = header.showDataRange.start;
    while (
      start > header.range.start &&
      /[\t ]/.test(source[start - 1] ?? "")
    ) {
      start -= 1;
    }
    return { end: header.showDataRange.end, replacement: "", start };
  }
  if (showData && !header.showDataRange) {
    const source = model.sourceDocument.source;
    const syntaxEnd = header.inlineCommentRange?.start ?? header.range.end;
    let insertion = syntaxEnd;
    while (
      insertion > header.range.start &&
      /[\t ]/.test(source[insertion - 1] ?? "")
    ) {
      insertion -= 1;
    }
    return { end: insertion, replacement: " showData", start: insertion };
  }
  return null;
}

function optionPatch(
  model: MermaidPieModel,
  field: keyof MermaidPieOptions,
  value: MermaidPieOptions[keyof MermaidPieOptions],
) {
  const record = effectiveOption(model, field);
  if (record) {
    const raw = model.sourceDocument.source.slice(
      record.valueRange.start,
      record.valueRange.end,
    );
    return {
      end: record.valueRange.end,
      replacement: encodedOptionValue(raw, value),
      start: record.valueRange.start,
    };
  }
  const header = headerRecord(model);
  if (!header) return null;
  const encoded =
    typeof value === "number"
      ? mermaidChartDecimal(value)
      : JSON.stringify(value);
  return {
    end: header.range.start,
    replacement: `%%{init: {"pie": {"${field}": ${encoded}}}}%%${model.sourceDocument.newline}`,
    start: header.range.start,
  };
}

function appearancePatches(
  model: MermaidPieModel,
  showData: boolean,
  options: MermaidPieOptions,
) {
  const patches: MermaidPieSourcePatch[] = [];
  if (model.showData !== showData) {
    const patch = showDataPatch(model, showData);
    if (!patch) return null;
    patches.push(patch);
  }
  const missing: Array<
    [keyof MermaidPieOptions, MermaidPieOptions[keyof MermaidPieOptions]]
  > = [];
  for (const [field, value] of Object.entries(options) as Array<
    [keyof MermaidPieOptions, MermaidPieOptions[keyof MermaidPieOptions]]
  >) {
    if (model.options[field] === value) continue;
    if (!effectiveOption(model, field)) {
      missing.push([field, value]);
      continue;
    }
    const patch = optionPatch(model, field, value);
    if (!patch) return null;
    patches.push(patch);
  }
  if (missing.length) {
    const header = headerRecord(model);
    if (!header) return null;
    const entries = missing
      .map(([field, value]) => {
        const encoded =
          typeof value === "number"
            ? mermaidChartDecimal(value)
            : JSON.stringify(value);
        return `"${field}": ${encoded}`;
      })
      .join(", ");
    patches.push({
      end: header.range.start,
      replacement: `%%{init: {"pie": {${entries}}}}%%${model.sourceDocument.newline}`,
      start: header.range.start,
    });
  }
  return patches;
}

function accessibilityPatches(
  model: MermaidPieModel,
  title: string,
  description: string,
) {
  const normalizedTitle = normalizedSingleLine(title);
  const normalizedDescription = description.trim();
  const patches: MermaidPieSourcePatch[] = [];
  const missing: Array<{
    readonly field: "accessibilityDescription" | "accessibilityTitle";
    readonly value: string;
  }> = [];
  for (const { field, value } of [
    { field: "accessibilityTitle", value: normalizedTitle },
    { field: "accessibilityDescription", value: normalizedDescription },
  ] as const) {
    if (model[field] === value) continue;
    const record = effectiveMetadata(model, field);
    if (!record) {
      if (value) missing.push({ field, value });
      continue;
    }
    if (!value) {
      const inlineComment = record.inlineCommentRange
        ? model.sourceDocument.source
            .slice(
              record.inlineCommentRange.start,
              record.inlineCommentRange.end,
            )
            .trimStart()
        : "";
      patches.push({
        end: record.range.end,
        replacement: inlineComment
          ? `${record.raw.match(/^\s*/)?.[0] ?? ""}${inlineComment}`
          : "",
        start: record.range.start,
      });
      continue;
    }
    const patch = metadataPatch(model, field, value);
    if (!patch) return null;
    patches.push(patch);
  }
  if (missing.length) {
    const header = headerRecord(model);
    if (!header) return null;
    const indent = `${header.raw.match(/^\s*/)?.[0] ?? ""}  `;
    patches.push(
      insertionAfterRecord(
        model,
        header,
        missing
          .map(({ field, value }) =>
            bodyMetadataLine(
              field,
              value,
              indent,
              model.sourceDocument.newline,
            ),
          )
          .join(model.sourceDocument.newline),
      ),
    );
  }
  return patches;
}

function inlineCommentPatchRange(
  model: MermaidPieModel,
  range: { readonly end: number; readonly start: number },
  replacement: string,
) {
  const source = model.sourceDocument.source;
  const raw = source.slice(range.start, range.end);
  const marker = raw.indexOf("%%");
  if (marker < 0) return null;
  let textStart = marker + 2;
  while (/[\t ]/.test(raw[textStart] ?? "")) textStart += 1;
  let textEnd = raw.length;
  while (textEnd > textStart && /[\t ]/.test(raw[textEnd - 1] ?? ""))
    textEnd -= 1;
  return {
    end: range.start + textEnd,
    replacement,
    start: range.start + textStart,
  };
}

function commentOwnerRecord(model: MermaidPieModel, commentId: string) {
  return model.sourceDocument.records.find(
    (record): record is MermaidPieCommentOwnerRecord => {
      if (record.kind === "comment") return record.commentId === commentId;
      return (
        (record.kind === "header" ||
          record.kind === "metadata" ||
          record.kind === "slice") &&
        record.inlineCommentId === commentId
      );
    },
  );
}

function ownerCommentId(record: MermaidPieSourceRecord) {
  if (record.kind === "comment") return record.commentId;
  if (
    record.kind === "header" ||
    record.kind === "metadata" ||
    record.kind === "slice"
  ) {
    return record.inlineCommentId;
  }
  return undefined;
}

function setOwnerCommentId(record: MermaidPieSourceRecord, commentId: string) {
  if (record.kind === "comment") record.commentId = commentId;
  else if (
    record.kind === "header" ||
    record.kind === "metadata" ||
    record.kind === "slice"
  ) {
    record.inlineCommentId = commentId;
  }
}

function updateCommentPatch(
  model: MermaidPieModel,
  commentId: string,
  text: string,
) {
  const record = commentOwnerRecord(model, commentId);
  if (!record) return null;
  if (record.kind === "comment") {
    return inlineCommentPatchRange(model, record.range, text);
  }
  return record.inlineCommentRange
    ? inlineCommentPatchRange(model, record.inlineCommentRange, text)
    : null;
}

function deleteCommentPatch(model: MermaidPieModel, commentId: string) {
  const record = commentOwnerRecord(model, commentId);
  if (!record) return null;
  if (record.kind === "comment") {
    return {
      end: record.range.end,
      replacement: "",
      start: record.range.start,
    };
  }
  if (!record.inlineCommentRange) return null;
  const source = model.sourceDocument.source;
  let start = record.inlineCommentRange.start;
  while (start > record.range.start && /[\t ]/.test(source[start - 1] ?? "")) {
    start -= 1;
  }
  return { end: record.inlineCommentRange.end, replacement: "", start };
}

function addCommentPatch(
  model: MermaidPieModel,
  command: Extract<MermaidPieCommand, { type: "comment.add" }>,
) {
  const text = normalizedCommentText(command.text);
  const newline = model.sourceDocument.newline;
  if (command.anchor.kind === "slice") {
    const record = sliceRecord(model, command.anchor.sliceId);
    if (!record) return null;
    if (command.position === "after") {
      if (record.inlineCommentId) return null;
      return {
        end: record.range.end,
        replacement: ` %% ${text}`,
        start: record.range.end,
      };
    }
    const indent = record.raw.match(/^\s*/)?.[0] ?? "";
    return {
      end: record.range.start,
      replacement: `${indent}%% ${text}${newline}`,
      start: record.range.start,
    };
  }
  const header = headerRecord(model);
  if (!header) return null;
  if (command.position === "after") {
    if (header.inlineCommentId) return null;
    return {
      end: header.range.end,
      replacement: ` %% ${text}`,
      start: header.range.end,
    };
  }
  const indent = header.raw.match(/^\s*/)?.[0] ?? "";
  return {
    end: header.range.start,
    replacement: `${indent}%% ${text}${newline}`,
    start: header.range.start,
  };
}

function sourceSliceWithoutInlineComment(
  source: string,
  record: Extract<MermaidPieSourceRecord, { kind: "slice" }>,
) {
  if (!record.inlineCommentRange)
    return source.slice(record.range.start, record.range.end);
  let end = record.inlineCommentRange.start;
  while (end > record.range.start && /[\t ]/.test(source[end - 1] ?? ""))
    end -= 1;
  return source.slice(record.range.start, end);
}

function destinationInlineComment(
  source: string,
  record: Extract<MermaidPieSourceRecord, { kind: "slice" }>,
) {
  if (!record.inlineCommentRange) return "";
  let start = record.inlineCommentRange.start;
  while (start > record.range.start && /[\t ]/.test(source[start - 1] ?? ""))
    start -= 1;
  return source.slice(start, record.range.end);
}

function reorderPatches(
  model: MermaidPieModel,
  next: MermaidPieModel,
): MermaidPieSourcePatch[] | null {
  const source = model.sourceDocument.source;
  const destinationRecords = model.slices.map((slice) =>
    sliceRecord(model, slice.id),
  );
  if (destinationRecords.some((record) => !record)) return null;
  const sourceBySliceId = new Map(
    model.slices.map(
      (slice) => [slice.id, sliceRecord(model, slice.id)] as const,
    ),
  );
  return destinationRecords.flatMap((destination, index) => {
    if (!destination) return [];
    const nextSlice = next.slices[index];
    const origin = nextSlice ? sourceBySliceId.get(nextSlice.id) : undefined;
    if (!origin) return [];
    const replacement = `${sourceSliceWithoutInlineComment(source, origin)}${destinationInlineComment(
      source,
      destination,
    )}`;
    const current = source.slice(
      destination.range.start,
      destination.range.end,
    );
    return replacement === current
      ? []
      : [
          {
            end: destination.range.end,
            replacement,
            start: destination.range.start,
          },
        ];
  });
}

function sourcePatches(
  model: MermaidPieModel,
  result: MermaidPieCommandResult,
): MermaidPieSourcePatch[] | null {
  const { command } = result;
  if (command.type === "slice.rename" || command.type === "slice.value") {
    const record = sliceRecord(model, command.sliceId);
    if (!record) return null;
    return [
      command.type === "slice.rename"
        ? {
            end: record.labelRange.end,
            replacement: encodedSliceLabelLike(
              model.sourceDocument.source.slice(
                record.labelRange.start,
                record.labelRange.end,
              ),
              command.label.trim(),
            ),
            start: record.labelRange.start,
          }
        : {
            end: record.valueRange.end,
            replacement: mermaidChartDecimal(command.value),
            start: record.valueRange.start,
          },
    ];
  }
  if (command.type === "slice.reorder")
    return reorderPatches(model, result.model);
  if (command.type === "slice.delete") {
    const record = sliceRecord(model, command.sliceId);
    if (!record) return null;
    const replacement = record.inlineCommentRange
      ? `${record.raw.match(/^\s*/)?.[0] ?? ""}${model.sourceDocument.source
          .slice(record.inlineCommentRange.start, record.inlineCommentRange.end)
          .trimStart()}`
      : "";
    return [{ end: record.range.end, replacement, start: record.range.start }];
  }
  if (command.type === "slice.add") {
    const after = command.afterSliceId
      ? sliceRecord(model, command.afterSliceId)
      : model.slices.length
        ? sliceRecord(model, model.slices.at(-1)!.id)
        : [...model.sourceDocument.records]
            .reverse()
            .find(
              (record) =>
                record.kind === "metadata" || record.kind === "header",
            );
    if (!after) return null;
    const indent = after.raw.match(/^\s*/)?.[0] ?? "  ";
    return [
      insertionAfterRecord(
        model,
        after,
        `${indent}${encodeMermaidLangiumString(command.label.trim())} : ${mermaidChartDecimal(
          command.value,
        )}`,
      ),
    ];
  }
  if (command.type === "diagram.title") {
    const patch = metadataPatch(
      model,
      "title",
      normalizedSingleLine(command.title),
    );
    return patch ? [patch] : null;
  }
  if (command.type === "diagram.appearance") {
    return appearancePatches(model, command.showData, command.options);
  }
  if (command.type === "diagram.accessibility") {
    const patch = metadataPatch(
      model,
      command.field,
      command.field === "accessibilityTitle"
        ? normalizedSingleLine(command.value)
        : command.value.trim(),
    );
    return patch ? [patch] : null;
  }
  if (command.type === "diagram.accessibility-settings") {
    return accessibilityPatches(model, command.title, command.description);
  }
  if (command.type === "diagram.show-data") {
    const patch = showDataPatch(model, command.showData);
    return patch ? [patch] : null;
  }
  if (command.type === "diagram.option") {
    const patch = optionPatch(model, command.field, command.value);
    return patch ? [patch] : null;
  }
  if (command.type === "comment.add") {
    const patch = addCommentPatch(model, command);
    return patch ? [patch] : null;
  }
  if (command.type === "comment.update") {
    const patch = updateCommentPatch(
      model,
      command.commentId,
      normalizedCommentText(command.text),
    );
    return patch ? [patch] : null;
  }
  const patch = deleteCommentPatch(model, command.commentId);
  return patch ? [patch] : null;
}

function semanticsMatch(
  command: MermaidPieCommand,
  previous: MermaidPieModel,
  expected: MermaidPieModel,
  actual: MermaidPieModel,
) {
  if (command.type === "slice.add") {
    return actual.slices.some(
      (slice) =>
        slice.label === command.label.trim() && slice.value === command.value,
    );
  }
  if (command.type === "slice.delete") {
    const deleted = previous.slices.find(
      (slice) => slice.id === command.sliceId,
    );
    return (
      !!deleted?.sourceRecordId &&
      !actual.sourceDocument.records.some(
        (record) => record.id === deleted.sourceRecordId,
      )
    );
  }
  if (command.type === "slice.reorder") {
    return (
      actual.slices.length === expected.slices.length &&
      expected.slices.every(
        (slice, index) => actual.slices[index]?.id === slice.id,
      )
    );
  }
  if (command.type === "slice.rename") {
    return (
      actual.slices.find((slice) => slice.id === command.sliceId)?.label ===
      command.label.trim()
    );
  }
  if (command.type === "slice.value") {
    return (
      actual.slices.find((slice) => slice.id === command.sliceId)?.value ===
      command.value
    );
  }
  if (command.type === "diagram.title") {
    return actual.title === normalizedSingleLine(command.title);
  }
  if (command.type === "diagram.show-data")
    return actual.showData === command.showData;
  if (command.type === "diagram.appearance") {
    return (
      actual.showData === command.showData &&
      (
        Object.entries(command.options) as Array<
          [keyof MermaidPieOptions, MermaidPieOptions[keyof MermaidPieOptions]]
        >
      ).every(([field, value]) => actual.options[field] === value)
    );
  }
  if (command.type === "diagram.option")
    return actual.options[command.field] === command.value;
  if (command.type === "diagram.accessibility") {
    const value =
      command.field === "accessibilityTitle"
        ? normalizedSingleLine(command.value)
        : command.value.trim();
    return actual[command.field] === value;
  }
  if (command.type === "diagram.accessibility-settings") {
    return (
      actual.accessibilityTitle === normalizedSingleLine(command.title) &&
      actual.accessibilityDescription === command.description.trim()
    );
  }
  if (command.type === "comment.add") {
    const text = normalizedCommentText(command.text);
    return (
      actual.comments.length === expected.comments.length &&
      actual.comments.some((comment) => comment.text === text)
    );
  }
  if (command.type === "comment.update") {
    return (
      actual.comments.find((comment) => comment.id === command.commentId)
        ?.text === normalizedCommentText(command.text)
    );
  }
  return (
    actual.comments.length === expected.comments.length &&
    !actual.comments.some((comment) => comment.id === command.commentId)
  );
}

function stabilizePatchedAnchors(
  previous: MermaidPieModel,
  next: MermaidPieModel,
  command: MermaidPieCommand,
) {
  if (command.type === "slice.rename" || command.type === "slice.value") {
    const previousSlice = previous.slices.find(
      (slice) => slice.id === command.sliceId,
    );
    const previousRecord = sliceRecord(previous, command.sliceId);
    const nextRecord = previousRecord
      ? next.sourceDocument.records.find(
          (
            record,
          ): record is Extract<MermaidPieSourceRecord, { kind: "slice" }> =>
            record.kind === "slice" &&
            record.range.start === previousRecord.range.start,
        )
      : undefined;
    const provisionalSliceId = nextRecord?.sliceId;
    const nextSlice = provisionalSliceId
      ? next.slices.find((slice) => slice.id === provisionalSliceId)
      : undefined;
    if (previousSlice && nextRecord && nextSlice) {
      const provisionalRecordId = nextRecord.id;
      nextSlice.id = previousSlice.id;
      nextSlice.sourceRecordId = previousSlice.sourceRecordId;
      nextRecord.id = previousSlice.sourceRecordId ?? nextRecord.id;
      nextRecord.sliceId = previousSlice.id;
      for (const comment of next.comments) {
        if (comment.anchorId === provisionalSliceId) {
          comment.anchorId = previousSlice.id;
        }
      }
      for (const diagnostic of next.diagnostics) {
        if (diagnostic.recordId === provisionalRecordId) {
          diagnostic.recordId = nextRecord.id;
        }
      }
    }
  }
  if (command.type !== "comment.update") return;
  const previousOwner = commentOwnerRecord(previous, command.commentId);
  if (!previousOwner) return;
  const nextOwner = next.sourceDocument.records.find(
    (record) =>
      record.kind === previousOwner.kind &&
      record.range.start === previousOwner.range.start,
  );
  if (!nextOwner) return;
  const provisionalCommentId =
    nextOwner.kind === "comment"
      ? nextOwner.commentId
      : nextOwner.kind === "header" ||
          nextOwner.kind === "metadata" ||
          nextOwner.kind === "slice"
        ? nextOwner.inlineCommentId
        : undefined;
  if (!provisionalCommentId) return;
  const nextComment = next.comments.find(
    (comment) => comment.id === provisionalCommentId,
  );
  if (!nextComment) return;
  nextComment.id = command.commentId;
  if (nextOwner.kind === "comment") nextOwner.commentId = command.commentId;
  else if (
    nextOwner.kind === "header" ||
    nextOwner.kind === "metadata" ||
    nextOwner.kind === "slice"
  ) {
    nextOwner.inlineCommentId = command.commentId;
  }
}

function transformedRecordStart(
  start: number,
  patches: readonly MermaidPieSourcePatch[],
) {
  let transformed = start;
  for (const patch of [...patches].sort(
    (left, right) => left.start - right.start,
  )) {
    if (patch.start === patch.end) {
      if (start >= patch.start) transformed += patch.replacement.length;
      continue;
    }
    if (start >= patch.end) {
      transformed += patch.replacement.length - (patch.end - patch.start);
      continue;
    }
    if (start === patch.start) continue;
    if (start > patch.start) return null;
  }
  return transformed;
}

function stabilizeExistingCommentAnchors(
  previous: MermaidPieModel,
  next: MermaidPieModel,
  patches: readonly MermaidPieSourcePatch[],
) {
  for (const previousComment of previous.comments) {
    const previousOwner = commentOwnerRecord(previous, previousComment.id);
    if (!previousOwner) continue;
    const nextStart = transformedRecordStart(
      previousOwner.range.start,
      patches,
    );
    if (nextStart === null) continue;
    const nextOwner = next.sourceDocument.records.find(
      (record) => record.range.start === nextStart && ownerCommentId(record),
    );
    const provisionalId = nextOwner ? ownerCommentId(nextOwner) : undefined;
    if (!nextOwner || !provisionalId) continue;
    const target = next.comments.find(
      (comment) => comment.id === provisionalId,
    );
    if (!target || target.id === previousComment.id) continue;
    const displaced = next.comments.find(
      (comment) => comment !== target && comment.id === previousComment.id,
    );
    const displacedOwner = displaced
      ? commentOwnerRecord(next, displaced.id)
      : undefined;
    if (displaced) displaced.id = provisionalId;
    if (displacedOwner) setOwnerCommentId(displacedOwner, provisionalId);
    target.id = previousComment.id;
    setOwnerCommentId(nextOwner, previousComment.id);
  }
}

function anchorMapping(previous: MermaidPieModel, next: MermaidPieModel) {
  const mapping: Record<string, string> = {};
  const nextSlices = new Map(next.slices.map((slice) => [slice.id, slice]));
  for (const slice of previous.slices) {
    const candidate = nextSlices.get(slice.id);
    if (!candidate) continue;
    mapping[slice.id] = candidate.id;
    if (slice.sourceRecordId && candidate.sourceRecordId) {
      mapping[slice.sourceRecordId] = candidate.sourceRecordId;
    }
  }
  const nextConflicts = new Map(
    next.conflicts.map((conflict) => [conflict.sliceId, conflict]),
  );
  for (const conflict of previous.conflicts) {
    const candidate = nextConflicts.get(conflict.sliceId);
    if (!candidate) continue;
    mapping[conflict.id] = candidate.id;
    mapping[conflict.sliceId] = candidate.sliceId;
    mapping[conflict.sourceRecordId] = candidate.sourceRecordId;
  }
  const nextComments = new Map(
    next.comments.map((comment) => [comment.id, comment]),
  );
  for (const comment of previous.comments) {
    if (nextComments.has(comment.id)) mapping[comment.id] = comment.id;
  }
  for (const record of previous.sourceDocument.records) {
    if (record.kind === "header") {
      const candidate = next.sourceDocument.records.find(
        (item) => item.kind === "header",
      );
      if (candidate) mapping[record.id] = candidate.id;
    } else if (record.kind === "metadata") {
      const candidate = next.sourceDocument.records.find(
        (item) =>
          item.kind === "metadata" &&
          item.field === record.field &&
          item.effective,
      );
      if (candidate) mapping[record.id] = candidate.id;
    } else if (record.kind === "option") {
      const candidate = next.sourceDocument.records.find(
        (item) =>
          item.kind === "option" &&
          item.field === record.field &&
          item.effective,
      );
      if (candidate) mapping[record.id] = candidate.id;
    }
  }
  return mapping;
}

function remapCreatedSelection(
  selection: MermaidPieCommandSelection,
  command: MermaidPieCommand,
  previous: MermaidPieModel,
  next: MermaidPieModel,
  mapping: Record<string, string>,
) {
  if (selection.kind === "diagram") return selection;
  if (mapping[selection.id]) return { ...selection, id: mapping[selection.id] };
  if (command.type === "slice.add") {
    const previousIds = new Set(previous.slices.map((slice) => slice.id));
    const created = next.slices.find(
      (slice) =>
        !previousIds.has(slice.id) &&
        slice.label === command.label.trim() &&
        slice.value === command.value,
    );
    if (created) {
      mapping[selection.id] = created.id;
      return { ...selection, id: created.id };
    }
  }
  if (command.type === "comment.add") {
    const previousIds = new Set(previous.comments.map((comment) => comment.id));
    const text = normalizedCommentText(command.text);
    const created = next.comments.find(
      (comment) => !previousIds.has(comment.id) && comment.text === text,
    );
    if (created) {
      mapping[selection.id] = created.id;
      return { ...selection, id: created.id };
    }
  }
  return selection;
}

function rejectedResult(
  model: MermaidPieModel | null,
  command: MermaidPieCommandResult | null,
  source: string,
  diagnosis: MermaidPieCommandDiagnosis,
): MermaidPieSourceApplyResult {
  return {
    anchorMapping: {},
    changed: false,
    command,
    diagnosis,
    diagnostics: model?.diagnostics ?? [],
    model,
    selectionAfter: command?.selectionAfter ?? { kind: "diagram" },
    source,
  };
}

export function applyMermaidPieSourceCommand(
  input: MermaidPieSourceApplyInput,
): MermaidPieSourceApplyResult {
  const parsed = parseMermaidPieSourceResult(input.source, input.previousModel);
  if (!parsed.model) {
    return rejectedResult(null, null, input.source, {
      code: "pie.source-invalid",
      recordId: parsed.diagnostic.recordId,
    });
  }
  const command = applyMermaidPieCommand(parsed.model, input.command);
  if ((input.intent ?? "commit") !== "commit") {
    return rejectedResult(parsed.model, command, input.source, {
      code: `pie.${input.intent ?? "preview"}-not-writable`,
    });
  }
  if (input.readonly) {
    return rejectedResult(parsed.model, command, input.source, {
      code: "pie.readonly",
    });
  }
  if (
    input.baseSourceHash &&
    input.baseSourceHash !== hashMermaidSource(input.source)
  ) {
    return rejectedResult(parsed.model, command, input.source, {
      code: "pie.source-stale",
    });
  }
  if (!command.changed) {
    return rejectedResult(
      parsed.model,
      command,
      input.source,
      command.diagnosis,
    );
  }
  const patches = sourcePatches(parsed.model, command);
  if (!patches?.length) {
    return rejectedResult(parsed.model, command, input.source, {
      code: "pie.source-location-unavailable",
    });
  }
  let candidateSource: string;
  try {
    candidateSource = applyPatches(input.source, patches);
  } catch {
    return rejectedResult(parsed.model, command, input.source, {
      code: "pie.source-patch-overlap",
    });
  }
  const candidate = parseMermaidPieSourceResult(candidateSource, parsed.model);
  if (candidate.model) {
    stabilizeExistingCommentAnchors(parsed.model, candidate.model, patches);
    stabilizePatchedAnchors(parsed.model, candidate.model, input.command);
  }
  if (
    !candidate.model ||
    !semanticsMatch(input.command, parsed.model, command.model, candidate.model)
  ) {
    return rejectedResult(parsed.model, command, input.source, {
      code: "pie.source-reparse-mismatch",
      recordId: candidate.diagnostic?.recordId,
    });
  }
  const mapping = anchorMapping(parsed.model, candidate.model);
  const selectionAfter = remapCreatedSelection(
    command.selectionAfter,
    input.command,
    parsed.model,
    candidate.model,
    mapping,
  );
  return {
    anchorMapping: mapping,
    changed: candidateSource !== input.source,
    command,
    diagnosis: { code: "pie.ok" },
    diagnostics: candidate.model.diagnostics,
    model: candidate.model,
    selectionAfter,
    source: candidateSource,
  };
}
