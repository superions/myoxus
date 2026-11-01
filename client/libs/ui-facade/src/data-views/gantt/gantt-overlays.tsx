// SPDX-License-Identifier: AGPL-3.0-or-later

import { Box, Text, Tooltip } from "@mantine/core";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  ganttOffsetToValue,
  ganttSnapValue,
  ganttValueToOffset,
} from "./geometry";
import type {
  GanttAxisProjection,
  GanttCommentAnchorView,
  GanttMarkerIntent,
  GanttMarkerView,
} from "./gantt-view";

const DRAG_THRESHOLD = 4;

/**
 * Vertical `vert` markers plus the anchored popover host slot. Markers are real
 * objects: they own direct move by pointer or keyboard, inline rename and their
 * own delete, sharing snap/preview/apply/cancel semantics with task bars.
 */
export function GanttOverlays({
  axis,
  connecting,
  commentAnchors,
  height,
  markers,
  offsetById,
  onOpenComment,
  onCommitMarker,
  onConnectTarget,
  onDeleteMarker,
  onOpenMarker,
  onPreviewMarker,
  onRenameMarker,
  onSelectMarker,
  popover,
  readonly,
  width,
}: {
  axis: GanttAxisProjection;
  connecting: boolean;
  commentAnchors: readonly GanttCommentAnchorView[];
  height: number;
  markers: readonly GanttMarkerView[];
  offsetById: ReadonlyMap<string, number>;
  onOpenComment?: (anchor: GanttCommentAnchorView) => void;
  onCommitMarker?: (intent: GanttMarkerIntent) => void;
  onConnectTarget: (markerId: string) => void;
  onDeleteMarker?: (markerId: string) => void;
  onOpenMarker?: (markerId: string) => void;
  onPreviewMarker?: (intent: GanttMarkerIntent | null) => void;
  onRenameMarker?: (markerId: string) => void;
  onSelectMarker?: (markerId: string | null) => void;
  popover: ReactNode;
  readonly: boolean;
  width: number;
}) {
  return (
    <>
      {markers.map((marker) => (
        <GanttMarker
          axis={axis}
          connecting={connecting}
          height={height}
          key={marker.id}
          marker={marker}
          onCommitMarker={onCommitMarker}
          onConnectTarget={onConnectTarget}
          onDeleteMarker={onDeleteMarker}
          onOpenMarker={onOpenMarker}
          onPreviewMarker={onPreviewMarker}
          onRenameMarker={onRenameMarker}
          onSelectMarker={onSelectMarker}
          readonly={readonly}
          width={width}
        />
      ))}
      {commentAnchors.map((anchor) => (
        <Tooltip key={anchor.id} label={anchor.text} withArrow>
          <Box
            component="button"
            data-myoxus-ui-role="gantt-comment-marker"
            data-testid={`gantt-comment-${anchor.id}`}
            onClick={() => onOpenComment?.(anchor)}
            style={{
              insetBlockStart: (offsetById.get(anchor.objectId) ?? 0) + 8,
              insetInlineEnd: 8,
              position: "absolute",
              zIndex: 5,
            }}
            type="button"
          >
            <Text span fz="xs" fw={700}>
              {anchor.count}
            </Text>
          </Box>
        </Tooltip>
      ))}
      {popover}
    </>
  );
}

type MarkerDrag = {
  pointerStart: number | null;
  original: number;
  delta: number;
};

