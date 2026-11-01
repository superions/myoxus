// SPDX-License-Identifier: AGPL-3.0-or-later

import { Box, Group, Popover, Stack, Text } from "@mantine/core";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useResponsiveElementSize } from "../../responsive";
import { PrimaryScrollArea } from "../primary-scroll-area";
import { GanttAxis } from "./gantt-axis";
import { GanttDependencies, GanttEndpointRail } from "./gantt-dependencies";
import { GanttOverlays } from "./gantt-overlays";
import { GanttSectionList } from "./gantt-section-list";
import { GanttTaskBar } from "./gantt-task";
import {
  ganttAxisWidth,
  ganttLayout,
  type GanttLayoutEntry,
  ganttSurfaceHeight,
  ganttValueToOffset,
  ganttOffsetToValue,
  ganttSnapValue,
  GANTT_AXIS_HEADER_HEIGHT,
  GANTT_ROW_HEIGHT,
  GANTT_SECTION_HEADER_HEIGHT,
  GANTT_PINNED_LABEL_WIDTH,
  GANTT_MINIMUM_BAR_WIDTH,
} from "./geometry";

export type GanttAxisProjection = {
  start: number;
  end: number;
  step: number;
  ticks: ReadonlyArray<{ label: string; value: number }>;
  valueLabel: (value: number) => string;
};

export type GanttCapability = { enabled: boolean; reason?: string };

export type GanttSectionView = {
  id: string;
  label: string;
  order: number;
  selected?: boolean;
  count?: number;
  collapsed?: boolean;
};

export type GanttMetadataColumnView = { id: string; label: string };

export type GanttTaskView = {
  id: string;
  sectionId: string;
  label: string;
  /** Optional pinned content; semantic text remains the accessible bar name. */
  labelContent?: ReactNode;
  labelAccessory?: ReactNode;
  pending?: boolean;
  metadata?: Readonly<Record<string, ReactNode>>;
  /** Full resolved interval, including nonzero-duration milestones. */
  start: number;
  end: number;
  milestone?: boolean;
  /** Draw the actual span separately from its minimum pointer hit area. */
  preciseRange?: boolean;
  statuses?: readonly string[];
  selected?: boolean;
  description?: string;
  move?: GanttCapability;
  resize?: GanttCapability & { edges?: ReadonlyArray<"start" | "end"> };
  connect?: GanttCapability;
  laneMove?: GanttCapability;
  /** Per-gesture geometry increments; omitted values use the axis step. */
  steps?: { move?: number; start?: number; end?: number };
};

/** Pinned content without a fabricated schedule or bar. */
export type GanttListRowView = Pick<
  GanttTaskView,
  | "id"
  | "sectionId"
  | "label"
  | "labelContent"
  | "labelAccessory"
  | "pending"
  | "metadata"
  | "selected"
  | "statuses"
> & {
  notice?: ReactNode;
  /** A pinned row can own a connection endpoint without schedule geometry. */
  connectEndpoint?: GanttCapability;
};

/** A labeled geometry anchor for an endpoint outside the visible task set. */
export type GanttExternalEndpointView = {
  id: string;
  label: string;
  anchorTaskId: string;
  side: "start" | "end";
  available: boolean;
  /** Suppress duplicate chrome when a pinned row already labels this boundary. */
  renderLabel?: boolean;
};

export type GanttDependencyView = {
  id: string;
  fromTaskId: string;
  toTaskId: string;
  kind: "after" | "until" | "previous" | "connection";
  edit?: GanttCapability;
  selected?: boolean;
  implicit?: boolean;
  preview?: boolean;
};

export type GanttMarkerView = {
  id: string;
  value: number;
  /** Logical interval end; a vertical line need not denote a zero-length task. */
  end?: number;
  label: string;
  selected?: boolean;
  /** A `vert` marker is a real object, so it carries its own capabilities. */
  move?: GanttCapability;
  description?: string;
};

/** Comment badge anchored to a task or section row of the surface. */
export type GanttCommentAnchorView = {
  id: string;
  objectId: string;
  text: string;
  count: number;
};

export type GanttExcludedBand = { id: string; start: number; end: number };

export type GanttDiagnosticView = {
  id: string;
  message: string;
  taskId?: string;
  sectionId?: string;
};

export type GanttMarkerIntent = {
  markerId: string;
  /** Preview/committed time value for the marker line. */
  value: number;
  mode: "move";
};

export type GanttMoveIntent = {
  taskId: string;
  start: number;
  end: number;
  mode: "move" | "resize-start" | "resize-end";
  /** Pointer y at commit, resolved into a lane by the surface. */
  pointerY?: number;
  targetLaneId?: string;
  targetOrder?: number;
};

export type GanttViewLabels = {
  empty: string;
  reorderSection: string;
  reorderTask: string;
  region: string;
  row?: string;
  connectTask?: string;
  deleteDependency?: string;
};

/** A placement preview has no persistent task identity before confirmation. */
export type GanttCreateDraft = {
  sectionId: string;
  start: number;
  end?: number;
};

