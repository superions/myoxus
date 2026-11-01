// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ChartTooltip as MantineChartTooltip,
  CompositeChart as MantineCompositeChart,
} from "@mantine/charts";
import {
  getThemeColor,
  Group,
  Popover,
  Text,
  UnstyledButton,
  useMantineTheme,
} from "@mantine/core";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Label, type LabelProps, Rectangle, usePlotArea } from "recharts";

import {
  DataChartShell,
  type DataChartValueFormatter,
  localizedChartNumber,
} from "./chart-shell";

export type DataCompositeChartPoint = {
  readonly id: string;
  readonly label?: string;
  readonly missing?: boolean;
  readonly outOfRange?: "above" | "below";
  readonly displayY?: number;
  readonly x: number | string;
  readonly xLabel?: string;
  readonly y: number;
};

export type DataCompositeChartPlot = {
  readonly accessibleLabel?: string;
  readonly action?: ReactNode;
  readonly color: string;
  readonly id: string;
  readonly label: string;
  readonly points: ReadonlyArray<DataCompositeChartPoint>;
  readonly type: "bar" | "line";
};

export type DataCompositeChartProps = {
  readonly appearance?: {
    readonly height?: number;
    readonly plotReservedSpacePercent?: number;
    readonly showDataLabel?: boolean;
    readonly showDataLabelOutsideBar?: boolean;
    readonly useMaxWidth?: boolean;
    readonly width?: number;
    readonly xAxis?: DataCompositeChartAxisAppearance;
    readonly yAxis?: DataCompositeChartAxisAppearance;
  };
  readonly ariaDescription?: string;
  readonly ariaLabel: string;
  readonly axisEditor?: (
    axis: {
      readonly id: "xy-axis-x" | "xy-axis-y";
      readonly label: string;
    },
    controls: { readonly close: () => void },
  ) => ReactNode;
  readonly axisEditorId?: "xy-axis-x" | "xy-axis-y";
  readonly categories?: ReadonlyArray<{
    readonly accessibleLabel?: string;
    readonly id: string;
    readonly label: string;
  }>;
  readonly categoryEditor?: (
    category: { readonly id: string; readonly label: string },
    controls: { readonly close: () => void },
  ) => ReactNode;
  readonly categoryEditorId?: string;
  readonly onCategoryEditorClose?: () => void;
  readonly emptyLabel: string;
  readonly emptyAction?: ReactNode;
  readonly focusRequestKey?: number;
  readonly focusRevision?: string;
  readonly diagramAction?: ReactNode;
  readonly onCancelPointPreview?: (pointId: string) => void;
  readonly onCommitPointPreview?: (pointId: string, value: number) => void;
  readonly onEditPoint?: (pointId: string) => void;
  readonly onEditAxis?: (axisId: "xy-axis-x" | "xy-axis-y") => void;
  readonly onEditCategory?: (categoryId: string) => void;
  readonly onEditPlot?: (plotId: string) => void;
  readonly onPreviewPoint?: (pointId: string, value: number) => void;
  readonly onPreviewReorder?: (
    kind: "category" | "plot" | "point",
    id: string,
    direction: -1 | 1 | null,
  ) => void;
  readonly onCommitReorder?: (
    kind: "category" | "plot" | "point",
    id: string,
    direction: -1 | 1,
  ) => void;
  readonly onSelectPlot?: (plotId: string) => void;
  readonly onSelectPoint?: (pointId: string) => void;
  readonly onSelectCategory?: (categoryId: string) => void;
  readonly onSelectAxis?: (axisId: "xy-axis-x" | "xy-axis-y") => void;
  readonly pointKeyboardStepLabel?: (step: number, largeStep: number) => string;
  readonly orientation: "horizontal" | "vertical";
  readonly plots: ReadonlyArray<DataCompositeChartPlot>;
  readonly plotEditor?: (
    plot: DataCompositeChartPlot,
    controls: { readonly close: () => void },
  ) => ReactNode;
  readonly plotEditorId?: string;
  readonly onPlotEditorClose?: () => void;
  readonly pointEditor?: (
    point: DataCompositeChartPoint,
    plot: DataCompositeChartPlot,
    controls: { readonly close: () => void },
  ) => ReactNode;
  readonly pointEditorId?: string;
  readonly onPointEditorClose?: () => void;
  readonly onAxisEditorClose?: () => void;
  readonly previewPoint?: { readonly id: string; readonly y: number };
  readonly readonly?: boolean;
  readonly selectedId?: string;
  readonly summary?: ReactNode;
  readonly valueFormatter?: DataChartValueFormatter;
  readonly xAxisKind: "band" | "linear";
  readonly xAxisLabel?: string;
  readonly xMaximum?: number;
  readonly xMinimum?: number;
  readonly yAxisLabel?: string;
  readonly xAxisAction?: ReactNode;
  readonly yAxisAction?: ReactNode;
  readonly yMaximum: number;
  readonly yMinimum: number;
};

export type DataCompositeChartAxisAppearance = {
  readonly axisLineWidth?: number;
  readonly labelFontSize?: number;
  readonly labelPadding?: number;
  readonly labelRotation?: number;
  readonly showAxisLine?: boolean;
  readonly showLabel?: boolean;
  readonly showTick?: boolean;
  readonly showTitle?: boolean;
  readonly tickLength?: number;
  readonly tickWidth?: number;
  readonly titleFontSize?: number;
  readonly titlePadding?: number;
};

type DragState = {
  captureTarget: Element;
  dimension: number;
  moved: boolean;
  pointId: string;
  pointerId: number;
  startClient: number;
  startValue: number;
};

type CompositePlotArea = ReturnType<typeof usePlotArea>;

// Recharts owns these natural axis dimensions. The XY reserve is only allowed
// to constrain them when a source value explicitly reserves more chart area;
// it never inflates otherwise natural whitespace around the plot.
const RECHARTS_NATURAL_AXIS_HEIGHT = 30;
const RECHARTS_NATURAL_AXIS_WIDTH = 60;
const RECHARTS_DEFAULT_AXIS_TITLE_FONT_SIZE = 16;
const RECHARTS_DEFAULT_AXIS_TITLE_PADDING = 5;
const RECHARTS_AXIS_LABEL_WIDTH_RATIO = 0.65;
const RECHARTS_AXIS_LABEL_INLINE_SPACE = 16;
const COMPOSITE_POINT_LABEL_OFFSET = 10;
const COMPOSITE_POINT_LABEL_WITH_VALUE_OFFSET = 24;

