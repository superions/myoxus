// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  TIMELINE_UNSECTIONED_ID,
  isMermaidTimelineEventLabel,
  isMermaidTimelinePeriodLabel,
  isMermaidTimelineSectionLabel,
  type MermaidTimelineModel,
  type TimelineAnchor,
  type TimelineMetadata,
} from "./model.js";
import { nextTimelineIdentity } from "./source-document.js";
import type { TimelineSourceStatement } from "./source-document.js";
import {
  timelineConfigPatches,
  validTimelineConfigValue,
  type TimelineConfigField,
  type TimelineConfigValue,
} from "./config.js";
import {
  timelineAfterPhysicalLine,
  timelineLineInsertion,
  timelineNoChange,
  timelineRecord,
  timelineRecordPayload,
  timelineSegment,
  timelineStatementRemoval,
  writeTimelinePatches,
  type TimelineCommandResult,
  type TimelinePatch,
} from "./writer.js";

export type TimelineDeleteStrategy =
  | { readonly kind: "cascade" }
  | { readonly kind: "move"; readonly targetId: string };
export type TimelineCommand =
  | {
      readonly type: "section-add";
      readonly label: string;
      readonly targetOrder: number;
    }
  | {
      readonly type: "period-add";
      readonly label: string;
      readonly targetSectionId: string;
      readonly targetOrder: number;
    }
  | {
      readonly type: "event-add";
      readonly label: string;
      readonly targetPeriodId: string;
      readonly targetOrder: number;
    }
  | {
      readonly type: "rename";
      readonly anchor: TimelineAnchor;
      readonly label: string;
    }
  | {
      readonly type: "section-move";
      readonly id: string;
      readonly targetOrder: number;
    }
  | {
      readonly type: "period-move";
      readonly id: string;
      readonly targetSectionId: string;
      readonly targetOrder: number;
    }
  | {
      readonly type: "event-move";
      readonly id: string;
      readonly targetPeriodId: string;
      readonly targetOrder: number;
    }
  | {
      readonly type: "delete";
      readonly anchor: TimelineAnchor;
      readonly strategy?: TimelineDeleteStrategy;
    }
  | { readonly type: "direction"; readonly value: "LR" | "TD" }
  | {
      readonly type: "metadata";
      readonly field: TimelineMetadata["field"];
      readonly value?: string;
      readonly format?: "body" | "multiline";
    }
  | {
      readonly type: "config";
      readonly field: TimelineConfigField;
      readonly value?: TimelineConfigValue;
      readonly statementId?: string;
    }
  | {
      readonly type: "comment-add";
      readonly anchor: TimelineAnchor;
      readonly text: string;
    }
  | {
      readonly type: "comment-edit";
      readonly id: string;
      readonly text: string;
    }
  | { readonly type: "comment-delete"; readonly id: string };
export type TimelineCommandContext = {
  /** Draft basis is source content, not projection array identity. */
  readonly baseSource: string;
  readonly readonly: boolean;
};
export type TimelineDeleteImpact = {
  readonly anchor: TimelineAnchor;
  readonly periodIds: readonly string[];
  readonly eventIds: readonly string[];
  readonly commentIds: readonly string[];
  readonly direct: boolean;
  readonly targets: readonly string[];
};

