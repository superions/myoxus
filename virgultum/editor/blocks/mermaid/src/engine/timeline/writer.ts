// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidTimelineModel, TimelineAnchor } from "./model.js";
import type { TimelineDiagnostic } from "./diagnostics.js";
import type { TimelineSourceStatement } from "./source-document.js";
import { parseTimelineSource } from "./parser.js";

export type TimelinePatch = {
  readonly range: { readonly start: number; readonly end: number };
  readonly value: string;
  readonly identities?: {
    readonly statements: readonly (readonly [number, string])[];
    readonly segments: readonly (readonly [number, string])[];
  };
};
export type TimelineCommandResult = {
  readonly changed: boolean;
  readonly source: string;
  readonly model: MermaidTimelineModel;
  readonly patches: readonly TimelinePatch[];
  readonly selection: TimelineAnchor | null;
  readonly diagnostics: readonly TimelineDiagnostic[];
  readonly reason:
    "applied" | "no-change" | "conflict" | "invalid" | "readonly";
};

export function timelineNoChange(
  model: MermaidTimelineModel,
  reason: TimelineCommandResult["reason"] = "no-change",
  anchorId: string | null = null,
): TimelineCommandResult {
  const record = model.sourceDocument.statements.find(
    (item) =>
      item.id === anchorId ||
      item.segments.some((segment) => segment.id === anchorId),
  );
  return {
    changed: false,
    source: model.sourceDocument.source,
    model,
    patches: [],
    selection: null,
    reason,
    diagnostics:
      reason === "no-change"
        ? []
        : [
            {
              code:
                reason === "readonly"
                  ? "readonly"
                  : reason === "conflict"
                    ? "conflict"
                    : "target",
              range: record?.range ?? { start: 0, end: 0, line: 1 },
              anchorId,
            },
          ],
  };
}

