// SPDX-License-Identifier: AGPL-3.0-or-later

import { TrashIcon } from "@myoxus/icons/react";

import { ActionIcon, Box, Button, Grid, Text, Tooltip } from "@mantine/core";
import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  ganttValueToOffset,
  GANTT_MINIMUM_BAR_WIDTH,
  GANTT_MILESTONE_RADIUS,
  GANTT_ROW_HEIGHT,
  GANTT_AXIS_HEADER_HEIGHT,
} from "./geometry";
import type {
  GanttAxisProjection,
  GanttDependencyView,
  GanttExternalEndpointView,
  GanttMarkerView,
  GanttTaskView,
} from "./gantt-view";

type Endpoint = GanttTaskView | GanttMarkerView | GanttExternalEndpointView;

function endpointBounds(
  axis: GanttAxisProjection,
  object: Endpoint,
  width: number,
) {
  if ("side" in object) {
    const boundary = object.side === "start" ? 0 : width;
    return { left: boundary, right: boundary };
  }
  if ("value" in object) {
    return {
      left: ganttValueToOffset(axis, object.value, width),
      right: ganttValueToOffset(axis, object.end ?? object.value, width),
    };
  }
  const start = ganttValueToOffset(
    axis,
    object.milestone ? (object.start + object.end) / 2 : object.start,
    width,
  );
  return {
    left: start - (object.milestone ? GANTT_MILESTONE_RADIUS : 0),
    right: object.milestone
      ? start + GANTT_MILESTONE_RADIUS
      : Math.max(
          ganttValueToOffset(axis, object.end, width),
          start + (object.preciseRange ? 0 : GANTT_MINIMUM_BAR_WIDTH),
        ),
  };
}

/** Markers span the body rather than owning invented task rows. Their edge
 * meets the real counterpart's row; marker-to-marker edges use the header rail. */
function endpointTops(
  from: Endpoint,
  to: Endpoint,
  offsets: ReadonlyMap<string, number>,
) {
  const fromTop = offsets.get(
    "anchorTaskId" in from ? from.anchorTaskId : from.id,
  );
  const toTop = offsets.get("anchorTaskId" in to ? to.anchorTaskId : to.id);
  return { fromTop: fromTop ?? toTop ?? 0, toTop: toTop ?? fromTop ?? 0 };
}

/**
 * Anchors the overlay edge at the boundaries the reference kind actually
 * couples. `after`/`previous` couple the referenced end to the owner start
 * (finish-to-start); `until` couples the referenced start to the owner end.
 */
function edgePoints(
  axis: GanttAxisProjection,
  dependency: GanttDependencyView,
  from: Endpoint,
  to: Endpoint,
  width: number,
  fromTop: number,
  toTop: number,
  rowHeight: number,
) {
  const { left: fromLeft, right: fromRight } = endpointBounds(
    axis,
    from,
    width,
  );
  const { left: toLeft, right: toRight } = endpointBounds(axis, to, width);
  const fromY = fromTop + rowHeight / 2;
  const toY = toTop + rowHeight / 2;
  if (dependency.kind === "connection" && "sectionId" in from) {
    return {
      fromX: from.milestone ? (fromLeft + fromRight) / 2 : fromRight,
      fromY: fromY + (from.milestone ? GANTT_MILESTONE_RADIUS : 12),
      toX: toLeft,
      toY,
    };
  }
  if (dependency.kind === "until") {
    return { fromX: fromLeft, fromY, toX: toRight, toY };
  }
  return { fromX: fromRight, fromY, toX: toLeft, toY };
}

/**
 * Visual-only dependency overlays. They are edit affordances; the clean
 * View/preview/export renderer keeps Mermaid's own output.
 */
