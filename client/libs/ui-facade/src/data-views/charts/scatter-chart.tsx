// SPDX-License-Identifier: AGPL-3.0-or-later

import { TextInput } from "@mantine/core";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart as RechartsScatterChart,
  usePlotArea,
  XAxis,
  YAxis,
} from "recharts";

import { DataChartShell } from "./chart-shell";

export type DataScatterPoint = {
  readonly accessibleLabel?: string;
  readonly badge?: string;
  readonly color?: string;
  readonly decoration?: ReactNode;
  readonly displayLabel?: string;
  readonly id: string;
  readonly label: string;
  readonly labelStyle?: {
    readonly color?: string;
    readonly fontSize?: number;
  };
  readonly labelPadding?: number;
  readonly labelOffsetX?: number;
  readonly labelOffsetY?: number;
  readonly renderedLabel?: ReactNode;
  readonly radius?: number;
  readonly strokeColor?: string;
  readonly strokeWidth?: number;
  readonly x: number;
  readonly y: number;
};

export type DataScatterReferenceArea = {
  readonly fill: string;
  readonly id: string;
  readonly label?: string;
  readonly x1: number;
  readonly x2: number;
  readonly y1: number;
  readonly y2: number;
};

export type DataScatterReferenceLine = {
  readonly id: string;
  readonly label?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly x?: number;
  readonly y?: number;
};

export type DataScatterReferenceLabel = {
  readonly anchor?: "end" | "middle" | "start";
  readonly decoration?: ReactNode;
  readonly displayLabel?: string;
  readonly id: string;
  readonly label: string;
  readonly labelStyle?: { readonly fontSize?: number };
  readonly renderedLabel?: ReactNode;
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly x: number;
  readonly y: number;
};

export type DataScatterMove = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
};

export type DataScatterChartProps = {
  readonly ariaLabel: string;
  readonly emptyLabel: string;
  readonly emptyAction?: ReactNode;
  readonly externalBorderWidth?: number;
  readonly height?: number;
  readonly onCoordinateEditor?: (id: string) => void;
  readonly onLabelEditor?: (id: string) => void;
  readonly onMoveCancel?: (id: string) => void;
  readonly onMoveCommit?: (move: DataScatterMove) => void;
  readonly onMovePreview?: (move: DataScatterMove | null) => void;
  readonly onReferenceLabelApply?: (
    id: string,
    label: string,
  ) => boolean | void;
  readonly onReorderPoint?: (id: string, direction: -1 | 1) => void;
  readonly onReorderPreview?: (id: string, direction: -1 | 1 | null) => void;
  readonly onSelect?: (id: string) => void;
  readonly points: ReadonlyArray<DataScatterPoint>;
  readonly plotPadding?: number;
  readonly referenceAreas?: ReadonlyArray<DataScatterReferenceArea>;
  readonly referenceLines?: ReadonlyArray<DataScatterReferenceLine>;
  readonly referenceLabels?: ReadonlyArray<DataScatterReferenceLabel>;
  readonly selectedId?: string;
  readonly summary?: ReactNode;
  readonly xAxisEndLabel?: string;
  readonly xAxisStartLabel?: string;
  readonly yAxisEndLabel?: string;
  readonly yAxisStartLabel?: string;
  readonly width?: number | `${number}%`;
};

