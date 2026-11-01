// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  applyGanttCommentCommand,
  type GanttCommentCommand,
} from "./comment.js";
import {
  applyGanttDependencyCommand,
  type GanttDependencyCommand,
} from "./dependency.js";
import {
  applyGanttMetadataCommand,
  type GanttMetadataCommand,
} from "./metadata.js";
import {
  applyGanttScheduleCommand,
  type GanttScheduleCommand,
} from "./schedule.js";
import {
  applyGanttSectionCommand,
  ganttSectionDeleteImpact,
  type GanttSectionCommand,
} from "./section.js";

import {
  applyGanttTaskCommand,
  ganttRenameTaskIdsPatches,
  ganttTaskDeleteImpact,
  type GanttTaskCommand,
} from "./task.js";

export { ganttSectionDeleteImpact, ganttTaskDeleteImpact };
export { ganttClickArgumentValue, ganttClickBindingError } from "./metadata.js";
import {
  ganttNoChange,
  ganttPatchedResult,
  type GanttCommandResult,
} from "../writer.js";
import type { MermaidGanttModel } from "../types.js";

export type GanttCommand =
  | GanttSectionCommand
  | GanttTaskCommand
  | GanttScheduleCommand
  | GanttDependencyCommand
  | GanttMetadataCommand
  | GanttCommentCommand;

/** Uses the complete atomic plan, including implicit-id preservation. */
export function ganttReorderImpact(
  model: MermaidGanttModel,
  taskId: string,
  targetSectionId: string,
  targetOrder: number,
) {
  const preview = applyGanttCommands({
    model,
    readonly: false,
    commands: [{ type: "task.reorder", taskId, targetSectionId, targetOrder }],
  });
  if (!preview.changed && !preview.rejectedModel) return [];
  const planned = preview.rejectedModel ?? preview.model;
  return model.tasks.filter((task) => {
    const before = model.intervals[task.recordId];
    const after = planned.intervals[task.recordId];
    return before?.start !== after?.start || before?.end !== after?.end;
  });
}

type GanttCommandInput = {
  readonly model: MermaidGanttModel;
  readonly source?: string;
  readonly readonly: boolean;
  readonly command: GanttCommand;
};

function applyGanttCommandDraft(input: GanttCommandInput): GanttCommandResult {
  const model = input.model;
  switch (input.command.type) {
    case "section.add":
    case "section.rename":
    case "section.reorder":
    case "section.delete":
      return applyGanttSectionCommand({
        command: input.command,
        model,
        readonly: input.readonly,
      });
    case "task.add":
    case "task.rename":
    case "task.reorder":
    case "task.delete":
    case "task.set-statuses":
    case "task.set-shape":
    case "task.rename-id":
      return applyGanttTaskCommand({
        command: input.command,
        model,
        readonly: input.readonly,
      });
    case "schedule.set":
    case "task.move":
    case "task.resize":
      return applyGanttScheduleCommand({
        command: input.command,
        model,
        readonly: input.readonly,
      });
    case "dependency.create":
    case "dependency.reconnect":
    case "dependency.delete":
      return applyGanttDependencyCommand({
        command: input.command,
        model,
        readonly: input.readonly,
      });
    case "metadata.set":
    case "metadata.remove":
    case "option.set":
    case "option.remove":
    case "click.set":
    case "click.remove":
      return applyGanttMetadataCommand({
        command: input.command,
        model,
        readonly: input.readonly,
      });
    case "comment.add":
    case "comment.edit":
    case "comment.delete":
      return applyGanttCommentCommand({
        command: input.command,
        model,
        readonly: input.readonly,
      });
    default:
      return ganttNoChange(model, "unknown-command");
  }
}

/** Preserves referenced implicit ids within the same confirmed command. */
export function applyGanttCommand(
  input: GanttCommandInput,
): GanttCommandResult {
  const { model: before, command } = input;
  const next = applyGanttCommandDraft(input);
  const structural =
    command.type === "task.add" ||
    command.type === "task.reorder" ||
    command.type === "task.delete" ||
    command.type === "section.reorder" ||
    command.type === "section.delete";
  if (!structural || (!next.changed && !next.rejectedModel)) return next;
  // Renumbering may itself make the first draft unresolved. Inspect that pure
  // candidate before rejecting so referenced automatic IDs can be stabilized.
  const projected = next.rejectedModel ?? next.model;
  const names = new Map<string, string>();
  const reserved = new Set(before.tasks.map((task) => task.id));
  const referenced = new Set([
    ...before.tasks.flatMap((task) => [...task.afterIds, ...task.untilIds]),
    ...before.clicks.flatMap((click) =>
      click.targetTaskId ? [click.targetTaskId] : [],
    ),
  ]);
  for (const task of before.tasks) {
    const moved = projected.tasks.find(
      (candidate) => candidate.recordId === task.recordId,
    );
    if (
      task.explicitId ||
      !referenced.has(task.id) ||
      !moved ||
      moved.id === task.id
    )
      continue;
    // Source-order ids cannot identify a reference across structural edits.
    // Reuse the id-rename owner before the mutation; reloads never do this.
    let id = `${task.id}-ref`;
    let suffix = 1;
    while (reserved.has(id)) id = `${task.id}-ref${++suffix}`;
    reserved.add(id);
    names.set(task.recordId, id);
  }
  if (!names.size) return next;
  const patches = ganttRenameTaskIdsPatches(before, names);
  if (!patches) return ganttNoChange(before, "conflict");
  const materialized = ganttPatchedResult(before, patches, null);
  if (!materialized.changed)
    return ganttNoChange(before, materialized.diagnosis);
  const prepared = materialized.model;
  const committed = applyGanttCommandDraft({ ...input, model: prepared });
  return committed.changed
    ? committed
    : {
        ...ganttNoChange(before, committed.diagnosis),
        rejectedModel: committed.rejectedModel,
      };
}

/**
 * Stages a multi-field draft as one atomic result so the host creates exactly
 * one history entry per confirmed user action.
 */
export function applyGanttCommands(input: {
  readonly model: MermaidGanttModel;
  readonly readonly: boolean;
  readonly commands: readonly GanttCommand[];
}): GanttCommandResult {
  let result: GanttCommandResult | null = null;
  for (const command of input.commands) {
    const before = result?.model ?? input.model;
    const next = applyGanttCommand({
      model: before,
      readonly: input.readonly,
      command,
    });
    if (!next.changed && next.diagnosis !== "no-change") {
      return {
        ...ganttNoChange(input.model, next.diagnosis),
        rejectedModel: next.rejectedModel,
      };
    }
    if (next.changed) result = next;
  }
  return result ?? ganttNoChange(input.model, "no-change");
}
