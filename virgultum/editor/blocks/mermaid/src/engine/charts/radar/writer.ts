// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidChartDecimal } from "../../chart-number.js";
import { parseMermaidRadarSourceResult } from "./parser.js";
import type {
  MermaidRadarAxis,
  MermaidRadarConfig,
  MermaidRadarCurve,
  MermaidRadarEntry,
  MermaidRadarModel,
} from "./model.js";
import { DEFAULT_MERMAID_RADAR_CONFIG } from "./model.js";
import type {
  MermaidRadarCommandResult,
  MermaidRadarCommandSelection,
} from "./commands/types.js";
import type {
  MermaidRadarConfigFieldName,
  MermaidRadarSourceRange,
  MermaidRadarSourceRecord,
} from "./source-document.js";

export type MermaidRadarSourcePatch = {
  readonly range: Pick<MermaidRadarSourceRange, "end" | "start">;
  readonly value: string;
};

export function radarNoChange(
  model: MermaidRadarModel,
  source: string,
  diagnosis: string,
): MermaidRadarCommandResult {
  return { changed: false, diagnosis, model, selectionAfter: null, source };
}

export function applyRadarPatches(
  source: string,
  patches: readonly MermaidRadarSourcePatch[],
) {
  const ordered = [...patches].sort(
    (left, right) => right.range.start - left.range.start,
  );
  let next = source;
  let previousStart = source.length + 1;
  for (const patch of ordered) {
    if (
      patch.range.start < 0 ||
      patch.range.end < patch.range.start ||
      patch.range.end > source.length ||
      patch.range.end > previousStart
    )
      return null;
    next = `${next.slice(0, patch.range.start)}${patch.value}${next.slice(patch.range.end)}`;
    previousStart = patch.range.start;
  }
  return next;
}

export function radarPatchedResult({
  diagnosis = "radar.ok",
  model,
  patches,
  selectionAfter,
  source,
}: {
  readonly diagnosis?: string;
  readonly model: MermaidRadarModel;
  readonly patches: readonly MermaidRadarSourcePatch[];
  readonly selectionAfter: MermaidRadarCommandSelection | null;
  readonly source: string;
}): MermaidRadarCommandResult {
  const nextSource = applyRadarPatches(source, patches);
  if (nextSource === null || nextSource === source)
    return radarNoChange(
      model,
      source,
      nextSource === null ? "radar.patch-overlap" : "radar.no-change",
    );
  const parsed = parseMermaidRadarSourceResult(nextSource, model);
  if (!parsed.model)
    return radarNoChange(model, source, parsed.diagnostic.code);
  return {
    changed: true,
    diagnosis,
    model: parsed.model,
    selectionAfter,
    source: nextSource,
  };
}

export function radarRecord(model: MermaidRadarModel, id: string) {
  return model.sourceDocument.records.find((record) => record.id === id);
}

export function radarOwnedRecordRange(
  model: MermaidRadarModel,
  record: MermaidRadarSourceRecord,
  owner: { readonly id: string; readonly kind: "axis" | "curve" },
) {
  const commentRecords = model.comments.flatMap((comment) => {
    if (comment.anchor.kind !== owner.kind || comment.anchor.id !== owner.id)
      return [];
    const sourceRecord = radarRecord(model, comment.sourceRecordId);
    return sourceRecord?.kind === "comment" ? [sourceRecord] : [];
  });
  return {
    end: Math.max(
      record.range.end,
      ...commentRecords.map((item) => item.range.end),
    ),
    start: Math.min(
      record.range.start,
      ...commentRecords.map((item) => item.range.start),
    ),
  };
}

export function radarAxisSource(
  model: MermaidRadarModel,
  axis: MermaidRadarAxis,
) {
  const record = radarRecord(model, axis.sourceRecordId);
  if (record?.kind !== "axis") return null;
  const item =
    record.axes.find((candidate) => candidate.id === axis.id) ??
    record.axes[
      model.axes
        .filter((candidate) => candidate.sourceRecordId === record.id)
        .findIndex((candidate) => candidate.id === axis.id)
    ];
  return item ? { item, record } : null;
}

export function radarCurveSource(
  model: MermaidRadarModel,
  curve: MermaidRadarCurve,
) {
  const record = radarRecord(model, curve.sourceRecordId);
  if (record?.kind !== "curve") return null;
  const item =
    record.curves.find((candidate) => candidate.id === curve.id) ??
    record.curves[
      model.curves
        .filter((candidate) => candidate.sourceRecordId === record.id)
        .findIndex((candidate) => candidate.id === curve.id)
    ];
  return item ? { item, record } : null;
}