function ordered<T extends { order: number }>(items: readonly T[]) {
  return [...items].sort((a, b) => a.order - b.order);
}
function validSlot(slot: number, length: number) {
  return Number.isInteger(slot) && slot >= 0 && slot <= length;
}
function boundComments(model: MermaidTimelineModel, ids: ReadonlySet<string>) {
  return model.comments.filter(
    (item) => item.anchor.id !== null && ids.has(item.anchor.id),
  );
}
function boundStart(model: MermaidTimelineModel, id: string) {
  const record = timelineRecord(model, id);
  if (!record) return null;
  return Math.min(
    record.range.start,
    ...boundComments(model, new Set([id])).map((item) => item.range.start),
  );
}
function ownedRecords(model: MermaidTimelineModel, ids: ReadonlySet<string>) {
  const comments = new Set(boundComments(model, ids).map((item) => item.id));
  return model.sourceDocument.statements.filter(
    (record) =>
      ids.has(record.id) ||
      comments.has(record.id) ||
      (record.kind === "event" &&
        record.segments.length > 0 &&
        record.segments.every((segment) => ids.has(segment.id))),
  );
}
/** A section header can share a line with events owned by an earlier period. */
function moveSourcePlan(model: MermaidTimelineModel, ids: ReadonlySet<string>) {
  const source = model.sourceDocument.source;
  const comments = new Set(boundComments(model, ids).map((item) => item.id));
  const removals: TimelinePatch[] = [];
  const payload = {
    value: "",
    identities: {
      statements: [] as [number, string][],
      segments: [] as [number, string][],
    },
  };
  const append = (
    raw: string,
    eol: string,
    id: string,
    segments: readonly [number, string][],
  ) => {
    const base = payload.value.length;
    payload.identities.statements.push([base, id]);
    payload.identities.segments.push(
      ...segments.map(
        ([offset, identity]) => [base + offset, identity] as [number, string],
      ),
    );
    payload.value += raw + eol;
  };
  for (const record of model.sourceDocument.statements) {
    const ownsRecord = ids.has(record.id) || comments.has(record.id);
    const selected = record.segments.filter((item) => ids.has(item.id));
    if (ownsRecord) {
      const foreign = record.segments.filter((item) => !ids.has(item.id));
      if (foreign.length) {
        const colon = foreign[0]!.range.start;
        append(
          source.slice(record.range.start, colon),
          record.eol,
          record.id,
          [],
        );
        const value =
          record.indent + source.slice(colon, record.range.end) + record.eol;
        removals.push({
          range: {
            start: record.range.start,
            end: record.range.end + record.eol.length,
          },
          value,
          identities: {
            statements: [[0, nextTimelineIdentity()]],
            segments: foreign.map((item) => [
              record.indent.length + item.range.start - colon,
              item.id,
            ]),
          },
        });
      } else {
        append(
          record.raw,
          record.eol,
          record.id,
          record.segments.map((item) => [
            item.range.start - record.range.start,
            item.id,
          ]),
        );
        removals.push(timelineStatementRemoval(record));
      }
    } else if (selected.length) {
      const first = selected[0]!;
      const last = selected.at(-1)!;
      const start = first.range.start;
      const end = last.range.end;
      const fullEventLine =
        record.kind === "event" && selected.length === record.segments.length;
      if (fullEventLine) {
        append(
          record.raw,
          record.eol,
          record.id,
          selected.map((item) => [
            item.range.start - record.range.start,
            item.id,
          ]),
        );
        removals.push(timelineStatementRemoval(record));
      } else {
        append(
          record.indent + source.slice(start, end),
          model.sourceDocument.newline,
          nextTimelineIdentity(),
          selected.map((item) => [
            record.indent.length + item.range.start - start,
            item.id,
          ]),
        );
        removals.push({ range: { start, end }, value: "" });
      }
    }
  }
  return { removals, payload };
}
function periodOwnedIds(model: MermaidTimelineModel, id: string) {
  return new Set([
    id,
    ...model.events
      .filter((item) => item.periodId === id)
      .map((item) => item.id),
  ]);
}
function sectionOwnedIds(model: MermaidTimelineModel, id: string) {
  const periods = model.periods.filter((item) => item.sectionId === id);
  return new Set([
    id,
    ...periods.flatMap((item) => [...periodOwnedIds(model, item.id)]),
  ]);
}
function endOfRecords(
  model: MermaidTimelineModel,
  records: readonly TimelineSourceStatement[],
  fallback: number,
) {
  return records.length
    ? Math.max(
        ...records.map((item) =>
          timelineAfterPhysicalLine(model, item.range.end),
        ),
      )
    : fallback;
}
function sectionSlot(
  model: MermaidTimelineModel,
  sectionId: string,
  targetOrder: number,
  excluding?: string,
) {
  if (
    sectionId !== TIMELINE_UNSECTIONED_ID &&
    !model.sections.some((item) => item.id === sectionId)
  )
    return null;
  const periods = ordered(
    model.periods.filter(
      (item) => item.sectionId === sectionId && item.id !== excluding,
    ),
  );
  if (!validSlot(targetOrder, periods.length)) return null;
  if (periods[targetOrder]) return boundStart(model, periods[targetOrder]!.id);
  const last = periods.at(-1);
  if (last) {
    const record = timelineRecord(model, last.id)!;
    const nextSection = model.sourceDocument.statements.find(
      (item) =>
        item.kind === "section" && item.range.start > record.range.start,
    );
    const end = endOfRecords(
      model,
      ownedRecords(model, periodOwnedIds(model, last.id)),
      0,
    );
    return nextSection
      ? Math.min(
          end,
          boundStart(model, nextSection.id) ?? nextSection.range.start,
        )
      : end;
  }
  if (sectionId === TIMELINE_UNSECTIONED_ID) {
    const firstNamed = ordered(
      model.sections.filter((item) => !item.implicit),
    )[0];
    if (firstNamed) return boundStart(model, firstNamed.id);
    // Put the first period after complete diagram metadata, before an ambiguous remainder.
    const boundary = model.sourceDocument.statements.find(
      (item) => !item.complete,
    );
    return boundary?.range.start ?? model.sourceDocument.source.length;
  }
  const section = timelineRecord(model, sectionId);
  return section ? timelineAfterPhysicalLine(model, section.range.end) : null;
}
function eventSlot(
  model: MermaidTimelineModel,
  periodId: string,
  targetOrder: number,
  excluding?: string,
) {
  const period = timelineRecord(model, periodId);
  if (!period || !model.periods.some((item) => item.id === periodId))
    return null;
  const events = ordered(
    model.events.filter(
      (item) => item.periodId === periodId && item.id !== excluding,
    ),
  );
  if (!validSlot(targetOrder, events.length)) return null;
  const next = events[targetOrder];
  if (next) {
    const record = timelineRecord(model, next.id)!;
    const segment = timelineSegment(model, next.id)!;
    const comments = boundComments(model, new Set([next.id]));
    if (comments.length)
      return {
        offset: Math.min(...comments.map((item) => item.range.start)),
        inline: false,
      };
    return {
      offset:
        record.kind === "event" && record.segments[0]?.id === next.id
          ? record.range.start
          : segment.range.start,
      inline: record.kind === "period" || record.segments[0]?.id !== next.id,
    };
  }
  const last = events.at(-1);
  const record = last ? timelineRecord(model, last.id)! : period;
  return {
    offset: timelineAfterPhysicalLine(model, record.range.end),
    inline: false,
  };
}
function newLine(
  model: MermaidTimelineModel,
  value: string,
  statementId?: string,
  segmentId?: string,
) {
  const id = statementId ?? nextTimelineIdentity();
  const colon = value.indexOf(":");
  return {
    value: value + model.sourceDocument.newline,
    identities: {
      statements: [[0, id]] as [number, string][],
      segments: segmentId
        ? ([[colon, segmentId]] as [number, string][])
        : ([] as [number, string][]),
    },
  };
}
function localIndent(
  model: MermaidTimelineModel,
  kind: TimelineSourceStatement["kind"],
  anchorId?: string,
) {
  const siblings =
    kind === "period"
      ? model.periods
          .filter((item) => item.sectionId === anchorId)
          .map((item) => item.id)
      : kind === "event"
        ? model.events
            .filter((item) => item.periodId === anchorId)
            .map((item) => timelineRecord(model, item.id)?.id)
        : [];
  const local = model.sourceDocument.statements.find(
    (item) => item.kind === kind && siblings.includes(item.id),
  );
  if (local) return local.indent;
  return (
    model.sourceDocument.statements.find((item) => item.kind === kind)
      ?.indent ?? "  "
  );
}
function insertEvent(
  model: MermaidTimelineModel,
  id: string,
  raw: string,
  separator: string,
  periodId: string,
  slot: number,
  comments: readonly TimelineSourceStatement[] = [],
  removals: readonly TimelinePatch[] = [],
) {
  const target = eventSlot(model, periodId, slot, id);
  if (!target) return null;
  if (target.inline && !comments.length)
    return {
      range: { start: target.offset, end: target.offset },
      value: `${separator}${raw} `,
      identities: { statements: [], segments: [[0, id]] as [number, string][] },
    } satisfies TimelinePatch;
  const prefix = timelineRecordPayload(comments, model.sourceDocument.newline);
  const event = newLine(
    model,
    `${localIndent(model, "event", periodId)}${separator}${raw}`,
    undefined,
    id,
  );
  const payload = {
    value: prefix.value + event.value,
    identities: {
      statements: [
        ...prefix.identities.statements,
        ...event.identities.statements.map(
          ([point, identity]) =>
            [point + prefix.value.length, identity] as [number, string],
        ),
      ],
      segments: event.identities.segments.map(
        ([point, identity]) =>
          [point + prefix.value.length, identity] as [number, string],
      ),
    },
  };
  return timelineLineInsertion(model, target.offset, payload, removals);
}
function eventRemovals(model: MermaidTimelineModel, id: string) {
  const record = timelineRecord(model, id);
  const segment = timelineSegment(model, id);
  if (!record || !segment) return null;
  const comments = boundComments(model, new Set([id])).map((item) =>
    timelineRecord(model, item.id)!,
  );
  const entire = record.kind === "event" && record.segments.length === 1;
  const removedIds = new Set(comments.map((item) => item.id));
  removedIds.add(id);
  if (entire) removedIds.add(record.id);
  return {
    record,
    segment,
    comments,
    removedIds,
    patches: [
      entire
        ? timelineStatementRemoval(record)
        : { range: segment.range, value: "" },
      ...comments.map(timelineStatementRemoval),
    ],
  };
}

