// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { getDuplicatedDocTitle } from "./duplicate-title";

describe("getDuplicatedDocTitle", () => {
  test("adds a first duplicate suffix to plain document titles", () => {
    expect(getDuplicatedDocTitle("test")).toBe("test(1)");
  });

  test("increments an existing trailing duplicate suffix", () => {
    expect(getDuplicatedDocTitle("test(1)")).toBe("test(2)");
    expect(getDuplicatedDocTitle("report(12)")).toBe("report(13)");
  });

  test("only treats the trailing numeric suffix as the duplicate counter", () => {
    expect(getDuplicatedDocTitle("quarter(1) report")).toBe(
      "quarter(1) report(1)",
    );
  });
});
