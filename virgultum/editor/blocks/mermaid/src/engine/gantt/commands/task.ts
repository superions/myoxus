// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ganttAnchorAfter,
  ganttDeleteStatement,
  ganttInsertAfter,
  ganttMovePatches,
  ganttNoChange,
  ganttPatchedResult,
  ganttStatementSpan,
  encodeGanttTaskLine,
  type GanttCommandResult,
  type GanttPatch,
} from "../writer.js";
import {
  formatGanttDateValue,
  formatGanttDurationMs,
  ganttSourceEndMs,
  ganttWorkingDurationMs,
  resolveGanttCalendar,
} from "../schedule.js";
import {
  GANTT_STATUS_TOKENS,
  GANTT_SHAPE_TOKENS,
  isMermaidGanttTaskLabel,
  type GanttSelection,
  type MermaidGanttModel,
  type MermaidGanttTask,
} from "../types.js";

export type GanttTaskCommand =
  | {
      readonly type: "task.add";
      readonly sectionId: string;
      readonly start: string;
      readonly label: string;
      readonly milestone?: boolean;
    }
  | {
      readonly type: "task.rename";
      readonly taskId: string;
      readonly label: string;
    }
  | {
      readonly type: "task.reorder";
      readonly taskId: string;
      readonly targetSectionId: string;
      readonly targetOrder: number;
    }
  | {
      readonly type: "task.delete";
      readonly taskId: string;
      readonly strategy: "remove-dependencies" | "materialize-dates";
    }
  | {
      readonly type: "task.set-statuses";
      readonly taskId: string;
      readonly statuses: readonly string[];
    }
  | {
      readonly type: "task.set-shape";
      readonly taskId: string;
      readonly milestone: boolean;
      readonly vert: boolean;
    }
  | {
      readonly type: "task.rename-id";
      readonly taskId: string;
      readonly newId: string;
    };

export type GanttTaskDeleteImpact = {
  readonly dependents: readonly {
    readonly taskId: string;
    readonly label: string;
    readonly references: readonly string[];
  }[];
  readonly commentIds: readonly string[];
  readonly clickIds: readonly string[];
};

/** Record-owned comments and previous-task links never use the source ID as
 * object identity; source IDs are only names in explicit references/clicks. */
export function ganttTaskDeleteImpact(
  model: MermaidGanttModel,
  recordId: string,
): GanttTaskDeleteImpact {
  const owner = findTask(model, recordId);
  if (!owner) return { dependents: [], commentIds: [], clickIds: [] };
  const taskId = owner.id;
  const dependents = model.tasks
    .filter(
      (task, index) =>
        task.recordId !== recordId &&
        (task.afterIds.includes(taskId) ||
          task.untilIds.includes(taskId) ||
          (task.scheduleKind === "previous" &&
            model.tasks[index - 1]?.recordId === recordId)),
    )
    .map((task) => ({
      label: task.label,
      references: [
        ...task.afterIds.filter((id) => id === taskId),
        ...task.untilIds.filter((id) => id === taskId),
      ],
      taskId: task.recordId,
    }));
  return {
    clickIds: model.clicks
      .filter((click) => click.targetTaskId === taskId)
      .map((click) => click.id),
    commentIds: model.comments
      .filter((comment) => {
        const anchor = comment.anchor;
        return anchor.kind === "task" && anchor.id === recordId;
      })
      .map((comment) => comment.id),
    dependents,
  };
}

function findTask(model: MermaidGanttModel, recordId: string) {
  return model.tasks.find((task) => task.recordId === recordId) ?? null;
}

function patchLabel(task: MermaidGanttTask, label: string): GanttPatch {
  return { range: task.labelRange, value: label };
}

/** Rename against one source snapshot: materializing an automatic ID changes
 * the later automatic names, so sequential reparsing would retarget references. */