/** The impact and commit use identical ownership; no implicit cascade or replacement target. */
export function timelineDeleteImpact(
  model: MermaidTimelineModel,
  anchor: TimelineAnchor,
): TimelineDeleteImpact | null {
  if (
    !anchor.id ||
    anchor.kind === "diagram" ||
    (anchor.kind === "section" && anchor.id === TIMELINE_UNSECTIONED_ID)
  )
    return null;
  const exists =
    anchor.kind === "section"
      ? model.sections.some((item) => item.id === anchor.id)
      : anchor.kind === "period"
        ? model.periods.some((item) => item.id === anchor.id)
        : model.events.some((item) => item.id === anchor.id);
  if (!exists) return null;
  const periods =
    anchor.kind === "section"
      ? model.periods
          .filter((item) => item.sectionId === anchor.id)
          .map((item) => item.id)
      : anchor.kind === "period"
        ? [anchor.id]
        : [];
  const events =
    anchor.kind === "event"
      ? [anchor.id]
      : model.events
          .filter((item) => periods.includes(item.periodId))
          .map((item) => item.id);
  const ids = new Set([anchor.id, ...periods, ...events]);
  const comments = boundComments(model, ids).map((item) => item.id);
  return {
    anchor,
    periodIds: periods,
    eventIds: events,
    commentIds: comments,
    direct:
      comments.length === 0 &&
      (anchor.kind === "event" ||
        (anchor.kind === "period" && events.length === 0)),
    targets:
      anchor.kind === "section"
        ? [
            TIMELINE_UNSECTIONED_ID,
            ...model.sections
              .filter((item) => item.id !== anchor.id && !item.implicit)
              .map((item) => item.id),
          ]
        : anchor.kind === "period"
          ? model.periods
              .filter((item) => item.id !== anchor.id)
              .map((item) => item.id)
          : [],
  };
}

