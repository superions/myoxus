/** @vitest-environment happy-dom */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ADMIN_THEME_STORAGE_KEY, ThemeProvider } from "../theme-provider";

function mockMatchMedia(matchesDark: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: matchesDark,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function resetThemeDom() {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
}

describe("Admin ThemeProvider device storage bridge", () => {
  beforeEach(() => {
    // Node 26 exposes localStorage; use the browser environment's isolated storage.
    vi.stubGlobal("localStorage", new Storage());
    window.localStorage.clear();
    mockMatchMedia(false);
    resetThemeDom();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    resetThemeDom();
    vi.unstubAllGlobals();
  });

  test('reads seeded "light" from shared localStorage key on mount', async () => {
    window.localStorage.setItem(ADMIN_THEME_STORAGE_KEY, "light");

    render(
      <ThemeProvider>
        <div>content</div>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("light");
    });
  });

  test("storage event from another tab flips data-theme", async () => {
    window.localStorage.setItem(ADMIN_THEME_STORAGE_KEY, "dark");

    render(
      <ThemeProvider>
        <div>content</div>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
    });

    // Simulate a foreign tab (e.g. the web frontend) writing the shared key.
    // In real browsers `storage` events do NOT fire in the writing tab —
    // here we fabricate the event the way another tab would deliver it.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: ADMIN_THEME_STORAGE_KEY,
        newValue: "light",
        oldValue: "dark",
        storageArea: window.localStorage,
      }),
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("light");
    });
  });

  test("storage event for an unrelated key does not flip data-theme", async () => {
    window.localStorage.setItem(ADMIN_THEME_STORAGE_KEY, "dark");

    render(
      <ThemeProvider>
        <div>content</div>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
    });

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "some-other-key",
        newValue: "light",
        oldValue: "dark",
        storageArea: window.localStorage,
      }),
    );

    // Give the storage bridge a tick; unrelated keys must not change the mode.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