export function ganttRenameTaskIdsPatches(
  model: MermaidGanttModel,
  replacements: ReadonlyMap<string, string>,
): readonly GanttPatch[] | null {
  const names = new Map(replacements);
  if (
    model.tasks.some((task) => !task.explicitId && names.has(task.recordId))
  ) {
    const referenced = new Set([
      ...model.tasks.flatMap((task) => [...task.afterIds, ...task.untilIds]),
      ...model.clicks.flatMap((click) =>
        click.targetTaskId ? [click.targetTaskId] : [],
      ),
    ]);
    const reserved = new Set([
      ...model.tasks.map((task) => task.id),
      ...names.values(),
    ]);
    for (const task of model.tasks) {
      if (
        task.explicitId ||
        names.has(task.recordId) ||
        !referenced.has(task.id)
      )
        continue;
      let id = `${task.id}-ref`;
      let suffix = 1;
      while (reserved.has(id)) id = `${task.id}-ref${++suffix}`;
      reserved.add(id);
      names.set(task.recordId, id);
    }
  }
  const references = new Map(
    model.tasks.flatMap((task) => {
      const name = names.get(task.recordId);
      return name ? [[task.id, name] as const] : [];
    }),
  );
  // A shared source spelling cannot identify which record a reference owns.
  // Unreferenced duplicate IDs can still be repaired without retargeting data.
  if (
    [...references.keys()].some(
      (id) =>
        model.tasks.filter((task) => task.id === id).length > 1 &&
        (model.tasks.some(
          (task) => task.afterIds.includes(id) || task.untilIds.includes(id),
        ) ||
          model.clicks.some((click) => click.targetTaskId === id)),
    )
  )
    return null;
  const patches: GanttPatch[] = [];
  for (const task of model.tasks) {
    const statement = model.sourceDocument.statements.find(
      (item) => item.id === task.recordId,
    );
    if (!statement) return null;
    const name = names.get(task.recordId);
    const dataStart = statement.raw.indexOf(":") + 1;
    // Mermaid consumes leading status/shape tags before reading an ID.
    const idStart =
      dataStart +
      (statement.raw
        .slice(dataStart)
        .match(/^(?:\s*(?:active|done|crit|milestone|vert)\s*,)*/)?.[0]
        .length ?? 0);
    if (name)
      patches.push(
        task.idRange
          ? { range: task.idRange, value: name }
          : {
              range: {
                start: statement.range.start + idStart,
                end: statement.range.start + idStart,
              },
              value: ` ${name},`,
            },
      );
    // Only reference-list tokens are IDs; label words, URLs and callback
    // arguments remain untouched even when they contain the same spelling.
    for (const match of statement.raw
      .slice(dataStart)
      .matchAll(/\b(after|until)(\s+)([^,]+)/g)) {
      const before = match[3];
      const after = before
        .split(/(\s+)/)
        .map((id) => references.get(id) ?? id)
        .join("");
      if (after === before) continue;
      const start =
        statement.range.start +
        dataStart +
        match.index +
        match[1].length +
        match[2].length;
      patches.push({
        range: { start, end: start + before.length },
        value: after,
      });
    }
  }
  for (const click of model.clicks) {
    const name = click.targetTaskId
      ? references.get(click.targetTaskId)
      : undefined;
    if (!name) continue;
    const statement = model.sourceDocument.statements.find(
      (item) => item.id === click.recordId,
    );
    const target = statement
      ? /^(\s*(?:click|href)\s+)(\S+)/.exec(statement.raw)
      : null;
    if (!statement || !target) return null;
    const start = statement.range.start + target[1].length;
    patches.push({
      range: { start, end: start + target[2].length },
      value: name,
    });
  }
  return patches;
}

