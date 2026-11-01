// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { consumeTaskCreationIntent } from "./creation-intent";

describe("Task creation handoff", () => {
  it("rejects foreign return destinations and preserves unrelated query state", () => {
    const request = consumeTaskCreationIntent(
      new URLSearchParams(
        "create=task&origin=home&returnTo=https://foreign.test/home&returnScroll=NaN&projectId=a&projectId=b",
      ),
    )!;
    expect(request.returnTo).toBe("/home");
    expect(request.returnScroll).toBeNull();
    expect(request.remaining.getAll("projectId")).toEqual(["a", "b"]);
    expect(
      consumeTaskCreationIntent(
        new URLSearchParams("create=unknown&origin=home"),
      ),
    ).toBeNull();
  });
});