type SourcePiece = { readonly value: string; readonly origin: number | null };
function composeTimelinePatches(
  original: string,
  steps: readonly (readonly TimelinePatch[])[],
): TimelinePatch[] {
  let pieces: SourcePiece[] = [{ value: original, origin: 0 }];
  for (const patches of steps) {
    for (const patch of [...patches].sort(
      (a, b) => b.range.start - a.range.start || b.range.end - a.range.end,
    )) {
      const next: SourcePiece[] = [];
      let offset = 0;
      let inserted = false;
      for (const piece of pieces) {
        const end = offset + piece.value.length;
        if (offset < patch.range.start && end > patch.range.start)
          next.push({
            value: piece.value.slice(0, patch.range.start - offset),
            origin: piece.origin,
          });
        else if (end <= patch.range.start) next.push(piece);
        if (!inserted && end >= patch.range.start) {
          if (patch.value) next.push({ value: patch.value, origin: null });
          inserted = true;
        }
        if (offset >= patch.range.end && offset >= patch.range.start)
          next.push(piece);
        else if (end > patch.range.end)
          next.push({
            value: piece.value.slice(patch.range.end - offset),
            origin:
              piece.origin === null
                ? null
                : piece.origin + patch.range.end - offset,
          });
        offset = end;
      }
      if (!inserted && patch.value)
        next.push({ value: patch.value, origin: null });
      pieces = next;
    }
  }
  const patches: TimelinePatch[] = [];
  let cursor = 0;
  let value = "";
  for (const piece of pieces) {
    if (piece.origin === null) {
      value += piece.value;
      continue;
    }
    if (piece.origin < cursor) return []; // Unchanged origin slices must retain their relative order.
    if (value || piece.origin !== cursor)
      patches.push({ range: { start: cursor, end: piece.origin }, value });
    value = "";
    cursor = piece.origin + piece.value.length;
  }
  if (value || cursor !== original.length)
    patches.push({ range: { start: cursor, end: original.length }, value });
  return patches;
}

function applyDelete(
  model: MermaidTimelineModel,
  command: Extract<TimelineCommand, { type: "delete" }>,
): TimelineCommandResult {
  const impact = timelineDeleteImpact(model, command.anchor);
  if (!impact || (!impact.direct && !command.strategy))
    return timelineNoChange(model, "invalid", command.anchor.id);
  const id = impact.anchor.id!;
  if (command.strategy?.kind === "move") {
    const targetId = command.strategy.targetId;
    if (!impact.targets.includes(targetId))
      return timelineNoChange(model, "invalid", id);
    let current = model;
    const steps: (readonly TimelinePatch[])[] = [];
    const children =
      command.anchor.kind === "section" ? impact.periodIds : impact.eventIds;
    for (const child of children) {
      const move: TimelineCommand =
        command.anchor.kind === "section"
          ? {
              type: "period-move",
              id: child,
              targetSectionId: targetId,
              targetOrder: current.periods.filter(
                (item) => item.sectionId === targetId,
              ).length,
            }
          : {
              type: "event-move",
              id: child,
              targetPeriodId: targetId,
              targetOrder: current.events.filter(
                (item) => item.periodId === targetId,
              ).length,
            };
      const result = applyTimelineIntent(current, move);
      if (!result.changed) return timelineNoChange(model, result.reason, child);
      steps.push(result.patches);
      current = result.model;
    }
    const record = timelineRecord(current, id);
    if (!record) return timelineNoChange(model, "conflict", id);
    const comments = boundComments(current, new Set([id]));
    const removal = timelineStatementRemoval(record);
    // Container comments stay where they were, separated from the next object's binding.
    const anchors = new Map(
      comments.map((item) => [
        item.id,
        { kind: "diagram", id: null } as TimelineAnchor,
      ]),
    );
    const result = writeTimelinePatches(
      current,
      [
        {
          ...removal,
          value: comments.length ? current.sourceDocument.newline : "",
        },
      ],
      {
        removedIds: new Set([id]),
        commentAnchors: anchors,
        selection: children.length
          ? {
              kind: command.anchor.kind === "section" ? "period" : "event",
              id: children[0]!,
            }
          : null,
      },
    );
    if (!result.changed) return timelineNoChange(model, result.reason, id);
    // Intermediate pure reparses never reach the host or history. The final source is one transaction.
    return {
      ...result,
      patches: composeTimelinePatches(model.sourceDocument.source, [
        ...steps,
        result.patches,
      ]),
    };
  }
  if (command.anchor.kind === "event") {
    const removal = eventRemovals(model, id);
    if (!removal) return timelineNoChange(model, "conflict", id);
    const event = model.events.find((item) => item.id === id)!;
    const sibling = ordered(
      model.events.filter(
        (item) => item.periodId === event.periodId && item.id !== id,
      ),
    )[0];
    return writeTimelinePatches(model, removal.patches, {
      removedIds: removal.removedIds,
      selection: sibling
        ? { kind: "event", id: sibling.id }
        : { kind: "period", id: event.periodId },
    });
  }
  const ids = new Set([
    id,
    ...impact.periodIds,
    ...impact.eventIds,
    ...impact.commentIds,
  ]);
  const plan = moveSourcePlan(model, ids);
  for (const record of model.sourceDocument.statements)
    if (
      record.kind === "event" &&
      record.segments.every((item) => ids.has(item.id))
    )
      ids.add(record.id);
  const neighbor =
    command.anchor.kind === "section"
      ? model.sections.find((item) => item.id !== id)
      : model.periods.find((item) => item.id !== id);
  return writeTimelinePatches(model, plan.removals, {
    removedIds: ids,
    selection: neighbor ? { kind: command.anchor.kind, id: neighbor.id } : null,
  });
}