function DataScatterEditableLabel({
  cx,
  cy,
  editing,
  label,
  onApply,
  onEdit,
}: {
  readonly cx: number;
  readonly cy: number;
  readonly editing: boolean;
  readonly label: DataScatterReferenceLabel;
  readonly onApply: (value: string) => void;
  readonly onEdit?: () => void;
}) {
  const [draft, setDraft] = useState(label.label);
  const textRef = useRef<SVGTextElement | null>(null);
  const wasEditingRef = useRef(editing);
  useEffect(() => setDraft(label.label), [label.label]);
  useEffect(() => {
    if (wasEditingRef.current && !editing) {
      textRef.current?.focus({ preventScroll: true });
    }
    wasEditingRef.current = editing;
  }, [editing]);
  if (editing) {
    const editorWidth = 160;
    const editorHeight = 44;
    const editorX =
      label.anchor === "start"
        ? cx
        : label.anchor === "end"
          ? cx - editorWidth
          : cx - editorWidth / 2;
    const editorY = label.y > 0.5 ? cy : cy - editorHeight;
    return (
      <foreignObject
        height={editorHeight}
        width={editorWidth}
        x={editorX}
        y={editorY}
      >
        <TextInput
          aria-label={label.label}
          autoFocus
          onBlur={() => onApply(draft)}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              onApply(event.key === "Enter" ? draft : label.label);
            }
          }}
          value={draft}
          onPointerDown={(event) => event.stopPropagation()}
        />
      </foreignObject>
    );
  }
  return (
    <g>
      <text
        aria-label={label.label}
        data-scatter-reference-label-id={label.id}
        dx={label.offsetX}
        dy={label.offsetY}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onEdit?.();
        }}
        onKeyDown={(event) => {
          if (event.key === "F2" || event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            onEdit?.();
          }
        }}
        role={onEdit ? "button" : undefined}
        fontSize={label.labelStyle?.fontSize}
        ref={textRef}
        tabIndex={onEdit ? 0 : undefined}
        textAnchor={label.anchor ?? "middle"}
        x={cx}
        y={cy}
      >
        <title>{label.label}</title>
        {label.renderedLabel ?? label.displayLabel ?? label.label}
      </text>
      {label.decoration ? (
        <foreignObject
          height={40}
          onPointerDown={(event) => event.stopPropagation()}
          width={72}
          x={cx + 8}
          y={cy - 20}
        >
          <div>{label.decoration}</div>
        </foreignObject>
      ) : null}
    </g>
  );
}

type DataScatterCoordinate = Pick<DataScatterMove, "x" | "y">;

type DragState = {
  clientX: number;
  clientY: number;
  cleanup: () => void;
  coordinate: (
    clientX: number,
    clientY: number,
  ) => DataScatterCoordinate | null;
  moved: boolean;
  point: DataScatterPoint;
  pointerId: number;
  target: HTMLElement;
};

type KeyboardState = {
  current: DataScatterMove;
  start: DataScatterMove;
};

type ReorderState = {
  direction: -1 | 1;
  id: string;
};

type DataScatterGestureOwner = {
  drag: () => DragState | null;
  keyboard: () => KeyboardState | null;
  reorder: () => ReorderState | null;
  setDrag: (value: DragState | null) => void;
  setKeyboard: (value: KeyboardState | null) => void;
  setReorder: (value: ReorderState | null) => void;
};

function clampCoordinate(value: number) {
  return Math.max(0, Math.min(1, value));
}

function pointCoordinateResolver(
  target: SVGCircleElement,
  plotArea: ReturnType<typeof usePlotArea>,
) {
  const svg = target.ownerSVGElement;
  const matrix = svg?.getScreenCTM();
  if (!svg || !matrix || !plotArea?.width || !plotArea.height) return null;
  const inverse = matrix.inverse();
  return (clientX: number, clientY: number): DataScatterCoordinate => {
    const svgPoint = svg.createSVGPoint();
    svgPoint.x = clientX;
    svgPoint.y = clientY;
    const position = svgPoint.matrixTransform(inverse);
    return {
      x: clampCoordinate((position.x - plotArea.x) / plotArea.width),
      y: clampCoordinate(1 - (position.y - plotArea.y) / plotArea.height),
    };
  };
}

