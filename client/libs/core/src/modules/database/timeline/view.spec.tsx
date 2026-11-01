// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import {
  DatabaseFieldKind,
  DatabaseTimelineGroupBy,
  DatabaseTimelineOrder,
} from "@myoxus/graphql";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  dueField,
  field,
  p9gRecord,
  p9gRows,
  timelineView,
} from "../test-fixtures";
import { renderDatabaseViewHost } from "../test-harness";
import type { DatabaseField, DatabaseRowRecord, DatabaseView } from "../types";
import { databaseTimelineGroups } from "./view";

vi.mock("@myoxus/core/modules/peek-view/view/doc-preview", () => ({
  DocPeekPreview: ({ docRef }: { docRef: { docId: string } }) => (
    <div data-testid="database-row-content-editor">{docRef.docId}</div>
  ),
}));

const endField = field("field-end", DatabaseFieldKind.Date, "End", 3);
const dateTimeField: DatabaseField = {
  ...field("field-datetime", DatabaseFieldKind.DateTime, "Starts", 4),
  config: {
    ...field("field-datetime", DatabaseFieldKind.DateTime, "Starts", 4).config,
    dateTime: { allowReminders: true, defaultTimeZone: "Europe/Berlin" },
  },
};
const baseDateCell = p9gRows[0]!.cells.find(
  (cell) => cell.fieldId === dueField.id,
)!;

function dateCell(
  rowId: string,
  targetField: DatabaseField,
  start: string,
  end: string | null = null,
) {
  return {
    ...baseDateCell,
    fieldId: targetField.id,
    rowId,
    value: {
      ...baseDateCell.value,
      date: { end, start },
    },
  };
}

function dateTimeCell(rowId: string, start: string, end: string | null) {
  return {
    ...baseDateCell,
    fieldId: dateTimeField.id,
    fieldType: DatabaseFieldKind.DateTime,
    rowId,
    value: {
      ...baseDateCell.value,
      date: null,
      dateTime: {
        allDay: true,
        end,
        start,
        timeZone: "Europe/Berlin",
      },
      kind: DatabaseFieldKind.DateTime,
    },
  };
}

function row(
  id: string,
  title: string,
  position: number,
  cells: DatabaseRowRecord["cells"],
  redacted = false,
): DatabaseRowRecord {
  return {
    ...p9gRows[0]!,
    cells,
    cellRevisions: [],
    redacted,
    row: {
      ...p9gRows[0]!.row,
      id,
      position,
      title,
    },
  };
}

const timelineRows = [
  row("row-range", "Range", 0, [
    dateCell("row-range", dueField, "2026-07-10", "2026-07-12"),
  ]),
  row("row-milestone", "Milestone", 1, [
    dateCell("row-milestone", dueField, "2026-07-11"),
  ]),
  row("row-separate-end", "Separate end", 2, [
    dateCell("row-separate-end", dueField, "2026-07-13"),
    dateCell("row-separate-end", endField, "2026-07-14"),
  ]),
  row("row-august", "August", 3, [
    dateCell("row-august", dueField, "2026-08-01"),
  ]),
  row(
    "row-redacted-dated",
    "Restricted dated row",
    4,
    [dateCell("row-redacted-dated", dueField, "2026-07-15")],
    true,
  ),
];

function configuredTimeline(
  edits: Partial<NonNullable<DatabaseView["config"]["timeline"]>>,
) {
  return {
    ...timelineView,
    config: {
      ...timelineView.config,
      timeline: { ...timelineView.config.timeline!, ...edits },
    },
  };
}

