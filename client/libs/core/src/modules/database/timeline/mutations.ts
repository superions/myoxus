// SPDX-License-Identifier: AGPL-3.0-or-later

import { useService } from "@myoxus/infra";
import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import {
  DatabaseFieldKind,
  databaseRowQuery,
  updateDatabaseRowTitleMutation,
  createDatabaseRowMutation,
  type CreateDatabaseRowCellInput,
  type DatabaseCellValueInput,
  type BulkDatabaseCellPatchInput,
  bulkApplyDatabaseCellPatchesMutation,
} from "@myoxus/graphql";
import type { TimeTimelineTimeIntent } from "@myoxus/ui-facade";
import { useDatabaseConflictController } from "../presence";
import {
  getFieldById,
  isDatabaseProjectionField,
  getCellValue,
  getDatabaseCellEditRevision,
} from "../model";
import { executeNonForceableRevisionMutation } from "../presence/execute-revision-mutation";
import {
  scheduleCellValue,
  scheduleCalendarDay,
  scheduleWallTimeToInstant,
  scheduleFieldInterval,
  scheduleChangedTimeCells,
  scheduleRowIntervals,
  scheduleFieldValueInterval,
  type DatabaseScheduleInterval,
} from "../shared/schedule-values";
import { databaseZonedDateTime } from "../shared/schedule";
import { getDatabaseDateField } from "../shared/date-source";
import type { DatabaseChangeHandler } from "../shared/change-invalidation";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
  DatabaseView,
} from "../types";

export type TimelineTitleDraft = {
  row: DatabaseRowRecord;
  view: DatabaseView;
  titleFieldId: string;
  value: string;
};

export function timelineTitleDraft(
  row: DatabaseRowRecord,
  view: DatabaseView,
): TimelineTitleDraft | null {
  const titleFieldId = view.config.timeline?.titleFieldId;
  return titleFieldId && !row.redacted && !row.row.deletedAt
    ? { row, view, titleFieldId, value: row.row.title }
    : null;
}

/** Keep the opening row revision. Realtime readback must never silently rebase
 * a local title, and a pending Force must recheck the current capability.
 */
export function timelineTitleWritable(
  draft: TimelineTitleDraft,
  record: DatabaseRecord,
  view: DatabaseView,
  rows: DatabaseRowRecord[],
  canEdit: boolean,
) {
  const row = rows.find((row) => row.row.id === draft.row.row.id);
  return Boolean(
    canEdit &&
    row &&
    !row.redacted &&
    !row.row.deletedAt &&
    view.id === draft.view.id &&
    view.config.timeline?.titleFieldId === draft.titleFieldId &&
    getFieldById(record, draft.titleFieldId),
  );
}

export function timelineTitleConflict(
  draft: TimelineTitleDraft,
  rows: DatabaseRowRecord[],
) {
  const row = rows.find(
    (row) =>
      row.row.id === draft.row.row.id && !row.redacted && !row.row.deletedAt,
  );
  return row && row.row.editRevision !== draft.row.row.editRevision
    ? row.row.title
    : null;
}

export type TimelineCreateDraft = {
  record: DatabaseRecord;
  view: DatabaseView;
  startField: DatabaseField;
  endField: DatabaseField | null;
  start: number;
  end: number | null;
  title: string;
  chosen: boolean;
  startInput?: string | null;
  endInput?: string | null;
  confirmedId?: string;
  uncertain?: boolean;
};

export function timelineCreateDraft(
  record: DatabaseRecord,
  view: DatabaseView,
  start: number,
): TimelineCreateDraft | null {
  const startField = getDatabaseDateField(
    record,
    view.config.timeline?.startFieldId,
  );
  const endField =
    getDatabaseDateField(record, view.config.timeline?.endFieldId) ?? null;
  if (
    !startField ||
    (view.config.timeline?.endFieldId && !endField) ||
    [startField, endField].some(
      (field) => field && isDatabaseProjectionField(field.fieldType),
    )
  )
    return null;
  return {
    record,
    view,
    startField,
    endField,
    start,
    end: null,
    title: "",
    chosen: false,
  };
}

/** Fields are captured with the opening view. A changed mapping/configuration
 * requires explicit recovery; a changed revision remains a server conflict.
 */
