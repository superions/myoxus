// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import {
  attachDatabaseRowContentDocumentMutation,
  createDatabaseRowContentDocumentMutation,
  databaseRowActivityQuery,
  DatabaseRowContentDocumentState,
  detachDatabaseRowContentDocumentMutation,
  indexerSearchDocsQuery,
} from "@myoxus/graphql";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { p9gRecord, rows } from "../test-fixtures";
import { renderDatabaseViewHost } from "../test-harness";
import type { DatabaseRowRecord } from "../types";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

vi.mock("@myoxus/core/modules/peek-view/view/doc-preview", () => ({
  DocPeekPreview: ({ docRef }: { docRef: { docId: string } }) => (
    <div data-testid="database-row-content-editor">{docRef.docId}</div>
  ),
}));

function contentRow(
  state: DatabaseRowContentDocumentState | null,
): DatabaseRowRecord {
  return {
    ...rows[0]!,
    row: {
      ...rows[0]!.row,
      contentDocument: state
        ? {
            documentId: `doc-${state.toLowerCase()}`,
            workspaceId: null,
            externalId:
              state === DatabaseRowContentDocumentState.Available
                ? `doc-${state.toLowerCase()}`
                : null,
            state,
            title:
              state === DatabaseRowContentDocumentState.Available
                ? "Independent page title"
                : null,
          }
        : null,
      title: "Independent row title",
    },
  };
}

async function openListRow() {
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Independent row title: Open details",
    }),
  );
  return within(await screen.findByTestId("database-row-detail-peek"));
}

async function openPageContent(peek: ReturnType<typeof within>) {
  const control = peek.getByRole("button", { name: "Page content" });
  const panelId = control.getAttribute("aria-controls");
  fireEvent.click(control);
  await waitFor(() => {
    expect(control.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(panelId ?? "")?.hasAttribute("inert")).toBe(
      false,
    );
  });
  return within(peek.getByTestId("database-row-content"));
}

