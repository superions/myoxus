// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Button,
  Group,
  MyoxusText,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  formatGanttDateValue,
  mermaidMessages as messages,
  type GanttCommand,
  type MermaidGanttReactHostProps,
} from "@virgultum/block-mermaid";
import { useId, useState } from "react";

import type { GanttDependencyAnchor } from "./projection";

/**
 * Anchored dependency surface: the honest relation, explicit reconnection of
 * the referenced task and its delete. It never pretends an editable kind
 * switch; the kind is source form, changed by reconverting the schedule.
 */
export function GanttDependencyPopover({
  anchor,
  diagnosisMessage,
  onClose,
  onDeleteRequest,
  props,
}: {
  readonly anchor: { dependencyId: string } & GanttDependencyAnchor;
  readonly diagnosisMessage: (diagnosis: string) => string;
  readonly onClose: (returnFocus?: boolean) => void;
  /** Routes deletion into the shared dependency-impact decision. */
  readonly onDeleteRequest: (anchor: GanttDependencyAnchor) => void;
  readonly props: MermaidGanttReactHostProps;
}) {
  const optionsPortalId = useId();
  const task = props.model.tasks.find(
    (candidate) => candidate.recordId === anchor.taskRecordId,
  );
  const [target, setTarget] = useState<string>(anchor.referenceId);
  const [rejected, setRejected] = useState<string>();
  if (!task) return null;
  const from = props.model.tasks.find((candidate) => candidate.id === target);
  const lastAfter = anchor.kind === "after" && task.afterIds.length === 1;
  const command = {
    endpoint: "source",
    kind: anchor.kind,
    newReferenceId: target,
    referenceId: anchor.referenceId,
    taskRecordId: anchor.taskRecordId,
    type: "dependency.reconnect",
  } satisfies GanttCommand;
  const preview =
    target !== anchor.referenceId ? props.onPreviewCommand(command) : null;
  const affected = preview?.changed
    ? props.model.tasks.filter((candidate) => {
        const before = props.model.intervals[candidate.recordId];
        const after = preview.model.intervals[candidate.recordId];
        return before?.start !== after?.start || before?.end !== after?.end;
      })
    : [];
  const range = (
    model: MermaidGanttReactHostProps["model"],
    recordId: string,
  ) => {
    const interval = model.intervals[recordId];
    if (!interval) return "—";
    return `${formatGanttDateValue(interval.start, model.calendar.dateFormat)} → ${formatGanttDateValue(interval.end, model.calendar.dateFormat, undefined, "end")}`;
  };
  return (
    <Popover
      opened
      fitViewport
      position="bottom-start"
      onChange={(opened) => {
        if (!opened) onClose();
      }}
    >
      <PopoverTarget>
        <span />
      </PopoverTarget>
      <PopoverContent
        id={optionsPortalId}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          props.onConsumeEscape(event.nativeEvent);
          onClose(true);
        }}
      >
        <Scrollable.Viewport autosize maxHeight="floating">
          <Stack p="sm" w={320}>
            <MyoxusText typographySlot="dense-label">
              {`${from?.label ?? anchor.referenceId} → ${task.label}`}
            </MyoxusText>
            <Select
              comboboxProps={{
                withinPortal: true,
                portalProps: { target: `#${CSS.escape(optionsPortalId)}` },
              }}
              label={
                anchor.kind === "after"
                  ? messages.ganttScheduleAfter()
                  : messages.ganttScheduleUntil()
              }
              disabled={props.readonly}
              value={target}
              data={props.model.tasks
                .filter((candidate) => candidate.id !== task.id)
                .filter(
                  (candidate, index, candidates) =>
                    candidates.findIndex(
                      (other) => other.id === candidate.id,
                    ) === index,
                )
                .map((candidate) => ({
                  value: candidate.id,
                  label: `${candidate.label} · ${candidate.id}`,
                  disabled:
                    props.model.tasks.filter(
                      (other) => other.id === candidate.id,
                    ).length !== 1,
                }))}
              onChange={(value) => {
                if (value) {
                  setTarget(value);
                  setRejected(undefined);
                }
              }}
            />
            {rejected || (preview && !preview.changed) ? (
              <MyoxusText tone="danger" typographySlot="caption">
                {diagnosisMessage(rejected ?? preview!.diagnosis)}
              </MyoxusText>
            ) : null}
            {affected.map((candidate) => (
              <Stack gap="xs" key={candidate.recordId}>
                <MyoxusText typographySlot="dense-label">{`${candidate.label} · ${candidate.id}`}</MyoxusText>
                <MyoxusText
                  tone="muted"
                  typographySlot="caption"
                >{`${messages.ganttImpactBefore()}: ${range(props.model, candidate.recordId)}`}</MyoxusText>
                <MyoxusText
                  tone="muted"
                  typographySlot="caption"
                >{`${messages.ganttImpactAfter()}: ${range(preview!.model, candidate.recordId)}`}</MyoxusText>
              </Stack>
            ))}
            {lastAfter ? (
              // Deleting the last explicit dependency leaves an implicit previous
              // start, which the shared decision dialog will name concretely.
              <MyoxusText tone="secondary" typographySlot="caption">
                {messages.ganttDeleteLastDependency(
                  messages.ganttSchedulePrevious(),
                )}
              </MyoxusText>
            ) : null}
            <Group justify="flex-end">
              <Button variant="ghost" onClick={() => onClose(true)}>
                {messages.cancel()}
              </Button>
              <Button
                color="myoxusError"
                disabled={props.readonly}
                variant="secondary"
                onClick={() => onDeleteRequest(anchor)}
              >
                {messages.visualDelete()}
              </Button>
              <Button
                disabled={props.readonly || !preview?.changed}
                onClick={() => {
                  if (!preview?.changed) return;
                  const result = props.onCommand(command);
                  if (result.changed) onClose(true);
                  else setRejected(result.diagnosis);
                }}
              >
                {messages.visualConnect()}
              </Button>
            </Group>
          </Stack>
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