export function timelineCreateWritable(
  draft: TimelineCreateDraft,
  record: DatabaseRecord,
  view: DatabaseView,
  canEdit: boolean,
) {
  return (
    canEdit &&
    view.id === draft.view.id &&
    view.config.timeline?.titleFieldId ===
      draft.view.config.timeline?.titleFieldId &&
    view.config.timeline?.startFieldId === draft.startField.id &&
    (view.config.timeline?.endFieldId ?? null) ===
      (draft.endField?.id ?? null) &&
    [draft.startField, draft.endField].every((field) => {
      if (!field) return true;
      const current = getFieldById(record, field.id);
      return (
        current &&
        !isDatabaseProjectionField(current.fieldType) &&
        current.fieldType === field.fieldType &&
        JSON.stringify(current.config) === JSON.stringify(field.config)
      );
    })
  );
}

export function timelineCreateCells(
  draft: TimelineCreateDraft,
): CreateDatabaseRowCellInput[] {
  for (const [field, value] of [
    [draft.startField, draft.start],
    [draft.endField ?? draft.startField, draft.end],
  ] as const)
    if (
      value !== null &&
      field.fieldType === DatabaseFieldKind.Date &&
      value % 86400000 !== 0
    )
      throw new Error("invalid-calendar-boundary");
  if (
    !Number.isFinite(draft.start) ||
    (draft.end !== null &&
      (!Number.isFinite(draft.end) || draft.end < draft.start))
  )
    throw new Error("invalid-range");
  const cells = [
    {
      fieldId: draft.startField.id,
      value: scheduleCellValue(
        draft.startField,
        draft.start,
        draft.endField ? null : draft.end,
        null,
      ),
    },
  ];
  if (draft.endField && draft.end !== null)
    cells.push({
      fieldId: draft.endField.id,
      value: scheduleCellValue(draft.endField, draft.end, null, null),
    });
  return cells;
}

export function timelineCreateDisplay(
  draft: TimelineCreateDraft,
  edge: "start" | "end",
) {
  const input = edge === "start" ? draft.startInput : draft.endInput;
  if (input !== undefined) return input;
  const field =
    edge === "start" ? draft.startField : (draft.endField ?? draft.startField);
  const value = edge === "start" ? draft.start : draft.end;
  return value === null
    ? null
    : field.fieldType === DatabaseFieldKind.Date
      ? new Date(value).toISOString().slice(0, 10)
      : databaseZonedDateTime(
          new Date(value).toISOString(),
          field.config.dateTime?.defaultTimeZone ?? "UTC",
        );
}

export function timelineCreateSetBoundary(
  draft: TimelineCreateDraft,
  edge: "start" | "end",
  value: string | null,
) {
  if (!value) return edge === "end" ? { ...draft, end: null } : draft;
  const field =
    edge === "start" ? draft.startField : (draft.endField ?? draft.startField);
  const instant =
    field.fieldType === DatabaseFieldKind.Date
      ? scheduleCalendarDay(value)
      : scheduleWallTimeToInstant(
          value,
          field.config.dateTime?.defaultTimeZone ?? "UTC",
        );
  const numeric = typeof instant === "string" ? Date.parse(instant) : instant;
  return {
    ...draft,
    [edge]: numeric ?? Number.NaN,
    [edge === "start" ? "startInput" : "endInput"]: value,
  };
}

export type TimelineTimeDraft = {
  item: DatabaseScheduleInterval;
  intent?: TimeTimelineTimeIntent;
  validation?: "invalid-local-time" | "end-before-start";
  view: DatabaseView;
  startField: DatabaseField;
  endField: DatabaseField | null;
  values: Record<string, DatabaseCellValueInput | null>;
  inputs: Partial<Record<"start" | "end", string | null>>;
  invalid: Partial<Record<"start" | "end", boolean>>;
};