function DataScatterPointShape({
  cx,
  cy,
  gestureOwner,
  onCoordinateEditor,
  onLabelEditor,
  onMoveCancel,
  onMoveCommit,
  onMovePreview,
  onReorderPoint,
  onReorderPreview,
  onSelect,
  point,
  selected,
}: {
  readonly cx: number;
  readonly cy: number;
  readonly gestureOwner: DataScatterGestureOwner;
  readonly onCoordinateEditor?: DataScatterChartProps["onCoordinateEditor"];
  readonly onLabelEditor?: DataScatterChartProps["onLabelEditor"];
  readonly onMoveCancel?: DataScatterChartProps["onMoveCancel"];
  readonly onMoveCommit?: DataScatterChartProps["onMoveCommit"];
  readonly onMovePreview?: DataScatterChartProps["onMovePreview"];
  readonly onReorderPoint?: DataScatterChartProps["onReorderPoint"];
  readonly onReorderPreview?: DataScatterChartProps["onReorderPreview"];
  readonly onSelect?: DataScatterChartProps["onSelect"];
  readonly point: DataScatterPoint;
  readonly selected: boolean;
}) {
  const plotArea = usePlotArea();
  const groupRef = useRef<SVGGElement | null>(null);
  useLayoutEffect(() => {
    if (selected) groupRef.current?.focus({ preventScroll: true });
  }, [selected]);
  const focusPoint = () => groupRef.current?.focus({ preventScroll: true });
  const cancel = () => {
    const drag = gestureOwner.drag();
    gestureOwner.setDrag(null);
    drag?.cleanup();
    if (drag?.target.hasPointerCapture(drag.pointerId)) {
      drag.target.releasePointerCapture(drag.pointerId);
    }
    onMovePreview?.(null);
    if (drag?.moved) onMoveCancel?.(drag.point.id);
  };
  const applyKeyboardMove = (xDelta: number, yDelta: number) => {
    const keyboard =
      gestureOwner.keyboard()?.start.id === point.id
        ? gestureOwner.keyboard()!
        : {
            current: { id: point.id, x: point.x, y: point.y },
            start: { id: point.id, x: point.x, y: point.y },
          };
    const move = {
      id: point.id,
      x: clampCoordinate(keyboard.current.x + xDelta),
      y: clampCoordinate(keyboard.current.y + yDelta),
    };
    gestureOwner.setKeyboard({ ...keyboard, current: move });
    onMovePreview?.(move);
  };
  const radius = point.radius ?? 7;
  return (
    <g
      aria-label={point.accessibleLabel ?? point.label}
      aria-pressed={onSelect ? selected : undefined}
      data-chart-point-id={point.id}
      data-selected={selected || undefined}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onLabelEditor?.(point.id);
      }}
      onKeyDown={(event) => {
        if (
          event.altKey &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          event.preventDefault();
          event.stopPropagation();
          const direction = event.key === "ArrowUp" ? -1 : 1;
          gestureOwner.setReorder({ direction, id: point.id });
          onReorderPreview?.(point.id, direction);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (gestureOwner.reorder()?.id === point.id) {
            gestureOwner.setReorder(null);
            onReorderPreview?.(point.id, null);
            return;
          }
          if (gestureOwner.keyboard()?.start.id === point.id) {
            gestureOwner.setKeyboard(null);
            onMovePreview?.(null);
            onMoveCancel?.(point.id);
            return;
          }
          cancel();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          const reorder = gestureOwner.reorder();
          if (reorder?.id === point.id) {
            gestureOwner.setReorder(null);
            onReorderPreview?.(point.id, null);
            onReorderPoint?.(point.id, reorder.direction);
            return;
          }
          const keyboard =
            gestureOwner.keyboard()?.start.id === point.id
              ? gestureOwner.keyboard()
              : null;
          if (keyboard) {
            gestureOwner.setKeyboard(null);
            onMovePreview?.(null);
            if (
              keyboard.current.x !== keyboard.start.x ||
              keyboard.current.y !== keyboard.start.y
            ) {
              onMoveCommit?.(keyboard.current);
            }
            return;
          }
          onCoordinateEditor?.(point.id);
          return;
        }
        if (event.key === "F2") {
          event.preventDefault();
          event.stopPropagation();
          onLabelEditor?.(point.id);
          return;
        }
        const step = event.shiftKey ? 0.05 : 0.01;
        if (event.key === "ArrowLeft") applyKeyboardMove(-step, 0);
        else if (event.key === "ArrowRight") applyKeyboardMove(step, 0);
        else if (event.key === "ArrowUp") applyKeyboardMove(0, step);
        else if (event.key === "ArrowDown") applyKeyboardMove(0, -step);
        else if (event.key === " ") onSelect?.(point.id);
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
      role={onSelect ? "button" : undefined}
      ref={groupRef}
      tabIndex={onSelect ? 0 : undefined}
    >
      <circle
        cx={cx}
        cy={cy}
        fill="transparent"
        onClick={(event) => {
          event.stopPropagation();
          focusPoint();
          onSelect?.(point.id);
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          focusPoint();
          const target = event.currentTarget.closest<HTMLElement>(
            '[data-myoxus-ui-role="data-chart"]',
          );
          const resolveCoordinate = pointCoordinateResolver(
            event.currentTarget,
            plotArea,
          );
          if (!onMoveCommit || !target || !resolveCoordinate) {
            onSelect?.(point.id);
            return;
          }
          const pointerId = event.pointerId;
          const handlePointerMove = (pointerEvent: PointerEvent) => {
            const drag = gestureOwner.drag();
            if (!drag || drag.pointerId !== pointerEvent.pointerId) return;
            pointerEvent.stopPropagation();
            const moved =
              drag.moved ||
              Math.hypot(
                pointerEvent.clientX - drag.clientX,
                pointerEvent.clientY - drag.clientY,
              ) >= 4;
            drag.moved = moved;
            if (!moved) return;
            const coordinate = drag.coordinate(
              pointerEvent.clientX,
              pointerEvent.clientY,
            );
            if (!coordinate) {
              cancel();
              return;
            }
            onMovePreview?.({ ...coordinate, id: drag.point.id });
          };
          const handlePointerUp = (pointerEvent: PointerEvent) => {
            const drag = gestureOwner.drag();
            if (!drag || drag.pointerId !== pointerEvent.pointerId) return;
            pointerEvent.stopPropagation();
            const coordinate = drag.moved
              ? drag.coordinate(pointerEvent.clientX, pointerEvent.clientY)
              : null;
            gestureOwner.setDrag(null);
            drag.cleanup();
            if (drag.target.hasPointerCapture(drag.pointerId)) {
              drag.target.releasePointerCapture(drag.pointerId);
            }
            onMovePreview?.(null);
            if (
              coordinate &&
              (coordinate.x !== drag.point.x || coordinate.y !== drag.point.y)
            ) {
              onMoveCommit?.({ ...coordinate, id: drag.point.id });
            }
          };
          const handlePointerCancel = (pointerEvent: PointerEvent) => {
            if (gestureOwner.drag()?.pointerId === pointerEvent.pointerId) {
              cancel();
            }
          };
          const cleanup = () => {
            target.removeEventListener(
              "lostpointercapture",
              handlePointerCancel,
            );
            target.removeEventListener("pointercancel", handlePointerCancel);
            target.removeEventListener("pointermove", handlePointerMove);
            target.removeEventListener("pointerup", handlePointerUp);
          };
          target.addEventListener("lostpointercapture", handlePointerCancel);
          target.addEventListener("pointercancel", handlePointerCancel);
          target.addEventListener("pointermove", handlePointerMove);
          target.addEventListener("pointerup", handlePointerUp);
          gestureOwner.setDrag({
            clientX: event.clientX,
            clientY: event.clientY,
            cleanup,
            coordinate: resolveCoordinate,
            moved: false,
            point,
            pointerId,
            target,
          });
          target.setPointerCapture(pointerId);
          onSelect?.(point.id);
        }}
        r={Math.max(radius + 8, 16)}
      />
      <circle
        cx={cx}
        cy={cy}
        fill={point.color ?? "currentColor"}
        pointerEvents="none"
        r={radius}
        stroke={
          selected
            ? "var(--myoxus-accent-primary)"
            : (point.strokeColor ?? "currentColor")
        }
        strokeWidth={
          selected ? Math.max(point.strokeWidth ?? 1, 3) : point.strokeWidth
        }
      />
      <text
        dx={
          point.labelOffsetX ??
          (point.x > 0.75
            ? -(point.labelPadding ?? 10)
            : (point.labelPadding ?? 10))
        }
        dy={point.labelOffsetY ?? -(point.labelPadding ?? 10)}
        fill={point.labelStyle?.color ?? "currentColor"}
        fontSize={point.labelStyle?.fontSize}
        onClick={(event) => {
          event.stopPropagation();
          focusPoint();
          onSelect?.(point.id);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          focusPoint();
          onLabelEditor?.(point.id);
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          focusPoint();
          onSelect?.(point.id);
        }}
        textAnchor={point.x > 0.75 ? "end" : "start"}
        x={cx}
        y={cy}
      >
        <title>{point.label}</title>
        {point.renderedLabel ?? point.displayLabel ?? point.label}
        {point.badge ? ` ${point.badge}` : null}
      </text>
      {point.decoration ? (
        <foreignObject
          height={40}
          onPointerDown={(event) => event.stopPropagation()}
          width={72}
          x={cx + radius + 6}
          y={cy - 20}
        >
          <div>{point.decoration}</div>
        </foreignObject>
      ) : null}
    </g>
  );
}

