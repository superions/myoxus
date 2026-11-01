import { checkSnapshotPreflight } from "@virgultum/editor/blocks/surface";
import { describe, expect, test } from "vitest";

const limits = {
  maxCanvasDimensionPx: 1000,
  maxCanvasTotalPixels: 1_000_000,
};

describe("checkSnapshotPreflight", () => {
  test("returns ok when dimensions fit all limits", () => {
    const result = checkSnapshotPreflight(800, 600, limits);
    expect(result.severity).toBe("ok");
    expect(result.scale).toBe(1);
    expect(result.scaledWidth).toBe(800);
    expect(result.scaledHeight).toBe(600);
  });

  test("warns and computes the downscaled dimensions for moderate overshoot", () => {
    const result = checkSnapshotPreflight(1200, 900, limits);
    expect(result.severity).toBe("warning");
    expect(result.scale).toBeLessThan(1);
    expect(result.scaledWidth).toBeLessThanOrEqual(1000);
    expect(result.scaledHeight).toBeLessThanOrEqual(1000);
  });

  test("marks extreme overshoot as severe", () => {
    const result = checkSnapshotPreflight(2500, 1000, limits);
    expect(result.severity).toBe("severe");
    expect(result.scaledWidth).toBeLessThanOrEqual(1000);
  });

  test("handles invalid dimensions defensively without NaN", () => {
    const result = checkSnapshotPreflight(0, -1, limits);
    expect(result.severity).toBe("ok");
    expect(result.scale).toBe(1);
    expect(Number.isNaN(result.scaledWidth)).toBe(false);
    expect(Number.isNaN(result.scaledHeight)).toBe(false);
  });
});
