// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { classNames } from "./index";

describe("classNames", () => {
  test("joins strings, numbers and nested arrays in order", () => {
    expect(classNames("root", 1, ["nested", ["deep"]], false, null)).toBe(
      "root 1 nested deep",
    );
  });

  test("uses object keys only when their guard is truthy", () => {
    expect(
      classNames("root", {
        active: true,
        disabled: false,
        selected: 1,
        empty: "",
      }),
    ).toBe("root active selected");
  });
});