function DataScatterPointRenderer({
  cx,
  cy,
  dataPoints,
  gestureOwner,
  onCoordinateEditor,
  onLabelEditor,
  onMoveCancel,
  onMoveCommit,
  onMovePreview,
  onReorderPoint,
  onReorderPreview,
  onSelect,
  payload,
  selectedId,
}: {
  readonly cx?: number;
  readonly cy?: number;
  readonly dataPoints: ReadonlyArray<DataScatterPoint>;
  readonly gestureOwner: DataScatterGestureOwner;
  readonly onCoordinateEditor?: DataScatterChartProps["onCoordinateEditor"];
  readonly onLabelEditor?: DataScatterChartProps["onLabelEditor"];
  readonly onMoveCancel?: DataScatterChartProps["onMoveCancel"];
  readonly onMoveCommit?: DataScatterChartProps["onMoveCommit"];
  readonly onMovePreview?: DataScatterChartProps["onMovePreview"];
  readonly onReorderPoint?: DataScatterChartProps["onReorderPoint"];
  readonly onReorderPreview?: DataScatterChartProps["onReorderPreview"];
  readonly onSelect?: DataScatterChartProps["onSelect"];
  readonly payload?: { readonly index?: number };
  readonly selectedId?: string;
}) {
  const point = dataPoints[Number(payload?.index ?? -1)];
  if (!point || cx === undefined || cy === undefined) return <g />;
  return (
    <DataScatterPointShape
      cx={cx}
      cy={cy}
      gestureOwner={gestureOwner}
      onCoordinateEditor={onCoordinateEditor}
      onLabelEditor={onLabelEditor}
      onMoveCancel={onMoveCancel}
      onMoveCommit={onMoveCommit}
      onMovePreview={onMovePreview}
      onReorderPoint={onReorderPoint}
      onReorderPreview={onReorderPreview}
      onSelect={onSelect}
      point={point}
      selected={point.id === selectedId}
    />
  );
}

