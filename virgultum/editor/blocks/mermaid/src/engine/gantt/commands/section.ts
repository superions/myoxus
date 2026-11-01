// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ganttAnchorAfter,
  ganttDeleteStatement,
  ganttInsertAfter,
  ganttMovePatches,
  ganttNoChange,
  ganttPatchedResult,
  ganttReplaceStatement,
  ganttStatementSpan,
  type GanttCommandResult,
} from "../writer.js";
import {
  isMermaidGanttSectionTitle,
  type GanttSelection,
  type MermaidGanttModel,
} from "../types.js";
import { applyGanttTaskCommand } from "./task.js";

export type GanttSectionCommand =
  | {
      readonly type: "section.add";
      readonly title: string;
      readonly afterSectionId?: string | null;
    }
  | {
      readonly type: "section.rename";
      readonly sectionId: string;
      readonly title: string;
    }
  | {
      readonly type: "section.reorder";
      readonly sectionId: string;
      readonly targetOrder: number;
    }
  | {
      readonly type: "section.delete";
      readonly sectionId: string;
      readonly strategy:
        "delete-content" | { readonly moveToSectionId: string };
    };

export type GanttSectionDeleteImpact = {
  readonly taskIds: readonly string[];
  readonly commentIds: readonly string[];
  readonly externalDependencyIds: readonly string[];
};

export function ganttSectionDeleteImpact(
  model: MermaidGanttModel,
  sectionId: string,
): GanttSectionDeleteImpact {
  const ownedTasks = model.tasks.filter((task) => task.sectionId === sectionId);
  const taskIds = ownedTasks.map((task) => task.id);
  const inside = new Set(taskIds);
  const taskRecords = new Set(ownedTasks.map((task) => task.recordId));
  const externalDependencyIds = model.tasks.flatMap((task, index) => {
    if (taskRecords.has(task.recordId)) return [];
    const previous = model.tasks[index - 1];
    return [
      ...task.afterIds,
      ...task.untilIds,
      ...(task.scheduleKind === "previous" &&
      previous &&
      taskRecords.has(previous.recordId)
        ? [previous.id]
        : []),
    ].filter((id) => inside.has(id));
  });
  const commentIds = model.comments
    .filter(
      (comment) =>
        (comment.anchor.kind === "section" &&
          comment.anchor.id === sectionId) ||
        (comment.anchor.kind === "task" && taskRecords.has(comment.anchor.id)),
    )
    .map((comment) => comment.id);
  return { commentIds, externalDependencyIds, taskIds };
}

/** Section header, its tasks and their bound comments move as one byte block. */
function sectionBlockStatementIds(model: MermaidGanttModel, sectionId: string) {
  const section = model.sections.find(
    (candidate) => candidate.id === sectionId,
  );
  if (!section) return [] as string[];
  const taskRecords = model.tasks
    .filter((task) => task.sectionId === sectionId)
    .flatMap((task) => [
      task.recordId,
      ...model.comments
        .filter(
          (comment) =>
            comment.anchor.kind === "task" &&
            comment.anchor.id === task.recordId,
        )
        .map((comment) => comment.recordId),
    ]);
  return [
    ...model.comments
      .filter(
        (comment) =>
          comment.anchor.kind === "section" && comment.anchor.id === sectionId,
      )
      .map((comment) => comment.recordId),
    section.recordId,
    ...taskRecords,
  ].filter(Boolean);
}

