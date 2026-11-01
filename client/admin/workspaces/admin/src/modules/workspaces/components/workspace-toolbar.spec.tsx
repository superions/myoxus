// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import { AdminWorkspaceSort } from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspaceToolbar } from "./workspace-toolbar";
import { selectMantineOption } from "../../../__tests__/test-utils";

vi.mock("../../common", () => ({
  useServerConfig: () => ({ availableWorkspaceFeatures: [] }),
}));
vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

function props() {
  return {
    keyword: "",
    onKeywordChange: vi.fn(),
    selectedFeatures: [],
    onFeaturesChange: vi.fn(),
    flags: {},
    onFlagsChange: vi.fn(),
    typeFilter: "all" as const,
    onTypeFilterChange: vi.fn(),
    gitSyncFilter: "all" as const,
    onGitSyncFilterChange: vi.fn(),
    sort: AdminWorkspaceSort.CreatedAt,
    onSortChange: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("workspace inventory toolbar", () => {
  test("opens labelled secondary filters and preserves false flag values", async () => {
    const input = { ...props(), flags: { public: false } };
    render(
      <MyoxusUIProvider>
        <WorkspaceToolbar {...input} />
      </MyoxusUIProvider>,
    );
    expect(screen.queryByTestId("workspace-filters-popover")).toBeNull();
    fireEvent.click(screen.getByTestId("workspace-filters-trigger"));
    const publicFilter = await screen.findByLabelText(
      "admin.workspaces.flags.public-filter",
      { selector: "input" },
    );
    expect(publicFilter.getAttribute("role")).toBe("combobox");
    expect((publicFilter as HTMLInputElement).value).toBe(
      "admin.workspaces.toolbar.flag-off",
    );
    selectMantineOption(publicFilter, "admin.workspaces.toolbar.flag-any");
    expect(input.onFlagsChange).toHaveBeenCalledWith({ public: undefined });
    expect(
      screen.getByTestId("workspace-filters-trigger").textContent,
    ).toContain("1");
  });

  test("resets every filter and cancels a pending search debounce without resetting sort", () => {
    vi.useFakeTimers();
    const input = {
      ...props(),
      flags: { public: false },
      gitSyncFilter: "failed" as const,
    };
    render(
      <MyoxusUIProvider>
        <WorkspaceToolbar {...input} />
      </MyoxusUIProvider>,
    );
    fireEvent.change(screen.getByTestId("workspace-search-input"), {
      target: { value: "pending search" },
    });
    fireEvent.click(screen.getByTestId("workspace-filters-reset"));
    vi.advanceTimersByTime(500);
    expect(
      (screen.getByTestId("workspace-search-input") as HTMLInputElement).value,
    ).toBe("");
    expect(input.onKeywordChange).toHaveBeenLastCalledWith("");
    expect(input.onKeywordChange).not.toHaveBeenCalledWith("pending search");
    expect(input.onFeaturesChange).toHaveBeenCalledWith([]);
    expect(input.onFlagsChange).toHaveBeenCalledWith({});
    expect(input.onTypeFilterChange).toHaveBeenCalledWith("all");
    expect(input.onGitSyncFilterChange).toHaveBeenCalledWith("all");
    expect(input.onSortChange).not.toHaveBeenCalled();
  });
});
