// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import { templateRecordCollection } from "../services/template-repeat";

test("record collection limits count UTF-8 bytes without truncation and reject legacy arrays for repeats", () => {
  const record = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`field${i}`, "é".repeat(4096)]),
  );
  const records = Array.from({ length: 500 }, () => record);
  expect(templateRecordCollection(records)).toBe(records);
  for (const value of [
    [],
    ["legacy"],
    Array.from({ length: 501 }, () => ({ name: "One" })),
    [{ name: "é".repeat(4097) }],
    [{ ["a".repeat(129)]: "one" }],
    [{ "member..name": "one" }],
    [
      Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [`field${i}`, "one"]),
      ),
    ],
  ]) {
    expect(() => templateRecordCollection(value)).toThrow();
  }
});
