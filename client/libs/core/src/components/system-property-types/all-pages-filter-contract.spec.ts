// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { describe, expect, test } from "vitest";

import { SystemPropertyTypes } from ".";

describe("All content system filter contract", () => {
  test("keeps common title and typed page-kind filters discoverable", () => {
    expect(SystemPropertyTypes.title.defaultFilter).toEqual({
      method: "match",
      value: "",
    });
    expect(SystemPropertyTypes.title.filterMethod).toEqual({
      match: "com.myoxus.filter.contains",
    });
    expect(SystemPropertyTypes.title.filterValue).toBeTypeOf("function");

    expect(SystemPropertyTypes.pageKind.allPagesOnly).toBe(true);
    expect(SystemPropertyTypes.pageKind.defaultFilter).toEqual({
      method: "is",
      value: "all",
    });
  });
});