export function radarEntrySource(
  model: MermaidRadarModel,
  entry: MermaidRadarEntry,
) {
  const curve = model.curves.find((candidate) =>
    candidate.entries.some((item) => item.id === entry.id),
  );
  if (!curve) return null;
  const source = radarCurveSource(model, curve);
  if (!source) return null;
  const item =
    source.item.entries.find((candidate) => candidate.id === entry.id) ??
    source.item.entries[
      curve.entries.findIndex((candidate) => candidate.id === entry.id)
    ];
  return item
    ? { curve, curveSource: source.item, entry: item, record: source.record }
    : null;
}

export function radarInsertionPatch(
  model: MermaidRadarModel,
  text: string,
  afterKinds: readonly MermaidRadarSourceRecord["kind"][],
): MermaidRadarSourcePatch {
  const records = model.sourceDocument.records.filter((record) =>
    afterKinds.includes(record.kind),
  );
  const owner =
    records.at(-1) ??
    model.sourceDocument.records.find((record) => record.kind === "header")!;
  const anchor =
    model.sourceDocument.records.findLast(
      (record) =>
        record.kind === "comment" &&
        record.anchorId === owner.id &&
        record.range.start >= owner.range.end,
    ) ?? owner;
  const newline = model.sourceDocument.newline;
  return {
    range: { end: anchor.range.end, start: anchor.range.end },
    value: `${newline}${text}`,
  };
}

/** Appends to an owner without inserting ahead of comments anchored after it. */
export function radarInsertionAfterOwnedComments(
  model: MermaidRadarModel,
  owner: MermaidRadarSourceRecord,
  text: string,
): MermaidRadarSourcePatch {
  const anchor =
    model.sourceDocument.records.findLast(
      (record) =>
        record.kind === "comment" &&
        record.anchorId === owner.id &&
        record.range.start >= owner.range.end,
    ) ?? owner;
  return radarInsertionAfterRecord(model, anchor, text);
}

export function radarInsertionBeforeRecord(
  model: MermaidRadarModel,
  record: Pick<MermaidRadarSourceRecord, "range">,
  text: string,
): MermaidRadarSourcePatch {
  return {
    range: { end: record.range.start, start: record.range.start },
    value: `${text}${model.sourceDocument.newline}`,
  };
}

export function radarInsertionAfterRecord(
  model: MermaidRadarModel,
  record: Pick<MermaidRadarSourceRecord, "range">,
  text: string,
): MermaidRadarSourcePatch {
  return {
    range: { end: record.range.end, start: record.range.end },
    value: `${model.sourceDocument.newline}${text}`,
  };
}

export function radarRecordRemovalPatch(
  model: MermaidRadarModel,
  record: {
    readonly range: Pick<MermaidRadarSourceRange, "end" | "start">;
  },
): MermaidRadarSourcePatch {
  const { source } = model.sourceDocument;
  const preceding = source[record.range.start - 1];
  if (record.range.start > 0 && preceding !== "\r" && preceding !== "\n")
    return { range: record.range, value: "" };
  const after = source.startsWith("\r\n", record.range.end)
    ? 2
    : /[\r\n]/.test(source[record.range.end] ?? "")
      ? 1
      : 0;
  if (after)
    return {
      range: { end: record.range.end + after, start: record.range.start },
      value: "",
    };
  const before = source.slice(0, record.range.start).endsWith("\r\n")
    ? 2
    : /[\r\n]$/.test(source.slice(0, record.range.start))
      ? 1
      : 0;
  return {
    range: {
      end: record.range.end,
      start: Math.max(0, record.range.start - before),
    },
    value: "",
  };
}

export function radarRemovalRange(
  record: MermaidRadarSourceRecord,
  item: { readonly range: MermaidRadarSourceRange },
  siblings: readonly { readonly range: MermaidRadarSourceRange }[],
) {
  if (siblings.length <= 1) return record.range;
  const index = siblings.findIndex(
    (candidate) => candidate.range.start === item.range.start,
  );
  if (index < 0) return item.range;
  if (index < siblings.length - 1)
    return { ...item.range, end: siblings[index + 1].range.start };
  return { ...item.range, start: siblings[index - 1].range.end };
}

