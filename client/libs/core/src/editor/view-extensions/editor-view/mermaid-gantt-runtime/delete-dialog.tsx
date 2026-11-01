// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button, Group, Radio, MyoxusText, Stack } from "@myoxus/ui-facade";
import {
  ganttSectionDeleteImpact,
  ganttTaskDeleteImpact,
  mermaidMessages as messages,
  type GanttCommand,
  type MermaidGanttReactHostProps,
} from "@virgultum/block-mermaid";
import { useState } from "react";

/** The same engine plan gates confirmation; a rejected projection is never
 * committed, but still names intervals that would become unresolved. */
function deletePlan(
  props: MermaidGanttReactHostProps,
  command: GanttCommand | null,
) {
  const result = command ? props.onPreviewCommand(command) : null;
  const model = result?.rejectedModel ?? result?.model;
  const unresolved = model?.tasks.filter(
    (task) =>
      Boolean(props.model.intervals[task.recordId]) &&
      !model.intervals[task.recordId],
  );
  return {
    diagnosis: result?.diagnosis,
    valid: Boolean(result?.changed) && !unresolved?.length,
    unresolved: unresolved?.map((task) => task.label).join(", "),
  };
}

function deletePlanMessage(
  plan: ReturnType<typeof deletePlan>,
  labels: string,
) {
  return plan.diagnosis === "ambiguous-source"
    ? messages.ganttAmbiguousSource()
    : `${messages.ganttDiagnosticInvalidSchedule()}: ${plan.unresolved || labels}`;
}

/**
 * Deletion always names its fachlichen Impact: dependents, comments and
 * external references. No strategy is preselected.
 */
