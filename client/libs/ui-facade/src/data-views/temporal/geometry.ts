// SPDX-License-Identifier: AGPL-3.0-or-later

export type TemporalAxisValue = number;

export type TemporalAxisModel = {
  start: TemporalAxisValue;
  end: TemporalAxisValue;
};

export type TemporalAxisZoom =
  "day" | "week" | "month" | "quarter" | "year" | "ordinal";

export type TemporalAxisLayoutInput = TemporalAxisModel & {
  step: number;
  ticks: ReadonlyArray<{ label: string; value: number }>;
  zoom: TemporalAxisZoom;
};

export type TemporalItemGeometryInput = {
  start: TemporalAxisValue;
  end?: TemporalAxisValue;
  milestone?: boolean;
};

export type TemporalItemGeometry = {
  left: number;
  width: number;
  center: number;
};

export const TEMPORAL_MINIMUM_ITEM_WIDTH = 18;
export const TEMPORAL_ITEM_HEIGHT = 32;
export const TEMPORAL_HEADER_HEIGHT = 56;
export const TEMPORAL_LANE_HEIGHT = 56;
export const TEMPORAL_DEPENDENCY_BEND_PADDING = 12;

const MINIMUM_AXIS_WIDTH = 640;
const MAXIMUM_DENSITY_WIDTH = 24_000;
const TICK_LABEL_CHARACTER_WIDTH = 8;
const TICK_LABEL_PADDING = 24;
const TICK_EDGE_THRESHOLD = 48;
const ZOOM_STEP_WIDTH: Record<TemporalAxisZoom, number> = {
  day: 48,
  week: 104,
  month: 40,
  quarter: 18,
  year: 28,
  ordinal: 144,
};

/** Shared renderer estimate for a single unwrapped axis label. */
export function temporalTickLabelWidth(
  ticks: ReadonlyArray<{ label: string }>,
) {
  const longestTick = ticks.reduce(
    (length, tick) => Math.max(length, Array.from(tick.label).length),
    0,
  );
  return longestTick * TICK_LABEL_CHARACTER_WIDTH + TICK_LABEL_PADDING;
}

/**
 * Technical renderer sizing. The available workarea is always filled, while
 * dense ranges gain an internal ScrollArea width based on their semantic zoom
 * and labels instead of a route or viewport breakpoint.
 */
export function temporalAxisWidth(
  axis: TemporalAxisLayoutInput,
  workareaWidth: number,
) {
  const span = Math.max(0, axis.end - axis.start);
  const stepCount =
    Number.isFinite(axis.step) && axis.step > 0 ? span / axis.step : 0;
  const rangeWidth = Math.ceil(stepCount * ZOOM_STEP_WIDTH[axis.zoom]);
  const labelWidth = temporalTickLabelWidth(axis.ticks);
  const tickWidth = Math.max(0, axis.ticks.length - 1) * labelWidth;
  const densityWidth = Number.isFinite(Math.max(rangeWidth, tickWidth))
    ? Math.min(MAXIMUM_DENSITY_WIDTH, Math.max(rangeWidth, tickWidth))
    : MAXIMUM_DENSITY_WIDTH;
  return Math.ceil(
    Math.max(
      MINIMUM_AXIS_WIDTH,
      Number.isFinite(workareaWidth) ? workareaWidth : 0,
      densityWidth,
    ),
  );
}

export function temporalLaneCenter(laneIndex: number) {
  return (
    TEMPORAL_HEADER_HEIGHT +
    Math.max(0, laneIndex) * TEMPORAL_LANE_HEIGHT +
    TEMPORAL_LANE_HEIGHT / 2
  );
}

export function temporalTickLabelPosition(
  axis: TemporalAxisModel,
  value: number,
  width: number,
): "start" | "middle" | "end" {
  const offset = temporalValueToOffset(axis, value, width);
  if (offset <= TICK_EDGE_THRESHOLD) return "start";
  if (offset >= width - TICK_EDGE_THRESHOLD) return "end";
  return "middle";
}

export function temporalSurfaceHeight(laneCount: number) {
  return TEMPORAL_HEADER_HEIGHT + Math.max(1, laneCount) * TEMPORAL_LANE_HEIGHT;
}

/**
 * The temporal renderer owns numerical axis and hit geometry, not product
 * layout chrome. Every adapter uses this clamped scale so bars, milestones,
 * dependency endpoints and pointer commits agree on one coordinate system.
 */
export function temporalValueToOffset(
  axis: TemporalAxisModel,
  value: TemporalAxisValue,
  width: number,
): number {
  if (!Number.isFinite(width) || width <= 0 || axis.end <= axis.start) return 0;
  const ratio = (value - axis.start) / (axis.end - axis.start);
  return Math.min(width, Math.max(0, ratio * width));
}

export function temporalOffsetToValue(
  axis: TemporalAxisModel,
  offset: number,
  width: number,
): TemporalAxisValue {
  if (!Number.isFinite(width) || width <= 0 || axis.end <= axis.start) {
    return axis.start;
  }
  const ratio = Math.min(1, Math.max(0, offset / width));
  return axis.start + ratio * (axis.end - axis.start);
}

export function temporalItemGeometry(
  axis: TemporalAxisModel,
  item: TemporalItemGeometryInput,
  width: number,
  minimumWidth: number,
): TemporalItemGeometry {
  const valueOffset = temporalValueToOffset(axis, item.start, width);
  const end = temporalValueToOffset(axis, item.end ?? item.start, width);
  const requestedWidth = Math.max(0, end - valueOffset);
  const renderedWidth = Math.min(
    Math.max(0, width),
    item.milestone ? minimumWidth : Math.max(minimumWidth, requestedWidth),
  );
  const left = item.milestone
    ? Math.min(
        Math.max(0, width - renderedWidth),
        Math.max(0, valueOffset - renderedWidth / 2),
      )
    : Math.min(Math.max(0, width - renderedWidth), valueOffset);
  return {
    left,
    width: renderedWidth,
    center: left + renderedWidth / 2,
  };
}

export function temporalSnapValue(
  value: TemporalAxisValue,
  step: number,
): TemporalAxisValue {
  if (!Number.isFinite(step) || step <= 0) return value;
  return Math.round(value / step) * step;
}

export function temporalOverlaps(
  item: TemporalItemGeometryInput,
  window: TemporalAxisModel,
): boolean {
  const end = item.end ?? item.start;
  return item.start <= window.end && end >= window.start;
}
