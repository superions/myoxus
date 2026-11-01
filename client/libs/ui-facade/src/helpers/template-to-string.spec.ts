// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { templateToString } from "./template-to-string";

describe("templateToString", () => {
  test("serializes lit-like template strings and values without importing lit", () => {
    expect(
      templateToString({
        strings: ["Hello ", ", count ", ""],
        values: ["Myoxus", 3],
      }),
    ).toBe("Hello Myoxus, count 3");
  });
});
