// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Stack,
  Button,
  Group,
  TextInput,
  NavLink,
  Text,
  ActionIcon,
  Tooltip,
  Menu,
} from "@mantine/core";
import { useRef } from "react";
import {
  GripVerticalIcon,
  MoreHorizontalIcon,
  CheckIcon,
  CloseIcon,
  CommentIcon,
} from "@myoxus/icons/react";
import { Popover, PopoverTarget, PopoverContent } from "../../popover";
import type {
  TimelineDiagnosticProjection,
  OrdinalTimelineViewProps,
  TimelineObject,
  TimelineMoveIntent,
} from "./timeline-view";

export function TimelineOverlays({
  diagnostics,
}: {
  readonly diagnostics: readonly TimelineDiagnosticProjection[];
}) {
  if (!diagnostics.length) return null;
  return (
    <Stack>
      {diagnostics.map((item) => (
        <Alert
          key={item.id}
          data-timeline-diagnostic-anchor={item.anchorId ?? undefined}
        >
          {item.message}
        </Alert>
      ))}
    </Stack>
  );
}

/** Labels edit in place. Source validation and draft history stay with the consumer. */
export function TimelineObjectLabel({
  object,
  label,
  props,
  accessibleLabel,
}: {
  readonly object: TimelineObject;
  readonly label: string;
  readonly accessibleLabel?: string;
  readonly props: OrdinalTimelineViewProps;
}) {
  const draft = props.labelDraft;
  const editing =
    draft?.object.kind === object.kind && draft.object.id === object.id;
  const selected =
    props.selection?.kind === object.kind && props.selection.id === object.id;
  if (editing && props.labels)
    return (
      <Stack>
        <TextInput
          autoFocus
          aria-label={props.labels.label}
          value={draft.label}
          error={draft.message}
          onChange={(event) => props.onLabelChange?.(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              if (draft.valid) props.onDraftApply?.();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              props.onDraftCancel?.();
            }
          }}
        />
        <Group>
          <Button disabled={!draft.valid} onClick={props.onDraftApply}>
            {props.labels.apply}
          </Button>
          <Button variant="subtle" onClick={props.onDraftCancel}>
            {props.labels.cancel}
          </Button>
        </Group>
      </Stack>
    );
  return (
    <NavLink
      component="button"
      data-timeline-kind={object.kind}
      data-timeline-id={object.id}
      aria-label={accessibleLabel ?? label}
      aria-pressed={selected}
      active={selected}
      disabled={!props.selectionCapability.enabled}
      label={<Text textWrap="pretty">{label}</Text>}
      onClick={() => props.onSelect(object)}
      onDoubleClick={() => {
        if (!props.readonly) props.onRename?.(object);
      }}
      onKeyDown={(event) => {
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          event.stopPropagation();
          if (selected && !props.readonly) props.onDelete?.(object);
          return;
        }
        if (
          ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(
            event.key,
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          const root = event.currentTarget.closest(
            '[data-myoxus-ui-role="timeline-view"]',
          );
          const actors = Array.from(
            root?.querySelectorAll<HTMLElement>("[data-timeline-kind]") ?? [],
          );
          const index = actors.indexOf(event.currentTarget);
          actors[
            Math.max(
              0,
              Math.min(
                actors.length - 1,
                index +
                  (event.key === "ArrowUp" || event.key === "ArrowLeft"
                    ? -1
                    : 1),
              ),
            )
          ]?.focus();
        }
        if ([" ", "Enter", "F2"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === " ") props.onSelect(object);
          else if (!props.readonly) props.onRename?.(object);
        }
      }}
    />
  );
}

