// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ganttNoChange,
  ganttPatchedResult,
  encodeGanttTaskLine,
  type GanttCommandResult,
  type GanttPatch,
} from "../writer.js";
import {
  formatGanttDurationMs,
  ganttWorkingDurationMs,
  resolveGanttCalendar,
} from "../schedule.js";
import type { MermaidGanttModel, MermaidGanttTask } from "../types.js";

export type GanttDependencyCommand =
  | {
      readonly type: "dependency.create";
      readonly fromTaskId: string;
      readonly toTaskId: string;
      readonly kind?: "after" | "until";
    }
  | {
      readonly type: "dependency.reconnect";
      /** Owning statement of the reference (the dependent task). */
      readonly taskRecordId: string;
      readonly referenceId: string;
      readonly kind: "after" | "until";
      /** Grabbed endpoint; defaults to the referenced ("source") end. */
      readonly endpoint?: "source" | "target";
      /** Replacement referenced task for the source endpoint. */
      readonly newReferenceId?: string;
      /** Replacement owner statement for the target endpoint. */
      readonly newOwnerRecordId?: string;
    }
  | {
      readonly type: "dependency.delete";
      readonly taskRecordId: string;
      readonly referenceId: string;
      readonly kind: "after" | "until";
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
  return {
    range: { end: statement.range.end, start: statement.range.start },
    value: encodeGanttTaskLine(next, statement.indent),
  };
}

/** A new owner→reference binding cycles only if the reference already depends
 * on the owner. Follow both reference families and implicit previous links,
 * using record identity rather than a potentially duplicated source ID. */
function wouldCycle(
  model: MermaidGanttModel,
  ownerRecordId: string,
  referenceId: string,
) {
  const seen = new Set<string>();
  const referenced = (id: string) => {
    const matches = model.tasks.filter((task) => task.id === id);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const first = referenced(referenceId);
  const stack = first ? [first] : [];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.recordId === ownerRecordId) return true;
    if (seen.has(current.recordId)) continue;
    seen.add(current.recordId);
    const dependencies = [...current.afterIds, ...current.untilIds]
      .map(referenced)
      .filter((task): task is MermaidGanttTask => Boolean(task));
    const previous = model.tasks[current.order - 1];
    if (current.scheduleKind === "previous" && previous)
      dependencies.push(previous);
    stack.push(...dependencies);
  }
  return false;
}