function rebuildTaskLine(
  model: MermaidGanttModel,
  task: MermaidGanttTask,
  mutate: (task: MermaidGanttTask) => MermaidGanttTask,
): GanttPatch | null {
  const statement = model.sourceDocument.statements.find(
    (candidate) => candidate.id === task.recordId,
  );
  if (!statement) return null;
  return {
    range: { end: statement.range.end, start: statement.range.start },
    value: encodeGanttTaskLine(mutate(task), statement.indent),
  };
}

/** Replace only the selected native tag field. Authored IDs, boundary clauses,
 * duration lexemes and other tags retain their original data tokens. */
function patchTaskTags(
  model: MermaidGanttModel,
  task: MermaidGanttTask,
  owned: readonly string[],
  values: readonly string[],
): GanttPatch | null {
  const statement = model.sourceDocument.statements.find(
    (item) => item.id === task.recordId,
  );
  if (!statement) return null;
  const dataStart = statement.raw.indexOf(":") + 1;
  if (!dataStart) return null;
  const tokens = statement.raw.slice(dataStart).split(",");
  const retained = tokens.filter((token) => !owned.includes(token.trim()));
  const prefix = /^\s*/.exec(tokens[0] ?? "")?.[0] ?? " ";
  return {
    range: {
      start: statement.range.start + dataStart,
      end: statement.range.end,
    },
    value: [...values.map((value) => `${prefix}${value}`), ...retained].join(
      ",",
    ),
  };
}

