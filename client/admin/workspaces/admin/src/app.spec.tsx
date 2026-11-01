/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  invalidateAdminSession,
  resetAdminSessionInvalidation,
} from "./admin-session";

const useServerConfigMock = vi.fn();
const useCurrentUserMock = vi.fn();
const revalidateCurrentUserMock = vi.fn();
const isAdminMock = vi.fn();
const unexpectedFetchMock = vi.fn(
  async () => new Response(null, { status: 204 }),
);

vi.mock("@sentry/react", () => ({
  withSentryReactRouterV7Routing: (routes: unknown) => routes,
}));

vi.mock("./components/theme-provider", async () => {
  const { MyoxusUIProvider } = await import("@myoxus/ui-facade/provider");

  return {
    ThemeProvider: ({ children }: { children: React.ReactNode }) => (
      <MyoxusUIProvider>{children}</MyoxusUIProvider>
    ),
  };
});

vi.mock("./modules/layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="layout">{children}</div>
  ),
}));

vi.mock("./modules/branding/accent-theme", () => ({
  BrandingAccentThemeSync: () => null,
}));

vi.mock("./modules/branding/admin-locale-sync", () => ({
  AdminBootstrapLocaleSync: () => null,
  AdminLocaleSync: () => null,
}));

vi.mock("./modules/common", () => ({
  useCurrentUser: () => useCurrentUserMock(),
  isAdmin: (...args: unknown[]) => isAdminMock(...args),
  useRevalidateCurrentUser: () => revalidateCurrentUserMock,
  useAdminCapabilities: () => ({
    hasQueueDashboard: false,
  }),
  useServerConfig: () => useServerConfigMock(),
}));

vi.mock("./modules/auth", () => ({
  default: () => <div>auth-page</div>,
}));

vi.mock("./modules/auth/shared-sign-in-redirect", () => ({
  SharedSignInRedirect: ({ to }: { to: string }) => (
    <a data-testid="shared-sign-in-redirect" href={to}>
      {to}
    </a>
  ),
}));

vi.mock("./modules/auth/no-admin-access", () => ({
  NoAdminAccess: () => <div>Admin access required</div>,
}));

vi.mock("./modules/setup", () => ({
  default: () => <div>setup-page</div>,
}));
vi.mock("./modules/config-wizard", () => ({
  default: () => <div>config-wizard-page</div>,
}));
vi.mock("./modules/security", () => ({
  default: () => <div>security-page</div>,
}));
vi.mock("./modules/dashboard", () => ({
  default: () => <div>dashboard-page</div>,
}));
vi.mock("./modules/workspaces", () => ({
  default: () => <div>workspaces-page</div>,
}));
vi.mock("./modules/queue", () => ({
  default: () => <div>queue-page</div>,
}));
vi.mock("./modules/ai", () => ({
  default: () => <div>ai-page</div>,
}));
vi.mock("./modules/system", () => ({
  default: () => <div data-testid="system-page">system-page</div>,
}));
vi.mock("./modules/organization", () => ({
  default: ({
    defaultTab,
    focusUnitId,
  }: {
    defaultTab?: string;
    focusUnitId?: string | null;
  }) => (
    <div
      data-testid="organization-page"
      data-default-tab={defaultTab}
      data-focus-unit-id={focusUnitId ?? undefined}
    >
      organization-page
    </div>
  ),
}));
vi.mock("./modules/templates", () => ({
  default: () => <div data-testid="templates-page">templates-page</div>,
}));
vi.mock("./modules/storage", () => ({
  default: () => <div>storage-page</div>,
}));

import { App } from "./app";

