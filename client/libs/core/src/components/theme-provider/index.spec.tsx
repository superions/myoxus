/**
 * @vitest-environment happy-dom
 */
import { useMyoxusTheme } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const themeNextMock = vi.fn();
const preferenceState = vi.hoisted(() => ({
  colorMode: undefined as "dark" | "light" | "system" | undefined,
}));

vi.mock("@myoxus/core/components/hooks/myoxus/use-user-preferences", () => ({
  useUserPreferences: () => ({
    preferences: preferenceState.colorMode
      ? { effectiveValues: { colorMode: preferenceState.colorMode } }
      : undefined,
  }),
}));

vi.mock("@myoxus/core/modules/theme", () => ({
  AppThemeService: class {},
}));

vi.mock("@myoxus/infra", () => ({
  useService: () => ({
    appTheme: {
      theme$: {
        next: themeNextMock,
      },
    },
  }),
}));

import { ThemeProvider } from "./index";

function ThemeProbe() {
  const { resolvedTheme, setTheme, theme } = useMyoxusTheme();
  return (
    <button type="button" onClick={() => setTheme("dark")}>
      {theme}:{resolvedTheme}
    </button>
  );
}

describe("Core ThemeProvider", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    // Vitest retains Node 26's file-backed localStorage getter, and window is
    // the same global object. Use Happy DOM's browser storage for this fixture.
    vi.stubGlobal("localStorage", new window.Storage());
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
    themeNextMock.mockClear();
    preferenceState.colorMode = undefined;
  });

  test("applies the server-projected account color mode", async () => {
    preferenceState.colorMode = "dark";

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(themeNextMock).toHaveBeenCalledWith("dark");
    });
  });

  test("syncs resolved theme changes to AppThemeService", async () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(themeNextMock).toHaveBeenCalledWith("light");
    });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(window.localStorage.length).toBe(0);
      expect(themeNextMock).toHaveBeenCalledWith("dark");
    });
  });
});
