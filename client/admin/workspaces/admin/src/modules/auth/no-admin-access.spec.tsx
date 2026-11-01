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

import { resetAdminSessionInvalidation } from "../../admin-session";

const adminFetchMock = vi.fn();
const revalidateCurrentUserMock = vi.fn();
const useCurrentUserMock = vi.fn();

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    AuthActionStack: ({ children }: { children: React.ReactNode }) => (
      <div data-myoxus-ui-role="auth-action-stack">{children}</div>
    ),
    AuthBackgroundArt: () => <div data-testid="auth-background" />,
    AuthContainer: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    AuthContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    AuthHeader: ({
      title,
      titleProps,
    }: {
      title: string;
      titleProps: React.HTMLAttributes<HTMLHeadingElement>;
    }) => <h1 {...titleProps}>{title}</h1>,
    AuthPanelFrame: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & {
      children: React.ReactNode;
    }) => (
      <div data-myoxus-ui-role="auth-panel-frame" {...props}>
        {children}
      </div>
    ),
    AuthStatusText: ({ children }: { children: React.ReactNode }) => (
      <div data-myoxus-ui-role="auth-status-text">{children}</div>
    ),
    MyoxusOtherPageLayout: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SignInPageContainer: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const messages: Record<string, string> = {
        "admin.auth.failed-to-logout": `Failed to log out: ${values?.message ?? ""}`,
        "admin.auth.no-admin-description": `${values?.email ?? ""} is signed in, but this account does not have administrator access.`,
        "admin.auth.no-admin-open-myoxus": "Open Myoxus",
        "admin.auth.no-admin-sign-out": "Sign out",
        "admin.auth.no-admin-title": "Admin access required",
      };
      return messages[key] ?? key;
    },
  }),
}));

vi.mock("react-router", () => ({
  useLocation: () => ({
    pathname: "/adminfrontend/security",
    search: "?tab=oauth",
    hash: "#providers",
  }),
}));

vi.mock("@myoxus/routes", () => ({
  ROUTES: {
    index: "/",
  },
}));

vi.mock("../../fetch-utils", () => ({
  adminFetch: (...args: unknown[]) => adminFetchMock(...args),
}));

vi.mock("../common", () => ({
  useCurrentUser: () => useCurrentUserMock(),
  useRevalidateCurrentUser: () => revalidateCurrentUserMock,
}));

vi.mock("./redirect", () => ({
  buildAdminSignInUrl: (returnPath: string) =>
    `/sign-in?redirect_uri=${encodeURIComponent(returnPath)}&auth_context=admin`,
}));

import { NoAdminAccess } from "./no-admin-access";

function renderNoAdminAccess() {
  return render(
    <MyoxusUIProvider>
      <NoAdminAccess />
    </MyoxusUIProvider>,
  );
}

describe("NoAdminAccess", () => {
  beforeEach(() => {
    adminFetchMock.mockReset();
    revalidateCurrentUserMock.mockReset();
    useCurrentUserMock.mockReturnValue({
      email: "user@example.com",
    });
  });

  afterEach(() => {
    cleanup();
    resetAdminSessionInvalidation();
  });

  test("offers web-app and sign-out actions without a login loop", () => {
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => undefined);
    adminFetchMock.mockReturnValue(new Promise(() => {}));

    renderNoAdminAccess();

    fireEvent.click(screen.getByRole("button", { name: "Open Myoxus" }));
    expect(assign).toHaveBeenCalledWith("/");

    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Admin access required", level: 1 }),
    );

    const signOut = screen.getByRole("button", { name: "Sign out" });
    fireEvent.click(signOut);

    expect(adminFetchMock).toHaveBeenCalledWith("/api/auth/sign-out", {
      method: "POST",
      admin: { channel: "auth", operationName: "adminSignOut" },
    });
    expect(signOut.hasAttribute("disabled")).toBe(true);
    assign.mockRestore();
  });

  test("hands off once through session invalidation after sign-out", async () => {
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => undefined);
    adminFetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    renderNoAdminAccess();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "/sign-in?redirect_uri=%2Fadminfrontend%2Fsecurity%3Ftab%3Doauth%23providers&auth_context=admin",
      );
    });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    replace.mockRestore();
  });
});