export function GanttDependencies({
  axis,
  dependencies,
  deleteLabel,
  onDelete,
  onReconnect,
  onSelect,
  readonly,
  offsetByTaskId,
  selectedDependencyId,
  endpointsById,
  width,
  rowHeight = GANTT_ROW_HEIGHT,
}: {
  rowHeight?: number;
  axis: GanttAxisProjection;
  dependencies: readonly GanttDependencyView[];
  deleteLabel?: string;
  onDelete: (dependencyId: string) => void;
  onReconnect: (
    dependencyId: string,
    end: "source" | "target",
    taskId: string,
  ) => void;
  onSelect: (dependencyId: string) => void;
  readonly: boolean;
  offsetByTaskId: ReadonlyMap<string, number>;
  selectedDependencyId: string | null;
  endpointsById: ReadonlyMap<string, Endpoint>;
  width: number;
}) {
  const edgesRef = useRef<SVGSVGElement>(null);
  const focusEdge = (dependencyId: string) =>
    edgesRef.current
      ?.querySelector<SVGElement>(
        `[data-testid="${CSS.escape(`gantt-dependency-${dependencyId}`)}"] [role="button"]`,
      )
      ?.focus();
  const handlePointer = (event: ReactPointerEvent, dependencyId: string) => {
    event.stopPropagation();
    (event.currentTarget as SVGElement).focus();
    onSelect(dependencyId);
  };
  const handleKey = (
    event: ReactKeyboardEvent,
    dependencyId: string,
    dependency: GanttDependencyView,
    from: Endpoint,
    to: Endpoint,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      onSelect(dependencyId);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      if (
        !readonly &&
        !dependency.implicit &&
        dependency.edit?.enabled !== false
      )
        onDelete(dependencyId);
      return;
    }
    if (readonly || dependency.implicit || dependency.edit?.enabled === false)
      return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      onReconnect(dependencyId, "source", from.id);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      onReconnect(dependencyId, "target", to.id);
    }
  };
  const selectedDependency = dependencies.find(
    (dependency) => dependency.id === selectedDependencyId,
  );
  const selectedFrom = selectedDependency
    ? endpointsById.get(selectedDependency.fromTaskId)
    : undefined;
  const selectedTo = selectedDependency
    ? endpointsById.get(selectedDependency.toTaskId)
    : undefined;
  const selectedTops =
    selectedFrom && selectedTo
      ? endpointTops(selectedFrom, selectedTo, offsetByTaskId)
      : null;
  const handles =
    selectedDependency &&
    selectedFrom &&
    selectedTo &&
    !readonly &&
    !selectedDependency.implicit &&
    selectedDependency.edit?.enabled !== false &&
    selectedTops
      ? edgePoints(
          axis,
          selectedDependency,
          selectedFrom,
          selectedTo,
          width,
          selectedTops.fromTop,
          selectedTops.toTop,
          rowHeight,
        )
      : null;
  // A marker can meet a bar on the same row and at the same coupled time.
  // Separate only the hit handles vertically; the edge keeps its true bounds.
  const handleSeparation =
    handles &&
    Math.hypot(handles.fromX - handles.toX, handles.fromY - handles.toY) < 16
      ? 8
      : 0;
  const connectionRailX = Math.max(
    0,
    Math.min(
      width,
      ...[...endpointsById.values()]
        .filter(
          (object) => "sectionId" in object && offsetByTaskId.has(object.id),
        )
        .map((object) => endpointBounds(axis, object, width).left),
    ) - 24,
  );
  return (
    <>
      <svg
        ref={edgesRef}
        data-myoxus-ui-role="gantt-dependencies"
        height="100%"
        style={{ insetInlineStart: 0, position: "absolute", top: 0 }}
        width={width}
      >
        {dependencies.map((dependency) => {
          const from = endpointsById.get(dependency.fromTaskId);
          const to = endpointsById.get(dependency.toTaskId);
          if (!from || !to) return null;
          // A collapsed task has no row. Its edges cannot borrow the visible
          // counterpart's offset and manufacture a ghost endpoint.
          if (
            !("value" in from) &&
            !offsetByTaskId.has(
              "anchorTaskId" in from ? from.anchorTaskId : from.id,
            )
          )
            return null;
          if (
            !("value" in to) &&
            !offsetByTaskId.has("anchorTaskId" in to ? to.anchorTaskId : to.id)
          )
            return null;
          const tops = endpointTops(from, to, offsetByTaskId);
          const { fromX, fromY, toX, toY } = edgePoints(
            axis,
            dependency,
            from,
            to,
            width,
            tops.fromTop,
            tops.toTop,
            rowHeight,
          );
          // Leave and enter the coupled bar sides. At equal-time boundaries a
          // dogleg crosses the row gap, never approaches through the target bar.
          const direction = dependency.kind === "until" ? -1 : 1;
          const exitX = fromX + direction * 8;
          const entryX = toX - direction * 24;
          const forward = direction * (entryX - exitX) >= 0;
          const gapY = fromY + (Math.sign(toY - fromY || 1) * rowHeight) / 2;
          // Uncoupled connections leave below the source, cross its row gap
          // and use a rail left of every visible task. Neighbour labels stay
          // unobstructed even when a prerequisite lies below its dependent.
          const railX = Math.min(
            connectionRailX,
            Math.max(0, Math.min(fromX, toX) - 24),
          );
          const path =
            dependency.kind === "connection"
              ? `M ${fromX} ${fromY} V ${tops.fromTop + rowHeight} H ${railX} V ${toY} H ${toX}`
              : forward
                ? `M ${fromX} ${fromY} H ${entryX} V ${toY} H ${toX}`
                : `M ${fromX} ${fromY} H ${exitX} V ${gapY} H ${entryX} V ${toY} H ${toX}`;
          const selected =
            dependency.selected ?? selectedDependencyId === dependency.id;
          return (
            <g
              data-testid={`gantt-dependency-${dependency.id}`}
              data-connection={dependency.kind === "connection"}
              key={dependency.id}
            >
              <path
                aria-label={`${from.label} → ${to.label}`}
                className="myoxus-gantt-dependency-hit"
                d={path}
                onKeyDown={(event) =>
                  handleKey(event, dependency.id, dependency, from, to)
                }
                onPointerDown={(event) => handlePointer(event, dependency.id)}
                role="button"
                tabIndex={0}
              />
              <path
                className="myoxus-gantt-dependency"
                d={path}
                data-selected={selected}
                strokeDasharray={
                  dependency.implicit || dependency.preview ? "4 4" : undefined
                }
              />
              <path
                className="myoxus-gantt-dependency-arrow"
                d={`M ${toX} ${toY} l ${-direction * 8} -4 v 8 z`}
              />
            </g>
          );
        })}
      </svg>
      {/* Only the active handles overlay bars; unselected edge hit paths stay
        below them. Keyboard reconnection remains on the focusable edge. */}
      {handles && selectedDependency && deleteLabel ? (
        <ActionIcon
          aria-label={deleteLabel}
          data-testid={`gantt-dependency-delete-${selectedDependency.id}`}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(selectedDependency.id);
          }}
          style={{
            position: "absolute",
            insetInlineStart:
              selectedDependency.kind === "connection"
                ? connectionRailX
                : (handles.fromX + handles.toX) / 2,
            insetBlockStart: (handles.fromY + handles.toY) / 2,
          }}
        >
          <TrashIcon />
        </ActionIcon>
      ) : null}
      {handles && selectedDependency && selectedFrom && selectedTo ? (
        <svg
          data-myoxus-ui-role="gantt-dependency-handles"
          aria-hidden="true"
          height="100%"
          style={{ insetInlineStart: 0, position: "absolute", top: 0 }}
          width={width}
        >
          {handleSeparation ? (
            <path
              className="myoxus-gantt-dependency"
              d={`M ${handles.fromX} ${handles.fromY - handleSeparation} V ${handles.fromY} M ${handles.toX} ${handles.toY} V ${handles.toY + handleSeparation}`}
              data-selected
            />
          ) : null}
          <circle
            className="myoxus-gantt-dependency-endpoint"
            cx={handles.fromX}
            cy={handles.fromY - handleSeparation}
            data-testid={`gantt-dependency-source-${selectedDependency.id}`}
            onPointerDown={(event) => {
              event.stopPropagation();
              focusEdge(selectedDependency.id);
              onReconnect(selectedDependency.id, "source", selectedFrom.id);
            }}
            r={6}
          />
          <circle
            className="myoxus-gantt-dependency-endpoint"
            cx={handles.toX}
            cy={handles.toY + handleSeparation}
            data-testid={`gantt-dependency-target-${selectedDependency.id}`}
            onPointerDown={(event) => {
              event.stopPropagation();
              focusEdge(selectedDependency.id);
              onReconnect(selectedDependency.id, "target", selectedTo.id);
            }}
            r={6}
          />
        </svg>
      ) : null}
    </>
  );
}

