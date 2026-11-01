// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DatabaseTimelineGroupBy,
  DatabaseTimelineOrder,
  DatabaseTimelineZoom,
} from "@myoxus/graphql";
import { describe, expect, test } from "vitest";

import { databaseTimelineGroups } from "../timeline/projection";
import { dueField, p9gRows } from "../test-fixtures";
import { databaseTemporalAxis } from "./temporal";

describe("Database temporal projection", () => {
  test("aligns week axes and grouping to the locale week start", () => {
    const enAxis = databaseTemporalAxis(
      "2026-07-15",
      DatabaseTimelineZoom.Week,
      "en-US",
    );
    const deAxis = databaseTemporalAxis(
      "2026-07-15",
      DatabaseTimelineZoom.Week,
      "de-DE",
    );
    expect(new Date(enAxis.start).toISOString().slice(0, 10)).toBe(
      "2026-07-12",
    );
    expect(new Date(deAxis.start).toISOString().slice(0, 10)).toBe(
      "2026-07-13",
    );

    const en = databaseTimelineGroups(
      p9gRows,
      dueField,
      null,
      DatabaseTimelineGroupBy.Week,
      DatabaseTimelineOrder.Asc,
      "en-US",
    );
    const de = databaseTimelineGroups(
      p9gRows,
      dueField,
      null,
      DatabaseTimelineGroupBy.Week,
      DatabaseTimelineOrder.Asc,
      "de-DE",
    );
    expect(en[0]?.key).not.toBe(de[0]?.key);
  });
});
