// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ganttNoChange,
  ganttPatchedResult,
  encodeGanttTaskLine,
  type GanttCommandResult,
  type GanttPatch,
} from "../writer.js";
import {
  formatGanttDateValue,
  formatGanttDurationMs,
  resolveGanttCalendar,
  ganttWorkingDurationMs,
  ganttSourceEndMs,
} from "../schedule.js";
import type {
  GanttSelection,
  MermaidGanttModel,
  MermaidGanttTask,
} from "../types.js";

export type GanttScheduleCommand =
  | {
      readonly type: "schedule.set";
      readonly taskId: string;
      readonly start: string;
      readonly end: string;
      readonly duration: string;
      readonly afterIds: readonly string[];
      readonly untilIds: readonly string[];
      readonly mode:
        "explicit-range" | "explicit-duration" | "previous" | "after" | "until";
    }
  | {
      readonly type: "task.move";
      readonly taskId: string;
      readonly deltaMs: number;
    }
  | {
      readonly type: "task.resize";
      readonly taskId: string;
      readonly edge: "start" | "end";
      readonly valueMs: number;
    };

function findTask(model: MermaidGanttModel, recordId: string) {
  return model.tasks.find((task) => task.recordId === recordId) ?? null;
}

function patchTask(
  model: MermaidGanttModel,
  task: MermaidGanttTask,
  next: MermaidGanttTask,
): GanttPatch | null {
  const statement = model.sourceDocument.statements.find(
    (candidate) => candidate.id === task.recordId,
  );
  if (!statement) return null;
  const value = encodeGanttTaskLine(next, statement.indent);
  const dataStart = value.indexOf(":") + 1;
  let nextData = value.slice(dataStart);
  // A free-boundary/length edit does not own unchanged reference clauses.
  // Keep their authored spacing rather than normalizing them through encoding.
  const data = statement.raw.slice(statement.raw.indexOf(":") + 1);
  for (const kind of ["after", "until"] as const) {
    const beforeIds = kind === "after" ? task.afterIds : task.untilIds;
    const afterIds = kind === "after" ? next.afterIds : next.untilIds;
    if (JSON.stringify(beforeIds) !== JSON.stringify(afterIds)) continue;
    const original = data
      .split(",")
      .find((token) => token.trim().startsWith(`${kind} `));
    if (!original) continue;
    nextData = nextData.replace(
      new RegExp(`(^|,)\\s*${kind} [^,]+`),
      (_match, comma: string) => `${comma}${original}`,
    );
  }
  return {
    range: { end: statement.range.end, start: statement.range.start },
    value: value.slice(0, dataStart) + nextData,
  };
}

function selectionOf(task: MermaidGanttTask): GanttSelection {
  return { id: task.recordId, kind: "task" };
}

/** A valid reparse must also represent the exact requested boundary. */
function checkedBoundaryResult(
  model: MermaidGanttModel,
  result: GanttCommandResult,
  task: MermaidGanttTask,
  start: number,
  end?: number,
) {
  // Rounding can produce identical source. It is still an unrepresentable
  // request and must report the local boundary error instead of a silent no-op.
  if (!result.changed && result.diagnosis !== "no-change") return result;
  const interval = result.model.intervals[task.recordId];
  return interval?.start === start &&
    (end === undefined || interval.end === end)
    ? result
    : ganttNoChange(model, "invalid-date");
}

/**
 * A start is bound when the source expresses it through a reference
 * (`after`/implicit previous); an end is bound by an `until` reference.
 * Moving or resizing across such a boundary must be an explicit conversion in
 * the schedule popover, never a silent rewrite of the source reference.
 */
function startIsBound(task: MermaidGanttTask) {
  return task.scheduleKind === "after" || task.scheduleKind === "previous";
}

function endIsBound(task: MermaidGanttTask) {
  return task.untilIds.length > 0;
}

/** True when the statement only carries a start and has no length at all. */
function isPointInTime(task: MermaidGanttTask) {
  return !task.end && !task.duration;
}

