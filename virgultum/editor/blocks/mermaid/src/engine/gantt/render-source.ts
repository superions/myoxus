// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMermaidGanttSource } from "./parser.js";
import { formatGanttDateValue, ganttSourceEndMs } from "./schedule.js";
import {
  applyGanttPatches,
  encodeGanttTaskData,
  type GanttPatch,
} from "./writer.js";

export type GanttNativeRenderTask = {
  readonly id: string;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly renderEndTime?: Date | null;
};

/** Native checkTaskDates extends even explicit non-ISO/until ends. Project
 * fixed engine boundaries into native renderer data, not another SVG layout.
 * Duration tasks retain the native working-calendar renderEndTime behaviour. */
export function projectGanttNativeRenderTasks<T extends GanttNativeRenderTask>(
  source: string,
  tasks: readonly T[],
): readonly T[] {
  const model = parseMermaidGanttSource(source);
  if (!model || model.diagnostics.length) return tasks;
  const byId = new Map(model.tasks.map((task) => [task.id, task]));
  return tasks.map((task) => {
    const original = byId.get(task.id);
    if (!original || (!original.end && !original.untilIds.length)) return task;
    const interval = model.intervals[original.recordId];
    if (!interval) return task;
    return {
      ...task,
      startTime: new Date(interval.start),
      endTime: new Date(interval.end),
      renderEndTime: null,
    };
  });
}

/** Compile bound times for native rendering only. Stored source, reference
 * semantics, edit commands and .mmd exports never consume this projection.
 * Mermaid's positional data reader cannot represent an explicit-ID Previous
 * or missing end, and its until lookup may encounter an uncompiled forward
 * reference. The existing engine resolves all three without inventing dates. */
export function projectGanttNativeRenderSource(source: string): string {
  const model = parseMermaidGanttSource(source);
  if (!model || model.diagnostics.length) return source;
  const patches: GanttPatch[] = [];
  for (const task of model.tasks) {
    const boundStart =
      task.scheduleKind === "after" || task.scheduleKind === "previous";
    const boundEnd = task.untilIds.length > 0;
    const interval = model.intervals[task.recordId];
    const statement = model.sourceDocument.statements.find(
      (item) => item.id === task.recordId,
    );
    if (!interval || !statement) return source;
    const projected = {
      ...task,
      scheduleKind: "explicit" as const,
      start: boundStart
        ? formatGanttDateValue(interval.start, model.calendar.dateFormat)
        : task.start,
      afterIds: [],
      untilIds: [],
      end: boundEnd
        ? formatGanttDateValue(
            ganttSourceEndMs(
              interval.end,
              model.calendar.inclusiveEndDates,
              task,
            ),
            model.calendar.dateFormat,
          )
        : task.end,
      // A missing end is a zero-length render, not an authored duration.
      duration: boundEnd ? "" : task.duration || (task.end ? "" : "0ms"),
    };
    const start = statement.range.start + statement.raw.indexOf(":") + 1;
    // The engine retains untouched tag lexemes, including their source
    // position. Native Mermaid requires status/shape tags before the ID.
    patches.push({
      range: { start, end: statement.range.end },
      value: ` ${encodeGanttTaskData(projected)}`,
    });
  }
  return applyGanttPatches(source, patches) ?? source;
}