export function timelineTimeDraft(
  item: DatabaseScheduleInterval,
  view: DatabaseView,
  startField: DatabaseField,
  endField: DatabaseField | null,
): TimelineTimeDraft {
  const values: TimelineTimeDraft["values"] = {};
  for (const field of [startField, endField]) {
    if (!field || isDatabaseProjectionField(field.fieldType)) continue;
    const resolved = scheduleFieldInterval(item.row, field);
    values[field.id] =
      resolved.kind === "ready"
        ? scheduleCellValue(
            field,
            resolved.interval.start,
            resolved.interval.end,
            resolved.interval,
            getCellValue(item.row, field.id)?.value.dateTime,
          )
        : null;
  }
  return { item, view, startField, endField, values, inputs: {}, invalid: {} };
}
function timelineDraftResolution(
  draft: TimelineTimeDraft,
  field: DatabaseField,
) {
  return field.id in draft.values
    ? scheduleFieldValueInterval(field, draft.values[field.id])
    : scheduleFieldInterval(draft.item.row, field);
}
export function timelineTimeInterval(
  draft: TimelineTimeDraft,
): DatabaseScheduleInterval | null {
  if (Object.values(draft.invalid).some(Boolean)) return null;
  const start = timelineDraftResolution(draft, draft.startField);
  const end = draft.endField
    ? timelineDraftResolution(draft, draft.endField)
    : null;
  if (start.kind !== "ready" || end?.kind === "invalid") return null;
  const finish =
    end?.kind === "ready"
      ? end.interval.start
      : draft.endField
        ? null
        : start.interval.end;
  return finish !== null && finish < start.interval.start
    ? null
    : { ...start.interval, end: finish, row: draft.item.row };
}
export function timelineTimeDisplay(
  draft: TimelineTimeDraft,
  edge: "start" | "end",
): string | null {
  if (draft.inputs[edge] !== undefined) return draft.inputs[edge] ?? null;
  const field =
    edge === "start" ? draft.startField : (draft.endField ?? draft.startField);
  const value =
    draft.values[field.id] ?? getCellValue(draft.item.row, field.id)?.value;
  const persisted = getCellValue(draft.item.row, field.id)?.value;
  const raw =
    edge === "end" && !draft.endField
      ? (value?.date?.end ?? value?.dateTime?.end)
      : (value?.date?.start ??
        value?.dateTime?.start ??
        persisted?.createdTime ??
        persisted?.updatedTime);
  if (typeof raw !== "string" || !raw) return null;
  if (field.fieldType === DatabaseFieldKind.Date) return raw;
  const resolution = timelineDraftResolution(draft, field);
  if (resolution.kind !== "ready") return null;
  return resolution.interval.allDay
    ? new Date(
        edge === "end" && !draft.endField
          ? resolution.interval.end!
          : resolution.interval.start,
      )
        .toISOString()
        .slice(0, 10)
    : databaseZonedDateTime(raw, resolution.interval.timeZone);
}
export function timelineTimeSettings(
  draft: TimelineTimeDraft,
  edge: "start" | "end",
) {
  const field =
    edge === "start" ? draft.startField : (draft.endField ?? draft.startField);
  const resolution = timelineDraftResolution(draft, field);
  return {
    field,
    editable: !isDatabaseProjectionField(field.fieldType),
    allDay:
      field.fieldType === DatabaseFieldKind.Date ||
      (resolution.kind === "ready" && resolution.interval.allDay),
    timeZone:
      resolution.kind === "ready"
        ? resolution.interval.timeZone
        : (field.config.dateTime?.defaultTimeZone ?? "UTC"),
  };
}
export function timelineTimeSetBoundary(
  draft: TimelineTimeDraft,
  edge: "start" | "end",
  input: string | null,
): TimelineTimeDraft {
  const { field, editable, allDay, timeZone } = timelineTimeSettings(
    draft,
    edge,
  );
  if (!editable) return draft;
  const instant = input
    ? allDay
      ? scheduleCalendarDay(input)
      : scheduleWallTimeToInstant(input, timeZone)
    : null;
  const rawBasis =
    draft.values[field.id]?.dateTime ??
    getCellValue(draft.item.row, field.id)?.value.dateTime;
  const rawBoundary =
    edge === "end" && !draft.endField ? rawBasis?.end : rawBasis?.start;
  const fraction =
    !allDay && rawBoundary ? new Date(rawBoundary).getUTCMilliseconds() : 0;
  const numeric =
    typeof instant === "string" ? Date.parse(instant) + fraction : instant;
  let next = {
    ...draft,
    inputs: { ...draft.inputs, [edge]: input },
    invalid: { ...draft.invalid, [edge]: numeric === null },
    values: { ...draft.values },
    validation: undefined,
  };
  if (numeric === null) return next;
  const current = timelineDraftResolution(draft, field);
  const existing = draft.values[field.id]?.dateTime;
  const previous = getCellValue(draft.item.row, field.id)?.value.dateTime;
  try {
    const old = current.kind === "ready" ? current.interval : null;
    next.values[field.id] = scheduleCellValue(
      field,
      edge === "end" && !draft.endField ? old!.start : numeric,
      edge === "end" && !draft.endField ? numeric : (old?.end ?? null),
      { allDay, timeZone },
      existing ?? previous,
    );
    // Validation inputs stay local; unchanged seconds and fractions are kept
    // by the shared serializer rather than rewritten from formatted labels.
    return next;
  } catch (error) {
    return {
      ...next,
      invalid: { ...next.invalid, [edge]: true },
      validation:
        error instanceof Error && error.message === "end-before-start"
          ? "end-before-start"
          : "invalid-local-time",
    };
  }
}
export function timelineTimeSetMetadata(
  draft: TimelineTimeDraft,
  edge: "start" | "end",
  changes: { allDay?: boolean; timeZone?: string },
): TimelineTimeDraft {
  const { field, editable } = timelineTimeSettings(draft, edge);
  const value = draft.values[field.id]?.dateTime;
  if (!editable || !value || !timelineTimeInterval(draft)) return draft;
  // A timezone edit retains instants. All-day changes reproject those same
  // stored bounds in the selected calendar and are previewed before Apply.
  return {
    ...draft,
    values: {
      ...draft.values,
      [field.id]: { dateTime: { ...value, ...changes } },
    },
    inputs: {},
    invalid: {},
    validation: undefined,
  };
}
export function timelineTimeSetRange(
  draft: TimelineTimeDraft,
  enabled: boolean,
): TimelineTimeDraft {
  const { field, editable } = timelineTimeSettings(draft, "end");
  if (!editable) return draft;
  const interval = timelineTimeInterval(draft);
  if (!interval) return draft;
  const values = { ...draft.values };
  if (!enabled && draft.endField) values[field.id] = null;
  else {
    const resolution = timelineDraftResolution(draft, field);
    const raw =
      draft.values[field.id]?.dateTime ??
      getCellValue(draft.item.row, field.id)?.value.dateTime;
    const options =
      resolution.kind === "ready"
        ? resolution.interval
        : field.fieldType === DatabaseFieldKind.Date
          ? null
          : {
              allDay: false,
              timeZone: field.config.dateTime?.defaultTimeZone ?? "UTC",
            };
    values[field.id] = scheduleCellValue(
      field,
      interval.start,
      draft.endField
        ? resolution.kind === "ready"
          ? resolution.interval.end
          : null
        : enabled
          ? interval.start
          : null,
      options,
      raw,
    );
  }
  return { ...draft, values, inputs: {}, invalid: {} };
}
/** Relative move/resize intents reuse the Gantt-proven serializer; only the
 * captured cell values change, never opening revisions or unowned endpoints.
 */
