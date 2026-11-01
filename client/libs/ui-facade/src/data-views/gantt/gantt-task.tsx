// SPDX-License-Identifier: AGPL-3.0-or-later

import { Box, Text, Tooltip } from "@mantine/core";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  ganttSnapValue,
  ganttValueToOffset,
  GANTT_MINIMUM_BAR_WIDTH,
  GANTT_ROW_HEIGHT,
} from "./geometry";
import type {
  GanttAxisProjection,
  GanttMoveIntent,
  GanttTaskView,
} from "./gantt-view";

const DRAG_THRESHOLD = 4;

type DragState = {
  mode: "move" | "resize-start" | "resize-end";
  pointerStart: number | null;
  pointerY?: number;
  moved: boolean;
  originalStart: number;
  originalEnd: number;
  delta: number;
  targetLaneId?: string;
  step: number;
  valuePerPixel?: number;
} | null;

/** One task bar or milestone diamond with direct move/resize manipulation. */
export function GanttTaskBar({
  activation = { enter: "rename", doubleClick: "rename" },
  axis,
  onCancel,
  onBegin,
  onLaneStep,
  onOpen,
  onDelete,
  onConnectStart,
  connectMode = false,
  connectLabel = "connect",
  connecting,
  onConnectTarget,
  onFocusMove,
  onPreview,
  onRename,
  onSelect,
  onCommitMove,
  readonly,
  rowTop,
  rowHeight = GANTT_ROW_HEIGHT,
  task,
  width,
}: {
  activation?: { enter: "open" | "rename"; doubleClick: "open" | "rename" };
  axis: GanttAxisProjection;
  onCancel: () => void;
  onBegin?: (intent: GanttMoveIntent) => void;
  onLaneStep?: (
    sectionId: string,
    direction: "up" | "down",
  ) => string | undefined;
  onOpen: (taskId: string) => void;
  onDelete: (taskId: string) => void;
  onConnectStart: (taskId: string) => void;
  connectMode: boolean;
  connectLabel?: string;
  connecting: boolean;
  onConnectTarget: (taskId: string) => void;
  onFocusMove: (
    taskId: string,
    direction: "up" | "down" | "left" | "right",
  ) => void;
  onPreview: (intent: GanttMoveIntent | null) => void;
  onRename: (taskId: string) => void;
  onSelect: (taskId: string) => void;
  onCommitMove: (intent: GanttMoveIntent) => void;
  readonly: boolean;
  rowTop: number;
  rowHeight?: number;
  task: GanttTaskView;
  width: number;
}) {
  const [drag, setDrag] = useState<DragState>(null);
  // Pointer events can arrive faster than React commits state, so the live
  // drag is mirrored in a ref and every commit reads that authoritative value.
  const dragRef = useRef<DragState>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLParagraphElement>(null);
  const [labelExtent, setLabelExtent] = useState(0);
  useLayoutEffect(() => {
    if (!task.preciseRange || task.milestone) return;
    const label = labelRef.current;
    if (!label) return;
    // A DOM range measures the rendered glyphs, including RTL/CJK and the
    // effective server font, rather than the constrained label box.
    const measure = () => {
      const range = document.createRange();
      range.selectNodeContents(label);
      const padding =
        parseFloat(getComputedStyle(label).paddingInlineStart) || 0;
      setLabelExtent(range.getBoundingClientRect().width + 2 * padding);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(label);
    document.fonts.addEventListener("loadingdone", measure);
    measure();
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [task.label, task.preciseRange, task.milestone]);
  const previewStart = drag
    ? drag.mode === "resize-start"
      ? drag.originalStart + drag.delta
      : drag.originalStart + (drag.mode === "move" ? drag.delta : 0)
    : task.start;
  const previewEnd = drag
    ? drag.mode === "resize-end"
      ? drag.originalEnd + drag.delta
      : drag.originalEnd + (drag.mode === "move" ? drag.delta : 0)
    : (task.end ?? task.start);
  const previewLeft = ganttValueToOffset(
    axis,
    task.milestone ? (previewStart + previewEnd) / 2 : previewStart,
    width,
  );
  const actualWidth = Math.max(
    0,
    ganttValueToOffset(axis, previewEnd, width) - previewLeft,
  );
  const outsideLabel = Boolean(task.preciseRange && actualWidth < labelExtent);
  const showConnect =
    !readonly && (!task.preciseRange || task.selected) && task.connect?.enabled;
  const previewWidth = task.milestone
    ? GANTT_MINIMUM_BAR_WIDTH
    : Math.max(
        GANTT_MINIMUM_BAR_WIDTH,
        ganttValueToOffset(axis, previewEnd, width) - previewLeft,
      );

  const selectLabel = (event: ReactPointerEvent) => {
    // Capturing on the bar retargets pointerup/click to its body and would
    // turn a label double click into Open. Labels select without move capture.
    event.stopPropagation();
    barRef.current?.focus();
    onSelect(task.id);
  };
  const renameLabel = (event: MouseEvent) => {
    event.stopPropagation();
    if (!readonly) onRename(task.id);
  };

  const stepFor = (mode: "move" | "resize-start" | "resize-end") =>
    task.steps?.[
      mode === "move" ? "move" : mode === "resize-start" ? "start" : "end"
    ] ?? axis.step;

  const beginDrag = (
    event: ReactPointerEvent,
    mode: "move" | "resize-start" | "resize-end",
  ) => {
    if (readonly) return;
    if (mode === "move" && task.move?.enabled === false) return;
    if (
      mode === "resize-start" &&
      task.resize?.edges?.includes("start") === false
    )
      return;
    if (mode === "resize-end" && task.resize?.edges?.includes("end") === false)
      return;
    event.preventDefault();
    event.stopPropagation();
    // Capture on the bar, not the grabbed child: move/up handlers live on the
    // bar, so capturing the resize handle would retarget them and the drag
    // would never preview or commit.
    const captureTarget =
      barRef.current ?? (event.currentTarget as HTMLElement);
    // preventDefault keeps focus on the previous label/control. The bar owns
    // Escape/Enter for this pointer draft as well as pointer capture.
    captureTarget.focus();
    try {
      captureTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* continue without capture */
    }
    const started: DragState = {
      delta: 0,
      moved: false,
      mode,
      originalEnd: task.end ?? task.start,
      originalStart: task.start,
      pointerStart: event.clientX,
      pointerY: event.clientY,
      step: stepFor(mode),
      valuePerPixel: (axis.end - axis.start) / Math.max(1, width),
    };
    onBegin?.({
      taskId: task.id,
      start: started.originalStart,
      end: started.originalEnd,
      mode,
    });
    dragRef.current = started;
    setDrag(started);
  };
  const moveDrag = (event: ReactPointerEvent) => {
    if (!drag || drag.pointerStart === null) return;
    const rawDelta = event.clientX - drag.pointerStart;
    const rawVertical = event.clientY - (drag.pointerY ?? event.clientY);
    if (!drag.moved && Math.hypot(rawDelta, rawVertical) < DRAG_THRESHOLD)
      return;
    const valueDelta =
      ganttSnapValue(
        rawDelta *
          (drag.valuePerPixel ?? (axis.end - axis.start) / Math.max(1, width)),
        drag.step,
      ) || 0;
    const base = dragRef.current ?? drag!;
    const next = {
      ...base,
      delta: valueDelta,
      moved: true,
      pointerY: event.clientY,
    };
    dragRef.current = next;
    setDrag(next);
    onPreview({
      end:
        next.mode === "resize-end"
          ? next.originalEnd + valueDelta
          : next.originalEnd + (next.mode === "move" ? valueDelta : 0),
      mode: next.mode,
      pointerY: next.pointerY,
      start:
        next.mode === "resize-start"
          ? next.originalStart + valueDelta
          : next.originalStart + (next.mode === "move" ? valueDelta : 0),
      taskId: task.id,
    });
  };
  const endDrag = (event?: ReactPointerEvent) => {
    const live = dragRef.current ?? drag;
    if (!live) return;
    dragRef.current = null;
    setDrag(null);
    try {
      if (event) barRef.current?.releasePointerCapture?.(event.pointerId);
    } catch {
      /* already released */
    }
    onPreview(null);
    // A pointer click selects only. Without a real drag, lane hit-testing can
    // turn the click position into an unintended source reorder.
    if (!live.moved) return;
    onCommitMove({
      end:
        live.mode === "resize-end"
          ? live.originalEnd + live.delta
          : live.originalEnd + (live.mode === "move" ? live.delta : 0),
      mode: live.mode,
      pointerY: live.pointerY,
      start:
        live.mode === "resize-start"
          ? live.originalStart + live.delta
          : live.originalStart + (live.mode === "move" ? live.delta : 0),
      taskId: task.id,
      targetLaneId: live.targetLaneId,
    });
  };
  // A cancelled or lost pointer interaction discards the draft without commit.
  const abortDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDrag(null);
    onPreview(null);
    onCancel();
  };
  useEffect(() => {
    abortDrag();
    // Permission, identity and connection-mode changes revoke the draft.
    // Concurrent source updates leave its opening geometry/revisions intact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readonly, task.id, connecting, connectMode]);
  const handleKey = (event: KeyboardEvent) => {
    if (
      !readonly &&
      (connecting || connectMode) &&
      (event.key === "Enter" || event.key === " ")
    ) {
      event.preventDefault();
      onConnectTarget(task.id);
      return;
    }
    if (event.key === "Escape" && dragRef.current) {
      event.preventDefault();
      abortDrag();
      return;
    }
    if (event.key === "Enter" && dragRef.current) {
      event.preventDefault();
      endDrag();
      return;
    }
    // Shift+Enter opens the anchored schedule surface; plain Enter, F2 and a
    // double click all start the same inline label command once editing is
    // actually allowed. Readonly keeps navigation/selection only.
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      onOpen(task.id);
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (event.key === "Enter" && activation.enter === "open") onOpen(task.id);
      else if (!readonly && event.key === "Enter") onRename(task.id);
      else onSelect(task.id);
      return;
    }
    if (
      (event.key === "F2" ||
        event.key === "Delete" ||
        event.key === "Backspace") &&
      readonly
    ) {
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      onRename(task.id);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onDelete(task.id);
      return;
    }
    const direction =
      event.key === "ArrowUp"
        ? ("up" as const)
        : event.key === "ArrowDown"
          ? ("down" as const)
          : event.key === "ArrowLeft"
            ? ("left" as const)
            : event.key === "ArrowRight"
              ? ("right" as const)
              : null;
    // Alt+Arrow moves the bar by one snap step, Alt+Shift+Arrow resizes the
    // corresponding edge; plain arrows keep navigating the rows.
    if (direction && event.altKey && !readonly) {
      if (
        (direction === "up" || direction === "down") &&
        task.laneMove?.enabled
      ) {
        event.preventDefault();
        const live = dragRef.current;
        const targetLaneId = onLaneStep?.(
          live?.targetLaneId ?? task.sectionId,
          direction,
        );
        if (!targetLaneId) return;
        if (!live)
          onBegin?.({
            taskId: task.id,
            start: task.start,
            end: task.end,
            mode: "move",
          });
        const next: NonNullable<DragState> = {
          mode: "move",
          moved: true,
          pointerStart: null,
          originalStart: live?.originalStart ?? task.start,
          originalEnd: live?.originalEnd ?? task.end,
          delta: live?.mode === "move" ? live.delta : 0,
          targetLaneId,
          step: live?.step ?? stepFor("move"),
        };
        dragRef.current = next;
        setDrag(next);
        onPreview({
          taskId: task.id,
          start: next.originalStart + next.delta,
          end: next.originalEnd + next.delta,
          mode: "move",
          targetLaneId,
        });
        return;
      }
      if (direction === "left" || direction === "right") {
        event.preventDefault();
        onSelect(task.id);
        const sign = direction === "left" ? -1 : 1;
        const mode = event.shiftKey
          ? direction === "left"
            ? "resize-start"
            : "resize-end"
          : "move";
        if (mode === "move" && task.move?.enabled === false) return;
        if (
          mode !== "move" &&
          (task.resize?.enabled === false ||
            task.resize?.edges?.includes(
              mode === "resize-start" ? "start" : "end",
            ) === false)
        )
          return;
        const live = dragRef.current;
        if (!live)
          onBegin?.({
            taskId: task.id,
            start: task.start,
            end: task.end,
            mode,
          });
        const next: NonNullable<DragState> = {
          mode,
          moved: true,
          originalStart: live?.originalStart ?? task.start,
          originalEnd: live?.originalEnd ?? task.end,
          targetLaneId: live?.targetLaneId,
          pointerStart: null,
          pointerY: undefined,
          delta:
            (live?.mode === mode ? live.delta : 0) +
            sign * (live?.mode === mode ? live.step : stepFor(mode)),
          step: live?.mode === mode ? live.step : stepFor(mode),
        };
        dragRef.current = next;
        setDrag(next);
        onPreview({
          taskId: task.id,
          mode,
          start: next.originalStart + (mode !== "resize-end" ? next.delta : 0),
          end: next.originalEnd + (mode !== "resize-start" ? next.delta : 0),
          targetLaneId: next.targetLaneId,
        });
      }
      return;
    }
    if (direction) {
      event.preventDefault();
      onFocusMove(task.id, direction);
    }
  };

  if (task.milestone) {
    return (
      <Box
        aria-label={task.label}
        aria-description={task.description}
        aria-busy={task.pending || undefined}
        className="myoxus-gantt-milestone"
        data-precise-range={task.preciseRange}
        data-readonly={readonly}
        data-selected={task.selected}
        data-testid={`gantt-bar-${task.id}`}
        onDoubleClick={() =>
          activation.doubleClick === "open"
            ? onOpen(task.id)
            : !readonly && onRename(task.id)
        }
        onPointerDown={(event) => {
          (event.currentTarget as HTMLElement).focus?.();
          onSelect(task.id);
          if (connecting || connectMode) {
            event.stopPropagation();
            onConnectTarget(task.id);
            return;
          }
          beginDrag(event, "move");
        }}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={abortDrag}
        onLostPointerCapture={abortDrag}
        ref={barRef}
        onKeyDown={handleKey}
        role="button"
        style={{
          insetBlockStart: rowTop + rowHeight / 2,
          insetInlineStart: previewLeft - GANTT_MINIMUM_BAR_WIDTH / 2,
        }}
        tabIndex={0}
      >
        <Box
          aria-hidden="true"
          className="myoxus-gantt-bar"
          data-milestone
          data-readonly={readonly}
          data-selected={task.selected}
          data-status={(task.statuses ?? []).join(" ")}
          style={{
            blockSize: GANTT_MINIMUM_BAR_WIDTH,
            inlineSize: GANTT_MINIMUM_BAR_WIDTH,
            insetBlockStart: 0,
            position: "relative",
          }}
        />
        {!readonly &&
        task.preciseRange &&
        task.selected &&
        task.connect?.enabled ? (
          <Box
            component="button"
            type="button"
            className="myoxus-gantt-connect-handle"
            style={{
              insetInlineStart: GANTT_MINIMUM_BAR_WIDTH / 2 - 5,
              insetInlineEnd: "auto",
              insetBlockStart: 0,
            }}
            aria-label={connectLabel}
            data-testid={`gantt-connect-${task.id}`}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onConnectStart(task.id);
            }}
          />
        ) : null}
        <Text
          className="myoxus-gantt-milestone-label"
          onDoubleClick={renameLabel}
          onPointerDown={selectLabel}
          size="xs"
          textWrap="nowrap"
        >
          {task.label}
        </Text>
      </Box>
    );
  }

  return (
    <Tooltip label={task.description ?? task.label}>
      <Box
        aria-label={task.label}
        aria-description={task.description}
        aria-busy={task.pending || undefined}
        className="myoxus-gantt-bar"
        data-editable={!readonly}
        data-precise-range={task.preciseRange}
        data-milestone={task.milestone}
        data-readonly={readonly}
        data-selected={task.selected}
        data-status={(task.statuses ?? []).join(" ")}
        data-testid={`gantt-bar-${task.id}`}
        onDoubleClick={() =>
          activation.doubleClick === "open"
            ? onOpen(task.id)
            : !readonly && onRename(task.id)
        }
        onKeyDown={handleKey}
        onPointerDown={(event) => {
          (event.currentTarget as HTMLElement).focus?.();
          onSelect(task.id);
          if (connecting || connectMode) {
            event.stopPropagation();
            onConnectTarget(task.id);
            return;
          }
          beginDrag(event, "move");
        }}
        onPointerCancel={abortDrag}
        onLostPointerCapture={abortDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        ref={barRef}
        role="button"
        style={{
          insetBlockStart: rowTop + rowHeight / 2,
          insetInlineStart: previewLeft,
          inlineSize: previewWidth,
          position: "absolute",
        }}
        tabIndex={0}
      >
        {task.preciseRange ? (
          <svg
            aria-hidden="true"
            className="myoxus-gantt-range-shape"
            width={actualWidth}
            height={24}
            data-selected={task.selected}
          >
            <rect width={actualWidth} height={24} />
          </svg>
        ) : null}
        <Text
          ref={labelRef}
          className="myoxus-gantt-bar-label"
          data-outside={outsideLabel}
          onDoubleClick={renameLabel}
          onPointerDown={selectLabel}
          size="xs"
          textWrap="nowrap"
          style={
            task.preciseRange
              ? {
                  // The outside label must also clear the precise endpoint's
                  // resize and connect controls, without stretching the range.
                  insetInlineStart: outsideLabel
                    ? actualWidth + (showConnect ? 28 : 0)
                    : 0,
                  inlineSize: outsideLabel ? undefined : actualWidth,
                }
              : undefined
          }
        >
          {task.label}
        </Text>
        {showConnect && (
          <Box
            component="button"
            type="button"
            aria-label={connectLabel}
            className="myoxus-gantt-connect-handle"
            style={
              task.preciseRange
                ? {
                    // Precise resize extends past the real endpoint. Keep
                    // the connect nub outside that hit area, as for bars
                    // whose container already matches their visible span.
                    insetInlineStart: actualWidth + 14,
                    insetInlineEnd: "auto",
                  }
                : undefined
            }
            data-testid={`gantt-connect-${task.id}`}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onConnectStart(task.id);
            }}
          />
        )}
        {!readonly &&
          (!task.preciseRange || task.selected) &&
          task.resize?.enabled && (
            <>
              {task.resize.edges?.includes("start") !== false && (
                <Box
                  className="myoxus-gantt-resize-handle"
                  data-edge="start"
                  onPointerDown={(event) => beginDrag(event, "resize-start")}
                />
              )}
              {task.resize.edges?.includes("end") !== false && (
                <Box
                  className="myoxus-gantt-resize-handle"
                  data-edge="end"
                  style={
                    task.preciseRange
                      ? {
                          insetInlineStart: actualWidth,
                          insetInlineEnd: "auto",
                        }
                      : undefined
                  }
                  onPointerDown={(event) => beginDrag(event, "resize-end")}
                />
              )}
            </>
          )}
      </Box>
    </Tooltip>
  );
}
