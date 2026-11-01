// SPDX-License-Identifier: AGPL-3.0-or-later

import { RadarChart as MantineRadarChart } from "@mantine/charts";
import {
  Group,
  Paper,
  Popover as MantinePopover,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from "@mantine/core";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  DataChartShell,
  localizedChartNumber,
  type DataChartValueFormatter,
} from "./chart-shell";

export type DataRadarAxis = {
  readonly accessibleLabel?: string;
  readonly annotationCount?: number;
  readonly id: string;
  readonly label: string;
};

export type DataRadarVertex = {
  readonly axisId: string;
  readonly id: string;
  readonly state:
    "clipped-high" | "clipped-low" | "duplicate" | "missing" | "present";
  readonly value?: number;
  readonly step?: number;
};

export type DataRadarCurve = {
  readonly accessibleLabel?: string;
  readonly annotationCount?: number;
  readonly color: string;
  readonly id: string;
  readonly label: string;
  readonly vertices: readonly DataRadarVertex[];
};

export type DataRadarGeometry = {
  readonly axisLabelFactor: number;
  readonly axisScaleFactor: number;
  readonly curveTension: number;
  readonly height: number;
  readonly marginBottom: number;
  readonly marginLeft: number;
  readonly marginRight: number;
  readonly marginTop: number;
  readonly useMaxWidth: boolean;
  readonly width: number;
};

export type DataRadarSelection = {
  readonly id: string;
  readonly kind: "axis" | "curve" | "vertex";
} | null;

export type DataRadarSelectionEditor = (
  selection: Exclude<DataRadarSelection, null>,
  controls: { readonly close: () => void },
) => ReactNode;

export type DataRadarAnnotation = {
  readonly id: string;
  readonly kind: "axis" | "curve";
};

export type DataRadarAnnotationEditor = (
  annotation: DataRadarAnnotation,
  controls: { readonly close: () => void },
) => ReactNode;

export type DataRadarChartProps = {
  readonly ariaDescription?: string;
  readonly ariaLabel: string;
  readonly annotationEditor?: DataRadarAnnotationEditor;
  readonly annotationLabel?: (count: number) => string;
  readonly axes: readonly DataRadarAxis[];
  readonly curves: readonly DataRadarCurve[];
  readonly emptyAction?: ReactNode;
  readonly emptyLabel: string;
  readonly editing?: DataRadarSelection;
  readonly graticule: "circle" | "polygon";
  readonly geometry?: DataRadarGeometry;
  readonly focusRequestKey?: string;
  readonly focusSelection?: Exclude<DataRadarSelection, null>;
  readonly interactive?: boolean;
  readonly maximum: number;
  readonly maximumIsExplicit?: boolean;
  readonly minimum: number;
  readonly onSelect?: (selection: Exclude<DataRadarSelection, null>) => void;
  readonly onEdit?: (selection: Exclude<DataRadarSelection, null>) => void;
  readonly onEditClose?: () => void;
  readonly onEscapeGestureCancel?: (event: globalThis.KeyboardEvent) => void;
  readonly onFocusRequestConsumed?: () => void;
  readonly onReorderCancel?: () => void;
  readonly onReorderCommit?: (
    kind: "axis" | "curve",
    id: string,
    beforeId?: string,
  ) => void;
  readonly onReorderPreview?: (
    kind: "axis" | "curve",
    id: string,
    beforeId?: string,
  ) => void;
  readonly onVertexCancel?: (vertexId: string) => void;
  readonly onVertexCommit?: (vertexId: string, value: number) => void;
  readonly onVertexPreview?: (vertexId: string, value: number) => void;
  readonly readonly?: boolean;
  /** Invalidates open previews after an authoritative external source change. */
  readonly revision?: string;
  readonly selected?: DataRadarSelection;
  readonly selectionEditor?: DataRadarSelectionEditor;
  readonly showLegend: boolean;
  readonly summary?: ReactNode;
  readonly ticks: number;
  readonly valueFormatter?: DataChartValueFormatter;
  readonly valueStepLabel?: (step: number, largeStep: number) => string;
  readonly vertexStateLabel?: (state: DataRadarVertex["state"]) => string;
};

type RadarReorderGesture = {
  readonly id: string;
  readonly kind: "axis" | "curve";
  readonly order: readonly string[];
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  beforeId?: string;
  moved: boolean;
  previewed: boolean;
};

type RadarVertexPointerGesture = {
  readonly axisX: number;
  readonly axisY: number;
  readonly id: string;
  readonly pointerId: number;
  readonly radius: number;
  readonly rangeMaximum: number;
  readonly rangeMinimum: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startValue: number;
  readonly step: number;
  value: number;
  moved: boolean;
};

type RadarVertexKeyboardGesture = {
  readonly id: string;
  readonly startValue: number;
  readonly step: number;
  value: number;
};

// Mantine's native radar series uses this opacity. Recharts omits it when it
// delegates to a custom shape, so preserve the Facade component's native look.
const MANTINE_RADAR_AREA_OPACITY = 0.4;

function radarStepValue(value: number, gestureStart: number, step: number) {
  const quantized =
    gestureStart + Math.round((value - gestureStart) / step) * step;
  return Number(quantized.toPrecision(12));
}

export function dataRadarValueStep(
  sourceStep: number | undefined,
  minimum: number,
  maximum: number,
  ticks: number,
  gestureStep?: number,
) {
  const rangeStep =
    (maximum - minimum) / (Math.max(1, Math.min(32, ticks || 10)) * 10);
  if (gestureStep) return gestureStep;
  const rawStep = Math.max(
    sourceStep && sourceStep > 0 ? sourceStep : 0,
    rangeStep,
  );
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const factor = normalized < 2 ? 1 : normalized < 5 ? 2 : 5;
  return factor * magnitude;
}

function selected(
  selection: DataRadarSelection | undefined,
  kind: "axis" | "curve" | "vertex",
  id: string,
) {
  return selection?.kind === kind && selection.id === id;
}

function radarDisplayedValue(
  vertex: DataRadarVertex | undefined,
  minimum: number,
  maximum: number,
) {
  if (vertex?.state === "missing") return maximum;
  return Math.max(minimum, Math.min(maximum, vertex?.value ?? minimum));
}

function radarAccessibleSentence(value: string) {
  const sentence = value.trim();
  return sentence && !/[.!?]$/.test(sentence) ? `${sentence}.` : sentence;
}

function radarCurvePath(
  points: readonly { readonly x: number; readonly y: number }[],
  tension: number,
  graticule: "circle" | "polygon",
) {
  if (points.length < 3) return "";
  if (graticule === "polygon")
    return `${points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
      .join(" ")} Z`;
  const factor = tension;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const following = points[(index + 2) % points.length];
    path += ` C ${current.x + factor * (next.x - previous.x)} ${
      current.y + factor * (next.y - previous.y)
    }, ${next.x - factor * (following.x - current.x)} ${
      next.y - factor * (following.y - current.y)
    }, ${next.x} ${next.y}`;
  }
  return `${path} Z`;
}

function radarAxisLabelLines(label: string, maximumCharacters: number) {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [label];
  const chunks = words.flatMap((word) => {
    if (word.length <= maximumCharacters) return [word];
    const parts: string[] = [];
    for (let index = 0; index < word.length; index += maximumCharacters)
      parts.push(word.slice(index, index + maximumCharacters));
    return parts;
  });
  return chunks.reduce<string[]>((lines, word) => {
    const current = lines.at(-1);
    if (!current || `${current} ${word}`.length > maximumCharacters)
      lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
    return lines;
  }, []);
}

