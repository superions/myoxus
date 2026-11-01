// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  GanttTaskView,
  GanttListRowView,
  GanttSectionView,
  GanttDependencyView,
  GanttExternalEndpointView,
} from "@myoxus/ui-facade";

import { getCellValue, isDatabaseProjectionField } from "../model";
import {
  DatabaseFieldKind,
  DatabaseTimelineZoom,
  type DatabaseRowGroupSummaryFragment,
} from "@myoxus/graphql";
import { temporalOverlaps } from "@myoxus/ui-facade";
import type { DatabaseRecord, DatabaseRowRecord, DatabaseView } from "../types";
import {
  scheduleFieldInterval,
  scheduleRowIntervals,
  type DatabaseScheduleInterval,
} from "../shared/schedule-values";
import { getDatabaseDateField } from "../shared/date-source";
import {
  databaseTemporalAxis,
  databaseTemporalTicks,
} from "../shared/temporal";

/** Pure adapter: server records and resolved times in, neutral geometry out. */
export function projectDatabaseGantt({
  record,
  rows,
  rowGroups,
  view,
  date,
  locale,
  canEdit,
  selectedRowId,
  ungroupedLabel,
  readonlyReason,
  unavailableLabel,
  collapsedGroupKeys = [],
}: {
  record: DatabaseRecord;
  rows: DatabaseRowRecord[];
  rowGroups?: DatabaseRowGroupSummaryFragment[];
  view: DatabaseView;
  date: string;
  locale: string;
  canEdit: boolean;
  selectedRowId: string | null;
  ungroupedLabel: string;
  readonlyReason: string;
  unavailableLabel: string;
  collapsedGroupKeys?: readonly string[];
}) {
  const config = view.config.gantt;
  const startField = getDatabaseDateField(record, config?.startFieldId);
  const endField = getDatabaseDateField(record, config?.endFieldId) ?? null;
  const zoom = config?.zoom ?? DatabaseTimelineZoom.Month;
  const bounds = databaseTemporalAxis(date, zoom, locale);
  const axis = {
    ...bounds,
    ticks: databaseTemporalTicks(bounds, locale, zoom),
    valueLabel: (value: number) =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeZone: "UTC",
        ...(zoom === DatabaseTimelineZoom.Day
          ? { timeStyle: "short" as const }
          : {}),
      }).format(value),
  };
  const resolved = startField
    ? scheduleRowIntervals(rows, startField, endField)
    : { intervals: [], diagnostics: [] };
  const intervals = resolved.intervals.filter((item) =>
    temporalOverlaps({ start: item.start, end: item.end ?? undefined }, axis),
  );
  const sections: GanttSectionView[] = config?.group
    ? (rowGroups ?? []).map((group, order) => ({
        id: group.key,
        label: group.label,
        order,
        count: group.rowCount,
        collapsed: collapsedGroupKeys.includes(group.key),
      }))
    : [{ id: "all", label: ungroupedLabel, order: 0 }];
  const sectionKeys = new Set(sections.map((section) => section.id));
  // The tuple stays collision-free even when opaque keys contain separators.
  // Server membership determines every copy; no cell regrouping or sorting
  // may replace the authoritative Row order or catalog order.
  const projections = intervals.flatMap((item) =>
    (config?.group ? item.row.groupKeys : ["all"])
      .filter((key) => sectionKeys.has(key))
      .map((key) => ({
        id: JSON.stringify([item.row.row.id, key]),
        key,
        item,
      })),
  );
  const startEditable = Boolean(
    startField && !isDatabaseProjectionField(startField.fieldType),
  );
  const endEditable =
    !endField || !isDatabaseProjectionField(endField.fieldType);
  const endpointStep = (item: DatabaseScheduleInterval) => {
    const resolution = endField
      ? scheduleFieldInterval(item.row, endField)
      : null;
    return (
      resolution?.kind === "ready" ? resolution.interval.allDay : item.allDay
    )
      ? 86_400_000
      : axis.step;
  };
  const canConnect = Boolean(
    canEdit &&
    config?.dependencyFieldId &&
    record.fields.some(
      (field) =>
        field.id === config.dependencyFieldId &&
        field.fieldType === DatabaseFieldKind.Relation,
    ),
  );
  const tasks: GanttTaskView[] = projections.map(({ id, key, item }) => ({
    id,
    sectionId: key,
    label: item.row.row.title,
    start: item.start,
    end: item.end ?? item.start,
    milestone: item.end === null || item.end === item.start,
    preciseRange: true,
    selected: item.row.row.id === selectedRowId,
    connect: {
      enabled: canConnect,
    },
    laneMove: {
      enabled: Boolean(
        canEdit &&
        config?.group &&
        !isDatabaseProjectionField(
          record.fields.find((field) => field.id === config.group!.fieldId)
            ?.fieldType ?? DatabaseFieldKind.CreatedTime,
        ),
      ),
    },
    steps: {
      move: item.allDay ? 86_400_000 : axis.step,
      start: item.allDay ? 86_400_000 : axis.step,
      end: endpointStep(item),
    },
    move: {
      enabled: canEdit && startEditable && (item.end === null || endEditable),
      reason: readonlyReason,
    },
    resize: {
      enabled: canEdit && item.end !== null && (startEditable || endEditable),
      edges: [
        ...(startEditable ? ["start" as const] : []),
        ...(endEditable ? ["end" as const] : []),
      ],
      reason: readonlyReason,
    },
  }));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const diagnosisByRowId = new Map(
    resolved.diagnostics.map((item) => [item.row.row.id, item.reason]),
  );
  const rowByProjectionId = new Map<string, DatabaseRowRecord>();
  const pinnedRows: GanttListRowView[] = rows.flatMap((row) =>
    (config?.group ? row.groupKeys : ["all"])
      .filter((key) => sectionKeys.has(key))
      .flatMap((key) => {
        const id = JSON.stringify([row.row.id, key]);
        const task = taskById.get(id);
        if (!task && !diagnosisByRowId.has(row.row.id)) return [];
        rowByProjectionId.set(id, row);
        return [
          task ?? {
            id,
            sectionId: key,
            label: row.row.title,
            selected: row.row.id === selectedRowId,
            connectEndpoint: {
              enabled: canConnect,
            },
          },
        ];
      }),
  );
  const dependencyField =
    record.fields.find(
      (field) =>
        field.id === config?.dependencyFieldId &&
        field.fieldType === DatabaseFieldKind.Relation,
    ) ?? null;
  const dependencies: GanttDependencyView[] = [];
  const externalEndpoints: GanttExternalEndpointView[] = [];
  const edgeById = new Map<
    string,
    {
      dependent: DatabaseRowRecord;
      prerequisiteId: string;
      businessId: string;
    }
  >();
  const externalRowById = new Map<string, string>();
  // Untimed diagnostics still own real pinned rows and relation endpoints.
  // A boundary anchor conveys no invented date or schedule geometry.
  for (const row of pinnedRows) {
    if (!taskById.has(row.id))
      externalEndpoints.push({
        id: row.id,
        anchorTaskId: row.id,
        side: "start",
        label: row.label,
        available: true,
        renderLabel: false,
      });
  }
  const projectionsByRow = new Map<string, GanttListRowView[]>();
  for (const projection of pinnedRows) {
    const rowId = rowByProjectionId.get(projection.id)!.row.id;
    const copies = projectionsByRow.get(rowId) ?? [];
    copies.push(projection);
    projectionsByRow.set(rowId, copies);
  }
  if (dependencyField) {
    for (const dependent of pinnedRows) {
      const dependentRow = rowByProjectionId.get(dependent.id)!;
      const cell = getCellValue(dependentRow, dependencyField.id)?.value;
      const targets = new Map(
        (cell?.relationTargets ?? []).map((target) => [target.rowId, target]),
      );
      // Cell order is authoritative. Visual copies never become extra writes.
      for (const prerequisiteId of new Set(cell?.relation ?? [])) {
        const target = targets.get(prerequisiteId);
        const available = Boolean(
          target && !target.deleted && !target.redacted,
        );
        const visible = available
          ? (projectionsByRow.get(prerequisiteId) ?? [])
          : [];
        const businessId = JSON.stringify([
          dependentRow.row.id,
          prerequisiteId,
        ]);
        let anchorIds = visible.map((copy) => copy.id);
        if (!anchorIds.length) {
          const id = JSON.stringify(["external", dependent.id, prerequisiteId]);
          externalEndpoints.push({
            id,
            anchorTaskId: dependent.id,
            side: "start",
            label: available ? (target!.title ?? "") : unavailableLabel,
            available,
          });
          if (available) externalRowById.set(id, prerequisiteId);
          anchorIds = [id];
        }
        for (const anchorId of anchorIds) {
          const id = JSON.stringify([businessId, anchorId, dependent.id]);
          dependencies.push({
            id,
            fromTaskId: anchorId,
            toTaskId: dependent.id,
            kind: "connection",
            edit: {
              enabled:
                canEdit &&
                !dependentRow.redacted &&
                !dependentRow.row.deletedAt,
            },
          });
          edgeById.set(id, {
            dependent: dependentRow,
            prerequisiteId,
            businessId,
          });
        }
      }
    }
  }
  return {
    axis,
    sections,
    tasks,
    pinnedRows,
    rowByProjectionId,
    diagnosisByRowId,
    dependencyField,
    dependencies,
    externalEndpoints,
    edgeById,
    externalRowById,
    startField,
    endField,
    diagnostics: resolved.diagnostics,
    intervalById: new Map(projections.map(({ id, item }) => [id, item])),
  };
}
