/**
 * @vitest-environment happy-dom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { QuickSearchItem } from "../types/item";
import { CMDK } from "./cmdk";
import { QuickSearchModal } from "./modal";

vi.mock("@myoxus/i18n", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    i18nTime: () => "timestamp",
    useI18n: () => ({
      "com.myoxus.cmdk.no-results": () => "com.myoxus.cmdk.no-results",
      "com.myoxus.common.operation-failed": () =>
        "com.myoxus.common.operation-failed",
      "com.myoxus.error.retry": () => "com.myoxus.error.retry",
      "com.myoxus.loading": () => "com.myoxus.loading",
      "com.myoxus.search.results.open": () => "Open search results",
      t: (value: unknown) => {
        if (typeof value === "object" && value !== null && "i18nKey" in value) {
          return String((value as { i18nKey: string }).i18nKey);
        }
        return String(value);
      },
    }),
  };
});

const items: QuickSearchItem[] = [
  { id: "alpha", source: "test", label: "Alpha" },
  { id: "disabled", source: "test", label: "Disabled", disabled: true },
  { id: "gamma", source: "test", label: "Gamma", keyBinding: "$mod+KeyK" },
];

function renderQuickSearch(ui: ReactNode) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("CMDK quicksearch listbox", () => {
  test("offers the optional page action outside the empty listbox without intercepting native button Enter", () => {
    const openPage = vi.fn();
    const submit = vi.fn();
    const { unmount } = renderQuickSearch(
      <CMDK query="missing needle" onOpenPage={openPage} onSubmit={submit} />,
    );
    const button = screen.getByRole("button", { name: "Open search results" });
    expect(screen.getByRole("listbox").contains(button)).toBe(false);
    expect(fireEvent.keyDown(button, { key: "Enter" })).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(openPage).toHaveBeenCalledExactlyOnceWith("missing needle");
    unmount();
    renderQuickSearch(<CMDK query="missing needle" />);
    expect(
      screen.queryByRole("button", { name: "Open search results" }),
    ).toBeNull();
  });
  beforeEach(() => {
    (globalThis as any).environment = { isMacOs: false };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("keeps keyboard selection and submit behavior without the cmdk package", () => {
    const onSubmit = vi.fn();
    const consoleError = vi.spyOn(console, "error");
    const highlightedItems = items.map((item) =>
      item.id === "alpha" ? { ...item, label: "<b>Alpha</b>" } : item,
    );
    renderQuickSearch(
      <CMDK
        query=""
        placeholder="Search commands"
        groups={[
          {
            group: { id: "docs", label: "Documents" },
            items: highlightedItems,
          },
        ]}
        onSubmit={onSubmit}
      />,
    );

    const root = screen.getByTestId("cmdk-quick-search");
    expect(
      screen
        .getByRole("option", { name: /Alpha/ })
        .getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(
      screen
        .getByRole("option", { name: /Gamma/ })
        .getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.keyDown(root, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gamma" }),
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("resets to the first enabled item on query changes and ignores disabled hover", () => {
    const onSubmit = vi.fn();
    const onQueryChange = vi.fn();
    renderQuickSearch(
      <CMDK
        query=""
        placeholder="Search commands"
        groups={[{ group: { id: "docs", label: "Documents" }, items }]}
        onSubmit={onSubmit}
        onQueryChange={onQueryChange}
      />,
    );

    const root = screen.getByTestId("cmdk-quick-search");
    fireEvent.keyDown(root, { key: "End" });
    expect(
      screen
        .getByRole("option", { name: /Gamma/ })
        .getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.change(screen.getByPlaceholderText("Search commands"), {
      target: { value: "alp" },
    });
    expect(onQueryChange).toHaveBeenCalledWith("alp");
    expect(
      screen
        .getByRole("option", { name: /Alpha/ })
        .getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.mouseEnter(screen.getByRole("option", { name: /Disabled/ }));
    expect(
      screen
        .getByRole("option", { name: /Alpha/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("keeps successful groups actionable while an independent source fails", () => {
    const onRetry = vi.fn();
    const onSubmit = vi.fn();
    renderQuickSearch(
      <CMDK
        query="roadmap"
        placeholder="Search commands"
        groups={[
          {
            group: { id: "docs", label: "Documents", score: 20 },
            items: [items[0]],
          },
          {
            group: { id: "databases", label: "Databases", score: 18 },
            items: [],
            state: {
              error: new Error("sensitive transport detail"),
              group: { id: "databases", label: "Databases", score: 18 },
              loading: false,
              retry: onRetry,
            },
          },
        ]}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole("option", { name: /Alpha/ })).toBeTruthy();
    expect(screen.queryByText("sensitive transport detail")).toBeNull();
    expect(screen.getByText("com.myoxus.common.operation-failed")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "com.myoxus.error.retry" }),
    );
    expect(onRetry).toHaveBeenCalledOnce();

    fireEvent.keyDown(screen.getByTestId("cmdk-quick-search"), {
      key: "Enter",
    });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(items[0]);
  });

  test("waits for a search result instead of defaulting to creation", () => {
    const onSubmit = vi.fn();
    const creation = {
      id: "creation:create-page",
      source: "creation",
      label: 'Create "roadmap"',
    };
    const docs = { id: "docs", label: "Documents" };
    const search = (ready: boolean) => (
      <MyoxusUIProvider>
        <CMDK
          query="roadmap"
          placeholder="Search commands"
          loading={!ready}
          groups={[
            {
              group: docs,
              items: ready ? [items[0]] : [],
              state: ready
                ? undefined
                : { group: docs, loading: true, error: null },
            },
            { group: { id: "creation", label: "Create" }, items: [creation] },
          ]}
          onSubmit={onSubmit}
        />
      </MyoxusUIProvider>
    );
    const view = render(search(false));
    const root = screen.getByTestId("cmdk-quick-search");
    expect(
      screen
        .getByRole("option", { name: /Create/ })
        .getAttribute("aria-selected"),
    ).toBe("false");
    fireEvent.keyDown(root, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();

    view.rerender(search(true));
    fireEvent.keyDown(root, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(items[0]);

    fireEvent.keyDown(root, { key: "End" });
    fireEvent.keyDown(root, { key: "Enter" });
    expect(onSubmit).toHaveBeenLastCalledWith(creation);
  });

  test("announces a localized empty result after all sources settle", () => {
    renderQuickSearch(
      <CMDK query="missing" placeholder="Search commands" groups={[]} />,
    );

    expect(screen.getByText("com.myoxus.cmdk.no-results")).toBeTruthy();
  });
});

describe("QuickSearchModal dismissal", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("closes through the Mantine overlay without swallowing inside clicks", () => {
    const onOpenChange = vi.fn();
    renderQuickSearch(
      <QuickSearchModal open onOpenChange={onOpenChange}>
        <button type="button">Inside action</button>
      </QuickSearchModal>,
    );

    fireEvent.mouseDown(screen.getByRole("button", { name: "Inside action" }));
    expect(onOpenChange).not.toHaveBeenCalled();

    const overlay = document.querySelector(
      '[data-myoxus-ui-role="command-palette-overlay"]',
    );
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("closes on Escape through the document listener", () => {
    const onOpenChange = vi.fn();
    renderQuickSearch(
      <QuickSearchModal open onOpenChange={onOpenChange}>
        <div>Search</div>
      </QuickSearchModal>,
    );

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
