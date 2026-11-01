// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Alert,
  Button,
  Group,
  MyoxusText,
  Radio,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  timelineDeleteImpact,
  mermaidMessages as messages,
  TIMELINE_UNSECTIONED_ID,
  type MermaidTimelineReactHostProps,
  type TimelineAnchor,
  type TimelineCommand,
} from "@virgultum/block-mermaid";
import { useState } from "react";

/** Capture ownership and source together. A collaborative edit invalidates Apply, never silently retargets impact. */
export function TimelineDeleteDialog({
  props,
  target,
  onClose,
  onApplied,
}: {
  readonly props: MermaidTimelineReactHostProps;
  readonly target: TimelineAnchor;
  readonly onClose: () => void;
  readonly onApplied: (id?: string) => void;
}) {
  const [model] = useState(props.model);
  const [strategy, setStrategy] = useState<"cascade" | "move" | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const impact = timelineDeleteImpact(model, target);
  if (!impact) return null;
  const source = model.sourceDocument.source;
  const object = [...model.sections, ...model.periods, ...model.events].find(
    (item) => item.id === target.id,
  );
  const command: TimelineCommand | undefined =
    strategy === "cascade"
      ? { type: "delete", anchor: target, strategy: { kind: "cascade" } }
      : strategy === "move" && targetId
        ? {
            type: "delete",
            anchor: target,
            strategy: { kind: "move", targetId },
          }
        : undefined;
  const preview = command ? props.onPreviewCommand(command, source) : undefined;
  const targets = impact.targets.map((id) => ({
    value: id,
    label:
      id === TIMELINE_UNSECTIONED_ID
        ? messages.timelineUnsectioned()
        : ([...model.sections, ...model.periods].find((item) => item.id === id)
            ?.label ?? id),
  }));
  const children = [
    ...model.periods.filter(
      (item) => impact.periodIds.includes(item.id) && item.id !== target.id,
    ),
    ...model.events.filter(
      (item) => impact.eventIds.includes(item.id) && item.id !== target.id,
    ),
  ];
  const comments = model.comments.filter((item) =>
    impact.commentIds.includes(item.id),
  );
  return (
    <Stack>
      <MyoxusText>{object?.label}</MyoxusText>
      {children.map((item) => (
        <MyoxusText key={item.id}>{item.label}</MyoxusText>
      ))}
      {comments.map((comment) => (
        <MyoxusText key={comment.id}>{comment.text}</MyoxusText>
      ))}
      <Radio
        label={
          target.kind === "section"
            ? messages.ganttDeleteSectionContent()
            : target.kind === "period"
              ? messages.timelineDeletePeriodContent()
              : messages.visualDelete()
        }
        checked={strategy === "cascade"}
        onChange={() => setStrategy("cascade")}
      />
      {target.kind !== "event" && targets.length ? (
        <Radio
          label={messages.ganttMoveContent()}
          checked={strategy === "move"}
          onChange={() => setStrategy("move")}
        />
      ) : null}
      {strategy === "move" ? (
        <>
          <Select
            label={
              target.kind === "section"
                ? messages.ganttSection()
                : messages.timelinePeriod()
            }
            value={targetId}
            data={targets}
            comboboxProps={{ withinPortal: false }}
            onChange={setTargetId}
          />
          {model.comments.some((comment) => comment.anchor.id === target.id) ? (
            <MyoxusText>{messages.timelineKeepContainerComments()}</MyoxusText>
          ) : null}
          {model.comments
            .filter((comment) => comment.anchor.id === target.id)
            .map((comment) => (
              <MyoxusText key={comment.id}>
                {messages.visualComments()}: {comment.text}
              </MyoxusText>
            ))}
        </>
      ) : null}
      {error || preview?.reason === "conflict" ? (
        <Alert>{error ?? messages.ganttDiagnosticConflict()}</Alert>
      ) : null}
      <Group>
        <Button variant="plain" onClick={onClose}>
          {messages.cancel()}
        </Button>
        <Button
          disabled={props.readonly || !preview?.changed}
          onClick={() => {
            if (!command) return;
            const result = props.onCommand(command, source);
            if (result.changed) onApplied(result.selection?.id ?? undefined);
            else
              setError(
                result.reason === "conflict"
                  ? messages.ganttDiagnosticConflict()
                  : messages.ganttCommandRejected(),
              );
          }}
        >
          {messages.visualDelete()}
        </Button>
      </Group>
    </Stack>
  );
}
