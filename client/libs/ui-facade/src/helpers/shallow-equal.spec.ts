// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { shallowEqual, shallowUpdater } from "./shallow-equal";

describe("shallowEqual", () => {
  test("keeps referential equality and shallow object equality distinct", () => {
    const nested = { value: 1 };

    expect(shallowEqual(nested, nested)).toBe(true);
    expect(shallowEqual({ value: 1 }, { value: 1 })).toBe(true);
    expect(shallowEqual({ value: 1 }, { value: 2 })).toBe(false);
    expect(
      shallowEqual({ nested: { value: 1 } }, { nested: { value: 1 } }),
    ).toBe(false);
  });

  test("reuses previous state when shallow fields are unchanged", () => {
    const previous = { id: "alpha", count: 2 };
    const next = shallowUpdater({ id: "alpha", count: 2 })(previous);
    const changed = shallowUpdater({ id: "alpha", count: 3 })(previous);

    expect(next).toBe(previous);
    expect(changed).not.toBe(previous);
    expect(changed).toEqual({ id: "alpha", count: 3 });
  });
});
