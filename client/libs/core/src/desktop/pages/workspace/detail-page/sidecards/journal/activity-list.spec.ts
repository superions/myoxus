/**
 * @vitest-environment happy-dom
 */
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import dayjs from "dayjs";
import { describe, expect, test } from "vitest";

import {
  buildJournalActivityItems,
  type JournalActivityRecord,
} from "./activity-list";

function record(
  id: string,
  meta: {
    createDate?: number;
    updatedDate?: number;
    trash?: boolean;
  },
): JournalActivityRecord {
  return { id, meta$: { value: meta } } as JournalActivityRecord;
}

describe("Journal activity projection", () => {
  test("filters trash, deduplicates kinds and sorts by activity on the selected day", () => {
    const selectedDate = dayjs("2026-07-18");
    const records = [
      record("new-with-later-update", {
        createDate: dayjs("2026-07-18T09:00:00").valueOf(),
        updatedDate: dayjs("2026-07-19T23:00:00").valueOf(),
      }),
      record("updated", {
        createDate: dayjs("2026-07-17T08:00:00").valueOf(),
        updatedDate: dayjs("2026-07-18T12:00:00").valueOf(),
      }),
      record("both", {
        createDate: dayjs("2026-07-18T08:00:00").valueOf(),
        updatedDate: dayjs("2026-07-18T15:00:00").valueOf(),
      }),
      record("trash", {
        updatedDate: dayjs("2026-07-18T17:00:00").valueOf(),
        trash: true,
      }),
      record("outside", {
        updatedDate: dayjs("2026-07-17T17:00:00").valueOf(),
      }),
    ];

    expect(
      buildJournalActivityItems(records, selectedDate).map(
        ({ docId, kind }) => ({ docId, kind }),
      ),
    ).toEqual([
      { docId: "both", kind: "both" },
      { docId: "updated", kind: "updated" },
      { docId: "new-with-later-update", kind: "new" },
    ]);
  });
});