/** An outside-window caption owns a separate geometry rail. It must not
 * overlap a task hit area, even when the task starts at the window boundary.
 * Several external relations share the actual row without invented task rows.
 */
export function GanttEndpointRail({
  endpoints,
  offsetByTaskId,
  onOpen,
  width,
  height,
  rowHeight = GANTT_ROW_HEIGHT,
  headerHeight = GANTT_AXIS_HEADER_HEIGHT,
}: {
  rowHeight?: number;
  headerHeight?: number;
  endpoints: readonly GanttExternalEndpointView[];
  offsetByTaskId: ReadonlyMap<string, number>;
  onOpen?: (endpointId: string) => void;
  width: number;
  height: number;
}) {
  const byAnchor = new Map<string, GanttExternalEndpointView[]>();
  for (const endpoint of endpoints) {
    const siblings = byAnchor.get(endpoint.anchorTaskId) ?? [];
    siblings.push(endpoint);
    byAnchor.set(endpoint.anchorTaskId, siblings);
  }
  return (
    <Box
      style={{
        position: "relative",
        width,
        minWidth: width,
        minHeight: height,
      }}
    >
      {[...byAnchor].map(([anchorId, siblings]) => {
        const top = offsetByTaskId.get(anchorId);
        if (top === undefined) return null;
        return (
          <Box
            key={anchorId}
            style={{
              position: "absolute",
              top: top + headerHeight,
              width,
              height: rowHeight,
            }}
          >
            <Grid columns={siblings.length} gap={0}>
              {siblings.map((endpoint) => (
                <Grid.Col key={endpoint.id} span={1}>
                  <Tooltip label={endpoint.label}>
                    <Button
                      fullWidth
                      variant="subtle"
                      disabled={!endpoint.available}
                      data-testid={`gantt-external-endpoint-${endpoint.id}`}
                      onClick={() => onOpen?.(endpoint.id)}
                    >
                      <Text truncate>{endpoint.label}</Text>
                    </Button>
                  </Tooltip>
                </Grid.Col>
              ))}
            </Grid>
          </Box>
        );
      })}
    </Box>
  );
}
