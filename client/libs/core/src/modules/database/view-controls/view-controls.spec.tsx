// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import {
  DatabaseCalendarDateMode,
  DatabaseCalendarInitialRange,
  DatabaseCardDensity,
  DatabaseFieldKind,
  DatabaseFilterConjunction,
  DatabaseFilterOperator,
  DatabaseGalleryCardDensity,
  DatabaseListDensity,
  DatabaseSortDirection,
  DatabaseTimelineGroupBy,
  DatabaseTimelineOrder,
  DatabaseTimelineZoom,
  updateDatabaseViewMutation,
  upsertDatabaseViewUserStateMutation,
} from "@myoxus/graphql";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type Document as HappyDocument,
  PropertySymbol,
  type Window as HappyWindow,
} from "happy-dom";

import {
  calendarView,
  confidenceField,
  dueField,
  filesField,
  galleryView,
  kanbanRecord,
  kanbanRows,
  kanbanView,
  listView,
  notesField,
  p9gRecord,
  plannedField,
  progressField,
  progressRecord,
  progressView,
  record,
  relationField,
  rows,
  statusField,
  tableView,
  timelineView,
  TIMESTAMP,
  titleField,
} from "../test-fixtures";
import { renderDatabaseViewHost, selectFacadeOption } from "../test-harness";
import { type DatabaseView } from "../types";
import { renderDatabaseViewSettings } from "../view-settings-test-harness";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

const timerNames = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
] as const;
const originalTimers = Object.fromEntries(
  timerNames.map((name) => [name, globalThis[name]]),
);
const browserWindow = (document as unknown as HappyDocument)[
  PropertySymbol.defaultView
] as HappyWindow;

// Mantine transitions use Window timers even with env="test". Keep their
// ownership on this DOM, not Node timers that can outlive environment teardown.
beforeEach(() => {
  Object.assign(
    globalThis,
    Object.fromEntries(
      timerNames.map((name) => [name, browserWindow[name].bind(browserWindow)]),
    ),
  );
});
afterEach(async () => {
  cleanup();
  try {
    // Let Happy DOM's zero-delay batch settle before cancelling remaining frames.
    await new Promise<void>((resolve) => browserWindow.setTimeout(resolve, 0));
    await browserWindow.happyDOM.abort();
  } finally {
    Object.assign(globalThis, originalTimers);
  }
});

