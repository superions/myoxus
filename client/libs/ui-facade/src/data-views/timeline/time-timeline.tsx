// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Button,
  Alert,
  Badge,
  Box,
  Card,
  Group,
  NavLink,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Popover, PopoverTarget, PopoverContent } from "../../popover";
import { useResponsiveElementSize } from "../../responsive";
import {
  temporalAxisWidth,
  temporalValueToOffset,
  temporalOffsetToValue,
} from "../temporal/geometry";
import { ordinalTimelineGeometry } from "./geometry";
import type {
  TimeTimelineViewProps,
  TimeTimelineEntry,
  TimeTimelineTimeIntent,
} from "./timeline-view";

/** Pointer release leaves a preview. Keyboard Drop and explicit Apply use
 * the same consuming intent; a sub-threshold pointer gesture writes nothing.
 */
function TimeHandle({
  entry,
  mode,
  props,
  planeWidth,
}: {
  entry: TimeTimelineEntry;
  mode: TimeTimelineTimeIntent["mode"];
  props: TimeTimelineViewProps;
  planeWidth: number;
}) {
  const pointer = useRef<{
    x: number;
    scroll: number;
    start: number;
    end: number | null;
    step: number;
    scale: number;
    active: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const capability =
    mode === "move"
      ? entry.timeActions?.move
      : mode === "resize-start"
        ? entry.timeActions?.start
        : entry.timeActions?.end;
  const step =
    mode === "move"
      ? entry.timeActions?.moveStep
      : mode === "resize-start"
        ? entry.timeActions?.startStep
        : entry.timeActions?.endStep;
  const label =
    mode === "move"
      ? props.timeLabels?.move
      : mode === "resize-start"
        ? props.timeLabels?.start
        : props.timeLabels?.end;
  if (!capability || !step || !label || !props.onTimePreview) return null;
  if (!capability.enabled && !entry.timePreview) return null;
  const current = entry.timePreview?.mode === mode ? entry.timePreview : null;
  const initial = { id: entry.id, start: entry.start, end: entry.end, mode };
  const intent = (
    start: number,
    end: number | null,
    delta: number,
  ): TimeTimelineTimeIntent => ({
    id: entry.id,
    mode,
    start: mode === "resize-end" ? start : start + delta,
    end: end === null || mode === "resize-start" ? end : end + delta,
  });
  const viewport = (target: HTMLElement) =>
    target
      .closest('[data-myoxus-ui-role="timeline-view"]')
      ?.querySelector<HTMLElement>(".mantine-ScrollArea-viewport");
  return (
    <Button
      variant="subtle"
      disabled={!capability.enabled}
      aria-label={label}
      aria-grabbed={Boolean(current)}
      title={capability.reason}
      data-time-handle-id={entry.id}
      data-time-handle-mode={mode}
      onClick={(event) => {
        event.stopPropagation();
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        props.onTimePreview?.(initial);
      }}
      onKeyDown={(event) => {
        if (
          ![
            " ",
            "Enter",
            "Escape",
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
          ].includes(event.key)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") props.onTimeCancel?.();
        else if (event.key === "Enter" && current) props.onTimeApply?.(current);
        else if (event.key === " " || event.key === "Enter")
          props.onTimePreview?.(initial);
        else if (current)
          props.onTimePreview?.(
            intent(
              current.start,
              current.end,
              (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) *
                step,
            ),
          );
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        pointer.current = {
          x: event.clientX,
          scroll: viewport(event.currentTarget)?.scrollLeft ?? 0,
          start: entry.start,
          end: entry.end,
          step,
          scale: (props.axis.end - props.axis.start) / planeWidth,
          active: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const basis = pointer.current;
        if (!basis || !props.onTimePreview) return;
        if (!basis.active && Math.abs(event.clientX - basis.x) < 5) return;
        basis.active = true;
        const scroller = viewport(event.currentTarget);
        if (scroller) {
          const rect = scroller.getBoundingClientRect();
          scroller.scrollBy({
            left:
              event.clientX > rect.right - 24
                ? 16
                : event.clientX < rect.left + 24
                  ? -16
                  : 0,
          });
        }
        const offset =
          event.clientX - basis.x + (scroller?.scrollLeft ?? 0) - basis.scroll;
        const delta =
          Math.round((offset * basis.scale) / basis.step) * basis.step;
        props.onTimePreview(intent(basis.start, basis.end, delta));
      }}
      onPointerUp={(event) => {
        const basis = pointer.current;
        pointer.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        suppressClick.current = Boolean(basis?.active);
      }}
      onPointerCancel={() => {
        pointer.current = null;
        suppressClick.current = true;
        props.onTimeCancel?.();
      }}
    >
      {label}
    </Button>
  );
}

/** Cards occupy collision stacks, never one fixed lane per entry. Measurements
 * affect label bounds only; the exact point/range keeps the shared time scale.
 */
export function TimeTimeline(props: TimeTimelineViewProps) {
  const { ref, width } = useResponsiveElementSize<HTMLDivElement>();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const placePointer = useRef<{
    id: number;
    start: number;
    x: number;
    active: boolean;
  } | null>(null);
  const placement = props.placement;
  const [font, setFont] = useState("");
  const [groupOffsets, setGroupOffsets] = useState<Record<string, number>>({});
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const root = useCallback(
    (element: HTMLDivElement | null) => {
      rootRef.current = element;
      ref(element);
    },
    [ref],
  );
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const next = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    setFont((previous) => (previous === next ? previous : next));
    const measure = () => {
      const next: Record<string, number> = {};
      for (const card of element.querySelectorAll<HTMLElement>(
        "[data-time-card-id]",
      ))
        next[card.dataset.timeCardId!] = card.getBoundingClientRect().height;
      const plane = element.querySelector<HTMLElement>(".timeline-time-plane");
      if (plane) {
        const origin = plane.getBoundingClientRect().top;
        const offsets = Object.fromEntries(
          [
            ...element.querySelectorAll<HTMLElement>("[data-time-group-id]"),
          ].map((group) => [
            group.dataset.timeGroupId!,
            group.getBoundingClientRect().top - origin,
          ]),
        );
        setGroupOffsets((previous) =>
          Object.keys(previous).length === Object.keys(offsets).length &&
          Object.entries(offsets).every(([id, value]) => previous[id] === value)
            ? previous
            : offsets,
        );
      }
      setSizes((previous) =>
        Object.keys(next).length === Object.keys(previous).length &&
        Object.entries(next).every(([id, height]) => previous[id] === height)
          ? previous
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const card of element.querySelectorAll<HTMLElement>(
      "[data-time-card-id]",
    ))
      observer.observe(card);
    for (const group of element.querySelectorAll<HTMLElement>(
      "[data-time-group-id]",
    ))
      observer.observe(group);
    return () => observer.disconnect();
  }, [props.groups, font]);
  const planeWidth = temporalAxisWidth(
    {
      ...props.axis,
      // Display density follows visible ticks, not the finer edit snap step.
      step:
        (props.axis.end - props.axis.start) /
        Math.max(1, props.axis.ticks.length - 1),
    },
    width,
  );
  const cardWidth = ordinalTimelineGeometry(
    width,
    props.groups.flatMap((group) => group.entries.map((entry) => entry.label)),
    font,
  ).cardWidth;
  const x = (value: number) =>
    temporalValueToOffset(props.axis, value, planeWidth);
  // Cards share one keyed parent: changing a date group moves geometry,
  // without remounting the entry or losing capture, input or focus.
  const layouts = props.groups.map((group) => {
    // Server order controls collisions, but a later row may occupy a
    // free gap before an earlier row on the same time axis.
    const levels: {
      spans: { left: number; right: number }[];
      height: number;
    }[] = [];
    const placed = group.entries.map((entry) => {
      const left = Math.max(
        0,
        Math.min(planeWidth - cardWidth, x(entry.start)),
      );
      const right = Math.max(left + cardWidth, x(entry.end ?? entry.start));
      let level = levels.findIndex((candidate) =>
        candidate.spans.every(
          (span) => span.right + 16 <= left || right + 16 <= span.left,
        ),
      );
      if (level < 0) level = levels.length;
      levels[level] = {
        spans: [...(levels[level]?.spans ?? []), { left, right }],
        height: Math.max(levels[level]?.height ?? 0, sizes[entry.id] ?? 96),
      };
      return { entry, left, level };
    });
    const top = (level: number) =>
      levels.slice(0, level).reduce((sum, item) => sum + item.height + 32, 24);
    const height = top(levels.length);

    return { group, placed, top, height };
  });
  return (
    <Box
      ref={root}
      data-myoxus-ui-role="timeline-view"
      data-axis-kind="time"
      role="region"
      aria-label={props.accessibility.title}
      aria-description={props.accessibility.description}
      onKeyDown={(event) => {
        if (
          !placement?.active ||
          placement.chosen ||
          event.target instanceof HTMLInputElement
        )
          return;
        if (
          [
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Enter",
            "Escape",
          ].includes(event.key)
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") placement.onCancel();
          else if (event.key === "Enter") placement.onChoose();
          else {
            const delta =
              (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) *
              placement.step;
            const start = Math.max(
              props.axis.start,
              Math.min(
                props.axis.end - placement.step,
                placement.start + delta,
              ),
            );
            if (event.shiftKey) {
              const end = Math.max(
                props.axis.start,
                Math.min(
                  props.axis.end - placement.step,
                  (placement.end ?? placement.start) + delta,
                ),
              );
              placement.onPreview(
                Math.min(placement.start, end),
                Math.max(placement.start, end),
              );
            } else placement.onPreview(start, null);
          }
        }
      }}
    >
      {/* The renderer caps dense collision stacks in its own ScrollArea; the
        document never gains a horizontal surface or a technical Row table. */}
      <ScrollArea.Autosize mah="70vh" type="auto" offsetScrollbars>
        <Box
          className="timeline-time-plane"
          style={{ width: planeWidth }}
          tabIndex={placement?.active ? 0 : undefined}
          data-time-placement-plane={placement?.active || undefined}
          onPointerDown={(event) => {
            if (
              !placement?.active ||
              placement.chosen ||
              event.button !== 0 ||
              (event.target as HTMLElement).closest(
                "button, input, [data-time-card-id]",
              )
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            const value = temporalOffsetToValue(
              props.axis,
              event.clientX - rect.left,
              planeWidth,
            );
            const start = Math.max(
              props.axis.start,
              Math.min(
                props.axis.end - placement.step,
                props.axis.start +
                  Math.round((value - props.axis.start) / placement.step) *
                    placement.step,
              ),
            );
            placePointer.current = {
              id: event.pointerId,
              start,
              x: event.clientX,
              active: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            placement.onPreview(start, null);
          }}
          onPointerMove={(event) => {
            const pointer = placePointer.current;
            if (!pointer || !placement?.active) return;
            if (!pointer.active && Math.abs(event.clientX - pointer.x) < 5)
              return;
            pointer.active = true;
            const rect = event.currentTarget.getBoundingClientRect();
            const value = temporalOffsetToValue(
              props.axis,
              event.clientX - rect.left,
              planeWidth,
            );
            const end =
              props.axis.start +
              Math.round((value - props.axis.start) / placement.step) *
                placement.step;
            placement.onPreview(
              Math.min(pointer.start, end),
              Math.max(pointer.start, end),
            );
          }}
          onPointerUp={(event) => {
            const pointer = placePointer.current;
            placePointer.current = null;
            if (!pointer || !placement?.active) return;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
            placement.onChoose();
          }}
          onPointerCancel={() => {
            placePointer.current = null;
            placement?.onCancel();
          }}
        >
          <Box className="timeline-time-axis">
            {props.axis.ticks.map((tick) => (
              <Text
                key={tick.value}
                size="sm"
                className="timeline-time-tick"
                data-edge={
                  x(tick.value) === 0
                    ? "start"
                    : x(tick.value) === planeWidth
                      ? "end"
                      : "middle"
                }
                style={{ left: x(tick.value) }}
              >
                {tick.label}
              </Text>
            ))}
          </Box>
          {layouts.flatMap(({ group, placed, top, height }) => [
            <Stack key={`group:${group.id}`} gap="xs">
              {group.label !== null ? (
                <Group
                  role="heading"
                  aria-level={2}
                  aria-label={group.label}
                  tabIndex={0}
                >
                  <Text fw="bold">{group.label}</Text>
                  <Badge>{group.entries.length}</Badge>
                </Group>
              ) : null}
              <Box
                className="timeline-time-group"
                data-time-group-id={group.id}
                style={{ height }}
              >
                <svg
                  className="timeline-time-lines"
                  width={planeWidth}
                  height={height}
                  aria-hidden="true"
                >
                  <line
                    x1={0}
                    x2={planeWidth}
                    y1={8}
                    y2={8}
                    className="timeline-time-baseline"
                  />
                  {placed.map(({ entry, level }) => {
                    const y = top(level) - 12;
                    const start = x(entry.start),
                      end = x(entry.end ?? entry.start);
                    return (
                      <g key={entry.id}>
                        {entry.end !== null ? (
                          <line
                            data-time-range-id={entry.id}
                            x1={start}
                            x2={end}
                            y1={y}
                            y2={y}
                          />
                        ) : null}
                        <circle
                          data-time-point-id={entry.id}
                          cx={start}
                          cy={y}
                          r={4}
                        />
                        {entry.end !== null ? (
                          <circle cx={end} cy={y} r={4} />
                        ) : null}
                        <line x1={start} x2={start} y1={y} y2={top(level)} />
                        {entry.start < props.axis.start ? (
                          <path d={`M 8 ${y - 4} L 0 ${y} L 8 ${y + 4}`} />
                        ) : null}
                        {entry.end !== null && entry.end > props.axis.end ? (
                          <path
                            d={`M ${planeWidth - 8} ${y - 4} L ${planeWidth} ${y} L ${planeWidth - 8} ${y + 4}`}
                          />
                        ) : null}
                      </g>
                    );
                  })}
                  {props.now !== undefined &&
                  props.now >= props.axis.start &&
                  props.now < props.axis.end ? (
                    <line
                      x1={x(props.now)}
                      x2={x(props.now)}
                      y1={0}
                      y2={height}
                      className="timeline-time-now"
                    />
                  ) : null}
                </svg>
              </Box>
            </Stack>,
            ...placed.map(({ entry, left, level }) => (
              <Card
                key={entry.id}
                withBorder
                className="timeline-time-card"
                data-time-card-id={entry.id}
                data-selected={entry.selected || undefined}
                style={{
                  left,
                  top: (groupOffsets[group.id] ?? 56) + top(level),
                  width: cardWidth,
                }}
              >
                {entry.labelContent ?? (
                  <NavLink
                    component="button"
                    label={<Text textWrap="pretty">{entry.label}</Text>}
                    data-time-entry-id={entry.id}
                    aria-label={entry.accessibleLabel}
                    aria-pressed={entry.selected}
                    active={entry.selected}
                    onClick={() => props.onSelect(entry.id)}
                    onDoubleClick={() => props.onOpen(entry.id)}
                    onKeyDown={(event) => {
                      if (event.key === "F2" && entry.rename?.enabled) {
                        event.preventDefault();
                        event.stopPropagation();
                        props.onRename?.(entry.id);
                      }
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.stopPropagation();
                        props.onOpen(entry.id);
                      }
                      if (event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        props.onSelect(entry.id);
                      }
                      if (
                        [
                          "ArrowLeft",
                          "ArrowRight",
                          "ArrowUp",
                          "ArrowDown",
                        ].includes(event.key)
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        const positions = layouts.flatMap((layout) =>
                          layout.placed.map((position) => ({
                            ...position,
                            group: layout.group.id,
                          })),
                        );
                        const current = positions.find(
                          (position) => position.entry.id === entry.id,
                        );
                        if (!current) return;
                        const horizontal =
                          event.key === "ArrowLeft" ||
                          event.key === "ArrowRight";
                        const direction =
                          event.key === "ArrowLeft" || event.key === "ArrowUp"
                            ? -1
                            : 1;
                        const candidates = positions.filter(
                          (position) =>
                            position.entry.id !== entry.id &&
                            (horizontal
                              ? direction *
                                  (position.entry.start - entry.start) >
                                0
                              : position.group === group.id &&
                                direction * (position.level - level) > 0),
                        );
                        candidates.sort((a, b) =>
                          horizontal
                            ? Math.abs(a.entry.start - entry.start) -
                                Math.abs(b.entry.start - entry.start) ||
                              Math.abs(a.level - level) -
                                Math.abs(b.level - level)
                            : Math.abs(a.level - level) -
                                Math.abs(b.level - level) ||
                              Math.abs(a.left - left) - Math.abs(b.left - left),
                        );
                        const target = candidates[0]?.entry.id;
                        [
                          ...(rootRef.current?.querySelectorAll<HTMLElement>(
                            "[data-time-entry-id]",
                          ) ?? []),
                        ]
                          .find((actor) => actor.dataset.timeEntryId === target)
                          ?.focus();
                      }
                    }}
                  />
                )}
                <Text size="sm" textWrap="pretty">
                  {entry.timeLabel}
                </Text>
                {entry.content}
                {entry.selected ? (
                  <Group>
                    {entry.dateEditor ? (
                      <Popover
                        fitViewport
                        returnFocus
                        trapFocus
                        opened={entry.dateEditor.opened}
                        onChange={(opened) => {
                          if (!opened) entry.dateEditor?.onClose();
                        }}
                      >
                        <PopoverTarget>
                          <Button
                            variant="subtle"
                            disabled={!entry.dateEditor.enabled}
                            onClick={entry.dateEditor.onOpen}
                          >
                            {entry.dateEditor.label}
                          </Button>
                        </PopoverTarget>
                        <PopoverContent>
                          {entry.dateEditor.content}
                        </PopoverContent>
                      </Popover>
                    ) : null}
                    {entry.timeActions && props.timeLabels ? (
                      <>
                        <TimeHandle
                          entry={entry}
                          mode="move"
                          props={props}
                          planeWidth={planeWidth}
                        />
                        <TimeHandle
                          entry={entry}
                          mode="resize-start"
                          props={props}
                          planeWidth={planeWidth}
                        />
                        <TimeHandle
                          entry={entry}
                          mode="resize-end"
                          props={props}
                          planeWidth={planeWidth}
                        />
                      </>
                    ) : null}
                    {entry.actions}
                  </Group>
                ) : null}
                {entry.timePreview ? (
                  <Stack>
                    <Text role="status" aria-live="polite">
                      {entry.timePreview.message}
                    </Text>
                    {entry.timePreview.error ? (
                      <Alert>{entry.timePreview.error}</Alert>
                    ) : null}
                    <Group>
                      <Button
                        disabled={!entry.timePreview.valid}
                        onClick={() => props.onTimeApply?.(entry.timePreview!)}
                      >
                        {props.timeLabels?.apply}
                      </Button>
                      <Button variant="subtle" onClick={props.onTimeCancel}>
                        {props.timeLabels?.cancel}
                      </Button>
                    </Group>
                  </Stack>
                ) : null}
              </Card>
            )),
          ])}
          {placement?.active ? (
            <Popover
              fitViewport
              returnFocus
              trapFocus
              opened={placement.chosen}
              onChange={(opened) => {
                if (!opened && placement.chosen) placement.onCancel();
              }}
            >
              <PopoverTarget>
                <Box
                  className="timeline-time-place"
                  style={{
                    left: Math.min(planeWidth - cardWidth, x(placement.start)),
                  }}
                >
                  <Button onClick={placement.onChoose} data-time-place-target>
                    {placement.label}
                  </Button>
                </Box>
              </PopoverTarget>
              <PopoverContent>{placement.content}</PopoverContent>
            </Popover>
          ) : null}
          {!props.groups.some((group) => group.entries.length)
            ? props.empty
            : null}
        </Box>
      </ScrollArea.Autosize>
    </Box>
  );
}
