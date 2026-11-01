import type { ReactElement } from "react";
import type { ThemeDefinition } from "../theme/theme-contract";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../libs/i18n/src/resources/en.json";

const themeApiMocks = vi.hoisted(() => ({
  useThemeCatalogQuery: vi.fn(),
  useEffectiveThemeProfileQuery: vi.fn(),
  useAppServerBrandingQuery: vi.fn(),
  useOrganizationIdentityQuery: vi.fn(),
  useSetThemeProfileMutation: vi.fn(),
  setThemeProfile: vi.fn(),
}));

vi.mock("../theme/theme-api", () => ({
  useThemeCatalogQuery: themeApiMocks.useThemeCatalogQuery,
  useEffectiveThemeProfileQuery: themeApiMocks.useEffectiveThemeProfileQuery,
  useSetThemeProfileMutation: themeApiMocks.useSetThemeProfileMutation,
}));

vi.mock("../branding/brand-identity-api", () => ({
  useAppServerBrandingQuery: themeApiMocks.useAppServerBrandingQuery,
  useOrganizationIdentityQuery: themeApiMocks.useOrganizationIdentityQuery,
}));

vi.mock("../admin-shell", () => ({
  AdminPageFrame: ({
    title,
    children,
  }: {
    title: string;
    children: React.ReactNode;
  }) => (
    <div data-testid="admin-page-frame">
      <h1>{title}</h1>
      {children}
    </div>
  ),
  AdminPageScroll: ({ children }: { children: React.ReactNode }) => (
    <main data-testid="admin-page-scroll">{children}</main>
  ),
  AdminSubnav: ({
    children,
    items,
  }: {
    children?: React.ReactNode;
    items?: readonly {
      value: string;
      label: React.ReactNode;
      testId?: string;
    }[];
  }) => (
    <nav data-testid="admin-subnav">
      {items?.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          data-testid={item.testId}
        >
          {item.label}
        </button>
      ))}
      {children}
    </nav>
  ),
}));

vi.mock("./tabs/branding-tab", () => ({
  BrandingTab: ({
    branding,
    organizationIdentity,
  }: {
    branding: unknown;
    organizationIdentity: unknown;
  }) => (
    <div data-testid="branding-tab">
      {JSON.stringify({ branding, organizationIdentity })}
    </div>
  ),
}));

vi.mock("./tabs/colors-tab", () => ({
  ColorsTab: ({ theme }: { theme: ThemeDefinition | null }) => (
    <div data-testid="colors-tab">{theme?.slug ?? "none"}</div>
  ),
}));

vi.mock("./theme-gallery", () => ({
  ThemeGallery: ({
    activePreset,
    activeMode,
    onSelectPreset,
    onSelectMode,
  }: {
    activePreset?: string | null;
    activeMode?: string | null;
    onSelectPreset: (slug: string) => void;
    onSelectMode: (mode: "light" | "dark" | "system") => void;
  }) => (
    <div
      data-testid="theme-gallery"
      data-active={activePreset ?? ""}
      data-mode={activeMode ?? ""}
    >
      <button
        type="button"
        onClick={() => onSelectPreset("harbor")}
        data-testid="select-harbor"
      >
        Harbor
      </button>
      <button
        type="button"
        onClick={() => onSelectMode("dark")}
        data-testid="select-dark"
      >
        Dark
      </button>
    </div>
  ),
}));

const en: Record<string, string> = enJson;
const tMock = vi.fn((key: string): string => en[key] ?? key);

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: tMock,
    exists: (key: string) => key in en,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("@myoxus/admin/notifications", () => ({
  adminToast: toastMock,
}));

import { adminToast as toast } from "@myoxus/admin/notifications";

import { DesignPage } from "./index";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

const BASE_COLORS = {
  light: {
    paper: "#ffffff",
    "paper-deep": "#f5f5f5",
    ink: "#111111",
    "ink-soft": "#333333",
    "ink-mute": "#777777",
    rule: "#dddddd",
    "accent-primary": "#1455cc",
    "link-default": "#1455cc",
    "accent-secondary": "#0f766e",
    "status-success-paper": "#e7f5ee",
    "status-success-deep": "#1d6a46",
    "status-pending-paper": "#fff5d6",
    "status-pending-deep": "#9a6200",
    "status-error-paper": "#ffe2e2",
    "status-error-deep": "#a32020",
    "status-preset-paper": "#ece8ff",
    "status-preset-deep": "#5145a8",
    "status-info-paper": "#e3f1ff",
    "status-info-deep": "#1d5f9f",
  },
  dark: {
    paper: "#111827",
    "paper-deep": "#1f2937",
    ink: "#f8fafc",
    "ink-soft": "#d1d5db",
    "ink-mute": "#9ca3af",
    rule: "#374151",
    "accent-primary": "#f59e0b",
    "link-default": "#f59e0b",
    "accent-secondary": "#38bdf8",
    "status-success-paper": "#052e1a",
    "status-success-deep": "#4ade80",
    "status-pending-paper": "#422006",
    "status-pending-deep": "#facc15",
    "status-error-paper": "#450a0a",
    "status-error-deep": "#f87171",
    "status-preset-paper": "#312e81",
    "status-preset-deep": "#c4b5fd",
    "status-info-paper": "#082f49",
    "status-info-deep": "#7dd3fc",
  },
};

