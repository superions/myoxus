// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";
import { queueHistorySeries } from "./queue-history";

describe("queue history projection", () => {
  test("preserves minute gaps and real zero measurements", () => {
    expect(
      queueHistorySeries([
        { timestamp: 60_000, pending: 5 },
        { timestamp: 120_000, pending: 0 },
        { timestamp: 240_000, pending: 3 },
      ]),
    ).toEqual({ data: [5, 0, null, 3], start: 60_000, end: 240_000, last: 3 });
  });

  test("rejects invalid ordering, values and unbounded history", () => {
    for (const points of [
      [
        { timestamp: 60_000, pending: 1 },
        { timestamp: 60_000, pending: 2 },
      ],
      [
        { timestamp: 120_000, pending: 1 },
        { timestamp: 60_000, pending: 2 },
      ],
      [
        { timestamp: 60_000, pending: 1 },
        { timestamp: 120_000, pending: -1 },
      ],
      [
        { timestamp: 60_000, pending: 1 },
        { timestamp: 120_001, pending: 2 },
      ],
      [
        { timestamp: 0, pending: 1 },
        { timestamp: 86_460_000, pending: 2 },
      ],
    ])
      expect(queueHistorySeries(points)).toBeNull();
  });
});