export function applyGanttSectionCommand(input: {
  readonly model: MermaidGanttModel;
  readonly readonly: boolean;
  readonly command: GanttSectionCommand;
}): GanttCommandResult {
  const { command, model, readonly } = input;
  if (readonly) return ganttNoChange(model, "readonly");
  switch (command.type) {
    case "section.add": {
      if (!isMermaidGanttSectionTitle(command.title))
        return ganttNoChange(model, "invalid-label");
      const anchorId =
        command.afterSectionId ?? model.sections.at(-1)?.recordId ?? null;
      let anchorStatement = anchorId;
      if (anchorId) {
        const lastTask = [...model.tasks]
          .reverse()
          .find((task) => task.sectionId === anchorId);
        anchorStatement = lastTask?.recordId ?? anchorId;
      }
      const patch = ganttInsertAfter(
        model,
        anchorStatement,
        `section ${command.title.trim()}`,
      );
      if (!patch) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, [patch], null);
    }
    case "section.rename": {
      const section = model.sections.find(
        (candidate) => candidate.id === command.sectionId,
      );
      if (!section || !isMermaidGanttSectionTitle(command.title))
        return ganttNoChange(model, "invalid-label");
      const patch = ganttReplaceStatement(
        model,
        section.recordId,
        `${section.recordId ? (model.sourceDocument.statements.find((s) => s.id === section.recordId)?.indent ?? "  ") : "  "}section ${command.title.trim()}`,
      );
      if (!patch) return ganttNoChange(model, "conflict");
      const selection: GanttSelection = { id: section.id, kind: "section" };
      return ganttPatchedResult(model, [patch], selection);
    }
    case "section.reorder": {
      const ordered = [...model.sections].sort((a, b) => a.order - b.order);
      const from = ordered.findIndex((s) => s.id === command.sectionId);
      if (from < 0) return ganttNoChange(model, "unknown-section");
      const target = Math.max(
        0,
        Math.min(ordered.length - 1, Math.round(command.targetOrder)),
      );
      if (target === from) return ganttNoChange(model, "no-change");
      const moved = ordered[from]!;
      const blockIds = sectionBlockStatementIds(model, moved.id);
      const span = ganttStatementSpan(model, blockIds);
      if (!span) return ganttNoChange(model, "conflict");
      const next = [...ordered];
      next.splice(from, 1);
      const anchorSection = next[Math.max(0, target - 1)];
      const anchorId =
        target === 0
          ? null
          : (model.tasks
              .filter((task) => task.sectionId === anchorSection?.id)
              .at(-1)?.recordId ??
            anchorSection?.recordId ??
            null);
      const anchor = ganttAnchorAfter(model, anchorId);
      if (anchor === null) return ganttNoChange(model, "conflict");
      const patches = ganttMovePatches(model, span, anchor);
      if (!patches) return ganttNoChange(model, "conflict");
      return ganttPatchedResult(model, patches, {
        id: moved.id,
        kind: "section",
      });
    }
    case "section.delete": {
      const section = model.sections.find((s) => s.id === command.sectionId);
      if (!section) return ganttNoChange(model, "unknown-section");
      const movedTasks = model.tasks.filter(
        (task) => task.sectionId === command.sectionId,
      );
      if (command.strategy === "delete-content") {
        // Validate the complete removed set, never an intermediate task
        // deletion whose temporary dependent is also about to be removed.
        let staged = model;
        if (movedTasks.length) {
          const result = applyGanttTaskCommand({
            model: staged,
            readonly,
            deleteRecordIds: movedTasks.map((task) => task.recordId),
            command: {
              type: "task.delete",
              taskId: movedTasks[0]!.recordId,
              strategy: "remove-dependencies",
            },
          });
          if (!result.changed)
            return {
              ...ganttNoChange(model, result.diagnosis),
              rejectedModel: result.rejectedModel,
            };
          staged = result.model;
        }
        const remaining = [
          section.recordId,
          ...staged.comments
            .filter(
              (comment) =>
                comment.anchor.kind === "section" &&
                comment.anchor.id === section.id,
            )
            .map((comment) => comment.recordId),
        ];
        const result = ganttPatchedResult(
          staged,
          remaining.flatMap((id) => {
            const patch = ganttDeleteStatement(staged, id);
            return patch ? [patch] : [];
          }),
          null,
        );
        return result.changed ? result : ganttNoChange(model, result.diagnosis);
      }
      if (typeof command.strategy === "object") {
        const target = command.strategy.moveToSectionId;
        const targetSection = model.sections.find(
          (s) => s.id === target && s.id !== command.sectionId,
        );
        if (!targetSection) return ganttNoChange(model, "unknown-section");
        const sectionComments = model.comments
          .filter(
            (comment) =>
              comment.anchor.kind === "section" &&
              comment.anchor.id === section.id,
          )
          .map((comment) => comment.recordId);
        // Resolve every span against the original source and validate only the
        // complete move. A dependent may be invalid between individual moves.
        const sectionPatch = ganttDeleteStatement(model, section.recordId);
        if (!sectionPatch) return ganttNoChange(model, "conflict");
        const patches = [sectionPatch];
        if (movedTasks.length) {
          const contentIds = sectionBlockStatementIds(model, section.id).filter(
            (id) => id !== section.recordId && !sectionComments.includes(id),
          );
          const span = ganttStatementSpan(model, contentIds);
          const lastTarget = model.tasks
            .filter((task) => task.sectionId === target)
            .at(-1);
          const anchor = ganttAnchorAfter(
            model,
            lastTarget?.recordId ?? targetSection.recordId,
          );
          if (!span || anchor === null) return ganttNoChange(model, "conflict");
          const moved = ganttMovePatches(model, span, anchor);
          if (!moved) return ganttNoChange(model, "conflict");
          patches.push(...moved);
        }
        if (sectionComments.length) {
          const span = ganttStatementSpan(model, sectionComments);
          const header = model.sourceDocument.statements.find(
            (entry) => entry.id === targetSection.recordId,
          );
          if (!span || !header) return ganttNoChange(model, "conflict");
          const moved = ganttMovePatches(model, span, header.range.start);
          if (!moved) return ganttNoChange(model, "conflict");
          patches.push(...moved);
        }
        return ganttPatchedResult(model, patches, {
          kind: "section",
          id: target,
        });
      }
      return ganttNoChange(model, "unknown-command");
    }
  }
}
