// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";
import {
  parseNavigationQuery,
  stringifyNavigationQuery,
} from "./navigation-query";
import { createNavigableHistory } from "./navigable-history";

describe("navigation query contract", () => {
  test("preserves repeated values, null flags, empties and scalar conversion", () => {
    expect(
      parseNavigationQuery("?flag&empty=&id=001&id=a%2Bb&n=12&b=FALSE", {
        parseNumbers: true,
        parseBooleans: true,
      }),
    ).toEqual({ flag: null, empty: "", id: [1, "a+b"], n: 12, b: false });
    expect(parseNavigationQuery("?id=001")).toEqual({ id: "001" });
  });
  test("roundtrips escaping, sorted keys and repeated/null values", () => {
    const value = {
      z: undefined,
      list: ["a b", "+", ""],
      flag: null,
      b: false,
      n: 12,
      text: "é!*'()~",
    };
    const search = stringifyNavigationQuery(value);
    expect(search).toBe(
      "b=false&flag&list=a%20b&list=%2B&list=&n=12&text=%C3%A9%21%2A%27%28%29~",
    );
    expect(
      parseNavigationQuery(search, { parseNumbers: true, parseBooleans: true }),
    ).toEqual({ ...value, z: undefined });
  });
  test("treats prototype-named keys as data", () => {
    const result = parseNavigationQuery(
      "__proto__=a&constructor=b&__proto__=c",
    );
    expect(result.__proto__).toEqual(["a", "c"]);
    expect(result.constructor).toBe("b");
    expect(Object.getPrototypeOf(result)).toBeNull();
  });
});

test("pane history preserves path fragments, state, branch truncation and blocker retry", () => {
  const h = createNavigableHistory({ initialEntries: ["/first?x=1#top"] });
  const updates: string[] = [];
  h.listen(({ action }) => updates.push(action));
  h.push("/second?empty=#bottom", { selected: true });
  expect(h.location).toMatchObject({
    pathname: "/second",
    search: "?empty=",
    hash: "#bottom",
    state: { selected: true },
  });
  h.back();
  h.push("/third");
  expect(h.entries.map((e) => e.pathname)).toEqual(["/first", "/third"]);
  let retry = () => {};
  const unblock = h.block((tx) => {
    retry = tx.retry;
  });
  h.replace("/fourth");
  expect(h.location.pathname).toBe("/third");
  unblock();
  retry();
  expect(h.location.pathname).toBe("/fourth");
  expect(h.createHref({ pathname: "/x", search: "a=1", hash: "part" })).toBe(
    "/x?a=1#part",
  );
  expect(updates).toEqual(["PUSH", "POP", "PUSH", "REPLACE"]);
});
