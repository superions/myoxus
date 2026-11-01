// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ganttExcludedBands,
  GANTT_DAY_MS,
  ganttDiagnosticText,
  inspectGanttDateFormat,
  mermaidMessages as messages,
  resolveGanttCalendar,
  type MermaidGanttModel,
} from "@virgultum/block-mermaid";
import {
  ganttAxisTicks,
  type GanttCapability,
  type GanttDependencyView,
  type GanttExcludedBand,
  type GanttMarkerView,
  type GanttSectionView,
  type GanttTaskView,
} from "@myoxus/ui-facade";

export type GanttDependencyAnchor = {
  readonly kind: "after" | "until";
  readonly referenceId: string;
  readonly taskRecordId: string;
};

export type GanttViewProjection = {
  axis: {
    start: number;
    end: number;
    step: number;
    ticks: ReadonlyArray<{ label: string; value: number }>;
    valueLabel: (value: number) => string;
  };
  dependencies: readonly GanttDependencyView[];
  dependencyById: ReadonlyMap<string, GanttDependencyAnchor>;
  excludedBands: readonly GanttExcludedBand[];
  markers: readonly GanttMarkerView[];
  sections: readonly GanttSectionView[];
  tasks: readonly GanttTaskView[];
};

const DAY = GANTT_DAY_MS;
const EMPTY_RANGE = { end: 0, start: 0 };

function formatWithDateStyle(value: number, locale: string, withTime: boolean) {
  return new Intl.DateTimeFormat(
    locale,
    withTime
      ? { dateStyle: "medium", timeStyle: "short" }
      : { dateStyle: "medium" },
  ).format(new Date(value));
}

/**
 * Maps the engine's source-backed model onto the neutral Gantt surface and
 * back onto typed intents. No parsing, schedule maths or writer access here.
 */
export function projectGanttView(
  model: MermaidGanttModel,
  locale: string,
  workareaWidth: number,
  zoomOverride?: "day" | "week" | "month" | "quarter" | "year" | null,
): GanttViewProjection {
  const values = Object.values(model.intervals);
  const range = values.length
    ? {
        end: Math.max(...values.map((interval) => interval.end)) + DAY,
        start: Math.min(...values.map((interval) => interval.start)),
      }
    : EMPTY_RANGE;
  const withTime = inspectGanttDateFormat(model.calendar.dateFormat).hasTime;
  const { ticks } = ganttAxisTicks(
    range,
    (value) => formatWithDateStyle(value, locale, withTime),
    workareaWidth,
    110,
    zoomOverride,
  );
  const recordById = new Map(
    model.tasks.map((task) => [task.id, task.recordId]),
  );
  const dependencies: GanttDependencyView[] = [];
  const dependencyById = new Map<string, GanttDependencyAnchor>();
  for (const task of model.tasks) {
    // Locally invalid schedules remain visible as disabled rows. Only resolved
    // endpoints may enter the numeric SVG geometry projection.
    if (!model.intervals[task.recordId]) continue;
    for (const reference of task.afterIds) {
      const from = recordById.get(reference);
      if (!from || !model.intervals[from]) continue;
      const id = `${task.recordId}:after:${reference}`;
      dependencyById.set(id, {
        kind: "after",
        referenceId: reference,
        taskRecordId: task.recordId,
      });
      dependencies.push({
        fromTaskId: from,
        id,
        kind: "after",
        toTaskId: task.recordId,
      });
    }
    for (const reference of task.untilIds) {
      const to = recordById.get(reference);
      if (!to || !model.intervals[to]) continue;
      const id = `${task.recordId}:until:${reference}`;
      dependencyById.set(id, {
        kind: "until",
        referenceId: reference,
        taskRecordId: task.recordId,
      });
      dependencies.push({
        fromTaskId: to,
        id,
        kind: "until",
        toTaskId: task.recordId,
      });
    }
    if (task.scheduleKind === "previous") {
      const previous = model.tasks[task.order - 1];
      if (previous && model.intervals[previous.recordId]) {
        dependencies.push({
          fromTaskId: previous.recordId,
          id: `${task.recordId}:previous`,
          implicit: true,
          kind: "previous",
          toTaskId: task.recordId,
        });
      }
    }
  }
  const calendar = resolveGanttCalendar(model.calendar, () => undefined);
  const capability = (enabled: boolean, reason?: string): GanttCapability => ({
    enabled,
    reason,
  });
  const readonlyBlocked = capability(false, messages.ganttReadOnly());
  return {
    axis: {
      end: range.end,
      start: range.start,
      // Tick density may coarsen for readability; gesture precision must not.
      step: withTime ? DAY / 24 : DAY,
      ticks,
      valueLabel: (value) => formatWithDateStyle(value, locale, withTime),
    },
    dependencies,
    dependencyById,
    excludedBands: ganttExcludedBands(range, calendar).map((band, index) => ({
      ...band,
      id: `excluded-${index}`,
    })),
    markers: model.tasks
      .filter((task) => task.isVert)
      .map((task) => {
        // `vert` is a real object. A reference-bound marker stays draggable so
        // its drag can open the anchored conversion popover, exactly like a bar.
        const interval = model.intervals[task.recordId];
        return {
          description: task.diagnostics.length
            ? ganttDiagnosticText(task.diagnostics[0])
            : undefined,
          id: task.recordId,
          label: task.label,
          end: interval?.end ?? range.start,
          move: interval ? capability(true) : readonlyBlocked,
          value: interval?.start ?? range.start,
        };
      }),
    sections: model.sections.map((section) => ({
      id: section.id,
      label: section.title,
      order: section.order,
    })),
    // A `vert` statement is a marker across the rows, not a zero-length bar.
    tasks: model.tasks
      .filter((task) => !task.isVert)
      .map((task) => {
        const interval = model.intervals[task.recordId];
        return {
          connect: task.explicitId ? capability(true) : readonlyBlocked,
          description: task.diagnostics.length
            ? ganttDiagnosticText(task.diagnostics[0])
            : undefined,
          end: interval?.end ?? range.start,
          id: task.recordId,
          label: task.label,
          milestone: task.isMilestone,
          // A reference-bound start stays draggable: the drag opens the
          // anchored conversion popover, and the engine refuses a silent move.
          // `move.enabled` is only false when no schedule could be resolved.
          move: interval ? capability(true) : readonlyBlocked,
          resize: {
            edges:
              task.scheduleKind === "explicit"
                ? (["start", "end"] as const)
                : (["end"] as const),
            ...capability(
              Boolean(interval) &&
                (task.scheduleKind === "explicit" ||
                  Boolean(task.duration) ||
                  Boolean(task.end)),
            ),
          },
          sectionId: task.sectionId,
          selected: false,
          // The Facade positions the diamond at the midpoint, but move intents
          // retain both authored boundaries rather than moving a collapsed point.
          start: interval?.start ?? range.start,
          statuses: task.statuses,
        } satisfies GanttTaskView;
      }),
  };
}
