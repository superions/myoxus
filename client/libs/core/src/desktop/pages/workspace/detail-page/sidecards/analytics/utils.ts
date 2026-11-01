/**
 * Analytics utilities — pure helpers for the `EditorAnalyticsPanel` component.
 *
 * This module is intentionally free of React and side effects so the functions
 * can be unit-tested in isolation (see `analytics.utils.spec.ts`).
 *
 * ### Constants
 * - `ANALYTICS_WINDOW_OPTIONS` — the five selectable time windows in days.
 * - `DEFAULT_ANALYTICS_WINDOW_DAYS` — default selection (28 days).
 * - `INITIAL_MEMBERS_PAGE_SIZE` / `MAX_MEMBERS_PAGE_SIZE` — pagination for
 *   the recent-viewers list.
 *
 * ### Functions
 * - `getAvailableAnalyticsWindowOptions()` — returns all window options as a
 *   mutable copy (safe to render as a list without referential equality issues).
 * - `clampAnalyticsWindowDays(value)` — returns a supported stored window or
 *   the default.
 * - `buildAnalyticsChartPoints(series)` — sorts the raw time-series by date and
 *   maps each point to `AnalyticsChartPoint` with a monotonic integer `x` axis
 *   suitable for Recharts.
 * - `ensureMinimumChartPoints(points)` — Recharts requires at least two data
 *   points to render a line; when there is exactly one point a duplicate is
 *   appended with `x + 1` so the line renders as a single horizontal segment
 *   rather than a broken chart.
 */
import type { GetDocPageAnalyticsQuery } from "@myoxus/graphql";

/** All selectable analytics time-window options, in days. */
export const ANALYTICS_WINDOW_OPTIONS = [7, 14, 28, 60, 90] as const;
/** Default time-window selection for the analytics chart. */
export const DEFAULT_ANALYTICS_WINDOW_DAYS = 28;
/** Number of viewer rows shown before "Show all" is triggered. */
export const INITIAL_MEMBERS_PAGE_SIZE = 5;
/** Upper bound on viewer rows loaded via "Show all". */
export const MAX_MEMBERS_PAGE_SIZE = 50;

/** A single daily analytics data point as returned by the GraphQL API. */
export type AnalyticsSeriesPoint = NonNullable<
  NonNullable<GetDocPageAnalyticsQuery["workspace"]>["doc"]
>["analytics"]["series"][number];

/** A normalised data point for the Recharts `LineChart` with a monotonic `x` axis. */
export type AnalyticsChartPoint = {
  x: number;
  date: string;
  totalViews: number;
  uniqueViews: number;
  guestViews: number;
};

/** Returns all analytics window options as a mutable array. */
export function getAvailableAnalyticsWindowOptions() {
  return [...ANALYTICS_WINDOW_OPTIONS];
}

/**
 * Returns the selected window days if it is a valid option, or the default.
 * All options are available regardless of workspace plan.
 */
export function clampAnalyticsWindowDays(value: number) {
  return ANALYTICS_WINDOW_OPTIONS.includes(
    value as (typeof ANALYTICS_WINDOW_OPTIONS)[number],
  )
    ? value
    : DEFAULT_ANALYTICS_WINDOW_DAYS;
}

/**
 * Converts raw API series data into sorted `AnalyticsChartPoint` records with
 * a monotonic integer `x` axis.  Recharts uses the `x` field for positioning;
 * using sequential integers (rather than timestamps) gives uniform column spacing.
 */
export function buildAnalyticsChartPoints(series: AnalyticsSeriesPoint[]) {
  const sorted = [...series].sort(
    (left, right) =>
      new Date(left.date).getTime() - new Date(right.date).getTime(),
  );

  return sorted.map((point, index) => ({
    x: index,
    date: point.date,
    totalViews: point.totalViews,
    uniqueViews: point.uniqueViews,
    guestViews: point.guestViews,
  })) satisfies AnalyticsChartPoint[];
}

/**
 * Ensures the chart always has at least two data points.
 * Recharts cannot render a `<Line>` with a single point; it produces a broken
 * (invisible) chart.  When exactly one point is returned by the API a
 * synthetic duplicate is appended with `x + 1` so the line renders as a flat
 * segment at the correct y-value.
 */
export function ensureMinimumChartPoints(points: AnalyticsChartPoint[]) {
  if (points.length !== 1) {
    return points;
  }

  return [
    points[0],
    {
      ...points[0],
      x: points[0].x + 1,
    },
  ] satisfies AnalyticsChartPoint[];
}
