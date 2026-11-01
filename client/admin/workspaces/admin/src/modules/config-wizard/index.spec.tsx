/** @vitest-environment happy-dom */
import { clearBrandIdentityCache } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const status = vi.hoisted(() => ({ use: vi.fn(), refetch: vi.fn() }));

vi.mock("../../hooks/use-server-setup-status", () => ({
  useServerSetupStatus: () => status.use(),
}));
vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("./wizard", () => ({ Wizard: () => <h1>Active wizard</h1> }));

import { ConfigWizard } from "./index";

function view() {
  return (
    <MyoxusUIProvider>
      <MemoryRouter initialEntries={["/adminfrontend/config-wizard"]}>
        <Routes>
          <Route
            path="/adminfrontend/config-wizard"
            element={<ConfigWizard />}
          />
          <Route path="/adminfrontend/dashboard" element={<h1>Dashboard</h1>} />
        </Routes>
      </MemoryRouter>
    </MyoxusUIProvider>
  );
}

describe("Config wizard admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBrandIdentityCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    status.use.mockReturnValue({
      data: { setupCompleted: false },
      isLoading: false,
      error: undefined,
      refetch: status.refetch,
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    clearBrandIdentityCache();
  });

  test("keeps the admitted wizard mounted when completion readback updates SWR", () => {
    const rendered = render(view());
    expect(
      screen.getByRole("heading", { name: "Active wizard" }),
    ).not.toBeNull();
    status.use.mockReturnValue({
      data: { setupCompleted: true },
      isLoading: false,
      refetch: status.refetch,
    });
    rendered.rerender(view());
    expect(
      screen.getByRole("heading", { name: "Active wizard" }),
    ).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Dashboard" })).toBeNull();
  });
});
