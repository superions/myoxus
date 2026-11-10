// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { DatabaseViewKind } from "@myoxus/graphql";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import {
  calendarView,
  galleryView,
  kanbanRecord,
  kanbanRows,
  kanbanView,
  listView,
  notesField,
  p9gRecord,
  p9gRows,
  statusField,
  tableView,
  timelineView,
  TIMESTAMP,
  titleField,
} from "../test-fixtures";
import {
  renderDatabaseViewHost,
  setDatabasePresenceOverride,
} from "../test-harness";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

vi.mock("@myoxus/core/modules/peek-view/view/doc-preview", () => ({
  DocPeekPreview: ({ docRef }: { docRef: { docId: string } }) => (
    <div data-testid="database-row-content-editor">{docRef.docId}</div>
  ),
}));

describe("Database sibling view dispatch", () => {
  test.each(["page", "embedded"] as const)(
    "keeps the complete shared host contract in the %s consumer",
    async (layout) => {
      const updateFocus = vi.fn();
      const collaborator = {
        socketId: "remote-socket",
        userId: "remote-user",
        displayName: "Remote editor",
        viewId: tableView.id,
        rowId: p9gRows[0]!.row.id,
        fieldId: titleField.id,
        dragging: false,
        lastActiveAt: TIMESTAMP,
      };
      setDatabasePresenceOverride({
        collaborators: [collaborator],
        connected: true,
        localSocketId: "local-socket",
        presenceByRowId: new Map([[collaborator.rowId, [collaborator]]]),
        presenceByFieldId: new Map([[collaborator.fieldId, [collaborator]]]),
        draggingUserIds: [],
        updateFocus,
        refresh: async () => [collaborator],
      });

      const { gql, onChanged } = renderDatabaseViewHost({
        activeViewId: tableView.id,
        initialRowId: p9gRows[0]!.row.id,
        layout,
        record: p9gRecord,
        rows: p9gRows,
      });

      const table = within(screen.getByTestId("database-table-view"));
      expect(screen.getByTestId("database-view-tab-view-table")).toBeTruthy();
      expect(screen.getByTestId("database-field-plus")).toBeTruthy();
      expect(screen.getByTestId("database-new-row")).toBeTruthy();
      expect(screen.getByTestId("database-row-detail-content")).toBeTruthy();
      expect(screen.getByTestId("database-row-detail-peek")).toBeTruthy();
      expect(
        document.querySelector(
          '[data-myoxus-database-presence-indicator="true"][aria-label="Remote editor"]',
        ),
      ).not.toBeNull();

      fireEvent.doubleClick(table.getByText("Initial note"));
      fireEvent.change(table.getByRole("textbox"), {
        target: { value: `${layout} mutation` },
      });
      fireEvent.blur(table.getByRole("textbox"));
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(gql).toHaveBeenCalled();
    },
  );

  test("renders remote row presence independently in every database view", () => {
    const updateFocus = vi.fn();
    const viewCases = [
      {
        record: p9gRecord,
        rows: p9gRows,
        view: tableView,
        testId: "database-table-view",
      },
      {
        record: kanbanRecord,
        rows: kanbanRows,
        view: kanbanView,
        testId: "database-kanban-view",
      },
      {
        record: p9gRecord,
        rows: p9gRows,
        view: listView,
        testId: "database-list-view",
      },
      {
        record: p9gRecord,
        rows: p9gRows,
        view: galleryView,
        testId: "database-gallery-view",
      },
      {
        record: p9gRecord,
        rows: p9gRows,
        scheduleDate: "2026-07-15",
        view: calendarView,
        testId: "database-calendar-view",
      },
      {
        record: p9gRecord,
        rows: p9gRows,
        scheduleDate: "2026-07-15",
        view: timelineView,
        testId: "database-timeline-view",
      },
    ] as const;

    for (const viewCase of viewCases) {
      const targetRow = viewCase.rows[0]!;
      const collaborator = {
        socketId: "remote-socket",
        userId: "remote-user",
        displayName: "Remote editor",
        viewId: viewCase.view.id,
        rowId: targetRow.row.id,
        fieldId: titleField.id,
        dragging: viewCase.view.viewKind === DatabaseViewKind.Kanban,
        lastActiveAt: TIMESTAMP,
      };
      setDatabasePresenceOverride({
        collaborators: [collaborator],
        connected: true,
        localSocketId: "local-socket",
        presenceByRowId: new Map([[targetRow.row.id, [collaborator]]]),
        presenceByFieldId: new Map([[titleField.id, [collaborator]]]),
        draggingUserIds: collaborator.dragging ? [collaborator.userId] : [],
        updateFocus,
        refresh: async () => [collaborator],
      });

      renderDatabaseViewHost({
        activeViewId: viewCase.view.id,
        record: { ...viewCase.record, views: [viewCase.view] },
        rows: viewCase.rows,
        scheduleDate:
          "scheduleDate" in viewCase ? viewCase.scheduleDate : undefined,
      });
      const ownView = screen.getByTestId(viewCase.testId);
      const indicator = ownView.querySelector(
        '[data-myoxus-database-presence-indicator="true"][aria-label="Remote editor"]',
      );
      expect(
        indicator,
        `${viewCase.view.viewKind} owns its presence indicator`,
      ).not.toBeNull();
      if (viewCase.view.viewKind === DatabaseViewKind.Kanban) {
        expect(indicator?.getAttribute("data-dragging")).toBe("true");
      }
      cleanup();
    }
  });

  test("renders List and Gallery rows and actions inside their own Facade surfaces", () => {
    const { rerender } = renderDatabaseViewHost({
      activeViewId: "view-list",
      record: p9gRecord,
      rows: p9gRows,
    });

    const viewCases = [
      {
        viewId: listView.id,
        viewTestId: "database-list-view",
        rowTestId: "database-list-row",
        requiredTexts: [
          "Initial task",
          "Restricted task",
          "No access to this row document",
          "Deleted",
        ],
      },
      {
        viewId: galleryView.id,
        viewTestId: "database-gallery-view",
        rowTestId: "database-gallery-card",
        requiredTexts: [
          "Initial task",
          "Restricted task",
          "No access to this row document",
          "Deleted",
        ],
      },
    ] as const;

    for (const { requiredTexts, rowTestId, viewId, viewTestId } of viewCases) {
      rerender(p9gRecord, p9gRows, viewId);
      const view = within(screen.getByTestId(viewTestId));
      expect(view.getAllByTestId(rowTestId)).toHaveLength(p9gRows.length);
      for (const text of requiredTexts) {
        expect(view.getAllByText(text).length).toBeGreaterThan(0);
      }
      expect(view.getAllByTestId("database-row-action-menu")).toHaveLength(
        p9gRows.length,
      );
      if (viewTestId === "database-gallery-view") {
        expect(view.queryByText(p9gRecord.database.title)).toBeNull();
      }
      expect(
        view.queryByRole("button", { name: "Open row document" }),
      ).toBeNull();
      expect(view.queryByRole("button", { name: "Remove row" })).toBeNull();
    }
  });

  test("omits Gallery cover chrome when the active View disables empty covers", () => {
    const compactGallery = {
      ...galleryView,
      config: {
        ...galleryView.config,
        gallery: {
          ...galleryView.config.gallery!,
          showEmptyCover: false,
        },
      },
    };
    renderDatabaseViewHost({
      activeViewId: compactGallery.id,
      record: { ...p9gRecord, views: [compactGallery] },
      rows: p9gRows,
    });

    const gallery = within(screen.getByTestId("database-gallery-view"));
    expect(gallery.queryByText("No cover image")).toBeNull();
    expect(gallery.getAllByTestId("database-gallery-card")).toHaveLength(
      p9gRows.length,
    );
  });

  test("opens a density-backed List row in the shared Detail Peek before editing", async () => {
    const { onChanged } = renderDatabaseViewHost({
      activeViewId: listView.id,
      layout: "page",
      record: { ...p9gRecord, views: [listView] },
      rows: p9gRows,
    });
    const list = within(screen.getByTestId("database-list-view"));
    const row = within(list.getAllByTestId("database-list-row")[0]!);
    const openDetails = row.getByRole("button", {
      name: "Initial task: Open details",
    });
    expect(within(openDetails).getByText("Notes: Initial note")).not.toBeNull();

    fireEvent.click(openDetails);
    const context = within(
      await screen.findByTestId("database-row-detail-content"),
    );
    fireEvent.click(context.getByRole("button", { name: "Details" }));
    const details = await context.findByRole("region", { name: "Details" });
    fireEvent.doubleClick(within(details).getByText("Initial note"));
    const input = within(details).getByRole("textbox", { name: "Notes" });
    fireEvent.change(input, {
      target: { value: "Updated from List" },
    });
    fireEvent.blur(input);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test("opens a Gallery card in the shared Detail Peek", async () => {
    renderDatabaseViewHost({
      activeViewId: galleryView.id,
      layout: "page",
      record: { ...p9gRecord, views: [galleryView] },
      rows: p9gRows,
    });

    const gallery = within(screen.getByTestId("database-gallery-view"));
    fireEvent.click(
      gallery.getByRole("button", {
        name: "Initial task: Open details",
      }),
    );

    expect(
      await screen.findByTestId("database-row-detail-peek"),
    ).not.toBeNull();
  });

  test("Calendar renders only dated rows as Mantine schedule events and opens the shared Detail Peek", async () => {
    const onScheduleDateChange = vi.fn();
    renderDatabaseViewHost({
      activeViewId: calendarView.id,
      layout: "page",
      onScheduleDateChange,
      record: { ...p9gRecord, views: [calendarView] },
      rows: p9gRows,
      scheduleDate: "2026-07-11",
    });
    const surface = within(screen.getByTestId("database-calendar-view"));
    expect(surface.getByTestId("database-calendar-schedule")).not.toBeNull();
    const event = surface.getByRole("button", { name: "Initial task" });
    expect(surface.queryByText("Restricted task")).toBeNull();
    fireEvent.click(surface.getByRole("button", { name: "Next" }));
    expect(onScheduleDateChange).toHaveBeenCalledWith("2026-08-01");
    fireEvent.click(event);
    expect(
      await screen.findByTestId("database-row-detail-peek"),
    ).not.toBeNull();
  });

  test("opens a Timeline entry in the shared Detail Peek", async () => {
    renderDatabaseViewHost({
      activeViewId: timelineView.id,
      layout: "page",
      record: { ...p9gRecord, views: [timelineView] },
      rows: p9gRows,
      scheduleDate: "2026-07-15",
    });

    const timeline = within(screen.getByTestId("database-timeline-view"));
    fireEvent.click(timeline.getByRole("button", { name: /^Initial task,/ }));

    expect(await screen.findByTestId("database-row-detail-peek")).toBeTruthy();
  });

  test("rejects calendar and timeline views without a valid date field visibly", () => {
    const invalidCalendar = {
      ...calendarView,
      config: {
        ...calendarView.config,
        calendar: {
          ...calendarView.config.calendar!,
          dateFieldId: notesField.id,
        },
      },
    };
    const invalidTimeline = {
      ...timelineView,
      config: {
        ...timelineView.config,
        timeline: {
          ...timelineView.config.timeline!,
          startFieldId: notesField.id,
        },
      },
    };

    renderDatabaseViewHost({
      activeViewId: invalidCalendar.id,
      record: { ...p9gRecord, views: [invalidCalendar, invalidTimeline] },
      rows: p9gRows,
    });
    expect(screen.getByText("Calendar view needs a date field")).toBeTruthy();

    cleanup();
    renderDatabaseViewHost({
      activeViewId: invalidTimeline.id,
      record: { ...p9gRecord, views: [invalidCalendar, invalidTimeline] },
      rows: p9gRows,
    });
    expect(screen.getByText("Timeline view needs a date field")).toBeTruthy();
  });

  test("keeps the primary description visible and collapses secondary detail groups", async () => {
    renderDatabaseViewHost({
      initialRowId: p9gRows[0]!.row.id,
      record: {
        ...p9gRecord,
        fields: [...p9gRecord.fields, statusField],
      },
      rows: p9gRows,
    });

    const detail = within(screen.getByTestId("database-row-detail-content"));
    expect(screen.getByText("Row details")).toBeTruthy();
    expect(detail.getByText("Initial note")).toBeTruthy();
    const populatedDetails = detail.getByRole("button", {
      name: "Details",
    });
    expect(populatedDetails.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(populatedDetails);
    expect(populatedDetails.getAttribute("aria-expanded")).toBe("true");
    const emptyProperties = detail.getByRole("button", {
      name: "1 more property",
    });
    expect(emptyProperties.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(emptyProperties);
    expect(emptyProperties.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() =>
      expect(
        detail.getByRole("combobox", { name: "Status", hidden: true }),
      ).toBeTruthy(),
    );
  });

  test("opens only a server-provided deep-linked Row in shared Side Peek", () => {
    renderDatabaseViewHost({ initialRowId: p9gRows[0]!.row.id, rows: p9gRows });
    expect(screen.getByTestId("database-row-detail-content")).toBeTruthy();

    cleanup();
    renderDatabaseViewHost({ initialRowId: "missing-row", rows: p9gRows });
    expect(screen.queryByTestId("database-row-detail-content")).toBeNull();
  });
});
