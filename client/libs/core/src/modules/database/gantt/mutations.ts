// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import { useI18n } from "@myoxus/i18n";
import {
  DatabaseFieldKind,
  bulkApplyDatabaseCellPatchesMutation,
  updateDatabaseRowTitleMutation,
  createDatabaseRowMutation,
  type CreateDatabaseRowCellInput,
  type DatabaseCellValueInput,
  type BulkDatabaseCellPatchInput,
} from "@myoxus/graphql";
import type { GanttMoveIntent, GanttCreateDraft } from "@myoxus/ui-facade";

import {
  createCellValueInput,
  getCellValue,
  getCellPrimitiveValue,
  getFieldById,
  isDatabaseProjectionField,
  getDatabaseCellEditRevision,
} from "../model";
import { useDatabaseConflictController } from "../presence";
import {
  executeNonForceableRevisionMutation,
  executeRevisionMutation,
} from "../presence/execute-revision-mutation";
import type { DatabaseChangeHandler } from "../shared/change-invalidation";
import {
  scheduleCellValue,
  scheduleChangedTimeCells,
  type DatabaseScheduleInterval,
} from "../shared/schedule-values";
import type {
  DatabaseField,
  DatabaseRowRecord,
  DatabaseRecord,
  DatabaseView,
} from "../types";

/** DateTime group buckets use the server's UTC date, including offset values. */
function scheduleGroupKey(value?: DatabaseCellValueInput | null) {
  const date = value?.date?.start;
  if (typeof date === "string") return date;
  const dateTime = value?.dateTime?.start;
  return typeof dateTime === "string" && dateTime
    ? new Date(dateTime).toISOString().slice(0, 10)
    : null;
}

/** A lane key is a membership identity, never an arbitrary scalar/date value. */
export function ganttGroupCellValue(
  field: DatabaseField,
  sourceKey: string | null,
  targetKey: string,
  row?: DatabaseRowRecord,
  explicitDate?: string,
): DatabaseCellValueInput | null {
  if (isDatabaseProjectionField(field.fieldType))
    throw new Error("projection-readonly");
  const multi = [
    DatabaseFieldKind.MultiSelect,
    DatabaseFieldKind.Tags,
    DatabaseFieldKind.Users,
  ].includes(field.fieldType);
  if (multi) {
    const previous = row ? getCellPrimitiveValue(row, field) : [];
    const values = (Array.isArray(previous) ? previous.map(String) : []).filter(
      (value) => value !== sourceKey,
    );
    if (targetKey !== "__empty__" && !values.includes(targetKey))
      values.push(targetKey);
    return values.length ? createCellValueInput(field, values) : null;
  }
  if (targetKey === "__empty__") return null;
  if (
    field.fieldType === DatabaseFieldKind.Date ||
    field.fieldType === DatabaseFieldKind.DateTime
  ) {
    if (!explicitDate) throw new Error("group-date-required");
    const instant =
      field.fieldType === DatabaseFieldKind.Date
        ? Date.parse(`${explicitDate}T00:00:00Z`)
        : Date.parse(explicitDate);
    if (
      !Number.isFinite(instant) ||
      new Date(instant).toISOString().slice(0, 10) !== targetKey
    )
      throw new Error("invalid-lane");
    const previous = row ? getCellValue(row, field.id)?.value : null;
    if (field.fieldType === DatabaseFieldKind.Date)
      return {
        date: { start: explicitDate, end: previous?.date?.end ?? null },
      };
    // The operator selected an exact instant. Preserve the cell's remaining
    // range/zone metadata without replacing that choice with its old clock.
    return createCellValueInput(field, {
      start: new Date(instant).toISOString(),
      end: previous?.dateTime?.end ?? null,
      allDay: previous?.dateTime?.allDay ?? false,
      timeZone:
        previous?.dateTime?.timeZone ??
        field.config.dateTime?.defaultTimeZone ??
        "UTC",
    });
  }
  if (field.fieldType === DatabaseFieldKind.Checkbox) {
    if (targetKey !== "true" && targetKey !== "false")
      throw new Error("invalid-lane");
    return { checkbox: targetKey === "true" };
  }
  if (
    ![
      DatabaseFieldKind.Select,
      DatabaseFieldKind.Status,
      DatabaseFieldKind.User,
    ].includes(field.fieldType)
  )
    throw new Error("invalid-lane");
  return createCellValueInput(field, targetKey);
}