export function DataScatterChart({
  ariaLabel,
  emptyLabel,
  emptyAction,
  externalBorderWidth,
  height = 300,
  onCoordinateEditor,
  onLabelEditor,
  onMoveCancel,
  onMoveCommit,
  onMovePreview,
  onReferenceLabelApply,
  onReorderPoint,
  onReorderPreview,
  onSelect,
  points,
  plotPadding,
  referenceAreas = [],
  referenceLines = [],
  referenceLabels = [],
  selectedId,
  summary,
  xAxisEndLabel,
  xAxisStartLabel,
  yAxisEndLabel,
  yAxisStartLabel,
  width,
}: DataScatterChartProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [preview, setPreview] = useState<DataScatterMove | null>(null);
  const [editingLabelId, setEditingLabelId] = useState<string>();
  const dragRef = useRef<DragState | null>(null);
  const keyboardRef = useRef<KeyboardState | null>(null);
  const reorderRef = useRef<ReorderState | null>(null);
  const gestureOwner = useMemo<DataScatterGestureOwner>(
    () => ({
      drag: () => dragRef.current,
      keyboard: () => keyboardRef.current,
      reorder: () => reorderRef.current,
      setDrag: (value) => {
        dragRef.current = value;
      },
      setKeyboard: (value) => {
        keyboardRef.current = value;
      },
      setReorder: (value) => {
        reorderRef.current = value;
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    if (!selectedId) return;
    rootRef.current
      ?.querySelector<SVGGElement>(
        `[data-chart-point-id="${CSS.escape(selectedId)}"]`,
      )
      ?.focus({ preventScroll: true });
  }, [selectedId]);
  const projectedPoints = points.map((point) =>
    preview?.id === point.id ? { ...point, x: preview.x, y: preview.y } : point,
  );
  const previewMove = (move: DataScatterMove | null) => {
    setPreview(move);
    onMovePreview?.(move);
  };
  return (
    <DataChartShell
      ariaLabel={ariaLabel}
      empty={points.length === 0}
      emptyAction={emptyAction}
      emptyLabel={emptyLabel}
      rootRef={rootRef}
      selectedId={selectedId}
      summary={summary}
      testId="data-scatter-chart"
    >
      <ResponsiveContainer height={height} width={width ?? "100%"}>
        <RechartsScatterChart
          accessibilityLayer
          margin={
            plotPadding === undefined
              ? undefined
              : {
                  bottom: plotPadding,
                  left: plotPadding,
                  right: plotPadding,
                  top: plotPadding,
                }
          }
        >
          <XAxis dataKey="x" domain={[0, 1]} hide type="number" />
          <YAxis dataKey="y" domain={[0, 1]} hide type="number" />
          {referenceAreas.map((area) => (
            <ReferenceArea
              fill={area.fill}
              ifOverflow="hidden"
              key={area.id}
              label={
                referenceLabels.length === 0 && area.label
                  ? { position: "insideTopLeft", value: area.label }
                  : undefined
              }
              pointerEvents="none"
              stroke="none"
              x1={area.x1}
              x2={area.x2}
              y1={area.y1}
              y2={area.y2}
            />
          ))}
          {referenceLines.map((line) => (
            <ReferenceLine
              key={line.id}
              label={
                line.label
                  ? { position: "insideTopLeft", value: line.label }
                  : undefined
              }
              pointerEvents="none"
              stroke={line.stroke ?? "var(--myoxus-sem-border-default)"}
              strokeWidth={line.strokeWidth}
              x={line.x}
              y={line.y}
            />
          ))}
          {externalBorderWidth ? (
            <ReferenceArea
              fill="transparent"
              ifOverflow="hidden"
              pointerEvents="none"
              stroke="var(--myoxus-sem-border-default)"
              strokeWidth={externalBorderWidth}
              x1={0}
              x2={1}
              y1={0}
              y2={1}
            />
          ) : null}
          <Scatter
            data={projectedPoints.map((point, index) => ({
              index,
              x: point.x,
              y: point.y,
            }))}
            isAnimationActive={false}
            name={ariaLabel}
            shape={
              <DataScatterPointRenderer
                dataPoints={projectedPoints}
                gestureOwner={gestureOwner}
                onCoordinateEditor={onCoordinateEditor}
                onLabelEditor={onLabelEditor}
                onMoveCancel={onMoveCancel}
                onMoveCommit={onMoveCommit}
                onMovePreview={previewMove}
                onReorderPoint={onReorderPoint}
                onReorderPreview={onReorderPreview}
                onSelect={onSelect}
                selectedId={selectedId}
              />
            }
          />
          {referenceLabels
            .filter((label) => label.label)
            .map((label) => (
              <ReferenceDot
                ifOverflow="extendDomain"
                key={label.id}
                shape={({ cx = 0, cy = 0 }) => (
                  <DataScatterEditableLabel
                    cx={cx}
                    cy={cy}
                    editing={editingLabelId === label.id}
                    label={label}
                    onApply={(value) => {
                      const accepted =
                        value === label.label ||
                        onReferenceLabelApply?.(label.id, value) !== false;
                      if (accepted) setEditingLabelId(undefined);
                    }}
                    onEdit={
                      onReferenceLabelApply
                        ? () => setEditingLabelId(label.id)
                        : undefined
                    }
                  />
                )}
                x={label.x}
                y={label.y}
              />
            ))}
          {referenceLabels.length === 0 && xAxisStartLabel ? (
            <ReferenceLine
              label={{ position: "insideBottomLeft", value: xAxisStartLabel }}
              strokeOpacity={0}
              x={0}
            />
          ) : null}
          {referenceLabels.length === 0 && xAxisEndLabel ? (
            <ReferenceLine
              label={{ position: "insideBottomRight", value: xAxisEndLabel }}
              strokeOpacity={0}
              x={1}
            />
          ) : null}
          {referenceLabels.length === 0 && yAxisStartLabel ? (
            <ReferenceLine
              label={{ position: "insideBottomLeft", value: yAxisStartLabel }}
              strokeOpacity={0}
              y={0}
            />
          ) : null}
          {referenceLabels.length === 0 && yAxisEndLabel ? (
            <ReferenceLine
              label={{ position: "insideTopLeft", value: yAxisEndLabel }}
              strokeOpacity={0}
              y={1}
            />
          ) : null}
        </RechartsScatterChart>
      </ResponsiveContainer>
    </DataChartShell>
  );
}