export function radarEntryListPatch(
  source: string,
  model: MermaidRadarModel,
  curve: MermaidRadarCurve,
  entries: readonly string[],
) {
  const sourceInfo = radarCurveSource(model, curve);
  if (!sourceInfo) return null;
  const raw = source.slice(
    sourceInfo.item.range.start,
    sourceInfo.item.range.end,
  );
  const open = raw.indexOf("{");
  const close = raw.lastIndexOf("}");
  if (open < 0 || close <= open) return null;
  return {
    range: {
      end: sourceInfo.item.range.start + close,
      start: sourceInfo.item.range.start + open + 1,
    },
    value: entries.join(", "),
  } satisfies MermaidRadarSourcePatch;
}

export function radarEntryAppendPatch(
  source: string,
  model: MermaidRadarModel,
  curve: MermaidRadarCurve,
  entry: string,
) {
  const sourceInfo = radarCurveSource(model, curve);
  if (!sourceInfo) return null;
  const raw = source.slice(
    sourceInfo.item.range.start,
    sourceInfo.item.range.end,
  );
  const close = raw.lastIndexOf("}");
  if (close < 0) return null;
  return {
    range: {
      end: sourceInfo.item.range.start + close,
      start: sourceInfo.item.range.start + close,
    },
    value: `${sourceInfo.item.entries.length ? ", " : ""}${entry}`,
  } satisfies MermaidRadarSourcePatch;
}

export function radarEntryRemovalRange(
  record: MermaidRadarSourceRecord,
  entry: { readonly range: MermaidRadarSourceRange },
  entries: readonly { readonly range: MermaidRadarSourceRange }[],
) {
  return entries.length === 1
    ? entry.range
    : radarRemovalRange(record, entry, entries);
}

export function radarConfigValue(value: boolean | number) {
  return typeof value === "boolean"
    ? String(value)
    : mermaidChartDecimal(value);
}

export function radarConfigPatches(
  model: MermaidRadarModel,
  desired: Required<MermaidRadarConfig>,
) {
  const current = model.config;
  const effective = { ...DEFAULT_MERMAID_RADAR_CONFIG, ...current };
  const fields = Object.keys(desired) as MermaidRadarConfigFieldName[];
  const existing = model.sourceDocument.records.flatMap((record) =>
    record.kind === "frontmatter" || record.kind === "directive"
      ? record.configFields.map((field) => ({ field, record }))
      : [],
  );
  const patches: MermaidRadarSourcePatch[] = [];
  const missing: MermaidRadarConfigFieldName[] = [];
  for (const field of fields) {
    const value = desired[field];
    const occurrence = existing.findLast(
      (candidate) => candidate.field.field === field,
    );
    if (occurrence) {
      const before = model.sourceDocument.source.slice(
        occurrence.field.valueRange.start,
        occurrence.field.valueRange.end,
      );
      const after = radarConfigValue(value);
      if (before !== after)
        patches.push({ range: occurrence.field.valueRange, value: after });
    } else if (effective[field] !== value) missing.push(field);
  }
  if (missing.length > 0) {
    const authority = model.sourceDocument.records.findLast(
      (record) =>
        (record.kind === "frontmatter" || record.kind === "directive") &&
        record.configScope,
    );
    if (
      authority &&
      (authority.kind === "frontmatter" || authority.kind === "directive") &&
      authority.configScope
    ) {
      const entries = missing.map(
        (field) => `${field}: ${radarConfigValue(desired[field])}`,
      );
      if (authority.configScope.format === "json") {
        const hasFields = authority.configFields.length > 0;
        patches.push({
          range: {
            end: authority.configScope.range.end - 1,
            start: authority.configScope.range.end - 1,
          },
          value: `${hasFields ? ", " : ""}${entries
            .map((entry) => {
              const separator = entry.indexOf(":");
              return `${JSON.stringify(entry.slice(0, separator))}${entry.slice(separator)}`;
            })
            .join(", ")}`,
        });
      } else {
        patches.push({
          range: {
            end: authority.configScope.range.end,
            start: authority.configScope.range.end,
          },
          value: `${model.sourceDocument.newline}${entries
            .map((entry) => `${authority.configScope!.indentation}${entry}`)
            .join(model.sourceDocument.newline)}`,
        });
      }
    } else {
      const config = Object.fromEntries(
        missing.map((field) => [field, desired[field]]),
      );
      const directive = `%%{init: ${JSON.stringify({ radar: config })}}%%`;
      const firstHeader = model.sourceDocument.records.find(
        (record) => record.kind === "header",
      )!;
      patches.push({
        range: {
          end: firstHeader.range.start,
          start: firstHeader.range.start,
        },
        value: `${directive}${model.sourceDocument.newline}`,
      });
    }
  }
  return patches;
}

export function mermaidRadarNumber(value: number) {
  return mermaidChartDecimal(value);
}