export function applyGanttTaskCommand(input: {
  readonly model: MermaidGanttModel;
  readonly readonly: boolean;
  readonly command: GanttTaskCommand;
  /** Section deletion plans all removed records against one source snapshot. */
  readonly deleteRecordIds?: readonly string[];
}): GanttCommandResult {
  const { command, model, readonly } = input;
  if (readonly) return ganttNoChange(model, "readonly");
  switch (command.type) {
    case "task.add": {
      const section = model.sections.find((s) => s.id === command.sectionId);
      if (!section || !isMermaidGanttTaskLabel(command.label))
        return ganttNoChange(model, "invalid-label");
      const anchor =
        (model.tasks.filter((task) => task.sectionId === section.id).at(-1)
          ?.recordId ??
          section.recordId) ||
        null;
      const data = command.milestone
        ? `${command.label.trim()} : milestone, ${command.start}, 0d`
        : `${command.label.trim()} : ${command.start}, 1d`;
      const patch = ganttInsertAfter(model, anchor || null, data);
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], null);
    }
    case "task.rename": {
      const task = findTask(model, command.taskId);
      if (!task || !isMermaidGanttTaskLabel(command.label))
        return ganttNoChange(model, "invalid-label");
      const selection: GanttSelection = { id: task.recordId, kind: "task" };
      return ganttPatchedResult(
        model,
        [patchLabel(task, command.label.trim())],
        selection,
      );
    }
    case "task.reorder": {
      const task = findTask(model, command.taskId);
      if (!task) return ganttNoChange(model, "unknown-task");
      const span = ganttStatementSpan(model, [
        task.recordId,
        ...model.comments
          .filter(
            (comment) =>
              comment.anchor.kind === "task" &&
              comment.anchor.id === task.recordId,
          )
          .map((comment) => comment.recordId),
      ]);
      if (!span) return ganttNoChange(model, "conflict");
      const siblings = model.tasks
        .filter(
          (candidate) =>
            candidate.sectionId === command.targetSectionId &&
            candidate.recordId !== task.recordId,
        )
        .sort((a, b) => a.order - b.order);
      const index = Math.max(0, Math.min(siblings.length, command.targetOrder));
      const currentIndex = model.tasks
        .filter((candidate) => candidate.sectionId === task.sectionId)
        .findIndex((candidate) => candidate.recordId === task.recordId);
      if (command.targetSectionId === task.sectionId && index === currentIndex)
        return ganttNoChange(model, "no-change");
      const anchorRecord =
        index === 0
          ? (model.sections.find((s) => s.id === command.targetSectionId)
              ?.recordId ?? null)
          : (siblings[index - 1]?.recordId ?? null);
      const anchor = ganttAnchorAfter(model, anchorRecord);
      if (anchor === null) return ganttNoChange(model, "conflict");
      const patches = ganttMovePatches(model, span, anchor);
      if (!patches) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, patches, {
        id: task.recordId,
        kind: "task",
      });
    }
    case "task.delete": {
      const task = findTask(model, command.taskId);
      if (!task) return ganttNoChange(model, "unknown-task");
      const removed = model.tasks.filter((item) =>
        (input.deleteRecordIds ?? [task.recordId]).includes(item.recordId),
      );
      const removedIds = new Set(removed.map((item) => item.id));
      const removedRecords = new Set(removed.map((item) => item.recordId));
      // Never interpret an ambiguous reference as belonging to the removed
      // record while another record with that source ID survives.
      if (
        model.tasks.some(
          (item) =>
            !removedRecords.has(item.recordId) &&
            removedIds.has(item.id) &&
            (model.tasks.some(
              (candidate) =>
                candidate.afterIds.includes(item.id) ||
                candidate.untilIds.includes(item.id),
            ) ||
              model.clicks.some((click) => click.targetTaskId === item.id)),
        )
      )
        return ganttNoChange(model, "ambiguous-source");
      const impacts = removed.map((item) =>
        ganttTaskDeleteImpact(model, item.recordId),
      );
      const dependentRecords = new Set(
        impacts.flatMap((impact) =>
          impact.dependents.map((item) => item.taskId),
        ),
      );
      const patches: GanttPatch[] = [];
      const resolved = command.strategy === "materialize-dates";
      for (const dependentTask of model.tasks) {
        if (
          removedRecords.has(dependentTask.recordId) ||
          !dependentRecords.has(dependentTask.recordId)
        )
          continue;
        const nextAfter = dependentTask.afterIds.filter(
          (id) => !removedIds.has(id),
        );
        const nextUntil = dependentTask.untilIds.filter(
          (id) => !removedIds.has(id),
        );
        const interval = model.intervals[dependentTask.recordId];
        // Materialize the shown schedule through the format-aware command
        // owner, so a DD.MM.YYYY diagram keeps its source form.
        const format = model.calendar.dateFormat;
        const iso = (value: number) => formatGanttDateValue(value, format);
        let mutated: MermaidGanttTask;
        if (resolved) {
          if (!interval) return ganttNoChange(model, "unresolved-schedule");
          // Materialize only a boundary that loses its last reference. The
          // independent reference family remains authoritative, not a date.
          const startLost =
            (dependentTask.afterIds.some((id) => removedIds.has(id)) &&
              !nextAfter.length) ||
            (dependentTask.scheduleKind === "previous" &&
              removedRecords.has(
                model.tasks[model.tasks.indexOf(dependentTask) - 1]?.recordId ??
                  "",
              ));
          const endLost =
            dependentTask.untilIds.some((id) => removedIds.has(id)) &&
            !nextUntil.length;
          const freezeEnd =
            endLost ||
            (startLost &&
              !nextUntil.length &&
              !dependentTask.duration &&
              !dependentTask.end);
          mutated = {
            ...dependentTask,
            afterIds: nextAfter,
            duration: freezeEnd ? "" : dependentTask.duration,
            end: freezeEnd
              ? iso(
                  ganttSourceEndMs(
                    interval.end,
                    model.calendar.inclusiveEndDates,
                    dependentTask,
                  ),
                )
              : dependentTask.end,
            scheduleKind: nextAfter.length
              ? "after"
              : startLost
                ? nextUntil.length
                  ? "until"
                  : "explicit"
                : dependentTask.scheduleKind === "until" && endLost
                  ? "explicit"
                  : dependentTask.scheduleKind,
            start: nextAfter.length
              ? `after ${nextAfter.join(" ")}`
              : startLost
                ? iso(interval.start)
                : dependentTask.start,
            untilIds: nextUntil,
          };
        } else {
          mutated = {
            ...dependentTask,
            afterIds: nextAfter,
            scheduleKind: nextAfter.length
              ? "after"
              : dependentTask.scheduleKind === "after"
                ? "previous"
                : dependentTask.scheduleKind,
            untilIds: nextUntil,
          };
          // Dropping the last end anchor would emit a start-only statement that
          // Mermaid cannot resolve, so the current working length is kept.
          const keepsEnd =
            Boolean(mutated.end) ||
            Boolean(mutated.duration) ||
            nextUntil.length > 0 ||
            mutated.isMilestone ||
            mutated.isVert;
          if (!keepsEnd) {
            if (!interval) return ganttNoChange(model, "unresolved-schedule");
            const workingLength = ganttWorkingDurationMs(
              interval.start,
              interval.end,
              resolveGanttCalendar(model.calendar, () => undefined),
            );
            if (workingLength === null)
              return ganttNoChange(model, "unresolved-schedule");
            mutated = {
              ...mutated,
              duration:
                workingLength === 0
                  ? "0d"
                  : (formatGanttDurationMs(workingLength) ?? ""),
            };
          }
        }
        const patch = rebuildTaskLine(model, dependentTask, () => mutated);
        if (!patch) return ganttNoChange(model, "conflict");
        patches.push(patch);
      }
      for (const attachedId of new Set([
        ...removedRecords,
        ...impacts.flatMap((impact) => [
          ...impact.commentIds,
          ...impact.clickIds,
        ]),
      ])) {
        const patch = ganttDeleteStatement(model, attachedId);
        if (patch) patches.push(patch);
      }
      return ganttPatchedResult(model, patches, null);
    }
    case "task.set-statuses": {
      const task = findTask(model, command.taskId);
      if (!task) return ganttNoChange(model, "unknown-task");
      const statuses = [...new Set(command.statuses)];
      if (
        statuses.some(
          (status) =>
            !(GANTT_STATUS_TOKENS as readonly string[]).includes(status),
        )
      )
        return ganttNoChange(model, "invalid-status");
      if (
        statuses.length === task.statuses.length &&
        statuses.every((status) => task.statuses.includes(status))
      )
        return ganttNoChange(model, "no-change");
      const patch = patchTaskTags(model, task, GANTT_STATUS_TOKENS, statuses);
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], {
        id: task.recordId,
        kind: "task",
      });
    }
    case "task.set-shape": {
      const task = findTask(model, command.taskId);
      if (!task) return ganttNoChange(model, "unknown-task");
      if (
        command.milestone === task.isMilestone &&
        command.vert === task.isVert
      )
        return ganttNoChange(model, "no-change");
      const patch = patchTaskTags(model, task, GANTT_SHAPE_TOKENS, [
        ...(command.milestone ? ["milestone"] : []),
        ...(command.vert ? ["vert"] : []),
      ]);
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], {
        id: task.recordId,
        kind: "task",
      });
    }
    case "task.rename-id": {
      const task = findTask(model, command.taskId);
      if (!task) return ganttNoChange(model, "unknown-task");
      if (
        !/^[\w-]+$/.test(command.newId) ||
        [...GANTT_STATUS_TOKENS, "milestone", "vert"].includes(command.newId)
      )
        return ganttNoChange(model, "invalid-id");
      if (command.newId === task.id) return ganttNoChange(model, "no-change");
      if (model.tasks.some((candidate) => candidate.id === command.newId))
        return ganttNoChange(model, "duplicate-id");
      const patches = ganttRenameTaskIdsPatches(
        model,
        new Map([[task.recordId, command.newId]]),
      );
      if (!patches) return ganttNoChange(model, "ambiguous-source");
      return ganttPatchedResult(model, patches, {
        id: task.recordId,
        kind: "task",
      });
    }
  }
}