function CompositePlotAreaObserver({
  onChange,
}: {
  readonly onChange: (area: CompositePlotArea) => void;
}) {
  const area = usePlotArea();
  useLayoutEffect(() => onChange(area), [area, onChange]);
  return null;
}

function CompositeAxisTitle({
  axis,
  axisEditor,
  axisEditorId,
  children,
  onAxisEditorClose,
  onEditAxis,
  onSelectAxis,
  selected,
}: {
  readonly axis: {
    readonly id: "xy-axis-x" | "xy-axis-y";
    readonly label: string;
  };
  readonly axisEditor?: DataCompositeChartProps["axisEditor"];
  readonly axisEditorId?: DataCompositeChartProps["axisEditorId"];
  readonly children: ReactElement;
  readonly onAxisEditorClose?: () => void;
  readonly onEditAxis?: DataCompositeChartProps["onEditAxis"];
  readonly onSelectAxis?: DataCompositeChartProps["onSelectAxis"];
  readonly selected: boolean;
}) {
  const control = (
    <g
      aria-label={axis.label}
      aria-pressed={selected}
      data-chart-axis-id={axis.id}
      data-selected={selected || undefined}
      onClick={() => onSelectAxis?.(axis.id)}
      onDoubleClick={() => onEditAxis?.(axis.id)}
      onPointerDown={(event) => event.currentTarget.focus()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectAxis?.(axis.id);
        } else if (event.key === "F2") {
          event.preventDefault();
          onEditAxis?.(axis.id);
        }
      }}
      role="button"
      tabIndex={0}
    >
      {children}
    </g>
  );
  if (axisEditorId !== axis.id || !axisEditor) return control;
  return (
    <Popover
      opened
      onChange={(opened) => {
        if (!opened) onAxisEditorClose?.();
      }}
      position="top"
      returnFocus
      trapFocus
    >
      <Popover.Target>{control}</Popover.Target>
      <Popover.Dropdown>
        {axisEditor(axis, { close: () => onAxisEditorClose?.() })}
      </Popover.Dropdown>
    </Popover>
  );
}

const POINT_DRAG_THRESHOLD = 3;

function pointName(
  plot: DataCompositeChartPlot,
  point: DataCompositeChartPoint,
  value = point.y,
  keyboardHelp?: string,
) {
  const pointOrder = plot.points.indexOf(point) + 1;
  const position = point.xLabel ?? String(point.x);
  const pointLabel = point.label ? ` · ${point.label}` : "";
  return `${plot.accessibleLabel ?? plot.label}${pointLabel} · ${position} · ${pointOrder}: ${localizedChartNumber(value)}${keyboardHelp ? `. ${keyboardHelp}` : ""}`;
}

function decimalPlaces(value: number) {
  const source = value.toString().toLowerCase();
  if (source.includes("e-")) return Number(source.split("e-")[1] ?? 0);
  return source.includes(".") ? source.length - source.indexOf(".") - 1 : 0;
}

