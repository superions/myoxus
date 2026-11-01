/**
 * @vitest-environment happy-dom
 */
import { FeatureType } from "@myoxus/graphql";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const useCurrentUserMock = vi.fn();

vi.mock("../common", async () => {
  const actual = await vi.importActual("../common");
  return {
    ...actual,
    useCurrentUser: () => useCurrentUserMock(),
  };
});

vi.mock("./no-admin-access", () => ({
  NoAdminAccess: () => <div data-testid="no-admin-access" />,
}));

import { Auth } from "./index";
import { buildAdminSignInUrl } from "./redirect";

describe("Auth compatibility route", () => {
  beforeEach(() => {
    useCurrentUserMock.mockReset();
    useCurrentUserMock.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  test("redirects unauthenticated users to the shared sign-in page", () => {
    render(
      <MemoryRouter initialEntries={["/adminfrontend/auth"]}>
        <Routes>
          <Route path="/adminfrontend/auth" element={<Auth />} />
        </Routes>
      </MemoryRouter>,
    );

    const redirect = screen.getByTestId("shared-sign-in-redirect");
    expect(redirect.getAttribute("href")).toContain(
      "redirect_uri=%2Fadminfrontend",
    );
    expect(redirect.getAttribute("href")).toContain("auth_context=admin");
  });

  test("redirects an already authenticated admin to the admin root", () => {
    useCurrentUserMock.mockReturnValue({
      features: [FeatureType.Admin],
    });

    render(
      <MemoryRouter initialEntries={["/adminfrontend/auth"]}>
        <Routes>
          <Route path="/adminfrontend/auth" element={<Auth />} />
          <Route path="/adminfrontend" element={<div>Dashboard</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Dashboard")).toBeTruthy();
  });

  test("renders no-admin state for authenticated users without admin access", () => {
    useCurrentUserMock.mockReturnValue({
      features: [],
    });

    render(
      <MemoryRouter initialEntries={["/adminfrontend/auth"]}>
        <Routes>
          <Route path="/adminfrontend/auth" element={<Auth />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("no-admin-access")).toBeTruthy();
  });

  test("sanitizes admin redirect targets before building shared sign-in URLs", () => {
    expect(buildAdminSignInUrl("/adminfrontend/templates")).toContain(
      "redirect_uri=%2Fadminfrontend%2Ftemplates",
    );
    expect(buildAdminSignInUrl("https://evil.invalid/adminfrontend")).toContain(
      "redirect_uri=%2Fadminfrontend",
    );
    expect(buildAdminSignInUrl("/adminfrontendevil")).toContain(
      "redirect_uri=%2Fadminfrontend",
    );
    expect(buildAdminSignInUrl("/adminfrontend%2fevil")).toContain(
      "redirect_uri=%2Fadminfrontend",
    );
    expect(buildAdminSignInUrl("/web")).toContain(
      "redirect_uri=%2Fadminfrontend",
    );
  });
});