function prepareSectionAppend(
  model: MermaidTimelineModel,
  command: Extract<TimelineCommand, { type: "period-add" | "period-move" }>,
) {
  const excluding = command.type === "period-move" ? command.id : undefined;
  const periods = ordered(
    model.periods.filter(
      (item) =>
        item.sectionId === command.targetSectionId && item.id !== excluding,
    ),
  );
  if (command.targetOrder !== periods.length) return timelineNoChange(model);
  if (command.type === "period-move") {
    const same = ordered(
      model.periods.filter(
        (item) => item.sectionId === command.targetSectionId,
      ),
    );
    if (
      same.findIndex((item) => item.id === command.id) === command.targetOrder
    )
      return timelineNoChange(model);
  }
  const last = periods.at(-1);
  const period = last && timelineRecord(model, last.id);
  if (!period) return timelineNoChange(model);
  const nextSection = model.sourceDocument.statements.find(
    (item) => item.kind === "section" && item.range.start > period.range.start,
  );
  if (!nextSection) return timelineNoChange(model);
  const continuations = model.events.filter(
    (item) =>
      item.periodId === last!.id &&
      timelineSegment(model, item.id)!.range.start > nextSection.range.start,
  );
  if (!continuations.length) return timelineNoChange(model);
  const ids = new Set(continuations.map((item) => item.id));
  const plan = moveSourcePlan(model, ids);
  const earlier = model.sourceDocument.statements.filter(
    (item) =>
      item.range.start < nextSection.range.start &&
      (item.id === last!.id ||
        item.segments.some((segment) =>
          model.events.some(
            (event) => event.periodId === last!.id && event.id === segment.id,
          ),
        )),
  );
  const offset = endOfRecords(
    model,
    earlier,
    timelineAfterPhysicalLine(model, period.range.end),
  );
  return writeTimelinePatches(model, [
    ...plan.removals,
    timelineLineInsertion(model, offset, plan.payload, plan.removals),
  ]);
}