function SelectionTarget({
  children,
  editor,
  onClose,
  selection,
}: {
  readonly children: ReactElement;
  readonly editor?: DataRadarSelectionEditor;
  readonly onClose: () => void;
  readonly selection: Exclude<DataRadarSelection, null>;
}) {
  if (!editor) return children;
  return (
    <MantinePopover
      closeOnClickOutside
      onChange={(opened) => {
        if (!opened) onClose();
      }}
      opened
      position="top"
      returnFocus
      shadow="md"
      trapFocus
      withinPortal
    >
      <MantinePopover.Target>{children}</MantinePopover.Target>
      <MantinePopover.Dropdown>
        {editor(selection, { close: onClose })}
      </MantinePopover.Dropdown>
    </MantinePopover>
  );
}

function AnnotationTarget({
  annotation,
  children,
  editor,
  onClose,
  opened,
}: {
  readonly annotation: DataRadarAnnotation;
  readonly children: ReactElement;
  readonly editor?: DataRadarAnnotationEditor;
  readonly onClose: () => void;
  readonly opened: boolean;
}) {
  if (!editor || !opened) return children;
  return (
    <MantinePopover
      closeOnClickOutside
      onChange={(next) => {
        if (!next) onClose();
      }}
      opened
      position="top"
      returnFocus
      shadow="md"
      trapFocus
      withinPortal
    >
      <MantinePopover.Target>{children}</MantinePopover.Target>
      <MantinePopover.Dropdown>
        {editor(annotation, { close: onClose })}
      </MantinePopover.Dropdown>
    </MantinePopover>
  );
}

function RadarVertexMarker({
  axisCount,
  axisAccessibleLabel,
  axisIndex,
  color,
  collisionOffset,
  curveId,
  curveAccessibleLabel,
  cx,
  cy,
  gestureStep,
  interactive,
  maximum,
  minimum,
  onEdit,
  onEditClose,
  onKeyboardBlur,
  onPointerStart,
  onSelect,
  onVertexKey,
  readonly,
  selected: isSelected,
  selectionEditor,
  ticks,
  valueFormatter,
  valueStepLabel,
  vertexStateLabel,
  vertex,
}: {
  readonly axisCount: number;
  readonly axisAccessibleLabel: string;
  readonly axisIndex: number;
  readonly color: string;
  readonly collisionOffset: number;
  readonly curveId: string;
  readonly curveAccessibleLabel: string;
  readonly cx: number;
  readonly cy: number;
  readonly gestureStep?: number;
  readonly interactive: boolean;
  readonly maximum: number;
  readonly minimum: number;
  readonly onEdit?: (selection: Exclude<DataRadarSelection, null>) => void;
  readonly onEditClose?: () => void;
  readonly onKeyboardBlur: (
    vertexId: string,
    relatedTarget: EventTarget | null,
  ) => void;
  readonly onPointerStart: (gesture: RadarVertexPointerGesture) => void;
  readonly onSelect?: (selection: Exclude<DataRadarSelection, null>) => void;
  readonly onVertexKey: (
    event: ReactKeyboardEvent<SVGGElement>,
    vertex: DataRadarVertex,
    step: number,
  ) => boolean;
  readonly readonly: boolean;
  readonly selected: boolean;
  readonly selectionEditor?: DataRadarSelectionEditor;
  readonly ticks: number;
  readonly valueFormatter: DataChartValueFormatter;
  readonly valueStepLabel?: (step: number, largeStep: number) => string;
  readonly vertexStateLabel?: (state: DataRadarVertex["state"]) => string;
  readonly vertex: DataRadarVertex;
}) {
  const selection = { id: vertex.id, kind: "vertex" as const };
  const step = dataRadarValueStep(
    vertex.step,
    minimum,
    maximum,
    ticks,
    gestureStep,
  );
  const accessibleValue =
    vertex.value === undefined ? "–" : valueFormatter(vertex.value);
  const accessibleState =
    vertexStateLabel && vertex.state !== "present"
      ? vertexStateLabel(vertex.state)
      : "";
  const accessibleStep =
    vertex.value !== undefined && valueStepLabel
      ? valueStepLabel(step, step * 10)
      : "";
  const target = (
    <g
      aria-label={[
        `${curveAccessibleLabel} · ${axisAccessibleLabel}: ${accessibleValue}`,
        accessibleState,
        accessibleStep,
      ]
        .filter(Boolean)
        .map(radarAccessibleSentence)
        .join(" ")}
      aria-pressed={interactive ? isSelected : undefined}
      color={color}
      data-chart-curve-id={curveId}
      data-chart-point-id={vertex.id}
      data-chart-vertex-state={vertex.state}
      data-selected={isSelected || undefined}
      onBlur={
        interactive
          ? (event) => onKeyboardBlur(vertex.id, event.relatedTarget)
          : undefined
      }
      onClick={
        interactive
          ? (event) => {
              event.stopPropagation();
              event.currentTarget.focus();
              onSelect?.(selection);
              if (event.detail === 2) onEdit?.(selection);
            }
          : undefined
      }
      onKeyDown={
        interactive
          ? (event) => {
              if (
                (readonly || event.ctrlKey) &&
                (event.key === "ArrowLeft" || event.key === "ArrowRight")
              ) {
                const vertices = Array.from(
                  event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>(
                    `[data-chart-curve-id="${CSS.escape(curveId)}"][data-chart-point-id]`,
                  ) ?? [],
                );
                const index = vertices.indexOf(event.currentTarget);
                const next =
                  index < 0
                    ? undefined
                    : vertices[
                        (index +
                          (event.key === "ArrowLeft" ? -1 : 1) +
                          vertices.length) %
                          vertices.length
                      ];
                if (next) {
                  event.preventDefault();
                  next.focus();
                }
                return;
              }
              if (onVertexKey(event, vertex, step)) return;
              if (event.key === "Enter" || event.key === "F2") {
                event.preventDefault();
                onSelect?.(selection);
                onEdit?.(selection);
                return;
              }
              if (event.key === " ") {
                event.preventDefault();
                onSelect?.(selection);
                return;
              }
            }
          : undefined
      }
      onPointerDown={
        interactive
          ? (event) => {
              event.stopPropagation();
              if (readonly || vertex.value === undefined || event.button !== 0)
                return;
              const svg = event.currentTarget.ownerSVGElement;
              const matrix = svg?.getScreenCTM();
              if (!svg || !matrix) return;
              const viewBox = svg.viewBox.baseVal;
              const radialLines = svg.querySelectorAll<SVGLineElement>(
                ".recharts-polar-grid-angle line",
              );
              const radialLine = radialLines[axisIndex];
              const center = svg.createSVGPoint();
              center.x = radialLine
                ? Number(radialLine.getAttribute("x1"))
                : viewBox.x + viewBox.width / 2;
              center.y = radialLine
                ? Number(radialLine.getAttribute("y1"))
                : viewBox.y + viewBox.height / 2;
              const centerScreen = center.matrixTransform(matrix);
              const point = svg.createSVGPoint();
              point.x = cx;
              point.y = cy;
              const pointScreen = point.matrixTransform(matrix);
              const axisLength = Math.hypot(
                pointScreen.x - centerScreen.x,
                pointScreen.y - centerScreen.y,
              );
              const displayed = Math.max(
                minimum,
                Math.min(maximum, vertex.value),
              );
              const ratio = (displayed - minimum) / (maximum - minimum);
              const fallbackAngle =
                -Math.PI / 2 +
                (axisIndex / Math.max(1, axisCount)) * Math.PI * 2;
              const box = svg.getBoundingClientRect();
              const end = svg.createSVGPoint();
              end.x = radialLine ? Number(radialLine.getAttribute("x2")) : 0;
              end.y = radialLine ? Number(radialLine.getAttribute("y2")) : 0;
              const endScreen = radialLine ? end.matrixTransform(matrix) : null;
              const gridRadius = endScreen
                ? Math.hypot(
                    endScreen.x - centerScreen.x,
                    endScreen.y - centerScreen.y,
                  )
                : 0;
              const radius =
                gridRadius > 0
                  ? gridRadius
                  : ratio > 0
                    ? axisLength / ratio
                    : Math.min(box.width, box.height) * 0.36;
              const axisX =
                gridRadius > 0 && endScreen
                  ? (endScreen.x - centerScreen.x) / gridRadius
                  : axisLength > 0
                    ? (pointScreen.x - centerScreen.x) / axisLength
                    : Math.cos(fallbackAngle);
              const axisY =
                gridRadius > 0 && endScreen
                  ? (endScreen.y - centerScreen.y) / gridRadius
                  : axisLength > 0
                    ? (pointScreen.y - centerScreen.y) / axisLength
                    : Math.sin(fallbackAngle);
              if (
                !Number.isFinite(radius) ||
                radius <= 0 ||
                !Number.isFinite(axisX) ||
                !Number.isFinite(axisY)
              )
                return;
              onPointerStart({
                axisX,
                axisY,
                id: vertex.id,
                moved: false,
                pointerId: event.pointerId,
                radius,
                rangeMaximum: maximum,
                rangeMinimum: minimum,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startValue: vertex.value,
                step,
                value: vertex.value,
              });
            }
          : undefined
      }
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      transform={
        collisionOffset === 0
          ? undefined
          : `translate(${
              -Math.sin(
                -Math.PI / 2 +
                  (axisIndex / Math.max(1, axisCount)) * Math.PI * 2,
              ) * collisionOffset
            },${
              Math.cos(
                -Math.PI / 2 +
                  (axisIndex / Math.max(1, axisCount)) * Math.PI * 2,
              ) * collisionOffset
            })`
      }
    >
      <circle
        className="myoxus-data-radar-vertex-hitarea"
        cx={cx}
        cy={cy}
        r={12}
      />
      <circle className="myoxus-data-radar-vertex" cx={cx} cy={cy} r={5} />
    </g>
  );
  return isSelected && selectionEditor ? (
    <SelectionTarget
      editor={selectionEditor}
      onClose={() => onEditClose?.()}
      selection={selection}
    >
      {target}
    </SelectionTarget>
  ) : (
    target
  );
}