function GanttMarker({
  axis,
  connecting,
  height,
  marker,
  onCommitMarker,
  onConnectTarget,
  onDeleteMarker,
  onOpenMarker,
  onPreviewMarker,
  onRenameMarker,
  onSelectMarker,
  readonly,
  width,
}: {
  axis: GanttAxisProjection;
  connecting: boolean;
  height: number;
  marker: GanttMarkerView;
  onCommitMarker?: (intent: GanttMarkerIntent) => void;
  onConnectTarget: (markerId: string) => void;
  onDeleteMarker?: (markerId: string) => void;
  onOpenMarker?: (markerId: string) => void;
  onPreviewMarker?: (intent: GanttMarkerIntent | null) => void;
  onRenameMarker?: (markerId: string) => void;
  onSelectMarker?: (markerId: string | null) => void;
  readonly: boolean;
  width: number;
}) {
  const [drag, setDrag] = useState<MarkerDrag | null>(null);
  const dragRef = useRef<MarkerDrag | null>(null);
  const editable = !readonly && (marker.move?.enabled ?? false);
  const value = drag ? drag.original + drag.delta : marker.value;
  const offset = ganttValueToOffset(axis, value, width);
  const flip = offset > width * 0.72;

  // Convert the client-space pointer delta through the axis scale with the
  // same origin-independent trick the bars use, so later moves do not feed the
  // marker's rendered position back into the calculation and overshoot.
  const deltaFor = (clientX: number, start: MarkerDrag) => {
    const rawDelta = clientX - (start.pointerStart ?? clientX);
    return (
      ganttSnapValue(
        ganttOffsetToValue(axis, rawDelta + width / 2, width) -
          ganttOffsetToValue(axis, width / 2, width),
        axis.step,
      ) || 0
    );
  };

  const begin = (event: ReactPointerEvent) => {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).focus();
    onSelectMarker?.(marker.id);
    if (!editable) return;
    if (connecting) {
      onConnectTarget(marker.id);
      return;
    }
    try {
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    } catch {
      /* best effort */
    }
    const started: MarkerDrag = {
      delta: 0,
      original: marker.value,
      pointerStart: event.clientX,
    };
    dragRef.current = started;
    setDrag(started);
  };
  const move = (event: ReactPointerEvent) => {
    const start = dragRef.current;
    if (!start || start.pointerStart === null) return;
    const raw = event.clientX - start.pointerStart;
    if (!start.delta && Math.abs(raw) < DRAG_THRESHOLD) return;
    const next = { ...start, delta: deltaFor(event.clientX, start) };
    dragRef.current = next;
    setDrag(next);
    onPreviewMarker?.({
      markerId: marker.id,
      mode: "move",
      value: next.original + next.delta,
    });
  };
  const end = (event?: ReactPointerEvent) => {
    const start = dragRef.current ?? drag;
    if (!start) return;
    dragRef.current = null;
    setDrag(null);
    try {
      if (event)
        (event.currentTarget as HTMLElement).releasePointerCapture?.(
          event.pointerId,
        );
    } catch {
      /* already released */
    }
    onPreviewMarker?.(null);
    // Selection clicks and a move returned to its origin are not conversions.
    if (start.delta === 0) return;
    onCommitMarker?.({
      markerId: marker.id,
      mode: "move",
      value: start.original + start.delta,
    });
  };
  const cancel = () => {
    dragRef.current = null;
    setDrag(null);
    onPreviewMarker?.(null);
  };
  useEffect(() => {
    if (dragRef.current) cancel();
    // Source, permission and connection-mode changes revoke the move draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, marker.value, marker.end, connecting]);
  const handleKey = (event: ReactKeyboardEvent) => {
    if (
      editable &&
      connecting &&
      (event.key === "Enter" || event.key === " ")
    ) {
      event.preventDefault();
      event.stopPropagation();
      onConnectTarget(marker.id);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (!editable) return;
    if (event.key === "Enter" && dragRef.current) {
      event.preventDefault();
      end();
      return;
    }
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      onOpenMarker?.(marker.id);
      return;
    }
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      onRenameMarker?.(marker.id);
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      onSelectMarker?.(marker.id);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onDeleteMarker?.(marker.id);
      return;
    }
    if (!editable) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = axis.step * (event.key === "ArrowLeft" ? -1 : 1);
      const next = {
        original: marker.value,
        pointerStart: null,
        delta: (dragRef.current?.delta ?? 0) + step,
      };
      dragRef.current = next;
      setDrag(next);
      onPreviewMarker?.({
        markerId: marker.id,
        mode: "move",
        value: marker.value + next.delta,
      });
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  if (!editable) {
    // View/readonly markers are a static projection, not a focusable control.
    return (
      <Box
        className="myoxus-gantt-marker"
        data-editable={false}
        data-readonly={readonly}
        data-testid={`gantt-marker-${marker.id}`}
        style={{
          insetBlockStart: 0,
          insetInlineStart: offset,
          minHeight: height,
          position: "absolute",
        }}
      >
        <Text className="myoxus-gantt-marker-label" size="xs" textWrap="nowrap">
          {marker.label}
        </Text>
      </Box>
    );
  }
  return (
    <Box
      className="myoxus-gantt-marker"
      data-editable={editable}
      data-readonly={readonly}
      data-selected={marker.selected}
      data-testid={`gantt-marker-${marker.id}`}
      onDoubleClick={() => onRenameMarker?.(marker.id)}
      onKeyDown={handleKey}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      role="button"
      style={{
        insetBlockStart: 0,
        insetInlineStart: offset,
        minHeight: height,
        position: "absolute",
        zIndex: marker.selected ? 4 : 1,
      }}
      tabIndex={0}
    >
      <Text
        className="myoxus-gantt-marker-label"
        size="xs"
        textWrap="nowrap"
        style={
          flip
            ? {
                insetInlineEnd: 0,
                insetInlineStart: "auto",
                transform: "translateX(-2px)",
              }
            : undefined
        }
      >
        {marker.label}
      </Text>
    </Box>
  );
}