const atlas: ThemeDefinition = {
  slug: "atlas",
  name: "Atlas",
  origin: "system",
  locked: true,
  isDefault: true,
  colors: BASE_COLORS,
  typographyStyles: [],
};
const harbor: ThemeDefinition = {
  ...atlas,
  slug: "harbor",
  name: "Harbor",
  isDefault: false,
};
function setup(
  overrides: Partial<{
    profileTheme: ThemeDefinition | null;
    mode: "light" | "dark" | "system";
    mutating: boolean;
    rejectMutation: boolean;
  }> = {},
) {
  themeApiMocks.setThemeProfile.mockReset();
  themeApiMocks.setThemeProfile.mockResolvedValue({
    theme: harbor,
    themeMode: overrides.mode ?? "system",
  });
  if (overrides.rejectMutation) {
    themeApiMocks.setThemeProfile.mockRejectedValue(
      new Error("mutation failed"),
    );
  }
  themeApiMocks.useThemeCatalogQuery.mockReturnValue({
    themes: [atlas, harbor],
    fontFamilies: [],
    catalog: {
      catalogHash: "abcdef123456",
      themes: [atlas, harbor],
      fontFamilies: [],
    },
  });
  themeApiMocks.useEffectiveThemeProfileQuery.mockReturnValue({
    profile: {
      scope: "global",
      workspaceId: null,
      themeMode: overrides.mode ?? "system",
      theme:
        overrides.profileTheme === undefined ? atlas : overrides.profileTheme,
    },
  });
  themeApiMocks.useAppServerBrandingQuery.mockReturnValue({
    branding: {
      logo: {
        id: "asset-logo",
        slot: "logo",
        variant: "large",
        qualityClass: "web",
        storageKind: "style_static",
        storageKey: "logo.svg",
        mime: "image/svg+xml",
        sha256: "abc",
        publicUrl: "/style/logo.svg?v=abc",
      },
    },
  });
  themeApiMocks.useOrganizationIdentityQuery.mockReturnValue({
    identity: {
      displayName: "Acme Research",
      legalName: null,
      shortName: "Acme",
      jurisdiction: null,
      websiteUrl: null,
      contactEmail: null,
      addressLines: [],
      taxId: null,
      registrationId: null,
    },
  });
  themeApiMocks.useSetThemeProfileMutation.mockReturnValue({
    setThemeProfile: themeApiMocks.setThemeProfile,
    isMutating: overrides.mutating ?? false,
  });
}

describe("DesignPage", () => {
  beforeEach(() => {
    tMock.mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
    setup();
  });

  afterEach(cleanup);

  test("inv_selecting_theme_uses_adminroot_set_theme_profile", async () => {
    setup({ mode: "system" });
    renderWithFacade(<DesignPage />);

    fireEvent.click(screen.getByTestId("select-harbor"));
    await waitFor(() => {
      expect(themeApiMocks.setThemeProfile).toHaveBeenCalledWith({
        themeSlug: "harbor",
        themeMode: "system",
      });
    });
    expect(toast.success).toHaveBeenCalledWith("Saved");
  });

  test("inv_selecting_mode_preserves_active_theme_slug", async () => {
    setup({ profileTheme: harbor, mode: "system" });
    renderWithFacade(<DesignPage />);

    fireEvent.click(screen.getByTestId("select-dark"));
    await waitFor(() => {
      expect(themeApiMocks.setThemeProfile).toHaveBeenCalledWith({
        themeSlug: "harbor",
        themeMode: "dark",
      });
    });
  });

  test("inv_mutation_error_surfaces_toast_without_local_fallback", async () => {
    setup({ rejectMutation: true });
    renderWithFacade(<DesignPage />);

    fireEvent.click(screen.getByTestId("select-harbor"));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("mutation failed");
    });
  });
});