function applyTimelineIntent(
  model: MermaidTimelineModel,
  command: TimelineCommand,
): TimelineCommandResult {
  const source = model.sourceDocument.source;
  if (command.type === "period-add" || command.type === "period-move") {
    const prepared = prepareSectionAppend(model, command);
    if (prepared.changed) {
      const applied = applyTimelineIntent(prepared.model, command);
      if (!applied.changed) return timelineNoChange(model, applied.reason);
      return {
        ...applied,
        patches: composeTimelinePatches(source, [
          prepared.patches,
          applied.patches,
        ]),
      };
    }
    if (prepared.reason !== "no-change") return prepared;
  }
  if (command.type === "rename") {
    const { anchor, label } = command;
    const valid =
      anchor.kind === "section"
        ? isMermaidTimelineSectionLabel(label)
        : anchor.kind === "period"
          ? isMermaidTimelinePeriodLabel(label)
          : anchor.kind === "event" && isMermaidTimelineEventLabel(label);
    if (!valid || !anchor.id)
      return timelineNoChange(model, "invalid", anchor.id);
    if (anchor.kind === "section" && anchor.id === TIMELINE_UNSECTIONED_ID) {
      const first = ordered(
        model.periods.filter((item) => item.sectionId === anchor.id),
      )[0];
      const offset = first && boundStart(model, first.id);
      if (offset === null || offset === undefined)
        return timelineNoChange(model, "invalid", anchor.id);
      return writeTimelinePatches(
        model,
        [
          timelineLineInsertion(
            model,
            offset,
            newLine(
              model,
              `${localIndent(model, "section")}section ${label.trim()}`,
              anchor.id,
            ),
          ),
        ],
        { selection: anchor },
      );
    }
    const record = timelineRecord(model, anchor.id);
    const range =
      anchor.kind === "event"
        ? timelineSegment(model, anchor.id)?.valueRange
        : record?.valueRange;
    if (!range) return timelineNoChange(model, "conflict", anchor.id);
    return writeTimelinePatches(model, [{ range, value: label.trim() }], {
      selection: anchor,
    });
  }
  if (command.type === "direction") {
    const record = model.sourceDocument.statements.find(
      (item) => item.id === model.headerId,
    );
    if (!record || (command.value !== "LR" && command.value !== "TD"))
      return timelineNoChange(model, "invalid");
    const start = record.range.start + record.indent.length;
    const end =
      record.range.end - (record.raw.match(/[ \t]*$/)?.[0].length ?? 0);
    if (model.direction === command.value) return timelineNoChange(model);
    return writeTimelinePatches(model, [
      { range: { start, end }, value: `timeline ${command.value}` },
    ]);
  }
  if (command.type === "section-add") {
    const sections = ordered(model.sections.filter((item) => !item.implicit));
    if (
      !isMermaidTimelineSectionLabel(command.label) ||
      !validSlot(command.targetOrder, sections.length)
    )
      return timelineNoChange(model, "invalid");
    const boundary = sections[command.targetOrder];
    const offset = boundary
      ? boundStart(model, boundary.id)
      : (model.sourceDocument.statements.find((item) => !item.complete)?.range
          .start ?? source.length);
    if (offset === null) return timelineNoChange(model, "conflict");
    const id = nextTimelineIdentity();
    return writeTimelinePatches(
      model,
      [
        timelineLineInsertion(
          model,
          offset,
          newLine(
            model,
            `${localIndent(model, "section")}section ${command.label.trim()}`,
            id,
          ),
        ),
      ],
      { selection: { kind: "section", id } },
    );
  }
  if (command.type === "period-add") {
    if (!isMermaidTimelinePeriodLabel(command.label))
      return timelineNoChange(model, "invalid");
    const offset = sectionSlot(
      model,
      command.targetSectionId,
      command.targetOrder,
    );
    if (offset === null)
      return timelineNoChange(model, "invalid", command.targetSectionId);
    const id = nextTimelineIdentity();
    const result = writeTimelinePatches(
      model,
      [
        timelineLineInsertion(
          model,
          offset,
          newLine(
            model,
            `${localIndent(model, "period", command.targetSectionId)}${command.label.trim()}`,
            id,
          ),
        ),
      ],
      { selection: { kind: "period", id } },
    );
    return result.model.periods.find((item) => item.id === id)?.sectionId ===
      command.targetSectionId
      ? result
      : timelineNoChange(model, "invalid", command.targetSectionId);
  }
  if (command.type === "event-add") {
    if (!isMermaidTimelineEventLabel(command.label))
      return timelineNoChange(model, "invalid");
    const id = nextTimelineIdentity();
    const patch = insertEvent(
      model,
      id,
      command.label.trim(),
      timelineSegment(
        model,
        model.events.find((item) => item.periodId === command.targetPeriodId)
          ?.id ?? "",
      )?.separator ?? ": ",
      command.targetPeriodId,
      command.targetOrder,
    );
    if (!patch)
      return timelineNoChange(model, "invalid", command.targetPeriodId);
    const result = writeTimelinePatches(model, [patch], {
      selection: { kind: "event", id },
    });
    return result.model.events.find((item) => item.id === id)?.periodId ===
      command.targetPeriodId
      ? result
      : timelineNoChange(model, "invalid", command.targetPeriodId);
  }
  if (command.type === "section-move" || command.type === "period-move") {
    const section = command.type === "section-move";
    if (section && command.id === TIMELINE_UNSECTIONED_ID)
      return timelineNoChange(model, "invalid", command.id);
    const object = section
      ? model.sections.find((item) => item.id === command.id)
      : model.periods.find((item) => item.id === command.id);
    if (!object) return timelineNoChange(model, "conflict", command.id);
    const siblings = section
      ? ordered(
          model.sections.filter(
            (item) => !item.implicit && item.id !== command.id,
          ),
        )
      : ordered(
          model.periods.filter(
            (item) =>
              item.sectionId === command.targetSectionId &&
              item.id !== command.id,
          ),
        );
    if (!validSlot(command.targetOrder, siblings.length))
      return timelineNoChange(model, "invalid", command.id);
    const currentSiblings = section
      ? ordered(model.sections.filter((item) => !item.implicit))
      : ordered(
          model.periods.filter(
            (item) =>
              item.sectionId === (object as { sectionId: string }).sectionId,
          ),
        );
    if (
      (section ||
        (object as { sectionId: string }).sectionId ===
          command.targetSectionId) &&
      currentSiblings.findIndex((item) => item.id === command.id) ===
        command.targetOrder
    )
      return timelineNoChange(model);
    const ids = section
      ? sectionOwnedIds(model, command.id)
      : periodOwnedIds(model, command.id);
    const { removals, payload } = moveSourcePlan(model, ids);
    if (!removals.length)
      return timelineNoChange(model, "conflict", command.id);
    const target = section
      ? siblings[command.targetOrder]
        ? boundStart(model, siblings[command.targetOrder]!.id)
        : (model.sourceDocument.statements.find((item) => !item.complete)?.range
            .start ?? source.length)
      : sectionSlot(
          model,
          command.targetSectionId,
          command.targetOrder,
          command.id,
        );
    if (target === null) return timelineNoChange(model, "invalid", command.id);
    const patch = timelineLineInsertion(model, target, payload, removals);
    const changes = !section
      ? new Map([[command.id, command.targetSectionId]])
      : undefined;
    return writeTimelinePatches(model, [...removals, patch], {
      ownerChanges: changes,
      selection: { kind: section ? "section" : "period", id: command.id },
    });
  }
  if (command.type === "event-move") {
    const event = model.events.find((item) => item.id === command.id);
    if (
      !event ||
      !model.periods.some((item) => item.id === command.targetPeriodId)
    )
      return timelineNoChange(model, "invalid", command.id);
    const siblings = ordered(
      model.events.filter((item) => item.periodId === event.periodId),
    );
    if (
      event.periodId === command.targetPeriodId &&
      siblings.findIndex((item) => item.id === command.id) ===
        command.targetOrder
    )
      return timelineNoChange(model);
    const removal = eventRemovals(model, command.id);
    if (!removal) return timelineNoChange(model, "conflict", command.id);
    const patch = insertEvent(
      model,
      event.id,
      removal.segment.raw,
      removal.segment.separator,
      command.targetPeriodId,
      command.targetOrder,
      removal.comments,
      removal.patches,
    );
    if (!patch) return timelineNoChange(model, "invalid", command.id);
    // Moved identities are explicit payload destinations, not deleted objects.
    const removedIds = new Set(
      removal.record.kind === "event" && removal.record.segments.length === 1
        ? [removal.record.id]
        : [],
    );
    return writeTimelinePatches(model, [...removal.patches, patch], {
      removedIds,
      ownerChanges: new Map([[event.id, command.targetPeriodId]]),
      selection: { kind: "event", id: event.id },
    });
  }
  if (command.type === "delete") return applyDelete(model, command);
  if (command.type === "config") {
    if (
      command.value !== undefined &&
      !validTimelineConfigValue(command.field, command.value)
    )
      return timelineNoChange(model, "invalid");
    const patches = timelineConfigPatches(
      model.sourceDocument,
      command.field,
      command.value,
      command.statementId ? { statementId: command.statementId } : undefined,
    );
    return patches
      ? writeTimelinePatches(model, patches)
      : timelineNoChange(model, "conflict");
  }
  if (command.type === "metadata") {
    const existing = model.metadata.find(
      (item) => item.field === command.field && item.effective,
    );
    if (command.value === undefined) {
      if (!existing) return timelineNoChange(model);
      if (existing.format === "frontmatter")
        return timelineNoChange(model, "invalid", existing.id);
      const record = timelineRecord(model, existing.id)!;
      return writeTimelinePatches(model, [timelineStatementRemoval(record)], {
        removedIds: new Set([record.id]),
      });
    }
    const multiline =
      command.field === "accessibilityDescription" &&
      command.format === "multiline";
    if (
      (!multiline && /[\r\n]/.test(command.value)) ||
      (multiline && command.value.includes("}")) ||
      (command.field === "title" && !command.value.trim())
    )
      return timelineNoChange(model, "invalid", existing?.id);
    if (
      existing &&
      (existing.format === "frontmatter" ||
        (existing.format === "multiline") === multiline)
    ) {
      if (
        existing.value.replace(/\r\n|\r/g, "\n") ===
        command.value.replace(/\r\n|\r/g, "\n")
      )
        return timelineNoChange(model);
      return writeTimelinePatches(model, [
        {
          range: existing.valueRange,
          value:
            existing.format === "frontmatter"
              ? JSON.stringify(command.value)
              : command.value.replace(
                  /\r\n|\r|\n/g,
                  model.sourceDocument.newline,
                ),
        },
      ]);
    }
    const keyword =
      command.field === "title"
        ? "title "
        : command.field === "accessibilityTitle"
          ? "accTitle: "
          : multiline
            ? "accDescr {\n"
            : "accDescr: ";
    const value = `${keyword}${command.value}${multiline ? "\n}" : ""}`.replace(
      /\r\n|\r|\n/g,
      model.sourceDocument.newline,
    );
    if (existing) {
      const record = timelineRecord(model, existing.id)!;
      return writeTimelinePatches(model, [
        { range: record.range, value: record.indent + value },
      ]);
    }
    const header = timelineRecord(model, model.headerId!)!;
    const offset = timelineAfterPhysicalLine(model, header.range.end);
    return writeTimelinePatches(model, [
      timelineLineInsertion(model, offset, newLine(model, value)),
    ]);
  }
  if (command.type === "comment-edit" || command.type === "comment-delete") {
    const comment = model.comments.find((item) => item.id === command.id);
    const record = comment && timelineRecord(model, comment.id);
    if (!comment || !record)
      return timelineNoChange(model, "conflict", command.id);
    if (command.type === "comment-delete") {
      const inline = model.sourceDocument.statements.some(
        (item) =>
          item.kind === "period" &&
          item.range.line === record.range.line &&
          item.range.end === record.range.start,
      );
      return writeTimelinePatches(
        model,
        [
          inline
            ? { range: record.range, value: "" }
            : timelineStatementRemoval(record),
        ],
        { removedIds: new Set([record.id]) },
      );
    }
    if (/[\r\n]/.test(command.text))
      return timelineNoChange(model, "invalid", command.id);
    if (comment.text === command.text) return timelineNoChange(model);
    const start =
      record.range.start + record.indent.length + comment.marker.length;
    const leading =
      source.slice(start, record.range.end).match(/^[ \t]*/)?.[0].length ?? 0;
    return writeTimelinePatches(model, [
      {
        range: { start: start + leading, end: record.range.end },
        value: command.text,
      },
    ]);
  }
  if (command.type === "comment-add") {
    if (/[\r\n]/.test(command.text) || !command.text.trim())
      return timelineNoChange(model, "invalid", command.anchor.id);
    const id = nextTimelineIdentity();
    const text = `${localIndent(model, "comment")}%% ${command.text}`;
    let offset: number | null;
    if (command.anchor.kind === "diagram") {
      const header = timelineRecord(model, model.headerId!)!;
      offset = timelineAfterPhysicalLine(model, header.range.end);
      const payload = newLine(model, text, id);
      payload.value += model.sourceDocument.newline;
      return writeTimelinePatches(model, [
        timelineLineInsertion(model, offset, payload),
      ]);
    }
    if (!command.anchor.id || command.anchor.id === TIMELINE_UNSECTIONED_ID)
      return timelineNoChange(model, "invalid", command.anchor.id);
    const record = timelineRecord(model, command.anchor.id);
    if (!record) return timelineNoChange(model, "conflict", command.anchor.id);
    const payload = newLine(model, text, id);
    if (command.anchor.kind === "event") {
      const segment = timelineSegment(model, command.anchor.id);
      if (!segment)
        return timelineNoChange(model, "conflict", command.anchor.id);
      offset =
        record.kind === "event" && record.segments[0]?.id === segment.id
          ? record.range.start
          : segment.range.start;
    } else offset = boundStart(model, command.anchor.id);
    if (offset === null)
      return timelineNoChange(model, "invalid", command.anchor.id);
    const before = [...model.sourceDocument.statements]
      .reverse()
      .find((item) => item.range.end <= offset);
    // Header-near comments are diagram comments; an explicit object comment needs separation.
    if (before?.kind === "header" && offset === record.range.start) {
      payload.value = model.sourceDocument.newline + payload.value;
      payload.identities.statements = payload.identities.statements.map(
        ([point, identity]) => [
          point + model.sourceDocument.newline.length,
          identity,
        ],
      );
    }
    const patch = timelineLineInsertion(model, offset, payload);
    const result = writeTimelinePatches(model, [patch], {
      selection: command.anchor,
    });
    const created = result.model.comments.find((item) => item.id === id);
    return created?.anchor.kind === command.anchor.kind &&
      created.anchor.id === command.anchor.id
      ? result
      : timelineNoChange(model, "invalid", command.anchor.id);
  }
  return timelineNoChange(model, "invalid");
}

