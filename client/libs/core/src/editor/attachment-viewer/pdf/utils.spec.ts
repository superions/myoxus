import { describe, expect, test } from "vitest";

import { fitToPage } from "./utils";

describe("fitToPage", () => {
  test("preserves the page ratio inside a valid viewport", () => {
    expect(
      fitToPage(
        { width: 800, height: 600 },
        { width: 400, height: 800 },
        { width: 400, height: 800 },
      ),
    ).toEqual({ width: 300, height: 600, aspectRatio: 0.5 });
  });

  test.each([
    { width: 0, height: 600 },
    { width: -1, height: 600 },
    { width: 800, height: Number.NaN },
  ])(
    "does not emit invalid canvas geometry for $width x $height",
    (viewport) => {
      expect(
        fitToPage(
          viewport,
          { width: 400, height: 800 },
          { width: 400, height: 800 },
        ),
      ).toEqual({ width: 0, height: 0, aspectRatio: 1 });
    },
  );
});
