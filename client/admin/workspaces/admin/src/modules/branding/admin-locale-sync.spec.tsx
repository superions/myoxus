/** @vitest-environment happy-dom */
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, test, vi } from "vitest";

// Mock: useQuery (SWR)

const useQueryMock = vi.fn();

vi.mock("../../use-query", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

// Mock: i18next instance — capture changeLanguage calls

const changeLanguageMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@myoxus/i18n", () => ({
  getOrCreateI18n: () => ({ changeLanguage: changeLanguageMock }),
  SUPPORTED_LANGUAGES: {
    ca: { name: "Catalan" },
    cs: { name: "Czech" },
    de: { name: "German" },
    en: { name: "English" },
    es: { name: "Spanish" },
    fr: { name: "French" },
    it: { name: "Italian" },
    nl: { name: "Dutch" },
    pl: { name: "Polish" },
  },
  useI18n: () => ({ t: (k: string) => k }),
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Helpers

function mockAdminI18nConfig(locale: string | null) {
  const fields =
    locale !== null
      ? [
          {
            key: "default_locale",
            path: "admin_i18n.default_locale",
            value: locale,
          },
        ]
      : [];
  return {
    data: {
      admin: {
        adminConfigValues: {
          modules: [
            {
              module: "admin_i18n",
              groups: [{ fields }],
            },
          ],
        },
      },
    },
  };
}

function mockServerInfoLocale(locale: string | null) {
  return {
    data: {
      admin: {
        serverInfo: {
          i18n: locale
            ? { defaultLocale: locale, availableLocales: ["en", locale] }
            : null,
        },
      },
    },
  };
}

import { AdminBootstrapLocaleSync, AdminLocaleSync } from "./admin-locale-sync";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminLocaleSync", () => {
  test("inv_p118b_02: unsupported locale does NOT call changeLanguage", async () => {
    useQueryMock.mockReturnValue(mockAdminI18nConfig("zh"));

    render(<AdminLocaleSync />);

    // Give the effect a chance to fire
    await new Promise((r) => setTimeout(r, 10));
    expect(changeLanguageMock).not.toHaveBeenCalled();
  });

  test("inv_p118b_03: missing adminI18n config does NOT call changeLanguage", async () => {
    useQueryMock.mockReturnValue({ data: null });

    render(<AdminLocaleSync />);

    await new Promise((r) => setTimeout(r, 10));
    expect(changeLanguageMock).not.toHaveBeenCalled();
  });

  test("inv_p118b_04: all registered admin locales are accepted", async () => {
    for (const locale of [
      "en",
      "de",
      "fr",
      "es",
      "it",
      "nl",
      "pl",
      "ca",
      "cs",
    ]) {
      changeLanguageMock.mockClear();
      useQueryMock.mockReturnValue(mockAdminI18nConfig(locale));

      const { unmount } = render(<AdminLocaleSync />);

      await waitFor(() => {
        expect(changeLanguageMock).toHaveBeenCalledWith(locale);
      });

      unmount();
    }
  });

  test("inv_p118b_05: setup routes apply the public server locale without admin config", async () => {
    useQueryMock.mockReturnValue(mockServerInfoLocale("de"));

    render(
      <MemoryRouter initialEntries={["/adminfrontend/setup"]}>
        <AdminBootstrapLocaleSync />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(changeLanguageMock).toHaveBeenCalledWith("de");
    });
  });

  test("inv_p118b_06: authenticated admin routes are not overridden by the public locale sync", async () => {
    useQueryMock.mockReturnValue(mockServerInfoLocale("de"));

    render(
      <MemoryRouter initialEntries={["/adminfrontend/dashboard"]}>
        <AdminBootstrapLocaleSync />
      </MemoryRouter>,
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(changeLanguageMock).not.toHaveBeenCalled();
  });
});