export function ganttCreateCells(
  record: DatabaseRecord,
  view: DatabaseView,
  draft: GanttCreateDraft,
  explicitGroupDate?: string,
): CreateDatabaseRowCellInput[] {
  const config = view.config.gantt;
  const start = getFieldById(record, config?.startFieldId ?? "");
  const end = getFieldById(record, config?.endFieldId ?? "");
  if (!start || isDatabaseProjectionField(start.fieldType))
    throw new Error("projection-readonly");
  // A new row always has Created/Updated metadata. Such an end cannot stay
  // empty for a point or accept an explicit range boundary from Gantt Create.
  if (
    (end && isDatabaseProjectionField(end.fieldType)) ||
    (draft.end !== undefined && draft.end < draft.start)
  )
    throw new Error("projection-readonly");
  const values = new Map<string, DatabaseCellValueInput>();
  values.set(
    start.id,
    scheduleCellValue(
      start,
      draft.start,
      end ? null : (draft.end ?? null),
      null,
    ),
  );
  if (end && draft.end !== undefined)
    values.set(end.id, scheduleCellValue(end, draft.end, null, null));
  const group = getFieldById(record, config?.group?.fieldId ?? "");
  if (group) {
    const scheduled = values.get(group.id);
    if (scheduled) {
      if (scheduleGroupKey(scheduled) !== draft.sectionId)
        throw new Error("invalid-lane");
    } else {
      const value = ganttGroupCellValue(
        group,
        null,
        draft.sectionId,
        undefined,
        explicitGroupDate,
      );
      if (value) values.set(group.id, value);
    }
  }
  return [...values].map(([fieldId, value]) => ({ fieldId, value }));
}

/** Resolve one final intent per field, including aliasing schedule/group roles. */
export function ganttMoveCells(
  item: DatabaseScheduleInterval,
  startField: DatabaseField,
  endField: DatabaseField | null,
  intent: GanttMoveIntent,
  groupField: DatabaseField | null,
  sourceKey: string,
  explicitGroupDate?: string,
): BulkDatabaseCellPatchInput[] {
  if (
    !Number.isFinite(intent.start) ||
    !Number.isFinite(intent.end) ||
    intent.end < intent.start
  )
    throw new Error("invalid-lane");
  const cells = scheduleChangedTimeCells(item, startField, endField, intent);
  if (!groupField || !intent.targetLaneId || intent.targetLaneId === sourceKey)
    return cells;
  const scheduled = cells.find((cell) => cell.fieldId === groupField.id);
  if (scheduled) {
    if (scheduleGroupKey(scheduled.value) !== intent.targetLaneId)
      throw new Error("invalid-lane");
    return cells;
  }
  const value = ganttGroupCellValue(
    groupField,
    sourceKey,
    intent.targetLaneId,
    item.row,
    explicitGroupDate,
  );
  cells.push({
    fieldId: groupField.id,
    expectedEditRevision: getDatabaseCellEditRevision(item.row, groupField.id),
    ...(value ? { value } : { clear: true }),
  });
  return cells;
}

export type GanttDependencyIntent = {
  kind: "create" | "remove" | "source" | "target";
  dependent: DatabaseRowRecord;
  prerequisiteId: string;
  targetRow?: DatabaseRowRecord;
};

/** Relation order and unrelated targets survive each explicit edge intent. */
export function ganttDependencyPatches(
  field: DatabaseField,
  intent: GanttDependencyIntent,
) {
  const { dependent, prerequisiteId, targetRow } = intent;
  if (
    dependent.redacted ||
    dependent.row.deletedAt ||
    targetRow?.redacted ||
    targetRow?.row.deletedAt
  )
    throw new Error("invalid-dependency");
  const ids = (row: DatabaseRowRecord) => [
    ...(getCellValue(row, field.id)?.value.relation ?? []),
  ];
  const cell = (
    row: DatabaseRowRecord,
    relation: string[],
  ): BulkDatabaseCellPatchInput => ({
    fieldId: field.id,
    expectedEditRevision: getDatabaseCellEditRevision(row, field.id),
    ...(relation.length ? { value: { relation } } : { clear: true }),
  });
  const previous = ids(dependent);
  if (intent.kind === "create") {
    if (
      dependent.row.id === prerequisiteId ||
      previous.includes(prerequisiteId)
    )
      throw new Error("invalid-dependency");
    return [
      {
        rowId: dependent.row.id,
        cells: [cell(dependent, [...previous, prerequisiteId])],
      },
    ];
  }
  const index = previous.indexOf(prerequisiteId);
  if (index < 0) throw new Error("invalid-dependency");
  if (intent.kind === "remove")
    return [
      {
        rowId: dependent.row.id,
        cells: [
          cell(
            dependent,
            previous.filter((id) => id !== prerequisiteId),
          ),
        ],
      },
    ];
  if (!targetRow) throw new Error("invalid-dependency");
  if (intent.kind === "source") {
    if (targetRow.row.id === prerequisiteId) return [];
    if (
      targetRow.row.id === dependent.row.id ||
      previous.includes(targetRow.row.id)
    )
      throw new Error("invalid-dependency");
    previous[index] = targetRow.row.id;
    return [{ rowId: dependent.row.id, cells: [cell(dependent, previous)] }];
  }
  if (targetRow.row.id === dependent.row.id) return [];
  const targetIds = ids(targetRow);
  if (targetRow.row.id === prerequisiteId || targetIds.includes(prerequisiteId))
    throw new Error("invalid-dependency");
  return [
    {
      rowId: dependent.row.id,
      cells: [
        cell(
          dependent,
          previous.filter((id) => id !== prerequisiteId),
        ),
      ],
    },
    {
      rowId: targetRow.row.id,
      cells: [cell(targetRow, [...targetIds, prerequisiteId])],
    },
  ];
}