export function applyGanttDependencyCommand(input: {
  readonly model: MermaidGanttModel;
  readonly readonly: boolean;
  readonly command: GanttDependencyCommand;
}): GanttCommandResult {
  const { command, model, readonly } = input;
  if (readonly) return ganttNoChange(model, "readonly");
  switch (command.type) {
    case "dependency.create": {
      const source = findTask(model, command.fromTaskId);
      const target = findTask(model, command.toTaskId);
      if (!source || !target || source.id === target.id)
        return ganttNoChange(model, "unknown-task");
      if (model.tasks.filter((task) => task.id === source.id).length !== 1)
        return ganttNoChange(model, "ambiguous-source");
      const kind = command.kind ?? "after";
      if (wouldCycle(model, target.recordId, source.id))
        return ganttNoChange(model, "cycle");
      const references = kind === "after" ? target.afterIds : target.untilIds;
      if (references.includes(source.id))
        return ganttNoChange(model, "no-change");
      // Converting an explicit end into a dependency must keep the resolved
      // working length instead of silently collapsing the task to one day.
      const derivedDuration = () => {
        if (target.duration) return target.duration;
        // A start-only task remains start-only when its start becomes bound.
        // Connecting a point must not silently invent a one-day duration.
        if (!target.end) return "";
        const interval = model.intervals[target.recordId];
        if (!interval) return null;
        const duration = ganttWorkingDurationMs(
          interval.start,
          interval.end,
          resolveGanttCalendar(model.calendar, () => undefined),
        );
        return duration === null ? null : formatGanttDurationMs(duration);
      };
      const duration = kind === "after" ? derivedDuration() : target.duration;
      if (duration === null) return ganttNoChange(model, "unresolved-schedule");
      const next: MermaidGanttTask =
        kind === "after"
          ? {
              ...target,
              afterIds: [...references, source.id],
              duration,
              end: "",
              scheduleKind: "after",
              start: `after ${[...references, source.id].join(" ")}`,
            }
          : {
              ...target,
              scheduleKind:
                target.scheduleKind === "none" ? "until" : target.scheduleKind,
              untilIds: [...references, source.id],
            };
      const patch = patchTask(model, target, next);
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], {
        id: target.recordId,
        kind: "task",
      });
    }
    case "dependency.reconnect": {
      const endpoint = command.endpoint ?? "source";
      if (endpoint === "target") {
        // Move the dependent (owner) end: remove the reference from the old
        // owning statement and add it to the new one, atomically.
        const newOwnerRecordId = command.newOwnerRecordId;
        if (!newOwnerRecordId || newOwnerRecordId === command.taskRecordId)
          return ganttNoChange(model, "no-change");
        const oldOwner = findTask(model, command.taskRecordId);
        const newOwner = findTask(model, newOwnerRecordId);
        if (!oldOwner || !newOwner) return ganttNoChange(model, "unknown-task");
        const listKey = command.kind === "after" ? "afterIds" : "untilIds";
        const oldRefs = oldOwner[listKey];
        if (!oldRefs.includes(command.referenceId))
          return ganttNoChange(model, "unknown-reference");
        if (
          model.tasks.filter((task) => task.id === command.referenceId)
            .length !== 1
        )
          return ganttNoChange(model, "ambiguous-source");
        if (newOwner.id === command.referenceId)
          return ganttNoChange(model, "cycle");
        if (newOwner[listKey].includes(command.referenceId))
          return ganttNoChange(model, "duplicate-reference");
        if (wouldCycle(model, newOwner.recordId, command.referenceId))
          return ganttNoChange(model, "cycle");
        const nextRefs = oldRefs.filter((id) => id !== command.referenceId);
        const oldNext: MermaidGanttTask =
          command.kind === "after"
            ? {
                ...oldOwner,
                afterIds: nextRefs,
                scheduleKind: nextRefs.length ? "after" : "previous",
                start: nextRefs.length ? `after ${nextRefs.join(" ")}` : "",
              }
            : { ...oldOwner, untilIds: nextRefs };
        const addedRefs = [...newOwner[listKey], command.referenceId];
        const newNext: MermaidGanttTask =
          command.kind === "after"
            ? {
                ...newOwner,
                afterIds: addedRefs,
                scheduleKind: "after",
                start: `after ${addedRefs.join(" ")}`,
              }
            : {
                ...newOwner,
                scheduleKind:
                  newOwner.scheduleKind === "none"
                    ? "until"
                    : newOwner.scheduleKind,
                untilIds: addedRefs,
              };
        const oldPatch = patchTask(model, oldOwner, oldNext);
        const newPatch = patchTask(model, newOwner, newNext);
        if (!oldPatch || !newPatch) return ganttNoChange(model, "conflict");
        return ganttPatchedResult(model, [oldPatch, newPatch], {
          id: newOwner.recordId,
          kind: "task",
        });
      }
      const task = findTask(model, command.taskRecordId);
      if (!task) return ganttNoChange(model, "unknown-task");
      const newReferenceId = command.newReferenceId;
      if (!newReferenceId) return ganttNoChange(model, "unknown-reference");
      const references =
        command.kind === "after" ? task.afterIds : task.untilIds;
      if (!references.includes(command.referenceId))
        return ganttNoChange(model, "unknown-reference");
      if (newReferenceId === command.referenceId)
        return ganttNoChange(model, "no-change");
      const candidates = model.tasks.filter(
        (task) => task.id === newReferenceId,
      );
      if (!candidates.length) return ganttNoChange(model, "unknown-reference");
      if (candidates.length !== 1)
        return ganttNoChange(model, "ambiguous-source");
      // Re-pointing at the owner itself or at an already referenced id would
      // duplicate or self-reference the edge; both are refused before writing.
      if (newReferenceId === task.id) return ganttNoChange(model, "cycle");
      if (references.includes(newReferenceId))
        return ganttNoChange(model, "duplicate-reference");
      if (wouldCycle(model, task.recordId, newReferenceId))
        return ganttNoChange(model, "cycle");
      const nextReferences = references.map((id) =>
        id === command.referenceId ? newReferenceId : id,
      );
      const next: MermaidGanttTask =
        command.kind === "after"
          ? {
              ...task,
              afterIds: nextReferences,
              start: `after ${nextReferences.join(" ")}`,
            }
          : { ...task, untilIds: nextReferences };
      const patch = patchTask(model, task, next);
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], {
        id: task.recordId,
        kind: "task",
      });
    }
    case "dependency.delete": {
      const task = findTask(model, command.taskRecordId);
      if (!task) return ganttNoChange(model, "unknown-task");
      const references =
        command.kind === "after" ? task.afterIds : task.untilIds;
      if (!references.includes(command.referenceId))
        return ganttNoChange(model, "unknown-reference");
      const nextReferences = references.filter(
        (id) => id !== command.referenceId,
      );
      const next: MermaidGanttTask =
        command.kind === "after"
          ? {
              ...task,
              afterIds: nextReferences,
              scheduleKind: nextReferences.length ? "after" : "previous",
              start: nextReferences.length
                ? `after ${nextReferences.join(" ")}`
                : "",
            }
          : { ...task, untilIds: nextReferences };
      const patch = patchTask(model, task, next);
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], {
        id: task.recordId,
        kind: "task",
      });
    }
  }
}