/** Pure source operation. The bridge rechecks capability and commits a changed result once. */
export function applyTimelineCommand(
  model: MermaidTimelineModel,
  command: TimelineCommand,
  context: TimelineCommandContext,
): TimelineCommandResult {
  if (context.readonly) return timelineNoChange(model, "readonly");
  if (context.baseSource !== model.sourceDocument.source)
    return timelineNoChange(model, "conflict");
  if (!model.headerId) return timelineNoChange(model, "invalid");
  return applyTimelineIntent(model, command);
}

/** All fields of a local form stage atomically before the single host transaction. */
export function applyTimelineCommands(
  model: MermaidTimelineModel,
  commands: readonly TimelineCommand[],
  context: TimelineCommandContext,
): TimelineCommandResult {
  if (context.readonly) return timelineNoChange(model, "readonly");
  if (context.baseSource !== model.sourceDocument.source)
    return timelineNoChange(model, "conflict");
  let current = model;
  let selection: TimelineAnchor | null = null;
  const steps: (readonly TimelinePatch[])[] = [];
  for (const command of commands) {
    const result = applyTimelineCommand(current, command, {
      ...context,
      baseSource: current.sourceDocument.source,
    });
    if (result.reason !== "applied" && result.reason !== "no-change")
      return timelineNoChange(model, result.reason);
    if (result.changed) {
      current = result.model;
      steps.push(result.patches);
      selection = result.selection ?? selection;
    }
  }
  if (current.sourceDocument.source === model.sourceDocument.source)
    return timelineNoChange(model);
  return {
    changed: true,
    source: current.sourceDocument.source,
    model: current,
    patches: composeTimelinePatches(model.sourceDocument.source, steps),
    selection,
    diagnostics: [],
    reason: "applied",
  };
}
