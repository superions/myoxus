// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { describe, expect, test, vi } from "vitest";

import {
  resolveTagCatalogViewState,
  selectTagCatalogRows,
  stopTagCatalogRowAction,
  type TagCatalogRow,
} from "./catalog-page";

const rows: TagCatalogRow[] = [
  {
    id: "tag-c",
    name: "Review",
    description: "Database readiness",
    color: "tag.blue",
    archived: false,
    updatedAt: 30,
    documentCount: 1,
    databaseRowCount: 4,
  },
  {
    id: "tag-a",
    name: "Architecture",
    description: "System design",
    color: "tag.green",
    archived: false,
    updatedAt: 10,
    documentCount: 2,
    databaseRowCount: 0,
  },
  {
    id: "tag-b",
    name: "Done",
    description: "Released work",
    color: "tag.grey",
    archived: true,
    updatedAt: 20,
    documentCount: 1,
    databaseRowCount: 0,
  },
];

describe("TagCatalogPage contract", () => {
  test("searches name and description, filters lifecycle and sorts with stable ids", () => {
    expect(selectTagCatalogRows(rows, "SYSTEM", "active", "name-asc")).toEqual([
      rows[1],
    ]);
    expect(
      selectTagCatalogRows(rows, "released", "archived", "name-asc"),
    ).toEqual([rows[2]]);
    expect(
      selectTagCatalogRows(rows, "", "all", "usage-desc").map((row) => row.id),
    ).toEqual(["tag-c", "tag-a", "tag-b"]);

    const tied = rows.map((row) => ({
      ...row,
      name: "Same",
      documentCount: 0,
      databaseRowCount: 0,
    }));
    expect(
      selectTagCatalogRows(tied, "", "all", "usage-desc").map((row) => row.id),
    ).toEqual(["tag-a", "tag-b", "tag-c"]);
  });

  test("keeps loading, error, empty and filtered-empty states distinct", () => {
    expect(
      resolveTagCatalogViewState({
        error: null,
        isLoading: true,
        totalCount: 0,
        visibleCount: 0,
      }),
    ).toEqual({ body: "loading", showError: false });
    expect(
      resolveTagCatalogViewState({
        error: new Error("offline"),
        isLoading: false,
        totalCount: 3,
        visibleCount: 3,
      }),
    ).toEqual({ body: "rows", showError: true });
    expect(
      resolveTagCatalogViewState({
        error: null,
        isLoading: false,
        totalCount: 0,
        visibleCount: 0,
      }).body,
    ).toBe("empty");
    expect(
      resolveTagCatalogViewState({
        error: null,
        isLoading: false,
        totalCount: 3,
        visibleCount: 0,
      }).body,
    ).toBe("no-results");
  });

  test("prevents a row-owned menu action from opening the backing tag link", () => {
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    stopTagCatalogRowAction(event as never);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
});
