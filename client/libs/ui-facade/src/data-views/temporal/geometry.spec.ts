// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import {
  temporalItemGeometry,
  temporalOffsetToValue,
  temporalOverlaps,
  temporalSnapValue,
  temporalValueToOffset,
} from "./geometry";

const axis = { start: 100, end: 200 };

describe("temporal geometry", () => {
  test("maps the shared axis in both directions and clamps hit coordinates", () => {
    expect(temporalValueToOffset(axis, 125, 400)).toBe(100);
    expect(temporalOffsetToValue(axis, 300, 400)).toBe(175);
    expect(temporalValueToOffset(axis, 50, 400)).toBe(0);
    expect(temporalOffsetToValue(axis, 500, 400)).toBe(200);
    expect(temporalSnapValue(174, 10)).toBe(170);
  });

  test("derives bar width from duration while retaining milestone hit targets", () => {
    expect(
      temporalItemGeometry(axis, { start: 120, end: 180 }, 400, 18),
    ).toEqual({ left: 80, width: 240, center: 200 });
    expect(
      temporalItemGeometry(axis, { start: 120, milestone: true }, 400, 18),
    ).toEqual({ left: 71, width: 18, center: 80 });
  });

  test("keeps intervals that begin before but end inside the visible window", () => {
    expect(temporalOverlaps({ start: 50, end: 125 }, axis)).toBe(true);
    expect(temporalOverlaps({ start: 50, end: 99 }, axis)).toBe(false);
    expect(temporalOverlaps({ start: 200 }, axis)).toBe(true);
  });
});
