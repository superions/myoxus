import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { getOrCreateI18n } from "@myoxus/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockQueryState: {
  entries: any[];
  totalCount: number;
  error?: Error;
  isLoading: boolean;
} = {
  entries: [],
  totalCount: 0,
  isLoading: false,
};
const catalogRequest = vi.hoisted(() => vi.fn());
const catalogMutate = vi.hoisted(() => vi.fn());
const sourceMutate = vi.hoisted(() => vi.fn());
const sourceQueryState: { error?: Error } = {};

vi.mock("./api", () => ({
  archiveTemplate: vi.fn(),
  disableTemplate: vi.fn(),
  enableTemplate: vi.fn(),
  useTemplateCatalogQuery: (variables: unknown) => {
    catalogRequest(variables);
    return {
      ...mockQueryState,
      mutate: catalogMutate,
    };
  },
  useTemplateRegistryRevalidate: () => ({
    revalidateCatalog: vi.fn(),
  }),
  useWorkspaceTemplateSourcesQuery: (workspaceId: string) => ({
    sources: [
      {
        // Native external keys are scoped to a workspace and may be equal.
        docId: "shared-source-key",
        title: workspaceId === "alpha" ? "Alpha source" : "Beta source",
        documentRevision: 7,
        metadataRevision: 2,
        category: null,
      },
    ],
    nextOffset: null,
    data: {},
    error: sourceQueryState.error,
    isLoading: false,
    isValidating: false,
    mutate: sourceMutate,
  }),
}));

vi.mock("../../components/domain-pickers", () => ({
  WorkspacePicker: ({
    value,
    onChange,
    label,
  }: {
    value: string | null;
    onChange: (value: string | null) => void;
    label: string;
  }) => (
    <input
      aria-label={label}
      value={value ?? ""}
      onChange={(event) => onChange(event.currentTarget.value || null)}
    />
  ),
}));

import { CatalogTab } from "./catalog-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider env="test">{ui}</MyoxusUIProvider>);
}

describe("CatalogTab", () => {
  beforeEach(() => {
    // This file's legacy t(key) fixture also serves the Facade Modal's
    // generated close method; keep the real translated value for both APIs.
    const { t } = getOrCreateI18n();
    Object.assign(t, {
      "com.myoxus.peek-view-controls.close": () =>
        t("com.myoxus.peek-view-controls.close"),
    });
    catalogRequest.mockClear();
    catalogMutate.mockClear();
    sourceMutate.mockClear();
    sourceQueryState.error = undefined;
    mockQueryState.error = undefined;
    mockQueryState.isLoading = false;
    mockQueryState.entries = [
      {
        id: "tpl-1",
        slug: "weekly-standup",
        title: "Weekly Standup",
        category: "work",
        status: "Active",
        source: "Bundle",
        tags: ["team"],
      },
    ];
    mockQueryState.totalCount = 1;
  });

  afterEach(() => {
    cleanup();
  });

  test("clears workspace-local source selections on workspace changes and lost access", async () => {
    const user = userEvent.setup();
    const view = renderWithFacade(<CatalogTab />);
    await user.click(
      screen.getByRole("button", { name: "Export from workspace…" }),
    );
    const workspace = screen.getByRole("textbox", { name: "Workspace" });
    fireEvent.change(workspace, { target: { value: "alpha" } });
    await user.click(screen.getByRole("button", { name: "Alpha source" }));
    expect(
      screen
        .getByRole("button", { name: "Alpha source" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.change(workspace, { target: { value: "beta" } });
    expect(screen.queryByRole("button", { name: "Alpha source" })).toBeNull();
    const beta = screen.getByRole("button", { name: "Beta source" });
    expect(beta.getAttribute("aria-pressed")).toBe("false");
    await user.click(beta);
    sourceQueryState.error = new Error("Access denied");
    view.rerender(
      <MyoxusUIProvider env="test">
        <CatalogTab />
      </MyoxusUIProvider>,
    );
    expect(screen.queryByRole("button", { name: "Beta source" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(sourceMutate).toHaveBeenCalledWith(undefined, {
      throwOnError: false,
    });
    sourceQueryState.error = undefined;
    view.rerender(
      <MyoxusUIProvider env="test">
        <CatalogTab />
      </MyoxusUIProvider>,
    );
    expect(
      screen
        .getByRole("button", { name: "Beta source" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  test("hides builtin raw slugs from the localized catalog table", () => {
    mockQueryState.entries = [
      {
        id: "tpl-builtin",
        slug: "business-daily",
        title: "Business Daily",
        description: "Daily business planning with priorities and follow-ups",
        category: "journal-daily",
        status: "Active",
        source: "Builtin",
        tags: ["daily", "planning", "business"],
      },
    ];
    mockQueryState.totalCount = 1;

    const { container } = renderWithFacade(<CatalogTab />);

    const list = container.querySelector(
      '[data-testid="templates-catalog-table"]',
    );
    expect(list?.textContent).toContain("Daily Plan");
    expect(list?.textContent).toContain(
      "Plan the day before the day plans you.",
    );
    expect(list?.textContent).not.toContain("business-daily");
    expect(list?.textContent).not.toContain("Business Daily");
  });

  test("combines native source and category filters and resets an empty result", async () => {
    const user = userEvent.setup();
    mockQueryState.entries.push({
      id: "tpl-2",
      slug: "notes",
      title: "Notes",
      category: "notes",
      status: "Active",
      source: "Builtin",
      tags: [],
    });
    mockQueryState.totalCount = 2;
    renderWithFacade(<CatalogTab />);

    await user.click(
      screen.getByRole("combobox", { name: "Filter templates" }),
    );
    await user.click(await screen.findByRole("option", { name: "Built-in" }));
    expect(screen.getByTestId("templates-catalog-table").textContent).toContain(
      "Notes",
    );
    expect(
      screen.getByTestId("templates-catalog-table").textContent,
    ).not.toContain("Weekly Standup");

    await user.click(screen.getByRole("combobox", { name: "Category" }));
    await user.click(await screen.findByRole("option", { name: /^work$/ }));
    expect(screen.queryByTestId("templates-catalog-table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByTestId("templates-catalog-table").textContent).toContain(
      "Weekly Standup",
    );
    expect(screen.getByTestId("templates-catalog-table").textContent).toContain(
      "Notes",
    );
    expect(
      (screen.getByRole("combobox", { name: "Category" }) as HTMLInputElement)
        .value,
    ).toBe("All Categories");
  });

  test("searches tags and resets an unmatched search", () => {
    renderWithFacade(<CatalogTab />);
    const search = screen.getByRole("textbox", { name: "Search this page" });
    fireEvent.change(search, { target: { value: "team" } });
    expect(
      screen.getByRole("button", { name: "Weekly Standup" }).textContent,
    ).toBe("Weekly Standup");
    fireEvent.change(search, { target: { value: "unmatched" } });
    expect(screen.queryByTestId("templates-catalog-table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect((search as HTMLInputElement).value).toBe("");
    expect(
      screen.getByRole("button", { name: "Weekly Standup" }).textContent,
    ).toBe("Weekly Standup");
  });

  test("requests the next bounded catalog page and clears page-local search", () => {
    mockQueryState.totalCount = 51;
    renderWithFacade(<CatalogTab />);
    const search = screen.getByRole("textbox", { name: "Search this page" });
    fireEvent.change(search, { target: { value: "team" } });
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(catalogRequest).toHaveBeenLastCalledWith({ skip: 50, take: 50 });
    expect((search as HTMLInputElement).value).toBe("");
  });
});