export type GanttViewProps = {
  axis: GanttAxisProjection;
  sections: readonly GanttSectionView[];
  tasks: readonly GanttTaskView[];
  /** Complete display order with intrinsic labels, including untimed rows. */
  pinnedRows?: readonly GanttListRowView[];
  metadataColumns?: readonly GanttMetadataColumnView[];
  dependencies?: readonly GanttDependencyView[];
  externalEndpoints?: readonly GanttExternalEndpointView[];
  showDependenciesWhenReadonly?: boolean;
  onOpenExternalEndpoint?: (endpointId: string) => void;
  markers?: readonly GanttMarkerView[];
  commentAnchors?: readonly GanttCommentAnchorView[];
  onOpenComment?: (anchor: GanttCommentAnchorView) => void;
  excludedBands?: readonly GanttExcludedBand[];
  diagnostics?: readonly GanttDiagnosticView[];
  readonly?: boolean;
  /** Defaults retain the established direct label-edit activation. */
  taskActivation?: { enter: "open" | "rename"; doubleClick: "open" | "rename" };
  reorder?: { sections: GanttCapability; tasks: GanttCapability };
  toolbar?: ReactNode;
  empty?: ReactNode;
  labels: GanttViewLabels;
  selectedDependencyId?: string | null;
  popover?: ReactNode;
  placement?: {
    active: boolean;
    enabled: boolean;
    step: number;
    draft: GanttCreateDraft | null;
    content?: ReactNode;
    onPreview: (draft: GanttCreateDraft) => void;
    onChoose: () => void;
    onCancel: () => void;
  };
  onCreateTask?: (sectionId: string, start: number, milestone: boolean) => void;
  onSelectTask?: (taskId: string | null) => void;
  onSelectSection?: (sectionId: string) => void;
  onToggleSection?: (sectionId: string, collapsed: boolean) => void;
  onOpenTask?: (taskId: string) => void;
  onRenameTask?: (taskId: string) => void;
  onBeginMove?: (intent: GanttMoveIntent) => void;
  /** Keep the active gesture's source mounted across authoritative reprojection. */
  retainMoveSource?: boolean;
  onPreviewMove?: (intent: GanttMoveIntent | null) => void;
  onCommitMove?: (intent: GanttMoveIntent) => void;
  onCancelMove?: () => void;
  onSelectDependency?: (dependencyId: string) => void;
  onBeginDependency?: (
    intent:
      | { kind: "create"; sourceTaskId: string }
      | {
          kind: "reconnect";
          dependencyId: string;
          endpoint: "source" | "target";
        },
  ) => void;
  onCreateDependency?: (fromTaskId: string, toTaskId: string) => void;
  onReconnectDependency?: (
    dependencyId: string,
    end: "source" | "target",
    taskId: string,
  ) => void;
  onDeleteDependency?: (dependencyId: string) => void;
  onDeleteSelection?: (taskId: string) => void;
  onSelectMarker?: (markerId: string | null) => void;
  onOpenMarker?: (markerId: string) => void;
  onRenameMarker?: (markerId: string) => void;
  onPreviewMarker?: (intent: GanttMarkerIntent | null) => void;
  onCommitMarker?: (intent: GanttMarkerIntent) => void;
  onDeleteMarker?: (markerId: string) => void;
  popoverAnchorTaskId?: string | null;
  /** Explicit dependency mode: the next two bar clicks create one edge. */
  connectMode?: boolean;
  onConnectModeChange?: (active: boolean) => void;
  onReorderSection?: (sectionId: string, targetOrder: number) => void;
  onReorderTask?: (
    taskId: string,
    targetSectionId: string,
    targetOrder: number,
  ) => void;
  "data-testid"?: string;
};

/**
 * Product-neutral Gantt surface. Consumers supply resolved schedule values,
 * capabilities and localized labels; the view owns axis, row, bar, marker and
 * dependency geometry plus typed interaction intents only.
 */
/** True when the pointer row differs from the current lane or row order. */
function laneChanged(
  lane: GanttMoveIntent,
  rows: readonly { task: GanttTaskView }[],
  taskId: string,
) {
  const index = rows.findIndex((entry) => entry.task.id === taskId);
  const current = rows[index];
  if (!current || !lane.targetLaneId) return false;
  if (lane.targetLaneId !== current.task.sectionId) return true;
  const localIndex = rows
    .slice(0, index)
    .filter((entry) => entry.task.sectionId === current.task.sectionId).length;
  return lane.targetOrder !== undefined && lane.targetOrder !== localIndex;
}

/** Row offset of the prospective drop position for a reorder preview. */
function targetRowOffset(
  layout: readonly GanttLayoutEntry[],
  lane: GanttMoveIntent,
) {
  const tasks = layout.filter(
    (e) => e.kind === "task" && e.sectionId === lane.targetLaneId,
  );
  const index = lane.targetOrder ?? tasks.length - 1;
  const target = tasks[Math.max(0, Math.min(index, tasks.length - 1))];
  return target
    ? target.offset
    : (layout.find(
        (entry) =>
          entry.kind === "section" && entry.sectionId === lane.targetLaneId,
      )?.offset ?? 0);
}

