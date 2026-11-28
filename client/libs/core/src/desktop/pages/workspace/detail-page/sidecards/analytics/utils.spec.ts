// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { describe, expect, test } from "vitest";

import {
  ANALYTICS_WINDOW_OPTIONS,
  buildAnalyticsChartPoints,
  clampAnalyticsWindowDays,
  DEFAULT_ANALYTICS_WINDOW_DAYS,
  ensureMinimumChartPoints,
  getAvailableAnalyticsWindowOptions,
} from "./utils";

describe("analytics utils", () => {
  test("clamps unsupported window sizes to the default while allowing all configured windows", () => {
    expect(clampAnalyticsWindowDays(15)).toBe(DEFAULT_ANALYTICS_WINDOW_DAYS);
    for (const option of ANALYTICS_WINDOW_OPTIONS) {
      expect(clampAnalyticsWindowDays(option)).toBe(option);
    }
    expect(getAvailableAnalyticsWindowOptions()).toEqual([
      ...ANALYTICS_WINDOW_OPTIONS,
    ]);
  });

  test("sorts raw API series chronologically with sequential x coordinates", () => {
    expect(
      buildAnalyticsChartPoints([
        { date: "2026-02-12", totalViews: 4, uniqueViews: 2, guestViews: 1 },
        { date: "2026-02-10", totalViews: 9, uniqueViews: 3, guestViews: 0 },
      ]),
    ).toEqual([
      {
        x: 0,
        date: "2026-02-10",
        totalViews: 9,
        uniqueViews: 3,
        guestViews: 0,
      },
      {
        x: 1,
        date: "2026-02-12",
        totalViews: 4,
        uniqueViews: 2,
        guestViews: 1,
      },
    ]);
  });

  test("pads single-point series with a trailing coordinate", () => {
    expect(
      ensureMinimumChartPoints([
        {
          x: 0,
          date: "2026-02-12",
          totalViews: 4,
          uniqueViews: 2,
          guestViews: 1,
        },
      ]),
    ).toEqual([
      {
        x: 0,
        date: "2026-02-12",
        totalViews: 4,
        uniqueViews: 2,
        guestViews: 1,
      },
      {
        x: 1,
        date: "2026-02-12",
        totalViews: 4,
        uniqueViews: 2,
        guestViews: 1,
      },
    ]);
  });
});