describe("Database Row Content", () => {
  test("opens an existing content document from the subordinate Page content section", async () => {
    const { onOpenDoc } = renderDatabaseViewHost({
      activeViewId: "view-list",
      layout: "page",
      record: p9gRecord,
      rows: [contentRow(DatabaseRowContentDocumentState.Available)],
    });
    const content = await openPageContent(await openListRow());
    fireEvent.click(content.getByRole("button", { name: "Open full page" }));
    expect(onOpenDoc).toHaveBeenCalledWith("doc-available");
  });

  test("creates server-confirmed content and refreshes the Row without fabricating an id", async () => {
    const created = contentRow(DatabaseRowContentDocumentState.Available);
    const gql = vi.fn(({ query }) =>
      query === createDatabaseRowContentDocumentMutation
        ? { createDatabaseRowContentDocument: created }
        : {},
    );
    const { onChanged, onOpenDoc } = renderDatabaseViewHost({
      activeViewId: "view-list",
      gql,
      layout: "page",
      record: p9gRecord,
      rows: [contentRow(null)],
    });
    const content = await openPageContent(await openListRow());
    fireEvent.click(
      content.getByRole("button", { name: "Create page content" }),
    );

    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(onOpenDoc).not.toHaveBeenCalled();
    expect(gql).toHaveBeenCalledWith(
      expect.objectContaining({
        query: createDatabaseRowContentDocumentMutation,
        variables: {
          input: {
            databaseId: "database-1",
            expectedEditRevision: 1,
            rowId: "row-1",
          },
        },
      }),
    );
  });

  test("loads Row activity from the final Sidecard section", async () => {
    const gql = vi.fn(({ query }) =>
      query === databaseRowActivityQuery
        ? {
            workspace: {
              databaseRowActivity: [
                {
                  actorDisplayName: "Alice",
                  actorUserId: "user-1",
                  createdAt: "2026-07-15T09:00:00.000Z",
                  databaseId: "database-1",
                  eventType: "row.status_changed",
                  id: "activity-1",
                  payload: {
                    value: "status.in_progress",
                    valueLabel: "In progress",
                  },
                  rowId: "row-1",
                  workspaceId: "workspace-1",
                },
              ],
            },
          }
        : {},
    );
    renderDatabaseViewHost({
      activeViewId: "view-list",
      gql,
      layout: "page",
      record: p9gRecord,
      rows: [contentRow(null)],
    });
    const peek = await openListRow();
    fireEvent.click(peek.getByRole("button", { name: "View activity" }));

    expect(
      await peek.findByTestId("database-row-activity-list"),
    ).not.toBeNull();
    expect(
      peek.getByTestId("database-row-activity-message").textContent,
    ).toContain("In progress");
    expect(
      peek.getByTestId("database-row-activity-message").textContent,
    ).not.toContain("status.in_progress");
    expect(screen.queryByTestId("database-row-activity-drawer")).toBeNull();
    expect(gql).toHaveBeenCalledWith(
      expect.objectContaining({
        query: databaseRowActivityQuery,
        variables: {
          rowId: "row-1",
          skip: 0,
          take: 50,
          workspaceId: "workspace-1",
        },
      }),
    );
  });

  test("keeps one independent Row title and offers both null-state actions", async () => {
    renderDatabaseViewHost({
      activeViewId: "view-list",
      record: p9gRecord,
      rows: [contentRow(null)],
    });

    const peek = await openListRow();
    const content = await openPageContent(peek);
    expect(peek.getAllByText("Independent row title")).toHaveLength(1);
    expect(
      content.getByRole("button", { name: "Create page content" }),
    ).not.toBeNull();
    expect(
      content.getByRole("button", { name: "Attach existing document" }),
    ).not.toBeNull();
    expect(peek.queryByText("Independent page title")).toBeNull();
  });

  test("prevents duplicate create and sends the active Row revision", async () => {
    let resolveCreate: ((value: unknown) => void) | undefined;
    const createPending = new Promise((resolve) => {
      resolveCreate = resolve;
    });
    const gql = vi.fn(({ query }) => {
      if (query === createDatabaseRowContentDocumentMutation) {
        return createPending;
      }
      return {};
    });
    renderDatabaseViewHost({
      activeViewId: "view-list",
      gql,
      record: p9gRecord,
      rows: [contentRow(null)],
    });

    const peek = await openListRow();
    const content = await openPageContent(peek);
    const create = content.getByRole("button", { name: "Create page content" });
    fireEvent.click(create);
    fireEvent.click(create);

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: createDatabaseRowContentDocumentMutation,
          variables: {
            input: {
              databaseId: "database-1",
              expectedEditRevision: 1,
              rowId: "row-1",
            },
          },
        }),
      ),
    );
    expect(
      gql.mock.calls.filter(
        ([request]) =>
          request.query === createDatabaseRowContentDocumentMutation,
      ),
    ).toHaveLength(1);
    expect(content.getByTestId("database-row-content-progress")).not.toBeNull();
    resolveCreate?.({ createDatabaseRowContentDocument: contentRow(null) });
  });

  test("attaches only a server-search result and preserves the Side Peek", async () => {
    const gql = vi.fn(({ query }) => {
      if (query === indexerSearchDocsQuery) {
        return {
          workspace: {
            searchDocs: [
              {
                docId: "9381181b-f8f2-4a3f-ad98-9fc918f8b654",
                externalId: "doc-existing",
                workspaceId: null,
                title: "Existing page",
              },
            ],
          },
        };
      }
      if (query === attachDatabaseRowContentDocumentMutation) {
        return { attachDatabaseRowContentDocument: contentRow(null) };
      }
      return {};
    });
    renderDatabaseViewHost({
      activeViewId: "view-list",
      gql,
      record: p9gRecord,
      rows: [contentRow(null)],
    });

    const peek = await openListRow();
    const content = await openPageContent(peek);
    fireEvent.click(
      content.getByRole("button", { name: "Attach existing document" }),
    );
    fireEvent.click(
      await screen.findByTestId("database-document-picker-select-doc-existing"),
    );

    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: attachDatabaseRowContentDocumentMutation,
          variables: {
            input: {
              databaseId: "database-1",
              documentId: "9381181b-f8f2-4a3f-ad98-9fc918f8b654",
              expectedEditRevision: 1,
              rowId: "row-1",
            },
          },
        }),
      ),
    );
    expect(screen.getByTestId("database-row-detail-content")).not.toBeNull();
  });

  test("embeds available content and routes open/detach through Side Peek", async () => {
    const gql = vi.fn(({ query }) =>
      query === detachDatabaseRowContentDocumentMutation
        ? { detachDatabaseRowContentDocument: contentRow(null) }
        : {},
    );
    const { onOpenDoc } = renderDatabaseViewHost({
      activeViewId: "view-list",
      gql,
      record: p9gRecord,
      rows: [contentRow(DatabaseRowContentDocumentState.Available)],
    });

    const peek = await openListRow();
    const content = await openPageContent(peek);
    expect(content.getByTestId("database-row-content-editor").textContent).toBe(
      "doc-available",
    );
    fireEvent.click(content.getByRole("button", { name: "Open full page" }));
    expect(onOpenDoc).toHaveBeenCalledWith("doc-available");
    fireEvent.click(content.getByRole("button", { name: "Detach" }));
    await waitFor(() =>
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: detachDatabaseRowContentDocumentMutation,
          variables: expect.objectContaining({
            input: expect.objectContaining({
              expectedEditRevision: 1,
              rowId: "row-1",
            }),
          }),
        }),
      ),
    );
  });

  test.each([
    [DatabaseRowContentDocumentState.Deleted, "database-row-content-deleted"],
    [DatabaseRowContentDocumentState.Missing, "database-row-content-missing"],
    [DatabaseRowContentDocumentState.Redacted, "database-row-content-redacted"],
  ])("renders %s without an editor or open action", async (state, testId) => {
    renderDatabaseViewHost({
      activeViewId: "view-list",
      record: p9gRecord,
      rows: [contentRow(state)],
    });

    const peek = await openListRow();
    const content = await openPageContent(peek);
    expect(content.getByTestId(testId)).not.toBeNull();
    expect(content.queryByTestId("database-row-content-editor")).toBeNull();
    expect(
      content.queryByRole("button", { name: "Open full page" }),
    ).toBeNull();
    expect(content.queryByText("Independent page title")).toBeNull();
    const detach = content.queryByRole("button", { name: "Detach" });
    if (state === DatabaseRowContentDocumentState.Redacted) {
      expect(detach).toBeNull();
    } else {
      expect(detach).not.toBeNull();
    }
  });
});