export function GanttView({
  axis,
  sections: currentSections,
  tasks: currentTasks,
  pinnedRows: suppliedPinnedRows,
  metadataColumns = [],
  dependencies = [],
  externalEndpoints = [],
  showDependenciesWhenReadonly = false,
  onOpenExternalEndpoint,
  markers = [],
  commentAnchors = [],
  onOpenComment,
  excludedBands = [],
  diagnostics = [],
  readonly = false,
  taskActivation,
  reorder,
  toolbar,
  empty,
  labels,
  selectedDependencyId = null,
  popover,
  popoverAnchorTaskId = null,
  connectMode = false,
  onConnectModeChange,
  onCreateTask,
  placement,
  onSelectTask,
  onSelectSection,
  onToggleSection,
  onOpenTask,
  onRenameTask,
  onPreviewMove,
  onBeginMove,
  retainMoveSource = false,
  onCommitMove,
  onCancelMove,
  onSelectDependency,
  onCreateDependency,
  onBeginDependency,
  onReconnectDependency,
  onDeleteDependency,
  onDeleteSelection,
  onSelectMarker,
  onOpenMarker,
  onRenameMarker,
  onPreviewMarker,
  onCommitMarker,
  onDeleteMarker,
  onReorderSection,
  onReorderTask,
  "data-testid": dataTestId,
}: GanttViewProps) {
  const currentPinnedRows = suppliedPinnedRows ?? currentTasks;
  // Explicit data rows must remain readable even without metadata columns.
  // Omitted rows retain the compact geometry of schedule-only consumers.
  const intrinsicLabels =
    suppliedPinnedRows !== undefined || metadataColumns.length > 0;
  const viewport = useResponsiveElementSize<HTMLDivElement>();
  const [moveSource, setMoveSource] = useState<{
    task: GanttTaskView;
    row: GanttListRowView;
    section: GanttSectionView;
    index: number;
  } | null>(null);
  // The retained object is an uncommitted gesture, never server confirmation.
  // Keeping its keyed bar mounted preserves the opening basis and keyboard
  // focus when a concurrent membership change removes that visual copy.
  const retained = retainMoveSource && !readonly ? moveSource : null;
  const tasks = useMemo(
    () =>
      retained && !currentTasks.some((task) => task.id === retained.task.id)
        ? [...currentTasks, retained.task]
        : currentTasks,
    [currentTasks, retained],
  );
  const pinnedRows = useMemo(
    () =>
      retained && !currentPinnedRows.some((row) => row.id === retained.row.id)
        ? [
            ...currentPinnedRows.slice(0, retained.index),
            retained.row,
            ...currentPinnedRows.slice(retained.index),
          ]
        : currentPinnedRows,
    [currentPinnedRows, retained],
  );
  const sections = useMemo(
    () =>
      retained &&
      !currentSections.some((section) => section.id === retained.section.id)
        ? [...currentSections, retained.section]
        : currentSections,
    [currentSections, retained],
  );
  const [tickWidth, setTickWidth] = useState(96);
  const [rowHeight, setRowHeight] = useState(GANTT_ROW_HEIGHT);
  const [headerHeight, setHeaderHeight] = useState(GANTT_AXIS_HEADER_HEIGHT);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [reorderPreview, setReorderPreview] = useState<{
    offset: number;
    taskId: string;
  } | null>(null);
  const [reconnect, setReconnect] = useState<{
    dependencyId: string;
    end: "source" | "target";
  } | null>(null);
  useEffect(() => {
    if (readonly) {
      setConnectFrom(null);
      setReconnect(null);
      setReorderPreview(null);
      setMoveSource(null);
    }
  }, [readonly]);
  const width = ganttAxisWidth(
    { ...axis, zoom: "day" },
    viewport.width,
    tickWidth,
  );
  const orderedSections = useMemo(
    () => [...sections].sort((a, b) => a.order - b.order),
    [sections],
  );
  const layout = useMemo(
    () => ganttLayout(orderedSections, pinnedRows, rowHeight),
    [orderedSections, pinnedRows, rowHeight],
  );
  const rows = useMemo(
    () =>
      layout
        .filter((entry) => entry.kind === "task")
        .map((entry) => ({
          offset: entry.offset,
          section: orderedSections.find(
            (section) => section.id === entry.sectionId,
          )!,
          task: tasks.find((task) => task.id === entry.taskId)!,
        }))
        .filter((entry) => entry.section && entry.task),
    [layout, orderedSections, tasks],
  );
  const listRows = useMemo(
    () =>
      layout
        .filter((entry) => entry.kind === "task")
        .map((entry) => ({
          offset: entry.offset,
          section: orderedSections.find(
            (section) => section.id === entry.sectionId,
          )!,
          task: pinnedRows.find((row) => row.id === entry.taskId)!,
        }))
        .filter((entry) => entry.section && entry.task),
    [layout, orderedSections, pinnedRows],
  );
  const placementPointer = useRef<{
    startX: number;
    draft: GanttCreateDraft;
  } | null>(null);
  const placementPreviewRef = useRef<HTMLDivElement>(null);
  const placementKeyboard = useRef(false);
  const creationPopoverOpen = Boolean(placement?.content);
  useLayoutEffect(() => {
    if (
      !placement?.draft ||
      (!placementKeyboard.current && !creationPopoverOpen)
    )
      return;
    placementKeyboard.current = false;
    // Native scroll ownership keeps the keyboard target inside the time
    // viewport so Mantine does not hide its detached creation popover.
    placementPreviewRef.current?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [placement?.draft, creationPopoverOpen, axis.start, axis.end]);
  const placementValue = (clientX: number) => {
    const rect = bodyRef.current?.getBoundingClientRect();
    return ganttSnapValue(
      ganttOffsetToValue(axis, clientX - (rect?.left ?? 0), width),
      placement?.step ?? axis.step,
    );
  };
  const placementAt = (
    clientX: number,
    clientY: number,
  ): GanttCreateDraft | null => {
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const y = clientY - rect.top;
    const bands = layout.filter((entry) => entry.kind === "section");
    const section = bands.find(
      (entry, index) =>
        y >= entry.offset && y < (bands[index + 1]?.offset ?? surfaceHeight),
    );
    return section
      ? { sectionId: section.sectionId, start: placementValue(clientX) }
      : null;
  };
  useEffect(() => {
    if (placement?.active && !placement.draft) bodyRef.current?.focus();
    if (!placement?.active) placementPointer.current = null;
  }, [placement?.active, placement?.draft]);
  const offsetByTaskId = useMemo(
    () =>
      new Map(
        layout
          .filter((entry) => entry.kind === "task")
          // Overlays and bars share the body below the axis header. Adding
          // the header again shifts edges and hides the last row's popover.
          .map((entry) => [entry.taskId, entry.offset]),
      ),
    [layout],
  );
  // Comment badges anchor to either column member, so both share one map.
  const offsetById = useMemo(
    () =>
      new Map(
        layout.map((entry) => [
          entry.kind === "task" ? entry.taskId : entry.sectionId,
          entry.offset,
        ]),
      ),
    [layout],
  );
  const tasksById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const endpointsById = useMemo(
    () =>
      new Map<
        string,
        GanttTaskView | GanttMarkerView | GanttExternalEndpointView
      >(
        [...tasks, ...markers, ...externalEndpoints].map((object) => [
          object.id,
          object,
        ]),
      ),
    [tasks, markers, externalEndpoints],
  );
  const connectTarget = (taskId: string) => {
    if (readonly || tasksById.get(taskId)?.connect?.enabled === false) return;
    if (reconnect) {
      onReconnectDependency?.(reconnect.dependencyId, reconnect.end, taskId);
      setReconnect(null);
      return;
    }
    if (!connectFrom && connectMode) {
      setConnectFrom(taskId);
      return;
    }
    if (connectFrom && connectFrom !== taskId)
      onCreateDependency?.(connectFrom, taskId);
    setConnectFrom(null);
    onConnectModeChange?.(false);
  };
  const anchorTask = tasksById.get(popoverAnchorTaskId ?? "");
  const anchorDependency = dependencies.find(
    (dependency) =>
      dependency.id === selectedDependencyId &&
      (dependency.fromTaskId === popoverAnchorTaskId ||
        dependency.toTaskId === popoverAnchorTaskId),
  );
  const anchorTop =
    offsetByTaskId.get(popoverAnchorTaskId ?? "") ??
    (anchorDependency
      ? (offsetByTaskId.get(anchorDependency.fromTaskId) ??
        offsetByTaskId.get(anchorDependency.toTaskId))
      : undefined) ??
    0;
  const anchorValue = anchorTask
    ? anchorTask.milestone
      ? (anchorTask.start + anchorTask.end) / 2
      : anchorTask.start
    : (markers.find((marker) => marker.id === popoverAnchorTaskId)?.value ??
      axis.start);
  const anchorLeft =
    ganttValueToOffset(axis, anchorValue, width) -
    (anchorTask?.milestone ? GANTT_MINIMUM_BAR_WIDTH / 2 : 0);
  const anchorWidth = anchorTask?.milestone
    ? GANTT_MINIMUM_BAR_WIDTH
    : Math.max(
        GANTT_MINIMUM_BAR_WIDTH,
        ganttValueToOffset(axis, anchorTask?.end ?? anchorValue, width) -
          anchorLeft,
      );
  const bodyRef = useRef<HTMLDivElement>(null);
  const tickMeasurementKey = JSON.stringify(
    axis.ticks.map((tick) => tick.label),
  );
  useLayoutEffect(() => {
    if (!intrinsicLabels) {
      setTickWidth(96);
      return;
    }
    const root = bodyRef.current?.parentElement;
    if (!root) return;
    const ticks = [
      ...root.querySelectorAll<HTMLElement>(
        '[data-myoxus-ui-role="gantt-axis-tick"]',
      ),
    ];
    const measure = () =>
      setTickWidth(
        Math.ceil(
          Math.max(
            0,
            ...ticks.map((tick) => tick.getBoundingClientRect().width),
          ),
        ),
      );
    const observer = new ResizeObserver(measure);
    ticks.forEach((tick) => observer.observe(tick));
    measure();
    return () => observer.disconnect();
  }, [tickMeasurementKey, intrinsicLabels]);
  /**
   * A vertical drag target is read from the rendered row rectangles, so the
   * drop lane and its order stay correct while the surface scrolls.
   */
  const withLane = (intent: GanttMoveIntent): GanttMoveIntent => {
    if (intent.mode !== "move") return intent;
    if (tasksById.get(intent.taskId)?.laneMove?.enabled === false)
      return intent;
    const body = bodyRef.current;
    const y = intent.pointerY;
    if (!body || y === null || y === undefined) return intent;
    if (reorder?.tasks.enabled === false) {
      const localY = y - body.getBoundingClientRect().top;
      const bands = layout.filter((entry) => entry.kind === "section");
      const hit = bands.find(
        (entry, index) =>
          localY >= entry.offset &&
          localY <
            (bands[index + 1]?.offset ?? body.getBoundingClientRect().height),
      );
      return hit ? { ...intent, targetLaneId: hit.sectionId } : intent;
    }
    const lanes = Array.from(
      body.querySelectorAll(`[data-myoxus-ui-role="gantt-row"]`),
    ) as HTMLElement[];
    if (!lanes.length) return intent;
    const rects = lanes.map((row) => row.getBoundingClientRect());
    let hit = rects.findIndex((rect) => y >= rect.top && y < rect.bottom);
    if (hit < 0) {
      hit = rects.reduce((best, rect, key) => {
        const near = Math.abs((rect.top + rect.bottom) / 2 - y);
        const cur = rects[best];
        return near < Math.abs((cur.top + cur.bottom) / 2 - y) ? key : best;
      }, 0);
    }
    const lane = lanes[hit].dataset.sectionId;
    if (!lane) return intent;
    const order = lanes
      .slice(0, hit)
      .filter((row) => row.dataset.sectionId === lane).length;
    return { ...intent, targetLaneId: lane, targetOrder: order };
  };
  const surfaceHeight = ganttSurfaceHeight(layout, rowHeight, headerHeight);
  const beginConnection = (taskId: string) => {
    if (readonly || reconnect) return;
    onBeginDependency?.({ kind: "create", sourceTaskId: taskId });
    setConnectFrom(taskId);
  };
  const cssVars = {
    "--myoxus-gantt-axis-header-height": `${headerHeight}px`,
    "--myoxus-gantt-axis-width": `${width}px`,
    // The pinned column yields to the time surface on narrow workareas without
    // any product-side breakpoint logic.
    "--myoxus-gantt-label-width": intrinsicLabels
      ? "45%"
      : `clamp(7rem, 45%, ${GANTT_PINNED_LABEL_WIDTH}px)`,
    "--myoxus-gantt-minimum-bar-width": `${GANTT_MINIMUM_BAR_WIDTH}px`,
    "--myoxus-gantt-row-height": `${rowHeight}px`,
  } as CSSProperties;

  if (!tasks.length && !sections.length) {
    return (
      <Stack data-testid={dataTestId} gap="sm">
        {toolbar}
        {empty ?? <Text c="dimmed">{labels.empty}</Text>}
      </Stack>
    );
  }

  return (
    <Stack
      data-myoxus-editor-keyboard-owner="gantt"
      data-testid={dataTestId}
      gap="sm"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          (connectFrom || reconnect || connectMode)
        ) {
          event.preventDefault();
          event.stopPropagation();
          setConnectFrom(null);
          setReconnect(null);
          onConnectModeChange?.(false);
        }
      }}
    >
      {toolbar}
      <Box data-myoxus-ui-role="gantt-grid" style={cssVars}>
        <GanttSectionList
          labels={labels}
          intrinsicLabels={intrinsicLabels}
          metadataColumns={metadataColumns}
          rowHeight={rowHeight}
          headerHeight={headerHeight}
          onMeasureRows={setRowHeight}
          onMeasureHeader={setHeaderHeight}
          onSelectSection={onSelectSection}
          onConnectTask={beginConnection}
          onToggleSection={onToggleSection}
          selectedSectionId={
            sections.find((section) => section.selected)?.id ?? null
          }
          onReorderSection={(sectionId, targetOrder) =>
            onReorderSection?.(sectionId, targetOrder)
          }
          onReorderTask={(taskId, targetSectionId, targetOrder) =>
            onReorderTask?.(taskId, targetSectionId, targetOrder)
          }
          readonly={readonly}
          reorder={reorder}
          onRenameTask={onRenameTask}
          onDeleteTask={onDeleteSelection}
          onOpenTask={
            taskActivation?.enter === "open"
              ? (id) => {
                  if (connectFrom || reconnect) connectTarget(id);
                  else onOpenTask?.(id);
                }
              : undefined
          }
          onSelectTask={(id) => {
            if (connectFrom || reconnect) connectTarget(id);
            else onSelectTask?.(id);
          }}
          rows={listRows}
          sections={orderedSections}
          selectedTaskId={pinnedRows.find((task) => task.selected)?.id ?? null}
        />
        <PrimaryScrollArea
          data-myoxus-ui-role="gantt-axis-scroll"
          viewportRef={viewport.ref}
        >
          <Group wrap="nowrap" gap={0} align="stretch">
            {externalEndpoints.some(
              (endpoint) =>
                endpoint.side === "start" && endpoint.renderLabel !== false,
            ) ? (
              <GanttEndpointRail
                endpoints={externalEndpoints.filter(
                  (endpoint) =>
                    endpoint.side === "start" && endpoint.renderLabel !== false,
                )}
                offsetByTaskId={offsetByTaskId}
                onOpen={onOpenExternalEndpoint}
                width={GANTT_PINNED_LABEL_WIDTH}
                height={surfaceHeight}
                rowHeight={rowHeight}
                headerHeight={headerHeight}
              />
            ) : null}
            <Box style={{ minHeight: surfaceHeight }}>
              <GanttAxis axis={axis} width={width} />
              <Box
                ref={bodyRef}
                tabIndex={placement?.enabled ? 0 : undefined}
                aria-label={placement ? labels.region : undefined}
                onPointerDownCapture={(event) => {
                  if (
                    !placement?.active ||
                    !placement.enabled ||
                    placement.content
                  )
                    return;
                  if (
                    (event.target as HTMLElement).closest(
                      '[data-testid^="gantt-bar-"]',
                    )
                  )
                    return;
                  const draft = placementAt(event.clientX, event.clientY);
                  if (!draft) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  placementKeyboard.current = false;
                  placementPointer.current = { startX: event.clientX, draft };
                  placement.onPreview(draft);
                }}
                onPointerMove={(event) => {
                  const pick = placementPointer.current;
                  if (!pick || !placement) return;
                  const end = placementValue(event.clientX);
                  placement.onPreview(
                    Math.abs(event.clientX - pick.startX) < 4
                      ? pick.draft
                      : {
                          sectionId: pick.draft.sectionId,
                          start: Math.min(pick.draft.start, end),
                          end: Math.max(pick.draft.start, end),
                        },
                  );
                }}
                onPointerUp={(event) => {
                  if (!placementPointer.current || !placement) return;
                  placementPointer.current = null;
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  placement.onChoose();
                }}
                onPointerCancel={() => {
                  placementPointer.current = null;
                  placement?.onCancel();
                }}
                onLostPointerCapture={() => {
                  if (placementPointer.current) {
                    placementPointer.current = null;
                    placement?.onCancel();
                  }
                }}
                onDoubleClick={(event) => {
                  if (
                    !placement?.enabled ||
                    (event.target as HTMLElement).closest(
                      '[data-testid^="gantt-bar-"]',
                    )
                  )
                    return;
                  const draft = placementAt(event.clientX, event.clientY);
                  if (draft) {
                    event.stopPropagation();
                    placementKeyboard.current = false;
                    placement.onPreview(draft);
                    placement.onChoose();
                  }
                }}
                onKeyDown={(event) => {
                  if (
                    !placement?.active ||
                    event.target !== event.currentTarget
                  )
                    return;
                  if (event.key === "Escape") {
                    event.preventDefault();
                    placement.onCancel();
                    return;
                  }
                  const draft = placement.draft ?? {
                    sectionId: orderedSections[0]?.id ?? "",
                    start: axis.start,
                  };
                  if (!draft.sectionId) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    placementKeyboard.current = true;
                    placement.onPreview(draft);
                    placement.onChoose();
                    return;
                  }
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    placementKeyboard.current = true;
                    const delta =
                      (event.key === "ArrowLeft" ? -1 : 1) * placement.step;
                    placement.onPreview(
                      event.shiftKey
                        ? {
                            ...draft,
                            end: Math.max(
                              draft.start,
                              (draft.end ?? draft.start) + delta,
                            ),
                          }
                        : {
                            ...draft,
                            start: Math.max(
                              axis.start,
                              Math.min(axis.end, draft.start + delta),
                            ),
                            end:
                              draft.end === undefined
                                ? undefined
                                : draft.end + delta,
                          },
                    );
                  } else if (
                    event.key === "ArrowUp" ||
                    event.key === "ArrowDown"
                  ) {
                    event.preventDefault();
                    const index = orderedSections.findIndex(
                      (section) => section.id === draft.sectionId,
                    );
                    const section =
                      orderedSections[
                        index + (event.key === "ArrowUp" ? -1 : 1)
                      ];
                    if (section) {
                      placementKeyboard.current = true;
                      placement.onPreview({ ...draft, sectionId: section.id });
                    }
                  }
                }}
                style={{
                  position: "relative",
                  minHeight: surfaceHeight - headerHeight,
                }}
              >
                {excludedBands.map((band) => (
                  <Box
                    data-myoxus-ui-role="gantt-excluded-band"
                    key={band.id}
                    style={{
                      insetBlockSize: "100%",
                      insetInlineStart: ganttValueToOffset(
                        axis,
                        band.start,
                        width,
                      ),
                      inlineSize: Math.max(
                        0,
                        ganttValueToOffset(axis, band.end, width) -
                          ganttValueToOffset(axis, band.start, width),
                      ),
                      position: "absolute",
                    }}
                  />
                ))}
                {axis.ticks.map((tick) => (
                  <Box
                    data-myoxus-ui-role="gantt-gridline"
                    key={`grid-${tick.value}`}
                    style={{
                      insetBlockSize: "100%",
                      insetInlineStart: ganttValueToOffset(
                        axis,
                        tick.value,
                        width,
                      ),
                      position: "absolute",
                    }}
                  />
                ))}
                {layout
                  .filter((entry) => entry.kind === "section")
                  .map((entry) => (
                    <Box
                      data-myoxus-ui-role="gantt-section-band"
                      key={`band-${entry.sectionId}`}
                      style={{
                        background: "var(--myoxus-background-secondary-color)",
                        blockSize: GANTT_SECTION_HEADER_HEIGHT,
                        insetBlockStart: entry.offset,
                        inlineSize: "100%",
                        position: "absolute",
                      }}
                    />
                  ))}
                {listRows.map((row) => (
                  <Box
                    data-myoxus-ui-role="gantt-row"
                    data-section-id={row.section.id}
                    key={`${row.section.id}-${row.task.id}`}
                    onDoubleClick={(event) => {
                      if (readonly || !onCreateTask) return;
                      const rect = (
                        event.currentTarget as HTMLElement
                      ).getBoundingClientRect();
                      onCreateTask(
                        row.section.id,
                        axis.start +
                          ((event.clientX - rect.left) /
                            Math.max(1, rect.width)) *
                            (axis.end - axis.start),
                        false,
                      );
                    }}
                    onPointerDown={() => onSelectTask?.(row.task.id)}
                    style={{
                      blockSize: rowHeight,
                      insetBlockStart: row.offset,
                      inlineSize: "100%",
                      position: "absolute",
                    }}
                  />
                ))}
                {rows.map((row) => (
                  <GanttTaskBar
                    activation={taskActivation}
                    axis={axis}
                    connectMode={connectMode}
                    connecting={connectFrom !== null || reconnect !== null}
                    connectLabel={labels.connectTask}
                    key={row.task.id}
                    onCancel={() => {
                      setMoveSource(null);
                      onCancelMove?.();
                    }}
                    onBegin={(intent) => {
                      if (retainMoveSource) {
                        const pinned = pinnedRows.find(
                          (item) => item.id === row.task.id,
                        );
                        if (pinned)
                          setMoveSource({
                            task: row.task,
                            row: pinned,
                            section: row.section,
                            index: pinnedRows.findIndex(
                              (item) => item.id === row.task.id,
                            ),
                          });
                      }
                      onBeginMove?.(intent);
                    }}
                    onLaneStep={(sectionId, direction) => {
                      const index = orderedSections.findIndex(
                        (section) => section.id === sectionId,
                      );
                      return orderedSections[
                        index + (direction === "up" ? -1 : 1)
                      ]?.id;
                    }}
                    onConnectStart={beginConnection}
                    onConnectTarget={connectTarget}
                    onDelete={(taskId) => onDeleteSelection?.(taskId)}
                    onFocusMove={(taskId, direction) => {
                      const order = rows.map((entry) => entry.task.id);
                      const current = order.indexOf(taskId);
                      const next =
                        direction === "down" || direction === "right"
                          ? order[current + 1]
                          : order[current - 1];
                      if (!next) return;
                      // Stay inside this surface: a foreign block may own a bar
                      // with the same test id, so scope the lookup to our body.
                      const target =
                        bodyRef.current?.querySelector<HTMLElement>(
                          `[data-testid="${CSS.escape(`gantt-bar-${next}`)}"]`,
                        );
                      target?.focus();
                    }}
                    onCommitMove={(intent) => {
                      const withTarget = withLane(intent);
                      setMoveSource(null);
                      setReorderPreview(null);
                      onCommitMove?.(withTarget);
                    }}
                    onOpen={(taskId) => onOpenTask?.(taskId)}
                    onPreview={(intent) => {
                      // Consumers must preview the same resolved lane intent
                      // that the pointer commit receives, not a time-only move.
                      const lane = intent ? withLane(intent) : null;
                      if (!lane) setReorderPreview(null);
                      else {
                        setReorderPreview(
                          lane.targetLaneId &&
                            laneChanged(lane, rows, lane.taskId)
                            ? {
                                offset: targetRowOffset(layout, lane),
                                taskId: lane.taskId,
                              }
                            : null,
                        );
                      }
                      onPreviewMove?.(lane);
                    }}

                    onRename={(taskId) => onRenameTask?.(taskId)}
                    onSelect={(taskId) => onSelectTask?.(taskId)}
                    readonly={readonly || row.task.pending === true}
                    rowTop={row.offset}
                    rowHeight={rowHeight}
                    task={row.task}
                    width={width}
                  />
                ))}
                {placement?.draft ? (
                  <Popover
                    opened={Boolean(placement.content)}
                    position="bottom-start"
                    withinPortal
                  >
                    <Popover.Target>
                      <Box
                        data-myoxus-ui-role="gantt-create-preview"
                        ref={placementPreviewRef}
                        style={{
                          position: "absolute",
                          insetBlockStart:
                            layout.find(
                              (entry) =>
                                entry.kind === "section" &&
                                entry.sectionId === placement.draft!.sectionId,
                            )?.offset ?? 0,
                          insetInlineStart: ganttValueToOffset(
                            axis,
                            placement.draft.start,
                            width,
                          ),
                        }}
                        onPointerDown={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                      >
                        <Group wrap="nowrap">
                          <Box
                            data-point={placement.draft.end === undefined}
                            data-myoxus-ui-role="gantt-create-span"
                            style={{
                              inlineSize:
                                placement.draft.end === undefined
                                  ? GANTT_MINIMUM_BAR_WIDTH
                                  : Math.max(
                                      0,
                                      ganttValueToOffset(
                                        axis,
                                        placement.draft.end,
                                        width,
                                      ) -
                                        ganttValueToOffset(
                                          axis,
                                          placement.draft.start,
                                          width,
                                        ),
                                    ),
                            }}
                          />
                          <Text size="xs">
                            {axis.valueLabel(placement.draft.start)}
                          </Text>
                        </Group>
                      </Box>
                    </Popover.Target>
                    <Popover.Dropdown>{placement.content}</Popover.Dropdown>
                  </Popover>
                ) : null}
                {/* Mermaid defaults retain edit-only overlays. Other consumers
                  may project canonical read-only relationships explicitly. */}
                {!readonly || showDependenciesWhenReadonly ? (
                  <GanttDependencies
                    axis={axis}
                    dependencies={dependencies}
                    deleteLabel={labels.deleteDependency}
                    rowHeight={rowHeight}
                    onDelete={(dependencyId) =>
                      onDeleteDependency?.(dependencyId)
                    }
                    onReconnect={(dependencyId, end) => {
                      onBeginDependency?.({
                        kind: "reconnect",
                        dependencyId,
                        endpoint: end,
                      });
                      setReconnect({ dependencyId, end });
                    }}
                    onSelect={(dependencyId) =>
                      onSelectDependency?.(dependencyId)
                    }
                    readonly={readonly}
                    offsetByTaskId={offsetByTaskId}
                    selectedDependencyId={selectedDependencyId}
                    endpointsById={endpointsById}
                    width={width}
                  />
                ) : null}
                {reorderPreview ? (
                  <Box
                    data-myoxus-ui-role="gantt-insert-marker"
                    data-testid="gantt-insert-marker"
                    style={{
                      blockSize: 3,
                      insetBlockStart: reorderPreview.offset,
                      inlineSize: "100%",
                      position: "absolute",
                      zIndex: 7,
                    }}
                  />
                ) : null}
                <GanttOverlays
                  axis={axis}
                  connecting={
                    connectMode || connectFrom !== null || reconnect !== null
                  }
                  commentAnchors={commentAnchors}
                  height={surfaceHeight - headerHeight}
                  markers={markers}
                  offsetById={offsetById}
                  onCommitMarker={onCommitMarker}
                  onConnectTarget={connectTarget}
                  onDeleteMarker={onDeleteMarker}
                  onOpenComment={onOpenComment}
                  onOpenMarker={onOpenMarker}
                  onPreviewMarker={onPreviewMarker}
                  onRenameMarker={onRenameMarker}
                  onSelectMarker={onSelectMarker}
                  readonly={readonly}
                  popover={
                    popover && !reconnect && !connectFrom && !connectMode ? (
                      <Box
                        data-myoxus-ui-role="gantt-popover-anchor"
                        style={{
                          insetBlockStart: anchorTop,
                          insetInlineStart: anchorLeft,
                          // A partially visible long bar must remain a visible
                          // floating reference when its start has scrolled out.
                          inlineSize: anchorWidth,
                          blockSize: rowHeight,
                          position: "absolute",
                          // This is only a floating measurement reference; its
                          // portal owns the controls, not this actor-sized box.
                          pointerEvents: "none",
                          zIndex: 6,
                        }}
                      >
                        {popover}
                      </Box>
                    ) : null
                  }
                  width={width}
                />
              </Box>
            </Box>
            {externalEndpoints.some(
              (endpoint) =>
                endpoint.side === "end" && endpoint.renderLabel !== false,
            ) ? (
              <GanttEndpointRail
                endpoints={externalEndpoints.filter(
                  (endpoint) =>
                    endpoint.side === "end" && endpoint.renderLabel !== false,
                )}
                offsetByTaskId={offsetByTaskId}
                onOpen={onOpenExternalEndpoint}
                width={GANTT_PINNED_LABEL_WIDTH}
                height={surfaceHeight}
                rowHeight={rowHeight}
                headerHeight={headerHeight}
              />
            ) : null}
          </Group>
        </PrimaryScrollArea>
      </Box>
      {diagnostics.length > 0 && (
        <Stack gap={4}>
          {diagnostics.map((diagnostic) => (
            <Text c="dimmed" key={diagnostic.id} size="xs">
              {diagnostic.message}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