describe("Database view controls", () => {
  test("clears table search immediately through personal state without clearing other overrides", async () => {
    const onSearchChange = vi.fn();
    const searchableView: DatabaseView = {
      ...tableView,
      config: {
        ...tableView.config,
        table: {
          ...tableView.config.table!,
          searchFieldIds: [titleField.id],
        },
      },
    };
    const { gql } = renderDatabaseViewHost({
      effectiveState: {
        personalState: {
          collapsedGroupKeys: ["doing"],
          editRevision: 4,
          fieldWidthOverrides: [{ fieldId: notesField.id, width: 240 }],
          filterTree: null,
          searchText: "roadmap",
          sort: [
            {
              direction: DatabaseSortDirection.Desc,
              fieldId: dueField.id,
            },
          ],
        },
      },
      onSearchChange,
      record: { ...record, views: [searchableView] },
      search: "roadmap",
    });

    expect(
      await screen.findByRole("searchbox", { name: "Search" }),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(onSearchChange).toHaveBeenCalledWith(""));
    expect(gql).toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: upsertDatabaseViewUserStateMutation,
        variables: {
          input: expect.objectContaining({
            collapsedGroupKeys: ["doing"],
            expectedEditRevision: 4,
            fieldWidthOverrides: [{ fieldId: notesField.id, width: 240 }],
            searchText: "",
            sort: [
              {
                direction: DatabaseSortDirection.Desc,
                fieldId: dueField.id,
              },
            ],
          }),
        },
      }),
    );
  });

  test("debounces search persistence once and flushes the latest value on blur", async () => {
    const searchableView: DatabaseView = {
      ...tableView,
      config: {
        ...tableView.config,
        table: {
          ...tableView.config.table!,
          searchFieldIds: [titleField.id],
        },
      },
    };
    const onSearchChange = vi.fn();
    const { gql, personalStateAcknowledgements } = renderDatabaseViewHost({
      onSearchChange,
      record: { ...record, views: [searchableView] },
    });
    const search = screen.getByRole("searchbox", { name: "Search" });

    fireEvent.change(search, { target: { value: "r" } });
    fireEvent.change(search, { target: { value: "ro" } });
    fireEvent.change(search, { target: { value: "roadmap" } });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await waitFor(() => expect(onSearchChange).toHaveBeenCalledWith("roadmap"));
    expect(
      gql.mock.calls.filter(
        ([request]) =>
          (request.query ?? request.mutation) ===
          upsertDatabaseViewUserStateMutation,
      ),
    ).toHaveLength(1);

    expect(personalStateAcknowledgements).toHaveLength(1);
    const acknowledgedRevision = personalStateAcknowledgements[0]!;
    expect(acknowledgedRevision).toBeGreaterThan(0);
    fireEvent.change(search, { target: { value: "on blur" } });
    fireEvent.blur(search);
    await waitFor(() => expect(onSearchChange).toHaveBeenCalledWith("on blur"));
    const searchWrites = gql.mock.calls.filter(
      ([request]) =>
        (request.query ?? request.mutation) ===
        upsertDatabaseViewUserStateMutation,
    );
    expect(searchWrites).toHaveLength(2);
    expect(searchWrites[1]?.[0]).toEqual(
      expect.objectContaining({
        variables: {
          input: expect.objectContaining({
            expectedEditRevision: acknowledgedRevision,
            searchText: "on blur",
          }),
        },
      }),
    );
  });

  test("creates saved table filters and multi-column sort through view settings", async () => {
    const sortableView: DatabaseView = {
      ...tableView,
      config: {
        ...tableView.config,
        table: {
          ...tableView.config.table!,
          visibleFieldIds: [titleField.id, notesField.id, dueField.id],
        },
      },
    };
    const sortableRecord = {
      ...record,
      fields: [titleField, notesField, dueField],
      views: [sortableView],
    };
    const filterRender = renderDatabaseViewHost({ record: sortableRecord });

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const filterModal = await screen.findByTestId(
      "database-view-settings-modal",
    );
    fireEvent.click(
      within(filterModal).getByRole("button", { name: "Add Filter Rule" }),
    );
    const filterValue =
      within(filterModal).getByPlaceholderText("Filter value");
    expect(filterValue).not.toBeNull();
    expect(
      filterValue.closest(
        '[data-myoxus-ui-role="database-filter-rule-controls"]',
      )?.className,
    ).toContain("mantine-Stack-root");
    fireEvent.change(
      within(filterModal).getByRole("textbox", { name: "Name" }),
      {
        target: { value: "roadmap" },
      },
    );
    fireEvent.click(within(filterModal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(filterRender.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                table: expect.objectContaining({
                  filter: [],
                  filterTree: {
                    conjunction: DatabaseFilterConjunction.And,
                    groups: [],
                    rules: [
                      {
                        fieldId: titleField.id,
                        operator: DatabaseFilterOperator.Contains,
                        value: { text: "roadmap" },
                      },
                    ],
                  },
                }),
              },
            }),
          }),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("database-view-settings-modal")).toBeNull(),
    );

    cleanup();
    const sortRender = renderDatabaseViewSettings({
      record: sortableRecord,
      section: "sort",
      view: sortableView,
    });
    const sortModal = await screen.findByTestId("database-view-settings-modal");
    fireEvent.click(
      within(sortModal).getByRole("button", { name: "Add sort" }),
    );
    fireEvent.click(
      within(sortModal).getByRole("button", { name: "Add sort" }),
    );
    fireEvent.click(
      within(sortModal).getByRole("button", { name: "Add sort" }),
    );
    fireEvent.click(
      within(sortModal).getAllByRole("button", { name: "Move up" })[2]!,
    );
    fireEvent.click(
      within(sortModal).getAllByRole("button", { name: "Move up" })[1]!,
    );
    fireEvent.click(within(sortModal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(sortRender.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: {
            input: expect.objectContaining({
              config: {
                table: expect.objectContaining({
                  sort: [
                    {
                      direction: DatabaseSortDirection.Asc,
                      fieldId: dueField.id,
                    },
                    {
                      direction: DatabaseSortDirection.Asc,
                      fieldId: titleField.id,
                    },
                    {
                      direction: DatabaseSortDirection.Asc,
                      fieldId: notesField.id,
                    },
                  ],
                }),
              },
              databaseId: "database-1",
              expectedEditRevision: 1,
              force: false,
              viewId: tableView.id,
            }),
          },
        }),
      ),
    );
  });

  test("preserves a dirty filter draft across an effective-state refresh", async () => {
    const user = userEvent.setup();
    const { gql, rerender } = renderDatabaseViewHost();

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const filterModal = await screen.findByTestId(
      "database-view-settings-modal",
    );
    fireEvent.click(
      within(filterModal).getByRole("button", { name: "Add Filter Rule" }),
    );
    const filterValue =
      within(filterModal).getByPlaceholderText("Filter value");
    await user.type(filterValue, "package acceptance");

    rerender(
      {
        ...record,
        views: record.views.map((view) => ({ ...view })),
      },
      rows,
    );

    expect((filterValue as HTMLInputElement).value).toBe("package acceptance");
    fireEvent.click(within(filterModal).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: expect.objectContaining({
                table: expect.objectContaining({
                  filterTree: expect.objectContaining({
                    rules: [
                      expect.objectContaining({
                        value: { text: "package acceptance" },
                      }),
                    ],
                  }),
                }),
              }),
            }),
          }),
        }),
      ),
    );
  });

  test("shows effective multi-sort in Table headers and preserves lower priorities", async () => {
    const sortableView: DatabaseView = {
      ...tableView,
      config: {
        ...tableView.config,
        table: {
          ...tableView.config.table!,
          visibleFieldIds: [titleField.id, statusField.id],
        },
      },
    };
    const { gql } = renderDatabaseViewHost({
      effectiveState: {
        effectiveSort: [
          {
            direction: DatabaseSortDirection.Asc,
            fieldId: titleField.id,
          },
          {
            direction: DatabaseSortDirection.Desc,
            fieldId: statusField.id,
          },
        ],
      },
      record: {
        ...record,
        fields: [titleField, statusField],
        views: [sortableView],
      },
    });

    const headers = screen.getAllByTestId("database-field-header");
    expect(headers[0]?.getAttribute("aria-sort")).toBe("ascending");
    expect(headers[1]?.getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByText("Ascending · 1")).not.toBeNull();
    expect(screen.getByText("Descending · 2")).not.toBeNull();

    fireEvent.click(
      within(headers[1]!).getByRole("button", {
        name: "Configure field: Status",
      }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Ascending" }));
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: {
            input: expect.objectContaining({
              config: {
                table: expect.objectContaining({
                  sort: [
                    {
                      direction: DatabaseSortDirection.Asc,
                      fieldId: statusField.id,
                    },
                    {
                      direction: DatabaseSortDirection.Asc,
                      fieldId: titleField.id,
                    },
                  ],
                }),
              },
            }),
          },
        }),
      ),
    );
  });

  test("creates, reorders and persists nested typed filter groups", async () => {
    const { gql } = renderDatabaseViewSettings({ section: "filter" });
    const modal = await screen.findByTestId("database-view-settings-modal");
    const root = within(modal).getByTestId("database-filter-group-0");
    fireEvent.click(
      within(root).getByRole("button", { name: "Add Filter Rule" }),
    );
    fireEvent.click(
      within(root).getByRole("button", { name: "Add Filter Rule" }),
    );
    const rootValues = within(root).getAllByRole("textbox", { name: "Name" });
    fireEvent.change(rootValues[0]!, { target: { value: "first" } });
    fireEvent.change(rootValues[1]!, { target: { value: "second" } });
    fireEvent.click(
      within(root).getAllByRole("button", { name: "Move up" })[1]!,
    );
    fireEvent.click(within(root).getByRole("button", { name: "Grouping +" }));
    const nested = within(modal).getByTestId("database-filter-group-1");
    fireEvent.click(
      within(nested).getByRole("button", { name: "Add Filter Rule" }),
    );
    fireEvent.change(within(nested).getByRole("textbox", { name: "Name" }), {
      target: { value: "nested" },
    });
    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                table: expect.objectContaining({
                  filterTree: {
                    conjunction: DatabaseFilterConjunction.And,
                    groups: [
                      {
                        conjunction: DatabaseFilterConjunction.And,
                        groups: [],
                        rules: [
                          expect.objectContaining({
                            value: { text: "nested" },
                          }),
                        ],
                      },
                    ],
                    rules: [
                      expect.objectContaining({ value: { text: "second" } }),
                      expect.objectContaining({ value: { text: "first" } }),
                    ],
                  },
                }),
              },
            }),
          }),
        }),
      ),
    );
  });

  test("keeps Table field ownership separate from display settings", async () => {
    const propertiesView: DatabaseView = {
      ...tableView,
      config: {
        ...tableView.config,
        table: {
          ...tableView.config.table!,
          visibleFieldIds: [titleField.id, notesField.id, dueField.id],
        },
      },
    };
    const propertiesRecord = {
      ...record,
      fields: [titleField, notesField, dueField],
      views: [propertiesView],
    };
    const fieldsRender = renderDatabaseViewSettings({
      section: "fields",
      view: propertiesView,
      record: propertiesRecord,
    });
    const modal = await screen.findByTestId("database-view-settings-modal");
    fireEvent.click(
      within(modal).getByRole("button", { name: "Move up: Due" }),
    );
    fireEvent.click(within(modal).getByRole("button", { name: "Hide: Notes" }));
    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fieldsRender.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                table: expect.objectContaining({
                  visibleFieldIds: [titleField.id, dueField.id],
                }),
              },
            }),
          }),
        }),
      ),
    );

    cleanup();
    const displayRender = renderDatabaseViewSettings({
      section: "display",
      view: propertiesView,
      record: propertiesRecord,
    });
    const displayModal = await screen.findByTestId(
      "database-view-settings-modal",
    );
    fireEvent.click(
      within(displayModal).getByRole("combobox", { name: "Search · fields" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Name" }));
    fireEvent.change(
      within(displayModal).getByRole("textbox", {
        name: "Column width: Due",
      }),
      { target: { value: "320" } },
    );
    fireEvent.click(within(displayModal).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(displayRender.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                table: expect.objectContaining({
                  fieldWidths: [{ fieldId: dueField.id, width: 320 }],
                  searchFieldIds: [titleField.id],
                  visibleFieldIds: [titleField.id, notesField.id, dueField.id],
                }),
              },
            }),
          }),
        }),
      ),
    );
  });

  test("persists one-grapheme view icons and keeps long tab names accessible", async () => {
    const longName =
      "Quarterly delivery roadmap with a deliberately long view name";
    const iconView = { ...tableView, name: longName };
    renderDatabaseViewHost({
      record: { ...record, views: [iconView] },
    });

    const tab = screen.getByRole("tab", { name: longName });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(tab.getAttribute("title")).toBe(longName);

    cleanup();
    const { gql: settingsGql } = renderDatabaseViewSettings({
      section: "advanced",
      record: { ...record, views: [iconView] },
      view: iconView,
    });
    const modal = await screen.findByTestId("database-view-settings-modal");
    fireEvent.click(within(modal).getByText("Emoji"));
    const save = within(modal).getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(modal).getByRole("textbox", { name: "Emoji" }), {
      target: { value: "📊" },
    });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() =>
      expect(settingsGql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              icon: { emoji: "📊" },
              name: longName,
            }),
          }),
        }),
      ),
    );
  });

  test("persists Kanban display separately from card fields", async () => {
    const settingsRecord = {
      ...kanbanRecord,
      fields: [titleField, statusField, notesField, dueField, filesField],
      views: [kanbanView],
    };
    const layoutRender = renderDatabaseViewHost({
      activeViewId: kanbanView.id,
      record: settingsRecord,
      rows: kanbanRows,
    });

    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    let modal = await screen.findByTestId("database-view-settings-modal");
    await selectFacadeOption(modal, "Cover field", "Files");
    await selectFacadeOption(modal, "Card density", "Comfortable");
    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(layoutRender.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                kanban: expect.objectContaining({
                  cardDensity: DatabaseCardDensity.Comfortable,
                  coverFieldId: filesField.id,
                }),
              },
            }),
          }),
        }),
      ),
    );

    cleanup();
    const propertiesRender = renderDatabaseViewSettings({
      record: settingsRecord,
      section: "fields",
      view: kanbanView,
    });
    modal = await screen.findByTestId("database-view-settings-modal");
    fireEvent.click(within(modal).getByRole("button", { name: "Hide: Notes" }));
    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(propertiesRender.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                kanban: expect.objectContaining({
                  visibleFieldIds: expect.not.arrayContaining([notesField.id]),
                }),
              },
            }),
          }),
        }),
      ),
    );
  });

  test("persists List density and field labels from Display", async () => {
    const listRecord = { ...p9gRecord, views: [listView] };
    const { gql } = renderDatabaseViewSettings({
      section: "display",
      record: listRecord,
      view: listView,
    });

    const modal = await screen.findByTestId("database-view-settings-modal");
    await selectFacadeOption(modal, "List density", "Compact");
    fireEvent.click(
      within(modal).getByRole("switch", { name: "Show · fields" }),
    );
    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                list: expect.objectContaining({
                  density: DatabaseListDensity.Compact,
                  showFieldLabels: false,
                }),
              },
            }),
          }),
        }),
      ),
    );
  });

  test("persists Gallery cover, density and empty cover from Display", async () => {
    const galleryRecord = {
      ...p9gRecord,
      fields: [...p9gRecord.fields, filesField],
      views: [galleryView],
    };
    const { gql } = renderDatabaseViewSettings({
      section: "display",
      record: galleryRecord,
      view: galleryView,
    });

    const modal = await screen.findByTestId("database-view-settings-modal");
    await selectFacadeOption(modal, "Cover field", "Files");
    await selectFacadeOption(modal, "Card density", "Large");
    fireEvent.click(
      within(modal).getByRole("switch", { name: "Show · Empty" }),
    );
    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                gallery: expect.objectContaining({
                  cardDensity: DatabaseGalleryCardDensity.Large,
                  coverFieldId: filesField.id,
                  showEmptyCover: false,
                }),
              },
            }),
          }),
        }),
      ),
    );
  });

  test("separates Calendar date source from display controls", async () => {
    const calendarRecord = {
      ...p9gRecord,
      fields: [...p9gRecord.fields, plannedField],
      views: [calendarView],
    };
    const fieldsRender = renderDatabaseViewSettings({
      section: "fields",
      record: calendarRecord,
      view: calendarView,
    });
    const modal = await screen.findByTestId("database-view-settings-modal");
    await selectFacadeOption(modal, "Date", "Planned");
    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(fieldsRender.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                calendar: expect.objectContaining({
                  dateFieldId: plannedField.id,
                }),
              },
            }),
          }),
        }),
      ),
    );

    cleanup();
    const displayRender = renderDatabaseViewSettings({
      section: "display",
      record: calendarRecord,
      view: calendarView,
    });
    const displayModal = await screen.findByTestId(
      "database-view-settings-modal",
    );
    fireEvent.click(within(displayModal).getByRole("radio", { name: "Year" }));
    await selectFacadeOption(displayModal, "Date · From", "this year");
    fireEvent.click(within(displayModal).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(displayRender.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                calendar: expect.objectContaining({
                  dateMode: DatabaseCalendarDateMode.Year,
                  initialRange: DatabaseCalendarInitialRange.CurrentYear,
                }),
              },
            }),
          }),
        }),
      ),
    );
  });

  test("separates Timeline boundaries from display controls", async () => {
    const timelineRecord = {
      ...p9gRecord,
      fields: [...p9gRecord.fields, plannedField],
      views: [timelineView],
    };
    const fieldsRender = renderDatabaseViewSettings({
      section: "fields",
      record: timelineRecord,
      view: timelineView,
    });

    const modal = await screen.findByTestId("database-view-settings-modal");
    await selectFacadeOption(modal, "Start", "Planned");
    await selectFacadeOption(modal, "End", "Due");
    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fieldsRender.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                timeline: expect.objectContaining({
                  endFieldId: dueField.id,
                  startFieldId: plannedField.id,
                }),
              },
            }),
          }),
        }),
      ),
    );

    cleanup();
    const displayRender = renderDatabaseViewSettings({
      section: "display",
      record: timelineRecord,
      view: timelineView,
    });
    const displayModal = await screen.findByTestId(
      "database-view-settings-modal",
    );
    await selectFacadeOption(displayModal, "Zoom", "Quarter");
    await selectFacadeOption(displayModal, "Date grouping", "Week");
    await selectFacadeOption(displayModal, "Group order", "Descending");
    fireEvent.click(within(displayModal).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(displayRender.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                timeline: expect.objectContaining({
                  groupBy: DatabaseTimelineGroupBy.Week,
                  order: DatabaseTimelineOrder.Desc,
                  zoom: DatabaseTimelineZoom.Quarter,
                }),
              },
            }),
          }),
        }),
      ),
    );
  });

  test("separates Progress metric from grouping", async () => {
    const progressSettingsRecord = {
      ...progressRecord,
      fields: [...progressRecord.fields, confidenceField, dueField],
      views: [progressView],
    };
    const fieldsRender = renderDatabaseViewSettings({
      section: "fields",
      record: progressSettingsRecord,
      view: progressView,
    });

    const modal = await screen.findByTestId("database-view-settings-modal");
    await selectFacadeOption(modal, "Progress field", "Confidence");
    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fieldsRender.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                progress: expect.objectContaining({
                  progressFieldId: confidenceField.id,
                }),
              },
            }),
          }),
        }),
      ),
    );

    cleanup();
    const groupRender = renderDatabaseViewSettings({
      section: "group",
      record: progressSettingsRecord,
      view: progressView,
    });
    const groupModal = await screen.findByTestId(
      "database-view-settings-modal",
    );
    await selectFacadeOption(groupModal, "Grouping", "Due");
    fireEvent.click(within(groupModal).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(groupRender.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                progress: expect.objectContaining({
                  groupFieldId: dueField.id,
                  progressFieldId: progressField.id,
                }),
              },
            }),
          }),
        }),
      ),
    );
  });

  test("configures primary and subgroup rules through the shared Group control", async () => {
    const user = userEvent.setup();
    const groupView: DatabaseView = {
      ...tableView,
      config: {
        ...tableView.config,
        table: {
          ...tableView.config.table!,
          visibleFieldIds: [
            titleField.id,
            notesField.id,
            statusField.id,
            dueField.id,
          ],
        },
      },
    };
    const groupRecord = {
      ...record,
      fields: [titleField, notesField, statusField, dueField],
      views: [groupView],
    };
    const { gql } = renderDatabaseViewSettings({
      section: "group",
      record: groupRecord,
      view: groupView,
    });

    const modal = await screen.findByTestId("database-view-settings-modal");
    await user.click(within(modal).getByRole("combobox", { name: "Grouping" }));
    await user.click(await screen.findByRole("option", { name: "Status" }));
    await user.click(
      within(modal).getByRole("combobox", { name: "Subgroup field" }),
    );
    await user.click(await screen.findByRole("option", { name: "Due" }));
    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                table: expect.objectContaining({
                  group: {
                    descending: false,
                    fieldId: statusField.id,
                    showEmptyGroups: true,
                  },
                  subgroup: {
                    descending: false,
                    fieldId: dueField.id,
                    showEmptyGroups: true,
                  },
                }),
              },
            }),
          }),
        }),
      ),
    );
  });

  test("edits and clears an active server-owned saved filter", async () => {
    const filteredView: DatabaseView = {
      ...tableView,
      config: {
        ...tableView.config,
        table: {
          ...tableView.config.table!,
          filter: [
            {
              fieldId: titleField.id,
              operator: DatabaseFilterOperator.Contains,
              value: { kind: "text", value: "old" },
            },
          ],
          sort: [
            {
              direction: DatabaseSortDirection.Asc,
              fieldId: titleField.id,
            },
          ],
        },
      },
    };
    const filteredRecord = { ...record, views: [filteredView] };
    const { gql } = renderDatabaseViewHost({ record: filteredRecord });

    expect(
      screen.getByTestId("database-active-filter-bar").textContent,
    ).toContain("old");
    fireEvent.click(screen.getByRole("button", { name: /old/ }));
    const modal = await screen.findByTestId("database-view-settings-modal");
    const valueInput = within(modal).getByRole("textbox", { name: "Name" });
    fireEvent.change(valueInput, { target: { value: "new" } });
    fireEvent.click(within(modal).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                table: expect.objectContaining({
                  filter: [],
                  filterTree: expect.objectContaining({
                    rules: [
                      expect.objectContaining({ value: { text: "new" } }),
                    ],
                  }),
                  sort: [
                    {
                      direction: DatabaseSortDirection.Asc,
                      fieldId: titleField.id,
                    },
                  ],
                }),
              },
            }),
          }),
        }),
      ),
    );

    cleanup();
    const clearRender = renderDatabaseViewHost({ record: filteredRecord });
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() =>
      expect(clearRender.gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              config: {
                table: expect.objectContaining({
                  filter: [],
                  filterTree: null,
                }),
              },
            }),
          }),
        }),
      ),
    );
  });

  test("renders relation filter chips with loaded row titles instead of ids", () => {
    const relationTableView: DatabaseView = {
      ...tableView,
      config: {
        ...tableView.config,
        table: {
          ...tableView.config.table!,
          visibleFieldIds: [titleField.id, relationField.id],
        },
      },
    };
    renderDatabaseViewHost({
      effectiveState: {
        effectiveFilterTree: {
          conjunction: DatabaseFilterConjunction.And,
          groups: [],
          rules: [
            {
              fieldId: relationField.id,
              operator: DatabaseFilterOperator.ContainsRow,
              value: { kind: "relation_row_id", value: "phase-1" },
            },
          ],
        },
      },
      record: {
        ...record,
        fields: [titleField, relationField],
        views: [relationTableView],
      },
      rows: [
        {
          ...rows[0]!,
          cells: [
            ...rows[0]!.cells,
            {
              ...rows[0]!.cells[0]!,
              fieldId: relationField.id,
              fieldType: DatabaseFieldKind.Relation,
              value: {
                ...rows[0]!.cells[0]!.value,
                kind: DatabaseFieldKind.Relation,
                relation: ["phase-1"],
                relationTargets: [
                  {
                    deleted: false,
                    contentDocument: null,
                    redacted: false,
                    rowId: "phase-1",
                    title: "Delivery phase",
                  },
                ],
                text: null,
              },
            },
          ],
        },
      ],
    });

    const filterBar = screen.getByTestId("database-active-filter-bar");
    expect(filterBar.textContent).toContain("Delivery phase");
    expect(filterBar.textContent).not.toContain("phase-1");
  });

  test("keeps viewers fixed to personal scope and removes a saved filter through an explicit empty override", async () => {
    const filteredView: DatabaseView = {
      ...tableView,
      config: {
        ...tableView.config,
        table: {
          ...tableView.config.table!,
          filter: [
            {
              fieldId: titleField.id,
              operator: DatabaseFilterOperator.Contains,
              value: { kind: "text", value: "saved" },
            },
          ],
        },
      },
    };
    const { gql } = renderDatabaseViewHost({
      effectiveState: { canEditShared: false },
      record: { ...record, views: [filteredView] },
    });

    fireEvent.click(
      within(screen.getByTestId("database-view-toolbar")).getAllByRole(
        "button",
      )[0]!,
    );
    const modal = await screen.findByTestId("database-view-settings-modal");
    expect(within(modal).getByText("Personal")).not.toBeNull();
    expect(within(modal).queryByText("View")).toBeNull();
    fireEvent.click(within(modal).getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete: Name" }));
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          mutation: upsertDatabaseViewUserStateMutation,
          variables: {
            input: expect.objectContaining({
              expectedEditRevision: 0,
              filterTree: {
                conjunction: DatabaseFilterConjunction.And,
                groups: [],
                rules: [],
              },
            }),
          },
        }),
      ),
    );
  });

  test("keeps search personal without presenting an inapplicable shared save", () => {
    renderDatabaseViewHost({
      effectiveState: {
        personalState: {
          collapsedGroupKeys: [],
          editRevision: 2,
          fieldWidthOverrides: [],
          filterTree: null,
          searchText: "private search",
          sort: null,
          updatedAt: TIMESTAMP,
          viewId: tableView.id,
        },
        searchText: "private search",
      },
      rows: [],
    });

    expect(screen.getByText("Personal · View settings")).not.toBeNull();
    expect(screen.getByText("No results found.")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Save · View" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Reset · Personal" }),
    ).not.toBeNull();
  });

  test("distinguishes an empty Table from an empty search result", () => {
    renderDatabaseViewHost({ rows: [] });

    expect(screen.getByText("No rows yet")).not.toBeNull();
    expect(screen.queryByText("No results found.")).toBeNull();
  });
});
