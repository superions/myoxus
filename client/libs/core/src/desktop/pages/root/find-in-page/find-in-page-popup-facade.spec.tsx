// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const canvasContext = vi.hoisted(() => ({
  clearRect: vi.fn(),
  fillText: vi.fn(),
  scale: vi.fn(),
}));

const findInPage = vi.hoisted(() => ({
  backward: vi.fn(),
  clear: vi.fn(),
  findInPage: vi.fn(),
  forward: vi.fn(),
  isSearching$: {
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    value: false,
  },
  onChangeVisible: vi.fn(),
  result$: {
    value: {
      activeMatchOrdinal: 2,
      matches: 5,
    },
  },
  searchText$: {
    value: "alpha",
  },
  visible$: {
    value: true,
  },
}));

vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useLiveData: (source: { value: unknown }) => source.value,
  useService: () => ({ findInPage }),
}));

import { FindInPagePopup } from "./find-in-page-popup";

class ResizeObserverMock {
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();
}

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

function renderPopup() {
  return renderWithProvider(<FindInPagePopup />);
}

describe("FindInPagePopup facade migration", () => {
  beforeEach(() => {
    findInPage.visible$.value = true;
    findInPage.result$.value = {
      activeMatchOrdinal: 2,
      matches: 5,
    };
    findInPage.searchText$.value = "alpha";
    findInPage.isSearching$.value = false;
    findInPage.backward.mockReset();
    findInPage.clear.mockReset();
    findInPage.findInPage.mockReset();
    findInPage.forward.mockReset();
    findInPage.onChangeVisible.mockReset();
    findInPage.isSearching$.subscribe.mockClear();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      canvasContext as unknown as CanvasRenderingContext2D,
    );
    canvasContext.clearRect.mockReset();
    canvasContext.fillText.mockReset();
    canvasContext.scale.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("renders the popup through facade roles and keeps search controls functional", () => {
    renderPopup();

    expect(
      document.querySelector('[data-myoxus-ui-role="find-in-page-anchor"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-myoxus-ui-role="find-in-page-panel"]'),
    ).toBeTruthy();
    expect(
      document
        .querySelector('[data-myoxus-ui-role="find-in-page-search-box"]')
        ?.getAttribute("data-active"),
    ).toBe("true");
    expect(
      document.querySelector('[data-myoxus-ui-role="find-in-page-count"]')
        ?.textContent,
    ).toBe("2/5");
    expect(
      (
        screen.getByRole("textbox", {
          name: "Find in page",
        }) as HTMLInputElement
      ).value,
    ).toBe("alpha");
    expect(canvasContext.fillText).toHaveBeenCalledWith(
      "alpha",
      expect.any(Number),
      expect.any(Number),
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Find in page" }), {
      target: { value: "beta" },
    });
    expect(findInPage.findInPage).toHaveBeenCalledWith("beta");

    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(findInPage.backward).toHaveBeenCalledTimes(1);
    expect(findInPage.forward).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close find in page" }));
    expect(findInPage.clear).toHaveBeenCalledTimes(1);
    expect(findInPage.onChangeVisible).toHaveBeenCalledWith(false);
  });

  test("renders the empty-result state without reintroducing local popup chrome", () => {
    findInPage.result$.value = {
      activeMatchOrdinal: 0,
      matches: 0,
    };
    findInPage.searchText$.value = "missing";

    renderPopup();

    expect(screen.getByText("No matches")).toBeTruthy();

    const repoRoot = process.cwd();
    const sourcePath =
      "client/libs/core/src/desktop/pages/root/find-in-page/find-in-page-popup.tsx";
    const source = readFileSync(join(repoRoot, sourcePath), "utf8");

    for (const deletedPath of [
      "client/libs/core/src/desktop/pages/root/find-in-page/find-in-page-popup.css",
      "client/libs/core/src/desktop/pages/root/find-in-page/find-in-page-popup.styles.ts",
    ]) {
      expect(existsSync(join(repoRoot, deletedPath)), deletedPath).toBe(false);
    }

    expect(source).toContain("FindInPagePanel");
    expect(source).toContain("FindInPageTextInput");
    expect(source).toContain("FindInPageCanvasText");
    expect(source).not.toContain("classNames");
    expect(source).not.toContain("find-in-page-popup.styles");
    expect(source).not.toContain("style={{");
    expect(source).not.toContain("15px Inter");
    expect(source).not.toContain("--myoxus-text-primary-color");
    expect(source).toContain("getComputedStyle(canvas)");
  });
});