export function applyGanttScheduleCommand(input: {
  readonly model: MermaidGanttModel;
  readonly readonly: boolean;
  readonly command: GanttScheduleCommand;
}): GanttCommandResult {
  const { command, model, readonly } = input;
  if (readonly) return ganttNoChange(model, "readonly");
  const dateFormat = model.calendar.dateFormat;
  const calendar = resolveGanttCalendar(model.calendar, () => undefined);
  switch (command.type) {
    case "schedule.set": {
      const task = findTask(model, command.taskId);
      if (!task) return ganttNoChange(model, "unknown-task");
      // `after` and `until` are independent fields. A mode that owns only one
      // boundary carries the other unchanged: the command's list is the
      // authority for both, so an `until` edit keeps its `after` start and an
      // `after` edit keeps its `until` end. Only an end-owning mode clears it.
      const afterIds = [...command.afterIds];
      const untilIds = [...command.untilIds];
      for (const [nextIds, previousIds] of [
        [afterIds, task.afterIds],
        [untilIds, task.untilIds],
      ] as const) {
        for (const id of nextIds) {
          if (previousIds.includes(id)) continue;
          const matches = model.tasks.filter(
            (candidate) => candidate.id === id,
          );
          if (!matches.length) return ganttNoChange(model, "unknown-reference");
          if (matches.length !== 1)
            return ganttNoChange(model, "ambiguous-source");
        }
      }
      const endViaUntil = untilIds.length > 0;
      // A start expressed through `after` (also when combined with `until`)
      // keeps the `after` schedule kind so the writer emits the start clause.
      const scheduleKind: MermaidGanttTask["scheduleKind"] =
        command.mode === "explicit-duration" ||
        command.mode === "explicit-range"
          ? "explicit"
          : afterIds.length > 0
            ? "after"
            : command.mode;
      const next: MermaidGanttTask = {
        ...task,
        afterIds,
        // An until-bound end has no free duration; every other mode keeps the
        // working length so the runtime does not reparse a zero-length bar.
        duration:
          command.mode === "explicit-range" || endViaUntil
            ? ""
            : command.duration.trim(),
        end:
          command.mode === "explicit-range" && !endViaUntil
            ? command.end.trim()
            : "",
        scheduleKind,
        start:
          scheduleKind === "after"
            ? `after ${afterIds.join(" ")}`
            : command.mode === "previous"
              ? ""
              : command.start.trim(),
        untilIds,
      };
      const patch = patchTask(model, task, next);
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], selectionOf(task));
    }
    case "task.move": {
      const task = findTask(model, command.taskId);
      if (!task) return ganttNoChange(model, "unknown-task");
      if (command.deltaMs === 0) return ganttNoChange(model, "no-change");
      const interval = model.intervals[task.recordId];
      if (!interval) return ganttNoChange(model, "unresolved-schedule");
      if (startIsBound(task)) return ganttNoChange(model, "bound-start");
      if (endIsBound(task)) return ganttNoChange(model, "bound-end");
      const startMs = interval.start + command.deltaMs;
      // Epoch zero is not a minimum date: valid pre-1970 source dates must
      // remain movable. Reject nonrepresentable instants, not negative ones.
      if (
        !Number.isFinite(startMs) ||
        Number.isNaN(new Date(startMs).getTime())
      )
        return ganttNoChange(model, "invalid-date");
      // The delta is a millisecond span; the technical snap grid is the axis
      // contract, not a hidden day rounding inside the command.
      let next: MermaidGanttTask = {
        ...task,
        start: formatGanttDateValue(startMs, dateFormat, task.start),
      };
      if (task.end) {
        const endMs = interval.end + command.deltaMs;
        if (!Number.isFinite(endMs) || Number.isNaN(new Date(endMs).getTime()))
          return ganttNoChange(model, "invalid-date");
        if (endMs < startMs) return ganttNoChange(model, "invalid-schedule");
        next = {
          ...next,
          end: formatGanttDateValue(
            ganttSourceEndMs(endMs, model.calendar.inclusiveEndDates, task),
            dateFormat,
            task.end,
            "end",
          ),
        };
      }
      const patch = patchTask(model, task, next);
      if (!patch) return ganttNoChange(model, "conflict");
      return checkedBoundaryResult(
        model,
        ganttPatchedResult(model, [patch], selectionOf(task)),
        task,
        startMs,
        task.end ? interval.end + command.deltaMs : undefined,
      );
    }
    case "task.resize": {
      const task = findTask(model, command.taskId);
      if (!task) return ganttNoChange(model, "unknown-task");
      const interval = model.intervals[task.recordId];
      if (!interval) return ganttNoChange(model, "unresolved-schedule");
      if (
        !Number.isFinite(command.valueMs) ||
        Number.isNaN(new Date(command.valueMs).getTime())
      )
        return ganttNoChange(model, "invalid-date");
      if (command.edge === "start") {
        if (startIsBound(task)) return ganttNoChange(model, "bound-start");
        const endMs = interval.end;
        if (command.valueMs > endMs && !isPointInTime(task))
          return ganttNoChange(model, "invalid-schedule");
        // Date+duration keeps the untouched end boundary and recomputes the
        // working length instead of dropping the duration for an empty end.
        if (task.duration) {
          const durationMs = ganttWorkingDurationMs(
            command.valueMs,
            endMs,
            calendar,
          );
          if (durationMs === null)
            return ganttNoChange(model, "invalid-schedule");
          const duration = formatGanttDurationMs(durationMs);
          if (!duration) return ganttNoChange(model, "invalid-duration");
          const next: MermaidGanttTask = {
            ...task,
            duration,
            start: formatGanttDateValue(
              command.valueMs,
              dateFormat,
              task.start,
            ),
          };
          const patch = patchTask(model, task, next);
          if (!patch) return ganttNoChange(model, "conflict");
          return checkedBoundaryResult(
            model,
            ganttPatchedResult(model, [patch], selectionOf(task)),
            task,
            command.valueMs,
            isPointInTime(task) ? command.valueMs : interval.end,
          );
        }
        // Explicit end or point-in-time keeps its end, only the start moves.
        const next: MermaidGanttTask = {
          ...task,
          start: formatGanttDateValue(command.valueMs, dateFormat, task.start),
        };
        const patch = patchTask(model, task, next);
        if (!patch) return ganttNoChange(model, "conflict");
        return checkedBoundaryResult(
          model,
          ganttPatchedResult(model, [patch], selectionOf(task)),
          task,
          command.valueMs,
          isPointInTime(task) ? command.valueMs : interval.end,
        );
      }
      if (endIsBound(task)) return ganttNoChange(model, "bound-end");
      const startMs = interval.start;
      if (command.valueMs < startMs)
        return ganttNoChange(model, "invalid-schedule");
      // A bound start stays a reference; only the free end boundary changes.
      if (task.duration || isPointInTime(task)) {
        const durationMs = ganttWorkingDurationMs(
          startMs,
          command.valueMs,
          calendar,
        );
        if (durationMs === null)
          return ganttNoChange(model, "invalid-schedule");
        const duration = formatGanttDurationMs(durationMs);
        if (!duration) return ganttNoChange(model, "invalid-duration");
        const next: MermaidGanttTask = {
          ...task,
          duration,
          end: "",
        };
        const patch = patchTask(model, task, next);
        if (!patch) return ganttNoChange(model, "conflict");
        return checkedBoundaryResult(
          model,
          ganttPatchedResult(model, [patch], selectionOf(task)),
          task,
          interval.start,
          command.valueMs,
        );
      }
      const next: MermaidGanttTask = {
        ...task,
        end: formatGanttDateValue(
          ganttSourceEndMs(
            command.valueMs,
            model.calendar.inclusiveEndDates,
            task,
          ),
          dateFormat,
          task.end,
          "end",
        ),
      };
      const patch = patchTask(model, task, next);
      if (!patch) return ganttNoChange(model, "conflict");
      return checkedBoundaryResult(
        model,
        ganttPatchedResult(model, [patch], selectionOf(task)),
        task,
        interval.start,
        command.valueMs,
      );
    }
  }
}