function niceKeyboardStep(values: readonly number[], range: number) {
  const precision = Math.min(
    8,
    values.reduce(
      (maximum, value) => Math.max(maximum, decimalPlaces(value)),
      0,
    ),
  );
  const raw = Math.max(10 ** -precision, Math.max(Math.abs(range), 1) / 100);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factor =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function snapChartValue(value: number, step: number) {
  const precision = Math.min(8, decimalPlaces(step));
  return Number((Math.round(value / step) * step).toFixed(precision));
}

export function DataCompositeChart({
  appearance,
  ariaDescription,
  ariaLabel,
  axisEditor,
  axisEditorId,
  categories = [],
  categoryEditor,
  categoryEditorId,
  onCategoryEditorClose,
  diagramAction,
  emptyLabel,
  emptyAction,
  focusRequestKey,
  focusRevision,
  onCancelPointPreview,
  onCommitPointPreview,
  onEditPoint,
  onEditAxis,
  onEditCategory,
  onEditPlot,
  onPreviewPoint,
  onPreviewReorder,
  onCommitReorder,
  onSelectPlot,
  onSelectPoint,
  onSelectCategory,
  onSelectAxis,
  pointKeyboardStepLabel,
  orientation,
  plots,
  plotEditor,
  plotEditorId,
  onPlotEditorClose,
  pointEditor,
  pointEditorId,
  onPointEditorClose,
  onAxisEditorClose,
  previewPoint,
  readonly = false,
  selectedId,
  summary,
  valueFormatter = localizedChartNumber,
  xAxisKind,
  xAxisLabel,
  xMaximum,
  xMinimum,
  yAxisLabel,
  xAxisAction,
  yAxisAction,
  yMaximum,
  yMinimum,
}: DataCompositeChartProps) {
  const theme = useMantineTheme();
  const chartRootRef = useRef<HTMLElement | null>(null);
  const chartSurfaceRef = useRef<HTMLDivElement | null>(null);
  const plotAreaRef = useRef<CompositePlotArea>(undefined);
  const dragRef = useRef<DragState | null>(null);
  const keyboardPreviewRef = useRef<{
    pointId: string;
    value: number;
  } | null>(null);
  const previewValueRef = useRef<number | null>(null);
  const cancelPreviewRef = useRef(onCancelPointPreview);
  const moveDragRef = useRef<(clientX: number, clientY: number) => void>(
    () => undefined,
  );
  const finishDragRef = useRef<(commit: boolean) => void>(() => undefined);
  cancelPreviewRef.current = onCancelPointPreview;
  const [draggingPointId, setDraggingPointId] = useState<string>();
  const [reorderGesture, setReorderGesture] = useState<{
    direction: -1 | 1;
    id: string;
    kind: "category" | "plot" | "point";
  }>();
  const requestedFocusToken =
    focusRequestKey === undefined || !selectedId
      ? undefined
      : `${focusRevision ?? ""}:${focusRequestKey}`;
  const focusRequestRef = useRef<{ id: string; token: string } | undefined>(
    undefined,
  );
  if (
    requestedFocusToken &&
    selectedId &&
    focusRequestRef.current?.token !== requestedFocusToken
  )
    focusRequestRef.current = { id: selectedId, token: requestedFocusToken };
  const recordPlotArea = useCallback((area: CompositePlotArea) => {
    plotAreaRef.current = area;
  }, []);
  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category.label])),
    [categories],
  );
  const xLabelByValue = useMemo(
    () =>
      new Map(
        plots.flatMap((plot) =>
          plot.points.flatMap((point) =>
            point.xLabel === undefined
              ? []
              : [[String(point.x), point.xLabel] as const],
          ),
        ),
      ),
    [plots],
  );
  const allX = useMemo(() => {
    if (xAxisKind === "band") {
      const categoryIds = categories.map((category) => category.id);
      const overflowIds = plots
        .flatMap((plot) => plot.points.map((point) => point.x))
        .filter((x) => !categoryIds.includes(String(x)));
      return [...categoryIds, ...new Set(overflowIds)];
    }
    return [
      ...new Set(
        plots.flatMap((plot) => plot.points.map((point) => Number(point.x))),
      ),
    ].sort((left, right) => left - right);
  }, [categories, plots, xAxisKind]);
  const pointById = useMemo(
    () =>
      new Map(
        plots.flatMap((plot) =>
          plot.points.map((point) => [point.id, { plot, point }] as const),
        ),
      ),
    [plots],
  );
  const keyboardStep = useMemo(
    () =>
      niceKeyboardStep(
        plots.flatMap((plot) => plot.points.map((point) => point.y)),
        yMaximum - yMinimum,
      ),
    [plots, yMaximum, yMinimum],
  );
  const data = allX.map((x) => {
    const row: Record<string, number | string | undefined> = {
      x,
      xLabel:
        xAxisKind === "band"
          ? (categoryById.get(String(x)) ??
            xLabelByValue.get(String(x)) ??
            String(x))
          : Number(x),
    };
    for (const plot of plots) {
      const point = plot.points.find((candidate) => candidate.x === x);
      row[plot.id] = point
        ? previewPoint?.id === point.id
          ? Math.min(yMaximum, Math.max(yMinimum, previewPoint.y))
          : (point.displayY ?? point.y)
        : undefined;
      row[`${plot.id}PointId`] = point?.id;
      row[`${plot.id}PointLabel`] = point?.label;
    }
    return row;
  });
  const formatXLabel = (label: unknown) =>
    label === undefined || label === null
      ? ""
      : xAxisKind === "band"
        ? (categoryById.get(String(label)) ??
          xLabelByValue.get(String(label)) ??
          String(label))
        : valueFormatter(Number(label));

  const cancelDrag = (pointId?: string) => {
    const drag = dragRef.current;
    if (!drag || (pointId && drag.pointId !== pointId)) return false;
    dragRef.current = null;
    previewValueRef.current = null;
    setDraggingPointId(undefined);
    if (drag.captureTarget.hasPointerCapture(drag.pointerId))
      drag.captureTarget.releasePointerCapture(drag.pointerId);
    cancelPreviewRef.current?.(drag.pointId);
    return true;
  };

  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.captureTarget.hasPointerCapture(drag.pointerId))
        drag.captureTarget.releasePointerCapture(drag.pointerId);
      cancelPreviewRef.current?.(drag.pointId);
    },
    [],
  );

  useEffect(() => {
    const request = focusRequestRef.current;
    const root = chartRootRef.current;
    if (!request || request.token !== requestedFocusToken || !root) return;
    let ownsFocus = false;
    let stopped = false;
    let firstFrame = 0;
    let finalFrame = 0;
    const matchesTarget = (element: Element | null) =>
      element instanceof HTMLElement || element instanceof SVGElement
        ? element.dataset.chartPointId === request.id ||
          element.dataset.chartPlotId === request.id ||
          element.dataset.chartCategoryId === request.id ||
          element.dataset.chartAxisId === request.id
        : false;
    const findTarget = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          "[data-chart-point-id], [data-chart-plot-id], [data-chart-category-id], [data-chart-axis-id]",
        ),
      ).find(matchesTarget);
    const focusTarget = () => {
      if (stopped) return;
      const target = findTarget();
      if (!target) return;
      target.focus();
      ownsFocus = document.activeElement === target;
    };
    const scheduleFocus = () => {
      if (stopped || firstFrame || finalFrame) return;
      firstFrame = requestAnimationFrame(() => {
        firstFrame = 0;
        finalFrame = requestAnimationFrame(() => {
          finalFrame = 0;
          focusTarget();
        });
      });
    };
    const stopOwnership = () => {
      stopped = true;
      observer.disconnect();
    };
    const observer = new MutationObserver(() => {
      const activeElement = document.activeElement;
      if (
        ownsFocus &&
        activeElement !== document.body &&
        !matchesTarget(activeElement)
      ) {
        stopOwnership();
        return;
      }
      if (!ownsFocus || activeElement === document.body || !activeElement)
        scheduleFocus();
    });
    const onFocusIn = (event: FocusEvent) => {
      if (ownsFocus && !matchesTarget(event.target as Element | null))
        stopOwnership();
    };
    observer.observe(root, { childList: true, subtree: true });
    document.addEventListener("focusin", onFocusIn);
    scheduleFocus();
    return () => {
      stopped = true;
      observer.disconnect();
      document.removeEventListener("focusin", onFocusIn);
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(finalFrame);
    };
  }, [requestedFocusToken]);

  const beginDrag = (event: PointerEvent<SVGElement>, pointId: string) => {
    if (readonly || !onPreviewPoint || !onCommitPointPreview) return;
    const point = pointById.get(pointId)?.point;
    const plotArea = plotAreaRef.current;
    if (!point || !plotArea) return;
    event.stopPropagation();
    event.currentTarget.closest<SVGElement>("[data-chart-point-id]")?.focus();
    const captureTarget = chartSurfaceRef.current ?? event.currentTarget;
    captureTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      captureTarget,
      dimension: Math.max(
        1,
        orientation === "vertical" ? plotArea.height : plotArea.width,
      ),
      pointId,
      pointerId: event.pointerId,
      moved: false,
      startClient: orientation === "vertical" ? event.clientY : event.clientX,
      startValue: point.y,
    };
    previewValueRef.current = point.y;
    setDraggingPointId(pointId);
    onSelectPoint?.(pointId);
  };
  const moveDrag = (clientX: number, clientY: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    const current = orientation === "vertical" ? clientY : clientX;
    const distance =
      orientation === "vertical"
        ? drag.startClient - current
        : current - drag.startClient;
    const rawValue =
      drag.startValue + (distance / drag.dimension) * (yMaximum - yMinimum);
    if (!Number.isFinite(rawValue)) return;
    if (!drag.moved && Math.abs(distance) < POINT_DRAG_THRESHOLD) return;
    const value = snapChartValue(rawValue, keyboardStep);
    drag.moved = true;
    previewValueRef.current = value;
    onPreviewPoint?.(drag.pointId, value);
  };
  const finishDrag = (commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    const value = previewValueRef.current;
    dragRef.current = null;
    previewValueRef.current = null;
    setDraggingPointId(undefined);
    if (drag.captureTarget.hasPointerCapture(drag.pointerId))
      drag.captureTarget.releasePointerCapture(drag.pointerId);
    if (commit && drag.moved && value !== null && value !== drag.startValue)
      onCommitPointPreview?.(drag.pointId, value);
    else onCancelPointPreview?.(drag.pointId);
  };
  moveDragRef.current = moveDrag;
  finishDragRef.current = finishDrag;
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerId === dragRef.current?.pointerId)
        moveDragRef.current(event.clientX, event.clientY);
    };
    const finish = (event: globalThis.PointerEvent, commit: boolean) => {
      if (event.pointerId === dragRef.current?.pointerId)
        finishDragRef.current(commit);
    };
    const up = (event: globalThis.PointerEvent) => finish(event, true);
    const pointerCancel = (event: globalThis.PointerEvent) =>
      finish(event, false);
    const cancel = () => finishDragRef.current(false);
    // Recharts may rebuild SVG shapes while preview geometry changes. Window
    // capture retains gesture ownership across that rebuild and guarantees one
    // terminal commit/cancel event for the original point.
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", pointerCancel, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", pointerCancel, true);
      window.removeEventListener("blur", cancel);
    };
  }, []);
  const keyboardPoint = (event: KeyboardEvent<SVGElement>, pointId: string) => {
    const owned = pointById.get(pointId);
    const point = owned?.point;
    if (!point || !owned) return;
    if (
      !readonly &&
      event.altKey &&
      ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(event.key)
    ) {
      event.preventDefault();
      const direction =
        event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1;
      setReorderGesture({ direction, id: pointId, kind: "point" });
      onPreviewReorder?.("point", pointId, direction);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const keyboardPreview = keyboardPreviewRef.current;
      if (readonly) {
        onSelectPoint?.(pointId);
      } else if (
        reorderGesture?.kind === "point" &&
        reorderGesture.id === pointId
      ) {
        onCommitReorder?.("point", pointId, reorderGesture.direction);
        setReorderGesture(undefined);
      } else if (keyboardPreview?.pointId === pointId) {
        keyboardPreviewRef.current = null;
        onCommitPointPreview?.(pointId, keyboardPreview.value);
      } else if (previewPoint?.id === pointId) {
        onCommitPointPreview?.(pointId, previewPoint.y);
      } else {
        onSelectPoint?.(pointId);
        onEditPoint?.(pointId);
      }
    } else if (!readonly && event.key === "F2") {
      event.preventDefault();
      onEditPoint?.(pointId);
    } else if (
      event.key === "Escape" &&
      (dragRef.current?.pointId === pointId ||
        previewPoint?.id === pointId ||
        reorderGesture?.id === pointId ||
        keyboardPreviewRef.current?.pointId === pointId)
    ) {
      event.preventDefault();
      if (reorderGesture?.id === pointId)
        onPreviewReorder?.(reorderGesture.kind, pointId, null);
      if (keyboardPreviewRef.current?.pointId === pointId)
        keyboardPreviewRef.current = null;
      setReorderGesture(undefined);
      if (!cancelDrag(pointId)) onCancelPointPreview?.(pointId);
    } else if (
      (orientation === "vertical" &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")) ||
      (orientation === "horizontal" &&
        (event.key === "ArrowUp" || event.key === "ArrowDown"))
    ) {
      event.preventDefault();
      const index = owned.plot.points.findIndex(
        (candidate) => candidate.id === pointId,
      );
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const target = owned.plot.points[index + (forward ? 1 : -1)];
      if (target) {
        onSelectPoint?.(target.id);
        chartRootRef.current
          ?.querySelector<HTMLElement>(`[data-chart-point-id="${target.id}"]`)
          ?.focus();
      }
    } else if (
      !readonly &&
      ((orientation === "vertical" &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")) ||
        (orientation === "horizontal" &&
          (event.key === "ArrowLeft" || event.key === "ArrowRight")))
    ) {
      event.preventDefault();
      const direction =
        event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : -1;
      const step = keyboardStep * (event.shiftKey ? 10 : 1);
      const keyboardPreview = keyboardPreviewRef.current;
      const base =
        keyboardPreview?.pointId === pointId
          ? keyboardPreview.value
          : previewPoint?.id === pointId
            ? previewPoint.y
            : point.y;
      const value = Math.max(
        Number.MIN_SAFE_INTEGER,
        Math.min(
          Number.MAX_SAFE_INTEGER,
          snapChartValue(base + direction * step, step),
        ),
      );
      keyboardPreviewRef.current = { pointId, value };
      onPreviewPoint?.(pointId, value);
    }
  };
  const pointDragProps = (pointId: string) => ({
    onPointerDown: (event: PointerEvent<SVGElement>) =>
      beginDrag(event, pointId),
  });
  const selectProps = (
    pointId: string,
    name: string,
    pointerValueEdit = true,
  ) => ({
    "aria-label": name,
    "aria-pressed": selectedId === pointId,
    "data-chart-point-id": pointId,
    "data-dragging": draggingPointId === pointId || undefined,
    "data-selected": selectedId === pointId || undefined,
    onBlur: () => {
      if (reorderGesture?.kind === "point" && reorderGesture.id === pointId)
        onPreviewReorder?.("point", pointId, null);
      const hasKeyboardPreview =
        keyboardPreviewRef.current?.pointId === pointId;
      const cancelPreview =
        hasKeyboardPreview ||
        previewPoint?.id === pointId ||
        dragRef.current?.pointId === pointId;
      if (hasKeyboardPreview) keyboardPreviewRef.current = null;
      const cancelledDrag = cancelDrag(pointId);
      if (cancelPreview && !cancelledDrag) onCancelPointPreview?.(pointId);
      setReorderGesture(undefined);
    },
    onDoubleClick: () => onEditPoint?.(pointId),
    onFocus: () => {
      if (selectedId !== pointId) onSelectPoint?.(pointId);
    },
    onKeyDown: (event: KeyboardEvent<SVGElement>) =>
      keyboardPoint(event, pointId),
    ...(pointerValueEdit ? pointDragProps(pointId) : {}),
    role: "button",
    tabIndex: 0,
  });
  const xDomain =
    xAxisKind === "linear" && xMinimum !== undefined && xMaximum !== undefined
      ? [xMinimum, xMaximum]
      : undefined;
  const horizontal = orientation === "horizontal";
  const reservedRatio = Math.min(
    1,
    Math.max(0.01, (appearance?.plotReservedSpacePercent ?? 50) / 100),
  );
  // Mermaid defines the reserved plot ratio against its source dimensions.
  // Measuring the responsive Recharts output here creates a resize feedback
  // loop because the resulting axis dimensions change the measured surface.
  const configuredHeight = appearance?.height ?? 500;
  const configuredWidth = appearance?.width ?? 700;
  const axisHeightBudget = configuredHeight * (1 - reservedRatio);
  const axisWidthBudget = configuredWidth * (1 - reservedRatio);
  const bottomAxisAppearance = horizontal
    ? appearance?.yAxis
    : appearance?.xAxis;
  const bottomAxisHasTitle =
    bottomAxisAppearance?.showTitle !== false &&
    Boolean(horizontal ? yAxisLabel : xAxisLabel);
  const sideAxisAppearance = horizontal ? appearance?.xAxis : appearance?.yAxis;
  const sideAxisHasTitle =
    sideAxisAppearance?.showTitle !== false &&
    Boolean(horizontal ? xAxisLabel : yAxisLabel);
  const widestSideAxisLabel =
    horizontal &&
    xAxisKind === "band" &&
    sideAxisAppearance?.showLabel !== false
      ? Math.max(
          0,
          ...categories.map((category) => category.label.length),
          ...Array.from(xLabelByValue.values(), (label) => label.length),
        )
      : 0;
  const sideAxisLabelWidth =
    widestSideAxisLabel *
      (sideAxisAppearance?.labelFontSize ?? 14) *
      RECHARTS_AXIS_LABEL_WIDTH_RATIO +
    (sideAxisAppearance?.labelPadding ?? 5) +
    (sideAxisAppearance?.tickLength ?? 5) +
    RECHARTS_AXIS_LABEL_INLINE_SPACE;
  const naturalAxisHeight =
    RECHARTS_NATURAL_AXIS_HEIGHT +
    (bottomAxisHasTitle
      ? (bottomAxisAppearance?.titleFontSize ??
          RECHARTS_DEFAULT_AXIS_TITLE_FONT_SIZE) +
        (bottomAxisAppearance?.titlePadding ??
          RECHARTS_DEFAULT_AXIS_TITLE_PADDING)
      : 0);
  const naturalAxisWidth = Math.max(
    RECHARTS_NATURAL_AXIS_WIDTH +
      (sideAxisHasTitle
        ? (sideAxisAppearance?.titleFontSize ??
            RECHARTS_DEFAULT_AXIS_TITLE_FONT_SIZE) +
          (sideAxisAppearance?.titlePadding ??
            RECHARTS_DEFAULT_AXIS_TITLE_PADDING)
        : 0),
    sideAxisLabelWidth,
  );
  const constrainedAxisHeight = Math.max(
    1,
    Math.min(naturalAxisHeight, axisHeightBudget),
  );
  const constrainedAxisWidth = Math.max(
    1,
    Math.min(naturalAxisWidth, axisWidthBudget),
  );
  const categoryByStableId = new Map(
    categories.map((category) => [category.id, category]),
  );
  const categoryTick = (tickProps: {
    payload?: { value?: string | number };
    x?: number | string;
    y?: number | string;
  }) => {
    const tickX = Number(tickProps.x ?? 0);
    const tickY = Number(tickProps.y ?? 0);
    const category = categoryByStableId.get(String(tickProps.payload?.value));
    if (!category) {
      const overflowLabel = xLabelByValue.get(String(tickProps.payload?.value));
      return overflowLabel ? (
        <text
          className="myoxus-data-composite-overflow-label"
          dominantBaseline="middle"
          textAnchor={horizontal ? "end" : "middle"}
          x={tickX + (horizontal ? -8 : 0)}
          y={tickY + (horizontal ? 0 : 10)}
        >
          {overflowLabel}
        </text>
      ) : (
        <g />
      );
    }
    const control = (
      <text
        aria-label={category.accessibleLabel ?? category.label}
        aria-pressed={selectedId === category.id}
        data-chart-category-id={category.id}
        data-selected={selectedId === category.id || undefined}
        dominantBaseline="middle"
        fontSize={appearance?.xAxis?.labelFontSize}
        onClick={() => onSelectCategory?.(category.id)}
        onBlur={() => {
          if (
            reorderGesture?.kind === "category" &&
            reorderGesture.id === category.id
          ) {
            onPreviewReorder?.("category", category.id, null);
            setReorderGesture(undefined);
          }
        }}
        onDoubleClick={() => onEditCategory?.(category.id)}
        onPointerDown={(event) => event.currentTarget.focus()}
        onKeyDown={(event) => {
          if (
            !readonly &&
            event.altKey &&
            ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(
              event.key,
            )
          ) {
            event.preventDefault();
            const direction =
              event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1;
            setReorderGesture({
              direction,
              id: category.id,
              kind: "category",
            });
            onPreviewReorder?.("category", category.id, direction);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (
              reorderGesture?.kind === "category" &&
              reorderGesture.id === category.id
            ) {
              onCommitReorder?.(
                "category",
                category.id,
                reorderGesture.direction,
              );
              setReorderGesture(undefined);
            } else onSelectCategory?.(category.id);
          } else if (
            event.key === "Escape" &&
            reorderGesture?.kind === "category" &&
            reorderGesture.id === category.id
          ) {
            event.preventDefault();
            onPreviewReorder?.("category", category.id, null);
            setReorderGesture(undefined);
          } else if (!readonly && event.key === "F2") {
            event.preventDefault();
            onEditCategory?.(category.id);
          }
        }}
        role="button"
        tabIndex={0}
        textAnchor={horizontal ? "end" : "middle"}
        transform={`rotate(${appearance?.xAxis?.labelRotation ?? 0} ${tickX} ${tickY})`}
        x={tickX + (horizontal ? -8 : 0)}
        y={tickY + (horizontal ? 0 : 10)}
      >
        {category.label}
      </text>
    );
    if (categoryEditorId !== category.id || !categoryEditor || readonly)
      return control;
    return (
      <Popover
        opened
        onChange={(opened) => {
          if (!opened) onCategoryEditorClose?.();
        }}
        position="bottom"
        returnFocus
        trapFocus
      >
        <Popover.Target>{control}</Popover.Target>
        <Popover.Dropdown>
          {categoryEditor(category, {
            close: () => onCategoryEditorClose?.(),
          })}
        </Popover.Dropdown>
      </Popover>
    );
  };
  const withPointEditor = (pointId: string, control: ReactElement) => {
    const owned = pointById.get(pointId);
    if (!owned || pointEditorId !== pointId || !pointEditor) return control;
    return (
      <Popover
        opened
        onChange={(opened) => {
          if (!opened) onPointEditorClose?.();
        }}
        position="top"
        returnFocus
        trapFocus
      >
        <Popover.Target>{control}</Popover.Target>
        <Popover.Dropdown>
          {pointEditor(owned.point, owned.plot, {
            close: () => onPointEditorClose?.(),
          })}
        </Popover.Dropdown>
      </Popover>
    );
  };
  const withAxisEditor = (
    id: "xy-axis-x" | "xy-axis-y",
    label: string,
    control: ReactElement,
  ) => (
    <CompositeAxisTitle
      axis={{ id, label }}
      axisEditor={readonly ? undefined : axisEditor}
      axisEditorId={axisEditorId}
      onAxisEditorClose={onAxisEditorClose}
      onEditAxis={readonly ? undefined : onEditAxis}
      onSelectAxis={onSelectAxis}
      selected={selectedId === id}
    >
      {control}
    </CompositeAxisTitle>
  );
  const editableAxisLabel = (
    id: "xy-axis-x" | "xy-axis-y",
    label: string,
    labelProps: LabelProps,
  ) => (
    <Label
      {...labelProps}
      content={(contentProps) =>
        withAxisEditor(
          id,
          label,
          <Label {...contentProps} zIndex={0}>
            {label}
          </Label>,
        )
      }
    >
      {label}
    </Label>
  );

  return (
    <DataChartShell
      ariaDescription={ariaDescription}
      ariaLabel={ariaLabel}
      empty={data.length === 0 || plots.length === 0}
      emptyAction={
        emptyAction ? (
          <div data-chart-empty-action>{emptyAction}</div>
        ) : undefined
      }
      emptyLabel={emptyLabel}
      rootRef={chartRootRef}
      selectedId={selectedId}
      summary={summary}
      testId="data-composite-chart"
    >
      {diagramAction ? <Group justify="center">{diagramAction}</Group> : null}
      <Group aria-label={ariaLabel} gap="xs" justify="center" role="list">
        {plots.map((plot) => {
          const control = (
            <UnstyledButton
              aria-label={plot.accessibleLabel ?? plot.label}
              aria-pressed={selectedId === plot.id}
              data-chart-plot-id={plot.id}
              data-selected={selectedId === plot.id || undefined}
              key={plot.id}
              onBlur={() => {
                if (
                  reorderGesture?.kind === "plot" &&
                  reorderGesture.id === plot.id
                ) {
                  onPreviewReorder?.("plot", plot.id, null);
                  setReorderGesture(undefined);
                }
              }}
              onClick={() => onSelectPlot?.(plot.id)}
              onDoubleClick={() => onEditPlot?.(plot.id)}
              onKeyDown={(event) => {
                if (
                  !readonly &&
                  event.altKey &&
                  ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(
                    event.key,
                  )
                ) {
                  event.preventDefault();
                  const direction =
                    event.key === "ArrowUp" || event.key === "ArrowLeft"
                      ? -1
                      : 1;
                  setReorderGesture({ direction, id: plot.id, kind: "plot" });
                  onPreviewReorder?.("plot", plot.id, direction);
                } else if (
                  event.key === "Escape" &&
                  reorderGesture?.kind === "plot" &&
                  reorderGesture.id === plot.id
                ) {
                  event.preventDefault();
                  onPreviewReorder?.("plot", plot.id, null);
                  setReorderGesture(undefined);
                } else if (
                  (event.key === "Enter" || event.key === " ") &&
                  reorderGesture?.kind === "plot" &&
                  reorderGesture.id === plot.id
                ) {
                  event.preventDefault();
                  onCommitReorder?.("plot", plot.id, reorderGesture.direction);
                  setReorderGesture(undefined);
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectPlot?.(plot.id);
                } else if (!readonly && event.key === "F2") {
                  event.preventDefault();
                  onEditPlot?.(plot.id);
                }
              }}
            >
              <Group gap="xs">
                <span
                  aria-hidden="true"
                  className="myoxus-data-composite-legend-swatch"
                  style={{ backgroundColor: getThemeColor(plot.color, theme) }}
                />
                <Text size="sm">{plot.label}</Text>
              </Group>
            </UnstyledButton>
          );
          return (
            <Group gap="xs" key={plot.id} role="listitem" wrap="nowrap">
              {plotEditorId === plot.id && plotEditor ? (
                <Popover
                  opened
                  onChange={(opened) => {
                    if (!opened) onPlotEditorClose?.();
                  }}
                  position="top"
                  returnFocus
                  trapFocus
                >
                  <Popover.Target>{control}</Popover.Target>
                  <Popover.Dropdown>
                    {plotEditor(plot, { close: () => onPlotEditorClose?.() })}
                  </Popover.Dropdown>
                </Popover>
              ) : (
                <span>{control}</span>
              )}
              {plot.action}
            </Group>
          );
        })}
      </Group>
      <div
        className="myoxus-data-composite-chart-surface"
        data-orientation={orientation}
        data-plot-reserved-space-percent={
          appearance?.plotReservedSpacePercent ?? 50
        }
        onLostPointerCapture={() => finishDrag(false)}
        ref={chartSurfaceRef}
      >
        <MantineCompositeChart
          accessibilityLayer
          barProps={(series) => ({
            isAnimationActive: false,
            label: appearance?.showDataLabel
              ? {
                  position: appearance.showDataLabelOutsideBar
                    ? horizontal
                      ? "right"
                      : "top"
                    : "inside",
                }
              : false,
            shape: (shapeProps) => {
              const payload = shapeProps.payload as Record<
                string,
                string | number | undefined
              >;
              const pointId = String(payload[`${series.name}PointId`] ?? "");
              const owned = pointById.get(pointId);
              if (!owned) return <g />;
              const { height = 0, width = 0, x = 0, y = 0 } = shapeProps;
              const label = owned.point.label;
              const numericHeight = Number(height);
              const numericWidth = Number(width);
              const visibleHeight = Math.abs(numericHeight);
              const visibleWidth = Math.abs(numericWidth);
              const visibleLeft = Math.min(Number(x), Number(x) + numericWidth);
              const visibleTop = Math.min(Number(y), Number(y) + numericHeight);
              const hitWidth = Math.max(visibleWidth, 16);
              const hitHeight = Math.max(visibleHeight, 16);
              const baseline = Math.min(yMaximum, Math.max(yMinimum, 0));
              const displayedValue =
                previewPoint?.id === pointId
                  ? previewPoint.y
                  : (owned.point.displayY ?? owned.point.y);
              const displayedOutOfRange =
                displayedValue > yMaximum
                  ? "above"
                  : displayedValue < yMinimum
                    ? "below"
                    : undefined;
              const valueEndpoint = {
                x: horizontal
                  ? Number(x) + numericWidth
                  : visibleLeft + visibleWidth / 2,
                y: horizontal
                  ? Number(y) + Number(height) / 2
                  : displayedValue >= baseline
                    ? Number(y)
                    : Number(y) + numericHeight,
              };
              return withPointEditor(
                pointId,
                <g
                  {...selectProps(
                    pointId,
                    pointName(
                      owned.plot,
                      owned.point,
                      previewPoint?.id === pointId
                        ? previewPoint.y
                        : owned.point.y,
                      readonly
                        ? undefined
                        : pointKeyboardStepLabel?.(
                            keyboardStep,
                            keyboardStep * 10,
                          ),
                    ),
                    false,
                  )}
                  data-missing={owned.point.missing || undefined}
                  data-out-of-range={displayedOutOfRange}
                  onClick={() => onSelectPoint?.(pointId)}
                >
                  <Rectangle
                    {...shapeProps}
                    aria-hidden="true"
                    pointerEvents="none"
                  />
                  <rect
                    aria-hidden="true"
                    fill="transparent"
                    height={hitHeight}
                    stroke="none"
                    width={hitWidth}
                    x={visibleLeft - (hitWidth - visibleWidth) / 2}
                    y={visibleTop - (hitHeight - visibleHeight) / 2}
                  />
                  <rect
                    {...pointDragProps(pointId)}
                    aria-hidden="true"
                    data-chart-point-drag-handle={pointId}
                    fill="transparent"
                    height={16}
                    stroke="none"
                    width={16}
                    x={valueEndpoint.x - 8}
                    y={valueEndpoint.y - 8}
                  />
                  {label ? (
                    <text
                      aria-hidden="true"
                      className="myoxus-data-composite-point-label"
                      textAnchor={
                        horizontal
                          ? displayedValue >= baseline
                            ? "start"
                            : "end"
                          : "middle"
                      }
                      x={valueEndpoint.x}
                      y={
                        valueEndpoint.y -
                        (appearance?.showDataLabel
                          ? COMPOSITE_POINT_LABEL_WITH_VALUE_OFFSET
                          : COMPOSITE_POINT_LABEL_OFFSET)
                      }
                    >
                      {label}
                    </text>
                  ) : null}
                  {displayedOutOfRange || owned.point.missing ? (
                    <circle
                      aria-hidden="true"
                      className="myoxus-data-composite-range-marker"
                      cx={valueEndpoint.x}
                      cy={valueEndpoint.y}
                      r={5}
                    />
                  ) : null}
                </g>,
              );
            },
          })}
          composedChartProps={{
            layout: horizontal ? "vertical" : "horizontal",
          }}
          data={data}
          dataKey="x"
          h={appearance?.height ?? "100%"}
          lineProps={(series) => ({
            activeDot: false,
            isAnimationActive: false,
            "aria-label": (() => {
              const plot = plots.find(
                (candidate) => candidate.id === series.name,
              );
              return plot?.accessibleLabel ?? plot?.label;
            })(),
            "aria-pressed": selectedId === series.name,
            "data-chart-plot-id": series.name,
            onClick: () => onSelectPlot?.(series.name),
            onDoubleClick: () => onEditPlot?.(series.name),
            onPointerDown: (_curve, event) => event.currentTarget.focus(),
            onKeyDown: (_curve, event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectPlot?.(series.name);
              } else if (!readonly && event.key === "F2") {
                event.preventDefault();
                onEditPlot?.(series.name);
              }
            },
            role: "button",
            tabIndex: 0,
            connectNulls: true,
            dot: (dotProps) => {
              const payload = dotProps.payload as Record<
                string,
                string | number | undefined
              >;
              const pointId = String(payload[`${series.name}PointId`] ?? "");
              const owned = pointById.get(pointId);
              if (!owned) return <g />;
              const cx = Number(dotProps.cx ?? 0);
              const cy = Number(dotProps.cy ?? 0);
              const displayedValue =
                previewPoint?.id === pointId
                  ? previewPoint.y
                  : (owned.point.displayY ?? owned.point.y);
              const displayedOutOfRange =
                displayedValue > yMaximum
                  ? "above"
                  : displayedValue < yMinimum
                    ? "below"
                    : undefined;
              return withPointEditor(
                pointId,
                <g
                  {...selectProps(
                    pointId,
                    pointName(
                      owned.plot,
                      owned.point,
                      previewPoint?.id === pointId
                        ? previewPoint.y
                        : owned.point.y,
                      readonly
                        ? undefined
                        : pointKeyboardStepLabel?.(
                            keyboardStep,
                            keyboardStep * 10,
                          ),
                    ),
                  )}
                  data-missing={owned.point.missing || undefined}
                  data-out-of-range={displayedOutOfRange}
                  onClick={() => onSelectPoint?.(pointId)}
                >
                  <circle
                    aria-hidden="true"
                    cx={cx}
                    cy={cy}
                    fill="transparent"
                    r={12}
                    stroke="none"
                  />
                  <circle
                    aria-hidden="true"
                    cx={cx}
                    cy={cy}
                    fill={String(dotProps.fill ?? "currentColor")}
                    pointerEvents="none"
                    r={Math.max(Number(dotProps.r ?? 4), 6)}
                    stroke={String(dotProps.stroke ?? "currentColor")}
                    strokeWidth={Number(dotProps.strokeWidth ?? 2)}
                  />
                  {owned.point.label ? (
                    <text
                      aria-hidden="true"
                      className="myoxus-data-composite-point-label"
                      textAnchor="middle"
                      x={cx}
                      y={
                        cy -
                        (appearance?.showDataLabel
                          ? COMPOSITE_POINT_LABEL_WITH_VALUE_OFFSET
                          : COMPOSITE_POINT_LABEL_OFFSET)
                      }
                    >
                      {owned.point.label}
                    </text>
                  ) : null}
                  {displayedOutOfRange || owned.point.missing ? (
                    <circle
                      aria-hidden="true"
                      className="myoxus-data-composite-range-marker"
                      cx={cx}
                      cy={cy}
                      r={8}
                    />
                  ) : null}
                </g>,
              );
            },
          })}
          series={plots.map((plot) => ({
            color: plot.color,
            label: plot.label,
            name: plot.id,
            type: plot.type,
          }))}
          tooltipProps={{
            content: ({ label, payload }) => {
              const row = payload?.[0]?.payload as
                Record<string, string | number | undefined> | undefined;
              return (
                <MantineChartTooltip
                  label={formatXLabel(label)}
                  payload={payload}
                  series={plots.map((plot) => {
                    const pointLabel = row?.[`${plot.id}PointLabel`];
                    return {
                      color: plot.color,
                      label: pointLabel
                        ? `${plot.label} · ${pointLabel}`
                        : plot.label,
                      name: plot.id,
                    };
                  })}
                  valueFormatter={valueFormatter}
                />
              );
            },
            wrapperStyle: {
              maxWidth: `calc(100% - ${constrainedAxisWidth}px)`,
            },
          }}
          valueFormatter={valueFormatter}
          withLegend={false}
          withTooltip
          w={
            appearance?.useMaxWidth === false
              ? appearance.width
              : `min(100%, ${appearance?.width ?? 700}px)`
          }
          withPointLabels={appearance?.showDataLabel}
          xAxisLabel={undefined}
          xAxisProps={
            horizontal
              ? {
                  axisLine:
                    appearance?.yAxis?.showAxisLine === false
                      ? false
                      : { strokeWidth: appearance?.yAxis?.axisLineWidth },
                  children:
                    appearance?.yAxis?.showTitle === false || !yAxisLabel
                      ? undefined
                      : editableAxisLabel("xy-axis-y", yAxisLabel, {
                          fontSize: appearance?.yAxis?.titleFontSize,
                          offset: appearance?.yAxis?.titlePadding,
                          position: "insideBottom",
                        }),
                  dataKey: undefined,
                  domain: [yMinimum, yMaximum],
                  height: constrainedAxisHeight,
                  tick:
                    appearance?.yAxis?.showLabel === false
                      ? false
                      : {
                          angle: appearance?.yAxis?.labelRotation,
                          fontSize: appearance?.yAxis?.labelFontSize,
                        },
                  tickMargin: appearance?.yAxis?.labelPadding,
                  tickLine:
                    appearance?.yAxis?.showTick === false
                      ? false
                      : { strokeWidth: appearance?.yAxis?.tickWidth },
                  tickSize: appearance?.yAxis?.tickLength,
                  type: "number",
                }
              : {
                  axisLine:
                    appearance?.xAxis?.showAxisLine === false
                      ? false
                      : { strokeWidth: appearance?.xAxis?.axisLineWidth },
                  children:
                    appearance?.xAxis?.showTitle === false || !xAxisLabel
                      ? undefined
                      : editableAxisLabel("xy-axis-x", xAxisLabel, {
                          fontSize: appearance?.xAxis?.titleFontSize,
                          offset: appearance?.xAxis?.titlePadding,
                          position: "insideBottom",
                        }),
                  domain: xDomain,
                  height: constrainedAxisHeight,
                  interval: xAxisKind === "band" ? 0 : undefined,
                  tick:
                    appearance?.xAxis?.showLabel === false
                      ? false
                      : xAxisKind === "band"
                        ? categoryTick
                        : {
                            angle: appearance?.xAxis?.labelRotation,
                            fontSize: appearance?.xAxis?.labelFontSize,
                          },
                  tickMargin: appearance?.xAxis?.labelPadding,
                  tickLine:
                    appearance?.xAxis?.showTick === false
                      ? false
                      : { strokeWidth: appearance?.xAxis?.tickWidth },
                  tickSize: appearance?.xAxis?.tickLength,
                  type: xAxisKind === "linear" ? "number" : "category",
                }
          }
          yAxisLabel={undefined}
          yAxisProps={
            horizontal
              ? {
                  axisLine:
                    appearance?.xAxis?.showAxisLine === false
                      ? false
                      : { strokeWidth: appearance?.xAxis?.axisLineWidth },
                  children:
                    appearance?.xAxis?.showTitle === false || !xAxisLabel
                      ? undefined
                      : editableAxisLabel("xy-axis-x", xAxisLabel, {
                          angle: -90,
                          fontSize: appearance?.xAxis?.titleFontSize,
                          offset: appearance?.xAxis?.titlePadding,
                          position: "insideLeft",
                        }),
                  dataKey: "x",
                  domain: xDomain,
                  interval: xAxisKind === "band" ? 0 : undefined,
                  tick:
                    appearance?.xAxis?.showLabel === false
                      ? false
                      : xAxisKind === "band"
                        ? categoryTick
                        : {
                            angle: appearance?.xAxis?.labelRotation,
                            fontSize: appearance?.xAxis?.labelFontSize,
                          },
                  tickMargin: appearance?.xAxis?.labelPadding,
                  tickLine:
                    appearance?.xAxis?.showTick === false
                      ? false
                      : { strokeWidth: appearance?.xAxis?.tickWidth },
                  tickSize: appearance?.xAxis?.tickLength,
                  type: xAxisKind === "linear" ? "number" : "category",
                  width: constrainedAxisWidth,
                }
              : {
                  axisLine:
                    appearance?.yAxis?.showAxisLine === false
                      ? false
                      : { strokeWidth: appearance?.yAxis?.axisLineWidth },
                  children:
                    appearance?.yAxis?.showTitle === false || !yAxisLabel
                      ? undefined
                      : editableAxisLabel("xy-axis-y", yAxisLabel, {
                          angle: -90,
                          fontSize: appearance?.yAxis?.titleFontSize,
                          offset: appearance?.yAxis?.titlePadding,
                          position: "insideLeft",
                        }),
                  domain: [yMinimum, yMaximum],
                  tick:
                    appearance?.yAxis?.showLabel === false
                      ? false
                      : {
                          angle: appearance?.yAxis?.labelRotation,
                          fontSize: appearance?.yAxis?.labelFontSize,
                        },
                  tickMargin: appearance?.yAxis?.labelPadding,
                  tickLine:
                    appearance?.yAxis?.showTick === false
                      ? false
                      : { strokeWidth: appearance?.yAxis?.tickWidth },
                  tickSize: appearance?.yAxis?.tickLength,
                  type: "number",
                  width: constrainedAxisWidth,
                }
          }
        >
          <CompositePlotAreaObserver onChange={recordPlotArea} />
        </MantineCompositeChart>
      </div>
      {xAxisAction || yAxisAction ? (
        <Group gap="xs" justify="center">
          {xAxisAction}
          {yAxisAction}
        </Group>
      ) : null}
    </DataChartShell>
  );
}
