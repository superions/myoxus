// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import {
  type DatabaseSummaryFragment,
  DatabaseProfileKind,
} from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } =
    await import("../../../../modules/database/test-i18n-mock");
  return createDatabaseTestI18nModule();
});

import {
  DatabaseInventory,
  type DatabaseInventorySortValue,
} from "./inventory";
import {
  type DatabaseInventoryScope,
  DatabaseInventoryScopeSwitcher,
} from "./inventory-scope-switcher";

afterEach(cleanup);

function databaseSummary(
  id: string,
  title: string,
  profileKind: DatabaseProfileKind,
): DatabaseSummaryFragment {
  return {
    createdAt: "2026-01-01T12:00:00.000Z",
    deletedAt: null,
    description: `${title} overview`,
    editRevision: 2,
    fieldCount: 2,
    id,
    profileKind,
    systemRole: null,
    profileStructurePreset: null,
    rowCount: 7,
    title,
    updatedAt: "2026-01-02T12:00:00.000Z",
    viewCount: 1,
    workspaceId: "workspace-1",
  };
}

function renderInventory({
  canGoNext = true,
  favoriteIds = new Set(["project-1"]),
  isPristine = true,
  page = 0,
  records = [
    databaseSummary(
      "project-1",
      "Product roadmap",
      DatabaseProfileKind.Project,
    ),
    databaseSummary(
      "database-1",
      "Research index",
      DatabaseProfileKind.Generic,
    ),
  ],
  search = "",
  sort = "updated-desc",
}: {
  canGoNext?: boolean;
  favoriteIds?: ReadonlySet<string>;
  isPristine?: boolean;
  page?: number;
  records?: readonly DatabaseSummaryFragment[];
  search?: string;
  sort?: DatabaseInventorySortValue;
} = {}) {
  const callbacks = {
    onOpen: vi.fn(),
    onPageChange: vi.fn(),
    onSearchChange: vi.fn(),
    onSortChange: vi.fn(),
    onToggleFavorite: vi.fn(),
  };
  render(
    <MyoxusUIProvider>
      <DatabaseInventory
        canGoNext={canGoNext}
        emptyCta={<button type="button">Create database</button>}
        favoriteIds={favoriteIds}
        isPristine={isPristine}
        page={page}
        records={records}
        search={search}
        sort={sort}
        {...callbacks}
      />
    </MyoxusUIProvider>,
  );
  return callbacks;
}

describe("DatabaseInventory", () => {
  test("keeps the inventory scope in the compact header switcher", () => {
    const onChange = vi.fn();
    render(
      <MyoxusUIProvider>
        <DatabaseInventoryScopeSwitcher value="all" onChange={onChange} />
      </MyoxusUIProvider>,
    );

    const scope = screen.getByTestId("database-inventory-scope");
    fireEvent.click(within(scope).getByRole("radio", { name: "Project" }));
    expect(onChange).toHaveBeenLastCalledWith(
      "project" satisfies DatabaseInventoryScope,
    );
  });

  test("renders typed Database and Project cards with localized metadata", () => {
    renderInventory();

    const rows = screen.getAllByTestId("database-list-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Project").textContent).toBe("Project");
    expect(within(rows[1]).getByText("Database").textContent).toBe("Database");
    expect(
      within(rows[0]).getByText("Fields 2 · Rows 7 · Views 1").textContent,
    ).toBe("Fields 2 · Rows 7 · Views 1");
    const localizedDate = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
    }).format(new Date("2026-01-02T12:00:00.000Z"));
    expect(
      within(rows[0]).getByText(`Updated ${localizedDate}`).textContent,
    ).toBe(`Updated ${localizedDate}`);
    expect(rows[0].dataset.myoxusUiRole).toBe("surface-list-item");
  });

  test("exposes search, favorite and sort intent without local filtering", () => {
    const callbacks = renderInventory();

    fireEvent.change(screen.getByLabelText("Search databases"), {
      target: { value: "roadmap" },
    });
    expect(callbacks.onSearchChange).toHaveBeenLastCalledWith("roadmap");

    fireEvent.click(screen.getByRole("combobox", { name: "Sort" }));
    fireEvent.click(screen.getByRole("option", { name: "Title A–Z" }));
    expect(callbacks.onSortChange).toHaveBeenLastCalledWith("title-asc");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove from favourites" }),
    );
    expect(callbacks.onToggleFavorite).toHaveBeenLastCalledWith("project-1");
    fireEvent.click(screen.getByTestId("database-open-project-1"));
    expect(callbacks.onOpen).toHaveBeenLastCalledWith("project-1");
  });

  test("keeps pristine, no-result and paginated states independently actionable", () => {
    const pristine = renderInventory({ records: [], canGoNext: false });
    expect(
      screen.getByTestId("database-inventory-empty").dataset.myoxusUiRole,
    ).toBe("empty-state");
    expect(
      screen.getByRole("button", { name: "Create database" }).textContent,
    ).toBe("Create database");
    expect(pristine.onPageChange).not.toHaveBeenCalled();

    cleanup();
    renderInventory({
      records: [],
      isPristine: false,
      search: "missing",
      canGoNext: false,
    });
    expect(
      screen.getByTestId("database-inventory-no-results").dataset.myoxusUiRole,
    ).toBe("empty-state");
    expect(
      screen.queryByRole("button", { name: "Create database" }),
    ).toBeNull();

    cleanup();
    const paginated = renderInventory({ page: 1, canGoNext: false });
    expect(screen.getByText("Page 2").textContent).toBe("Page 2");
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(paginated.onPageChange).toHaveBeenLastCalledWith(0);
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
