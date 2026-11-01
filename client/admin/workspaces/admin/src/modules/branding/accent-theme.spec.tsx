/** @vitest-environment happy-dom */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const useQueryMock = vi.fn();
const useThemeMock = vi.fn();
const setThemeMock = vi.fn();

vi.mock("../../use-query", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("@myoxus/ui-facade/provider", () => ({
  useMyoxusTheme: () => useThemeMock(),
}));

import { BrandingAccentThemeSync } from "./accent-theme";

function profileResponse(themeMode: string | null = "system") {
  return {
    data: {
      admin: {
        effectiveThemeProfile: {
          scope: "global",
          workspaceId: null,
          themeMode,
          theme: {
            slug: "server-owned-theme",
            name: "Server Owned Theme",
            origin: "db",
            locked: false,
            isDefault: false,
            colorSchemaSlug: "server-colors",
            typographySlug: "server-type",
            colors: {
              light: {
                paper: "#fbf6ea",
                "paper-deep": "#eadfc8",
                ink: "#17202a",
                "ink-soft": "#53606b",
                "ink-mute": "#7a8790",
                rule: "#cabd9e",
                "accent-primary": "#126b5f",
                "link-default": "#126b5f",
                "accent-secondary": "#8a4f12",
              },
              dark: {
                paper: "#111923",
                "paper-deep": "#1f2b37",
                ink: "#edf4f8",
                "ink-soft": "#c4d0d8",
                "ink-mute": "#93a1aa",
                rule: "#40505c",
                "accent-primary": "#78d6c8",
                "link-default": "#78d6c8",
                "accent-secondary": "#f2b66d",
              },
            },
            typographyStyles: [],
          },
        },
      },
    },
  };
}

const INLINE_THEME_VARS = [
  "--myoxus-accent-primary",
  "--myoxus-accent-secondary",
  "--myoxus-background-primary-color",
  "--myoxus-background-primary-color",
  "--myoxus-text-primary-color",
  "--myoxus-sem-text-primary",
  "--myoxus-typography-h1-family",
  "--myoxus-font-family",
  "--myoxus-btn-primary-hover-bg",
  "--myoxus-overlay-hover-bg",
] as const;

describe("BrandingAccentThemeSync", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useThemeMock.mockReset();
    setThemeMock.mockReset();
    useThemeMock.mockReturnValue({
      theme: "system",
      resolvedTheme: "light",
      setTheme: setThemeMock,
    });
    useQueryMock.mockReturnValue(profileResponse());
    for (const varName of INLINE_THEME_VARS) {
      document.documentElement.style.removeProperty(varName);
    }
  });

  afterEach(() => {
    cleanup();
    for (const varName of INLINE_THEME_VARS) {
      document.documentElement.style.removeProperty(varName);
    }
  });

  test("syncs explicit dark server mode to the shared theme provider", async () => {
    useQueryMock.mockReturnValue(profileResponse("dark"));

    render(<BrandingAccentThemeSync />);

    await waitFor(() => {
      expect(setThemeMock).toHaveBeenCalledWith("dark");
    });
  });

  test("syncs explicit light server mode to the shared theme provider", async () => {
    useThemeMock.mockReturnValue({
      theme: "dark",
      resolvedTheme: "dark",
      setTheme: setThemeMock,
    });
    useQueryMock.mockReturnValue(profileResponse("light"));

    render(<BrandingAccentThemeSync />);

    await waitFor(() => {
      expect(setThemeMock).toHaveBeenCalledWith("light");
    });
  });

  test("does not rewrite local mode for the server system mode", async () => {
    useThemeMock.mockReturnValue({
      theme: "dark",
      resolvedTheme: "dark",
      setTheme: setThemeMock,
    });
    useQueryMock.mockReturnValue(profileResponse("system"));

    render(<BrandingAccentThemeSync />);

    await waitFor(() => {
      expect(useQueryMock).toHaveBeenCalled();
    });
    expect(setThemeMock).not.toHaveBeenCalled();
  });
});