/** Mutation owner retains the exact opening revisions and canonical readback. */
export function useGanttMutations(
  databaseId: string,
  onChanged: DatabaseChangeHandler,
) {
  const t = useI18n();
  const conflicts = useDatabaseConflictController();
  const bulk = useMutation({ mutation: bulkApplyDatabaseCellPatchesMutation });
  const create = useMutation({ mutation: createDatabaseRowMutation });
  const title = useMutation({ mutation: updateDatabaseRowTitleMutation });
  const changed = (rowId: string) =>
    onChanged({ kind: "cell_updated", target: { rowId } });
  return {
    dependency: async (
      field: DatabaseField,
      intent: GanttDependencyIntent,
      onReloadLatest: () => void,
      description?: string,
    ) => {
      const patches = ganttDependencyPatches(field, intent);
      if (!patches.length) return true;
      const result = await executeRevisionMutation(
        conflicts,
        bulk.trigger,
        { databaseId, patches },
        {
          attemptedAction: field.name,
          localValue: description ?? intent.dependent.row.title,
          reloadLatest: async () => {
            await onChanged();
            onReloadLatest();
          },
          afterSuccess: () => onChanged(),
          afterForceSuccess: async () => {
            await onChanged();
            onReloadLatest();
          },
        },
      );
      return Boolean(result);
    },
    create: async (
      record: DatabaseRecord,
      view: DatabaseView,
      draft: GanttCreateDraft,
      value: string,
      explicitGroupDate?: string,
    ) => {
      const next = value.trim();
      if (!next) return null;
      const cells = ganttCreateCells(record, view, draft, explicitGroupDate);
      const result = await executeNonForceableRevisionMutation(
        conflicts,
        create.trigger,
        {
          databaseId,
          viewId: view.id,
          expectedViewEditRevision: view.editRevision,
          title: next,
          cells,
        },
        {
          attemptedAction: t["com.myoxus.database.row.add"](),
          localValue: next,
          reloadLatest: () => onChanged(),
          afterSuccess: (result) =>
            result &&
            onChanged({
              kind: "row_created",
              target: { rowId: result.createDatabaseRow.row.id },
            }),
        },
      );
      return result?.createDatabaseRow.row.id ?? null;
    },
    schedule: async (
      item: DatabaseScheduleInterval,
      startField: DatabaseField,
      endField: DatabaseField | null,
      intent: GanttMoveIntent,
      groupField: DatabaseField | null = null,
      sourceKey = "all",
      explicitGroupDate?: string,
      targetLaneLabel?: string,
      onRecovered?: () => void,
    ) => {
      const cells = ganttMoveCells(
        item,
        startField,
        endField,
        intent,
        groupField,
        sourceKey,
        explicitGroupDate,
      );
      if (!cells.length) return;
      const localValue = cells
        .map((cell) => {
          const field = [startField, endField, groupField].find(
            (field) => field?.id === cell.fieldId,
          );
          const value = cell.value?.date ?? cell.value?.dateTime;
          const dateTime = cell.value?.dateTime;
          const formatter = new Intl.DateTimeFormat(t.language, {
            dateStyle: "medium",
            timeStyle: dateTime && !dateTime.allDay ? "short" : undefined,
            timeZone: dateTime?.timeZone ?? "UTC",
          });
          const label = value
            ? [value.start, value.end]
                .filter((boundary): boundary is string => Boolean(boundary))
                .map((boundary) => formatter.format(new Date(boundary)))
                .join(" – ")
            : cell.clear
              ? t["com.myoxus.database.cell.empty"]()
              : (targetLaneLabel ?? field?.name);
          return `${field?.name ?? startField.name}: ${label}`;
        })
        .join("\n");
      return executeRevisionMutation(
        conflicts,
        bulk.trigger,
        { databaseId, patches: [{ rowId: item.row.row.id, cells }] },
        {
          attemptedAction: startField.name,
          localValue,
          reloadLatest: async () => {
            await onChanged();
            onRecovered?.();
          },
          afterSuccess: () => changed(item.row.row.id),
          afterForceSuccess: async () => {
            await changed(item.row.row.id);
            onRecovered?.();
          },
        },
      );
    },
    rename: async (
      row: DatabaseRowRecord,
      titleFieldId: string,
      value: string,
      onReloadLatest?: () => void,
    ) => {
      const next = value.trim();
      if (!next || next === row.row.title) return true;
      const result = await executeRevisionMutation(
        conflicts,
        title.trigger,
        {
          databaseId,
          rowId: row.row.id,
          title: next,
          titleFieldId,
          // Title is stored on the row; its canonical mutation guards the
          // captured row revision, even though the API names a title field.
          expectedEditRevision: row.row.editRevision,
        },
        {
          attemptedAction: row.row.title,
          localValue: next,
          reloadLatest: async () => {
            await onChanged();
            onReloadLatest?.();
          },
          afterSuccess: () =>
            onChanged({ kind: "row_updated", target: { rowId: row.row.id } }),
          afterForceSuccess: async () => {
            await onChanged({
              kind: "row_updated",
              target: { rowId: row.row.id },
            });
            onReloadLatest?.();
          },
        },
      );
      return Boolean(result);
    },
  };
}