export function DataRadarChart({
  annotationEditor,
  annotationLabel = (count) => String(count),
  ariaDescription,
  ariaLabel,
  axes,
  curves,
  editing,
  emptyAction,
  emptyLabel,
  focusRequestKey,
  focusSelection,
  graticule,
  geometry,
  interactive = true,
  maximum,
  maximumIsExplicit = true,
  minimum,
  onEdit,
  onEditClose,
  onEscapeGestureCancel,
  onFocusRequestConsumed,
  onReorderCancel,
  onReorderCommit,
  onReorderPreview,
  onSelect,
  onVertexCancel,
  onVertexCommit,
  onVertexPreview,
  readonly = false,
  revision,
  selected: selection,
  selectionEditor,
  showLegend,
  summary,
  ticks,
  valueFormatter = localizedChartNumber,
  valueStepLabel,
  vertexStateLabel,
}: DataRadarChartProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const reorderRef = useRef<RadarReorderGesture | undefined>(undefined);
  const suppressReorderClickRef = useRef(false);
  const pendingAnnotationFocusRef = useRef<DataRadarAnnotation | undefined>(
    undefined,
  );
  const pendingVertexFocusRef = useRef<string | undefined>(undefined);
  const vertexKeyboardRef = useRef<RadarVertexKeyboardGesture | undefined>(
    undefined,
  );
  const vertexPointerRef = useRef<RadarVertexPointerGesture | undefined>(
    undefined,
  );
  const [keyboardReorder, setKeyboardReorder] = useState<{
    readonly beforeId?: string;
    readonly id: string;
    readonly kind: "axis" | "curve";
  }>();
  const [activeAnnotation, setActiveAnnotation] =
    useState<DataRadarAnnotation>();
  const [gridRadii, setGridRadii] = useState<readonly number[]>([]);
  const requestedFocusToken =
    focusRequestKey && focusSelection
      ? `${focusRequestKey}:${focusSelection.kind}:${focusSelection.id}`
      : undefined;
  const focusRequestRef = useRef<
    | {
        readonly selection: Exclude<DataRadarSelection, null>;
        readonly token: string;
      }
    | undefined
  >(undefined);
  const consumedFocusTokenRef = useRef<string | undefined>(undefined);
  if (
    requestedFocusToken &&
    focusSelection &&
    focusRequestRef.current?.token !== requestedFocusToken
  )
    focusRequestRef.current = {
      selection: focusSelection,
      token: requestedFocusToken,
    };
  const focusVertex = (id: string) => {
    const target = rootRef.current?.querySelector<SVGGElement>(
      `[data-chart-point-id="${CSS.escape(id)}"]`,
    );
    target?.focus();
    return Boolean(target);
  };
  useEffect(() => {
    const request = focusRequestRef.current;
    const root = rootRef.current;
    if (!request || request.token !== requestedFocusToken || !root) return;
    const attribute =
      request.selection.kind === "axis"
        ? "data-chart-axis-id"
        : request.selection.kind === "curve"
          ? "data-chart-curve-id"
          : "data-chart-point-id";
    const selector = `[${attribute}="${CSS.escape(request.selection.id)}"]`;
    let ownsFocus = false;
    let stopped = false;
    let firstFrame = 0;
    let finalFrame = 0;
    let acknowledgeFrame = 0;
    let acknowledgeFinalFrame = 0;
    const matchesTarget = (element: Element | null) =>
      Boolean(element?.matches(selector));
    const acknowledgeFocus = () => {
      if (stopped || acknowledgeFrame || acknowledgeFinalFrame) return;
      acknowledgeFrame = requestAnimationFrame(() => {
        acknowledgeFrame = 0;
        acknowledgeFinalFrame = requestAnimationFrame(() => {
          acknowledgeFinalFrame = 0;
          if (!matchesTarget(document.activeElement)) {
            scheduleFocus();
            return;
          }
          if (consumedFocusTokenRef.current === request.token) return;
          consumedFocusTokenRef.current = request.token;
          onFocusRequestConsumed?.();
        });
      });
    };
    const focusTarget = () => {
      if (stopped) return;
      const target = root.querySelector<HTMLElement>(selector);
      if (!target) return;
      target.focus();
      ownsFocus = document.activeElement === target;
      if (ownsFocus) acknowledgeFocus();
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
      cancelAnimationFrame(acknowledgeFrame);
      cancelAnimationFrame(acknowledgeFinalFrame);
      acknowledgeFrame = 0;
      acknowledgeFinalFrame = 0;
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
      cancelAnimationFrame(acknowledgeFrame);
      cancelAnimationFrame(acknowledgeFinalFrame);
    };
  }, [onFocusRequestConsumed, requestedFocusToken]);
  const restoreVertexFocus = (id: string) => {
    // Controlled Recharts updates replace the focused SVG node during the
    // React commit. Retain the semantic target until the replacement has been
    // committed so a following key cannot escape into the surrounding editor.
    pendingVertexFocusRef.current = id;
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        if (!focusVertex(id)) return;
        pendingVertexFocusRef.current = undefined;
      });
    });
  };
  const restoreAnnotationFocus = (annotation: DataRadarAnnotation) => {
    pendingAnnotationFocusRef.current = annotation;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const pending = pendingAnnotationFocusRef.current;
        if (!pending) return;
        const target = rootRef.current?.querySelector<HTMLElement>(
          `[data-chart-annotation-kind="${pending.kind}"][data-chart-annotation-id="${CSS.escape(pending.id)}"]`,
        );
        if (!target) return;
        target.focus();
        pendingAnnotationFocusRef.current = undefined;
      }),
    );
  };
  useLayoutEffect(() => {
    const pending = pendingVertexFocusRef.current;
    if (!pending || !focusVertex(pending)) return;
    pendingVertexFocusRef.current = undefined;
  }, [curves, revision]);
  const cancelVertexKeyboard = (restoreFocus = true) => {
    const gesture = vertexKeyboardRef.current;
    if (!gesture) return;
    vertexKeyboardRef.current = undefined;
    onVertexCancel?.(gesture.id);
    if (restoreFocus) restoreVertexFocus(gesture.id);
  };
  const finishVertexKeyboard = (commit: boolean) => {
    const gesture = vertexKeyboardRef.current;
    if (!gesture) return;
    vertexKeyboardRef.current = undefined;
    if (commit && gesture.value !== gesture.startValue)
      onVertexCommit?.(gesture.id, gesture.value);
    else onVertexCancel?.(gesture.id);
    restoreVertexFocus(gesture.id);
  };
  const previewVertexKeyboard = (
    gesture: RadarVertexKeyboardGesture,
    key: string,
    shiftKey: boolean,
  ) => {
    const direction =
      key === "ArrowUp" || key === "ArrowRight"
        ? 1
        : key === "ArrowDown" || key === "ArrowLeft"
          ? -1
          : 0;
    if (!direction) return false;
    const candidate =
      gesture.value + direction * gesture.step * (shiftKey ? 10 : 1);
    const stepped = radarStepValue(candidate, gesture.startValue, gesture.step);
    // Keyboard editing is the precise source-value path. Unlike radial drag,
    // it must retain and adjust values outside an explicit visual range;
    // Radar source only requires the result to remain non-negative.
    gesture.value = Math.max(0, stepped);
    onVertexPreview?.(gesture.id, gesture.value);
    return true;
  };
  const vertexKey = (
    event: ReactKeyboardEvent<SVGGElement>,
    vertex: DataRadarVertex,
    step: number,
  ) => {
    const active = vertexKeyboardRef.current;
    if (active?.id === vertex.id) {
      if (event.key === "Escape") {
        onEscapeGestureCancel?.(event.nativeEvent);
        event.preventDefault();
        event.stopPropagation();
        cancelVertexKeyboard();
        return true;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        finishVertexKeyboard(true);
        return true;
      }
    }
    if (readonly || vertex.value === undefined) return false;
    const gesture =
      active?.id === vertex.id
        ? active
        : ({
            id: vertex.id,
            startValue: vertex.value,
            step,
            value: vertex.value,
          } satisfies RadarVertexKeyboardGesture);
    if (!previewVertexKeyboard(gesture, event.key, event.shiftKey))
      return false;
    event.preventDefault();
    vertexKeyboardRef.current = gesture;
    return true;
  };
  const finishVertexPointer = (commit: boolean) => {
    const gesture = vertexPointerRef.current;
    if (!gesture) return;
    vertexPointerRef.current = undefined;
    const root = rootRef.current;
    if (root?.hasPointerCapture(gesture.pointerId))
      root.releasePointerCapture(gesture.pointerId);
    if (
      commit &&
      gesture.moved &&
      Number.isFinite(gesture.value) &&
      gesture.value !== gesture.startValue
    )
      onVertexCommit?.(gesture.id, gesture.value);
    else if (gesture.moved) onVertexCancel?.(gesture.id);
    if (gesture.moved) restoreVertexFocus(gesture.id);
  };
  const cancelVertexPreviews = () => {
    finishVertexPointer(false);
    cancelVertexKeyboard();
  };
  const orderedIds = (kind: "axis" | "curve") =>
    kind === "axis"
      ? axes.map((axis) => axis.id)
      : curves.map((curve) => curve.id);
  const beforeForDirection = (
    kind: "axis" | "curve",
    id: string,
    direction: -1 | 1,
  ) => {
    const ids = orderedIds(kind);
    const from = ids.indexOf(id);
    if (from < 0) return null;
    const to = from + direction;
    if (to < 0 || to >= ids.length) return null;
    return direction < 0 ? ids[to] : ids[to + 1];
  };
  const beforeForTarget = (
    ids: readonly string[],
    id: string,
    targetId: string,
  ) => {
    const from = ids.indexOf(id);
    const target = ids.indexOf(targetId);
    if (from < 0 || target < 0 || from === target) return null;
    return target < from ? targetId : ids[target + 1];
  };
  const cancelReorder = () => {
    const gesture = reorderRef.current;
    const keyboardActive = keyboardReorder !== undefined;
    if (gesture) {
      reorderRef.current = undefined;
      const root = rootRef.current;
      if (root?.hasPointerCapture(gesture.pointerId))
        root.releasePointerCapture(gesture.pointerId);
    }
    setKeyboardReorder(undefined);
    if (gesture?.previewed || keyboardActive) onReorderCancel?.();
  };
  const finishReorder = (commit: boolean) => {
    const gesture = reorderRef.current;
    if (!gesture) return;
    reorderRef.current = undefined;
    const root = rootRef.current;
    if (root?.hasPointerCapture(gesture.pointerId))
      root.releasePointerCapture(gesture.pointerId);
    if (gesture.moved) {
      suppressReorderClickRef.current = true;
    }
    if (commit && gesture.moved && gesture.previewed)
      onReorderCommit?.(gesture.kind, gesture.id, gesture.beforeId);
    else if (gesture.previewed) onReorderCancel?.();
  };
  const beginReorder = (
    event: ReactPointerEvent<SVGElement | HTMLButtonElement>,
    kind: "axis" | "curve",
    id: string,
  ) => {
    if (readonly || event.button !== 0 || !rootRef.current) return;
    // Keep the pointer stream owned by the chart. Native text selection or
    // HTML drag initiation on a legend label otherwise terminates the stream
    // before it reaches a second curve target.
    event.preventDefault();
    event.stopPropagation();
    reorderRef.current = {
      id,
      kind,
      moved: false,
      order: orderedIds(kind),
      pointerId: event.pointerId,
      previewed: false,
      startX: event.clientX,
      startY: event.clientY,
    };
  };
  const reorderKey = (
    event: ReactKeyboardEvent<SVGElement | HTMLButtonElement>,
    kind: "axis" | "curve",
    id: string,
  ) => {
    const active = keyboardReorder?.kind === kind && keyboardReorder.id === id;
    if (
      !readonly &&
      event.altKey &&
      ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(event.key)
    ) {
      event.preventDefault();
      const direction =
        event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1;
      const beforeId = beforeForDirection(kind, id, direction);
      if (beforeId === null) return true;
      setKeyboardReorder({ beforeId, id, kind });
      onReorderPreview?.(kind, id, beforeId);
      return true;
    }
    if (active && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      onReorderCommit?.(kind, id, keyboardReorder.beforeId);
      setKeyboardReorder(undefined);
      return true;
    }
    if (active && event.key === "Escape") {
      onEscapeGestureCancel?.(event.nativeEvent);
      event.preventDefault();
      event.stopPropagation();
      cancelReorder();
      return true;
    }
    return false;
  };
  useEffect(() => {
    const pointerDown = (event: globalThis.PointerEvent) => {
      const gesture = vertexKeyboardRef.current;
      if (!gesture || !(event.target instanceof Element)) return;
      const continuedTarget = event.target.closest(
        `[data-chart-point-id="${CSS.escape(gesture.id)}"]`,
      );
      if (!continuedTarget) cancelVertexKeyboard(false);
    };
    const move = (event: globalThis.PointerEvent) => {
      const vertexGesture = vertexPointerRef.current;
      if (vertexGesture?.pointerId === event.pointerId) {
        const deltaX = event.clientX - vertexGesture.startClientX;
        const deltaY = event.clientY - vertexGesture.startClientY;
        if (!vertexGesture.moved && Math.hypot(deltaX, deltaY) < 4) return;
        const root = rootRef.current;
        if (!vertexGesture.moved) {
          vertexGesture.moved = true;
          if (root && !root.hasPointerCapture(event.pointerId))
            root.setPointerCapture(event.pointerId);
          onSelect?.({ id: vertexGesture.id, kind: "vertex" });
        }
        const projected =
          deltaX * vertexGesture.axisX + deltaY * vertexGesture.axisY;
        const raw =
          vertexGesture.startValue +
          (projected / vertexGesture.radius) *
            (vertexGesture.rangeMaximum - vertexGesture.rangeMinimum);
        if (!Number.isFinite(raw)) return;
        const stepped = radarStepValue(
          raw,
          vertexGesture.startValue,
          vertexGesture.step,
        );
        vertexGesture.value = Math.max(
          vertexGesture.rangeMinimum,
          maximumIsExplicit
            ? Math.min(vertexGesture.rangeMaximum, stepped)
            : stepped,
        );
        onVertexPreview?.(vertexGesture.id, vertexGesture.value);
        return;
      }
      const gesture = reorderRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (
        !gesture.moved &&
        Math.hypot(
          event.clientX - gesture.startX,
          event.clientY - gesture.startY,
        ) < 5
      )
        return;
      gesture.moved = true;
      const root = rootRef.current;
      if (root && !root.hasPointerCapture(event.pointerId))
        root.setPointerCapture(event.pointerId);
      onSelect?.({ id: gesture.id, kind: gesture.kind });
      const selector =
        gesture.kind === "axis"
          ? "[data-chart-axis-id]"
          : "[data-chart-curve-id]";
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>(selector);
      const targetId =
        gesture.kind === "axis"
          ? target?.dataset.chartAxisId
          : target?.dataset.chartCurveId;
      if (!targetId) return;
      const beforeId = beforeForTarget(gesture.order, gesture.id, targetId);
      if (
        beforeId === null ||
        (gesture.previewed && beforeId === gesture.beforeId)
      )
        return;
      gesture.beforeId = beforeId;
      gesture.previewed = true;
      onReorderPreview?.(gesture.kind, gesture.id, beforeId);
    };
    const up = (event: globalThis.PointerEvent) => {
      if (vertexPointerRef.current?.pointerId === event.pointerId)
        finishVertexPointer(true);
      else if (reorderRef.current?.pointerId === event.pointerId)
        finishReorder(true);
    };
    const pointerCancel = (event: globalThis.PointerEvent) => {
      if (vertexPointerRef.current?.pointerId === event.pointerId)
        finishVertexPointer(false);
      else if (reorderRef.current?.pointerId === event.pointerId)
        finishReorder(false);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      const ownsGestureEscape =
        event.key === "Escape" &&
        Boolean(
          vertexPointerRef.current ||
          vertexKeyboardRef.current ||
          reorderRef.current ||
          keyboardReorder,
        );
      // Edgeless reserves its global Escape hotkey before this inner chart
      // owner runs, but defers the actual fallback. An active chart gesture
      // must still mark and cancel that same event during its synchronous path.
      if (event.defaultPrevented && !ownsGestureEscape) return;
      let vertexGesture = vertexKeyboardRef.current;
      if (
        !vertexGesture &&
        !readonly &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(
          event.key,
        ) &&
        document.activeElement instanceof Element &&
        rootRef.current?.contains(document.activeElement)
      ) {
        const vertexId = document.activeElement
          .closest<SVGElement>("[data-chart-point-id]")
          ?.getAttribute("data-chart-point-id");
        const vertex = vertexId
          ? curves
              .flatMap((curve) => curve.vertices)
              .find((candidate) => candidate.id === vertexId)
          : undefined;
        if (vertex?.value !== undefined) {
          vertexGesture = {
            id: vertex.id,
            startValue: vertex.value,
            step: dataRadarValueStep(vertex.step, minimum, maximum, ticks),
            value: vertex.value,
          };
          vertexKeyboardRef.current = vertexGesture;
        }
      }
      if (
        vertexGesture &&
        previewVertexKeyboard(vertexGesture, event.key, event.shiftKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
      } else if (
        vertexGesture &&
        (event.key === "Enter" || event.key === " ")
      ) {
        event.preventDefault();
        event.stopPropagation();
        finishVertexKeyboard(true);
      } else if (vertexGesture && event.key === "Escape") {
        onEscapeGestureCancel?.(event);
        event.preventDefault();
        event.stopPropagation();
        cancelVertexKeyboard();
      } else if (
        keyboardReorder &&
        (event.key === "Enter" || event.key === " ")
      ) {
        event.preventDefault();
        onReorderCommit?.(
          keyboardReorder.kind,
          keyboardReorder.id,
          keyboardReorder.beforeId,
        );
        setKeyboardReorder(undefined);
      } else if (
        event.key === "Escape" &&
        (vertexPointerRef.current || reorderRef.current || keyboardReorder)
      ) {
        // Escape belongs to the active chart gesture. Letting it bubble closes
        // the embedded editor in Edgeless after the value/reorder preview has
        // already been cancelled, which makes a local cancel look like exit.
        onEscapeGestureCancel?.(event);
        event.preventDefault();
        event.stopPropagation();
        if (vertexPointerRef.current) finishVertexPointer(false);
        else if (reorderRef.current) finishReorder(false);
        else if (keyboardReorder) cancelReorder();
      }
    };
    window.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", pointerCancel, true);
    window.addEventListener("keydown", key, true);
    const blur = () => {
      cancelVertexPreviews();
      cancelReorder();
    };
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", pointerCancel, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", blur);
    };
  });
  useLayoutEffect(() => {
    const gesture = vertexKeyboardRef.current;
    if (gesture) focusVertex(gesture.id);
  });
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const updateGridRadii = () => {
      const axisLine = root.querySelector<SVGLineElement>(
        ".myoxus-data-radar-axis-line",
      );
      const axisScaleFactor = geometry?.axisScaleFactor ?? 1;
      const outerRadius = axisLine
        ? Math.hypot(
            Number(axisLine.getAttribute("x2")) -
              Number(axisLine.getAttribute("x1")),
            Number(axisLine.getAttribute("y2")) -
              Number(axisLine.getAttribute("y1")),
          ) / axisScaleFactor
        : 0;
      const count = Math.ceil(Math.max(0, Math.min(32, ticks)));
      const next =
        outerRadius > 0 && ticks > 0
          ? Array.from(
              { length: count },
              (_, index) => (outerRadius * (index + 1)) / ticks,
            )
          : [];
      setGridRadii((current) =>
        current.length === next.length &&
        current.every((radius, index) => radius === next[index])
          ? current
          : next,
      );
    };
    updateGridRadii();
    const observer = new ResizeObserver(updateGridRadii);
    observer.observe(root);
    return () => observer.disconnect();
  }, [axes.length, geometry?.axisScaleFactor, ticks]);
  useEffect(() => {
    cancelVertexPreviews();
    cancelReorder();
    setActiveAnnotation(undefined);
  }, [revision]);
  useEffect(() => {
    if (!activeAnnotation) return;
    const count =
      activeAnnotation.kind === "axis"
        ? axes.find((axis) => axis.id === activeAnnotation.id)?.annotationCount
        : curves.find((curve) => curve.id === activeAnnotation.id)
            ?.annotationCount;
    if (count === undefined) setActiveAnnotation(undefined);
  }, [activeAnnotation, axes, curves]);
  const data = axes.map((axis) => ({
    __axisId: axis.id,
    axis: axis.label,
    ...Object.fromEntries(
      curves.map((curve) => [
        curve.id,
        (() => {
          const vertex = curve.vertices.find(
            (candidate) => candidate.axisId === axis.id,
          );
          // Missing is a source state, not a numeric zero. Put its distinct
          // marker at this axis endpoint so multiple missing vertices remain
          // individually reachable; partial curves never render a line or
          // area, so this display coordinate cannot imply a persisted value.
          if (vertex?.state === "missing") return maximum;
          return Math.max(minimum, Math.min(maximum, vertex?.value ?? minimum));
        })(),
      ]),
    ),
  }));
  const hasAxes = axes.length > 0;
  const hasCurves = curves.length > 0;
  const totalWidth = geometry
    ? geometry.width + geometry.marginLeft + geometry.marginRight
    : 0;
  const totalHeight = geometry
    ? geometry.height + geometry.marginTop + geometry.marginBottom
    : 0;
  const surfaceStyle = geometry
    ? ({
        aspectRatio: `${totalWidth} / ${totalHeight}`,
        blockSize: "auto",
        inlineSize: geometry.useMaxWidth ? "100%" : `${totalWidth}px`,
        marginInline: "auto",
        maxInlineSize: geometry.useMaxWidth ? `${totalWidth}px` : "none",
      } satisfies CSSProperties)
    : undefined;
  const legend =
    showLegend && hasCurves ? (
      <Group aria-label={ariaLabel} justify="center" role="list">
        {curves.map((curve) => {
          const curveSelection = { id: curve.id, kind: "curve" as const };
          const legendContent = (
            <Group gap="xs" wrap="nowrap">
              <ThemeIcon
                aria-hidden
                color={curve.color}
                size="xs"
                variant="filled"
              />
              <Text component="span" size="sm">
                {curve.label}
              </Text>
            </Group>
          );
          const control = interactive ? (
            <UnstyledButton
              aria-label={curve.accessibleLabel ?? curve.label}
              aria-pressed={selected(selection, "curve", curve.id)}
              data-chart-curve-id={curve.id}
              data-selected={
                selected(selection, "curve", curve.id) || undefined
              }
              onClick={(event) => {
                onSelect?.(curveSelection);
                if (event.detail === 2) onEdit?.(curveSelection);
              }}
              onKeyDown={(event) => {
                if (reorderKey(event, "curve", curve.id)) return;
                if (event.key === "F2") {
                  event.preventDefault();
                  onSelect?.(curveSelection);
                  onEdit?.(curveSelection);
                }
              }}
              onPointerDown={(event) => {
                beginReorder(event, "curve", curve.id);
              }}
            >
              {legendContent}
            </UnstyledButton>
          ) : (
            <Group aria-label={curve.accessibleLabel ?? curve.label}>
              {legendContent}
            </Group>
          );
          return (
            <Group gap="xs" key={curve.id} role="listitem" wrap="nowrap">
              {selected(editing, "curve", curve.id) && selectionEditor ? (
                <SelectionTarget
                  editor={selectionEditor}
                  onClose={() => onEditClose?.()}
                  selection={curveSelection}
                >
                  {control}
                </SelectionTarget>
              ) : (
                control
              )}
              {curve.annotationCount !== undefined ? (
                <AnnotationTarget
                  annotation={curveSelection}
                  editor={annotationEditor}
                  onClose={() => {
                    setActiveAnnotation(undefined);
                    restoreAnnotationFocus(curveSelection);
                  }}
                  opened={
                    activeAnnotation?.kind === "curve" &&
                    activeAnnotation.id === curve.id
                  }
                >
                  <UnstyledButton
                    aria-label={annotationLabel(curve.annotationCount)}
                    className="myoxus-data-radar-annotation"
                    data-chart-annotation-id={curve.id}
                    data-chart-annotation-kind="curve"
                    onClick={(event) => {
                      event.stopPropagation();
                      onEditClose?.();
                      setActiveAnnotation(curveSelection);
                    }}
                  >
                    {curve.annotationCount}
                  </UnstyledButton>
                </AnnotationTarget>
              ) : null}
            </Group>
          );
        })}
      </Group>
    ) : null;
  return (
    <DataChartShell
      ariaDescription={ariaDescription}
      ariaLabel={ariaLabel}
      empty={!hasAxes}
      emptyAction={emptyAction}
      emptyLabel={emptyLabel}
      selectedId={selection?.id}
      summary={summary}
      testId="data-radar-chart"
    >
      <Stack
        gap="sm"
        onClickCapture={(event) => {
          if (!suppressReorderClickRef.current) return;
          suppressReorderClickRef.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDownCapture={() => {
          // A new physical gesture is never the synthetic click that follows
          // the preceding reorder pointerup.
          suppressReorderClickRef.current = false;
        }}
        onLostPointerCapture={(event) => {
          if (vertexPointerRef.current?.pointerId === event.pointerId)
            finishVertexPointer(false);
          else if (reorderRef.current?.pointerId === event.pointerId)
            finishReorder(false);
        }}
        ref={rootRef}
      >
        {legend}
        <div className="myoxus-data-radar-scroll-owner">
          <MantineRadarChart
            accessibilityLayer={interactive}
            className="myoxus-data-radar-chart-surface"
            data={data}
            // Recharts deduplicates equal category keys. Axis labels are allowed
            // to match, so only the stable axis identity may own geometry.
            dataKey="__axisId"
            radarChartProps={
              geometry
                ? {
                    margin: {
                      bottom: geometry.marginBottom,
                      left: geometry.marginLeft,
                      right: geometry.marginRight,
                      top: geometry.marginTop,
                    },
                    // Mermaid's Radar renderer uses min(width, height) / 2 for
                    // graticule and curves. The configured margins own label
                    // room; shrinking the polar radius for label text would
                    // make values and ticks diverge from exported Mermaid SVG.
                    outerRadius: "100%",
                  }
                : undefined
            }
            style={surfaceStyle}
            polarAngleAxisProps={{
              tick: (tickProps) => {
                const axis = axes[tickProps.index];
                if (!axis) return <g />;
                // Recharts supplies polar center coordinates to custom angle
                // ticks at runtime although its shared Cartesian tick type omits
                // them. Keep that renderer contract local to this projection.
                const polarTick = tickProps as typeof tickProps & {
                  readonly cx?: number;
                  readonly cy?: number;
                };
                const centerX = Number(polarTick.cx ?? 0);
                const centerY = Number(polarTick.cy ?? 0);
                const labelX =
                  centerX +
                  (Number(tickProps.x ?? 0) - centerX) *
                    (geometry?.axisLabelFactor ?? 1);
                const labelY =
                  centerY +
                  (Number(tickProps.y ?? 0) - centerY) *
                    (geometry?.axisLabelFactor ?? 1);
                const textAnchor = tickProps.textAnchor ?? "middle";
                const sideMargin =
                  textAnchor === "end"
                    ? geometry?.marginLeft
                    : textAnchor === "start"
                      ? geometry?.marginRight
                      : undefined;
                const labelLines = radarAxisLabelLines(
                  axis.label,
                  Math.max(
                    // Side labels own the configured margin plus the chart's
                    // centred shell slack. Wrap at word boundaries before the
                    // scroll owner clips an otherwise valid Mermaid label.
                    8,
                    Math.floor(
                      sideMargin === undefined ? 18 : (sideMargin + 36) / 7,
                    ),
                  ),
                );
                const axisSelection = { id: axis.id, kind: "axis" as const };
                const annotation =
                  axis.annotationCount !== undefined ? (
                    <AnnotationTarget
                      annotation={axisSelection}
                      editor={annotationEditor}
                      onClose={() => {
                        setActiveAnnotation(undefined);
                        restoreAnnotationFocus(axisSelection);
                      }}
                      opened={
                        activeAnnotation?.kind === "axis" &&
                        activeAnnotation.id === axis.id
                      }
                    >
                      <g
                        aria-label={annotationLabel(axis.annotationCount)}
                        className="myoxus-data-radar-annotation"
                        data-chart-annotation-id={axis.id}
                        data-chart-annotation-kind="axis"
                        onClick={(event) => {
                          event.stopPropagation();
                          onEditClose?.();
                          setActiveAnnotation(axisSelection);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ")
                            return;
                          event.preventDefault();
                          event.stopPropagation();
                          onEditClose?.();
                          setActiveAnnotation(axisSelection);
                        }}
                        role="button"
                        tabIndex={0}
                        transform={`translate(${labelX},${labelY})`}
                      >
                        <text
                          dominantBaseline="central"
                          textAnchor="middle"
                          y={16}
                        >
                          {axis.annotationCount}
                        </text>
                      </g>
                    </AnnotationTarget>
                  ) : null;
                const axisLine = (
                  <line
                    aria-hidden
                    className="myoxus-data-radar-axis-line"
                    stroke="var(--chart-grid-color)"
                    x1={centerX}
                    x2={
                      centerX +
                      (Number(tickProps.x ?? 0) - centerX) *
                        (geometry?.axisScaleFactor ?? 1)
                    }
                    y1={centerY}
                    y2={
                      centerY +
                      (Number(tickProps.y ?? 0) - centerY) *
                        (geometry?.axisScaleFactor ?? 1)
                    }
                  />
                );
                const control = (
                  <g
                    aria-label={axis.accessibleLabel ?? axis.label}
                    aria-pressed={
                      interactive
                        ? selected(selection, "axis", axis.id)
                        : undefined
                    }
                    data-chart-axis-id={axis.id}
                    data-selected={
                      selected(selection, "axis", axis.id) || undefined
                    }
                    onClick={
                      interactive
                        ? (event) => {
                            event.stopPropagation();
                            event.currentTarget.focus();
                            onSelect?.(axisSelection);
                            if (event.detail === 2) onEdit?.(axisSelection);
                          }
                        : undefined
                    }
                    onKeyDown={
                      interactive
                        ? (event) => {
                            if (reorderKey(event, "axis", axis.id)) return;
                            if (event.key === "F2") {
                              event.preventDefault();
                              onSelect?.(axisSelection);
                              onEdit?.(axisSelection);
                            } else if (
                              event.key === "Enter" ||
                              event.key === " "
                            ) {
                              event.preventDefault();
                              onSelect?.(axisSelection);
                            }
                          }
                        : undefined
                    }
                    onPointerDown={
                      interactive
                        ? (event) => beginReorder(event, "axis", axis.id)
                        : undefined
                    }
                    role={interactive ? "button" : undefined}
                    tabIndex={interactive ? 0 : undefined}
                    transform={`translate(${labelX},${labelY})`}
                  >
                    <text
                      aria-hidden
                      className="myoxus-data-radar-axis-label"
                      dominantBaseline="central"
                      textAnchor={textAnchor}
                    >
                      {labelLines.map((line, index) => (
                        <tspan
                          dy={
                            index === 0
                              ? `${-(labelLines.length - 1) * 0.6}em`
                              : "1.2em"
                          }
                          key={`${line}-${index}`}
                          x={0}
                        >
                          {line}
                        </tspan>
                      ))}
                    </text>
                  </g>
                );
                return (
                  <g>
                    {axisLine}
                    {selected(editing, "axis", axis.id) && selectionEditor ? (
                      <SelectionTarget
                        editor={selectionEditor}
                        onClose={() => onEditClose?.()}
                        selection={axisSelection}
                      >
                        {control}
                      </SelectionTarget>
                    ) : (
                      control
                    )}
                    {annotation}
                  </g>
                );
              },
            }}
            polarGridProps={{
              gridType: graticule,
              polarRadius: gridRadii,
              radialLines: false,
            }}
            polarRadiusAxisProps={{
              axisLine: false,
              domain: [minimum, maximum],
              tick: false,
              tickCount: Math.max(1, Math.min(32, ticks)),
            }}
            radarProps={(series) => {
              const curve = curves.find(
                (candidate) => candidate.id === series.name,
              )!;
              const partial = curve.vertices.some(
                (vertex) =>
                  vertex.state === "missing" || vertex.state === "duplicate",
              );
              return {
                // RadarVertexMarker is the single visible and interactive point.
                // Recharts' hover-only active dot otherwise overlays that marker
                // and prevents direct double-click, drag and keyboard ownership.
                activeDot: false,
                dataKey: curve.id,
                // Direct-manipulation previews must follow the pointer in the
                // current frame. Recharts' default series animation restarts
                // for every preview value and otherwise leaves the visible dot
                // behind the pointer until the gesture has already finished.
                isAnimationActive: !interactive,
                dot: (dotProps) => {
                  const axisId = String(dotProps.payload?.__axisId ?? "");
                  const axis = axes.find(
                    (candidate) => candidate.id === axisId,
                  );
                  const vertex = curve.vertices.find(
                    (candidate) => candidate.axisId === axisId,
                  );
                  if (!axis || !vertex) return <g />;
                  const displayedValue = radarDisplayedValue(
                    vertex,
                    minimum,
                    maximum,
                  );
                  const collidingCurveIds = curves.flatMap((candidate) => {
                    const candidateVertex = candidate.vertices.find(
                      (entry) => entry.axisId === axisId,
                    );
                    return radarDisplayedValue(
                      candidateVertex,
                      minimum,
                      maximum,
                    ) === displayedValue
                      ? [candidate.id]
                      : [];
                  });
                  const collisionIndex = collidingCurveIds.indexOf(curve.id);
                  const collisionOffset =
                    collisionIndex < 0 || collidingCurveIds.length < 2
                      ? 0
                      : (collisionIndex - (collidingCurveIds.length - 1) / 2) *
                        16;
                  return (
                    <RadarVertexMarker
                      axisCount={axes.length}
                      axisAccessibleLabel={axis.accessibleLabel ?? axis.label}
                      axisIndex={axes.findIndex(
                        (candidate) => candidate.id === axis.id,
                      )}
                      color={curve.color}
                      collisionOffset={collisionOffset}
                      curveId={curve.id}
                      curveAccessibleLabel={
                        curve.accessibleLabel ?? curve.label
                      }
                      cx={Number(dotProps.cx)}
                      cy={Number(dotProps.cy)}
                      gestureStep={
                        vertexKeyboardRef.current?.id === vertex.id
                          ? vertexKeyboardRef.current.step
                          : vertexPointerRef.current?.id === vertex.id
                            ? vertexPointerRef.current.step
                            : undefined
                      }
                      interactive={interactive}
                      key={vertex.id}
                      maximum={maximum}
                      minimum={minimum}
                      onEdit={onEdit}
                      onEditClose={onEditClose}
                      onKeyboardBlur={(vertexId, relatedTarget) => {
                        // A controlled value preview makes Recharts replace its
                        // SVG dot. That transient replacement reports no next
                        // focus target and must not cancel the keyboard gesture
                        // before Enter can commit it. Genuine pointer changes
                        // are cancelled by the capture listener above; Tab and
                        // other focus moves provide their concrete next target.
                        queueMicrotask(() => {
                          if (vertexKeyboardRef.current?.id !== vertexId)
                            return;
                          if (relatedTarget) {
                            cancelVertexKeyboard(false);
                            return;
                          }
                          focusVertex(vertexId);
                        });
                      }}
                      onPointerStart={(gesture) => {
                        cancelVertexPreviews();
                        cancelReorder();
                        vertexPointerRef.current = gesture;
                      }}
                      onSelect={onSelect}
                      onVertexKey={vertexKey}
                      readonly={readonly}
                      selected={selected(selection, "vertex", vertex.id)}
                      selectionEditor={
                        selected(editing, "vertex", vertex.id)
                          ? selectionEditor
                          : undefined
                      }
                      ticks={ticks}
                      valueFormatter={valueFormatter}
                      valueStepLabel={valueStepLabel}
                      vertexStateLabel={vertexStateLabel}
                      vertex={vertex}
                    />
                  );
                },
                fillOpacity: partial ? 0 : undefined,
                onClick: interactive
                  ? () => onSelect?.({ id: curve.id, kind: "curve" })
                  : undefined,
                onDoubleClick: interactive
                  ? () => onEdit?.({ id: curve.id, kind: "curve" })
                  : undefined,
                shape: !geometry
                  ? undefined
                  : (shapeProps: {
                      fill?: string;
                      fillOpacity?: number;
                      points?: readonly { x: number; y: number }[];
                      stroke?: string;
                      strokeOpacity?: number;
                      strokeWidth?: number;
                    }) => {
                      const points = shapeProps.points ?? [];
                      const path = radarCurvePath(
                        points,
                        geometry.curveTension,
                        graticule,
                      );
                      const curveSelection = {
                        id: curve.id,
                        kind: "curve" as const,
                      };
                      const control = interactive ? (
                        <path
                          aria-label={curve.accessibleLabel ?? curve.label}
                          aria-pressed={selected(selection, "curve", curve.id)}
                          className="myoxus-data-radar-curve-hitarea"
                          d={path}
                          data-chart-curve-id={curve.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            event.currentTarget.focus();
                            onSelect?.(curveSelection);
                            if (event.detail === 2) onEdit?.(curveSelection);
                          }}
                          onKeyDown={(event) => {
                            if (reorderKey(event, "curve", curve.id)) return;
                            if (event.key === "F2") {
                              event.preventDefault();
                              onSelect?.(curveSelection);
                              onEdit?.(curveSelection);
                            } else if (
                              event.key === "Enter" ||
                              event.key === " "
                            ) {
                              event.preventDefault();
                              onSelect?.(curveSelection);
                            }
                          }}
                          onPointerDown={(event) => {
                            beginReorder(event, "curve", curve.id);
                          }}
                          role="button"
                          tabIndex={0}
                        />
                      ) : null;
                      const annotationPoint = points[0];
                      return (
                        <g>
                          <path
                            aria-hidden
                            className="myoxus-data-radar-curve"
                            d={path}
                            data-partial={partial || undefined}
                            data-selected={
                              selected(selection, "curve", curve.id) ||
                              undefined
                            }
                            fill={shapeProps.fill}
                            fillOpacity={
                              partial
                                ? 0
                                : (shapeProps.fillOpacity ??
                                  MANTINE_RADAR_AREA_OPACITY)
                            }
                            stroke={shapeProps.stroke}
                            strokeOpacity={
                              partial ? 0 : shapeProps.strokeOpacity
                            }
                            strokeWidth={shapeProps.strokeWidth}
                          />
                          {!showLegend &&
                          control &&
                          selected(editing, "curve", curve.id) &&
                          selectionEditor ? (
                            <SelectionTarget
                              editor={selectionEditor}
                              onClose={() => onEditClose?.()}
                              selection={curveSelection}
                            >
                              {control}
                            </SelectionTarget>
                          ) : (
                            control
                          )}
                          {!showLegend &&
                          curve.annotationCount !== undefined &&
                          annotationPoint ? (
                            <AnnotationTarget
                              annotation={curveSelection}
                              editor={annotationEditor}
                              onClose={() => {
                                setActiveAnnotation(undefined);
                                restoreAnnotationFocus(curveSelection);
                              }}
                              opened={
                                activeAnnotation?.kind === "curve" &&
                                activeAnnotation.id === curve.id
                              }
                            >
                              <g
                                aria-label={annotationLabel(
                                  curve.annotationCount,
                                )}
                                className="myoxus-data-radar-annotation"
                                data-chart-annotation-id={curve.id}
                                data-chart-annotation-kind="curve"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onEditClose?.();
                                  setActiveAnnotation(curveSelection);
                                }}
                                onKeyDown={(event) => {
                                  if (
                                    event.key !== "Enter" &&
                                    event.key !== " "
                                  )
                                    return;
                                  event.preventDefault();
                                  event.stopPropagation();
                                  onEditClose?.();
                                  setActiveAnnotation(curveSelection);
                                }}
                                role="button"
                                tabIndex={0}
                                transform={`translate(${annotationPoint.x + 8},${annotationPoint.y - 8})`}
                              >
                                <text
                                  dominantBaseline="central"
                                  textAnchor="middle"
                                >
                                  {curve.annotationCount}
                                </text>
                              </g>
                            </AnnotationTarget>
                          ) : null}
                        </g>
                      );
                    },
                strokeOpacity: partial ? 0 : undefined,
              };
            }}
            series={curves.map((curve) => ({
              color: curve.color,
              label: curve.label,
              name: curve.id,
            }))}
            tooltipProps={{
              content: ({ payload }) => {
                const axisId = String(payload?.[0]?.payload?.__axisId ?? "");
                const axis = axes.find((candidate) => candidate.id === axisId);
                if (!axis) return null;
                return (
                  <Paper p="xs" shadow="sm" withBorder>
                    <Stack gap="xs">
                      <Text fw={500} size="sm">
                        {axis.label}
                      </Text>
                      {curves.map((curve) => {
                        const vertex = curve.vertices.find(
                          (candidate) => candidate.axisId === axis.id,
                        );
                        return (
                          <Group gap="xs" key={curve.id} wrap="nowrap">
                            <ThemeIcon
                              aria-hidden
                              color={curve.color}
                              size="xs"
                              variant="filled"
                            />
                            <Text size="sm">
                              {curve.label}:{" "}
                              {vertex?.value === undefined
                                ? "–"
                                : valueFormatter(vertex.value)}
                            </Text>
                          </Group>
                        );
                      })}
                    </Stack>
                  </Paper>
                );
              },
            }}
            withDots
            withLegend={false}
            withPolarRadiusAxis
            withTooltip={interactive}
          />
        </div>
        {!hasCurves ? (
          <Stack align="center" gap="sm">
            <Text c="dimmed">{emptyLabel}</Text>
            {emptyAction}
          </Stack>
        ) : null}
      </Stack>
    </DataChartShell>
  );
}
