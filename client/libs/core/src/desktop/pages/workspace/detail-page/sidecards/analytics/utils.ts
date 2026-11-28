// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { GetDocPageAnalyticsQuery } from "@myoxus/graphql";

export const ANALYTICS_WINDOW_OPTIONS = [7, 14, 28, 60, 90] as const;
export const DEFAULT_ANALYTICS_WINDOW_DAYS = 28;
export const INITIAL_MEMBERS_PAGE_SIZE = 5;
export const MAX_MEMBERS_PAGE_SIZE = 50;

export type AnalyticsSeriesPoint = NonNullable<
  NonNullable<GetDocPageAnalyticsQuery["workspace"]>["doc"]
>["analytics"]["series"][number];

export interface AnalyticsChartPoint {
  x: number;
  date: string;
  totalViews: number;
  uniqueViews: number;
  guestViews: number;
}

export function getAvailableAnalyticsWindowOptions(): number[] {
  return [...ANALYTICS_WINDOW_OPTIONS];
}

export function clampAnalyticsWindowDays(value: number): number {
  return (ANALYTICS_WINDOW_OPTIONS as readonly number[]).includes(value)
    ? value
    : DEFAULT_ANALYTICS_WINDOW_DAYS;
}

export function buildAnalyticsChartPoints(
  series: readonly AnalyticsSeriesPoint[],
): AnalyticsChartPoint[] {
  return [...series]
    .sort(
      (left, right) =>
        new Date(left.date).getTime() - new Date(right.date).getTime(),
    )
    .map((point, index) => ({
      x: index,
      date: point.date,
      totalViews: point.totalViews,
      uniqueViews: point.uniqueViews,
      guestViews: point.guestViews,
    }));
}

/**
 * Duplicates a single-day series entry so area/line charts can render a flat
 * segment instead of collapsing an isolated point.
 */
export function ensureMinimumChartPoints(
  points: AnalyticsChartPoint[],
): AnalyticsChartPoint[] {
  if (points.length !== 1) {
    return points;
  }
  return [points[0], { ...points[0], x: points[0].x + 1 }];
}
