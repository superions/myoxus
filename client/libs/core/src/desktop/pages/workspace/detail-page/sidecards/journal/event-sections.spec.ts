/**
 * @vitest-environment happy-dom
 */
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { claimUniqueEventBuckets } from "./event-sections";

describe("claimUniqueEventBuckets", () => {
  test("assigns an event to only the first agenda bucket that claims it", () => {
    const event = { id: "event-1", title: "Workbench review" };

    const [today, tomorrow, week] = claimUniqueEventBuckets([
      [event],
      [{ id: "event-2", title: "Planning" }],
      [event, { id: "event-3", title: "Retrospective" }],
    ]);

    expect(today.map((item) => item.id)).toEqual(["event-1"]);
    expect(tomorrow.map((item) => item.id)).toEqual(["event-2"]);
    expect(week.map((item) => item.id)).toEqual(["event-3"]);
    expect([...today, ...tomorrow, ...week]).toHaveLength(3);
  });
});