describe("App legacy admin routes", () => {
  beforeEach(() => {
    (globalThis as any).environment = {
      isSelfHosted: true,
      subPath: "",
    };
    (globalThis as any).BUILD_CONFIG = {
      appVersion: "test",
      downloadUrl: "https://example.invalid/download",
      isElectron: false,
    };
    useServerConfigMock.mockReset();
    useCurrentUserMock.mockReset();
    revalidateCurrentUserMock.mockReset();
    isAdminMock.mockReset();
    unexpectedFetchMock.mockClear();
    vi.stubGlobal("fetch", unexpectedFetchMock);
    window.fetch = unexpectedFetchMock as typeof fetch;
    useCurrentUserMock.mockReturnValue({
      id: "admin-1",
      email: "admin@example.invalid",
      features: ["Admin"],
    });
    revalidateCurrentUserMock.mockResolvedValue(undefined);
    isAdminMock.mockReturnValue(true);
    resetAdminSessionInvalidation();
    window.history.replaceState({}, "", "/adminfrontend/accounts");
  });

  afterEach(() => {
    cleanup();
    resetAdminSessionInvalidation();
    expect(unexpectedFetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("redirects legacy accounts route to organization members", async () => {
    useServerConfigMock.mockReturnValue({
      initialized: true,
    });
    window.history.replaceState({}, "", "/adminfrontend/accounts");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("organization-page").textContent).toBe(
        "organization-page",
      );
    });

    expect(window.location.pathname).toBe("/adminfrontend/organization");
    expect(window.location.search).toBe("?tab=members");
  });

  test("renders an organization-unit deep link on the units tab", async () => {
    useServerConfigMock.mockReturnValue({
      initialized: true,
    });
    window.history.replaceState(
      {},
      "",
      "/adminfrontend/organization/units/unit-123",
    );

    render(<App />);

    const page = await screen.findByTestId("organization-page");
    expect(page.dataset.defaultTab).toBe("units");
    expect(page.dataset.focusUnitId).toBe("unit-123");
  });

  test("redirects legacy about route to system", async () => {
    useServerConfigMock.mockReturnValue({
      initialized: true,
    });
    window.history.replaceState({}, "", "/adminfrontend/about");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("system-page").textContent).toBe("system-page");
    });

    expect(window.location.pathname).toBe("/adminfrontend/system");
    expect(window.location.search).toBe("");
  });

  test("redirects legacy logging route to the System logging tab", async () => {
    useServerConfigMock.mockReturnValue({
      initialized: true,
    });
    window.history.replaceState({}, "", "/adminfrontend/logging");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("system-page").textContent).toBe("system-page");
    });

    expect(window.location.pathname).toBe("/adminfrontend/system");
    expect(window.location.search).toBe("?tab=logging");
  });

  test("redirects legacy orphaned-workspaces route to the Storage orphaned tab", async () => {
    useServerConfigMock.mockReturnValue({
      initialized: true,
    });
    window.history.replaceState({}, "", "/adminfrontend/orphaned-workspaces");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("storage-page").textContent).toBe("storage-page");
    });

    expect(window.location.pathname).toBe("/adminfrontend/storage");
    expect(window.location.search).toBe("?tab=orphaned");
  });

  test("renders queue page when queue dashboard capability is unavailable", async () => {
    useServerConfigMock.mockReturnValue({
      initialized: true,
    });
    window.history.replaceState({}, "", "/adminfrontend/queue");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("queue-page").textContent).toBe("queue-page");
    });

    expect(window.location.pathname).toBe("/adminfrontend/queue");
  });

  test("renders templates page for templates route", async () => {
    useServerConfigMock.mockReturnValue({
      initialized: true,
    });
    window.history.replaceState({}, "", "/adminfrontend/templates");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("templates-page").textContent).toBe(
        "templates-page",
      );
    });
    expect(window.location.pathname).toBe("/adminfrontend/templates");
  });

  test("redirects templates route to shared sign-in when user is unauthenticated", async () => {
    useServerConfigMock.mockReturnValue({
      initialized: true,
    });
    useCurrentUserMock.mockReturnValue(null);
    isAdminMock.mockReturnValue(false);
    window.history.replaceState({}, "", "/adminfrontend/templates");

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByTestId("shared-sign-in-redirect").getAttribute("href"),
      ).toContain("auth_context=admin");
    });
    const href = screen
      .getByTestId("shared-sign-in-redirect")
      .getAttribute("href");
    expect(href).toContain("redirect_uri=%2Fadminfrontend%2Ftemplates");
    expect(href).toContain("auth_context=admin");
  });

  test("renders no-admin state when authenticated user lacks admin feature", async () => {
    useServerConfigMock.mockReturnValue({
      initialized: true,
    });
    useCurrentUserMock.mockReturnValue({
      id: "user-1",
      email: "user@example.com",
      features: [],
    });
    isAdminMock.mockReturnValue(false);
    window.history.replaceState({}, "", "/adminfrontend/templates");

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Admin access required").textContent).toBe(
        "Admin access required",
      );
    });
    expect(window.location.pathname).toBe("/adminfrontend/templates");
  });

  test("redirects protected routes when central session state is invalidated", async () => {
    useServerConfigMock.mockReturnValue({
      initialized: true,
    });
    useCurrentUserMock.mockReturnValue({
      id: "admin-1",
      email: "admin@example.invalid",
      features: ["Admin"],
    });
    isAdminMock.mockReturnValue(true);
    invalidateAdminSession({
      reason: "graphql-unauthorized",
      channel: "graphql",
      operationName: "AdminProbe",
      source: "/graphql",
      status: 200,
    });
    window.history.replaceState({}, "", "/adminfrontend/templates");

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByTestId("shared-sign-in-redirect").getAttribute("href"),
      ).toContain("auth_context=admin");
    });
    const href = screen
      .getByTestId("shared-sign-in-redirect")
      .getAttribute("href");
    expect(href).toContain("redirect_uri=%2Fadminfrontend%2Ftemplates");
    expect(href).toContain("auth_context=admin");
  });

  test("invalidated sessions redirect even while cleared current-user data is undefined", async () => {
    useServerConfigMock.mockReturnValue({ initialized: true });
    window.history.replaceState(
      {},
      "",
      "/adminfrontend/security?tab=oauth#providers",
    );
    render(<App />);
    await screen.findByText("security-page");
    useCurrentUserMock.mockReturnValue(undefined);
    await act(async () => {
      invalidateAdminSession({ reason: "logout", source: "test" });
    });
    const redirect = await screen.findByTestId("shared-sign-in-redirect");
    const target = new URL(
      redirect.getAttribute("href")!,
      "https://admin.example.test",
    );
    expect(target.searchParams.get("redirect_uri")).toBe(
      "/adminfrontend/security?tab=oauth#providers",
    );
    expect(screen.queryByText("security-page")).toBeNull();
    expect(screen.queryByText("setup-page")).toBeNull();
  });

  test("requires sign-in before exposing the writable fullscreen wizard", async () => {
    useServerConfigMock.mockReturnValue({ initialized: true });
    useCurrentUserMock.mockReturnValue(null);
    window.history.replaceState({}, "", "/adminfrontend/config-wizard");
    render(<App />);

    const redirect = await screen.findByTestId("shared-sign-in-redirect");
    expect(redirect.getAttribute("href")).toContain(
      "redirect_uri=%2Fadminfrontend%2Fconfig-wizard",
    );
    expect(redirect.getAttribute("href")).toContain("auth_context=admin");
    expect(screen.queryByText("config-wizard-page")).toBeNull();
  });

  test("does not expose the wizard to authenticated non-admin users", async () => {
    useServerConfigMock.mockReturnValue({ initialized: true });
    useCurrentUserMock.mockReturnValue({ id: "user-1", features: [] });
    isAdminMock.mockReturnValue(false);
    window.history.replaceState({}, "", "/adminfrontend/config-wizard");
    render(<App />);

    await screen.findByText("Admin access required");
    expect(screen.queryByText("config-wizard-page")).toBeNull();
  });
});
