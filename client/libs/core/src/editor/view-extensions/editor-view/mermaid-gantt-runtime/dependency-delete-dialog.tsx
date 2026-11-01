// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button, Group, Radio, MyoxusText, Stack } from "@myoxus/ui-facade";
import {
  formatGanttDateValue,
  ganttSourceEndMs,
  mermaidMessages as messages,
  type GanttCommand,
  type MermaidGanttReactHostProps,
} from "@virgultum/block-mermaid";
import { useState } from "react";

import type { GanttDependencyAnchor } from "./projection";

/**
 * Shared dependency-delete decision. Every delete entry point (anchored
 * popover, global selection delete, edge keyboard delete) routes here so the
 * scheduling impact is named once: all changed task intervals and,
 * when the last `after` reference is removed, the concrete new predecessor.
 * No strategy is preselected.
 */
export function GanttDependencyDeleteDialog({
  anchor,
  onDone,
  props,
}: {
  readonly anchor: GanttDependencyAnchor;
  readonly onDone: () => void;
  readonly props: MermaidGanttReactHostProps;
}) {
  const task = props.model.tasks.find(
    (candidate) => candidate.recordId === anchor.taskRecordId,
  );
  const [strategy, setStrategy] = useState<string>("");
  if (!task) return null;

  const dateFormat = props.model.calendar.dateFormat;
  const range = (recordId: string, model: typeof props.model) => {
    const interval = model.intervals[recordId];
    if (!interval) return "—";
    return `${formatGanttDateValue(interval.start, dateFormat)} → ${formatGanttDateValue(interval.end, dateFormat, undefined, "end")}`;
  };
  // Removing the only `after` reference flips the task to Mermaid's implicit
  // previous-start; the user must consciously accept that or freeze the dates.
  const becomesPrevious = anchor.kind === "after" && task.afterIds.length === 1;
  const previousTask = props.model.tasks
    .filter((candidate) => candidate.order < task.order)
    .at(-1);
  const deleteCommand: GanttCommand = {
    kind: anchor.kind,
    referenceId: anchor.referenceId,
    taskRecordId: anchor.taskRecordId,
    type: "dependency.delete",
  };
  const interval = props.model.intervals[task.recordId];
  // Freeze only the removed start binding. The independent until boundary
  // keeps its source reference and calendar semantics.
  const materializeCommand: GanttCommand | null = interval
    ? {
        afterIds: [],
        duration: "",
        end: task.untilIds.length
          ? ""
          : formatGanttDateValue(
              ganttSourceEndMs(
                interval.end,
                props.model.calendar.inclusiveEndDates,
                task,
              ),
              dateFormat,
              undefined,
              "end",
            ),
        mode: task.untilIds.length ? "until" : "explicit-range",
        start: formatGanttDateValue(interval.start, dateFormat),
        taskId: task.recordId,
        type: "schedule.set",
        untilIds: [...task.untilIds],
      }
    : null;
  const beforeRange = range(task.recordId, props.model);
  const strategies = (
    becomesPrevious
      ? [
          {
            command: deleteCommand,
            label: messages.ganttDependencyDeleteAdoptPrevious(),
            value: "previous",
          },
          {
            command: materializeCommand,
            label: messages.ganttMaterializeDates(),
            value: "materialize",
          },
        ]
      : [
          {
            command: deleteCommand,
            label: messages.visualDelete(),
            value: "delete",
          },
        ]
  ).map((entry) => {
    const preview = entry.command
      ? props.onPreviewCommand(entry.command)
      : null;
    const planned = preview?.rejectedModel ?? preview?.model;
    // Compare the engine's complete projection by stable statement identity,
    // not merely direct references: Previous/after/until effects can cascade.
    const affected = props.model.tasks.filter((candidate) => {
      const before = props.model.intervals[candidate.recordId];
      const after = planned?.intervals[candidate.recordId];
      return before?.start !== after?.start || before?.end !== after?.end;
    });
    const unresolved = planned?.tasks.filter(
      (candidate) =>
        !planned.intervals[candidate.recordId] &&
        (candidate.recordId === task.recordId ||
          Boolean(props.model.intervals[candidate.recordId])),
    ) ?? [task];
    return {
      ...entry,
      preview,
      planned,
      affected,
      unresolved,
      valid: Boolean(preview?.changed) && unresolved.length === 0,
    };
  });
  const chosen = becomesPrevious
    ? strategies.find((entry) => entry.value === strategy)
    : strategies[0];

  const commit = () => {
    if (!chosen?.valid || !chosen.command || props.readonly) return;
    if (props.onCommand(chosen.command).changed) {
      onDone();
    }
  };

  return (
    <Stack p="sm" w={380}>
      <MyoxusText typographySlot="dense-label">{task.label}</MyoxusText>
      <MyoxusText tone="muted" typographySlot="caption">
        {`${messages.ganttImpactBefore()}: ${beforeRange}`}
      </MyoxusText>
      {task.afterIds.length ? (
        <MyoxusText tone="muted" typographySlot="caption">
          {`${messages.ganttScheduleAfter()}: ${task.afterIds
            .map(
              (id) =>
                props.model.tasks.find((candidate) => candidate.id === id)
                  ?.label ?? id,
            )
            .join(", ")}`}
        </MyoxusText>
      ) : null}
      {becomesPrevious ? (
        <MyoxusText tone="secondary" typographySlot="caption">
          {messages.ganttDependencyDeletePrevious(
            previousTask?.label ?? messages.ganttSchedulePrevious(),
          )}
        </MyoxusText>
      ) : null}
      {becomesPrevious ? (
        <Stack role="group" aria-label={messages.ganttDeleteImpact()}>
          {strategies.map((entry) => (
            <Radio
              key={entry.value}
              name={`dependency-delete-${task.recordId}`}
              label={entry.label}
              checked={strategy === entry.value}
              onChange={() => setStrategy(entry.value)}
            />
          ))}
        </Stack>
      ) : null}
      {strategies.map((entry) => (
        <Stack key={entry.value}>
          <MyoxusText typographySlot="dense-label">{entry.label}</MyoxusText>
          {entry.affected.map((candidate) => (
            <Stack gap={2} key={candidate.recordId}>
              <MyoxusText typographySlot="body-small">
                {candidate.label}
              </MyoxusText>
              <MyoxusText tone="muted" typographySlot="caption">
                {`${messages.ganttImpactBefore()}: ${range(candidate.recordId, props.model)}`}
              </MyoxusText>
              <MyoxusText tone="muted" typographySlot="caption">
                {`${messages.ganttImpactAfter()}: ${entry.planned ? range(candidate.recordId, entry.planned) : "—"}`}
              </MyoxusText>
            </Stack>
          ))}
          {!entry.valid ? (
            <MyoxusText tone="danger" typographySlot="caption">
              {`${messages.ganttDiagnosticInvalidSchedule()}: ${entry.unresolved.map((candidate) => candidate.label).join(", ") || task.label}`}
            </MyoxusText>
          ) : null}
        </Stack>
      ))}
      <Group justify="flex-end">
        <Button variant="plain" onClick={onDone}>
          {messages.cancel()}
        </Button>
        <Button
          color="myoxusError"
          disabled={props.readonly || !chosen?.valid}
          onClick={commit}
        >
          {messages.visualDelete()}
        </Button>
      </Group>
    </Stack>
  );
}