/** Capture and move handlers share the handle. A click is selection, never reorder. */
export function TimelineMoveHandle({
  object,
  props,
}: {
  readonly object: TimelineObject;
  readonly props: OrdinalTimelineViewProps;
}) {
  const pointer = useRef<{
    x: number;
    y: number;
    id: number;
    active: boolean;
    intent?: TimelineMoveIntent;
  } | null>(null);
  if (props.readonly || !props.onMovePreview || !props.labels) return null;
  const current =
    props.moveDraft?.object.id === object.id ? props.moveDraft : undefined;
  const groups =
    object.kind === "section"
      ? [
          {
            id: "sections",
            items: props.sections
              .filter((s) => !s.implicit && s.id !== object.id)
              .map((s) => s.id),
          },
        ]
      : object.kind === "period"
        ? props.sections.map((s) => ({
            id: s.id,
            items: s.periods.filter((p) => p.id !== object.id).map((p) => p.id),
          }))
        : props.sections.flatMap((s) =>
            s.periods.map((p) => ({
              id: p.id,
              items: p.events
                .filter((e) => e.id !== object.id)
                .map((e) => e.id),
            })),
          );
  const slots: TimelineMoveIntent[] = groups.flatMap((g) =>
    Array.from({ length: g.items.length + 1 }, (_, targetOrder) => ({
      object,
      targetOrder,
      ...(object.kind === "period"
        ? { targetSectionId: g.id }
        : object.kind === "event"
          ? { targetPeriodId: g.id }
          : {}),
    })),
  );
  const ownGroup =
    object.kind === "section"
      ? "sections"
      : object.kind === "period"
        ? props.sections.find((s) => s.periods.some((p) => p.id === object.id))
            ?.id
        : props.sections
            .flatMap((s) => s.periods)
            .find((p) => p.events.some((e) => e.id === object.id))?.id;
  const ownItems =
    object.kind === "section"
      ? props.sections.filter((s) => !s.implicit).map((s) => s.id)
      : object.kind === "period"
        ? props.sections
            .find((s) => s.id === ownGroup)
            ?.periods.map((p) => p.id)
        : props.sections
            .flatMap((s) => s.periods)
            .find((p) => p.id === ownGroup)
            ?.events.map((e) => e.id);
  const initial = slots.find(
    (i) =>
      (i.targetSectionId ?? i.targetPeriodId ?? "sections") === ownGroup &&
      i.targetOrder === (ownItems?.indexOf(object.id) ?? 0),
  );
  const same = (a: TimelineMoveIntent, b: TimelineMoveIntent) =>
    a.targetOrder === b.targetOrder &&
    a.targetSectionId === b.targetSectionId &&
    a.targetPeriodId === b.targetPeriodId;
  const currentIndex = current ? slots.findIndex((i) => same(i, current)) : -1;
  return (
    <Group wrap="nowrap">
      <Tooltip
        label={
          current
            ? (props.movePreview?.message ??
              props.labels.slot(
                current.targetOrder + 1,
                (groups.find(
                  (g) =>
                    g.id ===
                    (current.targetSectionId ??
                      current.targetPeriodId ??
                      "sections"),
                )?.items.length ?? 0) + 1,
              ))
            : props.labels.moveHint
        }
      >
        <ActionIcon
          variant="subtle"
          aria-label={props.labels.move}
          aria-grabbed={Boolean(current)}
          data-timeline-drag-id={object.id}
          onKeyDown={(event) => {
            if (
              ![
                " ",
                "Enter",
                "Escape",
                "ArrowUp",
                "ArrowDown",
                "ArrowLeft",
                "ArrowRight",
              ].includes(event.key)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") props.onDraftCancel?.();
            else if (event.key === "Enter" && current)
              props.onMoveApply?.(current);
            else if (event.key === " " || event.key === "Enter") {
              if (initial) props.onMovePreview?.(initial);
            } else if (current) {
              const slot =
                slots[
                  Math.max(
                    0,
                    Math.min(
                      slots.length - 1,
                      currentIndex +
                        (event.key === "ArrowUp" || event.key === "ArrowLeft"
                          ? -1
                          : 1),
                    ),
                  )
                ];
              if (slot) props.onMovePreview?.(slot);
            }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            pointer.current = {
              x: event.clientX,
              y: event.clientY,
              id: event.pointerId,
              active: false,
            };
          }}
          onPointerMove={(event) => {
            const draft = pointer.current;
            if (!draft) return;
            if (
              !draft.active &&
              Math.hypot(event.clientX - draft.x, event.clientY - draft.y) < 5
            )
              return;
            draft.active = true;
            const root = event.currentTarget.closest(
              '[data-myoxus-ui-role="timeline-view"]',
            );
            if (!root) return;
            const groupNodes =
              object.kind === "section"
                ? [root]
                : Array.from(
                    root.querySelectorAll<HTMLElement>(
                      object.kind === "period"
                        ? "[data-section-id]"
                        : "[data-period-id]",
                    ),
                  );
            const groupNode = groupNodes.reduce<Element | null>(
              (best, node) => {
                const distance = (n: Element) => {
                  const r = n.getBoundingClientRect();
                  return Math.hypot(
                    Math.max(
                      r.left - event.clientX,
                      0,
                      event.clientX - r.right,
                    ),
                    Math.max(
                      r.top - event.clientY,
                      0,
                      event.clientY - r.bottom,
                    ),
                  );
                };
                return !best || distance(node) < distance(best) ? node : best;
              },
              null,
            );
            const group = groups.find(
              (g) =>
                g.id ===
                (object.kind === "section"
                  ? "sections"
                  : (groupNode as HTMLElement | undefined)?.dataset[
                      object.kind === "period" ? "sectionId" : "periodId"
                    ]),
            );
            if (!group) return;
            const actorNodes = Array.from(
              groupNode?.querySelectorAll<HTMLElement>(
                object.kind === "section"
                  ? "[data-section-id]"
                  : object.kind === "period"
                    ? "[data-period-id]"
                    : "[data-timeline-event-id]",
              ) ?? [],
            ).filter((n) =>
              group.items.includes(
                n.dataset[
                  object.kind === "section"
                    ? "sectionId"
                    : object.kind === "period"
                      ? "periodId"
                      : "timelineEventId"
                ] ?? "",
              ),
            );
            const horizontal =
              object.kind === "period" && props.axis.direction === "LR";
            const targetOrder = actorNodes.findIndex((n) => {
              const r = n.getBoundingClientRect();
              return horizontal
                ? event.clientX < r.left + r.width / 2
                : event.clientY < r.top + r.height / 2;
            });
            const intent = slots.find(
              (i) =>
                (i.targetSectionId ?? i.targetPeriodId ?? "sections") ===
                  group.id &&
                i.targetOrder ===
                  (targetOrder < 0 ? group.items.length : targetOrder),
            );
            if (intent) {
              draft.intent = intent;
              props.onMovePreview?.(intent);
            }
            const viewport = root.querySelector<HTMLElement>(
              "[data-scrollbars] > div, .mantine-ScrollArea-viewport",
            );
            if (viewport) {
              const r = viewport.getBoundingClientRect();
              viewport.scrollBy({
                left:
                  event.clientX > r.right - 24
                    ? 16
                    : event.clientX < r.left + 24
                      ? -16
                      : 0,
                top:
                  event.clientY > r.bottom - 24
                    ? 16
                    : event.clientY < r.top + 24
                      ? -16
                      : 0,
              });
            }
          }}
          onPointerUp={(event) => {
            const draft = pointer.current;
            pointer.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
            if (draft?.active && draft.intent)
              props.onMoveApply?.(draft.intent);
            else props.onSelect(object);
          }}
          onPointerCancel={() => {
            pointer.current = null;
            props.onDraftCancel?.();
          }}
        >
          <GripVerticalIcon />
        </ActionIcon>
      </Tooltip>
      {current && !pointer.current?.active ? (
        <>
          <Tooltip label={props.labels.apply}>
            <ActionIcon
              aria-label={props.labels.apply}
              disabled={props.movePreview?.valid === false}
              onClick={() => props.onMoveApply?.(current)}
            >
              <CheckIcon />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={props.labels.cancel}>
            <ActionIcon
              aria-label={props.labels.cancel}
              variant="subtle"
              onClick={props.onDraftCancel}
            >
              <CloseIcon />
            </ActionIcon>
          </Tooltip>
        </>
      ) : null}
    </Group>
  );
}

/** Insert marker is local renderer geometry; the source actors stay mounted during capture. */
export function TimelineInsertMarker({
  props,
  kind,
  parentId,
  order,
}: {
  readonly props: OrdinalTimelineViewProps;
  readonly kind: TimelineObject["kind"];
  readonly parentId?: string;
  readonly order: number;
}) {
  const move = props.moveDraft;
  if (
    !move ||
    move.object.kind !== kind ||
    move.targetOrder !== order ||
    (kind === "period" && move.targetSectionId !== parentId) ||
    (kind === "event" && move.targetPeriodId !== parentId)
  )
    return null;
  return (
    <Text role="status" className="timeline-insert-marker">
      {props.movePreview?.label} · {props.labels?.slot(order + 1, order + 1)}
    </Text>
  );
}

/** Object menu and the global Selection-Delete emit the same consuming intent. */
export function TimelineObjectActions({
  object,
  props,
}: {
  readonly object: TimelineObject;
  readonly props: OrdinalTimelineViewProps;
}) {
  if (!props.labels || object.id === "timeline-create-draft") return null;
  const implicit =
    object.kind === "section" &&
    props.sections.some((s) => s.id === object.id && s.implicit);
  if (implicit) return null;
  return (
    <Group wrap="nowrap">
      <TimelineMoveHandle object={object} props={props} />
      {props.comments ? (
        <Popover
          fitViewport
          returnFocus
          trapFocus
          opened={props.comments.targetId === object.id}
          onChange={(opened) => {
            if (!opened) props.comments?.onClose();
          }}
        >
          <PopoverTarget>
            <Tooltip
              label={`${props.comments.label} (${props.comments.counts[object.id] ?? 0})`}
            >
              <ActionIcon
                variant="subtle"
                aria-label={`${props.comments.label}: ${object.kind === "section" ? props.sections.find((s) => s.id === object.id)?.label : object.kind === "period" ? props.sections.flatMap((s) => s.periods).find((p) => p.id === object.id)?.label : props.sections.flatMap((s) => s.periods.flatMap((p) => p.events)).find((e) => e.id === object.id)?.label} (${props.comments.counts[object.id] ?? 0})`}
                onClick={() => props.comments?.onOpen(object)}
              >
                <CommentIcon />
              </ActionIcon>
            </Tooltip>
          </PopoverTarget>
          <PopoverContent>
            {props.comments.targetId === object.id
              ? props.comments.content
              : null}
          </PopoverContent>
        </Popover>
      ) : null}
      {!props.readonly && props.onDelete ? (
        <Menu>
          <Menu.Target>
            <ActionIcon variant="subtle" aria-label={props.labels.more}>
              <MoreHorizontalIcon />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => props.onDelete?.(object)}>
              {props.labels.delete}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      ) : null}
    </Group>
  );
}