export function timelineTimeIntent(
  draft: TimelineTimeDraft,
  intent: TimeTimelineTimeIntent,
): TimelineTimeDraft {
  if (
    intent.id !== draft.item.row.row.id ||
    (intent.mode === "move" &&
      [draft.startField, draft.endField].some(
        (field) => field && isDatabaseProjectionField(field.fieldType),
      ))
  )
    return draft;
  const editable =
    intent.mode === "resize-start"
      ? draft.startField
      : (draft.endField ?? draft.startField);
  if (isDatabaseProjectionField(editable.fieldType)) return draft;
  const values = {
    ...timelineTimeDraft(
      draft.item,
      draft.view,
      draft.startField,
      draft.endField,
    ).values,
  };
  try {
    const cells = scheduleChangedTimeCells(
      draft.item,
      draft.startField,
      draft.endField,
      { ...intent, end: intent.end ?? intent.start },
    );
    for (const cell of cells) if (cell.value) values[cell.fieldId] = cell.value;
    const candidate = {
      ...draft,
      values,
      inputs: {},
      invalid: {},
      validation: undefined,
      intent,
    };
    // The shared serializer rejects inversions. Preserve the bad target as a
    // local validation instead of displaying the old value as a valid preview.
    if (intent.end !== null && intent.end < intent.start)
      return {
        ...candidate,
        invalid: { end: true },
        validation: "end-before-start",
      };
    return candidate;
  } catch (failure) {
    return {
      ...draft,
      intent,
      invalid: { start: true },
      validation:
        failure instanceof Error && failure.message === "end-before-start"
          ? "end-before-start"
          : "invalid-local-time",
    };
  }
}
export function timelineTimeConflict(
  draft: TimelineTimeDraft,
  rows: DatabaseRowRecord[],
) {
  const current = rows.find(
    (row) =>
      row.row.id === draft.item.row.row.id &&
      !row.redacted &&
      !row.row.deletedAt,
  );
  return (
    current &&
    [draft.startField, draft.endField].some(
      (field) =>
        field &&
        !isDatabaseProjectionField(field.fieldType) &&
        getDatabaseCellEditRevision(current, field.id) !==
          getDatabaseCellEditRevision(draft.item.row, field.id),
    )
  );
}
export function timelineCurrentTime(
  draft: TimelineTimeDraft,
  rows: DatabaseRowRecord[],
) {
  const current = rows.find(
    (row) =>
      row.row.id === draft.item.row.row.id &&
      !row.redacted &&
      !row.row.deletedAt,
  );
  return current
    ? (scheduleRowIntervals([current], draft.startField, draft.endField)
        .intervals[0] ?? null)
    : null;
}
export function timelineTimeError(
  draft: TimelineTimeDraft,
): "invalid-local-time" | "end-before-start" | null {
  if (draft.validation) return draft.validation;
  if (timelineTimeInterval(draft)) return null;
  const start = timelineDraftResolution(draft, draft.startField);
  const end = draft.endField
    ? timelineDraftResolution(draft, draft.endField)
    : start;
  if (start.kind === "ready" && end.kind === "ready") {
    const last = draft.endField ? end.interval.start : start.interval.end;
    if (last !== null && last < start.interval.start) return "end-before-start";
  }
  return "invalid-local-time";
}
export function timelineTimeCells(
  draft: TimelineTimeDraft,
): BulkDatabaseCellPatchInput[] {
  if (!timelineTimeInterval(draft)) throw new Error("invalid-range");
  return [draft.startField, draft.endField].flatMap((field) => {
    if (!field || isDatabaseProjectionField(field.fieldType)) return [];
    const value = draft.values[field.id];
    const basis = timelineTimeDraft(
      draft.item,
      draft.view,
      draft.startField,
      draft.endField,
    ).values[field.id];
    if (JSON.stringify(value) === JSON.stringify(basis)) return [];
    const expectedEditRevision = getDatabaseCellEditRevision(
      draft.item.row,
      field.id,
    );
    return [
      {
        fieldId: field.id,
        expectedEditRevision,
        ...(value === null ? { clear: true } : { value }),
      },
    ];
  });
}
export function timelineTimeWritable(
  draft: TimelineTimeDraft,
  record: DatabaseRecord,
  view: DatabaseView,
  rows: DatabaseRowRecord[],
  canEdit: boolean,
) {
  const row = rows.find((row) => row.row.id === draft.item.row.row.id);
  return Boolean(
    canEdit &&
    row &&
    !row.redacted &&
    !row.row.deletedAt &&
    view.id === draft.view.id &&
    view.config.timeline?.startFieldId === draft.startField.id &&
    (view.config.timeline?.endFieldId ?? null) ===
      (draft.endField?.id ?? null) &&
    [draft.startField, draft.endField].every(
      (field) =>
        !field ||
        (() => {
          const current = getFieldById(record, field.id);
          return (
            current &&
            current.fieldType === field.fieldType &&
            JSON.stringify(current.config) === JSON.stringify(field.config)
          );
        })(),
    ),
  );
}

