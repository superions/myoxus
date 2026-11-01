/**
 * @vitest-environment happy-dom
 */
import { useMyoxusTheme } from "@myoxus/ui-facade/provider";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ThemeProvider } from "./theme-provider";

function ThemeSetter({ theme }: { theme: "light" | "dark" | "system" }) {
  const { setTheme } = useMyoxusTheme();

  useEffect(() => {
    setTheme(theme);
  }, [setTheme, theme]);

  return null;
}

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
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

function resetThemeDomState() {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
}

function clearStorageSafely() {
  const storage = globalThis.localStorage as { clear?: () => void } | undefined;
  if (storage && typeof storage.clear === "function") {
    storage.clear();
  }
}

describe("Admin ThemeProvider switch behavior", () => {
  beforeEach(() => {
    clearStorageSafely();
    mockMatchMedia(false);
    resetThemeDomState();
  });

  afterEach(() => {
    cleanup();
    clearStorageSafely();
    resetThemeDomState();
  });

  test('applies dark mode when setTheme("dark") is called', async () => {
    render(
      <ThemeProvider>
        <ThemeSetter theme="dark" />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.style.colorScheme).toBe("dark");
    });
  });

  test('applies light mode when setTheme("light") is called', async () => {
    render(
      <ThemeProvider>
        <ThemeSetter theme="light" />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.style.colorScheme).toBe("light");
    });
  });

  test("uses system preference by default (dark OS => dark theme)", async () => {
    mockMatchMedia(true);

    render(
      <ThemeProvider>
        <div>content</div>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.style.colorScheme).toBe("dark");
    });
  });
});