export function GanttDeleteDialog({
  onDone,
  props,
  target,
}: {
  readonly onDone: () => void;
  readonly props: MermaidGanttReactHostProps;
  readonly target: { id: string; kind: "task" | "section" };
}) {
  const [strategy, setStrategy] = useState<string>("");
  if (target.kind === "task") {
    const task = props.model.tasks.find(
      (candidate) => candidate.recordId === target.id,
    );
    if (!task) return null;
    const impact = ganttTaskDeleteImpact(props.model, task.recordId);
    const dependents = impact.dependents.map((entry) => entry.label);
    const requiresChoice =
      dependents.length > 0 || impact.commentIds.length > 0;
    const command: GanttCommand | null =
      !requiresChoice || strategy
        ? {
            type: "task.delete",
            taskId: task.recordId,
            strategy: requiresChoice
              ? (strategy as "remove-dependencies" | "materialize-dates")
              : "remove-dependencies",
          }
        : null;
    const plan = deletePlan(props, command);
    if (!dependents.length && !impact.commentIds.length) {
      return (
        <Stack p="sm">
          <MyoxusText typographySlot="body-small">{task.label}</MyoxusText>
          {!plan.valid ? (
            <MyoxusText tone="danger" typographySlot="caption">
              {deletePlanMessage(plan, task.label)}
            </MyoxusText>
          ) : null}
          <Group justify="flex-end">
            <Button variant="plain" onClick={onDone}>
              {messages.cancel()}
            </Button>
            <Button
              color="myoxusError"
              disabled={props.readonly || !plan.valid}
              onClick={() => {
                if (command && props.onCommand(command).changed) onDone();
              }}
            >
              {messages.visualDelete()}
            </Button>
          </Group>
        </Stack>
      );
    }
    return (
      <Stack p="sm" w={360}>
        <MyoxusText typographySlot="dense-label">
          {messages.ganttDeleteImpact()}
        </MyoxusText>
        <MyoxusText typographySlot="body-small">{task.label}</MyoxusText>
        {dependents.length ? (
          <>
            <MyoxusText typographySlot="body-small">
              {messages.ganttDeleteImpactDependents()}
            </MyoxusText>
            <MyoxusText tone="muted" typographySlot="caption">
              {dependents.join(", ")}
            </MyoxusText>
          </>
        ) : null}
        {impact.commentIds.length ? (
          <MyoxusText tone="muted" typographySlot="caption">
            {`${impact.commentIds.length} ${messages.visualComments()}`}
          </MyoxusText>
        ) : null}
        <Stack role="group" aria-label={messages.ganttDeleteImpact()}>
          {[
            {
              label: messages.ganttDeleteDependencies(),
              value: "remove-dependencies",
            },
            {
              label: messages.ganttMaterializeDates(),
              value: "materialize-dates",
            },
          ].map((entry) => (
            <Radio
              key={entry.value}
              name={`task-delete-${target.id}`}
              label={entry.label}
              checked={strategy === entry.value}
              onChange={() => setStrategy(entry.value)}
            />
          ))}
        </Stack>
        {command && !plan.valid ? (
          <MyoxusText tone="danger" typographySlot="caption">
            {deletePlanMessage(plan, task.label)}
          </MyoxusText>
        ) : null}
        <Group justify="flex-end">
          <Button variant="plain" onClick={onDone}>
            {messages.cancel()}
          </Button>
          <Button
            color="myoxusError"
            disabled={props.readonly || !plan.valid}
            onClick={() => {
              if (command && props.onCommand(command).changed) onDone();
            }}
          >
            {messages.visualDelete()}
          </Button>
        </Group>
      </Stack>
    );
  }
  const impact = ganttSectionDeleteImpact(props.model, target.id);
  const content = props.model.tasks.filter(
    (task) => task.sectionId === target.id,
  );
  const external = props.model.tasks.filter(
    (task, index) =>
      task.sectionId !== target.id &&
      ([...task.afterIds, ...task.untilIds].some((id) =>
        impact.taskIds.includes(id),
      ) ||
        (task.scheduleKind === "previous" &&
          props.model.tasks[index - 1]?.sectionId === target.id)),
  );
  const targets = props.model.sections.filter(
    (section) => section.id !== target.id,
  );
  const command: GanttCommand | null = strategy
    ? {
        type: "section.delete",
        sectionId: target.id,
        strategy:
          strategy === "delete-content"
            ? "delete-content"
            : { moveToSectionId: strategy },
      }
    : null;
  const plan = deletePlan(props, command);
  return (
    <Stack p="sm" w={360}>
      <MyoxusText typographySlot="dense-label">
        {messages.ganttDeleteImpact()}
      </MyoxusText>
      <MyoxusText tone="muted" typographySlot="caption">
        {`${impact.taskIds.length} · ${impact.commentIds.length} · ${impact.externalDependencyIds.length}`}
      </MyoxusText>
      <MyoxusText typographySlot="body-small">
        {content.map((task) => task.label).join(", ")}
      </MyoxusText>
      {external.length ? (
        <MyoxusText tone="muted" typographySlot="caption">
          {`${messages.ganttDeleteImpactDependents()}: ${external.map((task) => task.label).join(", ")}`}
        </MyoxusText>
      ) : null}
      <Stack role="group" aria-label={messages.ganttDeleteImpact()}>
        {[
          {
            label: messages.ganttDeleteSectionContent(),
            value: "delete-content",
          },
          ...targets.map((section) => ({
            label: `${messages.ganttMoveContent()}: ${section.title}`,
            value: section.id,
          })),
        ].map((entry) => (
          <Radio
            key={entry.value}
            name={`section-delete-${target.id}`}
            label={entry.label}
            checked={strategy === entry.value}
            onChange={() => setStrategy(entry.value)}
          />
        ))}
      </Stack>
      {command && !plan.valid ? (
        <MyoxusText tone="danger" typographySlot="caption">
          {deletePlanMessage(
            plan,
            content.map((task) => task.label).join(", "),
          )}
        </MyoxusText>
      ) : null}
      <Group justify="flex-end">
        <Button variant="plain" onClick={onDone}>
          {messages.cancel()}
        </Button>
        <Button
          color="myoxusError"
          disabled={props.readonly || !plan.valid}
          onClick={() => {
            if (command && props.onCommand(command).changed) onDone();
          }}
        >
          {messages.visualDelete()}
        </Button>
      </Group>
    </Stack>
  );
}