/** Reparse, reserve identities, and protect unrelated membership before any host commit. */
export function writeTimelinePatches(
  model: MermaidTimelineModel,
  patches: readonly TimelinePatch[],
  options: {
    readonly removedIds?: ReadonlySet<string>;
    readonly ownerChanges?: ReadonlyMap<string, string>;
    readonly selection?: TimelineAnchor | null;
    readonly commentAnchors?: ReadonlyMap<string, TimelineAnchor>;
    readonly repairComments?: boolean;
  } = {},
): TimelineCommandResult {
  const original = model.sourceDocument.source;
  const sorted = [...patches].sort(
    (left, right) =>
      left.range.start - right.range.start || left.range.end - right.range.end,
  );
  let cursor = 0;
  let source = "";
  const statements = new Map<number, string>();
  const segments = new Map<number, string>();
  for (const patch of sorted) {
    if (
      patch.range.start < cursor ||
      patch.range.start < 0 ||
      patch.range.end < patch.range.start ||
      patch.range.end > original.length
    )
      return timelineNoChange(model, "invalid");
    source += original.slice(cursor, patch.range.start);
    const base = source.length;
    for (const [offset, id] of patch.identities?.statements ?? [])
      statements.set(base + offset, id);
    for (const [offset, id] of patch.identities?.segments ?? [])
      segments.set(base + offset, id);
    source += patch.value;
    cursor = patch.range.end;
  }
  source += original.slice(cursor);
  if (source === original) return timelineNoChange(model);
  const mappedIds = new Set([...statements.values(), ...segments.values()]);
  const mapOffset = (offset: number) => {
    let delta = 0;
    for (const patch of sorted) {
      if (offset < patch.range.start) break;
      if (offset > patch.range.start && offset < patch.range.end) return null;
      if (offset === patch.range.start && patch.range.end > patch.range.start)
        return offset + delta;
      delta += patch.value.length - (patch.range.end - patch.range.start);
    }
    return offset + delta;
  };
  for (const record of model.sourceDocument.statements) {
    if (!options.removedIds?.has(record.id) && !mappedIds.has(record.id)) {
      const start = mapOffset(record.range.start);
      if (start !== null) statements.set(start, record.id);
    }
    for (const segment of record.segments) {
      if (options.removedIds?.has(segment.id) || mappedIds.has(segment.id))
        continue;
      const start = mapOffset(segment.range.start);
      if (start !== null) segments.set(start, segment.id);
    }
  }
  const next = parseTimelineSource(source, model, { statements, segments });
  if (
    !next.headerId ||
    next.diagnostics.some(
      (item) =>
        !model.diagnostics.some(
          (old) => old.code === item.code && old.anchorId === item.anchorId,
        ),
    )
  )
    return timelineNoChange(model, "invalid");
  if (options.repairComments !== false) {
    const repairs = new Map<number, TimelinePatch>();
    for (const comment of model.comments) {
      if (options.removedIds?.has(comment.id) || mappedIds.has(comment.id))
        continue;
      const retained = next.comments.find((item) => item.id === comment.id);
      const expected =
        options.commentAnchors?.get(comment.id) ?? comment.anchor;
      if (
        !retained ||
        (retained.anchor.kind === expected.kind &&
          retained.anchor.id === expected.id)
      )
        continue;
      const index = next.sourceDocument.statements.findIndex(
        (record) => record.id === comment.id,
      );
      let first = index;
      let last = index;
      while (next.sourceDocument.statements[first - 1]?.kind === "comment")
        first--;
      while (next.sourceDocument.statements[last + 1]?.kind === "comment")
        last++;
      if (
        expected.kind !== "diagram" &&
        retained.anchor.kind === "diagram" &&
        next.sourceDocument.statements[first - 1]?.kind === "header"
      ) {
        const originalRecord = timelineRecord(
          model,
          next.sourceDocument.statements[first]!.id,
        );
        if (originalRecord && !mappedIds.has(originalRecord.id))
          repairs.set(originalRecord.range.start, {
            range: {
              start: originalRecord.range.start,
              end: originalRecord.range.start,
            },
            value: model.sourceDocument.newline,
          });
      } else if (
        expected.kind === "diagram" &&
        retained.anchor.kind !== "diagram"
      ) {
        const originalRecord = timelineRecord(
          model,
          next.sourceDocument.statements[last]!.id,
        );
        if (originalRecord && !mappedIds.has(originalRecord.id)) {
          const point = originalRecord.range.end + originalRecord.eol.length;
          repairs.set(point, {
            range: { start: point, end: point },
            value: model.sourceDocument.newline,
          });
        }
      }
    }
    if (repairs.size)
      return writeTimelinePatches(model, [...patches, ...repairs.values()], {
        ...options,
        repairComments: false,
      });
  }
  const ids = [
    ...next.sections.map((item) => item.id),
    ...next.periods.map((item) => item.id),
    ...next.events.map((item) => item.id),
    ...next.comments.map((item) => item.id),
  ];
  if (new Set(ids).size !== ids.length)
    return timelineNoChange(model, "conflict");
  for (const period of model.periods) {
    if (options.removedIds?.has(period.id)) continue;
    const retained = next.periods.find((item) => item.id === period.id);
    if (
      !retained ||
      retained.sectionId !==
        (options.ownerChanges?.get(period.id) ?? period.sectionId)
    )
      return timelineNoChange(model, "invalid", period.id);
  }
  for (const event of model.events) {
    if (options.removedIds?.has(event.id)) continue;
    const retained = next.events.find((item) => item.id === event.id);
    if (
      !retained ||
      retained.periodId !==
        (options.ownerChanges?.get(event.id) ?? event.periodId)
    )
      return timelineNoChange(model, "invalid", event.id);
  }
  for (const comment of model.comments) {
    if (options.removedIds?.has(comment.id)) continue;
    const retained = next.comments.find((item) => item.id === comment.id);
    const expected = options.commentAnchors?.get(comment.id) ?? comment.anchor;
    if (
      !retained ||
      retained.anchor.kind !== expected.kind ||
      retained.anchor.id !== expected.id
    )
      return timelineNoChange(model, "invalid", comment.id);
  }
  return {
    changed: true,
    source,
    model: next,
    patches: sorted,
    selection: options.selection ?? null,
    diagnostics: [],
    reason: "applied",
  };
}