export function useTimelineMutations(
  databaseId: string,
  workspaceId: string,
  onChanged: DatabaseChangeHandler,
  titleWritable: (draft: TimelineTitleDraft) => boolean,
  createWritable: (draft: TimelineCreateDraft) => boolean,
  timeWritable: (draft: TimelineTimeDraft) => boolean,
) {
  const conflicts = useDatabaseConflictController();
  const graphqlService = useService(GraphQLService);
  const title = useMutation({ mutation: updateDatabaseRowTitleMutation });
  const create = useMutation({ mutation: createDatabaseRowMutation });
  const bulk = useMutation({ mutation: bulkApplyDatabaseCellPatchesMutation });
  return {
    discardConflict: (rowId: string) =>
      conflicts.dismiss?.(`timeline:${databaseId}:${rowId}`),
    time: async (
      draft: TimelineTimeDraft,
      localValue: string,
      currentLabel: (interval: DatabaseScheduleInterval | null) => string,
      recovered: () => void,
    ) => {
      if (!timeWritable(draft)) return false;
      const cells = timelineTimeCells(draft);
      if (!cells.length) return true;
      const changed = () =>
        onChanged({
          kind: "cell_updated",
          target: { rowId: draft.item.row.row.id },
        });
      const result = await conflicts.execute({
        scope: `timeline:${databaseId}:${draft.item.row.row.id}`,
        attemptedAction: draft.startField.name,
        canOverwrite: () => timeWritable(draft),
        localValue,
        readServerValue: async () => {
          const response = await graphqlService.gql({
            query: databaseRowQuery,
            variables: {
              workspaceId,
              databaseId,
              rowId: draft.item.row.row.id,
            },
          });
          const current = response.workspace?.databaseRow;
          await onChanged();
          if (current?.redacted) throw new Error("Database row forbidden.");
          if (!current || current.row.deletedAt)
            throw new Error("Database row not found.");
          return currentLabel(
            scheduleRowIntervals([current], draft.startField, draft.endField)
              .intervals[0] ?? null,
          );
        },
        mutate: (force) => {
          if (!timeWritable(draft))
            throw new Error("Database time is no longer writable.");
          return bulk.trigger({
            input: {
              databaseId,
              patches: [{ rowId: draft.item.row.row.id, cells }],
              force,
            },
          });
        },
        reloadLatest: async () => {
          await onChanged();
          recovered();
        },
        afterSuccess: changed,
        afterForceSuccess: async () => {
          await changed();
          recovered();
        },
      });
      return Boolean(result);
    },
    create: async (
      draft: TimelineCreateDraft,
      confirmed: (id: string) => void,
      recovered: () => void,
    ) => {
      if (
        !draft.title.trim() ||
        !createWritable(draft) ||
        draft.uncertain ||
        draft.confirmedId
      )
        return null;
      const result = await executeNonForceableRevisionMutation(
        conflicts,
        create.trigger,
        {
          databaseId,
          viewId: draft.view.id,
          expectedViewEditRevision: draft.view.editRevision,
          title: draft.title.trim(),
          cells: timelineCreateCells(draft),
        },
        {
          attemptedAction: draft.startField.name,
          localValue: draft.title.trim(),
          reloadLatest: async () => {
            await onChanged();
            recovered();
          },
          afterSuccess: async (result) => {
            if (!result)
              throw new Error("Database row creation returned no result.");
            // Remember the confirmed ID before readback. A readback failure must
            // retry retrieval, never create a second row.
            const id = result.createDatabaseRow.row.id;
            confirmed(id);
            await onChanged({ kind: "row_created", target: { rowId: id } });
          },
        },
      );
      return result?.createDatabaseRow.row.id ?? null;
    },
    rename: async (draft: TimelineTitleDraft, recovered: () => void) => {
      const value = draft.value.trim();
      if (!value || !titleWritable(draft)) return false;
      if (value === draft.row.row.title) return true;
      const changed = () =>
        onChanged({ kind: "row_updated", target: { rowId: draft.row.row.id } });
      const result = await conflicts.execute({
        scope: `timeline:${databaseId}:${draft.row.row.id}`,
        attemptedAction: draft.row.row.title,
        canOverwrite: () => titleWritable(draft),
        localValue: value,
        mutate: (force) => {
          if (!titleWritable(draft))
            throw new Error("Database title is no longer writable.");
          return title.trigger({
            input: {
              databaseId,
              rowId: draft.row.row.id,
              title: value,
              titleFieldId: draft.titleFieldId,
              expectedEditRevision: draft.row.row.editRevision,
              force,
            },
          });
        },
        reloadLatest: async () => {
          await onChanged();
          recovered();
        },
        afterSuccess: changed,
        afterForceSuccess: async () => {
          await changed();
          recovered();
        },
      });
      return Boolean(result);
    },
  };
}
