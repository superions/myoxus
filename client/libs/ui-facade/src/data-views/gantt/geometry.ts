// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  temporalAxisWidth,
  temporalOffsetToValue,
  temporalSnapValue,
  temporalTickLabelWidth,
  temporalValueToOffset,
  type TemporalAxisModel,
} from "../temporal/geometry";

export const GANTT_PINNED_LABEL_WIDTH = 220;
export const GANTT_SECTION_HEADER_HEIGHT = 44;
export const GANTT_ROW_HEIGHT = 40;
export const GANTT_AXIS_HEADER_HEIGHT = 44;
export const GANTT_MINIMUM_BAR_WIDTH = 18;
/** Horizontal extent of the square milestone after its 45-degree rotation. */
export const GANTT_MILESTONE_RADIUS = GANTT_MINIMUM_BAR_WIDTH / Math.SQRT2;

export type GanttAxisLayoutInput = TemporalAxisModel & {
  step: number;
  ticks: ReadonlyArray<{ label: string; value: number }>;
  zoom: string;
};

/**
 * Technical renderer sizing shared with the temporal geometry owner. Dense
 * ranges widen the internal scroll area instead of the document page.
 */
export function ganttAxisWidth(
  axis: GanttAxisLayoutInput,
  workareaWidth: number,
  tickLabelWidth: number,
) {
  // Display density follows visible ticks, not the finer gesture snap step.
  // Timestamp precision must not expand a month into hourly display columns.
  const displayStep =
    axis.ticks.length > 1
      ? axis.ticks[1]!.value - axis.ticks[0]!.value
      : Math.max(1, axis.end - axis.start);
  const base = temporalAxisWidth(
    { ...axis, step: displayStep, zoom: "day" as const },
    Math.max(0, workareaWidth - GANTT_PINNED_LABEL_WIDTH),
  );
  // The first tick is start-aligned and its neighbour is centred: their
  // separation needs one full label plus half the next, not just one label.
  const labelSpan =
    axis.ticks.length > 1
      ? ((axis.end - axis.start) / displayStep) *
        Math.max(tickLabelWidth, temporalTickLabelWidth(axis.ticks)) *
        1.5
      : 0;
  return Math.ceil(Math.max(base, labelSpan));
}

export type GanttLayoutEntry =
  | {
      readonly kind: "section";
      readonly offset: number;
      readonly sectionId: string;
    }
  | {
      readonly kind: "task";
      readonly offset: number;
      readonly sectionId: string;
      readonly taskId: string;
    };

/**
 * One shared vertical layout for both columns: section headers and task rows
 * keep identical offsets in the pinned label column and the time surface, so
 * bars, markers and dependency endpoints always sit on their own row.
 */
export function ganttLayout(
  sections: ReadonlyArray<{ id: string; order: number; collapsed?: boolean }>,
  tasks: ReadonlyArray<{ id: string; sectionId: string }>,
  rowHeight = GANTT_ROW_HEIGHT,
): readonly GanttLayoutEntry[] {
  const ordered = [...sections].sort((a, b) => a.order - b.order);
  const entries: GanttLayoutEntry[] = [];
  let offset = 0;
  for (const section of ordered) {
    entries.push({ kind: "section", offset, sectionId: section.id });
    offset += GANTT_SECTION_HEADER_HEIGHT;
    if (section.collapsed) continue;
    for (const task of tasks.filter(
      (entry) => entry.sectionId === section.id,
    )) {
      entries.push({
        kind: "task",
        offset,
        sectionId: section.id,
        taskId: task.id,
      });
      offset += rowHeight;
    }
  }
  return entries;
}

export function ganttTaskOffset(
  layout: readonly GanttLayoutEntry[],
  taskId: string,
): number {
  return (
    layout.find((entry) => entry.kind === "task" && entry.taskId === taskId)
      ?.offset ?? 0
  );
}

export function ganttSurfaceHeight(
  layout: readonly GanttLayoutEntry[],
  rowHeight = GANTT_ROW_HEIGHT,
  headerHeight = GANTT_AXIS_HEADER_HEIGHT,
) {
  const last = layout.at(-1);
  const body = last
    ? last.offset +
      (last.kind === "section" ? GANTT_SECTION_HEADER_HEIGHT : rowHeight)
    : rowHeight;
  return headerHeight + Math.max(rowHeight, body);
}

export {
  temporalOffsetToValue as ganttOffsetToValue,
  temporalSnapValue as ganttSnapValue,
  temporalValueToOffset as ganttValueToOffset,
};

export type GanttZoom = "year" | "quarter" | "month" | "week" | "day";

const GANTT_ZOOM_MS: Record<GanttZoom, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  quarter: 90 * 86_400_000,
  year: 365 * 86_400_000,
};

/**
 * Tick density is technical geometry: the visible range always yields ticks,
 * while compact workareas drop to a coarser zoom instead of colliding labels.
 */
export function ganttAxisTicks(
  range: { start: number; end: number },
  valueLabel: (value: number) => string,
  workareaWidth: number,
  minimumTickSpacing = 110,
  zoomOverride?: GanttZoom | null,
) {
  const span = Math.max(1, range.end - range.start);
  const order: GanttZoom[] = ["day", "week", "month", "quarter", "year"];
  const zoom =
    zoomOverride ??
    order.find(
      (candidate) =>
        (span / GANTT_ZOOM_MS[candidate]) * minimumTickSpacing <=
        Math.max(320, workareaWidth),
    ) ??
    "year";
  const step = GANTT_ZOOM_MS[zoom];
  const ticks: { label: string; value: number }[] = [];
  for (let value = range.start; value <= range.end + step / 2; value += step) {
    ticks.push({ label: valueLabel(value), value });
    if (ticks.length > 400) break;
  }
  return { step, ticks, zoom: zoom as GanttZoom };
}

export function ganttZoomStep(zoom: GanttZoom) {
  return GANTT_ZOOM_MS[zoom];
}