export function timelineRecord(model: MermaidTimelineModel, id: string) {
  return model.sourceDocument.statements.find(
    (item) =>
      item.id === id || item.segments.some((segment) => segment.id === id),
  );
}
export function timelineSegment(model: MermaidTimelineModel, id: string) {
  return timelineRecord(model, id)?.segments.find((item) => item.id === id);
}
export function timelineStatementRemoval(
  record: TimelineSourceStatement,
): TimelinePatch {
  return {
    range: {
      start: record.range.start,
      end: record.range.end + record.eol.length,
    },
    value: "",
  };
}
export function timelineAfterPhysicalLine(
  model: MermaidTimelineModel,
  offset: number,
) {
  const source = model.sourceDocument.source;
  while (
    offset < source.length &&
    source[offset] !== "\r" &&
    source[offset] !== "\n"
  )
    offset++;
  return (
    offset +
    (source.startsWith("\r\n", offset) ? 2 : offset < source.length ? 1 : 0)
  );
}

/** Only owned records move; intervening global metadata retains its position and precedence. */
export function timelineRecordPayload(
  records: readonly TimelineSourceStatement[],
  newline: string = "\n",
) {
  let value = "";
  const statements: [number, string][] = [];
  const segments: [number, string][] = [];
  let previous: TimelineSourceStatement | undefined;
  for (const record of [...records].sort(
    (left, right) => left.range.start - right.range.start,
  )) {
    if (previous && !previous.eol && previous.range.line !== record.range.line)
      value += newline;
    statements.push([value.length, record.id]);
    for (const segment of record.segments)
      segments.push([
        value.length + segment.range.start - record.range.start,
        segment.id,
      ]);
    value += record.raw + record.eol;
    previous = record;
  }
  return { value, identities: { statements, segments } };
}
export function timelineLineInsertion(
  model: MermaidTimelineModel,
  offset: number,
  payload: ReturnType<typeof timelineRecordPayload>,
  removals: readonly TimelinePatch[] = [],
): TimelinePatch {
  const source = model.sourceDocument.source;
  let preceding = offset - 1;
  for (;;) {
    const removed = removals.find(
      (item) => item.range.start <= preceding && preceding < item.range.end,
    );
    if (!removed) break;
    preceding = removed.range.start - 1;
  }
  const last = [...model.sourceDocument.statements]
    .reverse()
    .find(
      (record) =>
        record.range.end + record.eol.length <= offset &&
        !removals.some(
          (patch) =>
            patch.range.start <= record.range.start &&
            record.range.start < patch.range.end,
        ),
    );
  const diagramComment =
    last?.kind === "comment" &&
    last.range.end + last.eol.length === offset &&
    model.comments.some(
      (comment) => comment.id === last.id && comment.anchor.kind === "diagram",
    );
  const firstIdentity = payload.identities.statements[0]?.[1];
  const boundComment = model.comments.some(
    (comment) =>
      comment.id === firstIdentity && comment.anchor.kind !== "diagram",
  );
  const headerNear =
    last?.kind === "header" &&
    last.range.end + last.eol.length === offset &&
    boundComment;
  const prefix =
    (preceding >= 0 && source[preceding] !== "\n" && source[preceding] !== "\r"
      ? model.sourceDocument.newline
      : "") +
    (diagramComment || headerNear ? model.sourceDocument.newline : "");
  const suffix =
    offset < source.length && !/[\r\n]$/.test(payload.value)
      ? model.sourceDocument.newline
      : "";
  return {
    range: { start: offset, end: offset },
    value: prefix + payload.value + suffix,
    identities: {
      statements: payload.identities.statements.map(([point, id]) => [
        point + prefix.length,
        id,
      ]),
      segments: payload.identities.segments.map(([point, id]) => [
        point + prefix.length,
        id,
      ]),
    },
  };
}