describe("Database Timeline", () => {
  beforeEach(() => {
    // Semantic tests need text measurement; desktop QA owns rendered geometry.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: (text: string) =>
        ({ width: text.length * 7 }) as TextMetrics,
    } as CanvasRenderingContext2D);
  });
  afterEach(() => vi.restoreAllMocks());

  test("groups and orders normalized milestones and ranges without redacted rows", () => {
    const ascending = databaseTimelineGroups(
      timelineRows,
      dueField,
      endField,
      DatabaseTimelineGroupBy.None,
      DatabaseTimelineOrder.Asc,
      "en-US",
    );
    expect(ascending[0]!.entries.map((entry) => entry.row.row.title)).toEqual([
      "Range",
      "Milestone",
      "Separate end",
      "August",
    ]);
    expect(ascending[0]!.entries[2]!.end?.toISOString()).toBe(
      "2026-07-14T00:00:00.000Z",
    );

    const descending = databaseTimelineGroups(
      timelineRows,
      dueField,
      endField,
      DatabaseTimelineGroupBy.None,
      DatabaseTimelineOrder.Desc,
      "en-US",
    );
    expect(descending[0]!.entries.map((entry) => entry.row.row.title)).toEqual([
      "Range",
      "Milestone",
      "Separate end",
      "August",
    ]);

    expect(
      databaseTimelineGroups(
        timelineRows,
        dueField,
        endField,
        DatabaseTimelineGroupBy.Day,
        DatabaseTimelineOrder.Asc,
        "en-US",
      ),
    ).toHaveLength(4);
    expect(
      databaseTimelineGroups(
        timelineRows,
        dueField,
        endField,
        DatabaseTimelineGroupBy.Week,
        DatabaseTimelineOrder.Asc,
        "de-DE",
      ),
    ).toHaveLength(3);
    expect(
      databaseTimelineGroups(
        timelineRows,
        dueField,
        endField,
        DatabaseTimelineGroupBy.Month,
        DatabaseTimelineOrder.Asc,
        "en-US",
      ),
    ).toHaveLength(2);
  });

  test.each(["doubleClick", "Enter"] as const)(
    "opens the shared Side Peek through temporal pointer/keyboard %s semantics",
    async (activation) => {
      const user = userEvent.setup();
      const view = configuredTimeline({
        endFieldId: endField.id,
        groupBy: DatabaseTimelineGroupBy.Day,
      });
      renderDatabaseViewHost({
        activeViewId: view.id,
        record: {
          ...p9gRecord,
          fields: [...p9gRecord.fields, endField],
          views: [view],
        },
        rows: timelineRows,
        scheduleDate: "2026-07-11",
      });
      const surface = within(screen.getByTestId("database-timeline-view"));
      expect(surface.queryByText("Restricted dated row")).toBeNull();
      const action = surface.getByRole("button", { name: /^Range,/ });
      if (activation === "doubleClick") {
        await user.dblClick(action);
      } else {
        action.focus();
        await user.keyboard("{Enter}");
      }
      expect(
        await screen.findByTestId("database-row-detail-content"),
      ).not.toBeNull();
    },
  );

  test("renders all-day DateTime as a localized item and empty windows explicitly", () => {
    const view = configuredTimeline({
      endFieldId: null,
      groupBy: DatabaseTimelineGroupBy.None,
      startFieldId: dateTimeField.id,
    });
    const allDayRow = row("row-all-day", "All day", 0, [
      dateTimeCell(
        "row-all-day",
        "2026-07-14T22:00:00Z",
        "2026-07-15T22:00:00Z",
      ),
    ]);
    const { rerender } = renderDatabaseViewHost({
      activeViewId: view.id,
      record: {
        ...p9gRecord,
        fields: [...p9gRecord.fields, dateTimeField],
        views: [view],
      },
      rows: [allDayRow],
      scheduleDate: "2026-07-15",
    });
    expect(
      within(screen.getByTestId("database-timeline-view")).getByRole("button", {
        name: /^All day,/,
      }),
    ).not.toBeNull();

    rerender(
      {
        ...p9gRecord,
        fields: [...p9gRecord.fields, dateTimeField],
        views: [view],
      },
      [],
    );
    expect(
      screen.getByText("com.myoxus.database.schedule.window-empty"),
    ).not.toBeNull();
  });
});
