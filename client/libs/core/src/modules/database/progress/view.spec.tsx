// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import {
  createDatabaseRowMutation,
  DatabaseFieldKind,
  DatabaseFilterConjunction,
  DatabaseFilterOperator,
  databaseProgressQuery,
  DatabaseStatusGroup,
  updateDatabaseViewMutation,
} from "@myoxus/graphql";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import {
  progressField,
  progressRecord,
  progressRows,
  progressView,
  statusField,
  titleField,
} from "../test-fixtures";
import { renderDatabaseViewHost } from "../test-harness";
import { type DatabaseField, type DatabaseView } from "../types";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

vi.mock("@myoxus/core/modules/peek-view/view/doc-preview", () => ({
  DocPeekPreview: ({ docRef }: { docRef: { docId: string } }) => (
    <div data-testid="database-row-content-editor">{docRef.docId}</div>
  ),
}));

describe("Database Progress view", () => {
  test("renders the server-owned Progress summary with native expandable row controls", async () => {
    const gql = vi.fn(async ({ query }) =>
      query === databaseProgressQuery
        ? {
            workspace: {
              databaseProgress: {
                averageProgress: 65,
                blockedCount: 1,
                completedCount: 0,
                databaseId: "database-1",
                groups: [
                  {
                    averageProgress: 65,
                    blockedCount: 1,
                    completedCount: 0,
                    incompleteCount: 1,
                    key: "doing",
                    label: "Doing",
                    overdueCount: 1,
                    totalCount: 1,
                  },
                ],
                groupFieldId: statusField.id,
                incompleteCount: 1,
                overdueCount: 1,
                progressFieldId: progressField.id,
                totalCount: 1,
                viewId: progressView.id,
              },
            },
          }
        : {},
    );

    const { rerender } = renderDatabaseViewHost({
      activeViewId: progressView.id,
      gql,
      layout: "page",
      record: progressRecord,
      rows: progressRows,
    });

    expect(await screen.findByTestId("database-progress-view")).not.toBeNull();
    expect(
      screen.getByTestId("database-progress-summary").textContent,
    ).toContain("65%");
    expect(
      screen.getByRole("progressbar", { name: "Doing: 65%" }),
    ).not.toBeNull();
    expect(screen.getByText("1 Blocked")).not.toBeNull();
    expect(screen.getByText("1 Overdue")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Filter: Doing" }));
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: updateDatabaseViewMutation,
          variables: {
            input: expect.objectContaining({
              config: expect.objectContaining({
                progress: expect.objectContaining({
                  filterTree: {
                    conjunction: DatabaseFilterConjunction.And,
                    groups: [],
                    rules: [
                      {
                        fieldId: statusField.id,
                        operator: DatabaseFilterOperator.Is,
                        value: { optionId: "doing" },
                      },
                    ],
                  },
                }),
              }),
            }),
          },
        }),
      ),
    );
    rerender(
      {
        ...progressRecord,
        views: [{ ...progressView, editRevision: 2 }],
      },
      progressRows,
    );
    await waitFor(() =>
      expect(
        gql.mock.calls.filter(
          ([request]) => request.query === databaseProgressQuery,
        ),
      ).toHaveLength(2),
    );

    const rowControl = within(
      screen.getByTestId("database-progress-rows"),
    ).getByRole("button", { name: "Initial task: 65%" });
    rowControl.focus();
    expect(document.activeElement).toBe(rowControl);
    expect(rowControl.tagName).toBe("BUTTON");
    expect(rowControl.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(rowControl);
    await waitFor(() =>
      expect(rowControl.getAttribute("aria-expanded")).toBe("true"),
    );
    fireEvent.click(
      within(screen.getByTestId("database-progress-rows")).getByTestId(
        "database-row-action-menu",
      ),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Open details" }),
    );
    expect(
      await screen.findByTestId("database-row-detail-content"),
    ).not.toBeNull();
    expect(screen.getByTestId("database-row-detail-peek")).not.toBeNull();
  });

  test("localizes semantic Status groups without rewriting Select option labels", async () => {
    const semanticProgressView: DatabaseView = {
      ...progressView,
      id: "view-progress-semantic-status",
    };
    const semanticStatusField: DatabaseField = {
      ...statusField,
      fieldType: DatabaseFieldKind.Status,
      config: {
        ...statusField.config,
        kind: DatabaseFieldKind.Status,
        select: null,
        status: {
          defaultOptionId: "todo",
          options: [
            {
              colorRole: "orange",
              group: DatabaseStatusGroup.Active,
              id: "doing",
              name: "In progress",
              position: 0,
            },
          ],
        },
      },
    };
    const gql = vi.fn(async ({ query }) =>
      query === databaseProgressQuery
        ? {
            workspace: {
              databaseProgress: {
                averageProgress: 65,
                blockedCount: 0,
                completedCount: 0,
                groups: [
                  {
                    averageProgress: 65,
                    blockedCount: 0,
                    completedCount: 0,
                    incompleteCount: 1,
                    key: "active",
                    label: "Active",
                    overdueCount: 0,
                    totalCount: 1,
                  },
                ],
                groupFieldId: semanticStatusField.id,
                incompleteCount: 1,
                overdueCount: 0,
                progressFieldId: progressField.id,
                totalCount: 1,
                viewId: semanticProgressView.id,
              },
            },
          }
        : {},
    );

    renderDatabaseViewHost({
      activeViewId: semanticProgressView.id,
      gql,
      record: {
        ...progressRecord,
        fields: [titleField, semanticStatusField, progressField],
        views: [semanticProgressView],
      },
      rows: progressRows,
    });

    const groups = await screen.findByTestId("database-progress-groups");
    expect(groups.textContent).toContain("Localized active");
    expect(
      within(groups).getByRole("progressbar", {
        name: "Localized active: 65%",
      }),
    ).not.toBeNull();
    expect(screen.queryByText("Active")).toBeNull();
  });

  test("renders an actionable Progress empty state through the canonical row mutation", async () => {
    const gql = vi.fn(async ({ query }) =>
      query === databaseProgressQuery
        ? {
            workspace: {
              databaseProgress: {
                averageProgress: null,
                blockedCount: 0,
                completedCount: 0,
                groups: [],
                groupFieldId: statusField.id,
                incompleteCount: 0,
                overdueCount: 0,
                progressFieldId: progressField.id,
                totalCount: 0,
                viewId: progressView.id,
              },
            },
          }
        : {},
    );
    const { onChanged } = renderDatabaseViewHost({
      activeViewId: progressView.id,
      gql,
      record: progressRecord,
      rows: [],
    });

    expect(await screen.findByText("No tasks yet")).not.toBeNull();
    fireEvent.click(screen.getByTestId("database-progress-add-task"));
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseRowMutation,
          variables: {
            input: {
              databaseId: "database-1",
              title: "Untitled row",
            },
          },
        }),
      ),
    );
    expect(onChanged).toHaveBeenCalled();
  });
});
